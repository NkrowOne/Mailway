#!/usr/bin/env bash
#
# Pruebas de deploy/copias.sh, la parte de Mailway de las copias externas que
# hace Skyway («sudo skyway copias»), sin contenedores, sin red y sin root:
# docker y el instalador simulados, y git de verdad sobre una copia de la
# carpeta de Mailway con sus compose de verdad. Comprueba:
#   - «inventario» con cada configuración: Stalwart 0.15 (también sin
#     MAILWAY_MOTOR), 0.16 nueva, 0.16 migrada (volúmenes con fecha y el de la
#     0.15 conservado), de vuelta en la 0.15, Bulwark activo, desactivado y
#     nunca activado, la instalación autónoma y una anterior a la 1.0: una sola
#     línea de JSON válido con los campos de la especificación, sin ningún
#     secreto de deploy/.env ni las credenciales del origen de git, y sin
#     tocar Docker cuando no responde;
#   - con Docker: el contenedor del panel, los contenedores que existen, los
#     volúmenes que faltan, el de la 0.15 ya retirado, los de intentos de
#     migración y los del proyecto sin regla;
#   - «parar» y «arrancar» con el compose, los perfiles y el motor del
#     instalador, sin recrear nada; «arrancar» no arranca un motor que no
#     corresponde a deploy/.env (código 3);
#   - «reaplicar»: instalar.sh --actualizar sin terminal, MAILWAY_IP con --ip,
#     el resumen con los secretos tapados, una IP no válida y la cerradura de
#     las actualizaciones;
#   - la COBERTURA: todo volumen de docker-compose.mail.yml,
#     docker-compose.standalone.yml y motor/*/compose.yml aparece, con su
#     regla, en «volumenes» o «ignorados» de alguna configuración probada. Si
#     alguien añade un volumen a un compose sin declararlo en copias.sh, esta
#     prueba falla y dice cuál y qué hacer (se comprueba también que lo
#     detecta). Con «docker compose» en el equipo (en la CI), la lista de
#     volúmenes se contrasta además con la de «docker compose config».
#
#   bash deploy/prueba-copias.sh     # código 1 si alguna comprobación falla
#
# Necesita git y jq. Las variables que fija cada escenario las leen copias.sh
# o los dobles, que el análisis estático no ve: de ahí SC2034. Y cada
# escenario corre en un subshell para que sus cambios no lleguen a los
# siguientes: SC2030 y SC2031.
# shellcheck disable=SC2034,SC2030,SC2031

set -uo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v jq >/dev/null 2>&1 || { echo "Falta jq." >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Falta git." >&2; exit 1; }
# El «docker compose» del equipo, si lo hay, antes de poner los dobles delante.
DOCKER_REAL=$(command -v docker || true)

TMP=$(mktemp -d)
BIN="$TMP/bin"
RAIZ="$TMP/Mailway"
ENV="$RAIZ/deploy/.env"
REGISTRO="$TMP/registro"
SALIDA="$TMP/salida"
ERRORES="$TMP/errores"
# Inventarios de cada escenario (con su deploy/.env) para la cobertura.
COBERTURA="$TMP/cobertura"
# Llamadas que ningún doble esperaba: al final, debe estar vacío.
IMPREVISTOS="$TMP/imprevistos"
mkdir -p "$BIN" "$COBERTURA"
: >"$REGISTRO"
: >"$IMPREVISTOS"
TERMINADA=0
trap 'rm -rf "$TMP"; [ "$TERMINADA" = 1 ] || echo "FALLO - la prueba terminó antes de tiempo"' EXIT

export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=Prueba GIT_AUTHOR_EMAIL=prueba@mailway.test
export GIT_COMMITTER_NAME=Prueba GIT_COMMITTER_EMAIL=prueba@mailway.test
export PRUEBA_REGISTRO=$REGISTRO PRUEBA_IMPREVISTOS=$IMPREVISTOS

# Un valor conocido en cada secreto de deploy/.env (y el token del origen de
# git): ninguno debe salir nunca de copias.sh.
S_MOTOR='Clave-del-motor-7a1f9c03e4'
S_DES='Des-key-0123456789abcdef'
S_MAESTRA='Secreto-maestro-del-panel-55aa77'
S_SETUP='Token-de-puesta-1e1e1e1e'
S_TRAEFIK='Token-de-traefik-0f0f0f0f'
S_WEBMAIL='Token-del-webmail-2d2d2d2d'
S_SESION='Sesion-de-bulwark-0123456789abcdef0123456789'
S_BULWARK='Admin-de-bulwark-3c3c3c3c'
S_GIT='ghp_TokenDeGitHub0123456789abcdef'
SECRETOS=("$S_MOTOR" "$S_DES" "$S_MAESTRA" "$S_SETUP" "$S_TRAEFIK" "$S_WEBMAIL" "$S_SESION" "$S_BULWARK" "$S_GIT")

FALLOS=0
comprobar() {
  local descripcion=$1
  shift
  if "$@"; then
    printf 'ok - %s\n' "$descripcion"
  else
    printf 'FALLO - %s\n' "$descripcion"
    FALLOS=$((FALLOS + 1))
  fi
}
contiene() { grep -Fq -- "$2" "$1"; }
no_contiene() { ! grep -Fq -- "$2" "$1"; }
igual() { [ "$1" = "$2" ]; }
incluye() { [[ $1 == *"$2"* ]]; }
vacio() { [ ! -s "$1" ]; }
# ¿Hay una línea con $3 después de la primera con $2?
despues_de() {
  local a b
  a=$(grep -nF -- "$2" "$1" | head -n 1 | cut -d: -f1)
  b=$(grep -nF -- "$3" "$1" | tail -n 1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}

# Consultas sobre la última salida: un campo, «rol consistencia [contenedores]»
# de un volumen copiado y el motivo de uno ignorado.
campo() { jq -r "$1" "$SALIDA"; }
vol() { jq -r --arg n "$1" '.volumenes[] | select(.nombre == $n) | "\(.rol) \(.consistencia) [\(.contenedores | join(","))]"' "$SALIDA"; }
ign() { jq -r --arg n "$1" '.ignorados[] | select(.nombre == $n) | .motivo' "$SALIDA"; }

# Una sola línea de JSON con exactamente los campos de la especificación
# (docs de Skyway: «Parte de Mailway»), sin nombres repetidos.
una_linea() { [ "$(wc -l <"$SALIDA")" = 1 ] && [ "$(tail -c 1 "$SALIDA" | od -An -c | tr -d ' ')" = '\n' ]; }
json_valido() { jq -e . "$SALIDA" >/dev/null 2>&1; }
conforme() {
  jq -e '
    (keys_unsorted == ["formato","producto","version","raiz","git","instalacion","env","ficheros","motor","panel","contenedores","volumenes","ignorados"])
    and .formato == 1 and .producto == "mailway"
    and (.git == null or (.git | keys_unsorted) == ["commit","rama","origen"])
    and (.instalacion | IN("skyway", "autonoma"))
    and (.ficheros | type == "array" and all(.[]; type == "string"))
    and ((.motor | keys_unsorted) == ["serie","imagen","contenedor"])
    and (.motor.serie | IN("0.15", "0.16"))
    and ((.panel | keys_unsorted) == ["contenedor","volumen"])
    and (.contenedores | type == "array" and all(.[]; type == "string"))
    and all(.volumenes[];
      keys_unsorted == ["nombre","rol","descripcion","consistencia","contenedores"]
      and (.consistencia | IN("parar", "pausar", "en-caliente"))
      and (.contenedores | type == "array")
      and (.descripcion | length > 0))
    and all(.ignorados[]; keys_unsorted == ["nombre","motivo"] and (.motivo | length > 0))
    and ([.volumenes[].nombre, .ignorados[].nombre] | length == (unique | length))
  ' "$SALIDA" >/dev/null 2>&1
}
sin_secretos() {
  local s
  for s in "${SECRETOS[@]}"; do
    if grep -Fq -- "$s" "$SALIDA" "$ERRORES"; then return 1; fi
  done
  return 0
}
# Sin Docker, copias.sh solo pregunta si responde.
solo_docker_info() { [ "$(grep -c '^docker ' "$REGISTRO")" = "$(grep -c '^docker info$' "$REGISTRO")" ]; }

# Lo que debe cumplir todo inventario, más lo propio de cada escenario.
comprobar_inventario() {
  comprobar "termina con 0" igual "$CODIGO" 0
  comprobar "una sola línea en la salida" una_linea
  comprobar "de JSON válido" json_valido
  comprobar "con los campos de la especificación" conforme
  comprobar "sin ningún secreto de deploy/.env ni del origen de git" sin_secretos
  comprobar "y sin avisos" vacio "$ERRORES"
}

# ------------------------------------------------------------------ dobles --

# docker: anota cada llamada (Compose, con el motor que recibe y si le llega
# LETSENCRYPT_EMAIL) y, con PRUEBA_DOCKER=1, responde según PRUEBA_*:
# contenedores del proyecto («nombre=servicio»), otros contenedores,
# volúmenes del proyecto, otros volúmenes, quién monta un volumen, la imagen
# y los montajes del motor y el código de Compose. Sin PRUEBA_DOCKER, no
# responde.
cat >"$BIN/docker" <<'DOCKER'
#!/usr/bin/env bash
linea="$*"
if [ "${1:-}" = compose ]; then linea="compose[${MAILWAY_MOTOR:-}${LETSENCRYPT_EMAIL+ con LETSENCRYPT_EMAIL}] ${*:2}"; fi
echo "docker $linea" >>"$PRUEBA_REGISTRO"
if [ "${PRUEBA_DOCKER:-0}" != 1 ]; then
  echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2
  exit 1
fi
case "$*" in
  info) exit 0 ;;
  "compose version") echo "Docker Compose version v2.40.3" ;;
  "ps -a --filter volume="*) for c in ${PRUEBA_MONTAN:-}; do echo "$c"; done ;;
  "ps -a --format "*)
    for c in ${PRUEBA_CONTENEDORES:-}; do printf '%s|mailway|False|%s\n' "${c%%=*}" "${c#*=}"; done
    for c in ${PRUEBA_OTROS_CONTENEDORES:-}; do printf '%s|||\n' "$c"; done
    ;;
  "volume ls --format "*)
    for v in ${PRUEBA_VOLUMENES:-}; do printf '%s|mailway\n' "$v"; done
    for v in ${PRUEBA_OTROS_VOLUMENES:-}; do printf '%s|\n' "$v"; done
    ;;
  "inspect --type container -f {{.Config.Image}} mailway-mail") echo "${PRUEBA_IMAGEN_MOTOR:-}" ;;
  "inspect --type container -f {{.State.Running}} "*) echo "${PRUEBA_PANEL_EN_MARCHA:-true}" ;;
  "exec -u node "*" node server/dist/tools/motor.js estado")
    printf '{"ok":true,"api":"jmap","mantenimiento":{"activo":%s,"hasta":null}}\n' "${PRUEBA_MANTENIMIENTO_ACTIVO:-false}" ;;
  "exec -u node "*" node server/dist/tools/motor.js mantenimiento "*) exit "${PRUEBA_MOTOR_CODIGO:-0}" ;;
  "inspect --type container -f {{range .Mounts}}"*" mailway-mail") echo "${PRUEBA_MONTAJES_MOTOR:-}" ;;
  "compose "*" config --services")
    printf '%s\n' mailway-mail mailway-mail-gw mailway-webmail certs-dumper mailway-bulwark mailway-bulwark-gw
    case "$*" in *docker-compose.standalone.yml*) printf '%s\n' mailway-panel mailway-proxy ;; esac
    ;;
  "compose "*) exit "${PRUEBA_COMPOSE_CODIGO:-0}" ;;
  *)
    echo "docker no simulado: $*" >>"$PRUEBA_IMPREVISTOS"
    exit 1
    ;;
