/*--------------------------Home section---------------------------*/
let dashboardInterval = null;
let currentPage = "home";

// Cache DOM elements once (better performance)
const layout   = document.querySelector('.layout');
const rightbar = document.getElementById('rightbar');
const toggleBtn = document.getElementById('toggle-rightbar');

async function loadHome() {
  hideChannelSidebar();

  const container = document.getElementById('content');
  container.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">${new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <h1>Camera wall</h1>
      </div>
      <div class="stats">
        <div><div class="stat__value" id="stat-recording">-- / --</div><div class="stat__label">Recording now</div></div>
        <div><div class="stat__value" id="stat-attention">--</div><div class="stat__label">Need attention</div></div>
        <div><div class="stat__value" id="stat-disk">--%</div><div class="stat__label">Disk used</div></div>
      </div>
    </div>

    <div class="wall" id="camera-wall" aria-label="Cameras"></div>

    <div class="home-row">
      <section class="card sched-list">
        <div class="card__head">
          <h2>Next on the schedule</h2>
          <a class="link" href="#" onclick="loadSchedules(); return false;">Open schedules</a>
        </div>
        <div id="next-list"><p class="muted">Loading…</p></div>
      </section>

      <section class="card storage" id="disk-card">
        <div class="card__head"><h2>Storage</h2></div>
        <div class="storage__big"><strong id="disk-used">--</strong><span class="muted" id="disk-of">GB used</span></div>
        <div class="track track--lg" role="img" aria-label="Disk usage">
          <div class="track__fill" id="disk-bar"></div>
          <div class="track__mark" style="left:85%"></div>
        </div>
        <div class="storage__legend"><span id="disk-free">Free: -- GB</span><span>Recycle at 85%</span></div>
      </section>

      <section class="card system" id="resource-card">
        <div class="card__head"><h2>System</h2></div>
        <div class="resource-row"><span class="label">CPU</span><span class="value" id="cpu-value">--%</span></div>
        <div class="meter"><i id="cpu-bar"></i></div>
        <div class="resource-row"><span class="label">RAM</span><span class="value" id="ram-value">--%</span></div>
        <div class="meter"><i id="ram-bar"></i></div>
        <div class="resource-row" id="network-card"><span class="label">Network</span><span class="net" id="net-value">--</span></div>
        <p class="note">Updated every 10 sec</p>
      </section>
    </div>
  `;

  updateDashboard();  // Run once after rendering
}


/* ---------- Menu Click Handler ---------- */
document.querySelectorAll('.topbar nav a').forEach(link => {
  link.addEventListener('click', function () {

    document.querySelectorAll('.topbar nav a')
      .forEach(a => a.classList.remove('active'));

    this.classList.add('active');

    currentPage = this.textContent.trim().toLowerCase();

    const showRightbarPages = ["recordings"];

    if (showRightbarPages.includes(currentPage)) {
      rightbar.classList.remove('hidden');
      layout.classList.remove('rightbar-hidden');
      toggleBtn.querySelector('i').classList.remove('fa-chevron-left');
      toggleBtn.querySelector('i').classList.add('fa-chevron-right');
    } else {
      rightbar.classList.add('hidden');
      layout.classList.add('rightbar-hidden');
      toggleBtn.querySelector('i').classList.remove('fa-chevron-right');
      toggleBtn.querySelector('i').classList.add('fa-chevron-left');
    }

    toggleBtn.parentElement.style.display = showRightbarPages.includes(currentPage) ? '' : 'none';

    handleDashboardRefresh(); // Start/Stop interval
  });
});


document.addEventListener("DOMContentLoaded", () => {
  // Home has no side panel; it is shown again on the Recordings page
  rightbar.classList.add('hidden');
  layout.classList.add('rightbar-hidden');
  toggleBtn.parentElement.style.display = 'none';
  loadHome();
  handleDashboardRefresh(); // start interval initially
});


/* ---------- Right Sidebar Toggle (manual button) ---------- */
toggleBtn.addEventListener('click', () => {
  const hidden = rightbar.classList.toggle('hidden');
  layout.classList.toggle('rightbar-hidden', hidden);

  const icon = toggleBtn.querySelector('i');
  icon.classList.toggle('fa-chevron-left', !hidden);
  icon.classList.toggle('fa-chevron-right', hidden);
});


/* ---------- Helpers ---------- */
function hideChannelSidebar() {
  const channelSidebar = document.getElementById('channel_sidebar');
  if (channelSidebar) {
    channelSidebar.classList.remove('visible');
  }
}

function getSessionId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substr(2, 9);
  return `sess_${timestamp}_${random}`;
}


/* ---------- Auto Refresh Logic ---------- */
function handleDashboardRefresh() {
  if (currentPage === "home") {
    if (!dashboardInterval) {
      updateDashboard();
      dashboardInterval = setInterval(updateDashboard, 10000);
      console.log("Dashboard auto-refresh started");
    }
  } else {
    if (dashboardInterval) {
      clearInterval(dashboardInterval);
      dashboardInterval = null;
      console.log("Dashboard auto-refresh stopped");
    }
  }
}


/* ---------- Visual helpers (new UI) ---------- */
function setMeter(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  el.style.width = v + "%";
  el.classList.toggle("hot", v >= 85);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* ---------- Schedule helpers (read-only, mirrors the server's interval logic) ---------- */
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const SEC_DAY = 86400, SEC_WEEK = 7 * SEC_DAY;

function hmsToSec(t) {
  const [h, m, s] = String(t).split(":").map(Number);
  return h === 24 ? SEC_DAY : h * 3600 + (m || 0) * 60 + (s || 0);
}

function weekIntervals(slots) {
  const out = [];
  Object.keys(slots || {}).forEach(day => {
    const di = DAY_KEYS.indexOf(day);
    if (di < 0) return;
    (slots[day] || []).forEach(r => out.push([di * SEC_DAY + hmsToSec(r.from), di * SEC_DAY + hmsToSec(r.to)]));
  });
  out.sort((a, b) => a[0] - b[0]);
  const merged = [];
  out.forEach(iv => {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  });
  return merged;
}

function nowWeekSec() {
  const n = new Date();
  const di = (n.getDay() + 6) % 7; // Monday = 0
  return di * SEC_DAY + n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds();
}

function fmtClock(sec) {
  const s = ((sec % SEC_DAY) + SEC_DAY) % SEC_DAY;
  return String(Math.floor(s / 3600)).padStart(2, "0") + ":" + String(Math.floor((s % 3600) / 60)).padStart(2, "0");
}

// Segments (in % of the day) that are scheduled today
function todaySegments(merged) {
  const di = (new Date().getDay() + 6) % 7;
  const d0 = di * SEC_DAY, d1 = d0 + SEC_DAY;
  const segs = [];
  merged.forEach(([s, e]) => {
    const a = Math.max(s, d0), b = Math.min(e, d1);
    if (b > a) segs.push({ left: ((a - d0) / SEC_DAY * 100).toFixed(2), w: ((b - a) / SEC_DAY * 100).toFixed(2) });
  });
  return segs;
}

// Upcoming start/stop events within the next 24 h
function upcomingEvents(name, merged) {
  if (!merged.length) return [];
  if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] === SEC_WEEK) return []; // 24x7
  const now = nowWeekSec();
  const events = [];
  merged.forEach(([s, e]) => {
    [[s, "Starts recording"], [e % SEC_WEEK, "Stops recording"]].forEach(([t, kind]) => {
      let delta = t - now;
      if (delta < 0) delta += SEC_WEEK;
      if (delta <= SEC_DAY) events.push({ delta, name, kind, t });
    });
  });
  return events;
}

async function fetchSchedule(id) {
  try {
    const r = await fetch("/api/schedules/" + id);
    return await r.json();
  } catch (e) { return {}; }
}

function tickClock() {
  const t = new Date().toLocaleTimeString("en-GB");
  document.querySelectorAll(".tile__time[data-live]").forEach(el => { el.textContent = t; });
}

// Camera tiles on Home (uses the existing /api/cameras endpoint)
async function updateCameraWall() {
  const wall = document.getElementById("camera-wall");
  if (!wall) return;
  try {
    const res = await fetch("/api/cameras");
    const cameras = await res.json();
    const schedules = await Promise.all(cameras.map(s => fetchSchedule(s.id)));
    const merged = schedules.map(weekIntervals);

    const recording = cameras.filter(s => (s.current_status || "").toLowerCase().includes("running")).length;
    const attention = cameras.filter(s => (s.current_status || "").toLowerCase().includes("error")).length;
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText("stat-recording", `${recording} / ${cameras.length}`);
    setText("stat-attention", attention);

    // Next on the schedule
    const list = document.getElementById("next-list");
    if (list) {
      const events = cameras.flatMap((s, i) => upcomingEvents(s.name, merged[i])).sort((a, b) => a.delta - b.delta).slice(0, 5);
      const anyTimed = merged.some(m => m.length);
      list.innerHTML = events.length ? events.map(ev => `
        <div class="sched-item">
          <span class="sched-item__time">${fmtClock(ev.t)}</span>
          <span class="sched-item__name">${escapeHtml(ev.name)}</span>
          <span class="chip">${ev.kind}</span>
        </div>`).join("") :
        `<p class="muted">${anyTimed || cameras.length ? "Nothing scheduled in the next 24 hours." : "No cameras yet."}</p>`;
    }

    if (!cameras.length) {
      wall.innerHTML = '<p class="muted">No cameras yet. Add one from the Cameras page.</p>';
      return;
    }

    const nowPct = ((new Date().getHours() * 3600 + new Date().getMinutes() * 60) / SEC_DAY * 100).toFixed(2);
    const clock = new Date().toLocaleTimeString("en-GB");

    wall.innerHTML = cameras.map((s, i) => {
      const status = (s.current_status || "").toLowerCase();
      let badge = '<span class="badge badge--idle">' + (status === "not scheduled" ? "Not scheduled" : escapeHtml(s.current_status || "Not scheduled")) + '</span>';
      let time = "--:--:--";
      if (status.includes("running")) { badge = '<span class="badge badge--rec">REC</span>'; time = clock; }
      else if (status.includes("error")) badge = '<span class="badge badge--err">NO SIGNAL</span>';
      else if (status.includes("pending") || status.includes("restarting")) badge = '<span class="badge badge--idle">' + escapeHtml(s.current_status) + '</span>';

      const segs = todaySegments(merged[i]).map(g =>
        `<div class="track__seg" style="left:${g.left}%;width:${g.w}%"></div>`).join("");
      const live = status.includes("running") ? " data-live" : "";

      return `
        <article class="tile" data-id="${s.id}" data-name="${escapeHtml(s.name)}" data-sub="${s.sub_url ? 1 : 0}" title="Click to watch live">
          <div class="tile__thumb">
            <i class="fa-solid fa-video tile__icon"></i>
            <img class="tile__snap" alt="" onerror="this.hidden=true" data-stream="${s.sub_url ? 'cam_' + s.id + '_sub' : 'cam_' + s.id}" src="${snapCache[s.sub_url ? 'cam_' + s.id + '_sub' : 'cam_' + s.id] || ''}"${snapCache[s.sub_url ? 'cam_' + s.id + '_sub' : 'cam_' + s.id] ? '' : ' hidden'}>
            <span class="tile__badge">${badge}</span>
            <span class="tile__time"${live}>${time}</span>
            <span class="tile__hint" hidden></span>
            <div class="tile__bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
          </div>
          <div class="tile__body">
            <div class="tile__title"><h3>${escapeHtml(s.name)}</h3></div>
            <div class="tile__url" title="${escapeHtml(s.url)}">${escapeHtml(s.url)}</div>
            <div class="track" title="Scheduled today">${segs}<div class="track__now" style="left:${nowPct}%"></div></div>
            <div class="tile__note">${escapeHtml(s.status_msg || s.current_status || "")}</div>
          </div>
        </article>`;
    }).join("");

    applyGlobalSearch();
    refreshSnapshots();
  } catch (err) {
    console.error("Failed to load cameras:", err);
  }
}


/* ---------- Live view (go2rtc) ---------- */
const snapCache = {};          // stream name -> last snapshot (object URL), avoids flicker on refresh
let liveCfg = null;            // { available, base }

async function getLiveConfig(force) {
  if (!liveCfg || force) {
    try { liveCfg = await (await fetch("/api/live/config")).json(); }
    catch (e) { liveCfg = { available: false, base: "" }; }
  }
  return liveCfg;
}

const snapBusy = new Set();    // stream names with a snapshot request in flight

function setSnapHint(name, text) {
  document.querySelectorAll(`#camera-wall img.tile__snap[data-stream="${name}"]`).forEach(img => {
    const hint = img.parentElement.querySelector(".tile__hint");
    if (!hint) return;
    hint.textContent = text || "";
    hint.hidden = !text;
  });
}

