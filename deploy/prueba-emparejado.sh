#!/usr/bin/env bash
#
# Pruebas del emparejado con Skyway y del paso «Panel en Skyway» de
# deploy/instalar.sh, con docker y la API de Skyway simulados: sin
# contenedores, sin red y sin root. Carga las funciones del instalador (todo
# menos la llamada final a main) y comprueba lo que hacen en cada escenario.
#
#   bash deploy/prueba-emparejado.sh     # código 1 si alguna comprobación falla
#
# Necesita jq (el instalador lo usa para leer las respuestas JSON).
#
# Las variables que fija la prueba las leen las funciones del instalador, que
# el análisis estático no ve (se cargan de una copia): de ahí SC2034. Por lo
# mismo, los dobles de docker, sky_api y otras funciones (que cada sección
# vuelve a definir) solo los invocan esas funciones: SC2329 (SC2317 en las
# versiones de shellcheck anteriores a la 0.11). Y algunos escenarios cambian
# variables dentro de un subshell precisamente para que el cambio no llegue a
# los siguientes: SC2030 y SC2031.
# shellcheck disable=SC2034,SC2329,SC2317,SC2030,SC2031

set -uo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v jq >/dev/null 2>&1 || { echo "Falta jq." >&2; exit 1; }
if [ "$(tail -n 1 "$AQUI/instalar.sh")" != "main" ]; then
  echo "La última línea de instalar.sh ya no es «main»: actualiza esta prueba." >&2
  exit 1
fi

TMP=$(mktemp -d)
mkdir -p "$TMP/deploy"
sed '$d' "$AQUI/instalar.sh" >"$TMP/deploy/instalar.sh"
REGISTRO="$TMP/registro"
SALIDA="$TMP/salida"
: >"$REGISTRO"

# shellcheck source=/dev/null
source "$TMP/deploy/instalar.sh" </dev/null
set +e
# Un «fallo» del instalador fuera de un subshell terminaría la prueba a medias:
# que no pase inadvertido. Se escribe en el descriptor 3 (la salida original),
# porque al salir puede seguir activa la redirección de la función que falló.
TERMINADA=0
exec 3>&1
trap 'al_salir; rm -rf "$TMP"; [ "$TERMINADA" = 1 ] || echo "FALLO - la prueba terminó antes de tiempo" >&3' EXIT
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
  fi
}
contiene() { grep -Fq -- "$2" "$1"; }
rechaza_correo() { ! correo_admin_valido "$1"; }
no_contiene() { ! grep -Fq -- "$2" "$1"; }
# Una línea exactamente igual a $2 (con «contiene», un salto de línea en el
# patrón serían dos patrones, y uno vacío casa con todo).
tiene_linea() { grep -Fxq -- "$2" "$1"; }
igual() { [ "$1" = "$2" ]; }

# ------------------------------------------------------------- simulación --

# docker simulado. Escenario en FAKE_*: salida y avisos de la herramienta del
# panel, IP del contenedor «skyway».
FAKE_SALIDA=""
FAKE_AVISO=""
FAKE_IPS="172.18.0.5 "
# Herramienta de Cloudflare: si existe en el panel y en Skyway, si falla y qué responde.
FAKE_CF_PANEL=1
FAKE_CF_SKYWAY=1
FAKE_CF_FALLA=""
FAKE_CF_SALIDA='{"ok":true,"id":"cf_1","label":"Instalador de Mailway","zones":3,"creada":true}'
docker() {
  printf 'docker %s\n' "$*" >>"$REGISTRO"
  case "$*" in
    "inspect --type container -f {{.State.Running}} skyway") echo true ;;
    "inspect --type container -f {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}} skyway") echo "$FAKE_IPS" ;;
    "exec skyway test -f server/dist/tools/cloudflare.js") [ "$FAKE_CF_SKYWAY" = 1 ] ;;
    "exec panel-c test -f server/dist/tools/cloudflare.js" | "exec mailway-panel test -f server/dist/tools/cloudflare.js")
      [ "$FAKE_CF_PANEL" = 1 ]
      ;;
    "exec skyway test -f "* | "exec panel-c test -f "*) return 0 ;;
    "exec -i -u node "*" node server/dist/tools/cloudflare.js conectar"*)
      # Lo que llega por la entrada estándar queda en el registro (no es una línea «docker»).
      echo "CF_PANEL_RECIBIDO=$(cat)" >>"$REGISTRO"
      if [ -n "$FAKE_CF_FALLA" ]; then
        echo "$FAKE_CF_FALLA" >&2
        return 1
      fi
      printf '%s\n' "$FAKE_CF_SALIDA"
      ;;
    "exec -i skyway node server/dist/tools/cloudflare.js conectar"*)
      echo "CF_SKYWAY_RECIBIDO=$(cat)" >>"$REGISTRO"
      echo '{"ok":true}'
      ;;
    "exec skyway node server/dist/tools/token.js crear"*) echo '{"id":"tok_tmp1","token":"sky_temporal12345"}' ;;
    "exec skyway node server/dist/tools/token.js revocar"*) echo "TOKEN_TEMPORAL_REVOCADO" >>"$REGISTRO" ;;
    "exec -i -u node panel-c node server/dist/tools/emparejar.js"*)
      if [ -n "$FAKE_AVISO" ]; then echo "Aviso: $FAKE_AVISO" >&2; fi
      printf '%s\n' "$FAKE_SALIDA"
      ;;
    "exec -i skyway node server/dist/tools/mailway.js conectar"*)
      echo "TOKEN_RECIBIDO=$(cat)" >>"$REGISTRO"
      echo '{"ok":true,"version":"1.0.0","brandName":"Correo"}'
      ;;
    *)
      echo "docker no simulado: $*" >>"$REGISTRO"
      return 1
      ;;
  esac
}
esperar_sano() { return 0; }
# Sin red: la IP con la que «sale» el servidor y si la guardada es de una de
# sus interfaces los fija cada escenario.
FAKE_IP_DETECTADA=203.0.113.7
FAKE_IP_LOCAL=1
detectar_ip() {
  echo "DETECTAR_IP" >>"$REGISTRO"
  printf '%s' "$FAKE_IP_DETECTADA"
}
ip_local() { [ "$FAKE_IP_LOCAL" = 0 ]; }

# API de Skyway simulada. /api/health responde 200 solo en FAKE_SANA.
FAKE_SANA=""
FAKE_CONFIG='{"configured":false}'
sky_api() {
  printf 'sky_api %s %s\n' "$1" "$SKYWAY_URL$2" >>"$REGISTRO"
  case "$2" in
    /api/health)
      RESP_BODY='{"version":"0.34.0"}'
      if [ "$SKYWAY_URL" = "$FAKE_SANA" ]; then RESP_CODE=200; else RESP_CODE=000; fi
      ;;
    /api/mailway/config) RESP_CODE=200 RESP_BODY=$FAKE_CONFIG ;;
    /api/mailway/test) RESP_CODE=200 RESP_BODY='{"ok":true,"info":{"role":"admin"}}' ;;
    # Lo siguiente del despliegue no se prueba aquí: termina en un error conocido.
    *) RESP_CODE=401 RESP_BODY='{}' ;;
  esac
}

# Deja el estado del emparejado como al empezar.
reiniciar() {
  : >"$REGISTRO"
  EMPAREJADO_OK=0
  EMPAREJADO_ADMIN_EMAIL=""
  EMPAREJADO_ADMIN_PASSWORD=""
  RESUMEN_EMPAREJADO=""
  FAKE_AVISO=""
  CF_TOKEN=""
  RESUMEN_CF_PANEL=""
  RESUMEN_CF_SKYWAY=""
  CF_PANEL_CONECTADA=0
  FAKE_CF_PANEL=1
  FAKE_CF_SKYWAY=1
  FAKE_CF_FALLA=""
  ACTUALIZAR=0
  EMPAREJAR=0
}
# Ninguna línea «docker …» del registro (sus argumentos) contiene $1.
docker_sin() {
  grep '^docker ' "$REGISTRO" >"$TMP/lineas-docker" || true
  ! grep -Fq -- "$1" "$TMP/lineas-docker"
}
# El final de la instalación junto a Skyway, en el mismo orden que main.
final_skyway() {
  emparejar_al_terminar
  conectar_cloudflare_junto_a_skyway
  conectar_cloudflare_en_skyway
}
# Las llamadas a la herramienta de Cloudflare van después de la de emparejado.
cloudflare_tras_emparejado() {
  local emparejado cloudflare
  emparejado=$(grep -n 'emparejar.js --email' "$REGISTRO" | head -n 1 | cut -d: -f1)
  cloudflare=$(grep -n 'cloudflare.js conectar' "$REGISTRO" | head -n 1 | cut -d: -f1)
  [ -n "$emparejado" ] && [ -n "$cloudflare" ] && [ "$cloudflare" -gt "$emparejado" ]
}

TOKEN_MWT='mwt_0123abcd_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'
TOKEN_CF='cfut_TokenDeCloudflareDePrueba0123456789abcd'
PANEL_CONTENEDOR=panel-c
PANEL_SERVICIO_ID=svc1
PANEL_PROYECTO_ID=prj1
PANEL_HOSTNAME=panel.ejemplo.test
ADMIN_EMAIL=admin@ejemplo.test

# ------------------------------------------------------------- escenarios --

echo "# Correo de la cuenta de administración (lo que rechaza el panel, se rechaza al principio)"
for correo in admin@ejemplo.test Ana.Uno+avisos@sub.ejemplo.test; do
  comprobar "acepta $correo" correo_admin_valido "$correo"
done
for correo in a..b@ejemplo.test %x@ejemplo.test .a@ejemplo.test a.@ejemplo.test "o'brien@ejemplo.test" a@ejemplo..test; do
  comprobar "rechaza $correo" rechaza_correo "$correo"
done

echo "# La cuenta existente tiene un correo con apóstrofo y la herramienta avisa"
reiniciar
FAKE_SALIDA="{\"adminEmail\":\"o'brien@empresa.test\",\"token\":\"$TOKEN_MWT\"}"
FAKE_AVISO="El motor no responde. Al entrar en el panel, el asistente continúa en el paso del motor."
emparejar_con_skyway >"$SALIDA" 2>&1
comprobar "el token llega a Skyway por la entrada estándar" contiene "$REGISTRO" "TOKEN_RECIBIDO=$TOKEN_MWT"
comprobar "queda emparejado" igual "$EMPAREJADO_OK" 1
comprobar "con el correo de la cuenta" igual "$EMPAREJADO_ADMIN_EMAIL" "o'brien@empresa.test"
comprobar "no dice que la puesta en marcha se completó sin más" no_contiene "$SALIDA" "[ok] Puesta en marcha del panel completada"
comprobar "dice que se completó con avisos" contiene "$SALIDA" "completada con avisos"
comprobar "el resumen lo recoge" contiene <(printf '%s' "$RESUMEN_EMPAREJADO") "con avisos"

echo "# Cuenta nueva y sin avisos"
reiniciar
FAKE_SALIDA="{\"adminEmail\":\"admin@ejemplo.test\",\"adminPassword\":\"Abcdefghijklmnopqrstuvwx\",\"token\":\"$TOKEN_MWT\"}"
emparejar_con_skyway >"$SALIDA" 2>&1
comprobar "dice que la puesta en marcha se completó" contiene "$SALIDA" "Puesta en marcha del panel completada con el entorno"
comprobar "guarda la contraseña para el resumen" igual "$EMPAREJADO_ADMIN_PASSWORD" "Abcdefghijklmnopqrstuvwx"
comprobar "no la muestra antes del resumen" no_contiene "$SALIDA" "Abcdefghijklmnopqrstuvwx"

echo "# Respuesta sin token: no se conecta nada"
reiniciar
FAKE_SALIDA='{"adminEmail":"admin@ejemplo.test"}'
emparejar_con_skyway >"$SALIDA" 2>&1
comprobar "avisa de la respuesta inesperada" contiene "$SALIDA" "Respuesta inesperada de la herramienta de emparejado"
comprobar "no llama a Skyway" no_contiene "$REGISTRO" "mailway.js conectar"
comprobar "no queda emparejado" igual "$EMPAREJADO_OK" 0

