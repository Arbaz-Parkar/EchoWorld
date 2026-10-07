"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  meta: null,
  mode: "live",
  frames: new Map(),
  maxTick: 0,
  playhead: 1,
  playing: false,
  speed: 2,
  live: { tick: 0, target: new Map(), disp: new Map(), trails: new Map(), ms: 0 },
  motion: new Map(),
  npcs: [],
  selected: null,
  profile: null,
  probe: null,
  probeMode: false,
  anomalies: [],
  stats: null,
  showTrails: true,
  lastTs: 0,
  lastPanel: 0,
  lastScanTick: -1,
  tickerPrevLive: new Map(),
  tickerPrevReplayTick: null,
  tickerQueue: [],
  onboardShown: false,
};

const canvas = $("map");
const ctx = canvas.getContext("2d");
let scale = 1;
let dpr = 1;
let pollBusy = false;
let syncBusy = false;

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(path + " -> " + res.status);
  return res.json();
}

function nameOf(id) {
  const n = state.meta.npcs.find((x) => x.id === id);
  return n ? n.name : id;
}

function hueOf(id) {
  const i = state.meta.npcs.findIndex((x) => x.id === id);
  return (i * 30 + 10) % 360;
}

function actColor(a) {
  return state.meta.activities[a] || "#ffffff";
}

/* ---------- plain-language concepts, for non-technical viewers ---------- */

const CONCEPTS = [
  {
    title: "Redis - the character's short-term memory",
    body: "Redis stores only what each character is doing right this second: their position and activity, nothing older. Every update overwrites the last one, so a lookup is always instant, which matters because a real game asks this question for every character, every single frame.",
    analogy: "Think of it like glancing at someone right now. You see where they are this instant, not where they were five minutes ago.",
  },
  {
    title: "MongoDB - the character's permanent memory",
    body: "Every time a character's state changes, a brand new, timestamped record is added to MongoDB. Nothing is ever overwritten, so the complete history of every character is always there to search by time or by place.",
    analogy: "Think of it like a diary that is never erased, only added to.",
  },
  {
    title: "Why two different databases",
    body: "Redis is built to be read instantly but cannot answer questions about the past. MongoDB can answer questions about the past but is slower to search since it has to look through more data. Using the right tool for each job, instead of forcing one database to do both, is the actual point of this project.",
    analogy: "A sticky note on your desk versus a filing cabinet. You would not file a sticky note, and you would not keep ten years of records on a sticky note.",
  },
  {
    title: "Sharding - splitting the filing cabinet in two",
    body: "Every character's full history always lives on the same one of two shards, decided by their ID. A real system with millions of characters would need far more than two, splitting the data across many servers so no single one is overloaded. This project does it at a tiny, two-shard scale to demonstrate the same idea.",
    analogy: "Like splitting one enormous filing cabinet into two smaller ones, and always knowing exactly which cabinet a given folder is in without having to check both.",
  },
  {
    title: "Geospatial index - searching by location quickly",
    body: "Without an index, finding everyone who was ever near a given spot means checking every single record one by one. The index organises records by location in advance, so that search can skip almost everything irrelevant. The Query Lab tab lets you compare the search with and without this index directly.",
    analogy: "Like the index at the back of a textbook versus reading every page to find one topic.",
  },
];

function renderConcepts() {
  const box = $("conceptCards");
  box.innerHTML = "";
  for (const c of CONCEPTS) {
    const card = document.createElement("div");
    card.className = "concept-card";
    card.innerHTML =
      "<h4>" + c.title + "</h4><p>" + c.body + '</p><p class="analogy">' + c.analogy + "</p>";
    box.appendChild(card);
  }
}

/* ---------- plain-language event ticker ---------- */

function describeEvent(id, prev, curr) {
  const name = nameOf(id);
  if (curr.activity === "fleeing" && (!prev || prev.activity !== "fleeing")) {
    return name + " suddenly ran off.";
  }
  if (prev && prev.activity !== curr.activity) {
    if (curr.activity === "walking" && curr.target) {
      return name + " set off toward the " + curr.target + ".";
    }
    if (curr.zone) {
      return name + " started " + curr.activity + " at the " + curr.zone + ".";
    }
    return name + " started " + curr.activity + ".";
  }
  return null;
}

function queueTicker(text) {
  if (!text) return;
  state.tickerQueue.push(text);
  if (state.tickerQueue.length > 8) state.tickerQueue.shift();
}

function startTickerRotation() {
  const el = $("tickerInner");
  setInterval(() => {
    let text = state.tickerQueue.shift();
    if (!text) {
      text = state.npcs.length
        ? "Characters are going about their day. Click one to see what it remembers."
        : "Press Start or Generate 300 ticks to begin.";
    }
    el.classList.remove("ticker-inner");
    void el.offsetWidth;
    el.classList.add("ticker-inner");
    el.textContent = text;
  }, 2600);
}

function detectLiveEvents(npcs) {
  for (const n of npcs) {
    const prev = state.tickerPrevLive.get(n.id);
    queueTicker(describeEvent(n.id, prev, n));
    state.tickerPrevLive.set(n.id, { activity: n.activity, zone: n.zone, target: n.target });
  }
}

function detectReplayEvents(tick) {
  if (tick < 1 || tick > state.maxTick) return;
  if (state.tickerPrevReplayTick === tick) return;
  const prevTick = state.tickerPrevReplayTick;
  state.tickerPrevReplayTick = tick;
  if (prevTick === null || tick - prevTick !== 1) return;
  const curFrame = state.frames.get(tick);
  const prevFrame = state.frames.get(prevTick);
  if (!curFrame || !prevFrame) return;
  const prevMap = new Map(prevFrame.map((n) => [n.id, n]));
  for (const n of curFrame) {
    queueTicker(describeEvent(n.id, prevMap.get(n.id), n));
  }
}

/* ---------- setup ---------- */

async function init() {
  state.meta = await api("/api/meta");
  buildLegend();
  buildZoneChips();
  buildNpcSelect();
  renderConcepts();
  buildScenery();
  wireEvents();
  updatePlaybackControls();
  wireOnboarding();
  startTickerRotation();
  resize();
  $("qTo").value = state.meta.max_ticks;
  $("mTo").value = 100;
  updateRadiusLabel();
  await pollStats();
  await pollLive();
  setInterval(pollLive, 250);
  setInterval(pollStats, 1000);
  setInterval(refreshProfileLive, 3000);
  requestAnimationFrame(frame);
}

function wireOnboarding() {
  const modal = $("onboard");
  if (!localStorage.getItem("echoworld_onboarded")) {
    modal.hidden = false;
  }
  const close = () => {
    modal.hidden = true;
    localStorage.setItem("echoworld_onboarded", "1");
  };
  $("btnCloseOnboard").onclick = close;
  $("btnHelp").onclick = () => { modal.hidden = false; };
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
}

function buildLegend() {
  const box = $("legend");
  box.innerHTML = "";
  for (const [name, color] of Object.entries(state.meta.activities)) {
    const s = document.createElement("span");
    s.innerHTML = '<i style="background:' + color + '"></i>' + name;
    box.appendChild(s);
  }
}

function buildZoneChips() {
  const box = $("zoneChips");
  box.innerHTML = "";
  for (const z of state.meta.zones) {
    const b = document.createElement("button");
    b.textContent = z.name;
    b.onclick = () => {
      state.probe = { x: z.x, y: z.y, r: z.r, points: [], liveIds: new Set() };
      $("radius").value = z.r;
      updateRadiusLabel();
      runSpatial();
    };
    box.appendChild(b);
  }
}

function buildNpcSelect() {
  const sel = $("memNpc");
  sel.innerHTML = "";
  for (const n of state.meta.npcs) {
    const o = document.createElement("option");
    o.value = n.id;
    o.textContent = n.name + " (" + n.id + ")";
    sel.appendChild(o);
  }
}

