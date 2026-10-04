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
| Enlaces de configuración (`/api/public/setup/*`) | Quien tenga el enlace | Token de 256 bits, caducidad, 60 peticiones por minuto e IP |
| Formularios de contacto (`/forms/*`) | Visitantes de las webs permitidas | `Origin` en la lista del formulario, campo trampa, límites por IP y por formulario (cupo diario propio, separado del de la API), Turnstile opcional; destinatario fijo del cliente |
| Autoconfiguración (`/mail/…`, `/autodiscover/…`, `/.well-known/…`) | Programas de correo | Solo dominios de la instancia; sin datos de cuentas |
| Cambio de contraseña del webmail (`/api/webmail/password`) | Roundcube, por la red interna | Secreto compartido `MAILWAY_WEBMAIL_TOKEN`; sin él la ruta no existe |
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

### 3.2 Tokens de gestión

- `mwt_<prefijo>_<secreto de 256 bits>`; en la base de datos, solo el hash.
- Heredan los permisos de su usuario y se comprueban en **cada** petición:
  revocar el token, deshabilitar al usuario o cambiarle el rol surte efecto
  de inmediato.
- Un token **no puede** crear otros tokens, cambiar la contraseña del panel ni
  conectar, cambiar o probar el motor de correo (`403 session_required`): un
  token filtrado no puede perpetuarse, dejar fuera al titular ni desviar los
  secretos del motor (sección 7).
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

- La contraseña se comprueba **en el panel**, contra el hash `$6$` que guarda
  el motor, nunca pidiéndole al motor que autentique (sección 7).
- 5 fallos por buzón y 20 por IP cada 15 minutos; los contadores sobreviven a
  un reinicio.
- La misma respuesta (`401 bad_credentials`, «La dirección de correo o la
  contraseña no son correctas.») para una dirección inexistente y para una
  contraseña incorrecta: no se revela qué direcciones existen. La web muestra
  en ambas pantallas de acceso (panel y «Mi buzón») el mismo texto, «El correo
  electrónico o la contraseña no son correctos.».
- Una **contraseña de aplicación** no sirve para entrar en «Mi buzón» ni para
  cambiar la contraseña principal: quien encuentre un móvil perdido no puede
  adueñarse del buzón.
- Máximo de **25 contraseñas de aplicación activas** por buzón, con la misma
  respuesta (`409 app_password_limit`) en el panel, en «Mi buzón» y en las
  integraciones: cada una es una puerta más al buzón, y decenas suelen indicar
  que no se revocan las antiguas.
- Cambiar la contraseña cierra las demás sesiones de «Mi buzón» y borra la
  contraseña guardada en los enlaces de configuración.
- Suspender el buzón o su cliente corta las sesiones abiertas del portal.

## 4. Autorización y aislamiento entre clientes

- Cada ruta declara su nivel: `requireAuth`, `requireAdmin`,
  `requireClientAccess(clientId)`, `requireSession` o `requireAdminSession`
  (cambiar la conexión con el motor: sesión de administración, nunca un token). Un usuario de cliente
  recibe `403` al pedir un recurso de otro cliente, exista o no, sin poder
  enumerar identificadores.
- **Propiedad de los dominios**: nadie crea buzones ni alias en un dominio sin
  probar que es suyo (MX hacia el servidor o TXT `_mailway.<dominio>` =
  `mailway-verificacion=<token>`; si no, `409 domain_ownership_pending`). Se
  aplica también a la administración y a los tokens. Una zona de Cloudflare solo
  prueba la propiedad si está activa: cualquiera puede añadir un dominio ajeno
  a su cuenta de Cloudflare, pero no activarlo.
- **El dominio solo existe en el motor cuando es del cliente**: para Stalwart,
  un dominio que existe es local para todo el servidor (rechaza con «550
  Mailbox does not exist» cualquier dirección que no tenga y entrega en local
  las demás). Por eso el alta de un dominio no lo crea en el motor: se crea con
  su primer buzón o alias, que exigen la propiedad comprobada. Sin esta regla,
  bastaría con dar de alta gmail.com (o el dominio de otro cliente) para que
  ningún cliente del servidor pudiera escribirle. Al actualizar desde una
  versión anterior, una tarea única retira del motor los dominios sin
  propiedad comprobada y sin buzones ni alias; si el motor no responde al
  arrancar, la repite el vigilante.
