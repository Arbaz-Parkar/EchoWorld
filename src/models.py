NPC_IDS = [f"NPC_{i:02d}" for i in range(1, 13)]
ACTIVITIES = ["patrolling", "idle", "trading", "fighting", "fleeing"]

WORLD_X = (0, 100)
WORLD_Y = (0, 80)
NUM_TICKS = 150
ACTIVITY_CHANGE_CHANCE = 0.08
RANDOM_SEED = 42

EARTH_RADIUS_KM = 6378.1
DEFAULT_QUERY_RADIUS_KM = 2000