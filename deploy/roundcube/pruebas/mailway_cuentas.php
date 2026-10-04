<?php

/*
 * Prueba del complemento mailway_cuentas con la imagen real de Roundcube.
 *
 * Usa la biblioteca de la imagen (rcube_db, rcube_user, rcube_plugin_api y el
 * cliente HTTP de rcube) y su esquema SQLite (SQL/sqlite.initial.sql) sobre
 * una base desechable en /tmp. El panel de Mailway se simula con el servidor
 * integrado de PHP en 127.0.0.1, dentro del mismo contenedor y sin red:
 *
 *   docker run --rm -v "$PWD/deploy/roundcube:/opt/mailway-rc:ro" \
 *     roundcube/roundcubemail:1.7.x-apache php /opt/mailway-rc/pruebas/mailway_cuentas.php
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
// Los avisos que el complemento manda al registro se recogen abajo (gancho
// raise_error) en vez de ensuciar la salida.
define('ROUNDCUBE_STDERR_DISABLE', true);
require_once INSTALL_PATH . 'program/include/iniset.php';

$complemento = dirname(__DIR__) . '/mailway_cuentas';
require_once $complemento . '/datos.php';
require_once $complemento . '/mailway_cuentas.php';

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

/* ------------------------------ Base de Roundcube ---------------------------- */

const HOST = 'mailway-mail';
$base = '/tmp/mailway-cuentas-prueba.db';
@unlink($base);
$rcube = rcube::get_instance();
$rcube->config->set('db_dsnw', 'sqlite:///' . $base . '?mode=0600');
$rcube->config->set('imap_host', 'ssl://mailway-mail:993');
$db = $rcube->get_dbh();
// El driver SQLite de Roundcube crea el esquema (SQL/sqlite.initial.sql de la
// imagen) al conectar con una base vacía, igual que en el webmail.
$esquema = RCUBE_INSTALL_PATH . 'SQL/sqlite.initial.sql';
$db->db_connect('w');
$tablas = $db->is_connected() ? (array) $db->list_tables() : [];
if (!is_file($esquema) || array_diff(['users', 'identities', 'contacts'], $tablas)) {
    echo "FALLO: no se ha podido crear el esquema de Roundcube ({$esquema}): " . ($db->is_error() ?: 'faltan tablas') . "\n";
    exit(2);
}
echo 'OK: esquema SQLite de Roundcube ' . RCMAIL_VERSION . " ({$esquema})\n";

function crearUsuario(string $usuario, string $host = HOST): int
{
    global $db;
    $db->query(
        'INSERT INTO ' . $db->table_name('users', true)
        . ' (`username`, `mail_host`, `created`, `preferences`) VALUES (?, ?, ' . $db->now() . ', ?)',
        $usuario,
        $host,
        serialize(['timezone' => 'Europe/Madrid'])
    );

    return (int) $db->insert_id('users');
}

function crearIdentidad(int $userId, string $email, bool $predeterminada, string $firma = ''): int
{
    global $db;
    $db->query(
        'INSERT INTO ' . $db->table_name('identities', true)
        . ' (`user_id`, `changed`, `standard`, `name`, `email`, `signature`, `html_signature`)'
        . ' VALUES (?, ' . $db->now() . ', ?, ?, ?, ?, ?)',
        $userId,
        $predeterminada ? 1 : 0,
        'Nombre ' . $userId,
        $email,
        $firma,
        $firma !== '' ? 1 : 0
    );

    return (int) $db->insert_id('identities');
}

function crearContacto(int $userId, string $email): void
{
    global $db;
    $db->query(
        'INSERT INTO ' . $db->table_name('contacts', true)
        . ' (`user_id`, `changed`, `name`, `email`, `vcard`, `words`) VALUES (?, ' . $db->now() . ', ?, ?, ?, ?)',
        $userId,
        'Contacto',
        $email,
        "BEGIN:VCARD\nVERSION:3.0\nFN:Contacto\nEMAIL:{$email}\nEND:VCARD",
        " contacto {$email}"
    );
}

function contar(string $tabla, string $donde = '1 = 1', ...$parametros): int
{
    global $db;
    $resultado = $db->query('SELECT COUNT(*) AS n FROM ' . $db->table_name($tabla, true) . " WHERE {$donde}", ...$parametros);

    return (int) ($db->fetch_assoc($resultado)['n'] ?? -1);
}

