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
  performance: { snapshot: null, querySamples: [], indexComparison: null, loading: false },
  runCatalog: [],
  comparison: null,
  comparisonTickTouched: false,
  showTrails: true,
  mapFilter: "all",
  camera: { zoom: 1, panX: 0, panY: 0, drag: null, suppressClick: false },
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
const minimap = $("minimapMap");
const minimapCtx = minimap.getContext("2d");
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

function activeRunId() {
  return (state.stats && state.stats.run_id) || state.meta.run_id;
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
  if (prev && prev.routine !== curr.routine && curr.routine) {
    if (curr.routine === "sleep") return name + " finished the day and is heading home to sleep.";
    if (curr.routine === "work") return name + " started a shift at the " + roleOf(id) + ".";
    return name + " finished work and has free time to explore.";
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
    state.tickerPrevLive.set(n.id, {
      activity: n.activity, zone: n.zone, target: n.target, routine: n.routine,
    });
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
  buildMapNavigation();
  renderConcepts();
  buildScenery();
  wireEvents();
  updatePlaybackControls();
  wireOnboarding();
  startTickerRotation();
  resize();
  $("qTo").value = state.meta.max_ticks;
  $("mTo").value = 100;
  $("npcCount").max = state.meta.max_npcs;
  $("npcCount").value = state.meta.npc_count;
  $("npcCountLabel").textContent = state.meta.npc_count;
  updateRadiusLabel();
  await pollStats();
  await pollLive();
  await refreshRunCatalog();
  setInterval(pollLive, 250);
  setInterval(pollStats, 1000);
  setInterval(refreshProfileLive, 3000);
  setInterval(() => {
    if ($("tab-scale").classList.contains("active")) refreshScalability();
  }, 2500);
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

function buildMapNavigation() {
  const options = $("npcOptions");
  options.replaceChildren();
  for (const npc of state.meta.npcs) {
    const option = document.createElement("option");
    option.value = npc.name + " (" + npc.id + ")";
    options.appendChild(option);
  }

  const districtSelect = $("districtSelect");
  districtSelect.replaceChildren();
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All districts";
  districtSelect.appendChild(all);
  for (const zone of state.meta.zones) {
    const option = document.createElement("option");
    option.value = zone.name;
    option.textContent = zone.name;
    districtSelect.appendChild(option);
  }
  districtSelect.value = state.mapFilter;
  updateDistrictStatus();
}

function wireEvents() {
  window.addEventListener("resize", () => { resize(); redrawComparison(); });
  canvas.addEventListener("click", onCanvasClick);
  canvas.addEventListener("wheel", onMapWheel, { passive: false });
  canvas.addEventListener("pointerdown", startMapPan);
  canvas.addEventListener("pointermove", moveMapPan);
  canvas.addEventListener("pointerup", endMapPan);
  canvas.addEventListener("pointercancel", endMapPan);

  $("btnZoomIn").onclick = () => zoomMap(state.camera.zoom * 1.25);
  $("btnZoomOut").onclick = () => zoomMap(state.camera.zoom / 1.25);
  $("btnResetView").onclick = resetMapView;
  $("btnFindNpc").onclick = findNpc;
  $("npcSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") findNpc();
  });
  $("btnToggleMinimap").onclick = toggleMinimap;
  minimap.addEventListener("click", onMinimapClick);
  $("districtSelect").onchange = (event) => {
    setDistrictFilter(event.target.value);
    const zone = state.meta.zones.find((item) => item.name === event.target.value);
    if (zone) setCameraCenter(zone.x, zone.y, Math.max(state.camera.zoom, 1.45));
  };

  $("modeLive").onclick = () => setMode("live");
  $("modeReplay").onclick = () => setMode("replay");

  $("btnStart").onclick = () => simCall("/api/sim/start");
  $("btnPause").onclick = () => simCall("/api/sim/pause");
  $("btnReset").onclick = async () => {
    const seed = $("runSeed").value.trim();
    const query = seed ? "?seed=" + encodeURIComponent(seed) : "";
    await api("/api/sim/reset" + query, { method: "POST" });
    state.meta = await api("/api/meta");
    clearAll();
    buildNpcSelect();
    buildMapNavigation();
    await setMode("live");
    updateRunSeedStatus();
    await pollStats();
    await pollLive();
    await refreshRunCatalog();
  };
  $("btnNewRun").onclick = startNewRun;
  $("runSeed").addEventListener("keydown", (event) => {
    if (event.key === "Enter") startNewRun();
  });
  $("btnCopySeed").onclick = () => {
    $("runSeed").value = state.meta.seed || "";
    $("runSeed").focus();
  };
  $("btnFF").onclick = async () => {
    $("btnFF").disabled = true;
    $("btnFF").textContent = "Generating...";
    await simCall("/api/sim/fast_forward?ticks=300");
    $("btnFF").disabled = false;
    $("btnFF").textContent = "Generate 300 ticks";
    scanAlerts();
    if (state.selected) await refreshProfile();
    if ($("tab-scale").classList.contains("active")) await refreshScalability();
    if ($("tab-compare").classList.contains("active")) await refreshRunCatalog();
  };
  $("npcCount").oninput = (e) => { $("npcCountLabel").textContent = e.target.value; };
  $("btnApplyNpcCount").onclick = configureNpcCount;
  $("btnCompareRuns").onclick = compareRuns;
  $("btnRefreshRuns").onclick = refreshRunCatalog;
  $("compareRunA").onchange = () => { updateCompareTickLimit(); invalidateComparison(); };
  $("compareRunB").onchange = () => { updateCompareTickLimit(); invalidateComparison(); };
  $("compareTick").oninput = () => {
    state.comparisonTickTouched = true;
    invalidateComparison();
  };
  $("btnScaleQuery").onclick = sampleQueryLatency;
  $("btnScaleBenchmark").onclick = runBenchmark;

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
  clampCamera();
  updateZoomLabel();
}

function updateZoomLabel() {
  $("zoomLabel").textContent = Math.round(state.camera.zoom * 100) + "%";
}

function clampCamera() {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || canvas.clientWidth || 900;
  const height = rect.height || canvas.clientHeight || width * state.meta.world.h / state.meta.world.w;
  const maxX = width * (state.camera.zoom - 1) / 2;
  const maxY = height * (state.camera.zoom - 1) / 2;
  state.camera.panX = Math.max(-maxX, Math.min(maxX, state.camera.panX));
  state.camera.panY = Math.max(-maxY, Math.min(maxY, state.camera.panY));
}

function zoomMap(nextZoom, anchorX, anchorY) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  const x = anchorX === undefined ? centerX : anchorX;
  const y = anchorY === undefined ? centerY : anchorY;
  const oldZoom = state.camera.zoom;
  const newZoom = Math.max(1, Math.min(4, nextZoom));
  const baseX = (x - centerX - state.camera.panX) / oldZoom + centerX;
  const baseY = (y - centerY - state.camera.panY) / oldZoom + centerY;
  state.camera.zoom = newZoom;
  state.camera.panX = x - centerX - newZoom * (baseX - centerX);
  state.camera.panY = y - centerY - newZoom * (baseY - centerY);
  clampCamera();
  updateZoomLabel();
}

function setCameraCenter(worldX, worldY, nextZoom = state.camera.zoom) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  state.camera.zoom = Math.max(1, Math.min(4, nextZoom));
  const baseX = worldX / state.meta.world.w * rect.width;
  const baseY = worldY / state.meta.world.h * rect.height;
  state.camera.panX = (rect.width / 2) - state.camera.zoom * (baseX - rect.width / 2);
  state.camera.panY = (rect.height / 2) - state.camera.zoom * (baseY - rect.height / 2);
  clampCamera();
  updateZoomLabel();
}

function resetMapView() {
  state.camera.zoom = 1;
  state.camera.panX = 0;
  state.camera.panY = 0;
  clampCamera();
  updateZoomLabel();
}

function onMapWheel(e) {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const direction = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  zoomMap(state.camera.zoom * direction, e.clientX - rect.left, e.clientY - rect.top);
}

