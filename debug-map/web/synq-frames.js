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
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
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
// Poses are ECEF, so heights are above the WGS84 ellipsoid, and are drawn as
// if above sea level, as the map's terrain is: right for SITL, which reports
// no geoid separation, and too low by the local separation (about 21 m at
// Halifax) for a real robot. Without terrain, the lowest frame sits on the
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
// Rangefinders, a layer of their own, and the one exception to drawing every
// Position alike. Where a gimbal's rangefinder hits is a BearingDetection (from
// SpiriMav): a point in the tree under the gimbal, so it has a pose like any
// frame, and with it the reading and the beam's accuracies (SPOT_FIELDS),
// which come with its rehydrate, then live. It isn't a ball: it's drawn along
// its gimbal's x axis, the beam, as a marker where it hit, in a faint cone
// out to two rings at the ends of its ± range: from a base at the gimbal as
// wide as the gimbal's own position error, so the robot's (the GPS's), each
// ring that plus the pointing error there, and the range that plus the
// range error (beamRings). "far", nothing within the sensor's max,
// has no spot, so is a faint ray from the gimbal out to it; "near" has no
// length to draw, so only the details say so. Its label is just the distance;
// it opens to the spot's details, as any frame's does: coordinates, and the
// pose's accuracy, the beam's, the gimbal's and the robot's, summed down the
// tree by SpiriMav, in the 90% bounds every pose uses. Like the coverage, it's
// depth-tested against the map, so the terrain, buildings and Gazebo's models
// hide what's behind them; the label isn't.

const DISCOVER_MS = 5000;
const ARROW_PX = 48; // arrow length on screen
const REANCHOR_M = 20000;
const COLOR = 0xbb9af7;
const FIN_COLOR = 0xe6dcff;
const OPEN_COLOR = 0xffb86c; // an open frame's arrow, and its accuracy
const CONE_COLOR = 0x3a9bff;
const RANGE_COLOR = 0xff5555;
const HIT_PX = 10; // the hit marker's size on screen
const FACE_OPACITY = 0.08;
const EDGE_OPACITY = 0.6;

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

// A BearingDetection's own fields, besides its pose.
const SPOT_FIELDS = ["status", "distance", "min", "max", "range_accuracy", "pointing_accuracy"];

// Where a spot along gimbal g's beam might really be, as [distance along the
// beam, radius] rings: one at the gimbal, as wide as its own position error,
// and one at either end of the ± range. Along the beam, the spot's range
// accuracy and the gimbal's position error along it; across, its pointing
// accuracy at that distance and the gimbal's position error across it (the
// larger of the two ways). Each a 90% bound, summed in quadrature as
// Accuracy does down the tree; the gimbal's is its pose's, which is the
// robot's, the GPS's. Null if nothing is known.
function beamRings(spot, g) {
  const { distance: d, range_accuracy: a, pointing_accuracy: p } = spot;
  const { horizontal: h, vertical: v } = g.pose.accuracy ?? {};
  if (d == null || (a == null && p == null && h == null && v == null)) return null;
  const u = new Vector3(1, 0, 0).applyQuaternion(g.inScene); // the beam, ENU
  const [uh, uz] = [Math.hypot(u.x, u.y), Math.abs(u.z)];
  const [ph, pv] = [h ?? 0, v ?? 0];
  const along = Math.hypot(a ?? 0, ph * uh, pv * uz);
  const across = Math.max(ph, Math.hypot(ph * uz, pv * uh));
  const tan = Math.tan(((p ?? 0) * Math.PI) / 180);
  const radius = (r) => Math.hypot(r * tan, across);
  return [0, Math.max(d - along, 0), d + along].map((r) => [r, radius(r)]);
}

// A spot's label: its distance. Its accuracy is in its details, opened.
function spotText(f) {
  const d = f.spot.distance;
  return d == null || !f.pose ? "rangefinder" : `${d.toFixed(1)} m`;
}

