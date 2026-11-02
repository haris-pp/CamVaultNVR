/*--------------------------Schedules section---------------------------
  Planner layout: cameras on the left, weekly 15-minute grid on the right.
  - Tick one camera  -> its saved schedule is loaded into the grid for editing.
  - Tick several     -> whatever is on the grid is applied to all of them on Save.
  - Left-drag paints (or erases, if the Erase tool is on). Right-drag does the opposite.
  - Click a day name to fill / clear that whole day.
  The backend API and the schedule JSON format are unchanged.
-----------------------------------------------------------------------*/

const SCH_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const SCH_SLOTS = 96;

let schedule = null;                       // the grid element
let selectedCameraIds = [];
let schState = {
  cameras: [],                             // from /api/cameras
  saved: {},                               // camera id -> saved schedule JSON (for tags)
  tool: "record",                          // "record" | "erase"
  baseline: "{}",                          // JSON string of the grid when last loaded / saved
  statusTimer: null
};

async function loadSchedules() {
  hideChannelSidebar();

  const res = await fetch('/api/cameras');
  schState.cameras = await res.json();
  selectedCameraIds = [];
  schState.tool = "record";

  document.getElementById('content').innerHTML = `
    ${backToCamerasHtml()}
    <div class="page-head">
      <div>
        <div class="eyebrow">Weekly plan</div>
        <h1>Schedules</h1>
      </div>
      <div class="sch-actions">
        <span id="sch-status" class="sch-status" hidden></span>
        <span id="sch-dirty" class="sch-dirty" hidden><i></i>Unsaved changes</span>
        <button id="sch-discard" class="btn" onclick="schDiscard()" disabled>Discard</button>
        <button id="sch-save" class="btn btn--primary" onclick="saveSchedule()" disabled>Save schedule</button>
      </div>
    </div>

    <div class="sch-layout">
      <aside class="card sch-side">
        <div class="sch-side__head">
          <h2>Cameras</h2>
          <button class="sch-link" onclick="schSelectAll()">Select all</button>
        </div>
        <input type="text" id="cameraSearch" class="camera-search" placeholder="Search camera..." oninput="filterCameras(this.value)">
        <div id="sch-hint" class="sch-hint">Tick a camera to edit its schedule. Tick several to give them the same schedule.</div>
        <div id="sch-camlist"></div>
        <div class="sch-copy">
          <label for="sch-copy-from">Copy schedule from another camera</label>
          <select id="sch-copy-from" onchange="schCopyFrom(this.value)"></select>
        </div>
      </aside>

      <section class="card sch-main">
        <div class="sch-toolbar">
          <div class="sch-seg" role="group" aria-label="Tool">
            <button id="sch-tool-record" class="is-on" onclick="schSetTool('record')">Record</button>
            <button id="sch-tool-erase" onclick="schSetTool('erase')">Erase</button>
          </div>
          <span class="sch-sep"></span>
          <span class="sch-label">Quick fill</span>
          <button class="sch-chip" onclick="schPreset('all')">24 / 7</button>
          <button class="sch-chip" onclick="schPreset('business')">Business hours</button>
          <button class="sch-chip" onclick="schPreset('nights')">Nights</button>
          <button class="sch-chip" onclick="schPreset('weekends')">Weekends</button>
          <button class="sch-chip sch-chip--danger" onclick="schPreset('clear')">Clear all</button>
        </div>

        <div id="schedule-container">
          <div class="schedule" id="schedule"></div>
        </div>

        <div class="sch-legend">
          <span><i class="sw sw--on"></i>Recording</span>
          <span><i class="sw"></i>Not recording</span>
        </div>

        <div class="sch-summary">
          <div><b id="sch-hours">0 h</b><span>per week</span></div>
          <div><b id="sch-days">0 of 7</b><span>days active</span></div>
        </div>

        <p class="hint schedule-hint">Drag across the grid to record. Right-drag, or switch to Erase, to clear. Click a day name to fill or clear the whole day. Quick fill replaces what is on the grid.</p>
      </section>
    </div>

    <div class="tooltip" id="tooltip"></div>
  `;

  schedule = document.getElementById("schedule");
  buildScheduleGrid();
  schRenderCameraList();
  schUpdateUi();

  // load every camera's saved schedule once, only to show the tags
  await Promise.all(schState.cameras.map(async c => {
    try {
      const r = await fetch(`/api/schedules/${c.id}`);
      schState.saved[c.id] = r.ok ? await r.json() : {};
    } catch (e) { schState.saved[c.id] = {}; }
  }));
  schRenderCameraList();

  // arrived from the Cameras page with a camera in mind
  if (window.pendingScheduleCamera != null) {
    const id = parseInt(window.pendingScheduleCamera);
    window.pendingScheduleCamera = null;
    if (schState.cameras.some(c => c.id === id)) {
      selectedCameraIds = [id];
      schRenderCameraList();
      await schLoadCamera(id);
      schUpdateUi();
    }
  }
}

