# Integraciones de Mailway

Cómo conectar Mailway con otras piezas:

- **cualquier sistema** (scripts, CI, agentes): API de gestión con tokens
  (secciones 1 y 2);
- **Skyway**: el correo de cada proyecto desde su panel (sección 3);
- **Cloudflare**: DNS de correo en un clic (sección 4);
- **programas de correo** de los titulares: autoconfiguración, enlaces de
  configuración y «Mi buzón» (secciones 5 y 6);
- **Traefik**: marca blanca y rutas (sección 7);
- **otras plataformas** que envían correo (sección 8);
- **webs estáticas**: formularios de contacto sin claves secretas (sección 9).

Base de todas las rutas: la URL pública del panel, p. ej.
`https://panel.miempresa.com`.

---

## 1. Tokens de gestión

Todo lo que hace el panel existe como ruta bajo `/api`. Para usarla desde
fuera se crea un **token de gestión** en **Conexiones → Tokens de gestión**.

- **Formato**: `mwt_<prefijo de 8 hexadecimales>_<secreto de 43 caracteres>`.
  Se muestra **una sola vez**; en la base de datos solo queda su hash. El
  prefijo, visible en el panel, sirve para reconocerlo.
- **Permisos**: los del usuario que lo crea. Un token de administración lo
  puede todo; el de un usuario de cliente solo ve y gestiona ese cliente. Si el
  usuario se deshabilita o cambia de rol, el token lo refleja en la siguiente
  petición.
- **Creación**: solo desde una sesión del panel, nunca con otro token (un
  token filtrado no puede perpetuarse creando más). Caducidad opcional de 1 a
  3650 días. Máximo **25 tokens activos** por usuario.
- **Revocación**: inmediata. El panel anota el último uso (fecha e IP).
- **Actividad**: cada acción hecha con un token queda en **Actividad** con
  `via: "token:<nombre>"` en el detalle.

```bash
BASE="https://panel.miempresa.com"
TOKEN="mwt_..."

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/auth/me"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/integrations/info"
```

### 1.1 Reglas de la cabecera `Authorization`

- Con `Authorization: Bearer …` **no se lee la cookie** de sesión, aunque
  venga: una llamada de máquina actúa siempre con la identidad de su token, y
  un token no válido nunca «cae» a la sesión de un navegador.
- Las peticiones con `Authorization` no pasan por la protección CSRF (no usan
  cookies).
- `GET /api/auth/me` devuelve `{ user, via }`, con
  `via = { kind: "token", tokenId, name }` o `{ kind: "session" }`.

### 1.2 Rutas de tokens

| Método y ruta | Descripción |
|---|---|
| `GET /api/tokens` | Tokens propios (`{ tokens }`). La administración ve los de todos con `?all=1`. |
| `POST /api/tokens` | `{ name (1–60), expiresInDays? (1–3650 o null) }` → `{ token, info }`. **Solo con sesión del panel.** |
| `DELETE /api/tokens/:id` | Revoca → `{ ok, token }`. Idempotente. Un token ajeno responde `404 token_not_found`. |

`info`: `{ id, name, prefix, createdAt, expiresAt, lastUsedAt, lastUsedIp,
revokedAt, status: active|expired|revoked, userId, ownerEmail, ownerName,
ownerRole, ownerClientId, ownerClientName, current }`.

### 1.3 Errores de autenticación

| HTTP | `code` | Causa |
|---|---|---|
| `401` | `unauthorized` | Sin sesión ni token |
| `401` | `invalid_token` | El token no tiene el formato `mwt_…` o no existe |
| `401` | `token_revoked` | Token revocado |
| `401` | `token_expired` | Token caducado |
| `401` | `token_user_disabled` | El usuario dueño del token está deshabilitado |
| `401` | `api_key_not_allowed` | Se ha usado una clave de envío `mw_…` en `/api` (solo vale en `/v1/send`) |
| `401` | `bad_credentials` | Inicio de sesión del panel (`POST /api/auth/login`) con un correo o una contraseña incorrectos, o con un usuario deshabilitado. Mismo mensaje en todos los casos: «El correo electrónico o la contraseña no son correctos.» |
| `403` | `session_required` | Operación reservada a la sesión del panel: crear tokens, cambiar la contraseña del panel y conectar, cambiar o probar el motor de correo (sección 2.9) |
| `403` | `forbidden` | El usuario no tiene acceso a ese cliente o la operación es de administración |
| `403` | `cross_site_request` | Petición con cookie enviada desde otro sitio web (CSRF) |
| `409` | `token_limit` | Ya hay 25 tokens activos |
| `429` | `rate_limited` | Inicio de sesión del panel bloqueado de forma temporal: 8 fallos desde la misma IP, o 10 con el mismo correo, en los últimos 10 minutos |

> Las claves `mw_…` solo sirven para **enviar** correo por `POST /v1/send`
> ([API.md](API.md)). No dan acceso a la gestión.

---

## 2. API de gestión: referencia

### 2.1 Convenciones

- Cuerpos y respuestas en JSON. Los errores llegan siempre como
  `{ "error": "<mensaje en español listo para mostrar>", "code": "<código>" }`;
  los de validación (`400 validation`) añaden `issues: [{ path, message }]`.
- Los errores del motor de correo se devuelven como `502` con
  `engine_unreachable`, `engine_error`, `engine_not_found` o `engine_exists`.
  `engine_not_found` significa que el motor no encuentra un elemento concreto
  (Stalwart 0.15 lo comunica con HTTP 200 y `{ error }`). Un HTTP 404 del
  motor es otra cosa, una ruta de gestión desconocida por una URL del motor
  mal configurada, y se devuelve como `engine_error`: tomarlo por «no existe»
  daría por hechos borrados que no se han realizado.
- Contraseñas, tokens y claves se devuelven **una sola vez**, en la respuesta
  que los crea.
- Un usuario de cliente solo ve lo suyo: los filtros `clientId` de las rutas
  de listado solo los usa la administración.

### 2.2 Rutas pensadas para integraciones

| Método y ruta | Quién | Descripción |
|---|---|---|
| `GET /api/integrations/info` | cualquiera autenticado | `{ version, brandName, mailHostname, webmailUrl, panelUrl, imap, smtp, submission, user, features: { cloudflare, autoconfig, portal, cloudflareSoloCrear }, traefik }`. `imap` es 993 SSL/TLS, `smtp` 465 SSL/TLS y `submission` 587 STARTTLS. `traefik` = `{ configPath, token }` solo para la administración (`null` en otro caso). Un cliente con webmail de marca propia recibe su URL. `features.cloudflare` indica si ese usuario puede usar alguna cuenta de Cloudflare: la administración, cualquiera; un cliente, solo las suyas (las de la instancia no cuentan). `features.cloudflareSoloCrear` (siempre `true` desde la 1.1) es un compromiso para quien integra: el alta con `autoDns` y el registro de marca blanca con `soloCrear` solo crean lo que falta (nunca modifican un registro existente) y la cuenta de la instancia asociada a un dominio nunca se usa en nombre de un cliente; Skyway no pide el DNS automático del correo a un Mailway que no lo declare. |
| `POST /api/integrations/clients/ensure` | administración | `{ externalRef, name, contactEmail?, planId? }` → `{ client, created }`. Idempotente: si ya existe un cliente con esa referencia se devuelve sin modificarlo. Sin `planId` usa el primer plan. |
| `GET /api/integrations/clients/by-ref?externalRef=` | administración | `{ client }` o `404 client_not_found`. |
| `PUT /api/integrations/clients/:id/link` | administración | `{ externalRef }` → `{ client }`. Vincula un cliente existente. |
| `DELETE /api/integrations/clients/:id/link` | administración | Quita la referencia (no borra nada más) → `{ client }`. Con `?externalRef=<referencia>` solo la quita si sigue siendo esa (ver debajo); sin el parámetro, siempre. |
| `GET /api/integrations/clients/:id/summary` | acceso al cliente | Todo en una llamada: `{ client: { id, name, slug, externalRef, suspended }, plan, usage, domains, mailboxes, apiKeys, appPasswords, connection: { imap, smtp, submission, webmailUrl } }`. Un usuario de otro cliente recibe `403` exista o no el id. |

Reglas de `externalRef`: de 3 a 200 caracteres (letras, números, `:`, `.`,
`_`, `-`), empezando por letra o número; p. ej. `skyway:project:<id>`. Es
única entre clientes. El nombre (`name`) tiene de 2 a 80 caracteres; si el
*slug* ya existe se añade un sufijo (`acme-2`, `acme-3`…).

**Desvinculación condicional.** Con el parámetro `externalRef`
(`DELETE /api/integrations/clients/:id/link?externalRef=<referencia>`), la
referencia se quita solo si el cliente sigue vinculado a esa. Así una
integración que se desactiva (Skyway, al desactivar el correo de un proyecto o
al borrarlo) no puede quitarle el cliente a otra que lo reclamó entre su
comprobación y la llamada: si el cliente lleva otra referencia, responde
`409 external_ref_mismatch` y no cambia nada. Si no lleva ninguna, responde
`200` sin cambios. Sin el parámetro, desvincula siempre.

| Código | Cuándo |
|---|---|
| `400 plan_not_found` | `planId` no existe |
| `409 no_plans` | No hay ningún plan definido |
| `409 external_ref_in_use` | La referencia ya está vinculada a otro cliente |
| `409 external_ref_mismatch` | Desvinculación condicional: el cliente está vinculado a otra referencia |
| `404 client_not_found` | No hay cliente con esa referencia o ese id |

### 2.3 Clientes, planes y usuarios (administración)