echo "# Skyway ya conectado con este panel: se vuelve a emparejar (retoma lo pendiente)"
reiniciar
SKYWAY_TOKEN=sky_indicado12345
SKYWAY_URL=http://127.0.0.1:4000
FAKE_CONFIG='{"configured":true,"serviceId":"svc1","baseUrl":"https://panel.ejemplo.test"}'
FAKE_SALIDA="{\"adminEmail\":\"admin@ejemplo.test\",\"token\":\"$TOKEN_MWT\"}"
emparejar_al_terminar >"$SALIDA" 2>&1
comprobar "ejecuta la herramienta del panel" contiene "$REGISTRO" "node server/dist/tools/emparejar.js --email"
comprobar "conecta Skyway con el token nuevo" contiene "$REGISTRO" "TOKEN_RECIBIDO=$TOKEN_MWT"
comprobar "queda emparejado" igual "$EMPAREJADO_OK" 1

echo "# Skyway conectado con otro panel: no se toca"
reiniciar
FAKE_CONFIG='{"configured":true,"serviceId":"otro","baseUrl":"https://otro.ejemplo.test"}'
emparejar_al_terminar >"$SALIDA" 2>&1
comprobar "no ejecuta la herramienta del panel" no_contiene "$REGISTRO" "emparejar.js --email"
comprobar "lo explica" contiene "$SALIDA" "Skyway ya está conectado con otro panel de Mailway"
SKYWAY_TOKEN=""

echo "# Con token de Cloudflare: llega por la entrada estándar al panel y a Skyway, nunca en argumentos"
reiniciar
CF_TOKEN=$TOKEN_CF
FAKE_SALIDA="{\"adminEmail\":\"admin@ejemplo.test\",\"token\":\"$TOKEN_MWT\"}"
final_skyway >"$SALIDA" 2>&1
comprobar "el panel recibe el token por la entrada estándar" contiene "$REGISTRO" "CF_PANEL_RECIBIDO=$TOKEN_CF"
comprobar "como el usuario del panel y con su nombre" contiene "$REGISTRO" "docker exec -i -u node panel-c node server/dist/tools/cloudflare.js conectar --nombre Instalador de Mailway"
comprobar "después de la herramienta de emparejado" cloudflare_tras_emparejado
comprobar "Skyway lo recibe por la entrada estándar" contiene "$REGISTRO" "CF_SKYWAY_RECIBIDO=$TOKEN_CF"
comprobar "ninguna línea docker lleva el token" docker_sin "$TOKEN_CF"
comprobar "la salida del instalador no lo muestra" no_contiene "$SALIDA" "$TOKEN_CF"
comprobar "el emparejado sigue" igual "$EMPAREJADO_OK" 1
comprobar "el resumen dice qué cuenta quedó conectada" igual "$RESUMEN_CF_PANEL" "cuenta de la instancia conectada («Instalador de Mailway», 3 zonas)"
comprobar "y lo de Skyway" contiene <(printf '%s' "$RESUMEN_CF_SKYWAY") "token guardado"

echo "# Cuenta que ya estaba conectada (otra ejecución): se dice así"
reiniciar
CF_TOKEN=$TOKEN_CF
FAKE_CF_SALIDA='{"ok":true,"id":"cf_1","label":"Instalador de Mailway","zones":3,"creada":false,"sustituida":false}'
final_skyway >"$SALIDA" 2>&1
comprobar "ya conectada" contiene <(printf '%s' "$RESUMEN_CF_PANEL") "ya conectada"

echo "# Token nuevo en la cuenta del instalador (rotación): se dice que se ha sustituido"
reiniciar
CF_TOKEN=$TOKEN_CF
FAKE_CF_SALIDA='{"ok":true,"id":"cf_1","label":"Instalador de Mailway","zones":4,"creada":false,"sustituida":true}'
final_skyway >"$SALIDA" 2>&1
comprobar "sustituido" igual "$RESUMEN_CF_PANEL" "token de la cuenta de la instancia sustituido por el nuevo («Instalador de Mailway», 4 zonas)"
comprobar "queda conectada" igual "$CF_PANEL_CONECTADA" 1
FAKE_CF_SALIDA='{"ok":true,"id":"cf_1","label":"Instalador de Mailway","zones":3,"creada":true,"sustituida":false}'

echo "# Skyway sin la herramienta de Cloudflare: aviso y sigue"
reiniciar
CF_TOKEN=$TOKEN_CF
FAKE_CF_SKYWAY=0
FAKE_SALIDA="{\"adminEmail\":\"admin@ejemplo.test\",\"token\":\"$TOKEN_MWT\"}"
{ final_skyway; echo "CODIGO=$?"; } >"$SALIDA" 2>&1
comprobar "avisa" contiene "$SALIDA" "Esta versión de Skyway no guarda el token de Cloudflare"
comprobar "no interrumpe" contiene "$SALIDA" "CODIGO=0"
comprobar "no llama a una herramienta que no existe" no_contiene "$REGISTRO" "docker exec -i skyway node server/dist/tools/cloudflare.js"
comprobar "el panel sí la recibe" contiene "$REGISTRO" "CF_PANEL_RECIBIDO=$TOKEN_CF"
comprobar "el emparejado sigue" igual "$EMPAREJADO_OK" 1
comprobar "el resumen lo recoge" contiene <(printf '%s' "$RESUMEN_CF_SKYWAY") "pendiente"

echo "# Panel sin la herramienta o que falla: aviso, sin interrumpir el emparejado"
reiniciar
CF_TOKEN=$TOKEN_CF
FAKE_CF_PANEL=0
final_skyway >"$SALIDA" 2>&1
comprobar "explica cómo conectarla a mano" contiene "$SALIDA" "Conexiones → Cloudflare"
comprobar "no la llama" no_contiene "$REGISTRO" "CF_PANEL_RECIBIDO"
comprobar "Skyway queda emparejado" igual "$EMPAREJADO_OK" 1
reiniciar
CF_TOKEN=$TOKEN_CF
FAKE_SALIDA="{\"adminEmail\":\"admin@ejemplo.test\",\"token\":\"$TOKEN_MWT\"}"
FAKE_CF_FALLA="Cloudflare ha rechazado el token."
final_skyway >"$SALIDA" 2>&1
comprobar "muestra el motivo" contiene "$SALIDA" "Cloudflare ha rechazado el token."
comprobar "queda pendiente" contiene <(printf '%s' "$RESUMEN_CF_PANEL") "pendiente"
comprobar "Skyway queda emparejado igualmente" igual "$EMPAREJADO_OK" 1
comprobar "y la contraseña sigue para el resumen" igual "$EMPAREJADO_ADMIN_EMAIL" "admin@ejemplo.test"
# El fallo de Cloudflare no es un pendiente de la puesta en marcha: no se manda repetir --emparejar.
comprobar "la puesta en marcha se da por completa" contiene "$SALIDA" "Puesta en marcha del panel completada con el entorno"
comprobar "sin decir que tuvo avisos" no_contiene "$SALIDA" "completada con avisos"
comprobar "ni el resumen del emparejado" no_contiene <(printf '%s' "$RESUMEN_EMPAREJADO") "con avisos"

echo "# Avisos de la puesta en marcha y Cloudflare sin avisos: el resumen conserva los de la puesta en marcha"
reiniciar
CF_TOKEN=$TOKEN_CF
FAKE_SALIDA="{\"adminEmail\":\"admin@ejemplo.test\",\"token\":\"$TOKEN_MWT\"}"
FAKE_AVISO="El motor no responde. Al entrar en el panel, el asistente continúa en el paso del motor."
final_skyway >"$SALIDA" 2>&1
comprobar "dice que se completó con avisos" contiene "$SALIDA" "completada con avisos"
comprobar "no dice que se completó sin más" no_contiene "$SALIDA" "[ok] Puesta en marcha del panel completada"
comprobar "el resumen lo recoge" contiene <(printf '%s' "$RESUMEN_EMPAREJADO") "con avisos"
comprobar "y la cuenta de Cloudflare se conecta igual" igual "$CF_PANEL_CONECTADA" 1

echo "# Si la herramienta de emparejado falla, el panel recibe igualmente la cuenta de Cloudflare"
reiniciar
CF_TOKEN=$TOKEN_CF
FAKE_SALIDA='{"adminEmail":"admin@ejemplo.test"}'
final_skyway >"$SALIDA" 2>&1
comprobar "no queda emparejado" igual "$EMPAREJADO_OK" 0
comprobar "el panel recibe el token por la entrada estándar" contiene "$REGISTRO" "CF_PANEL_RECIBIDO=$TOKEN_CF"
comprobar "queda conectada" igual "$CF_PANEL_CONECTADA" 1

echo "# Skyway conectado con otro panel: no se empareja, pero el panel recibe la cuenta"
reiniciar
CF_TOKEN=$TOKEN_CF
SKYWAY_TOKEN=sky_indicado12345
SKYWAY_URL=http://127.0.0.1:4000
FAKE_CONFIG='{"configured":true,"serviceId":"otro","baseUrl":"https://otro.ejemplo.test"}'
final_skyway >"$SALIDA" 2>&1
comprobar "no ejecuta la herramienta de emparejado" no_contiene "$REGISTRO" "emparejar.js --email"
comprobar "el panel recibe el token" contiene "$REGISTRO" "CF_PANEL_RECIBIDO=$TOKEN_CF"
comprobar "el resumen dice qué cuenta quedó conectada" contiene <(printf '%s' "$RESUMEN_CF_PANEL") "cuenta de la instancia conectada"
SKYWAY_TOKEN=""
FAKE_CONFIG='{"configured":false}'

echo "# Sin token (instalación sin Cloudflare): no se llama a ninguna"
reiniciar
FAKE_SALIDA="{\"adminEmail\":\"admin@ejemplo.test\",\"token\":\"$TOKEN_MWT\"}"
final_skyway >"$SALIDA" 2>&1
comprobar "ni en el panel ni en Skyway" no_contiene "$REGISTRO" "cloudflare.js"
comprobar "el resumen no dice nada de una cuenta" igual "$RESUMEN_CF_PANEL$RESUMEN_CF_SKYWAY" ""

echo "# --actualizar y --emparejar no tienen el token: no se pide y lo conectado se conserva"
for modo in ACTUALIZAR EMPAREJAR; do
  reiniciar
  printf -v "$modo" '%s' 1
  FAKE_SALIDA="{\"adminEmail\":\"admin@ejemplo.test\",\"token\":\"$TOKEN_MWT\"}"
  final_skyway >"$SALIDA" 2>&1 </dev/null
  comprobar "$modo: no llama a ninguna herramienta de Cloudflare" no_contiene "$REGISTRO" "cloudflare.js"
  # Esta ejecución no sabe si hay una cuenta: no la da por hecha.
  comprobar "$modo: informa en condicional" contiene "$SALIDA" "si el panel ya tenía una cuenta conectada, la conserva"
  comprobar "$modo: el resumen lo recoge" contiene <(printf '%s' "$RESUMEN_CF_PANEL") "si el panel ya tenía una cuenta conectada"
  if [ "$modo" = ACTUALIZAR ]; then
    comprobar "$modo: y para Skyway, también en condicional" contiene <(printf '%s' "$RESUMEN_CF_SKYWAY") "si Skyway ya tenía uno guardado"
  fi
done
# --emparejar no pasa por el paso de Cloudflare: aunque se exporte el token, no
# lo usa (ni lo verifica ni lo pasa) y dice cómo conectarlo.
reiniciar
EMPAREJAR=1
FAKE_SALIDA="{\"adminEmail\":\"admin@ejemplo.test\",\"token\":\"$TOKEN_MWT\"}"
(CLOUDFLARE_API_TOKEN=$TOKEN_CF && final_skyway) >"$SALIDA" 2>&1 </dev/null
comprobar "--emparejar con CLOUDFLARE_API_TOKEN: no llama a ninguna herramienta de Cloudflare" no_contiene "$REGISTRO" "cloudflare.js"
comprobar "--emparejar con CLOUDFLARE_API_TOKEN: indica que se use --actualizar" contiene "$SALIDA" "--emparejar no usa CLOUDFLARE_API_TOKEN"
comprobar "--emparejar con CLOUDFLARE_API_TOKEN: sin mostrar el token" no_contiene "$SALIDA" "$TOKEN_CF"
reiniciar

