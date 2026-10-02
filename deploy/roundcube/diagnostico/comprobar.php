<?php

/*
 * Diagnóstico del webmail de Mailway (solo línea de órdenes).
 *
 * Usa la configuración efectiva de Roundcube —la misma que el webmail:
 * imap_host, smtp_host y sus *_conn_options de roundcube/mailway.php— y su
 * biblioteca IMAP. Lo invoca deploy/instalar.sh (--comprobar y
 * --probar-acceso) dentro del contenedor, como www-data:
 *
 *   php /opt/mailway/comprobar.php conexion
 *       Abre IMAP y SMTP exactamente como el webmail, sin credenciales:
 *       resolución del nombre, conexión, TLS y saludo del motor.
 *   php /opt/mailway/comprobar.php certificado <MAIL_HOSTNAME>
 *       Certificado público que sirve el motor en 993 y 465, verificado
 *       (cadena de confianza, nombre y vigencia). Va aparte porque el webmail
 *       entra por la red interna sin verificarlo (ver mailway.php).
 *   php /opt/mailway/comprobar.php acceso
 *       Lee de la entrada estándar la dirección y la contraseña (dos líneas),
 *       inicia sesión UNA sola vez y abre la bandeja de entrada.
 *
 * Nunca acepta la contraseña como argumento ni la escribe en ningún sitio, y
 * hace un único intento: cada contraseña incorrecta cuenta para el bloqueo
 * automático del motor.
 *
 * Cada resultado ocupa una línea que empieza por «OK: » o «FALLO: »; el
 * código de salida es 0 solo si todo ha ido bien.
 *
 * Los compose montan esta carpeta (deploy/roundcube/diagnostico) en
 * /opt/mailway: fuera de la raíz web y de /var/roundcube/config, cuyos .php
 * se cargarían como configuración. Es una carpeta, y no un fichero suelto,
 * para que el contenedor vea la versión nueva tras un «git pull».
 */

if (\PHP_SAPI !== 'cli') {
    // El fichero no se monta en la raíz web; aun así, nunca responde por HTTP.
    http_response_code(404);
    exit;
}

// Roundcube trata los errores fatales con un manejador de cierre que termina
// con «exit» y código 0: sin este, registrado antes, un fallo al cargar
// Roundcube pasaría por una comprobación correcta.
register_shutdown_function(static function (): void {
    $error = error_get_last();
    if ($error && in_array($error['type'], [\E_ERROR, \E_PARSE, \E_CORE_ERROR, \E_COMPILE_ERROR, \E_USER_ERROR], true)) {
        $mensaje = trim((string) preg_replace('/\s+/', ' ', strtok($error['message'], "\n") ?: ''));
        echo 'FALLO: Error interno de Roundcube al hacer la comprobación (' . mb_substr($mensaje, 0, 200) . ").\n";
        exit(3);
    }
});

// MAILWAY_ROUNDCUBE_DIR solo existe para probar este fichero fuera de la imagen.
define('INSTALL_PATH', rtrim(getenv('MAILWAY_ROUNDCUBE_DIR') ?: '/var/www/html', '/') . '/');
require_once INSTALL_PATH . 'program/include/iniset.php';

$rcube = rcube::get_instance();
// Sin trazas de protocolo pase lo que pase en la configuración: la del
// inicio de sesión incluiría la contraseña. Y sin la línea «Login failed» del
// registro de errores, que este diagnóstico ya explica a su manera.
$rcube->config->set('imap_debug', false);
$rcube->config->set('smtp_debug', false);
$rcube->config->set('log_logins', true);

/** Una línea legible, sin saltos ni caracteres de control. */
function mw_linea(string $texto, int $limite = 240): string
{
    $texto = trim(preg_replace('/[\x00-\x1F\x7F]+/', ' ', $texto) ?? '');
    $texto = preg_replace('/\s+/', ' ', $texto) ?? '';

    return mb_strlen($texto) > $limite ? mb_substr($texto, 0, $limite - 1) . '…' : $texto;
}