const deg = (a) => `${a.toFixed(1)}°`;
const m = (x) => x.toFixed(2);

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
  return lines;
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
    // Rangefinder rays and their hits.
    this.hitMaterial = new MeshBasicMaterial({ color: RANGE_COLOR });
    this.rangeMaterial = new LineMaterial({ color: RANGE_COLOR, linewidth: 2.5 });
    this.farMaterial = new LineMaterial({ color: RANGE_COLOR, linewidth: 1.5, transparent: true, opacity: 0.35 });
    this.ringMaterial = new LineMaterial({ color: RANGE_COLOR, linewidth: 2 });
    this.spreadFace = new MeshBasicMaterial({ color: RANGE_COLOR, transparent: true, opacity: 0.12, side: DoubleSide, depthWrite: false });
    this.ranges = new Group();
    // Depth-tested as coverage is.
    this.coverage.add(this.cones, this.ranges);
  }

  onAdd(map, gl) {
    this.map = map;
    this.renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;
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

  // Rangefinders.
  get showRanges() {
    return this.ranges.visible;
  }

  set showRanges(on) {
    this.ranges.visible = on;
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
    // A spot's reading, live; only spots take these.
    for (const field of ["status", "distance", "range_accuracy"]) {
      this.zenoh.subscribe(`**/${field}`, (sample) => this.onSpotField(field, sample));
    }
    this.zenoh.subscribe("**/intrinsics", (sample) => this.onLens(sample));
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

  onSpotField(field, sample) {
    if (sample.kind() === SampleKind.DELETE) return; // onSample removes the frame
    const key = sample.keyexpr().toString();
    const frame = this.frames.get(key.slice(0, -(field.length + 1)));
    if (!frame?.spot) return;
    try {
      frame.spot[field] = load(sample.payload().toString()) ?? null;
    } catch (e) {
      console.warn(`frames: ${key}`, e);
      return;
    }
    this.changed();
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

  async discover() {
    const round = ++this.rounds;
    const replies = await this.zenoh.query("**/sr_metadata");
    const topics = replies.flatMap((r) => {
      if (r instanceof Error) return [];
      const meta = parse(r.payload().toString());
      // A camera is a Position too, but it's drawn as its carrier's view
      // (camera coverage, below), and rehydrating one brings its frame along.
      const classes = meta?.classes ?? [];
      return classes.includes("!Position") && !classes.includes("!CameraBase") ? [meta.topic] : [];
    });
    await Promise.all(topics.map((topic) => this.rehydrate(topic, round)));
    // Gone after two rounds without an answer: one can just be lost.
    for (const [topic, frame] of this.frames) if (round - frame.round > 1) this.remove(topic);
    this.changed();
  }

  async rehydrate(topic, round) {
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
      // The exception: a rangefinder spot keeps its reading and beam.
      frame.spot = frame.cls === "BearingDetection" ? Object.fromEntries(SPOT_FIELDS.map((k) => [k, o[k] ?? null])) : null;
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
    this.dirty = false;
    const placed = [...this.frames.values()].filter((f) => f.pose);
    for (const f of placed) {
      [f.lat, f.lon, f.h] = geodetic(f.pose.offset);
      f.world = f.pose.q && angles(levelFrame(f.lat, f.lon, "ned").invert().multiply(f.pose.q));
    }
    this.arrows.clear();
    for (const child of [...this.lines.children, ...this.cones.children]) child.geometry.dispose();
    for (const child of this.ranges.children) if (child.geometry !== POINT) child.geometry.dispose();
    this.lines.clear();
    this.cones.clear();
    this.ranges.clear();
    if (!placed.length) return;

    if (!this.anchor) this.setAnchor([placed[0].lon, placed[0].lat]);
    const ground = this.onGround ? Math.min(...placed.map((f) => f.h)) : 0;
    const a = MercatorCoordinate.fromLngLat(this.anchor, 0);
    const s = a.meterInMercatorCoordinateUnits();
    for (const f of placed) {
      const p = MercatorCoordinate.fromLngLat([f.lon, f.lat], f.h - ground);
      f.at = new Vector3((p.x - a.x) / s, -(p.y - a.y) / s, (p.z - a.z) / s);
      f.inScene = f.pose.q ? levelFrame(f.lat, f.lon, "enu").invert().multiply(f.pose.q) : UNTURNED;
    }

    for (const f of placed) {
      if (f.spot) continue; // drawn along its beam, below
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
      if (parent?.pose && !f.spot) parentLines.push(...f.at.toArray(), ...parent.at.toArray());
    }
    if (parentLines.length) this.lines.add(segments(parentLines, this.parentMaterial));
    for (const f of placed) if (this.isOpen(f)) this.addAccuracy(f);

    for (const f of placed) {
      if (!f.pose.q) continue; // a point has no facing to look along
      for (const camera of f.cameras ?? []) {
        const lens = this.lenses.get(camera);
        if (lens) this.addCoverage(f, lens);
      }
    }

    // Spots, placed or not: one with no return still says why.
    for (const spot of this.frames.values()) {
      const gimbal = spot.spot && this.frames.get(spot.parent?.link);
      if (gimbal?.pose?.q && gimbal.at) this.addSpot(gimbal, spot);
    }
  }

  // A rangefinder spot along its gimbal's beam: a marker where it hit, in the
  // beam's ± range, or a plain ray to it if that's unknown; with nothing
  // within the sensor's max, a faint ray out to it.
  addSpot(g, f) {
    const s = f.spot;
    if (s.status === "ok" && f.pose && f.at) {
      const rings = beamRings(s, g);
      if (rings) this.addBounds(g, rings);
      else this.ranges.add(segments([...g.at.toArray(), ...f.at.toArray()], this.rangeMaterial));
      const marker = new Mesh(POINT, this.hitMaterial);
      marker.matrixAutoUpdate = false;
      marker.userData.at = f.at;
      this.ranges.add(marker);
    } else if (s.status === "far" && s.max) {
      const end = new Vector3(s.max, 0, 0).applyQuaternion(g.inScene).add(g.at);
      this.ranges.add(segments([...g.at.toArray(), ...end.toArray()], this.farMaterial));
    }
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
  // wide as its own position error.
  addBounds(f, rings) {
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
    for (const ring of circles.slice(1)) {
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
    const cone = new Mesh(faces, this.spreadFace);
    cone.frustumCulled = false;
    this.ranges.add(cone, segments(edges, this.ringMaterial));
  }

  // The pose's 90% accuracy: circles of the horizontal radius at the frame and
  // at ± the vertical, joined at the sides. Level, whatever the frame's tilt.
  addAccuracy(f) {
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
    // A spot's shows with the rangefinders, as it does.
    (f.spot ? this.ranges : this.lines).add(segments(lines.map((c, i) => c + f.at.getComponent(i % 3)), this.accuracyMaterial));
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
    for (const material of [this.parentMaterial, this.accuracyMaterial, this.rayMaterial, this.bandEdge, this.rangeMaterial, this.farMaterial, this.ringMaterial]) {
      material.resolution.set(...this.size);
    }

    // Arrows and hit markers a fixed size on screen: scaled by how many
    // pixels a metre is there. The marker is a ball 0.3 across.
    const fixed = (object, at, q, px) => {
      const pxPerM = Math.max(...[[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((d) => this.pixels(at, at.clone().add(new Vector3(...d)))));
      const scale = pxPerM > 0 ? px / pxPerM : 1;
      object.matrix.compose(at, q, new Vector3(scale, scale, scale));
      object.matrixWorldNeedsUpdate = true;
    };
    for (const arrow of this.arrows.children) fixed(arrow, arrow.userData.frame.at, arrow.userData.frame.inScene, ARROW_PX);
    for (const marker of this.ranges.children) if (marker.userData.at) fixed(marker, marker.userData.at, UNTURNED, HIT_PX / 0.3);
    this.renderer.resetState();
    // Coverage and rangefinders first, against the map's depth, so the
    // ground, buildings and Gazebo's models hide them.
    if (this.cones.visible || this.ranges.visible) this.renderer.render(this.coverage, this.camera);
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
  // without dragging the map. A spot's reads its distance instead (spotText),
  // and goes before the others.
  label(f) {
    if (!f.label) {
      const label = el("div", f.spot ? "sf-label sf-spot" : "sf-label");
      const head = el("div", "sf-head");
      head.append(el("b", "", f.spot ? spotText(f) : f.topic));
      head.onclick = () => {
        if (!this.open.delete(f.topic)) this.open.add(f.topic);
        this.changed();
      };
      for (const type of ["pointerdown", "mousedown", "touchstart", "dblclick"]) {
        label.addEventListener(type, (e) => e.stopPropagation());
      }
      label.append(head, el("div", "sf-body"));
      f.label = this.mapLabels.add(`synq/${f.topic}`, label, { priority: f.spot ? 1 : 0 });
    }
    return f.label;
  }

  // An open label's details, as rows of [class, text] pieces: its class,
  // angles, mount, accuracy, place and links.
  details(f) {
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
    const acc = f.pose.accuracy;
    const fmt = (x) => (x == null ? "?" : `${m(x)} m`);
    rows.push(
      acc
        ? [["acc", "± "], ["acc", fmt(acc.horizontal)], ["acc", " horizontal, "], ["acc", fmt(acc.vertical)], ["acc", " vertical (90%)"]]
        : [["acc", "accuracy unknown"]],
      [["", `${f.lat.toFixed(7)}, ${f.lon.toFixed(7)}`], ["k", ", "], ["", f.h.toFixed(2)], ["k", " m above WGS84"]],
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
    // A spot's reading, and the beam it was taken along: the rest of its
    // accuracy is the tree's, in the row above.
    const s = f.spot;
    if (s) {
      const reading =
        s.status === "ok" && s.distance != null
          ? [["", `${m(s.distance)} m`]]
          : s.status === "far"
            ? [["k", "nothing within "], ["", `${s.max} m`]]
            : s.status === "near"
              ? [["k", "nearer than "], ["", `${m(s.min)} m`]]
              : [["k", "silent"]];
      rows.push(
        [["k", "reading: "], ...reading, ["k", s.min != null ? `  (${m(s.min)}–${s.max} m)` : ""]],
        [
          ["k", "beam: "],
          ["acc", s.range_accuracy != null ? `± ${m(s.range_accuracy)} m along` : "along unknown"],
          ["acc", s.pointing_accuracy != null ? `, ± ${s.pointing_accuracy.toFixed(1)}° off it (90%, configured)` : ", pointing unknown"],
        ],
      );
    }
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

  // Each label anchored at its frame's origin, opened or not; the map labels
  // place it below-right of it, clear of the rest. An opened label grows
  // downward, so it stays under the pointer to close it.
  placeLabels() {
    for (const f of this.frames.values()) {
      // A spot's label shows with the rangefinders, the rest with the frames.
      if (!(f.spot ? this.ranges.visible : this.show)) continue;
      const at = f.at && f.pose && this.toScreen(f.at);
      if (!at) continue;
      const label = this.label(f);
      if (f.spot) {
        const text = spotText(f);
        const head = label.firstChild.firstChild;
        if (head.textContent !== text) head.textContent = text;
      }
      const open = this.isOpen(f);
      label.classList.toggle("open", open);
      if (open) this.fill(label.lastChild, this.details(f));
      this.mapLabels.at(`synq/${f.topic}`, at);
    }
  }
}
