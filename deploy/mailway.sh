#!/usr/bin/env bash
# ============================================================================
# mailway: actualizar y revisar Mailway desde la terminal del servidor
# ----------------------------------------------------------------------------
# El instalador lo deja en /usr/local/bin/mailway (enlace a este fichero), así
# que se usa desde cualquier carpeta:
#
#   mailway update            # trae lo nuevo de GitHub y lo aplica (pregunta antes)
#   mailway update -y         # igual, sin preguntar
#   mailway update --reaplicar  # vuelve a aplicar aunque no haya nada nuevo
#   mailway comprobar         # diagnóstico de solo lectura (instalar.sh --comprobar)
#   mailway probar-acceso     # abre un buzón desde el webmail (instalar.sh --probar-acceso)
#   mailway version
#
# «update» = «git pull» + «instalar.sh --actualizar»: el panel junto a Skyway
# se actualiza solo, pero el motor, el webmail y su tema viven en esta
# carpeta y solo cambian al reaplicar.
# ============================================================================
set -euo pipefail

# Ruta real aunque se llame por el enlace de /usr/local/bin.
SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
RAIZ="$(cd "$(dirname "$SCRIPT")/.." && pwd)"
ENLACE="/usr/local/bin/mailway"

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
  comprobar                  Diagnóstico de solo lectura (instalar.sh --comprobar).
  probar-acceso              Inicia sesión con un buzón desde el webmail
                             (instalar.sh --probar-acceso).
  version                    Versión instalada y carpeta de Mailway.
  ayuda                      Muestra esta ayuda.

Los secretos que acepta el instalador (CLOUDFLARE_API_TOKEN, SKYWAY_TOKEN…)
se pasan igual que con instalar.sh, por el entorno y nunca en la orden.
AYUDA
}

# git como root sobre una carpeta de otro usuario: sin esto, git se niega
# («dubious ownership») y la actualización fallaría sin explicar por qué.
git_mw() { git -c safe.directory="$RAIZ" -C "$RAIZ" "$@"; }

version_en() {
  # Versión del package.json raíz en una revisión de git (HEAD, origin/main…).
  git_mw show "$1:package.json" 2>/dev/null | sed -n 's/^  "version": "\(.*\)",$/\1/p' | head -n1
}

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
    exec sudo --preserve-env=CLOUDFLARE_API_TOKEN,SKYWAY_TOKEN,STALWART_ADMIN_PASSWORD,SKYWAY_URL bash "$SCRIPT" "$@"
  fi
}

actualizar() {
  local si=0 reaplicar=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -y|--yes|--si) si=1 ;;
      --reaplicar) reaplicar=1 ;;
      *) fallo "Opción desconocida para update: $1 (mira «mailway ayuda»)." ;;
    esac
    shift
  done

  command -v git >/dev/null 2>&1 || fallo "Falta git en este servidor."
  git_mw rev-parse --git-dir >/dev/null 2>&1 || fallo "$RAIZ no es una copia de git de Mailway."

  local rama upstream
  rama=$(git_mw rev-parse --abbrev-ref HEAD)
  [ "$rama" != "HEAD" ] || fallo "La copia de $RAIZ no está en ninguna rama. Cambia a la rama que despliegas (p. ej. «git -C $RAIZ checkout main»)."
  upstream=$(git_mw rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "origin/$rama")

  # Cambios hechos a mano en ficheros del repositorio: un «pull» los mezclaría
  # o fallaría a medias. Se para y se dice cuáles son (deploy/.env no cuenta:
  # no está en git).
  local locales
  locales=$(git_mw status --porcelain --untracked-files=no)
  if [ -n "$locales" ]; then
    aviso "Hay cambios hechos a mano en la copia de Mailway:"
    printf '%s\n' "$locales" | sed 's/^/    /'
    fallo "Guárdalos o descártalos antes de actualizar (por ejemplo «git -C $RAIZ stash»)."
  fi

  info "Buscando novedades de Mailway ($upstream)…"
  git_mw fetch --quiet "${upstream%%/*}" "${upstream#*/}" || fallo "No se ha podido contactar con GitHub. Comprueba la conexión y vuelve a intentarlo."

  local nuevos actual siguiente
  nuevos=$(git_mw rev-list --count "HEAD..$upstream")
  actual=$(version_en HEAD)
  siguiente=$(version_en "$upstream")

  local cambios="$nuevos cambios" cambios_nuevos="$nuevos cambios nuevos"
  if [ "$nuevos" = 1 ]; then cambios="1 cambio"; cambios_nuevos="1 cambio nuevo"; fi
  if [ "$nuevos" = 0 ]; then
    ok "Mailway ya está al día (versión ${actual:-desconocida})."
    if [ "$reaplicar" = 0 ]; then
      info "Para volver a aplicar la configuración igualmente: mailway update --reaplicar"
      return 0
    fi
  else
    if [ "${actual:-}" != "${siguiente:-}" ] && [ -n "${siguiente:-}" ]; then
      info "${C_NEGRITA}Mailway $actual → $siguiente${C_FIN} ($cambios):"
    else
      info "${C_NEGRITA}${cambios_nuevos}${C_FIN} (versión ${actual:-desconocida}):"
    fi
    git_mw log --oneline --no-merges --format='  · %s' "HEAD..$upstream" | head -n 15
    [ "$(git_mw rev-list --count --no-merges "HEAD..$upstream")" -le 15 ] || info "  · …"
  fi

  if [ "$si" = 0 ]; then
    [ -t 0 ] || fallo "Sin terminal no se puede preguntar: usa «mailway update -y»."
    local respuesta
    read -r -p "¿Aplicar ahora? Se recrean el motor y el webmail (unos segundos sin correo web). [s/N] " respuesta
    case "$respuesta" in s|S|si|SI|sí|Sí|y|Y) ;; *) info "No se ha cambiado nada."; return 0 ;; esac
  fi

  if [ "$nuevos" != 0 ]; then
    git_mw merge --ff-only --quiet "$upstream" \
      || fallo "La copia de $RAIZ se ha separado de GitHub y no se puede avanzar sin mezclar. Revísala con «git -C $RAIZ status»."
    ok "Código actualizado a la versión $(version_en HEAD)."
  fi

  info "Aplicando con instalar.sh --actualizar…"
  # exec: el instalador sustituye a este proceso. Este mismo fichero acaba de
  # cambiar con el «pull», y bash lo lee a trozos: no debe seguir leyéndolo.
  exec bash "$RAIZ/deploy/instalar.sh" --actualizar
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
