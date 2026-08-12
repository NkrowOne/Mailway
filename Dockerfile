# ---------- build: compila la web y el servidor ----------
FROM node:22-alpine AS build
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
FROM node:22-alpine AS prod-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci -w server --omit=dev --no-audit --no-fund

# ---------- runtime ----------
FROM node:22-alpine
RUN apk add --no-cache curl ca-certificates

WORKDIR /app
ENV NODE_ENV=production \
    MAILWAY_DATA_DIR=/data \
    PORT=4100

COPY package.json ./
COPY server/package.json server/
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist

VOLUME /data
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS http://localhost:4100/api/health || exit 1

CMD ["node", "server/dist/index.js"]
