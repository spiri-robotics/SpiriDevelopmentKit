#!/bin/sh
# Run the robot: its own dockerd, then SpiriConfig managing it. If either
# exits the container exits, and the restart policy brings the robot back.
set -eu

# Pull through the appliance's registry instead of each robot fetching (and
# storing) every image itself.
if [ -n "${REGISTRY_MIRROR:-}" ] && [ ! -e /etc/docker/daemon.json ]; then
	mkdir -p /etc/docker
	host="${REGISTRY_MIRROR#*://}"
	cat > /etc/docker/daemon.json <<-EOF
		{
		  "registry-mirrors": ["$REGISTRY_MIRROR"],
		  "insecure-registries": ["$host"]
		}
	EOF
fi

# Unix socket only: the stock dind default also listens on tcp/2375, which
# would hand the robot's daemon to anything on the SDK network.
TINI_SUBREAPER=1 dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock &
dockerd=$!

tries=0
until docker info > /dev/null 2>&1; do
	if ! kill -0 "$dockerd" 2> /dev/null; then
		echo >&2 "robot: dockerd exited during startup"
		exit 1
	fi
	tries=$((tries + 1))
	if [ "$tries" -ge 60 ]; then
		echo >&2 "robot: dockerd not up after 60s"
		exit 1
	fi
	sleep 1
done

# The robot's SpiriConfig shares an origin with the SDK's, so their cookies
# must not share a name. The secret survives restarts with the volume.
: "${SPIRICONFIG_SESSION_COOKIE:=session-$(hostname)}"
export SPIRICONFIG_SESSION_COOKIE
if [ -z "${SPIRICONFIG_STORAGE_SECRET:-}" ]; then
	secret=/var/lib/spiriconfig/storage-secret
	if [ ! -s "$secret" ]; then
		mkdir -p "$(dirname "$secret")"
		(umask 077 && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$secret")
	fi
	SPIRICONFIG_STORAGE_SECRET="$(cat "$secret")"
	export SPIRICONFIG_STORAGE_SECRET
fi

# First boot: install and start the apps every Mu runs. After that they're
# ordinary installed apps, and dockerd's restart policy brings them back. A
# robot that can't reach its stores still boots, just without them. In the
# background, since building an app (ROBOT_DEV) can take minutes, and the
# robot's SpiriConfig shouldn't wait for it.
missing=
for app in ${ROBOT_APPS:-}; do
	[ -e "$SPIRICONFIG_DOCKER_COMPOSE_DIR/${app##*/}" ] || missing="$missing $app"
done
if [ -n "$missing" ]; then
	(
		# Clone the stores we haven't got. Not `appstore check`, which also
		# fetches the ones we have and stops at the first that fails, as a
		# read-only development checkout does.
		for url in $(echo "$SPIRICONFIG_APPSTORE_STORES" | tr -d '[]" ' | tr ',' ' '); do
			slug=$(basename "$url" .git)
			[ -e "$SPIRICONFIG_APPSTORE_STORE_DIR/$slug" ] ||
				spiriconfig appstore add "$url" || echo >&2 "robot: could not clone $url"
		done
		for app in $missing; do
			if ! { spiriconfig appstore install "$app" &&
				spiriconfig docker up "${app##*/}" ${ROBOT_DEV:+--dev}; }; then
				echo >&2 "robot: could not install $app"
			fi
		done
		echo >&2 "robot: first boot done"
	) &
fi

spiriconfig serve &
spiriconfig=$!

stop() {
	kill -TERM "$spiriconfig" 2> /dev/null || :
	# dockerd stops the robot's apps on the way down; give it the time.
	kill -TERM "$dockerd" 2> /dev/null || :
	wait "$dockerd" 2> /dev/null || :
	exit "${1:-0}"
}
trap stop TERM INT

while kill -0 "$dockerd" 2> /dev/null && kill -0 "$spiriconfig" 2> /dev/null; do
	sleep 2
done
echo >&2 "robot: $(kill -0 "$dockerd" 2> /dev/null && echo spiriconfig || echo dockerd) exited"
stop 1
