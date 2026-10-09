#!/usr/bin/env bash
#
# Pruebas del motor de correo en deploy/instalar.sh (Stalwart 0.15 y 0.16) con
# docker, Compose, el motor y la herramienta del motor del panel simulados:
# sin contenedores, sin red y sin root. Carga las funciones del instalador
# (todo menos la llamada final a main) y comprueba:
#   - la elección del motor: lo que diga deploy/.env, si no los datos que ya
#     hay y, en una instalación nueva, la 0.16; una actualización nunca cambia
#     de motor;
#   - el aviso del fin de soporte de la 0.15, antes y después de la fecha;
#   - el primer arranque de la 0.16 (Bootstrap por JMAP sin mostrar la
#     contraseña que devuelve, reinicio y retirada de la cuenta admin@) y que
#     una actualización no lo repite;
#   - «provisionar» del panel: reinicio del motor y repetición si lo pide, y
#     sin interrumpir la instalación si falla;
#   - el diagnóstico de la 0.16 (--comprobar), con una sola petición;
#   - la migración (--migrar-motor) con su orden de pasos y la vuelta atrás
#     automática según dónde falle: deploy/.env como estaba, la 0.15 sobre su
#     volumen y el panel fuera de mantenimiento; nunca se borra un volumen y
#     la contraseña del motor nunca va en los argumentos de un proceso;
#   - --revertir-motor y --retirar-motor-anterior, también cuando se niegan;
#   - Bulwark: --activar-bulwark se niega con la 0.15; con la 0.16, sus dos
#     secretos se generan una vez y nunca se muestran, Compose recibe el
#     perfil «bulwark» solo si está activo, desactivarlo conserva secretos y
#     volúmenes, y volver a la 0.15 lo desactiva.
# La migración de verdad, con contenedores reales, la prueba
# «deploy/prueba-stack.py --migracion» (CI: .github/workflows/stack.yml).
#
#   bash deploy/prueba-motor016.sh     # código 1 si alguna comprobación falla
#
# Necesita jq. Las variables que fija la prueba las leen las funciones del
# instalador, que el análisis estático no ve (se cargan de una copia): de ahí
# SC2034. Los dobles de funciones del instalador solo los invocan esas
# funciones: SC2329 (SC2317 en las versiones de shellcheck anteriores a la
# 0.11). Cada escenario corre en un subshell con «set -e», como el instalador,
# para que sus cambios no lleguen a los siguientes: SC2030 y SC2031.
# shellcheck disable=SC2034,SC2329,SC2317,SC2030,SC2031

set -uo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v jq >/dev/null 2>&1 || { echo "Falta jq." >&2; exit 1; }
if [ "$(tail -n 1 "$AQUI/instalar.sh")" != "main" ]; then
  echo "La última línea de instalar.sh ya no es «main»: actualiza esta prueba." >&2
  exit 1
fi

TMP=$(mktemp -d)
mkdir -p "$TMP/deploy/roundcube" "$TMP/bin" "$TMP/estado"
sed '$d' "$AQUI/instalar.sh" >"$TMP/deploy/instalar.sh"
# Los compose de verdad: de ellos salen las imágenes (Dependabot).
cp "$AQUI"/docker-compose.mail.yml "$AQUI"/docker-compose.standalone.yml "$TMP/deploy/"
mkdir -p "$TMP/deploy/motor/stalwart-0.15" "$TMP/deploy/motor/stalwart-0.16"
cp "$AQUI/motor/stalwart-0.15/compose.yml" "$TMP/deploy/motor/stalwart-0.15/"
cp "$AQUI/motor/stalwart-0.16/compose.yml" "$TMP/deploy/motor/stalwart-0.16/"
REGISTRO="$TMP/registro"
SALIDA="$TMP/salida"
E="$TMP/estado"
# Llamadas que ningún doble esperaba: al final, debe estar vacío.
IMPREVISTOS="$TMP/imprevistos"
: >"$REGISTRO"
: >"$IMPREVISTOS"
CLAVE_MOTOR='Clave-del-motor-0123456789abcdef'
export PRUEBA_REGISTRO=$REGISTRO PRUEBA_IMPREVISTOS=$IMPREVISTOS PRUEBA_ESTADO=$E

# ------------------------------------------------------------------ docker --
#
# docker (también por «timeout» y por «env» en compose()) simulado con su
# estado en ficheros de $E: imagen del motor, contenedores en marcha,
# volúmenes, respuestas del panel (panel/<orden>[.<n>]: la línea JSON; el
# código, 0 si lleva "ok":true), del ayudante (ayudante/<orden>), de la API
# JMAP (jmap/<Objeto>-<método>: código HTTP y cuerpo) y de la REST de la 0.15
# (rest/cola). Anota cada llamada en el registro; lo que se le pasa por la
# entrada estándar a curl, en curl.log. Con un patrón de $E/fallar que
# coincida, la llamada falla.
cat >"$TMP/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
E=$PRUEBA_ESTADO
linea="$*"
if [ "${1:-}" = compose ]; then linea="compose[${MAILWAY_MOTOR:-}] ${*:2}"; fi
printf 'docker %s\n' "$linea" >>"$PRUEBA_REGISTRO"
if [ -f "$E/fallar" ]; then
  while IFS= read -r patron; do
    # shellcheck disable=SC2053
    if [ -n "$patron" ] && [[ $linea == $patron ]]; then
      echo "FALLA: $linea" >>"$PRUEBA_REGISTRO"
      echo "fallo simulado" >&2
      exit 1
    fi
  done <"$E/fallar"
