# Getting started

How to run the SDK on your own Linux machine. For how the parts fit together,
see [architecture.md](architecture.md).

You need Docker, with your user able to run `docker` without sudo, and
[uv](https://docs.astral.sh/uv/).

## 1. Start SpiriConfig

```console
$ uvx spiriconfig serve --no-login-required
```

Open <http://localhost:8337>.

`--no-login-required` is safe here because SpiriConfig only listens on
`127.0.0.1`. Don't combine it with `SPIRICONFIG_HOST=0.0.0.0`: anyone on your
network would control your docker daemon.

## 2. Add the simulation app store

In the app store page, press **Add store** and enter:

```
https://github.com/spiri-robotics/Appsource-Spiri-Simulation
```

Or from a shell:

```console
$ uvx spiriconfig appstore add https://github.com/spiri-robotics/Appsource-Spiri-Simulation
```

## 3. Install the apps

Install and start them in this order:

1. **zenoh-router.** Everything meets at this router, and it creates the
   `spirisynq` network the other apps join. It listens on port 7447, which is
   how real robots and other machines reach the sim.
2. **gazebo.** The simulated world. It has no page of its own; pick the
   world in its settings.
3. **debug-map.** A globe with the Gazebo world on it, and a
   tool to browse everything on zenoh. Once it's up, *Debug map* appears in
   SpiriConfig's sidebar. It isn't in Appsource-Spiri-Simulation yet, so
   install it from this repo's own store (below).

## What isn't there yet

- **Simulated robots.** `sim-robot`, `ardupilot-sitl` and `sim-agent` aren't
  in Appsource-Spiri-Simulation yet. Install them from this repo's own store
  (below).
- **The map.** Appsource-Spiri-Simulation's `gazebo` pins the last release,
  which still bundles the older viewer. The `debug-map` app, its applets and *Zenoh
  keys* are only in this repo until the next release.
- **More than one robot.** The SDK runs one simulated robot, `mu-1`, for now.

## Developing the SDK

This repo is an app store too: each app is a top-level directory with a
compose file. Link your checkout into SpiriConfig's store directory, and it
shows up next to Appsource-Spiri-Simulation:

```console
$ git clone git@github.com:spiri-robotics/SpiriDevelopmentKit.git
$ mkdir -p ~/.local/share/spiriconfig/stores
$ ln -s "$PWD/SpiriDevelopmentKit" ~/.local/share/spiriconfig/stores/SpiriDevelopmentKit
```

Use a symlink, not **Add store**. Adding a store makes its own clone, which
you'd have to keep pulling. Through the link, apps installed from this store
run your working tree.

Both stores have a `gazebo`, so name the one you mean:

```console
$ uvx spiriconfig appstore install SpiriDevelopmentKit/gazebo
$ uvx spiriconfig appstore install SpiriDevelopmentKit/debug-map
```

Every app here has a `compose.dev.yaml` that builds its images, so SpiriConfig
offers **Up (dev)** for it in advanced mode. Up (dev) doesn't rebuild, though:
it only builds images that don't exist yet. Build first, and again after each
change:

```console
$ cd ~/spiri-apps/gazebo
$ docker compose -p gazebo -f compose.yaml -f compose.dev.yaml build
$ uvx spiriconfig docker up gazebo --dev
```

The first Gazebo build compiles ardupilot_gazebo and takes a while.

**Don't press Update on an app from this store.** Update commits every edit to
a tracked file in the checkout, then merges its upstream branch into yours.
That's right for an installed app store, and wrong for the branch you're
working on. Use git yourself. Removing the store is safe: it deletes the
symlink, not your checkout.

### Robots

Install `SpiriDevelopmentKit/sim-robot` as `mu-1`:

```console
$ uvx spiriconfig appstore install SpiriDevelopmentKit/sim-robot --as mu-1
```

A robot mounts your checkout as a store too, so the apps it installs from
SpiriDevelopmentKit are your working tree. Tell it where the checkout is: in
the robot's settings, turn on advanced mode and set *SpiriDevelopmentKit
checkout*. The same settings hold its name, its MAVLink system ID and the
QGroundControl port. Then build and start it as above:

```console
$ cd ~/spiri-apps/mu-1
$ docker compose -p mu-1 -f compose.yaml -f compose.dev.yaml build
$ uvx spiriconfig docker up mu-1 --dev
```

On its first boot the robot installs and starts its own apps from your
checkout: the Mu's zenoh router, `sim-agent` (which puts its airframe into the
world) and `ardupilot-sitl` (its flight controller). It builds them itself,
and the first SITL build compiles ArduCopter, so give it a few minutes. Watch
for `robot: first boot done` in its log:

```console
$ docker logs -f mu-1 2>&1 | grep robot:
```

The robot appears in the sidebar as *mu-1*, and in the Gazebo world as `mu-1`.

**Connecting QGroundControl.** In QGC, open *Application Settings → Comm
Links*, add a **TCP** link to `localhost` port 5760, and connect. From another
machine, use this machine's address instead. The port is in the robot's
settings.

A robot's own SpiriConfig shown inside the SDK's is still being worked out
(see [architecture.md](architecture.md#open-questions-and-first-spike)), so
expect rough edges there. To look inside a robot directly:

```console
$ docker exec -it mu-1 sh
# docker ps
```

A robot keeps its images and installed apps in named volumes. Bring it down
with `docker compose -p mu-1 down -v` to start it fresh.
