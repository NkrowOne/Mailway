# 📮 Mailway

**Tu propio servicio de correo multi-cliente, auto-alojado sobre Docker.**

Crea cuentas de correo para tus clientes y dales un panel donde ellos mismos
gestionan sus buzones (hasta el máximo de su plan), configuran el DNS de su
dominio con un asistente verificado en vivo, y envían correo automatizado
(códigos OTP, avisos) a través de una API HTTP. Con recomendaciones de
spam/entregabilidad en español y webmail incluido.

> Pensado para desplegarse junto a [Skyway](https://github.com/NkrowOne/Skyway):
> el panel se despliega desde GitHub con auto-deploy, y el motor de correo va
> en un docker-compose adyacente. También funciona sin Skyway.

## Características

- **Multi-cliente con planes** — límites de dominios, buzones, alias y envíos
  de API por cliente, impuestos en el servidor. Cada cliente ve solo lo suyo.
- **Asistente DNS con verificación en vivo** — la tabla exacta de registros
  (MX, SPF, DKIM, DMARC, autoconfiguración) lista para copiar, y un botón
  «Verificar» que consulta el DNS público y sella cada registro correcto.
- **API de envío transaccional** — `POST /v1/send` con clave `mw_…` por
  aplicación, límites por minuto y por día según plan, historial de envíos en
  el panel. Ideal para OTP. [Documentación](docs/API.md).
- **Asesor de entregabilidad** — PTR, registro A, listas negras (Spamhaus,
  SpamCop, Barracuda) y una lista de tareas priorizada en español.
- **Buzones reales** — IMAP/SMTP/webmail (Roundcube), cuotas, alias,
  contraseñas generadas que se muestran una sola vez, tarjeta de datos de
  conexión para configurar dispositivos.
- **Marca blanca** — cada cliente puede servir el webmail en **su propio
  dominio** (`webmail.sucliente.com`) con certificado automático: añade el
  dominio, copia el CNAME, y cuando el DNS apunta al servidor Traefik lo
  enruta y emite el certificado solo. Autoservicio, sin tocar el servidor.
- **Vigilante con avisos** — comprueba el motor, el webmail y la cola cada
  minuto, el DNS de los dominios cada hora y las listas negras a diario; avisa
  por **Discord, Telegram o webhook**, sin repetir el mismo aviso y con
  mensaje de recuperación cuando se arregla.
- **Motor desacoplado** — Stalwart Mail Server tras una interfaz de driver;
  incluye un **modo demostración** para probar todo el panel sin motor.
- **Seguridad** — sesiones revocables, límite de intentos de login, registro
  de auditoría completo, secretos cifrados en reposo, confirmaciones
  proporcionales al daño.

## Despliegue en producción

Guía completa paso a paso: **[docs/DESPLIEGUE-SKYWAY.md](docs/DESPLIEGUE-SKYWAY.md)**.

Resumen: 1) desbloquea el puerto 25 y configura el PTR; 2) levanta
`deploy/docker-compose.mail.yml` (motor + webmail); 3) despliega el panel con
Skyway desde este repo (puerto 4100, volumen `/data`, dominio con TLS);
4) sigue el asistente de primera puesta en marcha.

Sin Skyway: `deploy/docker-compose.standalone.yml` levanta panel + motor +
webmail en un solo comando.

## Desarrollo

```bash
npm install
npm run dev              # servidor :4100 + web :5173
MAILWAY_DEMO=1 npm run dev   # sin motor de correo real
npm run typecheck && npm test
```

## Documentación

- [Plan técnico y decisiones de arquitectura](docs/PLAN.md)
- [Guía de despliegue con Skyway](docs/DESPLIEGUE-SKYWAY.md)
- [API de envío transaccional](docs/API.md)

## Arquitectura

- **Servidor**: Node 20+ / TypeScript / Fastify. Estado en SQLite (`/data`).
  Habla con el motor de correo (Stalwart v0.15) por su API REST de gestión.
- **Web**: React + Vite + Tailwind, en español.
- **Motor**: [Stalwart](https://stalw.art) v0.15 (SMTP + IMAP + antispam +
  DKIM) y [Roundcube](https://roundcube.net) como webmail, vía docker-compose.