function usuarioDe(int $userId): ?string
{
    global $db;
    $fila = $db->fetch_assoc($db->query(
        'SELECT `username` FROM ' . $db->table_name('users', true) . ' WHERE `user_id` = ?',
        $userId
    ));

    return $fila['username'] ?? null;
}

function identidad(int $identityId): array
{
    global $db;

    return $db->fetch_assoc($db->query(
        'SELECT * FROM ' . $db->table_name('identities', true) . ' WHERE `identity_id` = ?',
        $identityId
    )) ?: [];
}

/* -------------------------------- trasladarFila ------------------------------ */

$ana = crearUsuario('ana@viejo.test');
crearIdentidad($ana, 'ana@viejo.test', true, '<b>Ana</b> · Firma');
crearContacto($ana, 'cliente@externo.test');
crearContacto($ana, 'proveedor@externo.test');
$filas = contar('users');

$r = mailway_cuentas_datos::trasladarFila($db, HOST, 'ana@nuevo.test', ['ana@viejo.test']);
comprobar($r === 'trasladada', 'trasladarFila traslada la fila del usuario anterior al vigente', $r);
comprobar(usuarioDe($ana) === 'ana@nuevo.test', 'la fila conserva su user_id con el usuario nuevo', (string) usuarioDe($ana));
comprobar(contar('contacts', '`user_id` = ?', $ana) === 2, 'los contactos siguen con la misma fila');
comprobar(contar('users') === $filas, 'no se crea ni se borra ninguna fila de users');
$r = mailway_cuentas_datos::trasladarFila($db, HOST, 'ana@nuevo.test', ['ana@viejo.test']);
comprobar($r === 'sin_cambios', 'repetir el traslado no cambia nada', $r);
comprobar(usuarioDe($ana) === 'ana@nuevo.test', 'la fila sigue con el usuario nuevo tras repetir');

// El titular ya había entrado con la dirección nueva: Roundcube le creó una
// fila vacía, que se aparta (nunca se borra).
$luis = crearUsuario('luis@viejo.test');
crearIdentidad($luis, 'luis@viejo.test', true);
crearContacto($luis, 'cliente@externo.test');
$luisVacio = crearUsuario('luis@nuevo.test');
crearIdentidad($luisVacio, 'luis@nuevo.test', true);
$filas = contar('users');
$identidades = contar('identities');
$r = mailway_cuentas_datos::trasladarFila($db, HOST, 'luis@nuevo.test', ['luis@viejo.test']);
comprobar($r === 'trasladada_apartando', 'con fila del usuario vigente, la aparta y traslada la anterior', $r);
comprobar(usuarioDe($luis) === 'luis@nuevo.test', 'la fila con los datos pasa al usuario vigente');
comprobar(
    usuarioDe($luisVacio) === 'luis@nuevo.test#apartado-' . $luisVacio,
    'la fila que estorbaba queda apartada como <usuario>#apartado-<id>',
    (string) usuarioDe($luisVacio)
);
comprobar(contar('users') === $filas && contar('identities') === $identidades, 'apartar no borra filas ni identidades');
comprobar(contar('contacts', '`user_id` = ?', $luis) === 1, 'los contactos de la fila trasladada siguen');
$r = mailway_cuentas_datos::trasladarFila($db, HOST, 'luis@nuevo.test', ['luis@viejo.test']);
comprobar($r === 'sin_cambios' && usuarioDe($luisVacio) === 'luis@nuevo.test#apartado-' . $luisVacio, 'repetir tras apartar no cambia nada', $r);

// Otro servidor IMAP, el propio usuario como «anterior» o nada que trasladar.
$otroHost = crearUsuario('marta@viejo.test', 'otro-servidor');
$r = mailway_cuentas_datos::trasladarFila($db, HOST, 'marta@nuevo.test', ['marta@viejo.test']);
comprobar($r === 'sin_cambios' && usuarioDe($otroHost) === 'marta@viejo.test', 'no toca filas de otro servidor IMAP', $r);
comprobar(
    mailway_cuentas_datos::trasladarFila($db, HOST, 'ana@nuevo.test', ['ana@nuevo.test', 'no-es-una-direccion']) === 'sin_cambios'
        && mailway_cuentas_datos::trasladarFila($db, HOST, 'ana@nuevo.test', []) === 'sin_cambios'
        && mailway_cuentas_datos::trasladarFila($db, '', 'ana@nuevo.test', ['ana@viejo.test']) === 'sin_cambios',
    'sin un anterior válido distinto del vigente no hace nada'
);

