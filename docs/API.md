# API de envío transaccional de Mailway

Para que tus aplicaciones envíen correo (códigos OTP, avisos, facturas…) con
una sola llamada HTTP. Cada clave de API pertenece a un cliente y envía en
nombre de **un buzón remitente** fijo (recomendado: `noreply@su-dominio.com`),
lo que impide suplantaciones entre clientes.

## Autenticación

Cabecera `Authorization` con la clave tal y como se mostró al crearla
(solo se muestra una vez):

```
Authorization: Bearer mw_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Enviar un mensaje

`POST /v1/send` — `Content-Type: application/json`

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `to` | string o string[] | sí | Hasta 50 destinatarios |
| `subject` | string | sí | Máx. 300 caracteres |
| `html` | string | html o text | Cuerpo HTML (máx. 2 MB) |
| `text` | string | html o text | Cuerpo texto plano |
| `fromName` | string | no | Nombre visible del remitente |
| `replyTo` | string | no | Dirección de respuesta |
| `cc`, `bcc` | string[] | no | Hasta 20 cada uno |
| `headers` | objeto | no | Cabeceras extra (p. ej. `X-Campaign`) |

El remitente (`From`) es siempre el buzón asociado a la clave; `fromName`
solo cambia el nombre visible.

### Ejemplo: código OTP

```bash
curl -X POST https://panel.tuempresa.com/v1/send \
  -H "Authorization: Bearer mw_TU_CLAVE" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "cliente@ejemplo.com",
    "subject": "Tu código de acceso",
    "html": "<p>Tu código es <strong>482913</strong>. Caduca en 10 minutos.</p>",
    "text": "Tu código es 482913. Caduca en 10 minutos."
  }'
```

### Ejemplo: Node.js

```js
const res = await fetch('https://panel.tuempresa.com/v1/send', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.MAILWAY_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    to: user.email,
    subject: 'Tu código de acceso',
    html: `<p>Tu código es <strong>${otp}</strong>.</p>`,
  }),
});
const data = await res.json(); // { id, status: 'sent', messageId }
```

## Respuestas

| Código | Significado | Qué hacer |
|---|---|---|
| `200` | `{ id, status: "sent", messageId }` | Nada: entregado al motor |
| `200` | `{ id, status: "failed", error }` | El SMTP rechazó el mensaje; revisa `error` |
| `400` | Datos no válidos | El campo `error` explica cuál |
| `401` | Clave ausente, no válida o revocada | Revisa la cabecera |
| `429` | Límite del plan (por minuto o diario) | Reintenta con espera exponencial |

Los límites (envíos/día y envíos/minuto) los define el plan del cliente; el
contador diario se reinicia a medianoche UTC. Todo envío queda registrado y
visible en la pestaña **API de envío** del panel.

## Buenas prácticas

- Una clave por aplicación y entorno («OTP producción», «Facturas staging»).
- Guarda la clave en un gestor de secretos o variable de entorno, nunca en el
  código.
- Incluye siempre versión `text` además de `html`: mejora la entrega.
- Si recibes `429`, reintenta con espera exponencial (2s, 4s, 8s…).
- Revoca inmediatamente cualquier clave que se haya podido filtrar; crear una
  nueva tarda segundos.