esac
DOCKER

# El instalador: anota sus opciones, MAILWAY_IP y lo que le llega por la
# entrada estándar (nada: se ejecuta sin terminal), muestra un resumen con
# secretos y termina con PRUEBA_INSTALAR_CODIGO.
cat >"$TMP/instalar-simulado.sh" <<'INSTALAR'
#!/usr/bin/env bash
entrada=$(cat)
echo "instalar $* MAILWAY_IP=${MAILWAY_IP:-} entrada=$entrada" >>"$PRUEBA_REGISTRO"
echo "   Panel:               https://panel.ejemplo.test/setup?token=token-de-puesta-1234"
echo "   Token de puesta en marcha: token-de-puesta-1234"
echo "   Contraseña:          clave-del-administrador-1234"
exit "${PRUEBA_INSTALAR_CODIGO:-0}"
INSTALAR

chmod +x "$BIN"/* "$TMP/instalar-simulado.sh"
export PATH="$BIN:$PATH"

# Copia de la carpeta de Mailway: copias.sh, los compose y los motores de
# verdad, el instalador simulado y un package.json con su versión.
preparar_raiz() {
  local r=$1 d
  mkdir -p "$r/deploy/motor"
  cp "$AQUI/copias.sh" "$AQUI/docker-compose.mail.yml" "$AQUI/docker-compose.standalone.yml" "$r/deploy/"
  for d in "$AQUI"/motor/*/; do
    if [ -f "$d/compose.yml" ]; then
      mkdir -p "$r/deploy/motor/$(basename "$d")"
      cp "$d/compose.yml" "$r/deploy/motor/$(basename "$d")/"
    fi
  done
  cp "$TMP/instalar-simulado.sh" "$r/deploy/instalar.sh"
  printf '{\n  "name": "mailway",\n  "version": "9.8.7",\n  "private": true\n}\n' >"$r/package.json"
}
preparar_raiz "$RAIZ"
RAIZ=$(cd "$RAIZ" && pwd -P)
ENV="$RAIZ/deploy/.env"
git init -q -b main "$RAIZ"
git -C "$RAIZ" add -A
git -C "$RAIZ" commit -q -m "Mailway 9.8.7"
git -C "$RAIZ" remote add origin "https://usuario:$S_GIT@github.com/NkrowOne/Mailway.git"
COMMIT=$(git -C "$RAIZ" rev-parse HEAD)
imagen_de() { sed -n -E 's#^[[:space:]]*image:[[:space:]]*(stalwartlabs/stalwart:[^[:space:]]+).*#\1#p' "$AQUI/motor/$1/compose.yml" | head -n 1; }
IMAGEN_015=$(imagen_de stalwart-0.15)
IMAGEN_016=$(imagen_de stalwart-0.16)

