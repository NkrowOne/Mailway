#!/usr/bin/env bash
# Arranca un Stalwart 0.16.25 desechable para la prueba real del driver JMAP
# (server/test/motor016-real.test.ts) y escribe por la salida estándar las
# variables que necesita la prueba, listas para `eval`:
#
#   eval "$(server/test/motor016-arrancar.sh)"
#   cd server && node --test --import tsx --import ./test/env.ts test/motor016-real.test.ts
#   docker rm -f "$MAILWAY_TEST_STALWART016_CONTENEDOR"
#
# Escribe también las de la prueba del panel contra un motor real
# (MAILWAY_TEST_MOTOR_*, las mismas que server/test/motor015-arrancar.sh):
#
#   cd server && node --test --import tsx --import ./test/env.ts \
#     --import ./test/env-real.ts test/panel-motor-real.test.ts
#
# Cada prueba deja sus datos en el motor: mejor un contenedor para cada una.
#
# Todo lo demás (progreso y errores) va a la salida de errores. La puesta en
# marcha es la de una instalación nueva, sin pasos interactivos:
#   1. Sin config.json el motor arranca en modo «bootstrap» (solo el 8080).
#      Con STALWART_RECOVERY_ADMIN fijada no genera contraseña temporal y ese
#      usuario vale también después, fuera del modo de recuperación.
#   2. x:Bootstrap/set escribe config.json, el dominio por defecto y los
#      ajustes del sistema. NO reinicia solo: hace falta `docker restart`.
#   3. Tras el reinicio escuchan los puertos por defecto (25, 465, 993, 995,
#      4190, 443 y 8080). El 587 NO existe: lo crean los ajustes recomendados
#      de Mailway y solo se abre al reiniciar otra vez (la prueba lo hace).
# El registro de eventos se deja como lo deja el motor (ficheros en
# /var/log/stalwart, que no existe en la imagen): la prueba comprueba que los
# ajustes recomendados lo pasan a la salida estándar.
#
# Variables opcionales (con su valor por defecto):
#   MOTOR016_CONTENEDOR=mailway-motor016-prueba
#   MOTOR016_IMAGEN=stalwartlabs/stalwart:v0.16.25
#   MOTOR016_IP=127.0.0.1                 (dónde se publican los puertos)
#   MOTOR016_PUERTO_HTTP=18080            (8080 del contenedor)
#   MOTOR016_PUERTO_SMTP=18025            (25)
#   MOTOR016_PUERTO_SMTPS=18465           (465, TLS implícito)
#   MOTOR016_PUERTO_SUBMISSION=18587      (587, STARTTLS)
#   MOTOR016_PUERTO_IMAPS=18993           (993)
#   MOTOR016_HOSTNAME=mail.mailway.test   (nombre del servidor)
#   MOTOR016_DOMINIO=arranque.mailway.test (dominio por defecto del arranque)
set -euo pipefail

CONTENEDOR="${MOTOR016_CONTENEDOR:-mailway-motor016-prueba}"
IMAGEN="${MOTOR016_IMAGEN:-stalwartlabs/stalwart:v0.16.25}"
IP="${MOTOR016_IP:-127.0.0.1}"
PUERTO_HTTP="${MOTOR016_PUERTO_HTTP:-18080}"
PUERTO_SMTP="${MOTOR016_PUERTO_SMTP:-18025}"
PUERTO_SMTPS="${MOTOR016_PUERTO_SMTPS:-18465}"
PUERTO_SUBMISSION="${MOTOR016_PUERTO_SUBMISSION:-18587}"
PUERTO_IMAPS="${MOTOR016_PUERTO_IMAPS:-18993}"
NOMBRE_SERVIDOR="${MOTOR016_HOSTNAME:-mail.mailway.test}"
DOMINIO="${MOTOR016_DOMINIO:-arranque.mailway.test}"
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

