# Roundcube en Mailway

Cinco complementos propios (`mailway_theme`, `mailway_perfil`,
`mailway_sesion`, `mailway_cuentas` y `mailway_llave`), la configuración
(`mailway.php`) y el diagnóstico que usa el instalador.

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
- Campos de texto con fondo propio y borde visible (también De,
  Destinatario y Asunto al redactar), para que se vean aunque estén vacíos;
  al enfocarlos pasan a blanco con borde petróleo.
- Modo oscuro propio y amable (gris verdoso suave, no casi negro; acento
  apagado para textos e iconos; botones principales en un petróleo
  intermedio con texto claro; contraste AA) en lugar del gris azulado de
  Elastic. El editor HTML también se ve en oscuro (`editor.js`): Elastic lo
  deja en blanco. Es solo la vista al escribir; el mensaje sale sin colores
  añadidos.
- El panel vacío (sin mensaje abierto) muestra la tesela del panel en vez del
  logotipo de Roundcube, que asomaba aunque hubiera marca blanca.
- El icono de la pestaña es el de Mailway (`favicon.ico`, `favicon.svg` y
  `apple-touch-icon.png`, los mismos del panel), salvo que el operador haya
  configurado el suyo (`skin_logo` con `[favicon]` o `favicon`).
- El logotipo es la tesela de Mailway (`logo.svg`) en el acceso y en el
  menú; en el menú va en su recuadro (tesela blanca con borde fino y una
  regla debajo) para que no se confunda con «Redactar», el botón petróleo
  que tiene debajo. Si el operador puso su logotipo en `skin_logo`, se
  respeta tal cual (y el acceso queda en su versión sencilla).
- La pantalla de acceso es una portada en dos columnas: panel de marca en
  petróleo (logotipo y nombre del servicio centrados y una bandeja de
  entrada dibujada, sin textos añadidos) y la tarjeta, con la etiqueta
  «Dirección de correo» y el botón «Acceder»; en el móvil, el panel queda
  como franja de cabecera con la marca.
- El enlace de soporte, que `mailway.php` apunta a «Mi buzón», se llama
  «Mi buzón» en lugar de «Obtener soporte» (si el operador cambia
  `support_url`, conserva la etiqueta de Roundcube).

Ficheros:

- `mailway_theme.php`: incluye las hojas de estilo, marca `<html>` con la
  clase `mailway` (para que las reglas valgan igual en claro y en oscuro sin
  `!important`), ajusta `theme-color`, pone los iconos de la pestaña y apunta
  el panel vacío a `vacio.html`.
- `mailway.css`: el tema, con la paleta clara y la oscura en variables.
- `iconos.css`: los iconos de Lucide en línea (licencia ISC, aviso incluido).
- `editor.js`: el editor HTML sigue el modo oscuro (estilo de la vista, no
  del mensaje).
- `vacio.html`: el panel vacío, sin texto, válido para cualquier idioma.

El tema es Elastic, el que trae la imagen de Roundcube (no hay que mantener
una copia). `mailway.php` lo fija para todos (`skin` en `dont_override`):
nadie se queda con un tema que ya no se instala y el selector de temas no
aparece en los ajustes.

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
sesión y se vuelve a la pantalla de acceso con el aviso «Tu contraseña ya no es
válida (puede que haya cambiado) y la sesión se ha cerrado. Vuelve a acceder.»,
también desde las peticiones AJAX y los marcos (refresco de la bandeja, vista
previa), por el mismo camino que una sesión caducada; en la redacción,
Roundcube guarda antes el borrador en el navegador. Un fallo de red, de TLS o
temporal del servidor (IMAP caído, `UNAVAILABLE`) no cierra la sesión, y el
acceso normal fallido sigue igual. No depende del panel. En una sesión iniciada con
llave de acceso, el aviso de la pantalla de acceso lo pone `mailway_llave`
(ver más abajo).

## Configuración y diagnóstico

`mailway.php` es la configuración de Mailway para Roundcube (servidores,
complemento de contraseña y de perfil, ManageSieve, marca, formato de fecha y
letra del editor); el compose lo monta en `/var/roundcube/config/`.

- **IP real detrás del proxy de Cloudflare**: cuando quien conecta con
  Traefik es una IP de Cloudflare (sus rangos IPv4 e IPv6, fijados en
  `mailway.php`), Roundcube toma la del visitante de `CF-Connecting-IP` para
  la sesión y los registros. Si no, la cabecera se ignora: cualquiera puede
  enviarla conectando directamente con el servidor.

`diagnostico/comprobar.php` es el diagnóstico de línea de órdenes que usan
`deploy/instalar.sh --comprobar` y `--probar-acceso`: abre IMAP y SMTP con la
configuración efectiva de Roundcube, verifica el certificado público del
motor y, con `--probar-acceso`, inicia sesión una sola vez con la biblioteca
IMAP de Roundcube. Los compose montan esa carpeta en `/opt/mailway`, fuera de
la raíz web y de `/var/roundcube/config/` (cuyos `.php` se cargarían como
configuración).

