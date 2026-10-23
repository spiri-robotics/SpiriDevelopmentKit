FROM node:24-slim AS build
# gz-msgs' protos, the version Jetty ships (as debug-map/index's), for the
# messages the map decodes: gz-msgs.mjs writes them out as gz-msgs.json.
ARG GZ_MSGS_TAG=gz-msgs12_12.0.2
ADD https://github.com/gazebosim/gz-msgs/archive/refs/tags/${GZ_MSGS_TAG}.tar.gz /tmp/gz-msgs.tar.gz
RUN mkdir /gz-msgs && tar xzf /tmp/gz-msgs.tar.gz -C /gz-msgs --strip-components=1
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY gz-msgs.mjs ./
RUN node gz-msgs.mjs /gz-msgs/proto > gz-msgs.json
COPY index.html main.js offline-map.js gz-world.js gz-services.js gz-transport.js shell.js shell.css zenoh.js path-tree.js path-tree.css synq.js synq-schema.js synq-schema.css synq-frames.js synq-frames.css vite.config.js ./
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
