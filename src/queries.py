import math
import statistics
import time
from collections import defaultdict

from .db import (
    redis_client, shards, shard_for, shard_index, SHARD_LABELS, GEO_KEY,
)
from .geo import (
    to_geo, position_from_document, units_to_meters, meters_to_units,
    EARTH_RADIUS_KM,
)
from .models import NPC_IDS, MAX_PLAUSIBLE_STEP

PROJECTION = {
    "_id": 0, "npc_id": 1, "tick": 1, "x": 1, "y": 1,
    "location": 1, "activity": 1, "zone": 1, "target": 1,
}


def _npc_view(d):
    x, y = position_from_document(d)
    return {
        "id": d["npc_id"], "x": x, "y": y, "activity": d["activity"],
        "zone": d.get("zone") or None, "target": d.get("target") or None,
    }


def live_snapshot():
    """Reads every NPC's current state from Redis in one round trip."""
    start = time.perf_counter()
    pipe = redis_client.pipeline()
    for npc_id in NPC_IDS:
        pipe.hgetall(f"npc:live:{npc_id}")
    pipe.get("sim:tick")
    results = pipe.execute()
    ms = (time.perf_counter() - start) * 1000

    npcs = []
    for npc_id, h in zip(NPC_IDS, results[:-1]):
        if h:
            npcs.append({
                "id": npc_id, "x": float(h["x"]), "y": float(h["y"]),
                "activity": h["activity"],
                "zone": h.get("zone") or None, "target": h.get("target") or None,
            })
    return {"tick": int(results[-1] or 0), "npcs": npcs, "ms": round(ms, 3), "source": "redis"}


def frames(start, end):
    """Scatter-gather: asks every shard for a tick range and merges the answers."""
    t0 = time.perf_counter()
    by_tick = defaultdict(list)
    for col in shards:
        for d in col.find({"tick": {"$gte": start, "$lte": end}}, PROJECTION):
            by_tick[d["tick"]].append(_npc_view(d))
    out = [
        {"tick": t, "npcs": sorted(by_tick[t], key=lambda n: n["id"])}
        for t in sorted(by_tick)
    ]
    ms = (time.perf_counter() - t0) * 1000
    return {"frames": out, "ms": round(ms, 3), "source": "mongodb", "shards": SHARD_LABELS}


def _segments(docs):
    segments = []
    for d in docs:
        place = (d.get("target") or "") if d["activity"] == "walking" else (d.get("zone") or "")
        last = segments[-1] if segments else None
        if last and last["activity"] == d["activity"] and last["place"] == place \
                and last["end"] == d["tick"] - 1:
            last["end"] = d["tick"]
        else:
            segments.append({
                "start": d["tick"], "end": d["tick"],
                "activity": d["activity"], "place": place,
            })
    return segments


def memory(npc_id, t_from, t_to):
    """Temporal query routed to the single shard that owns this NPC."""
    t0 = time.perf_counter()
    col = shard_for(npc_id)
    docs = list(
        col.find({"npc_id": npc_id, "tick": {"$gte": t_from, "$lte": t_to}}, PROJECTION)
        .sort("tick", 1)
    )
    ms = (time.perf_counter() - t0) * 1000
    return {
        "npc_id": npc_id, "segments": _segments(docs), "records": len(docs),
        "shard": SHARD_LABELS[shard_index(npc_id)], "ms": round(ms, 3),
    }


def npc_profile(npc_id):
    t0 = time.perf_counter()
    col = shard_for(npc_id)
    docs = list(col.find({"npc_id": npc_id}, PROJECTION).sort("tick", 1))
    ms_history = (time.perf_counter() - t0) * 1000

    t1 = time.perf_counter()
    live = redis_client.hgetall(f"npc:live:{npc_id}")
    ms_live = (time.perf_counter() - t1) * 1000

    distance = 0.0
    jumps = 0
    for a, b in zip(docs, docs[1:]):
        ax, ay = position_from_document(a)
        bx, by = position_from_document(b)
        step = math.hypot(bx - ax, by - ay)
        if step > MAX_PLAUSIBLE_STEP:
            jumps += 1
        else:
            distance += step

    by_activity = defaultdict(int)
    by_zone = defaultdict(int)
    for d in docs:
        by_activity[d["activity"]] += 1
        if d.get("zone"):
            by_zone[d["zone"]] += 1

    return {
        "npc_id": npc_id,
        "shard": SHARD_LABELS[shard_index(npc_id)],
        "records": len(docs),
        "distance": round(distance, 1),
        "jumps": jumps,
        "time_by_activity": dict(by_activity),
        "time_by_zone": dict(by_zone),
        "segments": _segments(docs),
        "live": live,
        "ms_live": round(ms_live, 3),
        "ms_history": round(ms_history, 3),
    }


