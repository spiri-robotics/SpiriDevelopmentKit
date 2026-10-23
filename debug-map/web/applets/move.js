// Move… and Reset, on each model's right-click menu and in the Inspector.
// Move… teleports a model to the next place clicked on the map; Reset respawns
// a robot where it first spawned, at rest. No window: actions only.
const isModel = (e) => e.kind === "model";

// The next point clicked on the map, as [lng, lat], or null on Escape.
function pickPoint(map, notify, text) {
  return new Promise((resolve) => {
    const canvas = map.getCanvas();
    const dismiss = notify(`${text} (Esc to cancel)`, 0);
    const done = (at) => {
      dismiss();
      canvas.style.cursor = "";
      map.off("click", onClick);
      document.removeEventListener("keydown", onKey);
      resolve(at);
    };
    const onClick = (e) => done(e.lngLat.toArray());
    const onKey = (e) => e.key === "Escape" && done(null);
    canvas.style.cursor = "crosshair";
    map.on("click", onClick);
    document.addEventListener("keydown", onKey);
  });
}

export default {
  title: "Move and reset",
  group: "World",
  setup({ actions, map, gz, notify }) {
    actions.register({
      label: "Move…",
      when: isModel,
      run: async (e) => {
        const at = await pickPoint(map, notify, `Click where to move ${e.name}`);
        if (!at) return;
        try {
          await gz.moveTo(e.id, at);
        } catch (err) {
          notify(`Couldn't move ${e.name}: ${err.message}`);
        }
      },
    });
    actions.register({
      label: "Reset",
      when: isModel,
      run: async (e) => {
        const dismiss = notify(`Resetting ${e.name}…`, 0);
        try {
          await gz.respawn(e.id);
        } catch (err) {
          notify(`Couldn't reset ${e.name}: ${err.message}`);
        } finally {
          dismiss();
        }
      },
    });
  },
};
