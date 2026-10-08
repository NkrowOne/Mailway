# Mailway — Plan técnico y decisiones de arquitectura

> Versión de este documento: 1.3.0. Si el código y este documento discrepan,
> gana el código (`server/src/`, `deploy/`, `web/src/`).

Este documento recoge las decisiones de arquitectura y su porqué, el modelo
de datos y el estado del proyecto. Es la referencia para cualquier persona (o
agente) que vaya a modificar Mailway. El despliegue se describe en
[DESPLIEGUE-SKYWAY.md](DESPLIEGUE-SKYWAY.md), la API en [API.md](API.md) e
[INTEGRACIONES.md](INTEGRACIONES.md) y la seguridad en
[SEGURIDAD.md](SEGURIDAD.md).

## 1. Qué es

Mailway convierte un servidor propio en un **servicio de correo comercial
multi-cliente**:

- El **administrador** (dueño del servidor) da de alta clientes y les asigna
  un plan con límites (dominios, buzones, alias, cuota, envíos por API).
- Cada **cliente** tiene su panel: dominios con DNS guiado o aplicado en
  Cloudflare, buzones hasta el máximo de su plan, alias, contraseñas de
  aplicación, claves de API, marca blanca y actividad.
- Cada **titular** de un buzón configura sus dispositivos con un enlace de
  configuración o desde «Mi buzón», sin cuenta en el panel.
- **Integraciones**: tokens de gestión para scripts y agentes, y Skyway, que
  gestiona el correo de cada proyecto.
- Un **asesor de entregabilidad** y un **vigilante** explican en español qué
  falta y avisan cuando algo se rompe.

## 2. Arquitectura

```
┌──────────────────────────────────── servidor ───────────────────────────────────┐
│ Traefik de Skyway :80/:443                                                      │
│   ├─ panel.<d>      → skyway-mailway-panel:4100   (Node, desplegado por Skyway) │
│   ├─ webmail.<d>    → mailway-webmail:80          (Roundcube, compose)          │
│   ├─ mail.<d>       → mailway-mail:8080           (web y API del motor)         │
│   └─ autoconfig./autodiscover./mta-sts./marca blanca                            │
│        → rutas dinámicas: Mailway /api/traefik/config → puente de Skyway        │
│                                                                                 │
│ panel ──HTTP──► mailway-mail:8080 (API de gestión)       red skyway-edge        │
│   │  SQLite /data                                                               │
│   └─SMTP 587 (API de envío) ─► mailway-mail              red skyway-edge        │
│ webmail ─IMAP 993 / SMTP 465 / Sieve 4190─► mailway-mail red mailway-internal   │
│                                                          (10.203.53.0/24)       │
│ mailway-mail: Stalwart v0.15.5 — :25 :465 :587 :993 :4190 directos al host      │
└─────────────────────────────────────────────────────────────────────────────────┘
```

| Pieza | Qué es | Cómo se despliega | Por qué separada |
|---|---|---|---|
| Panel (`server/` + `web/`) | Fastify + React; toda la lógica multi-cliente | Skyway desde GitHub (o `docker-compose.standalone.yml`) | Es una web normal: un puerto, TLS de Traefik, despliegue por cambio de rama |
| Motor (Stalwart v0.15.5) | SMTP, IMAP, ManageSieve, antispam, DKIM | `deploy/docker-compose.mail.yml` | Necesita cinco puertos del host; Skyway publica uno por servicio |
| Webmail (Roundcube 1.7) | Cliente web IMAP en español | Mismo compose | Imagen oficial con parches de seguridad activos |

El servidor se organiza en `server/src/modules/` (un módulo por área),
`server/src/engine/` (drivers del motor) y `server/src/core/` (base de datos,
cifrado, DNS, Cloudflare, cerrojos, errores, avisos). La web, en
`web/src/pages/` (panel), `web/src/pages/portal/` (titular) y `web/src/ui/`
(kit).

