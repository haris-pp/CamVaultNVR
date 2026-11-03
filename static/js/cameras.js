/*-------------------------- Cameras page (list + detail) ---------------------------*/
/* Left: cameras grouped by a common word in their names (Parking, Gate, ...), the rest under "Others".
   Right: preview, overview, connection (edit / test / delete) and schedule summary for the selected camera. */

const camState = { list: [], selectedId: null, tab: 'overview', mode: 'view', query: '', timer: null };
const camThumbs = {};          // camera id -> object URL of its last snapshot
const camSnapBusy = new Set(); // camera ids with a snapshot request in flight

/* ---------- Grouping by common name ---------- */
// Words that never make a good group name (generic, or only a position/modifier like "North", "Main").
const CAM_SKIP = new Set([
  'cam', 'camera', 'cctv', 'ipc', 'nvr', 'channel', 'the', 'and', 'for',
  'north', 'south', 'east', 'west', 'left', 'right', 'front', 'back', 'main', 'upper', 'lower',
  'top', 'side', 'inner', 'outer', 'new', 'old', 'one', 'two', 'three', 'first', 'second', 'third'
]);

function camStem(w) { return (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) ? w.slice(0, -1) : w; }

function camWords(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')          // "MainParking" -> "Main Parking"
    .replace(/[_\-./]+/g, ' ')
    .toLowerCase().split(/[^a-z]+/)
    .filter(w => w.length >= 3).map(camStem);
}

// A camera joins the group of the word it shares with the most other cameras
// (a tie goes to the later word: "Main Parking" -> Parking, "Back Gate" -> Gate).
// Cameras that share no useful word, and one-camera groups, go to "Others".
function groupCameras(list) {
  const words = list.map(c => camWords(c.name).filter(w => !CAM_SKIP.has(w)));
  const freq = {};
  words.forEach(ws => new Set(ws).forEach(w => { freq[w] = (freq[w] || 0) + 1; }));

  const buckets = new Map();
  list.forEach((c, i) => {
    let best = null;
    words[i].forEach(w => { if (freq[w] >= 2 && (best === null || freq[w] >= freq[best])) best = w; });
    const key = best || '';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  });

  const others = buckets.get('') || [];
  const groups = [];
  buckets.forEach((cams, key) => {
    if (!key) return;
    if (cams.length < 2) others.push(...cams);
    else groups.push({ label: key.charAt(0).toUpperCase() + key.slice(1), cams });
  });
  groups.sort((a, b) => b.cams.length - a.cams.length || a.label.localeCompare(b.label));
  groups.forEach(g => g.cams.sort((a, b) => a.name.localeCompare(b.name)));
  if (others.length) groups.push({ label: 'Others', cams: others.sort((a, b) => a.name.localeCompare(b.name)) });
  return groups;
}

/* ---------- Small helpers ---------- */
function camStatus(c) {
  const s = (c.current_status || '').toLowerCase();
  if (s.includes('running')) return { key: 'rec', label: 'Recording' };
  if (s.includes('error') || s.includes('restart') || s.includes('stop_failed')) return { key: 'err', label: 'Problem' };
  if (s.includes('not scheduled') || s.includes('not sheduled')) return { key: 'idle', label: 'Not scheduled' };
  return { key: 'sched', label: 'Scheduled' };
}

