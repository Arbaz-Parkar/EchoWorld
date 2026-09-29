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

/* ---------- setup ---------- */

async function init() {
  state.meta = await api("/api/meta");
  buildLegend();
  buildZoneChips();
  buildNpcSelect();
  wireEvents();
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
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
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
  $("npcCard").hidden = true;
  $("npcEmpty").hidden = false;
  $("labResult").innerHTML = "";
  $("memResult").innerHTML = "";
  renderAlerts();
  updateScrub();
  updatePlayButton();
}

async function setMode(mode) {
  state.mode = mode;
  state.playing = false;
  updatePlayButton();
  $("modeLive").classList.toggle("active", mode === "live");
  $("modeReplay").classList.toggle("active", mode === "replay");
  if (mode === "replay") {
    state.frames.clear();
    state.maxTick = 0;
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
  }
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

function draw(t) {
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  drawGround(W, H);
  drawZones();
  if (state.showTrails) drawTrails();
  drawProbe();
  const sorted = state.npcs.slice().sort((a, b) => a.y - b.y);
  sorted.forEach((n) => drawAvatar(n, t));
  drawAnomalyRings(t);
}

function drawGround(W, H) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#1d2f24");
  g.addColorStop(1, "#15241b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
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

  ctx.strokeStyle = "rgba(150,125,85,0.28)";
  ctx.lineWidth = scale * 2.2;
  ctx.lineCap = "round";
  const zs = state.meta.zones;
  for (let i = 0; i < zs.length; i++) {
    for (let j = i + 1; j < zs.length; j++) {
      ctx.beginPath();
      ctx.moveTo(zs[i].x * scale, zs[i].y * scale);
      ctx.lineTo(zs[j].x * scale, zs[j].y * scale);
      ctx.stroke();
    }
  }
}

function drawZones() {
  for (const z of state.meta.zones) {
    const cx = z.x * scale;
    const cy = z.y * scale;
    const r = z.r * scale;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = z.color + "55";
    ctx.fill();
    ctx.setLineDash([scale * 0.8, scale * 0.8]);
    ctx.strokeStyle = z.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    const u = scale * 0.5;
    ctx.fillStyle = z.color;
    ctx.fillRect(cx - 4 * u, cy - 3 * u, 8 * u, 5 * u);
    ctx.beginPath();
    ctx.moveTo(cx - 5 * u, cy - 3 * u);
    ctx.lineTo(cx, cy - 7 * u);
    ctx.lineTo(cx + 5 * u, cy - 3 * u);
    ctx.closePath();
    ctx.fillStyle = "#c9b48a";
    ctx.fill();

    ctx.font = "bold " + Math.round(12 * dpr) + "px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fillText(z.name.toUpperCase(), cx, cy + r + 14 * dpr);
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

  // legs
  ctx.strokeStyle = "#263238";
  ctx.lineWidth = Math.max(2, u * 0.9);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(px - 0.9 * u, py - 3 * u + bob);
  ctx.lineTo(px - 0.9 * u + swing, py);
  ctx.moveTo(px + 0.9 * u, py - 3 * u + bob);
  ctx.lineTo(px + 0.9 * u - swing, py);
  ctx.stroke();

  // body
  rr(ctx, px - 2.2 * u, py - 8 * u + bob, 4.4 * u, 5.4 * u, u);
  ctx.fillStyle = "hsl(" + hue + ",55%,48%)";
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // head, hair, eyes
  ctx.beginPath();
  ctx.arc(px, py - 10.4 * u + bob, 2.1 * u, 0, Math.PI * 2);
  ctx.fillStyle = "#f1c9a5";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(px, py - 10.6 * u + bob, 2.15 * u, Math.PI, 0);
  ctx.fillStyle = "hsl(" + hue + ",35%,22%)";
  ctx.fill();
  ctx.fillStyle = "#222";
  ctx.beginPath();
  ctx.arc(px + face * 0.8 * u, py - 10.2 * u + bob, 0.28 * u, 0, Math.PI * 2);
  ctx.arc(px + face * 1.5 * u, py - 10.2 * u + bob, 0.28 * u, 0, Math.PI * 2);
  ctx.fill();

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