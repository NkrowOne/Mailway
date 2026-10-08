<?php

/**
 * Sesión del webmail cuando la contraseña del buzón cambia por fuera.
 *
 * Roundcube guarda la contraseña en la sesión y vuelve a entrar en IMAP en
 * cada petición. Si mientras tanto la contraseña cambia (el titular la
 * restablece en el panel, la administración «reinicia la configuración»…),
 * cada refresco falla con un error de conexión confuso y el usuario no
 * vuelve a la pantalla de acceso. Este complemento detecta ese caso concreto
 * (IMAP rechaza las credenciales con una sesión ya iniciada), cierra la sesión
 * y lleva al acceso con un aviso claro, igual que Roundcube hace con una
 * sesión caducada, también en las peticiones AJAX.
 *
 * No depende del panel. No cambia el acceso normal: un intento fallido en la
 * pantalla de acceso sigue mostrando el mensaje de siempre. Y un fallo de red
 * o de TLS (IMAP caído) no cierra la sesión: no es un problema de credenciales
 * y basta con reintentar.
 */
class mailway_sesion extends rcube_plugin
{
    /** Parámetro de la pantalla de acceso que pide mostrar el aviso. */
    private const AVISO = '_mwclave';

    /**
     * Códigos de respuesta (RFC 5530) con los que el servidor dice que estas
     * credenciales ya no valen. Otros, como UNAVAILABLE (fallo temporal del
     * servidor) o LIMIT, no deben echar a nadie.
     */
    private const CODIGOS_CREDENCIALES = ['AUTHENTICATIONFAILED', 'AUTHORIZATIONFAILED', 'EXPIRED'];

    public function init()
    {
        $this->add_hook('storage_connect', [$this, 'storage_connect']);
        $this->add_hook('unauthenticated', [$this, 'unauthenticated']);
        $this->add_hook('login_after', [$this, 'login_after']);
    }

    /**
     * Antes de cada intento de conexión IMAP.
     *
     * Roundcube no avisa a los complementos cuando la conexión falla, pero
     * vuelve a llamar a este hook si en el primer intento se pide «retry».
     * Se aprovecha eso: en el primer intento se pide un segundo turno, que
     * solo llega si la conexión ha fallado; en él se mira por qué y, si no son
     * las credenciales, se renuncia al reintento (retry = false) y la petición
     * sigue exactamente como sin el complemento.
     */
    public function storage_connect($args)
    {
        $rcmail = rcmail::get_instance();

        // Solo con una sesión ya iniciada. En el acceso (y al salir) se deja
        // todo como está.
        if (empty($_SESSION['user_id']) || in_array($rcmail->task, ['login', 'logout'], true)) {
            return $args;
        }

        $intento = (int) ($args['attempt'] ?? 1);

        if ($intento === 1) {
            $args['retry'] = true;

            return $args;
        }

        if ($intento === 2 && $this->credenciales_rechazadas($rcmail)) {
            $this->cerrar_sesion($rcmail);
        }

        $args['retry'] = false;

        return $args;
    }

    /** Pantalla de acceso: el aviso, si se llega desde un cierre por contraseña. */
    public function unauthenticated($args)
    {
        if (rcube_utils::get_input_string(self::AVISO, rcube_utils::INPUT_GET) === '1') {
            $this->add_texts('localization/');
            rcmail::get_instance()->output->show_message($this->gettext('clave_cambiada'), 'warning', null, true, -1);
        }

        return $args;
    }

    /**
     * Tras volver a entrar: la pantalla de acceso recuerda su dirección (con
     * el parámetro del aviso) para redirigir después; se quita para que no
     * quede en la dirección del correo.
     */
    public function login_after($args)
    {
        unset($args[self::AVISO]);

        return $args;
    }

    /**
     * Cierto si el último intento falló porque IMAP no aceptó el usuario y la
     * contraseña: respuesta NO (no BAD ni BYE, que son de conexión, TLS o
     * servidor) sin código o con uno de credenciales. También cubre una
     * contraseña de sesión que ya no se puede descifrar («Empty password»).
     */
    private function credenciales_rechazadas(rcmail $rcmail): bool
    {
        $conexion = $rcmail->get_storage()->conn ?? null;

        if (!($conexion instanceof rcube_imap_generic) || $conexion->errornum !== rcube_imap_generic::ERROR_NO) {
            return false;
        }

        $codigo = strtoupper((string) $conexion->resultcode);

        return $codigo === '' || in_array($codigo, self::CODIGOS_CREDENCIALES, true);
    }

    /**
     * Cierra la sesión y lleva a la pantalla de acceso. Mismo camino que
     * Roundcube con una sesión caducada (index.php): en AJAX o en un marco se
     * ordena al navegador ir al acceso; en una página normal, redirección.
     * No vuelve.
     */
    private function cerrar_sesion(rcmail $rcmail): void
    {
        $usuario = (string) ($_SESSION['username'] ?? '');
        rcube::raise_error([
            'code' => 401,
            'type' => 'imap',
            'message' => "mailway_sesion: IMAP rechaza la contraseña guardada de {$usuario}; se cierra la sesión",
        ], true, false);

        $this->add_texts('localization/');
        $aviso = $this->gettext('clave_cambiada');

        $rcmail->kill_session();

        if ($rcmail->output->ajax_call || $rcmail->output->get_env('framed')) {
            $rcmail->output->show_message($aviso, 'warning');
            $rcmail->output->command('session_error', $rcmail->url(['_task' => 'login', self::AVISO => 1]));
            $rcmail->output->send('iframe');
            exit;
        }

        $rcmail->output->redirect(['_task' => 'login', self::AVISO => 1]);
    }
}
