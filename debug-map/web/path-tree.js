import { KeyExpr } from "@eclipse-zenoh/zenoh-ts";
import "./path-tree.css";

// A live tree of `/`-separated paths (zenoh keys, topics, files), for lists
// that are big and busy. Rows exist only under expanded folders and are
// updated at most once a frame; each row shows the updates per second of
// everything under it.
//
// Filtering keeps the paths that match and the folders above them. A filter
// with `*` in it is a zenoh key expression (`mu-*/telemetry/**`, where a `*`
// inside a chunk means zenoh's `$*`);
// anything else is words, and every word must appear in the path, as in the
// applet search. While a filter is on, folders start open if there are few
// enough matches to show.
//
//   const tree = new PathTree(el, {
//     value: (node) => "…",   // text after a node's name; node.data is yours
//     title: (node) => "…",   // optional tooltip for that text
//     rate: (node) => 2.5,     // optional: a path's updates per second, if
//                              // known better than by counting set() calls
//     kind: (node) => "…",    // optional: the row's data-kind, for styling
//     onSelect(node) {},      // optional: a node with data was clicked
//     onFlush() {},           // optional: after each frame's updates
//   });
//   tree.set("a/b/c", data); tree.delete("a/**"); tree.setFilter("b");
//
// Deleted paths are struck through and dropped a minute later, unless set
// again first.

const AUTO_OPEN = 200; // matches under which a filter opens every folder
const KEEP_DELETED = 60_000; // ms a deleted path stays on screen
const collator = new Intl.Collator(undefined, { numeric: true });

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

// A test for paths, or an Error for a bad key expression.
export function pathFilter(text) {
  text = text.trim();
  if (!text) return null;
  if (text.includes("*")) {
    // Zenoh wants `$*` for a wildcard inside a chunk; take `mu-*` to mean that.
    const expr = text
      .split("/")
      .map((c) => (c === "*" || c === "**" ? c : c.replace(/\$?\*/g, "$$*")))
      .join("/");
    try {
      const ke = new KeyExpr(expr);
      return (path) => ke.includes(path);
    } catch {
      return new Error(`not a key expression: ${text}`);
    }
  }
  const words = text.toLowerCase().split(/\s+/);
  return (path) => {
    const p = path.toLowerCase();
    return words.every((w) => p.includes(w));
  };
}

export class PathTree {
  #root;
  #el;
  #opts;
  #match = null;
  #autoOpen = false;
  #shown = new Set(); // nodes with rows
  #dirty = new Set();
  #frame = 0;
  #timer;
  #selected = null;
  #deleted = new Set();
  #ratedAt = null;
  paused = false;

  constructor(container, opts) {
    this.#el = el("div", "path-tree");
    container.append(this.#el);
    this.#opts = opts;
    this.#root = this.#node("", null);
    this.#root.open = true;
    this.#root.kids = this.#el;
    this.#timer = setInterval(() => {
      this.#rates();
      const old = performance.now() - KEEP_DELETED;
      for (const n of this.#deleted) if (n.deleted < old) this.#remove(n);
    }, 1000);
  }

