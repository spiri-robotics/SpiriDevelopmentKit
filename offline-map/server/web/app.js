import { Map as MapLibre, NavigationControl, setWorkerUrl } from "./vendor/maplibre-gl.mjs";
import { layers as basemapLayers, namedFlavor } from "./vendor/basemaps.mjs";

// The downloaded regions: each layer's files listed, and outlined on a map
// drawn from those same files, so what you see is what's offline. New regions
// are a box drawn on the map, cut from the planets by the server.

setWorkerUrl(new URL("vendor/maplibre-gl-worker.mjs", import.meta.url).href);

const COLORS = { osm: "#7aa2f7", terrain: "#e0af68" };
const color = (layer) => COLORS[layer] ?? "#bb9af7";
const POLL_IDLE_MS = 10000;
const POLL_BUSY_MS = 1500;
const ESTIMATE_DELAY_MS = 600;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const $ = (id) => document.getElementById(id);
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
const tileUrl = (layer) => new URL(`tiles/${layer}/{z}/{x}/{y}`, location.href).href.replace(/%7B/g, "{").replace(/%7D/g, "}");

function size(n) {
  if (n == null) return "";
  if (n < 1e6) return `${Math.max(1, Math.round(n / 1e3))} kB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}
const zooms = (r) => (r.minzoom === r.maxzoom ? `z${r.maxzoom}` : `z${r.minzoom}–${r.maxzoom}`);
const fmtBbox = (b) => b.map((v) => v.toFixed(3)).join(", ");
function sourceLabel(src) {
  if (!src) return "";
  const m = src.match(/build\.protomaps\.com\/(\d{4})(\d{2})(\d{2})/);
  if (m) return `Protomaps ${m[1]}-${m[2]}-${m[3]}`;
  if (src.includes("mapterhorn")) return "Mapterhorn";
  return src;
}
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body && typeof options.body === "string" ? { "Content-Type": "application/json" } : options.headers,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}
const boxPolygon = ([w, s, e, n]) => ({
  type: "Polygon",
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
});

// --- Map -------------------------------------------------------------------

// Protomaps' dark style, its labels in English. Outside every region the
// server makes deep tiles from the z6 base that ships in the image, so you can
// always tell where you are; regions draw in full detail. Fills and lines,
// and labels, are apart so labels go on top of everything.
const osmStyle = basemapLayers("osm", namedFlavor("dark"), { lang: "en" });
const osm = { shapes: osmStyle.filter((l) => l.type !== "symbol"), labels: osmStyle.filter((l) => l.type === "symbol") };
const absolute = (path) => new URL(path, location.href).href;

const map = new MapLibre({
  container: "map",
  center: [-63.58, 44.65],
  zoom: 3,
  attributionControl: { compact: true },
  style: {
    version: 8,
    // Fonts and sprites from the image, so labels work offline.
    glyphs: `${absolute("assets/fonts/")}{fontstack}/{range}.pbf`,
    sprite: absolute("assets/sprites/v4/dark"),
    sources: {
      osm: {
        type: "vector",
        tiles: [tileUrl("osm")],
        maxzoom: 15,
        attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>',
      },
      // Online only: choosing a region needs the internet anyway.
      satellite: {
        type: "raster",
        tiles: ["https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
      },
      coverage: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      draft: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [
      ...osm.shapes,
      { id: "satellite", type: "raster", source: "satellite", layout: { visibility: "none" } },
      {
        id: "coverage-fill",
        type: "fill",
        source: "coverage",
        paint: {
          "fill-color": ["get", "color"],
          "fill-opacity": ["case", ["boolean", ["feature-state", "hot"], false], 0.25, 0.06],
        },
      },
      {
        id: "coverage-line",
        type: "line",
        source: "coverage",
        paint: {
          "line-color": ["get", "color"],
          "line-width": ["case", ["boolean", ["feature-state", "hot"], false], 2.5, 1.2],
        },
      },
      { id: "draft-fill", type: "fill", source: "draft", paint: { "fill-color": "#fff", "fill-opacity": 0.08 } },
      { id: "draft-line", type: "line", source: "draft", paint: { "line-color": "#fff", "line-width": 1.5, "line-dasharray": [2, 2] } },
      ...osm.labels,
    ],
  },
});
map.addControl(new NavigationControl({ visualizePitch: false }), "top-right");
window.map = map; // for the console

// Map or satellite underneath; labels stay on top of either.
class BackdropControl {
  onAdd() {
    const box = el("div", "maplibregl-ctrl backdrop");
    const pick = (which) => {
      map.setLayoutProperty("satellite", "visibility", which === "satellite" ? "visible" : "none");
      for (const b of box.children) b.classList.toggle("active", b.dataset.which === which);
    };
    for (const [which, label, title] of [
      ["map", "Map", "The offline map"],
      ["satellite", "Satellite", "Esri World Imagery, online"],
    ]) {
      const b = el("button", which === "map" ? "active" : "", label);
      b.type = "button";
      b.dataset.which = which;
      b.title = title;
      b.onclick = () => pick(which);
      box.append(b);
    }
    return box;
  }
  onRemove() {}
}
map.addControl(new BackdropControl(), "top-left");
// Tiles outside every region are missing on purpose, and satellite tiles are
// missing offline. Nothing to show for either.
map.on("error", (e) => {
  if (!e.sourceId) console.warn(e.error);
});

// --- State -----------------------------------------------------------------

let data = { layers: [], jobs: [] };
let tilesVersion = "";
let fitted = false;
let bbox = null;
const picked = {}; // layer -> { on, maxzoom }
let hot = null; // feature id of the highlighted region

function setHot(id) {
  if (hot === id) return;
  if (hot !== null) map.setFeatureState({ source: "coverage", id: hot }, { hot: false });
  hot = id;
  if (hot !== null) map.setFeatureState({ source: "coverage", id: hot }, { hot: true });
  document.querySelectorAll(".region").forEach((r) => r.classList.toggle("hot", Number(r.dataset.fid) === hot));
}

// --- Downloaded ------------------------------------------------------------

function render() {
  const features = [];
  const list = $("layers");
  list.replaceChildren();
  let fid = 0;
  for (const layer of data.layers) {
    const box = el("div", "layer");
    const head = el("div", "layer-head");
    const sw = el("span", "swatch");
    sw.style.background = color(layer.name);
    const total = layer.regions.reduce((n, r) => n + r.size, 0);
    head.append(sw, el("span", "", layer.title), el("span", "muted", `${layer.kind} · ${size(total)}`));
    box.append(head);
    if (!layer.regions.length) box.append(el("div", "empty", "Nothing downloaded."));
    for (const r of layer.regions) {
      const id = fid++;
      features.push({ type: "Feature", id, properties: { color: color(layer.name) }, geometry: boxPolygon(r.bounds) });
      const row = el("div", "region");
      row.dataset.fid = id;
      row.append(el("span", "name", r.name), el("span", "size", size(r.size)));
      if (r.base) {
        row.append(el("span", "muted small", "built in"));
      } else {
        const del = el("button", "icon", "✕");
        del.title = `Delete ${r.name}`;
        del.onclick = async () => {
          if (!confirm(`Delete ${layer.title} region "${r.name}" (${size(r.size)})?`)) return;
          try {
            await api(`api/regions/${layer.name}/${r.name}`, { method: "DELETE" });
          } catch (e) {
            alert(e.message);
          }
          refresh();
        };
        row.append(del);
      }
      const when = r.base ? "" : new Date(r.mtime * 1000).toLocaleDateString();
      row.append(el("span", "meta", [zooms(r), sourceLabel(r.source), when].filter(Boolean).join(" · ")));
      row.onmouseenter = () => setHot(id);
      row.onmouseleave = () => setHot(null);
      row.ondblclick = () => map.fitBounds(r.bounds, { padding: 40, maxZoom: 14 });
      row.title = "Double-click to zoom to it";
      box.append(row);
    }
    list.append(box);
  }
  map.getSource("coverage")?.setData({ type: "FeatureCollection", features });
  hot = null;

  // Tiles that were missing may exist now.
  const version = data.layers.map((l) => l.regions.map((r) => `${r.name}@${r.mtime}`).join()).join("|");
  if (version !== tilesVersion) {
    const first = tilesVersion === "";
    tilesVersion = version;
    if (!first)
    for (const l of data.layers) {
      const src = map.getSource(l.name);
      if (src?.setTiles) src.setTiles([`${tileUrl(l.name)}?v=${encodeURIComponent(version.length + ":" + Date.now())}`]);
    }
  }

  if (!fitted) {
    const regions = data.layers.flatMap((l) => l.regions.filter((r) => !r.base));
    if (regions.length) {
      const b = regions.reduce((a, r) => [Math.min(a[0], r.bounds[0]), Math.min(a[1], r.bounds[1]), Math.max(a[2], r.bounds[2]), Math.max(a[3], r.bounds[3])], [180, 90, -180, -90]);
      map.fitBounds(b, { padding: 60, maxZoom: 12, duration: 0 });
    }
    fitted = true;
  }

  renderAddLayers();
  renderJobs();
  renderUploadLayers();
}

// --- Add a region ----------------------------------------------------------

function renderAddLayers() {
  const box = $("add-layers");
  const cuttable = data.layers.filter((l) => l.can_cut);
  if (box.dataset.names === cuttable.map((l) => l.name).join()) return;
  box.dataset.names = cuttable.map((l) => l.name).join();
  box.replaceChildren();
  for (const l of cuttable) {
    picked[l.name] ??= { on: true, maxzoom: l.default_maxzoom };
    const row = el("label", "add-layer");
    const on = el("input");
    on.type = "checkbox";
    on.checked = picked[l.name].on;
    on.onchange = () => {
      picked[l.name].on = on.checked;
      changed();
    };
    const sw = el("span", "swatch");
    sw.style.background = color(l.name);
    const name = el("span", "", l.title);
    name.prepend(sw, " ");
    const zoom = el("select");
    for (let z = 4; z <= l.planet_maxzoom; z++) {
      const o = el("option", "", `to z${z}`);
      o.value = z;
      zoom.append(o);
    }
    zoom.value = picked[l.name].maxzoom;
    zoom.onchange = () => {
      picked[l.name].maxzoom = Number(zoom.value);
      changed();
    };
    const est = el("span", "size");
    est.id = `est-${l.name}`;
    row.append(on, name, zoom, est);
    box.append(row);
  }
}

function wanted() {
  return Object.fromEntries(Object.entries(picked).filter(([, p]) => p.on).map(([l, p]) => [l, p.maxzoom]));
}

let estimateTimer = null;
let estimateSeq = 0;
function changed() {
  $("add-error").textContent = "";
  const name = $("name").value.trim();
  const layers = wanted();
  $("download").disabled = !(bbox && NAME.test(name) && Object.keys(layers).length);
  $("name").classList.toggle("bad", name !== "" && !NAME.test(name));
  for (const l of Object.keys(picked)) $(`est-${l}`) && ($(`est-${l}`).textContent = "");
  $("estimate").textContent = "";
  clearTimeout(estimateTimer);
  if (!bbox || !Object.keys(layers).length) return;
  for (const l of Object.keys(layers)) $(`est-${l}`).textContent = "…";
  estimateTimer = setTimeout(estimate, ESTIMATE_DELAY_MS);
}

async function estimate() {
  const seq = ++estimateSeq;
  const layers = wanted();
  try {
    const sizes = await api("api/estimate", { method: "POST", body: JSON.stringify({ bbox, layers }) });
    if (seq !== estimateSeq) return;
    let total = 0;
    let failed = null;
    for (const [l, s] of Object.entries(sizes)) {
      const cell = $(`est-${l}`);
      if (typeof s === "number") {
        total += s;
        if (cell) cell.textContent = size(s);
      } else {
        failed = s.error;
        if (cell) cell.textContent = "?";
      }
    }
    $("estimate").textContent = failed ? "" : `About ${size(total)} in all.`;
    if (failed) $("add-error").textContent = `Can't reach the planet builds: ${failed}`;
  } catch (e) {
    if (seq !== estimateSeq) return;
    $("add-error").textContent = e.message;
  }
}

