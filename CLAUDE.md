# CLAUDE.md — guía del repositorio para agentes/LLM

Punto de entrada para navegar Mailway. Arquitectura, decisiones y modelo de
datos en **[docs/PLAN.md](docs/PLAN.md)**; despliegue en
**[docs/DESPLIEGUE-SKYWAY.md](docs/DESPLIEGUE-SKYWAY.md)**; API de envío en
**[docs/API.md](docs/API.md)**; API de gestión e integraciones (tokens,
Skyway, Cloudflare, autoconfiguración, portal, marca blanca, correo web
nuevo) en
**[docs/INTEGRACIONES.md](docs/INTEGRACIONES.md)**; modelo de seguridad en
**[docs/SEGURIDAD.md](docs/SEGURIDAD.md)**. Sistema de diseño de la web en
**[DESIGN.md](DESIGN.md)** y producto en **[PRODUCT.md](PRODUCT.md)**.

## Qué es

Servicio de correo multi-cliente auto-alojado: el administrador da de alta
clientes con un plan; cada cliente gestiona sus dominios (DNS guiado o en
Cloudflare, con verificación de propiedad), buzones, alias, contraseñas de
aplicación y claves de API; los titulares configuran sus dispositivos con un
enlace de configuración o desde «Mi buzón». Motor Stalwart con versión
exacta por serie: 0.16.25 en las instalaciones nuevas y 0.15.5 en las
anteriores hasta que se migran (`mailway migrar-motor`); webmail Roundcube
(y, por cliente y en beta, el correo web nuevo, Bulwark, con Stalwart 0.16);
panel Node + SQLite. Se despliega junto a
[Skyway](https://github.com/NkrowOne/Skyway) (≥ 0.34 lo gestiona por
proyecto y publica sus rutas de Traefik) o de forma autónoma.

## Estructura

- `server/` — Node 20+/TypeScript/Fastify. `src/app.ts` construye la app
  (`buildApp()`: CSRF, sesión/token, rutas, manejador de errores);
  `src/index.ts` la pone a escuchar y arranca el vigilante.
  - `src/modules/`: un módulo por área. `auth` (sesiones, tokens `mwt_`,
    guardas), `tokens`, `integrations`, `audit`, `setup`, `settings`,
    `clients` (planes, clientes, usuarios, `assertWithinLimit`),
    `invitaciones` (enlace de bienvenida del cliente), `domains`
    (DNS y propiedad), `zonefile`, `deliverability`, `cloudflare`,
    `mailboxes` (buzones, altas masivas, alias), `direcciones` (usuario del
    motor de cada buzón, cambios abiertos y su conciliador),
    `domainmigrations` (cambio de dominio: plan, preparar, pasar, volver,
    cancelar y dar de baja), `recepcion` (dominios con el correo en otro
    proveedor y sus reglas en el motor), `apppasswords`, `perfil`
    (nombre visible y foto del buzón), `portal` (enlaces de configuración y
    su reinicio, «Mi buzón», «Actualizar mis dispositivos», rutas
    `/api/webmail/*` de Roundcube), `remitente` (cuenta oculta
    `configuration@<dominio>`, reservada) y
    `envioconfiguracion` (correo «Configura tu correo» con el enlace de cada
    titular y marca de buzón configurado),
    `connection` (datos de conexión y generadores de autoconfiguración),
    `autoconfig` (rutas públicas y estado de los nombres), `whitelabel`
    (marca blanca, webmail automático de cada dominio y `/api/traefik/config`), `transactional` (claves y
    `/v1/send`), `engineops` (ajustes recomendados, TLS y ACME del motor),
    `alerts`, `watchdog`, `dashboard`, `suspensiones` (corrección única, al
    arrancar o desde el vigilante, de lo que dejó la suspensión anterior:
    buzones con `roles: []` y alias sin sus destinos), `nombreservidor` (lo
    que arrastra cambiar el nombre del servidor), `ipservidor` (IP de salida
    frente a la de Ajustes: aviso y «Usar esta IP»), `entorno` (identidad del
    servidor que trae el entorno tras un cambio de dominio o de IP en el
    instalador) y `demo` (propiedad simulada solo con `MAILWAY_DEMO=1`).
    Correo web nuevo: `webmailmotor` (si Bulwark está instalado y qué
    clientes lo usan; sin dependencias de otros módulos, lo importan Traefik
    y los ajustes del motor), `bulwark` (cliente de su API de
    administración: marca por dominio, imágenes y política) y `correoweb`
    (elección por cliente, su marca y la sincronización con Bulwark, que
    nunca bloquea una ruta).
  - `src/engine/`: interfaz `MailEngine` y drivers `stalwart` (0.15, API
    REST), `stalwart016` (0.16, JMAP) y `demo`; `detector.ts` averigua la
    versión del motor y `protegido.ts` rechaza las escrituras durante su
    mantenimiento;
    `apiconocida.ts` guarda la última versión del motor vista (las rutas de
    Traefik la usan sin esperar al motor) y `recepcion.ts`, las reglas de
    Stalwart 0.15 para los dominios con el correo en otro proveedor.
  - `src/core/`: base de datos y migraciones (`db.ts`), cifrado, DNS,
    cliente de Cloudflare, cerrojos (`locks.ts`), errores, avisos,
    sha512-crypt, imágenes (`imagenes.ts`: tipo y dimensiones por el
    contenido), prueba del puerto 25 (`puerto25.ts`) y detección de la IP
    pública (`ippublica.ts`).
  - `src/tools/reset-password.ts`: restablecer la contraseña de un usuario
    del panel desde la terminal; `src/tools/emparejar.ts`: emparejado con
    Skyway (administrador, puesta en marcha con el entorno y token «Skyway»;
    una línea JSON por la salida estándar), que usa el instalador. Los pasos
    del asistente que comparte viven en `modules/setup.ts`.
    `src/tools/avisar.ts`: aviso a la administración (incidencia en Avisos y
    canales) desde la terminal, que usa `mailway update --auto`.
    `src/tools/identidad.ts`: Ajustes adopta la identidad del entorno tras un
    cambio de dominio o de IP confirmado en el instalador (la comparación
    con el entorno, en `modules/entorno.ts`).
