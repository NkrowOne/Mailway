#!/usr/bin/env bash
# ============================================================================
# mailway: actualizar y revisar Mailway desde la terminal del servidor
# ----------------------------------------------------------------------------
# El instalador lo deja en /usr/local/bin/mailway (enlace a este fichero), así
# que se usa desde cualquier carpeta:
#
#   mailway update              # trae lo nuevo de GitHub y lo aplica (pregunta antes)
#   mailway update -y           # igual, sin preguntar
#   mailway update --reaplicar  # vuelve a aplicar aunque no haya nada nuevo
#   mailway update --auto       # desatendida: comprueba y vuelve atrás si algo falla
#   mailway auto-update on      # «update --auto» cada noche (temporizador de systemd)
#   mailway comprobar           # diagnóstico de solo lectura (instalar.sh --comprobar)
#   mailway probar-acceso       # abre un buzón desde el webmail (instalar.sh --probar-acceso)
#   mailway version
#
# «update» = «git pull» + «instalar.sh --actualizar»: el panel junto a Skyway
# se actualiza solo, pero el motor, el webmail y su tema viven en esta
# carpeta y solo cambian al reaplicar.
#
# «update --auto» es la que lanza el temporizador. Sin versión nueva no toca
# nada: ningún contenedor se reinicia cada noche. Con ella, comprueba que el
# servidor está sano, guarda la versión anterior (deploy/.actualizacion),
# aplica la nueva, la comprueba durante unos minutos y, si falla, vuelve a la
# anterior y la comprueba. Avisa a la administración en el panel (Avisos y
# sus canales). Códigos de salida:
#   0  actualizado y comprobado, o nada que hacer;
#   1  no se ha aplicado o se ha vuelto atrás: sigue la versión anterior;
#   2  ha fallado y la vuelta atrás también: hay que revisarlo a mano.
# ============================================================================
set -euo pipefail

# Ruta real aunque se llame por el enlace de /usr/local/bin.
SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
RAIZ="$(cd "$(dirname "$SCRIPT")/.." && pwd)"
ENLACE="/usr/local/bin/mailway"
ENV_FILE="${MAILWAY_ENV_FILE:-$RAIZ/deploy/.env}"
# Versión anterior, versión nueva y resultado de la última actualización: con
# él se vuelve atrás, se retoma una actualización interrumpida y no se insiste
# con una versión que ya ha fallado. Fuera de git (deploy/.gitignore).
ESTADO="$RAIZ/deploy/.actualizacion"
CERROJO="$RAIZ/deploy/.actualizacion.lock"
UNIDAD="mailway-auto-update"
# Carpeta de las unidades de systemd. La variable solo existe para las
# pruebas (deploy/prueba-actualizacion.sh).
SYSTEMD_DIR="${MAILWAY_SYSTEMD_DIR:-/etc/systemd/system}"
# Hora por defecto: hora y media antes de la actualización nocturna de Skyway
# (04:30) y de sus copias de seguridad (04:00). Aplicar, comprobar y, si
# falla, volver atrás (con Skyway, compilando el panel) cabe de sobra antes:
# nunca coinciden, ni siquiera cuando una de las dos vuelve atrás.
HORA_AUTO="03:00"
# Tras recrear los contenedores, el webmail tarda en volver a estar sano: la
# comprobación se repite cada SALUD_INTERVALO segundos durante SALUD_ESPERA.
SALUD_ESPERA=180
SALUD_INTERVALO=15
# Intentos automáticos de una misma versión que falla: el segundo cubre un
# fallo pasajero (una descarga cortada); después, solo con otra o a mano.
MAX_INTENTOS=2

MODO_AUTO=0
# Resultado de la última comprobación (ver comprobar_salud).
SALUD_DETALLE=""
SALUD_SALIDA=""
# 1 si el panel se comprueba: solo si estaba en marcha al empezar (con Skyway
# puede estar en otro servidor). Su contenedor se busca en cada comprobación:
# el instalador puede cambiarlo en deploy/.env.
VIGILAR_PANEL=0

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_AVISO=$'\033[33m'; C_ERROR=$'\033[31m'; C_NEGRITA=$'\033[1m'; C_FIN=$'\033[0m'
else
  C_OK=''; C_AVISO=''; C_ERROR=''; C_NEGRITA=''; C_FIN=''
fi
info() { printf '%s\n' "$*"; }
ok() { printf '%s✓%s %s\n' "$C_OK" "$C_FIN" "$*"; }
aviso() { printf '%s!%s %s\n' "$C_AVISO" "$C_FIN" "$*"; }
fallo() { printf '%s✗ %s%s\n' "$C_ERROR" "$*" "$C_FIN" >&2; exit 1; }

