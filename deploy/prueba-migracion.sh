#!/usr/bin/env bash
#
# Pruebas de la migración de una instalación anterior a la 1.0 (guía 0.x) en
# deploy/instalar.sh, con docker y la API del motor simulados: sin
# contenedores, sin red y sin root. Carga las funciones del instalador (todo
# menos la llamada final a main) y comprueba, también en los casos que NO
# deben cambiar nada:
#   - el certificado que dejaba traefik-certs-dumper en certificate.default
#     pasa al extractor (o se retira si el motor usa su propio ACME);
#   - los usuarios del webmail pasan del servidor público al interno
#     (users.mail_host), sobre una base SQLite real con el esquema de Roundcube;
#   - el docker-compose.override.yml de Traefik copiado a mano de Ajustes →
#     Marca blanca se retira con Skyway 0.34, y el «ok» depende de los
#     parámetros con los que corre Traefik.
#
#   bash deploy/prueba-migracion.sh     # código 1 si alguna comprobación falla
#
# Necesita jq y, para la base del webmail, php con pdo_sqlite (sin él, esos
# casos se omiten y se indica).
#
# Las variables que fija la prueba las leen las funciones del instalador, que
# el análisis estático no ve (se cargan de una copia): de ahí SC2034. Por lo
# mismo, los dobles de docker, motor_api y otras funciones solo los invocan
# esas funciones: SC2329 (SC2317 en las versiones de shellcheck anteriores a
# la 0.11). Cada escenario se ejecuta en un subshell con «set -e», como el
# instalador, para que sus cambios no lleguen a los siguientes: SC2030 y
# SC2031. Y los «$» entre comillas simples son variables de PHP: SC2016.
# shellcheck disable=SC2034,SC2329,SC2317,SC2030,SC2031,SC2016

set -uo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v jq >/dev/null 2>&1 || { echo "Falta jq." >&2; exit 1; }
if [ "$(tail -n 1 "$AQUI/instalar.sh")" != "main" ]; then
  echo "La última línea de instalar.sh ya no es «main»: actualiza esta prueba." >&2
  exit 1
fi

TMP=$(mktemp -d)
mkdir -p "$TMP/deploy" "$TMP/bin"
sed '$d' "$AQUI/instalar.sh" >"$TMP/deploy/instalar.sh"
REGISTRO="$TMP/registro"
SALIDA="$TMP/salida"
# Llamadas que ningún doble esperaba: al final, debe estar vacío.
IMPREVISTOS="$TMP/imprevistos"
: >"$REGISTRO"
: >"$IMPREVISTOS"

# shellcheck source=/dev/null
source "$TMP/deploy/instalar.sh" </dev/null
set +e
# Red de seguridad: lo que llame a docker como programa (env, compose) da con
# este y no con el de verdad.
printf '#!/bin/sh\necho "docker real: $*" >>"%s"\nexit 1\n' "$IMPREVISTOS" >"$TMP/bin/docker"
chmod +x "$TMP/bin/docker"
PATH="$TMP/bin:$PATH"
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
  fi
}
contiene() { grep -Fq -- "$2" "$1"; }
no_contiene() { ! grep -Fq -- "$2" "$1"; }
igual() { [ "$1" = "$2" ]; }
existe() { [ -e "$1" ]; }
no_existe() { [ ! -e "$1" ]; }
# ¿Hay una línea con $3 después de la primera con $2? (El fichero se lee una
# sola vez: puede ser una sustitución de proceso.)
despues_de() {
  local contenido a b
  contenido=$(cat "$1")
  a=$(grep -nF -- "$2" <<<"$contenido" | head -n 1 | cut -d: -f1)
  b=$(grep -nF -- "$3" <<<"$contenido" | tail -n 1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}
no_es_de_mailway() { ! override_de_mailway "$1"; }
sleep() { :; }

# Lo que ya han fijado los pasos anteriores de la instalación.
MAIL_HOSTNAME=mail.ejemplo.test
INTERNAL_SUBNET=10.203.53.0/24
LE_EMAIL=postmaster@ejemplo.test
CON_SKYWAY=1
TRAEFIK_ACME_VOLUME=skyway_traefik-letsencrypt
USAR_PROXY_PROPIO=0
CF_TOKEN=""
CF_ZONA_NOMBRE=""

# ------------------------------------------- certificado del volcado antiguo --

# API del motor simulada. FAKE_AJUSTES es lo que devuelve la lectura de
# ajustes; un POST que contenga FAKE_RECHAZO se rechaza como lo hace Stalwart
# 0.15 (HTTP 200 con { "error" }).
FAKE_AJUSTES='{"data":{}}'
FAKE_RECHAZO=""
# FAKE_DEFAULT_ROTO=1: certificate.default apunta a ficheros que no existen
# (lo normal tras retirar el volcador antiguo) y toda recarga falla hasta que
# una petición lo borra. El estado va en un fichero: motor_api corre en $(…).
FAKE_DEFAULT_ROTO=0
DEFAULT_RETIRADO="$TMP/default-retirado"
motor_api() {
  printf 'motor_api %s %s %s\n' "$1" "$2" "${3:-}" >>"$REGISTRO"
  case "$1 $2" in
    "GET /api/settings/keys"*) printf '%s' "$FAKE_AJUSTES" ;;
    "POST /api/settings")
      if [ -n "$FAKE_RECHAZO" ] && [[ $3 == *"$FAKE_RECHAZO"* ]]; then
        echo '{"error":"other","details":"rechazado"}'
      else
        if [[ $3 == *'"prefix":"certificate.default."'* ]]; then : >"$DEFAULT_RETIRADO"; fi
        echo '{"data":null}'
      fi
      ;;
    "GET /api/reload" | "GET /api/reload/certificate")
      if [ "$FAKE_DEFAULT_ROTO" = 1 ] && [ ! -e "$DEFAULT_RETIRADO" ]; then
        echo '{"data":{"errors":{"certificate.default.cert":"No such file or directory"}}}'
      else
        echo '{"data":{"errors":{}}}'
      fi
      ;;
    *)
      echo "motor_api no simulado: $*" >>"$IMPREVISTOS"
      return 1
      ;;
  esac
}
compose_q() { printf 'compose_q %s\n' "$*" >>"$REGISTRO"; }
# FAKE_DUMPER=1: existe el contenedor del extractor.
FAKE_DUMPER=0
docker() {
  printf 'docker %s\n' "$*" >>"$REGISTRO"
  case "$*" in
    "image inspect "*) return 0 ;;
    "inspect mailway-certs-dumper") [ "$FAKE_DUMPER" = 1 ] ;;
    "rm -f mailway-certs-dumper") return 0 ;;
    "exec mailway-certs-dumper python /app/extractor.py estado") return 0 ;;
    *)
      echo "docker no simulado: $*" >>"$IMPREVISTOS"
      return 1
      ;;
  esac
}

