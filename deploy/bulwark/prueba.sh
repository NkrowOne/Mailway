#!/usr/bin/env bash
#
# Ensayo con contenedores reales de Bulwark para Mailway: Stalwart 0.16,
# Bulwark, la pasarela (nginx) y Traefik, como en producción pero con
# nombres de prueba. Comprueba:
#   - salud de Bulwark y de la pasarela, HSTS y cabeceras;
#   - 404 en la administración y el asistente para el tráfico público, y que
#     el panel sí llega a la API de administración por la red interna;
#   - la marca por dominio aplicada con el cliente de
#     server/src/modules/bulwark.ts (dos veces: la segunda no escribe) y
#     visible con Host: webmail.cliente.test; la marca de la instancia en un
#     nombre sin marca propia; la política de Mailway;
#   - acceso con un buzón ($6$): contraseña buena y mala; lectura de la
#     bandeja por el mismo camino que el navegador (JMAP con CORS);
#   - IP real: Bulwark recibe UNA sola IP (salto directo, nodo de
#     Cloudflare con CF-Connecting-IP, intentos de falsificarla);
#   - bloqueo automático del motor: un cliente sin exención queda bloqueado;
#     40 accesos fallidos a través de Bulwark no bloquean su IP (red exenta);
#     cómo cuenta el motor los fallos por buzón;
#   - el oráculo de contraseñas de /api/auth/stalwart-context y el límite de
#     la pasarela que lo frena;
#   - la cabecera Forwarded que Traefik deja pasar hasta el motor y el
#     middleware que la retira;
#   - CORS del motor para el origen del webmail;
#   - con Playwright, un Chromium real (prueba-navegador.cjs) y, con
#     MWB_PESTANA_SEGUNDOS, la pestaña abierta tras cambiar la contraseña.
#
#   bash deploy/bulwark/prueba.sh              # código 1 si alguna comprobación falla
#   bash deploy/bulwark/prueba.sh --conservar  # deja la pila en marcha para mirarla
#   bash deploy/bulwark/prueba.sh --retirar    # retira una pila conservada
#   MWB_PLAYWRIGHT=/ruta/node_modules/playwright MWB_PESTANA_SEGUNDOS=300 bash deploy/bulwark/prueba.sh
#
# Necesita docker, curl, jq, openssl y node ≥ 20 con las dependencias del
# repositorio instaladas (npm ci): la marca se aplica con el cliente del panel.
#
# Solo crea (y borra al terminar) lo suyo: contenedores, redes y volúmenes
# mwb-* con la etiqueta mailway.ensayo=bulwark, y publica únicamente puertos
# de 127.0.0.1:22000-22999. Las subredes se pueden cambiar si chocan con
# otras (MWB_SUBRED_*). El «nodo de Cloudflare» es un contenedor con una IP
# de un rango de Cloudflare (MWB_SUBRED_CF, una /29): mientras dura el
# ensayo, este equipo no llega a esas 8 direcciones reales.

set -uo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RAIZ=$(cd "$AQUI/../.." && pwd)
CONSERVAR=0
[ "${1:-}" = "--conservar" ] && CONSERVAR=1

# Imágenes fijadas (las mismas que el README; las pruebas del servidor lo exigen).
IMAGEN_STALWART=stalwartlabs/stalwart:v0.16.25@sha256:74e5a7d55303ba525d939c6bf97ed4e010df7521f52d80afc22a815b66bd53f3
IMAGEN_BULWARK=ghcr.io/bulwarkmail/webmail:1.13.0@sha256:cc85f569396b6eb1d3f8cf41311b7512cf6b943fa28a8844a27edaeb2daae1ed
IMAGEN_NGINX=nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94
IMAGEN_TRAEFIK=traefik:v3.7.14@sha256:575fa15b135078fe5e50aa847987d96dbddd7b093c172429618404df73f3fa7c

ETIQUETA=mailway.ensayo=bulwark
SUBRED_INTERNA=${MWB_SUBRED_INTERNA:-10.222.53.0/24}
SUBRED_BORDE=${MWB_SUBRED_BORDE:-10.222.54.0/24}
SUBRED_ECO=${MWB_SUBRED_ECO:-10.222.55.0/24}
SUBRED_CALLE=${MWB_SUBRED_CALLE:-10.222.56.0/24}
SUBRED_CF=${MWB_SUBRED_CF:-131.0.75.240/29}
PUERTO_MOTOR=${MWB_PUERTO_MOTOR:-22080}
PUERTO_BULWARK=${MWB_PUERTO_BULWARK:-22030}
PUERTO_TRAEFIK=${MWB_PUERTO_TRAEFIK:-22443}

# Primeros tres octetos de cada /24 y de la /29 de Cloudflare.
pre() { local s=${1%/*}; echo "${s%.*}"; }
I=$(pre "$SUBRED_INTERNA")
B=$(pre "$SUBRED_BORDE")
E=$(pre "$SUBRED_ECO")
C=$(pre "$SUBRED_CALLE")
CF_BASE=${SUBRED_CF%/*}
CF_PRE=${CF_BASE%.*}
CF_ULTIMO=${CF_BASE##*.}
IP_MOTOR=$I.10
IP_MOTOR_BORDE=$B.10
IP_BULWARK=$I.20
IP_TRAEFIK_BORDE=$B.5
IP_TRAEFIK_ECO=$E.5
IP_TRAEFIK_CALLE=$C.5
IP_TRAEFIK_CF=$CF_PRE.$((CF_ULTIMO + 2))
IP_CF_1=$CF_PRE.$((CF_ULTIMO + 3))

CONTENEDORES=(mwb-stalwart mwb-bulwark mwb-pasarela mwb-pasarela-eco mwb-eco mwb-traefik)
REDES=(mwb-interna mwb-borde mwb-eco mwb-calle mwb-cf)
VOLUMENES=(mwb-bulwark-ajustes mwb-bulwark-admin mwb-bulwark-estado mwb-stalwart-datos mwb-stalwart-etc)

for programa in docker curl jq openssl node; do
  command -v "$programa" >/dev/null 2>&1 || { echo "Falta $programa." >&2; exit 1; }
done
[ -d "$RAIZ/node_modules/tsx" ] || { echo "Faltan las dependencias del repositorio: ejecuta npm ci en $RAIZ." >&2; exit 1; }

TMP=$(mktemp -d)
FALLOS=0
TERMINADA=0

# Solo lo que lleva la etiqueta del ensayo: nunca un contenedor ajeno.
retirar() {
  local nombre
  for nombre in "${CONTENEDORES[@]}"; do
    [ "$(docker inspect -f '{{index .Config.Labels "mailway.ensayo"}}' "$nombre" 2>/dev/null)" = bulwark ] &&
      docker rm -f "$nombre" >/dev/null 2>&1
  done
  for nombre in $(docker ps -aq --filter "label=$ETIQUETA" --filter 'name=^mwb-'); do
    docker rm -f "$nombre" >/dev/null 2>&1
  done
  for nombre in "${REDES[@]}"; do
    [ "$(docker network inspect -f '{{index .Labels "mailway.ensayo"}}' "$nombre" 2>/dev/null)" = bulwark ] &&
      docker network rm "$nombre" >/dev/null 2>&1
  done
  for nombre in "${VOLUMENES[@]}"; do
    [ "$(docker volume inspect -f '{{index .Labels "mailway.ensayo"}}' "$nombre" 2>/dev/null)" = bulwark ] &&
      docker volume rm "$nombre" >/dev/null 2>&1
  done
  return 0
}
al_salir() {
  if [ "$CONSERVAR" = 1 ]; then
    # Traefik y Bulwark montan ficheros de $TMP: se quedan con la pila.
    echo "Pila conservada (--conservar), con sus ficheros en $TMP. Para retirarla: bash $0 --retirar && rm -rf $TMP" >&2
  else
    retirar
    rm -rf "$TMP"
  fi
  [ "$TERMINADA" = 1 ] || echo "FALLO - el ensayo terminó antes de tiempo" >&2
}
if [ "${1:-}" = "--retirar" ]; then
  retirar
  rm -rf "$TMP"
  exit 0
fi
trap al_salir EXIT

ok() { printf 'ok - %s\n' "$1"; }
fallo() {
  printf 'FALLO - %s\n' "$1"
  [ -n "${2:-}" ] && printf '        %s\n' "$2"
  FALLOS=$((FALLOS + 1))
}
# comprobar «descripción» «esperado» «obtenido»
comprobar() {
  if [ "$2" = "$3" ]; then ok "$1"; else fallo "$1" "esperado «$2», obtenido «$3»"; fi
}
# contiene «descripción» «texto» «fragmento»
contiene() {
  if [[ $2 == *"$3"* ]]; then ok "$1"; else fallo "$1" "no aparece «$3» en «${2:0:300}»"; fi
}
no_contiene() {
  if [[ $2 != *"$3"* ]]; then ok "$1"; else fallo "$1" "aparece «$3»"; fi
}
seccion() { printf '\n# %s\n' "$1"; }
detener() {
  echo "$1" >&2
  exit 1
}

# Imagen fijada: del registro y, si Docker Hub limita las descargas, del espejo
# de Google (mismo digest, así que es la misma imagen).
traer() {
  local imagen=$1 espejo id
  docker image inspect "$imagen" >/dev/null 2>&1 && return 0
  docker pull -q "$imagen" >/dev/null 2>&1 && return 0
  case $imagen in
    ghcr.io/*) return 1 ;;
    */*) espejo="mirror.gcr.io/$imagen" ;;
    *) espejo="mirror.gcr.io/library/$imagen" ;;
  esac
  docker pull -q "$espejo" >/dev/null 2>&1 || return 1
  # Con el nombre de Docker Hub, la referencia fijada (nombre:etiqueta@digest)
  # se resuelve en local.
  id=$(docker image inspect -f '{{.Id}}' "$espejo") || return 1
  docker tag "$id" "${imagen%@*}" && docker image inspect "$imagen" >/dev/null 2>&1
}

