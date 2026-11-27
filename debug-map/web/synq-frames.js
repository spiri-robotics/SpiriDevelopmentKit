import { SampleKind } from "@eclipse-zenoh/zenoh-ts";
import { MercatorCoordinate } from "maplibre-gl";
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Camera,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Euler,
  GreaterDepth,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OctahedronGeometry,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
  Vector4,
  WebGLRenderer,
} from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { parse } from "yaml";
import { takColour, takIcon } from "./cot-symbol.js";
import "./synq-frames.css";

// Every SpiriSynq Position on zenoh, as a tree of frames on the map: a MapLibre
// custom layer, drawn by three.js like gz-world.js.
//
// Positions are found by discovery (`**/sr_metadata`, classes including
// Position) and rehydrated for their parents and links; poses and mounts then
// come live from two subscriptions, `**/pose` and `**/mount`, which never
// match a camera's image however many cameras there are. A key whose topic
// isn't a known Position (a nested `…/gimbal/pose`, say) is ignored. A
// SpiriCamera camera is a Position, on what carries it, but isn't a frame
// here: it's drawn as its carrier's view.
//
// Each frame with a pose is a 3D arrow along its x axis: forward for a body
// in FRD, so it shows heading and pitch, and north for a NED frame. A fin on
// its top shows roll. Arrows are a fixed size on screen, and each is joined
// to its parent (relative_to) by a line between the two. Each has a label at
// it, its topic, a map label (map-labels.js), so labels from every layer stay
// clear of each other. Clicking the label opens it: its class, heading, pitch and
// roll against local NED, mount (offset and angles in the parent's frame),
// links, and the pose's 90% accuracy, also drawn as a cylinder around the
// frame. Clicking again closes it.
//
// A point -- a pose without an orientation, such as a region of interest --
// has a place but no facing: it's a ball, with no arrow, fin or angles.
//
// Poses are ECEF, so heights are above the WGS84 ellipsoid; they're drawn above
// sea level, as the map's terrain and the Gazebo world are, by taking off the
// geoid's height there (EGM96: about -21 m at Halifax). A detection in the
// root frame with no vertical accuracy (an ATAK phone's report) has a height
// nobody vouches for. If its CoT type puts it on the ground or the sea it's
// drawn on the terrain, otherwise (an aircraft) at the height it reports. A
// faint line joins that point to the other one: how far the reported height is
// from the terrain. Its label gives both, and where the position came from
// (CoT's how).
// Without terrain, the lowest frame sits on the
// flat map.
//
// Scene coordinates are ENU metres from an anchor near the frames, so floats
// hold at any zoom; the anchor moves when the view goes far from it.
//
// Camera coverage, a layer of its own: a frame whose `cameras` link to
// SpiriCamera cameras (a gimbal) gets, for each camera with a known lens
// (Camera.intrinsics), its view as a pyramid along the frame's x axis --
// image right along y, down along z -- with the lens's own angles, in bands,
// nearest first, each from where the last ends and capped at its far end.
// The bands are the viewer's, set in the Layers applet and kept in this
// browser (see `bands`): each either a target -- an object `size` metres
// across that must span `pixels` of the frame, so its range follows the
// lens, at the image centre and the lens's native size -- or a fixed
// distance. They start as Johnson's criteria for recognition (4 line pairs,
// 8 px, across the critical dimension) of a person and a car.
//
// Unlike the frames, the pyramids are depth-tested against the map: drawn
// before this layer clears depth, so the terrain, 3D buildings and Gazebo's
// models hide what's behind or under them, and a view ends where it meets
// them.
//
// A camera's lens comes once from its sr_rehydrate, when a frame first links
// to it, then live from `**/intrinsics`.
//
// Camera previews, a layer of their own, on by default: each placed frame's
// cameras' SpiriCamera previews (`<base>/preview` beside the `raw` or `hud` it
// links; 96 px high, 1 fps) in its label, under its topic, shown whether the
// frames are or not. Each is fetched from zenoh-index, which is kept watching
// it, as the Cameras applet does, so only the latest frame crosses the
// websocket. One with no new frame for PREVIEW_STALE_MS is dimmed, not hidden.
//
// Detections: every SpiriDetect Detection (a Position whose classes include
// Detection, at `<host>/detections/<producer>/<id>` or
// `<host>/detections/self`), with its own fields (DET_FIELDS) from its
// rehydrate, then live from `*/detections/**`. Not drawn as frames, but in
// two layers of their own: the points, and how they were found.
//
// The points ("Detections"): a diamond at each detection with a pose, a
// fixed size on screen, with its label. Like the frames, over the map, so
// terrain doesn't hide a thing on the ground. A detection without a pose
// isn't located, so it isn't here: never a stand-in point.
//
// How they were found ("Detection geometry"), each detection showing what it
// knows and no more, depth-tested against the map as coverage is:
//
// - Its relative_to chain up the pose tree, frame to frame to the root (a
//   rangefinder hit, its gimbal, the robot), as lines, so where the point
//   came from shows without every frame on.
// - A plain Detection with a pose (a node's report of itself) has its 90%
//   accuracy drawn around it, as an open frame's is.
// - With a ray (a BearingDetection), the bearing from the sensor's place.
//   With a range, the beam's ± range in a cone (beamRings, as a rangefinder's
//   below, from range_accuracy, bearing_accuracy and the ray's own accuracy)
//   out to the diamond: a faint cone from a base at the sensor as wide as its
//   own position error, to two rings at the ends of the ± range. Without
//   one, there's no place, only where to look: a faint ray, in a cone of
//   bearing_accuracy if it's known, out to the sensor's `max` if it has one
//   (a rangefinder that saw nothing within it), else LOOK_M. That length is
//   the drawing's, not the detection's, so the cone has no end ring.
// - A BoxDetection's angular footprint is a pyramid down its ray, out to its
//   range, capped there, or uncapped to LOOK_M without one.
//
// A detection past its stale time (time + stale_after, against this
// browser's clock) is drawn grey, not hidden: "we lost it" is worth seeing.
// Its label is one value: a range, if it has one, else what it is (label,
// else its producer: CoT types are codes); opened, its fields, including any its
// subclass adds (a rangefinder's status, min and max). Labels show with the
// points, and an unlocated detection's, at its sensor, with the geometry.

const DISCOVER_MS = 5000;
const ARROW_PX = 48; // arrow length on screen
const REANCHOR_M = 20000;
const COLOR = 0xbb9af7;
const FIN_COLOR = 0xe6dcff;
const OPEN_COLOR = 0xffb86c; // an open frame's arrow, and its accuracy
const CONE_COLOR = 0x3a9bff;
const MARKER_PX = 10; // a detection's diamond's size on screen
// Saturated, so they stand out on grey, green and brown ground and from the
// frames' lavender, coverage's blue and an open frame's orange.
const DET_COLOR = 0xff2d55;
const STALE_COLOR = 0x8c3a4c; // darker and duller, still visible on light ground
const LOOK_M = 1000; // how far a bearing without a range is drawn
const TICK_MS = 1000; // how often staleness and ages are looked at again
const FACE_OPACITY = 0.08;
const EDGE_OPACITY = 0.6;
const PREVIEW_MS = 1000; // how often a preview is fetched: SpiriCamera's preview is 1 fps
const PREVIEW_WATCH_MS = 4000; // well inside zenoh-index's WATCH_FOR, 10 s
const PREVIEW_STALE_MS = 5000; // a preview with no new frame for this long is dimmed

