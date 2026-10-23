"""cloud-link: links this robot to a Spiri Cloud organization, and keeps the
organization's configuration for the robot in an env file other apps read.

The cloud side is the Drones app; its contract is cloud_deploy's
docs/drones-api.md. Linking is an RFC 8628 device grant: the robot asks for a
code, shows it with a link (and a QR code) on this page, and polls until
someone in the organization approves it, from any browser. The credential it
gets back never expires; it only stops working when the robot is unlinked,
from either side.

Once linked, the env file is fetched at start and every INTERVAL seconds,
with the last ETag, and written to ENV_FILE. Apps that want it read it with
compose's

    env_file:
      - path: /var/lib/spiri-cloud/cloud.env
        required: false

and treat a missing key as "not set up". A 401 means the robot was unlinked
from the cloud: the credential and the env file are deleted. Anything else
that fails is temporary, and the last good file stays.

    GET  api/state      what the page shows
    POST api/link       {url, name}: start linking
    POST api/cancel     stop linking
    POST api/unlink     {force}: unlink, or with force forget the link locally
    POST api/refresh    fetch the env file now
    GET  api/qr.svg     the approval link as a QR code
"""

import io
import json
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import segno

PORT = int(os.environ.get("CLOUD_LINK_PORT", "8080"))
DATA = Path(os.environ.get("CLOUD_LINK_DATA", "/data"))
ENV_FILE = Path(os.environ.get("CLOUD_LINK_ENV_FILE", "/out/cloud.env"))
INTERVAL = max(10, int(os.environ.get("CLOUD_LINK_INTERVAL") or "60"))
# The app's settings in SpiriConfig. Set, they replace what the page asks for.
FIXED_URL = os.environ.get("CLOUD_LINK_URL", "").strip()
FIXED_NAME = " ".join(os.environ.get("CLOUD_LINK_NAME", "").split())[:64]
HOSTNAME = Path(os.environ.get("CLOUD_LINK_HOSTNAME_FILE", "/etc/host-hostname"))
WEB = Path(__file__).parent / "web"
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}
LINK = DATA / "link.json"  # {url, token, drone_id, etag}: the credential
PREFS = DATA / "prefs.json"  # {url, name}: what was last typed, to link again
USER_AGENT = "spiri-cloud-link/0.1"
TIMEOUT = 20
DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

# The env file format (docs/drones-api.md, "Format"): blank lines, comments,
# and KEY='value' with nothing to unescape. Anything else is refused rather
# than written where compose would read it.
ENV_LINE = re.compile(r"([A-Z][A-Z0-9_]*)='([^'\r\0]*)'")
SECRET = re.compile(r"KEY|TOKEN|SECRET|PASSWORD")


def hostname() -> str:
    try:
        return HOSTNAME.read_text().strip() or socket.gethostname()
    except OSError:
        return socket.gethostname()


def read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def write_private(path: Path, data: bytes):
    """Write a file only root can read, replacing the old one in one step, so
    a reader never sees half of it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def parse_env(text: str) -> dict[str, str]:
    if text and not text.endswith("\n"):
        raise ValueError("env file doesn't end with a newline")
    out = {}
    for n, line in enumerate(text.split("\n")[:-1], 1):
        if not line or line.startswith("#"):
            continue
        m = ENV_LINE.fullmatch(line)
        if not m:
            raise ValueError(f"env file line {n} isn't KEY='value'")
        if m[1] in out:
            raise ValueError(f"env file sets {m[1]} twice")
        out[m[1]] = m[2]
    return out


def normalize_url(url: str) -> str:
    url = url.strip().rstrip("/")
    if "://" not in url:
        url = "https://" + url
    parts = urlsplit(url)
    if parts.scheme not in ("https", "http") or not parts.hostname or re.search(r"\s", url):
        raise ValueError("that isn't a web address")
    return url


def fixed_url() -> str:
    """The Cloud address setting as the page should show it: normalized when it
    can be, as typed when it can't (linking then says why)."""
    try:
        return normalize_url(FIXED_URL) if FIXED_URL else ""
    except ValueError:
        return FIXED_URL


def request(method, url, fields=None, token=None, etag=None):
    """One HTTP request: (status, headers, body). HTTP errors are answers
    here, not exceptions; a network failure raises OSError."""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json, text/plain"}
    data = None
    if fields is not None:
        data = urlencode(fields).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if etag:
        headers["If-None-Match"] = etag
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return res.status, res.headers, res.read()
    except urllib.error.HTTPError as e:
        with e:
            return e.code, e.headers, e.read()


def oauth_error(body: bytes) -> str:
    try:
        return json.loads(body).get("error") or "unknown error"
    except (ValueError, AttributeError):
        return "unreadable reply"


def describe_network_error(e: OSError) -> str:
    reason = getattr(e, "reason", None) or e
    return f"can't reach the cloud: {reason}"


