import statistics


def compute_step_distances(history_col, npc_id):
    docs = list(history_col.find({"npc_id": npc_id}).sort("tick", 1))
    steps = []
    for prev, curr in zip(docs, docs[1:]):
        x1, y1 = prev["location"]["coordinates"]
        x2, y2 = curr["location"]["coordinates"]
        dist = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
        steps.append({"tick": curr["tick"], "distance": dist})
    return steps


def find_anomalies(history_col, npc_id, threshold_std=2.5):
    """
    Flags ticks where an NPC moved much farther than its own typical step.
    Deliberately one-directional: an unusually small step just means the
    NPC stood still, not suspicious. An unusually large step is what would
    actually indicate a glitch or a teleport in a real game.
    """
    steps = compute_step_distances(history_col, npc_id)
    distances = [s["distance"] for s in steps]
    if len(distances) < 2:
        return []
    mean = statistics.mean(distances)
    stdev = statistics.stdev(distances)
    return [
        s for s in steps
        if stdev > 0 and (s["distance"] - mean) > threshold_std * stdev
    ]


def report_anomalies(history_col, npc_ids, threshold_std=2.5):
    print("\nAnomaly scan (movement much larger than an NPC's normal step size):")
    any_found = False
    for npc_id in npc_ids:
        for a in find_anomalies(history_col, npc_id, threshold_std):
            any_found = True
            print(f"  {npc_id} at tick {a['tick']}: moved {a['distance']:.2f} units in one tick, "
                  f"far beyond its usual step size, possible glitch or teleport")
    if not any_found:
        print("  No anomalies found at this threshold.")