// ---- CAMERA LIST ----

function schTag(cameraId) {
  const data = schState.saved[cameraId];
  if (data === undefined) return "…";
  const hours = schHoursOf(data);
  if (!hours) return "None";
  return hours >= 168 ? "24 / 7" : `${Math.round(hours)} h`;
}

function schHoursOf(data) {
  let slots = 0;
  Object.values(data || {}).forEach(ranges => ranges.forEach(r => {
    slots += time24ToIndex(r.to) - time24ToIndex(r.from);
  }));
  return slots / 4;
}

function schFmtHours(h) { return Number.isInteger(h) ? String(h) : h.toFixed(1); }

function schRenderCameraList() {
  const box = document.getElementById("sch-camlist");
  if (!box) return;
  const q = (document.getElementById("cameraSearch") || {}).value || "";

  // groupCameras() lives in cameras.js; fall back to one flat group if it is missing
  const groups = (typeof groupCameras === "function")
    ? groupCameras(schState.cameras)
    : [{ label: "Cameras", cams: schState.cameras }];

  box.innerHTML = groups.map(g => `
    <div class="sch-group" data-group>
      <div class="sch-group__head">
        <span>${escapeHtml(g.label)}</span>
        <button class="sch-link sch-link--sm" onclick="schSelectGroup('${g.cams.map(c => c.id).join(',')}')">All</button>
      </div>
      ${g.cams.map(c => `
        <label class="camera-card${selectedCameraIds.includes(c.id) ? ' active' : ''}">
          <input type="checkbox" class="camera-checkbox" value="${c.id}"
                 ${selectedCameraIds.includes(c.id) ? 'checked' : ''}
                 onchange="onCamerasChanged(this)">
          <span class="camera-name">${escapeHtml(c.name)}</span>
          <span class="sch-tag">${schTag(c.id)}</span>
        </label>`).join("")}
    </div>`).join("");

  // copy-from dropdown
  const sel = document.getElementById("sch-copy-from");
  if (sel) {
    sel.innerHTML = `<option value="">Choose a camera…</option>` +
      schState.cameras.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  }
  filterCameras(q);
}

function filterCameras(query) {
  query = (query || "").toLowerCase();
  document.querySelectorAll("#sch-camlist .camera-card").forEach(card => {
    const name = card.querySelector(".camera-name").textContent.toLowerCase();
    card.style.display = name.includes(query) ? "" : "none";
  });
  document.querySelectorAll("#sch-camlist [data-group]").forEach(g => {
    const any = [...g.querySelectorAll(".camera-card")].some(c => c.style.display !== "none");
    g.style.display = any ? "" : "none";
  });
}

function schReadSelection() {
  return [...document.querySelectorAll(".camera-checkbox:checked")].map(cb => parseInt(cb.value));
}

async function onCamerasChanged() {
  const before = selectedCameraIds;
  const after = schReadSelection();

  // going to exactly one camera loads its schedule into the grid
  if (after.length === 1 && !(before.length === 1 && before[0] === after[0])) {
    if (schIsDirty() && !confirm("Discard the unsaved changes on the grid?")) {
      document.querySelectorAll(".camera-checkbox").forEach(cb => cb.checked = before.includes(parseInt(cb.value)));
      return;
    }
    selectedCameraIds = after;
    schRenderCameraList();
    await schLoadCamera(after[0]);
  } else {
    selectedCameraIds = after;
    schRenderCameraList();
  }
  schUpdateUi();
}

