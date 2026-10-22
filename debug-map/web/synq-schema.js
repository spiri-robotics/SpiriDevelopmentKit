import { parse } from "yaml";
import "./synq-schema.css";

// A SpiriSynq object schema (sr_object_schema: JSON Schema 2020-12 with
// x- keywords, see docs/protocol.md §9 in SpiriSynq), drawn for people:
// fields with Python-style types, defaults and help, then RPC methods, then
// the types they use. Methods can be called from it.

// Schemas are sent as YAML but hold only JSON values. Read as YAML 1.2, so
// a parameter called `n` or `y` stays a name rather than a YAML 1.1 bool.
export function parseSchema(text) {
  return parse(text, { logLevel: "error" });
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const SCALARS = { integer: "int", number: "float", string: "str", boolean: "bool", null: "None", array: "list", object: "dict" };
const tag = (t) => t?.replace(/^!+/, "");

// A value schema as a Python-ish type: `float | None`, `list[Gimbal]`,
// `Literal["idle", "run"]`.
export function typeName(s) {
  if (!s || typeof s !== "object" || !Object.keys(s).length) return "Any";
  if (s.$ref) return s.$ref.startsWith("#/$defs/") ? s.$ref.slice(8) : s.$ref === "#" ? "Self" : "Schema";
  if (s.anyOf) return s.anyOf.map(typeName).join(" | ");
  if (s.enum) {
    const lit = s.enum.filter((v) => v !== null).map((v) => JSON.stringify(v));
    return `Literal[${lit.join(", ")}]${s.enum.includes(null) ? " | None" : ""}`;
  }
  if (s["x-python-type"]) return s["x-python-type"];
  const types = [s.type].flat().filter(Boolean);
  const nullable = types.includes("null") && types.length > 1;
  const base = types.filter((t) => !nullable || t !== "null")[0];
  let name;
  if (s.contentEncoding === "base64") name = "bytes";
  else if (base === "array") {
    if (s.prefixItems) name = `tuple[${s.prefixItems.map(typeName).join(", ")}]`;
    else {
      const items = s.items === undefined ? "Any" : typeName(s.items);
      const kind = s["x-yaml-tag"] === "!!set" || s.uniqueItems ? "set" : "list";
      name = `${tag(s["x-yaml-tag"])?.startsWith("Evented") ? tag(s["x-yaml-tag"]) : kind}[${items}]`;
    }
  } else if (base === "object" && s.additionalProperties !== undefined) {
    name = `dict[str, ${typeName(s.additionalProperties)}]`;
  } else name = SCALARS[base] ?? base ?? "Any";
  return nullable ? `${name} | None` : name;
}

// A default as Python would write it: None, True, 0.0, "idle".
function pyRepr(v, s) {
  if (v === null) return "None";
  if (v === true || v === false) return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) && typeName(s).startsWith("float") ? `${v}.0` : String(v);
  if (Array.isArray(v)) return `[${v.map((x) => pyRepr(x, s?.items)).join(", ")}]`;
  if (typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyRepr(x, s?.properties?.[k])}`).join(", ")}}`;
  return JSON.stringify(v);
}

function fields(schema) {
  const props = schema.properties ?? {};
  const names = Object.keys(props);
  if (!names.length) return el("div", "none", "No fields.");
  const list = el("div", "fields");
  for (const name of names) {
    const p = props[name];
    const row = el("div", "field");
    const head = el("div", "head");
    head.append(el("span", "name", name), el("span", "type", typeName(p)));
    if ("default" in p) head.append(el("span", "default", `= ${pyRepr(p.default, p)}`));
    if (p["x-encoding"]) head.append(el("span", "enc", p["x-encoding"]));
    row.append(head);
    if (p.description) row.append(el("div", "help", p.description));
    list.append(row);
  }
  return list;
}

// One input per parameter, by type. read() gives the argument as YAML,
// undefined to leave it out, or throws if it can't be sent.
function paramInput(name, s, required) {
  const types = [s.type].flat().filter(Boolean);
  const nullable = types.includes("null") || s.enum?.includes(null) || s.anyOf?.some((a) => a.type === "null");
  const base = types.filter((t) => t !== "null");
  const has = "default" in s;
  const missing = () => {
    if (nullable) return "null";
    if (!required) return undefined;
    throw new Error(`${name} is required`);
  };
  let input;
  let read;
  if (s.enum) {
    input = el("select");
    for (const v of s.enum) {
      const o = el("option", "", v === null ? "None" : String(v));
      o.value = JSON.stringify(v);
      input.append(o);
    }
    if (has) input.value = JSON.stringify(s.default);
    read = () => input.value;
  } else if (base.length === 1 && base[0] === "boolean") {
    input = el("input");
    input.type = "checkbox";
    input.checked = s.default === true;
    read = () => String(input.checked);
  } else if (base.length === 1 && (base[0] === "integer" || base[0] === "number")) {
    input = el("input");
    input.inputMode = "decimal";
    if (has && s.default !== null) input.value = String(s.default);
    read = () => {
      const t = input.value.trim();
      if (!t) return missing();
      if (!Number.isFinite(Number(t)) || (base[0] === "integer" && !Number.isInteger(Number(t)))) {
        throw new Error(`${name} must be ${base[0] === "integer" ? "an integer" : "a number"}`);
      }
      return t;
    };
  } else if (base.length === 1 && base[0] === "string" && !s.contentEncoding) {
    input = el("input");
    if (has && s.default !== null) input.value = s.default;
    read = () => (!input.value && nullable ? "null" : JSON.stringify(input.value));
  } else {
    // Anything else is written as YAML: [1, 2], {pitch: 3.0}, !Gimbal {…}.
    input = el("input");
    input.placeholder = "YAML";
    if (has) input.value = JSON.stringify(s.default);
    read = () => input.value.trim() || missing();
  }
  const row = el("label", "param");
  row.append(el("span", "name", name), el("span", "type", typeName(s)), input);
  return { row, read };
}