- `web/` — React + Vite + Tailwind. Panel en `src/pages/` (administración en
  `src/pages/admin/`; la ficha del cliente, con sus pestañas, en
  `ClienteDetalle.tsx` y `src/pages/admin/cliente/`), portal del titular en `src/pages/portal/`, kit de UI
  en `src/ui/`, componentes de área en `src/components/`, tipos y utilidades
  en `src/lib/`, esqueleto y navegación en `src/shell/AppShell.tsx`.
- `deploy/` — `instalar.sh` (instalador idempotente), `mailway.sh` (la orden
  `mailway update -y` del servidor: `git pull` y `instalar.sh --actualizar`;
  `update --auto`, con comprobación antes y después y vuelta atrás,
  `auto-update on|off|status`, su temporizador de systemd, y
  `bulwark on|off|status`, el correo web beta), pruebas de los
  scripts con dobles (`prueba-*.sh`), compose del motor y el
  webmail (`docker-compose.mail.yml`) y autónomo
  (`docker-compose.standalone.yml`), el motor de cada serie
  (`motor/stalwart-0.15/compose.yml` y `motor/stalwart-0.16/compose.yml`, que
  elige `MAILWAY_MOTOR`), la pasarela HTTP del motor (`motor/pasarela`: nginx
  con la IP real, delante de sus rutas de Traefik), el ayudante de la
  migración (`motor/migracion.py`), Bulwark y su pasarela (`bulwark/`, ver su
  README), las pruebas de la pila con contenedores reales (`prueba-stack.py`,
  también con `--bulwark`; `prueba-pasarela.sh`, `prueba-motor016.sh`,
  `prueba-panel-motor.js`; `prueba-cambio-dominio.py`, el cambio de dominio
  con un Stalwart 0.15 real), `.env.example`, configuración de
  Roundcube (`roundcube/mailway.php`) y sus complementos
  (`roundcube/mailway_*`: marca sobre Elastic, perfil, sesión y
  `mailway_cuentas`, que traslada la fila del usuario anterior tras un
  cambio de dominio), plantilla
  del override de Traefik y punto de entrada de la imagen.
- `docs/` — documentación consultable.

## Comandos

```bash
npm install
npm run dev                  # servidor :4100 + web :5173
MAILWAY_DEMO=1 npm run dev   # sin motor de correo real
npm run typecheck            # SIEMPRE antes de dar por terminado un cambio
npm run lint                 # reglas de hooks de React en la web
npm test                     # pruebas del servidor (node:test + app.inject)
npm run build                # compila web y servidor
npm run reset-password -w server -- correo@ejemplo.com NuevaContraseña
```