# Cuerpos de los POST de ajustes, en orden.
cuerpos_post() { grep '^motor_api POST /api/settings ' "$REGISTRO" | sed 's/^motor_api POST \/api\/settings //'; }
# ¿Hay una petición que contiene $2 y, más adelante en la misma, $3?
en_la_misma_peticion() {
  local linea
  while IFS= read -r linea; do
    [[ $linea == *"$2"*"$3"* ]] && return 0
  done <"$1"
  return 1
}
# Ejecuta configurar_motor como el instalador (con set -e) y deja su salida y
# el estado del certificado en $SALIDA.
probar_motor() {
  : >"$REGISTRO"
  (
    set -e
    configurar_motor
    echo "CERT_CONFIGURADO=$CERT_CONFIGURADO"
    echo "RESUMEN_CERT=$RESUMEN_CERT"
  ) >"$SALIDA" 2>&1
  CODIGO=$?
}

RUTA=/opt/stalwart/certs/mail.ejemplo.test
DEFAULT_VOLCADO="\"certificate.default.cert\":\"%{file:$RUTA/cert.pem}%\",\"certificate.default.private-key\":\"%{file:$RUTA/key.pem}%\""
OP_CLEAR='{"type":"clear","prefix":"certificate.default."}'

echo "# Guía 0.x sin Cloudflare: el certificado del volcado antiguo pasa al extractor"
FAKE_AJUSTES="{\"data\":{$DEFAULT_VOLCADO}}"
probar_motor
comprobar "termina bien" igual "$CODIGO" 0
comprobar "crea certificate.mailway.cert con las mismas rutas" contiene <(cuerpos_post) "[\"certificate.mailway.cert\",\"%{file:$RUTA/cert.pem}%\"]"
comprobar "y certificate.mailway.private-key" contiene <(cuerpos_post) "[\"certificate.mailway.private-key\",\"%{file:$RUTA/key.pem}%\"]"
comprobar "como certificado por defecto" contiene <(cuerpos_post) '["certificate.mailway.default","true"]'
comprobar "con el nombre del servidor como sujeto" contiene <(cuerpos_post) '["certificate.mailway.subjects.0","mail.ejemplo.test"]'
comprobar "y borra certificate.default después, en la misma petición" contiene <(cuerpos_post) "\"assert_empty\":false},$OP_CLEAR]"
comprobar "arranca el extractor (retira las claves ajenas del volumen)" contiene "$REGISTRO" "compose_q --profile tls up -d --force-recreate certs-dumper"
comprobar "espera a que compruebe el certificado servido" contiene "$REGISTRO" "docker exec mailway-certs-dumper python /app/extractor.py estado"
comprobar "no lo trata como un certificado propio" no_contiene "$SALIDA" "configurado a mano"
comprobar "el motor queda con certificado" contiene "$SALIDA" "CERT_CONFIGURADO=1"
comprobar "el resumen dice que lo mantiene el extractor" contiene "$SALIDA" "RESUMEN_CERT=el de Traefik, aplicado por el extractor"

