import heapq
import math
import random
import secrets
import threading
import time
import uuid

from .models import (
    WORLD_W, WORLD_H, ZONES, CITY_BLOCKERS, CITY_HOUSES,
    WALK_SPEED, FLEE_SPEED, DWELL_RANGE, FLEE_CHANCE, MAX_TICKS,
    TICK_SECONDS, ANOMALY_NPC, ANOMALY_TICK,
    DEFAULT_NPC_COUNT, MAX_NPCS, make_npc_roster,
    GAME_MINUTES_PER_TICK, GAME_START_MINUTES, ROLE_SCHEDULES,
)
from .writer import write_frame
from .db import reset_all, clear_live_state
from .queries import behavioral_memory

ZONE_BY_NAME = {z["name"]: z for z in ZONES}
NAV_STEP = 0.5
NAV_MAX_X = round(WORLD_W / NAV_STEP)
NAV_MAX_Y = round(WORLD_H / NAV_STEP)
CITY_CENTER = (WORLD_W / 2, WORLD_H / 2)


def clamp(value, low, high):
    return max(low, min(high, value))


def zone_at(x, y):
    for z in ZONES:
        if math.hypot(x - z["x"], y - z["y"]) <= z["r"]:
            return z["name"]
    return None


def _inside_city(x, y):
    return ((x - 50) / 45) ** 2 + ((y - 40) / 34) ** 2 <= 1


def _point_blocked(x, y):
    if x < 0 or x > WORLD_W or y < 0 or y > WORLD_H:
        return True
    wall_distance = math.sqrt(((x - 50) / 45) ** 2 + ((y - 40) / 34) ** 2)
    at_south_gate = abs(x - 50) <= 2.5 and y >= 70
    if 0.975 <= wall_distance <= 1.04 and not at_south_gate:
        return True
    for block in CITY_BLOCKERS:
        rx, ry = block["rx"] + 0.28, block["ry"] + 0.28
        if ((x - block["x"]) / rx) ** 2 + ((y - block["y"]) / ry) ** 2 < 1:
            return True
    for house in CITY_HOUSES:
        rx, ry = 2.65 * house["scale"] + 0.25, 2.05 * house["scale"] + 0.25
        if ((x - house["x"]) / rx) ** 2 + ((y - (house["y"] - 1.5)) / ry) ** 2 < 1:
            return True
    return False


BLOCKED_CELLS = frozenset(
    (ix, iy)
    for iy in range(NAV_MAX_Y + 1)
    for ix in range(NAV_MAX_X + 1)
    if _point_blocked(ix * NAV_STEP, iy * NAV_STEP)
)


def _crosses_city_wall(ax, ay, bx, by):
    if _inside_city(ax, ay) == _inside_city(bx, by):
        return False
    gate_x = (ax + bx) / 2
    gate_y = (ay + by) / 2
    return not (abs(gate_x - 50) <= 2.5 and gate_y >= 70)


def _can_walk_segment(start, end):
    distance = math.hypot(end[0] - start[0], end[1] - start[1])
    steps = max(1, math.ceil(distance / 0.2))
    previous = start
    for i in range(1, steps + 1):
        ratio = i / steps
        point = (
            start[0] + (end[0] - start[0]) * ratio,
            start[1] + (end[1] - start[1]) * ratio,
        )
        if _point_blocked(*point) or _crosses_city_wall(*previous, *point):
            return False
        previous = point
    return True


def _zone_stand_point(zone):
    # Landmarks sit on the north side of each district; NPCs gather at the
    # open apron on their south side, beside the visible local street.
    return zone["x"], zone["y"] + zone["r"] * 0.42


def _route_control(zone, start):
    hub_x, hub_y = CITY_CENTER
    dx, dy = hub_x - zone["x"], hub_y - zone["y"]
    length = math.hypot(dx, dy) or 1
    bend = -2.4 if zone["x"] < hub_x else 2.4
    return (
        (start[0] + hub_x) / 2 - dy / length * bend,
        (start[1] + hub_y) / 2 + dx / length * bend,
    )