ayuda() {
  cat <<'AYUDA'
mailway: actualizar y revisar Mailway

Uso: mailway <orden> [opciones]

Órdenes:
  update [-y] [--reaplicar]  Trae lo nuevo de GitHub (git pull) y lo aplica con
                             instalar.sh --actualizar: motor, webmail y su tema,
                             variables del panel y, con Skyway, redespliegue.
                             -y          no pregunta antes de aplicar.
                             --reaplicar aplica aunque no haya nada nuevo.
  update --auto              Actualización desatendida (la del temporizador). Sin
                             nada nuevo no toca ningún contenedor. Si hay versión
                             nueva: comprueba que el servidor está sano, guarda la
                             versión anterior, aplica la nueva, la comprueba hasta
                             3 minutos y, si falla, vuelve a la anterior. Avisa en
                             el panel (Avisos y sus canales). Código 0: actualizado
                             o nada que hacer; 1: no aplicado o vuelto atrás;
                             2: la vuelta atrás también ha fallado.
  auto-update on [--hora HH:MM]
                             Ejecuta «update --auto» cada día con un temporizador de
                             systemd (por defecto a las 03:00, antes del de Skyway).
  auto-update off            Retira el temporizador.
  auto-update status         Si está activo, la próxima ejecución, el último
                             resultado y el registro (journalctl).
  comprobar                  Diagnóstico de solo lectura (instalar.sh --comprobar).
  probar-acceso              Inicia sesión con un buzón desde el webmail
                             (instalar.sh --probar-acceso).
  version                    Versión instalada y carpeta de Mailway.
  ayuda                      Muestra esta ayuda.

Los secretos que acepta el instalador (CLOUDFLARE_API_TOKEN, SKYWAY_TOKEN…)
se pasan igual que con instalar.sh, por el entorno y nunca en la orden. Lo
mismo MAILWAY_PANEL_SERVICIO, si el instalador lo pide:
  MAILWAY_PANEL_SERVICIO=svc_… mailway update -y --reaplicar
AYUDA
}

# git como root sobre una carpeta de otro usuario: sin esto, git se niega
# («dubious ownership») y la actualización fallaría sin explicar por qué.
git_mw() { git -c safe.directory="$RAIZ" -C "$RAIZ" "$@"; }

version_en() {
  # Versión del package.json raíz en una revisión de git (HEAD, origin/main…).
  git_mw show "$1:package.json" 2>/dev/null | sed -n 's/^  "version": "\(.*\)",$/\1/p' | head -n1
}

# Commit abreviado, para los mensajes y las claves de los avisos.
corto() { printf '%s' "${1:0:8}"; }

# Deja «mailway» en el PATH apuntando a este fichero (lo usa también el
# instalador). Sin permisos o sin /usr/local/bin, se sigue sin el atajo.
instalar_comando() {
  [ "$(id -u)" = 0 ] || return 0
  [ -d "$(dirname "$ENLACE")" ] || return 0
  # Por si la copia perdió el permiso de ejecución (descarga en zip, etc.).
  chmod +x "$SCRIPT" 2>/dev/null || true
  if [ "$(readlink -f "$ENLACE" 2>/dev/null || true)" != "$SCRIPT" ]; then
    if ln -sfn "$SCRIPT" "$ENLACE" 2>/dev/null; then
      ok "Orden «mailway» disponible ($ENLACE)."
    fi
  fi
  return 0
}

como_root() {
  if [ "$(id -u)" != 0 ]; then
    command -v sudo >/dev/null 2>&1 || fallo "Ejecuta «mailway» como root."
    # Los secretos del instalador viajan por el entorno: se conservan.
    exec sudo --preserve-env=CLOUDFLARE_API_TOKEN,SKYWAY_TOKEN,STALWART_ADMIN_PASSWORD,SKYWAY_URL,MAILWAY_PANEL_SERVICIO bash "$SCRIPT" "$@"
  fi
}

# ----------------------------------------------------------- configuración --

# Valor de CLAVE en un fichero «CLAVE=valor» sin ejecutarlo (quita las
# comillas envolventes), como leer_env del instalador.
#   leer_clave <fichero> <CLAVE>
leer_clave() {
  local linea valor
  [ -r "$1" ] || return 0
  linea=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n 1 || true)
  valor=${linea#*=}
  case "$valor" in
    \'*\') valor=${valor:1:${#valor}-2} ;;
    \"*\") valor=${valor:1:${#valor}-2} ;;
  esac
  printf '%s' "$valor"
}
leer_env() { leer_clave "$ENV_FILE" "$1"; }
leer_estado() { leer_clave "$ESTADO" "$1"; }

# Número entero o 0 (lo que se lee de un fichero puede venir roto).
numero() { case "$1" in '' | *[!0-9]*) printf '0' ;; *) printf '%s' "$1" ;; esac; }

