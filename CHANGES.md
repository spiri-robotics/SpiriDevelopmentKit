# Changes

## Unreleased

### Features

- Project generated from SpiriProjectTemplates.
- Debug map: SpiriDetect detections, in two layers. *Detections* is the points: a diamond at each
  located detection, labelled with its range or what it is and its CoT type's MIL-STD-2525 symbol
  (milsymbol), grey once stale. *Detection geometry* is how each was found: its chain up the pose
  tree, its bearing in a cone of its bearing accuracy, rings at the ends of its ± range, a camera
  box's footprint, and a faint ray for a bearing without a range. Detections are no longer drawn
  as frames, and the *Rangefinders* layer is gone: SpiriMav's rangefinder is now a detection.
- Debug map: a *Camera previews* layer, on by default, shows each gimbal camera's SpiriCamera
  preview (96 px, 1 fps) live in the gimbal's label, with or without *Frames*. A preview is
  dimmed when its frames stop.
- `mu-mavlink`: a real Mu's MAVLink. mavlink-router on the flight controller's UART, shared over
  tcp 5760 with SpiriMav, QGroundControl, and the robot's other MAVLink apps, and sent over UDP
  to a ground station's address if one is set.
  SpiriMav's gimbal 1 carries `./cameras/1/raw` (a *Gimbal cameras* setting), so the camera's
  lens and preview reach maps.

### Fixes

- Debug map: heights are drawn above sea level, not above the WGS84 ellipsoid as if it were sea
  level, so real devices no longer sit ~21 m low around Halifax. The geoid is EGM96
  (`egm96-universal`, bundled: it works offline), the same grid SpiriMav uses for SITL. A
  detection in the root frame with no vertical accuracy (an ATAK phone's report, CoT's `le`
  9999999) is drawn on the terrain if its CoT type is a ground or sea-surface one, and at the
  height it reports otherwise (an aircraft), with a faint line between that height and the
  terrain. Its label gives how far the reported height is from the terrain, and where the
  position came from (CoT's `how`: GPS, placed by hand). Labels give heights above sea level and
  WGS84.
- Debug map: the Cameras applet shows SpiriCamera's frames again. A camera now sends them on
  `transport_jpeg/@data`, not its `image` field, and runs only while something subscribes, so
  zenoh-index watches a camera's frames while a tile on it is open, as it does a Gazebo topic, and
  the camera goes idle again once every tile is closed.
- sim-camera-ingress: the sim's gimbal camera uses SpiriCamera's new camera layout, so the debug
  map sees it again. It publishes `<robot>/cameras/1/raw`, `/hud` and `/preview` from one service,
  rather than `<robot>/camera1` and a second `camera-hud` service for `<robot>/hud/camera1`; the
  HUD's widgets are now `SPIRICAMERA_HUD_WIDGETS`, and the `hud` command is gone. SpiriMav's gimbal
  1 camera is `<robot>/cameras/1/raw`. `compose.dev.yaml` takes `SPIRICAMERA_IMAGE` to build on
  an unreleased SpiriCamera.
