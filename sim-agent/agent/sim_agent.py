"""Put this robot's airframe into the Gazebo world, and keep it there.

A plain zenoh client: Gazebo's gz-transport, on its zenoh backend, serves
`/world/<world>/create` as a queryable at `@/<partition>@/world/<world>/create`
taking a raw protobuf, and announces it with a liveliness token. Watching that
token is how we notice a world (re)start; each time it appears we remove our
model, in case it outlived us, and create it again.

The model is rendered from iris.sdf: named after the robot, with its
ArduPilotPlugin listening on 9002 + 10 * index, where this robot's SITL sends.
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

WORLD = os.environ.get("GZ_WORLD", "sdk")
PARTITION = os.environ.get("GZ_PARTITION", "sdk")
ROUTER = os.environ.get("ZENOH_CONNECT", "tcp/127.0.0.1:7447")
NAME = os.environ.get("ROBOT_NAME") or socket.gethostname()


def robot_index() -> int:
    """mu-N is index N-1, until the robot's config carries an index."""
    if os.environ.get("ROBOT_INDEX"):
        return int(os.environ["ROBOT_INDEX"])
    match = re.search(r"(\d+)$", NAME)
    return int(match.group(1)) - 1 if match else 0


INDEX = robot_index()
SERVICE = f"@/{PARTITION}@/world/{WORLD}"
# The token for our world's create service, as gz-transport mangles it.
CREATE_TOKEN = f"/%world%{WORLD}%create/"


def log(*args) -> None:
    print("sim-agent:", *args, flush=True)


# -- the three protobuf messages we need, encoded by hand ---------------------


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


# -- talking to the world -------------------------------------------------------


def call(session: zenoh.Session, service: str, request: bytes, timeout: float = 5.0) -> bool | None:
    """Call a gz service. None if nobody answered, which is how a failure looks."""
    for reply in session.get(f"{SERVICE}/{service}", payload=request, timeout=timeout):
        if reply.ok is not None:
            return boolean(reply.ok.payload.to_bytes())
    return None


def model_sdf() -> str:
    template = string.Template((Path(__file__).parent / "iris.sdf").read_text())
    return template.substitute(
        name=NAME,
        fdm_port=9002 + 10 * INDEX,
        # Side by side along y, 2 m apart, so robots don't spawn inside each other.
        pose=f"0 {2 * INDEX} 0.2 0 0 0",
    )


def spawn(session: zenoh.Session) -> bool:
    removed = call(session, "remove/blocking", entity_model(NAME))
    if removed:
        log(f"removed a leftover {NAME}")
    created = call(session, "create/blocking", entity_factory(model_sdf(), NAME), timeout=15.0)
    if created:
        log(f"spawned {NAME} (index {INDEX}, FDM port {9002 + 10 * INDEX})")
        return True
    log(f"spawning {NAME} failed:", "no reply" if created is None else "world refused it")
    return False


def main() -> None:
    conf = zenoh.Config()
    conf.insert_json5("mode", '"client"')
    conf.insert_json5("connect/endpoints", f'["{ROUTER}"]')
    conf.insert_json5("scouting/multicast/enabled", "false")

    world_up = threading.Event()

    def on_token(sample: zenoh.Sample) -> None:
        if CREATE_TOKEN not in str(sample.key_expr):
            return
        if sample.kind == zenoh.SampleKind.PUT:
            log("world is up")
            world_up.set()
        else:
            log("world went away")

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    log(f"{NAME}, index {INDEX}, via {ROUTER}")
    with zenoh.open(conf) as session:
        session.liveliness().declare_subscriber("@gz/**", on_token, history=True)
        while not stop.is_set():
            if not world_up.wait(timeout=1.0):
                continue
            world_up.clear()
            # A failed call gets no reply, only a timeout: retry until it
            # takes, or until the world goes away and comes back.
            while not stop.is_set() and not world_up.is_set() and not spawn(session):
                stop.wait(5.0)
        if call(session, "remove/blocking", entity_model(NAME), timeout=2.0):
            log(f"removed {NAME}")


if __name__ == "__main__":
    sys.exit(main())
