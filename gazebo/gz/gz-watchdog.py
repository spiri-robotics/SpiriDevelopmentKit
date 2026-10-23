#!/usr/bin/env python3
"""Run Gazebo, and stop it when the zenoh router it's linked to goes away.

Gazebo's zenoh is libzenohc 1.8, from the OSRF packages, and the router is
newer. When a 1.8 peer reconnects to a 1.10 router, it re-sends what it
declared as replies to the router's interest, which the router drops
("Received token with interest id from south-bound face"). Gazebo would carry
on without its services and topics, so the map loses the world, and robots
can't spawn into it. A fresh Gazebo declares everything anew, so this exits
when the link drops, and the container's restart policy brings Gazebo back.

The link is Gazebo's TCP connection to the router, read from /proc/net, which
needs nothing from zenoh. Drop this when Gazebo's zenoh is 1.9 or newer.

Usage: gz-watchdog gz sim ...
"""

import os
import signal
import socket
import subprocess
import sys
import time

ROUTER = os.environ.get("ZENOH_ROUTER", "zenoh-router")
PORT = 7447
INTERVAL = 2.0  # s between looks at the link
GRACE = 10.0  # s for Gazebo to stop before it's killed


def log(*args):
    print("gz-watchdog:", *args, file=sys.stderr, flush=True)


def router_links(ip: str) -> set[int]:
    """Local ports of established TCP connections to ip:PORT."""
    v4 = socket.inet_aton(ip)[::-1].hex().upper()
    remotes = {f"{v4}:{PORT:04X}", f"0000000000000000FFFF0000{v4}:{PORT:04X}"}
    ports = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(table) as f:
                next(f)
                for line in f:
                    local, remote, state = line.split()[1:4]
                    if state == "01" and remote in remotes:
                        ports.add(int(local.rsplit(":", 1)[1], 16))
        except FileNotFoundError:
            pass
    return ports


def main() -> int:
    child = subprocess.Popen(sys.argv[1:])

    def stop(signum, _frame):
        child.send_signal(signum)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    linked: set[int] = set()  # the link Gazebo first made, once it has
    while child.poll() is None:
        time.sleep(INTERVAL)
        try:
            ports = router_links(socket.gethostbyname(ROUTER))
        except OSError:
            ports = set()  # the router's name is gone with it
        if not linked:
            if ports:
                linked = ports
                log(f"linked to {ROUTER}:{PORT}")
            continue
        if not linked & ports:
            log(f"lost the link to {ROUTER}:{PORT}; stopping Gazebo to start afresh")
            child.terminate()
            try:
                child.wait(GRACE)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
            return 1
    return child.returncode


if __name__ == "__main__":
    sys.exit(main())
