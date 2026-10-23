# Gazebo anywhere

**Status:** idea, not scheduled. Handy, not critical.

Pick a spot on the debug map and simulate there: Gazebo's ground and buildings
are generated from the same tiles the map draws, instead of a hand-built world
per site. Hand-built worlds like `citadel-hill` stay, as extras on top.

## Approach: world tiles

Gazebo's world is split the way the map is: web-mercator tiles, at z15 (about
900 m across at Halifax's latitude). Each tile becomes one static Gazebo model,
generated from tile sources the map already reads:

| Part | Source | Becomes |
| --- | --- | --- |
| Ground | `raster-dem` tile (Mapterhorn, as the map uses) | Grid mesh in ENU metres: fine for the visual, coarse (~64×64) for collision |
| Texture | Matching hillshade or imagery tile | The ground mesh's texture |
| Buildings | Building layer of an OpenMapTiles-schema vector tile (footprint + `render_height`) | Extruded meshes, set on the ground at each footprint's lowest point |

Since the map and Gazebo read the same tiles, they agree by construction.
Online, the vector tiles can come from OpenFreeMap (no key). Offline, both read
the PMTiles already planned for the appliance (see *Map data* in
[docs/architecture.md](docs/architecture.md)).

## Terrain agent

A zenoh client like `sim-agent`, running in the `gazebo` app so it can write
meshes where Gazebo loads them.

1. **Pick a place.** The debug map sends a "simulate here" request over zenoh.
   The agent looks up the DEM height at that point and sets the world's origin
   there, with that height as elevation (Gazebo's `set_spherical_coordinates`
   service; check it behaves on Jetty). Ground at the origin is then z = 0, so
   the robot spawns on the ground at the origin.
2. **Stream tiles.** Subscribe to the robot's pose, and keep a 3×3 block of
   tiles loaded around it, spawning with `create` and dropping far tiles with
   `remove`, as `sim-agent` does. Generated tiles are cached on a volume that
   `gazebo-assets` also serves, so the debug map can fetch them.
3. **Move.** A new pick clears the tiles, moves the origin and respawns the
   robot. With one robot (mu-1) this is a sim restart in a new place.
   `ardupilot-sitl` reads `--home` from the loaded world, so it has to re-read
   it after a move, i.e. restart.

## Problems to solve

- **Spawning stalls lockstep.** Loading a collision mesh pauses physics briefly.
  Keep collision meshes coarse and load a ring ahead of the robot.
- **Flat world.** Gazebo is flat around its origin. The Earth drops away by
  ~8 cm at 1 km and ~2 m at 5 km. Fine within a few km. Moving the origin
  mid-flight is fiddly, so range is a limit at first.
- **Seams.** Neighbouring tiles must share edge samples, or the ground cracks.
- **Ground drawn twice on the map.** `gz-world.js` would draw Gazebo's ground
  on top of MapLibre's terrain and they'd z-fight. Tag tile ground models and
  skip them while map terrain is on. Draw the buildings.
- **Double shading.** Gazebo's sun shades a hillshade texture again. Use
  imagery, a lighter hillshade, or flatter lighting.
- **Licences.** OSM data is ODbL: attribution, and share-alike on derived
  databases. Check that Mapterhorn allows redistributing derived meshes;
  Copernicus GLO-30 and NRCan HRDEM do.
- **Data quality varies.** Building heights and DEM resolution vary by place.
  Some places will look poor; nothing breaks.

## First step

A one-off generator for a single z15 tile (DEM + hillshade + buildings → glTF
model with `model.sdf`), dropped into one of the existing worlds by hand. It
shows the look, the mesh sizes and the spawn stall before any agent is built.
