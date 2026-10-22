import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Color,
  Credit,
  CustomDataSource,
  DistanceDisplayCondition,
  ExtrapolationType,
  ImageryLayer,
  JulianDate,
  LabelStyle,
  Matrix4,
  SampledPositionProperty,
  TileMapServiceImageryProvider,
  TimeInterval,
  Transforms,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Viewer,
  buildModuleUrl,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { Topic, Transport } from "gzweb";
import { GazeboOverlay } from "./gz-overlay.js";
import { Actions, Layers, startShell } from "./shell.js";

// A Cesium globe. Natural Earth II ships inside CesiumJS and is the offline
// fallback; the detailed layers stream from public tile servers until the
// appliance has its own tilesets. Nothing here talks to Cesium ion. Robots
// come from Gazebo's websocket for now; they move to SpiriSynq telemetry once
// robots publish it (see docs/architecture.md, "The map: Cesium first").
const viewer = new Viewer("map", {
  baseLayer: ImageryLayer.fromProviderAsync(
    TileMapServiceImageryProvider.fromUrl(buildModuleUrl("Assets/Textures/NaturalEarthII")),
  ),
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: false,
});
viewer.clock.shouldAnimate = true;

// Cesium's camera is tuned for the whole globe: moves coast after you let go,
// and a scroll step is never less than 20 m. At drone scale that makes fine
// positioning fight you, so stop dead and allow small steps.
const controls = viewer.scene.screenSpaceCameraController;
controls.inertiaSpin = 0;
controls.inertiaTranslate = 0;
controls.inertiaZoom = 0;
controls.minimumZoomDistance = 0.5;
// Private, and has no public setting.
controls._minimumZoomRate = 0.5;

// Relative to this page, so it works both at / and behind SpiriConfig's
// /plugin/<name>/ prefix. Caddy forwards /ws to Gazebo's websocket server.
const wsUrl = new URL("ws", window.location.href);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
const transport = new Transport();

// Gazebo's websocket sends meshes at ~245 KB/s, so fetch them over HTTP from
// the asset server (Caddy's /models) and only fall back to the websocket.
function findAsset(uri, cb) {
  // gzweb strips model:// before asking, so a bare relative path is a model path.
  const path = uri.startsWith("model://")
    ? "model/" + uri.slice("model://".length)
    : uri.startsWith("file://")
      ? "file" + uri.slice("file://".length)
      : uri.startsWith("/")
        ? "file" + uri
        : /^[a-z][a-z0-9+.-]*:/i.test(uri)
          ? null
          : "model/" + uri;
  if (!path) return transport.getAsset(uri, cb);
  // Fall back only if the fetch fails. A mesh that fails to parse would fail
  // the same way over the websocket, and a big one can drop the connection.
  fetch(new URL("models/" + path, window.location.href))
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
    .then(
      (buf) => cb(new Uint8Array(buf)),
      () => transport.getAsset(uri, cb),
    );
}

// The Gazebo layer: the world's 3D models, drawn by gzweb over the globe, plus
// Cesium labels, trails and ground outlines, so models stay findable from afar.
const overlay = new GazeboOverlay(viewer, document.getElementById("gz"), findAsset);
const gazebo = new CustomDataSource("gazebo");
viewer.dataSources.add(gazebo);

// Online tile layers, drawn over the base in this order. Both need internet.
// Esri World Imagery is free to view with attribution; check Esri's terms
// before shipping it. OSM's tile servers are for light use only.
function tiles(url, credit, show) {
  const layer = new ImageryLayer(
    new UrlTemplateImageryProvider({ url, maximumLevel: 19, credit: new Credit(credit, true) }),
    { show },
  );
  viewer.imageryLayers.add(layer);
  return layer;
}
const layers = new Layers();
layers.add(
  "satellite",
  "Satellite",
  tiles(
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    "Imagery © Esri, Maxar, Earthstar Geographics",
    true,
  ),
);
layers.add("osm", "OpenStreetMap", tiles("https://tile.openstreetmap.org/{z}/{x}/{y}.png", "© OpenStreetMap contributors", false));
layers.add("gazebo", "Gazebo", {
  get show() {
    return gazebo.show;
  },
  set show(on) {
    gazebo.show = overlay.show = on;
  },
});

// Everything else on screen is an applet; see shell.js and applets/.
startShell(viewer, { viewer, layers, actions: new Actions(), gazebo, home: () => origin && resetView() });

// Gazebo poses are metres in the world's ENU frame, anchored to the globe by the
// world's <spherical_coordinates>. Gazebo doesn't send those over the websocket,
// so read them from the world SDF through the asset server.
let enuToFixed = null;
let origin = null;

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
  origin = Cartesian3.fromDegrees(num("longitude_deg"), num("latitude_deg"), num("elevation"));
  enuToFixed = Transforms.eastNorthUpToFixedFrame(origin);
  overlay.setOrigin(enuToFixed);
}

