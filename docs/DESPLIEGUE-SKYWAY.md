# Desplegar Mailway en producción

Guía para dejar Mailway funcionando en un servidor propio, junto a Skyway
(recomendado) o de forma autónoma. Al terminar dispondrá de:

- el **panel de Mailway** en `https://panel.<su dominio>`, desplegado desde
  GitHub por Skyway y con actualización automática;
- el **motor de correo** (Stalwart) y el **webmail** (Roundcube) en un
  docker-compose junto a Skyway, con certificado válido para IMAP y SMTP;
- la **conexión con Skyway** para gestionar el correo de cada proyecto desde
  su botón «Correo».

La forma recomendada es el instalador (`deploy/instalar.sh`, sección 2). La
sección 6 describe el mismo proceso a mano.

> **Por qué hay dos piezas.** Skyway publica un solo puerto por servicio, y un
> servidor de correo necesita varios (25, 465, 587, 993 y 4190). Por eso el
> motor va en un compose propio con los puertos directos al host, mientras que
> el panel, que es una web normal, se despliega y actualiza con Skyway. Ambos
> se comunican por la red Docker `skyway-edge`.

```
                    ┌──────────────────────────── servidor ─────────────────────────────┐
  :80 / :443 ─────► │ Traefik de Skyway (skyway-traefik)                                │
                    │   ├─ panel.<dominio>    → skyway-mailway-panel:4100  (Skyway)     │
                    │   ├─ webmail.<dominio>  → mailway-webmail:80         (compose)    │
                    │   ├─ mail.<dominio>     → mailway-mail:8080 (web del motor)       │
                    │   └─ autoconfig., autodiscover., mta-sts., webmail de clientes    │
                    │        → rutas que publica Mailway a través del puente de Skyway  │
  :25 :465 :587 ──► │ mailway-mail (Stalwart v0.15.5, compose)                          │
  :993 :4190        │   ▲ http://mailway-mail:8080 (API de gestión; no se publica)      │
                    │   └── el panel la usa por skyway-edge; el webmail usa IMAP/SMTP   │
                    │       por mailway-internal (10.203.53.0/24)                       │
                    └───────────────────────────────────────────────────────────────────┘
```

---

## 1. Requisitos previos

1. **Servidor dedicado o VPS** con Docker y Docker Compose v2 (`docker compose
   version`). Con Skyway: Skyway en marcha (contenedores `skyway` y
   `skyway-traefik`, red `skyway-edge`) y con correo de Let's Encrypt
   configurado en **Skyway → Ajustes → Dominios**; sin él, Traefik no emite
   certificados.
2. **Un dominio para la plataforma** (p. ej. `miempresa.com`) cuyo DNS pueda
   editar. Se usan tres nombres:
   - `mail.miempresa.com`: nombre del servidor de correo;
   - `panel.miempresa.com`: panel de Mailway;
   - `webmail.miempresa.com`: webmail.
3. **Puerto 25 de salida abierto.** Muchos proveedores (Hetzner, OVH, AWS,
   DigitalOcean…) lo bloquean por defecto: solicite el desbloqueo indicando que
   va a operar un servidor de correo. Sin él no se entrega correo a otros
   servidores. Compruébelo desde el servidor:
   ```bash
   timeout 5 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25' && echo ABIERTO || echo BLOQUEADO
   ```
4. **DNS inverso (PTR).** En el panel del proveedor del servidor (no en su
   DNS), configure el registro inverso de la IP para que devuelva
   `mail.miempresa.com`. Gmail y Outlook rechazan servidores sin PTR coherente.
5. **Puertos de correo libres**: 25, 465, 587, 993 y 4190. Si el sistema trae
   Postfix o Exim, desactívelos.
6. **Opcional, pero recomendado:**
   - un **token de API de Cloudflare** si el DNS del dominio está en
     Cloudflare, con los permisos *Zona → Zona → Leer* y *Zona → DNS →
     Editar*. El instalador crea con él los registros de la plataforma y el
     motor obtiene su certificado por DNS;
   - un **token de API de Skyway** de administrador (`sky_…`, en Skyway → Mi
     perfil → Tokens de API) para que el instalador despliegue el panel.

---

## 2. Instalación con el instalador (recomendada)

### 2.1 Ejecutar

```bash
git clone https://github.com/NkrowOne/Mailway.git
cd Mailway
sudo bash deploy/instalar.sh
```

El instalador es **idempotente**: se puede ejecutar tantas veces como haga
falta. Guarda la configuración y los secretos en `deploy/.env` (permisos 600)
y los reutiliza en las ejecuciones siguientes; nunca regenera la contraseña de
un motor que ya tiene datos.

### 2.2 Qué pregunta

| Pregunta | Valor por defecto | Variable para responderla sin preguntar |
|---|---|---|
| Dominio base de la plataforma | el de una ejecución anterior | `MAILWAY_DOMINIO` |
| Nombre del servicio en el webmail | `Webmail` | `MAILWAY_MARCA` |
| Correo de contacto para Let's Encrypt | `postmaster@<dominio>` | `LETSENCRYPT_EMAIL` |
| IPv4 pública del servidor | la detectada | `MAILWAY_IP` |
| Token de API de Cloudflare (Intro para omitir) | — | `CLOUDFLARE_API_TOKEN` |
| Token de API de Skyway (Intro para omitir) | — | `SKYWAY_TOKEN` |
| ¿Configurar el Traefik de Skyway para los dominios de los clientes? | sí | `MAILWAY_TRAEFIK_PROVEEDOR` |

Los nombres `mail.`, `webmail.` y `panel.` cuelgan del dominio base; se
pueden cambiar con `MAILWAY_MAIL_HOST`, `MAILWAY_WEBMAIL_HOST` y
`MAILWAY_PANEL_HOST` (deben seguir siendo subdominios del dominio base).

Si el motor ya tiene datos y `deploy/.env` no guarda su contraseña, el
instalador la pide (o la toma de `STALWART_ADMIN_PASSWORD`).

### 2.3 Qué hace, en orden

