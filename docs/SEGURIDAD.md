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

### 3.3 Claves de API

`mw_<prefijo>_<secreto>`; solo el hash en la base de datos; comparación en
tiempo constante; revocación inmediata (también se cierra su conexión SMTP y
se retira su credencial del motor). Solo valen en `/v1/send`.

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
  `requireClientAccess(clientId)` o `requireSession`. Un usuario de cliente
  recibe `403` al pedir un recurso de otro cliente, exista o no, sin poder
  enumerar identificadores.
- **Propiedad de los dominios**: nadie crea buzones ni alias en un dominio sin
  probar que es suyo (MX hacia el servidor o TXT `_mailway.<dominio>` =
  `mailway-verificacion=<token>`; si no, `409 domain_ownership_pending`). Sin
  esta regla, un cliente podría dar de alta un dominio ajeno y el motor le
  entregaría en local el correo que otros clientes envían a ese dominio. Se
  aplica también a la administración y a los tokens. Una zona de Cloudflare solo
  prueba la propiedad si está activa: cualquiera puede añadir un dominio ajeno
  a su cuenta de Cloudflare, pero no activarlo.
- **Destinos de alias**: solo buzones del mismo cliente o direcciones
  externas; una dirección de un dominio de la instancia que no existe se
  rechaza en lugar de salir a Internet.
- **Remitente de las claves**: siempre un buzón del mismo cliente; el `From`
  no se puede cambiar.
- **Marca blanca**: solo subdominios de un dominio de correo del mismo cliente
  con la propiedad comprobada (no basta con que esté activo), sin prefijos
  reservados ni nombres de la instancia.
- **Cloudflare**: un cliente solo usa sus cuentas; las de la instancia, solo
  la administración (o una ya asociada por la administración a ese dominio).
  `soloCliente=1` fuerza esta regla aunque llegue un token de administración,
  en el plan y la aplicación del DNS de un dominio, en el alta con
  `autoDns: true` y en el DNS de un dominio de marca blanca.
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
  IP en cada intento y esquivar los límites. Cámbielo solo si hay más proxies
  delante.

## 6. Secretos

- **Clave maestra** (`MAILWAY_SECRET` o `/data/.secret`): firma sesiones, cifra
  secretos y deriva los tokens de verificación de propiedad. **No la cambie**
  en una instalación en uso: invalidaría sesiones, tokens de gestión, claves de
  API, enlaces, los secretos cifrados y los TXT de verificación.
- **Cifrado en reposo** (AES-256-GCM) de lo que hay que recuperar: contraseña
  del motor, tokens de Cloudflare, credencial SMTP de cada clave de API,
  contraseña opcional de un enlace de configuración.
- **Solo hash** (HMAC-SHA256 con la clave maestra) de lo que no hay que
  recuperar: sesiones, tokens de gestión, claves de API, tokens de enlaces.
- Contraseñas, tokens y claves se devuelven **una sola vez**. Los tokens de
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
  administración del motor: use una larga y aleatoria (el instalador la
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
  volcado de Traefik). El vigilante avisa si caduca, es autofirmado o no
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

## 11. Recomendaciones operativas

- Mantenga cerrados en el cortafuegos todos los puertos salvo 22, 25, 80, 443,
  465, 587, 993 y 4190.
- Conecte a Cloudflare tokens con los permisos mínimos (*Zona → Zona → Leer* y
  *Zona → DNS → Editar*) y limitados a las zonas necesarias; nunca la clave
  global.
- Dé a cada integración su propio token de gestión, con caducidad si es
  temporal, y revoque los que no se usen. Para Skyway, un token de
  administración dedicado.
- Retire `MAILWAY_SMTP_ALLOW_SELF_SIGNED` en cuanto el motor tenga
  certificado.
- Revise **Actividad** y **Avisos** con regularidad y configure al menos un
  canal de aviso.
- Guarde cifradas las copias de `/data`, del volumen del motor y de
  `deploy/.env`.
