<?php

/**
 * Capa visual de Mailway sobre Elastic (Roundcube 1.7).
 *
 * Solo apariencia: añade dos hojas de estilo (iconos y tema), una clase en
 * <html> y el color de la barra del navegador. No toca la autenticación, el
 * contenido de los mensajes, los atajos ni la navegación: si algo de esto
 * fallara, el webmail seguiría funcionando con el aspecto original de Elastic.
 */
class mailway_theme extends rcube_plugin
{
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

        $args['content'] = $html;

        return $args;
    }
}
