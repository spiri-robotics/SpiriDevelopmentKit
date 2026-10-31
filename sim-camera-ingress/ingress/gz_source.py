"""gz:// -- a Gazebo camera sensor as a SpiriCamera source.

``gz://model/mu-1/gimbal/image`` reads the camera publishing on the gz topic
``/model/mu-1/gimbal/image``, straight off zenoh: gz-transport's zenoh
backend publishes a topic at ``@/<partition>@/<topic>`` as a raw
``gz.msgs.Image`` protobuf. It needs no Gazebo libraries, and no video
encoding between the world and the robot.

gz-transport only publishes a topic someone subscribes to, and it learns of
subscribers from their liveliness tokens, so this declares one, as a gz node
would. A camera with no subscriber isn't rendered at all, which is why a sim
camera costs nothing until its ingress runs.

The lens comes from the ``camera_info`` the sensor publishes beside its image,
read once on opening, so the camera's intrinsics are the sensor's own.

Registered by being imported (SpiriCamera finds every SourceBase subclass);
run.py imports it before handing over to SpiriCamera's CLI.
"""

from __future__ import annotations

import os
import struct
import threading
import time
import uuid
from collections.abc import Iterator

import cv2
import numpy as np
from loguru import logger
from SpiriSynq.session import current_session

from SpiriCamera.sources.base import (
    CaptureSettings,
    Intrinsics,
    SourceBase,
    SourceCapabilities,
    SourceError,
    SourceURL,
)

PARTITION = os.environ.get("GZ_PARTITION", "sdk")


def fit_within(width: int, height: int, max_width: int, max_height: int) -> tuple[int, int]:
    """The largest size within the bounds with the frame's aspect, never larger than it."""
    scale = min(1.0, max_width / width if max_width else 1.0, max_height / height if max_height else 1.0)
    return max(1, round(width * scale)), max(1, round(height * scale))

# gz.msgs.PixelFormatType -> (channels, conversion to BGR, or None if BGR already)
PIXEL_FORMATS = {
    1: (1, cv2.COLOR_GRAY2BGR),  # L_INT8
    3: (3, cv2.COLOR_RGB2BGR),  # RGB_INT8
    4: (4, cv2.COLOR_RGBA2BGR),  # RGBA_INT8
    5: (4, cv2.COLOR_BGRA2BGR),  # BGRA_INT8
    8: (3, None),  # BGR_INT8
}


