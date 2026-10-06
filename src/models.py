NPC_IDS = [f"NPC_{i:02d}" for i in range(1, 13)]
NPC_NAMES = {
    "NPC_01": "Aldric", "NPC_02": "Brenna", "NPC_03": "Cedric", "NPC_04": "Dara",
    "NPC_05": "Elowen", "NPC_06": "Fenn", "NPC_07": "Garrick", "NPC_08": "Hilda",
    "NPC_09": "Ivor", "NPC_10": "Jora", "NPC_11": "Kael", "NPC_12": "Lyra",
}

# Each NPC's permanent role, independent of whatever they're doing right
# now, so a merchant still looks like a merchant even while fleeing.
NPC_ROLES = {
    "NPC_01": "Market", "NPC_02": "Market", "NPC_03": "Market",
    "NPC_04": "Tavern", "NPC_05": "Tavern", "NPC_06": "Tavern",
    "NPC_07": "Barracks", "NPC_08": "Barracks", "NPC_09": "Barracks",
    "NPC_10": "Watchtower", "NPC_11": "Watchtower", "NPC_12": "Watchtower",
}

WORLD_W = 100
WORLD_H = 80

ACTIVITY_COLORS = {
    "walking": "#4fc3f7",
    "trading": "#ffd54f",
    "idle": "#b0bec5",
    "fighting": "#ef5350",
    "patrolling": "#81c784",
    "fleeing": "#ff9800",
}

ZONES = [
    {"name": "Market", "x": 25, "y": 55, "r": 11, "activity": "trading", "color": "#8d6e2f"},
    {"name": "Tavern", "x": 72, "y": 60, "r": 9, "activity": "idle", "color": "#6d4c41"},
    {"name": "Barracks", "x": 75, "y": 20, "r": 11, "activity": "fighting", "color": "#7b3f3f"},
    {"name": "Watchtower", "x": 22, "y": 18, "r": 8, "activity": "patrolling", "color": "#3f6b4a"},
]

WALK_SPEED = 1.4
FLEE_SPEED = 2.8
DWELL_RANGE = (12, 35)
FLEE_CHANCE = 0.004

MAX_TICKS = 400
TICK_SECONDS = 0.25
RANDOM_SEED = 42

ANOMALY_NPC = "NPC_03"
ANOMALY_TICK = 75

# Projection of the game world onto a small patch of the globe, so the
# database geospatial features measure real metres instead of degrees.
ORIGIN_LON = 73.10
ORIGIN_LAT = 19.00
METERS_PER_UNIT = 50

# Anomaly rule: no NPC can plausibly move farther than this in a single tick
# (fleeing is the fastest legitimate movement, plus a little noise headroom).
MAX_PLAUSIBLE_STEP = 3.5