// Un usuario largo: el nombre apartado no pasa de los 128 de users.username.
$largo = str_repeat('a', 110) . '@nuevo.test';
$largoViejo = crearUsuario(str_repeat('a', 110) . '@viejo.test');
$largoVacio = crearUsuario($largo);
$r = mailway_cuentas_datos::trasladarFila($db, HOST, $largo, [str_repeat('a', 110) . '@viejo.test']);
$apartado = (string) usuarioDe($largoVacio);
comprobar(
    $r === 'trasladada_apartando' && strlen($apartado) <= 128 && str_ends_with($apartado, '#apartado-' . $largoVacio)
        && usuarioDe($largoViejo) === $largo,
    'el nombre apartado se recorta a 128 caracteres y conserva el id',
    $apartado
);

/* ---------------------------- actualizarIdentidades -------------------------- */

$eva = crearUsuario('eva@viejo.test');
$evaPrincipal = crearIdentidad($eva, 'eva@viejo.test', true, '<p>Eva Pérez</p><p>Dirección</p>');
$evaInfo = crearIdentidad($eva, 'info@viejo.test', false);
$antes = identidad($evaPrincipal);
$usuarioEva = new rcube_user($eva);
$cambio = mailway_cuentas_datos::actualizarIdentidades($usuarioEva, 'eva@nuevo.test', ['eva@viejo.test']);
$despues = identidad($evaPrincipal);
comprobar($cambio === true && $despues['email'] === 'eva@nuevo.test', 'la identidad predeterminada pasa a la dirección vigente', json_encode($despues));
comprobar(
    $despues['name'] === $antes['name'] && $despues['signature'] === $antes['signature']
        && (int) $despues['html_signature'] === 1 && (int) $despues['standard'] === 1,
    'conserva el nombre, la firma HTML y que es la predeterminada'
);
comprobar(identidad($evaInfo)['email'] === 'info@viejo.test', 'no toca otras identidades');
$repetido = mailway_cuentas_datos::actualizarIdentidades(new rcube_user($eva), 'eva@nuevo.test', ['eva@viejo.test']);
comprobar($repetido === false && identidad($evaPrincipal) == $despues, 'la segunda vez no cambia nada');
// Volver al dominio anterior: la misma regla en sentido contrario.
$vuelta = mailway_cuentas_datos::actualizarIdentidades(new rcube_user($eva), 'eva@viejo.test', ['eva@nuevo.test']);
comprobar($vuelta === true && identidad($evaPrincipal)['email'] === 'eva@viejo.test', 'al volver, la identidad recupera la dirección anterior');

// La predeterminada es otra (un alias): cambia la primera con la dirección anterior.
$pau = crearUsuario('pau@viejo.test');
$pauAlias = crearIdentidad($pau, 'ventas@viejo.test', true);
$pauPropia = crearIdentidad($pau, 'pau@viejo.test', false, 'Pau');
$cambio = mailway_cuentas_datos::actualizarIdentidades(new rcube_user($pau), 'pau@nuevo.test', ['pau@viejo.test']);
comprobar(
    $cambio === true && identidad($pauPropia)['email'] === 'pau@nuevo.test' && identidad($pauAlias)['email'] === 'ventas@viejo.test',
    'si la predeterminada no es del buzón, cambia la primera que lo es'
);
$usuarioSinDatos = mailway_cuentas_datos::actualizarIdentidades(new rcube_user($pau), 'pau@nuevo.test', []);
comprobar($usuarioSinDatos === false, 'sin direcciones anteriores no hace nada');

/* ------------------------- hostDeAlmacen y la respuesta ---------------------- */

