import { parse } from "yaml";
import "./cameras.css";

// Every SpiriCamera on SpiriSynq, real or simulated, and what it sees.
//
// Cameras are found by SpiriSynq discovery (`**/sr_metadata`): any object
// whose classes include Camera. Opening one adds a tile showing its `image`
// field, a JPEG. Frames are fetched from zenoh-index, not subscribed to: a
// camera publishes at its own rate and size, and one full-rate stream is
// enough to starve the page's websocket (docs/architecture.md). Each tile
// asks for the next frame only once the last one is drawn, at most at the
// rate picked on it, so a slow link shows fewer frames instead of falling
// behind.

const DISCOVER_MS = 5000;
const STALE_MS = 3000; // a tile with no new frame for this long says so
const RATES = [1, 5, 10, 30];
const isCamera = (classes) => classes.some((c) => /^!(Camera|CameraBase)$/.test(c));

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

export default {
  title: "Cameras",
  group: "Sensors",
  keywords: ["camera", "video", "image", "spiricamera", "gimbal", "spirisynq"],
  icon: "◉",
  order: 10,
  mount(body, { zenoh, store }) {
    body.classList.add("cams");
    const saved = () => ({ open: [], rates: {}, ...store.get() });

    const status = el("div", "status", "Looking for cameras…");
    const list = el("div", "list");
    const tiles = el("div", "tiles");
    body.append(status, list, tiles);

    // Found cameras by topic: { node, gone }.
    const cameras = new Map();
    // Open tiles by topic.
    const open = new Map();
    let stopped = false;

    function renderList() {
      const topics = [...cameras.keys()].sort();
      status.textContent = topics.length ? "" : "No cameras found.";
      status.hidden = !!topics.length;
      list.replaceChildren(
        ...topics.map((topic) => {
          const c = cameras.get(topic);
          const row = el("label", `row${c.gone ? " gone" : ""}`);
          const box = el("input");
          box.type = "checkbox";
          box.checked = open.has(topic);
          box.onchange = () => (box.checked ? openTile(topic) : closeTile(topic));
          row.title = c.gone ? "No longer answering discovery" : `on node ${c.node}`;
          row.append(box, el("span", "", topic));
          return row;
        }),
      );
    }

    function remember() {
      const s = saved();
      store.set({ ...s, open: [...open.keys()] });
    }

    function openTile(topic) {
      if (open.has(topic)) return;
      const tile = new Tile(topic, zenoh, saved().rates[topic] ?? 10, (rate) => {
        const s = saved();
        store.set({ ...s, rates: { ...s.rates, [topic]: rate } });
      });
      tile.close.onclick = () => closeTile(topic);
      open.set(topic, tile);
      tiles.append(tile.root);
      remember();
      renderList();
    }

    function closeTile(topic) {
      open.get(topic)?.stop();
      open.delete(topic);
      remember();
      renderList();
    }

    // Discovery. A camera that stops answering is kept, greyed out, so an
    // open tile doesn't vanish while its robot restarts.
    (async () => {
      while (!stopped) {
        try {
          const replies = await zenoh.query("**/sr_metadata");
          const seen = new Map();
          for (const r of replies) {
            if (r instanceof Error) continue;
            try {
              const meta = parse(r.payload().toString());
              if (isCamera(meta.classes ?? [])) seen.set(meta.topic, meta.authoritive_node);
            } catch (e) {
              console.warn("cameras: bad sr_metadata", e);
            }
          }
          for (const [topic, node] of seen) cameras.set(topic, { node, gone: false });
          for (const [topic, c] of cameras) if (!seen.has(topic)) c.gone = true;
          for (const topic of saved().open) if (cameras.has(topic)) openTile(topic);
          for (const [topic, tile] of open) tile.setGone(cameras.get(topic)?.gone ?? true);
          if (!stopped) renderList();
        } catch (e) {
          console.warn("cameras: discovery failed", e);
        }
        await sleep(DISCOVER_MS);
      }
    })();

    return () => {
      stopped = true;
      for (const tile of open.values()) tile.stop();
    };
  },
};

// One camera's picture, kept up to date from zenoh-index.
class Tile {
  constructor(topic, zenoh, rate, onRate) {
    this.topic = topic;
    this.zenoh = zenoh;
    this.rate = rate;
    this.stopped = false;
    this.count = null; // the index's message count for the frame shown
    this.url = null;
    this.lastNew = 0;
    this.frames = []; // times new frames were drawn, for the fps shown

    this.root = el("figure", "tile");
    const head = el("figcaption");
    const rates = el("select");
    rates.title = "Most frames per second to fetch";
    for (const r of RATES) rates.append(new Option(`${r} fps`, r, false, r === rate));
    rates.onchange = () => {
      this.rate = Number(rates.value);
      onRate(this.rate);
    };
    this.close = el("button", "", "×");
    this.close.title = "Close";
    head.append(el("span", "name", topic), rates, this.close);
    this.img = el("img");
    this.img.alt = topic;
    this.info = el("div", "info", "Waiting for a frame…");
    this.root.append(head, this.img, this.info);
    this.loop();
  }

  setGone(gone) {
    this.root.classList.toggle("gone", gone);
  }

  async loop() {
    while (!this.stopped) {
      const started = performance.now();
      try {
        await this.fetch();
      } catch (e) {
        this.info.textContent = `zenoh-index: ${e.message}`;
      }
      const wait = 1000 / this.rate - (performance.now() - started);
      await sleep(Math.max(wait, 0));
    }
  }

  async fetch() {
    const [reply] = await this.zenoh.query("@sdk/index/value", { payload: `${this.topic}/image` });
    if (this.stopped) return;
    const now = performance.now();
    if (!reply || reply instanceof Error) {
      if (now - this.lastNew > STALE_MS) this.info.textContent = reply ? reply.message : "No frames yet.";
      return;
    }
    const count = reply.attachment()?.toString();
    if (count === this.count) {
      if (now - this.lastNew > STALE_MS) this.info.textContent = `No new frame for ${((now - this.lastNew) / 1000).toFixed(0)} s`;
      return;
    }
    this.count = count;
    const bytes = reply.payload().toBytes();
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    await new Promise((resolve) => {
      this.img.onload = this.img.onerror = resolve;
      this.img.src = url;
    });
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = url;
    this.lastNew = now;
    this.frames = [...this.frames.filter((t) => now - t < 2000), now];
    const fps = this.frames.length > 1 ? ((this.frames.length - 1) * 1000) / (now - this.frames[0]) : 0;
    this.info.textContent = `${this.img.naturalWidth}×${this.img.naturalHeight} · ${kb(bytes.length)} · ${fps.toFixed(1)} fps shown`;
  }

  stop() {
    this.stopped = true;
    this.root.remove();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}
