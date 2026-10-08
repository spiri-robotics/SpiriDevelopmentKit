# Architecture

How the SpiriDevelopmentKit is put together, and why. This is for people working
*on* the SDK; people working *with* it should start at the [README](../README.md).

Status: design agreed, nothing built yet. Anything marked **(proposed)** is a
starting point for the first spike, not a settled interface.

## What it is for

The SDK is a simulated swarm of Spiri robots that runs the same software as the
real ones, so that a capability developed against the sim runs on hardware
unchanged.

The near-term scope is the SDK deliverables on the ARC contract (Odoo project
*TS3-011581 - ARC*):

| Milestone | KPI tasks | What the SDK has to do |
| --- | --- | --- |
| Airgapped install | #92 | Install and run with no internet connection. |
| Sim runs ISR and C-UAS behaviours | #93, #94 | Run the mapping, surveillance, intercept, escort and vehicle-following scenarios with a swarm of at least 3 Mu's. |
| SDK-to-real-world pipeline | #95, #96, #97 | An operator builds a helipad detector, runs it in sim, then on a physical Mu. |

The swarm behaviours those scenarios exercise (mapping, surveillance, intercept,
escort, following) are not part of the SDK. Another team builds them as a
QGroundControl plugin. The SDK provides the swarm for that plugin to fly, the
worlds and targets, and the KPI scoring.

Longer term the SDK should scale past 3 robots, mix simulated and real robots in
one swarm, and attach to simulations we don't run ourselves. Choices below are
made so that none of that is ruled out, without building it now.

## The appliance

The SDK ships as a server appliance that Spiri provides. We choose the hardware,
the GPU, and the OS. Privileged containers are allowed, and images come
pre-loaded, which is most of the airgap story.

```
appliance (docker)
│
├── sdk-spiriconfig   SpiriConfig in a container, host docker socket mounted.
│                     Manages the sim stacks; each robot's UI appears in it.
├── zenoh-router      The one router everything meets at, sim and real.
├── world             Stock Gazebo Jetty (zenoh backend) + ardupilot_gazebo.
├── registry          Image mirror shared by every robot's inner dockerd.
└── mu-1 … mu-N       One docker-in-docker container per simulated robot,
                      each running its own SpiriConfig and robot apps.
```

