# ArduCopter SITL: the flight controller of a simulated Mu. Its physics come
# from Gazebo's ArduPilotPlugin over the JSON backend; see ../compose.yaml.

FROM ubuntu:24.04 AS build

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git build-essential \
      python3 python3-dev python3-pip python3-lxml pkg-config \
 && rm -rf /var/lib/apt/lists/*
# waf's code generators (mavgen, dronecan) want these exact-ish versions.
RUN pip install --no-cache-dir --break-system-packages empy==3.3.4 pexpect future

ARG ARDUPILOT_REF=Copter-4.7.2
RUN git clone --depth 1 --branch ${ARDUPILOT_REF} --recurse-submodules --shallow-submodules \
      https://github.com/ArduPilot/ardupilot /src/ardupilot
WORKDIR /src/ardupilot
RUN ./waf configure --board sitl && ./waf copter


FROM ubuntu:24.04

# curl: the entrypoint reads the world's location for SITL's home.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/ardupilot/build/sitl/bin/arducopter /usr/local/bin/arducopter
COPY --from=build /src/ardupilot/Tools/autotest/default_params/copter.parm \
                  /src/ardupilot/Tools/autotest/default_params/gazebo-iris.parm \
                  /usr/share/ardupilot/
COPY sitl-entrypoint.sh /usr/local/bin/sitl-entrypoint

# eeprom.bin (parameters) and logs, kept across restarts.
WORKDIR /var/lib/ardupilot
VOLUME /var/lib/ardupilot

ENTRYPOINT ["sitl-entrypoint"]