  destroy() {
    clearInterval(this.#timer);
    cancelAnimationFrame(this.#frame);
    this.#el.remove();
  }

  // Paths with data, all of them and the ones the filter shows.
  get paths() {
    return this.#root.total;
  }
  get matching() {
    return this.#root.hits;
  }
  // Updates per second, over everything.
  get rate() {
    return Math.round(this.#root.hz);
  }
  get filtering() {
    return !!this.#match;
  }

  #node(name, parent) {
    return {
      name, parent, path: parent?.path ? `${parent.path}/${name}` : name,
      children: new Map(), data: undefined, deleted: 0, hits: 0, total: 0, gone: 0,
      count: 0, seen: 0, hz: 0, at: 0, flashed: 0,
      open: false, fopen: undefined, row: null, line: null, kids: null, added: false,
    };
  }

  #isOpen(n) {
    return n === this.#root || (this.#match ? (n.fopen ?? this.#autoOpen) : n.open);
  }

  #touch(n) {
    if (n.row || n === this.#root) this.#dirty.add(n);
    if (!this.paused) this.#frame ||= requestAnimationFrame(() => this.#flush());
  }

  // Calls fn(node) for every node.
  each(fn) {
    const walk = (n) => {
      for (const c of [...n.children.values()]) {
        fn(c);
        walk(c);
      }
    };
    walk(this.#root);
  }

  get(path) {
    let n = this.#root;
    for (const name of path.split("/")) if (!(n = n.children.get(name))) return undefined;
    return n;
  }

  // Store data at path, creating it, and count `count` updates to it.
  set(path, data, count = 1) {
    let n = this.#root;
    for (const name of path.split("/")) {
      let child = n.children.get(name);
      if (!child) n.children.set(name, (child = this.#node(name, n)));
      n = child;
    }
    if (n.data === undefined) this.#counts(n, +1);
    if (n.deleted) {
      n.deleted = 0;
      this.#deleted.delete(n);
      this.#gone(n, -1);
    }
    n.data = data;
    const now = performance.now();
    for (let a = n; a; a = a.parent) {
      a.count += count;
      if (count) a.at = now;
      this.#touch(a);
    }
    return n;
  }

  // Mark a path deleted, or with `prefix/**` everything under it. Deleted
  // paths stay, struck through, until set again or KEEP_DELETED has passed.
  delete(path) {
    const subtree = path.endsWith("/**");
    const n = this.get(subtree ? path.slice(0, -3) : path);
    if (!n) return;
    const now = performance.now();
    const mark = (m) => {
      if (m.data !== undefined && !m.deleted) {
        m.deleted = now;
        this.#deleted.add(m);
        this.#gone(m, +1);
      }
    };
    if (subtree) {
      const walk = (m) => {
        for (const c of m.children.values()) {
          mark(c);
          walk(c);
        }
      };
      walk(n);
    }
    mark(n);
  }

  // Deleted paths under each folder, so a folder whose paths are all deleted
  // is struck through too.
  #gone(n, d) {
    for (let a = n; a; a = a.parent) {
      a.gone += d;
      this.#touch(a);
    }
  }

  // Forget a path for good, and any folders it leaves empty.
  #remove(n) {
    this.#deleted.delete(n);
    this.#gone(n, -1);
    this.#counts(n, -1);
    n.data = undefined;
    n.deleted = 0;
    while (n !== this.#root && n.data === undefined && !n.children.size) {
      this.#drop(n);
      n.parent.children.delete(n.name);
      n = n.parent;
    }
    this.#touch(n);
  }

  // A data path appearing (+1) or going (-1): totals and filter hits for it
  // and its folders. A folder whose hits come or go needs its parent laid out.
  #counts(n, d) {
    const hit = !this.#match || this.#match(n.path);
    for (let a = n; a; a = a.parent) {
      a.total += d;
      if (!hit) continue;
      a.hits += d;
      if (a.parent && (a.hits === 0 || a.hits === d)) {
        a.parent.added = true;
        this.#touch(a.parent);
      }
    }
  }

  #drop(n) {
    if (n.row) {
      n.row.remove();
      this.#hide(n);
    }
    if (this.#selected === n) this.select(null);
  }

  #hide(n) {
    for (const c of n.children.values()) if (c.row) this.#hide(c);
    n.row = n.line = n.kids = null;
    this.#shown.delete(n);
  }

