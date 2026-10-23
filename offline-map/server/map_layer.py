"""The MapLayer SpiriSynq object. Importing SpiriSynq opens its default zenoh
session, so only server.py's serve imports this."""

from dataclasses import dataclass, field
from typing import Literal

from SpiriSynq.syncable_objects import SyncableObject

from tiles import WORLD


@dataclass(frozen=True)
class Region:
    name: str = ""
    bounds: list[float] = field(default_factory=lambda: list(WORLD))  # W, S, E, N
    minzoom: int = 0
    maxzoom: int = 0
    source: str = ""  # the planet it was cut from, if known


@dataclass
class MapLayer(SyncableObject):
    """A map layer: a MapLibre source, with tiles at tile_key, and what to
    draw from it. Layers with the same tile_key are one source drawn several
    ways: a page should fetch their tiles once."""

    title: str = ""
    # What to draw: "map" (Protomaps' fills and lines), "labels" (its
    # symbols), "buildings" (its buildings, extruded by height), "terrain"
    # (a DEM: terrain height and hillshade), "imagery".
    role: Literal["map", "labels", "buildings", "terrain", "imagery"] = "map"
    kind: Literal["raster", "raster-dem", "vector"] = "raster"
    format: Literal["png", "jpg", "webp", "pbf"] = "png"
    encoding: Literal["terrarium", "mapbox"] | None = None  # raster-dem only
    tile_size: int = 256
    minzoom: int = 0
    maxzoom: int = 0
    bounds: list[float] = field(default_factory=lambda: list(WORLD))  # W, S, E, N, of all regions
    attribution: str = ""
    regions: list[Region] = field(default_factory=list)  # newest first, then the base
    tile_key: str = ""  # "<layer path>/tiles/{z}/{x}/{y}"
    # Labels only: key templates for fonts, "<...>/fonts/{fontstack}/{range}.pbf",
    # and a prefix for sprites, "<...>/sprites/v4", to which a page adds
    # Protomaps' flavor name ("light", "dark", ...).
    glyphs: str = ""
    sprites: str = ""
