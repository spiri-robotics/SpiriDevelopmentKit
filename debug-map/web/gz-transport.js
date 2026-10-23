import { SampleKind } from "@eclipse-zenoh/zenoh-ts";
import protobuf from "protobufjs/light.js";
import gzMsgs from "./gz-msgs.json";

// Gazebo's topics and services, over zenoh: gz-transport's zenoh backend
// puts them there anyway, so the map needs no websocket server in Gazebo
// (whose thread spins a whole core once a client has connected).
//
// A topic is published at `@/<partition>@<topic>` and a service is a
// queryable there, as raw protobuf. A topic is only published while a gz
// node has declared a subscriber to it, as a liveliness token, so subscribing
// declares one too. Worlds are found by the token of their scene/info
// service. See debug-map/index/gz.py, which does the same in Python.
//
// The messages are decoded with gz-msgs' definitions (gz-msgs.json, built
// from gz-msgs' protos by gz-msgs.mjs), with proto field names.

// The gazebo image's GZ_PARTITION.
const PARTITION = "sdk";

const root = protobuf.Root.fromJSON(gzMsgs);

function decode(type, bytes) {
  const t = root.lookupType(type);
  return t.toObject(t.decode(bytes), { longs: Number, enums: String });
}

const key = (topic) => `@/${PARTITION}@${topic}`;

// A gz liveliness token: { kind, process, topic, type }, or null.
// `@gz/%<partition>/<process>/<node>/<node>/<kind>/%/%/%/<topic>/<type>/%/%`,
// with the topic's slashes as `%`. Kinds: MP and MS publish and subscribe to
// messages, SS and SC serve and call services.
function parseToken(token) {
  const c = token.split("/");
  if (c.length < 11 || c[0] !== "@gz") return null;
  return { kind: c[5], process: c[2], topic: c[9].replaceAll("%", "/"), type: c[10] };
}

function subscriberToken(topic, type) {
  const node = crypto.randomUUID();
  return `@gz/%${PARTITION}/${crypto.randomUUID()}/${node}/${node}/MS/%/%/%/${topic.replaceAll("/", "%")}/${type}/%/%`;
}

const SCENE_SERVICE = /^\/world\/([^/]+)\/scene\/info$/;

// The world that's up: `world` is its name, or null. Fires "world" when it
// comes, goes, or is replaced by a restarted Gazebo.
export class Gazebo extends EventTarget {
  #zenoh;
  #servers = new Map(); // token -> { world, process }
  world = null;
  #process = null;

  constructor(zenoh) {
    super();
    this.#zenoh = zenoh;
    zenoh.subscribeLiveliness(`@gz/%${PARTITION}/**`, (sample) => {
      const token = sample.keyexpr().toString();
      const t = parseToken(token);
      const world = t?.kind === "SS" && t.topic.match(SCENE_SERVICE)?.[1];
      if (!world) return;
      if (sample.kind() === SampleKind.DELETE) this.#servers.delete(token);
      else this.#servers.set(token, { world, process: t.process });
      this.#update();
    });
  }

  // The newest world, if several are up.
  #update() {
    const up = [...this.#servers.values()].at(-1);
    if (up?.world === this.world && up?.process === this.#process) return;
    this.world = up?.world ?? null;
    this.#process = up?.process ?? null;
    this.dispatchEvent(new Event("world"));
  }

  // Calls handler(message) for every message on topic, of type (a gz-msgs
  // name such as "gz.msgs.Pose_V"). Returns a function that unsubscribes.
  subscribe(topic, type, handler) {
    const untoken = this.#zenoh.token(subscriberToken(topic, type));
    const unsubscribe = this.#zenoh.subscribe(key(topic), (sample) => {
      let msg;
      try {
        msg = decode(type, sample.payload().toBytes());
      } catch (e) {
        return console.warn(`gz: bad ${type} on ${topic}`, e);
      }
      handler(msg);
    });
    return () => {
      untoken();
      unsubscribe();
    };
  }

  // Calls a service with an empty request, returning its reply decoded as
  // type. A failed call gets no reply at all, so that's what failure looks
  // like.
  async request(service, type, { timeoutMs = 5000 } = {}) {
    const [reply] = await this.#zenoh.query(key(service), { payload: new Uint8Array(0), timeoutMs });
    if (!reply) throw new Error(`no reply from ${service}`);
    if (reply instanceof Error) throw reply;
    return decode(type, reply.payload().toBytes());
  }
}
