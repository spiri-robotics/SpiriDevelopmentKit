# A simulated Spiri robot: docker-in-docker plus SpiriConfig, so robot apps
# install and run inside it as ordinary compose stacks, as on a real Mu.
# Must run privileged; see ../compose.yaml.
FROM docker:29.8.2-dind

COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /usr/local/bin/uv

# git: SpiriConfig's app store clones appsources. linux-pam: SpiriConfig
# loads it even with auth off.
RUN apk add --no-cache git linux-pam
# A store can be a checkout someone else owns, such as one mounted for
# development; see ../compose.dev.yaml.
RUN git config --system --add safe.directory '*'

# Pinned to a commit until a release has configurable session cookies, which
# keep each robot's login separate from the SDK SpiriConfig's on one origin.
ARG SPIRICONFIG=git+https://github.com/spiri-robotics/SpiriConfig.git@431dd9f
ENV UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_TOOL_DIR=/opt/uv-tools \
    UV_TOOL_BIN_DIR=/usr/local/bin
RUN uv tool install --python 3.13 "spiriconfig @ ${SPIRICONFIG}" \
    && uv cache clean

# Behind the SDK SpiriConfig, which owns the login and the TLS.
ENV SPIRICONFIG_HOST=0.0.0.0 \
    SPIRICONFIG_PORT=8337 \
    SPIRICONFIG_AUTH=none \
    SPIRICONFIG_TLS=off \
    SPIRICONFIG_DOCKER_COMPOSE_DIR=/srv/compose \
    SPIRICONFIG_APPSTORE_STORE_DIR=/var/lib/spiriconfig/stores \
    SPIRICONFIG_APPSTORE_STORES='["https://github.com/spiri-robotics/Appsource-Spiri-Simulation", "https://github.com/spiri-robotics/Appstore-Spiri_development"]'

# Apps every Mu runs, installed and started on the robot's first boot, as
# <store>/<app>. Appstore-Spiri_development stands in for Appsource-Spiri-Mu,
# which doesn't exist yet; its zenoh-router is the Mu's own.
ENV ROBOT_APPS="Appstore-Spiri_development/zenoh-router"

COPY robot-entrypoint.sh /usr/local/bin/robot-entrypoint

# Inner images and containers; installed apps and their store clones.
VOLUME /var/lib/docker /srv/compose /var/lib/spiriconfig

EXPOSE 8337
ENTRYPOINT ["docker-init", "--", "robot-entrypoint"]
