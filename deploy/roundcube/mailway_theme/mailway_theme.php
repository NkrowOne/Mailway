<?php

/**
 * Capa visual de Mailway sobre Elastic (Roundcube 1.7).
 *
 * Solo apariencia: añade dos hojas de estilo (iconos y tema), una clase en
 * <html>, el color de la barra del navegador, el icono de Mailway en la
 * pestaña y su logotipo (con el nombre del servicio en la pantalla de
 * acceso). No toca la autenticación, el contenido de los mensajes, los
 * atajos ni la navegación: si algo de esto fallara, el webmail seguiría
 * funcionando con el aspecto original de Elastic.
 */
class mailway_theme extends rcube_plugin
{
    /** El favicon de Elastic cuando nadie ha configurado otro. */
    private const FAVICON_ROUNDCUBE = '/images/favicon.ico';

    /** @var bool Si se ponen los iconos de Mailway (el operador no tiene los suyos). */
    private $iconos_propios = false;

    /** @var bool Si se pone el logotipo de Mailway (el operador no tiene el suyo). */
    private $logo_propio = false;

    public function init()
    {
        // Las reglas están escritas contra el marcado de Elastic; con otro
        // tema romperían más de lo que arreglan.
        if (rcmail::get_instance()->config->get('skin') !== 'elastic') {
            return;
        }

        $this->include_stylesheet('iconos.css');
        $this->include_stylesheet('mailway.css');
        $this->add_hook('render_page', [$this, 'render_page']);

        // Panel vacío propio (vacio.html) en lugar de la marca de agua de
        // Elastic, que muestra el logotipo de Roundcube aunque haya marca
        // blanca. Si el operador configuró otra página, se respeta.
        $rcmail = rcmail::get_instance();
        if ($rcmail->output instanceof rcmail_output_html
            && $rcmail->config->get('blankpage_url', '/watermark.html') === '/watermark.html'
        ) {
            $rcmail->output->set_env('blankpage', $this->urlbase . 'vacio.html');
        }

        // Icono de la pestaña: el de Mailway (el mismo que el panel) y no el
        // de Roundcube, también en los dominios de marca blanca del webmail.
        // Va como valor por defecto de «favicon», que Roundcube solo usa si el
        // operador no ha puesto el suyo en skin_logo; si lo cambió en
        // «favicon», tampoco se toca.
        $this->iconos_propios = $this->sin_iconos_del_operador($rcmail);
        if ($this->iconos_propios) {
            $rcmail->config->set('favicon', $this->urlbase . 'favicon.ico');
        }

        // Logotipo: el de Mailway en lugar del de Roundcube (acceso y menú),
        // también con marca blanca. Se añade a skin_logo con la clave
        // «elastic:*», que Roundcube solo consulta para el logotipo de
        // pantalla: no alcanza al favicon ni a la impresión, que piden un tipo
        // concreto. Va después de decidir los iconos porque esa decisión mira
        // skin_logo y debe ver solo lo que puso el operador. Un tipo «[dark]»
        // o «[small]» no hace falta: la tesela se lee igual en claro y en
        // oscuro y a cualquier tamaño.
        //
        // La fecha del fichero va a mano: Roundcube no la añade a las rutas
        // de skin_logo y, sin ella, un logotipo nuevo tardaría en verse.
        $this->logo_propio = $this->sin_logo_del_operador($rcmail);

        // En el acceso, el usuario es la dirección completa: la etiqueta lo
        // dice en lugar de «Nombre de usuario», que hace dudar a la gente.
        if ($this->logo_propio && $rcmail->task === 'login') {
            $rcmail->load_language(null, [], ['username' => 'Dirección de correo']);
        }
        if ($this->logo_propio) {
            $logo = $rcmail->config->get('skin_logo');
            $logo = is_array($logo) ? $logo : [];
            $fecha = @filemtime($this->home . '/logo.svg');
            $logo['elastic:*'] = $this->urlbase . 'logo.svg' . ($fecha ? '?s=' . $fecha : '');
            $rcmail->config->set('skin_logo', $logo);
        }
    }

