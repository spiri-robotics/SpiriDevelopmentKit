"""Put this robot's airframe into the Gazebo world, and keep it there.

A plain zenoh client: Gazebo's gz-transport, on its zenoh backend, serves
`/world/<world>/create` as a queryable at `@/<partition>@/world/<world>/create`
taking a raw protobuf, and announces it with a liveliness token. Watching those
tokens is how we find the world, whatever it's called, and notice it
(re)starting; each time it appears we remove our model, in case it outlived
us, and create it again.

The model is rendered from iris.sdf: named after the robot, with its
ArduPilotPlugin listening on 9002 + 10 * index, where this robot's SITL sends.
With ROBOT_GIMBAL it carries a 3-axis gimbal, driven by SITL's mount outputs,
and a camera publishing on /model/<name>/gimbal/image.

    @sdk/sim-agent/<name>/respawn   remove the model and spawn it again, at
                                    its spawn pose and at rest. debug-map's
                                    Reset. SITL carries on as it was: armed
                                    and throttled up, it takes off again.
"""

import os
import re
import signal
import socket
import string
import sys
import threading
import time
from pathlib import Path

import zenoh

PARTITION = os.environ.get("GZ_PARTITION", "sdk")
ROUTER = os.environ.get("ZENOH_CONNECT", "tcp/127.0.0.1:7447")
NAME = os.environ.get("ROBOT_NAME") or socket.gethostname()


# Offsets the FDM port, as SITL's -I does. One robot: 0.
INDEX = int(os.environ.get("ROBOT_INDEX") or 0)
# A gimbal camera under the airframe; the robot's setting, as SpiriConfig
# writes a switch. ardupilot-sitl reads the same variable for its mount.
GIMBAL = os.environ.get("ROBOT_GIMBAL", "").strip().lower() in {"true", "1", "yes", "on"}
CAMERA = {
    "camera_width": int(os.environ.get("CAMERA_WIDTH") or 640),
    "camera_height": int(os.environ.get("CAMERA_HEIGHT") or 480),
    "camera_rate": float(os.environ.get("CAMERA_RATE") or 10),
}
# A world's create service, in its liveliness token as gz-transport mangles it.
CREATE_TOKEN = re.compile(r"/%world%([^%/]+)%create/")


def log(*args) -> None:
    print("sim-agent:", *args, flush=True)


# -- the protobuf messages we need, encoded and decoded by hand ---------------


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _string(field: int, value: str) -> bytes:
    data = value.encode()
    return _varint(field << 3 | 2) + _varint(len(data)) + data


def _uint(field: int, value: int) -> bytes:
    return _varint(field << 3) + _varint(value)


def entity_factory(sdf: str, name: str) -> bytes:
    """gz.msgs.EntityFactory: sdf = 2, name = 8 (allow_renaming stays false)."""
    return _string(2, sdf) + _string(8, name)


def entity_model(name: str) -> bytes:
    """gz.msgs.Entity: name = 3, type = 4 (MODEL = 2)."""
    return _string(3, name) + _uint(4, 2)


def boolean(payload: bytes) -> bool:
    """gz.msgs.Boolean: data = 2. Proto3 omits false, so empty is false."""
    return payload.endswith(b"\x10\x01")


