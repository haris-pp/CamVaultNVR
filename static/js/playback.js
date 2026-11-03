/*--------------------------Playback section (page file: playback.js)---------------------------
  Layout: [camera list + calendar] | [player + 24-hour timeline]
  - Pick a camera, pick a day (days with footage are green), then click or drag on the
    24-hour bar to watch from that time. The red marker follows the video.
  - Zoom 24 h / 6 h / 1 h for a closer look; the mouse wheel moves the zoomed view.
  - Playback goes on by itself over the gaps and into the next day with footage.
  - Settings used: skip seconds, default speed, longest range loaded at once, 12 / 24-hour clock.
  Backend: playback_api.py (/api/playback/days, /summary, /day, /window)
-----------------------------------------------------------------------*/

const PB_DAY = 86400;
const PB_SPEEDS = [0.5, 1, 1.5, 2];
const PB_PRE_ROLL = 120;            // seconds loaded before the chosen time, so a small step back needs no reload
const PB_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PB_WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PB_GRADS = [
  'linear-gradient(135deg,#5d7d92,#c9dbe0)', 'linear-gradient(135deg,#1e3a5f,#5b7fa6)',
  'linear-gradient(135deg,#3f3f46,#8b8b94)', 'linear-gradient(135deg,#27413a,#5f8a7c)',
  'linear-gradient(135deg,#4a3b32,#9a8068)', 'linear-gradient(135deg,#2c3e55,#7a8ea6)'
];

let PB_24H = false;                 // Settings > Playback: clock style
let PB_RANGE = 7200;                // Settings > Playback: longest stretch loaded at once
let PB_SKIP = 10;                   // Settings > Playback: skip seconds
let pbLast = { source: null, date: null };   // remembered while the app is open

const pb = {
  cams: [], cam: null,
  summary: {},                      // folder -> {secs, sessions} for the selected day
  snaps: {},                        // camera id -> {url, w, h}
  days: new Set(), latest: null, today: null,
  month: null,                      // {y, m} shown in the calendar
  date: null,                       // selected day, YYYY-MM-DD
  sessions: [], total: 0, count: 0, // footage of the selected day
  dayLoading: false,
  zoom: 24, viewStart: 0,           // hours shown on the bar, and the second at its left edge
  win: null,                        // playlist window currently in the player
  playAbs: null,                    // second of the day under the playhead (null = nothing playing)
  cue: null,                        // where playback will start when Play is pressed
  scrub: null,                      // second the user is dragging to
  rate: 1,
  req: 0, dayReq: 0, sumReq: 0, run: 0,
  pendingSeek: null,
  player: null, ov: {}, el: {},
  panLock: 0, timers: {}, noteTimer: null
};
window.pb = pb;

/* ---------- Small helpers ---------- */
const pbEsc = s => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const pbPad = n => String(n).padStart(2, '0');
const pbClamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pbDateStr = d => `${d.getFullYear()}-${pbPad(d.getMonth() + 1)}-${pbPad(d.getDate())}`;
const pbParseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const pbById = id => document.getElementById(id);
const pbGrad = i => PB_GRADS[i % PB_GRADS.length];

