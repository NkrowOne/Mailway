# Desplegar Mailway en producción con Skyway

Guía paso a paso, pensada para hacerse en una tarde. Al final tendrás:

- El **panel Mailway** desplegado desde GitHub vía Skyway, con dominio y HTTPS,
  y auto-deploy en cada push.
- El **motor de correo** (Stalwart) y el **webmail** (Roundcube) corriendo en
  docker-compose junto a Skyway.
- Un primer cliente con su dominio verificado, buzones y clave de API.

> **Arquitectura en una frase:** Skyway solo puede publicar un puerto por
> servicio, y un servidor de correo necesita varios (25, 465, 587, 993); por
> eso el motor va en un compose propio con los puertos directos al host,
> mientras que el panel — una web normal — sí se despliega y actualiza con
> Skyway. Ambos se ven a través de la red Docker `skyway-edge`.

```
                    ┌────────────────────── tu servidor ──────────────────────┐
   :80/:443 ─────►  │  Traefik (de Skyway)                                    │
                    │   ├─ panel.tudominio.com   → mailway-panel  (Skyway)    │
                    │   ├─ webmail.tudominio.com → mailway-webmail (compose)  │
                    │   └─ mail.tudominio.com    → webadmin del motor         │
   :25 :465 :587 ─► │  mailway-mail (Stalwart v0.15, compose)                 │
   :993             │       ▲ http://mailway-mail:8080 (API de gestión)       │
                    │       └── mailway-panel la usa vía red skyway-edge      │
                    └─────────────────────────────────────────────────────────┘
```

---

## 0. Requisitos previos

1. **Servidor dedicado o VPS** con Docker y Skyway ya funcionando
   (Traefik en 80/443 con `LETSENCRYPT_EMAIL` configurado).
2. **Un dominio para la plataforma** (p. ej. `tuempresa.com`) cuyo DNS puedas
   editar. Reservaremos:
   - `mail.tuempresa.com` → identidad del servidor de correo
   - `panel.tuempresa.com` → panel Mailway
   - `webmail.tuempresa.com` → Roundcube
3. **Puerto 25 de salida abierto.** La mayoría de proveedores (Hetzner, OVH,
   AWS, DigitalOcean…) lo bloquean por defecto: abre un ticket pidiendo que lo
   desbloqueen ("quiero operar un servidor de correo"). Sin esto **no se puede
   enviar correo a otros servidores**. Compruébalo desde el servidor:
   ```bash
   timeout 5 bash -c 'cat < /dev/null > /dev/tcp/gmail-smtp-in.l.google.com/25' && echo ABIERTO || echo BLOQUEADO
   ```
4. **PTR (DNS inverso).** En el panel de tu proveedor de servidor (no en tu
   DNS), configura el registro inverso de la IP → `mail.tuempresa.com`.
   Gmail y Outlook rechazan servidores sin PTR coherente.

## 1. DNS base de la plataforma

En tu proveedor de DNS crea (sustituye `203.0.113.10` por tu IP):

| Tipo | Nombre | Valor |
|------|--------------------|----------------|
| A | mail.tuempresa.com | 203.0.113.10 |
| A | panel.tuempresa.com | 203.0.113.10 |
| A | webmail.tuempresa.com | 203.0.113.10 |

Espera a que propaguen (`dig +short mail.tuempresa.com` debe devolver tu IP).

## 2. Levantar el motor de correo y el webmail

En el servidor:

```bash
git clone https://github.com/NkrowOne/Mailway.git
cd Mailway/deploy
cp .env.example .env
nano .env        # MAIL_HOSTNAME, WEBMAIL_HOSTNAME y STALWART_ADMIN_PASSWORD
docker compose -f docker-compose.mail.yml up -d
```

Comprueba:

```bash
docker logs mailway-mail | head -30     # debe arrancar sin errores
docker ps                               # mailway-mail y mailway-webmail "Up"
```

- El webadmin del motor queda en `https://mail.tuempresa.com` (usuario
  `admin`, la contraseña de tu `.env`). No necesitas tocarlo en el día a día:
  Mailway lo gestiona por API.
- El webmail queda en `https://webmail.tuempresa.com`.