All of these sit on **one user-defined docker bridge network**. See
[Networking](#networking) for why.

## SDK SpiriConfig

A normal SpiriConfig, run as a container with `/var/run/docker.sock` mounted. It
manages the world, the router and the robots as ordinary compose stacks, and
does not have to be on the same host as any of them.

Each robot container carries `spiriconfig.plugin.*` labels. The SDK SpiriConfig
discovers them through `docker ps`, so each robot's own SpiriConfig shows up as
a plugin and is proxied at `/plugin/mu-1/`. The fleet view comes from the
existing container-plugin mechanism, not a new feature.

The compose directory must be mounted **at the same path inside and outside**
the container (e.g. `/srv/sdk:/srv/sdk`). The host daemon resolves bind mounts in
compose files, so a path that only exists inside the container breaks every
relative volume.

SpiriConfig changes this needs:

- **Nested shells.** A robot's SpiriConfig is a full shell served under a
  prefix, inside another shell. Its iframe `src` and other absolute URLs must
  honour `X-Forwarded-Prefix`. Robots run `SPIRICONFIG_AUTH=none`, since they
  sit behind the SDK's login, and their cookies must not collide with the
  SDK's on the shared origin.
- **Discovery scoping, only if two SpiriConfigs share the appliance's
  daemon.** A robot's own apps run on its *inner* dockerd and never appear in
  the appliance's `docker ps`, so there is nothing inside a robot to filter.
  The only overlap is the robot containers themselves. If the appliance also
  runs a host SpiriConfig, it would list them too. Fixing that needs a label or
  compose-project filter, and only matters if that second SpiriConfig exists.

## A simulated robot

Each robot is a privileged docker-in-docker container whose hostname is its name
(`mu-1`). The hostname is also the SpiriSynq topic prefix. Inside it run
dockerd, SpiriConfig, and a set of compose apps. **Most of those apps are
identical to what runs on a real Mu.** Only the apps standing in for hardware
differ:

| Sim app | Does | On a real Mu, replaced by |
| --- | --- | --- |
| `ardupilot-sitl` | ArduPilot SITL, the flight controller | the FC board, over serial |
| `sim-camera-ingress` | Video from Gazebo | `camera-ingress` from the real camera |
| `sim-agent` | Joins the robot to the simulated world (below) | nothing |
| `sim-link` (optional) | netem on the robot's link: a simulated radio | the real radio |

Everything else is the same app on both: mavlink-router, zenoh, and the
operator's own code, such as the helipad detector. Moving from sim to hardware
(#97) means swapping the first column for the third and changing nothing else.

The image is `apps/sim-robot/`: stock `docker:dind` plus SpiriConfig, with an
entrypoint that runs both. The inner dockerd listens on its unix socket only,
not the dind default `tcp/2375`, which would hand the robot to anything on the
bridge. SpiriConfig runs with `SPIRICONFIG_AUTH=none` and TLS off, and with a
session cookie named after the hostname. `REGISTRY_MIRROR` points the inner
dockerd at the shared registry. Docker only applies mirrors to Docker Hub,
though, so ghcr.io pulls still need a solution (#177).

Inside, a robot is networked exactly like a Mu. It runs the Mu's own
`zenoh-router` app: an inner router on the robot's own `spirisynq` network,
plus a `network_mode: host` router in the robot's network namespace, which is
on the appliance bridge. Inner apps only ever talk to their own router, so
they need no appliance names or addresses. Docker's DNS doesn't resolve
appliance names from inner containers anyway. Routers don't connect to each
other by default, so the appliance's `zenoh-router` sets
`scouting/multicast/autoconnect` to include routers and joins each robot's
router as it appears. Robots carry no sim-specific zenoh config.

A sim robot installs from two appsources. The real **Appsource-Spiri-Mu**
provides everything except its ArduPilot and camera connectors, which the robot
doesn't start. **Appsource-Spiri-Simulation** provides the sim apps above. See
[Images and appsources](#images-and-appsources).

## Gazebo and ArduPilot

### The world is stock Gazebo

The world container runs **Gazebo Jetty** with the zenoh transport backend
(`GZ_TRANSPORT_IMPLEMENTATION=zenoh`) connected to the shared router, a pinned
`GZ_PARTITION` (e.g. `sdk`), and the ardupilot_gazebo plugin. **There is no
Spiri code on the world side.** A world we don't run, with the same four
ingredients, is one our robots can join.

With the zenoh backend, gz-transport maps (verified in the `gz-transport15`
source):

- A **service** such as `/world/sdk/create` → a zenoh **queryable** at
  `@/<partition>@/world/sdk/create`. Requests and replies are raw protobuf
  bytes (`gz.msgs.EntityFactory` in, `gz.msgs.Boolean` out).
- A **topic** → pub/sub on the same kind of key. The payload is protobuf, with
  the message type name in the zenoh attachment.
- **Discovery** → liveliness tokens under `@gz/<partition>/…`.

So any plain zenoh client with protobuf classes generated from gz-msgs can
spawn, remove, and observe models. It needs no Gazebo libraries. Keys starting
with `@` only match exactly, so Gazebo traffic doesn't show up in `**`
subscriptions and stays separate from SpiriSynq traffic.

Upstream still calls ZeroMQ the recommended production backend, and the zenoh
code is still settling: `main` has a cold-start fix that Jetty lacks. A failed
service call gets no reply, only a timeout. Callers retry, and treat a timeout
as a failure.

### The ArduPilot bridge stays on UDP

SITL's JSON backend and the `ArduPilotPlugin` exchange packets every physics
step: servo PWM out, IMU, pose and velocity back. This link is the wire between
the flight controller and its own airframe, so it:

- **stays on plain UDP, not zenoh.** It's on the lockstep critical path, about
  1 kHz per robot, and an extra hop slows the whole world.
- **is exempt from `sim-link`'s netem.** Radio loss must not corrupt physics.
- uses **port `9002 + 10·index`**, with SITL started as `-I <index>`. The
  index comes from the robot's config, set by whatever launched the swarm.

With `<lock_step>` on, the slowest robot sets the real-time factor for the
whole world. Rendered cameras make this worse. It's the main performance risk,
and it gets measured before the scenarios are built on top.

### sim-agent

`sim-agent` does everything needed to put its robot in a world. It has no
counterpart on the world side.

1. **Configure SITL.** Write the FDM target (world address, `9002 + 10·index`)
   and `--home` for `ardupilot-sitl`, which starts after the agent is healthy.
   `--home` is the world origin for every robot, and robots get distinct GPS
   fixes from their spawn positions. If any robot's home is wrong, its GPS is
   quietly wrong too.
2. **Announce.** Declare a liveliness token and publish a SpiriSynq object with
   the robot's model reference, content hash, and spawn pose. **(proposed)** The
   token goes at `sim/robots/<name>` and the object is `SimRobot` on the same
   topic.
3. **Serve the model.** A zenoh queryable returns the robot's SDF and meshes,
   which ship in its own image. A model therefore travels with the robot and is
   versioned with its firmware and parameters. **(proposed)** The queryable is
   `sim/robots/<name>/model`, returning a tarball.
4. **Spawn.** Call the world's `create` service over zenoh, with the model
   rendered from a template: name, FDM port, camera stream target. It's
   idempotent: `remove` its own name first, then `create`.
5. **Re-spawn.** Watch Gazebo's liveliness token for `/world/<name>/create`.
   When the world restarts and the token comes back, spawn again.

**Known gap:** a robot that crashes and never comes back leaves its model in the
world. Cleanup is an optional sweep, "models with no matching robot liveliness →
`remove`". It's a plain zenoh client, so it works against any world and can be a
button in the SDK SpiriConfig. If a leftover model stalls lockstep, this has to
become automatic. That's untested; see the spike list.

### Cameras

**(proposed)** ardupilot_gazebo's GStreamer camera plugin sends H.264/RTP over
UDP to the robot's address, which `sim-camera-ingress` consumes like a real
camera stream. This needs a UDP path from the world to the robot, which the
appliance's bridge provides. Robots reachable only through zenoh will need
video over zenoh instead. That isn't required for the contract.

## Networking

**Decision:** one plain docker bridge network for everything on the appliance.
Anything that has to cross machines goes through **zenoh routing**.

- The host and SDK SpiriConfig can reach every container. Discovery and the
  plugin proxy work unchanged. Docker DNS resolves `mu-1`, `world`, and so on.
- A Linux bridge forwards multicast, so zenoh peer scouting should work between
  sim robots on one appliance. Verify this in the spike.
- Only a few ports are published to the LAN: the SDK SpiriConfig UI, and the
  zenoh router (`7447`), which real robots and developer machines connect
  through. MAVLink for QGroundControl is a third. A mavlink-router on the
  appliance fans every sim robot into one endpoint, each robot with its own
  system ID. That's how the behaviour team's QGC plugin flies the swarm.
- **Real robots** run their own zenoh router, which connects to the appliance's.
  To SpiriSynq, sim and real robots are then one network. SSH to real hardware
  works as usual. The SDK SpiriConfig can't discover a real robot's UI yet. That
  needs zenoh-based SpiriConfig discovery, and is deferred.

**Rejected: ipvlan and macvlan** (giving each robot its own LAN IP). We tested
this with real Docker 29.8 ipvlan L2 containers:

- Robots could reach the router, the internet and each other.
- **The host could not reach them, and they could not reach the host.** Nor
  could a container on Docker's default bridge.

The cause is that the container's address lives in its own network namespace.
ipvlan and macvlan only deliver frames arriving *from* the wire. Frames the
host sends go straight to the NIC, and switches and access points don't
hairpin them back. A host-side shim interface fixes it, but Docker won't
manage that, and there are other drawbacks:

- one ipvlan/macvlan network per NIC;
- DHCP doesn't work, since Docker assigns addresses itself;
- macvlan doesn't work over Wi-Fi;
- ipvlan puts many IPs behind one MAC, which can trip ARP-spoofing defences.

**Rejected: host networking.** It's operationally painful, and robots would
collide on ports.

## Images and appsources

This repo builds images. **Appsource-Spiri-Simulation** says how to run them.

- **Images** go to `ghcr.io/spiri-robotics/spiridevelopmentkit/<name>`, built by
  CI from each app's source here. A `vX.Y.Z` tag publishes `X.Y.Z`, `X.Y` and
  `latest`, and `main` publishes `edge`. The workflow is the same as
  SpiriCamera's.
- **Appsource-Spiri-Simulation** is one flat appsource for everything
  simulated: world apps (`gazebo`, `zenoh-router`, `registry`), the robot
  container (`sim-robot`), and the apps that run inside a robot
  (`ardupilot-sitl`, `sim-agent`, `sim-camera-ingress`, `sim-link`). Its
  compose files pin image versions. Dependabot bumps them, so CI here needs no
  access to it.
- Each app in this repo keeps a `compose.yaml` that mirrors the appsource's,
  plus a `compose.dev.yaml` that builds from source, for local work.

The airgapped appliance ships these appsources already cloned (#146), and every
image they pin is loaded into its registry.

## Repository layout

```
apps/<app>/           one directory per appsource app:
                      compose.yaml (pulls), compose.dev.yaml (builds),
                      and the source of each image it builds
apps/gazebo/          gz/ (world image), web/ (viewer image)
compose.yaml          (planned) the whole appliance, for development
models/               robot SDF templates and meshes (shipped in robot images)
worlds/               world SDFs per KPI scenario
scenarios/            scripts that run #93/#94 and score the KPIs
examples/helipad-detector/   the #95 walkthrough, from SpiriProjectTemplates
offline/              build and load the airgapped bundle
docs/
```

SpiriConfig, SpiriSynq and SpiriOs stay in their own repos and are pinned by
version, not vendored.

## Open questions and first spike

The first spike's goal: **a plain-Python robot declares liveliness, appears in
Gazebo, and disappears when you `docker kill` it.** Along the way, answer these:

- [x] The OSRF Jetty packages were built with zenoh (`ldd libgz-transport15.so | grep zenoh`).
- [x] ardupilot_gazebo builds against Jetty, with `GZ_VERSION=jetty`.
- [x] Spawn and remove from Python over raw zenoh with gz-msgs protobufs.
- [x] gzweb renders the world through Caddy. Gazebo's websocket sends meshes
      at ~245 KB/s, so the viewer fetches them over HTTP instead
      (`apps/gazebo/gz/asset_server.py`).
- [ ] A leftover ArduPilot model with no SITL attached doesn't stall lockstep.
- [ ] Two robots, then five, in lockstep: real-time factor, and GPS correct with
      a shared `--home`.
- [x] Zenoh multicast scouting between robots on the docker bridge. Peers
      and the appliance's router (with router autoconnect) find a robot's
      host-mode router.
- [ ] A robot's SpiriConfig works nested inside the SDK SpiriConfig under
      `/plugin/mu-1/`: URLs, cookies, auth.
- [ ] Whether `--home` and the FDM index stay config, or can be read from the
      world.
