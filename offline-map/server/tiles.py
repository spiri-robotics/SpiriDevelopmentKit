"""PMTiles files and the layers they make up, shared by server.py and manager.py.

Each layer is a directory of .pmtiles files, one per region, under DATA (what
people add) and BASE (what ships in the image). A tile comes from the first
file that has it: regions newest first, then the base. Failing that, it's
made from the first file with a tile above it (overzoom.py). A region's .json
sidecar says where it was cut from.

Anything ending in .pmtiles is read as soon as it's seen, so files are written
under another name (.part) and renamed into place.
"""

import functools
import gzip
import json
import mmap
import os
import re
import subprocess
import urllib.request
from pathlib import Path

from pmtiles.tile import Compression, TileType, deserialize_directory, deserialize_header, find_tile, zxy_to_tileid

import overzoom

DATA = Path(os.environ.get("OFFLINE_MAP_DATA", "/data"))
BASE = Path(os.environ.get("OFFLINE_MAP_BASE", "/opt/offline-map/base"))

PROTOMAPS_BUILDS = "https://build-metadata.protomaps.dev/builds.json"

# What a layer's files don't say about it, where its regions are cut from, and
# the max zoom a new region gets. A directory with another name is still
# served, with what its header says.
LAYERS = {
    # z15: Protomaps' buildings are nearly all at z15 only.
    "osm": dict(title="OpenStreetMap", kind="vector", planet="protomaps", maxzoom=15, planet_maxzoom=15),
    "terrain": dict(title="Terrain", kind="raster-dem", encoding="terrarium", tile_size=512,
                    planet="https://download.mapterhorn.com/planet.pmtiles", maxzoom=12, planet_maxzoom=12),
}

# What each layer is published as: MapLayer objects, by name and role, all
# sharing the layer's tiles. A layer not here is one object, its role from
# its tiles.
ROLES = {
    "osm": [("osm", "map"), ("osm-labels", "labels"), ("osm-buildings", "buildings")],
    "terrain": [("terrain", "terrain")],
}

# Fonts and sprites for labels (Protomaps'), served with the tiles.
ASSETS = Path(os.environ.get("OFFLINE_MAP_ASSETS", "/opt/offline-map/web/assets"))

FORMATS = {
    TileType.MVT: ("pbf", "application/vnd.mapbox-vector-tile"),
    TileType.PNG: ("png", "image/png"),
    TileType.JPEG: ("jpg", "image/jpeg"),
    TileType.WEBP: ("webp", "image/webp"),
}

WORLD = [-180.0, -85.051129, 180.0, 85.051129]

NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


class Tileset:
    """One .pmtiles file, mapped into memory, with its directories cached."""

    def __init__(self, path: Path):
        self.path = path
        self.base = path.is_relative_to(BASE)
        with path.open("rb") as f:
            self.data = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        self.size = len(self.data)
        self.mtime = path.stat().st_mtime
        self.header = h = deserialize_header(self.data[0:127])
        meta = self.data[h["metadata_offset"] : h["metadata_offset"] + h["metadata_length"]]
        if h["internal_compression"] == Compression.GZIP:
            meta = gzip.decompress(meta)
        self.metadata = json.loads(meta or b"{}")
        self.directory = functools.lru_cache(maxsize=64)(
            lambda offset, length: deserialize_directory(self.data[offset : offset + length])
        )
        side = path.with_suffix(".json")
        self.source = json.loads(side.read_text()).get("source", "") if side.exists() else ""

    @property
    def name(self):
        return self.path.stem

    @property
    def bounds(self):
        h = self.header
        return [h["min_lon_e7"] / 1e7, h["min_lat_e7"] / 1e7, h["max_lon_e7"] / 1e7, h["max_lat_e7"] / 1e7]

    @property
    def gzipped(self):
        return self.header["tile_compression"] == Compression.GZIP

    def get(self, z, x, y) -> bytes | None:
        h = self.header
        if not h["min_zoom"] <= z <= h["max_zoom"]:
            return None
        tile_id = zxy_to_tileid(z, x, y)
        offset, length = h["root_offset"], h["root_length"]
        for _ in range(4):  # the spec's maximum depth
            entry = find_tile(self.directory(offset, length), tile_id)
            if entry is None:
                return None
            if entry.run_length:
                start = h["tile_data_offset"] + entry.offset
                return self.data[start : start + entry.length]
            offset, length = h["leaf_directory_offset"] + entry.offset, entry.length
        return None

    def describe(self):
        return dict(name=self.name, base=self.base, size=self.size, mtime=self.mtime, bounds=self.bounds,
                    minzoom=self.header["min_zoom"], maxzoom=self.header["max_zoom"], source=self.source)


def layer_names() -> set[str]:
    return {p.name for root in (DATA, BASE) if root.is_dir() for p in root.iterdir() if p.is_dir()} | LAYERS.keys()


