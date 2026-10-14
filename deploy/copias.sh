#!/usr/bin/env bash
# ============================================================================
# Copias externas: la parte de Mailway
# ----------------------------------------------------------------------------
# Las copias de seguridad externas (S3, cifradas) las hace Skyway con
# «sudo skyway copias» (scripts/copias/copias.sh de su repositorio). Skyway
# localiza Mailway por el enlace /usr/local/bin/mailway o por la etiqueta de
# Compose del contenedor mailway-mail y llama a este fichero, que dice qué hay
# que copiar de Mailway y cómo pararlo, arrancarlo y volver a aplicarlo al
# restaurar. Cada repositorio declara lo suyo: cuando Mailway añade un
# volumen, su regla va aquí, y deploy/prueba-copias.sh (en la CI) falla si
# algún volumen de los compose se queda sin ella.
#
#   bash deploy/copias.sh inventario [--env FICHERO]   # qué copiar: una línea JSON, sin secretos
#   bash deploy/copias.sh parar                         # detiene la pila de correo
#   bash deploy/copias.sh arrancar                      # la vuelve a levantar tal cual
#   bash deploy/copias.sh reaplicar [--ip IPv4]         # instalar.sh --actualizar sin preguntas
#   bash deploy/copias.sh mantenimiento on|off          # avisa al panel de que el motor se para un momento
#
# inventario lee deploy/.env (o el de --env) y los compose, sin red y sin
# Docker; si Docker responde, añade lo que ve: los contenedores que existen
# (también el del panel), los volúmenes que faltan, los de intentos de
# migración del motor y los del proyecto que no tienen regla. De deploy/.env
# solo salen su ruta y nombres de volúmenes: ningún valor secreto. Cada
# volumen lleva su consistencia, lo que hace la copia en su segunda pasada
# (la primera es siempre en caliente; la segunda solo lee lo que ha cambiado):
#   parar        detiene sus contenedores: el motor (RocksDB solo se copia
#                íntegra con la base cerrada);
#   pausar       los congela con «docker pause»: las bases SQLite del
#                webmail, del panel autónomo y de Bulwark, y el acme.json del
#                Traefik propio;
#   en-caliente  nadie lo usa (o solo lo lee).
# La regla de cada volumen está en regla_volumen, y los ficheros que se
# copian, en ficheros_con_estado.
#
# parar y arrancar usan el compose, los perfiles y el motor que usa el
# instalador (su función compose), con «stop» y «start»: no recrean ni borran
# ningún contenedor. reaplicar es «instalar.sh --actualizar» desatendido,
# como en «mailway update --auto», con MAILWAY_IP si se indica --ip (al
# restaurar en un servidor con otra IP). mantenimiento pone el panel en su modo
# mantenimiento (tools/motor.js) mientras la copia tiene el motor parado unos
# segundos: así su vigilante no lo toma por una caída.
#
# Códigos de salida:
#   0  hecho;
#   1  no se ha podido (el motivo, en la salida de errores);
#   2  uso incorrecto;
#   3  (arrancar) faltan contenedores o el del motor no corresponde a
#      deploy/.env (p. ej. tras restaurar una copia de antes de migrar el
#      motor): hay que aplicar la configuración con «reaplicar». Si lo que no
#      cuadra es el motor, no se arranca nada; si solo faltan otros, se
#      arranca lo que existe.
#
# Lo poco que comparte con instalar.sh y mailway.sh (leer deploy/.env, el
# modo de la instalación, el motor, el contenedor del panel y la cerradura)
# está repetido aquí a propósito: los dos ejecutan su orden al cargarse y no
# se pueden incluir, y este fichero tiene que funcionar solo y sin Docker. Los
# nombres de los volúmenes y la imagen del motor no se repiten: salen de los
# compose, que son la referencia.
# ============================================================================
set -euo pipefail

SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
DEPLOY_DIR="$(cd "$(dirname "$SCRIPT")" && pwd -P)"
RAIZ="$(cd "$DEPLOY_DIR/.." && pwd -P)"
ENV_FILE="${MAILWAY_ENV_FILE:-$DEPLOY_DIR/.env}"
COMPOSE_MAIL="$DEPLOY_DIR/docker-compose.mail.yml"
COMPOSE_SOLO="$DEPLOY_DIR/docker-compose.standalone.yml"
# Nombre fijo de los compose («name: mailway»): el proyecto de Compose de sus
# contenedores y volúmenes.
PROYECTO=mailway
MOTOR_015=stalwart-0.15
MOTOR_016=stalwart-0.16
# Contenedores de la pila en el orden en que se listan (y se arrancan sus
# servicios): primero el motor, del que dependen los demás.
ORDEN_CONTENEDORES=(mailway-mail mailway-mail-gw mailway-webmail mailway-certs-dumper
  mailway-bulwark mailway-bulwark-gw mailway-panel mailway-proxy)

# Estado de la ejecución (ver cargar_configuracion).
CON_DOCKER=0
MODO=""
MOTOR=""
COMPOSE=""
BULWARK_ACTIVO=0
BULWARK_USADO=0
# «nombre|proyecto|oneoff|servicio» de cada contenedor (también los parados)
# y «nombre|proyecto» de cada volumen: una consulta a Docker de cada.
DOCKER_CONTENEDORES=""
DOCKER_VOLUMENES=""
# Volúmenes del compose del modo: clave de «volumes:» y nombre con deploy/.env aplicado.
CLAVES=()
NOMBRES=()
# Inventario: objetos JSON de los volúmenes (los del motor en uso, primero:
# datos y configuración) y de los ignorados, y los nombres ya clasificados.
VOL_DATOS=()
VOL_CONFIG=()
VOL_RESTO=()
IGNORADOS=()
VISTOS=" "

# ------------------------------------------------------------------ salida --

info() { printf '%s\n' "$*"; }
aviso() { printf 'Aviso: %s\n' "$*" >&2; }
fallo() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}
# Sale con 3: hay que aplicar la configuración con «reaplicar».
pide_reaplicar() {
  printf 'Error: %s\n' "$*" >&2
  exit 3
}
USO="Uso: bash deploy/copias.sh inventario [--env FICHERO] | parar | arrancar | reaplicar [--ip IPv4] | mantenimiento on|off"
mal_uso() {
  printf 'Error: %s\n%s\n' "$1" "$USO" >&2
  exit 2
}