/** Destino de imap_host o smtp_host: [nombre, puerto, «ssl» | «tls» | «»] (como rcmail::login). */
function mw_destino($uri, int $plano, int $ssl): array
{
    if (is_array($uri)) {
        $clave = key($uri);
        $uri = is_numeric($clave) ? $uri[$clave] : $clave;
    }
    $uri = rcube_utils::parse_host((string) $uri);
    [$host, $esquema, $puerto] = rcube_utils::parse_host_uri($uri, $plano, $ssl);
    $esquema = strtolower((string) $esquema);
    $modo = in_array($esquema, ['ssl', 'imaps', 'smtps'], true) ? 'ssl' : ($esquema === 'tls' ? 'tls' : '');

    return [(string) $host, (int) $puerto, $modo];
}

/** Opciones de socket que Roundcube aplicaría a ese nombre (*_conn_options por servidor). */
function mw_opciones($opciones, string $host): array
{
    rcube_utils::parse_socket_options($opciones, $host);

    return is_array($opciones) ? array_intersect_key($opciones, ['ssl' => 1, 'socket' => 1]) : [];
}

/**
 * Abre la conexión y devuelve [recurso | null, avisos de PHP]. Los avisos de
 * OpenSSL explican por qué falla una verificación.
 */
function mw_abrir(string $host, int $puerto, bool $ssl, array $contexto, int $espera = 10): array
{
    $avisos = [];
    set_error_handler(static function (int $nivel, string $mensaje) use (&$avisos): bool {
        $avisos[] = preg_replace('/^stream_socket_client\(\): /', '', $mensaje);

        return true;
    });
    try {
        $flujo = stream_socket_client(($ssl ? 'ssl://' : 'tcp://') . $host . ':' . $puerto, $codigo, $error,
            $espera, \STREAM_CLIENT_CONNECT, stream_context_create($contexto));
    } finally {
        restore_error_handler();
    }
    if (!$flujo) {
        if ($error !== '') {
            $avisos[] = $error;
        }

        return [null, $avisos];
    }
    stream_set_timeout($flujo, $espera);

    return [$flujo, $avisos];
}

function mw_leer($flujo): string
{
    $linea = fgets($flujo, 8192);

    return $linea === false ? '' : rtrim($linea, "\r\n");
}

/** Respuesta SMTP completa (varias líneas «250-…» hasta «250 …»): devuelve el código. */
function mw_respuesta_smtp($flujo): string
{
    do {
        $linea = mw_leer($flujo);
    } while ($linea !== '' && isset($linea[3]) && $linea[3] === '-');

    return substr($linea, 0, 3);
}

/** Abre IMAP o SMTP como el webmail y comprueba el saludo, sin autenticarse. */
function mw_conexion(string $servicio, $uri, $opciones, int $plano, int $ssl): bool
{
    [$host, $puerto, $modo] = mw_destino($uri, $plano, $ssl);
    $destino = ($modo === 'ssl' ? 'ssl://' : ($modo === 'tls' ? 'tls://' : '')) . "{$host}:{$puerto}";
    if ($host === '') {
        echo "FALLO: {$servicio} del webmail: no hay servidor configurado.\n";

        return false;
    }
    $contexto = mw_opciones($opciones, $host);
    [$flujo, $avisos] = mw_abrir($host, $puerto, $modo === 'ssl', $contexto);
    if (!$flujo) {
        $motivo = mw_linea(implode(' ', $avisos) ?: 'sin respuesta');
        echo "FALLO: {$servicio} del webmail ({$destino}): no se pudo conectar ({$motivo}).\n";

        return false;
    }
    $imap = $servicio === 'IMAP';
    $saludo = mw_leer($flujo);
    $correcto = $imap ? (bool) preg_match('/^\* (OK|PREAUTH)\b/i', $saludo) : str_starts_with($saludo, '220');
    if ($correcto && $modo === 'tls') {
        // STARTTLS: el mismo contexto (y la misma verificación) que usaría Roundcube.
        if ($imap) {
            fwrite($flujo, "M1 STARTTLS\r\n");
            $correcto = (bool) preg_match('/^M1 OK\b/i', mw_leer($flujo));
        } else {
            while (!str_starts_with($saludo, '220 ') && $saludo !== '') {
                $saludo = mw_leer($flujo);
            }
            fwrite($flujo, "EHLO comprobacion.mailway\r\n");
            $correcto = mw_respuesta_smtp($flujo) === '250';
            fwrite($flujo, "STARTTLS\r\n");
            $correcto = $correcto && mw_respuesta_smtp($flujo) === '220';
        }
        $correcto = $correcto && @stream_socket_enable_crypto($flujo, true, \STREAM_CRYPTO_METHOD_TLS_CLIENT);
    }
    fwrite($flujo, $imap ? "M2 LOGOUT\r\n" : "QUIT\r\n");
    fclose($flujo);
    if (!$correcto) {
        $texto = $saludo === '' ? 'el motor no saludó' : 'saludo inesperado: ' . mw_linea($saludo, 120);
        echo "FALLO: {$servicio} del webmail ({$destino}): {$texto}.\n";

        return false;
    }
    echo "OK: {$servicio} del webmail ({$destino}): conexión" . ($modo !== '' ? ' TLS' : '') . " y saludo del motor.\n";

    return true;
}

