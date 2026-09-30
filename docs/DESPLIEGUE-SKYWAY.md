# Desplegar Mailway en producción con Skyway

Guía de instalación y validación. El despliegue no se considera producción
hasta superar las pruebas de acceso y entrega del apartado 7. Al final tendrás:

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

1. **Servidor dedicado o VPS** con Docker Compose v2 con soporte para `up --wait` y Skyway ya funcionando
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

En Cloudflare deja `mail` y los webmails personalizados en **DNS only**.
El correo no pasa por el proxy HTTP; además Mailway verifica que el webmail
resuelva a la IP del servidor. No publiques AAAA sin IPv6 operativo.

Espera a que propaguen (`dig +short mail.tuempresa.com` debe devolver tu IP).

## 2. Levantar el motor de correo y el webmail

En el servidor:

```bash
git clone https://github.com/NkrowOne/Mailway.git
cd Mailway/deploy
cp .env.example .env
chmod 600 .env
nano .env        # MAIL_HOSTNAME, WEBMAIL_HOSTNAME, contraseña vigente y TRAEFIK_ACME_VOLUME
./mailway.sh up
```

Comprueba:

```bash
./mailway.sh check
# Si falta algo:
./mailway.sh logs
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
   `MAILWAY_MAIL_HOSTNAME` prevalece sobre Ajustes y cambiarlo requiere
   redesplegar el panel. Las credenciales y SMTP se guardan al configurar el
   motor: en una instalación existente se cambian en Ajustes → Motor.
   La IP y URL del webmail guardadas también prevalecen sobre sus valores iniciales.
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

Antes de copiar el DNS, comprueba que Stalwart anuncia el nombre público
del servidor (por ejemplo `mail.tuempresa.com`). Si el MX o los destinos SRV/CNAME
contienen un identificador como `93e0126401b4`, el motor ha usado un nombre interno
de Docker. Corrige su hostname en la configuración de Stalwart y vuelve a obtener
los registros DNS. `MAILWAY_MAIL_HOSTNAME` tiene prioridad sobre el valor guardado
en Mailway. Al arrancar o guardar los ajustes, Mailway aplica `server.hostname` en
Stalwart, recarga su configuración y verifica el MX que genera antes de dar la
sincronización por correcta. Los Compose también fijan `hostname` para evitar ese
valor interno en nuevas instalaciones.

Para cambiar el nombre posteriormente:

1. Prepara primero el A/AAAA y certificado del nuevo nombre; conserva el nombre
   anterior mientras dure la transición. Actualiza `MAILWAY_MAIL_HOSTNAME` en las variables del panel en Skyway y
   redespliega Mailway. Si la variable no está definida, se usa el valor de Ajustes.
2. Comprueba **Ajustes → Identidad del servidor**: indica si Stalwart ya confirma
   el nuevo hostname. Puedes pulsar **Sincronizar hostname** para reintentar.
   Los fallos quedan visibles en Ajustes y Avisos; el vigilante los reintenta.
3. Alinea `MAIL_HOSTNAME` en el stack de correo y recrea los servicios afectados
   con `./mailway.sh up` para actualizar Roundcube, TLS y las rutas del proxy.
4. Revisa A/AAAA, PTR, certificados y los MX/CNAME/SRV de tus dominios. Los
   informes de DNS anteriores se invalidan cuando se cambia el motor. Los
   dominios anteriormente verificados siguen bajo vigilancia; pulsa Verificar
   para obtener el resultado actualizado sin esperar a la revisión horaria.

Mailway no modifica Cloudflare ni el PTR. Traefik emite los certificados y el
servicio del stack los instala y renueva en Stalwart.
El cambio se aplica al servidor compartido, no a los dominios personalizados del
webmail. La variable de entorno se lee al iniciar el proceso: un cambio en Skyway
requiere un redespliegue. Con `MAILWAY_WATCHDOG_DISABLED=1` no hay reintentos periódicos;
se mantiene la sincronización inicial y la acción manual.

Mailway compara los MX existentes con los anunciados por el motor y la identidad
del panel. Si alguno difiere, pide revisarlo sin afirmar que necesariamente sea
otro proveedor. Si el propio motor anuncia un nombre sin dominio público completo,
lo marca como problema de configuración e impide exportar esa zona.

El servicio `certs-dumper` del Compose actualizado ya no requiere un perfil ni
comandos manuales de API. Usa Python estándar y **no monta el socket Docker**:

1. Lee el volumen `TRAEFIK_ACME_VOLUME` y espera al certificado del hostname exacto.
2. Valida que el certificado y la clave correspondan y los guarda como una pareja
   versionada en `mailway-mail-certs` (solo Stalwart lo monta en lectura).
3. Configura `certificate.default` mediante la API de Stalwart v0.15.5 y recarga.
4. Comprueba nombre, cadena, vigencia y huella del certificado servido en 993/465.
5. Repite cada 30 segundos. Tras una renovación recarga de nuevo; un fallo se
   reintenta sin reescribir ajustes que ya estén guardados. El estado de Docker
   solo es saludable después de verificar ambos puertos.

Este servicio gestiona `certificate.default`: si usas otro sistema de certificados,
resuelve esa configuración antes de activar ambos. La contraseña del `.env` debe
ser la vigente de Stalwart, no una contraseña nueva elegida al actualizar. El valor
inicial del motor solo se usa al crear su volumen. No borres volúmenes para corregir
credenciales. Si has configurado un usuario de ejecución no root en Stalwart,
adapta los permisos del volumen de certificados (por defecto las claves son 0600).

`TRAEFIK_ACME_VOLUME` debe existir. Mira `docker volume ls` y copia su nombre real.
Si `./mailway.sh up` agota los 180 segundos, los servicios permanecen arrancados y
el sincronizador sigue reintentando: corrige DNS/ACME/credenciales y repite `check`.
No se considera un despliegue completado hasta que pase.

Roundcube resuelve el hostname del correo mediante un alias en la red interna:
no necesita salir por la IP pública para volver al mismo servidor. Sigue exigiendo
un certificado válido para el nombre público. Los clientes externos usan DNS normal.

```bash
cd Mailway/deploy
./mailway.sh check
# Tras crear un buzón en el panel (dirección completa; contraseña oculta):
./mailway.sh login
```

`check` prueba TLS y la identidad del motor; desde el contenedor Roundcube carga
su configuración efectiva y abre la conexión IMAP con validación TLS estricta.
`login` añade autenticación y apertura de INBOX mediante la biblioteca de Roundcube;
no guarda la contraseña. **Hasta ejecutar y superar esa prueba, el login IMAP
sigue sin estar acreditado.** Aun superándola, prueba también la sesión web real,
el envío SMTP y la recepción externa.

Desde una máquina externa verifica también 587 con STARTTLS:

```bash
openssl s_client -starttls smtp -connect mail.tuempresa.com:587 \
  -servername mail.tuempresa.com -verify_hostname mail.tuempresa.com \
  -verify_return_error </dev/null
