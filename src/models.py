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
    {"name": "Market", "x": 29, "y": 44, "r": 8, "activity": "trading", "color": "#a27639", "building": "market"},
    {"name": "Tavern", "x": 72, "y": 44, "r": 8, "activity": "idle", "color": "#8c5b3f", "building": "tavern"},
    {"name": "Barracks", "x": 75, "y": 61, "r": 7, "activity": "fighting", "color": "#87534b", "building": "barracks"},
    {"name": "Watchtower", "x": 23, "y": 61, "r": 6, "activity": "patrolling", "color": "#56734e", "building": "watchtower"},
    {"name": "High Hall", "x": 50, "y": 17, "r": 7, "activity": "patrolling", "color": "#8b7958", "building": "high_hall"},
    {"name": "Temple", "x": 25, "y": 25, "r": 6, "activity": "idle", "color": "#9a8965", "building": "temple"},
    {"name": "Forge", "x": 75, "y": 24, "r": 6, "activity": "trading", "color": "#855544", "building": "forge"},
    {"name": "Stables", "x": 62, "y": 64, "r": 6, "activity": "idle", "color": "#806548", "building": "stables"},
]

WALK_SPEED = 1.4
FLEE_SPEED = 2.8
DWELL_RANGE = (12, 35)
FLEE_CHANCE = 0.004

MAX_TICKS = 400
TICK_SECONDS = 0.25

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
