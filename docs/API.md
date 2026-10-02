# API de Mailway

Mailway tiene dos API con credenciales distintas:

| API | Para qué | Credencial | Dónde se crea |
|---|---|---|---|
| **Envío transaccional** (`POST /v1/send`) | Que una aplicación envíe correo: códigos OTP, avisos, facturas… | Clave de API `mw_…` | Panel → **API de envío** |
| **Gestión** (`/api/…`) | Automatizar lo que se hace en el panel: clientes, dominios, buzones, claves… | Token de gestión `mwt_…` | Panel → **Conexiones → Tokens de gestión** |

Una clave `mw_…` no sirve para la API de gestión (`401 api_key_not_allowed`)
ni un token `mwt_…` para enviar. Este documento describe la API de envío; la
de gestión está en [INTEGRACIONES.md](INTEGRACIONES.md).

---

## 1. Envío transaccional

Cada clave de API pertenece a un cliente y envía siempre en nombre de **un
buzón remitente** fijo (recomendado: `noreply@tu-dominio.com`). Así ningún
cliente puede enviar como otro.

### 1.1 Autenticación

Cabecera `Authorization` con la clave tal como se mostró al crearla (solo se
muestra una vez):

```
Authorization: Bearer mw_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

La clave tiene la forma `mw_<prefijo de 8 caracteres>_<secreto>`. El panel
muestra el prefijo para reconocerla; en la base de datos solo queda su hash.

### 1.2 Enviar un mensaje

`POST https://panel.miempresa.com/v1/send` con `Content-Type: application/json`.

| Campo | Tipo | Obligatorio | Límites |
|---|---|---|---|
| `to` | cadena o lista de cadenas | sí | De 1 a 50 direcciones |
| `subject` | cadena | sí | De 1 a 300 caracteres |
| `html` | cadena | `html`, `text` o ambos | Máximo 2 MB (2 097 152 bytes en UTF-8) |
| `text` | cadena | `html`, `text` o ambos | Máximo 2 MB (2 097 152 bytes en UTF-8) |
| `fromName` | cadena | no | Nombre visible del remitente, hasta 80 caracteres |
| `replyTo` | cadena | no | Dirección de respuesta |
| `cc`, `bcc` | lista de cadenas | no | Hasta 20 direcciones cada una |
| `headers` | objeto | no | Cabeceras adicionales (p. ej. `X-Campaign`), valores de hasta 500 caracteres |
| `attachments` | lista de objetos | no | Hasta 5 adjuntos y 10 MB en total una vez decodificados (sección 1.3) |

El remitente (`From`) es siempre el buzón asociado a la clave: `fromName` solo
cambia el nombre visible. La petición completa no puede superar 20 MB (los
adjuntos en base64 ocupan un tercio más que el fichero).

### 1.3 Adjuntos

Cada elemento de `attachments` es `{ filename, contentType, content }`:

| Campo | Contenido |
|---|---|
| `filename` | Nombre del fichero. Se sanea: se quitan rutas, caracteres de control, marcas de dirección (U+202E y similares), `" < > : * ? \|` y puntos al principio o al final, y se recorta a 120 caracteres conservando la extensión. Sin extensión, se añade la del tipo. |
| `contentType` | Uno de los tipos admitidos (debajo). De los parámetros solo se conservan `charset` y, en un calendario, `method` (`REQUEST`, `CANCEL`…), que convierte el `.ics` en una invitación con botones de respuesta. |
| `content` | El fichero en base64 (estándar o URL; se admiten saltos de línea). |

Tipos admitidos y extensiones válidas:

| Tipo | Extensiones |
|---|---|
| `application/pdf` | `pdf` |
| `text/calendar` | `ics`, `ical`, `ifb` |
| `text/plain` · `text/csv` · `application/json` | `txt`, `text`, `log` · `csv` · `json` |
| `image/png` · `image/jpeg` · `image/gif` · `image/webp` | `png` · `jpg`, `jpeg` · `gif` · `webp` |
| Office (`…wordprocessingml.document`, `…spreadsheetml.sheet`, `…presentationml.presentation`) | `docx` · `xlsx` · `pptx` |
| OpenDocument (`application/vnd.oasis.opendocument.text`, `.spreadsheet`, `.presentation`) | `odt` · `ods` · `odp` |