echo "# Instalación autónoma: el token llega al panel mailway-panel por la entrada estándar"
reiniciar
CF_TOKEN=$TOKEN_CF
conectar_cloudflare_autonoma >"$SALIDA" 2>&1
comprobar "lo recibe por la entrada estándar" contiene "$REGISTRO" "CF_PANEL_RECIBIDO=$TOKEN_CF"
comprobar "en el contenedor del panel autónomo" contiene "$REGISTRO" "docker exec -i -u node mailway-panel node server/dist/tools/cloudflare.js conectar"
comprobar "sin el token en argumentos" docker_sin "$TOKEN_CF"
comprobar "queda conectada" igual "$CF_PANEL_CONECTADA" 1
reiniciar
conectar_cloudflare_autonoma >"$SALIDA" 2>&1
comprobar "sin token, no llama a nada" no_contiene "$REGISTRO" "cloudflare.js"

echo "# Token temporal y la API de Skyway no responde: se omite el panel sin interrumpir"
reiniciar
unset SKYWAY_TOKEN SKYWAY_URL
FAKE_SANA=""
# En un subshell: si volviera a llamar a fallo, terminaría la prueba entera.
(desplegar_en_skyway && echo "RESUMEN_SKYWAY=$RESUMEN_SKYWAY") >"$SALIDA" 2>&1
codigo=$?
comprobar "no interrumpe la instalación" igual "$codigo" 0
comprobar "prueba la IP del contenedor" contiene "$REGISTRO" "sky_api GET http://172.18.0.5:4000/api/health"
comprobar "revoca el token temporal" contiene "$REGISTRO" "TOKEN_TEMPORAL_REVOCADO"
comprobar "lo explica" contiene "$SALIDA" "no se despliega el panel"
comprobar "el resumen lo recoge" contiene "$SALIDA" "RESUMEN_SKYWAY=omitido"

echo "# La API solo responde en la IP del contenedor: se usa esa"
reiniciar
unset SKYWAY_TOKEN SKYWAY_URL
FAKE_SANA=http://172.18.0.5:4000
(desplegar_en_skyway) >"$SALIDA" 2>&1
comprobar "sigue con la API del contenedor" contiene "$REGISTRO" "sky_api GET http://172.18.0.5:4000/api/projects"

echo "# Con SKYWAY_TOKEN indicado, una API que no responde sí es un error"
reiniciar
FAKE_SANA=""
(SKYWAY_TOKEN=sky_indicado12345 && unset SKYWAY_URL && desplegar_en_skyway) >"$SALIDA" 2>&1
codigo=$?
comprobar "termina con código 1" igual "$codigo" 1
comprobar "con el motivo" contiene "$SALIDA" "Skyway no responde en http://127.0.0.1:4000"

echo "# Con SKYWAY_URL indicada no se prueba la IP del contenedor"
reiniciar
(unset SKYWAY_TOKEN && SKYWAY_URL=http://10.0.0.9:4000 && desplegar_en_skyway) >"$SALIDA" 2>&1
comprobar "solo consulta la URL indicada" no_contiene "$REGISTRO" "172.18.0.5"

# ------------------------------------- panel que Skyway ya despliega --
#
# Instalaciones anteriores a la 1.0: el panel se creó a mano en Skyway (proyecto
# «Correo», servicio «mailway»), con su clave maestra en el volumen /data y sin
# deploy/.env completo. El instalador debe actualizar ese panel sin duplicarlo
# ni cambiar su clave, y no tocar nunca el Mailway que despliegue un cliente.

FAKE_PANEL_ENV_BASE=$'NODE_ENV=production\nMAILWAY_DATA_DIR=/data\nPORT=4100\nSTALWART_URL=http://mailway-mail:8080\nSTALWART_ADMIN_PASSWORD=clave-motor-antigua\nMAILWAY_MAIL_HOSTNAME=mail.ejemplo.test\nMAILWAY_WEBMAIL_URL=https://webmail.ejemplo.test\nMAILWAY_PUBLIC_IP=203.0.113.7'
FAKE_CLAVE_VOLUMEN="clave-del-volumen-0123456789abcdef"
docker() {
  printf 'docker %s\n' "$*" >>"$REGISTRO"
  local ultimo=${*: -1}
  case "$*" in
    "ps --filter label=skyway.service --format {{.Names}}") printf '%s\n' "$FAKE_CONTENEDORES" ;;
    "ps -a --filter label=skyway.service --format {{.Names}}") printf '%s\n%s\n' "$FAKE_CONTENEDORES" "$FAKE_PARADOS" ;;
    *skyway.service*)
      case "$ultimo" in
        skyway-web-app) echo svc_web ;;
        skyway-correo-mailway | skyway-correo-mailway-2) echo svc_panel ;;
        skyway-otro-mailway) echo svc_otro ;;
        skyway-cliente-mailway) echo svc_cliente ;;
        *) return 1 ;;
      esac
      ;;
    *skyway.project*)
      case "$ultimo" in
        skyway-mailway-panel) echo prj_mailway_cli ;;
        skyway-correo-mailway) echo prj_correo ;;
        *) return 1 ;;
      esac
      ;;
    "exec skyway node server/dist/tools/token.js revocar"*) return 0 ;;
    "inspect --type container -f {{.State.Running}} "*)
      case " $FAKE_CONTENEDORES " in *[[:space:]]"$ultimo"[[:space:]]*) echo true ;; *) echo false ;; esac
      ;;
    "inspect --type container -f {{range .Config.Env}}{{println .}}{{end}} "*)
      case "$ultimo" in
        skyway-web-app) printf 'NODE_ENV=production\nPORT=3000\n' ;;
        *) printf '%s\n' "$FAKE_PANEL_ENV" ;;
      esac
      ;;
    "inspect --type container -f {{range \$k, \$v := .Config.Labels}}"*)
      # shellcheck disable=SC2016 # las comillas invertidas son literales: así las escribe Traefik
      printf '%s\n' 'skyway.service=svc_panel' \
        'traefik.http.routers.skyway-correo-mailway.rule=Host(`Correo.Ejemplo.test`) || Host(`otro.ejemplo.test`)'
      ;;
    "exec skyway-correo-mailway cat /data/.secret") printf '%s\n' "$FAKE_CLAVE_VOLUMEN" ;;
    "volume inspect mailway-mail-data") [ "$FAKE_VOLUMEN_MOTOR" = 1 ] ;;
    *)
      echo "docker no simulado: $*" >>"$REGISTRO"
      return 1
      ;;
  esac
}

# API de Skyway: el panel en el proyecto propio «Correo», una web en «Web» y
# un Mailway de un cliente en «Cliente» (workspace ws_cliente).
sky_api() {
  printf 'sky_api %s %s\n' "$1" "$SKYWAY_URL$2" >>"$REGISTRO"
  if [ -n "${3:-}" ]; then printf 'CUERPO %s %s %s\n' "$1" "$2" "$3" >>"$REGISTRO"; fi
  RESP_CODE=200
  case "$1 $2" in
    "GET /api/health") RESP_BODY='{"ok":true,"version":"0.34.0"}' ;;
    "GET /api/projects") RESP_BODY=$FAKE_PROYECTOS ;;
    "POST /api/projects") RESP_CODE=201 RESP_BODY='{"project":{"id":"prj_nuevo","slug":"mailway-2"}}' ;;
    "GET /api/projects/prj_mailway_cli") RESP_BODY='{"project":{"id":"prj_mailway_cli","slug":"mailway","name":"mailway","workspace_id":"ws_cliente"},"services":[{"id":"svc_mailway_cli","slug":"panel","name":"panel","type":"git","config":{"repoUrl":"https://github.com/NkrowOne/Mailway"}}]}' ;;
    "GET /api/projects/prj_mailway") RESP_BODY="{\"project\":{\"id\":\"prj_mailway\",\"slug\":\"mailway\",\"name\":\"mailway\",\"workspace_id\":null},\"services\":$FAKE_SERVICIOS_MAILWAY}" ;;
    "GET /api/projects/prj_web") RESP_BODY='{"project":{"id":"prj_web","slug":"web"},"services":[{"id":"svc_web","slug":"app","type":"git","config":{"repoUrl":"https://github.com/NkrowOne/codanuance"}}]}' ;;
    "GET /api/projects/prj_correo") RESP_BODY="{\"project\":{\"id\":\"prj_correo\",\"slug\":\"correo\"},\"services\":$FAKE_REPOS}" ;;
    "GET /api/projects/prj_cliente") RESP_BODY='{"project":{"id":"prj_cliente","slug":"cliente","workspace_id":"ws_cliente"},"services":[{"id":"svc_cliente","slug":"mailway","type":"git","config":{"repoUrl":"https://github.com/NkrowOne/Mailway"}}]}' ;;
    "GET /api/services/svc_panel") RESP_BODY='{"service":{"id":"svc_panel","slug":"mailway","name":"mailway","type":"git","config":{"volumes":[{"name":"skyway-correo-mailway-data","containerPath":"/data"}],"domains":["correo.ejemplo.test"]}},"project":{"id":"prj_correo","slug":"correo","name":"Correo","workspace_id":null}}' ;;
    "GET /api/services/svc_cliente") RESP_BODY='{"service":{"id":"svc_cliente","slug":"mailway","name":"mailway","type":"git","config":{}},"project":{"id":"prj_cliente","slug":"cliente","name":"Cliente","workspace_id":"ws_cliente"}}' ;;
    "GET /api/services/svc_panel/env") RESP_BODY=$FAKE_ENV_PANEL ;;
    "PUT /api/services/svc_panel/env" | "PATCH /api/services/svc_panel") RESP_BODY='{}' ;;
    "GET /api/domains/config") RESP_BODY='{"tls":true}' ;;
    "POST /api/services/svc_panel/deploy") RESP_CODE=202 RESP_BODY='{"deployment":{"id":"dep1"}}' ;;
    "GET /api/deployments/dep1") RESP_BODY='{"deployment":{"status":"success"}}' ;;
    *) RESP_CODE=404 RESP_BODY='{"error":"no simulado"}' ;;
  esac
}
sleep() { :; }
crear_token_temporal_skyway() {
  SKYWAY_TOKEN=sky_temporal12345
  SKY_TOKEN_TEMPORAL_ID=tok_tmp1
}
PROYECTOS_BASE='{"projects":[{"id":"prj_web","slug":"web","name":"Web","workspace_id":null},{"id":"prj_correo","slug":"correo","name":"Correo","workspace_id":null},{"id":"prj_cliente","slug":"cliente","name":"Cliente","workspace_id":"ws_cliente"}]}'