echo "# Con espacios alrededor de las rutas (editado en la web del motor), también"
FAKE_AJUSTES="{\"data\":{\"certificate.default.cert\":\" %{file:$RUTA/cert.pem}%\\n\",\"certificate.default.private-key\":\"%{file:$RUTA/key.pem}% \"}}"
probar_motor
comprobar "pasa al extractor" contiene "$REGISTRO" "compose_q --profile tls up -d --force-recreate certs-dumper"

echo "# Certificado propio con otras rutas: se respeta"
FAKE_AJUSTES='{"data":{"certificate.default.cert":"%{file:/etc/stalwart/propio/cert.pem}%","certificate.default.private-key":"%{file:/etc/stalwart/propio/key.pem}%"}}'
probar_motor
comprobar "lo explica" contiene "$SALIDA" "El motor ya tiene un certificado configurado a mano; no se modifica"
comprobar "no crea certificate.mailway" no_contiene <(cuerpos_post) "certificate.mailway"
comprobar "no borra certificate.default" no_contiene <(cuerpos_post) "clear"
comprobar "no arranca el extractor" no_contiene "$REGISTRO" "compose_q"

echo "# Las rutas del volcado, pero de otro nombre de servidor: se respeta"
FAKE_AJUSTES='{"data":{"certificate.default.cert":"%{file:/opt/stalwart/certs/mail.otro.test/cert.pem}%","certificate.default.private-key":"%{file:/opt/stalwart/certs/mail.otro.test/key.pem}%"}}'
probar_motor
comprobar "lo trata como propio" contiene "$SALIDA" "configurado a mano"
comprobar "no borra certificate.default" no_contiene <(cuerpos_post) "clear"

echo "# El certificado del volcado con una clave de otro sitio: se respeta"
FAKE_AJUSTES="{\"data\":{\"certificate.default.cert\":\"%{file:$RUTA/cert.pem}%\",\"certificate.default.private-key\":\"%{file:/etc/stalwart/clave.pem}%\"}}"
probar_motor
comprobar "lo trata como propio" contiene "$SALIDA" "configurado a mano"

echo "# El motor rechaza el cambio: avisa sin interrumpir y no da el certificado por renovado"
FAKE_AJUSTES="{\"data\":{$DEFAULT_VOLCADO}}"
FAKE_RECHAZO="certificate.mailway.cert"
probar_motor
comprobar "termina bien" igual "$CODIGO" 0
comprobar "lo explica" contiene "$SALIDA" "No se pudo pasar el certificado al extractor"
comprobar "el resumen lo recoge" contiene "$SALIDA" "SIN RENOVACIÓN"
comprobar "no arranca el extractor" no_contiene "$REGISTRO" "compose_q"
FAKE_RECHAZO=""

echo "# Con Cloudflare: ACME del motor, fuera certificate.default y volumen limpio"
FAKE_AJUSTES="{\"data\":{$DEFAULT_VOLCADO}}"
CF_TOKEN=cf_token_de_prueba_0123456789
CF_ZONA_NOMBRE=ejemplo.test
probar_motor
comprobar "configura el ACME del motor" contiene <(cuerpos_post) '["acme.mailway.provider","cloudflare"]'
comprobar "borra certificate.default después del ACME, en la misma petición" \
  en_la_misma_peticion <(cuerpos_post) "acme.mailway.directory" ",$OP_CLEAR]"
comprobar "no crea certificate.mailway" no_contiene <(cuerpos_post) "certificate.mailway"
comprobar "limpia el volumen aunque no exista el contenedor del extractor" contiene "$REGISTRO" "compose_q --profile tls run --rm --no-deps -T certs-dumper python /app/extractor.py purgar"
comprobar "no arranca el extractor" no_contiene "$REGISTRO" "up -d --force-recreate certs-dumper"
CF_TOKEN=""
CF_ZONA_NOMBRE=""

echo "# Con Cloudflare y los ficheros del volcador ya borrados: la recarga que activa el ACME no falla"
FAKE_AJUSTES="{\"data\":{$DEFAULT_VOLCADO}}"
CF_TOKEN=cf_token_de_prueba_0123456789
CF_ZONA_NOMBRE=ejemplo.test
FAKE_DEFAULT_ROTO=1
rm -f "$DEFAULT_RETIRADO"
probar_motor
comprobar "da el certificado por configurado" contiene "$SALIDA" "CERT_CONFIGURADO=1"
comprobar "sin avisar de que no se pudo" no_contiene "$SALIDA" "No se pudo configurar la emisión del certificado"
FAKE_DEFAULT_ROTO=0
rm -f "$DEFAULT_RETIRADO"
CF_TOKEN=""
CF_ZONA_NOMBRE=""