/** Datos legibles del certificado capturado en la conexión. */
function mw_describir($flujo): string
{
    $parametros = stream_context_get_params($flujo);
    $cert = $parametros['options']['ssl']['peer_certificate'] ?? null;
    $datos = $cert ? openssl_x509_parse($cert) : false;
    if (!$datos) {
        return 'sin datos del certificado';
    }
    $nombre = $datos['subject']['CN'] ?? '?';
    $emisor = trim(($datos['issuer']['O'] ?? '') . ' ' . ($datos['issuer']['CN'] ?? '')) ?: '?';
    $caduca = (int) ($datos['validTo_time_t'] ?? 0);
    $dias = (int) floor(($caduca - time()) / 86400);

    return sprintf('CN=%s, emisor %s, caduca el %s, dentro de %d %s', mw_linea((string) $nombre, 80),
        mw_linea($emisor, 80), gmdate('Y-m-d', $caduca), $dias, $dias === 1 ? 'día' : 'días');
}

/** Certificado que sirve el motor en un puerto TLS implícito, verificado como lo haría un cliente. */
function mw_certificado(string $host, int $puerto, string $servicio, string $nombre): bool
{
    $ssl = [
        'verify_peer' => true,
        'verify_peer_name' => true,
        'allow_self_signed' => false,
        'peer_name' => $nombre,
        'SNI_enabled' => true,
        'capture_peer_cert' => true,
    ];
    // Solo para pruebas (CI): CA de laboratorio. En producción, las del sistema.
    if (($ca = getenv('MAILWAY_TLS_CA_FILE')) !== false && $ca !== '') {
        $ssl['cafile'] = $ca;
    }
    [$flujo, $avisos] = mw_abrir($host, $puerto, true, ['ssl' => $ssl]);
    if ($flujo) {
        $descripcion = mw_describir($flujo);
        fclose($flujo);
        echo "OK: {$servicio} {$puerto}: certificado válido para {$nombre}; {$descripcion}.\n";

        return true;
    }
    $texto = implode(' ', $avisos);
    if (str_contains($texto, 'did not match expected')) {
        $motivo = "no es para {$nombre}";
    } elseif (str_contains($texto, 'certificate verify failed')) {
        $motivo = 'la cadena no es de confianza o el certificado no está vigente';
    } else {
        $motivo = mw_linea($texto ?: 'sin conexión', 160);
    }
    // Qué sirve de verdad, para orientar la solución.
    [$crudo] = mw_abrir($host, $puerto, true, ['ssl' => [
        'verify_peer' => false, 'verify_peer_name' => false, 'allow_self_signed' => true,
        'peer_name' => $nombre, 'SNI_enabled' => true, 'capture_peer_cert' => true,
    ]]);
    $servido = '';
    if ($crudo) {
        $servido = ' Sirve: ' . mw_describir($crudo) . '.';
        fclose($crudo);
    }
    echo "FALLO: {$servicio} {$puerto}: el certificado no es válido ({$motivo}).{$servido}\n";

    return false;
}

