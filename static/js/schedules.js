/*--------------------------Schedules section---------------------------*/

// Global mode: "view" | "edit"
let scheduleMode = "view";

async function loadSchedules() {
  hideChannelSidebar();

  const res = await fetch('/api/cameras');
  const cameras = await res.json();

  const container = document.getElementById('content');

  let html = `
    ${backToCamerasHtml()}
    <div class="page-head">
      <div>
        <div class="eyebrow">Weekly plan</div>
        <h1>Schedules</h1>
      </div>
    </div>

    <section class="card">
      <div class="card__head">
        <h2>Weekly recording schedule</h2>
        <div class="actions">
          <button id="saveBtn" class="btn btn--primary" onclick="saveSchedule()" disabled style="display:none;">
            Save schedule
          </button>
        </div>
      </div>

      <div id="schedule-container">
        <div class="schedule" id="schedule"></div>
      </div>

      <p class="hint schedule-hint">Click or drag on the grid to select 15-minute slots. Right-click and drag to clear slots.</p>
    </section>

    <div class="tooltip" id="tooltip"></div>

    <section class="card">
      <div class="card__head">
        <h2>Select cameras</h2>

        <div class="schedule-tools">
          <!-- Toggle switch -->
          <div id="mode-toggle" class="mode-toggle" onclick="toggleScheduleMode()">
            <span id="mode-label-view" class="mode-label is-on">View</span>
            <span id="mode-label-edit" class="mode-label">Edit</span>
          </div>

          <span id="mode-hint" class="hint">
            Click a camera to view its schedule
          </span>

          <input
            type="text"
            id="cameraSearch"
            class="camera-search"
            placeholder="Search camera..."
            oninput="filterCameras(this.value)"
          >
        </div>
      </div>

      <div class="camera-grid">
  `;

  cameras.forEach(camera => {
    html += `
      <label class="camera-card">
        <input
          type="checkbox"
          class="camera-checkbox"
          value="${camera.id}"
          onchange="onCamerasChanged(event, this)"
        />
        <span class="camera-name">${escapeHtml(camera.name)}</span>
      </label>
    `;
  });

  html += `</div></section>`;

  container.innerHTML = html;
  schedule = document.getElementById("schedule");
  buildScheduleGrid();

  // Apply initial mode styling
  applyModeToGrid();
}

// ---- MODE TOGGLE ----

function toggleScheduleMode() {
  scheduleMode = scheduleMode === "view" ? "edit" : "view";

  const viewLabel = document.getElementById("mode-label-view");
  const editLabel = document.getElementById("mode-label-edit");
  const hint = document.getElementById("mode-hint");
  const saveBtn = document.getElementById("saveBtn");

  // Always reset everything on mode switch
  document.querySelectorAll('.camera-checkbox').forEach(cb => cb.checked = false);
  selectedCameraIds = [];
  clearScheduleGrid();
  clearCameraHighlights();

  if (scheduleMode === "view") {
    viewLabel.classList.add("is-on");
    editLabel.classList.remove("is-on");
    hint.textContent = "Click a camera to view its schedule";
    saveBtn.disabled = true;
    saveBtn.style.display = "none";
  } else {
    editLabel.classList.add("is-on");
    viewLabel.classList.remove("is-on");
    hint.textContent = "Select cameras, draw schedule, then save";
    saveBtn.disabled = true;
    saveBtn.style.display = "";
  }

  applyModeToGrid();
}

function applyModeToGrid() {
  const scheduleEl = document.getElementById("schedule");
  if (!scheduleEl) return;

  if (scheduleMode === "view") {
    scheduleEl.classList.add("readonly");
  } else {
    scheduleEl.classList.remove("readonly");
  }
}

// ---- CAMERA SELECTION ----

function onCamerasChanged(event, changedCheckbox) {
  if (scheduleMode === "view") {
    // --- VIEW MODE: only one checkbox allowed ---
    const allCheckboxes = document.querySelectorAll('.camera-checkbox');

    if (changedCheckbox && changedCheckbox.checked) {
      // Uncheck all others
      allCheckboxes.forEach(cb => {
        if (cb !== changedCheckbox) cb.checked = false;
      });
      selectedCameraIds = [parseInt(changedCheckbox.value)];
    } else {
      selectedCameraIds = [];
    }

    clearCameraHighlights();
    clearScheduleGrid();

    const saveBtn = document.getElementById("saveBtn");
    saveBtn.disabled = true; // View mode never saves

    if (selectedCameraIds.length === 1) {
      highlightActiveCamera(selectedCameraIds[0]);
      loadScheduleForCamera(selectedCameraIds[0]);
    }

  } else {
    // --- EDIT MODE: multi-select, no schedule loading ---
    selectedCameraIds = [...document.querySelectorAll('.camera-checkbox:checked')]
      .map(cb => parseInt(cb.value));

    const saveBtn = document.getElementById("saveBtn");
    saveBtn.disabled = selectedCameraIds.length === 0;

    clearCameraHighlights();
    if (selectedCameraIds.length > 0) {
      highlightActiveCamera(selectedCameraIds[selectedCameraIds.length - 1]);
    }
    // Do NOT load/show any existing schedule in edit mode
  }
}


function clearScheduleGrid() {
  document.querySelectorAll(".slot.selected")
    .forEach(slot => slot.classList.remove("selected"));
}

