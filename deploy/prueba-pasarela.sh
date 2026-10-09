#!/usr/bin/env bash
#
# Prueba con contenedores reales de la pasarela HTTP del motor
# (deploy/motor/pasarela, servicio mailway-mail-gw): Stalwart 0.16 o 0.15, la
# pasarela con su configuración de verdad y Traefik con dos entradas, una que
# confía en los rangos de Cloudflare (forwardedHeaders.trustedIPs, como el PR
# de Skyway que quiere ver la IP real de los visitantes) y otra que no (como el
# Traefik de Skyway de hoy). Un contenedor con una IP de un rango de
# Cloudflare hace de nodo de Cloudflare. Comprueba:
#   - la tabla de la IP real: lo que recibe el motor (un eco con su nombre)
#     desde un visitante directo con cabeceras falsas, desde Cloudflare con un
#     X-Forwarded-For falso (con y sin confianza en Cloudflare), sin datos del
#     visitante y desde fuera de las redes de Docker; nunca Forwarded ni
#     CF-Connecting-IP;
#   - el bloqueo automático del motor de verdad (umbral bajo): el visitante
#     directo y el que llega por Cloudflare diciendo ser de la red exenta
#     quedan bloqueados con SU IP; sin la pasarela, el de Cloudflare se hace
#     pasar por la red exenta y nunca se bloquea (lo que la pasarela evita);
#   - que pasa lo que pasaba por Traefik: sesión JMAP con el nombre público,
#     una subida de 20 MB, el push de JMAP (EventSource) sin búfer, WebSocket,
#     DAV y la salud; y un registro con la IP real, sin la cadena de consulta.
#
#   bash deploy/prueba-pasarela.sh                          # Stalwart 0.16
#   bash deploy/prueba-pasarela.sh --motor stalwart-0.15
#   bash deploy/prueba-pasarela.sh --conservar              # deja la pila en marcha
#   bash deploy/prueba-pasarela.sh --retirar                # retira una pila conservada
#
# Necesita docker, openssl y curl (y no hace falta ser root: basta con el
# grupo docker). Las imágenes son las de los compose (las que sube
# Dependabot). Solo crea contenedores, redes y volúmenes con el prefijo
# MWP_PREFIJO (mwp- por defecto) y la etiqueta mailway.ensayo=pasarela, y solo
# publica la API del motor en 127.0.0.1:MWP_PUERTO_MOTOR (23080). Las subredes
# se cambian con MWP_SUBRED_* si chocan con otras; la del nodo de Cloudflare
# (MWP_SUBRED_CF, una /29 de sus rangos) deja inalcanzables desde este equipo
# esas 8 direcciones reales mientras dura la prueba.

set -uo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MOTOR=stalwart-0.16
CONSERVAR=0
RETIRAR=0
while [ $# -gt 0 ]; do
  case "$1" in
    --motor)
      MOTOR=${2:-}
      shift
      ;;
    --conservar) CONSERVAR=1 ;;
    --retirar) RETIRAR=1 ;;
    *)
      echo "Uso: $0 [--motor stalwart-0.16|stalwart-0.15] [--conservar|--retirar]" >&2
      exit 2
      ;;
  esac
  shift
done
case "$MOTOR" in stalwart-0.16 | stalwart-0.15) ;; *)
  echo "Motor no válido: «$MOTOR» (stalwart-0.16 o stalwart-0.15)." >&2
  exit 2
  ;;
esac

P=${MWP_PREFIJO:-mwp-}
ETIQUETA=mailway.ensayo=pasarela
SUBRED_INTERNA=${MWP_SUBRED_INTERNA:-10.231.53.0/24}
SUBRED_BORDE=${MWP_SUBRED_BORDE:-10.231.54.0/24}
SUBRED_ECO=${MWP_SUBRED_ECO:-10.231.55.0/24}
SUBRED_CALLE=${MWP_SUBRED_CALLE:-10.231.56.0/24}
SUBRED_CF=${MWP_SUBRED_CF:-131.0.74.240/29}
PUERTO_MOTOR=${MWP_PUERTO_MOTOR:-23080}
UMBRAL=6

