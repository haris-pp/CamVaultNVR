/*--------------------------Recordings section---------------------------*/
// Enforce 2-hour (7200 seconds) maximum gap
const MAX_RANGE = 7200; // 2 hours in seconds


 function secondsToAmPm(sec) {
    sec = Math.max(0, Math.min(sec, 86400));
    const h24 = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const h12 = h24 % 12 || 12;
    const ampm = h24 < 12 ? 'AM' : 'PM';
    return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} ${ampm}`;
  }

  // Utility: HH:MM → seconds
  function timeToSeconds(time) {
    if (!time) return null;
    const [h, m] = time.split(':').map(Number);
    return h * 3600 + m * 60;
  }
function timeStringToSeconds(t) {
  if (typeof t === 'number') return t;
  if (!t) return 0;

  const parts = t.split(':').map(n => Number(n));

  if (parts.some(isNaN)) return 0;

  // hh:mm
  if (parts.length === 2) {
    const [hh, mm] = parts;
    return hh * 3600 + mm * 60;
  }

  // hh:mm:ss
  if (parts.length === 3) {
    const [hh, mm, ss] = parts;
    return hh * 3600 + mm * 60 + ss;
  }

  return 0;
}



function initSlider() {
  const sliderEl = document.getElementById('time-range-slider');
  const leftLabel = document.getElementById('slider-left-label');
const rightLabel = document.getElementById('slider-right-label');

  if (!sliderEl) return;

  // Utility: seconds → 12-hour AM/PM
 
  noUiSlider.create(sliderEl, {
    start: [0, MAX_RANGE], // 00:00 to 02:00
    connect: true,
    range: { min: 0, max: 86400 },
    step: 60,
   /* tooltips: [
      { to: v => secondsToAmPm(v) },
      { to: v => secondsToAmPm(v) }
    ],*/
    format: { to: v => Math.round(v), from: v => Number(v) }
  });

 
  // Store slider reference
  window.timeSlider = sliderEl.noUiSlider;
   // Sync slider → load on change
// Sync slider → update labels
window.timeSlider.on('update', (values) => {
  leftLabel.textContent = secondsToAmPm(values[0]);
  rightLabel.textContent = secondsToAmPm(values[1]);
});

let isAdjusting = false; // Prevent feedback loop

window.timeSlider.on('change', (values, handle) => {
  if (isAdjusting) return; // Skip if we're the ones setting

  isAdjusting = true;

  let [start, end] = values.map(v => Math.round(v));
  const diff = end - start;

  if (diff > MAX_RANGE) {
    if (handle === 0) {
      // User dragged START too far right → move END forward
      end = start + MAX_RANGE;
    } else {
      // User dragged END too far left → move START backward
      start = end - MAX_RANGE;
    }

    // Clamp to valid bounds
    start = Math.max(0, start);
    end = Math.min(86400, end);

    window.timeSlider.set([start, end]);
  }

  isAdjusting = false;
});
}

async function intRecordingPage() {
  const res = await fetch('/api/settings');
  const data = await res.json();
  let skipDuration = parseInt(data.skip_duration, 10);
  // Validate: must be a positive number
if (isNaN(skipDuration) || skipDuration <= 0) {
  skipDuration = 10; // default fallback
}

window.skip_duration = skipDuration;

  const container = document.getElementById('content');
  container.innerHTML = `
    <div class="video-container">
      <video id="video-player" class="video-js" controls preload="auto" width="100%" height="auto" data-setup='{"playbackRates": [0.5, 1, 1.5, 2]}'>
        <p class="vjs-no-js">To view this video, enable JavaScript and consider upgrading to a web browser that supports HTML5 video.</p>
      </video>
    </div>
    <div class="bottom-panel">
      
    </div>
  `;

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
    userActions: {
      hotkeys: true
    }
  });

  player.ready(function() {
  this.hotkeys({
    volumeStep: 0.1,
    seekStep: 5,
    enableModifiersForNumbers: false,
    alwaysCaptureHotkeys: true,
    enableFullscreen: true,
    enableVolumeScroll: true,
    enableNumbers: true,

    playPauseKey: function(e) {
    if (e.which === 32 || e.which === 75) { // space or K
      const player = videojs.getPlayer('video-player');
      if (player.paused()) {
        player.play();
      } else {
        player.pause();
      }
      return true;
    }
    return false;
  },
    fullscreenKey: function(e) {
      // 'f'
      return e.which === 70;
    },
    seekStep: window.skip_duration, // seconds per arrow press
    rewindKey: function(e) {
      // Left arrow
      return e.which === 37;
    },
    forwardKey: function(e) {
      // Right arrow
      return e.which === 39;
    }
  });

  // -----------------------------------------------------
    //  LOW-LATENCY / SMOOTH SEEK SETTINGS FOR VIDEO.JS VHS
    // -----------------------------------------------------
    const tech = player.tech({ IWillNotUseThisInPlugins: true });

    if (tech && tech.vhs) {
        tech.vhs.xhr.beforeRequest = function (opt) {
            opt.timeout = 250;  // lower fetch stall time
            return opt;
        };

    }
});

  // Force control bar to always be visible
  player.controlBar.show();
  player.controlBar.el().style.display = 'flex';
  player.on('userinactive', function() {
    player.controlBar.show();
  });

  window.player = player;

  // Define custom Camera Dropdown component
  const Component = videojs.getComponent('Component');
  
 
  
  
  // Define custom Overlay Message component
  class OverlayMessage extends Component {
    constructor(player, options) {
      super(player, options);
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
  
  // Register components
  videojs.registerComponent('OverlayMessage', OverlayMessage);
  
  // Add to control bar and player
  player.addChild('OverlayMessage', {}, 0);

  // Hide overlay when video plays
  player.on('play', () => {
    player.getChild('OverlayMessage').hideMessage();
  });


  const controlBar = player.getChild('controlBar');
  // Remove SourceDropdown and DatePicker from control bar
if (controlBar.getChildById('SourceDropdown')) {
  controlBar.removeChild('SourceDropdown');
}
if (controlBar.getChildById('DatePicker')) {
  controlBar.removeChild('DatePicker');
}

// Create bottom panel and insert after video container
const videoContainer = document.querySelector('.video-container');
const bottomPanel = document.createElement('div');
bottomPanel.className = 'bottom-panel';
bottomPanel.innerHTML = `
  <div class="bottom-row top-row">
    <div class="control-group">
      <span class="control-label">Date</span>
      <input type="date" id="date-picker" value="${new Date().toISOString().split('T')[0]}" />
    </div>

    <div class="control-group trim-control">
      <label class="manual-toggle">
        <input type="checkbox" id="capture-from-input-time" />
        Manual input time
      </label>
      <div class="button-group trim-group">

        <!-- Capture Mode Group (buttons + labels) -->
        <div id="capture-mode-group" class="trim-capture">
          <button id="trim-start-btn"
                  onclick="trim_start_btn_clicked(this)"
                  class="quick-load-btn btn--sm">
            Trim start
          </button>
          <span id="trim-start-label" class="trim-time-label">--:--</span>

          <button id="trim-stop-btn"
                  onclick="trim_stop_btn_clicked(this)"
                  class="quick-load-btn btn--sm">
            Trim stop
          </button>
          <span id="trim-stop-label" class="trim-time-label">--:--</span>
        </div>

        <!-- Manual Input Mode Group (time inputs) -->
        <div id="manual-input-group" class="trim-manual">
          <label class="trim-time-label" for="trim-start-time">Start</label>
          <input type="time" id="trim-start-time" oninput="onManualTimeInputChange()" class="time-input" step="1" />

          <label class="trim-time-label" for="trim-end-time">End</label>
          <input type="time" id="trim-end-time" oninput="onManualTimeInputChange()" class="time-input" step="1" />
        </div>

        <button id="add-to-download-btn"
                onclick="add_to_download_btn_clicked()"
                class="quick-load-btn btn--sm">
          Add to download
        </button>

      </div>
    </div>
  </div>

  <div class="bottom-row bottom-row-controls">
    <div class="control-group time-slider-group">
      <span class="control-label">Choose a time range to play</span>
      <div class="slider-wrapper">
        <span id="slider-left-label">12:00 AM</span>
        <div id="time-range-slider"></div>
        <span id="slider-right-label">11:59 PM</span>
      </div>
    </div>

    <div class="button-group">
      <button id="quick-load-btn" class="quick-load-btn btn--primary">
        Play selected time
      </button>
    </div>
  </div>