function startMapPan(e) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  state.camera.drag = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    lastX: e.clientX,
    lastY: e.clientY,
    moved: false,
  };
  canvas.setPointerCapture(e.pointerId);
}

function moveMapPan(e) {
  const drag = state.camera.drag;
  if (!drag || drag.pointerId !== e.pointerId) return;
  if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3) drag.moved = true;
  if (!drag.moved) return;
  state.camera.panX += e.clientX - drag.lastX;
  state.camera.panY += e.clientY - drag.lastY;
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
  clampCamera();
  canvas.style.cursor = "grabbing";
}

function endMapPan(e) {
  const drag = state.camera.drag;
  if (!drag || drag.pointerId !== e.pointerId) return;
  state.camera.suppressClick = drag.moved;
  state.camera.drag = null;
  canvas.style.cursor = "grab";
  if (state.camera.suppressClick) {
    setTimeout(() => { state.camera.suppressClick = false; }, 250);
  }
}

function setDistrictFilter(district) {
  state.mapFilter = district;
  $("districtSelect").value = district;
  updateDistrictStatus();
}

function npcMatchesActiveDistrict(npc) {
  return state.mapFilter === "all" || npc.zone === state.mapFilter || npc.target === state.mapFilter;
}

function updateDistrictStatus() {
  const visible = state.npcs.filter(npcMatchesActiveDistrict).length;
  const label = state.mapFilter === "all" ? "all districts" : state.mapFilter;
  const text = "Showing " + visible + " / " + state.npcs.length + " NPCs in " + label;
  if ($("districtStatus").textContent !== text) $("districtStatus").textContent = text;
}

function onMinimapClick(e) {
  const rect = minimap.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
  setCameraCenter(x * state.meta.world.w, y * state.meta.world.h);
}

function drawMinimap() {
  if (!state.meta || minimap.hidden) return;
  const width = minimap.width;
  const height = minimap.height;
  const world = state.meta.world;
  const sx = width / world.w;
  const sy = height / world.h;
  const mx = (x) => x * sx;
  const my = (y) => y * sy;

  minimapCtx.clearRect(0, 0, width, height);
  minimapCtx.fillStyle = "#243629";
  minimapCtx.fillRect(0, 0, width, height);
  minimapCtx.fillStyle = "#625b49";
  minimapCtx.beginPath();
  minimapCtx.ellipse(mx(50), my(40), mx(45), my(34), 0, 0, Math.PI * 2);
  minimapCtx.fill();
  minimapCtx.strokeStyle = "rgba(221,199,154,0.65)";
  minimapCtx.lineWidth = 2;
  minimapCtx.stroke();

  minimapCtx.strokeStyle = "rgba(221,199,154,0.32)";
  minimapCtx.lineWidth = 2;
  minimapCtx.beginPath();
  minimapCtx.moveTo(mx(50), my(40));
  for (const zone of state.meta.zones) {
    minimapCtx.moveTo(mx(50), my(40));
    minimapCtx.lineTo(mx(zone.x), my(zone.y));
  }
  minimapCtx.stroke();

  for (const zone of state.meta.zones) {
    minimapCtx.beginPath();
    minimapCtx.arc(mx(zone.x), my(zone.y), Math.max(3, zone.r * sx * 0.55), 0, Math.PI * 2);
    minimapCtx.fillStyle = zone.name === state.mapFilter ? "#e8bd64" : zone.color;
    minimapCtx.globalAlpha = 0.78;
    minimapCtx.fill();
    minimapCtx.globalAlpha = 1;
  }

  for (const npc of state.npcs) {
    minimapCtx.beginPath();
    minimapCtx.arc(mx(npc.x), my(npc.y), npc.id === state.selected ? 3.2 : 2, 0, Math.PI * 2);
    minimapCtx.fillStyle = npc.id === state.selected ? "#ffffff" : "#62d5ff";
    minimapCtx.globalAlpha = npcMatchesActiveDistrict(npc) ? 1 : 0.28;
    minimapCtx.fill();
    minimapCtx.globalAlpha = 1;
  }

  const rect = canvas.getBoundingClientRect();
  if (rect.width && rect.height) {
    const leftBase = (0 - rect.width / 2 - state.camera.panX) / state.camera.zoom + rect.width / 2;
    const topBase = (0 - rect.height / 2 - state.camera.panY) / state.camera.zoom + rect.height / 2;
    const visibleWidth = rect.width / state.camera.zoom;
    const visibleHeight = rect.height / state.camera.zoom;
    const left = Math.max(0, Math.min(width, leftBase / rect.width * width));
    const top = Math.max(0, Math.min(height, topBase / rect.height * height));
    const right = Math.max(left, Math.min(width, (leftBase + visibleWidth) / rect.width * width));
    const bottom = Math.max(top, Math.min(height, (topBase + visibleHeight) / rect.height * height));
    minimapCtx.fillStyle = "rgba(255,255,255,0.07)";
    minimapCtx.fillRect(left, top, right - left, bottom - top);
    minimapCtx.strokeStyle = "#ffffff";
    minimapCtx.lineWidth = 2;
    minimapCtx.setLineDash([5, 3]);
    minimapCtx.strokeRect(left, top, right - left, bottom - top);
    minimapCtx.setLineDash([]);
  }
}

async function findNpc() {
  const query = $("npcSearch").value.trim().toLocaleLowerCase();
  if (!query) {
    $("npcSearchStatus").textContent = "Enter a name or NPC ID.";
    return;
  }
  const entries = state.meta.npcs;
  let npc = entries.find((item) =>
    item.id.toLocaleLowerCase() === query || item.name.toLocaleLowerCase() === query ||
    (item.name + " (" + item.id + ")").toLocaleLowerCase() === query
  );
  if (!npc) {
    const matches = entries.filter((item) =>
      item.id.toLocaleLowerCase().includes(query) || item.name.toLocaleLowerCase().includes(query)
    );
    if (matches.length === 1) npc = matches[0];
  }
  if (!npc) {
    $("npcSearchStatus").textContent = "Choose one NPC from the suggestions.";
    return;
  }

  setDistrictFilter("all");
  const position = state.npcs.find((item) => item.id === npc.id);
  const fallbackZone = state.meta.zones.find((zone) => zone.name === npc.role);
  const target = position || fallbackZone;
  if (target) setCameraCenter(target.x, target.y, Math.max(state.camera.zoom, 2));
  $("npcSearchStatus").textContent = "Focused on " + npc.name + " (" + npc.id + ").";
  await selectNpc(npc.id);
}

function toggleMinimap() {
  minimap.hidden = !minimap.hidden;
  const button = $("btnToggleMinimap");
  button.textContent = minimap.hidden ? "Show" : "Hide";
  button.setAttribute("aria-expanded", minimap.hidden ? "false" : "true");
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
  if (name === "npc") drawTimeline();
  if (name === "scale") {
    refreshScalability();
    drawPerformanceCharts();
  }
  if (name === "compare") refreshRunCatalog();
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
  state.mapFilter = "all";
  state.selected = null;
  state.profile = null;
  state.performance.snapshot = null;
  state.performance.indexComparison = null;
  state.comparison = null;
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
  $("compareSummary").textContent = "";
  $("compareMetaA").textContent = "";
  $("compareMetaB").textContent = "";
  redrawComparison();
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
  $("pSource").textContent = "Source: Redis, " + d.ms.toFixed(2) + " ms (all " + state.meta.npcs.length + " NPCs, one round trip)";
}

