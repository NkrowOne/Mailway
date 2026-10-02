<?php

/*
 * Configuración de Roundcube para Mailway.
 *
 * El entrypoint de la imagen roundcube/roundcubemail incluye todos los
 * /var/roundcube/config/*.php DESPUÉS de lo que genera a partir de las
 * variables ROUNDCUBEMAIL_*, así que lo de aquí prevalece. El compose monta
 * este fichero en solo lectura; los valores que cambian por instalación
 * llegan por variables de entorno (MAILWAY_*), nunca escritos aquí.
 *
 * Criterio: que el webmail funcione desde el primer minuto (por la red
 * interna, sin depender del certificado público), en español, con la marca
 * del operador y con valores de uso cómodos para quien viene de Gmail u
 * Outlook.
 */

// Lectura de variables con valor por defecto. Es una closure y no una
// función con nombre: este fichero se incluye dentro de un método de
// Roundcube, y una función global redeclarada sería un error fatal.
$mailwayEnv = static function (string $name, string $default = ''): string {
    $value = getenv($name);

    return ($value === false || trim($value) === '') ? $default : trim($value);
};

/* ------------------------------ Idioma y marca ----------------------------- */

$config['language'] = 'es_ES';
$config['product_name'] = $mailwayEnv('MAILWAY_BRAND', 'Webmail');
// Solo el nombre en la pantalla de acceso, sin número de versión.
$config['display_product_info'] = 1;
// Sin versión en la cabecera User-Agent de los mensajes enviados.
$config['useragent'] = $config['product_name'];

$mailwayPanelUrl = rtrim($mailwayEnv('MAILWAY_PANEL_URL'), '/');
if ($mailwayPanelUrl !== '') {
    // «Mi buzón» del panel: datos de conexión, dispositivos y contraseñas
    // de aplicación, sin depender del administrador.
    $config['support_url'] = $mailwayPanelUrl . '/mi-buzon';
}

$config['timezone'] = 'auto';
$config['date_format'] = 'd/m/Y';
$config['time_format'] = 'H:i';

/* ---------------------------- Inicio de sesión ----------------------------- */

// Usuario = dirección completa: los buzones de todos los clientes conviven
// en el mismo motor y un nombre sin dominio sería ambiguo.
$config['username_domain'] = '';
$config['login_username_filter'] = 'email';
$config['login_lc'] = 2;
// El navegador puede recordar la dirección (no la contraseña).
$config['login_autocomplete'] = 1;
$config['session_lifetime'] = 30;

// Detrás de Traefik: se aceptan X-Forwarded-For y X-Forwarded-Proto solo de
// las redes de Docker. Así el límite de intentos fallidos de Roundcube
// (login_rate_limit, por IP) cuenta la IP real del visitante y las cookies
// se marcan como seguras al servirse por HTTPS.
$config['proxy_whitelist'] = array_values(array_filter(array_map(
    'trim',
    explode(',', $mailwayEnv('MAILWAY_PROXY_WHITELIST', '172.16.0.0/12,192.168.0.0/16,10.0.0.0/8'))
)));

/* ------------------------- Conexión con el motor ---------------------------- */

// El webmail llega al motor por la red interna (ssl://mailway-mail). El
// certificado del motor es de su nombre público —o autofirmado mientras no
// se emita—, así que la verificación se desactiva SOLO para ese host
// interno; cualquier otro servidor se verificaría con normalidad.
$mailwayTlsInterno = [
    'ssl' => [
        'verify_peer' => false,
        'verify_peer_name' => false,
        'allow_self_signed' => true,
    ],
];
$config['imap_conn_options'] = ['mailway-mail' => $mailwayTlsInterno];
$config['smtp_conn_options'] = ['mailway-mail' => $mailwayTlsInterno];
$config['managesieve_conn_options'] = ['mailway-mail' => $mailwayTlsInterno];
$config['smtp_user'] = '%u';
$config['smtp_pass'] = '%p';

// Carpetas especiales con los nombres que crea Stalwart. Roundcube las
// muestra traducidas («Enviados», «Papelera», «Correo no deseado»).
$config['drafts_mbox'] = 'Drafts';
$config['sent_mbox'] = 'Sent Items';
$config['junk_mbox'] = 'Junk Mail';
$config['trash_mbox'] = 'Deleted Items';
$config['archive_mbox'] = 'Archive';
$config['create_default_folders'] = true;
$config['show_real_foldernames'] = false;

/* ------------------------ Filtros y respuesta automática -------------------- */

// Roundcube 1.7: esquema y puerto van en el host (tls:// = STARTTLS).
$config['managesieve_host'] = 'tls://mailway-mail:4190';
$config['managesieve_vacation'] = 1;
$config['managesieve_forward'] = 1;
$config['managesieve_raw_editor'] = false;