ayuda() {
  cat <<'AYUDA'
Copias externas de Mailway (las hace Skyway: sudo skyway copias)

Uso: bash deploy/copias.sh <orden>

  inventario [--env FICHERO]  Qué copiar de Mailway y cómo, en una línea JSON y sin
                              secretos. Funciona sin Docker; con Docker, añade lo que ve.
  parar                       Detiene la pila de correo (motor, pasarela, webmail,
                              extractor y Bulwark; en la instalación autónoma, también el
                              panel y su Traefik) sin borrar ningún contenedor.
  arrancar                    La vuelve a levantar tal cual, sin recrear nada.
  reaplicar [--ip IPv4]       Aplica deploy/.env con instalar.sh --actualizar, sin
                              preguntas (tras restaurar en un servidor nuevo; --ip, con
                              su IP pública).
  mantenimiento on|off        Pone (o quita) el panel en modo mantenimiento mientras la
                              copia para el motor: su vigilante no avisa de una caída.
                              Si ya lo estaba (un cambio de motor), no lo toca.

Códigos de salida: 0 hecho; 1 no se ha podido (el motivo, en la salida de errores);
2 uso incorrecto; 3 (arrancar) faltan contenedores o el del motor no corresponde a
deploy/.env: aplica la configuración con «reaplicar».
AYUDA
}

# ------------------------------------------------------------ deploy/.env --

# Valor de CLAVE en deploy/.env sin ejecutarlo (quita las comillas
# envolventes), como leer_env de instalar.sh y leer_clave de mailway.sh.
leer_env() {
  local linea valor
  [ -r "$ENV_FILE" ] || return 0
  linea=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)
  valor=${linea#*=}
  case "$valor" in
    \'*\') valor=${valor:1:${#valor}-2} ;;
    \"*\") valor=${valor:1:${#valor}-2} ;;
  esac
  printf '%s' "$valor"
}

# ¿Tiene deploy/.env alguna de estas claves con valor? Sin leer el valor:
# algunas son secretos y no hace falta tenerlos en ninguna variable.
#   hay_valor CLAVE [CLAVE…]
hay_valor() {
  local claves
  claves=$(
    IFS='|'
    printf '%s' "$*"
  )
  grep -qE "^($claves)=['\"]?[^'\"[:space:]]" "$ENV_FILE" 2>/dev/null
}

ruta_absoluta() { printf '%s/%s' "$(cd "$(dirname "$1")" && pwd -P)" "$(basename "$1")"; }

# Nombre válido para Docker (volúmenes y contenedores). Es lo que acaba en
# rutas y órdenes de quien copia: nada de barras ni espacios.
nombre_docker_valido() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9_.-]+$ ]]; }

# ----------------------------------------------------------------- Docker --

docker_responde() {
  command -v docker >/dev/null 2>&1 || return 1
  if command -v timeout >/dev/null 2>&1; then
    timeout 30 docker info >/dev/null 2>&1
  else
    docker info >/dev/null 2>&1
  fi
}

cargar_docker() {
  DOCKER_CONTENEDORES=$(docker ps -a --format \
    '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.oneoff"}}|{{.Label "com.docker.compose.service"}}' 2>/dev/null) ||
    fallo "Docker no ha podido listar los contenedores."
  DOCKER_VOLUMENES=$(docker volume ls --format '{{.Name}}|{{.Label "com.docker.compose.project"}}' 2>/dev/null) ||
    fallo "Docker no ha podido listar los volúmenes."
}

existe_contenedor() {
  local nombre
  while IFS='|' read -r nombre _; do
    if [ -n "$nombre" ] && [ "$nombre" = "$1" ]; then return 0; fi
  done <<<"$DOCKER_CONTENEDORES"
  return 1
}

existe_volumen() {
  local nombre
  while IFS='|' read -r nombre _; do
    if [ -n "$nombre" ] && [ "$nombre" = "$1" ]; then return 0; fi
  done <<<"$DOCKER_VOLUMENES"
  return 1
}

# Contenedores del proyecto (sin los de «compose run»), uno por línea.
contenedores_del_proyecto() {
  local nombre proyecto oneoff servicio
  while IFS='|' read -r nombre proyecto oneoff servicio; do
    if [ -n "$nombre" ] && [ "$proyecto" = "$PROYECTO" ] && [ "$oneoff" != True ]; then printf '%s\n' "$nombre"; fi
  done <<<"$DOCKER_CONTENEDORES"
}

# Servicio de Compose de un contenedor del proyecto (vacío si no lo es).
servicio_de() {
  local nombre proyecto oneoff servicio
  while IFS='|' read -r nombre proyecto oneoff servicio; do
    if [ "$nombre" = "$1" ] && [ "$proyecto" = "$PROYECTO" ] && [ "$oneoff" != True ]; then
      printf '%s' "$servicio"
      return 0
    fi
  done <<<"$DOCKER_CONTENEDORES"
}

volumenes_del_proyecto() {
  local nombre proyecto
  while IFS='|' read -r nombre proyecto; do
    if [ -n "$nombre" ] && [ "$proyecto" = "$PROYECTO" ]; then printf '%s\n' "$nombre"; fi
  done <<<"$DOCKER_VOLUMENES"
}

# ¿Está $1 entre los demás argumentos?
en_lista() {
  local buscado=$1 e
  shift
  for e in "$@"; do
    if [ "$e" = "$buscado" ]; then return 0; fi
  done
  return 1
}

# Los contenedores de la entrada en el orden de ORDEN_CONTENEDORES y, detrás,
# los demás por orden alfabético.
ordenar_contenedores() {
  local -a hay=()
  local c
  mapfile -t hay
  for c in "${ORDEN_CONTENEDORES[@]}"; do
    if en_lista "$c" ${hay[@]+"${hay[@]}"}; then printf '%s\n' "$c"; fi
  done
  while IFS= read -r c; do
    if [ -n "$c" ] && ! en_lista "$c" "${ORDEN_CONTENEDORES[@]}"; then printf '%s\n' "$c"; fi
  done < <(printf '%s\n' ${hay[@]+"${hay[@]}"} | LC_ALL=C sort -u)
}

