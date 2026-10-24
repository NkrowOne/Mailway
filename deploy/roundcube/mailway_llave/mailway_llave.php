<?php

/*
 * mailway_llave: entrar en el webmail con una llave de acceso (passkey).
 *
 * Roundcube no sabe nada de WebAuthn y no tiene por qué: la llave se comprueba
 * en «Mi buzón» del panel, que es quien conoce las llaves del titular. El viaje
 * completo es este:
 *
 * 1. Pantalla de acceso (gancho loginform_content): si el panel dice que este
 *    nombre es un webmail Roundcube de la instancia (GET
 *    /api/webmail/llave/portal?host=…), se añade el botón «Entrar con llave de
 *    acceso» debajo del de entrar. Si el panel no responde o no lo conoce, no
 *    hay botón y el acceso es el de siempre.
 * 2. Acción plugin.mailway_llave_ir: genera un «estado» aleatorio, lo guarda en
 *    la sesión de Roundcube (la previa al acceso) y lleva al navegador a
 *    ${portal}/mi-buzon/correo-web?destino=<host>&estado=<estado>, donde el
 *    titular usa su llave.
 * 3. El panel devuelve al navegador a plugin.mailway_llave con un código de un
 *    solo uso (2 minutos) y el mismo estado. Si el estado coincide con el
 *    guardado, el código se canjea (POST /api/webmail/llave) por el usuario del
 *    motor y una contraseña de aplicación temporal (12 horas como mucho), y se
 *    entra con ellos por el camino normal de Roundcube.
 * 4. Al salir o al cerrarse la sesión (gancho session_destroy) se pide al panel
 *    que retire esa contraseña temporal (POST /api/webmail/llave/salir). Antes
 *    de que caduque, la propia sesión se cierra con un aviso claro.
 *
 * Por qué el estado (contra el «login CSRF»): sin él, cualquiera podría usar SU
 * llave para conseguir un código y mandar el enlace a otra persona, que entraría
 * sin darse cuenta en el buzón de quien se lo mandó (y le escribiría desde él).
 * El estado lo genera este webmail en la sesión de cada navegador y viaja en la
 * URL del panel, así que un código conseguido en otro navegador nunca coincide.
 *
 * Las acciones son GET sin el token de petición de Roundcube porque llegan
 * desde otra web (el panel) por una redirección, como el retorno de OAuth del
 * propio Roundcube. Lo que las protege es lo anterior: el código es de un solo
 * uso, lo genera el panel tras comprobar la llave y solo vale con el estado que
 * guardó esta sesión.
 *
 * Cómo se entra: igual que el acceso con OAuth de Roundcube 1.7
 * (rcmail_oauth::startup y program/actions/login/oauth.php). En el gancho
 * startup, la acción pasa a ser «login» y el index.php de Roundcube hace lo de
 * siempre: purga la sesión previa (kill_session), ejecuta authenticate (aquí se
 * ponen el usuario y la contraseña temporal, antes que mailway_cuentas, que
 * traduce el usuario durante un cambio de dominio), rcmail::login contra el
 * mismo IMAP del formulario, regenera el id de sesión, envía la cookie de
 * autenticación, anota el acceso (log_login), ejecuta login_after (aquí se
 * guarda el id de la sesión del panel) y redirige al correo. Por eso
 * mailway_cuentas, mailway_perfil y mailway_sesion funcionan igual que con
 * contraseña.
 *
 * Sin MAILWAY_PANEL_INTERNAL_URL o sin MAILWAY_WEBMAIL_TOKEN no registra nada:
 * sin panel no hay a quién preguntar y el webmail funciona como siempre.
 */
class mailway_llave extends rcube_plugin
{
    /** Acción del botón: genera el estado y lleva al panel. */
    public const ACCION_IR = 'plugin.mailway_llave_ir';

    /** Acción de vuelta desde el panel, con el código y el estado. */
    public const ACCION = 'plugin.mailway_llave';

    /** Parámetro de la pantalla de acceso que pide un aviso de este complemento. */
    public const AVISO = '_mwllave';

    /** Avisos que se pueden pedir por la URL (lista cerrada: nada de texto libre). */
    public const AVISOS = ['enlace', 'fallo', 'portal', 'caducada'];

