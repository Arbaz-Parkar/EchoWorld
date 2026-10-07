from datetime import datetime, timezone

from .db import redis_client, shards, shard_index, GEO_KEY
from .geo import to_geo


def write_frame(tick, npcs, run_id):
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
        })

    pipe.set("sim:tick", tick)
    pipe.execute()

    for i, batch in enumerate(batches):
        if batch:
            shards[i].insert_many(batch)