**`npm run typecheck`, `npm run lint`, `npm test` y `npm run build`** son la
verificación mínima; la CI (`.github/workflows/ci.yml`) ejecuta los cuatro,
comprueba la sintaxis de `deploy/*.sh` (`bash -n`) y construye y arranca la
imagen del panel. Si tocas `deploy/`, ejecuta también sus `prueba-*.sh`
(`bash deploy/prueba-actualizacion.sh`…), que corren en
`.github/workflows/stack.yml` con `shellcheck` y la pila de correo real.

Las pruebas viven en `server/test/*.test.ts` y se ejecutan con `node --test`.
`test/env.ts` da a cada fichero una carpeta de datos temporal propia, activa
el motor de demostración, desactiva el vigilante y activa el modo sin red
(`MAILWAY_DNS_OFFLINE=1`: el DNS devuelve «no se pudo consultar»).
`test/helpers.ts` crea la app, el administrador, clientes, dominios y buzones
para probar rutas reales con `app.inject()`. Si arreglas un fallo, añade la
prueba que lo reproduce.

## Convenciones

- **Idioma**: código, comentarios, mensajes de interfaz y de error en
  **español**. Los comentarios explican el *porqué*.
- **Registro de los textos**: profesional y neutro, tratando al usuario de
  tú («Revisa el token», «Tu sesión ha caducado»), con construcciones
  impersonales cuando encajen, botones en infinitivo y sin coloquialismos
  (mismo criterio que `docs/ESTILO-TEXTOS.md` de Skyway). «Su», «le» y
  «puede» no cambian cuando se refieren a un tercero (el cliente, el buzón,
  el titular). Terminología fija: buzón, alias, clave de API, token de
  gestión, contraseña de aplicación, enlace de configuración, plan,
  entregabilidad, cambio de dominio (pasar un cliente de dominio.es a
  dominio2.es), dominio anterior (el origen de un cambio, que no cuenta en el
  plan), actualizar dispositivos (el buzón pasa a entrar con su dirección
  nueva) y usuario del motor (con el que entra un buzón; durante un cambio de
  dominio puede no ser su dirección).
- **Rutas**: `requireAuth` / `requireAdmin` / `requireClientAccess` según el
  recurso, y `requireSession` para lo que un token no debe poder hacer (crear
  tokens, cambiar la contraseña). `requireAdminSession` (administrador con
  sesión del panel) es el guarda para cambiar la conexión con el motor: un
  token de gestión no puede, ni siquiera el de administración. Cuerpo
  validado con **zod**. Errores con los ayudantes de `core/errors.ts` y un
  `code` estable: la respuesta es siempre `{ error, code }`.
  `audit(req, 'area.accion', {...}, clientId)` en las acciones sensibles, con
  el cliente afectado para que aparezca en su Actividad, y nunca con
  secretos.
- **Altas**: dentro de `withLock(clientLockKey(clientId), …)` (dominios:
  `'altas:dominios'`) y con `assertWithinLimit` dentro del cerrojo. Buzones y
  alias exigen `assertDomainOwnership(domainId)` y `assertAltasPermitidas`
  (un dominio en un cambio de dominio no admite altas).
- **Cerrojos** (`core/locks.ts`), siempre en este orden y nunca al revés
  (`withLock` no es reentrante): `altas:dominios` → `altas:<cliente>`
  (`clientLockKey`) → `cambio:<id>` (`cambioLockKey`) → `buzon:<id>`
  (`buzonLockKey`) → `estado-buzon:<id>` (`mailboxStateLockKey`),
  `credenciales:<id>` o `contrasenas-app:<id>` (estos tres no se anidan entre
  sí). Quien tiene uno solo pide los que van después; lo que habla con el
  motor con el usuario de un buzón relee la fila dentro de `buzon:<id>`.
- **Motor**: las rutas nunca hablan con Stalwart directamente, siempre vía
  `getEngine()`, que averigua si el motor es 0.15 (API REST) o 0.16 (JMAP) y
  usa su driver (`engine/stalwart.ts` o `engine/stalwart016.ts`). Lo que
  identifica un buzón en el motor usa su usuario del motor
  (`loginParaMotor(id)`, o `loginDe(fila)` para mostrarlo), nunca su
  dirección, y los destinos internos de un alias van con `nombreEnMotor`.
  Las rutas que escriben en el motor llaman antes a
  `exigirSinMantenimiento()` (503 `engine_maintenance` mientras cambia de
  versión).
  Stalwart 0.15 devuelve los errores de gestión con HTTP 200 y
  cuerpo `{ error }`; el driver los convierte en `HttpError` 502
  (`engine_not_found`, `engine_exists`, `engine_error`,
  `engine_unreachable`). Los ajustes de Stalwart (`POST /api/settings`)
  exigen `assert_empty`. Suspender un buzón le quita los permisos
  `authenticate` y `authenticate-oauth` y le deja el rol `user` (el que da
  `email-receive`): no inicia sesión, pero el correo le sigue llegando. Nunca
  `set` sobre `roles` de un buzón existente: en Stalwart 0.15 roles, listas y
  grupos son la misma relación y `set roles` lo saca de todos sus alias; el
  rol se añade con `addItem`.