# ---------------------------------------------------------- configuración --

# Modo de la instalación, como lo decide el instalador: el de deploy/.env y,
# en los anteriores a la 1.0 (sin MAILWAY_INSTALACION), autónoma si existe el
# contenedor mailway-panel.
modo_instalacion() {
  case "$(leer_env MAILWAY_INSTALACION)" in
    autonoma) printf 'autonoma' ;;
    '') if [ "$CON_DOCKER" = 1 ] && existe_contenedor mailway-panel; then printf 'autonoma'; else printf 'skyway'; fi ;;
    *) printf 'skyway' ;;
  esac
}

# Motor de la instalación, como motor_configurado de instalar.sh: el de
# deploy/.env; sin él (instalaciones de antes de la 0.16), el del contenedor
# del motor y, si no lo hay, la 0.15.
motor_configurado() {
  local m
  m=$(leer_env MAILWAY_MOTOR)
  case "$m" in
    "$MOTOR_015" | "$MOTOR_016")
      printf '%s' "$m"
      return 0
      ;;
    '') ;;
    *) aviso "MAILWAY_MOTOR de $ENV_FILE no es $MOTOR_016 ni $MOTOR_015: se toma el motor del contenedor (o, sin él, la 0.15), como el instalador." ;;
  esac
  if [ "$CON_DOCKER" = 1 ] && existe_contenedor mailway-mail; then
    case "$(docker inspect --type container -f '{{.Config.Image}}' mailway-mail 2>/dev/null || true)" in
      *stalwart:v0.16*)
        printf '%s' "$MOTOR_016"
        return 0
        ;;
    esac
  fi
  printf '%s' "$MOTOR_015"
}

# Contenedor del panel junto a Skyway, como contenedor_panel_conocido de
# instalar.sh: el de MAILWAY_PANEL_INTERNAL_URL (skyway-<proyecto>-<servicio>)
# o, si falta, skyway-mailway-panel.
contenedor_panel_skyway() {
  local interna re='^http://(skyway-[a-z0-9][a-z0-9_.-]*):[0-9]{1,5}$'
  interna=$(leer_env MAILWAY_PANEL_INTERNAL_URL)
  if [[ $interna =~ $re ]]; then printf '%s' "${BASH_REMATCH[1]}"; else printf 'skyway-mailway-panel'; fi
}

# Imagen (con su versión exacta) de un compose, como imagen_compose de instalar.sh.
#   imagen_compose <fichero> <inicio de la imagen, p. ej. stalwartlabs/stalwart:>
imagen_compose() {
  { sed -n -E "s#^[[:space:]]*image:[[:space:]]*($2[^[:space:]]+)[[:space:]]*\$#\1#p" "$1" 2>/dev/null || true; } | head -n 1
}

# Volúmenes de primer nivel de un compose («volumes:» sin sangría), uno por
# línea: «clave expresión-del-nombre» («-» sin «name:»). Basta con el formato
# de los compose de deploy/ (bloques con dos espacios por nivel); la prueba
# lo contrasta con «docker compose config».
volumenes_compose() {
  awk -v q="'" '
    function soltar() {
      if (clave != "") print clave, (nombre == "" ? "-" : nombre)
      clave = ""
      nombre = ""
    }
    /^[^ \t#]/ {
      soltar()
      seccion = $0
      sub(/:.*/, "", seccion)
      next
    }
    seccion != "volumes" { next }
    /^  [A-Za-z0-9][A-Za-z0-9_.-]*:[ \t]*$/ {
      soltar()
      clave = $0
      sub(/^  /, "", clave)
      sub(/:[ \t]*$/, "", clave)
      next
    }
    clave != "" && /^    name:/ {
      nombre = $0
      sub(/^    name:[ \t]*/, "", nombre)
      sub(/[ \t]+#.*$/, "", nombre)
      sub(/[ \t]+$/, "", nombre)
      gsub("^[\"" q "]|[\"" q "]$", "", nombre)
    }
    END { soltar() }
  ' "$1"
}

# Nombre de un volumen a partir de su «name:» del compose, con las variables
# de deploy/.env (${VAR:-por defecto}, ${VAR} o un nombre fijo).
resolver_nombre() {
  local expr=$1 re='^\$\{([A-Za-z_][A-Za-z0-9_]*)(:?-([^}]*))?\}$' variable defecto valor
  if [[ $expr =~ $re ]]; then
    variable=${BASH_REMATCH[1]}
    defecto=${BASH_REMATCH[3]}
    valor=$(leer_env "$variable")
    printf '%s' "${valor:-$defecto}"
  else
    printf '%s' "$expr"
  fi
}

# Variable de deploy/.env que da nombre al volumen (para los mensajes: su
# valor no se muestra).
variable_de() {
  local re='^\$\{([A-Za-z_][A-Za-z0-9_]*)'
  if [[ $1 =~ $re ]]; then printf '%s' "${BASH_REMATCH[1]}"; fi
}

cargar_volumenes_compose() {
  local clave expr nombre variable
  CLAVES=()
  NOMBRES=()
  [ -f "$COMPOSE" ] || fallo "No existe $COMPOSE."
  while read -r clave expr; do
    [ -n "$clave" ] || continue
    if [ "$expr" = - ]; then nombre="${PROYECTO}_$clave"; else nombre=$(resolver_nombre "$expr"); fi
    if ! nombre_docker_valido "$nombre"; then
      variable=$(variable_de "$expr")
      fallo "El volumen «$clave» de $(basename "$COMPOSE") no tiene un nombre válido para Docker${variable:+ (revisa $variable en $ENV_FILE)}."
    fi
    CLAVES+=("$clave")
    NOMBRES+=("$nombre")
  done < <(volumenes_compose "$COMPOSE")
  [ "${#CLAVES[@]}" -gt 0 ] || fallo "No se han encontrado los volúmenes de $COMPOSE."
}

# Nombre del volumen de una clave del compose del modo.
nombre_volumen() {
  local i
  for i in "${!CLAVES[@]}"; do
    if [ "${CLAVES[i]}" = "$1" ]; then
      printf '%s' "${NOMBRES[i]}"
      return 0
    fi
  done
  return 1
}

# Lo que hace falta en todas las órdenes: deploy/.env, Docker (si responde),
# el modo, el motor, Bulwark y los volúmenes del compose del modo.
cargar_configuracion() {
  [ -f "$ENV_FILE" ] || fallo "No existe $ENV_FILE: Mailway no está instalado en $RAIZ, o su configuración está en otro fichero (MAILWAY_ENV_FILE; en inventario, también --env)."
  [ -r "$ENV_FILE" ] || fallo "No se puede leer $ENV_FILE (permisos 600): ejecuta como root."
  ENV_FILE=$(ruta_absoluta "$ENV_FILE")
  if docker_responde; then
    CON_DOCKER=1
    cargar_docker
  fi
  MODO=$(modo_instalacion)
  MOTOR=$(motor_configurado)
  if [ "$MODO" = autonoma ]; then COMPOSE=$COMPOSE_SOLO; else COMPOSE=$COMPOSE_MAIL; fi
  # Bulwark activo: lo pide deploy/.env y el motor es la 0.16 (bulwark_activo
  # de instalar.sh). Usado alguna vez: deploy/.env guarda su estado o sus
  # secretos, que la desactivación conserva junto a sus volúmenes.
  if [ "$MOTOR" = "$MOTOR_016" ] && [ "$(leer_env MAILWAY_BULWARK)" = 1 ]; then BULWARK_ACTIVO=1; fi
  if hay_valor MAILWAY_BULWARK BULWARK_SESSION_SECRET BULWARK_ADMIN_PASSWORD; then BULWARK_USADO=1; fi
  cargar_volumenes_compose
}

# -------------------------------------------------------------------- JSON --

json_texto() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  s=${s//[[:cntrl:]]/}
  printf '"%s"' "$s"
}

json_o_null() { if [ -n "$1" ]; then json_texto "$1"; else printf 'null'; fi; }

json_lista() {
  local primero=1 e
  printf '['
  for e in "$@"; do
    if [ "$primero" = 0 ]; then printf ','; fi
    primero=0
    json_texto "$e"
  done
  printf ']'
}

# Objetos JSON ya formados, en una lista.
unir() {
  local IFS=,
  printf '[%s]' "$*"
}

# ------------------------------------------------------------- inventario --

ya_clasificado() { case "$VISTOS" in *" $1 "*) return 0 ;; esac; return 1; }

