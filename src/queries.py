import time

from .db import redis_client, history_col
from .models import EARTH_RADIUS_KM


def get_live_state(npc_id):
    start = time.perf_counter()
    state = redis_client.hgetall(f"npc:live:{npc_id}")
    elapsed = time.perf_counter() - start
    return state, elapsed


def get_latest_from_history(npc_id):
    start = time.perf_counter()
    docs = list(history_col.find({"npc_id": npc_id}).sort("tick", -1).limit(1))
    elapsed = time.perf_counter() - start
    return (docs[0] if docs else None), elapsed


def get_temporal_range(npc_id, start_tick, end_tick):
    return list(history_col.find({
        "npc_id": npc_id,
        "tick": {"$gte": start_tick, "$lte": end_tick}
    }).sort("tick", 1))


def get_live_nearby(lon, lat, radius_km):
    return redis_client.geosearch(
        "npc:live:positions",
        longitude=lon, latitude=lat,
        radius=radius_km, unit="km",
        withcoord=True, withdist=True
    )


def get_historical_nearby(lon, lat, radius_km):
    return list(history_col.find({
        "location": {
            "$geoWithin": {
                "$centerSphere": [[lon, lat], radius_km / EARTH_RADIUS_KM]
            }
        }
    }))