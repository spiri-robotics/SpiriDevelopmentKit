# The Spiri platform

What you're developing for: what's on a Spiri robot, how your code runs on
it, and how it talks to everything else. Every later page assumes this one.

## Every machine is a robot

A Spiri deployment is a set of **robots**: the Spiri Mus in the air, and
the **ground control station** the operator works from. They run the same
software. The ground control station is a robot that doesn't fly, and we
think about it differently, but nothing in the platform treats it
differently.

Every robot runs Docker and
[SpiriConfig](https://github.com/spiri-robotics/SpiriConfig). Everything a
robot does is an **app**: a directory with a `compose.yaml` in it, run by
`docker compose`. A Mu's camera, the zenoh router, the link to Spiri Cloud,
the simulation on the ground control station and your own code are all apps
of the same kind. None of them is special.

While you develop, your own machine is a ground control station.

SpiriConfig is the robot's web UI and CLI over those apps. It installs,
starts, stops and configures them. It never does anything you couldn't do
yourself, though: every button runs a `docker compose` command, and shows it.
If you can run your code with `docker compose up`, you can run it on a robot.

```console
$ spiriconfig docker up my-app --show
cd /srv/compose/my-app && docker compose -p my-app -f compose.yaml up -d
```

## Apps come from appsources

An **appsource** is a git repository
with one directory per app. There is no manifest and no registry: a
directory with a compose file in it is a published app.

```
Appsource-Example/
├── my-app/
│   └── compose.yaml
└── another-app/
    └── compose.yaml
```

Installing an app links its directory into the robot's compose directory.
Updating it is a `git merge`, so any edits the robot's operator made to it,
such as a port or a device path, survive the update. See SpiriConfig's
[appsource docs](https://github.com/spiri-robotics/SpiriConfig/blob/main/docs/appstore.md)
for the details.

**While you develop**, an app doesn't have to be in a published appsource.
SpiriConfig runs two kinds of local app directly:

- **An app directory in SpiriConfig's compose directory**: `~/spiri-apps`
  (or `/srv/compose` when SpiriConfig runs as root). Make a directory there
  with a `compose.yaml` in it and it's an app. It's yours: no appsource
  tracks it, and nothing updates it.
- **A checkout of an appsource in SpiriConfig's appsources directory**:
  `~/.local/share/spiriconfig/stores` (or `/var/lib/spiriconfig/stores`).
  Link your checkout there, and apps installed from it run your working
  tree, so your edits take effect without a commit. This repo is used that
  way; see [Getting started](getting-started.md#2-add-the-appsources).

Your app's **image** and its **appsource entry** are separate. Your
project's CI builds and publishes the image. The appsource's `compose.yaml`
pins a version of it, and Dependabot on the appsource side opens a pull
request when you tag a new release. Your project needs no access to the
appsource.

An app can also describe itself to SpiriConfig:

- **Settings.** An `x-spiri-settings` block in `compose.yaml` turns
  environment variables into a form in SpiriConfig: text, numbers, switches,
  sliders, a video device picker and so on. See
  [Settings forms](https://github.com/spiri-robotics/SpiriConfig/blob/main/docs/docker.md#settings-forms-x-spiri-settings).
- **A web page.** `spiriconfig.plugin.*` labels on a service put its web UI in
  SpiriConfig's sidebar, proxied under `/plugin/<name>/`. Any language and
  any framework works, as long as it runs behind a path prefix. See
  [Container plugins](https://github.com/spiri-robotics/SpiriConfig/blob/main/docs/container-plugins.md).

## Apps talk over zenoh and SpiriSynq

Apps on a robot and apps on every other robot, the ground control station
included, share data over [zenoh](https://zenoh.io/), a pub/sub and query protocol.
Most of that data is **SpiriSynq** objects.
[SpiriSynq](https://github.com/spiri-robotics/SpiriSynq) maps a Python
dataclass onto zenoh keys: each field is a key, assigning a field publishes
it, and every copy of the object elsewhere on the network updates to match.
Methods marked `@remote_method` can be called from any copy, and run on the
original.

```python
@dataclass
class Counter(SyncableObject):
    value: int = 0

    @remote_method()
    def reset(self, to: int = 0) -> int:
        self.value = to
        return self.value
```

Every object's topic starts with the name of the robot that publishes it,
such as `mu-1/camera1`. An app can say `./camera1` and SpiriSynq fills in the
robot's name. Objects advertise themselves, so you can find every camera, or
every object of any class, without knowing in advance where it is.

### Why not plain zenoh?

Zenoh is a transport: keys, pub/sub, queries, routing, and permissions on
keys. Its payloads are bytes, and every app decides for itself what its keys
mean. SpiriSynq is the shared answer to that, so apps from different
authors understand each other:

- **State, not just messages.** A plain subscriber that joins late hears
  nothing until the next change. A SpiriSynq object fetches its current state
  when it connects, and most of a robot's data is state: pose, mode,
  settings, battery.
- **Types that travel with the data.** Fields are typed, payloads are tagged
  with their class, and every object serves its own schema. A tool that has
  never seen your class can still read it, and check it.
- **Find things by what they are.** "Every camera on the network" is one
  discovery query, not a naming convention everyone has to know.
- **Methods.** `@remote_method` gives typed arguments, errors, timeouts and
  streamed results, instead of an RPC protocol designed per app.
- **One key per field.** Zenoh's permissions and QoS work per key, so they
  work per field: anyone may read `pose` and only the operator may write
  `mode`, and a camera's `image` goes at low priority so it never holds up
  telemetry.

It doesn't decide who may write: that's zenoh's access control, on the
robot's routers. And SpiriSynq is still plain zenoh underneath. Its
[protocol](https://github.com/spiri-robotics/SpiriSynq/blob/main/docs/protocol.md)
is specified apart from the Python library, so any language can take part.

### When to use raw zenoh

Use SpiriSynq to own an object, or to work with a few objects. **Go straight
to zenoh when you want one field across the whole network.** SpiriSynq
objects are ordinary zenoh keys, and reading them raw is supported, not a
workaround. To draw every robot's position, subscribe to `**/pose`, rather than discovering every object with a pose and
instantiating each one. It's one subscription for the whole network, and it
only matches poses, never a camera frame.

Decode what arrives with the protocol's rules: YAML, tagged with the class,
unless the encoding says otherwise. Writing raw is just as valid, with the
same care a mirror takes: send a value of the field's type, to a field the
object has.

**Networking.** Each robot runs a pair of zenoh routers, the
`zenoh-router` app. The inner one sits on a docker network called
`spirisynq`, and your app joins that network:

```yaml
services:
  app:
    image: ghcr.io/example/my-app:1.0.0
    networks:
      - spirisynq

networks:
  spirisynq:
    external: true
```

The outer router is on the robot's own network and connects to the other
robots' routers. The pair is where the robot's zenoh permissions
are enforced, so **don't run a zenoh app with `network_mode: host`**: it
would skip that check. Leave your zenoh session at its defaults (peer mode,
with scouting). On `spirisynq` it finds its router by itself.

## What's on a robot

Every robot, the ground control station included, runs these:

| App | What it gives your code |
| --- | --- |
| `zenoh-router` | The robot's zenoh routers, and the `spirisynq` network. |
| `cloud-link` | The robot's link to a Spiri Cloud organization, and its VPN (NetBird) once linked. The configuration the cloud has for this robot is in `/var/lib/spiri-cloud/cloud.env`. |

A Mu adds its hardware:

| App | What it gives your code |
| --- | --- |
| `mavlink-router` | The flight controller, over MAVLink at `tcp:127.0.0.1:5760` in the robot's network namespace. QGroundControl and any number of apps can be connected at once. |
| `camera-ingress` | The camera, published as a SpiriSynq `Camera` object (from [SpiriCamera](https://github.com/spiri-robotics/SpiriCamera)). |

To read the Spiri Cloud configuration, add the file to your service, and
treat a missing key as that feature not being set up:

```yaml
    env_file:
      - path: /var/lib/spiri-cloud/cloud.env
        required: false
```

Compose reads it when it creates the container, so your app sees a change the
next time it's brought up.

The robot's identity is in the environment SpiriConfig gives every app:
`ROBOT_NAME` (its hostname, and the prefix of its topics) and `ROBOT_SYSID`
(its MAVLink system ID).

## The simulation runs on the ground control station

The simulation is a set of ground control station apps:

| App | What it is |
| --- | --- |
| `gazebo` | The simulated world. |
| `debug-map` | A map in SpiriConfig showing the world and everything on zenoh. |
| `offline-map` | Map tiles for downloaded regions, so the map works offline. |
| `sim-robot` | A simulated Mu. Install it once per robot. |

A simulated Mu is a robot in its own right, running inside a container on
the ground control station: its own Docker daemon, its own SpiriConfig, and
the same apps as a real Mu. Its routers connect to the ground control
station's, exactly as a real Mu's would. Only the apps that stand in for
hardware are different:

| On a real Mu | In the simulation |
| --- | --- |
| The flight controller board | `ardupilot-sitl`: ArduCopter SITL, flying an airframe in Gazebo |
| `camera-ingress`, from the camera | `sim-camera-ingress`, from a camera in Gazebo |
| The airframe | `sim-agent`, which puts the airframe into the Gazebo world |

Your app can't tell the difference, and shouldn't try to. If it runs on the
simulated `mu-1`, it runs on a real Mu without changes. That's the point of
the SDK.

Simulated and real Mus can share one ground control station, and its map
shows them the same way: from what each robot publishes, not from the
simulator. See [Getting started](getting-started.md) to run it.

## Where things live

| Repository | What it is |
| --- | --- |
| [SpiriDevelopmentKit](https://github.com/spiri-robotics/SpiriDevelopmentKit) | This kit: the simulation, and these docs. |
| [SpiriProjectTemplates](https://github.com/spiri-robotics/SpiriProjectTemplates) | A copier template for a new app: Python package, Dockerfile, compose files, CI that publishes the image. |
| [SpiriConfig](https://github.com/spiri-robotics/SpiriConfig) | The robot's app manager. |
| [SpiriSynq](https://github.com/spiri-robotics/SpiriSynq) | Objects over zenoh. |
| [SpiriCamera](https://github.com/spiri-robotics/SpiriCamera) | Cameras on SpiriSynq. |
| [SpiriMav](https://github.com/spiri-robotics/SpiriMav) | Mirrors the flight controller's state onto SpiriSynq, so apps can read it without speaking MAVLink. |
| [Appsource-Spiri-Simulation](https://github.com/spiri-robotics/Appsource-Spiri-Simulation) | Released versions of the simulation's apps. |