    /**
     * Marca el documento y ajusta el color del navegador.
     *
     * La clase «mailway» en <html> da a todas las reglas del tema la misma
     * especificidad que las de Elastic para el modo oscuro (html.dark-mode),
     * así que una sola regla con variables sirve para los dos modos sin
     * recurrir a !important. Se pone en el servidor, no con JavaScript, para
     * que no haya un parpadeo con el aspecto original al cargar.
     */
    public function render_page($args)
    {
        $html = $args['content'];

        $html = preg_replace_callback('/<html\b([^>]*)>/i', static function (array $m): string {
            $atributos = $m[1];
            if (preg_match('/\bclass\s*=\s*(["\'])([^"\']*)\1/i', $atributos, $clase)) {
                if (preg_match('/(^|\s)mailway(\s|$)/', $clase[2])) {
                    return $m[0];
                }
                $atributos = str_replace($clase[0], 'class=' . $clase[1] . trim($clase[2] . ' mailway') . $clase[1], $atributos);
            } else {
                $atributos .= ' class="mailway"';
            }

            return '<html' . $atributos . '>';
        }, $html, 1);

        // Elastic declara un gris fijo (#f4f4f4). La barra del navegador del
        // móvil se tiñe con el fondo de la pantalla de acceso y con el de la
        // barra superior dentro del correo, en claro y en oscuro.
        $acceso = ($args['template'] ?? '') === 'login';
        $claro = $acceso ? '#f4f6f4' : '#ffffff';
        $oscuro = $acceso ? '#101716' : '#172120';
        $html = preg_replace(
            '/<meta name="theme-color"[^>]*>/i',
            '<meta name="theme-color" content="' . $claro . '" media="(prefers-color-scheme: light)">'
                . '<meta name="theme-color" content="' . $oscuro . '" media="(prefers-color-scheme: dark)">',
            $html,
            1
        );

        // Junto al .ico, la versión vectorial (nítida en cualquier tamaño, la
        // que prefieren los navegadores actuales) y el icono para la pantalla
        // de inicio de iOS. Elastic no declara ninguno de los dos. Rutas
        // relativas: Roundcube las pasa luego por static.php y les añade la
        // fecha del fichero para invalidar la caché.
        if ($this->iconos_propios) {
            $iconos = "\n" . '<link rel="icon" type="image/svg+xml" href="' . $this->urlbase . 'favicon.svg">'
                . "\n" . '<link rel="apple-touch-icon" href="' . $this->urlbase . 'apple-touch-icon.png">';
            $html = preg_replace('/<link[^>]*rel="apple-touch-icon"[^>]*>\s*/i', '', $html);
            $con_icono = preg_replace('/(<link[^>]*rel="shortcut icon"[^>]*>)/i', '$1' . $iconos, $html, 1, $hechos);
            if ($hechos) {
                $html = $con_icono;
            } else {
                $html = preg_replace('/<\/head>/i', $iconos . "\n</head>", $html, 1);
            }
        }

        if ($acceso && $this->logo_propio) {
            $html = $this->marca_en_acceso($html, rcmail::get_instance());
        }

        $args['content'] = $html;

        return $args;
    }

