"""offline-map: map tiles over zenoh, from PMTiles files.

Each layer's files (see tiles.py) are published as one or more MapLayer
SpiriSynq objects at <base topic>/offline-map/<name>, whose fields are a
MapLibre source spec and a role saying what to draw from it (tiles.ROLES:
osm is osm, osm-labels and osm-buildings). Its tiles are a plain zenoh
queryable beside the layer, shared by all its objects:

    <layer path>/tiles/{z}/{x}/{y}   the tile's bytes as stored, encoded as its
                                     media type (`;gzip` if stored gzipped).
                                     The first region that has it answers:
                                     newest first, the base last. No reply if
                                     none has it.

and fonts and sprites for labels, as files:

    <base topic>/offline-map/assets/fonts/{fontstack}/{range}.pbf
    <base topic>/offline-map/assets/sprites/v4/<flavor>[@2x].{json,png}

SpiriSynq RPC replies are YAML, so tiles would cost base64 that way; the
queryables are outside SpiriSynq, and MapLayer.tile_key, glyphs and sprites
name them.

Files are rescanned every RESCAN seconds, so a region added by manager.py, or
dropped into the data directory, shows up by itself.

    server.py serve
    server.py add <layer> <region> --bbox W,S,E,N [--maxzoom Z]
        Cut a region out of the layer's planet (needs the internet).
"""

import argparse
import time
from urllib.parse import unquote

import tiles
from tiles import ASSETS, LAYERS, ROLES

RESCAN = 5  # seconds
ASSET_TYPES = {".pbf": "application/x-protobuf", ".png": "image/png", ".json": "application/json"}


def serve():
    # SpiriSynq opens its default zenoh session on import, so only here.
    import zenoh
    from loguru import logger
    from map_layer import MapLayer, Region
    from SpiriSynq.session import current_session

    zsession = current_session.get().zenoh_session
    base_topic = current_session.get().base_topic
    assets_key = f"{base_topic}/offline-map/assets"

    class Layer:
        """A layer's files, its MapLayers and its tile queryable."""

        def __init__(self, name: str):
            self.name = name
            self.stack = tiles.Stack(name)
            self.media = "application/octet-stream"
            self.prefix = f"{base_topic}/offline-map/{name}/tiles/"
            self.queryable = zsession.declare_queryable(f"{self.prefix}*/*/*", self.reply)
            self.objs: list[MapLayer] = []
            for obj_name, role in ROLES.get(name, [(name, None)]):
                o = MapLayer(f"offline-map/{obj_name}", synq_authoritive=True)
                o.tile_key = f"{self.prefix}{{z}}/{{x}}/{{y}}"
                if role:
                    o.role = role
                if role == "labels":
                    o.glyphs = f"{assets_key}/fonts/{{fontstack}}/{{range}}.pbf"
                    o.sprites = f"{assets_key}/sprites/v4"
                self.objs.append(o)
                logger.info(f"layer {name}: {o.synq_absolute_path} ({role or 'from its tiles'})")

        def rescan(self):
            if not self.stack.rescan(logger.warning):
                return
            s = self.stack.source()
            self.media = s.pop("media")
            regions = [
                Region(name=t.name, bounds=t.bounds, minzoom=t.header["min_zoom"],
                       maxzoom=t.header["max_zoom"], source=t.source)
                for t in self.stack.tilesets
            ]
            for o in self.objs:
                title = s["title"] if o.role in ("map", "terrain", "imagery") else f"{s['title']} {o.role}"
                for k, v in {**s, "title": title}.items():
                    if getattr(o, k) != v:
                        setattr(o, k, v)
                if self.name not in ROLES:
                    role = {"vector": "map", "raster-dem": "terrain"}.get(s["kind"], "imagery")
                    if o.role != role:
                        o.role = role
                o.regions = regions
            logger.info(f"layer {self.name}: {', '.join(r.name for r in regions) or 'no regions'}")

        def reply(self, query: zenoh.Query):
            try:
                z, x, y = (int(v) for v in str(query.key_expr).removeprefix(self.prefix).split("/"))
            except ValueError:
                return
            if (hit := self.stack.get(z, x, y)) is not None:
                query.reply(query.key_expr, hit[0], encoding=zenoh.Encoding(self.media))

        def close(self):
            self.queryable.undeclare()
            for o in self.objs:
                o.close()

    # Fonts and sprites, as files. Keys may arrive percent-encoded (a font
    # stack's spaces, from a URL).
    root = ASSETS.resolve()

    def asset(query: zenoh.Query):
        rel = unquote(str(query.key_expr).removeprefix(f"{assets_key}/"))
        path = (root / rel).resolve()
        if path.is_relative_to(root) and path.is_file():
            media = ASSET_TYPES.get(path.suffix, "application/octet-stream")
            query.reply(query.key_expr, path.read_bytes(), encoding=zenoh.Encoding(media))

    assets = zsession.declare_queryable(f"{assets_key}/**", asset)  # noqa: F841 (kept declared)

    layers: dict[str, Layer] = {}
    while True:
        names = tiles.layer_names()
        for name in names - layers.keys():
            layers[name] = Layer(name)
        for name in layers.keys() - names:
            layers.pop(name).close()
        for layer in layers.values():
            layer.rescan()
        time.sleep(RESCAN)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve")
    a = sub.add_parser("add")
    a.add_argument("layer", choices=sorted(LAYERS))
    a.add_argument("region")
    a.add_argument("--bbox", required=True, help="W,S,E,N in degrees")
    a.add_argument("--maxzoom", type=int)
    args = ap.parse_args()
    if args.cmd == "serve":
        serve()
    else:
        bbox = [float(v) for v in args.bbox.split(",")]
        print(tiles.extract(args.layer, args.region, bbox, args.maxzoom))


if __name__ == "__main__":
    main()