function schSelectAll() {
  const all = schState.cameras.map(c => c.id);
  selectedCameraIds = (selectedCameraIds.length === all.length) ? [] : all;
  schRenderCameraList();
  schUpdateUi();
}

function schSelectGroup(ids) {
  const list = ids.split(",").map(Number);
  const allOn = list.every(id => selectedCameraIds.includes(id));
  selectedCameraIds = allOn
    ? selectedCameraIds.filter(id => !list.includes(id))
    : [...new Set([...selectedCameraIds, ...list])];
  schRenderCameraList();
  schUpdateUi();
}

async function schLoadCamera(cameraId) {
  clearScheduleGrid();
  try {
    const res = await fetch(`/api/schedules/${cameraId}`);
    const data = res.ok ? await res.json() : {};
    schState.saved[cameraId] = data;
    applySavedSchedule(data);
  } catch (e) { /* leave grid empty */ }
  schState.baseline = JSON.stringify(generateJSON());
  schRenderCameraList();
}

async function schCopyFrom(cameraId) {
  if (!cameraId) return;
  const res = await fetch(`/api/schedules/${cameraId}`);
  const data = res.ok ? await res.json() : {};
  clearScheduleGrid();
  applySavedSchedule(data);
  document.getElementById("sch-copy-from").value = "";
  schUpdateUi();
}

// ---- TOOLS / PRESETS ----

function schSetTool(tool) {
  schState.tool = tool;
  document.getElementById("sch-tool-record").classList.toggle("is-on", tool === "record");
  document.getElementById("sch-tool-erase").classList.toggle("is-on", tool === "erase");
  schedule.classList.toggle("erasing", tool === "erase");
}

function schPreset(kind) {
  const weekdays = ["mon", "tue", "wed", "thu", "fri"];
  const everyDay = SCH_DAYS;
  const plan = {};                          // day -> [[startHour, endHour], ...]
  if (kind === "all") everyDay.forEach(d => plan[d] = [[0, 24]]);
  if (kind === "business") weekdays.forEach(d => plan[d] = [[9, 18]]);
  if (kind === "nights") everyDay.forEach(d => plan[d] = [[0, 6], [20, 24]]);
  if (kind === "weekends") ["sat", "sun"].forEach(d => plan[d] = [[0, 24]]);
  // "clear" leaves the plan empty

  clearScheduleGrid();
  Object.entries(plan).forEach(([day, ranges]) => ranges.forEach(([s, e]) => {
    for (let i = s * 4; i < e * 4; i++) schSlot(day, i)?.classList.add("selected");
  }));
  schUpdateUi();
}

function schToggleDay(day) {
  const slots = [...document.querySelectorAll(`.slot[data-day="${day}"]`)];
  const full = slots.every(s => s.classList.contains("selected"));
  slots.forEach(s => s.classList.toggle("selected", !full));
  schUpdateUi();
}

function schSlot(day, i) {
  return document.querySelector(`.slot[data-day="${day}"][data-index="${i}"]`);
}

// ---- STATE / UI ----

function schIsDirty() {
  return JSON.stringify(generateJSON()) !== schState.baseline;
}