function camGradient(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 28% 26%), hsl(${(h + 20) % 360} 24% 46%))`;
}

function camMaskUrl(url) {
  return String(url || '').replace(/\/\/([^:@\/]+):([^@\/]+)@/, '//$1:••••@');
}

function camFolderFor(name) { return String(name || '').trim().replace(/[^A-Za-z0-9_-]/g, ''); }

function camById(id) { return camState.list.find(c => String(c.id) === String(id)); }

function camMsg(text, kind) {
  const el = document.getElementById('cam-msg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'cam-msg' + (kind ? ' cam-msg--' + kind : '');
  el.hidden = !text;
}

/* ---------- Page ---------- */
async function loadCameras() {
  hideChannelSidebar();
  camState.mode = 'view';
  camState.tab = 'overview';
  camState.query = '';
  const box = document.getElementById('content');
  box.innerHTML = `
    <div class="cam-page" id="cam-page">
      <aside class="card cam-list" aria-label="Camera list">
        <div class="cam-list__head">
          <h1>Cameras</h1>
          <button class="btn btn--primary btn--sm" id="cam-add" type="button">+ Add</button>
        </div>
        <label class="cam-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input type="search" id="cam-q" placeholder="Search cameras" aria-label="Search cameras">
        </label>
        <div id="cam-groups"></div>
      </aside>
      <section class="card cam-detail" id="cam-detail" aria-label="Camera details"></section>
    </div>`;
  await reloadCameras(null);
  const page = document.getElementById('cam-page');
  page.addEventListener('click', camClick);
  page.addEventListener('input', camInput);
}

async function reloadCameras(selectId) {
  let data = [];
  try { data = await (await fetch('/api/cameras')).json(); } catch (e) { /* keep empty */ }
  camState.list = data;
  if (selectId != null && camById(selectId)) camState.selectedId = selectId;
  else if (!camById(camState.selectedId)) camState.selectedId = (camState.list[0] || {}).id ?? null;
  renderCamList();
  renderCamDetail();
  startCamPreview();
  refreshCamThumbs();
}

function renderCamList() {
  const box = document.getElementById('cam-groups');
  if (!box) return;
  const q = camState.query.trim().toLowerCase();
  const list = camState.list.filter(c => !q || c.name.toLowerCase().includes(q) || (c.url || '').toLowerCase().includes(q));
  if (!camState.list.length) { box.innerHTML = '<p class="cam-empty">No cameras yet.</p>'; return; }
  if (!list.length) { box.innerHTML = '<p class="cam-empty">No camera matches your search.</p>'; return; }

  box.innerHTML = groupCameras(list).map(g => `
    <div class="cam-group">
      <div class="cam-group__title">${escapeHtml(g.label)} <span>${g.cams.length}</span></div>
      ${g.cams.map(c => {
        const st = camStatus(c);
        const on = String(c.id) === String(camState.selectedId) && camState.mode === 'view';
        return `<button type="button" class="cam-item${on ? ' is-on' : ''}" data-cam-id="${c.id}">
          <span class="cam-thumb" data-thumb="${c.id}" style="background:${camGradient(c.name)}">${camThumbs[c.id] ? `<img src="${camThumbs[c.id]}" alt="">` : ''}</span>
          <span class="cam-item__name">${escapeHtml(c.name)}</span>
          <span class="cam-dot cam-dot--${st.key}" role="img" aria-label="${st.label}" title="${st.label}"></span>
        </button>`;
      }).join('')}
    </div>`).join('');
}

/* ---------- Detail panel ---------- */
function camField(id, label, value, opts = {}) {
  return `<div class="field${opts.wide ? ' field--wide' : ''}">
    <label for="${id}">${label}</label>
    <input id="${id}" value="${escapeHtml(value || '')}" ${opts.placeholder ? `placeholder="${escapeHtml(opts.placeholder)}"` : ''}
           ${opts.readonly ? 'readonly' : ''} ${opts.mono ? 'class="mono"' : ''} autocomplete="off" spellcheck="false">
    ${opts.help ? `<span class="hint">${opts.help}</span>` : ''}
  </div>`;
}

function renderCamDetail() {
  const box = document.getElementById('cam-detail');
  if (!box) return;

  if (camState.mode === 'add') {
    box.innerHTML = `
      <div class="cam-head"><h2>Add camera</h2></div>
      <div class="cam-form">
        ${camField('f-name', 'Name', '', { placeholder: 'e.g. Parking North' })}
        ${camField('f-folder', 'Recording folder', '', { readonly: true, mono: true, help: 'Created automatically from the name.' })}
        ${camField('f-url', 'Camera address (RTSP)', '', { wide: true, mono: true, placeholder: 'rtsp://user:password@192.168.1.50:554/stream1' })}
        ${camField('f-sub', 'Lower-quality stream <span class="muted">(optional)</span>', '', { wide: true, mono: true, placeholder: 'rtsp://…/stream2', help: 'Used for the live wall so it stays light. Recording always uses the main stream.' })}
      </div>
      <div id="cam-test-result" class="cam-test" hidden></div>
      <p id="cam-msg" class="cam-msg" role="status" hidden></p>
      <div class="cam-actions">
        <button type="button" class="btn" id="cam-cancel">Cancel</button>
        <span class="cam-actions__right">
          <button type="button" class="btn" id="cam-test">Test connection</button>
          <button type="button" class="btn btn--primary" id="cam-create">Add camera</button>
        </span>
      </div>`;
    return;
  }

  const cam = camById(camState.selectedId);
  if (!cam) {
    box.innerHTML = `<div class="cam-blank"><h2>No cameras yet</h2><p>Add your first camera to see it here.</p>
      <button type="button" class="btn btn--primary" id="cam-add2">Add camera</button></div>`;
    return;
  }

  const st = camStatus(cam);
  box.innerHTML = `
    <div class="cam-head">
      <h2>${escapeHtml(cam.name)}</h2>
      <span class="cam-pill cam-pill--${st.key}" title="${escapeHtml(cam.status_msg || '')}">${st.label}</span>
      <button type="button" class="btn btn--sm" id="cam-live">Open live view</button>
    </div>

    <div class="cam-preview" id="cam-preview">
      <img id="cam-snap" alt="Latest picture from ${escapeHtml(cam.name)}" hidden>
      <span class="cam-preview__hint" id="cam-snap-hint">Loading picture…</span>
    </div>

    <div class="cam-tabs" role="tablist" aria-label="Camera sections">
      ${[['overview', 'Overview'], ['connection', 'Connection'], ['schedule', 'Schedule']].map(([k, l]) =>
        `<button type="button" role="tab" class="cam-tab${camState.tab === k ? ' is-on' : ''}" aria-selected="${camState.tab === k}" data-tab="${k}">${l}</button>`).join('')}
    </div>
    <div id="cam-panel"></div>`;
  renderCamPanel(cam);

  const cached = camThumbs[cam.id];
  if (cached) showCamSnap(cached, '');
}

function renderCamPanel(cam) {
  const panel = document.getElementById('cam-panel');
  if (!panel) return;

  if (camState.tab === 'connection') {
    panel.innerHTML = `
      <div class="cam-form">
        ${camField('f-name', 'Name', cam.name)}
        ${camField('f-folder', 'Recording folder', cam.record_folder_name, { readonly: true, mono: true, help: 'Fixed, so existing recordings stay linked to this camera.' })}
        ${camField('f-url', 'Main stream (recording)', cam.url, { wide: true, mono: true })}
        ${camField('f-sub', 'Lower-quality stream <span class="muted">(optional, used for the live wall)</span>', cam.sub_url, { wide: true, mono: true, placeholder: 'rtsp://…/stream2' })}
      </div>
      <div id="cam-test-result" class="cam-test" hidden></div>
      <p id="cam-msg" class="cam-msg" role="status" hidden></p>
      <div class="cam-actions">
        <button type="button" class="btn btn--danger" id="cam-delete">Delete camera</button>
        <span class="cam-actions__right">
          <button type="button" class="btn" id="cam-test">Test connection</button>
          <button type="button" class="btn btn--primary" id="cam-save">Save changes</button>
        </span>
      </div>`;
    return;
  }

  if (camState.tab === 'schedule') {
    panel.innerHTML = '<p class="muted">Loading schedule…</p>';
    camScheduleSummary(cam);
    return;
  }

  const st = camStatus(cam);
  panel.innerHTML = `
    <dl class="cam-facts">
      <div><dt>Status</dt><dd><span class="status-badge ${getStatusClass(cam.current_status)}">${escapeHtml(cam.current_status || '')}</span>
        ${cam.status_msg ? `<span class="muted">${escapeHtml(cam.status_msg)}</span>` : ''}</dd></div>
      <div><dt>Recording folder</dt><dd class="mono">${escapeHtml(cam.record_folder_name || '')}</dd></div>
      <div class="cam-facts__wide"><dt>Main stream</dt><dd class="mono">${escapeHtml(camMaskUrl(cam.url))}</dd></div>
      <div class="cam-facts__wide"><dt>Lower-quality stream</dt><dd class="mono">${cam.sub_url ? escapeHtml(camMaskUrl(cam.sub_url)) : '<span class="muted">None</span>'}</dd></div>
    </dl>
    <div class="cam-actions cam-actions--start">
      <button type="button" class="btn" id="cam-goto-schedule">Edit schedule</button>
      <button type="button" class="btn" id="cam-goto-play">Watch recordings</button>
      <button type="button" class="btn" id="cam-goto-rec">Download footage</button>
    </div>`;
}

async function camScheduleSummary(cam) {
  const slots = await fetchSchedule(cam.id);
  const panel = document.getElementById('cam-panel');
  if (!panel || String(camState.selectedId) !== String(cam.id) || camState.tab !== 'schedule') return;

  const names = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const rows = DAY_KEYS.map(d => ({ d, r: (slots && slots[d]) || [] }));
  const any = rows.some(x => x.r.length);
  const allDay = rows.every(x => x.r.some(r => hmsToSec(r.from) <= 0 && hmsToSec(r.to) >= SEC_DAY));

  panel.innerHTML = !any
    ? `<p class="cam-empty cam-empty--left">No schedule yet, so this camera is not recording.</p>
       <div class="cam-actions cam-actions--start"><button type="button" class="btn btn--primary" id="cam-goto-schedule">Create schedule</button></div>`
    : `${allDay ? '<p class="cam-allday">Records 24 hours a day, 7 days a week.</p>' : ''}
       <ul class="cam-sched">${rows.map(x => `<li><b>${names[x.d]}</b><span>${x.r.length
         ? x.r.map(r => `${String(r.from).slice(0, 5)}–${String(r.to).slice(0, 5)}`).join(', ')
         : '<span class="muted">Off</span>'}</span></li>`).join('')}</ul>
       <div class="cam-actions cam-actions--start"><button type="button" class="btn" id="cam-goto-schedule">Edit schedule</button></div>`;
}

/* ---------- Pictures (go2rtc snapshots) ---------- */
function showCamSnap(url, hint) {
  const img = document.getElementById('cam-snap');
  const h = document.getElementById('cam-snap-hint');
  if (!img || !h) return;
  if (url) { img.src = url; img.hidden = false; h.hidden = true; }
  else { img.hidden = true; h.hidden = !hint; h.textContent = hint || ''; }
}

async function fetchCamSnapshot(id) {
  if (camSnapBusy.has(id)) return { busy: true };
  camSnapBusy.add(id);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const cfg = await getLiveConfig(!liveCfg || !liveCfg.available);
    if (!cfg.available) return { hint: 'Live view is off (go2rtc is not running)' };
    const r = await fetch(`${cfg.base}/api/frame.jpeg?src=${encodeURIComponent('cam_' + id)}`, { signal: ctrl.signal });
    const blob = r.ok ? await r.blob() : null;
    if (!blob || !blob.type.startsWith('image/') || blob.size < 200) return { hint: 'No picture from the camera' };
    return { url: URL.createObjectURL(blob) };
  } catch (e) {
    return { hint: e.name === 'AbortError' ? 'Camera is too slow to respond' : 'Live view is not reachable' };
  } finally {
    clearTimeout(timer);
    camSnapBusy.delete(id);
  }
}

function applyCamSnapshot(id, res) {
  if (res.busy) return;
  if (res.url) {
    const old = camThumbs[id];
    camThumbs[id] = res.url;
    document.querySelectorAll(`.cam-thumb[data-thumb="${id}"]`).forEach(el => { el.innerHTML = `<img src="${res.url}" alt="">`; });
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
  }
  if (String(camState.selectedId) === String(id) && camState.mode === 'view') {
    showCamSnap(res.url || camThumbs[id] || '', res.hint || '');
  }
}

async function refreshCamThumbs() {           // all list pictures, three at a time
  const ids = camState.list.map(c => c.id);
  const worker = async () => {
    while (ids.length) {
      const id = ids.shift();
      if (!document.getElementById('cam-groups')) return;
      applyCamSnapshot(id, await fetchCamSnapshot(id));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

function startCamPreview() {                   // the selected camera's picture is refreshed every 6 s
  clearInterval(camState.timer);
  camState.timer = setInterval(async () => {
    if (!document.getElementById('cam-snap') || currentPage !== 'cameras' || camState.mode !== 'view') {
      if (!document.getElementById('cam-page')) { clearInterval(camState.timer); camState.timer = null; }
      return;
    }
    const id = camState.selectedId;
    if (id != null) applyCamSnapshot(id, await fetchCamSnapshot(id));
  }, 6000);
}

/* ---------- Actions ---------- */
function camSelect(id) {
  camState.selectedId = id;
  camState.mode = 'view';
  camState.tab = 'overview';
  renderCamList();
  renderCamDetail();
  const cached = camThumbs[id];
  if (!cached) fetchCamSnapshot(id).then(res => applyCamSnapshot(id, res));
}

function camFormValues() {
  const v = id => (document.getElementById(id)?.value || '').trim();
  return { name: v('f-name'), url: v('f-url'), sub_url: v('f-sub') };
}

async function camTest() {
  const { url } = camFormValues();
  const out = document.getElementById('cam-test-result');
  const btn = document.getElementById('cam-test');
  if (!out) return;
  out.hidden = false;
  out.className = 'cam-test';
  if (!url) { out.className = 'cam-test cam-test--bad'; out.textContent = 'Enter the camera address first.'; return; }
  out.textContent = 'Testing… this can take a few seconds.';
  if (btn) btn.disabled = true;
  try {
    const d = await (await fetch('/api/cameras/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url })
    })).json();
    if (!d.ok) { out.className = 'cam-test cam-test--bad'; out.textContent = 'Could not connect: ' + (d.error || 'unknown error'); return; }
    const codec = String(d.codec || '').toLowerCase();
    const bits = [codec ? codec.toUpperCase().replace('HEVC', 'H.265').replace('H264', 'H.264') : null,
                  d.width && d.height ? `${d.width}×${d.height}` : null, d.fps ? `${d.fps} fps` : null].filter(Boolean);
    const okHtml = '✓ Connected · ' + escapeHtml(bits.join(' · '));
    if (codec && codec !== 'h264') {
      out.className = 'cam-test cam-test--warn';
      out.innerHTML = okHtml + '<br>Recording works with this stream, but browsers only play H.264 live. Add an H.264 lower-quality stream, or switch the camera to H.264.';
    } else {
      out.className = 'cam-test cam-test--ok';
      out.innerHTML = okHtml;
    }
  } catch (e) {
    out.className = 'cam-test cam-test--bad';
    out.textContent = 'Could not run the test.';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function camSave() {
  const cam = camById(camState.selectedId);
  const { name, url, sub_url } = camFormValues();
  if (!cam) return;
  if (!name || !url) return camMsg('Enter both a name and a camera address.', 'bad');
  const btn = document.getElementById('cam-save');
  if (btn) btn.disabled = true;
  camMsg(url !== cam.url && cam.current_status && /running/i.test(cam.current_status) ? 'Saving… restarting the recording on the new address.' : 'Saving…');
  try {
    const r = await fetch('/api/cameras/' + cam.id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, url, sub_url })
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); return camMsg(d.error || 'Could not save.', 'bad'); }
    const urlChanged = url !== cam.url;
    await reloadCameras(cam.id);
    camState.tab = 'connection';
    renderCamDetail();
    camMsg(urlChanged ? 'Saved. The camera address changed, so recording and live view use the new address.' : 'Saved.', 'ok');
    if (urlChanged) { delete camThumbs[cam.id]; fetchCamSnapshot(cam.id).then(res => applyCamSnapshot(cam.id, res)); }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function camCreate() {
  const { name, url, sub_url } = camFormValues();
  if (!name || !url) return camMsg('Enter both a name and a camera address.', 'bad');
  const folder = camFolderFor(name);
  if (!folder) return camMsg('The name needs at least one letter or number.', 'bad');
  if (camState.list.some(c => (c.record_folder_name || '').toLowerCase() === folder.toLowerCase()))
    return camMsg(`A camera with the recording folder "${folder}" already exists. Use a different name.`, 'bad');

  const btn = document.getElementById('cam-create');
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/cameras', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, url, sub_url })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return camMsg(d.error || 'Could not add the camera.', 'bad');
    camState.mode = 'view';
    camState.tab = 'overview';
    await reloadCameras(d.id);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function camDelete() {
  const cam = camById(camState.selectedId);
  if (!cam) return;
  if (!confirm(`Delete "${cam.name}"?\n\nIts saved recordings stay on disk, but the camera is removed from CamVault.`)) return;
  await fetch('/api/cameras?id=' + cam.id, { method: 'DELETE' });
  delete camThumbs[cam.id];
  camState.selectedId = null;
  camState.tab = 'overview';
  await reloadCameras(null);
}

function camClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.camId) return camSelect(t.dataset.camId);
  if (t.dataset.tab) { camState.tab = t.dataset.tab; renderCamDetail(); return; }
  switch (t.id) {
    case 'cam-add': case 'cam-add2':
      camState.mode = 'add'; renderCamList(); renderCamDetail();
      document.getElementById('f-name')?.focus(); return;
    case 'cam-cancel': camState.mode = 'view'; renderCamList(); renderCamDetail(); return;
    case 'cam-test': return camTest();
    case 'cam-save': return camSave();
    case 'cam-create': return camCreate();
    case 'cam-delete': return camDelete();
    case 'cam-live': {
      const cam = camById(camState.selectedId);
      if (cam) openLive(cam.id, cam.name, !!cam.sub_url);
      return;
    }
    case 'cam-goto-schedule': window.pendingScheduleCamera = camState.selectedId; return goTo('schedules');
    case 'cam-goto-play': {                       // open Playback on this camera
      const cam = camById(camState.selectedId);
      window.pbOpen = cam ? { source: cam.record_folder_name } : null;
      return goTo('playback');
    }
    case 'cam-goto-rec': return goTo('download');
  }
}

function camInput(e) {
  if (e.target.id === 'cam-q') { camState.query = e.target.value; renderCamList(); }
  if (e.target.id === 'f-name' && camState.mode === 'add') {
    const f = document.getElementById('f-folder');
    if (f) f.value = camFolderFor(e.target.value);
  }
}

// The search box in the top bar filters this list too
document.addEventListener('input', e => {
  if (e.target && e.target.id === 'globalSearch' && document.getElementById('cam-groups')) {
    camState.query = e.target.value;
    const q = document.getElementById('cam-q');
    if (q) q.value = e.target.value;
    renderCamList();
  }
});

/* ---------- Status helpers (also used by other pages) ---------- */
function getStatusClass(status) {
  const statusLower = (status || '').toLowerCase();
  if (statusLower.includes('pending')) return 'pending';
  if (statusLower.includes('running')) return 'running';
  if (statusLower.includes('expired')) return 'expired';
  if (statusLower.includes('error'))   return 'error';
  if (statusLower === 'not scheduled' || statusLower.includes('not sheduled')) return 'not-scheduled';
  return 'unknown';
}

function getDotClass(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('not scheduled') || s.includes('not sheduled')) return 'dot-red';
  if (s.includes('running')) return 'dot-green';
  return 'dot-yellow';
}