function highlightActiveCamera(cameraId) {
  const checkbox = document.querySelector(
    `.camera-checkbox[value="${cameraId}"]`
  );
  if (!checkbox) return;
  checkbox.closest(".camera-card").classList.add("active");
}

function clearCameraHighlights() {
  document.querySelectorAll(".camera-card.active")
    .forEach(card => card.classList.remove("active"));
}

async function loadScheduleForCamera(cameraId) {
  const container = document.getElementById("schedule-container");

  container.innerHTML = `
    <div class="schedule" id="schedule"></div>
  `;

  schedule = document.getElementById("schedule");
  buildScheduleGrid();
  applyModeToGrid(); // re-apply readonly after rebuild

  const res = await fetch(`/api/schedules/${cameraId}`);
  if (res.ok) {
    const data = await res.json();
    applySavedSchedule(data);
  }
}


function filterCameras(query) {
  query = query.toLowerCase();
  document.querySelectorAll(".camera-card").forEach(card => {
    const name = card.querySelector(".camera-name").textContent.toLowerCase();
    card.style.display = name.includes(query) ? "" : "none";
  });
}


function buildScheduleGrid() {
  const days = ["sun","mon","tue","wed","thu","fri","sat"];
  const slotsPerDay = 96;
  const tooltip = document.getElementById("tooltip");

  let selectionBox = null;
  let startX = 0;
  let startY = 0;
  let dragMode = null;
  let initialSelection = new Map();

  // ---- HEADER ----
  schedule.appendChild(document.createElement("div")); // empty corner

  for (let h = 0; h < 24; h++) {
    const t = document.createElement("div");
    t.className = "time-header hour";
    t.textContent = formatHourLabel(h);
    t.style.gridColumn = "span 4";
    schedule.appendChild(t);
  }

  // ---- GRID ----
  days.forEach(day => {
    const d = document.createElement("div");
    d.className = "day";
    d.textContent = day;
    schedule.appendChild(d);

    for (let i = 0; i < slotsPerDay; i++) {
      const slot = document.createElement("div");
      slot.className = "slot" + (i % 4 === 0 ? " hour-start" : "");
      slot.dataset.day = day;
      slot.dataset.index = i;

      slot.addEventListener("click", () => {
        if (scheduleMode === "view") return; // 🔒 read-only
        if (!dragMode) slot.classList.toggle("selected");
      });

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

      slot.addEventListener("mouseleave", () => {
        tooltip.style.display = "none";
      });

      schedule.appendChild(slot);
    }
  });

  schedule.addEventListener("contextmenu", e => e.preventDefault());

  // ---- DRAG SELECT (edit mode only) ----
  schedule.addEventListener("mousedown", e => {
    if (scheduleMode === "view") return; // 🔒 read-only
    if (!e.target.classList.contains("slot")) return;

    document.body.classList.add("no-scroll");

    dragMode = e.button === 2 ? "unselect" : "select";
    startX = e.pageX;
    startY = e.pageY;

    initialSelection.clear();
    document.querySelectorAll(".slot").forEach(slot => {
      initialSelection.set(slot, slot.classList.contains("selected"));
    });

    selectionBox = document.createElement("div");
    selectionBox.className = "selection-box";
    document.body.appendChild(selectionBox);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  function onMouseMove(e) {
    const x = Math.min(e.pageX, startX);
    const y = Math.min(e.pageY, startY);
    const w = Math.abs(e.pageX - startX);
    const h = Math.abs(e.pageY - startY);

    Object.assign(selectionBox.style, {
      left: x + "px", top: y + "px",
      width: w + "px", height: h + "px"
    });

    const rect = selectionBox.getBoundingClientRect();

    document.querySelectorAll(".slot").forEach(slot => {
      slot.classList.toggle("selected", initialSelection.get(slot));

      const r = slot.getBoundingClientRect();
      const hit =
        r.left < rect.right  && r.right  > rect.left &&
        r.top  < rect.bottom && r.bottom > rect.top;

      if (hit) slot.classList.toggle("selected", dragMode === "select");
    });
  }

  function onMouseUp() {
    if (selectionBox) selectionBox.remove();
    selectionBox = null;
    dragMode = null;
    initialSelection.clear();

    document.body.classList.remove("no-scroll");

    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }
}

function applySavedSchedule(scheduleData) {
  Object.entries(scheduleData).forEach(([day, ranges]) => {
    ranges.forEach(range => {
      const start = time24ToIndex(range.from);
      const end   = time24ToIndex(range.to);

      for (let i = start; i < end; i++) {
        const slot = document.querySelector(
          `.slot[data-day="${day}"][data-index="${i}"]`
        );
        if (slot) slot.classList.add("selected");
      }
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

function saveSchedule() {
  if (!selectedCameraIds.length) {
    alert("Please select at least one camera");
    return;
  }

  const scheduleData = generateJSON();

  Promise.all(
    selectedCameraIds.map(cameraId =>
      fetch(`/api/schedules/${cameraId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scheduleData)
      })
    )
  ).then(() => {
    alert("Schedule saved for selected cameras");
  }).catch(() => {
    alert("Failed to save schedule");
  });
}

function generateJSON() {
  const days = ["sun","mon","tue","wed","thu","fri","sat"];
  const result = {};

  days.forEach(day => {
    const slots = [...document.querySelectorAll(`.slot[data-day="${day}"]`)];
    const selected = slots
      .filter(s => s.classList.contains("selected"))
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