// 08:18:22 PM  /  20:18:22
function pbClock(sec, withSec = true) {
  sec = pbClamp(Math.floor(sec), 0, PB_DAY - 1);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (PB_24H) return `${pbPad(h)}:${pbPad(m)}${withSec ? ':' + pbPad(s) : ''}`;
  return `${pbPad(h % 12 || 12)}:${pbPad(m)}${withSec ? ':' + pbPad(s) : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

// 06:00 – 09:30 AM  /  11:00 AM – 01:00 PM
function pbRange(a, b) {
  a = Math.floor(a / 60) * 60;
  b = Math.min(Math.ceil(b / 60) * 60, PB_DAY - 60);
  if (PB_24H) return `${pbClock(a, false)} – ${pbClock(b, false)}`;
  const same = (a < 43200) === (b < 43200);
  return same ? `${pbClock(a, false).slice(0, 5)} – ${pbClock(b, false)}` : `${pbClock(a, false)} – ${pbClock(b, false)}`;
}

// 9 h 48 min · 31 min · 40 s
function pbDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return `${h} h${m ? ' ' + pbPad(m) + ' min' : ''}`;
  if (m) return `${m} min`;
  return `${sec} s`;
}

function pbDayLabel(str, long = true) {          // Sat, 31 Oct 2026
  const d = pbParseDate(str);
  return `${PB_WD[d.getDay()]}${long ? ',' : ''} ${pbPad(d.getDate())} ${PB_MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}

// "8:18 pm", "08:18:22 PM", "20:18", "8pm", "7" -> seconds of the day, or null
function pbParseTime(text) {
  const m = String(text || '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*([ap])?\.?m?\.?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mi = m[2] != null ? parseInt(m[2], 10) : 0;
  const s = m[3] != null ? parseInt(m[3], 10) : 0;
  if (mi > 59 || s > 59) return null;
  if (m[4]) {
    if (h < 1 || h > 12) return null;
    h = h % 12 + (m[4] === 'p' ? 12 : 0);
  } else if (h > 23) return null;
  return h * 3600 + mi * 60 + s;
}

/* ---------- Page ---------- */
const PB_ICON = {
  play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 001.5.86l12-7.5a1 1 0 000-1.72l-12-7.5A1 1 0 007 4.5z"/></svg>',
  pause: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  bigplay: '<svg width="38" height="38" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 001.5.86l12-7.5a1 1 0 000-1.72l-12-7.5A1 1 0 007 4.5z"/></svg>',
  vol: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 010 7"/></svg>',
  mute: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9.5l4 5M21 9.5l-4 5"/></svg>',
  full: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  prev: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  next: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'
};

async function loadPlayback() {
  pbLeave();
  const run = pb.run;
  if (typeof hideChannelSidebar === 'function') hideChannelSidebar();

  const open = window.pbOpen || {};
  window.pbOpen = null;

  // Settings > Playback
  try {
    const data = await (await fetch('/api/settings')).json();
    PB_24H = data.time_format === '24h';
    PB_RANGE = [3600, 7200, 14400].includes(Number(data.max_play_range)) ? Number(data.max_play_range) : 7200;
    PB_SKIP = Math.max(1, parseInt(data.skip_duration, 10) || 10);
    pb.rate = PB_SPEEDS.includes(Number(data.default_speed)) ? Number(data.default_speed) : 1;
  } catch (e) { /* keep the defaults */ }
  if (run !== pb.run) return;          // another page was opened while the settings loaded

  pb.cams = []; pb.cam = null; pb.summary = {}; pb.days = new Set(); pb.latest = null;
  pb.date = null; pb.sessions = []; pb.total = 0; pb.count = 0; pb.win = null;
  pb.playAbs = null; pb.cue = null; pb.scrub = null; pb.zoom = 24; pb.viewStart = 0;

  pbById('content').innerHTML = `
    <div class="pb-page">
      <aside class="pb-side">
        <section class="pb-card pb-cams" aria-label="Camera">
          <div class="pb-cardhead"><h2>Camera</h2><span id="pb-camcount"></span></div>
          <div class="pb-camlist" id="pb-camlist"><p class="pb-empty-note">Loading cameras…</p></div>
        </section>
        <section class="pb-card pb-cal" aria-label="Calendar">
          <div class="pb-calhead">
            <button type="button" class="pb-round" id="pb-mprev" aria-label="Previous month">${PB_ICON.prev}</button>
            <b id="pb-mtitle"></b>
            <button type="button" class="pb-round" id="pb-mnext" aria-label="Next month">${PB_ICON.next}</button>
          </div>
          <div class="pb-grid7" id="pb-cal"></div>
          <div class="pb-legend"><i></i><span id="pb-legend">Days with footage</span><button type="button" class="pb-link" id="pb-latest">Latest day</button></div>
        </section>
      </aside>

      <div class="pb-main">
        <div class="pb-stage is-idle" id="pb-stage">
          <video id="pb-video" class="video-js" playsinline preload="auto"></video>
        </div>

        <section class="pb-card pb-dock" aria-label="Day timeline">
          <div class="pb-dockhead">
            <button type="button" class="pb-round pb-round--lg" id="pb-dprev" aria-label="Previous day">${PB_ICON.prev}</button>
            <span class="pb-date" id="pb-date"></span>
            <button type="button" class="pb-round pb-round--lg" id="pb-dnext" aria-label="Next day">${PB_ICON.next}</button>
            <span class="pb-pill is-none" id="pb-pill"></span>
            <span class="pb-spacer"></span>
            <span class="pb-eyebrow">Zoom</span>
            <div class="pb-seg" id="pb-zoom" role="group" aria-label="Zoom">
              <button type="button" data-z="24" class="is-on">24 h</button>
              <button type="button" data-z="6">6 h</button>
              <button type="button" data-z="1">1 h</button>
            </div>
          </div>

          <div class="pb-tl">
            <div class="pb-track" id="pb-track" tabindex="0" role="slider" aria-label="Time of day" aria-valuemin="0" aria-valuemax="${PB_DAY}" aria-valuenow="0">
              <div class="pb-clip"><div id="pb-grid"></div><div id="pb-blocks"></div><div class="pb-none" id="pb-none" hidden></div></div>
              <div class="pb-hover" id="pb-hover" hidden><i></i><b></b></div>
              <div class="pb-head" id="pb-head" hidden><i class="line"></i><i class="knob"></i><b class="pb-bubble" id="pb-bubble"></b></div>
            </div>
            <div class="pb-ticks" id="pb-ticks"></div>
          </div>

          <div class="pb-jump">
            <div class="pb-chips" id="pb-chips"></div>
            <input type="text" class="pb-goto" id="pb-goto" aria-label="Go to time" placeholder="hh:mm" autocomplete="off" spellcheck="false">
            <button type="button" class="pb-gobtn" id="pb-go">Go</button>
          </div>
        </section>
      </div>
    </div>`;

  pbBuildPlayer();
  pbWire();
  pbRenderTimeline();
  pbRenderHead();
  pbRenderCalendar();
  pbSetStage();

  pb.timers.refresh = setInterval(() => { if (pb.date && pb.date === pb.today) pbRefreshDay(); }, 30000);

  await pbInit(open, run);
}

// Called by the menu when another page opens, so a video never keeps playing behind the scenes
function pbLeave() {
  Object.values(pb.timers).forEach(t => clearInterval(t));
  pb.timers = {};
  clearTimeout(pb.noteTimer);
  pb.req++; pb.dayReq++; pb.sumReq++; pb.run++;
  if (pb.cam) pbLast = { source: pb.cam.record_folder_name, date: pb.date };
  if (pb.player) {
    try { pb.player.pause(); pb.player.dispose(); } catch (e) { /* already gone */ }
    pb.player = null;
  }
  pb.ov = {};
  pb.win = null;
}

/* ---------- Player ---------- */
class PbOverlay extends videojs.getComponent('Component') {
  createEl() {
    return super.createEl('div', {
      className: 'pb-ov',
      innerHTML: `
        <div class="pb-hit" data-act="toggle"></div>
        <div class="pb-top" id="pb-top"></div>
        <div class="pb-cue"><button type="button" data-act="cue" aria-label="Play">${PB_ICON.bigplay}</button><span id="pb-cuetxt"></span></div>
        <div class="pb-note" id="pb-note" role="status" aria-live="polite"></div>
        <div class="pb-bar">
          <button type="button" class="pb-play-btn" data-act="toggle" id="pb-pp" aria-label="Play">${PB_ICON.play}</button>
          <button type="button" class="pb-skip" data-act="back" id="pb-back" aria-label="Back">−${PB_SKIP}s</button>
          <button type="button" class="pb-skip" data-act="fwd" id="pb-fwd" aria-label="Forward">+${PB_SKIP}s</button>
          <span class="pb-grow"></span>
          <button type="button" class="pb-speed" data-act="speed" id="pb-speed" aria-label="Playback speed">1×</button>
          <span class="pb-vol"><button type="button" class="pb-icon" data-act="mute" id="pb-mute" aria-label="Mute">${PB_ICON.vol}</button><input type="range" id="pb-vol" min="0" max="1" step="0.05" value="1" aria-label="Volume"></span>
          <button type="button" class="pb-icon" data-act="full" aria-label="Full screen">${PB_ICON.full}</button>
        </div>`
    });
  }
}
if (!videojs.getComponent('PbOverlay')) videojs.registerComponent('PbOverlay', PbOverlay);

function pbBuildPlayer() {
  const p = videojs('pb-video', {
    controls: false, fluid: false, preload: 'auto', bigPlayButton: false, loadingSpinner: false,
    userActions: { click: false, doubleClick: false, hotkeys: false }
  });
  p.defaultPlaybackRate(pb.rate);
  p.playbackRate(pb.rate);
  pb.player = p;

  const ov = p.addChild('PbOverlay', {});
  const el = ov.el();
  pb.ov = {
    root: el, top: el.querySelector('#pb-top'), cuetxt: el.querySelector('#pb-cuetxt'), note: el.querySelector('#pb-note'),
    pp: el.querySelector('#pb-pp'), speed: el.querySelector('#pb-speed'), mute: el.querySelector('#pb-mute'), vol: el.querySelector('#pb-vol')
  };
  pb.ov.speed.textContent = pb.rate + '×';

  el.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b) pbAct(b.dataset.act);
  });
  el.addEventListener('dblclick', e => { if (e.target.classList.contains('pb-hit')) pbAct('full'); });
  pb.ov.vol.addEventListener('input', () => { p.volume(parseFloat(pb.ov.vol.value)); p.muted(p.volume() === 0); });

  p.on('play', pbSetStage);
  p.on('playing', () => {
    pbNoteHide(); pbSetStage();
    if (pb.afterLoadNote) { pbNote(pb.afterLoadNote); pb.afterLoadNote = ''; }
  });
  p.on('pause', pbSetStage);
  p.on('waiting', () => { if (!p.paused()) pbNote('Loading…', 0); });
  p.on('canplay', pbNoteHide);
  p.on('timeupdate', pbOnTime);
  p.on('seeked', pbOnTime);
  p.on('ended', pbOnEnded);
  p.on('volumechange', () => {
    pb.ov.mute.innerHTML = (p.muted() || p.volume() === 0) ? PB_ICON.mute : PB_ICON.vol;
    if (!p.muted()) pb.ov.vol.value = p.volume();
  });
  p.on('loadedmetadata', () => {
    if (pb.pendingSeek != null) {
      const t = pb.pendingSeek;
      pb.pendingSeek = null;
      if (t > 0.5) p.currentTime(t);
    }
  });
  p.on('error', () => {
    const err = p.error();
    console.error('Playback error', err);
    pbNote('This part of the recording could not be played' + (err && err.code ? ` (error ${err.code})` : ''), 6000);
  });
}