Reglas:

- La extensión del nombre debe ser una de las del tipo: `factura.pdf.exe`
  declarado como PDF se rechaza (`400 attachment_type_not_allowed`).
- El contenido debe corresponder al tipo: un PDF empieza por `%PDF-`, una
  imagen por su firma, un calendario por `BEGIN:VCALENDAR`, los documentos de
  Office y OpenDocument son ZIP y los textos no contienen bytes nulos
  (`400 attachment_invalid`).
- No se admiten ejecutables, scripts, HTML ni comprimidos: salen con el
  dominio y la IP del cliente, y son la vía habitual del *phishing*.
- El tamaño de los adjuntos cuenta en el `sizeBytes` del historial.

### 1.4 Reintentos sin duplicados: `Idempotency-Key`

Si la aplicación no recibe la respuesta (un corte de red, un *timeout*) no
sabe si el mensaje salió. Con la cabecera opcional `Idempotency-Key` puede
reintentar sin riesgo de enviarlo dos veces:

```
Idempotency-Key: 0b8f2c1e-4d5a-4f7e-9a61-3c2d1e0f9b8a
```

- Valor de 1 a 200 caracteres ASCII imprimibles; un UUID por mensaje es lo
  más sencillo. Si no, `400 invalid_idempotency_key`.
- Se guarda **por clave de API** durante **24 horas**: el mismo valor con la
  misma clave devuelve la respuesta original (mismo `id`, mismo `status`) con
  la cabecera `Idempotent-Replayed: true`, sin volver a enviar ni gastar cupo.
  Con otra clave de API, el mismo valor es independiente.
- Si llega con el mismo valor un mensaje **distinto** (otro destinatario,
  asunto, contenido o adjuntos), `409 idempotency_conflict`. El orden de los
  campos del JSON no cuenta.
- Mientras la primera petición está en curso, otra con el mismo valor recibe
  `409 idempotency_in_progress`: reintenta en unos segundos.
- Si el servidor se reinicia a mitad de un envío (un redespliegue, falta de
  memoria), la reserva no se queda bloqueada: al arrancar se retiran las que
  quedaron sin respuesta, y una que siga sin respuesta pasados **15 minutos**
  se da por abandonada. En los dos casos el reintento con el mismo valor
  **vuelve a enviar** el mensaje: si el servidor llegó a entregarlo al SMTP
  antes de detenerse, el destinatario puede recibirlo dos veces, que es
  preferible a no recibirlo nunca.
- Solo se guardan los envíos que se ejecutaron (`status: "sent"` o
  `"failed"`). Un rechazo por límites (`429`), autenticación o validación no
  reserva el valor, así que el reintento con la misma clave funciona. Para
  reintentar un envío con `status: "failed"`, usa un valor nuevo.
- Del valor solo se guarda su hash.

### 1.5 Ejemplos

**curl (código OTP):**

```bash
curl -sS -X POST https://panel.miempresa.com/v1/send \
  -H "Authorization: Bearer $MAILWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "cliente@ejemplo.com",
    "subject": "Tu código de acceso",
    "html": "<p>Tu código es <strong>482913</strong>. Caduca en 10 minutos.</p>",
    "text": "Tu código es 482913. Caduca en 10 minutos."
  }'
```

**Node.js (con reintentos ante el límite por minuto):**

```js
async function enviarCorreo(mensaje, intentos = 4) {
  for (let i = 0; i < intentos; i++) {
    const res = await fetch(`${process.env.MAILWAY_API_URL}/v1/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MAILWAY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(mensaje),
    });
    const data = await res.json();
    if (res.status === 429 && data.code === 'rate_limited') {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i)); // 2 s, 4 s, 8 s…
      continue;
    }
    if (!res.ok) throw new Error(`${data.code}: ${data.error}`);
    if (data.status === 'failed') throw new Error(data.error);
    return data; // { id, status: 'sent', messageId }
  }
  throw new Error('Límite por minuto superado de forma continuada.');
}

await enviarCorreo({
  to: usuario.email,
  subject: 'Tu código de acceso',
  html: `<p>Tu código es <strong>${otp}</strong>.</p>`,
  text: `Tu código es ${otp}.`,
});
```

**Python:**

```python
import os, requests

