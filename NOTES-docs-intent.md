# Docs vs reality

The docs in `docs/` describe the platform as we intend it to be. This is the
list of places where the code doesn't match yet. Fix the code, then delete
the entry.

## Ground control station

- **The GCS is a robot.** The docs say the developer's machine is a ground
  control station running the same apps as a Mu. Today its zenoh router is
  `Appsource-Spiri-Simulation/zenoh-router`, a world router with router
  autoconnect, not the Mu's `zenoh-router` app. architecture.md still
  describes an "appliance" running the simulation.
- **cloud-link (with its netbird) on the GCS.** platform.md lists them on every
  robot, the GCS included. Today they only run inside a sim Mu. *(Assumption:
  confirm the GCS links to Spiri Cloud too.)*
- **The map draws robots from what they publish.** It draws them from
  Gazebo's topics today.

## Developing apps

- **Both dev routes inside a sim Mu.** platform.md says an app can be a
  directory in the compose dir, or come from an appsource checkout linked
  into the appsources dir. On the GCS both work. Inside a sim Mu only the
  SDK checkout is mounted (`SDK_SOURCE`), so a developer's own app can't get
  into `mu-1`.
- **The template's app can't reach zenoh.** SpiriProjectTemplates' generated
  `compose.yaml` doesn't join `spirisynq`, and the project doesn't depend on
  SpiriSynq.

## A real Mu

- **A real Mu runs SpiriConfig and apps.** SpiriOs doesn't package
  SpiriConfig yet.
- **`ROBOT_NAME` and `ROBOT_SYSID` in every app's environment.** Set by
  sim-robot; a comment says a real Mu's OS sets them too. Unconfirmed.
- **MAVLink and zenoh in one app.** mavlink-router is reached at
  `tcp:127.0.0.1:5760`, which needs host networking, but zenoh apps must stay
  on `spirisynq`. Either SpiriMav (MAVLink state on SpiriSynq) is how apps
  read the vehicle and runs on every Mu, or the router needs an address on
  `spirisynq`. Undecided.