1. **Comprobaciones previas**: Docker y Compose v2, contenedor
   `skyway-traefik` y red `skyway-edge` (salvo con `--sin-skyway`), puertos de
   correo libres y puerto 25 de salida.
2. **Datos**: dominio, nombres, marca, correo de Let's Encrypt (rechaza los
   de `example.com`, que Let's Encrypt no admite) e IP. Comprueba que la
   subred interna no se solapa con otra red de Docker ni con una ruta del
   servidor (VPN, red privada del proveedor). Con Skyway, detecta el volumen
   de certificados de su Traefik y la carpeta de Skyway, y avisa si su
   Traefik no tiene un correo válido para Let's Encrypt.
3. **Migración**: si detecta una instalación anterior a la 1.0, reutiliza sus
   volúmenes (sección 8.2).
4. **Secretos**: genera los que falten (`MAILWAY_SECRET`,
   `ROUNDCUBE_DES_KEY`, `MAILWAY_TRAEFIK_TOKEN`, `MAILWAY_SETUP_TOKEN`,
   `MAILWAY_WEBMAIL_TOKEN` y la contraseña del motor).
5. **`deploy/.env`**: lo escribe con permisos 600 y los valores entre
   comillas simples (Compose no interpreta `$`, `#` ni los espacios). Guarda
   el modo de instalación (`MAILWAY_INSTALACION`), conserva las claves que se
   hayan añadido a mano y guarda la versión con la que empezó la ejecución
   como `.env.anterior` (también con permisos 600).
6. **DNS en Cloudflare** (si hay token): verifica el token (también los
   tokens de cuenta) y crea o corrige, sin proxy, los registros A de `mail.`,
   `webmail.` y `panel.` hacia la IP, y los CNAME `autoconfig.` y
   `autodiscover.` del dominio base hacia `mail.`. Si un nombre ya apunta a
   otro sitio, pregunta antes de cambiarlo. En `autoconfig.` y
   `autodiscover.`, que pueden estar sirviendo a otro proveedor (por ejemplo,
   Microsoft 365), la respuesta por defecto es no cambiarlos, también en la
   ejecución desatendida.
7. **Propagación**: espera (hasta `MAILWAY_ESPERA_DNS` segundos, 300 por
   defecto) a que los tres nombres resuelvan a la IP. Así Traefik no pide
   certificados que Let's Encrypt rechazaría.
8. **PTR**: comprueba el DNS inverso y lo incluye en el resumen.
9. **Motor y webmail**: levanta `mailway-mail`, espera a que esté sano y
   después `mailway-webmail`. En núcleos sin IPv6, cambia el motor a IPv4.
10. **Ajustes del motor**: fija `server.hostname`, `http.use-x-forwarded` y
    la exención de la red interna (los mismos ajustes que «Aplicar ajustes
    recomendados» del panel) y configura el certificado: con Cloudflare, ACME
    del propio motor por DNS-01 (sección 5.1); sin Cloudflare, el volcado del
    certificado de Traefik (sección 5.2).
11. **Panel en Skyway** (si hay token): crea (o reutiliza) el proyecto
    `mailway` y su servicio `panel` desde GitHub, con puerto 4100, dominio,
    volumen `/data`, comprobación `/api/health` y todas las variables, sin
    perder los volúmenes, dominios ni variables que se hayan añadido a mano;
    lanza el despliegue y espera a que termine. Después enlaza el webmail con
    el contenedor real del panel (`MAILWAY_PANEL_INTERNAL_URL`). Si el motor
    ya tiene certificado, retira `MAILWAY_SMTP_ALLOW_SELF_SIGNED` de las
    variables del panel (sección 5.4).
12. **Traefik**: con Skyway 0.34 o posterior no instala nada, porque el
    puente ya viene incluido (sección 4.2); si encuentra el
    `docker-compose.override.yml` que generó una versión anterior del
    instalador, ofrece retirarlo (lo conserva como
    `docker-compose.override.yml.mailway-retirado`) y recrear Traefik. Con
    Skyway anterior a 0.34, si su Traefik no consulta todavía ningún
    proveedor HTTP, ofrece crear ese fichero en la carpeta de Skyway
    (sección 4.3).
13. **Resumen**: dirección de la puesta en marcha con su token (el único
    secreto que se muestra en pantalla), estado del DNS, del PTR, del puerto
    25 y del certificado, y el comando de copia de seguridad del correo.

### 2.4 Opciones

| Opción | Efecto |
|---|---|
| `--sin-skyway` | Instalación autónoma con `docker-compose.standalone.yml`: panel, motor y webmail, y un Traefik propio en 80/443 si esos puertos están libres (sección 7). |
| `--sin-cloudflare` | No usa la API de Cloudflare: los registros DNS se crean a mano. |
| `--actualizar` | Reaplica la configuración de `deploy/.env` sin preguntas: descarga imágenes, recrea contenedores, reaplica los ajustes del motor y, con Skyway, actualiza las variables y vuelve a desplegar el panel. Mantiene el modo de la instalación (junto a Skyway o autónoma). Ejecute antes `git pull`. |
| `--ayuda` | Muestra la ayuda con todas las variables. |

### 2.5 Ejecución desatendida

Sin terminal interactiva (por ejemplo, desde un script de aprovisionamiento)
el instalador no pregunta: usa estas variables o los valores por defecto.

