import { SceneManager } from "gzweb";

// Relative to this page, so it works both at / and behind SpiriConfig's
// /plugin/<name>/ prefix. Caddy forwards /ws to Gazebo's websocket server.
const wsUrl = new URL("ws", window.location.href);
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

const scene = new SceneManager({ elementId: "gz-scene", websocketUrl: wsUrl.href });

// Gazebo's websocket sends meshes at ~245 KB/s, so fetch them over HTTP from
// the asset server (Caddy's /models) and only fall back to the websocket.
// gzweb has no hook for this; `transport` is private in its TypeScript only.
const transport = scene.transport;
const wsGetAsset = transport.getAsset.bind(transport);
transport.getAsset = (uri, cb) => {
  const path = uri.startsWith("model://")
    ? "model/" + uri.slice("model://".length)
    : uri.startsWith("file://")
      ? "file" + uri.slice("file://".length)
      : uri.startsWith("/")
        ? "file" + uri
        : null;
  if (!path) return wsGetAsset(uri, cb);
  fetch(new URL("models/" + path, window.location.href))
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
    .then((buf) => cb(new Uint8Array(buf)))
    .catch(() => wsGetAsset(uri, cb));
};

const status =document.getElementById("status");
scene.getConnectionStatusAsObservable().subscribe((up) => {
  status.textContent = up ? "connected" : "disconnected";
  status.className = up ? "up" : "down";
});

document.getElementById("reset").onclick = () => scene.resetView();
window.addEventListener("resize", () => scene.resize());

// gzweb has no model-list event, so poll its list.
const list = document.getElementById("models");
let shown = "";
setInterval(() => {
  const names = scene
    .getModels()
    .map((m) => m.name)
    .filter((n) => n && n !== "ground_plane")
    .sort();
  if (names.join("\n") === shown) return;
  shown = names.join("\n");
  list.replaceChildren(
    ...names.map((name) => {
      const li = document.createElement("li");
      const follow = document.createElement("button");
      follow.textContent = "Follow";
      follow.onclick = () => scene.follow(name);
      li.append(name, follow);
      return li;
    }),
  );
}, 1000);
