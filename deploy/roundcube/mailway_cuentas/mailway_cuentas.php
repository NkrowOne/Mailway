<?php

/*
 * mailway_cuentas: el webmail durante un cambio de dominio de Mailway.
 *
 * Cuando un cliente pasa de @dominio.es a @dominio2.es, el motor sigue
 * conociendo cada buzón por su usuario anterior (ana@dominio.es) hasta que su
 * titular pulsa «Actualizar mis dispositivos». Este complemento hace que el
 * webmail funcione igual se teclee lo que se teclee y que no se pierda nada:
 *
 * - authenticate: pregunta al panel (POST /api/webmail/cuenta, con el secreto
 *   compartido X-Mailway-Token, el mismo canal que el complemento password)
 *   qué usuario corresponde a lo tecleado —la dirección vieja, la nueva o el
 *   usuario—, entra con ese y, si el buzón ya cambió de usuario, le traslada la
 *   fila de users del usuario anterior: los contactos, las identidades, las
 *   respuestas y las preferencias van con ella. Nunca se borra nada: si ya
 *   había una fila con el usuario vigente, se aparta renombrándola.
 * - login_after: pasa la identidad que aún tiene la dirección anterior a la
 *   vigente, conservando nombre, firma y respuestas.
 *
 * El traslado ocurre antes de comprobar la contraseña: solo se produce cuando
 * el panel dice que el usuario vigente de ese buzón es otro, lleva al mismo
 * estado que la siguiente entrada legítima y no borra datos, así que quien no
 * conoce la contraseña solo puede adelantarlo. Ver docs/SEGURIDAD.md.
 *
 * Sin MAILWAY_PANEL_INTERNAL_URL o sin MAILWAY_WEBMAIL_TOKEN no registra nada,
 * y si el panel no responde (2 s como mucho) se entra como siempre: el
 * webmail nunca depende del panel para funcionar.
 */

require_once __DIR__ . '/datos.php';

class mailway_cuentas extends rcube_plugin
{
    // authenticate y login_after solo existen al entrar.
    public $task = 'login';

    private string $panel = '';
    private string $token = '';
    /** @var array{login: string, email: string, anteriores: string[], otrasDirecciones: string[]}|null */
    private ?array $datos = null;

    public function init()
    {
        $panel = rtrim(trim((string) getenv('MAILWAY_PANEL_INTERNAL_URL')), '/');
        $token = trim((string) getenv('MAILWAY_WEBMAIL_TOKEN'));
        if ($panel === '' || $token === '') {
            return;
        }
        $this->panel = $panel;
        $this->token = $token;
        $this->add_hook('authenticate', [$this, 'authenticate']);
        $this->add_hook('login_after', [$this, 'login_after']);
    }

    /**
     * Traduce lo tecleado al usuario vigente y traslada la fila del anterior.
     */
    public function authenticate($args)
    {
        // Sin el token del formulario (o abortada por otro complemento) no se
        // va a entrar: no hace falta preguntar nada al panel.
        if (empty($args['valid']) || !empty($args['abort'])) {
            return $args;
        }
        $usuario = mb_strtolower(trim((string) ($args['user'] ?? '')));
        if ($usuario === '' || strpos($usuario, '@') === false) {
            return $args;
        }
        $datos = $this->consultar($usuario);
        if ($datos === null) {
            return $args;
        }

        $rcube = rcube::get_instance();
        if ($datos['anteriores']) {
            $host = mailway_cuentas_datos::hostDeAlmacen(
                $args['host'] ?? null,
                $rcube->config->get('imap_host', 'localhost:143'),
            );
            try {
                mailway_cuentas_datos::trasladarFila($rcube->get_dbh(), $host, $datos['login'], $datos['anteriores']);
            } catch (Throwable $e) {
                // Se entra igual (con una fila nueva); la anterior sigue intacta
                // y se trasladará en la próxima entrada.
                self::registrarError('No se ha podido trasladar la fila del usuario anterior: ' . $e->getMessage());
            }
        }

        $this->datos = $datos;
        $args['user'] = $datos['login'];

        return $args;
    }

    /**
     * Identidad predeterminada con la dirección vigente.
     */
    public function login_after($args)
    {
        $datos = $this->datos;
        $this->datos = null;
        $user = rcube::get_instance()->user;
        if ($datos !== null && $user instanceof rcube_user && $user->ID) {
            try {
                mailway_cuentas_datos::actualizarIdentidades($user, $datos['email'], $datos['otrasDirecciones']);
            } catch (Throwable $e) {
                self::registrarError('No se ha podido actualizar la identidad: ' . $e->getMessage());
            }
        }

        return $args;
    }

    /**
     * Datos del buzón según el panel, o null para entrar como siempre (el panel
     * no responde, no conoce lo tecleado o contesta algo que no se entiende).
     */
    private function consultar(string $usuario): ?array
    {
        try {
            // Plazos cortos: el formulario espera, y sin respuesta se entra igual.
            $cliente = rcube::get_instance()->get_http_client([
                'timeout' => 2,
                'connect_timeout' => 1,
                'read_timeout' => 2,
                'http_errors' => false,
            ]);
            $respuesta = $cliente->request('POST', $this->panel . '/api/webmail/cuenta', [
                'headers' => ['X-Mailway-Token' => $this->token, 'Accept' => 'application/json'],
                'json' => ['user' => $usuario],
            ]);
        } catch (Throwable $e) {
            self::registrarError('El panel no responde en ' . $this->panel . ': ' . $e->getMessage());

            return null;
        }

        $estado = $respuesta->getStatusCode();
        if ($estado !== 200) {
            // 404: lo tecleado no es ningún buzón de Mailway (no es un error).
            // 409: el usuario del buzón se está cambiando y no se sabe cuál es
            // el vigente; se entra con lo tecleado.
            if ($estado !== 404) {
                self::registrarError("El panel ha respondido {$estado} a la consulta de la cuenta" . match ($estado) {
                    401 => ': revisa MAILWAY_WEBMAIL_TOKEN.',
                    409 => ': se está actualizando el usuario del buzón y se entra con lo tecleado.',
                    default => '.',
                });
            }

            return null;
        }
        $datos = mailway_cuentas_datos::validarRespuesta(json_decode((string) $respuesta->getBody(), true));
        if ($datos === null) {
            self::registrarError('La respuesta del panel a la consulta de la cuenta no es válida.');
        }

        return $datos;
    }

    /** Al registro de errores de Roundcube, sin direcciones ni secretos. */
    private static function registrarError(string $mensaje): void
    {
        rcube::raise_error(['code' => 500, 'message' => 'mailway_cuentas: ' . $mensaje], true, false);
    }
}
