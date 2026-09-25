import random
from .models import (NPC_IDS, ACTIVITIES, WORLD_X, WORLD_Y, NUM_TICKS,
                      ACTIVITY_CHANGE_CHANCE, RANDOM_SEED, ANOMALY_TICK, ANOMALY_NPC)
from .writer import write_tick
from .db import history_col


def run_simulation():
    random.seed(RANDOM_SEED)
    npc_states = {
        npc_id: {"x": round(random.uniform(*WORLD_X), 2),
                  "y": round(random.uniform(*WORLD_Y), 2), "activity": "idle"}
        for npc_id in NPC_IDS
    }

    print(f"Simulating {NUM_TICKS} ticks for {len(NPC_IDS)} NPCs...")

    for tick in range(1, NUM_TICKS + 1):
        for npc_id in NPC_IDS:
            state = npc_states[npc_id]

            if npc_id == ANOMALY_NPC and tick == ANOMALY_TICK:
                # Deliberate glitch: a sudden jump to a random point instead
                # of a normal step, purely to give the anomaly detector
                # below something real to catch.
                state["x"] = round(random.uniform(*WORLD_X), 2)
                state["y"] = round(random.uniform(*WORLD_Y), 2)
            else:
                state["x"] = min(max(state["x"] + random.uniform(-3, 3), WORLD_X[0]), WORLD_X[1])
                state["y"] = min(max(state["y"] + random.uniform(-3, 3), WORLD_Y[0]), WORLD_Y[1])

            if random.random() < ACTIVITY_CHANGE_CHANCE:
                state["activity"] = random.choice(ACTIVITIES)

            write_tick(npc_id, tick, round(state["x"], 2), round(state["y"], 2), state["activity"])

    print("Simulation complete. Total historical documents:", history_col.count_documents({}))