"""Serve Gazebo model and world files over HTTP for the map viewer.

Gazebo's websocket server sends assets at ~245 KB/s (one lws chunk per
16 ms service tick), so a 20 MB mesh takes over a minute. This resolves
the same URIs the same way and serves them at disk speed:

    GET /model/<name>/<path>   model://<name>/<path>, searched in GZ_SIM_RESOURCE_PATH
    GET /file/<absolute path>  only if it lies inside GZ_SIM_RESOURCE_PATH
    GET /world.sdf             the world Gazebo loaded (GZ_WORLD), for whatever
                               needs its <spherical_coordinates>, such as SITL's home
    GET /gltf/<either above>.glb
                               a mesh (.dae, .stl, .obj) converted to glTF for
                               the map. Any other path under /gltf/ is the plain
                               file, so the textures a glTF names relative to
                               itself resolve.

Like the websocket server, nothing outside the resource paths is readable.

Meshes are converted with assimp on first request and cached by the source's
path, size and mtime. The result is ordinary Y-up glTF in metres, with the
mesh's frame as Gazebo sees it: assimp applies a COLLADA file's <up_axis> and
<unit> as Gazebo does, and STL and OBJ, which Gazebo reads as Z-up, get a root
node that turns them Y-up.
"""
import hashlib
import json
import os
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOTS = [os.path.realpath(p) for p in os.environ.get("GZ_SIM_RESOURCE_PATH", "").split(":") if p]
WORLD = os.environ.get("GZ_WORLD", "citadel-hill")
CACHE = os.environ.get("GLTF_CACHE", os.path.join(tempfile.gettempdir(), "gz-gltf"))
MESHES = (".dae", ".stl", ".obj")
# Column-major, as glTF stores it: Gazebo's Z-up to glTF's Y-up.
Z_UP_TO_Y_UP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]


def inside_roots(path):
    real = os.path.realpath(path)
    return real if any(real == r or real.startswith(r + os.sep) for r in ROOTS) else None


def resolve(url_path):
    """The file a request names, or None."""
    path = unquote(urlsplit(url_path).path)
    if path.startswith("/gltf/"):
        path = path[len("/gltf"):]
        if path.endswith(".glb") and path[: -len(".glb")].lower().endswith(MESHES):
            source = resolve(path[: -len(".glb")])
            return source and to_gltf(source)
        return resolve(path)
    if path == "/world.sdf":
        path = f"/model/{WORLD}.sdf"
    if path.startswith("/model/"):
        rel = path[len("/model/"):]
        for root in ROOTS:
            found = inside_roots(os.path.join(root, rel))
            if found and os.path.isfile(found):
                return found
    elif path.startswith("/file/"):
        found = inside_roots(path[len("/file"):])
        if found and os.path.isfile(found):
            return found
    return None


_locks = {}
_locks_lock = threading.Lock()


def to_gltf(source):
    """The cached GLB for a mesh file, converting it first if need be."""
    st = os.stat(source)
    key = hashlib.sha256(f"{source}\0{st.st_size}\0{st.st_mtime_ns}".encode()).hexdigest()[:32]
    out = os.path.join(CACHE, key + ".glb")
    with _locks_lock:
        lock = _locks.setdefault(key, threading.Lock())
    # One conversion per mesh; requests for it meanwhile wait for that one.
    with lock:
        if os.path.isfile(out):
            return out
        os.makedirs(CACHE, exist_ok=True)
        tmp = out + ".tmp.glb"
        run = subprocess.run(["assimp", "export", source, tmp, "-f", "glb2"], capture_output=True, text=True)
        if run.returncode != 0 or not os.path.isfile(tmp):
            print(f"assimp failed on {source}: {run.stdout[-500:]}{run.stderr[-500:]}", flush=True)
            return None
        if not source.lower().endswith(".dae"):
            wrap_root(tmp, Z_UP_TO_Y_UP)
        os.replace(tmp, out)
        return out


def wrap_root(glb, matrix):
    """Put a GLB's scene under one new root node with this transform."""
    with open(glb, "rb") as f:
        data = f.read()
    magic, version, _ = struct.unpack_from("<4sII", data, 0)
    length, kind = struct.unpack_from("<I4s", data, 12)
    assert magic == b"glTF" and version == 2 and kind == b"JSON"
    doc = json.loads(data[20 : 20 + length])
    rest = data[20 + length :]
    nodes = doc.setdefault("nodes", [])
    for scene in doc.get("scenes", []):
        nodes.append({"name": "z_up", "matrix": matrix, "children": scene.get("nodes", [])})
        scene["nodes"] = [len(nodes) - 1]
    text = json.dumps(doc, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    chunk = struct.pack("<I4s", len(text), b"JSON") + text
    with open(glb, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, 12 + len(chunk) + len(rest)) + chunk + rest)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        found = resolve(self.path)
        if not found:
            self.send_error(404)
            return
        st = os.stat(found)
        etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
        # Browsers keep the file but check it each load, so a model that changes
        # on disk shows up at once and an unchanged one costs only a 304.
        if etag in self.headers.get("If-None-Match", ""):
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "model/gltf-binary" if found.endswith(".glb") else "application/octet-stream")
        self.send_header("Content-Length", str(st.st_size))
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", self.date_time_string(int(st.st_mtime)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with open(found, "rb") as f:
            shutil.copyfileobj(f, self.wfile)

    def finish(self):
        # Close gracefully. A request can carry a body we never read (SpiriConfig's
        # proxy streams one even on GET), and closing a socket with unread input
        # sends a TCP reset, which can destroy the response still in flight.
        super().finish()
        try:
            self.connection.shutdown(socket.SHUT_WR)
            self.connection.settimeout(5)
            while self.connection.recv(65536):
                pass
        except OSError:
            pass

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("ASSET_PORT", "9003"))
    ThreadingHTTPServer(("", port), Handler).serve_forever()
