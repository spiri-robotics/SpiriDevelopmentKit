import { SampleKind } from "@eclipse-zenoh/zenoh-ts";
import DOMPurify from "dompurify";
import { parse } from "yaml";
import { project, visible } from "./world-projection.js";

// A SpiriCamera's overlays (HudWidgets, SpiriCamera's overlay.py), mirrored
// read-only for a Cameras tile: the widgets its `overlay_widgets` names and
// the objects their templates read.
//
// A camera normally burns its overlays into the frame, and then there's
// nothing to draw here. With `overlay_client_render` set it sends clean
// frames and leaves drawing them to its viewer, so they're drawn here the
// way CameraDebugUi's render_overlays_for_client does: each template
// rendered with MiniJinja against the frame's EXIF tags, its size and rate,
// and the objects it declares, then sized and anchored on the frame by the
// same rules. This is a port of that Python, so the two should be changed
// together.
//
// Widgets are anyone's to publish, so what they render is sanitised before
// it reaches the page.
//
// It can also change the camera, as CameraDebugUi does: which widgets are
// on (a widget is on while it's a key of overlay_widgets, so turning one off
// drops this camera's overrides for it too), who draws them, and which
// anchor a widget sits on (the widget's own, so every camera's). Every
// HudWidget on the network is found by discovery, so one that's off can be
// turned back on.

