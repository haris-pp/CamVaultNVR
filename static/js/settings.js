/*--------------------------Settings section---------------------------
  Left: section list (follows the scroll). Right: one card per section, each setting is a row
  of label + description + control. Changes are collected and saved together from the bar at
  the bottom (Save / Discard). The backend is /api/settings (see settings_api.py).
-----------------------------------------------------------------------*/

const SET_SECTIONS = [
  { id: 'storage',   name: 'Storage',   icon: '◼' },
  { id: 'recording', name: 'Recording', icon: '●' },
  { id: 'playback',  name: 'Playback',  icon: '▶' },
  { id: 'downloads', name: 'Downloads', icon: '↓' },
  { id: 'live',      name: 'Live view', icon: '◉' },
  { id: 'system',    name: 'System',    icon: 'i' }
];

// Same limits as the server (settings_api.py). The server checks again on save.
const SET_NUMBER_RULES = {
  chunk_duration:        [1, 300],
  skip_duration:         [1, 300],
  download_keep_minutes: [5, 1440],
  wall_refresh_seconds:  [5, 300]
};
const SET_KEYS = [
  'recording_folder', 'auto_clean_enabled', 'disk_limit_percent', 'cleanup_times',
  'chunk_duration', 'skip_duration', 'default_speed', 'max_play_range', 'time_format',
  'download_keep_minutes', 'wall_refresh_seconds'
];
const SET_RESTART_NOTE = ['recording_folder', 'chunk_duration'];   // only used by recordings that start after saving

let setState = null;

