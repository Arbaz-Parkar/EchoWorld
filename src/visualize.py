import matplotlib.pyplot as plt
from matplotlib.widgets import Slider, Button
from matplotlib.animation import FuncAnimation
from matplotlib.lines import Line2D

ACTIVITY_COLORS = {
    "patrolling": "#1f77b4",
    "idle": "#7f7f7f",
    "trading": "#2ca02c",
    "fighting": "#d62728",
    "fleeing": "#ff7f0e",
}


def load_history_by_tick(history_col, npc_ids, num_ticks):
    by_tick = {t: {} for t in range(1, num_ticks + 1)}
    for doc in history_col.find({}, {"_id": 0, "npc_id": 1, "tick": 1, "location": 1, "activity": 1}):
        t = doc["tick"]
        if t in by_tick:
            x, y = doc["location"]["coordinates"]
            by_tick[t][doc["npc_id"]] = {"x": x, "y": y, "activity": doc["activity"]}
    return by_tick


def build_viewer(history_col, npc_ids, world_x, world_y, num_ticks):
    data_by_tick = load_history_by_tick(history_col, npc_ids, num_ticks)

    trails = {npc_id: {"x": [], "y": []} for npc_id in npc_ids}
    for t in range(1, num_ticks + 1):
        for npc_id in npc_ids:
            info = data_by_tick[t].get(npc_id)
            if info:
                trails[npc_id]["x"].append(info["x"])
                trails[npc_id]["y"].append(info["y"])

    fig, ax = plt.subplots(figsize=(10, 8))
    plt.subplots_adjust(bottom=0.2)

    for npc_id in npc_ids:
        ax.plot(trails[npc_id]["x"], trails[npc_id]["y"], color="lightgray", alpha=0.4, linewidth=1, zorder=1)

    scat = ax.scatter([], [], s=80, picker=5, zorder=3)

    info_box = ax.text(0.02, 0.98, "Click an NPC to see details", transform=ax.transAxes,
                        va="top", ha="left", fontsize=9,
                        bbox=dict(boxstyle="round", facecolor="white", alpha=0.85))

    ax.set_xlim(world_x)
    ax.set_ylim(world_y)
    ax.set_title("EchoWorld: NPC Simulation Playback")
    ax.set_aspect("equal", adjustable="box")

    legend_handles = [
        Line2D([0], [0], marker="o", color="w", markerfacecolor=color, markersize=8, label=activity)
        for activity, color in ACTIVITY_COLORS.items()
    ]
    ax.legend(handles=legend_handles, loc="upper right", title="Activity", fontsize=8)

    state = {"tick": 1}

    def draw_tick(tick):
        tick = int(tick)
        state["tick"] = tick
        frame = data_by_tick.get(tick, {})
        xs, ys, colors, ids = [], [], [], []
        for npc_id in npc_ids:
            info = frame.get(npc_id)
            if info:
                xs.append(info["x"])
                ys.append(info["y"])
                colors.append(ACTIVITY_COLORS.get(info["activity"], "black"))
                ids.append(npc_id)
        scat.set_offsets(list(zip(xs, ys)) if xs else [])
        scat.set_color(colors)
        scat.ids = ids
        ax.set_title(f"EchoWorld: NPC Simulation Playback — Tick {tick}/{num_ticks}")
        fig.canvas.draw_idle()

    draw_tick(1)

    ax_slider = plt.axes([0.2, 0.06, 0.6, 0.03])
    tick_slider = Slider(ax_slider, "Tick", 1, num_ticks, valinit=1, valstep=1)
    tick_slider.on_changed(draw_tick)

    ax_button = plt.axes([0.82, 0.05, 0.1, 0.05])
    play_button = Button(ax_button, "Play")
    playing = {"on": False}

    def toggle_play(event):
        playing["on"] = not playing["on"]
        play_button.label.set_text("Pause" if playing["on"] else "Play")

    play_button.on_clicked(toggle_play)

    def advance(frame):
        if playing["on"]:
            next_tick = state["tick"] + 1
            if next_tick > num_ticks:
                next_tick = 1
            tick_slider.set_val(next_tick)
        return (scat,)

    anim = FuncAnimation(fig, advance, interval=150, blit=False, cache_frame_data=False)

    def on_pick(event):
        idx = event.ind[0]
        npc_id = scat.ids[idx]
        info = data_by_tick[state["tick"]].get(npc_id)
        if info:
            info_box.set_text(
                f"{npc_id}\nTick: {state['tick']}\nActivity: {info['activity']}\n"
                f"Position: ({info['x']:.1f}, {info['y']:.1f})"
            )
            fig.canvas.draw_idle()

    fig.canvas.mpl_connect("pick_event", on_pick)
    return fig, ax, anim