    /** Parámetro con el que mailway_sesion pide su aviso de contraseña cambiada. */
    public const AVISO_SESION = '_mwclave';

    /** Clave de la sesión con el viaje al panel en curso (estado, hora y zona horaria). */
    public const SESION_IDA = 'mailway_llave_ida';

    /** Clave de la sesión iniciada con llave: id de la sesión del panel y caducidad. */
    public const SESION = 'mailway_llave';

    /**
     * Cookie breve que recuerda, tras cerrarse la sesión, que se había entrado
     * con llave (la sesión ya no existe para contarlo). Solo sirve para elegir
     * el aviso de la pantalla de acceso.
     */
    public const COOKIE_FIN = 'mailway_llave_fin';

    /** Minutos que vale un estado: de sobra para usar la llave en el panel. */
    private const VIDA_IDA = 15 * 60;

    /**
     * La sesión se cierra un minuto antes de que caduque la contraseña
     * temporal: así nunca se llega a pedir algo al IMAP con una contraseña que
     * ya no vale (y mailway_sesion no tiene que intervenir).
     */
    private const MARGEN_MS = 60 * 1000;

    /** El panel da contraseñas temporales de 12 horas como mucho. */
    private const MAX_SESION_MS = 12 * 3600 * 1000;

    /** Cuánto se recuerda la respuesta del panel para cada nombre. */
    private const CACHE_PORTAL = 300;

    /** Si el panel falla, se le vuelve a preguntar antes. */
    private const CACHE_FALLO = 60;

    private string $panel = '';
    private string $token = '';

    /** @var array<string, string|null> Portal por nombre en esta petición. */
    private array $portales = [];

    /** @var array{usuario: string, contrasena: string, sesion: string, expira: int}|null Entrada en curso. */
    private ?array $entrada = null;

    public function init()
    {
        $panel = rtrim(trim((string) getenv('MAILWAY_PANEL_INTERNAL_URL')), '/');
        $token = trim((string) getenv('MAILWAY_WEBMAIL_TOKEN'));
        if ($panel === '' || $token === '') {
            return;
        }
        $this->panel = $panel;
        $this->token = $token;

        $this->add_hook('startup', [$this, 'startup']);
        $this->add_hook('loginform_content', [$this, 'loginform_content']);
        $this->add_hook('authenticate', [$this, 'authenticate']);
        $this->add_hook('login_after', [$this, 'login_after']);
        $this->add_hook('login_failed', [$this, 'login_failed']);
        $this->add_hook('session_destroy', [$this, 'session_destroy']);
        $this->add_hook('unauthenticated', [$this, 'unauthenticated']);
    }

    /* -------------------------------- Ganchos -------------------------------- */

    /**
     * Las dos acciones del complemento y la caducidad de la sesión con llave.
     *
     * Van aquí y no con register_action porque, sin sesión iniciada, Roundcube
     * muestra la pantalla de acceso sin llegar a ejecutar ninguna acción
     * (index.php): startup es el único punto en el que un complemento puede
     * atender una petición de la tarea «login», como hace OAuth.
     */
    public function startup($args)
    {
        $rcmail = rcmail::get_instance();
        $tarea = (string) ($args['task'] ?? '');
        $accion = (string) ($args['action'] ?? '');

        if ($tarea === 'login' && $accion === self::ACCION_IR) {
            $this->ir($rcmail);
        }
        if ($tarea === 'login' && $accion === self::ACCION) {
            return $this->volver($rcmail, $args);
        }

        $this->vigilarCaducidad($rcmail, $tarea);

        return $args;
    }

    /** Botón «Entrar con llave de acceso» debajo del de entrar, si el panel lo admite. */
    public function loginform_content($contenido)
    {
        $host = self::hostActual();
        if ($host === null || $this->portal($host) === null) {
            return $contenido;
        }

        $this->add_texts('localization/');
        $this->include_stylesheet('mailway_llave.css');
        // Añade la zona horaria al enlace (ver mailway_llave.js).
        $this->include_script('mailway_llave.js');

        $rcmail = rcmail::get_instance();
        $enlace = html::a(
            [
                'href' => $rcmail->url(['_task' => 'login', '_action' => self::ACCION_IR]),
                'id' => 'mailway-llave',
                // Las clases que Elastic da al botón de OAuth: el mismo aspecto
                // de botón secundario, en claro y en oscuro, también sin
                // mailway_theme.
                'class' => 'btn btn-secondary btn-lg w-100 mailway-llave',
            ],
            html::span(['class' => 'mailway-llave-icono', 'aria-hidden' => 'true'], '')
                . html::quote($this->gettext('boton'))
        );
        $contenido['buttons']['mailway_llave'] = ['outterclass' => 'mailway-llave', 'content' => $enlace];

        return $contenido;
    }