function setBbox(b) {
  bbox = b && [Math.max(-180, b[0]), Math.max(-85.05, b[1]), Math.min(180, b[2]), Math.min(85.05, b[3])];
  $("bbox").textContent = bbox ? fmtBbox(bbox) : "No area chosen.";
  map.getSource("draft").setData({
    type: "FeatureCollection",
    features: bbox ? [{ type: "Feature", properties: {}, geometry: boxPolygon(bbox) }] : [],
  });
  changed();
}

$("use-view").onclick = () => {
  const b = map.getBounds();
  setBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
};

// Drawing: press, drag, release. The map doesn't pan meanwhile.
let drawing = false;
let start = null;
function stopDrawing() {
  drawing = false;
  start = null;
  $("draw").classList.remove("active");
  map.getCanvas().style.cursor = "";
  map.dragPan.enable();
}
$("draw").onclick = () => {
  if (drawing) return stopDrawing();
  drawing = true;
  $("draw").classList.add("active");
  map.getCanvas().style.cursor = "crosshair";
  map.dragPan.disable();
};
map.on("mousedown", (e) => {
  if (drawing) start = e.lngLat;
});
map.on("mousemove", (e) => {
  if (!drawing || !start) return;
  const a = start;
  const b = e.lngLat;
  bbox = null;
  map.getSource("draft").setData({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: boxPolygon([Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)]) }],
  });
});
map.on("mouseup", (e) => {
  if (!drawing || !start) return;
  const a = start;
  const b = e.lngLat;
  stopDrawing();
  if (Math.abs(a.lng - b.lng) < 1e-6 || Math.abs(a.lat - b.lat) < 1e-6) return setBbox(null);
  setBbox([Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)]);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && drawing) stopDrawing();
});

