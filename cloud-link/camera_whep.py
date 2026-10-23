"""camera-whep: a SpiriSynq camera, served as WHEP for cloud-link's mediamtx.

The camera is mirrored, not consumed: a read-only view of the camera named
by CLOUD_LINK_CAMERA, so nothing new is published, and each frame the camera
already encoded is turned into H.264 once, by SpiriCamera's WebRTC track.
./camera is relative to the base topic (the robot's name), which SpiriSynq
expands itself from 0.4.0.

The mirror is made on the first request rather than at start, so this runs
before the camera does; a request that can't find it fails, and the next
tries again.
"""

import os
import threading

import uvicorn
from SpiriCamera.camera import Camera
from SpiriCamera.whep import create_whep_app

TOPIC = os.environ.get("CLOUD_LINK_CAMERA") or "./camera"
PORT = int(os.environ.get("CAMERA_WHEP_PORT", "8889"))

_lock = threading.Lock()
_mirror = None


def camera() -> Camera:
    global _mirror
    with _lock:
        if _mirror is None:
            _mirror = Camera.from_topic(TOPIC)
        return _mirror


if __name__ == "__main__":
    print(f"camera-whep: serving {TOPIC} on :{PORT}/whep", flush=True)
    uvicorn.run(create_whep_app(camera), host="0.0.0.0", port=PORT)
