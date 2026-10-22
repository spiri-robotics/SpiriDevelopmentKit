FROM node:24-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY index.html main.js gz-overlay.js shell.js shell.css zenoh.js path-tree.js path-tree.css synq.js synq-schema.js synq-schema.css vite.config.js ./
COPY applets ./applets
RUN npm run build

# zenoh-ts's websocket bridge, the same version as the zenoh-ts in the page
# (they must match) and as the SDK router.
FROM alpine:3.22 AS zenoh
ARG TARGETARCH
ARG ZENOH_TS=1.8.0
RUN arch=$([ "$TARGETARCH" = arm64 ] && echo aarch64 || echo x86_64) \
 && wget -qO z.zip "https://github.com/eclipse-zenoh/zenoh-ts/releases/download/${ZENOH_TS}/zenoh-ts-${ZENOH_TS}-${arch}-unknown-linux-musl-standalone.zip" \
 && unzip z.zip zenoh-bridge-remote-api \
 && install -m 755 zenoh-bridge-remote-api /usr/local/bin/

FROM caddy:2.10.2-alpine
RUN apk add --no-cache libgcc
COPY --from=zenoh /usr/local/bin/zenoh-bridge-remote-api /usr/local/bin/
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