# Guarda pares CLAVE=valor en deploy/.actualizacion (un valor vacío borra la
# clave) y conserva los demás. Se escribe aparte y se renombra: un corte a
# medias no deja el fichero vacío. Si no se puede escribir, se avisa y se
# sigue: el estado ayuda, pero no debe impedir actualizar.
guardar_estado() {
  local tmp par linea clave valor
  if ! tmp=$(mktemp "$ESTADO.XXXXXX" 2>/dev/null); then
    aviso "No se puede escribir $ESTADO: se sigue sin guardar el estado de la actualización."
    return 0
  fi
  if ! {
    printf '# Estado de las actualizaciones de Mailway (lo escribe deploy/mailway.sh).\n'
    if [ -f "$ESTADO" ]; then
      while IFS= read -r linea || [ -n "$linea" ]; do
        [[ $linea =~ ^[A-Z_]+= ]] || continue
        clave=${linea%%=*}
        for par in "$@"; do
          if [ "${par%%=*}" = "$clave" ]; then continue 2; fi
        done
        printf '%s\n' "$linea"
      done <"$ESTADO"
    fi
    for par in "$@"; do
      # Una línea de texto sencillo: el fichero nunca se ejecuta, pero se lee por líneas.
      valor=${par#*=}
      valor=${valor//[!A-Za-z0-9._:+ -]/}
      if [ -n "$valor" ]; then printf '%s=%s\n' "${par%%=*}" "$valor"; fi
    done
  } >"$tmp" || ! mv -f "$tmp" "$ESTADO"; then
    rm -f "$tmp"
    aviso "No se puede escribir $ESTADO: se sigue sin guardar el estado de la actualización."
  fi
  return 0
}

# Una sola actualización a la vez: la del temporizador y una a mano no deben
# cruzarse. El descriptor 9 queda abierto hasta el final (el instalador lo
# hereda con exec). Sin flock (util-linux), se sigue sin cerrojo.
tomar_cerrojo() {
  command -v flock >/dev/null 2>&1 || return 0
  { exec 9>>"$CERROJO"; } 2>/dev/null || return 0
  flock -n 9
}

# ------------------------------------------------------------- contenedores --

en_marcha() { [ "$(docker inspect --type container -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }

# Modo de la instalación, como lo decide el instalador: el de deploy/.env y,
# en los anteriores a la 1.0, autónoma si existe el contenedor mailway-panel.
modo_instalacion() {
  case "$(leer_env MAILWAY_INSTALACION)" in
    autonoma) printf 'autonoma' ;;
    skyway) printf 'skyway' ;;
    *)
      if docker inspect --type container mailway-panel >/dev/null 2>&1; then
        printf 'autonoma'
      else
        printf 'skyway'
      fi
      ;;
  esac
}

# Contenedor del panel, como lo localiza el instalador (--emparejar): el
# autónomo es mailway-panel; junto a Skyway, el de MAILWAY_PANEL_INTERNAL_URL
# (skyway-<proyecto>-<servicio>) o, si falta, skyway-mailway-panel.
contenedor_panel() {
  local interna re='^http://(skyway-[a-z0-9][a-z0-9_.-]*):[0-9]{1,5}$'
  if [ "$(modo_instalacion)" = autonoma ]; then
    printf 'mailway-panel'
    return 0
  fi
  interna=$(leer_env MAILWAY_PANEL_INTERNAL_URL)
  if [[ $interna =~ $re ]]; then printf '%s' "${BASH_REMATCH[1]}"; else printf 'skyway-mailway-panel'; fi
}

# /api/health del panel desde dentro de su contenedor, igual que su
# HEALTHCHECK (la imagen no trae curl). Solo lee: sin credenciales.
panel_responde() {
  timeout 30 docker exec "$1" node -e \
    "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/api/health',{signal:AbortSignal.timeout(10000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" \
    >/dev/null 2>&1
}

# Aviso a la administración en el panel (Avisos y sus canales: Discord,
# Telegram, webhook) con su herramienta de terminal (tools/avisar.js). Nunca
# cambia el resultado de la actualización: sin panel en marcha o con uno que
# aún no tiene la herramienta, se dice aquí y se sigue. Nada de lo que se
# envía es secreto.
#   notificar <info|aviso|critico> <clave> <título> <mensaje> [qué hacer]
notificar() {
  local panel salida argumentos=(--nivel "$1" --clave "$2" --titulo "$3" --mensaje "$4")
  if [ -n "${5:-}" ]; then argumentos+=(--remedio "$5"); fi
  panel=$(contenedor_panel)
  if ! en_marcha "$panel"; then
    info "No se avisa en el panel: su contenedor ($panel) no está en marcha."
    return 0
  fi
  if ! docker exec "$panel" test -f server/dist/tools/avisar.js >/dev/null 2>&1; then
    info "No se avisa en el panel: la versión desplegada aún no tiene la herramienta de avisos."
    return 0
  fi
  # Como el usuario del panel («node»): lo que toque en /data debe seguir siendo suyo.
  if salida=$(timeout 60 docker exec -u node "$panel" node server/dist/tools/avisar.js "${argumentos[@]}" </dev/null 2>&1); then
    info "Aviso en el panel: $salida"
  else
    info "No se ha podido avisar en el panel: ${salida:-sin respuesta}"
  fi
  return 0
}

# ------------------------------------------------------------- comprobación --

# Lo que instalar.sh exige para empezar (comprobaciones_previas): Docker y,
# junto a Skyway, su Traefik y la red skyway-edge. Si faltan, el instalador se
# pararía al principio: mejor no empezar.
servidor_listo() {
  if ! docker info >/dev/null 2>&1; then
    SALUD_DETALLE="Docker no responde."
    return 1
  fi
  if [ "$(modo_instalacion)" = skyway ]; then
    if ! en_marcha skyway-traefik; then
      SALUD_DETALLE="El Traefik de Skyway (skyway-traefik) no está en marcha."
      return 1
    fi
    if ! docker network inspect skyway-edge >/dev/null 2>&1; then
      SALUD_DETALLE="No existe la red skyway-edge de Skyway."
      return 1
    fi
  fi
  return 0
}

# Una pasada de la comprobación. Es el diagnóstico de solo lectura del
# instalador (instalar.sh --comprobar, código 1 si algo falla: contenedores
# sanos, ajustes y certificado del motor, IMAP y SMTP con TLS desde el
# webmail por la red interna, que está exenta del bloqueo automático del
# motor) más /api/health del panel si estaba en marcha. No inicia sesión en
# ningún buzón ni prueba los puertos desde fuera: esas conexiones llegarían
# desde una IP sin exención y contarían para el bloqueo automático. Deja en
# SALUD_DETALLE las líneas de lo que falla y en SALUD_SALIDA el diagnóstico.
comprobar_salud() {
  local salida codigo=0 panel
  SALUD_DETALLE=""
  SALUD_SALIDA=""
  salida=$(bash "$RAIZ/deploy/instalar.sh" --comprobar </dev/null 2>&1) || codigo=$?
  if [ "$codigo" != 0 ]; then
    SALUD_SALIDA=$salida
    # Primeras incidencias: sed lee toda la entrada (con «head» la tubería
    # podría cortarse antes y, con pipefail, contar como fallo).
    SALUD_DETALLE=$(printf '%s\n' "$salida" | sed -n -E 's/^[[:space:]]*\[(aviso|error)\][[:space:]]*//p' | sed -n '1,4p')
    SALUD_DETALLE=${SALUD_DETALLE:-"instalar.sh --comprobar ha terminado con código $codigo."}
  fi
  if [ "$VIGILAR_PANEL" = 1 ]; then
    panel=$(contenedor_panel)
    if ! panel_responde "$panel"; then
      SALUD_DETALLE+="${SALUD_DETALLE:+$'\n'}El panel ($panel) no responde en /api/health."
      SALUD_SALIDA+="${SALUD_SALIDA:+$'\n'}El panel ($panel) no responde en /api/health. Revisa: docker logs $panel"
    fi
  fi
  [ -z "$SALUD_DETALLE" ]
}

# Repite la comprobación hasta que pasa o se agota la espera (segundos). Una
# contraseña del motor rechazada no se arregla esperando y cada intento
# cuenta para su bloqueo automático: entonces no se repite (como hace
# instalar.sh --comprobar).
esperar_salud() {
  local intentos=$(($1 / SALUD_INTERVALO + 1)) i=1
  while ! comprobar_salud; do
    if [ "$i" -ge "$intentos" ] || [[ $SALUD_DETALLE == *"rechaza la contraseña"* ]]; then
      aviso "El servidor no supera la comprobación. Detalle de la última:"
      printf '%s\n' "$SALUD_SALIDA" | sed 's/^/    /'
      return 1
    fi
    info "La comprobación aún no pasa (${SALUD_DETALLE%%$'\n'*}); se repite en ${SALUD_INTERVALO} s (intento $i de $intentos)."
    sleep "$SALUD_INTERVALO"
    i=$((i + 1))
  done
  ok "El servidor supera la comprobación."
}

# El resumen del instalador muestra a quien instala a mano el token de puesta
# en marcha (mientras el panel no tiene administrador) y la contraseña de la
# cuenta que crea el emparejado: en una ejecución desatendida acabarían en el
# registro del sistema (journal), así que se tapan.
tapar_secretos() {
  sed -E 's/(setup\?token=)[^[:space:]]+/\1•••/g; s/(Token de puesta en marcha: *)[^[:space:]]+/\1•••/; s/(Contraseña: *)[^[:space:]].*$/\1•••/'
}

# instalar.sh --actualizar como proceso aparte (después hay que comprobar y
# quizá volver atrás) y sin terminal. Con pipefail, el código es el suyo.
aplicar_version() {
  bash "$RAIZ/deploy/instalar.sh" --actualizar </dev/null 2>&1 | tapar_secretos
}

# Vuelve a la versión anterior: el código con git (la actualización solo
# avanza y al empezar no había cambios a mano), la configuración y los
# contenedores con instalar.sh --actualizar (las imágenes exactas de antes
# siguen en Docker) y la comprobación. Nunca toca los volúmenes ni restaura
# bases de datos: deploy/.env tampoco, porque el instalador conserva las
# variables que no conoce.
volver_atras() {
  local anterior=$1 codigo=0
  if ! git_mw reset --hard --quiet "$anterior"; then
    SALUD_DETALLE="git no ha podido volver a $(corto "$anterior")."
    return 1
  fi
  ok "Código de vuelta en la versión anterior ($(corto "$anterior"))."
  info "Aplicando la versión anterior con instalar.sh --actualizar…"
  aplicar_version || codigo=$?
  if [ "$codigo" != 0 ]; then
    SALUD_DETALLE="instalar.sh --actualizar ha terminado con código $codigo al aplicar la versión anterior."
    return 1
  fi
  info "Comprobando el servidor con la versión anterior (hasta $((SALUD_ESPERA / 60)) minutos)…"
  esperar_salud "$SALUD_ESPERA"
}

# ------------------------------------------------------------- actualizar --

# Detiene la actualización sin haber cambiado nada. En la automática, además,
# lo avisa en el panel: si no, nadie sabría que las actualizaciones han
# dejado de aplicarse.
#   parar <motivo, para la clave del aviso> <mensaje> [texto del aviso, si es otro]
parar() {
  if [ "$MODO_AUTO" = 1 ]; then
    printf '%s✗ %s%s\n' "$C_ERROR" "$2" "$C_FIN" >&2
    notificar aviso "actualizacion:detenida:$1" "Actualización automática detenida" "${3:-$2}" \
      "Cuando esté resuelto, la próxima ejecución seguirá sola (o ejecuta «sudo mailway update»)."
    exit 1
  fi
  fallo "$2"
}

actualizar() {
  local si=0 reaplicar=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -y|--yes|--si) si=1 ;;
      --reaplicar) reaplicar=1 ;;
      --auto) MODO_AUTO=1 ;;
      *) fallo "Opción desconocida para update: $1 (mira «mailway ayuda»)." ;;
    esac
    shift
  done
  if [ "$MODO_AUTO" = 1 ] && [ "$reaplicar" = 1 ]; then
    fallo "--auto no se combina con --reaplicar: la actualización automática solo aplica versiones nuevas."
  fi
  if [ "$MODO_AUTO" = 1 ]; then info "Actualización automática de Mailway ($(date '+%Y-%m-%d %H:%M %Z'))."; fi

  command -v git >/dev/null 2>&1 || parar sin-git "Falta git en este servidor."
  git_mw rev-parse --git-dir >/dev/null 2>&1 || parar sin-git "$RAIZ no es una copia de git de Mailway."

  if ! tomar_cerrojo; then
    if [ "$MODO_AUTO" = 1 ]; then
      info "Ya hay otra actualización de Mailway en curso: esta no hace nada."
      exit 0
    fi
    fallo "Ya hay otra actualización de Mailway en curso (¿la automática?). Espera a que termine y vuelve a intentarlo."
  fi

  local rama upstream
  rama=$(git_mw rev-parse --abbrev-ref HEAD)
  [ "$rama" != "HEAD" ] || parar sin-rama "La copia de $RAIZ no está en ninguna rama. Cambia a la rama que despliegas (p. ej. «git -C $RAIZ checkout main»)."
  upstream=$(git_mw rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "origin/$rama")

  # Cambios hechos a mano en ficheros del repositorio: un «pull» los mezclaría
  # o fallaría a medias, y volver atrás los borraría. Se para y se dice cuáles
  # son (deploy/.env no cuenta: no está en git).
  local locales
  locales=$(git_mw status --porcelain --untracked-files=no)
  if [ -n "$locales" ]; then
    aviso "Hay cambios hechos a mano en la copia de Mailway:"
    printf '%s\n' "$locales" | sed 's/^/    /'
    parar cambios-locales "Guárdalos o descártalos antes de actualizar (por ejemplo «git -C $RAIZ stash»)." \
      "Hay cambios hechos a mano en ficheros de la copia de Mailway ($RAIZ): no se actualiza para no perderlos. Guárdalos o descártalos (por ejemplo «git -C $RAIZ stash»)."
  fi

  info "Buscando novedades de Mailway ($upstream)…"
  local entorno_git=()
  if [ "$MODO_AUTO" = 1 ]; then
    # Sin terminal: que git no espere una contraseña y que una conexión
    # atascada no deje el temporizador colgado.
    entorno_git=(GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=60)
  fi
  env ${entorno_git[@]+"${entorno_git[@]}"} git -c safe.directory="$RAIZ" -C "$RAIZ" \
    fetch --quiet "${upstream%%/*}" "${upstream#*/}" ||
    parar sin-conexion "No se ha podido contactar con GitHub. Comprueba la conexión y vuelve a intentarlo."

  local nuevos actual siguiente
  nuevos=$(git_mw rev-list --count "HEAD..$upstream")
  actual=$(version_en HEAD)
  siguiente=$(version_en "$upstream")

  # Una actualización automática que no terminó (apagado, tiempo agotado) se
  # retoma aunque no haya nada nuevo: el código puede estar ya en la versión
  # nueva sin haberse aplicado ni comprobado.
  local reanudar=0 anterior_guardado=""
  if [ "$MODO_AUTO" = 1 ] && [ "$(leer_estado RESULTADO)" = en-curso ]; then
    anterior_guardado=$(leer_estado ANTERIOR)
    if [[ $anterior_guardado =~ ^[0-9a-f]{40}$ ]] && git_mw merge-base --is-ancestor "$anterior_guardado" HEAD 2>/dev/null; then
      reanudar=1
    fi
  fi

  local cambios="$nuevos cambios" cambios_nuevos="$nuevos cambios nuevos"
  if [ "$nuevos" = 1 ]; then cambios="1 cambio"; cambios_nuevos="1 cambio nuevo"; fi
  if [ "$nuevos" = 0 ]; then
    ok "Mailway ya está al día (versión ${actual:-desconocida})."
    if [ "$reanudar" = 1 ]; then
      aviso "La actualización automática anterior no llegó a terminar: se aplica de nuevo y se comprueba."
    elif [ "$reaplicar" = 0 ]; then
      if [ "$MODO_AUTO" = 0 ]; then info "Para volver a aplicar la configuración igualmente: mailway update --reaplicar"; fi
      return 0
    fi
  else
    if [ "${actual:-}" != "${siguiente:-}" ] && [ -n "${siguiente:-}" ]; then
      info "${C_NEGRITA}Mailway $actual → $siguiente${C_FIN} ($cambios):"
    else
      info "${C_NEGRITA}${cambios_nuevos}${C_FIN} (versión ${actual:-desconocida}):"
    fi
    git_mw log --oneline --no-merges --max-count=15 --format='  · %s' "HEAD..$upstream"
    [ "$(git_mw rev-list --count --no-merges "HEAD..$upstream")" -le 15 ] || info "  · …"
  fi

  if [ "$MODO_AUTO" = 1 ]; then
    actualizar_auto "$upstream" "$reanudar" "$anterior_guardado"
  fi

  if [ "$si" = 0 ]; then
    [ -t 0 ] || fallo "Sin terminal no se puede preguntar: usa «mailway update -y»."
    local respuesta
    read -r -p "¿Aplicar ahora? Se recrean el motor y el webmail (unos segundos sin correo web). [s/N] " respuesta
    case "$respuesta" in s|S|si|SI|sí|Sí|y|Y) ;; *) info "No se ha cambiado nada."; return 0 ;; esac
  fi

  local anterior
  anterior=$(git_mw rev-parse HEAD)
  if [ "$nuevos" != 0 ]; then
    git_mw merge --ff-only --quiet "$upstream" \
      || fallo "La copia de $RAIZ se ha separado de GitHub y no se puede avanzar sin mezclar. Revísala con «git -C $RAIZ status»."
    ok "Código actualizado a la versión $(version_en HEAD)."
    info "Versión anterior: ${actual:-desconocida} ($(corto "$anterior")). Para volver a ella a mano:"
    info "  sudo git -C $RAIZ reset --hard $anterior && sudo bash $RAIZ/deploy/instalar.sh --actualizar"
  fi
  # Quien actualiza a mano decide: lo que dejó la automática (una versión que
  # falló y no se reintentaba) deja de valer.
  guardar_estado FECHA="$(date -Iseconds)" RESULTADO=manual ANTERIOR="$anterior" OBJETIVO="$(git_mw rev-parse HEAD)" \
    VERSION_ANTERIOR="$actual" VERSION_OBJETIVO="$(version_en HEAD)" FALLIDA= INTENTOS=

  info "Aplicando con instalar.sh --actualizar…"
  # exec: el instalador sustituye a este proceso. Este mismo fichero acaba de
  # cambiar con el «pull», y bash lo lee a trozos: no debe seguir leyéndolo.
  exec bash "$RAIZ/deploy/instalar.sh" --actualizar
}