# deploy/.env de un escenario: lo común, con un valor conocido en cada
# secreto, y las líneas que se indiquen (modo, motor, volúmenes, Bulwark…).
escribir_env() {
  local fichero=${ENV_DESTINO:-$ENV}
  {
    printf '# Generado por deploy/prueba-copias.sh. Contiene secretos de prueba.\n'
    printf "MAIL_HOSTNAME='mail.ejemplo.test'\nWEBMAIL_HOSTNAME='webmail.ejemplo.test'\nPANEL_HOSTNAME='panel.ejemplo.test'\n"
    printf "MAILWAY_PUBLIC_IP='203.0.113.7'\nLETSENCRYPT_EMAIL='postmaster@ejemplo.test'\n"
    printf "STALWART_ADMIN_PASSWORD='%s'\nROUNDCUBE_DES_KEY='%s'\n" "$S_MOTOR" "$S_DES"
    printf "MAILWAY_SECRET='%s'\nMAILWAY_SETUP_TOKEN='%s'\n" "$S_MAESTRA" "$S_SETUP"
    printf "MAILWAY_TRAEFIK_TOKEN='%s'\nMAILWAY_WEBMAIL_TOKEN='%s'\n" "$S_TRAEFIK" "$S_WEBMAIL"
    printf "MAILWAY_PANEL_INTERNAL_URL='http://skyway-mailway-panel:4100'\n"
    printf '%s\n' "$@"
  } >"$fichero"
}
SECRETOS_BULWARK=("BULWARK_SESSION_SECRET='$S_SESION'" "BULWARK_ADMIN_PASSWORD='$S_BULWARK'")

# Ejecuta «copias.sh <orden> …» (de $RAIZ_PRUEBA, por defecto $RAIZ) en un
# subshell, con la entrada de $ENTRADA (por defecto, ninguna): la salida en
# $SALIDA, los errores en $ERRORES y el código en $CODIGO. Las asignaciones
# PRUEBA_*=… del principio describen el escenario.
ejecutar() {
  : >"$REGISTRO"
  (
    while [[ ${1:-} == PRUEBA_*=* ]]; do
      export "${1?}"
      shift
    done
    bash "${RAIZ_PRUEBA:-$RAIZ}/deploy/copias.sh" "$@"
  ) >"$SALIDA" 2>"$ERRORES" <"${ENTRADA:-/dev/null}"
  CODIGO=$?
}

# Guarda el último inventario y su deploy/.env para la cobertura.
N_INVENTARIO=0
guardar_inventario() {
  local destino=${1:-$COBERTURA} env=${2:-$ENV}
  N_INVENTARIO=$((N_INVENTARIO + 1))
  cp "$SALIDA" "$destino/$N_INVENTARIO.json"
  cp "$env" "$destino/$N_INVENTARIO.env"
}

# --------------------------------------------------------------- escenarios --

echo "# Órdenes y opciones que no existen: uso incorrecto (código 2)"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'"
ejecutar
comprobar "sin orden: termina con 2" igual "$CODIGO" 2
ejecutar borrar
comprobar "una orden desconocida: termina con 2" igual "$CODIGO" 2
comprobar "y lo dice" contiene "$ERRORES" "Orden desconocida: borrar"
ejecutar inventario --todo
comprobar "una opción desconocida: termina con 2" igual "$CODIGO" 2
comprobar "sin nada en la salida" vacio "$SALIDA"
ejecutar ayuda
comprobar "la ayuda termina con 0" igual "$CODIGO" 0
comprobar "y explica los códigos de salida" contiene "$SALIDA" "Códigos de salida"

echo "# Junto a Skyway con Stalwart 0.15 (deploy/.env sin MAILWAY_MOTOR, como las instalaciones anteriores a la 0.16)"
escribir_env "MAILWAY_INSTALACION='skyway'" "TRAEFIK_ACME_VOLUME='skyway_traefik-letsencrypt'"
ejecutar inventario
comprobar_inventario
guardar_inventario
comprobar "sin Docker no le pregunta nada más" solo_docker_info
comprobar "versión del package.json" igual "$(campo .version)" 9.8.7
comprobar "carpeta de Mailway" igual "$(campo .raiz)" "$RAIZ"
comprobar "commit de git" igual "$(campo .git.commit)" "$COMMIT"
comprobar "rama" igual "$(campo .git.rama)" main
comprobar "origen sin las credenciales" igual "$(campo .git.origen)" "https://github.com/NkrowOne/Mailway.git"
comprobar "modo junto a Skyway" igual "$(campo .instalacion)" skyway
comprobar "deploy/.env, solo nombrado" igual "$(campo .env)" "$ENV"
comprobar "y como único fichero" igual "$(campo '.ficheros | join(" ")')" "$ENV"
comprobar "motor: la 0.15" igual "$(campo .motor.serie)" 0.15
comprobar "con la imagen exacta de su compose" igual "$(campo .motor.imagen)" "$IMAGEN_015"
comprobar "y su contenedor" igual "$(campo .motor.contenedor)" mailway-mail
comprobar "el panel es de Skyway: sin Docker, sin contenedor ni volumen" igual "$(campo '.panel | "\(.contenedor) \(.volumen)"')" "null null"
comprobar "contenedores de la pila" igual "$(campo '.contenedores | join(" ")')" "mailway-mail mailway-mail-gw mailway-webmail"
comprobar "el motor, primero y con el motor parado" igual "$(campo '.volumenes[0].nombre') $(vol mailway-mail-data)" "mailway-mail-data motor-datos parar [mailway-mail]"
comprobar "el webmail, en pausa" igual "$(vol mailway-webmail-db)" "webmail pausar [mailway-webmail]"
comprobar "nada más se copia" igual "$(campo '.volumenes | length')" 2
comprobar "sin volúmenes de la 0.16" incluye "$(ign mailway-stalwart-data)" "usa Stalwart 0.15"
comprobar "(ninguno de los dos)" incluye "$(ign mailway-stalwart-etc)" "usa Stalwart 0.15"
comprobar "el certificado del extractor se rehace" incluye "$(ign mailway-mail-certs)" "Se rehace solo"
comprobar "Bulwark, nunca activado" incluye "$(ign mailway-bulwark-ajustes)" "no se ha activado nunca"
comprobar "el acme.json de Traefik lo copia Skyway" incluye "$(ign skyway_traefik-letsencrypt)" "Lo copia Skyway"

echo "# Junto a Skyway con Stalwart 0.16 (instalación nueva) y MAILWAY_MOTOR entre comillas dobles"
escribir_env "MAILWAY_INSTALACION=skyway" 'MAILWAY_MOTOR="stalwart-0.16"' "TRAEFIK_ACME_VOLUME='skyway_traefik-letsencrypt'"
ejecutar inventario
comprobar_inventario
guardar_inventario
comprobar "motor: la 0.16" igual "$(campo .motor.serie)" 0.16
comprobar "con la imagen exacta de su compose" igual "$(campo .motor.imagen)" "$IMAGEN_016"
comprobar "los datos del motor primero, parado" igual "$(campo '.volumenes[0].nombre') $(vol mailway-stalwart-data)" "mailway-stalwart-data motor-datos parar [mailway-mail]"
comprobar "después su configuración" igual "$(campo '.volumenes[1].nombre') $(vol mailway-stalwart-etc)" "mailway-stalwart-etc motor-config parar [mailway-mail]"
comprobar "sin volumen de la 0.15" incluye "$(ign mailway-mail-data)" "empezó con Stalwart 0.16"
comprobar "con el extractor entre los contenedores" igual "$(campo '.contenedores | join(" ")')" "mailway-mail mailway-mail-gw mailway-webmail mailway-certs-dumper"

echo "# Stalwart 0.16 migrada desde la 0.15: volúmenes con fecha y el de la 0.15 conservado"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'" \
  "MAILWAY_STALWART_ETC_VOLUME='mailway-stalwart-etc-20261001-030000'" \
  "MAILWAY_STALWART_DATA_VOLUME='mailway-stalwart-data-20261001-030000'" \
  "MAILWAY_MOTOR_MIGRADO='2026-10-01T03:00:00Z'" "TRAEFIK_ACME_VOLUME='skyway_traefik-letsencrypt'"
