#!/usr/bin/env bash
# ============================================================================
# Instalador de Mailway
# ----------------------------------------------------------------------------
# Deja en marcha el motor de correo (Stalwart), el webmail (Roundcube) y, si
# se dispone de Skyway, el panel de Mailway desplegado desde GitHub. Es
# idempotente: puede ejecutarse tantas veces como haga falta y reutiliza la
# configuración y los secretos de deploy/.env.
#
# Uso:
#   sudo bash deploy/instalar.sh                 # junto a Skyway (recomendado)
#   sudo bash deploy/instalar.sh --sin-skyway    # todo en un compose propio
#   sudo bash deploy/instalar.sh --actualizar    # reaplicar sin preguntas
#   sudo bash deploy/instalar.sh --comprobar     # diagnóstico de solo lectura
#   sudo bash deploy/instalar.sh --probar-acceso # abrir un buzón desde el webmail
#   sudo bash deploy/instalar.sh --emparejar     # repetir solo el emparejado con Skyway
#   bash deploy/instalar.sh --ayuda
#
# Ejecución desatendida: todas las preguntas se pueden responder con
# variables de entorno (ver --ayuda). Sin terminal interactiva, el
# instalador no pregunta y usa esas variables o los valores por defecto.
# ============================================================================
# Los «$t» y «$n» entre comillas simples son variables de jq, no de bash.
# shellcheck disable=SC2016
set -euo pipefail

VERSION_INSTALADOR="1.3.0"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$RAIZ/deploy"
ENV_FILE="${MAILWAY_ENV_FILE:-$DEPLOY_DIR/.env}"
COMPOSE_MAIL="$DEPLOY_DIR/docker-compose.mail.yml"
COMPOSE_SOLO="$DEPLOY_DIR/docker-compose.standalone.yml"
IMAGEN_CURL="curlimages/curl:8.11.1"
# Huella de la configuración de Roundcube: la etiqueta del webmail en los
# compose la usa para que Compose lo recree cuando cambia mailway.php.
MAILWAY_ROUNDCUBE_CONFIG_HASH=$(sha256sum "$DEPLOY_DIR/roundcube/mailway.php" 2>/dev/null | cut -c1-16 || true)
export MAILWAY_ROUNDCUBE_CONFIG_HASH
IMAGEN_JQ="ghcr.io/jqlang/jq:1.7.1"
# Diagnóstico del webmail: deploy/roundcube/diagnostico, que los compose montan en /opt/mailway.
COMPROBAR_PHP="/opt/mailway/comprobar.php"
LE_DIRECTORIO="https://acme-v02.api.letsencrypt.org/directory"

CON_SKYWAY=1
CON_CLOUDFLARE=1
ACTUALIZAR=0
COMPROBAR=0
PROBAR_ACCESO=0
EMPAREJAR=0
INTERACTIVO=0
if [ -t 0 ] && [ -t 1 ]; then INTERACTIVO=1; fi

# Resultado de la última petición HTTP (ver peticion_http).
RESP_CODE=""
RESP_BODY=""

# Estado para el resumen final.
RESUMEN_CERT="pendiente"
RESUMEN_PTR="sin comprobar"
RESUMEN_P25="sin comprobar"
RESUMEN_DNS="sin comprobar"
RESUMEN_SKYWAY="no se ha desplegado el panel"
MIGRAR_CONTENEDORES=0
ENV_COPIADO=0
CERT_CONFIGURADO=0
SKYWAY_VERSION=""
PANEL_CONTENEDOR=""
CF_TOKEN=""
CF_ZONA_ID=""
CF_ZONA_NOMBRE=""
# Qué ha pasado con la cuenta de Cloudflare del operador en el panel y en
# Skyway (ver conectar_cloudflare_en_panel); vacío = no se ha intentado.
RESUMEN_CF_PANEL=""
RESUMEN_CF_SKYWAY=""
CF_PANEL_CONECTADA=0

# Emparejado con Skyway (ver emparejar_con_skyway).
ADMIN_EMAIL=""
PANEL_SERVICIO_ID=""
PANEL_PROYECTO_ID=""
# Panel que Skyway ya despliega (ver detectar_panel_existente): servicio,
# contenedor, nombre público y lo que interesa de su entorno en ejecución.
PANEL_EXISTENTE_SERVICIO=""
PANEL_EXISTENTE_CONTENEDOR=""
PANEL_EXISTENTE_HOST=""
declare -A PANEL_EXISTENTE_ENV=()
# Servicio de Skyway que se actualiza en lugar de crear otro: «proyecto
# slug-del-proyecto servicio slug-del-servicio» (ver localizar_panel_en_skyway).
PANEL_ADOPTADO=""
# 1 si quien instala ha dicho que el panel detectado no es el de esta instalación,
# y el servicio de Skyway de ese panel (no se reutiliza por su nombre).
PANEL_SIN_ADOPCION=0
PANEL_RECHAZADO=""
# 1 si SKYWAY_URL la fijó preparar_api_skyway_en_silencio (no la indicó nadie).
SKYWAY_URL_AUTOMATICA=0
# 1 si deploy/.env guarda el MAILWAY_TRAEFIK_TOKEN que usa el panel. Un panel
# anterior a la 1.0 lo tiene en su base de datos, no en sus variables: el del
# instalador no le sirve (ver la fusión de variables en desplegar_en_skyway).
TRAEFIK_TOKEN_PROPIO=1
SKY_TOKEN_TEMPORAL_ID=""
RESUMEN_EMPAREJADO="sin emparejar: no se ha desplegado el panel"
EMPAREJADO_OK=0
EMPAREJADO_ADMIN_EMAIL=""
# La contraseña del administrador que crea el emparejado: solo vive en esta
# variable hasta que el resumen la muestra (una vez) y la borra.
EMPAREJADO_ADMIN_PASSWORD=""
# Ficheros temporales que hay que borrar al salir, pase lo que pase.
ENV_TMP=""
ERR_TMP=""
# ¿Escribió avisos la última herramienta de terminal? (ver mostrar_errores_herramienta)
HERRAMIENTA_CON_AVISOS=0

# ------------------------------------------------------------------ salida --

if [ -t 1 ]; then
  C_TIT=$'\033[1m'; C_OK=$'\033[32m'; C_AV=$'\033[33m'; C_ER=$'\033[31m'; C_0=$'\033[0m'
else
  C_TIT=""; C_OK=""; C_AV=""; C_ER=""; C_0=""
fi

titulo() { printf '\n%s== %s ==%s\n' "$C_TIT" "$*" "$C_0"; }
info() { printf '   %s\n' "$*"; }
ok() { printf '   %s[ok]%s %s\n' "$C_OK" "$C_0" "$*"; }
aviso() { printf '   %s[aviso]%s %s\n' "$C_AV" "$C_0" "$*" >&2; }
fallo() {
  printf '\n   %s[error]%s %s\n' "$C_ER" "$C_0" "$*" >&2
  exit 1
}

ayuda() {
  cat <<'AYUDA'
Instalador de Mailway

Uso: sudo bash deploy/instalar.sh [opciones]

Opciones:
  --sin-skyway      Instala panel, motor y webmail con docker-compose.standalone.yml,
                    con un Traefik propio en 80/443 si esos puertos están libres.
  --sin-cloudflare  No usa la API de Cloudflare: los registros DNS se crean a mano.
  --actualizar      Reaplica la configuración existente (deploy/.env) sin preguntas:
                    descarga imágenes, recrea contenedores, reaplica los ajustes del
                    motor y, con Skyway, actualiza las variables y redespliega el panel.
                    Mantiene el modo de la instalación (junto a Skyway o autónoma).
                    Ejecuta antes «git pull» en la carpeta de Mailway.
  --comprobar       Diagnóstico de solo lectura: contenedores, ajustes y certificado del
                    motor (993 y 465), conexión IMAP y SMTP desde el webmail y extractor
                    del certificado. No cambia nada. Código de salida 1 si algo falla.
  --probar-acceso   Pide la dirección y la contraseña de un buzón (sin mostrarla ni
                    guardarla) e inicia sesión desde el webmail: un único intento, porque
                    cada contraseña incorrecta cuenta para el bloqueo automático del motor.
  --emparejar       Repite solo el emparejado del panel con Skyway con la configuración de
                    deploy/.env: crea el administrador del panel si aún no existe, completa su
                    puesta en marcha y conecta Skyway con un token de gestión nuevo.
  --ayuda           Muestra esta ayuda.

Junto a Skyway, el instalador termina emparejando el panel con Skyway: crea la cuenta de
administración del panel (su contraseña se muestra una sola vez en el resumen), completa
la puesta en marcha y conecta Skyway → Ajustes → Correo (Mailway) sin pasos manuales.
Si el emparejado falla, la instalación no se interrumpe: repítelo con --emparejar.

Con un token de Cloudflare, el instalador lo pasa también al panel (como cuenta de la
instancia) y a Skyway por la entrada estándar de sus herramientas: los dominios que da de
alta el administrador configuran su DNS solos, sin modificar los registros existentes. Las
acciones de los clientes nunca usan esa cuenta. El token no se guarda en deploy/.env:
--actualizar sin CLOUDFLARE_API_TOKEN y --emparejar (que nunca lo usa, ni con esa variable)
no lo tienen y no tocan la cuenta que hubiera conectada; con un token nuevo en
CLOUDFLARE_API_TOKEN, --actualizar lo sustituye en esa cuenta.

Los secretos (CLOUDFLARE_API_TOKEN, SKYWAY_TOKEN, STALWART_ADMIN_PASSWORD) nunca se escriben en
la orden: delante de sudo («sudo CLOUDFLARE_API_TOKEN=… bash …») quedan a la vista en «ps»
mientras dura la instalación. Léelos sin mostrarlos y pásalos por el entorno:
  read -rs CLOUDFLARE_API_TOKEN; export CLOUDFLARE_API_TOKEN
  sudo --preserve-env=CLOUDFLARE_API_TOKEN bash deploy/instalar.sh --actualizar

Variables de entorno (ejecución desatendida):
  MAILWAY_DOMINIO           Dominio base (mail., webmail. y panel. cuelgan de él).
  MAILWAY_MAIL_HOST         Nombre del servidor de correo (por defecto mail.<dominio>).
  MAILWAY_WEBMAIL_HOST      Nombre del webmail (por defecto webmail.<dominio>).
  MAILWAY_PANEL_HOST        Nombre del panel (por defecto panel.<dominio>).
  MAILWAY_IP                IPv4 pública del servidor (se detecta si falta).
  MAILWAY_MARCA             Nombre del servicio en el webmail (por defecto «Webmail»).
  LETSENCRYPT_EMAIL         Correo de contacto para Let's Encrypt.
  CLOUDFLARE_API_TOKEN      Token de Cloudflare (Zona: Lectura y DNS: Edición). Vacío = sin Cloudflare.
                            Además del DNS de la plataforma, se guarda en el panel (cuenta de la
                            instancia) y en Skyway para que el DNS de los dominios que da de alta el
                            administrador se configure solo. Nunca se escribe en deploy/.env.
  MAILWAY_ADMIN_EMAIL       Correo de la cuenta de administración del panel que crea el emparejado
                            con Skyway (por defecto, el de Let's Encrypt).
  SKYWAY_TOKEN              Token de API de Skyway (sky_…). Si falta y Skyway corre en este servidor
                            (contenedor «skyway»), se crea uno temporal (60 min) que se revoca al
                            terminar. Sin él ni Skyway en este servidor, no se despliega el panel.
  SKYWAY_URL                API de Skyway (por defecto http://127.0.0.1:4000; si ahí no responde,
                            se prueba la IP del contenedor «skyway»).
  SKYWAY_DIR                Carpeta de Skyway (se detecta a partir de su Traefik).
  MAILWAY_PROYECTO          Proyecto de Skyway para el panel (por defecto «mailway»).
  MAILWAY_REPO              Repositorio del panel (por defecto https://github.com/NkrowOne/Mailway).
  MAILWAY_RAMA              Rama a desplegar (por defecto main).
  MAILWAY_TRAEFIK_PROVEEDOR 1 para ajustar el Traefik de Skyway sin preguntar, 0 para no tocarlo.
                            Con Skyway 0.34 o posterior no se instala ningún fichero: su Traefik ya
                            lee las rutas de Mailway a través de Skyway (Ajustes → Correo (Mailway)).
  STALWART_ADMIN_PASSWORD   Contraseña del motor existente, si deploy/.env se perdió.
  MAILWAY_INTERNAL_SUBNET   Subred de la red interna (por defecto 10.203.53.0/24). Cámbiala si
                            choca con otra red del servidor.
  MAILWAY_MAIL_INTERNAL_IP  IP del motor en esa red (por defecto 10.203.53.10).
  MAILWAY_ESPERA_DNS        Segundos máximos de espera a que propague el DNS (por defecto 300).
  MAILWAY_DNS_REEMPLAZAR    1 = sin terminal, permite cambiar los registros A de mail., webmail. y
                            panel. que ya existan con otra IP o con el proxy de Cloudflare. Sin ella,
                            una ejecución desatendida no modifica ningún registro existente.
  MAILWAY_ENV_FILE          Fichero de configuración con los secretos (por defecto deploy/.env).
  MAILWAY_COMPOSE_EXTRA     Fichero de Compose adicional que se aplica sobre el del instalador
                            (ajustes locales; lo usa la prueba de la pila en la CI).
  MAILWAY_CLOUDFLARE_API    Base de la API de Cloudflare (solo para pruebas).

Los nombres del servidor de correo, del webmail y del panel cuelgan directamente
del dominio base (un solo nivel: correo.miempresa.com, no a.b.miempresa.com).
AYUDA
}

while [ $# -gt 0 ]; do
  case "$1" in
    --sin-skyway) CON_SKYWAY=0 ;;
    --sin-cloudflare) CON_CLOUDFLARE=0 ;;
    --actualizar) ACTUALIZAR=1 ;;
    --comprobar) COMPROBAR=1 ;;
    --probar-acceso) PROBAR_ACCESO=1 ;;
    --emparejar) EMPAREJAR=1 ;;
    --ayuda | -h | --help)
      ayuda
      exit 0
      ;;
    *) fallo "Opción desconocida: $1 (usa --ayuda)." ;;
  esac
  shift
done

if [ "$((ACTUALIZAR + COMPROBAR + PROBAR_ACCESO + EMPAREJAR))" -gt 1 ]; then
  fallo "Las opciones --actualizar, --comprobar, --probar-acceso y --emparejar no se combinan: usa una."
fi
if [ "$EMPAREJAR" = 1 ] && [ "$CON_SKYWAY" = 0 ]; then
  fallo "El emparejado solo existe junto a Skyway: --emparejar no se combina con --sin-skyway."
fi
# --emparejar usa lo que ya está en deploy/.env: no pregunta nada.
if [ "$ACTUALIZAR" = 1 ] || [ "$EMPAREJAR" = 1 ]; then INTERACTIVO=0; fi
if [ -n "${MAILWAY_COMPOSE_EXTRA:-}" ] && [ ! -f "$MAILWAY_COMPOSE_EXTRA" ]; then
  fallo "No existe el fichero de MAILWAY_COMPOSE_EXTRA: $MAILWAY_COMPOSE_EXTRA."
fi

# -------------------------------------------------------------- utilidades --

tiene() { command -v "$1" >/dev/null 2>&1; }

# Al salir, también tras un fallo o una interrupción: sin ficheros temporales,
# sin el token temporal de Skyway y sin perder la contraseña del administrador
# que acaba de crear el emparejado (si el resumen no llegó a mostrarla).
al_salir() {
  if [ -n "$ENV_TMP" ]; then rm -f "$ENV_TMP"; fi
  if [ -n "$ERR_TMP" ]; then rm -f "$ERR_TMP"; fi
  revocar_token_temporal_skyway || true
  if [ -n "$EMPAREJADO_ADMIN_PASSWORD" ]; then
    printf '\n'
    info "Cuenta de administración del panel creada por el emparejado (la contraseña se muestra solo esta vez):"
    info "  Correo:     $EMPAREJADO_ADMIN_EMAIL"
    info "  Contraseña: $EMPAREJADO_ADMIN_PASSWORD"
    EMPAREJADO_ADMIN_PASSWORD=""
  fi
}
trap al_salir EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Pregunta con valor por defecto. Sin terminal, devuelve el valor por defecto.
preguntar() {
  local __var=$1 __texto=$2 __def=${3:-} __resp=""
  if [ "$INTERACTIVO" = 1 ]; then
    if [ -n "$__def" ]; then
      read -r -p "   $__texto [$__def]: " __resp || true
    else
      read -r -p "   $__texto: " __resp || true
    fi
  fi
  if [ -z "$__resp" ]; then __resp=$__def; fi
  printf -v "$__var" '%s' "$__resp"
}

# Pregunta sin eco (tokens). Sin terminal, devuelve el valor por defecto.
preguntar_secreto() {
  local __var=$1 __texto=$2 __def=${3:-} __resp=""
  if [ "$INTERACTIVO" = 1 ]; then
    read -r -s -p "   $__texto: " __resp || true
    printf '\n'
  fi
  if [ -z "$__resp" ]; then __resp=$__def; fi
  printf -v "$__var" '%s' "$__resp"
}

# confirmar "texto" s|n → 0 si la respuesta es sí.
confirmar() {
  local texto=$1 def=${2:-n} resp=""
  if [ "$INTERACTIVO" = 1 ]; then
    if [ "$def" = s ]; then
      read -r -p "   $texto [S/n]: " resp || true
    else
      read -r -p "   $texto [s/N]: " resp || true
    fi
  fi
  if [ -z "$resp" ]; then resp=$def; fi
  case "$resp" in s | S | si | sí | Si | Sí | SI | y | Y) return 0 ;; *) return 1 ;; esac
}

# Hexadecimal aleatorio de $1 bytes. od lee exactamente N bytes, así que no
# hay tuberías cortadas (con pipefail, «tr </dev/urandom | head» aborta).
aleatorio_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

# Lee CLAVE de deploy/.env sin ejecutarlo (quita comillas envolventes).
leer_env() {
  local linea valor
  [ -f "$ENV_FILE" ] || return 0
  linea=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)
  valor=${linea#*=}
  case "$valor" in
    \'*\') valor=${valor:1:${#valor}-2} ;;
    \"*\") valor=${valor:1:${#valor}-2} ;;
  esac
  printf '%s' "$valor"
}

# Escapa un texto para una línea «clave = "valor"» de configuración de curl.
# Un salto de línea sin escapar terminaría la línea y el resto se leería
# como otra opción de curl: se convierten en sus secuencias de escape.
escapar_curl() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

# Escapa un texto para una cadena JSON. Los demás caracteres de control no
# tienen cabida en ningún valor del instalador y se descartan.
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  s=${s//[[:cntrl:]]/}
  printf '%s' "$s"
}

# ¿Casa el texto ENTERO con la expresión regular extendida? Con «grep» bastaría
# con que casara una de sus líneas: un valor con un salto de línea pasaría.
coincide() { [[ $1 =~ $2 ]]; }

# Dirección de correo razonable (la validación completa la hace quien la usa).
correo_valido() { coincide "$1" '^[A-Za-z0-9._%+-]+@([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$'; }

# Correo de la cuenta de administración del panel: además, nada de lo que el
# panel rechaza (zod .email(): «%», «..» o un punto al principio o al final
# de la parte local). Así un valor que el panel no admite falla aquí, al
# principio, y no en el emparejado del final de la instalación.
correo_admin_valido() {
  correo_valido "$1" || return 1
  case "$1" in *%* | *..* | .* | *.@*) return 1 ;; esac
  [ "${#1}" -le 254 ]
}

# ¿Tiene el texto caracteres de control (saltos de línea incluidos)?
tiene_control() { case "$1" in *[[:cntrl:]]*) return 0 ;; *) return 1 ;; esac; }

# Nombre de host en minúsculas (RFC 1123, con al menos un punto). Es lo que
# acaba en las reglas Host(`…`) de Traefik y en deploy/.env.
host_valido() {
  coincide "$1" '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' &&
    [ "${#1}" -le 253 ]
}

ipv4_valida() {
  local IFS=. octeto
  case "$1" in '' | *[!0-9.]*) return 1 ;; esac
  # shellcheck disable=SC2086 # se separa por puntos a propósito
  set -- $1
  [ $# -eq 4 ] || return 1
  for octeto in "$@"; do
    case "$octeto" in '' | *[!0-9]*) return 1 ;; esac
    [ "${#octeto}" -le 3 ] && [ "$((10#$octeto))" -le 255 ] || return 1
  done
}