def _build_road_cells():
    road_cells = set()
    spread = 1.75
    cell_radius = math.ceil(spread / NAV_STEP)
    offsets = [
        (ox, oy)
        for oy in range(-cell_radius, cell_radius + 1)
        for ox in range(-cell_radius, cell_radius + 1)
        if math.hypot(ox * NAV_STEP, oy * NAV_STEP) <= spread
    ]

    def mark(x, y):
        ix, iy = round(x / NAV_STEP), round(y / NAV_STEP)
        for ox, oy in offsets:
            cell = ix + ox, iy + oy
            if 0 <= cell[0] <= NAV_MAX_X and 0 <= cell[1] <= NAV_MAX_Y:
                road_cells.add(cell)

    hub_x, hub_y = CITY_CENTER
    for zone in ZONES:
        start = zone["x"], zone["y"] + zone["r"] * 0.8
        control = _route_control(zone, start)
        for i in range(201):
            t = i / 200
            inverse = 1 - t
            x = inverse * inverse * start[0] + 2 * inverse * t * control[0] + t * t * hub_x
            y = inverse * inverse * start[1] + 2 * inverse * t * control[1] + t * t * hub_y
            mark(x, y)
        for i in range(21):
            t = i / 20
            mark(zone["x"], zone["y"] + zone["r"] * (0.8 - 0.38 * t))

    for i in range(481):
        angle = i / 480 * math.tau
        mark(hub_x + math.cos(angle) * 22, hub_y + math.sin(angle) * 16)

    # Main street connects the plaza to the south gate.
    for i in range(161):
        t = i / 160
        inverse = 1 - t
        x = inverse**3 * 50 + 3 * inverse**2 * t * 48.8 + 3 * inverse * t**2 * 51.2 + t**3 * 50
        y = inverse**3 * 73 + 3 * inverse**2 * t * 63 + 3 * inverse * t**2 * 53 + t**3 * 44
        mark(x, y)
    return road_cells


ROAD_CELLS = _build_road_cells()


def _grid_point(cell):
    return cell[0] * NAV_STEP, cell[1] * NAV_STEP


def _grid_cell(point):
    return (
        round(clamp(point[0], 0, WORLD_W) / NAV_STEP),
        round(clamp(point[1], 0, WORLD_H) / NAV_STEP),
    )


def _grid_blocked(cell):
    return cell in BLOCKED_CELLS


def _nearest_open_cell(point):
    origin = _grid_cell(point)
    if not _grid_blocked(origin):
        return origin
    for radius in range(1, 25):
        candidates = []
        for oy in range(-radius, radius + 1):
            for ox in range(-radius, radius + 1):
                if max(abs(ox), abs(oy)) != radius:
                    continue
                cell = origin[0] + ox, origin[1] + oy
                if 0 <= cell[0] <= NAV_MAX_X and 0 <= cell[1] <= NAV_MAX_Y and not _grid_blocked(cell):
                    candidates.append(cell)
        if candidates:
            return min(candidates, key=lambda cell: math.dist(_grid_point(cell), point))
    return None


def _find_path(start, goal):
    start_cell = _nearest_open_cell(start)
    goal_cell = _nearest_open_cell(goal)
    if start_cell is None or goal_cell is None:
        return []

    directions = [
        (-1, -1), (0, -1), (1, -1),
        (-1, 0),             (1, 0),
        (-1, 1),  (0, 1),   (1, 1),
    ]
    open_heap = []
    sequence = 0
    heapq.heappush(open_heap, (math.dist(start_cell, goal_cell) * NAV_STEP, 0.0, sequence, start_cell))
    came_from = {}
    scores = {start_cell: 0.0}
    closed = set()

    while open_heap:
        _, current_cost, _, current = heapq.heappop(open_heap)
        if current in closed:
            continue
        if current == goal_cell:
            break
        closed.add(current)
        current_point = _grid_point(current)

        for ox, oy in directions:
            neighbor = current[0] + ox, current[1] + oy
            if not (0 <= neighbor[0] <= NAV_MAX_X and 0 <= neighbor[1] <= NAV_MAX_Y):
                continue
            if _grid_blocked(neighbor):
                continue
            neighbor_point = _grid_point(neighbor)
            if _crosses_city_wall(*current_point, *neighbor_point):
                continue
            if ox and oy and (_grid_blocked((current[0] + ox, current[1])) or _grid_blocked((current[0], current[1] + oy))):
                continue

            distance = NAV_STEP * (math.sqrt(2) if ox and oy else 1)
            if neighbor in ROAD_CELLS:
                terrain_cost = 1.0
            elif _inside_city(*neighbor_point):
                terrain_cost = 2.8
            else:
                terrain_cost = 1.25
            tentative = current_cost + distance * terrain_cost
            if tentative >= scores.get(neighbor, math.inf):
                continue
            came_from[neighbor] = current
            scores[neighbor] = tentative
            heuristic = math.dist(neighbor, goal_cell) * NAV_STEP
            sequence += 1
            heapq.heappush(open_heap, (tentative + heuristic, tentative, sequence, neighbor))

    if goal_cell not in scores:
        return []

    cells = [goal_cell]
    while cells[-1] != start_cell:
        cells.append(came_from[cells[-1]])
    cells.reverse()

    points = [start]
    points.extend(_grid_point(cell) for cell in cells[1:])
    if math.dist(points[-1], goal) > 0.05:
        points.append(goal)
    return points