const RETRY_MS = 5000; // rehydrating something that doesn't answer, at most this often
const DISCOVER_MS = 5000;
const WIDGET_FIELDS = ["svg_template", "anchor", "custom_anchor_x", "custom_anchor_y", "z_index"];
const DECLARATION = /\{#\s*object:\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^#]+?)\s*#\}/g;
// A widget placed by where its objects are in the world, overlay.py's
// world_placement: `{# anchor: alias #}`, `{# anchor: each alias.field #}`,
// `{# project: a, b #}`.
const ANCHOR = /\{#\s*anchor:\s*(?:(each)\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*#\}/g;
const PROJECT = /\{#\s*project:\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*#\}/g;
export const ANCHORS = {
  top_left: [0, 0],
  top_middle: [0.5, 0],
  top_right: [1, 0],
  center_left: [0, 0.5],
  center_middle: [0.5, 0.5],
  center_right: [1, 0.5],
  bottom_left: [0, 1],
  bottom_middle: [0.5, 1],
  bottom_right: [1, 1],
};

const load = (text) => parse(text, { logLevel: "error" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// MiniJinja is a wasm module, so it's only loaded once a camera is opened.
// Set up as the camera's own is: a value a template reads that isn't there
// is an error, so a widget waits for its objects rather than drawing blanks.
let environment = null;
function minijinja() {
  environment ??= import("minijinja-js").then(({ Environment }) => {
    const env = new Environment();
    env.undefinedBehavior = "strict";
    env.enablePyCompat();
    return env;
  });
  return environment;
}

// One SpiriSynq object, read-only: rehydrated, then kept up to date from puts
// to just the fields watched, so mirroring a camera for one of its fields
// doesn't bring its frames along. Rehydrated again after a tombstone, and
// until it answers.
class Mirror {
  constructor(zenoh, topic, onChange) {
    this.zenoh = zenoh;
    this.topic = topic;
    this.onChange = onChange;
    this.values = null;
    this.error = "waiting for an answer";
    this.subs = new Map(); // field -> unsubscribe
    this.rehydrated = 0;
    this.closed = false;
    this.rehydrate();
  }

  watch(fields) {
    for (const [field, drop] of this.subs) if (!fields.has(field)) (drop(), this.subs.delete(field));
    for (const field of fields) {
      if (this.subs.has(field)) continue;
      this.subs.set(field, this.zenoh.subscribe(`${this.topic}/${field}/**`, (s) => this.onSample(field, s)));
    }
  }

  // Asked again once it answers if anything changed while it was being
  // asked, since the answer may be from before that change.
  async rehydrate() {
    if (this.rehydrating) return void (this.again = true);
    this.rehydrating = true;
    while (!this.closed) {
      this.again = false;
      this.rehydrated = performance.now();
      try {
        const [reply] = await this.zenoh.query(`${this.topic}/sr_rehydrate`);
        if (!reply) throw new Error("not answering");
        if (reply instanceof Error) throw reply;
        this.values = load(reply.payload().toString()) ?? {};
        this.error = null;
        if (this.again) continue;
        break;
      } catch (e) {
        this.values = null;
        this.error = e.message;
        this.onChange();
      }
      await sleep(RETRY_MS);
    }
    this.rehydrating = false;
    this.onChange();
  }

  onSample(field, sample) {
    if (this.closed) return;
    const key = sample.keyexpr().toString();
    if (sample.kind() === SampleKind.DELETE) {
      if (key !== `${this.topic}/**`) return;
      this.values = null;
      this.error = "gone";
      this.onChange();
      this.rehydrate();
      return;
    }
    // Left to the rehydrate under way, which asks again for it.
    if (this.rehydrating) return void (this.again = true);
    if (!this.values) return;
    // A put inside a field: rehydrate rather than patch it in.
    if (key !== `${this.topic}/${field}`) {
      if (performance.now() - this.rehydrated > RETRY_MS) this.rehydrate();
      return;
    }
    try {
      this.values[field] = load(sample.payload().toString());
    } catch (e) {
      console.warn(`overlays: ${key}`, e);
      return;
    }
    this.onChange();
  }

  // Sets a field for everyone, as any SpiriSynq peer may: a put of its new
  // value as YAML. The owner applies a put without sending it back out, and
  // may not apply it at all, so what's shown is never the put (nor its echo
  // on this page's own subscription) but the owner's answer to a rehydrate
  // after it.
  async put(field, yaml) {
    await this.zenoh.put(`${this.topic}/${field}`, yaml, { encoding: "application/yaml" });
    this.rehydrate();
  }

  close() {
    this.closed = true;
    for (const drop of this.subs.values()) drop();
  }
}

// `{# object: alias = topic #}` declarations in a template.
export function declaredObjects(template) {
  return Object.fromEntries([...template.matchAll(DECLARATION)].map((m) => [m[1], m[2]]));
}

// How a template places itself by where its objects are in the world:
// {anchor, each, project}, all empty for a widget placed on the frame. Throws
// for what overlay.py's world_placement refuses.
export function worldPlacement(template) {
  const anchors = [...template.matchAll(ANCHOR)];
  const project = [...template.matchAll(PROJECT)].flatMap((m) => m[1].split(",").map((a) => a.trim()));
  if (anchors.length > 1) throw new Error("a widget has one anchor, this one declares several");
  if (anchors.length && project.length) throw new Error("a widget is either anchored on an object or projects objects, not both");
  const [, each, anchor, field] = anchors[0] ?? [];
  if (anchors.length && !!each !== !!field) throw new Error(`'${anchors[0][0]}': anchor on one object as 'anchor: <alias>', or on each of its links as 'anchor: each <alias>.<field>'`);
  const placement = { anchor: anchor ?? null, each: field ?? null, project };
  const declared = declaredObjects(template);
  for (const alias of [placement.anchor, ...project].filter(Boolean))
    if (!(alias in declared)) throw new Error(`places itself by '${alias}' with no '{# object: ${alias} = ... #}' declaration`);
  return placement;
}

// A link's topic: a Link parses to its topic, as a string.
const linkTopic = (link) => (typeof link === "string" ? link : link?.topic);

// Opens a mirror for each key of `wanted` not already open, and closes the
// rest.
function reconcile(mirrors, wanted, open) {
  for (const [topic, m] of mirrors) if (!wanted.has(topic)) (m.close(), mirrors.delete(topic));
  for (const topic of wanted) if (!mirrors.has(topic)) mirrors.set(topic, open(topic));
}

export class CameraOverlays {
  constructor(zenoh, topic, onChange) {
    this.zenoh = zenoh;
    this.onChange = onChange;
    this.camera = new Mirror(zenoh, topic, onChange);
    // Its pose and lens, for widgets placed on the world.
    this.camera.watch(new Set(["overlay_widgets", "overlay_client_render", "pose", "intrinsics"]));
    this.widgets = new Map(); // widget topic -> Mirror
    this.objects = new Map(); // object topic -> Mirror
    this.problems = new Map(); // widget topic -> why it wasn't drawn last time
    this.reads = new Map(); // template -> {reads: {alias: Set(fields)}, item: Set(fields), placement}, or an Error
    this.available = new Set(); // every HudWidget's topic, from discovery
    this.closed = false;
    this.env = null;
    minijinja().then(
      (env) => ((this.env = env), onChange()),
      (e) => (this.envError = `MiniJinja didn't load: ${e.message}`),
    );
    this.discover();
  }

  async discover() {
    while (!this.closed) {
      try {
        const replies = await this.zenoh.query("**/sr_metadata/HudWidget");
        const found = new Set();
        for (const r of replies) if (!(r instanceof Error)) found.add(load(r.payload().toString())?.topic);
        found.delete(undefined);
        const key = (set) => [...set].sort().join();
        if (key(found) !== key(this.available)) (this.available = found), this.onChange();
      } catch (e) {
        console.warn("overlays: discovery failed", e);
      }
      await sleep(DISCOVER_MS);
    }
  }

  get clientRender() {
    return !!this.camera.values?.overlay_client_render;
  }

  // Who draws the overlays: the camera, into its frames, or each viewer.
  setClientRender(on) {
    return this.camera.put("overlay_client_render", on ? "true" : "false");
  }

  // Turns a widget on or off for this camera.
  setWidget(topic, on) {
    const usages = { ...this.usages };
    if (on) usages[topic] ??= {};
    else delete usages[topic];
    return this.camera.put("overlay_widgets", `!EventedDict ${JSON.stringify(usages)}`);
  }

  // Moves a widget to one of its anchors. The anchor is the widget's own,
  // so this moves it on every camera that shows it.
  setAnchor(topic, anchor) {
    const w = this.widgets.get(topic);
    if (!w) return Promise.reject(new Error(`${topic} isn't mirrored`));
    return w.put("anchor", JSON.stringify(anchor));
  }

  // The camera's overrides per widget topic: x, y, z_index, bindings.
  get usages() {
    const usages = this.camera.values?.overlay_widgets;
    return usages && typeof usages === "object" ? usages : {};
  }

  // The fields a template reads of each object alias, checked against what
  // it declares as overlay.py's resolve_objects does.
  // An object a widget is placed on, or projects, is one it reads the pose
  // of; an `anchor: each` widget's, the field holding its links. What it
  // reads of each linked object, as item.*, is `item`.
  reading(template) {
    if (!this.reads.has(template)) {
      let parsed;
      try {
        const reads = {};
        const item = new Set(["pose"]);
        for (const name of this.env.undeclaredVariablesInStr(template, true)) {
          const [root, alias, field] = name.split(".");
          if (root === "item" && alias) item.add(alias);
          if (root !== "objects" || !alias) continue;
          (reads[alias] ??= new Set()).add(field);
        }
        const placement = worldPlacement(template);
        for (const alias of placement.project) (reads[alias] ??= new Set()).add("pose");
        if (placement.anchor) (reads[placement.anchor] ??= new Set()).add(placement.each ?? "pose");
        const declared = declaredObjects(template);
        const missing = Object.keys(reads).find((alias) => !(alias in declared));
        if (missing) throw new Error(`reads objects.${missing} with no '{# object: ${missing} = ... #}' declaration`);
        parsed = { reads, item, placement };
      } catch (e) {
        parsed = e;
      }
      this.reads.set(template, parsed);
    }
    const parsed = this.reads.get(template);
    if (parsed instanceof Error) throw parsed;
    return parsed;
  }

  // Each alias a widget reads, and the object it's bound to on this camera.
  bindings(topic, template) {
    const overrides = this.usages[topic]?.bindings ?? {};
    const declared = declaredObjects(template);
    return Object.entries(this.reading(template).reads).map(([alias, fields]) => [alias, overrides[alias] || declared[alias], fields]);
  }

  // Mirrors what overlay_widgets names, and the objects their templates read.
  sync() {
    reconcile(this.widgets, new Set(Object.keys(this.usages)), (topic) => {
      const m = new Mirror(this.zenoh, topic, this.onChange);
      m.watch(new Set(WIDGET_FIELDS));
      return m;
    });
    if (!this.env) return;
    const wanted = new Map(); // object topic -> fields read
    const want = (object, fields) => {
      const all = wanted.get(object) ?? new Set();
      for (const f of fields) if (f) all.add(f);
      wanted.set(object, all);
    };
    for (const [topic, w] of this.widgets) {
      const template = w.values?.svg_template;
      if (typeof template !== "string") continue;
      try {
        for (const [, object, fields] of this.bindings(topic, template)) want(object, fields);
        // An `anchor: each` widget's linked objects, once the object holding
        // the links is mirrored.
        const { item } = this.reading(template);
        for (const linked of this.linked(topic, template)) want(linked, item);
      } catch {} // shown when it's drawn
    }
    reconcile(this.objects, new Set(wanted.keys()), (topic) => new Mirror(this.zenoh, topic, this.onChange));
    for (const [topic, fields] of wanted) this.objects.get(topic).watch(fields);
  }

  // The topics an `anchor: each` widget's links name, in their order; none
  // for any other widget, or while the object holding them isn't mirrored.
  linked(topic, template) {
    const { placement } = this.reading(template);
    if (!placement.each) return [];
    const object = this.bindings(topic, template).find(([alias]) => alias === placement.anchor)?.[1];
    const links = this.objects.get(object)?.values?.[placement.each];
    return Array.isArray(links) ? links.map(linkTopic).filter((t) => typeof t === "string") : [];
  }

  // Where an object's pose is in the frame from this camera, or null.
  view(values, frame) {
    const { pose, intrinsics } = this.camera.values ?? {};
    return project(pose, intrinsics, values?.pose, frame.width, frame.height);
  }

  // The widgets as SVG markup over a frame: a `<svg>` with a viewBox of
  // `canvas`, to be laid over the image letterboxed the same way. `frame`
  // is what templates see as frame.*: width, height and framerate. Empty
  // when there's nothing to draw.
  render(frame, exif, canvas) {
    this.sync();
    this.problems.clear();
    if (!this.clientRender || !this.env || !frame.width || !frame.height) return "";
    const order = [...this.widgets].map(([topic, w]) => [topic, w, this.usages[topic]?.z_index ?? w.values?.z_index ?? 0]);
    order.sort((a, b) => a[2] - b[2]);
    const pieces = [];
    for (const [topic, w] of order) {
      try {
        pieces.push(...this.place(topic, w, frame, exif, canvas));
      } catch (e) {
        this.problems.set(topic, e.message);
      }
    }
    if (!pieces.length) return "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas.width} ${canvas.height}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">${pieces.join("")}</svg>`;
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  }

  // A widget's copies, as <g> elements: one placed on the frame, as usual,
  // or, for one anchored on the world, one centred on each object it's
  // anchored on that's in view (overlay.py's _overlay_renders).
  place(topic, w, frame, exif, canvas) {
    if (!w.values) throw new Error(`widget ${w.error}`);
    const { svg_template: template, anchor, custom_anchor_x, custom_anchor_y } = w.values;
    const objects = {};
    const bound = {};
    for (const [alias, object] of this.bindings(topic, template)) {
      const m = this.objects.get(object);
      if (!m?.values) throw new Error(`object ${object} for ${alias}: ${m?.error ?? "not mirrored"}`);
      objects[alias] = m.values;
      bound[alias] = object;
    }
    const render = (context) => {
      try {
        return this.env.renderStr(template, { objects, exif, frame, ...context });
      } catch (e) {
        throw new Error(`template: ${e.message}`);
      }
    };
    const piece = (svg, [x, y]) => `<g transform="translate(${x},${y})">${sized(svg, ...measure(svg, canvas))}</g>`;
    const onFrame = (svg) => {
      const [width, height] = measure(svg, canvas);
      const usage = this.usages[topic] ?? {};
      return "x" in usage && "y" in usage
        ? anchorPosition("custom", usage.x, usage.y, canvas, width, height)
        : anchorPosition(anchor, custom_anchor_x, custom_anchor_y, canvas, width, height);
    };

    const { placement } = this.reading(template);
    if (placement.project.length) {
      const view = Object.fromEntries(placement.project.map((alias) => [alias, this.view(objects[alias], frame)]));
      const svg = render({ view });
      return [piece(svg, onFrame(svg))];
    }
    if (!placement.anchor) {
      const svg = render({});
      return [piece(svg, onFrame(svg))];
    }
    // In the widget's own units, the canvas's: the frame's times this.
    const [sx, sy] = [canvas.width / frame.width, canvas.height / frame.height];
    const targets = placement.each ? this.linked(topic, template) : [bound[placement.anchor]];
    const pieces = [];
    for (const target of targets) {
      const values = this.objects.get(target)?.values;
      const view = values && this.view(values, frame);
      if (!view || !visible(view, frame.width, frame.height)) continue;
      const centred = { ...view, x: view.x * sx, y: view.y * sy, r: view.r == null ? null : view.r * Math.min(sx, sy) };
      const svg = render(placement.each ? { view: centred, item: values } : { view: centred });
      const [width, height] = measure(svg, canvas);
      pieces.push(piece(svg, [Math.round(centred.x - width / 2), Math.round(centred.y - height / 2)]));
    }
    return pieces;
  }

  close() {
    this.closed = true;
    this.camera.close();
    for (const m of [...this.widgets.values(), ...this.objects.values()]) m.close();
  }
}

const ROOT = /<svg\b[^>]*>/i;
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`))?.[1];

// A rendered widget's size on the canvas: its own width and height (or
// viewBox), unscaled, or, if both are percentages, its viewBox scaled to fit
// that much of the canvas. overlay.py's measure_size.
function measure(svg, canvas) {
  const tag = svg.match(ROOT)?.[0];
  if (!tag) throw new Error("no <svg> element");
  const box = attr(tag, "viewBox")?.trim().split(/[\s,]+/).map(Number) ?? [];
  const [boxW, boxH] = box.length === 4 ? box.slice(2) : [NaN, NaN];
  const w = attr(tag, "width");
  const h = attr(tag, "height");
  let width, height;
  if (w?.endsWith("%") && h?.endsWith("%")) {
    const scale = Math.min(((parseFloat(w) / 100) * canvas.width) / boxW, ((parseFloat(h) / 100) * canvas.height) / boxH);
    [width, height] = [boxW * scale, boxH * scale];
  } else {
    width = w && !w.endsWith("%") ? parseFloat(w) : boxW;
    height = h && !h.endsWith("%") ? parseFloat(h) : boxH;
  }
  if (!(width > 0 && height > 0)) throw new Error("the SVG has no size: give it a width and height, or a viewBox");
  return [Math.ceil(width), Math.ceil(height)];
}

// The root <svg>'s width and height set to its measured size.
function sized(svg, width, height) {
  return svg.replace(ROOT, (tag) => `${tag.replace(/\s(width|height)\s*=\s*"[^"]*"/g, "").slice(0, -1)} width="${width}" height="${height}">`);
}

// A widget's top-left corner on the canvas. overlay.py's anchor_position.
function anchorPosition(anchor, x, y, canvas, width, height) {
  if (anchor === "custom") return [Math.round((x / 100) * canvas.width), Math.round((y / 100) * canvas.height)];
  const [fx, fy] = ANCHORS[anchor] ?? ANCHORS.top_left;
  return [Math.round(fx * (canvas.width - width)), Math.round(fy * (canvas.height - height))];
}
