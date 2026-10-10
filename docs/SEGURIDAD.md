# Modelo de seguridad de Mailway

Qué protege Mailway, frente a quién y cómo. Complementa
[PLAN.md](PLAN.md) (decisiones) e [INTEGRACIONES.md](INTEGRACIONES.md)
(rutas y códigos de error).

## 1. Qué se protege y frente a quién

| Activo | Amenaza principal |
|---|---|
| El correo de cada cliente | Otro cliente de la misma instancia, un tercero que adivina o roba credenciales |
| La reputación de la IP | Un cliente o una clave filtrada que envía spam |
| Las credenciales (contraseñas, tokens, claves, tokens de Cloudflare) | Robo de la base de datos, registros o respuestas de la API |
| El servidor y las demás aplicaciones (Skyway) | Un cliente que reclama nombres ajenos en Traefik |
| La disponibilidad del motor | El bloqueo automático de IPs del motor usado contra el propio servicio |

Se parte de que **los clientes no confían entre sí** y de que un usuario de
cliente puede usar la API directamente, no solo la interfaz.

## 2. Superficie y niveles de acceso

| Superficie | Quién accede | Protección |
|---|---|---|
| Panel (`/api/*`) | Usuarios del panel (sesión) e integraciones (token `mwt_`) | Guardas por ruta, CSRF, límites de intentos |
| Estado de la puesta en marcha (`GET /api/setup/status`) | Cualquiera, sin sesión | Terminada la puesta en marcha, solo la marca y tres indicadores; el detalle, solo para la administración |
| API de envío (`/v1/send`) | Aplicaciones con clave `mw_` | Clave hasheada, límites del plan por cliente |
| «Mi buzón» (`/api/portal/*`) | Titulares con la contraseña del buzón | Cookie propia limitada a `/api/portal`, verificación local, límites de fallos |
| Enlaces de bienvenida (`/api/invite/*`) | Quien tenga el enlace (la persona de contacto del cliente) | Token de 256 bits de un solo uso, caducidad, 60 peticiones por minuto e IP; solo la administración los crea o los vuelve a enviar; aceptar crea un usuario del cliente (nunca de administración) o, si el correo ya es de un usuario de ese mismo cliente, le pone la contraseña elegida; nunca entra en una cuenta de la administración ni de otro cliente (se comprueba al crearlo y al aceptarlo); pasa la protección CSRF |
| Enlaces de configuración (`/api/public/setup/*`) | Quien tenga el enlace | Token de 256 bits, caducidad, 60 peticiones por minuto e IP. Se busca por su hash; la copia cifrada (para que solo la administración pueda volver a enviarlo) se borra al caducar o revocar |
| Formularios de contacto (`/forms/*`) | Visitantes de las webs permitidas | `Origin` en la lista del formulario, campo trampa, límites por IP y por formulario (cupo diario propio, separado del de la API), Turnstile opcional; destinatario fijo del cliente |
| Autoconfiguración (`/mail/…`, `/autodiscover/…`, `/.well-known/…`) | Programas de correo | Solo dominios de la instancia; sin datos de cuentas |
| Cambio de contraseña y perfil del webmail (`/api/webmail/*`) | Roundcube, por la red interna | Secreto compartido `MAILWAY_WEBMAIL_TOKEN`; sin él las rutas no existen. Las fotos solo entre buzones del mismo cliente |
| Fotos de buzones (`…/photo`) | Las mismas guardas que la ruta que las sirve | Solo JPEG, PNG o WebP comprobados por su firma (nunca SVG ni HTML), máximo 512 KB, servidas con `nosniff` y `Content-Security-Policy: default-src 'none'` |
| Rutas de Traefik (`/api/traefik/config`) | Traefik o el puente de Skyway | `X-Mailway-Token` comparado en tiempo constante |
| Motor (`mailway-mail`) | El panel y el webmail por red interna; programas de correo por 25/465/587/993/4190 | Contraseña de administración del motor, bloqueo automático de IPs, TLS |

## 3. Autenticación

### 3.1 Usuarios del panel

- Contraseñas con **scrypt** (N = 16384, sal aleatoria), de al menos 10
  caracteres.
- Sesión en la cookie `mailway_session` (`httpOnly`, `SameSite=Lax`,
  `Secure` en producción). En la base de datos solo está el hash HMAC del
  token. Duración: `MAILWAY_SESSION_TTL_HOURS` (7 días por defecto).
- Cambiar la contraseña cierra las demás sesiones del usuario.
- Límite de intentos: 8 fallos por IP y 10 por dirección de correo cada 10
  minutos (`429 rate_limited`). El contador por dirección es el que protege de
  verdad: la IP puede rotarse.
- Un correo inexistente, una contraseña incorrecta y un usuario deshabilitado
  reciben la misma respuesta: `401 bad_credentials`, «El correo electrónico o
  la contraseña no son correctos.».
- **Puesta en marcha**: con `MAILWAY_SETUP_TOKEN` (el instalador lo genera),
  crear el primer administrador exige ese token; así el primer visitante de un
  panel recién publicado no se queda con la instancia. Los intentos con un
  token incorrecto se limitan a 10 por IP cada 15 minutos (`429`).
- **Administrador desde el entorno**: `MAILWAY_ADMIN_PASSWORD` (con
  `MAILWAY_ADMIN_EMAIL`, o para el único administrador si falta) crea un
  administrador o fija su contraseña al arrancar (solo quien controla el
  entorno del panel). Mientras exista, es la contraseña de esa cuenta: vale
  al iniciar sesión aunque la de la base sea otra (se compara en tiempo
  constante, tras el límite de intentos, y la base se pone al día), el
  cambio desde el panel responde `409 password_managed_by_env` y
  `reset-password.js` se niega, para que la variable y el acceso no digan
  cosas distintas. Nunca modifica a un usuario que no sea administrador y la
  contraseña no se registra ni se anota en la Actividad. Quien la deja en las
  variables acepta que cualquiera con acceso a ellas (en Skyway, la
  administración de la plataforma) conoce esa contraseña.

### 3.2 Tokens de gestión

- `mwt_<prefijo>_<secreto de 256 bits>`; en la base de datos, solo el hash.
- Heredan los permisos de su usuario y se comprueban en **cada** petición:
  revocar el token, deshabilitar al usuario o cambiarle el rol surte efecto
  de inmediato.
- Un token **no puede** crear otros tokens, cambiar la contraseña del panel,
  conectar, cambiar o probar el motor de correo ni reiniciar la puesta en
  marcha de un cliente (`403 session_required`): un token filtrado no puede
  perpetuarse, dejar fuera al titular, desviar los secretos del motor (sección
  7) ni dejar de golpe sin correo los dispositivos de toda una empresa.
- Con `Authorization: Bearer` no se lee la cookie: una integración nunca
  actúa con la sesión de un navegador que comparta la petición.
- Caducidad opcional; máximo 25 activos por usuario; último uso (fecha e IP)
  visible en **Conexiones**.
- **Emparejado con Skyway** (`server/src/tools/emparejar.ts`): solo desde la
  terminal del servidor (`docker exec` en el contenedor del panel), sin
  ninguna ruta HTTP; quien la ejecuta ya es root en el servidor. Crea el token
  de administración «Skyway» sin caducidad y revoca antes los que hubiera
  activos con ese nombre de cualquier administrador (nunca los de un usuario
  de cliente), en una sola transacción. El token y, si la crea, la contraseña
  aleatoria del primer administrador solo salen por su salida estándar: no
  pasan por argumentos, registros ni auditoría, que anota cada paso como
  «Sistema» y sin secretos. El instalador pasa el token a Skyway por la
  entrada estándar y muestra la contraseña una sola vez.
- **Identidad del servidor desde el instalador**
  (`server/src/tools/identidad.ts`): también solo desde la terminal, tras un
  cambio de dominio o de IP que quien instala ha confirmado. Hace que Ajustes
  adopte los valores del entorno del panel (nombre del servidor, URL del
  webmail y del panel, IP) aunque se hubieran cambiado a mano; nada más.
  Sin confirmación, el panel solo adopta lo que nadie ha cambiado en Ajustes
  y avisa de lo demás (`modules/entorno.ts`). Su salida (nombres, URL e IP)
  no lleva secretos.