function pbAct(act) {
  const p = pb.player;
  if (!p) return;
  switch (act) {
    case 'cue': return pbPlayAt(pb.cue != null ? pb.cue : 0);
    case 'toggle':
      if (!pb.win) return pbPlayAt(pb.cue != null ? pb.cue : 0);
      return p.paused() ? p.play() : p.pause();
    case 'back': return pbSkip(-PB_SKIP);
    case 'fwd': return pbSkip(PB_SKIP);
    case 'speed': {
      pb.rate = PB_SPEEDS[(PB_SPEEDS.indexOf(pb.rate) + 1) % PB_SPEEDS.length];
      p.defaultPlaybackRate(pb.rate);
      p.playbackRate(pb.rate);
      pb.ov.speed.textContent = pb.rate + '×';
      return;
    }
    case 'mute': return p.muted(!p.muted());
    case 'full': return p.isFullscreen() ? p.exitFullscreen() : p.requestFullscreen();
  }
}

// Step forward / back from where the video is now (goes over window edges and gaps correctly)
function pbSkip(delta) {
  if (pb.playAbs == null) return;
  pbPlayAt(pbClamp(pb.playAbs + delta, 0, PB_DAY - 1), { quiet: true });
}

function pbResetPlayer() {
  const p = pb.player;
  pb.req++;
  pb.win = null;
  pb.playAbs = null;
  pb.pendingSeek = null;
  pb.afterLoadNote = '';
  if (p) {
    try { p.pause(); p.reset(); } catch (e) { /* nothing loaded yet */ }
    const snap = pb.cam && pb.snaps[pb.cam.id];
    if (snap) p.poster(snap.url);
  }
  pbNoteHide();
  pbSetStage();
}