// Fetch a fresh JPEG for every visible tile (one request per camera, runs after each Home refresh).
// The first snapshot can take several seconds: go2rtc has to connect and wait for a keyframe.
async function refreshSnapshots() {
  const cfg = await getLiveConfig(true);
  const names = [...new Set([...document.querySelectorAll("#camera-wall img.tile__snap")].map(i => i.dataset.stream))];
  if (!cfg.available) { names.forEach(n => setSnapHint(n, "Live view off")); return; }

  names.forEach(async name => {
    if (snapBusy.has(name)) return;
    snapBusy.add(name);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const r = await fetch(`${cfg.base}/api/frame.jpeg?src=${encodeURIComponent(name)}`, { signal: ctrl.signal });
      const blob = r.ok ? await r.blob() : null;
      if (!blob || !blob.type.startsWith("image/") || blob.size < 200) { setSnapHint(name, "No image from camera"); return; }
      const url = URL.createObjectURL(blob);
      if (snapCache[name]) URL.revokeObjectURL(snapCache[name]);
      snapCache[name] = url;
      document.querySelectorAll(`#camera-wall img.tile__snap[data-stream="${name}"]`).forEach(img => {
        img.onerror = () => { img.hidden = true; delete snapCache[name]; };
        img.src = url;
        img.hidden = false;
      });
      setSnapHint(name, "");
    } catch (e) {
      setSnapHint(name, e.name === "AbortError" ? "Camera too slow to respond" : "Live view not reachable");
    } finally {
      clearTimeout(timer);
      snapBusy.delete(name);
    }
  });
}