### 3.3 Claves de API

`mw_<prefijo>_<secreto>`; solo el hash en la base de datos; comparación en
tiempo constante; revocación inmediata (también se cierra su conexión SMTP y
se retira su credencial del motor). Solo valen en `/v1/send`.

- **Adjuntos**: lista cerrada de tipos (PDF, calendario, imágenes, texto,
  CSV, JSON y documentos de Office u OpenDocument), con la extensión del
  nombre comprobada contra el tipo y el contenido contra su firma: un
  ejecutable no sale etiquetado como PDF ni como `factura.pdf.exe`. El nombre
  se sanea (sin rutas, controles ni marcas de dirección como U+202E). Máximo
  5 adjuntos y 10 MB decodificados; la petición, 20 MB.
- **Idempotency-Key**: se guarda por clave de API, solo su hash, durante
  24 horas. Una clave nunca ve ni reutiliza la respuesta guardada de otra.

### 3.4 Titulares de buzones

- La contraseña se comprueba **en el panel**, contra su propia copia del hash
  `$6$` de la contraseña principal, nunca pidiéndole al motor que autentique
  (sección 7). El panel calcula ese hash una sola vez, al dar de alta el buzón
  o cambiar su contraseña, y es el mismo que recibe el motor; la contraseña en
  claro no se guarda. Los buzones anteriores a la copia toman el hash de
  Stalwart 0.15 la primera vez que se comprueba su contraseña, al arrancar el
  panel, en el vigilante y con `motor.js capturar` antes de actualizar el
  motor. Sin copia y con un motor que ya no la da (0.16), la respuesta es
  `409 password_unverifiable`: hay que restablecer la contraseña del buzón.
- La suspensión que cuenta es la del panel (el buzón o su cliente): un buzón
  suspendido no entra en «Mi buzón» aunque el motor lo tenga activo (tras
  actualizar a 0.16, hasta que `motor.js provisionar` lo vuelve a suspender en
  él).
- 5 fallos por buzón y 20 por IP cada 15 minutos; los contadores sobreviven a
  un reinicio.
- La misma respuesta (`401 bad_credentials`, «La dirección de correo o la
  contraseña no son correctas.») para una dirección inexistente y para una
  contraseña incorrecta: no se revela qué direcciones existen. La web muestra
  en ambas pantallas de acceso (panel y «Mi buzón») el mismo texto, «El correo
  electrónico o la contraseña no son correctos.».
- Una **contraseña de aplicación** no sirve para entrar en «Mi buzón» ni para
  cambiar la contraseña principal: quien encuentre un móvil perdido no puede
  adueñarse del buzón. El panel las reconoce por un verificador irreversible
  (sección 6), también las que dejaron de funcionar al actualizar el motor.
- Máximo de **25 contraseñas de aplicación activas** por buzón, con la misma
  respuesta (`409 app_password_limit`) en el panel, en «Mi buzón» y en las
  integraciones: cada una es una puerta más al buzón, y decenas suelen indicar
  que no se revocan las antiguas. Las invalidadas por una actualización del
  motor ya no abren nada y no cuentan.
- Cambiar la contraseña cierra las demás sesiones de «Mi buzón» y borra la
  contraseña guardada en los enlaces de configuración.
- Suspender el buzón o su cliente corta las sesiones abiertas del portal.

## 4. Autorización y aislamiento entre clientes

- Cada ruta declara su nivel: `requireAuth`, `requireAdmin`,
  `requireClientAccess(clientId)`, `requireSession` o `requireAdminSession`
  (cambiar la conexión con el motor y reiniciar la puesta en marcha de un
  cliente: sesión de administración, nunca un token). Un usuario de cliente
  recibe `403` al pedir un recurso de otro cliente, exista o no, sin poder
  enumerar identificadores.
- **Propiedad de los dominios**: nadie crea buzones ni alias en un dominio sin
  probar que es suyo (MX hacia el servidor o TXT `_mailway.<dominio>` =
  `mailway-verificacion=<token>`; si no, `409 domain_ownership_pending`). Se
  aplica también a la administración y a los tokens. Una zona de Cloudflare solo
  prueba la propiedad si está activa: cualquiera puede añadir un dominio ajeno
  a su cuenta de Cloudflare, pero no activarlo. La única excepción es el modo
  demostración: solo con `MAILWAY_DEMO=1` (no con el motor «demo» elegido en
  el asistente, que puede pasar a Stalwart sin reiniciar), quien tiene acceso
  al cliente puede simular la propiedad; queda anotada y, al arrancar sin
  `MAILWAY_DEMO`, vuelve a quedar pendiente, así que un motor real nunca
  hereda un dominio ajeno dado por comprobado.
- **Un dominio dado de alta existe en el motor**, también sin la propiedad
  comprobada: con Stalwart 0.16 sus claves DKIM y los registros que hay que
  publicar solo existen así. Para Stalwart, un dominio que existe es local
  para todo el servidor (rechaza con «550 Mailbox does not exist» cualquier
  dirección que no tenga y entrega en local las demás), así que dar de alta
  gmail.com (o el dominio de otro cliente) afectaría al correo que los demás
  clientes del servidor le envían. Lo limitan la propiedad, que se exige para
  cualquier buzón o alias, y, con la 0.15, la recepción en otro proveedor
  (siguiente punto), que devuelve ese correo a su MX en cuanto se mide. Está
  en los límites conocidos de `docs/PLAN.md`; la rama del cambio de dominio
  lo retrasaba hasta el primer buzón, pero solo funcionaba con la 0.15.
- **Dominios con el correo en otro proveedor**: aunque el dominio tenga buzones
  aquí, mientras su MX público apunte a otro servidor, lo que se envía desde
  este servidor a sus direcciones sale por ese MX y no se entrega en local
  (véase «Recepción en otro proveedor» en `INTEGRACIONES.md`). Así, preparar
  un traslado o tener solo el envío en Mailway no desvía el correo que se
  envía desde aquí. Límite conocido: el correo de Internet que llega a un
  alias de otro dominio de este servidor y reenvía a un buzón de ese dominio
  se entrega en el buzón de aquí (Stalwart no distingue en la cola un
  destinatario que viene de un alias); el formulario de alias lo avisa.
- **Marca blanca y cambios de IP**: la comprobación del DNS de un dominio
  propio acepta un CNAME al servidor de correo o un A a una IP del servidor
  (la de Ajustes o las del nombre del servidor de correo). Ampliarla no abre
  nada: quién puede dar de alta un nombre lo decide la regla de propiedad.
- **Destinos de alias**: solo buzones del mismo cliente o direcciones
  externas; una dirección de un dominio de la instancia que no existe se
  rechaza en lugar de salir a Internet. Solo cuenta como dominio de la
  instancia uno con la propiedad comprobada: si alguien da de alta gmail.com
  (o el dominio de otro) sin probarla, sus direcciones siguen siendo destinos
  externos para todos los clientes, y borrarlo después no quita esos
  reenvíos de ningún alias (solo se retiran los destinos que eran buzones
  del dominio borrado).
- **Remitente de las claves**: siempre un buzón del mismo cliente; el `From`
  no se puede cambiar.
