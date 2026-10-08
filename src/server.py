from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import queries, analytics
from .db import SHARD_LABELS, shard_index
from .engine import engine
from .models import (
    WORLD_W, WORLD_H, ZONES, ACTIVITY_COLORS,
    CITY_HOUSES, MAX_TICKS, TICK_SECONDS, METERS_PER_UNIT,
    DEFAULT_NPC_COUNT, MAX_NPCS,
    GAME_MINUTES_PER_TICK, GAME_START_MINUTES, ROLE_SCHEDULES,
)
from .writer import write_performance

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="EchoWorld")


def check_npc(npc_id):
    if npc_id not in engine.npc_ids:
        raise HTTPException(status_code=404, detail="Unknown NPC")


@app.get("/api/meta")
def meta():
    return {
        "run_id": engine.run_id,
        "seed": engine.seed,
        "world": {"w": WORLD_W, "h": WORLD_H, "meters_per_unit": METERS_PER_UNIT},
        "zones": ZONES,
        "houses": CITY_HOUSES,
        "activities": ACTIVITY_COLORS,
        "npc_count": engine.npc_count,
        "default_npc_count": DEFAULT_NPC_COUNT,
        "max_npcs": MAX_NPCS,
        "npcs": [
            {
                "id": npc_id, "name": engine.npc_names[npc_id],
                "role": engine.npc_roles[npc_id], "shard": SHARD_LABELS[shard_index(npc_id)],
                "schedule": {
                    **ROLE_SCHEDULES[engine.npc_roles[npc_id]],
                    "home": f"House {index % len(CITY_HOUSES) + 1}",
                },
            }
            for index, npc_id in enumerate(engine.npc_ids)
        ],
        "max_ticks": MAX_TICKS,
        "tick_seconds": TICK_SECONDS,
        "game_time": {
            "minutes_per_tick": GAME_MINUTES_PER_TICK,
            "start_minutes": GAME_START_MINUTES,
        },
    }


@app.get("/api/stats")
def stats():
    data = queries.stats()
    data.update({
        "run_id": engine.run_id,
        "seed": engine.seed,
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
def sim_reset(seed: str | None = Query(None, max_length=64)):
    engine.reset(seed)
    return {"running": engine.running, "tick": engine.tick, "run_id": engine.run_id, "seed": engine.seed}


@app.post("/api/sim/new_run")
def sim_new_run(seed: str | None = Query(None, max_length=64)):
    engine.new_run(seed)
    return {
        "running": engine.running, "tick": engine.tick, "run_id": engine.run_id,
        "seed": engine.seed, "npc_count": engine.npc_count,
    }


@app.post("/api/sim/configure")
def sim_configure(
    npcs: int = Query(..., ge=DEFAULT_NPC_COUNT, le=MAX_NPCS),
    seed: str | None = Query(None, max_length=64),
):
    engine.configure_npcs(npcs, seed)
    return {
        "running": engine.running, "tick": engine.tick, "npc_count": engine.npc_count,
        "run_id": engine.run_id, "seed": engine.seed,
    }


@app.post("/api/sim/fast_forward")
def sim_fast_forward(ticks: int = Query(300, ge=1, le=MAX_TICKS)):
    engine.fast_forward(ticks)
    return {"running": engine.running, "tick": engine.tick}


@app.get("/api/live")
def live():
    return queries.live_snapshot(engine.npc_ids)


@app.get("/api/frames")
def frames(
    start: int = Query(1, ge=1), end: int = Query(MAX_TICKS, ge=1),
    run_id: str | None = None,
):
    return queries.frames(start, end, run_id or engine.run_id)


@app.get("/api/runs")
def runs():
    return {"runs": queries.run_catalog(engine.run_id, engine.seed, engine.npc_count, engine.tick)}


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
    return queries.index_benchmark(x, y, radius, run_id=engine.run_id)


@app.get("/api/scalability")
def scalability():
    distribution = queries.shard_distribution(engine.run_id)
    return {
        "run_id": engine.run_id,
        "seed": engine.seed,
        "npc_count": engine.npc_count,
        "tick": engine.tick,
        "records_by_shard": distribution,
        "records_total": sum(distribution.values()),
        "write": write_performance(engine.run_id),
    }


@app.get("/api/anomalies")
def anomalies():
    return analytics.find_anomalies(engine.run_id, engine.npc_ids, engine.npc_names)


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