# Estado de cada escenario: sin panel detectado, sin deploy/.env, el panel de
# «Correo» en marcha con la clave en su volumen y el motor sin datos.
reiniciar_panel() {
  : >"$REGISTRO"
  PANEL_EXISTENTE_SERVICIO=""
  PANEL_EXISTENTE_CONTENEDOR=""
  PANEL_EXISTENTE_HOST=""
  PANEL_EXISTENTE_ENV=()
  PANEL_ADOPTADO=""
  PANEL_SIN_ADOPCION=0
  PANEL_RECHAZADO=""
  SKY_TOKEN_TEMPORAL_ID=""
  SKYWAY_URL_AUTOMATICA=0
  PANEL_CONTENEDOR=""
  TRAEFIK_TOKEN_PROPIO=1
  CON_SKYWAY=1
  INTERACTIVO=0
  ENV_FILE="$TMP/env-inexistente"
  rm -f "$ENV_FILE" "$ENV_FILE.anterior"
  ENV_COPIADO=0
  unset MAILWAY_PANEL_SERVICIO SKYWAY_TOKEN SKYWAY_URL STALWART_ADMIN_PASSWORD MAILWAY_IP
  FAKE_SANA=""
  FAKE_CONTENEDORES=$'skyway-web-app\nskyway-correo-mailway'
  FAKE_PARADOS=""
  FAKE_PANEL_ENV=$FAKE_PANEL_ENV_BASE
  FAKE_VOLUMEN_MOTOR=0
  FAKE_ENV_PANEL='{"vars":{"STALWART_URL":"http://mailway-mail:8080","MAILWAY_SMTP_ALLOW_SELF_SIGNED":"1","MI_VARIABLE":"se-conserva"}}'
  FAKE_REPOS='[{"id":"svc_panel","slug":"mailway","type":"git","config":{"repoUrl":"https://github.com/NkrowOne/Mailway.git"}}]'
  FAKE_PROYECTOS=$PROYECTOS_BASE
  FAKE_SERVICIOS_MAILWAY='[]'
}
# Lo que ya han fijado los pasos anteriores de la instalación.
datos_instalacion() {
  MAILWAY_SECRET=0123456789abcdef0123456789abcdef
  STALWART_ADMIN_PASSWORD=clave-motor-antigua
  MAILWAY_SETUP_TOKEN=s MAILWAY_TRAEFIK_TOKEN=t MAILWAY_WEBMAIL_TOKEN=w ROUNDCUBE_DES_KEY=d
  MAIL_HOSTNAME=mail.ejemplo.test WEBMAIL_HOSTNAME=webmail.ejemplo.test PANEL_HOSTNAME=correo.ejemplo.test
  IP_PUBLICA=203.0.113.7 INTERNAL_SUBNET=10.203.53.0/24 MAIL_INTERNAL_IP=10.203.53.10 CERT_CONFIGURADO=1
  MARCA=Correo LE_EMAIL=admin@ejemplo.test PANEL_INTERNAL_URL=http://skyway-correo-mailway:4100
  TRAEFIK_ACME_VOLUME="" MAILWAY_MAIL_VOLUME="" MAILWAY_WEBMAIL_DB_VOLUME="" MAILWAY_PANEL_VOLUME=""
  FAKE_SANA=http://127.0.0.1:4000
}
# Cuerpo del PUT de las variables del panel.
cuerpo_put() { grep '^CUERPO PUT /api/services/svc_panel/env ' "$REGISTRO" | sed 's/^CUERPO PUT [^ ]* //'; }
# Detecta como en una terminal, respondiendo $1 a la confirmación.
# (read -p solo muestra la pregunta con una terminal: las comprobaciones miran
# la línea que la presenta.)
detectar_respondiendo() {
  INTERACTIVO=1
  detectar_panel_existente <<<"$1"
  INTERACTIVO=0
}

echo "# Se reconoce el panel entre los contenedores de Skyway y se pide confirmación"
reiniciar_panel
detectar_respondiendo s >"$SALIDA" 2>&1
comprobar "lo presenta antes de preguntar" contiene "$SALIDA" "Skyway despliega un panel de Mailway: contenedor skyway-correo-mailway, https://correo.ejemplo.test."
comprobar "elige el servicio del panel" igual "$PANEL_EXISTENTE_SERVICIO" svc_panel
comprobar "y su contenedor" igual "$PANEL_EXISTENTE_CONTENEDOR" skyway-correo-mailway
comprobar "toma el dominio de la regla de Traefik" igual "$PANEL_EXISTENTE_HOST" correo.ejemplo.test
comprobar "lee la contraseña del motor de su entorno" igual "$(valor_panel STALWART_ADMIN_PASSWORD)" clave-motor-antigua
comprobar "no confunde la web del otro proyecto" no_contiene "$SALIDA" skyway-web-app
comprobar "comprueba de quién es el panel antes de usar nada suyo" contiene "$REGISTRO" "sky_api GET http://127.0.0.1:4000/api/services/svc_panel"

echo "# Quien instala dice que no es el suyo: no se usa nada de él"
reiniciar_panel
detectar_respondiendo n >"$SALIDA" 2>&1
comprobar "no lo adopta" igual "$PANEL_EXISTENTE_SERVICIO$PANEL_EXISTENTE_CONTENEDOR" ""
comprobar "olvida su entorno" igual "$(valor_panel STALWART_ADMIN_PASSWORD)" ""
comprobar "lo recuerda para no buscarlo por el repositorio" igual "$PANEL_SIN_ADOPCION" 1
localizar_panel_en_skyway https://github.com/NkrowOne/Mailway >/dev/null 2>&1
comprobar "y no lo busca por el repositorio" igual "$PANEL_ADOPTADO" ""

echo "# Sin terminal y sin que deploy/.env lo nombre: se detiene sin tocar nada"
reiniciar_panel
(detectar_panel_existente) >"$SALIDA" 2>&1
codigo=$?
comprobar "termina con código 1" igual "$codigo" 1
comprobar "explica cómo indicarlo" contiene "$SALIDA" "MAILWAY_PANEL_SERVICIO=svc_panel"
comprobar "y cómo no tocarlo" contiene "$SALIDA" "MAILWAY_PANEL_SERVICIO=ninguno"

echo "# El panel que nombra deploy/.env se adopta sin preguntar"
reiniciar_panel
printf 'MAILWAY_PANEL_INTERNAL_URL=http://skyway-correo-mailway:4100\n' >"$ENV_FILE"
detectar_panel_existente >"$SALIDA" 2>&1
comprobar "lo adopta" igual "$PANEL_EXISTENTE_SERVICIO" svc_panel
comprobar "sin preguntar" no_contiene "$SALIDA" "Skyway despliega un panel de Mailway: contenedor"
reiniciar_panel
printf 'PANEL_HOSTNAME=correo.ejemplo.test\n' >"$ENV_FILE"
detectar_panel_existente >"$SALIDA" 2>&1
comprobar "también por su dominio" igual "$PANEL_EXISTENTE_SERVICIO" svc_panel

