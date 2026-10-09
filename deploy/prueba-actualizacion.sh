#!/usr/bin/env bash
#
# Pruebas de «mailway update --auto» y de «mailway auto-update»
# (deploy/mailway.sh) sin contenedores, sin red y sin root: git de verdad
# sobre repositorios locales (el «GitHub» es una carpeta) y docker, systemctl,
# journalctl, sleep, id y el instalador simulados. Carga las funciones de
# mailway.sh (todo menos la última línea) y comprueba:
#   - sin versión nueva no se aplica nada ni se habla con Docker;
#   - una versión que funciona se aplica una sola vez, se comprueba (con
#     reintentos si tarda) y se avisa; los secretos del resumen se tapan;
#   - si la nueva no supera la comprobación, no se puede aplicar o el panel
#     deja de responder, vuelve a la anterior con git e instalar.sh, avisa y
#     termina con 1; si la vuelta atrás también falla, con 2;
#   - una versión que falla se reintenta una vez y después no se insiste;
#   - con el servidor ya enfermo, sin el Traefik de Skyway, con cambios a
#     mano o con otra actualización en curso no se toca nada;
#   - una actualización interrumpida se retoma;
#   - auto-update on/off/status escribe y retira las unidades de systemd en
#     una carpeta temporal y llama a systemctl.
#
#   bash deploy/prueba-actualizacion.sh     # código 1 si alguna comprobación falla
#
# Necesita git 2.28 o posterior. Las variables que fija cada escenario las
# leen las funciones de mailway.sh o los dobles, que el análisis estático no
# ve: de ahí SC2034. Y cada escenario corre en un subshell para que sus
# cambios no lleguen a los siguientes: SC2030 y SC2031.
# shellcheck disable=SC2034,SC2030,SC2031

set -uo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC2016
ULTIMA='main "$@"; exit $?'
if [ "$(tail -n 1 "$AQUI/mailway.sh")" != "$ULTIMA" ]; then
  echo "La última línea de mailway.sh ya no es «$ULTIMA»: actualiza esta prueba." >&2
  exit 1
fi
command -v git >/dev/null 2>&1 || { echo "Falta git." >&2; exit 1; }

TMP=$(mktemp -d)
BIN="$TMP/bin"
REGISTRO="$TMP/registro"
SALIDA="$TMP/salida"
# Llamadas que ningún doble esperaba: al final, debe estar vacío.
IMPREVISTOS="$TMP/imprevistos"
mkdir -p "$BIN" "$TMP/enlace"
: >"$REGISTRO"
: >"$IMPREVISTOS"
ID_REAL=$(command -v id)
TERMINADA=0
trap 'rm -rf "$TMP"; [ "$TERMINADA" = 1 ] || echo "FALLO - la prueba terminó antes de tiempo"' EXIT

# git aislado: ni la configuración del sistema ni la del usuario (firmas,
# ganchos, plantillas) cambian lo que hace la prueba.
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=Prueba GIT_AUTHOR_EMAIL=prueba@mailway.test
export GIT_COMMITTER_NAME=Prueba GIT_COMMITTER_EMAIL=prueba@mailway.test
export PRUEBA_REGISTRO=$REGISTRO PRUEBA_IMPREVISTOS=$IMPREVISTOS

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
no_existe() { [ ! -e "$1" ]; }
# Líneas de $1 que contienen $2.
cuenta() { grep -cF -- "$2" "$1"; }
# ¿Hay una línea con $3 después de la primera con $2?
despues_de() {
  local a b
  a=$(grep -nF -- "$2" "$1" | head -n 1 | cut -d: -f1)
  b=$(grep -nF -- "$3" "$1" | tail -n 1 | cut -d: -f1)
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}

# ------------------------------------------------------------------ dobles --

