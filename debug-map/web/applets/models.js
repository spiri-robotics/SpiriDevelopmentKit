// Gazebo's models (the ones with a position; ground planes are outlines).
// Click a name to select it; Follow is also on each model's right-click menu.
const isModel = (gazebo, e) => gazebo.entities.contains(e) && !!e.position;

export default {
  title: "Models",
  group: "World",
  keywords: ["gazebo", "robots", "follow"],
  icon: "☰",
  order: 20,
  setup({ viewer, gazebo, actions }) {
    actions.register({
      label: "Follow",
      when: (e) => isModel(gazebo, e),
      run: (e) => (viewer.trackedEntity = e),
    });
  },
  mount(el, { viewer, gazebo }) {
    function render() {
      const models = gazebo.entities.values.filter((e) => isModel(gazebo, e));
      if (!models.length) return el.replaceChildren("No models.");
      el.replaceChildren(
        ...models
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => {
            const row = document.createElement("div");
            row.className = "row";
            const name = document.createElement("a");
            name.textContent = e.name;
            name.onclick = () => (viewer.selectedEntity = e);
            const follow = document.createElement("button");
            follow.textContent = "Follow";
            follow.onclick = () => (viewer.trackedEntity = e);
            row.append(name, follow);
            return row;
          }),
      );
    }
    render();
    return gazebo.entities.collectionChanged.addEventListener(render);
  },
};