## Aplicar los cambios

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
que ya tuvieran); `mailway_sesion`, `mailway_cuentas` y `mailway_llave` se
retiran igual. No hay cambios de esquema ni de datos.

## Cambio de dominio: `mailway_cuentas`

Cuando un cliente pasa de `@dominio.es` a `@dominio2.es`, el servidor de
correo sigue conociendo cada buzón por su usuario anterior (`ana@dominio.es`)
hasta que su titular pulsa «Actualizar mis dispositivos». El complemento
`mailway_cuentas` hace que el webmail funcione igual mientras tanto:

- **Al entrar** (gancho `authenticate`) pregunta al panel qué usuario
  corresponde a lo que se ha tecleado —la dirección vieja, la nueva o el
  usuario— con `POST <MAILWAY_PANEL_INTERNAL_URL>/api/webmail/cuenta` y la
  cabecera `X-Mailway-Token`, el mismo canal que el complemento de contraseña.
  Entra con ese usuario y, si el buzón ya lo cambió, traslada al nuevo la fila
  de `users` del anterior: los contactos, las identidades, las respuestas y
  las preferencias van con ella porque el `user_id` no cambia.
- **Nunca borra nada.** Si ya había una fila con el usuario vigente (alguien
  entró con él antes), se aparta renombrándola a
  `<usuario>#apartado-<user_id>`: conserva sus datos y, si hiciera falta, se
  recuperan a mano desde esa fila.
- **Tras entrar** (gancho `login_after`) pasa a la dirección vigente la
  identidad que aún tenía la anterior, conservando el nombre, la firma y las
  respuestas.

El traslado se hace antes de comprobar la contraseña: solo ocurre cuando el
panel dice que el usuario vigente del buzón es otro y lleva al mismo estado
que la siguiente entrada legítima, así que quien no conoce la contraseña solo
puede adelantarlo (ver `docs/SEGURIDAD.md`).

No necesita configuración propia: lee `MAILWAY_PANEL_INTERNAL_URL` y
`MAILWAY_WEBMAIL_TOKEN`, que los compose ya pasan al webmail. Sin alguna de
las dos no hace nada. Si el panel no responde (espera 2 segundos como
máximo), contesta algo inesperado o no conoce la dirección, se entra como
siempre; los fallos que no son un simple «no existe» quedan en el registro de
errores de Roundcube con el prefijo `mailway_cuentas:`.

Tras «Actualizar mis dispositivos», una sesión del webmail que ya estaba
abierta pide volver a entrar; al hacerlo, el complemento traslada la fila.

La prueba `pruebas/mailway_cuentas.php` usa la biblioteca y el esquema SQLite
de la imagen real de Roundcube, con el panel simulado dentro del mismo
contenedor y sin red. Además de los ganchos por separado, entra por el
`index.php` de la imagen con la configuración `mailway.php` y un IMAP falso,
como lo haría un navegador:

```sh
docker run --rm -v "$PWD/deploy/roundcube:/opt/mailway-rc:ro" \
  roundcube/roundcubemail:1.7.5-apache php /opt/mailway-rc/pruebas/mailway_cuentas.php
```

Para desactivarlo, retira `mailway_cuentas` de `ROUNDCUBEMAIL_PLUGINS` y
recrea solo el webmail. No cambia el esquema de Roundcube.

## Acceso con llave de acceso: `mailway_llave`

El titular puede acceder al webmail con una llave de acceso (passkey) en
lugar de su contraseña. Roundcube no comprueba la llave: lo hace «Mi buzón»
del panel, que es quien conoce las llaves del titular.

- **Botón en el acceso** (gancho `loginform_content`): «Usar llave de
  acceso», debajo de «Acceder», como botón secundario (las clases que
  Elastic da al botón de OAuth, con el icono de la llave de `mailway_theme`).
  Solo aparece si el panel dice que el nombre por el que se ha llegado es un
  webmail Roundcube de la instancia (`GET
  <MAILWAY_PANEL_INTERNAL_URL>/api/webmail/llave/portal?host=<nombre>`). La
  respuesta, también la negativa, se recuerda cinco minutos para todos los
  visitantes en la caché compartida de Roundcube (un minuto si el panel
  falla); sin respuesta no hay botón y el acceso es el de siempre.
- **Ida al panel** (acción `plugin.mailway_llave_ir`, la del botón): genera
  un estado aleatorio, lo guarda en la sesión previa al acceso junto con la
  zona horaria del navegador (`mailway_llave.js` la añade al enlace) y lleva
  a `<portal>/mi-buzon/correo-web?destino=<nombre>&estado=<estado>`, donde el
  titular usa su llave.
