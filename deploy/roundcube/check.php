<?php
// CLI only. Uses Roundcube's effective configuration and its IMAP implementation.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require '/var/www/html/program/include/iniset.php';
$config = new rcube_config();
$host = $config->get('imap_host');
if (!is_string($host) || !str_starts_with($host, 'ssl://')) {
    fwrite(STDERR, "FALLO: se espera un único imap_host con ssl:// en la configuración efectiva.\n");
    exit(1);
}
$parts = parse_url($host);
$hostname = $parts['host'] ?? '';
$port = $parts['port'] ?? 993;
$context = stream_context_create(['ssl' => [
    'verify_peer' => true, 'verify_peer_name' => true, 'allow_self_signed' => false,
    'peer_name' => $hostname,
]]);
$socket = @stream_socket_client("ssl://{$hostname}:{$port}", $code, $message, 10, STREAM_CLIENT_CONNECT, $context);
if (!$socket) {
    fwrite(STDERR, "FALLO: Roundcube no puede abrir IMAP con certificado válido. Revisa DNS interno, TLS y logs.\n");
    exit(1);
}
fclose($socket);
echo "OK: conexión IMAP con TLS válido desde Roundcube ({$hostname}:{$port}).\n";
$interactive = ($argv[1] ?? '') === '--login';
$fromPipe = ($argv[1] ?? '') === '--login-stdin';
if ($fromPipe && stream_isatty(STDIN)) { fwrite(STDERR, "Usa --login para una terminal.\n"); exit(1); }
if (!$interactive && !$fromPipe) {
    echo "El login aún no está acreditado. Ejecuta ./mailway.sh login y comprueba también el navegador.\n";
    exit(0);
}
if ($interactive) fwrite(STDOUT, 'Buzón completo: ');
$user = trim(fgets(STDIN));
if ($interactive) fwrite(STDOUT, 'Contraseña (oculta): ');
// Do not accept a password as an argument or store it in the environment.
if ($interactive && function_exists('system')) {
    system('stty -echo', $status);
    if ($status !== 0) { fwrite(STDERR, "No hay terminal seguro. Usa un terminal interactivo.\n"); exit(1); }
} elseif ($interactive) { exit(1); }
try { $password = rtrim(fgets(STDIN), "\r\n"); }
finally { if ($interactive) { system('stty echo'); echo "\n"; } }
$imap = new rcube_imap_generic();
$options = ['port' => $port, 'ssl_mode' => 'ssl', 'timeout' => 15,
    'socket_options' => ['ssl' => ['verify_peer' => true, 'verify_peer_name' => true,
        'allow_self_signed' => false, 'peer_name' => $hostname]]];
$ok = $imap->connect($hostname, $user, $password, $options);
$password = '';
if (!$ok) { fwrite(STDERR, "FALLO: autenticación IMAP rechazada. Revisa el buzón y los logs de Stalwart.\n"); exit(1); }
if (!$imap->select('INBOX')) { $imap->closeConnection(); fwrite(STDERR, "FALLO: no se pudo abrir INBOX.\n"); exit(1); }
$imap->closeConnection();
echo 'OK: ' . gmdate('c') . " — login IMAP y apertura de INBOX mediante la biblioteca de Roundcube.\n";
echo "Comprueba también la sesión web, el envío SMTP y la entrega externa.\n";