// A camera's preview, its thumbnail stream: SpiriCamera publishes
// `<base>/raw`, `hud` and `preview`, and a gimbal links whichever it carries.
// Null for a camera not named that way, which has no preview.
const previewOf = (camera) => (/\/(raw|hud|preview)$/.test(camera) ? camera.replace(/[^/]+$/, "preview") : null);

// Coverage bands: { name, mode: "pixels", size, pixels } or
// { name, mode: "distance", range }. Johnson's recognition is 4 line pairs,
// 2 px each, across the target's critical dimension: a standing person's
// 0.75 m, and NATO's 2.3 m vehicle.
export const JOHNSON_BANDS = [
  { name: "person", mode: "pixels", size: 0.75, pixels: 8 },
  { name: "car", mode: "pixels", size: 2.3, pixels: 8 },
];
const BANDS_KEY = "coverage-bands";

// A band's range in metres through a lens, or null if it has none: for a
// target, where its size spans `pixels` at the image centre, where one
// pixel subtends 1/f radians.
export function bandRange(lens, band) {
  const range = band.mode === "distance" ? band.range : (band.size * Math.sqrt(lens.fx * lens.fy)) / band.pixels;
  return Number.isFinite(range) && range > 0 ? range : null;
}

function loadBands() {
  try {
    const saved = JSON.parse(localStorage.getItem(BANDS_KEY));
    if (Array.isArray(saved)) return saved;
  } catch {}
  return structuredClone(JOHNSON_BANDS);
}

// A lens's half-angle tangents from its principal point: left, right, up, down.
const tangents = (l) => [l.cx / l.fx, (l.width - l.cx) / l.fx, l.cy / l.fy, (l.height - l.cy) / l.fy];
const fovs = (l) => {
  const [left, right, up, down] = tangents(l).map(Math.atan);
  return [left + right, up + down].map((r) => (r * 180) / Math.PI);
};

// A unit arrow along +x (forward) from the frame's origin, marked by a ball,
// with a fin on its top (-z, up in FRD) so roll shows. three.js's round
// shapes are along +y, so turned.
const alongX = (g, x) => g.rotateZ(-Math.PI / 2).translate(x, 0, 0);
const ARROW = [
  alongX(new CylinderGeometry(0.035, 0.035, 0.7, 12), 0.35),
  alongX(new ConeGeometry(0.1, 0.3, 20), 0.85),
  new SphereGeometry(0.07, 16, 8),
];
const FIN = new BoxGeometry(0.4, 0.015, 0.16).translate(0.3, 0, -0.1);
const POINT = new SphereGeometry(0.15, 20, 10);
const DIAMOND = new OctahedronGeometry(0.15);
const UNTURNED = new Quaternion();

// !Link and !RootFrame are kept apart; other tags load as plain values.
const TAGS = [
  { tag: "!Link", resolve: (s) => ({ link: s }) },
  { tag: "!RootFrame", resolve: (s) => ({ root: s }) },
];
const load = (text) => parse(text, { customTags: TAGS, logLevel: "error" });
// A loaded !Link's topic, or null. Not just `x.link`: every string has a
// link() method.
const linkOf = (x) => (typeof x?.link === "string" ? x.link : null);

function toPose(v) {
  if (!v?.offset) return null;
  const o = v.offset;
  const q = v.orientation;
  return {
    offset: new Vector3(o.x ?? 0, o.y ?? 0, o.z ?? 0),
    // null for a point
    q: q ? new Quaternion(q.x ?? 0, q.y ?? 0, q.z ?? 0, q.w ?? 1).normalize() : null,
    accuracy: v.accuracy ?? null,
  };
}

// WGS84, as SpiriSynq's Offset.to_geodetic: [lat°, lon°, height above the ellipsoid].
const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
function geodetic({ x, y, z }) {
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  for (let i = 0; i < 10; i++) {
    const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + E2 * n * Math.sin(lat), p);
  }
  const h = p * Math.cos(lat) + z * Math.sin(lat) - A * Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return [(lat * 180) / Math.PI, (Math.atan2(y, x) * 180) / Math.PI, h];
}

// A local level frame's orientation in ECEF, from its axes: NED's or ENU's.
function levelFrame(lat, lon, axes) {
  const [phi, lam] = [(lat * Math.PI) / 180, (lon * Math.PI) / 180];
  const [sp, cp, sl, cl] = [Math.sin(phi), Math.cos(phi), Math.sin(lam), Math.cos(lam)];
  const north = new Vector3(-sp * cl, -sp * sl, cp);
  const east = new Vector3(-sl, cl, 0);
  const down = new Vector3(-cp * cl, -cp * sl, -sp);
  const basis = axes === "ned" ? [north, east, down] : [east, north, down.clone().negate()];
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(...basis));
}

// Roll, pitch and yaw in degrees, ZYX as SpiriSynq's Orientation.to_euler.
function angles(q) {
  const e = new Euler().setFromQuaternion(q, "ZYX");
  return [e.x, e.y, e.z].map((r) => (r * 180) / Math.PI);
}

// A detection's own fields, besides its pose and mount: SpiriDetect's, and
// those its subclasses add that the map shows (a rangefinder's).
const DET_FIELDS = [
  "cot_type", "label", "confidence", "time", "stale_after", "course", "speed",
  "azimuth", "elevation", "range", "range_accuracy", "bearing_accuracy", "ray",
  "angular_width", "angular_height", "box",
  "status", "min", "max", "how", "team", "colour",
];

// A detection's topic's parts: <host>/detections/<producer>/<id>, or
// <host>/detections/self.
function detParts(topic) {
  const chunks = topic.split("/");
  const at = chunks.lastIndexOf("detections");
  return { host: chunks.slice(0, at).join("/"), producer: chunks[at + 1], id: chunks[at + 2] ?? null };
}

const isStale = (d, now) => d.time != null && d.stale_after != null && now > d.time + d.stale_after;

// Where a thing d metres down a beam from sensor pose s might really be, as
// [distance along the beam, radius] rings: one at the sensor, as wide as its
// own position error, and one at either end of the ± range. Along the beam,
// the range accuracy a and the sensor's position error along it; across, the
// bearing accuracy p (deg) at that distance and the sensor's position error
// across it (the larger of the two ways). Each a 90% bound, summed in
// quadrature as Accuracy does down the tree. Null if nothing is known.
function beamRings(d, a, p, s) {
  const { horizontal: h, vertical: v } = s.accuracy ?? {};
  if (d == null || (a == null && p == null && h == null && v == null)) return null;
  const u = new Vector3(1, 0, 0).applyQuaternion(s.inScene); // the beam, ENU
  const [uh, uz] = [Math.hypot(u.x, u.y), Math.abs(u.z)];
  const [ph, pv] = [h ?? 0, v ?? 0];
  const along = Math.hypot(a ?? 0, ph * uh, pv * uz);
  const across = Math.max(ph, Math.hypot(ph * uz, pv * uh));
  const radius = (r) => Math.hypot(r * Math.tan(((p ?? 0) * Math.PI) / 180), across);
  return [0, Math.max(d - along, 0), d + along].map((r) => [r, radius(r)]);
}

// A detection's label: one value. A range if it has one, else what it is.
function detText(f) {
  const d = f.det;
  if (d.range != null && f.pose) return `${d.range.toFixed(1)} m`;
  const { host, producer } = detParts(f.topic);
  return d.label ?? (producer === "self" ? `${host} self` : producer);
}