// Stage classes: idle (nothing loaded), playing, no footage on this day
function pbSetStage() {
  const st = pbById('pb-stage');
  if (!st) return;
  const p = pb.player;
  const loaded = !!pb.win;
  st.classList.toggle('is-idle', !loaded);
  st.classList.toggle('is-playing', loaded && !!p && !p.paused());
  st.classList.toggle('no-footage', !loaded && pb.cue == null);
  if (pb.ov.pp) {
    const playing = loaded && p && !p.paused();
    pb.ov.pp.innerHTML = playing ? PB_ICON.pause : PB_ICON.play;
    pb.ov.pp.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  if (pb.ov.cuetxt) {
    pb.ov.cuetxt.textContent = !pb.cam ? 'Pick a camera'
      : pb.dayLoading ? 'Loading…'
      : pb.cue != null ? `Play from ${pbClock(pb.cue)}` : 'No footage on this day · pick a green day';
  }
  pbSetOsd();
}

function pbSetOsd() {
  if (!pb.ov.top) return;
  if (!pb.cam || !pb.date) { pb.ov.top.innerHTML = ''; return; }
  const abs = pb.scrub != null ? pb.scrub : (pb.playAbs != null ? pb.playAbs : pb.cue);
  const when = abs != null ? `${pbDayLabel(pb.date, false)} · ${pbClock(abs)}` : `No footage on ${pbDayLabel(pb.date, false)}`;
  pb.ov.top.innerHTML = `<b>${pbEsc(pb.cam.name)}</b><span>${when}</span>`;
}

function pbNote(msg, ms = 3500) {
  const n = pb.ov.note;
  if (!n) return;
  clearTimeout(pb.noteTimer);
  n.textContent = msg;
  n.classList.add('is-on');
  if (ms) pb.noteTimer = setTimeout(pbNoteHide, ms);
}
function pbNoteHide() {
  clearTimeout(pb.noteTimer);
  if (pb.ov.note) pb.ov.note.classList.remove('is-on');
}

/* ---------- Cameras ---------- */
async function pbInit(open, run) {
  let cams = [];
  try {
    cams = await (await fetch('/api/cameras')).json();
  } catch (e) { console.error('Could not load the cameras', e); }
  if (run !== pb.run) return;
  pb.cams = Array.isArray(cams) ? cams : [];
  pbRenderCams();
  if (!pb.cams.length) { pbSetStage(); return; }
  pbLoadSnaps();

  const want = open.source || pbLast.source;
  let cam = pb.cams.find(c => c.record_folder_name === want);
  let days = null;
  if (!cam) {                       // no camera asked for: start with the first one that has footage
    for (const c of pb.cams) {
      days = await pbFetchDays(c.record_folder_name);
      if (days && days.days.length) { cam = c; break; }
    }
    if (!cam) { cam = pb.cams[0]; days = null; }
    if (run !== pb.run) return;
  }
  await pbSelectCamera(cam, { date: open.date || (cam.record_folder_name === pbLast.source ? pbLast.date : null), days });
}

async function pbFetchDays(folder) {
  try {
    const r = await fetch(`/api/playback/days?source=${encodeURIComponent(folder)}`);
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

async function pbSelectCamera(cam, opt = {}) {
  pb.cam = cam;
  pbResetPlayer();
  pbRenderCams();
  const r = opt.days || await pbFetchDays(cam.record_folder_name);
  if (pb.cam !== cam) return;       // another camera was picked meanwhile
  pb.days = new Set(r ? r.days : []);
  pb.latest = r ? r.latest : null;
  pb.today = (r && r.today) || pbDateStr(new Date());
  const date = opt.date || pb.date || pb.latest || pb.today;
  await pbSelectDate(date, opt);
}

function pbRenderCams() {
  const list = pbById('pb-camlist');
  if (!list) return;
  pbById('pb-camcount').textContent = pb.cams.length ? `${pb.cams.length} camera${pb.cams.length === 1 ? '' : 's'}` : '';
  if (!pb.cams.length) {
    list.innerHTML = '<p class="pb-empty-note">No cameras yet. Add one on the Cameras page.</p>';
    return;
  }
  list.innerHTML = pb.cams.map((c, i) => {
    const on = pb.cam && pb.cam.id === c.id;
    const rec = typeof camStatus === 'function' && camStatus(c).key === 'rec';
    const s = pb.summary[c.record_folder_name];
    const sub = !pb.date ? '' : !s ? '…' : s.secs > 0 ? pbDur(s.secs) : 'No footage';
    return `<button type="button" class="pb-cam${on ? ' is-on' : ''}" data-i="${i}" aria-pressed="${on}" title="${pbEsc(c.name)}">
      <span class="pb-cam__thumb" style="background:${pbGrad(i)}"><img class="pb-snap" alt="" data-cam="${c.id}" hidden></span>
      <span class="pb-cam__txt"><span class="pb-cam__name">${pbEsc(c.name)}</span><span class="pb-cam__sub${s && !s.secs ? ' is-none' : ''}">${sub}</span></span>
      <i class="pb-cam__dot${rec ? ' is-rec' : ''}" title="${rec ? 'Recording now' : 'Not recording'}"></i>
    </button>`;
  }).join('');
  // pictures that are already known
  pb.cams.forEach(c => { if (pb.snaps[c.id]) pbApplySnap(c.id, pb.snaps[c.id].url, true); });
}

function pbApplySnap(id, url, known) {
  document.querySelectorAll(`.pb-snap[data-cam="${id}"]`).forEach(img => {
    img.onerror = () => { img.hidden = true; };
    img.src = url;
    img.hidden = false;
  });
  if (known) return;
  const im = new Image();
  im.onload = () => {
    pb.snaps[id] = { url, w: im.naturalWidth, h: im.naturalHeight };
    if (pb.cam && pb.cam.id === id && pb.player && !pb.win) pb.player.poster(url);
  };
  im.src = url;
}

// Camera pictures from go2rtc, the same source the Cameras page and the Download page use
async function pbLoadSnaps() {
  if (typeof getLiveConfig !== 'function') return;
  let cfg;
  try { cfg = await getLiveConfig(true); } catch (e) { return; }
  if (!cfg || !cfg.available) return;
  pb.cams.forEach(async cam => {
    const name = 'cam_' + cam.id;
    if (typeof snapCache !== 'undefined' && snapCache[name]) pbApplySnap(cam.id, snapCache[name]);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const r = await fetch(`${cfg.base}/api/frame.jpeg?src=${encodeURIComponent(name)}`, { signal: ctrl.signal });
      const blob = r.ok ? await r.blob() : null;
      if (!blob || !blob.type.startsWith('image/') || blob.size < 200) return;
      if (!pbById('pb-camlist')) return;           // page was closed meanwhile
      pbApplySnap(cam.id, URL.createObjectURL(blob));
    } catch (e) { /* camera not reachable: keep the colour tile */ }
    finally { clearTimeout(timer); }
  });
}

async function pbLoadSummary() {
  const tok = ++pb.sumReq;
  const date = pb.date;
  try {
    const r = await fetch(`/api/playback/summary?date=${date}`);
    if (!r.ok) return;
    const data = await r.json();
    if (tok !== pb.sumReq) return;
    pb.summary = {};
    data.cameras.forEach(c => { pb.summary[c.folder] = { secs: c.secs, sessions: c.sessions }; });
    pbRenderCams();
  } catch (e) { /* the list just keeps its dots */ }
}

/* ---------- Day ---------- */
async function pbSelectDate(date, opt = {}) {
  if (!pb.cam) return;
  const dayChanged = date !== pb.date;
  pb.date = date;
  const d = pbParseDate(date);
  pb.month = { y: d.getFullYear(), m: d.getMonth() };
  if (opt.reset !== false) pbResetPlayer();
  pb.cue = null;
  pb.sessions = []; pb.total = 0; pb.count = 0;
  pb.dayLoading = true;
  pb.summary = dayChanged ? {} : pb.summary;
  pbRenderCalendar(); pbRenderHead(); pbRenderTimeline(); pbRenderCams(); pbSetStage();

  const tok = ++pb.dayReq;
  pbLoadSummary();
  let data = null;
  try {
    const r = await fetch(`/api/playback/day?source=${encodeURIComponent(pb.cam.record_folder_name)}&date=${date}`);
    data = r.ok ? await r.json() : null;
  } catch (e) { /* shown as "no footage" */ }
  if (tok !== pb.dayReq) return;

  pb.dayLoading = false;
  pbApplyDay(data);
  pb.cue = opt.cue != null ? opt.cue : (pb.sessions.length ? pb.sessions[0].from : null);
  pbCenterView(pb.cue);
  pbRenderCalendar(); pbRenderHead(); pbRenderTimeline(); pbSetStage(); pbAfterMove();
  if (opt.play && pb.cue != null) pbPlayAt(pb.cue, { quiet: true });
}

function pbApplyDay(data) {
  pb.sessions = data && Array.isArray(data.sessions) ? data.sessions : [];
  pb.total = data ? data.total || 0 : 0;
  pb.count = data ? data.count || 0 : 0;
  if (pb.sessions.length && pb.date) pb.days.add(pb.date);
}

// Quietly re-read today's footage, because recording keeps adding to it
async function pbRefreshDay() {
  if (!pb.cam || !pb.date) return;
  const tok = pb.dayReq, date = pb.date, cam = pb.cam;
  try {
    const r = await fetch(`/api/playback/day?source=${encodeURIComponent(cam.record_folder_name)}&date=${date}`);
    if (!r.ok) return;
    const data = await r.json();
    if (tok !== pb.dayReq || cam !== pb.cam || date !== pb.date) return;
    pbApplyDay(data);
    if (pb.cue == null && pb.sessions.length && !pb.win) pb.cue = pb.sessions[0].from;
    pbRenderCalendar(); pbRenderHead(); pbRenderTimeline(); pbSetStage();
  } catch (e) { /* try again next time */ }
}

function pbStepDay(n) {
  if (!pb.date) return;
  const d = pbParseDate(pb.date);
  d.setDate(d.getDate() + n);
  const s = pbDateStr(d);
  if (s > (pb.today || pbDateStr(new Date()))) return;
  pbSelectDate(s);
}

/* ---------- Calendar ---------- */
function pbRenderCalendar() {
  const grid = pbById('pb-cal');
  if (!grid || !pb.month) return;
  const { y, m } = pb.month;
  pbById('pb-mtitle').textContent = `${PB_MONTHS[m]} ${y}`;
  const today = pb.today || pbDateStr(new Date());
  const lead = (new Date(y, m, 1).getDay() + 6) % 7;                 // Monday first
  const count = new Date(y, m + 1, 0).getDate();
  let html = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(w => `<span class="pb-wd">${w}</span>`).join('');
  for (let i = 0; i < lead; i++) html += '<span class="pb-blank"></span>';
  for (let day = 1; day <= count; day++) {
    const ds = `${y}-${pbPad(m + 1)}-${pbPad(day)}`;
    const has = pb.days.has(ds), sel = ds === pb.date, future = ds > today;
    const cls = ['pb-day', has ? 'has' : '', sel ? 'is-sel' : '', ds === today ? 'is-today' : '', future ? 'is-future' : ''].filter(Boolean).join(' ');
    html += `<button type="button" class="${cls}" data-d="${ds}" ${future ? 'disabled' : ''} aria-pressed="${sel}" aria-label="${pbDayLabel(ds)}${has ? ', footage' : ', no footage'}">${day}</button>`;
  }
  grid.innerHTML = html;
  const cur = new Date(), atNow = y > cur.getFullYear() || (y === cur.getFullYear() && m >= cur.getMonth());
  pbById('pb-mnext').disabled = atNow;
  pbById('pb-legend').textContent = pb.cam ? `Footage from ${pb.cam.name}` : 'Days with footage';
  pbById('pb-latest').disabled = !pb.latest && !pb.sessions.length;
}

function pbShiftMonth(n) {
  if (!pb.month) return;
  const d = new Date(pb.month.y, pb.month.m + n, 1);
  pb.month = { y: d.getFullYear(), m: d.getMonth() };
  pbRenderCalendar();
}

/* ---------- Header of the timeline card ---------- */
function pbRenderHead() {
  const date = pbById('pb-date');
  if (!date) return;
  date.textContent = pb.date ? pbDayLabel(pb.date) : '';
  const pill = pbById('pb-pill');
  if (pb.dayLoading) { pill.textContent = 'Loading…'; pill.classList.add('is-none'); }
  else if (pb.sessions.length) {
    pill.textContent = `${pbDur(pb.total)} recorded · ${pb.sessions.length} session${pb.sessions.length === 1 ? '' : 's'}`;
    pill.classList.remove('is-none');
  } else {
    pill.textContent = pb.date ? 'No footage on this day' : '';
    pill.classList.add('is-none');
  }
  pbById('pb-dnext').disabled = !pb.date || pb.date >= (pb.today || pbDateStr(new Date()));
  document.querySelectorAll('#pb-zoom button').forEach(b => b.classList.toggle('is-on', Number(b.dataset.z) === pb.zoom));
  pbRenderChips();
}

function pbRenderChips() {
  const box = pbById('pb-chips');
  if (!box) return;
  box.dataset.cur = String(pbCurrentSession());
  if (!pb.sessions.length) {
    box.innerHTML = `<span class="pb-eyebrow">Jump to</span><span class="pb-nochips">${pb.dayLoading ? 'Loading…' : 'No sessions'}</span>`;
    return;
  }
  const cur = pbCurrentSession();
  box.innerHTML = '<span class="pb-eyebrow">Jump to</span>' + pb.sessions.map((s, i) =>
    `<button type="button" class="pb-chip${i === cur ? ' is-on' : ''}" data-i="${i}" title="Play from ${pbClock(s.from)}">${pbRange(s.from, s.to)}</button>`).join('');
}

function pbCurrentSession() {
  const abs = pb.playAbs != null ? pb.playAbs : pb.cue;
  if (abs == null) return -1;
  return pb.sessions.findIndex(s => abs >= s.from && abs < s.to + 1);
}

/* ---------- 24-hour timeline ---------- */
const pbSpan = () => pb.zoom * 3600;
const pbFrac = abs => (abs - pb.viewStart) / pbSpan();

function pbCenterView(abs) {
  const span = pbSpan();
  if (pb.zoom === 24) { pb.viewStart = 0; return; }
  const c = abs != null ? abs : pb.viewStart + span / 2;
  pb.viewStart = pbClamp(c - span / 2, 0, PB_DAY - span);
}

function pbTickLabel(sec, step) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (PB_24H) return step >= 3600 ? pbPad(h) : `${pbPad(h)}:${pbPad(m)}`;
  const mer = h < 12 ? 'a' : 'p';
  return `${h % 12 || 12}${step >= 3600 ? '' : ':' + pbPad(m)}${mer}`;
}

function pbRenderTimeline() {
  const track = pbById('pb-track');
  if (!track) return;
  const span = pbSpan(), v0 = pb.viewStart, v1 = v0 + span;
  const step = pb.zoom === 24 ? 3600 : pb.zoom === 6 ? 1800 : 300;

  let grid = '', ticks = '';
  for (let t = Math.ceil(v0 / step) * step; t <= v1 && t < PB_DAY; t += step) {
    const left = ((t - v0) / span * 100).toFixed(4);
    if (t > v0 && t < v1) grid += `<span class="pb-gl" style="left:${left}%"></span>`;
    ticks += `<span style="left:${left}%">${pbTickLabel(t, step)}</span>`;
  }
  pbById('pb-grid').innerHTML = grid;
  pbById('pb-ticks').innerHTML = ticks;

  pbById('pb-blocks').innerHTML = pb.sessions.filter(s => s.to > v0 && s.from < v1).map(s => {
    const a = Math.max(s.from, v0), b = Math.min(s.to, v1);
    return `<span class="pb-blk" style="left:${((a - v0) / span * 100).toFixed(4)}%;width:${((b - a) / span * 100).toFixed(4)}%" title="${pbRange(s.from, s.to)}"></span>`;
  }).join('');

  const none = pbById('pb-none');
  none.hidden = pb.sessions.length > 0;
  none.textContent = pb.dayLoading ? 'Loading…' : 'No footage on this day';
  pbUpdatePlayhead();
}

function pbUpdatePlayhead() {
  const head = pbById('pb-head');
  if (!head) return;
  const abs = pb.scrub != null ? pb.scrub : (pb.playAbs != null ? pb.playAbs : pb.cue);
  if (abs == null || !pb.sessions.length) { head.hidden = true; return; }
  const f = pbFrac(abs);
  if (f < -0.002 || f > 1.002) { head.hidden = true; return; }
  head.hidden = false;
  head.style.left = (pbClamp(f, 0, 1) * 100).toFixed(4) + '%';
  const bub = pbById('pb-bubble');
  bub.textContent = pbClock(abs);
  bub.className = 'pb-bubble' + (f < 0.05 ? ' edge-l' : f > 0.95 ? ' edge-r' : '');
  const track = pbById('pb-track');
  track.setAttribute('aria-valuenow', Math.round(abs));
  track.setAttribute('aria-valuetext', pbClock(abs));
}

const pbXToAbs = clientX => {
  const r = pbById('pb-track').getBoundingClientRect();
  return pb.viewStart + pbClamp((clientX - r.left) / r.width, 0, 1) * pbSpan();
};

function pbSetZoom(z) {
  if (![24, 6, 1].includes(z) || z === pb.zoom) return;
  const center = pb.scrub != null ? pb.scrub : (pb.playAbs != null ? pb.playAbs : (pb.cue != null ? pb.cue : pb.viewStart + pbSpan() / 2));
  pb.zoom = z;
  pbCenterView(center);
  pb.panLock = 0;
  pbRenderHead();
  pbRenderTimeline();
}

// While the video plays, a zoomed bar moves along with it (unless the user has just moved it by hand)
function pbFollow() {
  if (pb.zoom === 24 || pb.playAbs == null || pb.scrub != null || Date.now() < pb.panLock) return;
  const span = pbSpan();
  if (pb.playAbs < pb.viewStart + span * 0.04 || pb.playAbs > pb.viewStart + span * 0.96) {
    pb.viewStart = pbClamp(pb.playAbs - span * 0.25, 0, PB_DAY - span);
    pbRenderTimeline();
  }
}

/* ---------- Playing ---------- */
// Seconds of the day -> position in the playlist window (a gap moves to the next piece of footage)
function pbAbsToPl(w, abs) {
  const s = w.segments;
  let lo = 0, hi = s.length - 1, i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid][0] <= abs) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (i < 0) return 0;
  const g = s[i];
  if (abs < g[0] + g[1]) return g[2] + (abs - g[0]);
  return i + 1 < s.length ? s[i + 1][2] : w.duration;
}

