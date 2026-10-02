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
# vuelve a definir) solo los invocan esas funciones: SC2329. Y algunos
# escenarios cambian variables dentro de un subshell precisamente para que el
# cambio no llegue a los siguientes: SC2030 y SC2031.
# shellcheck disable=SC2034,SC2329,SC2030,SC2031

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

# ------------------------------------- panel que Skyway ya despliega --
#
# Instalaciones anteriores a la 1.0: el panel se creó a mano en Skyway (proyecto
# «Correo», servicio «mailway»), con su clave maestra en el volumen /data y sin
# deploy/.env completo. El instalador debe actualizar ese panel sin duplicarlo
# ni cambiar su clave.

FAKE_PANEL_ENV=$'NODE_ENV=production\nMAILWAY_DATA_DIR=/data\nPORT=4100\nSTALWART_URL=http://mailway-mail:8080\nSTALWART_ADMIN_PASSWORD=clave-motor-antigua\nMAILWAY_MAIL_HOSTNAME=mail.ejemplo.test\nMAILWAY_WEBMAIL_URL=https://webmail.ejemplo.test\nMAILWAY_PUBLIC_IP=203.0.113.7'
FAKE_CONTENEDORES=$'skyway-web-app\nskyway-correo-mailway'
FAKE_PARADOS=""
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
      esac
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
    "volume inspect "*) return 1 ;;
    *)
      echo "docker no simulado: $*" >>"$REGISTRO"
      return 1
      ;;
  esac
}

# API de Skyway con el panel en el proyecto «Correo». FAKE_ENV_PANEL son sus
# variables guardadas; FAKE_REPOS, los servicios git del segundo proyecto.
FAKE_ENV_PANEL='{"vars":{"STALWART_URL":"http://mailway-mail:8080","MAILWAY_SMTP_ALLOW_SELF_SIGNED":"1","MI_VARIABLE":"se-conserva"}}'
FAKE_REPOS='[{"id":"svc_panel","slug":"mailway","type":"git","config":{"repoUrl":"https://github.com/NkrowOne/Mailway.git"}}]'
sky_api() {
  printf 'sky_api %s %s\n' "$1" "$SKYWAY_URL$2" >>"$REGISTRO"
  if [ -n "${3:-}" ]; then printf 'CUERPO %s %s %s\n' "$1" "$2" "$3" >>"$REGISTRO"; fi
  RESP_CODE=200
  case "$1 $2" in
    "GET /api/health") RESP_BODY='{"ok":true,"version":"0.34.0"}' ;;
    "GET /api/projects") RESP_BODY='{"projects":[{"id":"prj_web","slug":"web","name":"Web"},{"id":"prj_correo","slug":"correo","name":"Correo"}]}' ;;
    "GET /api/projects/prj_web") RESP_BODY='{"project":{"id":"prj_web","slug":"web"},"services":[{"id":"svc_web","slug":"app","type":"git","config":{"repoUrl":"https://github.com/NkrowOne/codanuance"}}]}' ;;
    "GET /api/projects/prj_correo") RESP_BODY="{\"project\":{\"id\":\"prj_correo\",\"slug\":\"correo\"},\"services\":$FAKE_REPOS}" ;;
    "GET /api/services/svc_panel") RESP_BODY='{"service":{"id":"svc_panel","slug":"mailway","type":"git","config":{"volumes":[{"name":"skyway-correo-mailway-data","containerPath":"/data"}],"domains":["correo.ejemplo.test"]}},"project":{"id":"prj_correo","slug":"correo"}}' ;;
    "GET /api/services/svc_panel/env") RESP_BODY=$FAKE_ENV_PANEL ;;
    "PUT /api/services/svc_panel/env" | "PATCH /api/services/svc_panel") RESP_BODY='{}' ;;
    "GET /api/domains/config") RESP_BODY='{"tls":true}' ;;
    "POST /api/services/svc_panel/deploy") RESP_CODE=202 RESP_BODY='{"deployment":{"id":"dep1"}}' ;;
    "GET /api/deployments/dep1") RESP_BODY='{"deployment":{"status":"success"}}' ;;
    *) RESP_CODE=404 RESP_BODY='{"error":"no simulado"}' ;;
  esac
}
sleep() { :; }
crear_token_temporal_skyway() { SKYWAY_TOKEN=sky_temporal12345; }