- **Correo de configuración** (`POST /api/mailboxes/:id/setup-email`): solo
  para un buzón del propio cliente, activo, de un cliente no suspendido
  (`403 client_suspended`, como la API de envío) y de un dominio con la
  propiedad comprobada. Sale de `configuration@<dominio>`, una cuenta oculta
  del motor por dominio que no es un buzón del cliente: no aparece en los
  listados ni cuenta para el plan, no entra en «Mi buzón» y su contraseña
  (aleatoria, de 32 caracteres) solo la conoce el panel y no se devuelve
  nunca. La parte local `configuration` está reservada: nadie, tampoco la
  administración, crea un buzón ni un alias con ella (`400 reserved_address`),
  y ningún alias puede reenviar a la cuenta oculta (no es un buzón). Si ya
  existe un buzón o alias `configuration@` anterior a la reserva, no se envía
  (`409 configuration_sender_taken`): enviar desde él sería suplantarlo.
  Límites: 5 por buzón y 50 por cliente cada hora, contando también los
  fallidos (`429 too_many_setup_emails`). La contraseña del titular solo
  cambia cuando no queda otra: se reutiliza el enlace vigente (más de 24 horas
  de validez, recuperable y con la contraseña si se pide); si se pide sin
  contraseña, nunca se envía un enlace que la lleve; y si hay que generar una,
  se hace después de comprobar el remitente, para que un error previo al envío
  no deje al titular sin acceso. La respuesta, el registro de envíos y la
  actividad (`mailbox.setup_email_sent` / `_failed`) nunca llevan la URL, el
  token ni la contraseña; solo la dirección de destino.
- **Reiniciar la puesta en marcha** (`POST /api/clients/:id/onboarding-reset`):
  solo la administración con sesión del panel (`requireAdminSession`); ni el
  propio cliente ni un token de gestión, tampoco el de administración. Recorre
  solo los buzones de los dominios de ese cliente y salta los suspendidos.
  Las contraseñas nuevas no se devuelven, no se guardan en ningún enlace y no
  aparecen en la actividad (`client.onboarding_reset`, una sola anotación con
  los recuentos). Los errores inesperados del motor no se devuelven tal cual.
- **Enlace de bienvenida para un usuario que ya existe**: solo si es un
  usuario (rol `client`) del mismo cliente, comparando el correo sin
  distinguir mayúsculas; aceptarlo equivale a un restablecimiento de la
  administración (contraseña nueva, cuenta habilitada, demás sesiones
  cerradas). El correo de la administración o de otro cliente se rechaza al
  crear el enlace y, otra vez, al aceptarlo (`409 user_exists`, sin sesión y
  con el enlace aún pendiente), por si ha cambiado de manos entretanto. No da
  a la administración nada que no tuviera: ya podía restablecer esa
  contraseña.
- **Formularios de contacto**: el buzón destinatario es del mismo cliente y de
  un dominio con la propiedad comprobada (también para la administración); un
  cliente no ve, edita ni elimina los formularios de otro.
- **Marca blanca**: solo subdominios de un dominio de correo del mismo cliente
  con la propiedad comprobada (no basta con que esté activo), sin prefijos
  reservados ni nombres de la instancia.
- **Cloudflare**: un cliente solo usa sus cuentas; las de la instancia (el
  token del operador, también la que deja el instalador), solo la
  administración. Ni siquiera una cuenta de la instancia que la administración
  dejó asociada al dominio al aplicar su DNS sirve después al cliente: si
  sirviera, le bastaría con dar de alta un subdominio de una zona del operador,
  esperar a que la administración aplicara su DNS una vez y, desde entonces,
  reescribir esa zona (con `replaceConflicts`, incluso su MX). `soloCliente=1`
  fuerza esta regla aunque llegue un token de administración: en el plan y la
  aplicación del DNS de un dominio, en el alta con `autoDns: true`, en el DNS
  de un dominio de marca blanca y en el listado, la conexión y el borrado de
  cuentas; las rutas que solo trabajan con la cuenta de la instancia (DNS de
  la plataforma y certificado del motor) responden
  `403 cloudflare_instance_admin_only`.
  **Única excepción: el registro del dominio de marca blanca.** Para él vale
  la cuenta con la que se aplicó el DNS del dominio de correo del que cuelga,
  aunque sea de la instancia y actúe el cliente (o Skyway con
  `soloCliente=1`). No abre ninguna zona nueva: la administración ya escribió
  en ella para ese mismo dominio del mismo cliente, el nombre es un subdominio
  suyo con la propiedad comprobada, el registro tiene un valor fijo (CNAME al
  servidor de correo o A a su IP) y con esa cuenta nunca se reemplaza lo que
  haya, ni pidiéndolo (`replaceConflicts` se ignora). Una zona del operador
  cuyo DNS no aplicó la administración para ese cliente sigue cerrada.
- **Webmail detrás del proxy de Cloudflare**: el registro del webmail de
  marca blanca se crea con proxy. Como el DNS público devuelve entonces IP de
  Cloudflare, la comprobación pregunta a Cloudflare (con la misma cuenta, solo
  lectura) si el registro apunta de verdad a este servidor; sin una cuenta que
  vea la zona, el dominio no se publica en Traefik. El webmail solo toma la IP
  del visitante de `CF-Connecting-IP` cuando quien conectó con Traefik es una
  IP de Cloudflare: el servidor tiene la IP pública y cualquiera podría enviar
  esa cabecera directamente. Queda el límite habitual de fiarse de los rangos
  de Cloudflare: quien consiga llegar desde una IP de Cloudflare (un Worker u
  otra zona de Cloudflare apuntada al servidor) puede elegir esa IP. Solo
  cambia la IP anotada en la sesión y en los registros; no da acceso a nada.
- **Dominios en zonas del operador**: si la administración escribió el DNS de
  un dominio con una cuenta de la instancia, sus registros (MX, TXT de
  verificación) siguen en la zona del operador aunque el dominio se borre, y
  probarían la propiedad a cualquiera que lo diera de alta. El dominio queda
  reservado al cliente para el que se escribió (`cloudflare_reservas`): otro
  cliente, o Skyway con `soloCliente=1`, recibe `409 domain_reserved`. Solo la
  administración (sin `soloCliente`) puede darlo de alta para otro cliente, y
  entonces la reserva pasa a ese cliente. Al actualizar desde la 1.0, que ya
  escribía en esas zonas sin reservar nada, la migración
  `008-reservas-de-cloudflare` reserva a su cliente los dominios que siguen en
  la base con el DNS aplicado con una cuenta de la instancia, o con una cuenta
  ya desconectada (no se sabe si era la del operador). Los dominios borrados
  antes de actualizar no se pueden reconstruir: sus registros siguen en la
  zona y nada impide a otro cliente darlos de alta. Para cerrarlo, busca en
  las zonas del operador los registros que la 1.0 marcó con el comentario
  `Mailway` (MX y TXT `_mailway.`) de dominios que ya no estén en el panel, y
  bórralos.
- **El alta automática solo crea** (`autoDns`, y el registro del webmail de
  marca blanca al darlo de alta o al comprobarlo): no modifica ni borra ningún
  registro existente, ni para activarle el proxy; las actualizaciones (SPF, proxy, registros propios) solo
  las aplica «Aplicar» tras revisar el plan, y solo sobre registros con el
  comentario exacto de esta instancia.
- **Lo que el cliente no ve de la administración**: las notas internas del
  cliente (`notes`: acuerdos, incidencias, precios) solo las recibe la
  administración, y en **Actividad** no ve el correo ni la IP de quien
  administra (el campo `ip` llega vacío), ni tampoco la IP de un usuario que
  ya no existe, que podía serlo. Sí ve las IP de sus propios usuarios y de los
  titulares de sus buzones.
- **Límites del plan** en el servidor, con las altas de cada cliente en fila
  (`core/locks.ts`): ni las peticiones simultáneas superan el plan. Los envíos
  por API se cuentan por cliente, sumando todas sus claves.
- **Skyway** trabaja con un token de administración, así que el aislamiento
  entre proyectos lo impone Skyway: comprueba cada dominio y buzón contra el
  resumen del cliente vinculado antes de actuar.

## 5. CSRF e IP real

- Las peticiones mutantes (`POST`, `PUT`, `PATCH`, `DELETE`) a `/api/` que
  llegan con cookie y que el navegador marca como de otro sitio
  (`Sec-Fetch-Site`, o `Origin` distinto del host) se rechazan con
  `403 cross_site_request`. `SameSite=Lax` no basta cuando otra aplicación
  del mismo servidor comparte sitio. Quedan fuera las peticiones con
  `Authorization`, las rutas públicas y la del webmail, que no usan la cookie
  del panel.