$("name").oninput = changed;

$("download").onclick = async () => {
  const name = $("name").value.trim();
  const layers = wanted();
  const existing = data.layers.filter((l) => layers[l.name] !== undefined && l.regions.some((r) => r.name === name && !r.base));
  if (existing.length && !confirm(`Replace the existing "${name}" in ${existing.map((l) => l.title).join(" and ")}?`)) return;
  $("download").disabled = true;
  try {
    await api("api/regions", { method: "POST", body: JSON.stringify({ name, bbox, layers }) });
    $("name").value = "";
    setBbox(null);
  } catch (e) {
    $("add-error").textContent = e.message;
  }
  refresh();
};

// --- Jobs ------------------------------------------------------------------

function renderJobs() {
  const box = $("jobs");
  $("jobs-section").hidden = !data.jobs.length;
  box.replaceChildren(
    ...data.jobs
      .slice()
      .reverse()
      .map((j) => {
        const title = data.layers.find((l) => l.name === j.layer)?.title ?? j.layer;
        const row = el("div", "job");
        row.append(el("span", "", `${j.name} · ${title} to z${j.maxzoom}`));
        const right = el("span", "row");
        let state = j.state;
        if (j.state === "running" && j.estimate) state = `${size(j.bytes)} of ${size(j.estimate)}`;
        if (j.state === "done") state = `done · ${size(j.bytes)}`;
        right.append(el("span", `state ${j.state}`, state));
        if (j.state === "done" || j.state === "failed") {
          const x = el("button", "icon", "✕");
          x.title = "Dismiss";
          x.onclick = async () => {
            await api(`api/jobs/${j.id}`, { method: "DELETE" }).catch(() => {});
            refresh();
          };
          right.append(x);
        }
        row.append(right);
        if (j.state === "running" || j.state === "queued") {
          const p = el("progress");
          if (j.state === "running" && j.estimate) {
            p.max = j.estimate;
            p.value = Math.min(j.bytes, j.estimate);
          }
          row.append(p);
        }
        if (j.error) row.append(el("div", "error small", j.error));
        return row;
      }),
  );
}

