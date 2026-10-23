import { layers as protomapsLayers, namedFlavor } from "@protomaps/basemaps";
import { AJAXError, addProtocol } from "maplibre-gl";
import { parse } from "yaml";

// The appliance's offline map layers (offline-map/, NOTES-offline-map.md):
// each is a MapLayer SpiriSynq object whose fields are a MapLibre source, with
// its tiles at a plain zenoh queryable, tile_key, and a role saying what to
// draw from them. Objects with the same tile_key share one source, so their
// tiles cross the websocket once. They're found by discovery and listed in
// the Layers applet by key.
//
// By role: "map" (Protomaps' fills and lines) and "imagery" go under the
// online imagery, so they show where it doesn't load; "buildings" are
// extruded, off at first like the online ones; "labels" go on top, with fonts
// and sprites from offline-map too; "terrain" is the map's terrain height,
// in place of Mapterhorn's online tiles, and a hillshade, off at first.

const DISCOVER_MS = 10000;
const TILE_TIMEOUT_MS = 10000;
const FLAVOR = "light";
const DEFAULT_HEIGHT = 6; // m, for buildings without one
const MAX_HEIGHT = 600; // m; the CN Tower is 553

// zenoh://<key>: a tile, font or sprite, by zenoh query. No reply is a
// missing tile, which MapLibre takes as a 404: it draws the parent tile
// instead, without an error. Tiles stored gzipped (Protomaps') cross the
// websocket that way and are unpacked here.
export function addZenohProtocol(zenoh) {
  addProtocol("zenoh", async ({ url, type }) => {
    const [reply] = await zenoh.query(url.slice("zenoh://".length), { timeoutMs: TILE_TIMEOUT_MS });
    if (!reply) throw new AJAXError(404, "Not Found", url, new Blob());
    if (reply instanceof Error) throw reply;
    let stream = new Blob([reply.payload().toBytes()]).stream();
    if (reply.encoding().toString().endsWith(";gzip")) stream = stream.pipeThrough(new DecompressionStream("gzip"));
    const res = new Response(stream);
    // A sprite's index is asked for as JSON.
    return { data: type === "json" ? await res.json() : await res.arrayBuffer() };
  });
}

function sourceSpec(o) {
  const spec = {
    type: o.kind,
    tiles: [`zenoh://${o.tile_key}`],
    minzoom: o.minzoom,
    maxzoom: o.maxzoom,
    bounds: o.bounds,
    attribution: o.attribution,
  };
  if (o.kind !== "vector") spec.tileSize = o.tile_size;
  if (o.kind === "raster-dem") spec.encoding = o.encoding ?? "mapbox";
  return spec;
}

// An object's role, for objects from before roles: from its kind.
const roleOf = (o) => o.role ?? { vector: "map", "raster-dem": "terrain" }[o.kind] ?? "imagery";

// The style layers an object draws from source, the layer they go under
// (undefined: on top), and whether they're shown at first.
function styleFor(source, o, prefix) {
  const id = (l) => ({ ...l, id: `${prefix}:${l.id}` });
  switch (roleOf(o)) {
    case "terrain":
      return [[{ id: `${prefix}:hillshade`, type: "hillshade", source, paint: { "hillshade-shadow-color": "#473B24" } }], "hillshade", false];
    case "imagery":
      return [[{ id: `${prefix}:raster`, type: "raster", source }], "satellite", true];
    case "labels":
      return [protomapsLayers(source, namedFlavor(FLAVOR), { lang: "en" }).filter((l) => l.type === "symbol").map(id), undefined, true];
    case "buildings":
      return [
        [
          {
            id: `${prefix}:buildings`,
            type: "fill-extrusion",
            source,
            "source-layer": "buildings",
            minzoom: 14,
            paint: {
              "fill-extrusion-color": "#c8c4bc",
              // Most buildings in OSM have no height, and some have nonsense:
              // Dalhousie's Goldberg building is 3,704 m, from levels
              // "0,1,2,3,4" read as 1234. Over MAX_HEIGHT is unknown.
              "fill-extrusion-height": [
                "let",
                "h",
                ["coalesce", ["get", "height"], DEFAULT_HEIGHT],
                ["case", [">", ["var", "h"], MAX_HEIGHT], DEFAULT_HEIGHT, ["var", "h"]],
              ],
              "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
              "fill-extrusion-opacity": 0.9,
            },
          },
        ],
        "planes-fill",
        false,
      ];
    default:
      // Fills and lines, without Protomaps' background, so the map's own
      // shows outside the tiles.
      return [
        protomapsLayers(source, namedFlavor(FLAVOR))
          .filter((l) => l.type !== "background" && l.type !== "symbol")
          .map(id),
        "satellite",
        true,
      ];
  }
}