// A method's call form and results. call(args, onReply) does the calling.
function callForm(name, m, call) {
  const box = el("div", "call");
  const props = m.parameters?.properties ?? {};
  const required = new Set(m.parameters?.required ?? []);
  const inputs = Object.entries(props)
    .sort(([, x], [, y]) => ("default" in x) - ("default" in y))
    .map(([p, s]) => [p, paramInput(p, s, required.has(p))]);
  const go = el("button", "go", "Call");
  const out = el("pre", "result");
  out.hidden = true;
  box.append(...inputs.map(([, i]) => i.row), go, out);
  go.onclick = async (e) => {
    e.preventDefault();
    const args = {};
    try {
      for (const [p, i] of inputs) {
        const v = i.read();
        if (v !== undefined) args[p] = v;
      }
    } catch (err) {
      out.hidden = false;
      out.className = "result error";
      out.textContent = err.message;
      return;
    }
    out.hidden = false;
    out.className = "result";
    out.textContent = "…";
    go.disabled = true;
    const lines = [];
    const show = (text, error) => {
      lines.push(text);
      out.textContent = lines.join("\n");
      if (error) out.className = "result error";
    };
    try {
      await call(args, ({ yaml, done, error }) => {
        if (error) show(error, true);
        else if (m["x-generator"]) show(done ? `→ ${yaml}` : `• ${yaml}`);
        else show(yaml);
      });
    } catch (err) {
      show(err.message, true);
    } finally {
      go.disabled = false;
    }
  };
  return box;
}

function methods(endpoints, call) {
  const list = el("div", "fields");
  const names = Object.keys(endpoints ?? {}).sort((a, b) => a.startsWith("sr_") - b.startsWith("sr_") || a.localeCompare(b));
  for (const name of names) {
    const m = endpoints[name];
    // The schema doesn't keep the signature's order; required ones first, as
    // Python has them.
    const params = Object.entries(m.parameters?.properties ?? {})
      .sort(([a, x], [b, y]) => ("default" in x) - ("default" in y))
      .map(([p, s]) => `${p}: ${typeName(s)}${"default" in s ? ` = ${pyRepr(s.default, s)}` : ""}`);
    const returns = m["x-generator"] ? `Generator[${typeName(m.yields)}, None, ${typeName(m.returns)}]` : typeName(m.returns);
    const row = el("div", "field" + (name.startsWith("sr_") ? " builtin" : ""));
    const head = el("div", "head");
    head.append(el("span", "name", name), el("span", "type", `(${params.join(", ")}) → ${returns}`));
    row.append(head);
    if (m.description) row.append(el("div", "help", m.description));
    if (call) {
      const open = el("button", "open", "Call…");
      head.append(open);
      let form = null;
      open.onclick = () => {
        if (form) {
          form.remove();
          form = null;
          open.textContent = "Call…";
        } else {
          row.append((form = callForm(name, m, (args, onReply) => call(name, args, onReply))));
          open.textContent = "Close";
        }
      };
    }
    list.append(row);
  }
  return list;
}

function section(title, body, open = true) {
  const d = el("details", "section");
  d.open = open;
  d.append(el("summary", "", title), body);
  return d;
}

// The schema, drawn. `raw` is the text it was parsed from, shown on request.
// With call(method, args, onReply) (see callMethod in synq.js), each method
// gets a form to call it with.
export function renderSchema(schema, raw, { call } = {}) {
  const root = el("div", "synq-schema");
  const classes = (schema["x-classes"] ?? []).map(tag);
  root.append(el("div", "classes", classes.join(" · ") || schema.title || "object"));
  if (schema.description) root.append(el("div", "help", schema.description));
  if (!schema["x-spirisynq-schema"]) root.append(el("div", "warn", "Old schema format (before SpiriSynq 0.3); types may be wrong."));
  root.append(section("Fields", fields(schema)));
  const endpoints = schema["x-rpc-endpoints"] ?? {};
  const own = Object.keys(endpoints).filter((n) => !n.startsWith("sr_")).length;
  root.append(section(`Methods (${own}${own === Object.keys(endpoints).length ? "" : " + built-in"})`, methods(endpoints, call)));
  // Types the fields and methods use, other than the protocol's own.
  const defs = Object.entries(schema.$defs ?? {}).filter(([name]) => name !== "SyncableObjectMetadata");
  if (defs.length) {
    const box = el("div", "defs");
    for (const [name, def] of defs) {
      box.append(el("div", "def-name", name));
      if (def.description) box.append(el("div", "help", def.description));
      box.append(fields(def));
    }
    root.append(section(`Types (${defs.length})`, box, false));
  }
  if (raw) root.append(section("Raw", el("pre", "raw", raw), false));
  return root;
}