# IPv4 como entero (para comparar rangos).
ipv4_num() {
  local IFS=. a b c d
  # shellcheck disable=SC2086
  set -- $1
  a=$((10#$1)) b=$((10#$2)) c=$((10#$3)) d=$((10#$4))
  printf '%s' "$(((a << 24) | (b << 16) | (c << 8) | d))"
}

# Rango IPv4 en notación CIDR (cualquier prefijo).
cidr_formato() {
  local ip=${1%/*} bits=${1#*/}
  if [ "$ip" = "$1" ] || ! ipv4_valida "$ip"; then return 1; fi
  case "$bits" in '' | *[!0-9]*) return 1 ;; esac
  [ "$bits" -le 32 ]
}

# Subred utilizable para la red interna: ni enorme ni sin sitio para el motor.
cidr_valido() {
  cidr_formato "$1" && [ "${1#*/}" -ge 8 ] && [ "${1#*/}" -le 29 ]
}

# ¿Se solapan dos rangos IPv4 en notación CIDR?
cidr_solapan() {
  local a=$1 b=$2 ma mb m
  ma=${a#*/}
  mb=${b#*/}
  m=$((ma < mb ? ma : mb))
  [ "$(($(ipv4_num "${a%/*}") >> (32 - m)))" = "$(($(ipv4_num "${b%/*}") >> (32 - m)))" ]
}

# ¿Está la IP dentro del rango?
ip_en_cidr() { cidr_solapan "$1/32" "$2"; }

# Línea CLAVE='valor' de deploy/.env. Entre comillas simples, Compose no
# interpreta «$», «#» ni espacios; a cambio, el valor no puede contener una
# comilla simple ni saltos de línea (no hay forma de escaparlos).
linea_env() {
  case "$2" in
    *\'*) fallo "El valor de $1 contiene una comilla simple, que deploy/.env no admite." ;;
  esac
  if tiene_control "$2"; then fallo "El valor de $1 contiene caracteres de control."; fi
  printf "%s='%s'\n" "$1" "$2"
}

# jq del sistema o, si no está instalado, el de su imagen oficial.
jqr() {
  if tiene jq; then
    jq "$@"
  else
    docker run --rm -i "$IMAGEN_JQ" "$@"
  fi
}

# Petición HTTP con las credenciales por la entrada estándar (-K -): ni el
# token ni la contraseña aparecen en la lista de procesos.
#   peticion_http <cabecera de autorización> <método> <url> [cuerpo JSON]
peticion_http() {
  local auth=$1 metodo=$2 url=$3 cuerpo=${4:-} salida
  salida=$(
    {
      if [ -n "$auth" ]; then printf 'header = "%s"\n' "$(escapar_curl "$auth")"; fi
      if [ -n "$cuerpo" ]; then
        printf 'header = "Content-Type: application/json"\n'
        printf 'data = "%s"\n' "$(escapar_curl "$cuerpo")"
      fi
    } | curl -sS --max-time 30 -X "$metodo" -w '\n%{http_code}' -K - "$url" 2>/dev/null
  ) || {
    RESP_CODE="000"
    RESP_BODY=""
    return 0
  }
  RESP_CODE=${salida##*$'\n'}
  RESP_BODY=${salida%$'\n'*}
}

cf_api() { peticion_http "Authorization: Bearer $CF_TOKEN" "$1" "${MAILWAY_CLOUDFLARE_API:-https://api.cloudflare.com/client/v4}$2" "${3:-}"; }
sky_api() { peticion_http "Authorization: Bearer $SKYWAY_TOKEN" "$1" "$SKYWAY_URL$2" "${3:-}"; }

# API de gestión del motor desde un contenedor efímero en la red interna: el
# puerto 8080 del motor no está publicado en el host.
motor_api() {
  local metodo=$1 ruta=$2 cuerpo=${3:-}
  {
    printf 'user = "admin:%s"\n' "$(escapar_curl "$STALWART_ADMIN_PASSWORD")"
    if [ -n "$cuerpo" ]; then
      printf 'header = "Content-Type: application/json"\n'
      printf 'data = "%s"\n' "$(escapar_curl "$cuerpo")"
    fi
  } | docker run -i --rm --network mailway-internal "$IMAGEN_CURL" \
    -sS --max-time 30 -X "$metodo" -K - "http://mailway-mail:8080$ruta"
}

# Operación «insert» de /api/settings con los pares clave valor indicados.
motor_op_insertar() {
  local valores="" primero=1
  while [ $# -gt 1 ]; do
    if [ "$primero" = 0 ]; then valores+=","; fi
    primero=0
    valores+=$(printf '["%s","%s"]' "$(json_escape "$1")" "$(json_escape "$2")")
    shift 2
  done
  printf '{"type":"insert","prefix":null,"values":[%s],"assert_empty":false}' "$valores"
}

# Inserta ajustes (pares clave valor) en el motor y lo recarga. Devuelve 1 si
# el motor informa de errores.
motor_ajustes() { motor_cambios "[$(motor_op_insertar "$@")]"; }

# Aplica en el motor una lista JSON de operaciones de /api/settings (las
# procesa en orden y se detiene en la primera que falla) y lo recarga.
# Devuelve 1 si el motor informa de errores.
motor_cambios() {
  local respuesta errores
  respuesta=$(motor_api POST /api/settings "$1") || return 1
  if ! printf '%s' "$respuesta" | grep -q '"data"'; then
    # El motor no repite los valores en sus errores, pero el token de
    # Cloudflare nunca debe acabar en pantalla: se tapa por si acaso.
    if [ -n "$CF_TOKEN" ]; then respuesta=${respuesta//"$CF_TOKEN"/•••}; fi
    aviso "El motor rechazó los ajustes: $respuesta"
    return 1
  fi
  respuesta=$(motor_api GET /api/reload) || return 1
  errores=$(printf '%s' "$respuesta" | jqr -r '(.data.errors // {}) | to_entries | map("\(.key): \(.value)") | join("; ")' 2>/dev/null || true)
  if [ -n "$CF_TOKEN" ]; then errores=${errores//"$CF_TOKEN"/•••}; fi
  if [ -n "$errores" ]; then
    aviso "El motor recargó con errores: $errores"
    return 1
  fi
  return 0
}

# Estado de salud (o de ejecución, si no tiene healthcheck) de un contenedor.
estado_contenedor() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || printf 'ausente'
}

esperar_sano() {
  local contenedor=$1 max=$2 t=0 estado
  while [ "$t" -lt "$max" ]; do
    estado=$(estado_contenedor "$contenedor")
    case "$estado" in
      healthy) return 0 ;;
      running) return 0 ;;
    esac
    sleep 3
    t=$((t + 3))
  done
  return 1
}

# ¿Resuelve el nombre a la IP en los resolutores públicos? (DNS sobre HTTPS)
# Un resolutor que no contesta (red filtrada) no cuenta; los que contestan
# deben dar todos la IP esperada, y al menos uno tiene que contestar.
resuelve_a() {
  local nombre=$1 ip=$2 servidor respuesta contestados=0
  for servidor in "https://cloudflare-dns.com/dns-query" "https://dns.google/resolve"; do
    respuesta=$(curl -fsS --max-time 8 -H 'accept: application/dns-json' "$servidor?name=$nombre&type=A" 2>/dev/null) ||
      continue
    contestados=$((contestados + 1))
    printf '%s' "$respuesta" | grep -Fq "\"data\":\"$ip\"" || return 1
  done
  [ "$contestados" -gt 0 ]
}

# Compose da prioridad al entorno sobre --env-file: sin quitarla, una
# LETSENCRYPT_EMAIL exportada para responder al instalador ganaría al valor
# elegido y guardado en deploy/.env. MAILWAY_COMPOSE_EXTRA añade un fichero
# que se aplica encima (ajustes locales; la prueba de la pila de la CI lo usa
# para la CA de laboratorio).
compose() {
  local ficheros=(-f "$COMPOSE_MAIL")
  if [ "$CON_SKYWAY" = 0 ]; then ficheros=(-f "$COMPOSE_SOLO"); fi
  if [ -n "${MAILWAY_COMPOSE_EXTRA:-}" ]; then ficheros+=(-f "$MAILWAY_COMPOSE_EXTRA"); fi
  env -u LETSENCRYPT_EMAIL docker compose --env-file "$ENV_FILE" "${ficheros[@]}" "$@"
}

# Compose sin su barra de progreso; la salida completa solo si falla.
compose_q() {
  local salida
  if ! salida=$(compose "$@" 2>&1); then
    printf '%s\n' "$salida" >&2
    return 1
  fi
}

puerto_ocupado_por_otro() {
  local puerto=$1 duenos
  tiene ss || return 1
  if [ -z "$(ss -ltnH "sport = :$puerto" 2>/dev/null)" ]; then return 1; fi
  # Ocupado por un contenedor de Mailway (reinstalación): no es un conflicto.
  duenos=$(docker ps --filter "publish=$puerto" --format '{{.Names}}' 2>/dev/null || true)
  if [ -n "$duenos" ] && ! printf '%s\n' "$duenos" | grep -qv '^mailway-'; then return 1; fi
  return 0
}

# ------------------------------------------------------------ comprobaciones --

comprobaciones_previas() {
  titulo "Comprobaciones previas"
  local falta=""
  for cmd in docker curl od grep sed awk timeout; do
    if ! tiene "$cmd"; then falta+=" $cmd"; fi
  done
  if [ -n "$falta" ]; then fallo "Faltan herramientas:$falta. Instálalas y vuelve a ejecutar."; fi
  docker info >/dev/null 2>&1 || fallo "No se puede hablar con Docker. Ejecuta como root (sudo) o con un usuario del grupo docker."
  docker compose version >/dev/null 2>&1 || fallo "Falta Docker Compose v2 («docker compose»). Instala el plugin docker-compose-plugin."
  ok "Docker y Docker Compose v2 disponibles."

  if [ "$CON_SKYWAY" = 1 ]; then
    if [ "$(docker inspect -f '{{.State.Running}}' skyway-traefik 2>/dev/null || true)" != "true" ]; then
      fallo "No está en marcha el Traefik de Skyway (contenedor skyway-traefik). Arranca Skyway o usa --sin-skyway."
    fi
    docker network inspect skyway-edge >/dev/null 2>&1 ||
      fallo "No existe la red skyway-edge de Skyway. Arranca Skyway o usa --sin-skyway."
    ok "Skyway detectado (Traefik y red skyway-edge)."
    # Let's Encrypt rechaza los contactos de example.com: con el valor por
    # defecto del compose de Skyway, Traefik no obtiene ningún certificado
    # (tampoco los del webmail y del servidor de correo).
    # Sin el flag (configuración por fichero) no se puede saber: no se avisa.
    local correo_le
    correo_le=$(docker inspect -f '{{json .Config.Cmd}}' skyway-traefik 2>/dev/null |
      grep -o 'acme\.email=[^",]*' | head -n 1 || true)
    if [ -n "$correo_le" ]; then
      correo_le=${correo_le#acme.email=}
      case "$correo_le" in
        '' | *@example.com | *@example.org | *@example.net)
          aviso "El Traefik de Skyway no tiene un correo válido para Let's Encrypt («${correo_le:-vacío}»): no obtendrá certificados."
          aviso "Define LETSENCRYPT_EMAIL en el fichero .env de Skyway y ejecuta «docker compose up -d traefik» en su carpeta."
          ;;
      esac
    fi
  fi

  local puerto ocupados=""
  for puerto in 25 465 587 993 4190; do
    if puerto_ocupado_por_otro "$puerto"; then ocupados+=" $puerto"; fi
  done
  if [ -n "$ocupados" ]; then
    fallo "Puertos de correo ocupados por otro programa:$ocupados. Libéralos (p. ej. postfix o exim del sistema) y vuelve a ejecutar."
  fi
  if tiene ss; then ok "Puertos 25, 465, 587, 993 y 4190 libres."; else aviso "Sin «ss» no se pueden comprobar los puertos."; fi

  if timeout 6 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null; then
    RESUMEN_P25="abierto"
    ok "Puerto 25 de salida abierto."
  else
    RESUMEN_P25="BLOQUEADO"
    aviso "El puerto 25 de salida parece bloqueado: sin él no se entrega correo a otros servidores. Solicita al proveedor que lo desbloquee."
  fi
}

# -------------------------------------------------------------- configuración --

detectar_ip() {
  local ip=""
  ip=$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)
  if ! ipv4_valida "$ip"; then
    ip=$(curl -4 -fsS --max-time 8 https://ipv4.icanhazip.com 2>/dev/null | tr -d '[:space:]' || true)
  fi
  if ipv4_valida "$ip"; then printf '%s' "$ip"; fi
}

# Nombre de un servicio de la plataforma: el indicado (variable o deploy/.env)
# si cuelga directamente del dominio base, o <prefijo>.<dominio>. Un solo
# nivel: el panel deduce de él el dominio de la autoconfiguración.
elegir_host() {
  local __var=$1 prefijo=$2 indicado=$3 variable=$4 previo=$5 host
  host=$(printf '%s' "${indicado:-$previo}" | tr '[:upper:]' '[:lower:]')
  if [ -n "$host" ] && { [ "${host#*.}" != "$DOMINIO" ] || ! host_valido "$host"; }; then
    if [ -n "$indicado" ]; then
      aviso "Se ignora $variable=«$indicado»: debe ser un nombre directamente bajo $DOMINIO."
    fi
    host=""
  fi
  printf -v "$__var" '%s' "${host:-$prefijo.$DOMINIO}"
}

recoger_datos() {
  titulo "Datos de la instalación"
  if [ "$ACTUALIZAR" = 1 ] && [ ! -f "$ENV_FILE" ]; then
    fallo "No existe $ENV_FILE: no hay nada que actualizar. Ejecuta el instalador sin --actualizar."
  fi

  local mail_prev dominio_def
  mail_prev=$(leer_env MAIL_HOSTNAME)
  # Sin deploy/.env (panel creado a mano en Skyway), los nombres que ya usa.
  mail_prev=${mail_prev:-$(valor_panel MAILWAY_MAIL_HOSTNAME)}
  dominio_def=${MAILWAY_DOMINIO:-}
  # Los nombres cuelgan de un solo nivel bajo el dominio base: quitar la
  # primera etiqueta lo recupera también con un nombre propio (correo.x.com).
  if [ -z "$dominio_def" ] && [ -n "$mail_prev" ]; then dominio_def=${mail_prev#*.}; fi
  preguntar DOMINIO "Dominio base de la plataforma (p. ej. miempresa.com)" "$dominio_def"
  DOMINIO=$(printf '%s' "$DOMINIO" | tr '[:upper:]' '[:lower:]' | sed 's/^[.]*//; s/[.]*$//')
  host_valido "$DOMINIO" ||
    fallo "Dominio no válido: «$DOMINIO». Indica un dominio como miempresa.com (variable MAILWAY_DOMINIO)."

  local webmail_prev panel_prev
  webmail_prev=$(leer_env WEBMAIL_HOSTNAME)
  webmail_prev=${webmail_prev:-$(host_de_url "$(valor_panel MAILWAY_WEBMAIL_URL)")}
  panel_prev=$(leer_env PANEL_HOSTNAME)
  panel_prev=${panel_prev:-$PANEL_EXISTENTE_HOST}
  elegir_host MAIL_HOSTNAME mail "${MAILWAY_MAIL_HOST:-}" MAILWAY_MAIL_HOST "$mail_prev"
  elegir_host WEBMAIL_HOSTNAME webmail "${MAILWAY_WEBMAIL_HOST:-}" MAILWAY_WEBMAIL_HOST "$webmail_prev"
  elegir_host PANEL_HOSTNAME panel "${MAILWAY_PANEL_HOST:-}" MAILWAY_PANEL_HOST "$panel_prev"
  if [ -n "$PANEL_EXISTENTE_HOST" ] && [ "$PANEL_HOSTNAME" != "$PANEL_EXISTENTE_HOST" ]; then
    info "El panel también se publicará en $PANEL_HOSTNAME (hoy está en $PANEL_EXISTENTE_HOST, que se conserva)."
  fi
  if [ "$MAIL_HOSTNAME" = "$WEBMAIL_HOSTNAME" ] || [ "$MAIL_HOSTNAME" = "$PANEL_HOSTNAME" ] ||
    [ "$WEBMAIL_HOSTNAME" = "$PANEL_HOSTNAME" ]; then
    fallo "El servidor de correo, el webmail y el panel necesitan tres nombres distintos."
  fi
  info "Servidor de correo: $MAIL_HOSTNAME"
  info "Webmail:            $WEBMAIL_HOSTNAME"
  info "Panel:              $PANEL_HOSTNAME"

  local marca_def
  marca_def=${MAILWAY_MARCA:-$(leer_env MAILWAY_BRAND)}
  preguntar MARCA "Nombre del servicio que verán los usuarios del webmail" "${marca_def:-Webmail}"
  # Sin comillas, «$», barras ni caracteres de control: el valor acaba en
  # deploy/.env (que interpreta Compose) y en la configuración del webmail.
  MARCA=$(printf '%s' "$MARCA" | tr -d "'\"\$\\\\\`" | tr -d '[:cntrl:]')
  MARCA=${MARCA:0:60}
  MARCA=${MARCA:-Webmail}

  local correo_def
  correo_def=${LETSENCRYPT_EMAIL:-$(leer_env LETSENCRYPT_EMAIL)}
  preguntar LE_EMAIL "Correo de contacto para Let's Encrypt" "${correo_def:-postmaster@$DOMINIO}"
  correo_valido "$LE_EMAIL" || fallo "Correo no válido: «$LE_EMAIL» (variable LETSENCRYPT_EMAIL)."
  case "$LE_EMAIL" in
    *@example.com | *@example.org | *@example.net) fallo "Let's Encrypt rechaza los correos de ${LE_EMAIL#*@}: indica uno real (variable LETSENCRYPT_EMAIL)." ;;
  esac
  if [ "$CON_SKYWAY" = 1 ]; then elegir_correo_admin "$LE_EMAIL"; fi

  local ip_def
  ip_def=${MAILWAY_IP:-$(leer_env MAILWAY_PUBLIC_IP)}
  ip_def=${ip_def:-$(valor_panel MAILWAY_PUBLIC_IP)}
  if [ -z "$ip_def" ]; then ip_def=$(detectar_ip); fi
  preguntar IP_PUBLICA "IPv4 pública del servidor" "$ip_def"
  ipv4_valida "$IP_PUBLICA" || fallo "IPv4 no válida: «$IP_PUBLICA» (variable MAILWAY_IP)."
  if ip_en_cidr "$IP_PUBLICA" 10.0.0.0/8 || ip_en_cidr "$IP_PUBLICA" 172.16.0.0/12 ||
    ip_en_cidr "$IP_PUBLICA" 192.168.0.0/16 || ip_en_cidr "$IP_PUBLICA" 100.64.0.0/10 ||
    ip_en_cidr "$IP_PUBLICA" 127.0.0.0/8; then
    aviso "$IP_PUBLICA es una IP privada: el DNS, el SPF y el PTR necesitan la IP pública con la que el servidor sale a Internet."
  fi
  ok "IP pública: $IP_PUBLICA"

  INTERNAL_SUBNET=${MAILWAY_INTERNAL_SUBNET:-$(leer_env MAILWAY_INTERNAL_SUBNET)}
  INTERNAL_SUBNET=${INTERNAL_SUBNET:-10.203.53.0/24}
  MAIL_INTERNAL_IP=${MAILWAY_MAIL_INTERNAL_IP:-$(leer_env MAILWAY_MAIL_INTERNAL_IP)}
  MAIL_INTERNAL_IP=${MAIL_INTERNAL_IP:-10.203.53.10}
  comprobar_subred

  if [ "$CON_SKYWAY" = 1 ]; then
    TRAEFIK_ACME_VOLUME=$(docker inspect skyway-traefik \
      -f '{{range .Mounts}}{{if eq .Destination "/letsencrypt"}}{{.Name}}{{end}}{{end}}' 2>/dev/null || true)
    SKYWAY_DIR=${SKYWAY_DIR:-$(docker inspect skyway-traefik \
      -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)}
    if [ -n "$TRAEFIK_ACME_VOLUME" ]; then ok "Volumen de certificados de Traefik: $TRAEFIK_ACME_VOLUME"; fi
    if [ -n "$SKYWAY_DIR" ]; then ok "Carpeta de Skyway: $SKYWAY_DIR"; fi
  else
    TRAEFIK_ACME_VOLUME=""
    SKYWAY_DIR=""
  fi
}

# Correo de la cuenta de administración del panel que crea el emparejado con
# Skyway (solo si el panel aún no tiene ninguna). Por defecto, el de Let's
# Encrypt ($1) o el de una ejecución anterior.
elegir_correo_admin() {
  local def
  def=${MAILWAY_ADMIN_EMAIL:-$(leer_env MAILWAY_ADMIN_EMAIL)}
  preguntar ADMIN_EMAIL "Correo de la cuenta de administración del panel" "${def:-$1}"
  ADMIN_EMAIL=$(printf '%s' "$ADMIN_EMAIL" | tr '[:upper:]' '[:lower:]')
  correo_admin_valido "$ADMIN_EMAIL" || fallo "Correo no válido: «$ADMIN_EMAIL» (variable MAILWAY_ADMIN_EMAIL)."
}

# La red interna tiene subred fija (el motor la exime de su bloqueo
# automático). Si se solapa con otra red de Docker o con una ruta del
# servidor (VPN, red privada del proveedor), Docker no puede crearla o el
# tráfico hacia esa otra red se desviaría: se comprueba antes de tocar nada.
comprobar_subred() {
  cidr_valido "$INTERNAL_SUBNET" ||
    fallo "Subred interna no válida: «$INTERNAL_SUBNET» (variable MAILWAY_INTERNAL_SUBNET, p. ej. 10.203.53.0/24)."
  if ! { ipv4_valida "$MAIL_INTERNAL_IP" && ip_en_cidr "$MAIL_INTERNAL_IP" "$INTERNAL_SUBNET"; }; then
    fallo "La IP interna del motor «$MAIL_INTERNAL_IP» no pertenece a $INTERNAL_SUBNET (variable MAILWAY_MAIL_INTERNAL_IP)."
  fi
  case "$MAIL_INTERNAL_IP" in *.0 | *.1 | *.255)
    fallo "La IP interna del motor «$MAIL_INTERNAL_IP» está reservada (red, puerta de enlace o difusión). Usa p. ej. la .10." ;;
  esac

  # «nombre subred» de cada red de Docker con IPv4.
  local redes red subred ruta conflictos=""
  redes=$(docker network ls -q 2>/dev/null |
    xargs -r docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null |
    awk '{for (i = 2; i <= NF; i++) if ($i ~ /^[0-9.]+\/[0-9]+$/) print $1, $i}' || true)
  while read -r red subred; do
    if [ -z "$subred" ] || [ "$red" = "mailway-internal" ] || ! cidr_formato "$subred"; then continue; fi
    if cidr_solapan "$subred" "$INTERNAL_SUBNET"; then conflictos+=" red de Docker «$red» ($subred);"; fi
  done <<<"$redes"

  # Rutas del servidor que no son de una red de Docker (VPN, red privada).
  if tiene ip; then
    local subredes_docker
    subredes_docker=$(awk '{print $2}' <<<"$redes")
    while read -r ruta; do
      case "$ruta" in default | '' | */0) continue ;; esac
      [ "${ruta#*/}" = "$ruta" ] && ruta="$ruta/32"
      cidr_formato "$ruta" || continue
      if grep -Fqx "$ruta" <<<"$subredes_docker"; then continue; fi
      if cidr_solapan "$ruta" "$INTERNAL_SUBNET"; then conflictos+=" ruta del servidor $ruta;"; fi
    done < <(ip -4 route show 2>/dev/null | awk '{print $1}')
  fi

  if [ -n "$conflictos" ]; then
    fallo "La subred interna $INTERNAL_SUBNET se solapa con:${conflictos%;}. Elige otra libre con MAILWAY_INTERNAL_SUBNET y MAILWAY_MAIL_INTERNAL_IP (p. ej. 10.231.87.0/24 y 10.231.87.10)."
  fi
  ok "Subred interna $INTERNAL_SUBNET libre (motor en $MAIL_INTERNAL_IP)."
}

# Volumen con los datos del motor, si ya existe (lo fija la detección de
# instalaciones anteriores, que se ejecuta antes).
volumen_datos_motor() {
  local v=${MAILWAY_MAIL_VOLUME:-mailway-mail-data}
  if docker volume inspect "$v" >/dev/null 2>&1; then printf '%s' "$v"; fi
  return 0
}

preparar_secretos() {
  titulo "Secretos"
  MAILWAY_SECRET=$(leer_env MAILWAY_SECRET)
  ROUNDCUBE_DES_KEY=$(leer_env ROUNDCUBE_DES_KEY)
  MAILWAY_TRAEFIK_TOKEN=$(leer_env MAILWAY_TRAEFIK_TOKEN)
  MAILWAY_SETUP_TOKEN=$(leer_env MAILWAY_SETUP_TOKEN)
  MAILWAY_WEBMAIL_TOKEN=$(leer_env MAILWAY_WEBMAIL_TOKEN)
  local generar_clave=1
  if [ -n "$PANEL_EXISTENTE_CONTENEDOR" ]; then
    # Panel que Skyway ya despliega (confirmado en detectar_panel_existente):
    # lo que usa él manda sobre deploy/.env, empezando por su clave maestra.
    local clave
    clave=$(clave_maestra_del_panel)
    if [ -n "$clave" ]; then
      MAILWAY_SECRET=$clave
      ok "Se conserva la clave maestra del panel."
    else
      # No se puede saber (contenedor parado): deploy/.env no guarda ninguna,
      # para que nadie copie al panel una clave que no es la suya.
      MAILWAY_SECRET=""
      generar_clave=0
      aviso "No se ha podido leer la clave maestra del panel (¿está parado?): sigue en su volumen /data y no se cambia."
    fi
    # Un panel anterior a la 1.0 guarda el token de Traefik en su base de
    # datos: uno nuevo en sus variables lo sustituiría y dejaría sin acceso a
    # quien ya consulta las rutas con el antiguo.
    if [ -n "$(valor_panel MAILWAY_TRAEFIK_TOKEN)" ]; then
      MAILWAY_TRAEFIK_TOKEN=$(valor_panel MAILWAY_TRAEFIK_TOKEN)
    else
      MAILWAY_TRAEFIK_TOKEN=""
      TRAEFIK_TOKEN_PROPIO=0
    fi
    if [ -z "$MAILWAY_SETUP_TOKEN" ]; then MAILWAY_SETUP_TOKEN=$(valor_panel MAILWAY_SETUP_TOKEN); fi
    if [ -z "$MAILWAY_WEBMAIL_TOKEN" ]; then MAILWAY_WEBMAIL_TOKEN=$(valor_panel MAILWAY_WEBMAIL_TOKEN); fi
  fi
  if [ -z "$MAILWAY_SECRET" ] && [ "$generar_clave" = 1 ]; then MAILWAY_SECRET=$(aleatorio_hex 32); fi
  if [ -z "$ROUNDCUBE_DES_KEY" ]; then ROUNDCUBE_DES_KEY=$(aleatorio_hex 12); fi
  if [ -z "$MAILWAY_TRAEFIK_TOKEN" ] && [ "$TRAEFIK_TOKEN_PROPIO" = 1 ]; then MAILWAY_TRAEFIK_TOKEN=$(aleatorio_hex 24); fi
  if [ -z "$MAILWAY_SETUP_TOKEN" ]; then MAILWAY_SETUP_TOKEN=$(aleatorio_hex 16); fi
  if [ -z "$MAILWAY_WEBMAIL_TOKEN" ]; then MAILWAY_WEBMAIL_TOKEN=$(aleatorio_hex 24); fi

  # La contraseña del motor solo se aplica en su PRIMER arranque. Si ya hay
  # datos del motor, generar otra dejaría al panel sin acceso: se reutiliza
  # la guardada o se pide. La del panel solo sirve para un motor que ya
  # existe (es la que el panel usa con él); un motor nuevo estrena la suya.
  local previa volumen
  volumen=$(volumen_datos_motor)
  previa=${STALWART_ADMIN_PASSWORD:-$(leer_env STALWART_ADMIN_PASSWORD)}
  if [ -z "$previa" ] && [ -n "$volumen" ]; then previa=$(valor_panel STALWART_ADMIN_PASSWORD); fi
  if [ -n "$previa" ]; then
    STALWART_ADMIN_PASSWORD=$previa
    ok "Se reutiliza la contraseña del motor existente."
  elif [ -n "$volumen" ]; then
    aviso "El motor ya tiene datos (volumen $volumen), pero deploy/.env no guarda su contraseña."
    preguntar_secreto STALWART_ADMIN_PASSWORD "Contraseña actual del administrador del motor" ""
    [ -n "$STALWART_ADMIN_PASSWORD" ] ||
      fallo "Sin la contraseña actual del motor no se puede continuar (variable STALWART_ADMIN_PASSWORD)."
  else
    STALWART_ADMIN_PASSWORD=$(aleatorio_hex 24)
    ok "Contraseña del motor generada."
  fi
}

# Instalaciones anteriores a la 1.0: proyecto de Compose «deploy» (o el
# nombre de la carpeta desde la que se lanzó), volúmenes <proyecto>_* y red
# interna sin subred fija. Se reutilizan los datos sin copiarlos. Va antes que
# los secretos: la contraseña del motor depende de si ya hay datos.
migrar_instalacion_anterior() {
  local proyecto="" par nombre var candidato
  proyecto=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' mailway-mail 2>/dev/null || true)
  MAILWAY_MAIL_VOLUME=$(leer_env MAILWAY_MAIL_VOLUME)
  MAILWAY_WEBMAIL_DB_VOLUME=$(leer_env MAILWAY_WEBMAIL_DB_VOLUME)
  MAILWAY_PANEL_VOLUME=$(leer_env MAILWAY_PANEL_VOLUME)

  # Para cada volumen sin fijar: si el de la 1.0 no existe pero sí el del
  # proyecto anterior (aunque sus contenedores ya se hayan borrado), se usa ese.
  for par in mailway-mail-data:MAILWAY_MAIL_VOLUME mailway-webmail-db:MAILWAY_WEBMAIL_DB_VOLUME \
    mailway-panel-data:MAILWAY_PANEL_VOLUME; do
    nombre=${par%%:*}
    var=${par#*:}
    [ -z "${!var}" ] || continue
    docker volume inspect "$nombre" >/dev/null 2>&1 && continue
    for candidato in "${proyecto:+${proyecto}_$nombre}" "deploy_$nombre"; do
      if [ -n "$candidato" ] && docker volume inspect "$candidato" >/dev/null 2>&1; then
        printf -v "$var" '%s' "$candidato"
        break
      fi
    done
  done

  if [ -n "$MAILWAY_MAIL_VOLUME" ] && [ "$MAILWAY_MAIL_VOLUME" != "$(leer_env MAILWAY_MAIL_VOLUME)" ]; then
    info "Se reutiliza el correo de una instalación anterior (volumen $MAILWAY_MAIL_VOLUME)."
  fi

  if [ -n "$proyecto" ] && [ "$proyecto" != "mailway" ]; then
    titulo "Migración de una instalación anterior"
    info "Los contenedores actuales pertenecen al proyecto de Compose «$proyecto»; la 1.0 usa «mailway»."
    confirmar "Se detendrán y recrearán los contenedores de Mailway conservando el correo. ¿Continuar?" s ||
      fallo "Migración cancelada."
    MIGRAR_CONTENEDORES=1
    info "Se reutilizarán los volúmenes (${MAILWAY_MAIL_VOLUME:-sin volumen de correo}); los contenedores se recrean al levantar el servicio."
  fi
}

# Justo antes de levantar el servicio (para que el correo esté parado el menor
# tiempo posible): retira los contenedores del proyecto anterior y recrea la
# red interna si no tiene la subred fija, que el motor exime de su bloqueo.
retirar_contenedores_anteriores() {
  local c servidor_webmail="" imagen_webmail=""
  if [ "$MIGRAR_CONTENEDORES" = 1 ]; then
    # Antes de retirar el webmail: el servidor por el que entraba al motor y
    # su imagen (ya descargada y con php y SQLite), para trasladar sus usuarios.
    if docker inspect --type container mailway-webmail >/dev/null 2>&1; then
      servidor_webmail=$(servidor_webmail_anterior)
      imagen_webmail=$(docker inspect --type container -f '{{.Image}}' mailway-webmail 2>/dev/null || true)
    fi
    for c in mailway-webmail mailway-certs-dumper mailway-mail mailway-panel; do
      if docker inspect "$c" >/dev/null 2>&1; then docker rm -f "$c" >/dev/null; fi
    done
    ok "Contenedores de la instalación anterior retirados; los volúmenes se conservan."
    migrar_usuarios_webmail "$servidor_webmail" "$imagen_webmail"
  elif docker inspect --type container mailway-webmail >/dev/null 2>&1; then
    # Contenedores ya en el proyecto «mailway» pero quizá trasladados por un
    # instalador sin este paso (la 1.0): la base puede conservar usuarios con
    # el nombre público. Se trasladan con el webmail en marcha (la escritura
    # espera a su bloqueo); sin filas que cambiar, no dice nada.
    migrar_usuarios_webmail "$MAIL_HOSTNAME" \
      "$(docker inspect --type container -f '{{.Image}}' mailway-webmail 2>/dev/null || true)"
  fi

  if docker network inspect mailway-internal >/dev/null 2>&1; then
    local subred proyecto_red conectados
    subred=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' mailway-internal)
    proyecto_red=$(docker network inspect -f '{{index .Labels "com.docker.compose.project"}}' mailway-internal)
    if [ "$subred" != "$INTERNAL_SUBNET" ] || [ "$proyecto_red" != "mailway" ]; then
      conectados=$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' mailway-internal)
      for c in $conectados; do
        case "$c" in
          mailway-*) docker rm -f "$c" >/dev/null ;;
          *) fallo "La red mailway-internal tiene conectado «$c», que no es de Mailway. Desconéctalo y vuelve a ejecutar." ;;
        esac
      done
      docker network rm mailway-internal >/dev/null
      ok "Red mailway-internal recreada con la subred $INTERNAL_SUBNET."
    fi
  fi
}

# Servidor IMAP del webmail de la 1.0 (ROUNDCUBEMAIL_DEFAULT_HOST de los dos
# compose, ssl://mailway-mail), como lo guarda Roundcube: sin esquema ni puerto.
SERVIDOR_WEBMAIL="mailway-mail"

# Servidor IMAP del webmail actual (ROUNDCUBEMAIL_DEFAULT_HOST), como lo
# guarda Roundcube en users.mail_host: sin esquema ni puerto y en minúsculas.
# Se lee con bash: el entorno del contenedor lleva secretos.
servidor_webmail_anterior() {
  local linea
  while IFS= read -r linea; do
    case "$linea" in
      ROUNDCUBEMAIL_DEFAULT_HOST=*)
        host_de_url "${linea#*=}"
        return 0
        ;;
    esac
  done <<<"$(entorno_contenedor mailway-webmail)"
}