# Estado de cada escenario: sin panel detectado y sin deploy/.env.
reiniciar_panel() {
  : >"$REGISTRO"
  PANEL_EXISTENTE_SERVICIO=""
  PANEL_EXISTENTE_CONTENEDOR=""
  PANEL_EXISTENTE_HOST=""
  PANEL_EXISTENTE_ENV=()
  PANEL_ADOPTADO=""
  PANEL_CONTENEDOR=""
  CON_SKYWAY=1
  ENV_FILE="$TMP/env-inexistente"
  unset MAILWAY_PANEL_SERVICIO SKYWAY_TOKEN SKYWAY_URL STALWART_ADMIN_PASSWORD MAILWAY_IP
  FAKE_SANA=""
}
# Lo que ya han fijado los pasos anteriores de la instalación.
datos_instalacion() {
  MAILWAY_SECRET=0123456789abcdef0123456789abcdef
  STALWART_ADMIN_PASSWORD=clave-motor-antigua
  MAILWAY_SETUP_TOKEN=s MAILWAY_TRAEFIK_TOKEN=t MAILWAY_WEBMAIL_TOKEN=w
  MAIL_HOSTNAME=mail.ejemplo.test WEBMAIL_HOSTNAME=webmail.ejemplo.test PANEL_HOSTNAME=correo.ejemplo.test
  IP_PUBLICA=203.0.113.7 INTERNAL_SUBNET=10.203.53.0/24 CERT_CONFIGURADO=1
  FAKE_SANA=http://127.0.0.1:4000
}
# Cuerpo del PUT de las variables del panel.
cuerpo_put() { grep '^CUERPO PUT /api/services/svc_panel/env ' "$REGISTRO" | sed 's/^CUERPO PUT [^ ]* //'; }

echo "# Se reconoce el panel entre los contenedores de Skyway"
reiniciar_panel
detectar_panel_existente >"$SALIDA" 2>&1
comprobar "elige el servicio del panel" igual "$PANEL_EXISTENTE_SERVICIO" svc_panel
comprobar "y su contenedor" igual "$PANEL_EXISTENTE_CONTENEDOR" skyway-correo-mailway
comprobar "toma el dominio de la regla de Traefik" igual "$PANEL_EXISTENTE_HOST" correo.ejemplo.test
comprobar "lee la contraseña del motor de su entorno" igual "$(valor_panel STALWART_ADMIN_PASSWORD)" clave-motor-antigua
comprobar "no confunde la web del otro proyecto" no_contiene "$SALIDA" skyway-web-app
comprobar "explica que su clave maestra no cambia" contiene "$SALIDA" "Su clave maestra está en su volumen /data y no se cambia"

echo "# Sin deploy/.env: los secretos y los nombres salen del panel"
detectar_panel_existente >/dev/null 2>&1
preparar_secretos >"$SALIDA" 2>&1
comprobar "reutiliza la contraseña del motor" igual "$STALWART_ADMIN_PASSWORD" clave-motor-antigua
comprobar "genera una clave maestra para deploy/.env" coincide "$MAILWAY_SECRET" '^[0-9a-f]{64}$'
(
  comprobar_subred() { :; }
  elegir_correo_admin() { ADMIN_EMAIL=admin@ejemplo.test; }
  recoger_datos >/dev/null 2>&1
  printf '%s %s %s %s %s\n' "$DOMINIO" "$MAIL_HOSTNAME" "$WEBMAIL_HOSTNAME" "$PANEL_HOSTNAME" "$IP_PUBLICA"
) >"$SALIDA" 2>&1
comprobar "propone el dominio, los nombres y la IP que ya usa" \
  igual "$(tail -n 1 "$SALIDA")" "ejemplo.test mail.ejemplo.test webmail.ejemplo.test correo.ejemplo.test 203.0.113.7"

