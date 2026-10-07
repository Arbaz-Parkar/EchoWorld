from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import queries, analytics
from .db import SHARD_LABELS, shard_index
from .engine import engine
from .models import (
    NPC_IDS, NPC_NAMES, NPC_ROLES, WORLD_W, WORLD_H, ZONES, ACTIVITY_COLORS,
    MAX_TICKS, TICK_SECONDS, METERS_PER_UNIT,
)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="EchoWorld")


def check_npc(npc_id):
    if npc_id not in NPC_IDS:
        raise HTTPException(status_code=404, detail="Unknown NPC")


@app.get("/api/meta")
def meta():
    return {
        "run_id": engine.run_id,
        "world": {"w": WORLD_W, "h": WORLD_H, "meters_per_unit": METERS_PER_UNIT},
        "zones": ZONES,
        "activities": ACTIVITY_COLORS,
        "npcs": [
            {"id": i, "name": NPC_NAMES[i], "role": NPC_ROLES[i], "shard": SHARD_LABELS[shard_index(i)]}
            for i in NPC_IDS
        ],
        "max_ticks": MAX_TICKS,
        "tick_seconds": TICK_SECONDS,
    }


@app.get("/api/stats")
def stats():
    data = queries.stats()
    data.update({
        "run_id": engine.run_id,
        "running": engine.running,
        "tick": engine.tick,
        "max_ticks": MAX_TICKS,
    })
    return data


@app.post("/api/sim/start")
def sim_start():
    engine.start()
    return {"running": engine.running, "tick": engine.tick}


@app.post("/api/sim/pause")
def sim_pause():
    engine.pause()
    return {"running": engine.running, "tick": engine.tick}


@app.post("/api/sim/reset")
def sim_reset():
    engine.reset()
    return {"running": engine.running, "tick": engine.tick}


@app.post("/api/sim/fast_forward")
def sim_fast_forward(ticks: int = Query(300, ge=1, le=MAX_TICKS)):
    engine.fast_forward(ticks)
    return {"running": engine.running, "tick": engine.tick}


@app.get("/api/live")
def live():
    return queries.live_snapshot()


@app.get("/api/frames")
def frames(start: int = Query(1, ge=1), end: int = Query(MAX_TICKS, ge=1)):
    return queries.frames(start, end, engine.run_id)


@app.get("/api/npc/{npc_id}")
def npc(npc_id: str):
    check_npc(npc_id)
    return queries.npc_profile(npc_id, engine.run_id)


@app.get("/api/memory")
def memory(npc: str, t_from: int = Query(1, ge=1), t_to: int = Query(MAX_TICKS, ge=1)):
    check_npc(npc)
    return queries.memory(npc, t_from, t_to, engine.run_id)


@app.get("/api/nearby")
def nearby(
    x: float, y: float,
    radius: float = Query(10, ge=1, le=60),
    t_from: int = Query(1, ge=1), t_to: int = Query(MAX_TICKS, ge=1),
):
    return queries.nearby(x, y, radius, t_from, t_to, engine.run_id)


@app.get("/api/index_benchmark")
def index_benchmark(x: float, y: float, radius: float = Query(10, ge=1, le=60)):
    return queries.index_benchmark(x, y, radius)


@app.get("/api/anomalies")
def anomalies():
    return analytics.find_anomalies(engine.run_id)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