// --- Upload ----------------------------------------------------------------

function renderUploadLayers() {
  const sel = $("up-layer");
  const names = data.layers.map((l) => l.name).join();
  if (sel.dataset.names === names) return;
  sel.dataset.names = names;
  const value = sel.value;
  sel.replaceChildren(
    ...data.layers.map((l) => {
      const o = el("option", "", l.title);
      o.value = l.name;
      return o;
    }),
  );
  if (value) sel.value = value;
}

function uploadReady() {
  $("upload").disabled = !($("up-file").files.length && NAME.test($("up-name").value.trim()));
}
$("up-file").onchange = () => {
  const f = $("up-file").files[0];
  if (f && !$("up-name").value) {
    $("up-name").value = f.name.replace(/\.pmtiles$/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  }
  uploadReady();
};
$("up-name").oninput = uploadReady;

$("upload").onclick = () => {
  const f = $("up-file").files[0];
  const layer = $("up-layer").value;
  const name = $("up-name").value.trim();
  $("up-error").textContent = "";
  $("upload").disabled = true;
  const bar = $("up-progress");
  bar.hidden = false;
  bar.value = 0;
  // XHR, not fetch, for upload progress.
  const xhr = new XMLHttpRequest();
  xhr.open("PUT", `api/upload/${layer}/${name}`);
  xhr.setRequestHeader("X-Filename", f.name);
  xhr.upload.onprogress = (e) => e.lengthComputable && (bar.value = e.loaded / e.total);
  xhr.onloadend = () => {
    bar.hidden = true;
    if (xhr.status !== 200) {
      let msg = `${xhr.status} ${xhr.statusText}`;
      try {
        msg = JSON.parse(xhr.responseText).error || msg;
      } catch {}
      $("up-error").textContent = xhr.status ? msg : "Upload failed.";
    } else {
      $("up-file").value = "";
      $("up-name").value = "";
    }
    uploadReady();
    refresh();
  };
  xhr.send(f);
};

// --- Polling ---------------------------------------------------------------

let pollTimer = null;
async function refresh() {
  clearTimeout(pollTimer);
  try {
    data = await api("api/layers");
    $("status").textContent = "";
    if (map.isStyleLoaded()) render();
    else map.once("load", render);
  } catch (e) {
    $("status").textContent = "Can't reach the server.";
  }
  const busy = data.jobs.some((j) => j.state === "queued" || j.state === "running");
  pollTimer = setTimeout(refresh, busy ? POLL_BUSY_MS : POLL_IDLE_MS);
}
refresh();