fi
marcha() { grep -qx -- "$1" "$E/en_marcha" 2>/dev/null; }
poner() { marcha "$1" || echo "$1" >>"$E/en_marcha"; }
quitar() { if [ -f "$E/en_marcha" ]; then grep -vx -- "$1" "$E/en_marcha" >"$E/en_marcha.n" || true; mv "$E/en_marcha.n" "$E/en_marcha"; fi; }
responder() { # <fichero sin número> <orden>: la respuesta n-ésima, o la general
  local n
  n=$(grep -cx -- "$2" "$E/llamadas" 2>/dev/null) || true
  echo "$2" >>"$E/llamadas"
  n=$((${n:-0} + 1))
  if [ -f "$1.$n" ]; then cat "$1.$n"; elif [ -f "$1" ]; then cat "$1"; else return 1; fi
}
case "$linea" in
  info | "compose version") exit 0 ;;
  "inspect --type container -f {{.Config.Image}} mailway-mail")
    [ -s "$E/imagen" ] || exit 1
    cat "$E/imagen"
    ;;
  "inspect --type container mailway-panel" | "inspect --type container mailway-proxy") exit 1 ;;
  "inspect --type container mailway-bulwark" | "inspect --type container mailway-bulwark-gw") marcha "${linea##* }" ;;
  # Bulwark: ¿hay ajustes de usuarios en su volumen? ¿Y un admin.json? (que se retira)
  "run --rm --network none -v mailway-bulwark-ajustes:/v:ro "*) [ ! -f "$E/bulwark-ajustes" ] || echo /v/ajuste ;;
  "run --rm --network none -v mailway-bulwark-admin:/a "*)
    if [ -f "$E/bulwark-admin-json" ]; then rm -f "$E/bulwark-admin-json" && echo retirado; fi
    ;;
  "inspect --type container -f {{.State.Running}} "*)
    if marcha "${linea##* }"; then echo true; else echo false; fi
    ;;
  "inspect -f {{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}} "*)
    if marcha "${linea##* }"; then echo healthy; elif grep -qx -- "${linea##* }" "$E/parados" 2>/dev/null; then echo exited; else exit 1; fi
    ;;
  "image inspect "* | "pull -q "*) exit 0 ;;
  "exec "*" test -f server/dist/tools/motor.js") [ -f "$E/herramienta" ] ;;
  "exec mailway-mail test -f /etc/stalwart/config.json") [ -f "$E/config016" ] ;;
  "exec "*" bash -c exec 3<>/dev/tcp/127.0.0.1/"*)
    # Un puerto abierto si el contenedor está en marcha; $E/cerrado
    # lo deja cerrado hasta el siguiente «docker restart».
    c=${linea#exec }
    marcha "${c%% *}" && [ ! -f "$E/cerrado" ]
    ;;
  "exec "*" curl -fsS -o /dev/null --max-time 5 -H X-Forwarded-For: 127.0.0.1 http://127.0.0.1:8080/healthz/"*)
    c=${linea#exec }
    marcha "${c%% *}"
    ;;
  "exec -i -u node "*" node server/dist/tools/motor.js "*)
    orden=${linea#*motor.js }
    orden=${orden%% *}
    [ "$orden" != mantenimiento ] || orden="mantenimiento-${linea##* mantenimiento }"
    orden=${orden%% --*}
    orden=${orden// /-}
    respuesta=$(responder "$E/panel/$orden" "panel $orden") || { echo "panel sin respuesta: $orden" >>"$PRUEBA_IMPREVISTOS"; exit 1; }
    if [ -f "$E/panel/$orden.err" ]; then cat "$E/panel/$orden.err" >&2; fi
    printf '%s\n' "$respuesta"
    [[ $respuesta == *'"ok":true'* ]]
    ;;
  "exec mailway-certs-dumper python /app/extractor.py estado") exit 0 ;;
  "run -i --rm --network mailway-internal curlimages/curl:"*)
    entrada=$(cat)
    printf '%s\n' "$entrada" >>"$E/curl.log"
    case "$linea" in
      *"/api/queue/messages"*) cat "$E/rest/cola" 2>/dev/null || echo '{"data":{"total":0,"items":[]}}' ;;
      *"/jmap")
        metodo=$(printf '%s' "$entrada" | sed -n 's/^data = .*\[\[\\"x:\([A-Za-z]*\)\/\([a-z]*\)\\".*/\1-\2/p' | head -n 1)
        respuesta=$(responder "$E/jmap/$metodo" "jmap $metodo") || respuesta=$'500\n'
        printf '%s\n%s' "$(printf '%s\n' "$respuesta" | sed '1d')" "$(printf '%s\n' "$respuesta" | sed -n 1p)"
        ;;
      *) echo "curl no simulado: $linea" >>"$PRUEBA_IMPREVISTOS"; exit 1 ;;
    esac
    ;;
  "run --rm -i --network mailway-internal --read-only "*"migracion.py "*)
    cat >/dev/null
    orden=${linea#*migracion.py }
    orden=${orden%% *}
    # Lo que deja el ayudante de verdad en la carpeta de trabajo (con secretos).
    trabajo=${linea#* -v }
    trabajo=${trabajo%%:/trabajo *}
    case "$orden" in
      volcar) touch "$trabajo/settings.json" "$trabajo/principals.json" "$trabajo/resumen-015.json" ;;
      convertir) touch "$trabajo/export.json" ;;
    esac
    respuesta=$(responder "$E/ayudante/$orden" "ayudante $orden") || { echo "ayudante sin respuesta: $orden" >>"$PRUEBA_IMPREVISTOS"; exit 1; }
    printf '%s\n' "$respuesta"
    [[ $respuesta == *'"ok":true'* ]]
    ;;
  "run --rm --network none -v "*" sh -c du -sk /v/data"*) printf '1024\n10485760\n' ;;
  "run --rm --network none -v "*"du -sh /v") printf '1.0M\t/v\n' ;;
  "run --rm --network none -v "*" sh -euc "*) echo "origen 12 4096 copia 12 4096" ;;
  "run --rm -i --network mailway-internal -e STALWART_URL=http://mailway-mail:8080 -e STALWART_USER=admin -e STALWART_PASSWORD stalwartlabs/cli:"*)
    cat >/dev/null
    echo "Applied 25 operations (0 failed)"
    ;;
  "run -d --name "*)
    c=${linea#run -d --name }
    poner "${c%% *}"
    ;;
  "network connect --alias mailway-mail "*) exit 0 ;;
  "logs --tail "*) echo "registro del motor" ;;
  "stop "*)
    for c in $linea; do case "$c" in stop | -t | [0-9]*) ;; *) quitar "$c"; echo "$c" >>"$E/parados" ;; esac; done
    ;;
  "restart "*) rm -f "$E/cerrado" ;;
  "rm -f "*)
    for c in ${linea#rm -f }; do quitar "$c"; done
    ;;
  "volume inspect "*) grep -qx -- "${linea##* }" "$E/volumenes" 2>/dev/null ;;
  "volume create "*) echo "${linea##* }" >>"$E/volumenes" ;;
  "volume rm "*)
    grep -vx -- "${linea##* }" "$E/volumenes" >"$E/volumenes.n" || true
    mv "$E/volumenes.n" "$E/volumenes"
    ;;
  "volume ls -q --filter label=com.docker.compose.project=mailway") cat "$E/volumenes" 2>/dev/null ;;
  "ps -a --filter volume="*) cat "$E/usado" 2>/dev/null || true ;;
  compose\[*) # Compose: el estado de los contenedores según el motor.
    motor=${linea#compose[}
    motor=${motor%%]*}
    case "$linea" in
      *" config -q") exit 0 ;;
      *" up -d mailway-mail" | *" up -d --remove-orphans mailway-mail")
        if [ "$motor" = stalwart-0.16 ]; then echo stalwartlabs/stalwart:v0.16.25 >"$E/imagen"; else echo stalwartlabs/stalwart:v0.15.5 >"$E/imagen"; fi
        poner mailway-mail
        ;;
      *" up -d --remove-orphans")
        poner mailway-webmail
        poner mailway-mail-gw
        case "$linea" in *"--profile bulwark"*) poner mailway-bulwark && poner mailway-bulwark-gw ;; esac
        ;;
      *"--profile tls up -d"*certs-dumper) poner mailway-certs-dumper ;;
      *"--profile bulwark rm -s -f mailway-bulwark mailway-bulwark-gw") quitar mailway-bulwark && quitar mailway-bulwark-gw ;;
      *) exit 0 ;;
    esac
    ;;
  *)
    echo "docker no simulado: $linea" >>"$PRUEBA_IMPREVISTOS"
    exit 1
    ;;
esac
DOCKER
chmod +x "$TMP/bin/docker"
PATH="$TMP/bin:$PATH"

# shellcheck source=/dev/null
source "$TMP/deploy/instalar.sh" </dev/null
set +e
# Un «fallo» del instalador fuera de un subshell terminaría la prueba a medias:
# que no pase inadvertido. Se escribe en el descriptor 3 (la salida original).
TERMINADA=0
exec 3>&1
trap 'rm -rf "$TMP"; [ "$TERMINADA" = 1 ] || echo "FALLO - la prueba terminó antes de tiempo" >&3' EXIT
INTERACTIVO=0

