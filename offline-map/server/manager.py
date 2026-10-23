"""offline-map's manager: the SpiriConfig plugin for the downloaded regions.

A page (web/) listing each layer's regions with their coverage on a map drawn
from the same files, and an HTTP API it uses. Regions are cut from the
layers' planets one at a time in a background thread, or uploaded as
.pmtiles cut elsewhere (the way in on an airgapped appliance). The tile
server notices new and removed files by itself.

    GET    api/layers                     layers, their regions, and jobs
    POST   api/estimate                   {bbox, layers: {layer: maxzoom}} -> {layer: bytes | {error}}
    POST   api/regions                    {name, bbox, layers: {layer: maxzoom}}: queue cuts
    DELETE api/regions/<layer>/<name>
    PUT    api/upload/<layer>/<name>      body: a .pmtiles file
    DELETE api/jobs/<id>                  forget a finished job
    GET    tiles/<layer>/<z>/<x>/<y>      a tile, for the page's map
"""

import itertools
import json
import os
import queue
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

import tiles
from tiles import DATA, LAYERS, NAME

PORT = int(os.environ.get("OFFLINE_MAP_PORT", "8080"))
WEB = Path(__file__).parent / "web"
TYPES = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
         ".json": "application/json", ".png": "image/png", ".pbf": "application/x-protobuf"}
RESCAN = 2  # seconds between checks of the files, at most
CHUNK = 1 << 20


class Layers:
    """Every layer's Stack, rescanned at most every RESCAN seconds."""

    def __init__(self):
        self.lock = threading.Lock()
        self.stacks: dict[str, tiles.Stack] = {}
        self.checked = 0.0

    def get(self) -> dict[str, tiles.Stack]:
        with self.lock:
            if time.monotonic() - self.checked > RESCAN:
                self.checked = time.monotonic()
                names = tiles.layer_names()
                self.stacks = {n: self.stacks.get(n) or tiles.Stack(n) for n in sorted(names)}
                for s in self.stacks.values():
                    s.rescan()
            return self.stacks

    def touch(self):
        with self.lock:
            self.checked = 0.0


layers = Layers()


class Jobs:
    """Region cuts, run one at a time so one appliance is gentle on the planets."""

    def __init__(self):
        self.lock = threading.Lock()
        self.jobs: dict[int, dict] = {}
        self.ids = itertools.count(1)
        self.queue: queue.Queue = queue.Queue()
        threading.Thread(target=self.run, daemon=True).start()

    def add(self, layer, name, bbox, maxzoom):
        with self.lock:
            job = dict(id=next(self.ids), layer=layer, name=name, bbox=bbox, maxzoom=maxzoom,
                       state="queued", estimate=None, bytes=0, error=None)
            self.jobs[job["id"]] = job
        self.queue.put(job)
        return job

    def list(self):
        with self.lock:
            out = []
            for j in self.jobs.values():
                j = dict(j)
                if j["state"] == "running":
                    try:
                        j["bytes"] = tiles.part_path(j["layer"], j["name"]).stat().st_size
                    except FileNotFoundError:
                        pass
                out.append(j)
            return out

    def forget(self, id):
        with self.lock:
            if self.jobs.get(id, {}).get("state") in ("done", "failed"):
                del self.jobs[id]
                return True
            return False

    def run(self):
        while True:
            job = self.queue.get()
            try:
                job["state"] = "running"
                url = tiles.planet_url(job["layer"])
                job["estimate"] = tiles.estimate(job["layer"], job["bbox"], job["maxzoom"], url)
                out = tiles.extract(job["layer"], job["name"], job["bbox"], job["maxzoom"], url)
                job["bytes"] = out.stat().st_size
                job["state"] = "done"
            except Exception as e:
                job["state"], job["error"] = "failed", str(e) or type(e).__name__
            layers.touch()


jobs = Jobs()
estimates = ThreadPoolExecutor(max_workers=4)


def describe():
    out = []
    for name, stack in layers.get().items():
        known = LAYERS.get(name, {})
        src = stack.source()
        out.append(dict(
            name=name, **src,
            can_cut=bool(known.get("planet")),
            default_maxzoom=known.get("maxzoom", src["maxzoom"]),
            planet_maxzoom=known.get("planet_maxzoom", src["maxzoom"]),
            regions=[t.describe() for t in stack.tilesets],
        ))
    return dict(layers=out, jobs=jobs.list())


def check_bbox(bbox):
    w, s, e, n = (float(v) for v in bbox)
    if not (-180 <= w < e <= 180 and -85.06 <= s < n <= 85.06):
        raise ValueError("bbox must be W,S,E,N with W < E and S < N")
    return [w, s, e, n]


