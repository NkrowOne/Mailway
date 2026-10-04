# Desplegar Mailway en producción

Guía para dejar Mailway funcionando en un servidor propio, junto a Skyway
(recomendado) o de forma autónoma. Al terminar dispondrás de:

- el **panel de Mailway** en `https://panel.<tu dominio>`, desplegado desde
  GitHub por Skyway y con actualización automática;
- el **motor de correo** (Stalwart) y el **webmail** (Roundcube) en un
  docker-compose junto a Skyway, con certificado válido para IMAP y SMTP;
- la **conexión con Skyway** para gestionar el correo de cada proyecto desde
  su botón «Correo».

La forma recomendada es el instalador (`deploy/instalar.sh`, sección 2): junto
a Skyway lo deja todo emparejado, sin tokens que copiar ni asistentes que
completar (sección 2.6). La sección 6 describe el mismo proceso a mano.

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
2. **Un dominio para la plataforma** (p. ej. `miempresa.com`) cuyo DNS puedas
   editar. Se usan tres nombres:
   - `mail.miempresa.com`: nombre del servidor de correo;
   - `panel.miempresa.com`: panel de Mailway;
   - `webmail.miempresa.com`: webmail.
3. **Puerto 25 de salida abierto.** Muchos proveedores (Hetzner, OVH, AWS,
   DigitalOcean…) lo bloquean por defecto: solicita el desbloqueo indicando que
   vas a operar un servidor de correo. Sin él no se entrega correo a otros
   servidores. Compruébalo desde el servidor:
   ```bash
   timeout 5 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25' && echo ABIERTO || echo BLOQUEADO
   ```
4. **DNS inverso (PTR).** En el panel del proveedor del servidor (no en tu
   DNS), configura el registro inverso de la IP para que devuelva
   `mail.miempresa.com`. Gmail y Outlook rechazan servidores sin PTR coherente.
5. **Puertos de correo libres**: 25, 465, 587, 993 y 4190. Si el sistema trae
   Postfix o Exim, desactívalos.
6. **Opcional, pero recomendado:**
   - un **token de API de Cloudflare** si el DNS del dominio está en
     Cloudflare, con los permisos *Zona → Zona → Leer* y *Zona → DNS →
     Editar*. El instalador crea con él los registros de la plataforma y el
     motor obtiene su certificado por DNS;
   - solo si Skyway **no** corre en este mismo servidor: un **token de API de
     Skyway** de administrador (`sky_…`, en Skyway → Mi perfil → Tokens de
     API) para que el instalador despliegue el panel. Si Skyway corre aquí
     (contenedor `skyway`), el instalador crea uno temporal por sí mismo.

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
| Correo de la cuenta de administración del panel (junto a Skyway) | el de Let's Encrypt | `MAILWAY_ADMIN_EMAIL` |
| IPv4 pública del servidor | la de una ejecución anterior si coincide con la detectada, si sigue siendo de una interfaz del servidor (se conserva con un aviso) o si no se puede detectar ninguna; si no, con terminal se propone la detectada y sin terminal el instalador se detiene (sección 8.3) | `MAILWAY_IP` |
| Token de API de Cloudflare (Intro para omitir) | — | `CLOUDFLARE_API_TOKEN` |
| Token de API de Skyway (solo si Skyway no corre en este servidor; Intro para omitir) | — | `SKYWAY_TOKEN` |
| ¿Configurar el Traefik de Skyway para los dominios de los clientes? | sí | `MAILWAY_TRAEFIK_PROVEEDOR` |

Los nombres `mail.`, `webmail.` y `panel.` cuelgan del dominio base; se
pueden cambiar con `MAILWAY_MAIL_HOST`, `MAILWAY_WEBMAIL_HOST` y
`MAILWAY_PANEL_HOST` (deben seguir siendo subdominios del dominio base). Si
los nombres resultantes no son los de la ejecución anterior (otro dominio
base, por ejemplo), el instalador resume lo que supone y pide confirmación
antes de tocar nada; sin terminal hace falta `MAILWAY_CAMBIAR_NOMBRES=1`
(sección 8.3).

Si el motor ya tiene datos y `deploy/.env` no guarda su contraseña, el
instalador la pide (o la toma de `STALWART_ADMIN_PASSWORD`).

### 2.3 Qué hace, en orden

1. **Comprobaciones previas**: Docker y Compose v2, contenedor
   `skyway-traefik` y red `skyway-edge` (salvo con `--sin-skyway`), puertos de
   correo libres y puerto 25 de salida.
2. **Datos**: dominio, nombres, marca, correo de Let's Encrypt (rechaza los
   de `example.com`, que Let's Encrypt no admite) e IP. Si los nombres
   cambian respecto a la ejecución anterior, pide confirmación; si la IP
   guardada no es la de este servidor, la propone o se detiene (sección
   8.3). Comprueba que la
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
   `autodiscover.` del dominio base hacia `mail.`. Si un nombre ya existe
   con otro valor o con el proxy de Cloudflare, pregunta antes de cambiarlo.
   En `autoconfig.` y `autodiscover.`, que pueden estar sirviendo a otro
   proveedor (por ejemplo, Microsoft 365), la respuesta por defecto es no
   cambiarlos. Sin terminal (ejecución desatendida o `--actualizar`) no
   modifica ningún registro existente: lo informa como conflicto y sigue;
   con `MAILWAY_DNS_REEMPLAZAR=1` cambia los A de `mail.`, `webmail.` y
   `panel.`, nunca los CNAME de autoconfiguración. Un A que ya apunta a la
   IP con la que sale el servidor no se devuelve a otra sin preguntar (por
   defecto, no), ni siquiera con esa variable.
7. **Propagación**: espera (hasta `MAILWAY_ESPERA_DNS` segundos, 300 por
   defecto) a que los tres nombres resuelvan a la IP. Así Traefik no pide
   certificados que Let's Encrypt rechazaría.
8. **PTR**: comprueba el DNS inverso en dos resolutores (Cloudflare y
   Google) y lo incluye en el resumen; si ninguno responde, lo da por «sin
   comprobar», no por «sin configurar».
9. **Motor y webmail**: levanta `mailway-mail`, espera a que esté sano y
   después `mailway-webmail`. En núcleos sin IPv6, cambia el motor a IPv4.
   Con `--actualizar` descarga antes las imágenes; si no puede (límite de
   Docker Hub, sin conexión), avisa de que siguen las anteriores y lo deja en
   el resumen.
10. **Ajustes del motor**: fija `server.hostname`, `http.use-x-forwarded` y
    la exención de la red interna (los mismos ajustes que «Aplicar ajustes
    recomendados» del panel) y configura el certificado: con Cloudflare, ACME
    del propio motor por DNS-01 (sección 5.1); sin Cloudflare, el certificado
    de Traefik, que lleva al motor el extractor del perfil `tls` (sección
    5.2). Espera a que el extractor confirme el certificado servido en 993 y
    465. Si el nombre del servidor ha cambiado, lleva el certificado al nombre
    nuevo (sección 8.3). En la instalación autónoma, tras un cambio de
    nombres o de IP confirmado, el panel adopta los valores nuevos y, con un
    token de Cloudflare y el panel sano, se lo pasa como cuenta de la
    instancia (sección 2.7).
11. **Panel en Skyway**: sin `SKYWAY_TOKEN`, si Skyway corre en este
    servidor (contenedor `skyway`), crea un token de API temporal con la
    herramienta de terminal de Skyway (caduca en 60 minutos y se revoca al
    terminar, también si la instalación falla); si no, lo pide. Si la API de
    Skyway no responde en `http://127.0.0.1:4000` (un compose propio que no
    publica el puerto), prueba la IP del contenedor `skyway`; si tampoco
    responde y el token era el temporal, lo revoca, avisa y sigue sin
    desplegar el panel (con un `SKYWAY_TOKEN` indicado, se detiene). Con él crea
    (o reutiliza) el proyecto `mailway` y su servicio `panel` desde GitHub,
    con puerto 4100, dominio, volumen `/data`, comprobación `/api/health` y
    todas las variables, sin perder los volúmenes, dominios ni variables que
    se hayan añadido a mano; lanza el despliegue y espera a que termine. Después enlaza el webmail con
    el contenedor real del panel (`MAILWAY_PANEL_INTERNAL_URL`). Si el motor
    ya tiene certificado, retira `MAILWAY_SMTP_ALLOW_SELF_SIGNED` de las
    variables del panel (sección 5.4).
12. **Traefik**: con Skyway 0.34 o posterior no instala nada, porque el
    puente ya viene incluido (sección 4.2); si encuentra un
    `docker-compose.override.yml` de Mailway (el que generó una versión
    anterior del instalador o el copiado a mano de Ajustes → Marca blanca),
    ofrece retirarlo (lo conserva como
    `docker-compose.override.yml.mailway-retirado`) y recrear Traefik, y
    solo da el paso por bueno si Traefik corre después con el puente. Con
    Skyway anterior a 0.34, si su Traefik no consulta todavía ningún
    proveedor HTTP, ofrece crear ese fichero en la carpeta de Skyway
    (sección 4.3).
13. **Emparejado con Skyway** (sección 2.6): tras un cambio de nombres o de
    IP confirmado, el panel adopta antes los valores nuevos (sección 8.3); si
    no puede (el panel en marcha aún tiene los anteriores), no se empareja y
    el resumen dice que se repita `--actualizar`. Con el panel desplegado y
    sano,
    crea su cuenta de administración si aún no existe, completa su puesta en
    marcha y conecta Skyway con un token de gestión, sin pasos manuales. Se
    hace en cada ejecución, así que repetir el instalador completa lo que
    hubiera quedado pendiente (por ejemplo, el motor si no respondía); solo
    se salta si Skyway está conectado con **otro** panel de Mailway. Si algo
    falla, avisa y la instalación sigue: se repite con `--emparejar`. Con un
    token de Cloudflare (paso 6), después del emparejado, y aunque este no se
    haga o falle, se lo pasa al panel sano como cuenta de la instancia y, a
    continuación, a Skyway (sección 2.7).
14. **Resumen**: dirección del panel, estado del DNS, del PTR, del puerto 25,
    del certificado, de las imágenes (con `--actualizar`), de la identidad en
    el panel (tras un cambio), del emparejado y de las cuentas de Cloudflare que han
    quedado conectadas en el panel y en Skyway, el comando de copia de seguridad del
    correo y los de diagnóstico (sección 13.1). Con el emparejado hecho,
    muestra la cuenta de administración del panel y, si se acaba de crear, su
    contraseña: **una sola vez**, porque no se guarda en ningún sitio. Sin
    emparejado, muestra en su lugar la dirección de la puesta en marcha con
    su token. «Siguientes pasos» incluye pedir al proveedor el puerto 25 si
    está bloqueado y, tras cambiar el nombre del servidor, el MX de los
    dominios de los clientes y los programas de correo que hay que
    reconfigurar.

