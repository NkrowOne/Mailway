# Mailway

**Servicio de correo multi-cliente y auto-alojado, sobre Docker.**

Mailway convierte un servidor propio en un proveedor de correo para varios
clientes: cada cliente tiene un plan con límites, un panel donde gestiona sus
dominios, buzones, alias y claves de API, y los titulares de los buzones
configuran sus dispositivos con un enlace o desde su propio portal. El motor
de correo es [Stalwart](https://stalw.art) v0.15 y el webmail,
[Roundcube](https://roundcube.net), ambos en español.

> Pensado para desplegarse junto a [Skyway](https://github.com/NkrowOne/Skyway):
> el panel se despliega desde GitHub con Skyway y el motor de correo va en un
> docker-compose adyacente. Skyway 0.34 o posterior gestiona además el correo
> de cada proyecto. Mailway también funciona sin Skyway.

## Funciones

- **Clientes con planes.** Límites de dominios, buzones, alias, cuota por
  buzón y envíos por API (por minuto y por día), impuestos en el servidor. Las
  altas de un mismo cliente se serializan, así que ni las peticiones
  simultáneas superan el plan. Cada cliente ve solo lo suyo.
- **DNS en un clic con Cloudflare.** Con una cuenta de Cloudflare conectada,
  Mailway muestra qué registros va a crear, cuáles ya están bien y cuáles
  chocan con otros, y los aplica en una sola operación. Si el DNS está en otro
  proveedor, el asistente da la tabla exacta de registros para copiar (o un
  fichero de zona para importar) y verifica cada uno en vivo.
- **Verificación de la propiedad de los dominios.** No se crean buzones ni
  alias en un dominio hasta comprobar que es de quien lo da de alta: su MX
  apunta a este servidor o tiene el registro TXT de verificación.
- **Configuración automática de dispositivos.** Thunderbird, Outlook y los
  dispositivos de Apple se configuran solos (autoconfig, Autodiscover y
  perfiles `.mobileconfig`). El administrador envía al titular un **enlace de
  configuración** con código QR y pasos para su dispositivo.
- **Portal «Mi buzón».** El titular entra con su dirección y su contraseña para
  ver sus datos de conexión, descargar el perfil, cambiar la contraseña y crear
  **contraseñas de aplicación** (una por dispositivo o programa, revocables).
- **Webmail en español.** Roundcube con cambio de contraseña, filtros,
  reenvío, aviso de ausencia, archivo y botón para marcar correo no deseado.
- **API de envío transaccional.** `POST /v1/send` con clave `mw_…` por
  aplicación, adjuntos (PDF, invitaciones `.ics`, imágenes…), reintentos sin
  duplicados con `Idempotency-Key`, límites del plan por cliente e historial
  de envíos. Al crear una clave o una contraseña de aplicación, el panel da el
  `.env` y el código de Node, Laravel y Django listos para copiar.
  [Documentación](docs/API.md).
- **Formularios de contacto para webs estáticas.** Un fragmento HTML con una
  clave pública: los mensajes llegan al buzón del cliente, solo desde sus
  webs, con campo trampa, límites y Cloudflare Turnstile opcional.
  [Integraciones](docs/INTEGRACIONES.md#9-formularios-de-contacto-para-webs-estáticas).
- **Tokens de gestión.** Todo lo que hace el panel está disponible por API con
  un token `mwt_…`, para scripts, CI, agentes o Skyway.
  [Integraciones](docs/INTEGRACIONES.md).
- **Integración con Skyway.** Desde el botón «Correo» de cada proyecto de
  Skyway se activa el correo, se añaden dominios y buzones y se conecta un
  servicio por SMTP o por la API. El Traefik de Skyway publica solo las rutas
  que Mailway necesita, sin editar ningún fichero.
- **Vigilante con avisos.** Comprueba el motor, el webmail y la cola cada
  minuto; el DNS de los dominios, la autoconfiguración y la marca blanca con
  una frecuencia que depende de su estado; las listas negras y el certificado
  del motor a diario. Avisa por Discord, Telegram o webhook, sin repetir el
  mismo aviso y con mensaje de recuperación.
- **Marca blanca.** Cada cliente puede servir el webmail en su propio dominio
  (`webmail.sucliente.com`) con certificado automático.
- **Asesor de entregabilidad.** PTR, registro A, listas negras y una lista de
  tareas priorizada en español.
- **Instalador.** `deploy/instalar.sh` prepara motor, webmail, DNS en
  Cloudflare, certificado y panel en Skyway en una sola ejecución, y se puede
  repetir sin riesgo.

## Puesta en marcha rápida

Requisitos: un servidor con Docker y Docker Compose v2, el **puerto 25 de
salida desbloqueado** por el proveedor y el **DNS inverso (PTR)** de la IP
apuntando al futuro `mail.<tu dominio>`. Con Skyway, Skyway debe estar en
marcha.

```bash
git clone https://github.com/NkrowOne/Mailway.git
cd Mailway
sudo bash deploy/instalar.sh              # junto a Skyway (recomendado)
sudo bash deploy/instalar.sh --sin-skyway # sin Skyway: todo en un compose propio
```

El instalador pregunta el dominio base, la IP y, de forma opcional, un token
de Cloudflare y un token de API de Skyway. Al terminar muestra la dirección
de la puesta en marcha (`https://panel.<dominio>/setup?token=…`): ábrela y
completa el asistente. Guía completa, variables de ejecución desatendida y
camino manual en **[docs/DESPLIEGUE-SKYWAY.md](docs/DESPLIEGUE-SKYWAY.md)**.

## Desarrollo

```bash
npm install
npm run dev                  # servidor :4100 + web :5173
MAILWAY_DEMO=1 npm run dev   # sin motor de correo real (modo demostración)
npm run typecheck && npm run lint && npm test && npm run build
```

## Documentación

- [Despliegue (instalador, Skyway, TLS, problemas frecuentes)](docs/DESPLIEGUE-SKYWAY.md)
- [API de envío transaccional](docs/API.md)
- [Integraciones: tokens de gestión, Skyway, Cloudflare, autoconfiguración](docs/INTEGRACIONES.md)
- [Modelo de seguridad](docs/SEGURIDAD.md)
- [Guía para los titulares de los buzones](docs/GUIA-TITULARES.md)
- [Plan técnico y decisiones de arquitectura](docs/PLAN.md)
- [Sistema de diseño de la web](DESIGN.md) y [producto](PRODUCT.md)

## Arquitectura

- **Panel**: Node 20+ / TypeScript / Fastify, estado en SQLite (`/data`), web
  React + Vite + Tailwind servida por el mismo proceso en el puerto 4100.
  Habla con el motor por su API REST de gestión.
- **Motor**: Stalwart **v0.15.5, fijado** (SMTP, IMAP, ManageSieve, antispam,
  DKIM). La v0.16 eliminó la API REST que usa Mailway.
- **Webmail**: Roundcube 1.7, conectado al motor por una red interna.
- **Proxy**: el Traefik de Skyway (o uno propio con `--profile proxy`) da
  HTTPS al panel, al webmail y a los nombres de autoconfiguración.