- **Dominios con el correo en otro proveedor**: aunque el dominio tenga buzones
  aquí, mientras su MX público apunte a otro servidor, lo que se envía desde
  este servidor a sus direcciones sale por ese MX y no se entrega en local
  (véase «Recepción en otro proveedor» en `INTEGRACIONES.md`). Así, preparar
  un traslado o tener solo el envío en Mailway no desvía el correo que se
  envía desde aquí. Límite conocido: el correo de Internet que llega a un
  alias de otro dominio de este servidor y reenvía a un buzón de ese dominio
  se entrega en el buzón de aquí (Stalwart no distingue en la cola un
  destinatario que viene de un alias); el formulario de alias lo avisa.
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
- **El alta automática solo crea** (`autoDns`): no modifica ni borra ningún
  registro existente; las actualizaciones (SPF, proxy, registros propios) solo
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

## 6. Secretos

- **Clave maestra** (`MAILWAY_SECRET` o `/data/.secret`): firma sesiones, cifra
  secretos y deriva los tokens de verificación de propiedad. **No la cambies**
  en una instalación en uso: invalidaría sesiones, tokens de gestión, claves de
  API, enlaces, los secretos cifrados y los TXT de verificación.
- **Cifrado en reposo** (AES-256-GCM) de lo que hay que recuperar: contraseña
  del motor, tokens de Cloudflare, credencial SMTP de cada clave de API y de
  cada formulario, secreto de Turnstile de un formulario, contraseña opcional
  de un enlace de configuración.
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
  copia de seguridad cifrada.

## 7. El motor de correo

- **API de gestión**: el puerto 8080 no se publica en el host; el panel la usa
  por la red `skyway-edge` y el instalador por la red interna. Traefik publica
  la web del motor en `https://mail.<dominio>`, protegida por la contraseña de
  administración del motor: usa una larga y aleatoria (el instalador la
  genera).
- **Conexión del panel con el motor**: conectarlo, cambiarlo o probarlo
  (`POST /api/setup/engine`, `PUT /api/settings/engine`,
  `POST /api/settings/engine/test`) exige la sesión de un administrador, no
  vale un token de gestión (`403 session_required`), y, si cambian la URL, el
  usuario o el servidor SMTP, escribir de nuevo la contraseña del motor
  (`400 engine_password_required`). Si bastara un token, uno filtrado podría
  hacer que el panel enviase la contraseña guardada, o las credenciales SMTP de
  las claves de API, a un servidor ajeno. La URL solo admite `http(s)` y sin
  usuario ni contraseña incrustados.
- **Rutas desconocidas**: un HTTP 404 del motor se trata como un error
  (`engine_error`), nunca como «el elemento no existe»; si no, los borrados
  darían por buena una eliminación que el motor no ha hecho y los buzones
  seguirían recibiendo correo.
- **Bloqueo automático**: Stalwart bloquea para siempre una IP tras 100 fallos
  de autenticación al día y al instante ante rutas típicas de escáneres
  (`*.php`, `/wp-*`…). Por eso:
  - el panel **nunca** pide al motor que autentique contraseñas de titulares
    (portal, enlaces, webmail): las verifica en local;
  - el motor exime de su bloqueo **solo** la red interna `mailway-internal`
    (`10.203.53.0/24`), por la que llega el webmail, cuyos usuarios comparten
    IP. La red del proxy no se exime: por ella entra Internet;
  - `http.use-x-forwarded=true` hace que el motor vea la IP real de quien llega
    por Traefik, en lugar de bloquear la IP de Traefik para todos.
- **Compromiso conocido**: con `http.use-x-forwarded=true`, un contenedor
  conectado a `skyway-edge` podría falsear `X-Forwarded-For` al hablar con
  `mailway-mail:8080`. La mejora prevista es una red dedicada entre Traefik y
  Stalwart.
- **TLS**: IMAP y SMTP con certificado de Let's Encrypt (ACME del motor o
  certificado de Traefik copiado por el extractor del perfil `tls`, que solo
  lleva al volumen del motor el par del servidor de correo, nunca las claves
  de otros dominios). El vigilante avisa si caduca, es autofirmado o no
  corresponde al nombre. La API de envío verifica el certificado del SMTP
  interno contra el nombre público; `MAILWAY_SMTP_ALLOW_SELF_SIGNED=1` solo
  debe usarse mientras no hay certificado.
- La autenticación en claro solo se admite sobre TLS (IMAP, SMTP de envío,
  ManageSieve).

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

## 11. Recomendaciones operativas

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
- Guarda cifradas las copias de `/data`, del volumen del motor y de
  `deploy/.env`.