esperar() { # esperar «qué» «orden…»: hasta 90 s
  local que=$1 i
  shift
  for i in $(seq 1 90); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 1
  done
  detener "No responde: $que"
}

# Cliente en una red, con una IP concreta, que resuelve los nombres de la
# prueba hacia Traefik y confía en la CA de prueba. El guion llega por la
# entrada estándar. La imagen del motor trae bash y curl.
cliente() {
  local red=$1 ip=$2 traefik
  shift 2
  case $red in
    mwb-calle) traefik=$IP_TRAEFIK_CALLE ;;
    mwb-cf) traefik=$IP_TRAEFIK_CF ;;
    mwb-eco) traefik=$IP_TRAEFIK_ECO ;;
    *) traefik=$IP_TRAEFIK_BORDE ;;
  esac
  docker run --rm -i --label "$ETIQUETA" --network "$red" --ip "$ip" \
    --add-host "webmail.cliente.test:$traefik" --add-host "webmail.otro.test:$traefik" \
    --add-host "eco.cliente.test:$traefik" --add-host "mail.mwb.test:$traefik" \
    --add-host "mail-crudo.mwb.test:$traefik" \
    -v "$TMP/tls/ca.pem:/ca.pem:ro" "$@" --entrypoint bash "$IMAGEN_STALWART" -s
}

# Llamada JMAP de administración al motor (administrador de recuperación).
jmap() {
  curl -sS -u "admin:$CLAVE_MOTOR" -H 'Content-Type: application/json' \
    "http://127.0.0.1:$PUERTO_MOTOR/jmap" -d "$1"
}
# Igual, pero falla si algún método o elemento devuelve error.
jmap_ok() {
  local respuesta
  respuesta=$(jmap "$1") || return 1
  if [ "$(jq '[.methodResponses[]? | select(.[0] == "error" or (.[1].notCreated // {} | length > 0) or (.[1].notUpdated // {} | length > 0))] | length' <<<"$respuesta" 2>/dev/null)" != 0 ]; then
    echo "$respuesta" >&2
    return 1
  fi
  printf '%s' "$respuesta"
}
USING='"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"]'

retirar

# ---------------------------------------------------------------- Preparar --

seccion 'Imágenes'
for imagen in "$IMAGEN_STALWART" "$IMAGEN_BULWARK" "$IMAGEN_NGINX" "$IMAGEN_TRAEFIK"; do
  traer "$imagen" || detener "No se pudo descargar $imagen."
  ok "imagen $imagen"
done

# CA y certificado de prueba para todos los nombres (Traefik y el 443 del motor).
mkdir -p "$TMP/tls" "$TMP/traefik"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
  -keyout "$TMP/tls/ca.key" -out "$TMP/tls/ca.pem" -subj '/CN=CA del ensayo de Mailway' >/dev/null 2>&1
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj '/CN=mail.mwb.test' \
  -keyout "$TMP/tls/servidor.key" -out "$TMP/tls/servidor.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:mail.mwb.test,DNS:mail-crudo.mwb.test,DNS:webmail.cliente.test,DNS:webmail.otro.test,DNS:eco.cliente.test\nextendedKeyUsage=serverAuth\n' >"$TMP/tls/ext.cnf"
openssl x509 -req -in "$TMP/tls/servidor.csr" -CA "$TMP/tls/ca.pem" -CAkey "$TMP/tls/ca.key" -CAcreateserial \
  -days 2 -extfile "$TMP/tls/ext.cnf" -out "$TMP/tls/servidor.pem" >/dev/null 2>&1 || detener 'No se pudo crear el certificado de prueba.'
chmod 644 "$TMP/tls/"*

seccion 'Redes'
crear_red() {
  docker network create --label "$ETIQUETA" --subnet "$2" "$1" >/dev/null 2>"$TMP/red.err" ||
    detener "No se pudo crear la red $1 ($2): $(cat "$TMP/red.err"). Cambia MWB_SUBRED_*."
}
crear_red mwb-interna "$SUBRED_INTERNA"
crear_red mwb-borde "$SUBRED_BORDE"
crear_red mwb-eco "$SUBRED_ECO"
crear_red mwb-calle "$SUBRED_CALLE"
crear_red mwb-cf "$SUBRED_CF"
ok "redes mwb-* (exenta $SUBRED_INTERNA, Cloudflare $SUBRED_CF)"

# ------------------------------------------------------------------- Motor --

seccion 'Motor (Stalwart 0.16)'
CLAVE_MOTOR=$(openssl rand -hex 16)
for v in mwb-stalwart-datos mwb-stalwart-etc; do docker volume create --label "$ETIQUETA" "$v" >/dev/null; done
docker run -d --name mwb-stalwart --label "$ETIQUETA" --hostname mail.mwb.test \
  --network mwb-interna --ip "$IP_MOTOR" -p "127.0.0.1:$PUERTO_MOTOR:8080" \
  -v mwb-stalwart-datos:/var/lib/stalwart -v mwb-stalwart-etc:/etc/stalwart \
  -e STALWART_RECOVERY_ADMIN="admin:$CLAVE_MOTOR" "$IMAGEN_STALWART" >/dev/null || detener 'No arranca el motor.'
docker network connect --ip "$IP_MOTOR_BORDE" mwb-borde mwb-stalwart
esperar 'el motor (arranque inicial)' curl -fsS "http://127.0.0.1:$PUERTO_MOTOR/healthz/live"
jmap_ok "{$USING,\"methodCalls\":[[\"x:Bootstrap/set\",{\"update\":{\"singleton\":{\"serverHostname\":\"mail.mwb.test\",\"defaultDomain\":\"mwb.test\",\"requestTlsCertificate\":false,\"generateDkimKeys\":false,\"tracer\":{\"@type\":\"Stdout\"}}}},\"c\"]]}" >/dev/null ||
  detener 'Falla el arranque inicial del motor (x:Bootstrap).'