pre() { local s=${1%/*}; echo "${s%.*}"; }
I=$(pre "$SUBRED_INTERNA")
B=$(pre "$SUBRED_BORDE")
E=$(pre "$SUBRED_ECO")
C=$(pre "$SUBRED_CALLE")
CF_BASE=${SUBRED_CF%/*}
CF_PRE=${CF_BASE%.*}
CF_ULTIMO=${CF_BASE##*.}
IP_MOTOR=$I.10
# Una dirección de la red exenta que no tiene nadie: la que dirá ser el atacante.
IP_EXENTA=$I.77
IP_TRAEFIK_BORDE=$B.5
IP_TRAEFIK_ECO=$E.5
IP_TRAEFIK_CALLE=$C.5
IP_TRAEFIK_CF=$CF_PRE.$((CF_ULTIMO + 2))
IP_CF_1=$CF_PRE.$((CF_ULTIMO + 3))
IP_CF_2=$CF_PRE.$((CF_ULTIMO + 4))
IP_ECO_CF=$CF_PRE.$((CF_ULTIMO + 5))

CONTENEDORES=("${P}motor" "${P}pasarela" "${P}pasarela-eco" "${P}eco" "${P}traefik")
REDES=("${P}interna" "${P}borde" "${P}eco" "${P}calle" "${P}cf")
VOLUMENES=("${P}motor-datos" "${P}motor-etc")

# Imágenes con su versión exacta, de donde las mantiene Dependabot.
imagen_de() { sed -n -E "s#^[[:space:]]*image:[[:space:]]*($2[^[:space:]]*)[[:space:]]*\$#\1#p" "$AQUI/$1" | head -n 1; }
IMAGEN_MOTOR=$(imagen_de "motor/$MOTOR/compose.yml" 'stalwartlabs/stalwart:')
IMAGEN_NGINX=$(imagen_de docker-compose.mail.yml 'nginx:')
IMAGEN_TRAEFIK=$(imagen_de docker-compose.standalone.yml 'traefik:')
IMAGEN_PYTHON=$(imagen_de docker-compose.mail.yml 'python:')
IMAGEN_CURL=$(sed -n -E 's/^IMAGEN_CURL="([^"]+)"$/\1/p' "$AQUI/instalar.sh")
for v in IMAGEN_MOTOR IMAGEN_NGINX IMAGEN_TRAEFIK IMAGEN_PYTHON IMAGEN_CURL; do
  [ -n "${!v}" ] || { echo "No se encuentra $v en deploy/." >&2; exit 1; }
done

for programa in docker openssl curl; do
  command -v "$programa" >/dev/null 2>&1 || { echo "Falta $programa." >&2; exit 1; }
done

TMP=$(mktemp -d)
chmod 755 "$TMP"
FALLOS=0
TERMINADA=0

# Solo lo que lleva la etiqueta de la prueba: nunca nada ajeno.
retirar() {
  local nombre
  for nombre in "${CONTENEDORES[@]}"; do
    [ "$(docker inspect -f '{{index .Config.Labels "mailway.ensayo"}}' "$nombre" 2>/dev/null)" = pasarela ] &&
      docker rm -f "$nombre" >/dev/null 2>&1
  done
  for nombre in $(docker ps -aq --filter "label=$ETIQUETA" --filter "name=^$P"); do
    docker rm -f "$nombre" >/dev/null 2>&1
  done
  for nombre in "${REDES[@]}"; do
    [ "$(docker network inspect -f '{{index .Labels "mailway.ensayo"}}' "$nombre" 2>/dev/null)" = pasarela ] &&
      docker network rm "$nombre" >/dev/null 2>&1
  done
  for nombre in "${VOLUMENES[@]}"; do
    [ "$(docker volume inspect -f '{{index .Labels "mailway.ensayo"}}' "$nombre" 2>/dev/null)" = pasarela ] &&
      docker volume rm "$nombre" >/dev/null 2>&1
  done
  return 0
}
al_salir() {
  if [ "$CONSERVAR" = 1 ]; then
    echo "Pila conservada (--conservar), con sus ficheros en $TMP. Para retirarla: bash $0 --retirar && rm -rf $TMP" >&2
  else
    retirar
    rm -rf "$TMP"
  fi
  [ "$TERMINADA" = 1 ] || echo "FALLO - la prueba terminó antes de tiempo" >&2
}
if [ "$RETIRAR" = 1 ]; then
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
comprobar() { if [ "$2" = "$3" ]; then ok "$1"; else fallo "$1" "esperado «$2», obtenido «$3»"; fi; }
contiene() { if [[ $2 == *"$3"* ]]; then ok "$1"; else fallo "$1" "no aparece «$3» en «${2:0:400}»"; fi; }
no_contiene() { if [[ $2 != *"$3"* ]]; then ok "$1"; else fallo "$1" "aparece «$3» en «${2:0:400}»"; fi; }
seccion() { printf '\n# %s\n' "$1"; }
detener() {
  echo "$1" >&2
  exit 1
}

# Imagen fijada: del registro y, si Docker Hub limita las descargas, del espejo
# de Google (mismo contenido; se etiqueta con el nombre de Docker Hub).
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
  id=$(docker image inspect -f '{{.Id}}' "$espejo") || return 1
  docker tag "$id" "${imagen%@*}" && docker image inspect "$imagen" >/dev/null 2>&1
}

esperar() { # esperar «qué» «orden…»: hasta 120 s
  local que=$1
  shift
  for _ in $(seq 1 120); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 1
  done
  detener "No responde: $que"
}

# Cliente en una red, con una IP, que resuelve los nombres de la prueba hacia
# Traefik (en esa red) y confía en la CA de la prueba. El guion (sh) llega por
# la entrada estándar.
cliente() {
  local red=$1 ip=$2 traefik
  shift 2
  case $red in
    "${P}calle") traefik=$IP_TRAEFIK_CALLE ;;
    "${P}cf") traefik=$IP_TRAEFIK_CF ;;
    "${P}eco") traefik=$IP_TRAEFIK_ECO ;;
    *) traefik=$IP_TRAEFIK_BORDE ;;
  esac
  docker run --rm -i --label "$ETIQUETA" --network "$red" --ip "$ip" \
    --add-host "mail.mwp.test:$traefik" --add-host "crudo.mwp.test:$traefik" --add-host "eco.mwp.test:$traefik" \
    -v "$TMP/tls/ca.pem:/tmp/ca.pem:ro" "$@" --entrypoint sh "$IMAGEN_CURL" -s
}

# API de gestión del motor (administrador), publicada solo en 127.0.0.1.
api() { # api <método> <ruta> [cuerpo]
  curl -sS --max-time 30 -u "admin:$CLAVE_MOTOR" -X "$1" -H 'Content-Type: application/json' \
    ${3:+--data-binary "$3"} "http://127.0.0.1:$PUERTO_MOTOR$2"
}
USING='"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"]'
jmap() { api POST /jmap "{$USING,\"methodCalls\":$1}"; }

retirar

# ---------------------------------------------------------------- Preparar --

seccion "Imágenes ($MOTOR)"
for imagen in "$IMAGEN_MOTOR" "$IMAGEN_NGINX" "$IMAGEN_TRAEFIK" "$IMAGEN_PYTHON" "$IMAGEN_CURL"; do
  traer "$imagen" || detener "No se pudo descargar $imagen."
  ok "imagen $imagen"
done

mkdir -p "$TMP/tls" "$TMP/traefik"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
  -keyout "$TMP/tls/ca.key" -out "$TMP/tls/ca.pem" -subj '/CN=CA de la prueba de la pasarela' >/dev/null 2>&1
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj '/CN=mail.mwp.test' \
  -keyout "$TMP/tls/servidor.key" -out "$TMP/tls/servidor.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:mail.mwp.test,DNS:crudo.mwp.test,DNS:eco.mwp.test\nextendedKeyUsage=serverAuth\n' >"$TMP/tls/ext.cnf"
openssl x509 -req -in "$TMP/tls/servidor.csr" -CA "$TMP/tls/ca.pem" -CAkey "$TMP/tls/ca.key" -CAcreateserial \
  -days 2 -extfile "$TMP/tls/ext.cnf" -out "$TMP/tls/servidor.pem" >/dev/null 2>&1 || detener 'No se pudo crear el certificado.'
chmod 644 "$TMP/tls/"*

crear_red() {
  docker network create --label "$ETIQUETA" --subnet "$2" "$1" >/dev/null 2>"$TMP/red.err" ||
    detener "No se pudo crear la red $1 ($2): $(cat "$TMP/red.err"). Cambia MWP_SUBRED_*."
}
crear_red "${P}interna" "$SUBRED_INTERNA"
crear_red "${P}borde" "$SUBRED_BORDE"
crear_red "${P}eco" "$SUBRED_ECO"
crear_red "${P}calle" "$SUBRED_CALLE"
crear_red "${P}cf" "$SUBRED_CF"
ok "redes ${P}* (exenta $SUBRED_INTERNA, Cloudflare $SUBRED_CF)"

# ------------------------------------------------------------------- Motor --

seccion "Motor ($IMAGEN_MOTOR)"
CLAVE_MOTOR=$(openssl rand -hex 16)
CLAVE_ANA="Prueba-Ana-$(openssl rand -hex 6)"
HASH_ANA=$(openssl passwd -6 "$CLAVE_ANA")
for v in "${VOLUMENES[@]}"; do docker volume create --label "$ETIQUETA" "$v" >/dev/null; done
if [ "$MOTOR" = stalwart-0.16 ]; then
  docker run -d --name "${P}motor" --label "$ETIQUETA" --hostname mail.mwp.test \
    --network "${P}interna" --ip "$IP_MOTOR" -p "127.0.0.1:$PUERTO_MOTOR:8080" \
    -v "${P}motor-datos:/var/lib/stalwart" -v "${P}motor-etc:/etc/stalwart" \
    -e STALWART_RECOVERY_ADMIN="admin:$CLAVE_MOTOR" "$IMAGEN_MOTOR" >/dev/null || detener 'No arranca el motor.'
  esperar 'el motor (arranque inicial)' curl -fsS "http://127.0.0.1:$PUERTO_MOTOR/healthz/live"
  R=$(jmap '[["x:Bootstrap/set",{"update":{"singleton":{"serverHostname":"mail.mwp.test","defaultDomain":"mail.mwp.test","requestTlsCertificate":false,"generateDkimKeys":false,"tracer":{"@type":"Stdout","ansi":false,"buffered":false}}}},"c"]]')
  contiene 'arranque inicial del motor (x:Bootstrap)' "$R" '"updated"'
  docker restart "${P}motor" >/dev/null
  esperar 'el motor (tras el arranque inicial)' curl -fsS "http://127.0.0.1:$PUERTO_MOTOR/healthz/ready"
  R=$(jmap '[["x:Domain/set",{"create":{"d":{"name":"mwp.test"}}},"a"]]')
  DOMINIO=$(sed -n 's/.*"created":{"d":{"id":"\([^"]*\)".*/\1/p' <<<"$R")
  [ -n "$DOMINIO" ] || detener "No se pudo crear el dominio: $R"
  R=$(jmap "[[\"x:Account/set\",{\"create\":{\"u\":{\"@type\":\"User\",\"name\":\"ana\",\"domainId\":\"$DOMINIO\",\"description\":\"Ana\",\"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":\"$HASH_ANA\"}}}}},\"a\"]]")
  contiene "buzón ana@mwp.test con hash \$6\$" "$R" '"created":{"u"'
  # Como lo dejan los ajustes de Mailway: IP real de X-Forwarded-For y la red
  # interna exenta. Umbral de bloqueo bajo para alcanzarlo en la prueba.
  R=$(jmap "[[\"x:Http/set\",{\"update\":{\"singleton\":{\"useXForwarded\":true}}},\"a\"],[\"x:AllowedIp/set\",{\"create\":{\"i\":{\"address\":\"$SUBRED_INTERNA\",\"reason\":\"Red interna de Mailway\"}}},\"b\"],[\"x:Security/set\",{\"update\":{\"singleton\":{\"authBanRate\":{\"count\":$UMBRAL,\"period\":86400000}}}},\"c\"],[\"x:Action/set\",{\"create\":{\"r\":{\"@type\":\"ReloadSettings\"}}},\"d\"]]")
  no_contiene "motor: X-Forwarded-For, red exenta y umbral de $UMBRAL fallos" "$R" 'notUpdated'
else
  # Como server/test/motor015-arrancar.sh: la configuración inicial y, sin
  # IPv6 en el núcleo, las escuchas en IPv4.
  ARRANQUE='
if [ ! -f /opt/stalwart/etc/config.toml ]; then
  /usr/local/bin/stalwart --init /opt/stalwart || exit 1
  if [ ! -e /proc/net/if_inet6 ]; then sed -i "s/\"\[::\]:/\"0.0.0.0:/" /opt/stalwart/etc/config.toml; fi
fi
exec /usr/local/bin/stalwart --config /opt/stalwart/etc/config.toml'
  docker run -d --name "${P}motor" --label "$ETIQUETA" --hostname mail.mwp.test \
    --network "${P}interna" --ip "$IP_MOTOR" -p "127.0.0.1:$PUERTO_MOTOR:8080" \
    -v "${P}motor-datos:/opt/stalwart" -e STALWART_ADMIN_PASSWORD="$CLAVE_MOTOR" \
    --entrypoint /bin/sh "$IMAGEN_MOTOR" -c "$ARRANQUE" >/dev/null || detener 'No arranca el motor.'
  esperar 'el motor' curl -fsS "http://127.0.0.1:$PUERTO_MOTOR/healthz/live"
  esperar 'la API del motor' api GET '/api/principal?types=domain&page=1&limit=1'
  VACIO='"quota":0,"urls":[],"memberOf":[],"lists":[],"members":[],"enabledPermissions":[],"disabledPermissions":[],"externalMembers":[]'
  R=$(api POST /api/principal "{\"type\":\"domain\",\"name\":\"mwp.test\",\"description\":\"Prueba\",\"secrets\":[],\"emails\":[],\"roles\":[],$VACIO}")
  contiene 'dominio mwp.test' "$R" '"data"'
  R=$(api POST /api/principal "{\"type\":\"individual\",\"name\":\"ana@mwp.test\",\"description\":\"Ana\",\"secrets\":[\"$HASH_ANA\"],\"emails\":[\"ana@mwp.test\"],\"roles\":[\"user\"],$VACIO}")
  contiene "buzón ana@mwp.test con hash \$6\$" "$R" '"data"'
  R=$(api POST /api/settings "[{\"type\":\"insert\",\"prefix\":null,\"values\":[[\"http.use-x-forwarded\",\"true\"],[\"server.allowed-ip.$SUBRED_INTERNA\",\"\"],[\"server.auto-ban.auth.rate\",\"$UMBRAL/1d\"]],\"assert_empty\":false}]")
  contiene "motor: X-Forwarded-For, red exenta y umbral de $UMBRAL fallos" "$R" '"data"'
  api GET /api/reload >/dev/null
fi
docker network connect --alias mailway-mail "${P}borde" "${P}motor" || detener 'No se pudo conectar el motor a la red de Traefik.'

# ----------------------------------------------- Pasarela, eco y Traefik --

seccion 'Pasarela y Traefik'
arrancar_pasarela() { # <nombre> <red> <ip> [alias]
  docker run -d --name "$1" --label "$ETIQUETA" --network "$2" --ip "$3" ${4:+--network-alias "$4"} \
    --user 101:101 --read-only --tmpfs /tmp:size=16m --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$AQUI/motor/pasarela:/etc/nginx/mailway:ro" "$IMAGEN_NGINX" \
    nginx -c /etc/nginx/mailway/nginx.conf -g 'daemon off;' >/dev/null
}
# La de verdad, delante del motor (con el nombre de producción en la red de Traefik).
arrancar_pasarela "${P}pasarela" "${P}borde" "$B.30" mailway-mail-gw || detener 'No arranca la pasarela.'
# Otra igual delante de un eco que se llama como el motor y devuelve las
# cabeceras que le llegan: se ve exactamente lo que recibiría el motor.
docker run -d --name "${P}eco" --label "$ETIQUETA" --network "${P}eco" --ip "$E.40" --network-alias mailway-mail \
  "$IMAGEN_PYTHON" python -c '
import http.server, json
class Eco(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        cuerpo = json.dumps({k.lower(): v for k, v in self.headers.items()}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)
    def log_message(self, *a):
        pass
http.server.ThreadingHTTPServer(("0.0.0.0", 8080), Eco).serve_forever()' >/dev/null || detener 'No arranca el eco.'
arrancar_pasarela "${P}pasarela-eco" "${P}eco" "$E.30" || detener 'No arranca la pasarela del eco.'
# También en la red de Cloudflare: una conexión directa desde una IP que no es
# de las redes de Docker.
docker network connect --ip "$IP_ECO_CF" "${P}cf" "${P}pasarela-eco"

# Traefik con dos entradas: websecure confía en Cloudflare (trustedIPs con los
# rangos de rangos.txt, como el PR de Skyway) y sincf no confía en nadie (el
# Traefik de Skyway de hoy). mail.mwp.test va a la pasarela, como en
# producción; crudo.mwp.test, al motor sin ella (lo de antes, para comparar).
RANGOS=$(grep -v '^#' "$AQUI/bulwark/cloudflare/rangos.txt" | tr -d ' \t' | grep -v '^$' | paste -sd, -)
cat >"$TMP/traefik/dinamica.yml" <<EOF
http:
  middlewares:
    mailway-mail-sin-forwarded:
      headers:
        customRequestHeaders:
          Forwarded: ""
  routers:
    motor:
      rule: Host(\`mail.mwp.test\`)
      entryPoints: [websecure, sincf]
      service: pasarela
      middlewares: [mailway-mail-sin-forwarded]
      tls: {}
    crudo:
      rule: Host(\`crudo.mwp.test\`)
      entryPoints: [websecure, sincf]
      service: motor-directo
      middlewares: [mailway-mail-sin-forwarded]
      tls: {}
    eco:
      rule: Host(\`eco.mwp.test\`)
      entryPoints: [websecure, sincf]
      service: pasarela-eco
      tls: {}
  services:
    pasarela:
      loadBalancer:
        servers:
          - url: http://mailway-mail-gw:8080
    motor-directo:
      loadBalancer:
        servers:
          - url: http://mailway-mail:8080
    pasarela-eco:
      loadBalancer:
        servers:
          # Por su IP en la red del eco: Traefik entra desde una red de Docker.
          - url: http://$E.30:8080
tls:
  stores:
    default:
      defaultCertificate:
        certFile: /etc/traefik/tls/servidor.pem
        keyFile: /etc/traefik/tls/servidor.key
EOF
chmod -R a+rX "$TMP/traefik"
docker run -d --name "${P}traefik" --label "$ETIQUETA" --network "${P}borde" --ip "$IP_TRAEFIK_BORDE" \
  -v "$TMP/traefik:/etc/traefik/dinamica:ro" -v "$TMP/tls:/etc/traefik/tls:ro" "$IMAGEN_TRAEFIK" \
  --entrypoints.websecure.address=:443 "--entrypoints.websecure.forwardedHeaders.trustedIPs=$RANGOS" \
  --entrypoints.sincf.address=:8443 --providers.file.directory=/etc/traefik/dinamica --log.level=ERROR >/dev/null ||
  detener 'No arranca Traefik.'
docker network connect --ip "$IP_TRAEFIK_ECO" "${P}eco" "${P}traefik"
docker network connect --ip "$IP_TRAEFIK_CALLE" "${P}calle" "${P}traefik"
docker network connect --ip "$IP_TRAEFIK_CF" "${P}cf" "${P}traefik"
sleep 1
for c in "${P}pasarela" "${P}pasarela-eco"; do
  [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] ||
    detener "La pasarela $c no arranca: $(docker logs "$c" 2>&1 | tail -n 3 | tr '\n' ' ')"
done
esperar 'la pasarela' docker exec "${P}pasarela" wget -qO- http://127.0.0.1:8081/salud
sleep 2
comprobar 'la pasarela corre sin privilegios (usuario 101)' '101' "$(docker exec "${P}pasarela" id -u 2>/dev/null)"
SALIDA=$(cliente "${P}calle" "$C.50" <<'EOF'
curl -sS -o /dev/null -w '%{http_code}' --cacert /tmp/ca.pem https://mail.mwp.test/healthz/live
EOF
)
comprobar 'el motor responde a través de Traefik y la pasarela' '200' "$SALIDA"

# ---------------------------------------------------------- Tabla de IP --

seccion 'IP real: lo que recibe el motor'
# eco <red> <ip> <puerto 443|8443> [cabeceras curl…]
eco() {
  local red=$1 ip=$2 puerto=$3 cabeceras=''
  shift 3
  [ "$#" -gt 0 ] && printf -v cabeceras '%q ' "$@"
  cliente "$red" "$ip" <<EOF
curl -sS --cacert /tmp/ca.pem $cabeceras https://eco.mwp.test:$puerto/ruta-del-eco
EOF
}
# Campos del eco: X-Forwarded-For|X-Real-IP|CF-Connecting-IP|Forwarded|True-Client-IP|Host|X-Forwarded-Proto
campos() {
  python3 -c '
import json, sys
d = json.load(sys.stdin)
print("|".join(d.get(k, "-") for k in ("x-forwarded-for", "x-real-ip", "cf-connecting-ip", "forwarded", "true-client-ip", "host", "x-forwarded-proto")))' 2>/dev/null || echo 'respuesta no válida'
}
FALSAS=(-H "X-Forwarded-For: $IP_EXENTA" -H "Forwarded: for=$IP_EXENTA" -H "CF-Connecting-IP: $IP_EXENTA"
  -H "True-Client-IP: $IP_EXENTA" -H "X-Real-IP: $IP_EXENTA")
comprobar 'visitante directo (Traefik que confía en Cloudflare) con cabeceras falsas: su IP y nada más' \
  "$C.51|$C.51|-|-|-|eco.mwp.test|https" "$(eco "${P}calle" "$C.51" 443 "${FALSAS[@]}" | campos)"
comprobar 'visitante directo (Traefik que no confía en nadie) con cabeceras falsas: su IP y nada más' \
  "$C.51|$C.51|-|-|-|eco.mwp.test:8443|https" "$(eco "${P}calle" "$C.51" 8443 "${FALSAS[@]}" | campos)"
# Cloudflare añade la IP del visitante detrás de lo que trae la petición; lo
# de delante lo escribe el visitante.
comprobar 'por Cloudflare con X-Forwarded-For falso (Traefik confía en Cloudflare): el visitante según Cloudflare' \
  '203.0.113.10|203.0.113.10|-|-|-|eco.mwp.test|https' \
  "$(eco "${P}cf" "$IP_CF_1" 443 -H "X-Forwarded-For: $IP_EXENTA, 203.0.113.10" -H 'CF-Connecting-IP: 203.0.113.10' -H "Forwarded: for=$IP_EXENTA" | campos)"
comprobar 'por Cloudflare con X-Forwarded-For falso (Traefik no confía): CF-Connecting-IP' \
  '203.0.113.11|203.0.113.11|-|-|-|eco.mwp.test:8443|https' \
  "$(eco "${P}cf" "$IP_CF_1" 8443 -H "X-Forwarded-For: $IP_EXENTA, 203.0.113.11" -H 'CF-Connecting-IP: 203.0.113.11' | campos)"
comprobar 'por Cloudflare sin datos del visitante: el nodo de Cloudflare, sin inventar nada' \
  "$IP_CF_1|$IP_CF_1|-|-|-|eco.mwp.test:8443|https" "$(eco "${P}cf" "$IP_CF_1" 8443 | campos)"
comprobar 'IPv6 de CF-Connecting-IP' '2001:db8::7' \
  "$(eco "${P}cf" "$IP_CF_1" 8443 -H 'CF-Connecting-IP: 2001:db8::7' | campos | cut -d'|' -f1)"
SALIDA=$(cliente "${P}cf" "$IP_CF_2" <<EOF
curl -sS -H 'X-Forwarded-For: $IP_EXENTA' -H 'CF-Connecting-IP: $IP_EXENTA' -H 'X-Forwarded-Proto: https' http://$IP_ECO_CF:8080/directo
EOF
)
comprobar 'conexión directa desde fuera de las redes de Docker: su propia IP, sin creer cabeceras' \
  "$IP_CF_2|$IP_CF_2|-|-|-|$IP_ECO_CF:8080|http" "$(campos <<<"$SALIDA")"

# ------------------------------------------------------ Bloqueo del motor --

seccion "Bloqueo automático del motor (umbral de prueba: $UMBRAL fallos)"
# fallos <red> <ip> <host> <puerto> <usuario> [cabeceras…]: los códigos de N fallos
fallos() {
  local red=$1 ip=$2 host=$3 puerto=$4 usuario=$5 cabeceras=''
  shift 5
  [ "$#" -gt 0 ] && printf -v cabeceras '%q ' "$@"
  cliente "$red" "$ip" <<EOF
for i in \$(seq 1 $((UMBRAL + 4))); do
  curl -sS -o /dev/null -w '%{http_code} ' --cacert /tmp/ca.pem $cabeceras -u "$usuario:mala\$i" "https://$host:$puerto/jmap/session" 2>/dev/null || printf 'x '
done
EOF
}
bloqueadas() {
  if [ "$MOTOR" = stalwart-0.16 ]; then
    jmap '[["x:BlockedIp/query",{},"a"],["x:BlockedIp/get",{"#ids":{"resultOf":"a","name":"x:BlockedIp/query","path":"/ids"}},"b"]]' |
      python3 -c 'import json,sys; print(" ".join(i.get("address","") for i in json.load(sys.stdin)["methodResponses"][1][1].get("list",[])))'
  else
    api GET '/api/settings/list?prefix=server.blocked-ip' |
      python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]["items"]; print(" ".join(d.keys() if isinstance(d, dict) else [i.get("key","") for i in d]))'
  fi
}
SALIDA=$(fallos "${P}calle" "$C.60" mail.mwp.test 443 directo@mwp.test -H "X-Forwarded-For: $IP_EXENTA" -H "Forwarded: for=$IP_EXENTA")
contiene 'visitante directo que dice ser de la red exenta: bloqueado al pasar el umbral' "$SALIDA" '429'
SALIDA=$(fallos "${P}cf" "$IP_CF_1" mail.mwp.test 443 porcf@mwp.test -H "X-Forwarded-For: $IP_EXENTA, 203.0.113.60" -H 'CF-Connecting-IP: 203.0.113.60')
contiene 'por Cloudflare, diciendo ser de la red exenta: bloqueado al pasar el umbral' "$SALIDA" '429'
SALIDA=$(fallos "${P}cf" "$IP_CF_2" crudo.mwp.test 443 sinpasarela@mwp.test -H "X-Forwarded-For: $IP_EXENTA, 203.0.113.61" -H 'CF-Connecting-IP: 203.0.113.61')
no_contiene 'SIN la pasarela, el mismo ataque por Cloudflare se hace pasar por la red exenta y nunca se bloquea' "$SALIDA" '429'
BLOQUEADAS=$(bloqueadas)
contiene 'el motor bloqueó la IP del visitante directo' "$BLOQUEADAS" "$C.60"
contiene 'y la del visitante según Cloudflare' "$BLOQUEADAS" '203.0.113.60'
no_contiene 'no la del nodo de Cloudflare' "$BLOQUEADAS" "$IP_CF_1"
no_contiene 'ni ninguna de la red exenta' "$BLOQUEADAS" "$I."
no_contiene 'ni la de Traefik' "$BLOQUEADAS" "$B.5"

# ----------------------------------------------------- Lo que ya pasaba --

seccion 'Lo que pasaba por Traefik sigue pasando'
# Las mismas peticiones al motor por la pasarela (mail.mwp.test) y sin ella
# (crudo.mwp.test, Traefik directo al motor, como antes): mismas respuestas.
# probar <host> [cuenta JMAP]
probar() {
  cliente "${P}calle" "$C.70" -e "CLAVE=$CLAVE_ANA" -e "H=$1" -e "CUENTA=${2:-}" <<'EOF'
A="ana@mwp.test:$CLAVE"
echo "SESION $(curl -sS --cacert /tmp/ca.pem -u "$A" "https://$H/jmap/session")"
echo "WELLKNOWN $(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --cacert /tmp/ca.pem "https://$H/.well-known/jmap")"
echo "SALUD $(curl -sS -o /dev/null -w '%{http_code}' --cacert /tmp/ca.pem "https://$H/healthz/live")"
[ -n "$CUENTA" ] || exit 0
# 20 MB por cada camino: el motor admite 50 MB de subidas pendientes por cuenta.
head -c 20971520 /dev/urandom >/tmp/adjunto
echo "SUBIDA $(curl -sS --cacert /tmp/ca.pem -u "$A" -H 'Content-Type: application/octet-stream' --data-binary @/tmp/adjunto "https://$H/jmap/upload/$CUENTA/" | sed -n 's/.*"size":\([0-9]*\).*/\1/p')"
# El push de JMAP: una conexión abierta (EventSource) que recibe un evento en
# cuanto cambia algo del buzón (aquí, una carpeta nueva). El motor no responde
# nada hasta el primer evento; sin búfer en medio, llega antes de que curl
# corte la conexión.
curl -sS -N --max-time 12 --cacert /tmp/ca.pem -u "$A" "https://$H/jmap/eventsource/?types=*&closeafter=no&ping=300" >/tmp/push 2>/dev/null &
sleep 3
curl -sS -o /dev/null --cacert /tmp/ca.pem -u "$A" -H 'Content-Type: application/json' "https://$H/jmap/" \
  -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Mailbox/set\",{\"accountId\":\"$CUENTA\",\"create\":{\"m\":{\"name\":\"Push $H\"}}},\"a\"]]}"
wait
echo "PUSH $(grep -c '^event: state' /tmp/push)"
echo "WS $(curl -sS -i --http1.1 --max-time 4 --cacert /tmp/ca.pem -u "$A" -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Protocol: jmap' \
  "https://$H/jmap/ws" 2>/dev/null | head -n 1 | tr -d '\r')"
echo "DAV $(curl -sS -o /dev/null -w '%{http_code}' --cacert /tmp/ca.pem -u "$A" -X PROPFIND -H 'Depth: 0' "https://$H/dav/card/ana@mwp.test/")"
echo "AUTOCONFIG $(curl -sS --cacert /tmp/ca.pem "https://$H/mail/config-v1.1.xml?emailaddress=ana%40mwp.test" | grep -c '<hostname>')"
EOF
}
dato() { sed -n "s/^$1 //p" <<<"$2"; }
# Las direcciones que anuncia la sesión JMAP, sin el estado.
urls() { python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(" ".join(d[k] for k in ("apiUrl","downloadUrl","uploadUrl","eventSourceUrl")))' "$1" 2>/dev/null; }
SIN=$(probar crudo.mwp.test)
CON=$(probar mail.mwp.test)
SESION=$(dato SESION "$CON")
contiene 'sesión JMAP con la contraseña buena' "$SESION" '"apiUrl"'
CUENTA=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["primaryAccounts"]["urn:ietf:params:jmap:mail"])' "$SESION" 2>/dev/null)
comprobar 'la sesión anuncia las mismas direcciones que sin la pasarela' \
  "$(urls "$(dato SESION "$SIN")" | sed 's/crudo\.mwp\.test/mail.mwp.test/g')" "$(urls "$SESION")"
comprobar '/.well-known/jmap responde igual' "$(dato WELLKNOWN "$SIN" | sed 's/crudo\.mwp\.test/mail.mwp.test/g')" "$(dato WELLKNOWN "$CON")"
comprobar 'salud del motor' '200' "$(dato SALUD "$CON")"
SIN=$(probar crudo.mwp.test "$CUENTA")
CON=$(probar mail.mwp.test "$CUENTA")
comprobar 'una subida de 20 MB pasa entera (sin tope ni búfer en la pasarela)' '20971520' "$(dato SUBIDA "$CON")"
comprobar 'el push de JMAP (EventSource) llega sin esperar al final de la respuesta' '1' "$(dato PUSH "$CON")"
comprobar 'JMAP sobre WebSocket: la misma respuesta que sin la pasarela' "$(dato WS "$SIN")" "$(dato WS "$CON")"
if [ "$MOTOR" = stalwart-0.16 ]; then
  comprobar 'JMAP sobre WebSocket: el motor acepta el cambio de protocolo' 'HTTP/1.1 101 Switching Protocols' "$(dato WS "$CON")"
fi
comprobar 'DAV (PROPFIND) pasa' '207' "$(dato DAV "$CON")"
comprobar 'la autoconfiguración de Thunderbird responde igual' "$(dato AUTOCONFIG "$SIN")" "$(dato AUTOCONFIG "$CON")"

# ------------------------------------------------------------- Registro --

seccion 'Registro de la pasarela'
cliente "${P}calle" "$C.80" >/dev/null <<'EOF'
curl -sS -o /dev/null --cacert /tmp/ca.pem -u 'nadie@mwp.test:SECRETO-EN-LA-CLAVE' 'https://mail.mwp.test/jmap/session?token=SECRETO-EN-LA-URL'
EOF
REGISTRO=$(docker logs "${P}pasarela" 2>&1)
contiene 'anota los accesos rechazados con la IP real' "$REGISTRO" "\"ip\":\"$C.80\""
no_contiene 'sin la cadena de consulta' "$REGISTRO" 'SECRETO-EN-LA-URL'
no_contiene 'sin credenciales' "$REGISTRO" 'SECRETO-EN-LA-CLAVE'
no_contiene 'sin la contraseña del buzón' "$REGISTRO" "$CLAVE_ANA"
no_contiene 'sin anotar lo que sale bien (la salud)' "$REGISTRO" '"ruta":"/healthz/live"'

TERMINADA=1
echo
if [ "$FALLOS" -gt 0 ]; then
  echo "$FALLOS comprobaciones fallidas."
  exit 1
fi
echo "Todas las comprobaciones han pasado ($MOTOR)."
