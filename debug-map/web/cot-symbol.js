import ms from "milsymbol";

// A Cursor on Target type's MIL-STD-2525 symbol, as SVG markup, or null.
//
// An atom's type (`a-<affiliation>-<dimension>-<function…>`, such as
// `a-u-G-U-C-I`) is a 2525 symbol id with its letters spelt out: affiliation
// is the standard identity (f, h, n, u, p, a, s, j, k, o), dimension the
// battle dimension, and the rest the function id. The status is "present".
// Other types (`b-` bits such as a sensor point, `t-` tasking) have no 2525
// symbol, so get none. milsymbol draws it, as TAK's own icons do.

const cache = new Map(); // cot type -> svg or null

// ATAK's team colours, by the name it sends in <__group name=...>.
const TEAM_COLOURS = {
  White: "#ffffff", Yellow: "#ffff00", Orange: "#ff8000", Magenta: "#ff00ff", Red: "#ff0000",
  Maroon: "#800000", Purple: "#800080", "Dark Blue": "#000080", Blue: "#0000ff", Cyan: "#00ffff",
  Teal: "#008080", Green: "#00ff00", "Dark Green": "#008000", Brown: "#a0522d",
};
// Without a team: the affiliation's colour, as ATAK colours its frames.
const AFFILIATION_COLOURS = { f: "#80e0ff", h: "#ff8080", n: "#aaffaa", u: "#ffff80" };
const HEX = /^#[0-9a-f]{6}$/i;

const svg = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-10 -10 20 20">${body}</svg>`;

// What ATAK draws for a detection heard from TAK (or sent to it), as SpiriTak's
// camera HUD does: an ATAK user (one with a team) is a circle in the team's
// colour; another unit its 2525 symbol; a spot marker (b-m-p-s-m) a dot in its
// own colour; anything else with a CoT type a small white diamond. Null
// without a CoT type: not a TAK thing.
export function takIcon(det, size = 18) {
  const type = det.cot_type;
  if (det.team != null) {
    return svg(size - 4, `<circle r="7.5" fill="${TEAM_COLOURS[det.team] ?? "#ffffff"}" stroke="black" stroke-width="2"/>`);
  }
  if (!type) return null;
  const symbol = cotSymbol(type, size);
  if (symbol) return symbol;
  if (type.startsWith("b-m-p-s-m")) {
    const fill = HEX.test(det.colour ?? "") ? det.colour : "#ffffff";
    return svg(size - 6, `<circle r="7" fill="${fill}" stroke="black" stroke-width="2"/>`);
  }
  return svg(size - 6, `<path d="M0 -8 L8 0 L0 8 L-8 0 Z" fill="white" stroke="black" stroke-width="2"/>`);
}

// A TAK detection's callsign colour, as ATAK writes it: its team's, else its
// affiliation's, else null (the map's own).
export function takColour(det) {
  if (det.team != null && TEAM_COLOURS[det.team]) return TEAM_COLOURS[det.team];
  const t = det.cot_type ?? "";
  return t.startsWith("a-") ? (AFFILIATION_COLOURS[t[2]] ?? null) : null;
}

export function cotSymbol(type, size = 18) {
  if (!type) return null;
  if (!cache.has(type)) cache.set(type, build(type, size));
  return cache.get(type);
}

function build(type, size) {
  // Letters only, so what goes into the id (and the markup) is ours.
  const parts = type.split("-");
  if (parts[0] !== "a" || parts.length < 3 || !parts.every((p) => /^[A-Za-z]$/.test(p))) return null;
  const [, affiliation, dimension, ...fn] = parts;
  if (fn.length > 6) return null;
  const sidc = `S${affiliation}${dimension}P${fn.join("").padEnd(6, "-")}-----`.toUpperCase();
  const symbol = new ms.Symbol(sidc, { size });
  return symbol.isValid() ? symbol.asSVG() : null;
}
