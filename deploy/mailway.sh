#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
compose=(docker compose -f docker-compose.mail.yml)
if [[ ! -f .env ]]; then
  (umask 077; cp .env.example .env)
  echo 'Se ha creado deploy/.env. Rellena MAIL_HOSTNAME, WEBMAIL_HOSTNAME, la contraseña vigente de Stalwart y TRAEFIK_ACME_VOLUME; después repite el comando.'
  exit 1
fi
case "${1:-help}" in
  up)
    "${compose[@]}" config --quiet
    if ! docker network inspect skyway-edge >/dev/null 2>&1; then
      echo 'Falta skyway-edge. Arranca Skyway antes de desplegar el correo.' >&2
      exit 1
    fi
    if ! "${compose[@]}" up -d --wait --wait-timeout 180; then
      echo 'El stack aún no está listo. Ejecuta ./mailway.sh logs; revisa DNS, ACME y la contraseña vigente del motor.' >&2
      exit 1
    fi
    echo 'TLS del motor comprobado. Sigue con ./mailway.sh check y ./mailway.sh login.'
    ;;
  check)
    failures=0
    "${compose[@]}" ps
    "${compose[@]}" exec -T certs-dumper python /app/sync.py health || failures=1
    "${compose[@]}" exec -T certs-dumper python /app/check.py || failures=1
    "${compose[@]}" exec -T mailway-webmail php /opt/mailway-check.php || failures=1
    exit "$failures"
    ;;
  login) "${compose[@]}" exec mailway-webmail php /opt/mailway-check.php --login ;;
  logs) "${compose[@]}" logs --tail 80 certs-dumper mailway-mail mailway-webmail ;;
  *) echo 'Uso: ./mailway.sh up | check | login | logs' ;;
esac
