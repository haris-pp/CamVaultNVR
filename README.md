# CamVault NVR

A self-hosted recorder for live video streams (multicast / UDP / RTSP) with scheduling,
playback, clip export and a monitoring dashboard. Python + Flask + FFmpeg + SQLite.

> The UI uses the "Studio Light" design (top navigation, light theme). The original design
> reference is kept in `ui-kit/`. AI features (search, analytics) are planned.

## Features
- Add any FFmpeg-readable stream as a camera (`udp://`, `rtsp://`, `http://` …)
- Weekly 15-minute-grid scheduling per camera, with automatic restart and back-off
- Segmented HLS recording (`-c copy`, no re-encode) organised by camera and day
- Browser playback of recorded sessions, trimming and MP4 export
- Disk-usage recycling (oldest day removed above a threshold) and daily maintenance jobs
- Live system stats: CPU, RAM, disk, network, recording status
- Live view in the browser (snapshots on the wall, click for live video) through go2rtc – optional, see `tools/go2rtc/README.md`

## Project layout
```
camvault-nvr/
├── app.py                 Flask app, API routes, scheduler, recording control
├── ffmpeg_supervisor.py   Crash supervision, exponential back-off, schedule gap checker
├── daily_jobs.py          Daily folder creation, disk recycle, cleanup
├── transcoding_job.py     Optional MPEG-2 → H.264 background transcode (disabled by default)
├── init_db.py             SQLite schema + default settings
├── go2rtc_client.py       Keeps the optional go2rtc live-view gateway in sync with the camera list
├── tools/                 go2rtc (live view), fake test cameras and startup helpers
├── run_windows.bat        Starts go2rtc (if present) and the app on Windows
├── requirements.txt
├── templates/index.html   Single-page shell
├── static/
│   ├── css/               Current UI styles + vendored libraries (Video.js, noUiSlider, Font Awesome)
│   └── js/                Current UI logic (home, cameras, schedules, recordings, settings) + vendored libs
├── ui-kit/                Static HTML/CSS design reference for the Studio Light theme
└── RECORD/                Default recording folder (contents are git-ignored)
```

## Requirements
- Python 3.10+
- FFmpeg and ffprobe on `PATH` (`sudo apt install ffmpeg`)
- Optional: NVIDIA GPU + NVENC for hardware-accelerated clip export

## Live view (optional)
Install go2rtc as described in `tools/go2rtc/README.md`. Without it everything else still works.

## Run
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py
```
Open http://localhost:5000. The database (`app_database.db`) and `Logs/` are created on first start.
The recording folder defaults to `RECORD/` and can be changed in Settings.

## Roadmap
- [x] Port the UI to the Studio Light design
- [ ] Camera-oriented wording and views (live grid, event timeline)
- [ ] AI: object / vehicle search, analytics, clip download by query
- [ ] Authentication, Docker image, tests

## Notes
- Time zone for scheduled jobs is set in `app.py` (`BackgroundScheduler(timezone=...)`).
- Do not expose this app to an untrusted network: there is no authentication yet.