echo "# El Mailway de un cliente no se toca"
reiniciar_panel
FAKE_CONTENEDORES="skyway-cliente-mailway"
(detectar_respondiendo s && echo "SERVICIO=$PANEL_EXISTENTE_SERVICIO" && echo "CLAVE=$(valor_panel STALWART_ADMIN_PASSWORD)") >"$SALIDA" 2>&1
comprobar "lo ignora" contiene "$SALIDA" "Se ignora el panel de Mailway del contenedor skyway-cliente-mailway"
comprobar "no lo adopta" tiene_linea "$SALIDA" "SERVICIO="
comprobar "ni pregunta" no_contiene "$SALIDA" "Skyway despliega un panel de Mailway: contenedor"
comprobar "ni usa su entorno" tiene_linea "$SALIDA" "CLAVE="
reiniciar_panel
SKYWAY_URL=http://127.0.0.1:4000
SKYWAY_TOKEN=sky_indicado12345
PANEL_EXISTENTE_SERVICIO=svc_cliente
(localizar_panel_en_skyway https://github.com/NkrowOne/Mailway) >"$SALIDA" 2>&1
codigo=$?
comprobar "la búsqueda por la API también lo rechaza" igual "$codigo" 1

echo "# MAILWAY_PANEL_SERVICIO=ninguno: no se adopta nada"
reiniciar_panel
MAILWAY_PANEL_SERVICIO=ninguno
detectar_panel_existente >"$SALIDA" 2>&1
comprobar "no adopta" igual "$PANEL_EXISTENTE_SERVICIO" ""
comprobar "ni busca contenedores" no_contiene "$REGISTRO" "docker ps"
unset MAILWAY_PANEL_SERVICIO

echo "# Clave maestra: la del volumen del panel, que es la que usa"
reiniciar_panel
# Un deploy/.env de una ejecución anterior con un token que el panel no usa.
printf 'MAILWAY_TRAEFIK_TOKEN=token-que-el-panel-no-usa\n' >"$ENV_FILE"
detectar_respondiendo s >/dev/null 2>&1
preparar_secretos >"$SALIDA" 2>&1
comprobar "lee la del volumen /data" igual "$MAILWAY_SECRET" "$FAKE_CLAVE_VOLUMEN"
comprobar "lo dice" contiene "$SALIDA" "Se conserva la clave maestra del panel"
comprobar "el token de Traefik no es suyo: no se inventa" igual "$MAILWAY_TRAEFIK_TOKEN:$TRAEFIK_TOKEN_PROPIO" ":0"
comprobar "motor sin datos: no usa la contraseña del panel" no_contiene <(printf '%s' "$STALWART_ADMIN_PASSWORD") clave-motor-antigua

echo "# Clave maestra en el entorno del panel: manda sobre deploy/.env"
reiniciar_panel
FAKE_PANEL_ENV+=$'\nMAILWAY_SECRET=clave-maestra-del-panel-0123456789\nMAILWAY_TRAEFIK_TOKEN=token-del-panel'
printf 'MAILWAY_SECRET=otra-clave-distinta-0123456789abcdef\n' >"$ENV_FILE"
FAKE_VOLUMEN_MOTOR=1
detectar_respondiendo s >/dev/null 2>&1
preparar_secretos >"$SALIDA" 2>&1
comprobar "usa la del panel" igual "$MAILWAY_SECRET" clave-maestra-del-panel-0123456789
comprobar "y su token de Traefik" igual "$MAILWAY_TRAEFIK_TOKEN:$TRAEFIK_TOKEN_PROPIO" "token-del-panel:1"
comprobar "motor con datos: reutiliza la contraseña del panel" igual "$STALWART_ADMIN_PASSWORD" clave-motor-antigua

echo "# Una clave del entorno de menos de 16 caracteres no cuenta (como en el panel)"
reiniciar_panel
FAKE_PANEL_ENV+=$'\nMAILWAY_SECRET=  corta  '
detectar_respondiendo s >/dev/null 2>&1
preparar_secretos >/dev/null 2>&1
comprobar "usa la del volumen" igual "$MAILWAY_SECRET" "$FAKE_CLAVE_VOLUMEN"

echo "# Panel parado: la clave no se puede leer y deploy/.env no guarda ninguna"
reiniciar_panel
FAKE_CONTENEDORES=""
FAKE_PARADOS="skyway-correo-mailway"
detectar_respondiendo s >/dev/null 2>&1
preparar_secretos >"$SALIDA" 2>&1
comprobar "no inventa una clave" igual "$MAILWAY_SECRET" ""
comprobar "lo explica" contiene "$SALIDA" "No se ha podido leer la clave maestra del panel"
(datos_instalacion; MAILWAY_SECRET="" MAILWAY_TRAEFIK_TOKEN=""; escribir_env >/dev/null 2>&1; cat "$ENV_FILE") >"$SALIDA" 2>&1
comprobar "deploy/.env lo anota sin valor" contiene "$SALIDA" "# MAILWAY_SECRET: el panel la guarda en su volumen /data."
comprobar "sin ninguna línea MAILWAY_SECRET=" no_contiene "$SALIDA" "MAILWAY_SECRET="
comprobar "ni MAILWAY_TRAEFIK_TOKEN=" no_contiene "$SALIDA" "MAILWAY_TRAEFIK_TOKEN="

echo "# Sin deploy/.env: los nombres y la IP salen del panel"
reiniciar_panel
detectar_respondiendo s >/dev/null 2>&1
(
  comprobar_subred() { :; }
  elegir_correo_admin() { ADMIN_EMAIL=admin@ejemplo.test; }
  recoger_datos >/dev/null 2>&1
  printf '%s %s %s %s %s\n' "$DOMINIO" "$MAIL_HOSTNAME" "$WEBMAIL_HOSTNAME" "$PANEL_HOSTNAME" "$IP_PUBLICA"
) >"$SALIDA" 2>&1
comprobar "propone el dominio, los nombres y la IP que ya usa" \
  igual "$(tail -n 1 "$SALIDA")" "ejemplo.test mail.ejemplo.test webmail.ejemplo.test correo.ejemplo.test 203.0.113.7"

echo "# Panel adoptado: se actualiza en su proyecto, sin crear otro ni darle clave ni token"
reiniciar_panel
detectar_respondiendo s >/dev/null 2>&1
datos_instalacion
(desplegar_en_skyway && echo "PANEL_CONTENEDOR=$PANEL_CONTENEDOR" && echo "ENV_SECRET=$(grep '^MAILWAY_SECRET=' "$ENV_FILE")") >"$SALIDA" 2>&1
comprobar "termina bien" contiene "$SALIDA" "Panel desplegado (skyway-correo-mailway)"
comprobar "usa el contenedor del panel existente" contiene "$SALIDA" "PANEL_CONTENEDOR=skyway-correo-mailway"
comprobar "no crea proyectos" no_contiene "$REGISTRO" "sky_api POST http://127.0.0.1:4000/api/projects"
comprobar "no crea servicios" no_contiene "$REGISTRO" "sky_api POST http://127.0.0.1:4000/api/projects/"
comprobar "no añade MAILWAY_SECRET a sus variables" no_contiene <(cuerpo_put) "MAILWAY_SECRET"
comprobar "ni MAILWAY_TRAEFIK_TOKEN" no_contiene <(cuerpo_put) "MAILWAY_TRAEFIK_TOKEN"
comprobar "conserva las variables puestas a mano" contiene <(cuerpo_put) '"MI_VARIABLE":"se-conserva"'
comprobar "actualiza las del instalador" contiene <(cuerpo_put) '"MAILWAY_WEBMAIL_TOKEN":"w"'
comprobar "retira MAILWAY_SMTP_ALLOW_SELF_SIGNED con certificado" no_contiene <(cuerpo_put) "MAILWAY_SMTP_ALLOW_SELF_SIGNED"
comprobar "deploy/.env guarda la clave que de verdad usa" contiene "$SALIDA" "ENV_SECRET=MAILWAY_SECRET='$FAKE_CLAVE_VOLUMEN'"
comprobar "despliega ese servicio" contiene "$REGISTRO" "sky_api POST http://127.0.0.1:4000/api/services/svc_panel/deploy"
comprobar "el PATCH conserva sus dominios y añade el del panel" \
  contiene "$REGISTRO" '"domains":["correo.ejemplo.test"'
comprobar "y dice de qué dominios parte (Skyway no devuelve los que otro quite entretanto)" \
  contiene "$REGISTRO" '"domainsBase":["correo.ejemplo.test"]'

echo "# Con el token temporal que ya creó la detección, no se pregunta por otro"
reiniciar_panel
detectar_respondiendo s >/dev/null 2>&1
comprobar "la detección deja la URL por defecto como automática" igual "$SKYWAY_URL_AUTOMATICA" 1
datos_instalacion
(INTERACTIVO=1 && desplegar_en_skyway <<<"n") >"$SALIDA" 2>&1
comprobar "termina bien aunque la respuesta no sea un token" contiene "$SALIDA" "Panel desplegado (skyway-correo-mailway)"
comprobar "sin pedir un token" no_contiene "$SALIDA" "El token de Skyway no es válido"

echo "# Si sus variables ya llevan clave y token, se conservan aunque deploy/.env diga otros"
reiniciar_panel
detectar_respondiendo s >/dev/null 2>&1
FAKE_ENV_PANEL='{"vars":{"MAILWAY_SECRET":"la-del-panel-0123456789abcdef","MAILWAY_TRAEFIK_TOKEN":"token-del-panel"}}'
datos_instalacion
(desplegar_en_skyway) >"$SALIDA" 2>&1
comprobar "envía su clave" contiene <(cuerpo_put) '"MAILWAY_SECRET":"la-del-panel-0123456789abcdef"'
comprobar "y su token" contiene <(cuerpo_put) '"MAILWAY_TRAEFIK_TOKEN":"token-del-panel"'
comprobar "y el resto de variables del instalador" contiene <(cuerpo_put) '"MAILWAY_WEBMAIL_TOKEN":"w"'
comprobar "no envía la clave de deploy/.env" no_contiene <(cuerpo_put) "0123456789abcdef0123456789abcdef"
comprobar "avisa de la diferencia" contiene "$SALIDA" "se conserva la del panel"

echo "# Sin contenedor (parado y retirado): se encuentra por el repositorio y se confirma"
reiniciar_panel
FAKE_CONTENEDORES="skyway-web-app"
detectar_panel_existente >/dev/null 2>&1
comprobar "no detecta contenedor" igual "$PANEL_EXISTENTE_SERVICIO" ""
SKYWAY_URL=http://127.0.0.1:4000
SKYWAY_TOKEN=sky_indicado12345
INTERACTIVO=1
localizar_panel_en_skyway https://github.com/NkrowOne/Mailway <<<"s" >"$SALIDA" 2>&1
INTERACTIVO=0
comprobar "pregunta con su nombre y su proyecto" contiene "$SALIDA" "en el servicio «mailway» del proyecto «Correo»"
comprobar "adopta el servicio propio (no el del cliente)" igual "$PANEL_ADOPTADO" "prj_correo correo svc_panel mailway"
comprobar "no mira el proyecto del cliente" no_contiene "$REGISTRO" "/api/projects/prj_cliente"
reiniciar_panel
FAKE_CONTENEDORES="skyway-web-app"
SKYWAY_URL=http://127.0.0.1:4000
SKYWAY_TOKEN=sky_indicado12345
(localizar_panel_en_skyway https://github.com/NkrowOne/Mailway) >"$SALIDA" 2>&1
codigo=$?
comprobar "sin terminal ni deploy/.env que lo nombre, se detiene" igual "$codigo" 1
comprobar "con el identificador para indicarlo" contiene "$SALIDA" "MAILWAY_PANEL_SERVICIO=svc_panel"
reiniciar_panel
FAKE_CONTENEDORES="skyway-web-app"
printf 'PANEL_HOSTNAME=correo.ejemplo.test\n' >"$ENV_FILE"
SKYWAY_URL=http://127.0.0.1:4000
SKYWAY_TOKEN=sky_indicado12345
localizar_panel_en_skyway https://github.com/NkrowOne/Mailway >"$SALIDA" 2>&1
comprobar "con su dominio en deploy/.env, sin preguntar" igual "$PANEL_ADOPTADO" "prj_correo correo svc_panel mailway"

echo "# Dos servicios propios despliegan el repositorio: se pide cuál, sin tocar nada"
reiniciar_panel
FAKE_REPOS='[{"id":"svc_panel","slug":"mailway","type":"git","config":{"repoUrl":"github.com/nkrowone/mailway/"}},{"id":"svc_copia","slug":"copia","type":"git","config":{"repoUrl":"git@github.com:NkrowOne/Mailway.git"}}]'
SKYWAY_URL=http://127.0.0.1:4000
SKYWAY_TOKEN=sky_indicado12345
(localizar_panel_en_skyway https://github.com/NkrowOne/Mailway) >"$SALIDA" 2>&1
codigo=$?
comprobar "termina con código 1" igual "$codigo" 1
comprobar "lista los dos" contiene "$SALIDA" "servicio «copia» del proyecto «correo» (id svc_copia)"
comprobar "explica cómo elegir" contiene "$SALIDA" "MAILWAY_PANEL_SERVICIO"

echo "# El proyecto «mailway» de un cliente no se usa: se crea uno propio"
reiniciar_panel
FAKE_PROYECTOS='{"projects":[{"id":"prj_mailway_cli","slug":"mailway","name":"mailway","workspace_id":"ws_cliente"},{"id":"prj_web","slug":"web","name":"Web","workspace_id":null}]}'
PANEL_SIN_ADOPCION=1
datos_instalacion
(desplegar_en_skyway) >"$SALIDA" 2>&1
comprobar "crea un proyecto propio" contiene "$REGISTRO" "sky_api POST http://127.0.0.1:4000/api/projects"
comprobar "no toca el del cliente" no_contiene "$REGISTRO" "prj_mailway_cli"
comprobar "ni su servicio" no_contiene "$REGISTRO" "svc_mailway_cli"

echo "# El servicio «panel» que se dijo que no es el de esta instalación no se reutiliza por su nombre"
reiniciar_panel
FAKE_PROYECTOS='{"projects":[{"id":"prj_mailway","slug":"mailway","name":"mailway","workspace_id":null}]}'
FAKE_SERVICIOS_MAILWAY='[{"id":"svc_rechazado","slug":"panel","name":"panel","type":"git","config":{"repoUrl":"https://github.com/NkrowOne/Mailway"}}]'
PANEL_SIN_ADOPCION=1
PANEL_RECHAZADO=svc_rechazado
datos_instalacion
(desplegar_en_skyway) >"$SALIDA" 2>&1
codigo=$?
comprobar "se detiene" igual "$codigo" 1
comprobar "lo explica" contiene "$SALIDA" "es el que has dicho que no es de esta instalación"
comprobar "sin tocar sus variables" no_contiene "$REGISTRO" "svc_rechazado/env"

echo "# Un servicio «panel» que no despliega Mailway no se toma por el panel"
reiniciar_panel
FAKE_PROYECTOS='{"projects":[{"id":"prj_mailway","slug":"mailway","name":"mailway","workspace_id":null}]}'
FAKE_SERVICIOS_MAILWAY='[{"id":"svc_otra_web","slug":"panel","name":"panel","type":"git","config":{"repoUrl":"https://github.com/alguien/otra-web"}}]'
FAKE_REPOS='[]'
datos_instalacion
(desplegar_en_skyway) >"$SALIDA" 2>&1
codigo=$?
comprobar "se detiene" igual "$codigo" 1
comprobar "lo explica" contiene "$SALIDA" "no despliega https://github.com/NkrowOne/Mailway"
comprobar "sin tocar sus variables" no_contiene "$REGISTRO" "svc_otra_web/env"

echo "# El contenedor del panel por defecto de un cliente no recibe las contraseñas del webmail"
reiniciar_panel
contenedor_de_cliente skyway-mailway-panel
comprobar "reconoce el de un cliente" igual "$?" 0
contenedor_de_cliente skyway-correo-mailway
comprobar "y el propio" igual "$?" 1

echo "# Sin panel en ningún sitio: instalación nueva en el proyecto «mailway»"
reiniciar_panel
FAKE_REPOS='[]'
SKYWAY_URL=http://127.0.0.1:4000
SKYWAY_TOKEN=sky_indicado12345
localizar_panel_en_skyway https://github.com/NkrowOne/Mailway >"$SALIDA" 2>&1
comprobar "no adopta nada" igual "$PANEL_ADOPTADO" ""

echo "# Varios paneles propios en contenedores: se pide cuál"
reiniciar_panel
FAKE_CONTENEDORES=$'skyway-correo-mailway\nskyway-otro-mailway'
(detectar_respondiendo s) >"$SALIDA" 2>&1
codigo=$?
comprobar "termina con código 1" igual "$codigo" 1
comprobar "explica cómo elegir" contiene "$SALIDA" "MAILWAY_PANEL_SERVICIO=<servicio>"

echo "# Réplicas del mismo servicio: es un solo panel"
reiniciar_panel
FAKE_CONTENEDORES=$'skyway-correo-mailway\nskyway-correo-mailway-2'
(detectar_respondiendo s && echo "SERVICIO=$PANEL_EXISTENTE_SERVICIO") >"$SALIDA" 2>&1
comprobar "lo reconoce" contiene "$SALIDA" "SERVICIO=svc_panel"

echo "# El panel en marcha manda sobre un panel parado de otro servicio"
reiniciar_panel
FAKE_CONTENEDORES="skyway-correo-mailway"
FAKE_PARADOS="skyway-otro-mailway"
(detectar_respondiendo s && echo "SERVICIO=$PANEL_EXISTENTE_SERVICIO") >"$SALIDA" 2>&1
comprobar "elige el que está en marcha" contiene "$SALIDA" "SERVICIO=svc_panel"

echo "# Ninguno en marcha: se reconoce el parado"
reiniciar_panel
FAKE_CONTENEDORES=""
FAKE_PARADOS="skyway-otro-mailway"
(detectar_respondiendo s && echo "SERVICIO=$PANEL_EXISTENTE_SERVICIO") >"$SALIDA" 2>&1
comprobar "lo encuentra" contiene "$SALIDA" "SERVICIO=svc_otro"

echo "# Indicado con MAILWAY_PANEL_SERVICIO: sin preguntar"
reiniciar_panel
FAKE_CONTENEDORES=$'skyway-correo-mailway\nskyway-otro-mailway'
MAILWAY_PANEL_SERVICIO=svc_otro
detectar_panel_existente >"$SALIDA" 2>&1
comprobar "usa el indicado" igual "$PANEL_EXISTENTE_CONTENEDOR" skyway-otro-mailway
comprobar "sin preguntar" no_contiene "$SALIDA" "Skyway despliega un panel de Mailway: contenedor"
MAILWAY_PANEL_SERVICIO='../x'
(detectar_panel_existente) >"$SALIDA" 2>&1
comprobar "rechaza un identificador no válido" contiene "$SALIDA" "no es un identificador de servicio de Skyway válido"
unset MAILWAY_PANEL_SERVICIO

echo "# El token de Cloudflare nunca se escribe en deploy/.env y el resumen dice qué quedó conectado"
reiniciar_panel
(datos_instalacion; CF_TOKEN=$TOKEN_CF; escribir_env >/dev/null 2>&1)
comprobar "deploy/.env existe" test -s "$ENV_FILE"
comprobar "sin el token de Cloudflare" no_contiene "$ENV_FILE" "$TOKEN_CF"
(
  datos_instalacion
  CON_SKYWAY=1 RESUMEN_SKYWAY=x RESUMEN_EMPAREJADO=x RESUMEN_DNS=x RESUMEN_PTR=x RESUMEN_P25=x RESUMEN_CERT=x
  EMPAREJADO_ADMIN_EMAIL=admin@ejemplo.test EMPAREJADO_OK=1 PANEL_CONTENEDOR=panel-c
  CF_PANEL_CONECTADA=1 RESUMEN_CF_PANEL="cuenta de la instancia conectada («Instalador de Mailway», 3 zonas)"
  RESUMEN_CF_SKYWAY="token guardado"
  resumen
) >"$SALIDA" 2>&1
comprobar "el resumen nombra la cuenta del panel" contiene "$SALIDA" "Cloudflare (panel):  cuenta de la instancia conectada («Instalador de Mailway», 3 zonas)"
comprobar "y la de Skyway" contiene "$SALIDA" "Cloudflare (Skyway): token guardado"
comprobar "no manda conectarla a mano" no_contiene "$SALIDA" "conecta una cuenta para publicar el DNS"
(
  datos_instalacion
  CON_SKYWAY=1 RESUMEN_SKYWAY=x RESUMEN_EMPAREJADO=x RESUMEN_DNS=x RESUMEN_PTR=x RESUMEN_P25=x RESUMEN_CERT=x
  EMPAREJADO_ADMIN_EMAIL=admin@ejemplo.test EMPAREJADO_OK=1 PANEL_CONTENEDOR=panel-c
  CF_PANEL_CONECTADA=0 RESUMEN_CF_PANEL="" RESUMEN_CF_SKYWAY=""
  resumen
) >"$SALIDA" 2>&1
comprobar "sin cuenta conectada, sí lo manda" contiene "$SALIDA" "conecta una cuenta para publicar el DNS"
comprobar "y no hay línea de Cloudflare" no_contiene "$SALIDA" "Cloudflare (panel)"
(
  datos_instalacion
  CON_SKYWAY=1 RESUMEN_SKYWAY=x RESUMEN_EMPAREJADO=x RESUMEN_DNS=x RESUMEN_PTR=x RESUMEN_P25=x RESUMEN_CERT=x
  EMPAREJADO_ADMIN_EMAIL=admin@ejemplo.test EMPAREJADO_OK=1 PANEL_CONTENEDOR=panel-c ACTUALIZAR=1
  CF_PANEL_CONECTADA=0 RESUMEN_CF_PANEL="" RESUMEN_CF_SKYWAY="" CF_TOKEN=""
  cloudflare_sin_token
  resumen
) >"$SALIDA" 2>&1
comprobar "--actualizar sin token: no afirma que haya una cuenta" no_contiene "$SALIDA" "la cuenta ya conectada se conserva"
comprobar "y mantiene el paso de Conexiones → Cloudflare" contiene "$SALIDA" "En Conexiones → Cloudflare, comprueba que hay una cuenta conectada"

# --------------------------------------------- registros de la plataforma --

# API de Cloudflare simulada para cf_registro: el GET devuelve los registros
# de FAKE_CF_EXISTENTES; cualquier escritura queda en el registro.
FAKE_CF_EXISTENTES='[]'
cf_api() {
  printf 'cf_api %s %s %s\n' "$1" "$2" "${3:-}" >>"$REGISTRO"
  RESP_CODE=200
  case "$1" in
    GET) RESP_BODY="{\"success\":true,\"result\":$FAKE_CF_EXISTENTES}" ;;
    *) RESP_BODY='{"success":true,"result":{"id":"nuevo"}}' ;;
  esac
}
escrituras_cf() { grep -E '^cf_api (POST|PUT|PATCH|DELETE) ' "$REGISTRO" || true; }
CF_ZONA_ID=zona1
A_OTRA_IP='[{"id":"rec1","type":"A","name":"mail.ejemplo.test","content":"198.51.100.9","proxied":false}]'
A_CON_PROXY='[{"id":"rec1","type":"A","name":"mail.ejemplo.test","content":"203.0.113.7","proxied":true}]'
CNAME_AJENO='[{"id":"rec2","type":"CNAME","name":"autodiscover.ejemplo.test","content":"autodiscover.outlook.com","proxied":false}]'
CNAME_PROPIO_CON_PROXY='[{"id":"rec3","type":"CNAME","name":"autoconfig.ejemplo.test","content":"mail.ejemplo.test","proxied":true}]'

echo "# Sin terminal, un registro de la plataforma que ya existe no se modifica"
for caso in "$A_OTRA_IP" "$A_CON_PROXY"; do
  : >"$REGISTRO"
  FAKE_CF_EXISTENTES=$caso
  (INTERACTIVO=0 && unset MAILWAY_DNS_REEMPLAZAR && cf_registro A mail.ejemplo.test 203.0.113.7 s) >"$SALIDA" 2>&1
  comprobar "no escribe nada en Cloudflare" igual "$(escrituras_cf)" ""
  comprobar "lo informa como conflicto" contiene "$SALIDA" "no se modifica sin confirmación"
done
comprobar "y explica el proxy" contiene "$SALIDA" "tiene el proxy de Cloudflare activado"

echo "# Sin terminal y con MAILWAY_DNS_REEMPLAZAR=1: solo los A de la plataforma, nunca un autodiscover ajeno"
: >"$REGISTRO"
FAKE_CF_EXISTENTES=$A_OTRA_IP
(INTERACTIVO=0 && MAILWAY_DNS_REEMPLAZAR=1 && cf_registro A mail.ejemplo.test 203.0.113.7 s) >"$SALIDA" 2>&1
comprobar "cambia el A" contiene <(escrituras_cf) "cf_api PUT /zones/zona1/dns_records/rec1"
: >"$REGISTRO"
FAKE_CF_EXISTENTES=$CNAME_AJENO
(INTERACTIVO=0 && MAILWAY_DNS_REEMPLAZAR=1 && cf_registro CNAME autodiscover.ejemplo.test mail.ejemplo.test n) >"$SALIDA" 2>&1
comprobar "no toca el autodiscover de otro proveedor" igual "$(escrituras_cf)" ""
# Mismo destino y solo el proxy distinto: con terminal se propone quitarlo,
# pero sin ella un CNAME de autoconfiguración tampoco se modifica.
: >"$REGISTRO"
FAKE_CF_EXISTENTES=$CNAME_PROPIO_CON_PROXY
(INTERACTIVO=0 && MAILWAY_DNS_REEMPLAZAR=1 && cf_registro CNAME autoconfig.ejemplo.test mail.ejemplo.test n) >"$SALIDA" 2>&1
comprobar "ni le quita el proxy a un CNAME de autoconfiguración" igual "$(escrituras_cf)" ""
comprobar "lo informa como conflicto" contiene "$SALIDA" "no se modifica sin confirmación"

echo "# Con terminal se pregunta, también para quitar el proxy"
: >"$REGISTRO"
FAKE_CF_EXISTENTES=$A_CON_PROXY
(INTERACTIVO=1 && cf_registro A mail.ejemplo.test 203.0.113.7 s <<<"n") >"$SALIDA" 2>&1
comprobar "respondiendo que no, no escribe nada" igual "$(escrituras_cf)" ""
comprobar "lo deja como está" contiene "$SALIDA" "se deja como está"
: >"$REGISTRO"
(INTERACTIVO=1 && cf_registro A mail.ejemplo.test 203.0.113.7 s <<<"s") >"$SALIDA" 2>&1
comprobar "respondiendo que sí, quita el proxy" contiene <(escrituras_cf) '"proxied":false'

echo "# Lo que falta se crea siempre, también sin terminal"
: >"$REGISTRO"
FAKE_CF_EXISTENTES='[]'
(INTERACTIVO=0 && cf_registro A webmail.ejemplo.test 203.0.113.7 s) >"$SALIDA" 2>&1
comprobar "lo crea" contiene <(escrituras_cf) "cf_api POST /zones/zona1/dns_records"
comprobar "sin proxy" contiene <(escrituras_cf) '"proxied":false'

echo "# Instalación autónoma: no se busca nada en Skyway"
reiniciar_panel
CON_SKYWAY=0
detectar_panel_existente >"$SALIDA" 2>&1
comprobar "no consulta Docker" no_contiene "$REGISTRO" "docker ps"

# ------------------------------------------- nombres e IP de la plataforma --

# deploy/.env de una instalación anterior con el dominio ejemplo.test.
env_anterior() {
  cat >"$ENV_FILE" <<'ENV'
MAILWAY_INSTALACION='skyway'
MAIL_HOSTNAME='mail.ejemplo.test'
WEBMAIL_HOSTNAME='webmail.ejemplo.test'
PANEL_HOSTNAME='panel.ejemplo.test'
MAILWAY_PUBLIC_IP='203.0.113.7'
LETSENCRYPT_EMAIL='admin@ejemplo.test'
MAILWAY_ADMIN_EMAIL='admin@ejemplo.test'
ENV
}
# recoger_datos como el instalador (con set -e) y lo que deja, en $SALIDA.
datos_con() {
  (
    set -e
    comprobar_subred() { :; }
    elegir_correo_admin() { ADMIN_EMAIL=admin@ejemplo.test; }
    recoger_datos
    echo "NOMBRES=$MAIL_HOSTNAME $WEBMAIL_HOSTNAME $PANEL_HOSTNAME"
    echo "IP=$IP_PUBLICA"
    echo "ADOPTAR=$ADOPTAR_EN_PANEL"
    echo "ANTERIOR=$MAIL_HOSTNAME_ANTERIOR"
  ) >"$SALIDA" 2>&1
  CODIGO=$?
}
reiniciar_datos() {
  reiniciar_panel
  FAKE_IP_DETECTADA=203.0.113.7
  FAKE_IP_LOCAL=1
  unset MAILWAY_DOMINIO MAILWAY_CAMBIAR_NOMBRES MAILWAY_MAIL_HOST MAILWAY_WEBMAIL_HOST MAILWAY_PANEL_HOST
  env_anterior
}

echo "# Con los mismos nombres y la misma IP no se pide nada ni se adopta nada"
reiniciar_datos
datos_con
comprobar "termina bien" igual "$CODIGO" 0
comprobar "conserva los nombres" contiene "$SALIDA" "NOMBRES=mail.ejemplo.test webmail.ejemplo.test panel.ejemplo.test"
comprobar "no habla de un cambio de nombres" no_contiene "$SALIDA" "Cambio de los nombres"
comprobar "el panel no tiene nada que adoptar" tiene_linea "$SALIDA" "ADOPTAR="

echo "# Otro dominio sin terminal: se detiene sin tocar nada y dice cómo confirmarlo"
reiniciar_datos
cp "$ENV_FILE" "$TMP/env-antes"
MAILWAY_DOMINIO=nuevo.test datos_con
comprobar "termina con código 1" igual "$CODIGO" 1
comprobar "resume lo que cambia" contiene "$SALIDA" "Servidor de correo: mail.ejemplo.test → mail.nuevo.test"
comprobar "y lo que supone para los clientes" contiene "$SALIDA" "tendrán que apuntar su MX"
comprobar "dice cómo confirmarlo" contiene "$SALIDA" "MAILWAY_CAMBIAR_NOMBRES=1"
comprobar "deploy/.env no cambia" cmp -s "$ENV_FILE" "$TMP/env-antes"

echo "# Otro dominio con MAILWAY_CAMBIAR_NOMBRES=1: los tres nombres pasan al nuevo y el panel los adopta"
reiniciar_datos
MAILWAY_DOMINIO=nuevo.test MAILWAY_CAMBIAR_NOMBRES=1 datos_con
comprobar "termina bien" igual "$CODIGO" 0
comprobar "nombres nuevos" contiene "$SALIDA" "NOMBRES=mail.nuevo.test webmail.nuevo.test panel.nuevo.test"
comprobar "el panel los adopta aunque se cambiaran a mano" tiene_linea "$SALIDA" "ADOPTAR=servidor,webmail,panel"
comprobar "recuerda el nombre anterior del servidor" contiene "$SALIDA" "ANTERIOR=mail.ejemplo.test"
comprobar "dice que el panel anterior se conserva en Skyway" contiene "$SALIDA" "panel.ejemplo.test se conserva en Skyway"

echo "# Con terminal se pregunta, y por defecto no se cambia nada"
reiniciar_datos
INTERACTIVO=1 datos_con <<<$'nuevo.test\n\n'
comprobar "termina con código 1" igual "$CODIGO" 1
comprobar "no ha cambiado nada" contiene "$SALIDA" "No se ha cambiado nada"
reiniciar_datos
INTERACTIVO=1 datos_con <<<$'nuevo.test\ns\n\n\n\n'
comprobar "respondiendo que sí, sigue" igual "$CODIGO" 0
comprobar "con los nombres nuevos" contiene "$SALIDA" "NOMBRES=mail.nuevo.test webmail.nuevo.test panel.nuevo.test"

echo "# Solo cambia el nombre del webmail: solo se adopta ese"
reiniciar_datos
MAILWAY_WEBMAIL_HOST=correo-web.ejemplo.test MAILWAY_CAMBIAR_NOMBRES=1 datos_con
comprobar "termina bien" igual "$CODIGO" 0
comprobar "adopta solo el webmail" tiene_linea "$SALIDA" "ADOPTAR=webmail"
comprobar "sin nombre anterior del servidor" tiene_linea "$SALIDA" "ANTERIOR="
comprobar "avisa de que el anterior deja de responder" contiene "$SALIDA" "webmail.ejemplo.test deja de responder"

echo "# IP guardada que no es la del servidor, sin terminal: se detiene y propone las dos salidas"
reiniciar_datos
FAKE_IP_DETECTADA=198.51.100.99
datos_con
comprobar "termina con código 1" igual "$CODIGO" 1
comprobar "nombra las dos IP" contiene "$SALIDA" "La IP guardada (203.0.113.7) no es la de este servidor, que sale a Internet con 198.51.100.99"
comprobar "propone la detectada" contiene "$SALIDA" "MAILWAY_IP=198.51.100.99"
comprobar "y conservar la guardada" contiene "$SALIDA" "MAILWAY_IP=203.0.113.7"

echo "# Con terminal se avisa y se propone la detectada, que el panel adopta"
reiniciar_datos
FAKE_IP_DETECTADA=198.51.100.99
INTERACTIVO=1 datos_con <<<$'\n\n\n\n'
comprobar "termina bien" igual "$CODIGO" 0
comprobar "lo avisa" contiene "$SALIDA" "La IP guardada (203.0.113.7) no es la de este servidor"
comprobar "elige la detectada por defecto" contiene "$SALIDA" "IP=198.51.100.99"
comprobar "el panel la adopta" tiene_linea "$SALIDA" "ADOPTAR=ip"

echo "# Con MAILWAY_IP manda la indicada y no se detecta nada"
reiniciar_datos
FAKE_IP_DETECTADA=198.51.100.99
MAILWAY_IP=203.0.113.7 datos_con
comprobar "termina bien" igual "$CODIGO" 0
comprobar "usa la indicada" contiene "$SALIDA" "IP=203.0.113.7"
comprobar "sin consultar la IP de salida" no_contiene "$REGISTRO" "DETECTAR_IP"
comprobar "sin nada que adoptar" tiene_linea "$SALIDA" "ADOPTAR="

echo "# La IP guardada sigue siendo de una interfaz del servidor: se conserva con un aviso"
reiniciar_datos
FAKE_IP_DETECTADA=198.51.100.99
FAKE_IP_LOCAL=0
datos_con
comprobar "termina bien" igual "$CODIGO" 0
comprobar "conserva la guardada" contiene "$SALIDA" "IP=203.0.113.7"
comprobar "avisa de la IP de salida" contiene "$SALIDA" "sale a Internet con 198.51.100.99, no con 203.0.113.7"

echo "# Sin poder detectar la IP se usa la guardada"
reiniciar_datos
FAKE_IP_DETECTADA=""
datos_con
comprobar "termina bien" igual "$CODIGO" 0
comprobar "usa la guardada" contiene "$SALIDA" "IP=203.0.113.7"
comprobar "lo dice" contiene "$SALIDA" "No se ha podido detectar la IP pública"

echo "# Un A que ya apunta a la IP de este servidor no se devuelve a la guardada"
: >"$REGISTRO"
FAKE_CF_EXISTENTES=$A_OTRA_IP
(IP_DETECTADA=198.51.100.9 && INTERACTIVO=0 && MAILWAY_DNS_REEMPLAZAR=1 && cf_registro A mail.ejemplo.test 203.0.113.7 s) >"$SALIDA" 2>&1
comprobar "sin terminal no escribe nada, ni con MAILWAY_DNS_REEMPLAZAR=1" igual "$(escrituras_cf)" ""
comprobar "explica por qué" contiene "$SALIDA" "la IP con la que este servidor sale a Internet"
comprobar "sin proponer MAILWAY_DNS_REEMPLAZAR, que no lo cambiaría" no_contiene "$SALIDA" "MAILWAY_DNS_REEMPLAZAR=1"
: >"$REGISTRO"
(IP_DETECTADA=198.51.100.9 && INTERACTIVO=1 && cf_registro A mail.ejemplo.test 203.0.113.7 s <<<"") >"$SALIDA" 2>&1
comprobar "con terminal, la respuesta por defecto es no" igual "$(escrituras_cf)" ""
: >"$REGISTRO"
(IP_DETECTADA=203.0.113.7 && INTERACTIVO=0 && MAILWAY_DNS_REEMPLAZAR=1 && cf_registro A mail.ejemplo.test 203.0.113.7 s) >"$SALIDA" 2>&1
comprobar "a la IP de este servidor sí lo mueve (mudanza)" contiene <(escrituras_cf) "cf_api PUT /zones/zona1/dns_records/rec1"

# ------------------------------------------ identidad del servidor en el panel --

FAKE_IDENTIDAD=1
FAKE_IDENTIDAD_SALIDA='{"cambios":[{"campo":"servidor","antes":"mail.ejemplo.test","despues":"mail.nuevo.test"}]}'
docker() {
  printf 'docker %s\n' "$*" >>"$REGISTRO"
  case "$*" in
    "exec panel-c test -f server/dist/tools/identidad.js") [ "$FAKE_IDENTIDAD" = 1 ] ;;
    "exec -u node panel-c node server/dist/tools/identidad.js --adoptar "*)
      echo "Aviso: algo que contar" >&2
      printf '%s\n' "$FAKE_IDENTIDAD_SALIDA"
      ;;
    *)
      echo "docker no simulado: $*" >>"$REGISTRO"
      return 1
      ;;
  esac
}

