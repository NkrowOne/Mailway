/*
 * Editor HTML en modo oscuro (Roundcube 1.7, Elastic).
 *
 * Elastic deja el área de escritura en blanco también en oscuro: un bloque
 * deslumbrante en mitad de la pantalla. Aquí sigue el modo de la interfaz.
 * Solo cambia cómo se ve mientras se escribe: el estilo va en content_style,
 * que no forma parte del mensaje; el correo sale sin colores añadidos y el
 * destinatario lo ve como siempre.
 *
 * El modo se marca con la clase dark-mode en el <html> del editor, la misma
 * que Elastic pone y quita en todos los marcos al cambiar de modo, así que
 * el editor también cambia en vivo. Al crearlo, la clase mw-oscuro del
 * <body> cubre el arranque hasta que el editor termina de cargar.
 */
(function () {
    if (!window.rcmail || !rcmail.addEventListener) {
        return;
    }

    var OSCURO = 'html.dark-mode body,body.mw-oscuro{background-color:#212a29;color:#e1e8e5}'
        + 'html.dark-mode a,body.mw-oscuro a{color:#86cbc1}'
        + 'html.dark-mode blockquote,body.mw-oscuro blockquote{border-left-color:rgba(255,255,255,.18);color:#b4c0bd}';

    function oscuro() {
        return document.documentElement.classList.contains('dark-mode');
    }

    rcmail.addEventListener('editor-init', function (o) {
        o.config.content_style = (o.config.content_style ? o.config.content_style + ' ' : '') + OSCURO;
        if (oscuro()) {
            o.config.body_class = ((o.config.body_class || '') + ' mw-oscuro').trim();
        }
    });

    rcmail.addEventListener('editor-load', function (o) {
        try {
            var ed = o.ref.editor || (window.tinymce && tinymce.get(o.ref.id)),
                doc = ed && ed.getDoc();

            if (doc) {
                doc.documentElement.classList.toggle('dark-mode', oscuro());
                doc.body.classList.remove('mw-oscuro');
            }
        } catch (e) { /* sin editor HTML: nada que hacer */ }
    });
})();
