# mavlink-router: shares a robot's flight controller between everything that
# talks MAVLink to it; see ../compose.yaml.

FROM debian:trixie-slim AS build

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git g++ meson ninja-build pkg-config \
 && rm -rf /var/lib/apt/lists/*

ARG MAVLINK_ROUTER_REF=v4
RUN git clone --depth 1 --branch ${MAVLINK_ROUTER_REF} --recurse-submodules --shallow-submodules \
      https://github.com/mavlink-router/mavlink-router /src/mavlink-router
WORKDIR /src/mavlink-router
RUN meson setup build --buildtype=release -Dsystemdsystemunitdir=/usr/lib/systemd/system \
 && ninja -C build


FROM debian:trixie-slim

COPY --from=build /src/mavlink-router/build/src/mavlink-routerd /usr/local/bin/mavlink-routerd
COPY main.conf /etc/mavlink-router/main.conf

ENTRYPOINT ["mavlink-routerd", "-c", "/etc/mavlink-router/main.conf"]
