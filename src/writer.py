from datetime import datetime

from .db import redis_client, history_col


def write_tick(npc_id, tick, x, y, activity):
    redis_client.hset(f"npc:live:{npc_id}", mapping={
        "x": x, "y": y, "activity": activity, "tick": tick
    })
    redis_client.geoadd("npc:live:positions", (x, y, npc_id))

    history_col.insert_one({
        "npc_id": npc_id,
        "tick": tick,
        "timestamp": datetime.utcnow(),
        "location": {"type": "Point", "coordinates": [x, y]},
        "activity": activity
    })