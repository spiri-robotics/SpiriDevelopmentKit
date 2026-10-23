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
    function row({ id, title, layer, info }) {
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
      return label;
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
