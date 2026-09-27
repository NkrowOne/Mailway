#!/bin/sh
# Punto de entrada de la imagen del panel.
#
# Arranca como root solo para asegurar que /data pertenece al usuario «node»:
# las versiones anteriores de la imagen escribían ahí como root y, sin este
# ajuste, el servidor no podría abrir su base de datos tras actualizar. Después
# cede los privilegios; el servidor nunca se ejecuta como root.
set -eu

DATA_DIR="${MAILWAY_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Solo si hace falta: evita recorrer el volumen en cada arranque.
  if [ -n "$(find "$DATA_DIR" -maxdepth 2 ! -user node -print -quit 2>/dev/null)" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  exec su-exec node "$@"
fi

exec "$@"