function schUpdateUi() {
  const dirty = schIsDirty();
  const n = selectedCameraIds.length;

  const dirtyEl = document.getElementById("sch-dirty");
  if (dirtyEl) dirtyEl.hidden = !dirty;
  const discard = document.getElementById("sch-discard");
  if (discard) discard.disabled = !dirty;

  const save = document.getElementById("sch-save");
  if (save) {
    save.disabled = n === 0;
    save.textContent = n > 1 ? `Save for ${n} cameras` : "Save schedule";
    save.title = n === 0 ? "Tick at least one camera first" : "";
  }

  const hint = document.getElementById("sch-hint");
  if (hint) {
    hint.classList.toggle("is-active", n > 0);
    if (n === 0) hint.textContent = "Tick a camera to edit its schedule. Tick several to give them the same schedule.";
    else if (n === 1) hint.textContent = "Editing " + (schState.cameras.find(c => c.id === selectedCameraIds[0]) || {}).name + ".";
    else hint.textContent = `${n} cameras selected. What is on the grid will replace the schedule of all ${n}.`;
  }

  // per-day range text under each day name, e.g. "08:00–19:00"
  const plan = generateJSON();
  SCH_DAYS.forEach(day => {
    const el = document.querySelector(`[data-day-text="${day}"]`);
    if (!el) return;
    const r = plan[day] || [];
    const f = t => t.slice(0, 5);
    el.textContent = !r.length ? "Off"
      : r.length === 1 ? (r[0].from === "00:00:00" && r[0].to === "24:00:00" ? "All day" : `${f(r[0].from)}–${f(r[0].to)}`)
      : `${r.length} ranges`;
  });

  const selected = document.querySelectorAll(".slot.selected").length;
  const daysActive = SCH_DAYS.filter(d => document.querySelector(`.slot[data-day="${d}"].selected`)).length;
  const h = document.getElementById("sch-hours");
  if (h) h.textContent = schFmtHours(selected / 4) + " h";
  const d = document.getElementById("sch-days");
  if (d) d.textContent = `${daysActive} of 7`;
}

function schDiscard() {
  clearScheduleGrid();
  applySavedSchedule(JSON.parse(schState.baseline));
  schUpdateUi();
}

