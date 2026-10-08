DEFAULT_NPC_COUNT = 12
MAX_NPCS = 120
NPC_NAME_POOL = [
    "Aldric", "Brenna", "Cedric", "Dara", "Elowen", "Fenn",
    "Garrick", "Hilda", "Ivor", "Jora", "Kael", "Lyra",
]
NPC_ROLE_PATTERN = [
    "Market", "Market", "Market", "Tavern", "Tavern", "Tavern",
    "Barracks", "Barracks", "Barracks", "Watchtower", "Watchtower", "Watchtower",
]


def make_npc_roster(count):
    ids = [f"NPC_{i:02d}" for i in range(1, count + 1)]
    names = {
        npc_id: (
            NPC_NAME_POOL[(i - 1) % len(NPC_NAME_POOL)]
            if i <= len(NPC_NAME_POOL)
            else f"{NPC_NAME_POOL[(i - 1) % len(NPC_NAME_POOL)]} {i}"
        )
        for i, npc_id in enumerate(ids, 1)
    }
    roles = {
        npc_id: NPC_ROLE_PATTERN[(i - 1) % len(NPC_ROLE_PATTERN)]
        for i, npc_id in enumerate(ids, 1)
    }
    return ids, names, roles


NPC_IDS, NPC_NAMES, NPC_ROLES = make_npc_roster(DEFAULT_NPC_COUNT)

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

# Elliptical movement blockers for the landmark footprints drawn on the map.
# The extra breathing room keeps sprites from clipping through roof edges.
CITY_BLOCKERS = [
    {"x": 29, "y": 40, "rx": 5.4, "ry": 6.4},   # Market hall
    {"x": 72, "y": 39, "rx": 5.7, "ry": 6.7},   # Tavern
    {"x": 75, "y": 55.2, "rx": 5.8, "ry": 4.4}, # Barracks
    {"x": 23, "y": 54.7, "rx": 4.8, "ry": 8.0}, # Watchtower
    {"x": 50, "y": 12.4, "rx": 7.2, "ry": 5.4}, # High Hall
    {"x": 25, "y": 20.5, "rx": 5.8, "ry": 4.5}, # Temple
    {"x": 75, "y": 19.7, "rx": 5.3, "ry": 5.2}, # Forge
    {"x": 62, "y": 60.4, "rx": 6.1, "ry": 4.6}, # Stables
]

# Fixed residential plots are shared by the renderer and navigation system.
CITY_HOUSES = [
    {"x": 31.1, "y": 54.9, "roof": "#594337", "scale": 0.82},
    {"x": 74.0, "y": 33.1, "roof": "#674b3b", "scale": 0.9},
    {"x": 81.5, "y": 53.3, "roof": "#4e4b43", "scale": 0.98},
    {"x": 28.6, "y": 68.2, "roof": "#76533a", "scale": 0.82},
    {"x": 17.4, "y": 53.8, "roof": "#594337", "scale": 0.82},
    {"x": 39.9, "y": 17.0, "roof": "#674b3b", "scale": 0.9},
    {"x": 60.1, "y": 17.0, "roof": "#4e4b43", "scale": 0.9},
    {"x": 20.3, "y": 32.8, "roof": "#76533a", "scale": 0.98},
    {"x": 29.7, "y": 17.2, "roof": "#594337", "scale": 0.98},
    {"x": 70.1, "y": 16.3, "roof": "#674b3b", "scale": 0.82},
    {"x": 79.9, "y": 31.7, "roof": "#4e4b43", "scale": 0.9},
    {"x": 53.9, "y": 68.1, "roof": "#76533a", "scale": 0.98},
]

WALK_SPEED = 1.4
FLEE_SPEED = 2.8
DWELL_RANGE = (12, 35)
FLEE_CHANCE = 0.004
MEMORY_AVOID_TICKS = 80

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