## 3. Decisiones y su porqué

### 3.1 Motor y datos

1. **Stalwart como motor, fijado a v0.15.5.** Un solo contenedor con SMTP,
   IMAP, antispam, DKIM y **API REST de gestión**, sin pegamento
   Postfix + Dovecot + Rspamd. La v0.16 eliminó la API REST (migró a JMAP):
   actualizar exige un driver nuevo (sección 6).
2. **Driver de motor intercambiable.** Las rutas nunca hablan con Stalwart:
   usan `MailEngine` (`server/src/engine/types.ts`) mediante `getEngine()`.
   Drivers: `stalwart` y `demo` (todo el panel funciona sin motor real).
3. **Semántica de errores del motor.** Stalwart 0.15 devuelve los errores de
   gestión con **HTTP 200** y un cuerpo sin `data`
   (`{"error":"notFound"|"fieldAlreadyExists"|"other"|…}`). El driver los
   traduce a `HttpError` 502 con código `engine_not_found`, `engine_exists` o
   `engine_error`; sin esa traducción, un alta duplicada o un borrado de algo
   inexistente pasarían por éxitos. Un **HTTP 404 real** no significa «no
   existe», sino una ruta de gestión desconocida (URL del motor mal puesta, un
   proxy con otro prefijo o un motor sin esta API): se traduce a `engine_error`,
   porque tomarlo por `engine_not_found` haría que los borrados «tuvieran
   éxito» sin hacer nada y los buzones siguieran recibiendo correo. Los fallos
   de red son `engine_unreachable`. Las altas **adoptan** lo que ya existe en
   el motor (un huérfano de un borrado interrumpido): el panel es la fuente de
   verdad.
4. **Contraseñas hasheadas en el panel.** La API de Stalwart no hashea lo que
   recibe: Mailway genera `$6$` (sha512-crypt, probado contra los vectores
   oficiales en `server/src/core/sha512crypt.ts`) y nunca envía ni guarda
   contraseñas de buzón en claro.
5. **Contraseñas de aplicación nativas.** Las del titular, las de Skyway y la
   credencial SMTP de cada clave de API son secretos `$app$<etiqueta>$<hash>`
   del motor: se revocan una a una, no tocan la contraseña principal, y
   cambiar la principal las conserva (`addItem` de un secreto normal solo
   sustituye la principal).
6. **SQLite (better-sqlite3).** Mismo criterio que Skyway: un servidor, sin
   dependencias pesadas, copia de seguridad = copiar un fichero. El correo vive
   en el motor (RocksDB en su volumen). Las transacciones nunca contienen un
   `await`.
7. **Secretos cifrados en reposo** con AES-256-GCM (credenciales del motor,
   tokens de Cloudflare, contraseñas de enlaces, credencial SMTP de las
   claves). La clave maestra se genera en el primer arranque en `/data/.secret`
   o viene de `MAILWAY_SECRET`. Lo que no hay que recuperar (tokens de gestión,
   claves de API, sesiones, enlaces) solo existe como hash HMAC.

### 3.2 Límites, concurrencia y propiedad

8. **Los límites del plan se imponen en el servidor.** `assertWithinLimit()`
   antes de crear dominios, buzones y alias; el frontend solo los pinta.
9. **Cerrojos por cliente.** Las altas comprueban el plan, esperan al motor e
   insertan: sin serializarlas, peticiones simultáneas pasarían todas la
   comprobación. `withLock(clientLockKey(clientId))` (`core/locks.ts`) encadena
   las altas de buzones y alias de cada cliente, y `altas:dominios` las de
   dominios (dos clientes no pueden dar de alta el mismo dominio a la vez).
   Mailway es un único proceso, así que basta con una cadena de promesas por
   clave. Si pese a ello una alta choca con otra en la base (índice único),
   responde `409` (`domain_exists`, `mailbox_exists`, `alias_exists`) y no
   deshace en el motor lo que creó la otra: ese principal es el suyo. Las
   contraseñas de aplicación de un mismo buzón van en fila por la misma razón
   (`contrasenas-app:<buzón>`).