/* ------------------------------- Uso diario -------------------------------- */

$config['prefer_html'] = true;
// Imágenes remotas: solo de contactos y remitentes conocidos. Bloquearlas
// siempre es incómodo; permitirlas siempre delata la apertura del mensaje.
$config['show_images'] = 1;
// Redactar en HTML salvo al responder a un mensaje de texto plano.
$config['htmleditor'] = 4;
$config['draft_autosave'] = 60;
// Responder encima del mensaje citado, con la firma bajo la respuesta,
// como en Gmail y Outlook.
$config['reply_mode'] = 1;
$config['sig_below'] = true;
$config['strip_existing_sig'] = true;
// La dirección junto al nombre ayuda a detectar suplantaciones.
$config['message_show_email'] = true;
$config['mdn_requests'] = 0;
// Tamaño total del mensaje: 25 MB de adjuntos más la codificación. Casi
// ningún proveedor acepta mensajes mayores.
$config['max_message_size'] = '30M';

// Marcar como correo no deseado lo mueve a la carpeta del motor, y al
// revés al desmarcarlo.
$config['markasjunk_move_spam'] = true;
$config['markasjunk_move_ham'] = true;
$config['markasjunk_read_spam'] = true;

$config['newmail_notifier_basic'] = true;
$config['newmail_notifier_desktop'] = true;
$config['attachment_reminder'] = true;

// Corrector ortográfico: la imagen solo trae el diccionario inglés, así que
// se desactiva salvo que se instalen otros con ROUNDCUBEMAIL_ASPELL_DICTS
// (p. ej. «es,en»).
$mailwayDicts = array_values(array_filter(array_map(
    'trim',
    explode(',', $mailwayEnv('ROUNDCUBEMAIL_ASPELL_DICTS'))
)));
if ($mailwayDicts) {
    $mailwayNombres = [
        'es' => 'Español',
        'ca' => 'Català',
        'gl' => 'Galego',
        'eu' => 'Euskara',
        'en' => 'English',
        'fr' => 'Français',
        'pt' => 'Português',
        'de' => 'Deutsch',
        'it' => 'Italiano',
    ];
    $config['enable_spellcheck'] = true;
    $config['spellcheck_engine'] = 'pspell';
    $config['spellcheck_languages'] = [];
    foreach ($mailwayDicts as $mailwayCodigo) {
        $config['spellcheck_languages'][$mailwayCodigo] = $mailwayNombres[$mailwayCodigo] ?? $mailwayCodigo;
    }
    unset($mailwayNombres, $mailwayCodigo);
} else {
    $config['enable_spellcheck'] = false;
}

/* -------------------------- Cambio de contraseña ---------------------------- */

// El complemento «password» pide el cambio al panel de Mailway, que lo
// aplica en el motor conservando las contraseñas de aplicación del buzón.
// Sin token o sin dirección del panel, el complemento se retira: mejor sin
// pestaña de contraseña que con una que siempre falla.
$mailwayToken = $mailwayEnv('MAILWAY_WEBMAIL_TOKEN');
$mailwayPanelInterno = rtrim($mailwayEnv('MAILWAY_PANEL_INTERNAL_URL'), '/');
if ($mailwayToken !== '' && $mailwayPanelInterno !== '') {
    $config['password_driver'] = 'httpapi';
    $config['password_httpapi_url'] = $mailwayPanelInterno . '/api/webmail/password';
    $config['password_httpapi_method'] = 'POST';
    $config['password_httpapi_var_user'] = 'user';
    $config['password_httpapi_var_curpass'] = 'curpass';
    $config['password_httpapi_var_newpass'] = 'newpass';
    $config['password_httpapi_expect'] = '/^ok$/';
    // Sin «http_errors», el cliente HTTP convierte cualquier respuesta 4xx en
    // una excepción y el usuario vería «error de conexión» aunque el panel
    // haya contestado (p. ej. contraseña actual incorrecta o demasiados
    // intentos). Así el complemento distingue el rechazo de la caída.
    $config['password_http_client'] = [
        'timeout' => 10,
        'connect_timeout' => 5,
        'http_errors' => false,
        'headers' => ['X-Mailway-Token' => $mailwayToken],
    ];
    $config['password_confirm_current'] = true;
    $config['password_minimum_length'] = 10;
    $config['password_log'] = false;
} else {
    $config['plugins'] = array_values(array_diff((array) ($config['plugins'] ?? []), ['password']));
}

unset($mailwayEnv, $mailwayPanelUrl, $mailwayTlsInterno, $mailwayDicts, $mailwayToken, $mailwayPanelInterno);
