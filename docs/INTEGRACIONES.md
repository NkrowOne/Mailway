# Integraciones de Mailway

Cómo conectar Mailway con otras piezas: **Skyway** (crear y gestionar el
correo de cada proyecto desde su panel), **Cloudflare** (DNS automático),
**cualquier plataforma o script** (API de gestión con tokens) y los
**programas de correo** de los usuarios (autoconfiguración).

---

## 1. Tokens de gestión

Todo lo que hace el panel existe como endpoint bajo `/api`. Para usarlo
desde fuera (Skyway, un script, un pipeline de CI, un agente) se crea un
**token de gestión** en **Conexiones → Tokens de gestión**.

- Formato: `mwt_<prefijo>_<secreto>`. Se muestra **una sola vez**; en la base
  de datos solo queda su hash.
- Hereda los permisos del usuario que lo crea: un token del administrador lo
  puede todo; el de un usuario de cliente solo ve y gestiona ese cliente.
- Se crea solo desde una sesión del panel (un token no puede crear otros
  tokens) y puede tener caducidad. Revocarlo corta el acceso al instante.
- Cada acción queda en **Actividad** con la marca «mediante token X».

```bash
BASE="https://panel.tuempresa.com"
TOKEN="mwt_..."

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/integrations/info"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/clients"
```

> Las claves `mw_…` son otra cosa: solo sirven para **enviar** correo por
> `POST /v1/send` (ver [API.md](API.md)). No dan acceso a la gestión.

### Endpoints pensados para integraciones

| Método y ruta | Quién | Qué hace |
|---|---|---|
| `GET /api/integrations/info` | cualquiera con token | Versión, marca, servidores IMAP/SMTP, URL del panel y del webmail, funciones disponibles. Con token de administrador incluye además el token del proveedor de Traefik. |
| `POST /api/integrations/clients/ensure` | administración | Crea (o devuelve) el cliente asociado a una referencia externa, p. ej. `skyway:project:<id>`. Idempotente. Cuerpo: `{externalRef, name, contactEmail?, planId?}`. |
| `GET /api/integrations/clients/by-ref?externalRef=…` | administración | Busca el cliente de una referencia externa. |
| `PUT /api/integrations/clients/:id/link` | administración | Vincula un cliente existente a una referencia externa: `{externalRef}`. |
| `DELETE /api/integrations/clients/:id/link` | administración | Quita el vínculo (no borra nada más). |
| `GET /api/integrations/clients/:id/summary` | acceso al cliente | Todo en una llamada: plan, uso, dominios con su estado DNS, buzones con su ocupación, claves de API, contraseñas de aplicación y datos de conexión. |
| `GET /api/mailboxes/:id/app-passwords` · `POST` · `DELETE /:appId` | acceso al cliente | Contraseñas de aplicación de un buzón (una por dispositivo o app). La contraseña se devuelve una vez. |
| `POST /api/mailboxes/:id/setup-links` | acceso al cliente | Enlace de configuración para el titular del buzón (`{url, expiresAt}`), opcionalmente con la contraseña recién generada. |

Además están todos los endpoints del panel: clientes, planes, dominios
(`POST /api/domains`, `POST /api/domains/:id/verify`), buzones
(`POST /api/mailboxes`, `POST /api/mailboxes/:id/password`), alias, claves de
API (`POST /api/apikeys`) y Cloudflare (sección 3). Los errores siempre
llegan como `{ "error": "<mensaje en español>", "code": "<código>" }`.

---

## 2. Skyway

Con Skyway ≥ 0.34, el correo de cada proyecto se crea y se gestiona desde el
propio proyecto de Skyway.

### Conectar (una vez)

1. En Mailway: **Conexiones → Tokens de gestión → Crear token** con la cuenta
   de administración (p. ej. «Skyway», sin caducidad).
2. En Skyway: **Ajustes → Correo (Mailway)**. Elija el servicio de Skyway que
   ejecuta el panel de Mailway (o escriba su URL pública), pegue el token y
   pulse **Probar conexión**.

### Usar desde un proyecto

En la cabecera del proyecto, el botón **Correo** abre el correo del proyecto:

- **Activar correo**: crea en Mailway un cliente vinculado a ese proyecto
  (o, para la administración, vincula uno que ya exista).
- **Dominios**: añadir un dominio, ver sus registros, **Configurar en
  Cloudflare** con un clic y **Verificar**.
- **Buzones**: crear, restablecer la contraseña, generar el enlace de
  configuración para el titular y eliminar.