comprobar(mailway_cuentas_datos::hostDeAlmacen('ssl://mailway-mail:993', null) === 'mailway-mail', 'mail_host desde el host del formulario');
comprobar(mailway_cuentas_datos::hostDeAlmacen(null, 'ssl://mailway-mail:993') === 'mailway-mail', 'mail_host desde imap_host');
comprobar(
    mailway_cuentas_datos::hostDeAlmacen('', ['tls://mailway-mail:143' => 'Mailway']) === 'mailway-mail',
    'mail_host desde un imap_host con varias opciones'
);
comprobar(
    mailway_cuentas_datos::validarRespuesta([
        'login' => 'Ana@Viejo.test', 'email' => 'ana@nuevo.test', 'anteriores' => [], 'otrasDirecciones' => ['ana@viejo.test', 7],
    ]) === ['login' => 'ana@viejo.test', 'email' => 'ana@nuevo.test', 'anteriores' => [], 'otrasDirecciones' => ['ana@viejo.test']],
    'la respuesta del panel se valida y se pasa a minúsculas'
);
comprobar(
    mailway_cuentas_datos::validarRespuesta(null) === null
        && mailway_cuentas_datos::validarRespuesta(['login' => 'sin-arroba', 'email' => 'a@b.test']) === null
        && mailway_cuentas_datos::validarRespuesta(['login' => "a@b.test\nX: y", 'email' => 'a@b.test']) === null,
    'una respuesta sin la forma esperada se descarta'
);

/* ------------------- El complemento con un panel simulado -------------------- */

$puerto = 18765;
$estadoPanel = '/tmp/mailway-cuentas-panel.json';
$registroPanel = '/tmp/mailway-cuentas-peticiones.jsonl';
$enrutador = '/tmp/mailway-cuentas-panel.php';
@unlink($registroPanel);
// El panel simulado contesta según el fichero de estado y anota cada petición.
file_put_contents($enrutador, <<<'PHP'
<?php
$estado = json_decode((string) @file_get_contents('/tmp/mailway-cuentas-panel.json'), true) ?: [];
$cuerpo = (string) file_get_contents('php://input');
file_put_contents('/tmp/mailway-cuentas-peticiones.jsonl', json_encode([
    'metodo' => $_SERVER['REQUEST_METHOD'],
    'ruta' => $_SERVER['REQUEST_URI'],
    'token' => $_SERVER['HTTP_X_MAILWAY_TOKEN'] ?? null,
    'tipo' => $_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? null,
    'cuerpo' => json_decode($cuerpo, true),
]) . "\n", FILE_APPEND);
if (($_SERVER['HTTP_X_MAILWAY_TOKEN'] ?? '') !== 'secreto-de-prueba') {
    http_response_code(401);
    echo '{"error":"El token del webmail no es válido.","code":"webmail_token_invalid"}';
    return;
}
$usuario = json_decode($cuerpo, true)['user'] ?? '';
if (isset($estado['dormir'])) {
    sleep((int) $estado['dormir']);
}
if (isset($estado['crudo'])) {
    echo $estado['crudo'];
    return;
}
if (!isset($estado['cuentas'][$usuario])) {
    http_response_code(404);
    echo '{"error":"No hay ningún buzón con esa dirección o ese usuario.","code":"not_found"}';
    return;
}
header('Content-Type: application/json');
echo json_encode($estado['cuentas'][$usuario]);
PHP);

function estadoPanel(array $estado): void
{
    file_put_contents('/tmp/mailway-cuentas-panel.json', json_encode($estado));
}

/** @return array<int, array<string, mixed>> */
function peticionesPanel(): array
{
    $lineas = is_file('/tmp/mailway-cuentas-peticiones.jsonl')
        ? file('/tmp/mailway-cuentas-peticiones.jsonl', \FILE_IGNORE_NEW_LINES | \FILE_SKIP_EMPTY_LINES)
        : [];

    return array_map(static fn (string $l): array => json_decode($l, true), $lineas);
}

