<?php

/**
 * Perfil del buzón desde el panel de Mailway: nombre visible y foto.
 *
 * El titular pone su nombre y su foto en el panel (enlace de configuración o
 * «Mi buzón»). Sin este complemento, Roundcube crearía la identidad sin
 * nombre (rcube_user::create deja el nombre vacío cuando el usuario es la
 * propia dirección) y los correos saldrían solo con la dirección.
 *
 * - Alta (user_create): la identidad nace con el nombre del panel.
 * - Cada acceso (login_after): se trae el nombre del panel sin pisar lo que el
 *   usuario haya cambiado en Roundcube (ver sincronizar_nombre()).
 * - Avatares (contact_photo): si las libretas no tienen foto de un remitente,
 *   se pide al panel, que solo la da si es un buzón del mismo cliente.
 *
 * El panel se consulta por la red interna con el token del webmail
 * (X-Mailway-Token), igual que el cambio de contraseña. Cualquier fallo del
 * panel es silencioso: nunca impide entrar ni leer un mensaje.
 */
class mailway_perfil extends rcube_plugin
{
    /** Preferencia con el último nombre que este complemento puso en la identidad. */
    private const PREF_NOMBRE = 'mailway_nombre';

    /** Las fotos (y su ausencia) se recuerdan unos minutos por usuario. */
    private const CACHE_FOTOS = '5m';

    /** El panel acepta fotos de hasta 512 KB; algo de margen y nada más. */
    private const MAX_BYTES = 600 * 1024;

    /** @var array|false|null Perfil pedido en esta petición (false: no disponible). */
    private $perfil;

    /** @var string|null Usuario del perfil anterior. */
    private $perfil_usuario;

    public function init()
    {
        $rcmail = rcmail::get_instance();

        // Sin dirección del panel o sin token no hay a quién preguntar
        // (mailway.php además retira el complemento en ese caso).
        if (!$this->url_panel() || !$rcmail->config->get('mailway_perfil_token')) {
            return;
        }

        $this->add_hook('user_create', [$this, 'user_create']);
        $this->add_hook('login_after', [$this, 'login_after']);
        $this->add_hook('contact_photo', [$this, 'contact_photo']);

        $this->foto_propia($rcmail);
    }

    /**
     * Alta del usuario en Roundcube (primer acceso): la identidad se crea
     * con el nombre del panel, y se anota como último nombre sincronizado.
     */
    public function user_create($args)
    {
        $perfil = $this->perfil((string) $args['user']);

        if ($perfil) {
            if ($perfil['name'] !== '') {
                $args['user_name'] = $perfil['name'];
            }
            $args['preferences'][self::PREF_NOMBRE] = $perfil['name'];
        }

        return $args;
    }

    /**
     * Tras iniciar sesión: nombre al día y aviso de si hay foto propia. Se
     * devuelven los argumentos tal cual (son la redirección tras entrar).
     */
    public function login_after($args)
    {
        $rcmail = rcmail::get_instance();
        $user = $rcmail->user;

        if (empty($user) || empty($user->ID)) {
            return $args;
        }

        $usuario = (string) $user->get_username();
        $perfil = $this->perfil($usuario);

        if (!$perfil) {
            return $args;
        }

        // Marca de tiempo como versión: la URL de la foto propia cambia en
        // cada acceso y el navegador no sigue mostrando una foto antigua.
        $_SESSION['mailway_perfil_foto'] = $perfil['photo'] ? time() : 0;

        try {
            $this->sincronizar_nombre($user, $usuario, $perfil['name']);
        } catch (\Throwable $e) {
            rcube::raise_error('mailway_perfil: no se pudo actualizar la identidad: ' . $e->getMessage(), true, false);
        }

        return $args;
    }

    /**
     * Avatar de un remitente o de un contacto sin foto en las libretas.
     *
     * Lo llama photo.php (con «email», al mostrar un mensaje) e index.php
     * (con el registro, al ver un contacto).
     */
    public function contact_photo($args)
    {
        if (!empty($args['data']) || !empty($args['url'])) {
            return $args;
        }

        $rcmail = rcmail::get_instance();

        if (empty($rcmail->user) || empty($rcmail->user->ID)) {
            return $args;
        }

        if (!empty($args['email'])) {
            if ($foto = $this->foto((string) $args['email'])) {
                $args['data'] = $foto;
            }

            return $args;
        }

        // Ficha de un contacto (solo al verla: en el formulario de edición la
        // foto del panel taparía la que el usuario quiera subir o quitar).
        $registro = $args['record'] ?? null;
        if ($rcmail->action === 'show' && is_array($registro) && empty($registro['photo'])
            && (empty($registro['_type']) || $registro['_type'] === 'contact')
        ) {
            $direcciones = rcube_addressbook::get_col_values('email', $registro, true);
            $email = $direcciones ? (string) reset($direcciones) : '';

            if ($email !== '' && $this->foto($email)) {
                // La propia acción «photo» la servirá desde la caché.
                $args['url'] = $rcmail->url(['_task' => 'addressbook', '_action' => 'photo', '_email' => $email]);
            }
        }

        return $args;
    }

