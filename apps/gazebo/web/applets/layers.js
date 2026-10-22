// A checkbox per map layer.
export default {
  title: "Layers",
  group: "View",
  keywords: ["imagery", "satellite", "osm", "map"],
  icon: "◧",
  order: 10,
  mount(el, { layers }) {
    function render() {
      el.replaceChildren(
        ...layers.list().map(({ id, title, layer }) => {
          const label = document.createElement("label");
          label.className = "row";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = layer.show;
          box.onchange = () => layers.show(id, box.checked);
          label.append(box, " ", title);
          return label;
        }),
      );
    }
    render();
    layers.addEventListener("change", render);
    return () => layers.removeEventListener("change", render);
  },
};