aviso "Arrancando ${IMAGEN} como ${CONTENEDOR}…"
docker run -d --name "$CONTENEDOR" \
  -p "${IP}:${PUERTO_HTTP}:8080" \
  -p "${IP}:${PUERTO_SMTP}:25" \
  -p "${IP}:${PUERTO_SMTPS}:465" \
  -p "${IP}:${PUERTO_SUBMISSION}:587" \
  -p "${IP}:${PUERTO_IMAPS}:993" \
  -e "STALWART_RECOVERY_ADMIN=admin:${CLAVE}" \
  "$IMAGEN" >/dev/null || fallo "no se pudo arrancar el contenedor"

esperar /healthz/live || fallo "el motor no responde en ${URL}/healthz/live"

aviso "Puesta en marcha (x:Bootstrap/set)…"
CUERPO=$(cat <<JSON
{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
 "methodCalls":[["x:Bootstrap/set",{"update":{"singleton":{
   "serverHostname":"${NOMBRE_SERVIDOR}","defaultDomain":"${DOMINIO}",
   "requestTlsCertificate":false,"generateDkimKeys":false}}},"c1"]]}
JSON
)
RESPUESTA="$(curl -fsS --max-time 30 -u "admin:${CLAVE}" -H 'Content-Type: application/json' \
  -d "$CUERPO" "${URL}/jmap")" || fallo "la puesta en marcha no respondió"
case "$RESPUESTA" in
  *'"updated"'*) ;;
  *) fallo "la puesta en marcha no se aplicó: ${RESPUESTA}" ;;
esac

aviso "Reiniciando para salir del modo de puesta en marcha…"
docker restart "$CONTENEDOR" >/dev/null || fallo "no se pudo reiniciar el contenedor"
esperar /healthz/ready || fallo "el motor no queda listo tras el reinicio"

# La sesión JMAP con la capacidad de gestión confirma que es 0.16 y que la
# credencial de administración vale fuera del modo de recuperación.
curl -fsS --max-time 10 -u "admin:${CLAVE}" "${URL}/jmap/session" | grep -q 'urn:stalwart:jmap' \
  || fallo "la sesión JMAP no ofrece urn:stalwart:jmap"

aviso "Listo: Stalwart 0.16 en ${URL} (contenedor ${CONTENEDOR})."
cat <<VARIABLES
export MAILWAY_TEST_STALWART016_URL='${URL}'
export MAILWAY_TEST_STALWART016_USER='admin'
export MAILWAY_TEST_STALWART016_PASSWORD='${CLAVE}'
export MAILWAY_TEST_STALWART016_HOST='${IP}'
export MAILWAY_TEST_STALWART016_SMTP='${PUERTO_SMTP}'
export MAILWAY_TEST_STALWART016_SMTPS='${PUERTO_SMTPS}'
export MAILWAY_TEST_STALWART016_SUBMISSION='${PUERTO_SUBMISSION}'
export MAILWAY_TEST_STALWART016_IMAPS='${PUERTO_IMAPS}'
export MAILWAY_TEST_STALWART016_HOSTNAME='${NOMBRE_SERVIDOR}'
export MAILWAY_TEST_STALWART016_CONTENEDOR='${CONTENEDOR}'
export MAILWAY_TEST_MOTOR_URL='${URL}'
export MAILWAY_TEST_MOTOR_USER='admin'
export MAILWAY_TEST_MOTOR_PASSWORD='${CLAVE}'
export MAILWAY_TEST_MOTOR_API='jmap016'
export MAILWAY_TEST_MOTOR_HOST='${IP}'
export MAILWAY_TEST_MOTOR_SMTP='${PUERTO_SMTP}'
export MAILWAY_TEST_MOTOR_SMTPS='${PUERTO_SMTPS}'
export MAILWAY_TEST_MOTOR_SUBMISSION='${PUERTO_SUBMISSION}'
export MAILWAY_TEST_MOTOR_IMAPS='${PUERTO_IMAPS}'
export MAILWAY_TEST_MOTOR_CONTENEDOR='${CONTENEDOR}'
VARIABLES