ejecutar inventario
comprobar_inventario
guardar_inventario
comprobar "los datos del motor, con su fecha" igual "$(vol mailway-stalwart-data-20261001-030000)" "motor-datos parar [mailway-mail]"
comprobar "y su configuración" igual "$(vol mailway-stalwart-etc-20261001-030000)" "motor-config parar [mailway-mail]"
comprobar "la 0.15 conservada, en caliente y sin contenedores" igual "$(vol mailway-mail-data)" "motor-anterior en-caliente []"
comprobar "que se dice la vuelta atrás" incluye "$(campo '.volumenes[] | select(.nombre == "mailway-mail-data") | .descripcion')" "revertir-motor"
comprobar "sin los nombres por defecto de la 0.16" igual "$(campo '[.volumenes[], .ignorados[]] | map(select(.nombre == "mailway-stalwart-data")) | length')" 0

echo "# Migrada desde una instalación anterior a la 1.0 (volúmenes deploy_*)"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'" \
  "MAILWAY_STALWART_ETC_VOLUME='mailway-stalwart-etc-20261001-030000'" \
  "MAILWAY_STALWART_DATA_VOLUME='mailway-stalwart-data-20261001-030000'" \
  "MAILWAY_MOTOR_MIGRADO='2026-10-01T03:00:00Z'" "TRAEFIK_ACME_VOLUME='mi-skyway_traefik-letsencrypt'" \
  "MAILWAY_MAIL_VOLUME='deploy_mailway-mail-data'" "MAILWAY_WEBMAIL_DB_VOLUME='deploy_mailway-webmail-db'"
ejecutar inventario
comprobar_inventario
guardar_inventario
comprobar "la 0.15 con su nombre antiguo" igual "$(vol deploy_mailway-mail-data)" "motor-anterior en-caliente []"
comprobar "el webmail también" igual "$(vol deploy_mailway-webmail-db)" "webmail pausar [mailway-webmail]"
comprobar "y el acme.json con el de TRAEFIK_ACME_VOLUME" incluye "$(ign mi-skyway_traefik-letsencrypt)" "Lo copia Skyway"

echo "# De vuelta en la 0.15 tras revertir: los volúmenes de la 0.16 guardan el correo de ese tiempo"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.15'" \
  "MAILWAY_STALWART_ETC_VOLUME='mailway-stalwart-etc-20261001-030000'" \
  "MAILWAY_STALWART_DATA_VOLUME='mailway-stalwart-data-20261001-030000'"
ejecutar inventario
comprobar_inventario
guardar_inventario
comprobar "el motor es la 0.15" igual "$(vol mailway-mail-data)" "motor-datos parar [mailway-mail]"
comprobar "los datos de la 0.16, en caliente" igual "$(vol mailway-stalwart-data-20261001-030000)" "motor-anterior en-caliente []"
comprobar "con el correo que llegó a la 0.16" incluye "$(campo '.volumenes[] | select(.nombre == "mailway-stalwart-data-20261001-030000") | .descripcion')" "correo que llegó"
comprobar "y su configuración" igual "$(vol mailway-stalwart-etc-20261001-030000)" "motor-anterior en-caliente []"

echo "# Bulwark activo: sus tres volúmenes, con Bulwark en pausa"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'" "MAILWAY_BULWARK='1'" "${SECRETOS_BULWARK[@]}" \
  "MAILWAY_BULWARK_URL='http://mailway-bulwark:3000'" "MAILWAY_BULWARK_BACKEND_URL='http://mailway-bulwark-gw:8080'"
ejecutar inventario
comprobar_inventario
guardar_inventario
comprobar "ajustes de los usuarios" igual "$(vol mailway-bulwark-ajustes)" "bulwark pausar [mailway-bulwark]"
comprobar "administración" igual "$(vol mailway-bulwark-admin)" "bulwark pausar [mailway-bulwark]"
comprobar "estado" igual "$(vol mailway-bulwark-estado)" "bulwark pausar [mailway-bulwark]"
comprobar "Bulwark y su pasarela entre los contenedores" igual "$(campo '.contenedores | join(" ")')" \
  "mailway-mail mailway-mail-gw mailway-webmail mailway-certs-dumper mailway-bulwark mailway-bulwark-gw"

echo "# Bulwark desactivado: sus volúmenes se copian igual (se conservan para volver a activarlo)"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'" "MAILWAY_BULWARK='0'" "${SECRETOS_BULWARK[@]}"
ejecutar inventario
comprobar_inventario
guardar_inventario
comprobar "en caliente y sin contenedores" igual "$(vol mailway-bulwark-ajustes)" "bulwark en-caliente []"
comprobar "y lo dice" incluye "$(campo '.volumenes[] | select(.nombre == "mailway-bulwark-ajustes") | .descripcion')" "desactivado"
comprobar "sin Bulwark entre los contenedores" no_contiene "$SALIDA" '"mailway-bulwark-gw"'

echo "# Bulwark pedido con la 0.15 (no puede estar activo): se copian sus volúmenes en caliente"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.15'" "MAILWAY_BULWARK='1'" "${SECRETOS_BULWARK[@]}"
ejecutar inventario
comprobar_inventario
guardar_inventario
comprobar "en caliente" igual "$(vol mailway-bulwark-admin)" "bulwark en-caliente []"

echo "# Instalación autónoma con Stalwart 0.16: el panel y el Traefik propio son de Mailway"
escribir_env "MAILWAY_INSTALACION='autonoma'" "MAILWAY_MOTOR='stalwart-0.16'" "MAILWAY_PANEL_INTERNAL_URL='http://mailway-panel:4100'"
ejecutar inventario
comprobar_inventario
guardar_inventario
comprobar "modo autónomo" igual "$(campo .instalacion)" autonoma
comprobar "el panel y su volumen" igual "$(campo '.panel | "\(.contenedor) \(.volumen)"')" "mailway-panel mailway-panel-data"
comprobar "que se copia con el panel en pausa" igual "$(vol mailway-panel-data)" "panel pausar [mailway-panel]"
comprobar "los certificados del Traefik propio, en pausa" igual "$(vol mailway-letsencrypt)" "certificados pausar [mailway-proxy]"
comprobar "sin el acme.json de Skyway" no_contiene "$SALIDA" "traefik-letsencrypt"
comprobar "contenedores con el panel y el Traefik propio" igual "$(campo '.contenedores | join(" ")')" \
  "mailway-mail mailway-mail-gw mailway-webmail mailway-certs-dumper mailway-panel mailway-proxy"

echo "# Instalación autónoma anterior a la 1.0 (volúmenes deploy_*) con la 0.15"
escribir_env "MAILWAY_INSTALACION='autonoma'" "MAILWAY_MAIL_VOLUME='deploy_mailway-mail-data'" \
  "MAILWAY_WEBMAIL_DB_VOLUME='deploy_mailway-webmail-db'" "MAILWAY_PANEL_VOLUME='deploy_mailway-panel-data'"
ejecutar inventario
comprobar_inventario
guardar_inventario
comprobar "el panel con su volumen antiguo" igual "$(campo .panel.volumen) $(vol deploy_mailway-panel-data)" "deploy_mailway-panel-data panel pausar [mailway-panel]"
comprobar "y el motor" igual "$(vol deploy_mailway-mail-data)" "motor-datos parar [mailway-mail]"

