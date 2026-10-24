/*
 * Botón «Usar llave de acceso»: añade al enlace la zona horaria del
 * navegador.
 *
 * El formulario de acceso de Roundcube la manda en el campo _timezone y, con
 * timezone = 'auto' (mailway.php), es la que usa el webmail para las horas.
 * La entrada con llave no pasa por ese formulario: la zona viaja en el enlace
 * hasta plugin.mailway_llave_ir, se guarda en la sesión y se aplica al entrar.
 * Se pone al cargar (no al pulsar) para que también valga al abrir el enlace
 * en otra pestaña. Sin JavaScript se entra igual, con la hora del servidor.
 */
(function () {
  'use strict';

  function ponerZona() {
    var enlace = document.getElementById('mailway-llave');
    var zona = '';

    if (!enlace) {
      return;
    }
    try {
      zona = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) {
      zona = '';
    }
    // El mismo formato que acepta Roundcube para _timezone.
    if (!/^[A-Za-z0-9\/_+-]{1,64}$/.test(zona) || /[?&]_timezone=/.test(enlace.href)) {
      return;
    }
    enlace.href += (enlace.href.indexOf('?') === -1 ? '?' : '&') + '_timezone=' + encodeURIComponent(zona);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ponerZona);
  } else {
    ponerZona();
  }
})();
