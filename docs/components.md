# Components

The pieces the platform is built from, and what each one is for.

## SpiriSynq

Apps on a robot, and on every other robot, need to share state: where the
robot is, what its camera sees, what mode it's in. Without a common way to do
that, every app invents its own message format, and apps from different
authors can't understand each other.
[SpiriSynq](https://github.com/spiri-robotics/SpiriSynq) is that common way:
state synchronization.

An app defines its data as a typed object, and every other app that wants it
gets a live copy: change a field and every copy updates, and a copy that
connects late starts from the current state. Objects describe their own
types, so any app can find "every camera" or "every position" on the network
and read them without having been written for them, and methods on an object
can be called from any copy.

## SpiriConfig

A robot's operator has to install, configure and update the software on it,
often in the field and without a developer to hand.
[SpiriConfig](https://github.com/spiri-robotics/SpiriConfig) is the robot's
web UI and command-line tool for that. It installs apps from appsources,
starts and stops them, turns their settings into forms, and gives apps with
a web page a place in its sidebar.

It's built so that you never depend on it. Every app is a plain
`docker compose` project, and every button runs a `docker compose` command
and shows it. If SpiriConfig went away, everything it manages would keep
working, and you would already know how to manage it by hand.

## SpiriGateway

*In development: not on a robot yet.*

Inside a robot, apps share everything with each other. The link off the
robot is different: a radio has little bandwidth to spare, and not everything
a robot knows should leave it, or be changeable by whoever is on the other end.
[SpiriGateway](https://github.com/spiri-robotics/SpiriGateway) is the
robot's firewall and bandwidth control for that link.

It decides which data leaves the robot and what outside peers may change,
keeps traffic within the link's budget so a camera feed can't starve
telemetry, and shows what's actually crossing the link. SpiriGateway is
source-available under the Business Source License, not open source.

## SpiriMav

[SpiriMav](https://github.com/spiri-robotics/SpiriMav) puts the aircraft
into the shared world. Everything a robot sees is placed in the world through
the robot itself: a camera is mounted on a gimbal, the gimbal on the robot,
and the robot on the earth. SpiriMav publishes that last link, the robot's
own position, and with it its mode, battery, home and gimbals. Without it, a
detection has no place on the map and a camera can't mark home in its
picture.

The rest follows from the aircraft being one more object on the platform.
Apps work with a robot, not an autopilot, so they don't care whether it runs
ArduPilot, PX4 or something else. The vehicle becomes a shared resource:
many operators and apps can watch it and command it (arm, take off, go
somewhere, point the gimbal), under the same access control as everything
else, so seeing a robot and flying it are separate permissions. And every
robot looks the same, however large the swarm. The flight controller's own
failsafes stay in charge, watching the operator's ground station, not
SpiriMav.

## SpiriCamera

Many apps want a robot's camera: the operator's video feed, a detector, a
recorder. Only one of them can open the device, and each would otherwise
deal with its own drivers, formats and streaming.
[SpiriCamera](https://github.com/spiri-robotics/SpiriCamera) opens the
camera once, whether it's a USB camera, a network stream or a file, and
publishes it as a camera object every app can share.

A camera knows what it's mounted on and what its lens is, so its picture can
be related to the world: a point on the map can be found in the frame. It draws heads-up displays over the video,
including markers on things in the world such as home or a detection, and
streams to a browser at a rate that follows the link.

## SpiriDetect

*In development: parts of it work today, the whole doesn't yet.*

Detections are the platform's common language. Spiri is middleware, and
this is the layer it's middleware at. A robot finds things in many ways: a
box around something in the camera picture, a rangefinder hit, a contact
reported from a TAK device. Without a shared form, everything that wants to
know what's out there has to understand every sensor and system that might
have seen it. With one, anything that finds something publishes a detection,
anything that wants to know reads detections, and neither needs to know
about the other.

A detection is a thing in the world: where it is, how accurate that is, how
confident the producer is, and who produced it. It moves and updates as the
robot learns more, and goes away when the thing does. A robot's own position
is published the same way, so maps, camera overlays and bridges to other
systems such as TAK handle everything alike.
