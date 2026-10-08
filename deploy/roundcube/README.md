# Roundcube en Mailway

Tres complementos propios (`mailway_theme`, `mailway_perfil` y
`mailway_sesion`), la configuración (`mailway.php`) y el diagnóstico que usa
el instalador.

## Apariencia (`mailway_theme`)

`mailway_theme` es una capa visual sobre Elastic 1.7, mediante la API de
complementos, que acerca el webmail a un cliente de correo actual y al aspecto
del panel (ver `DESIGN.md`). Los dos ficheros Compose de Mailway montan el
complemento en solo lectura y lo incluyen en `ROUNDCUBEMAIL_PLUGINS`.

Qué cambia:

- Carril de tareas claro, con «Redactar» como botón relleno y redondeado y la
  sección activa en una pastilla petróleo tenue; en el móvil, el mismo menú
  en un cajón blanco y un botón flotante «Redactar».
- Carpetas y secciones de ajustes en pastillas sobre el fondo gris verdoso;
  lista y lectura en paneles blancos de esquinas suaves.
- Iconos de línea (Lucide, los mismos del panel) en barras de botones de
  icono; las etiquetas siguen ahí para lectores de pantalla y en el `title`.
- Lista de mensajes con el no leído claro (punto petróleo, negrita y fecha en
  petróleo), bandera y clip discretos y filas más cómodas en pantallas
  táctiles.
- Cabecera del mensaje, adjuntos en fichas, citas con una línea gris y texto
  plano en la letra normal; búsqueda en un campo redondeado.
- Redacción con las cabeceras en filas y los destinatarios en fichas;
  formularios, interruptores, menús, diálogos y avisos con los controles del
  panel; pantalla de acceso con las etiquetas encima de los campos.
- Modo oscuro propio y coherente (gris verdoso profundo, petróleo aclarado,
  contraste AA) en lugar del gris azulado de Elastic.
- El panel vacío (sin mensaje abierto) muestra la tesela del panel en vez del
  logotipo de Roundcube, que asomaba aunque hubiera marca blanca.
- El icono de la pestaña es el de Mailway (`favicon.ico`, `favicon.svg` y
  `apple-touch-icon.png`, los mismos del panel), salvo que el operador haya
  configurado el suyo (`skin_logo` con `[favicon]` o `favicon`).

Ficheros:

- `mailway_theme.php`: incluye las hojas de estilo, marca `<html>` con la
  clase `mailway` (para que las reglas valgan igual en claro y en oscuro sin
  `!important`), ajusta `theme-color`, pone los iconos de la pestaña y apunta
  el panel vacío a `vacio.html`.
- `mailway.css`: el tema, con la paleta clara y la oscura en variables.
- `iconos.css`: los iconos de Lucide en línea (licencia ISC, aviso incluido).
- `vacio.html`: el panel vacío, sin texto, válido para cualquier idioma.

No modifica la autenticación, el contenido de los mensajes, los atajos ni la
estructura adaptable de Elastic (escritorio, tableta y móvil), no carga nada
de fuera (letra del sistema e iconos en línea) y no sustituye el logotipo de
marca blanca configurado.

## Nombre y foto del buzón (`mailway_perfil`)

Complemento funcional, aparte de la capa visual. El titular pone su nombre
visible y su foto en el panel (enlace de configuración o «Mi buzón») y el
webmail los usa:

- **Alta en Roundcube** (`user_create`): la identidad del remitente se crea
  con el nombre del panel. Sin el complemento, Roundcube la crearía sin
  nombre y los correos saldrían solo con la dirección.
- **Cada acceso** (`login_after`): el nombre de la identidad de la dirección
  del buzón se pone al día con el del panel solo si está vacío o sigue siendo
  el último que puso el complemento (lo guarda en la preferencia
  `mailway_nombre`). Así un cambio en «Mi buzón» llega en el siguiente acceso
  y uno hecho en los ajustes de Roundcube se respeta. Las identidades de otras
  direcciones no se tocan.