// Position in the playlist window -> seconds of the day
function pbPlToAbs(w, t) {
  const s = w.segments;
  let lo = 0, hi = s.length - 1, i = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid][2] <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const g = s[i];
  return g[0] + pbClamp(t - g[2], 0, g[1]);
}

// Where footage exists at or after abs: {abs, moved} or null
function pbSnap(abs) {
  for (const s of pb.sessions) {
    if (abs >= s.from && abs < s.to) return { abs, moved: false };
    if (s.from > abs) return { abs: s.from, moved: true };
  }
  return null;
}

async function pbPlayAt(abs, opt = {}) {
  const p = pb.player, cam = pb.cam;
  if (!p || !cam || !pb.date) return;
  if (!pb.sessions.length) { pbNote(pb.dayLoading ? 'Loading…' : 'No footage on this day'); pbAfterMove(); return; }
  abs = pbClamp(abs, 0, PB_DAY - 1);
  const snap = pbSnap(abs);
  if (!snap) { pbNote(`No footage after ${pbClock(abs, false)}`); pbAfterMove(); return; }
  const movedNote = snap.moved && !opt.quiet ? `No footage at ${pbClock(abs, false)} · jumped to ${pbClock(snap.abs, false)}` : '';
  abs = snap.abs;

  const w = pb.win;
  if (w && w.source === cam.record_folder_name && w.date === pb.date && abs >= w.from && abs < w.to) {
    pb.playAbs = abs;                           // the footage is already loaded: just move there
    if (movedNote) pbNote(movedNote);
    p.currentTime(pbAbsToPl(w, abs));
    p.play();
    pbAfterMove();
    return;
  }
  pb.afterLoadNote = movedNote;                 // shown once the picture is there
  await pbLoadWindow(abs, opt);
}