function schFlash(text, isError) {
  const el = document.getElementById("sch-status");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle("is-error", !!isError);
  clearTimeout(schState.statusTimer);
  schState.statusTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function clearScheduleGrid() {
  document.querySelectorAll(".slot.selected")
    .forEach(slot => slot.classList.remove("selected"));
}

// ---- GRID ----

function buildScheduleGrid() {
  const slotsPerDay = SCH_SLOTS;
  const tooltip = document.getElementById("tooltip");

  let selectionBox = null;
  let startX = 0, startY = 0;
  let dragMode = null;                      // "select" | "unselect"
  let downSlot = null;
  let moved = false;
  let slotRects = [];
  let initialSelection = new Map();

  // ---- HEADER ----
  schedule.appendChild(document.createElement("div")); // empty corner

  for (let h = 0; h < 24; h += 3) {
    const t = document.createElement("div");
    t.className = "time-header hour";
    t.textContent = formatHourLabel(h);
    t.style.gridColumn = "span 12";
    schedule.appendChild(t);
  }

  // ---- GRID ----
  SCH_DAYS.forEach(day => {
    const d = document.createElement("button");
    d.type = "button";
    d.className = "day";
    d.innerHTML = `<span class="day__name">${day}</span><span class="day__text" data-day-text="${day}">Off</span>`;
    d.title = "Click to fill or clear the whole day";
    d.addEventListener("click", () => schToggleDay(day));
    schedule.appendChild(d);

    for (let i = 0; i < slotsPerDay; i++) {
      const slot = document.createElement("div");
      slot.className = "slot" + (i % 12 === 0 ? " hour-start" : "");
      slot.dataset.day = day;
      slot.dataset.index = i;

      slot.addEventListener("mousemove", e => {
        tooltip.style.display = "block";
        tooltip.innerHTML = `<b>${day}</b><br>${indexToTimeAMPM(i)} - ${indexToTimeAMPM(i + 1)}`;

        const padding = 12;
        const tooltipRect = tooltip.getBoundingClientRect();
        let x = e.clientX + padding;
        let y = e.clientY + padding;

        if (x + tooltipRect.width > window.innerWidth)  x = e.clientX - tooltipRect.width - padding;
        if (y + tooltipRect.height > window.innerHeight) y = e.clientY - tooltipRect.height - padding;

        tooltip.style.left = x + "px";
        tooltip.style.top  = y + "px";
      });

      slot.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });

      schedule.appendChild(slot);
    }
  });

  schedule.addEventListener("contextmenu", e => e.preventDefault());

  // ---- DRAG SELECT ----
  schedule.addEventListener("mousedown", e => {
    if (!e.target.classList.contains("slot")) return;
    if (e.button !== 0 && e.button !== 2) return;

    document.body.classList.add("no-scroll");

    // left button follows the tool, right button does the opposite
    const painting = schState.tool === "record";
    dragMode = (e.button === 2) ? (painting ? "unselect" : "select") : (painting ? "select" : "unselect");
    startX = e.clientX;
    startY = e.clientY;
    downSlot = e.target;
    moved = false;

    const all = [...document.querySelectorAll(".slot")];
    initialSelection.clear();
    slotRects = all.map(slot => {
      initialSelection.set(slot, slot.classList.contains("selected"));
      return [slot, slot.getBoundingClientRect()];
    });

    selectionBox = document.createElement("div");
    selectionBox.className = "selection-box";
    document.body.appendChild(selectionBox);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  function onMouseMove(e) {
    if (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3) moved = true;
    if (!moved) return;

    const left = Math.min(e.clientX, startX);
    const top = Math.min(e.clientY, startY);
    const right = Math.max(e.clientX, startX);
    const bottom = Math.max(e.clientY, startY);

    Object.assign(selectionBox.style, {
      left: left + "px", top: top + "px",
      width: (right - left) + "px", height: (bottom - top) + "px"
    });

    slotRects.forEach(([slot, r]) => {
      const hit = r.left < right && r.right > left && r.top < bottom && r.bottom > top;
      slot.classList.toggle("selected", hit ? dragMode === "select" : initialSelection.get(slot));
    });
  }

  function onMouseUp() {
    // a plain click (no drag) toggles the slot with the Record tool, clears it with Erase
    if (!moved && downSlot) {
      if (dragMode === "select") downSlot.classList.toggle("selected");
      else downSlot.classList.remove("selected");
    }

    if (selectionBox) selectionBox.remove();
    selectionBox = null;
    dragMode = null;
    downSlot = null;
    slotRects = [];
    initialSelection.clear();

    document.body.classList.remove("no-scroll");
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    schUpdateUi();
  }
}

function applySavedSchedule(scheduleData) {
  Object.entries(scheduleData || {}).forEach(([day, ranges]) => {
    ranges.forEach(range => {
      const start = time24ToIndex(range.from);
      const end   = time24ToIndex(range.to);
      for (let i = start; i < end; i++) schSlot(day, i)?.classList.add("selected");
    });
  });
}

// ---------- TIME HELPERS ----------

function indexToTime24(i) {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
}

function time24ToIndex(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 4 + Math.floor(m / 15);
}

function indexToTimeAMPM(i) {
  let h = Math.floor(i / 4);
  let m = (i % 4) * 15;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatHourLabel(h) {
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour} ${ampm}`;
}

// ---------- SAVE ----------

async function saveSchedule() {
  if (!selectedCameraIds.length) {
    schFlash("Tick at least one camera first", true);
    return;
  }

  const scheduleData = generateJSON();
  const ids = [...selectedCameraIds];
  const save = document.getElementById("sch-save");
  save.disabled = true;
  save.textContent = "Saving…";

  try {
    const results = await Promise.all(ids.map(id =>
      fetch(`/api/schedules/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scheduleData)
      })
    ));
    if (results.some(r => !r.ok)) throw new Error("save failed");

    ids.forEach(id => { schState.saved[id] = scheduleData; });
    schState.baseline = JSON.stringify(scheduleData);
    schRenderCameraList();
    schFlash(ids.length > 1 ? `Saved for ${ids.length} cameras` : "Schedule saved");
  } catch (e) {
    schFlash("Failed to save schedule", true);
  }
  schUpdateUi();
}

function generateJSON() {
  const result = {};

  SCH_DAYS.forEach(day => {
    const selected = [...document.querySelectorAll(`.slot[data-day="${day}"].selected`)]
      .map(s => parseInt(s.dataset.index))
      .sort((a, b) => a - b);

    if (!selected.length) return;

    result[day] = [];
    let start = selected[0];

    for (let i = 1; i <= selected.length; i++) {
      if (selected[i] !== selected[i - 1] + 1) {
        result[day].push({
          from: indexToTime24(start),
          to:   indexToTime24(selected[i - 1] + 1)
        });
        start = selected[i];
      }
    }
  });

  return result;
}
