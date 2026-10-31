import "./coverage-bands.css";
import { JOHNSON_BANDS } from "./synq-frames.js";

// The Camera coverage layer's settings, in its Layers row: a line per band,
// each a target (an object so many metres across that must span so many
// pixels, so its range follows each camera's lens) or a fixed distance.
// Changes apply as they're typed and are kept in this browser.
export function bandEditor(el, frames) {
  const list = document.createElement("div");
  list.className = "bands";

  const input = (value, onChange, { step = "any", min = "0", width = "" } = {}) => {
    const field = document.createElement("input");
    field.type = "number";
    field.step = step;
    field.min = min;
    field.value = value ?? "";
    if (width) field.style.width = width;
    field.oninput = () => onChange(field.valueAsNumber);
    return field;
  };
  const text = (value, title) => {
    const span = document.createElement("span");
    span.className = "unit";
    span.textContent = value;
    if (title) span.title = title;
    return span;
  };

  function band(b, i) {
    const bands = frames.bands;
    const save = () => frames.setBands([...bands]);
    const row = document.createElement("div");
    row.className = "band";

    const name = document.createElement("input");
    name.className = "name";
    name.value = b.name ?? "";
    name.placeholder = "name";
    name.oninput = () => {
      b.name = name.value;
      save();
    };

    const mode = document.createElement("select");
    mode.title = "pixels: an object's size, and the pixels it must span; distance: a fixed range";
    for (const [value, label] of [["pixels", "pixels"], ["distance", "distance"]]) mode.add(new Option(label, value));
    mode.value = b.mode ?? "pixels";
    mode.onchange = () => {
      b.mode = mode.value;
      save();
      render();
    };

    const fields =
      b.mode === "distance"
        ? [text("out to"), input(b.range, (v) => ((b.range = v), save()), { width: "56px" }), text("m")]
        : [
            input(b.size, (v) => ((b.size = v), save()), { width: "48px" }),
            text("m wide, needs", "the object's size: its critical dimension"),
            input(b.pixels, (v) => ((b.pixels = v), save()), { width: "36px", step: "1" }),
            text("px", "pixels it must span; Johnson's recognition is 8 (4 line pairs)"),
          ];

    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Remove";
    remove.onclick = () => {
      frames.setBands(bands.filter((_, j) => j !== i));
      render();
    };

    row.append(name, mode, ...fields, remove);
    return row;
  }

  const about = document.createElement("p");
  about.className = "about";
  about.textContent =
    "Johnson's criteria: an object is recognised once its critical dimension " +
    "spans 4 line pairs, 8 px. Each band ends where its object does, through " +
    "each camera's lens. The defaults are a person (0.75 m) and a car (2.3 m).";

  function render() {
    const add = document.createElement("button");
    add.textContent = "+ Band";
    add.onclick = () => {
      frames.setBands([...frames.bands, { name: "", mode: "pixels", size: 1, pixels: 8 }]);
      render();
    };
    const reset = document.createElement("button");
    reset.textContent = "Defaults";
    reset.title = "Replace these bands with the defaults: a person (0.75 m) and a car (2.3 m), 8 px each";
    reset.onclick = () => {
      frames.setBands(structuredClone(JOHNSON_BANDS));
      render();
    };
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(add, reset);
    list.replaceChildren(about, ...frames.bands.map(band), actions);
  }

  render();
  el.append(list);
}
