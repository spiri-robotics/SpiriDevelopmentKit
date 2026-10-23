import { Map as MapLibre, NavigationControl, TerrainControl, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre finds its worker next to its own module, which bundling breaks;
// Vite bundles the worker on its own and gives its URL.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { Topic, Transport } from "gzweb";
import * as gzServices from "./gz-services.js";
import { GazeboWorld } from "./gz-world.js";
import { Actions, Entities, Layers, startShell } from "./shell.js";
import { Zenoh } from "./zenoh.js";

setWorkerUrl(workerUrl);

// A MapLibre map, with terrain. Imagery and terrain stream from public tile
// servers until the appliance has its own tile server; offline, the map is a
// plain background with the Gazebo layer on it. Robots come from Gazebo's websocket for now; they
// move to SpiriSynq telemetry once robots publish it (see docs/architecture.md,
// "The map: MapLibre").
//
// MapLibre draws a frame only when something changes: a camera move, a tile,
// or a layer asking (gz-world.js asks when a model visibly moves).
//
// Esri World Imagery is free to view with attribution; check Esri's terms
// before shipping it. OSM's tile servers are for light use only. Terrain is
// Mapterhorn's; hillshading reads the same tiles through its own source,
// which renders better than sharing terrain's. 3D buildings are OSM's, as
// OpenFreeMap's OpenMapTiles vector tiles.
const raster = (url, attribution) => ({ type: "raster", tiles: [url], tileSize: 256, maxzoom: 19, attribution });
const dem = { type: "raster-dem", url: "https://tiles.mapterhorn.com/tilejson.json" };
const map = new MapLibre({
  container: "map",
  style: {
    version: 8,
    sources: {
      satellite: raster(
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        "Imagery © Esri, Maxar, Earthstar Geographics",
      ),
      osm: raster("https://tile.openstreetmap.org/{z}/{x}/{y}.png", "© OpenStreetMap contributors"),
      terrain: dem,
      hillshade: dem,
      openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
      planes: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#1b2026" } },
      { id: "satellite", type: "raster", source: "satellite" },
      { id: "osm", type: "raster", source: "osm", layout: { visibility: "none" } },
      { id: "hillshade", type: "hillshade", source: "hillshade", paint: { "hillshade-shadow-color": "#473B24" } },
      {
        id: "buildings",
        type: "fill-extrusion",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 14,
        filter: ["!=", ["get", "hide_3d"], true],
        // Off at first: OSM has the Gazebo world's real buildings too.
        layout: { visibility: "none" },
        paint: {
          "fill-extrusion-color": ["to-color", ["get", "colour"], "#c8c4bc"],
          "fill-extrusion-height": ["get", "render_height"],
          "fill-extrusion-base": ["get", "render_min_height"],
          "fill-extrusion-opacity": 0.9,
        },
      },
      // Ground planes, outlined so the world's extent shows.
      { id: "planes-fill", type: "fill", source: "planes", paint: { "fill-color": "#90ee90", "fill-opacity": 0.15 } },
      { id: "planes-line", type: "line", source: "planes", paint: { "line-color": "#90ee90", "line-width": 1.5 } },
    ],
    terrain: { source: "terrain", exaggeration: 1 },
    sky: {},
  },
  center: [0, 20],
  zoom: 1.5,
  // Drone scale: close in, and steep enough to look along the ground.
  maxZoom: 24,
  maxPitch: 85,
  canvasContextAttributes: { antialias: true },
  attributionControl: { compact: true },
});
// For the browser console.
window.map = map;
map.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
map.addControl(new TerrainControl({ source: "terrain", exaggeration: 1 }), "top-right");

// The Gazebo layer: the world's 3D models (see gz-world.js), labelled so they
// stay findable from afar. Meshes come over HTTP from the asset server, not
// the websocket.
const world3d = new GazeboWorld();
const entities = new Entities();

// Layers by id, for the Layers applet.
const styleLayer = (...ids) => ({
  get show() {
    return map.getLayoutProperty(ids[0], "visibility") !== "none";
  },
  set show(on) {
    for (const id of ids) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  },
});
const layers = new Layers();

// Zenoh, through Caddy's /zenoh; connects when an applet first uses it.
const zenohUrl = new URL("zenoh", window.location.href);
zenohUrl.protocol = zenohUrl.protocol === "https:" ? "wss:" : "ws:";
const zenoh = new Zenoh(zenohUrl.href);

// Changing the world, for applets, over zenoh: any model moves through
// Gazebo's set_pose; a robot resets through its sim-agent, which respawns it.
const gz = {
  world: null,

  // Moves a model to lngLat, keeping its height above the map's terrain, so
  // a landed robot stays landed and a flying one flies on. 30 cm higher,
  // so where the terrain and the world's own ground disagree it drops onto
  // the ground rather than into it. Velocities are kept.
  async moveTo(name, lngLat) {
    const pose = world3d.poseOf(name);
    if (!gz.world || !pose) throw new Error(`${name} isn't in the world`);
    const ground = (at) => (map.getTerrain() ? map.queryTerrainElevation(at) : null);
    const [from, to] = [ground(world3d.lngLatOf(name)), ground(lngLat)];
    const climb = from != null && to != null ? to - from : 0;
    const { x, y } = lngLatToEnu(lngLat);
    await gzServices.setPose(zenoh, gz.world, name, { ...pose, position: { x, y, z: pose.position.z + climb + 0.3 } });
  },

  // Back to its spawn pose, at rest. Only robots have a sim-agent.
  async respawn(name) {
    const [reply] = await zenoh.query(`@sdk/sim-agent/${name}/respawn`, { timeoutMs: 20000 });
    if (!reply) throw new Error(`no sim-agent answers for ${name}`);
    if (reply instanceof Error) throw reply;
  },
};

// Everything else on screen is an applet; see shell.js and applets/.
startShell({ map, layers, actions: new Actions(), entities, zenoh, gz, home: () => origin && resetView() });

// Gazebo poses are metres in the world's ENU frame, anchored to the map by the
// world's <spherical_coordinates>. Gazebo doesn't send those over the websocket,
// so read them from the world SDF through the asset server.
let origin = null; // [lng, lat]
// ENU metres to [lng, lat] and back, near the origin.
let enuToLngLat = null;
let lngLatToEnu = null;

async function loadOrigin(world) {
  const r = await fetch(new URL(`models/model/${world}.sdf`, window.location.href));
  if (!r.ok) throw new Error(`world SDF ${world}.sdf: HTTP ${r.status}`);
  // Drop comments first: Gazebo accepts "--" inside one, strict XML doesn't.
  const text = (await r.text()).replace(/<!--[\s\S]*?-->/g, "");
  const sdf = new DOMParser().parseFromString(text, "application/xml");
  const sc = sdf.querySelector("world > spherical_coordinates");
  if (!sc) throw new Error(`${world}.sdf has no <spherical_coordinates>`);
  const num = (tag) => Number(sc.querySelector(tag)?.textContent ?? 0);
  if (num("heading_deg") !== 0) console.warn("heading_deg is ignored; the world is drawn as if it were 0");
  origin = [num("longitude_deg"), num("latitude_deg")];
  // Over a world's few kilometres, a flat-earth step from the origin is
  // well under a pixel off.
  const mPerDegLat = 111320;
  const mPerDegLng = mPerDegLat * Math.cos((origin[1] * Math.PI) / 180);
  enuToLngLat = (p) => [origin[0] + (p?.x ?? 0) / mPerDegLng, origin[1] + (p?.y ?? 0) / mPerDegLat];
  lngLatToEnu = ([lng, lat]) => ({ x: (lng - origin[0]) * mPerDegLng, y: (lat - origin[1]) * mPerDegLat });
  world3d.setOrigin(origin, num("elevation"));
}

function resetView() {
  entities.track(null);
  map.flyTo({ center: origin, zoom: 16.5, pitch: 55, bearing: 0, duration: 1000 });
}

// Following: keep the followed model at the centre as it moves, until the
// map is dragged.
entities.addEventListener("track", () => {
  const at = entities.tracked && world3d.lngLatOf(entities.tracked.id);
  // Zoom on the followed model, not the pointer. enable() ignores its
  // options while already enabled.
  for (const zoom of [map.scrollZoom, map.touchZoomRotate]) {
    zoom.disable();
    zoom.enable({ around: at ? "center" : undefined });
  }
  if (at) map.easeTo({ center: at, duration: 500 });
  for (const label of document.querySelectorAll(".gz-label")) {
    label.classList.toggle("following", label.dataset.entity === entities.tracked?.id);
  }
});
map.on("dragstart", () => entities.track(null));

// Models keyed by name; ids map back to names for deletions. A model with
// plane visuals (the ground) is outlined; anything else is an entity with a
// label.
const planes = new Map(); // name -> GeoJSON features
const idToName = new Map();

// Plane visuals, as ENU rectangles. Rotations are ignored: ground planes are
// level and axis-aligned.
function planeVisuals(model) {
  const out = [];
  for (const link of model.link ?? []) {
    for (const visual of link.visual ?? []) {
      const size = visual.geometry?.plane?.size;
      if (!size) continue;
      const at = (k) => (model.pose?.position?.[k] ?? 0) + (link.pose?.position?.[k] ?? 0) + (visual.pose?.position?.[k] ?? 0);
      const [x, y, hx, hy] = [at("x"), at("y"), (size.x ?? 0) / 2, (size.y ?? 0) / 2];
      out.push([
        { x: x - hx, y: y - hy },
        { x: x + hx, y: y - hy },
        { x: x + hx, y: y + hy },
        { x: x - hx, y: y + hy },
        { x: x - hx, y: y - hy },
      ]);
    }
  }
  return out;
}

function showPlanes() {
  map.getSource("planes").setData({ type: "FeatureCollection", features: [...planes.values()].flat() });
}

function label(name) {
  const e = document.createElement("div");
  e.className = "gz-label";
  e.dataset.entity = name;
  e.textContent = name;
  return e;
}

function addModel(model) {
  idToName.set(model.id, model.name);
  if (entities.get(model.name) || planes.has(model.name)) return;
  const rects = planeVisuals(model);
  if (rects.length) {
    world3d.addModel(model);
    planes.set(
      model.name,
      rects.map((ring) => ({
        type: "Feature",
        properties: { name: model.name },
        geometry: { type: "Polygon", coordinates: [ring.map(enuToLngLat)] },
      })),
    );
    showPlanes();
    return;
  }
  world3d.addModel(model, label(model.name));
  entities.add({ id: model.name, name: model.name, kind: "model" });
}

function removeModel(name) {
  if (!name) return;
  world3d.removeModel(name);
  if (planes.delete(name)) showPlanes();
  const entity = entities.get(name);
  if (entity) entities.remove(entity);
}

function setPose(pose) {
  // dynamic_pose/info also carries links, by entity id; world3d places both.
  if (!world3d.setPose(pose)) return;
  const tracked = entities.tracked;
  // jumpTo stops whatever the camera is doing, a rotate or zoom gesture
  // included, so leave it be until that's over: both turn about the centre,
  // where the model already is, and the next pose catches up.
  if (tracked && tracked.id === pose.name && !map.isMoving()) map.jumpTo({ center: world3d.lngLatOf(tracked.id) });
}

const status = document.getElementById("status");
function showStatus(text, up) {
  status.textContent = text;
  status.className = up ? "up" : "down";
}

// Relative to this page, so it works both at / and behind SpiriConfig's
// /plugin/<name>/ prefix. Caddy forwards /ws to Gazebo's websocket server.
const wsUrl = new URL("ws", window.location.href);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
const transport = new Transport();

// Connect, and reconnect whenever the socket drops. A failed socket reports
// "error" then "disconnected"; the timer makes that one retry, not two.
let retry = null;
let firstTry = true;
function reconnect() {
  if (retry) return;
  retry = setTimeout(() => {
    retry = null;
    transport.connect(wsUrl.href);
  }, firstTry ? 0 : 2000);
  firstTry = false;
}

map.on("load", () => {
  map.addLayer(world3d);
  world3d.setTerrain(!!map.getTerrain());
  map.on("terrain", () => world3d.setTerrain(!!map.getTerrain()));
  layers.add("satellite", "Satellite", styleLayer("satellite"));
  layers.add("osm", "OpenStreetMap", styleLayer("osm"));
  layers.add("hillshade", "Hillshade", styleLayer("hillshade"));
  layers.add("buildings", "3D buildings", styleLayer("buildings"));
  layers.add("gazebo", "Gazebo", {
    get show() {
      return world3d.show;
    },
    set show(on) {
      world3d.show = on;
      styleLayer("planes-fill", "planes-line").show = on;
    },
  });

  transport.getConnectionStatus().subscribe(async (s) => {
    if (s !== "ready") {
      showStatus(s === "connected" ? "loading world…" : s === "disconnected" ? "connecting…" : s, false);
      if (s === "disconnected" || s === "error") {
        gz.world = null;
        for (const name of [...entities.values.map((e) => e.id), ...planes.keys()]) removeModel(name);
        idToName.clear();
        world3d.clear();
        reconnect();
      }
      return;
    }
    const world = transport.getWorld();
    try {
      await loadOrigin(world);
    } catch (e) {
      showStatus(`no georeference: ${e.message}`, false);
      return;
    }
    gz.world = world;
    showStatus(`connected: ${world}`, true);
    resetView();

    // Ready means the first scene message has arrived; it lists the models so
    // far. Its lights aren't used: gz-world.js lights the models.
    const scene = transport.sceneInfo$.getValue();
    scene?.model?.forEach(addModel);

    const available = new Set(transport.getAvailableTopics().map((t) => t.topic));
    // gzweb's subscribe throws on a topic Gazebo doesn't advertise.
    const subscribe = (name, cb) => available.has(name) && transport.subscribe(new Topic(name, cb));
    subscribe(`/world/${world}/scene/info`, (msg) => msg?.model?.forEach(addModel));
    subscribe(`/world/${world}/scene/deletion`, (msg) =>
      msg?.data?.forEach((id) => removeModel(idToName.get(id))),
    );
    subscribe(`/world/${world}/dynamic_pose/info`, (msg) => msg?.pose?.forEach(setPose));
  });
});