echo "# La clave maestra del panel manda sobre la de deploy/.env"
reiniciar_panel
FAKE_PANEL_ENV+=$'\nMAILWAY_SECRET=clave-maestra-del-panel-0123456789'
printf 'MAILWAY_SECRET=otra-clave-distinta-0123456789abcdef\n' >"$TMP/env-previo"
ENV_FILE="$TMP/env-previo"
detectar_panel_existente >"$SALIDA" 2>&1
preparar_secretos >>"$SALIDA" 2>&1
comprobar "usa la del panel" igual "$MAILWAY_SECRET" clave-maestra-del-panel-0123456789
comprobar "lo explica" contiene "$SALIDA" "Se conservan su clave maestra y sus secretos"
FAKE_PANEL_ENV=${FAKE_PANEL_ENV%$'\n'MAILWAY_SECRET=*}

echo "# Panel detectado: se actualiza en su proyecto, sin crear otro ni darle clave maestra"
reiniciar_panel
detectar_panel_existente >/dev/null 2>&1
datos_instalacion
(desplegar_en_skyway && echo "PANEL_CONTENEDOR=$PANEL_CONTENEDOR") >"$SALIDA" 2>&1
comprobar "termina bien" contiene "$SALIDA" "Panel desplegado (skyway-correo-mailway)"
comprobar "usa el contenedor del panel existente" contiene "$SALIDA" "PANEL_CONTENEDOR=skyway-correo-mailway"
comprobar "no crea proyectos" no_contiene "$REGISTRO" "sky_api POST http://127.0.0.1:4000/api/projects"
comprobar "no crea servicios" no_contiene "$REGISTRO" "sky_api POST http://127.0.0.1:4000/api/projects/"
comprobar "no busca el proyecto «mailway»" no_contiene "$REGISTRO" "GET http://127.0.0.1:4000/api/projects"
comprobar "no añade MAILWAY_SECRET a sus variables" no_contiene <(cuerpo_put) "MAILWAY_SECRET"
comprobar "conserva las variables puestas a mano" contiene <(cuerpo_put) '"MI_VARIABLE":"se-conserva"'
comprobar "actualiza las del instalador" contiene <(cuerpo_put) '"MAILWAY_WEBMAIL_TOKEN":"w"'
comprobar "retira MAILWAY_SMTP_ALLOW_SELF_SIGNED con certificado" no_contiene <(cuerpo_put) "MAILWAY_SMTP_ALLOW_SELF_SIGNED"
comprobar "despliega ese servicio" contiene "$REGISTRO" "sky_api POST http://127.0.0.1:4000/api/services/svc_panel/deploy"

echo "# Si sus variables ya llevan MAILWAY_SECRET, se conserva aunque deploy/.env diga otra"
reiniciar_panel
detectar_panel_existente >/dev/null 2>&1
FAKE_ENV_PANEL='{"vars":{"MAILWAY_SECRET":"la-del-panel-0123456789abcdef"}}'
datos_instalacion
(desplegar_en_skyway) >"$SALIDA" 2>&1
comprobar "envía la del panel" contiene <(cuerpo_put) '"MAILWAY_SECRET":"la-del-panel-0123456789abcdef"'
comprobar "y el resto de variables del instalador" contiene <(cuerpo_put) '"MAILWAY_WEBMAIL_TOKEN":"w"'
comprobar "no envía la de deploy/.env" no_contiene <(cuerpo_put) "$MAILWAY_SECRET"
comprobar "avisa de la diferencia" contiene "$SALIDA" "se conserva la del panel"
FAKE_ENV_PANEL='{"vars":{}}'

echo "# Sin contenedor (parado y retirado): se encuentra por el repositorio, se llame como se llame"
reiniciar_panel
FAKE_CONTENEDORES="skyway-web-app"
detectar_panel_existente >/dev/null 2>&1
comprobar "no detecta contenedor" igual "$PANEL_EXISTENTE_SERVICIO" ""
SKYWAY_URL=http://127.0.0.1:4000
SKYWAY_TOKEN=sky_indicado12345
localizar_panel_en_skyway https://github.com/NkrowOne/Mailway >"$SALIDA" 2>&1
comprobar "adopta el servicio que despliega el repositorio" igual "$PANEL_ADOPTADO" "prj_correo correo svc_panel mailway"