10. **Límites de la API por cliente.** Los envíos por minuto (memoria) y por
    día (SQLite) del plan se cuentan por cliente, sumando todas sus claves:
    crear más claves no amplía el plan. El límite diario de una clave solo
    puede acotar el del plan. El cupo se reserva de forma atómica antes de
    enviar. Los formularios web tienen su propio cupo diario por formulario
    y no gastan el de la API: los rellena cualquiera desde Internet.
11. **Verificación de la propiedad de los dominios.** Sin ella, un cliente
    podría dar de alta `gmail.com`, crear `victima@gmail.com` y el motor
    entregaría en local el correo que otros clientes del servidor envían a ese
    dominio. Nadie (tampoco la administración ni un token, así Skyway queda
    cubierto) crea buzones ni alias hasta probar la propiedad: un MX que apunta
    al servidor de la instancia, o el TXT `_mailway.<dominio>` =
    `mailway-verificacion=<token>`, con `token` = primeros 32 hexadecimales de
    HMAC-SHA256(clave maestra, `propiedad:<dominio>`). Es estable, no se
    guarda y no se puede adivinar. Se comprueba al medir el DNS (también lo
    hace el vigilante mientras está pendiente); una vez probada no se pierde, y
    una consulta que falla no cuenta como «no». Cloudflare crea el TXT al
    aplicar el DNS y, si la zona está activa, la propiedad queda probada al
    instante; una zona pendiente de activación no prueba nada, porque cualquiera
    puede añadir un dominio ajeno a su cuenta. La API lo expone en cada dominio
    (`ownershipVerifiedAt`, `ownershipRecord`) y en la tabla de registros con
    la categoría `verificacion`; sin propiedad, crear buzones o alias responde
    `409 domain_ownership_pending`.
12. **Marca blanca solo sobre dominios de correo del mismo cliente con la
    propiedad comprobada.** Traefik enruta cualquier nombre que se le
    publique: sin esta regla un cliente podría reclamar el nombre de otra
    aplicación del servidor. Cuenta la propiedad, no que el dominio esté
    activo.

### 3.3 DNS y Cloudflare

13. **DNS con verificación en vivo.** El motor dicta los registros exactos
    (`/api/dns/records/{dominio}`); Mailway descarta los SRV de puertos que no
    se publican, TLSA y nombres de otras zonas, y los compara contra
    resolutores públicos (`MAILWAY_DNS_RESOLVERS`, por defecto 1.1.1.1 y
    8.8.8.8). Un fallo de consulta (`unknown`) no degrada un dominio ya
    verificado: solo un fallo definitivo (`missing`/`mismatch`) lo hace. Las
    listas negras se consultan con el resolutor del sistema (Spamhaus rechaza
    los públicos; su respuesta 127.255.255.x se trata como «no concluyente»).
14. **Cloudflare en un clic, sin romper nada.** Plan previo (crear, actualizar,
    conservar, conflicto), un solo lote transaccional y, si el lote falla,
    aplicación uno a uno. Todo sin proxy; SPF fusionado; DMARC existente
    respetado; MX ajenos solo con confirmación.