r = requests.post(
    f"{os.environ['MAILWAY_API_URL']}/v1/send",
    headers={"Authorization": f"Bearer {os.environ['MAILWAY_API_KEY']}"},
    json={"to": ["ana@ejemplo.com"], "subject": "Factura 2026-031",
          "text": "Adjuntamos el enlace a tu factura.", "replyTo": "facturacion@miempresa.com"},
    timeout=30,
)
data = r.json()
if r.status_code != 200 or data.get("status") != "sent":
    raise RuntimeError(data.get("code") or data.get("status"), data.get("error"))
```

**curl (invitación de calendario y PDF adjuntos):**

```bash
ICS=$(base64 -w0 invitacion.ics)   # en macOS: base64 -i invitacion.ics
PDF=$(base64 -w0 orden-del-dia.pdf)
curl -sS -X POST https://panel.miempresa.com/v1/send \
  -H "Authorization: Bearer $MAILWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: reunion-2026-10-10-ana" \
  -d @- <<JSON
{
  "to": "ana@ejemplo.com",
  "subject": "Invitación: revisión trimestral",
  "text": "Te enviamos la invitación y el orden del día.",
  "attachments": [
    { "filename": "invitacion.ics", "contentType": "text/calendar; method=REQUEST", "content": "$ICS" },
    { "filename": "orden-del-dia.pdf", "contentType": "application/pdf", "content": "$PDF" }
  ]
}
JSON
```

**Node.js (ICS generado en el momento, con `Idempotency-Key`):**

```js
import { randomUUID } from 'node:crypto';

const ics = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Mi empresa//Citas//ES',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  `UID:${randomUUID()}@miempresa.com`,
  'DTSTAMP:20261002T080000Z',
  'DTSTART:20261010T090000Z',
  'DTEND:20261010T100000Z',
  'SUMMARY:Revisión trimestral',
  'ORGANIZER:mailto:agenda@miempresa.com',
  'ATTENDEE;RSVP=TRUE:mailto:ana@ejemplo.com',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

// Un valor por mensaje, guardado junto al pedido o la cita: si hay que
// reintentar, se reutiliza el mismo y el mensaje no sale dos veces.
const idempotencyKey = randomUUID();

