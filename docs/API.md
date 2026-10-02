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

El remitente (`From`) es siempre el buzón asociado a la clave: `fromName` solo
cambia el nombre visible. La petición completa no puede superar 5 MB.

### 1.3 Ejemplos

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

Las aplicaciones conectadas desde Skyway reciben `MAILWAY_API_URL` (URL del
panel), `MAILWAY_API_KEY` y `MAIL_FROM` como variables de entorno.

### 1.4 Respuestas

Todas las respuestas son JSON. Los errores tienen la forma
`{ "error": "<mensaje en español>", "code": "<código>" }`; los de validación
añaden `issues: [{ path, message }]`.

| HTTP | `code` | Significado | Qué hacer |
|---|---|---|---|
| `200` | — | `{ id, status: "sent", messageId }`: entregado al motor | Nada |
| `200` | — | `{ id, status: "failed", error }`: el servidor SMTP rechazó el mensaje | Revisar `error`. El envío queda en el historial y **cuenta** para el cupo diario |
| `400` | `validation` | Algún campo no es válido; `error` indica cuál | Corregir la petición |
| `400` | `bad_request` | Falta el contenido (`html` o `text`), o el cuerpo no es JSON válido | Corregir la petición |
| `401` | `missing_api_key` | No hay cabecera `Authorization` | Añadirla |
| `401` | `invalid_api_key` | La cabecera no tiene el formato `Bearer mw_…` o la clave no existe | Revisar la clave |
| `401` | `revoked_api_key` | La clave fue revocada | Crear una nueva |
| `403` | `client_suspended` | La cuenta del cliente está suspendida | Contactar con quien administra el servicio |
| `403` | `sender_suspended` | El buzón remitente de la clave está suspendido | Reactivarlo en el panel o usar otra clave |
| `403` | `sender_missing` | El buzón remitente ya no existe | Crear una clave con otro remitente |
| `413` | `bad_request` | La petición supera 5 MB | Reducir el contenido |
| `429` | `rate_limited` | Límite de envíos por minuto del plan, contado por cliente (todas sus claves) | Reintentar con espera exponencial |
| `429` | `daily_limit_reached` | Límite diario del plan (por cliente, todas sus claves) o de la clave | Esperar al reinicio: medianoche UTC |

Los rechazos por `401`, `403` y los datos no válidos **no gastan** cupo diario
ni la ventana por minuto.

### 1.5 Límites

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

### 1.6 Historial

Cada envío queda registrado con su estado, destinatarios, asunto, tamaño y
`messageId`. En el panel: **API de envío**. Por API de gestión:
`GET /api/messages?keyId=<id>&limit=100` (máximo 500).

---

## 2. Claves de API (gestión)

Las claves se crean en el panel o con un token de gestión.

| Método y ruta | Descripción |
|---|---|
| `GET /api/apikeys?clientId=` | Claves del cliente (`{ keys }`). Un usuario de cliente solo ve las suyas. |
| `POST /api/apikeys` | Crea una clave. Cuerpo: `{ name, senderMailboxId, dailyLimit?, clientId? }` (`clientId` solo para la administración). Respuesta: `{ key, info }`; **`key` solo aparece aquí**. |
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

---

## 3. Buenas prácticas

- Una clave por aplicación y entorno («OTP producción», «Facturas pruebas»).
- Guarda la clave en un gestor de secretos o en una variable de entorno, nunca
  en el código.
- Incluye siempre la versión `text` además de `html`: mejora la entrega.
- Ante `429 rate_limited`, reintenta con espera exponencial (2 s, 4 s, 8 s…).
  Ante `429 daily_limit_reached`, no reintentes hasta el día siguiente.
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