# ¿Existe el volumen? Con Docker, lo que diga Docker; sin él, lo que deja ver
# deploy/.env ($2: 1 si lo da por existente).
existe_o_supuesto() {
  if [ "$CON_DOCKER" = 1 ]; then existe_volumen "$1"; else [ "$2" = 1 ]; fi
}

# Un volumen que no se copia, con el motivo.
#   ignorar <nombre> <motivo>
ignorar() {
  ya_clasificado "$1" && return 0
  VISTOS+="$1 "
  IGNORADOS+=("$(printf '{"nombre":%s,"motivo":%s}' "$(json_texto "$1")" "$(json_texto "$2")")")
}

# Un volumen que se copia. Con Docker, solo si existe, y con los contenedores
# que existen; si no lo usa ninguno, la segunda pasada no tiene nada que
# detener: en caliente.
#   copiar <nombre> <rol> <descripción> <consistencia> [contenedores…]
copiar() {
  local nombre=$1 rol=$2 descripcion=$3 consistencia=$4 c
  local -a usan=()
  shift 4
  ya_clasificado "$nombre" && return 0
  if [ "$CON_DOCKER" = 1 ]; then
    if ! existe_volumen "$nombre"; then
      ignorar "$nombre" "No existe en este servidor."
      return 0
    fi
    for c in "$@"; do
      if existe_contenedor "$c"; then usan+=("$c"); fi
    done
  else
    usan=("$@")
  fi
  if [ "${#usan[@]}" -eq 0 ]; then consistencia=en-caliente; fi
  VISTOS+="$nombre "
  local objeto
  objeto=$(printf '{"nombre":%s,"rol":%s,"descripcion":%s,"consistencia":%s,"contenedores":%s}' \
    "$(json_texto "$nombre")" "$(json_texto "$rol")" "$(json_texto "$descripcion")" \
    "$(json_texto "$consistencia")" "$(json_lista ${usan[@]+"${usan[@]}"})")
  case "$rol" in
    motor-datos) VOL_DATOS+=("$objeto") ;;
    motor-config) VOL_CONFIG+=("$objeto") ;;
    *) VOL_RESTO+=("$objeto") ;;
  esac
}