- **Contraseñas de buzón**: se verifican en local contra la copia del hash
  `$6$` (`comprobarContrasenaBuzon` en `modules/credenciales.ts`), nunca
  pidiendo al motor que autentique: los fallos alimentarían su bloqueo
  automático de IPs. Cambiar la principal con
  `setMailboxPassword` conserva las contraseñas de aplicación; tras
  cambiarla, `alCambiarContrasenaBuzon()` limpia enlaces y sesiones del
  portal.
- **Secretos**: cifrados con `encryptSecret` si hay que recuperarlos; si no,
  solo hash (`hashToken`). Contraseñas, tokens y claves se devuelven una sola
  vez.
- **Autoconfiguración y Traefik**: los documentos se generan en
  `modules/connection.ts` para que panel, portal, enlaces y rutas públicas
  digan lo mismo. Solo se publican en Traefik los nombres cuyo DNS ya apunta
  al servidor.
- **Correo web nuevo (Bulwark)**: se habla con él solo con
  `ClienteAdminBulwark` (la sesión compartida de `correoweb.ts`: Bulwark
  limita los inicios de sesión, también los buenos) y bajo
  `withLock('bulwark')`. Los cambios que afectan a su marca llaman a
  `programarSincronizacionBulwark()`: la sincronización va en segundo plano
  y ninguna ruta la espera. Imágenes de marca: PNG, JPEG o WebP comprobados
  por su contenido, nunca SVG.
- **Web**: seguir `DESIGN.md` (tarjetas blancas, un solo acento petróleo,
  sin adornos de instrumento). Estados de carga (`Cargando`), vacío (`Vacio`,
  con el icono de la vista) y error (`AvisoError`) en cada vista; tablas
  regladas con flex, nunca `<table>`; enlaces con aspecto de botón mediante
  `estiloBoton`; sin desplazamiento horizontal en móvil.
- **Migraciones**: se añaden al final de `core/db.ts` (`018-…`); nunca se
  edita una publicada. Las que deben tolerar un esquema que ya tenga parte de
  lo que añaden (016 y 017, que la rama del cambio de dominio publicó con
  otros ids) usan `aplicar` en vez de `sql`.
- **Versión**: `config.version`, los tres `package.json`,
  `VERSION_INSTALADOR` de `deploy/instalar.sh` y la cabecera de
  `docs/PLAN.md` van sincronizados.
- **Dependencias e imágenes**: versión exacta siempre (`Dockerfile` y
  compose, nunca `1.7.x` ni `22-alpine`). Dependabot (`.github/dependabot.yml`)
  propone las nuevas y `parches-automaticos.yml` fusiona solo los parches
  cuando todo ha pasado. Stalwart solo recibe parches dentro de su serie;
  cambiar de serie es una migración (`mailway migrar-motor`).

## Seguridad (imprescindible)

- Un token de gestión de administración (el que usa Skyway) lo puede todo:
  ninguna comprobación de pertenencia puede depender solo del rol.
- La propiedad del dominio se exige a todos, también a la administración.
- Las cuentas de Cloudflare de la instancia solo las usa la administración
  (`soloCliente=1` lo fuerza aunque llegue un token de administración).
- Rutas públicas (autoconfiguración, `/api/public/*`, portal, webmail): sin
  datos de otros clientes, con límite de peticiones y sin registrar
  credenciales (Autodiscover nunca lee `Authorization`).
- Peticiones mutantes con cookie desde otro sitio: `403 cross_site_request`.
  La IP del cliente depende de `MAILWAY_TRUST_PROXY`: no la cambies a `true`.
- Detalle en `docs/SEGURIDAD.md`.

## Git

Desarrolla en la rama indicada por la tarea; no hagas push a otra rama sin
permiso explícito. No incluyas identificadores internos de modelo en commits
ni artefactos.