function wireEvents() {
  window.addEventListener("resize", resize);
  canvas.addEventListener("click", onCanvasClick);

  $("modeLive").onclick = () => setMode("live");
  $("modeReplay").onclick = () => setMode("replay");

  $("btnStart").onclick = () => simCall("/api/sim/start");
  $("btnPause").onclick = () => simCall("/api/sim/pause");
  $("btnReset").onclick = async () => {
    await simCall("/api/sim/reset");
    clearAll();
  };
  $("btnFF").onclick = async () => {
    $("btnFF").textContent = "Generating...";
    await simCall("/api/sim/fast_forward?ticks=300");
    $("btnFF").textContent = "Generate 300 ticks";
    scanAlerts();
  };

  $("btnPlay").onclick = () => {
    if (state.mode !== "replay") return;
    if (state.playhead >= state.maxTick) state.playhead = 1;
    state.playing = !state.playing;
    updatePlayButton();
  };
  $("speed").onchange = (e) => { state.speed = Number(e.target.value); };
  $("scrub").oninput = (e) => {
    if (state.mode !== "replay") return;
    state.playhead = Number(e.target.value);
    state.playing = false;
    updatePlayButton();
  };
  $("chkTrails").onchange = (e) => { state.showTrails = e.target.checked; };

  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => showTab(t.dataset.tab);
  });

  $("btnProbe").onclick = () => {
    state.probeMode = true;
    showHint("Click anywhere on the map to place the probe");
    setTimeout(hideHint, 2500);
  };
  $("radius").oninput = () => {
    updateRadiusLabel();
    if (state.probe) state.probe.r = Number($("radius").value);
  };
  $("btnRun").onclick = runSpatial;
  $("btnBenchmark").onclick = runBenchmark;
  $("btnMem").onclick = runMemory;
  $("btnScan").onclick = scanAlerts;

  $("timeline").onclick = (e) => {
    if (!state.profile || !state.profile.segments.length) return;
    const rect = e.target.getBoundingClientRect();
    const total = state.profile.segments[state.profile.segments.length - 1].end;
    const tick = Math.max(1, Math.round(((e.clientX - rect.left) / rect.width) * total));
    seekTo(tick);
  };
}

function resize() {
  const wrap = canvas.parentElement;
  dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth || 900;
  const h = (w * state.meta.world.h) / state.meta.world.w;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  scale = canvas.width / state.meta.world.w;
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  if (name === "npc") drawTimeline();
}

function showHint(text) {
  const h = $("hint");
  h.textContent = text;
  h.style.display = "block";
}

function hideHint() {
  $("hint").style.display = "none";
}

function updateRadiusLabel() {
  const r = Number($("radius").value);
  $("radiusVal").textContent = r + " units (about " + r * state.meta.world.meters_per_unit + " m)";
}

function updatePlayButton() {
  $("btnPlay").textContent = state.playing ? "Pause" : "Play";
}

function updatePlaybackControls() {
  $("replayControls").hidden = state.mode !== "replay";
}

/* ---------- simulation control and polling ---------- */

async function simCall(path) {
  try {
    await api(path, { method: "POST" });
  } catch (e) { /* ignore */ }
  await pollStats();
  if (state.mode === "live") await pollLive();
}

function clearAll() {
  state.frames.clear();
  state.maxTick = 0;
  state.playhead = 1;
  state.playing = false;
  state.live.tick = 0;
  state.live.target.clear();
  state.live.disp.clear();
  state.live.trails.clear();
  state.motion.clear();
  state.npcs = [];
  state.profile = null;
  state.probe = null;
  state.anomalies = [];
  state.lastScanTick = -1;
  state.tickerPrevLive.clear();
  state.tickerPrevReplayTick = null;
  state.tickerQueue = [];
  $("npcCard").hidden = true;
  $("npcEmpty").hidden = false;
  $("labResult").innerHTML = "";
  $("memResult").innerHTML = "";
  $("benchResult").innerHTML = "";
  $("queryShown").classList.remove("show");
  renderAlerts();
  updateScrub();
  updatePlayButton();
}

async function setMode(mode) {
  state.mode = mode;
  state.playing = false;
  updatePlaybackControls();
  updatePlayButton();
  $("modeLive").classList.toggle("active", mode === "live");
  $("modeReplay").classList.toggle("active", mode === "replay");
  if (mode === "replay") {
    state.frames.clear();
    state.maxTick = 0;
    state.tickerPrevReplayTick = null;
    await syncFrames();
    state.playhead = 1;
    updateScrub();
  } else {
    await pollLive();
  }
}

async function pollLive() {
  if (state.mode !== "live" || pollBusy) return;
  pollBusy = true;
  try {
    applyLive(await api("/api/live"));
  } catch (e) { /* ignore */ }
  pollBusy = false;
}

function applyLive(d) {
  const L = state.live;
  if (d.tick < L.tick || d.npcs.length === 0) {
    L.disp.clear();
    L.trails.clear();
    L.target.clear();
    state.tickerPrevLive.clear();
  }
  detectLiveEvents(d.npcs);
  L.tick = d.tick;
  L.ms = d.ms;
  for (const n of d.npcs) {
    L.target.set(n.id, n);
    if (!L.disp.has(n.id)) L.disp.set(n.id, { x: n.x, y: n.y });
    const tr = L.trails.get(n.id) || [];
    const last = tr[tr.length - 1];
    if (!last || last.x !== n.x || last.y !== n.y) {
      tr.push({ x: n.x, y: n.y });
      if (tr.length > 40) tr.shift();
    }
    L.trails.set(n.id, tr);
  }
  $("pSource").textContent = "Source: Redis, " + d.ms.toFixed(2) + " ms (all 12 NPCs, one round trip)";
}

async function pollStats() {
  try {
    const s = await api("/api/stats");
    state.stats = s;
    $("pTick").textContent = "Tick " + s.tick + " / " + s.max_ticks + (s.running ? " (running)" : "");
    $("pRedis").textContent = "Redis keys " + s.redis_keys;
    const names = Object.keys(s.mongo);
    $("pShardA").textContent = names[0] + " " + s.mongo[names[0]] + " docs";
    $("pShardB").textContent = names[1] + " " + s.mongo[names[1]] + " docs";
    if (state.mode === "replay") await syncFrames();
    if (s.tick === 0) {
      showHint("Nothing recorded yet. Press Start to run live, or Generate 300 ticks to record a run instantly.");
    } else if ($("hint").textContent.startsWith("Nothing")) {
      hideHint();
    }
    if (s.tick - state.lastScanTick >= 10 || (!s.running && s.tick !== state.lastScanTick)) {
      scanAlerts();
    }
  } catch (e) { /* ignore */ }
}

async function syncFrames() {
  if (syncBusy) return;
  syncBusy = true;
  try {
    const upto = state.stats ? state.stats.tick : 0;
    if (upto < state.maxTick) {
      state.frames.clear();
      state.maxTick = 0;
      state.playhead = 1;
    }
    if (upto > state.maxTick) {
      const d = await api("/api/frames?start=" + (state.maxTick + 1) + "&end=" + upto);
      for (const f of d.frames) {
        state.frames.set(f.tick, f.npcs);
        state.maxTick = Math.max(state.maxTick, f.tick);
      }
      $("pSource").textContent =
        "Source: MongoDB, " + d.ms.toFixed(1) + " ms (scatter-gather across " + d.shards.join(" and ") + ")";
    }
    updateScrub();
  } catch (e) { /* ignore */ }
  syncBusy = false;
}

function updateScrub() {
  const s = $("scrub");
  s.max = Math.max(1, state.maxTick);
  s.value = Math.floor(state.playhead);
  updateTickLabel();
}

function updateTickLabel() {
  if (state.mode === "live") {
    $("tickLabel").textContent = "LIVE tick " + state.live.tick;
  } else {
    $("tickLabel").textContent = "tick " + Math.floor(state.playhead) + " / " + state.maxTick;
  }
}

async function seekTo(tick) {
  if (state.mode !== "replay") await setMode("replay");
  await syncFrames();
  state.playhead = Math.max(1, Math.min(tick, Math.max(1, state.maxTick)));
  state.playing = false;
  updatePlayButton();
  updateScrub();
}

/* ---------- per-frame positions ---------- */