class Link:
    """The robot's link, and whatever it's doing about it. One lock guards
    everything; network calls are made outside it."""

    def __init__(self):
        self.lock = threading.Lock()
        self.link = read_json(LINK)
        self.prefs = read_json(PREFS) or {}
        self.pending = None  # a device code being approved
        self.attempt = 0  # bumped to stop a polling thread
        self.notice = None  # why the last attempt or link ended
        self.fetched = None  # time of the last fetch that got an answer
        self.fetch_error = None
        self.wake = threading.Event()
        threading.Thread(target=self.fetch_loop, daemon=True).start()

    # --- state --------------------------------------------------------------

    def state(self):
        with self.lock:
            out = dict(name=FIXED_NAME or self.prefs.get("name") or hostname(),
                       url=fixed_url() or self.prefs.get("url", ""),
                       url_fixed=bool(FIXED_URL), name_fixed=bool(FIXED_NAME),
                       notice=self.notice, env_file=str(ENV_FILE))
            if self.link:
                env = self.env()
                # Linked before the setting changed: say so, but leave the link.
                if FIXED_URL and fixed_url() != self.link["url"]:
                    out["url_mismatch"] = fixed_url()
                out.update(state="linked", url=self.link["url"], drone_id=self.link.get("drone_id"),
                           name=env.get("SPIRI_CLOUD_DRONE_NAME") or out["name"],
                           fetched=self.fetched, fetch_error=self.fetch_error, interval=INTERVAL,
                           config=[dict(key=k, value=None if SECRET.search(k) else v) for k, v in env.items()])
            elif self.pending:
                p = self.pending
                out.update(state="linking", url=p["url"], user_code=p["user_code"],
                           verification_uri=p["verification_uri"],
                           verification_uri_complete=p.get("verification_uri_complete"),
                           expires_in=max(0, round(p["expires_at"] - time.time())),
                           poll_error=p.get("error"))
            else:
                out.update(state="unlinked")
            return out

    def env(self) -> dict[str, str]:
        try:
            return parse_env(ENV_FILE.read_text())
        except (OSError, ValueError):
            return {}

    def forget(self, notice=None):
        """Drop the credential and the env file. Called with the lock held."""
        self.link = None
        self.fetched = self.fetch_error = None
        self.notice = notice
        LINK.unlink(missing_ok=True)
        ENV_FILE.unlink(missing_ok=True)

    # --- linking ------------------------------------------------------------

    def start(self, url, name):
        if FIXED_URL:
            try:
                url = normalize_url(FIXED_URL)
            except ValueError:
                raise ValueError(f"the Cloud address setting ({FIXED_URL}) isn't a web address") from None
        else:
            url = normalize_url(url)
        name = FIXED_NAME or " ".join((name or "").split())[:64] or hostname()
        with self.lock:
            if self.link:
                raise ValueError("already linked; unlink first")
            self.prefs = dict(url=url, name=name)
        write_private(PREFS, json.dumps(self.prefs).encode())
        try:
            status, _, body = request("POST", f"{url}/oauth/device_authorization",
                                      dict(client_id="spiri-drone", drone_name=name))
        except OSError as e:
            raise ValueError(describe_network_error(e)) from None
        if status != 200:
            raise ValueError(f"{url} didn't give a link code ({status}); is it the Drones app's address?")
        try:
            dev = json.loads(body)
            pending = dict(url=url, device_code=dev["device_code"], user_code=dev["user_code"],
                           verification_uri=dev["verification_uri"],
                           verification_uri_complete=dev.get("verification_uri_complete"),
                           expires_at=time.time() + int(dev.get("expires_in", 600)),
                           interval=int(dev.get("interval", 5)))
        except (ValueError, KeyError, TypeError):
            raise ValueError(f"{url} gave a link code this robot can't read") from None
        with self.lock:
            self.attempt += 1
            self.pending, self.notice = pending, None
            attempt = self.attempt
        threading.Thread(target=self.poll, args=(attempt, pending), daemon=True).start()

    def cancel(self):
        with self.lock:
            self.attempt += 1
            self.pending = None

    def poll(self, attempt, p):
        """Poll for the credential until it comes, or the user or the cloud
        says no, or the code runs out."""
        interval = p["interval"]
        while True:
            time.sleep(interval)
            with self.lock:
                if self.attempt != attempt:
                    return
                if time.time() > p["expires_at"]:
                    self.pending, self.notice = None, "The link code ran out before it was approved."
                    return
            try:
                status, _, body = request("POST", f"{p['url']}/oauth/token",
                                          dict(grant_type=DEVICE_GRANT, device_code=p["device_code"]))
            except OSError as e:
                p["error"] = describe_network_error(e)
                continue
            p.pop("error", None)
            if status == 200:
                try:
                    tok = json.loads(body)
                    link = dict(url=p["url"], token=tok["access_token"], drone_id=tok.get("drone_id"), etag=None)
                except (ValueError, KeyError, TypeError):
                    link = None
                with self.lock:
                    if self.attempt != attempt:
                        return
                    self.pending = None
                    if link is None:
                        self.notice = "The cloud approved the link, but its reply was unreadable. Link again."
                        return
                    self.link = link
                    write_private(LINK, json.dumps(link).encode())
                self.wake.set()
                return
            error = oauth_error(body)
            if error == "authorization_pending":
                continue
            if error == "slow_down":
                interval += 5
                continue
            with self.lock:
                if self.attempt != attempt:
                    return
                self.pending = None
                self.notice = {
                    "access_denied": "The link was denied in the cloud.",
                    "expired_token": "The link code ran out before it was approved.",
                }.get(error, f"Linking failed: {error}.")
            return

    # --- unlinking ----------------------------------------------------------

    def unlink(self, force=False):
        with self.lock:
            link = self.link
        if not link:
            return
        try:
            status, _, _ = request("POST", f"{link['url']}/api/v1/unlink", {}, token=link["token"])
        except OSError as e:
            if not force:
                raise ValueError(describe_network_error(e)) from None
            status = None
        if status not in (204, 401, None) and not force:
            raise ValueError(f"the cloud wouldn't unlink this robot ({status})")
        with self.lock:
            if self.link is link:
                self.forget("Unlinked." if status in (204, 401) else
                            "Forgotten on this robot. It may still be listed in the cloud; unlink it there too.")

    # --- the env file -------------------------------------------------------

    def refresh(self):
        self.wake.set()

    def fetch_loop(self):
        while True:
            with self.lock:
                link = self.link
            if link:
                self.fetch(link)
            self.wake.wait(INTERVAL)
            self.wake.clear()

    def fetch(self, link):
        # Without the file there's nothing an ETag could match, so ask for it whole.
        etag = link.get("etag") if ENV_FILE.exists() else None
        try:
            status, headers, body = request("GET", f"{link['url']}/api/v1/config", token=link["token"], etag=etag)
        except OSError as e:
            return self.fetch_done(link, describe_network_error(e))
        if status == 401:
            with self.lock:
                if self.link is link:
                    self.forget("This robot was unlinked in the cloud.")
            return
        if status == 304:
            return self.fetch_done(link)
        if status != 200:
            return self.fetch_done(link, f"the cloud answered {status}; keeping the last configuration")
        try:
            text = body.decode("utf-8")
            parse_env(text)
        except (UnicodeDecodeError, ValueError) as e:
            return self.fetch_done(link, f"refused the cloud's configuration: {e}")
        with self.lock:
            if self.link is not link:
                return
            write_private(ENV_FILE, body)
            link["etag"] = headers.get("ETag")
            write_private(LINK, json.dumps(link).encode())
        self.fetch_done(link)

    def fetch_done(self, link, error=None):
        with self.lock:
            if self.link is link:
                self.fetched = time.time() if error is None else self.fetched
                self.fetch_error = error


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send(self, status, body=b"", type="application/json"):
        if not isinstance(body, (bytes, bytearray)):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def error(self, status, message):
        self.send(status, {"error": message})

    def body(self):
        """The request's JSON. SpiriConfig's proxy re-streams bodies chunked,
        without a Content-Length."""
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            data = b""
            while size := int(self.rfile.readline().split(b";")[0].strip() or b"0", 16):
                data += self.rfile.read(size)
                self.rfile.readline()
            while self.rfile.readline().strip():
                pass
        else:
            data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        return json.loads(data or b"{}")

    def route(self):
        return self.path.split("?")[0].strip("/")

    def do_GET(self):
        path = self.route()
        if path == "api/state":
            return self.send(HTTPStatus.OK, link.state())
        if path == "api/qr.svg":
            s = link.state()
            uri = s.get("verification_uri_complete") or s.get("verification_uri")
            if not uri:
                return self.error(HTTPStatus.NOT_FOUND, "not linking")
            # Not svg_inline: it leaves out the xmlns an <img> needs.
            svg = io.BytesIO()
            segno.make(uri, error="m").save(svg, kind="svg", scale=5, border=2, dark="#000", light="#fff")
            return self.send(HTTPStatus.OK, svg.getvalue(), "image/svg+xml")
        file = (WEB / (path or "index.html")).resolve()
        if not file.is_relative_to(WEB.resolve()) or not file.is_file():
            return self.error(HTTPStatus.NOT_FOUND, "not found")
        self.send(HTTPStatus.OK, file.read_bytes(), TYPES.get(file.suffix, "application/octet-stream"))

    do_HEAD = do_GET

    def do_POST(self):
        path = self.route()
        try:
            req = self.body()
            if path == "api/link":
                link.start(str(req.get("url", "")), str(req.get("name", "")))
            elif path == "api/cancel":
                link.cancel()
            elif path == "api/unlink":
                link.unlink(force=bool(req.get("force")))
            elif path == "api/refresh":
                link.refresh()
            else:
                return self.error(HTTPStatus.NOT_FOUND, "not found")
        except (ValueError, TypeError, AttributeError) as e:
            return self.error(HTTPStatus.BAD_REQUEST, str(e))
        self.send(HTTPStatus.OK, link.state())


link = Link()


def main():
    server = ThreadingHTTPServer(("", PORT), Handler)
    server.daemon_threads = True
    print(f"cloud-link on :{PORT}, env file {ENV_FILE}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
