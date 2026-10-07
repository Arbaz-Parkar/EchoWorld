import math
import statistics

from .db import shard_for
from .geo import position_from_document
from .models import NPC_IDS, NPC_NAMES, MAX_PLAUSIBLE_STEP


def find_anomalies(run_id):
    """
    Speed-limit check over stored history: any NPC that covers more ground in
    one tick than the fastest legitimate movement is flagged. This is the same
    idea anti-cheat systems use to catch speed hacks and teleports.
    """
    found = []
    for npc_id in NPC_IDS:
        projection = {
            "_id": 0, "tick": 1, "x": 1, "y": 1, "location": 1,
        }
        docs = list(
            shard_for(npc_id)
            .find({"npc_id": npc_id, "run_id": run_id}, projection)
            .sort("tick", 1)
        )
        steps = []
        for a, b in zip(docs, docs[1:]):
            ax, ay = position_from_document(a)
            bx, by = position_from_document(b)
            steps.append((b["tick"], math.hypot(bx - ax, by - ay)))
        if len(steps) < 5:
            continue
        typical = statistics.median(d for _, d in steps) or 0.1
        for tick, dist in steps:
            if dist > MAX_PLAUSIBLE_STEP:
                found.append({
                    "npc_id": npc_id,
                    "name": NPC_NAMES[npc_id],
                    "tick": tick,
                    "distance": round(dist, 1),
                    "times_typical": round(dist / typical, 1),
                })
    return sorted(found, key=lambda a: a["tick"])
