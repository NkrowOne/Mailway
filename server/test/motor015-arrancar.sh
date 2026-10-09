#!/usr/bin/env bash
# Arranca un Stalwart 0.15.5 desechable para la prueba del panel contra un
# motor real (server/test/panel-motor-real.test.ts) y escribe por la salida
# estándar las variables que necesita la prueba, listas para `eval`:
#
#   eval "$(server/test/motor015-arrancar.sh)"
#   cd server && node --test --import tsx --import ./test/env.ts \
#     --import ./test/env-real.ts test/panel-motor-real.test.ts
#   docker rm -f "$MAILWAY_TEST_MOTOR_CONTENEDOR"
#
# Todo lo demás (progreso y errores) va a la salida de errores. La puesta en
# marcha es la de una instalación nueva, como la del instalador:
#   1. Sin config.toml, el punto de entrada de la imagen lo crea
#      (`stalwart --init`) con los puertos por defecto (25, 465, 587 con
#      STARTTLS, 993…) y con STALWART_ADMIN_PASSWORD como contraseña del
#      administrador de respaldo (`admin`). Esa variable solo se lee en ese
#      primer arranque.
#      Las escuchas por defecto son «[::]:<puerto>»: en una máquina cuyo
#      núcleo no tiene IPv6 (ipv6.disable=1, como algunas VM de CI) el motor
#      no puede abrir ninguna. Solo en ese caso se cambian por 0.0.0.0 justo
#      después de crear la configuración; con IPv6 queda como la deja la
#      imagen.
#   2. Hasta que los ajustes recomendados de Mailway fijan server.hostname,
#      el motor se anuncia con el nombre del contenedor (--hostname).
#   3. No hace falta reiniciar: la API REST de gestión (/api/*) responde en
#      cuanto el motor está vivo, y en 0.15 todo se aplica con una recarga.
#
# Variables opcionales (con su valor por defecto):
#   MOTOR015_CONTENEDOR=mailway-motor015-prueba
#   MOTOR015_IMAGEN=stalwartlabs/stalwart:v0.15.5
#   MOTOR015_IP=127.0.0.1                 (dónde se publican los puertos)
#   MOTOR015_PUERTO_HTTP=19080            (8080 del contenedor)
#   MOTOR015_PUERTO_SMTP=19025            (25)
#   MOTOR015_PUERTO_SMTPS=19465           (465, TLS implícito)
#   MOTOR015_PUERTO_SUBMISSION=19587      (587, STARTTLS)
#   MOTOR015_PUERTO_IMAPS=19993           (993)
#   MOTOR015_HOSTNAME=mail.mailway.test   (nombre del servidor)
set -euo pipefail

CONTENEDOR="${MOTOR015_CONTENEDOR:-mailway-motor015-prueba}"
IMAGEN="${MOTOR015_IMAGEN:-stalwartlabs/stalwart:v0.15.5}"
IP="${MOTOR015_IP:-127.0.0.1}"
PUERTO_HTTP="${MOTOR015_PUERTO_HTTP:-19080}"
PUERTO_SMTP="${MOTOR015_PUERTO_SMTP:-19025}"
PUERTO_SMTPS="${MOTOR015_PUERTO_SMTPS:-19465}"
PUERTO_SUBMISSION="${MOTOR015_PUERTO_SUBMISSION:-19587}"
PUERTO_IMAPS="${MOTOR015_PUERTO_IMAPS:-19993}"
NOMBRE_SERVIDOR="${MOTOR015_HOSTNAME:-mail.mailway.test}"
URL="http://${IP}:${PUERTO_HTTP}"

aviso() { printf '%s\n' "$*" >&2; }
fallo() {
  aviso "ERROR: $*"
  docker logs --tail 40 "$CONTENEDOR" >&2 2>&1 || true
  exit 1
}

command -v docker >/dev/null || fallo "no se encuentra docker"
command -v curl >/dev/null || fallo "no se encuentra curl"

if command -v openssl >/dev/null; then
  CLAVE="$(openssl rand -hex 16)"