15. **Cuentas de Cloudflare de la instancia solo para la administración.** Un
    cliente usa sus propias cuentas y nunca una de la instancia, ni siquiera
    la que quedó asociada a su dominio porque la administración aplicó su DNS
    con ella (hasta la 1.0 sí podía, y eso le permitía reescribir una zona del
    operador con solo dar de alta un subdominio suyo). `soloCliente=1` fuerza
    esta regla aunque la petición llegue con un token de administración
    (Skyway actuando por un usuario que no lo es), en el plan y la aplicación
    del DNS de un dominio, en el alta con `autoDns`, en el DNS de un dominio de
    marca blanca, en el listado, la conexión y el borrado de cuentas y en las
    rutas que solo usan la cuenta de la instancia (DNS de la plataforma y
    ACME del motor), que lo rechazan.

    **El token de Cloudflare del instalador es la cuenta de la instancia.** El
    instalador lo pasa al panel con `tools/cloudflare.js conectar` (y a Skyway
    con su herramienta equivalente) por la entrada estándar, nunca como
    argumento ni en `deploy/.env`. Desde entonces, las altas de dominios del
    administrador (panel, alta de cliente con dominio o Skyway con `autoDns`
    explícito) configuran el DNS solas: **solo crean** lo que falta (ni
    completan el SPF, ni quitan un proxy, ni actualizan un registro; eso queda
    para «Aplicar» tras revisar el plan). `POST /api/domains` sin `autoDns`
    sigue sin tocar Cloudflare: quien llama decide. Repetir el instalador con
    otro token sustituye el de su cuenta en vez de añadir otra.

    **Lo que la administración escribe en una zona del operador queda
    reservado.** Los registros de un dominio (MX, TXT de verificación) siguen
    en la zona aunque el dominio se borre, y bastarían a otro cliente para
    probar la propiedad. Por eso, si se escribieron con una cuenta de la
    instancia, el dominio queda reservado al cliente para el que se
    escribieron (`cloudflare_reservas`): otro cliente, o Skyway con
    `soloCliente=1`, recibe `409 domain_reserved`; la administración puede
    darlo de alta para otro cliente, y la reserva pasa a ese cliente.

    **Registros propios con la huella de la instancia.** Mailway marca lo que
    crea con `Mailway (instancia <huella>)` (HMAC del secreto, que no lo
    revela) y solo actualiza sin confirmación los registros con exactamente
    ese comentario: los de otra instalación que gestione la misma zona son
    conflictos.

### 3.4 Autoconfiguración y Traefik

16. **La autoconfiguración la sirve el panel, no Stalwart.** Stalwart sirve su
    propio autoconfig, pero anuncia todos sus *listeners* (también los que el
    compose no publica, como 143, 110 o 995) y marca como `TLS` puertos con
    TLS implícito. El panel genera Thunderbird *clientConfig*, Autodiscover
    POX y v2, perfiles de Apple con UUID deterministas y MTA-STS
    (`modules/connection.ts`), así el panel, el portal, los enlaces y las rutas
    públicas dicen exactamente lo mismo. Thunderbird busca
    `autoconfig.<dominio del MX>`: servir `autoconfig.<dominio base>` cubre a
    todos los clientes sin DNS propio.
17. **Autodiscover responde siempre 200 y nunca lee `Authorization`.**
    Thunderbird envía ahí la contraseña real por Basic: un 401 le haría
    pedirla de nuevo, y registrarla sería una fuga.
18. **Rutas de Traefik por proveedor HTTP.** Mailway publica en
    `/api/traefik/config` los nombres que necesita (webmails de marca blanca y
    `autoconfig.`/`autodiscover.`/`mta-sts.`), **solo cuando su DNS ya apunta
    aquí**: uno que no resuelve haría fallar Let's Encrypt y acabaría en un
    bloqueo por reintentos. Cada nombre lleva su propio par de routers, sin
    puntos en el nombre, para que un filtro intermedio pueda descartar uno sin
    perder los demás.
19. **Puente de Skyway (≥ 0.34).** El Traefik de Skyway no consulta a Mailway
    directamente, sino a Skyway (`/api/traefik/mailway`), que ya conoce la
    dirección y el token de Mailway, **filtra** lo publicado (solo `Host()`
    hacia contenedores de Mailway, nunca un dominio de Skyway) y conserva la
    última configuración buena. Un Mailway comprometido no puede secuestrar el
    tráfico de otras aplicaciones. Sin Skyway o con una versión anterior, un
    `docker-compose.override.yml` hace que Traefik consulte el panel con
    `X-Mailway-Token`.

