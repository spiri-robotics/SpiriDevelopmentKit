#!/bin/sh
# Run ArduCopter SITL against the world's ArduPilotPlugin for this robot.
#
# Everything per-robot comes from outside: the MAVLink system ID from the
# robot (ROBOT_SYSID), and the GPS home from the world itself, so the two
# can't disagree. ROBOT_INDEX sets SITL's -I, which offsets every port: the
# world's FDM port is 9002 + 10 * index, matching the model sim-agent spawns.
set -eu

: "${ROBOT_INDEX:=0}"
: "${ROBOT_SYSID:=1}"
world_host=${SIM_HOST:-gazebo}
world_sdf=${WORLD_SDF_URL:-http://gazebo-assets:9003/world.sdf}

# Home is the world's <spherical_coordinates>; wait for the world to be up.
if [ -z "${SITL_HOME:-}" ]; then
	until sdf=$(curl -fsS "$world_sdf" 2> /dev/null); do
		echo >&2 "sitl: waiting for the world at $world_sdf"
		sleep 5
	done
	tag() { echo "$sdf" | tr -d '\n' | sed -n "s:.*<spherical_coordinates>.*<$1>\([^<]*\)</$1>.*</spherical_coordinates>.*:\1:p" | tr -d ' '; }
	SITL_HOME="$(tag latitude_deg),$(tag longitude_deg),$(tag elevation),$(tag heading_deg)"
	case "$SITL_HOME" in
		,* | *,,*) echo >&2 "sitl: the world has no usable <spherical_coordinates> ($SITL_HOME)"; exit 1 ;;
	esac
fi

# SITL wants an IP, and the appliance's names resolve here because the
# robot's network namespace is on the appliance network.
sim=$(getent hosts "$world_host" | awk '{print $1; exit}')
if [ -z "$sim" ]; then
	echo >&2 "sitl: cannot resolve $world_host"
	exit 1
fi

printf 'SYSID_THISMAV %s\n' "$ROBOT_SYSID" > identity.parm

# A gimbal camera (ROBOT_GIMBAL, as SpiriConfig writes a switch): its mount
# drives SERVO9-11, which sim-agent's model takes as the gimbal's joints.
defaults=/usr/share/ardupilot/copter.parm,/usr/share/ardupilot/gazebo-iris.parm
case "$(echo "${ROBOT_GIMBAL:-}" | tr '[:upper:]' '[:lower:]')" in
	true | 1 | yes | on) defaults="$defaults,/usr/share/ardupilot/gazebo-iris-gimbal.parm" ;;
esac

echo "sitl: $(hostname) sysid $ROBOT_SYSID, home $SITL_HOME," \
	"world $sim:$((9002 + 10 * ROBOT_INDEX)), MAVLink on tcp:$((5760 + 10 * ROBOT_INDEX))"
# --serial0 without :wait: by default SITL doesn't start until a GCS connects,
# and in lock-step the world waits on SITL, so nothing would move until then.
exec arducopter --model JSON --sim-address="$sim" -I "$ROBOT_INDEX" \
	--speedup 1 --slave 0 --serial0 tcp:0 \
	--home "$SITL_HOME" \
	--defaults "$defaults,identity.parm" \
	"$@"
