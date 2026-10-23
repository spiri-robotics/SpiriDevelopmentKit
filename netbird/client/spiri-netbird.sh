#!/usr/bin/env bash
# The NetBird daemon, joined to whichever VPN the robot's Spiri Cloud link
# says: SPIRI_NETBIRD_MANAGEMENT_URL and SPIRI_NETBIRD_SETUP_KEY in the env
# file cloud-link writes. The file is watched, not read once like compose's
# env_file, so linking, relinking and unlinking reach the VPN without anyone
# restarting this.
#
# The setup key is one-off, but passing it again is harmless: once the peer
# exists, the daemon logs in with its own key and the setup key is unused.
# Relinking gives a new setup key, and since unlinking deleted the old peer in
# the cloud, the same WireGuard key enrolls again as the new peer.
set -Eeuo pipefail

ENV_FILE="${SPIRI_CLOUD_ENV_FILE:-/spiri-cloud/cloud.env}"
POLL="${SPIRI_NETBIRD_POLL:-10}"
export NB_LOG_FILE="${NB_LOG_FILE:-console}"

log() { printf '%s spiri-netbird: %s\n' "$(date -Isec)" "$*" >&2; }

# One KEY='value' from the env file. Not sourced: only these two keys, and
# nothing in the file gets run. No file (not linked) is no value.
value() {
	[ -r "$ENV_FILE" ] || return 0
	sed -n "s/^$1='\\([^']*\\)'\$/\\1/p" "$ENV_FILE" | head -n 1 || :
}

netbird service run &
daemon=$!
trap 'kill -TERM "$daemon" 2> /dev/null; wait "$daemon"' TERM INT EXIT

for _ in $(seq 30); do
	netbird status --check live > /dev/null 2>&1 && break
	kill -0 "$daemon" 2> /dev/null || { log "daemon exited during startup"; exit 1; }
	sleep 1
done

joined=  # the management URL and setup key we last ran `up` with
while kill -0 "$daemon" 2> /dev/null; do
	url=$(value SPIRI_NETBIRD_MANAGEMENT_URL)
	key=$(value SPIRI_NETBIRD_SETUP_KEY)
	want=
	[ -n "$url" ] && [ -n "$key" ] && want="$url $key"
	if [ "$want" != "$joined" ]; then
		if [ -n "$want" ]; then
			log "joining $url"
			# A failed `up` (cloud unreachable, say) is tried again next round.
			if netbird up --management-url "$url" --setup-key "$key"; then
				joined=$want
			fi
		else
			log "not linked, or no VPN in this organization: staying off"
			netbird down > /dev/null 2>&1 || :
			joined=
		fi
	fi
	sleep "$POLL"
done
log "daemon exited"
exit 1
