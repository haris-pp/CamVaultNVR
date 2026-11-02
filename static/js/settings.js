/*--------------------------Settings section---------------------------*/
async function loadSettings() {
  hideChannelSidebar();
  const res = await fetch('/api/settings');
  const data = await res.json();
  const container = document.getElementById('content');
  container.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">Preferences</div>
        <h1>Settings</h1>
      </div>
      <button class="btn btn--primary" onclick="saveSettings()">Save settings</button>
    </div>

    <div class="settings-grid">

      <section class="card">
        <div class="card__head"><h2>Recording folder</h2></div>
        <div class="field">
          <label for="recordingFolder">Folder path</label>
          <input id="recordingFolder" value="${data.recording_folder}" placeholder="e.g. /mnt/recordings or F:/recordings">
          <p class="hint">Full path of the folder where recordings are saved. The server needs write access to it.</p>
        </div>
      </section>

      <section class="card">
        <div class="card__head"><h2>Segment length</h2></div>
        <div class="field">
          <label for="chunkDuration">Chunk duration (seconds)</label>
          <input id="chunkDuration" type="number" value="${data.chunk_duration}" min="1" max="300">
          <p class="hint">Duration of each video segment file (e.g. 30 seconds). Used as the FFmpeg HLS segment time.</p>
        </div>
      </section>

      <section class="card">
        <div class="card__head"><h2>Player</h2></div>
        <div class="field">
          <label for="skipDuration">Skip forward / backward (seconds)</label>
          <input id="skipDuration" type="number" value="${data.skip_duration}" min="1" max="300">
          <p class="hint">How far the keyboard arrows and skip buttons jump in the video player (e.g. 5 seconds).</p>
        </div>
      </section>

    </div>
  `;
}

async function saveSettings() {
  const recording_folder = document.getElementById('recordingFolder').value;
  const chunk_duration = parseInt(document.getElementById('chunkDuration').value);
  const skip_duration = parseInt(document.getElementById('skipDuration').value);

  if (!recording_folder || isNaN(chunk_duration)) return alert("Fill all fields correctly");
  await fetch('/api/settings', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({recording_folder, chunk_duration,skip_duration})
  });
  alert("Settings saved!");
}