echo "# Sin cambio confirmado, no se llama a la herramienta de identidad"
: >"$REGISTRO"
(ADOPTAR_EN_PANEL="" && adoptar_identidad_en_panel panel-c && echo "RESUMEN=$RESUMEN_IDENTIDAD") >"$SALIDA" 2>&1
comprobar "no llama a nada" no_contiene "$REGISTRO" "identidad.js"
comprobar "sin línea en el resumen" contiene "$SALIDA" "RESUMEN="

echo "# Con el cambio confirmado, el panel adopta lo indicado"
: >"$REGISTRO"
(ADOPTAR_EN_PANEL=servidor,webmail && adoptar_identidad_en_panel panel-c && echo "RESUMEN=$RESUMEN_IDENTIDAD") >"$SALIDA" 2>&1
comprobar "pasa la lista a --adoptar" contiene "$REGISTRO" "docker exec -u node panel-c node server/dist/tools/identidad.js --adoptar servidor,webmail"
comprobar "como el usuario del panel" contiene "$REGISTRO" "exec -u node panel-c"
comprobar "muestra los avisos de la herramienta" contiene "$SALIDA" "[aviso] algo que contar"
comprobar "el resumen dice qué ha cambiado" contiene "$SALIDA" "RESUMEN=adoptada en Ajustes del panel (mail.ejemplo.test → mail.nuevo.test)"