function currentNpcs(dt) {
  const out = [];
  if (state.mode === "live") {
    const k = 1 - Math.exp(-dt * 9);
    for (const [id, t] of state.live.target) {
      const d = state.live.disp.get(id) || { x: t.x, y: t.y };
      if (Math.hypot(t.x - d.x, t.y - d.y) > 6) {
        d.x = t.x;
        d.y = t.y;
      } else {
        d.x += (t.x - d.x) * k;
        d.y += (t.y - d.y) * k;
      }
      state.live.disp.set(id, d);
      out.push({ id, x: d.x, y: d.y, activity: t.activity, zone: t.zone, target: t.target });
    }
  } else {
    const t0 = Math.floor(state.playhead);
    const f = state.playhead - t0;
    const A = state.frames.get(t0);
    const B = state.frames.get(Math.min(t0 + 1, state.maxTick)) || A;
    if (A) {
      const mapB = new Map(B.map((n) => [n.id, n]));
      for (const a of A) {
        const b = mapB.get(a.id) || a;
        const jumped = Math.hypot(b.x - a.x, b.y - a.y) > 6;
        const m = jumped ? 0 : f;
        out.push({
          id: a.id,
          x: a.x + (b.x - a.x) * m,
          y: a.y + (b.y - a.y) * m,
          activity: a.activity, zone: a.zone, target: a.target,
        });
      }
    }
  }
  return out;
}

function frame(ts) {
  const dt = Math.min(0.1, (ts - (state.lastTs || ts)) / 1000);
  state.lastTs = ts;

  if (state.mode === "replay" && state.playing && state.maxTick > 1) {
    state.playhead += dt * state.speed * (1 / state.meta.tick_seconds);
    if (state.playhead >= state.maxTick) {
      state.playhead = state.maxTick;
      state.playing = false;
      updatePlayButton();
    }
    $("scrub").value = Math.floor(state.playhead);
  }
  updateTickLabel();

  state.npcs = currentNpcs(dt);
  if (state.mode === "replay") detectReplayEvents(Math.floor(state.playhead));
  draw(ts / 1000);

  if (ts - state.lastPanel > 200) {
    state.lastPanel = ts;
    updateNowPanel();
  }
  requestAnimationFrame(frame);
}

/* ---------- drawing ---------- */

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function buildScenery() {
  const w = state.meta.world.w;
  const h = state.meta.world.h;
  const rand = mulberry32(7);
  const inAnyZone = (x, y, pad) =>
    state.meta.zones.some((z) => Math.hypot(x - z.x, y - z.y) < z.r + pad);

  const ground = [];
  const groundColors = ["rgba(106,126,72,0.11)", "rgba(126,105,68,0.10)", "rgba(57,88,55,0.12)"];
  for (let i = 0; i < 70; i++) {
    const x = rand() * w, y = rand() * h;
    if (inAnyZone(x, y, 5)) continue;
    ground.push({
      x, y, rx: 1.2 + rand() * 3.8, ry: 0.5 + rand() * 1.8,
      angle: rand() * Math.PI, color: groundColors[Math.floor(rand() * groundColors.length)],
    });
  }

  const grass = [];
  for (let i = 0; i < 340; i++) {
    const x = rand() * w, y = rand() * h;
    if (inAnyZone(x, y, 2)) continue;
    grass.push({ x, y, a: rand() * Math.PI, len: 0.5 + rand() * 0.6 });
  }

  const props = [];
  const kinds = ["tree", "tree", "rock", "bush"];
  for (let i = 0; i < 30; i++) {
    const x = rand() * w, y = rand() * h;
    if (inAnyZone(x, y, 6)) continue;
    props.push({ x, y, kind: kinds[Math.floor(rand() * kinds.length)], scale: 0.7 + rand() * 0.6 });
  }

  const fireflies = [];
  for (let i = 0; i < 12; i++) {
    fireflies.push({ x: rand() * w, y: rand() * h, phase: rand() * Math.PI * 2, speed: 0.3 + rand() * 0.4 });
  }

  state.scenery = { ground, grass, props, fireflies };
}