class Engine:
    def __init__(self, npc_count=DEFAULT_NPC_COUNT, seed=None):
        self.lock = threading.Lock()
        self.operation_lock = threading.Lock()
        self.running = False
        self.thread = None
        self.tick = 0
        self.set_npc_count(npc_count)
        self._init_state(seed)

    def set_npc_count(self, npc_count):
        self.npc_count = npc_count
        self.npc_ids, self.npc_names, self.npc_roles = make_npc_roster(npc_count)

    def _init_state(self, seed=None):
        # Keep equal tick numbers from separate process runs in separate histories.
        self.run_id = uuid.uuid4().hex
        seed_text = str(seed).strip() if seed is not None else ""
        self.seed = seed_text or secrets.token_hex(8)
        self.rng = random.Random(self.seed)
        self.tick = 0
        self.npcs = []
        for index, npc_id in enumerate(self.npc_ids):
            zone = ZONE_BY_NAME[self.npc_roles[npc_id]]
            x, y = self._initial_position(zone)
            house = CITY_HOUSES[index % len(CITY_HOUSES)]
            home_cell = _nearest_open_cell((house["x"], house["y"] + 3.0 * house["scale"]))
            home = _grid_point(home_cell) if home_cell else _zone_stand_point(zone)
            self.npcs.append({
                "id": npc_id,
                "x": round(x, 2),
                "y": round(y, 2),
                "activity": zone["activity"],
                "routine": None,
                "zone": zone["name"],
                "target": None,
                "home": home,
                "decision_note": "Still learning the city; the first recorded choices will shape future visits.",
                "incident_zone": None,
                "incident_tick": None,
                "mode": "dwell",
                "timer": self.rng.randint(*DWELL_RANGE),
                "path": [],
                "path_index": 0,
                "vx": 0.0, "vy": 0.0, "flee_left": 0,
            })

    def _initial_position(self, zone):
        for _ in range(100):
            x = zone["x"] + self.rng.uniform(-zone["r"] * 0.34, zone["r"] * 0.34)
            y = zone["y"] + self.rng.uniform(zone["r"] * 0.25, zone["r"] * 0.46)
            if not _point_blocked(x, y) and _inside_city(x, y):
                return x, y
        return _zone_stand_point(zone)

    def _random_walkable_position(self, far_from=None):
        for _ in range(1000):
            point = self.rng.uniform(1, WORLD_W - 1), self.rng.uniform(1, WORLD_H - 1)
            if _point_blocked(*point):
                continue
            if far_from and math.dist(point, far_from) < 12:
                continue
            return point
        return WORLD_W / 2, WORLD_H / 2

    def _pick_target(self, n):
        memory = behavioral_memory(n["id"], self.run_id, self.tick)
        visits = memory["visits"]
        current_zone = n["zone"]
        options = [z for z in ZONES if z["name"] != current_zone]
        avoided_zone = memory["avoided_zone"]
        if avoided_zone:
            safer_options = [z for z in options if z["name"] != avoided_zone]
            if safer_options:
                options = safer_options

        weights = [1 + min(6, visits.get(z["name"], 0)) * 0.55 for z in options]
        choice = self.rng.choices(options, weights=weights, k=1)[0]
        previous_visits = visits.get(choice["name"], 0)
        if previous_visits:
            note = (
                f"Returning to {choice['name']} after {previous_visits} recorded visit(s); "
                "familiar districts have better odds."
            )
        else:
            note = f"Exploring {choice['name']}; familiar districts still have better odds."
        if avoided_zone:
            note += f" Avoiding {avoided_zone} after a scare at tick {memory['last_incident_tick']}."
        return choice["name"], note

    def _assign_target(self, n, target_name, note):
        n["target"] = target_name
        n["decision_note"] = note
        goal = _zone_stand_point(ZONE_BY_NAME[target_name])
        n["path"] = _find_path((n["x"], n["y"]), goal)
        n["path_index"] = 1 if len(n["path"]) > 1 else 0

    def _start_flee(self, n):
        angle = self.rng.uniform(0, 2 * math.pi)
        n["mode"] = "flee"
        n["vx"] = math.cos(angle) * FLEE_SPEED
        n["vy"] = math.sin(angle) * FLEE_SPEED
        n["flee_left"] = self.rng.randint(5, 9)
        n["activity"] = "fleeing"
        n["incident_zone"] = n["zone"]
        n["incident_tick"] = self.tick
        n["target"] = None
        n["path"] = []
        n["path_index"] = 0

    def _step_flee(self, n):
        origin = (n["x"], n["y"])
        candidates = [math.atan2(n["vy"], n["vx"])]
        candidates.extend(candidates[0] + offset for offset in (math.pi / 4, -math.pi / 4, math.pi / 2, -math.pi / 2, math.pi))
        for angle in candidates:
            candidate = (
                clamp(n["x"] + math.cos(angle) * FLEE_SPEED, 0, WORLD_W),
                clamp(n["y"] + math.sin(angle) * FLEE_SPEED, 0, WORLD_H),
            )
            if _can_walk_segment(origin, candidate):
                n["x"], n["y"] = candidate
                n["vx"], n["vy"] = math.cos(angle) * FLEE_SPEED, math.sin(angle) * FLEE_SPEED
                break

        n["flee_left"] -= 1
        n["zone"] = zone_at(n["x"], n["y"])
        n["activity"] = "fleeing"
        if n["flee_left"] <= 0:
            n["mode"] = "travel"
            target_name, note = self._pick_target(n)
            self._assign_target(n, target_name, note)

    def _move_on_path(self, n, distance):
        path = n["path"]
        index = n["path_index"]
        while index < len(path) and distance > 0:
            destination = path[index]
            current = (n["x"], n["y"])
            dx, dy = destination[0] - n["x"], destination[1] - n["y"]
            remaining = math.hypot(dx, dy)
            if remaining < 0.03:
                n["x"], n["y"] = destination
                index += 1
                continue
            step = min(distance, remaining)
            next_point = (n["x"] + dx / remaining * step, n["y"] + dy / remaining * step)
            if not _can_walk_segment(current, next_point):
                n["path"] = []
                n["path_index"] = 0
                return
            n["x"], n["y"] = next_point
            distance -= step
            if step >= remaining - 0.03:
                n["x"], n["y"] = destination
                index += 1
            else:
                break
        n["path_index"] = index

    def _minute_in_window(self, minute, start, end):
        if start < end:
            return start <= minute < end
        return minute >= start or minute < end

    def _routine_at_current_time(self, n):
        minute = (GAME_START_MINUTES + self.tick * GAME_MINUTES_PER_TICK) % (24 * 60)
        schedule = ROLE_SCHEDULES[self.npc_roles[n["id"]]]
        if self._minute_in_window(minute, schedule["sleep_start"], schedule["sleep_end"]):
            return "sleep"
        if self._minute_in_window(minute, schedule["work_start"], schedule["work_end"]):
            return "work"
        return "leisure"

    def _begin_routine(self, n, routine):
        n["routine"] = routine
        if routine == "sleep":
            n["target"] = "Home"
            n["decision_note"] = "Heading home for the scheduled sleep period."
            n["path"] = _find_path((n["x"], n["y"]), n["home"])
            n["path_index"] = 1 if len(n["path"]) > 1 else 0
            n["mode"] = "travel"
            n["activity"] = "walking"
        elif routine == "work":
            target_name = self.npc_roles[n["id"]]
            self._assign_target(n, target_name, f"Reporting for the scheduled {target_name} shift.")
            n["mode"] = "travel"
            n["activity"] = "walking"
        else:
            target_name, note = self._pick_target(n)
            self._assign_target(n, target_name, note)
            n["mode"] = "travel"
            n["activity"] = "walking"

    def _step_scheduled_travel(self, n, target_name, goal, arrival_activity, arrival_zone):
        if math.dist((n["x"], n["y"]), goal) <= 0.65:
            n["x"], n["y"] = goal
            n["mode"] = "dwell"
            n["zone"] = arrival_zone
            n["target"] = None
            n["path"] = []
            n["path_index"] = 0
            n["activity"] = arrival_activity
            return

        if n["target"] != target_name or not n["path"] or n["path_index"] >= len(n["path"]):
            n["target"] = target_name
            n["path"] = _find_path((n["x"], n["y"]), goal)
            n["path_index"] = 1 if len(n["path"]) > 1 else 0
        self._move_on_path(n, WALK_SPEED)
        n["zone"] = zone_at(n["x"], n["y"])
        n["activity"] = "walking"

    def _step_npc(self, n):
        rng = self.rng

        if n["mode"] == "flee":
            self._step_flee(n)
            return

        routine = self._routine_at_current_time(n)
        if routine != n["routine"]:
            self._begin_routine(n, routine)

        if routine == "sleep":
            self._step_scheduled_travel(n, "Home", n["home"], "sleeping", None)
            return
        if routine == "work":
            zone = ZONE_BY_NAME[self.npc_roles[n["id"]]]
            self._step_scheduled_travel(
                n, zone["name"], _zone_stand_point(zone), zone["activity"], zone["name"],
            )
            return

        if n["mode"] == "dwell":
            zone = ZONE_BY_NAME[n["zone"]]
            candidate = (
                clamp(n["x"] + rng.uniform(-0.4, 0.4), 0, WORLD_W),
                clamp(n["y"] + rng.uniform(-0.4, 0.4), 0, WORLD_H),
            )
            if _can_walk_segment((n["x"], n["y"]), candidate):
                n["x"], n["y"] = candidate
            n["activity"] = zone["activity"]
            n["timer"] -= 1
            if n["timer"] <= 0:
                target_name, note = self._pick_target(n)
                self._assign_target(n, target_name, note)
                n["mode"] = "travel"
                n["activity"] = "walking"
            elif rng.random() < FLEE_CHANCE:
                self._start_flee(n)
            return

        target_zone = ZONE_BY_NAME[n["target"]]
        goal = _zone_stand_point(target_zone)
        if math.dist((n["x"], n["y"]), goal) <= 0.65:
            n["x"], n["y"] = goal
            n["mode"] = "dwell"
            n["zone"] = target_zone["name"]
            n["target"] = None
            n["path"] = []
            n["path_index"] = 0
            n["timer"] = rng.randint(*DWELL_RANGE)
            n["activity"] = target_zone["activity"]
            return

        if not n["path"] or n["path_index"] >= len(n["path"]):
            n["path"] = _find_path((n["x"], n["y"]), goal)
            n["path_index"] = 1 if len(n["path"]) > 1 else 0
        self._move_on_path(n, WALK_SPEED)
        n["zone"] = zone_at(n["x"], n["y"])
        n["activity"] = "walking"

    def _advance_one(self):
        with self.lock:
            self.tick += 1
            for n in self.npcs:
                if n["id"] == ANOMALY_NPC and self.tick == ANOMALY_TICK:
                    # Deliberate glitch: teleport to another walkable point so
                    # the speed-limit detector has a clear anomaly to catch.
                    n["x"], n["y"] = self._random_walkable_position((n["x"], n["y"]))
                    n["zone"] = zone_at(n["x"], n["y"])
                    n["mode"] = "travel"
                    target_name, note = self._pick_target(n)
                    self._assign_target(n, target_name, note)
                    n["activity"] = "walking"
                else:
                    self._step_npc(n)
                n["x"] = round(n["x"], 2)
                n["y"] = round(n["y"], 2)
            frame = [
                {"id": n["id"], "x": n["x"], "y": n["y"], "activity": n["activity"],
                 "zone": n["zone"], "target": n["target"], "routine": n["routine"],
                 "decision_note": n["decision_note"],
                 "incident_zone": n["incident_zone"],
                 "incident_tick": n["incident_tick"]}
                for n in self.npcs
            ]
            write_frame(self.tick, frame, self.run_id, self.seed)

    def _loop(self):
        while self.running and self.tick < MAX_TICKS:
            started = time.time()
            self._advance_one()
            time.sleep(max(0.0, TICK_SECONDS - (time.time() - started)))
        self.running = False

    def start(self):
        with self.operation_lock:
            if self.running or self.tick >= MAX_TICKS:
                return
            self.running = True
            self.thread = threading.Thread(target=self._loop, daemon=True)
            self.thread.start()

    def pause(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=2)

    def reset(self, seed=None):
        with self.operation_lock:
            self.pause()
            with self.lock:
                reset_all()
                self._init_state(seed)

    def new_run(self, seed=None):
        with self.operation_lock:
            self.pause()
            with self.lock:
                clear_live_state()
                self._init_state(seed)

    def configure_npcs(self, npc_count, seed=None):
        if npc_count < DEFAULT_NPC_COUNT or npc_count > MAX_NPCS:
            raise ValueError(f"NPC count must be between {DEFAULT_NPC_COUNT} and {MAX_NPCS}")
        with self.operation_lock:
            self.pause()
            with self.lock:
                self.set_npc_count(npc_count)
                clear_live_state()
                self._init_state(seed)

    def fast_forward(self, ticks):
        with self.operation_lock:
            if self.running:
                return
            for _ in range(ticks):
                if self.tick >= MAX_TICKS:
                    break
                self._advance_one()


engine = Engine()