def check_layers(requested: dict):
    if not requested:
        raise ValueError("pick at least one layer")
    out = {}
    for layer, maxzoom in requested.items():
        known = LAYERS.get(layer)
        if not known or not known.get("planet"):
            raise ValueError(f"can't cut {layer}")
        maxzoom = int(maxzoom)
        if not 0 <= maxzoom <= known["planet_maxzoom"]:
            raise ValueError(f"{layer} goes to z{known['planet_maxzoom']}")
        out[layer] = maxzoom
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send(self, status, body=b"", type="application/json", headers=()):
        if not isinstance(body, (bytes, bytearray)):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def error(self, status, message):
        self.send(status, {"error": message})

    def chunks(self):
        """The request body, a piece at a time. SpiriConfig's proxy re-streams
        bodies chunked, without a Content-Length."""
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            while size := int(self.rfile.readline().split(b";")[0].strip() or b"0", 16):
                left = size
                while left:
                    piece = self.rfile.read(min(CHUNK, left))
                    if not piece:
                        raise ValueError("body cut short")
                    left -= len(piece)
                    yield piece
                self.rfile.readline()  # the chunk's CRLF
            while self.rfile.readline().strip():  # trailers
                pass
            return
        left = int(self.headers.get("Content-Length") or 0)
        while left:
            piece = self.rfile.read(min(CHUNK, left))
            if not piece:
                raise ValueError("body cut short")
            left -= len(piece)
            yield piece

    def body(self):
        return json.loads(b"".join(self.chunks()) or b"{}")

    def parts(self):
        return [unquote(p) for p in self.path.split("?")[0].split("/") if p]

    def do_GET(self):
        p = self.parts()
        if p == ["api", "layers"]:
            return self.send(HTTPStatus.OK, describe())
        if len(p) == 5 and p[0] == "tiles":
            return self.tile(p[1], p[2:])
        return self.static(p)

    do_HEAD = do_GET

    def static(self, p):
        rel = Path(*p) if p else Path("index.html")
        path = (WEB / rel).resolve()
        if not path.is_relative_to(WEB.resolve()) or not path.is_file():
            return self.error(HTTPStatus.NOT_FOUND, "not found")
        cache = [("Cache-Control", "max-age=86400")] if p and p[0] in ("vendor", "assets") else [("Cache-Control", "no-cache")]
        self.send(HTTPStatus.OK, path.read_bytes(), TYPES.get(path.suffix, "application/octet-stream"), cache)

    def tile(self, layer, zxy):
        stack = layers.get().get(layer)
        try:
            z, x, y = (int(v) for v in zxy)
        except ValueError:
            return self.error(HTTPStatus.BAD_REQUEST, "bad tile")
        hit = stack and stack.get(z, x, y)
        if not hit:
            return self.send(HTTPStatus.NO_CONTENT, b"", "application/octet-stream")
        data, t = hit
        media = tiles.FORMATS.get(t.header["tile_type"], ("", "application/octet-stream"))[1]
        headers = [("Cache-Control", "no-cache")]
        if t.gzipped:
            headers.append(("Content-Encoding", "gzip"))
        self.send(HTTPStatus.OK, data, media, headers)

    def do_POST(self):
        p = self.parts()
        try:
            req = self.body()
            if p == ["api", "estimate"]:
                bbox = check_bbox(req.get("bbox", []))
                wanted = check_layers(req.get("layers", {}))
                futures = {l: estimates.submit(tiles.estimate, l, bbox, z) for l, z in wanted.items()}
                out = {}
                for l, f in futures.items():
                    try:
                        out[l] = f.result()
                    except Exception as e:
                        out[l] = {"error": str(e) or type(e).__name__}
                return self.send(HTTPStatus.OK, out)
            if p == ["api", "regions"]:
                name = req.get("name", "")
                if not NAME.match(name):
                    raise ValueError("name: lowercase letters, digits and dashes")
                bbox = check_bbox(req.get("bbox", []))
                wanted = check_layers(req.get("layers", {}))
                return self.send(HTTPStatus.ACCEPTED, [jobs.add(l, name, bbox, z) for l, z in wanted.items()])
        except (ValueError, TypeError, json.JSONDecodeError) as e:
            return self.error(HTTPStatus.BAD_REQUEST, str(e))
        self.error(HTTPStatus.NOT_FOUND, "not found")

    def do_DELETE(self):
        p = self.parts()
        if len(p) == 4 and p[:2] == ["api", "regions"]:
            try:
                tiles.remove(p[2], p[3])
            except ValueError as e:
                return self.error(HTTPStatus.BAD_REQUEST, str(e))
            layers.touch()
            return self.send(HTTPStatus.OK, {})
        if len(p) == 3 and p[:2] == ["api", "jobs"] and p[2].isdigit():
            return self.send(HTTPStatus.OK if jobs.forget(int(p[2])) else HTTPStatus.CONFLICT, {})
        self.error(HTTPStatus.NOT_FOUND, "not found")

    def do_PUT(self):
        p = self.parts()
        if not (len(p) == 4 and p[:2] == ["api", "upload"]):
            return self.error(HTTPStatus.NOT_FOUND, "not found")
        layer, name = p[2], p[3]
        if not NAME.match(layer) or not NAME.match(name):
            return self.error(HTTPStatus.BAD_REQUEST, "names: lowercase letters, digits and dashes")
        part = tiles.part_path(layer, name)
        part.parent.mkdir(parents=True, exist_ok=True)
        try:
            with part.open("wb") as f:
                for piece in self.chunks():
                    f.write(piece)
            t = tiles.Tileset(part)
            want = LAYERS.get(layer, {}).get("kind")
            got = "vector" if t.header["tile_type"] == tiles.TileType.MVT else "raster"
            if want and (want == "vector") != (got == "vector"):
                raise ValueError(f"{layer} needs {want} tiles, this file has {got} tiles")
            del t
        except Exception as e:
            part.unlink(missing_ok=True)
            return self.error(HTTPStatus.BAD_REQUEST, f"not a usable .pmtiles: {str(e) or type(e).__name__}")
        out = DATA / layer / f"{name}.pmtiles"
        filename = self.headers.get("X-Filename", "")
        out.with_suffix(".json").write_text(json.dumps({"source": f"upload: {filename}" if filename else "upload"}))
        shutil.move(part, out)
        layers.touch()
        self.send(HTTPStatus.OK, {})


def main():
    server = ThreadingHTTPServer(("", PORT), Handler)
    server.daemon_threads = True
    print(f"offline-map manager on :{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
