import "./shell.css";

// The map's shell. The globe fills the stage; every tool is an applet, one file
// in applets/, listed in a searchable sidebar and opened into a floating window
// over the map. There may be hundreds, so the sidebar is labels in groups, and
// the search box (/ or Ctrl+K from anywhere) is the main way in. An applet is
//
//   export default {
//     title: "Models",
//     group: "World",       // sidebar heading
//     keywords: ["follow"], // extra words the search matches
//     icon: "☰",            // optional glyph; the title's first letter otherwise
//     order: 20,            // position within its group, low first
//     setup(ctx) {},        // optional: runs once at load, open or not
//     mount(el, ctx) {},    // optional: draw into a window; may return a cleanup
//     run(ctx) {},          // optional, instead of mount: an entry that just acts
//   };
//
// Closed windows are unmounted, so they cost nothing. Most one-off tools should
// be actions rather than windows: ctx.actions.register adds an entry to an
// entity's right-click menu and the Inspector, so the tool takes no screen space
// until someone points at the thing it's for. An applet with only setup (actions,
// say) isn't listed in the sidebar.
//
// ctx.notify(text, ms) shows a line of text over the map for ms (0: until the
// function it returns is called), for what an action did or is waiting for.

// JSON in localStorage, which can be missing or throw (private windows etc.).
function storage(key) {
  return {
    get() {
      try {
        return JSON.parse(localStorage.getItem(key) ?? "{}");
      } catch {
        return {};
      }
    },
    set(value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };
}

// Map layers by id: anything with a `show` property. Visibility is remembered
// per browser. Fires "change" when a layer is added or toggled.
export class Layers extends EventTarget {
  #items = new Map();
  #saved = storage("layers");
  #shown = this.#saved.get();

  add(id, title, layer) {
    layer.show = this.#shown[id] ?? layer.show;
    this.#items.set(id, { id, title, layer });
    this.dispatchEvent(new Event("change"));
  }

  list() {
    return [...this.#items.values()];
  }

  show(id, on) {
    this.#items.get(id).layer.show = on;
    this.#shown[id] = on;
    this.#saved.set(this.#shown);
    this.dispatchEvent(new Event("change"));
  }
}

// Things on the map that can be picked and acted on: { id, name, kind }, plus
// whatever their layer adds. One can be selected and one followed. Fires
// "change" when one is added or removed, "select" and "track" when those
// change. An element on the map stands for an entity by carrying its id in
// data-entity; the shell picks it from there (see startShell).
export class Entities extends EventTarget {
  #items = new Map();
  selected = null;
  tracked = null;

  add(entity) {
    this.#items.set(entity.id, entity);
    this.dispatchEvent(new Event("change"));
    return entity;
  }

  remove(entity) {
    if (!this.#items.delete(entity.id)) return;
    if (this.selected === entity) this.select(null);
    if (this.tracked === entity) this.track(null);
    this.dispatchEvent(new Event("change"));
  }

  get(id) {
    return this.#items.get(id);
  }

  get values() {
    return [...this.#items.values()];
  }

  select(entity) {
    this.selected = entity;
    this.dispatchEvent(new Event("select"));
  }

  track(entity) {
    if (this.tracked === entity) return;
    this.tracked = entity;
    this.dispatchEvent(new Event("track"));
  }
}

// Things you can do to an entity: { label, when(entity), run(entity) }.
export class Actions {
  #list = [];

  register(action) {
    this.#list.push(action);
    return () => this.#list.splice(this.#list.indexOf(action), 1);
  }

  for(entity) {
    return this.#list.filter((a) => a.when?.(entity) ?? true);
  }
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

// Every word typed must appear in the title, id, group or keywords.
function matches(a, words) {
  const hay = [a.title, a.id, a.group, ...(a.keywords ?? [])].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function startShell(ctx) {
  const stage = document.getElementById("stage");
  const list = document.getElementById("applets");
  const search = document.getElementById("search");
  const toggle = document.getElementById("sidebar-toggle");
  const expand = document.getElementById("sidebar-expand");

  const state = storage("shell");
  const saved = { open: {}, pos: {}, collapsed: {}, ...state.get() };
  const save = () => state.set(saved);

  const modules = import.meta.glob("./applets/*.js", { eager: true });
  const all = Object.entries(modules).map(([path, m]) => ({ id: path.match(/([^/]+)\.js$/)[1], group: "Other", ...m.default }));
  const applets = all
    .filter((a) => a.mount || a.run)
    .sort(
      (a, b) =>
        a.group.localeCompare(b.group) || (a.order ?? 50) - (b.order ?? 50) || a.title.localeCompare(b.title),
    );

  // The sidebar: wide, or hidden behind a button at the stage's corner.
  function setHidden(hidden) {
    document.body.dataset.sidebar = hidden ? "hidden" : "shown";
    saved.sidebarHidden = hidden;
    save();
  }
  setHidden(!!saved.sidebarHidden);
  toggle.onclick = () => setHidden(true);
  expand.onclick = () => setHidden(false);

  // The list, grouped; or, while searching, the matches with title-prefix
  // matches first and the first one picked (Enter opens it).
  let shown = [];
  let pick = 0;

  function render() {
    const q = search.value.trim().toLowerCase();
    const rows = [];
    if (q) {
      const words = q.split(/\s+/);
      shown = applets
        .filter((a) => matches(a, words))
        .sort((a, b) => b.title.toLowerCase().startsWith(q) - a.title.toLowerCase().startsWith(q));
      pick = Math.min(pick, Math.max(shown.length - 1, 0));
      if (!shown.length) rows.push(el("div", "empty", "Nothing matches."));
    } else {
      shown = applets;
      pick = -1;
    }
    let group = null;
    shown.forEach((a, i) => {
      if (!q && a.group !== group) rows.push(el("div", "group", (group = a.group)));
      a.entry.dataset.pick = i === pick;
      a.entry.querySelector(".where").textContent = q ? a.group : "";
      rows.push(a.entry);
    });
    list.dataset.filter = q ? "on" : "off";
    list.replaceChildren(...rows);
    list.querySelector('[data-pick="true"]')?.scrollIntoView({ block: "nearest" });
  }

  function activate(a) {
    if (a.run) a.run(a.ctx);
    else if (open.has(a.id)) raise(open.get(a.id).win);
    else show(a);
  }

  search.oninput = () => {
    pick = 0;
    render();
  };
  search.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      pick = (Math.max(pick, 0) + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
      render();
    } else if (e.key === "Enter" && shown[pick]) {
      activate(shown[pick]);
      search.value = "";
      render();
    } else if (e.key === "Escape") {
      if (search.value) search.value = "";
      else search.blur();
      render();
    }
  };
  // / or Ctrl+K from anywhere outside a text field goes to the search box.
  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
    if ((e.key === "/" && !typing) || (e.key === "k" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      setHidden(false);
      search.focus();
      search.select();
    }
  });

  const notices = el("div", "notices");
  stage.append(notices);
  ctx.notify = (text, ms = 4000) => {
    const notice = el("div", "", text);
    notices.append(notice);
    const dismiss = () => notice.remove();
    if (ms) setTimeout(dismiss, ms);
    return dismiss;
  };

  // Windows.
  const open = new Map();
  let top = 10;
  const raise = (win) => (win.style.zIndex = ++top);

  function place(win, { x, y }) {
    x = Math.max(0, Math.min(x, stage.clientWidth - 80));
    y = Math.max(0, Math.min(y, stage.clientHeight - 30));
    win.style.left = `${x}px`;
    win.style.top = `${y}px`;
    return { x, y };
  }

  function show(a) {
    const win = el("section", "win");
    const header = el("header");
    const collapse = el("button", "", "–");
    const close = el("button", "", "×");
    collapse.title = "Collapse";
    close.title = "Close";
    header.append(el("span", "", a.title), collapse, close);
    const body = el("div", "body");
    win.append(header, body);
    win.classList.toggle("collapsed", !!saved.collapsed[a.id]);
    place(win, saved.pos[a.id] ?? { x: 12 + 24 * open.size, y: 12 + 24 * open.size });
    stage.append(win);
    raise(win);

    win.onpointerdown = () => raise(win);
    collapse.onclick = () => {
      saved.collapsed[a.id] = win.classList.toggle("collapsed");
      save();
    };
    close.onclick = () => hide(a);

    // Drag by the title bar.
    header.onpointerdown = (e) => {
      if (e.target.tagName === "BUTTON") return;
      const dx = e.clientX - win.offsetLeft;
      const dy = e.clientY - win.offsetTop;
      header.setPointerCapture(e.pointerId);
      header.onpointermove = (m) => (saved.pos[a.id] = place(win, { x: m.clientX - dx, y: m.clientY - dy }));
      header.onpointerup = () => {
        header.onpointermove = header.onpointerup = null;
        save();
      };
    };

    open.set(a.id, { win, cleanup: a.mount(body, a.ctx) });
    a.entry.dataset.open = true;
    saved.open[a.id] = true;
    save();
  }

  function hide(a) {
    const { win, cleanup } = open.get(a.id);
    cleanup?.();
    win.remove();
    open.delete(a.id);
    a.entry.dataset.open = false;
    saved.open[a.id] = false;
    save();
  }

  for (const a of all) {
    // Each applet gets the shared context plus its own storage.
    a.ctx = Object.assign(Object.create(ctx), { store: storage(`applet:${a.id}`) });
    a.setup?.(a.ctx);
  }
  for (const a of applets) {
    a.entry = el("a");
    a.entry.dataset.open = false;
    const ico = el("span", "ico", a.icon ?? a.title[0].toUpperCase());
    const close = el("button", "close", "×");
    close.title = `Close ${a.title}`;
    close.onclick = (e) => {
      e.stopPropagation();
      hide(a);
    };
    a.entry.append(ico, el("span", "label", a.title), el("span", "where"), close);
    a.entry.onclick = () => activate(a);
  }
  render();
  for (const a of applets) if (a.mount && saved.open[a.id]) show(a);

  // Click an entity to select it; right-click it for its actions.
  const menu = el("div", "menu");
  menu.hidden = true;
  stage.append(menu);
  const hideMenu = () => (menu.hidden = true);
  document.addEventListener("pointerdown", (e) => menu.contains(e.target) || hideMenu());
  document.addEventListener("keydown", (e) => e.key === "Escape" && hideMenu());

  const entityAt = (e) => ctx.entities.get(e.target.closest?.("[data-entity]")?.dataset.entity);
  stage.addEventListener("click", (e) => {
    const entity = entityAt(e);
    if (entity) ctx.entities.select(entity);
  });
  stage.addEventListener("contextmenu", (e) => {
    // On the map only; applet windows keep the browser's menu.
    if (!e.target.closest("#map")) return;
    e.preventDefault();
    const entity = entityAt(e);
    const actions = entity ? ctx.actions.for(entity) : [];
    if (!actions.length) return hideMenu();
    menu.replaceChildren(
      el("div", "title", entity.name ?? entity.id),
      ...actions.map((action) => {
        const b = el("button", "", action.label);
        b.onclick = () => {
          hideMenu();
          action.run(entity);
        };
        return b;
      }),
    );
    const at = stage.getBoundingClientRect();
    menu.style.left = `${e.clientX - at.left}px`;
    menu.style.top = `${e.clientY - at.top}px`;
    menu.hidden = false;
  });
}