echo "# Un panel sin la herramienta: se dice que se revise a mano"
: >"$REGISTRO"
FAKE_IDENTIDAD=0
(ADOPTAR_EN_PANEL=servidor && adoptar_identidad_en_panel panel-c && echo "RESUMEN=$RESUMEN_IDENTIDAD") >"$SALIDA" 2>&1
comprobar "queda pendiente" contiene "$SALIDA" "RESUMEN=pendiente"
comprobar "y dónde revisarla" contiene "$SALIDA" "Ajustes → Identidad del servidor"
FAKE_IDENTIDAD=1

# ------------------------------------------------------------- DNS inverso --

# curl simulado para las consultas DoH: la respuesta de cada resolutor, o
# «falla» si no responde.
FAKE_DOH_CF=falla
FAKE_DOH_GOOGLE=falla
curl() {
  local url=${*: -1}
  printf 'curl %s\n' "$url" >>"$REGISTRO"
  local respuesta
  case "$url" in
    https://cloudflare-dns.com/*) respuesta=$FAKE_DOH_CF ;;
    https://dns.google/*) respuesta=$FAKE_DOH_GOOGLE ;;
    *) return 7 ;;
  esac
  [ "$respuesta" != falla ] || return 7
  printf '%s' "$respuesta"
}
ptr_con() {
  FAKE_DOH_CF=$1
  FAKE_DOH_GOOGLE=$2
  : >"$REGISTRO"
  (IP_PUBLICA=203.0.113.7 && MAIL_HOSTNAME=mail.ejemplo.test && comprobar_ptr && echo "PTR=$RESUMEN_PTR") >"$SALIDA" 2>&1
}
PTR_BIEN='{"Status":0,"Answer":[{"name":"7.113.0.203.in-addr.arpa.","type":12,"data":"Mail.Ejemplo.TEST."}]}'

echo "# PTR: si ningún resolutor responde, no se da por «sin configurar»"
ptr_con falla falla
comprobar "dice que no se ha podido comprobar" contiene "$SALIDA" "PTR=sin comprobar: ningún resolutor ha respondido"
comprobar "no manda pedírselo al proveedor" no_contiene "$SALIDA" "SIN CONFIGURAR"
comprobar "prueba los dos resolutores" contiene "$REGISTRO" "https://dns.google/resolve?name=7.113.0.203.in-addr.arpa&type=PTR"

echo "# PTR: si el primero falla responde el segundo; sin distinguir mayúsculas ni el punto final"
ptr_con falla "$PTR_BIEN"
comprobar "correcto" contiene "$SALIDA" "PTR=correcto (203.0.113.7 → mail.ejemplo.test)"

echo "# PTR: un SERVFAIL no cuenta como respuesta"
ptr_con '{"Status":2}' "$PTR_BIEN"
comprobar "usa el segundo resolutor" contiene "$SALIDA" "PTR=correcto"

echo "# PTR: el nombre no existe (NXDOMAIN)"
ptr_con '{"Status":3}' falla
comprobar "sin configurar" contiene "$SALIDA" "PTR=SIN CONFIGURAR: pide al proveedor del servidor el DNS inverso 203.0.113.7 → mail.ejemplo.test"

