// The selected entity and everything that can be done to it.
export default {
  title: "Inspector",
  group: "World",
  keywords: ["selection", "actions"],
  icon: "ⓘ",
  order: 30,
  mount(el, { entities, actions }) {
    function render() {
      const e = entities.selected;
      if (!e) return el.replaceChildren("Click something on the map.");
      const name = document.createElement("div");
      name.textContent = e.name ?? e.id;
      el.replaceChildren(
        name,
        ...actions.for(e).map((action) => {
          const b = document.createElement("button");
          b.textContent = action.label;
          b.onclick = () => action.run(e);
          return b;
        }),
      );
    }
    render();
    entities.addEventListener("select", render);
    return () => entities.removeEventListener("select", render);
  },
};
