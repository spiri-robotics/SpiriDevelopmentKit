# Getting started

How to run the SDK on your own Linux machine, from source: a Gazebo world, a
map to watch it on, and one simulated Spiri Mu running ArduPilot that you fly
from QGroundControl. Everything runs as SpiriConfig apps. For how the parts
fit together, see [architecture.md](architecture.md).

You need:

- Linux, with Docker. Your user must be able to run `docker` without sudo.
  The simulated robot runs as a privileged container.
- [uv](https://docs.astral.sh/uv/), to run SpiriConfig.
- [QGroundControl](https://qgroundcontrol.com/), to fly the robot.
- An internet connection. The first builds pull Gazebo and compile
  ArduCopter, which takes a few minutes.

## 1. Start SpiriConfig

```console
$ uvx spiriconfig serve --no-login-required
```

Leave it running, and open <http://localhost:8337>.

`--no-login-required` is safe here because SpiriConfig only listens on
`127.0.0.1`. Don't combine it with `SPIRICONFIG_HOST=0.0.0.0`: anyone on your
network would control your docker daemon.

## 2. Add the app stores

You need two. **Appsource-Spiri-Simulation** has the zenoh router. **This
repo** has everything else, until the next release puts it in the appsource
too.

Add the appsource from the app store page (**Add store**), or from a shell:

```console
$ uvx spiriconfig appstore add https://github.com/spiri-robotics/Appsource-Spiri-Simulation
```

Add this repo by linking a checkout into SpiriConfig's store directory. Use a
link, not **Add store**: apps installed through the link run your working
tree, so your edits take effect without pulling anything.

```console
$ git clone git@github.com:spiri-robotics/SpiriDevelopmentKit.git
$ mkdir -p ~/.local/share/spiriconfig/stores
$ ln -s "$PWD/SpiriDevelopmentKit" ~/.local/share/spiriconfig/stores/SpiriDevelopmentKit
```

**Don't press Update on an app from SpiriDevelopmentKit.** Update commits every
edit in the checkout and merges its upstream branch into yours. Use git
yourself. Removing the store only deletes the link.

## 3. Start the world

Install three apps, in this order. Both stores have a `gazebo`, so name the
store:

```console
$ uvx spiriconfig appstore install Appsource-Spiri-Simulation/zenoh-router
$ uvx spiriconfig appstore install SpiriDevelopmentKit/gazebo
$ uvx spiriconfig appstore install SpiriDevelopmentKit/debug-map
```

| App | What it is |
| --- | --- |
| `zenoh-router` | The router everything meets at. It creates the `spirisynq` docker network the other apps join. |
| `gazebo` | The simulated world. Choose which in its settings. |
| `debug-map` | A globe showing the world and everything on zenoh. It appears in SpiriConfig's sidebar as *Debug map*. |

Start the router as is. Gazebo and the map build from your checkout, so build
them first:

```console
$ uvx spiriconfig docker up zenoh-router
$ for app in gazebo debug-map; do
    (cd ~/spiri-apps/$app && docker compose -p $app -f compose.yaml -f compose.dev.yaml build) &&
    uvx spiriconfig docker up $app --dev
  done
```

In the web UI, **Up (dev)** does the same as `docker up --dev`, in advanced
mode. Neither rebuilds for you yet, so build after every change.

**Choosing a world.** Set it in Gazebo's settings, or:

```console
$ uvx spiriconfig docker settings gazebo GZ_WORLD=yarmouth-airport
$ uvx spiriconfig docker up gazebo --dev
```

| World | Where |
| --- | --- |
| `citadel-hill` (default) | The Halifax Citadel: the hill and its buildings. |
| `yarmouth-airport` | Yarmouth airport, Nova Scotia. Flat ground. |
| `cmac` | ArduPilot's stock SITL field in Canberra. Flat ground. |

Restart the robot after changing the world (see [Day to day](#day-to-day)).

## 4. Add the robot

The SDK runs one simulated robot, `mu-1`. Install it:

```console
$ uvx spiriconfig appstore install SpiriDevelopmentKit/sim-robot --as mu-1
```

The robot installs its own apps from your checkout, so it needs to know
where that is. In its settings, turn on advanced mode and set *SpiriDevelopmentKit
checkout*, or:

```console
$ uvx spiriconfig docker settings mu-1 SDK_SOURCE="$PWD/SpiriDevelopmentKit"
```

Its other settings are its name, its MAVLink system ID, the port
QGroundControl connects to, and *Gimbal camera*. The defaults are fine. The
gimbal camera is off by default: turn it on for a 3-axis gimbal with a camera
under the airframe, which you point from QGroundControl like any ArduPilot
mount and watch in the debug map's *Cameras* applet.

Build it and start it:

```console
$ cd ~/spiri-apps/mu-1
$ docker compose -p mu-1 -f compose.yaml -f compose.dev.yaml build
$ uvx spiriconfig docker up mu-1 --dev
```

The robot is a computer of its own: a docker daemon and a SpiriConfig, like a
real Mu's. On its first boot it installs seven apps into itself, and builds
six of them, which takes a few minutes:

| App inside the robot | What it does | On a real Mu |
| --- | --- | --- |
| `zenoh-router` | The Mu's own router, joined to the world's | the same app |
| `sim-agent` | Puts the robot's airframe into the world, and back after the world restarts | nothing: a real Mu has a body |
| `mavlink-router` | The robot's MAVLink endpoint, tcp 5760: QGroundControl and the robot's own apps connect to the flight controller through it at once | the same app |
| `ardupilot-sitl` | The flight controller: ArduCopter SITL, flying the airframe in Gazebo | the flight controller board |
| `sim-camera-ingress` | The gimbal camera's picture, on SpiriSynq. Idle without *Gimbal camera* | `camera-ingress`, from the real camera |
| `cloud-link` | Links the robot to a Spiri Cloud organization, from its *Spiri Cloud* page, and serves its camera to the organization's Frigate | the same app |
| `netbird` | Joins the organization's VPN once the robot is linked; idle otherwise | the same app |

Watch for the end of the first boot:

```console
$ docker logs -f mu-1 2>&1 | grep robot:
robot: first boot done
```

The robot then appears in the world, on the map, and in SpiriConfig's
sidebar as *mu-1*.

## 5. Fly it

In QGroundControl, open *Application Settings → Comm Links*, add a link of
type **TCP** to host `localhost`, port **5760**, and connect. From another
machine, use this machine's address. That's the robot's mavlink-router, so
QGroundControl shares the flight controller with the robot's own apps, such as
SpiriMav, which connect to `tcp:127.0.0.1:5760` inside the robot.

The robot shows up as system ID 1 with a GPS fix, at the world's location.
Arm and take off as with any ArduCopter.

## Day to day

**After changing code**, build and restart the app that changed. For an app on
your machine (`gazebo`, `debug-map`, `mu-1`), build as in step 3. For an app
inside the robot, build it there:

```console
$ docker exec mu-1 sh -c 'cd /srv/compose/ardupilot-sitl &&
    docker compose -p ardupilot-sitl -f compose.yaml -f compose.dev.yaml up -d --build'
```

**After changing the robot's settings**, such as *Gimbal camera*, restart it
with Up (dev): its apps read them from the robot's environment, which is set
when its container is created. A robot from before `sim-camera-ingress`
existed won't install it by itself; install it inside the robot like the
others, or start the robot from scratch (below). The same goes for
`mavlink-router`. Install it after rebuilding `ardupilot-sitl`: until then the
old SITL holds port 5760, and the router runs without its TCP server until it
restarts.

```console
$ docker exec mu-1 sh -c 'spiriconfig appstore install SpiriDevelopmentKit/mavlink-router &&
    spiriconfig docker up mavlink-router --dev'
```

**After changing the world, or restarting Gazebo**, restart the robot.
`sim-agent` puts the airframe back by itself, but SITL looks up the world's
address and location only when it starts.

```console
$ docker restart mu-1
```

**To look inside the robot**:

```console
$ docker exec -it mu-1 sh
# docker ps
# docker logs ardupilot-sitl-sitl-1
```

**To start the robot from scratch**, delete its volumes. Its next boot is a
first boot again, builds included.

```console
$ cd ~/spiri-apps/mu-1 && docker compose -p mu-1 down -v
$ uvx spiriconfig docker up mu-1 --dev
```

## Known issues

- **The world freezes if SITL stops while its airframe is in the world.**
  Gazebo waits for SITL before every physics step, with no timeout. Restarting
  the robot brings it back. If you remove the robot for good, restart Gazebo.
- **Nothing rebuilds by itself.** Up (dev) only builds images that don't exist
  yet.
- **One robot.** Several robots need their own ports and system IDs, and a way
  for QGroundControl to reach all of them. Not done yet.
- **The robot's own SpiriConfig** opens inside yours under *mu-1*, but nesting
  one SpiriConfig in another still has rough edges. A shell into the robot
  always works.
- **The released appsource lags behind.** Appsource-Spiri-Simulation's `gazebo`
  is the last release, with the older viewer and no robot. Use this repo's
  apps until the next release.