function closeLive() {
  const m = document.getElementById("live-modal");
  if (m) m.remove();   // removing the iframe also closes the stream
}

async function openLive(id, name, hasSub) {
  closeLive();
  const cfg = await getLiveConfig(true);
  const modal = document.createElement("div");
  modal.id = "live-modal";
  modal.className = "live-modal";
  modal.innerHTML = `
    <div class="live-modal__box" role="dialog" aria-label="Live view">
      <div class="live-modal__head">
        <h2>${escapeHtml(name)}</h2>
        <div class="live-modal__tools">
          ${hasSub ? `<div class="seg" id="live-quality">
              <button class="seg__btn is-on" data-q="sub">Low</button>
              <button class="seg__btn" data-q="main">Full</button></div>` : ""}
          <button class="btn btn--sm" id="live-close" aria-label="Close">Close</button>
        </div>
      </div>
      <div class="live-modal__body" id="live-body"></div>
    </div>`;
  document.body.appendChild(modal);

  const body = modal.querySelector("#live-body");
  const play = quality => {
    if (!cfg.available) {
      body.innerHTML = '<p class="live-modal__msg">Live view is not running. Start go2rtc (see go2rtc/README.md) and try again.</p>';
      return;
    }
    const stream = (hasSub && quality === "sub") ? `cam_${id}_sub` : `cam_${id}`;
    body.innerHTML = `<iframe src="${cfg.base}/stream.html?src=${encodeURIComponent(stream)}" allow="autoplay; fullscreen" title="Live ${escapeHtml(name)}"></iframe>`;
  };
  play(hasSub ? "sub" : "main");

  modal.addEventListener("click", e => {
    if (e.target === modal || e.target.id === "live-close") closeLive();
    const q = e.target.closest && e.target.closest("[data-q]");
    if (q) {
      modal.querySelectorAll("[data-q]").forEach(b => b.classList.toggle("is-on", b === q));
      play(q.dataset.q);
    }
  });
}