echo "# PTR: delegación con CNAME (RFC 2317) y otro nombre"
ptr_con '{"Status":0,"Answer":[{"type":5,"data":"7.0-25.113.0.203.in-addr.arpa."},{"type":12,"data":"vps-1.proveedor.test."}]}' falla
comprobar "incorrecto, con el PTR y no el CNAME" contiene "$SALIDA" "PTR=INCORRECTO: 203.0.113.7 → vps-1.proveedor.test (debe ser mail.ejemplo.test"
unset -f curl

# ----------------------------------------------------- imágenes y resumen --

echo "# --actualizar sin poder descargar las imágenes: avisa y queda en el resumen"
: >"$REGISTRO"
compose() {
  printf 'compose %s\n' "$*" >>"$REGISTRO"
  echo "Error response from daemon: toomanyrequests" >&2
  return 1
}
(descargar_imagenes --profile proxy && echo "IMAGENES=$RESUMEN_IMAGENES") >"$SALIDA" 2>&1
comprobar "lo intenta con --ignore-buildable" tiene_linea "$REGISTRO" "compose --profile proxy pull --quiet --ignore-buildable"
comprobar "y sin él" tiene_linea "$REGISTRO" "compose --profile proxy pull --quiet"
comprobar "avisa" contiene "$SALIDA" "No se han podido descargar las imágenes nuevas"
comprobar "queda en el resumen" contiene "$SALIDA" "IMAGENES=NO DESCARGADAS"
compose() { printf 'compose %s\n' "$*" >>"$REGISTRO"; }
(descargar_imagenes && echo "IMAGENES=$RESUMEN_IMAGENES") >"$SALIDA" 2>&1
comprobar "si se descargan, se dice" contiene "$SALIDA" "IMAGENES=descargadas las últimas versiones"
unset -f compose

resumen_con() {
  (
    datos_instalacion
    CON_SKYWAY=1 RESUMEN_SKYWAY=x RESUMEN_EMPAREJADO=x RESUMEN_DNS=x RESUMEN_PTR=x RESUMEN_CERT=x
    EMPAREJADO_ADMIN_EMAIL=admin@ejemplo.test EMPAREJADO_OK=1 PANEL_CONTENEDOR=panel-c CF_PANEL_CONECTADA=1
    RESUMEN_P25=abierto RESUMEN_IMAGENES="" RESUMEN_IDENTIDAD="" MAIL_HOSTNAME_ANTERIOR=""
    "$@"
    resumen
  ) >"$SALIDA" 2>&1
}

echo "# Resumen: el puerto 25 bloqueado es un paso que dar"
resumen_con eval 'RESUMEN_P25=BLOQUEADO'
comprobar "en «Siguientes pasos»" contiene "$SALIDA" "Pide al proveedor del servidor que desbloquee el puerto 25 de salida"
resumen_con true
comprobar "abierto, no" no_contiene "$SALIDA" "desbloquee el puerto 25"

echo "# Resumen tras cambiar el nombre del servidor y sin imágenes nuevas"
resumen_con eval 'MAIL_HOSTNAME=mail.nuevo.test MAIL_HOSTNAME_ANTERIOR=mail.ejemplo.test RESUMEN_IMAGENES="NO DESCARGADAS: x" RESUMEN_IDENTIDAD="pendiente: y"'
comprobar "manda cambiar el MX de los dominios" contiene "$SALIDA" "Cambia a mail.nuevo.test el MX"
comprobar "y reconfigurar los programas de correo" contiene "$SALIDA" "programas de correo que usaban mail.ejemplo.test"
comprobar "la línea de las imágenes" contiene "$SALIDA" "Imágenes:            NO DESCARGADAS: x"
comprobar "y repetir --actualizar" contiene "$SALIDA" "cuando haya conexión con Docker Hub"
comprobar "la identidad pendiente" contiene "$SALIDA" "Identidad en el panel: pendiente: y"
comprobar "y dónde revisarla" contiene "$SALIDA" "En Ajustes → Identidad del servidor, comprueba los nombres y la IP nuevos"

# ------------------------------------------------------------- --comprobar --

# Dobles para el diagnóstico: estado de cada contenedor, API del motor, lo que
# se ejecuta en el webmail, parámetros de Traefik, DNS, PTR y puerto 25.
declare -A FAKE_ESTADOS=()
FAKE_PANEL_RESPONDE=1
FAKE_TRAEFIK='["--providers.http.endpoint=http://skyway:4000/api/traefik/mailway"]'
FAKE_DNS=0
FAKE_PTR_LEIDOS=mail.ejemplo.test
FAKE_P25=1
reiniciar_diagnostico() {
  : >"$REGISTRO"
  FAKE_ESTADOS=([mailway-mail]=healthy [mailway-webmail]=healthy [skyway-mailway-panel]=healthy [skyway-traefik]=running [mailway-certs-dumper]=ausente)
  FAKE_PANEL_RESPONDE=1
  FAKE_TRAEFIK='["--providers.http.endpoint=http://skyway:4000/api/traefik/mailway"]'
  FAKE_DNS=0
  FAKE_PTR_LEIDOS=mail.ejemplo.test
  FAKE_P25=1
}
diagnostico() {
  (
    CON_SKYWAY=1 MAIL_HOSTNAME=mail.ejemplo.test WEBMAIL_HOSTNAME=webmail.ejemplo.test PANEL_HOSTNAME=panel.ejemplo.test
    IP_PUBLICA=203.0.113.7 PANEL_INTERNAL_URL=http://skyway-mailway-panel:4100 INTERNAL_SUBNET=10.203.53.0/24
    STALWART_ADMIN_PASSWORD=clave
    "$@"
    comprobar_instalacion
  ) >"$SALIDA" 2>&1
  CODIGO=$?
}
estado_contenedor() { printf '%s' "${FAKE_ESTADOS[$1]:-ausente}"; }
motor_api() {
  printf '{"data":{"server.hostname":"mail.ejemplo.test","server.allowed-ip.10.203.53.0/24":"","acme.mailway.directory":"x"}}'
}
argumentos_traefik() { printf '%s' "$FAKE_TRAEFIK"; }
resuelve_a() {
  echo "DNS $1" >>"$REGISTRO"
  DNS_LEIDAS=""
  if [ "$FAKE_DNS" = 1 ]; then DNS_LEIDAS=198.51.100.1; fi
  return "$FAKE_DNS"
}
consultar_ptr() { PTR_LEIDOS=$FAKE_PTR_LEIDOS; }
puerto25_abierto() { [ "$FAKE_P25" = 1 ]; }
docker() {
  printf 'docker %s\n' "$*" >>"$REGISTRO"
  case "$*" in
    "exec -u www-data mailway-webmail php "*) echo "OK: comprobado" ;;
    "exec mailway-webmail curl -fsS --max-time 8 http://skyway-mailway-panel:4100/api/health")
      [ "$FAKE_PANEL_RESPONDE" = 1 ] && echo '{"ok":true,"name":"mailway","version":"1.2.0"}'
      ;;
    *)
      echo "docker no simulado: $*" >>"$REGISTRO"
      return 1
      ;;
  esac
}

echo "# --comprobar con todo bien junto a Skyway"
reiniciar_diagnostico
diagnostico true
comprobar "termina bien" igual "$CODIGO" 0
comprobar "revisa el contenedor del panel" contiene "$SALIDA" "skyway-mailway-panel: en marcha y sano"
comprobar "y que el webmail llega a él, con su versión" contiene "$SALIDA" "El webmail llega al panel (http://skyway-mailway-panel:4100): Mailway 1.2.0"
comprobar "revisa Traefik" contiene "$SALIDA" "Traefik lee las rutas de Mailway a través de Skyway"
comprobar "el DNS de los tres nombres" contiene "$REGISTRO" "DNS panel.ejemplo.test"
comprobar "el PTR" contiene "$SALIDA" "DNS inverso (PTR) correcto"
comprobar "el puerto 25" contiene "$SALIDA" "Puerto 25 de salida abierto"
comprobar "ya no dice que el DNS y el PTR quedan fuera" no_contiene "$SALIDA" "Quedan fuera el DNS público"

echo "# --comprobar con el panel parado: ya no dice «Todo correcto»"
reiniciar_diagnostico
FAKE_ESTADOS[skyway-mailway-panel]=exited
FAKE_PANEL_RESPONDE=0
diagnostico true
comprobar "termina con código 1" igual "$CODIGO" 1
comprobar "lo dice" contiene "$SALIDA" "skyway-mailway-panel: exited"
comprobar "y que el webmail no llega a él" contiene "$SALIDA" "El webmail no llega al panel en http://skyway-mailway-panel:4100"
comprobar "sin «Todo correcto»" no_contiene "$SALIDA" "Todo correcto"

echo "# --comprobar: Traefik sin las rutas de Mailway, DNS a otra IP, PTR ajeno y 25 bloqueado"
reiniciar_diagnostico
FAKE_TRAEFIK='["--entrypoints.web.address=:80"]'
FAKE_DNS=1
FAKE_PTR_LEIDOS=vps-1.proveedor.test
FAKE_P25=0
diagnostico true
comprobar "termina con código 1" igual "$CODIGO" 1
comprobar "Traefik" contiene "$SALIDA" "El Traefik de Skyway no lee las rutas de Mailway"
comprobar "el DNS, con la IP a la que apunta" contiene "$SALIDA" "mail.ejemplo.test apunta a 198.51.100.1, no a 203.0.113.7"
comprobar "el PTR" contiene "$SALIDA" "DNS inverso (PTR) INCORRECTO: 203.0.113.7 → vps-1.proveedor.test"
comprobar "el puerto 25, con qué hacer" contiene "$SALIDA" "Pide al proveedor del servidor que lo desbloquee"
comprobar "cuenta cada incidencia" contiene "$SALIDA" "6 comprobaciones con incidencias"

echo "# --comprobar sin respuesta de los resolutores: se dice, pero no es una incidencia"
reiniciar_diagnostico
FAKE_DNS=2
diagnostico true
comprobar "termina bien" igual "$CODIGO" 0
comprobar "lo dice" contiene "$SALIDA" "ningún resolutor público ha respondido"

echo "# --comprobar sin el contenedor del panel en deploy/.env"
reiniciar_diagnostico
diagnostico eval 'PANEL_INTERNAL_URL=http://panel-pendiente.invalid:4100'
comprobar "termina con código 1" igual "$CODIGO" 1
comprobar "lo dice" contiene "$SALIDA" "deploy/.env no indica el contenedor del panel"

echo "# MAILWAY_COMPROBAR_SOLO_MOTOR=1: solo el motor, el webmail y el extractor"
reiniciar_diagnostico
FAKE_ESTADOS[skyway-mailway-panel]=ausente
FAKE_ESTADOS[skyway-traefik]=ausente
FAKE_P25=0
diagnostico export MAILWAY_COMPROBAR_SOLO_MOTOR=1
comprobar "termina bien" igual "$CODIGO" 0
comprobar "lo dice" contiene "$SALIDA" "MAILWAY_COMPROBAR_SOLO_MOTOR=1: sin el panel, Traefik ni las comprobaciones desde Internet"
comprobar "no llama al panel" no_contiene "$REGISTRO" "api/health"
comprobar "ni consulta el DNS" no_contiene "$REGISTRO" "DNS mail.ejemplo.test"

echo "# El contenedor del panel sale de MAILWAY_PANEL_INTERNAL_URL"
comprobar "con Skyway" igual "$(PANEL_INTERNAL_URL=http://skyway-correo-mailway:4100 contenedor_del_panel)" skyway-correo-mailway
comprobar "el marcador de panel pendiente no es un contenedor" igual "$(PANEL_INTERNAL_URL=http://panel-pendiente.invalid:4100 contenedor_del_panel)" ""

echo
TERMINADA=1
if [ "$FALLOS" -gt 0 ]; then
  echo "$FALLOS comprobaciones han fallado."
  exit 1
fi
echo "Todas las comprobaciones son correctas."
