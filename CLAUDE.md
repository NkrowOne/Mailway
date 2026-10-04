# CLAUDE.md — guía del repositorio para agentes/LLM

Punto de entrada para navegar Mailway. Arquitectura, decisiones y modelo de
datos en **[docs/PLAN.md](docs/PLAN.md)**; despliegue en
**[docs/DESPLIEGUE-SKYWAY.md](docs/DESPLIEGUE-SKYWAY.md)**; API de envío en
**[docs/API.md](docs/API.md)**; API de gestión e integraciones (tokens,
Skyway, Cloudflare, autoconfiguración, portal, marca blanca) en
**[docs/INTEGRACIONES.md](docs/INTEGRACIONES.md)**; modelo de seguridad en
**[docs/SEGURIDAD.md](docs/SEGURIDAD.md)**. Sistema de diseño de la web en
**[DESIGN.md](DESIGN.md)** y producto en **[PRODUCT.md](PRODUCT.md)**.

## Qué es

Servicio de correo multi-cliente auto-alojado: el administrador da de alta
clientes con un plan; cada cliente gestiona sus dominios (DNS guiado o en
Cloudflare, con verificación de propiedad), buzones, alias, contraseñas de
aplicación y claves de API; los titulares configuran sus dispositivos con un
enlace de configuración o desde «Mi buzón». Motor Stalwart v0.15.5 (fijado),
webmail Roundcube, panel Node + SQLite. Se despliega junto a
[Skyway](https://github.com/NkrowOne/Skyway) (≥ 0.34 lo gestiona por
proyecto y publica sus rutas de Traefik) o de forma autónoma.

## Estructura

- `server/` — Node 20+/TypeScript/Fastify. `src/app.ts` construye la app
  (`buildApp()`: CSRF, sesión/token, rutas, manejador de errores);
  `src/index.ts` la pone a escuchar y arranca el vigilante.
  - `src/modules/`: un módulo por área. `auth` (sesiones, tokens `mwt_`,
    guardas), `tokens`, `integrations`, `audit`, `setup`, `settings`,
    `clients` (planes, clientes, usuarios, `assertWithinLimit`), `domains`
    (DNS y propiedad), `zonefile`, `deliverability`, `cloudflare`,
    `mailboxes` (buzones, altas masivas, alias), `direcciones` (usuario del
    motor de cada buzón, cambios abiertos y su conciliador),
    `domainmigrations` (cambio de dominio: plan, preparar, pasar, volver,
    cancelar y dar de baja), `apppasswords`, `portal`
    (enlaces de configuración, «Mi buzón», `/api/webmail/password`),
    `connection` (datos de conexión y generadores de autoconfiguración),
    `autoconfig` (rutas públicas y estado de los nombres), `whitelabel`
    (marca blanca y `/api/traefik/config`), `transactional` (claves y
    `/v1/send`), `engineops` (ajustes recomendados, TLS y ACME del motor),
    `nombreservidor` (lo que arrastra cambiar el nombre del servidor),
    `ipservidor` (IP de salida frente a la de Ajustes: aviso y «Usar esta IP»),
    `demo` (propiedad simulada solo con `MAILWAY_DEMO=1`), `alerts`,
    `watchdog`, `dashboard`.
  - `src/engine/`: interfaz `MailEngine` y drivers `stalwart` y `demo`.
  - `src/core/`: base de datos y migraciones (`db.ts`), cifrado, DNS,
    cliente de Cloudflare, cerrojos (`locks.ts`), errores, avisos,
    sha512-crypt, prueba del puerto 25 (`puerto25.ts`) y detección de la IP
    pública (`ippublica.ts`).
  - `src/tools/reset-password.ts`: restablecer la contraseña de un usuario
    del panel desde la terminal; `src/tools/emparejar.ts`: emparejado con
    Skyway (administrador, puesta en marcha con el entorno y token «Skyway»;
    una línea JSON por la salida estándar), que usa el instalador. Los pasos
    del asistente que comparte viven en `modules/setup.ts`;
    `src/tools/identidad.ts`: Ajustes adopta la identidad del entorno tras un
    cambio de dominio o de IP confirmado en el instalador (la comparación
    con el entorno, en `modules/entorno.ts`).
- `web/` — React + Vite + Tailwind. Panel en `src/pages/` (administración en
  `src/pages/admin/`), portal del titular en `src/pages/portal/`, kit de UI
  en `src/ui/`, componentes de área en `src/components/`, tipos y utilidades
  en `src/lib/`, esqueleto y navegación en `src/shell/AppShell.tsx`.
- `deploy/` — `instalar.sh` (instalador idempotente), compose del motor y el
  webmail (`docker-compose.mail.yml`) y autónomo
  (`docker-compose.standalone.yml`), `.env.example`, configuración de
  Roundcube (`roundcube/mailway.php`), plantilla del override de Traefik y
  punto de entrada de la imagen.
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
verificación mínima; la CI (`.github/workflows/ci.yml`) ejecuta los cuatro y
comprueba la sintaxis de `deploy/*.sh` (`bash -n`).

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
  (`buzonLockKey`) → `contrasenas-app:<id>`. Quien tiene uno solo pide los que
  van después; lo que habla con el motor con el usuario de un buzón relee la
  fila dentro de `buzon:<id>`.
- **Motor**: las rutas nunca hablan con Stalwart directamente, siempre vía
  `getEngine()`. Lo que identifica un buzón en el motor usa su usuario del
  motor (`loginParaMotor(id)`, o `loginDe(fila)` para mostrarlo), nunca su
  dirección, y los miembros de un alias van con `nombreEnMotor`. Stalwart
  0.15 devuelve los errores de gestión con HTTP 200 y cuerpo `{ error }`; el
  driver los convierte en `HttpError` 502
  (`engine_not_found`, `engine_exists`, `engine_error`,
  `engine_unreachable`). Los ajustes de Stalwart (`POST /api/settings`)
  exigen `assert_empty`.
- **Contraseñas de buzón**: se verifican en local contra el hash `$6$`
  (`engine.verifyCredentials`), nunca pidiendo al motor que autentique: los
  fallos alimentarían su bloqueo automático de IPs. Cambiar la principal con
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
- **Web**: seguir `DESIGN.md` (tarjetas blancas, un solo acento petróleo,
  sin adornos de instrumento). Estados de carga (`Cargando`), vacío (`Vacio`,
  con el icono de la vista) y error (`AvisoError`) en cada vista; tablas
  regladas con flex, nunca `<table>`; enlaces con aspecto de botón mediante
  `estiloBoton`; sin desplazamiento horizontal en móvil.
- **Migraciones**: se añaden al final de `core/db.ts` (`005-…`); nunca se
  edita una publicada.
- **Versión**: `config.version`, los tres `package.json`,
  `VERSION_INSTALADOR` de `deploy/instalar.sh` y la cabecera de
  `docs/PLAN.md` van sincronizados.

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