| Variable | Uso |
|---|---|
| `MAILWAY_DOMINIO` | Dominio base (`mail.`, `webmail.` y `panel.` cuelgan de él). **Obligatoria** en la primera ejecución. |
| `MAILWAY_MAIL_HOST`, `MAILWAY_WEBMAIL_HOST`, `MAILWAY_PANEL_HOST` | Nombres concretos (por defecto `mail.`, `webmail.` y `panel.` del dominio). |
| `MAILWAY_IP` | IPv4 pública (se detecta si falta). |
| `MAILWAY_MARCA` | Nombre del servicio en el webmail (por defecto `Webmail`). |
| `LETSENCRYPT_EMAIL` | Correo de contacto para Let's Encrypt. |
| `CLOUDFLARE_API_TOKEN` | Token de Cloudflare. Vacío = sin Cloudflare. |
| `SKYWAY_TOKEN` | Token de API de Skyway (`sky_…`). Vacío = no desplegar el panel. |
| `SKYWAY_URL` | API de Skyway (por defecto `http://127.0.0.1:4000`). |
| `SKYWAY_DIR` | Carpeta de Skyway (se detecta a partir de su Traefik). |
| `MAILWAY_PROYECTO` | Proyecto de Skyway para el panel (por defecto `mailway`). |
| `MAILWAY_REPO`, `MAILWAY_RAMA` | Repositorio y rama del panel (por defecto `https://github.com/NkrowOne/Mailway`, `main`). |
| `MAILWAY_TRAEFIK_PROVEEDOR` | `1` ajusta el Traefik de Skyway sin preguntar (paso 12); `0` no lo toca. |
| `STALWART_ADMIN_PASSWORD` | Contraseña del motor existente, si `deploy/.env` se perdió. |
| `MAILWAY_INTERNAL_SUBNET`, `MAILWAY_MAIL_INTERNAL_IP` | Red interna (por defecto `10.203.53.0/24` y `10.203.53.10`). |
| `MAILWAY_ESPERA_DNS` | Segundos máximos de espera a la propagación del DNS (por defecto 300). |
| `MAILWAY_ENV_FILE` | Ruta alternativa del fichero de configuración (por defecto `deploy/.env`). |

Ejemplo:

```bash
sudo MAILWAY_DOMINIO=miempresa.com LETSENCRYPT_EMAIL=sistemas@miempresa.com \
     CLOUDFLARE_API_TOKEN=... SKYWAY_TOKEN=sky_... MAILWAY_TRAEFIK_PROVEEDOR=1 \
     bash deploy/instalar.sh < /dev/null
```

> Los tokens pasados como variables quedan en el historial de la terminal.
> Bórrelo después (`history -c`) o expórtelos desde un fichero protegido.

---

## 3. Puesta en marcha del panel

Abra la dirección que muestra el instalador:
`https://panel.miempresa.com/setup?token=<MAILWAY_SETUP_TOKEN>`. El token de
puesta en marcha evita que el primer visitante de un panel recién publicado
se quede con la instancia; también está en `deploy/.env`. Sin él, el paso 1
responde `403 setup_token_invalid`.

El asistente tiene cuatro pasos:

1. **Administrador**: su cuenta del panel (no es la del motor).
2. **Motor de correo**: con las variables del instalador, «Usar el motor
   configurado en el servidor» lo conecta sin que su contraseña pase por el
   navegador. Al conectar, el panel aplica en el motor los ajustes
   recomendados.
3. **Servidor**: marca, nombre del servidor de correo, IP pública (botón
   «Detectar»), URL del webmail y URL del panel.
4. **Comprobación**: DNS de la plataforma, PTR, certificado del motor y los
   siguientes pasos.

Después, en el panel:

- **Conexiones → Cloudflare**: conecte una cuenta con el ámbito «Toda la
  instancia» si va a usar Cloudflare para el certificado o para los dominios
  de sus clientes. **DNS de la plataforma** crea los registros del propio
  servidor si aún faltan.
- **Ajustes → Servidor de correo**: compruebe el nombre del servidor, los
  ajustes recomendados y el certificado (sección 5).
- **Avisos → Canales de aviso**: configure al menos un canal (sección 10).

---

## 4. Conectar Skyway

### 4.1 Skyway 0.34 o posterior

Skyway gestiona el correo de cada proyecto a través de la API de Mailway.

1. En Mailway, con la cuenta de administración: **Conexiones → Tokens de
   gestión → Crear token** (p. ej. «Skyway», sin caducidad). Copie el token
   `mwt_…`: solo se muestra una vez.
2. En Skyway: **Ajustes → Correo (Mailway)**. Seleccione el servicio de Skyway
   que ejecuta el panel de Mailway (Skyway le hablará por la red interna) o
   escriba su URL pública, pegue el token y pulse **Probar conexión**. Skyway
   avisa si el token no es de administrador. Guarde.
3. El botón **Correo** aparece en la cabecera de cada proyecto. Para los
   usuarios de Skyway que no son administradores, el plan de su cuenta debe
   incluir el módulo **Correo** (`mail`): los planes creados antes de la 0.34
   no lo incluyen y hay que activarlo en Skyway.