### 2.4 Opciones

| Opción | Efecto |
|---|---|
| `--sin-skyway` | Instalación autónoma con `docker-compose.standalone.yml`: panel, motor y webmail, y un Traefik propio en 80/443 si esos puertos están libres (sección 7). |
| `--sin-cloudflare` | No usa la API de Cloudflare: los registros DNS se crean a mano. |
| `--actualizar` | Reaplica la configuración de `deploy/.env` sin preguntas: descarga imágenes, recrea contenedores, reaplica los ajustes del motor y, con Skyway, actualiza las variables y vuelve a desplegar el panel. Mantiene el modo de la instalación (junto a Skyway o autónoma). Ejecuta antes `git pull`. |
| `--comprobar` | Diagnóstico de solo lectura: contenedores (también el del panel), ajustes y certificado del motor, certificado servido en 993 y 465, conexión IMAP y SMTP desde el webmail, enlace del webmail con el panel, estado del extractor, rutas de Traefik (junto a Skyway), DNS público de los tres nombres, PTR y puerto 25 de salida (sección 13.1). Termina con código 1 si algo falla. |
| `--probar-acceso` | Pide la dirección y la contraseña de un buzón, sin mostrarla ni guardarla, e inicia sesión desde el webmail con un único intento (sección 13.1). |
| `--emparejar` | Repite solo el emparejado con Skyway (sección 2.6) con la configuración de `deploy/.env`, sin preguntas. Renueva siempre el token de gestión «Skyway». Termina con código 1 si no se completa. |
| `--ayuda` | Muestra la ayuda con todas las variables. |

### 2.5 Ejecución desatendida

Sin terminal interactiva (por ejemplo, desde un script de aprovisionamiento)
el instalador no pregunta: usa estas variables o los valores por defecto.