const deg = (a) => `${a.toFixed(1)}°`;
const m = (x) => x.toFixed(2);

// A placed frame's accuracy and place, as detail rows.
function placeRows(f) {
  const acc = f.pose.accuracy;
  const fmt = (x) => (x == null ? "?" : `${m(x)} m`);
  const how = f.det && howText(f.det.how);
  return [
    acc
      ? [["acc", "± "], ["acc", fmt(acc.horizontal)], ["acc", " horizontal, "], ["acc", fmt(acc.vertical)], ["acc", " vertical (90%)"]]
      : [["acc", "accuracy unknown"]],
    [["", `${f.lat.toFixed(7)}, ${f.lon.toFixed(7)}`], ["k", how ? `  from ${how}` : ""]],
    f.unvouched ? unvouchedRow(f) : [["", m(f.msl)], ["k", " m above sea level (EGM96), "], ["", m(f.h)], ["k", " m above WGS84"]],
  ];
}

// A height nobody vouches for: what it reports, against the terrain under it
// where there's terrain, and where it's drawn.
function unvouchedRow(f) {
  const row = [["acc", "height unvouched: "], ["k", "reports "], ["", m(f.msl)], ["k", " m above sea level"]];
  if (f.terrain != null) {
    const d = f.msl - f.terrain;
    row.push(["k", ", "], ["", m(Math.abs(d))], ["k", ` m ${d >= 0 ? "above" : "below"} the terrain`]);
  }
  row.push(["k", f.onTerrain ? "; drawn on the terrain" : "; drawn there"]);
  return row;
}

// The geoid's height above the WGS84 ellipsoid (EGM96, 15' grid), once its
// chunk loads: bundled, never fetched from elsewhere. The same grid and
// interpolation as SpiriMav's spiri_mav.geoid, so a sim robot's heights,
// which SpiriMav puts on the ellipsoid with it, come back exactly.
let geoidAt = null;
const geoidReady = import("egm96-universal").then(({ meanSeaLevel }) => {
  geoidAt = meanSeaLevel;
});

// A report whose height nobody vouches for: a detection straight in the root
// frame (not found through a sensor's chain, which gives it a height) with no
// vertical accuracy, as an ATAK phone's position report (CoT's le 9999999).
// Its height is often tens of metres off.
function heightUnknown(f) {
  return !!(f.det && f.parent?.root && f.pose.accuracy?.vertical == null);
}

// Whether a report whose height is unknown is best drawn on the terrain: its
// CoT type says it's on the ground or the sea's surface (a-f-G, a-h-S), or it
// has no type. Anything else (an aircraft, a-f-A) keeps the height it reports:
// the terrain is a worse guess than that.
function onSurface(f) {
  const dim = f.det.cot_type?.split("-")[2];
  return dim == null || dim === "G" || dim === "S";
}

