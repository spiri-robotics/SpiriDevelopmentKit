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
import socket
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
        self.send_header("Content-Type", "application/octet-stream")
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
