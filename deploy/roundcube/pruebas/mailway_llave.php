<?php

/*
 * Prueba del complemento mailway_llave con la imagen real de Roundcube.
 *
 * Un navegador simulado (cliente HTTP con cookies) entra por el index.php de la
 * imagen (servidor integrado de PHP, configuración de producción mailway.php,
 * base SQLite desechable e IMAP falso) con los complementos mailway_* en el
 * orden de deploy/docker-compose.mail.yml. El panel de Mailway se simula con
 * otro servidor integrado de PHP en 127.0.0.1, dentro del mismo contenedor y
 * sin red. Cubre el botón, el viaje con estado (también el de otro navegador:
 * el «login CSRF»), la entrada por el camino de Roundcube (sesión regenerada,
 * zona horaria, mailway_cuentas traduciendo el usuario), salir, la caducidad
 * (también por AJAX), el cierre por mailway_sesion con su aviso propio y los
 * fallos del panel. Además, que los dos compose montan el complemento y lo
 * ponen antes que mailway_cuentas y mailway_sesion.
 *
 * Necesita la carpeta deploy entera (lee los compose):
 *
 *   docker run --rm -v "$PWD/deploy:/opt/mailway-deploy:ro" \
 *     roundcube/roundcubemail:1.7.x-apache php /opt/mailway-deploy/roundcube/pruebas/mailway_llave.php
 *
 * Cada comprobación escribe una línea «OK: …» o «FALLO: …»; el código de
 * salida es 0 solo si todas pasan.
 */

