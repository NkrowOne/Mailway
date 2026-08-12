# Mailway — Plan técnico y de producción

Este documento recoge las decisiones de arquitectura, el porqué de cada una,
el modelo de datos y el camino a producción. Es la referencia para cualquier
persona (o IA) que vaya a tocar el proyecto.

## 1. Qué es

Mailway convierte un servidor propio en un **servicio de correo comercial
multi-cliente**:

- El **administrador** (dueño del servidor) da de alta clientes y les asigna
  un plan con límites (dominios, buzones, alias, envíos de API).
- Cada **cliente** tiene su propio panel: gestiona sus buzones hasta el máximo
  de su plan, configura el DNS de sus dominios con un asistente con
  verificación en vivo, y crea claves de API para envíos automatizados
  (códigos OTP, avisos) vía `POST /v1/send`.
- Un **asesor de entregabilidad** explica en español qué falta (PTR, SPF,
  DKIM, DMARC, listas negras) y cómo arreglarlo.

## 2. Arquitectura

```
┌──────────────────────────── servidor ────────────────────────────┐
│  Traefik (Skyway) :80/:443                                       │
│    ├─ panel.dominio    → mailway-panel   (Node, vía Skyway)      │
│    ├─ webmail.dominio  → mailway-webmail (Roundcube, compose)    │
│    └─ mail.dominio     → mailway-mail:8080 (webadmin/API motor)  │
│                                                                  │
│  mailway-panel ──HTTP──► mailway-mail:8080 (API de gestión)      │
│       │  SQLite /data        │                                   │
│       └─SMTP 587────────────►│  Stalwart v0.15 (compose)         │
│                              │  :25 :465 :587 :993 directos      │
└──────────────────────────────────────────────────────────────────┘
```

**Tres piezas desacopladas:**

| Pieza | Qué es | Cómo se despliega | Por qué separada |
|---|---|---|---|
| Panel (`server/` + `web/`) | Fastify + React. Toda la lógica multi-cliente | Skyway desde GitHub (auto-deploy) | Es una web normal: un puerto, TLS de Traefik, redeploy por push |
| Motor (Stalwart v0.15) | SMTP/IMAP/antispam/DKIM real | `deploy/docker-compose.mail.yml` | Necesita 4+ puertos del host; Skyway publica solo 1 por servicio |
| Webmail (Roundcube) | Cliente web IMAP | mismo compose | Imagen oficial con parches de seguridad activos |

### Decisiones clave y su porqué

1. **Stalwart como motor, fijado a v0.15.5.** Un solo contenedor con SMTP,
   IMAP, filtro antispam, DKIM y **API REST de gestión** — sin pegamento
   Postfix+Dovecot+Rspamd. La v0.16 (abril 2026) **eliminó la API REST**
   (migró a JMAP), así que la imagen queda fijada: actualizar exige
   reescribir `server/src/engine/stalwart.ts` contra JMAP.
2. **Driver de motor intercambiable.** Las rutas nunca hablan con Stalwart:
   usan la interfaz `MailEngine` (`server/src/engine/types.ts`). Hay dos
   drivers: `stalwart` y `demo` (todo el panel funciona sin motor real, para
   probar o desarrollar). Migrar a otro motor = escribir un driver.
3. **Contraseñas hasheadas en el panel.** La API de Stalwart NO hashea lo que
   recibe: Mailway genera `$6$` (sha512-crypt, implementado y testeado contra
   los vectores oficiales en `server/src/core/sha512crypt.ts`) y nunca envía
   ni guarda contraseñas de buzón en claro.
4. **Claves de API → contraseñas de aplicación.** Cada clave de API crea en
   el buzón remitente un secret `$app$mailway-<prefijo>$<hash>` (formato
   nativo de Stalwart). Ventajas: no toca la contraseña del usuario, se
   revoca de forma independiente, y el SMTP autentica de verdad (nada de
   relay abierto interno).
5. **SQLite (better-sqlite3) para el panel.** Mismo criterio que Skyway: un
   solo servidor, cero dependencias pesadas, copia de seguridad = copiar un
   fichero. El correo en sí vive en el motor (RocksDB en su volumen).
6. **Secretos cifrados en reposo.** Credenciales del motor y contraseñas de
   aplicación SMTP se guardan cifradas con AES-256-GCM; la clave maestra se
   genera en el primer arranque y vive en `/data/.secret` (o `MAILWAY_SECRET`).
7. **Los límites del plan se imponen en el servidor.** `assertWithinLimit()`
   antes de crear dominios/buzones/alias; límites de la API por minuto
   (memoria) y por día (SQLite) por clave. El frontend solo los pinta.
8. **DNS con verificación en vivo.** El motor dicta los registros exactos
   (`GET /api/dns/records/{dominio}` incluye MX, SPF, DKIM con la clave
   pública real, DMARC, MTA-STS, SRV…); Mailway los consulta contra
   resolutores públicos (1.1.1.1/8.8.8.8) y compara. Las listas negras se
   consultan con el resolutor del sistema (Spamhaus rechaza resolutores
   públicos; su respuesta 127.255.255.x se trata como «no concluyente»).

## 3. Modelo de datos (SQLite, migraciones en `server/src/core/db.ts`)