# Segunda mitad de «update --auto», con la versión nueva ya traída: no
# insistir con una que ya ha fallado, comprobación previa, versión anterior
# guardada, aplicación, comprobación posterior y, si falla, vuelta atrás.
# Termina siempre con exit (0, 1 o 2). Este fichero puede cambiar con el
# «pull», pero las funciones ya están leídas (ver la última línea).
#   actualizar_auto <upstream> <reanudar 0|1> <anterior guardado>
actualizar_auto() {
  local upstream=$1 reanudar=$2 objetivo anterior version_anterior version_objetivo
  local intentos codigo=0 motivo detalle sha_nueva sha_anterior aplicados resto
  objetivo=$(git_mw rev-parse "$upstream^{commit}")
  anterior=$(git_mw rev-parse HEAD)
  if [ "$reanudar" = 1 ]; then anterior=$3; fi
  # Solo se avanza: con commits propios en esta copia, no se mezcla nada.
  git_mw merge-base --is-ancestor HEAD "$objetivo" ||
    parar separada "La copia de $RAIZ se ha separado de GitHub y no se puede avanzar sin mezclar. Revísala con «git -C $RAIZ status»."
  version_anterior=$(version_en "$anterior")
  version_objetivo=$(version_en "$objetivo")
  sha_nueva=$(corto "$objetivo")
  sha_anterior=$(corto "$anterior")
  intentos=$(numero "$(leer_estado INTENTOS)")
  if [ "$(leer_estado FALLIDA)" != "$objetivo" ]; then intentos=0; fi

  # Se exige lo que funcionaba al empezar: el panel, solo si estaba en marcha.
  if en_marcha "$(contenedor_panel)"; then VIGILAR_PANEL=1; fi

  if [ "$reanudar" = 0 ] && [ "$intentos" -ge "$MAX_INTENTOS" ]; then
    info "La versión ${version_objetivo:-nueva} ($sha_nueva) ya ha fallado $intentos veces y el servidor volvió a la anterior: no se reintenta sola."
    info "Se intentará con la próxima versión que llegue; para aplicarla ya, a mano: sudo mailway update -y"
    exit 0
  fi
  # Antes de tocar nada, el servidor debe estar sano: con un fallo que ya
  # estaba, la comprobación de después no diría nada de la versión nueva. Al
  # retomar una actualización interrumpida no se exige (puede haberla dejado
  # a medias), pero sí lo que el instalador necesita para empezar: si falta,
  # se queda como estaba y la próxima ejecución lo vuelve a intentar.
  info "Comprobación previa (antes de tocar nada)…"
  if ! servidor_listo || { [ "$reanudar" = 0 ] && ! esperar_salud 30; }; then
    aviso "El servidor no supera la comprobación previa: no se aplica la versión nueva."
    notificar aviso "actualizacion:previa:$sha_nueva" "Actualización automática pendiente" \
      "Hay una versión nueva de Mailway (${version_objetivo:-?}, $sha_nueva), pero el servidor no supera la comprobación previa, así que no se ha tocado nada.
Detalle: $SALUD_DETALLE" \
      "Corrige lo que indique «sudo mailway comprobar»; la próxima ejecución lo intentará de nuevo."
    exit 1
  fi

  guardar_estado FECHA="$(date -Iseconds)" RESULTADO=en-curso ANTERIOR="$anterior" OBJETIVO="$objetivo" \
    VERSION_ANTERIOR="$version_anterior" VERSION_OBJETIVO="$version_objetivo"
  info "Versión anterior guardada en $ESTADO: ${version_anterior:-?} ($sha_anterior)."
  if [ "$(git_mw rev-parse HEAD)" != "$objetivo" ]; then
    if ! git_mw merge --ff-only --quiet "$objetivo"; then
      guardar_estado RESULTADO=no-aplicada
      parar separada "git no ha podido avanzar la copia de $RAIZ a la versión nueva. Revísala con «git -C $RAIZ status»."
    fi
  fi
  ok "Código en la versión ${version_objetivo:-nueva} ($sha_nueva)."

  info "Aplicando con instalar.sh --actualizar…"
  aplicar_version || codigo=$?
  if [ "$codigo" = 0 ]; then
    info "Comprobando el servidor (hasta $((SALUD_ESPERA / 60)) minutos)…"
    if esperar_salud "$SALUD_ESPERA"; then
      guardar_estado RESULTADO=actualizada FALLIDA= INTENTOS=
      aplicados=$(git_mw rev-list --count "$anterior..$objetivo" 2>/dev/null || true)
      if [ "$aplicados" = 1 ]; then aplicados="1 cambio"; else aplicados="${aplicados:-varios} cambios"; fi
      ok "Mailway actualizado (${version_anterior:-?} → ${version_objetivo:-?}) y comprobado."
      local titulo="Mailway actualizado"
      if [ -n "$version_objetivo" ] && [ "$version_objetivo" != "$version_anterior" ]; then
        titulo="Mailway actualizado a la versión $version_objetivo"
      fi
      notificar info "actualizacion:aplicada" "$titulo" \
        "La actualización automática ha aplicado $aplicados de GitHub ($sha_anterior → $sha_nueva) y el servidor supera la comprobación."
      exit 0
    fi
    motivo="no ha superado la comprobación tras aplicarse"
    detalle=$SALUD_DETALLE
  else
    motivo="no se ha podido aplicar (instalar.sh --actualizar terminó con código $codigo)"
    detalle="Revisa la salida del instalador en el registro (sudo mailway auto-update status)."
  fi

  # Vuelta atrás. Cuenta como un intento más de esta versión.
  intentos=$((intentos + 1))
  aviso "La versión ${version_objetivo:-nueva} ($sha_nueva) $motivo: se vuelve a la anterior (${version_anterior:-?}, $sha_anterior)."
  if volver_atras "$anterior"; then
    guardar_estado RESULTADO=revertida FALLIDA="$objetivo" INTENTOS="$intentos"
    ok "El servidor ha vuelto a la versión ${version_anterior:-anterior} ($sha_anterior) y la supera."
    if [ "$intentos" -lt "$MAX_INTENTOS" ]; then
      resto="Se volverá a intentar en la próxima ejecución, por si el fallo fue pasajero."
    else
      resto="No se volverá a intentar sola: se intentará con la próxima versión, o aplícala a mano con «sudo mailway update -y» cuando lo hayas revisado."
    fi
    notificar aviso "actualizacion:revertida:$sha_nueva" "Actualización automática revertida" \
      "La versión ${version_objetivo:-nueva} de Mailway ($sha_nueva) $motivo, así que el servidor ha vuelto solo a la ${version_anterior:-anterior} ($sha_anterior), que sí supera la comprobación.
Detalle: $detalle" \
      "$resto El registro completo está en «sudo mailway auto-update status»."
    exit 1
  fi
  guardar_estado RESULTADO=sin-revertir FALLIDA="$objetivo" INTENTOS="$intentos"
  aviso "La vuelta a la versión anterior tampoco ha funcionado. Hay que revisarlo a mano: sudo mailway comprobar"
  notificar critico "actualizacion:sin-revertir:$sha_nueva" "Actualización automática fallida: el servidor necesita revisión" \
    "La versión ${version_objetivo:-nueva} de Mailway ($sha_nueva) $motivo, y la vuelta a la ${version_anterior:-anterior} ($sha_anterior) tampoco ha funcionado.
Detalle: $SALUD_DETALLE" \
    "Entra en el servidor y ejecuta «sudo mailway comprobar»; el registro está en «sudo mailway auto-update status». No se ha tocado ningún volumen ni dato del correo."
  exit 2
}