El uso del botón «Correo» (activar, dominios, buzones, conectar un servicio)
se describe en [INTEGRACIONES.md](INTEGRACIONES.md#3-skyway).

### 4.2 Rutas de Traefik: el puente de Skyway

Mailway necesita que Traefik sirva, además del panel y el webmail, los nombres
de autoconfiguración (`autoconfig.`, `autodiscover.`, `mta-sts.` de cada
dominio) y los webmails de marca blanca de los clientes. Mailway publica esas
rutas en `GET /api/traefik/config`.

Con **Skyway 0.34 o posterior no hay que instalar nada**: el Traefik de Skyway
arranca con `--providers.http.endpoint=http://skyway:4000/api/traefik/mailway`,
y Skyway obtiene las rutas de Mailway con el token de gestión, las **filtra**
(solo reglas `Host()` hacia contenedores de Mailway, nunca un dominio que ya
sirve Skyway) y, si Mailway no responde, conserva la última configuración
válida. Basta con haber conectado Mailway (sección 4.1).

Para comprobarlo:

```bash
docker inspect -f '{{json .Config.Cmd}}' skyway-traefik | grep -o 'providers.http.endpoint=[^"]*'
curl -s http://127.0.0.1:4000/api/traefik/mailway | head -c 400; echo
```

El estado de la sincronización (rutas publicadas y descartadas) aparece en
Skyway → Ajustes → Correo (Mailway); en Mailway, en **Ajustes → Rutas de
Traefik** y **Ajustes → Autoconfiguración de dispositivos**.

> Si actualiza Skyway desde una versión anterior y tenía un
> `docker-compose.override.yml` para Mailway en la carpeta de Skyway,
> **elimínelo** y ejecute `docker compose up -d traefik` en esa carpeta: el
> fichero sustituye los parámetros de Traefik de la 0.34 (Traefik solo admite
> un proveedor HTTP) y dejaría sin efecto el puente. Si lo generó el
> instalador, `deploy/instalar.sh --actualizar` lo retira por usted.

### 4.3 Skyway anterior a 0.34 o Traefik propio

Traefik debe consultar el panel directamente. El instalador lo configura solo
(paso 12 de la sección 2.3). A mano:

1. En Mailway, **Ajustes → Rutas de Traefik** muestra el bloque exacto
   (`docker-compose.override.yml`) con su token y el destino del panel. Hay
   una plantilla comentada en `deploy/skyway-traefik-override.yml`.
2. Cópielo a la carpeta de Skyway como `docker-compose.override.yml` y
   aplíquelo: `cd /ruta/a/Skyway && docker compose up -d traefik`.

Compose **reemplaza** `command` entero, no lo fusiona: el bloque repite los
parámetros que ya traía Traefik. Si actualiza Skyway y cambian, compárelos
con `docker inspect -f '{{json .Config.Cmd}}' skyway-traefik`.

---

## 5. Certificado TLS de IMAP y SMTP

Los programas de correo exigen un certificado válido en los puertos 993, 465 y
587. Hay dos vías; elija una.

### 5.1 ACME del propio motor con Cloudflare (preferida)

El motor pide y renueva su certificado a Let's Encrypt con el reto DNS-01 en
Cloudflare. No depende de Traefik ni del puerto 80, renueva 30 días antes de
caducar y sirve para IMAP y SMTP.

- **Con el instalador**: si indicó un token de Cloudflare, ya está hecho.
- **Desde el panel**: conecte en **Conexiones → Cloudflare** una cuenta con el
  ámbito «Toda la instancia» cuyo token vea la zona de `mail.<dominio>`. En
  **Ajustes → Servidor de correo**, elija esa cuenta, indique el correo de
  contacto y emita el certificado. Solo se admiten cuentas de la instancia
  (`400 cloudflare_account_not_instance` con la de un cliente).
- **Por API**: `POST /api/engine/acme` con
  `{"cloudflareAccountId":"cf_…","email":"sistemas@miempresa.com"}` y un token
  de administrador.

La emisión tarda unos minutos. **Ajustes → Servidor de correo** muestra el
emisor y los días de validez; el botón de recarga (`POST
/api/engine/reload-certificate`) hace que el motor use el certificado nuevo.

### 5.2 Alternativa: volcar el certificado de Traefik

Traefik ya obtiene un certificado para `mail.<dominio>` (la web del motor va
por Traefik). El servicio `certs-dumper` (perfil `tls`) lo vuelca a ficheros
PEM que lee el motor. El instalador lo usa cuando no hay token de Cloudflare.
A mano:

```bash
cd /ruta/a/Mailway
# 1) Nombre real del volumen de certificados de Skyway (<carpeta>_traefik-letsencrypt):
docker volume ls | grep letsencrypt
#    Si no es skyway_traefik-letsencrypt, ajuste TRAEFIK_ACME_VOLUME en deploy/.env.

# 2) Arrancar el volcado:
docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml --profile tls up -d certs-dumper
docker exec mailway-mail ls /opt/stalwart/certs/     # debe listar mail.miempresa.com/

# 3) Indicar al motor que use esos ficheros y recargar los certificados.
#    El puerto 8080 del motor no está publicado: se usa un contenedor efímero
#    en la red interna. Sustituya mail.miempresa.com por su nombre.
read -rsp 'Contraseña del motor (STALWART_ADMIN_PASSWORD): ' PASS; echo
docker run --rm --network mailway-internal curlimages/curl:8.11.1 -sS -u "admin:$PASS" \
  -X POST http://mailway-mail:8080/api/settings -H 'Content-Type: application/json' \
  -d '[{"type":"insert","prefix":null,"assert_empty":false,"values":[
        ["certificate.mailway.cert","%{file:/opt/stalwart/certs/mail.miempresa.com/cert.pem}%"],
        ["certificate.mailway.private-key","%{file:/opt/stalwart/certs/mail.miempresa.com/key.pem}%"],
        ["certificate.mailway.default","true"]]}]'
docker run --rm --network mailway-internal curlimages/curl:8.11.1 -sS -u "admin:$PASS" \
  http://mailway-mail:8080/api/reload/certificate
unset PASS
```

El campo `assert_empty` es obligatorio en la API de ajustes de Stalwart 0.15:
sin él, la petición falla. Stalwart no relee el fichero por sí solo tras una
renovación; el vigilante del panel recarga los certificados a diario.

### 5.3 Comprobar

```bash
openssl s_client -connect mail.miempresa.com:993 -servername mail.miempresa.com </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -enddate
```

Debe indicar Let's Encrypt. El vigilante comprueba el certificado a diario y
abre un aviso (`engine_tls`) si quedan menos de 20 días, si quedan menos de 7
(crítico), si ha caducado, si es autofirmado, si no corresponde al nombre del
servidor o si la cadena no es de confianza.

### 5.4 El SMTP interno de la API de envío

La API de envío entrega al motor por la red interna (`mailway-mail:587`). El
panel verifica su certificado contra el nombre público del servidor
(`mail.<dominio>`), así que funciona en cuanto el certificado es válido. El
instalador no desactiva esa verificación. Solo mientras el motor no tenga un
certificado válido (por ejemplo, sin Cloudflare y con el certificado de
Traefik aún pendiente), `MAILWAY_SMTP_ALLOW_SELF_SIGNED=1` acepta el
autofirmado: en las variables del panel (en Skyway, pestaña Variables) o, en
la instalación autónoma, en `deploy/.env`. Una vez emitido el certificado,
**elimínela** y vuelva a desplegar; `deploy/instalar.sh --actualizar` la
retira de las variables del panel en Skyway si el certificado ya está
configurado.

---

## 6. Instalación manual (sin instalador)

Mismo resultado que la sección 2, paso a paso.

### 6.1 DNS de la plataforma

| Tipo | Nombre | Valor |
|---|---|---|
| A | `mail.miempresa.com` | IP del servidor |
| A | `panel.miempresa.com` | IP del servidor |
| A | `webmail.miempresa.com` | IP del servidor |
| CNAME | `autoconfig.miempresa.com` | `mail.miempresa.com` |
| CNAME | `autodiscover.miempresa.com` | `mail.miempresa.com` |

Sin proxy de Cloudflare (nube gris). Espere a que propaguen:
`dig +short mail.miempresa.com` debe devolver la IP.

### 6.2 Configuración (`deploy/.env`)

```bash
git clone https://github.com/NkrowOne/Mailway.git
cd Mailway
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
nano deploy/.env
```

Rellene al menos: `MAIL_HOSTNAME`, `WEBMAIL_HOSTNAME`, `PANEL_HOSTNAME`,
`MAILWAY_PUBLIC_IP`, `LETSENCRYPT_EMAIL`, `STALWART_ADMIN_PASSWORD`
(`openssl rand -hex 24`), `ROUNDCUBE_DES_KEY` (`openssl rand -hex 12`: 24
caracteres), `MAILWAY_PANEL_URL`, `MAILWAY_WEBMAIL_URL` y los secretos
compartidos con el panel `MAILWAY_SECRET`, `MAILWAY_SETUP_TOKEN`,
`MAILWAY_TRAEFIK_TOKEN` y `MAILWAY_WEBMAIL_TOKEN` (`openssl rand -hex 24`).
El fichero explica cada variable.

### 6.3 Motor y webmail

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml up -d
docker ps --format '{{.Names}}\t{{.Status}}' | grep mailway   # mailway-mail (healthy) y mailway-webmail
```

El proyecto de Compose se llama siempre `mailway`, con independencia de la
carpeta: contenedores `mailway-mail` y `mailway-webmail`, volúmenes
`mailway-mail-data` y `mailway-webmail-db`, red `mailway-internal`.

> La imagen de Stalwart está **fijada a v0.15.5**: la v0.16 eliminó la API
> REST que usa Mailway. No la actualice sin leer [PLAN.md](PLAN.md).

### 6.4 Panel en Skyway

En Skyway:

1. **Nuevo proyecto** `mailway`.
2. **Nuevo servicio → Repositorio de GitHub** `NkrowOne/Mailway`, rama
   `main`, puerto interno `4100`, nombre `panel`. Skyway construye con el
   `Dockerfile` del repositorio y, con el despliegue automático activado,
   vuelve a desplegar cuando cambia la rama.
3. **Dominio**: `panel.miempresa.com` (así, además, el contenedor queda en la
   red `skyway-edge`, por la que llega al motor).
4. **Volumen** en `/data` (base de datos y clave del panel) y comprobación de
   salud `/api/health`.
5. **Variables** (las mismas que genera el instalador; los secretos, iguales
   que en `deploy/.env`):
   ```
   STALWART_URL=http://mailway-mail:8080
   STALWART_ADMIN_USER=admin
   STALWART_ADMIN_PASSWORD=<la de deploy/.env>
   STALWART_SMTP_HOST=mailway-mail
   STALWART_SMTP_PORT=587
   MAILWAY_SECRET=<el de deploy/.env>
   MAILWAY_SETUP_TOKEN=<el de deploy/.env>
   MAILWAY_TRAEFIK_TOKEN=<el de deploy/.env>
   MAILWAY_WEBMAIL_TOKEN=<el de deploy/.env>
   MAILWAY_MAIL_HOSTNAME=mail.miempresa.com
   MAILWAY_PUBLIC_IP=<IP del servidor>
   MAILWAY_WEBMAIL_URL=https://webmail.miempresa.com
   MAILWAY_PANEL_URL=https://panel.miempresa.com
   MAILWAY_ENGINE_TRUSTED_NETWORK=10.203.53.0/24
   ```
6. Despliegue. El contenedor se llamará `skyway-<proyecto>-<servicio>`
   (`skyway-mailway-panel` con los nombres de arriba). Mailway lo deduce solo
   de las variables `SKYWAY_PROJECT` y `SKYWAY_SERVICE` que inyecta Skyway, y
   su URL pública de `PUBLIC_URL` si no se define `MAILWAY_PANEL_URL`.

### 6.5 Enlazar el webmail con el panel

La pestaña **Ajustes → Contraseña** del webmail cambia la contraseña a través
del panel, por la red interna. Indique el contenedor real del panel en
`deploy/.env` y recree el webmail:

```bash
docker ps --format '{{.Names}}' | grep '^skyway-.*panel'      # p. ej. skyway-mailway-panel
# En deploy/.env: MAILWAY_PANEL_INTERNAL_URL=http://skyway-mailway-panel:4100
docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml up -d mailway-webmail
```

### 6.6 Puesta en marcha, rutas y certificado

1. Abra `https://panel.miempresa.com/setup?token=<MAILWAY_SETUP_TOKEN>` y
   complete el asistente (sección 3). Al conectar el motor se aplican los
   ajustes recomendados; si fallan, repítalos en **Ajustes → Servidor de
   correo**.
2. Conecte Skyway (sección 4).
3. Configure el certificado (sección 5).

---

## 7. Sin Skyway (instalación autónoma)

`deploy/docker-compose.standalone.yml` levanta panel, motor y webmail en un
solo proyecto de Compose. Con el perfil `proxy` añade un Traefik propio
(`mailway-proxy`) en 80/443 con Let's Encrypt, que consulta las rutas del
panel directamente.

```bash
sudo bash deploy/instalar.sh --sin-skyway
# o a mano, con deploy/.env relleno (incluido LETSENCRYPT_EMAIL):
docker compose --env-file deploy/.env -f deploy/docker-compose.standalone.yml --profile proxy up -d --build
```

Sin el perfil `proxy` (por ejemplo, si 80/443 ya los usa otro servidor web),
el panel (`127.0.0.1:4100`), el webmail (`127.0.0.1:8000`) y la web del motor
(`127.0.0.1:8080`) escuchan **solo en local**: póngales delante un proxy con
TLS (Caddy, Nginx…). Nunca los publique en HTTP hacia Internet: por ellos
viajan contraseñas.

El certificado de IMAP/SMTP se obtiene igual que en la sección 5: ACME del
motor con Cloudflare desde **Ajustes → Servidor de correo**, o el volcado del
certificado de `mailway-proxy` con `--profile tls`.

---

## 8. Actualizar y migrar

### 8.1 Actualizar

- **Panel con Skyway**: se actualiza solo al cambiar la rama desplegada.
- **Motor, webmail y configuración**:
  ```bash
  cd /ruta/a/Mailway
  git pull
  sudo bash deploy/instalar.sh --actualizar
  ```
  O a mano: `docker compose --env-file deploy/.env -f
  deploy/docker-compose.mail.yml pull && docker compose --env-file deploy/.env
  -f deploy/docker-compose.mail.yml up -d`. Los volúmenes no se tocan.
  Stalwart está fijado a `v0.15.5`, así que `pull` nunca salta a la v0.16.
- **Liberar espacio desde Skyway es seguro**: `docker image prune -f` y
  `docker builder prune -f` solo borran imágenes huérfanas y caché de
  compilación, nunca volúmenes ni imágenes en uso.

### 8.2 Migrar desde una versión 0.x

Hasta la 1.0, el proyecto de Compose tomaba el nombre de la carpeta (`deploy`)
y los volúmenes se llamaban `deploy_mailway-mail-data`,
`deploy_mailway-webmail-db` y `deploy_mailway-panel-data`. La 1.0 usa el
proyecto fijo `mailway` y una red interna con subred fija.

**Con el instalador** (recomendado): `git pull` y `sudo bash
deploy/instalar.sh`. Detecta la instalación anterior (también si sus
contenedores ya se borraron, por los volúmenes `deploy_*`), fija los volúmenes
antiguos en `deploy/.env`, retira los contenedores anteriores (conservando
los volúmenes) y recrea la red `mailway-internal` con su subred. No copia
datos: el correo sigue en el mismo volumen.

**A mano:**

```bash
docker volume ls | grep mailway                         # localice los volúmenes deploy_*
# En deploy/.env:
#   MAILWAY_MAIL_VOLUME=deploy_mailway-mail-data
#   MAILWAY_WEBMAIL_DB_VOLUME=deploy_mailway-webmail-db
#   MAILWAY_PANEL_VOLUME=deploy_mailway-panel-data      # solo en la instalación autónoma
#   ROUNDCUBE_DES_KEY, MAILWAY_WEBMAIL_TOKEN, MAILWAY_PANEL_INTERNAL_URL… (ver .env.example)
docker rm -f mailway-webmail mailway-certs-dumper mailway-mail   # los volúmenes se conservan
#   (en la instalación autónoma, retire también mailway-panel y use docker-compose.standalone.yml)
docker network rm mailway-internal                               # se recrea con la subred fija
docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml up -d
```

Después, en el panel, **Ajustes → Servidor de correo → Aplicar ajustes
recomendados** (nombre del servidor, proxy y exención de la red interna), y
añada al servicio del panel en Skyway las variables nuevas de la sección 6.4
(`MAILWAY_WEBMAIL_TOKEN`, `MAILWAY_ENGINE_TRUSTED_NETWORK`,
`MAILWAY_SETUP_TOKEN`…).

---

## 9. Primer cliente

En el panel (`https://panel.miempresa.com`):

1. **Clientes → Alta de cliente**: nombre y plan, y opcionalmente el usuario con
   el que el cliente entrará en su panel (la contraseña generada se muestra
   una sola vez). Los planes se editan en **Planes**.
2. El cliente (o usted) sigue la lista de puesta en marcha:
   - **Dominios → Añadir dominio**. Si una cuenta de Cloudflare conectada
     contiene la zona, la casilla «Configurar el DNS automáticamente en
     Cloudflare» lo deja listo en un paso. Si no, el asistente muestra los
     registros exactos (MX, SPF, DKIM, DMARC, verificación y recomendados)
     con botón de copiar, un fichero de zona para importar y **Medir el DNS ahora**.
   - **Propiedad del dominio**: hasta comprobarla no se pueden crear buzones
     ni alias. Se comprueba sola cuando el MX apunta a este servidor o cuando
     existe el TXT `_mailway.<dominio>` que indica la ficha del dominio (útil
     para preparar los buzones antes de mover el correo desde otro proveedor).
   - **Buzones → Crear buzón** (o **Alta masiva** para una lista). La
     contraseña se muestra una vez; **Conectar dispositivos** genera el enlace
     de configuración para el titular.
   - **API de envío**: claves para envíos automatizados ([API.md](API.md)).
3. Envíe a los titulares la [guía para titulares](GUIA-TITULARES.md) junto con
   su enlace de configuración.

---

## 10. Avisos

El vigilante del panel comprueba cada minuto el motor, el webmail y la cola de
salida; el DNS de los dominios cada 10 minutos mientras se espera un cambio
(48 horas tras aplicar el DNS o 7 días tras el alta) y cada hora después; la
marca blanca cada 10 minutos; la autoconfiguración cada hora; las listas
negras y el certificado del motor una vez al día. Cuando algo falla abre una
incidencia en **Avisos** y la envía por los canales configurados, sin repetir
el mismo aviso y con mensaje de recuperación.

En **Avisos → Canales de aviso** configure al menos uno:

- **Discord**: Ajustes del canal → Integraciones → Webhooks → Copiar URL.
- **Telegram**: cree un bot con [@BotFather](https://t.me/BotFather) e indique
  su token y el ID del chat.
- **Webhook genérico**: recibe un JSON (útil para n8n o un sistema propio).

Pulse **Enviar aviso de prueba**. Skyway no vigila estos contenedores: el
vigilante de Mailway es lo que cubre el correo.

---

## 11. Marca blanca y autoconfiguración

- **Autoconfiguración**: con el DNS de la plataforma de la sección 6.1,
  Thunderbird configura cualquier dominio cuyo MX sea este servidor sin
  registros adicionales. Los nombres `autoconfig.`, `autodiscover.` y
  `mta-sts.` de cada dominio se publican en Traefik solo cuando su DNS ya
  apunta aquí. Estado en **Ajustes → Autoconfiguración de dispositivos**.
- **Marca blanca**: en **Marca blanca**, el cliente añade
  `webmail.sucliente.com` (debe ser un subdominio de uno de sus dominios de
  correo ya verificados), crea el CNAME que se le indica (o pulsa «Configurar
  en Cloudflare») y pulsa **Comprobar**. El dominio pasa por *Esperando DNS →
  Emitiendo certificado → En servicio*. Mailway solo publica los dominios cuyo
  DNS ya apunta aquí: publicar uno que no resuelve haría fallar la validación
  de Let's Encrypt y acabaría en un bloqueo temporal por reintentos.

Detalle y reglas en [INTEGRACIONES.md](INTEGRACIONES.md).

---

## 12. Entregabilidad

En **Entregabilidad** el panel comprueba PTR, registro A y listas negras
(Spamhaus, SpamCop, Barracuda) y ordena las tareas pendientes. Antes de enviar
en volumen:

- **Caliente la IP**: si es nueva, empiece con decenas de envíos al día y
  aumente de forma gradual durante 2–4 semanas.
- **DMARC en `p=quarantine` o `p=reject`** cuando SPF y DKIM lleven unos días
  correctos.
- Pruebe con [mail-tester.com](https://www.mail-tester.com) desde un buzón y
  desde la API; el objetivo es 10/10.
- Si Spamhaus aparece como «no concluyente», consulte manualmente en
  [check.spamhaus.org](https://check.spamhaus.org): rechaza las consultas
  hechas a través de resolutores públicos.

---

## 13. Operación y copias de seguridad

- **Datos que respaldar**:
  - volumen `/data` del panel (SQLite y clave maestra; en Skyway, el volumen
    del servicio, que se puede programar desde Skyway);
  - volumen `mailway-mail-data` (todo el correo y la configuración del motor);
  - volumen `mailway-webmail-db` (ajustes de los usuarios del webmail);
  - `deploy/.env` (secretos; guárdelo cifrado).
  ```bash
  # Se detiene el motor unos segundos: copiar su base de datos en marcha
  # puede dejarla incoherente.
  docker stop mailway-mail
  docker run --rm -v mailway-mail-data:/origen:ro -v /root/copias:/destino alpine \
    tar czf /destino/mailway-correo-$(date +%F).tar.gz -C /origen .
  docker start mailway-mail
  ```
  Con una instalación migrada desde 0.x, sustituya `mailway-mail-data` por el
  valor de `MAILWAY_MAIL_VOLUME`.
- **Registros del motor**: `docker logs -f mailway-mail` y
  `docker exec mailway-mail ls /opt/stalwart/logs`.
- **Cola de salida**: visible en **Constantes** (panel de administración).
- **Contraseña de administración del panel olvidada**: en el contenedor del
  panel (con Skyway, `skyway-<proyecto>-<servicio>`; en la instalación
  autónoma, `mailway-panel`):
  ```bash
  docker exec -u node skyway-mailway-panel \
    node server/dist/tools/reset-password.js correo@ejemplo.com 'NuevaContraseña'
  ```
  La contraseña debe tener al menos 10 caracteres; se cierran las sesiones de
  ese usuario.

---

## 14. Variables de entorno del panel

Los valores de motor e identidad son **iniciales**: tras la puesta en marcha
se guardan en la base de datos y se cambian en **Ajustes**.

| Variable | Por defecto | Uso |
|---|---|---|
| `PORT`, `HOST` | `4100`, `0.0.0.0` | Dirección de escucha. |
| `MAILWAY_DATA_DIR` | `/data` en la imagen | Base de datos y clave maestra. |
| `MAILWAY_SECRET` | se genera en `/data/.secret` | Clave maestra: firma sesiones, cifra secretos y deriva los TXT de verificación de propiedad. Mínimo 16 caracteres. **No la cambie** en una instalación en uso ([SEGURIDAD.md](SEGURIDAD.md#6-secretos)). |
| `MAILWAY_SETUP_TOKEN` | — | Exige este token para crear el primer administrador. |
| `STALWART_URL`, `STALWART_ADMIN_USER`, `STALWART_ADMIN_PASSWORD` | —, `admin`, — | Motor que el asistente conecta con «Usar el motor configurado en el servidor», sin que la contraseña pase por el navegador. |
| `STALWART_SMTP_HOST`, `STALWART_SMTP_PORT` | host de `STALWART_URL`, `587` | SMTP interno de la API de envío. |
| `MAILWAY_SMTP_ALLOW_SELF_SIGNED` | — | `1` desactiva la verificación TLS del SMTP interno (solo hasta tener certificado). |
| `MAILWAY_MAIL_HOSTNAME`, `MAILWAY_PUBLIC_IP` | — | Nombre del servidor de correo e IP pública iniciales. |
| `MAILWAY_WEBMAIL_URL`, `MAILWAY_PANEL_URL` | —, `PUBLIC_URL` | URL públicas del webmail y del panel. |
| `MAILWAY_WEBMAIL_TOKEN` | — | Secreto compartido con el webmail para el cambio de contraseña. Sin él, `/api/webmail/password` no existe. |
| `MAILWAY_TRAEFIK_TOKEN` | se genera | Token de `/api/traefik/config` (cabecera `X-Mailway-Token`). |
| `MAILWAY_PANEL_BACKEND_URL` | `http://skyway-<SKYWAY_PROJECT>-<SKYWAY_SERVICE>:<PORT>` | Contenedor del panel para Traefik (autoconfiguración y dominios de tipo panel). |
| `MAILWAY_WEBMAIL_BACKEND_URL` | `http://mailway-webmail:80` | Contenedor del webmail para Traefik (marca blanca). |
| `MAILWAY_TRAEFIK_CERTRESOLVER` | `le` | Nombre del emisor de certificados de Traefik. |
| `MAILWAY_ENGINE_TRUSTED_NETWORK` | `10.203.53.0/24` | Rangos que el motor exime de su bloqueo automático (separados por comas; vacío lo desactiva). Debe coincidir con `MAILWAY_INTERNAL_SUBNET`. |
| `MAILWAY_TRUST_PROXY` | `1` | Proxies de confianza delante del panel: número de saltos, `true`/`false` o lista de IP/CIDR. |
| `MAILWAY_DNS_RESOLVERS` | `1.1.1.1,8.8.8.8` | Resolutores para verificar el DNS de los dominios. |
| `MAILWAY_SESSION_TTL_HOURS` | `168` | Duración de las sesiones del panel. |
| `MAILWAY_WATCHDOG_INTERVAL`, `MAILWAY_WATCHDOG_DISABLED` | `60`, — | Intervalo del vigilante en segundos (mínimo 30); `1` lo desactiva. |
| `MAILWAY_DEMO` | — | `1` activa el motor de demostración (sin servidor de correo real). |
| `LOG_LEVEL` | `info` | Nivel de registro. |
| `SKYWAY_PROJECT`, `SKYWAY_SERVICE`, `PUBLIC_URL` | los inyecta Skyway | Nombre del contenedor y URL pública del panel. |

---

## 15. Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| `engine_unreachable` al conectar el motor | El compose del correo no está en marcha, o el panel no está en la red `skyway-edge` | `docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml up -d`. En Skyway, el servicio del panel necesita un dominio para quedar conectado a `skyway-edge`. |
| El paso 1 del asistente responde «El token de puesta en marcha no es correcto» | Falta `?token=` o no coincide con `MAILWAY_SETUP_TOKEN` | Use la dirección que imprime el instalador o copie el valor de `deploy/.env`. |
| `mailway-mail` nunca llega a *healthy* | Núcleo sin IPv6, o puertos ocupados | Vuelva a ejecutar el instalador (cambia el motor a IPv4) y revise `docker exec mailway-mail ls /opt/stalwart/logs`. |
| Gmail rechaza con «PTR record» | DNS inverso sin configurar | Panel del proveedor del servidor → DNS inverso → `mail.<dominio>` (sección 1). |
| No llega correo de fuera | Puerto 25 de entrada cerrado o MX incorrecto | `dig MX su-dominio.com`; abra el 25 de entrada en el cortafuegos del proveedor. |
| No sale correo hacia Gmail u Outlook | Puerto 25 de salida bloqueado | Solicítelo al proveedor (sección 1). |
| Thunderbird o el iPhone avisan del certificado | Certificado de IMAP/SMTP sin configurar o autofirmado | Sección 5; estado en Ajustes → Servidor de correo. |
| Un envío por API devuelve `status: "failed"` con un error de certificado | El SMTP interno no puede verificar el certificado | Emita el certificado (sección 5) o, solo mientras tanto, `MAILWAY_SMTP_ALLOW_SELF_SIGNED=1` en las variables del panel. |
| El webmail no inicia sesión | El motor no está sano o la IP del webmail está bloqueada | `docker ps`; compruebe en Ajustes → Servidor de correo que la exención de la red interna está aplicada. |
| El webmail no muestra «Contraseña» o no la cambia | Falta `MAILWAY_WEBMAIL_TOKEN` (en `deploy/.env` y en el panel, con el mismo valor) o `MAILWAY_PANEL_INTERNAL_URL` no apunta al contenedor real del panel | Sección 6.5; recree `mailway-webmail`. |
| Una IP legítima no puede conectar al motor (bloqueo automático) | Stalwart bloquea de forma permanente una IP tras demasiados fallos de autenticación | Desbloquéela: `docker run --rm --network mailway-internal curlimages/curl:8.11.1 -sS -u "admin:$PASS" -X DELETE http://mailway-mail:8080/api/settings/server.blocked-ip.<IP>` y después `…/api/reload/server.blocked-ip`. |
| No se pueden crear buzones: `domain_ownership_pending` | La propiedad del dominio no está comprobada | Apunte el MX a este servidor o cree el TXT `_mailway.<dominio>` de la ficha del dominio y pulse «Medir el DNS ahora». |
| Los nombres `autoconfig.` o la marca blanca dan 404 de Traefik | El DNS aún no apunta aquí (Mailway no los publica), o Traefik no consulta las rutas de Mailway | Pulse «Comprobar» cuando el DNS esté listo. Con Skyway 0.34, compruebe que Mailway está conectado en Skyway (sección 4.2); en versiones anteriores, el override (sección 4.3). |
| Ajustes → Rutas de Traefik indica «Destino del panel: Sin detectar» | El panel no se desplegó con Skyway y no define `MAILWAY_PANEL_BACKEND_URL` | Defina `MAILWAY_PANEL_BACKEND_URL=http://<contenedor del panel>:4100`. Sin él no se publican los nombres de autoconfiguración ni los dominios de tipo panel. |
| Un dominio de marca blanca se queda en «Emitiendo certificado» | Traefik no consulta el panel, o el puerto 80 está cerrado | Revise la sección 4. Let's Encrypt valida por el puerto 80: debe estar abierto. |
| Tras actualizar Skyway a 0.34 las rutas de Mailway no se actualizan | Sigue el `docker-compose.override.yml` antiguo en la carpeta de Skyway | Elimínelo y ejecute `docker compose up -d traefik` en la carpeta de Skyway (sección 4.2). |
| El botón «Correo» no aparece en un proyecto de Skyway | Mailway no está conectado en Skyway, o el plan de la cuenta no incluye el módulo «Correo» | Sección 4.1. |
| No llegan los avisos | Ningún canal configurado, o token o URL incorrectos | Avisos → «Enviar aviso de prueba»; el panel indica qué canal falla. |
