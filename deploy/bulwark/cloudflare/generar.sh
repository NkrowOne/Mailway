#!/usr/bin/env bash
#
# Genera las entradas del bloque geo de las dos pasarelas a partir de
# cloudflare/rangos.txt, la única fuente de los rangos de Cloudflare:
#   - deploy/bulwark/nginx/cloudflare.conf (pasarela de Bulwark);
#   - deploy/motor/pasarela/cloudflare.conf (pasarela del motor).
# Las dos copias son idénticas: cada pasarela monta solo su carpeta.
#
#   bash deploy/bulwark/cloudflare/generar.sh              # reescribe los ficheros
#   bash deploy/bulwark/cloudflare/generar.sh --comprobar  # código 1 si alguno no está al día
#
# Un rango mal escrito detiene el script: en nginx, una línea inválida dentro
# de geo impide arrancar la pasarela, y una que sí arrancara pero fuera
# demasiado amplia haría creer CF-Connecting-IP a quien no pasa por Cloudflare.

set -euo pipefail

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ORIGEN="$AQUI/rangos.txt"
DESTINOS=("$AQUI/../nginx/cloudflare.conf" "$AQUI/../../motor/pasarela/cloudflare.conf")

valido() {
  local rango=$1 ip prefijo
  ip=${rango%/*}
  prefijo=${rango#*/}
  [ "$ip" != "$rango" ] || return 1
  [[ $prefijo =~ ^[0-9]{1,3}$ ]] || return 1
  if [[ $ip =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
    local octeto
    for octeto in "${BASH_REMATCH[@]:1}"; do
      [ "$((10#$octeto))" -le 255 ] || return 1
    done
    [ "$((10#$prefijo))" -le 32 ] && [ "$((10#$prefijo))" -ge 8 ]
  elif [[ $ip =~ ^[0-9a-f:]+$ && $ip == *:* ]]; then
    [ "$((10#$prefijo))" -le 128 ] && [ "$((10#$prefijo))" -ge 16 ]
  else
    return 1
  fi
}

generar() {
  local linea rango nombre
  nombre=$(basename "$ORIGEN")
  printf '# GENERADO por deploy/bulwark/cloudflare/generar.sh a partir de rangos.txt.\n'
  printf '# No se edita a mano: se cambia rangos.txt y se vuelve a ejecutar el script.\n'
  printf '# Lo incluye el bloque geo de nginx.conf: 1 = rango del proxy de Cloudflare.\n'
  while IFS= read -r linea || [ -n "$linea" ]; do
    rango=$(printf '%s' "$linea" | tr -d '[:space:]')
    [ -n "$rango" ] || continue
    case $rango in \#*) continue ;; esac
    if ! valido "$rango"; then
      echo "Rango no válido en $nombre: «$linea»" >&2
      return 1
    fi
    printf '%s 1;\n' "$rango"
  done <"$ORIGEN"
}

# Ruta del fichero relativa a la raíz del repositorio, para los mensajes.
ruta() { local d; d=$(cd "$(dirname "$1")" && pwd); printf '%s/%s' "${d#"$RAIZ"/}" "$(basename "$1")"; }
RAIZ=$(cd "$AQUI/../../.." && pwd)

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
generar >"$TMP"

if [ "${1:-}" = "--comprobar" ]; then
  desfasados=0
  for destino in "${DESTINOS[@]}"; do
    if ! cmp -s "$TMP" "$destino"; then
      echo "$(ruta "$destino") no corresponde a cloudflare/rangos.txt: ejecuta bash deploy/bulwark/cloudflare/generar.sh" >&2
      desfasados=1
    fi
  done
  [ "$desfasados" = 0 ] || exit 1
  echo "Los rangos de Cloudflare de las dos pasarelas están al día."
  exit 0
fi

# Legibles para todos: cada pasarela corre como el usuario 101 (con cp, un
# fichero nuevo saldría con los permisos 600 del temporal).
for destino in "${DESTINOS[@]}"; do
  cat "$TMP" >"$destino"
  chmod 644 "$destino"
  echo "Escrito $(ruta "$destino")"
done
