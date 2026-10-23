# SpiriDevelopmentKit

Simulate Spiri robots: a Gazebo world, simulated Spiri Mus running ArduPilot
SITL that you fly from QGroundControl, and the same SpiriConfig apps that run
on real hardware.

Everything here is a SpiriConfig app, one per top-level directory. This repo
builds their images, and is itself an app store you can link into SpiriConfig
to run them from source. Released versions install from
[Appsource-Spiri-Simulation](https://github.com/spiri-robotics/Appsource-Spiri-Simulation).

| App | What it is |
| --- | --- |
| [`gazebo`](gazebo/) | The simulated world, with a choice of worlds. |
| [`debug-map`](debug-map/) | A globe in SpiriConfig showing the world and everything on zenoh. |
| [`sim-robot`](sim-robot/) | A simulated Mu: its own docker daemon and SpiriConfig. |
| [`ardupilot-sitl`](ardupilot-sitl/) | Inside a robot: its flight controller, ArduCopter SITL. |
| [`sim-agent`](sim-agent/) | Inside a robot: puts its airframe into the world. |
| [`sim-camera-ingress`](sim-camera-ingress/) | Inside a robot: its gimbal camera, published on SpiriSynq. |

To run it, start with [docs/getting-started.md](docs/getting-started.md). For
how it fits together and why, see [docs/architecture.md](docs/architecture.md).