```

**Instalaciones existentes:** actualiza tanto el código del panel como este
checkout del stack; ejecuta `./mailway.sh up`. Se conserva el nombre del servicio
`certs-dumper`, pero se sustituye su imagen anterior por el sincronizador. Los
volúmenes de correo se conservan. No uses `down -v`. Un `docker restart` no aplica
variables o montajes nuevos; `up` recrea los servicios cuya configuración cambia.

**Sin Skyway:** el Compose standalone mantiene su proxy/TLS a cargo del operador;
no dispone del volumen ACME de Skyway ni de este sincronizador. No uses el script
`mailway.sh` con ese stack. Configura TLS válido en Stalwart y repite las mismas
pruebas externas antes de publicarlo.

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
que entren por `mail.sudominio.com`, con su propio certificado, hay que
configurar Traefik **una sola vez**:

1. En el panel, **Ajustes → Marca blanca**: copia el bloque que te muestra (ya
   trae tu token generado).
2. Pégalo en la carpeta de Skyway como `docker-compose.override.yml`. Hay una
   plantilla comentada en `deploy/skyway-traefik-override.yml`.
3. Comprueba con `docker ps` el nombre real del contenedor del panel y ajusta
   la URL del sondeo si no es `mailway-panel`.
4. Aplica: `cd /ruta/a/Skyway && docker compose up -d`.

A partir de ahí se gestiona desde Mailway:

1. El administrador abre **Clientes → un cliente → Configurar webmail**.
   También puede seleccionar el cliente en **Webmail personalizado**.
   El cliente puede gestionar sus propios dominios desde esa misma sección.
2. Añade `mail.sudominio.com` y copia el CNAME o registro A que indica Mailway
   al proveedor DNS de ese dominio. No hace falta modificar el Compose por cliente.
3. Pulsa **Comprobar**. Con el DNS apuntando al servidor, Traefik publica la ruta
   y solicita el certificado. El estado pasa por *Esperando DNS → Pendiente de
   HTTPS → En marcha*. Un 404 o 5xx no cuenta como dominio activo.
4. Si tiene varios dominios de webmail, pulsa **Usar como principal** en el deseado.
   Sin una selección explícita se usa el dominio activo más antiguo.

Los accesos de **Inicio** y **Buzones → Configurar en un dispositivo** usan el
mismo dominio activo del cliente. Si ninguno está activo, usan **Ajustes → URL
general del webmail** (por ejemplo `https://webmail.nkrow.com`). Esta URL general
y `WEBMAIL_HOSTNAME` siguen siendo el acceso compartido; no hay que cambiarlos por
cada cliente. Los servidores IMAP/SMTP mantienen la identidad del servidor de correo.