  // Returns an Error for a filter that can't be used; the old one stays.
  setFilter(text) {
    const match = pathFilter(text);
    if (match instanceof Error) return match;
    this.#match = match;
    const count = (n) => {
      n.fopen = undefined;
      n.hits = n.data !== undefined && (!match || match(n.path)) ? 1 : 0;
      for (const c of n.children.values()) n.hits += count(c);
      return n.hits;
    };
    count(this.#root);
    this.#autoOpen = !!match && this.#root.hits <= AUTO_OPEN;
    // Rebuild what's on screen.
    for (const c of this.#root.children.values()) if (c.row) this.#hide(c);
    this.#root.added = true;
    this.#layout(this.#root);
    return null;
  }

  select(n) {
    this.#selected?.line?.classList.remove("selected");
    this.#selected = n;
    n?.line?.classList.add("selected");
    this.#opts.onSelect?.(n);
  }

  get selected() {
    return this.#selected;
  }

  // Open or close every folder on screen and below.
  expandAll(open) {
    const walk = (n) => {
      if (this.#match) n.fopen = open;
      else n.open = open;
      for (const c of n.children.values()) walk(c);
    };
    for (const c of this.#root.children.values()) walk(c);
    for (const c of this.#root.children.values()) if (c.row) this.#hide(c);
    this.#root.added = true;
    this.#layout(this.#root);
  }

  setPaused(paused) {
    this.paused = paused;
    if (!paused) this.#touch(this.#root);
  }

  #makeRow(n) {
    n.row = el("div", "node");
    n.line = el("div", "line");
    n.line.append(el("span", "twisty"), el("span", "name", n.name), el("span", "value"), el("span", "rate"));
    n.line.onclick = () => {
      if (n.children.size) this.#toggle(n);
      if (n.data !== undefined) this.select(n);
    };
    if (n === this.#selected) n.line.classList.add("selected");
    n.row.append(n.line);
    // Rates are kept for rows on screen, so start counting now.
    n.seen = n.count;
    this.#shown.add(n);
    this.#update(n);
    if (this.#isOpen(n)) this.#open(n);
    return n.row;
  }

  #toggle(n) {
    const open = !this.#isOpen(n);
    if (this.#match) n.fopen = open;
    else n.open = open;
    if (open) this.#open(n);
    else {
      for (const c of n.children.values()) if (c.row) this.#hide(c);
      n.kids.remove();
      n.kids = null;
    }
    this.#update(n);
  }

  #open(n) {
    n.kids = el("div", "kids");
    n.row.append(n.kids);
    n.added = true;
    this.#layout(n);
  }

  // Child rows in path order, reusing the ones already built.
  #layout(n) {
    if (!n.added || !n.kids) return;
    n.added = false;
    const names = [...n.children.keys()].filter((k) => n.children.get(k).hits).sort(collator.compare);
    n.kids.replaceChildren(
      ...names.map((name) => {
        const c = n.children.get(name);
        return c.row ?? this.#makeRow(c);
      }),
    );
    // Rows the filter now hides.
    for (const c of n.children.values()) if (c.row && !c.hits) this.#hide(c);
  }

  #update(n) {
    const [twisty, , value] = n.line.children;
    const open = this.#isOpen(n);
    twisty.textContent = n.children.size ? (open ? "▾" : "▸") : "";
    n.line.classList.toggle("deleted", n.gone > 0 && n.gone === n.total);
    const kind = this.#opts.kind?.(n);
    if (kind) n.line.dataset.kind = kind;
    else delete n.line.dataset.kind;
    value.textContent =
      n.data !== undefined ? this.#opts.value(n) : open ? "" : `${n.hits} ${n.hits === 1 ? "key" : "keys"}`;
    value.title = n.data !== undefined ? (this.#opts.title?.(n) ?? "") : "";
  }

  #flush() {
    this.#frame = 0;
    if (this.paused) return;
    const now = performance.now();
    for (const n of this.#dirty) {
      this.#layout(n);
      if (!n.line) continue;
      this.#update(n);
      // A short highlight when something under it changes, at most once a
      // second, so busy rows pulse rather than stay lit.
      if (n.at > n.flashed && now - n.flashed > 1000) {
        n.flashed = now;
        n.line.animate([{ background: "#33405a" }, { background: "transparent" }], 400);
      }
    }
    this.#dirty.clear();
    this.#opts.onFlush?.();
  }

  // Rates once a second for rows on screen: from opts.rate if given, summed
  // up the folders, or else from update counts over the time since the last
  // tick, which a busy page can stretch well past a second.
  #rates() {
    if (this.paused) return;
    const r = this.#root;
    const rate = this.#opts.rate;
    if (rate) {
      const sum = (n) => {
        n.hz = n.data !== undefined && !n.deleted ? (rate(n) ?? 0) : 0;
        for (const c of n.children.values()) n.hz += sum(c);
        return n.hz;
      };
      sum(r);
    } else {
      const now = performance.now();
      const secs = (now - (this.#ratedAt ?? now - 1000)) / 1000;
      this.#ratedAt = now;
      for (const n of [r, ...this.#shown]) {
        n.hz = (n.count - n.seen) / secs;
        n.seen = n.count;
      }
    }
    for (const n of this.#shown) {
      n.line.lastChild.textContent = n.hz >= 10 ? `${Math.round(n.hz)}/s` : n.hz >= 0.1 ? `${+n.hz.toFixed(1)}/s` : "";
    }
  }


}
