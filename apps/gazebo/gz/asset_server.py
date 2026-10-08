"""Serve Gazebo model files over HTTP for the gzweb viewer.

Gazebo's websocket server sends assets at ~245 KB/s (one lws chunk per
16 ms service tick), so a 20 MB mesh takes over a minute. This resolves
the same URIs the same way and serves them at disk speed:

    GET /model/<name>/<path>   model://<name>/<path>, searched in GZ_SIM_RESOURCE_PATH
    GET /file/<absolute path>  only if it lies inside GZ_SIM_RESOURCE_PATH

Like the websocket server, nothing outside the resource paths is readable.
"""
import os
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOTS = [os.path.realpath(p) for p in os.environ.get("GZ_SIM_RESOURCE_PATH", "").split(":") if p]


def inside_roots(path):
    real = os.path.realpath(path)
    return real if any(real == r or real.startswith(r + os.sep) for r in ROOTS) else None


def resolve(url_path):
    path = unquote(urlsplit(url_path).path)
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


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        found = resolve(self.path)
        if not found:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(os.path.getsize(found)))
        self.send_header("Cache-Control", "max-age=3600")
        self.end_headers()
        with open(found, "rb") as f:
            shutil.copyfileobj(f, self.wfile)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("ASSET_PORT", "9003"))
    ThreadingHTTPServer(("", port), Handler).serve_forever()