echo "# Con --env, otro fichero (y por un enlace a copias.sh)"
mkdir -p "$TMP/otra carpeta"
ENV_DESTINO="$TMP/otra carpeta/mailway.env" escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'"
ln -s "$RAIZ/deploy/copias.sh" "$TMP/copias-enlace.sh"
: >"$REGISTRO"
(bash "$TMP/copias-enlace.sh" inventario --env "$TMP/otra carpeta/mailway.env") >"$SALIDA" 2>"$ERRORES" </dev/null
CODIGO=$?
comprobar_inventario
OTRO_ENV="$(cd "$TMP/otra carpeta" && pwd -P)/mailway.env"
comprobar "el fichero indicado, con su ruta absoluta" igual "$(campo .env)" "$OTRO_ENV"
comprobar "como único fichero" igual "$(campo '.ficheros | join("|")')" "$OTRO_ENV"
comprobar "la carpeta de Mailway, la del fichero real" igual "$(campo .raiz)" "$RAIZ"
ejecutar inventario --env "$TMP/no-existe.env"
comprobar "un fichero que no existe: termina con 1" igual "$CODIGO" 1
comprobar "lo dice" contiene "$ERRORES" "No existe $TMP/no-existe.env"
comprobar "sin nada en la salida" vacio "$SALIDA"

echo "# Un nombre de volumen no válido en deploy/.env: termina con 1 sin mostrar su valor"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MAIL_VOLUME='../../etc/$S_MOTOR'"
ejecutar inventario
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "dice qué variable revisar" contiene "$ERRORES" "revisa MAILWAY_MAIL_VOLUME"
comprobar "sin el valor" sin_secretos
comprobar "sin nada en la salida" vacio "$SALIDA"

echo "# Con Docker: la 0.16 migrada, el panel de Skyway, un intento de migración y un volumen sin regla"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'" \
  "MAILWAY_STALWART_ETC_VOLUME='mailway-stalwart-etc-20261001-030000'" \
  "MAILWAY_STALWART_DATA_VOLUME='mailway-stalwart-data-20261001-030000'" \
  "MAILWAY_MOTOR_MIGRADO='2026-10-01T03:00:00Z'" "TRAEFIK_ACME_VOLUME='skyway_traefik-letsencrypt'"
CON_DOCKER=(PRUEBA_DOCKER=1
  "PRUEBA_CONTENEDORES=mailway-webmail=mailway-webmail mailway-mail=mailway-mail mailway-certs-dumper=certs-dumper mailway-mail-gw=mailway-mail-gw"
  "PRUEBA_OTROS_CONTENEDORES=skyway skyway-traefik skyway-mailway-panel mailway-depurar"
  "PRUEBA_OTROS_VOLUMENES=skyway_traefik-letsencrypt skyway-data")
VOLS_MIGRADA="mailway-stalwart-etc-20261001-030000 mailway-stalwart-data-20261001-030000 mailway-webmail-db mailway-mail-certs"
ejecutar "${CON_DOCKER[@]}" "PRUEBA_VOLUMENES=$VOLS_MIGRADA mailway-mail-data mailway-stalwart-etc-20260915-021500 mailway-stalwart-data-20260915-021500 mailway-desconocido" \
  "PRUEBA_MONTAN=mailway-depurar" inventario
comprobar_inventario
guardar_inventario
comprobar "el contenedor del panel de Skyway" igual "$(campo .panel.contenedor)" skyway-mailway-panel
comprobar "los contenedores que existen, en el orden de la pila" igual "$(campo '.contenedores | join(" ")')" \
  "mailway-mail mailway-mail-gw mailway-webmail mailway-certs-dumper"
comprobar "el motor" igual "$(vol mailway-stalwart-data-20261001-030000)" "motor-datos parar [mailway-mail]"
comprobar "la 0.15 conservada" igual "$(vol mailway-mail-data)" "motor-anterior en-caliente []"
comprobar "el intento de migración que volvió atrás se copia en caliente" igual "$(vol mailway-stalwart-data-20260915-021500)" "motor-intento en-caliente []"
comprobar "(y su configuración)" igual "$(vol mailway-stalwart-etc-20260915-021500)" "motor-intento en-caliente []"
comprobar "diciendo cómo borrarlo" incluye "$(campo '.volumenes[] | select(.nombre == "mailway-stalwart-data-20260915-021500") | .descripcion')" "docker volume rm mailway-stalwart-data-20260915-021500"
comprobar "un volumen del proyecto sin regla se copia en caliente, con quien lo monta" igual "$(vol mailway-desconocido)" "sin-regla en-caliente [mailway-depurar]"
comprobar "Bulwark, nunca activado" incluye "$(ign mailway-bulwark-admin)" "no se ha activado nunca"
comprobar "solo lee: lista contenedores y volúmenes" igual "$(grep -c '^docker ' "$REGISTRO")" 4
comprobar "(y quién monta el volumen sin regla)" contiene "$REGISTRO" "docker ps -a --filter volume=mailway-desconocido --format {{.Names}}"

echo "# Con Docker: el volumen de la 0.15 ya retirado y el webmail sin volumen"
ejecutar "${CON_DOCKER[@]}" "PRUEBA_VOLUMENES=mailway-stalwart-etc-20261001-030000 mailway-stalwart-data-20261001-030000 mailway-mail-certs" inventario
comprobar_inventario
guardar_inventario
comprobar "la 0.15, retirada" incluye "$(ign mailway-mail-data)" "Retirado tras pasar a Stalwart 0.16"
comprobar "el webmail no existe" igual "$(ign mailway-webmail-db)" "No existe en este servidor."

echo "# Con Docker: Bulwark activo sin su contenedor, y el panel de deploy/.env que ya no existe"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'" "MAILWAY_BULWARK='1'" "${SECRETOS_BULWARK[@]}" \
  "MAILWAY_PANEL_INTERNAL_URL='http://skyway-correo-panel:4100'"
ejecutar PRUEBA_DOCKER=1 "PRUEBA_CONTENEDORES=mailway-mail=mailway-mail mailway-mail-gw=mailway-mail-gw mailway-webmail=mailway-webmail" \
  "PRUEBA_OTROS_CONTENEDORES=skyway-mailway-panel" \
  "PRUEBA_VOLUMENES=mailway-stalwart-etc mailway-stalwart-data mailway-webmail-db mailway-bulwark-ajustes mailway-bulwark-admin mailway-bulwark-estado" inventario
comprobar_inventario
guardar_inventario
comprobar "sin nadie que pausar, en caliente" igual "$(vol mailway-bulwark-ajustes)" "bulwark en-caliente []"
comprobar "el panel de deploy/.env no existe: null" igual "$(campo .panel.contenedor)" null
comprobar "ni el extractor" igual "$(campo '.contenedores | join(" ")')" "mailway-mail mailway-mail-gw mailway-webmail"

echo "# Con Docker y un deploy/.env anterior a la 1.0 (sin modo ni motor): los decide como el instalador"
escribir_env "TRAEFIK_ACME_VOLUME='skyway_traefik-letsencrypt'"
ejecutar PRUEBA_DOCKER=1 "PRUEBA_CONTENEDORES=mailway-mail=mailway-mail mailway-panel=mailway-panel" \
  PRUEBA_IMAGEN_MOTOR=stalwartlabs/stalwart:v0.16.25 "PRUEBA_VOLUMENES=mailway-stalwart-etc mailway-stalwart-data mailway-panel-data" inventario
comprobar_inventario
guardar_inventario
comprobar "autónoma: existe mailway-panel" igual "$(campo .instalacion)" autonoma
comprobar "la 0.16: la imagen del contenedor del motor" igual "$(campo .motor.serie)" 0.16
comprobar "el panel y su volumen" igual "$(vol mailway-panel-data)" "panel pausar [mailway-panel]"