# Cambia en la base SQLite de Roundcube (MAILWAY_RC_BASE) el servidor de los
# usuarios de MAILWAY_RC_ANTERIOR a MAILWAY_RC_NUEVO. «OR IGNORE»: el índice
# único es (username, mail_host), y el usuario que ya entró con el servidor
# nuevo conserva esa fila. Escribe «<cambiados> <pendientes>»; sin base, «0 0»
# (abrirla con PDO la crearía vacía).
PHP_MIGRAR_WEBMAIL='$base = getenv("MAILWAY_RC_BASE");
if (!is_file($base)) { echo "0 0\n"; exit(0); }
$db = new PDO("sqlite:" . $base, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 30]);
$antes = getenv("MAILWAY_RC_ANTERIOR");
$cambio = $db->prepare("UPDATE OR IGNORE users SET mail_host = ? WHERE lower(mail_host) = ?");
$cambio->execute([getenv("MAILWAY_RC_NUEVO"), $antes]);
$quedan = $db->prepare("SELECT COUNT(*) FROM users WHERE lower(mail_host) = ?");
$quedan->execute([$antes]);
echo $cambio->rowCount(), " ", $quedan->fetchColumn(), "\n";'

# El webmail anterior a la 1.0 entraba al motor por su nombre público
# (ssl://<MAIL_HOSTNAME>); el de la 1.0, por la red interna (ssl://mailway-mail).
# Roundcube identifica a cada usuario por su dirección y por ese servidor
# (users.mail_host): sin trasladarlos, cada titular entraría en un usuario
# nuevo y vacío, sin sus contactos, identidades, firmas ni preferencias,
# aunque sigan en la base. Se hace con el webmail antiguo ya retirado y antes
# de levantar el nuevo (o, al repetir la instalación, con el actual en
# marcha), en un contenedor efímero sin red. Si falla, avisa y la
# instalación sigue.
#   migrar_usuarios_webmail <servidor del webmail anterior> <su imagen>
migrar_usuarios_webmail() {
  local anterior=$1 imagen=$2 volumen=${MAILWAY_WEBMAIL_DB_VOLUME:-mailway-webmail-db}
  local salida="" resultado cambiados pendientes re='^([0-9]+) ([0-9]+)$'
  if [ -z "$anterior" ] || [ "$anterior" = "$SERVIDOR_WEBMAIL" ]; then return 0; fi
  if [ "$anterior" != "$MAIL_HOSTNAME" ]; then
    info "El webmail anterior entraba al motor por $anterior, que no es $MAIL_HOSTNAME: sus usuarios no se trasladan."
    return 0
  fi
  if [ -z "$imagen" ] || ! docker volume inspect "$volumen" >/dev/null 2>&1; then return 0; fi
  # Como root (el usuario de la imagen): la base puede ser de root, según
  # quién la creara. Sin secretos: los valores pueden ir en el entorno.
  if salida=$(docker run --rm --network none -v "$volumen:/var/roundcube/db" \
    -e MAILWAY_RC_BASE=/var/roundcube/db/sqlite.db -e "MAILWAY_RC_ANTERIOR=$anterior" \
    -e "MAILWAY_RC_NUEVO=$SERVIDOR_WEBMAIL" --entrypoint php "$imagen" -r "$PHP_MIGRAR_WEBMAIL" 2>&1); then
    resultado=${salida##*$'\n'}
  else
    resultado=""
  fi
  if ! [[ $resultado =~ $re ]]; then
    aviso "No se pudo trasladar a los usuarios del webmail al servidor $SERVIDOR_WEBMAIL: ${salida:0:300}"
    aviso "Hasta hacerlo, los titulares verán el webmail sin sus contactos ni preferencias (sección 8.2 de docs/DESPLIEGUE-SKYWAY.md)."
    return 0
  fi
  cambiados=${BASH_REMATCH[1]}
  pendientes=${BASH_REMATCH[2]}
  if [ "$cambiados" -gt 0 ]; then
    ok "Usuarios del webmail trasladados de $anterior a $SERVIDOR_WEBMAIL: $cambiados. Conservan sus contactos, identidades y preferencias."
  fi
  if [ "$pendientes" -gt 0 ]; then
    aviso "Usuarios del webmail que ya habían entrado por $SERVIDOR_WEBMAIL y conservan ese usuario: $pendientes. Sus datos anteriores siguen en la base."
  fi
  return 0
}

escribir_env() {
  titulo "Configuración (deploy/.env)"
  local tmp claves clave linea umask_previa
  umask_previa=$(umask)
  umask 077
  tmp=$(mktemp "$(dirname "$ENV_FILE")/.env.XXXXXX")
  # Si algo falla a medias, no queda una copia parcial con secretos (al_salir).
  ENV_TMP=$tmp
  {
    printf '# Generado por deploy/instalar.sh %s el %s. Contiene secretos: permisos 600.\n' \
      "$VERSION_INSTALADOR" "$(date -u '+%Y-%m-%d %H:%M UTC')"
    printf '# Se puede volver a ejecutar el instalador: reutiliza estos valores.\n\n'
    if [ "$CON_SKYWAY" = 1 ]; then linea_env MAILWAY_INSTALACION skyway; else linea_env MAILWAY_INSTALACION autonoma; fi
    linea_env MAIL_HOSTNAME "$MAIL_HOSTNAME"
    linea_env WEBMAIL_HOSTNAME "$WEBMAIL_HOSTNAME"
    linea_env PANEL_HOSTNAME "$PANEL_HOSTNAME"
    linea_env MAILWAY_PUBLIC_IP "$IP_PUBLICA"
    linea_env MAILWAY_BRAND "$MARCA"
    linea_env LETSENCRYPT_EMAIL "$LE_EMAIL"
    if [ -n "$ADMIN_EMAIL" ]; then linea_env MAILWAY_ADMIN_EMAIL "$ADMIN_EMAIL"; fi
    printf '\n# Motor: contraseña VIGENTE del administrador. El motor solo la toma en su primer\n'
    printf '# arranque; si la cambias en el motor, cámbiala también aquí (la usa el extractor).\n'
    linea_env STALWART_ADMIN_PASSWORD "$STALWART_ADMIN_PASSWORD"
    printf '\n# Webmail\n'
    linea_env ROUNDCUBE_DES_KEY "$ROUNDCUBE_DES_KEY"
    linea_env MAILWAY_PANEL_URL "https://$PANEL_HOSTNAME"
    linea_env MAILWAY_WEBMAIL_URL "https://$WEBMAIL_HOSTNAME"
    linea_env MAILWAY_PANEL_INTERNAL_URL "$PANEL_INTERNAL_URL"
    printf '\n# Secretos compartidos con el panel (sus variables en Skyway llevan los mismos).\n'
    # Vacías cuando el panel las guarda él mismo (anterior a la 1.0): aquí no
    # se escribe una que no es la suya.
    if [ -n "$MAILWAY_SECRET" ]; then
      linea_env MAILWAY_SECRET "$MAILWAY_SECRET"
    else
      printf '# MAILWAY_SECRET: el panel la guarda en su volumen /data.\n'
    fi
    linea_env MAILWAY_SETUP_TOKEN "$MAILWAY_SETUP_TOKEN"
    if [ -n "$MAILWAY_TRAEFIK_TOKEN" ]; then
      linea_env MAILWAY_TRAEFIK_TOKEN "$MAILWAY_TRAEFIK_TOKEN"
    else
      printf '# MAILWAY_TRAEFIK_TOKEN: el panel lo guarda en su base de datos (Ajustes → Rutas de Traefik).\n'
    fi
    linea_env MAILWAY_WEBMAIL_TOKEN "$MAILWAY_WEBMAIL_TOKEN"
    printf '\n# Red interna (subred fija que el motor exime de su bloqueo automático).\n'
    linea_env MAILWAY_INTERNAL_SUBNET "$INTERNAL_SUBNET"
    linea_env MAILWAY_MAIL_INTERNAL_IP "$MAIL_INTERNAL_IP"
    if [ -n "$TRAEFIK_ACME_VOLUME" ]; then linea_env TRAEFIK_ACME_VOLUME "$TRAEFIK_ACME_VOLUME"; fi
    if [ -n "$MAILWAY_MAIL_VOLUME" ]; then linea_env MAILWAY_MAIL_VOLUME "$MAILWAY_MAIL_VOLUME"; fi
    if [ -n "$MAILWAY_WEBMAIL_DB_VOLUME" ]; then linea_env MAILWAY_WEBMAIL_DB_VOLUME "$MAILWAY_WEBMAIL_DB_VOLUME"; fi
    if [ -n "$MAILWAY_PANEL_VOLUME" ]; then linea_env MAILWAY_PANEL_VOLUME "$MAILWAY_PANEL_VOLUME"; fi
  } >"$tmp"

  # Las claves añadidas a mano se conservan.
  claves=" MAILWAY_INSTALACION MAIL_HOSTNAME WEBMAIL_HOSTNAME PANEL_HOSTNAME MAILWAY_PUBLIC_IP MAILWAY_BRAND LETSENCRYPT_EMAIL"
  claves+=" MAILWAY_ADMIN_EMAIL"
  claves+=" STALWART_ADMIN_PASSWORD ROUNDCUBE_DES_KEY MAILWAY_PANEL_URL MAILWAY_WEBMAIL_URL MAILWAY_PANEL_INTERNAL_URL"
  claves+=" MAILWAY_SECRET MAILWAY_SETUP_TOKEN MAILWAY_TRAEFIK_TOKEN MAILWAY_WEBMAIL_TOKEN MAILWAY_INTERNAL_SUBNET"
  claves+=" MAILWAY_MAIL_INTERNAL_IP TRAEFIK_ACME_VOLUME MAILWAY_MAIL_VOLUME MAILWAY_WEBMAIL_DB_VOLUME MAILWAY_PANEL_VOLUME "
  if [ -f "$ENV_FILE" ]; then
    local extra=""
    while IFS= read -r linea || [ -n "$linea" ]; do
      case "$linea" in '' | '#'*) continue ;; esac
      clave=${linea%%=*}
      case "$claves" in *" $clave "*) ;; *) extra+="$linea"$'\n' ;; esac
    done <"$ENV_FILE"
    if [ -n "$extra" ]; then
      printf '\n# Conservado de la versión anterior de este fichero.\n%s' "$extra" >>"$tmp"
    fi
    # Copia de la versión con la que empezó esta ejecución (una sola vez:
    # la segunda escritura, tras desplegar el panel, no debe pisarla).
    if [ "$ENV_COPIADO" = 0 ]; then
      cp -p "$ENV_FILE" "$ENV_FILE.anterior"
      chmod 600 "$ENV_FILE.anterior"
      ENV_COPIADO=1
    fi
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  ENV_TMP=""
  umask "$umask_previa"
  ok "Escrito $ENV_FILE (permisos 600)."
}

# ------------------------------------------------------------------- DNS --

cf_primer_error() {
  printf '%s' "$RESP_BODY" | jqr -r '(.errors // [])[0] | if . then "\(.message) (código \(.code))" else "HTTP '"$RESP_CODE"'" end' 2>/dev/null ||
    printf 'HTTP %s' "$RESP_CODE"
}

# Campo de la última respuesta JSON (vacío si no es JSON o no existe).
campo_json() { printf '%s' "$RESP_BODY" | jqr -r "$@" 2>/dev/null || true; }

# Comprueba que el token existe y está activo. Los tokens de cuenta (cfat_…)
# no se pueden verificar en /user/tokens/verify (responden «Invalid API
# Token»): se verifican en su cuenta, que se deduce de las zonas visibles.
cf_verificar_token() {
  case "$CF_TOKEN" in
    cfk_*) fallo "Has indicado la clave global de Cloudflare. Crea un token de API con los permisos Zona: Lectura y DNS: Edición." ;;
  esac
  coincide "$CF_TOKEN" '^[A-Za-z0-9_-]{20,200}$' ||
    fallo "El token de Cloudflare no tiene un formato válido (variable CLOUDFLARE_API_TOKEN)."

  local estado="" cuenta
  if [ "${CF_TOKEN#cfat_}" = "$CF_TOKEN" ]; then
    cf_api GET /user/tokens/verify
    if [ "$RESP_CODE" = "200" ]; then estado=$(campo_json '.result.status // empty'); fi
  fi
  if [ -z "$estado" ]; then
    cf_api GET "/zones?per_page=50"
    [ "$RESP_CODE" = "200" ] ||
      fallo "Cloudflare rechazó el token: $(cf_primer_error). Comprueba que está activo y tiene los permisos Zona: Lectura y DNS: Edición."
    cuenta=$(campo_json '(.result // [])[0].account.id // empty')
    coincide "$cuenta" '^[A-Za-z0-9]{1,64}$' ||
      fallo "El token de Cloudflare no da acceso a ninguna zona. Añade la zona de $DOMINIO a sus permisos."
    cf_api GET "/accounts/$cuenta/tokens/verify"
    if [ "$RESP_CODE" = "200" ]; then estado=$(campo_json '.result.status // empty'); fi
  fi
  [ "$estado" = "active" ] ||
    fallo "El token de Cloudflare no está activo (estado: ${estado:-no verificable; $(cf_primer_error)})."
  ok "Token de Cloudflare verificado."
}