### 3.5 Titulares y contraseñas

20. **Verificación local de contraseñas de buzón.** El portal, los enlaces y el
    webmail comprueban la contraseña leyendo el principal del motor y
    comparando su hash `$6$` en el panel (`engine.verifyCredentials`), nunca
    pidiendo al motor que autentique: Stalwart bloquea **para siempre** una IP
    tras 100 fallos al día (`server.auto-ban.auth.rate`), y detrás de Traefik o
    del webmail todas las peticiones comparten IP. Los fallos se cuentan en el
    panel (5 por buzón y 20 por IP cada 15 minutos).
21. **Una contraseña de aplicación no gestiona el buzón.** Sirve para IMAP y
    SMTP, pero no para entrar en «Mi buzón» ni cambiar la principal. Cada
    buzón admite hasta 25 activas (`409 app_password_limit`): lo comprueba
    `createAppPassword`, junto con el cliente y el buzón suspendidos, para que
    el panel, «Mi buzón» y las integraciones no puedan saltárselo.
22. **Cambio de contraseña desde el webmail por el panel.** El complemento
    `password` de Roundcube (driver `httpapi`) llama a `/api/webmail/password`
    por la red interna con un secreto compartido. No se usa
    `/api/account/auth` de Stalwart porque borra las contraseñas de
    aplicación.
23. **Enlaces de configuración con contraseña de corta vida.** El token (256
    bits) solo existe como hash; la contraseña va cifrada y se borra al
    caducar, al revocar, al marcar «Ya lo he configurado» o al cambiar la
    contraseña del buzón. Al crear el enlace, la contraseña se comprueba antes
    de guardarla; para que esa comprobación no sirva de oráculo, cada fallo
    cuenta por buzón (5 en 15 minutos → `429 rate_limited`) y, si el motor no
    responde, no se guarda nada (`503 engine_unreachable`).

### 3.6 Motor detrás del proxy

24. **Ajustes recomendados del motor** (asistente, instalador y
    `POST /api/engine/recommended`): `server.hostname` (sin él, Stalwart
    anuncia el ID del contenedor en su DNS), `http.use-x-forwarded=true`
    (sin él, un escáner que pide `/wp-login.php` por Traefik banea la IP de
    Traefik) y `server.allowed-ip.<red interna>` (exime del bloqueo solo al
    webmail y, en la instalación autónoma, al panel).
25. **Red interna con subred fija** (`10.203.53.0/24`, motor en
    `10.203.53.10`). Poco común para no chocar con redes de Docker ni VPN, y
    fija para que la exención cubra solo al webmail. El webmail fija
    `mailway-mail` a esa IP (`extra_hosts`) para no entrar por la red del
    proxy.
26. **Certificado del motor.** Preferido: ACME del propio Stalwart con DNS-01
    en Cloudflare (no depende de Traefik ni del puerto 80, renueva 30 días
    antes). Alternativa (perfil `tls`): el extractor propio
    (`deploy/tls/extractor.py`) toma de Traefik solo el certificado del
    servidor de correo, lo valida antes de usarlo, pide la recarga al motor,
    comprueba 993/465 y vuelve al anterior si falla. El vigilante recarga
    además los certificados a diario y avisa si caducan.

### 3.7 Seguridad del panel

27. **CSRF y proxy.** Las peticiones mutantes con cookie que el navegador marca
    como de otro sitio se rechazan (`403 cross_site_request`): `SameSite=Lax`
    no basta cuando otra aplicación del mismo servidor comparte sitio.
    `MAILWAY_TRUST_PROXY` (1 salto por defecto) evita que el cliente falsee su
    IP con `X-Forwarded-For` y esquive los límites de intentos.
