# Bulwark en Mailway (correo web «beta» por cliente)

[Bulwark](https://github.com/bulwarkmail/webmail) es un correo web JMAP
(Next.js, AGPL-3.0) que Mailway ofrecerá como opción por cliente. Roundcube
sigue siendo el predeterminado. Esta carpeta reúne las piezas de despliegue;
el servicio todavía no está en los ficheros Compose ni en el instalador.

- Versión fijada: **1.13.0**
  (`ghcr.io/bulwarkmail/webmail:1.13.0@sha256:cc85f569396b6eb1d3f8cf41311b7512cf6b943fa28a8844a27edaeb2daae1ed`).
  En Docker Hub no hay imagen oficial: solo copias de terceros.
- Necesita **Stalwart 0.16.6 o posterior** (ensayado con 0.16.25). Con el motor
  0.15.5 no funciona.

## Cómo encaja

```
Navegador ──HTTPS──▶ Traefik ──▶ mailway-bulwark-gw :8080 (nginx) ──▶ mailway-bulwark :3000
    │                                                                    │ comprobaciones de acceso
    │                                                                    ▼ (red interna exenta)
    └──JMAP con CORS──▶ Traefik ──▶ mailway-mail :8080          https://MAIL_HOSTNAME → 10.203.53.10:443
Panel ──http://mailway-bulwark:3000/api/admin──▶ marca por dominio y política
```

- **La aplicación** (páginas, ajustes del usuario) pasa por la pasarela.
- **El correo no pasa por Bulwark**: el navegador habla JMAP directamente con
  el motor en `https://MAIL_HOSTNAME`, otro origen. Por eso el motor necesita
  CORS permisivo y el correo y sus adjuntos no cuentan para los límites de
  la pasarela.
- **Bulwark comprueba contraseñas desde el servidor** (antes del acceso y al
  crear su sesión). Esas peticiones salen de su contenedor: tiene que llegar al
  motor por la red interna, la exenta del bloqueo automático, o el motor lo
  bloquearía a la primera oleada de contraseñas erróneas. `JMAP_SERVER_URL` es
  la dirección pública (el navegador también la usa), así que el contenedor
  resuelve `MAIL_HOSTNAME` a la IP interna del motor con `extra_hosts` y
  entra por su 443, que sirve el certificado de `MAIL_HOSTNAME`.
- **El panel aplica la marca de cada cliente** con la API de administración de
  Bulwark, directamente por la red interna (la pasarela la cierra).

## Ficheros

| Fichero | Qué es |
|---|---|
| `nginx/nginx.conf` | Configuración de la pasarela (ver «Pasarela»). |
| `nginx/cloudflare.conf` | Rangos de Cloudflare para la pasarela. **Generado**: no se edita. |
| `cloudflare/rangos.txt` | Fuente única de los rangos de Cloudflare (IPv4 e IPv6). |
| `cloudflare/generar.sh` | Regenera `nginx/cloudflare.conf`; `--comprobar` falla si no está al día. |
| `bulwark.env` | Valores fijos de Mailway para Bulwark (`env_file`). |
| `marca/mailway/` | Logotipo y favicon de la instancia, montados en `/app/public/branding/mailway`. |
| `prueba.sh` | Ensayo con contenedores reales (ver «Ensayo»). |
| `prueba-navegador.cjs` | Parte del ensayo con un Chromium real (Playwright), opcional. |

La lógica del panel está en `server/src/modules/bulwark.ts` (marca por
dominio, política, huella y cliente de la API de administración) y sus
pruebas en `server/test/bulwark.test.ts`. Esas pruebas también exigen que
`cloudflare/rangos.txt` coincida con los rangos de
`deploy/roundcube/mailway.php` y de `server/src/modules/whitelabel.ts`, y que
este README, `prueba.sh` y `bulwark.env` fijen lo mismo.

## Servicio de referencia

Lo que llevará `docker-compose.mail.yml` (y, con `mailway-edge` en lugar de
`skyway-edge`, el autónomo). Es la misma configuración que levanta el ensayo.

```yaml
  mailway-bulwark:
    image: ghcr.io/bulwarkmail/webmail:1.13.0@sha256:cc85f569396b6eb1d3f8cf41311b7512cf6b943fa28a8844a27edaeb2daae1ed
    container_name: mailway-bulwark
    restart: unless-stopped
    env_file: ./bulwark/bulwark.env
    environment:
      JMAP_SERVER_URL: https://${MAIL_HOSTNAME}
      # ≥ 32 caracteres y fijo: rotarlo cierra todas las sesiones y deja
      # ilegibles los ajustes sincronizados (van cifrados con él).
      SESSION_SECRET: ${BULWARK_SESSION_SECRET:?Define BULWARK_SESSION_SECRET en deploy/.env}
      # Solo se lee en el primer arranque (ver «Secretos»).
      ADMIN_PASSWORD: ${BULWARK_ADMIN_PASSWORD:?Define BULWARK_ADMIN_PASSWORD en deploy/.env}
      APP_NAME: ${MAILWAY_BRAND:-Webmail}
      LOGIN_WEBSITE_URL: ${MAILWAY_PANEL_URL:-}/mi-buzon
    extra_hosts:
      # Las comprobaciones de acceso de Bulwark, siempre por la subred exenta.
      - ${MAIL_HOSTNAME}:${MAILWAY_MAIL_INTERNAL_IP:-10.203.53.10}
    read_only: true
    tmpfs:
      - /tmp:size=64m
      - /app/.next/cache:size=64m,uid=1001,gid=1001
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    volumes:
      - mailway-bulwark-ajustes:/app/data/settings
      - mailway-bulwark-admin:/app/data/admin
      - mailway-bulwark-estado:/app/data/admin-state
      - ./bulwark/marca/mailway:/app/public/branding/mailway:ro
    networks:
      - mailway-internal   # el motor, desde la subred exenta
      - skyway-edge        # la pasarela y el panel (API de administración)
    depends_on:
      mailway-mail:
        condition: service_healthy
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:3000/api/health']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s

  mailway-bulwark-gw:
    image: nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94
    container_name: mailway-bulwark-gw
    restart: unless-stopped
    command: ['nginx', '-c', '/etc/nginx/mailway/nginx.conf', '-g', 'daemon off;']
    user: '101:101'
    read_only: true
    tmpfs:
      - /tmp:size=64m
    cap_drop: [ALL]
    security_opt: ['no-new-privileges:true']
    volumes:
      - ./bulwark/nginx:/etc/nginx/mailway:ro
    networks:
      - skyway-edge
    labels:
      # Huella de deploy/bulwark/nginx/* (la pone el instalador): nginx no
      # relee su configuración solo; si cambia, Compose recrea la pasarela.
      - mailway.bulwark-gw-config=${MAILWAY_BULWARK_GW_HASH:-}
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:8081/salud']
      interval: 30s
      timeout: 5s
      retries: 3
```

Sin etiquetas de Traefik: los nombres `webmail.<dominio>` de los clientes que
usan Bulwark los publica el panel en `/api/traefik/config` con el destino
`http://mailway-bulwark-gw:8080` (el puente de Skyway admite `http://mailway-*`).
Bulwark no tiene ruta pública propia.

Bulwark también está en `skyway-edge` para que el panel (que despliega Skyway)
llegue a su API de administración. Cualquier otro contenedor de esa red
llega a él sin pasar por la pasarela: la administración sigue protegida por
`ADMIN_PASSWORD` (5 intentos por IP y 50 en total cada 15 minutos), igual que la API del
motor lo está por la suya.

## Secretos

- `BULWARK_SESSION_SECRET`: 32 bytes aleatorios en hexadecimal, generado una
  vez por el instalador, como `ROUNDCUBE_DES_KEY`. Cifra las cookies de sesión
  (con la contraseña del buzón dentro) y los ajustes sincronizados. Quien tenga
  este secreto y una cookie robada recupera la contraseña: se guarda como el
  resto de `deploy/.env`.
- `BULWARK_ADMIN_PASSWORD`: aleatoria, solo la conocen el panel y Bulwark.
  **Bulwark la lee una sola vez**: en el primer arranque guarda su hash en
  `admin.json` (volumen `mailway-bulwark-admin`) y después ignora la variable.
  Para cambiarla hay que borrar ese fichero y reiniciar:
  `docker run --rm -v mailway-bulwark-admin:/a alpine rm /a/admin.json && docker restart mailway-bulwark`.
  Si no coinciden, el panel lo dice con el error `bulwark_credenciales`.

## Valores de `bulwark.env`

| Variable | Valor | Por qué |
|---|---|---|
| `STALWART_FEATURES` | `false` | Sin pestaña Seguridad: contraseña, contraseñas de aplicación y 2FA siguen en «Mi buzón», que conserva las contraseñas de aplicación, limpia enlaces y sesiones del portal y deja auditoría. |
| `STALWART_JMAP_PASSTHROUGH_ENABLED` | `false` | Cierra `/api/account/stalwart/jmap`, el paso a los métodos `x:` con la sesión del usuario (la pasarela también lo cierra). |
| `LOGIN_SHOW_TOTP`, `LOGIN_SHOW_TOKEN_LOGIN` | `false` | Mailway no usa 2FA del motor ni acceso con token. |
| `STALWART_ADMIN_ACCESS` | `off` | Ser administrador del motor no abre la administración de Bulwark: solo `ADMIN_PASSWORD`. |
| `ALLOW_CUSTOM_JMAP_ENDPOINT`, `OAUTH_ENABLED` | `false` | Un único servidor JMAP, el de la instalación. |
| `BULWARK_TELEMETRY`, `BULWARK_UPDATE_CHECK`, `CONNECTOR_ENABLED` | `off`/`false` | Nada hacia servicios de Bulwark. Las versiones se actualizan con `mailway update`. |
| `SEARCH_ENGINE_INDEXING`, `LOGIN_SHOW_VERSION` | `false` | Sin indexación ni versión a la vista de quien no ha entrado. |
| `TRUSTED_PROXY_DEPTH` | `1` | La pasarela entrega una sola IP, la real. |
| `COOKIE_SECURE`, `COOKIE_SAME_SITE` | `true`, `lax` | Siempre HTTPS; `lax` deja llegar desde el enlace del portal con la sesión. |
| `SETTINGS_SYNC_ENABLED` | `true` | Ajustes del usuario en el servidor, cifrados con `SESSION_SECRET`. |
| `LOG_FORMAT`, `LOG_LEVEL` | `json`, `info` | Registro estructurado. |
| `VERSION_CHECK_DATA_DIR`, `TELEMETRY_DATA_DIR` | `/tmp/…` | Con la raíz en solo lectura; sin esto, `/api/system/update-status` responde 500. |
| `APP_SHORT_NAME`, `FAVICON_URL`, `PWA_ICON_URL`, `APP_LOGO_*`, `LOGIN_LOGO_*` | marca de Mailway | Sin ellos se verían el logotipo y el favicon de Bulwark en cualquier nombre sin marca propia. |

No se fija `PWA_THEME_COLOR`: sin él, Bulwark ajusta el color de la barra del
navegador al tema claro u oscuro.

Lo que no se puede configurar en 1.13: el idioma por defecto cuando el
navegador no pide uno conocido es el inglés (solo cambia compilando la imagen
con `NEXT_PUBLIC_DEFAULT_LOCALE=es`); el registro de los textos en español
mezcla «tú» y «usted»; «Bulwark» aparece en algunos textos.

## Pasarela

Lo que hace `nginx/nginx.conf`, comprobado en el ensayo:

- **404** en `/admin`, `/setup`, `/api/admin`, `/api/setup`, `/api/auth/impersonate`
  (suplantación con JWT), `/api/account` (métodos `x:` de Stalwart) y
  `/api/dev-jmap`, sin distinguir mayúsculas y sobre la ruta normalizada
  (`/api/%61dmin`, `//admin` y `/admin/../admin` también). También en
  peticiones con la cabecera `Next-Action` (acciones de servidor de Next.js,
  que se invocan desde cualquier ruta; Bulwark 1.13 no tiene ninguna).
- Excepciones de solo lectura (GET y HEAD) que el correo web necesita y que
  Bulwark deja públicas por diseño: `/api/admin/policy` (sin ella el
  navegador vuelve a la política por defecto y pierde la de Mailway),
  `/api/admin/branding/<fichero>` (recursos de marca subidos) y
  `/api/admin/themes/<id>/css`.
- **404 en `/api/favicon` y `/api/translate`**: el servidor de Bulwark pediría
  el favicon a cada dominio que escribe a un buzón (el remitente sabría cuándo
  se ve su correo) y la traducción va a MyMemory. La política de 1.13 no puede
  apagarlos. Sin favicon, Bulwark muestra las iniciales.
- **IP real**: Bulwark recibe una sola IP en `X-Forwarded-For` y `X-Real-IP`.

  | Petición que llega de Traefik | IP para Bulwark |
  |---|---|
  | Último salto ajeno a Cloudflare | ese salto (lo escribe Traefik) |
  | Último salto de Cloudflare con un salto anterior (Traefik con `trustedIPs`) | el salto anterior |
  | Último salto de Cloudflare, sin salto anterior (Traefik de Skyway) | `CF-Connecting-IP` |
  | Último salto de Cloudflare sin datos del visitante | el nodo de Cloudflare |
  | Conexión desde fuera de las redes de Docker | la suya, sin creer cabeceras |

  `CF-Connecting-IP`, `Forwarded` y `True-Client-IP` no llegan a Bulwark.
  `Host` y `X-Forwarded-Host` pasan tal cual: Bulwark elige la marca por el
  nombre y compara el origen con él. Cualquier contenedor de las redes de
  Docker se trata como Traefik (no hay forma de distinguirlos), igual que en
  `roundcube/mailway.php`.
- **Límite en las comprobaciones de credenciales** (`POST`/`PUT` en
  `/api/auth/*`): 20 por minuto y ráfagas de 40 por IP real, 180 por minuto en
  toda la instancia. `/api/auth/stalwart-context` y `/api/auth/session`
  comprueban la contraseña desde Bulwark (red exenta) sin ningún límite propio:
  sin la pasarela son un oráculo de contraseñas (ensayo: 40 de 40 intentos
  contestados). Las lecturas no gastan.
- HSTS de un año (sin `includeSubDomains`: el dominio es del cliente), sin
  `X-Powered-By`, cuerpos de hasta 30 MB, tiempos de 60 a 120 s, búferes
  para la CSP de Bulwark y sus cookies.
- Registro de acceso en JSON con la IP real y la ruta **sin la cadena de
  consulta** (el acceso con token y la vuelta de OAuth llevan secretos en
  ella), sin cabeceras.
- `127.0.0.1:8081/salud`, solo dentro del contenedor, para el healthcheck.

Los rangos de Cloudflare se cambian en `cloudflare/rangos.txt` y se regeneran
con `bash deploy/bulwark/cloudflare/generar.sh`; las pruebas fallan si
`nginx/cloudflare.conf`, `mailway.php` o `whitelabel.ts` no coinciden.

## Marca

- **De la instancia** (cualquier nombre sin marca propia): `marca/mailway/`,
  montada en `/app/public/branding/mailway`, y `APP_NAME` desde
  `MAILWAY_BRAND`. Para usar otra, se monta otra carpeta o se cambian las
  `*_URL` en el compose.
- **De cada cliente**: el panel calcula `domainBranding` con
  `marcaPorHostBulwark()` (nombre, empresa, logotipos claro y oscuro, favicon,
  icono, colores, enlace a «Mi buzón», privacidad y aviso legal) y la aplica
  con `ClienteAdminBulwark.aplicarMarca()`, que solo escribe si cambia. Bulwark
  la aplica al momento, sin reiniciar. Solo nombres exactos (sin comodines,
  que alcanzarían a otros clientes) y solo direcciones `https://` o rutas de
  `/branding/` y `/api/admin/branding/`.
- **Dónde viven los logotipos de cada cliente**: Next.js solo sirve los
  ficheros de `public/` que existen al arrancar (comprobado: uno añadido
  después da 404), así que no sirve una carpeta compartida. O los sirve el
  panel por `https://` (la CSP de Bulwark admite imágenes `https:`; para el
  icono de la aplicación, Bulwark descarga la imagen desde el servidor y solo
  de direcciones públicas), o se suben a Bulwark con su API
  (`POST /api/admin/branding`, multipart con `host` y `slot`) y se enlazan como
  `/api/admin/branding/<fichero>`, del mismo origen que cada webmail.
- No hay color de acento ni tema por cliente: el tema es de toda la instancia.

## Política

`politicaBulwark()` la deja entera (se envía con `PUT`) y todos los
interruptores explícitos:

| Interruptor | Valor | Por qué |
|---|---|---|
| `pluginsEnabled`, `pluginsUploadEnabled` | no | Código de terceros en el origen del correo web. |
| `userThemesEnabled` | no | CSS que sube cada usuario. |
| `sidebarAppsEnabled` | no | Apps propias de cada usuario en un marco (amplían la CSP). Las fijas de la política siguen. |
| `debugModeEnabled` | no | Herramientas de depuración para usuarios finales. |
| `filesEnabled` | no (opción) | Archivos del motor: ocupan la cuota del buzón. |
| `calendarEnabled`, `calendarTasksEnabled`, `contactsEnabled` | sí (opción) | Calendario y contactos del motor (JMAP/CalDAV/CardDAV). |
| resto | valor de Bulwark | Plantillas, S/MIME, etiquetas, temas incluidos… |
| `defaultSidebarApps` | «Mi buzón» | Enlace al panel en la barra lateral, en otra pestaña. Es de toda la instancia (la política no es por nombre): el enlace de cada cliente es el del pie del acceso. |
| `pushRelayUrl` | vacío (opción) | Sin relé propio, quien active las notificaciones del navegador las recibe por el relé alojado de Bulwark (ve la suscripción y los identificadores de lo que cambia, no el contenido). Con `relePush` se fija uno propio. |

`defaults` (`senderFavicons: false`) se guarda pero **Bulwark 1.13 no lo
aplica** (comprobado en el código y en el ensayo); por eso la pasarela corta
`/api/favicon`.

## Lo que necesita del motor (Stalwart 0.16)

Todo comprobado en el ensayo con Stalwart 0.16.25:

- `Http.usePermissiveCors = true`: sin él, el navegador no puede hablar JMAP
  desde `webmail.<dominio>`. Es global (`Access-Control-Allow-Origin: *`),
  **sin** `Access-Control-Allow-Credentials`: las cookies no viajan a otro
  origen y JMAP se autentica con la cabecera `Authorization`. Se aplica con
  `ReloadSettings`, sin reiniciar.
- `Http.useXForwarded = true` y `AllowedIp` con la subred interna (ya los
  aplica Mailway para Roundcube).
- El certificado de `MAIL_HOSTNAME` en el 443 del motor (`Certificate` y
  `SystemSettings.defaultCertificateId`, `ReloadTlsCertificates`), para que
  Bulwark lo verifique por la red interna. Con el autofirmado, sus
  comprobaciones dan «inconclusive» y el navegador comprueba por su cuenta.
- **Retirar la cabecera `Forwarded` en el router de Traefik del motor**
  (middleware `headers.customRequestHeaders.Forwarded=""`). Stalwart, con
  `useXForwarded`, lee `Forwarded: for=` antes que `X-Forwarded-For`, de
  cualquiera; Traefik reescribe `X-Forwarded-For` pero deja pasar `Forwarded`.
  Sin el middleware, cualquiera puede decir que viene de la red exenta y
  probar contraseñas contra `https://MAIL_HOSTNAME` sin bloqueo (comprobado:
  12 fallos sin bloqueo frente a bloqueo al pasar el umbral con el
  middleware). Stalwart 0.15.5 lee las cabeceras igual: afecta también a la
  instalación actual con Roundcube.
- Los fallos desde la red exenta **no cuentan para el buzón**: Stalwart cuenta
  los fallos por IP y por nombre de acceso, pero si la IP está exenta no cuenta
  ninguno de los dos. Los fallos que llegan por Bulwark solo los limitan
  Bulwark y la pasarela. Los del navegador (JMAP directo) sí cuentan, por IP y
  por buzón: pasado el umbral de un buzón, cualquier IP nueva que falle con él
  queda bloqueada al primer intento.
- Bloqueo por fallos **con caducidad** (`Security.authBanPeriod`): por defecto
  es para siempre. Con Bulwark los usuarios entran desde su IP real (con
  Roundcube no) y una pestaña abierta tras cambiar la contraseña llegó en el
  ensayo a unos 30 fallos por minuto (ver «Riesgos»).

## Frente a Roundcube

Se pierde:

- La caducidad de la sesión por inactividad (Bulwark no la aplica) y el aviso
  claro de contraseña cambiada (`mailway_sesion`): Bulwark muestra «Conexión
  perdida. Intentando reconectar…» y sigue reintentando.
- El cambio de contraseña dentro del correo web: se hace en «Mi buzón».
- Los avatares de compañeros del mismo cliente y el nombre visible del panel
  en cada acceso (la identidad JMAP toma el nombre solo al crearse).
- Los favicons de los remitentes (la pasarela los corta).
- Libretas, identidades y firmas de Roundcube: no pasan solas.
- El español por defecto para navegadores en otro idioma y un registro
  uniforme de los textos.
- Una superficie más simple: Roundcube entra por IMAP desde la red exenta y
  nada más; Bulwark añade CORS global en el motor, JMAP desde Internet y un
  contenedor más (la pasarela).
- Personalizaciones privadas: con AGPL, modificar Bulwark obliga a publicar
  el código a sus usuarios (se usa sin modificar; configurar no es modificar).

Se gana:

- Marca por cliente en el mismo servicio (nombre, logotipos, favicon, enlaces),
  aplicada en caliente desde el panel.
- Calendario, contactos y (si se activan) archivos del motor, compartidos con
  los dispositivos; push en tiempo real; aplicación instalable (PWA).
- Interfaz actual: hilos, varias cuentas, plantillas, envío programado,
  S/MIME, aviso de remitente sin verificar.
- CSP estricta con nonce y el correo HTML en un marco aislado.
- El bloqueo por IP real del navegador en el motor, que con Roundcube no
  existía (todo llegaba desde la red exenta).

## Riesgos conocidos

Comprobados en el ensayo salvo que se diga otra cosa:

1. **Pestaña abierta tras cambiar la contraseña**: Bulwark no vuelve al
   acceso; reintenta con la contraseña vieja desde la IP del usuario. Primero
   ráfagas de unos 5 fallos cada 1–2 minutos y, a los 3 minutos, unos 3 cada 3
   segundos (150 en 5 minutos). Con el umbral por defecto del motor (100 al
   día, bloqueo para siempre) la IP del usuario —una oficina entera tras NAT,
   también para IMAP y SMTP— queda bloqueada en minutos, y el contador del
   buzón bloquea al primer fallo cualquier otra IP suya con la contraseña
   vieja. Antes de ofrecer la beta: caducidad del bloqueo en el motor y aviso
   en «Mi buzón» de cerrar el correo web abierto; para hacerlo predeterminado,
   que Bulwark deje de reintentar tras un 401 (petición a Bulwark).
2. **Oráculo de contraseñas** en `/api/auth/stalwart-context` y
   `/api/auth/session` (sin límite en Bulwark y desde la red exenta). Lo
   frena la pasarela; conviene pedir a Bulwark que aplique a esas rutas el
   presupuesto de `/api/auth/verify`.
3. **Presupuesto global de comprobaciones**: con 30 contraseñas erróneas cada
   15 minutos, cualquiera deja `/api/auth/verify` en «inconclusive» para todos;
   el acceso sigue funcionando (el navegador comprueba por su cuenta).
4. **Cabecera `Forwarded`** hasta el motor (ver «Lo que necesita del motor»).
5. **CORS global** en el motor para cualquier origen. Sin credenciales por
   cookie, el riesgo es el de cualquier cliente JMAP en el navegador.
6. **API de administración sin contrato documentado**: la marca depende de
   `PATCH /api/admin/config` y `PUT /api/admin/policy`. Cada versión nueva pasa
   por el ensayo.
7. **Madurez**: versiones semanales, avisos de seguridad recientes (XSS por
   correo HTML corregido en 1.10.0) y la contraseña del buzón en la memoria de
   la pestaña: un XSS la expone. La CSP con nonce lo mitiga.
8. **Licencia AGPL-3.0**: imagen sin modificar y configurada; cualquier
   parche obligaría a ofrecer el código (`SOURCE_CODE_URL`).

## Actualizar Bulwark

1. Leer la sección «Security» del CHANGELOG de cada versión intermedia.
2. Buscar rutas nuevas de administración o equivalentes
   (`app/api/**/route.ts`, `app/(main)/**/page.tsx`), rutas nuevas que
   comprueben contraseñas desde el servidor y acciones de servidor
   (`'use server'`): la pasarela solo bloquea lo que conoce.
3. Revisar las variables nuevas (`lib/admin/types.ts`, `CONFIG_ENV_MAP`), los
   interruptores nuevos de la política (`FeatureGates`) y si `domainBranding`
   cambia de forma (`lib/admin/domain-branding.ts`).
4. Cambiar la etiqueta y el digest en este README y en `prueba.sh` (las
   pruebas exigen que coincidan) y en los compose.
5. Ejecutar el ensayo, también con `MWB_PESTANA_SEGUNDOS`.

## Ensayo

```bash
bash deploy/bulwark/prueba.sh               # ≈ 3 minutos; código 1 si algo falla
bash deploy/bulwark/prueba.sh --conservar   # deja la pila en marcha para mirarla
bash deploy/bulwark/prueba.sh --retirar     # retira una pila conservada
MWB_PLAYWRIGHT=/ruta/a/node_modules/playwright MWB_PESTANA_SEGUNDOS=300 bash deploy/bulwark/prueba.sh
```

Levanta Stalwart 0.16.25 (arranque inicial por JMAP, dominio y buzones con
hash `$6$`), Bulwark y la pasarela tal como en «Servicio de referencia»,
Traefik 3.7 como el de Skyway y un eco que devuelve las cabeceras que le
llegan. Un contenedor con una IP de un rango de Cloudflare hace de nodo de
Cloudflare. Comprueba la salud y las cabeceras; el bloqueo de la
administración; la marca y la política aplicadas con el cliente del panel
(dos veces, la segunda sin escribir) y visibles por nombre; el acceso con
contraseña buena y mala y la lectura de la bandeja por JMAP con CORS; la IP
real en todos los casos de la tabla; el bloqueo del motor (IP de control
bloqueada, Bulwark no, cómo cuenta por buzón); el oráculo y su límite; la
cabecera `Forwarded`; límites y registros sin secretos. Con Playwright añade
un Chromium real (acceso, bandeja, «Mi buzón», sin pestaña Seguridad, sin
violaciones de la CSP ni peticiones a terceros) y, con
`MWB_PESTANA_SEGUNDOS`, la medida de la pestaña abierta.

Necesita docker, curl, jq, openssl y node con las dependencias del
repositorio. Solo crea contenedores, redes y volúmenes `mwb-*` con la etiqueta
`mailway.ensayo=bulwark`, publica puertos de `127.0.0.1:22000-22999` y lo
retira todo al terminar. Si Docker Hub limita las descargas, usa el espejo
`mirror.gcr.io` con el mismo digest. Las subredes se cambian con
`MWB_SUBRED_*` si chocan con otras.

No cubre: redactar y enviar, filtros, «Fuera de la oficina» y notificaciones
push en el navegador; Cloudflare real; el puente de Traefik de Skyway.