**Ajustes → Marca blanca** muestra cuándo Traefik consultó por última vez los
dominios. Si nunca ha consultado o lleva más de 90 segundos sin hacerlo, revisa
la URL interna del panel, el token y la red `skyway-edge`. Una consulta confirma
que el proxy obtiene la configuración; la comprobación HTTPS de cada dominio
confirma su respuesta. El certificado debe ser válido y la respuesta HTTP 2xx/3xx.

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

### Lista de salida a producción

Que el contenedor responda no significa todavía que el servicio de correo
esté listo. Antes de aceptar clientes reales, deja **todos** estos puntos
comprobados y registra la fecha de la prueba:

- [ ] El panel solo se publica por HTTPS y `/api/health` devuelve `ok: true`.
- [ ] El volumen persistente de `/data` está montado y una copia de seguridad
  de prueba se ha restaurado en otro directorio. Deben copiarse juntos
  `mailway.db`, sus ficheros WAL/SHM si existen, y `.secret`.
- [ ] Los puertos 25 entrante **y saliente**, 465, 587 y 993 son accesibles
  desde fuera; 8080 permanece ligado a localhost o a la red Docker.
- [ ] El PTR devuelve `MAIL_HOSTNAME` y el registro A de ese nombre vuelve a
  la misma IP (FCrDNS).
- [ ] `openssl s_client` confirma un certificado público vigente en 465 y
  993; no se usa el certificado autofirmado fuera de la red interna.
- [ ] `./mailway.sh check` pasa y `./mailway.sh login` autentica un buzón real.
- [ ] El mismo buzón abre INBOX en el navegador de Roundcube, tanto en la URL
  compartida como en un dominio personalizado.
- [ ] Un dominio piloto muestra MX, SPF, DKIM y DMARC verificados en Mailway.
  No hay MX inesperados ni SPF/DMARC duplicados. Las cabeceras de mensajes
  recibidos fuera acreditan SPF/DKIM/DMARC; el panel no evalúa toda la semántica SPF.
- [ ] Se ha comprobado una renovación de TLS y la nueva huella servida por Stalwart.
- [ ] Se ha probado recepción, envío SMTP autenticado y `POST /v1/send` en
  ambos sentidos con Gmail u Outlook; no basta con probar dentro del dominio.
- [ ] Hay al menos un canal de avisos configurado y el aviso de prueba llega.
- [ ] La restauración de los volúmenes del motor y del panel se ha ensayado;
  una copia que nunca se restauró no se considera verificada.
- [ ] Se ha acordado calentamiento de IP y límites bajos para el primer
  cliente. No se inicia envío masivo desde una IP nueva.

**Criterio de decisión:** el software puede desplegarse cuando pasan la
compilación, las pruebas y esta lista. La disponibilidad, reputación, PTR,
firewall, TLS y restauración dependen del servidor final y no pueden validarse
desde el repositorio. Mientras quede una casilla sin comprobar, trátalo como
preproducción.

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
  ./mailway.sh up
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