else
  CLAVE="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi

# Espera a que una ruta de salud responda 200 (mientras arranca, el proxy de
# Docker acepta la conexión y la corta: curl falla y se reintenta).
esperar() {
  local ruta="$1" limite="${2:-120}" i
  for ((i = 0; i < limite; i++)); do
    if curl -fsS -o /dev/null --max-time 2 "${URL}${ruta}" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

aviso "Quitando un contenedor anterior con el mismo nombre (${CONTENEDOR}), si lo hay…"
docker rm -f "$CONTENEDOR" >/dev/null 2>&1 || true

# El mismo arranque que el punto de entrada de la imagen (crear la
# configuración si no existe y arrancar con ella), más el cambio de las
# escuchas a IPv4 cuando el núcleo no tiene IPv6. Se repite en cada arranque
# del contenedor (docker restart), pero solo actúa la primera vez.
ARRANQUE='
if [ ! -f /opt/stalwart/etc/config.toml ]; then
  /usr/local/bin/stalwart --init /opt/stalwart || exit 1
  if [ ! -e /proc/net/if_inet6 ]; then
    sed -i "s/\"\[::\]:/\"0.0.0.0:/" /opt/stalwart/etc/config.toml
  fi
fi
exec /usr/local/bin/stalwart --config /opt/stalwart/etc/config.toml
'

aviso "Arrancando ${IMAGEN} como ${CONTENEDOR}…"
docker run -d --name "$CONTENEDOR" \
  --hostname "$NOMBRE_SERVIDOR" \
  -p "${IP}:${PUERTO_HTTP}:8080" \
  -p "${IP}:${PUERTO_SMTP}:25" \
  -p "${IP}:${PUERTO_SMTPS}:465" \
  -p "${IP}:${PUERTO_SUBMISSION}:587" \
  -p "${IP}:${PUERTO_IMAPS}:993" \
  -e "STALWART_ADMIN_PASSWORD=${CLAVE}" \
  --entrypoint /bin/sh \
  "$IMAGEN" -c "$ARRANQUE" >/dev/null || fallo "no se pudo arrancar el contenedor"

esperar /healthz/live 120 || fallo "el motor no responde en ${URL}/healthz/live"

# La API REST de gestión con la credencial del administrador de respaldo
# confirma que es 0.15 y que STALWART_ADMIN_PASSWORD se ha aplicado. Pocos
# intentos y espaciados: cada credencial rechazada cuenta para el bloqueo
# automático de IPs del motor.
aviso "Comprobando la API REST de gestión…"
API_LISTA=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  RESPUESTA="$(curl -sS --max-time 5 -u "admin:${CLAVE}" \
    "${URL}/api/principal?types=domain&page=1&limit=1" 2>/dev/null || true)"
  case "$RESPUESTA" in
    *'"data"'*) API_LISTA=1; break ;;
  esac
  sleep 2
done
[ "$API_LISTA" = 1 ] || fallo "la API REST de gestión no responde con la credencial del administrador: ${RESPUESTA:-sin respuesta}"

aviso "Listo: Stalwart 0.15 en ${URL} (contenedor ${CONTENEDOR})."
cat <<VARIABLES
export MAILWAY_TEST_MOTOR_URL='${URL}'
export MAILWAY_TEST_MOTOR_USER='admin'
export MAILWAY_TEST_MOTOR_PASSWORD='${CLAVE}'
export MAILWAY_TEST_MOTOR_API='rest015'
export MAILWAY_TEST_MOTOR_HOST='${IP}'
export MAILWAY_TEST_MOTOR_SMTP='${PUERTO_SMTP}'
export MAILWAY_TEST_MOTOR_SMTPS='${PUERTO_SMTPS}'
export MAILWAY_TEST_MOTOR_SUBMISSION='${PUERTO_SUBMISSION}'
export MAILWAY_TEST_MOTOR_IMAPS='${PUERTO_IMAPS}'
export MAILWAY_TEST_MOTOR_CONTENEDOR='${CONTENEDOR}'
VARIABLES
