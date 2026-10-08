# SpiriDevelopmentKit

Simulate swarms of Spiri robots: a Gazebo world, simulated Spiri Mus running
ArduPilot SITL, and the same SpiriConfig apps that run on real hardware.

This repository builds the images. To install them, add
[Appsource-Spiri-Simulation](https://github.com/spiri-robotics/Appsource-Spiri-Simulation)
to SpiriConfig.

Working on the SDK itself? See [docs/architecture.md](docs/architecture.md).
Each app under `apps/` runs from source with:

```console
$ docker compose -f compose.yaml -f compose.dev.yaml up --build
```