# ----------------------------------------------------- auto-update (systemd) --

escribir_unidades() {
  local hora=$1
  cat >"$SYSTEMD_DIR/$UNIDAD.service" <<UNIDAD_SERVICIO
# Lo crea «mailway auto-update on» (deploy/mailway.sh). Para quitarlo:
#   sudo mailway auto-update off
[Unit]
Description=Actualización automática de Mailway (con comprobación y vuelta atrás)
Documentation=https://github.com/NkrowOne/Mailway/blob/main/docs/DESPLIEGUE-SKYWAY.md
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
# Docker y git leen su configuración de HOME, que systemd no fija.
Environment=HOME=/root
ExecStart=$ENLACE update --auto
# Con Skyway, aplicar incluye compilar el panel (y volver atrás, otra vez):
# margen de sobra, pero sin dejar el temporizador bloqueado si algo se cuelga.
TimeoutStartSec=3h
UNIDAD_SERVICIO
  cat >"$SYSTEMD_DIR/$UNIDAD.timer" <<UNIDAD_TEMPORIZADOR
# Lo crea «mailway auto-update on» (deploy/mailway.sh). Para quitarlo:
#   sudo mailway auto-update off
[Unit]
Description=Actualización automática diaria de Mailway

[Timer]
# Por defecto a las $HORA_AUTO, con margen antes de la actualización nocturna
# de Skyway (04:30): nunca a la vez. Si el servidor estaba apagado, al arrancar.
OnCalendar=*-*-* $hora:00
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
UNIDAD_TEMPORIZADOR
}

