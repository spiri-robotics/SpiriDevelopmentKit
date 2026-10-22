import { Math as CesiumMath, Matrix4, Cartesian3 } from "cesium";
import { SDFParser, Scene } from "gzweb";
import * as THREE from "three";

// Gazebo's world, drawn by gzweb, on top of the Cesium globe.
//
// gzweb's Scene and SDFParser build a three.js scene from Gazebo's scene info,
// meshes and materials included. gzweb's own renderer is opaque and its orbit
// controls own the camera, so neither is used. Instead, a transparent canvas
// over Cesium's renders that scene, with a camera copied from Cesium's after
// every frame. Gazebo's world frame is ENU at <spherical_coordinates>, so the
// copy is Cesium's camera expressed in that frame.
//
// It's an overlay, so Gazebo models always draw over the globe; terrain can't
// hide them. Drawing them as Cesium glTF models instead would fix that.
export class GazeboOverlay {
  constructor(viewer, canvas, findAsset) {
    this.viewer = viewer;
    this.canvas = canvas;
    this.fixedToEnu = null;
    this.planes = new Set();

    // gzweb creates its own (unused) renderer and controls here.
    this.gz = new Scene({ shaders: {}, findResourceCb: findAsset });
    this.parser = new SDFParser(this.gz);
    this.parser.usingFilesUrls = true;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      logarithmicDepthBuffer: true,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.camera = new THREE.PerspectiveCamera();

    viewer.scene.postRender.addEventListener(() => this.render());
  }

  get show() {
    return this.canvas.style.display !== "none";
  }

  set show(on) {
    this.canvas.style.display = on ? "" : "none";
  }

  setOrigin(enuToFixed) {
    this.fixedToEnu = Matrix4.inverse(enuToFixed, new Matrix4());
  }

  addModel(model) {
    if (this.gz.getByName(model.name)) return;
    const obj = this.parser.spawnFromObj({ model }, { enableLights: true });
    // Ground planes would hide the map; the map draws their outline instead.
    if (hasPlane(model)) {
      obj.visible = false;
      this.planes.add(model.name);
    }
    this.gz.add(obj);
  }

  addLight(light) {
    this.gz.add(this.parser.spawnLight(light));
  }

  setAmbient(c) {
    this.gz.ambient.color = new THREE.Color(c.r ?? 0, c.g ?? 0, c.b ?? 0);
  }

  removeModel(name) {
    const obj = this.gz.getByName(name);
    if (obj) this.gz.remove(obj);
    this.planes.delete(name);
  }

  clear() {
    this.gz.removeAll();
    this.planes.clear();
  }

  setPose(pose) {
    const obj = this.gz.getByName(pose.name);
    if (!obj) return;
    const p = pose.position ?? {};
    const q = pose.orientation ?? {};
    this.gz.setPose(obj, { x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0 }, { x: q.x ?? 0, y: q.y ?? 0, z: q.z ?? 0, w: q.w ?? 1 });
  }

  render() {
    if (!this.fixedToEnu || !this.show) return;
    const cam = this.viewer.camera;
    const pos = Matrix4.multiplyByPoint(this.fixedToEnu, cam.positionWC, new Cartesian3());
    const dir = Matrix4.multiplyByPointAsVector(this.fixedToEnu, cam.directionWC, new Cartesian3());
    const up = Matrix4.multiplyByPointAsVector(this.fixedToEnu, cam.upWC, new Cartesian3());

    this.camera.position.set(pos.x, pos.y, pos.z);
    this.camera.up.set(up.x, up.y, up.z);
    this.camera.lookAt(pos.x + dir.x, pos.y + dir.y, pos.z + dir.z);
    this.camera.fov = CesiumMath.toDegrees(cam.frustum.fovy);
    this.camera.aspect = cam.frustum.aspectRatio;
    this.camera.near = 0.05;
    this.camera.far = 1e6;
    this.camera.updateProjectionMatrix();

    const { clientWidth: w, clientHeight: h } = this.viewer.canvas;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) {
      this.renderer.setPixelRatio(window.devicePixelRatio);
      this.renderer.setSize(w, h, false);
    }
    this.renderer.render(this.gz.scene, this.camera);
  }
}

export function hasPlane(model) {
  return (model.link ?? []).some((l) => (l.visual ?? []).some((v) => v.geometry?.plane));
}
