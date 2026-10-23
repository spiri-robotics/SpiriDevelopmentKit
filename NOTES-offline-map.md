# Offline map

**Status:** in progress.

The appliance is airgapped, so the map can't stream tiles from the internet.
`offline-map` is an app that serves map tiles over zenoh from PMTiles files on
the appliance, and a SpiriConfig plugin for choosing which regions are
downloaded. The debug map, and later the operator's view, finds its layers by
SpiriSynq discovery and fetches tiles through a MapLibre custom protocol.

It has three parts:

| Part | What it is |
| --- | --- |
| Transport | One `MapLayer` SpiriSynq object per layer, and a zenoh queryable for its tiles |
| Data | PMTiles extracts, cut from public planet builds by region |
| UI | A SpiriConfig plugin listing what's downloaded, adding and removing regions |

## Why PMTiles, not OsmAnd

OsmAnd's `.obf` carries map drawing, search and routing in one file, read by
OsmAnd's Java library. But MapLibre can't draw it: the server would have to
render raster tiles with OsmAnd's renderer, a heavy dependency, in OsmAnd's
style. PMTiles holds MVT and raster tiles MapLibre draws as they are, and the
server only has to look tiles up. Sizes are about the same: Nova Scotia is
191 MB of unpacked `.obf` against 141 MB of PMTiles at z14.

Offline routing, if we want it, is a second dataset: a Valhalla or GraphHopper
graph built from the region's `.osm.pbf`.

## Layers

| Layer | Source | Kind | Licence |
| --- | --- | --- | --- |
| `osm` | Protomaps daily planet build (`build.protomaps.com/<date>.pmtiles`), z0–15 | vector, Protomaps basemap schema | ODbL: "© OpenStreetMap contributors" |
| `terrain` | Mapterhorn planet (`download.mapterhorn.com/planet.pmtiles`), z0–12 | `raster-dem`, terrarium webp | per mapterhorn.com/attribution |

`terrain` is one DEM the map uses twice: drawn as hillshade, and as terrain
height, which is what puts the Gazebo world on the real ground. MapLibre does
the hillshading in the page.

`osm` is published as three objects drawn from the same tiles: `osm` (fills
and lines), `osm-labels` and `osm-buildings` (its `buildings` layer, extruded
by `height`/`min_height`). Protomaps' buildings are nearly all at z15 only (a
z14 tile in Halifax had 9 against 1,331 in one z15 child), so `osm` regions
default to z15. The Protomaps schema isn't the OpenMapTiles one the debug
map's online 3D buildings use (`source-layer: building`); the
`@protomaps/basemaps` package has styles for it. Its fonts and sprites
(`protomaps/basemaps-assets`, ~15 MB) are in the image.

## Slicing

Nobody downloads a planet. `pmtiles extract` reads the planet with HTTP range
requests and writes only the tiles in a box or polygon, in seconds. Measured
against the builds of 2026-10-23:

| Slice | `osm` | `terrain` |
| --- | --- | --- |
| World, z0–6 | 45 MB | 278 MB |
| World, z0–8 | 560 MB | 3.2 GB |
| Nova Scotia box (`-66.4,43.3,-59.6,47.1`) | 141 MB at z14, 264 MB at z15 | 49 MB at z11, 196 MB at z12 |
| Citadel Hill, ~12 × 11 km (`-63.65,44.6,-63.5,44.7`) | 6.3 MB at z15 | 1.6 MB at z12 |

- **Base.** `osm` to z6 ships in the image, so the map is never blank. No
  world `terrain`: it costs more than it's worth.
- **Regions.** Each region is one `.pmtiles` file per layer, a box (or
  polygon) at a chosen max zoom. A test site is a few MB, a province a few
  hundred. Named regions (provinces, countries) can come later as polygon
  presets.
- **Past a file's max zoom, its tiles are made from its deepest ones**
  (overzoom, below), so the base shows everywhere at every zoom, coarsely.
- **Each file records where it came from** (planet URL and build date) in a
  `.json` sidecar next to it. Protomaps deletes old daily builds, so a region can't always be
  re-cut from the same build.

## Transport

```python
@dataclass(frozen=True)
class Region:
    name: str
    bounds: list[float]  # W, S, E, N
    minzoom: int
    maxzoom: int
    source: str  # planet URL it was cut from


@dataclass
class MapLayer(SyncableObject):
    title: str = ""
    role: Literal["map", "labels", "buildings", "terrain", "imagery"] = "map"
    kind: Literal["raster", "raster-dem", "vector"] = "raster"
    format: Literal["png", "jpg", "webp", "pbf"] = "png"
    encoding: Literal["terrarium", "mapbox"] | None = None  # raster-dem only
    tile_size: int = 256
    minzoom: int = 0
    maxzoom: int = 0
    bounds: list[float] = ...  # union of the regions
    attribution: str = ""
    regions: list[Region] = ...  # newest first, then the base
    tile_key: str = ""  # "<layer path>/tiles/{z}/{x}/{y}"
    glyphs: str = ""  # labels: "<...>/fonts/{fontstack}/{range}.pbf"
    sprites: str = ""  # labels: "<...>/sprites/v4", plus a Protomaps flavor
```