estadoPanel([]);
$servidor = proc_open(
    [\PHP_BINARY, '-S', "127.0.0.1:{$puerto}", $enrutador],
    [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
    $tuberias
);
register_shutdown_function(static function () use ($servidor): void {
    if (is_resource($servidor)) {
        proc_terminate($servidor);
    }
});
for ($i = 0; $i < 50; $i++) {
    $conexion = @fsockopen('127.0.0.1', $puerto, $codigo, $error, 0.2);
    if ($conexion) {
        fclose($conexion);
        break;
    }
    usleep(100_000);
}
comprobar(isset($conexion) && $conexion !== false, "panel simulado escuchando en 127.0.0.1:{$puerto}");

// Los avisos del complemento al registro de errores, para comprobarlos.
$avisos = [];
$api = rcube_plugin_api::get_instance();
// Como en el webmail (rcmail), los ganchos van por la API de complementos real:
// rcube sin más usa una ficticia y raise_error no llegaría al gancho de abajo.
$rcube->plugins = $api;

function reiniciarGanchos(): void
{
    global $api, $avisos;
    $api->handlers = [];
    $api->register_hook('raise_error', static function (array $arg): array {
        $GLOBALS['avisos'][] = (string) ($arg['message'] ?? '');

        return $arg;
    });
    $avisos = [];
}

/** Instancia el complemento con estas variables de entorno, como lo haría Roundcube. */
function complemento(?string $panel, ?string $token): mailway_cuentas
{
    global $api;
    reiniciarGanchos();
    putenv($panel === null ? 'MAILWAY_PANEL_INTERNAL_URL' : "MAILWAY_PANEL_INTERNAL_URL={$panel}");
    putenv($token === null ? 'MAILWAY_WEBMAIL_TOKEN' : "MAILWAY_WEBMAIL_TOKEN={$token}");
    $plugin = new mailway_cuentas($api);
    $plugin->init();

    return $plugin;
}

function entrar(string $usuario, bool $valida = true): array
{
    global $api;

    return $api->exec_hook('authenticate', [
        'host' => 'ssl://mailway-mail:993',
        'user' => $usuario,
        'pass' => 'contraseña',
        'valid' => $valida,
        'error' => null,
        'cookiecheck' => true,
    ]);
}

$panel = "http://127.0.0.1:{$puerto}";

// Sin las variables, el complemento no registra nada.
complemento(null, null);
comprobar(empty($api->handlers['authenticate']) && empty($api->handlers['login_after']), 'sin MAILWAY_PANEL_INTERNAL_URL ni token no registra ningún gancho');
complemento($panel, null);
comprobar(empty($api->handlers['authenticate']), 'sin MAILWAY_WEBMAIL_TOKEN tampoco');
$sinCambio = entrar('ana@nuevo.test');
comprobar($sinCambio['user'] === 'ana@nuevo.test' && !peticionesPanel(), 'y se entra como siempre, sin preguntar al panel');

// Pendiente de actualizar: se teclea la dirección nueva y se entra con el usuario anterior.
$sofia = crearUsuario('sofia@viejo.test');
$sofiaPrincipal = crearIdentidad($sofia, 'sofia@viejo.test', true, 'Sofía');
crearContacto($sofia, 'amiga@externo.test');
estadoPanel(['cuentas' => [
    'sofia@nuevo.test' => ['login' => 'sofia@viejo.test', 'email' => 'sofia@nuevo.test', 'anteriores' => [], 'otrasDirecciones' => ['sofia@viejo.test']],
]]);
complemento($panel . '/', 'secreto-de-prueba');
comprobar(count($api->handlers['authenticate'] ?? []) === 1 && count($api->handlers['login_after'] ?? []) === 1, 'con las dos variables registra authenticate y login_after');
$args = entrar('  Sofia@Nuevo.test ');
comprobar($args['user'] === 'sofia@viejo.test', 'authenticate traduce la dirección nueva al usuario del motor', (string) $args['user']);
$peticion = peticionesPanel()[0] ?? [];
comprobar(
    ($peticion['metodo'] ?? '') === 'POST' && ($peticion['ruta'] ?? '') === '/api/webmail/cuenta'
        && ($peticion['token'] ?? '') === 'secreto-de-prueba' && str_starts_with((string) ($peticion['tipo'] ?? ''), 'application/json')
        && ($peticion['cuerpo'] ?? null) === ['user' => 'sofia@nuevo.test'],
    'consulta POST /api/webmail/cuenta con X-Mailway-Token y {"user"} en JSON (cliente HTTP de rcube)',
    json_encode($peticion)
);
comprobar(usuarioDe($sofia) === 'sofia@viejo.test', 'sin usuario anterior no se traslada ninguna fila');
// rcmail::login fija el usuario; después Roundcube ejecuta login_after.
$rcube->user = rcube_user::query('sofia@viejo.test', HOST);
$api->exec_hook('login_after', ['_task' => 'mail']);
comprobar(identidad($sofiaPrincipal)['email'] === 'sofia@nuevo.test', 'login_after pasa la identidad a la dirección vigente');
comprobar(identidad($sofiaPrincipal)['signature'] === 'Sofía', 'y conserva la firma');

// Ya actualizado: se teclea la dirección vieja, se entra con la nueva y la fila se traslada.
estadoPanel(['cuentas' => [
    'sofia@viejo.test' => ['login' => 'sofia@nuevo.test', 'email' => 'sofia@nuevo.test', 'anteriores' => ['sofia@viejo.test'], 'otrasDirecciones' => ['sofia@viejo.test']],
]]);
complemento($panel, 'secreto-de-prueba');
$args = entrar('sofia@viejo.test');
comprobar($args['user'] === 'sofia@nuevo.test', 'tras actualizar, lo tecleado lleva al usuario nuevo');
comprobar(usuarioDe($sofia) === 'sofia@nuevo.test', 'y la fila del usuario anterior pasa al nuevo, con su user_id');
comprobar(contar('contacts', '`user_id` = ?', $sofia) === 1, 'con sus contactos');
$rcube->user = rcube_user::query('sofia@nuevo.test', HOST);
comprobar($rcube->user && (int) $rcube->user->ID === $sofia, 'Roundcube encuentra la fila trasladada al entrar con el usuario nuevo');
$api->exec_hook('login_after', ['_task' => 'mail']);
comprobar(identidad($sofiaPrincipal)['email'] === 'sofia@nuevo.test', 'login_after no cambia nada que ya esté al día');
comprobar(!$avisos, 'el camino bueno no escribe en el registro de errores', implode(' | ', $avisos));

// Casos en los que se entra como siempre.
$peticionesAntes = count(peticionesPanel());
$noValida = entrar('sofia@viejo.test', false);
$sinArroba = entrar('sofia');
comprobar(
    $noValida['user'] === 'sofia@viejo.test' && $sinArroba['user'] === 'sofia' && count(peticionesPanel()) === $peticionesAntes,
    'sin el token del formulario o sin «@» no pregunta al panel'
);
$desconocido = entrar('nadie@nuevo.test');
comprobar($desconocido['user'] === 'nadie@nuevo.test' && !$avisos, 'un 404 del panel deja lo tecleado y no es un error');
estadoPanel(['crudo' => '<html>no es JSON</html>']);
$basura = entrar('sofia@viejo.test');
comprobar($basura['user'] === 'sofia@viejo.test' && count($avisos) === 1, 'una respuesta que no es JSON deja lo tecleado y se registra');
estadoPanel(['crudo' => json_encode(['login' => 'sin-arroba', 'email' => 'sofia@nuevo.test'])]);
$malFormada = entrar('sofia@viejo.test');
comprobar($malFormada['user'] === 'sofia@viejo.test', 'una respuesta sin la forma esperada deja lo tecleado');

complemento($panel, 'secreto-equivocado');
$tokenMalo = entrar('sofia@viejo.test');
comprobar(
    $tokenMalo['user'] === 'sofia@viejo.test' && count($avisos) === 1 && str_contains($avisos[0], 'MAILWAY_WEBMAIL_TOKEN'),
    'con un token erróneo (401) se entra como siempre y se avisa en el registro',
    implode(' | ', $avisos)
);

complemento('http://127.0.0.1:1', 'secreto-de-prueba');
$inicio = microtime(true);
$caido = entrar('sofia@viejo.test');
$espera = microtime(true) - $inicio;
comprobar(
    $caido['user'] === 'sofia@viejo.test' && $espera < 3 && count($avisos) === 1,
    'con el panel caído se entra como siempre, sin esperar más de 2 s',
    sprintf('%.2f s', $espera)
);

// El panel acepta la conexión pero no contesta: el plazo total es de 2 s.
// Va la última: el servidor integrado de PHP atiende una petición cada vez.
complemento($panel, 'secreto-de-prueba');
estadoPanel(['dormir' => 6, 'cuentas' => []]);
$inicio = microtime(true);
$lento = entrar('sofia@viejo.test');
$espera = microtime(true) - $inicio;
comprobar(
    $lento['user'] === 'sofia@viejo.test' && $espera < 3.5 && count($avisos) === 1,
    'con el panel colgado se entra como siempre tras el plazo de 2 s',
    sprintf('%.2f s', $espera)
);

/* ---------------------------------- Final ----------------------------------- */

@unlink($base);
@unlink($enrutador);
@unlink($estadoPanel);
@unlink($registroPanel);
if ($fallos > 0) {
    echo "FALLO: {$fallos} comprobaciones del complemento mailway_cuentas han fallado.\n";
    exit(1);
}
echo "OK: complemento mailway_cuentas con Roundcube " . RCMAIL_VERSION . "\n";
exit(0);
