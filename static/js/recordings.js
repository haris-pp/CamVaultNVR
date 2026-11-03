/*--------------------------Download section (page file: recordings.js)---------------------------
  Layout: camera rail | player + timeline dock | sessions + clips panel.
  - The player is sized to the free height, so nothing needs scrolling.
  - One 24-hour timeline does both jobs: the blue band is the range to play
    AND the range to trim. Drag its handles, drag on the bar to draw a new range,
    click the bar to jump to a time, or type exact In / Out times.
  - A "session" is one continuous recorded block returned by /api/recording_slots.
  The backend API is unchanged.
-----------------------------------------------------------------------*/

let MAX_RANGE = 7200;        // longest range played in one go (Settings > Playback, default 2 hours)
let REC_24H = false;         // time format (Settings > Playback)
let REC_SPEED = 1;           // default playback speed (Settings > Playback)

// "2 h" / "1 h" / "4 h" for the current MAX_RANGE
const recMaxLabel = () => (MAX_RANGE / 3600) + ' h';
const DAY_SEC = 86400;

// Words shown in the UI for what the API calls "slots". Change them here.
const SESSION_LABEL = {
  title: 'Sessions',
  none: 'No recordings on this day',
  pick: 'Pick a session, or click the timeline'
};

let trimClips = [];          // clips queued for download
window.selectedSource = null; // record_folder_name of the selected camera

const rec = {
  name: '',                  // display name of the selected camera
  sessions: [],              // [{from_sec, to_sec, source, date}]
  sel: null,                 // {from, to} absolute seconds in the day: the play / trim range
  playAbs: null,             // absolute second of the playhead (null = nothing loaded)
  osd: null,                 // on-video label element
  cam: null,                 // selected camera object
  snaps: {},                 // camera id -> {url, w, h} latest snapshot (rail thumbnail, poster, aspect)
  drag: null,
  noteTimer: null
};

const TARGET_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>';
const REC_HINT = 'Drag the handles to trim · drag on the bar to draw a range · click to jump · I / O mark in / out';
const REC_GRADS = [
  'linear-gradient(135deg,#5d7d92,#c9dbe0)', 'linear-gradient(135deg,#1e3a5f,#5b7fa6)',
  'linear-gradient(135deg,#3f3f46,#8b8b94)', 'linear-gradient(135deg,#27413a,#5f8a7c)',
  'linear-gradient(135deg,#4a3b32,#9a8068)', 'linear-gradient(135deg,#2c3e55,#7a8ea6)'
];
const recGrad = i => REC_GRADS[i % REC_GRADS.length];

/* ---------- Time helpers ---------- */
function secondsToAmPm(sec) {
  sec = Math.max(0, Math.min(sec, DAY_SEC));
  const h24 = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (REC_24H) return `${String(h24 % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  const h12 = h24 % 12 || 12;
  const ampm = h24 < 12 ? 'AM' : 'PM';
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${ampm}`;
}