28. **Tokens de gestión con los permisos de su usuario**, verificados en cada
    petición (sin caché); crearlos exige sesión de navegador, igual que cambiar
    la contraseña del panel y conectar, cambiar o probar el motor
    (`requireSession` y `requireAdminSession`): de otro modo, un token
    filtrado podría desviar la contraseña del motor a otro servidor. Con
    `Bearer` no se lee la cookie.

Detalle en [SEGURIDAD.md](SEGURIDAD.md).

## 4. Modelo de datos

SQLite en `/data/mailway.db`. Migraciones incrementales en
`server/src/core/db.ts`: cada una se ejecuta una vez, en orden, y nunca se
edita una ya publicada.

| Migración | Contenido |
|---|---|
| `001-esquema-inicial` | Tablas base (abajo). |
| `002-marca-blanca-y-alertas` | `client_domains`, `alerts`. |
| `003-integraciones-y-portal` | `management_tokens`, `cloudflare_accounts`, `setup_links`, `mailbox_sessions`, `app_passwords`; columnas `domains.cloudflare_account_id`, `domains.cloudflare_zone_id`, `domains.dns_applied_at`, `mailboxes.used_bytes`, `mailboxes.usage_checked_at`, `clients.external_ref` (índice único parcial). |
| `004-propiedad-de-dominios` | `domains.owner_verified_at`. Los dominios anteriores ya verificados o con buzones o alias se marcan como comprobados, para no romper nada. |
| `005-idempotencia-de-envios` | `send_idempotency`: respuesta de cada envío con `Idempotency-Key`, 24 h por clave de API. |
| `006-formularios-web` | `forms` (formularios de contacto para webs estáticas) y `messages.form_id`. |
| `007-origen-de-los-envios` | `messages.source` (`api` o `form`, se conserva al eliminar el formulario) e índice por formulario: el cupo de la API solo cuenta `api` y cada formulario tiene el suyo. |
| `008-reservas-de-cloudflare` | `cloudflare_reservas`: dominios cuyo DNS escribió la administración con una cuenta de la instancia, con el cliente para el que se escribió (sin claves foráneas: sobrevive al dominio y al cliente). Rellena las de la 1.0: dominios con `dns_applied_at` y la zona anotada cuya cuenta es de la instancia o ya no existe. |
| `009-perfil-de-buzones` | `mailbox_photos`: foto de cada buzón (tipo comprobado por su firma, bytes y fecha para invalidar la caché), aparte de `mailboxes` para que los listados no carguen imágenes. |
| `010-enlaces-recuperables` | `setup_links.token_enc`: token del enlace cifrado con la clave maestra para que la administración pueda volver a enviarlo; se vacía al caducar o revocar. |

```
plans              límites por plan (dominios, buzones, alias, cuota, API/día, API/minuto)
clients            cliente → plan, suspensión, notas internas (solo la administración),
                   external_ref (p. ej. skyway:project:<id>)
users              usuarios del panel: admin (todo) | client (su cliente); deshabilitables
sessions           sesiones del panel (hash del token, caducidad, IP, agente)
management_tokens  tokens de gestión: prefijo, hash, caducidad, último uso, revocación
domains            dominio → cliente, selector DKIM, último informe DNS (JSON), estado,
                   cuenta y zona de Cloudflare, dns_applied_at, owner_verified_at
mailboxes          buzón → dominio (local_part único por dominio), cuota, estado, ocupación
aliases            alias → destinos (JSON: buzones del cliente o externos)
app_passwords      contraseñas de aplicación: secreto tal como está en el motor, revocación
setup_links        enlaces de configuración: hash del token, contraseña cifrada opcional
mailbox_sessions   sesiones de «Mi buzón»
mailbox_photos     foto de cada buzón (tipo comprobado, bytes, fecha para la caché)
api_keys           claves de envío: prefijo, hash, remitente, credencial SMTP cifrada,
                   límite diario opcional, revocación
messages           registro de cada envío por API o formulario (estado, error, message-id,
                   tamaño, source api|form, form_id)
forms              formularios de contacto: clave pública mwf_, buzón destinatario,
                   orígenes permitidos, asunto, credencial SMTP cifrada, Turnstile
                   (secreto cifrado), activo, contador
api_usage          contador diario de envíos
send_idempotency   Idempotency-Key de /v1/send: hash del valor y del cuerpo, respuesta
                   guardada 24 h por clave de API
cloudflare_accounts  cuentas de Cloudflare (token cifrado; client_id NULL = instancia)
client_domains     dominios de marca blanca (webmail | panel) y su estado
alerts             incidencias del vigilante (una abierta por dedupe_key, índice parcial)
audit_log          quién hizo qué, cuándo, desde qué IP y con qué token (el cliente no ve
                   la IP ni el correo de la administración)
login_attempts     intentos fallidos (panel por IP y correo; portal por buzón e IP;
                   enlaces con contraseña por buzón; token de puesta en marcha por IP)
settings           ajustes de instancia y motor, estado de autoconfiguración, cachés
```