# La regla de cada volumen de los compose, por su clave en «volumes:»: se
# copia (rol, descripción, consistencia y contenedores que lo usan) o se
# ignora (motivo). Un volumen nuevo en los compose necesita su regla aquí:
# sin ella se copia en caliente como «sin-regla» y deploy/prueba-copias.sh
# falla. Roles: motor-datos y motor-config (el motor en uso), motor-anterior
# (el de la otra versión que se conserva), motor-intento (Stalwart 0.16 de un
# intento de migración que volvió atrás), webmail, bulwark, panel,
# certificados y sin-regla.
#   regla_volumen <clave> <nombre>
regla_volumen() {
  local clave=$1 nombre=$2 supuesto=0 variable descripcion
  case "$clave" in
    mailway-mail-data)
      # Stalwart 0.15. Tras migrar a la 0.16 se conserva intacto como vuelta
      # atrás (y con el correo de antes de migrar) hasta que se retira.
      if [ "$MOTOR" = "$MOTOR_015" ]; then
        copiar "$nombre" motor-datos "Correo, cuentas y configuración del motor (Stalwart 0.15)." parar mailway-mail
        return 0
      fi
      if hay_valor MAILWAY_MOTOR_MIGRADO MAILWAY_MAIL_VOLUME; then supuesto=1; fi
      if existe_o_supuesto "$nombre" "$supuesto"; then
        copiar "$nombre" motor-anterior "Correo y configuración de Stalwart 0.15 de antes de pasar a la 0.16: la vuelta atrás (sudo mailway revertir-motor) hasta que se retira." en-caliente
      elif hay_valor MAILWAY_MOTOR_MIGRADO; then
        ignorar "$nombre" "Retirado tras pasar a Stalwart 0.16 (sudo mailway retirar-motor-anterior)."
      elif [ "$supuesto" = 1 ]; then
        ignorar "$nombre" "No existe en este servidor."
      else
        ignorar "$nombre" "La instalación empezó con Stalwart 0.16: no hay volumen de la 0.15."
      fi
      ;;
    mailway-stalwart-etc | mailway-stalwart-data)
      # Stalwart 0.16: config.json (solo dice dónde está la base) y RocksDB,
      # con el correo y todos los ajustes. Con la 0.15 solo existen si se
      # volvió atrás tras una migración: guardan el correo que llegó a la 0.16.
      if [ "$clave" = mailway-stalwart-data ]; then variable=MAILWAY_STALWART_DATA_VOLUME; else variable=MAILWAY_STALWART_ETC_VOLUME; fi
      if [ "$MOTOR" = "$MOTOR_016" ]; then
        if [ "$clave" = mailway-stalwart-data ]; then
          copiar "$nombre" motor-datos "Correo, cuentas y ajustes del motor (Stalwart 0.16, base RocksDB)." parar mailway-mail
        else
          copiar "$nombre" motor-config "Configuración de arranque del motor (Stalwart 0.16, config.json)." parar mailway-mail
        fi
        return 0
      fi
      if hay_valor "$variable"; then supuesto=1; fi
      if existe_o_supuesto "$nombre" "$supuesto"; then
        if [ "$clave" = mailway-stalwart-data ]; then
          descripcion="Correo y ajustes de Stalwart 0.16 de antes de volver a la 0.15, con el correo que llegó mientras se usó la 0.16."
        else
          descripcion="Configuración de arranque de Stalwart 0.16 de antes de volver a la 0.15."
        fi
        copiar "$nombre" motor-anterior "$descripcion" en-caliente
      elif [ "$supuesto" = 1 ]; then
        ignorar "$nombre" "No existe en este servidor."
      else
        ignorar "$nombre" "Esta instalación usa Stalwart 0.15 y no ha pasado a la 0.16: no hay volumen de la 0.16."
      fi
      ;;
    mailway-webmail-db)
      copiar "$nombre" webmail "Base de datos del webmail (Roundcube, SQLite): contactos, identidades, firmas y preferencias de los usuarios." pausar mailway-webmail
      ;;
    mailway-mail-certs)
      ignorar "$nombre" "Se rehace solo: guarda el certificado de MAIL_HOSTNAME que el extractor copia del acme.json de Traefik."
      ;;
    mailway-bulwark-ajustes | mailway-bulwark-admin | mailway-bulwark-estado)
      case "$clave" in
        mailway-bulwark-ajustes) descripcion="Ajustes de los usuarios de Bulwark, cifrados con BULWARK_SESSION_SECRET de deploy/.env." ;;
        mailway-bulwark-admin) descripcion="Administración de Bulwark: configuración, política y marca de cada cliente." ;;
        *) descripcion="Estado de la administración de Bulwark (registro de auditoría)." ;;
      esac
      if [ "$BULWARK_ACTIVO" = 1 ]; then
        copiar "$nombre" bulwark "$descripcion" pausar mailway-bulwark
      elif existe_o_supuesto "$nombre" "$BULWARK_USADO"; then
        # Desactivado: sus volúmenes y secretos se conservan para volver a activarlo.
        copiar "$nombre" bulwark "$descripcion Bulwark está desactivado: se conserva para volver a activarlo." en-caliente
      elif [ "$BULWARK_USADO" = 1 ]; then
        ignorar "$nombre" "No existe en este servidor."
      else
        ignorar "$nombre" "Bulwark no se ha activado nunca en este servidor: no hay datos."
      fi
      ;;
    traefik-letsencrypt)
      # Junto a Skyway: el volumen externo (TRAEFIK_ACME_VOLUME) de su Traefik.
      ignorar "$nombre" "Lo copia Skyway: son los certificados de su Traefik."
      ;;
    mailway-panel-data)
      # Instalación autónoma. Junto a Skyway, el /data del panel es un volumen
      # de su servicio en Skyway, y lo copia Skyway.
      copiar "$nombre" panel "Datos del panel (base SQLite y clave maestra)." pausar mailway-panel
      ;;
    mailway-letsencrypt)
      copiar "$nombre" certificados "Certificados de Let's Encrypt del Traefik propio (acme.json): al restaurar no hay que volver a pedirlos." pausar mailway-proxy
      ;;
    *)
      copiar "$nombre" sin-regla "Volumen de $(basename "$COMPOSE") sin regla en deploy/copias.sh: se copia en caliente." en-caliente
      ;;
  esac
}

# Con Docker, los volúmenes del proyecto que no salen de los compose: los de
# Stalwart 0.16 con fecha que no usa el motor (intentos de migración que
# volvieron atrás o una migración revertida: pueden guardar correo, se copian
# hasta que se borran) y cualquier otro, que se copia en caliente por si
# guarda datos.
volumenes_sin_compose() {
  local v sello re='^mailway-stalwart-(etc|data)-([0-9]{8}-[0-9]{6})$'
  local -a usan
  while IFS= read -r v; do
    if [ -z "$v" ] || ! nombre_docker_valido "$v" || ya_clasificado "$v"; then continue; fi
    if [[ $v =~ $re ]]; then
      sello=${BASH_REMATCH[2]}
      copiar "$v" motor-intento "Stalwart 0.16 de un intento de migración que volvió atrás o de una migración revertida ($sello): no lo usa ningún motor, pero puede guardar correo. Cuando ya no haga falta: docker volume rm $v" en-caliente
    else
      mapfile -t usan < <(docker ps -a --filter "volume=$v" --format '{{.Names}}' 2>/dev/null || true)
      copiar "$v" sin-regla "Volumen del proyecto $PROYECTO sin regla en deploy/copias.sh: se copia en caliente por si guarda datos." en-caliente ${usan[@]+"${usan[@]}"}
    fi
  done < <(volumenes_del_proyecto)
}