> La imagen de Stalwart está **fijada a v0.15** a propósito: la v0.16 eliminó
> la API REST que usa Mailway. No la actualices sin leer `docs/PLAN.md`.

## 3. Desplegar el panel Mailway con Skyway

En el panel de Skyway:

1. **Crea un proyecto** (p. ej. `mailway`).
2. **Nuevo servicio → Repositorio de GitHub**:
   - Repo: `NkrowOne/Mailway` — rama `main` — puerto interno `4100`.
   - Skyway construirá con el `Dockerfile` del repo.
3. **Variables** del servicio (pestaña Variables):
   ```
   STALWART_URL=http://mailway-mail:8080
   STALWART_ADMIN_USER=admin
   STALWART_ADMIN_PASSWORD=(la de tu .env del compose)
   STALWART_SMTP_HOST=mailway-mail
   STALWART_SMTP_PORT=587
   MAILWAY_SMTP_ALLOW_SELF_SIGNED=1
   MAILWAY_MAIL_HOSTNAME=mail.tuempresa.com
   MAILWAY_WEBMAIL_URL=https://webmail.tuempresa.com
   ```
   (Son valores iniciales para el asistente; luego todo se cambia en Ajustes.)
4. **Volumen**: añade un volumen en `/data` (ahí viven la base de datos y la
   clave secreta del panel).
5. **Dominio**: en Ajustes del servicio añade `panel.tuempresa.com` → Traefik
   emitirá el certificado.
6. **Auto-deploy**: copia la URL y el secreto del webhook (Ajustes del
   servicio en Skyway) y pégalos en GitHub → Settings → Webhooks del repo.
   Cada push a `main` redesplegará el panel.
7. Despliega y abre `https://panel.tuempresa.com`.

> **Nota:** el panel llega al motor por la red `skyway-edge` porque el compose
> del paso 2 conecta `mailway-mail` a esa red. Si el deploy del panel dice
> "engine_unreachable", revisa que el compose esté levantado antes.

## 4. Asistente de primera puesta en marcha

Al abrir el panel por primera vez, Mailway te guía en 4 paradas:

1. **Administrador** — tu cuenta del panel (no es la del motor).
2. **Motor de correo** — verás los datos ya rellenos con las variables del
   paso 3; pulsa «Probar conexión y continuar».
3. **Servidor** — FQDN (`mail.tuempresa.com`), IP pública (botón «Detectar»)
   y URL del webmail.
4. **Arranque** — resumen y entrada al panel.

## 5. TLS del motor (IMAP/SMTP con certificado válido)

Los clientes de correo (Thunderbird, iPhone) exigen un certificado válido en
993/465. El Traefik de Skyway ya obtuvo uno para `mail.tuempresa.com` en el
paso 2; solo hay que dárselo a Stalwart:

```bash
# 1) Comprueba el nombre real del volumen de certificados de Skyway:
docker volume ls | grep letsencrypt     # p. ej. skyway_traefik-letsencrypt
# (si difiere, ajusta TRAEFIK_ACME_VOLUME en deploy/.env)

# 2) Arranca el volcador de certificados:
cd Mailway/deploy
docker compose -f docker-compose.mail.yml --profile tls up -d certs-dumper
docker exec mailway-certs-dumper ls /output    # debe listar mail.tuempresa.com/
```

3) Di a Stalwart que use esos ficheros — una sola vez, desde el webadmin
   (`https://mail.tuempresa.com` → Settings → TLS → Certificates) o por API:

```bash
PASS='TU_STALWART_ADMIN_PASSWORD'
curl -su "admin:$PASS" -X POST https://mail.tuempresa.com/api/settings \
  -H 'Content-Type: application/json' \
  -d '[{"type":"insert","prefix":"certificate.default","values":[["cert","%{file:/opt/stalwart/certs/mail.tuempresa.com/cert.pem}%"],["private-key","%{file:/opt/stalwart/certs/mail.tuempresa.com/key.pem}%"],["default","true"]]}]'
curl -su "admin:$PASS" https://mail.tuempresa.com/api/reload/certificate
```

Verifica: `openssl s_client -connect mail.tuempresa.com:993 < /dev/null 2>/dev/null | openssl x509 -noout -issuer` → debe decir Let's Encrypt.