echo "# ACME configurado antes (sin Cloudflare) y certificate.default antiguo: se retira"
FAKE_AJUSTES="{\"data\":{\"acme.mailway.directory\":\"https://acme-v02.api.letsencrypt.org/directory\",$DEFAULT_VOLCADO}}"
probar_motor
comprobar "borra certificate.default" contiene <(cuerpos_post) "[$OP_CLEAR]"
comprobar "y limpia el volumen" contiene "$REGISTRO" "extractor.py purgar"

echo "# ACME configurado antes, sin restos de la guía 0.x: nada que borrar ni limpiar"
FAKE_AJUSTES='{"data":{"acme.mailway.directory":"https://acme-v02.api.letsencrypt.org/directory"}}'
probar_motor
comprobar "no borra nada" no_contiene <(cuerpos_post) "clear"
comprobar "no ejecuta el extractor" no_contiene "$REGISTRO" "compose_q"

echo "# Instalación de la 1.0 con el extractor: sigue igual"
FAKE_AJUSTES="{\"data\":{\"certificate.mailway.cert\":\"%{file:$RUTA/cert.pem}%\",\"certificate.mailway.subjects.0\":\"mail.ejemplo.test\"}}"
probar_motor
comprobar "no borra nada" no_contiene <(cuerpos_post) "clear"
comprobar "recrea el extractor" contiene "$REGISTRO" "compose_q --profile tls up -d --force-recreate certs-dumper"

# ---------------------------------------------------- usuarios del webmail --

# docker simulado para la retirada de los contenedores anteriores. El
# contenedor efímero del webmail ejecuta el php de este equipo sobre una base
# SQLite real ($TMP/rcdb hace de /var/roundcube/db).
FAKE_WEBMAIL_ENV=""
FAKE_PHP_FALLA=0
ejecutar_php_simulado() {
  local -a entorno=()
  local codigo=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -e)
        entorno+=("${2//\/var\/roundcube\/db/$TMP/rcdb}")
        shift 2
        ;;
      -r)
        codigo=$2
        shift 2
        ;;
      *) shift ;;
    esac
  done
  env "${entorno[@]}" php -r "$codigo"
}
docker() {
  printf 'docker %s\n' "$*" >>"$REGISTRO"
  case "$*" in
    "inspect --type container mailway-webmail" | "inspect mailway-webmail" | "inspect mailway-mail") [ -n "$FAKE_WEBMAIL_ENV" ] ;;
    "inspect --type container -f {{range .Config.Env}}{{println .}}{{end}} mailway-webmail") printf '%s\n' "$FAKE_WEBMAIL_ENV" ;;
    "inspect --type container -f {{.Image}} mailway-webmail") echo "sha256:0123456789abcdef" ;;
    "inspect mailway-certs-dumper" | "inspect mailway-panel") return 1 ;;
    "rm -f "*) return 0 ;;
    "volume inspect deploy_mailway-webmail-db") return 0 ;;
    "run --rm --network none -v deploy_mailway-webmail-db:/var/roundcube/db "*"--entrypoint php sha256:0123456789abcdef -r "*)
      if [ "$FAKE_PHP_FALLA" = 1 ]; then
        echo "PHP Fatal error:  Uncaught PDOException: SQLSTATE[HY000]: General error: 1 no such table: users"
        return 255
      fi
      ejecutar_php_simulado "$@"
      ;;
    "network inspect mailway-internal") return 1 ;;
    *)
      echo "docker no simulado: $*" >>"$IMPREVISTOS"
      return 1
      ;;
  esac
}