| Método y ruta | Descripción |
|---|---|
| `GET /api/plans` | `{ plans }`, cada uno con `clientCount`. |
| `POST /api/plans` · `PATCH /api/plans/:id` · `DELETE /api/plans/:id` | Campos: `name`, `maxDomains`, `maxMailboxes`, `maxAliases`, `mailboxQuotaMb` (64–1048576), `apiDailyLimit` (0 = sin límite), `apiPerMinuteLimit` (≥ 1), `notes`. Los dos límites de envío se aplican al cliente en conjunto, sumando todas sus claves ([API.md](API.md#17-límites)). Borrar: `409 plan_in_use` o `409 last_plan`. Nombre repetido: `409 plan_exists`. |
| `GET /api/clients` | Clientes con `plan` y `usage` (`{ domains, mailboxes, aliases, apiKeys, messagesLast30d }`). |
| `POST /api/clients` | `{ name, planId, contactEmail?, notes?, user?: { email, name, password? } }` → `{ client, user?, password? }` (`password` solo si se generó). |
| `GET /api/clients/:id` | `{ client, plan, usage, users }` (también accesible al propio cliente, que no recibe `notes`: son notas internas de la administración). |
| `PATCH /api/clients/:id` | `{ name?, contactEmail?, planId?, notes?, suspended? }` → `{ client, suspension? }`. Un plan por debajo del uso actual: `409 plan_below_usage`. Suspender o reactivar se aplica a todos los buzones en el motor: `suspension = { updated, skipped, failed: [{ email, error }] }`; repetir la petición reintenta los fallidos. |
| `DELETE /api/clients/:id` | `409 client_has_domains` si aún tiene dominios. |
| `POST /api/clients/:id/users` | `{ email, name, password? }`. Correo repetido: `409 user_exists`. |
| `PATCH /api/clients/:id/users/:userId` | `{ name?, password?, generatePassword?, disabled? }`. |
| `DELETE /api/clients/:id/users/:userId` | Elimina el usuario. |
| `POST /api/clients/:id/invites` | **Enlace de bienvenida** para la persona de contacto (ver abajo). `{ email, name?, ttlHours? (1–720, 168 por defecto) }` → `{ invite: { id, url, email, name, expiresAt, existingUser } }`. Correo de un usuario de **este** cliente: se admite (`existingUser: true`; al aceptarlo elige una contraseña nueva). Correo de la administración o de un usuario de otro cliente (sin distinguir mayúsculas): `409 user_exists`; cliente suspendido: `400 client_suspended`. |
| `POST /api/clients/:id/onboarding-reset` | **Solo administración con sesión del panel** (un token de gestión, también el de administración: `403 session_required`). Reinicia la puesta en marcha del cliente (sección 2.7). `{ revokeAppPasswords? (false por defecto) }` → `{ reset, skipped, failed: [{ email, error }] }`. Cliente suspendido: `400 client_suspended`; sin motor configurado: `400 engine_not_configured`. |
| `GET /api/clients/:id/invites` | Últimos 50: `{ invites: [{ id, email, name, createdAt, expiresAt, openedAt, acceptedAt, revokedAt, status (pending\|accepted\|expired\|revoked), recoverable }] }`. |
| `GET /api/clients/:id/invites/:inviteId/url` | Vuelve a dar la URL de un enlace pendiente → `{ invite }`. Usado, revocado o caducado: `404 invite_invalid`; ilegible: `409 invite_not_recoverable`. |
| `DELETE /api/clients/:id/invites/:inviteId` | Revoca un enlace pendiente. |

**Enlace de bienvenida.** Es para la empresa, no para un buzón: la persona de
contacto lo abre (`<panel>/bienvenida/<token>`, con el dominio de marca blanca
del panel del cliente si lo tiene activo), crea su propio acceso al panel
—nadie le dicta una contraseña— y entra en la **puesta en marcha**: dominio y
DNS, los buzones de su equipo de una vez (cada uno con su enlace de
configuración), postmaster y abuse, y sus dispositivos. Solo la
administración lo crea, lo vuelve a enviar o lo revoca. Sirve una vez y caduca
(7 días por defecto); uno nuevo para el mismo correo sustituye al pendiente.
El token se busca por su hash y se guarda además cifrado mientras está
pendiente. Si el correo ya es de un usuario del mismo cliente (habitual tras
reiniciar la puesta en marcha), el enlace no crea otro: esa persona elige una
contraseña nueva para su usuario. Nunca sirve para una cuenta de la
administración ni de otro cliente; se comprueba al crearlo y otra vez al
aceptarlo, por si el correo ha cambiado de manos. Rutas del enlace (60
peticiones por minuto e IP):

| Ruta | Descripción |
|---|---|
| `GET /api/invite/:token` | `{ clientName, brandName, email, name, expiresAt, existingUser }`. `existingUser: true` si el correo ya es de un usuario de ese cliente (la página dice «Elige una contraseña nueva» en vez de «Crea tu acceso»). No existe, caducó o se revocó: `404 invite_invalid`; ya usado: `409 invite_used`; cliente suspendido: `403 client_suspended`. |
| `POST /api/invite/:token/accept` | `{ name (2–80), password (10–200) }` → crea el usuario del cliente, abre su sesión del panel y devuelve `{ ok, redirect: '/puesta-en-marcha' }`. Si el correo ya es de un usuario de ese cliente, `name` es opcional (vacío o ausente conserva el suyo) y, en vez de crear otro usuario, le pone la contraseña elegida, lo habilita si estaba deshabilitado y cierra sus demás sesiones. Si ahora es de la administración o de otro cliente: `409 user_exists` y el enlace sigue pendiente. Queda en la actividad como `client.invite_accepted` con `existing`. Al abrir una sesión, pasa la protección CSRF de las peticiones con cookie (solo desde el propio panel). |

### 2.4 Dominios

| Método y ruta | Descripción |
|---|---|
| `GET /api/domains?clientId=` | `{ domains: DomainRecord[] }`. |
| `POST /api/domains` | `{ domain, clientId?, autoDns? }` → `{ domain, cloudflare, cloudflareReason? }`. Admite dominios con acentos o «ñ» (se guardan en *punycode*). Con `autoDns: true` aplica el DNS en Cloudflare (sección 4; con `?soloCliente=1`, solo con las cuentas del cliente, sección 4.3). Dominio ya dado de alta, incluso por otra petición simultánea: `409 domain_exists`. Dominio cuyo DNS escribió la administración con una cuenta de la instancia para otro cliente: `409 domain_reserved` (sección 4.3), salvo que lo dé de alta la administración sin `soloCliente`. |
| `GET /api/domains/:id` | `{ domain }`. |
| `GET /api/domains/:id/dns` | `{ records: [{ type, name, content, required, category }], mxInternos }`, sin punto final, sin SRV de puertos que no se publican y sin registros de la web del dominio raíz ni de `www` (A, AAAA, CNAME, HTTPS y SVCB). `category` es `obligatorio`, `autoconfiguracion`, `verificacion` (el TXT de propiedad, con `required: false`) o `endurecimiento` (MTA-STS y TLS-RPT). `mxInternos` lista los destinos MX que propone el motor y son nombres internos (ver «MX interno»); si no está vacío, no publiques la tabla. |
| `GET /api/domains/:id/zonefile?nivel=obligatorios\|recomendados\|completo` | Fichero de zona BIND para importar (`recomendados` por defecto). Incluye el TXT de verificación salvo en `obligatorios`. Nunca incluye registros de la web del dominio raíz ni de `www`: si el motor propusiera alguno, la cabecera del fichero lo dice. Con un MX interno: `409 mx_hostname_internal`. |
| `GET /api/domains/:id/conflicto` | ¿El dominio ya recibe correo en otro proveedor? → `{ hayOtroProveedor, mxActuales, spfActual, dmarcPolitica, aviso, mxInternos, avisoServidor }`. Los MX publicados se comparan con el nombre del servidor de Ajustes y con los destinos MX que genera el motor; si el motor no responde, solo con el de Ajustes. `dmarcPolitica` es `null` si hay varios DMARC. `avisoServidor` explica `mxInternos` (null si está vacío). |
| `POST /api/domains/:id/verify` | Mide el DNS y actualiza el estado → `{ domain }`; mientras la propiedad esté pendiente, la comprueba también. Con `?auto=1` (sondeo) no se anota cada vuelta en la actividad. |
| `POST /api/domains/:id/dkim` | Regenera las claves DKIM en el motor. |
| `DELETE /api/domains/:id?confirm=<dominio>` | Borra buzones, alias y dominio → `{ ok, apiKeysRevoked, aliasesUpdated, aliasesDeleted }` (ver «Baja de un dominio»). Con buzones exige `confirm` (`409 needs_confirmation`, que ya indica cuántas claves de API dejarán de funcionar). Si el motor falla a mitad: `502 partial_delete` (repetir completa el borrado). |

`DomainRecord`: `{ id, clientId, domain, domainUnicode, status:
pending_dns|active|error, dkimSelector, dnsStatus: { checks, requiredTotal,
requiredOk, allRequiredOk, checkedAt }, lastCheckedAt, verifiedAt, createdAt,
cloudflare: { accountId, zoneId } | null, dnsAppliedAt, ownershipVerifiedAt,
ownershipRecord: { type: "TXT", name, content } }`.

Cada elemento de `checks` es `{ id, label, type, name, expected, found, status:
ok|missing|mismatch|unknown, required, help, engineMissing? }`. `found` es lo
que devuelve el DNS público (`null` si no se pudo consultar; cadena vacía si no
existe). `unknown` significa que no se pudo consultar, no que falte.

**Comprobación DNS.** Se mide lo que genera el motor tras la selección común
(la misma que la tabla, el fichero de zona y Cloudflare), con estas reglas:

- **MX**: en rango si apunta al servidor y ningún MX de otro proveedor tiene la
  misma o mayor preferencia. Cualquier prioridad vale, y un segundo MX propio o
  un respaldo con menor preferencia no lo estropean.
- **SPF**: uno solo por nombre (con dos, ninguno vale). Uno propio vale si
  autoriza al servidor **antes de `all`**: `mx`, `+mx`, `mx:<el propio
  dominio>` o `mx/24`, una `ip4:` que contenga la IP pública del servidor, o los
  mismos mecanismos (`a`, `ip4:`, `include:`…) que proponga el motor. Lo que va
  detrás de `all` no se evalúa, y `help` lo indica.
- **DMARC**: uno solo por nombre (con varios, los receptores no aplican
  ninguno) y con una política `p=none`, `p=quarantine` o `p=reject`; se
  admiten espacios (`p = reject`).
- **SRV**: se comparan destino y puerto; la prioridad y el peso no cuentan.
- **A y AAAA**: se consultan de verdad; las IPv6 se comparan en forma canónica.
- **Registros que el motor no generó**: si falta un obligatorio (MX, SPF, DKIM
  o DMARC) en lo que devuelve el motor, por ejemplo porque la creación de la
  clave DKIM falló, la comprobación añade una medida con `engineMissing: true`,
  `status: "missing"`, `expected` vacío e `id` `motor:mx`, `motor:spf`,
  `motor:dkim` o `motor:dmarc`. El dominio no puede quedar activo hasta que el
  motor la genere (para el DKIM, `POST /api/domains/:id/dkim`).

**MX interno.** Si el motor propone como destino MX un nombre interno (sin
punto, como el identificador del contenedor de Stalwart sin `server.hostname`;
`localhost`; una IP; una última etiqueta numérica; o los sufijos `.local`,
`.internal`, `.lan`, `.docker`, `.localdomain` y `.home.arpa`), ningún servidor
de Internet podría entregar correo al dominio. La medida del MX queda fuera de
rango aunque el DNS coincida, el fichero de zona, el plan y la aplicación en
Cloudflare responden `409 mx_hostname_internal` (sin escribir nada), y
`/conflicto` y `/dns` lo indican en `mxInternos`. Se corrige fijando el nombre
del servidor de correo (Ajustes → Servidor de correo, «Aplicar ajustes
recomendados») y volviendo a medir.

**Propiedad del dominio.** Cada dominio expone `ownershipVerifiedAt` (fecha en
que quedó comprobada; `null` si está pendiente) y `ownershipRecord` (el TXT que
la prueba). Nadie (ni la administración ni un token) puede crear buzones ni
alias en un dominio cuya propiedad no se ha comprobado:
`409 domain_ownership_pending`. La propiedad queda comprobada, y no se vuelve a
perder, cuando al medir el DNS (con `POST /api/domains/:id/verify` o por el
vigilante):

- algún MX del dominio, de cualquier prioridad, apunta al servidor de correo de
  la instancia, o
- existe el TXT `_mailway.<dominio>` con el valor
  `mailway-verificacion=<token>` (`ownershipRecord`; el token es estable y
  propio de cada dominio y de cada instancia).

Una consulta DNS que falla no cuenta como «no»: la propiedad sigue pendiente
hasta la siguiente medición. El TXT permite preparar los buzones antes de mover
el MX desde otro proveedor. Figura en la tabla de registros con la categoría
`verificacion` y en el fichero de zona de los niveles `recomendados` y
`completo`; el nivel `obligatorios` no lo incluye, porque un MX hacia el
servidor ya prueba la propiedad. **Aplicar en Cloudflare** lo crea cuando se
aplica lo recomendado (el valor por defecto). Si la zona está activa en
Cloudflare, escribirlo prueba la propiedad al instante; si está pendiente de
activación, no prueba nada. Los dominios de versiones anteriores que ya estaban
verificados o tenían buzones o alias quedaron comprobados al actualizar.

**Baja de un dominio.** La respuesta es
`{ ok: true, apiKeysRevoked, aliasesUpdated, aliasesDeleted }`:

- `apiKeysRevoked`: número de claves de API activas cuyo remitente era un
  buzón del dominio; dejan de funcionar y se eliminan con él.
- `aliasesUpdated`: direcciones de alias de **otros** dominios que reenviaban a
  buzones del dominio borrado y a los que se les ha quitado ese destino.
- `aliasesDeleted`: direcciones de alias de otros dominios que se han eliminado
  por quedarse sin destinos.

Los alias del propio dominio se borran con él y no figuran en la respuesta.

### 2.5 Buzones y alias

| Método y ruta | Descripción |
|---|---|
| `GET /api/mailboxes?clientId=&domainId=` | `{ mailboxes }`, con `usedBytes` (ocupación leída del motor, en caché unos minutos; `null` = sin dato), `photoUpdatedAt` (`null` = sin foto), `configuredAt` y `setup` (ver «Buzón configurado», abajo). |
| `POST /api/mailboxes` | `{ domainId, localPart, displayName?, password? (10–200), quotaMb? }` → `{ mailbox, password? }` (`password` solo si se generó). La cuota se acota a la del plan. |
| `POST /api/mailboxes/bulk` | `{ domainId, entries: [{ localPart, displayName? }] (1–100), quotaMb?, dryRun? }`. Con `dryRun: true` solo valida y devuelve `{ dryRun, capacity, valid, exceedsPlan, ownershipPending, ownershipError, results }`; con la propiedad del dominio pendiente, cada línea sale con su error y no se responde `409`. Si no, exige la propiedad (`409 domain_ownership_pending`), comprueba el plan para el lote entero antes de crear ninguno y devuelve `{ results (con la contraseña de cada buzón creado), created, failed, capacity }`. Otro lote en curso: `409 bulk_in_progress`. Con `setupLinks: { ttlHours? (1–720, 72) }`, cada buzón creado lleva además `setupLink: { id, url, expiresAt, hasPassword }`: su enlace de configuración con la contraseña dentro, listo para enviar a su titular. |
| `PATCH /api/mailboxes/:id` | `{ displayName?, quotaMb?, status?: active\|suspended }`. Reactivar con el cliente suspendido: `409 client_suspended`. |
| `POST /api/mailboxes/:id/password` | `{ password? }` → `{ ok, password? }`. Sin cuerpo genera una. **Desconecta los dispositivos** que usan la contraseña principal; las contraseñas de aplicación siguen valiendo. Cierra las sesiones de «Mi buzón» y borra la contraseña guardada en los enlaces de configuración. |
| `DELETE /api/mailboxes/:id` | → `{ ok, aliasesUpdated, aliasesDeleted }`: antes de borrar, quita el buzón de los alias que reenvían a él (y borra los que se quedan sin destinos). Remitente de una clave activa: `409 mailbox_in_use`. |
| `GET /api/mailboxes/:id/connection` | Datos de conexión (sección 5.3). |
| `GET /api/mailboxes/:id/mobileconfig` | Perfil de Apple del buzón, sin contraseña. Sin nombre de servidor configurado: `409 mail_hostname_missing`. |
| `GET\|PUT\|DELETE /api/mailboxes/:id/photo` | Foto del buzón (ver «Perfil del buzón», abajo). `PUT { photo }` → `{ photoUpdatedAt }`. |
| `POST /api/mailboxes/:id/configured` | `{ configured: boolean }` → `{ configuredAt }`. Marca a mano el buzón como configurado (el titular puso los datos a mano) o lo desmarca. Conserva el primer momento si ya lo estaba. Queda en la actividad como `mailbox.marked_configured`. |
| `GET\|PUT /api/domains/:id/essential-addresses` | **postmaster@ y abuse@** del dominio → `{ addresses: [{ localPart, email, kind: alias\|mailbox\|null, destinations }] }`. `PUT { destinations (1–20) }` los crea o actualiza como alias (mismas reglas de destinos que los alias); un buzón con ese nombre se deja como está. Exige la propiedad del dominio. |
| `GET /api/aliases?clientId=&domainId=` | `{ aliases }`, cada uno con `destinations` y `externalDestinations`. |
| `POST /api/aliases` | `{ domainId, localPart, destinations (1–20) }`. |
| `PATCH /api/aliases/:id` | `{ destinations }`: sustituye los destinos. |
| `DELETE /api/aliases/:id` | Elimina el alias. |

postmaster@ y abuse@ (RFC 5321 y 2142) **no cuentan para el límite de alias
del plan**, se creen con la ruta anterior o como alias normales.

Los destinos de un alias pueden ser buzones del **mismo cliente** o direcciones
externas (reenvío a otro proveedor). Una dirección de un dominio de esta
instancia que no es un buzón existente se rechaza en lugar de salir a Internet.

**Perfil del buzón.** El nombre visible y la foto los puede poner quien
administra (aquí), el titular en el onboarding (sección 6.1) o en «Mi buzón»
(6.2); el webmail los usa (6.3). La foto viaja como data URL en JSON
(`{ "photo": "data:image/jpeg;base64,…" }`): solo JPEG, PNG o WebP
**comprobados por su firma**, hasta 512 KB (`400 invalid_photo`, `400
photo_too_large`). La web la recorta y la reduce a 256×256 JPEG antes de
subirla, lo que además quita los metadatos. Se sirve con su tipo real,
`nosniff`, `Content-Security-Policy: default-src 'none'` y caché privada de 5
minutos; las URL llevan `?v=<photoUpdatedAt>`. Sin foto: `404
photo_not_found`. Cambios en la actividad: `mailbox.photo_updated`,
`mailbox.photo_removed` y, desde el titular, `portal.profile_updated`,
`portal.photo_updated` y `portal.photo_removed`.

**Buzón configurado.** Cada buzón lleva:

```json
{
  "configuredAt": 1791475119879,
  "setup": {
    "lastLinkAt": 1791475119877,
    "lastOpenedAt": null,
    "lastEmail": { "to": "ana@gmail.com", "at": 1791475119879, "status": "sent" }
  }
}
```

- `configuredAt` (`null` = sin configurar) es el **primer** momento en que el
  titular demostró tener acceso: pulsó «Ya lo he configurado» en el enlace de
  configuración, descargó el perfil de Apple, entró en «Mi buzón» o en el
  webmail; o se marcó a mano. Vuelve a `null` cuando el panel deja sus
  dispositivos sin acceso: contraseña nueva desde el panel
  (`POST …/password`), reinicio del buzón (`POST …/setup-reset`) o de la
  puesta en marcha del cliente (`POST /api/clients/:id/onboarding-reset`), o
  el correo de configuración con contraseña nueva (sección 2.7). No cambia cuando el
  titular cambia su contraseña desde «Mi buzón» o el webmail.
- `setup.lastLinkAt` y `setup.lastOpenedAt`: creación del último enlace de
  configuración y última apertura de cualquiera de ellos (de cualquier
  estado; `null` si no hay).
- `setup.lastEmail`: último correo de configuración (sección 2.7), enviado
  (`sent`) o fallido (`failed`), con la dirección a la que se envió; `null` si
  no hay ninguno o se reinició la configuración.

Errores frecuentes de altas:

| Código | Cuándo |
|---|---|
| `400 plan_limit_reached` | Se superaría el máximo de dominios, buzones o alias del plan |
| `400 client_suspended` | El cliente está suspendido: no se crean recursos |
| `409 domain_ownership_pending` | La propiedad del dominio no está comprobada (buzones, altas masivas y alias; sección 2.4) |
| `400 invalid_local_part` | Nombre no válido (solo `a-z`, `0-9`, `.`, `-`, `_`; sin símbolo al principio o al final ni `..`) |
| `400 reserved_address` | `configuration@` está reservada: desde ella se envían los correos de configuración (buzones, altas masivas, también en la revisión con `dryRun`, y alias) |
| `409 mailbox_exists` · `409 alias_exists` | Ya existe un buzón o un alias con esa dirección |
| `400 alias_loop` | El alias se reenvía a sí mismo |
| `400 destination_other_client` | El destino es un buzón de otro cliente |
| `400 destination_not_found` | El destino es de un dominio de esta instancia pero no existe |

Las altas de un mismo cliente (dominios, buzones, alias) se ejecutan en fila:
varias peticiones simultáneas nunca superan el plan.

### 2.6 Contraseñas de aplicación

Una por dispositivo o programa (el móvil, una aplicación de Skyway…). Se
revocan una a una sin tocar la contraseña principal. Usuario IMAP/SMTP: la
dirección completa del buzón.

| Método y ruta | Descripción |
|---|---|
| `GET /api/mailboxes/:id/app-passwords` | `{ appPasswords: [{ id, mailboxId, email, name, createdAt, revokedAt }] }`. |
| `POST /api/mailboxes/:id/app-passwords` | `{ name (1–60) }` → `{ appPassword, password, snippets }` con `Cache-Control: no-store`; **`password` y `snippets` solo aparecen aquí**. Máximo 25 activas por buzón: `409 app_password_limit`. |
| `DELETE /api/mailboxes/:id/app-passwords/:appId` | Revoca al instante → `{ ok }`. |

El máximo de 25 contraseñas activas por buzón se comprueba al crearlas, sea cual
sea la vía: este panel y las integraciones con token (también la conexión de un
servicio desde Skyway) y «Mi buzón» (`POST /api/portal/app-passwords`). Todas
responden `409 app_password_limit`; hay que revocar alguna antes de crear otra.
Con el cliente o el buzón suspendido no se crean (`400 client_suspended`,
`400 mailbox_suspended`). Las altas de un mismo buzón se ejecutan en fila, así
que varias peticiones simultáneas no superan el máximo. No cuentan las
credenciales SMTP que crea cada clave de API ([API.md](API.md)).

Una contraseña de aplicación **no sirve** para entrar en «Mi buzón» ni para
cambiar la contraseña principal (`400 app_password_not_allowed`): quien
encuentre un móvil perdido no puede adueñarse del buzón.

**Variables listas para copiar.** La respuesta del alta (en el panel y en
`POST /api/portal/app-passwords`) incluye `snippets`, bloques
`{ id, label, language, filename, content }` para conectar una aplicación por
SMTP, que el panel y «Mi buzón» muestran en pestañas con botón de copiar:

| `id` | Contenido |
|---|---|
| `env` | `SMTP_HOST` (servidor de correo), `SMTP_PORT=587`, `SMTP_SECURE=false` (STARTTLS), `SMTP_USER` y `SMTP_FROM` (la dirección del buzón) y `SMTP_PASS` (la contraseña). |
| `node` | Transporte de **nodemailer** que lee `SMTP_*` del entorno y un envío de prueba. |
| `laravel` | `.env` de Laravel (`MAIL_MAILER=smtp`, `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_ENCRYPTION=tls` para Laravel 10 o anterior y `MAIL_SCHEME=smtp` para Laravel 11 o posterior). |
| `django` | `settings.py` con `EmailBackend` SMTP que lee `SMTP_*` del entorno y la orden de prueba `sendtestemail`. |

Son los mismos nombres y el mismo puerto que Skyway inyecta en modo SMTP. Los
bloques se generan en `server/src/modules/connection.ts`, como el resto de
datos de conexión, y **no se pueden volver a generar**: la contraseña no se
guarda en claro.

### 2.7 Enlaces de configuración

| Método y ruta | Descripción |
|---|---|
| `POST /api/mailboxes/:id/setup-links` | `{ includePassword?, password?, ttlHours? (1–720, 72 por defecto) }` → `{ link: { id, url, expiresAt, hasPassword } }`. `url` = `<panel>/conectar/<token>`. |
| `GET /api/mailboxes/:id/setup-links` | Últimos 50: `{ links: [{ id, createdAt, expiresAt, lastOpenedAt, revokedAt, hasPassword, recoverable }] }`. |
| `GET /api/mailboxes/:id/setup-links/:linkId/url` | **Solo administración.** Vuelve a dar la URL de un enlace activo → `{ link: { id, url, expiresAt, hasPassword } }`. Caducado o revocado: `404 setup_link_invalid`; creado antes de la 1.3 (sin token guardado): `409 setup_link_not_recoverable`. Queda en la actividad como `mailbox.setup_link_viewed`. |
| `DELETE /api/mailboxes/:id/setup-links/:linkId` | Revoca el enlace y borra su contraseña → `{ ok }`. |
| `POST /api/mailboxes/:id/setup-reset` | Reinicia la configuración del buzón (ver abajo). `{ revokeAppPasswords? (true por defecto), includePassword? (true por defecto), ttlHours? (1–720, 72 por defecto) }` → `{ password, link: { id, url, expiresAt, hasPassword }, linksRemoved, appPasswordsRevoked, photoRemoved }`. |
| `POST /api/mailboxes/:id/setup-email` | Envía al titular su enlace de configuración por correo (ver abajo). `{ to (correo, ≤ 254), includePassword? (true por defecto), ttlHours? (1–720, 168 por defecto) }` → `{ sent: { to, at, status: 'sent' }, link: { expiresAt, hasPassword }, reused }`. **Nunca devuelve la URL ni el token.** |

- Con `includePassword: true` hay que indicar en `password` la contraseña
  recién generada (`400 password_required`). Se comprueba con el motor antes de
  guardarla, y debe ser la principal del buzón:
  - `400 password_mismatch`: no es la del buzón.
  - `400 app_password_not_allowed`: es una contraseña de aplicación.
  - `429 rate_limited`: ya se han indicado 5 contraseñas incorrectas para ese
    buzón en los últimos 15 minutos. El bloqueo alcanza también a la contraseña
    correcta, para que la ruta no sirva para probar contraseñas: espera 15
    minutos o crea el enlace sin contraseña.
  - `503 engine_unreachable`: el motor no ha respondido, así que no se puede
    comprobar. No se crea ningún enlace; reintenta o crea uno sin contraseña.
- El token del enlace tiene 256 bits. Se busca por su hash; además se guarda
  **cifrado** con la clave maestra para que la administración pueda volver a
  enviarlo, y ese cifrado se borra al caducar o revocar el enlace. La contraseña
  se guarda cifrada y se borra al caducar o revocar el enlace, cuando el
  titular pulsa «Ya lo he configurado» o cuando cambia la contraseña del
  buzón. Los enlaces caducados se eliminan 30 días después.
- Buzón o cliente suspendido: `400 mailbox_suspended`.

**Reiniciar la configuración** (`setup-reset`) deja el buzón como recién
creado para entregárselo al titular, normalmente después de haberlo probado:
genera una contraseña principal nueva, elimina todos los enlaces anteriores,
cierra las sesiones de «Mi buzón», borra los intentos fallidos registrados del
buzón, quita la foto (parte del onboarding del titular; el nombre visible se
conserva) y crea un enlace nuevo (con la contraseña cifrada si
`includePassword`).
Con `revokeAppPasswords` revoca en el motor las contraseñas de aplicación
activas y borra su historial; desmárcalo si alguna la usa una integración que
debe seguir enviando. El correo del buzón no se modifica. Primero se revocan
las contraseñas de aplicación y luego se cambia la principal: si el motor no
responde (`502`), no se ha borrado ningún enlace y el reinicio se puede
repetir. Queda en la actividad como `mailbox.setup_reset`, sin secretos. El
buzón vuelve a estar sin configurar (`configuredAt: null`) y se olvidan sus
correos de configuración (`setup.lastEmail: null`).

**Reiniciar la puesta en marcha del cliente** (`POST
/api/clients/:id/onboarding-reset`) hace lo mismo con **todos los buzones
activos** del cliente, de todos sus dominios, pero **sin crear enlaces**: la
entrega vuelve a empezar desde la puesta en marcha (el enlace de bienvenida a
la persona de contacto y, desde ella, el correo de configuración de cada
titular). Las contraseñas nuevas no se devuelven ni se guardan en ningún
enlace. `revokeAppPasswords` es `false` por defecto: en un cliente entero es
fácil que alguna contraseña de aplicación la use una integración que debe
seguir enviando. Solo la administración con sesión del panel, nunca con un
token de gestión: cambia de una vez las contraseñas de una empresa entera.

- `reset`: buzones reiniciados. `skipped`: buzones suspendidos, que se quedan
  como estaban (su titular no puede entrar y conservan su configuración al
  reactivarlos).
- `failed`: buzones en los que el motor ha fallado, con el mensaje del error;
  no detienen los demás y quedan como estaban, salvo las contraseñas de
  aplicación ya revocadas (mismo orden que en `setup-reset`). Repetir la
  petición los reintenta.
- Queda en la actividad del cliente una sola anotación,
  `client.onboarding_reset`, con `{ clientId, reset, skipped, failed (número),
  revokeAppPasswords }`, sin contraseñas ni enlaces (no una por buzón).

**Correo de configuración** (`setup-email`): la puesta en marcha del cliente
envía a cada titular, a la dirección que elija quien gestiona (su correo
personal, el de otro trabajo…), un correo con su enlace de configuración.

- Sale de **`configuration@<dominio del buzón>`** con el nombre «Configura tu
  correo», el asunto `Configura tu correo <buzón>` y, como `Reply-To`, el
  correo del usuario del panel que lo envía. El texto (en texto y HTML) saluda
  por el nombre visible, explica qué hacer, lleva un botón «Configurar mi
  correo» con la URL debajo, dice hasta cuándo vale el enlace (y, si lleva la
  contraseña, que no se reenvíe) y lo firma «Te lo envía <usuario> desde
  <cliente>». No menciona la plataforma (marca blanca).
- `configuration@` es una cuenta oculta del motor por dominio, que se crea en
  el primer envío: no es un buzón del cliente (no sale en ningún listado ni
  cuenta para el plan) y su contraseña no se devuelve nunca. Por eso nadie
  puede crear un buzón ni un alias `configuration` (`400 reserved_address`).
  Se borra con el dominio.
- **Enlace**: se reutiliza el más reciente que no esté revocado, venza dentro
  de más de 24 horas, se pueda volver a enviar y lleve la contraseña (con
  `includePassword`) o no la lleve (sin él; nunca se envía la contraseña si se
  ha pedido sin ella). Si no hay ninguno, se crea uno con `ttlHours`; con
  `includePassword` eso **genera una contraseña principal nueva** (como el
  reinicio: los dispositivos que usaban la anterior dejan de entrar, las
  contraseñas de aplicación siguen valiendo, se cierran las sesiones de «Mi
  buzón» y el buzón vuelve a estar sin configurar). `reused` dice si se
  reutilizó.
- Límites por hora: 5 por buzón y 50 por cliente, contando también los
  fallidos (`429 too_many_setup_emails`).
- Errores: `400 setup_email_same_mailbox` (la dirección es la del propio
  buzón, que aún no está configurado en ningún sitio), `403 client_suspended`
  (cliente suspendido), `400 mailbox_suspended`, `409
  domain_ownership_pending`, `409 configuration_sender_taken` (ya hay un buzón
  o alias `configuration@` en el dominio, de antes de reservarla: copia el
  enlace y envíalo tú), `503 engine_not_configured` y `502 setup_email_failed`
  (el SMTP del motor lo ha rechazado; el mensaje incluye la causa). Si falla
  el SMTP, el envío queda anotado como fallido y reintentar reutiliza el mismo
  enlace. Ningún error previo al envío cambia la contraseña.
- En modo demostración no se abre ninguna conexión SMTP: el envío se da por
  hecho.
- Queda en la actividad como `mailbox.setup_email_sent` o
  `mailbox.setup_email_failed` con `{ mailboxId, email, to, linkId, reused,
  hasPassword }`, nunca con la URL, el token ni la contraseña.

### 2.8 Actividad

`GET /api/audit?clientId=&limit=&before=` → `{ entries, nextBefore }`.
`limit` de 1 a 500 (100 por defecto); para la página siguiente, pasa
`before=<nextBefore>`. Cada anotación es `{ id, userId, clientId, clientName,
action, detail, ip, createdAt, actor: { name, email, role } | null }`.

Un usuario de cliente solo ve su cliente. De las acciones de la administración
(también las hechas con un token) no ve el correo ni la **IP** de quien
administra: `actor.email` llega `null` e `ip` llega vacía. Tampoco ve la IP de
una acción de un usuario que ya no existe, porque podía ser de la
administración. Sí ve la de las acciones de sus propios usuarios y de los
titulares de sus buzones. La administración lo ve todo.

### 2.9 Otras rutas

Envíos de la API y de los formularios (`GET /api/messages`; cada uno lleva
`source`, `api` o `form`, y los de un formulario que sigue existiendo,
`formId`), formularios (sección 9), marca blanca (sección 7), Cloudflare
(sección 4), alertas (`GET /api/alerts`, `POST /api/alerts/:id/dismiss`),
canales de aviso (`GET|PUT /api/notify/channels`, `POST /api/notify/test`),
entregabilidad (`GET /api/deliverability/server`), resúmenes
(`GET /api/dashboard/admin`, `GET /api/dashboard/client`) y ajustes y motor
(`/api/settings`, `/api/engine/*`, solo administración).

**Nombre del servidor de correo.** `mailHostname` (`PUT /api/settings/instance`
y `POST /api/setup/instance`) debe ser un nombre completo: al menos dos
etiquetas y una última etiqueta no numérica (una IP no vale; los dominios de
primer nivel `xn--` sí). Si no: `400 validation`. Lo guardado en Ajustes manda:
el entorno solo da el valor inicial.

**Nombre en ejecución del motor.** `GET /api/engine/status` devuelve en
`hostname` el `server.hostname` guardado en el motor (`configured`), el de
Ajustes (`expected`), si coinciden (`ok`) y, además, el nombre con el que el
motor genera de verdad los registros de los dominios (`running`, el destino de
su MX; Stalwart solo lo cambia al recargar o reiniciar), si coincide con el de
Ajustes (`runningOk`, `null` si no se pudo comparar) y, si no se pudo leer, el
motivo (`runningError`). `POST /api/engine/recommended` devuelve también
`running` tras recargar: si sigue siendo otro, lo fija la configuración local
del motor. El vigilante compara ese nombre cada 10 minutos y, si difiere, abre
un aviso (`engine_hostname`) que se cierra solo al coincidir; no reinicia el
estado DNS de los dominios, que se vuelven a medir con su frecuencia habitual.
Ni la puesta en marcha ni Ajustes se bloquean por ello.

**Entregabilidad del servidor.** `GET /api/deliverability/server` incluye
`hostnameIpv6` (AAAA del nombre del servidor; `null` si no se pudo consultar,
vacío si solo tiene IPv4) e `ipv6Ok`: `false` si alguna IPv6 tiene un inverso
(PTR) que no apunta al servidor, en cuyo caso el plan de acción recomienda
eliminar el AAAA si no es de este servidor o el servidor no tiene IPv6, o
configurar su PTR si lo es.

**Webmail.** El vigilante solo da por disponible el webmail con una respuesta
HTTP 2xx o 3xx; un 404, un 403 o un 5xx abren el aviso `webmail_down`.

**Motor de correo.** Conectarlo, cambiarlo o probarlo (`POST /api/setup/engine`,
`PUT /api/settings/engine`, `POST /api/settings/engine/test`) exige la **sesión
del panel** de un administrador: con un token, aunque sea de administración,
responde `403 session_required`. Si no, un token filtrado podría hacer que el
panel enviase la contraseña guardada del motor, o las credenciales SMTP de las
claves de API, a otro servidor. Por la misma razón, si cambian la URL, el
usuario o el servidor SMTP hay que escribir de nuevo la contraseña del
administrador del motor (`400 engine_password_required`); si el destino no
cambia, se reutiliza la guardada. La URL debe empezar por `http://` o
`https://` y no puede incluir usuario ni contraseña. Un motor que no responde
da `400 engine_test_failed`.

**Estado de la puesta en marcha.** `GET /api/setup/status` no exige
autenticación (lo usan la pantalla de inicio de sesión y el asistente). Con la
puesta en marcha terminada, quien no es administrador recibe solo
`{ setupComplete, hasAdmin, requiresSetupToken, instance: { brandName } }`. La
administración, y cualquiera mientras la puesta en marcha no ha terminado,
recibe además `engineConfigured`, `demoMode`, `engineFromEnv`, `engineDefaults`
(URL, usuario y servidor SMTP del motor del entorno, y `hasPassword`; nunca la
contraseña) e `instance` completa (nombre y IP pública del servidor, URL del
panel y del webmail).

---

## 3. Skyway

Con Skyway 0.34 o posterior, el correo de cada proyecto se crea y se gestiona
desde el propio proyecto. Skyway usa la API de la sección 2 con un token de
administración y **aísla los proyectos por su cuenta**: antes de actuar sobre
un dominio o un buzón comprueba, con el resumen del cliente vinculado, que es
de ese proyecto (si no, responde 404 sin llegar a Mailway).

### 3.1 Conectar (una vez)

Si Mailway se instala con `deploy/instalar.sh` en el mismo servidor que
Skyway, el instalador hace esta conexión solo al terminar (emparejado:
[DESPLIEGUE-SKYWAY.md, sección 2.6](DESPLIEGUE-SKYWAY.md#26-emparejado-con-skyway)),
con un token de gestión de administración llamado «Skyway»; se repite con
`sudo bash deploy/instalar.sh --emparejar`. A mano:

1. En Mailway: **Conexiones → Tokens de gestión → Crear token** con la cuenta
   de administración (p. ej. «Skyway», sin caducidad).
2. En Skyway: **Ajustes → Correo (Mailway)**. Selecciona el servicio de Skyway
   que ejecuta el panel de Mailway (Skyway le habla por la red interna,
   `http://skyway-<proyecto>-<servicio>:4100`) o escribe su URL pública;
   pega el token (debe empezar por `mwt_`) y pulsa **Probar conexión**. Skyway
   muestra la versión, la marca y el servidor de correo, y avisa si el token no
   es de administración. Guarda.
3. Para los usuarios de Skyway que no son administradores, el plan de su
   cuenta debe incluir el módulo **Correo** (`mail`). Los planes anteriores a
   la 0.34 no lo incluyen.

### 3.2 Usar desde un proyecto

El botón **Correo** de la cabecera del proyecto abre el correo del proyecto:

- **Activar correo**:
  - *crear* un cliente nuevo (nombre, plan y correo de contacto opcionales):
    Skyway llama a `POST /api/integrations/clients/ensure` con
    `externalRef = skyway:project:<id del proyecto>`, así que repetirlo nunca
    duplica clientes;
  - *vincular uno existente* (solo la administración de Skyway):
    `PUT /api/integrations/clients/:id/link`.
- **Dominios**: añadir, ver los registros (incluido el TXT de verificación de
  la propiedad), **Configurar en Cloudflare** (vista previa de cambios y
  conflictos antes de aplicar) y verificar. Hasta que la propiedad esté
  comprobada (sección 2.4), crear buzones o alias responde
  `409 domain_ownership_pending` y Skyway muestra el TXT que falta.
- **Buzones**: crear (la contraseña se muestra una vez), generar el enlace de
  configuración para el titular, restablecer la contraseña y eliminar.
- **Conectar a un servicio**: elige un servicio del proyecto (no de base de
  datos) y un buzón.
  - *SMTP*: crea una contraseña de aplicación `skyway:<servicio>` y añade
    `SMTP_HOST` (`mail.<dominio>`), `SMTP_PORT=587`, `SMTP_SECURE=false`
    (STARTTLS), `SMTP_USER` y `SMTP_FROM` (la dirección del buzón) y
    `SMTP_PASS`.
  - *API*: crea una clave de envío y añade `MAILWAY_API_URL` (URL pública del
    panel), `MAILWAY_API_KEY` y `MAIL_FROM`.
  - Las variables se fusionan con las existentes y sus valores nunca se
    muestran ni se anotan. Opcionalmente vuelve a desplegar el servicio.
  - Conectar de nuevo crea una credencial nueva, pero **no revoca la
    anterior**: retírala en Mailway (contraseñas de aplicación del buzón o
    **API de envío**) si ya no se usa.
- **Desactivar el correo**: quita la referencia en Mailway (los datos se
  conservan). Skyway lo hace de forma condicional
  (`DELETE …/link?externalRef=skyway:project:<id>`, sección 2.2): si el cliente
  ya está vinculado a otra referencia, Mailway responde
  `409 external_ref_mismatch` y no lo toca. Borrar el proyecto en Skyway
  también la quita.

Con un usuario de Skyway que no es administrador, Skyway solo usa las cuentas
de Cloudflare **del propio cliente** (parámetro `soloCliente=1`, sección 4.3).

### 3.3 Rutas automáticas en Traefik

El Traefik de Skyway consulta `GET http://skyway:4000/api/traefik/mailway`
cada 15 segundos. Skyway obtiene las rutas de Mailway
(`/api/traefik/config`, con el token de Traefik que le da
`/api/integrations/info`), las **filtra** (solo reglas `Host()` hacia
contenedores de Mailway, nunca un dominio que ya sirve Skyway, solo
redirecciones a HTTPS y el emisor `le`) y, si Mailway no responde, sirve la
última configuración válida. No hace falta ningún
`docker-compose.override.yml`.

Sin Skyway, o con una versión anterior, el bloque manual está en **Ajustes →
Rutas de Traefik** (sección 7.3).

### 3.4 Variables que Mailway aprovecha de Skyway

Cuando el panel se despliega con Skyway, Mailway deduce el nombre de su
contenedor (`skyway-<SKYWAY_PROJECT>-<SKYWAY_SERVICE>`, para las rutas de
Traefik) y su URL pública (`PUBLIC_URL`, si no se define `MAILWAY_PANEL_URL`).

---

## 4. Cloudflare

Si el DNS de un dominio está en Cloudflare, Mailway crea los registros por ti.

### 4.1 Conectar una cuenta

**Conexiones → Cloudflare → Conectar cuenta.** El botón abre Cloudflare con un
token ya preparado con los permisos mínimos: *Zona → Zona → Leer* y *Zona →
DNS → Editar*. Limítalo a las zonas que quieras, créalo y pégalo.

- La administración puede conectar una cuenta para **toda la instancia** o
  para un cliente. Cada cliente puede conectar la suya.
- Se admiten tokens de usuario y de cuenta (`cfat_…`). Se **rechaza la clave
  global** de la API (`400 cloudflare_global_key`): da acceso a toda la
  cuenta.
- El token se verifica al conectarlo y debe ver al menos una zona
  (`400 cloudflare_no_zones`). Se guarda cifrado y no se vuelve a mostrar.

| Método y ruta | Descripción |
|---|---|
| `GET /api/cloudflare/accounts` | Cuentas visibles: `{ accounts: [{ id, clientId, label, tokenHint, createdAt, lastVerifiedAt, lastError, zones?, zonesTotal? }] }`. Administración: `?clientId=<id>` o `?clientId=instancia`. `?refresh=1` vuelve a leer las zonas. Con `?soloCliente=1`, solo las del `?clientId` indicado (sin él, ninguna). |
| `POST /api/cloudflare/accounts` | `{ token, label?, clientId? }` (`clientId` null o ausente = instancia; solo administración) → `{ account }`. Mismo token en el mismo ámbito: `409 cloudflare_duplicate`. Con `?soloCliente=1` hay que indicar el cliente: sin él, `403 cloudflare_instance_admin_only`. |
| `DELETE /api/cloudflare/accounts/:id` | Desconecta la cuenta. Con `?soloCliente=1`, una cuenta de la instancia responde `404`. |

#### La cuenta de la instancia que deja el instalador

Si das un token de Cloudflare al instalar (`deploy/instalar.sh`, variable
`CLOUDFLARE_API_TOKEN` o la pregunta del instalador), además de crear los
registros de la plataforma se guarda en el panel como **cuenta de la
instancia** («Instalador de Mailway»), así que no tienes que volver a pegarlo
en Conexiones. Desde entonces, los dominios que da de alta **la
administración** (en el panel, en el alta de un cliente con su primer dominio
o desde Skyway) configuran su DNS en Cloudflare solos, sin modificar los
registros existentes (sección 4.4): lo que falta se crea y lo que choca se
informa y no se toca. Las acciones de un cliente nunca la usan (sección 4.3).

El instalador usa la herramienta de terminal del panel, con el token por la
entrada estándar (nunca como argumento, que se vería en `ps`):

```bash
printf '%s' "$TOKEN" | docker exec -i -u node <contenedor del panel> \
  node server/dist/tools/cloudflare.js conectar [--nombre <nombre>]
```

- Rechaza `--token` y cualquier argumento que parezca un token antes de leer
  nada, no lee desde un terminal y no repite nunca lo recibido.
- Imprime una línea JSON `{"ok":true,"id","label","zones","creada","sustituida"}`;
  los avisos van a la salida de errores con «Aviso: » y un fallo termina con
  código 1.
- Es idempotente: con el mismo token ya conectado como cuenta de la instancia
  devuelve esa cuenta (`creada: false`) sin cambiarla.
- Con un token distinto, si ya hay una cuenta de la instancia conectada desde
  la terminal (la del instalador), le **sustituye el token** tras verificarlo
  (`sustituida: true`, `cloudflare.account_token_replaced` en la Actividad) en
  vez de añadir otra: así se rota el token repitiendo el instalador con
  `CLOUDFLARE_API_TOKEN`, y los dominios asociados a la cuenta lo siguen estando.
  Las cuentas de la instancia conectadas desde el panel no se tocan. Esa
  variable se exporta y se pasa con `sudo --preserve-env` (o desde una sesión
  de root), nunca escrita en la orden: `sudo CLOUDFLARE_API_TOKEN=…` la deja a
  la vista en `ps` mientras dura la instalación (docs/DESPLIEGUE-SKYWAY.md,
  sección 2.5).
- Queda en la Actividad como «Sistema» (`cloudflare.account_connected`, sin el
  token). El token no se escribe en `deploy/.env`: `--actualizar` sin
  `CLOUDFLARE_API_TOKEN` y `--emparejar` (que nunca lo usa, aunque exista esa
  variable) no lo tienen y no tocan la cuenta que hubiera conectada.

### 4.2 Aplicar el DNS de un dominio

1. En el detalle de un dominio, **Revisar cambios** muestra qué registros se
   crearán, cuáles ya están bien y cuáles chocan con otros, con el motivo.
2. **Aplicar en Cloudflare** los crea en una sola operación (si Cloudflare
   rechaza el lote, se aplican uno a uno y se informa de cada error) y el panel
   mide la propagación.
3. Al dar de alta un dominio, la casilla **Configurar el DNS automáticamente
   en Cloudflare** (`autoDns: true`) crea en un paso los registros que faltan
   y **no modifica nada que ya exista**: un SPF que habría que completar, un
   registro con proxy o uno propio que haya cambiado quedan en `skipped` con su
   motivo, igual que un conflicto, para revisarlos y aplicarlos desde la ficha
   del dominio (pasos 1 y 2). Aparece en Dominios y, para la administración, en
   el alta de un cliente con su primer dominio (con las cuentas de la
   instancia). Sin `autoDns` en el cuerpo, `POST /api/domains` no toca
   Cloudflare.

| Método y ruta | Descripción |
|---|---|
| `GET /api/domains/:id/cloudflare` | Plan (no modifica nada): `{ available, reason?, account?: { id, label }, zone?: { id, name, status, nameServers }, changes: [{ action: create\|update\|keep\|conflict, type, name, content, priority?, current?, reason, required }], summary }`. `?includeRecommended=false` limita a los obligatorios. |
| `POST /api/domains/:id/cloudflare/apply` | `{ replaceConflicts?, includeRecommended? (true por defecto) }` → `{ applied, errors, skipped, domain }`. Sin cuenta que vea la zona: `400 cloudflare_unavailable`. Si el motor propone un MX interno, ni el plan ni la aplicación siguen: `409 mx_hostname_internal` (sección 2.4). |
| `POST /api/whitelabel/domains/:id/cloudflare` | Crea el CNAME (o A) de un dominio de marca blanca → `{ applied, errors, skipped, domain }`; el de tipo `webmail`, con el proxy de Cloudflare (a uno existente que apunta aquí se le activa). `{ soloCrear: true }` (lo envía Skyway al crearlo automáticamente) no modifica uno existente, ni para activarle el proxy. Usa también la cuenta con la que se aplicó el DNS del dominio de correo del que cuelga, aunque sea de la instancia (sección 4.3). |
| `GET /api/cloudflare/instance-dns` · `POST` | DNS de la plataforma (administración): A de `mail.`, `webmail.` y `panel.` y CNAME `autoconfig.`/`autodiscover.` del dominio base. `POST` acepta `{ replaceConflicts? }` → `{ applied, errors, skipped, missing }`. |

Si la zona está pendiente de activación en Cloudflare, `zone.nameServers`
indica los servidores de nombres que debes poner en tu registrador.

### 4.3 Qué cuentas se usan

- Primero, la cuenta ya asociada al dominio, si quien actúa puede usarla;
  después, las del **cliente** dueño del dominio; y, solo si actúa la
  **administración** (y no pide `soloCliente=1`), las de la instancia.
- Un cliente **nunca** usa las cuentas de la instancia, ni directa ni
  indirectamente: si pudiera, le bastaría con dar de alta un dominio que vive
  en la cuenta del administrador (o un subdominio suyo) para escribir en esa
  zona. Tampoco cuando la cuenta quedó asociada al dominio porque la
  administración aplicó su DNS con ella: la asociación solo la aprovecha la
  administración, y el cliente recibe un motivo que lo explica (conectar una
  cuenta propia o pedir a la administración que vuelva a aplicarlo).
- **`?soloCliente=1`** (o `true`) limita la búsqueda a las cuentas del cliente
  aunque la petición llegue con un token de administración. Se aplica en las
  cuatro rutas que planifican o escriben DNS con una cuenta de Cloudflare:
  - `GET /api/domains/:id/cloudflare` (plan);
  - `POST /api/domains/:id/cloudflare/apply`;
  - `POST /api/domains` con `autoDns: true`: el alta se completa igualmente y,
    si el cliente no tiene una cuenta que contenga la zona, `cloudflare` es
    `null` y `cloudflareReason` explica el motivo;
  - `POST /api/whitelabel/domains/:id/cloudflare`.

  Sin una cuenta propia que contenga la zona, el plan responde
  `available: false` y la aplicación `400 cloudflare_unavailable`: nunca se
  escribe en una zona de la instancia, salvo el registro de marca blanca de
  abajo. Skyway lo envía cuando quien actúa en
  Skyway no es administrador (propietario o miembro de un espacio de trabajo),
  para que su token de administración no abra a los proyectos las cuentas de la
  instancia.
- **Excepción: el registro de un dominio de marca blanca.** Vale también la
  cuenta con la que se aplicó el DNS del dominio de correo del que cuelga,
  aunque sea de la instancia y actúe el cliente (o Skyway con
  `soloCliente=1`): la administración ya escribió en esa zona para ese mismo
  dominio. Con esa cuenta solo se crea el registro (o se le activa el proxy),
  nunca se reemplaza un conflicto, aunque se pida `replaceConflicts`. Una zona
  del operador cuyo DNS no aplicó la administración para ese cliente no se
  toca (docs/SEGURIDAD.md).
- Lo que la administración escribe con una cuenta de la instancia queda
  **reservado**: los registros de un dominio (MX, TXT de verificación) siguen
  en la zona del operador aunque el dominio se borre, y probarían la propiedad
  a cualquiera. Ese dominio solo lo puede volver a dar de alta el cliente para
  el que se escribió o la administración (sin `soloCliente`); para otro
  cliente, `409 domain_reserved`. Si la administración lo da de alta para otro
  cliente, la reserva pasa a ese cliente. Borrar el dominio no borra sus
  registros en Cloudflare. Al actualizar desde la 1.0 se reservan los
  dominios que siguen en la base con el DNS aplicado con una cuenta de la
  instancia (o con una ya desconectada); los borrados antes de actualizar no
  se pueden reconstruir (docs/SEGURIDAD.md).
- Con `soloCliente=1`, además, las cuentas de la instancia no se listan ni se
  borran, no se puede conectar una cuenta sin cliente y las rutas que solo
  trabajan con ellas (`/api/cloudflare/instance-dns` y `POST /api/engine/acme`)
  responden `403 cloudflare_instance_admin_only`.

### 4.4 Reglas que protegen el correo existente

- El **alta automática** (`autoDns`) solo crea: nunca modifica ni borra un
  registro existente. Lo que esta sección describe como «se corrige», «se
  fusiona» o «se actualiza» solo lo hace **Aplicar en Cloudflare** desde la
  ficha del dominio, después de revisar el plan.
- Todos los registros del correo van **sin proxy** (nube gris): el proxy de
  Cloudflare rompe SMTP e IMAP. Un registro con proxy se corrige. La
  excepción es el **webmail de marca blanca**, que va con proxy (sección 7.1):
  es solo una página web y el correo va al nombre del servidor.
- **SPF**: si ya existe uno, se fusiona (se añade `mx` delante del primer
  `all`) en lugar de crear un segundo, que invalidaría ambos. Un `mx` escrito
  detrás de `all` no cuenta, igual que en la comprobación DNS. Con dos SPF no
  se toca y se avisa.
- **Registros propios**: Mailway marca lo que crea con el comentario
  `Mailway (instancia <huella>)`, propio de cada instalación. Solo un registro
  con exactamente ese comentario se actualiza sin confirmación (una clave DKIM
  nueva, un SRV que cambia de puerto); el de otra instalación de Mailway que
  gestione la misma zona, o uno que solo mencione «Mailway», es un conflicto.
- **DMARC**: si ya existe uno, se respeta. Con varios, es un conflicto que no
  se corrige solo: conserva tú una única política.
- **Web del dominio**: nunca se crean A, AAAA, CNAME, HTTPS ni SVCB en el
  dominio raíz ni en `www`.
- **MX de otro proveedor** (Google, Microsoft…): se marcan como conflicto y
  solo se sustituyen si se confirma expresamente (`replaceConflicts: true`),
  porque cambiarlos mueve el correo de todo el dominio.
- Un **CNAME** no convive con otros registros del mismo nombre: se marca como
  conflicto.
- No se crean registros CAA (restringirían las autoridades de certificación de
  todo el dominio).

### 4.5 Errores de Cloudflare

| Código | Causa |
|---|---|
| `400 cloudflare_token_invalid` · `cloudflare_token_malformed` · `cloudflare_token_inactive` | Token no válido, incompleto, desactivado o caducado |
| `400 cloudflare_forbidden` | El token no tiene permiso sobre la zona o está limitado por IP |
| `409 cloudflare_email_routing` | La zona tiene *Email Routing* activado, que bloquea MX y SPF: desactívalo en Cloudflare (Email → Email Routing) |
| `409 cloudflare_exists` | Otro registro con ese nombre impide crear el nuevo |
| `429 cloudflare_rate_limited` | Límite de Cloudflare (1200 peticiones cada 5 minutos por token) |
| `502 cloudflare_unreachable` · `504 cloudflare_timeout` | Cloudflare no responde o tarda más de 15 segundos |

---

## 5. Programas de correo (autoconfiguración)

El panel sirve la configuración que piden los programas de correo, de modo que
el titular solo escribe su dirección y su contraseña.

| Programa | Cómo se configura |
|---|---|
| Thunderbird (escritorio) y Thunderbird para Android | Solos. Buscan `autoconfig.<dominio>` y, si no existe, `autoconfig.<dominio del MX>`: basta con que la plataforma tenga `autoconfig.<dominio base>` para cubrir a todos los clientes cuyo MX sea este servidor. |
| iPhone, iPad y Mac | Perfil de configuración (`.mobileconfig`) desde el enlace de configuración o desde «Mi buzón». |
| Outlook | Autodiscover (`autodiscover.<dominio>`). Las versiones recientes de Outlook apenas autodetectan IMAP, así que el enlace muestra también los datos manuales. |
| Gmail, Samsung Email y otros | Datos manuales (servidor, puertos, cifrado) con botones de copiar. |

### 5.1 Rutas públicas

| Ruta | Uso |
|---|---|
| `GET /mail/config-v1.1.xml?emailaddress=` y `GET /.well-known/autoconfig/mail/config-v1.1.xml` | Thunderbird. El dominio se toma de `emailaddress` o del host (`autoconfig.<dominio>`). En el host de la instancia sin dirección se devuelve un documento genérico con `%EMAILDOMAIN%`. |
| `GET\|POST /autodiscover/autodiscover.xml` | Autodiscover (Outlook y Thunderbird), sin distinguir mayúsculas. Responde siempre `200` (con el XML de error si no procede) y **nunca lee** la cabecera `Authorization`, en la que Thunderbird envía la contraseña real. |
| `GET /autodiscover/autodiscover.json?Email=&Protocol=AutodiscoverV1` y `GET /autodiscover/autodiscover.json/v1.0/<dirección>` | Autodiscover v2: devuelve la URL del documento XML. |
| `GET /.well-known/mta-sts.txt` | Política MTA-STS (modo `testing`) en `mta-sts.<dominio>`. |

Solo se responde para dominios dados de alta en esta instancia.

### 5.2 Nombres y rutas de Traefik

Cada dominio tiene tres nombres (`autoconfig.`, `autodiscover.`, `mta-sts.`) y
la instancia dos (`autoconfig.` y `autodiscover.` del dominio base, derivado
del nombre del servidor de correo). Traefik solo los enruta al panel cuando su
DNS apunta a este servidor (CNAME al servidor de correo o A a la IP pública):
publicar uno que no resuelve haría fallar Let's Encrypt. El vigilante los
revisa cada hora, y los de un dominio en cuanto este queda activo. Hace falta
conocer el contenedor del panel (`MAILWAY_PANEL_BACKEND_URL` o despliegue con
Skyway).

| Método y ruta | Descripción |
|---|---|
| `GET /api/autoconfig/status` | Administración: estado de cada nombre (`ok`, `pending`, `unknown`), si está enrutado y los CNAME que faltan para la instancia. |
| `POST /api/autoconfig/refresh` | Administración: vuelve a comprobarlos → `{ summary, status }`. |

### 5.3 Datos de conexión de un buzón

`GET /api/mailboxes/:id/connection` →

```json
{
  "email": "ana@cliente.es",
  "username": "ana@cliente.es",
  "imap":    { "host": "mail.miempresa.com", "port": 993, "security": "SSL/TLS" },
  "smtp":    { "host": "mail.miempresa.com", "port": 465, "security": "SSL/TLS" },
  "smtpAlt": { "host": "mail.miempresa.com", "port": 587, "security": "STARTTLS" },
  "webmailUrl": "https://webmail.miempresa.com",
  "autoconfig": {
    "thunderbird": "https://autoconfig.cliente.es/mail/config-v1.1.xml?emailaddress=ana%40cliente.es",
    "outlook": "https://autodiscover.cliente.es/autodiscover/autodiscover.xml",
    "appleProfileUrl": "https://panel.miempresa.com/api/mailboxes/mbx_…/mobileconfig"
  },
  "portalUrl": "https://panel.miempresa.com/mi-buzon"
}
```

Las URL de autoconfiguración usan el nombre del dominio si su DNS ya apunta
aquí; si no, el de la instancia; y, como último recurso, el panel (que sirve
las mismas rutas en cualquier nombre). `webmailUrl` es el webmail de marca
blanca del cliente si tiene uno en servicio.

---

## 6. Enlace de configuración, «Mi buzón» y webmail

### 6.1 Enlace de configuración

Desde **Buzones → (buzón) → Conectar dispositivos** se genera un enlace
(`/conectar/<token>`) con su código QR. Al abrirlo, el titular ve los pasos
para su dispositivo (iPhone o iPad, Mac, Android, Outlook, Thunderbird, otros),
con el perfil de Apple, el QR de importación de Thunderbird para Android, los
datos manuales, el webmail y el acceso a «Mi buzón». Antes de los
dispositivos puede poner su **nombre visible y su foto** (el nombre va en el
perfil de Apple y en el QR de Thunderbird). Si el enlace se crea al dar de alta
el buzón, puede incluir la contraseña inicial.

Rutas públicas (60 peticiones por minuto e IP, sin caché):

| Ruta | Descripción |
|---|---|
| `GET /api/public/setup/:token` | `{ email, displayName, brandName, connection, password?, hasPassword, expiresAt, portalUrl, photoUrl, appleProfileUrl, thunderbirdAndroidQr }`. `photoUrl` es relativa o `null`. |
| `GET /api/public/setup/:token/perfil.mobileconfig` | Perfil de Apple (con la contraseña si el enlace la lleva). Marca el buzón como configurado. |
| `POST /api/public/setup/:token/done` | «Ya lo he configurado»: borra la contraseña del enlace y marca el buzón como configurado. |
| `PATCH /api/public/setup/:token/profile` | `{ displayName (≤ 80) }` → `{ displayName }`. Cambia también el motor. |
| `GET\|PUT\|DELETE /api/public/setup/:token/photo` | Foto del buzón (sección 2.5). `PUT { photo }` → `{ photoUrl, photoUpdatedAt }`. |

Enlace inexistente, caducado o revocado: `404 setup_link_invalid`. Buzón o
cliente suspendido: `403 mailbox_suspended`.

### 6.2 «Mi buzón»

En `/mi-buzon` el titular entra con su dirección y la **contraseña principal**
del buzón para ver sus datos de conexión y su espacio ocupado, descargar el
perfil de Apple, cambiar la contraseña y crear o revocar contraseñas de
aplicación.

| Método y ruta | Descripción |
|---|---|
| `POST /api/portal/login` | `{ email, password }` → `{ ok, email }`. Cookie `mailway_buzon` (httpOnly, `SameSite=Lax`, `Path=/api/portal`, 12 horas). Marca el buzón como configurado. |
| `GET /api/portal/me` | Datos del buzón, conexión, ocupación, webmail y `photoUrl` (relativa o `null`). |
| `PATCH /api/portal/profile` | `{ displayName (≤ 80) }` → `{ displayName }`. |
| `GET\|PUT\|DELETE /api/portal/photo` | Foto del buzón (sección 2.5). `PUT { photo }` → `{ photoUrl, photoUpdatedAt }`. |
| `POST /api/portal/logout` | Cierra la sesión. |
| `POST /api/portal/password` | `{ current, next (≥ 10) }`. Cierra las demás sesiones de «Mi buzón» y borra la contraseña de los enlaces; las contraseñas de aplicación siguen valiendo. |
| `GET /api/portal/mobileconfig` | Perfil de Apple sin contraseña. |
| `GET\|POST /api/portal/app-passwords`, `DELETE /api/portal/app-passwords/:appId` | Contraseñas de aplicación del buzón (`POST` con `{ name }` → `{ appPassword, password, snippets }`, con las variables listas para copiar de la sección 2.6). Máximo 25 activas por buzón: `409 app_password_limit`, igual que en el panel. |

- La contraseña se comprueba **en local** contra el hash del motor, nunca
  pidiéndole al motor que autentique (sus fallos bloquearían la IP del proxy
  para todos).
- Límite: 5 fallos por buzón y 20 por IP cada 15 minutos (`429 rate_limited`).
- Mismo `401 bad_credentials` y mismo mensaje («La dirección de correo o la
  contraseña no son correctas.») para una dirección inexistente que para una
  contraseña incorrecta. Buzón suspendido: `403 mailbox_suspended`. Motor sin
  respuesta: `503 engine_unreachable`. Sin sesión: `401 portal_unauthorized`.
- El inicio de sesión del panel (`POST /api/auth/login`) usa el mismo código con
  el mensaje «El correo electrónico o la contraseña no son correctos.». Las dos
  pantallas de la web muestran este último texto cuando reciben
  `bad_credentials`; una integración debe guiarse por el `code`, no por el
  texto.
- Contraseña nueva igual a la actual: `400 same_password`; actual incorrecta:
  `400 bad_current_password`; contraseña de aplicación en lugar de la
  principal: `400 app_password_not_allowed`.

### 6.3 Webmail

Roundcube, en español, con cambio de contraseña (**Ajustes → Contraseña**),
filtros, reenvío y aviso de ausencia (**Ajustes → Filtros**, por ManageSieve),
carpeta de archivo y botón «Marcar como Spam». Su enlace de ayuda lleva a «Mi
buzón».

El cambio de contraseña llama al panel por la red interna:

`POST /api/webmail/password` (formulario `user`, `curpass`, `newpass`;
cabecera `X-Mailway-Token` = `MAILWAY_WEBMAIL_TOKEN`) → `200 ok`, o `error`
con `400`, `401`, `403`, `429` o `503`. Sin `MAILWAY_WEBMAIL_TOKEN` la ruta no
existe (`404`) y el webmail oculta la pestaña.

El complemento `mailway_perfil` usa otras dos rutas con el mismo secreto (JSON
o formulario; sin secreto configurado, `404`; secreto incorrecto, `401`):

- `POST /api/webmail/profile` `{ user }` → `{ name, photo }`: el nombre visible
  con el que se crea y se mantiene la identidad del remitente y si hay foto.
  Buzón inexistente: `404`. Como el complemento la llama justo después de
  entrar en el webmail, marca el buzón como configurado.
- `POST /api/webmail/photo` `{ user, email }` → la imagen, **solo si `email`
  es un buzón del mismo cliente que `user`**; si no, `404`. La foto de un
  empleado nunca se muestra a otra empresa alojada en la misma instancia.

---

## 7. Marca blanca y rutas de Traefik

### 7.1 Dominios propios de los clientes

En **Marca blanca**, un cliente sirve el webmail en su propio dominio
(`webmail.sucliente.com`) con certificado automático.

Reglas:

- Debe ser un **subdominio de un dominio de correo del mismo cliente cuya
  propiedad esté comprobada** (sección 2.4; `400 hostname_not_owned`,
  `400 domain_not_verified`). Cuenta la propiedad, no que el DNS del dominio
  esté completo. Así nadie puede reclamar el nombre de otra aplicación del
  servidor.
- No puede empezar por `autoconfig.`, `autodiscover.` ni `mta-sts.`, ni ser
  uno de los nombres de la instancia (`400 reserved_hostname`).
- Máximo **5 por cliente** (`400 whitelabel_limit`). La administración debe
  indicar el cliente (`400 client_required`).
- Tipo `webmail` (por defecto) o `panel`; este último requiere conocer el
  contenedor del panel (`400 kind_unavailable`).

Estados: **Esperando DNS** (`pending_dns`) → **Emitiendo certificado**
(`issuing`) → **En servicio** (`active`), o `error`. Solo se publican en
Traefik los dominios cuyo DNS ya apunta aquí, y un dominio solo pasa a «En
servicio» cuando responde por HTTPS con un certificado válido y un código 2xx
o 3xx (un 404 o un 5xx indican que la ruta o su destino aún no están bien).

**Webmail automático de cada dominio.** No hace falta dar de alta el webmail
de cada cliente: en cuanto un dominio de correo tiene la propiedad
comprobada, Mailway da de alta `webmail.<dominio>` como webmail de marca
blanca de su cliente y crea su registro en Cloudflare con proxy (abajo). Vale
para todos los clientes y dominios que se vayan añadiendo, y el vigilante lo
repasa cada hora: prepara los dominios que ya existían y reintenta los
webmail que siguen esperando al DNS. Barandillas:

- Solo si el nombre está libre en Cloudflare (aunque lo responda un comodín)
  o ya apunta a este servidor. Si `webmail.<dominio>` existe y apunta a otro
  sitio (el cliente lo usa para otra cosa), no se toca. Sin una cuenta de
  Cloudflare que vea la zona, solo si su DNS ya apunta aquí.
- Un nombre eliminado a mano no se vuelve a crear; darlo de alta a mano lo
  vuelve a activar.
- Respeta el máximo de 5 dominios propios por cliente y los nombres
  reservados.
- `MAILWAY_WEBMAIL_AUTOMATICO=0` lo desactiva.

Cada buzón entra por el webmail de **su propio dominio** si está en servicio
(quien tiene el correo en `b.com`, por `webmail.b.com`); si no, por el
principal del cliente y, si no hay, por el general de la instancia.

**DNS automático y proxy de Cloudflare.** Al dar de alta un dominio de tipo
`webmail`, y al pulsar «Comprobar» mientras espera al DNS, Mailway crea su
registro en Cloudflare si alguna cuenta utilizable ve la zona (sección 4.3,
incluida la excepción de marca blanca): CNAME al servidor de correo **con el
proxy de Cloudflare** (nube naranja), marcado con el comentario de la
instancia. Solo crea: un registro existente no se toca (para activarle el
proxy está «Configurar en Cloudflare» en la ficha). Si no puede, el alta
sigue y quedan las instrucciones.

Con el proxy, el DNS público devuelve IP de Cloudflare: Mailway pregunta a
Cloudflare si el registro de ese nombre es un CNAME al servidor de correo (o
un A a su IP) con proxy y, si lo es, lo da por bueno («apunta a este
servidor a través del proxy de Cloudflare»). Sin una cuenta conectada que vea
la zona no puede saberlo: el detalle pide conectarla o quitar el proxy. Si el
nombre no tiene registro propio y responde el comodín del dominio
(`*.sucliente.com`, normalmente el de la web), el detalle también lo dice.
Mientras tanto no se publica en Traefik (el nombre responde «404 page not
found») y el panel, los enlaces y la API siguen dando el webmail general de
la instancia.

Lo que tiene que cumplir la zona en Cloudflare (lo mismo que ya necesitan las
webs de Skyway con proxy):

- **SSL/TLS en «Completo» o «Completo (estricto)»**, nunca «Flexible»: en
  «Flexible», Cloudflare llega por HTTP, Traefik lo devuelve a HTTPS y la
  página no carga nunca. La comprobación lo detecta («HTTPS redirige a la
  misma dirección») y el dominio no entra en servicio.
- Con «Completo (estricto)», el certificado del servidor tiene que poder
  emitirse: Let's Encrypt lo valida por HTTP en `/.well-known/acme-challenge/`,
  así que, si «Usar siempre HTTPS» está activo, esa ruta necesita una
  excepción. Mientras no hay certificado, Cloudflare responde con un error 526
  y el dominio sigue en «Emitiendo certificado».
- El webmail toma la IP real del visitante de `CF-Connecting-IP`, solo cuando
  la conexión llega de una IP de Cloudflare, para que la sesión y los
  registros (los accesos fallidos, por ejemplo) muestren la del visitante y no
  la del nodo de Cloudflare (deploy/roundcube/README.md). El límite de
  intentos fallidos de Roundcube no depende de la IP: lo lleva por usuario.
- El nombre del servidor de correo (`mail.…`) sigue sin proxy: lo necesitan
  IMAP y SMTP, y es el destino del CNAME del webmail.

**Webmail principal**: si un cliente tiene varios dominios de webmail en
servicio, el marcado como principal (`isPrimary`) es el que usan su inicio y
la API, y el de los buzones de un dominio sin webmail propio en servicio
(datos de conexión, enlaces de configuración y autoconfiguración). Sin elección expresa se usa el primero que entró en
servicio y, si no hay ninguno, la URL general del webmail de la instancia.

| Método y ruta | Descripción |
|---|---|
| `GET /api/whitelabel/domains?clientId=` | `{ domains }`. |
| `POST /api/whitelabel/domains` | `{ hostname, kind?, clientId? }` → `{ domain, instructions }` (CNAME recomendado hacia el servidor de correo o A hacia la IP). Si el nombre ya es de ese cliente y del mismo tipo (por ejemplo, porque lo creó el alta automática), devuelve el que hay; de otro cliente o de otro tipo, `409`. |
| `GET /api/whitelabel/domains/:id` · `POST …/:id/verify` · `DELETE …/:id` | Ficha, comprobación y baja. |
| `POST /api/whitelabel/domains/:id/cloudflare` | Crea el registro en Cloudflare (sección 4). |
| `POST /api/whitelabel/domains/:id/primary` | Marca el dominio como webmail principal de su cliente → `{ domain }` (`400 webmail_not_active` si no es de tipo `webmail` o no está en servicio). |

### 7.2 Configuración para Traefik

`GET /api/traefik/config` (cabecera `X-Mailway-Token`; `401` sin ella)
devuelve la configuración dinámica de Traefik: un par de routers por nombre
(`mailway-<id>` en `websecure` con el emisor `le`, y `mailway-<id>-http` que
redirige a HTTPS), los servicios `mailway-webmail` y `mailway-panel` y el
*middleware* `mailway-https`. Los routers de autoconfiguración se llaman
`mailway-autoconfig-<id>`, `mailway-autodiscover-<id>` y `mailway-mtasts-<id>`
(`…-instancia` para los de la instancia). El token es `MAILWAY_TRAEFIK_TOKEN`
o, si no se define, uno generado y guardado. Cada consulta autenticada queda
anotada (`lastPollAt` en la sección 7.3).

### 7.3 Ajustes → Rutas de Traefik

`GET /api/whitelabel/setup` (administración) → `{ token, tokenFromEnv,
certResolver, webmailBackend, panelBackend, panelDomainsAvailable, panelUrl,
underSkyway, providerEndpoint, overrideSnippet, autoconfig: { routingAvailable,
routedHosts }, skywayBridge: { minVersion: "0.34.0", endpoint, note },
lastPollAt, publishedDomains }`. `lastPollAt` es la hora (en milisegundos) de
la última consulta autenticada de Traefik o del puente de Skyway, o `null` si
aún no ha llegado ninguna: si lleva más de 90 segundos sin llegar, Traefik no
está leyendo las rutas.

- Con **Skyway 0.34 o posterior** no hay que instalar nada (sección 3.3).
- Con Skyway anterior o un Traefik propio, `overrideSnippet` es el
  `docker-compose.override.yml` exacto que hace que Traefik consulte el panel
  directamente. **No lo instales con Skyway 0.34**: Traefik solo admite un
  proveedor HTTP y el fichero sustituiría al puente.

---

## 8. Otras plataformas

Cualquier aplicación (Railway, Vercel, un VPS, un script) puede enviar correo
con Mailway de dos formas:

- **SMTP** con una contraseña de aplicación del buzón remitente:
  `SMTP_HOST=mail.miempresa.com`, `SMTP_PORT=587` (STARTTLS) o `465`
  (SSL/TLS), usuario = dirección completa del buzón.
- **API HTTP** con una clave `mw_…`:
  `POST https://panel.miempresa.com/v1/send` ([API.md](API.md)).

En los dos casos, al crear la credencial el panel entrega el `.env` y el código
de Node, Laravel y Django listos para copiar (sección 2.6 y
[API.md](API.md#21-variables-listas-para-copiar)), con los mismos nombres de
variables que Skyway.

Y cualquier sistema puede **gestionar** el correo con un token de gestión y
las rutas de la sección 2. Flujo típico de una integración que da correo a sus
propios clientes:

```bash
BASE=https://panel.miempresa.com; AUTH="Authorization: Bearer $TOKEN"
# 1. Cliente idempotente por referencia externa
curl -s -H "$AUTH" -H 'Content-Type: application/json' -X POST "$BASE/api/integrations/clients/ensure" \
  -d '{"externalRef":"crm:cuenta:4821","name":"Acme S.L."}'
# 2. Dominio (con DNS automático si hay cuenta de Cloudflare)
curl -s -H "$AUTH" -H 'Content-Type: application/json' -X POST "$BASE/api/domains" \
  -d '{"clientId":"cli_…","domain":"acme.es","autoDns":true}'
# 3. Cuando la propiedad esté comprobada: buzón y enlace de configuración
curl -s -H "$AUTH" -H 'Content-Type: application/json' -X POST "$BASE/api/mailboxes" \
  -d '{"domainId":"dom_…","localPart":"ana","displayName":"Ana Pérez"}'
curl -s -H "$AUTH" -H 'Content-Type: application/json' -X POST "$BASE/api/mailboxes/mbx_…/setup-links" \
  -d '{"ttlHours":72}'
```

---

## 9. Formularios de contacto para webs estáticas

Una web estática (sin servidor propio: Netlify, GitHub Pages, un HTML en
cualquier alojamiento) puede tener un formulario de contacto sin guardar
ninguna clave secreta: el cliente crea un **formulario** en el panel
(**Formularios**) y pega en su web un fragmento HTML con una **clave pública**
`mwf_…`. Cada envío llega a un buzón del propio cliente.

### 9.1 Gestión (panel o token de gestión)

| Método y ruta | Descripción |
|---|---|
| `GET /api/forms?clientId=` | `{ forms }`. Un usuario de cliente solo ve los suyos (el filtro `clientId` solo lo usa la administración). |
| `POST /api/forms` | `{ name (2–60), recipientMailboxId, allowedOrigins (1–10), subject? (1–150), turnstileSiteKey?, turnstileSecret?, clientId? }` → `{ form }`. |
| `PATCH /api/forms/:id` | `{ name?, allowedOrigins?, subject?, enabled?, turnstileSiteKey?, turnstileSecret? }` → `{ form }`. Con `turnstileSiteKey: null` (o `turnstileSecret: null`) se retira Turnstile; un secreto omitido se conserva. El buzón destinatario no cambia: para otro buzón, crea otro formulario. |
| `DELETE /api/forms/:id` | Elimina el formulario y retira su credencial SMTP del motor → `{ ok }`. |

`form`: `{ id, clientId, name, publicKey, recipientMailboxId, recipientEmail,
allowedOrigins, subject, turnstile: { siteKey } | null, enabled,
submissionsCount, lastSubmissionAt, createdAt, updatedAt, endpoint,
embedHtml }`. `endpoint` es `<panel>/forms/<publicKey>` y `embedHtml`, el
fragmento listo para pegar; los dos se pueden volver a consultar cuando se
quiera (la clave es pública). El secreto de Turnstile no se devuelve nunca.

Reglas del alta:

- El **buzón destinatario** debe ser del mismo cliente
  (`400 recipient_other_client`), estar activo (`400 mailbox_suspended`) y
  estar en un dominio con la **propiedad comprobada**
  (`409 domain_ownership_pending`), también para la administración: los
  mensajes salen con el remitente de ese dominio.
- **Orígenes permitidos**: de 1 a 10, solo `https://` y sin comodines
  (`400 invalid_origin`). Se guardan como los envía el navegador en la
  cabecera `Origin`: `https://www.acme.es/contacto` se queda en
  `https://www.acme.es`, y se puede escribir sin el esquema. `www.acme.es` y
  `acme.es` son orígenes distintos.
- **Turnstile** (opcional): la clave de sitio y la secreta, las dos o
  ninguna (`400 turnstile_incomplete`). El secreto se guarda cifrado.
- Máximo **20 formularios por cliente** (`409 form_limit`); las altas del
  mismo cliente van en fila, así que las simultáneas no superan el máximo.
- Cliente suspendido: `400 client_suspended`.
- Cada formulario envía con una **contraseña de aplicación propia** del buzón
  (como las claves de API), que no cuenta para el máximo de 25 del titular y
  se retira al eliminarlo. Un buzón que recibe formularios no se puede
  eliminar (`409 mailbox_in_use`).
- Actividad: `form.created`, `form.updated` y `form.deleted`, con el cliente
  afectado y sin secretos (de Turnstile solo consta `configurado` o
  `retirado`).

### 9.2 El fragmento para la web

```html
<form action="https://panel.miempresa.com/forms/mwf_…" method="post" data-mailway-form="mwf_…">
  <p>
    <label for="mw-nombre-x">Nombre</label>
    <input id="mw-nombre-x" name="nombre" type="text" autocomplete="name" required maxlength="200">
  </p>
  <p>
    <label for="mw-email-x">Correo electrónico</label>
    <input id="mw-email-x" name="email" type="email" autocomplete="email" required maxlength="254">
  </p>
  <p>
    <label for="mw-mensaje-x">Mensaje</label>
    <textarea id="mw-mensaje-x" name="mensaje" rows="6" required maxlength="5000"></textarea>
  </p>
  <!-- Campo trampa: las personas no lo ven; si llega relleno, el envío se descarta. -->
  <div aria-hidden="true" style="position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden">
    <label for="mw-web-x">No rellenes este campo</label>
    <input id="mw-web-x" name="mw_web" type="text" tabindex="-1" autocomplete="off">
  </div>
  <button type="submit">Enviar</button>
  <p data-mailway-estado role="status" aria-live="polite"></p>
</form>
<script src="https://panel.miempresa.com/forms/widget.js" data-form="mwf_…" defer></script>
```

- Los textos, el diseño y los campos se pueden cambiar: **todos los campos**
  llegan en el mensaje (hasta 30, de hasta 5000 caracteres cada uno). Los
  campos `email` (o `correo`) y `nombre` (o `name`) se usan para «Responder a».
- Con Turnstile, el fragmento incluye además
  `<div class="cf-turnstile" data-sitekey="…" data-language="es"></div>` y el
  script `https://challenges.cloudflare.com/turnstile/v0/api.js`.
- **`/forms/widget.js`** (sin dependencias, ES5): envía el formulario sin
  recargar la página (`application/x-www-form-urlencoded`, sin cookies),
  desactiva el botón mientras tanto, escribe el resultado en la región
  `role="status"` y vacía el formulario al terminar. Muestra en español el
  motivo de los errores (`400`) o un texto según el código (`403`, `404`,
  `413`, `429`, red). Tras cada intento reinicia Turnstile (cada token sirve una
  vez). Si el navegador no tiene `fetch`, no hace nada y el formulario se envía
  de forma nativa.
- **Sin JavaScript**: el envío nativo recibe una página en español con el
  resultado y un enlace para volver a la web.

### 9.3 Ruta pública `POST /forms/:clave`

Admite `application/x-www-form-urlencoded` (el de un formulario HTML; no
`multipart/form-data`), `application/json` y JSON en `text/plain`. Con
`Accept: application/json` responde `{ ok: true }`; si el navegador pide
HTML, una página.

Por orden:

1. Límite general: 60 peticiones por minuto e IP.
2. La clave debe existir (`404 form_not_found`) y la cabecera `Origin` estar en
   la lista del formulario (`403 origin_not_allowed`; sin `Origin`, también).
3. Formulario desactivado: `403 form_disabled`; cliente o buzón suspendidos:
   `403 form_unavailable`.
4. Tamaño máximo de 32 KB (`413`), 30 campos (`400 too_many_fields`) de
   5000 caracteres (`400 field_too_long`), una dirección de correo válida si
   se indica (`400 invalid_email`) y algún contenido (`400 empty_submission`).
   Estos errores no gastan el cupo de la IP.
5. Límite por IP: **5 envíos cada 10 minutos** en cada formulario
   (`429 rate_limited`).
6. **Campo trampa** `mw_web` relleno: responde `200 { ok: true }` sin enviar
   nada (el robot no aprende que lo han descartado).
7. **Turnstile**, si está configurado: el token (`cf-turnstile-response`) es
   obligatorio (`400 turnstile_required`) y se comprueba con Cloudflare,
   incluido que el `hostname` que devuelve sea el de un origen permitido
   (`400 turnstile_failed`). Si Cloudflare no responde,
   `503 turnstile_unavailable`.
8. Límite por formulario: **30 mensajes por hora** (`429 rate_limited`) y
   **200 al día** (UTC; `429 daily_limit_reached`, con un texto para el
   visitante sin detalles del plan). Ese cupo diario es **propio de cada
   formulario y no gasta el de la API del plan**: el `Origin` se falsea con
   curl, y si los formularios gastaran el cupo de `/v1/send`, cualquiera
   podría dejar al cliente sin sus envíos transaccionales (códigos de un solo
   uso, recuperación de contraseña) hasta el día siguiente. Con el máximo de
   20 formularios, acota lo que puede llegar a los buzones del cliente.
9. Envío al buzón destinatario. Si el servidor de correo lo rechaza,
   `502 send_failed` (el intento queda en el historial y cuenta para el cupo
   del formulario).

**CORS solo en esta ruta**: la respuesta (también la de error, para que la web
lea el motivo) lleva `Access-Control-Allow-Origin` con el origen de la
petición si está en la lista, y `Vary: Origin`; la petición previa (`OPTIONS`)
responde `204` con `POST`, `Content-Type` y `Accept`, o `403` a un origen no
permitido. El resto de la API no responde con CORS.

### 9.4 El mensaje que recibe el cliente

- **De**: el propio buzón destinatario, con el nombre «<formulario> (formulario
  web)». Nunca la dirección que escribe el visitante: sería suplantarla y el
  mensaje no pasaría SPF ni DMARC. Así sale firmado con el DKIM del dominio.
- **Para**: el buzón destinatario. No se puede enviar a otras direcciones.
- **Responder a**: la dirección del visitante, si es válida (sin saltos de
  línea, comas ni comillas), con su nombre saneado.
- **Asunto**: el del formulario; el visitante no lo elige.
- **Cuerpo**: solo texto, con cada campo en una línea (o en un bloque si tiene
  varias), el origen y la hora en UTC. Sin los campos de control (trampa y
  Turnstile). Cabecera `X-Web-Form: mwf_…` para filtrar.
- Queda en el historial de envíos (`GET /api/messages`, con
  `source: "form"`, que se conserva aunque el formulario se elimine, y
  `formId`) y suma en el contador del formulario.
