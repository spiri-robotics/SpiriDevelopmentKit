# SpiriDevelopmentKit

Simulate Spiri robots: a Gazebo world, simulated Spiri Mus running ArduPilot
SITL that you fly from QGroundControl, and the same SpiriConfig apps that run
on real hardware.

Everything here is a SpiriConfig app, one per top-level directory. This repo
builds their images, and is itself an appsource you can link into SpiriConfig
to run them from source. Released versions install from
[Appsource-Spiri-Simulation](https://github.com/spiri-robotics/Appsource-Spiri-Simulation).

| App | What it is |
| --- | --- |
| [`gazebo`](gazebo/) | The simulated world, with a choice of worlds. |
| [`debug-map`](debug-map/) | A globe in SpiriConfig showing the world and everything on zenoh. |
| [`offline-map`](offline-map/) | Map tiles over zenoh from downloaded regions, for maps offline. |
| [`sim-robot`](sim-robot/) | A simulated Mu: its own docker daemon and SpiriConfig. |
| [`ardupilot-sitl`](ardupilot-sitl/) | Inside a robot: its flight controller, ArduCopter SITL. |
| [`mavlink-router`](mavlink-router/) | Inside a robot: its MAVLink endpoint, sharing the flight controller between QGroundControl and the robot's apps. Not simulated; here until Appsource-Spiri-Mu exists. |
| [`spirimav`](spirimav/) | Inside a robot: SpiriMav, the robot on SpiriSynq, with its state, its frames (origin, home, gimbals, region of interest) and commands. The same app a real Mu runs; its image comes from the SpiriMav repo. |
| [`sim-agent`](sim-agent/) | Inside a robot: puts its airframe into the world. |
| [`sim-camera-ingress`](sim-camera-ingress/) | Inside a robot: its gimbal camera, published on SpiriSynq. |
| [`cloud-link`](cloud-link/) | Inside a robot: links it to a Spiri Cloud organization, fetches its configuration, joins the VPN it configures (NetBird), and serves its camera to the cloud's Frigate. Not simulated; here until Appsource-Spiri-Mu exists. |

To run it, start with [docs/getting-started.md](docs/getting-started.md). For
how it fits together and why, see [docs/architecture.md](docs/architecture.md).