async function pollStats() {
  try {
    const s = await api("/api/stats");
    state.stats = s;
    if (state.meta && s.seed) state.meta.seed = s.seed;
    updateRunSeedStatus();
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

function gameTimeAtTick(tick) {
  const timing = state.meta.game_time;
  const totalMinutes = timing.start_minutes + Math.max(0, tick) * timing.minutes_per_tick;
  const elapsedDays = Math.floor(totalMinutes / 1440);
  const minutes = Math.floor(totalMinutes % 1440);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  let phase = "Day";
  if (hour < 5 || hour >= 21) phase = "Night";
  else if (hour < 7) phase = "Dawn";
  else if (hour >= 18) phase = "Dusk";
  return {
    day: elapsedDays + 1,
    minutes,
    hour: (totalMinutes % 1440) / 60,
    phase,
    label: "Day " + (elapsedDays + 1) + " · " + String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0"),
  };
}

function updateWorldClock() {
  const tick = state.mode === "live" ? state.live.tick : state.playhead;
  const time = gameTimeAtTick(tick);
  $("worldTime").textContent = time.label;
  $("worldPhase").textContent = time.phase;
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
      out.push({
        id, x: d.x, y: d.y, activity: t.activity, zone: t.zone,
        target: t.target, routine: t.routine,
      });
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
          activity: a.activity, zone: a.zone, target: a.target, routine: a.routine,
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
  updateWorldClock();

  state.npcs = currentNpcs(dt);
  updateDistrictStatus();
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
  const inCity = (x, y) => ((x - 50) / 46) ** 2 + ((y - 40) / 34) ** 2 < 1;
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
  for (let i = 0; i < 75; i++) {
    const x = rand() * w, y = rand() * h;
    if (inCity(x, y) || inAnyZone(x, y, 6)) continue;
    props.push({ x, y, kind: kinds[Math.floor(rand() * kinds.length)], scale: 0.7 + rand() * 0.6 });
  }

  const fireflies = [];
  for (let i = 0; i < 12; i++) {
    fireflies.push({ x: rand() * w, y: rand() * h, phase: rand() * Math.PI * 2, speed: 0.3 + rand() * 0.4 });
  }

  const houses = (state.meta.houses || []).map((house) => ({ ...house }));
  state.scenery = { ground, grass, props, fireflies, houses };
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

function drawFireflies(t, nightAmount) {
  if (!state.scenery || nightAmount < 0.12) return;
  for (const f of state.scenery.fireflies) {
    const px = (f.x + Math.sin(t * f.speed + f.phase) * 2) * scale;
    const py = (f.y + Math.cos(t * f.speed * 0.7 + f.phase) * 2) * scale;
    const glow = nightAmount * Math.max(0.15, 0.4 + Math.sin(t * 2 + f.phase) * 0.3);
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
  const worldTime = gameTimeAtTick(state.mode === "live" ? state.live.tick : state.playhead);
  const daylight = Math.max(0, Math.sin((worldTime.hour - 6) * Math.PI / 12));
  const nightAmount = 1 - daylight;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.setTransform(
    state.camera.zoom, 0, 0, state.camera.zoom,
    (W * (1 - state.camera.zoom) / 2) + state.camera.panX * dpr,
    (H * (1 - state.camera.zoom) / 2) + state.camera.panY * dpr,
  );
  drawGround(W, H);
  drawScenery();
  drawCityWall();
  drawCitadel();
  drawRoadNetwork();
  drawCityBlocks();
  drawZones();
  ctx.fillStyle = "rgba(13, 22, 48, " + (nightAmount * 0.48) + ")";
  ctx.fillRect(0, 0, W, H);
  const dawnGlow = Math.max(0, 1 - Math.abs(worldTime.hour - 6) / 2);
  const duskGlow = Math.max(0, 1 - Math.abs(worldTime.hour - 18) / 2);
  const warmGlow = Math.max(dawnGlow, duskGlow) * 0.12;
  if (warmGlow > 0) {
    ctx.fillStyle = "rgba(220, 143, 73, " + warmGlow + ")";
    ctx.fillRect(0, 0, W, H);
  }
  if (state.showTrails) drawTrails();
  drawProbe();
  const sorted = state.npcs.filter(npcMatchesActiveDistrict).slice().sort((a, b) => a.y - b.y);
  sorted.forEach((n) => drawAvatar(n, t));
  drawAnomalyRings(t);
  drawFireflies(t, nightAmount);
  ctx.restore();
  drawVignette(W, H);
  drawMinimap();
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

  const city = ctx.createLinearGradient(0, H * 0.08, 0, H * 0.94);
  city.addColorStop(0, "#746b56");
  city.addColorStop(0.48, "#625b49");
  city.addColorStop(1, "#504c40");
  ctx.fillStyle = city;
  ctx.beginPath();
  ctx.ellipse(W * 0.5, H * 0.5, W * 0.46, H * 0.425, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(221,199,154,0.13)";
  ctx.lineWidth = Math.max(1, scale * 0.48);
  ctx.stroke();

  const hill = ctx.createRadialGradient(W * 0.5, H * 0.16, 0, W * 0.5, H * 0.16, W * 0.2);
  hill.addColorStop(0, "rgba(202,181,136,0.19)");
  hill.addColorStop(1, "rgba(202,181,136,0)");
  ctx.fillStyle = hill;
  ctx.fillRect(0, 0, W, H * 0.5);

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

function drawCityWall() {
  const cx = 50, cy = 40, rx = 45, ry = 34;
  const arcs = [[0, 1.45], [1.69, Math.PI * 2]];
  ctx.lineCap = "round";
  for (const layer of [
    { color: "rgba(25,25,22,0.72)", width: 2.3 },
    { color: "#554f43", width: 1.8 },
    { color: "#a99b7d", width: 0.72 },
  ]) {
    ctx.strokeStyle = layer.color;
    ctx.lineWidth = scale * layer.width;
    for (const [start, end] of arcs) {
      ctx.beginPath();
      ctx.ellipse(cx * scale, cy * scale, rx * scale, ry * scale, 0, start, end);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = "rgba(217,202,170,0.46)";
  ctx.lineWidth = Math.max(1, scale * 0.12);
  for (let angle = 0.025; angle < Math.PI * 2; angle += 0.055) {
    if (angle > 1.41 && angle < 1.73) continue;
    const x = cx + Math.cos(angle) * rx;
    const y = cy + Math.sin(angle) * ry;
    const tx = -Math.sin(angle), ty = Math.cos(angle);
    ctx.beginPath();
    ctx.moveTo((x - tx * 0.28) * scale, (y - ty * 0.28) * scale);
    ctx.lineTo((x + tx * 0.28) * scale, (y + ty * 0.28) * scale);
    ctx.stroke();
  }

  const towers = [
    [50, 6], [78, 10], [94, 25], [95, 50],
    [80, 67], [20, 67], [5, 50], [6, 25], [22, 10],
  ];
  for (const [x, y] of towers) drawWallTower(x, y);
  drawGatehouse();
}

function drawCitadel() {
  ctx.save();
  ctx.translate(50 * scale, 17 * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(17,18,17,0.32)";
  ctx.beginPath(); ctx.ellipse(0, 1.7, 14.2, 8.7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#4e4b40";
  ctx.beginPath(); ctx.ellipse(0, 0, 13.8, 8.2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#746b56";
  ctx.beginPath(); ctx.ellipse(0, -0.35, 11.6, 6.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#b3a17d"; ctx.lineWidth = 0.2;
  ctx.beginPath(); ctx.ellipse(0, -0.35, 9.5, 5.2, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#8b7d60";
  ctx.beginPath(); ctx.ellipse(0, -0.75, 7.7, 4.1, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#6c604d";
  for (let i = 0; i < 4; i++) {
    rr(ctx, -2.7 + i * 1.45, 6.3 + i * 0.56, 5.4 - i * 0.9, 0.42, 0.12);
    ctx.fill();
  }
  ctx.restore();
}

function drawCottage(house) {
  ctx.save();
  ctx.translate(house.x * scale, house.y * scale);
  ctx.scale(scale * house.scale, scale * house.scale);
  ctx.fillStyle = "rgba(22,19,16,0.32)";
  ctx.beginPath(); ctx.ellipse(0.2, 0.6, 2.7, 1.25, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#554838";
  ctx.beginPath();
  ctx.moveTo(-2.25, -1.9); ctx.lineTo(0, -3.05); ctx.lineTo(2.25, -1.9);
  ctx.lineTo(2.05, 0.35); ctx.lineTo(-1.95, 0.35); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#a98e68";
  ctx.beginPath();
  ctx.moveTo(-1.75, -1.65); ctx.lineTo(0, -2.55); ctx.lineTo(1.75, -1.65);
  ctx.lineTo(1.75, -0.15); ctx.lineTo(-1.75, -0.15); ctx.closePath(); ctx.fill();
  ctx.fillStyle = house.roof;
  ctx.beginPath();
  ctx.moveTo(-2.55, -1.8); ctx.lineTo(0, -3.35); ctx.lineTo(2.55, -1.8);
  ctx.lineTo(1.95, -0.72); ctx.lineTo(0, -1.9); ctx.lineTo(-1.95, -0.72); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "rgba(218,191,147,0.56)"; ctx.lineWidth = 0.11;
  for (const x of [-1.65, -0.85, 0, 0.85, 1.65]) {
    ctx.beginPath(); ctx.moveTo(x, -2.12 + Math.abs(x) * 0.12); ctx.lineTo(x * 0.55, -1.9); ctx.stroke();
  }
  ctx.fillStyle = "#4b3729";
  rr(ctx, -0.48, -1.35, 0.96, 1.7, 0.26); ctx.fill();
  ctx.fillStyle = "#e4bc69";
  ctx.fillRect(-1.45, -1.45, 0.42, 0.5);
  ctx.fillRect(1.02, -1.45, 0.42, 0.5);
  ctx.fillStyle = "#57483a";
  ctx.fillRect(1.25, -2.95, 0.52, 1.0);
  ctx.fillStyle = "#8d7a60";
  ctx.fillRect(1.18, -3.08, 0.66, 0.2);
  ctx.restore();
}

function drawCityBlocks() {
  if (!state.scenery) return;
  const houses = state.scenery.houses.slice().sort((a, b) => a.y - b.y);
  for (const house of houses) drawCottage(house);
}

function drawWallTower(x, y) {
  ctx.save();
  ctx.translate(x * scale, y * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(18,19,17,0.36)";
  ctx.beginPath(); ctx.ellipse(0, 0.65, 2.2, 1.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#4e493f";
  ctx.beginPath(); ctx.ellipse(0, 0, 2.05, 1.75, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#928a76";
  ctx.beginPath(); ctx.ellipse(0, -0.18, 1.68, 1.38, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#c0b18c"; ctx.lineWidth = 0.13;
  ctx.beginPath(); ctx.ellipse(0, -0.18, 1.27, 1.02, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#5c5548";
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    ctx.fillRect(Math.cos(a) * 1.48 - 0.22, Math.sin(a) * 1.22 - 0.22, 0.44, 0.44);
  }
  ctx.fillStyle = "#3e3a33";
  ctx.beginPath(); ctx.arc(0, 0, 0.38, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawGatehouse() {
  ctx.save();
  ctx.translate(50 * scale, 73.3 * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(17,18,16,0.44)";
  ctx.beginPath(); ctx.ellipse(0, 1.45, 7.1, 1.7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#575145";
  rr(ctx, -6.6, -1.8, 13.2, 3.3, 0.35); ctx.fill();
  ctx.fillStyle = "#a09882";
  rr(ctx, -5.9, -2.2, 11.8, 2.9, 0.25); ctx.fill();
  ctx.fillStyle = "#39372f";
  ctx.beginPath();
  ctx.moveTo(-1.9, 0.7); ctx.lineTo(-1.9, -0.95);
  ctx.quadraticCurveTo(0, -3.2, 1.9, -0.95); ctx.lineTo(1.9, 0.7); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#7e7158";
  for (const x of [-5.35, 5.35]) {
    rr(ctx, x - 1.15, -3.4, 2.3, 4.8, 0.18); ctx.fill();
    ctx.fillStyle = "#c1b18e";
    for (let i = -0.75; i <= 0.76; i += 0.75) ctx.fillRect(x + i - 0.24, -3.72, 0.48, 0.42);
    ctx.fillStyle = "#7e7158";
  }
  ctx.strokeStyle = "#c09a58"; ctx.lineWidth = 0.14;
  for (let x = -1.15; x <= 1.16; x += 0.58) {
    ctx.beginPath(); ctx.moveTo(x, -0.25); ctx.lineTo(x, 0.62); ctx.stroke();
  }
  ctx.restore();
}

function routeForZone(z) {
  const hub = { x: state.meta.world.w / 2, y: state.meta.world.h / 2 };
  const dx = hub.x - z.x, dy = hub.y - z.y;
  const length = Math.hypot(dx, dy) || 1;
  const start = { x: z.x, y: z.y + z.r * 0.8 };
  const bend = z.x < hub.x ? -2.4 : 2.4;
  return {
    zone: z,
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
    ctx.beginPath();
    ctx.ellipse(50 * scale, 40 * scale, 22 * scale, 16 * scale, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(50 * scale, 73 * scale);
    ctx.bezierCurveTo(48.8 * scale, 63 * scale, 51.2 * scale, 53 * scale, 50 * scale, 44 * scale);
    ctx.stroke();

    for (const route of routes) {
      ctx.beginPath();
      ctx.moveTo(route.start.x * scale, route.start.y * scale);
      ctx.quadraticCurveTo(
        route.control.x * scale, route.control.y * scale,
        route.end.x * scale, route.end.y * scale,
      );
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(route.zone.x * scale, (route.zone.y + route.zone.r * 0.8) * scale);
      ctx.lineTo(route.zone.x * scale, (route.zone.y + route.zone.r * 0.42) * scale);
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
  const hex = z.color || "#b29765";
  const rgb = hex.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  ctx.fillStyle = rgb
    ? "rgba(" + parseInt(rgb[1], 16) + "," + parseInt(rgb[2], 16) + "," + parseInt(rgb[3], 16) + ",0.2)"
    : "rgba(178,151,101,0.2)";
  ctx.beginPath();
  ctx.ellipse(cx, cy, z.r * 1.2 * scale, z.r * 0.82 * scale, -0.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(219,191,139,0.3)";
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

function drawHighHallBuilding(z) {
  ctx.save();
  ctx.translate(z.x * scale, (z.y - 1.8) * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(20,18,16,0.38)";
  ctx.beginPath(); ctx.ellipse(0, 2.2, 7.6, 2.1, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#4b473e";
  rr(ctx, -7.2, -4.2, 14.4, 7, 0.5); ctx.fill();
  ctx.fillStyle = "#927f5e";
  rr(ctx, -6.25, -4.55, 12.5, 6.6, 0.35); ctx.fill();
  ctx.fillStyle = "#49392e";
  ctx.beginPath();
  ctx.moveTo(-7.1, -3.7); ctx.lineTo(-4.4, -6.1); ctx.lineTo(0, -7.9);
  ctx.lineTo(4.4, -6.1); ctx.lineTo(7.1, -3.7); ctx.lineTo(5.6, -2.9);
  ctx.lineTo(0, -5.7); ctx.lineTo(-5.6, -2.9); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#72533b";
  ctx.beginPath();
  ctx.moveTo(-5.8, -3.7); ctx.lineTo(-3.6, -5.6); ctx.lineTo(0, -7.1);
  ctx.lineTo(3.6, -5.6); ctx.lineTo(5.8, -3.7); ctx.lineTo(0, -6.1); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "rgba(204,171,119,0.55)"; ctx.lineWidth = 0.15;
  for (let x = -5.5; x <= 5.51; x += 1.1) {
    ctx.beginPath(); ctx.moveTo(x, -3.3); ctx.lineTo(x * 0.62, -5.9 + Math.abs(x) * 0.18); ctx.stroke();
  }
  ctx.fillStyle = "#392d24";
  rr(ctx, -1.05, -2.5, 2.1, 4.35, 0.5); ctx.fill();
  ctx.fillStyle = "#d6b778";
  rr(ctx, -0.8, -2.35, 1.6, 1.08, 0.4); ctx.fill();
  ctx.fillStyle = "#453629";
  rr(ctx, -0.72, -2.15, 1.44, 3.9, 0.48); ctx.fill();
  ctx.fillStyle = "#dbb66a";
  for (const x of [-4.6, 4.6]) {
    ctx.fillRect(x - 0.2, -2.8, 0.4, 0.85);
    ctx.fillStyle = "#963f35";
    ctx.beginPath(); ctx.moveTo(x, -1.95); ctx.lineTo(x + 1.15, -1.55); ctx.lineTo(x, -1.15); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#dbb66a";
  }
  ctx.restore();
}

function drawTempleBuilding(z) {
  ctx.save();
  ctx.translate(z.x * scale, (z.y - 1.6) * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(18,19,17,0.35)";
  ctx.beginPath(); ctx.ellipse(0, 2, 5.8, 1.7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#5b5548"; rr(ctx, -5.2, -3.1, 10.4, 5.1, 0.35); ctx.fill();
  ctx.fillStyle = "#b0a183"; rr(ctx, -4.65, -3.5, 9.3, 4.75, 0.25); ctx.fill();
  ctx.fillStyle = "#4c4a44";
  ctx.beginPath(); ctx.moveTo(-5.8, -3.1); ctx.lineTo(-3.2, -5.8); ctx.lineTo(0, -7.1);
  ctx.lineTo(3.2, -5.8); ctx.lineTo(5.8, -3.1); ctx.lineTo(0, -4.7); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#6d746d";
  ctx.beginPath(); ctx.moveTo(-4.5, -3.2); ctx.lineTo(-2.6, -5.1); ctx.lineTo(0, -6.2);
  ctx.lineTo(2.6, -5.1); ctx.lineTo(4.5, -3.2); ctx.lineTo(0, -4.55); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#756b55";
  for (const x of [-3.7, -1.9, 1.9, 3.7]) {
    rr(ctx, x - 0.25, -3.45, 0.5, 4.25, 0.18);
    ctx.fill();
  }
  ctx.fillStyle = "#40372d";
  ctx.beginPath(); ctx.moveTo(-1, 1.3); ctx.lineTo(-1, -0.7); ctx.quadraticCurveTo(0, -2.4, 1, -0.7); ctx.lineTo(1, 1.3); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#d0b47e";
  ctx.beginPath(); ctx.arc(0, -5.2, 0.48, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawForgeBuilding(z) {
  ctx.save();
  ctx.translate(z.x * scale, (z.y - 1.5) * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(16,16,15,0.38)";
  ctx.beginPath(); ctx.ellipse(0, 2.1, 5.8, 1.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#51483b"; rr(ctx, -4.9, -2.6, 9.8, 4.6, 0.25); ctx.fill();
  ctx.fillStyle = "#82735b"; rr(ctx, -4.25, -3.3, 8.5, 5.1, 0.2); ctx.fill();
  ctx.fillStyle = "#38332d";
  ctx.beginPath(); ctx.moveTo(-5.3, -3.05); ctx.lineTo(-2.6, -5.8); ctx.lineTo(0, -6.8);
  ctx.lineTo(3.2, -5.25); ctx.lineTo(5.1, -3.05); ctx.lineTo(0, -4.8); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#58463a";
  ctx.beginPath(); ctx.moveTo(-3.9, -3.05); ctx.lineTo(-1.8, -5.1); ctx.lineTo(0, -5.9);
  ctx.lineTo(2.4, -4.9); ctx.lineTo(3.9, -3.05); ctx.lineTo(0, -4.55); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#443d33"; rr(ctx, 2.4, -7.8, 1.65, 4.3, 0.2); ctx.fill();
  ctx.fillStyle = "#d47a3a";
  ctx.beginPath(); ctx.arc(3.2, -2.5, 0.68, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#ffca68";
  ctx.beginPath(); ctx.arc(3.2, -2.5, 0.34, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#423a32"; rr(ctx, -1.4, 0.1, 1.8, 0.9, 0.18); ctx.fill();
  ctx.fillStyle = "#c1a276"; rr(ctx, -1.15, -0.1, 1.2, 0.5, 0.16); ctx.fill();
  ctx.strokeStyle = "#3c3630"; ctx.lineWidth = 0.28;
  ctx.beginPath(); ctx.moveTo(-0.55, -0.15); ctx.lineTo(-0.55, -1.4); ctx.lineTo(0.55, -1.4); ctx.stroke();
  ctx.restore();
}

function drawStablesBuilding(z) {
  ctx.save();
  ctx.translate(z.x * scale, (z.y - 1.4) * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(20,17,15,0.36)";
  ctx.beginPath(); ctx.ellipse(0, 2.2, 6.2, 1.55, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#574638"; rr(ctx, -5.5, -2.7, 11, 4.8, 0.24); ctx.fill();
  ctx.fillStyle = "#987650"; rr(ctx, -4.8, -3.2, 9.6, 4.7, 0.18); ctx.fill();
  ctx.fillStyle = "#55402e";
  ctx.beginPath(); ctx.moveTo(-5.8, -3); ctx.lineTo(-3.4, -5.4); ctx.lineTo(0, -6.9);
  ctx.lineTo(3.4, -5.4); ctx.lineTo(5.8, -3); ctx.lineTo(0, -4.75); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#815b3f";
  ctx.beginPath(); ctx.moveTo(-4.6, -3); ctx.lineTo(-2.8, -5); ctx.lineTo(0, -6.15);
  ctx.lineTo(2.8, -5); ctx.lineTo(4.6, -3); ctx.lineTo(0, -4.65); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#4a3729"; ctx.lineWidth = 0.2;
  for (const x of [-3, 0, 3]) {
    rr(ctx, x - 1.05, -1.9, 2.1, 3.05, 0.2); ctx.fillStyle = "#624a35"; ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#b48d5e"; ctx.fillRect(x - 0.84, -1.6, 1.68, 0.17);
    ctx.fillStyle = "#4d392a"; ctx.fillRect(x - 0.62, -0.2, 1.24, 1.2);
    ctx.fillStyle = "#c6a174";
  }
  ctx.fillStyle = "#d2b27d";
  ctx.beginPath(); ctx.ellipse(-3.7, -2.2, 0.72, 0.46, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(3.7, -2.2, 0.72, 0.46, 0, 0, Math.PI * 2); ctx.fill();
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
  for (const z of state.meta.zones) drawClearing(z);
  for (const z of state.meta.zones) {
    if (z.building === "market") drawMarketBuilding(z);
    else if (z.building === "tavern") drawTavernBuilding(z);
    else if (z.building === "barracks") drawBarracksBuilding(z);
    else if (z.building === "watchtower") drawWatchtowerBuilding(z);
    else if (z.building === "high_hall") drawHighHallBuilding(z);
    else if (z.building === "temple") drawTempleBuilding(z);
    else if (z.building === "forge") drawForgeBuilding(z);
    else if (z.building === "stables") drawStablesBuilding(z);
  }
  for (const z of state.meta.zones) drawZoneLabel(z);
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
    if (!npcMatchesActiveDistrict(n)) continue;
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
  } else if (activity === "sleeping") {
    const rise = (t * 0.45) % 1;
    ctx.globalAlpha = 1 - rise * 0.55;
    ctx.font = "bold " + Math.round(12 * dpr) + "px system-ui, sans-serif";
    ctx.fillStyle = "#d9dcff";
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
    if (!n || !npcMatchesActiveDistrict(n)) continue;
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
  if (state.camera.suppressClick) {
    state.camera.suppressClick = false;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const screenX = e.clientX - rect.left;
  const screenY = e.clientY - rect.top;
  const baseX = (screenX - rect.width / 2 - state.camera.panX) / state.camera.zoom + rect.width / 2;
  const baseY = (screenY - rect.height / 2 - state.camera.panY) / state.camera.zoom + rect.height / 2;
  const wx = (baseX / rect.width) * state.meta.world.w;
  const wy = (baseY / rect.height) * state.meta.world.h;

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
    if (!npcMatchesActiveDistrict(n)) continue;
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
  const behavioral = p.behavioral_memory || {};
  $("npcMemory").textContent = behavioral.latest_note || "No recorded travel decisions yet.";
  const visits = Object.entries(behavioral.visits || {}).sort((a, b) => b[1] - a[1]);
  const visitCount = visits.reduce((total, entry) => total + entry[1], 0);
  let memoryMeta = visitCount + " recorded district visit" + (visitCount === 1 ? "" : "s");
  if (visits.length) {
    memoryMeta += " · Familiar with " + visits.slice(0, 2).map(([zone, count]) => zone + " (" + count + ")").join(", ");
  }
  if (behavioral.avoided_zone) {
    memoryMeta += " · Avoiding " + behavioral.avoided_zone + " for " + behavioral.avoid_ticks_left + " more ticks";
  }
  $("npcMemoryMeta").textContent = memoryMeta;
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
  g.fillStyle = "#23352b";
  g.fillRect(mx - 1, 0, 2 * dpr, c.height);
  g.font = Math.round(10 * dpr) + "px system-ui, sans-serif";
  g.fillStyle = "#6b796f";
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
  const character = state.meta.npcs.find((item) => item.id === n.id);
  const schedule = character && character.schedule;
  if (schedule) {
    const routine = n.routine === "sleep" ? "sleeping"
      : n.routine === "work" ? "on shift"
        : n.routine === "leisure" ? "free time" : "between routines";
    const clock = (minutes) => String(Math.floor(minutes / 60)).padStart(2, "0") + ":" +
      String(minutes % 60).padStart(2, "0");
    $("npcSchedule").textContent =
      "Currently " + routine + ". Work at the " + character.role + " " +
      clock(schedule.work_start) + "–" + clock(schedule.work_end) +
      "; sleep " + clock(schedule.sleep_start) + "–" + clock(schedule.sleep_end) +
      "; home: " + schedule.home + ".";
  }
  drawTimeline();
}

/* ---------- query lab ---------- */

function showQuery(text) {
  const el = $("queryShown");
  el.textContent = text;
  el.classList.add("show");
}

async function runBenchmark() {
  const btns = [$("btnBenchmark"), $("btnScaleBenchmark")];
  btns.forEach((btn) => { btn.disabled = true; btn.textContent = "Running..."; });
  const probe = state.probe || { x: 50, y: 40, r: 20 };
  const q = new URLSearchParams({
    x: probe.x.toFixed(2), y: probe.y.toFixed(2), radius: probe.r,
  });
  try {
    const r = await api("/api/index_benchmark?" + q.toString());
    state.performance.indexComparison = r;
    drawIndexChart();
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
      " | " + r.run_documents + " active-run records in this shard; scan examined a collection of " +
      r.collection_documents + " total records. Fastest of " + r.reps + " runs each.</div></div>";
  } catch (e) {
    $("benchResult").innerHTML = '<div class="result">Benchmark failed: ' + e.message + "</div>";
    $("scaleIndexSummary").textContent = "Benchmark failed: " + e.message;
  }
  btns.forEach((btn) => { btn.disabled = false; btn.textContent = btn.id === "btnScaleBenchmark" ? "Run index benchmark" : "Compare: with index vs without"; });
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
    "  run_id: \"" + activeRunId() + "\",\n" +
    "  location: { $geoWithin: { $centerSphere: [[<probe lon>, <probe lat>], radius] } },\n" +
    "  tick: { $gte: " + ($("qFrom").value || 1) + ", $lte: " + ($("qTo").value || state.meta.max_ticks) + " }\n" +
    "})  -- current run, both shards queried and results merged"
  );
  try {
    const r = await api("/api/nearby?" + q.toString());
    rememberQuerySample(r);
    state.probe.points = r.history.points;
    state.probe.liveIds = new Set(r.live.map((x) => x.id));
    renderSpatial(r);
  } catch (e) {
    $("labResult").innerHTML = '<div class="result">Query failed: ' + e.message + "</div>";
  }
}

function updateRunSeedStatus() {
  if (!$("runSeedStatus") || !state.meta) return;
  const seed = (state.stats && state.stats.seed) || state.meta.seed;
  $("runSeedStatus").textContent = seed ? "Current seed: " + seed : "Current seed unavailable";
}

async function startNewRun() {
  const button = $("btnNewRun");
  const seed = $("runSeed").value.trim();
  const query = new URLSearchParams();
  if (seed) query.set("seed", seed);
  button.disabled = true;
  button.textContent = "Starting...";
  try {
    const queryText = query.toString();
    await api("/api/sim/new_run" + (queryText ? "?" + queryText : ""), { method: "POST" });
    state.meta = await api("/api/meta");
    clearAll();
    buildNpcSelect();
    buildMapNavigation();
    await api("/api/sim/start", { method: "POST" });
    await setMode("live");
    await pollStats();
    await refreshRunCatalog();
    if ($("tab-scale").classList.contains("active")) await refreshScalability();
  } catch (e) {
    $("runSeedStatus").textContent = "Could not start run: " + e.message;
  }
  button.disabled = false;
  button.textContent = "New run";
}

async function refreshRunCatalog() {
  const selectA = $("compareRunA");
  if (!selectA || refreshRunCatalog.loading) return;
  refreshRunCatalog.loading = true;
  const previousA = selectA.value;
  const previousB = $("compareRunB").value;
  try {
    const response = await api("/api/runs");
    state.runCatalog = response.runs || [];
    for (const [select, previous] of [[selectA, previousA], [$("compareRunB"), previousB]]) {
      select.replaceChildren();
      for (const run of state.runCatalog) {
        const option = document.createElement("option");
        option.value = run.run_id;
        const seed = run.seed || "legacy/no seed";
        const active = run.active ? " · active" : "";
        option.textContent = seed + " · " + run.npc_count + " NPC · " + run.max_tick + " ticks" + active + " · " + run.run_id.slice(0, 8);
        select.appendChild(option);
      }
      if (state.runCatalog.some((run) => run.run_id === previous)) {
        select.value = previous;
      } else if (select === selectA) {
        select.value = (state.runCatalog.find((run) => run.active) || state.runCatalog[0] || {}).run_id || "";
      } else {
        const activeId = (state.runCatalog.find((run) => run.active) || {}).run_id;
        select.value = (state.runCatalog.find((run) => run.run_id !== activeId) || state.runCatalog[0] || {}).run_id || "";
      }
    }
    updateCompareTickLimit();
    $("compareStatus").textContent = state.runCatalog.length + " saved run" + (state.runCatalog.length === 1 ? "" : "s") + " available.";
  } catch (e) {
    $("compareStatus").textContent = "Could not load saved runs: " + e.message;
  }
  refreshRunCatalog.loading = false;
}

function updateCompareTickLimit() {
  const a = state.runCatalog.find((run) => run.run_id === $("compareRunA").value);
  const b = state.runCatalog.find((run) => run.run_id === $("compareRunB").value);
  const max = a && b ? Math.max(1, Math.min(a.max_tick, b.max_tick)) : 1;
  const input = $("compareTick");
  input.max = max;
  const requested = state.comparisonTickTouched ? Number(input.value) || 1 : max;
  input.value = Math.max(1, Math.min(requested, max));
}

function invalidateComparison() {
  state.comparison = null;
  $("compareSummary").textContent = "";
  $("compareMetaA").textContent = "";
  $("compareMetaB").textContent = "";
  $("compareStatus").textContent = "Selection changed. Compare again to load these frames.";
  redrawComparison();
}

async function compareRuns() {
  const runA = state.runCatalog.find((run) => run.run_id === $("compareRunA").value);
  const runB = state.runCatalog.find((run) => run.run_id === $("compareRunB").value);
  const tick = Math.max(1, Number($("compareTick").value) || 1);
  if (!runA || !runB) {
    $("compareStatus").textContent = "Create or load a saved run before comparing.";
    return;
  }
  const button = $("btnCompareRuns");
  button.disabled = true;
  $("compareStatus").textContent = "Loading both frames...";
  try {
    const loadFrame = async (run) => {
      const q = new URLSearchParams({ start: tick, end: tick, run_id: run.run_id });
      const result = await api("/api/frames?" + q.toString());
      return result.frames.find((frame) => frame.tick === tick) || null;
    };
    const [frameA, frameB] = await Promise.all([loadFrame(runA), loadFrame(runB)]);
    state.comparison = { runA, runB, frameA, frameB, tick };
    $("compareHeadingA").textContent = "Run A · tick " + tick;
    $("compareHeadingB").textContent = "Run B · tick " + tick;
    $("compareMetaA").textContent = runDescription(runA, frameA);
    $("compareMetaB").textContent = runDescription(runB, frameB);
    redrawComparison();
    $("compareSummary").textContent = compareFrameSummary(runA, runB, frameA, frameB);
    $("compareStatus").textContent = frameA && frameB ? "Comparison complete." : "One or both runs have no recorded frame at that tick.";
  } catch (e) {
    $("compareStatus").textContent = "Comparison failed: " + e.message;
  }
  button.disabled = false;
}

function runDescription(run, frame) {
  return "Seed " + (run.seed || "unknown/legacy") + " · " + run.npc_count + " NPC · " +
    run.max_tick + " recorded ticks · " + (frame ? frame.npcs.length : 0) + " NPCs in selected frame";
}

function compareFrameSummary(runA, runB, frameA, frameB) {
  if (!frameA || !frameB) return "A saved frame is missing for the selected tick. Choose a tick recorded in both runs.";
  const mapA = new Map(frameA.npcs.map((npc) => [npc.id, npc]));
  const mapB = new Map(frameB.npcs.map((npc) => [npc.id, npc]));
  const shared = [...mapA.keys()].filter((id) => mapB.has(id));
  let distanceTotal = 0;
  let exactPositions = 0;
  let matchingActivities = 0;
  let matchingStates = 0;
  for (const id of shared) {
    const a = mapA.get(id), b = mapB.get(id);
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    distanceTotal += distance;
    if (distance < 0.005) exactPositions++;
    if (a.activity === b.activity) matchingActivities++;
    if (distance < 0.005 && a.activity === b.activity && a.zone === b.zone &&
        a.target === b.target && a.routine === b.routine) matchingStates++;
  }
  const sameSeed = !!runA.seed && runA.seed === runB.seed;
  const sameCount = runA.npc_count === runB.npc_count;
  const sameRoster = shared.length === mapA.size && shared.length === mapB.size;
  const identical = sameRoster && matchingStates === shared.length;
  const condition = sameSeed
    ? (sameCount ? "Same seed and NPC count." : "Same seed, different NPC counts.")
    : "Seeds differ or are unavailable.";
  return condition +
    " Shared NPCs: " + shared.length + ". Exact position matches: " + exactPositions +
    ". Activity matches: " + matchingActivities + ". Full NPC state matches: " + matchingStates +
    ". Average position difference: " +
    (shared.length ? (distanceTotal / shared.length).toFixed(3) : "—") + " world units. " +
    (identical ? "These frames match exactly." : "These frames differ.");
}

function redrawComparison() {
  if (!state.comparison) {
    for (const id of ["compareMapA", "compareMapB"]) {
      const target = $(id);
      if (!target) continue;
      const context = target.getContext("2d");
      context.clearRect(0, 0, target.width, target.height);
    }
    return;
  }
  renderComparisonMap("compareMapA", state.comparison.frameA);
  renderComparisonMap("compareMapB", state.comparison.frameB);
}

function renderComparisonMap(id, frame) {
  const target = $(id);
  const width = target.clientWidth || 600;
  const height = target.clientHeight || 280;
  const ratio = window.devicePixelRatio || 1;
  target.width = Math.round(width * ratio);
  target.height = Math.round(height * ratio);
  const context = target.getContext("2d");
  context.setTransform(target.width / state.meta.world.w, 0, 0, target.height / state.meta.world.h, 0, 0);
  context.fillStyle = "#1a2a23";
  context.fillRect(0, 0, state.meta.world.w, state.meta.world.h);
  context.fillStyle = "rgba(10, 18, 15, 0.42)";
  for (let x = 4; x < 100; x += 8) {
    for (let y = 5; y < 80; y += 8) {
      context.beginPath(); context.arc(x + ((y / 8) % 2) * 2, y, 0.18, 0, Math.PI * 2); context.fill();
    }
  }
  context.fillStyle = "#45483b";
  context.beginPath(); context.ellipse(50, 40, 45, 34, 0, 0, Math.PI * 2); context.fill();
  context.strokeStyle = "#a58c65"; context.lineWidth = 0.8;
  context.beginPath(); context.ellipse(50, 40, 44.3, 33.3, 0, 0, Math.PI * 2); context.stroke();
  context.fillStyle = "#68563f";
  context.beginPath(); context.ellipse(50, 40, 21.5, 15.5, 0, 0, Math.PI * 2); context.fill();
  context.strokeStyle = "rgba(215, 193, 145, 0.6)"; context.lineWidth = 0.55;
  context.beginPath(); context.ellipse(50, 40, 22, 16, 0, 0, Math.PI * 2); context.stroke();
  for (const zone of state.meta.zones) {
    context.fillStyle = (state.meta.activities[zone.activity] || "#d6bd83") + "35";
    context.strokeStyle = "rgba(235, 218, 179, 0.55)";
    context.lineWidth = 0.28;
    context.beginPath(); context.arc(zone.x, zone.y, zone.r * 0.78, 0, Math.PI * 2); context.fill(); context.stroke();
    context.fillStyle = "#f0e3c5";
    context.font = "1.15px system-ui";
    context.textAlign = "center";
    context.fillText(zone.name, zone.x, zone.y + zone.r + 1.8);
  }
  if (!frame) {
    context.fillStyle = "rgba(6, 10, 12, 0.68)";
    context.fillRect(0, 0, state.meta.world.w, state.meta.world.h);
    context.fillStyle = "#eaf0f6";
    context.font = "2px system-ui";
    context.textAlign = "center";
    context.fillText("No frame recorded", state.meta.world.w / 2, state.meta.world.h / 2);
    return;
  }
  for (const npc of frame.npcs) {
    context.fillStyle = actColor(npc.activity);
    context.strokeStyle = "rgba(10, 14, 17, 0.9)";
    context.lineWidth = 0.28;
    context.beginPath(); context.arc(npc.x, npc.y, 0.72, 0, Math.PI * 2); context.fill(); context.stroke();
  }
}

async function configureNpcCount() {
  const btn = $("btnApplyNpcCount");
  const count = Number($("npcCount").value);
  const seed = $("runSeed").value.trim();
  const query = new URLSearchParams({ npcs: count });
  if (seed) query.set("seed", seed);
  btn.disabled = true;
  $("scaleConfigStatus").textContent = "Starting a fresh run...";
  try {
    await api("/api/sim/configure?" + query.toString(), { method: "POST" });
    state.meta = await api("/api/meta");
    await api("/api/sim/start", { method: "POST" });
    state.selected = null;
    state.performance.indexComparison = null;
    clearAll();
    buildNpcSelect();
    buildMapNavigation();
    $("npcCount").value = state.meta.npc_count;
    $("npcCountLabel").textContent = state.meta.npc_count;
    $("qTo").value = state.meta.max_ticks;
    await setMode("live");
    await pollStats();
    await refreshScalability();
    await refreshRunCatalog();
    $("scaleConfigStatus").textContent =
      "New run started with " + state.meta.npc_count + " NPCs and seed " + state.meta.seed + ". Earlier history is preserved.";
  } catch (e) {
    $("scaleConfigStatus").textContent = "Could not configure the run: " + e.message;
  }
  btn.disabled = false;
}

async function sampleQueryLatency() {
  const btn = $("btnScaleQuery");
  btn.disabled = true;
  btn.textContent = "Sampling...";
  const probe = state.probe || { x: 50, y: 40, r: 20 };
  const tick = Math.max(1, state.stats ? state.stats.tick : 1);
  const q = new URLSearchParams({
    x: probe.x.toFixed(2), y: probe.y.toFixed(2), radius: probe.r,
    t_from: 1, t_to: tick,
  });
  try {
    const r = await api("/api/nearby?" + q.toString());
    rememberQuerySample(r);
    $("querySampleStatus").textContent =
      "Sample " + state.performance.querySamples.length + " at " + state.meta.npcs.length + " NPCs.";
  } catch (e) {
    $("querySampleStatus").textContent = "Sample failed: " + e.message;
  }
  btn.disabled = false;
  btn.textContent = "Sample query latency";
}

function rememberQuerySample(result) {
  const samples = state.performance.querySamples;
  samples.push({
    npc_count: state.meta.npcs.length,
    tick: state.stats ? state.stats.tick : 0,
    redis_ms: result.ms_live,
    mongo_ms: result.ms_history,
  });
  if (samples.length > 30) samples.shift();
  $("querySampleStatus").textContent = "Recent samples: " + samples.slice(-5).map((sample) =>
    sample.npc_count + " NPC (Redis " + sample.redis_ms.toFixed(2) +
    " / Mongo " + sample.mongo_ms.toFixed(2) + " ms)"
  ).join(" · ");
  drawQueryChart();
}

async function refreshScalability() {
  if (state.performance.loading) return;
  state.performance.loading = true;
  try {
    const snapshot = await api("/api/scalability");
    state.performance.snapshot = snapshot;
    $("scaleNpcTotal").textContent = snapshot.npc_count;
    $("scaleRecordTotal").textContent = snapshot.records_total.toLocaleString();
    const latest = snapshot.write.latest;
    $("scaleWriteRate").textContent = latest
      ? latest.records_per_second.toLocaleString() + " rec/s"
      : "-";
    $("scaleWriteTime").textContent = latest ? latest.write_ms.toFixed(2) + " ms" : "-";
    renderShardDistribution(snapshot.records_by_shard, snapshot.records_total);
    drawWriteChart();
    drawQueryChart();
    drawIndexChart();
  } catch (e) {
    $("scaleConfigStatus").textContent = "Performance data unavailable: " + e.message;
  } finally {
    state.performance.loading = false;
  }
}

function renderShardDistribution(counts, total) {
  const box = $("shardDistribution");
  box.replaceChildren();
  const entries = Object.entries(counts || {});
  const max = Math.max(1, ...entries.map((entry) => entry[1]));
  const colors = ["#367d63", "#b9853d"];
  entries.forEach(([name, count], index) => {
    const row = document.createElement("div");
    row.className = "bar";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = name;
    const track = document.createElement("span");
    track.className = "track";
    const fill = document.createElement("span");
    fill.className = "fill";
    fill.style.width = (count / max * 100) + "%";
    fill.style.background = colors[index % colors.length];
    track.appendChild(fill);
    const value = document.createElement("span");
    value.className = "num";
    value.textContent = count.toLocaleString();
    row.append(label, track, value);
    box.appendChild(row);
  });
  const note = document.createElement("div");
  note.className = "sub";
  note.textContent = total
    ? total.toLocaleString() + " current-run records across both shards."
    : "No records yet. Start or generate the run to populate the shards.";
  box.appendChild(note);
}

function drawPerformanceCharts() {
  drawWriteChart();
  drawQueryChart();
  drawIndexChart();
}

function chartCanvas(id, height) {
  const canvasEl = $(id);
  if (!canvasEl || !canvasEl.clientWidth) return null;
  const ratio = window.devicePixelRatio || 1;
  canvasEl.width = Math.round(canvasEl.clientWidth * ratio);
  canvasEl.height = Math.round(height * ratio);
  const context = canvasEl.getContext("2d");
  context.scale(ratio, ratio);
  context.clearRect(0, 0, canvasEl.clientWidth, height);
  return { canvas: canvasEl, context, width: canvasEl.clientWidth, height };
}

function drawLineChart(id, series, unit, emptyText, height = 170) {
  const chart = chartCanvas(id, height);
  if (!chart) return;
  const { context: g, width, height: h } = chart;
  const allValues = series.flatMap((s) => s.values.map((p) => p.value)).filter(Number.isFinite);
  g.font = "11px system-ui, sans-serif";
  g.fillStyle = "#6b796f";
  if (!allValues.length) {
    g.fillText(emptyText, 12, Math.round(h / 2));
    return;
  }
  const left = 48, right = 12, top = 20, bottom = 24;
  const plotW = Math.max(1, width - left - right);
  const plotH = Math.max(1, h - top - bottom);
  const maxValue = Math.max(1, ...allValues) * 1.1;
  for (let i = 0; i <= 3; i++) {
    const y = top + plotH * i / 3;
    g.strokeStyle = "rgba(107,121,111,0.18)";
    g.beginPath(); g.moveTo(left, y); g.lineTo(width - right, y); g.stroke();
    g.fillStyle = "#6b796f";
    g.textAlign = "right";
    g.fillText((maxValue * (1 - i / 3)).toFixed(maxValue < 10 ? 1 : 0), left - 6, y + 4);
  }
  g.textAlign = "left";
  series.forEach((s, seriesIndex) => {
    g.fillStyle = s.color;
    g.fillRect(left + seriesIndex * 120, 4, 9, 9);
    g.fillStyle = "#35443a";
    g.fillText(s.label, left + 14 + seriesIndex * 120, 13);
    if (!s.values.length) return;
    g.strokeStyle = s.color;
    g.lineWidth = 2;
    g.beginPath();
    s.values.forEach((point, index) => {
      const x = left + (s.values.length === 1 ? plotW : index / (s.values.length - 1) * plotW);
      const y = top + plotH - point.value / maxValue * plotH;
      if (index === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.stroke();
  });
  g.fillStyle = "#6b796f";
  g.textAlign = "left";
  g.fillText(unit, 4, 12);
  g.fillText("older", left, h - 4);
  g.textAlign = "right";
  g.fillText("newer", width - right, h - 4);
}

function drawWriteChart() {
  const samples = state.performance.snapshot && state.performance.snapshot.write
    ? state.performance.snapshot.write.samples.slice(-70)
    : [];
  drawLineChart("writeChart", [{
    label: "Dual-write",
    color: "#438766",
    values: samples.map((sample) => ({ value: sample.records_per_second })),
  }], "records/s", "Generate ticks to collect write samples.");
}

function drawQueryChart() {
  const samples = state.performance.querySamples;
  drawLineChart("queryChart", [
    { label: "Redis live", color: "#367d63", values: samples.map((s) => ({ value: s.redis_ms })) },
    { label: "Mongo history", color: "#b9853d", values: samples.map((s) => ({ value: s.mongo_ms })) },
  ], "ms", "Run a query sample to collect latency.");
}

function drawIndexChart() {
  const result = state.performance.indexComparison;
  const chart = chartCanvas("indexChart", 120);
  if (!chart) return;
  const { context: g, width, height: h } = chart;
  if (!result) {
    g.fillStyle = "#6b796f";
    g.font = "12px system-ui, sans-serif";
    g.fillText("Run the benchmark to compare both query plans.", 12, h / 2);
    $("scaleIndexSummary").textContent = "";
    return;
  }
  const rows = [
    { label: "2dsphere index", value: result.indexed_ms, color: "#438766" },
    { label: "Collection scan", value: result.scan_ms, color: "#bf5149" },
  ];
  const max = Math.max(0.01, ...rows.map((row) => row.value));
  rows.forEach((row, index) => {
    const y = 25 + index * 42;
    g.font = "11px system-ui, sans-serif";
    g.fillStyle = "#35443a";
    g.textAlign = "left";
    g.fillText(row.label, 2, y + 10);
    const x = 105, barW = Math.max(1, width - x - 54);
    g.fillStyle = "rgba(107,121,111,0.15)";
    g.fillRect(x, y, barW, 13);
    g.fillStyle = row.color;
    g.fillRect(x, y, Math.max(2, row.value / max * barW), 13);
    g.fillStyle = "#35443a";
    g.textAlign = "right";
    g.fillText(row.value.toFixed(2) + " ms", width - 2, y + 11);
  });
  $("scaleIndexSummary").textContent =
    "Plans: " + result.indexed_plan + " / " + result.scan_plan +
    " · " + result.run_documents + " active-run records on " + result.shard + "; collection has " +
    result.collection_documents.toLocaleString() + " records.";
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
    "  run_id: \"" + activeRunId() + "\",\n" +
    "  tick: { $gte: " + ($("mFrom").value || 1) + ", $lte: " + ($("mTo").value || state.meta.max_ticks) + " }\n" +
    "})  -- current run, routed to exactly one shard"
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
