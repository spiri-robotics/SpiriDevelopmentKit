#!/bin/sh
# Run ArduCopter SITL against the world's ArduPilotPlugin for this robot.
#
# The robot's index sets every per-robot number: SITL's -I (so the FDM port
# is 9002 + 10*index, matching the model sim-agent spawns), and the MAVLink
# system ID (index + 1). Until the robot's config carries it, the index comes
# from the robot's name: mu-N is index N-1.
set -eu

name=$(hostname)
if [ -z "${ROBOT_INDEX:-}" ]; then
	n=$(echo "$name" | sed -n 's/.*[^0-9]\([0-9][0-9]*\)$/\1/p')
	ROBOT_INDEX=$(( ${n:-1} - 1 ))
fi

# The world's address. SITL wants an IP, and the appliance's names resolve
# here because the robot's network namespace is on the appliance network.
sim=$(getent hosts "${SIM_HOST:-gazebo}" | awk '{print $1; exit}')
if [ -z "$sim" ]; then
	echo >&2 "sitl: cannot resolve ${SIM_HOST:-gazebo}"
	exit 1
fi

printf 'SYSID_THISMAV %s\n' $((ROBOT_INDEX + 1)) > identity.parm

echo "sitl: $name index $ROBOT_INDEX, world $sim:$((9002 + 10 * ROBOT_INDEX))," \
	"MAVLink on tcp:$((5760 + 10 * ROBOT_INDEX))"
exec arducopter -S --model JSON --sim-address="$sim" -I "$ROBOT_INDEX" \
	--speedup 1 --slave 0 \
	--home "$SITL_HOME" \
	--defaults /usr/share/ardupilot/copter.parm,/usr/share/ardupilot/gazebo-iris.parm,identity.parm \
	"$@"