    /**
     * Portada de la pantalla de acceso: panel de marca a la izquierda (logo
     * y nombre del servicio sobre el petróleo de la marca) y la tarjeta a la
     * derecha; en el móvil, el panel queda como franja de cabecera. Solo con el logotipo de Mailway: un operador con marca
     * propia conserva el acceso sencillo con su logotipo.
     *
     * El nombre (product_name, de MAILWAY_BRAND) sale escapado. Al estar en
     * el panel, se quita del pie, que si no diría «<nombre> • Obtener
     * soporte» bajo la tarjeta.
     */
    private function marca_en_acceso(string $html, rcmail $rcmail): string
    {
        $nombre = html::quote(trim((string) $rcmail->config->get('product_name', '')) ?: 'Webmail');
        // La misma URL que Roundcube dio al logotipo (pasa por static.php y
        // lleva la fecha del fichero): una ruta escrita aquí no se reescribe.
        $logo = preg_match('/<img\b[^>]*\bid="logo"[^>]*\bsrc="([^"]+)"/i', $html, $m)
            || preg_match('/<img\b[^>]*\bsrc="([^"]+)"[^>]*\bid="logo"/i', $html, $m)
            ? $m[1]
            : $this->urlbase . 'logo.svg';

        // Solo marca y diseño: el panel no añade textos a la pantalla.
        $portada = "\n" . '<aside id="mailway-portada" aria-hidden="true">'
            . '<div class="mw-portada-marca"><img src="' . $logo . '" alt=""><span>' . $nombre . '</span></div>'
            . '</aside>';

        // La portada abre el contenedor de la página; la clase en <body>
        // activa la disposición en dos columnas y oculta el logotipo suelto.
        $html = preg_replace('/<div id="layout">/', '<div id="layout">' . $portada, $html, 1, $hechos);
        if (!$hechos) {
            return $html;
        }
        $html = preg_replace('/<body class="task-login/', '<body class="mailway-portada task-login', $html, 1);


        $html = preg_replace(
            '/(<div id="login-footer"[^>]*>\s*)' . preg_quote($nombre, '/') . '\s*(?:&nbsp;&bull;&nbsp;\s*)?/',
            '$1',
            $html,
            1
        );
        // Sin enlace de soporte (no hay URL del panel), el pie se queda
        // vacío: se marca para que su margen no deje un hueco en la tarjeta.
        // No se quita, porque otros complementos pueden escribir en él desde
        // JavaScript (contenedor «loginfooter»).
        $html = preg_replace(
            '/<div id="login-footer"([^>]*)>\s*<\/div>/',
            '<div id="login-footer"$1 class="mailway-vacio"></div>',
            $html,
            1
        );

        return $html;
    }

    /**
     * Cierto si el operador no ha configurado iconos propios.
     *
     * Roundcube toma el favicon de skin_logo (una entrada «[favicon]» o, si
     * skin_logo es un texto, el propio logotipo) y, si no, de «favicon».
     * Cualquiera de los dos puestos por el operador manda sobre los nuestros.
     */
    private function sin_iconos_del_operador(rcmail $rcmail): bool
    {
        $logo = $rcmail->config->get('skin_logo');
        if (is_string($logo) && $logo !== '') {
            return false;
        }
        if (is_array($logo)) {
            foreach (array_keys($logo) as $clave) {
                if (str_contains((string) $clave, '[favicon]')) {
                    return false;
                }
            }
        }

        $favicon = (string) $rcmail->config->get('favicon', '');

        return $favicon === '' || $favicon === self::FAVICON_ROUNDCUBE;
    }

    /**
     * Cierto si el operador no ha puesto un logotipo propio en skin_logo.
     *
     * Cuenta como logotipo cualquier entrada que Roundcube pinte en pantalla:
     * un texto, o una clave sin tipo («login», «elastic:*», «*»...) o con los
     * tipos de Elastic para el modo oscuro y el móvil. Si solo configuró el
     * favicon, el enlace del logotipo o el logotipo de impresión, en pantalla
     * seguiría saliendo el de Roundcube: ahí sí va el de Mailway.
     */
    private function sin_logo_del_operador(rcmail $rcmail): bool
    {
        $logo = $rcmail->config->get('skin_logo');
        if (is_string($logo)) {
            return $logo === '';
        }
        if (!is_array($logo)) {
            return true;
        }

        foreach (array_keys($logo) as $clave) {
            if (!preg_match('/\[([a-z-]+)\]$/', (string) $clave, $tipo)
                || in_array($tipo[1], ['dark', 'small', 'small-dark'], true)
            ) {
                return false;
            }
        }

        return true;
    }
}
