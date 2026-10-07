import math

from .models import ORIGIN_LON, ORIGIN_LAT, METERS_PER_UNIT

EARTH_RADIUS_KM = 6378.1
_M_PER_DEG_LAT = 110574.0
_M_PER_DEG_LON = 111320.0 * math.cos(math.radians(ORIGIN_LAT))


def to_geo(x, y):
    lon = ORIGIN_LON + (x * METERS_PER_UNIT) / _M_PER_DEG_LON
    lat = ORIGIN_LAT + (y * METERS_PER_UNIT) / _M_PER_DEG_LAT
    return lon, lat


def from_geo(lon, lat):
    x = (lon - ORIGIN_LON) * _M_PER_DEG_LON / METERS_PER_UNIT
    y = (lat - ORIGIN_LAT) * _M_PER_DEG_LAT / METERS_PER_UNIT
    return x, y


def position_from_document(document):
    """Return map coordinates from either the current or legacy history schema."""
    if "x" in document and "y" in document:
        return float(document["x"]), float(document["y"])

    location = document.get("location") or {}
    coordinates = location.get("coordinates")
    if not isinstance(coordinates, (list, tuple)) or len(coordinates) != 2:
        raise ValueError("History document has no valid position")
    return from_geo(*coordinates)


def units_to_meters(units):
    return units * METERS_PER_UNIT


def meters_to_units(meters):
    return meters / METERS_PER_UNIT
