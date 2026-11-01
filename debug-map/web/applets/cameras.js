import { parse } from "yaml";
import { ANCHORS, CameraOverlays, declaredObjects, worldPlacement } from "./camera-overlays.js";
import { exifTags } from "./jpeg-exif.js";
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
//
// Under each tile are the camera's overlays (camera-overlays.js). A camera
// that draws them itself burns them into the frame; one that leaves them to
// its viewer (overlay_client_render) has them drawn over the tile here, at
// frame scale, or at screen size as CameraDebugUi's "Scale overlays to
// viewport" does. Widgets can be turned on and off there, and the camera
// switched between drawing them itself and leaving them to its viewers.

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
    const saved = () => ({ open: [], rates: {}, screen: {}, ...store.get() });

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
      const s = saved();
      const tile = new Tile(topic, zenoh, {
        rate: s.rates[topic] ?? 10,
        screen: s.screen[topic] ?? true,
        onChange: (key, value) => {
          const s = saved();
          store.set({ ...s, [key]: { ...s[key], [topic]: value } });
        },
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

// One camera's picture, kept up to date from zenoh-index, with its overlays.
class Tile {
  constructor(topic, zenoh, { rate, screen, onChange }) {
    this.topic = topic;
    this.zenoh = zenoh;
    this.rate = rate;
    this.screen = screen;
    this.stopped = false;
    this.count = null; // the index's message count for the frame shown
    this.url = null;
    this.lastNew = 0;
    this.frames = []; // times new frames were drawn, for the fps shown
    this.counts = []; // [time, count] per new frame, for the camera's own rate
    this.frame = null; // what overlay templates see as frame.*
    this.exif = {};
    this.svg = "";
    this.panelKey = "";

    this.root = el("figure", "tile");
    const head = el("figcaption");
    const rates = el("select");
    rates.title = "Most frames per second to fetch";
    for (const r of RATES) rates.append(new Option(`${r} fps`, r, false, r === rate));
    rates.onchange = () => {
      this.rate = Number(rates.value);
      onChange("rates", this.rate);
    };
    this.close = el("button", "", "×");
    this.close.title = "Close";
    head.append(el("span", "name", topic), rates, this.close);
    this.img = el("img");
    this.img.alt = topic;
    this.overlay = el("div", "overlay");
    const view = el("div", "view");
    view.append(this.img, this.overlay);
    this.view = view;
    this.info = el("div", "info", "Waiting for a frame…");

    this.panel = el("details", "overlays");
    this.summary = el("summary", "", "Overlays");
    const screenBox = el("input");
    screenBox.type = "checkbox";
    screenBox.checked = screen;
    screenBox.onchange = () => {
      this.screen = screenBox.checked;
      onChange("screen", this.screen);
      this.redraw();
    };
    this.screenRow = el("label", "screen");
    this.screenRow.title = "Draw overlays at their own size on screen, rather than scaled with the frame";
    this.screenRow.append(screenBox, el("span", "", "At screen size"));
    // Who draws them is the camera's setting, so it changes them for every
    // viewer, not just this tile.
    this.mode = el("select");
    this.mode.title = "Set on the camera, for everyone watching it";
    this.mode.append(new Option("Server side: the camera burns them in", "server"), new Option("Client side: each viewer draws them", "client"));
    this.mode.onchange = () => this.write(this.overlays.setClientRender(this.mode.value === "client"));
    const modeRow = el("label", "mode");
    modeRow.append(el("span", "", "Rendering"), this.mode);
    this.widgetList = el("div", "widgets");
    this.panel.append(this.summary, modeRow, this.screenRow, this.widgetList);
    this.root.append(head, view, this.info, this.panel);

    this.overlays = new CameraOverlays(zenoh, topic, () => this.redraw());
    this.resize = new ResizeObserver(() => this.redraw());
    this.resize.observe(view);
    this.loop();
  }

  // At most once a frame, however many things changed.
  redraw() {
    if (this.pending || this.stopped) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.draw();
    });
  }

  draw() {
    let canvas = this.frame;
    if (canvas && this.screen) {
      // The frame's letterboxed size on screen, as object-fit draws it.
      const box = this.view.getBoundingClientRect();
      const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
      if (scale > 0) canvas = { width: Math.max(1, Math.round(canvas.width * scale)), height: Math.max(1, Math.round(canvas.height * scale)) };
    }
    const svg = this.overlays.render(this.frame ?? {}, this.exif, canvas);
    if (svg !== this.svg) this.overlay.innerHTML = this.svg = svg;
    this.drawPanel();
  }

  // A change to the camera, reported if it fails. Either way the panel is
  // rebuilt, so a control left showing what was picked goes back to what the
  // camera says until the camera says otherwise.
  write(promise) {
    promise
      .catch((e) => (this.info.textContent = `Couldn't change the camera: ${e.message}`))
      .finally(() => {
        this.panelKey = "";
        this.redraw();
      });
  }

  // Every widget found, on or off for this camera; for those on, how each
  // is placed, what it reads, and whether it was drawn. Rebuilt only when
  // that changes.
  drawPanel() {
    const o = this.overlays;
    const client = o.clientRender;
    const usages = o.usages;
    const on = Object.keys(usages);
    const topics = [...new Set([...on, ...o.available])].sort();
    const rows = topics.map((topic) => {
      if (!(topic in usages)) return { topic, on: false };
      const usage = usages[topic] ?? {};
      const w = o.widgets.get(topic)?.values;
      const status = !w
        ? `widget ${o.widgets.get(topic)?.error ?? "not mirrored"}`
        : !client
          ? "burned in by the camera"
          : (o.envError ?? o.problems.get(topic) ?? (o.env ? "drawn here" : "loading MiniJinja…"));
      // A named anchor is shown by the slot picker instead.
      const where =
        "x" in usage && "y" in usage
          ? `at ${usage.x}%, ${usage.y}% (this camera)`
          : w?.anchor === "custom"
            ? `at ${w.custom_anchor_x}%, ${w.custom_anchor_y}%`
            : "";
      const z = usage.z_index ?? w?.z_index;
      const declared = typeof w?.svg_template === "string" ? declaredObjects(w.svg_template) : {};
      // A widget placed on the world goes where its objects are in the
      // picture, so it has no slot on the frame.
      let world = "";
      try {
        const p = typeof w?.svg_template === "string" ? worldPlacement(w.svg_template) : {};
        world = p.each ? `on each of ${p.anchor}.${p.each}` : p.anchor ? `on ${p.anchor}` : p.project?.length ? `projects ${p.project.join(", ")}` : "";
      } catch {} // shown as its status
      if (world) world += ", where it is in the picture";
      const binds = Object.entries(declared).map(([alias, def]) => {
        const bound = usage.bindings?.[alias];
        return bound ? `${alias} → ${bound} (this camera)` : `${alias} → ${def}`;
      });
      const ok = status === "drawn here" || status === "burned in by the camera";
      const anchored = world && !world.startsWith("projects");
      return { topic, on: true, status, ok, anchor: anchored ? undefined : w?.anchor, where: [world, anchored ? "" : where, z ? `z ${z}` : ""].filter(Boolean).join(" · "), binds };
    });
    const camera = o.camera.values ? "" : `camera ${o.camera.error}`;
    const key = JSON.stringify([camera, client, rows]);
    if (key === this.panelKey) return;
    this.panelKey = key;

    this.summary.textContent = camera
      ? `Overlays: ${camera}`
      : `Overlays: ${on.length || "none"} on${on.length ? (client ? ", drawn here" : ", burned in by the camera") : ""}`;
    this.mode.value = client ? "client" : "server";
    this.mode.disabled = !!camera;
    this.screenRow.hidden = !client;
    this.widgetList.replaceChildren(
      ...rows.map((r) => {
        const row = el("div", `widget${r.on ? "" : " off"}`);
        const box = el("input");
        box.type = "checkbox";
        box.checked = r.on;
        box.disabled = !!camera;
        box.onchange = () => this.write(o.setWidget(r.topic, box.checked));
        const head = el("label", "topic");
        head.append(box, el("span", "", r.topic));
        row.append(head);
        if (!r.on) return row;
        row.append(el("div", `status${r.ok ? "" : " bad"}`, r.status));
        if (r.anchor !== undefined) {
          // The widget's own anchor, as CameraDebugUi's "Anchor (default)"
          // sets it: it moves the widget on every camera showing it.
          const slot = el("select");
          slot.title = "Set on the widget, for every camera showing it";
          const names = Object.keys(ANCHORS);
          if (!names.includes(r.anchor)) names.push(r.anchor);
          for (const a of names) slot.append(new Option(a.replace("_", " "), a, false, a === r.anchor));
          slot.onchange = () => this.write(o.setAnchor(r.topic, slot.value));
          const slotRow = el("label", "slot");
          slotRow.append(el("span", "", "Slot"), slot);
          row.append(slotRow);
        }
        if (r.where) row.append(el("div", "where", r.where));
        for (const b of r.binds) row.append(el("div", "bind", b));
        return row;
      }),
    );
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
    // The camera's own rate, from how far the index's count moved: what
    // overlay templates see as frame.framerate. Not the rate shown here,
    // which is capped by the tile's.
    this.counts = [...this.counts.filter(([t]) => now - t < 2000), [now, Number(count)]];
    const [[t0, c0], [t1, c1]] = [this.counts[0], this.counts.at(-1)];
    const framerate = t1 > t0 && c1 >= c0 ? Math.round(((c1 - c0) * 10000) / (t1 - t0)) / 10 : 0;
    const bytes = reply.payload().toBytes();
    this.exif = exifTags(bytes);
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
    this.frame = { width: this.img.naturalWidth, height: this.img.naturalHeight, framerate };
    this.draw();
  }

  stop() {
    this.stopped = true;
    cancelAnimationFrame(this.pending);
    this.resize.disconnect();
    this.overlays.close();
    this.root.remove();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}