class Stack:
    """A layer's files, newest region first and the base last, reloaded when
    they change."""

    def __init__(self, name: str):
        self.name = name
        self.tilesets: list[Tileset] = []
        self.seen = None

    def files(self):
        regions = sorted((DATA / self.name).glob("*.pmtiles"), key=lambda p: p.stat().st_mtime, reverse=True)
        return regions + sorted((BASE / self.name).glob("*.pmtiles"))

    def rescan(self, log=print) -> bool:
        """Reload if the files changed; True if they did."""
        try:
            files = self.files()
            seen = [(p, p.stat().st_mtime, p.stat().st_size) for p in files]
        except FileNotFoundError:  # one went away mid-scan; next time
            return False
        if seen == self.seen:
            return False
        self.seen = seen
        tilesets = []
        for p in files:
            try:
                tilesets.append(Tileset(p))
            except Exception as e:
                log(f"{p}: {e}")
        self.tilesets = tilesets
        return True

    def get(self, z, x, y) -> tuple[bytes, Tileset] | None:
        """A tile: from the first file that has it, or else made from the
        first file with a tile above it (overzoom.py), so a region cut to z14,
        or the z6 base, still answers deeper."""
        for t in self.tilesets:
            if (tile := t.get(z, x, y)) is not None:
                return tile, t
        for t in self.tilesets:
            dz = z - t.header["max_zoom"]
            if dz > 0 and t.get(z - dz, x >> dz, y >> dz) is not None:
                return _overzoomed(t, dz, x, y), t
        return None

    def source(self) -> dict:
        """The layer as a MapLibre source spec, less its tile URL."""
        ts = self.tilesets
        known = LAYERS.get(self.name, {})
        s = dict(title=known.get("title", self.name), encoding=known.get("encoding"), kind="raster", format="png",
                 media="application/octet-stream", minzoom=0, maxzoom=0, bounds=list(WORLD), attribution="")
        if ts:
            first = ts[0].header
            s["format"], s["media"] = FORMATS.get(first["tile_type"], ("png", "application/octet-stream"))
            if ts[0].gzipped:
                s["media"] += ";gzip"
            s["kind"] = known.get("kind", "vector" if first["tile_type"] == TileType.MVT else "raster")
            s["minzoom"] = min(t.header["min_zoom"] for t in ts)
            s["maxzoom"] = max(t.header["max_zoom"] for t in ts)
            bs = [t.bounds for t in ts]
            s["bounds"] = [min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs)]
            s["attribution"] = next((t.metadata["attribution"] for t in ts if t.metadata.get("attribution")), "")
        else:
            s["kind"] = known.get("kind", "raster")
        s["tile_size"] = known.get("tile_size", 512 if s["kind"] == "vector" else 256)
        return s


@functools.lru_cache(maxsize=512)
def _overzoomed(t: Tileset, dz: int, x: int, y: int) -> bytes:
    parent = bytes(t.get(t.header["max_zoom"], x >> dz, y >> dz))
    cx, cy = x & ((1 << dz) - 1), y & ((1 << dz) - 1)
    if t.header["tile_type"] == TileType.MVT:
        data = gzip.decompress(parent) if t.gzipped else parent
        data = overzoom.mvt(data, dz, cx, cy)
        return gzip.compress(data, 6) if t.gzipped else data
    return overzoom.raster(parent, dz, cx, cy, FORMATS[t.header["tile_type"]][0])


def planet_url(layer: str) -> str:
    planet = LAYERS.get(layer, {}).get("planet")
    if planet is None:
        raise ValueError(f"don't know where to cut {layer} from")
    if planet == "protomaps":
        # Python's own User-Agent gets a 403.
        req = urllib.request.Request(PROTOMAPS_BUILDS, headers={"User-Agent": "offline-map"})
        with urllib.request.urlopen(req, timeout=30) as r:
            latest = json.load(r)[-1]["key"]
        return f"https://build.protomaps.com/{latest}"
    return planet


def _extract_cmd(url, out, bbox, maxzoom):
    w, s, e, n = bbox
    cmd = ["pmtiles", "extract", url, str(out), f"--bbox={w},{s},{e},{n}"]
    if maxzoom is not None:
        cmd.append(f"--maxzoom={maxzoom}")
    return cmd


def estimate(layer: str, bbox, maxzoom: int | None, url: str | None = None) -> int:
    """A region's size in bytes, from a dry run: only the directories are read."""
    url = url or planet_url(layer)
    r = subprocess.run(_extract_cmd(url, "/dev/null", bbox, maxzoom) + ["--dry-run"],
                       capture_output=True, text=True, timeout=120)
    m = re.search(r"archive size of ([\d.]+) (\w?B)", r.stderr + r.stdout)
    if r.returncode or not m:
        raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout) else "dry run failed")
    units = {"B": 1, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}
    return int(float(m[1]) * units.get(m[2], 1))


def part_path(layer: str, region: str) -> Path:
    return DATA / layer / f"{region}.part"


def extract(layer: str, region: str, bbox, maxzoom: int | None, url: str | None = None) -> Path:
    """Cut a region out of the layer's planet into DATA."""
    if not NAME.match(region):
        raise ValueError(f"bad region name {region!r}")
    url = url or planet_url(layer)
    out = DATA / layer / f"{region}.pmtiles"
    out.parent.mkdir(parents=True, exist_ok=True)
    part = part_path(layer, region)
    r = subprocess.run(_extract_cmd(url, part, bbox, maxzoom), capture_output=True, text=True)
    if r.returncode:
        part.unlink(missing_ok=True)
        raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout) else "extract failed")
    out.with_suffix(".json").write_text(json.dumps({"source": url, "bbox": list(bbox), "maxzoom": maxzoom}))
    part.rename(out)
    return out


def remove(layer: str, region: str):
    if not NAME.match(region):
        raise ValueError(f"bad region name {region!r}")
    for suffix in (".pmtiles", ".json"):
        (DATA / layer / f"{region}{suffix}").unlink(missing_ok=True)