docker restart mwb-stalwart >/dev/null
esperar 'el motor (tras el arranque inicial)' curl -fsS "http://127.0.0.1:$PUERTO_MOTOR/healthz/ready"
ok 'motor arrancado y configurado (x:Bootstrap y reinicio)'

CLAVE_ANA="Prueba-Ana-$(openssl rand -hex 6)"
HASH_ANA=$(openssl passwd -6 "$CLAVE_ANA")
R=$(jmap_ok "{$USING,\"methodCalls\":[[\"x:Domain/set\",{\"create\":{\"d\":{\"name\":\"cliente.test\"}}},\"a\"]]}") || detener 'No se pudo crear el dominio.'
DOMINIO=$(jq -r '.methodResponses[0][1].created.d.id' <<<"$R")
jmap_ok "$(jq -n --arg d "$DOMINIO" --arg h "$HASH_ANA" "{$USING,\"methodCalls\":[[\"x:Account/set\",{\"create\":{\"u\":{\"@type\":\"User\",\"name\":\"ana\",\"domainId\":\$d,\"description\":\"Ana de Cliente\",\"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":\$h}}}}},\"a\"]]}")" >/dev/null ||
  detener 'No se pudo crear el buzón.'
ok "dominio cliente.test y buzón ana@cliente.test con hash \$6\$ (JMAP)"

