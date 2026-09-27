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
#   bash deploy/instalar.sh --ayuda
#
# Ejecución desatendida: todas las preguntas se pueden responder con
# variables de entorno (ver --ayuda). Sin terminal interactiva, el
# instalador no pregunta y usa esas variables o los valores por defecto.
# ============================================================================
# Los «$t» y «$n» entre comillas simples son variables de jq, no de bash.
# shellcheck disable=SC2016
set -euo pipefail

VERSION_INSTALADOR="1.0.0"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$RAIZ/deploy"
ENV_FILE="${MAILWAY_ENV_FILE:-$DEPLOY_DIR/.env}"
COMPOSE_MAIL="$DEPLOY_DIR/docker-compose.mail.yml"
COMPOSE_SOLO="$DEPLOY_DIR/docker-compose.standalone.yml"
IMAGEN_CURL="curlimages/curl:8.11.1"
IMAGEN_JQ="ghcr.io/jqlang/jq:1.7.1"
LE_DIRECTORIO="https://acme-v02.api.letsencrypt.org/directory"

CON_SKYWAY=1
CON_CLOUDFLARE=1
ACTUALIZAR=0
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
PANEL_CONTENEDOR=""
CF_TOKEN=""
CF_ZONA_ID=""
CF_ZONA_NOMBRE=""

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
                    Ejecute antes «git pull» en la carpeta de Mailway.
  --ayuda           Muestra esta ayuda.

Variables de entorno (ejecución desatendida):
  MAILWAY_DOMINIO           Dominio base (mail., webmail. y panel. cuelgan de él).
  MAILWAY_MAIL_HOST         Nombre del servidor de correo (por defecto mail.<dominio>).
  MAILWAY_WEBMAIL_HOST      Nombre del webmail (por defecto webmail.<dominio>).
  MAILWAY_PANEL_HOST        Nombre del panel (por defecto panel.<dominio>).
  MAILWAY_IP                IPv4 pública del servidor (se detecta si falta).
  MAILWAY_MARCA             Nombre del servicio en el webmail (por defecto «Webmail»).
  LETSENCRYPT_EMAIL         Correo de contacto para Let's Encrypt.
  CLOUDFLARE_API_TOKEN      Token de Cloudflare (Zona: Lectura y DNS: Edición). Vacío = sin Cloudflare.
  SKYWAY_TOKEN              Token de API de Skyway (sky_…). Vacío = no desplegar el panel.
  SKYWAY_URL                API de Skyway (por defecto http://127.0.0.1:4000).
  SKYWAY_DIR                Carpeta de Skyway (se detecta a partir de su Traefik).
  MAILWAY_PROYECTO          Proyecto de Skyway para el panel (por defecto «mailway»).
  MAILWAY_REPO              Repositorio del panel (por defecto https://github.com/NkrowOne/Mailway).
  MAILWAY_RAMA              Rama a desplegar (por defecto main).
  MAILWAY_TRAEFIK_PROVEEDOR 1 para configurar el proveedor HTTP de Traefik sin preguntar, 0 para omitirlo.
  STALWART_ADMIN_PASSWORD   Contraseña del motor existente, si deploy/.env se perdió.
  MAILWAY_INTERNAL_SUBNET   Subred de la red interna (por defecto 10.203.53.0/24).
  MAILWAY_MAIL_INTERNAL_IP  IP del motor en esa red (por defecto 10.203.53.10).
  MAILWAY_ESPERA_DNS        Segundos máximos de espera a que propague el DNS (por defecto 300).
  MAILWAY_CLOUDFLARE_API    Base de la API de Cloudflare (solo para pruebas).
AYUDA
}

while [ $# -gt 0 ]; do
  case "$1" in
    --sin-skyway) CON_SKYWAY=0 ;;
    --sin-cloudflare) CON_CLOUDFLARE=0 ;;
    --actualizar) ACTUALIZAR=1 ;;
    --ayuda | -h | --help)
      ayuda
      exit 0
      ;;
    *) fallo "Opción desconocida: $1 (use --ayuda)." ;;
  esac
  shift
done

if [ "$ACTUALIZAR" = 1 ]; then INTERACTIVO=0; fi

# -------------------------------------------------------------- utilidades --

tiene() { command -v "$1" >/dev/null 2>&1; }

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
escapar_curl() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

# Escapa un texto para una cadena JSON (los valores propios son hex, URL o nombres).
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
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