proxima_ejecucion() {
  local proxima
  proxima=$(systemctl show "$UNIDAD.timer" -p NextElapseUSecRealtime --value 2>/dev/null || true)
  printf '%s' "${proxima:-sin programar}"
}

activar_auto() {
  local hora=$HORA_AUTO
  while [ $# -gt 0 ]; do
    case "$1" in
      --hora)
        [ $# -ge 2 ] || fallo "Falta la hora: mailway auto-update on --hora HH:MM"
        hora=$2
        shift
        ;;
      --hora=*) hora=${1#--hora=} ;;
      *) fallo "Opción desconocida para auto-update on: $1 (mira «mailway ayuda»)." ;;
    esac
    shift
  done
  [[ $hora =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || fallo "Hora no válida: «$hora». Usa HH:MM en 24 horas (p. ej. $HORA_AUTO)."
  command -v systemctl >/dev/null 2>&1 ||
    fallo "Este servidor no usa systemd. Programa «$ENLACE update --auto» con cron (p. ej. en /etc/cron.d/mailway: 0 3 * * * root $ENLACE update --auto)."
  if ! command -v git >/dev/null 2>&1 || ! git_mw rev-parse --git-dir >/dev/null 2>&1; then
    fallo "$RAIZ no es una copia de git de Mailway: la actualización automática trae las versiones nuevas con git."
  fi
  # El temporizador llama a la orden del PATH, no a esta ruta.
  instalar_comando
  [ "$(readlink -f "$ENLACE" 2>/dev/null || true)" = "$SCRIPT" ] ||
    fallo "No se ha podido dejar la orden en $ENLACE (apunta a otro sitio o falta la carpeta)."
  mkdir -p "$SYSTEMD_DIR"
  escribir_unidades "$hora"
  systemctl daemon-reload || fallo "systemd no ha cargado las unidades nuevas (systemctl daemon-reload)."
  systemctl enable --now "$UNIDAD.timer" || fallo "No se ha podido activar el temporizador $UNIDAD.timer."
  # Si ya estaba en marcha con otra hora, la toma ahora.
  systemctl restart "$UNIDAD.timer" || true
  ok "Actualización automática activada: cada día a las $hora (con hasta 5 minutos de margen)."
  info "Próxima ejecución: $(proxima_ejecucion)"
  info "Sin versión nueva no toca nada; con ella, la aplica, la comprueba y vuelve atrás si falla."
  info "Último resultado y registro: sudo mailway auto-update status"
}

desactivar_auto() {
  local habia=0
  if [ -f "$SYSTEMD_DIR/$UNIDAD.timer" ] || [ -f "$SYSTEMD_DIR/$UNIDAD.service" ]; then habia=1; fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now "$UNIDAD.timer" >/dev/null 2>&1 || true
  fi
  rm -f "$SYSTEMD_DIR/$UNIDAD.timer" "$SYSTEMD_DIR/$UNIDAD.service"
  if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload || true; fi
  if [ "$habia" = 1 ]; then
    ok "Actualización automática desactivada: temporizador retirado."
  else
    info "La actualización automática no estaba activada."
  fi
  info "Una actualización que estuviera en curso termina sola. A mano: sudo mailway update"
}

texto_resultado() {
  case "$1" in
    actualizada) printf 'aplicada y comprobada' ;;
    revertida) printf 'falló y el servidor volvió a la versión anterior' ;;
    sin-revertir) printf 'falló y la vuelta atrás también: hay que revisarlo a mano' ;;
    en-curso) printf 'en curso o interrumpida (la próxima ejecución la retoma)' ;;
    manual) printf 'aplicada a mano (mailway update)' ;;
    no-aplicada) printf 'no se pudo aplicar (sin cambios)' ;;
    *) printf '%s' "$1" ;;
  esac
}