def _read_varint(data: bytes, i: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = data[i]
        i += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return value, i


def _fields(data: bytes):
    """(field, value) for each field of a message; value is bytes when length-delimited."""
    i = 0
    while i < len(data):
        key, i = _read_varint(data, i)
        wire = key & 7
        if wire == 0:
            value, i = _read_varint(data, i)
        elif wire == 2:
            size, i = _read_varint(data, i)
            value, i = data[i : i + size], i + size
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            value, i = data[i : i + size], i + size
        else:
            raise ValueError(f"protobuf wire type {wire}")
        yield key >> 3, value


def model_names(payload: bytes) -> set[str]:
    """The top-level models in a gz.msgs.Scene: model = 9, each a Model with name = 2."""
    return {
        name.decode()
        for field, model in _fields(payload)
        if field == 9
        for f, name in _fields(model)
        if f == 2
    }


# -- talking to the world -------------------------------------------------------


def call(session: zenoh.Session, world: str, service: str, request: bytes, timeout: float = 5.0) -> bool | None:
    """Call a world's gz service. None if nobody answered, which is how a failure looks."""
    key = f"@/{PARTITION}@/world/{world}/{service}"
    for reply in session.get(key, payload=request, timeout=timeout):
        if reply.ok is not None:
            return boolean(reply.ok.payload.to_bytes())
    return None


def render(file: str, **values) -> str:
    return string.Template((Path(__file__).parent / file).read_text()).substitute(values)


def model_sdf() -> str:
    return render(
        "iris.sdf",
        name=NAME,
        fdm_port=9002 + 10 * INDEX,
        # Side by side along y, 2 m apart, so robots don't spawn inside each other.
        pose=f"0 {2 * INDEX} 0.2 0 0 0",
        gimbal=render("gimbal.sdf", name=NAME, **CAMERA) if GIMBAL else "",
        gimbal_controls=render("gimbal-controls.sdf", name=NAME) if GIMBAL else "",
    )


def models(session: zenoh.Session, world: str) -> set[str] | None:
    """The world's models by name, or None if it didn't answer."""
    key = f"@/{PARTITION}@/world/{world}/scene/info"
    for reply in session.get(key, payload=b"", timeout=5.0):
        if reply.ok is not None:
            return model_names(reply.ok.payload.to_bytes())
    return None


def remove(session: zenoh.Session, world: str, timeout: float = 10.0) -> bool:
    """Remove our model, and wait until the world has.

    remove/blocking answers as soon as the request is queued, true whether or
    not the model exists, and the world removes it only at the end of a step. A
    create sent before then is refused as a duplicate, and the removal is lost
    with it: the model stays, reset, with a second set of plugins and sensors
    loaded into it. So only ever create once the world no longer lists it.
    """
    names = models(session, world)
    if names is None or NAME not in names:
        return names is not None
    call(session, world, "remove/blocking", entity_model(NAME))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(0.2)
        names = models(session, world)
        if names is not None and NAME not in names:
            log(f"removed a leftover {NAME}")
            return True
    return False


def spawn(session: zenoh.Session, world: str) -> bool:
    if not remove(session, world):
        # A stalled world (e.g. waiting in lockstep on a SITL that's gone)
        # never gets to the end of a step; try again later.
        log(f"spawning {NAME} failed: the world didn't remove the old one")
        return False
    created = call(session, world, "create/blocking", entity_factory(model_sdf(), NAME), timeout=15.0)
    if created:
        log(f"spawned {NAME} into {world} (FDM port {9002 + 10 * INDEX})")
        return True
    log(f"spawning {NAME} failed:", "no reply" if created is None else "world refused it")
    return False


def respawn_key() -> str:
    return f"@sdk/sim-agent/{NAME}/respawn"


def main() -> None:
    conf = zenoh.Config()
    conf.insert_json5("mode", '"client"')
    conf.insert_json5("connect/endpoints", f'["{ROUTER}"]')
    conf.insert_json5("scouting/multicast/enabled", "false")

    world_up = threading.Event()
    world: str | None = None
    # Respawns from a query and from the world (re)appearing don't interleave.
    spawning = threading.Lock()

    def on_token(sample: zenoh.Sample) -> None:
        nonlocal world
        match = CREATE_TOKEN.search(str(sample.key_expr))
        if not match:
            return
        if sample.kind == zenoh.SampleKind.PUT:
            world = match.group(1)
            log(f"world {world} is up")
            world_up.set()
        else:
            log(f"world {match.group(1)} went away")

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    def respawn(session: zenoh.Session, query: zenoh.Query) -> None:
        if world is None:
            return query.reply_err("no world is up")
        with spawning:
            ok = spawn(session, world)
        if ok:
            query.reply(query.key_expr, f"respawned {NAME} in {world}")
        else:
            query.reply_err(f"respawning {NAME} in {world} failed; see sim-agent's log")

    def try_spawn(session: zenoh.Session) -> bool:
        with spawning:
            return spawn(session, world)

    log(f"{NAME} via {ROUTER}" + (", with a gimbal camera" if GIMBAL else ""))
    with zenoh.open(conf) as session:
        session.liveliness().declare_subscriber("@gz/**", on_token, history=True)
        # Spawning blocks on the world's replies, so not in zenoh's callback.
        session.declare_queryable(
            respawn_key(), lambda q: threading.Thread(target=respawn, args=(session, q), daemon=True).start()
        )
        while not stop.is_set():
            if not world_up.wait(timeout=1.0):
                continue
            world_up.clear()
            # A failed call gets no reply, only a timeout: retry until it
            # takes, or until the world goes away and comes back.
            while not stop.is_set() and not world_up.is_set() and not try_spawn(session):
                stop.wait(5.0)
        if world and call(session, world, "remove/blocking", entity_model(NAME), timeout=2.0):
            log(f"removed {NAME}")


if __name__ == "__main__":
    sys.exit(main())