# Base del webmail con el esquema de Roundcube 1.7 (SQL/sqlite.initial.sql).
crear_base_webmail() {
  rm -rf "$TMP/rcdb"
  mkdir -p "$TMP/rcdb"
  php -r '
    $db = new PDO("sqlite:" . $argv[1], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $db->exec("CREATE TABLE users (user_id integer NOT NULL PRIMARY KEY, username varchar(128) NOT NULL default \"\",
      mail_host varchar(128) NOT NULL default \"\", created datetime NOT NULL default \"0000-00-00 00:00:00\",
      last_login datetime DEFAULT NULL, failed_login datetime DEFAULT NULL, failed_login_counter integer DEFAULT NULL,
      language varchar(16), preferences text DEFAULT NULL)");
    $db->exec("CREATE UNIQUE INDEX ix_users_username ON users(username, mail_host)");
    $alta = $db->prepare("INSERT INTO users (user_id, username, mail_host, preferences) VALUES (?, ?, ?, ?)");
    foreach ([
      [1, "ana@ejemplo.test", "mail.ejemplo.test", "firma de Ana"],
      [2, "luis@ejemplo.test", "mail.ejemplo.test", "firma de Luis"],
      [3, "luis@ejemplo.test", "mailway-mail", ""],
      [4, "eva@otra.test", "Mail.Ejemplo.Test", "firma de Eva"],
      [5, "raro@ejemplo.test", "imap.otro.test", ""],
    ] as $fila) { $alta->execute($fila); }
  ' "$TMP/rcdb/sqlite.db"
}
# «user_id username mail_host» de cada usuario, uno por línea.
usuarios_webmail() {
  php -r '
    $db = new PDO("sqlite:" . $argv[1]);
    foreach ($db->query("SELECT user_id, username, mail_host FROM users ORDER BY user_id") as $f) {
      echo $f[0], " ", $f[1], " ", $f[2], "\n";
    }
  ' "$TMP/rcdb/sqlite.db"
}
# Ejecuta retirar_contenedores_anteriores como el instalador (con set -e).
probar_retirada() {
  : >"$REGISTRO"
  (
    set -e
    retirar_contenedores_anteriores
    echo "RETIRADA_TERMINADA"
  ) >"$SALIDA" 2>&1
  CODIGO=$?
}

MIGRAR_CONTENEDORES=1
MAILWAY_WEBMAIL_DB_VOLUME=deploy_mailway-webmail-db
ENV_WEBMAIL_0X=$'ROUNDCUBEMAIL_DEFAULT_HOST=ssl://mail.ejemplo.test\nROUNDCUBEMAIL_DEFAULT_PORT=993\nROUNDCUBEMAIL_DES_KEY=clave-des-secreta-0123\nROUNDCUBEMAIL_DB_TYPE=sqlite'

if php -m 2>/dev/null | grep -qix pdo_sqlite; then
  echo "# Webmail 0.x (ssl://mail.ejemplo.test): sus usuarios pasan a mailway-mail"
  crear_base_webmail
  FAKE_WEBMAIL_ENV=$ENV_WEBMAIL_0X
  probar_retirada
  comprobar "termina bien" igual "$CODIGO" 0
  comprobar "y la retirada sigue hasta el final" contiene "$SALIDA" "RETIRADA_TERMINADA"
  comprobar "con el webmail antiguo ya retirado" despues_de "$REGISTRO" "docker rm -f mailway-webmail" "docker run --rm --network none"
  comprobar "en un contenedor efímero sin red, con la imagen del webmail antiguo" contiene "$REGISTRO" "--entrypoint php sha256:0123456789abcdef"
  comprobar "sobre el volumen de la base que usará el nuevo" contiene "$REGISTRO" "-v deploy_mailway-webmail-db:/var/roundcube/db"
  comprobar "sin pasar el entorno del webmail (con secretos) a otro programa" no_contiene "$REGISTRO" "clave-des-secreta"
  usuarios_webmail >"$TMP/usuarios"
  comprobar "ana conserva su usuario (mismo user_id) con el servidor nuevo" contiene "$TMP/usuarios" "1 ana@ejemplo.test mailway-mail"
  comprobar "también con el nombre en otras mayúsculas" contiene "$TMP/usuarios" "4 eva@otra.test mailway-mail"
  comprobar "luis ya había entrado con la 1.0: se respeta su usuario nuevo" contiene "$TMP/usuarios" "3 luis@ejemplo.test mailway-mail"
  comprobar "y su usuario anterior sigue en la base" contiene "$TMP/usuarios" "2 luis@ejemplo.test mail.ejemplo.test"
  comprobar "no toca otros servidores" contiene "$TMP/usuarios" "5 raro@ejemplo.test imap.otro.test"
  comprobar "dice cuántos se trasladan" contiene "$SALIDA" "Usuarios del webmail trasladados de mail.ejemplo.test a mailway-mail: 2."
  comprobar "y cuántos no" contiene "$SALIDA" "Usuarios del webmail que ya habían entrado por mailway-mail y conservan ese usuario: 1."

  echo "# Repetirlo no cambia nada"
  : >"$REGISTRO"
  (set -e; migrar_usuarios_webmail mail.ejemplo.test sha256:0123456789abcdef) >"$SALIDA" 2>&1
  comprobar "la base queda igual" igual "$(usuarios_webmail)" "$(cat "$TMP/usuarios")"
  comprobar "no dice que traslade a nadie" no_contiene "$SALIDA" "trasladados"

  echo "# Volumen sin base del webmail: no la crea"
  rm -rf "$TMP/rcdb"
  mkdir -p "$TMP/rcdb"
  probar_retirada
  comprobar "termina bien" igual "$CODIGO" 0
  comprobar "no crea una base vacía" no_existe "$TMP/rcdb/sqlite.db"
  comprobar "sin avisos" no_contiene "$SALIDA" "[aviso]"
else
  echo "# Omitidos los casos con la base del webmail: falta php con pdo_sqlite."
fi

echo "# El contenedor efímero falla: avisa y la instalación sigue"
FAKE_WEBMAIL_ENV=$ENV_WEBMAIL_0X
FAKE_PHP_FALLA=1
probar_retirada
comprobar "termina bien" igual "$CODIGO" 0
comprobar "y la retirada sigue hasta el final" contiene "$SALIDA" "RETIRADA_TERMINADA"
comprobar "lo explica" contiene "$SALIDA" "No se pudo trasladar a los usuarios del webmail"
comprobar "con el motivo" contiene "$SALIDA" "no such table: users"
FAKE_PHP_FALLA=0

echo "# Webmail que ya usaba mailway-mail: no se toca su base"
FAKE_WEBMAIL_ENV=$'ROUNDCUBEMAIL_DEFAULT_HOST=ssl://mailway-mail\nROUNDCUBEMAIL_DEFAULT_PORT=993'
probar_retirada
comprobar "termina bien" igual "$CODIGO" 0
comprobar "no ejecuta nada sobre la base" no_contiene "$REGISTRO" "docker run"
comprobar "ni dice nada de sus usuarios" no_contiene "$SALIDA" "entraba al motor por"

echo "# Webmail con otro servidor IMAP: no se toca su base"
FAKE_WEBMAIL_ENV=$'ROUNDCUBEMAIL_DEFAULT_HOST=ssl://imap.otro.test:993'
probar_retirada
comprobar "no ejecuta nada sobre la base" no_contiene "$REGISTRO" "docker run"
comprobar "lo explica" contiene "$SALIDA" "entraba al motor por imap.otro.test"

echo "# Sin migración de contenedores: no se lee ni se toca el webmail"
FAKE_WEBMAIL_ENV=$ENV_WEBMAIL_0X
MIGRAR_CONTENEDORES=0
probar_retirada
comprobar "no lee su entorno" no_contiene "$REGISTRO" "mailway-webmail"
comprobar "no ejecuta nada sobre la base" no_contiene "$REGISTRO" "docker run"
MIGRAR_CONTENEDORES=1

# ------------------------------------------------ override de Traefik --

SKYWAY_DIR="$TMP/skyway"
OVERRIDE="$SKYWAY_DIR/docker-compose.override.yml"
mkdir -p "$SKYWAY_DIR"
PANEL_CONTENEDOR=skyway-mailway-panel
MAILWAY_TRAEFIK_TOKEN=token-traefik-del-instalador
CMD_033='["--providers.docker=true","--entrypoints.web.address=:80"]'
CMD_034='["--providers.docker=true","--entrypoints.web.address=:80","--providers.http.endpoint=http://skyway:4000/api/traefik/mailway"]'
CMD_OVERRIDE='["--providers.docker=true","--providers.http.endpoint=http://mailway-panel:4100/api/traefik/config","--providers.http.headers.X-Mailway-Token=token-del-panel"]'
# Parámetros con los que corre Traefik y si recrearlo los cambia (0) o no (1).
FAKE_CMD=$CMD_034
FAKE_TRAEFIK_ROTO=0
docker() {
  printf 'docker %s\n' "$*" >>"$REGISTRO"
  case "$*" in
    "inspect -f {{json .Config.Cmd}} skyway-traefik") printf '%s\n' "$FAKE_CMD" ;;
    *)
      echo "docker no simulado: $*" >>"$IMPREVISTOS"
      return 1
      ;;
  esac
}
# Como «docker compose up -d traefik» en la carpeta de Skyway: el override
# reemplaza el «command» del compose de Skyway.
recrear_traefik() {
  echo "TRAEFIK_RECREADO" >>"$REGISTRO"
  if [ -f "$OVERRIDE" ]; then
    FAKE_CMD=$CMD_OVERRIDE
  elif [ "$FAKE_TRAEFIK_ROTO" = 0 ] && grep -q 'api/traefik/mailway' "$SKYWAY_DIR/docker-compose.yml"; then
    FAKE_CMD=$CMD_034
  else
    FAKE_CMD=$CMD_033
  fi
}

