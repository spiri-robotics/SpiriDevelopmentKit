import { PathTree } from "../path-tree.js";
import { callMethod } from "../synq.js";
import { parseSchema, renderSchema } from "../synq-schema.js";
import "./keys.css";

// Everything published on zenoh, as a tree of keys with each key's latest
// value. The page doesn't subscribe to `**`: zenoh-index (debug-map/index)
// does, next to the router, and the page polls it for what changed, then
// fetches the selected key's value. So big streams such as camera frames
// never cross the websocket unless one is selected, and then only a few
// times a second. See path-tree.js for the tree and its filter syntax.
//
// SpiriSynq objects (found by the index's discovery) are drawn in their own
// colour; selecting one shows its schema, asked of the object itself, and
// its methods can be called from there.
//
// Gazebo's topics are under `@/<partition>@/`. Gazebo only sends a topic
// someone subscribes to, so the index receives one only while it's selected
// here (we keep asking it to watch), and shows its messages decoded to JSON.

const POLL_MS = 500;
const VALUE_MS = 250; // at most this often for the selected key's value
const WATCH_MS = 3000; // how often to ask the index to keep watching a Gazebo topic
const isGz = (path) => path.startsWith("@/");
const MAX_DETAIL = 64 * 1024;
const TEXT = /^(application\/(yaml|json|json5|xml)|text\/|zenoh\/string)/;
const decoder = new TextDecoder();

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function size(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

// First bytes of a binary payload, as hex.
function hex(bytes) {
  const lines = [];
  for (let i = 0; i < Math.min(bytes.length, 512); i += 16) {
    const chunk = [...bytes.subarray(i, i + 16)].map((b) => b.toString(16).padStart(2, "0"));
    lines.push(`${i.toString(16).padStart(4, "0")}  ${chunk.join(" ")}`);
  }
  if (bytes.length > 512) lines.push("…");
  return lines.join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  title: "Zenoh keys",
  group: "Network",
  keywords: ["zenoh", "topics", "subscribe", "tree", "debug", "spirisynq"],
  icon: "⋔",
  order: 10,
  mount(body, { zenoh, store }) {
    body.classList.add("zkeys");

    const filter = el("input", "filter");
    filter.type = "search";
    filter.placeholder = "Filter: words, or a key expression (mu-*/telemetry/**)";
    filter.spellcheck = false;
    filter.value = store.get().filter ?? "";
    const expand = el("button", "", "+");
    expand.title = "Expand all";
    const collapse = el("button", "", "−");
    collapse.title = "Collapse all";
    const pause = el("button", "", "Pause");
    pause.title = "Freeze the view; keys are still kept up to date";
    const bar = el("div", "bar");
    bar.append(filter, expand, collapse, pause);
    const status = el("div", "status");
    const treeBox = el("div", "tree");
    const detail = el("div", "detail");
    detail.hidden = true;
    body.append(bar, status, treeBox, detail);

    // The selected key's value, fetched from the index when its count moves.
    let value = null; // { path, count, payload, encoding }
    let shownAs = "";
    // Object schemas by topic: { schema, raw } or { error }. Fetched once per
    // selection, so a changed object shows its new schema when picked again.
    const schemas = new Map();
    // Keys whose values don't fit their object's schema.
    const problems = new Set();
    // A key's value is shown in these, updated in place so scrolling holds.
    const keyLine = el("div", "key");
    const metaLine = el("div", "meta");
    const problemLine = el("div", "problem");
    const pre = el("pre");
    // While text in the pane is being selected, or is selected, it's left
    // alone so it can be copied; it catches up once the selection goes.
    let pressing = false;
    detail.addEventListener("pointerdown", () => (pressing = true));
    const release = () => {
      if (!pressing) return;
      pressing = false;
      showDetail();
    };
    window.addEventListener("pointerup", release);
    const onSelection = () => {
      const s = document.getSelection();
      if (!pressing && (!s || s.isCollapsed)) showDetail();
    };
    document.addEventListener("selectionchange", onSelection);
    function holding() {
      const s = document.getSelection();
      return pressing || (s && !s.isCollapsed && detail.contains(s.anchorNode));
    }
    const setText = (e, text) => e.textContent !== text && (e.textContent = text);

    function showDetail() {
      const n = tree.selected;
      if (!n?.data) return void (detail.hidden = true);
      const d = n.data;
      if (d.object) return showObject(n);
      const v = value?.path === n.path ? value : null;
      const as = `${n.path}:${d.count}:${n.deleted}:${v?.count}:${d.problem}`;
      if (as === shownAs || (!detail.hidden && keyLine.textContent === n.path && detail.contains(pre) && holding())) return;
      shownAs = as;
      const t = v && TEXT.test(v.encoding) && v.payload.length <= MAX_DETAIL ? decoder.decode(v.payload) : null;
      detail.hidden = false;
      if (!detail.contains(pre)) detail.replaceChildren(keyLine, metaLine, problemLine, pre);
      setText(keyLine, n.path);
      const gzNote = isGz(n.path) ? " · Gazebo topic, received only while selected" : "";
      setText(metaLine, `${d.encoding} · ${size(d.size)} · ${d.count} messages${n.deleted ? " · deleted" : ""}${gzNote}`);
      problemLine.hidden = !d.problem;
      setText(problemLine, d.problem ? `Doesn't fit the schema: ${d.problem}` : "");
      setText(pre, v ? (t ?? hex(v.payload)) : "…");
    }

    function showObject(n) {
      const s = schemas.get(n.path);
      const as = `${n.path}:${n.deleted}:${!!s}`;
      if (as === shownAs) return;
      shownAs = as;
      detail.hidden = false;
      detail.replaceChildren(
        el("div", "key", n.path),
        el("div", "meta", `SpiriSynq object${n.deleted ? " · gone" : ""}`),
        !s ? el("div", "meta", "Fetching schema…")
          : s.error ? el("div", "meta", `No schema: ${s.error}`)
          : renderSchema(s.schema, s.raw, {
              call: (method, args, onReply) => callMethod(zenoh, n.path, method, args, onReply),
            }),
      );
    }

    async function fetchSchema(path) {
      try {
        const [reply] = await zenoh.query(`${path}/sr_object_schema`);
        if (!reply) throw new Error("nothing answered");
        if (reply instanceof Error) throw reply;
        const raw = reply.payload().toString();
        schemas.set(path, { schema: parseSchema(raw), raw });
      } catch (e) {
        schemas.set(path, { error: e.message });
      }
      showDetail();
    }

    // The class names an object goes by, most specific first.
    const classNames = (classes) =>
      classes.map((c) => c.replace(/^!/, "")).filter((c) => c !== "SyncableObject").join(", ") || "SyncableObject";

    const tree = new PathTree(treeBox, {
      value: (n) => (n.data.object ? classNames(n.data.object) : (n.data.preview ?? `${size(n.data.size)} ${n.data.encoding}`)),
      title: (n) => (n.data.object ? n.data.object.join(" ") : (n.data.problem ?? n.data.encoding)),
      rate: (n) => n.data.rate,
      // A key that doesn't fit its object's schema is red; anything above
      // one gets a red mark, so it can be found with folders closed.
      kind: (n) => {
        const kinds = [];
        if (n.data?.object) kinds.push("object");
        if (n.data?.problem) kinds.push("problem");
        for (const p of problems) {
          if (p.startsWith(`${n.path}/`)) {
            kinds.push("problems");
            break;
          }
        }
        return kinds.join(" ") || undefined;
      },
      onSelect: (n) => {
        shownAs = "";
        if (n?.data?.object) {
          schemas.delete(n.path);
          fetchSchema(n.path);
        }
        showDetail();
      },
      onFlush: showDetail,
    });

    let indexUp = null;
    function showStatus() {
      const keys = tree.filtering ? `${tree.matching} of ${tree.paths} keys` : `${tree.paths} keys`;
      const state = tree.paused ? "paused" : zenoh.status !== "up" ? zenoh.status : indexUp === false ? "no zenoh-index" : "up";
      status.textContent = `${keys} · ${tree.rate}/s · ${state}`;
    }

    function applyFilter() {
      const error = tree.setFilter(filter.value);
      filter.classList.toggle("bad", !!error);
      filter.title = error?.message ?? "";
      if (!error) store.set({ ...store.get(), filter: filter.value });
      showStatus();
    }
    let debounce = 0;
    filter.oninput = () => {
      clearTimeout(debounce);
      debounce = setTimeout(applyFilter, 150);
    };
    filter.onkeydown = (e) => {
      if (e.key === "Escape" && filter.value) {
        e.stopPropagation();
        filter.value = "";
        applyFilter();
      }
    };
    expand.onclick = () => tree.expandAll(true);
    collapse.onclick = () => tree.expandAll(false);
    pause.onclick = () => {
      tree.setPaused(!tree.paused);
      pause.textContent = tree.paused ? "Resume" : "Pause";
      pause.classList.toggle("on", tree.paused);
      showStatus();
    };
    const timer = setInterval(showStatus, 1000);
    applyFilter();

    // Apply one summary. Rates come from the index, which sees every message
    // as it arrives. A full summary (since=0) lists every key the index
    // has, so known keys missing from it are gone.
    function apply(summary, full) {
      const seen = new Set();
      for (const [key, encoding, bytes, count, preview, deleted, rate, problem] of summary.keys) {
        if (problem && !deleted) problems.add(key);
        else problems.delete(key);
        seen.add(key);
        const n = tree.get(key);
        const data = { encoding, size: bytes, count, preview, rate, problem };
        // Messages since the last summary; only those make a row flash.
        const before = n?.data?.count ?? (full ? count : 0);
        const delta = Math.max(0, count - before);
        if (deleted) {
          if (!n?.data) tree.set(key, data, 0);
          tree.delete(key);
        } else if (delta || !n?.data || n.deleted || n.data.rate !== rate || n.data.problem !== problem) {
          tree.set(key, data, delta);
        }
      }
      if (full) tree.each((n) => n.data && !n.data.object && !n.deleted && !seen.has(n.path) && tree.delete(n.path));
      if (summary.objects) applyObjects(summary.objects);
    }

    // The index's object list, whole, whenever it changes.
    let objects = {};
    function applyObjects(found) {
      for (const [topic, classes] of Object.entries(found)) {
        const n = tree.get(topic);
        if (!n?.data?.object || n.deleted || n.data.object.join() !== classes.join()) {
          tree.set(topic, { ...n?.data, object: classes }, 0);
        }
      }
      for (const topic of Object.keys(objects)) if (!(topic in found)) tree.delete(topic);
      objects = found;
    }

    // Poll the index. A different epoch means it restarted, and its revisions
    // mean nothing to it any more: start over with everything.
    let epoch = null;
    let rev = 0;
    let stopped = false;
    (async () => {
      while (!stopped) {
        try {
          const since = rev;
          const [reply] = await zenoh.query(`@sdk/index?since=${since}`);
          indexUp = !!reply && !(reply instanceof Error);
          if (indexUp && !stopped) {
            const summary = JSON.parse(reply.payload().toString());
            if (since && summary.epoch !== epoch) rev = 0;
            else {
              apply(summary, !since);
              epoch = summary.epoch;
              rev = summary.rev;
            }
          }
        } catch (e) {
          indexUp = false;
          console.warn("zenoh-index:", e);
        }
        await sleep(POLL_MS);
      }
    })();

    // The selected key's value, whenever its count has moved. A Gazebo topic
    // is only received while we keep asking the index to watch it.
    let watched = null;
    let watchedAt = 0;
    (async () => {
      while (!stopped) {
        const n = tree.selected;
        if (n?.data && isGz(n.path) && !n.deleted && (watched !== n.path || Date.now() - watchedAt > WATCH_MS)) {
          watched = n.path;
          watchedAt = Date.now();
          zenoh.query("@sdk/index/watch", { payload: n.path }).catch((e) => console.warn("zenoh-index watch:", e));
        }
        if (n?.data && !n.data.object && !tree.paused && (value?.path !== n.path || value.count !== n.data.count)) {
          try {
            const [reply] = await zenoh.query("@sdk/index/value", { payload: n.path });
            if (reply && !(reply instanceof Error) && tree.selected === n) {
              value = {
                path: n.path,
                count: Number(reply.attachment()?.toString() ?? n.data.count),
                payload: reply.payload().toBytes(),
                encoding: reply.encoding().toString(),
              };
              showDetail();
            }
          } catch (e) {
            console.warn("zenoh-index value:", e);
          }
        }
        await sleep(VALUE_MS);
      }
    })();

    return () => {
      stopped = true;
      window.removeEventListener("pointerup", release);
      document.removeEventListener("selectionchange", onSelection);
      clearInterval(timer);
      clearTimeout(debounce);
      tree.destroy();
    };
  },
};