    /**
     * Usuario y contraseña temporal de la entrada con llave.
     *
     * Tiene que ejecutarse antes que el de mailway_cuentas (va antes en la
     * lista de complementos): así este traduce el usuario del motor al vigente
     * durante un cambio de dominio y traslada la fila, como con contraseña.
     */
    public function authenticate($args)
    {
        if ($this->entrada !== null) {
            $args['user'] = $this->entrada['usuario'];
            $args['pass'] = $this->entrada['contrasena'];
        }

        return $args;
    }

    /**
     * Ya dentro (la sesión nueva, con el id regenerado): se guarda lo necesario
     * para retirar la contraseña temporal al salir y para cerrar la sesión antes
     * de que caduque. El aviso de la pantalla de acceso no pasa al correo.
     */
    public function login_after($args)
    {
        unset($args[self::AVISO]);
        if ($this->entrada !== null) {
            $_SESSION[self::SESION] = ['sesion' => $this->entrada['sesion'], 'expira' => $this->entrada['expira']];
            $this->entrada = null;
            self::borrarCookieFin();
        }

        return $args;
    }

    /**
     * El IMAP no ha aceptado la contraseña temporal recién dada (o Roundcube ha
     * rechazado la entrada por otro motivo). Se retira y se vuelve al acceso con
     * un aviso de esta entrada, no con «Error de inicio de sesión».
     */
    public function login_failed($args)
    {
        if ($this->entrada === null) {
            return $args;
        }
        $entrada = $this->entrada;
        $this->entrada = null;
        self::registrarError('Roundcube no ha podido entrar con la contraseña temporal (código ' . ($args['code'] ?? '?') . ').');
        $this->salir($entrada['sesion']);
        $this->volverAlAcceso(rcmail::get_instance(), 'fallo');
    }

    /**
     * La sesión se cierra (salir, caducidad, mailway_sesion o un acceso nuevo
     * encima): se retira la contraseña temporal sin esperar a que caduque.
     *
     * Si se cierra con el correo abierto (no al salir ni al entrar), se deja la
     * cookie que permite a la pantalla de acceso explicar que era una sesión
     * con llave (ver unauthenticated()).
     */
    public function session_destroy($args)
    {
        $llave = $_SESSION[self::SESION] ?? null;
        if (!is_array($llave) || !is_string($llave['sesion'] ?? null) || $llave['sesion'] === '') {
            return $args;
        }
        $this->salir($llave['sesion']);
        if (!in_array(rcmail::get_instance()->task, ['login', 'logout'], true)) {
            rcube_utils::setcookie(self::COOKIE_FIN, '1', time() + 300);
        }

        return $args;
    }

    /**
     * Pantalla de acceso: el aviso que corresponda.
     *
     * Si mailway_sesion cerró una sesión iniciada con llave porque el IMAP dejó
     * de aceptar la contraseña temporal (el panel la retira al borrar la llave,
     * al cambiar la contraseña del buzón o al abrirse demasiadas sesiones), su
     * aviso hablaría de una contraseña que el titular nunca escribió. Este gancho va antes que el suyo (orden de la lista de
     * complementos): quita su parámetro para que no lo muestre y pone el
     * propio. Sin la cookie (una sesión con contraseña), no se toca nada.
     */
    public function unauthenticated($args)
    {
        $aviso = (string) rcube_utils::get_input_string(self::AVISO, rcube_utils::INPUT_GET);
        $conLlave = !empty($_COOKIE[self::COOKIE_FIN]);
        if ($conLlave) {
            self::borrarCookieFin();
        }

        $etiqueta = null;
        if (in_array($aviso, self::AVISOS, true)) {
            $etiqueta = $aviso;
        } elseif ($conLlave && rcube_utils::get_input_string(self::AVISO_SESION, rcube_utils::INPUT_GET) === '1') {
            unset($_GET[self::AVISO_SESION]);
            $etiqueta = 'terminada';
        }

        if ($etiqueta !== null) {
            $this->add_texts('localization/');
            rcmail::get_instance()->output->show_message($this->gettext($etiqueta), 'warning', null, true, -1);
        }

        return $args;
    }

