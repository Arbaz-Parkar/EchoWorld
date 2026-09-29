import math

from .models import ORIGIN_LON, ORIGIN_LAT, METERS_PER_UNIT

EARTH_RADIUS_KM = 6378.1
_M_PER_DEG_LAT = 110574.0
_M_PER_DEG_LON = 111320.0 * math.cos(math.radians(ORIGIN_LAT))


def to_geo(x, y):
    lon = ORIGIN_LON + (x * METERS_PER_UNIT) / _M_PER_DEG_LON
    lat = ORIGIN_LAT + (y * METERS_PER_UNIT) / _M_PER_DEG_LAT
    return lon, lat


def units_to_meters(units):
    return units * METERS_PER_UNIT


def meters_to_units(meters):
    return meters / METERS_PER_UNIT