echo "# parar junto a Skyway: «stop» con el compose, los perfiles y el motor del instalador"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'"
ejecutar PRUEBA_DOCKER=1 "PRUEBA_CONTENEDORES=mailway-mail=mailway-mail" parar
comprobar "termina con 0" igual "$CODIGO" 0
comprobar "detiene con Compose, con margen para el motor" contiene "$REGISTRO" \
  "docker compose[stalwart-0.16] --env-file $ENV -f $RAIZ/deploy/docker-compose.mail.yml --profile tls --profile bulwark stop --timeout 120"
comprobar "no recrea ni borra nada" no_contiene "$REGISTRO" " up "
comprobar "(ni down ni rm)" igual "$(grep -cE ' (down|rm)( |$)' "$REGISTRO")" 0
comprobar "lo dice" contiene "$SALIDA" "Los contenedores se conservan"
echo "# …sin la LETSENCRYPT_EMAIL exportada y con MAILWAY_COMPOSE_EXTRA"
printf 'services: {}\n' >"$TMP/extra.yml"
(
  export LETSENCRYPT_EMAIL=exportado@ejemplo.test MAILWAY_COMPOSE_EXTRA="$TMP/extra.yml" MAILWAY_MOTOR=stalwart-0.15
  ejecutar PRUEBA_DOCKER=1 parar
  echo "$CODIGO" >"$TMP/codigo"
)
comprobar "termina con 0" igual "$(cat "$TMP/codigo")" 0
comprobar "con el motor de deploy/.env, no el exportado, y sin LETSENCRYPT_EMAIL" contiene "$REGISTRO" "docker compose[stalwart-0.16] --env-file"
comprobar "y el fichero adicional" contiene "$REGISTRO" "-f $RAIZ/deploy/docker-compose.mail.yml -f $TMP/extra.yml --profile tls"

echo "# parar en la instalación autónoma: también el panel y el Traefik propio"
escribir_env "MAILWAY_INSTALACION='autonoma'" "MAILWAY_MOTOR='stalwart-0.15'"
ejecutar PRUEBA_DOCKER=1 parar
comprobar "termina con 0" igual "$CODIGO" 0
comprobar "con el compose autónomo y el perfil proxy" contiene "$REGISTRO" \
  "docker compose[stalwart-0.15] --env-file $ENV -f $RAIZ/deploy/docker-compose.standalone.yml --profile tls --profile bulwark --profile proxy stop --timeout 120"

echo "# parar sin Docker o si Compose falla: termina con 1"
ejecutar parar
comprobar "sin Docker: termina con 1" igual "$CODIGO" 1
comprobar "lo dice" contiene "$ERRORES" "No se puede hablar con Docker"
comprobar "sin llamar a Compose" no_contiene "$REGISTRO" "compose"
ejecutar PRUEBA_DOCKER=1 PRUEBA_COMPOSE_CODIGO=1 parar
comprobar "Compose falla: termina con 1" igual "$CODIGO" 1

echo "# arrancar: «start» de los servicios que tienen contenedor, sin crear ninguno"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'" \
  "MAILWAY_STALWART_ETC_VOLUME='mailway-stalwart-etc-20261001-030000'" \
  "MAILWAY_STALWART_DATA_VOLUME='mailway-stalwart-data-20261001-030000'"
PILA=(PRUEBA_DOCKER=1 "PRUEBA_CONTENEDORES=mailway-webmail=mailway-webmail mailway-certs-dumper=certs-dumper mailway-mail=mailway-mail mailway-mail-gw=mailway-mail-gw mailway-viejo=servicio-retirado")
MONTAJES_016="PRUEBA_MONTAJES_MOTOR=/etc/stalwart=mailway-stalwart-etc-20261001-030000 /var/lib/stalwart=mailway-stalwart-data-20261001-030000 /opt/stalwart/certs=mailway-mail-certs "
ejecutar "${PILA[@]}" "$MONTAJES_016" arrancar
comprobar "termina con 0" igual "$CODIGO" 0
comprobar "arranca sus servicios, primero el motor" contiene "$REGISTRO" \
  "docker compose[stalwart-0.16] --env-file $ENV -f $RAIZ/deploy/docker-compose.mail.yml --profile tls --profile bulwark start mailway-mail mailway-mail-gw mailway-webmail certs-dumper"
comprobar "sin un servicio que ya no está en el compose" no_contiene "$REGISTRO" "servicio-retirado"
comprobar "no crea nada" no_contiene "$REGISTRO" " up "
comprobar "lo dice" contiene "$SALIDA" "Pila de correo en marcha."

echo "# arrancar con el motor de otra copia (restaurada una de antes de migrar): no arranca nada (código 3)"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.15'"
ejecutar "${PILA[@]}" "$MONTAJES_016" arrancar
comprobar "termina con 3" igual "$CODIGO" 3
comprobar "no arranca nada" no_contiene "$REGISTRO" " start "
comprobar "dice qué no cuadra" contiene "$ERRORES" "pide Stalwart 0.15 con el volumen mailway-mail-data en /opt/stalwart"
comprobar "y qué hacer" contiene "$ERRORES" "bash deploy/copias.sh reaplicar"
echo "# …ni con otros volúmenes de la 0.16"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'"
ejecutar "${PILA[@]}" "$MONTAJES_016" arrancar
comprobar "termina con 3" igual "$CODIGO" 3
comprobar "no arranca nada" no_contiene "$REGISTRO" " start "

echo "# arrancar sin el contenedor del motor: código 3, sin arrancar nada"
ejecutar PRUEBA_DOCKER=1 "PRUEBA_CONTENEDORES=mailway-webmail=mailway-webmail" arrancar
comprobar "termina con 3" igual "$CODIGO" 3
comprobar "no arranca nada" no_contiene "$REGISTRO" " start "
comprobar "lo dice" contiene "$ERRORES" "No existe el contenedor del motor"

echo "# arrancar con Bulwark activo y sin sus contenedores: arranca lo que hay y pide reaplicar (código 3)"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'" "MAILWAY_BULWARK='1'" "${SECRETOS_BULWARK[@]}"
ejecutar PRUEBA_DOCKER=1 "PRUEBA_CONTENEDORES=mailway-mail=mailway-mail mailway-mail-gw=mailway-mail-gw mailway-webmail=mailway-webmail" \
  "PRUEBA_MONTAJES_MOTOR=/etc/stalwart=mailway-stalwart-etc /var/lib/stalwart=mailway-stalwart-data " arrancar
comprobar "termina con 3" igual "$CODIGO" 3
comprobar "arranca lo que existe" contiene "$REGISTRO" "start mailway-mail mailway-mail-gw mailway-webmail"
comprobar "y dice qué falta" contiene "$ERRORES" "(mailway-bulwark mailway-bulwark-gw)"
comprobar "sin secretos" sin_secretos
ejecutar PRUEBA_DOCKER=1 "PRUEBA_CONTENEDORES=mailway-mail=mailway-mail" PRUEBA_COMPOSE_CODIGO=1 \
  "PRUEBA_MONTAJES_MOTOR=/etc/stalwart=mailway-stalwart-etc /var/lib/stalwart=mailway-stalwart-data " arrancar
comprobar "Compose falla: termina con 1" igual "$CODIGO" 1