`;

videoContainer.parentNode.insertBefore(bottomPanel, videoContainer.nextSibling);

//document.getElementById('source-select').addEventListener('change', loadRecordingSlots);

// Re-attach event listeners
const loadRecording = () => window.loadRecordingForTimeRange();

/*document.getElementById('source-select').addEventListener('change', loadList);
document.getElementById('date-picker').addEventListener('change', loadList);
document.getElementById('time-from').addEventListener('change', loadList);
document.getElementById('time-to').addEventListener('change', loadList);*/
document.getElementById('quick-load-btn').addEventListener('click', loadRecording);
/*document.getElementById('quick-download-btn').addEventListener('click', async () => {
  const source = document.getElementById('source-select').value;
  const date = document.getElementById('date-picker').value;
  const values = window.timeSlider ? window.timeSlider.get() : [0, 86340];
  const fromSec = Math.round(values[0]);
  const toSec = Math.round(values[1]);

  const overlay = window.player.getChild('OverlayMessage');
  const rightbar = document.querySelector('.rightbar');

  if (!source || !date) {
    overlay.setMessage('⚠️ Please select a camera and date first');
    return;
  }

  overlay.setMessage('⏳ Preparing download...');

  try {
    const response = await fetch(`/api/download_video?source=${source}&date=${date}&from=${fromSec}&to=${toSec}&session_id=${window.SESSION_ID}`);
    const result = await response.json();

    if (response.ok && result.download_url) {
      overlay.setMessage('✅ Download ready — starting...');
      const a = document.createElement('a');
      a.href = result.download_url;
      a.download = result.download_url.split('/').pop();
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      overlay.setMessage(`❌ ${result.error || 'Failed to prepare video'}`);
    }

  } catch (error) {
    console.error('Download error:', error);
    overlay.setMessage(`❌ Error: ${error.message}`);
  }
});*/

  // toggle enable/disable of time inputs
  // Toggle between capture mode and manual input mode
const captureCheckbox = document.getElementById('capture-from-input-time');
const captureModeGroup = document.getElementById('capture-mode-group');
const manualInputGroup = document.getElementById('manual-input-group');

function updateTimeInputState() {
  const manualTime = captureCheckbox.checked;
  
  if (manualTime) {
    // Manual input mode → show time inputs, hide buttons
    manualInputGroup.style.display = '';
    captureModeGroup.style.display = 'none';
  } else {
    // Capture mode → show buttons, hide time inputs
    manualInputGroup.style.display = 'none';
    captureModeGroup.style.display = '';
  }
}

captureCheckbox.addEventListener('change', updateTimeInputState);
updateTimeInputState(); // init




  updateTrimButtonStates();

  initSlider();

  intCahnnelSideBar();

  const rightbar = document.querySelector('.rightbar');
  rightbar.innerHTML = '<h3>Recordings</h3><p>Select camera and date</p>';
    
}

async function loadRecordingForTimeRange() {
  const source = window.selectedSource;
  const date = document.getElementById('date-picker').value;
  const values = window.timeSlider ? window.timeSlider.get() : [0, 86340];
  const fromSec = Math.round(values[0]);
  const toSec = Math.round(values[1]);



  const overlay = window.player.getChild('OverlayMessage');
  const rightbar = document.querySelector('.rightbar');
  
  if (!source || !date) {
    overlay.setMessage('Select camera and date to load recordings');
    rightbar.innerHTML = '<h3>Recordings</h3><p>Select camera and date</p>';
    return;
  }

  loadAndPlaySlot(source,date,fromSec,toSec);
  highlightCurrentlyPlayingSlotOnGallery(fromSec,toSec);
}
function highlightCurrentlyPlayingSlotOnGallery(fromSec, toSec) {
  const cards = document.querySelectorAll('.thumbnail-card');

  cards.forEach(card => {
    const slot = JSON.parse(card.getAttribute('data-slot'));
    const start = slot.from_sec || 0;
    const end = slot.to_sec || 0;

    // Highlight if any overlap with current play range
    // (start of slot <= end of play range) && (end of slot >= start of play range)
    const overlaps = start <= toSec && end >= fromSec;

    if (overlaps) {
      card.classList.add('active');
    } else {
      card.classList.remove('active');
    }
  });
}

async function loadRecordingSlots() {
  const source = window.selectedSource;
  const date = document.getElementById('date-picker').value;

  const overlay = window.player.getChild('OverlayMessage');
  const rightbar = document.querySelector('.rightbar');

  if (!source || !date) {
    overlay.setMessage('⚠️ Please select camera and date first');
    rightbar.innerHTML = '<h3>Recording Slots</h3><p>Select camera and date</p>';
    return;
  }

  overlay.setMessage('🔍 Loading recording slots...');
  rightbar.innerHTML = '<h3>Recording Slots</h3><p>Loading...</p>';

  try {
    const response = await fetch(
      `/api/recording_slots?source=${source}&date=${date}&session_id=${window.SESSION_ID}`
    );
    const slots = await response.json();

    if (!Array.isArray(slots) || slots.length === 0) {
      overlay.setMessage('❌ No slots found');
      rightbar.innerHTML = '<h3>Recording Slots</h3><p>No slots found</p>';
      return;
    }

    overlay.setMessage(`✅ Found ${slots.length} slot(s)`);

    // Sort by start time if available
    slots.sort((a, b) => (a.from_sec || 0) - (b.from_sec || 0));

    // Build gallery
    buildRecordingSlotsGallery(slots, rightbar);

  } catch (error) {
    overlay.setMessage(`❌ Error loading slots: ${error.message}`);
    console.error('Slot load error:', error);
    rightbar.innerHTML = '<h3>Recording Slots</h3><p>Error loading slots</p>';
  }
}

function buildRecordingSlotsGallery(slots, container) {
  let html = '';

  function formatTime(seconds) {
    if (seconds == null || isNaN(seconds)) return '--:-- --';
    const date = new Date(seconds * 1000); // convert sec → ms
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' });
  }

  slots.forEach(slot => {
    const start = formatTime(slot.from_sec);
    const end = formatTime(slot.to_sec);

    html += `
      <div class="thumbnail-card" 
           data-slot='${JSON.stringify(slot)}' 
           onclick="playSlotCliked(this)">
        <div class="time-info">
          <span class="time-range">${start} - ${end}</span>
        </div>
      </div>
    `;
  });

  container.innerHTML = `<h3>Recording Slots</h3><div class="gallery">${html}</div>`;
}

 function playSlotCliked(element) {
  const slot = JSON.parse(element.getAttribute('data-slot'));

  // Remove highlight from all
  document.querySelectorAll('.thumbnail-card').forEach(c => c.classList.remove('active'));

  // Highlight clicked slot
  element.classList.add('active');

  // Call your function
 // playSlot(slot.date, slot.from_sec, slot.to_sec, slot.source);


  const source = slot.source;
  const date = slot.date;
  const values = [slot.from_sec, slot.to_sec];
  const fromSec = Math.round(values[0]);
  const toSec = Math.round(values[1]);

  const overlay = window.player.getChild('OverlayMessage');
  
  if (!source || !date) {
    overlay.setMessage('No Valid chennel and date to load recordings');
    return;
  }

  overlay.setMessage('🔍 Loading recordings...');

  loadAndPlaySlot(source,date,fromSec,toSec);
}

async function loadAndPlaySlot(source,date,fromSec,toSec){

    const overlay = window.player.getChild('OverlayMessage');

try {
    const response = await fetch(`/api/recordings?source=${source}&date=${date}&from=${fromSec}&to=${toSec}&session_id=${window.SESSION_ID}`);
    const recordings = await response.json();

    if (recordings.length === 0) {
      overlay.setMessage('❌ No recordings found');
      return;
    }

    overlay.setMessage(`✅ Found ${recordings.length} recording(s)`);
 
    // Determine playlist URL based on transcode requirement
    let playlistUrl = recordings[0].playlist_url;
    
    if (recordings[0].transcode) {
      // Add transcode parameter to playlist URL
      playlistUrl = `${recordings[0].playlist_url}?transcode=true`;
      overlay.setMessage(`▶️ Playing (transcoding) from ${recordings[0].from_time}`);
    } else {
      overlay.setMessage(`▶️ Playing recording from ${recordings[0].from_time}`);
    }
    
    // Load recording into player
    window.player.src({
      src: playlistUrl,
      type: 'application/x-mpegURL'
    });
    
    window.player.play();
    overlay.hideMessage();   
    window.player.trimMeta = {
      source,
      date,
      fromSec,
      toSec
    };

     // Update trim button states after video is loaded
    updateTrimButtonStates();

  } catch (error) {
    overlay.setMessage(`❌ Error: ${error.message}`);
    console.error('Recording load error:', error);
  }
}

function buildPlayListGallery(recordings, container, append = false) {
  let html = '';

  recordings.forEach(rec => {
    const startTime = rec.from_time 
      ? new Date(`1970-01-01T${rec.from_time}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) 
      : '--:-- --';
    const endTime = rec.to_time 
      ? new Date(`1970-01-01T${rec.to_time}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) 
      : '--:-- --';    
    html += `
      <div class="thumbnail-card" data-recording='${JSON.stringify(rec)}' onclick="playRecordingFromGallery(this)">
        <div class="time-info">
          <span class="time-range">${startTime} - ${endTime}</span>
        </div>
      </div>
    `;
  });

  if (append) {
    container.querySelector('.gallery').insertAdjacentHTML('beforeend', html);
  } else {
    container.innerHTML = `<h3>Recordings</h3><div class="gallery">${html}</div>`;
  }
}

function playRecordingFromGallery(element) {
  const recording = JSON.parse(element.getAttribute('data-recording'));
  
  // Remove active class from all cards
  document.querySelectorAll('.thumbnail-card').forEach(card => card.classList.remove('active'));
  
  // Add active class to clicked card
  element.classList.add('active');
  
  // Determine playlist URL based on transcode requirement
  let playlistUrl = recording.playlist_url;
  const overlay = window.player.getChild('OverlayMessage');
  
  if (recording.transcode) {
    // Add transcode parameter to playlist URL
    playlistUrl = `${recording.playlist_url}?transcode=true`;
    overlay.setMessage(`▶️ Playing (transcoding) from ${recording.from_time}`);
  } else {
    overlay.setMessage(`▶️ Playing recording from ${recording.from_time}`);
  }
  
  // Load recording into player
  window.player.src({
    src: playlistUrl,
    type: 'application/x-mpegURL'
  });
  
  window.player.play();
  overlay.hideMessage();   

}

async function loadNextRecordings(source, date, lastEndSec, durationSec) {
  try {
    const overlay = window.player.getChild('OverlayMessage');
    const rightbar = document.querySelector('.rightbar');

    // Compute next 3 segments
    const nextRanges = [
      [lastEndSec, lastEndSec + durationSec],
      [lastEndSec + durationSec, lastEndSec + durationSec * 2],
      [lastEndSec + durationSec * 2, lastEndSec + durationSec * 3]
    ];

    let allNext = [];
    for (const [from, to] of nextRanges) {
      const res = await fetch(`/api/recordings?source=${source}&date=${date}&from=${Math.round(from)}&to=${Math.round(to)}&session_id=${window.SESSION_ID}`);
      const recs = await res.json();
      allNext = allNext.concat(recs);
    }

    if (allNext.length > 0) {
      overlay.setMessage(`📺 Loaded ${allNext.length} more recordings`);
      allNext.sort((a, b) => parseInt(a.id) - parseInt(b.id));
      buildPlayListGallery(allNext, rightbar, true); // append new recordings
    }

  } catch (err) {
    console.error('Next recordings load error:', err);
  }
}


/*--------------------------trim section----------------------------*/
let trimStartTime = null;
let trimClips = [];


function updateTrimButtonStates1() {
  const startBtn = document.getElementById('trim-start-btn');
  const stopBtn = document.getElementById('trim-stop-btn');
  
  if (!startBtn || !stopBtn) return;
  
  // Enable trim start only if video is loaded
  const videoLoaded = window.player && window.player.trimMeta;
  startBtn.disabled = !videoLoaded;
  
  // Enable trim stop only if video is loaded
  stopBtn.disabled = !videoLoaded ;
}
function updateTrimButtonStates() {
  const startBtn  = document.getElementById('trim-start-btn');
  const stopBtn   = document.getElementById('trim-stop-btn');
  const addBtn    = document.getElementById('add-to-download-btn');
  const startTime = document.getElementById('trim-start-time');
  const endTime   = document.getElementById('trim-end-time');

  if (!startBtn || !stopBtn) return;

  const videoLoaded      = window.player && window.player.trimMeta;
  const sourceSelected   = !!window.selectedSource;
  const trimInProgress   = trimStartTime !== null;
  const trimStopCaptured = window._trimStopTime !== undefined;

  // Capture mode buttons
  startBtn.disabled = !videoLoaded;
  stopBtn.disabled  = !videoLoaded;

  // Manual input fields — disabled if no source selected
  if (startTime) startTime.disabled = !sourceSelected;
  if (endTime)   endTime.disabled   = !sourceSelected;

  // Add to Download — disabled if no source, or times not captured
  if (addBtn) addBtn.disabled = !sourceSelected || !trimStopCaptured || trimStartTime === null;
}

function trim_start_btn_clicked() {
  if (!window.player) return;

  trimStartTime = window.player.currentTime();

  const meta = window.player.trimMeta;
  const absStart = Math.round(meta.fromSec + trimStartTime);
  document.getElementById('trim-start-label').textContent = secondsToAmPm(absStart % 86400);
  updateTrimButtonStates();

}

function trim_stop_btn_clicked() {
  

  if (!window.player || trimStartTime === null) return;
    const meta = window.player.trimMeta;
    window._trimDate = meta.date;
    window._trimFromSec = meta.fromSec;
    window._trimStopTime = window.player.currentTime();

  
  const absStop = Math.round(window._trimFromSec + window._trimStopTime);
  document.getElementById('trim-stop-label').textContent = secondsToAmPm(absStop % 86400);
  updateTrimButtonStates();
}

function onManualTimeInputChange() {
  trimStartTime = timeStringToSeconds(document.getElementById('trim-start-time').value);
  window._trimStopTime = timeStringToSeconds(document.getElementById('trim-end-time').value);
  window._trimFromSec = 0;
  window._trimDate = document.getElementById('date-picker').value;
  updateTrimButtonStates();
}

function add_to_download_btn_clicked() {
  if (trimStartTime === null || window._trimStopTime === undefined) {
    alert('Please set both Trim Start and Trim Stop time first');
    return;
  }

  if (window._trimStopTime <= trimStartTime) {
    alert('Stop time must be greater than start time');
    return;
  }


  const source = window.selectedSource;
  const date = window._trimDate;
  const fromSec = window._trimFromSec || 0;

  const absStart = Math.round(fromSec + trimStartTime);
  const absStop  = Math.round(fromSec + window._trimStopTime);

  const trimObj = {
    start_sec: absStart,
    stop_sec: absStop,
    source,
    date
  };

  trimClips.push(trimObj);

  // Reset state
  trimStartTime = null;
  window._trimStopTime = undefined;
  window._trimDate = undefined;
  window._trimFromSec = undefined;

  // Reset labels
  document.getElementById('trim-start-label').textContent = '--:--';
  document.getElementById('trim-stop-label').textContent = '--:--';

  console.log('Trim added:', trimObj);
  updateTrimListUI();
  updateTrimButtonStates(); 

}

function updateTrimListUI() {
  let rightbar = document.querySelector('.rightbar');
  if (!rightbar) return;

  let trimSection = rightbar.querySelector('.trim-section');
  if (!trimSection) {
    // Create trim section container if missing
    trimSection = document.createElement('div');
    trimSection.className = 'trim-section';
    trimSection.innerHTML = `
      <h3>Trim Clips</h3>
      <div class="trim-list"></div>
      <div class="trim-actions-bottom">
        <button id="download-all-trims" class="btn btn--primary btn--sm">Download all</button>
        <button id="clear-all-trims" class="btn btn--sm">Clear all</button>
      </div>
    `;
    rightbar.appendChild(trimSection);

    // Add event listeners for buttons
    trimSection.querySelector('#download-all-trims').addEventListener('click', downloadAllTrims);
    trimSection.querySelector('#clear-all-trims').addEventListener('click', clearAllTrims);
  }

  const trimListDiv = trimSection.querySelector('.trim-list');
  trimListDiv.innerHTML = '';

  trimClips.forEach((clip, idx) => {
     const startLabel = secondsToAmPm(clip.start_sec % 86400); // keep within 24h
     const stopLabel = secondsToAmPm(clip.stop_sec % 86400);


    const clipEl = document.createElement('div');
    clipEl.className = 'trim-item';
    clipEl.innerHTML = `
      <div class="trim-info">
        <div class="trim-info__name">${clip.source} <span class="muted">· ${clip.date}</span></div>
        <div class="trim-info__time">${startLabel} – ${stopLabel}</div>
      </div>

      <div class="trim-actions">
        <button class="download-trim btn btn--sm" data-idx="${idx}">
          <span class="btn-text">Download</span>
          <span class="btn-spinner"></span>
        </button>
        <button class="close-trim btn btn--sm" data-idx="${idx}" title="Remove this trim">×</button>
      </div>
    `;


    trimListDiv.appendChild(clipEl);
  });

  // Attach download handlers
  trimListDiv.querySelectorAll('.download-trim').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = e.currentTarget.dataset.idx; // ✅ FIX
      downloadTrim(Number(idx));
    });
  });


  // Attach close (remove) handlers
  trimListDiv.querySelectorAll('.close-trim').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = e.target.dataset.idx;
      removeTrim(idx);
    });
  });
}
function clearAllTrims() {
  if (trimClips.length === 0) return;

  if (!confirm('Are you sure you want to clear all trimmed clips?')) return;

  trimClips = [];
  updateTrimListUI();
}

function removeTrim(idx) {
  trimClips.splice(idx, 1);
  updateTrimListUI();
}
/*
async function downloadTrim(idx) {
  const clip = trimClips[idx];
  if (!clip) return;
  const url = `/api/download_video?source=${clip.source}&date=${clip.date}&from=${clip.start_sec}&to=${clip.stop_sec}&session_id=${window.SESSION_ID}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      alert(`Error: ${data.error || 'Failed to download'}`);
      return;
    }

    // Trigger browser download
    const link = document.createElement('a');
    link.href = data.download_url;
    link.download = `${clip.source}_${clip.date}_${clip.start_sec}-${clip.stop_sec}.mp4`;
    document.body.appendChild(link);
    link.click();
    link.remove();

  } catch (err) {
    console.error("Download failed", err);
  }
}*/
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

    // 🔹 backend encoding (this is where delay happens)
    const res = await fetch(apiUrl);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed');

    // 🔹 start download
    await downloadFile(data.download_url,
      `${clip.source}_${clip.date}_${clip.start_sec}-${clip.stop_sec}.mp4`
    );

    // ✅ finished
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
   for (const [i, clip] of trimClips.entries()) {
    await downloadTrim(i); // sequential (keeps FFmpeg load controlled)
  }
}
/*------------------------------------------------------------------------------------------*/