async function pbLoadWindow(abs, opt = {}) {
  const p = pb.player, cam = pb.cam, date = pb.date;
  const tok = ++pb.req;
  pb.cue = abs;
  pb.playAbs = abs;
  pbNote('Loading…', 0);
  pbAfterMove();

  const from = Math.max(0, Math.floor(abs - (opt.preRoll != null ? opt.preRoll : PB_PRE_ROLL)));
  const to = Math.min(PB_DAY, from + PB_RANGE);
  let data = null, err = '';
  try {
    const r = await fetch(`/api/playback/window?source=${encodeURIComponent(cam.record_folder_name)}&date=${date}&from=${from}&to=${to}&session_id=${encodeURIComponent(window.SESSION_ID)}`);
    data = await r.json();
    if (!r.ok) { err = data.error || 'Could not load the recording'; data = null; }
  } catch (e) { err = 'Could not reach the server'; }
  if (tok !== pb.req || !pb.player) return;     // something newer was asked for
  if (!data) { pb.playAbs = null; pbNote(err, 5000); pbSetStage(); pbAfterMove(); return; }

  pb.win = Object.assign({ source: cam.record_folder_name }, data);
  pb.pendingSeek = pbAbsToPl(pb.win, abs);
  const url = data.playlist_url + (data.transcode ? '?transcode=true' : '');
  p.poster('');
  p.src({ src: url, type: 'application/x-mpegURL' });
  p.defaultPlaybackRate(pb.rate);
  p.playbackRate(pb.rate);
  const started = p.play();
  if (started && started.catch) started.catch(() => { /* the browser asked for a click first */ });
  pbSetStage();
}