compose_skyway_034() {
  printf 'services:\n  traefik:\n    command:\n      - --providers.http.endpoint=http://skyway:4000/api/traefik/mailway\n' \
    >"$SKYWAY_DIR/docker-compose.yml"
}
compose_skyway_033() { printf 'services:\n  traefik:\n    command:\n      - --providers.docker=true\n' >"$SKYWAY_DIR/docker-compose.yml"; }
# El bloque que se copiaba de Ajustes → Marca blanca con la guía 0.x.
override_guia_0x() {
  cat >"$OVERRIDE" <<'EOF'
# docker-compose.override.yml — en la carpeta de Skyway.
# Compose lo lee solo; no toca el repositorio de Skyway ni se pierde al actualizar.
services:
  traefik:
    command:
      # --- los flags que Skyway ya usaba (deben mantenerse) ---
      - --providers.docker=true
      - --entrypoints.web.address=:80
      # --- añadido por Mailway: sondea el panel para los dominios de clientes ---
      - --providers.http.endpoint=http://mailway-panel:4100/api/traefik/config
      - --providers.http.pollInterval=15s
      - --providers.http.headers.X-Mailway-Token=token-del-panel
EOF
}
# Ejecuta configurar_proveedor_traefik como el instalador (con set -e).
probar_traefik() {
  : >"$REGISTRO"
  rm -f "$OVERRIDE.mailway-retirado"
  (
    set -e
    configurar_proveedor_traefik
  ) >"$SALIDA" 2>&1
  CODIGO=$?
}
OK_PUENTE="[ok] Skyway sirve a Traefik las rutas de Mailway"