# Ficheros con estado que no están en un volumen ni en git (con ruta
# absoluta, los que existen): deploy/.env, la configuración y sus secretos.
# Un fichero nuevo con estado se añade aquí. No se copian, a propósito, los
# que solo describen esta copia de trabajo: .env.anterior (la versión
# anterior de deploy/.env), .actualizacion (el estado de «mailway update»,
# ligado a sus commits) ni .migracion-motor/ (registros de las órdenes del
# motor).
ficheros_con_estado() {
  if [ -f "$ENV_FILE" ]; then printf '%s\n' "$ENV_FILE"; fi
}

# Contenedores de la pila: con Docker, los del proyecto que existen; sin él,
# los que corresponden a deploy/.env.
contenedores_pila() {
  if [ "$CON_DOCKER" = 1 ]; then
    contenedores_del_proyecto | ordenar_contenedores
    return 0
  fi
  printf '%s\n' mailway-mail mailway-mail-gw mailway-webmail
  if [ "$MOTOR" = "$MOTOR_016" ]; then printf '%s\n' mailway-certs-dumper; fi
  if [ "$BULWARK_ACTIVO" = 1 ]; then printf '%s\n' mailway-bulwark mailway-bulwark-gw; fi
  if [ "$MODO" = autonoma ]; then printf '%s\n' mailway-panel mailway-proxy; fi
}

# Copia de git de Mailway: commit, rama y origen (sin credenciales). null si
# la carpeta no es una copia de git.
git_json() {
  local superior commit rama origen re='^([A-Za-z][A-Za-z0-9+.-]*://)[^/]*@(.*)$'
  if ! command -v git >/dev/null 2>&1; then
    printf 'null'
    return 0
  fi
  superior=$(git -c safe.directory="$RAIZ" -C "$RAIZ" rev-parse --show-toplevel 2>/dev/null || true)
  if [ -z "$superior" ] || [ "$(cd "$superior" && pwd -P)" != "$RAIZ" ]; then
    printf 'null'
    return 0
  fi
  commit=$(git -c safe.directory="$RAIZ" -C "$RAIZ" rev-parse --verify -q HEAD 2>/dev/null || true)
  rama=$(git -c safe.directory="$RAIZ" -C "$RAIZ" symbolic-ref --short -q HEAD 2>/dev/null || true)
  origen=$(git -c safe.directory="$RAIZ" -C "$RAIZ" config --get remote.origin.url 2>/dev/null || true)
  # https://usuario:token@github.com/… → https://github.com/…
  if [[ $origen =~ $re ]]; then origen="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"; fi
  printf '{"commit":%s,"rama":%s,"origen":%s}' "$(json_o_null "$commit")" "$(json_o_null "$rama")" "$(json_o_null "$origen")"
}

orden_inventario() {
  local version imagen motor_contenedor panel_contenedor="" panel_volumen="" i
  local -a contenedores=() ficheros=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --env)
        [ $# -ge 2 ] || mal_uso "Falta el fichero: inventario --env FICHERO"
        ENV_FILE=$2
        shift
        ;;
      --env=*) ENV_FILE=${1#--env=} ;;
      *) mal_uso "Opción desconocida para inventario: $1" ;;
    esac
    shift
  done
  cargar_configuracion

  for i in "${!CLAVES[@]}"; do regla_volumen "${CLAVES[i]}" "${NOMBRES[i]}"; done
  if [ "$CON_DOCKER" = 1 ]; then volumenes_sin_compose; fi
  mapfile -t contenedores < <(contenedores_pila)
  mapfile -t ficheros < <(ficheros_con_estado)

  version=$({ sed -n 's/^  "version": "\(.*\)",$/\1/p' "$RAIZ/package.json" 2>/dev/null || true; } | head -n 1)
  imagen=$(imagen_compose "$DEPLOY_DIR/motor/$MOTOR/compose.yml" 'stalwartlabs/stalwart:')
  motor_contenedor=mailway-mail
  if [ "$CON_DOCKER" = 1 ] && ! existe_contenedor mailway-mail; then motor_contenedor=""; fi
  if [ "$MODO" = autonoma ]; then
    panel_contenedor=mailway-panel
    panel_volumen=$(nombre_volumen mailway-panel-data || true)
  elif [ "$CON_DOCKER" = 1 ]; then
    # Junto a Skyway, el panel es un servicio de Skyway: sin Docker no se
    # puede saber si su contenedor sigue siendo el que dice deploy/.env.
    panel_contenedor=$(contenedor_panel_skyway)
  fi
  if [ "$CON_DOCKER" = 1 ] && [ -n "$panel_contenedor" ] && ! existe_contenedor "$panel_contenedor"; then panel_contenedor=""; fi

  printf '{"formato":1,"producto":"mailway","version":%s,"raiz":%s,"git":%s,"instalacion":%s,"env":%s,"ficheros":%s,' \
    "$(json_o_null "$version")" "$(json_texto "$RAIZ")" "$(git_json)" "$(json_texto "$MODO")" \
    "$(json_texto "$ENV_FILE")" "$(json_lista ${ficheros[@]+"${ficheros[@]}"})"
  printf '"motor":{"serie":%s,"imagen":%s,"contenedor":%s},"panel":{"contenedor":%s,"volumen":%s},' \
    "$(json_texto "${MOTOR#stalwart-}")" "$(json_o_null "$imagen")" "$(json_o_null "$motor_contenedor")" \
    "$(json_o_null "$panel_contenedor")" "$(json_o_null "$panel_volumen")"
  printf '"contenedores":%s,"volumenes":%s,"ignorados":%s}\n' \
    "$(json_lista ${contenedores[@]+"${contenedores[@]}"})" \
    "$(unir ${VOL_DATOS[@]+"${VOL_DATOS[@]}"} ${VOL_CONFIG[@]+"${VOL_CONFIG[@]}"} ${VOL_RESTO[@]+"${VOL_RESTO[@]}"})" \
    "$(unir ${IGNORADOS[@]+"${IGNORADOS[@]}"})"
}

# ------------------------------------------------------- parar y arrancar --

