import { MercatorCoordinate } from "maplibre-gl";
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Camera,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector3,
  Vector4,
  WebGLRenderer,
  sRGBEncoding,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Gazebo's world, drawn by three.js as a MapLibre custom layer: it shares the
// map's GL context and depth buffer, so it's depth-tested with everything else
// on the map. MapLibre only draws a frame when something changes; this layer
// asks for one (triggerRepaint) when a model is added, removed or visibly
// moved, so a still world costs nothing.
//
// Built straight from Gazebo's scene info. Mesh visuals are glTF that the
// asset server converts from Gazebo's meshes (see gazebo/gz/asset_server.py);
// box, cylinder, cone, sphere, ellipsoid and capsule visuals are three.js
// geometry. Planes aren't drawn (main.js outlines them), nor heightmaps.
//
// Models, nested models and links are three.js groups keyed by Gazebo's entity
// id, each posed relative to its parent, as both scene info and
// dynamic_pose/info give them. The scene is the world's ENU frame in metres,
// Z up; the camera's matrix places it on the map at <spherical_coordinates>.
//
// Each top-level model can carry a label: a DOM element kept over the model's
// origin, so it's readable at any distance. A labelled model also gets a drop
// line from its origin straight down to the ground, with its height above
// that ground beside the line's foot.
//
// The models and the labels show and hide apart: `show` is the 3D models,
// `showEntities` the labels, drop lines and heights.
export class GazeboWorld {
  id = "gazebo-3d";
  type = "custom";
  renderingMode = "3d";
  motionTimer = null;
  lastMotion = 0;