// Finds MapLayers every DISCOVER_MS and adds each to the map and to layers,
// in section "Offline". A source that changes (a region added) is rebuilt
// with every object drawn from it, keeping whether each is shown. One that
// stops answering is left be: its tiles stop coming, and what's drawn stays.
export function startOfflineLayers(map, zenoh, layers) {
  const sources = new Map(); // source id -> { json, spec }
  const objects = new Map(); // topic -> { source, o, ids, show }

  function addStyle(topic, entry) {
    const [style, before] = styleFor(entry.source, entry.o, topic);
    for (const l of style) map.addLayer({ ...l, layout: { ...l.layout, visibility: entry.show ? "visible" : "none" } }, before);
    entry.ids = style.map((l) => l.id);
  }

  function removeStyle(entry) {
    for (const id of entry.ids) map.removeLayer(id);
    entry.ids = [];
  }

  // Terrain height from the offline DEM: the "terrain" source (main.js's,
  // which the terrain control turns on and off) takes its tiles.
  function useTerrain(spec) {
    const terrain = map.getTerrain();
    if (terrain) map.setTerrain(null);
    map.removeSource("terrain");
    map.addSource("terrain", spec);
    if (terrain) map.setTerrain(terrain);
  }

  function install(topic, o) {
    const spec = sourceSpec(o);
    // The regions too: one added inside the source's bounds (a layer with a
    // world base) leaves the spec as it was, but MapLibre still has the tiles
    // it got before, overzoomed from the base. A new source fetches them anew.
    const json = JSON.stringify([spec, o.regions]);
    const source = `offline:${o.tile_key}`;
    const old = objects.get(topic);
    const src = sources.get(source);
    if (src?.json === json && old && JSON.stringify(old.o) === JSON.stringify(o)) return;

    if (src?.json !== json) {
      // New tiles: everything drawn from the source goes, and comes back.
      const users = [...objects.entries()].filter(([, e]) => e.source === source);
      users.forEach(([, e]) => removeStyle(e));
      if (src) map.removeSource(source);
      map.addSource(source, spec);
      sources.set(source, { json, spec });
      users.forEach(([t, e]) => t !== topic && addStyle(t, e));
    }
    if (old?.ids.length) removeStyle(old);

    const role = roleOf(o);
    const entry = { source, o, ids: [], show: old ? old.show : styleFor(source, o, topic)[2] };
    objects.set(topic, entry);
    if (role === "labels" && o.glyphs) {
      map.setGlyphs(`zenoh://${o.glyphs}`);
      map.setSprite(`zenoh://${o.sprites}/${FLAVOR}`);
    }
    addStyle(topic, entry);
    if (role === "terrain") useTerrain(spec);

    const regions = (o.regions ?? []).map((r) => r.name).join(", ");
    const what = role === "terrain" ? "terrain height, and a hillshade" : role;
    layers.add(
      topic,
      topic,
      {
        get show() {
          return entry.show;
        },
        set show(on) {
          entry.show = on;
          for (const id of entry.ids) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
        },
      },
      { section: "Offline", info: `${o.title || topic} (${what}): ${regions}` },
    );
  }

  async function discover() {
    // All objects, then the MapLayers among them, as zenoh-index and the
    // cameras applet do: through the router, `**/sr_metadata/MapLayer` gets
    // no replies from a peer that `**/sr_metadata` reaches (zenoh 1.8).
    const replies = await zenoh.query("**/sr_metadata");
    const topics = replies.flatMap((r) => {
      if (r instanceof Error) return [];
      const m = parse(r.payload().toString());
      return m?.classes?.includes("!MapLayer") ? [m.topic] : [];
    });
    const found = [];
    await Promise.all(
      topics.map(async (topic) => {
        try {
          const [reply] = await zenoh.query(`${topic}/sr_rehydrate`);
          if (!reply || reply instanceof Error) return;
          // Tags (!MapLayer, !Region) aren't known here; they load as mappings.
          const o = parse(reply.payload().toString(), { logLevel: "error" });
          if (o?.tile_key && o.regions?.length) found.push([topic, o]);
        } catch (e) {
          console.warn(`offline map: ${topic}`, e);
        }
      }),
    );
    // In a fixed order, so layers stack the same way every time.
    found.sort(([a], [b]) => a.localeCompare(b)).forEach(([topic, o]) => install(topic, o));
  }

  (async () => {
    for (;;) {
      try {
        await discover();
      } catch (e) {
        console.warn("offline map: discovery failed", e);
      }
      await new Promise((r) => setTimeout(r, DISCOVER_MS));
    }
  })();
}