echo "# ¿Qué override es de Mailway?"
override_guia_0x
comprobar "el copiado a mano con la guía 0.x" override_de_mailway "$OVERRIDE"
printf '# docker-compose.override.yml (en la carpeta de Skyway).\nservices:\n  traefik:\n    command:\n      - --providers.http.endpoint=http://skyway-correo-mailway:4100/api/traefik/config\n' >"$OVERRIDE"
comprobar "el del panel actual (Ajustes → Rutas de Traefik)" override_de_mailway "$OVERRIDE"
printf 'services:\n  traefik:\n    command:\n      - --providers.http.headers.X-Mailway-Token=t\n' >"$OVERRIDE"
comprobar "uno con solo la cabecera del token" override_de_mailway "$OVERRIDE"
printf '%s el 2026-01-01.\nservices: {}\n' "$MARCA_OVERRIDE" >"$OVERRIDE"
comprobar "el que generó el instalador" override_de_mailway "$OVERRIDE"
printf 'services:\n  traefik:\n    command:\n      - --api.dashboard=true\n      - --providers.http.endpoint=http://otro:8080/rutas\n' >"$OVERRIDE"
comprobar "no: uno ajeno con otro proveedor HTTP" no_es_de_mailway "$OVERRIDE"
rm -f "$OVERRIDE"

echo "# Skyway 0.34 y el override copiado a mano con la guía 0.x: se retira"
compose_skyway_034
override_guia_0x
cp "$OVERRIDE" "$TMP/override-original"
FAKE_CMD=$CMD_OVERRIDE
SKYWAY_VERSION=0.34.0
MAILWAY_TRAEFIK_PROVEEDOR=1
probar_traefik
comprobar "termina bien" igual "$CODIGO" 0
comprobar "lo retira" no_existe "$OVERRIDE"
comprobar "y lo conserva como copia" cmp -s "$OVERRIDE.mailway-retirado" "$TMP/override-original"
comprobar "recuerda que la copia puede tener ajustes propios" contiene "$SALIDA" "recupéralos de esa copia"
comprobar "recrea Traefik una sola vez" igual "$(grep -c TRAEFIK_RECREADO "$REGISTRO")" 1
comprobar "vuelve a leer sus parámetros" despues_de "$REGISTRO" "TRAEFIK_RECREADO" "inspect -f {{json .Config.Cmd}} skyway-traefik"
comprobar "y solo entonces confirma el puente" contiene "$SALIDA" "$OK_PUENTE"

echo "# Traefik sigue sin el puente después de recrearlo: aviso, sin «ok»"
override_guia_0x
FAKE_CMD=$CMD_OVERRIDE
FAKE_TRAEFIK_ROTO=1
probar_traefik
comprobar "termina bien" igual "$CODIGO" 0
comprobar "lo retira y recrea Traefik" contiene "$REGISTRO" "TRAEFIK_RECREADO"
comprobar "no dice que Skyway sirva las rutas" no_contiene "$SALIDA" "$OK_PUENTE"
comprobar "avisa de que Traefik no las lee" contiene "$SALIDA" "El Traefik de Skyway no lee las rutas de Mailway"
FAKE_TRAEFIK_ROTO=0