(`offline-map/server/map_layer.py`.)

Objects live at `<base topic>/offline-map/<name>`. The fields are a MapLibre
source spec plus a role, what to draw from it; the page finds them with
`**/sr_metadata/MapLayer`. Objects with the same `tile_key` are one source:
the page makes one MapLibre source per key, so tiles cross zenoh once, and
each object adds its own style layers and its own toggle. Fonts and sprites
are served the same way as tiles, at `<base topic>/offline-map/assets/**`.

**Tiles are out of band.** SpiriSynq RPC replies are always YAML, so a tile
method would send base64. Instead the server declares a plain queryable at
`<path>/tiles/*/*/*` and replies with the tile's bytes as they are in the file,
with a zenoh encoding of `image/webp`, `image/png`, `image/jpeg`, or
`application/vnd.mapbox-vector-tile` (with `;gzip` when the file stores tiles
gzipped, as Protomaps does). The page decompresses with `DecompressionStream`,
so tiles cross the websocket compressed. A missing tile gets no reply. `tiles`
is a name SpiriSynq doesn't know about, so no field or method may be called
that. `tile_key` names the template so the convention is discoverable.

**Many files, one source.** A layer's server answers each tile from the first
file that has it: regions newest first, then the base. MapLibre sees one source
per layer however many regions are installed, and overlapping regions are
harmless.

**Overzoom.** One source has one maxzoom, but regions are cut to different
ones (and the base stops at z6), and MapLibre doesn't fall back to a parent
when a tile is missing: it draws nothing. So when no file has a tile, the
server makes it from the first file with a tile above it (`overzoom.py`):
vector tiles' geometries rescaled into the child, features outside it
dropped; raster tiles cropped and scaled up nearest-neighbour (so DEM heights
aren't blended) and re-encoded losslessly. ~40 ms a tile, cached. Features
aren't clipped, so deep overzoom of large polygons trips MapLibre's "Geometry
exceeds allowed extent" warning, and it clamps them; proper clipping would
fix that.

**In the page.** `maplibregl.addProtocol("zenoh", …)` maps
`zenoh://<tile key>` to a `zenoh.query()`. Tiles are fetched once each, when
MapLibre asks, so this doesn't have the problem of subscribing to big streams.

## UI

"Offline maps", a SpiriConfig plugin: the `manager` service, the same image
running `manager.py`. It lists what's installed per layer, with sizes and
sources, and outlines each region on a map drawn from the same files over
HTTP, so what you see is what's offline. Draw a box (or take the current
view), pick layers and max zoom, see the size from a dry run, then download;
cuts run one at a time with progress. Upload a `.pmtiles` cut elsewhere (its
tile type is checked against the layer); delete a region. Extracting needs the
internet, so on an airgapped appliance regions come in by upload.

The manager only touches files in the shared volume; the tile server picks up
changes on its next rescan (5 s). The page has no build step: MapLibre,
`@protomaps/basemaps` and its fonts and sprites are fetched into the image at
build time and served as they are. Its map is the offline `osm` with labels,
so it works airgapped, with Esri imagery as an online option for picking a
region.

SpiriConfig's proxy re-streams request bodies chunked, without a
Content-Length, so the manager reads chunked bodies.

## Plan

1. **Tile server.** `offline-map/` app: a Python service that reads
   `/data/<layer>/*.pmtiles`, publishes a MapLayer per layer and answers tile
   queries. Base `osm` z0–6 baked into the image. Done (`server.py`, with
   `tiles.py` shared with the manager); `server.py add` cuts a region from
   the command line.
2. **Debug map.** Discover MapLayers, add the zenoh protocol, Protomaps style
   for `osm`, hillshade and terrain from `terrain`. The internet layers stay
   for when nothing is installed. Done (`debug-map/web/offline-map.js`):
   labels with fonts and sprites over zenoh, extruded buildings, and the
   offline `terrain` as the map's terrain height, in place of Mapterhorn's
   online tiles, whenever it's on zenoh.
3. **Plugin.** The UI above. Done, and tried through SpiriConfig's proxy:
   estimate, download, a 45 MB upload, delete. Bounding boxes only; polygon
   presets later.

## Open questions

- Is the base baked into the image, or fetched by the plugin on first start?
  Baking is the only way it reaches an airgapped appliance without an upload,
  but it adds 45 MB to the image.
- Mapterhorn's planet stops at z12 (~30 m). Mapterhorn also has higher
  resolution regional files; check whether they cover Canada.
- Protomaps' terms for pulling daily builds from an appliance, vs mirroring
  one build ourselves.