def nearby(x, y, radius_units, t_from, t_to):
    """Runs the same spatial question against both layers."""
    lon, lat = to_geo(x, y)
    radius_m = units_to_meters(radius_units)

    t0 = time.perf_counter()
    live_raw = redis_client.geosearch(
        GEO_KEY, longitude=lon, latitude=lat, radius=radius_m,
        unit="m", withdist=True, sort="ASC",
    )
    ms_live = (time.perf_counter() - t0) * 1000
    live = [
        {"id": name, "distance": round(meters_to_units(dist), 1)}
        for name, dist in live_raw
    ]

    t1 = time.perf_counter()
    query = {
        "location": {"$geoWithin": {"$centerSphere": [[lon, lat], radius_m / 1000.0 / EARTH_RADIUS_KM]}},
        "tick": {"$gte": t_from, "$lte": t_to},
    }
    counts = defaultdict(int)
    points = []
    total = 0
    projection = {"_id": 0, "npc_id": 1, "x": 1, "y": 1, "location": 1}
    for col in shards:
        for d in col.find(query, projection):
            total += 1
            counts[d["npc_id"]] += 1
            if len(points) < 3000:
                points.append(list(position_from_document(d)))
    ms_history = (time.perf_counter() - t1) * 1000

    per_npc = sorted(
        [{"id": k, "ticks": v} for k, v in counts.items()],
        key=lambda r: -r["ticks"],
    )
    return {
        "live": live,
        "history": {"records": total, "per_npc": per_npc, "points": points},
        "ms_live": round(ms_live, 3),
        "ms_history": round(ms_history, 3),
        "shards_queried": SHARD_LABELS,
    }


def stats():
    return {
        "mongo": {
            SHARD_LABELS[i]: col.estimated_document_count() for i, col in enumerate(shards)
        },
        "redis_keys": sum(1 for _ in redis_client.scan_iter("npc:live:*")),
    }


def _plan_stage(node, found=None):
    """Walks a MongoDB explain() plan tree and returns the first
    interesting stage name it finds (IXSCAN, GEO_NEAR_2DSPHERE, COLLSCAN)."""
    if found is None:
        found = []
    if isinstance(node, dict):
        stage = node.get("stage")
        if stage in ("IXSCAN", "GEO_NEAR_2DSPHERE", "COLLSCAN"):
            found.append(stage)
        for v in node.values():
            _plan_stage(v, found)
    elif isinstance(node, list):
        for v in node:
            _plan_stage(v, found)
    return found


def index_benchmark(x, y, radius_units, reps=15):
    """
    Runs the identical spatial query twice: once letting MongoDB use the
    2dsphere index normally, once with a $natural hint that forces a full
    collection scan instead. Same data, same filter, only the access path
    changes. Each version runs several times and the fastest run is kept,
    since that best reflects the query itself rather than one-off system
    noise (a common benchmarking practice).
    """
    lon, lat = to_geo(x, y)
    radius_m = units_to_meters(radius_units)
    query = {
        "location": {
            "$geoWithin": {"$centerSphere": [[lon, lat], radius_m / 1000.0 / EARTH_RADIUS_KM]}
        }
    }
    col = shards[0]

    indexed_times = []
    scan_times = []

    for _ in range(reps):
        t0 = time.perf_counter()
        list(col.find(query).hint([("location", "2dsphere")]))
        indexed_times.append(time.perf_counter() - t0)

    for _ in range(reps):
        t0 = time.perf_counter()
        list(col.find(query).hint([("$natural", 1)]))
        scan_times.append(time.perf_counter() - t0)

    try:
        indexed_plan = _plan_stage(col.find(query).hint([("location", "2dsphere")]).explain())
        scan_plan = _plan_stage(col.find(query).hint([("$natural", 1)]).explain())
    except Exception:
        indexed_plan, scan_plan = [], []

    return {
        "documents_scanned": col.count_documents({}),
        "indexed_ms": round(min(indexed_times) * 1000, 3),
        "scan_ms": round(min(scan_times) * 1000, 3),
        "indexed_plan": indexed_plan[0] if indexed_plan else "unknown",
        "scan_plan": scan_plan[0] if scan_plan else "unknown",
        "reps": reps,
    }
