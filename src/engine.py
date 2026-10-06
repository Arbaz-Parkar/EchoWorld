import math
import random
import threading
import time

from .models import (
    NPC_IDS, WORLD_W, WORLD_H, ZONES, WALK_SPEED, FLEE_SPEED, DWELL_RANGE,
    FLEE_CHANCE, MAX_TICKS, TICK_SECONDS, RANDOM_SEED, ANOMALY_NPC, ANOMALY_TICK,
    NPC_ROLES,
)
from .writer import write_frame
from .db import reset_all

ZONE_BY_NAME = {z["name"]: z for z in ZONES}


def clamp(value, low, high):
    return max(low, min(high, value))


def zone_at(x, y):
    for z in ZONES:
        if math.hypot(x - z["x"], y - z["y"]) <= z["r"]:
            return z["name"]
    return None


class Engine:
    def __init__(self):
        self.lock = threading.Lock()
        self.running = False
        self.thread = None
        self.tick = 0
        self._init_state()

    def _init_state(self):
        self.rng = random.Random(RANDOM_SEED)
        self.tick = 0
        self.npcs = []
        for npc_id in NPC_IDS:
            zone = ZONE_BY_NAME[NPC_ROLES[npc_id]]
            self.npcs.append({
                "id": npc_id,
                "x": round(zone["x"] + self.rng.uniform(-zone["r"] / 2, zone["r"] / 2), 2),
                "y": round(zone["y"] + self.rng.uniform(-zone["r"] / 2, zone["r"] / 2), 2),
                "activity": zone["activity"],
                "zone": zone["name"],
                "target": None,
                "mode": "dwell",
                "timer": self.rng.randint(*DWELL_RANGE),
                "vx": 0.0, "vy": 0.0, "flee_left": 0,
            })

    def _pick_target(self, current_zone):
        options = [z for z in ZONES if z["name"] != current_zone]
        return self.rng.choice(options)["name"]

    def _start_flee(self, n):
        angle = self.rng.uniform(0, 2 * math.pi)
        n["mode"] = "flee"
        n["vx"] = math.cos(angle) * FLEE_SPEED
        n["vy"] = math.sin(angle) * FLEE_SPEED
        n["flee_left"] = self.rng.randint(5, 9)
        n["activity"] = "fleeing"
        n["target"] = None

    def _step_npc(self, n):
        rng = self.rng

        if n["mode"] == "flee":
            n["x"] = clamp(n["x"] + n["vx"], 0, WORLD_W)
            n["y"] = clamp(n["y"] + n["vy"], 0, WORLD_H)
            n["flee_left"] -= 1
            n["zone"] = zone_at(n["x"], n["y"])
            n["activity"] = "fleeing"
            if n["flee_left"] <= 0:
                n["mode"] = "travel"
                n["target"] = self._pick_target(n["zone"])
            return

        if n["mode"] == "dwell":
            zone = ZONE_BY_NAME[n["zone"]]
            n["x"] = clamp(n["x"] + rng.uniform(-0.4, 0.4), 0, WORLD_W)
            n["y"] = clamp(n["y"] + rng.uniform(-0.4, 0.4), 0, WORLD_H)
            n["activity"] = zone["activity"]
            n["timer"] -= 1
            if n["timer"] <= 0:
                n["mode"] = "travel"
                n["target"] = self._pick_target(n["zone"])
                n["activity"] = "walking"
            elif rng.random() < FLEE_CHANCE:
                self._start_flee(n)
            return

        target = ZONE_BY_NAME[n["target"]]
        dx = target["x"] - n["x"]
        dy = target["y"] - n["y"]
        dist = math.hypot(dx, dy)
        if dist <= target["r"] * 0.5:
            n["mode"] = "dwell"
            n["zone"] = target["name"]
            n["target"] = None
            n["timer"] = rng.randint(*DWELL_RANGE)
            n["activity"] = target["activity"]
        else:
            step = min(WALK_SPEED, dist)
            n["x"] = clamp(n["x"] + dx / dist * step + rng.uniform(-0.25, 0.25), 0, WORLD_W)
            n["y"] = clamp(n["y"] + dy / dist * step + rng.uniform(-0.25, 0.25), 0, WORLD_H)
            n["zone"] = zone_at(n["x"], n["y"])
            n["activity"] = "walking"
            if rng.random() < FLEE_CHANCE:
                self._start_flee(n)

    def _advance_one(self):
        with self.lock:
            self.tick += 1
            for n in self.npcs:
                if n["id"] == ANOMALY_NPC and self.tick == ANOMALY_TICK:
                    # Deliberate glitch: a sudden teleport, so the anomaly
                    # detector has something real to catch.
                    n["x"] = round(self.rng.uniform(0, WORLD_W), 2)
                    n["y"] = round(self.rng.uniform(0, WORLD_H), 2)
                    n["zone"] = zone_at(n["x"], n["y"])
                    n["mode"] = "travel"
                    n["target"] = self._pick_target(n["zone"])
                    n["activity"] = "walking"
                else:
                    self._step_npc(n)
                n["x"] = round(n["x"], 2)
                n["y"] = round(n["y"], 2)
            frame = [
                {"id": n["id"], "x": n["x"], "y": n["y"], "activity": n["activity"],
                 "zone": n["zone"], "target": n["target"]}
                for n in self.npcs
            ]
            write_frame(self.tick, frame)

    def _loop(self):
        while self.running and self.tick < MAX_TICKS:
            started = time.time()
            self._advance_one()
            time.sleep(max(0.0, TICK_SECONDS - (time.time() - started)))
        self.running = False

    def start(self):
        if self.running or self.tick >= MAX_TICKS:
            return
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def pause(self):
        self.running = False
        if self.thread:
            self.thread.join(timeout=2)

    def reset(self):
        self.pause()
        with self.lock:
            reset_all()
            self._init_state()

    def fast_forward(self, ticks):
        if self.running:
            return
        for _ in range(ticks):
            if self.tick >= MAX_TICKS:
                break
            self._advance_one()


engine = Engine()