echo "# Dos servicios despliegan el repositorio: se pide cuál, sin tocar nada"
reiniciar_panel
FAKE_REPOS='[{"id":"svc_panel","slug":"mailway","type":"git","config":{"repoUrl":"github.com/nkrowone/mailway/"}},{"id":"svc_copia","slug":"copia","type":"git","config":{"repoUrl":"git@github.com:NkrowOne/Mailway.git"}}]'
SKYWAY_URL=http://127.0.0.1:4000
SKYWAY_TOKEN=sky_indicado12345
(localizar_panel_en_skyway https://github.com/NkrowOne/Mailway) >"$SALIDA" 2>&1
codigo=$?
comprobar "termina con código 1" igual "$codigo" 1
comprobar "lista los dos" contiene "$SALIDA" "servicio «copia» del proyecto «correo» (id svc_copia)"
comprobar "explica cómo elegir" contiene "$SALIDA" "MAILWAY_PANEL_SERVICIO"
FAKE_REPOS='[]'

echo "# Sin panel en ningún sitio: instalación nueva en el proyecto «mailway»"
reiniciar_panel
SKYWAY_URL=http://127.0.0.1:4000
SKYWAY_TOKEN=sky_indicado12345
localizar_panel_en_skyway https://github.com/NkrowOne/Mailway >"$SALIDA" 2>&1
comprobar "no adopta nada" igual "$PANEL_ADOPTADO" ""

echo "# Varios paneles en contenedores: se pide cuál"
reiniciar_panel
FAKE_CONTENEDORES=$'skyway-correo-mailway\nskyway-otro-mailway'
(detectar_panel_existente) >"$SALIDA" 2>&1
codigo=$?
comprobar "termina con código 1" igual "$codigo" 1
comprobar "explica cómo elegir" contiene "$SALIDA" "MAILWAY_PANEL_SERVICIO=<servicio>"

echo "# Réplicas del mismo servicio: es un solo panel"
reiniciar_panel
FAKE_CONTENEDORES=$'skyway-correo-mailway\nskyway-correo-mailway-2'
(detectar_panel_existente && echo "SERVICIO=$PANEL_EXISTENTE_SERVICIO") >"$SALIDA" 2>&1
comprobar "lo reconoce" contiene "$SALIDA" "SERVICIO=svc_panel"

echo "# El panel en marcha manda sobre un panel parado de otro servicio"
reiniciar_panel
FAKE_CONTENEDORES="skyway-correo-mailway"
FAKE_PARADOS="skyway-otro-mailway"
(detectar_panel_existente && echo "SERVICIO=$PANEL_EXISTENTE_SERVICIO") >"$SALIDA" 2>&1
comprobar "elige el que está en marcha" contiene "$SALIDA" "SERVICIO=svc_panel"

echo "# Ninguno en marcha: se reconoce el parado"
reiniciar_panel
FAKE_CONTENEDORES=""
FAKE_PARADOS="skyway-otro-mailway"
(detectar_panel_existente && echo "SERVICIO=$PANEL_EXISTENTE_SERVICIO") >"$SALIDA" 2>&1
comprobar "lo encuentra" contiene "$SALIDA" "SERVICIO=svc_otro"
FAKE_PARADOS=""

echo "# Indicado con MAILWAY_PANEL_SERVICIO"
reiniciar_panel
FAKE_CONTENEDORES=$'skyway-correo-mailway\nskyway-otro-mailway'
MAILWAY_PANEL_SERVICIO=svc_otro
detectar_panel_existente >"$SALIDA" 2>&1
comprobar "usa el indicado" igual "$PANEL_EXISTENTE_CONTENEDOR" skyway-otro-mailway
MAILWAY_PANEL_SERVICIO='../x'
(detectar_panel_existente) >"$SALIDA" 2>&1
comprobar "rechaza un identificador no válido" contiene "$SALIDA" "no es un identificador de servicio de Skyway válido"
unset MAILWAY_PANEL_SERVICIO

echo "# Instalación autónoma: no se busca nada en Skyway"
reiniciar_panel
CON_SKYWAY=0
detectar_panel_existente >"$SALIDA" 2>&1
comprobar "no consulta Docker" no_contiene "$REGISTRO" "docker ps"

echo
TERMINADA=1
if [ "$FALLOS" -gt 0 ]; then
  echo "$FALLOS comprobaciones han fallado."
  exit 1
fi
echo "Todas las comprobaciones son correctas."
