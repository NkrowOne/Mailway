# Mailway — Plan técnico y decisiones de arquitectura

> Versión de este documento: 1.0.0. Si el código y este documento discrepan,
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
   inexistente pasarían por éxitos. Los fallos de red son
   `engine_unreachable`. Las altas **adoptan** lo que ya existe en el motor
   (un huérfano de un borrado interrumpido): el panel es la fuente de verdad.
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
   clave.
10. **Límites de la API por cliente.** Los envíos por minuto (memoria) y por
    día (SQLite) del plan se cuentan por cliente, sumando todas sus claves:
    crear más claves no amplía el plan. El límite diario de una clave solo
    puede acotar el del plan. El cupo se reserva de forma atómica antes de
    enviar.
11. **Verificación de la propiedad de los dominios.** Sin ella, un cliente
    podría dar de alta `gmail.com`, crear `victima@gmail.com` y el motor
    entregaría en local el correo que otros clientes del servidor envían a ese
    dominio. Nadie (tampoco la administración ni un token, así Skyway queda
    cubierto) crea buzones ni alias hasta probar la propiedad: un MX que apunta
    al servidor de la instancia, o el TXT `_mailway.<dominio>` =
    `mailway-verificacion=<token>`, con `token` = primeros 32 hexadecimales de
    HMAC-SHA256(clave maestra, `propiedad:<dominio>`). Es estable, no se
    guarda y no se puede adivinar. Se comprueba al medir el DNS; una vez
    probada no se pierde. Cloudflare crea el TXT al aplicar el DNS.
12. **Marca blanca solo sobre dominios verificados del mismo cliente.** Traefik
    enruta cualquier nombre que se le publique: sin esta regla un cliente
    podría reclamar el nombre de otra aplicación del servidor.

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
    cliente usa sus propias cuentas; una de la instancia solo si la
    administración ya aplicó con ella el DNS de ese dominio. `soloCliente=1`
    fuerza esta regla aunque la petición llegue con un token de
    administración (Skyway actuando por un usuario que no lo es).

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
    SMTP, pero no para entrar en «Mi buzón» ni cambiar la principal.
22. **Cambio de contraseña desde el webmail por el panel.** El complemento
    `password` de Roundcube (driver `httpapi`) llama a `/api/webmail/password`
    por la red interna con un secreto compartido. No se usa
    `/api/account/auth` de Stalwart porque borra las contraseñas de
    aplicación.
23. **Enlaces de configuración con contraseña de corta vida.** El token (256
    bits) solo existe como hash; la contraseña va cifrada y se borra al
    caducar, al revocar, al marcar «Ya lo he configurado» o al cambiar la
    contraseña del buzón.

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
    antes). Alternativa: volcar el certificado de Traefik con
    `ldez/traefik-certs-dumper`. Stalwart no relee el fichero tras renovar: el
    vigilante recarga los certificados a diario y avisa si caducan.

### 3.7 Seguridad del panel

27. **CSRF y proxy.** Las peticiones mutantes con cookie que el navegador marca
    como de otro sitio se rechazan (`403 cross_site_request`): `SameSite=Lax`
    no basta cuando otra aplicación del mismo servidor comparte sitio.
    `MAILWAY_TRUST_PROXY` (1 salto por defecto) evita que el cliente falsee su
    IP con `X-Forwarded-For` y esquive los límites de intentos.
28. **Tokens de gestión con los permisos de su usuario**, verificados en cada
    petición (sin caché); crearlos exige sesión de navegador. Con `Bearer` no
    se lee la cookie.

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

```
plans              límites por plan (dominios, buzones, alias, cuota, API/día, API/minuto)
clients            cliente → plan, suspensión, notas, external_ref (p. ej. skyway:project:<id>)
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
api_keys           claves de envío: prefijo, hash, remitente, credencial SMTP cifrada,
                   límite diario opcional, revocación
messages           registro de cada envío por API (estado, error, message-id, tamaño)
api_usage          contador diario de envíos
cloudflare_accounts  cuentas de Cloudflare (token cifrado; client_id NULL = instancia)
client_domains     dominios de marca blanca (webmail | panel) y su estado
alerts             incidencias del vigilante (una abierta por dedupe_key, índice parcial)
audit_log          quién hizo qué, cuándo, desde qué IP y con qué token
login_attempts     intentos fallidos (panel por IP y correo; portal por buzón e IP)
settings           ajustes de instancia y motor, estado de autoconfiguración, cachés
```

Reglas de integridad que protegen al usuario:

- No se borra un plan en uso ni el último plan, un cliente con dominios ni un
  buzón remitente de una clave activa.
- Borrar un dominio con buzones exige escribir su nombre; se limpia primero el
  motor y después el panel, buzón a buzón, de modo que un fallo a mitad deja
  el panel coherente y repetir completa el borrado.
- Borrar un buzón lo retira antes de los alias que reenvían a él.
- Contraseñas, tokens y claves se muestran **una sola vez**.

## 5. Frontend

Mundo visual de «parte de laboratorio» (contrato completo en
[DESIGN.md](../DESIGN.md)): mesa clara, hojas regladas, un único color de
identidad (petróleo) como región y no como filete, y cada dato expresado como
una medición con rango de referencia y veredicto (`Medida`). Interfaz en
español con tratamiento de usted, operable con teclado, con estados de carga,
vacío y error en todas las vistas y sin desplazamiento horizontal en móvil. El
portal del titular (`/conectar/<token>`, `/mi-buzon`) usa el mismo mundo con
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
- API de envío con límites por cliente e historial.
- Vigilante (motor, cola, webmail, DNS, marca blanca, autoconfiguración,
  listas negras, certificado) con avisos por Discord, Telegram o webhook.
- Instalador idempotente con modo desatendido y migración desde 0.x.

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