- **Conectar a un servicio**: elige un servicio del proyecto y un buzón.
  - *SMTP*: crea una contraseña de aplicación y añade al servicio
    `SMTP_HOST`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER`,
    `SMTP_PASS` y `SMTP_FROM`.
  - *API*: crea una clave de envío y añade `MAILWAY_API_URL`,
    `MAILWAY_API_KEY` y `MAIL_FROM`.
  - Opcionalmente vuelve a desplegar el servicio. Los valores nunca se
    muestran: van directos a las variables de entorno.

### Rutas automáticas en Traefik

Skyway incluye un puente para el proveedor HTTP de Traefik: Traefik le
pregunta a Skyway y Skyway le entrega, filtradas, las rutas que Mailway
necesita (webmail con dominio propio de cada cliente, `autoconfig.`,
`autodiscover.` y `mta-sts.`). No hace falta ningún
`docker-compose.override.yml`. Sin Skyway (o con una versión anterior), el
bloque manual sigue disponible en **Ajustes → Rutas y autoconfiguración**.

Cuando el panel se despliega con Skyway, Mailway deduce solo el nombre de su
contenedor (`skyway-<proyecto>-<servicio>`, a partir de las variables
`SKYWAY_PROJECT` y `SKYWAY_SERVICE` que Skyway inyecta) y su URL pública
(`PUBLIC_URL`).

---

## 3. Cloudflare

Si el DNS de un dominio está en Cloudflare, Mailway crea los registros por
usted.

1. **Conexiones → Cloudflare → Conectar cuenta**. El botón abre Cloudflare con
   un token ya preparado con los permisos mínimos: *Zona → Zona → Leer* y
   *Zona → DNS → Editar*. Limítelo a las zonas que quiera, créelo y péguelo.
   - El administrador puede conectar una cuenta para **toda la instancia**
     (sirve para cualquier dominio cuya zona vea el token) o para un cliente.
   - Cada cliente puede conectar su propia cuenta.
   - El token se guarda cifrado y nunca se vuelve a mostrar.
2. En el detalle de un dominio: **Revisar cambios** muestra qué registros se
   crearán, cuáles ya están bien y cuáles chocan con otros existentes, con el
   motivo. **Aplicar en Cloudflare** los crea en una sola operación y el panel
   comprueba la propagación automáticamente.
3. Al dar de alta un dominio, la casilla **Configurar el DNS
   automáticamente en Cloudflare** hace todo en un paso.

Reglas que protegen el correo existente:

- Todos los registros van **sin proxy** (nube gris): el proxy de Cloudflare
  rompe SMTP e IMAP.
- **SPF**: si ya existe uno, se fusiona (se añade `mx`) en lugar de crear un
  segundo, que invalidaría ambos.
- **DMARC**: si ya existe, se respeta.
- **MX de otro proveedor** (Google, Microsoft…): se marcan como conflicto y
  solo se sustituyen si usted lo confirma expresamente, porque cambiarlos
  mueve el correo de todo el dominio.
- Si la zona tiene **Email Routing** activado, Cloudflare bloquea los MX: el
  panel lo indica para que lo desactive primero.

El administrador tiene además **DNS de la plataforma**: crea los registros A
de `mail.`, `panel.` y `webmail.`, y los `autoconfig.`/`autodiscover.` del
dominio base.

---

## 4. Programas de correo de los usuarios (autoconfiguración)

El panel sirve la configuración que piden los programas de correo, así el
titular solo escribe su dirección y su contraseña:

| Cliente | Cómo se configura |
|---|---|
| Thunderbird (escritorio) y Thunderbird para Android | Solos. Buscan `autoconfig.<dominio>` y, si no existe, `autoconfig.<dominio del MX>`: basta con que la plataforma tenga `autoconfig.<dominio base>` para cubrir a todos los clientes. |
| iPhone, iPad y Mac | Perfil de configuración (`.mobileconfig`) desde el enlace de configuración o desde «Mi buzón». |
| Outlook | Autodiscover (`autodiscover.<dominio>`); las versiones recientes de Outlook ya no detectan bien IMAP, así que el enlace muestra también los datos manuales. |
| Gmail, Samsung Email y otros | Datos manuales (servidor, puertos, SSL/TLS), con botones de copiar. |

Rutas públicas: `GET /mail/config-v1.1.xml`,
`GET /.well-known/autoconfig/mail/config-v1.1.xml`,
`POST /autodiscover/autodiscover.xml`,
`GET /autodiscover/autodiscover.json`, `GET /.well-known/mta-sts.txt`.

### Enlace de configuración y «Mi buzón»

- Desde **Buzones → Conectar dispositivos** se genera un enlace (y su QR) para
  el titular. Al abrirlo en el móvil ve los pasos exactos para su
  dispositivo. Si se crea justo al dar de alta el buzón, puede incluir la
  contraseña inicial; se borra al caducar el enlace o cuando el titular marca
  «Ya lo he configurado».
- **Mi buzón** (`/mi-buzon`): el titular entra con su dirección y su
  contraseña para ver sus datos de conexión, descargar el perfil, cambiar la
  contraseña y crear contraseñas de aplicación por dispositivo.
- En el webmail, **Ajustes → Contraseña** cambia la contraseña del buzón a
  través del panel.

---

## 5. Otras plataformas (Railway, Vercel, un VPS…)

Cualquier aplicación puede enviar correo con Mailway de dos formas:

- **SMTP** con una contraseña de aplicación del buzón remitente:
  `SMTP_HOST=mail.tuempresa.com`, `SMTP_PORT=587` (STARTTLS) o `465`
  (TLS), usuario = dirección completa.
- **API HTTP** con una clave `mw_…`: `POST https://panel.tuempresa.com/v1/send`
  (ver [API.md](API.md)).

Y cualquier sistema puede **gestionar** el correo con un token de gestión y
los endpoints de la sección 1.