| Variable | Uso |
|---|---|
| `MAILWAY_DOMINIO` | Dominio base (`mail.`, `webmail.` y `panel.` cuelgan de él). **Obligatoria** en la primera ejecución. |
| `MAILWAY_MAIL_HOST`, `MAILWAY_WEBMAIL_HOST`, `MAILWAY_PANEL_HOST` | Nombres concretos (por defecto `mail.`, `webmail.` y `panel.` del dominio). |
| `MAILWAY_IP` | IPv4 pública. Sin ella se detecta y se compara con la de `deploy/.env`: si no coinciden y la guardada no es de ninguna interfaz del servidor, una ejecución desatendida se detiene y dice qué valor indicar (sección 8.3). |
| `MAILWAY_CAMBIAR_NOMBRES` | `1` confirma, sin terminal, que cambian los nombres de la plataforma (otro `MAILWAY_DOMINIO` o `MAILWAY_*_HOST` distintos de los de `deploy/.env`). Sin ella, una ejecución desatendida que los cambiaría se detiene sin tocar nada (sección 8.3). |
| `MAILWAY_MARCA` | Nombre del servicio en el webmail (por defecto `Webmail`). |
| `LETSENCRYPT_EMAIL` | Correo de contacto para Let's Encrypt. |
| `CLOUDFLARE_API_TOKEN` | Token de Cloudflare. Vacío = sin Cloudflare. Se guarda también en el panel (cuenta de la instancia) y en Skyway (sección 2.7); nunca en `deploy/.env`. |
| `MAILWAY_ADMIN_EMAIL` | Correo de la cuenta de administración del panel que crea el emparejado (por defecto, el de Let's Encrypt). Se comprueba al principio con las mismas reglas que el panel (sin `%`, sin `..` ni un punto al principio o al final de la parte local). Se guarda en `deploy/.env`; la contraseña, no. |
| `SKYWAY_TOKEN` | Token de API de Skyway (`sky_…`). Sin él, si Skyway corre en este servidor, se crea uno temporal; si no, no se despliega el panel. |
| `SKYWAY_URL` | API de Skyway (por defecto `http://127.0.0.1:4000`; si ahí no responde, se prueba la IP del contenedor `skyway`). |
| `SKYWAY_DIR` | Carpeta de Skyway (se detecta a partir de su Traefik). |
| `MAILWAY_PROYECTO` | Proyecto de Skyway para el panel nuevo (por defecto `mailway`). Si Skyway ya despliega un panel, se actualiza ese (sección 8.2). |
| `MAILWAY_PANEL_SERVICIO` | Identificador del servicio de Skyway del panel existente: lo actualiza sin preguntar. `ninguno`: no adopta ningún panel. Hace falta sin terminal, o si Skyway despliega más de uno (sección 8.2). |
| `MAILWAY_REPO`, `MAILWAY_RAMA` | Repositorio y rama del panel (por defecto `https://github.com/NkrowOne/Mailway`, `main`). |
| `MAILWAY_TRAEFIK_PROVEEDOR` | `1` ajusta el Traefik de Skyway sin preguntar (paso 12); `0` no lo toca. |
| `STALWART_ADMIN_PASSWORD` | Contraseña del motor existente, si `deploy/.env` se perdió. |
| `MAILWAY_INTERNAL_SUBNET`, `MAILWAY_MAIL_INTERNAL_IP` | Red interna (por defecto `10.203.53.0/24` y `10.203.53.10`). |
| `MAILWAY_ESPERA_DNS` | Segundos máximos de espera a la propagación del DNS (por defecto 300). |
| `MAILWAY_DNS_REEMPLAZAR` | `1` permite cambiar, sin terminal, los registros A de `mail.`, `webmail.` y `panel.` que ya existan en Cloudflare con otra IP o con el proxy (paso 6). Sin ella, una ejecución desatendida no modifica ningún registro existente. |
| `MAILWAY_ENV_FILE` | Ruta alternativa del fichero de configuración (por defecto `deploy/.env`). |
| `MAILWAY_COMPOSE_EXTRA` | Fichero de Compose adicional que se aplica sobre el del instalador (ajustes locales; lo usa la prueba de la pila en la CI, sección 16). |
| `MAILWAY_COMPROBAR_SOLO_MOTOR` | `1` limita `--comprobar` al motor, el webmail y el extractor, sin el panel, Traefik ni las comprobaciones desde Internet (la usa la prueba de la pila en la CI, sección 16). |

Ejemplo, con el token leído sin mostrarlo y exportado (nunca escrito en la
orden):

```bash
cd /ruta/a/Mailway
read -rs -p 'Token de Cloudflare: ' CLOUDFLARE_API_TOKEN; echo
export CLOUDFLARE_API_TOKEN
sudo --preserve-env=CLOUDFLARE_API_TOKEN \
     MAILWAY_DOMINIO=miempresa.com LETSENCRYPT_EMAIL=sistemas@miempresa.com \
     MAILWAY_ADMIN_EMAIL=admin@miempresa.com MAILWAY_TRAEFIK_PROVEEDOR=1 \
     bash deploy/instalar.sh < /dev/null
unset CLOUDFLARE_API_TOKEN
```

En una sesión de root (`sudo -i`), la misma orden sin
`sudo --preserve-env=CLOUDFLARE_API_TOKEN`. Desde un script de
aprovisionamiento que ya corre como root, carga los secretos de un fichero
solo legible por root (`set -a; . /root/mailway.secretos; set +a`) en vez de
leerlos con `read`.

> **Los secretos (`CLOUDFLARE_API_TOKEN`, `SKYWAY_TOKEN`,
> `STALWART_ADMIN_PASSWORD`) nunca se escriben en la orden.** Escritos delante
> de `sudo` (`sudo CLOUDFLARE_API_TOKEN=… bash …`) son argumentos del proceso
> `sudo`, que sigue en marcha mientras dura la instalación: cualquier usuario
> del servidor los ve con `ps`, no solo en el historial de la terminal.
> Exportados y con `--preserve-env`, llegan al instalador por el entorno, que
> los demás usuarios del servidor no pueden leer. Sin `CLOUDFLARE_API_TOKEN`,
> el instalador interactivo pregunta el token sin mostrarlo. Si guardas la
> salida del instalador en un fichero, ten en cuenta que el resumen incluye la
> contraseña del administrador del panel cuando la crea.

### 2.6 Emparejado con Skyway

Al final de la instalación junto a Skyway, el panel y Skyway quedan
conectados sin copiar tokens ni completar el asistente. Lo hacen dos
herramientas de terminal, que solo puede usar quien ya es root en el
servidor; ninguna abre un puerto ni recibe nada por la red:

1. **En el panel** (`node server/dist/tools/emparejar.js --email <correo>`,
   dentro de su contenedor y como el usuario `node`):
   - si el panel no tiene cuenta de administración, la crea con el correo
     indicado (`MAILWAY_ADMIN_EMAIL`) y una contraseña aleatoria; si ya la
     tiene, usa la que tiene ese correo o, si no, la primera que se creó;
   - completa la puesta en marcha con las variables del panel, con los mismos
     pasos que el asistente: identidad del servidor (lo que falte y lo que el
     instalador haya cambiado desde la última vez; lo que se haya cambiado en
     el panel no se pisa y se avisa, sección 8.3), motor de correo (`STALWART_*`)
     si aún no hay ninguno conectado y ajustes recomendados del motor. Si el
     motor no responde, lo avisa: la puesta en marcha queda abierta y el
     asistente continúa en ese paso al entrar;
   - crea el token de gestión de administración «Skyway», sin caducidad, y
     revoca el que hubiera activo con ese nombre (de cualquier
     administrador; nunca el de un usuario de cliente).

   Imprime una línea JSON (`adminEmail`, `adminPassword` solo si acaba de
   crear la cuenta, y `token`). La cuenta y el token se crean juntos, en el
   último paso: si algo falla antes, no queda una cuenta cuya contraseña no
   se ha mostrado. Lo que no puede completar (un motor que no responde, una
   variable del entorno no válida, que se descarta sin repetir su valor) lo
   avisa sin fallar, y el instalador lo resume como «completada con avisos».
   La auditoría anota cada paso como «Sistema», sin ningún secreto.
2. **En Skyway** (`node server/dist/tools/mailway.js conectar`, en el
   contenedor `skyway`): recibe el token **por la entrada estándar** (nunca
   como argumento, que quedaría a la vista en la lista de procesos), lo
   prueba como «Probar conexión» y lo guarda como **Ajustes → Correo
   (Mailway)**, con el servicio del panel y su URL pública.

El instalador lo ejecuta en el paso 13 de la sección 2.3, en cada ejecución:
así, repetir la instalación (o `--actualizar`) completa lo que hubiera
quedado pendiente de la puesta en marcha, y el token «Skyway» se renueva y se
guarda en Skyway en el mismo paso. Si Skyway está conectado con **otro**
panel de Mailway, no lo toca: avisa y solo lo cambia `--emparejar`.

Para repetir solo el emparejado (por ejemplo, tras un aviso del instalador o
si se ha revocado el token «Skyway»):

```bash
sudo bash deploy/instalar.sh --emparejar
```

Toma de `deploy/.env` el correo de la cuenta de administración
(`MAILWAY_ADMIN_EMAIL`, o el de Let's Encrypt), la URL del panel y su
contenedor (`MAILWAY_PANEL_INTERNAL_URL`); el servicio y el proyecto de
Skyway salen de las etiquetas del contenedor. No necesita token de Skyway.

El emparejado no se hace mientras el panel no haya adoptado un cambio de
nombres o de IP confirmado (`MAILWAY_ADOPCION_PENDIENTE` en `deploy/.env`):
aplicaría en el motor los ajustes del panel, que aún tiene la identidad
anterior. Tanto la instalación como `--emparejar` intentan antes esa
adopción y solo emparejan si se completa (sección 8.3).

A mano, el mismo emparejado es (con `jq` instalado en el servidor):

```bash
# Contenedor del panel: skyway-<proyecto>-<servicio> (p. ej. skyway-mailway-panel).
# La salida (el token y, si se acaba de crear la cuenta, su contraseña) se
# queda en una variable: nunca se escribe en la orden, así que no acaba en el
# historial del shell ni a la vista en «ps».
salida=$(docker exec -i -u node skyway-mailway-panel node server/dist/tools/emparejar.js \
  --email admin@miempresa.com </dev/null)
# Contraseña de la cuenta de administración (solo si se acaba de crear):
printf '%s' "$salida" | jq -r '.adminPassword // "La cuenta ya existía: usa su contraseña."'
# El token mwt_…, por la entrada estándar de la herramienta de Skyway:
printf '%s' "$salida" | jq -r .token | docker exec -i skyway node server/dist/tools/mailway.js conectar \
  --servicio panel --proyecto mailway --url https://panel.miempresa.com
unset salida
```

`printf` es una orden interna de bash: el token no aparece como argumento de
ningún proceso. Nunca pegues el token ni la contraseña dentro de la orden
(`printf '%s' 'mwt_…'`): quedarían en `~/.bash_history`.

Requiere un panel y un Skyway con estas herramientas; con versiones
anteriores, el instalador lo avisa y la conexión se hace a mano (sección 4.1).

### 2.7 El token de Cloudflare en el panel y en Skyway

El token de Cloudflare que das al instalador (`CLOUDFLARE_API_TOKEN` o la
pregunta del paso 6) sirve también para que, desde entonces, los dominios que
**tú, como administrador**, das de alta configuren su DNS en Cloudflare solos:
los de correo en el panel (también el primer dominio del alta de un cliente)
o desde Skyway, y los de los servicios en Skyway, también en proyectos de tus
clientes. Se crea lo que falta sin modificar los registros existentes (ni
siquiera para completar un SPF o quitar un proxy: eso se revisa y se aplica
desde la ficha del dominio); un registro que choca se informa y no se toca.
Para ello el instalador guarda el token:

1. **En el panel**, como cuenta de Cloudflare **de la instancia**
   («Instalador de Mailway» en Conexiones → Cloudflare), con su herramienta de
   terminal y el panel ya sano: junto a Skyway, al final de la instalación,
   después del emparejado y aunque este no se haga (Skyway conectado con otro
   panel, sin su herramienta o con un fallo); en la instalación autónoma, en
   cuanto `mailway-panel` está sano.

   ```bash
   printf '%s' "$CF_TOKEN" | docker exec -i -u node <contenedor del panel> \
     node server/dist/tools/cloudflare.js conectar --nombre "Instalador de Mailway"
   ```

2. **En Skyway**, con su herramienta equivalente, si la versión de Skyway la
   incluye (si no, lo avisa y sigue):

   ```bash
   printf '%s' "$CF_TOKEN" | docker exec -i skyway node server/dist/tools/cloudflare.js conectar
   ```

Reglas:

- El token va siempre por la **entrada estándar** (`printf` es una orden
  interna de bash): nunca como argumento, que quedaría a la vista en `ps`, ni
  en `deploy/.env`, ni en los registros. Las herramientas rechazan un token en
  sus argumentos y no lo repiten en sus mensajes; en el panel queda cifrado.
  Al instalador le llega igual: por su pregunta, que no lo muestra, o
  exportado en el entorno (sección 2.5), nunca escrito delante de `sudo`.
- Es **solo para el administrador**: las acciones de un cliente (un usuario de
  un cliente en el panel, o un propietario o miembro de un espacio de trabajo
  en Skyway, que llega al panel con `?soloCliente=1`) nunca usan esa cuenta,
  ni siquiera en un dominio cuyo DNS aplicó antes el administrador. Un cliente
  que quiera el DNS automático conecta su propia cuenta (docs/INTEGRACIONES.md,
  sección 4.3).
- **Nada de esto interrumpe la instalación**: un panel o un Skyway sin la
  herramienta, o un fallo de Cloudflare, quedan como aviso y en el resumen,
  que en ese caso indica que la conectes a mano en **Conexiones → Cloudflare**
  con el ámbito «Toda la instancia».
- Es **idempotente**: repetir la instalación con el mismo token no duplica la
  cuenta.
- **Para cambiar el token**, ejecuta `--actualizar` con el nuevo en
  `CLOUDFLARE_API_TOKEN`, exportado y con `sudo --preserve-env` como en el
  ejemplo de la sección 2.5 (nunca `sudo CLOUDFLARE_API_TOKEN=…`, que lo deja
  a la vista en `ps`): la herramienta del panel lo verifica y lo
  **sustituye** en la cuenta «Instalador de Mailway» (no añade otra, y los
  dominios asociados a ella lo siguen estando); Skyway también sustituye el
  suyo. Si conectas el nuevo a mano en Conexiones → Cloudflare, se añade como
  otra cuenta: elimina después la antigua.
- `--actualizar` sin `CLOUDFLARE_API_TOKEN` y `--emparejar` (que nunca lo
  usa, aunque exista esa variable: no pasa por el paso 6) **no tienen el
  token** (no se guarda en `deploy/.env`) y no lo piden: no tocan la cuenta
  que hubiera conectada, y como no saben si la hay, el resumen pide
  comprobarlo en Conexiones → Cloudflare. Para conectarlo o cambiarlo sin
  reinstalar, usa `--actualizar` con `CLOUDFLARE_API_TOKEN` (sección 2.5).

---

## 3. Puesta en marcha del panel

Junto a Skyway, el emparejado (sección 2.6) ya deja creada la cuenta de
administración y la puesta en marcha completa: entra en
`https://panel.miempresa.com` con el correo y la contraseña del resumen del
instalador. Si el motor no respondía al emparejar, al entrar con esa cuenta
el asistente continúa en el paso del motor.

Sin emparejado (instalación autónoma, Skyway en otro servidor), abre la
dirección que muestra el instalador:
`https://panel.miempresa.com/setup?token=<MAILWAY_SETUP_TOKEN>`. El token de
puesta en marcha evita que el primer visitante de un panel recién publicado
se quede con la instancia; también está en `deploy/.env`. Sin él, el paso 1
responde `403 setup_token_invalid`.

El asistente tiene cuatro pasos:

1. **Administrador**: tu cuenta del panel (no es la del motor).
2. **Motor de correo**: con las variables del instalador, «Usar el motor
   configurado en el servidor» lo conecta sin que su contraseña pase por el
   navegador. Al conectar, el panel aplica en el motor los ajustes
   recomendados.
3. **Servidor**: marca, nombre del servidor de correo, IP pública (botón
   «Detectar»), URL del webmail y URL del panel.
4. **Comprobación**: DNS de la plataforma, PTR, certificado del motor y los
   siguientes pasos.

Después, en el panel:

- **Conexiones → Cloudflare**: si diste un token al instalador, la cuenta de
  la instancia («Instalador de Mailway») ya está conectada (sección 2.7); si
  no, conecta una con el ámbito «Toda la instancia» si vas a usar Cloudflare
  para el certificado o para los dominios de tus clientes. **DNS de la
  plataforma** crea los registros del propio servidor si aún faltan.
- **Ajustes → Servidor de correo**: comprueba el nombre del servidor, los
  ajustes recomendados y el certificado (sección 5).
- **Avisos → Canales de aviso**: configura al menos un canal (sección 10).

---

## 4. Conectar Skyway

### 4.1 Skyway 0.34 o posterior

Skyway gestiona el correo de cada proyecto a través de la API de Mailway.
Con el instalador, el emparejado (sección 2.6) hace esta conexión solo; los
pasos siguientes son la **alternativa manual** (Skyway en otro servidor, o
versiones de Skyway o del panel sin las herramientas de emparejado):

1. En Mailway, con la cuenta de administración: **Conexiones → Tokens de
   gestión → Crear token** (p. ej. «Skyway», sin caducidad). Copia el token
   `mwt_…`: solo se muestra una vez.
2. En Skyway: **Ajustes → Correo (Mailway)**. Selecciona el servicio de Skyway
   que ejecuta el panel de Mailway (Skyway le hablará por la red interna) o
   escribe su URL pública, pega el token y pulsa **Probar conexión**. Skyway
   avisa si el token no es de administrador. Guarda.
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

> Si actualizas Skyway desde una versión anterior y tenías un
> `docker-compose.override.yml` para Mailway en la carpeta de Skyway,
> **elimínalo** y ejecuta `docker compose up -d traefik` en esa carpeta: el
> fichero sustituye los parámetros de Traefik de la 0.34 (Traefik solo admite
> un proveedor HTTP) y dejaría sin efecto el puente. `deploy/instalar.sh
> --actualizar` lo retira por ti, también si lo copiaste a mano de Ajustes →
> Marca blanca (sección 8.2).

### 4.3 Skyway anterior a 0.34 o Traefik propio

Traefik debe consultar el panel directamente. El instalador lo configura solo
(paso 12 de la sección 2.3). A mano:

1. En Mailway, **Ajustes → Rutas de Traefik** muestra el bloque exacto
   (`docker-compose.override.yml`) con su token y el destino del panel. Hay
   una plantilla comentada en `deploy/skyway-traefik-override.yml`.
2. Cópialo a la carpeta de Skyway como `docker-compose.override.yml` y
   aplícalo: `cd /ruta/a/Skyway && docker compose up -d traefik`.

Compose **reemplaza** `command` entero, no lo fusiona: el bloque repite los
parámetros que ya traía Traefik. Si actualizas Skyway y cambian, compáralos
con `docker inspect -f '{{json .Config.Cmd}}' skyway-traefik`.

---

## 5. Certificado TLS de IMAP y SMTP

Los programas de correo exigen un certificado válido en los puertos 993, 465 y
587. Hay dos vías; elige una.

### 5.1 ACME del propio motor con Cloudflare (preferida)

El motor pide y renueva su certificado a Let's Encrypt con el reto DNS-01 en
Cloudflare. No depende de Traefik ni del puerto 80, renueva 30 días antes de
caducar y sirve para IMAP y SMTP.

- **Con el instalador**: si indicaste un token de Cloudflare, ya está hecho.
- **Desde el panel**: conecta en **Conexiones → Cloudflare** una cuenta con el
  ámbito «Toda la instancia» cuyo token vea la zona de `mail.<dominio>`. En
  **Ajustes → Servidor de correo**, elige esa cuenta, indica el correo de
  contacto y emite el certificado. Solo se admiten cuentas de la instancia
  (`400 cloudflare_account_not_instance` con la de un cliente).
- **Por API**: `POST /api/engine/acme` con
  `{"cloudflareAccountId":"cf_…","email":"sistemas@miempresa.com"}` y un token
  de administrador.

La emisión tarda unos minutos. **Ajustes → Servidor de correo** muestra el
emisor y los días de validez; el botón de recarga (`POST
/api/engine/reload-certificate`) hace que el motor use el certificado nuevo.

### 5.2 Alternativa: el certificado de Traefik, con el extractor

Traefik ya obtiene un certificado para `mail.<dominio>` (la web del motor va
por Traefik). El **extractor del certificado** lo lleva al motor: es el
servicio `certs-dumper` del perfil `tls` (contenedor `mailway-certs-dumper`,
código en `deploy/tls/extractor.py`). El instalador lo usa cuando no hay token
de Cloudflare. Cada 30 segundos:

1. Lee el `acme.json` de Traefik **en solo lectura**.
2. Elige para `MAIL_HOSTNAME` el certificado exacto o comodín que caduca más
   tarde. El par que ya está en uso también compite: nunca lo cambia por otro
   que caduca antes.
3. Lo valida antes de escribir nada: vigente, válido para `MAIL_HOSTNAME` y
   con la clave privada que corresponde al certificado.
4. Escribe **solo ese par**, de forma atómica, donde lo lee
   `certificate.mailway`: `/opt/stalwart/certs/<MAIL_HOSTNAME>/cert.pem` y
   `key.pem`. Esa ruta es un enlace a una versión inmutable dentro de
   `.mailway-tls/`, así que el motor nunca ve el certificado de un par y la
   clave de otro.
5. Si el par cambió, pide al motor `GET /api/reload/certificate` y comprueba
   el certificado que sirve en 993 y 465 (cadena, nombre y huella). Si no es
   el nuevo, vuelve al anterior; el renovado no se reintenta hasta pasadas 6
   horas. Con todo en orden, repite la comprobación cada 10 minutos.

Si el motor obtiene su propio certificado por ACME (sección 5.1), el extractor
no hace nada. Si además conserva `certificate.mailway`, mantiene esos ficheros
al día sin recargar el motor, porque el motor los vuelve a cargar en cada
recarga de certificados. Si `certificate.mailway` apunta al par de otro
nombre (el anterior a cambiar `MAIL_HOSTNAME`), ya no es «nada que hacer»: ese
par no lo renueva nadie, así que el extractor deja listo el del nombre actual
y su estado lo señala hasta que el instalador traslada `certificate.mailway`.

Tras cambiar `MAIL_HOSTNAME`, `certificate.mailway` sigue apuntando al par del
nombre anterior hasta que el instalador lo traslada (sección 8.3). Mientras
tanto, el extractor no retira ese par ni la versión a la que apunta, aunque
sea de otro nombre: si lo hiciera, la siguiente recarga o el siguiente
arranque dejarían al motor sin certificado. Si la API del motor no responde y
no se sabe qué usa, no retira ningún enlace. Su estado lo indica («El motor aún
usa el certificado de …»).

> **Seguridad.** Hasta ahora el perfil `tls` usaba `traefik-certs-dumper`,
> que copiaba al volumen del motor las claves privadas de **todos** los
> dominios de Traefik, también las de las demás webs de Skyway. El extractor
> no decodifica siquiera las entradas de otros dominios y, al arrancar,
> retira del volumen esas copias; la carpeta que dejaba el volcado para
> `MAIL_HOSTNAME` pasa a ser una versión propia, con las mismas rutas.
> `deploy/instalar.sh --actualizar` hace el cambio sin tocar la configuración
> del motor. Si el motor seguía con el `certificate.default` de la guía 0.x,
> el instalador lo pasa a `certificate.mailway` (sección 8.2).

Para recargar los certificados usa la contraseña **vigente** del
administrador del motor (`STALWART_ADMIN_PASSWORD` de `deploy/.env`). Si el
motor la rechaza (401) o el usuario no tiene permiso (403), no reintenta hasta
pasada una hora y lo explica en su registro: cada contraseña incorrecta
cuenta para el bloqueo automático del motor. Corre solo en
`mailway-internal`, la red exenta de ese bloqueo, sin capacidades del núcleo y
con el sistema de ficheros en solo lectura. Nunca registra secretos.

A mano:

```bash
cd /ruta/a/Mailway
# 1) Nombre real del volumen de certificados de Skyway (<carpeta>_traefik-letsencrypt):
docker volume ls | grep letsencrypt
#    Si no es skyway_traefik-letsencrypt, ajusta TRAEFIK_ACME_VOLUME en deploy/.env.

# 2) Arrancar el extractor:
docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml --profile tls up -d certs-dumper
docker exec mailway-mail ls -l /opt/stalwart/certs/   # mail.miempresa.com -> .mailway-tls/…

# 3) Indicar al motor (una sola vez) que use esos ficheros. El puerto 8080 del
#    motor no está publicado: se usa un contenedor efímero en la red interna.
#    Sustituye mail.miempresa.com por el nombre de tu servidor.
read -rsp 'Contraseña del motor (STALWART_ADMIN_PASSWORD): ' PASS; echo
docker run --rm --network mailway-internal curlimages/curl:8.11.1 -sS -u "admin:$PASS" \
  -X POST http://mailway-mail:8080/api/settings -H 'Content-Type: application/json' \
  -d '[{"type":"insert","prefix":null,"assert_empty":false,"values":[
        ["certificate.mailway.cert","%{file:/opt/stalwart/certs/mail.miempresa.com/cert.pem}%"],
        ["certificate.mailway.private-key","%{file:/opt/stalwart/certs/mail.miempresa.com/key.pem}%"],
        ["certificate.mailway.default","true"],
        ["certificate.mailway.subjects.0","mail.miempresa.com"]]}]'
docker run --rm --network mailway-internal curlimages/curl:8.11.1 -sS -u "admin:$PASS" \
  http://mailway-mail:8080/api/reload/certificate
unset PASS

# 4) Estado: en el minuto siguiente debe confirmar el certificado servido.
docker exec mailway-certs-dumper python /app/extractor.py estado
```

El campo `assert_empty` es obligatorio en la API de ajustes de Stalwart 0.15:
sin él, la petición falla. `certificate.mailway.subjects.0` hace que el motor
sustituya el certificado al recargar aunque el nuevo sea un comodín; sin él,
conservaría en memoria el exacto anterior hasta reiniciarse. El instalador lo
añade también a las instalaciones existentes.

El registro del extractor (`docker logs mailway-certs-dumper`) explica cada
cambio y cada problema en una línea, sin repetirla. Sus tiempos se pueden
ajustar con variables de entorno (por ejemplo, en un fichero de
`MAILWAY_COMPOSE_EXTRA`):

| Variable | Por defecto | Uso |
|---|---|---|
| `MAILWAY_TLS_INTERVALO` | `30` | Segundos entre lecturas de `acme.json`. |
| `MAILWAY_TLS_COMPROBACION` | `600` | Segundos entre comprobaciones completas cuando todo está en orden. |
| `MAILWAY_TLS_ESPERA_AUTH` | `3600` | Espera tras un 401 o 403 del motor antes de volver a intentarlo. |
| `MAILWAY_TLS_ESPERA_RECHAZO` | `21600` | Espera antes de reintentar un certificado que el motor no llegó a servir. |

### 5.3 Comprobar

```bash
openssl s_client -connect mail.miempresa.com:993 -servername mail.miempresa.com </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -enddate
```

Debe indicar Let's Encrypt. Desde el propio servidor, `sudo bash
deploy/instalar.sh --comprobar` verifica el certificado de 993 y 465 desde el
webmail, con el nombre público, sin depender de que el servidor se alcance a
sí mismo por su IP pública (sección 13.1).

El vigilante comprueba el certificado a diario y abre un aviso (`engine_tls`)
si quedan menos de 20 días, si quedan menos de 7 (crítico), si ha caducado, si
es autofirmado, si no corresponde al nombre del servidor o si la cadena no es
de confianza.

### 5.4 El SMTP interno de la API de envío

La API de envío entrega al motor por la red interna (`mailway-mail:587`). El
panel verifica su certificado contra el nombre público del servidor
(`mail.<dominio>`), así que funciona en cuanto el certificado es válido. El
instalador no desactiva esa verificación. Solo mientras el motor no tenga un
certificado válido (por ejemplo, sin Cloudflare y con el certificado de
Traefik aún pendiente), `MAILWAY_SMTP_ALLOW_SELF_SIGNED=1` acepta el
autofirmado: en las variables del panel (en Skyway, pestaña Variables) o, en
la instalación autónoma, en `deploy/.env`. Una vez emitido el certificado,
**elimínala** y vuelve a desplegar; `deploy/instalar.sh --actualizar` la
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

Sin proxy de Cloudflare (nube gris). Espera a que propaguen:
`dig +short mail.miempresa.com` debe devolver la IP.

### 6.2 Configuración (`deploy/.env`)

```bash
git clone https://github.com/NkrowOne/Mailway.git
cd Mailway
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
nano deploy/.env
```

Rellena al menos: `MAIL_HOSTNAME`, `WEBMAIL_HOSTNAME`, `PANEL_HOSTNAME`,
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
> REST que usa Mailway. No la actualices sin leer [PLAN.md](PLAN.md).

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
del panel, por la red interna. Indica el contenedor real del panel en
`deploy/.env` y recrea el webmail:

```bash
docker ps --format '{{.Names}}' | grep '^skyway-.*panel'      # p. ej. skyway-mailway-panel
# En deploy/.env: MAILWAY_PANEL_INTERNAL_URL=http://skyway-mailway-panel:4100
docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml up -d mailway-webmail
```

### 6.6 Puesta en marcha, rutas y certificado

1. Empareja el panel con Skyway con las dos herramientas de terminal de la
   sección 2.6 (o con `sudo bash deploy/instalar.sh --emparejar`, que solo
   necesita `deploy/.env`). Si no puedes, abre
   `https://panel.miempresa.com/setup?token=<MAILWAY_SETUP_TOKEN>`, completa
   el asistente (sección 3) y conecta Skyway a mano (sección 4.1). Al
   conectar el motor se aplican los ajustes recomendados; si fallan,
   repítelos en **Ajustes → Servidor de correo**.
2. Comprueba las rutas de Traefik (sección 4.2).
3. Configura el certificado (sección 5).

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
(`127.0.0.1:8080`) escuchan **solo en local**: ponles delante un proxy con
TLS (Caddy, Nginx…). Nunca los publiques en HTTP hacia Internet: por ellos
viajan contraseñas.

El certificado de IMAP/SMTP se obtiene igual que en la sección 5: ACME del
motor con Cloudflare desde **Ajustes → Servidor de correo**, o el extractor
del certificado de `mailway-proxy` (perfil `tls`, sección 5.2).

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
  Junto a Skyway, `--actualizar` también actualiza las variables del panel y
  lo vuelve a desplegar (con `SKYWAY_TOKEN` o, si Skyway corre en este
  servidor, con un token temporal), y empareja de nuevo solo si Skyway no
  está ya conectado con el panel.
  Stalwart está fijado a `v0.15.5`, así que `pull` nunca salta a la v0.16.
  Si no se pueden descargar las imágenes (límite de descargas de Docker Hub,
  sin conexión), el instalador lo avisa y lo deja en el resumen: el motor y
  el webmail siguen con las anteriores, que pueden no tener los últimos
  parches del webmail. Repite `--actualizar` cuando se resuelva.
- **Extractor del certificado** (perfil `tls`): `--actualizar` lo recrea con
  el código nuevo. A mano: `docker compose --env-file deploy/.env -f
  deploy/docker-compose.mail.yml --profile tls up -d --force-recreate
  certs-dumper`. Si la instalación venía de `traefik-certs-dumper`, el
  extractor lo sustituye con las mismas rutas y retira del volumen del motor
  las claves de los demás dominios de Traefik (sección 5.2).
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

Si el panel se creó a mano en Skyway con la guía anterior (con cualquier
nombre de proyecto y de servicio), el instalador lo encuentra (por su
contenedor o, si está parado, por el repositorio que despliega), te pregunta
si es el de esta instalación y, si respondes que sí, **actualiza ese panel**
sin crear otro:

- No pregunta por el panel que ya nombra `deploy/.env` (su contenedor o su
  dominio). Ignora los paneles de los proyectos de clientes: en un Skyway
  con clientes, otro puede desplegar también un Mailway.
- Conserva su clave maestra. En esas instalaciones vive en el volumen `/data`
  del panel y no en sus variables: el instalador la lee de ahí para
  `deploy/.env` y no la añade a sus variables. Con otra clave, el panel
  perdería sus secretos cifrados, los tokens de gestión y las claves de API
  dejarían de valer y cambiaría el TXT `_mailway` de los dominios ya
  verificados. Si el panel está parado y no se puede leer, `deploy/.env` no
  guarda ninguna.
- Conserva también su token de Traefik, que esos paneles guardan en su base
  de datos.
- Propone el dominio, los nombres y la IP que ya usa el panel cuando
  `deploy/.env` no los tiene. Usa la contraseña del motor del panel solo si
  el motor ya tiene datos. Conserva las variables y el dominio que se
  añadieron a mano.
- Sin terminal (`--actualizar` o ejecución desatendida), no pregunta: se
  detiene sin tocar nada y pide `MAILWAY_PANEL_SERVICIO=<id del servicio>`
  para actualizarlo o `MAILWAY_PANEL_SERVICIO=ninguno` para no tocarlo. Lo
  mismo si Skyway despliega varios paneles.

El instalador también resuelve lo que dejaba configurado la guía anterior:

- **Certificado de IMAP y SMTP.** La guía 0.x arrancaba `traefik-certs-dumper`
  y apuntaba `certificate.default` a los ficheros que volcaba
  (`/opt/stalwart/certs/<servidor de correo>/cert.pem` y `key.pem`). La
  migración retira ese volcador, y sin él nadie renovaría el certificado. Por
  eso el instalador lo pasa a `certificate.mailway`, con las mismas rutas, y
  borra `certificate.default`. Después arranca el extractor (sección 5.2),
  que lo renueva y retira del volumen las claves privadas de los demás
  dominios que había copiado el volcador. Si el motor emite su propio
  certificado por ACME (con Cloudflare o configurado antes), solo borra
  `certificate.default` y limpia el volumen. Un certificado propio con otras
  rutas no se toca.
- **Webmail.** El webmail anterior entraba al motor por su nombre público
  (`ssl://<servidor de correo>`); el de la 1.0 entra por la red interna
  (`ssl://mailway-mail`). Roundcube identifica a cada usuario por su
  dirección y por ese servidor (`users.mail_host`). Sin más, cada titular
  vería el webmail vacío: sin contactos, identidades, firmas ni
  preferencias, aunque siguen en la base. El instalador cambia ese servidor
  en la base del webmail con el contenedor antiguo ya retirado y antes de
  levantar el nuevo. El usuario que ya hubiera entrado con la 1.0 conserva
  ese usuario y el instalador lo indica. Si los contenedores ya los trasladó
  el instalador de la 1.0.x, que no hacía este cambio, repetir la instalación
  lo hace con el webmail en marcha (es idempotente y sin cambios no dice
  nada). Si el cambio falla, avisa y la instalación sigue: hazlo a mano
  (abajo).
- **Override de Traefik.** Con la guía 0.x, el bloque de Ajustes → Marca
  blanca se copiaba a `docker-compose.override.yml` en la carpeta de Skyway.
  Con Skyway 0.34 o posterior, ese fichero deja sin efecto el puente de
  Skyway (sección 4.2). El instalador lo reconoce aunque se copiara a mano
  (lleva `/api/traefik/config` o `X-Mailway-Token`), ofrece retirarlo (lo
  conserva como `docker-compose.override.yml.mailway-retirado`) y recrea
  Traefik. Solo confirma el resultado si Traefik corre después con el
  proveedor de Skyway (`api/traefik/mailway`); si no, avisa. Si añadiste
  otros ajustes a ese fichero, recupéralos de la copia. Con Skyway anterior
  a la 0.34, si el panel guarda su propio token de Traefik, no genera el
  fichero: copia el bloque de Ajustes → Rutas de Traefik del panel (sección
  4.3).

**A mano:**

```bash
docker volume ls | grep mailway                         # localiza los volúmenes deploy_*
# En deploy/.env:
#   MAILWAY_MAIL_VOLUME=deploy_mailway-mail-data
#   MAILWAY_WEBMAIL_DB_VOLUME=deploy_mailway-webmail-db
#   MAILWAY_PANEL_VOLUME=deploy_mailway-panel-data      # solo en la instalación autónoma
#   ROUNDCUBE_DES_KEY, MAILWAY_WEBMAIL_TOKEN, MAILWAY_PANEL_INTERNAL_URL… (ver .env.example)
docker rm -f mailway-webmail mailway-certs-dumper mailway-mail   # los volúmenes se conservan
#   (en la instalación autónoma, retira también mailway-panel y usa docker-compose.standalone.yml)
docker network rm mailway-internal                               # se recrea con la subred fija

# Usuarios del webmail: del servidor público al interno, con el webmail parado.
# Sustituye mail.miempresa.com por el nombre de tu servidor de correo.
docker run --rm -v deploy_mailway-webmail-db:/var/roundcube/db --entrypoint php \
  roundcube/roundcubemail:1.7.x-apache -r '
    $db = new PDO("sqlite:/var/roundcube/db/sqlite.db", null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $q = $db->prepare("UPDATE OR IGNORE users SET mail_host = ? WHERE lower(mail_host) = ?");
    $q->execute(["mailway-mail", $argv[1]]);
    echo $q->rowCount(), " usuarios trasladados\n";' mail.miempresa.com

docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml up -d
```

Si el motor usaba el certificado del volcador (`certificate.default` con las
rutas de `/opt/stalwart/certs/`), sigue los pasos 2 a 4 de la sección 5.2 y,
antes de recargar los certificados, borra `certificate.default`:

```bash
docker run --rm --network mailway-internal curlimages/curl:8.11.1 -sS -u "admin:$PASS" \
  -X POST http://mailway-mail:8080/api/settings -H 'Content-Type: application/json' \
  -d '[{"type":"clear","prefix":"certificate.default."}]'
```

Con Skyway 0.34 o posterior, retira el override de Traefik de la guía 0.x:

```bash
cd /ruta/a/Skyway
mv docker-compose.override.yml docker-compose.override.yml.mailway-retirado
docker compose up -d traefik
docker inspect -f '{{json .Config.Cmd}}' skyway-traefik | grep -o 'api/traefik/mailway'
```

Después, en el panel, **Ajustes → Servidor de correo → Aplicar ajustes
recomendados** (nombre del servidor, proxy y exención de la red interna), y
añade al servicio del panel en Skyway las variables nuevas de la sección 6.4
(`MAILWAY_WEBMAIL_TOKEN`, `MAILWAY_ENGINE_TRUSTED_NETWORK`,
`MAILWAY_SETUP_TOKEN`…).

---

### 8.3 Cambiar el dominio o la IP de la plataforma

El instalador compara los nombres y la IP con los de la ejecución anterior
(`deploy/.env` o, sin él, el panel que ya despliega Skyway) antes de escribir
nada.

**Otro dominio base u otros nombres** (`MAILWAY_DOMINIO`, `MAILWAY_*_HOST`):
resume lo que cambia y lo que supone, y pide confirmación (por defecto, no);
sin terminal, se detiene salvo que se indique `MAILWAY_CAMBIAR_NOMBRES=1`.

```bash
cd /ruta/a/Mailway
git pull
sudo MAILWAY_DOMINIO=nuevo.com MAILWAY_CAMBIAR_NOMBRES=1 bash deploy/instalar.sh --actualizar
```

Con el cambio confirmado, el instalador:

- escribe los nombres nuevos en `deploy/.env` y en las variables del panel,
  y con Cloudflare crea los registros A que falten;
- fija el nombre nuevo en el motor y le lleva el certificado:
  - **ACME del motor** sin token en esta ejecución: pasa
    `acme.mailway.domains.0` al nombre nuevo con el token que ya guarda el
    motor si el nombre nuevo está en la misma zona de Cloudflare. Si está en
    otra, ese token puede no tener acceso: lo deja como estaba, lo avisa y
    hay que repetir con `CLOUDFLARE_API_TOKEN` (permisos en la zona nueva) o
    emitirlo en Ajustes → Servidor de correo → certificado automático. Con
    `CLOUDFLARE_API_TOKEN`, lo configura entero para la zona nueva. Si el
    motor conserva además `certificate.mailway` en el par del extractor del
    nombre anterior (instalaciones que empezaron con el extractor y
    añadieron después un token de Cloudflare), ese par ya no lo renueva
    nadie: pasa al del nombre nuevo como con el extractor (abajo). Con el
    ACME en otra zona, es además el certificado que el motor presenta para
    el nombre nuevo;
  - **extractor**: arranca con el nombre nuevo, espera a que Traefik tenga su
    certificado y entonces cambia `certificate.mailway` (certificado, clave y
    sujeto) en una sola operación. Hasta entonces el motor conserva el par
    del nombre anterior, que el extractor no retira mientras el motor lo use
    (sección 5.2). Si el DNS aún no apunta aquí, el resumen lo dice y basta
    con repetir `--actualizar` más tarde;
  - **certificado propio**: no lo toca, pero pide comprobar que cubre el
    nombre nuevo;
- hace que el panel adopte los nombres nuevos en Ajustes → Identidad del
  servidor (nombre del servidor, URL del webmail y URL del panel) aunque se
  hubieran cambiado a mano, y le aplica al motor los ajustes recomendados con
  el nombre nuevo, antes del emparejado (`server/dist/tools/identidad.js`).

**Si algo queda a medias.** Lo que el panel aún no ha adoptado se guarda en
`deploy/.env` (`MAILWAY_ADOPCION_PENDIENTE`, con un comentario) desde la
primera escritura, y cada ejecución (también `--emparejar`) lo retoma hasta
lograrlo; después se borra. Así, si la ejecución se interrumpe después de
escribir `deploy/.env` (un error de Skyway o de Cloudflare, Ctrl-C), basta con
repetir `sudo bash deploy/instalar.sh --actualizar`, aunque `deploy/.env` ya
tenga los nombres nuevos. Antes de adoptar, el instalador comprueba que el
panel en marcha arranca ya con los valores nuevos: si el despliegue en
Skyway ha fallado o sigue en curso, el contenedor que corre es el anterior,
con el entorno anterior. En ese caso, y siempre que la adopción quede
pendiente, **no empareja** (el emparejado aplica en el motor los ajustes del
panel y lo devolvería al nombre anterior) y el resumen dice que se repita
`--actualizar` cuando el panel esté desplegado y en marcha. `--comprobar`
también lo señala. Para descartar lo pendiente sin adoptarlo, borra esa línea
de `deploy/.env`.

Lo que el instalador no puede hacer por ti, y recuerda en «Siguientes pasos»:

- cambiar el **MX** (y la autoconfiguración) de los dominios de los clientes
  al nombre nuevo: la ficha de cada dominio muestra los registros o los
  aplica en Cloudflare; hasta entonces figuran como pendientes de DNS;
- volver a configurar los programas de correo que usaban el nombre anterior
  (sus enlaces de configuración ya llevan el nuevo);
- pedir al proveedor el **PTR** de la IP hacia el nombre nuevo.

El webmail deja de responder en el nombre anterior. Junto a Skyway, el panel
conserva su nombre anterior además del nuevo; en la instalación autónoma, el
anterior deja de responder.

**Otra IP** (mudanza, IP nueva del proveedor): si la IP guardada no es la de
este servidor y ninguna de sus interfaces la tiene, con terminal se propone la
detectada y sin terminal el instalador se detiene y dice qué indicar:
`MAILWAY_IP=<nueva>` si el servidor ha cambiado de IP, o `MAILWAY_IP=<guardada>`
si sale a Internet por otra IP y la guardada es la correcta. Con la IP nueva
confirmada, el panel la adopta, y con Cloudflare los A pasan a ella
(preguntando, o sin terminal con `MAILWAY_DNS_REEMPLAZAR=1`); un A que ya
apunta a la IP con la que sale el servidor nunca se devuelve a la anterior
sin confirmación. Revisa el PTR de la IP nueva y el SPF de los dominios que
incluyan la anterior de forma explícita.

**Qué adopta el panel solo.** El panel guarda el último valor que le dio el
instalador de cada campo de la identidad. Al arrancar (el instalador recrea
su contenedor o Skyway lo vuelve a desplegar) y al emparejar, lo que nadie
ha cambiado en Ajustes pasa al valor nuevo. Lo que la administración cambió
a mano se conserva, y la diferencia se dice en la salida del emparejado y en
el registro del panel. Si es el nombre del servidor o la IP, se abre además
el aviso «Ajustes y el instalador no coinciden en …», con los dos valores: si
el correcto es el del instalador, cámbialo en Ajustes → Identidad del
servidor (el aviso se cierra al guardar); si es el de Ajustes, repite el
instalador con ese valor. Las URL del webmail y del panel no abren aviso:
una propia que funcione es legítima y, si el webmail no responde, ya avisa
el vigilante. Un panel anterior a este registro solo adopta valores nuevos
cuando el instalador lo pide tras una confirmación. Hasta entonces, como no
consta si lo guardado vino del instalador o se cambió en el panel, el aviso
lo dice así y solo aparece en la campana del panel, sin enviarse a los
canales de aviso: al cambiar el dominio de un panel de antes de este
registro, se abre en su primer arranque y el instalador lo cierra segundos
después.

## 9. Primer cliente

En el panel (`https://panel.miempresa.com`):

1. **Clientes → Alta de cliente**: nombre y plan, y opcionalmente el usuario con
   el que el cliente entrará en su panel (la contraseña generada se muestra
   una sola vez). Los planes se editan en **Planes**.
2. El cliente (o tú en su nombre) sigue la lista de puesta en marcha:
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
3. Envía a los titulares la [guía para titulares](GUIA-TITULARES.md) junto con
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

En **Avisos → Canales de aviso** configura al menos uno:

- **Discord**: Ajustes del canal → Integraciones → Webhooks → Copiar URL.
- **Telegram**: crea un bot con [@BotFather](https://t.me/BotFather) e indica
  su token y el ID del chat.
- **Webhook genérico**: recibe un JSON (útil para n8n o un sistema propio).

Pulsa **Enviar aviso de prueba**. Skyway no vigila estos contenedores: el
vigilante de Mailway es lo que cubre el correo.

Además, al arrancar el panel, al emparejarlo y al guardar Ajustes → Identidad
del servidor, se compara la identidad con la que fijó el instalador: si el
nombre del servidor o la IP se cambiaron a mano y no coinciden, se abre
«Ajustes y el instalador no coinciden en …», con los dos valores (sección
8.3).

---

## 11. Marca blanca y autoconfiguración

- **Autoconfiguración**: con el DNS de la plataforma de la sección 6.1,
  Thunderbird configura cualquier dominio cuyo MX sea este servidor sin
  registros adicionales. Los nombres `autoconfig.`, `autodiscover.` y
  `mta-sts.` de cada dominio se publican en Traefik solo cuando su DNS ya
  apunta aquí. Estado en **Ajustes → Autoconfiguración de dispositivos**.
- **Marca blanca**: en **Marca blanca**, el cliente añade
  `webmail.sucliente.com` (debe ser un subdominio de uno de sus dominios de
  correo con la propiedad comprobada), crea el CNAME que se le indica (o pulsa «Configurar
  en Cloudflare») y pulsa **Comprobar**. El dominio pasa por *Esperando DNS →
  Emitiendo certificado → En servicio*. Mailway solo publica los dominios cuyo
  DNS ya apunta aquí: publicar uno que no resuelve haría fallar la validación
  de Let's Encrypt y acabaría en un bloqueo temporal por reintentos.
- **Webmail principal**: si un cliente tiene varios dominios de webmail en
  servicio, **Usar como principal** elige el que verán sus usuarios. Sin una
  elección expresa se usa el primero que entró en servicio y, si ninguno lo
  está, la URL general del webmail (**Ajustes**). El inicio del cliente, los
  datos de conexión de los buzones, los enlaces de configuración y la
  autoconfiguración usan siempre ese mismo webmail; los servidores IMAP y SMTP
  conservan el nombre del servidor de correo.
- **Comprobación**: un dominio solo cuenta como en servicio cuando responde
  por HTTPS con un certificado válido y un código 2xx o 3xx (un 404 o un 5xx
  indican que la ruta o su destino aún no están bien). **Ajustes → Rutas de
  Traefik** muestra cuándo consultó Traefik las rutas por última vez
  (directamente o a través de Skyway): si nunca lo ha hecho o lleva más de 90
  segundos sin hacerlo, revisa la conexión (sección 4).

Detalle y reglas en [INTEGRACIONES.md](INTEGRACIONES.md).

---

## 12. Entregabilidad

En **Entregabilidad** el panel comprueba PTR, registro A y listas negras
(Spamhaus, SpamCop, Barracuda) y ordena las tareas pendientes. Antes de enviar
en volumen:

- **Calienta la IP**: si es nueva, empieza con decenas de envíos al día y
  aumenta de forma gradual durante 2–4 semanas.
- **DMARC en `p=quarantine` o `p=reject`** cuando SPF y DKIM lleven unos días
  correctos.
- Prueba con [mail-tester.com](https://www.mail-tester.com) desde un buzón y
  desde la API; el objetivo es 10/10.
- Si Spamhaus aparece como «no concluyente», consulta manualmente en
  [check.spamhaus.org](https://check.spamhaus.org): rechaza las consultas
  hechas a través de resolutores públicos.

### 12.1 Lista de salida a producción

Que los contenedores respondan no significa que el servicio de correo esté
listo. Antes de aceptar clientes reales, deja comprobados **todos** estos
puntos y anota la fecha de la prueba:

- [ ] El panel solo se publica por HTTPS y `/api/health` devuelve `ok: true`.
- [ ] El volumen `/data` del panel es persistente y una copia de prueba se ha
  restaurado en otro directorio. Se copian juntos `mailway.db`, sus ficheros
  WAL/SHM si existen, y `.secret`.
- [ ] Los puertos 25 (de entrada **y de salida**), 465, 587 y 993 son
  accesibles desde fuera; el 8080 del motor no se publica en el host.
- [ ] El PTR devuelve `MAIL_HOSTNAME` y el registro A de ese nombre vuelve a
  la misma IP (FCrDNS).
- [ ] `openssl s_client` confirma un certificado público vigente en 465 y 993
  (sección 5.3); el autofirmado no se usa fuera de la red interna.
- [ ] `sudo bash deploy/instalar.sh --comprobar` termina sin incidencias y
  `--probar-acceso` abre la bandeja de entrada de un buzón de prueba desde el
  webmail (sección 13.1).
- [ ] Un dominio piloto muestra MX, SPF, DKIM y DMARC verificados en Mailway.
- [ ] Se han probado la recepción, el envío SMTP autenticado y `POST /v1/send`
  en ambos sentidos con Gmail u Outlook; no basta con probar dentro del
  dominio.
- [ ] Hay al menos un canal de avisos configurado y el aviso de prueba llega
  (sección 10).
- [ ] Se ha ensayado la restauración de los volúmenes del motor y del panel:
  una copia que nunca se ha restaurado no se considera verificada.
- [ ] Se han acordado el calentamiento de la IP y límites bajos para el primer
  cliente; no se inicia un envío masivo desde una IP nueva.

**Criterio de decisión:** el software puede desplegarse cuando pasan la
compilación, las pruebas y esta lista. La disponibilidad, la reputación, el
PTR, el cortafuegos, el TLS y la restauración dependen del servidor final y no
se pueden validar desde el repositorio. Mientras quede una casilla sin
comprobar, trata la instalación como preproducción.

---

## 13. Operación y copias de seguridad

- **Datos que respaldar**:
  - volumen `/data` del panel (SQLite y clave maestra; en Skyway, el volumen
    del servicio, que se puede programar desde Skyway);
  - volumen `mailway-mail-data` (todo el correo y la configuración del motor);
  - volumen `mailway-webmail-db` (ajustes de los usuarios del webmail);
  - `deploy/.env` (secretos; guárdalo cifrado).
  ```bash
  # Se detiene el motor unos segundos: copiar su base de datos en marcha
  # puede dejarla incoherente.
  docker stop mailway-mail
  docker run --rm -v mailway-mail-data:/origen:ro -v /root/copias:/destino alpine \
    tar czf /destino/mailway-correo-$(date +%F).tar.gz -C /origen .
  docker start mailway-mail
  ```
  Con una instalación migrada desde 0.x, sustituye `mailway-mail-data` por el
  valor de `MAILWAY_MAIL_VOLUME`.
- **Registros del motor**: `docker logs -f mailway-mail` y
  `docker exec mailway-mail ls /opt/stalwart/logs`.
- **Cola de salida**: visible en **Resumen → Tu servicio** (panel de administración).
- **Contraseña de administración del panel olvidada**: en el contenedor del
  panel (con Skyway, `skyway-<proyecto>-<servicio>`; en la instalación
  autónoma, `mailway-panel`), sin escribir la contraseña en la orden:
  ```bash
  # Genera una contraseña aleatoria y la muestra una sola vez:
  docker exec -u node skyway-mailway-panel node server/dist/tools/reset-password.js correo@ejemplo.com
  # O, para elegirla, por la entrada estándar («read -rs» no la muestra ni la guarda en el historial):
  read -rs -p 'Contraseña nueva: ' CLAVE; echo
  printf '%s\n' "$CLAVE" | docker exec -i -u node skyway-mailway-panel \
    node server/dist/tools/reset-password.js correo@ejemplo.com -
  unset CLAVE
  ```
  La contraseña debe tener entre 10 y 200 caracteres; se cierran las sesiones
  de ese usuario y la Actividad lo anota como «Sistema». Escrita como
  argumento también se admite, con un aviso: quedaría en el historial del
  shell y, mientras se ejecuta, a la vista de cualquier usuario del servidor
  con `ps`.

### 13.1 Diagnóstico y prueba de acceso

```bash
sudo bash deploy/instalar.sh --comprobar       # no cambia nada
sudo bash deploy/instalar.sh --probar-acceso   # un inicio de sesión real
```

**`--comprobar`** revisa, con los datos de `deploy/.env` y sin preguntar nada:

- que `mailway-mail`, `mailway-webmail` y el panel (`mailway-panel` en la
  instalación autónoma; junto a Skyway, el contenedor que nombra
  `MAILWAY_PANEL_INTERNAL_URL`) están en marcha y sanos;
- en el motor: el nombre del servidor, la exención de la red interna y qué
  certificado usa (ACME propio, el de Traefik con el extractor o uno a mano).
  Hace **una sola** petición autenticada a su API: si la contraseña de
  `deploy/.env` no es la vigente, lo dice y no reintenta;
- el certificado que sirve el motor en 993 y 465, verificado como lo haría
  un programa de correo (cadena de confianza, nombre y vigencia). Se
  comprueba desde el webmail, por la red interna y con el nombre público;
- la conexión IMAP y SMTP del webmail con el motor, con la configuración
  efectiva de Roundcube (`imap_conn_options` y `smtp_conn_options` de
  `deploy/roundcube/mailway.php`) y sin credenciales;
- que el webmail llega al panel por la dirección interna con la que cambia
  las contraseñas (`/api/health`), y la versión del panel;
- el estado del extractor del certificado, si está en marcha;
- si queda pendiente que el panel adopte los nombres o la IP nuevos de un
  cambio confirmado (`MAILWAY_ADOPCION_PENDIENTE` en `deploy/.env`, sección
  8.3);
- junto a Skyway, que su Traefik lee las rutas de Mailway (webmail de marca
  blanca y autoconfiguración de los dominios de los clientes);
- desde Internet: que `mail.`, `webmail.` y `panel.` resuelven a la IP de
  `deploy/.env` en los resolutores públicos, el DNS inverso (PTR) de esa IP
  y el puerto 25 de salida. Lo que no se puede consultar (resolutores
  filtrados) se indica, pero no cuenta como incidencia.

Termina con código 0 si todo es correcto y 1 si algo falla. No cubre los
puertos de entrada vistos desde Internet, las listas negras ni la entrega a
otros servidores: eso sigue en la lista de la sección 12.1 y en
Entregabilidad. `MAILWAY_COMPROBAR_SOLO_MOTOR=1` lo limita al motor, el
webmail y el extractor (lo usa la prueba de la pila de la CI, sin panel ni
DNS público).

**`--probar-acceso`** pide la dirección y la contraseña de un buzón (la
contraseña no se muestra, no se guarda y no aparece en la lista de procesos)
e inicia sesión desde el webmail con la biblioteca IMAP de Roundcube; después
abre la bandeja de entrada. Hace **un único intento** por ejecución: cada
contraseña incorrecta cuenta para el bloqueo automático del motor. Sin
terminal (por ejemplo, en un script), lee la dirección y la contraseña de dos
líneas de la entrada estándar.

Las dos opciones usan `deploy/roundcube/diagnostico/comprobar.php`, que los
compose montan en el webmail en `/opt/mailway` (fuera de la raíz web) y que
solo funciona por línea de órdenes.

---

## 14. Variables de entorno del panel

Los valores de motor e identidad son **iniciales**: tras la puesta en marcha
se guardan en la base de datos y se cambian en **Ajustes**.

| Variable | Por defecto | Uso |
|---|---|---|
| `PORT`, `HOST` | `4100`, `0.0.0.0` | Dirección de escucha. |
| `MAILWAY_DATA_DIR` | `/data` en la imagen | Base de datos y clave maestra. |
| `MAILWAY_SECRET` | se genera en `/data/.secret` | Clave maestra: firma sesiones, cifra secretos y deriva los TXT de verificación de propiedad. Mínimo 16 caracteres. **No la cambies** en una instalación en uso ([SEGURIDAD.md](SEGURIDAD.md#6-secretos)). |
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
| El paso 1 del asistente responde «El token de puesta en marcha no es correcto» | Falta `?token=` o no coincide con `MAILWAY_SETUP_TOKEN` | Usa la dirección que imprime el instalador o copia el valor de `deploy/.env`. |
| `mailway-mail` nunca llega a *healthy* | Núcleo sin IPv6, o puertos ocupados | Vuelve a ejecutar el instalador (cambia el motor a IPv4) y revisa `docker exec mailway-mail ls /opt/stalwart/logs`. |
| Gmail rechaza con «PTR record» | DNS inverso sin configurar | Panel del proveedor del servidor → DNS inverso → `mail.<dominio>` (sección 1). |
| No llega correo de fuera | Puerto 25 de entrada cerrado o MX incorrecto | `dig MX tu-dominio.com`; abre el 25 de entrada en el cortafuegos del proveedor. |
| No sale correo hacia Gmail u Outlook | Puerto 25 de salida bloqueado | Solicítalo al proveedor (sección 1). |
| Thunderbird o el iPhone avisan del certificado | Certificado de IMAP/SMTP sin configurar o autofirmado | Sección 5; estado en Ajustes → Servidor de correo o con `deploy/instalar.sh --comprobar`. |
| `mailway-certs-dumper` no está sano y su registro dice «El motor rechaza la contraseña de administración (HTTP 401)» | `STALWART_ADMIN_PASSWORD` de `deploy/.env` no es la contraseña vigente del motor | Corrígela y recrea el extractor (`docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml --profile tls up -d --force-recreate certs-dumper`). No reintenta antes de una hora para no alimentar el bloqueo automático. |
| El extractor dice «Traefik aún no tiene un certificado válido para mail.…» | El DNS de `mail.` aún no apunta aquí, los puertos 80/443 están cerrados o Traefik no tiene correo de Let's Encrypt | Sección 1; `docker logs skyway-traefik`. El motor conserva mientras tanto el certificado que tenga. |
| El extractor dice que el motor no sirve el certificado aunque se le pidió recargarlo | El motor conserva en memoria otro certificado para ese nombre | Reinicia el motor (`docker restart mailway-mail`) y comprueba que existe `certificate.mailway.subjects.0` (sección 5.2). |
| `--probar-acceso` dice que el motor rechazó el inicio de sesión | Contraseña incorrecta, o buzón inexistente o desactivado | Revisa el buzón en el panel antes de repetir: cada intento fallido cuenta para el bloqueo automático. |
| Un envío por API devuelve `status: "failed"` con un error de certificado | El SMTP interno no puede verificar el certificado | Emite el certificado (sección 5) o, solo mientras tanto, `MAILWAY_SMTP_ALLOW_SELF_SIGNED=1` en las variables del panel. |
| El webmail no inicia sesión | El motor no está sano o la IP del webmail está bloqueada | `docker ps`; comprueba en Ajustes → Servidor de correo que la exención de la red interna está aplicada. |
| El webmail no muestra «Contraseña» o no la cambia | Falta `MAILWAY_WEBMAIL_TOKEN` (en `deploy/.env` y en el panel, con el mismo valor) o `MAILWAY_PANEL_INTERNAL_URL` no apunta al contenedor real del panel | Sección 6.5; recrea `mailway-webmail`. |
| Una IP legítima no puede conectar al motor (bloqueo automático) | Stalwart bloquea de forma permanente una IP tras demasiados fallos de autenticación | Desbloquéala: `docker run --rm --network mailway-internal curlimages/curl:8.11.1 -sS -u "admin:$PASS" -X DELETE http://mailway-mail:8080/api/settings/server.blocked-ip.<IP>` y después `…/api/reload/server.blocked-ip`. |
| No se pueden crear buzones: `domain_ownership_pending` | La propiedad del dominio no está comprobada | Apunta el MX a este servidor o crea el TXT `_mailway.<dominio>` de la ficha del dominio y pulsa «Medir el DNS ahora». |
| Los nombres `autoconfig.` o la marca blanca dan 404 de Traefik | El DNS aún no apunta aquí (Mailway no los publica), o Traefik no consulta las rutas de Mailway | Pulsa «Comprobar» cuando el DNS esté listo. Con Skyway 0.34, comprueba que Mailway está conectado en Skyway (sección 4.2); en versiones anteriores, el override (sección 4.3). |
| Ajustes → Rutas de Traefik indica «Destino del panel: Sin detectar» | El panel no se desplegó con Skyway y no define `MAILWAY_PANEL_BACKEND_URL` | Define `MAILWAY_PANEL_BACKEND_URL=http://<contenedor del panel>:4100`. Sin él no se publican los nombres de autoconfiguración ni los dominios de tipo panel. |
| Un dominio de marca blanca se queda en «Emitiendo certificado» | Traefik no consulta el panel, o el puerto 80 está cerrado | Revisa la sección 4. Let's Encrypt valida por el puerto 80: debe estar abierto. |
| Tras actualizar Skyway a 0.34 las rutas de Mailway no se actualizan | Sigue el `docker-compose.override.yml` antiguo en la carpeta de Skyway | Elimínalo y ejecuta `docker compose up -d traefik` en la carpeta de Skyway (sección 4.2). |
| El botón «Correo» no aparece en un proyecto de Skyway | Mailway no está conectado en Skyway, o el plan de la cuenta no incluye el módulo «Correo» | `sudo bash deploy/instalar.sh --emparejar` (sección 2.6) o sección 4.1. |
| El instalador se detiene: «deploy/.env no menciona ese panel» | Se ejecutó sin terminal (`--actualizar` o desatendido) y encontró un panel que no conoce | Repite desde una terminal y confirma, o indica `MAILWAY_PANEL_SERVICIO=<id>` (actualizarlo) o `MAILWAY_PANEL_SERVICIO=ninguno` (no tocarlo). |
| El instalador se detiene porque Skyway despliega varios paneles de Mailway | Hay más de un servicio con el panel (p. ej. una copia de prueba) | Repite con `MAILWAY_PANEL_SERVICIO=<id>` y el servicio que corresponde (el instalador los lista). |
| El instalador avisa de que el emparejado ha quedado pendiente | Panel aún no sano, Skyway en otro servidor o versiones sin las herramientas de emparejado | Resuelve el motivo del aviso y ejecuta `sudo bash deploy/instalar.sh --emparejar`; si no es posible, conecta a mano (sección 4.1). |
| Se ha perdido la contraseña del administrador que mostró el instalador | No se guarda en ningún sitio | `docker exec -u node skyway-mailway-panel node server/dist/tools/reset-password.js <correo>` genera una nueva y la muestra una vez (sección 13; para elegirla, por la entrada estándar con `-`). |
| No llegan los avisos | Ningún canal configurado, o token o URL incorrectos | Avisos → «Enviar aviso de prueba»; el panel indica qué canal falla. |
| Aviso «El webmail no está disponible» | El contenedor del webmail está parado o no arranca | `docker logs mailway-webmail`; en la carpeta de Mailway, `sudo bash deploy/instalar.sh --comprobar` y, si hace falta, `--actualizar`, que lo levanta con el compose de la instalación (junto a Skyway o autónoma). |
| El instalador se detiene: «La IP guardada (…) no es la de este servidor» | Mudanza, IP nueva del proveedor o un servidor que sale a Internet por otra IP | `MAILWAY_IP=<detectada>` si ha cambiado de IP; `MAILWAY_IP=<guardada>` si la guardada es la correcta (sección 8.3). |
| El instalador se detiene: «Los nombres de la plataforma cambiarían» | `MAILWAY_DOMINIO` o `MAILWAY_*_HOST` distintos de los de `deploy/.env`, sin terminal | Si es lo que quieres, repite con `MAILWAY_CAMBIAR_NOMBRES=1`; si no, sin esas variables (sección 8.3). |
| Aviso «Ajustes y el instalador no coinciden en …» | El nombre del servidor o la IP de Ajustes → Identidad del servidor, cambiados a mano, no son los que fijó el instalador | Si el correcto es el del instalador, cámbialo en Ajustes; si es el de Ajustes, repite el instalador con ese valor (sección 8.3). |
| El extractor dice «El motor aún usa el certificado de …» | Ha cambiado `MAIL_HOSTNAME` y el motor sigue con el par del nombre anterior | `sudo bash deploy/instalar.sh --actualizar` lo traslada cuando Traefik tenga el certificado del nombre nuevo, también si el motor usa además su propio ACME (sección 8.3). |
| Resumen del instalador: «Identidad en el panel: pendiente» y «sin emparejar: el panel aún no ha adoptado la identidad nueva» | Tras un cambio de nombres o de IP, el panel en marcha aún arranca con los valores anteriores (despliegue fallido o en curso en Skyway), no está sano o no tiene `identidad.js` | Resuelve el despliegue en Skyway (o despliega la versión actual) y repite `sudo bash deploy/instalar.sh --actualizar`: retoma la adopción y el emparejado (sección 8.3). |

---

## 16. Pruebas automáticas del despliegue

Además de `ci.yml` (compilación y pruebas del panel), el workflow
`.github/workflows/stack.yml` prueba el despliegue cuando cambia `deploy/`, a
mano y cada semana (las imágenes de Roundcube y de Python siguen su versión
menor):

1. **Sin contenedores**: pruebas unitarias del extractor
   (`python3 -m unittest discover -s deploy/tls`, con un motor de laboratorio
   y certificados generados con openssl), sintaxis de Python, PHP y Bash,
   `shellcheck` y `docker compose config` de los dos compose, con y sin el
   perfil `tls`. Además, `deploy/prueba-emparejado.sh` carga las funciones
   del instalador con `docker` y la API de Skyway simulados y comprueba el
   emparejado (correo de la cuenta, avisos de la puesta en marcha, que se
   repite con Skyway ya conectado y no toca otro panel), el paso del token de
   Cloudflare (llega por la entrada estándar al panel y a Skyway y nunca
   aparece en los argumentos de `docker` ni en `deploy/.env`; sin la
   herramienta en Skyway, avisa y sigue; sin token, no llama a ninguna) y el
   paso «Panel en Skyway» cuando su API no responde (token temporal revocado, IP del
   contenedor, sin interrumpir la instalación) y con un panel que Skyway ya
   despliega (se actualiza sin duplicarlo ni cambiar su clave maestra). Solo
   necesita bash y `jq`. `deploy/prueba-migracion.sh`, igual, comprueba la
   migración desde la 0.x (sección 8.2): el certificado del volcador pasa al
   extractor, los usuarios del webmail cambian de servidor sobre una base
   SQLite con el esquema de Roundcube (necesita php con `pdo_sqlite`) y el
   override de Traefik copiado a mano se retira; y también que no cambia un
   certificado propio, un webmail que ya usaba `mailway-mail` ni un override
   ajeno. Las dos comprueban además el cambio de dominio y de IP de la
   plataforma (sección 8.3: confirmación, certificado del motor al nombre
   nuevo, identidad adoptada en el panel, registros A), el PTR consultado en
   dos resolutores, el aviso de las imágenes no descargadas, los «Siguientes
   pasos» del resumen y lo que revisa `--comprobar`.
2. **Con contenedores reales** (`deploy/prueba-stack.py`): monta con
   `deploy/instalar.sh --actualizar` Stalwart v0.15.5, Roundcube y el
   extractor con la topología de producción (subred interna fija, un Skyway
   simulado con certificados de laboratorio y credenciales desechables) y
   comprueba que el extractor sustituye al volcado antiguo sin dejar claves de
   otros dominios, el TLS de 993 y 465, el inicio de sesión IMAP desde el
   webmail y directo, la autenticación SMTP en 465 y 587 (sin enviar correo),
   la renovación y el paso a un comodín, `--comprobar` (con
   `MAILWAY_COMPROBAR_SOLO_MOTOR=1`: no hay panel ni DNS público) y
   `--probar-acceso`.
   El Skyway simulado no tiene el contenedor `skyway` ni panel desplegado:
   la prueba recorre el camino en el que el instalador no despliega el panel
   ni empareja, y comprueba que eso no interrumpe la instalación. El
   emparejado se prueba en `deploy/prueba-emparejado.sh` (el instalador),
   `server/test/emparejar.test.ts` (la herramienta del panel) y las pruebas
   de las herramientas de Skyway.

Las pruebas unitarias se ejecutan en cualquier equipo con Python 3 y openssl.
La prueba de la pila crea y borra contenedores, redes y volúmenes con los
nombres de Mailway: solo se ejecuta con `MAILWAY_PRUEBA_DESECHABLE=1`, se
niega si encuentra restos de Mailway o de Skyway y nunca debe lanzarse en un
servidor con datos.