# docker: anota cada llamada y responde según PRUEBA_*. La salud del panel
# depende de la versión aplicada (PRUEBA_APLICADA, la escribe el instalador).
cat >"$BIN/docker" <<'DOCKER'
#!/usr/bin/env bash
echo "docker $*" >>"$PRUEBA_REGISTRO"
aplicada=$(cat "$PRUEBA_APLICADA" 2>/dev/null || true)
case "$*" in
  info | "network inspect skyway-edge") exit 0 ;;
  "inspect --type container -f {{.State.Running}} skyway-traefik") echo "${PRUEBA_TRAEFIK:-true}" ;;
  "inspect --type container -f {{.State.Running}} skyway-mailway-panel") echo true ;;
  "exec skyway-mailway-panel test -f server/dist/tools/avisar.js") exit 0 ;;
  "exec -u node skyway-mailway-panel node server/dist/tools/avisar.js "*)
    echo "Incidencia abierta en Avisos (no hay canales de aviso configurados)."
    ;;
  "exec skyway-mailway-panel node -e "*) [ "$aplicada" != "${PRUEBA_PANEL_CAIDO_EN:-}" ] ;;
  *)
    echo "docker no simulado: $*" >>"$PRUEBA_IMPREVISTOS"
    exit 1
    ;;
esac
DOCKER

# El instalador de cada versión (va en git, en todas): anota cada llamada con
# la versión de su copia. --actualizar deja esa versión como aplicada y
# muestra un resumen con secretos; --comprobar falla con las versiones
# aplicadas de PRUEBA_ROTAS, y las PRUEBA_PASAJEROS primeras veces con
# PRUEBA_PASAJERO_EN.
cat >"$TMP/instalar-simulado.sh" <<'INSTALAR'
#!/usr/bin/env bash
version=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$(dirname "$0")/../package.json")
echo "instalar $1 $version" >>"$PRUEBA_REGISTRO"
case "$1" in
  --actualizar)
    case " ${PRUEBA_FALLA_APLICAR:-} " in
      *" $version "*)
        echo "   [error] Fallo simulado al aplicar la $version." >&2
        exit 1
        ;;
    esac
    printf '%s\n' "$version" >"$PRUEBA_APLICADA"
    echo "   Panel:               https://panel.ejemplo.test/setup?token=token-de-puesta-1234"
    echo "   Token de puesta en marcha: token-de-puesta-1234"
    echo "   Contraseña:          clave-del-administrador-1234"
    ;;
  --comprobar)
    aplicada=$(cat "$PRUEBA_APLICADA")
    if [ "${PRUEBA_CLAVE_RECHAZADA:-0}" = 1 ]; then
      echo "   [aviso] El motor rechaza la contraseña de administración de deploy/.env (STALWART_ADMIN_PASSWORD). No se reintenta."
      exit 1
    fi
    case " ${PRUEBA_ROTAS:-} " in
      *" $aplicada "*)
        echo "   [aviso] mailway-webmail: unhealthy. Revisa: docker logs mailway-webmail"
        exit 1
        ;;
    esac
    if [ "$aplicada" = "${PRUEBA_PASAJERO_EN:-}" ]; then
      veces=$(($(cat "$PRUEBA_CONTADOR" 2>/dev/null || echo 0) + 1))
      echo "$veces" >"$PRUEBA_CONTADOR"
      if [ "$veces" -le "${PRUEBA_PASAJEROS:-0}" ]; then
        echo "   [aviso] mailway-webmail: starting. Revisa: docker logs mailway-webmail"
        exit 1
      fi
    fi
    echo "   [ok] Todo correcto."
    ;;
esac
INSTALAR

cat >"$BIN/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
echo "systemctl $*" >>"$PRUEBA_REGISTRO"
case "$1" in
  is-enabled) echo enabled ;;
  is-active) echo active ;;
  show) echo "Sat 2026-10-10 04:52:31 CEST" ;;
esac
exit 0
SYSTEMCTL

cat >"$BIN/journalctl" <<'JOURNALCTL'
#!/usr/bin/env bash
echo "journalctl $*" >>"$PRUEBA_REGISTRO"
echo "oct 09 04:51:02 servidor mailway[812]: Mailway ya está al día (versión 1.3.0)."
JOURNALCTL

# Sin esperas de verdad: la prueba cuenta los reintentos.
cat >"$BIN/sleep" <<'SLEEP'
#!/usr/bin/env bash
echo "sleep $*" >>"$PRUEBA_REGISTRO"
SLEEP

# root para mailway.sh (PRUEBA_UID lo cambia); lo demás, el id de verdad.
cat >"$BIN/id" <<ID
#!/usr/bin/env bash
if [ "\${1:-}" = -u ]; then echo "\${PRUEBA_UID:-0}"; else exec "$ID_REAL" "\$@"; fi
ID