- **Avatares** (`contact_photo`): si las libretas no tienen foto de un
  remitente, se pide al panel, que solo la da si es un buzón del mismo cliente
  (nunca la de otro cliente). Las respuestas, también las negativas, se
  guardan cinco minutos en la caché de Roundcube por usuario.
- **Foto propia**: si el titular tiene foto, `mailway_theme` la muestra junto
  a su dirección, encima de las carpetas.

Consulta `POST /api/webmail/profile` y `POST /api/webmail/photo` del panel por
la red interna, con el mismo token que el cambio de contraseña
(`MAILWAY_WEBMAIL_TOKEN` y `MAILWAY_PANEL_INTERNAL_URL`); sin ellos,
`mailway.php` retira el complemento. Los tiempos de espera son cortos (1 s de
conexión, 2 s en total) y cualquier fallo del panel solo se anota en el
registro de errores de Roundcube: nunca impide entrar ni leer un mensaje. Los
navegadores guardan un día los avatares de los remitentes (lo decide
Roundcube), así que una foto nueva puede tardar en verse en un equipo que ya
mostró la anterior; la propia se renueva en cada acceso.

## Contraseña cambiada con la sesión abierta (`mailway_sesion`)

Roundcube guarda la contraseña en la sesión y vuelve a entrar en IMAP en cada
petición. Si la contraseña del buzón cambia por fuera (el titular la
restablece, la administración reinicia la configuración…), cada refresco
fallaba con errores de conexión confusos. Con este complemento, cuando IMAP
rechaza las credenciales de una sesión ya iniciada (respuesta `NO` sin código
o con `AUTHENTICATIONFAILED`, `AUTHORIZATIONFAILED` o `EXPIRED`), se cierra la
sesión y se vuelve a la pantalla de acceso con el aviso «Tu contraseña ha
cambiado y la sesión se ha cerrado. Vuelve a iniciar sesión con la nueva.»,
también desde las peticiones AJAX y los marcos (refresco de la bandeja, vista
previa), por el mismo camino que una sesión caducada; en la redacción,
Roundcube guarda antes el borrador en el navegador. Un fallo de red, de TLS o
temporal del servidor (IMAP caído, `UNAVAILABLE`) no cierra la sesión, y el
acceso normal fallido sigue igual. No depende del panel.

## Configuración y diagnóstico

`mailway.php` es la configuración de Mailway para Roundcube (servidores,
complemento de contraseña y de perfil, ManageSieve, marca, formato de fecha y
letra del editor); el compose lo monta en `/var/roundcube/config/`.

`diagnostico/comprobar.php` es el diagnóstico de línea de órdenes que usan
`deploy/instalar.sh --comprobar` y `--probar-acceso`: abre IMAP y SMTP con la
configuración efectiva de Roundcube, verifica el certificado público del
motor y, con `--probar-acceso`, inicia sesión una sola vez con la biblioteca
IMAP de Roundcube. Los compose montan esa carpeta en `/opt/mailway`, fuera de
la raíz web y de `/var/roundcube/config/` (cuyos `.php` se cargarían como
configuración).

Después de actualizar el repositorio, aplica los cambios con el instalador
(`sudo bash deploy/instalar.sh --actualizar`) o recrea solo el webmail con el
mismo Compose y el mismo fichero de entorno de siempre:

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml up -d --force-recreate mailway-webmail
```

En la instalación autónoma, usa `deploy/docker-compose.standalone.yml`.
Comprueba el acceso, las carpetas, la selección y lectura de mensajes, la
redacción, los adjuntos, los contactos, los ajustes, el teclado, el móvil y el
modo oscuro antes de ofrecerlo a los clientes: la compilación de la web no
valida esta capa PHP/CSS y la prueba requiere una instancia de Roundcube.

Para volver al aspecto original, retira `mailway_theme` de la variable de
complementos y recrea solo el servicio; para dejar de usar el nombre y la
foto del panel, retira `mailway_perfil` (las identidades conservan el nombre
que ya tuvieran); `mailway_sesion` se retira igual. No hay cambios de
esquema ni de datos.