```
plans        límites por plan (dominios, buzones, alias, cuota, API/día, API/min)
clients      cliente (empresa) → plan, suspensión
users        usuarios del panel: role admin (todo) | client (su cliente)
sessions     sesiones por cookie httpOnly (token hasheado, revocables)
domains      dominio → cliente, selector DKIM, último informe DNS (JSON)
mailboxes    buzón → dominio (local_part único por dominio), cuota, estado
aliases      alias → destinos (JSON), únicos frente a buzones
api_keys     prefijo público + hash de la clave, buzón remitente,
             credencial SMTP cifrada, límite diario opcional, revocación
messages     registro de cada envío por API (estado, error, message-id)
api_usage    contador diario por clave (límites)
audit_log    quién hizo qué, cuándo y desde qué IP
login_attempts  limitación de intentos por IP
settings     ajustes de instancia y del motor (secretos cifrados)
```

Reglas de integridad que protegen al usuario:

- No se puede borrar un plan en uso, ni un cliente con dominios, ni un buzón
  que sea remitente de una clave activa.
- Borrar un dominio con buzones exige teclear el dominio (confirmación
  proporcional al daño) y limpia primero el motor, luego el panel.
- Contraseñas y claves se muestran **una sola vez**; en BD solo hay hashes.

## 4. Seguridad

- Sesiones: cookie `httpOnly` + `SameSite=Lax`, token aleatorio hasheado
  (HMAC) en BD, expiración configurable, cierre del resto de sesiones al
  cambiar la contraseña.
- Login con límite de intentos por IP (8 cada 10 min).
- Autorización por capas: `requireAdmin` / `requireClientAccess` en cada
  ruta; un usuario de cliente no puede ni enumerar recursos ajenos.
- API transaccional: clave `mw_<prefijo>_<secreto>` — el prefijo localiza,
  el hash HMAC verifica; revocación inmediata; auditoría de uso.
- El panel valida todo con zod y devuelve errores en español listos para UI.
- El motor solo expone su API de gestión dentro de la red Docker (y opcional
  webadmin tras Traefik con TLS y su propia contraseña).

## 5. Frontend (dirección de diseño)

Mundo visual «central de clasificación postal» (ver contrato completo en el
comentario de `web/index.html` y sistema en `DESIGN.md`): chasis oscuro de
tres elevaciones, **etiquetas de papel** para todo lo que sale del sistema
(registros DNS, credenciales, datos de conexión), un único color de acción
(naranja de seguridad), estados que se **sellan** (VERIFICADO/REVOCADA),
tipografía Barlow/Barlow Condensed + Martian Mono para identificadores, y
medidores de carga del plan con graduación. Interfaz 100 % en español,
operable con teclado y con estados vacíos/carga/error en todas las vistas.

## 6. Camino a producción (resumen; guía completa en DESPLIEGUE-SKYWAY.md)

1. Puerto 25 de salida desbloqueado + PTR configurado (proveedor del server).
2. DNS: A de `mail.`, `panel.`, `webmail.` → IP del servidor.
3. `deploy/docker-compose.mail.yml` up (motor + webmail + red skyway-edge).
4. Panel vía Skyway: repo GitHub, puerto 4100, volumen `/data`, variables,
   dominio `panel.…`, webhook de auto-deploy.
5. Asistente de primera puesta en marcha (4 pasos) en el panel.
6. TLS del motor con el volcador de certificados de Traefik (perfil `tls`).
7. Primer cliente → manifiesto de puesta en marcha → mail-tester 10/10.
8. Calentamiento de IP progresivo antes de volumen real.

## 7. Límites conocidos y roadmap

**Limitaciones actuales (v0.1):**

- Alias solo hacia buzones internos (redirección externa: roadmap).
- Los planes de ejemplo se editan por API (`PATCH /api/plans/:id`); falta UI
  de edición de planes.
- Sin webhooks de eventos de envío (entregado/rebotado) hacia los clientes.
- La cola del motor se muestra agregada (pendientes), sin detalle por mensaje.
- Un solo administrador de instancia (no hay roles intermedios de staff).

**Roadmap sugerido, por orden de valor:**

1. **Editor de planes** en el panel de administración.
2. **Estadísticas de buzón** (ocupación real vía API del motor) y avisos de
   cuota.
3. **Webhooks de estado de envío** para las aplicaciones de los clientes.
4. **Redirecciones externas** en alias (vía sieve del motor).
5. **Plantillas transaccionales** con variables (`{{codigo}}`) versionadas.
6. **Passkeys** para el panel (mismo stack que Skyway).
7. **Import/export** de buzones (migración desde cPanel/otros).
8. **Módulo anti-abuso**: umbrales de rebote por clave, pausado automático.
9. **Driver JMAP** para Stalwart ≥ 0.16 cuando estabilicen la superficie de
   gestión.

## 8. Desarrollo local

```bash
npm install
npm run dev            # servidor :4100 (tsx watch) + web :5173 (vite)
MAILWAY_DEMO=1 npm run dev   # panel completo sin motor de correo real
npm run typecheck && npm test
```

Estructura: monorepo npm workspaces — `server/` (Fastify + better-sqlite3,
módulos en `src/modules/*`, drivers de motor en `src/engine/*`) y `web/`
(React + Vite + Tailwind, kit de UI en `src/ui/*`, páginas en `src/pages/*`).