chmod +x "$BIN"/* "$TMP/instalar-simulado.sh"
export PATH="$BIN:$PATH"

# --------------------------------------------------------------- escenarios --

# Un escenario nuevo: «GitHub» (repositorio desnudo), la copia de quien
# publica y la del servidor, con la 1.3.0 aplicada y su commit en V130. La
# copia de mailway.sh que se prueba va en la del servidor (fuera de git), así
# que su RAIZ es la del servidor.
nuevo_escenario() {
  ESC=$(mktemp -d "$TMP/escenario.XXXXXX")
  git init -q --bare -b main "$ESC/origen.git"
  git init -q -b main "$ESC/autor"
  mkdir -p "$ESC/autor/deploy"
  printf '{\n  "name": "mailway",\n  "version": "1.3.0",\n  "private": true\n}\n' >"$ESC/autor/package.json"
  cp "$TMP/instalar-simulado.sh" "$ESC/autor/deploy/instalar.sh"
  git -C "$ESC/autor" add -A
  git -C "$ESC/autor" commit -q -m "Versión 1.3.0"
  git -C "$ESC/autor" remote add origin "$ESC/origen.git"
  git -C "$ESC/autor" push -q origin main
  git clone -q "$ESC/origen.git" "$ESC/servidor"
  sed '$d' "$AQUI/mailway.sh" >"$ESC/servidor/deploy/mailway.sh"
  printf "MAILWAY_INSTALACION='skyway'\nMAILWAY_PANEL_INTERNAL_URL='http://skyway-mailway-panel:4100'\n" \
    >"$ESC/servidor/deploy/.env"
  export PRUEBA_APLICADA="$ESC/aplicada" PRUEBA_CONTADOR="$ESC/contador"
  echo 1.3.0 >"$PRUEBA_APLICADA"
  rm -rf "$TMP/systemd"
  V130=$(git -C "$ESC/servidor" rev-parse HEAD)
}

# Publica una versión en «GitHub» y escribe su commit.
publicar() {
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$1\"/" "$ESC/autor/package.json"
  git -C "$ESC/autor" commit -q -am "Versión $1"
  git -C "$ESC/autor" push -q origin main
  git -C "$ESC/autor" rev-parse HEAD
}

# Ejecuta «mailway …» en el servidor (root simulado) dentro de un subshell,
# con el registro vacío: deja la salida en $SALIDA y el código en $CODIGO.
# Las asignaciones PRUEBA_*=… del principio describen el escenario.
ejecutar_mailway() {
  : >"$REGISTRO"
  (
    while [[ ${1:-} == PRUEBA_*=* ]]; do
      export "${1?}"
      shift
    done
    MAILWAY_SYSTEMD_DIR="$TMP/systemd"
    # shellcheck source=/dev/null
    source "$ESC/servidor/deploy/mailway.sh"
    ENLACE="$TMP/enlace/mailway"
    main "$@"
  ) >"$SALIDA" 2>&1 </dev/null
  CODIGO=$?
}

cabeza() { git -C "$ESC/servidor" rev-parse HEAD; }
estado() { sed -n "s/^$1=//p" "$ESC/servidor/deploy/.actualizacion" 2>/dev/null; }

echo "# Sin versión nueva: no se aplica nada ni se habla con Docker"
nuevo_escenario
ejecutar_mailway update --auto
comprobar "termina con 0" igual "$CODIGO" 0
comprobar "dice que está al día" contiene "$SALIDA" "Mailway ya está al día (versión 1.3.0)"
comprobar "no llama al instalador" no_contiene "$REGISTRO" "instalar "
comprobar "no llama a Docker (nada se reinicia cada noche)" no_contiene "$REGISTRO" "docker "
comprobar "ni avisa" no_contiene "$REGISTRO" "avisar.js"
comprobar "ni guarda estado" no_existe "$ESC/servidor/deploy/.actualizacion"

echo "# Versión nueva que funciona: se comprueba antes, se aplica una vez, se comprueba y se avisa"
nuevo_escenario
V131=$(publicar 1.3.1)
ejecutar_mailway update --auto
comprobar "termina con 0" igual "$CODIGO" 0
comprobar "comprueba antes de tocar nada" despues_de "$REGISTRO" "instalar --comprobar 1.3.0" "instalar --actualizar 1.3.1"
comprobar "aplica una sola vez" igual "$(cuenta "$REGISTRO" "instalar --actualizar")" 1
comprobar "y comprueba la nueva" despues_de "$REGISTRO" "instalar --actualizar 1.3.1" "instalar --comprobar 1.3.1"
comprobar "también el panel" contiene "$REGISTRO" "docker exec skyway-mailway-panel node -e"
comprobar "sin esperas: pasa a la primera" no_contiene "$REGISTRO" "sleep"
comprobar "la copia queda en la versión nueva" igual "$(cabeza)" "$V131"
comprobar "guarda la versión anterior" igual "$(estado ANTERIOR)" "$V130"
comprobar "y el resultado" igual "$(estado RESULTADO)" actualizada
comprobar "avisa del éxito" contiene "$REGISTRO" "avisar.js --nivel info --clave actualizacion:aplicada --titulo Mailway actualizado a la versión 1.3.1"
comprobar "con lo aplicado" contiene "$REGISTRO" "ha aplicado 1 cambio de GitHub (${V130:0:8} → ${V131:0:8})"
comprobar "tapa el token de puesta en marcha" no_contiene "$SALIDA" "token-de-puesta-1234"
comprobar "y la contraseña del administrador" no_contiene "$SALIDA" "clave-del-administrador-1234"
comprobar "pero deja ver el resto del resumen" contiene "$SALIDA" "Token de puesta en marcha: •••"

echo "# La nueva tarda en estar sana: la comprobación se repite hasta que pasa"
nuevo_escenario
publicar 1.3.1 >/dev/null
ejecutar_mailway PRUEBA_PASAJERO_EN=1.3.1 PRUEBA_PASAJEROS=2 update --auto
comprobar "termina con 0" igual "$CODIGO" 0
comprobar "espera dos veces" igual "$(cuenta "$REGISTRO" "sleep 15")" 2
comprobar "sin volver atrás" igual "$(cuenta "$REGISTRO" "instalar --actualizar")" 1

echo "# La nueva no supera la comprobación: vuelve a la anterior y avisa"
nuevo_escenario
V131=$(publicar 1.3.1)
ejecutar_mailway PRUEBA_ROTAS=1.3.1 update --auto
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "insiste hasta tres minutos antes de rendirse" igual "$(cuenta "$REGISTRO" "sleep 15")" 12
comprobar "aplica la nueva y después la anterior" despues_de "$REGISTRO" "instalar --actualizar 1.3.1" "instalar --actualizar 1.3.0"
comprobar "y comprueba la anterior" despues_de "$REGISTRO" "instalar --actualizar 1.3.0" "instalar --comprobar 1.3.0"
comprobar "la copia vuelve al commit anterior" igual "$(cabeza)" "$V130"
comprobar "que supera la comprobación" contiene "$SALIDA" "El servidor ha vuelto a la versión 1.3.0"
comprobar "muestra el diagnóstico" contiene "$SALIDA" "mailway-webmail: unhealthy"
comprobar "anota la versión que falló" igual "$(estado FALLIDA)" "$V131"
comprobar "y el resultado" igual "$(estado RESULTADO)" revertida
comprobar "avisa en el panel" contiene "$REGISTRO" "avisar.js --nivel aviso --clave actualizacion:revertida:${V131:0:8}"
comprobar "con el motivo" contiene "$REGISTRO" "Detalle: mailway-webmail: unhealthy"

echo "# La misma versión se reintenta una vez más y después no se insiste"
ejecutar_mailway PRUEBA_ROTAS=1.3.1 update --auto
comprobar "segundo intento: vuelve atrás de nuevo" igual "$CODIGO" 1
comprobar "dos intentos anotados" igual "$(estado INTENTOS)" 2
comprobar "el aviso dice que no se insistirá" contiene "$REGISTRO" "No se volverá a intentar sola"
ejecutar_mailway PRUEBA_ROTAS=1.3.1 update --auto
comprobar "tercera vez: termina con 0" igual "$CODIGO" 0
comprobar "sin aplicar nada" no_contiene "$REGISTRO" "instalar "
comprobar "explica por qué" contiene "$SALIDA" "no se reintenta sola"
V132=$(publicar 1.3.2)
ejecutar_mailway PRUEBA_ROTAS=1.3.1 update --auto
comprobar "con una versión nueva sí se intenta" igual "$CODIGO" 0
comprobar "y queda aplicada" igual "$(cabeza)" "$V132"
comprobar "la que falló se olvida" igual "$(estado FALLIDA)" ""

echo "# La vuelta atrás también falla: termina con 2 y avisa como crítico"
nuevo_escenario
V131=$(publicar 1.3.1)
ejecutar_mailway PRUEBA_ROTAS=1.3.1 PRUEBA_FALLA_APLICAR=1.3.0 update --auto
comprobar "termina con 2" igual "$CODIGO" 2
comprobar "intentó aplicar la anterior" contiene "$REGISTRO" "instalar --actualizar 1.3.0"
comprobar "el código está en el commit anterior" igual "$(cabeza)" "$V130"
comprobar "anota que no se pudo volver" igual "$(estado RESULTADO)" sin-revertir
comprobar "avisa como crítico" contiene "$REGISTRO" "avisar.js --nivel critico --clave actualizacion:sin-revertir:${V131:0:8}"
comprobar "con el motivo de la vuelta atrás" contiene "$REGISTRO" "Detalle: instalar.sh --actualizar ha terminado con código 1 al aplicar la versión anterior."

echo "# El instalador falla con la versión nueva: vuelve a la anterior sin esperar"
nuevo_escenario
publicar 1.3.1 >/dev/null
ejecutar_mailway PRUEBA_FALLA_APLICAR=1.3.1 update --auto
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "no comprueba una versión que no se aplicó" no_contiene "$REGISTRO" "instalar --comprobar 1.3.1"
comprobar "vuelve a la anterior" igual "$(cabeza)" "$V130"
comprobar "avisa con el motivo" contiene "$REGISTRO" "terminó con código 1"

echo "# El panel deja de responder con la versión nueva: vuelve a la anterior"
nuevo_escenario
publicar 1.3.1 >/dev/null
ejecutar_mailway PRUEBA_PANEL_CAIDO_EN=1.3.1 update --auto
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "dice qué falla" contiene "$SALIDA" "El panel (skyway-mailway-panel) no responde en /api/health"
comprobar "vuelve a la anterior" igual "$(cabeza)" "$V130"

echo "# El servidor ya falla antes de actualizar: no se toca nada"
nuevo_escenario
V131=$(publicar 1.3.1)
ejecutar_mailway PRUEBA_ROTAS=1.3.0 update --auto
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "no aplica nada" no_contiene "$REGISTRO" "instalar --actualizar"
comprobar "la copia sigue igual" igual "$(cabeza)" "$V130"
comprobar "lo intenta tres veces en medio minuto" igual "$(cuenta "$REGISTRO" "instalar --comprobar")" 3
comprobar "avisa" contiene "$REGISTRO" "avisar.js --nivel aviso --clave actualizacion:previa:${V131:0:8}"
comprobar "no da la versión por fallida" igual "$(estado FALLIDA)" ""

echo "# El motor rechaza la contraseña de deploy/.env: no se repite la comprobación"
nuevo_escenario
publicar 1.3.1 >/dev/null
ejecutar_mailway PRUEBA_CLAVE_RECHAZADA=1 update --auto
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "una sola comprobación (cada intento cuenta para el bloqueo automático)" igual "$(cuenta "$REGISTRO" "instalar --comprobar")" 1
comprobar "sin esperas" no_contiene "$REGISTRO" "sleep"
comprobar "no aplica nada" no_contiene "$REGISTRO" "instalar --actualizar"
comprobar "(el instalador lo sigue diciendo así)" contiene "$AQUI/instalar.sh" 'aviso "El motor rechaza la contraseña de administración'

echo "# Sin el Traefik de Skyway, el instalador no podría ni empezar: no se toca nada"
nuevo_escenario
publicar 1.3.1 >/dev/null
ejecutar_mailway PRUEBA_TRAEFIK=false update --auto
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "no aplica nada" no_contiene "$REGISTRO" "instalar "
comprobar "dice por qué" contiene "$REGISTRO" "Detalle: El Traefik de Skyway (skyway-traefik) no está en marcha."

echo "# Cambios hechos a mano en la copia: se para sin perderlos y avisa"
nuevo_escenario
publicar 1.3.1 >/dev/null
echo "# cambio hecho a mano" >>"$ESC/servidor/deploy/instalar.sh"
ejecutar_mailway update --auto
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "no aplica nada" no_contiene "$REGISTRO" "instalar "
comprobar "el cambio sigue ahí" contiene "$ESC/servidor/deploy/instalar.sh" "# cambio hecho a mano"
comprobar "la copia sigue igual" igual "$(cabeza)" "$V130"
comprobar "avisa" contiene "$REGISTRO" "--clave actualizacion:detenida:cambios-locales"
comprobar "con el motivo" contiene "$REGISTRO" "no se actualiza para no perderlos"

echo "# Otra actualización en curso: esta no hace nada"
if command -v flock >/dev/null 2>&1; then
  nuevo_escenario
  publicar 1.3.1 >/dev/null
  exec 8>>"$ESC/servidor/deploy/.actualizacion.lock"
  flock 8
  ejecutar_mailway update --auto
  exec 8>&-
  comprobar "termina con 0" igual "$CODIGO" 0
  comprobar "lo dice" contiene "$SALIDA" "Ya hay otra actualización de Mailway en curso"
  comprobar "no aplica nada" no_contiene "$REGISTRO" "instalar "
else
  echo "(sin flock en este equipo: se omite)"
fi

echo "# Una actualización interrumpida con el código ya en la nueva se retoma"
nuevo_escenario
V131=$(publicar 1.3.1)
git -C "$ESC/servidor" pull -q --ff-only
printf 'RESULTADO=en-curso\nANTERIOR=%s\nOBJETIVO=%s\n' "$V130" "$V131" >"$ESC/servidor/deploy/.actualizacion"
ejecutar_mailway update --auto
comprobar "termina con 0" igual "$CODIGO" 0
comprobar "la aplica de nuevo" igual "$(cuenta "$REGISTRO" "instalar --actualizar 1.3.1")" 1
comprobar "queda como actualizada" igual "$(estado RESULTADO)" actualizada
echo "# …pero sin el Traefik de Skyway espera a la próxima ejecución sin tocar nada"
nuevo_escenario
V131=$(publicar 1.3.1)
git -C "$ESC/servidor" pull -q --ff-only
printf 'RESULTADO=en-curso\nANTERIOR=%s\nOBJETIVO=%s\n' "$V130" "$V131" >"$ESC/servidor/deploy/.actualizacion"
ejecutar_mailway PRUEBA_TRAEFIK=false update --auto
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "no aplica nada" no_contiene "$REGISTRO" "instalar --actualizar"
comprobar "y la deja para la próxima" igual "$(estado RESULTADO)" en-curso
echo "# …y si no funciona, vuelve a la que había antes de interrumpirse"
nuevo_escenario
V131=$(publicar 1.3.1)
git -C "$ESC/servidor" pull -q --ff-only
printf 'RESULTADO=en-curso\nANTERIOR=%s\nOBJETIVO=%s\n' "$V130" "$V131" >"$ESC/servidor/deploy/.actualizacion"
ejecutar_mailway PRUEBA_ROTAS=1.3.1 update --auto
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "vuelve a la anterior" igual "$(cabeza)" "$V130"

echo "# A mano (update -y) sigue igual: aplica, dice cómo volver y olvida la versión que falló"
nuevo_escenario
V131=$(publicar 1.3.1)
ejecutar_mailway PRUEBA_ROTAS=1.3.1 update --auto
ejecutar_mailway update -y
comprobar "termina con 0" igual "$CODIGO" 0
comprobar "aplica sin comprobar ni volver atrás" igual "$(grep '^instalar ' "$REGISTRO")" "instalar --actualizar 1.3.1"
comprobar "la copia queda en la versión nueva" igual "$(cabeza)" "$V131"
comprobar "dice cómo volver a la anterior" contiene "$SALIDA" "git -C $(cd "$ESC/servidor" && pwd -P) reset --hard $V130"
comprobar "anota la actualización a mano" igual "$(estado RESULTADO)" manual
comprobar "y olvida la versión que falló" igual "$(estado FALLIDA)" ""

echo "# --auto no se combina con --reaplicar"
nuevo_escenario
ejecutar_mailway update --auto --reaplicar
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "lo explica" contiene "$SALIDA" "no se combina con --reaplicar"

echo "# auto-update on: unidades de systemd y temporizador activado"
nuevo_escenario
SERVICIO="$TMP/systemd/mailway-auto-update.service"
TEMPORIZADOR="$TMP/systemd/mailway-auto-update.timer"
ejecutar_mailway auto-update on
comprobar "termina con 0" igual "$CODIGO" 0
comprobar "servicio de un solo disparo" contiene "$SERVICIO" "Type=oneshot"
comprobar "que ejecuta update --auto con la orden del PATH" contiene "$SERVICIO" "ExecStart=$TMP/enlace/mailway update --auto"
comprobar "a las 04:50 por defecto" contiene "$TEMPORIZADOR" "OnCalendar=*-*-* 04:50:00"
comprobar "con margen aleatorio" contiene "$TEMPORIZADOR" "RandomizedDelaySec=5min"
comprobar "y persistente" contiene "$TEMPORIZADOR" "Persistent=true"
comprobar "recarga systemd" contiene "$REGISTRO" "systemctl daemon-reload"
comprobar "y activa el temporizador" contiene "$REGISTRO" "systemctl enable --now mailway-auto-update.timer"
comprobar "deja la orden en el PATH" igual "$(readlink -f "$TMP/enlace/mailway")" "$(readlink -f "$ESC/servidor/deploy/mailway.sh")"
comprobar "dice la próxima ejecución" contiene "$SALIDA" "Próxima ejecución: Sat 2026-10-10 04:52:31 CEST"
ejecutar_mailway auto-update on --hora 03:15
comprobar "otra hora" contiene "$TEMPORIZADOR" "OnCalendar=*-*-* 03:15:00"
ejecutar_mailway auto-update on --hora 25:00
comprobar "una hora imposible termina con 1" igual "$CODIGO" 1
comprobar "sin tocar las unidades" contiene "$TEMPORIZADOR" "OnCalendar=*-*-* 03:15:00"
comprobar "ni llamar a systemctl" no_contiene "$REGISTRO" "systemctl"

echo "# auto-update status: activación, próxima ejecución, último resultado y registro"
printf 'FECHA=2026-10-09T04:51:02+02:00\nRESULTADO=revertida\nANTERIOR=%s\nOBJETIVO=%s\nVERSION_ANTERIOR=1.3.0\nVERSION_OBJETIVO=1.3.1\nFALLIDA=%s\nINTENTOS=1\n' \
  "$V130" "$V130" "$V130" >"$ESC/servidor/deploy/.actualizacion"
ejecutar_mailway auto-update status
comprobar "termina con 0" igual "$CODIGO" 0
comprobar "dice la hora" contiene "$SALIDA" "cada día a las 03:15"
comprobar "y la próxima ejecución" contiene "$SALIDA" "Próxima ejecución: Sat 2026-10-10 04:52:31 CEST"
comprobar "el último resultado" contiene "$SALIDA" "falló y el servidor volvió a la versión anterior · 1.3.0 → 1.3.1"
comprobar "la versión que falló" contiene "$SALIDA" "Versión que falló: ${V130:0:8} (1 de 2 intentos automáticos)"
comprobar "y el registro" contiene "$REGISTRO" "journalctl -u mailway-auto-update -n 30 --no-pager"

echo "# auto-update off: retira el temporizador"
ejecutar_mailway auto-update off
comprobar "termina con 0" igual "$CODIGO" 0
comprobar "lo desactiva" contiene "$REGISTRO" "systemctl disable --now mailway-auto-update.timer"
comprobar "retira el servicio" no_existe "$SERVICIO"
comprobar "y el temporizador" no_existe "$TEMPORIZADOR"
comprobar "recarga systemd" contiene "$REGISTRO" "systemctl daemon-reload"
ejecutar_mailway auto-update status
comprobar "status lo dice" contiene "$SALIDA" "Actualización automática desactivada"

echo "# auto-update sin root: pide sudo y no escribe nada"
ejecutar_mailway PRUEBA_UID=1000 auto-update on
comprobar "termina con 1" igual "$CODIGO" 1
comprobar "pide sudo" contiene "$SALIDA" "sudo mailway auto-update on"
comprobar "no escribe nada" no_existe "$SERVICIO"
comprobar "ni llama a systemctl" no_contiene "$REGISTRO" "systemctl"

echo "# Ningún doble ha recibido una llamada que no esperaba"
comprobar "ninguna llamada sin simular" igual "$(cat "$IMPREVISTOS")" ""

echo
TERMINADA=1
if [ "$FALLOS" -gt 0 ]; then
  echo "$FALLOS comprobaciones han fallado."
  exit 1
fi
echo "Todas las comprobaciones son correctas."