  constructor() {
    this.map = null;
    this.renderer = null;
    this.scene = new Scene();
    this.camera = new Camera();
    this.origin = null; // ENU metres -> mercator units
    this.anchor = null; // [lng, lat], and the world's elevation
    this.elevation = 0;
    this.onGround = false;
    this.frames = new Map(); // entity id -> group
    this.roots = new Map(); // top-level model name -> group
    this.labels = new Map(); // top-level model name -> element
    this.drops = new Map(); // top-level model name -> { line, tag }
    this.dropMaterial = new LineBasicMaterial({ color: 0xffa500 });
    this.meshes = new Map(); // glTF url -> Promise of its scene

    // Gazebo's lights aren't carried over. Light from overhead, a little
    // south-east, so models look the same at any hour.
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.3, -0.4, 1);
    this.scene.add(sun, new AmbientLight(0xffffff, 0.6));
    this.world = new Group();
    // Drop lines, apart from the models so they hide with the labels.
    this.markers = new Group();
    this.scene.add(this.world, this.markers);
  }

  onAdd(map, gl) {
    this.map = map;
    this.renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl });
    this.renderer.autoClear = false;
    this.renderer.outputEncoding = sRGBEncoding;
    this.overlay = document.createElement("div");
    this.overlay.className = "gz-labels";
    this.overlay.hidden = !this.markers.visible;
    map.getCanvasContainer().append(this.overlay);
  }

  onRemove() {
    this.overlay.remove();
  }

  render(gl, { defaultProjectionData }) {
    if (!this.origin) return;
    // In doubles, then once to the GPU: the scene's coordinates stay small
    // metres, so float precision holds at any zoom.
    this.camera.projectionMatrix.fromArray(defaultProjectionData.mainMatrix).multiply(this.origin);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.placeDrops();
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  // The ground's height in the world's ENU frame at a point: the terrain's,
  // where there's terrain and it has loaded there; else the flat map's, z=0.
  groundAt(x, y) {
    if (this.onGround) return 0;
    const at = new Vector3(x, y, 0).applyMatrix4(this.origin);
    const lngLat = new MercatorCoordinate(at.x, at.y, 0).toLngLat();
    const h = this.map.queryTerrainElevation(lngLat);
    return h == null ? 0 : h - this.elevation;
  }

  // Runs before each frame: models move and terrain tiles load, both of which
  // repaint.
  placeDrops() {
    const p = new Vector3();
    for (const [name, { line }] of this.drops) {
      p.setFromMatrixPosition(this.roots.get(name).matrix);
      const ground = this.groundAt(p.x, p.y);
      line.geometry.attributes.position.setXYZ(0, p.x, p.y, p.z);
      line.geometry.attributes.position.setXYZ(1, p.x, p.y, ground);
      line.geometry.attributes.position.needsUpdate = true;
      line.geometry.computeBoundingSphere();
      line.userData.height = p.z - ground;
    }
  }

  repaint() {
    this.map?.triggerRepaint();
  }

  // A repaint for motion, at most MOTION_FPS a second. Gazebo publishes poses
  // at 60 Hz and a spinning rotor moves on every one; the camera moving still
  // draws at the display's rate.
  repaintMotion() {
    if (!this.map || this.motionTimer) return;
    const wait = Math.max(0, this.lastMotion + 1000 / MOTION_FPS - performance.now());
    this.motionTimer = setTimeout(() => {
      this.motionTimer = null;
      this.lastMotion = performance.now();
      this.map.triggerRepaint();
    }, wait);
  }

  get show() {
    return this.world.visible;
  }

  set show(on) {
    this.world.visible = on;
    this.repaint();
  }

  get showEntities() {
    return this.markers.visible;
  }

  set showEntities(on) {
    this.markers.visible = on;
    this.overlay && (this.overlay.hidden = !on);
    this.repaint();
  }

  // The world's georeference: ENU metres at lng/lat, its origin `elevation`
  // metres above sea level.
  setOrigin(lngLat, elevation) {
    this.anchor = lngLat;
    this.elevation = elevation;
    this.place();
  }

  // With terrain, the world sits at its own elevation, the one its robots
  // report; without, on the flat map's ground at sea level.
  setTerrain(on) {
    this.onGround = !on;
    this.place();
  }

  place() {
    if (!this.anchor) return;
    const at = MercatorCoordinate.fromLngLat(this.anchor, this.onGround ? 0 : this.elevation);
    const s = at.meterInMercatorCoordinateUnits();
    // Mercator's y grows southward; ENU's north is up.
    this.origin = new Matrix4().makeTranslation(at.x, at.y, at.z).scale(new Vector3(s, -s, s));
    this.repaint();
  }

  // Where a top-level model is, as [lng, lat], or null.
  lngLatOf(name) {
    const root = this.roots.get(name);
    if (!root || !this.origin) return null;
    const p = new Vector3().setFromMatrixPosition(root.matrix).applyMatrix4(this.origin);
    return new MercatorCoordinate(p.x, p.y, p.z).toLngLat().toArray();
  }

  // The height of what's under a point, in the world's ENU frame: the
  // topmost of Gazebo's own models there (the place's ground, a roof) other
  // than `except`, so it's the surface models actually stand on; else the
  // terrain's (groundAt). Casts a ray, so it's for a move, not every frame.
  surfaceAt(x, y, except = null) {
    this.world.updateMatrixWorld(true);
    const skip = this.roots.get(except);
    const targets = this.world.children.filter((root) => root !== skip);
    const ray = new Raycaster(new Vector3(x, y, 1e4), new Vector3(0, 0, -1));
    const [hit] = ray.intersectObjects(targets, true);
    return hit ? hit.point.z : this.groundAt(x, y);
  }

  // A top-level model's pose in the world's ENU frame, or null.
  poseOf(name) {
    const root = this.roots.get(name);
    if (!root) return null;
    const [p, q] = [new Vector3(), new Quaternion()];
    root.matrix.decompose(p, q, new Vector3());
    return { position: { x: p.x, y: p.y, z: p.z }, orientation: { x: q.x, y: q.y, z: q.z, w: q.w } };
  }

  addModel(model, label) {
    if (this.roots.has(model.name)) return;
    const root = this.addFrame(model);
    this.world.add(root);
    this.roots.set(model.name, root);
    if (label) {
      this.labels.set(model.name, label);
      this.overlay?.append(label);
      this.addDrop(model.name);
    }
    this.repaint();
  }

  addDrop(name) {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(6, 3));
    const line = new Line(geometry, this.dropMaterial);
    line.frustumCulled = false;
    this.markers.add(line);
    const tag = document.createElement("div");
    tag.className = "gz-height";
    this.overlay?.append(tag);
    this.drops.set(name, { line, tag });
  }

  removeDrop(name) {
    const drop = this.drops.get(name);
    if (!drop) return;
    this.drops.delete(name);
    this.markers.remove(drop.line);
    drop.line.geometry.dispose();
    drop.tag.remove();
  }

  removeModel(name) {
    const root = this.roots.get(name);
    if (!root) return;
    this.roots.delete(name);
    this.labels.get(name)?.remove();
    this.labels.delete(name);
    this.removeDrop(name);
    this.world.remove(root);
    root.traverse((o) => {
      this.frames.delete(o.userData.gzId);
      if (o.userData.owned) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
    this.repaint();
  }

  clear() {
    for (const name of [...this.roots.keys()]) this.removeModel(name);
  }

  // Returns whether a visible move happened.
  setPose(pose) {
    const frame = this.frames.get(pose.id);
    if (!frame) return false;
    // Gazebo sends every pose at its publication rate, moving or not; only
    // a visible move (0.1 mm, or about as many mrad) is worth a redraw;
    // physics jitters a resting robot by microns.
    const m = poseMatrix(pose);
    if (nearlyEqual(m, frame.matrix, 1e-4)) return false;
    frame.matrix.copy(m);
    frame.matrixWorldNeedsUpdate = true;
    this.repaintMotion();
    return true;
  }

  // A model or link, its visuals, and (for a model) its links and nested models.
  addFrame(entity) {
    const frame = new Group();
    frame.matrixAutoUpdate = false;
    frame.matrix.copy(poseMatrix(entity.pose));
    frame.userData.gzId = entity.id;
    this.frames.set(entity.id, frame);
    for (const child of [...(entity.model ?? []), ...(entity.link ?? [])]) frame.add(this.addFrame(child));
    for (const visual of entity.visual ?? []) {
      const v = this.addVisual(visual);
      if (v) frame.add(v);
    }
    return frame;
  }

  addVisual(visual) {
    const geom = visual.geometry ?? {};
    const holder = new Group();
    holder.matrixAutoUpdate = false;
    const scale = [visual.scale, geom.mesh?.scale].reduce(
      (s, k) => (k ? s.multiply(new Vector3(k.x ?? 1, k.y ?? 1, k.z ?? 1)) : s),
      new Vector3(1, 1, 1),
    );
    holder.matrix.copy(poseMatrix(visual.pose)).scale(scale);
    const color = visualColor(visual);

    if (geom.mesh) {
      const url = meshUrl(geom.mesh.filename);
      if (!url) {
        console.warn(`Gazebo mesh ${geom.mesh.filename}: not served, skipped`);
        return null;
      }
      // A submesh visual draws the whole mesh; nothing here uses one yet.
      this.loadMesh(url).then(
        (scene) => {
          const mesh = scene.clone();
          // An SDF material overrides the mesh's own, as it does in Gazebo.
          if (color) {
            const material = colorMaterial(color);
            mesh.traverse((o) => o.isMesh && (o.material = material));
          }
          holder.add(mesh);
          this.repaint();
        },
        (e) => console.error(`Gazebo mesh ${geom.mesh.filename}:`, e),
      );
      return holder;
    }

    const shape = shapeGeometry(geom);
    if (!shape) return null;
    const mesh = new Mesh(shape, colorMaterial(color ?? { r: 0.7, g: 0.7, b: 0.7, a: 1 }));
    mesh.userData.owned = true;
    holder.add(mesh);
    return holder;
  }

  // Each mesh file is fetched and parsed once; visuals share its geometry.
  loadMesh(url) {
    if (!this.meshes.has(url)) {
      const loaded = new GLTFLoader().loadAsync(url).then(({ scene }) => {
        // The server writes Y-up glTF; Gazebo, and this scene, are Z-up.
        const zUp = new Group();
        zUp.rotation.x = Math.PI / 2;
        zUp.add(scene);
        return zUp;
      });
      this.meshes.set(url, loaded);
    }
    return this.meshes.get(url);
  }

  placeLabels() {
    if (!this.labels.size) return;
    const canvas = this.map.getCanvas();
    const [w, h] = [canvas.clientWidth, canvas.clientHeight];
    const p = new Vector4();
    const toScreen = (v) => [((v.x / v.w + 1) / 2) * w, ((1 - v.y / v.w) / 2) * h];
    // The heading is turned on the ground, not by projecting a point ahead of
    // the model: seen from in front or behind, that point lands on the model
    // and its direction is noise. The map's bearing turns it, and its pitch
    // shortens the part pointing into the screen.
    const bearing = (this.map.getBearing() * Math.PI) / 180;
    const tilt = Math.cos((this.map.getPitch() * Math.PI) / 180);
    const [cb, sb] = [Math.cos(bearing), Math.sin(bearing)];
    for (const [name, label] of this.labels) {
      const root = this.roots.get(name);
      p.set(0, 0, 0, 1).applyMatrix4(root.matrix).applyMatrix4(this.camera.projectionMatrix);
      // Behind the camera.
      if (p.w <= 0) {
        label.hidden = true;
        continue;
      }
      label.hidden = false;
      const [x, y] = toScreen(p);
      label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      // Its heading is the model's +X (east and north parts); pointing
      // straight up or down, it has none, so keep the last.
      const [east, north] = [root.matrix.elements[0], root.matrix.elements[1]];
      if (Math.hypot(east, north) > 1e-6) {
        const right = east * cb - north * sb;
        const ahead = (east * sb + north * cb) * tilt;
        label.style.setProperty("--heading", `${Math.atan2(right, ahead).toFixed(3)}rad`);
      }
    }
    // Heights, beside the drop line's foot.
    for (const { line, tag } of this.drops.values()) {
      const pos = line.geometry.attributes.position;
      p.set(pos.getX(1), pos.getY(1), pos.getZ(1), 1).applyMatrix4(this.camera.projectionMatrix);
      tag.hidden = p.w <= 0;
      if (tag.hidden) continue;
      const [x, y] = toScreen(p);
      tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      tag.textContent = `${line.userData.height.toFixed(1)} m`;
    }
  }
}

const MOTION_FPS = 30;

const MESHES = [".dae", ".stl", ".obj"];

// The asset server's glTF for a Gazebo mesh URI, relative to this page (Caddy
// forwards /models to it), or null for one it can't serve, such as Fuel's.
function meshUrl(uri) {
  if (!uri) return null;
  const path = uri.startsWith("model://")
    ? "model/" + uri.slice("model://".length)
    : uri.startsWith("file://")
      ? "file" + uri.slice("file://".length)
      : uri.startsWith("/")
        ? "file" + uri
        : /^[a-z][a-z0-9+.-]*:/i.test(uri)
          ? null
          : "model/" + uri;
  if (!path) return null;
  const lower = path.toLowerCase();
  const suffix = MESHES.some((e) => lower.endsWith(e)) ? ".glb" : lower.endsWith(".glb") || lower.endsWith(".gltf") ? "" : null;
  if (suffix === null) return null;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return new URL(`models/gltf/${encoded}${suffix}`, window.location.href).href;
}

// three.js geometry for Gazebo's simple shapes, centred on the visual's frame
// and Z-up as Gazebo's are (three.js's round shapes are Y-up, so turned).
function shapeGeometry(geom) {
  const n = (x, d = 0) => Number(x ?? d);
  const zUp = (g) => g.rotateX(Math.PI / 2);
  if (geom.box) {
    const s = geom.box.size ?? {};
    return new BoxGeometry(n(s.x, 1), n(s.y, 1), n(s.z, 1));
  }
  if (geom.cylinder || geom.cone) {
    const g = geom.cylinder ?? geom.cone;
    const r = n(g.radius);
    return zUp(new CylinderGeometry(geom.cone ? 0 : r, r, n(g.length), 32));
  }
  if (geom.sphere) return new SphereGeometry(n(geom.sphere.radius), 32, 16);
  if (geom.ellipsoid) {
    const r = geom.ellipsoid.radii ?? {};
    return new SphereGeometry(1, 32, 16).scale(n(r.x), n(r.y), n(r.z));
  }
  if (geom.capsule) return zUp(new CapsuleGeometry(n(geom.capsule.radius), n(geom.capsule.length), 8, 32));
  return null;
}

// The visual's SDF diffuse colour, if it has one, with its transparency.
function visualColor(visual) {
  const d = visual.material?.diffuse;
  if (!d) return null;
  // proto3 leaves zeros out, so a missing alpha is ambiguous; take it as opaque.
  const a = (d.a || 1) * (1 - (visual.transparency ?? 0));
  return { r: d.r ?? 0, g: d.g ?? 0, b: d.b ?? 0, a };
}

function colorMaterial({ r, g, b, a }) {
  return new MeshLambertMaterial({ color: new Color(r, g, b), opacity: a, transparent: a < 1 });
}

function poseMatrix(pose) {
  const p = pose?.position ?? {};
  const q = pose?.orientation ?? {};
  return new Matrix4().compose(
    new Vector3(p.x ?? 0, p.y ?? 0, p.z ?? 0),
    new Quaternion(q.x ?? 0, q.y ?? 0, q.z ?? 0, q.w ?? 1),
    new Vector3(1, 1, 1),
  );
}

function nearlyEqual(a, b, eps) {
  return a.elements.every((x, i) => Math.abs(x - b.elements[i]) <= eps);
}