    /* -------------------------------- Acciones ------------------------------- */

    /**
     * plugin.mailway_llave_ir: estado nuevo en la sesión y al panel. No vuelve.
     *
     * La sesión previa al acceso es la que Roundcube abre en la pantalla de
     * acceso (cookie roundcube_sessid, con «temp»); sigue ahí a la vuelta
     * porque es el mismo navegador.
     */
    private function ir(rcmail $rcmail): never
    {
        if (!empty($_SESSION['user_id'])) {
            $rcmail->output->redirect(['_task' => 'mail']);
        }
        $host = self::hostActual();
        $portal = $host !== null ? $this->portal($host) : null;
        if ($host === null || $portal === null) {
            $this->volverAlAcceso($rcmail, 'portal');
        }

        $estado = self::nuevoEstado();
        // La zona horaria del navegador (la pone mailway_llave.js en el enlace):
        // el formulario de acceso la manda en _timezone y, sin ella, el webmail
        // mostraría las horas en la del servidor.
        $zona = (string) rcube_utils::get_input_string('_timezone', rcube_utils::INPUT_GET);
        $_SESSION[self::SESION_IDA] = [
            'estado' => $estado,
            'hora' => time(),
            'zona' => self::zonaValida($zona) ? $zona : '',
        ];

        $rcmail->output->redirect($portal . '/mi-buzon/correo-web?' . http_build_query(
            ['destino' => $host, 'estado' => $estado],
            '',
            '&',
            \PHP_QUERY_RFC3986
        ));
        exit;
    }

    /**
     * plugin.mailway_llave: comprueba el estado, canjea el código y deja que
     * Roundcube entre (acción «login»). Ante cualquier fallo vuelve al acceso
     * con un aviso.
     */
    private function volver(rcmail $rcmail, array $args): array
    {
        // Con una sesión ya iniciada no se cambia de buzón por un enlace: se
        // sigue en el correo (y el código, sin canjear, caduca solo).
        if (!empty($_SESSION['user_id'])) {
            $rcmail->output->redirect(['_task' => 'mail']);
        }

        // El estado vale una sola vez, coincida o no. remove() y no unset():
        // Roundcube mezcla lo que hay en la sesión con lo guardado y solo
        // olvida de verdad lo que se quita con remove().
        $ida = $_SESSION[self::SESION_IDA] ?? null;
        $rcmail->session->remove(self::SESION_IDA);

        $codigo = (string) rcube_utils::get_input_string('_codigo', rcube_utils::INPUT_GET);
        $estado = (string) rcube_utils::get_input_string('_estado', rcube_utils::INPUT_GET);
        if (!self::codigoValido($codigo) || !self::estadoValido($estado) || !self::idaVigente($ida)
            || !hash_equals($ida['estado'], $estado)
        ) {
            // Sin preguntar al panel: un código ajeno ni siquiera se gasta.
            $this->volverAlAcceso($rcmail, 'enlace');
        }

        $canje = $this->canjear($codigo);
        if (!is_array($canje)) {
            $this->volverAlAcceso($rcmail, $canje);
        }

        $this->entrada = $canje;
        if ($ida['zona'] !== '') {
            // rcmail::login la lee de la petición, como la del formulario.
            $_GET['_timezone'] = $ida['zona'];
        }
        $args['action'] = 'login';

        return $args;
    }

