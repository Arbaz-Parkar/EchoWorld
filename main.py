import matplotlib.pyplot as plt

from src.simulator import run_simulation
from src.queries import get_live_state, get_latest_from_history, get_temporal_range, get_live_nearby, get_historical_nearby
from src.sharding import populate_shards, scatter_gather_query
from src.db import history_col
from src.models import NPC_IDS, WORLD_X, WORLD_Y, NUM_TICKS, DEFAULT_QUERY_RADIUS_KM

run_simulation()

target_npc = "NPC_05"
live, live_time = get_live_state(target_npc)
latest, mongo_time = get_latest_from_history(target_npc)
print(f"\nLive state ({live_time*1000:.3f} ms):", live)
print(f"Latest from history ({mongo_time*1000:.3f} ms): tick {latest['tick']}, {latest['activity']}")

history_slice = get_temporal_range(target_npc, 40, 55)
print(f"\n{target_npc} between tick 40 and 55:")
for doc in history_slice:
    print(f"  tick {doc['tick']}: {doc['activity']}")

query_point = (50, 40)
nearby_now = get_live_nearby(*query_point, DEFAULT_QUERY_RADIUS_KM)
print(f"\nNPCs currently within {DEFAULT_QUERY_RADIUS_KM} km of {query_point}:")
for name, dist, coord in nearby_now:
    print(f"  {name}: {dist:.1f} km away")

historical = get_historical_nearby(*query_point, DEFAULT_QUERY_RADIUS_KM)
print(f"\n{len(historical)} historical records ever within {DEFAULT_QUERY_RADIUS_KM} km of {query_point}")

populate_shards(history_col)
shard_results = scatter_gather_query("NPC_04", (10, 15))
print(f"\nNPC_04 ticks 10-15, routed to its shard:")
for doc in shard_results:
    print(f"  tick {doc['tick']}: {doc['activity']}")

plt.figure(figsize=(10, 8))
for npc_id in NPC_IDS:
    trail = list(history_col.find({"npc_id": npc_id}).sort("tick", 1))
    xs = [d["location"]["coordinates"][0] for d in trail]
    ys = [d["location"]["coordinates"][1] for d in trail]
    plt.plot(xs, ys, alpha=0.4)
plt.xlim(WORLD_X)
plt.ylim(WORLD_Y)
plt.title(f"NPC Movement Over {NUM_TICKS} Ticks")
plt.savefig("outputs/movement_trails.png", dpi=150)
print("\nPlot saved to outputs/movement_trails.png")