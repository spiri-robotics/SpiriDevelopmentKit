# Stock Gazebo Jetty from the OSRF apt repo -- already built with the zenoh
# transport backend and the websocket server system -- plus ardupilot_gazebo,
# which has no packages and is built from source.

FROM ubuntu:24.04 AS gazebo

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg lsb-release \
 && curl -fsSL https://packages.osrfoundation.org/gazebo.gpg -o /usr/share/keyrings/pkgs-osrf-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/pkgs-osrf-archive-keyring.gpg] https://packages.osrfoundation.org/gazebo/ubuntu-stable $(lsb_release -cs) main" \
      > /etc/apt/sources.list.d/gazebo-stable.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gz-jetty \
      gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav \
 && rm -rf /var/lib/apt/lists/*


FROM gazebo AS ardupilot-gazebo-build

ARG ARDUPILOT_GAZEBO_REF=082a0fe
# Without this its CMakeLists assumes Harmonic.
ENV GZ_VERSION=jetty
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git \
      rapidjson-dev libopencv-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --filter=blob:none https://github.com/ArduPilot/ardupilot_gazebo /src/ardupilot_gazebo \
 && git -C /src/ardupilot_gazebo checkout ${ARDUPILOT_GAZEBO_REF}
RUN cmake -S /src/ardupilot_gazebo -B /build -DCMAKE_BUILD_TYPE=RelWithDebInfo -DCMAKE_INSTALL_PREFIX=/opt/ardupilot_gazebo \
 && cmake --build /build -j"$(nproc)" \
 && mkdir -p /opt/ardupilot_gazebo/plugins \
 && cp /build/*.so /opt/ardupilot_gazebo/plugins/ \
 && cp -r /src/ardupilot_gazebo/models /src/ardupilot_gazebo/worlds /opt/ardupilot_gazebo/


FROM gazebo

RUN apt-get update \
 && apt-get install -y --no-install-recommends libopencv-core406t64 libopencv-imgproc406t64 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ardupilot-gazebo-build /opt/ardupilot_gazebo /opt/ardupilot_gazebo

ENV GZ_SIM_SYSTEM_PLUGIN_PATH=/opt/ardupilot_gazebo/plugins \
    GZ_SIM_RESOURCE_PATH=/opt/ardupilot_gazebo/models:/opt/ardupilot_gazebo/worlds:/worlds \
    GZ_TRANSPORT_IMPLEMENTATION=zenoh \
    GZ_PARTITION=sdk \
    ZENOH_CONFIG=/etc/zenoh/session.json5

COPY zenoh/session.json5 /etc/zenoh/session.json5
COPY worlds /worlds
# Run as a second service from this image; see asset_server.py.
COPY asset_server.py /usr/local/bin/gz-asset-server
# Headless rendering (EGL) so camera sensors work without a display.
CMD ["gz", "sim", "-s", "-r", "-v", "3", "--headless-rendering", "/worlds/sdk.sdf"]