if (\PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

// Roundcube trata los errores fatales con un manejador de cierre que termina
// con código 0: sin este, registrado antes, un fallo pasaría por un éxito.
register_shutdown_function(static function (): void {
    $error = error_get_last();
    if ($error && in_array($error['type'], [\E_ERROR, \E_PARSE, \E_CORE_ERROR, \E_COMPILE_ERROR, \E_USER_ERROR], true)) {
        echo 'FALLO: error fatal de PHP: ' . strtok($error['message'], "\n") . "\n";
        exit(3);
    }
});

// Con «php» como orden, el punto de entrada de la imagen no copia Roundcube a
// /var/www/html (solo lo hace al arrancar Apache): se usa la copia de origen.
$raiz = getenv('MAILWAY_ROUNDCUBE_DIR')
    ?: (is_file('/var/www/html/program/include/iniset.php') ? '/var/www/html' : '/usr/src/roundcubemail');
define('INSTALL_PATH', rtrim($raiz, '/') . '/');
define('ROUNDCUBE_STDERR_DISABLE', true);
require_once INSTALL_PATH . 'program/include/iniset.php';

$roundcubeDir = dirname(__DIR__);
$deployDir = dirname(__DIR__, 2);
$complemento = $roundcubeDir . '/mailway_llave';
require_once $complemento . '/mailway_llave.php';

$fallos = 0;

function comprobar(bool $condicion, string $descripcion, string $detalle = ''): void
{
    global $fallos;
    if ($condicion) {
        echo "OK: {$descripcion}\n";
    } else {
        $fallos++;
        echo "FALLO: {$descripcion}" . ($detalle !== '' ? " ({$detalle})" : '') . "\n";
    }
}

/* ------------------------------- Validación ---------------------------------- */

comprobar(
    mailway_llave::codigoValido(str_repeat('aB3_-', 8)) && !mailway_llave::codigoValido('corto')
        && mailway_llave::codigoValido(str_repeat('a', 128)) && !mailway_llave::codigoValido(str_repeat('a', 129)) && !mailway_llave::codigoValido(str_repeat('a', 20) . '=')
        && !mailway_llave::codigoValido(str_repeat('a', 20) . '/') && !mailway_llave::codigoValido(str_repeat('a', 20) . "\n"),
    'el código se valida (base64url de 16 a 128 caracteres, como el panel) antes de llamar al panel'
);
$e1 = mailway_llave::nuevoEstado();
$e2 = mailway_llave::nuevoEstado();
comprobar(
    strlen($e1) === 32 && mailway_llave::estadoValido($e1) && $e1 !== $e2
        && !mailway_llave::estadoValido(str_repeat('a', 15)) && !mailway_llave::estadoValido(str_repeat('a', 65))
        && !mailway_llave::estadoValido(str_repeat('a', 20) . '+'),
    'el estado es base64url aleatorio de 32 caracteres y se valida (16 a 64)',
    $e1
);
comprobar(
    mailway_llave::zonaValida('Europe/Madrid') && mailway_llave::zonaValida('America/Argentina/Buenos_Aires')
        && mailway_llave::zonaValida('-1') && !mailway_llave::zonaValida('Europe/Madrid; X')
        && !mailway_llave::zonaValida('') && !mailway_llave::zonaValida(str_repeat('a', 65)),
    'la zona horaria se valida como el _timezone del formulario'
);
comprobar(
    mailway_llave::validarPortal('https://Panel.Cliente.es/') === 'https://panel.cliente.es'
        && mailway_llave::validarPortal('http://127.0.0.1:4100') === 'http://127.0.0.1:4100',
    'el portal se normaliza a un origen sin barra final'
);
comprobar(
    mailway_llave::validarPortal('https://panel.cliente.es/mi-buzon') === null
        && mailway_llave::validarPortal('https://panel.cliente.es?x=1') === null
        && mailway_llave::validarPortal('https://u:p@panel.cliente.es') === null
        && mailway_llave::validarPortal('javascript:alert(1)') === null
        && mailway_llave::validarPortal('//panel.cliente.es') === null
        && mailway_llave::validarPortal("https://panel.cliente.es\r\nX: y") === null
        && mailway_llave::validarPortal(['https://a.es']) === null,
    'un portal con ruta, consulta, credenciales, otro esquema o saltos de línea se descarta'
);
$ahora = (int) floor(microtime(true) * 1000);
$canje = ['usuario' => ' ana@cliente.es ', 'contrasena' => 'Temporal-1', 'sesion' => 'ses_1', 'expira' => $ahora + 3600_000];
comprobar(
    mailway_llave::validarCanje($canje, $ahora) === ['usuario' => 'ana@cliente.es', 'contrasena' => 'Temporal-1', 'sesion' => 'ses_1', 'expira' => $ahora + 3600_000],
    'la respuesta del canje se valida'
);
comprobar(
    (mailway_llave::validarCanje(['expira' => $ahora + 48 * 3600_000] + $canje, $ahora)['expira'] ?? 0) === $ahora + 12 * 3600_000,
    'una caducidad de más de 12 horas se recorta a 12'
);
comprobar(
    mailway_llave::validarCanje(null, $ahora) === null
        && mailway_llave::validarCanje(['usuario' => 'sin-arroba'] + $canje, $ahora) === null
        && mailway_llave::validarCanje(['usuario' => "a@b.es\nX"] + $canje, $ahora) === null
        && mailway_llave::validarCanje(['contrasena' => ''] + $canje, $ahora) === null
        && mailway_llave::validarCanje(['contrasena' => "a\r\nb"] + $canje, $ahora) === null
        && mailway_llave::validarCanje(['sesion' => 'con espacio'] + $canje, $ahora) === null
        && mailway_llave::validarCanje(['expira' => $ahora - 1] + $canje, $ahora) === null
        && mailway_llave::validarCanje(['expira' => '9999999999999'] + $canje, $ahora) === null,
    'una respuesta del canje sin la forma esperada o ya caducada se descarta'
);

/* -------------------- Compose: lista de complementos y montaje ---------------- */

$compose = ['docker-compose.mail.yml', 'docker-compose.standalone.yml'];
if (!is_file("{$deployDir}/{$compose[0]}")) {
    echo "FALLO: no se encuentran los compose en {$deployDir}: monta la carpeta deploy entera (ver la cabecera).\n";
    exit(2);
}
$ordenProduccion = [];
foreach ($compose as $fichero) {
    $texto = (string) file_get_contents("{$deployDir}/{$fichero}");
    preg_match('/^\s*ROUNDCUBEMAIL_PLUGINS:\s*(\S+)\s*$/m', $texto, $m);
    $lista = explode(',', $m[1] ?? '');
    $posicion = array_flip($lista);
    comprobar(
        isset($posicion['mailway_llave'], $posicion['mailway_cuentas'], $posicion['mailway_sesion'])
            && $posicion['mailway_llave'] < $posicion['mailway_cuentas'] && $posicion['mailway_llave'] < $posicion['mailway_sesion'],
        "{$fichero}: mailway_llave va en ROUNDCUBEMAIL_PLUGINS antes que mailway_cuentas y mailway_sesion",
        $m[1] ?? 'sin ROUNDCUBEMAIL_PLUGINS'
    );
    comprobar(
        str_contains($texto, '- ./roundcube/mailway_llave:/var/www/html/plugins/mailway_llave:ro'),
        "{$fichero}: monta roundcube/mailway_llave en plugins/mailway_llave en solo lectura"
    );
    if (!$ordenProduccion) {
        $ordenProduccion = array_values(array_filter($lista, static fn (string $p): bool => str_starts_with($p, 'mailway_')));
    }
}

/* -------------------------- Sin panel no hace nada --------------------------- */

$api = rcube_plugin_api::get_instance();
foreach ([[null, null], ['http://127.0.0.1:1', null], [null, 'secreto']] as [$url, $token]) {
    putenv($url === null ? 'MAILWAY_PANEL_INTERNAL_URL' : "MAILWAY_PANEL_INTERNAL_URL={$url}");
    putenv($token === null ? 'MAILWAY_WEBMAIL_TOKEN' : "MAILWAY_WEBMAIL_TOKEN={$token}");
    $api->handlers = [];
    (new mailway_llave($api))->init();
    comprobar(!$api->handlers, 'sin MAILWAY_PANEL_INTERNAL_URL o sin MAILWAY_WEBMAIL_TOKEN no registra ningún gancho', json_encode([$url, $token]));
}
putenv('MAILWAY_PANEL_INTERNAL_URL=http://127.0.0.1:1');
putenv('MAILWAY_WEBMAIL_TOKEN=secreto');
$api->handlers = [];
(new mailway_llave($api))->init();
$ganchos = ['startup', 'loginform_content', 'authenticate', 'login_after', 'login_failed', 'session_destroy', 'unauthenticated'];
comprobar(
    array_keys($api->handlers) === $ganchos,
    'con las dos variables registra sus ganchos',
    implode(',', array_keys($api->handlers))
);
putenv('MAILWAY_PANEL_INTERNAL_URL');
putenv('MAILWAY_WEBMAIL_TOKEN');
$api->handlers = [];

/* ----------------------- Panel simulado, IMAP falso y webmail ----------------- */

$puertoPanel = 18775;
$puertoImap = 18776;
$puertoRc = 18777;
const TOKEN = 'secreto-de-prueba';
$tmp = '/tmp/mailway-llave';
@mkdir($tmp, 0700);
$base = "{$tmp}/roundcube.db";
$estadoPanel = "{$tmp}/panel.json";
$registroPanel = "{$tmp}/panel.jsonl";
$enrutador = "{$tmp}/panel.php";
$estadoImap = "{$tmp}/imap.json";
$registroImap = "{$tmp}/imap.jsonl";
$imapFalso = "{$tmp}/imap.php";
$configRc = "{$tmp}/config";
$complementosRc = "{$tmp}/complementos";
$prependRc = "{$tmp}/prepend.php";
$registrosRc = "{$tmp}/registro";
foreach ([$base, $estadoPanel, $registroPanel, $estadoImap, $registroImap] as $f) {
    @unlink($f);
}
foreach ([$configRc, $complementosRc, $registrosRc] as $d) {
    @mkdir($d, 0700);
}
array_map('unlink', glob($registrosRc . '/*') ?: []);

// El panel contesta según el fichero de estado y anota cada petición. Los
// códigos se gastan al canjearlos, como en el panel de verdad.
file_put_contents($enrutador, <<<'PHP'
<?php
$fichero = '/tmp/mailway-llave/panel.json';
$estado = json_decode((string) @file_get_contents($fichero), true) ?: [];
$ruta = (string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$cuerpo = json_decode((string) file_get_contents('php://input'), true);
file_put_contents('/tmp/mailway-llave/panel.jsonl', json_encode([
    'metodo' => $_SERVER['REQUEST_METHOD'],
    'ruta' => $ruta,
    'query' => $_GET,
    'token' => $_SERVER['HTTP_X_MAILWAY_TOKEN'] ?? null,
    'cuerpo' => $cuerpo,
]) . "\n", FILE_APPEND);
header('Content-Type: application/json');
$responder = static function (int $codigo, $datos): void {
    http_response_code($codigo);
    echo json_encode($datos);
};
if (($_SERVER['HTTP_X_MAILWAY_TOKEN'] ?? '') !== 'secreto-de-prueba') {
    $responder(401, ['error' => 'El token del webmail no es válido.', 'code' => 'webmail_token_invalid']);
    return;
}
$noEncontrado = ['error' => 'No encontrado.', 'code' => 'not_found'];
switch ($ruta) {
    case '/api/webmail/llave/portal':
        $r = $estado['portales'][$_GET['host'] ?? ''] ?? null;
        $r ? $responder($r[0], $r[1]) : $responder(404, $noEncontrado);
        return;
    case '/api/webmail/llave':
        $codigo = (string) ($cuerpo['codigo'] ?? '');
        $r = $estado['codigos'][$codigo] ?? null;
        if (!$r) {
            $responder(404, ['error' => 'El código no es válido.', 'code' => 'passkey_code_invalid']);
            return;
        }
        unset($estado['codigos'][$codigo]);
        file_put_contents($fichero, json_encode($estado));
        $responder($r[0], $r[1]);
        return;
    case '/api/webmail/llave/salir':
        $responder(200, ['ok' => true]);
        return;
    case '/api/webmail/cuenta':
        $r = $estado['cuentas'][$cuerpo['user'] ?? ''] ?? null;
        $r ? $responder(200, $r) : $responder(404, $noEncontrado);
        return;
    default:
        $responder(404, $noEncontrado);
}
PHP);

function estadoPanel(array $estado): void
{
    file_put_contents('/tmp/mailway-llave/panel.json', json_encode($estado));
}

function cambiarPanel(callable $cambio): void
{
    estadoPanel($cambio(json_decode((string) file_get_contents('/tmp/mailway-llave/panel.json'), true) ?: []));
}

/** @return array<int, array<string, mixed>> */
function peticionesPanel(): array
{
    $lineas = is_file('/tmp/mailway-llave/panel.jsonl')
        ? file('/tmp/mailway-llave/panel.jsonl', \FILE_IGNORE_NEW_LINES | \FILE_SKIP_EMPTY_LINES)
        : [];

    return array_map(static fn (string $l): array => json_decode($l, true), $lineas);
}

/** Peticiones al panel a partir de la n-ésima, solo de esa ruta. */
function peticionesDesde(int $desde, string $ruta): array
{
    return array_values(array_filter(
        array_slice(peticionesPanel(), $desde),
        static fn (array $p): bool => $p['ruta'] === $ruta,
    ));
}

// IMAP mínimo: LOGIN solo con el usuario y la contraseña del fichero de estado
// (anota cada intento); al resto de órdenes, OK. Una conexión cada vez.
file_put_contents($imapFalso, <<<'PHP'
<?php
$servidor = stream_socket_server('tcp://127.0.0.1:' . (int) $argv[1], $codigo, $error);
if (!$servidor) {
    fwrite(STDERR, "IMAP falso: {$error}\n");
    exit(1);
}
$capacidades = 'IMAP4rev1 LITERAL+ NAMESPACE';
$cadena = '"((?:[^"\\\\]|\\\\.)*)"';
while (true) {
    $c = @stream_socket_accept($servidor, -1);
    if (!$c) {
        continue;
    }
    fwrite($c, "* OK [CAPABILITY {$capacidades}] IMAP de prueba\r\n");
    while (($linea = fgets($c)) !== false) {
        $linea = rtrim($linea, "\r\n");
        [$etiqueta, $orden, $resto] = array_pad(explode(' ', $linea, 3), 3, '');
        switch (strtoupper($orden)) {
            case 'LOGIN':
                $estado = json_decode((string) @file_get_contents('/tmp/mailway-llave/imap.json'), true) ?: [];
                $usuario = $clave = null;
                if (preg_match('/^' . $cadena . ' ' . $cadena . '$/', $resto, $m)) {
                    $usuario = stripcslashes($m[1]);
                    $clave = stripcslashes($m[2]);
                }
                $valida = $usuario !== null && isset($estado[$usuario]) && $clave === $estado[$usuario];
                file_put_contents('/tmp/mailway-llave/imap.jsonl', json_encode(['usuario' => $usuario, 'valida' => $valida]) . "\n", FILE_APPEND);
                fwrite($c, $valida
                    ? "{$etiqueta} OK [CAPABILITY {$capacidades}] Dentro\r\n"
                    : "{$etiqueta} NO [AUTHENTICATIONFAILED] Credenciales no válidas\r\n");
                break;
            case 'CAPABILITY':
                fwrite($c, "* CAPABILITY {$capacidades}\r\n{$etiqueta} OK\r\n");
                break;
            case 'NAMESPACE':
                fwrite($c, "* NAMESPACE ((\"\" \"/\")) NIL NIL\r\n{$etiqueta} OK\r\n");
                break;
            case 'LIST':
            case 'LSUB':
                fwrite($c, ($resto === '"" ""' ? "* LIST (\\Noselect) \"/\" \"\"\r\n" : "* {$orden} (\\HasNoChildren) \"/\" INBOX\r\n") . "{$etiqueta} OK\r\n");
                break;
            case 'LOGOUT':
                fwrite($c, "* BYE\r\n{$etiqueta} OK\r\n");
                break 2;
            default:
                fwrite($c, "{$etiqueta} OK\r\n");
        }
    }
    @fclose($c);
}
PHP);

/** Usuarios y contraseñas que acepta el IMAP falso. */
function cuentasImap(array $cuentas): void
{
    file_put_contents('/tmp/mailway-llave/imap.json', json_encode($cuentas));
}

function ultimoLoginImap(): array
{
    $lineas = is_file('/tmp/mailway-llave/imap.jsonl')
        ? file('/tmp/mailway-llave/imap.jsonl', \FILE_IGNORE_NEW_LINES | \FILE_SKIP_EMPTY_LINES)
        : [];

    return $lineas ? json_decode((string) end($lineas), true) : [];
}

// Configuración: la de producción y, encima, lo que cambia en la prueba. Los
// complementos mailway_* en el orden de los compose.
file_put_contents($configRc . '/config.inc.php', '<?php
$config = [];
require ' . var_export($roundcubeDir . '/mailway.php', true) . ';
$config["db_dsnw"] = ' . var_export('sqlite:///' . $base . '?mode=0600', true) . ';
$config["imap_host"] = ' . var_export("127.0.0.1:{$puertoImap}", true) . ';
$config["plugins"] = ' . var_export($ordenProduccion, true) . ';
$config["create_default_folders"] = false;
$config["des_key"] = "mailway-prueba-24-bytes!";
$config["log_driver"] = "file";
$config["log_dir"] = ' . var_export($registrosRc, true) . ';
$config["temp_dir"] = "/tmp";
');
// Los complementos de la imagen y los nuestros, como los montan los compose.
$enlacesRc = [];
foreach ($ordenProduccion as $nombre) {
    $enlacesRc[$nombre] = realpath($roundcubeDir . '/' . $nombre);
}
foreach (glob(INSTALL_PATH . 'plugins/*', \GLOB_ONLYDIR) ?: [] as $dir) {
    $enlacesRc[basename($dir)] ??= $dir;
}
foreach ($enlacesRc as $nombre => $destino) {
    @unlink("{$complementosRc}/{$nombre}");
    symlink((string) $destino, "{$complementosRc}/{$nombre}");
}
file_put_contents($prependRc, "<?php\ndefine('RCUBE_PLUGINS_DIR', " . var_export($complementosRc . '/', true) . ");\n");

estadoPanel([]);
cuentasImap([]);
$silencio = [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w']];
$procesos = [
    proc_open([\PHP_BINARY, '-S', "127.0.0.1:{$puertoPanel}", $enrutador], $silencio + [2 => ['file', '/dev/null', 'w']], $tuberias),
    proc_open([\PHP_BINARY, $imapFalso, (string) $puertoImap], $silencio + [2 => ['file', "{$tmp}/imap.log", 'w']], $tuberias),
    proc_open(
        [\PHP_BINARY, '-d', "auto_prepend_file={$prependRc}", '-S', "127.0.0.1:{$puertoRc}", '-t', INSTALL_PATH . 'public_html'],
        $silencio + [2 => ['file', "{$tmp}/rc.log", 'w']],
        $tuberias,
        INSTALL_PATH . 'public_html',
        [
            'PATH' => (string) getenv('PATH'),
            'RCUBE_CONFIG_PATH' => INSTALL_PATH . 'config/' . \PATH_SEPARATOR . $configRc . '/',
            'MAILWAY_PANEL_INTERNAL_URL' => "http://127.0.0.1:{$puertoPanel}",
            'MAILWAY_WEBMAIL_TOKEN' => TOKEN,
        ]
    ),
];
register_shutdown_function(static function () use ($procesos): void {
    foreach ($procesos as $proceso) {
        if (is_resource($proceso)) {
            proc_terminate($proceso);
        }
    }
});
$escuchan = true;
foreach ([$puertoPanel, $puertoImap, $puertoRc] as $p) {
    $listo = false;
    for ($i = 0; $i < 50 && !$listo; $i++) {
        $conexion = @fsockopen('127.0.0.1', $p, $codigo, $error, 0.2);
        if ($conexion) {
            fclose($conexion);
            $listo = true;
        } else {
            usleep(100_000);
        }
    }
    $escuchan = $escuchan && $listo;
}
comprobar($escuchan, "panel simulado, IMAP falso y Roundcube (index.php) escuchando en 127.0.0.1:{$puertoPanel}, :{$puertoImap} y :{$puertoRc}");
if (!$escuchan) {
    exit(1);
}

// La base la crea Roundcube con el esquema de la imagen en la primera petición;
// esta conexión solo lee (sesiones y usuarios) para comprobar.
$rcube = rcube::get_instance();
$rcube->config->set('db_dsnw', 'sqlite:///' . $base . '?mode=0600');

/** Un navegador nuevo: cliente HTTP con su propio tarro de cookies. */
function navegador(): array
{
    global $rcube, $puertoRc;
    $tarro = new \GuzzleHttp\Cookie\CookieJar();
    $cliente = $rcube->get_http_client([
        'base_uri' => "http://127.0.0.1:{$puertoRc}/",
        'cookies' => $tarro,
        'allow_redirects' => false,
        'http_errors' => false,
        'timeout' => 20,
    ]);

    return [$cliente, $tarro];
}

/** GET como un navegador: [estado HTTP, Location, cuerpo]. */
function pedir(array $navegador, string $consulta, array $cabeceras = []): array
{
    $respuesta = $navegador[0]->request('GET', $consulta, ['headers' => $cabeceras]);

    return [$respuesta->getStatusCode(), $respuesta->getHeaderLine('Location'), (string) $respuesta->getBody()];
}

function cookie(array $navegador, string $nombre): ?string
{
    $cookie = $navegador[1]->getCookieByName($nombre);

    return $cookie && !$cookie->isExpired() ? (string) $cookie->getValue() : null;
}

/** La sesión de Roundcube de ese navegador, leída de la base (formato de rcube_session). */
function sesion(array $navegador): array
{
    global $rcube;
    $id = cookie($navegador, 'roundcube_sessid');
    if ($id === null) {
        return [];
    }
    $db = $rcube->get_dbh();
    $fila = $db->fetch_assoc($db->query('SELECT `vars` FROM ' . $db->table_name('session', true) . ' WHERE `sess_id` = ?', $id));
    $datos = is_array($fila) ? (string) base64_decode((string) $fila['vars']) : '';
    $salida = [];
    $pos = 0;
    while ($pos < strlen($datos) && ($barra = strpos($datos, '|', $pos)) !== false) {
        $valor = @unserialize(substr($datos, $barra + 1), ['allowed_classes' => false]);
        $salida[substr($datos, $pos, $barra - $pos)] = $valor;
        $pos = $barra + 1 + strlen(serialize($valor));
    }

    return $salida;
}

/** El botón de la llave y su viaje al panel: el estado que se lleva, o null. */
function irAlPanel(array $navegador, string $zona = 'Europe/Madrid'): ?string
{
    pedir($navegador, '?_task=login');
    [$estado, $destino] = pedir($navegador, '?_task=login&_action=plugin.mailway_llave_ir&_timezone=' . rawurlencode($zona));
    if ($estado !== 302 || !preg_match('#^https://portal\.test/mi-buzon/correo-web\?destino=127\.0\.0\.1&estado=([A-Za-z0-9_-]{32})$#', $destino, $m)) {
        return null;
    }

    return $m[1];
}

/** La vuelta del panel con este código y este estado: [estado HTTP, Location]. */
function volverDelPanel(array $navegador, string $codigo, string $estado): array
{
    [$http, $destino] = pedir($navegador, '?_task=login&_action=plugin.mailway_llave&_codigo=' . $codigo . '&_estado=' . $estado);

    return [$http, $destino];
}

/** Código nuevo en el panel simulado con su respuesta de canje. */
function codigoNuevo(array $respuesta, int $http = 200): string
{
    $codigo = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    cambiarPanel(static function (array $e) use ($codigo, $respuesta, $http): array {
        $e['codigos'][$codigo] = [$http, $respuesta];

        return $e;
    });

    return $codigo;
}

function canjeDe(string $usuario, string $contrasena, string $sesion, int $segundos = 3600): array
{
    return [
        'usuario' => $usuario,
        'contrasena' => $contrasena,
        'sesion' => $sesion,
        'expira' => (int) floor(microtime(true) * 1000) + $segundos * 1000,
    ];
}

/** ¿Es una redirección a la pantalla de acceso con este aviso? */
function alAcceso(string $destino, string $aviso): bool
{
    return (bool) preg_match('#^/?\?_task=login&_mwllave=' . preg_quote($aviso, '#') . '$#D', $destino);
}

/** Las últimas líneas de los registros, para entender un fallo. */
function registros(): string
{
    $salida = [];
    foreach (glob('/tmp/mailway-llave/registro/*') ?: [] as $f) {
        $salida[] = basename($f) . ': ' . implode(' | ', array_slice(file($f, \FILE_IGNORE_NEW_LINES) ?: [], -3));
    }
    $rc = array_values(array_filter(
        is_file('/tmp/mailway-llave/rc.log') ? (file('/tmp/mailway-llave/rc.log', \FILE_IGNORE_NEW_LINES) ?: []) : [],
        static fn (string $l): bool => !preg_match('/ (Accepted|Closing|\[\d+\]: (GET|POST) )/', $l)
    ));
    if ($rc) {
        $salida[] = 'rc.log: ' . implode(' | ', array_slice($rc, -3));
    }

    return implode(' || ', $salida);
}

function registroDeErrores(): string
{
    return (string) @file_get_contents('/tmp/mailway-llave/registro/errors.log');
}

/* --------------------------- Botón de la pantalla de acceso ------------------- */

estadoPanel(['portales' => [
    '127.0.0.1' => [200, ['portal' => 'https://portal.test/']],
    'caido.test' => [500, ['error' => 'Error interno.', 'code' => 'internal']],
]]);

$a = navegador();
[$http, , $html] = pedir($a, '?_task=login');
$boton = strpos($html, 'id="mailway-llave"');
comprobar(
    $http === 200 && $boton !== false && preg_match('#href="/?\?_task=login&amp;_action=plugin\.mailway_llave_ir"#', $html)
        && str_contains($html, 'Entrar con llave de acceso'),
    'la pantalla de acceso muestra «Entrar con llave de acceso», que lleva a plugin.mailway_llave_ir',
    "{$http} " . ($boton !== false ? substr($html, max(0, $boton - 200), 500) : registros())
);
comprobar(
    $boton !== false && strpos($html, 'id="rcmloginsubmit"') < $boton && str_contains($html, 'class="mailway-llave"')
        && str_contains($html, 'btn btn-secondary btn-lg w-100 mailway-llave'),
    'el botón va debajo del de entrar, como botón secundario'
);
// Las hojas de estilo no se pueden comprobar aquí: Roundcube solo enlaza las de
// los complementos que están dentro de su instalación (los compose los montan
// en /var/www/html/plugins) y la prueba los enlaza desde fuera para no tocarla.
comprobar(
    str_contains($html, 'plugins/mailway_llave/mailway_llave.js') && str_contains($html, 'plugins/mailway_theme/editor.js'),
    'con el script de la zona horaria, junto a la capa de Mailway',
    implode(' ', preg_match_all('/(?:href|src)="([^"]*mailway[^"]*)"/', $html, $recursos) ? $recursos[1] : [])
);
$portales = peticionesDesde(0, '/api/webmail/llave/portal');
comprobar(
    count($portales) === 1 && $portales[0]['metodo'] === 'GET' && $portales[0]['query'] === ['host' => '127.0.0.1']
        && $portales[0]['token'] === TOKEN,
    'pregunta al panel GET /api/webmail/llave/portal?host=<nombre> con X-Mailway-Token',
    json_encode($portales)
);
pedir(navegador(), '?_task=login');
comprobar(count(peticionesDesde(0, '/api/webmail/llave/portal')) === 1, 'la respuesta se recuerda para todos los visitantes (caché compartida)');

[, , $html] = pedir(navegador(), '?_task=login', ['Host' => "otro.test:{$puertoRc}"]);
$ultima = peticionesDesde(0, '/api/webmail/llave/portal');
comprobar(
    str_contains($html, 'rcmloginuser') && !str_contains($html, 'mailway-llave') && (end($ultima)['query']['host'] ?? '') === 'otro.test',
    'en un nombre que el panel no conoce (404) no hay botón (el nombre va sin puerto)'
);
$errores = registroDeErrores();
[, , $html] = pedir(navegador(), '?_task=login', ['Host' => 'caido.test']);
comprobar(
    str_contains($html, 'rcmloginuser') && !str_contains($html, 'mailway-llave')
        && str_contains(substr(registroDeErrores(), strlen($errores)), 'mailway_llave: El panel ha respondido 500 al pedir el portal'),
    'si el panel falla no hay botón, se entra como siempre y queda en el registro de errores'
);
$antes = count(peticionesPanel());
$b = navegador();
[$http, $destino] = pedir($b, '?_task=login&_action=plugin.mailway_llave_ir', ['Host' => 'caido.test']);
comprobar(
    $http === 302 && alAcceso($destino, 'portal') && count(peticionesPanel()) === $antes,
    'plugin.mailway_llave_ir sin portal vuelve al acceso (sin volver a preguntar al panel caído)',
    "{$http} {$destino}"
);
[, , $html] = pedir($b, $destino, ['Host' => 'caido.test']);
comprobar(str_contains($html, 'Ahora no se puede entrar con llave de acceso'), 'con el aviso de que ahora no se puede');

/* ---------------------------- El viaje con estado ------------------------------ */

$c = navegador();
pedir($c, '?_task=login');
$sesionAntes = cookie($c, 'roundcube_sessid');
$estado = irAlPanel($c);
comprobar(
    $estado !== null && cookie($c, 'roundcube_sessid') === $sesionAntes
        && (sesion($c)[mailway_llave::SESION_IDA]['estado'] ?? null) === $estado
        && (sesion($c)[mailway_llave::SESION_IDA]['zona'] ?? null) === 'Europe/Madrid',
    'plugin.mailway_llave_ir guarda el estado y la zona horaria en la sesión previa al acceso y lleva a ${portal}/mi-buzon/correo-web?destino=<nombre>&estado=<estado>',
    (string) $estado . ' ' . json_encode(sesion($c)) . ' ' . registros()
);

// Otro estado (o el enlace abierto en otro navegador): no se pregunta al panel.
$codigoAjeno = codigoNuevo(canjeDe('eva@ejemplo.test', 'Temporal-eva', 'ses-ajena'));
$antes = count(peticionesPanel());
[$http, $destino] = volverDelPanel($c, $codigoAjeno, mailway_llave::nuevoEstado());
comprobar(
    $http === 302 && alAcceso($destino, 'enlace') && !peticionesDesde($antes, '/api/webmail/llave'),
    'con un estado que no coincide vuelve al acceso sin canjear el código',
    "{$http} {$destino}"
);
comprobar(!isset(sesion($c)[mailway_llave::SESION_IDA]), 'y el estado guardado se borra (vale una sola vez, coincida o no)');
[$http, $destino] = volverDelPanel($c, $codigoAjeno, (string) $estado);
comprobar(
    alAcceso($destino, 'enlace') && !peticionesDesde($antes, '/api/webmail/llave'),
    'después, ni el estado bueno sirve: hay que volver a pulsar el botón',
    "{$http} {$destino}"
);
[, , $html] = pedir($c, $destino);
comprobar(
    str_contains($html, 'llave de acceso ha caducado o ya se ha usado') && !isset(sesion($c)['user_id']),
    'la pantalla de acceso lo explica y no hay sesión iniciada'
);

// «Login CSRF»: el enlace completo de otra persona en un navegador que no pulsó el botón.
$victima = navegador();
$estadoAtacante = irAlPanel(navegador());
$codigoAtacante = codigoNuevo(canjeDe('atacante@ejemplo.test', 'Temporal-atacante', 'ses-atacante'));
cuentasImap(['atacante@ejemplo.test' => 'Temporal-atacante']);
$antes = count(peticionesPanel());
[$http, $destino] = volverDelPanel($victima, $codigoAtacante, (string) $estadoAtacante);
comprobar(
    $estadoAtacante !== null && alAcceso($destino, 'enlace') && !peticionesDesde($antes, '/api/webmail/llave')
        && !isset(sesion($victima)['user_id']),
    'el enlace completo de otra persona no hace entrar en su buzón a quien lo abre («login CSRF»)',
    "{$http} {$destino}"
);
pedir($victima, '?_task=login');
$estadoVictima = irAlPanel($victima);
[$http, $destino] = volverDelPanel($victima, $codigoAtacante, (string) $estadoAtacante);
comprobar(
    $estadoVictima !== null && alAcceso($destino, 'enlace') && !peticionesDesde($antes, '/api/webmail/llave'),
    'tampoco si quien lo abre está a mitad de su propio viaje al panel (estados distintos)',
    "{$http} {$destino}"
);

$d = navegador();
$estado = irAlPanel($d);
$antes = count(peticionesPanel());
[$http, $destino] = volverDelPanel($d, 'no/vale%2Bnada', (string) $estado);
comprobar(
    alAcceso($destino, 'enlace') && !peticionesDesde($antes, '/api/webmail/llave'),
    'un código con otro formato no llega al panel',
    "{$http} {$destino}"
);

/* ------------------- Entrada por el camino normal de Roundcube ----------------- */

// El buzón está en un cambio de dominio ya actualizado: el panel da el usuario
// anterior y mailway_cuentas lo traduce al vigente, como con contraseña.
$e = navegador();
$estado = irAlPanel($e);
$sesionPrevia = cookie($e, 'roundcube_sessid');
cambiarPanel(static function (array $p): array {
    $p['cuentas']['ana@viejo.test'] = [
        'login' => 'ana@nuevo.test', 'email' => 'ana@nuevo.test', 'anteriores' => ['ana@viejo.test'], 'otrasDirecciones' => ['ana@viejo.test'],
    ];

    return $p;
});
$codigoAna = codigoNuevo(canjeDe('ana@viejo.test', 'Temporal-ana-1', 'ses-ana-1', 30 * 3600));
cuentasImap(['ana@nuevo.test' => 'Temporal-ana-1']);
$antes = count(peticionesPanel());
$inicio = (int) floor(microtime(true) * 1000);
[$http, $destino] = volverDelPanel($e, $codigoAna, (string) $estado);
comprobar(
    $http === 302 && str_contains($destino, '_task=mail') && !str_contains($destino, '_mwllave'),
    'con el estado y el código buenos se entra (302 al correo)',
    "{$http} {$destino} " . registros()
);
comprobar(
    ultimoLoginImap() === ['usuario' => 'ana@nuevo.test', 'valida' => true],
    'Roundcube entra en el IMAP con la contraseña temporal y el usuario vigente',
    json_encode(ultimoLoginImap())
);
$canjes = peticionesDesde($antes, '/api/webmail/llave');
$cuentas = peticionesDesde($antes, '/api/webmail/cuenta');
comprobar(
    count($canjes) === 1 && $canjes[0]['metodo'] === 'POST' && $canjes[0]['cuerpo'] === ['codigo' => $codigoAna] && $canjes[0]['token'] === TOKEN,
    'canjea el código con POST /api/webmail/llave {codigo} y X-Mailway-Token',
    json_encode($canjes)
);
comprobar(
    count($cuentas) === 1 && $cuentas[0]['cuerpo'] === ['user' => 'ana@viejo.test'],
    'su authenticate va antes que el de mailway_cuentas, que recibe el usuario del panel y lo traduce',
    json_encode($cuentas)
);
$s = sesion($e);
comprobar(
    !empty($s['user_id']) && ($s['username'] ?? '') === 'ana@nuevo.test' && empty($s['temp'])
        && cookie($e, 'roundcube_sessid') !== $sesionPrevia && cookie($e, 'roundcube_sessauth') !== null,
    'la sesión es la de un acceso normal: usuario, id de sesión regenerado y cookie de autenticación',
    json_encode(array_keys($s))
);
comprobar(
    ($s[mailway_llave::SESION]['sesion'] ?? null) === 'ses-ana-1' && !isset($s[mailway_llave::SESION_IDA])
        && ($s[mailway_llave::SESION]['expira'] ?? 0) <= $inicio + 12 * 3600_000 + 5000
        && ($s[mailway_llave::SESION]['expira'] ?? 0) >= $inicio + 12 * 3600_000 - 60_000,
    'guarda el id de la sesión del panel y su caducidad, recortada a 12 horas',
    json_encode($s[mailway_llave::SESION] ?? null)
);
comprobar(($s['timezone'] ?? null) === 'Europe/Madrid', 'con la zona horaria del navegador, como el formulario', (string) ($s['timezone'] ?? ''));
$antes = count(peticionesPanel());
[$http, $destino] = volverDelPanel($e, $codigoAna, (string) $estado);
comprobar(
    $http === 302 && str_contains($destino, '_task=mail') && !peticionesDesde($antes, '/api/webmail/llave'),
    'con la sesión ya iniciada, el mismo enlace lleva al correo sin canjear nada',
    "{$http} {$destino}"
);

// Salir: se retira la contraseña temporal; no queda la cookie del aviso.
$antes = count(peticionesPanel());
[$http, , $html] = pedir($e, '?_task=logout&_token=' . rawurlencode((string) ($s['request_token'] ?? '')));
$salidas = peticionesDesde($antes, '/api/webmail/llave/salir');
comprobar(
    $http === 200 && str_contains($html, 'rcmloginuser') && count($salidas) === 1 && $salidas[0]['cuerpo'] === ['sesion' => 'ses-ana-1']
        && $salidas[0]['token'] === TOKEN,
    'al salir pide al panel POST /api/webmail/llave/salir {sesion}',
    "{$http} " . json_encode($salidas) . ' ' . registros()
);
comprobar(cookie($e, mailway_llave::COOKIE_FIN) === null && !isset(sesion($e)['user_id']), 'y la sesión se cierra sin dejar la cookie del aviso');

/* ------------------------------ Caducidad ------------------------------------- */

// Caduca en 30 s: dentro del margen de un minuto, la siguiente petición cierra.
$f = navegador();
$estado = irAlPanel($f);
cuentasImap(['eva@ejemplo.test' => 'Temporal-eva-1']);
[$http, $destino] = volverDelPanel($f, codigoNuevo(canjeDe('eva@ejemplo.test', 'Temporal-eva-1', 'ses-eva-1', 30)), (string) $estado);
$entrada = $http === 302 && str_contains($destino, '_task=mail');
$antes = count(peticionesPanel());
[$http, $destino] = pedir($f, '?_task=mail');
$salidas = peticionesDesde($antes, '/api/webmail/llave/salir');
comprobar(
    $entrada && $http === 302 && alAcceso($destino, 'caducada') && count($salidas) === 1
        && $salidas[0]['cuerpo'] === ['sesion' => 'ses-eva-1'] && !isset(sesion($f)['user_id']),
    'antes de que caduque la contraseña temporal se cierra la sesión, se retira y se vuelve al acceso',
    "{$http} {$destino} " . json_encode($salidas) . ' ' . registros()
);
[, , $html] = pedir($f, $destino);
comprobar(
    str_contains($html, 'iniciaste con tu llave de acceso ha caducado') && cookie($f, mailway_llave::COOKIE_FIN) === null,
    'con el aviso de sesión caducada (y sin cookie pendiente)'
);

// Lo mismo en una petición AJAX (el refresco de la bandeja).
$g = navegador();
$estado = irAlPanel($g);
volverDelPanel($g, codigoNuevo(canjeDe('eva@ejemplo.test', 'Temporal-eva-1', 'ses-eva-2', 30)), (string) $estado);
$token = (string) (sesion($g)['request_token'] ?? '');
[$http, , $json] = pedir($g, '?_task=mail&_action=refresh&_remote=1', ['X-Roundcube-Request' => $token]);
comprobar(
    $token !== '' && $http === 200 && str_contains($json, 'session_error') && str_contains($json, '_mwllave=caducada')
        && !isset(sesion($g)['user_id']),
    'en AJAX ordena al navegador ir al acceso con el aviso, como una sesión caducada',
    "{$http} " . substr($json, 0, 300)
);

/* ------------- Contraseña temporal retirada antes de tiempo (mailway_sesion) ---- */

$h = navegador();
$estado = irAlPanel($h);
cuentasImap(['eva@ejemplo.test' => 'Temporal-eva-3']);
[$http, $destino] = volverDelPanel($h, codigoNuevo(canjeDe('eva@ejemplo.test', 'Temporal-eva-3', 'ses-eva-3')), (string) $estado);
$entrada = $http === 302 && str_contains($destino, '_task=mail');
cuentasImap([]); // se retiró la llave en «Mi buzón»
$antes = count(peticionesPanel());
[$http, $destino] = pedir($h, '?_task=mail');
$salidas = peticionesDesde($antes, '/api/webmail/llave/salir');
comprobar(
    $entrada && $http === 302 && str_contains($destino, '_mwclave=1') && count($salidas) === 1
        && $salidas[0]['cuerpo'] === ['sesion' => 'ses-eva-3'] && cookie($h, mailway_llave::COOKIE_FIN) === '1',
    'si el IMAP deja de aceptar la contraseña temporal, mailway_sesion cierra, se retira y queda la cookie del aviso',
    "{$http} {$destino} " . json_encode($salidas) . ' ' . registros()
);
[, , $html] = pedir($h, $destino);
comprobar(
    str_contains($html, 'llave de acceso ya no es') && !str_contains($html, 'puede que haya cambiado')
        && cookie($h, mailway_llave::COOKIE_FIN) === null,
    'la pantalla de acceso habla de la sesión con llave, no de una contraseña cambiada'
);

// Con contraseña, mailway_sesion sigue con su aviso de siempre.
$i = navegador();
[, , $pagina] = pedir($i, '?_task=login');
preg_match('/name="_token" value="([^"]+)"/', $pagina, $m);
cuentasImap(['luis@ejemplo.test' => 'Clave-de-luis-1']);
$respuesta = $i[0]->request('POST', '?_task=login', ['form_params' => [
    '_token' => $m[1] ?? '', '_task' => 'login', '_action' => 'login', '_timezone' => 'Europe/Madrid', '_url' => '',
    '_user' => 'luis@ejemplo.test', '_pass' => 'Clave-de-luis-1',
]]);
$entrada = $respuesta->getStatusCode() === 302 && !isset(sesion($i)[mailway_llave::SESION]);
cuentasImap([]);
$antes = count(peticionesPanel());
[$http, $destino] = pedir($i, '?_task=mail');
[, , $html] = pedir($i, $destino);
comprobar(
    $entrada && str_contains($destino, '_mwclave=1') && str_contains($html, 'puede que haya cambiado')
        && !str_contains($html, 'llave de acceso ya no es') && !peticionesDesde($antes, '/api/webmail/llave/salir'),
    'una sesión con contraseña cerrada por mailway_sesion conserva su aviso y no llama al panel',
    "{$respuesta->getStatusCode()} {$destino}"
);

/* ------------------------------ Fallos del panel ------------------------------ */

// El IMAP no acepta lo que dio el panel: se retira y se vuelve al acceso.
$j = navegador();
$estado = irAlPanel($j);
cuentasImap(['eva@ejemplo.test' => 'otra']);
$antes = count(peticionesPanel());
[$http, $destino] = volverDelPanel($j, codigoNuevo(canjeDe('eva@ejemplo.test', 'Temporal-mala', 'ses-mala')), (string) $estado);
$salidas = peticionesDesde($antes, '/api/webmail/llave/salir');
comprobar(
    $http === 302 && alAcceso($destino, 'fallo') && ultimoLoginImap() === ['usuario' => 'eva@ejemplo.test', 'valida' => false]
        && count($salidas) === 1 && $salidas[0]['cuerpo'] === ['sesion' => 'ses-mala'] && !isset(sesion($j)['user_id']),
    'si el IMAP rechaza la contraseña temporal, se retira y se vuelve al acceso con el aviso',
    "{$http} {$destino} " . json_encode($salidas)
);
[, , $html] = pedir($j, $destino);
comprobar(str_contains($html, 'No se ha podido entrar con tu llave de acceso'), 'que explica que no se ha podido entrar');

// Código gastado o caducado (404 passkey_code_invalid).
$k = navegador();
$estado = irAlPanel($k);
$antes = count(peticionesPanel());
[$http, $destino] = volverDelPanel($k, str_repeat('Z', 43), (string) $estado);
comprobar(
    alAcceso($destino, 'enlace') && count(peticionesDesde($antes, '/api/webmail/llave')) === 1,
    'un código que el panel no reconoce (404) vuelve al acceso con el aviso de enlace caducado',
    "{$http} {$destino}"
);

// El panel falla al canjear.
$l = navegador();
$estado = irAlPanel($l);
$errores = registroDeErrores();
[$http, $destino] = volverDelPanel($l, codigoNuevo(['error' => 'Error interno.', 'code' => 'internal'], 500), (string) $estado);
comprobar(
    alAcceso($destino, 'fallo')
        && str_contains(substr(registroDeErrores(), strlen($errores)), 'mailway_llave: El panel ha respondido 500 al canjear el código'),
    'si el panel falla al canjear, vuelve al acceso y queda en el registro de errores',
    "{$http} {$destino}"
);
$l2 = navegador();
$estado = irAlPanel($l2);
[$http, $destino] = volverDelPanel($l2, codigoNuevo(['usuario' => 'eva@ejemplo.test', 'contrasena' => 'x']), (string) $estado);
comprobar(alAcceso($destino, 'fallo'), 'una respuesta del canje incompleta tampoco deja entrar', "{$http} {$destino}");

comprobar(
    !str_contains(registroDeErrores() . registros(), 'Temporal-') && !str_contains(registroDeErrores(), $codigoAna),
    'los registros no contienen contraseñas temporales ni códigos'
);

/* ---------------------------------- Final ----------------------------------- */

foreach ($procesos as $proceso) {
    proc_terminate($proceso);
}
foreach (array_keys($enlacesRc) as $nombre) {
    @unlink("{$complementosRc}/{$nombre}");
}
array_map('unlink', glob($registrosRc . '/*') ?: []);
foreach ([$base, $estadoPanel, $registroPanel, $enrutador, $estadoImap, $registroImap, $imapFalso, $prependRc,
    $configRc . '/config.inc.php', "{$tmp}/imap.log", "{$tmp}/rc.log"] as $f) {
    @unlink($f);
}
foreach ([$registrosRc, $configRc, $complementosRc, $tmp] as $d) {
    @rmdir($d);
}
if ($fallos > 0) {
    echo "FALLO: {$fallos} comprobaciones del complemento mailway_llave han fallado.\n";
    exit(1);
}
echo 'OK: complemento mailway_llave con Roundcube ' . RCMAIL_VERSION . "\n";
exit(0);