- `MAILWAY_TRUST_PROXY` (por defecto `1`: un salto, el Traefik) decide qué
  parte de `X-Forwarded-For` se cree. Con `true`, cualquiera podría elegir su
  IP en cada intento y esquivar los límites. Cámbialo solo si hay más proxies
  delante.
- Con un número de saltos se da por bueno lo que diga quien conecta con el
  panel, sea cual sea su IP: su `X-Forwarded-For` y también
  `X-Forwarded-Proto` y `X-Forwarded-Host`, de donde sale la URL pública
  cuando no está configurada. Por eso el puerto del panel no se expone fuera
  de Traefik: con Skyway no se publica y el despliegue autónomo lo publica en
  `127.0.0.1`. Si tuviera que quedar accesible desde fuera, indica en su lugar
  la IP o la red del proxy (`MAILWAY_TRUST_PROXY=172.18.0.0/16`, p. ej.): así
  esas cabeceras solo valen cuando llegan de él.

## 6. Secretos

- **Clave maestra** (`MAILWAY_SECRET` o `/data/.secret`): firma sesiones, cifra
  secretos y deriva los tokens de verificación de propiedad. **No la cambies**
  en una instalación en uso: invalidaría sesiones, tokens de gestión, claves de
  API, enlaces, los secretos cifrados y los TXT de verificación.
- **Cifrado en reposo** (AES-256-GCM) de lo que hay que recuperar: contraseña
  del motor, tokens de Cloudflare, credencial SMTP de cada clave de API y de
  cada formulario, secreto de Turnstile de un formulario, contraseña opcional
  de un enlace de configuración, contraseña de la cuenta remitente
  `configuration@` de cada dominio.
- **Copia del hash `$6$`** (sha512-crypt) de la contraseña principal de cada
  buzón (`credenciales_buzon`), cifrada además con la clave maestra: una copia
  de la base de datos sin esa clave no sirve para atacar los hashes sin
  conexión. Si la clave cambia, la copia deja de poder leerse y se vuelve a
  tomar del motor (0.15) o hay que restablecer la contraseña.
- **Verificador `$6$`** de cada contraseña de aplicación (irreversible), solo
  para reconocerla y rechazarla donde hace falta la principal. No permite
  recuperarla: las contraseñas de aplicación, como las demás, se muestran una
  sola vez.
- **Solo hash** (HMAC-SHA256 con la clave maestra) de lo que no hay que
  recuperar: sesiones, tokens de gestión, claves de API, tokens de enlaces.
- Contraseñas, tokens y claves se devuelven **una sola vez**. Los bloques
  listos para copiar que acompañan a una clave de API o a una contraseña de
  aplicación viajan solo en esa respuesta (`Cache-Control: no-store`) y no se
  pueden regenerar; el secreto solo aparece en las líneas de `.env`. Los tokens de
  Cloudflare nunca se vuelven a mostrar (solo sus últimos caracteres). La
  contraseña del motor no sale del servidor: el asistente conecta el motor del
  entorno sin enviarla al navegador, y los mensajes de error se depuran de
  ella. Para cambiar la URL, el usuario o el servidor SMTP del motor hay que
  escribirla de nuevo (sección 7).
- La actividad nunca guarda secretos; las acciones hechas con un token llevan
  su nombre (`via: token:<nombre>`).
- `deploy/.env` contiene todos los secretos del despliegue: permisos 600 y
  copia de seguridad cifrada. Con Bulwark, también sus dos secretos (sección
  7, «Bulwark»).

## 7. El motor de correo

- **API de gestión**: el puerto 8080 no se publica en el host; el panel la usa
  por la red `skyway-edge` y el instalador por la red interna. Traefik publica
  la web del motor en `https://mail.<dominio>` a través de la pasarela del
  motor (más abajo), protegida por la contraseña de administración del motor:
  usa una larga y aleatoria (el instalador la genera). En la instalación
  autónoma sin proxy propio, lo publicado en `127.0.0.1:8080` también es la
  pasarela.
- **Conexión del panel con el motor**: conectarlo, cambiarlo o probarlo
  (`POST /api/setup/engine`, `PUT /api/settings/engine`,
  `POST /api/settings/engine/test`) exige la sesión de un administrador, no
  vale un token de gestión (`403 session_required`), y, si cambian la URL, el
  usuario o el servidor SMTP, escribir de nuevo la contraseña del motor
  (`400 engine_password_required`). Si bastara un token, uno filtrado podría
  hacer que el panel enviase la contraseña guardada, o las credenciales SMTP de
  las claves de API, a un servidor ajeno. La URL solo admite `http(s)` y sin
  usuario ni contraseña incrustados.
- **Versión del motor**: el panel averigua si habla con Stalwart 0.15 (API
  REST) o 0.16 (JMAP) preguntando al propio motor con su usuario de
  administración (`/jmap/session` y, si no anuncia la gestión de 0.16,
  `/api/principal`). Unas credenciales rechazadas dan
  `502 engine_auth_failed`, nunca se toman por otra versión.
- **Rutas desconocidas**: un HTTP 404 del motor se trata como un error
  (`engine_error`), nunca como «el elemento no existe»; si no, los borrados
  darían por buena una eliminación que el motor no ha hecho y los buzones
  seguirían recibiendo correo. Antes, el panel vuelve a averiguar la versión
  (el motor puede haberse actualizado con el panel en marcha) y repite la
  operación una sola vez, y solo si la versión ha cambiado: así no se repite
  una escritura que el mismo motor ya rechazó.
- **Bloqueo automático**: Stalwart bloquea para siempre una IP tras 100 fallos
  de autenticación al día y al instante ante rutas típicas de escáneres
  (`*.php`, `/wp-*`…). Por eso:
  - el panel **nunca** pide al motor que autentique contraseñas de titulares
    (portal, enlaces, webmail): las verifica en local, contra su copia del
    hash (sección 3.4). Hasta Stalwart 0.15 bastaba con leer el hash del
    motor, pero 0.16 lo devuelve enmascarado; la copia evita volver a
    autenticar contra el motor, que con unos cuantos errores tecleando
    bloquearía la IP del webmail o del proxy para todos y serviría de oráculo
    de contraseñas sin el límite de intentos del panel. Con 0.15, si la copia
    no coincide con lo que guarda el motor (un cambio hecho fuera del panel),
    se vuelve a leer del motor; con 0.16, los ajustes recomendados quitan a
    los usuarios del motor el autoservicio de contraseñas, contraseñas de
    aplicación y claves de API, para que nadie las cambie fuera del panel, y
    Ajustes comprueba que siga así;
  - el motor exime de su bloqueo **solo** la red interna `mailway-internal`
    (`10.203.53.0/24`), por la que llega el webmail, cuyos usuarios comparten
    IP. La red del proxy no se exime: por ella entra Internet;
  - `http.use-x-forwarded=true` hace que el motor vea la IP real de quien llega
    por Traefik, en lugar de bloquear la IP de Traefik para todos. Stalwart
    toma la **primera** dirección de `X-Forwarded-For` (y antes, la de
    `Forwarded: for=`), que es la que escribe el cliente si nadie la
    sustituye: por eso el motor no recibe nunca esas cabeceras tal como
    llegan (los dos puntos siguientes);
  - **la pasarela del motor** (`mailway-mail-gw`, nginx, `deploy/motor/pasarela`,
    con las dos series del motor) se pone entre Traefik y todas las rutas HTTP
    del motor: el servicio de Traefik del motor apunta a ella
    (`loadbalancer.server.url`), no al motor. Calcula la IP real como la
    pasarela de Bulwark (tabla de abajo) y entrega al motor **una sola**
    dirección en `X-Forwarded-For` y en `X-Real-IP`, sin `Forwarded`,
    `CF-Connecting-IP` ni `True-Client-IP`. Así el motor ve la IP real aunque
    Traefik conserve la cabecera que trae la petición, que es lo que hace si
    confía en los rangos de Cloudflare (`forwardedHeaders.trustedIPs`, para
    que las aplicaciones de Skyway vean al visitante): sin la pasarela, una
    petición enviada a través de Cloudflare con
    `X-Forwarded-For: <IP de la red interna>` se hacía pasar por la red exenta
    y podía probar contraseñas sin límite (`deploy/prueba-pasarela.sh` lo
    reproduce sin la pasarela y comprueba que con ella el motor bloquea la IP
    real, con un Traefik que confía en Cloudflare y otro que no). Solo está
    en la red de Traefik: nunca entra al motor por la red exenta. Todo lo
    demás pasa tal cual (rutas, DAV, subidas de JMAP sin tope propio, el push
    por EventSource y WebSocket); solo anota las respuestas de error, con la
    IP real y sin la cadena de consulta ni cabeceras;

    | Petición que llega de Traefik | IP para el motor |
    |---|---|
    | Último salto ajeno a Cloudflare | ese salto (lo escribe Traefik) |
    | Último salto de Cloudflare con un salto anterior (Traefik con `trustedIPs`) | el salto anterior (lo añade Cloudflare); nada de su izquierda |
    | Último salto de Cloudflare, sin salto anterior (Traefik de Skyway) | `CF-Connecting-IP` |
    | Último salto de Cloudflare sin datos del visitante | el nodo de Cloudflare |
    | Conexión desde fuera de las redes de Docker | la suya, sin creer cabeceras |

    Queda el límite habitual de fiarse de los rangos de Cloudflare: quien
    llegue desde una IP de Cloudflare (un Worker u otra zona apuntada al
    servidor) aparece con esa IP de Cloudflare, nunca con una de la red
    exenta;
  - Traefik **borra además la cabecera `Forwarded`** antes de llegar a la
    pasarela (middleware `mailway-mail-sin-forwarded`, en
    `deploy/motor/*/compose.yml`, encadenado en cada router del motor), como
    defensa en profundidad: Traefik solo reescribe las `X-Forwarded-*`. La CI
    comprueba que el middleware sigue en cada router y que el servicio del
    motor es la pasarela, con los dos motores.
