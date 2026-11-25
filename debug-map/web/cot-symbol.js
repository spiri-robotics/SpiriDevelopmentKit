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