# Inserta ajustes (pares clave valor) en el motor y lo recarga. Devuelve 1 si
# el motor informa de errores.
motor_ajustes() {
  local valores="" primero=1 respuesta errores
  while [ $# -gt 1 ]; do
    if [ "$primero" = 0 ]; then valores+=","; fi
    primero=0
    valores+=$(printf '["%s","%s"]' "$(json_escape "$1")" "$(json_escape "$2")")
    shift 2
  done
  respuesta=$(motor_api POST /api/settings "[{\"type\":\"insert\",\"prefix\":null,\"values\":[$valores],\"assert_empty\":false}]") || return 1
  if ! printf '%s' "$respuesta" | grep -q '"data"'; then
    aviso "El motor rechazó los ajustes: $respuesta"
    return 1
  fi
  respuesta=$(motor_api GET /api/reload) || return 1
  errores=$(printf '%s' "$respuesta" | jqr -r '(.data.errors // {}) | to_entries | map("\(.key): \(.value)") | join("; ")' 2>/dev/null || true)
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
resuelve_a() {
  local nombre=$1 ip=$2 servidor
  for servidor in "https://cloudflare-dns.com/dns-query" "https://dns.google/resolve"; do
    if ! curl -fsS --max-time 8 -H 'accept: application/dns-json' "$servidor?name=$nombre&type=A" 2>/dev/null |
      grep -q "\"data\":\"$ip\""; then
      return 1
    fi
  done
  return 0
}

compose() {
  if [ "$CON_SKYWAY" = 1 ]; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_MAIL" "$@"
  else
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_SOLO" "$@"
  fi
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
  if [ -n "$falta" ]; then fallo "Faltan herramientas:$falta. Instálelas y vuelva a ejecutar."; fi
  docker info >/dev/null 2>&1 || fallo "No se puede hablar con Docker. Ejecute como root (sudo) o con un usuario del grupo docker."
  docker compose version >/dev/null 2>&1 || fallo "Falta Docker Compose v2 («docker compose»). Instale el plugin docker-compose-plugin."
  ok "Docker y Docker Compose v2 disponibles."

  if [ "$CON_SKYWAY" = 1 ]; then
    if [ "$(docker inspect -f '{{.State.Running}}' skyway-traefik 2>/dev/null || true)" != "true" ]; then
      fallo "No está en marcha el Traefik de Skyway (contenedor skyway-traefik). Arranque Skyway o use --sin-skyway."
    fi
    docker network inspect skyway-edge >/dev/null 2>&1 ||
      fallo "No existe la red skyway-edge de Skyway. Arranque Skyway o use --sin-skyway."
    ok "Skyway detectado (Traefik y red skyway-edge)."
  fi

  local puerto ocupados=""
  for puerto in 25 465 587 993 4190; do
    if puerto_ocupado_por_otro "$puerto"; then ocupados+=" $puerto"; fi
  done
  if [ -n "$ocupados" ]; then
    fallo "Puertos de correo ocupados por otro programa:$ocupados. Libérelos (p. ej. postfix o exim del sistema) y vuelva a ejecutar."
  fi
  if tiene ss; then ok "Puertos 25, 465, 587, 993 y 4190 libres."; else aviso "Sin «ss» no se pueden comprobar los puertos."; fi

  if timeout 6 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null; then
    RESUMEN_P25="abierto"
    ok "Puerto 25 de salida abierto."
  else
    RESUMEN_P25="BLOQUEADO"
    aviso "El puerto 25 de salida parece bloqueado: sin él no se entrega correo a otros servidores. Solicite al proveedor que lo desbloquee."
  fi
}

# -------------------------------------------------------------- configuración --

detectar_ip() {
  local ip=""
  ip=$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)
  if ! printf '%s' "$ip" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
    ip=$(curl -4 -fsS --max-time 8 https://ipv4.icanhazip.com 2>/dev/null | tr -d '[:space:]' || true)
  fi
  if printf '%s' "$ip" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then printf '%s' "$ip"; fi
}

recoger_datos() {
  titulo "Datos de la instalación"
  if [ "$ACTUALIZAR" = 1 ] && [ ! -f "$ENV_FILE" ]; then
    fallo "No existe $ENV_FILE: no hay nada que actualizar. Ejecute el instalador sin --actualizar."
  fi

  local mail_prev dominio_def
  mail_prev=$(leer_env MAIL_HOSTNAME)
  dominio_def=${MAILWAY_DOMINIO:-}
  if [ -z "$dominio_def" ] && [ -n "$mail_prev" ]; then dominio_def=${mail_prev#mail.}; fi
  preguntar DOMINIO "Dominio base de la plataforma (p. ej. miempresa.com)" "$dominio_def"
  DOMINIO=$(printf '%s' "$DOMINIO" | tr '[:upper:]' '[:lower:]' | sed 's/^[.]*//; s/[.]*$//')
  printf '%s' "$DOMINIO" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$' ||
    fallo "Dominio no válido: «$DOMINIO». Indique un dominio como miempresa.com (variable MAILWAY_DOMINIO)."

  MAIL_HOSTNAME=${MAILWAY_MAIL_HOST:-$(leer_env MAIL_HOSTNAME)}
  WEBMAIL_HOSTNAME=${MAILWAY_WEBMAIL_HOST:-$(leer_env WEBMAIL_HOSTNAME)}
  PANEL_HOSTNAME=${MAILWAY_PANEL_HOST:-$(leer_env PANEL_HOSTNAME)}
  if [ -z "$MAIL_HOSTNAME" ] || [ "${MAIL_HOSTNAME#*.}" != "$DOMINIO" ]; then MAIL_HOSTNAME="mail.$DOMINIO"; fi
  if [ -z "$WEBMAIL_HOSTNAME" ] || [ "${WEBMAIL_HOSTNAME#*.}" != "$DOMINIO" ]; then WEBMAIL_HOSTNAME="webmail.$DOMINIO"; fi
  if [ -z "$PANEL_HOSTNAME" ] || [ "${PANEL_HOSTNAME#*.}" != "$DOMINIO" ]; then PANEL_HOSTNAME="panel.$DOMINIO"; fi
  info "Servidor de correo: $MAIL_HOSTNAME"
  info "Webmail:            $WEBMAIL_HOSTNAME"
  info "Panel:              $PANEL_HOSTNAME"

  local marca_def
  marca_def=${MAILWAY_MARCA:-$(leer_env MAILWAY_BRAND)}
  preguntar MARCA "Nombre del servicio que verán los usuarios del webmail" "${marca_def:-Webmail}"
  # Sin comillas ni «$»: el valor acaba en deploy/.env, que interpreta Compose.
  MARCA=$(printf '%s' "$MARCA" | tr -d "'\"\$\\\\\`")

  local correo_def
  correo_def=${LETSENCRYPT_EMAIL:-$(leer_env LETSENCRYPT_EMAIL)}
  preguntar LE_EMAIL "Correo de contacto para Let's Encrypt" "${correo_def:-postmaster@$DOMINIO}"

  local ip_def
  ip_def=${MAILWAY_IP:-$(leer_env MAILWAY_PUBLIC_IP)}
  if [ -z "$ip_def" ]; then ip_def=$(detectar_ip); fi
  preguntar IP_PUBLICA "IPv4 pública del servidor" "$ip_def"
  printf '%s' "$IP_PUBLICA" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' ||
    fallo "IPv4 no válida: «$IP_PUBLICA» (variable MAILWAY_IP)."
  ok "IP pública: $IP_PUBLICA"

  INTERNAL_SUBNET=${MAILWAY_INTERNAL_SUBNET:-$(leer_env MAILWAY_INTERNAL_SUBNET)}
  INTERNAL_SUBNET=${INTERNAL_SUBNET:-10.203.53.0/24}
  MAIL_INTERNAL_IP=${MAILWAY_MAIL_INTERNAL_IP:-$(leer_env MAILWAY_MAIL_INTERNAL_IP)}
  MAIL_INTERNAL_IP=${MAIL_INTERNAL_IP:-10.203.53.10}

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

# Volúmenes con datos del motor: el de esta versión o el de una anterior.
volumen_datos_motor() {
  local v
  for v in "$(leer_env MAILWAY_MAIL_VOLUME)" mailway-mail-data deploy_mailway-mail-data; do
    if [ -n "$v" ] && docker volume inspect "$v" >/dev/null 2>&1; then
      printf '%s' "$v"
      return 0
    fi
  done
  return 0
}

preparar_secretos() {
  titulo "Secretos"
  MAILWAY_SECRET=$(leer_env MAILWAY_SECRET)
  ROUNDCUBE_DES_KEY=$(leer_env ROUNDCUBE_DES_KEY)
  MAILWAY_TRAEFIK_TOKEN=$(leer_env MAILWAY_TRAEFIK_TOKEN)
  MAILWAY_SETUP_TOKEN=$(leer_env MAILWAY_SETUP_TOKEN)
  MAILWAY_WEBMAIL_TOKEN=$(leer_env MAILWAY_WEBMAIL_TOKEN)
  if [ -z "$MAILWAY_SECRET" ]; then MAILWAY_SECRET=$(aleatorio_hex 32); fi
  if [ -z "$ROUNDCUBE_DES_KEY" ]; then ROUNDCUBE_DES_KEY=$(aleatorio_hex 12); fi
  if [ -z "$MAILWAY_TRAEFIK_TOKEN" ]; then MAILWAY_TRAEFIK_TOKEN=$(aleatorio_hex 24); fi
  if [ -z "$MAILWAY_SETUP_TOKEN" ]; then MAILWAY_SETUP_TOKEN=$(aleatorio_hex 16); fi
  if [ -z "$MAILWAY_WEBMAIL_TOKEN" ]; then MAILWAY_WEBMAIL_TOKEN=$(aleatorio_hex 24); fi

  # La contraseña del motor solo se aplica en su PRIMER arranque. Si ya hay
  # datos del motor, generar otra dejaría al panel sin acceso: se reutiliza
  # la guardada o se pide.
  local previa volumen
  previa=${STALWART_ADMIN_PASSWORD:-$(leer_env STALWART_ADMIN_PASSWORD)}
  volumen=$(volumen_datos_motor)
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

# Instalaciones anteriores a la 1.0: proyecto de Compose «deploy», volúmenes
# deploy_* y red interna sin subred fija. Se reutilizan los datos sin copiar.
migrar_instalacion_anterior() {
  local proyecto vol_mail vol_web
  proyecto=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' mailway-mail 2>/dev/null || true)
  MAILWAY_MAIL_VOLUME=$(leer_env MAILWAY_MAIL_VOLUME)
  MAILWAY_WEBMAIL_DB_VOLUME=$(leer_env MAILWAY_WEBMAIL_DB_VOLUME)
  MAILWAY_PANEL_VOLUME=$(leer_env MAILWAY_PANEL_VOLUME)

  if [ -n "$proyecto" ] && [ "$proyecto" != "mailway" ]; then
    titulo "Migración de una instalación anterior"
    info "Los contenedores actuales pertenecen al proyecto de Compose «$proyecto»; la 1.0 usa «mailway»."
    vol_mail="${proyecto}_mailway-mail-data"
    vol_web="${proyecto}_mailway-webmail-db"
    if [ -z "$MAILWAY_MAIL_VOLUME" ] && docker volume inspect "$vol_mail" >/dev/null 2>&1; then
      MAILWAY_MAIL_VOLUME=$vol_mail
    fi
    if [ -z "$MAILWAY_WEBMAIL_DB_VOLUME" ] && docker volume inspect "$vol_web" >/dev/null 2>&1; then
      MAILWAY_WEBMAIL_DB_VOLUME=$vol_web
    fi
    if [ -z "$MAILWAY_PANEL_VOLUME" ] && docker volume inspect "${proyecto}_mailway-panel-data" >/dev/null 2>&1; then
      MAILWAY_PANEL_VOLUME="${proyecto}_mailway-panel-data"
    fi
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
  local c
  if [ "$MIGRAR_CONTENEDORES" = 1 ]; then
    for c in mailway-webmail mailway-certs-dumper mailway-mail mailway-panel; do
      if docker inspect "$c" >/dev/null 2>&1; then docker rm -f "$c" >/dev/null; fi
    done
    ok "Contenedores de la instalación anterior retirados; los volúmenes se conservan."
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
          *) fallo "La red mailway-internal tiene conectado «$c», que no es de Mailway. Desconéctelo y vuelva a ejecutar." ;;
        esac
      done
      docker network rm mailway-internal >/dev/null
      ok "Red mailway-internal recreada con la subred $INTERNAL_SUBNET."
    fi
  fi
}

escribir_env() {
  titulo "Configuración (deploy/.env)"
  local tmp claves clave linea
  umask 077
  tmp=$(mktemp "$(dirname "$ENV_FILE")/.env.XXXXXX")
  {
    printf '# Generado por deploy/instalar.sh %s el %s. Contiene secretos: permisos 600.\n' \
      "$VERSION_INSTALADOR" "$(date -u '+%Y-%m-%d %H:%M UTC')"
    printf '# Se puede volver a ejecutar el instalador: reutiliza estos valores.\n\n'
    printf 'MAIL_HOSTNAME=%s\n' "$MAIL_HOSTNAME"
    printf 'WEBMAIL_HOSTNAME=%s\n' "$WEBMAIL_HOSTNAME"
    printf 'PANEL_HOSTNAME=%s\n' "$PANEL_HOSTNAME"
    printf 'MAILWAY_PUBLIC_IP=%s\n' "$IP_PUBLICA"
    printf "MAILWAY_BRAND='%s'\n" "$MARCA"
    printf 'LETSENCRYPT_EMAIL=%s\n\n' "$LE_EMAIL"
    printf '# Motor (solo se aplica en su primer arranque; no la cambie aquí después).\n'
    printf 'STALWART_ADMIN_PASSWORD=%s\n\n' "$STALWART_ADMIN_PASSWORD"
    printf '# Webmail\n'
    printf 'ROUNDCUBE_DES_KEY=%s\n' "$ROUNDCUBE_DES_KEY"
    printf 'MAILWAY_PANEL_URL=https://%s\n' "$PANEL_HOSTNAME"
    printf 'MAILWAY_WEBMAIL_URL=https://%s\n' "$WEBMAIL_HOSTNAME"
    printf 'MAILWAY_PANEL_INTERNAL_URL=%s\n\n' "$PANEL_INTERNAL_URL"
    printf '# Secretos compartidos con el panel (sus variables en Skyway llevan los mismos).\n'
    printf 'MAILWAY_SECRET=%s\n' "$MAILWAY_SECRET"
    printf 'MAILWAY_SETUP_TOKEN=%s\n' "$MAILWAY_SETUP_TOKEN"
    printf 'MAILWAY_TRAEFIK_TOKEN=%s\n' "$MAILWAY_TRAEFIK_TOKEN"
    printf 'MAILWAY_WEBMAIL_TOKEN=%s\n\n' "$MAILWAY_WEBMAIL_TOKEN"
    printf '# Red interna (subred fija que el motor exime de su bloqueo automático).\n'
    printf 'MAILWAY_INTERNAL_SUBNET=%s\n' "$INTERNAL_SUBNET"
    printf 'MAILWAY_MAIL_INTERNAL_IP=%s\n' "$MAIL_INTERNAL_IP"
    if [ -n "$TRAEFIK_ACME_VOLUME" ]; then printf 'TRAEFIK_ACME_VOLUME=%s\n' "$TRAEFIK_ACME_VOLUME"; fi
    if [ -n "$MAILWAY_MAIL_VOLUME" ]; then printf 'MAILWAY_MAIL_VOLUME=%s\n' "$MAILWAY_MAIL_VOLUME"; fi
    if [ -n "$MAILWAY_WEBMAIL_DB_VOLUME" ]; then printf 'MAILWAY_WEBMAIL_DB_VOLUME=%s\n' "$MAILWAY_WEBMAIL_DB_VOLUME"; fi
    if [ -n "$MAILWAY_PANEL_VOLUME" ]; then printf 'MAILWAY_PANEL_VOLUME=%s\n' "$MAILWAY_PANEL_VOLUME"; fi
  } >"$tmp"

  # Las claves añadidas a mano se conservan.
  claves=" MAIL_HOSTNAME WEBMAIL_HOSTNAME PANEL_HOSTNAME MAILWAY_PUBLIC_IP MAILWAY_BRAND LETSENCRYPT_EMAIL"
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
    if ! cmp -s "$tmp" "$ENV_FILE"; then
      cp -p "$ENV_FILE" "$ENV_FILE.anterior"
    fi
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
  ok "Escrito $ENV_FILE (permisos 600)."
}

# ------------------------------------------------------------------- DNS --

cf_primer_error() {
  printf '%s' "$RESP_BODY" | jqr -r '(.errors // [])[0] | if . then "\(.message) (código \(.code))" else "HTTP '"$RESP_CODE"'" end' 2>/dev/null ||
    printf 'HTTP %s' "$RESP_CODE"
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
    info "Sin token: cree a mano los registros A de $MAIL_HOSTNAME, $WEBMAIL_HOSTNAME y $PANEL_HOSTNAME hacia $IP_PUBLICA."
    return 0
  fi

  # La zona se busca del nombre más largo al más corto (admite subdominios delegados).
  local candidato="$DOMINIO"
  while :; do
    cf_api GET "/zones?name=$candidato&per_page=5"
    if [ "$RESP_CODE" != "200" ]; then
      fallo "Cloudflare rechazó el token: $(cf_primer_error). Compruebe los permisos Zona: Lectura y DNS: Edición."
    fi
    CF_ZONA_ID=$(printf '%s' "$RESP_BODY" | jqr -r '(.result // [])[0].id // empty')
    if [ -n "$CF_ZONA_ID" ]; then
      CF_ZONA_NOMBRE=$candidato
      break
    fi
    case "$candidato" in *.*.*) candidato=${candidato#*.} ;; *) break ;; esac
  done
  if [ -z "$CF_ZONA_ID" ]; then
    fallo "El token no tiene acceso a la zona de $DOMINIO en Cloudflare. Añada la zona a los permisos del token."
  fi
  ok "Zona de Cloudflare: $CF_ZONA_NOMBRE"

  local nombre
  for nombre in "$MAIL_HOSTNAME" "$WEBMAIL_HOSTNAME" "$PANEL_HOSTNAME"; do
    cf_registro A "$nombre" "$IP_PUBLICA"
  done
  # Autoconfiguración de programas de correo para el propio dominio base.
  for nombre in "autoconfig.$DOMINIO" "autodiscover.$DOMINIO"; do
    cf_registro CNAME "$nombre" "$MAIL_HOSTNAME"
  done
}

# Crea o corrige un registro sin proxy (el proxy de Cloudflare rompe SMTP/IMAP
# y la validación de certificados).
cf_registro() {
  local tipo=$1 nombre=$2 contenido=$3 existente id actual proxied otro cuerpo
  cf_api GET "/zones/$CF_ZONA_ID/dns_records?name=$nombre&per_page=100"
  [ "$RESP_CODE" = "200" ] || fallo "No se pudieron leer los registros de $nombre: $(cf_primer_error)."
  existente=$(printf '%s' "$RESP_BODY" | jqr -r --arg t "$tipo" 'first((.result // [])[] | select(.type == $t)) | "\(.id) \(.content) \(.proxied)"' 2>/dev/null || true)
  otro=$(printf '%s' "$RESP_BODY" | jqr -r --arg t "$tipo" 'first((.result // [])[] | select(.type != $t and (.type == "A" or .type == "AAAA" or .type == "CNAME"))) | .type' 2>/dev/null || true)
  cuerpo=$(printf '{"type":"%s","name":"%s","content":"%s","ttl":1,"proxied":false,"comment":"Mailway"}' "$tipo" "$nombre" "$contenido")

  if [ -n "$otro" ]; then
    aviso "$nombre ya tiene un registro $otro: no se crea el $tipo. Revíselo en Cloudflare."
    return 0
  fi
  if [ -z "$existente" ]; then
    cf_api POST "/zones/$CF_ZONA_ID/dns_records" "$cuerpo"
    [ "$RESP_CODE" = "200" ] || fallo "No se pudo crear $tipo $nombre: $(cf_primer_error)."
    ok "Creado $tipo $nombre → $contenido"
    return 0
  fi
  read -r id actual proxied <<<"$existente"
  if [ "$actual" = "$contenido" ] && [ "$proxied" = "false" ]; then
    ok "$tipo $nombre → $contenido (ya correcto)"
    return 0
  fi
  if [ "$actual" != "$contenido" ] &&
    ! confirmar "$nombre apunta a $actual. ¿Cambiarlo a $contenido?" s; then
    aviso "$nombre se deja apuntando a $actual."
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
      info "Cree los registros A hacia $IP_PUBLICA en su proveedor de DNS (sin proxy)."
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
    RESUMEN_PTR="SIN CONFIGURAR: pida al proveedor del servidor el DNS inverso $IP_PUBLICA → $MAIL_HOSTNAME"
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
      esperar_sano mailway-mail 90 || fallo "El motor no arranca. Revise: docker exec mailway-mail tail -n 50 /opt/stalwart/logs/stalwart.log.$(date -u +%F)"
    else
      fallo "El motor no arranca. Revise: docker logs mailway-mail y docker exec mailway-mail ls /opt/stalwart/logs"
    fi
  fi
  ok "Motor en marcha (mailway-mail)."
  compose_q ${perfiles[@]+"${perfiles[@]}"} up -d --remove-orphans
  if esperar_sano mailway-webmail 180; then
    ok "Webmail en marcha (mailway-webmail)."
  else
    aviso "El webmail aún no está sano. Revise: docker logs mailway-webmail"
  fi
  if [ "$CON_SKYWAY" = 0 ]; then
    if esperar_sano mailway-panel 120; then ok "Panel en marcha (mailway-panel)."; else aviso "El panel aún no está sano. Revise: docker logs mailway-panel"; fi
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
  local existentes
  existentes=$(motor_api GET '/api/settings/keys?keys=acme.mailway.directory,acme.mailway.provider,certificate.mailway.cert' 2>/dev/null || true)
  if [ -z "$CF_TOKEN" ] && printf '%s' "$existentes" | grep -q '"acme.mailway.directory"'; then
    RESUMEN_CERT="Let's Encrypt emitido por el propio motor (configurado antes)"
    ok "El motor ya emite su certificado con Let's Encrypt."
    return 0
  fi
  if [ -z "$CF_TOKEN" ] && printf '%s' "$existentes" | grep -q '"certificate.mailway.cert"'; then
    compose_q --profile tls up -d certs-dumper || true
    motor_api GET /api/reload/certificate >/dev/null || true
    RESUMEN_CERT="certificado de Traefik volcado al motor (el panel lo recarga a diario)"
    ok "El motor ya usa el certificado volcado de Traefik; recargado."
    return 0
  fi

  if [ -n "$CF_TOKEN" ] && [ -n "$CF_ZONA_NOMBRE" ]; then
    # Vía preferida: el motor pide y renueva su certificado por DNS-01.
    if motor_ajustes \
      acme.mailway.directory "$LE_DIRECTORIO" \
      acme.mailway.challenge dns-01 \
      acme.mailway.provider cloudflare \
      acme.mailway.secret "$CF_TOKEN" \
      acme.mailway.contact.0 "$LE_EMAIL" \
      acme.mailway.domains.0 "$MAIL_HOSTNAME" \
      acme.mailway.origin "$CF_ZONA_NOMBRE" \
      acme.mailway.renew-before 30d \
      acme.mailway.default true; then
      RESUMEN_CERT="Let's Encrypt emitido por el propio motor (DNS-01 en Cloudflare); tarda unos minutos"
      ok "Certificado de IMAP/SMTP solicitado a Let's Encrypt por DNS-01."
    else
      aviso "No se pudo configurar la emisión del certificado; puede repetirse en Ajustes → Servidor de correo."
    fi
    return 0
  fi

  # Sin Cloudflare: se usa el certificado que Traefik obtiene para el nombre
  # del servidor de correo, volcado a ficheros.
  if [ "$CON_SKYWAY" = 1 ] && [ -z "$TRAEFIK_ACME_VOLUME" ]; then
    aviso "No se encontró el volumen de certificados de Traefik: emita el certificado desde Ajustes → Servidor de correo."
    return 0
  fi
  if [ "$CON_SKYWAY" = 0 ] && [ "$USAR_PROXY_PROPIO" = 0 ]; then
    aviso "Sin proxy propio ni Cloudflare, el certificado de IMAP/SMTP se emite desde Ajustes → Servidor de correo."
    return 0
  fi
  info "Volcando el certificado que obtiene Traefik para $MAIL_HOSTNAME…"
  compose_q --profile tls up -d certs-dumper
  local t=0 ruta="/opt/stalwart/certs/$MAIL_HOSTNAME"
  while [ "$t" -lt 180 ]; do
    if docker exec mailway-mail test -s "$ruta/cert.pem" 2>/dev/null; then break; fi
    sleep 5
    t=$((t + 5))
  done
  if ! docker exec mailway-mail test -s "$ruta/cert.pem" 2>/dev/null; then
    RESUMEN_CERT="pendiente: Traefik aún no tiene el certificado de $MAIL_HOSTNAME (vuelva a ejecutar con --actualizar)"
    aviso "Traefik aún no tiene el certificado de $MAIL_HOSTNAME. Cuando el DNS apunte aquí, ejecute de nuevo con --actualizar."
    return 0
  fi
  if motor_ajustes \
    certificate.mailway.cert "%{file:$ruta/cert.pem}%" \
    certificate.mailway.private-key "%{file:$ruta/key.pem}%" \
    certificate.mailway.default true; then
    motor_api GET /api/reload/certificate >/dev/null || true
    RESUMEN_CERT="certificado de Traefik volcado al motor (el panel lo recarga a diario)"
    ok "El motor usa el certificado de Traefik para IMAP y SMTP."
  else
    aviso "No se pudo configurar el certificado volcado; revise Ajustes → Servidor de correo."
  fi
}

# ----------------------------------------------------------------- Skyway --

desplegar_en_skyway() {
  titulo "Panel en Skyway"
  SKYWAY_URL=${SKYWAY_URL:-http://127.0.0.1:4000}
  SKYWAY_URL=${SKYWAY_URL%/}
  if [ "$INTERACTIVO" = 1 ] && [ -z "${SKYWAY_TOKEN:-}" ]; then
    info "Con un token de API de Skyway (Mi perfil → Tokens de API, «sky_…») se despliega el panel"
    info "desde GitHub con su dominio, volumen y variables. Intro para hacerlo a mano después."
  fi
  preguntar_secreto SKYWAY_TOKEN "Token de API de Skyway" "${SKYWAY_TOKEN:-}"
  if [ -z "$SKYWAY_TOKEN" ]; then
    info "Omitido. Variables del panel para crearlo a mano: vea el final de deploy/.env.example."
    return 0
  fi
  case "$SKYWAY_TOKEN" in sky_*) ;; *) fallo "El token de Skyway debe empezar por «sky_»." ;; esac

  sky_api GET /api/health
  [ "$RESP_CODE" = "200" ] || fallo "Skyway no responde en $SKYWAY_URL (variable SKYWAY_URL)."
  local version
  version=$(printf '%s' "$RESP_BODY" | jqr -r '.version // "?"')
  ok "Skyway $version en $SKYWAY_URL"

  local nombre_proyecto proyecto proyecto_id proyecto_slug
  nombre_proyecto=${MAILWAY_PROYECTO:-mailway}
  sky_api GET /api/projects
  [ "$RESP_CODE" = "200" ] || fallo "Skyway rechazó el token (HTTP $RESP_CODE). Use un token de administrador."
  proyecto=$(printf '%s' "$RESP_BODY" | jqr -r --arg n "$nombre_proyecto" \
    'first((.projects // [])[] | select(.slug == $n or .name == $n)) | "\(.id) \(.slug)"' 2>/dev/null || true)
  if [ -z "$proyecto" ]; then
    sky_api POST /api/projects "{\"name\":\"$(json_escape "$nombre_proyecto")\"}"
    [ "$RESP_CODE" = "201" ] || [ "$RESP_CODE" = "200" ] ||
      fallo "No se pudo crear el proyecto en Skyway: $(printf '%s' "$RESP_BODY" | jqr -r '.error // empty' 2>/dev/null)"
    proyecto=$(printf '%s' "$RESP_BODY" | jqr -r '.project | "\(.id) \(.slug)"')
    ok "Proyecto «$nombre_proyecto» creado en Skyway."
  else
    ok "Proyecto «$nombre_proyecto» ya existe en Skyway."
  fi
  read -r proyecto_id proyecto_slug <<<"$proyecto"

  local variables
  variables=$(env_json \
    "STALWART_URL=http://mailway-mail:8080" \
    "STALWART_ADMIN_USER=admin" \
    "STALWART_ADMIN_PASSWORD=$STALWART_ADMIN_PASSWORD" \
    "STALWART_SMTP_HOST=mailway-mail" \
    "STALWART_SMTP_PORT=587" \
    "MAILWAY_SMTP_ALLOW_SELF_SIGNED=1" \
    "MAILWAY_SECRET=$MAILWAY_SECRET" \
    "MAILWAY_SETUP_TOKEN=$MAILWAY_SETUP_TOKEN" \
    "MAILWAY_TRAEFIK_TOKEN=$MAILWAY_TRAEFIK_TOKEN" \
    "MAILWAY_WEBMAIL_TOKEN=$MAILWAY_WEBMAIL_TOKEN" \
    "MAILWAY_MAIL_HOSTNAME=$MAIL_HOSTNAME" \
    "MAILWAY_PUBLIC_IP=$IP_PUBLICA" \
    "MAILWAY_WEBMAIL_URL=https://$WEBMAIL_HOSTNAME" \
    "MAILWAY_PANEL_URL=https://$PANEL_HOSTNAME" \
    "MAILWAY_ENGINE_TRUSTED_NETWORK=$INTERNAL_SUBNET")

  local servicio servicio_id servicio_slug despliegue_inicial
  sky_api GET "/api/projects/$proyecto_id"
  servicio=$(printf '%s' "$RESP_BODY" | jqr -r \
    'first((.services // [])[] | select(.name == "panel" and .type == "git")) | "\(.id) \(.slug)"' 2>/dev/null || true)
  if [ -z "$servicio" ]; then
    local cuerpo
    cuerpo=$(printf '{"type":"git","name":"panel","repoUrl":"%s","branch":"%s","port":4100,"domains":["%s"],"autoDeploy":true,"env":%s}' \
      "$(json_escape "${MAILWAY_REPO:-https://github.com/NkrowOne/Mailway}")" \
      "$(json_escape "${MAILWAY_RAMA:-main}")" "$PANEL_HOSTNAME" "$variables")
    sky_api POST "/api/projects/$proyecto_id/services" "$cuerpo"
    [ "$RESP_CODE" = "201" ] || [ "$RESP_CODE" = "200" ] ||
      fallo "No se pudo crear el servicio del panel: $(printf '%s' "$RESP_BODY" | jqr -r '.error // empty' 2>/dev/null)"
    servicio=$(printf '%s' "$RESP_BODY" | jqr -r '.service | "\(.id) \(.slug)"')
    despliegue_inicial=$(printf '%s' "$RESP_BODY" | jqr -r '.deployment.id // empty')
    # El alta despliega al instante, aún sin volumen: ese despliegue se
    # cancela y se repite con /data persistente.
    if [ -n "$despliegue_inicial" ]; then sky_api POST "/api/deployments/$despliegue_inicial/cancel"; fi
    ok "Servicio «panel» creado (repositorio ${MAILWAY_REPO:-https://github.com/NkrowOne/Mailway}, rama ${MAILWAY_RAMA:-main})."
  else
    # Variables: se fusionan con las existentes (PUT reemplaza la lista entera).
    read -r servicio_id servicio_slug <<<"$servicio"
    sky_api GET "/api/services/$servicio_id/env"
    local fusion
    fusion=$(printf '%s\n%s' "$RESP_BODY" "$variables" | jqr -s -c '{vars: ((.[0].vars // {}) + .[1])}')
    sky_api PUT "/api/services/$servicio_id/env" "$fusion"
    [ "$RESP_CODE" = "200" ] || fallo "No se pudieron actualizar las variables del panel (HTTP $RESP_CODE)."
    ok "Servicio «panel» ya existe: variables actualizadas."
  fi
  read -r servicio_id servicio_slug <<<"$servicio"
  PANEL_CONTENEDOR="skyway-$proyecto_slug-$servicio_slug"

  # Sin volumen, la base de datos del panel se perdería en cada despliegue.
  sky_api PATCH "/api/services/$servicio_id" '{"config":{"volumes":[{"containerPath":"/data"}],"healthcheckPath":"/api/health"}}'
  [ "$RESP_CODE" = "200" ] || fallo "No se pudo configurar el volumen del panel: $(printf '%s' "$RESP_BODY" | jqr -r '.error // empty' 2>/dev/null)"
  ok "Volumen /data y comprobación /api/health configurados."

  sky_api GET /api/domains/config
  if [ "$RESP_CODE" = "200" ] && [ "$(printf '%s' "$RESP_BODY" | jqr -r '.tls')" != "true" ]; then
    aviso "Skyway no tiene correo de Let's Encrypt: el panel no tendrá HTTPS. Configúrelo en Skyway → Ajustes → Dominios."
  fi

  sky_api POST "/api/services/$servicio_id/deploy" '{}'
  [ "$RESP_CODE" = "202" ] || [ "$RESP_CODE" = "200" ] || fallo "No se pudo lanzar el despliegue del panel (HTTP $RESP_CODE)."
  local despliegue estado t=0
  despliegue=$(printf '%s' "$RESP_BODY" | jqr -r '.deployment.id')
  info "Desplegando el panel (compila desde GitHub; puede tardar varios minutos)…"
  while [ "$t" -lt 1500 ]; do
    sleep 10
    t=$((t + 10))
    sky_api GET "/api/deployments/$despliegue"
    estado=$(printf '%s' "$RESP_BODY" | jqr -r '.deployment.status // "desconocido"' 2>/dev/null || printf 'desconocido')
    case "$estado" in
      success)
        RESUMEN_SKYWAY="desplegado ($PANEL_CONTENEDOR)"
        ok "Panel desplegado ($PANEL_CONTENEDOR)."
        return 0
        ;;
      failed | canceled)
        RESUMEN_SKYWAY="despliegue fallido: revise el registro en Skyway"
        aviso "El despliegue del panel terminó en «$estado». Revise el registro del despliegue en Skyway (¿acceso de Skyway al repositorio de GitHub?)."
        return 0
        ;;
    esac
  done
  RESUMEN_SKYWAY="desplegando (consulte Skyway)"
  aviso "El despliegue sigue en curso; consulte su estado en Skyway."
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

# Comillas simples de YAML y «$» doblado (Compose interpola los dólares).
yaml_literal() {
  local s=$1
  s=${s//\'/\'\'}
  s=${s//\$/\$\$}
  printf "'%s'" "$s"
}

# Proveedor HTTP de Traefik: sirve las rutas de los dominios de los clientes
# (webmail de marca blanca y autoconfiguración de dispositivos).
configurar_proveedor_traefik() {
  titulo "Dominios de los clientes en Traefik"
  local argumentos override endpoint cabecera=""
  argumentos=$(docker inspect -f '{{json .Config.Cmd}}' skyway-traefik 2>/dev/null || printf '[]')
  if printf '%s' "$argumentos" | grep -q 'providers.http.endpoint'; then
    ok "El Traefik de Skyway ya consulta un proveedor HTTP."
    return 0
  fi
  if [ -z "$SKYWAY_DIR" ] || [ ! -f "$SKYWAY_DIR/docker-compose.yml" ]; then
    aviso "No se encontró la carpeta de Skyway: configure el proveedor con deploy/skyway-traefik-override.yml."
    return 0
  fi
  override="$SKYWAY_DIR/docker-compose.override.yml"
  if [ -f "$override" ]; then
    aviso "Ya existe $override y no se modifica. Añada a mano las líneas de deploy/skyway-traefik-override.yml."
    return 0
  fi
  case "${MAILWAY_TRAEFIK_PROVEEDOR:-}" in
    0) info "Omitido (MAILWAY_TRAEFIK_PROVEEDOR=0)."; return 0 ;;
    1) ;;
    *)
      confirmar "¿Configurar el Traefik de Skyway para los dominios de los clientes? Traefik se reinicia unos segundos." s ||
        { info "Omitido."; return 0; }
      ;;
  esac

  # Con el puente de Skyway (filtra lo que publica Mailway), mejor por él.
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${SKYWAY_URL:-http://127.0.0.1:4000}/api/traefik/mailway" 2>/dev/null || true)" = "200" ]; then
    endpoint="http://skyway:4000/api/traefik/mailway"
  else
    endpoint="http://${PANEL_CONTENEDOR:-skyway-mailway-panel}:4100/api/traefik/config"
    cabecera="--providers.http.headers.X-Mailway-Token=$MAILWAY_TRAEFIK_TOKEN"
  fi

  umask 077
  {
    printf '# Generado por el instalador de Mailway el %s.\n' "$(date -u '+%Y-%m-%d')"
    printf '# Compose REEMPLAZA «command»: se repiten los flags actuales de Traefik y se\n'
    printf '# añade el proveedor HTTP de Mailway. Si actualiza Skyway y cambian sus flags,\n'
    printf '# borre este fichero y vuelva a ejecutar deploy/instalar.sh --actualizar.\n'
    printf 'services:\n  traefik:\n    command:\n'
    printf '%s' "$argumentos" | jqr -r '.[]' | while IFS= read -r arg; do
      printf '      - %s\n' "$(yaml_literal "$arg")"
    done
    printf '      - %s\n' "$(yaml_literal "--providers.http.endpoint=$endpoint")"
    printf '      - %s\n' "'--providers.http.pollInterval=15s'"
    printf '      - %s\n' "'--providers.http.pollTimeout=5s'"
    if [ -n "$cabecera" ]; then printf '      - %s\n' "$(yaml_literal "$cabecera")"; fi
  } >"$override"
  chmod 600 "$override"
  local salida
  if ! salida=$(cd "$SKYWAY_DIR" && docker compose up -d traefik 2>&1); then
    printf '%s\n' "$salida" >&2
    fallo "Traefik no arrancó con $override. Bórrelo y ejecute «docker compose up -d traefik» en $SKYWAY_DIR."
  fi
  ok "Traefik consulta $endpoint."
  if [ "$endpoint" = "http://skyway:4000/api/traefik/mailway" ]; then
    info "Tras la puesta en marcha, conecte Mailway en Skyway → Ajustes → Mailway con un token de gestión."
  fi
}

# ---------------------------------------------------------------- resumen --

resumen() {
  titulo "Resumen"
  local copia volumen
  volumen=${MAILWAY_MAIL_VOLUME:-mailway-mail-data}
  copia="docker run --rm -v $volumen:/origen:ro -v /root/copias:/destino alpine tar czf /destino/mailway-correo-\$(date +%F).tar.gz -C /origen ."
  printf '\n'
  info "Panel:               https://$PANEL_HOSTNAME/setup?token=$MAILWAY_SETUP_TOKEN"
  info "Webmail:             https://$WEBMAIL_HOSTNAME"
  info "Web del motor:       https://$MAIL_HOSTNAME (usuario admin; contraseña en deploy/.env)"
  info "Token de puesta en marcha: $MAILWAY_SETUP_TOKEN"
  if [ "$CON_SKYWAY" = 1 ]; then info "Panel en Skyway:     $RESUMEN_SKYWAY"; fi
  if [ "$CON_SKYWAY" = 0 ] && [ "$USAR_PROXY_PROPIO" = 0 ]; then
    info "Sin proxy propio:    panel en 127.0.0.1:4100 y webmail en 127.0.0.1:8000; póngales delante un proxy con TLS."
  fi
  info "DNS de la plataforma: $RESUMEN_DNS"
  info "DNS inverso (PTR):   $RESUMEN_PTR"
  info "Puerto 25 de salida: $RESUMEN_P25"
  info "Certificado IMAP/SMTP: $RESUMEN_CERT"
  printf '\n'
  info "Copia de seguridad del correo:"
  info "  $copia"
  printf '\n'
  info "Siguientes pasos:"
  info "  1. Abra el panel con el enlace de arriba y complete la puesta en marcha."
  info "  2. En Conexiones → Cloudflare, conecte una cuenta para publicar el DNS de los dominios de los clientes."
  info "  3. En Ajustes → Servidor de correo, compruebe el certificado y el nombre del servidor."
  if [ "$CON_SKYWAY" = 1 ]; then
    info "  4. En Skyway → Ajustes → Mailway, pegue la URL del panel y un token de gestión (Mailway → Conexiones)."
  fi
}

# ------------------------------------------------------------------ main --

main() {
  printf '%sInstalador de Mailway %s%s\n' "$C_TIT" "$VERSION_INSTALADOR" "$C_0"
  if [ "$CON_SKYWAY" = 1 ]; then info "Modo: junto a Skyway."; else info "Modo: instalación autónoma (sin Skyway)."; fi
  if [ "$ACTUALIZAR" = 1 ]; then info "Actualización: se reutiliza deploy/.env sin preguntas."; fi

  comprobaciones_previas
  recoger_datos
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
  if [ "$CON_SKYWAY" = 0 ]; then PANEL_INTERNAL_URL="http://mailway-panel:4100"; fi
  PANEL_INTERNAL_URL=${PANEL_INTERNAL_URL:-http://skyway-mailway-panel:4100}

  migrar_instalacion_anterior
  escribir_env
  configurar_cloudflare
  esperar_dns
  comprobar_ptr
  levantar_servicios
  configurar_motor

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
  fi

  resumen
}

main