echo "# reaplicar --ip: instalar.sh --actualizar sin terminal, con MAILWAY_IP y los secretos tapados"
printf 's\n' >"$TMP/entrada"
ENTRADA="$TMP/entrada" ejecutar reaplicar --ip 198.51.100.20
comprobar "termina con 0" igual "$CODIGO" 0
comprobar "llama al instalador con la IP y sin nada en la entrada" contiene "$REGISTRO" "instalar --actualizar MAILWAY_IP=198.51.100.20 entrada="
comprobar "(lo de quien llama no le llega)" no_contiene "$REGISTRO" "entrada=s"
comprobar "tapa el token de puesta en marcha" no_contiene "$SALIDA" "token-de-puesta-1234"
comprobar "y la contraseña de la cuenta" no_contiene "$SALIDA" "clave-del-administrador-1234"
comprobar "pero deja ver el resto del resumen" contiene "$SALIDA" "Token de puesta en marcha: •••"
ejecutar reaplicar
comprobar "sin --ip: termina con 0" igual "$CODIGO" 0
comprobar "sin MAILWAY_IP" contiene "$REGISTRO" "instalar --actualizar MAILWAY_IP= entrada="
ejecutar reaplicar --ip=192.0.2.44
comprobar "--ip=…: también" contiene "$REGISTRO" "MAILWAY_IP=192.0.2.44"
ejecutar reaplicar --ip 300.1.2.3
comprobar "una IP no válida: termina con 2" igual "$CODIGO" 2
comprobar "sin llamar al instalador" no_contiene "$REGISTRO" "instalar"
ejecutar reaplicar --ip
comprobar "--ip sin valor: termina con 2" igual "$CODIGO" 2
ejecutar reaplicar --forzar
comprobar "otra opción: termina con 2" igual "$CODIGO" 2
ejecutar PRUEBA_INSTALAR_CODIGO=1 reaplicar
comprobar "el instalador falla: termina con 1" igual "$CODIGO" 1
comprobar "y lo dice" contiene "$ERRORES" "instalar.sh --actualizar ha terminado con código 1"
if command -v flock >/dev/null 2>&1; then
  exec 8>>"$RAIZ/deploy/.actualizacion.lock"
  flock 8
  ejecutar reaplicar
  exec 8>&-
  comprobar "con otra actualización en curso: termina con 1" igual "$CODIGO" 1
  comprobar "sin llamar al instalador" no_contiene "$REGISTRO" "instalar"
  comprobar "y lo dice" contiene "$ERRORES" "Hay una actualización de Mailway"
else
  echo "(sin flock en este equipo: se omite la cerradura)"
fi

echo "# mantenimiento on|off: el panel no toma la parada del motor por una caída"
MARCA="$RAIZ/deploy/.copias-mantenimiento"
rm -f "$MARCA"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'"
ejecutar PRUEBA_DOCKER=1 mantenimiento on
comprobar "on: termina con 0" igual "$CODIGO" 0
comprobar "lo activa en el panel de deploy/.env, 15 minutos" contiene "$REGISTRO" "docker exec -u node skyway-mailway-panel node server/dist/tools/motor.js mantenimiento on --minutos 15"
comprobar "y deja la marca de que lo activó la copia" test -f "$MARCA"
ejecutar PRUEBA_DOCKER=1 mantenimiento off
comprobar "off: termina con 0" igual "$CODIGO" 0
comprobar "lo quita" contiene "$REGISTRO" "motor.js mantenimiento off"
comprobar "y borra la marca" test ! -e "$MARCA"
ejecutar PRUEBA_DOCKER=1 PRUEBA_MANTENIMIENTO_ACTIVO=true mantenimiento on
comprobar "ya activo (un cambio de motor): termina con 0" igual "$CODIGO" 0
comprobar "sin prolongarlo" no_contiene "$REGISTRO" "mantenimiento on --minutos"
comprobar "ni dejar marca" test ! -e "$MARCA"
ejecutar PRUEBA_DOCKER=1 mantenimiento off
comprobar "y off no quita el de otro" no_contiene "$REGISTRO" "mantenimiento off"
ejecutar PRUEBA_DOCKER=1 PRUEBA_PANEL_EN_MARCHA=false mantenimiento on
comprobar "sin el panel en marcha: termina con 0 sin hacer nada" igual "$CODIGO/$(grep -c 'motor.js' "$REGISTRO")" "0/0"
escribir_env "MAILWAY_INSTALACION='autonoma'" "MAILWAY_MOTOR='stalwart-0.16'"
ejecutar PRUEBA_DOCKER=1 mantenimiento on
comprobar "en la instalación autónoma, en mailway-panel" contiene "$REGISTRO" "docker exec -u node mailway-panel node server/dist/tools/motor.js mantenimiento on"
ejecutar PRUEBA_DOCKER=1 PRUEBA_MOTOR_CODIGO=1 mantenimiento off
comprobar "si el panel falla: termina con 1" igual "$CODIGO" 1
rm -f "$MARCA"
ejecutar PRUEBA_DOCKER=1 mantenimiento
comprobar "sin on ni off: termina con 2" igual "$CODIGO" 2

# --------------------------------------------------------------- cobertura --

