# The offline-map tile server and its manager page, with go-pmtiles for
# cutting regions, and the world's osm base (z0-6, ~45 MB) cut at build time
# so the map is never blank offline. PROTOMAPS_BUILD picks the Protomaps
# planet build (YYYYMMDD); empty is the latest, since Protomaps deletes old
# builds.
FROM python:3.13-slim AS pmtiles
ARG PMTILES_VERSION=1.31.2
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && arch=$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x86_64) \
 && curl -fsSL "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_${arch}.tar.gz" \
    | tar xz -C /usr/local/bin pmtiles

FROM pmtiles AS base
ARG PROTOMAPS_BUILD=
RUN build=${PROTOMAPS_BUILD:-$(curl -fsSL -A offline-map https://build-metadata.protomaps.dev/builds.json \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1]["key"].removesuffix(".pmtiles"))')} \
 && url="https://build.protomaps.com/${build}.pmtiles" \
 && mkdir -p /base/osm \
 && pmtiles extract "$url" /base/osm/world.pmtiles --maxzoom=6 \
 && printf '{"source": "%s"}' "$url" > /base/osm/world.json

# The manager page's libraries, served as they are: it has no build step, and
# the appliance has no internet. MapLibre as the debug map's. Protomaps' fonts
# (~15 MB) and sprites, so the base map has labels offline.
FROM pmtiles AS vendor
ARG MAPLIBRE=6.11.2
ARG BASEMAPS=5.7.2
ARG BASEMAPS_ASSETS=028c18f713baecad011301ff7a69acc39bcc2ae7
RUN mkdir /vendor && cd /vendor \
 && for f in maplibre-gl.mjs maplibre-gl-shared.mjs maplibre-gl-worker.mjs maplibre-gl.css; do \
      curl -fsSLO "https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE}/dist/$f"; done \
 && curl -fsSLo basemaps.mjs "https://cdn.jsdelivr.net/npm/@protomaps/basemaps@${BASEMAPS}/dist/esm/index.js" \
 && mkdir /assets \
 && curl -fsSL "https://github.com/protomaps/basemaps-assets/archive/${BASEMAPS_ASSETS}.tar.gz" \
    | tar xz -C /assets --strip-components=1 "basemaps-assets-${BASEMAPS_ASSETS}/fonts" "basemaps-assets-${BASEMAPS_ASSETS}/sprites/v4"

FROM python:3.13-slim
# 1.9.0: 1.8.0 has no working x86_64 wheel. zenoh 1.x versions interoperate.
RUN pip install --no-cache-dir SpiriSynq==0.4.0 eclipse-zenoh==1.9.0 pmtiles==3.8.1 loguru==0.7.3 pillow==11.3.0
COPY --from=pmtiles /usr/local/bin/pmtiles /usr/local/bin/pmtiles
COPY --from=base /base /opt/offline-map/base
COPY --from=vendor /vendor /opt/offline-map/web/vendor
COPY --from=vendor /assets /opt/offline-map/web/assets
COPY tiles.py overzoom.py map_layer.py server.py manager.py /opt/offline-map/
COPY web /opt/offline-map/web
ENTRYPOINT ["python3", "-u"]
CMD ["/opt/offline-map/server.py", "serve"]