/*---------------------channel serach sidebar------------------ */
window.selectedSource = null;   // will hold the record_folder_name

async function loadChannelList() {
  try {
    const [camerasRes] = await Promise.all([fetch('/api/cameras')]);
    const cameras = await camerasRes.json();

    const channelListEl = document.getElementById('channel_list');
    channelListEl.innerHTML = '';                     // clear previous

    cameras.forEach(s => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="channel-item" data-source="${s.record_folder_name}">
          <div class="channel-item-name">
            <i class="fa-solid fa-video"></i> ${s.name}
          </div>
          <div class="channel-item-info">
            Folder: ${s.record_folder_name}
          </div>
        </div>
      `;
      li.dataset.source = s.record_folder_name;      // store the key
      li.title = s.name;

      li.addEventListener('click', () => selectChannel(li, s));
      channelListEl.appendChild(li);
    });
  } catch (err) {
    console.error('Failed to load channels:', err);
  }
}

function selectChannel(liElement, cameraObj) {

 if (window.player) {
    window.player.pause();

    // Reset player without triggering MEDIA_ERR_SRC_NOT_SUPPORTED
    window.player.reset();

    // Clear trim state
    window.player.trimMeta = null;
    trimStartTime = null;
    trimClips = [];
    updateTrimListUI();
// Disable trim buttons when no video is loaded
    updateTrimButtonStates();
    // Show overlay message
    const overlay = window.player.getChild('OverlayMessage');
    if (overlay) {
      overlay.setMessage('Select camera and date to load recordings');
    }
  }

  
  // Remove active from **all .channel-item** (not the <li>)
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));


  const channelItem = liElement.querySelector('.channel-item');   // <-- get the inner div
  if (channelItem) channelItem.classList.add('active');

  // Store globally
  window.selectedSource = cameraObj.record_folder_name;

  // Load recordings for the selected camera
  loadRecordingSlots();
}

// Function to show channel sidebar
function showChannelSidebar() {
    const channelSidebar = document.getElementById('channel_sidebar');
    if (channelSidebar) {
        channelSidebar.classList.add('visible');
    }
}


// Function to handle channel selection
function onChannelSelected(channel) {
    console.log('Channel selected:', channel);
    // Add your custom logic here
    // For example, load recordings for this channel
}



function intCahnnelSideBar() {
    
    // Show channel sidebar
    showChannelSidebar();
    
   loadChannelList();
}
/* --------------------------------------------------------------
   Search filter (optional – keep it if you want live search)
   -------------------------------------------------------------- */
// Search: filter channels as user types
document.getElementById('channelSearchInput')?.addEventListener('input', e => {
  const term = e.target.value.toLowerCase().trim();
  document.querySelectorAll('#channel_list li').forEach(li => {
    const text = li.textContent.toLowerCase();
    li.style.display = text.includes(term) ? '' : 'none';
  });
});
/*------------------------------------------------------------------------------------------*/


// Global arrow key seek — works even when player doesn't have focus
document.addEventListener('keydown', function(e) {
  const player = window.player;
  if (!player || !player.el()) return;

  // Ignore if user is typing in an input/textarea/select
  const tag = document.activeElement?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

  if (e.which === 37) {
    // Left arrow → seek backward
    e.preventDefault();
    player.currentTime(Math.max(0, player.currentTime() - window.skip_duration));
  } else if (e.which === 39) {
    // Right arrow → seek forward
    e.preventDefault();
    player.currentTime(Math.min(player.duration() || Infinity, player.currentTime() + window.skip_duration));
  } else if (e.which === 32 || e.which === 75) {
    // Space or K → play/pause
    e.preventDefault();
    player.paused() ? player.play() : player.pause();
  } else if (e.which === 70) {
    // F → fullscreen
    e.preventDefault();
    player.isFullscreen() ? player.exitFullscreen() : player.requestFullscreen();
  }
});