// Keeps the bar, the label, the chips and the time box in step with where the video is
function pbAfterMove() {
  pbUpdatePlayhead();
  pbSetOsd();
  const g = pbById('pb-goto');
  if (g && document.activeElement !== g) {
    const abs = pb.playAbs != null ? pb.playAbs : pb.cue;
    g.value = abs != null ? pbClock(abs) : '';
    g.classList.remove('is-bad');
  }
  const cur = pbCurrentSession();
  if (pb.sessions.length && pbById('pb-chips') && pbById('pb-chips').dataset.cur !== String(cur)) {
    pbById('pb-chips').dataset.cur = String(cur);
    pbRenderChips();
  }
}

function pbOnTime() {
  const p = pb.player, w = pb.win;
  if (!p || !w || pb.pendingSeek != null) return;
  pb.playAbs = pbPlToAbs(w, p.currentTime() || 0);
  pbFollow();
  pbAfterMove();
}

// The loaded stretch is finished: carry on with the next footage, today's newest included
async function pbOnEnded() {
  const w = pb.win;
  if (!w || !pb.cam) return;
  if (pb.date === pb.today) await pbRefreshDay();
  if (!pb.win) return;
  const next = pbSnap(w.to + 0.5);
  if (next) { pbPlayAt(next.abs, { quiet: true, preRoll: 0 }); return; }

  // nothing more today: continue on the next day that has footage
  const later = [...pb.days].filter(d => d > pb.date).sort()[0];
  if (later) {
    pbNote(`Continuing on ${pbDayLabel(later)}`);
    await pbSelectDate(later, { reset: false });
    if (pb.cue != null) pbPlayAt(pb.cue, { quiet: true, preRoll: 0 });
    return;
  }
  pbNote(pb.date === pb.today ? 'You have reached the latest recording' : 'End of recordings', 4000);
  pbSetStage();
}