def _varint(data: bytes, i: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = data[i]
        i += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, i
        shift += 7


def _fields(data: bytes | memoryview) -> Iterator[tuple[int, int, int | memoryview]]:
    """A protobuf message's (field number, wire type, value), in order.

    Varints are ints; length-delimited values are views into ``data``;
    fixed-width ones are their raw bytes, as views too.
    """
    view = memoryview(data)
    i = 0
    while i < len(view):
        tag, i = _varint(view, i)
        number, wire = tag >> 3, tag & 7
        if wire == 0:
            value, i = _varint(view, i)
            yield number, wire, value
        elif wire in (1, 2, 5):
            length = {1: 8, 5: 4}.get(wire)
            if length is None:
                length, i = _varint(view, i)
            yield number, wire, view[i : i + length]
            i += length
        else:
            raise ValueError(f"unexpected protobuf wire type {wire}")


def decode_image(data: bytes) -> tuple[int, int, int, int, memoryview]:
    """gz.msgs.Image: width = 2, height = 3, step = 4, data = 5, pixel_format_type = 6.

    Returns (width, height, step, pixel format, pixels). The pixels are a view
    into ``data``, not a copy.
    """
    fields = {2: 0, 3: 0, 4: 0, 6: 0}
    pixels = memoryview(b"")
    for number, wire, value in _fields(data):
        if wire == 0:
            fields[number] = value
        elif number == 5:
            pixels = value
    return fields[2], fields[3], fields[4], fields[6], pixels


def decode_camera_info(data: bytes) -> Intrinsics:
    """gz.msgs.CameraInfo: width = 2, height = 3, intrinsics = 5.

    intrinsics is a gz.msgs.CameraInfo.Intrinsics, whose k = 1 is the 3x3
    camera matrix, row major: fx 0 cx / 0 fy cy / 0 0 1.
    """
    width = height = 0
    k: list[float] = []
    for number, wire, value in _fields(data):
        if number == 2 and wire == 0:
            width = value
        elif number == 3 and wire == 0:
            height = value
        elif number == 5 and wire == 2:
            for inner, inner_wire, item in _fields(value):
                if inner != 1:
                    continue
                if inner_wire == 2:  # packed, as proto3 writes it
                    k.extend(struct.unpack(f"<{len(item) // 8}d", item))
                else:
                    k.extend(struct.unpack("<d", item))
    if len(k) != 9:
        raise ValueError(f"camera matrix has {len(k)} entries, not 9")
    return Intrinsics(width, height, fx=k[0], fy=k[4], cx=k[2], cy=k[5])


class GzSource(SourceBase):
    """Frames from a Gazebo camera sensor, by its gz topic."""

    schemes = ("gz",)

    #: Seconds without a frame before checking the camera is still there.
    STALE_AFTER = 3.0

    #: Seconds to wait for the sensor's camera_info when opening.
    CAMERA_INFO_TIMEOUT = 5.0

    def __init__(self, url: SourceURL) -> None:
        super().__init__(url)
        self._session = None
        self._subscriber = None
        self._token = None
        self._lock = threading.Lock()
        self._latest: bytes = b""
        self._last_arrival = 0.0
        self._last_probe = 0.0
        self._frame: np.ndarray | None = None
        self._frame_from: bytes = b""
        self._frame_bounds: tuple[int, int] | None = None

    @classmethod
    def from_url(cls, url: SourceURL) -> GzSource:
        if not url.target.strip("/"):
            raise SourceError(f"No topic given in {url.raw!r}; expected gz://<topic>")
        return cls(url)

    @property
    def topic(self) -> str:
        return "/" + self.url.target.strip("/")

    @property
    def key(self) -> str:
        return f"@/{PARTITION}@{self.topic}"

    @property
    def is_open(self) -> bool:
        return self._subscriber is not None

    def _published(self) -> bool:
        """Whether some gz node advertises the topic (an MP liveliness token)."""
        mangled = self.topic.replace("/", "%")
        replies = self._session.liveliness().get(f"@gz/%{PARTITION}/*/*/*/MP/%/%/%/{mangled}/**", timeout=2)
        return any(reply.ok is not None for reply in replies)

    def open(self, settings: CaptureSettings) -> SourceCapabilities:
        del settings  # Applied per frame in read(), so live changes work.
        if self._subscriber is not None:
            return SourceCapabilities()
        self._session = current_session.get().zenoh_session
        if not self._published():
            self._session = None
            raise SourceError(f"nothing publishes the gz topic {self.topic} (partition {PARTITION})")

        now = time.monotonic()
        self._last_arrival = self._last_probe = now
        self._subscriber = self._session.declare_subscriber(self.key, self._on_sample)
        self._token = self._subscribe_token(self.topic, "gz.msgs.Image")
        logger.info(f"{self!r} subscribed to {self.key}")

        lens = self._camera_info()
        if lens is None:
            return SourceCapabilities(vendor="Gazebo", model="camera sensor")
        logger.info(f"{self!r} lens {lens} from camera_info")
        return SourceCapabilities(
            max_supported_width=lens.width,
            max_supported_height=lens.height,
            vendor="Gazebo",
            model="camera sensor",
            intrinsics=lens,
        )

    def _subscribe_token(self, topic: str, message_type: str):
        """Declare the token a gz subscriber to *topic* declares.

        It's what makes the camera render and the topic publish: partition,
        process, node, node, MS (message subscriber), three empty fields,
        topic, message type.
        """
        node = uuid.uuid4()
        mangled = topic.replace("/", "%")
        token = f"@gz/%{PARTITION}/{uuid.uuid4()}/{node}/{node}/MS/%/%/%/{mangled}/{message_type}/%/%"
        return self._session.liveliness().declare_token(token)

    def _camera_info(self) -> Intrinsics | None:
        """The sensor's lens, from the camera_info it publishes beside its image.

        A gz camera sensor publishes ``<topic>/camera_info`` next to
        ``<topic>/image`` with every frame, so this waits for one.
        """
        topic = self.topic.rsplit("/", 1)[0] + "/camera_info"
        received: list[bytes] = []
        arrived = threading.Event()

        def on_sample(sample) -> None:
            received.append(sample.payload.to_bytes())
            arrived.set()

        subscriber = self._session.declare_subscriber(f"@/{PARTITION}@{topic}", on_sample)
        token = self._subscribe_token(topic, "gz.msgs.CameraInfo")
        try:
            if not arrived.wait(self.CAMERA_INFO_TIMEOUT):
                logger.warning(f"{self!r}: no camera_info on {topic}, lens unknown")
                return None
            return decode_camera_info(received[0])
        except ValueError as error:
            logger.warning(f"{self!r}: unusable camera_info on {topic}: {error}")
            return None
        finally:
            token.undeclare()
            subscriber.undeclare()

    def _on_sample(self, sample) -> None:
        """On zenoh's thread: just keep the bytes for :py:meth:`read`."""
        with self._lock:
            self._latest = sample.payload.to_bytes()
            self._last_arrival = time.monotonic()

    def close(self) -> None:
        for handle in (self._token, self._subscriber):
            if handle is not None:
                try:
                    handle.undeclare()
                except Exception:
                    pass
        self._token = self._subscriber = self._session = None
        with self._lock:
            self._latest = b""
        self._frame = None
        self._frame_from = b""
        self._frame_bounds = None

    def read(self, settings: CaptureSettings) -> np.ndarray | None:
        if self._subscriber is None:
            raise SourceError(f"{self!r} is not open; call open() before read()")
        self._check_publisher()

        with self._lock:
            message = self._latest
        if not message:
            return None
        bounds = (settings.max_width, settings.max_height)
        if message is self._frame_from and bounds == self._frame_bounds:
            return self._frame

        width, height, step, pixel_format, pixels = decode_image(message)
        if pixel_format not in PIXEL_FORMATS or not width or not height:
            raise SourceError(f"{self.topic}: unsupported image ({width}x{height}, pixel format {pixel_format})")
        channels, conversion = PIXEL_FORMATS[pixel_format]
        rows = np.frombuffer(pixels, np.uint8).reshape(height, step or width * channels)
        frame = rows[:, : width * channels].reshape(height, width, channels)
        frame = cv2.cvtColor(frame, conversion) if conversion is not None else frame.copy()

        size = fit_within(width, height, settings.max_width, settings.max_height)
        if size != (width, height):
            frame = cv2.resize(frame, size, interpolation=cv2.INTER_AREA)
        self._frame, self._frame_from, self._frame_bounds = frame, message, bounds
        return frame

    def _check_publisher(self) -> None:
        """Close and raise if no frame has come for a while and the camera is gone.

        A world that restarts, or a model that is respawned, comes back with a
        new publisher; the camera retries the source until then.
        """
        now = time.monotonic()
        with self._lock:
            quiet_for = now - self._last_arrival
        if quiet_for < self.STALE_AFTER or now - self._last_probe < self.STALE_AFTER:
            return
        self._last_probe = now
        if not self._published():
            self.close()
            raise SourceError(f"the gz topic {self.topic} is no longer published")