function timeStringToSeconds(t) {
  if (typeof t === 'number') return t;
  if (!t) return 0;
  const parts = t.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function recClock(sec) {                       // 9:18 PM
  const h24 = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  if (REC_24H) return `${String(h24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return `${h24 % 12 || 12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

function recInputTime(sec) {                   // 21:18:05 for <input type="time">
  sec = Math.max(0, Math.min(Math.round(sec), DAY_SEC - 1));
  return [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}

function recDuration(sec) {                    // 1 h 05 min · 31 min 28 s · 40 s
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h} h${m ? ' ' + String(m).padStart(2, '0') + ' min' : ''}`;
  if (m) return `${m} min${s ? ' ' + s + ' s' : ''}`;
  return `${s} s`;
}

function recLocalDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function recDayLabel(str) {                    // Mon, 02 Nov 2026
  const [y, m, d] = (str || '').split('-').map(Number);
  if (!y) return '';
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

const recDate = () => (document.getElementById('date-picker') || {}).value;
const recPct = sec => (Math.max(0, Math.min(sec, DAY_SEC)) / DAY_SEC * 100) + '%';

/* ---------- Aspect ratio, poster, on-video label ---------- */
// The video box takes the real aspect ratio of the footage (or of the camera snapshot), so there are no black bars inside it.
function recSetAspect(w, h) {
  if (!w || !h) return;
  const ar = Math.max(0.6, Math.min(w / h, 3.2));
  const stage = document.querySelector('.rec-stage');
  if (stage) stage.style.setProperty('--ar', ar.toFixed(4));
}

function recOsdSet(html) { if (rec.osd) rec.osd.innerHTML = html; }

// Before anything plays, show the camera's latest picture instead of a black box
function recSetPoster() {
  const p = window.player;
  if (!p || !rec.cam || p.trimMeta) return;
  const snap = rec.snaps[rec.cam.id];
  if (snap) {
    p.poster(snap.url);
    recSetAspect(snap.w, snap.h);
  }
  recOsdSet(`<span class="rec-osd__tag">Live preview</span><b>${escapeHtml(rec.name)}</b>`);
}

// Time-of-day tile for a session card: night / sunrise / day / sunset
function recSky(sec) {
  const h = (sec / 3600) % 24;
  const sun = '<svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" stroke="#fff" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5" stroke="none"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" fill="none"/></svg>';
  const low = '<svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" stroke="#fff" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 17a6 6 0 0112 0z" stroke="none"/><path d="M2 20h20M12 6v2.5M4.9 10.9l1.8 1.8M19.1 10.9l-1.8 1.8" fill="none"/></svg>';
  const moon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"/></svg>';
  if (h < 5 || h >= 20) return { bg: 'linear-gradient(135deg,#1e293b,#475569)', icon: moon };
  if (h < 8) return { bg: 'linear-gradient(135deg,#f08a4b,#f9cf9a)', icon: low };
  if (h < 17) return { bg: 'linear-gradient(135deg,#4a9ee0,#bfe0f7)', icon: sun };
  return { bg: 'linear-gradient(135deg,#9a5fb0,#f2a07a)', icon: low };
}

/* ---------- Page ---------- */
async function intRecordingPage() {
  const res = await fetch('/api/settings');
  const data = await res.json();
  let skipDuration = parseInt(data.skip_duration, 10);
  if (isNaN(skipDuration) || skipDuration <= 0) skipDuration = 10;
  window.skip_duration = skipDuration;

  // Settings > Playback
  MAX_RANGE = [3600, 7200, 14400].includes(Number(data.max_play_range)) ? Number(data.max_play_range) : 7200;
  REC_24H = data.time_format === '24h';
  REC_SPEED = [0.5, 1, 1.5, 2].includes(Number(data.default_speed)) ? Number(data.default_speed) : 1;

  const ticks = [0, 3, 6, 9, 12, 15, 18, 21].map(h =>
    `<span style="left:${h / 24 * 100}%">${String(h).padStart(2, '0')}:00</span>`).join('');

  document.getElementById('content').innerHTML = `
    <div class="rec-page">
      <div class="rec-stage">
        <div class="video-container">
          <video id="video-player" class="video-js" controls preload="auto" data-setup='{"playbackRates": [0.5, 1, 1.5, 2]}'>
            <p class="vjs-no-js">To view this video, enable JavaScript and consider upgrading to a web browser that supports HTML5 video.</p>
          </video>
        </div>
      </div>

      <section class="rec-dock" aria-label="Timeline and trim">
        <div class="rec-row">
          <button type="button" class="rec-iconbtn" id="rec-prev-day" aria-label="Previous day">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
          </button>
          <button type="button" class="rec-datebtn" id="rec-date-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>
            <span id="rec-date-text"></span>
          </button>
          <input type="date" id="date-picker" class="rec-date-input" value="${recLocalDate(new Date())}" aria-label="Date" tabindex="-1">
          <button type="button" class="rec-iconbtn" id="rec-next-day" aria-label="Next day">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
          </button>
          <button type="button" class="rec-linkbtn" id="rec-today">Today</button>
          <span class="rec-spacer"></span>
          <span class="rec-hint" id="rec-hint">${REC_HINT}</span>
        </div>

        <div class="rec-timeline">
          <div class="rec-ticks">${ticks}</div>
          <div class="rec-bar" id="rec-bar">
            <div id="rec-blocks"></div>
            <div class="rec-sel" id="rec-sel" hidden>
              <i class="rec-handle rec-handle--in" data-h="in" title="Drag to move In"></i>
              <i class="rec-handle rec-handle--out" data-h="out" title="Drag to move Out"></i>
            </div>
            <div class="rec-playhead" id="rec-playhead" hidden></div>
          </div>
        </div>

        <div class="rec-row rec-row--controls">
          <div class="rec-field">
            <label for="rec-in">In</label>
            <input type="time" step="1" id="rec-in" class="rec-time" disabled>
            <button type="button" class="rec-mini" id="rec-in-use" title="Set from the player position (I)" aria-label="Set In from the player" disabled>${TARGET_ICON}</button>
          </div>
          <div class="rec-field">
            <label for="rec-out">Out</label>
            <input type="time" step="1" id="rec-out" class="rec-time" disabled>
            <button type="button" class="rec-mini" id="rec-out-use" title="Set from the player position (O)" aria-label="Set Out from the player" disabled>${TARGET_ICON}</button>
          </div>
          <span class="rec-len" id="rec-len">No range</span>
          <div class="rec-actions">
            <button type="button" class="btn" id="rec-play-range" disabled>Preview range</button>
            <button type="button" class="btn btn--primary" id="rec-add" disabled>+ Add to clips</button>
          </div>
        </div>
      </section>
    </div>
  `;

  rec.sel = null;
  rec.playAbs = null;
  rec.sessions = [];

  if (window.player) {
    window.player.dispose();
    window.player = null;
  }

  // Initialize Video.js player
  const player = videojs('video-player', {
    fluid: false,
    controlBar: {
      timeDivider: true,
      durationDisplay: true,
      currentTimeDisplay: true,
      progressControl: true,
      fullscreenToggle: true,
      playbackRateMenuButton: true,
      skipButtons: {
        forward: window.skip_duration,
        backward: window.skip_duration
      }
    },
    userActions: { hotkeys: true }
  });
  player.defaultPlaybackRate(REC_SPEED);   // every new recording starts at the speed chosen in Settings
  player.playbackRate(REC_SPEED);

  player.ready(function () {
    this.hotkeys({
      volumeStep: 0.1,
      seekStep: 5,
      enableModifiersForNumbers: false,
      alwaysCaptureHotkeys: true,
      enableFullscreen: true,
      enableVolumeScroll: true,
      enableNumbers: true,

      playPauseKey: function (e) {
        if (e.which === 32 || e.which === 75) { // space or K
          const p = videojs.getPlayer('video-player');
          if (p.paused()) p.play(); else p.pause();
          return true;
        }
        return false;
      },
      fullscreenKey: function (e) { return e.which === 70; },   // F
      seekStep: window.skip_duration,
      rewindKey: function (e) { return e.which === 37; },       // left arrow
      forwardKey: function (e) { return e.which === 39; }       // right arrow
    });

    // Short stalls while seeking
    const tech = player.tech({ IWillNotUseThisInPlugins: true });
    if (tech && tech.vhs) {
      tech.vhs.xhr.beforeRequest = function (opt) {
        opt.timeout = 250;
        return opt;
      };
    }
  });

  // Keep the control bar visible
  player.controlBar.show();
  player.controlBar.el().style.display = 'flex';
  player.on('userinactive', function () { player.controlBar.show(); });

  window.player = player;

  // ---- Overlay message (centre of the video) ----
  const Component = videojs.getComponent('Component');

  class OverlayMessage extends Component {
    constructor(p, options) {
      super(p, options);
      this.addClass('vjs-overlay-message');
      this.el().id = 'overlay-message';
      this.el().style.cssText = `
        position: absolute;
        top: 35%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 10px 20px;
        border-radius: 5px;
        font-size: 1.5em;
        z-index: 100;
        display: none;
      `;
      this.el().textContent = 'Select camera and date to load recordings';
    }
    setMessage(message) {
      this.el().textContent = message;
      this.el().style.display = 'block';
    }
    hideMessage() {
      this.el().style.display = 'none';
    }
  }
  videojs.registerComponent('OverlayMessage', OverlayMessage);
  player.addChild('OverlayMessage', {}, 0);
  player.on('play', () => player.getChild('OverlayMessage').hideMessage());

  // ---- On-video label: camera · day · time of day ----
  class RecOsd extends Component {
    constructor(p, options) {
      super(p, options);
      this.addClass('rec-osd');
    }
  }
  videojs.registerComponent('RecOsd', RecOsd);
  rec.osd = player.addChild('RecOsd', {}, 1).el();

  player.on('timeupdate', recOnTimeUpdate);
  player.on('loadedmetadata', recOnTimeUpdate);
  player.on('loadedmetadata', () => recSetAspect(player.videoWidth(), player.videoHeight()));

  recWireDock();
  recRenderAll();

  intCahnnelSideBar();

  document.getElementById('rightbar').innerHTML = `
    <section class="rp-sessions">
      <div class="rp-head">
        <div><h3>${SESSION_LABEL.title}</h3><div class="rp-sub" id="rp-sessions-sub"></div></div>
        <span class="rp-count" id="rp-sessions-count"></span>
      </div>
      <div class="rp-sessions-body" id="rp-sessions-body"><p class="rp-empty">Select a camera to see its ${SESSION_LABEL.title.toLowerCase()}.</p></div>
    </section>
    <section class="rp-clips" id="rp-clips"></section>
  `;
  updateTrimListUI();
}

/* ---------- Dock: date, timeline, range controls ---------- */
function recWireDock() {
  const dateEl = document.getElementById('date-picker');

  document.getElementById('rec-date-btn').addEventListener('click', () => {
    try { dateEl.showPicker ? dateEl.showPicker() : dateEl.focus(); } catch (e) { dateEl.focus(); }
  });
  dateEl.addEventListener('change', recOnDateChange);

  const shiftDay = n => {
    const [y, m, d] = dateEl.value.split('-').map(Number);
    dateEl.value = recLocalDate(new Date(y, m - 1, d + n));
    recOnDateChange();
  };
  document.getElementById('rec-prev-day').addEventListener('click', () => shiftDay(-1));
  document.getElementById('rec-next-day').addEventListener('click', () => shiftDay(1));
  document.getElementById('rec-today').addEventListener('click', () => {
    dateEl.value = recLocalDate(new Date());
    recOnDateChange();
  });

  // Typed In / Out
  const onTyped = () => {
    const from = timeStringToSeconds(document.getElementById('rec-in').value);
    const to = timeStringToSeconds(document.getElementById('rec-out').value);
    if (to <= from) {
      recNote('Out must be after In');
      recRenderSel();
      return;
    }
    recSetSel(from, to);
  };
  document.getElementById('rec-in').addEventListener('change', onTyped);
  document.getElementById('rec-out').addEventListener('change', onTyped);

  document.getElementById('rec-in-use').addEventListener('click', () => recUsePlayer('in'));
  document.getElementById('rec-out-use').addEventListener('click', () => recUsePlayer('out'));
  document.getElementById('rec-play-range').addEventListener('click', recPlayRange);
  document.getElementById('rec-add').addEventListener('click', recAddClip);

  // Timeline pointer handling: handles, draw a range, click to jump
  const bar = document.getElementById('rec-bar');
  const secAt = x => {
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(DAY_SEC, Math.round((x - r.left) / r.width * DAY_SEC)));
  };

  bar.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !window.selectedSource) return;
    bar.setPointerCapture(e.pointerId);
    rec.drag = { mode: e.target.dataset.h || 'new', x0: e.clientX, s0: secAt(e.clientX), moved: false };
    if (e.target.dataset.h) e.preventDefault();
  });

  bar.addEventListener('pointermove', e => {
    const d = rec.drag;
    if (!d) return;
    const s = secAt(e.clientX);
    if (d.mode === 'in' && rec.sel) recSetSel(Math.min(s, rec.sel.to - 1), rec.sel.to);
    else if (d.mode === 'out' && rec.sel) recSetSel(rec.sel.from, Math.max(s, rec.sel.from + 1));
    else if (d.mode === 'new' && (d.moved || Math.abs(e.clientX - d.x0) > 4)) {
      d.moved = true;
      recSetSel(Math.min(d.s0, s), Math.max(d.s0, s, Math.min(d.s0, s) + 1));
    }
  });

  const endDrag = e => {
    const d = rec.drag;
    rec.drag = null;
    if (d && d.mode === 'new' && !d.moved && e.type === 'pointerup') recJumpTo(d.s0);
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
}

function recOnDateChange() {
  recResetPlayer(SESSION_LABEL.pick);
  rec.sel = null;
  rec.playAbs = null;
  rec.sessions = [];
  recRenderAll();
  if (window.selectedSource) loadRecordingSlots();
}

function recNote(msg) {
  const el = document.getElementById('rec-hint');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('is-note');
  clearTimeout(rec.noteTimer);
  rec.noteTimer = setTimeout(() => {
    el.textContent = REC_HINT;
    el.classList.remove('is-note');
  }, 3500);
}

function recSetSel(from, to) {
  from = Math.max(0, Math.min(Math.round(from), DAY_SEC - 1));
  to = Math.max(from + 1, Math.min(Math.round(to), DAY_SEC));
  rec.sel = { from, to };
  recRenderSel();
}

function recRenderAll() {
  const label = document.getElementById('rec-date-text');
  if (label) label.textContent = recDayLabel(recDate());
  const sub = document.getElementById('rp-sessions-sub');
  if (sub) sub.textContent = rec.cam ? `${rec.name} · ${recDayLabel(recDate())}` : '';
  recRenderBlocks();
  recRenderSel();
  recRenderPlayhead();
}

function recRenderBlocks() {
  const box = document.getElementById('rec-blocks');
  if (!box) return;
  box.innerHTML = rec.sessions.map(s => {
    const width = Math.max((s.to_sec - s.from_sec) / DAY_SEC * 100, 0.25);
    return `<div class="rec-block" style="left:${(s.from_sec / DAY_SEC * 100)}%;width:${width}%" title="${recClock(s.from_sec)} – ${recClock(s.to_sec)}"></div>`;
  }).join('');
}

function recRenderSel() {
  const selEl = document.getElementById('rec-sel');
  if (!selEl) return;
  const sel = rec.sel;
  const hasCam = !!window.selectedSource;

  const inEl = document.getElementById('rec-in');
  const outEl = document.getElementById('rec-out');
  inEl.disabled = outEl.disabled = !hasCam;

  selEl.hidden = !sel;
  const len = document.getElementById('rec-len');
  if (sel) {
    selEl.style.left = recPct(sel.from);
    selEl.style.width = ((sel.to - sel.from) / DAY_SEC * 100) + '%';
    if (document.activeElement !== inEl) inEl.value = recInputTime(sel.from);
    if (document.activeElement !== outEl) outEl.value = recInputTime(sel.to);
    const long = (sel.to - sel.from) > MAX_RANGE;
    len.textContent = recDuration(sel.to - sel.from) + (long ? ` · plays first ${recMaxLabel()}` : '');
    len.classList.toggle('is-warn', long);
  } else {
    inEl.value = outEl.value = '';
    len.textContent = 'No range';
    len.classList.remove('is-warn');
  }
  recUpdateButtons();
}

function recRenderPlayhead() {
  const ph = document.getElementById('rec-playhead');
  if (!ph) return;
  ph.hidden = rec.playAbs == null;
  if (rec.playAbs != null) ph.style.left = recPct(rec.playAbs);
}

function recUpdateButtons() {
  const ok = !!window.selectedSource && !!rec.sel && rec.sel.to > rec.sel.from;
  const live = rec.playAbs != null;
  const set = (id, off) => { const el = document.getElementById(id); if (el) el.disabled = off; };
  set('rec-play-range', !ok);
  set('rec-add', !ok);
  set('rec-in-use', !live);
  set('rec-out-use', !live);
}

function recOnTimeUpdate() {
  const p = window.player;
  const meta = p && p.trimMeta;
  if (!meta) return;
  const first = rec.playAbs == null;
  rec.playAbs = meta.fromSec + (p.currentTime() || 0);
  recRenderPlayhead();
  if (first) recUpdateButtons();
  recOsdSet(`<b>${escapeHtml(rec.name || meta.source)}</b><span>${recDayLabel(meta.date)} · ${secondsToAmPm(Math.floor(rec.playAbs) % DAY_SEC)}</span>`);
}

function recUsePlayer(which) {
  if (rec.playAbs == null) return;
  const t = Math.round(rec.playAbs);
  if (which === 'in') {
    recSetSel(t, rec.sel && rec.sel.to > t ? rec.sel.to : Math.min(DAY_SEC, t + 60));
  } else {
    recSetSel(rec.sel && rec.sel.from < t ? rec.sel.from : Math.max(0, t - 60), t);
  }
}

function recResetPlayer(message) {
  const p = window.player;
  if (!p) return;
  p.pause();
  p.reset();                     // avoids MEDIA_ERR_SRC_NOT_SUPPORTED on the next source
  p.trimMeta = null;
  rec.playAbs = null;
  recOsdSet('');
  const overlay = p.getChild('OverlayMessage');
  if (overlay && message) overlay.setMessage(message);
  recSetPoster();
}

/* ---------- Playing ---------- */
function recJumpTo(sec) {
  const p = window.player;
  const source = window.selectedSource;
  const date = recDate();
  if (!p || !source || !date) return;

  const meta = p.trimMeta;
  if (meta && meta.date === date && sec >= meta.fromSec && sec <= meta.toSec) {
    p.currentTime(sec - meta.fromSec);   // already loaded: just seek
    p.play();
    return;
  }
  if (!rec.sessions.some(s => sec >= s.from_sec && sec <= s.to_sec)) {
    recNote('Nothing was recorded at that time');
    return;
  }
  p.getChild('OverlayMessage').setMessage('Loading recordings...');
  loadAndPlaySlot(source, date, sec, Math.min(sec + MAX_RANGE, DAY_SEC), true);
}

function recPlayRange() {
  const source = window.selectedSource;
  const date = recDate();
  if (!source || !date || !rec.sel) {
    window.player.getChild('OverlayMessage').setMessage('Select camera and date to load recordings');
    return;
  }
  const fromSec = rec.sel.from;
  const toSec = Math.min(rec.sel.to, fromSec + MAX_RANGE);
  if (rec.sel.to > toSec) recNote(`Playing the first ${recMaxLabel()} of the range`);
  window.player.getChild('OverlayMessage').setMessage('Loading recordings...');
  loadAndPlaySlot(source, date, fromSec, toSec, true);
}

async function loadAndPlaySlot(source, date, fromSec, toSec, keepSel) {
  const overlay = window.player.getChild('OverlayMessage');

  try {
    const response = await fetch(`/api/recordings?source=${source}&date=${date}&from=${fromSec}&to=${toSec}&session_id=${window.SESSION_ID}`);
    const recordings = await response.json();

    if (!Array.isArray(recordings) || recordings.length === 0) {
      overlay.setMessage('No recordings found');
      return;
    }

    // Determine playlist URL based on transcode requirement
    let playlistUrl = recordings[0].playlist_url;
    if (recordings[0].transcode) {
      playlistUrl = `${recordings[0].playlist_url}?transcode=true`;
      overlay.setMessage(`Playing (transcoding) from ${recordings[0].from_time}`);
    } else {
      overlay.setMessage(`Playing recording from ${recordings[0].from_time}`);
    }

    window.player.src({ src: playlistUrl, type: 'application/x-mpegURL' });
    window.player.play();
    overlay.hideMessage();

    window.player.trimMeta = { source, date, fromSec, toSec };
    rec.playAbs = fromSec;
    recRenderPlayhead();
    recOnTimeUpdate();

    if (!keepSel) recSetSel(fromSec, toSec);
    else recUpdateButtons();
    highlightCurrentlyPlayingSlotOnGallery(fromSec, toSec);

  } catch (error) {
    overlay.setMessage(`Error: ${error.message}`);
    console.error('Recording load error:', error);
  }
}

/* ---------- Sessions list (right panel) ---------- */
function recSetSessionsBody(html, count) {
  const body = document.getElementById('rp-sessions-body');
  const cnt = document.getElementById('rp-sessions-count');
  if (body) body.innerHTML = html;
  if (cnt) cnt.textContent = count == null ? '' : String(count);
}

async function loadRecordingSlots() {
  const source = window.selectedSource;
  const date = recDate();
  const overlay = window.player.getChild('OverlayMessage');

  if (!source || !date) {
    overlay.setMessage('Please select camera and date first');
    recSetSessionsBody('<p class="rp-empty">Select a camera to see its sessions.</p>');
    return;
  }

  recSetSessionsBody('<p class="rp-empty">Loading...</p>');

  try {
    const response = await fetch(`/api/recording_slots?source=${source}&date=${date}&session_id=${window.SESSION_ID}`);
    const slots = await response.json();

    if (!Array.isArray(slots) || slots.length === 0) {
      rec.sessions = [];
      recRenderBlocks();
      overlay.setMessage(SESSION_LABEL.none);
      recSetSessionsBody(`<p class="rp-empty">${SESSION_LABEL.none}.</p>`, 0);
      return;
    }

    slots.sort((a, b) => (a.from_sec || 0) - (b.from_sec || 0));
    rec.sessions = slots;
    recRenderBlocks();
    overlay.setMessage(SESSION_LABEL.pick);
    buildRecordingSlotsGallery(slots);

  } catch (error) {
    overlay.setMessage(`Error loading recordings: ${error.message}`);
    console.error('Session load error:', error);
    recSetSessionsBody('<p class="rp-empty">Could not load recordings.</p>');
  }
}

function buildRecordingSlotsGallery(slots) {
  const html = slots.map((slot, i) => `
    <button type="button" class="thumbnail-card" data-i="${i}" onclick="playSlotCliked(this)">
      <span class="sess-sky" style="background:${recSky(slot.from_sec).bg}">${recSky(slot.from_sec).icon}</span>
      <span class="time-info">
        <span class="time-range">${recClock(slot.from_sec)} – ${recClock(slot.to_sec)}</span>
        <span class="sess-len">${recDuration(slot.to_sec - slot.from_sec)}</span>
      </span>
    </button>`).join('');

  recSetSessionsBody(`<div class="gallery">${html}</div>`, slots.length);

  // keep the highlight if something is already playing
  const meta = window.player && window.player.trimMeta;
  if (meta) highlightCurrentlyPlayingSlotOnGallery(meta.fromSec, meta.toSec);
}

function highlightCurrentlyPlayingSlotOnGallery(fromSec, toSec) {
  let first = null;
  document.querySelectorAll('.thumbnail-card').forEach(card => {
    const slot = rec.sessions[Number(card.dataset.i)];
    if (!slot) return;
    const overlaps = (slot.from_sec || 0) <= toSec && (slot.to_sec || 0) >= fromSec;
    card.classList.toggle('active', overlaps);
    if (overlaps && !first) first = card;
  });
  if (first) first.scrollIntoView({ block: 'nearest' });
}

function playSlotCliked(element) {
  const slot = rec.sessions[Number(element.dataset.i)];
  if (!slot) return;

  const source = slot.source || window.selectedSource;
  const date = slot.date || recDate();
  const overlay = window.player.getChild('OverlayMessage');

  if (!source || !date) {
    overlay.setMessage('No valid camera and date to load recordings');
    return;
  }

  overlay.setMessage('Loading recordings...');
  loadAndPlaySlot(source, date, Math.round(slot.from_sec), Math.round(slot.to_sec));
}

/*--------------------------Clips (trim queue)----------------------------*/
function recAddClip() {
  const source = window.selectedSource;
  const date = recDate();
  if (!source || !date || !rec.sel) return;

  if (rec.sel.to <= rec.sel.from) {
    recNote('Out must be after In');
    return;
  }

  trimClips.push({
    start_sec: rec.sel.from,
    stop_sec: rec.sel.to,
    source,
    name: rec.name,
    date
  });
  updateTrimListUI();
  recNote('Added to clips');
}

function updateTrimListUI() {
  const box = document.getElementById('rp-clips');
  if (!box) return;

  const total = trimClips.reduce((a, c) => a + (c.stop_sec - c.start_sec), 0);
  const count = trimClips.length
    ? `${trimClips.length} clip${trimClips.length > 1 ? 's' : ''} · ${recDuration(total)}`
    : '';

  box.innerHTML = `
    <div class="rp-head"><h3>Clips to download</h3><span class="rp-count">${count}</span></div>
    ${trimClips.length ? `
      <div class="trim-list">
        ${trimClips.map((clip, idx) => `
          <div class="trim-item">
            <div class="trim-info">
              <div class="trim-info__name">${escapeHtml(clip.name || clip.source)} <span class="muted">· ${clip.date}</span></div>
              <div class="trim-info__time">${secondsToAmPm(clip.start_sec % DAY_SEC)} – ${secondsToAmPm(clip.stop_sec % DAY_SEC)}</div>
            </div>
            <div class="trim-actions">
              <button class="download-trim btn btn--sm" data-idx="${idx}">
                <span class="btn-text">Download</span>
                <span class="btn-spinner"></span>
              </button>
              <button class="close-trim btn btn--sm" data-idx="${idx}" title="Remove this clip">×</button>
            </div>
          </div>`).join('')}
      </div>
      <div class="trim-actions-bottom">
        <button id="download-all-trims" class="btn btn--primary">Download all</button>
        <button id="clear-all-trims" class="btn">Clear</button>
      </div>` : `<p class="rp-empty">No clips yet. Set In and Out on the timeline, then choose Add to clips.</p>`}
  `;

  box.querySelectorAll('.download-trim').forEach(btn =>
    btn.addEventListener('click', e => downloadTrim(Number(e.currentTarget.dataset.idx))));
  box.querySelectorAll('.close-trim').forEach(btn =>
    btn.addEventListener('click', e => removeTrim(Number(e.currentTarget.dataset.idx))));
  const all = box.querySelector('#download-all-trims');
  if (all) all.addEventListener('click', downloadAllTrims);
  const clr = box.querySelector('#clear-all-trims');
  if (clr) clr.addEventListener('click', clearAllTrims);
}

function clearAllTrims() {
  if (trimClips.length === 0) return;
  if (!confirm('Are you sure you want to clear all clips?')) return;
  trimClips = [];
  updateTrimListUI();
}

function removeTrim(idx) {
  trimClips.splice(idx, 1);
  updateTrimListUI();
}

async function downloadTrim(idx) {
  const clip = trimClips[idx];
  if (!clip) return;

  const btn = document.querySelector(`.download-trim[data-idx="${idx}"]`);
  const textEl = btn?.querySelector('.btn-text');

  if (btn) {
    btn.disabled = true;
    btn.classList.add('loading');
    textEl.textContent = 'Preparing...';
  }

  try {
    const apiUrl =
      `/api/download_video?source=${clip.source}` +
      `&date=${clip.date}` +
      `&from=${clip.start_sec}` +
      `&to=${clip.stop_sec}` +
      `&session_id=${window.SESSION_ID}`;

    // backend encoding (this is where the delay happens)
    const res = await fetch(apiUrl);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');

    await downloadFile(data.download_url,
      `${clip.source}_${clip.date}_${clip.start_sec}-${clip.stop_sec}.mp4`
    );

    if (btn) {
      btn.classList.remove('loading');
      btn.classList.add('done');
      textEl.textContent = '✓ Completed';
    }

  } catch (err) {
    console.error(err);
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('loading');
      textEl.textContent = 'Download';
    }
    alert('Download failed');
  }
}

function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';

    xhr.onload = () => {
      if (xhr.status === 200) {
        const blobUrl = URL.createObjectURL(xhr.response);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(blobUrl);
        resolve();
      } else {
        reject();
      }
    };

    xhr.onerror = reject;
    xhr.send();
  });
}

async function downloadAllTrims() {
  if (trimClips.length === 0) return;
  for (const [i] of trimClips.entries()) {
    await downloadTrim(i); // sequential (keeps FFmpeg load controlled)
  }
}

/*---------------------Camera rail (left panel)------------------ */
async function loadChannelList() {
  try {
    const res = await fetch('/api/cameras');
    const cameras = await res.json();

    const channelListEl = document.getElementById('channel_list');
    channelListEl.innerHTML = '';

    cameras.forEach((s, i) => {
      const recording = typeof camStatus === 'function' && camStatus(s).key === 'rec';
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="channel-item" data-source="${escapeHtml(s.record_folder_name)}">
          <span class="ch-thumb" style="background:${recGrad(i)}">
            <img class="ch-snap" alt="" data-cam="${s.id}" hidden>
            ${recording ? '<i class="ch-rec" title="Recording now"></i>' : ''}
          </span>
          <span class="ch-name">${escapeHtml(s.name)}</span>
        </div>
      `;
      li.dataset.source = s.record_folder_name;
      li.title = s.name;

      li.addEventListener('click', () => selectChannel(li, s));
      channelListEl.appendChild(li);
    });

    recLoadRailSnapshots(cameras);
  } catch (err) {
    console.error('Failed to load channels:', err);
  }
}