/* ---------- Wiring ---------- */
function pbWire() {
  pbById('pb-camlist').addEventListener('click', e => {
    const b = e.target.closest('.pb-cam');
    if (!b) return;
    const cam = pb.cams[Number(b.dataset.i)];
    if (cam && (!pb.cam || cam.id !== pb.cam.id)) pbSelectCamera(cam);
  });

  pbById('pb-cal').addEventListener('click', e => {
    const b = e.target.closest('.pb-day');
    if (b && !b.disabled && b.dataset.d !== pb.date) pbSelectDate(b.dataset.d);
  });
  pbById('pb-mprev').addEventListener('click', () => pbShiftMonth(-1));
  pbById('pb-mnext').addEventListener('click', () => pbShiftMonth(1));
  pbById('pb-latest').addEventListener('click', () => {
    const d = pb.latest || pb.date;
    if (d) pbSelectDate(d);
  });
  pbById('pb-dprev').addEventListener('click', () => pbStepDay(-1));
  pbById('pb-dnext').addEventListener('click', () => pbStepDay(1));

  pbById('pb-zoom').addEventListener('click', e => {
    const b = e.target.closest('button[data-z]');
    if (b) pbSetZoom(Number(b.dataset.z));
  });

  pbById('pb-chips').addEventListener('click', e => {
    const b = e.target.closest('.pb-chip');
    if (b) pbPlayAt(pb.sessions[Number(b.dataset.i)].from, { quiet: true });
  });

  const go = () => {
    const input = pbById('pb-goto');
    const sec = pbParseTime(input.value);
    if (sec == null) {
      input.classList.add('is-bad');
      pbNote('Type a time like 8:30 PM or 20:30');
      return;
    }
    input.classList.remove('is-bad');
    input.blur();
    pbPlayAt(sec);
  };
  pbById('pb-go').addEventListener('click', go);
  pbById('pb-goto').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  pbById('pb-goto').addEventListener('input', () => pbById('pb-goto').classList.remove('is-bad'));

  // ---- the 24-hour bar: click or drag to choose a time, hover to read the time under the mouse ----
  const track = pbById('pb-track');
  const hover = pbById('pb-hover');
  track.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (!pb.sessions.length) { pbNote(pb.dayLoading ? 'Loading…' : 'No footage on this day'); return; }
    track.setPointerCapture(e.pointerId);
    pb.scrub = pbXToAbs(e.clientX);
    hover.hidden = true;
    pbUpdatePlayhead(); pbSetOsd();
  });
  track.addEventListener('pointermove', e => {
    if (pb.scrub != null) { pb.scrub = pbXToAbs(e.clientX); pbUpdatePlayhead(); pbSetOsd(); return; }
    if (!pb.sessions.length) { hover.hidden = true; return; }
    const r = track.getBoundingClientRect();
    const x = pbClamp(e.clientX - r.left, 0, r.width);
    hover.hidden = false;
    hover.style.left = x + 'px';
    hover.querySelector('b').textContent = pbClock(pbXToAbs(e.clientX));
  });
  track.addEventListener('pointerleave', () => { hover.hidden = true; });
  track.addEventListener('pointerup', e => {
    if (pb.scrub == null) return;
    const abs = pbXToAbs(e.clientX);
    pb.scrub = null;
    pbAfterMove();                                // the marker goes back to the real position first
    pbPlayAt(abs);
  });
  track.addEventListener('pointercancel', () => { pb.scrub = null; pbAfterMove(); });
  track.addEventListener('wheel', e => {
    if (pb.zoom === 24) return;                 // nothing to move at full day: let the page scroll
    e.preventDefault();
    const span = pbSpan();
    const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
    pb.viewStart = pbClamp(pb.viewStart + Math.sign(d) * span * 0.1, 0, PB_DAY - span);
    pb.panLock = Date.now() + 8000;
    pbRenderTimeline();
  }, { passive: false });
}

/*--------------------------Keyboard----------------------------*/
// Space / K play and pause, arrows skip, F full screen (not while typing in a box)
document.addEventListener('keydown', function (e) {
  if (typeof currentPage !== 'undefined' && currentPage !== 'playback') return;
  const p = pb.player;
  if (!p || !pbById('pb-stage')) return;
  const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;

  if (e.key === 'ArrowLeft') { e.preventDefault(); pbSkip(-PB_SKIP); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); pbSkip(PB_SKIP); }
  else if (e.key === ' ' || e.key.toLowerCase() === 'k') { e.preventDefault(); pbAct('toggle'); }
  else if (e.key.toLowerCase() === 'f') { e.preventDefault(); pbAct('full'); }
  else if (e.key.toLowerCase() === 'm') { e.preventDefault(); pbAct('mute'); }
});