configurar_cloudflare() {
  titulo "DNS en Cloudflare"
  if [ "$CON_CLOUDFLARE" = 0 ]; then
    info "Omitido (--sin-cloudflare)."
    return 0
  fi
  if [ "$ACTUALIZAR" = 1 ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    info "Omitido: sin CLOUDFLARE_API_TOKEN en la actualización."
    return 0
  fi
  if [ "$INTERACTIVO" = 1 ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    info "Con un token de Cloudflare (permisos Zona: Lectura y DNS: Edición) se crean los registros"
    info "del servidor y el motor obtiene su certificado de Let's Encrypt por DNS. Intro para omitir."
  fi
  preguntar_secreto CF_TOKEN "Token de API de Cloudflare" "${CLOUDFLARE_API_TOKEN:-}"
  if [ -z "$CF_TOKEN" ]; then
    info "Sin token: crea a mano los registros A de $MAIL_HOSTNAME, $WEBMAIL_HOSTNAME y $PANEL_HOSTNAME hacia $IP_PUBLICA."
    return 0
  fi
  cf_verificar_token

  # La zona se busca del nombre más largo al más corto (admite subdominios
  # delegados). Una zona que el token no ve responde con una lista vacía.
  local candidato="$DOMINIO" estado_zona
  while :; do
    cf_api GET "/zones?name=$candidato&per_page=5"
    [ "$RESP_CODE" = "200" ] || fallo "No se pudieron consultar las zonas de Cloudflare: $(cf_primer_error)."
    CF_ZONA_ID=$(campo_json '(.result // [])[0].id // empty')
    if [ -n "$CF_ZONA_ID" ]; then
      coincide "$CF_ZONA_ID" '^[A-Za-z0-9]{1,64}$' || fallo "Cloudflare devolvió un identificador de zona inesperado."
      CF_ZONA_NOMBRE=$candidato
      estado_zona=$(campo_json '(.result // [])[0].status // empty')
      break
    fi
    case "$candidato" in *.*.*) candidato=${candidato#*.} ;; *) break ;; esac
  done
  if [ -z "$CF_ZONA_ID" ]; then
    fallo "El token no tiene acceso a la zona de $DOMINIO en Cloudflare. Añade la zona a los permisos del token."
  fi
  ok "Zona de Cloudflare: $CF_ZONA_NOMBRE"
  if [ "$estado_zona" = "pending" ]; then
    aviso "La zona $CF_ZONA_NOMBRE aún está pendiente en Cloudflare: los registros no se publican hasta que el dominio"
    aviso "use estos servidores de nombres: $(campo_json '(.result // [])[0].name_servers // [] | join(", ")')."
  fi

  local nombre
  for nombre in "$MAIL_HOSTNAME" "$WEBMAIL_HOSTNAME" "$PANEL_HOSTNAME"; do
    cf_registro A "$nombre" "$IP_PUBLICA" s
  done
  # Autoconfiguración de programas de correo para el propio dominio base.
  # Suelen existir ya (p. ej. autodiscover hacia Microsoft 365): sin
  # confirmación expresa no se cambian.
  for nombre in "autoconfig.$DOMINIO" "autodiscover.$DOMINIO"; do
    cf_registro CNAME "$nombre" "$MAIL_HOSTNAME" n
  done
}

# Crea o corrige un registro sin proxy (el proxy de Cloudflare rompe SMTP/IMAP
# y la validación de certificados). Lo que falta se crea siempre; lo que ya
# existe con otro valor o con el proxy activado solo se modifica con permiso:
# con terminal, preguntando (<s|n> es la respuesta por defecto si apunta a otro
# sitio); sin terminal (ejecución desatendida, --actualizar), nunca, salvo con
# MAILWAY_DNS_REEMPLAZAR=1 y solo en los registros cuya respuesta por defecto
# es «s» (los A de la plataforma): un autodiscover hacia Microsoft 365 no se
# cambia nunca sin preguntar.
#   cf_registro <tipo> <nombre> <contenido> <s|n>
cf_registro() {
  local tipo=$1 nombre=$2 contenido=$3 cambiar_def=$4 existente id actual proxied otro cuerpo total
  cf_api GET "/zones/$CF_ZONA_ID/dns_records?name=$nombre&per_page=100"
  [ "$RESP_CODE" = "200" ] || fallo "No se pudieron leer los registros de $nombre: $(cf_primer_error)."
  existente=$(campo_json --arg t "$tipo" 'first((.result // [])[] | select(.type == $t)) | "\(.id) \(.content) \(.proxied)"')
  total=$(campo_json --arg t "$tipo" '[(.result // [])[] | select(.type == $t)] | length')
  # Un CNAME no convive con ningún otro registro del mismo nombre; un A solo
  # choca con un CNAME (un AAAA puede acompañarlo).
  if [ "$tipo" = "CNAME" ]; then
    otro=$(campo_json 'first((.result // [])[] | select(.type != "CNAME")) | .type')
  else
    otro=$(campo_json 'first((.result // [])[] | select(.type == "CNAME")) | .type')
  fi
  cuerpo=$(printf '{"type":"%s","name":"%s","content":"%s","ttl":1,"proxied":false,"comment":"Mailway"}' \
    "$tipo" "$(json_escape "$nombre")" "$(json_escape "$contenido")")

  if [ -n "$otro" ]; then
    aviso "$nombre ya tiene un registro $otro: no se crea el $tipo. Revísalo en Cloudflare."
    return 0
  fi
  if [ "$tipo" = "A" ] && [ -n "$(campo_json 'first((.result // [])[] | select(.type == "AAAA")) | .content')" ]; then
    aviso "$nombre tiene además un registro AAAA (IPv6): comprueba que apunta a este servidor o bórralo."
  fi
  if [ -z "$existente" ]; then
    cf_api POST "/zones/$CF_ZONA_ID/dns_records" "$cuerpo"
    [ "$RESP_CODE" = "200" ] || fallo "No se pudo crear $tipo $nombre: $(cf_primer_error)."
    ok "Creado $tipo $nombre → $contenido"
    return 0
  fi
  if [ "${total:-1}" -gt 1 ] 2>/dev/null; then
    aviso "$nombre tiene $total registros $tipo: solo se ajusta el primero. Borra los demás en Cloudflare."
  fi
  read -r id actual proxied <<<"$existente"
  coincide "$id" '^[A-Za-z0-9]{1,64}$' || fallo "Cloudflare devolvió un identificador de registro inesperado."
  if [ "$actual" = "$contenido" ] && [ "$proxied" = "false" ]; then
    ok "$tipo $nombre → $contenido (ya correcto)"
    return 0
  fi
  # Sin terminal decide la respuesta por defecto que pasó quien llama:
  # MAILWAY_DNS_REEMPLAZAR solo abre los A de la plataforma («s»), nunca los
  # CNAME de autoconfiguración, tampoco cuando solo cambiaría su proxy.
  local que="apunta a $actual" pregunta="¿Cambiarlo a $contenido (sin proxy)?" def_desatendida=$cambiar_def
  if [ "$actual" = "$contenido" ]; then
    que="tiene el proxy de Cloudflare activado, que impide el correo y la validación del certificado"
    pregunta="¿Desactivar el proxy («Solo DNS»)?"
    # Con el mismo destino, quitar el proxy es lo único que se haría: con
    # terminal se propone por defecto.
    cambiar_def=s
  fi
  if [ "$INTERACTIVO" = 1 ]; then
    if ! confirmar "$nombre $que. $pregunta" "$cambiar_def"; then
      aviso "$nombre se deja como está ($que)."
      return 0
    fi
  elif [ "${MAILWAY_DNS_REEMPLAZAR:-0}" != 1 ] || [ "$def_desatendida" != s ]; then
    # Sin nadie a quien preguntar, un registro existente es un conflicto: se
    # informa y no se toca.
    aviso "$nombre $que: no se modifica sin confirmación. Cámbialo en Cloudflare o repite la instalación con terminal (o con MAILWAY_DNS_REEMPLAZAR=1)."
    return 0
  fi
  cf_api PUT "/zones/$CF_ZONA_ID/dns_records/$id" "$cuerpo"
  [ "$RESP_CODE" = "200" ] || fallo "No se pudo actualizar $tipo $nombre: $(cf_primer_error)."
  ok "Actualizado $tipo $nombre → $contenido (sin proxy)"
}

# Traefik pide los certificados en cuanto ve las rutas: si el DNS aún no
# apunta aquí, Let's Encrypt falla la validación y aplica esperas por reintento.
esperar_dns() {
  titulo "Propagación del DNS"
  local nombre pendientes t=0 max=${MAILWAY_ESPERA_DNS:-300}
  case "$max" in '' | *[!0-9]*) fallo "MAILWAY_ESPERA_DNS debe ser un número de segundos." ;; esac
  while :; do
    pendientes=""
    for nombre in "$MAIL_HOSTNAME" "$WEBMAIL_HOSTNAME" "$PANEL_HOSTNAME"; do
      if ! resuelve_a "$nombre" "$IP_PUBLICA"; then pendientes+=" $nombre"; fi
    done
    if [ -z "$pendientes" ]; then
      RESUMEN_DNS="correcto"
      ok "Los tres nombres resuelven a $IP_PUBLICA."
      return 0
    fi
    if [ -z "$CF_TOKEN" ] && [ "$INTERACTIVO" = 1 ] && [ "$t" = 0 ]; then
      info "Pendientes:$pendientes"
      info "Crea los registros A hacia $IP_PUBLICA en tu proveedor de DNS (sin proxy)."
      if ! confirmar "¿Esperar a que propaguen?" s; then break; fi
    fi
    if [ "$t" -ge "$max" ]; then break; fi
    if [ "$t" = 0 ]; then info "Esperando a que propague:$pendientes (hasta $((max / 60)) min)…"; fi
    sleep 10
    t=$((t + 10))
  done
  RESUMEN_DNS="pendiente:$pendientes"
  aviso "Sin propagar:$pendientes. Se continúa; Traefik reintentará los certificados cuando el DNS esté listo."
}

comprobar_ptr() {
  local inverso ptr
  inverso=$(printf '%s' "$IP_PUBLICA" | awk -F. '{print $4"."$3"."$2"."$1".in-addr.arpa"}')
  ptr=$(curl -fsS --max-time 8 -H 'accept: application/dns-json' \
    "https://cloudflare-dns.com/dns-query?name=$inverso&type=PTR" 2>/dev/null |
    grep -o '"data":"[^"]*"' | head -n 1 | sed 's/"data":"//; s/"$//; s/\.$//' || true)
  if [ "$ptr" = "$MAIL_HOSTNAME" ]; then
    RESUMEN_PTR="correcto ($IP_PUBLICA → $ptr)"
  elif [ -n "$ptr" ]; then
    RESUMEN_PTR="INCORRECTO: $IP_PUBLICA → $ptr (debe ser $MAIL_HOSTNAME; se cambia en el panel del proveedor del servidor)"
  else
    RESUMEN_PTR="SIN CONFIGURAR: pide al proveedor del servidor el DNS inverso $IP_PUBLICA → $MAIL_HOSTNAME"
  fi
}

# ------------------------------------------------------------ contenedores --

levantar_servicios() {
  titulo "Motor de correo y webmail"
  retirar_contenedores_anteriores
  local perfiles=()
  if [ "$CON_SKYWAY" = 0 ] && [ "$USAR_PROXY_PROPIO" = 1 ]; then perfiles+=(--profile proxy); fi

  if [ "$ACTUALIZAR" = 1 ]; then
    info "Descargando imágenes…"
    compose ${perfiles[@]+"${perfiles[@]}"} pull --quiet --ignore-buildable 2>/dev/null || compose ${perfiles[@]+"${perfiles[@]}"} pull --quiet || true
  fi
  if [ "$CON_SKYWAY" = 0 ]; then
    info "Compilando el panel (la primera vez tarda unos minutos)…"
    compose_q ${perfiles[@]+"${perfiles[@]}"} build mailway-panel
  fi
  # Primero el motor: el webmail (y el panel) esperan a que esté sano.
  compose_q ${perfiles[@]+"${perfiles[@]}"} up -d --remove-orphans mailway-mail
  if ! esperar_sano mailway-mail 150; then
    # Núcleos sin IPv6: la configuración por defecto escucha en [::] y
    # Stalwart no abre ningún puerto. Se pasa a IPv4.
    if docker exec mailway-mail sh -c 'grep -qs "Address family not supported" /opt/stalwart/logs/*' 2>/dev/null; then
      aviso "El núcleo no admite IPv6: el motor pasa a escuchar solo en IPv4."
      docker exec mailway-mail sed -i 's/"\[::\]:/"0.0.0.0:/' /opt/stalwart/etc/config.toml
      docker restart mailway-mail >/dev/null
      esperar_sano mailway-mail 90 || fallo "El motor no arranca. Revisa: docker exec mailway-mail tail -n 50 /opt/stalwart/logs/stalwart.log.$(date -u +%F)"
    else
      fallo "El motor no arranca. Revisa: docker logs mailway-mail y docker exec mailway-mail ls /opt/stalwart/logs"
    fi
  fi
  ok "Motor en marcha (mailway-mail)."
  compose_q ${perfiles[@]+"${perfiles[@]}"} up -d --remove-orphans
  if esperar_sano mailway-webmail 180; then
    ok "Webmail en marcha (mailway-webmail)."
  else
    aviso "El webmail aún no está sano. Revisa: docker logs mailway-webmail"
  fi
  if [ "$CON_SKYWAY" = 0 ]; then
    if esperar_sano mailway-panel 120; then ok "Panel en marcha (mailway-panel)."; else aviso "El panel aún no está sano. Revisa: docker logs mailway-panel"; fi
  fi
}

configurar_motor() {
  titulo "Ajustes del motor"
  docker image inspect "$IMAGEN_CURL" >/dev/null 2>&1 || docker pull -q "$IMAGEN_CURL" >/dev/null
  # Nombre del servidor, confianza en el proxy y exención de la red interna:
  # lo mismo que aplica el panel con «Aplicar ajustes recomendados».
  if motor_ajustes \
    server.hostname "$MAIL_HOSTNAME" \
    http.use-x-forwarded true \
    "server.allowed-ip.$INTERNAL_SUBNET" ""; then
    ok "Nombre del servidor ($MAIL_HOSTNAME), proxy y exención de $INTERNAL_SUBNET aplicados."
  else
    aviso "No se pudieron aplicar todos los ajustes; el panel permite repetirlo en Ajustes → Servidor de correo."
  fi

  # Lo ya configurado (por el panel o por una ejecución anterior) se respeta.
  local existentes con_volcado=0 volcado_antiguo=0
  existentes=$(motor_api GET '/api/settings/keys?keys=acme.mailway.directory,certificate.mailway.cert,certificate.mailway.subjects.0,certificate.default.cert,certificate.default.private-key' 2>/dev/null || true)
  if printf '%s' "$existentes" | grep -q '"certificate.mailway.cert"'; then con_volcado=1; fi
  if certificado_del_volcado_antiguo "$existentes"; then volcado_antiguo=1; fi
  if [ -z "$CF_TOKEN" ] && printf '%s' "$existentes" | grep -q '"acme.mailway.directory"'; then
    CERT_CONFIGURADO=1
    RESUMEN_CERT="Let's Encrypt emitido por el propio motor (configurado antes)"
    ok "El motor ya emite su certificado con Let's Encrypt."
    if [ "$volcado_antiguo" = 1 ]; then retirar_certificado_antiguo; fi
    extractor_con_acme "$con_volcado" "$volcado_antiguo"
    return 0
  fi
  if [ -z "$CF_TOKEN" ] && [ "$volcado_antiguo" = 1 ]; then
    pasar_volcado_antiguo_al_extractor
    return 0
  fi
  if [ -z "$CF_TOKEN" ] && printf '%s' "$existentes" | grep -q '"certificate.default.cert"'; then
    CERT_CONFIGURADO=1
    RESUMEN_CERT="certificado propio configurado a mano en el motor"
    ok "El motor ya tiene un certificado configurado a mano; no se modifica."
    return 0
  fi
  if [ -z "$CF_TOKEN" ] && [ "$con_volcado" = 1 ]; then
    # Instalación que ya usa el certificado de Traefik: mismas rutas, ahora
    # con el extractor. El nombre del servidor como sujeto explícito hace que
    # el motor lo sustituya al recargar aunque el certificado nuevo sea un
    # comodín (sin él, conservaría en memoria el exacto anterior).
    if ! printf '%s' "$existentes" | grep -q '"certificate.mailway.subjects.0"'; then
      motor_ajustes certificate.mailway.subjects.0 "$MAIL_HOSTNAME" ||
        aviso "No se pudo añadir $MAIL_HOSTNAME como sujeto del certificado; el extractor funciona igualmente."
    fi
    CERT_CONFIGURADO=1
    aplicar_extractor
    return 0
  fi

  if [ -n "$CF_TOKEN" ] && [ -n "$CF_ZONA_NOMBRE" ]; then
    # Vía preferida: el motor pide y renueva su certificado por DNS-01. El
    # certificate.default de la guía 0.x se retira en la misma petición: si
    # apunta a ficheros que ya no existen, haría fallar la recarga que activa
    # el ACME (y cualquier recarga posterior).
    local ops
    ops="[$(motor_op_insertar \
      acme.mailway.directory "$LE_DIRECTORIO" \
      acme.mailway.challenge dns-01 \
      acme.mailway.provider cloudflare \
      acme.mailway.secret "$CF_TOKEN" \
      acme.mailway.contact.0 "$LE_EMAIL" \
      acme.mailway.domains.0 "$MAIL_HOSTNAME" \
      acme.mailway.origin "$CF_ZONA_NOMBRE" \
      acme.mailway.renew-before 30d \
      acme.mailway.default true)"
    if [ "$volcado_antiguo" = 1 ]; then ops+=",$OP_RETIRAR_CERT_ANTIGUO"; fi
    ops+="]"
    if motor_cambios "$ops"; then
      CERT_CONFIGURADO=1
      RESUMEN_CERT="Let's Encrypt emitido por el propio motor (DNS-01 en Cloudflare); tarda unos minutos"
      ok "Certificado de IMAP/SMTP solicitado a Let's Encrypt por DNS-01."
      if [ "$volcado_antiguo" = 1 ]; then
        ok "Retirado certificate.default, el certificado de la instalación anterior: el motor pasa a usar el de Let's Encrypt."
      fi
      extractor_con_acme "$con_volcado" "$volcado_antiguo"
    else
      aviso "No se pudo configurar la emisión del certificado; puede repetirse en Ajustes → Servidor de correo."
    fi
    return 0
  fi

  # Sin Cloudflare: el extractor lleva al motor el certificado que Traefik
  # obtiene para el nombre del servidor de correo (y solo ese).
  if [ "$CON_SKYWAY" = 1 ] && [ -z "$TRAEFIK_ACME_VOLUME" ]; then
    aviso "No se encontró el volumen de certificados de Traefik: emite el certificado desde Ajustes → Servidor de correo."
    return 0
  fi
  if [ "$CON_SKYWAY" = 0 ] && [ "$USAR_PROXY_PROPIO" = 0 ]; then
    aviso "Sin proxy propio ni Cloudflare, el certificado de IMAP/SMTP se emite desde Ajustes → Servidor de correo."
    return 0
  fi
  info "Extrayendo el certificado que obtiene Traefik para $MAIL_HOSTNAME…"
  if ! arrancar_extractor; then
    aviso "No se pudo arrancar el extractor del certificado. Revisa: docker logs mailway-certs-dumper"
    return 0
  fi
  local t=0 ruta="/opt/stalwart/certs/$MAIL_HOSTNAME"
  while [ "$t" -lt 180 ]; do
    if docker exec mailway-mail test -s "$ruta/cert.pem" 2>/dev/null; then break; fi
    sleep 5
    t=$((t + 5))
  done
  if ! docker exec mailway-mail test -s "$ruta/cert.pem" 2>/dev/null; then
    RESUMEN_CERT="pendiente: Traefik aún no tiene el certificado de $MAIL_HOSTNAME (vuelve a ejecutar con --actualizar)"
    aviso "Traefik aún no tiene el certificado de $MAIL_HOSTNAME. Cuando el DNS apunte aquí, ejecuta de nuevo con --actualizar."
    return 0
  fi
  if motor_ajustes \
    certificate.mailway.cert "%{file:$ruta/cert.pem}%" \
    certificate.mailway.private-key "%{file:$ruta/key.pem}%" \
    certificate.mailway.default true \
    certificate.mailway.subjects.0 "$MAIL_HOSTNAME"; then
    motor_api GET /api/reload/certificate >/dev/null || true
    CERT_CONFIGURADO=1
    comprobar_extractor
  else
    aviso "No se pudo configurar el certificado de Traefik en el motor; revisa Ajustes → Servidor de correo."
  fi
}

# Extractor del certificado de Traefik (servicio certs-dumper, perfil «tls»;
# deploy/tls/extractor.py). Se recrea siempre: así arranca con el código
# actual tras un «git pull» y, en las instalaciones anteriores, sustituye al
# volcado de traefik-certs-dumper, que copiaba al volumen del motor las claves
# privadas de todos los dominios de Traefik (el extractor retira esas copias).
arrancar_extractor() {
  compose_q --profile tls up -d --force-recreate certs-dumper
}

# Espera a que el extractor confirme que el motor sirve el certificado en 993
# y 465. Mientras no lo logra, lo comprueba cada 30 segundos.
esperar_extractor() {
  local t=0 max=${1:-150}
  while [ "$t" -lt "$max" ]; do
    if docker exec mailway-certs-dumper python /app/extractor.py estado >/dev/null 2>&1; then return 0; fi
    sleep 5
    t=$((t + 5))
  done
  return 1
}

comprobar_extractor() {
  info "Esperando a que el extractor compruebe el certificado que sirve el motor en 993 y 465…"
  if esperar_extractor 150; then
    RESUMEN_CERT="el de Traefik, aplicado por el extractor y comprobado en 993 y 465 (lo renueva solo)"
    ok "El motor sirve en 993 y 465 el certificado de Traefik para $MAIL_HOSTNAME."
  else
    RESUMEN_CERT="el de Traefik, configurado; el extractor aún no lo ha comprobado (deploy/instalar.sh --comprobar)"
    aviso "El extractor aún no ha comprobado el certificado. Estado: docker exec mailway-certs-dumper python /app/extractor.py estado"
  fi
}

# La guía 0.x arrancaba traefik-certs-dumper y apuntaba certificate.default
# a los ficheros que volcaba para el servidor de correo: las mismas rutas en
# las que escribe hoy el extractor. La migración retira ese volcador, así que
# un certificate.default así no es un certificado propio: sin el extractor,
# nadie lo renovaría. Uno con otras rutas sí lo es, y se respeta.
#   certificado_del_volcado_antiguo <respuesta de /api/settings/keys>
certificado_del_volcado_antiguo() {
  local ruta="/opt/stalwart/certs/$MAIL_HOSTNAME" cert clave
  printf '%s' "$1" | grep -q '"certificate.default.cert"' || return 1
  cert=$(printf '%s' "$1" | jqr -r '.data["certificate.default.cert"] // "" | gsub("^\\s+|\\s+$"; "")' 2>/dev/null || true)
  clave=$(printf '%s' "$1" | jqr -r '.data["certificate.default.private-key"] // "" | gsub("^\\s+|\\s+$"; "")' 2>/dev/null || true)
  [ "$cert" = "%{file:$ruta/cert.pem}%" ] && [ "$clave" = "%{file:$ruta/key.pem}%" ]
}

# Borra certificate.default.* (con el punto: no toca otros identificadores
# que empiecen igual).
OP_RETIRAR_CERT_ANTIGUO='{"type":"clear","prefix":"certificate.default."}'

# Instalación de la guía 0.x sin Cloudflare: el mismo certificado pasa a
# certificate.mailway (las rutas que mantiene el extractor, con el nombre del
# servidor como sujeto explícito) y certificate.default se borra en la misma
# petición, después: el motor no se queda sin certificado en ningún momento.
# El extractor sustituye al volcado antiguo y retira del volumen las claves de
# los demás dominios que este copiaba.
pasar_volcado_antiguo_al_extractor() {
  local ruta="/opt/stalwart/certs/$MAIL_HOSTNAME"
  info "El motor usa el certificado que volcaba traefik-certs-dumper (instalación anterior): pasa al extractor, que lo renueva."
  CERT_CONFIGURADO=1
  if ! motor_cambios "[$(motor_op_insertar \
    certificate.mailway.cert "%{file:$ruta/cert.pem}%" \
    certificate.mailway.private-key "%{file:$ruta/key.pem}%" \
    certificate.mailway.default true \
    certificate.mailway.subjects.0 "$MAIL_HOSTNAME"),$OP_RETIRAR_CERT_ANTIGUO]"; then
    RESUMEN_CERT="el de la instalación anterior, SIN RENOVACIÓN: no se pudo pasar al extractor (repite con --actualizar)"
    aviso "No se pudo pasar el certificado al extractor: el motor sigue con el de la instalación anterior, que nadie renueva. Repite con --actualizar."
    return 0
  fi
  motor_api GET /api/reload/certificate >/dev/null || true
  ok "Certificado del motor en certificate.mailway; retirado certificate.default."
  aplicar_extractor
}

# Con el ACME del motor, el certificate.default de la guía 0.x sobra: apunta a
# ficheros que ya nadie renueva y competiría con el certificado de ACME.
retirar_certificado_antiguo() {
  if motor_cambios "[$OP_RETIRAR_CERT_ANTIGUO]"; then
    ok "Retirado certificate.default, el certificado de la instalación anterior: el motor pasa a usar el de Let's Encrypt."
  else
    aviso "No se pudo retirar certificate.default, el certificado de la instalación anterior, que ya nadie renueva. Bórralo en la web del motor (Settings → TLS → Certificates)."
  fi
}

aplicar_extractor() {
  if ! arrancar_extractor; then
    RESUMEN_CERT="el de Traefik, pero el extractor no arranca (docker logs mailway-certs-dumper)"
    aviso "No se pudo arrancar el extractor del certificado. Revisa: docker logs mailway-certs-dumper"
    return 0
  fi
  comprobar_extractor
}

# Con el ACME del motor, el extractor solo sigue si el motor conserva además
# certificate.mailway: el motor vuelve a cargar esos ficheros en cada recarga
# de certificados y no deben caducar. Si no, se retira y se limpian del
# volumen las claves de otros dominios que dejó el volcado antiguo: también
# sin contenedor del extractor si el motor venía de ese volcado ($2 = 1), ya
# que la migración retira el contenedor de traefik-certs-dumper.
#   extractor_con_acme <con certificate.mailway: 0|1> [con el volcado antiguo: 0|1]
extractor_con_acme() {
  if [ "$1" = 1 ]; then
    if [ "$CON_SKYWAY" = 1 ] && [ -z "$TRAEFIK_ACME_VOLUME" ]; then return 0; fi
    if arrancar_extractor; then
      info "El motor conserva además certificate.mailway: el extractor mantiene esos ficheros al día sin recargar el motor."
    else
      aviso "No se pudo arrancar el extractor del certificado. Revisa: docker logs mailway-certs-dumper"
    fi
    return 0
  fi
  if docker inspect mailway-certs-dumper >/dev/null 2>&1; then
    docker rm -f mailway-certs-dumper >/dev/null
  elif [ "${2:-0}" != 1 ]; then
    return 0
  fi
  if compose_q --profile tls run --rm --no-deps -T certs-dumper python /app/extractor.py purgar; then
    ok "El motor usa su propio ACME: sin extractor del certificado y con el volumen de certificados limpio."
  else
    aviso "No se pudo limpiar el volumen de certificados del motor. A mano: docker compose --env-file deploy/.env -f deploy/docker-compose.mail.yml --profile tls run --rm --no-deps certs-dumper python /app/extractor.py purgar"
  fi
}

# ----------------------------------------------------------------- Skyway --

# Mensaje de error de la última respuesta de Skyway (o su código HTTP).
sky_error() {
  local mensaje
  mensaje=$(campo_json '.error // empty')
  printf '%s' "${mensaje:-HTTP $RESP_CODE}"
}

# Identificadores de Skyway: van en rutas de la API, así que se exigen simples.
id_simple() { coincide "$1" '^[A-Za-z0-9_-]{1,100}$'; }

# ¿Es la versión $1 igual o posterior a $2?
version_ge() {
  coincide "$1" '^[0-9]+(\.[0-9]+){1,2}' || return 1
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

# Si la API de Skyway no responde en la dirección por defecto, se prueba la IP
# del contenedor «skyway» en cada una de sus redes (puerto 4000): un compose
# propio puede no publicar el puerto en el host. Deja SKYWAY_URL en la que
# responde; si ninguna, la deja como estaba y devuelve 1.
skyway_por_ip_del_contenedor() {
  local original=$SKYWAY_URL ip
  en_marcha skyway || return 1
  for ip in $(docker inspect --type container -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' skyway 2>/dev/null || true); do
    ipv4_valida "$ip" || continue
    SKYWAY_URL="http://$ip:4000"
    sky_api GET /api/health
    if [ "$RESP_CODE" = "200" ]; then return 0; fi
  done
  SKYWAY_URL=$original
  RESP_CODE="000"
  return 1
}

# ------------------------------------------------- panel que ya está en Skyway --
#
# Antes de la 1.0, el panel se creaba a mano en Skyway (con el nombre de
# proyecto y de servicio que cada uno eligiera) y su clave maestra se generaba
# sola en su volumen /data. El instalador tiene que actualizar ESE panel: crear
# otro lo duplicaría, y darle otra MAILWAY_SECRET le haría perder sus secretos
# cifrados (Cloudflare, motor), invalidaría tokens de gestión, claves de API y
# sesiones y cambiaría el TXT _mailway con el que se verificaron los dominios.

# Entorno de un contenedor, una variable por línea.
entorno_contenedor() {
  docker inspect --type container -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null || true
}

# ¿Es un panel de Mailway? Su imagen fija MAILWAY_DATA_DIR desde la primera
# versión: no depende de las variables que se pusieran a mano. Se comprueba
# con bash, sin pasar el entorno (con secretos) a otro programa.
es_panel_mailway() {
  local entorno
  entorno=$'\n'$(entorno_contenedor "$1")
  [[ $entorno == *$'\nMAILWAY_DATA_DIR='* ]]
}

# Guarda en PANEL_EXISTENTE_ENV las variables del panel en ejecución que el
# instalador reutiliza (secretos, nombres e IP).
leer_entorno_panel() {
  local linea clave
  PANEL_EXISTENTE_ENV=()
  while IFS= read -r linea; do
    clave=${linea%%=*}
    case "$clave" in
      MAILWAY_SECRET | MAILWAY_TRAEFIK_TOKEN | MAILWAY_WEBMAIL_TOKEN | MAILWAY_SETUP_TOKEN | \
        STALWART_ADMIN_PASSWORD | MAILWAY_MAIL_HOSTNAME | MAILWAY_WEBMAIL_URL | MAILWAY_PANEL_URL | MAILWAY_PUBLIC_IP | \
        MAILWAY_DATA_DIR)
        if [ "$clave" != "$linea" ]; then PANEL_EXISTENTE_ENV[$clave]=${linea#*=}; fi
        ;;
    esac
  done <<<"$(entorno_contenedor "$1")"
}

# Valor de una variable del panel existente (vacío si no hay panel o no la tiene).
valor_panel() { printf '%s' "${PANEL_EXISTENTE_ENV[$1]:-}"; }

# Como config.ts del panel: una clave maestra solo cuenta con 16 caracteres o
# más, sin los espacios de los extremos. Escribe la clave limpia o nada.
clave_maestra_valida() {
  local c=$1
  c=${c#"${c%%[![:space:]]*}"}
  c=${c%"${c##*[![:space:]]}"}
  if [ "${#c}" -ge 16 ]; then printf '%s' "$c"; fi
}

# Clave maestra con la que arranca el panel existente (contenedor $1, por
# defecto el detectado): la de su entorno si vale y, si no, la de su volumen
# (<MAILWAY_DATA_DIR>/.secret), que es la que usa. Vacía si no se puede saber
# (contenedor parado). Se lee con bash: solo pasa por el «cat» del propio
# contenedor, nunca por argumentos.
clave_maestra_del_panel() {
  local contenedor=${1:-$PANEL_EXISTENTE_CONTENEDOR} clave dir
  clave=$(clave_maestra_valida "$(valor_panel MAILWAY_SECRET)")
  if [ -z "$clave" ] && [ -n "$contenedor" ] && en_marcha "$contenedor"; then
    dir=$(valor_panel MAILWAY_DATA_DIR)
    dir=${dir:-/data}
    if coincide "$dir" '^/[A-Za-z0-9._/-]*$'; then
      clave=$(clave_maestra_valida "$(docker exec "$contenedor" cat "$dir/.secret" 2>/dev/null || true)")
    fi
  fi
  printf '%s' "$clave"
}

# Nombre de una URL (https://Panel.x.com:443/ruta → panel.x.com).
host_de_url() {
  local resto=${1#*://}
  resto=${resto%%/*}
  resto=${resto%%:*}
  printf '%s' "$resto" | tr '[:upper:]' '[:lower:]'
}

# Primer Host(`…`) de las reglas de Traefik de un contenedor: el dominio con
# el que Skyway publica el panel.
host_traefik_contenedor() {
  local etiquetas linea re='Host\(`([^`]+)`\)'
  etiquetas=$(docker inspect --type container \
    -f '{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{println}}{{end}}' "$1" 2>/dev/null || true)
  while IFS= read -r linea; do
    case "$linea" in traefik.http.routers.*.rule=*) ;; *) continue ;; esac
    if [[ $linea =~ $re ]]; then
      printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]'
      return 0
    fi
  done <<<"$etiquetas"
}

# Contenedores que despliega Skyway (con -a, también los parados).
contenedores_skyway() {
  docker ps "$@" --filter label=skyway.service --format '{{.Names}}' 2>/dev/null || true
}

# Servicio de Skyway del panel que ya conoce deploy/.env (una ejecución
# anterior de la 1.0 guarda su contenedor en MAILWAY_PANEL_INTERNAL_URL).
servicio_del_panel_conocido() {
  local url c servicio re='^http://([a-z0-9][a-z0-9_.-]*):[0-9]{1,5}$'
  url=$(leer_env MAILWAY_PANEL_INTERNAL_URL)
  [[ $url =~ $re ]] || return 0
  c=${BASH_REMATCH[1]}
  servicio=$(docker inspect --type container -f '{{index .Config.Labels "skyway.service"}}' "$c" 2>/dev/null || true)
  if id_simple "$servicio"; then printf '%s' "$servicio"; fi
}

# Acceso a la API de Skyway antes de tiempo y sin preguntar (token temporal y
# dirección que responde), para saber de quién es un panel antes de usar
# nada suyo. Devuelve 1 si aún no se puede; desplegar_en_skyway lo resuelve
# después como siempre.
preparar_api_skyway_en_silencio() {
  if [ -n "${SKYWAY_URL:-}" ] && ! coincide "$SKYWAY_URL" '^https?://[][A-Za-z0-9.:-]+(/[A-Za-z0-9._~/-]*)?$'; then
    return 1
  fi
  if [ -z "${SKYWAY_TOKEN:-}" ]; then
    crear_token_temporal_skyway >/dev/null 2>&1 || return 1
    ok "Token temporal de Skyway creado (caduca en 60 minutos y se revoca al terminar)."
  fi
  if [ -z "${SKYWAY_URL:-}" ]; then SKYWAY_URL_AUTOMATICA=1; fi
  SKYWAY_URL=${SKYWAY_URL:-http://127.0.0.1:4000}
  SKYWAY_URL=${SKYWAY_URL%/}
  sky_api GET /api/health
  [ "$RESP_CODE" = "200" ] || skyway_por_ip_del_contenedor
}

# ¿Es de un proyecto de un cliente (workspace) el contenedor $1? Solo se sabe
# si la API de Skyway responde; si no, o si no existe, devuelve 1.
contenedor_de_cliente() {
  local proyecto
  proyecto=$(docker inspect --type container -f '{{index .Config.Labels "skyway.project"}}' "$1" 2>/dev/null || true)
  id_simple "$proyecto" || return 1
  preparar_api_skyway_en_silencio || return 1
  sky_api GET "/api/projects/$proyecto"
  [ "$RESP_CODE" = "200" ] && [ -n "$(campo_json '.project.workspace_id // empty')" ]
}

# Busca el panel entre los contenedores de Skyway antes de preguntar nada,
# para proponer sus nombres y conservar su clave y sus secretos. Primero los
# que están en marcha; si no hay ninguno, también los parados.
#   - MAILWAY_PANEL_SERVICIO=<id> lo indica a mano; =ninguno, no se adopta nada.
#   - El que nombra deploy/.env (MAILWAY_PANEL_INTERNAL_URL) es el de siempre.
#   - Si no, se ignoran los de proyectos de clientes (workspaces) y, antes de
#     usar nada del que queda, se pregunta si es el de esta instalación: en
#     un Skyway con clientes, otro puede desplegar también un Mailway.
detectar_panel_existente() {
  [ "$CON_SKYWAY" = 1 ] || return 0
  local forzado=${MAILWAY_PANEL_SERVICIO:-} conocido="" c servicio vistos=" " par
  local -a encontrados=() propios=()
  if [ "$forzado" = ninguno ]; then
    PANEL_SIN_ADOPCION=1
    return 0
  fi
  if [ -n "$forzado" ] && ! id_simple "$forzado"; then
    fallo "MAILWAY_PANEL_SERVICIO no es un identificador de servicio de Skyway válido."
  fi
  if [ -z "$forzado" ]; then conocido=$(servicio_del_panel_conocido); fi
  for par in en-marcha todos; do
    while IFS= read -r c; do
      [ -n "$c" ] || continue
      servicio=$(docker inspect --type container -f '{{index .Config.Labels "skyway.service"}}' "$c" 2>/dev/null || true)
      id_simple "$servicio" || continue
      # Las réplicas y los contenedores de un despliegue anterior son el mismo servicio.
      case "$vistos" in *" $servicio "*) continue ;; esac
      vistos+="$servicio "
      if [ -n "$forzado$conocido" ]; then
        [ "$servicio" = "${forzado:-$conocido}" ] || continue
      else
        es_panel_mailway "$c" || continue
      fi
      encontrados+=("$servicio $c")
    done < <(if [ "$par" = en-marcha ]; then contenedores_skyway; else contenedores_skyway -a; fi)
    [ "${#encontrados[@]}" -eq 0 ] || break
  done
  if [ "${#encontrados[@]}" -eq 0 ]; then
    # Indicado pero sin contenedor (parado y retirado): se localiza por la API.
    PANEL_EXISTENTE_SERVICIO=$forzado
    return 0
  fi
  titulo "Panel existente en Skyway"

  if [ -z "$forzado$conocido" ] && preparar_api_skyway_en_silencio; then
    for par in "${encontrados[@]}"; do
      sky_api GET "/api/services/${par%% *}"
      if [ "$RESP_CODE" = "200" ] && [ -n "$(campo_json '.project.workspace_id // empty')" ]; then
        info "Se ignora el panel de Mailway del contenedor ${par#* }: es de un proyecto de un cliente."
        continue
      fi
      propios+=("$par")
    done
    encontrados=(${propios[@]+"${propios[@]}"})
    if [ "${#encontrados[@]}" -eq 0 ]; then return 0; fi
  fi
  if [ "${#encontrados[@]}" -gt 1 ]; then
    aviso "Skyway despliega varios paneles de Mailway:"
    for par in "${encontrados[@]}"; do info "servicio ${par%% *} (contenedor ${par#* })"; done
    fallo "Indica el de esta instalación con MAILWAY_PANEL_SERVICIO=<servicio> y vuelve a ejecutar."
  fi

  servicio=${encontrados[0]%% *}
  c=${encontrados[0]#* }
  leer_entorno_panel "$c"
  PANEL_EXISTENTE_HOST=$(host_de_url "$(valor_panel MAILWAY_PANEL_URL)")
  if ! host_valido "$PANEL_EXISTENTE_HOST"; then
    PANEL_EXISTENTE_HOST=$(host_traefik_contenedor "$c")
    host_valido "$PANEL_EXISTENTE_HOST" || PANEL_EXISTENTE_HOST=""
  fi
  if [ -z "$forzado$conocido" ] && { [ -z "$PANEL_EXISTENTE_HOST" ] || [ "$PANEL_EXISTENTE_HOST" != "$(leer_env PANEL_HOSTNAME)" ]; }; then
    info "Skyway despliega un panel de Mailway: contenedor $c${PANEL_EXISTENTE_HOST:+, https://$PANEL_EXISTENTE_HOST}."
    if [ "$INTERACTIVO" != 1 ]; then
      fallo "deploy/.env no menciona ese panel. Para actualizarlo, indica MAILWAY_PANEL_SERVICIO=$servicio; para no tocarlo, MAILWAY_PANEL_SERVICIO=ninguno."
    fi
    if ! confirmar "¿Es el panel de esta instalación? Se actualizará ese, sin crear otro, conservando su clave maestra y sus datos." s; then
      PANEL_EXISTENTE_ENV=()
      PANEL_EXISTENTE_HOST=""
      PANEL_SIN_ADOPCION=1
      PANEL_RECHAZADO=$servicio
      info "No se toca ese panel."
      return 0
    fi
  fi
  PANEL_EXISTENTE_SERVICIO=$servicio
  PANEL_EXISTENTE_CONTENEDOR=$c
  ok "Se actualiza el panel que ya despliega Skyway (contenedor $c${PANEL_EXISTENTE_HOST:+, $PANEL_EXISTENTE_HOST}), sin crear otro."
}

# Repositorio de GitHub normalizado para compararlo (https://github.com/A/B.git,
# github.com/a/b y A/B son el mismo).
NORMALIZAR_REPO='def norm: ascii_downcase | sub("^\\s+"; "") | sub("\\s+$"; "") | sub("^git@github\\.com:"; "")
  | sub("^[a-z+]+://"; "") | sub("^www\\."; "") | sub("^github\\.com/"; "") | sub("/+$"; "") | sub("\\.git$"; "");'

# Decide qué servicio de Skyway es el panel y lo deja en PANEL_ADOPTADO:
#   1. el detectado por su contenedor (o indicado con MAILWAY_PANEL_SERVICIO);
#   2. si no, el único servicio git de cualquier proyecto que despliega el
#      repositorio de Mailway ($1), se llame como se llame.
# Si no hay ninguno, PANEL_ADOPTADO queda vacío y se usa (o crea) el proyecto
# «mailway» con el servicio «panel». Necesita el token de Skyway.
localizar_panel_en_skyway() {
  local repo=$1 proyectos id coincidencias="" n
  PANEL_ADOPTADO=""
  if [ "$PANEL_SIN_ADOPCION" = 1 ]; then return 0; fi
  if [ -n "$PANEL_EXISTENTE_SERVICIO" ]; then
    sky_api GET "/api/services/$PANEL_EXISTENTE_SERVICIO"
    case "$RESP_CODE" in
      200) ;;
      401) fallo "Skyway rechazó el token: no existe, ha caducado o se ha revocado." ;;
      *) fallo "No se pudo leer el servicio del panel en Skyway ($PANEL_EXISTENTE_SERVICIO): $(sky_error)." ;;
    esac
    # Red de seguridad: detectar_panel_existente ya descarta los de clientes
    # cuando la API responde a tiempo. Solo se acepta si se indicó a mano.
    if [ -n "$(campo_json '.project.workspace_id // empty')" ] && [ -z "${MAILWAY_PANEL_SERVICIO:-}" ]; then
      # Pasa si en Skyway se asigna el proyecto del panel a un cliente: sus
      # miembros verían sus variables (clave maestra, tokens). Se dice cuál y
      # cómo seguir, con la orden lista para copiar.
      local cliente_panel
      cliente_panel=$(campo_json '.project.client // empty')
      aviso "El proyecto «$(campo_json '.project.name // empty')» del panel está asignado a ${cliente_panel:+«$cliente_panel», }un cliente de Skyway."
      info "Si ese cliente eres tú (nadie más entra en él), sigue con:"
      info "  MAILWAY_PANEL_SERVICIO=$PANEL_EXISTENTE_SERVICIO mailway update -y --reaplicar"
      info "Si es de otra persona, quítale el cliente al proyecto en Skyway y repite «mailway update -y --reaplicar»."
      fallo "El panel detectado es de un proyecto de un cliente y no se toca. Si de verdad es el de esta instalación, indícalo con MAILWAY_PANEL_SERVICIO=$PANEL_EXISTENTE_SERVICIO."
    fi
    PANEL_ADOPTADO=$(campo_json '"\(.project.id) \(.project.slug) \(.service.id) \(.service.slug)"')
    return 0
  fi

  # Sin contenedor (parado y retirado): el único servicio git que despliega el
  # repositorio de Mailway en un proyecto propio (no de un cliente).
  sky_api GET /api/projects
  case "$RESP_CODE" in
    200) ;;
    401) fallo "Skyway rechazó el token: no existe, ha caducado o se ha revocado." ;;
    *) fallo "No se pudieron leer los proyectos de Skyway: $(sky_error)." ;;
  esac
  proyectos=$(campo_json '(.projects // [])[] | select((.workspace_id // "") == "") | .id')
  for id in $proyectos; do
    id_simple "$id" || continue
    sky_api GET "/api/projects/$id"
    [ "$RESP_CODE" = "200" ] || continue
    # $(…) quita los saltos de línea finales: se añade uno por proyecto.
    coincidencias+=$(campo_json --arg r "$repo" "$NORMALIZAR_REPO"'
      .project as $p | (.services // [])[]
      | select(.type == "git" and ((.config.repoUrl // "") | norm) == ($r | norm))
      | "\($p.id) \($p.slug) \(.id) \(.slug)"')$'\n'
  done
  n=$(printf '%s' "$coincidencias" | grep -c . || true)
  if [ "$n" -gt 1 ]; then
    aviso "Hay varios servicios en Skyway que despliegan $repo:"
    printf '%s' "$coincidencias" | while read -r _ proyecto id servicio; do
      if [ -n "$id" ]; then info "servicio «$servicio» del proyecto «$proyecto» (id $id)"; fi
    done
    fallo "Indica el del panel con MAILWAY_PANEL_SERVICIO=<id del servicio> y vuelve a ejecutar."
  fi
  [ "$n" = 1 ] || return 0

  # Antes de tocarlo: es el que nombra deploy/.env (contenedor o dominio), o
  # lo confirma quien instala.
  local candidato p_slug s_id s_slug
  candidato=$(printf '%s' "$coincidencias" | grep -m 1 .)
  read -r _ p_slug s_id s_slug <<<"$candidato"
  id_simple "$s_id" || fallo "Respuesta inesperada de Skyway al leer los servicios."
  sky_api GET "/api/services/$s_id"
  [ "$RESP_CODE" = "200" ] || fallo "No se pudo leer el servicio del panel en Skyway ($s_id): $(sky_error)."
  if [ "http://skyway-$p_slug-$s_slug:4100" != "$(leer_env MAILWAY_PANEL_INTERNAL_URL)" ] &&
    [ -z "$(campo_json --arg d "$(leer_env PANEL_HOSTNAME)" '(.service.config.domains // [])[] | select(. == $d and $d != "")')" ]; then
    info "Skyway despliega $repo en el servicio «$(campo_json '.service.name // empty')» del proyecto «$(campo_json '.project.name // empty')»."
    if [ "$INTERACTIVO" != 1 ]; then
      fallo "deploy/.env no menciona ese servicio. Para actualizarlo, indica MAILWAY_PANEL_SERVICIO=$s_id; para no tocarlo, MAILWAY_PANEL_SERVICIO=ninguno."
    fi
    if ! confirmar "¿Es el panel de esta instalación? Se actualizará ese, sin crear otro, conservando su clave maestra y sus datos." s; then
      PANEL_SIN_ADOPCION=1
      PANEL_RECHAZADO=$s_id
      info "No se toca ese servicio."
      return 0
    fi
  fi
  PANEL_ADOPTADO=$candidato
  return 0
}

desplegar_en_skyway() {
  titulo "Panel en Skyway"
  local url_indicada=${SKYWAY_URL:+1}
  if [ "$SKYWAY_URL_AUTOMATICA" = 1 ]; then url_indicada=""; fi
  SKYWAY_URL=${SKYWAY_URL:-http://127.0.0.1:4000}
  SKYWAY_URL=${SKYWAY_URL%/}
  coincide "$SKYWAY_URL" '^https?://[][A-Za-z0-9.:-]+(/[A-Za-z0-9._~/-]*)?$' ||
    fallo "SKYWAY_URL no es una dirección válida: «$SKYWAY_URL» (p. ej. http://127.0.0.1:4000)."
  # Sin token: si Skyway corre en este servidor, uno temporal creado desde su
  # terminal (caduca en 60 minutos y se revoca al terminar). Si no, se pide.
  # El token temporal puede existir ya (lo crea detectar_panel_existente para
  # saber de quién es un panel): entonces no se pregunta nada.
  if [ -z "$SKY_TOKEN_TEMPORAL_ID" ] && { [ -n "${SKYWAY_TOKEN:-}" ] || ! crear_token_temporal_skyway; }; then
    if [ "$INTERACTIVO" = 1 ] && [ -z "${SKYWAY_TOKEN:-}" ]; then
      info "Con un token de API de Skyway (Mi perfil → Tokens de API, «sky_…») se despliega el panel"
      info "desde GitHub con su dominio, volumen y variables. Intro para hacerlo a mano después."
    fi
    preguntar_secreto SKYWAY_TOKEN "Token de API de Skyway" "${SKYWAY_TOKEN:-}"
  fi
  if [ -z "$SKYWAY_TOKEN" ]; then
    info "Omitido. Variables del panel para crearlo a mano: consulta el final de deploy/.env.example."
    return 0
  fi
  coincide "$SKYWAY_TOKEN" '^sky_[A-Za-z0-9_-]{8,200}$' ||
    fallo "El token de Skyway no es válido: debe empezar por «sky_» (Mi perfil → Tokens de API)."

  sky_api GET /api/health
  if [ "$RESP_CODE" != "200" ] && [ -z "$url_indicada" ] && skyway_por_ip_del_contenedor; then
    info "Skyway no publica su API en 127.0.0.1:4000: se usa la de su contenedor ($SKYWAY_URL)."
  fi
  if [ "$RESP_CODE" != "200" ]; then
    # Con el token temporal nadie ha pedido desplegar el panel: como sin
    # token, se omite y la instalación sigue (motor y webmail ya están en
    # marcha). Con un token indicado, sí es un error.
    if [ -n "$SKY_TOKEN_TEMPORAL_ID" ]; then
      revocar_token_temporal_skyway
      RESUMEN_SKYWAY="omitido: Skyway no responde en $SKYWAY_URL"
      aviso "Skyway no responde en $SKYWAY_URL: no se despliega el panel. Indica su API con SKYWAY_URL y repite con --actualizar, o crea el panel a mano (variables al final de deploy/.env.example)."
      return 0
    fi
    fallo "Skyway no responde en $SKYWAY_URL (variable SKYWAY_URL)."
  fi
  SKYWAY_VERSION=$(campo_json '.version // empty')
  ok "Skyway ${SKYWAY_VERSION:-(versión desconocida)} en $SKYWAY_URL"

  local repo rama
  repo=${MAILWAY_REPO:-https://github.com/NkrowOne/Mailway}
  rama=${MAILWAY_RAMA:-main}
  if tiene_control "$repo$rama"; then fallo "MAILWAY_REPO o MAILWAY_RAMA contienen caracteres de control."; fi

  # El panel que Skyway ya despliega (aunque se creara a mano con otro nombre)
  # se actualiza; solo sin él se usa o crea el proyecto «mailway».
  local proyecto proyecto_id proyecto_slug servicio="" servicio_id servicio_slug
  localizar_panel_en_skyway "$repo"
  if [ -n "$PANEL_ADOPTADO" ]; then
    read -r proyecto_id proyecto_slug servicio_id servicio_slug <<<"$PANEL_ADOPTADO"
    if ! id_simple "$proyecto_id" || ! id_simple "$proyecto_slug" || ! id_simple "$servicio_id" ||
      ! id_simple "$servicio_slug"; then
      fallo "Respuesta inesperada de Skyway al leer el servicio del panel."
    fi
    servicio="$servicio_id $servicio_slug"
    ok "Se actualiza el panel que ya despliega Skyway (servicio «$servicio_slug» del proyecto «$proyecto_slug»)."
  else
    local nombre_proyecto
    nombre_proyecto=${MAILWAY_PROYECTO:-mailway}
    if tiene_control "$nombre_proyecto" || [ "${#nombre_proyecto}" -gt 60 ]; then
      fallo "Nombre de proyecto no válido (variable MAILWAY_PROYECTO): hasta 60 caracteres, sin caracteres de control."
    fi
    sky_api GET /api/projects
    [ "$RESP_CODE" = "200" ] || fallo "No se pudieron leer los proyectos de Skyway: $(sky_error)."
    proyecto=$(campo_json --arg n "$nombre_proyecto" \
      'first((.projects // [])[] | select((.workspace_id // "") == "" and (.slug == $n or .name == $n))) | "\(.id) \(.slug)"')
    if [ -z "$proyecto" ]; then
      sky_api POST /api/projects "{\"name\":\"$(json_escape "$nombre_proyecto")\"}"
      [ "$RESP_CODE" = "201" ] || [ "$RESP_CODE" = "200" ] ||
        fallo "No se pudo crear el proyecto en Skyway: $(sky_error). Usa un token de un administrador o propietario."
      proyecto=$(campo_json '.project | "\(.id) \(.slug)"')
      ok "Proyecto «$nombre_proyecto» creado en Skyway."
    else
      ok "Proyecto «$nombre_proyecto» ya existe en Skyway."
    fi
    read -r proyecto_id proyecto_slug <<<"$proyecto"
    if ! id_simple "$proyecto_id" || ! id_simple "$proyecto_slug"; then
      fallo "Respuesta inesperada de Skyway al leer el proyecto."
    fi
    sky_api GET "/api/projects/$proyecto_id"
    [ "$RESP_CODE" = "200" ] || fallo "No se pudo leer el proyecto de Skyway: $(sky_error)."
    # Un proyecto de un cliente nunca: se busca, y se vuelve a comprobar aquí.
    [ -z "$(campo_json '.project.workspace_id // empty')" ] ||
      fallo "El proyecto «$nombre_proyecto» de Skyway es de un cliente: elige otro con MAILWAY_PROYECTO=<nombre>."
    servicio=$(campo_json 'first((.services // [])[] | select(.name == "panel" and .type == "git")) | "\(.id) \(.slug)"')
    if [ -n "$servicio" ]; then
      if [ "${servicio%% *}" = "$PANEL_RECHAZADO" ]; then
        fallo "El servicio «panel» del proyecto «$nombre_proyecto» es el que has dicho que no es de esta instalación: elige otro proyecto con MAILWAY_PROYECTO=<nombre>."
      fi
      [ -n "$(campo_json --arg r "$repo" "$NORMALIZAR_REPO"'(.services // [])[] | select(.name == "panel" and .type == "git" and ((.config.repoUrl // "") | norm) == ($r | norm)) | .id')" ] ||
        fallo "El servicio «panel» del proyecto «$nombre_proyecto» no despliega $repo: elige otro proyecto con MAILWAY_PROYECTO=<nombre>."
    fi
  fi

  # Sin MAILWAY_SMTP_ALLOW_SELF_SIGNED: el panel verifica el certificado del
  # SMTP interno contra el nombre del servidor de correo.
  local variables
  variables=$(env_json \
    "STALWART_URL=http://mailway-mail:8080" \
    "STALWART_ADMIN_USER=admin" \
    "STALWART_ADMIN_PASSWORD=$STALWART_ADMIN_PASSWORD" \
    "STALWART_SMTP_HOST=mailway-mail" \
    "STALWART_SMTP_PORT=587" \
    "MAILWAY_SECRET=$MAILWAY_SECRET" \
    "MAILWAY_SETUP_TOKEN=$MAILWAY_SETUP_TOKEN" \
    "MAILWAY_TRAEFIK_TOKEN=$MAILWAY_TRAEFIK_TOKEN" \
    "MAILWAY_WEBMAIL_TOKEN=$MAILWAY_WEBMAIL_TOKEN" \
    "MAILWAY_MAIL_HOSTNAME=$MAIL_HOSTNAME" \
    "MAILWAY_PUBLIC_IP=$IP_PUBLICA" \
    "MAILWAY_WEBMAIL_URL=https://$WEBMAIL_HOSTNAME" \
    "MAILWAY_PANEL_URL=https://$PANEL_HOSTNAME" \
    "MAILWAY_ENGINE_TRUSTED_NETWORK=$INTERNAL_SUBNET")
  [ -n "$variables" ] || fallo "No se pudieron preparar las variables del panel."

  local despliegue_inicial
  if [ -z "$servicio" ]; then
    local cuerpo
    cuerpo=$(printf '{"type":"git","name":"panel","repoUrl":"%s","branch":"%s","port":4100,"domains":["%s"],"autoDeploy":true,"env":%s}' \
      "$(json_escape "$repo")" "$(json_escape "$rama")" "$PANEL_HOSTNAME" "$variables")
    sky_api POST "/api/projects/$proyecto_id/services" "$cuerpo"
    [ "$RESP_CODE" = "201" ] || [ "$RESP_CODE" = "200" ] ||
      fallo "No se pudo crear el servicio del panel: $(sky_error)."
    servicio=$(campo_json '.service | "\(.id) \(.slug)"')
    despliegue_inicial=$(campo_json '.deployment.id // empty')
    # El alta despliega al instante, aún sin volumen: ese despliegue se
    # cancela y se repite con /data persistente.
    if id_simple "$despliegue_inicial"; then sky_api POST "/api/deployments/$despliegue_inicial/cancel"; fi
    ok "Servicio «panel» creado (repositorio $repo, rama $rama)."
  else
    # Variables: se fusionan con las existentes (PUT reemplaza la lista entera).
    read -r servicio_id servicio_slug <<<"$servicio"
    id_simple "$servicio_id" || fallo "Respuesta inesperada de Skyway al leer el servicio del panel."
    sky_api GET "/api/services/$servicio_id/env"
    [ "$RESP_CODE" = "200" ] || fallo "No se pudieron leer las variables del panel: $(sky_error)."
    local fusion retirar=false
    # Instalaciones anteriores desactivaban la verificación del certificado
    # del SMTP interno; con el certificado ya configurado deja de hacer falta.
    if [ "$CERT_CONFIGURADO" = 1 ]; then retirar=true; fi
    # La clave maestra y el token de Traefik de un panel que ya existe no se
    # tocan nunca: si están en sus variables se conservan, y si no (un panel
    # anterior a la 1.0 los guarda en /data y en su base de datos) no se
    # añaden. Con otra clave perdería sus secretos y sus tokens; con otro
    # token, quien consulta sus rutas de Traefik dejaría de tener acceso.
    fusion=$(printf '%s\n%s' "$RESP_BODY" "$variables" | jqr -s -c --argjson retirar "$retirar" \
      '(.[0].vars // {}) as $antes | {vars: (reduce ("MAILWAY_SECRET", "MAILWAY_TRAEFIK_TOKEN") as $k
        ($antes + .[1] | if $retirar then del(.MAILWAY_SMTP_ALLOW_SELF_SIGNED) else . end;
          if ($antes | has($k)) then .[$k] = $antes[$k] else del(.[$k]) end))}' \
      2>/dev/null || true)
    [ -n "$fusion" ] || fallo "Respuesta inesperada de Skyway al leer las variables del panel."
    # deploy/.env debe guardar lo que de verdad usa el panel (o nada), no un
    # valor propio que alguien podría copiar después a sus variables.
    local clave_real token_real cambios=0
    clave_real=$(clave_maestra_valida "$(campo_json '.vars.MAILWAY_SECRET // empty')")
    if [ -z "$clave_real" ]; then clave_real=$(clave_maestra_del_panel "skyway-$proyecto_slug-$servicio_slug"); fi
    if [ "$clave_real" != "$MAILWAY_SECRET" ]; then
      if [ -n "$clave_real" ] && [ -n "$MAILWAY_SECRET" ]; then
        aviso "La clave maestra del panel no coincide con la de deploy/.env: se conserva la del panel."
      fi
      MAILWAY_SECRET=$clave_real
      cambios=1
    fi
    token_real=$(campo_json '.vars.MAILWAY_TRAEFIK_TOKEN // empty')
    if [ -n "$token_real" ]; then TRAEFIK_TOKEN_PROPIO=1; else TRAEFIK_TOKEN_PROPIO=0; fi
    if [ "$token_real" != "$MAILWAY_TRAEFIK_TOKEN" ]; then
      MAILWAY_TRAEFIK_TOKEN=$token_real
      cambios=1
    fi
    if [ "$retirar" = true ] && [ -n "$(campo_json '.vars.MAILWAY_SMTP_ALLOW_SELF_SIGNED // empty')" ]; then
      info "Se retira MAILWAY_SMTP_ALLOW_SELF_SIGNED: el motor ya tiene certificado y el panel lo verifica."
    fi
    sky_api PUT "/api/services/$servicio_id/env" "$fusion"
    [ "$RESP_CODE" = "200" ] || fallo "No se pudieron actualizar las variables del panel: $(sky_error)."
    ok "Servicio «$servicio_slug» ya existe: variables actualizadas."
    if [ "$cambios" = 1 ]; then escribir_env; fi
  fi
  read -r servicio_id servicio_slug <<<"$servicio"
  if ! id_simple "$servicio_id" || ! id_simple "$servicio_slug"; then
    fallo "Respuesta inesperada de Skyway al leer el servicio del panel."
  fi
  PANEL_CONTENEDOR="skyway-$proyecto_slug-$servicio_slug"
  PANEL_SERVICIO_ID=$servicio_id
  PANEL_PROYECTO_ID=$proyecto_id

  # Volumen /data (sin él, la base de datos del panel se perdería en cada
  # despliegue), comprobación de salud y dominio. Se parte de la
  # configuración actual: PATCH sustituye listas enteras y no deben perderse
  # volúmenes o dominios que se hayan añadido a mano. domainsBase son los
  # dominios leídos: si cambian entre la lectura y el PATCH, Skyway no
  # devuelve los quitados (y solo así aplica su DNS automático a los nuevos).
  local parche
  sky_api GET "/api/services/$servicio_id"
  [ "$RESP_CODE" = "200" ] || fallo "No se pudo leer el servicio del panel: $(sky_error)."
  parche=$(campo_json -c --arg d "$PANEL_HOSTNAME" '.service.config as $c | {config: {
      volumes: (($c.volumes // []) | map({containerPath}) | if any(.[]; .containerPath == "/data") then . else . + [{containerPath: "/data"}] end),
      healthcheckPath: ($c.healthcheckPath // "/api/health"),
      domains: (($c.domains // []) | if any(.[]; . == $d) then . else . + [$d] end)
    }, domainsBase: ($c.domains // [])}')
  [ -n "$parche" ] || fallo "Respuesta inesperada de Skyway al leer el servicio del panel."
  sky_api PATCH "/api/services/$servicio_id" "$parche"
  [ "$RESP_CODE" = "200" ] || fallo "No se pudo configurar el volumen del panel: $(sky_error)."
  ok "Volumen /data, comprobación /api/health y dominio $PANEL_HOSTNAME configurados."

  sky_api GET /api/domains/config
  if [ "$RESP_CODE" = "200" ] && [ "$(campo_json '.tls')" != "true" ]; then
    aviso "Skyway no tiene correo de Let's Encrypt: el panel no tendrá HTTPS. Configúralo en Skyway → Ajustes → Dominios."
  fi

  sky_api POST "/api/services/$servicio_id/deploy" '{}'
  [ "$RESP_CODE" = "202" ] || [ "$RESP_CODE" = "200" ] || fallo "No se pudo lanzar el despliegue del panel: $(sky_error)."
  local despliegue estado t=0
  despliegue=$(campo_json '.deployment.id // empty')
  id_simple "$despliegue" || fallo "Respuesta inesperada de Skyway al lanzar el despliegue."
  info "Desplegando el panel (compila desde GitHub; puede tardar varios minutos)…"
  while [ "$t" -lt 1500 ]; do
    sleep 10
    t=$((t + 10))
    sky_api GET "/api/deployments/$despliegue"
    estado=$(campo_json '.deployment.status // empty')
    case "$estado" in
      success)
        RESUMEN_SKYWAY="desplegado ($PANEL_CONTENEDOR)"
        ok "Panel desplegado ($PANEL_CONTENEDOR)."
        return 0
        ;;
      failed | canceled)
        RESUMEN_SKYWAY="despliegue fallido: revisa el registro en Skyway"
        aviso "El despliegue del panel terminó en «$estado». Revisa el registro del despliegue en Skyway (¿acceso de Skyway al repositorio de GitHub?)."
        return 0
        ;;
    esac
  done
  RESUMEN_SKYWAY="desplegando (consulta Skyway)"
  aviso "El despliegue sigue en curso; consulta su estado en Skyway."
}

env_json() {
  local primero=1 par
  printf '{'
  for par in "$@"; do
    if [ "$primero" = 0 ]; then printf ','; fi
    primero=0
    printf '"%s":"%s"' "${par%%=*}" "$(json_escape "${par#*=}")"
  done
  printf '}'
}

# ------------------------------------------------------ emparejado con Skyway --
#
# El panel y Skyway se emparejan con dos herramientas de terminal, sin red de
# entrada y sin que ningún secreto pase por argumentos: quien ejecuta esto ya
# es root en el servidor.
#   - Skyway: node server/dist/tools/token.js (token sky_ temporal) y
#     node server/dist/tools/mailway.js conectar (lee el token mwt_ por la
#     entrada estándar y lo guarda igual que Ajustes → Correo (Mailway)).
#   - Panel: node server/dist/tools/emparejar.js (administrador, puesta en
#     marcha y token de gestión «Skyway»).
#   - Cloudflare: node server/dist/tools/cloudflare.js conectar, en el panel y
#     en Skyway (lee el token de Cloudflare por la entrada estándar).

# Las capturas de =~ quedan en BASH_REMATCH: tras extraer un secreto, una
# coincidencia inocua las sustituye (hasta bash 5.1 no se puede vaciar a mano).
olvidar_coincidencias() { coincide x x; }

# ¿Existe y está en marcha ese contenedor? (--type: una imagen o una red con
# el mismo nombre no cuentan).
en_marcha() { [ "$(docker inspect --type container -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }

# Muestra como avisos lo que una herramienta escribió en su salida de errores
# y lo deja anotado en HERRAMIENTA_CON_AVISOS.
mostrar_errores_herramienta() {
  local linea
  [ -n "$ERR_TMP" ] && [ -f "$ERR_TMP" ] || return 0
  while IFS= read -r linea || [ -n "$linea" ]; do
    linea=${linea#Aviso: }
    if [ -n "$linea" ]; then
      aviso "$linea"
      HERRAMIENTA_CON_AVISOS=1
    fi
  done <"$ERR_TMP"
  rm -f "$ERR_TMP"
  ERR_TMP=""
}

# Fichero para la salida de errores de una herramienta (no lleva secretos).
preparar_errores_herramienta() {
  ERR_TMP=$(mktemp)
  HERRAMIENTA_CON_AVISOS=0
}

# Token de API temporal de Skyway, creado con su herramienta de terminal si
# Skyway corre en este servidor (contenedor «skyway»). Caduca en 60 minutos y
# al_salir lo revoca al terminar, también si la instalación falla.
crear_token_temporal_skyway() {
  local salida="" id="" token="" re_id='"id":"([A-Za-z0-9_-]{1,100})"' re_token='"token":"(sky_[A-Za-z0-9_-]{8,200})"'
  en_marcha skyway || return 1
  if ! docker exec skyway test -f server/dist/tools/token.js 2>/dev/null; then
    info "Esta versión de Skyway no crea tokens desde el servidor: indica uno de Mi perfil → Tokens de API (o actualiza Skyway)."
    return 1
  fi
  preparar_errores_herramienta
  if ! salida=$(docker exec skyway node server/dist/tools/token.js crear \
    --nombre "Instalador de Mailway" --caduca-min 60 </dev/null 2>"$ERR_TMP"); then
    mostrar_errores_herramienta
    aviso "Skyway no ha podido crear un token temporal."
    return 1
  fi
  mostrar_errores_herramienta
  # Se extrae con bash: el JSON lleva el token y no pasa por ningún otro programa.
  if [[ $salida =~ $re_id ]]; then id=${BASH_REMATCH[1]}; fi
  if [[ $salida =~ $re_token ]]; then token=${BASH_REMATCH[1]}; fi
  salida=""
  olvidar_coincidencias
  if [ -z "$id" ] || [ -z "$token" ]; then
    aviso "Respuesta inesperada de la herramienta de tokens de Skyway."
    return 1
  fi
  SKY_TOKEN_TEMPORAL_ID=$id
  SKYWAY_TOKEN=$token
  ok "Token temporal de Skyway creado (caduca en 60 minutos y se revoca al terminar)."
}

revocar_token_temporal_skyway() {
  [ -n "$SKY_TOKEN_TEMPORAL_ID" ] || return 0
  local id=$SKY_TOKEN_TEMPORAL_ID
  SKY_TOKEN_TEMPORAL_ID=""
  SKYWAY_TOKEN=""
  if docker exec skyway node server/dist/tools/token.js revocar --id "$id" </dev/null >/dev/null 2>&1; then
    ok "Token temporal de Skyway revocado."
  else
    aviso "No se pudo revocar el token temporal de Skyway «Instalador de Mailway»: caduca en una hora, o revócalo en Skyway → Mi perfil → Tokens de API."
  fi
}

# Deja constancia de por qué no se ha emparejado y de cómo repetirlo.
aviso_emparejado() {
  RESUMEN_EMPAREJADO="pendiente: $1"
  aviso "$1"
  aviso "Cuando esté resuelto, repite solo el emparejado: sudo bash deploy/instalar.sh --emparejar"
}

# ¿Está Skyway conectado con OTRO panel de Mailway? Entonces no se toca: eso
# solo lo cambia --emparejar. Con este panel (o sin conexión) se empareja
# siempre: la herramienta del panel retoma lo que hubiera quedado pendiente de
# la puesta en marcha (el motor, si no respondía en la ejecución anterior) y
# renovar el token no hace daño, porque «conectar» guarda el nuevo. Necesita
# el token de Skyway (se consulta su API); sin él, se empareja.
skyway_con_otro_panel() {
  [ -n "${SKYWAY_TOKEN:-}" ] || return 1
  local servicio url
  sky_api GET /api/mailway/config
  if [ "$RESP_CODE" != "200" ] || [ "$(campo_json '.configured')" != "true" ]; then return 1; fi
  servicio=$(campo_json '.serviceId // empty')
  url=$(campo_json '.baseUrl // empty' | tr -d '[:cntrl:]')
  if [ "$servicio" = "$PANEL_SERVICIO_ID" ] || [ "${url%/}" = "https://$PANEL_HOSTNAME" ]; then return 1; fi
  titulo "Emparejado del panel con Skyway"
  RESUMEN_EMPAREJADO="sin cambios: Skyway ya está conectado con otro panel de Mailway"
  aviso "Skyway ya está conectado con otro panel de Mailway (${url:-otro servicio}): no se cambia."
  aviso "Para conectarlo con este panel: sudo bash deploy/instalar.sh --emparejar"
  return 0
}

# ------------------------------------------ cuenta de Cloudflare del operador --
#
# El token de Cloudflare que se da al instalar se guarda también en el panel,
# como cuenta de la INSTANCIA, y en Skyway: desde entonces, los dominios que
# da de alta el administrador (de correo en el panel o desde Skyway, y de
# servicios en Skyway) configuran su DNS solos, sin modificar los registros
# que ya existan. Nunca lo usa una acción de un cliente. El token va siempre
# por la entrada estándar de la herramienta de cada uno: como argumento se
# vería en «ps» y en el registro de Docker. No se escribe en deploy/.env, así
# que --actualizar y --emparejar no lo tienen y conservan lo ya conectado.

# Sin token en esta ejecución: lo que haya conectado se conserva.
cloudflare_sin_token() {
  [ -z "$CF_TOKEN" ] || return 1
  if [ "$ACTUALIZAR" = 1 ] || [ "$EMPAREJAR" = 1 ]; then
    RESUMEN_CF_PANEL="sin cambios: esta ejecución no tiene el token (no se guarda en deploy/.env); si el panel ya tenía una cuenta conectada, la conserva"
    info "Cloudflare: esta ejecución no tiene el token; si el panel ya tenía una cuenta conectada, la conserva."
    # --emparejar no pasa por el paso de Cloudflare (no verifica el token ni
    # toca el DNS): quien lo exporta espera que se use, y se le dice dónde.
    if [ "$EMPAREJAR" = 1 ] && [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
      info "--emparejar no usa CLOUDFLARE_API_TOKEN: para conectar o cambiar el token de Cloudflare, repite con --actualizar."
    fi
  fi
  return 0
}

# Guarda el token como cuenta de Cloudflare de la instancia en el panel (que
# debe estar sano). Nunca interrumpe la instalación: un fallo queda en el
# resumen y se explica cómo conectarla a mano.
#   conectar_cloudflare_en_panel <contenedor del panel>
conectar_cloudflare_en_panel() {
  local contenedor=$1 salida="" etiqueta="" zonas="" creada="" sustituida=""
  local re_etiqueta='"label":"([^"\\[:cntrl:]]{1,80})"' re_zonas='"zones":([0-9]{1,6})' re_creada='"creada":(true|false)'
  local re_sustituida='"sustituida":(true|false)'
  local a_mano="conéctala en el panel, en Conexiones → Cloudflare, con el ámbito «Toda la instancia»."
  if cloudflare_sin_token; then return 0; fi
  if ! docker exec "$contenedor" test -f server/dist/tools/cloudflare.js 2>/dev/null; then
    RESUMEN_CF_PANEL="pendiente: el panel desplegado no guarda la cuenta desde el servidor"
    aviso "El panel desplegado no puede guardar la cuenta de Cloudflare desde el servidor: $a_mano"
    return 0
  fi
  # Como el usuario del panel («node»): lo que toque en /data debe seguir siendo suyo.
  preparar_errores_herramienta
  if ! salida=$(printf '%s' "$CF_TOKEN" | docker exec -i -u node "$contenedor" node server/dist/tools/cloudflare.js conectar \
    --nombre "Instalador de Mailway" 2>"$ERR_TMP"); then
    mostrar_errores_herramienta
    RESUMEN_CF_PANEL="pendiente: el panel no ha podido guardar la cuenta"
    aviso "El panel no ha podido guardar la cuenta de Cloudflare: $a_mano"
    return 0
  fi
  mostrar_errores_herramienta
  if [[ $salida =~ $re_etiqueta ]]; then etiqueta=${BASH_REMATCH[1]}; fi
  if [[ $salida =~ $re_zonas ]]; then zonas=${BASH_REMATCH[1]}; fi
  if [[ $salida =~ $re_creada ]]; then creada=${BASH_REMATCH[1]}; fi
  if [[ $salida =~ $re_sustituida ]]; then sustituida=${BASH_REMATCH[1]}; fi
  salida=""
  if [ -z "$creada" ]; then
    RESUMEN_CF_PANEL="pendiente: respuesta inesperada de la herramienta del panel"
    aviso "Respuesta inesperada de la herramienta de Cloudflare del panel: comprueba en Conexiones → Cloudflare que la cuenta está conectada."
    return 0
  fi
  CF_PANEL_CONECTADA=1
  if [ "$creada" = true ]; then
    RESUMEN_CF_PANEL="cuenta de la instancia conectada («${etiqueta:-Cloudflare}», ${zonas:-?} zonas)"
  elif [ "$sustituida" = true ]; then
    RESUMEN_CF_PANEL="token de la cuenta de la instancia sustituido por el nuevo («${etiqueta:-Cloudflare}», ${zonas:-?} zonas)"
  else
    RESUMEN_CF_PANEL="cuenta de la instancia ya conectada («${etiqueta:-Cloudflare}», ${zonas:-?} zonas)"
  fi
  ok "Cloudflare en el panel: $RESUMEN_CF_PANEL. Los dominios que des de alta como administrador configuran su DNS solos."
}

# Instalación autónoma: el panel es mailway-panel y se espera a que esté sano.
conectar_cloudflare_autonoma() {
  titulo "Cuenta de Cloudflare del panel"
  if cloudflare_sin_token; then
    if [ -z "$RESUMEN_CF_PANEL" ]; then info "Sin token de Cloudflare: no hay cuenta que conectar."; fi
    return 0
  fi
  if ! esperar_sano mailway-panel 120; then
    RESUMEN_CF_PANEL="pendiente: el panel no está sano"
    aviso "El panel (mailway-panel) no está sano: conecta la cuenta de Cloudflare en Conexiones → Cloudflare cuando arranque."
    return 0
  fi
  conectar_cloudflare_en_panel mailway-panel
}

# Junto a Skyway: la cuenta del panel no depende del emparejado (que se omite
# si Skyway está conectado con otro panel, si Skyway no tiene su herramienta o
# si la del panel falla): con el panel desplegado y sano, recibe el token
# igual. Va aparte también para no mezclar sus avisos con los de la puesta en
# marcha, que el emparejado resume por su cuenta.
conectar_cloudflare_junto_a_skyway() {
  if cloudflare_sin_token; then return 0; fi
  titulo "Cuenta de Cloudflare del panel"
  if [ -z "$PANEL_CONTENEDOR" ]; then
    RESUMEN_CF_PANEL="pendiente: no se ha localizado el panel desplegado en Skyway"
    aviso "No se ha localizado el panel desplegado en Skyway: conecta la cuenta de Cloudflare en Conexiones → Cloudflare."
    return 0
  fi
  if ! esperar_sano "$PANEL_CONTENEDOR" 180; then
    RESUMEN_CF_PANEL="pendiente: el panel no está sano"
    aviso "El panel ($PANEL_CONTENEDOR) no está sano: conecta la cuenta de Cloudflare en Conexiones → Cloudflare cuando arranque."
    return 0
  fi
  conectar_cloudflare_en_panel "$PANEL_CONTENEDOR"
}

# Guarda el token en Skyway para los dominios de servicios del administrador.
# La herramienta llegó con una versión de Skyway posterior: si no está, se
# avisa y se sigue.
conectar_cloudflare_en_skyway() {
  if [ -z "$CF_TOKEN" ]; then
    if [ "$ACTUALIZAR" = 1 ]; then
      RESUMEN_CF_SKYWAY="sin cambios: esta ejecución no tiene el token; si Skyway ya tenía uno guardado, lo conserva"
    fi
    return 0
  fi
  titulo "Cloudflare en Skyway"
  if ! en_marcha skyway; then
    RESUMEN_CF_SKYWAY="sin cambios: Skyway no corre en este servidor como el contenedor «skyway»"
    info "Skyway no corre en este servidor como el contenedor «skyway»: no se le pasa el token de Cloudflare."
    return 0
  fi
  if ! docker exec skyway test -f server/dist/tools/cloudflare.js 2>/dev/null; then
    RESUMEN_CF_SKYWAY="pendiente: esta versión de Skyway no guarda el token desde el servidor"
    aviso "Esta versión de Skyway no guarda el token de Cloudflare desde el servidor: actualiza Skyway y repite la instalación para que el DNS de los dominios de tus servicios se configure solo."
    return 0
  fi
  preparar_errores_herramienta
  if ! printf '%s' "$CF_TOKEN" | docker exec -i skyway node server/dist/tools/cloudflare.js conectar >/dev/null 2>"$ERR_TMP"; then
    mostrar_errores_herramienta
    RESUMEN_CF_SKYWAY="pendiente: Skyway no ha podido guardar el token"
    aviso "Skyway no ha podido guardar el token de Cloudflare (motivo arriba). El resto de la instalación no se ve afectado."
    return 0
  fi
  mostrar_errores_herramienta
  RESUMEN_CF_SKYWAY="token guardado: los dominios de servicios que des de alta como administrador configuran su DNS solos"
  ok "Token de Cloudflare guardado en Skyway."
}

# Empareja el panel con Skyway: la herramienta del panel crea (si falta) el
# administrador, completa la puesta en marcha y emite el token de gestión
# «Skyway», que pasa por la entrada estándar a la herramienta de Skyway. Nunca
# interrumpe la instalación: si algo falla, avisa y explica cómo repetirlo.
emparejar_con_skyway() {
  titulo "Emparejado del panel con Skyway"
  local salida="" conexion="" token="" correo="" clave="" version marca
  local re_token='"token":"(mwt_[0-9a-f]{8}_[A-Za-z0-9_-]{43})"'
  local re_correo='"adminEmail":"([^"\\]{3,254})"' re_clave='"adminPassword":"([A-Za-z0-9_-]{10,200})"'
  local puesta
  if [ -z "$PANEL_CONTENEDOR" ] || ! id_simple "$PANEL_SERVICIO_ID" || ! id_simple "$PANEL_PROYECTO_ID"; then
    aviso_emparejado "No se conoce el servicio del panel en Skyway."
    return 0
  fi
  if ! en_marcha skyway; then
    aviso_emparejado "Skyway no corre en este servidor como el contenedor «skyway»: conecta Mailway en Skyway → Ajustes → Correo (Mailway) (sección 4.1 de docs/DESPLIEGUE-SKYWAY.md)."
    return 0
  fi
  if ! docker exec skyway test -f server/dist/tools/mailway.js 2>/dev/null; then
    aviso_emparejado "Esta versión de Skyway no conecta Mailway desde el servidor: actualiza Skyway o conéctalo en Ajustes → Correo (Mailway)."
    return 0
  fi
  info "Esperando a que el panel ($PANEL_CONTENEDOR) esté sano…"
  if ! esperar_sano "$PANEL_CONTENEDOR" 180; then
    aviso_emparejado "El panel ($PANEL_CONTENEDOR) no está en marcha y sano. Revisa: docker logs $PANEL_CONTENEDOR"
    return 0
  fi
  if ! docker exec "$PANEL_CONTENEDOR" test -f server/dist/tools/emparejar.js 2>/dev/null; then
    aviso_emparejado "El panel desplegado no incluye la herramienta de emparejado: despliega la versión actual de Mailway en Skyway."
    return 0
  fi

  # Como el usuario del panel («node»): lo que toque en /data debe seguir siendo suyo.
  preparar_errores_herramienta
  if ! salida=$(docker exec -i -u node "$PANEL_CONTENEDOR" node server/dist/tools/emparejar.js \
    --email "$ADMIN_EMAIL" </dev/null 2>"$ERR_TMP"); then
    mostrar_errores_herramienta
    aviso_emparejado "La herramienta de emparejado del panel ha fallado."
    return 0
  fi
  mostrar_errores_herramienta
  # Se extrae con bash: el JSON lleva secretos y no pasa por ningún otro programa.
  if [[ $salida =~ $re_token ]]; then token=${BASH_REMATCH[1]}; fi
  if [[ $salida =~ $re_correo ]]; then correo=${BASH_REMATCH[1]}; fi
  if [[ $salida =~ $re_clave ]]; then clave=${BASH_REMATCH[1]}; fi
  salida=""
  olvidar_coincidencias
  # El correo no se vuelve a validar como dirección: es el de una cuenta que
  # el panel ya admitió (puede llevar, por ejemplo, un apóstrofo) y, a estas
  # alturas, el token «Skyway» anterior ya está revocado. La expresión ya
  # excluye comillas y barras; basta con que se pueda mostrar.
  if [ -z "$token" ] || [ -z "$correo" ] || tiene_control "$correo"; then
    token=""
    aviso_emparejado "Respuesta inesperada de la herramienta de emparejado del panel."
    return 0
  fi
  # Desde aquí la cuenta existe: su contraseña (si es nueva) se muestra en el
  # resumen aunque lo siguiente falle, porque no hay otra forma de saberla.
  EMPAREJADO_ADMIN_EMAIL=$correo
  EMPAREJADO_ADMIN_PASSWORD=$clave
  clave=""
  if [ -n "$EMPAREJADO_ADMIN_PASSWORD" ]; then
    ok "Cuenta de administración del panel creada ($correo); la contraseña aparece en el resumen."
  else
    ok "El panel ya tenía cuenta de administración ($correo)."
  fi
  # Los avisos de la herramienta (arriba) dicen qué ha quedado pendiente: el
  # asistente del panel lo retoma al entrar y --emparejar lo vuelve a intentar.
  if [ "$HERRAMIENTA_CON_AVISOS" = 1 ]; then
    puesta="puesta en marcha del panel con avisos"
    aviso "Puesta en marcha del panel completada con avisos (arriba) y token de gestión «Skyway» emitido. Lo pendiente se retoma al entrar en el panel o repitiendo: sudo bash deploy/instalar.sh --emparejar"
  else
    puesta=""
    ok "Puesta en marcha del panel completada con el entorno y token de gestión «Skyway» emitido."
  fi

  preparar_errores_herramienta
  if ! conexion=$(printf '%s' "$token" | docker exec -i skyway node server/dist/tools/mailway.js conectar \
    --servicio "$PANEL_SERVICIO_ID" --proyecto "$PANEL_PROYECTO_ID" --url "https://$PANEL_HOSTNAME" 2>"$ERR_TMP"); then
    token=""
    mostrar_errores_herramienta
    aviso_emparejado "Skyway no ha podido guardar la conexión con el panel."
    return 0
  fi
  token=""
  mostrar_errores_herramienta
  version=$(printf '%s' "$conexion" | jqr -r '.version // empty' 2>/dev/null | tr -d '[:cntrl:]' || true)
  marca=$(printf '%s' "$conexion" | jqr -r '.brandName // empty' 2>/dev/null | tr -d '[:cntrl:]' || true)
  EMPAREJADO_OK=1
  RESUMEN_EMPAREJADO="Skyway conectado con el panel (Mailway ${version:-?}${marca:+, «$marca»})"
  ok "$RESUMEN_EMPAREJADO."
  if [ -n "$puesta" ]; then RESUMEN_EMPAREJADO+="; $puesta"; fi
}

# Paso final de la instalación junto a Skyway: solo si el panel se ha
# desplegado y Skyway no está conectado con otro panel de Mailway.
emparejar_al_terminar() {
  if [ -z "$PANEL_CONTENEDOR" ]; then return 0; fi
  if skyway_con_otro_panel; then return 0; fi
  emparejar_con_skyway
}

# --emparejar: repite solo el emparejado con la configuración de deploy/.env.
# El contenedor del panel sale de MAILWAY_PANEL_INTERNAL_URL y su servicio y
# proyecto, de las etiquetas que Skyway pone a sus contenedores.
emparejar_solo() {
  [ -f "$ENV_FILE" ] || fallo "No existe $ENV_FILE: Mailway no está instalado aquí (sudo bash deploy/instalar.sh)."
  tiene docker || fallo "Falta Docker."
  docker info >/dev/null 2>&1 || fallo "No se puede hablar con Docker. Ejecuta como root (sudo) o con un usuario del grupo docker."
  if [ "$(leer_env MAILWAY_INSTALACION)" = autonoma ]; then
    fallo "Esta instalación es autónoma (sin Skyway): no hay nada que emparejar."
  fi
  PANEL_HOSTNAME=$(leer_env PANEL_HOSTNAME)
  host_valido "$PANEL_HOSTNAME" || fallo "PANEL_HOSTNAME no es válido en $ENV_FILE."
  local le interna re_panel='^http://(skyway-[a-z0-9][a-z0-9_.-]*):[0-9]{1,5}$'
  le=$(leer_env LETSENCRYPT_EMAIL)
  elegir_correo_admin "$le"
  interna=$(leer_env MAILWAY_PANEL_INTERNAL_URL)
  PANEL_CONTENEDOR=skyway-mailway-panel
  if [[ $interna =~ $re_panel ]]; then PANEL_CONTENEDOR=${BASH_REMATCH[1]}; fi
  docker inspect --type container "$PANEL_CONTENEDOR" >/dev/null 2>&1 ||
    fallo "No existe el contenedor del panel ($PANEL_CONTENEDOR). Despliégalo con el instalador completo: sudo bash deploy/instalar.sh"
  PANEL_SERVICIO_ID=$(docker inspect --type container -f '{{index .Config.Labels "skyway.service"}}' "$PANEL_CONTENEDOR" 2>/dev/null || true)
  PANEL_PROYECTO_ID=$(docker inspect --type container -f '{{index .Config.Labels "skyway.project"}}' "$PANEL_CONTENEDOR" 2>/dev/null || true)
  if ! id_simple "$PANEL_SERVICIO_ID" || ! id_simple "$PANEL_PROYECTO_ID"; then
    fallo "El contenedor $PANEL_CONTENEDOR no lo gestiona Skyway (le faltan sus etiquetas skyway.service y skyway.project)."
  fi
  info "Panel: $PANEL_CONTENEDOR (https://$PANEL_HOSTNAME)"
  emparejar_con_skyway
  conectar_cloudflare_junto_a_skyway
  titulo "Resumen"
  printf '\n'
  info "Emparejado con Skyway: $RESUMEN_EMPAREJADO"
  if [ -n "$RESUMEN_CF_PANEL" ]; then info "Cloudflare (panel): $RESUMEN_CF_PANEL"; fi
  resumen_administrador
  [ "$EMPAREJADO_OK" = 1 ]
}

# Comillas simples de YAML y «$» doblado (Compose interpola los dólares).
yaml_literal() {
  local s=$1
  s=${s//\'/\'\'}
  s=${s//\$/\$\$}
  printf "'%s'" "$s"
}

# Primera línea de los ficheros de la carpeta de Skyway que genera este
# instalador: así se reconocen al actualizar.
MARCA_OVERRIDE="# Generado por el instalador de Mailway"

confirmar_traefik() { [ "${MAILWAY_TRAEFIK_PROVEEDOR:-}" = 1 ] || confirmar "$1" s; }

# ¿Es de Mailway el override de Traefik de la carpeta de Skyway? El que genera
# este instalador lleva MARCA_OVERRIDE en la primera línea. El que se copiaba
# a mano de Ajustes → Marca blanca con la guía 0.x («# docker-compose.override.yml
# — en la carpeta de Skyway.») no la lleva, pero sí el proveedor HTTP del
# panel (/api/traefik/config) o su cabecera X-Mailway-Token.
override_de_mailway() {
  [[ $(head -n 1 "$1") == "$MARCA_OVERRIDE"* ]] || grep -Eq '/api/traefik/config|X-Mailway-Token' "$1"
}

# Parámetros con los que corre ahora el Traefik de Skyway (JSON).
argumentos_traefik() { docker inspect -f '{{json .Config.Cmd}}' skyway-traefik 2>/dev/null || printf '[]'; }

recrear_traefik() {
  local salida
  # Sin la LETSENCRYPT_EMAIL del instalador: Traefik debe tomar la del .env
  # de Skyway.
  if ! salida=$(cd "$SKYWAY_DIR" && env -u LETSENCRYPT_EMAIL docker compose up -d traefik 2>&1); then
    printf '%s\n' "$salida" >&2
    aviso "Traefik no se pudo recrear. Ejecuta «docker compose up -d traefik» en $SKYWAY_DIR."
    return 1
  fi
}

# Proveedor HTTP de Traefik: sirve las rutas de los dominios de los clientes
# (webmail de marca blanca y autoconfiguración de dispositivos).
configurar_proveedor_traefik() {
  titulo "Dominios de los clientes en Traefik"
  if [ "${MAILWAY_TRAEFIK_PROVEEDOR:-}" = 0 ]; then
    info "Omitido (MAILWAY_TRAEFIK_PROVEEDOR=0)."
    return 0
  fi
  local argumentos override="" compose_skyway=""
  argumentos=$(argumentos_traefik)
  if [ -n "$SKYWAY_DIR" ] && [ -f "$SKYWAY_DIR/docker-compose.yml" ]; then
    compose_skyway="$SKYWAY_DIR/docker-compose.yml"
    override="$SKYWAY_DIR/docker-compose.override.yml"
  fi
  if [ -z "$SKYWAY_VERSION" ]; then
    SKYWAY_VERSION=$(curl -fsS --max-time 5 "${SKYWAY_URL:-http://127.0.0.1:4000}/api/health" 2>/dev/null |
      jqr -r '.version // empty' 2>/dev/null || true)
  fi

  # Skyway 0.34 o posterior trae en su propio compose el proveedor HTTP que
  # lee las rutas de Mailway a través de Skyway (que las filtra). Instalar
  # además el fichero de Mailway sustituiría el «command» de Traefik por uno
  # con los flags antiguos: no se instala nada.
  if { [ -n "$compose_skyway" ] && grep -q 'api/traefik/mailway' "$compose_skyway"; } ||
    printf '%s' "$argumentos" | grep -q 'api/traefik/mailway' || version_ge "$SKYWAY_VERSION" 0.34.0; then
    traefik_con_puente "$argumentos" "$compose_skyway" "$override"
    return 0
  fi

  if printf '%s' "$argumentos" | grep -q 'providers.http.endpoint'; then
    ok "El Traefik de Skyway ya consulta un proveedor HTTP."
    return 0
  fi
  if [ -z "$compose_skyway" ]; then
    aviso "No se encontró la carpeta de Skyway: configura el proveedor con deploy/skyway-traefik-override.yml."
    return 0
  fi
  if [ -f "$override" ]; then
    aviso "Ya existe $override y no se modifica. Añade a mano las líneas de deploy/skyway-traefik-override.yml."
    return 0
  fi
  # El panel de una instalación anterior guarda su propio token de Traefik en
  # su base de datos: con el de deploy/.env, Traefik recibiría un 401 en cada
  # consulta. El bloque con el token bueno lo muestra el propio panel.
  if [ "${TRAEFIK_TOKEN_PROPIO:-1}" = 0 ]; then
    aviso "El panel usa su propio token de Traefik, que el instalador no conoce: no se genera $override."
    aviso "Copia el bloque de Ajustes → Rutas de Traefik del panel (antes, Ajustes → Marca blanca) en $override y ejecuta «docker compose up -d traefik» en $SKYWAY_DIR."
    return 0
  fi
  confirmar_traefik "¿Configurar el Traefik de Skyway para los dominios de los clientes? Traefik se reinicia unos segundos." ||
    { info "Omitido."; return 0; }

  # Skyway anterior a la 0.34: Traefik consulta directamente al panel, con
  # el token de Traefik del panel.
  local endpoint cabecera umask_previa
  endpoint="http://${PANEL_CONTENEDOR:-skyway-mailway-panel}:4100/api/traefik/config"
  cabecera="--providers.http.headers.X-Mailway-Token=$MAILWAY_TRAEFIK_TOKEN"
  umask_previa=$(umask)
  umask 077
  {
    printf '%s el %s.\n' "$MARCA_OVERRIDE" "$(date -u '+%Y-%m-%d')"
    printf '# Compose REEMPLAZA «command»: se repiten los flags actuales de Traefik y se\n'
    printf '# añade el proveedor HTTP de Mailway. Solo para Skyway anterior a la 0.34: al\n'
    printf '# actualizar Skyway, ejecuta deploy/instalar.sh --actualizar y este fichero se\n'
    printf '# retirará (Skyway 0.34 ya lee por sí mismo las rutas de Mailway).\n'
    printf 'services:\n  traefik:\n    command:\n'
    printf '%s' "$argumentos" | jqr -r '.[]' | while IFS= read -r arg; do
      printf '      - %s\n' "$(yaml_literal "$arg")"
    done
    printf '      - %s\n' "$(yaml_literal "--providers.http.endpoint=$endpoint")"
    printf '      - %s\n' "'--providers.http.pollInterval=15s'"
    printf '      - %s\n' "'--providers.http.pollTimeout=10s'"
    printf '      - %s\n' "$(yaml_literal "$cabecera")"
  } >"$override"
  chmod 600 "$override"
  umask "$umask_previa"
  if ! recrear_traefik; then
    fallo "Traefik no arrancó con $override. Bórralo y ejecuta «docker compose up -d traefik» en $SKYWAY_DIR."
  fi
  ok "Traefik consulta $endpoint."
}

# Skyway con el puente de Mailway: solo hay que retirar el override de
# Mailway que dejó una instalación anterior (el del instalador o el copiado a
# mano con la guía 0.x) y asegurarse de que Traefik corre con la
# configuración de Skyway. El «ok» final sale de los parámetros con los que
# corre Traefik, no de que se haya recreado.
traefik_con_puente() {
  local argumentos=$1 compose_skyway=$2 override=$3 queda_override=0
  if [ -n "$override" ] && [ -f "$override" ]; then
    if override_de_mailway "$override"; then
      if confirmar_traefik "Skyway ya lee las rutas de Mailway y $override (de una instalación anterior de Mailway) sobra. ¿Retirarlo y recrear Traefik?"; then
        mv "$override" "$override.mailway-retirado"
        ok "Retirado $override (se conserva como $override.mailway-retirado)."
        if [[ $(head -n 1 "$override.mailway-retirado") != "$MARCA_OVERRIDE"* ]]; then
          info "Si añadiste en él otros ajustes propios, recupéralos de esa copia."
        fi
        recrear_traefik || return 0
        argumentos=$(argumentos_traefik)
      else
        queda_override=1
        aviso "Se mantiene $override: fija los flags antiguos de Traefik y deja sin efecto el puente de Skyway. Bórralo cuando puedas."
      fi
    elif grep -q 'command' "$override"; then
      aviso "$override redefine opciones de Traefik: comprueba que no sustituye el «command» de Skyway ni añade otro proveedor HTTP."
    fi
  fi
  # Recrear Traefik con el override de Mailway aún en su sitio no cambiaría nada.
  if [ "$queda_override" = 0 ] && ! printf '%s' "$argumentos" | grep -q 'api/traefik/mailway' &&
    [ -n "$compose_skyway" ] && grep -q 'api/traefik/mailway' "$compose_skyway" &&
    confirmar_traefik "El Traefik de Skyway aún no usa la configuración actual de Skyway. ¿Recrearlo ahora?"; then
    recrear_traefik || return 0
    argumentos=$(argumentos_traefik)
  fi
  if ! printf '%s' "$argumentos" | grep -q 'api/traefik/mailway'; then
    aviso "El Traefik de Skyway no lee las rutas de Mailway: sus parámetros no incluyen el proveedor de Skyway (api/traefik/mailway)."
    if [ -n "$override" ] && [ -f "$override" ] && grep -q 'command' "$override"; then
      aviso "Los sustituye el «command» de $override: retíralo y ejecuta «docker compose up -d traefik» en $SKYWAY_DIR."
    else
      aviso "Ejecuta «docker compose up -d traefik» en la carpeta de Skyway y comprueba que Skyway es la 0.34 o posterior."
    fi
    return 0
  fi
  ok "Skyway sirve a Traefik las rutas de Mailway: no hace falta ningún fichero adicional."
  info "Las lee a través de la conexión con el panel que deja el emparejado (siguiente paso)."
}

# ---------------------------------------------------------------- resumen --

# Cuenta de administración del panel que ha dejado el emparejado. La
# contraseña (solo si se acaba de crear) se muestra aquí una vez y se olvida:
# no está en deploy/.env ni en ningún registro.
resumen_administrador() {
  [ -n "$EMPAREJADO_ADMIN_EMAIL" ] || return 0
  info "Administración del panel: $EMPAREJADO_ADMIN_EMAIL"
  if [ -n "$EMPAREJADO_ADMIN_PASSWORD" ]; then
    info "Contraseña:          $EMPAREJADO_ADMIN_PASSWORD"
    info "  Se muestra solo esta vez y no se guarda en ningún sitio: guárdala en un lugar seguro"
    info "  o cámbiala al entrar en el panel (Mi cuenta → Cambiar contraseña)."
    EMPAREJADO_ADMIN_PASSWORD=""
  fi
}

resumen() {
  titulo "Resumen"
  local copia volumen paso=0
  volumen=${MAILWAY_MAIL_VOLUME:-mailway-mail-data}
  copia="docker stop mailway-mail && docker run --rm -v $volumen:/origen:ro -v /root/copias:/destino alpine tar czf /destino/mailway-correo-\$(date +%F).tar.gz -C /origen . ; docker start mailway-mail"
  printf '\n'
  # Con la cuenta de administración ya creada, el enlace de puesta en marcha
  # (y su token) no sirven de nada: no se muestran.
  if [ -n "$EMPAREJADO_ADMIN_EMAIL" ]; then
    info "Panel:               https://$PANEL_HOSTNAME"
  else
    info "Panel:               https://$PANEL_HOSTNAME/setup?token=$MAILWAY_SETUP_TOKEN"
  fi
  info "Webmail:             https://$WEBMAIL_HOSTNAME"
  info "Web del motor:       https://$MAIL_HOSTNAME (usuario admin; contraseña en deploy/.env)"
  if [ -z "$EMPAREJADO_ADMIN_EMAIL" ]; then info "Token de puesta en marcha: $MAILWAY_SETUP_TOKEN"; fi
  if [ "$CON_SKYWAY" = 1 ]; then
    info "Panel en Skyway:     $RESUMEN_SKYWAY"
    info "Emparejado con Skyway: $RESUMEN_EMPAREJADO"
  fi
  if [ "$CON_SKYWAY" = 0 ] && [ "$USAR_PROXY_PROPIO" = 0 ]; then
    info "Sin proxy propio:    panel en 127.0.0.1:4100 y webmail en 127.0.0.1:8000; ponles delante un proxy con TLS."
  fi
  info "DNS de la plataforma: $RESUMEN_DNS"
  if [ -n "$RESUMEN_CF_PANEL" ]; then info "Cloudflare (panel):  $RESUMEN_CF_PANEL"; fi
  if [ "$CON_SKYWAY" = 1 ] && [ -n "$RESUMEN_CF_SKYWAY" ]; then info "Cloudflare (Skyway): $RESUMEN_CF_SKYWAY"; fi
  info "DNS inverso (PTR):   $RESUMEN_PTR"
  info "Puerto 25 de salida: $RESUMEN_P25"
  info "Certificado IMAP/SMTP: $RESUMEN_CERT"
  printf '\n'
  if [ "$CERT_CONFIGURADO" = 0 ]; then
    info "Mientras el motor no tenga un certificado válido para $MAIL_HOSTNAME, la API de envío del panel"
    info "(que lo verifica) y los programas de correo mostrarán errores de certificado."
    printf '\n'
  fi
  info "Copia de seguridad del correo (detiene el motor unos segundos: copiar su base de datos en marcha"
  info "puede dejarla incoherente):"
  info "  $copia"
  printf '\n'
  info "Actualizar Mailway (git pull y reaplicar):        mailway update -y"
  info "Parches probados cada noche, con vuelta atrás:     sudo mailway auto-update on"
  info "Diagnóstico en cualquier momento (no cambia nada): mailway comprobar"
  info "Prueba de acceso a un buzón desde el webmail:      mailway probar-acceso"
  printf '\n'
  if [ -n "$EMPAREJADO_ADMIN_EMAIL" ]; then
    resumen_administrador
    printf '\n'
  fi
  info "Siguientes pasos:"
  if [ -n "$EMPAREJADO_ADMIN_EMAIL" ]; then
    info "  $((paso += 1)). Entra en el panel con la cuenta de administración de arriba."
  else
    info "  $((paso += 1)). Abre el panel con el enlace de arriba y completa la puesta en marcha."
  fi
  # Con la cuenta conectada en esta ejecución, no se manda conectarla a mano.
  # Sin el token (--actualizar), esta ejecución no sabe si la hay: se pide
  # comprobarlo, sin darla por hecha.
  if [ "$CF_PANEL_CONECTADA" = 0 ]; then
    case "$RESUMEN_CF_PANEL" in
      pendiente*) info "  $((paso += 1)). En Conexiones → Cloudflare, conecta la cuenta de la instancia (ámbito «Toda la instancia»)." ;;
      "sin cambios"*) info "  $((paso += 1)). En Conexiones → Cloudflare, comprueba que hay una cuenta conectada para publicar el DNS de los dominios de los clientes (si no, conéctala)." ;;
      *) info "  $((paso += 1)). En Conexiones → Cloudflare, conecta una cuenta para publicar el DNS de los dominios de los clientes." ;;
    esac
  fi
  info "  $((paso += 1)). En Ajustes → Servidor de correo, comprueba el certificado y el nombre del servidor."
  if [ "$CON_SKYWAY" = 1 ] && [ "$EMPAREJADO_OK" = 0 ] && [ -n "$PANEL_CONTENEDOR" ]; then
    info "  $((paso += 1)). Empareja Skyway con el panel: sudo bash deploy/instalar.sh --emparejar"
    info "     (o a mano, en Skyway → Ajustes → Correo (Mailway): sección 4.1 de docs/DESPLIEGUE-SKYWAY.md)."
  fi
}

# ------------------------------------------------------------ diagnóstico --

# Datos que necesita el diagnóstico, leídos de deploy/.env sin preguntar nada.
preparar_diagnostico() {
  [ -f "$ENV_FILE" ] || fallo "No existe $ENV_FILE: Mailway no está instalado aquí (sudo bash deploy/instalar.sh)."
  tiene docker || fallo "Falta Docker."
  docker info >/dev/null 2>&1 || fallo "No se puede hablar con Docker. Ejecuta como root (sudo) o con un usuario del grupo docker."
  case "$(leer_env MAILWAY_INSTALACION)" in
    autonoma) CON_SKYWAY=0 ;;
    '') if docker inspect mailway-panel >/dev/null 2>&1; then CON_SKYWAY=0; fi ;;
  esac
  MAIL_HOSTNAME=$(leer_env MAIL_HOSTNAME)
  host_valido "$MAIL_HOSTNAME" || fallo "MAIL_HOSTNAME no es válido en $ENV_FILE."
  STALWART_ADMIN_PASSWORD=${STALWART_ADMIN_PASSWORD:-$(leer_env STALWART_ADMIN_PASSWORD)}
  INTERNAL_SUBNET=$(leer_env MAILWAY_INTERNAL_SUBNET)
  INTERNAL_SUBNET=${INTERNAL_SUBNET:-10.203.53.0/24}
}

# Muestra la salida de una comprobación hecha dentro de un contenedor con el
# formato del instalador: «OK: …» → [ok], «FALLO: …» → [aviso].
mostrar_resultado() {
  local linea
  while IFS= read -r linea; do
    case "$linea" in
      'OK: '*) ok "${linea#OK: }" ;;
      'FALLO: '*) aviso "${linea#FALLO: }" ;;
      '') ;;
      *) info "$linea" ;;
    esac
  done
}

# Ejecuta una comprobación, muestra su resultado y devuelve su código.
ejecutar_comprobacion() {
  local salida codigo=0
  salida=$("$@" 2>&1) || codigo=$?
  printf '%s\n' "$salida" | mostrar_resultado
  return "$codigo"
}

# --comprobar: diagnóstico de solo lectura. Hace una sola petición
# autenticada a la API del motor: cada contraseña incorrecta cuenta para su
# bloqueo automático.
comprobar_instalacion() {
  local fallos=0 c estado extractor respuesta nombre contenedores=(mailway-mail mailway-webmail)
  if [ "$CON_SKYWAY" = 0 ]; then contenedores+=(mailway-panel); fi

  titulo "Contenedores"
  for c in "${contenedores[@]}"; do
    estado=$(estado_contenedor "$c")
    case "$estado" in
      healthy) ok "$c: en marcha y sano." ;;
      ausente)
        aviso "$c: no existe. Vuelve a ejecutar el instalador (sudo bash deploy/instalar.sh --actualizar)."
        fallos=$((fallos + 1))
        ;;
      *)
        aviso "$c: $estado. Revisa: docker logs $c"
        fallos=$((fallos + 1))
        ;;
    esac
  done
  extractor=$(estado_contenedor mailway-certs-dumper)
  if [ "$extractor" = ausente ]; then
    info "Extractor del certificado (perfil tls): no está en marcha; solo hace falta si el motor usa el certificado de Traefik."
  fi

  titulo "Motor de correo"
  if [ "$(estado_contenedor mailway-mail)" = healthy ]; then
    respuesta=$(motor_api GET "/api/settings/keys?keys=server.hostname,server.allowed-ip.$INTERNAL_SUBNET,acme.mailway.directory,certificate.mailway.cert,certificate.default.cert" 2>/dev/null || true)
    if ! printf '%s' "$respuesta" | grep -q '"data"'; then
      if printf '%s' "$respuesta" | grep -Eq '"status": *40[13]'; then
        aviso "El motor rechaza la contraseña de administración de $ENV_FILE (STALWART_ADMIN_PASSWORD). No se reintenta."
      else
        aviso "La API de gestión del motor no responde por la red interna. Revisa: docker logs mailway-mail"
      fi
      fallos=$((fallos + 1))
    else
      nombre=$(printf '%s' "$respuesta" | jqr -r '.data["server.hostname"] // empty' 2>/dev/null || true)
      if [ "$nombre" = "$MAIL_HOSTNAME" ]; then
        ok "Nombre del servidor: $MAIL_HOSTNAME."
      else
        aviso "El motor se identifica como «${nombre:-sin nombre}», no como $MAIL_HOSTNAME: aplica los ajustes recomendados (Ajustes → Servidor de correo)."
        fallos=$((fallos + 1))
      fi
      if printf '%s' "$respuesta" | grep -Fq "\"server.allowed-ip.$INTERNAL_SUBNET\""; then
        ok "La red interna $INTERNAL_SUBNET está exenta del bloqueo automático."
      else
        aviso "Falta la exención de $INTERNAL_SUBNET: los fallos de contraseña del webmail acabarían bloqueándolo. Aplica los ajustes recomendados."
        fallos=$((fallos + 1))
      fi
      if printf '%s' "$respuesta" | grep -q '"acme.mailway.directory"'; then
        info "Certificado: Let's Encrypt emitido por el propio motor (ACME)."
      elif printf '%s' "$respuesta" | grep -q '"certificate.mailway.cert"'; then
        info "Certificado: el de Traefik, que mantiene el extractor (perfil tls)."
      elif printf '%s' "$respuesta" | grep -q '"certificate.default.cert"'; then
        info "Certificado: configurado a mano en el motor."
      else
        aviso "El motor no tiene ningún certificado configurado y sirve uno autofirmado (sección 5 de docs/DESPLIEGUE-SKYWAY.md)."
        fallos=$((fallos + 1))
      fi
    fi
  else
    info "El motor no está sano: no se consulta su API."
  fi

  titulo "Certificado público de IMAP y SMTP"
  if [ "$(estado_contenedor mailway-webmail)" = healthy ]; then
    # Se verifica desde el webmail, por la red interna y con el nombre público
    # (SNI): es el mismo certificado que ven los programas de correo.
    ejecutar_comprobacion docker exec -u www-data mailway-webmail php "$COMPROBAR_PHP" certificado "$MAIL_HOSTNAME" ||
      fallos=$((fallos + 1))
    titulo "Webmail"
    ejecutar_comprobacion docker exec -u www-data mailway-webmail php "$COMPROBAR_PHP" conexion ||
      fallos=$((fallos + 1))
    info "Inicio de sesión real con un buzón: sudo bash deploy/instalar.sh --probar-acceso"
  else
    info "Se comprueba desde el webmail, que no está en marcha."
  fi

  if [ "$extractor" != ausente ]; then
    titulo "Extractor del certificado (perfil tls)"
    ejecutar_comprobacion docker exec mailway-certs-dumper python /app/extractor.py estado ||
      fallos=$((fallos + 1))
  fi

  titulo "Resultado"
  if [ "$fallos" = 0 ]; then
    ok "Todo correcto. Quedan fuera el DNS público, el PTR, los puertos vistos desde Internet y la entrega a otros servidores (sección 12.1 de docs/DESPLIEGUE-SKYWAY.md)."
    return 0
  fi
  aviso "$fallos comprobaciones con incidencias (detalle arriba)."
  return 1
}

# --probar-acceso: un inicio de sesión real desde el webmail, con la
# biblioteca IMAP de Roundcube, y la apertura de la bandeja de entrada.
probar_acceso() {
  titulo "Prueba de acceso a un buzón desde el webmail"
  if [ "$(estado_contenedor mailway-webmail)" != healthy ]; then
    fallo "El webmail (mailway-webmail) no está en marcha y sano. Revisa: sudo bash deploy/instalar.sh --comprobar"
  fi
  local correo="" clave="" salida codigo=0
  if [ -t 0 ]; then
    info "Se hace un único intento: cada contraseña incorrecta cuenta para el bloqueo automático del"
    info "motor. La contraseña no se muestra, no se guarda y no queda en el historial."
    read -r -p "   Dirección del buzón: " correo || true
    IFS= read -r -s -p "   Contraseña: " clave || true
    printf '\n'
  else
    # Sin terminal (p. ej. la CI): dirección y contraseña en dos líneas.
    IFS= read -r correo || true
    IFS= read -r clave || true
  fi
  correo=$(printf '%s' "$correo" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  coincide "$correo" '^[^@[:space:][:cntrl:]]+@[a-z0-9.-]+\.[a-z0-9-]{2,}$' ||
    fallo "«$correo» no es una dirección de correo."
  [ -n "$clave" ] || fallo "No se ha indicado la contraseña."
  if tiene_control "$clave"; then
    clave=""
    fallo "La contraseña contiene caracteres de control."
  fi
  # La contraseña viaja por la entrada estándar del contenedor: printf es
  # interno de bash, así que no aparece en la lista de procesos ni en argumentos.
  salida=$(printf '%s\n%s\n' "$correo" "$clave" |
    docker exec -i -u www-data mailway-webmail php "$COMPROBAR_PHP" acceso 2>&1) || codigo=$?
  clave=""
  printf '%s\n' "$salida" | mostrar_resultado
  return "$codigo"
}

# ------------------------------------------------------------------ main --

main() {
  printf '%sInstalador de Mailway %s%s\n' "$C_TIT" "$VERSION_INSTALADOR" "$C_0"
  if [ "$EMPAREJAR" = 1 ]; then
    info "Emparejado del panel con Skyway (configuración de deploy/.env)."
    if emparejar_solo; then exit 0; fi
    exit 1
  fi
  if [ "$COMPROBAR" = 1 ] || [ "$PROBAR_ACCESO" = 1 ]; then
    preparar_diagnostico
    if [ "$CON_SKYWAY" = 1 ]; then info "Modo: junto a Skyway."; else info "Modo: instalación autónoma (sin Skyway)."; fi
    if [ "$COMPROBAR" = 1 ]; then
      if comprobar_instalacion; then exit 0; fi
    elif probar_acceso; then
      exit 0
    fi
    exit 1
  fi
  # La actualización mantiene el modo con el que se instaló. Los deploy/.env
  # anteriores a la 1.0 no lo guardan: solo la instalación autónoma tiene el
  # contenedor mailway-panel (con Skyway, el panel es skyway-<proyecto>-panel).
  if [ "$ACTUALIZAR" = 1 ]; then
    case "$(leer_env MAILWAY_INSTALACION)" in
      autonoma) CON_SKYWAY=0 ;;
      '') if docker inspect mailway-panel >/dev/null 2>&1; then CON_SKYWAY=0; fi ;;
    esac
  fi
  if [ "$CON_SKYWAY" = 1 ]; then info "Modo: junto a Skyway."; else info "Modo: instalación autónoma (sin Skyway)."; fi
  if [ "$ACTUALIZAR" = 1 ]; then info "Actualización: se reutiliza deploy/.env sin preguntas."; fi

  comprobaciones_previas
  detectar_panel_existente
  recoger_datos
  migrar_instalacion_anterior
  preparar_secretos

  USAR_PROXY_PROPIO=0
  if [ "$CON_SKYWAY" = 0 ]; then
    if puerto_ocupado_por_otro 80 || puerto_ocupado_por_otro 443; then
      aviso "Los puertos 80/443 están ocupados: no se levanta el Traefik propio."
    else
      USAR_PROXY_PROPIO=1
    fi
  fi

  PANEL_INTERNAL_URL=$(leer_env MAILWAY_PANEL_INTERNAL_URL)
  if ! coincide "$PANEL_INTERNAL_URL" '^http://[a-z0-9][a-z0-9_.-]*:[0-9]{1,5}$'; then PANEL_INTERNAL_URL=""; fi
  if [ "$CON_SKYWAY" = 0 ]; then PANEL_INTERNAL_URL="http://mailway-panel:4100"; fi
  if [ -z "$PANEL_INTERNAL_URL" ] && [ -n "$PANEL_EXISTENTE_CONTENEDOR" ]; then
    PANEL_INTERNAL_URL="http://$PANEL_EXISTENTE_CONTENEDOR:4100"
  fi
  # El nombre por defecto puede ser el de un cliente (un proyecto suyo con el
  # slug «mailway»): el webmail le mandaría las contraseñas que se cambian
  # hasta que desplegar_en_skyway lo corrija. Mientras, a ninguna parte.
  if [ -z "$PANEL_INTERNAL_URL" ] && [ "$CON_SKYWAY" = 1 ] && contenedor_de_cliente skyway-mailway-panel; then
    PANEL_INTERNAL_URL="http://panel-pendiente.invalid:4100"
  fi
  PANEL_INTERNAL_URL=${PANEL_INTERNAL_URL:-http://skyway-mailway-panel:4100}

  escribir_env
  configurar_cloudflare
  esperar_dns
  comprobar_ptr
  levantar_servicios
  configurar_motor
  if [ "$CON_SKYWAY" = 0 ]; then conectar_cloudflare_autonoma; fi

  if [ "$CON_SKYWAY" = 1 ]; then
    desplegar_en_skyway
    # El complemento de contraseña del webmail llama al panel por dentro.
    if [ -n "$PANEL_CONTENEDOR" ] && [ "http://$PANEL_CONTENEDOR:4100" != "$PANEL_INTERNAL_URL" ]; then
      PANEL_INTERNAL_URL="http://$PANEL_CONTENEDOR:4100"
      escribir_env
      compose_q up -d mailway-webmail
      ok "Webmail enlazado con el panel ($PANEL_INTERNAL_URL)."
    fi
    configurar_proveedor_traefik
    # Lo último que puede fallar: así la contraseña del administrador que
    # crea el emparejado llega al resumen sin que nada la interrumpa.
    emparejar_al_terminar
    conectar_cloudflare_junto_a_skyway
    conectar_cloudflare_en_skyway
    revocar_token_temporal_skyway
  fi

  # Orden «mailway» (update, comprobar…) en el PATH para las próximas veces.
  bash "$DEPLOY_DIR/mailway.sh" instalar-comando || true

  resumen
}

main
