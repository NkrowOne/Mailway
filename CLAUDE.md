# CLAUDE.md — guía del repositorio para agentes/LLM

Punto de entrada para navegar Mailway. Arquitectura y decisiones en
**[docs/PLAN.md](docs/PLAN.md)**; despliegue en
**[docs/DESPLIEGUE-SKYWAY.md](docs/DESPLIEGUE-SKYWAY.md)**; API de envío en
**[docs/API.md](docs/API.md)**; integraciones (Skyway, Cloudflare, tokens de
gestión, autoconfiguración) en **[docs/INTEGRACIONES.md](docs/INTEGRACIONES.md)**.
Sistema de diseño de la web en **[DESIGN.md](DESIGN.md)** y producto en
**[PRODUCT.md](PRODUCT.md)**.

## Qué es

Servicio de correo multi-cliente auto-alojado: el administrador da de alta
clientes con un plan, cada cliente gestiona sus dominios, buzones, alias y
claves de API desde su panel, y los titulares de los buzones configuran sus
dispositivos con un enlace o desde «Mi buzón». Motor Stalwart v0.15 (fijado),
webmail Roundcube, panel Node + SQLite. Se despliega junto a
[Skyway](https://github.com/NkrowOne/Skyway), que además puede gestionarlo.

## Estructura

- `server/` — Node 20+/TypeScript/Fastify. `src/app.ts` construye la app
  (`buildApp()`), `src/index.ts` la pone a escuchar y arranca el vigilante.
  Un módulo por área en `src/modules/`; drivers del motor en `src/engine/`
  (interfaz `MailEngine`, drivers `stalwart` y `demo`); utilidades en `src/core/`.
- `web/` — React + Vite + Tailwind. Páginas en `src/pages/`, kit de UI en
  `src/ui/`, portal del titular en `src/pages/portal/`.
- `deploy/` — compose del motor y el webmail, configuración de Roundcube e
  instalador (`deploy/instalar.sh`).
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
```

**`npm run typecheck`, `npm run lint`, `npm test` y `npm run build`** son la
verificación mínima; la CI (`.github/workflows/ci.yml`) ejecuta los cuatro.

Las pruebas viven en `server/test/*.test.ts`. `test/env.ts` da a cada fichero
una carpeta de datos temporal propia, activa el motor de demostración y el
modo sin red (`MAILWAY_DNS_OFFLINE=1`: el DNS devuelve «no se pudo
consultar»). `test/helpers.ts` crea la app, el administrador, clientes,
dominios y buzones para probar rutas reales con `app.inject()`.

## Convenciones

- **Idioma**: código, comentarios, mensajes de interfaz y de error en
  **español**. Los comentarios explican el *porqué*.
- **Registro de los textos**: profesional y neutro, tratamiento de usted,
  botones en infinitivo, sin coloquialismos (mismo criterio que
  `docs/ESTILO-TEXTOS.md` de Skyway). Terminología fija: buzón, alias, clave
  de API, token de gestión, plan, entregabilidad.
- **Rutas**: `requireAuth` / `requireAdmin` / `requireClientAccess` según el
  recurso; cuerpo validado con **zod**; `audit(req, 'area.accion', {...})` en
  las acciones sensibles (nunca con secretos).
- **Motor**: las rutas nunca hablan con Stalwart directamente, siempre vía
  `getEngine()`. Ojo: Stalwart 0.15 devuelve los errores de gestión con HTTP
  200 y cuerpo `{ error }`; el driver ya los convierte en `HttpError`.
- **Contraseñas de buzón**: se verifican en local contra el hash `$6$`
  (`engine.verifyCredentials`), nunca pidiendo al motor que autentique: los
  fallos alimentarían su baneo automático de IPs.
- **Secretos**: cifrados con `encryptSecret` si hay que recuperarlos; si no,
  solo hash. Contraseñas y tokens se muestran una sola vez.
- **Web**: seguir `DESIGN.md` (parte de laboratorio). Estados de carga, vacío
  y error en cada vista; sin scroll horizontal en móvil.
- **Versión**: `config.version`, los tres `package.json` y la cabecera de
  `docs/PLAN.md` van sincronizados.

## Git

Desarrolla en la rama indicada por la tarea; no hagas push a otra rama sin
permiso explícito. No incluyas identificadores internos de modelo en commits
ni artefactos.