function toFixed(p) {
  const local = new Cartesian3(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
  return Matrix4.multiplyByPoint(enuToFixed, local, new Cartesian3());
}

function resetView() {
  viewer.trackedEntity = undefined;
  viewer.camera.flyToBoundingSphere(new BoundingSphere(origin, 300), { duration: 1 });
}

// Map markers for Gazebo models, keyed by name; ids map back to names for
// deletions. A model with plane visuals (the ground) is outlined, so the
// world's extent shows on the map. Anything else gets a label, a trail, and a
// point once it's too far away to see.
const models = new Map();
const planes = new Map();
const idToName = new Map();
const TRAIL_SECONDS = 120;
const lastPrune = new Map();

// Plane visuals, as ENU rectangles. Rotations are ignored: ground planes are
// level and axis-aligned.
function planeVisuals(model) {
  const out = [];
  for (const link of model.link ?? []) {
    for (const visual of link.visual ?? []) {
      const size = visual.geometry?.plane?.size;
      if (!size) continue;
      const at = (k) => (model.pose?.position?.[k] ?? 0) + (link.pose?.position?.[k] ?? 0) + (visual.pose?.position?.[k] ?? 0);
      const [x, y, z, hx, hy] = [at("x"), at("y"), at("z"), (size.x ?? 0) / 2, (size.y ?? 0) / 2];
      out.push([
        { x: x - hx, y: y - hy, z },
        { x: x + hx, y: y - hy, z },
        { x: x + hx, y: y + hy, z },
        { x: x - hx, y: y + hy, z },
      ]);
    }
  }
  return out;
}

function addModel(model) {
  idToName.set(model.id, model.name);
  overlay.addModel(model);
  if (models.has(model.name) || planes.has(model.name)) return;
  const rects = planeVisuals(model);
  if (rects.length) {
    planes.set(
      model.name,
      rects.map((corners) =>
        gazebo.entities.add({
          name: model.name,
          polygon: {
            hierarchy: corners.map(toFixed),
            perPositionHeight: true,
            material: Color.LIGHTGREEN.withAlpha(0.15),
            outline: true,
            outlineColor: Color.LIGHTGREEN,
          },
        }),
      ),
    );
    return;
  }
  const position = new SampledPositionProperty();
  position.forwardExtrapolationType = ExtrapolationType.HOLD;
  position.backwardExtrapolationType = ExtrapolationType.HOLD;
  position.addSample(JulianDate.now(), toFixed(model.pose?.position));
  models.set(
    model.name,
    gazebo.entities.add({
      name: model.name,
      position,
      point: {
        distanceDisplayCondition: new DistanceDisplayCondition(300, Number.MAX_VALUE),
        pixelSize: 10,
        color: Color.ORANGE,
        outlineColor: Color.BLACK,
        outlineWidth: 1,
      },
      label: {
        text: model.name,
        font: "13px system-ui, sans-serif",
        style: LabelStyle.FILL_AND_OUTLINE,
        outlineWidth: 3,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -12),
      },
      path: { leadTime: 0, trailTime: TRAIL_SECONDS, width: 2, material: Color.ORANGE.withAlpha(0.7) },
    }),
  );
}

function removeModel(name) {
  overlay.removeModel(name);
  planes.get(name)?.forEach((e) => gazebo.entities.remove(e));
  planes.delete(name);
  const entity = models.get(name);
  if (!entity) return;
  if (viewer.trackedEntity === entity) viewer.trackedEntity = undefined;
  gazebo.entities.remove(entity);
  models.delete(name);
  lastPrune.delete(name);
}

function setPose(pose) {
  overlay.setPose(pose);
  // dynamic_pose/info also carries links, named relative to their model; only
  // top-level models are drawn.
  const entity = models.get(pose.name);
  if (!entity) return;
  const now = JulianDate.now();
  entity.position.addSample(now, toFixed(pose.position));
  // Poses arrive at 30 Hz; every so often drop what the trail no longer draws.
  if (JulianDate.secondsDifference(now, lastPrune.get(pose.name) ?? now) > 10) {
    const cutoff = JulianDate.addSeconds(now, -TRAIL_SECONDS, new JulianDate());
    entity.position.removeSamples(new TimeInterval({ start: new JulianDate(0, 0), stop: cutoff }));
    lastPrune.set(pose.name, now);
  } else if (!lastPrune.has(pose.name)) {
    lastPrune.set(pose.name, now);
  }
}

const status = document.getElementById("status");
function showStatus(text, up) {
  status.textContent = text;
  status.className = up ? "up" : "down";
}

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

transport.getConnectionStatus().subscribe(async (s) => {
  if (s !== "ready") {
    showStatus(s === "connected" ? "loading world…" : s === "disconnected" ? "connecting…" : s, false);
    if (s === "disconnected" || s === "error") {
      for (const name of [...models.keys(), ...planes.keys()]) removeModel(name);
      idToName.clear();
      overlay.clear();
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
  showStatus(`connected: ${world}`, true);
  resetView();

  // Ready means the first scene message has arrived; it lists the models and
  // lights so far.
  const scene = transport.sceneInfo$.getValue();
  scene?.model?.forEach(addModel);
  scene?.light?.forEach((light) => overlay.addLight(light));
  if (scene?.ambient) overlay.setAmbient(scene.ambient);

  const available = new Set(transport.getAvailableTopics().map((t) => t.topic));
  // gzweb's subscribe throws on a topic Gazebo doesn't advertise.
  const subscribe = (name, cb) => available.has(name) && transport.subscribe(new Topic(name, cb));
  subscribe(`/world/${world}/scene/info`, (msg) => msg?.model?.forEach(addModel));
  subscribe(`/world/${world}/scene/deletion`, (msg) =>
    msg?.data?.forEach((id) => removeModel(idToName.get(id))),
  );
  subscribe(`/world/${world}/dynamic_pose/info`, (msg) => msg?.pose?.forEach(setPose));
});
