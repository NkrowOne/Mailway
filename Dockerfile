# Imagen del panel de Mailway (servidor Node + web compilada).
# Skyway la construye desde este Dockerfile; el compose autónomo también.
#
# Node va con su versión exacta (p. ej. 22.23.3, no 22): Skyway reconstruye
# la imagen en cada despliegue y una etiqueta flotante cambiaría la base sin
# probarla. Las versiones nuevas llegan como PR de Dependabot que pasan la CI
# (que construye y arranca esta imagen).

# ---------- build: compila la web y el servidor ----------
FROM node:22.23.3-alpine AS build
# Compilador por si better-sqlite3 no tiene binario precompilado para la
# arquitectura (p. ej. algunos ARM); solo vive en esta etapa.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY server server
COPY web web
RUN npm run build

# ---------- prod-deps: solo dependencias de producción del servidor ----------
FROM node:22.23.3-alpine AS prod-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci -w server --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------- runtime ----------
FROM node:22.23.3-alpine
# su-exec: el contenedor arranca como root solo para dejar /data a nombre
# del usuario «node» (instalaciones anteriores escribían como root) y cede
# los privilegios antes de arrancar el servidor.
RUN apk add --no-cache su-exec tini \
  && mkdir -p /data \
  && chown node:node /data

WORKDIR /app
ENV NODE_ENV=production \
    MAILWAY_DATA_DIR=/data \
    PORT=4100

# El código queda a nombre de root (solo lectura para el servidor): un fallo
# en el proceso no puede reescribir el propio panel. Solo /data es de «node».
COPY package.json ./
COPY server/package.json server/
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY deploy/docker-entrypoint.sh /usr/local/bin/mailway-entrypoint

VOLUME /data
EXPOSE 4100

# Sin curl en la imagen: el propio Node consulta /api/health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# tini reenvía las señales (parada limpia de SQLite) y recoge procesos huérfanos.
# Con «sh» delante no depende del bit de ejecución (el constructor clásico de
# Docker, que Skyway usa si falta buildx, no admite COPY --chmod).
ENTRYPOINT ["/sbin/tini", "--", "/bin/sh", "/usr/local/bin/mailway-entrypoint"]
CMD ["node", "server/dist/index.js"]