    /**
     * Cierra la sesión iniciada con llave un poco antes de que caduque su
     * contraseña temporal, por el mismo camino que mailway_sesion y que
     * Roundcube con una sesión caducada: en AJAX o en un marco se ordena al
     * navegador ir al acceso; en una página normal, redirección. Si cierra, no
     * vuelve.
     */
    private function vigilarCaducidad(rcmail $rcmail, string $tarea): void
    {
        $llave = $_SESSION[self::SESION] ?? null;
        if (empty($_SESSION['user_id']) || !is_array($llave) || in_array($tarea, ['login', 'logout'], true)) {
            return;
        }
        if (self::ahoraMs() < (int) ($llave['expira'] ?? 0) - self::MARGEN_MS) {
            return;
        }

        $this->add_texts('localization/');
        $aviso = $this->gettext('caducada');
        // session_destroy retira la contraseña temporal en el panel.
        $rcmail->kill_session();

        $acceso = ['_task' => 'login', self::AVISO => 'caducada'];
        if ($rcmail->output->ajax_call || $rcmail->output->get_env('framed')) {
            $rcmail->output->show_message($aviso, 'warning');
            $rcmail->output->command('session_error', $rcmail->url($acceso));
            $rcmail->output->send('iframe');
            exit;
        }
        $rcmail->output->redirect($acceso);
    }

    /** A la pantalla de acceso con uno de los avisos de AVISOS. No vuelve. */
    private function volverAlAcceso(rcmail $rcmail, string $aviso): never
    {
        $rcmail->output->redirect(['_task' => 'login', self::AVISO => $aviso]);
        exit; // redirect() ya termina; «never» lo deja claro a quien lee volver().
    }

    /* ---------------------------- Diálogo con el panel ------------------------ */

    /**
     * Origen de «Mi buzón» para este nombre, o null si no se ofrece la llave.
     * Se recuerda 5 minutos para todos los visitantes (caché compartida de
     * Roundcube): la pantalla de acceso no debe preguntar al panel en cada
     * visita, ni esperarle cada vez si está caído.
     */
    private function portal(string $host): ?string
    {
        if (array_key_exists($host, $this->portales)) {
            return $this->portales[$host];
        }

        $cache = self::cache();
        $clave = 'portal.' . md5($host);
        $guardado = null;
        if ($cache) {
            try {
                $guardado = $cache->get($clave);
            } catch (Throwable $e) {
                $guardado = null;
            }
        }
        if (is_array($guardado) && (int) ($guardado['hasta'] ?? 0) > time() && is_string($guardado['portal'] ?? null)) {
            return $this->portales[$host] = ($guardado['portal'] === '' ? null : $guardado['portal']);
        }

        [$portal, $vida] = $this->pedirPortal($host);
        if ($cache) {
            try {
                $cache->set($clave, ['portal' => $portal ?? '', 'hasta' => time() + $vida]);
                // Sin índice, rcube_cache solo escribe en la base al cerrarse
                // (Roundcube cierra las suyas al terminar; esta no es suya).
                $cache->close();
            } catch (Throwable $e) {
                self::registrarError('No se ha podido guardar el portal en la caché: ' . $e->getMessage());
            }
        }

        return $this->portales[$host] = $portal;
    }

    /** @return array{0: string|null, 1: int} El portal (o null) y cuánto recordarlo. */
    private function pedirPortal(string $host): array
    {
        // Plazos cortos: la pantalla de acceso espera, y sin respuesta no hay botón.
        $respuesta = $this->pedir('GET', '/api/webmail/llave/portal', ['query' => ['host' => $host]], 2, 1);
        if ($respuesta === null) {
            return [null, self::CACHE_FALLO];
        }
        if ($respuesta['estado'] === 404) {
            // Este nombre no es un webmail Roundcube de la instancia (no es un error).
            return [null, self::CACHE_PORTAL];
        }
        if ($respuesta['estado'] !== 200) {
            self::registrarError("El panel ha respondido {$respuesta['estado']} al pedir el portal" . self::pista($respuesta['estado']));

            return [null, self::CACHE_FALLO];
        }
        $portal = self::validarPortal(is_array($respuesta['datos']) ? ($respuesta['datos']['portal'] ?? null) : null);
        if ($portal === null) {
            self::registrarError('La respuesta del panel al pedir el portal no es válida.');

            return [null, self::CACHE_FALLO];
        }

        return [$portal, self::CACHE_PORTAL];
    }

