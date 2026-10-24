<?php

$labels = [];
$labels['boton'] = 'Usar llave de acceso';
// El código de un solo uso no existe, caducó (2 minutos), ya se usó o el
// estado no coincide (el enlace se abrió en otro navegador o es de otra
// persona). En todos los casos basta con volver a empezar.
$labels['enlace'] = 'El enlace para acceder con tu llave de acceso ha caducado o ya se ha usado. Vuelve a intentarlo.';
$labels['fallo'] = 'No se ha podido acceder con tu llave de acceso. Vuelve a intentarlo o accede con tu contraseña.';
$labels['portal'] = 'Ahora no se puede acceder con llave de acceso. Vuelve a intentarlo en unos minutos o accede con tu contraseña.';
$labels['caducada'] = 'La sesión que iniciaste con tu llave de acceso ha caducado. Vuelve a acceder.';
// El servidor de correo dejó de aceptar la contraseña temporal antes de
// tiempo: el panel la retira al borrar la llave, al cambiar la contraseña del
// buzón o al abrirse demasiadas sesiones. El texto no afirma la causa.
$labels['terminada'] = 'La sesión que iniciaste con tu llave de acceso ya no es válida y se ha cerrado. Vuelve a acceder.';
