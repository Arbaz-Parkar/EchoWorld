from datetime import datetime, timezone
from collections import defaultdict, deque
import threading
import time

from .db import redis_client, shards, shard_index, GEO_KEY
from .geo import to_geo

WRITE_SAMPLE_LIMIT = 400
_write_samples = defaultdict(lambda: deque(maxlen=WRITE_SAMPLE_LIMIT))
_write_samples_lock = threading.Lock()


def write_frame(tick, npcs, run_id):
    started = time.perf_counter()
    now = datetime.now(timezone.utc)
    pipe = redis_client.pipeline()
    batches = [[], []]

    for n in npcs:
        lon, lat = to_geo(n["x"], n["y"])

        pipe.hset(f"npc:live:{n['id']}", mapping={
            "x": n["x"], "y": n["y"], "activity": n["activity"],
            "zone": n["zone"] or "", "target": n["target"] or "", "tick": tick,
        })
        pipe.geoadd(GEO_KEY, (lon, lat, n["id"]))

        batches[shard_index(n["id"])].append({
            "run_id": run_id, "npc_id": n["id"], "tick": tick, "timestamp": now,
            "x": n["x"], "y": n["y"],
            "location": {"type": "Point", "coordinates": [lon, lat]},
            "activity": n["activity"], "zone": n["zone"] or "",
            "target": n["target"] or "",
            "decision_note": n.get("decision_note", ""),
            "incident_zone": n.get("incident_zone") or "",
            "incident_tick": n.get("incident_tick"),
        })

    pipe.set("sim:tick", tick)
    pipe.execute()

    for i, batch in enumerate(batches):
        if batch:
            shards[i].insert_many(batch)

    elapsed_ms = (time.perf_counter() - started) * 1000
    docs_written = len(npcs)
    with _write_samples_lock:
        _write_samples[run_id].append({
            "tick": tick,
            "records": docs_written,
            "write_ms": round(elapsed_ms, 3),
            "records_per_second": round(docs_written / max(elapsed_ms / 1000, 0.000001), 1),
        })


def write_performance(run_id):
    with _write_samples_lock:
        samples = list(_write_samples.get(run_id, ()))
    if not samples:
        return {"samples": [], "latest": None, "average_records_per_second": 0}
    return {
        "samples": samples,
        "latest": samples[-1],
        "average_records_per_second": round(
            sum(sample["records_per_second"] for sample in samples) / len(samples), 1
        ),
    }