    /**
     * Canjea el código: los datos para entrar, o el aviso que hay que mostrar
     * ('enlace' si el código no vale, 'fallo' si el panel falla).
     *
     * @return array{usuario: string, contrasena: string, sesion: string, expira: int}|string
     */
    private function canjear(string $codigo)
    {
        // Más margen que en las consultas: el panel crea la contraseña temporal
        // en el motor antes de contestar.
        $respuesta = $this->pedir('POST', '/api/webmail/llave', ['json' => ['codigo' => $codigo]], 10, 2);
        if ($respuesta === null) {
            return 'fallo';
        }
        if ($respuesta['estado'] === 404) {
            // passkey_code_invalid: no existe, caducó o ya se usó.
            return 'enlace';
        }
        if ($respuesta['estado'] !== 200) {
            self::registrarError("El panel ha respondido {$respuesta['estado']} al canjear el código" . self::pista($respuesta['estado']));

            return 'fallo';
        }
        $datos = self::validarCanje($respuesta['datos'], self::ahoraMs());
        if ($datos === null) {
            self::registrarError('La respuesta del panel al canjear el código no es válida.');

            return 'fallo';
        }

        return $datos;
    }

    /**
     * Retira la contraseña temporal. Lo mejor posible: plazo corto y, si el
     * panel no contesta, la contraseña caduca sola (12 horas como mucho). Salir
     * nunca espera más de eso.
     */
    private function salir(string $sesion): void
    {
        $respuesta = $this->pedir('POST', '/api/webmail/llave/salir', ['json' => ['sesion' => $sesion]], 3, 1);
        if ($respuesta !== null && $respuesta['estado'] !== 200) {
            self::registrarError("El panel ha respondido {$respuesta['estado']} al cerrar la sesión con llave" . self::pista($respuesta['estado']));
        }
    }

    /**
     * Petición al panel con el secreto compartido. ['estado' => int, 'datos' =>
     * JSON decodificado o null], o null si no hubo respuesta (ya registrado).
     */
    private function pedir(string $metodo, string $ruta, array $opciones, int $plazo, int $conexion): ?array
    {
        try {
            $cliente = rcube::get_instance()->get_http_client([
                'timeout' => $plazo,
                'connect_timeout' => $conexion,
                'read_timeout' => $plazo,
                // Un 404 o un 401 son respuestas, no excepciones.
                'http_errors' => false,
                'allow_redirects' => false,
            ]);
            $respuesta = $cliente->request($metodo, $this->panel . $ruta, $opciones + [
                'headers' => ['X-Mailway-Token' => $this->token, 'Accept' => 'application/json'],
            ]);
            $cuerpo = (string) $respuesta->getBody();
        } catch (Throwable $e) {
            self::registrarError("El panel no responde en {$this->panel} ({$ruta}): " . $e->getMessage());

            return null;
        }
        // Las respuestas de estas rutas son de unos cientos de bytes.
        $datos = strlen($cuerpo) <= 65536 ? json_decode($cuerpo, true) : null;

        return ['estado' => $respuesta->getStatusCode(), 'datos' => $datos];
    }

    /* ---------------------- Validación (pública para la prueba) --------------------- */

    /**
     * Código del panel: base64url de 16 a 128 caracteres (el panel genera 43 y
     * no admite más de 128). Todas las expresiones
     * llevan /D: sin él, «$» también acepta un salto de línea final.
     */
    public static function codigoValido(string $codigo): bool
    {
        return (bool) preg_match('/^[A-Za-z0-9_-]{16,128}$/D', $codigo);
    }

    /** Estado: base64url de 16 a 64 caracteres (el contrato con el panel). */
    public static function estadoValido(string $estado): bool
    {
        return (bool) preg_match('/^[A-Za-z0-9_-]{16,64}$/D', $estado);
    }

    /** 24 bytes aleatorios en base64url: 32 caracteres. */
    public static function nuevoEstado(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
    }

    /** Zona horaria como la acepta rcmail::login para _timezone, con longitud acotada. */
    public static function zonaValida(string $zona): bool
    {
        return (bool) preg_match('|^[a-z0-9/_+-]{1,64}$|iD', $zona);
    }

    /**
     * Nombre por el que se ha llegado al webmail (sin puerto, en minúsculas), o
     * null si no parece un nombre de host.
     *
     * Se usa Host y no X-Forwarded-Host: Traefik pasa el Host original (y
     * rehace X-Forwarded-Host con ese mismo valor), mailway.php no confía en
     * ninguna cabecera de host y server_name() respeta trusted_host_patterns
     * si el operador lo configura.
     */
    public static function hostActual(): ?string
    {
        $host = strtolower((string) rcube_utils::server_name('HTTP_HOST'));
        if (strlen($host) > 253
            || !preg_match('/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/D', $host)
        ) {
            return null;
        }

        return $host;
    }