- **Vuelta** (acción `plugin.mailway_llave`, con `_codigo` y `_estado`): el
  estado tiene que coincidir con el guardado, que vale una sola vez y 15
  minutos. Solo entonces se canjea el código (`POST /api/webmail/llave`) por
  el usuario del motor y una contraseña de aplicación temporal (12 horas como
  mucho) y se entra por el camino normal de Roundcube, como con OAuth: purga
  de la sesión previa, `authenticate`, `rcmail::login` contra el mismo IMAP
  que el formulario, id de sesión nuevo, cookie de autenticación, registro del
  acceso, `login_after` y redirección al correo, con la zona horaria del
  navegador. `mailway_cuentas`, `mailway_perfil` y `mailway_sesion` funcionan
  igual que con contraseña. Con una sesión ya iniciada, el enlace lleva al
  correo sin canjear nada.
- **Salida** (gancho `session_destroy`: salir, caducidad, `mailway_sesion` o
  un acceso nuevo encima): pide al panel que retire la contraseña temporal
  (`POST /api/webmail/llave/salir`) con un plazo corto (3 s); si el panel no
  contesta, caduca sola. Una sesión que Roundcube olvida por inactividad (30
  minutos) no pasa por aquí: su contraseña temporal dura hasta que caduca.
- **Caducidad**: un minuto antes de que caduque la contraseña temporal, la
  sesión se cierra y la pantalla de acceso dice «La sesión que iniciaste con
  tu llave de acceso ha caducado. Vuelve a acceder.», también desde las
  peticiones AJAX y los marcos. Si el panel la retira antes (se borra la
  llave, se cambia la contraseña del buzón o se abren demasiadas sesiones), el
  IMAP la rechaza y `mailway_sesion` cierra la sesión; una cookie breve
  (`mailway_llave_fin`) permite a `mailway_llave` cambiar el aviso de
  contraseña cambiada por «La sesión que iniciaste con tu llave de acceso ya
  no es válida y se ha cerrado. Vuelve a acceder.». En una petición AJAX el
  aviso de `mailway_sesion` se ve un instante antes de ir al acceso.
- **Fallos**: un código caducado, gastado o con un estado que no coincide
  vuelve al acceso con «El enlace para acceder con tu llave de acceso ha
  caducado o ya se ha usado. Vuelve a intentarlo.»; si el panel falla o el IMAP
  no acepta la contraseña temporal (que entonces se retira), con «No se ha
  podido acceder con tu llave de acceso…».

**Por qué el estado**: sin él, cualquiera podría usar su propia llave para
conseguir un código y mandar el enlace a otra persona, que entraría sin darse
cuenta en el buzón de quien se lo mandó («login CSRF»). El estado lo genera
el webmail en la sesión de cada navegador, así que un enlace preparado en
otro navegador no sirve: se vuelve al acceso sin canjear el código. Las dos
acciones son GET sin el token de petición de Roundcube porque llegan del
panel por una redirección; las protegen el estado y que el código es de un
solo uso y de dos minutos.

**Orden**: `mailway_llave` va antes que `mailway_cuentas` y `mailway_sesion`
en `ROUNDCUBEMAIL_PLUGINS` (los compose ya lo hacen y la prueba lo
comprueba). Su `authenticate` tiene que poner el usuario del motor antes de
que `mailway_cuentas` lo traduzca, y su aviso tiene que ir antes que el de
`mailway_sesion`.

No necesita configuración propia: lee `MAILWAY_PANEL_INTERNAL_URL` y
`MAILWAY_WEBMAIL_TOKEN`; sin alguna de las dos no hace nada (ni botón). Los
fallos del panel quedan en el registro de errores de Roundcube con el prefijo
`mailway_llave:`, sin códigos ni contraseñas. El código de un solo uso sí
aparece en el registro de accesos del servidor web, porque va en la URL de
vuelta; para entonces ya está gastado o caduca a los dos minutos.

La prueba `pruebas/mailway_llave.php` entra como un navegador por el
`index.php` de la imagen real (configuración `mailway.php`, los complementos
`mailway_*` en el orden de los compose, IMAP falso y el panel simulado dentro
del mismo contenedor, sin red): el botón, el viaje con estado (también el
enlace abierto en otro navegador), la entrada con `mailway_cuentas`
traduciendo el usuario, la sesión regenerada y la zona horaria, salir, la
caducidad (también por AJAX), el cierre por `mailway_sesion` con su aviso y
los fallos del panel. Lee los compose, así que necesita la carpeta `deploy`
entera:

```sh
docker run --rm -v "$PWD/deploy:/opt/mailway-deploy:ro" \
  roundcube/roundcubemail:1.7.5-apache php /opt/mailway-deploy/roundcube/pruebas/mailway_llave.php
```

Para desactivarlo, retira `mailway_llave` de `ROUNDCUBEMAIL_PLUGINS` y recrea
solo el webmail. No cambia el esquema de Roundcube (usa su tabla
`cache_shared`).
