import "./layers.css";

// A checkbox per map layer, in sections: offline layers by their zenoh key,
// the online ones, the simulation.
export default {
  title: "Layers",
  group: "View",
  keywords: ["imagery", "satellite", "osm", "map", "offline", "terrain"],
  icon: "◧",
  order: 10,
  mount(el, { layers }) {
    el.classList.add("layers");
    const expanded = new Set(); // ids of layers whose settings are open
    function row({ id, title, layer, info, details }) {
      const label = document.createElement("label");
      label.className = "row";
      if (info) label.title = info;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = layer.show;
      box.onchange = () => layers.show(id, box.checked);
      const name = document.createElement("span");
      name.textContent = title;
      label.append(box, name);
      if (!details) return label;

      // A layer with settings: a toggle at the row's end opens them below it.
      const toggle = document.createElement("button");
      toggle.className = "expand";
      toggle.title = "Settings";
      const panel = document.createElement("div");
      panel.className = "details";
      const show = (open) => {
        toggle.textContent = open ? "▾" : "▸";
        panel.hidden = !open;
        if (open && !panel.childElementCount) details(panel);
      };
      toggle.onclick = (e) => {
        e.preventDefault(); // not the checkbox
        if (!expanded.delete(id)) expanded.add(id);
        show(expanded.has(id));
      };
      label.append(toggle);
      show(expanded.has(id));
      const wrap = document.createElement("div");
      wrap.append(label, panel);
      return wrap;
    }
    function render() {
      el.replaceChildren(
        ...layers.sections().flatMap(({ name, empty, items }) => {
          const head = document.createElement("div");
          head.className = "section";
          head.textContent = name;
          const note = document.createElement("div");
          note.className = "empty";
          note.textContent = empty;
          return [head, ...(items.length ? items.map(row) : empty ? [note] : [])];
        }),
      );
    }
    render();
    layers.addEventListener("change", render);
    return () => layers.removeEventListener("change", render);
  },
};