// CoT's how: where a position came from, as far as the label needs.
function howText(how) {
  if (!how) return null;
  if (how.startsWith("m-g")) return "GPS";
  if (how.startsWith("m-")) return "a machine";
  if (how.startsWith("h-g-i-g-o")) return "placed by hand on a map";
  if (how.startsWith("h-")) return "a person";
  return null;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

// A topic as seen from another: without the base they share.
function shortName(topic, from) {
  const base = from.split("/").slice(0, -1).join("/");
  return base && topic.startsWith(`${base}/`) ? topic.slice(base.length + 1) : topic;
}

function segments(positions, material) {
  const lines = new LineSegments2(new LineSegmentsGeometry().setPositions(positions), material);
  lines.frustumCulled = false;
  lines.computeLineDistances(); // for the dashes of its hidden pass
  return lines;
}

// A material's hidden-line twin: drawn only where something of the map's is
// in front (depth greater), fainter, and dashed. Only lines: faces behind a
// building stack up into a wash that hides the building itself.
const HIDDEN_OPACITY = 0.4;
const DASH_M = 1.5;
function hiddenTwin(material) {
  const twin = material.clone();
  if (!material.isLineMaterial) {
    twin.visible = false;
    return twin;
  }
  twin.depthFunc = GreaterDepth;
  twin.depthWrite = false;
  twin.transparent = true;
  twin.opacity = (material.transparent ? material.opacity : 1) * HIDDEN_OPACITY;
  twin.dashed = true;
  twin.dashSize = twin.gapSize = DASH_M;
  return twin;
}

export class SynqFrames {
  id = "synq-frames";
  type = "custom";
  renderingMode = "3d";

  constructor(zenoh, mapLabels) {
    this.zenoh = zenoh;
    this.mapLabels = mapLabels;
    this.map = null;
    this.renderer = null;
    this.scene = new Scene();
    this.camera = new Camera();
    this.frames = new Map(); // topic -> frame
    this.anchor = null; // [lng, lat]
    this.anchorMatrix = null; // scene ENU metres -> mercator units
    this.onGround = false;
    this.dirty = true;
    this.open = new Set(); // topics whose labels are open
    this.rounds = 0;
    this.lenses = new Map(); // camera topic -> its intrinsics, or null if unknown
    // Preview topic -> { url, count, watched, lastNew, busy }: its latest frame.
    this.previews = new Map();
    this.previewsOn = true;

    this.arrowMaterial = new MeshLambertMaterial({ color: COLOR });
    this.openMaterial = new MeshLambertMaterial({ color: OPEN_COLOR });
    this.finMaterial = new MeshLambertMaterial({ color: FIN_COLOR });
    this.parentMaterial = new LineMaterial({ color: COLOR, linewidth: 2 });
    this.accuracyMaterial = new LineMaterial({ color: OPEN_COLOR, linewidth: 1.5 });
    // Every band's faces, and its edges.
    this.bandFace = new MeshBasicMaterial({ color: CONE_COLOR, transparent: true, opacity: FACE_OPACITY, side: DoubleSide, depthWrite: false });
    this.bandEdge = new LineMaterial({ color: CONE_COLOR, linewidth: 1.5, transparent: true, opacity: EDGE_OPACITY });
    this.bands = loadBands();
    // The view's corner rays, once, the whole way out.
    this.rayMaterial = new LineMaterial({ color: 0xffffff, linewidth: 1, transparent: true, opacity: 0.25 });

    // Light from overhead, a little south-east, as gz-world.js's.
    const sun = new DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.3, -0.4, 1);
    this.arrows = new Group(); // one per placed frame, rebuilt with them
    this.lines = new Group(); // parent lines, accuracy cylinders
    this.scene.add(sun, new AmbientLight(0xffffff, 0.7), this.lines, this.arrows);
    // Camera coverage: a scene of its own, as it's depth-tested and the rest isn't.
    this.cones = new Group();
    this.coverage = new Scene();
    // Detections: the points over the map, how they were found depth-tested
    // as coverage is. A set of materials for live ones and one for stale.
    const detMaterials = (color) => ({
      marker: new MeshLambertMaterial({ color }),
      line: new LineMaterial({ color, linewidth: 2.5 }),
      chain: new LineMaterial({ color, linewidth: 2, transparent: true, opacity: 0.8 }),
      faint: new LineMaterial({ color, linewidth: 2, transparent: true, opacity: 0.6 }),
      face: new MeshBasicMaterial({ color, transparent: true, opacity: 0.2, side: DoubleSide, depthWrite: false }),
    });
    this.detLive = detMaterials(DET_COLOR);
    this.detStale = detMaterials(STALE_COLOR);
    // Each one's hidden-line twin, for what the map hides (see render).
    this.hidden = new Map(
      [this.detLive, this.detStale].flatMap((s) => Object.values(s)).map((mat) => [mat, hiddenTwin(mat)]),
    );
    this.points = new Group();
    this.scene.add(this.points);
    this.findings = new Group();
    this.coverage.add(this.cones, this.findings);
  }

  get lineMaterials() {
    const det = [this.detLive, this.detStale].flatMap((s) => [s.line, s.chain, s.faint]);
    return [this.parentMaterial, this.accuracyMaterial, this.rayMaterial, this.bandEdge, ...det, ...det.map((m) => this.hidden.get(m))];
  }

  onAdd(map, gl) {
    this.map = map;
    this.renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;
    geoidReady.then(() => this.changed());
    // A report drawn on the terrain moves once the terrain under it loads.
    map.on("data", (e) => {
      if (e.sourceId === "terrain" && e.tile && [...this.frames.values()].some((f) => f.unvouched)) this.changed();
    });
    this.start();
  }

  // The frames: arrows, lines and labels.
  get show() {
    return this.arrows.visible;
  }

  set show(on) {
    this.arrows.visible = this.lines.visible = on; // and the labels: see render
    this.repaint();
  }

  // Camera coverage.
  get showCoverage() {
    return this.cones.visible;
  }

  set showCoverage(on) {
    this.cones.visible = on;
    this.repaint();
  }

  // Detections' points, and how they were found.
  get showDetections() {
    return this.points.visible;
  }

  set showDetections(on) {
    this.points.visible = on;
    this.repaint();
  }

  // Camera previews, in their carriers' labels.
  get showPreviews() {
    return this.previewsOn;
  }

  set showPreviews(on) {
    this.previewsOn = on;
    if (on) this.fetchPreviews();
    this.repaint();
  }

  get showFindings() {
    return this.findings.visible;
  }

  set showFindings(on) {
    this.findings.visible = on;
    this.repaint();
  }

  setTerrain(on) {
    this.onGround = !on;
    this.changed();
  }

  repaint() {
    this.map?.triggerRepaint();
  }

  changed() {
    this.dirty = true;
    this.repaint();
  }

  // Discovery every DISCOVER_MS, and the live poses and mounts.
  start() {
    for (const field of ["pose", "mount"]) {
      this.zenoh.subscribe(`**/${field}`, (sample) => this.onSample(field, sample));
    }
    // Detections' own fields, live; pose and mount come as any frame's.
    this.zenoh.subscribe("*/detections/**", (sample) => this.onDetField(sample));
    this.zenoh.subscribe("**/intrinsics", (sample) => this.onLens(sample));
    // Staleness goes by the clock, not by samples; and open details show ages.
    setInterval(() => this.tick(), TICK_MS);
    setInterval(() => this.fetchPreviews(), PREVIEW_MS);
    (async () => {
      for (;;) {
        try {
          await this.discover();
        } catch (e) {
          console.warn("frames: discovery failed", e);
        }
        await new Promise((r) => setTimeout(r, DISCOVER_MS));
      }
    })();
  }

  onSample(field, sample, convert = toPose) {
    const key = sample.keyexpr().toString();
    // An object's tombstone is a delete on `<topic>/**`.
    if (sample.kind() === SampleKind.DELETE) {
      if (key.endsWith("/**")) this.remove(key.slice(0, -3));
      return;
    }
    const frame = this.frames.get(key.slice(0, -(field.length + 1)));
    if (!frame) return;
    try {
      frame[field] = convert(load(sample.payload().toString()));
    } catch (e) {
      console.warn(`frames: ${key}`, e);
      return;
    }
    this.changed();
  }

  onDetField(sample) {
    if (sample.kind() === SampleKind.DELETE) return; // onSample removes the frame
    const key = sample.keyexpr().toString();
    const cut = key.lastIndexOf("/");
    const field = key.slice(cut + 1);
    const frame = this.frames.get(key.slice(0, cut));
    if (!frame?.det || !DET_FIELDS.includes(field)) return;
    try {
      const v = load(sample.payload().toString()) ?? null;
      frame.det[field] = field === "ray" ? toPose(v) : v;
    } catch (e) {
      console.warn(`frames: ${key}`, e);
      return;
    }
    this.changed();
  }

  // A redraw when a detection goes stale (or comes back), and fresh ages in
  // open details.
  tick() {
    const now = Date.now() / 1000;
    let open = false;
    for (const f of this.frames.values()) {
      if (!f.det) continue;
      if (isStale(f.det, now) !== f.stale) return this.changed();
      open ||= this.isOpen(f);
    }
    if (open) this.repaint();
  }

  onLens(sample) {
    const key = sample.keyexpr().toString();
    if (sample.kind() === SampleKind.DELETE) {
      // A camera gone: rehydrated again if it comes back.
      if (key.endsWith("/**") && this.lenses.delete(key.slice(0, -3))) this.changed();
      return;
    }
    const topic = key.slice(0, -"/intrinsics".length);
    try {
      this.lenses.set(topic, load(sample.payload().toString()) ?? null);
    } catch (e) {
      console.warn(`frames: ${key}`, e);
      return;
    }
    this.changed();
  }

  // A camera's lens, the first time a frame links to it. Its rehydrate has a
  // frame in it too, but that's once; after, the lens comes live.
  async fetchLens(topic) {
    this.lenses.set(topic, null);
    try {
      const [reply] = await this.zenoh.query(`${topic}/sr_rehydrate`);
      if (!reply || reply instanceof Error) throw reply ?? new Error("no answer");
      // Only the lens, from the rest of the camera.
      const lens = load(reply.payload().toString())?.intrinsics ?? null;
      if (this.lenses.has(topic) && !this.lenses.get(topic)) this.lenses.set(topic, lens);
      this.changed();
    } catch (e) {
      this.lenses.delete(topic); // so the next round asks again
      console.warn(`frames: camera ${topic}`, e);
    }
  }

  // Every placed carrier's cameras' previews, while the layer is on: each
  // fetched from zenoh-index, which is kept watching it, since a camera only
  // runs while something subscribes. Only the latest frame crosses the
  // websocket, at most once a PREVIEW_MS, however fast the camera publishes.
  fetchPreviews() {
    if (!this.showPreviews) return;
    const wanted = new Set();
    for (const f of this.frames.values()) {
      if (!f.pose) continue;
      for (const camera of f.cameras ?? []) {
        const topic = previewOf(camera);
        if (topic) wanted.add(topic);
      }
    }
    for (const [topic, p] of this.previews) {
      if (wanted.has(topic)) continue;
      if (p.url) URL.revokeObjectURL(p.url);
      this.previews.delete(topic);
    }
    for (const topic of wanted) {
      if (!this.previews.has(topic)) this.previews.set(topic, { url: null, count: null, watched: 0, lastNew: 0, busy: false });
      this.fetchPreview(topic, this.previews.get(topic));
    }
    if (wanted.size) this.repaint(); // so a preview that stops is dimmed
  }

  async fetchPreview(topic, p) {
    if (p.busy) return;
    p.busy = true;
    const key = `${topic}/transport_jpeg/@data`;
    try {
      const now = performance.now();
      if (now - p.watched > PREVIEW_WATCH_MS) {
        p.watched = now;
        const [reply] = await this.zenoh.query("@sdk/index/watch", { payload: key });
        if (reply instanceof Error) throw reply;
      }
      const [reply] = await this.zenoh.query("@sdk/index/value", { payload: key });
      if (!reply || reply instanceof Error) return;
      const count = reply.attachment()?.toString();
      if (count === p.count || this.previews.get(topic) !== p) return;
      p.count = count;
      const url = URL.createObjectURL(new Blob([reply.payload().toBytes()], { type: "image/jpeg" }));
      if (p.url) URL.revokeObjectURL(p.url);
      p.url = url;
      p.lastNew = performance.now();
      this.repaint();
    } catch (e) {
      console.warn(`frames: preview ${topic}`, e);
    } finally {
      p.busy = false;
    }
  }

  async discover() {
    const round = ++this.rounds;
    const replies = await this.zenoh.query("**/sr_metadata");
    const topics = replies.flatMap((r) => {
      if (r instanceof Error) return [];
      const meta = parse(r.payload().toString());
      // A camera is a Position too, but it's drawn as its carrier's view
      // (camera coverage, below), and rehydrating one brings its frame along.
      const classes = meta?.classes ?? [];
      return classes.includes("!Position") && !classes.includes("!CameraBase") ? [[meta.topic, classes]] : [];
    });
    await Promise.all(topics.map(([topic, classes]) => this.rehydrate(topic, round, classes.includes("!Detection"))));
    // Gone after two rounds without an answer: one can just be lost.
    for (const [topic, frame] of this.frames) if (round - frame.round > 1) this.remove(topic);
    this.changed();
  }

  async rehydrate(topic, round, isDetection) {
    try {
      const [reply] = await this.zenoh.query(`${topic}/sr_rehydrate`);
      if (!reply || reply instanceof Error) return;
      const text = reply.payload().toString();
      const o = load(text);
      const frame = this.frames.get(topic) ?? { topic, pose: null, mount: null };
      frame.round = round;
      frame.cls = text.match(/^!(\w+)/)?.[1] ?? "Position";
      // A relative topic (./x) is relative to the object's base topic.
      const rel = o.relative_to;
      frame.parent = rel?.root
        ? { root: rel.root }
        : { link: String(linkOf(rel) ?? rel ?? "").replace(/^\.\//, `${o.synq_base_topic}/`) };
      frame.links = Object.entries(o).flatMap(([field, v]) =>
        field === "relative_to" ? [] : (Array.isArray(v) ? v : [v]).filter(linkOf).map((x) => ({ field, to: linkOf(x) })),
      );
      // Live updates are newer than any snapshot.
      frame.pose ??= toPose(o.pose);
      frame.mount ??= toPose(o.mount);
      // A detection keeps its own fields; live ones, once there, are newer.
      if (isDetection) {
        frame.det ??= {};
        for (const k of DET_FIELDS) if (!(k in frame.det)) frame.det[k] = k === "ray" ? toPose(o[k]) : (o[k] ?? null);
      } else frame.det = null;
      frame.cameras = frame.links.filter((l) => l.field === "cameras").map((l) => l.to);
      for (const camera of frame.cameras) if (!this.lenses.has(camera)) this.fetchLens(camera);
      this.frames.set(topic, frame);
    } catch (e) {
      console.warn(`frames: ${topic}`, e);
    }
  }

  remove(topic) {
    const frame = this.frames.get(topic);
    if (!frame) return;
    this.mapLabels.remove(`synq/${topic}`);
    this.frames.delete(topic);
    this.open.delete(topic);
    this.changed();
  }

  isOpen(f) {
    return this.open.has(f.topic);
  }

  // Each placed frame's geodetic position, angles and scene pose, then its
  // arrow and the lines between them.
  rebuild() {
    if (!geoidAt) return; // until the geoid loads: heights would jump ~20 m when it did
    this.dirty = false;
    const placed = [...this.frames.values()].filter((f) => f.pose);
    for (const f of placed) {
      [f.lat, f.lon, f.h] = geodetic(f.pose.offset);
      f.msl = f.h - geoidAt(f.lat, f.lon);
      f.unvouched = heightUnknown(f);
      f.onTerrain = f.unvouched && onSurface(f);
      f.world = f.pose.q && angles(levelFrame(f.lat, f.lon, "ned").invert().multiply(f.pose.q));
    }
    for (const f of this.frames.values()) if (!f.pose) f.onTerrain = f.unvouched = false;
    // A detection's ray is a pose of its own, placed or not.
    const rays = [...this.frames.values()].filter((f) => f.det?.ray);
    for (const f of this.frames.values()) f.rayAt = null;
    for (const f of rays) {
      const [lat, lon, h] = geodetic(f.det.ray.offset);
      f.rayAt = { pose: f.det.ray, lat, lon, h, msl: h - geoidAt(lat, lon) };
    }
    this.arrows.clear();
    for (const child of [...this.lines.children, ...this.cones.children, ...this.findings.children, ...this.points.children]) {
      if (child.geometry !== DIAMOND) child.geometry.dispose();
    }
    this.points.clear();
    this.lines.clear();
    this.cones.clear();
    this.findings.clear();
    const all = [...placed, ...rays.map((f) => f.rayAt)];
    if (!all.length) return;

    if (!this.anchor) this.setAnchor([all[0].lon, all[0].lat]);
    // Without terrain, the lowest frame with a known height sits on the flat
    // map, and a report whose height is unknown sits there too.
    const known = all.filter((f) => !f.unvouched);
    const ground = this.onGround ? Math.min(...(known.length ? known : all).map((f) => f.msl)) : 0;
    const a = MercatorCoordinate.fromLngLat(this.anchor, 0);
    const s = a.meterInMercatorCoordinateUnits();
    const scene = (lon, lat, msl) => {
      const p = MercatorCoordinate.fromLngLat([lon, lat], msl - ground);
      return new Vector3((p.x - a.x) / s, -(p.y - a.y) / s, (p.z - a.z) / s);
    };
    for (const f of all) {
      // The terrain under a report whose height is unknown, for its drop line
      // and label: null without terrain.
      f.terrain = f.unvouched && !this.onGround ? (this.map?.queryTerrainElevation([f.lon, f.lat]) ?? null) : null;
      let msl = f.msl;
      if (f.onTerrain) msl = this.onGround ? ground : (f.terrain ?? f.msl);
      f.at = scene(f.lon, f.lat, msl);
      // Where it's drawn and the other of terrain and reported height.
      f.drop = f.terrain != null ? scene(f.lon, f.lat, f.onTerrain ? f.msl : f.terrain) : null;
      f.inScene = f.pose.q ? levelFrame(f.lat, f.lon, "enu").invert().multiply(f.pose.q) : UNTURNED;
      f.accuracy = f.pose.accuracy;
    }

    for (const f of placed) {
      if (f.det) continue; // a point of its own, below
      const arrow = new Group();
      arrow.matrixAutoUpdate = false;
      arrow.userData.frame = f;
      const material = this.isOpen(f) ? this.openMaterial : this.arrowMaterial;
      if (f.pose.q) arrow.add(...ARROW.map((g) => new Mesh(g, material)), new Mesh(FIN, this.finMaterial));
      else arrow.add(new Mesh(POINT, material));
      this.arrows.add(arrow);
    }

    const parentLines = [];
    for (const f of placed) {
      const parent = this.frames.get(f.parent?.link);
      if (parent?.pose && !f.det) parentLines.push(...f.at.toArray(), ...parent.at.toArray());
    }
    if (parentLines.length) this.lines.add(segments(parentLines, this.parentMaterial));
    // An open detection's shows with its point.
    for (const f of placed) if (this.isOpen(f)) this.addAccuracy(f, f.det ? this.points : this.lines);

    for (const f of placed) {
      if (!f.pose.q) continue; // a point has no facing to look along
      for (const camera of f.cameras ?? []) {
        const lens = this.lenses.get(camera);
        if (lens) this.addCoverage(f, lens);
      }
    }

    const now = Date.now() / 1000;
    for (const f of this.frames.values()) {
      if (!f.det) continue;
      f.stale = isStale(f.det, now);
      this.addDetection(f, f.stale ? this.detStale : this.detLive);
    }
  }

  // A detection: its point, and how it was found (see the top of the file).
  addDetection(f, mat) {
    const d = f.det;
    const r = f.rayAt;
    if (f.pose && f.at) {
      const marker = new Mesh(DIAMOND, mat.marker);
      marker.matrixAutoUpdate = false;
      marker.userData.at = f.at;
      this.points.add(marker);
      // Height unknown: a faint line between the terrain and the height it
      // reports, whichever end it's drawn at.
      if (f.drop) this.findings.add(segments([...f.at.toArray(), ...f.drop.toArray()], mat.faint));
    }
    // Up the tree, from where it was found from (its sensor, or itself).
    const chain = [];
    let from = r ?? (f.pose ? f : null);
    for (let p = this.frames.get(f.parent?.link), seen = new Set(); from && p?.at && !seen.has(p); p = this.frames.get(p.parent?.link)) {
      seen.add(p);
      chain.push(...from.at.toArray(), ...p.at.toArray());
      from = p;
    }
    if (chain.length) this.findings.add(segments(chain, mat.chain));
    if (!r) {
      if (f.pose && f.at) this.addAccuracy(f, this.findings, mat.line);
      return;
    }
    const along = (x) => new Vector3(x, 0, 0).applyQuaternion(r.inScene).add(r.at);
    const box = d.angular_width != null && d.angular_height != null;
    if (d.range != null && f.pose && f.at) {
      // The beam itself, always: the cone's faces alone are too thin to see,
      // and behind the map only lines are drawn.
      this.findings.add(segments([...r.at.toArray(), ...f.at.toArray()], mat.line));
      const rings = beamRings(d.range, d.range_accuracy, d.bearing_accuracy, r);
      if (rings) this.addBounds(r, rings, mat, true);
    } else if (!box && d.status !== "near") {
      // A bearing alone: where to look, as far as the sensor reaches or LOOK_M.
      // (A rangefinder's "near" is nearer than it reads: nothing to draw.)
      const look = d.max ?? LOOK_M;
      this.findings.add(segments([...r.at.toArray(), ...along(look).toArray()], mat.faint));
      if (d.bearing_accuracy != null) {
        this.addBounds(r, [[0, r.accuracy?.horizontal ?? 0], [look, look * Math.tan((d.bearing_accuracy * Math.PI) / 180)]], mat, false);
      }
    }
    if (box) this.addFootprint(r, d, mat);
  }

  // A box's angular footprint down its ray: a pyramid out to its range,
  // capped, or uncapped to LOOK_M without one.
  addFootprint(r, d, mat) {
    const [tw, th] = [d.angular_width, d.angular_height].map((x) => Math.tan((x * Math.PI) / 360));
    const end = d.range ?? LOOK_M;
    // The footprint's corners at range x, in the ray's frame (x forward, y right, z down).
    const corners = (x) => [[x, -tw * x, -th * x], [x, tw * x, -th * x], [x, tw * x, th * x], [x, -tw * x, th * x]]
      .map((c) => new Vector3(...c).applyQuaternion(r.inScene).add(r.at));
    const far = corners(end);
    const tris = [];
    const edges = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      tris.push(...[r.at, far[i], far[j]].flatMap((c) => c.toArray()));
      edges.push(...r.at.toArray(), ...far[i].toArray());
      if (d.range != null) edges.push(...far[i].toArray(), ...far[j].toArray());
    }
    if (d.range != null) tris.push(...[far[0], far[1], far[2], far[0], far[2], far[3]].flatMap((c) => c.toArray()));
    const faces = new BufferGeometry();
    faces.setAttribute("position", new Float32BufferAttribute(tris, 3));
    const mesh = new Mesh(faces, mat.face);
    mesh.frustumCulled = false;
    this.findings.add(mesh, segments(edges, d.range != null ? mat.line : mat.faint));
  }

  // The coverage bands, as the Layers applet edits them; kept in this browser.
  setBands(bands) {
    this.bands = bands;
    try {
      localStorage.setItem(BANDS_KEY, JSON.stringify(bands));
    } catch {}
    this.changed();
  }

  // A camera's view from frame f, as bands along it, nearest first: each from
  // the last one's range out to its own, its far end capped and outlined, and
  // the corner rays drawn once over all of them.
  addCoverage(f, lens) {
    const [left, right, up, down] = tangents(lens);
    // The view's corners at range r, in f's body frame (x forward, y right, z down).
    const corners = (r) => [
      [r, -left * r, -up * r],
      [r, right * r, -up * r],
      [r, right * r, down * r],
      [r, -left * r, down * r],
    ].map((c) => new Vector3(...c).applyQuaternion(f.inScene).add(f.at));

    const ranges = [...new Set(this.bands.map((b) => bandRange(lens, b)).filter((r) => r))].sort((a, b) => a - b);
    if (!ranges.length) return;
    let near = corners(0);
    for (const range of ranges) {
      const far = corners(range);
      const tris = [];
      const edges = [];
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        tris.push(...[near[i], far[i], far[j], near[i], far[j], near[j]].flatMap((c) => c.toArray()));
        edges.push(...far[i].toArray(), ...far[j].toArray());
      }
      // Capped at its far end, so whether something's inside a band shows.
      tris.push(...[far[0], far[1], far[2], far[0], far[2], far[3]].flatMap((c) => c.toArray()));
      const faces = new BufferGeometry();
      faces.setAttribute("position", new Float32BufferAttribute(tris, 3));
      const mesh = new Mesh(faces, this.bandFace);
      mesh.frustumCulled = false;
      this.cones.add(mesh, segments(edges, this.bandEdge));
      near = far;
    }
    this.cones.add(segments(near.flatMap((c) => [...f.at.toArray(), ...c.toArray()]), this.rayMaterial));
  }

  // A beam's ± range along frame f's x axis (beamRings): a ring around it at
  // each end, in a faint cone out to the far one from a base at the frame as
  // wide as its own position error. Without outlined ends, just the cone.
  addBounds(f, rings, mat, outlined) {
    const n = 48;
    const edges = [];
    const circles = rings.map(([distance, radius]) => {
      const ring = [];
      for (let i = 0; i <= n; i++) {
        const a = (2 * Math.PI * i) / n;
        ring.push(new Vector3(distance, radius * Math.cos(a), radius * Math.sin(a)).applyQuaternion(f.inScene).add(f.at));
      }
      return ring;
    });
    // The ± range's ends outlined; the one at the gimbal is the cone's base.
    for (const ring of outlined ? circles.slice(1) : []) {
      for (let i = 0; i < n; i++) edges.push(...ring[i].toArray(), ...ring[i + 1].toArray());
    }
    // From the base at the gimbal out to the far ring.
    const [base, far] = [circles[0], circles.at(-1)];
    const tris = [];
    for (let i = 0; i < n; i++) {
      tris.push(...base[i].toArray(), ...far[i].toArray(), ...far[i + 1].toArray());
      tris.push(...base[i].toArray(), ...far[i + 1].toArray(), ...base[i + 1].toArray());
    }
    const faces = new BufferGeometry();
    faces.setAttribute("position", new Float32BufferAttribute(tris, 3));
    const cone = new Mesh(faces, mat.face);
    cone.frustumCulled = false;
    this.findings.add(cone);
    if (edges.length) this.findings.add(segments(edges, mat.line));
  }

  // The pose's 90% accuracy: circles of the horizontal radius at the frame and
  // at ± the vertical, joined at the sides. Level, whatever the frame's tilt.
  addAccuracy(f, group = this.lines, material = this.accuracyMaterial) {
    const { horizontal: r, vertical: v } = f.pose.accuracy ?? {};
    if (r == null && v == null) return;
    const lines = [];
    const levels = v != null ? [-v, 0, v] : [0];
    if (r != null) {
      const n = 48;
      for (const z of levels) {
        for (let i = 0; i < n; i++) {
          const [a, b] = [(2 * Math.PI * i) / n, (2 * Math.PI * (i + 1)) / n];
          lines.push(r * Math.cos(a), r * Math.sin(a), z, r * Math.cos(b), r * Math.sin(b), z);
        }
      }
    }
    if (v != null) {
      const sides = r != null ? [[r, 0], [-r, 0], [0, r], [0, -r]] : [[0, 0]];
      for (const [x, y] of sides) lines.push(x, y, -v, x, y, v);
    }
    group.add(segments(lines.map((c, i) => c + f.at.getComponent(i % 3)), material));
  }

  setAnchor(lngLat) {
    this.anchor = lngLat;
    const a = MercatorCoordinate.fromLngLat(lngLat, 0);
    const s = a.meterInMercatorCoordinateUnits();
    // Mercator's y grows southward; ENU's north is up.
    this.anchorMatrix = new Matrix4().makeTranslation(a.x, a.y, a.z).scale(new Vector3(s, -s, s));
  }

  render(gl, { defaultProjectionData }) {
    if (this.anchor) {
      const center = this.map.getCenter();
      if (center.distanceTo({ lng: this.anchor[0], lat: this.anchor[1] }) > REANCHOR_M) {
        this.setAnchor(center.toArray());
        this.dirty = true;
      }
    }
    if (this.dirty) this.rebuild();
    if (!this.anchorMatrix) return;
    // In doubles, then once to the GPU, as gz-world.js does.
    this.camera.projectionMatrix.fromArray(defaultProjectionData.mainMatrix).multiply(this.anchorMatrix);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    const canvas = this.map.getCanvas();
    this.size = [canvas.clientWidth, canvas.clientHeight];
    for (const material of this.lineMaterials) material.resolution.set(...this.size);

    // Arrows and detections' diamonds a fixed size on screen: scaled by how
    // many pixels a metre is there. The diamond is 0.3 across.
    const fixed = (object, at, q, px) => {
      const pxPerM = Math.max(...[[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((d) => this.pixels(at, at.clone().add(new Vector3(...d)))));
      const scale = pxPerM > 0 ? px / pxPerM : 1;
      object.matrix.compose(at, q, new Vector3(scale, scale, scale));
      object.matrixWorldNeedsUpdate = true;
    };
    for (const arrow of this.arrows.children) fixed(arrow, arrow.userData.frame.at, arrow.userData.frame.inScene, ARROW_PX);
    for (const marker of this.points.children) if (marker.userData.at) fixed(marker, marker.userData.at, UNTURNED, MARKER_PX / 0.3);
    this.renderer.resetState();
    // Coverage and how detections were found first, against the map's depth,
    // so the ground, buildings and Gazebo's models hide them.
    if (this.cones.visible || this.findings.visible) this.renderer.render(this.coverage, this.camera);
    // Then how detections were found, again, where the map hides it: faint
    // and dashed, so a beam into the ground still shows where it goes.
    if (this.findings.visible) {
      const children = this.findings.children;
      const shown = children.map((c) => c.material);
      for (const c of children) c.material = this.hidden.get(c.material) ?? c.material;
      const cones = this.cones.visible;
      this.cones.visible = false;
      this.renderer.render(this.coverage, this.camera);
      this.cones.visible = cones;
      children.forEach((c, i) => (c.material = shown[i]));
    }
    // The frames over the map and the Gazebo models, so a robot's frames show
    // inside its model, but depth-tested among themselves.
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  // Scene point to [x, y] on screen, or null behind the camera.
  toScreen(v) {
    const p = new Vector4(v.x, v.y, v.z, 1).applyMatrix4(this.camera.projectionMatrix);
    if (p.w <= 0) return null;
    const [w, h] = this.size;
    return [((p.x / p.w + 1) / 2) * w, ((1 - p.y / p.w) / 2) * h];
  }

  pixels(a, b) {
    const [p, q] = [this.toScreen(a), this.toScreen(b)];
    return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1]) : 0;
  }

  // A label: its topic, which opens and closes it, over its details. Pressing
  // on it doesn't reach the map, so the details can be selected and copied
  // without dragging the map. A detection's reads one value instead
  // (detText), and goes before the others.
  label(f) {
    if (!f.label) {
      const label = el("div", f.det ? "sf-label sf-det" : "sf-label");
      const head = el("div", "sf-head");
      head.append(el("b", "", f.det ? detText(f) : f.topic));
      if (f.det) head.append(el("span", "sf-icon"));
      head.onclick = () => {
        if (!this.open.delete(f.topic)) this.open.add(f.topic);
        this.changed();
      };
      for (const type of ["pointerdown", "mousedown", "touchstart", "dblclick"]) {
        label.addEventListener(type, (e) => e.stopPropagation());
      }
      // The previews between the head and the details, which stay last (fill).
      label.append(head, el("div", "sf-previews"), el("div", "sf-body"));
      f.label = this.mapLabels.add(`synq/${f.topic}`, label, { priority: f.det ? 1 : 0 });
    }
    return f.label;
  }

  // An open label's details, as rows of [class, text] pieces: its class,
  // angles, mount, accuracy, place and links.
  details(f) {
    if (f.det) return this.detDetails(f);
    const rows = [[["cls", f.cls]]];
    if (f.world) {
      const [roll, pitch, yaw] = f.world;
      rows.push([["k", "hdg "], ["", deg(yaw)], ["k", "  pitch "], ["", deg(pitch)], ["k", "  roll "], ["", deg(roll)]]);
    } else rows.push([["k", "a point: no facing"]]);
    if (f.parent?.root) rows.push([["k", "in "], ["", f.parent.root]]);
    else if (f.mount) {
      const o = f.mount.offset;
      const parent = this.frames.has(f.parent.link) ? shortName(f.parent.link, f.topic) : `${f.parent.link} (not found)`;
      rows.push([["k", "in "], ["", parent], ["k", ": "], ["", `(${m(o.x)}, ${m(o.y)}, ${m(o.z)})`], ["k", " m"]]);
      if (f.mount.q) {
        const [r, p, y] = angles(f.mount.q);
        rows.push([["k", "yaw "], ["", deg(y)], ["k", "  pitch "], ["", deg(p)], ["k", "  roll "], ["", deg(r)]]);
      }
    }
    rows.push(
      ...placeRows(f),
      ...f.links.map(({ field, to }) => [["k", `${field} → `], ["", shortName(to, f.topic)]]),
    );
    for (const camera of f.cameras ?? []) {
      const lens = this.lenses.get(camera);
      const name = shortName(camera, f.topic);
      if (!lens) {
        rows.push([["k", `${name}: lens unknown`]]);
        continue;
      }
      const [h, v] = fovs(lens);
      rows.push([["k", `${name}: `], ["", `${deg(h)} × ${deg(v)}`], ["k", ` at ${lens.width}×${lens.height}, from ${lens.origin || "?"}`]]);
      for (const band of this.bands) {
        const range = bandRange(lens, band);
        if (range) rows.push([["k", `  ${band.name || "band"} to `], ["", `${range.toFixed(0)} m`]]);
      }
    }
    return rows;
  }

  // A detection's details: what it is, how sure and how fresh, how it was
  // found, and where it is, if it's located. Only what it carries.
  detDetails(f) {
    const d = f.det;
    const now = Date.now() / 1000;
    const rows = [[["cls", f.cls], ["k", "  "], ["", f.topic]]];
    const what = [];
    if (d.label != null) what.push(["", d.label]);
    if (d.cot_type != null) what.push(["k", what.length ? "  CoT " : "CoT "], ["", d.cot_type]);
    if (what.length) rows.push(what);
    rows.push([["k", "confidence "], d.confidence != null ? ["", `${Math.round(d.confidence * 100)}%`] : ["k", "not given"]]);
    const age = d.time != null ? now - d.time : null;
    rows.push([
      ["k", "seen "],
      age != null ? ["", `${age.toFixed(1)} s ago`] : ["k", "at no given time"],
      ["k", d.stale_after != null ? `, stale after ${d.stale_after} s` : ", holds until closed"],
      f.stale ? ["acc", "  STALE"] : ["", ""],
    ]);
    if (d.course != null || d.speed != null) {
      rows.push([["k", "moving "], ["", d.speed != null ? `${d.speed.toFixed(1)} m/s` : "?"], ["k", " toward "], ["", d.course != null ? deg(d.course) : "?"]]);
    }
    if (d.ray) {
      const from = f.parent?.link ? shortName(f.parent.link, f.topic) : "its sensor";
      rows.push([
        ["k", "bearing "], ["", `${deg(d.azimuth ?? 0)} right, ${deg(d.elevation ?? 0)} up`], ["k", ` from ${from}`],
        ["acc", d.bearing_accuracy != null ? `  ± ${d.bearing_accuracy}°` : "  ± ?°"],
      ]);
      rows.push(
        d.range != null
          ? [["k", "range "], ["", `${m(d.range)} m`], ["acc", d.range_accuracy != null ? `  ± ${m(d.range_accuracy)} m` : "  ± ?"]]
          : [["k", "no range"]],
      );
    }
    if (d.status != null) {
      rows.push([["k", "status "], ["", String(d.status)], ["k", d.min != null || d.max != null ? `  (reads ${d.min ?? "?"}–${d.max ?? "?"} m)` : ""]]);
    }
    if (d.angular_width != null && d.angular_height != null) {
      const b = d.box;
      rows.push([
        ["k", "box "], ["", `${deg(d.angular_width)} × ${deg(d.angular_height)}`],
        ["k", b ? `  (${b.width}×${b.height} px at ${b.left},${b.top} of ${b.image_width}×${b.image_height})` : ""],
      ]);
    }
    if (f.pose && f.lat != null) rows.push(...placeRows(f));
    else rows.push([["k", "not located"]]);
    return rows;
  }

  // Writes rows into body in place: only text that changed is replaced, so a
  // selection elsewhere in it survives. A selection inside it holds the
  // whole body still until it's let go. Returns whether anything changed.
  fill(body, rows) {
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && (body.contains(sel.anchorNode) || body.contains(sel.focusNode))) return false;
    const shape = rows.map((r) => r.map(([cls]) => cls).join()).join("|");
    if (body.dataset.shape !== shape) {
      body.dataset.shape = shape;
      body.replaceChildren(...rows.map((r) => {
        const row = el("div");
        row.append(...r.map(([cls, text]) => el("span", cls, text)));
        return row;
      }));
      return true;
    }
    let changed = false;
    rows.forEach((r, i) => {
      const spans = body.children[i].children;
      r.forEach(([, text], j) => {
        const node = spans[j].firstChild;
        if (node?.data === text) return;
        if (node) node.data = text;
        else spans[j].textContent = text;
        changed = true;
      });
    });
    return changed;
  }

  // A label's previews, one image per camera, each its latest frame, dimmed
  // once none has come for PREVIEW_STALE_MS. Images are only touched when
  // what they show changes.
  showPreviewsIn(box, topics) {
    if (box.dataset.topics !== topics.join(" ")) {
      box.dataset.topics = topics.join(" ");
      box.replaceChildren(...topics.map((topic) => {
        const img = el("img");
        img.alt = img.title = topic;
        return img;
      }));
    }
    const now = performance.now();
    topics.forEach((topic, i) => {
      const img = box.children[i];
      const p = this.previews.get(topic);
      if (p?.url && img.getAttribute("src") !== p.url) img.src = p.url;
      img.hidden = !p?.url;
      img.classList.toggle("stale", !!p?.url && now - p.lastNew > PREVIEW_STALE_MS);
    });
  }

  // Each label anchored at its frame's origin, opened or not; the map labels
  // place it below-right of it, clear of the rest. An opened label grows
  // downward, so it stays under the pointer to close it.
  placeLabels() {
    for (const f of this.frames.values()) {
      // A detection's label shows with its point, or, unlocated, at its
      // sensor with how it was found; the rest with the frames.
      const located = f.pose && f.at;
      const previews = this.previewsOn && located ? (f.cameras ?? []).map(previewOf).filter(Boolean) : [];
      const visible = f.det ? (located ? this.points.visible : f.rayAt && this.findings.visible) : this.show || previews.length > 0;
      const at = visible && (located ? f.at : f.det && f.rayAt?.at);
      const screen = at && this.toScreen(at);
      if (!screen) continue;
      const label = this.label(f);
      if (f.det) {
        const text = detText(f);
        const head = label.firstChild.firstChild;
        if (head.textContent !== text) head.textContent = text;
        // What ATAK draws for it, before the text, and its callsign in ATAK's
        // colour (cot-symbol.js).
        const icon = label.firstChild.querySelector(".sf-icon");
        const look = `${f.det.cot_type ?? ""}|${f.det.team ?? ""}|${f.det.colour ?? ""}`;
        if (icon.dataset.look !== look) {
          icon.dataset.look = look;
          icon.innerHTML = takIcon(f.det) ?? "";
          const colour = takColour(f.det);
          if (colour) head.style.setProperty("--det-colour", colour);
          else head.style.removeProperty("--det-colour");
        }
        label.classList.toggle("stale", !!f.stale);
      }
      this.showPreviewsIn(label.children[1], previews);
      const open = this.isOpen(f);
      label.classList.toggle("open", open);
      if (open) this.fill(label.lastChild, this.details(f));
      this.mapLabels.at(`synq/${f.topic}`, screen);
    }
  }
}