// Camera thumbnails: one live picture per camera from go2rtc (the same source the Cameras page uses)
function recApplySnap(id, url) {
  document.querySelectorAll(`.ch-snap[data-cam="${id}"]`).forEach(img => {
    img.onerror = () => { img.hidden = true; };
    img.src = url;
    img.hidden = false;
  });
  const im = new Image();
  im.onload = () => {
    rec.snaps[id] = { url, w: im.naturalWidth, h: im.naturalHeight };
    if (rec.cam && rec.cam.id === id) recSetPoster();
  };
  im.src = url;
}

async function recLoadRailSnapshots(cameras) {
  const cfg = await getLiveConfig(true);
  if (!cfg.available) return;

  cameras.forEach(async cam => {
    const name = 'cam_' + cam.id;
    // show the picture the Home page already has straight away, then refresh it
    if (typeof snapCache !== 'undefined' && snapCache[name]) recApplySnap(cam.id, snapCache[name]);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const r = await fetch(`${cfg.base}/api/frame.jpeg?src=${encodeURIComponent(name)}`, { signal: ctrl.signal });
      const blob = r.ok ? await r.blob() : null;
      if (!blob || !blob.type.startsWith('image/') || blob.size < 200) return;
      recApplySnap(cam.id, URL.createObjectURL(blob));
    } catch (e) {
      /* camera not reachable: keep the colour tile */
    } finally {
      clearTimeout(timer);
    }
  });
}