## 6. Primer cliente de verdad

En el panel (`https://panel.tuempresa.com`):

1. **Clientes → Nuevo cliente** — nombre y plan (los tres planes de ejemplo se
   pueden editar por API o directamente en la tabla `plans`; ver PLAN.md).
2. **Crear usuario de acceso** — el correo y contraseña con los que tu cliente
   entrará a SU panel (verá solo lo suyo).
3. El cliente (o tú) entra y sigue el **manifiesto de puesta en marcha**:
   - **Añadir dominio** → alta de `su-dominio.com`.
   - **Configurar DNS** → el asistente lista los registros exactos (MX, SPF,
     DKIM, DMARC + recomendados) con botón de copiar y **verificación en
     vivo**: cada registro correcto queda sellado como VERIFICADO.
   - **Crear buzones** → la contraseña se genera y se muestra una sola vez;
     el botón «Conexión» da la tarjeta IMAP/SMTP para configurar dispositivos.
   - **Clave de API** → para envíos automatizados; ver `docs/API.md`.

## 6 bis. Avisos: que te enteres si algo se cae

El panel trae un **vigilante** que comprueba cada minuto el motor de correo, el
webmail y la cola de salida, cada hora el DNS de los dominios ya verificados, y
una vez al día las listas negras de la IP. Cuando algo se rompe abre una
incidencia en **Avisos** y te la manda por los canales que configures.

En **Avisos → Cómo quieres que te avise** rellena al menos uno:

- **Discord**: Ajustes del canal → Integraciones → Webhooks → Copiar URL.
- **Telegram**: crea un bot con [@BotFather](https://t.me/BotFather) y pon su
  token y el ID de tu chat.
- **Webhook genérico**: recibe un JSON; útil para n8n o tu propio sistema.

Pulsa **Enviar aviso de prueba** y confirma que te llega. Sin ningún canal, las
incidencias solo aparecen en el panel y no te enterarás hasta entrar.

> Skyway no vigila estos contenedores (su monitor solo ve sus propios
> servicios), así que este vigilante es lo que cubre el correo.

## 6 ter. Marca blanca: el webmail en el dominio de cada cliente

Por defecto todos tus clientes entran por `webmail.tuempresa.com`. Si quieres
que entren por `webmail.sucliente.com`, con su propio certificado, hay que
configurar Traefik **una sola vez**:

1. En el panel, **Ajustes → Marca blanca**: copia el bloque que te muestra (ya
   trae tu token generado).
2. Pégalo en la carpeta de Skyway como `docker-compose.override.yml`. Hay una
   plantilla comentada en `deploy/skyway-traefik-override.yml`.
3. Comprueba con `docker ps` el nombre real del contenedor del panel y ajusta
   la URL del sondeo si no es `mailway-panel`.
4. Aplica: `cd /ruta/a/Skyway && docker compose up -d`.

A partir de ahí es autoservicio: en **Marca blanca**, el cliente añade su
dominio, copia el CNAME que le damos, pulsa **Comprobar**, y cuando el DNS
apunta aquí Traefik pide el certificado solo. El panel pasa el dominio por
*Esperando DNS → Emitiendo certificado → En marcha*.

**Por qué funciona así**: Compose fusiona `docker-compose.override.yml` con el
principal, de modo que el repositorio de Skyway no se toca y el cambio
sobrevive a un `git pull`. Traefik pregunta a Mailway qué dominios servir
(`--providers.http.endpoint`), autenticándose con el token; Mailway solo
publica los dominios cuyo DNS **ya** apunta al servidor, porque publicar uno
que no resuelve haría fallar la validación de Let's Encrypt y acabaría en un
bloqueo temporal por reintentos.

> Ojo con `command`: Compose lo **reemplaza** entero, no lo fusiona. Por eso la
> plantilla repite los flags que Skyway ya traía. Si algún día actualizas
> Skyway y cambia su configuración de Traefik, compara ambas listas.

## 7. Entregabilidad: antes de enviar en volumen

En **Entregabilidad** el panel comprueba PTR, registro A y listas negras
(Spamhaus, SpamCop, Barracuda) y te da la lista de tareas en orden. Reglas de
oro para no caer en spam:

- **Calienta la IP**: si es nueva, empieza con decenas de envíos al día y sube
  gradualmente durante 2–4 semanas.
- **DMARC en `p=quarantine` o `p=reject`** cuando SPF y DKIM lleven unos días
  verdes (el asistente del dominio ya lo propone).
- Prueba con [mail-tester.com](https://www.mail-tester.com): envía un correo
  desde un buzón y desde la API; apunta a 10/10.
- Si Spamhaus marca "no concluyente", consulta manualmente en
  [check.spamhaus.org](https://check.spamhaus.org) (las consultas por
  resolutores públicos las rechazan).

## 8. Operación y copias de seguridad

- **Actualizar el panel**: push a `main` → webhook → Skyway redespliega solo.
- **Datos a respaldar**:
  - Volumen `/data` del panel (SQLite + clave secreta).
  - Volumen `mailway-mail-data` (todo el correo y la config del motor).
  - Volúmenes del webmail (ajustes de usuarios).
  Con Skyway puedes programar backups del panel; para el motor:
  ```bash
  docker run --rm -v mailway-mail-data:/src -v /root/backups:/dst alpine \
    tar czf /dst/mailway-mail-$(date +%F).tar.gz -C /src .
  ```
- **Logs del motor**: `docker logs -f mailway-mail`.
- **Cola de salida**: visible en el Panel de operaciones de Mailway.
- **Actualizar el stack de correo** (no va por Skyway):
  ```bash
  cd /ruta/a/Mailway/deploy
  git pull
  docker compose -f docker-compose.mail.yml pull
  docker compose -f docker-compose.mail.yml up -d
  ```
  Los volúmenes no se tocan: el correo sobrevive. Stalwart está fijado a
  `v0.15.5` a propósito (ver el aviso del apartado 9), así que ese `pull` nunca
  salta a v0.16.
- **Liberar espacio desde Skyway es seguro**: su botón ejecuta
  `docker image prune -f` y `docker builder prune -f`, que solo borran imágenes
  huérfanas y caché de compilación. No toca volúmenes ni imágenes en uso.

## 9. Problemas frecuentes

| Síntoma | Causa probable | Arreglo |
|---|---|---|
| «engine_unreachable» al configurar el motor | El compose del correo no está levantado o el panel no está en `skyway-edge` | `docker compose -f docker-compose.mail.yml up -d`; añade dominio al panel en Skyway (eso lo conecta a la red edge) |
| Gmail rechaza con «PTR record» | DNS inverso sin configurar | Panel del proveedor del servidor → reverse DNS → `mail.tuempresa.com` |
| No llega correo de fuera | Puerto 25 de entrada cerrado o MX mal | `dig MX su-dominio.com`; firewall/cloud: abre 25 entrante |
| No sale correo a Gmail/Outlook | Puerto 25 de salida bloqueado por el proveedor | Ticket al proveedor (paso 0.3) |
| Thunderbird avisa de certificado | TLS del motor sin configurar | Paso 5 |
| El envío por API falla con 502 | SMTP interno con certificado autofirmado | `MAILWAY_SMTP_ALLOW_SELF_SIGNED=1` en variables del panel (o completa el paso 5 y apunta `STALWART_SMTP_HOST` a `mail.tuempresa.com`) |
| Un dominio de marca blanca se queda en «Emitiendo certificado» | Traefik no está sondeando el panel, o el puerto 80 está cerrado | Revisa el bloque de Ajustes → Marca blanca en el `docker-compose.override.yml` de Skyway y que el nombre del contenedor del panel sea el real (`docker ps`). Let's Encrypt valida por el puerto 80: tiene que estar abierto |
| El dominio de marca blanca da 404 de Traefik | El DNS todavía no apunta aquí, así que Mailway no lo publica | Es el comportamiento correcto: publica solo lo verificado para no quemar el cupo de Let's Encrypt. Pulsa «Comprobar» cuando el DNS esté puesto |
| No me llegan los avisos | Ningún canal configurado, o token/URL mal | Avisos → «Enviar aviso de prueba»; si falla, el panel dice qué canal |