- **Compromiso conocido**: con `http.use-x-forwarded=true`, un contenedor
  conectado a `skyway-edge` podría falsear `X-Forwarded-For` al hablar
  directamente con `mailway-mail:8080` (el panel llega al motor por esa red),
  o con la pasarela, que trata como Traefik a cualquier contenedor de las
  redes de Docker. La mejora prevista es una red dedicada entre Traefik, la
  pasarela y Stalwart.
- **TLS**: IMAP y SMTP con certificado de Let's Encrypt (ACME del motor, solo
  con 0.15, o certificado de Traefik copiado por el extractor del perfil
  `tls`, que solo lleva al volumen del motor el par del servidor de correo,
  nunca las claves de otros dominios). El vigilante avisa si caduca, es
  autofirmado o no corresponde al nombre. La API de envío verifica el
  certificado del SMTP interno contra el nombre público;
  `MAILWAY_SMTP_ALLOW_SELF_SIGNED=1` solo debe usarse mientras no hay
  certificado.
- La autenticación en claro solo se admite sobre TLS (IMAP, SMTP de envío,
  ManageSieve).
- **Actualización del motor (0.15 → 0.16)**: se hace desde la terminal del
  servidor (`motor.js`, [INTEGRACIONES.md, sección 2.10](INTEGRACIONES.md#210-actualización-del-motor-stalwart-015--016)),
  con el **modo mantenimiento** activo: el panel, «Mi buzón» y las
  integraciones no pueden escribir en un motor a medio migrar
  (`503 engine_maintenance`) y el vigilante no lo da por caído. Solo se
  activa desde la terminal (ninguna ruta HTTP lo hace: un token de gestión no
  puede bloquear el panel) y caduca solo, como mucho a las 24 horas. Lo que la
  migración no conserva se resuelve sin exponer secretos:
  - las suspensiones: los buzones suspendidos vuelven activos en 0.16 hasta
    que `motor.js provisionar` los suspende de nuevo a partir de la base del
    panel, que es la fuente de verdad. Entre el arranque del motor nuevo y la
    provisión, un buzón suspendido podría entrar por IMAP o SMTP; la provisión
    informa de los que no ha podido volver a suspender;
  - las contraseñas de aplicación de 0.15 dejan de funcionar: se marcan como
    invalidadas (ya no cuentan ni se ofrecen como activas), se avisa a la
    administración y a cada titular, y se revocan sin llamar al motor;
  - las credenciales SMTP internas de las claves de API y de los formularios
    se renuevan en el motor nuevo y se guardan cifradas, como antes;
  - al volver a la 0.15 (`mailway revertir-motor`), las contraseñas de
    aplicación de la 0.15 que el motor todavía tiene vuelven a valer, y las
    creadas en la 0.16 se marcan como invalidadas: no existen en la 0.15.

### Stalwart 0.16 y el cambio de motor

- **Credencial del motor 0.16.** `STALWART_RECOVERY_ADMIN=admin:<STALWART_ADMIN_PASSWORD>`
  en el entorno de `mailway-mail` es la credencial de administración
  permanente del motor: la 0.16 la acepta en cada arranque, también fuera del
  modo de recuperación. Quien lea `deploy/.env` (600, root) o
  `docker inspect mailway-mail` (root o grupo `docker`) la tiene. Para
  cambiarla: `deploy/.env` y las variables del panel, y recrear el motor. La
  cuenta `admin@<servidor>` que crea el primer arranque (todos los permisos,
  contraseña que nadie guarda) se borra en cuanto el motor arranca, si es la
  única cuenta.
- **`mail.<dominio>` con la 0.16.** Traefik solo deja pasar una lista de rutas
  (`/jmap`, `/.well-known/`, `/dav/`, autoconfiguración de Thunderbird y
  Outlook, `/healthz/`, `/robots.txt`); todo lo demás (administración
  `/admin`, autoservicio `/account`, `/login`, `/api/…` y lo que añada un
  parche) responde 403 con un router de prioridad mínima y una lista de IP que
  solo admite 127.0.0.1. `/jmap` queda abierto a los titulares: lo que pueden
  hacer con los objetos de gestión (`x:…`) depende de los permisos de su rol,
  de los que el panel retira el autoservicio. La cabecera `Forwarded` se borra
  en los tres routers.
- **Suspensión en 0.16.** Se quita el permiso `authenticate`, que el motor
  exige con cualquier credencial: contraseña, contraseña de aplicación, token
  OAuth o clave de API (no hay un permiso aparte para OAuth, como en la 0.15).
- **Migración (`mailway migrar-motor`).** Carpeta de trabajo
  `deploy/.migracion-motor/` (700). El volcado y el plan llevan hashes de
  contraseñas, claves privadas DKIM y secretos de la 0.15: ficheros 600 que se
  borran al terminar, también si vuelve atrás (`MAILWAY_MIGRACION_CONSERVAR=1`
  los deja); el registro no lleva secretos (la prueba de la pila lo
  comprueba). La contraseña del motor llega al ayudante por la entrada
  estándar y al CLI de Stalwart por el entorno, nunca en los argumentos. El
  script oficial (`migrate_v016.py`) y sus dependencias se descargan de URL
  fijadas y se comprueba su sha256; se ejecutan con `python -I -B` en un
  contenedor efímero sin capacidades, sin privilegios nuevos, con el sistema
  de ficheros de solo lectura (salvo la carpeta de trabajo) y solo en
  `mailway-internal`.
- **Motores temporales.** Comparten la IP fija y el alias `mailway-mail` (red
  interna y de Traefik) pero no publican puertos ni llevan etiquetas de
  Traefik (`exposedbydefault=false`). El de recuperación solo escucha en el
  8080. Las suspensiones se vuelven a aplicar, por si el script oficial no las
  conserva, ANTES de abrir los puertos de correo.
- **Datos que se conservan.** El volumen de la 0.15 (correo, hashes y claves
  DKIM) sigue intacto tras migrar, como vuelta atrás, hasta
  `mailway retirar-motor-anterior` (que exige escribir su nombre). Los
  volúmenes de intentos que volvieron atrás también conservan datos: se
  listan, no se borran solos. Inclúyelos en la política de copias y de
  borrado.
- **Certificado con la 0.16.** El motor corre como el usuario 2000: el
  extractor escribe la clave privada con ese grupo y permisos 0640 (carpetas
  0750), para lo que conserva solo la capacidad `CHOWN`.

### Bulwark (correo web beta)

Bulwark es el correo web JMAP que el panel ofrece por cliente, opcional
(`sudo mailway bulwark on`, solo con Stalwart 0.16) y en beta. Detalle en
[deploy/bulwark/README.md](../deploy/bulwark/README.md) («Riesgos conocidos»).

- **Dos contenedores sin puertos publicados**: Bulwark (en la red interna y en
  la de Traefik) y su pasarela (nginx, solo en la de Traefik), los dos con la
  raíz en solo lectura, sin capacidades y sin privilegios nuevos. Traefik
  solo llega a la pasarela, con los nombres que publica el panel; la API de
  administración de Bulwark (el panel la usa directamente, sin la pasarela)
  da 404 por la pasarela, igual que su asistente, la suplantación con JWT, el paso a los
  métodos `x:` del motor y las acciones de servidor de Next.js. Otro
  contenedor de la red de Traefik sí llega a Bulwark directamente: su
  administración la protege `ADMIN_PASSWORD` (5 intentos por IP y 50 en total
  cada 15 minutos).
- **CORS global del motor**: el navegador habla JMAP con el motor desde
  `webmail.<dominio>`, otro origen, así que el motor responde
  `Access-Control-Allow-Origin: *` (`Http.usePermissiveCors`) para todos los
  orígenes, **sin** `Access-Control-Allow-Credentials`: ninguna cookie viaja
  a otro origen y JMAP se autentica con la cabecera `Authorization` (el riesgo
  es el de cualquier cliente JMAP en el navegador). El panel lo abre **solo
  mientras algún cliente usa Bulwark** y lo cierra cuando el último vuelve a
  Roundcube. Si se quitan las variables de Bulwark con el CORS abierto
  (`sudo mailway bulwark off`), sigue abierto hasta volver a aplicar los
  ajustes recomendados: Ajustes → Servidor de correo lo muestra pendiente.
- **Red exenta**: Bulwark comprueba las contraseñas desde el servidor (antes
  del acceso y al crear su sesión) contra `https://MAIL_HOSTNAME`, que en su
  contenedor apunta a la IP interna del motor (`extra_hosts`) y a su 443 con
  el certificado de `MAIL_HOSTNAME`. Esas comprobaciones salen de la red
  exenta: el motor no bloquea a Bulwark ni cuenta esos fallos para el buzón.
  Los límites son entonces los de Bulwark y su pasarela; los del navegador
  (JMAP directo, por la pasarela del motor) sí cuentan, con la IP real.
- **Oráculo de contraseñas y su límite**: `/api/auth/stalwart-context` y
  `/api/auth/session` responden 200 o 401 a cada contraseña sin ningún límite
  propio en Bulwark 1.13 (el ensayo lo comprueba: 40 de 40). La pasarela de
  Bulwark lo frena: 20 comprobaciones por minuto y ráfagas de 40 por IP real
  (calculada como la del motor), y 180 por minuto en toda la instancia, solo
  en `POST` y `PUT` de `/api/auth/*`.
- **Cabeceras de IP**: la pasarela de Bulwark entrega una sola IP real y
  retira `Forwarded`, `CF-Connecting-IP` y `True-Client-IP`; la del motor
  hace lo mismo con el JMAP del navegador.
- **Caducidad del bloqueo**: con Bulwark, los usuarios llegan al motor desde
  su IP real, y una pestaña abierta tras cambiar la contraseña reintenta con
  la anterior (hasta unos 30 fallos por minuto en el ensayo). El panel fija
  en todas las instalaciones con la 0.16 un bloqueo por fallos que caduca a la
  **hora** (`Security.authBanPeriod`), y «Mi buzón» avisa de cerrar el correo
  web abierto tras cambiar la contraseña. En las instalaciones 0.16 que ya
  existían, Ajustes lo muestra pendiente hasta volver a aplicar los ajustes
  recomendados; `--comprobar` lo avisa con Bulwark activo.
- **Secretos**: `BULWARK_SESSION_SECRET` (64 caracteres hexadecimales) cifra
  las cookies de sesión, que llevan dentro la contraseña del buzón, y los
  ajustes sincronizados de los usuarios: quien tenga el secreto y una cookie
  robada recupera la contraseña. `BULWARK_ADMIN_PASSWORD` abre la
  administración de Bulwark (marca y política de toda la instancia); en el
  panel es `MAILWAY_BULWARK_ADMIN_PASSWORD` y solo vive en su entorno, nunca
  en la base de datos, los registros ni la actividad. Los dos los genera el
  instalador una vez, en `deploy/.env` (600); nunca se muestran. Desactivar
  Bulwark los conserva; rotar el de sesión cierra las sesiones y deja
  ilegibles los ajustes sincronizados.
- **Imágenes de la marca de cada cliente**: el panel solo acepta PNG, JPEG y
  WebP, reconocidos por su contenido (nunca por el tipo declarado ni la
  extensión), de hasta 512 KB y entre 16 y 4096 píxeles de lado, y las sube a
  Bulwark con un nombre que sale de su contenido. Ni SVG ni HTML: se servirían
  como código desde el origen del correo web.
- **Peticiones a terceros**: sin telemetría, comprobación de versiones,
  conectores ni indexación (`bulwark.env`). La pasarela corta `/api/favicon`
  (el servidor pediría el icono de cada dominio que escribe a un buzón: el
  remitente sabría cuándo se lee su correo) y `/api/translate` (MyMemory).
  Quien activa las notificaciones del navegador las recibe por el relé de
  notificaciones de Bulwark (`notifications.relay.bulwarkmail.org`), que ve la
  suscripción y los identificadores de lo que cambia, no el contenido; con
  uno propio (`pushRelayUrl` de la política), no.
- **Licencia AGPL-3.0**: la imagen se usa sin modificar y solo se configura;
  cualquier parche obligaría a ofrecer su código a los usuarios
  (`SOURCE_CODE_URL`).
- **Madurez**: versiones semanales y avisos de seguridad recientes; la
  contraseña del buzón está en la memoria de la pestaña (un XSS la expondría;
  la CSP con nonce y el correo HTML aislado lo mitigan). Por eso Dependabot
  solo propone sus parches y no se fusionan solos (sección 11).

## 8. Rutas públicas

- **Autodiscover** responde siempre `200` y **nunca lee** la cabecera
  `Authorization`, en la que Thunderbird envía la contraseña real; las rutas
  públicas registran a nivel de aviso para no dejar direcciones en los
  registros.
- **Enlaces de configuración**: token de 256 bits (solo el hash en la base de
  datos), caducidad de 1 a 720 horas, revocables, respuestas sin caché. La
  contraseña inicial, si se incluye, va cifrada y se borra en cuanto deja de
  hacer falta. Al crear un enlace con contraseña, esta se comprueba antes de
  guardarla y debe ser la principal; como esa comprobación podría servir para
  probar contraseñas, cada fallo cuenta por buzón: con 5 en 15 minutos la ruta
  responde `429 rate_limited` (también con la contraseña correcta) y, si el
  motor no responde, `503 engine_unreachable` sin crear el enlace.
- **Autoconfiguración y MTA-STS**: solo responden para dominios dados de alta
  y no incluyen datos de las cuentas.
- **Formularios de contacto** (`POST /forms/:clave`): la clave `mwf_…` es
  pública. La cabecera `Origin` debe estar en la lista del formulario (solo
  `https://`); es lo único que responde con CORS, y solo para ese origen. El
  `Origin` frena a otras webs en un navegador, no a un script que lo falsee:
  contra eso están el campo trampa, los límites (5 envíos por IP cada 10
  minutos, 30 por formulario y hora, 200 por formulario y día y 60 peticiones
  por minuto e IP), Turnstile con el `hostname` comprobado y, sobre todo, que
  el destinatario es siempre el buzón del propio cliente: no sirve para enviar
  correo a terceros. El cupo diario de los formularios es **propio y separado
  del de la API del plan**: si lo compartieran, quien falsee el `Origin`
  podría agotarlo y dejar al cliente sin `/v1/send` (códigos de un solo uso,
  recuperación de contraseña) hasta medianoche UTC. Cada envío guarda su
  origen (`messages.source`), así que eliminar un formulario atacado tampoco
  pasa sus mensajes al cupo de la API. El mensaje sale con el remitente del buzón (nunca con la
  dirección del visitante, que va saneada en `Reply-To`), en texto plano y con
  el asunto que fija el formulario, así que el visitante no puede inyectar
  cabeceras ni HTML. Envíos de 32 KB como máximo; el widget envía sin cookies
  (`credentials: 'omit'`). Ni la ruta ni la actividad registran lo que escribe
  el visitante.
- **Estado de la puesta en marcha** (`GET /api/setup/status`): sin sesión y con
  la puesta en marcha terminada, solo devuelve `setupComplete`, `hasAdmin`,
  `requiresSetupToken` e `instance.brandName`; ni la IP pública, ni los nombres
  internos, ni la URL del motor. El detalle completo es para la administración
  (y para el asistente mientras no ha terminado); la contraseña del motor y el
  token de puesta en marcha no se devuelven nunca.

## 9. Traefik y otras aplicaciones del servidor

- Mailway solo publica en Traefik nombres cuyo DNS ya apunta al servidor
  (evita bloqueos de Let's Encrypt) y, en la marca blanca, solo subdominios de
  dominios de correo del mismo cliente con la propiedad comprobada.
- Con Skyway 0.34 o posterior, Traefik no consulta a Mailway sino al puente de
  Skyway, que solo deja pasar reglas `Host()` hacia contenedores de Mailway y
  nunca un dominio que ya sirve Skyway. Un Mailway comprometido no puede
  quedarse con el tráfico de otras aplicaciones.
- El token de Traefik solo se entrega a la administración
  (`/api/integrations/info`, `/api/whitelabel/setup`).
- Las rutas del nombre del servidor de correo (etiquetas del motor) llevan a
  la pasarela del motor, nunca al motor (sección 7). Los webmail de los
  clientes con Bulwark los publica el panel hacia su pasarela
  (`http://mailway-bulwark-gw:8080`), que el puente de Skyway admite como
  cualquier destino `mailway-*`.

## 10. Contenedor del panel

La imagen se ejecuta como el usuario `node` (no `root`) con `tini` como
proceso inicial. El punto de entrada solo usa `root` para asegurar que `/data`
pertenece a `node` tras actualizar desde imágenes antiguas.

Las herramientas de terminal se ejecutan también como `node`
(`docker exec -u node …`). Si `emparejar` se lanza como `root`, cede los
privilegios al dueño de `/data` antes de abrir la base de datos: un fichero de
SQLite creado por `root` dejaría al panel sin poder escribir en su base.

Los secretos llegan a las herramientas por la entrada estándar, nunca como
argumento (los procesos del contenedor se ven con `ps` desde el host). La de
Cloudflare (`tools/cloudflare.js conectar`, que usa el instalador para guardar
el token del operador como cuenta de la instancia) rechaza `--token` y
cualquier argumento que parezca un token antes de leer nada, no lee desde un
terminal, limita el tamaño de la entrada y no repite nunca lo recibido; el
token queda cifrado en la base y fuera de `deploy/.env` y de la actividad.

La de avisos (`tools/avisar.js`, que usa la actualización automática) no
recibe secretos: limpia los textos de colores y caracteres de control, los
acorta, no repite las opciones que no reconoce y nunca muestra las URL ni los
tokens de los canales.

## 11. Actualizaciones

Los parches de seguridad llegan solos, pero solo después de probarse:

- **Versiones exactas.** El `Dockerfile` y los compose fijan cada imagen con
  su versión completa (p. ej. `node:22.23.3-alpine`,
  `roundcube/roundcubemail:1.7.4-apache`, Stalwart `v0.15.5`): un `pull` o
  una reconstrucción nunca traen una versión que no haya pasado la CI.
- **Solo parches, y tras todas las comprobaciones.** Dependabot agrupa los
  parches (x.y.Z) de npm, de las imágenes y de las acciones.
  `.github/workflows/parches-automaticos.yml` fusiona uno solo si el PR es de
  Dependabot, sale de una rama de este repositorio hacia la principal, su
  último commit es de Dependabot y es exactamente el probado, todas sus
  dependencias suben solo un parche y han terminado bien todas las
  comprobaciones del commit: la CI, la imagen del panel construida y
  arrancada y, si cambian los compose, la pila de correo real. Las versiones
  menores y mayores, y Stalwart fuera de su serie, las revisa una persona.
  Bulwark solo recibe parches y en un PR propio que tampoco se fusiona solo:
  su pasarela bloquea solo las rutas que conoce, y cada versión pasa por la
  lista «Actualizar Bulwark» de `deploy/bulwark/README.md` (la CI ensaya la
  imagen nueva). nginx, la imagen de las dos pasarelas, se fusiona como las
  demás tras probar las dos con contenedores reales.
- **El workflow con permisos no ejecuta el código del PR.** Corre por
  `workflow_run` con la configuración de la rama principal y permiso de
  escritura, así que nunca hace checkout ni ejecuta nada del PR: solo consulta
  la API con `gh`, y lo que llega del evento pasa por variables de entorno,
  nunca dentro del script.
- **Vuelta atrás en el servidor.** `mailway update --auto` (activado con
  `sudo mailway auto-update on`) no hace nada si no hay versión nueva; si la
  hay, comprueba el servidor antes y después, y si falla vuelve al commit
  anterior y a sus imágenes. No toca los volúmenes ni restaura bases de datos
  (los parches de Stalwart no migran sus datos), no inicia sesión en ningún
  buzón y no prueba los puertos desde fuera (esas conexiones llegarían desde
  una IP sin exención y contarían para el bloqueo automático del motor). En
  el registro del sistema se tapan los secretos que el resumen del instalador
  muestra a quien instala a mano. Se niega a actualizar si hay cambios hechos
  a mano en la copia (volver atrás los borraría).

Detalle en la sección 8.1 de [DESPLIEGUE-SKYWAY.md](DESPLIEGUE-SKYWAY.md).

## 12. Cambio de dominio

El cambio de dominio de un cliente (dominio.es → dominio2.es,
[INTEGRACIONES.md](INTEGRACIONES.md), sección 10) separa el **usuario del
motor** de la dirección: Stalwart 0.15 solo autentica por el nombre del
principal y la 0.16 por la dirección de la cuenta (o un alias con la misma
parte local), así que durante la transición un buzón ya tiene la dirección
nueva y sigue entrando con su usuario anterior. Decisiones con efecto en la
seguridad:

- **La propiedad del dominio nuevo se prueba de nuevo**, por las vías de
  siempre (TXT `_mailway`, MX hacia aquí o escritura en una zona activa de
  Cloudflare). No se hereda del dominio viejo, ni siquiera para la
  administración: dominio2.es pasa por la misma alta que cualquier dominio, así
  que el cambio no amplía lo que hoy se puede dar de alta.
- **Reserva del dominio dado de baja.** Tras la baja, el TXT de verificación y
  quizá el MX de dominio.es siguen en su DNS y bastarían para que otro cliente
  «probara» la propiedad y recibiera el correo que aún llegue. Un dominio dado
  de baja en un cambio de dominio queda reservado a su cliente: otro cliente, o
  Skyway con `soloCliente=1`, recibe `409 domain_reserved`; solo la
  administración (sin `soloCliente`) puede darlo de alta para otro.
- **La baja exige que el MX viejo ya no apunte aquí** (medido en ese momento;
  sin DNS, `503`): el correo ajeno que siguiera llegando se rechazaría, y los
  rechazos alimentan el bloqueo automático de IPs del motor. Por la misma razón
  no se cancela un cambio cuyo dominio nuevo ya recibe aquí, tanto si lo creó
  el cambio como si ya existía. Tras pasar, el vigilante tampoco avisa de que
  el DNS del dominio anterior «ha dejado de ser correcto»: seguir ese aviso
  devolvería el MX a este servidor y bloquearía la baja.
- **Ningún reenvío sale a Internet por la dirección vieja.** Al pasar, los
  alias de toda la instancia que reenvían a un buzón que se muda se vuelven a
  escribir en el motor con el buzón como miembro (por id). Un reenvío que el
  motor guardaba por dirección (creado cuando dominio.es aún no tenía la
  propiedad comprobada, p. ej. desde otro cliente) seguiría apuntando a
  `ana@dominio.es` y, tras la baja, entregaría en el MX de dominio.es, es
  decir, a quien tenga ese dominio después. En Stalwart 0.16 los destinos de
  una lista son siempre direcciones: al quitar una (la baja), el driver pasa a
  la dirección nueva todas las listas que la tenían, antes de que el dominio
  salga del motor.
- **«Actualizar mis dispositivos» desde el enlace de configuración no pide la
  contraseña.** La acción solo cambia el usuario del propio buzón a su
  dirección vigente, algo que la baja hará de todos modos: no da acceso ni
  revela nada. Quien tiene el enlace (un secreto de 256 bits que crea la
  administración del cliente) ya puede ver los datos de conexión y, a veces, la
  contraseña. Lo peor que puede pasar es que unos dispositivos dejen de conectar
  antes de tiempo. La ruta tiene el límite de las rutas públicas.
- **Aplicaciones que envían por SMTP.** Un buzón con contraseñas de aplicación
  `skyway:*` activas solo cambia de usuario con el token de gestión de la
  administración: Skyway lo actualiza, cambia sus variables y vuelve a
  desplegar la aplicación. Ni el titular, ni la sesión del panel, ni un token
  que se crea un usuario del cliente pueden dejarla sin enviar
  (`409 mailbox_used_by_app`), tampoco cancelando un cambio que devolvería el
  buzón a su usuario anterior, y la baja no sigue con alguno pendiente. El
  prefijo `skyway:` está reservado a las integraciones: el panel y «Mi buzón»
  no crean contraseñas con ese nombre (`400 app_password_name_reserved`), que
  bloquearían la actualización del buzón y la baja de todo el dominio.
- **Cambios de Skyway.** Un cambio creado por Skyway (`origen: "skyway"`) solo
  se crea, se pasa, se vuelve, se cancela o se da de baja con el token de
  gestión de la administración, que es el que usa Skyway. Con la sesión del
  panel, o con un token que se crea un usuario del cliente (`POST /api/tokens`
  solo pide su sesión), crearlo da `403 token_required` y las acciones,
  `409 migration_managed_externally`. Así nadie
  desacompasa por error el correo de la web y los despliegues que lleva
  Skyway. Por lo mismo, Skyway no adopta un cambio que se lleva desde el panel
  ni el de otro proyecto: pedir el mismo cambio da `409 migration_exists`.
- **El complemento del webmail traslada la fila de Roundcube antes de
  comprobar la contraseña.** Al entrar, `mailway_cuentas` pregunta al panel
  (con el token del webmail, nunca con la contraseña) cuál es el usuario
  vigente de lo que se ha tecleado y, si es otro, pasa a él la fila de
  `users` del usuario anterior. Lo hace en `authenticate`, antes de que IMAP
  compruebe la contraseña, porque es el único gancho con el usuario tecleado.
  No es un riesgo: el traslado solo ocurre cuando el panel dice que el usuario
  vigente de ese buzón es otro, lleva al mismo estado que la siguiente entrada
  legítima y nunca borra datos (la fila que estorba se aparta con
  `#apartado-<id>`, no se elimina). Un anónimo solo puede adelantarlo.
  `POST /api/webmail/cuenta` exige el token del webmail (`404` si no está
  configurado, `401` si no coincide) y no cuenta fallos de contraseña porque no
  las comprueba.
- **La autoconfiguración revela el usuario de una dirección en cambio.** Con
  `?emailaddress=`, Thunderbird y Autodiscover reciben como usuario el login
  vigente cuando no coincide con la dirección pedida (si no, el programa se
  configuraría con un usuario que no existe). Para una dirección normal la
  respuesta no cambia (`%EMAILADDRESS%`), así que no se revela si existe; para
  una en cambio solo se revela su usuario anterior, que ya se deduce por SMTP.
- **Usuarios del motor y cerrojos.** Toda llamada al motor que identifica un
  buzón usa su usuario del motor (`loginParaMotor`). Un cambio de usuario se
  marca antes de tocar el motor (`usuario_cambiando_a`): si el panel cae a
  mitad, el buzón responde `409 mailbox_login_updating` hasta que el
  conciliador (al arrancar y en el vigilante) sabe con qué nombre quedó el
  principal, para no llamar nunca al motor con un nombre equivocado. La
  contraseña se sigue comprobando con la copia local del hash (sección 3.4),
  que no depende del nombre: sin copia, «no se puede comprobar ahora», nunca
  una pregunta al motor con el nombre equivocado. Las acciones del cambio van
  en fila con los cerrojos `altas:dominios → altas:<cliente> → cambio:<id> →
  buzon:<id> → estado-buzon:<id> | credenciales:<id> | contrasenas-app:<id>`,
  siempre en ese orden (la corrección de las suspensiones y el nombre visible
  también toman `buzon:<id>`).
- **Cambio de versión del motor.** Con el motor en mantenimiento ningún paso
  del cambio escribe en él (`503 engine_maintenance`), y el motor no se migra
  de la 0.15 a la 0.16 con un cambio sin terminar o con buzones que siguen
  con el usuario anterior: la migración oficial convierte cada cuenta por su
  nombre y el panel podría quedarse llamando a una cuenta con otro.
- **La cuenta oculta `configuration@` se va con el dominio.** La baja (y la
  cancelación que elimina el dominio nuevo) la retira del motor antes de
  borrar el dominio: no queda una cuenta con contraseña en un dominio que ya
  no es del cliente.
- **Auditoría.** Cada paso queda en la Actividad del cliente
  (`domain.migration_created`, `…_switched`, `…_rolled_back`, `…_cancelled`,
  `…_retired`, `…_mx_changed`) y cada cambio de usuario, con quién lo pidió
  (`mailbox.login_updated` con `por: panel|integracion|titular|enlace|baja|cancelacion|conciliador`).

## 13. Recomendaciones operativas

- Mantén cerrados en el cortafuegos todos los puertos salvo 22, 25, 80, 443,
  465, 587, 993 y 4190.
- Conecta a Cloudflare tokens con los permisos mínimos (*Zona → Zona → Leer* y
  *Zona → DNS → Editar*) y limitados a las zonas necesarias; nunca la clave
  global.
- Da a cada integración su propio token de gestión, con caducidad si es
  temporal, y revoca los que no se usen. Para Skyway, un token de
  administración dedicado.
- Retira `MAILWAY_SMTP_ALLOW_SELF_SIGNED` en cuanto el motor tenga
  certificado.
- Revisa **Actividad** y **Avisos** con regularidad y configura al menos un
  canal de aviso.
- Activa la actualización automática (`sudo mailway auto-update on`): los
  parches de seguridad llegan probados y, si algo falla al aplicarlos, el
  servidor vuelve solo a la versión anterior.
- Guarda cifradas las copias de `/data`, del volumen del motor y de
  `deploy/.env`.
