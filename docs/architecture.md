# Architecture

How the SpiriDevelopmentKit is put together, and why. This is for people working
*on* the SDK; people working *with* it should start at the [README](../README.md).

Status: one simulated Mu flies in Gazebo and connects to QGroundControl; see
[getting-started.md](getting-started.md) to run it. Anything marked
**(proposed)** is not built yet, and is a starting point rather than a settled
interface.

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
├── gazebo            Stock Gazebo Jetty (zenoh backend) + ardupilot_gazebo.
├── debug-map         MapLibre view of the sim and of zenoh, its bridge and index.
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
| `sim-camera-ingress` | Video from the Gazebo gimbal camera (see [Cameras](#cameras)) | `camera-ingress` from the real camera |
| `sim-agent` | Joins the robot to the simulated world (below) | nothing |
| `sim-link` (optional) | netem on the robot's link: a simulated radio | the real radio |

Everything else is the same app on both: mavlink-router, zenoh, and the
operator's own code, such as the helipad detector. Moving from sim to hardware
(#97) means swapping the first column for the third and changing nothing else.

The image is `sim-robot/`: stock `docker:dind` plus SpiriConfig, with an
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

On its first boot a robot installs and starts the apps every Mu runs, listed in
`ROBOT_APPS` as `<store>/<app>`. Released, that's only the router. In
development (`compose.dev.yaml`) it's also `sim-agent`, `ardupilot-sitl` and
`sim-camera-ingress` from the mounted checkout, built inside the robot (`ROBOT_DEV`). After that
they're ordinary installed apps, brought back by the inner dockerd's restart
policy. Appsource-Spiri-Mu doesn't exist yet, so the router comes from
Appstore-Spiri_development for now.

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

- A **service** such as `/world/citadel-hill/create` → a zenoh **queryable** at
  `@/<partition>@/world/citadel-hill/create`. Requests and replies are raw protobuf
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
- uses **port `9002 + 10·index`**, with SITL started as `-I <index>`. With one
  robot the index is 0. With several it has to come from the robot's
  config, set by whatever launched the swarm.

With `<lock_step>` on, the slowest robot sets the real-time factor for the
whole world. Rendered cameras make this worse. It's the main performance risk,
and it gets measured before the scenarios are built on top.

### sim-agent

`sim-agent` does everything needed to put its robot in a world. It has no
counterpart on the world side.

1. **Find the world.** Any world: the agent spawns into whichever world's
   `create` token appears, so it needs no world setting. SITL needs no
   coordination with it either. `ardupilot-sitl` reads its `--home` from the
   world itself (`gazebo-assets` serves the loaded world at `/world.sdf`), so
   home and the world's `<spherical_coordinates>` can't disagree, and a
   robot's GPS fix follows from its spawn position.
2. **Announce.** Declare a liveliness token and publish a SpiriSynq object with
   the robot's model reference, content hash, and spawn pose. **(proposed)** The
   token goes at `sim/robots/<name>` and the object is `SimRobot` on the same
   topic.
3. **Serve the model.** A zenoh queryable returns the robot's SDF and meshes,
   which ship in its own image. A model therefore travels with the robot and is
   versioned with its firmware and parameters. **(proposed)** The queryable is
   `sim/robots/<name>/model`, returning a tarball.
4. **Spawn.** Call the world's `create/blocking` service over zenoh, with the
   model rendered from a template: name, pose, FDM port (camera stream target
   later). It's idempotent: `remove` its own name first, then `create`. The
   messages are hand-encoded protobuf, so the agent needs neither Gazebo nor
   protobuf libraries.
5. **Re-spawn.** Watch Gazebo's liveliness token for `/world/<name>/create`.
   When the world restarts and the token comes back, spawn again.

**Known gap: a leftover model freezes the world.** In lock-step, once the
ArduPilotPlugin has heard from a SITL it waits for that SITL's next packet
before every physics step, with no timeout. If SITL stops while its model is
in the world, the world stops: physics, sensors and every `blocking` service,
including the `remove` that would clean the model up. A restarted SITL
resumes it (SITL starts without waiting for a GCS for this reason), but a
robot that goes away for good leaves the world frozen. The fix has to come
from outside lock-step: remove the model through a path that doesn't need the
world to step, or patch the plugin to time out.

### Cameras

A robot's **Gimbal camera** setting (`ROBOT_GIMBAL`, on `sim-robot`) gives it
ardupilot_gazebo's 3-axis `gimbal_small_3d` with a camera, placed as their
`iris_with_gimbal` places it. Two apps read the setting from the robot's
environment:

- `sim-agent` adds the gimbal to the model it spawns (`gimbal.sdf`), with its
  topics under the robot's name: the joints listen on
  `/model/<name>/gimbal/cmd_{roll,pitch,yaw}`, and the camera publishes
  `/model/<name>/gimbal/image`, 640×480 at 10 Hz by default.
- `ardupilot-sitl` adds ardupilot_gazebo's `gazebo-iris-gimbal.parm`, so
  mount 1 drives SERVO9–11, which the ArduPilotPlugin turns into joint
  commands. The gimbal is pointed the way a real one is, over MAVLink.

The picture never leaves zenoh. `sim-camera-ingress` is SpiriCamera's
camera-ingress, the app a real Mu runs, plus a `gz://` source
(`sim-camera-ingress/ingress/gz_source.py`) that subscribes to the camera's gz
topic and decodes `gz.msgs.Image` by hand. It publishes JPEG frames on
SpiriSynq like any other camera. There's no UDP path from the world to the
robot and no H.264 step, so robots reachable only through zenoh get video
too. Raw frames cost about 9 MB/s through the router at the default size.

gz-transport only publishes a topic that has a subscriber, and learns of
subscribers from their liveliness tokens, so the `gz://` source declares
one. A camera nobody subscribes to isn't rendered, so the camera costs nothing
until its ingress runs.

**Known gap: removed models leave tokens behind.** Gazebo doesn't undeclare
a removed model's sensor and controller tokens, so its topics still look
published until the world restarts.

## The map: MapLibre

**Decision:** the operator's view of the swarm is a MapLibre GL map. It draws
robots from what they publish on SpiriSynq, not from Gazebo, and it is the same
view for sim and real robots. Gazebo's world geometry is a three.js layer on
that map. The gzweb viewer it replaced is gone, and so is the CesiumJS globe
that came between.

**Why not Cesium.** Cesium drew every frame whether or not anything changed,
and each frame was expensive: profiled in Firefox on the citadel world, about
11 ms of JavaScript per frame at 60 fps: 70% of a CPU core, and steady GPU
load, for a still scene. The cost was per draw call (about 220 a frame, from several passes
over a 57-primitive scene, at ~50 µs of JavaScript each), not effects, so
turning features off couldn't fix it; request-render mode only halved it while
poses streamed. MapLibre draws only on a change, and three.js draws the world
in one pass at a few µs per draw. On the same world the map draws a handful
of frames while idle, against Cesium's 60 a second. The cost is the true
globe: MapLibre is a flat map with pitch, which suits a swarm over a few
kilometres.

**Today (interim).** The map is its own app, `debug-map/`, separate from the
simulation so either can be restarted or replaced alone. The page is
`debug-map/web/`. Robots don't publish telemetry over zenoh yet, so it draws
models from Gazebo's websocket instead (scene, deletions, poses) and anchors
them with the world's `<spherical_coordinates>`, read from the world SDF via
`gazebo-assets`. The 3D world is a MapLibre custom layer drawn by three.js in
the map's own GL context, so it shares the map's depth buffer
(`gz-world.js`). Mesh visuals are glTF: `gazebo-assets` converts Gazebo's
meshes with assimp on first request and caches them, matching Gazebo's axis
and unit handling (`gazebo/gz/asset_server.py`). Simple shapes are three.js
geometry, SDF colours override mesh materials as in Gazebo, and model,
nested-model and link poses come from the websocket by entity id. A pose
asks for a frame only if it moved visibly (0.1 mm): Gazebo sends every pose
at 30 Hz, and physics jitters a resting robot by microns. Gazebo's lights are
dropped; a fixed overhead light shows the models. Each model has a DOM label
kept over it, which is also what's clicked to select it. Ground planes are
outlined on the map instead of drawn. gzweb is used only for its websocket
client. (An earlier version drew gzweb's three.js scene in a canvas over the
globe; it couldn't depth-test against the map, so it covered whatever was
drawn above the models. A custom layer doesn't have that problem.)
Esri World Imagery, OpenStreetMap, hillshading and OSM 3D buildings
(OpenFreeMap's vector tiles) stream from the internet as layers that can be
switched on and off, with the Gazebo layer, over Mapterhorn terrain (toggled
by the map's terrain button). Offline, the map is a plain background with the
world on it. It's a stand-in until robot telemetry and the appliance's own
tile server exist.

**Applets.** The map is the only thing always on screen, apart from the
connection status. Every tool is an applet: one file in `web/applets/`, found
at build time, listed by title under its group in a sidebar, opened into a
floating window and unmounted when closed (`shell.js`). There may be hundreds,
so the sidebar is labels rather than icons, and its search box (`/` or Ctrl+K)
matches titles, groups and keywords. Tools about one entity should register *actions* instead,
which show up in its right-click menu and the Inspector. A one-off debug tool
then takes no space until someone points at the thing it's for. Map layers are
a registry applets can add to, separate from the windows. Later, other
containers could supply applets by URL through a SpiriConfig-style label; they
would run with full trust in the page.

**Zenoh in the page.** Applets reach zenoh directly through `ctx.zenoh`
(`web/zenoh.js`). It wraps zenoh-ts, which talks over a websocket (Caddy's
`/zenoh`) to `zenoh-ws`, a zenoh-ts remote-api bridge that runs from the
`debug-map` image and connects to the router as a client. The bridge, the
zenoh-ts package and the router are all on 1.8.0, and the bridge and the
package must match. The session opens when an applet first needs it,
reconnects by itself, and declares its subscriptions again afterwards. The
bridge doesn't restrict anything. Anyone who can load the page can read and
write every key, so the page is only as private as SpiriConfig's login.

**Don't subscribe to `**` from the page.** Everything a subscription matches
crosses the websocket, and one camera stream is enough to starve it. At 24 MB/s
of camera frames, a page subscribed to `**` received a few frames a second and
its telemetry froze. Publishers weren't slowed. Whole-network views ask
`zenoh-index` (`debug-map/index/index.py`) instead. It subscribes to `**` next to the
router and keeps each key's latest sample, count, rate and a short text preview.
Pages poll `@sdk/index?since=<rev>` for what changed, and fetch one key's value
from `@sdk/index/value`. With the same 24 MB/s that is about 1 KB/s per page,
plus the value of whatever key is selected. `@` keys are only matched exactly,
so this traffic never appears in `**`. The *Zenoh keys* applet is built on it:
a filterable tree of every key (`web/path-tree.js`, reusable for any `/`-path
list), with deleted keys struck through for a minute.

Gazebo's topics are in the tree too, under `@/<partition>@/`, though `**`
never sees them (`index/gz.py`). The index lists them from their publishers'
liveliness tokens, with the message type as the encoding. It doesn't
subscribe to them all, because gz-transport only publishes a topic that has a
subscriber: subscribing to everything would render every camera. A topic is
received only while it's selected. The page asks `@sdk/index/watch` to keep
it coming every few seconds, and the index subscribes as a gz node would and
lets go 10 s after the last ask. Its messages are decoded to JSON with
gz-msgs' definitions, built into the image, with long byte fields shown as
their size.

The *Cameras* applet (`web/applets/cameras.js`) lists every SpiriSynq object
whose classes include `Camera`, found by its own `**/sr_metadata` discovery,
so it covers real and simulated cameras alike. An open camera's `image` is
fetched from the index rather than subscribed to, for the same reason as
above. Each tile asks for the next frame only after drawing the last one, at
a rate picked on the tile, so a slow link shows fewer frames instead of
falling behind. WebRTC (SpiriCamera's `webrtc_offer`) would be smoother, but
a browser can't reach a camera inside a robot's inner docker network.

The index also runs SpiriSynq discovery (`**/sr_metadata`) every 5 s and lists
the objects it finds in the summary, since an object's schema and methods are
queryables that `**` never sees. *Zenoh keys* draws those objects in their own
colour. Selecting one asks the object for its `sr_object_schema` and shows its
fields and methods (`web/synq-schema.js`), and the methods can be called from
there (`web/synq.js`, the SpiriSynq RPC protocol), generators included. The index
also fetches each object's schema (again when its classes or owning node
change) and checks every value put under the object against it
(`index/check.py`). Values that don't fit, and keys that aren't fields of the
object, are shown in red with the reason. Values over 1 MB aren't checked.

Why the robots and not Gazebo:

- **Sim and real look the same.** A sim robot's position comes from SITL
  through the same mavlink-router and zenoh path as a real Mu's. The view can't
  tell them apart, and doesn't need to. Nothing about it changes for #97.
- **Mixed swarms.** Sim and real robots on one network appear on one map. A
  viewer per backend would need two screens.
- **It shows what the operator would see.** Gazebo shows ground truth. The map
  shows each robot's own estimate, so a bad `--home` or a GPS fault is visible
  on the map instead of hidden by the simulator.

### Layers

| Layer | Source | Sim | Real |
| --- | --- | --- | --- |
| Terrain and imagery | local tilesets on the appliance (below) | yes | yes |
| Robots | SpiriSynq state per robot **(proposed)** | yes | yes |
| World geometry | Gazebo world, exported to glTF / 3D Tiles | yes | no |
| Sim-only entities | targets and intruders, from Gazebo poses | yes | no |

**Placement.** The Gazebo world's `<spherical_coordinates>` is its anchor on
the map (`citadel-hill.sdf` is at 44.64750, -63.58028, ENU). Every robot's `--home`
must equal it. That is already a requirement for GPS. The world layer is placed
at that origin, ENU metres scaled into Web Mercator there, so world geometry
and robot positions line up only if both are right. With terrain on, the world
sits at its `<elevation>` above sea level, the altitude its robots report from;
without, on the flat map at sea level. A world's `<elevation>` should be the
map's DEM height at its origin, or the world floats over the terrain or sinks
into it: citadel-hill's is 65.4 m, Mapterhorn's height for its parade square.

**World geometry.** The world's static models are exported once, per world, to
glTF and served next to it. **(proposed)** This is done at image build time
from the same SDF and meshes the world container already ships, and served by
`gazebo-assets`. Terrain is the reverse case. A world meant to look like a real
place takes its heightmap *from* the same DEM the map uses, so Gazebo and
the map agree on where the ground is.

**Sim-only entities.** Targets and intruder drones aren't robots and publish
nothing. A small bridge subscribes to Gazebo's pose topic over zenoh and
republishes the entities it is told about, tagged as simulated. **(proposed)**
It is a plain zenoh client like `sim-agent`, and lives with the world.

**Robot state.** This needs one agreed SpiriSynq object per robot: position,
attitude, mode and battery, at a few Hz. Whether the Mu already publishes one,
or MAVLink to QGC is the only source today, is an open question. The object is
the actual shared piece. The map is one consumer of it.

### Map data

The appliance is airgapped (#92), so the map can't stream anything. Bing and
Google imagery and Google's Photorealistic 3D Tiles forbid offline caching, so
they're out.

**Usable, and free:**

| Data | Resolution | Licence | Notes |
| --- | --- | --- | --- |
| MapLibre GL JS | n/a | BSD-3-Clause | Self-hosted, no token. |
| Natural Earth II imagery | ~1 km | public domain | A small world-wide raster pyramid: the offline base, once it's built. |
| Copernicus DEM GLO-30 | 30 m, global | free, commercial use allowed | Needs a source notice and a liability disclaimer. GLO-10 is not public. |
| NRCan HRDEM | 1–2 m, lidar, most of southern Canada | Open Government Licence – Canada | The right terrain for Canadian test sites. CDEM is its legacy predecessor. |
| Sentinel-2 cloudless (EOX) | 10 m | depends on year | 2016 is CC BY 4.0. Some later years were non-commercial. Check the year before shipping. |
| OpenStreetMap | vector | ODbL | Buildings and roads, extruded to 3D Tiles if we want them. Share-alike applies to derived databases. |

The map's base layer is Natural Earth II. Each scenario site adds a
high-resolution patch over it: Copernicus or HRDEM terrain, Sentinel-2 imagery,
and optional OSM buildings, clipped to a few km around the site.

**Tooling (proposed).** Terrain becomes Terrarium (or Mapbox terrain-RGB)
PNG tiles, MapLibre's `raster-dem`, with `rio-rgbify` or GDAL. Imagery becomes
an XYZ pyramid with `gdal2tiles`. Both can be packed into PMTiles files, one
per site, served as static files by Caddy. Turning terrain on raises the
ground under the Gazebo layer, which today sits at sea level, so the layer has
to follow it. The site bundles are built once, online, and shipped in the
offline bundle (`offline/`).

**Attribution.** Copernicus, EOX and OSM all require credits on the map. Each
tileset ships with its credit string, which the viewer shows.

## Networking

**Decision:** one plain docker bridge network for everything on the appliance.
Anything that has to cross machines goes through **zenoh routing**.

- The host and SDK SpiriConfig can reach every container. Discovery and the
  plugin proxy work unchanged. Docker DNS resolves `mu-1`, `world`, and so on.
- A Linux bridge forwards multicast, so zenoh peer scouting should work between
  sim robots on one appliance. Verify this in the spike.
- Only a few ports are published to the LAN: the SDK SpiriConfig UI, and the
  zenoh router (`7447`), which real robots and developer machines connect
  through. MAVLink for QGroundControl is a third. Today the one robot
  publishes its SITL's TCP 5760 directly. **(proposed)** With more robots, a
  mavlink-router on the appliance fans every sim robot into one endpoint,
  each robot with its own system ID. That's how the behaviour team's QGC
  plugin flies the swarm.
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
- **This repo is itself an appsource**, for development. Each app is a
  top-level directory with a compose file, which is all SpiriConfig needs to
  find it. Symlink the checkout into SpiriConfig's store directory, and apps
  installed from it run your working tree. See
  [getting-started.md](getting-started.md#developing-the-sdk).

The airgapped appliance ships these appsources already cloned (#146), and every
image they pin is loaded into its registry.

## Repository layout

```
<app>/               one top-level directory per app, so the repo is an
                      appsource: compose.yaml (pulls), compose.dev.yaml
                      (builds), and the source of each image it builds.
                      Any other top-level directory must not have a
                      compose file, or SpiriConfig lists it as an app.
gazebo/               gz/ (world image), served by gazebo and gazebo-assets
debug-map/            web/ (MapLibre map and zenoh-ws), index/ (zenoh-index)
ardupilot-sitl/       sitl/ (ArduCopter SITL image), installed inside a robot
sim-agent/            agent/ (spawns the robot's airframe), installed inside a robot
sim-camera-ingress/   ingress/ (SpiriCamera + gz:// source), installed inside a robot
sim-robot/            robot/ (docker-in-docker + SpiriConfig image)
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
- [x] gzweb renders the world through Caddy (since replaced by the map).
      Gazebo's websocket sends meshes at ~245 KB/s, so the viewer fetches them
      over HTTP instead
      (`gazebo/gz/asset_server.py`).
- [x] A leftover ArduPilot model with no SITL attached doesn't stall lockstep.
      **It does**, and freezes the whole world; see sim-agent's known gap.
- [ ] Two robots, then five, in lockstep: real-time factor, and GPS correct with
      a shared `--home`.
- [x] Zenoh multicast scouting between robots on the docker bridge. Peers
      and the appliance's router (with router autoconnect) find a robot's
      host-mode router.
- [ ] A robot's SpiriConfig works nested inside the SDK SpiriConfig under
      `/plugin/mu-1/`: URLs, cookies, auth.
- [x] Whether `--home` and the FDM index stay config, or can be read from the
      world. Home is read from the world. The index is 0 while there is one
      robot.
- [ ] What position/state the Mu publishes on SpiriSynq today, and whether it
      is enough for the map.
- [ ] Terrarium terrain tiles from Copernicus GLO-30 for one site, served
      offline to MapLibre, with the Gazebo layer still on the ground.
- [ ] A world's static models export to glTF and line up on the globe at its
      `<spherical_coordinates>`.