document.addEventListener("keydown", e => { if (e.key === "Escape") closeLive(); });
document.addEventListener("click", e => {
  const tile = e.target.closest && e.target.closest("#camera-wall .tile");
  if (tile) openLive(tile.dataset.id, tile.dataset.name, tile.dataset.sub === "1");
});


/* ---------- Header search (filters camera tiles on Home) ---------- */
function applyGlobalSearch() {
  const input = document.getElementById("globalSearch");
  if (!input) return;
  const q = input.value.trim().toLowerCase();
  document.querySelectorAll("#camera-wall .tile").forEach(t => {
    const name = (t.querySelector("h3")?.textContent || "").toLowerCase();
    t.style.display = !q || name.includes(q) ? "" : "none";
  });
}
document.addEventListener("input", e => { if (e.target && e.target.id === "globalSearch") applyGlobalSearch(); });
setInterval(tickClock, 1000);


/* ---------- Dashboard Update Function ---------- */
async function updateDashboard() {
  try {
    const res = await fetch('/api/system_stats');
    const data = await res.json();
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

    // System stats
    setText("cpu-value", data.cpu + "%");
    setText("ram-value", data.ram + "%");
    setMeter("cpu-bar", data.cpu);
    setMeter("ram-bar", data.ram);
    setMeter("disk-bar", data.disk_percent);

    // Storage
    const used = Math.round((data.disk_total_gb - data.disk_free_gb) * 10) / 10;
    setText("disk-used", used);
    setText("disk-of", `GB of ${data.disk_total_gb} GB used`);
    setText("disk-free", `Free: ${data.disk_free_gb} GB`);
    setText("stat-disk", data.disk_percent + "%");

    setText("net-value", `${data.upload_gb} GB ↑ / ${data.download_gb} GB ↓`);
  } catch (err) {
    console.error("Failed to load system stats:", err);
  }

  updateCameraWall();
}

/* ---------- Expose Session ID ---------- */
window.SESSION_ID = getSessionId();