import "./map-labels.css";

// Every label over the map, from every layer, in one overlay and placed in
// one pass, so no two overlap whichever layer they come from.
//
// A layer adds a label once, as a DOM element under a key of its own, and
// gives its anchor, a point on screen, every frame it should show (`at`), from
// its render; one not given an anchor in a frame is hidden for it. After the
// map has drawn, the labels are laid out: pinned ones first, exactly where
// their own CSS puts them about the anchor (a Gazebo model's label, whose
// heading arrow marks the model), then the rest by priority and from the top
// of the screen down, each just below-right of its anchor, or as far below
// that as it takes to clear every label already placed. A free label is just
// put at its anchor and left out of that: a small tag on a moving point (a
// Gazebo model's height) that would only shove the others around.
export class MapLabels {
  constructor() {
    this.items = new Map(); // key -> { el, xy, pinned, free, priority, dx, dy }
    this.overlay = document.createElement("div");
    this.overlay.className = "map-labels";
  }

  attach(map) {
    map.getCanvasContainer().append(this.overlay);
    map.on("render", () => this.layout());
  }

  // Adds element as the label at key, replacing any there, and returns it.
  add(key, element, { pinned = false, free = false, priority = 0, dx = 8, dy = 8 } = {}) {
    this.remove(key);
    element.classList.add("map-label");
    element.hidden = true;
    this.overlay.append(element);
    this.items.set(key, { el: element, xy: null, pinned, free, priority, dx, dy });
    return element;
  }

  remove(key) {
    this.items.get(key)?.el.remove();
    this.items.delete(key);
  }

  has(key) {
    return this.items.has(key);
  }

  // The label at key shows this frame, anchored at xy ([x, y] on screen).
  at(key, xy) {
    const item = this.items.get(key);
    if (item) item.xy = xy;
  }

  layout() {
    const shown = [];
    for (const item of this.items.values()) {
      item.el.hidden = !item.xy;
      if (item.xy && item.free) item.el.style.transform = `translate(${item.xy[0].toFixed(1)}px, ${item.xy[1].toFixed(1)}px)`;
      else if (item.xy) shown.push(item);
    }
    shown.sort((a, b) => b.pinned - a.pinned || b.priority - a.priority || a.xy[1] - b.xy[1]);
    const origin = this.overlay.getBoundingClientRect();
    const placed = [];
    for (const item of shown) {
      const [x, y] = item.xy;
      if (item.pinned) {
        item.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        const r = item.el.getBoundingClientRect();
        placed.push({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
        continue;
      }
      const box = { x: x + item.dx, y: y + item.dy, w: item.el.offsetWidth, h: item.el.offsetHeight };
      for (let moved = true; moved; ) {
        moved = false;
        for (const o of placed) {
          if (box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h) {
            box.y = o.y + o.h + 2;
            moved = true;
          }
        }
      }
      placed.push(box);
      item.el.style.transform = `translate(${box.x.toFixed(1)}px, ${box.y.toFixed(1)}px)`;
    }
    // Each frame anew: a label shows only while its layer keeps placing it.
    for (const item of this.items.values()) item.xy = null;
  }
}
