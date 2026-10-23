"""Tiles deeper than a file goes, made from its deepest tile above them.

Regions are cut to different max zooms, and the base stops at z6, but a layer
is one MapLibre source with one maxzoom. MapLibre doesn't fall back to a
parent tile when one is missing, so the server makes the child instead:

- Vector (MVT): the parent's features, rescaled into the child's square;
  those wholly outside it (and its buffer) are dropped. Only geometries
  change: the rest of the tile is copied byte for byte.
- Raster: the parent's quarter (or smaller) cropped and scaled up, nearest
  neighbour, so DEM values aren't blended into heights that don't exist; and
  re-encoded losslessly for the same reason.
"""

import io

BUFFER = 1 / 8  # of the extent, kept around the child square


# --- Protobuf, just enough for MVT --------------------------------------------


def _varint(buf, i):
    shift = result = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def _put_varint(out: bytearray, v: int):
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return


def _fields(buf):
    """(field number, wire type, raw bytes of the whole field, payload)."""
    i = 0
    n = len(buf)
    while i < n:
        start = i
        key, i = _varint(buf, i)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire == 2:
            length, i = _varint(buf, i)
            value = buf[i : i + length]
            i += length
        elif wire == 1:
            value = buf[i : i + 8]
            i += 8
        elif wire == 5:
            value = buf[i : i + 4]
            i += 4
        else:
            raise ValueError(f"wire type {wire}")
        yield field, wire, buf[start:i], value


def _put_bytes(out: bytearray, field: int, data: bytes):
    _put_varint(out, field << 3 | 2)
    _put_varint(out, len(data))
    out += data


def _packed(buf):
    i = 0
    vals = []
    while i < len(buf):
        v, i = _varint(buf, i)
        vals.append(v)
    return vals


def _zz(v):
    return (v >> 1) ^ -(v & 1)


def _unzz(v):
    return (v << 1) ^ (v >> 63)


# --- MVT -------------------------------------------------------------------


def _geometry(cmds, scale, ox, oy, lo, hi):
    """A feature's geometry commands, rescaled and moved; None if it lies
    wholly outside [lo, hi]."""
    out = []
    i = x = y = nx = ny = 0  # cursor in parent coordinates, and in child
    minx = miny = float("inf")
    maxx = maxy = float("-inf")
    while i < len(cmds):
        cmd = cmds[i]
        i += 1
        op, count = cmd & 7, cmd >> 3
        out.append(cmd)
        if op == 7:  # ClosePath
            continue
        for _ in range(count):
            x += _zz(cmds[i])
            y += _zz(cmds[i + 1])
            i += 2
            cx, cy = x * scale - ox, y * scale - oy
            out.append(_unzz(cx - nx))
            out.append(_unzz(cy - ny))
            nx, ny = cx, cy
            minx, maxx = min(minx, cx), max(maxx, cx)
            miny, maxy = min(miny, cy), max(maxy, cy)
    if maxx < lo or minx > hi or maxy < lo or miny > hi:
        return None
    return out


def _feature(buf, scale, ox, oy, lo, hi):
    out = bytearray()
    for field, wire, raw, value in _fields(buf):
        if field == 4 and wire == 2:
            geom = _geometry(_packed(value), scale, ox, oy, lo, hi)
            if geom is None:
                return None
            packed = bytearray()
            for v in geom:
                _put_varint(packed, v)
            _put_bytes(out, 4, packed)
        else:
            out += raw
    return bytes(out)


def _layer(buf, dz, cx, cy):
    extent = 4096
    for field, wire, _, value in _fields(buf):
        if field == 5 and wire == 0:
            extent = value
    scale = 1 << dz
    ox, oy = cx * extent, cy * extent
    lo, hi = -extent * BUFFER, extent * (1 + BUFFER)
    out = bytearray()
    kept = 0
    for field, wire, raw, value in _fields(buf):
        if field == 2 and wire == 2:
            f = _feature(value, scale, ox, oy, lo, hi)
            if f is not None:
                _put_bytes(out, 2, f)
                kept += 1
        else:
            out += raw
    return bytes(out) if kept else None


def mvt(data: bytes, dz: int, cx: int, cy: int) -> bytes:
    """The child tile at (cx, cy) of the 2**dz by 2**dz below this one."""
    out = bytearray()
    for field, wire, raw, value in _fields(data):
        if field == 3 and wire == 2:
            layer = _layer(value, dz, cx, cy)
            if layer is not None:
                _put_bytes(out, 3, layer)
        else:
            out += raw
    return bytes(out)


# --- Raster ------------------------------------------------------------------


def raster(data: bytes, dz: int, cx: int, cy: int, fmt: str) -> bytes:
    from PIL import Image

    img = Image.open(io.BytesIO(data))
    w, h = img.size
    n = 1 << dz
    box = (cx * w // n, cy * h // n, (cx + 1) * w // n, (cy + 1) * h // n)
    img = img.crop(box).resize((w, h), Image.NEAREST)
    out = io.BytesIO()
    if fmt == "webp":
        img.save(out, "WEBP", lossless=True)
    elif fmt == "jpg":
        img.convert("RGB").save(out, "JPEG", quality=90)
    else:
        img.save(out, "PNG")
    return out.getvalue()