    /**
     * Pone en la identidad principal el nombre del panel, salvo que el usuario
     * lo haya cambiado en Roundcube.
     *
     * Se actualiza solo si el nombre está vacío o sigue siendo el último que
     * puso este complemento (preferencia mailway_nombre). Así un cambio en
     * «Mi buzón» llega al webmail en el siguiente acceso y uno hecho en los
     * ajustes de Roundcube se respeta.
     */
    private function sincronizar_nombre(rcube_user $user, string $usuario, string $nombre): void
    {
        $identidad = $this->identidad_principal($user, $usuario);
        if (!$identidad) {
            return;
        }

        $prefs = (array) $user->get_prefs();
        $ultimo = array_key_exists(self::PREF_NOMBRE, $prefs) ? (string) $prefs[self::PREF_NOMBRE] : null;
        $actual = (string) $identidad['name'];

        if ($actual === $nombre) {
            // Ya coinciden (p. ej. el usuario escribió lo mismo): se anota para
            // que los próximos cambios del panel sigan llegando.
            if ($ultimo !== $nombre) {
                $user->save_prefs([self::PREF_NOMBRE => $nombre]);
            }

            return;
        }

        if ($actual !== '' && $actual !== $ultimo) {
            return;
        }

        $user->update_identity($identidad['identity_id'], ['name' => $nombre]);
        $user->save_prefs([self::PREF_NOMBRE => $nombre]);
    }

    /**
     * Identidad de la dirección del buzón, preferentemente la predeterminada.
     * Las de otras direcciones (alias) no se tocan.
     */
    private function identidad_principal(rcube_user $user, string $usuario): ?array
    {
        $buzon = $this->normalizar_email($usuario);

        // list_identities() ya ordena con la predeterminada primero.
        foreach ($user->list_identities() as $identidad) {
            if ($this->normalizar_email((string) $identidad['email']) === $buzon) {
                return $identidad;
            }
        }

        return null;
    }

    /**
     * Perfil del buzón en el panel: ['name' => string, 'photo' => bool], o
     * null si no se pudo obtener. El alta y el acceso ocurren en la misma
     * petición: se pregunta una sola vez.
     */
    private function perfil(string $usuario): ?array
    {
        if ($this->perfil !== null && $this->perfil_usuario === $usuario) {
            return $this->perfil ?: null;
        }

        $this->perfil_usuario = $usuario;
        $this->perfil = false;

        $respuesta = $this->pedir('profile', ['user' => $usuario]);
        if (!$respuesta || $respuesta['codigo'] !== 200) {
            return null;
        }

        $datos = json_decode($respuesta['cuerpo'], true);
        if (!is_array($datos) || !isset($datos['name']) || !is_string($datos['name'])) {
            rcube::raise_error('mailway_perfil: respuesta del perfil no válida', true, false);

            return null;
        }

        $this->perfil = [
            'name' => $this->limpiar_nombre($datos['name']),
            'photo' => !empty($datos['photo']),
        ];

        return $this->perfil;
    }

    /**
     * Bytes de la foto de una dirección, o null. El panel solo la da si es un
     * buzón del mismo cliente que el usuario con la sesión abierta.
     */
    private function foto(string $email): ?string
    {
        $email = $this->normalizar_email($email);
        if ($email === '' || !rcube_utils::check_email($email, false)) {
            return null;
        }

        $rcmail = rcmail::get_instance();
        $usuario = (string) $rcmail->user->get_username();
        $clave = 'foto.' . md5($usuario . "\n" . $email);

        // Caché por usuario en la base de datos de Roundcube, también de las
        // respuestas negativas: un mensaje no debe costar una consulta al
        // panel cada vez que se abre. En la sesión no, porque las imágenes la
        // engordarían y se lee en cada petición.
        $cache = $rcmail->get_cache('mailway_perfil', 'db', self::CACHE_FOTOS);
        if ($cache) {
            $guardado = $cache->get($clave);
            if (is_array($guardado) && array_key_exists('f', $guardado)) {
                return $guardado['f'] === '' ? null : (base64_decode($guardado['f'], true) ?: null);
            }
        }

        $datos = null;
        $respuesta = $this->pedir('photo', ['user' => $usuario, 'email' => $email]);
        if ($respuesta && $respuesta['codigo'] === 200 && $this->es_imagen($respuesta['cuerpo'])) {
            $datos = $respuesta['cuerpo'];
        }

        // También se recuerda un fallo del panel: si está caído, no se le
        // pregunta otra vez por cada avatar durante unos minutos.
        if ($cache) {
            $cache->set($clave, ['f' => $datos === null ? '' : base64_encode($datos)]);
        }

        return $datos;
    }