FALLOS=0
comprobar() {
  local descripcion=$1
  shift
  if "$@"; then
    printf 'ok - %s\n' "$descripcion"
  else
    printf 'FALLO - %s\n' "$descripcion"
    FALLOS=$((FALLOS + 1))
    # PRUEBA_DEPURAR=1: la salida del escenario, para ver por qué.
    if [ "${PRUEBA_DEPURAR:-0}" = 1 ]; then sed 's/^/   | /' "$SALIDA" | tail -n 25; fi
  fi
}
contiene() { grep -Fq -- "$2" "$1"; }
no_contiene() { ! grep -Fq -- "$2" "$1"; }
igual() { [ "$1" = "$2" ]; }
existe() { [ -e "$1" ]; }
no_existe() { [ ! -e "$1" ]; }
# ¿Hay una línea con $3 después de la primera con $2?
despues_de() {
  local a b
  a=$(grep -nF -- "$2" "$1" | head -n 1 | cut -d: -f1)
  b=$(grep -nF -- "$3" "$1" | tail -n 1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}
sleep() { :; }

# deploy/.env de una instalación junto a Skyway (la contraseña del motor, entre otras cosas).
ENV_FILE="$TMP/deploy/.env"
escribir_env_prueba() {
  {
    echo "MAILWAY_INSTALACION='skyway'"
    echo "MAIL_HOSTNAME='mail.ejemplo.test'"
    echo "STALWART_ADMIN_PASSWORD='$CLAVE_MOTOR'"
    echo "MAILWAY_PANEL_INTERNAL_URL='http://skyway-mailway-panel:4100'"
    echo "TRAEFIK_ACME_VOLUME='skyway_traefik-letsencrypt'"
    for linea in "$@"; do echo "$linea"; done
  } >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
}
# Estado de docker de partida: $1 imagen del motor (vacía: sin contenedor),
# y los volúmenes que haya.
reiniciar_estado() {
  rm -rf "$E"
  mkdir -p "$E/panel" "$E/ayudante" "$E/jmap" "$E/rest"
  : >"$REGISTRO"
  printf '%s' "${1:-}" >"$E/imagen"
  shift
  : >"$E/volumenes"
  for v in "$@"; do echo "$v" >>"$E/volumenes"; done
  : >"$E/en_marcha"
}
marcha() { printf '%s\n' "$@" >>"$E/en_marcha"; }
volumen() { grep -qx -- "$1" "$E/volumenes"; }
sin_volumen() { ! volumen "$1"; }
valor_env() { leer_env "$1"; }
# Ejecuta $@ como el instalador (subshell con set -e y la salida de
# al_salir); deja la salida en $SALIDA y el código en CODIGO.
ejecutar() {
  (
    set -e
    trap al_salir EXIT
    "$@"
  ) >"$SALIDA" 2>&1
  CODIGO=$?
}

MAIL_HOSTNAME=mail.ejemplo.test
INTERNAL_SUBNET=10.203.53.0/24
MAIL_INTERNAL_IP=10.203.53.10
STALWART_ADMIN_PASSWORD=$CLAVE_MOTOR
CON_SKYWAY=1
USAR_PROXY_PROPIO=0
TRAEFIK_ACME_VOLUME=skyway_traefik-letsencrypt
CF_TOKEN=""
# Fecha de hoy para el aviso del fin de soporte (date -u +%F).
HOY=2026-10-09
date() {
  if [ "$*" = "-u +%F" ]; then printf '%s\n' "$HOY"; else command date "$@"; fi
}

# ---------------------------------------------------------- elección del motor --

probar_eleccion() { # <MAILWAY_MOTOR del entorno>
  (
    set -e
    MOTOR=""
    MAILWAY_MOTOR=$1
    elegir_motor
    echo "MOTOR=$MOTOR"
  ) >"$SALIDA" 2>&1
  CODIGO=$?
}

echo "# deploy/.env dice la 0.15: sigue en la 0.15 y avisa del fin de soporte"
reiniciar_estado "stalwartlabs/stalwart:v0.15.5" mailway-mail-data
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.15'"
probar_eleccion ""
comprobar "termina bien" igual "$CODIGO" 0
comprobar "elige la 0.15" contiene "$SALIDA" "MOTOR=stalwart-0.15"
comprobar "avisa de la fecha del fin de soporte" contiene "$SALIDA" "deja de recibir parches de seguridad el 1 de diciembre de 2026"
comprobar "y de cómo migrar" contiene "$SALIDA" "sudo mailway migrar-motor"

echo "# Desde el 1 de diciembre de 2026, el aviso dice que ya no tiene parches"
HOY=2026-12-01
probar_eleccion ""
comprobar "ya no recibe parches" contiene "$SALIDA" "Stalwart 0.15 ya no recibe parches de seguridad (desde el 1 de diciembre de 2026)"
HOY=2026-10-09

echo "# deploy/.env dice la 0.16: la 0.16, sin aviso"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25" mailway-stalwart-data
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.16'"
probar_eleccion ""
comprobar "elige la 0.16" contiene "$SALIDA" "MOTOR=stalwart-0.16"
comprobar "sin aviso del fin de soporte" no_contiene "$SALIDA" "parches de seguridad"

echo "# Instalación anterior a la 0.16 (deploy/.env sin MAILWAY_MOTOR): la 0.15 de su contenedor"
reiniciar_estado "stalwartlabs/stalwart:v0.15.5"
escribir_env_prueba
probar_eleccion ""
comprobar "elige la 0.15" contiene "$SALIDA" "MOTOR=stalwart-0.15"

echo "# Sin contenedor pero con el volumen de la 0.15: la 0.15"
reiniciar_estado "" mailway-mail-data
probar_eleccion ""
comprobar "elige la 0.15" contiene "$SALIDA" "MOTOR=stalwart-0.15"

echo "# Con el volumen de datos de la 0.16: la 0.16"
reiniciar_estado "" mailway-stalwart-data
probar_eleccion ""
comprobar "elige la 0.16" contiene "$SALIDA" "MOTOR=stalwart-0.16"

echo "# Con datos de las dos y deploy/.env sin decir cuál: no adivina"
reiniciar_estado "" mailway-mail-data mailway-stalwart-data
probar_eleccion ""
comprobar "se niega" igual "$CODIGO" 1
comprobar "pide que lo diga deploy/.env" contiene "$SALIDA" "Hay datos de Stalwart 0.15 y de 0.16"

echo "# Instalación nueva: la 0.16"
reiniciar_estado ""
probar_eleccion ""
comprobar "elige la 0.16" contiene "$SALIDA" "MOTOR=stalwart-0.16"

echo "# Instalación nueva con MAILWAY_MOTOR=stalwart-0.15: la 0.15"
probar_eleccion stalwart-0.15
comprobar "elige la 0.15" contiene "$SALIDA" "MOTOR=stalwart-0.15"

echo "# Una actualización nunca cambia de motor: MAILWAY_MOTOR=stalwart-0.16 en una 0.15"
reiniciar_estado "stalwartlabs/stalwart:v0.15.5" mailway-mail-data
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.15'"
probar_eleccion stalwart-0.16
comprobar "se niega" igual "$CODIGO" 1
comprobar "remite a --migrar-motor" contiene "$SALIDA" "deploy/instalar.sh --migrar-motor"

echo "# Valores que no son un motor"
probar_eleccion stalwart-0.17
comprobar "MAILWAY_MOTOR del entorno: se niega" igual "$CODIGO" 1
escribir_env_prueba "MAILWAY_MOTOR='0.16'"
probar_eleccion ""
comprobar "MAILWAY_MOTOR de deploy/.env: se niega" igual "$CODIGO" 1
comprobar "y lo explica" contiene "$SALIDA" "MAILWAY_MOTOR no es válido"

echo "# fijar_en_env cambia, añade y quita claves sin tocar las demás"
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.15'" "OTRA='con espacios y \$dolar'"
(
  set -e
  fijar_en_env MAILWAY_MOTOR stalwart-0.16 NUEVA valor TRAEFIK_ACME_VOLUME ""
) >"$SALIDA" 2>&1
comprobar "cambia la clave" igual "$(valor_env MAILWAY_MOTOR)" stalwart-0.16
comprobar "añade la nueva" igual "$(valor_env NUEVA)" valor
comprobar "quita la vacía" no_contiene "$ENV_FILE" "TRAEFIK_ACME_VOLUME"
comprobar "no toca las demás" contiene "$ENV_FILE" "OTRA='con espacios y \$dolar'"
comprobar "ni la contraseña del motor" igual "$(valor_env STALWART_ADMIN_PASSWORD)" "$CLAVE_MOTOR"
comprobar "permisos 600" igual "$(stat -c %a "$ENV_FILE")" 600
comprobar "sin temporales" igual "$(find "$TMP/deploy" -name '.env.*' | wc -l)" 0

# ------------------------------------------------ primer arranque de la 0.16 --

echo "# Primer arranque de la 0.16: Bootstrap, reinicio y fuera la cuenta admin@"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25"
marcha mailway-mail
printf '200\n%s\n' '{"methodResponses":[["x:Bootstrap/set",{"updated":{"singleton":{"username":"admin@mail.ejemplo.test","secret":"Secreto-del-arranque-XYZ"}}},"b"]]}' >"$E/jmap/Bootstrap-set"
printf '200\n%s\n' '{"methodResponses":[["x:Account/query",{"ids":["a1"]},"q"],["x:Account/get",{"list":[{"id":"a1","emailAddress":"admin@mail.ejemplo.test","roles":{"@type":"Admin"}}]},"g"]]}' >"$E/jmap/Account-query"
printf '200\n%s\n' '{"methodResponses":[["x:Account/set",{"destroyed":["a1"]},"d"]]}' >"$E/jmap/Account-set"
ejecutar preparar_motor_016
comprobar "termina bien" igual "$CODIGO" 0
comprobar "Bootstrap con el nombre del servidor" contiene "$E/curl.log" '\"serverHostname\":\"mail.ejemplo.test\"'
comprobar "y como dominio por defecto, ese mismo nombre" contiene "$E/curl.log" '\"defaultDomain\":\"mail.ejemplo.test\"'
comprobar "sin certificado propio del motor" contiene "$E/curl.log" '\"requestTlsCertificate\":false'
comprobar "sin claves DKIM del motor" contiene "$E/curl.log" '\"generateDkimKeys\":false'
comprobar "registro en la salida estándar, sin búfer" contiene "$E/curl.log" '\"tracer\":{\"@type\":\"Stdout\",\"ansi\":false,\"buffered\":false}'
comprobar "reinicia el motor" contiene "$REGISTRO" "docker restart mailway-mail"
comprobar "borra la cuenta admin@ del arranque" contiene "$E/curl.log" '\"x:Account/set\",{\"destroy\":[\"a1\"]}'
comprobar "no muestra la contraseña que devuelve el motor" no_contiene "$SALIDA" "Secreto-del-arranque-XYZ"
comprobar "la contraseña del motor solo va por la entrada estándar de curl" contiene "$E/curl.log" "user = \"admin:$CLAVE_MOTOR\""
comprobar "y nunca en los argumentos" no_contiene "$REGISTRO" "$CLAVE_MOTOR"

echo "# Con más cuentas que la del arranque, no se borra ninguna"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25"
marcha mailway-mail
printf '200\n%s\n' '{"methodResponses":[["x:Bootstrap/set",{"updated":{"singleton":{"username":"admin@mail.ejemplo.test","secret":"x"}}},"b"]]}' >"$E/jmap/Bootstrap-set"
printf '200\n%s\n' '{"methodResponses":[["x:Account/query",{"ids":["a1","a2"]},"q"],["x:Account/get",{"list":[{"id":"a1","emailAddress":"admin@mail.ejemplo.test","roles":{"@type":"Admin"}},{"id":"a2","emailAddress":"ana@ejemplo.test","roles":{"@type":"User"}}]},"g"]]}' >"$E/jmap/Account-query"
ejecutar preparar_motor_016
comprobar "termina bien" igual "$CODIGO" 0
comprobar "no borra nada" no_contiene "$E/curl.log" "destroy"

echo "# Con config.json (una actualización): ni Bootstrap ni reinicio"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25"
marcha mailway-mail
touch "$E/config016"
ejecutar preparar_motor_016
comprobar "termina bien" igual "$CODIGO" 0
comprobar "no llama a Bootstrap" no_existe "$E/curl.log"
comprobar "no reinicia el motor" no_contiene "$REGISTRO" "docker restart"

echo "# El motor rechaza la contraseña en su primer arranque"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25"
marcha mailway-mail
printf '401\n\n' >"$E/jmap/Bootstrap-set"
ejecutar preparar_motor_016
comprobar "falla" igual "$CODIGO" 1
comprobar "lo explica" contiene "$SALIDA" "El motor rechaza la contraseña"
comprobar "sin reiniciar el motor" no_contiene "$REGISTRO" "docker restart"

# ---------------------------------------------------- herramienta del panel --

PROVISION_OK='{"ok":true,"api":"jmap016","aplicados":["ajustes"],"avisos":[],"restartRequired":[],"errores":[],"suspensiones":{"reaplicadas":2,"fallidas":[]},"faltan":{"dominios":[],"buzones":[],"alias":[]}}'
PROVISION_REINICIO='{"ok":true,"api":"jmap016","aplicados":["la escucha del 587"],"avisos":[],"restartRequired":["Puerto 587 (envío con STARTTLS): se abre al reiniciar el contenedor del motor"],"errores":[],"suspensiones":{"reaplicadas":2,"fallidas":[]},"faltan":{"dominios":[],"buzones":[],"alias":[]}}'

echo "# provisionar pide reiniciar: se reinicia el motor y se repite"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25"
marcha mailway-mail skyway-mailway-panel
touch "$E/herramienta"
printf '%s\n' "$PROVISION_REINICIO" >"$E/panel/provisionar.1"
printf '%s\n' "$PROVISION_OK" >"$E/panel/provisionar.2"
ejecutar provisionar_motor skyway-mailway-panel mailway-mail
comprobar "termina bien" igual "$CODIGO" 0
comprobar "reinicia el motor entre las dos" despues_de "$REGISTRO" "docker restart mailway-mail" "motor.js provisionar"
comprobar "dos veces provisionar" igual "$(grep -c 'motor.js provisionar' "$REGISTRO")" 2
comprobar "da los ajustes por aplicados" contiene "$SALIDA" "Ajustes de Mailway aplicados en el motor (suspensiones reaplicadas: 2)"

echo "# Sigue pidiendo un reinicio después de reiniciarlo: no lo da por bueno"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25"
marcha mailway-mail skyway-mailway-panel
printf '%s\n' "$PROVISION_REINICIO" >"$E/panel/provisionar"
ejecutar provisionar_motor skyway-mailway-panel mailway-mail
comprobar "falla" igual "$CODIGO" 1
comprobar "lo explica" contiene "$SALIDA" "El motor sigue pidiendo un reinicio después de reiniciarlo"
comprobar "un solo reinicio" igual "$(grep -c 'docker restart' "$REGISTRO")" 1

echo "# provisionar ya no pide reinicio pero el 587 sigue cerrado (una ejecución cortada): se reinicia"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25"
marcha mailway-mail skyway-mailway-panel
touch "$E/cerrado"
printf '%s\n' "$PROVISION_OK" >"$E/panel/provisionar"
ejecutar provisionar_motor skyway-mailway-panel mailway-mail
comprobar "termina bien" igual "$CODIGO" 0
comprobar "reinicia el motor" igual "$(grep -c 'docker restart mailway-mail' "$REGISTRO")" 1
comprobar "y repite provisionar" igual "$(grep -c 'motor.js provisionar' "$REGISTRO")" 2

echo "# provisionar falla: errores, lo que falta y las suspensiones, explicados"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25"
marcha mailway-mail skyway-mailway-panel
printf '%s\n' '{"ok":false,"error":"No se han podido aplicar los ajustes","api":"jmap016","aplicados":[],"avisos":[],"restartRequired":[],"errores":["El motor no responde"],"suspensiones":{"reaplicadas":0,"fallidas":["luis@ejemplo.test"]},"faltan":{"dominios":[],"buzones":["eva@ejemplo.test"],"alias":[]}}' >"$E/panel/provisionar"
ejecutar provisionar_motor skyway-mailway-panel mailway-mail
comprobar "falla" igual "$CODIGO" 1
comprobar "con el error del panel" contiene "$SALIDA" "No se han podido aplicar los ajustes"
comprobar "lo que falta en el motor" contiene "$SALIDA" "Faltan en el motor: buzones: eva@ejemplo.test"
comprobar "y las suspensiones sin reaplicar" contiene "$SALIDA" "Suspensiones sin reaplicar: luis@ejemplo.test."
comprobar "sin reiniciar el motor" no_contiene "$REGISTRO" "docker restart"

echo "# La instalación no se interrumpe por los ajustes: queda dicho en el resumen"
probar_ajustes() {
  (
    set -e
    aplicar_ajustes_mailway skyway-mailway-panel
    echo "RESUMEN_AJUSTES=$RESUMEN_AJUSTES"
  ) >"$SALIDA" 2>&1
  CODIGO=$?
}
reiniciar_estado "stalwartlabs/stalwart:v0.16.25"
marcha mailway-mail
probar_ajustes
comprobar "sin panel en marcha: termina bien" igual "$CODIGO" 0
comprobar "y quedan pendientes" contiene "$SALIDA" "RESUMEN_AJUSTES=pendientes: el panel no está en marcha"
marcha skyway-mailway-panel
probar_ajustes
comprobar "panel sin la herramienta: termina bien" igual "$CODIGO" 0
comprobar "y quedan pendientes" contiene "$SALIDA" "RESUMEN_AJUSTES=pendientes: el panel desplegado no tiene la herramienta del motor"
touch "$E/herramienta"
printf '%s\n' '{"ok":false,"error":"Falta el nombre del servidor de correo"}' >"$E/panel/provisionar"
probar_ajustes
comprobar "provisionar falla: termina bien" igual "$CODIGO" 0
comprobar "y el resumen dice que están incompletos" contiene "$SALIDA" "RESUMEN_AJUSTES=INCOMPLETOS"
printf '%s\n' "$PROVISION_OK" >"$E/panel/provisionar"
probar_ajustes
comprobar "provisionar bien: aplicados" contiene "$SALIDA" "RESUMEN_AJUSTES=aplicados por el panel"

# -------------------------------------------------------- diagnóstico 0.16 --

# Respuesta de la petición de comprobar_motor_016, con $1 como escuchas, $2
# como redes exentas, $3 como X-Forwarded-For y $4 como nombres del certificado.
respuesta_ajustes() {
  printf '200\n{"methodResponses":[["x:SystemSettings/get",{"list":[{"defaultHostname":"%s","defaultCertificateId":"c1"}]},"s"],["x:Http/get",{"list":[{"useXForwarded":%s}]},"h"],["x:AllowedIp/query",{"ids":["i1"]},"aq"],["x:AllowedIp/get",{"list":[{"id":"i1","address":"%s"}]},"a"],["x:NetworkListener/query",{"ids":[]},"lq"],["x:NetworkListener/get",{"list":%s},"l"],["x:Certificate/query",{"ids":["c1"]},"cq"],["x:Certificate/get",{"list":[{"id":"c1","subjectAlternativeNames":%s,"notValidAfter":"2027-01-02T00:00:00Z"}]},"c"]]}\n' \
    "${5:-mail.ejemplo.test}" "$3" "$2" "$1" "$4" >"$E/jmap/SystemSettings-get"
}
ESCUCHAS_BIEN='[{"protocol":"smtp","bind":{"[::]:25":true},"tlsImplicit":false},{"protocol":"smtp","bind":{"[::]:465":true},"tlsImplicit":true},{"protocol":"smtp","bind":{"[::]:587":true},"tlsImplicit":false}]'
ESCUCHAS_SIN_587='[{"protocol":"smtp","bind":{"[::]:25":true},"tlsImplicit":false},{"protocol":"smtp","bind":{"[::]:465":true},"tlsImplicit":true}]'
probar_diagnostico() {
  (
    set -e
    comprobar_motor_016
  ) >"$SALIDA" 2>&1
  CODIGO=$?
}

echo "# Diagnóstico de la 0.16 con todo aplicado: una sola petición y sin incidencias"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25"
marcha mailway-mail
respuesta_ajustes "$ESCUCHAS_BIEN" "10.203.53.0/24" true '{"*.ejemplo.test":true}'
probar_diagnostico
comprobar "sin incidencias" igual "$CODIGO" 0
comprobar "una sola petición al motor" igual "$(grep -c '^jmap ' "$E/llamadas")" 1
comprobar "el comodín cubre el nombre del servidor" contiene "$SALIDA" "Certificado: el de Traefik, que mantiene el extractor (perfil tls); para mail.ejemplo.test"
comprobar "dice que hay 587 con STARTTLS" contiene "$SALIDA" "Envío por 587 con STARTTLS disponible."

echo "# Sin el 587, sin la red interna, sin X-Forwarded-For y con otro nombre: cuatro incidencias"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25"
respuesta_ajustes "$ESCUCHAS_SIN_587" "10.9.9.0/24" false '{"mail.ejemplo.test":true}' "otro.ejemplo.test"
probar_diagnostico
comprobar "cuatro incidencias" igual "$CODIGO" 4
comprobar "la del 587" contiene "$SALIDA" "El motor no escucha en 587 (STARTTLS)"
comprobar "la de la red interna" contiene "$SALIDA" "Falta la exención de 10.203.53.0/24"
comprobar "la de X-Forwarded-For" contiene "$SALIDA" "El motor no usa X-Forwarded-For"
comprobar "la del nombre" contiene "$SALIDA" "se identifica como «otro.ejemplo.test»"

echo "# El 587 en los ajustes pero sin abrir: incidencia y cómo arreglarlo"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25"
marcha mailway-mail
touch "$E/cerrado"
respuesta_ajustes "$ESCUCHAS_BIEN" "10.203.53.0/24" true '{"mail.ejemplo.test":true}'
probar_diagnostico
comprobar "una incidencia" igual "$CODIGO" 1
comprobar "dice que hay que reiniciarlo" contiene "$SALIDA" "no escucha hasta reiniciarlo: docker restart mailway-mail"

echo "# Contraseña rechazada: una incidencia y no se reintenta"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25"
printf '401\n\n' >"$E/jmap/SystemSettings-get"
probar_diagnostico
comprobar "una incidencia" igual "$CODIGO" 1
comprobar "lo explica como espera mailway.sh" contiene "$SALIDA" "rechaza la contraseña"
comprobar "una sola petición" igual "$(grep -c '^jmap ' "$E/llamadas")" 1

# ---------------------------------------------------------------- migración --

MIGRACIONES="$TMP/migracion"
MAILWAY_MIGRACION_DIR=$MIGRACIONES
SIN_CONFIRMAR=1
# Sin descargas: los ficheros del script oficial y sus ruedas, vacíos.
descargar_verificado() { printf 'descarga %s\n' "$1" >>"$REGISTRO"; : >"$3"; }
# El registro de cada orden, sin «tee» (con él, la salida de la prueba
# llegaría a destiempo): la carpeta de trabajo con su sello, como el de verdad.
N_SELLO=0
preparar_registro_motor() {
  N_SELLO=$((N_SELLO + 1))
  MIG_SELLO=$(printf '20261009-1200%02d' "$N_SELLO")
  MIG_DIR="$MIGRACIONES/$1-$MIG_SELLO"
  mkdir -p "$MIG_DIR"
  chmod 700 "$MIG_DIR"
  MIG_REGISTRO="$MIG_DIR/registro.log"
  : >"$MIG_REGISTRO"
}
# La comprobación final (la de --comprobar) y la espera del extractor tienen
# sus propias pruebas: aquí, lo que diga FAKE_COMPROBAR.
FAKE_COMPROBAR=0
comprobar_instalacion() {
  echo "comprobar_instalacion TOLERAR_CERTIFICADO=$TOLERAR_CERTIFICADO" >>"$REGISTRO"
  return "$FAKE_COMPROBAR"
}
esperar_extractor() { return 0; }

# Un servidor con la 0.15 junto a Skyway, sano, con su panel y el extractor.
preparar_migracion() {
  reiniciar_estado "stalwartlabs/stalwart:v0.15.5" mailway-mail-data mailway-mail-certs skyway_traefik-letsencrypt
  marcha mailway-mail mailway-webmail mailway-certs-dumper skyway-mailway-panel
  touch "$E/herramienta"
  escribir_env_prueba
  cp -p "$ENV_FILE" "$TMP/env-original"
  rm -rf "$MIGRACIONES"
  FAKE_COMPROBAR=0
  printf '%s\n' '{"ok":true,"api":"rest015","mantenimiento":{"activo":false,"hasta":null},"buzones":{"total":3,"conHash":1,"sinHash":2},"contrasenasAplicacion":{"porApi":{},"invalidadas":0}}' >"$E/panel/estado"
  printf '%s\n' '{"ok":true,"activo":true,"hasta":1760000000000}' >"$E/panel/mantenimiento-on"
  printf '%s\n' '{"ok":true,"activo":false,"hasta":null}' >"$E/panel/mantenimiento-off"
  printf '%s\n' '{"ok":true,"capturados":2,"yaEstaban":1,"fallidos":[]}' >"$E/panel/capturar"
  printf '%s\n' "$PROVISION_OK" >"$E/panel/provisionar"
  printf '%s\n' '{"ok":true,"api":"jmap016","credencialesInternas":{"renovadas":2,"fallidas":[]},"contrasenasInvalidadas":3,"avisados":2,"avisosFallidos":[],"sinCopia":0}' >"$E/panel/tras-migrar"
  printf '%s\n' '{"ok":true,"puertos":{"993":{"ok":true},"465":{"ok":true},"587":{"ok":true}}}' >"$E/ayudante/tls"
  printf '%s\n' '{"ok":true,"dominios":2,"buzones":3,"suspendidos":1,"alias":1,"dkim":4}' >"$E/ayudante/volcar"
  printf '%s\n' '{"ok":true,"operaciones":25,"crear":{"Domain":3,"Account":3}}' >"$E/ayudante/convertir"
  printf '%s\n' '{"ok":true,"registroCreado":true}' >"$E/ayudante/recuperacion"
  printf '%s\n' '{"ok":true,"problemas":[],"avisos":[],"recuento":{"dominios":3,"buzones":3,"alias":1,"dkim":4}}' >"$E/ayudante/comprobar"
}
migrar() { ejecutar migrar_motor; }
# ¿Están todas las líneas de $2… en $1 en ese orden?
en_orden() {
  local fichero=$1 desde=0 n
  shift
  for patron in "$@"; do
    n=$(grep -nF -- "$patron" "$fichero" | awk -F: -v d="$desde" '$1 > d {print $1; exit}')
    [ -n "$n" ] || { echo "   (no está, o no en su orden: $patron)"; return 1; }
    desde=$n
  done
}
# Primera línea con $2 posterior a la última con $3.
primera_tras_ultima() {
  local a b
  a=$(grep -nF -- "$3" "$1" | tail -n 1 | cut -d: -f1)
  b=$(grep -nF -- "$2" "$1" | head -n 1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ "$b" -gt "$a" ]
}
env_intacto() { cmp -s "$ENV_FILE" "$TMP/env-original"; }
sin_borrar_volumenes() { no_contiene "$REGISTRO" "docker volume rm"; }

echo "# Migración completa: pasos en orden, la 0.16 con sus volúmenes y la 0.15 intacta"
preparar_migracion
migrar
comprobar "termina bien" igual "$CODIGO" 0
comprobar "pasos en orden" en_orden "$REGISTRO" \
  "/api/queue/messages" "motor.js estado" "migracion.py tls" "motor.js mantenimiento on --minutos 120" \
  "motor.js capturar" "migracion.py volcar" "migracion.py convertir" "docker stop -t 30 mailway-webmail" \
  "docker stop -t 30 mailway-certs-dumper" "docker stop -t 120 mailway-mail" \
  "docker volume create --label com.docker.compose.project=mailway --label com.docker.compose.volume=mailway-stalwart-etc mailway-stalwart-etc-20261009-120001" \
  "docker volume create --label com.docker.compose.project=mailway --label com.docker.compose.volume=mailway-stalwart-data mailway-stalwart-data-20261009-120001" \
  "-v mailway-mail-data:/origen:ro" "docker run -d --name mailway-mail-016-recuperacion" "stalwartlabs/cli:1.0.13 apply --stdin" \
  "migracion.py recuperacion" "docker rm -f mailway-mail-016-recuperacion" "docker run -d --name mailway-mail-016-previo" \
  "motor.js provisionar" "--profile tls up -d --no-deps --force-recreate certs-dumper" "migracion.py tls" \
  "migracion.py comprobar" "docker rm -f mailway-mail-016-previo" "docker compose[stalwart-0.16] --env-file" \
  "motor.js provisionar" "comprobar_instalacion" "motor.js tras-migrar" "motor.js mantenimiento off"
comprobar "el motor de recuperación arranca en modo recuperación" contiene "$REGISTRO" "-e STALWART_RECOVERY_ADMIN -e STALWART_RECOVERY_MODE=1"
comprobar "el ayudante corre con el usuario de la orden (dueño de la carpeta de trabajo)" \
  contiene "$REGISTRO" "--security-opt no-new-privileges --user $(id -u):$(id -g) "
comprobar "los temporales, en la IP y con el alias del motor, sin publicar puertos" \
  contiene "$REGISTRO" "--network mailway-internal --ip 10.203.53.10 --network-alias mailway-mail --label mailway.migracion=recuperacion stalwartlabs/stalwart:v0.16.25"
comprobar "y en la red de Traefik con el mismo alias" contiene "$REGISTRO" "docker network connect --alias mailway-mail skyway-edge mailway-mail-016-previo"
comprobar "ningún temporal publica puertos" no_contiene <(grep 'docker run -d --name mailway-mail-016' "$REGISTRO") " -p "
comprobar "el panel no toca el motor en modo recuperación" primera_tras_ultima "$REGISTRO" "motor.js provisionar" "mailway-mail-016-recuperacion"
comprobar "deploy/.env dice la 0.16" igual "$(valor_env MAILWAY_MOTOR)" stalwart-0.16
comprobar "con sus volúmenes con fecha" igual "$(valor_env MAILWAY_STALWART_DATA_VOLUME)" mailway-stalwart-data-20261009-120001
comprobar "y la fecha de la migración" coincide "$(valor_env MAILWAY_MOTOR_MIGRADO)" '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$'
comprobar "deploy/.env conserva lo demás" igual "$(valor_env STALWART_ADMIN_PASSWORD)" "$CLAVE_MOTOR"
comprobar "el volumen de la 0.15 sigue ahí" volumen mailway-mail-data
comprobar "no se borra ningún volumen" sin_borrar_volumenes
comprobar "la contraseña del motor nunca va en los argumentos" no_contiene "$REGISTRO" "$CLAVE_MOTOR"
comprobar "el motor queda con la 0.16" igual "$(cat "$E/imagen")" "stalwartlabs/stalwart:v0.16.25"
comprobar "la carpeta de trabajo queda sin el volcado ni el plan" igual "$(find "$MIGRACIONES" -name '*.json' ! -name 'resumen-015.json' | wc -l)" 0
comprobar "ni la copia de deploy/.env" igual "$(find "$MIGRACIONES" -name 'env-antes' | wc -l)" 0
comprobar "la comprobación final no tolera un certificado malo" contiene "$REGISTRO" "comprobar_instalacion TOLERAR_CERTIFICADO=0"
comprobar "prolonga el mantenimiento en cada paso largo" igual "$(grep -c 'motor.js mantenimiento on' "$REGISTRO")" 4
comprobar "explica las contraseñas de aplicación" contiene "$SALIDA" "contraseñas de aplicación invalidadas: 3"
comprobar "y cómo retirar la 0.15 después" contiene "$SALIDA" "sudo mailway retirar-motor-anterior"

echo "# Ya en la 0.16: no hay nada que migrar"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25" mailway-stalwart-data
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.16'"
migrar
comprobar "se niega" igual "$CODIGO" 1
comprobar "lo explica" contiene "$SALIDA" "Este servidor ya usa Stalwart 0.16"
comprobar "sin tocar nada" no_contiene "$REGISTRO" "docker stop"

echo "# Sin terminal y sin -y: no migra"
preparar_migracion
SIN_CONFIRMAR=0
migrar
SIN_CONFIRMAR=1
comprobar "se niega" igual "$CODIGO" 1
comprobar "pide -y" contiene "$SALIDA" "añade -y"
comprobar "sin mantenimiento" no_contiene "$REGISTRO" "mantenimiento on"
comprobar "sin parar nada" no_contiene "$REGISTRO" "docker stop"

echo "# Panel sin la herramienta del motor: no empieza"
preparar_migracion
rm -f "$E/herramienta"
migrar
comprobar "se niega" igual "$CODIGO" 1
comprobar "pide desplegar antes el panel actual" contiene "$SALIDA" "no tiene la herramienta del motor"
comprobar "sin parar nada" no_contiene "$REGISTRO" "docker stop"
comprobar "deploy/.env intacto" env_intacto

echo "# Demasiados mensajes en la cola de salida: no empieza"
preparar_migracion
echo '{"data":{"total":51,"items":[]}}' >"$E/rest/cola"
migrar
comprobar "se niega" igual "$CODIGO" 1
comprobar "dice cómo migrar igualmente" contiene "$SALIDA" "MAILWAY_MIGRACION_COLA_MAX=51"

echo "# La copia de las contraseñas falla: fuera del mantenimiento y nada cambiado"
preparar_migracion
printf '%s\n' '{"ok":false,"error":"No se ha podido copiar","capturados":1,"yaEstaban":0,"fallidos":["eva@ejemplo.test"]}' >"$E/panel/capturar"
migrar
comprobar "falla" igual "$CODIGO" 1
comprobar "dice qué buzón" contiene "$SALIDA" "eva@ejemplo.test"
comprobar "quita el mantenimiento" contiene "$REGISTRO" "motor.js mantenimiento off"
comprobar "no para la 0.15" no_contiene "$REGISTRO" "docker stop"
comprobar "dice que no ha cambiado nada" contiene "$SALIDA" "No se ha cambiado nada del motor: sigue Stalwart 0.15."

echo "# stalwart-cli apply falla (0.15 parada): vuelve sola a la 0.15"
preparar_migracion
echo 'run --rm -i --network mailway-internal -e STALWART_URL=*' >"$E/fallar"
migrar
comprobar "termina con 1 (vuelta atrás completa)" igual "$CODIGO" 1
comprobar "explica el fallo" contiene "$SALIDA" "stalwart-cli apply no ha terminado sin fallos"
comprobar "arranca la 0.15 con Compose" primera_tras_ultima "$REGISTRO" "docker compose[stalwart-0.15] --env-file" "FALLA:"
comprobar "el motor vuelve a la 0.15" igual "$(cat "$E/imagen")" "stalwartlabs/stalwart:v0.15.5"
comprobar "retira los temporales" contiene "$REGISTRO" "docker rm -f mailway-mail-016-recuperacion mailway-mail-016-previo"
comprobar "el extractor vuelve como estaba" contiene "$REGISTRO" "docker compose[stalwart-0.15] --env-file $ENV_FILE -f $TMP/deploy/docker-compose.mail.yml --profile tls up -d --force-recreate certs-dumper"
comprobar "deploy/.env intacto" env_intacto
comprobar "no se borra ningún volumen" sin_borrar_volumenes
comprobar "el panel sale del mantenimiento" contiene "$REGISTRO" "motor.js mantenimiento off"
comprobar "lo dice" contiene "$SALIDA" "el servidor ha vuelto a Stalwart 0.15, con sus datos de siempre"
comprobar "y qué hacer con lo del intento" contiene "$SALIDA" "docker volume rm mailway-stalwart-etc-20261009-120001 mailway-stalwart-data-20261009-120001"

echo "# El panel no puede aplicar sus ajustes en la 0.16 (sin puertos aún): vuelta atrás"
preparar_migracion
printf '%s\n' '{"ok":false,"error":"Fallo del panel","errores":["Fallo del panel"],"restartRequired":[],"suspensiones":{"reaplicadas":0,"fallidas":[]},"faltan":{"dominios":[],"buzones":[],"alias":[]}}' >"$E/panel/provisionar"
migrar
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "nunca abre los puertos de la 0.16" no_contiene "$REGISTRO" "docker compose[stalwart-0.16] --env-file $ENV_FILE -f $TMP/deploy/docker-compose.mail.yml up -d mailway-mail"
comprobar "el motor vuelve a la 0.15" igual "$(cat "$E/imagen")" "stalwartlabs/stalwart:v0.15.5"
comprobar "deploy/.env intacto" env_intacto
comprobar "sin aviso de correo en la 0.16" no_contiene "$SALIDA" "llegó a abrir los puertos"

echo "# Falla la comprobación final (la 0.16 ya con puertos): vuelta atrás y deploy/.env como estaba"
preparar_migracion
FAKE_COMPROBAR=1
migrar
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "para la 0.16 y arranca la 0.15" en_orden "$REGISTRO" "comprobar_instalacion" "docker stop -t 60 mailway-mail" "docker compose[stalwart-0.15] --env-file"
comprobar "el motor vuelve a la 0.15" igual "$(cat "$E/imagen")" "stalwartlabs/stalwart:v0.15.5"
comprobar "deploy/.env exactamente como estaba" env_intacto
comprobar "avisa del correo recibido mientras tanto" contiene "$SALIDA" "llegó a abrir los puertos"
comprobar "no se borra ningún volumen" sin_borrar_volumenes
comprobar "sin las tareas de después" no_contiene "$REGISTRO" "motor.js tras-migrar"

echo "# Tampoco vuelve la 0.15: código 2 y los pasos a mano"
preparar_migracion
FAKE_COMPROBAR=1
echo '*compose\[stalwart-0.15\]* up -d mailway-mail' >"$E/fallar"
migrar
comprobar "termina con 2" igual "$CODIGO" 2
comprobar "lo dice" contiene "$SALIDA" "la vuelta a la 0.15 tampoco del todo"
comprobar "con los pasos a mano" contiene "$SALIDA" "sudo bash deploy/instalar.sh --actualizar"
comprobar "deploy/.env como estaba" env_intacto
comprobar "no se borra ningún volumen" sin_borrar_volumenes

echo "# Sin un certificado válido en la 0.15 tampoco se le exige a la 0.16"
preparar_migracion
printf '%s\n' '{"ok":false,"puertos":{"993":{"ok":false,"error":"autofirmado"}}}' >"$E/ayudante/tls"
migrar
comprobar "termina bien" igual "$CODIGO" 0
comprobar "lo avisa" contiene "$SALIDA" "no se le exigirá a la 0.16"
comprobar "y la comprobación final lo tolera" contiene "$REGISTRO" "comprobar_instalacion TOLERAR_CERTIFICADO=1"

echo "# Con un certificado válido en la 0.15, la 0.16 debe servirlo: si no, vuelta atrás"
preparar_migracion
printf '%s\n' '{"ok":true}' >"$E/ayudante/tls.1"
printf '%s\n' '{"ok":false,"puertos":{"587":{"ok":false,"error":"autofirmado"}}}' >"$E/ayudante/tls.2"
migrar
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "explica qué puerto" contiene "$SALIDA" "587: autofirmado"
comprobar "el motor vuelve a la 0.15" igual "$(cat "$E/imagen")" "stalwartlabs/stalwart:v0.15.5"

# ------------------------------------------------------------- revertir --

preparar_revertir() {
  reiniciar_estado "stalwartlabs/stalwart:v0.16.25" mailway-mail-data mailway-stalwart-etc-20261001-101010 \
    mailway-stalwart-data-20261001-101010 skyway_traefik-letsencrypt
  marcha mailway-mail mailway-webmail mailway-certs-dumper skyway-mailway-panel
  touch "$E/herramienta"
  escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.16'" "MAILWAY_STALWART_ETC_VOLUME='mailway-stalwart-etc-20261001-101010'" \
    "MAILWAY_STALWART_DATA_VOLUME='mailway-stalwart-data-20261001-101010'" "MAILWAY_MOTOR_MIGRADO='2026-10-01T10:10:10Z'"
  rm -rf "$MIGRACIONES"
  FAKE_COMPROBAR=0
  printf '%s\n' '{"ok":true,"activo":true,"hasta":1760000000000}' >"$E/panel/mantenimiento-on"
  printf '%s\n' '{"ok":true,"activo":false,"hasta":null}' >"$E/panel/mantenimiento-off"
  printf '%s\n' "$PROVISION_OK" >"$E/panel/provisionar"
  printf '%s\n' '{"ok":true,"api":"rest015","credencialesInternas":{"renovadas":2,"fallidas":[]},"contrasenasInvalidadas":1,"contrasenasRecuperadas":4,"avisados":1,"avisosFallidos":[],"sinCopia":0}' >"$E/panel/tras-migrar"
}

echo "# --revertir-motor: la 0.15 sobre su volumen, con el panel al día"
preparar_revertir
ejecutar revertir_motor
comprobar "termina bien" igual "$CODIGO" 0
comprobar "pasos en orden" en_orden "$REGISTRO" "motor.js mantenimiento on --minutos 60" "docker stop -t 120 mailway-mail" \
  "docker compose[stalwart-0.15] --env-file" "motor.js provisionar" "motor.js tras-migrar" "motor.js mantenimiento off" \
  "comprobar_instalacion"
comprobar "deploy/.env dice la 0.15" igual "$(valor_env MAILWAY_MOTOR)" stalwart-0.15
comprobar "sin la marca de la migración" igual "$(valor_env MAILWAY_MOTOR_MIGRADO)" ""
comprobar "conserva los volúmenes de la 0.16 en deploy/.env" igual "$(valor_env MAILWAY_STALWART_DATA_VOLUME)" mailway-stalwart-data-20261001-101010
comprobar "el motor vuelve a la 0.15" igual "$(cat "$E/imagen")" "stalwartlabs/stalwart:v0.15.5"
comprobar "no se borra ningún volumen" sin_borrar_volumenes
comprobar "avisa del correo que se queda en la 0.16" contiene "$SALIDA" "se queda en el volumen de la 0.16 (mailway-stalwart-data-20261001-101010)"
comprobar "dice cuántas contraseñas de aplicación de la 0.15 vuelven a valer" contiene "$SALIDA" "de la 0.15 que vuelven a valer: 4"

echo "# --revertir-motor sin migración previa, en la 0.15 o sin el volumen de la 0.15: se niega"
preparar_revertir
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.16'"
ejecutar revertir_motor
comprobar "instalación nueva con la 0.16: se niega" igual "$CODIGO" 1
comprobar "y lo explica" contiene "$SALIDA" "empezó con Stalwart 0.16"
preparar_revertir
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.15'"
ejecutar revertir_motor
comprobar "con la 0.15: se niega" igual "$CODIGO" 1
preparar_revertir
reiniciar_estado "stalwartlabs/stalwart:v0.16.25" mailway-stalwart-data-20261001-101010
ejecutar revertir_motor
comprobar "sin el volumen de la 0.15: se niega" igual "$CODIGO" 1
comprobar "y lo explica" contiene "$SALIDA" "se retiró y no se puede volver a ella"
preparar_revertir
SIN_CONFIRMAR=0
ejecutar revertir_motor
SIN_CONFIRMAR=1
comprobar "sin terminal y sin -y: se niega" igual "$CODIGO" 1
comprobar "sin parar nada" no_contiene "$REGISTRO" "docker stop"

echo "# --revertir-motor y la 0.15 no arranca: lo dice y deja cómo seguir con la 0.16"
preparar_revertir
echo '*compose\[stalwart-0.15\]* up -d mailway-mail' >"$E/fallar"
ejecutar revertir_motor
comprobar "falla" igual "$CODIGO" 1
comprobar "explica cómo seguir con la 0.16" contiene "$SALIDA" "MAILWAY_MOTOR=stalwart-0.16 en $ENV_FILE"
comprobar "conserva la marca de la migración" igual "$(valor_env MAILWAY_MOTOR_MIGRADO)" "2026-10-01T10:10:10Z"
comprobar "el panel sale del mantenimiento" contiene "$REGISTRO" "motor.js mantenimiento off"

# ------------------------------------------------------- retirar la 0.15 --

preparar_retirar() {
  reiniciar_estado "stalwartlabs/stalwart:v0.16.25" mailway-mail-data mailway-stalwart-etc-20261001-101010 \
    mailway-stalwart-data-20261001-101010 mailway-stalwart-etc-20260930-090909 mailway-stalwart-data-20260930-090909
  marcha mailway-mail skyway-mailway-panel
  escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.16'" "MAILWAY_MAIL_VOLUME='mailway-mail-data'" \
    "MAILWAY_STALWART_ETC_VOLUME='mailway-stalwart-etc-20261001-101010'" \
    "MAILWAY_STALWART_DATA_VOLUME='mailway-stalwart-data-20261001-101010'" "MAILWAY_MOTOR_MIGRADO='2026-10-01T10:10:10Z'"
  rm -rf "$MIGRACIONES"
}

echo "# --retirar-motor-anterior -y sin decir el volumen, o con otro nombre: no borra nada"
preparar_retirar
ejecutar retirar_motor_anterior
comprobar "sin MAILWAY_RETIRAR_VOLUMEN: se niega" igual "$CODIGO" 1
comprobar "y dice cuál poner" contiene "$SALIDA" "MAILWAY_RETIRAR_VOLUMEN=mailway-mail-data"
MAILWAY_RETIRAR_VOLUMEN=mailway-stalwart-data-20261001-101010
ejecutar retirar_motor_anterior
comprobar "con otro nombre: se niega" igual "$CODIGO" 1
comprobar "no borra nada" sin_borrar_volumenes

echo "# --retirar-motor-anterior con el nombre: solo el volumen de la 0.15"
MAILWAY_RETIRAR_VOLUMEN=mailway-mail-data
ejecutar retirar_motor_anterior
comprobar "termina bien" igual "$CODIGO" 0
comprobar "borra el volumen de la 0.15" sin_volumen mailway-mail-data
comprobar "y nada más" igual "$(grep -c 'docker volume rm' "$REGISTRO")" 1
comprobar "los de la 0.16 siguen" volumen mailway-stalwart-data-20261001-101010
comprobar "quita MAILWAY_MAIL_VOLUME de deploy/.env" igual "$(valor_env MAILWAY_MAIL_VOLUME)" ""
comprobar "dice los de un intento anterior, sin borrarlos" contiene "$SALIDA" "mailway-stalwart-etc-20260930-090909 mailway-stalwart-data-20260930-090909"
comprobar "que siguen ahí" volumen mailway-stalwart-data-20260930-090909
ejecutar retirar_motor_anterior
comprobar "repetirlo no hace nada" igual "$CODIGO" 0
comprobar "y lo dice" contiene "$SALIDA" "No queda ningún volumen de la 0.15"

echo "# --retirar-motor-anterior con un contenedor que usa el volumen: no lo borra"
preparar_retirar
echo "mailway-mail-viejo" >"$E/usado"
ejecutar retirar_motor_anterior
comprobar "se niega" igual "$CODIGO" 1
comprobar "dice qué contenedor" contiene "$SALIDA" "mailway-mail-viejo"
comprobar "no borra nada" sin_borrar_volumenes
rm -f "$E/usado"

echo "# --retirar-motor-anterior en la terminal: hay que escribir el nombre"
preparar_retirar
SIN_CONFIRMAR=0
INTERACTIVO=1
ejecutar retirar_motor_anterior <<<"mailway-mail"
comprobar "otro nombre: se niega" igual "$CODIGO" 1
comprobar "no borra nada" sin_borrar_volumenes
ejecutar retirar_motor_anterior <<<"mailway-mail-data"
comprobar "el nombre exacto: lo borra" sin_volumen mailway-mail-data
INTERACTIVO=0
SIN_CONFIRMAR=1
unset MAILWAY_RETIRAR_VOLUMEN

echo "# --retirar-motor-anterior con la 0.15 en uso: se niega"
preparar_retirar
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.15'"
ejecutar retirar_motor_anterior
comprobar "se niega" igual "$CODIGO" 1
comprobar "no borra nada" sin_borrar_volumenes

# --------------------------------------------------------------- Bulwark --

# Prepara Bulwark como el instalador con el motor $1 y deja en $TMP/bloque el
# bloque de Bulwark de deploy/.env (lo que escribiría escribir_env).
bloque_bulwark() {
  MOTOR=$1
  preparar_bulwark
  escribir_env_bulwark >"$TMP/bloque"
}
linea_bloque() { sed -n "s/^$1='\(.*\)'\$/\1/p" "$TMP/bloque"; }
# El bloque pasa a deploy/.env (como lo haría escribir_env).
guardar_bloque() {
  grep -v -E '^(MAILWAY_BULWARK|BULWARK_)' "$ENV_FILE" >"$ENV_FILE.n"
  cat "$TMP/bloque" >>"$ENV_FILE.n"
  mv "$ENV_FILE.n" "$ENV_FILE"
}

echo "# Bulwark: activarlo con la 0.15 se niega sin cambiar nada"
reiniciar_estado "stalwartlabs/stalwart:v0.15.5" mailway-mail-data
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.15'"
cp "$ENV_FILE" "$TMP/env-antes"
ejecutar cambiar_bulwark activar
comprobar "se niega" igual "$CODIGO" 1
comprobar "y lo explica" contiene "$SALIDA" "Bulwark necesita Stalwart 0.16 y este servidor usa la 0.15: no se ha cambiado nada"
comprobar "remite a la migración" contiene "$SALIDA" "sudo mailway migrar-motor"
comprobar "deploy/.env como estaba" cmp -s "$ENV_FILE" "$TMP/env-antes"
comprobar "sin tocar Docker" no_contiene "$REGISTRO" "docker compose"

echo "# Bulwark: activarlo con la 0.16 lo pide en deploy/.env (y sigue como --actualizar)"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25" mailway-stalwart-data
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.16'"
ejecutar cambiar_bulwark activar
comprobar "termina bien" igual "$CODIGO" 0
comprobar "MAILWAY_BULWARK=1 en deploy/.env" igual "$(valor_env MAILWAY_BULWARK)" 1

echo "# Bulwark activo: dos secretos generados una vez, nunca a la vista, y lo que recibe el panel"
ejecutar bloque_bulwark stalwart-0.16
SESION=$(linea_bloque BULWARK_SESSION_SECRET)
ADMIN=$(linea_bloque BULWARK_ADMIN_PASSWORD)
comprobar "termina bien" igual "$CODIGO" 0
comprobar "secreto de sesión de 64 caracteres" coincide "$SESION" '^[0-9a-f]{64}$'
comprobar "contraseña de administración de 48" coincide "$ADMIN" '^[0-9a-f]{48}$'
comprobar "ninguno de los dos se muestra" no_contiene "$SALIDA" "$SESION"
comprobar "ni la contraseña" no_contiene "$SALIDA" "$ADMIN"
comprobar "el panel recibe la API de administración" igual "$(linea_bloque MAILWAY_BULWARK_URL)" "http://mailway-bulwark:3000"
comprobar "y el destino de Traefik" igual "$(linea_bloque MAILWAY_BULWARK_BACKEND_URL)" "http://mailway-bulwark-gw:8080"
guardar_bloque
ejecutar bloque_bulwark stalwart-0.16
comprobar "una segunda vez: el mismo secreto de sesión" igual "$(linea_bloque BULWARK_SESSION_SECRET)" "$SESION"
comprobar "y la misma contraseña" igual "$(linea_bloque BULWARK_ADMIN_PASSWORD)" "$ADMIN"
comprobar "sin generar nada" no_contiene "$SALIDA" "generad"
: >"$REGISTRO"
(MOTOR=stalwart-0.16 && compose config -q) >/dev/null 2>&1
comprobar "Compose recibe el perfil «bulwark»" contiene "$REGISTRO" "--profile bulwark config -q"
: >"$REGISTRO"
(MOTOR=stalwart-0.15 && compose config -q) >/dev/null 2>&1
comprobar "con la 0.15, no" no_contiene "$REGISTRO" "--profile bulwark"

echo "# Bulwark con un admin.json de antes y sin su contraseña en deploy/.env: se retira para que tome la nueva"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25" mailway-stalwart-data mailway-bulwark-admin mailway-bulwark-ajustes
touch "$E/bulwark-admin-json" "$E/bulwark-ajustes"
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.16'" "MAILWAY_BULWARK='1'"
ejecutar bloque_bulwark stalwart-0.16
comprobar "retira el admin.json" no_existe "$E/bulwark-admin-json"
comprobar "y lo dice" contiene "$SALIDA" "Retirado el admin.json anterior de Bulwark"
comprobar "avisa de que los ajustes sincronizados no se podrán leer" contiene "$SALIDA" "esos ajustes no se podrán leer"
comprobar "sin borrar ningún volumen" sin_borrar_volumenes

echo "# Bulwark pedido con la 0.15, o con un secreto corto: queda desactivado y lo dice"
reiniciar_estado "stalwartlabs/stalwart:v0.15.5" mailway-mail-data
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.15'" "MAILWAY_BULWARK='1'"
ejecutar bloque_bulwark stalwart-0.15
comprobar "lo explica" contiene "$SALIDA" "Bulwark necesita Stalwart 0.16 y este servidor usa la 0.15: queda desactivado"
comprobar "deploy/.env lo guardará desactivado" igual "$(linea_bloque MAILWAY_BULWARK)" 0
comprobar "sin las variables del panel" no_contiene "$TMP/bloque" "MAILWAY_BULWARK_URL"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25" mailway-stalwart-data
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.16'" "MAILWAY_BULWARK='1'" "BULWARK_SESSION_SECRET='corto'"
ejecutar bloque_bulwark stalwart-0.16
comprobar "secreto corto: lo explica" contiene "$SALIDA" "tiene menos de 32 caracteres"
comprobar "queda desactivado" igual "$(linea_bloque MAILWAY_BULWARK)" 0
comprobar "sin cambiar el secreto" igual "$(linea_bloque BULWARK_SESSION_SECRET)" corto

echo "# Bulwark desactivado: fuera sus contenedores, con sus volúmenes y sus secretos"
reiniciar_estado "stalwartlabs/stalwart:v0.16.25" mailway-stalwart-data mailway-bulwark-ajustes mailway-bulwark-admin mailway-bulwark-estado
marcha mailway-mail mailway-bulwark mailway-bulwark-gw
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.16'" "MAILWAY_BULWARK='1'" "BULWARK_SESSION_SECRET='$(printf 's%.0s' {1..40})'" \
  "BULWARK_ADMIN_PASSWORD='admin-de-bulwark'" "MAILWAY_BULWARK_URL='http://mailway-bulwark:3000'"
ejecutar cambiar_bulwark desactivar
comprobar "MAILWAY_BULWARK=0" igual "$(valor_env MAILWAY_BULWARK)" 0
ejecutar bloque_bulwark stalwart-0.16
comprobar "conserva el secreto de sesión" igual "$(linea_bloque BULWARK_SESSION_SECRET)" "$(printf 's%.0s' {1..40})"
comprobar "y la contraseña" igual "$(linea_bloque BULWARK_ADMIN_PASSWORD)" admin-de-bulwark
comprobar "el panel ya no recibe sus variables" no_contiene "$TMP/bloque" "MAILWAY_BULWARK_URL"
(MOTOR=stalwart-0.16 && set -e && retirar_bulwark) >"$SALIDA" 2>&1
comprobar "retira sus contenedores" contiene "$REGISTRO" "--profile bulwark rm -s -f mailway-bulwark mailway-bulwark-gw"
comprobar "sin -v" no_contiene "$REGISTRO" "rm -s -f -v"
comprobar "y sin borrar ningún volumen" sin_borrar_volumenes
comprobar "lo dice" contiene "$SALIDA" "sus volúmenes (mailway-bulwark-ajustes mailway-bulwark-admin mailway-bulwark-estado) y sus secretos se conservan"
: >"$REGISTRO"
(MOTOR=stalwart-0.16 && set -e && retirar_bulwark) >"$SALIDA" 2>&1
comprobar "una segunda vez no hace nada" no_contiene "$REGISTRO" "docker compose"

echo "# --revertir-motor con Bulwark activo: queda desactivado, con sus secretos"
preparar_revertir
marcha mailway-bulwark mailway-bulwark-gw
escribir_env_prueba "MAILWAY_MOTOR='stalwart-0.16'" "MAILWAY_STALWART_ETC_VOLUME='mailway-stalwart-etc-20261001-101010'" \
  "MAILWAY_STALWART_DATA_VOLUME='mailway-stalwart-data-20261001-101010'" "MAILWAY_MOTOR_MIGRADO='2026-10-01T10:10:10Z'" \
  "MAILWAY_BULWARK='1'" "BULWARK_SESSION_SECRET='$(printf 's%.0s' {1..40})'" "BULWARK_ADMIN_PASSWORD='admin-de-bulwark'" \
  "MAILWAY_BULWARK_URL='http://mailway-bulwark:3000'" "MAILWAY_BULWARK_BACKEND_URL='http://mailway-bulwark-gw:8080'"
ejecutar revertir_motor
comprobar "termina bien" igual "$CODIGO" 0
comprobar "MAILWAY_BULWARK=0" igual "$(valor_env MAILWAY_BULWARK)" 0
comprobar "sin las variables del panel" igual "$(valor_env MAILWAY_BULWARK_URL)$(valor_env MAILWAY_BULWARK_BACKEND_URL)" ""
comprobar "con sus secretos" igual "$(valor_env BULWARK_ADMIN_PASSWORD)" admin-de-bulwark
comprobar "retira sus contenedores antes de levantar el resto" en_orden "$REGISTRO" \
  "--profile bulwark rm -s -f mailway-bulwark mailway-bulwark-gw" "docker compose[stalwart-0.15] --env-file"
comprobar "lo explica" contiene "$SALIDA" "Bulwark necesita Stalwart 0.16: queda desactivado"
comprobar "sin borrar ningún volumen" sin_borrar_volumenes

echo "# Ningún doble ha recibido una llamada que no esperaba"
comprobar "ninguna llamada sin simular" igual "$(cat "$IMPREVISTOS")" ""

echo
TERMINADA=1
if [ "$FALLOS" -gt 0 ]; then
  echo "$FALLOS comprobaciones han fallado."
  exit 1
fi
echo "Todas las comprobaciones son correctas."