    /**
     * Origen de «Mi buzón» (https://panel.cliente.es), sin barra final; null si
     * no es un origen limpio. Va a una redirección: nada de rutas, consultas,
     * credenciales ni otros esquemas.
     */
    public static function validarPortal($portal): ?string
    {
        if (!is_string($portal) || strlen($portal) > 300 || preg_match('/[\s\x00-\x1F\x7F]/', $portal)) {
            return null;
        }
        $partes = parse_url(rtrim($portal, '/'));
        if (!is_array($partes) || !in_array(strtolower($partes['scheme'] ?? ''), ['http', 'https'], true)
            || empty($partes['host']) || isset($partes['user']) || isset($partes['pass'])
            || isset($partes['path']) || isset($partes['query']) || isset($partes['fragment'])
        ) {
            return null;
        }

        return strtolower($partes['scheme']) . '://' . strtolower($partes['host'])
            . (isset($partes['port']) ? ':' . (int) $partes['port'] : '');
    }

    /**
     * Respuesta de POST /api/webmail/llave, validada. La caducidad se recorta a
     * 12 horas aunque el panel diga otra cosa. null si no tiene la forma
     * esperada o ya ha caducado.
     *
     * @return array{usuario: string, contrasena: string, sesion: string, expira: int}|null
     */
    public static function validarCanje($datos, int $ahoraMs): ?array
    {
        if (!is_array($datos)) {
            return null;
        }
        $usuario = is_string($datos['usuario'] ?? null) ? trim($datos['usuario']) : '';
        $contrasena = $datos['contrasena'] ?? null;
        $sesion = $datos['sesion'] ?? null;
        $expira = $datos['expira'] ?? null;
        $arroba = strrpos($usuario, '@');
        if ($usuario === '' || strlen($usuario) > 320 || $arroba === false || $arroba === 0
            || $arroba === strlen($usuario) - 1 || preg_match('/[\s\x00-\x1F\x7F]/', $usuario)
        ) {
            return null;
        }
        if (!is_string($contrasena) || $contrasena === '' || strlen($contrasena) > 1024
            || preg_match('/[\x00-\x1F\x7F]/', $contrasena)
        ) {
            return null;
        }
        if (!is_string($sesion) || !preg_match('/^[\x21-\x7E]{1,200}$/D', $sesion)) {
            return null;
        }
        if ((!is_int($expira) && !is_float($expira)) || $expira <= $ahoraMs) {
            return null;
        }

        return [
            'usuario' => $usuario,
            'contrasena' => $contrasena,
            'sesion' => $sesion,
            'expira' => (int) min($expira, $ahoraMs + self::MAX_SESION_MS),
        ];
    }

    /* -------------------------------- Internos ------------------------------- */

    /** El viaje guardado en la sesión, con su estado y sin caducar. */
    private static function idaVigente($ida): bool
    {
        return is_array($ida) && is_string($ida['estado'] ?? null) && is_string($ida['zona'] ?? null)
            && time() - (int) ($ida['hora'] ?? 0) <= self::VIDA_IDA;
    }

    /** Caché compartida (tabla cache_shared de Roundcube), o null si no hay base. */
    private static function cache(): ?rcube_cache
    {
        try {
            return rcube_cache::factory('db', null, 'mailway_llave', self::CACHE_PORTAL . 's');
        } catch (Throwable $e) {
            return null;
        }
    }

    private static function borrarCookieFin(): void
    {
        rcube_utils::setcookie(self::COOKIE_FIN, '', time() - 3600);
    }

    private static function ahoraMs(): int
    {
        return (int) floor(microtime(true) * 1000);
    }

    private static function pista(int $estado): string
    {
        return $estado === 401 ? ': revisa MAILWAY_WEBMAIL_TOKEN.' : '.';
    }

    /** Al registro de errores de Roundcube, sin códigos, contraseñas ni secretos. */
    private static function registrarError(string $mensaje): void
    {
        rcube::raise_error(['code' => 500, 'message' => 'mailway_llave: ' . $mensaje], true, false);
    }
}