    /**
     * POST al panel. Devuelve ['codigo' => int, 'cuerpo' => string] o null si
     * no hubo respuesta. Tiempos cortos: el panel está en la red interna y,
     * si no contesta, es mejor seguir sin perfil que hacer esperar al usuario.
     */
    private function pedir(string $ruta, array $campos): ?array
    {
        $rcmail = rcmail::get_instance();
        $url = $this->url_panel() . '/api/webmail/' . $ruta;

        try {
            $cliente = $rcmail->get_http_client([
                'connect_timeout' => 1,
                'timeout' => 2,
                'read_timeout' => 2,
                // Un 404 o un 401 son respuestas, no excepciones.
                'http_errors' => false,
                'allow_redirects' => false,
                'headers' => [
                    'X-Mailway-Token' => (string) $rcmail->config->get('mailway_perfil_token'),
                    'Accept' => 'application/json, image/jpeg, image/png, image/webp',
                ],
            ]);

            $respuesta = $cliente->request('POST', $url, ['json' => $campos, 'stream' => true]);
            $codigo = $respuesta->getStatusCode();

            // Lectura con tope: nada justifica más de una foto de 512 KB.
            $cuerpo = '';
            $flujo = $respuesta->getBody();
            while (!$flujo->eof() && strlen($cuerpo) <= self::MAX_BYTES) {
                $cuerpo .= $flujo->read(65536);
            }
            $flujo->close();

            if (strlen($cuerpo) > self::MAX_BYTES) {
                rcube::raise_error("mailway_perfil: respuesta demasiado grande de {$ruta}", true, false);

                return null;
            }
        } catch (\Throwable $e) {
            rcube::raise_error("mailway_perfil: el panel no responde ({$ruta}): " . $e->getMessage(), true, false);

            return null;
        }

        // 404 es lo normal (buzón sin foto, de otro cliente o inexistente);
        // cualquier otro código indica un problema de configuración (p. ej.
        // 401: el token del webmail no coincide con el del panel).
        if ($codigo !== 200 && $codigo !== 404) {
            rcube::raise_error("mailway_perfil: respuesta {$codigo} del panel ({$ruta})", true, false);
        }

        return ['codigo' => $codigo, 'cuerpo' => $cuerpo];
    }

    /**
     * Variables CSS con la foto del propio usuario, para que la capa visual
     * (mailway_theme) la muestre junto a su dirección. Sin foto, o sin la
     * capa visual, no se ve nada.
     */
    private function foto_propia(rcmail $rcmail): void
    {
        $version = (int) ($_SESSION['mailway_perfil_foto'] ?? 0);

        if (!$version || $rcmail->task !== 'mail' || empty($_SESSION['username'])
            || !($rcmail->output instanceof rcmail_output_html)
        ) {
            return;
        }

        // URL absoluta: en una variable CSS, una relativa se resolvería
        // respecto a la hoja de estilos que la usa, no respecto a la página.
        $url = $rcmail->url([
            '_task' => 'addressbook',
            '_action' => 'photo',
            '_email' => (string) $_SESSION['username'],
            '_error' => 1,
            '_v' => $version,
        ], true);

        $rcmail->output->add_header(html::tag('style', [],
            'html{--mw-foto-propia:url("' . addcslashes($url, "\"\\\n\r") . '");--mw-foto-propia-marca:"";}'
        ));
    }

    private function url_panel(): string
    {
        return rtrim((string) rcmail::get_instance()->config->get('mailway_perfil_url'), '/');
    }

    /** Sin saltos de línea ni caracteres de control (va a la cabecera From). */
    private function limpiar_nombre(string $nombre): string
    {
        $nombre = trim((string) preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $nombre));

        return mb_substr($nombre, 0, 80);
    }

    private function normalizar_email(string $email): string
    {
        $email = strtolower(trim($email));

        return (string) rcube_utils::idn_to_ascii($email);
    }

    /** JPEG, PNG o WebP por la firma de los bytes, como exige el panel al subirlas. */
    private function es_imagen(string $datos): bool
    {
        return strncmp($datos, "\xFF\xD8\xFF", 3) === 0
            || strncmp($datos, "\x89PNG\r\n\x1A\n", 8) === 0
            || (strncmp($datos, 'RIFF', 4) === 0 && substr($datos, 8, 4) === 'WEBP');
    }
}
