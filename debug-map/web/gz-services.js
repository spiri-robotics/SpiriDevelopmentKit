// Gazebo's services, called over zenoh, as sim-agent calls them: gz-transport's
// zenoh backend serves /world/<world>/<service> as a queryable at
// `@/<partition>@/world/<world>/<service>`, taking and returning raw protobuf.
// The few messages needed are encoded by hand.

// The gazebo image's GZ_PARTITION.
const PARTITION = "sdk";

function varint(n) {
  const out = [];
  for (; n > 0x7f; n >>>= 7) out.push((n & 0x7f) | 0x80);
  out.push(n);
  return out;
}

const bytes = (field, data) => [...varint((field << 3) | 2), ...varint(data.length), ...data];
const string = (field, s) => bytes(field, new TextEncoder().encode(s));

function double(field, x) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x, true);
  return [...varint((field << 3) | 1), ...b];
}

// gz.msgs.Pose: name = 2, position = 4 (Vector3d: x, y, z = 2, 3, 4),
// orientation = 5 (Quaternion: x, y, z, w = 2, 3, 4, 5).
function poseMsg(name, { position: p, orientation: q }) {
  return new Uint8Array([
    ...string(2, name),
    ...bytes(4, [...double(2, p.x), ...double(3, p.y), ...double(4, p.z)]),
    ...bytes(5, [...double(2, q.x), ...double(3, q.y), ...double(4, q.z), ...double(5, q.w)]),
  ]);
}

// gz.msgs.Boolean: data = 2. Proto3 leaves out false, so empty is false.
const boolean = (b) => b.length >= 2 && b[b.length - 2] === 0x10 && b[b.length - 1] === 1;

// Calls a world service; throws unless it answers true. A failed call gets
// no reply at all, so that's what failure looks like.
async function call(zenoh, world, service, payload) {
  const [reply] = await zenoh.query(`@/${PARTITION}@/world/${world}/${service}`, { payload, timeoutMs: 5000 });
  if (!reply) throw new Error(`no reply from ${world}/${service}`);
  if (reply instanceof Error) throw reply;
  if (!boolean(reply.payload().toBytes())) throw new Error(`${world}/${service} refused`);
}

// Teleports a top-level model to a pose in the world's ENU frame. Its
// velocities are kept.
export function setPose(zenoh, world, name, pose) {
  return call(zenoh, world, "set_pose", poseMsg(name, pose));
}