echo "# Sin override y Traefik con los parámetros de antes de la 0.34: se recrea y se comprueba"
rm -f "$OVERRIDE"
FAKE_CMD=$CMD_033
probar_traefik
comprobar "recrea Traefik" contiene "$REGISTRO" "TRAEFIK_RECREADO"
comprobar "vuelve a leer sus parámetros" despues_de "$REGISTRO" "TRAEFIK_RECREADO" "inspect -f {{json .Config.Cmd}} skyway-traefik"
comprobar "y, como ya lee el puente, lo confirma" contiene "$SALIDA" "$OK_PUENTE"
FAKE_CMD=$CMD_033
FAKE_TRAEFIK_ROTO=1
probar_traefik
comprobar "si después de recrearlo sigue sin el puente, no lo da por bueno" no_contiene "$SALIDA" "$OK_PUENTE"
comprobar "y lo explica" contiene "$SALIDA" "El Traefik de Skyway no lee las rutas de Mailway"
FAKE_TRAEFIK_ROTO=0

echo "# Se decide mantener el override: no se recrea Traefik en vano ni se da por bueno"
override_guia_0x
FAKE_CMD=$CMD_OVERRIDE
unset MAILWAY_TRAEFIK_PROVEEDOR
: >"$REGISTRO"
(
  set -e
  INTERACTIVO=1
  configurar_proveedor_traefik
) <<<"n" >"$SALIDA" 2>&1
CODIGO=$?
comprobar "termina bien" igual "$CODIGO" 0
comprobar "lo mantiene" existe "$OVERRIDE"
comprobar "lo explica" contiene "$SALIDA" "Se mantiene $OVERRIDE"
comprobar "no recrea Traefik" no_contiene "$REGISTRO" "TRAEFIK_RECREADO"
comprobar "no dice que Skyway sirva las rutas" no_contiene "$SALIDA" "$OK_PUENTE"
comprobar "señala el override" contiene "$SALIDA" "Los sustituye el «command» de $OVERRIDE"
MAILWAY_TRAEFIK_PROVEEDOR=1

echo "# Override ajeno, sin rastro de Mailway: no se toca"
printf 'services:\n  traefik:\n    environment:\n      TZ: Europe/Madrid\n' >"$OVERRIDE"
cp "$OVERRIDE" "$TMP/override-original"
FAKE_CMD=$CMD_034
probar_traefik
comprobar "sigue en su sitio" cmp -s "$OVERRIDE" "$TMP/override-original"
comprobar "no deja copia" no_existe "$OVERRIDE.mailway-retirado"
comprobar "no recrea Traefik" no_contiene "$REGISTRO" "TRAEFIK_RECREADO"
comprobar "confirma el puente" contiene "$SALIDA" "$OK_PUENTE"
rm -f "$OVERRIDE"

echo "# Override generado por el instalador: se sigue retirando"
printf '%s el 2026-01-01.\nservices:\n  traefik:\n    command:\n      - --providers.http.endpoint=http://skyway-mailway-panel:4100/api/traefik/config\n' "$MARCA_OVERRIDE" >"$OVERRIDE"
FAKE_CMD=$CMD_OVERRIDE
probar_traefik
comprobar "lo retira" no_existe "$OVERRIDE"
comprobar "sin aludir a ajustes propios" no_contiene "$SALIDA" "recupéralos de esa copia"
comprobar "confirma el puente" contiene "$SALIDA" "$OK_PUENTE"

echo "# Skyway anterior a la 0.34 y panel con su propio token de Traefik: no se genera el override"
rm -f "$OVERRIDE"
compose_skyway_033
FAKE_CMD=$CMD_033
SKYWAY_VERSION=0.33.0
TRAEFIK_TOKEN_PROPIO=0
probar_traefik
unset TRAEFIK_TOKEN_PROPIO
comprobar "termina bien" igual "$CODIGO" 0
comprobar "no crea el override" no_existe "$OVERRIDE"
comprobar "no recrea Traefik" no_contiene "$REGISTRO" "TRAEFIK_RECREADO"
comprobar "remite al bloque del panel" contiene "$SALIDA" "Ajustes → Rutas de Traefik del panel (antes, Ajustes → Marca blanca)"

echo "# Skyway anterior a la 0.34 con el token del instalador: se genera como antes"
FAKE_CMD=$CMD_033
probar_traefik
comprobar "termina bien" igual "$CODIGO" 0
comprobar "crea el override con la marca del instalador" contiene "$OVERRIDE" "$MARCA_OVERRIDE"
comprobar "con el token del instalador" contiene "$OVERRIDE" "X-Mailway-Token=token-traefik-del-instalador"
comprobar "y recrea Traefik" contiene "$REGISTRO" "TRAEFIK_RECREADO"
rm -f "$OVERRIDE"

echo "# Ningún doble ha recibido una llamada que no esperaba"
comprobar "ninguna llamada sin simular" igual "$(cat "$IMPREVISTOS")" ""

echo
TERMINADA=1
if [ "$FALLOS" -gt 0 ]; then
  echo "$FALLOS comprobaciones han fallado."
  exit 1
fi
echo "Todas las comprobaciones son correctas."