const setClone = v => JSON.parse(JSON.stringify(v));
const setSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const setEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Formatting ---------- */
function setFmtClock(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (setState && setState.vals.time_format === '24h') return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function setFmtSize(bytes) {
  const n = Number(bytes) || 0;
  const TB = 1024 ** 4, GB = 1024 ** 3, MB = 1024 ** 2;
  if (n >= TB) return (n / TB).toFixed(2).replace(/\.?0+$/, '') + ' TB';
  if (n >= GB) return (n / GB >= 100 ? Math.round(n / GB) : (n / GB).toFixed(1).replace(/\.0$/, '')) + ' GB';
  return Math.max(0, Math.round(n / MB)) + ' MB';
}

function setFmtUptime(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${Math.max(1, m)} min`;
}

function setFmtDay(str) {
  const [y, m, d] = String(str).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/* ---------- Page ---------- */
async function loadSettings() {
  hideChannelSidebar();
  const container = document.getElementById('content');
  container.innerHTML = `<div class="page-head"><div><div class="eyebrow">Preferences</div><h1>Settings</h1></div></div>
    <p class="muted">Loading…</p>`;

  let data;
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (e) {
    container.innerHTML = `<div class="page-head"><div><div class="eyebrow">Preferences</div><h1>Settings</h1></div></div>
      <section class="card"><p>Could not load the settings.</p>
      <p style="margin-top:14px"><button class="btn btn--primary" onclick="loadSettings()">Try again</button></p></section>`;
    return;
  }

  setState = {
    saved: data, vals: setClone(data), errors: {},
    storage: null, system: null,
    addingTime: false, folderNote: null, flash: null, flashTimer: null,
    storageTries: 0, saving: false,
    apply: null, applyHidden: false, applyBusy: false
  };

  container.innerHTML = setPageHtml();
  setWire();
  setSync();
  setLoadStorage();
  setLoadSystem();
  setLoadRecStatus();
}

function setRow(key, label, desc, control, opts = {}) {
  const lbl = opts.forId
    ? `<label class="set-lbl" id="lbl-${key}" for="${opts.forId}">${label}</label>`
    : `<div class="set-lbl" id="lbl-${key}">${label}</div>`;
  return `<div class="set-row" data-row="${key}">
    <div class="set-row__txt">
      ${lbl}
      ${desc ? `<div class="set-desc">${desc}</div>` : ''}
      ${opts.below || ''}
      <div class="set-err" data-err="${key}" role="alert"></div>
    </div>
    <div class="set-ctl"${opts.ctlWidth ? ` style="width:${opts.ctlWidth}px"` : ''}>${control}</div>
  </div>`;
}

const setNumber = (key, unit) =>
  `<input class="set-input set-input--num" type="number" inputmode="numeric" id="set-${key}" data-key="${key}" data-kind="number" aria-labelledby="lbl-${key}"><span class="set-unit">${unit}</span>`;

const setSeg = (key, options) =>
  `<div class="set-seg" role="radiogroup" aria-labelledby="lbl-${key}">${options.map(([v, t]) =>
    `<button type="button" role="radio" data-seg="${key}" data-val="${v}">${t}</button>`).join('')}</div>`;

function setCard(id, title, subtitle, body) {
  return `<section class="set-card" id="set-${id}" data-section="${id}" aria-labelledby="set-h-${id}">
    <div class="set-card__head"><h2 id="set-h-${id}">${title}</h2><p>${subtitle}</p></div>${body}
  </section>`;
}

function setPageHtml() {
  const nav = SET_SECTIONS.map((s, i) =>
    `<a href="#set-${s.id}" data-nav="${s.id}"${i === 0 ? ' class="on" aria-current="true"' : ''}><i>${s.icon}</i>${s.name}</a>`).join('');

  const storage = `
    <div class="set-disk">
      <div class="set-disk__top">
        <span class="set-disk__title">Recording disk</span>
        <span class="set-disk__nums" id="diskNums">Checking…</span>
      </div>
      <div class="set-meter" id="diskMeter" role="img" aria-label="Disk usage">
        <i class="set-meter__rec" id="meterRec"></i><i class="set-meter__other" id="meterOther"></i>
        <b class="set-meter__limit" id="meterLimit"></b>
      </div>
      <div class="set-legend" id="diskLegend"></div>
      <div class="set-diskwarn" id="diskWarn" hidden></div>
    </div>
    ${setRow('recording_folder', 'Recording folder',
      'Full path where recordings are saved. The server needs write access. Changing it does not move existing recordings.',
      `<input class="set-input set-input--wide" id="set-recording_folder" data-key="recording_folder" data-kind="text" aria-labelledby="lbl-recording_folder" placeholder="e.g. /mnt/recordings or F:/recordings" spellcheck="false" autocomplete="off">
       <button type="button" class="btn" data-action="browse-folder" id="browseFolderBtn">Browse…</button>
       <button type="button" class="btn" data-action="check-folder" id="checkFolderBtn">Check</button>`,
      { below: '<div class="set-note" id="folderNote" hidden></div>' })}
    ${setRow('auto_clean_enabled', 'Delete the oldest days when the disk is full',
      'Oldest day folders are removed first, across all cameras, until usage is back under the limit.',
      `<button type="button" class="set-toggle" role="switch" data-toggle="auto_clean_enabled" aria-labelledby="lbl-auto_clean_enabled"></button>`)}
    ${setRow('disk_limit_percent', 'Disk limit',
      'Start deleting when disk usage goes above this.',
      `<input class="set-range" type="range" min="50" max="95" step="1" id="set-disk_limit_percent" data-key="disk_limit_percent" data-kind="range" aria-labelledby="lbl-disk_limit_percent">
       <span class="set-chip set-chip--val" id="limitVal">85%</span>`, { ctlWidth: 300 })}
    ${setRow('cleanup_times', 'Clean-up runs at',
      'The disk is checked at these times every day.',
      `<div class="set-chips" id="timeChips"></div>`)}`;

  const recording = setRow('chunk_duration', 'Segment length',
    'Length of each video file. Shorter segments seek faster but make more files. A new length applies to recordings that start after you save.',
    setNumber('chunk_duration', 'seconds'), { forId: 'set-chunk_duration' });

  const playback = `
    ${setRow('skip_duration', 'Skip forward / back', 'How far the arrow keys and skip buttons jump.',
      setNumber('skip_duration', 'seconds'), { forId: 'set-skip_duration' })}
    ${setRow('default_speed', 'Default speed', 'The speed every recording starts at.',
      setSeg('default_speed', [[0.5, '0.5×'], [1, '1×'], [1.5, '1.5×'], [2, '2×']]))}
    ${setRow('max_play_range', 'Longest range to play at once',
      'Longer ranges load more footage and take longer to start.',
      setSeg('max_play_range', [[3600, '1 h'], [7200, '2 h'], [14400, '4 h']]))}
    ${setRow('time_format', 'Time format', 'How times are shown on the Download page and in the clean-up times.',
      setSeg('time_format', [['12h', '12-hour'], ['24h', '24-hour']]))}`;

  const downloads = setRow('download_keep_minutes', 'Keep prepared clips for',
    'Trimmed clips are deleted after this long, so download them before then.',
    setNumber('download_keep_minutes', 'minutes'), { forId: 'set-download_keep_minutes' });

  const live = `
    <div class="set-row">
      <div class="set-row__txt"><div class="set-lbl">Live view server</div><div class="set-desc">go2rtc, started together with CamVault.</div></div>
      <div class="set-ctl"><span class="set-status" id="liveStatus"><i></i>Checking…</span></div>
    </div>
    ${setRow('wall_refresh_seconds', 'Refresh camera wall every',
      'How often the Home page updates its camera pictures and numbers.',
      setNumber('wall_refresh_seconds', 'seconds'), { forId: 'set-wall_refresh_seconds' })}`;

  const system = `<div class="set-about" id="setAbout"><p class="muted">Loading…</p></div>`;

  return `
    <div class="page-head"><div><div class="eyebrow">Preferences</div><h1>Settings</h1></div></div>
    <div class="set-layout" id="setPage">
      <nav class="set-nav" id="setNav" aria-label="Settings sections">${nav}</nav>
      <div class="set-main">
        ${setCard('storage', 'Storage', 'Where recordings go and how CamVault keeps the disk from filling up.', storage)}
        ${setCard('recording', 'Recording', 'How footage is written to disk.', recording)}
        ${setCard('playback', 'Playback', 'How the video player behaves.', playback)}
        ${setCard('downloads', 'Downloads', 'Clips you trim on the Download page.', downloads)}
        ${setCard('live', 'Live view', 'Camera pictures on Home and the live window.', live)}
        ${setCard('system', 'System', 'For support and bug reports.', system)}
        <div class="set-bar" id="setBar" hidden>
          <span class="set-bar__msg" id="setBarMsg" role="status" aria-live="polite"></span>
          <span class="set-bar__space"></span>
          <button type="button" class="btn" data-action="discard" id="discardBtn">Discard</button>
          <button type="button" class="btn btn--primary" data-action="save" id="saveBtn">Save settings</button>
          <button type="button" class="btn" data-action="apply-later" id="applyLaterBtn" hidden>Not now</button>
          <button type="button" class="btn btn--primary" data-action="apply-now" id="applyNowBtn" hidden>Switch now</button>
        </div>
      </div>
    </div>
    <dialog id="folderDialog" class="set-dialog" aria-labelledby="pickTitle"><div id="pickBody"></div></dialog>`;
}

/* ---------- Events ---------- */
function setWire() {
  const page = document.getElementById('setPage');

  page.addEventListener('input', e => {
    const el = e.target.closest('[data-key]');
    if (!el) return;
    const key = el.dataset.key, kind = el.dataset.kind;
    if (kind === 'text') setState.vals[key] = el.value;
    else if (kind === 'range') setState.vals[key] = Number(el.value);
    else setState.vals[key] = el.value === '' ? '' : Number(el.value);
    if (key === 'recording_folder') setState.folderNote = null;
    setSync(key);
  });

  page.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('.set-input[data-key]')) {
      e.preventDefault();
      if (setDirtyKeys().length && !Object.keys(setState.errors).length) saveSettings();
    }
    if (e.target.id === 'setNewTime') {
      if (e.key === 'Enter') { e.preventDefault(); setAddTime(); }
      if (e.key === 'Escape') { setState.addingTime = false; setSync(); }
    }
  });

  page.addEventListener('click', e => {
    const seg = e.target.closest('[data-seg]');
    if (seg) {
      const key = seg.dataset.seg;
      setState.vals[key] = typeof setState.saved[key] === 'number' ? Number(seg.dataset.val) : seg.dataset.val;
      return setSync(key);
    }
    const tog = e.target.closest('[data-toggle]');
    if (tog) {
      const key = tog.dataset.toggle;
      setState.vals[key] = !setState.vals[key];
      return setSync(key);
    }
    const del = e.target.closest('[data-del-time]');
    if (del) {
      setState.vals.cleanup_times = setState.vals.cleanup_times.filter(t => t !== del.dataset.delTime);
      return setSync('cleanup_times');
    }
    const act = e.target.closest('[data-action]');
    if (!act) return;
    switch (act.dataset.action) {
      case 'add-time':    setState.addingTime = true; setSync(); { const i = document.getElementById('setNewTime'); if (i) i.focus(); } break;
      case 'cancel-time': setState.addingTime = false; setSync(); break;
      case 'confirm-time': setAddTime(); break;
      case 'check-folder': setCheckFolder(); break;
      case 'browse-folder': setOpenPicker(); break;
      case 'discard':     discardSettings(); break;
      case 'save':        saveSettings(); break;
      case 'apply-later': setState.applyHidden = true; setRenderBar(); break;
      case 'apply-now':   setApplyNow(); break;
    }
  });

  // Section list: jump on click, follow the scroll
  document.getElementById('setNav').addEventListener('click', e => {
    const a = e.target.closest('[data-nav]');
    if (!a) return;
    e.preventDefault();
    const target = document.getElementById('set-' + a.dataset.nav);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setMarkNav(a.dataset.nav);
  });

  setWirePicker();

  const scroller = document.querySelector('.main');
  if (setState.onScroll && setState.scroller) setState.scroller.removeEventListener('scroll', setState.onScroll);
  let ticking = false;
  setState.scroller = scroller;
  setState.onScroll = () => {
    if (!document.getElementById('setNav')) {            // left the page
      scroller.removeEventListener('scroll', setState.onScroll);
      return;
    }
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { ticking = false; setSpy(scroller); });
  };
  scroller.addEventListener('scroll', setState.onScroll, { passive: true });

  window.onbeforeunload = () => (document.getElementById('setPage') && setDirtyKeys().length ? true : undefined);
}

function setSpy(scroller) {
  const top = scroller.getBoundingClientRect().top + 90;
  let current = SET_SECTIONS[0].id;
  for (const s of SET_SECTIONS) {
    const el = document.getElementById('set-' + s.id);
    if (el && el.getBoundingClientRect().top <= top) current = s.id;
  }
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) current = SET_SECTIONS[SET_SECTIONS.length - 1].id;
  setMarkNav(current);
}

function setMarkNav(id) {
  document.querySelectorAll('#setNav a').forEach(a => {
    const on = a.dataset.nav === id;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
  });
}

/* ---------- State -> screen ---------- */
function setDirtyKeys() {
  return SET_KEYS.filter(k => !setSame(setState.vals[k], setState.saved[k]));
}

function setValidate() {
  const v = setState.vals, err = {};
  for (const [key, [lo, hi]] of Object.entries(SET_NUMBER_RULES)) {
    const n = v[key];
    if (n === '' || !Number.isInteger(n) || n < lo || n > hi) err[key] = `Enter a whole number between ${lo} and ${hi}`;
  }
  if (!String(v.recording_folder || '').trim()) err.recording_folder = 'Enter a folder path';
  if (v.auto_clean_enabled && !v.cleanup_times.length) err.cleanup_times = 'Add at least one time, or turn automatic clean-up off';
  return Object.assign(err, setState.serverErrors || {});
}

function setSync(changedKey) {
  const v = setState.vals;

  // A server error belongs to the value that was sent; editing the field clears it
  if (changedKey && setState.serverErrors) delete setState.serverErrors[changedKey];
  if (changedKey && setState.flash && setState.flash.kind === 'bad') setState.flash = null;
  setState.errors = setValidate();

  // Controls
  document.querySelectorAll('[data-key]').forEach(el => {
    const val = v[el.dataset.key];
    if (document.activeElement !== el && String(el.value) !== String(val)) el.value = val;
    if (el.dataset.kind === 'range') {
      el.style.setProperty('--pct', ((val - el.min) / (el.max - el.min) * 100) + '%');
    }
  });
  document.querySelectorAll('[data-seg]').forEach(b => {
    const on = String(v[b.dataset.seg]) === String(b.dataset.val);
    b.setAttribute('aria-checked', on);
    b.classList.toggle('on', on);
  });
  document.querySelectorAll('[data-toggle]').forEach(b => b.setAttribute('aria-checked', !!v[b.dataset.toggle]));
  const limitVal = document.getElementById('limitVal');
  if (limitVal) limitVal.textContent = v.disk_limit_percent + '%';

  // Clean-up is off: the limit and the times do not matter
  ['disk_limit_percent', 'cleanup_times'].forEach(k => {
    const row = document.querySelector(`[data-row="${k}"]`);
    if (row) row.classList.toggle('is-off', !v.auto_clean_enabled);
    document.querySelectorAll(`[data-row="${k}"] input, [data-row="${k}"] button`).forEach(c => { c.disabled = !v.auto_clean_enabled; });
  });

  setRenderChips();

  // Unsaved rows and messages
  SET_KEYS.forEach(k => {
    const row = document.querySelector(`[data-row="${k}"]`);
    if (row) row.classList.toggle('is-dirty', !setSame(v[k], setState.saved[k]));
    const box = document.querySelector(`[data-err="${k}"]`);
    if (box) {
      box.textContent = setState.errors[k] || '';
      row && row.classList.toggle('has-error', !!setState.errors[k]);
    }
  });

  const note = document.getElementById('folderNote');
  if (note) {
    note.hidden = !setState.folderNote;
    if (setState.folderNote) {
      note.className = 'set-note ' + (setState.folderNote.ok ? 'ok' : 'bad');
      note.innerHTML = setEsc(setState.folderNote.message) +
        (setState.folderNote.path ? `<span class="set-note__path">${setEsc(setState.folderNote.path)}</span>` : '');
    }
  }

  setRenderMeter();
  setRenderBar();
}

function setRenderChips() {
  const box = document.getElementById('timeChips');
  if (!box) return;
  const times = setState.vals.cleanup_times;
  const chips = times.map(t =>
    `<span class="set-chip">${setFmtClock(t)}<button type="button" class="set-chip__x" data-del-time="${t}" aria-label="Remove ${setFmtClock(t)}">×</button></span>`).join('');
  let add;
  if (setState.addingTime) {
    add = `<input type="time" class="set-input set-input--time" id="setNewTime" value="06:00" aria-label="New clean-up time">
           <button type="button" class="btn btn--sm btn--primary" data-action="confirm-time">Add</button>
           <button type="button" class="btn btn--sm" data-action="cancel-time">Cancel</button>`;
  } else {
    add = times.length < 6 ? `<button type="button" class="btn btn--sm" data-action="add-time">+ Add time</button>` : '';
  }
  const html = chips + add;
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  if (!setState.vals.auto_clean_enabled) box.querySelectorAll('button,input').forEach(c => { c.disabled = true; });
}

function setAddTime() {
  const input = document.getElementById('setNewTime');
  const t = input && input.value;
  if (!/^\d{2}:\d{2}$/.test(t || '')) return;
  const times = setState.vals.cleanup_times;
  if (!times.includes(t)) times.push(t);
  times.sort();
  setState.addingTime = false;
  setSync('cleanup_times');
}

function setRenderBar() {
  const bar = document.getElementById('setBar');
  if (!bar) return;
  const dirty = setDirtyKeys();
  const hasErr = Object.keys(setState.errors).length > 0;
  const flash = setState.flash;
  // Priority: unsaved changes, then the message after a save, then the "switch cameras now" notice
  const apply = !dirty.length && !flash && setState.apply && !setState.applyHidden;
  bar.hidden = !(dirty.length || flash || apply);
  bar.classList.toggle('is-flash', !dirty.length && !!flash);
  bar.classList.toggle('is-error', !!(flash && flash.kind === 'bad') || (dirty.length && hasErr));

  const msg = document.getElementById('setBarMsg');
  if (dirty.length) {
    msg.innerHTML = hasErr
      ? `<i class="set-dot set-dot--bad"></i>Fix the highlighted settings to save`
      : `<i class="set-dot"></i>${dirty.length} unsaved change${dirty.length === 1 ? '' : 's'}`;
    if (flash && flash.kind === 'bad') msg.innerHTML = `<i class="set-dot set-dot--bad"></i>${setEsc(flash.text)}`;
  } else if (flash) {
    msg.innerHTML = `<i class="set-dot set-dot--${flash.kind === 'bad' ? 'bad' : 'ok'}"></i>${setEsc(flash.text)}`;
  } else if (apply) {
    msg.innerHTML = `<i class="set-dot"></i><span>${setEsc(setApplyText())}<small>Each camera stops recording for a few seconds while it restarts.</small></span>`;
  }
  document.getElementById('discardBtn').hidden = !dirty.length;
  document.getElementById('saveBtn').hidden = !dirty.length;
  document.getElementById('saveBtn').disabled = hasErr || setState.saving;
  document.getElementById('saveBtn').textContent = setState.saving ? 'Saving…' : 'Save settings';
  document.getElementById('applyLaterBtn').hidden = !apply;
  document.getElementById('applyLaterBtn').disabled = setState.applyBusy;
  document.getElementById('applyNowBtn').hidden = !apply;
  document.getElementById('applyNowBtn').disabled = setState.applyBusy;
  document.getElementById('applyNowBtn').textContent = setState.applyBusy ? 'Restarting…' : 'Switch now';
}

/* ---------- Cameras that are recording with the old folder / segment length ---------- */
function setApplyText() {
  const list = setState.apply;
  const folder = list.some(c => c.folder_changed), length = list.some(c => c.length_changed);
  const who = list.length <= 3 ? list.map(c => c.name).join(', ') : `${list.length} cameras`;
  const what = folder && length ? 'using the old folder and segment length'
    : folder ? 'recording to the old folder' : 'using the old segment length';
  return `${who} ${list.length === 1 ? 'is' : 'are'} still ${what}`;
}

async function setLoadRecStatus() {
  try {
    const res = await fetch('/api/settings/recording_status');
    const out = await res.json();
    setState.apply = res.ok && out.outdated && out.outdated.length ? out.outdated : null;
  } catch (e) {
    setState.apply = null;
  }
  setRenderBar();
}

async function setApplyNow() {
  if (setState.applyBusy || !setState.apply) return;
  const folderChanged = setState.apply.some(c => c.folder_changed);
  setState.applyBusy = true;
  setRenderBar();
  let out = null;
  try {
    const res = await fetch('/api/settings/apply_recording', { method: 'POST' });
    out = await res.json();
  } catch (e) { /* handled below */ }
  setState.applyBusy = false;
  await setLoadRecStatus();

  if (!out) return setFlash('Could not reach the server.', 'bad', 6000);
  if (out.failed.length) {
    return setFlash(`Could not restart ${out.failed.join(', ')}. CamVault keeps trying on its own.`, 'bad', 9000);
  }
  const n = out.restarted.length;
  setFlash(n
    ? `${n} camera${n === 1 ? '' : 's'} restarted${folderChanged ? ' in the new folder. Earlier footage stays in the old folder.' : ' with the new segment length.'}`
    : 'Nothing needed restarting.', 'ok', 8000);
}

function setFlash(text, kind, ms) {
  clearTimeout(setState.flashTimer);
  setState.flash = { text, kind: kind || 'ok' };
  setRenderBar();
  if (ms) setState.flashTimer = setTimeout(() => {
    if (!setState) return;
    setState.flash = null;
    setRenderBar();
  }, ms);
}

/* ---------- Save / discard ---------- */
function discardSettings() {
  setState.vals = setClone(setState.saved);
  setState.serverErrors = {};
  setState.addingTime = false;
  setState.folderNote = null;
  setState.flash = null;
  setSync();
}

async function saveSettings() {
  const dirty = setDirtyKeys();
  if (!dirty.length || setState.saving) return;
  setState.errors = setValidate();
  if (Object.keys(setState.errors).length) return setSync();

  const body = {};
  dirty.forEach(k => { body[k] = setState.vals[k]; });
  setState.saving = true;
  setRenderBar();

  try {
    const res = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      setState.serverErrors = out.errors || (out.field ? { [out.field]: out.error } : {});
      setState.saving = false;
      setSync();
      setFlash(out.error || 'Could not save the settings', 'bad', 0);
      const first = document.querySelector('.set-row.has-error');
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    setState.saved = out.settings;
    setState.vals = setClone(out.settings);
    setState.serverErrors = {};
    setState.saving = false;

    // Other pages read these
    window.appSettings = Object.assign(window.appSettings || {}, out.settings);
    if (typeof restartDashboardRefresh === 'function') restartDashboardRefresh();

    const later = dirty.some(k => SET_RESTART_NOTE.includes(k));
    setSync();
    setState.storageTries = 0;
    setLoadStorage();
    setState.applyHidden = false;
    if (later) {
      // Cameras that are recording right now keep the old folder until they restart. Ask about them.
      await setLoadRecStatus();
      if (setState.apply) setFlash('Settings saved', 'ok', 2500);
      else setFlash('Saved. The folder and segment length apply to recordings that start from now on.', 'ok', 6000);
    } else {
      setFlash('Settings saved', 'ok', 2500);
    }
  } catch (e) {
    setState.saving = false;
    setSync();
    setFlash('Could not reach the server. Nothing was saved.', 'bad', 0);
  }
}

/* ---------- Folder check ---------- */
async function setCheckFolder() {
  const btn = document.getElementById('checkFolderBtn');
  const path = setState.vals.recording_folder;
  btn.disabled = true;
  setState.folderNote = { ok: true, message: 'Checking…' };
  setSync();
  try {
    const res = await fetch('/api/settings/check_folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path })
    });
    const out = await res.json();
    setState.folderNote = { ok: !!out.ok, message: out.message || '', path: out.path || '' };
  } catch (e) {
    setState.folderNote = { ok: false, message: 'Could not reach the server.' };
  }
  btn.disabled = false;
  setSync();
}

/* ---------- Folder picker ----------
   A web page cannot read real disk paths from the browser, so the folders are listed by the
   server (GET /api/settings/browse). It shows the drives of the computer CamVault runs on. */
const PICK_ICON_DIR = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>';
const PICK_ICON_DRIVE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="10" rx="2.5"/><path d="M7 12h.01M11 12h6" stroke-linecap="round"/></svg>';
const PICK_ICON_GO = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

let setPick = null;

function setWirePicker() {
  const dlg = document.getElementById('folderDialog');

  dlg.addEventListener('click', e => {
    if (e.target === dlg) return dlg.close();                   // click on the dim background
    const go = e.target.closest('[data-go]');
    if (go) return setPickerGo(go.dataset.go);
    const btn = e.target.closest('[data-pick]');
    if (!btn) return;
    switch (btn.dataset.pick) {
      case 'close':  dlg.close(); break;
      case 'up':     if (setPick.parent) setPickerGo(setPick.parent); break;
      case 'go':     setPickerGo(document.getElementById('pickPath').value.trim()); break;
      case 'new':    setPick.creating = true; setPickerRender(); { const i = document.getElementById('pickNewName'); if (i) i.focus(); } break;
      case 'new-cancel': setPick.creating = false; setPickerRender(); break;
      case 'new-make': setPickerMake(); break;
      case 'use':    setPickerUse(); break;
    }
  });

  dlg.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'pickPath') { e.preventDefault(); setPickerGo(e.target.value.trim()); }
    if (e.target.id === 'pickNewName') { e.preventDefault(); setPickerMake(); }
  });
}

function setOpenPicker() {
  const dlg = document.getElementById('folderDialog');
  setPick = { path: '', parent: null, folders: [], truncated: false, writable: true, drives: [], places: [],
              error: '', creating: false, loading: true, ticket: 0 };
  setPickerRender();
  dlg.showModal();
  setPickerGo(setState.vals.recording_folder, { nearest: true, drives: true });
}

async function setPickerGo(path, opts = {}) {
  const ticket = ++setPick.ticket;
  const q = new URLSearchParams({ path: path || '' });
  if (opts.nearest) q.set('nearest', '1');
  if (opts.drives || !setPick.drives.length) q.set('drives', '1');
  let out, ok = false;
  try {
    const res = await fetch('/api/settings/browse?' + q);
    out = await res.json();
    ok = res.ok;
  } catch (e) {
    out = { error: 'Could not reach the server.' };
  }
  if (ticket !== setPick.ticket) return;                         // a newer click is already on its way
  setPick.loading = false;
  if (!ok) return setPickerError(out.error || 'Could not open that folder');

  Object.assign(setPick, { path: out.path, parent: out.parent, folders: out.folders, truncated: out.truncated,
                           writable: out.writable, error: out.error || '', creating: false });
  if (out.drives) { setPick.drives = out.drives; setPick.places = out.places || []; }
  setPickerRender();
  const list = document.getElementById('pickList');
  if (list) list.scrollTop = 0;
}

function setPickerError(msg) {
  setPick.error = msg;
  const box = document.getElementById('pickErr');
  if (box) box.textContent = msg;
  const use = document.getElementById('pickUse');
  if (use) use.disabled = !setPick.path || !!setPick.loading;
}

function setPickerRender() {
  const P = setPick;
  const here = P.path.toLowerCase();
  // The drive that holds the folder we are in (the longest matching start)
  const drive = P.drives.reduce((best, d) => {
    const m = d.path.toLowerCase();
    return here.startsWith(m) && (!best || m.length > best.path.length) ? d : best;
  }, null);

  const drives = P.drives.map(d => {
    const used = d.total ? Math.round((d.total - d.free) / d.total * 100) : 0;
    return `<button type="button" class="pick__drive${drive && drive.path === d.path ? ' on' : ''}" data-go="${setEsc(d.path)}">
      ${PICK_ICON_DRIVE}<span class="pick__dname">${setEsc(d.path)}
      <small>${setFmtSize(d.free)} free of ${setFmtSize(d.total)}</small>
      <span class="pick__dbar"><i style="width:${used}%"></i></span></span></button>`;
  }).join('');
  const places = P.places.map(pl =>
    `<button type="button" class="pick__place" data-go="${setEsc(pl.path)}">${PICK_ICON_DIR}<span>${setEsc(pl.label)}</span></button>`).join('');

  let list;
  if (P.loading) list = '<p class="pick__empty">Loading…</p>';
  else {
    const creating = P.creating
      ? `<div class="pick__new">${PICK_ICON_DIR}
           <input class="set-input" id="pickNewName" placeholder="New folder name" aria-label="New folder name" spellcheck="false" autocomplete="off">
           <button type="button" class="btn btn--sm btn--primary" data-pick="new-make">Create</button>
           <button type="button" class="btn btn--sm" data-pick="new-cancel">Cancel</button>
         </div>` : '';
    const rows = P.folders.map(f =>
      `<button type="button" class="pick__dir" data-go="${setEsc(f.path)}">${PICK_ICON_DIR}<span>${setEsc(f.name)}</span>${PICK_ICON_GO}</button>`).join('');
    list = creating + (rows || (P.creating ? '' : '<p class="pick__empty">No folders in here. You can use this folder, or make a new one.</p>')) +
      (P.truncated ? '<p class="pick__empty">Only the first 1000 folders are shown. Type a path above to go deeper.</p>' : '');
  }

  document.getElementById('pickBody').innerHTML = `
    <header class="pick__head">
      <h3 id="pickTitle">Choose recording folder</h3>
      <button type="button" class="pick__close" data-pick="close" aria-label="Close">×</button>
    </header>
    <div class="pick__bar">
      <button type="button" class="btn btn--sm" data-pick="up"${P.parent ? '' : ' disabled'} aria-label="Up one folder">↑ Up</button>
      <input class="set-input pick__path" id="pickPath" value="${setEsc(P.path)}" spellcheck="false" autocomplete="off" aria-label="Folder path" placeholder="Type a path and press Enter">
      <button type="button" class="btn btn--sm" data-pick="go">Go</button>
    </div>
    <div class="pick__cols">
      <aside class="pick__places" aria-label="Drives">
        ${drives ? '<div class="pick__h">Drives</div>' + drives : ''}
        ${places ? '<div class="pick__h">Places</div>' + places : ''}
      </aside>
      <div class="pick__list" id="pickList">${list}</div>
    </div>
    <div class="pick__err" id="pickErr" role="alert">${setEsc(P.error)}</div>
    <footer class="pick__foot">
      <button type="button" class="btn btn--sm" data-pick="new"${P.loading || P.creating ? ' disabled' : ''}>+ New folder</button>
      <span class="pick__sel" title="${setEsc(P.path)}">${P.path ? 'Selected: <b>' + setEsc(P.path) + '</b>' : ''}</span>
      <button type="button" class="btn" data-pick="close">Cancel</button>
      <button type="button" class="btn btn--primary" id="pickUse" data-pick="use"${!P.path || P.loading ? ' disabled' : ''}>Use this folder</button>
    </footer>`;
}

async function setPickerMake() {
  const input = document.getElementById('pickNewName');
  const name = input ? input.value.trim() : '';
  let out;
  try {
    const res = await fetch('/api/settings/make_folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: setPick.path, name })
    });
    out = await res.json();
  } catch (e) {
    out = { ok: false, message: 'Could not reach the server.' };
  }
  if (!out.ok) return setPickerError(out.message);
  setPickerGo(out.path);                                          // step into the new folder
}

async function setPickerUse() {
  const path = setPick.path;
  const use = document.getElementById('pickUse');
  use.disabled = true;
  let out;
  try {
    const res = await fetch('/api/settings/check_folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path })
    });
    out = await res.json();
  } catch (e) {
    out = { ok: false, message: 'Could not reach the server.' };
  }
  if (!out.ok) {
    use.disabled = false;
    return setPickerError(out.message || 'CamVault cannot write to this folder');
  }
  setState.vals.recording_folder = path;
  setState.folderNote = { ok: true, message: out.message, path: '' };
  document.getElementById('folderDialog').close();
  setSync('recording_folder');
  const input = document.getElementById('set-recording_folder');
  if (input) input.focus();
}

/* ---------- Disk meter ---------- */
async function setLoadStorage() {
  if (!document.getElementById('diskMeter')) return;
  try {
    const res = await fetch('/api/settings/storage');
    if (!res.ok) throw new Error();
    setState.storage = await res.json();
  } catch (e) {
    setState.storage = { error: true };
  }
  setRenderMeter();
  // The size of a big recordings folder is added up in the background: ask again until it is ready
  if (setState.storage.calculating && setState.storageTries++ < 30) setTimeout(setLoadStorage, 2000);
}

function setRenderMeter() {
  const s = setState && setState.storage;
  const nums = document.getElementById('diskNums');
  if (!nums) return;
  const limit = setState.vals.disk_limit_percent;
  const on = setState.vals.auto_clean_enabled;
  const mark = document.getElementById('meterLimit');
  mark.style.left = limit + '%';
  mark.style.display = on ? '' : 'none';

  const legend = document.getElementById('diskLegend');
  const limitLegend = on ? `<span><i class="set-key set-key--limit"></i>Auto-clean limit (${limit}%)</span>` : `<span class="muted">Auto-clean is off</span>`;

  if (!s) return;
  if (s.error) {
    nums.textContent = 'Could not read the disk';
    legend.innerHTML = limitLegend;
    return;
  }

  const recPct = s.recordings_bytes != null && s.total ? s.recordings_bytes / s.total * 100 : 0;
  const otherPct = Math.max(0, s.percent - recPct);
  document.getElementById('meterRec').style.width = recPct + '%';
  document.getElementById('meterOther').style.width = otherPct + '%';
  document.getElementById('diskMeter').classList.toggle('is-hot', on && s.percent >= limit);

  nums.innerHTML = `${setFmtSize(s.used)} used of ${setFmtSize(s.total)} · <b>${setFmtSize(s.free)} free</b>`;
  const recText = s.calculating ? 'Recordings (adding up…)' : `Recordings · ${setFmtSize(s.recordings_bytes)}`;
  legend.innerHTML =
    `<span><i class="set-key set-key--rec"></i>${recText}</span>` +
    `<span><i class="set-key set-key--other"></i>Other files</span>` + limitLegend;

  // A hint when the disk is already over the limit
  const warn = document.getElementById('diskWarn');
  const msgs = [];
  if (!s.exists) msgs.push('This folder does not exist yet. It is created when the first recording starts.');
  if (on && s.percent >= limit) {
    const times = setState.vals.cleanup_times.map(setFmtClock).join(', ');
    msgs.push(`The disk is above the limit. The oldest days are deleted at the next clean-up${times ? ` (${times})` : ''}.`);
  }
  if (s.oldest_day) msgs.push(`Oldest recording: ${setFmtDay(s.oldest_day)}.`);
  warn.hidden = !msgs.length;
  warn.classList.toggle('is-warn', on && s.percent >= limit);
  warn.textContent = msgs.join(' ');
}

/* ---------- System ---------- */
async function setLoadSystem() {
  let info;
  try {
    const res = await fetch('/api/settings/system');
    if (!res.ok) throw new Error();
    info = await res.json();
  } catch (e) {
    const about = document.getElementById('setAbout');
    if (about) about.innerHTML = '<p class="muted">Could not read the system details.</p>';
    return;
  }
  const status = document.getElementById('liveStatus');
  if (!status) return;

  status.className = 'set-status ' + (info.live_available ? 'ok' : 'bad');
  status.innerHTML = `<i></i>${info.live_available ? `Running · port ${setEsc(info.live_port)}` : 'Not running'}`;

  const items = [
    ['CamVault', 'v' + info.version], ['FFmpeg', info.ffmpeg],
    ['Time zone', info.timezone], ['Running for', setFmtUptime(info.uptime_seconds)],
    ['Database', info.database], ['Log file', info.log_file || '—']
  ];
  document.getElementById('setAbout').innerHTML = items.map(([k, val]) =>
    `<div class="set-about__row"><span>${k}</span><span title="${setEsc(val)}">${setEsc(val)}</span></div>`).join('');
}