# Ajustes que Bulwark necesita del motor: CORS para el origen de cada
# webmail, IP real detrás de Traefik, la red de Bulwark exenta del bloqueo y
# el certificado de MAIL_HOSTNAME en el 443 interno. Umbral de bloqueo bajo
# (10 fallos) para que el ensayo lo alcance.
R=$(jmap_ok "$(jq -n --rawfile c "$TMP/tls/servidor.pem" --rawfile k "$TMP/tls/servidor.key" --arg red "$SUBRED_INTERNA" "{$USING,\"methodCalls\":[
  [\"x:Http/set\",{\"update\":{\"singleton\":{\"usePermissiveCors\":true,\"useXForwarded\":true}}},\"a\"],
  [\"x:AllowedIp/set\",{\"create\":{\"i\":{\"address\":\$red,\"reason\":\"Red interna de Mailway (Bulwark)\"}}},\"b\"],
  [\"x:Security/set\",{\"update\":{\"singleton\":{\"authBanRate\":{\"count\":10,\"period\":86400000}}}},\"c\"],
  [\"x:Certificate/set\",{\"create\":{\"k\":{\"certificate\":{\"@type\":\"Text\",\"value\":\$c},\"privateKey\":{\"@type\":\"Text\",\"secret\":\$k}}}},\"d\"]]}")") ||
  detener 'No se pudieron aplicar los ajustes del motor.'
CERTIFICADO=$(jq -r '.methodResponses[3][1].created.k.id' <<<"$R")
jmap_ok "{$USING,\"methodCalls\":[[\"x:SystemSettings/set\",{\"update\":{\"singleton\":{\"defaultCertificateId\":\"$CERTIFICADO\"}}},\"a\"],[\"x:Action/set\",{\"create\":{\"r\":{\"@type\":\"ReloadSettings\"},\"t\":{\"@type\":\"ReloadTlsCertificates\"}}},\"b\"]]}" >/dev/null ||
  detener 'No se pudieron recargar los ajustes del motor.'
ok 'motor: CORS permisivo, X-Forwarded, red exenta, umbral de 10 fallos y certificado en el 443'

# Un mensaje en la bandeja de entrada (subida y Email/import como el titular).
dejar_mensaje() { # dejar_mensaje <buzón> <contraseña> <asunto>
  local buzon=$1 clave=$2 asunto=$3 cuenta blob bandeja r
  printf 'From: Remitente <remitente@ejemplo.test>\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%s@ejemplo.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHola.\r\n' \
    "$buzon" "$asunto" "$(date -R)" "$(openssl rand -hex 8)" >"$TMP/mensaje.eml"
  cuenta=$(curl -sS -u "$buzon:$clave" "http://127.0.0.1:$PUERTO_MOTOR/jmap/session" | jq -r '.primaryAccounts["urn:ietf:params:jmap:mail"]')
  blob=$(curl -sS -u "$buzon:$clave" -H 'Content-Type: message/rfc822' --data-binary "@$TMP/mensaje.eml" \
    "http://127.0.0.1:$PUERTO_MOTOR/jmap/upload/$cuenta/" | jq -r .blobId)
  bandeja=$(curl -sS -u "$buzon:$clave" -H 'Content-Type: application/json' "http://127.0.0.1:$PUERTO_MOTOR/jmap" \
    -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Mailbox/query\",{\"accountId\":\"$cuenta\",\"filter\":{\"role\":\"inbox\"}},\"a\"]]}" |
    jq -r '.methodResponses[0][1].ids[0]')
  r=$(curl -sS -u "$buzon:$clave" -H 'Content-Type: application/json' "http://127.0.0.1:$PUERTO_MOTOR/jmap" \
    -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/import\",{\"accountId\":\"$cuenta\",\"emails\":{\"m\":{\"blobId\":\"$blob\",\"mailboxIds\":{\"$bandeja\":true},\"keywords\":{}}}},\"a\"]]}")
  [ "$(jq -r '.methodResponses[0][1].created.m.id // empty' <<<"$r")" != "" ] || detener "No se pudo dejar el mensaje de prueba: $r"
}
ASUNTO="Prueba de Bulwark $(openssl rand -hex 4)"
dejar_mensaje ana@cliente.test "$CLAVE_ANA" "$ASUNTO"
ok 'mensaje de prueba en la bandeja de entrada de ana'

# Un segundo buzón, limpio, para el navegador (al final del ensayo).
CLAVE_EVA="Prueba-Eva-$(openssl rand -hex 6)"
R=$(jmap_ok "$(jq -n --arg d "$DOMINIO" --arg h "$(openssl passwd -6 "$CLAVE_EVA")" "{$USING,\"methodCalls\":[[\"x:Account/set\",{\"create\":{\"u\":{\"@type\":\"User\",\"name\":\"eva\",\"domainId\":\$d,\"description\":\"Eva de Cliente\",\"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":\$h}}}}},\"a\"]]}")") ||
  detener 'No se pudo crear el segundo buzón.'
CUENTA_EVA=$(jq -r '.methodResponses[0][1].created.u.id' <<<"$R")
ASUNTO_EVA="Hola Eva $(openssl rand -hex 4)"
dejar_mensaje eva@cliente.test "$CLAVE_EVA" "$ASUNTO_EVA"
ok 'segundo buzón (eva@cliente.test) con su mensaje'

# ----------------------------------------------------------------- Bulwark --

seccion 'Bulwark y pasarela'
CLAVE_ADMIN_BULWARK=$(openssl rand -hex 24)
# Marca propia del cliente de prueba, servida por Bulwark en su mismo origen.
# Next.js solo sirve los ficheros de public/ que existen al arrancar: por eso
# se montan antes (en producción, la marca de cada cliente va por https o por
# la subida de la API de administración de Bulwark; ver README).
mkdir -p "$TMP/marca-clientes/cliente"
printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#7a2e8c"/></svg>\n' \
  | tee "$TMP/marca-clientes/cliente/logo.svg" >"$TMP/marca-clientes/cliente/favicon.svg"
chmod -R a+rX "$TMP/marca-clientes"
for v in mwb-bulwark-ajustes mwb-bulwark-admin mwb-bulwark-estado; do docker volume create --label "$ETIQUETA" "$v" >/dev/null; done
# Como en producción: raíz en solo lectura, sin capacidades, en la red exenta
# y con el nombre del motor apuntando a su IP interna (las comprobaciones de
# acceso de Bulwark salen desde esa red).
docker run -d --name mwb-bulwark --label "$ETIQUETA" \
  --network mwb-interna --ip "$IP_BULWARK" -p "127.0.0.1:$PUERTO_BULWARK:3000" \
  --add-host "mail.mwb.test:$IP_MOTOR" \
  --read-only --tmpfs /tmp:size=64m --tmpfs /app/.next/cache:size=64m,uid=1001,gid=1001 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --env-file "$AQUI/bulwark.env" \
  -e JMAP_SERVER_URL=https://mail.mwb.test \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e ADMIN_PASSWORD="$CLAVE_ADMIN_BULWARK" \
  -e APP_NAME='Correo Mailway' \
  -e LOGIN_WEBSITE_URL=https://panel.mwb.test/mi-buzon \
  -e NODE_EXTRA_CA_CERTS=/etc/mailway/ca.pem \
  -v "$TMP/tls/ca.pem:/etc/mailway/ca.pem:ro" \
  -v "$AQUI/marca/mailway:/app/public/branding/mailway:ro" \
  -v "$TMP/marca-clientes:/app/public/branding/clientes:ro" \
  -v mwb-bulwark-ajustes:/app/data/settings -v mwb-bulwark-admin:/app/data/admin -v mwb-bulwark-estado:/app/data/admin-state \
  "$IMAGEN_BULWARK" >/dev/null || detener 'No arranca Bulwark.'
docker network connect --alias mailway-bulwark mwb-borde mwb-bulwark
esperar 'Bulwark' curl -fsS "http://127.0.0.1:$PUERTO_BULWARK/api/health"

# Pasarela de producción (delante de Bulwark) y otra igual delante de un eco
# que devuelve las cabeceras recibidas: así se ve exactamente lo que le llega.
arrancar_pasarela() {
  docker run -d --name "$1" --label "$ETIQUETA" --network "$2" --ip "$3" \
    --user 101:101 --read-only --tmpfs /tmp:size=64m --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$AQUI/nginx:/etc/nginx/mailway:ro" "$IMAGEN_NGINX" \
    nginx -c /etc/nginx/mailway/nginx.conf -g 'daemon off;' >/dev/null
}
arrancar_pasarela mwb-pasarela mwb-borde "$B.30" || detener 'No arranca la pasarela.'
docker run -d --name mwb-eco --label "$ETIQUETA" --network mwb-eco --ip "$E.40" --network-alias mailway-bulwark \
  --entrypoint node "$IMAGEN_BULWARK" \
  -e "require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify(q.headers))}).listen(3000)" >/dev/null
arrancar_pasarela mwb-pasarela-eco mwb-eco "$E.30" || detener 'No arranca la pasarela de eco.'

# Traefik como el de Skyway (sin trustedIPs). mail.mwb.test lleva el
# middleware que retira Forwarded; mail-crudo.mwb.test es el mismo motor sin él.
cat >"$TMP/traefik/dinamica.yml" <<EOF
http:
  middlewares:
    mailway-mail-sin-forwarded:
      headers:
        customRequestHeaders:
          Forwarded: ""
  routers:
    webmail:
      rule: Host(\`webmail.cliente.test\`) || Host(\`webmail.otro.test\`)
      entryPoints: [websecure]
      service: pasarela
      tls: {}
    eco:
      rule: Host(\`eco.cliente.test\`)
      entryPoints: [websecure]
      service: pasarela-eco
      tls: {}
    motor:
      rule: Host(\`mail.mwb.test\`)
      entryPoints: [websecure]
      service: motor
      middlewares: [mailway-mail-sin-forwarded]
      tls: {}
    motor-crudo:
      rule: Host(\`mail-crudo.mwb.test\`)
      entryPoints: [websecure]
      service: motor
      tls: {}
  services:
    pasarela:
      loadBalancer:
        servers:
          - url: http://mwb-pasarela:8080
    pasarela-eco:
      loadBalancer:
        servers:
          - url: http://mwb-pasarela-eco:8080
    motor:
      loadBalancer:
        servers:
          - url: http://mwb-stalwart:8080
tls:
  stores:
    default:
      defaultCertificate:
        certFile: /etc/traefik/tls/servidor.pem
        keyFile: /etc/traefik/tls/servidor.key
EOF
docker run -d --name mwb-traefik --label "$ETIQUETA" --network mwb-borde --ip "$IP_TRAEFIK_BORDE" -p "127.0.0.1:$PUERTO_TRAEFIK:443" \
  -v "$TMP/traefik:/etc/traefik/dinamica:ro" -v "$TMP/tls:/etc/traefik/tls:ro" "$IMAGEN_TRAEFIK" \
  --entrypoints.websecure.address=:443 --providers.file.directory=/etc/traefik/dinamica --log.level=ERROR >/dev/null ||
  detener 'No arranca Traefik.'
docker network connect --ip "$IP_TRAEFIK_ECO" mwb-eco mwb-traefik
docker network connect --ip "$IP_TRAEFIK_CALLE" mwb-calle mwb-traefik
docker network connect --ip "$IP_TRAEFIK_CF" mwb-cf mwb-traefik
sleep 3

# -------------------------------------------------------------- Salud --

seccion 'Salud y cabeceras'
SALIDA=$(cliente mwb-calle "$C.50" <<'EOF'
curl -sS -D - -o /dev/null --cacert /ca.pem https://webmail.cliente.test/api/health
echo "CUERPO $(curl -sS --cacert /ca.pem https://webmail.cliente.test/api/health)"
EOF
)
contiene 'Bulwark sano a través de Traefik y la pasarela' "$SALIDA" '"status":"healthy"'
contiene 'HSTS en las respuestas de la pasarela' "$SALIDA" 'strict-transport-security: max-age=31536000'
no_contiene 'sin X-Powered-By' "${SALIDA,,}" 'x-powered-by'
comprobar 'salud propia de la pasarela (solo dentro del contenedor)' 'ok' \
  "$(docker exec mwb-pasarela wget -qO- http://127.0.0.1:8081/salud 2>/dev/null)"
comprobar 'la pasarela corre sin privilegios (usuario 101)' '101' "$(docker exec mwb-pasarela id -u 2>/dev/null)"

# --------------------------------------------------- Superficies de admin --

seccion 'Administración y asistente'
SALIDA=$(cliente mwb-calle "$C.50" <<'EOF'
for ruta in /admin /admin/ /admin/login /Admin //admin /admin/../admin /es/admin /setup /setup/ \
  /api/admin/auth /api/admin/config /api/admin/%61uth /API/ADMIN/config /api/%61dmin/config \
  /api/admin/plugins /api/admin/themes /api/admin/telemetry /api/admin/version /api/admin/audit \
  /api/setup/status /api/setup/token /api/auth/impersonate /api/account/stalwart/jmap /api/dev-jmap/x; do
  printf '%s %s\n' "$ruta" "$(curl -sS -o /dev/null -w '%{http_code}' --path-as-is --cacert /ca.pem "https://webmail.cliente.test$ruta")"
done
printf 'POST-auth %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --cacert /ca.pem -H 'content-type: application/json' -d '{"password":"x"}' https://webmail.cliente.test/api/admin/auth)"
printf 'PUT-politica %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --cacert /ca.pem -X PUT -H 'content-type: application/json' -d '{}' https://webmail.cliente.test/api/admin/policy)"
printf 'GET-politica %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --cacert /ca.pem https://webmail.cliente.test/api/admin/policy)"
printf 'Next-Action %s\n' "$(curl -sS -o /dev/null -w '%{http_code}' --cacert /ca.pem -X POST -H 'Next-Action: 0123456789abcdef' -d '[]' https://webmail.cliente.test/es/login)"
EOF
)
BLOQUEADAS=$(awk '$1 !~ /^(PUT|GET|POST|Next)/ && $2 != "404" {print}' <<<"$SALIDA")
if [ -z "$BLOQUEADAS" ] && [ "$(grep -c ' 404$' <<<"$SALIDA")" -ge 24 ]; then
  ok 'administración, asistente, suplantación y paso x: devuelven 404 por la pasarela (también %XX, mayúsculas, // y ..)'
else
  fallo 'administración y asistente bloqueados por la pasarela' "$(tr '\n' ' ' <<<"$BLOQUEADAS")"
fi
comprobar 'inicio de sesión de administración: 404 por la pasarela' 'POST-auth 404' "$(grep '^POST-auth' <<<"$SALIDA")"
comprobar 'la política no se puede escribir por la pasarela' 'PUT-politica 404' "$(grep '^PUT-politica' <<<"$SALIDA")"
comprobar 'la política se puede leer (el correo web la necesita)' 'GET-politica 200' "$(grep '^GET-politica' <<<"$SALIDA")"
comprobar 'acciones de servidor de Next.js rechazadas' 'Next-Action 404' "$(grep '^Next-Action' <<<"$SALIDA")"

# Por dentro (como el panel): la administración existe y responde.
comprobar 'por la red interna: /admin existe' '200' "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PUERTO_BULWARK/admin")"
comprobar 'por la red interna: la API de administración pide sesión' '401' "$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PUERTO_BULWARK/api/admin/config")"
comprobar 'por la red interna: administración activa solo con contraseña' 'true false' \
  "$(curl -sS "http://127.0.0.1:$PUERTO_BULWARK/api/admin/auth" | jq -r '"\(.enabled) \(.stalwartAutoLogin)"')"

# ------------------------------------------------------------------ Marca --

seccion 'Marca y política (cliente del panel)'
GUION_MARCA=$(cat <<'EOF'
const m = require('./src/modules/bulwark.ts');
(async () => {
  const cliente = new m.ClienteAdminBulwark({ url: process.env.MWB_URL, contrasena: process.env.MWB_CLAVE });
  const deseado = {
    marca: m.marcaPorHostBulwark([{
      host: 'webmail.cliente.test',
      nombre: 'Correo de Cliente',
      empresa: 'Cliente S.L.',
      logoClaroUrl: '/branding/clientes/cliente/logo.svg',
      faviconUrl: '/branding/clientes/cliente/favicon.svg',
      colorTema: '#0d5c5e',
      miBuzonUrl: 'https://panel.cliente.test/mi-buzon',
    }]),
    politica: m.politicaBulwark({ miBuzonUrl: 'https://panel.mwb.test/mi-buzon' }),
  };
  const primera = await m.sincronizarBulwark(cliente, deseado);
  const segunda = await m.sincronizarBulwark(cliente, deseado);
  console.log(JSON.stringify({ primera, segunda, huella: m.huellaBulwark(deseado) }));
})().catch((err) => {
  console.error(`${err.code}: ${err.message}`);
  process.exit(1);
});
EOF
)
if SALIDA=$(cd "$RAIZ/server" && MWB_URL="http://127.0.0.1:$PUERTO_BULWARK" MWB_CLAVE="$CLAVE_ADMIN_BULWARK" \
  node --import tsx -e "$GUION_MARCA" 2>&1); then
  comprobar 'primera sincronización: escribe marca y política' 'true true []' \
    "$(jq -r '"\(.primera.marcaCambiada) \(.primera.politicaCambiada) \(.primera.clavesFijadas)"' <<<"$SALIDA")"
  comprobar 'segunda sincronización: no escribe nada (idempotente)' 'false false' \
    "$(jq -r '"\(.segunda.marcaCambiada) \(.segunda.politicaCambiada)"' <<<"$SALIDA")"
  comprobar 'la huella devuelta es la del estado deseado' "$(jq -r .huella <<<"$SALIDA")" "$(jq -r .segunda.huella <<<"$SALIDA")"
else
  fallo 'el cliente del panel aplica la marca' "$SALIDA"
fi
comprobar 'un solo inicio de sesión de administración para las dos sincronizaciones' '1' \
  "$(docker exec mwb-bulwark cat /app/data/admin-state/audit.log 2>/dev/null | grep -c '"action":"admin.login",')"

SALIDA=$(cliente mwb-calle "$C.50" <<'EOF'
echo "CLIENTE $(curl -sS --cacert /ca.pem https://webmail.cliente.test/api/config)"
echo "OTRO $(curl -sS --cacert /ca.pem https://webmail.otro.test/api/config)"
echo "TITULO $(curl -sS --cacert /ca.pem -H 'Accept-Language: es' https://webmail.cliente.test/es/login | grep -o '<title>[^<]*</title>')"
echo "LOGO $(curl -sS -o /dev/null -w '%{http_code} %{content_type}' --cacert /ca.pem https://webmail.otro.test/branding/mailway/logo.svg)"
echo "LOGO-CLIENTE $(curl -sS -o /dev/null -w '%{http_code} %{content_type}' --cacert /ca.pem https://webmail.cliente.test/branding/clientes/cliente/logo.svg)"
echo "ICONO $(curl -sS -o /dev/null -w '%{http_code} %{content_type}' --cacert /ca.pem https://webmail.cliente.test/api/pwa-icon/192)"
echo "POLITICA $(curl -sS --cacert /ca.pem https://webmail.cliente.test/api/admin/policy)"
EOF
)
CONFIG_CLIENTE=$(sed -n 's/^CLIENTE //p' <<<"$SALIDA")
CONFIG_OTRO=$(sed -n 's/^OTRO //p' <<<"$SALIDA")
comprobar 'marca del cliente con Host: webmail.cliente.test' \
  'Correo de Cliente|Cliente S.L.|https://panel.cliente.test/mi-buzon|/branding/clientes/cliente/favicon.svg|/branding/clientes/cliente/logo.svg' \
  "$(jq -r '"\(.appName)|\(.loginCompanyName)|\(.loginWebsiteUrl)|\(.faviconUrl)|\(.loginLogoLightUrl)"' <<<"$CONFIG_CLIENTE")"
comprobar 'la pantalla de acceso lleva el nombre del cliente' '<title>Correo de Cliente</title>' "$(sed -n 's/^TITULO //p' <<<"$SALIDA")"
comprobar 'otro nombre: marca de la instancia (Mailway), no la de Bulwark' \
  'Correo Mailway|/branding/mailway/favicon.svg|/branding/mailway/logo.svg|https://panel.mwb.test/mi-buzon' \
  "$(jq -r '"\(.appName)|\(.faviconUrl)|\(.loginLogoLightUrl)|\(.loginWebsiteUrl)"' <<<"$CONFIG_OTRO")"
comprobar 'el logotipo montado de la instancia se sirve' '200 image/svg+xml' "$(sed -n 's/^LOGO //p' <<<"$SALIDA")"
comprobar 'y el del cliente, en su mismo origen' '200 image/svg+xml' "$(sed -n 's/^LOGO-CLIENTE //p' <<<"$SALIDA")"
comprobar 'el icono de la aplicación (PWA) del cliente se genera a partir de su favicon' '200 image/png' "$(sed -n 's/^ICONO //p' <<<"$SALIDA")"
comprobar 'Bulwark sin las funciones de cuenta de Stalwart ni JMAP propio' 'false false https://mail.mwb.test' \
  "$(jq -r '"\(.stalwartFeaturesEnabled) \(.allowCustomJmapEndpoint) \(.jmapServerUrl)"' <<<"$CONFIG_CLIENTE")"
comprobar 'política de Mailway (parte pública): complementos, archivos, apps propias y depuración desactivados' \
  'false false false false true true' \
  "$(sed -n 's/^POLITICA //p' <<<"$SALIDA" | jq -r '.features | "\(.pluginsEnabled) \(.filesEnabled) \(.sidebarAppsEnabled) \(.debugModeEnabled) \(.calendarEnabled) \(.contactsEnabled)"')"

# ------------------------------------------------------------ Acceso --

seccion 'Acceso con el buzón y lectura de la bandeja'
SALIDA=$(cliente mwb-calle "$C.50" -e "CLAVE=$CLAVE_ANA" -e "ASUNTO=$ASUNTO" <<'EOF'
W=https://webmail.cliente.test
nav=(-H 'Origin: https://webmail.cliente.test' -H 'Sec-Fetch-Site: same-origin' -H 'content-type: application/json')
echo "BUENA $(curl -sS --cacert /ca.pem "${nav[@]}" $W/api/auth/verify -d "{\"serverUrl\":\"https://mail.mwb.test\",\"username\":\"ana@cliente.test\",\"password\":\"$CLAVE\"}")"
echo "MALA $(curl -sS --cacert /ca.pem "${nav[@]}" $W/api/auth/verify -d '{"serverUrl":"https://mail.mwb.test","username":"ana@cliente.test","password":"no-es-esta"}')"
echo "OTRO-SITIO $(curl -sS -o /dev/null -w '%{http_code}' --cacert /ca.pem -H 'Origin: https://atacante.test' -H 'Sec-Fetch-Site: cross-site' -H 'content-type: application/json' $W/api/auth/verify -d '{}')"
AUTH="Basic $(printf 'ana@cliente.test:%s' "$CLAVE" | base64 -w0)"
echo "CONTEXTO $(curl -sS -c /tmp/galletas --cacert /ca.pem "${nav[@]}" $W/api/auth/stalwart-context -d "{\"serverUrl\":\"https://mail.mwb.test\",\"username\":\"ana@cliente.test\",\"authHeader\":\"$AUTH\"}")"
echo "POLITICA-COMPLETA $(curl -sS -b /tmp/galletas --cacert /ca.pem $W/api/admin/policy)"
echo "PASO-X $(curl -sS -o /dev/null -w '%{http_code}' -b /tmp/galletas --cacert /ca.pem "${nav[@]}" $W/api/account/stalwart/jmap -d '{}')"
# El navegador: la URL JMAP de /api/config y JMAP directo al motor con CORS.
JMAP=$(curl -sS --cacert /ca.pem $W/api/config | sed -n 's/.*"jmapServerUrl":"\([^"]*\)".*/\1/p')
SESION=$(curl -sS --cacert /ca.pem -H "Authorization: $AUTH" -H 'Origin: https://webmail.cliente.test' "$JMAP/jmap/session")
CUENTA=$(printf '%s' "$SESION" | sed -n 's/.*"urn:ietf:params:jmap:mail":"\([^"]*\)".*/\1/p' | head -n1)
BANDEJA=$(curl -sS --cacert /ca.pem -H "Authorization: $AUTH" -H 'Origin: https://webmail.cliente.test' -H 'content-type: application/json' "$JMAP/jmap/" \
  -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Mailbox/query\",{\"accountId\":\"$CUENTA\",\"filter\":{\"role\":\"inbox\"}},\"a\"]]}" |
  sed -n 's/.*"ids":\["\([^"]*\)".*/\1/p')
echo "BANDEJA $(curl -sS --cacert /ca.pem -H "Authorization: $AUTH" -H 'Origin: https://webmail.cliente.test' -H 'content-type: application/json' "$JMAP/jmap/" \
  -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/query\",{\"accountId\":\"$CUENTA\",\"filter\":{\"inMailbox\":\"$BANDEJA\"}},\"a\"],[\"Email/get\",{\"accountId\":\"$CUENTA\",\"#ids\":{\"resultOf\":\"a\",\"name\":\"Email/query\",\"path\":\"/ids\"},\"properties\":[\"subject\"]},\"b\"]]}")"
EOF
)
comprobar 'contraseña correcta: Bulwark la da por buena' '{"result":"ok"}' "$(sed -n 's/^BUENA //p' <<<"$SALIDA")"
comprobar 'contraseña incorrecta: rechazada' '{"result":"unauthorized"}' "$(sed -n 's/^MALA //p' <<<"$SALIDA")"
comprobar 'petición de otro sitio rechazada por Bulwark tras la pasarela (Host intacto)' '403' "$(sed -n 's/^OTRO-SITIO //p' <<<"$SALIDA")"
comprobar 'sesión de Bulwark creada (contexto del buzón)' '{"ok":true}' "$(sed -n 's/^CONTEXTO //p' <<<"$SALIDA")"
comprobar 'con sesión, la política completa trae «Mi buzón» en la barra lateral' 'Mi buzón https://panel.mwb.test/mi-buzon tab' \
  "$(sed -n 's/^POLITICA-COMPLETA //p' <<<"$SALIDA" | jq -r '.defaultSidebarApps[0] | "\(.name) \(.url) \(.openMode)"')"
comprobar 'el paso a los métodos x: de Stalwart no existe ni con sesión' '404' "$(sed -n 's/^PASO-X //p' <<<"$SALIDA")"
contiene 'la bandeja de entrada se lee por JMAP desde el origen del webmail' "$(sed -n 's/^BANDEJA //p' <<<"$SALIDA")" "$ASUNTO"

# ---------------------------------------------------------------- CORS --

seccion 'CORS del motor'
preflight() {
  cliente mwb-calle "$C.50" <<'EOF'
curl -sS -D - -o /dev/null -X OPTIONS --cacert /ca.pem -H 'Origin: https://webmail.cliente.test' \
  -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization, content-type' \
  https://mail.mwb.test/jmap/ | tr -d '\r' | tr 'A-Z' 'a-z'
EOF
}
SALIDA=$(preflight)
contiene 'preflight desde webmail.cliente.test: origen permitido' "$SALIDA" 'access-control-allow-origin: *'
contiene 'preflight: se permite la cabecera Authorization' "$SALIDA" 'authorization'
no_contiene 'sin Access-Control-Allow-Credentials (el motor no acepta cookies de otro origen)' "$SALIDA" 'allow-credentials'
jmap_ok "{$USING,\"methodCalls\":[[\"x:Http/set\",{\"update\":{\"singleton\":{\"usePermissiveCors\":false}}},\"a\"],[\"x:Action/set\",{\"create\":{\"r\":{\"@type\":\"ReloadSettings\"}}},\"b\"]]}" >/dev/null
no_contiene 'sin usePermissiveCors el navegador no podría (no hay Allow-Origin)' "$(preflight)" 'access-control-allow-origin'
jmap_ok "{$USING,\"methodCalls\":[[\"x:Http/set\",{\"update\":{\"singleton\":{\"usePermissiveCors\":true}}},\"a\"],[\"x:Action/set\",{\"create\":{\"r\":{\"@type\":\"ReloadSettings\"}}},\"b\"]]}" >/dev/null

# ------------------------------------------------------------- IP real --

seccion 'IP real'
eco() { # eco <red> <ip> [cabeceras curl…]: lo que la pasarela entrega al servicio
  local red=$1 ip=$2 cabeceras=''
  shift 2
  [ "$#" -gt 0 ] && printf -v cabeceras '%q ' "$@"
  cliente "$red" "$ip" <<EOF
curl -sS --cacert /ca.pem $cabeceras https://eco.cliente.test/ruta-de-eco
EOF
}
campos='"\(.["x-forwarded-for"])|\(.["x-real-ip"])|\(.["cf-connecting-ip"] // "-")|\(.forwarded // "-")|\(.["true-client-ip"] // "-")|\(.host)|\(.["x-forwarded-host"])|\(.["x-forwarded-proto"])"'
comprobar 'visitante directo con cabeceras falsas: una sola IP, la suya; nada más pasa' \
  "$C.51|$C.51|-|-|-|eco.cliente.test|eco.cliente.test|https" \
  "$(eco mwb-calle "$C.51" -H 'X-Forwarded-For: 203.0.113.9' -H 'CF-Connecting-IP: 203.0.113.9' -H 'Forwarded: for=203.0.113.9' -H 'True-Client-IP: 203.0.113.9' -H 'X-Real-IP: 203.0.113.9' | jq -r "$campos")"
comprobar 'nodo de Cloudflare con CF-Connecting-IP: la IP del visitante' \
  '203.0.113.10|203.0.113.10|-|-|-|eco.cliente.test|eco.cliente.test|https' \
  "$(eco mwb-cf "$IP_CF_1" -H 'CF-Connecting-IP: 203.0.113.10' -H 'X-Forwarded-For: 198.51.100.66' | jq -r "$campos")"
comprobar 'nodo de Cloudflare sin CF-Connecting-IP: la del nodo, sin inventar nada' \
  "$IP_CF_1|$IP_CF_1|-|-|-|eco.cliente.test|eco.cliente.test|https" \
  "$(eco mwb-cf "$IP_CF_1" | jq -r "$campos")"
comprobar 'IPv6 de CF-Connecting-IP' '2001:db8::7' \
  "$(eco mwb-cf "$IP_CF_1" -H 'CF-Connecting-IP: 2001:db8::7' | jq -r '.["x-forwarded-for"]')"

# Lo que hace Bulwark con esa IP: su presupuesto de comprobaciones fallidas es
# de 5 por IP cada 15 minutos. Agotado para 203.0.113.20, otra IP sigue y un
# visitante directo que dice ser 203.0.113.20 cuenta como sí mismo.
verifica_mala() { # verifica_mala <red> <ip> [cabeceras…]
  local red=$1 ip=$2 cabeceras=''
  shift 2
  [ "$#" -gt 0 ] && printf -v cabeceras '%q ' "$@"
  cliente "$red" "$ip" <<EOF
curl -sS --cacert /ca.pem $cabeceras -H 'content-type: application/json' https://webmail.cliente.test/api/auth/verify -d '{"serverUrl":"https://mail.mwb.test","username":"ana@cliente.test","password":"mala"}' | sed -n 's/.*"result":"\([a-z]*\)".*/\1/p'
EOF
}
RESULTADOS=""
for _ in 1 2 3 4 5 6; do RESULTADOS+="$(verifica_mala mwb-cf "$IP_CF_1" -H 'CF-Connecting-IP: 203.0.113.20') "; done
comprobar 'Bulwark cuenta los fallos por la IP del visitante tras Cloudflare' \
  'unauthorized unauthorized unauthorized unauthorized unauthorized inconclusive ' "$RESULTADOS"
comprobar 'otro visitante tras Cloudflare tiene su propio presupuesto' 'unauthorized' \
  "$(verifica_mala mwb-cf "$IP_CF_1" -H 'CF-Connecting-IP: 203.0.113.21')"
comprobar 'un visitante directo no puede hacerse pasar por otro con CF-Connecting-IP' 'unauthorized' \
  "$(verifica_mala mwb-calle "$C.52" -H 'CF-Connecting-IP: 203.0.113.20')"
REGISTRO=$(docker logs mwb-pasarela 2>/dev/null | grep '"ruta":"/api/auth/verify"')
contiene 'el registro de la pasarela anota la IP del visitante tras Cloudflare' "$REGISTRO" '"ip":"203.0.113.20"'
contiene 'y la del visitante directo que intentó falsearla' "$REGISTRO" "\"ip\":\"$C.52\""

# ------------------------------------------------- Bloqueo automático --

seccion 'Bloqueo automático del motor (umbral de prueba: 10 fallos)'
# Presupuestos de Bulwark a cero para contar desde aquí.
docker restart mwb-bulwark >/dev/null
esperar 'Bulwark (reinicio)' curl -fsS "http://127.0.0.1:$PUERTO_BULWARK/api/health"

CONTROL=$(cliente mwb-borde "$B.60" -e "MOTOR=$IP_MOTOR_BORDE" <<'EOF'
for i in $(seq 1 13); do
  curl -sS -o /dev/null -w '%{http_code} ' -u "control@cliente.test:mala$i" "http://$MOTOR:8080/jmap/session" 2>/dev/null || printf 'x '
done
EOF
)
contiene 'control: una IP sin exención queda bloqueada al pasar el umbral' "$CONTROL" '429'

# 40 accesos fallidos a través de Bulwark, de 8 visitantes tras Cloudflare.
RESULTADOS=$(cliente mwb-cf "$IP_CF_1" <<'EOF'
for v in 31 32 33 34 35 36 37 38; do
  for i in 1 2 3 4 5; do
    curl -sS -w '\n' --cacert /ca.pem -H "CF-Connecting-IP: 203.0.113.$v" -H 'content-type: application/json' \
      https://webmail.cliente.test/api/auth/verify \
      -d "{\"serverUrl\":\"https://mail.mwb.test\",\"username\":\"ana@cliente.test\",\"password\":\"mala-$v-$i\"}" |
      sed -n 's/.*"result":"\([a-z]*\)".*/\1/p'
  done
done
EOF
)
comprobar '40 fallos por Bulwark: 30 llegan al motor (presupuesto global de Bulwark) y 10 no' '30 10' \
  "$(grep -c '^unauthorized$' <<<"$RESULTADOS") $(grep -c '^inconclusive$' <<<"$RESULTADOS")"

bloqueadas() {
  jmap "{$USING,\"methodCalls\":[[\"x:BlockedIp/query\",{},\"a\"],[\"x:BlockedIp/get\",{\"#ids\":{\"resultOf\":\"a\",\"name\":\"x:BlockedIp/query\",\"path\":\"/ids\"}},\"b\"]]}" |
    jq -r '.methodResponses[1][1].list[]?.address'
}
BLOQUEADAS=$(bloqueadas)
contiene 'el motor bloqueó la IP de control' "$BLOQUEADAS" "$B.60"
no_contiene 'el motor no bloquea a Bulwark (red exenta)' "$BLOQUEADAS" "$IP_BULWARK"
SALIDA=$(cliente mwb-calle "$C.53" -e "CLAVE=$CLAVE_ANA" <<'EOF'
echo "VERIFICA $(curl -sS --cacert /ca.pem -H 'content-type: application/json' https://webmail.cliente.test/api/auth/verify \
  -d "{\"serverUrl\":\"https://mail.mwb.test\",\"username\":\"ana@cliente.test\",\"password\":\"$CLAVE\"}")"
AUTH="Basic $(printf 'ana@cliente.test:%s' "$CLAVE" | base64 -w0)"
echo "CONTEXTO $(curl -sS --cacert /ca.pem -H 'content-type: application/json' https://webmail.cliente.test/api/auth/stalwart-context \
  -d "{\"serverUrl\":\"https://mail.mwb.test\",\"username\":\"ana@cliente.test\",\"authHeader\":\"$AUTH\"}")"
EOF
)
comprobar 'agotado su presupuesto global, Bulwark contesta «inconclusive» a todos (el navegador comprueba por su cuenta)' \
  'VERIFICA {"result":"inconclusive"}' "$(grep '^VERIFICA' <<<"$SALIDA")"
comprobar 'Bulwark sigue entrando en el motor con la contraseña buena' 'CONTEXTO {"ok":true}' "$(grep '^CONTEXTO' <<<"$SALIDA")"

# El oráculo: /api/auth/stalwart-context comprueba la contraseña desde Bulwark
# sin ningún límite. Directo a Bulwark (sin pasarela), 40 de 40 contestan.
ORACULO=$(for i in $(seq 1 40); do
  curl -sS -o /dev/null -w '%{http_code}\n' -H 'content-type: application/json' "http://127.0.0.1:$PUERTO_BULWARK/api/auth/stalwart-context" \
    -d "{\"serverUrl\":\"https://mail.mwb.test\",\"username\":\"ana@cliente.test\",\"authHeader\":\"Basic $(printf 'ana@cliente.test:oraculo%s' "$i" | base64 -w0)\"}"
done | sort | uniq -c | awk '{print $2 "x" $1}' | tr '\n' ' ')
comprobar 'Bulwark 1.13 responde 401 a cada intento de /api/auth/stalwart-context, sin límite (oráculo)' '401x40 ' "$ORACULO"
no_contiene 'y el motor tampoco bloquea a Bulwark por ello' "$(bloqueadas)" "$IP_BULWARK"
ORACULO=$(cliente mwb-calle "$C.54" <<'EOF'
for i in $(seq 1 60); do
  curl -sS -o /dev/null -w '%{http_code}\n' --cacert /ca.pem -H 'content-type: application/json' https://webmail.cliente.test/api/auth/stalwart-context \
    -d "{\"serverUrl\":\"https://mail.mwb.test\",\"username\":\"ana@cliente.test\",\"authHeader\":\"Basic $(printf 'ana@cliente.test:oraculo%s' "$i" | base64 -w0)\"}"
done | sort | uniq -c | awk '{print $2 "x" $1}' | tr '\n' ' '
EOF
)
contiene 'por la pasarela, el límite por IP corta el oráculo (429)' "$ORACULO" '429x'

# Fallos por buzón: el motor no cuenta los que llegan desde la red exenta
# (ana lleva más de 70 sin que su contador se mueva), pero sí los directos.
directo() { # directo <ip>: un fallo de ana contra el motor por Traefik (camino del navegador)
  cliente mwb-calle "$1" <<'EOF'
curl -sS -o /dev/null -w '%{http_code}' --cacert /ca.pem -u 'ana@cliente.test:mala-directa' https://mail.mwb.test/jmap/session 2>/dev/null || printf 'x'
EOF
}
comprobar 'los fallos desde Bulwark no cuentan para el buzón: un fallo directo nuevo no bloquea' '401' "$(directo "$C.60")"
for ip in "$C.61" "$C.62" "$C.63"; do directo "$ip" >/dev/null; done
for _ in 1 2 3 4 5 6; do directo "$C.64" >/dev/null; done
comprobar 'los fallos directos sí cuentan por buzón: superado el umbral, una IP nueva cae al primer fallo' '429' "$(directo "$C.65")"

# ------------------------------------------------------------ Forwarded --

seccion 'Cabecera Forwarded hasta el motor'
forwarded() { # forwarded <ip> <host>: 12 fallos diciendo ser Bulwark
  cliente mwb-calle "$1" -e "HOST=$2" -e "FALSA=$IP_BULWARK" <<'EOF'
for i in $(seq 1 12); do
  curl -sS -o /dev/null -w '%{http_code} ' --cacert /ca.pem -H "Forwarded: for=$FALSA" -u "nadie@cliente.test:mala$i" "https://$HOST/jmap/session" 2>/dev/null || printf 'x '
done
EOF
}
SALIDA=$(forwarded "$C.70" mail-crudo.mwb.test)
no_contiene 'sin middleware: Traefik deja pasar Forwarded y el motor cree que es la red exenta (nunca bloquea)' "$SALIDA" '429'
SALIDA=$(forwarded "$C.71" mail.mwb.test)
contiene 'con el middleware que retira Forwarded, el atacante queda bloqueado' "$SALIDA" '429'

# --------------------------------------------------------------- Límites --

seccion 'Límites y registro'
SALIDA=$(cliente mwb-calle "$C.80" <<'EOF'
head -c 32000000 /dev/zero >/tmp/grande
echo "GRANDE $(curl -sS -o /dev/null -w '%{http_code}' --cacert /ca.pem -H 'content-type: application/octet-stream' --data-binary @/tmp/grande https://webmail.cliente.test/api/settings)"
echo "TOKEN $(curl -sS -o /dev/null -w '%{http_code}' --cacert /ca.pem 'https://webmail.cliente.test/es/login?token=SECRETO-EN-LA-URL')"
echo "FAVICON $(curl -sS -o /dev/null -w '%{http_code}' --cacert /ca.pem 'https://webmail.cliente.test/api/favicon?domain=ejemplo.test')"
echo "TRADUCIR $(curl -sS -o /dev/null -w '%{http_code}' --cacert /ca.pem -H 'content-type: application/json' -d '{"text":"hola","target":"en"}' https://webmail.cliente.test/api/translate)"
echo "VERSION $(curl -sS -o /dev/null -w '%{http_code}' --cacert /ca.pem https://webmail.cliente.test/api/system/update-status)"
EOF
)
comprobar 'cuerpo de más de 30 MB rechazado en la pasarela' 'GRANDE 413' "$(grep '^GRANDE' <<<"$SALIDA")"
comprobar 'sin favicons de remitentes pedidos por el servidor (/api/favicon)' 'FAVICON 404' "$(grep '^FAVICON' <<<"$SALIDA")"
comprobar 'sin traducción a través de terceros (/api/translate)' 'TRADUCIR 404' "$(grep '^TRADUCIR' <<<"$SALIDA")"
comprobar 'estado de versiones sin error con la raíz en solo lectura' 'VERSION 200' "$(grep '^VERSION' <<<"$SALIDA")"
REGISTRO=$(docker logs mwb-pasarela 2>&1)
no_contiene 'el registro de la pasarela no guarda la cadena de consulta' "$REGISTRO" 'SECRETO-EN-LA-URL'
TODO=$(docker logs mwb-pasarela 2>&1; docker logs mwb-bulwark 2>&1; docker logs mwb-stalwart 2>&1)
no_contiene 'ningún registro contiene la contraseña del buzón' "$TODO" "$CLAVE_ANA"
no_contiene 'ningún registro contiene la contraseña de administración de Bulwark' "$TODO" "$CLAVE_ADMIN_BULWARK"

# ------------------------------------------------------------- Navegador --

seccion 'Navegador (Playwright)'
# Opcional: con Playwright y Chromium instalados (MWB_PLAYWRIGHT=ruta del
# módulo si no está en el repositorio). MWB_PESTANA_SEGUNDOS=420 mide además
# la pestaña abierta tras un cambio de contraseña (al final: deja bloqueada
# la IP del navegador si supera el umbral de prueba).
PLAYWRIGHT=${MWB_PLAYWRIGHT:-playwright}
if (cd "$RAIZ" && node -e "require.resolve(process.argv[1])" "$PLAYWRIGHT") >/dev/null 2>&1; then
  # Los nombres de prueba nunca deben ir por un proxy de salida.
  (cd "$RAIZ" && no_proxy="${no_proxy:-}${no_proxy:+,}webmail.cliente.test,mail.mwb.test" \
    NO_PROXY="${NO_PROXY:-}${NO_PROXY:+,}webmail.cliente.test,mail.mwb.test" \
    MWB_PLAYWRIGHT="$PLAYWRIGHT" MWB_PUERTO_TRAEFIK="$PUERTO_TRAEFIK" MWB_PUERTO_MOTOR="$PUERTO_MOTOR" \
    MWB_ADMIN_MOTOR="$CLAVE_MOTOR" MWB_BUZON=eva@cliente.test MWB_CLAVE="$CLAVE_EVA" MWB_CUENTA_ID="$CUENTA_EVA" \
    MWB_ASUNTO="$ASUNTO_EVA" MWB_PESTANA_SEGUNDOS="${MWB_PESTANA_SEGUNDOS:-0}" \
    node "$AQUI/prueba-navegador.cjs") >"$TMP/navegador.log" 2>&1
  cat "$TMP/navegador.log"
  FALLOS=$((FALLOS + $(grep -c '^FALLO' "$TMP/navegador.log")))
else
  echo "omitido - no hay Playwright (MWB_PLAYWRIGHT=ruta del módulo para usar uno instalado aparte)"
fi

# ------------------------------------------------------------- Resumen --

seccion 'No verificado en este ensayo'
cat <<'EOF'
- Redactar y enviar, filtros, «Fuera de la oficina» y notificaciones push en
  el navegador (el acceso y la bandeja sí, con Playwright).
- Cloudflare real (aquí un contenedor con IP de su rango hace de nodo).
- El puente de Traefik de Skyway (aquí, el proveedor de ficheros de Traefik).
EOF

TERMINADA=1
echo
if [ "$FALLOS" -gt 0 ]; then
  echo "$FALLOS comprobaciones fallidas."
  exit 1
fi
echo 'Todas las comprobaciones han pasado.'
