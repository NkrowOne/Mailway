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
# el análisis estático no ve (se cargan de una copia): de ahí SC2034.
# shellcheck disable=SC2034

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
trap 'al_salir; rm -rf "$TMP"' EXIT
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
igual() { [ "$1" = "$2" ]; }

# ------------------------------------------------------------- simulación --

# docker simulado. Escenario en FAKE_*: salida y avisos de la herramienta del
# panel, IP del contenedor «skyway».
FAKE_SALIDA=""
FAKE_AVISO=""
FAKE_IPS="172.18.0.5 "
docker() {
  printf 'docker %s\n' "$*" >>"$REGISTRO"
  case "$*" in
    "inspect --type container -f {{.State.Running}} skyway") echo true ;;
    "inspect --type container -f {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}} skyway") echo "$FAKE_IPS" ;;
    "exec skyway test -f "* | "exec panel-c test -f "*) return 0 ;;
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
}

TOKEN_MWT='mwt_0123abcd_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'
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

echo
if [ "$FALLOS" -gt 0 ]; then
  echo "$FALLOS comprobaciones han fallado."
  exit 1
fi
echo "Todas las comprobaciones son correctas."