# Compose como lo llama el instalador (función compose de instalar.sh): el
# fichero del modo, MAILWAY_COMPOSE_EXTRA si lo hay, el motor de deploy/.env
# (nunca uno que llegue exportado: elige motor/<motor>/compose.yml) y sin la
# LETSENCRYPT_EMAIL del entorno, que ganaría a la de deploy/.env. Con todos
# los perfiles: «stop» y «start» solo ven los servicios de los perfiles
# activos, y así llegan también al extractor (tls), a Bulwark y al Traefik
# propio (proxy), que el instalador levanta con el suyo. Un servicio sin
# contenedor no cuenta.
compose_pila() {
  local ficheros=(-f "$COMPOSE") perfiles=(--profile tls --profile bulwark)
  if [ -n "${MAILWAY_COMPOSE_EXTRA:-}" ]; then ficheros+=(-f "$MAILWAY_COMPOSE_EXTRA"); fi
  if [ "$MODO" = autonoma ]; then perfiles+=(--profile proxy); fi
  env -u LETSENCRYPT_EMAIL MAILWAY_MOTOR="$MOTOR" docker compose --env-file "$ENV_FILE" "${ficheros[@]}" "${perfiles[@]}" "$@"
}

preparar_pila() {
  cargar_configuracion
  [ "$CON_DOCKER" = 1 ] || fallo "No se puede hablar con Docker. Ejecuta como root (sudo) o con un usuario del grupo docker."
  docker compose version >/dev/null 2>&1 || fallo "Falta Docker Compose v2 («docker compose»)."
  if [ -n "${MAILWAY_COMPOSE_EXTRA:-}" ] && [ ! -f "$MAILWAY_COMPOSE_EXTRA" ]; then
    fallo "No existe el fichero de MAILWAY_COMPOSE_EXTRA: $MAILWAY_COMPOSE_EXTRA."
  fi
}

orden_parar() {
  [ $# -eq 0 ] || mal_uso "parar no admite opciones."
  preparar_pila
  if [ "$MODO" = autonoma ]; then
    info "Deteniendo Mailway (motor, pasarela, webmail, extractor, Bulwark, panel y su Traefik)…"
  else
    info "Deteniendo la pila de correo de Mailway (motor, pasarela, webmail, extractor y Bulwark)…"
  fi
  # Con margen para que el motor cierre su base de datos limpia (RocksDB).
  compose_pila stop --timeout 120 ||
    fallo "Compose no ha podido detener la pila de correo. Revisa: docker ps -a --filter label=com.docker.compose.project=$PROYECTO"
  info "Detenida. Los contenedores se conservan: «bash deploy/copias.sh arrancar» la vuelve a levantar."
}

# Lo que no cuadra entre el contenedor del motor y deploy/.env (vacío si
# cuadra): los volúmenes de datos que monta. Con otros (el motor de antes de
# una migración, otros nombres), arrancarlo serviría el correo de antes de
# restaurar.
motor_distinto() {
  local montajes par serie=0.15
  local -a esperados
  montajes=" $(docker inspect --type container -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Destination}}={{.Name}} {{end}}{{end}}' mailway-mail 2>/dev/null || true) "
  if [ "$MOTOR" = "$MOTOR_016" ]; then
    serie=0.16
    esperados=("/var/lib/stalwart=$(nombre_volumen mailway-stalwart-data)" "/etc/stalwart=$(nombre_volumen mailway-stalwart-etc)")
  else
    esperados=("/opt/stalwart=$(nombre_volumen mailway-mail-data)")
  fi
  for par in "${esperados[@]}"; do
    case "$montajes" in
      *" $par "*) ;;
      *)
        printf 'pide Stalwart %s con el volumen %s en %s, y el contenedor no lo monta' "$serie" "${par#*=}" "${par%%=*}"
        return 0
        ;;
    esac
  done
}