function drawProp(p) {
  const px = p.x * scale, py = p.y * scale, u = scale * p.scale * 0.5;
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(px, py, 2.4 * u, 0.9 * u, 0, 0, Math.PI * 2);
  ctx.fill();
  if (p.kind === "tree") {
    ctx.fillStyle = "#5d4631";
    ctx.fillRect(px - 0.45 * u, py - 3.4 * u, 0.9 * u, 3.4 * u);
    ctx.fillStyle = "#203c2b";
    ctx.beginPath();
    ctx.moveTo(px, py - 9.1 * u);
    ctx.lineTo(px - 3.1 * u, py - 3.1 * u);
    ctx.lineTo(px + 3.1 * u, py - 3.1 * u);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#2f5d3a";
    ctx.beginPath();
    ctx.moveTo(px, py - 7.4 * u);
    ctx.lineTo(px - 2.5 * u, py - 2.4 * u);
    ctx.lineTo(px + 2.5 * u, py - 2.4 * u);
    ctx.closePath();
    ctx.fill();
  } else if (p.kind === "rock") {
    ctx.fillStyle = "#6b6b63";
    ctx.beginPath();
    ctx.ellipse(px, py - 0.6 * u, 1.8 * u, 1.2 * u, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = "#3f6b3f";
    ctx.beginPath();
    ctx.arc(px, py - 0.8 * u, 1.5 * u, 0, Math.PI * 2);
    ctx.arc(px - 1.3 * u, py - 0.4 * u, 1.1 * u, 0, Math.PI * 2);
    ctx.arc(px + 1.3 * u, py - 0.4 * u, 1.1 * u, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawScenery() {
  if (!state.scenery) return;
  for (const patch of state.scenery.ground) {
    ctx.fillStyle = patch.color;
    ctx.beginPath();
    ctx.ellipse(
      patch.x * scale, patch.y * scale, patch.rx * scale, patch.ry * scale,
      patch.angle, 0, Math.PI * 2,
    );
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(140,200,120,0.35)";
  ctx.lineWidth = Math.max(1, scale * 0.12);
  ctx.lineCap = "round";
  for (const g of state.scenery.grass) {
    const px = g.x * scale, py = g.y * scale;
    const dx = Math.cos(g.a) * g.len * scale * 0.6;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + dx, py - g.len * scale * 0.5);
    ctx.stroke();
  }
  for (const p of state.scenery.props) drawProp(p);
}

function drawFireflies(t) {
  if (!state.scenery) return;
  for (const f of state.scenery.fireflies) {
    const px = (f.x + Math.sin(t * f.speed + f.phase) * 2) * scale;
    const py = (f.y + Math.cos(t * f.speed * 0.7 + f.phase) * 2) * scale;
    const glow = Math.max(0.15, 0.4 + Math.sin(t * 2 + f.phase) * 0.3);
    ctx.shadowColor = "rgba(255,230,140,0.8)";
    ctx.shadowBlur = scale * 0.6;
    ctx.fillStyle = "rgba(255,240,160," + glow + ")";
    ctx.beginPath();
    ctx.arc(px, py, scale * 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawVignette(W, H) {
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.72);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.38)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function draw(t) {
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  drawGround(W, H);
  drawScenery();
  drawRoadNetwork();
  drawZones();
  if (state.showTrails) drawTrails();
  drawProbe();
  const sorted = state.npcs.slice().sort((a, b) => a.y - b.y);
  sorted.forEach((n) => drawAvatar(n, t));
  drawAnomalyRings(t);
  drawFireflies(t);
  drawVignette(W, H);
}

function drawGround(W, H) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#344b32");
  g.addColorStop(0.55, "#263c29");
  g.addColorStop(1, "#1b3024");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const clearing = ctx.createRadialGradient(W * 0.5, H * 0.5, 0, W * 0.5, H * 0.5, W * 0.48);
  clearing.addColorStop(0, "rgba(180,151,97,0.10)");
  clearing.addColorStop(1, "rgba(180,151,97,0)");
  ctx.fillStyle = clearing;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "rgba(221,225,176,0.025)";
  ctx.lineWidth = Math.max(1, dpr * 0.5);
  for (let x = 0; x <= state.meta.world.w; x += 10) {
    ctx.beginPath();
    ctx.moveTo(x * scale, 0);
    ctx.lineTo(x * scale, H);
    ctx.stroke();
  }
  for (let y = 0; y <= state.meta.world.h; y += 10) {
    ctx.beginPath();
    ctx.moveTo(0, y * scale);
    ctx.lineTo(W, y * scale);
    ctx.stroke();
  }
}

function routeForZone(z) {
  const hub = { x: state.meta.world.w / 2, y: state.meta.world.h / 2 };
  const dx = hub.x - z.x, dy = hub.y - z.y;
  const length = Math.hypot(dx, dy) || 1;
  const start = {
    x: z.x + dx / length * z.r * 0.92,
    y: z.y + dy / length * z.r * 0.92,
  };
  const bend = z.x < hub.x ? -2.4 : 2.4;
  return {
    start,
    control: {
      x: (start.x + hub.x) / 2 - dy / length * bend,
      y: (start.y + hub.y) / 2 + dx / length * bend,
    },
    end: hub,
  };
}

function roadPoint(route, t) {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * route.start.x + 2 * inverse * t * route.control.x + t * t * route.end.x,
    y: inverse * inverse * route.start.y + 2 * inverse * t * route.control.y + t * t * route.end.y,
  };
}

function drawRoadNetwork() {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const routes = state.meta.zones.map(routeForZone);
  const layers = [
    { color: "rgba(45,37,27,0.72)", width: 4.2 },
    { color: "#756247", width: 3.5 },
    { color: "rgba(177,151,107,0.9)", width: 2.65 },
  ];
  for (const layer of layers) {
    ctx.strokeStyle = layer.color;
    ctx.lineWidth = scale * layer.width;
    for (const route of routes) {
      ctx.beginPath();
      ctx.moveTo(route.start.x * scale, route.start.y * scale);
      ctx.quadraticCurveTo(
        route.control.x * scale, route.control.y * scale,
        route.end.x * scale, route.end.y * scale,
      );
      ctx.stroke();
    }
  }

  for (const route of routes) {
    for (let i = 1; i < 14; i++) {
      const point = roadPoint(route, i / 15);
      const next = roadPoint(route, (i + 0.1) / 15);
      const angle = Math.atan2(next.y - point.y, next.x - point.x);
      ctx.fillStyle = i % 2 ? "rgba(220,197,153,0.34)" : "rgba(65,55,40,0.25)";
      ctx.beginPath();
      ctx.ellipse(point.x * scale, point.y * scale, scale * 0.22, scale * 0.1, angle, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawClearing(z) {
  const cx = z.x * scale, cy = z.y * scale;
  ctx.fillStyle = "rgba(178,151,101,0.24)";
  ctx.beginPath();
  ctx.ellipse(cx, cy, z.r * 1.2 * scale, z.r * 0.82 * scale, -0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(219,191,139,0.22)";
  ctx.lineWidth = Math.max(1, scale * 0.12);
  ctx.stroke();
}

function drawCentralPlaza() {
  const x = state.meta.world.w / 2, y = state.meta.world.h / 2;
  ctx.fillStyle = "rgba(35,31,24,0.34)";
  ctx.beginPath();
  ctx.ellipse(x * scale, y * scale, 5.8 * scale, 4.6 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#8b7958";
  ctx.beginPath();
  ctx.ellipse(x * scale, y * scale, 5.3 * scale, 4.1 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(221,201,160,0.52)";
  ctx.lineWidth = Math.max(1, scale * 0.16);
  ctx.stroke();

  for (let i = 0; i < 12; i++) {
    const angle = i * Math.PI / 6;
    ctx.fillStyle = i % 2 ? "#a18d69" : "#6e624b";
    ctx.beginPath();
    ctx.ellipse(
      (x + Math.cos(angle) * 4.4) * scale,
      (y + Math.sin(angle) * 3.2) * scale,
      scale * 0.32, scale * 0.18, angle, 0, Math.PI * 2,
    );
    ctx.fill();
  }

  ctx.save();
  ctx.translate(x * scale, y * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath();
  ctx.ellipse(0, 1.4, 1.55, 0.65, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#554b3c";
  rr(ctx, -1.25, -0.1, 2.5, 1.2, 0.25);
  ctx.fill();
  ctx.fillStyle = "#a99a7b";
  rr(ctx, -1.05, -0.55, 2.1, 0.8, 0.2);
  ctx.fill();
  ctx.fillStyle = "#574b3a";
  ctx.fillRect(-0.72, -1.1, 1.44, 0.58);
  ctx.fillStyle = "#74593d";
  ctx.beginPath();
  ctx.moveTo(-1.15, -1.1);
  ctx.lineTo(0, -2.0);
  ctx.lineTo(1.15, -1.1);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawMarketBuilding(z) {
  ctx.save();
  ctx.translate(z.x * scale, (z.y - 4) * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(34,25,18,0.36)";
  ctx.beginPath(); ctx.ellipse(0, 2.2, 6.2, 1.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#593d27";
  rr(ctx, -5.1, -1.3, 10.2, 3.3, 0.3); ctx.fill();
  ctx.fillStyle = "#a77543";
  rr(ctx, -4.9, -1.7, 9.8, 0.62, 0.15); ctx.fill();
  ctx.fillStyle = "#c59a5b";
  ctx.fillRect(-4.4, -1.05, 8.8, 0.18);
  ctx.fillStyle = "#4b3828";
  for (const x of [-4.5, 4.5]) ctx.fillRect(x - 0.16, -5.1, 0.32, 5.2);
  ctx.fillRect(-4.8, -4.8, 9.6, 0.3);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(-5.1, -4.7); ctx.lineTo(5.1, -4.7);
  ctx.lineTo(4.1, -1.65); ctx.lineTo(-4.1, -1.65); ctx.closePath();
  ctx.clip();
  ctx.fillStyle = "#e2cfaa"; ctx.fillRect(-5.2, -5, 10.4, 3.6);
  for (let x = -4.8; x < 5; x += 1.7) {
    ctx.fillStyle = "#9d4939"; ctx.fillRect(x, -5, 0.82, 3.6);
  }
  ctx.restore();
  ctx.strokeStyle = "#674632"; ctx.lineWidth = 0.16;
  ctx.beginPath();
  ctx.moveTo(-5.1, -4.7); ctx.lineTo(5.1, -4.7);
  ctx.lineTo(4.1, -1.65); ctx.lineTo(-4.1, -1.65); ctx.closePath(); ctx.stroke();

  const goods = ["#bf4f3c", "#e3bd52", "#648e53", "#9e613f", "#d8d0a0"];
  goods.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(-3.4 + i * 1.7, -2.25, 0.35, 0, Math.PI * 2); ctx.fill();
  });
  ctx.fillStyle = "#d7b46d"; rr(ctx, -1.5, -6.15, 3, 0.75, 0.12); ctx.fill();
  ctx.strokeStyle = "#62452b"; ctx.stroke();
  ctx.fillStyle = "#463321"; ctx.font = "bold 0.85px system-ui, sans-serif"; ctx.textAlign = "center";
  ctx.fillText("GOODS", 0, -5.63);
  ctx.restore();
}

function drawTavernBuilding(z) {
  ctx.save();
  ctx.translate(z.x * scale, (z.y - 4) * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(34,25,18,0.4)";
  ctx.beginPath(); ctx.ellipse(0, 2.25, 6.1, 1.45, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#65513c"; rr(ctx, -4.8, -2.2, 9.6, 4.2, 0.3); ctx.fill();
  ctx.fillStyle = "#bd9865"; rr(ctx, -4.35, -4.3, 8.7, 6.1, 0.2); ctx.fill();
  ctx.fillStyle = "#593e2d"; ctx.fillRect(-4.35, -0.2, 8.7, 0.28);

  ctx.fillStyle = "#4b3029";
  ctx.beginPath();
  ctx.moveTo(-5.25, -4.2); ctx.lineTo(0, -8); ctx.lineTo(5.25, -4.2);
  ctx.lineTo(4.55, -3.75); ctx.lineTo(0, -6.95); ctx.lineTo(-4.55, -3.75);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#9a6844"; ctx.lineWidth = 0.18;
  ctx.beginPath(); ctx.moveTo(-3.8, -4.4); ctx.lineTo(0, -7.05); ctx.lineTo(3.8, -4.4); ctx.stroke();
  ctx.fillStyle = "#564233"; ctx.fillRect(2.8, -7.2, 1.1, 2.1);
  ctx.fillStyle = "#9b7550"; ctx.fillRect(3.05, -7.45, 0.65, 0.35);

  ctx.fillStyle = "#6d4933"; rr(ctx, -1.05, -2.3, 2.1, 4.05, 0.65); ctx.fill();
  ctx.fillStyle = "#332820"; rr(ctx, -0.72, -1.65, 1.44, 3.4, 0.5); ctx.fill();
  ctx.fillStyle = "#d7aa56"; ctx.beginPath(); ctx.arc(0.42, -0.05, 0.12, 0, Math.PI * 2); ctx.fill();

  for (const x of [-3.1, 3.1]) {
    ctx.fillStyle = "#49352a"; rr(ctx, x - 0.8, -3.15, 1.6, 1.65, 0.18); ctx.fill();
    ctx.fillStyle = "#f2c66c"; rr(ctx, x - 0.54, -2.88, 1.08, 1.12, 0.12); ctx.fill();
    ctx.strokeStyle = "#67412d"; ctx.lineWidth = 0.15;
    ctx.beginPath(); ctx.moveTo(x, -2.86); ctx.lineTo(x, -1.77);
    ctx.moveTo(x - 0.52, -2.34); ctx.lineTo(x + 0.52, -2.34); ctx.stroke();
  }
  ctx.strokeStyle = "#4a3324"; ctx.lineWidth = 0.2;
  ctx.beginPath();
  ctx.moveTo(-4.1, -4.1); ctx.lineTo(-4.1, 1.7);
  ctx.moveTo(4.1, -4.1); ctx.lineTo(4.1, 1.7);
  ctx.moveTo(0, -4.1); ctx.lineTo(0, -2.3); ctx.stroke();
  ctx.fillStyle = "#d7b46d"; rr(ctx, -5.3, -3.25, 1.15, 0.9, 0.1); ctx.fill();
  ctx.strokeStyle = "#513927"; ctx.stroke();
  ctx.fillStyle = "#523825"; ctx.font = "bold 1px system-ui, sans-serif"; ctx.textAlign = "center";
  ctx.fillText("T", -4.72, -2.62);
  ctx.restore();
}

function drawBarracksBuilding(z) {
  ctx.save();
  ctx.translate(z.x * scale, (z.y - 4) * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(26,24,23,0.4)";
  ctx.beginPath(); ctx.ellipse(0, 2.2, 6.3, 1.45, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#47494a"; rr(ctx, -5.1, -3.7, 10.2, 5.9, 0.25); ctx.fill();
  ctx.fillStyle = "#77766e"; rr(ctx, -4.55, -3.3, 9.1, 5.3, 0.18); ctx.fill();
  for (const x of [-4.55, 0, 4.55]) {
    ctx.fillStyle = "#5d5d59"; rr(ctx, x - 0.55, -4.8, 1.1, 6.8, 0.12); ctx.fill();
    ctx.fillStyle = "#96938a";
    for (let i = -0.45; i <= 0.46; i += 0.9) ctx.fillRect(x + i - 0.27, -5.1, 0.54, 0.55);
  }
  ctx.fillStyle = "#9b978b";
  for (let x = -3.8; x <= 3.8; x += 1.25) ctx.fillRect(x, -3.75, 0.66, 0.55);
  ctx.strokeStyle = "rgba(39,39,37,0.55)"; ctx.lineWidth = 0.13;
  for (let y = -2.55; y <= 1.4; y += 1.2) {
    ctx.beginPath(); ctx.moveTo(-4.4, y); ctx.lineTo(4.4, y); ctx.stroke();
  }
  for (let x = -3.4; x <= 3.5; x += 1.7) {
    ctx.beginPath(); ctx.moveTo(x, -3.2); ctx.lineTo(x, 1.9); ctx.stroke();
  }
  ctx.fillStyle = "#423c35";
  ctx.beginPath(); ctx.moveTo(-1.35, 2); ctx.lineTo(-1.35, -0.3);
  ctx.quadraticCurveTo(0, -2.05, 1.35, -0.3); ctx.lineTo(1.35, 2); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#27303a";
  ctx.beginPath(); ctx.moveTo(-0.92, 1.9); ctx.lineTo(-0.92, -0.15);
  ctx.quadraticCurveTo(0, -1.3, 0.92, -0.15); ctx.lineTo(0.92, 1.9); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#7f4037"; ctx.fillRect(-0.38, -2.35, 0.76, 1.2);
  ctx.beginPath(); ctx.moveTo(-0.38, -2.35); ctx.lineTo(0.9, -2); ctx.lineTo(-0.38, -1.72); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawWatchtowerBuilding(z) {
  ctx.save();
  ctx.translate(z.x * scale, (z.y - 4) * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(22,29,23,0.42)";
  ctx.beginPath(); ctx.ellipse(0, 2.15, 4.7, 1.35, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#51514a"; rr(ctx, -3.5, -5.2, 7, 7.2, 0.55); ctx.fill();
  ctx.fillStyle = "#888578"; rr(ctx, -2.9, -5, 5.8, 6.8, 0.42); ctx.fill();
  ctx.fillStyle = "#5d5b51"; rr(ctx, -3.7, -6.05, 7.4, 1.35, 0.2); ctx.fill();
  ctx.fillStyle = "#a39b86";
  for (let x = -3.25; x <= 2.8; x += 1.1) ctx.fillRect(x, -6.3, 0.58, 0.45);
  ctx.strokeStyle = "rgba(49,47,41,0.6)"; ctx.lineWidth = 0.14;
  for (let y = -4.6; y <= 1; y += 1.4) {
    ctx.beginPath(); ctx.moveTo(-2.75, y); ctx.lineTo(2.75, y); ctx.stroke();
  }
  for (const x of [-1.7, 1.7]) {
    ctx.fillStyle = "#34352f"; rr(ctx, x - 0.32, -4.4, 0.64, 1.55, 0.28); ctx.fill();
    ctx.fillStyle = "#d8b96e"; ctx.fillRect(x - 0.1, -4.05, 0.2, 0.4);
  }
  ctx.fillStyle = "#534234";
  ctx.beginPath(); ctx.moveTo(-4.2, -5.95); ctx.lineTo(0, -9.25); ctx.lineTo(4.2, -5.95); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#795740";
  ctx.beginPath(); ctx.moveTo(-3.4, -6.05); ctx.lineTo(0, -8.75); ctx.lineTo(3.4, -6.05); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#d6a952"; ctx.beginPath(); ctx.arc(0, -7.05, 0.42, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#44362a";
  ctx.beginPath(); ctx.moveTo(-0.9, 1.9); ctx.lineTo(-0.9, -0.35);
  ctx.quadraticCurveTo(0, -1.6, 0.9, -0.35); ctx.lineTo(0.9, 1.9); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#4b382a"; ctx.lineWidth = 0.18;
  ctx.beginPath(); ctx.moveTo(2.65, -8.5); ctx.lineTo(2.65, -10.7); ctx.stroke();
  ctx.fillStyle = "#9a4b3d";
  ctx.beginPath(); ctx.moveTo(2.7, -10.65); ctx.lineTo(4.3, -10.2); ctx.lineTo(2.7, -9.75); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawZoneLabel(z) {
  const text = z.name.toUpperCase();
  ctx.font = "bold " + Math.round(11 * dpr) + "px system-ui, sans-serif";
  ctx.textAlign = "center";
  const width = ctx.measureText(text).width + 16 * dpr;
  const height = 19 * dpr;
  const x = z.x * scale, y = (z.y + z.r + 2) * scale;
  rr(ctx, x - width / 2, y - height / 2, width, height, 6 * dpr);
  ctx.fillStyle = "rgba(22,27,24,0.82)"; ctx.fill();
  ctx.strokeStyle = "rgba(214,193,151,0.5)"; ctx.lineWidth = Math.max(1, dpr); ctx.stroke();
  ctx.fillStyle = "#f0e3c5";
  ctx.fillText(text, x, y + 4 * dpr);
}

function drawZones() {
  drawCentralPlaza();
  for (const z of state.meta.zones) {
    drawClearing(z);
    if (z.name === "Market") drawMarketBuilding(z);
    else if (z.name === "Tavern") drawTavernBuilding(z);
    else if (z.name === "Barracks") drawBarracksBuilding(z);
    else if (z.name === "Watchtower") drawWatchtowerBuilding(z);
    drawZoneLabel(z);
  }
}

function trailFor(id) {
  if (state.mode === "live") return state.live.trails.get(id) || [];
  const pts = [];
  const end = Math.floor(state.playhead);
  for (let t = Math.max(1, end - 40); t <= end; t++) {
    const f = state.frames.get(t);
    const n = f && f.find((q) => q.id === id);
    if (n) pts.push({ x: n.x, y: n.y });
  }
  return pts;
}

function drawTrails() {
  ctx.lineWidth = Math.max(1, scale * 0.3);
  ctx.lineCap = "round";
  for (const n of state.npcs) {
    const pts = trailFor(n.id);
    const hue = hueOf(n.id);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const jump = Math.hypot(b.x - a.x, b.y - a.y) > 6;
      const alpha = (i / pts.length) * 0.6;
      ctx.beginPath();
      ctx.setLineDash(jump ? [6, 6] : []);
      ctx.strokeStyle = jump ? "rgba(239,83,80," + alpha + ")" : "hsla(" + hue + ",70%,65%," + alpha + ")";
      ctx.moveTo(a.x * scale, a.y * scale);
      ctx.lineTo(b.x * scale, b.y * scale);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

function drawProbe() {
  const p = state.probe;
  if (!p) return;
  ctx.fillStyle = "rgba(79,195,247,0.35)";
  for (const [x, y] of p.points) {
    ctx.beginPath();
    ctx.arc(x * scale, y * scale, Math.max(1.5, scale * 0.25), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(p.x * scale, p.y * scale, p.r * scale, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(79,195,247,0.08)";
  ctx.fill();
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = "#4fc3f7";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(p.x * scale - 8, p.y * scale);
  ctx.lineTo(p.x * scale + 8, p.y * scale);
  ctx.moveTo(p.x * scale, p.y * scale - 8);
  ctx.lineTo(p.x * scale, p.y * scale + 8);
  ctx.stroke();
}

function roleOf(id) {
  const n = state.meta.npcs.find((x) => x.id === id);
  return n ? n.role : null;
}

function drawRoleGear(id, px, py, u, bob, hue) {
  const role = roleOf(id);
  const y = py - 10.6 * u + bob;
  if (role === "Market") {
    ctx.fillStyle = "#c98a3f";
    ctx.beginPath();
    ctx.ellipse(px, y + 0.3 * u, 2.2 * u, 0.9 * u, 0, Math.PI, 0);
    ctx.fill();
  } else if (role === "Barracks") {
    ctx.fillStyle = "#8a8f98";
    ctx.beginPath();
    ctx.arc(px, y, 2.25 * u, Math.PI, 0);
    ctx.fill();
    ctx.fillRect(px - 2.25 * u, y - 0.1 * u, 4.5 * u, 0.5 * u);
    ctx.fillStyle = "#5c6168";
    ctx.fillRect(px - 0.35 * u, y - 2.1 * u, 0.7 * u, 1.6 * u);
  } else if (role === "Watchtower") {
    ctx.fillStyle = "#2f5d3a";
    ctx.beginPath();
    ctx.moveTo(px - 2.1 * u, y + 0.3 * u);
    ctx.quadraticCurveTo(px, y - 2.6 * u, px + 2.1 * u, y + 0.3 * u);
    ctx.quadraticCurveTo(px, y - 1 * u, px - 2.1 * u, y + 0.3 * u);
    ctx.fill();
  }
  // Tavern-goers keep their natural hair, no overlay needed.
}

function drawAvatar(n, t) {
  const u = scale * 0.36;
  const px = n.x * scale;
  const py = n.y * scale;
  const hue = hueOf(n.id);
  const color = actColor(n.activity);

  const m = state.motion.get(n.id) || { x: n.x, y: n.y, face: 1 };
  const dx = n.x - m.x;
  if (Math.abs(dx) > 0.01) m.face = dx > 0 ? 1 : -1;
  m.x = n.x;
  m.y = n.y;
  state.motion.set(n.id, m);
  const face = m.face;

  const moving = n.activity === "walking" || n.activity === "fleeing";
  const seed = hue / 30;
  const bob = moving ? Math.sin(t * (n.activity === "fleeing" ? 16 : 10) + seed) * 0.4 * u
                     : Math.sin(t * 2 + seed) * 0.15 * u;
  const swing = moving ? Math.sin(t * (n.activity === "fleeing" ? 16 : 10) + seed) * 1.3 * u : 0;

  // shadow and activity ring
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(px, py, 2.8 * u, 1.1 * u, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(px, py, 3.6 * u, 1.5 * u, 0, 0, Math.PI * 2);
  ctx.stroke();

  if (state.selected === n.id) {
    const pulse = 1 + Math.sin(t * 5) * 0.12;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(px, py, 5.2 * u * pulse, 2.2 * u * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Boots and trousers give each character a fuller silhouette than the original stick figure.
  ctx.strokeStyle = "#342c25";
  ctx.lineWidth = Math.max(2, u * 0.85);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(px - 0.82 * u, py - 3.1 * u + bob);
  ctx.lineTo(px - 0.82 * u + swing, py - 0.5 * u);
  ctx.moveTo(px + 0.82 * u, py - 3.1 * u + bob);
  ctx.lineTo(px + 0.82 * u - swing, py - 0.5 * u);
  ctx.stroke();
  ctx.fillStyle = "#251f1b";
  ctx.beginPath();
  ctx.ellipse(px - 0.82 * u + swing, py - 0.15 * u, 0.8 * u, 0.38 * u, 0, 0, Math.PI * 2);
  ctx.ellipse(px + 0.82 * u - swing, py - 0.15 * u, 0.8 * u, 0.38 * u, 0, 0, Math.PI * 2);
  ctx.fill();

  const tunic = "hsl(" + hue + ",48%,43%)";
  const sleeve = "hsl(" + hue + ",42%,35%)";
  ctx.strokeStyle = sleeve;
  ctx.lineWidth = Math.max(2, u * 1.25);
  ctx.beginPath();
  ctx.moveTo(px - 1.8 * u, py - 7.1 * u + bob);
  ctx.lineTo(px - 2.8 * u + swing * 0.55, py - 4.2 * u + bob);
  ctx.moveTo(px + 1.8 * u, py - 7.1 * u + bob);
  ctx.lineTo(px + 2.8 * u - swing * 0.55, py - 4.2 * u + bob);
  ctx.stroke();
  ctx.fillStyle = "#e4b991";
  ctx.beginPath();
  ctx.arc(px - 2.8 * u + swing * 0.55, py - 4.1 * u + bob, 0.42 * u, 0, Math.PI * 2);
  ctx.arc(px + 2.8 * u - swing * 0.55, py - 4.1 * u + bob, 0.42 * u, 0, Math.PI * 2);
  ctx.fill();

  // A tapered tunic, belt, and collar make the role-specific accessories easier to read.
  ctx.beginPath();
  ctx.moveTo(px - 1.7 * u, py - 7.8 * u + bob);
  ctx.quadraticCurveTo(px, py - 8.5 * u + bob, px + 1.7 * u, py - 7.8 * u + bob);
  ctx.lineTo(px + 2.05 * u, py - 3.0 * u + bob);
  ctx.quadraticCurveTo(px, py - 2.35 * u + bob, px - 2.05 * u, py - 3.0 * u + bob);
  ctx.closePath();
  ctx.fillStyle = tunic;
  ctx.fill();
  ctx.strokeStyle = "rgba(24,20,17,0.7)";
  ctx.lineWidth = Math.max(1, u * 0.18);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,226,177,0.35)";
  ctx.fillRect(px - 0.18 * u, py - 7.1 * u + bob, 0.36 * u, 3.8 * u);
  ctx.fillStyle = "#463427";
  rr(ctx, px - 2.0 * u, py - 4.05 * u + bob, 4.0 * u, 0.62 * u, 0.2 * u);
  ctx.fill();
  ctx.fillStyle = "#d4aa5f";
  rr(ctx, px - 0.28 * u, py - 4.0 * u + bob, 0.56 * u, 0.5 * u, 0.12 * u);
  ctx.fill();

  // head, hair, eyes
  ctx.fillStyle = "#e4b991";
  rr(ctx, px - 0.58 * u, py - 9.3 * u + bob, 1.16 * u, 1.5 * u, 0.35 * u);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(px, py - 10.4 * u + bob, 2.1 * u, 0, Math.PI * 2);
  ctx.fillStyle = "#f1c9a5";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(px, py - 10.6 * u + bob, 2.15 * u, Math.PI, 0);
  ctx.fillStyle = "hsl(" + hue + ",35%,22%)";
  ctx.fill();
  ctx.fillStyle = "hsl(" + hue + ",35%,22%)";
  ctx.beginPath();
  ctx.ellipse(px - face * 1.65 * u, py - 9.7 * u + bob, 0.55 * u, 1.25 * u, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(px + face * 0.8 * u, py - 10.2 * u + bob, 0.28 * u, 0, Math.PI * 2);
  ctx.arc(px + face * 1.5 * u, py - 10.2 * u + bob, 0.28 * u, 0, Math.PI * 2);
  ctx.fill();

  drawRoleGear(n.id, px, py, u, bob, hue);
  drawAccessory(n.activity, px, py, u, bob, face, t, color);

  // name and activity label
  ctx.textAlign = "center";
  ctx.font = "bold " + Math.round(11 * dpr) + "px system-ui, sans-serif";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.strokeText(nameOf(n.id), px, py + 4.6 * u + 8 * dpr);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(nameOf(n.id), px, py + 4.6 * u + 8 * dpr);

  ctx.font = Math.round(10 * dpr) + "px system-ui, sans-serif";
  const label = n.activity;
  const tw = ctx.measureText(label).width;
  const ly = py - 15.5 * u + bob;
  rr(ctx, px - tw / 2 - 6 * dpr, ly - 9 * dpr, tw + 12 * dpr, 14 * dpr, 6 * dpr);
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(label, px, ly + 2 * dpr);
}

function drawAccessory(activity, px, py, u, bob, face, t, color) {
  ctx.lineCap = "round";
  if (activity === "fighting") {
    const sway = Math.sin(t * 9) * 1.2 * u;
    ctx.strokeStyle = "#eceff1";
    ctx.lineWidth = Math.max(2, u * 0.7);
    ctx.beginPath();
    ctx.moveTo(px + face * 2.8 * u, py - 6 * u + bob);
    ctx.lineTo(px + face * (5.2 * u + sway), py - 11 * u + bob);
    ctx.stroke();
    ctx.strokeStyle = "#8d6e63";
    ctx.beginPath();
    ctx.moveTo(px + face * 2.3 * u, py - 7 * u + bob);
    ctx.lineTo(px + face * 3.9 * u, py - 5.4 * u + bob);
    ctx.stroke();
  } else if (activity === "trading") {
    ctx.beginPath();
    ctx.arc(px + face * 3.6 * u, py - 5.6 * u + bob, 1.3 * u, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd54f";
    ctx.fill();
    ctx.strokeStyle = "#b28704";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else if (activity === "patrolling") {
    ctx.strokeStyle = "#a1887f";
    ctx.lineWidth = Math.max(2, u * 0.6);
    ctx.beginPath();
    ctx.moveTo(px + face * 3.4 * u, py - 0.5 * u);
    ctx.lineTo(px + face * 3.4 * u, py - 13 * u + bob);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px + face * 3.4 * u, py - 15 * u + bob);
    ctx.lineTo(px + face * 2.6 * u, py - 12.6 * u + bob);
    ctx.lineTo(px + face * 4.2 * u, py - 12.6 * u + bob);
    ctx.closePath();
    ctx.fillStyle = "#cfd8dc";
    ctx.fill();
  } else if (activity === "fleeing") {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const yy = py - (4 + i * 2.6) * u + bob;
      ctx.beginPath();
      ctx.moveTo(px - face * 3.4 * u, yy);
      ctx.lineTo(px - face * (6 + i) * u, yy);
      ctx.stroke();
    }
  } else if (activity === "idle") {
    const rise = (t * 0.8) % 1;
    ctx.globalAlpha = 1 - rise;
    ctx.font = "bold " + Math.round(12 * dpr) + "px system-ui, sans-serif";
    ctx.fillStyle = "#cfd8dc";
    ctx.textAlign = "center";
    ctx.fillText("z", px + face * 3.2 * u, py - (11 + rise * 4) * u);
    ctx.globalAlpha = 1;
  }
}

function drawAnomalyRings(t) {
  const now = state.mode === "replay" ? state.playhead : state.live.tick;
  for (const a of state.anomalies) {
    const age = now - a.tick;
    if (age < 0 || age > 5) continue;
    const n = state.npcs.find((q) => q.id === a.npc_id);
    if (!n) continue;
    const r = (2 + age * 2.2) * scale * 0.6;
    ctx.strokeStyle = "rgba(239,83,80," + (1 - age / 5) + ")";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(n.x * scale, n.y * scale - 5 * scale * 0.36, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = "bold " + Math.round(12 * dpr) + "px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(239,83,80," + (1 - age / 5) + ")";
    ctx.fillText("GLITCH DETECTED", n.x * scale, n.y * scale - 22 * scale * 0.36 - r * 0.2);
  }
}

/* ---------- interaction ---------- */

function onCanvasClick(e) {
  const rect = canvas.getBoundingClientRect();
  const wx = ((e.clientX - rect.left) / rect.width) * state.meta.world.w;
  const wy = ((e.clientY - rect.top) / rect.height) * state.meta.world.h;

  if (state.probeMode) {
    state.probeMode = false;
    state.probe = { x: wx, y: wy, r: Number($("radius").value), points: [], liveIds: new Set() };
    showTab("lab");
    runSpatial();
    return;
  }

  let best = null;
  let bestD = 5;
  for (const n of state.npcs) {
    const d = Math.hypot(n.x - wx, n.y - (wy + 4));
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  if (best) selectNpc(best.id);
}

async function selectNpc(id) {
  state.selected = id;
  showTab("npc");
  $("npcEmpty").hidden = true;
  $("npcCard").hidden = false;
  await refreshProfile();
}

async function refreshProfile() {
  if (!state.selected) return;
  try {
    state.profile = await api("/api/npc/" + state.selected);
    renderProfile();
  } catch (e) { /* ignore */ }
}

function refreshProfileLive() {
  if (state.selected && state.mode === "live" && state.stats && state.stats.running) refreshProfile();
}

function bars(container, data, colorFor) {
  container.innerHTML = "";
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? entries[0][1] : 1;
  for (const [label, value] of entries) {
    const row = document.createElement("div");
    row.className = "bar";
    row.innerHTML =
      '<span class="label">' + label + '</span><span class="track"><span class="fill" style="width:' +
      (value / max) * 100 + "%;background:" + colorFor(label) + '"></span></span><span class="num">' + value + "</span>";
    container.appendChild(row);
  }
}

function renderProfile() {
  const p = state.profile;
  if (!p) return;
  $("npcName").textContent = nameOf(p.npc_id);
  $("npcId").textContent = p.npc_id;
  $("npcShard").textContent = "stored on " + p.shard;
  $("npcLat").textContent =
    "Redis lookup " + p.ms_live.toFixed(2) + " ms | MongoDB lookup " + p.ms_history.toFixed(2) +
    " ms (" + p.records + " records, routed to " + p.shard + " only)";
  bars($("barsActivity"), p.time_by_activity, actColor);
  const zoneColors = {};
  state.meta.zones.forEach((z) => { zoneColors[z.name] = z.color; });
  bars($("barsZone"), p.time_by_zone, (l) => zoneColors[l] || "#888");
  $("npcStats").textContent =
    "Distance walked: " + p.distance + " units | Impossible jumps: " + p.jumps;
  drawTimeline();
}

function drawTimeline() {
  const c = $("timeline");
  if (!c.clientWidth) return;
  const g = c.getContext("2d");
  c.width = Math.round(c.clientWidth * dpr);
  c.height = Math.round(36 * dpr);
  g.clearRect(0, 0, c.width, c.height);
  const p = state.profile;
  if (!p || !p.segments.length) return;
  const total = p.segments[p.segments.length - 1].end;
  for (const s of p.segments) {
    const x0 = ((s.start - 1) / total) * c.width;
    const w = Math.max(1, ((s.end - s.start + 1) / total) * c.width);
    g.fillStyle = actColor(s.activity);
    g.fillRect(x0, 0, w, c.height * 0.75);
  }
  const now = state.mode === "replay" ? state.playhead : state.live.tick;
  const mx = (Math.min(now, total) / total) * c.width;
  g.fillStyle = "#ffffff";
  g.fillRect(mx - 1, 0, 2 * dpr, c.height);
  g.font = Math.round(10 * dpr) + "px system-ui, sans-serif";
  g.fillStyle = "#8b9bab";
  g.textAlign = "left";
  g.fillText("1", 2, c.height - 2);
  g.textAlign = "right";
  g.fillText(String(total), c.width - 2, c.height - 2);
}

function updateNowPanel() {
  if (!state.selected || $("npcCard").hidden) return;
  const n = state.npcs.find((q) => q.id === state.selected);
  if (!n) return;
  let text = n.activity;
  if (n.activity === "walking" && n.target) text += " toward the " + n.target;
  else if (n.zone) text += " at the " + n.zone;
  text += "  (position " + n.x.toFixed(1) + ", " + n.y.toFixed(1) + ")";
  $("npcNow").textContent = "Right now: " + text;
  drawTimeline();
}

/* ---------- query lab ---------- */

function showQuery(text) {
  const el = $("queryShown");
  el.textContent = text;
  el.classList.add("show");
}

async function runBenchmark() {
  if (!state.probe) {
    $("benchResult").innerHTML = '<div class="result">Place a probe on the map first.</div>';
    return;
  }
  const btn = $("btnBenchmark");
  btn.textContent = "Running...";
  const q = new URLSearchParams({
    x: state.probe.x.toFixed(2), y: state.probe.y.toFixed(2), radius: state.probe.r,
  });
  try {
    const r = await api("/api/index_benchmark?" + q.toString());
    const max = Math.max(r.indexed_ms, r.scan_ms, 0.01);
    $("benchResult").innerHTML =
      '<div class="result"><h4>Same query, same data, only the access path changes</h4>' +
      '<div class="bench-bar">' +
      '<div class="bench-row"><span class="label">With 2dsphere index</span>' +
      '<span class="track"><span class="fill indexed" style="width:' + (r.indexed_ms / max * 100) + '%"></span></span>' +
      '<span class="num">' + r.indexed_ms + ' ms</span></div>' +
      '<div class="bench-row"><span class="label">Forced full scan</span>' +
      '<span class="track"><span class="fill scan" style="width:' + (r.scan_ms / max * 100) + '%"></span></span>' +
      '<span class="num">' + r.scan_ms + ' ms</span></div>' +
      '</div>' +
      '<div class="meta">Indexed plan: ' + r.indexed_plan + " | Full scan plan: " + r.scan_plan +
      " | " + r.documents_scanned + " documents in this shard, fastest of " + r.reps + " runs each.</div></div>";
  } catch (e) {
    $("benchResult").innerHTML = '<div class="result">Benchmark failed: ' + e.message + "</div>";
  }
  btn.textContent = "Compare: with index vs without";
}

async function runSpatial() {
  if (!state.probe) {
    $("labResult").innerHTML = '<div class="result">Place a probe on the map first, or pick a place name above.</div>';
    return;
  }
  state.probe.r = Number($("radius").value);
  const q = new URLSearchParams({
    x: state.probe.x.toFixed(2), y: state.probe.y.toFixed(2), radius: state.probe.r,
    t_from: $("qFrom").value || 1, t_to: $("qTo").value || state.meta.max_ticks,
  });
  showQuery(
    "Redis:  GEOSEARCH npc:live:positions FROMLONLAT <probe> BYRADIUS " + state.probe.r + "\n\n" +
    "MongoDB:  db.history.find({\n" +
    "  location: { $geoWithin: { $centerSphere: [[<probe lon>, <probe lat>], radius] } },\n" +
    "  tick: { $gte: " + ($("qFrom").value || 1) + ", $lte: " + ($("qTo").value || state.meta.max_ticks) + " }\n" +
    "})  -- run against both shards, results merged"
  );
  try {
    const r = await api("/api/nearby?" + q.toString());
    state.probe.points = r.history.points;
    state.probe.liveIds = new Set(r.live.map((x) => x.id));
    renderSpatial(r);
  } catch (e) {
    $("labResult").innerHTML = '<div class="result">Query failed: ' + e.message + "</div>";
  }
}

function renderSpatial(r) {
  const liveList = r.live.length
    ? "<ul>" + r.live.map((x) => "<li>" + nameOf(x.id) + " - " + x.distance + " units away</li>").join("") + "</ul>"
    : "<div>Nobody is inside the circle right now.</div>";
  const hist = r.history.per_npc.slice(0, 8).map((x) =>
    '<div class="bar"><span class="label">' + nameOf(x.id) + '</span><span class="track"><span class="fill" style="width:' +
    (x.ticks / r.history.per_npc[0].ticks) * 100 + '%;background:#4fc3f7"></span></span><span class="num">' + x.ticks + "</span></div>"
  ).join("");
  $("labResult").innerHTML =
    '<div class="result"><h4>Redis (GEOSEARCH) - who is here right now</h4>' + liveList +
    '<div class="meta">' + r.ms_live.toFixed(2) + " ms. Redis only knows the present moment.</div></div>" +
    '<div class="result"><h4>MongoDB ($geoWithin plus tick filter) - who has been here</h4>' +
    "<div>" + r.history.records + " position records fall inside this circle. Ticks spent inside, per character:</div>" +
    (hist || "<div>No records.</div>") +
    '<div class="meta">' + r.ms_history.toFixed(2) + " ms. Scatter-gather: asked " + r.shards_queried.join(" and ") +
    " and merged the answers. Blue dots on the map are the recorded positions.</div></div>";
}

async function runMemory() {
  const q = new URLSearchParams({
    npc: $("memNpc").value, t_from: $("mFrom").value || 1, t_to: $("mTo").value || state.meta.max_ticks,
  });
  showQuery(
    "MongoDB:  shard_for(" + $("memNpc").value + ").find({\n" +
    "  npc_id: \"" + $("memNpc").value + "\",\n" +
    "  tick: { $gte: " + ($("mFrom").value || 1) + ", $lte: " + ($("mTo").value || state.meta.max_ticks) + " }\n" +
    "})  -- routed to exactly one shard, the other is never touched"
  );
  try {
    const r = await api("/api/memory?" + q.toString());
    const rows = r.segments.map((s) => {
      const where = s.activity === "walking" ? "toward the " + s.place : (s.place ? "at the " + s.place : "");
      return "<li>tick " + s.start + " to " + s.end + ": " + s.activity + " " + where + "</li>";
    }).join("");
    $("memResult").innerHTML =
      '<div class="result"><h4>' + nameOf(r.npc_id) + " between tick " + $("mFrom").value + " and " + $("mTo").value + "</h4>" +
      (rows ? "<ul>" + rows + "</ul>" : "<div>No records in that range.</div>") +
      '<div class="meta">Routed to ' + r.shard + " only (" + r.records + " records, " + r.ms.toFixed(2) + " ms). The other shard was never touched.</div></div>";
  } catch (e) {
    $("memResult").innerHTML = '<div class="result">Query failed: ' + e.message + "</div>";
  }
}

/* ---------- alerts ---------- */

async function scanAlerts() {
  try {
    state.anomalies = await api("/api/anomalies");
    state.lastScanTick = state.stats ? state.stats.tick : 0;
    renderAlerts();
  } catch (e) { /* ignore */ }
}

function renderAlerts() {
  $("alertCount").textContent = state.anomalies.length;
  const box = $("alertList");
  box.innerHTML = "";
  if (!state.anomalies.length) {
    box.innerHTML = '<div class="empty" style="margin-top:10px">No anomalies found in the stored history.</div>';
    return;
  }
  for (const a of state.anomalies) {
    const b = document.createElement("button");
    b.className = "alert";
    b.textContent =
      a.name + " moved " + a.distance + " units in a single tick at tick " + a.tick + " (" + a.times_typical +
      "x its usual step). Click to jump there.";
    b.onclick = async () => {
      await seekTo(Math.max(1, a.tick - 3));
      state.selected = a.npc_id;
      selectNpc(a.npc_id);
    };
    box.appendChild(b);
  }
}

init();