estado_auto() {
  local temporizador="$SYSTEMD_DIR/$UNIDAD.timer" hora habilitado activo resultado fallida
  if [ -f "$temporizador" ]; then
    hora=$(sed -n -E 's/^OnCalendar=\*-\*-\* ([0-9]{2}:[0-9]{2}):00$/\1/p' "$temporizador")
    habilitado=$(systemctl is-enabled "$UNIDAD.timer" 2>/dev/null || true)
    activo=$(systemctl is-active "$UNIDAD.timer" 2>/dev/null || true)
    ok "Actualización automática activada: cada día a las ${hora:-?} (temporizador ${habilitado:-desconocido}, ${activo:-desconocido})."
    info "Próxima ejecución: $(proxima_ejecucion)"
  else
    info "Actualización automática desactivada. Para activarla: sudo mailway auto-update on"
  fi
  resultado=$(leer_estado RESULTADO)
  if [ -n "$resultado" ]; then
    info "Última actualización: $(leer_estado FECHA) · $(texto_resultado "$resultado") · ${C_NEGRITA}$(leer_estado VERSION_ANTERIOR) → $(leer_estado VERSION_OBJETIVO)${C_FIN} ($(corto "$(leer_estado ANTERIOR)") → $(corto "$(leer_estado OBJETIVO)"))."
  fi
  fallida=$(leer_estado FALLIDA)
  if [ -n "$fallida" ]; then
    info "Versión que falló: $(corto "$fallida") ($(numero "$(leer_estado INTENTOS)") de $MAX_INTENTOS intentos automáticos). Con otra versión se vuelve a intentar; a mano: sudo mailway update -y"
  fi
  info "Registro de las últimas ejecuciones (journalctl -u $UNIDAD):"
  journalctl -u "$UNIDAD" -n 30 --no-pager 2>/dev/null || info "  (sin registro disponible)"
}