# Volúmenes de primer nivel de un compose, «clave expresión» (análisis propio,
# distinto del de copias.sh): la sección «volumes:» sin sangría, una clave por
# bloque con dos espacios y su «name:» con cuatro.
declarados() {
  awk '
    function soltar() { if (k != "") print k, (n == "" ? "-" : n); k = ""; n = "" }
    /^volumes:[ \t]*$/ { dentro = 1; next }
    /^[^ \t#]/ { if (dentro) soltar(); dentro = 0; next }
    !dentro { next }
    /^  [^ \t#][^ \t:]*:[ \t]*$/ { soltar(); k = $1; sub(/:$/, "", k); next }
    k != "" && /^    name:/ { n = $2 }
    END { if (dentro) soltar() }
  ' "$1"
}

# Volúmenes con nombre que montan los servicios de un compose (no carpetas).
usados() { sed -n -E 's#^[[:space:]]+-[[:space:]]+([A-Za-z0-9][A-Za-z0-9_.-]*):/.*#\1#p' "$1" | sort -u; }

# Nombre de un volumen con un deploy/.env: «${VAR:-defecto}», «${VAR}», un
# nombre fijo o, sin «name:», el que pone Compose (mailway_<clave>).
#   resolver <expresión> <.env> <clave>
resolver() {
  local expr=$1 env=$2 clave=$3 variable defecto valor re='^\$\{([A-Za-z_][A-Za-z0-9_]*)(:?-(.*))?\}$'
  expr=${expr#[\"\']}
  expr=${expr%[\"\']}
  if [ "$expr" = - ]; then
    printf 'mailway_%s' "$clave"
  elif [[ $expr =~ $re ]]; then
    variable=${BASH_REMATCH[1]}
    defecto=${BASH_REMATCH[3]}
    valor=$(sed -n "s/^$variable=//p" "$env" | tail -n 1)
    valor=${valor#[\"\']}
    valor=${valor%[\"\']}
    printf '%s' "${valor:-$defecto}"
  else
    printf '%s' "$expr"
  fi
}

# Todo volumen de los compose de <raíz>/deploy, con los inventarios de
# <carpeta>: el de docker-compose.mail.yml, en alguno junto a Skyway; el de
# docker-compose.standalone.yml, en alguno autónomo; y siempre con su regla
# (no «sin-regla»). Los de motor/*/compose.yml deben estar declarados en los
# dos compose. Escribe un mensaje por cada fallo y termina con 1 si hay alguno.
#   cobertura <raíz> <carpeta de inventarios>
cobertura() {
  local raiz=$1 dir=$2 f modo clave expr n nombre visto sin_regla fallos=0 motor
  for f in docker-compose.mail.yml docker-compose.standalone.yml; do
    if [ "$f" = docker-compose.mail.yml ]; then modo=skyway; else modo=autonoma; fi
    while read -r clave expr; do
      visto=0
      sin_regla=0
      for n in "$dir"/*.json; do
        [ "$(jq -r .instalacion "$n")" = "$modo" ] || continue
        nombre=$(resolver "$expr" "${n%.json}.env" "$clave")
        if jq -e --arg n "$nombre" '[.volumenes[], .ignorados[]] | any(.nombre == $n)' "$n" >/dev/null; then visto=1; fi
        if jq -e --arg n "$nombre" '.volumenes | any(.nombre == $n and .rol == "sin-regla")' "$n" >/dev/null; then sin_regla=1; fi
      done
      if [ "$visto" = 0 ]; then
        echo "El volumen «$clave» de deploy/$f no aparece en el inventario de deploy/copias.sh (ni en «volumenes» ni en «ignorados») con ninguna configuración probada. Declara su regla en regla_volumen() de deploy/copias.sh (si guarda datos: rol, descripción, consistencia —parar, pausar o en-caliente— y los contenedores que lo usan; si no, ignorar con su motivo) y prueba aquí la configuración en la que existe."
        fallos=1
      elif [ "$sin_regla" = 1 ]; then
        echo "El volumen «$clave» de deploy/$f no tiene regla en deploy/copias.sh: el inventario lo copia en caliente como «sin-regla». Declara su regla en regla_volumen() de deploy/copias.sh (si guarda datos: rol, descripción, consistencia —parar, pausar o en-caliente— y los contenedores que lo usan; si no, ignorar con su motivo)."
        fallos=1
      fi
    done < <(declarados "$raiz/deploy/$f")
  done
  for motor in "$raiz"/deploy/motor/*/compose.yml; do
    while IFS= read -r clave; do
      [ -n "$clave" ] || continue
      for f in docker-compose.mail.yml docker-compose.standalone.yml; do
        if ! declarados "$raiz/deploy/$f" | cut -d' ' -f1 | grep -qxF -- "$clave"; then
          echo "deploy/motor/$(basename "$(dirname "$motor")")/compose.yml usa el volumen «$clave», que no declara deploy/$f en su sección «volumes:»: decláralo allí (con su nombre) y su regla en regla_volumen() de deploy/copias.sh."
          fallos=1
        fi
      done
    done < <(usados "$motor")
  done
  return "$fallos"
}

echo "# Cobertura: todo volumen de los compose está en el inventario, con su regla"
comprobar "hay inventarios de los dos modos" igual "$(cat "$COBERTURA"/*.json | jq -r .instalacion | sort -u | tr '\n' ' ')" "autonoma skyway "
cobertura "$RAIZ" "$COBERTURA" >"$TMP/cobertura.txt"
COD_COBERTURA=$?
comprobar "ningún volumen de los compose se queda sin regla" igual "$COD_COBERTURA" 0
if [ "$COD_COBERTURA" != 0 ]; then sed 's/^/    /' "$TMP/cobertura.txt"; fi
comprobar "(el análisis encuentra volúmenes en los dos compose)" test \
  "$(declarados "$RAIZ/deploy/docker-compose.mail.yml" | wc -l)" -gt 0 -a "$(declarados "$RAIZ/deploy/docker-compose.standalone.yml" | wc -l)" -gt 0
comprobar "(y en los de cada motor)" test "$(for m in "$RAIZ"/deploy/motor/*/compose.yml; do usados "$m" | head -n 1; done | grep -c .)" \
  = "$(find "$RAIZ/deploy/motor" -name compose.yml | wc -l | tr -d ' ')"

# Contraste con Compose: lo que ve «docker compose config» en los compose de
# deploy/ (con cada motor y todos los perfiles) debe estar en lo que encuentra
# el análisis de arriba. Compose solo lista los volúmenes que usa algún servicio.
if [ -n "$DOCKER_REAL" ] && "$DOCKER_REAL" compose version >/dev/null 2>&1; then
  ENV_DESTINO="$TMP/compose.env" escribir_env "MAILWAY_INSTALACION='skyway'"
  for f in docker-compose.mail.yml docker-compose.standalone.yml; do
    : >"$TMP/compose.err"
    for motor in "$AQUI"/motor/*/compose.yml; do
      MAILWAY_MOTOR=$(basename "$(dirname "$motor")") "$DOCKER_REAL" compose --env-file "$TMP/compose.env" \
        -f "$AQUI/$f" --profile tls --profile bulwark --profile proxy config --format json 2>>"$TMP/compose.err" |
        jq -r '.volumes // {} | keys[]'
    done | sort -u >"$TMP/compose-$f"
    declarados "$AQUI/$f" | cut -d' ' -f1 | sort -u >"$TMP/analisis-$f"
    comprobar "docker compose config lee deploy/$f y ve sus volúmenes" test -s "$TMP/compose-$f" -a ! -s "$TMP/compose.err"
    if [ -s "$TMP/compose.err" ]; then sed 's/^/    /' "$TMP/compose.err"; fi
    faltan=$(comm -23 "$TMP/compose-$f" "$TMP/analisis-$f" | tr '\n' ' ')
    comprobar "y todos están en el análisis de la prueba${faltan:+ (faltan: $faltan; escríbelos como los demás, en bloque con «name:»)}" igual "$faltan" ""
  done
else
  echo "(sin docker compose en este equipo: no se contrasta con «docker compose config»)"
fi

echo "# La cobertura detecta un volumen nuevo sin regla en copias.sh"
RAIZ_NUEVO="$TMP/Mailway con un volumen nuevo"
COBERTURA_NUEVO="$TMP/cobertura-nuevo"
mkdir -p "$COBERTURA_NUEVO"
preparar_raiz "$RAIZ_NUEVO"
# Al final del compose, que termina con su sección «volumes:». El ${…} es de
# Compose, no de bash.
# shellcheck disable=SC2016
printf '  mailway-nuevo:\n    name: ${MAILWAY_NUEVO_VOLUME:-mailway-nuevo}\n' >>"$RAIZ_NUEVO/deploy/docker-compose.mail.yml"
escribir_env "MAILWAY_INSTALACION='skyway'" "MAILWAY_MOTOR='stalwart-0.16'"
RAIZ_PRUEBA="$RAIZ_NUEVO" ejecutar inventario --env "$ENV"
comprobar "el inventario lo copia por precaución" igual "$(vol mailway-nuevo)" "sin-regla en-caliente []"
guardar_inventario "$COBERTURA_NUEVO"
cobertura "$RAIZ_NUEVO" "$COBERTURA_NUEVO" >"$TMP/cobertura-nuevo.txt"
comprobar "y la cobertura falla" igual "$?" 1
comprobar "diciendo qué volumen" contiene "$TMP/cobertura-nuevo.txt" "El volumen «mailway-nuevo» de deploy/docker-compose.mail.yml no tiene regla en deploy/copias.sh"
comprobar "y qué hacer" contiene "$TMP/cobertura-nuevo.txt" "Declara su regla en regla_volumen() de deploy/copias.sh"
# Un volumen que el inventario ni siquiera lista (sin ningún inventario
# autónomo, los del compose autónomo no aparecen en ninguno).
cobertura "$RAIZ" "$COBERTURA_NUEVO" >"$TMP/cobertura-sin-autonoma.txt"
comprobar "sin probar un modo, sus volúmenes no aparecen" contiene "$TMP/cobertura-sin-autonoma.txt" \
  "El volumen «mailway-panel-data» de deploy/docker-compose.standalone.yml no aparece en el inventario de deploy/copias.sh"

echo "# Ningún doble ha recibido una llamada que no esperaba"
comprobar "ninguna llamada sin simular" igual "$(cat "$IMPREVISTOS")" ""

echo
TERMINADA=1
if [ "$FALLOS" -gt 0 ]; then
  echo "$FALLOS comprobaciones han fallado."
  exit 1
fi
echo "Todas las comprobaciones son correctas."