Reglas de integridad que protegen al usuario:

- No se borra un plan en uso ni el último plan, un cliente con dominios, un
  buzón remitente de una clave activa ni un buzón que recibe formularios.
- Borrar un dominio con buzones exige escribir su nombre; se limpia primero el
  motor y después el panel, buzón a buzón, de modo que un fallo a mitad deja
  el panel coherente y repetir completa el borrado. La respuesta cuenta las
  claves de API que dejan de funcionar con sus buzones y las direcciones de
  los alias de otros dominios que se actualizan o se eliminan.
- Borrar un buzón lo retira antes de los alias que reenvían a él.
- Contraseñas, tokens y claves se muestran **una sola vez**.

## 5. Frontend

Interfaz clara y sobria (contrato completo en [DESIGN.md](../DESIGN.md)):
fondo gris verdoso claro, tarjetas blancas con esquinas suaves, un único color
de identidad (verde petróleo) para la acción principal y la navegación, y
colores de estado solo para calificar datos. Cada comprobación se presenta con
su valor, lo esperado y su estado (`Medida`), y cada estado vacío con el icono
de la vista y el siguiente paso (`Vacio`). Interfaz en español profesional y
neutro, que trata al lector de tú, operable con teclado, con estados de carga,
vacío y error en todas las vistas y sin desplazamiento horizontal en móvil. El
portal del titular (`/conectar/<token>`, `/mi-buzon`) usa el mismo sistema con
controles táctiles de 44 px y un paso a la vez.

## 6. Estado y hoja de ruta

### Hecho en la 1.0

- Clientes, planes con editor, usuarios de cliente, suspensión propagada al
  motor.
- Dominios con DNS guiado, fichero de zona, verificación en vivo y
  **verificación de propiedad**.
- **Cloudflare**: DNS de dominios, de marca blanca y de la plataforma en un
  clic; certificado del motor por DNS-01.
- Buzones con ocupación real, altas masivas, alias con destinos externos,
  **contraseñas de aplicación**.
- **Autoconfiguración** (Thunderbird, Outlook, Apple, MTA-STS), **enlaces de
  configuración** con QR y portal **«Mi buzón»**.
- Webmail en español con cambio de contraseña, filtros y aviso de ausencia.
- **Tokens de gestión**, API de integraciones y **Skyway** (correo por
  proyecto y puente de Traefik).
- API de envío con límites por cliente, historial, **adjuntos** (lista cerrada
  de tipos con firma comprobada) e **`Idempotency-Key`**; al crear una clave o
  una contraseña de aplicación, **variables listas para copiar** (.env, Node,
  Laravel, Django) con los mismos nombres que Skyway.
- **Formularios de contacto** para webs estáticas: clave pública, orígenes
  permitidos, campo trampa, límites, Turnstile opcional y `widget.js`.