function selectChannel(liElement, cameraObj) {
  rec.cam = cameraObj;
  rec.name = cameraObj.name;
  if (window.player) recResetPlayer('Loading ' + SESSION_LABEL.title.toLowerCase() + '...');

  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
  const channelItem = liElement.querySelector('.channel-item');
  if (channelItem) channelItem.classList.add('active');

  window.selectedSource = cameraObj.record_folder_name;
  rec.sel = null;
  rec.playAbs = null;
  rec.sessions = [];
  recRenderAll();

  loadRecordingSlots();
}

// Show the rail, with a back button on top
function showChannelSidebar() {
  const channelSidebar = document.getElementById('channel_sidebar');
  if (!channelSidebar) return;
  channelSidebar.classList.add('visible');

  if (!channelSidebar.querySelector('.rail-back')) {
    channelSidebar.insertAdjacentHTML('afterbegin', `
      <button type="button" class="rail-back" onclick="goTo('cameras')" aria-label="Back to Cameras" title="Back to Cameras">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
      </button>
      <div class="rail-sep"></div>`);
  }
}

function intCahnnelSideBar() {
  showChannelSidebar();
  loadChannelList();
}

// Search: filter cameras as the user types (the search box is hidden in the rail but still works)
document.getElementById('channelSearchInput')?.addEventListener('input', e => {
  const term = e.target.value.toLowerCase().trim();
  document.querySelectorAll('#channel_list li').forEach(li => {
    li.style.display = li.textContent.toLowerCase().includes(term) ? '' : 'none';
  });
});

/*--------------------------Keyboard----------------------------*/
// Arrow keys / space / F work even when the player doesn't have focus. I and O mark In / Out.
document.addEventListener('keydown', function (e) {
  if (typeof currentPage !== 'undefined' && currentPage !== 'download') return;

  const player = window.player;
  if (!player || !player.el()) return;

  const tag = document.activeElement?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.which === 37) {
    e.preventDefault();
    player.currentTime(Math.max(0, player.currentTime() - window.skip_duration));
  } else if (e.which === 39) {
    e.preventDefault();
    player.currentTime(Math.min(player.duration() || Infinity, player.currentTime() + window.skip_duration));
  } else if (e.which === 32 || e.which === 75) {
    e.preventDefault();
    player.paused() ? player.play() : player.pause();
  } else if (e.which === 70) {
    e.preventDefault();
    player.isFullscreen() ? player.exitFullscreen() : player.requestFullscreen();
  } else if (e.which === 73) {           // I
    recUsePlayer('in');
  } else if (e.which === 79) {           // O
    recUsePlayer('out');
  }
});
