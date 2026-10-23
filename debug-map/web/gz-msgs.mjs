// Writes the gz-msgs definitions the map decodes, as protobufjs JSON, to
// stdout. Run at build time with gz-msgs' proto directory:
//
//   node gz-msgs.mjs /gz-msgs/proto > gz-msgs.json
import { join } from "node:path";
import protobuf from "protobufjs";

const TYPES = ["empty", "scene", "pose_v", "uint32_v"];

const [dir] = process.argv.slice(2);
const root = new protobuf.Root();
// gz-msgs imports each other as gz/msgs/<name>.proto; protobufjs has
// google/protobuf's own.
root.resolvePath = (_, target) => (target.startsWith("google/protobuf/") ? target : join(dir, target));
root.loadSync(
  TYPES.map((t) => `gz/msgs/${t}.proto`),
  { keepCase: true },
);
process.stdout.write(JSON.stringify(root.toJSON()));