- Vigilante (motor, cola, webmail, DNS, marca blanca, autoconfiguración,
  listas negras, certificado) con avisos por Discord, Telegram o webhook.
- Instalador idempotente con modo desatendido y migración desde 0.x.

### Hecho en la 1.1

- El token de Cloudflare del instalador queda conectado en el panel como
  cuenta de la instancia (herramienta `tools/cloudflare.js`, por la entrada
  estándar) y en Skyway: las altas de dominios del administrador configuran
  el DNS solas, sin modificar registros existentes.
- El alta de un cliente con su primer dominio admite el DNS automático.
- Cierre de la vía por la que un cliente (o `soloCliente=1`) usaba la cuenta de
  la instancia asociada a su dominio (decisión 15).

### Hecho en la 1.3

- **Reiniciar la configuración** de un buzón (`POST
  /api/mailboxes/:id/setup-reset`): tras probarlo, contraseña nueva, fuera
  enlaces, sesiones de «Mi buzón», bloqueos y (opcional) contraseñas de
  aplicación, y un enlace de configuración nuevo para el titular.
- **Volver a enviar** un enlace de configuración activo (solo la
  administración) y **favicon** con el logotipo de Mailway en el panel, el
  portal y el webmail.
- **Perfil del buzón**: el titular pone su nombre visible y su foto en el
  onboarding y en «Mi buzón» (y la administración en la ficha); el webmail los
  usa para la identidad del remitente y como avatar entre buzones del mismo
  cliente (complemento `mailway_perfil`).
- El cliente como centro del panel de administración: su ficha agrupa en
  pestañas dominios, buzones, alias, usuarios, marca blanca, API de envío,
  formularios y actividad.
- Webmail con aspecto actual (capa `mailway_theme` sobre Elastic), también en
  modo oscuro.

### Límites conocidos

- La cola del motor se muestra agregada (pendientes), sin detalle por mensaje.
- Un solo nivel de administración (no hay roles intermedios de personal).
- `http.use-x-forwarded=true` hace que el motor crea la cabecera
  `X-Forwarded-For`: cualquier contenedor conectado a `skyway-edge` podría
  falsearla al hablar con `mailway-mail:8080`. Es necesario para no banear la
  IP de Traefik; se resolverá con una red dedicada Traefik–Stalwart.
- MTA-STS se publica en modo `testing`.

### Hoja de ruta, por orden de valor

1. **Driver JMAP para Stalwart ≥ 0.16**, cuando se estabilice su superficie de
   gestión (hoy la imagen queda fijada a 0.15.5).
2. **Webhooks de estado de envío** (entregado, rebotado) hacia las
   aplicaciones de los clientes.
3. **Plantillas transaccionales** con variables (`{{codigo}}`) y versiones.
4. **Red dedicada Traefik–Stalwart** para no confiar en `X-Forwarded-For` de
   toda la red del proxy.
5. **Passkeys** para el panel (mismo enfoque que Skyway).
6. **Módulo antiabuso**: umbrales de rebote por clave y pausa automática.
7. **Importación y exportación** de buzones (migración desde cPanel y otros).
8. **Detalle de la cola** por mensaje y reintento manual.
9. **MTA-STS en modo `enforce`** cuando el certificado del motor lleve un
   tiempo estable.

## 7. Desarrollo local

```bash
npm install
npm run dev                  # servidor :4100 (tsx watch) + web :5173 (vite)
MAILWAY_DEMO=1 npm run dev   # panel completo sin motor de correo real
npm run typecheck && npm run lint && npm test && npm run build
```

Monorepo con *workspaces* de npm: `server/` (Fastify + better-sqlite3) y `web/`
(React + Vite + Tailwind). Las pruebas (`node --test` con `app.inject()`) usan
el motor de demostración y el modo sin red (`MAILWAY_DNS_OFFLINE=1`).