/** Inicio de sesión real, un solo intento, y apertura de la bandeja de entrada. */
function mw_acceso(rcube $rcube): bool
{
    if (stream_isatty(\STDIN)) {
        // Leída aquí, la contraseña se vería en pantalla al escribirla.
        echo "FALLO: Usa «sudo bash deploy/instalar.sh --probar-acceso»: pide la contraseña sin mostrarla.\n";

        return false;
    }
    $usuario = trim((string) fgets(\STDIN, 1024));
    $clave = fgets(\STDIN, 8192);
    $clave = $clave === false ? '' : rtrim($clave, "\r\n");
    if ($usuario === '' || $clave === '') {
        echo "FALLO: Faltan la dirección o la contraseña (dos líneas por la entrada estándar).\n";

        return false;
    }
    if (!preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/u', $usuario) || preg_match('/[\x00-\x1F\x7F]/', $usuario)) {
        echo 'FALLO: «' . mw_linea($usuario, 80) . "» no es una dirección de correo.\n";

        return false;
    }
    // Lo mismo que hace el webmail con login_lc = 2 y con los dominios IDN.
    $usuario = rcube_utils::idn_to_ascii(mb_strtolower($usuario));

    [$host, $puerto, $modo] = mw_destino($rcube->config->get('imap_host'), 143, 993);
    $almacen = $rcube->get_storage();
    $conectado = $almacen->connect($host, $usuario, $clave, $puerto, $modo !== '' ? $modo : null);
    $clave = '';
    $imap = $almacen->conn;
    if (!$conectado) {
        $detalle = rtrim(mw_linea((string) $imap->error, 160), '.');
        if ($imap->errornum === rcube_imap_generic::ERROR_NO) {
            echo "FALLO: El motor rechazó el inicio de sesión de {$usuario} (contraseña incorrecta, buzón inexistente "
                . "o desactivado: {$detalle}). No se ha repetido el intento: cada fallo cuenta para el bloqueo "
                . "automático del motor.\n";
        } else {
            echo "FALLO: El webmail no pudo conectar con el motor por IMAP ({$detalle}).\n";
        }

        return false;
    }
    if (!$imap->select('INBOX')) {
        $detalle = mw_linea((string) $imap->error, 160);
        $almacen->close();
        echo "FALLO: Sesión iniciada como {$usuario}, pero no se pudo abrir la bandeja de entrada ({$detalle}).\n";

        return false;
    }
    $mensajes = (int) ($imap->data['EXISTS'] ?? 0);
    $almacen->close();
    echo "OK: Sesión iniciada como {$usuario} desde el webmail y bandeja de entrada abierta ({$mensajes} "
        . ($mensajes === 1 ? 'mensaje' : 'mensajes') . ').' . "\n";

    return true;
}

$orden = $argv[1] ?? '';
switch ($orden) {
    case 'conexion':
        $config = $rcube->config;
        $imap = mw_conexion('IMAP', $config->get('imap_host'), $config->get('imap_conn_options'), 143, 993);
        $smtp = mw_conexion('SMTP', $config->get('smtp_host'), $config->get('smtp_conn_options'), 587, 465);
        exit($imap && $smtp ? 0 : 1);

    case 'certificado':
        $nombre = strtolower(trim($argv[2] ?? ''));
        if (!preg_match('/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/', $nombre)) {
            echo "FALLO: Indica el nombre del servidor de correo (MAIL_HOSTNAME).\n";
            exit(2);
        }
        // El webmail llega al motor por la red interna; el motor elige el
        // certificado por SNI, así que es el mismo que ven los clientes.
        [$host] = mw_destino($rcube->config->get('imap_host'), 143, 993);
        $imap = mw_certificado($host, 993, 'IMAP', $nombre);
        $smtp = mw_certificado($host, 465, 'SMTP', $nombre);
        exit($imap && $smtp ? 0 : 1);

    case 'acceso':
        exit(mw_acceso($rcube) ? 0 : 1);

    default:
        fwrite(\STDERR, "Uso: php comprobar.php conexion | certificado <MAIL_HOSTNAME> | acceso\n");
        exit(2);
}