const res = await fetch(`${process.env.MAILWAY_API_URL}/v1/send`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.MAILWAY_API_KEY}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  },
  body: JSON.stringify({
    to: 'ana@ejemplo.com',
    subject: 'Invitación: revisión trimestral',
    text: 'Te enviamos la invitación. Acéptala desde tu calendario.',
    attachments: [
      {
        filename: 'invitacion.ics',
        contentType: 'text/calendar; method=REQUEST',
        content: Buffer.from(ics).toString('base64'),
      },
    ],
  }),
});
const data = await res.json();
if (!res.ok || data.status !== 'sent') throw new Error(`${data.code ?? data.status}: ${data.error}`);
// res.headers.get('idempotent-replayed') === 'true' si era un reintento.
```

Las aplicaciones conectadas desde Skyway reciben `MAILWAY_API_URL` (URL del
panel), `MAILWAY_API_KEY` y `MAIL_FROM` como variables de entorno: son los
mismos nombres que usan los bloques que el panel entrega al crear una clave
(sección 2.1), así que el mismo código sirve con Skyway y sin él.

### 1.6 Respuestas

Todas las respuestas son JSON. Los errores tienen la forma
`{ "error": "<mensaje en español>", "code": "<código>" }`; los de validación
añaden `issues: [{ path, message }]`.

| HTTP | `code` | Significado | Qué hacer |
|---|---|---|---|
| `200` | — | `{ id, status: "sent", messageId }`: entregado al motor | Nada |
| `200` | — | `{ id, status: "failed", error }`: el servidor SMTP rechazó el mensaje | Revisar `error`. El envío queda en el historial y **cuenta** para el cupo diario |
| `200` | — | Con la cabecera `Idempotent-Replayed: true`: repetición de un envío ya hecho con la misma `Idempotency-Key` | Nada: es la respuesta original |
| `400` | `validation` | Algún campo no es válido (también más de 5 adjuntos); `error` indica cuál | Corregir la petición |
| `400` | `bad_request` | Falta el contenido (`html` o `text`), o el cuerpo no es JSON válido | Corregir la petición |
| `400` | `attachment_type_not_allowed` | Tipo de adjunto no admitido o extensión que no corresponde al tipo | Usar un tipo de la sección 1.3 |
| `400` | `attachment_invalid` | Adjunto vacío, sin base64 válido o cuyo contenido no es del tipo declarado | Revisar la codificación y el tipo |
| `400` | `invalid_idempotency_key` | `Idempotency-Key` vacía, de más de 200 caracteres o con caracteres no ASCII | Usar, por ejemplo, un UUID |
| `401` | `missing_api_key` | No hay cabecera `Authorization` | Añadirla |
| `401` | `invalid_api_key` | La cabecera no tiene el formato `Bearer mw_…` o la clave no existe | Revisar la clave |
| `401` | `revoked_api_key` | La clave fue revocada | Crear una nueva |
| `403` | `client_suspended` | La cuenta del cliente está suspendida | Contactar con quien administra el servicio |
| `403` | `sender_suspended` | El buzón remitente de la clave está suspendido | Reactivarlo en el panel o usar otra clave |
| `403` | `sender_missing` | El buzón remitente ya no existe | Crear una clave con otro remitente |
| `409` | `idempotency_conflict` | La `Idempotency-Key` ya se usó con esta clave para un mensaje distinto | Usar un valor nuevo por mensaje |
| `409` | `idempotency_in_progress` | Otra petición con la misma `Idempotency-Key` está en curso (como mucho 15 minutos; ver sección 1.4) | Reintentar en unos segundos |
| `413` | `attachments_too_large` | Los adjuntos superan 10 MB una vez decodificados | Reducirlos o enviar un enlace de descarga |
| `413` | `bad_request` | La petición supera 20 MB | Reducir el contenido |
| `429` | `rate_limited` | Límite de envíos por minuto del plan, contado por cliente (todas sus claves) | Reintentar con espera exponencial |
| `429` | `daily_limit_reached` | Límite diario del plan (por cliente, todas sus claves) o de la clave | Esperar al reinicio: medianoche UTC |

Los rechazos por `401`, `403`, `409`, `413` y los datos no válidos **no
gastan** cupo diario ni la ventana por minuto.

### 1.7 Límites

- Los límites **por minuto** y **por día** los define el plan del cliente y se
  aplican **al cliente en conjunto**: todas sus claves comparten el mismo
  cupo, de modo que crear más claves no amplía el plan. El límite por minuto es
  una ventana fija de 60 segundos que se abre con el primer envío; superado, se
  rechazan los envíos hasta que termina.
- Cada clave puede tener además su propio **límite diario**, que solo puede
  ser igual o menor que el del plan (sirve para acotar una aplicación
  concreta). Si el plan cambia después, se aplica el menor de los dos.
- Un límite diario 0 en el plan significa «sin límite diario».
- El contador diario se reinicia a medianoche UTC. El uso del día de cada clave
  aparece en la pestaña **API de envío** del panel (`usedToday` en la API); el
  cupo del plan suma, en cambio, los envíos admitidos de todas las claves del
  cliente, por lo que puede agotarse aunque `usedToday` de una clave sea bajo.
- Los mensajes de los **formularios web** no gastan este cupo: cada formulario
  tiene el suyo (200 al día) y lo rellena cualquiera desde Internet, así que
  un formulario atacado no puede dejar a la API sin envíos
  ([Integraciones §9.3](INTEGRACIONES.md#93-ruta-pública-post-formsclave)).

### 1.8 Historial

Cada envío queda registrado con su estado, destinatarios, asunto, tamaño y
`messageId`. En el panel: **API de envío**. Por API de gestión:
`GET /api/messages?keyId=<id>&limit=100` (máximo 500). Cada mensaje lleva
`source` (`api` o `form`, que se conserva aunque el formulario se elimine) y,
si salió de un formulario que sigue existiendo, `formId`.

---

## 2. Claves de API (gestión)

Las claves se crean en el panel o con un token de gestión.

| Método y ruta | Descripción |
|---|---|
| `GET /api/apikeys?clientId=` | Claves del cliente (`{ keys }`). Un usuario de cliente solo ve las suyas. |
| `POST /api/apikeys` | Crea una clave. Cuerpo: `{ name, senderMailboxId, dailyLimit?, clientId? }` (`clientId` solo para la administración). Respuesta: `{ key, info, snippets }` con `Cache-Control: no-store`; **`key` y `snippets` solo aparecen aquí**. |
| `DELETE /api/apikeys/:id` | Revoca la clave al instante y retira su credencial del motor. `409` si ya estaba revocada. |

Reglas:

- `name`: de 2 a 60 caracteres, reconocible («OTP producción»).
- El buzón remitente debe ser del mismo cliente (`400`) y no estar suspendido
  (`400 sender_suspended`).
- `dailyLimit` (entero ≥ 1) se acota al límite diario del plan.
- Cada clave crea en el buzón remitente una contraseña de aplicación propia:
  la API envía sin conocer ni tocar la contraseña del buzón. No cuenta para el
  máximo de 25 contraseñas de aplicación activas que admite el titular
  ([INTEGRACIONES.md](INTEGRACIONES.md#26-contraseñas-de-aplicación)).

`ApiKeyInfo`: `{ id, clientId, name, prefix, senderMailboxId, senderEmail,
dailyLimit, lastUsedAt, revokedAt, createdAt, usedToday }`.

### 2.1 Variables listas para copiar

`snippets` es una lista de bloques `{ id, label, language, filename, content }`
que el panel muestra en pestañas, con botón de copiar, en el mismo aviso donde
aparece la clave:

| `id` | `label` | Contenido |
|---|---|---|
| `env` | `.env` | `MAILWAY_API_URL` (URL pública del panel), `MAILWAY_API_KEY` (la clave) y `MAIL_FROM` (el buzón remitente). |
| `node` | `Node.js` | Función `enviarCorreo()` con `fetch` a `/v1/send` e `Idempotency-Key`; lee la clave del entorno. |
| `laravel` | `PHP · Laravel` | Líneas del `.env` con la clave, entrada de `config/services.php` y llamada con `Http::withToken()`. |
| `django` | `Python · Django` | `settings.py` que lee el entorno y función `enviar_correo()` con `requests`. |

El secreto solo va en las líneas de `.env` (las del bloque `env` y las del
bloque de Laravel); el código lo lee del entorno. Los
nombres son los mismos que Skyway inyecta al conectar el correo a un servicio
en modo API. Como la clave no se guarda en claro, los bloques **no se pueden
volver a generar**: si se pierden, crea otra clave y revoca la anterior. Las
contraseñas de aplicación traen bloques equivalentes para SMTP
([INTEGRACIONES.md](INTEGRACIONES.md#26-contraseñas-de-aplicación)).

---

## 3. Buenas prácticas

- Una clave por aplicación y entorno («OTP producción», «Facturas pruebas»).
- Guarda la clave en un gestor de secretos o en una variable de entorno, nunca
  en el código.
- Incluye siempre la versión `text` además de `html`: mejora la entrega.
- Ante `429 rate_limited`, reintenta con espera exponencial (2 s, 4 s, 8 s…).
  Ante `429 daily_limit_reached`, no reintentes hasta el día siguiente.
- Envía una `Idempotency-Key` por mensaje y reutilízala en los reintentos: un
  corte de red nunca duplicará un correo.
- Para ficheros grandes, envía un enlace de descarga en lugar de un adjunto:
  los adjuntos pesados empeoran la entrega.
- Trata `200` con `status: "failed"` como un error: el mensaje no salió.
- Revoca de inmediato cualquier clave que se haya podido filtrar; crear una
  nueva lleva segundos.
- Para enviar desde un programa que ya habla SMTP, usa una contraseña de
  aplicación del buzón (`mail.<dominio>`, puerto 587 con STARTTLS o 465 con
  TLS): ver [INTEGRACIONES.md](INTEGRACIONES.md#8-otras-plataformas).

---

## 4. API de gestión

Todo lo que hace el panel está disponible bajo `/api` con un **token de
gestión** (`Authorization: Bearer mwt_…`): clientes y planes, dominios y su
DNS (incluido Cloudflare), buzones y altas masivas, alias, contraseñas de
aplicación, enlaces de configuración, claves de API, marca blanca y
actividad. Referencia completa, reglas de los tokens y códigos de error en
**[INTEGRACIONES.md](INTEGRACIONES.md)**.