auto_actualizacion() {
  local accion=${1:-status}
  [ $# -eq 0 ] || shift
  # Escribe en /etc/systemd/system y lee el registro del sistema.
  [ "$(id -u)" = 0 ] || fallo "Hace falta ser root: sudo mailway auto-update $accion"
  case "$accion" in
    on|activar) activar_auto "$@" ;;
    off|desactivar) desactivar_auto ;;
    status|estado) estado_auto ;;
    *) fallo "Uso: mailway auto-update on [--hora HH:MM] | off | status" ;;
  esac
}

main() {
  local orden="${1:-ayuda}"
  [ $# -eq 0 ] || shift
  case "$orden" in
    update|actualizar)
      como_root update "$@"
      instalar_comando
      actualizar "$@"
      ;;
    auto-update|actualizacion-automatica)
      auto_actualizacion "$@"
      ;;
    comprobar|check|status)
      como_root comprobar "$@"
      exec bash "$RAIZ/deploy/instalar.sh" --comprobar
      ;;
    probar-acceso)
      como_root probar-acceso "$@"
      exec bash "$RAIZ/deploy/instalar.sh" --probar-acceso
      ;;
    instalar-comando)
      como_root instalar-comando
      instalar_comando
      ;;
    version|--version|-v)
      info "Mailway $(version_en HEAD) en $RAIZ"
      ;;
    ayuda|help|--help|-h)
      ayuda
      ;;
    *)
      ayuda >&2
      fallo "Orden desconocida: $orden"
      ;;
  esac
}

# Todo dentro de main y en una sola línea con la salida: si «update» cambia
# este fichero mientras se ejecuta, bash ya no necesita leer nada más de él.
main "$@"; exit $?
