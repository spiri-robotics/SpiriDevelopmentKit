// Gazebo's models (ground planes are outlines, not models).
// Click a name to select it; Follow is also on each model's right-click menu.
// Following stops with Stop following, Esc, or by dragging the map.
const isModel = (e) => e.kind === "model";

export default {
  title: "Models",
  group: "World",
  keywords: ["gazebo", "robots", "follow"],
  icon: "☰",
  order: 20,
  setup({ entities, actions }) {
    actions.register({
      label: "Follow",
      when: (e) => isModel(e) && entities.tracked !== e,
      run: (e) => entities.track(e),
    });
    actions.register({
      label: "Stop following",
      when: (e) => entities.tracked === e,
      run: () => entities.track(null),
    });
    document.addEventListener("keydown", (e) => {
      const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
      if (e.key === "Escape" && !typing) entities.track(null);
    });
  },
  mount(el, { entities }) {
    function render() {
      const models = entities.values.filter(isModel);
      if (!models.length) return el.replaceChildren("No models.");
      el.replaceChildren(
        ...models
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => {
            const row = document.createElement("div");
            row.className = "row";
            const name = document.createElement("a");
            name.textContent = e.name;
            name.onclick = () => entities.select(e);
            const following = entities.tracked === e;
            const follow = document.createElement("button");
            follow.textContent = following ? "Stop following" : "Follow";
            follow.onclick = () => entities.track(following ? null : e);
            row.append(name, follow);
            return row;
          }),
      );
    }
    render();
    entities.addEventListener("change", render);
    entities.addEventListener("track", render);
    return () => {
      entities.removeEventListener("change", render);
      entities.removeEventListener("track", render);
    };
  },
};
