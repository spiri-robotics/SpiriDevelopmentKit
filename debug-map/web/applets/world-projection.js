// Where a point in the world lands in a camera's picture: SpiriCamera's
// projection.py, ported for camera-overlays.js, so a widget placed on an
// object in the frame tree is drawn here where the camera would burn it in.
// Change the two together.
//
// Poses and lenses are the plain values a rehydrate parses to: a pose's
// offset {x, y, z} and orientation {w, x, y, z} in ECEF, its accuracy
// {horizontal, vertical} (90% bounds); a lens {width, height, fx, fy, cx, cy}.
// A camera's own frame is FRD: x out of the lens, y to the picture's right,
// z down it. The lens is a pinhole, with no distortion.

const NEAR = 0.01; // m along the optical axis: anything closer is behind the camera
const RING = 16; // points around the accuracy cylinder whose projections bound its circle
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });

// v rotated by the quaternion q, as SpiriSynq's Offset.rotate_by.
function rotate(v, q) {
  const n = Math.hypot(q.w, q.x, q.y, q.z);
  const [w, x, y, z] = [q.w / n, q.x / n, q.y / n, q.z / n];
  return {
    x: (1 - 2 * (y * y + z * z)) * v.x + 2 * (x * y - z * w) * v.y + 2 * (x * z + y * w) * v.z,
    y: 2 * (x * y + z * w) * v.x + (1 - 2 * (x * x + z * z)) * v.y + 2 * (y * z - x * w) * v.z,
    z: 2 * (x * z - y * w) * v.x + 2 * (y * z + x * w) * v.y + (1 - 2 * (x * x + y * y)) * v.z,
  };
}

// An ECEF point in the camera's own frame, or null if the camera has no axes.
function toCamera(camera, point) {
  const q = camera.orientation;
  if (!q) return null;
  return rotate(sub(point, camera.offset), { w: q.w, x: -q.x, y: -q.y, z: -q.z });
}

// A point in the camera's frame as a pixel of lens, or null behind it.
function pixel(lens, local) {
  if (local.x < NEAR) return null;
  return [lens.cx + (lens.fx * local.y) / local.x, lens.cy + (lens.fy * local.z) / local.x];
}

// East, north and up at an ECEF point, up being the ellipsoid's normal.
function levelAxes(p) {
  const r = Math.hypot(p.x, p.y);
  const lam = Math.atan2(p.y, p.x);
  let phi = Math.atan2(p.z, r * (1 - WGS84_E2));
  for (let i = 0; i < 10; i++) {
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(phi) ** 2);
    phi = Math.atan2(p.z + WGS84_E2 * n * Math.sin(phi), r);
  }
  const [sp, cp, sl, cl] = [Math.sin(phi), Math.cos(phi), Math.sin(lam), Math.cos(lam)];
  return [
    { x: -sl, y: cl, z: 0 },
    { x: -sp * cl, y: -sp * sl, z: cp },
    { x: cp * cl, y: cp * sl, z: sp },
  ];
}

// The radius around centre holding the point's 90% accuracy cylinder, or
// null when it's unknown or reaches behind the camera.
function radius(camera, lens, point, centre) {
  const h = point.accuracy?.horizontal;
  if (h == null) return null;
  const v = point.accuracy.vertical;
  const [east, north, up] = levelAxes(point.offset);
  let r = 0;
  for (let i = 0; i < RING; i++) {
    const a = (2 * Math.PI * i) / RING;
    const across = add(scale(east, h * Math.cos(a)), scale(north, h * Math.sin(a)));
    for (const dz of v ? [-v, v] : [0]) {
      const local = toCamera(camera, add(add(point.offset, across), scale(up, dz)));
      const seen = local && pixel(lens, local);
      if (!seen) return null;
      r = Math.max(r, Math.hypot(seen[0] - centre[0], seen[1] - centre[1]));
    }
  }
  return r;
}

// Whether any of a view's circle is on a width x height frame.
export function visible(view, width, height) {
  const r = view.r ?? 0;
  return -r <= view.x && view.x <= width + r && -r <= view.y && view.y <= height + r;
}

// Where point is in a width x height frame from camera: {x, y, r, range,
// edge}, as projection.py's View, or null when it's behind the camera, the
// camera has no axes, or anything it takes is unknown.
export function project(camera, lens, point, width, height) {
  if (!camera?.offset || !point?.offset || !lens?.width || !lens?.height) return null;
  const [sx, sy] = [width / lens.width, height / lens.height];
  const scaled = { fx: lens.fx * sx, fy: lens.fy * sy, cx: lens.cx * sx, cy: lens.cy * sy };
  const local = toCamera(camera, point.offset);
  const centre = local && pixel(scaled, local);
  if (!centre) return null;
  const [x, y] = centre;
  const r = radius(camera, scaled, point, centre);
  const view = { x, y, r, range: Math.hypot(local.x, local.y, local.z), edge: false };
  const rr = r ?? 0;
  const inside = rr <= x && x <= width - rr && rr <= y && y <= height - rr;
  view.edge = visible(view, width, height) && !inside;
  return view;
}