orden_arrancar() {
  local distinto c servicio
  local -a definidos=() servicios=() faltan=() esenciales=(mailway-mail mailway-mail-gw mailway-webmail)
  [ $# -eq 0 ] || mal_uso "arrancar no admite opciones."
  preparar_pila
  existe_contenedor mailway-mail ||
    pide_reaplicar "No existe el contenedor del motor (mailway-mail): no se arranca nada. Crea la pila con «bash deploy/copias.sh reaplicar»."
  distinto=$(motor_distinto)
  if [ -n "$distinto" ]; then
    pide_reaplicar "El contenedor del motor no corresponde a $ENV_FILE, que $distinto: no se arranca nada. Aplica la configuración con «bash deploy/copias.sh reaplicar»."
  fi
  # Solo los servicios de los compose que tienen contenedor, en el orden de la
  # pila: «start» no crea ninguno, y algunas versiones de Compose fallan con
  # uno que no lo tiene (o que ya no existe en el compose).
  mapfile -t definidos < <(compose_pila config --services 2>/dev/null || true)
  [ "${#definidos[@]}" -gt 0 ] || fallo "Compose no ha podido leer $COMPOSE con $ENV_FILE (docker compose config)."
  while IFS= read -r c; do
    servicio=$(servicio_de "$c")
    if [ -n "$servicio" ] && en_lista "$servicio" "${definidos[@]}"; then servicios+=("$servicio"); fi
  done < <(contenedores_del_proyecto | ordenar_contenedores)
  info "Arrancando la pila de correo de Mailway (${servicios[*]})…"
  compose_pila start "${servicios[@]}" ||
    fallo "Compose no ha podido arrancar la pila de correo. Revisa: docker ps -a --filter label=com.docker.compose.project=$PROYECTO y docker logs mailway-mail"
  if [ "$BULWARK_ACTIVO" = 1 ]; then esenciales+=(mailway-bulwark mailway-bulwark-gw); fi
  if [ "$MODO" = autonoma ]; then esenciales+=(mailway-panel); fi
  for c in "${esenciales[@]}"; do
    existe_contenedor "$c" || faltan+=("$c")
  done
  if [ "${#faltan[@]}" -gt 0 ]; then
    pide_reaplicar "Arrancado lo que existe, pero faltan contenedores que pide $ENV_FILE (${faltan[*]}): créalos con «bash deploy/copias.sh reaplicar»."
  fi
  info "Pila de correo en marcha."
}

# -------------------------------------------------------------- reaplicar --

ipv4_valida() {
  local re='^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$' i
  [[ $1 =~ $re ]] || return 1
  for i in 1 2 3 4; do
    [ "$((10#${BASH_REMATCH[i]}))" -le 255 ] || return 1
  done
}

# La cerradura de «mailway update» y de las órdenes del motor
# (deploy/.actualizacion.lock), como tomar_cerrojo de mailway.sh: reaplicar no
# se cruza con ellas. Sin flock, se sigue sin ella. El descriptor 9 queda
# abierto hasta el final y el instalador lo hereda.
tomar_cerrojo() {
  command -v flock >/dev/null 2>&1 || return 0
  { exec 9>>"$DEPLOY_DIR/.actualizacion.lock"; } 2>/dev/null || return 0
  flock -n 9
}

# Lo que el resumen del instalador muestra una vez a quien instala a mano (el
# token de puesta en marcha y la contraseña de una cuenta recién creada) se
# tapa, como en «mailway update --auto» (tapar_secretos de mailway.sh): esta
# salida acaba en el registro de quien restaura.
tapar_secretos() {
  sed -E 's/(setup\?token=)[^[:space:]]+/\1•••/g; s/(Token de puesta en marcha: *)[^[:space:]]+/\1•••/; s/(Contraseña: *)[^[:space:]].*$/\1•••/'
}

orden_reaplicar() {
  local ip="" codigo=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --ip)
        [ $# -ge 2 ] || mal_uso "Falta la IP: reaplicar --ip IPv4"
        ip=$2
        shift
        ;;
      --ip=*) ip=${1#--ip=} ;;
      *) mal_uso "Opción desconocida para reaplicar: $1" ;;
    esac
    shift
  done
  if [ -n "$ip" ] && ! ipv4_valida "$ip"; then mal_uso "IPv4 no válida: «$ip»."; fi
  [ -f "$DEPLOY_DIR/instalar.sh" ] || fallo "No existe $DEPLOY_DIR/instalar.sh."
  tomar_cerrojo ||
    fallo "Hay una actualización de Mailway u otra orden del motor en curso: espera a que termine y vuelve a intentarlo."
  # Sin terminal (no pregunta nada) y como proceso aparte: con pipefail, el
  # código es el del instalador.
  if [ -n "$ip" ]; then
    info "Aplicando $ENV_FILE con instalar.sh --actualizar y la IP pública $ip…"
    MAILWAY_IP=$ip bash "$DEPLOY_DIR/instalar.sh" --actualizar </dev/null 2>&1 | tapar_secretos || codigo=$?
  else
    info "Aplicando $ENV_FILE con instalar.sh --actualizar…"
    bash "$DEPLOY_DIR/instalar.sh" --actualizar </dev/null 2>&1 | tapar_secretos || codigo=$?
  fi
  [ "$codigo" = 0 ] || fallo "instalar.sh --actualizar ha terminado con código $codigo (el motivo está arriba)."
  info "Configuración aplicada."
}

# ---------------------------------------------------------- mantenimiento --

# La segunda pasada de la copia para el motor unos segundos, con su base
# cerrada. Mientras, el panel no debe tomarlo por una caída ni intentar
# escribir en él: su modo mantenimiento para el vigilante y responde 503 a los
# cambios en el motor. Caduca solo a los 15 minutos, por si la copia se corta
# antes de quitarlo. Si ya estaba activo (un cambio de motor en curso), no se
# toca: ni se prolonga ni se quita al terminar. La marca deploy/.copias-mantenimiento
# dice que lo activó la copia.
MINUTOS_MANTENIMIENTO=15
orden_mantenimiento() {
  local modo=${1:-} panel marca="$DEPLOY_DIR/.copias-mantenimiento" estado
  case "$modo" in
    on | off) ;;
    *) mal_uso "Indica «mantenimiento on» o «mantenimiento off»." ;;
  esac
  [ $# -eq 1 ] || mal_uso "mantenimiento no admite más opciones."
  cargar_configuracion
  [ "$CON_DOCKER" = 1 ] || fallo "No se puede hablar con Docker. Ejecuta como root (sudo) o con un usuario del grupo docker."
  if [ "$MODO" = autonoma ]; then panel=mailway-panel; else panel=$(contenedor_panel_skyway); fi
  if [ "$(docker inspect --type container -f '{{.State.Running}}' "$panel" 2>/dev/null || true)" != true ]; then
    rm -f "$marca"
    info "El panel ($panel) no está en marcha: no hay a quién avisar."
    return 0
  fi
  if [ "$modo" = off ]; then
    [ -f "$marca" ] || { info "El mantenimiento no lo activó la copia: no se toca."; return 0; }
    docker exec -u node "$panel" node server/dist/tools/motor.js mantenimiento off >/dev/null ||
      fallo "El panel ($panel) no ha podido quitar el modo mantenimiento del motor."
    rm -f "$marca"
    info "Mantenimiento del motor quitado."
    return 0
  fi
  estado=$(docker exec -u node "$panel" node server/dist/tools/motor.js estado 2>/dev/null || true)
  if printf '%s' "$estado" | grep -q '"mantenimiento":{"activo":true'; then
    info "El motor ya estaba en mantenimiento (un cambio de motor): no se toca."
    return 0
  fi
  docker exec -u node "$panel" node server/dist/tools/motor.js mantenimiento on --minutos "$MINUTOS_MANTENIMIENTO" >/dev/null ||
    fallo "El panel ($panel) no ha podido activar el modo mantenimiento del motor."
  : >"$marca"
  info "Mantenimiento del motor activado (caduca solo a los $MINUTOS_MANTENIMIENTO minutos)."
}

# ------------------------------------------------------------------- main --

main() {
  local orden=${1:-}
  [ $# -eq 0 ] || shift
  case "$orden" in
    inventario) orden_inventario "$@" ;;
    parar) orden_parar "$@" ;;
    arrancar) orden_arrancar "$@" ;;
    reaplicar) orden_reaplicar "$@" ;;
    mantenimiento) orden_mantenimiento "$@" ;;
    ayuda | --ayuda | -h | --help) ayuda ;;
    '') mal_uso "Falta la orden." ;;
    *) mal_uso "Orden desconocida: $orden" ;;
  esac
}

main "$@"
