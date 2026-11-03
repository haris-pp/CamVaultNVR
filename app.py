from flask import Flask, render_template, request, jsonify, send_from_directory
import sqlite3
import threading
import time
import subprocess
import os
import json
import logging
import re
from datetime import datetime, timedelta
from pathlib import Path
import math
import glob
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from collections import defaultdict
from daily_jobs import setup_daily_jobs
import daily_jobs
import settings_api
import playback_api
from transcoding_job import setup_transcoding_job
from logging.handlers import TimedRotatingFileHandler
from init_db import init_db
import psutil
import shutil
from contextlib import contextmanager
import sqlite3
import sys  # Add this

from ffmpeg_supervisor import ffmpeg_supervisor, start_gap_checker, _mark_started
import go2rtc_client  # optional live-view gateway (go2rtc)
import go2rtc_launcher  # starts/stops go2rtc together with the app

# ------------------- Mode and data location -------------------
# Relative paths (Logs, RECORD, templates, the database) always mean the project folder,
# whatever folder the app was started from.
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Demo mode (off by default): `python app.py --demo` or CAMVAULT_DEMO=1.
# It uses simulated cameras and keeps EVERYTHING in dev/demo_data/ (own database, own recordings),
# so it can never touch real cameras or real recordings. See dev/README.md.
DEMO = "--demo" in sys.argv or os.environ.get("CAMVAULT_DEMO", "").strip().lower() in ("1", "true", "yes", "on")
DEMO_DIR = "dev/demo_data"

def _schedule_timezone():
    """Time zone of the weekly schedules: this computer's own, unless CAMVAULT_TZ says otherwise (e.g. Europe/Berlin)."""
    name = os.environ.get("CAMVAULT_TZ", "").strip()
    if name:
        return name
    try:
        from tzlocal import get_localzone
        return get_localzone()
    except Exception as exc:
        print(f"WARNING: could not detect this computer's time zone ({exc}). Schedules use UTC - "
              "set CAMVAULT_TZ=Continent/City (for example Europe/Berlin) to fix that.", file=sys.stderr)
        return "UTC"


scheduler = BackgroundScheduler(timezone=_schedule_timezone())
scheduler.start()




app = Flask(__name__)
# The database holds camera addresses INCLUDING their passwords - it is git-ignored, never commit it.
# CAMVAULT_DB can point somewhere else (e.g. another disk).
DB = f"{DEMO_DIR}/app_database.db" if DEMO else (os.environ.get("CAMVAULT_DB") or "app_database.db")

active_recordings = {}
recording_schedules = {}

recording_lock = threading.Lock()


# Thread-local storage for database connections
thread_local = threading.local()




# ------------------- Logging Setup -------------------
log_dir = "Logs"
os.makedirs(log_dir, exist_ok=True)

# Log files: by default one rotating file per day (Logs/recorder_app.log, 30 days kept).
# FLASK_ENV=development writes a new time-stamped file at every start instead.
is_dev_mode = os.environ.get("FLASK_ENV") == "development"
is_flask_reloader = False   # app.run(use_reloader=False): there is never a second (reloader) process

# Skip file logging for Flask reloader process in development
if is_dev_mode and is_flask_reloader:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[logging.StreamHandler()],
        force=True
    )
    logger = logging.getLogger(__name__)
    logger.info("👀 Flask reloader process (no file logging)")
else:
    # Setup file logging (both dev main process and production)
    handlers = [logging.StreamHandler()]
    
    if is_dev_mode:
        # Development: Timestamped files (one per restart)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        log_file = os.path.join(log_dir, f"{timestamp}.log")
        file_handler = logging.FileHandler(log_file, mode="a", encoding="utf-8")
        log_msg = f"✅ Development logging → {log_file}"
    else:
        # Production: Daily rotating logs
        log_file = os.path.join(log_dir, "recorder_app.log")
        file_handler = TimedRotatingFileHandler(
            log_file,
            when="midnight",
            interval=1,
            backupCount=30,
            encoding="utf-8"
        )
        file_handler.suffix = "%Y-%m-%d"
        log_msg = f"✅ Production logging → {log_file} (daily rotation)"
    
    file_handler.setLevel(logging.INFO)
    file_handler.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] [%(name)s] %(message)s"
    ))
    handlers.append(file_handler)
    
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s",
        handlers=handlers,
        force=True
    )
    
    logger = logging.getLogger(__name__)
    logger.info(log_msg)



# ------------------- DB Utility -------------------
@contextmanager
def db_connection():
    conn = sqlite3.connect(DB, timeout=15)  # ← important!
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def query_db(query, args=(), one=False):
    with db_connection() as conn:
        cur = conn.execute(query, args)
        rows = [dict(row) for row in cur.fetchall()]
        return (rows[0] if rows else None) if one else rows


def execute_db(query, args=()):
    with db_connection() as conn:
        conn.execute(query, args)

def execute_and_return_cursor(query, args=()):
    with db_connection() as conn:
        cur = conn.execute(query, args)
        return cur  # return cursor so caller can get .lastrowid or .rowcount
    
# ------------------- Settings page -------------------
def get_setting(key, default=None):
    row = query_db("SELECT value FROM settings WHERE key = ?", (key,), one=True)
    return row["value"] if row else default

def set_setting(key, value):
    execute_db("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))

settings_api.init(app, get_setting, set_setting, scheduler, daily_jobs, DB)

# Playback page (recorded days, 24-hour slider data, playlists). The helpers are looked up when a request
# arrives, so they can be defined further down this file.
playback_api.init(
    app, get_setting, query_db,
    user_folder=lambda sid: get_user_session_folder(sid),
    needs_transcoding=lambda path: needs_transcoding(path),
)


def update_recording_status_on_schedule_db(source_id, status, msg="", pid=0):
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    execute_db(
        """UPDATE schedules
           SET status     = ?,
               status_msg = ?,
               pid        = ?,
               update_time = ?
           WHERE source_id = ?""",
        (status, msg, pid, now_str, source_id)
    )

# ------------------- Scheduler Logic -------------------
def stop_recording(schedule_data):
    source_id = schedule_data["source_id"]

    with recording_lock:
        info = active_recordings.get(source_id)

        if not info:
            logger.info(f" Recording {source_id} already stopped or not found.")
            #update_recording_status_on_schedule_db( schedule_id, "completed", "Recording already stopped or not found" )
            return

        process = info["process"]
        info["stopping"] = True     # tells ffmpeg_supervisor this exit is on purpose, not a crash

        if process.poll() is None:  # still running
            logger.info(f"Stopping recording for {source_id} at {datetime.now()}")

            try:
                process.terminate()
                process.wait(timeout=10)
                update_recording_status_on_schedule_db( source_id, "completed","Recording stopped successfully")
            except subprocess.TimeoutExpired:
                process.kill()
                update_recording_status_on_schedule_db( source_id, "stop_failed", "Recording force-killed (timeout)")

            logger.info(f" Recording {source_id} stopped successfully.")
        else:
            update_recording_status_on_schedule_db(source_id,"completed","Recording finished" )
            logger.info(f" Recording {source_id} already exited.")

        # Remove from active list
        active_recordings.pop(source_id, None)


# The recording is a straight copy of the camera stream, so it keeps the camera's own picture shape.
# (An earlier version forced sample_aspect_ratio=16/9 here. That is the shape of one PIXEL, not of the
# picture, so a normal 16:9 camera was stored as a 3.2:1 picture and looked stretched in every player.)

def start_recording(schedule_data,multiDay):
    # 1 Same source_id already running → skip
    source_id = schedule_data["source_id"]
    source_url = schedule_data["url"]
    record_folder_name  = schedule_data["record_folder_name"]

    if source_id in active_recordings:
        logger.warning(  f"Recording already running for source_id {source_id}" )
        return
    
    # 2 Same source_url already running → terminate old
    for sid, info in list(active_recordings.items()):
        if info["source_url"] == source_url:
            old_proc = info["process"]
            logger.warning(   f"Duplicate source detected ({source_url}). " f"Terminating old recording (schedule {sid})" )
            try:
                old_proc.terminate()
                old_proc.wait(timeout=5)
            except Exception:
                old_proc.kill()

            del active_recordings[sid]
            break  # only one source should exist     
    
    
    base_folder = get_setting("recording_folder", "RECORD")  # Match command's base folder
    chunk_duration = int(get_setting("chunk_duration", 20))  # Match command's hls_time
    duration = str(chunk_duration)

    # Full path for this source
    source_folder = os.path.join(base_folder, record_folder_name)
    # Ensure base folder exists
    os.makedirs(source_folder, exist_ok=True)



    # Create today's date folder inside source_folder
    now = datetime.now()
    today = now.date()
    tomorrow = today + timedelta(days=1)

    # Always create today's folder (safe)
    today_folder = os.path.join(source_folder, today.strftime("%Y-%m-%d"))
    os.makedirs(today_folder, exist_ok=True)

    # Pre-create tomorrow's folder IF recording ends on or after tomorrow
    if multiDay:
        tomorrow_folder = os.path.join(source_folder, tomorrow.strftime("%Y-%m-%d"))
        os.makedirs(tomorrow_folder, exist_ok=True)
        logging.info(f"Pre-created tomorrow's folder: {tomorrow_folder}")
    

    #cpu recording command
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-y",
        "-timeout", "10000000", #10 sec timeout
        "-analyzeduration", "10000000",
        "-probesize", "10000000",
        "-i", source_url,

        
        
        # Copy streams (no re-encode)
        "-c:v", "copy",
        "-c:a", "copy",

        # HLS settings
        "-f", "hls",
        "-hls_time", duration,
        "-hls_list_size", "0",
        "-hls_playlist_type", "event",
        "-hls_segment_type", "mpegts",
        "-hls_flags", "independent_segments+program_date_time",
        "-reset_timestamps", "1",
        "-strftime", "1",
        "-strftime_mkdir", "1",
        "-hls_segment_filename", f"%Y-%m-%d/{source_id}_{duration}_%H-%M-%S.ts",
        f"{source_id}_playlist.m3u8"
    ]
    
    #GPU recording command
    cmd_gpu_rec = [
        "ffmpeg",
        "-nostdin",
        "-y",
        "-timeout", "5000000",
        "-analyzeduration", "1000000",
        "-probesize", "1000000",
        "-i", source_url,
        "-vf",
        "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:"
        "text='%{localtime}':"
        "fontcolor=white:fontsize=24:box=1:boxcolor=black@0.5:boxborderw=5:"
        "x=10:y=10",

        "-c:v", "h264_nvenc",
        "-preset", "p4",
        "-rc", "vbr",
        "-b:v", "900k",
        "-maxrate", "1100k",
        "-bufsize", "1800k",

        # REMOVED: -vsync cfr  ← this was breaking segment alignment
        
        "-g", "50",                       # ADDED: keyframe every 50 frames (~2s at 25fps)
        "-keyint_min", "50",              # ADDED: minimum keyframe interval (force clean cuts)
        "-sc_threshold", "0",             # ADDED: disable scene-change keyframes (keeps GOP strict)
        "-forced-idr", "1",               # ADDED: force IDR frames at segment boundaries (nvenc specific)

        "-c:a", "aac",
        "-b:a", "128k",
        "-af", "aresample=async=1",

        "-f", "hls",
        "-hls_time", duration,
        "-hls_list_size", "0",
        "-hls_playlist_type", "event",
        "-hls_segment_type", "mpegts",
        "-hls_flags", "independent_segments+program_date_time",
        "-reset_timestamps", "1",
        "-strftime", "1",
        "-strftime_mkdir", "1",
        "-hls_segment_filename", f"%Y-%m-%d/{source_id}_{duration}_%H-%M-%S.ts",
        f"{source_id}_playlist.m3u8"
    ]

    logging.info(f"🎬 Starting HLS recording for {source_url} "
                 f"(s, folder={source_folder})")

    # Run FFmpeg (blocking) with working directory set to source_folder
    #subprocess.run(cmd, cwd=source_folder)
    #logger.info(f"🎥 Recording finished...")
    process = subprocess.Popen(
        cmd,
        cwd=source_folder,
        stdin=subprocess.DEVNULL,   # Prevent waiting for user input
        stdout=subprocess.DEVNULL,  # Optional: discard output
        stderr=subprocess.DEVNULL,   # <— send to null to avoid blocking
        #stderr=subprocess.PIPE,
        text=True,
        close_fds=True,                    # Close all inherited fds
    )

    with recording_lock:
        active_recordings[source_id] = {
            "process": process,
            "source_url": source_url,
            "hls_time": int(duration),
            "output_dir": source_folder,
        }
        recording_schedules[source_id] = (schedule_data, multiDay)  

    update_recording_status_on_schedule_db(source_id,"running","Recording started successfully",pid=process.pid)


# ------------- Apply Settings to cameras that are recording right now -------------
# ffmpeg gets its folder and segment length when it starts, so a camera that is already
# recording keeps the old ones until it is restarted. These two helpers back the
# "Switch now" button on the Settings page.
def recording_config_outdated():
    """Cameras recording right now with an older folder or segment length than the Settings page."""
    base_folder = get_setting("recording_folder", "RECORD")
    chunk_duration = int(get_setting("chunk_duration", 20))
    with recording_lock:
        running = list(active_recordings.items())

    outdated = []
    for source_id, info in running:
        if info["process"].poll() is not None or info.get("stopping"):
            continue
        entry = recording_schedules.get(source_id)
        if not entry:
            continue
        schedule_data = entry[0]
        wanted = os.path.join(base_folder, schedule_data["record_folder_name"])
        folder_changed = os.path.abspath(info["output_dir"]) != os.path.abspath(wanted)
        length_changed = int(info["hls_time"]) != chunk_duration
        if folder_changed or length_changed:
            outdated.append({
                "source_id": source_id,
                "name": schedule_data.get("source_name") or str(source_id),
                "folder_changed": folder_changed,
                "length_changed": length_changed,
            })
    return outdated


def restart_outdated_recordings():
    """Stop and start again every outdated camera (all at the same time, so each is only off for a few seconds)."""
    result = {"restarted": [], "failed": []}
    result_lock = threading.Lock()

    def work(item):
        source_id, name = item["source_id"], item["name"]
        entry = recording_schedules.get(source_id)
        ok = False
        if entry:
            schedule_data, multi_day = entry
            try:
                stop_recording(schedule_data)
                start_recording(schedule_data, multi_day)
                ok = source_id in active_recordings
            except Exception as e:
                logger.error("Could not restart recording for %s: %s", name, e)
        with result_lock:
            result["restarted" if ok else "failed"].append(name)

    threads = [threading.Thread(target=work, args=(item,), daemon=True) for item in recording_config_outdated()]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=90)
    logger.info("Applied settings to running cameras: restarted=%s failed=%s", result["restarted"], result["failed"])
    return result


settings_api.set_recorder(outdated=recording_config_outdated, restart=restart_outdated_recordings)


#--------------------schedule logic--------------------

DAY_INDEX = {
    "mon": 0, "tue": 1, "wed": 2,
    "thu": 3, "fri": 4, "sat": 5, "sun": 6
}
DAY_NAME = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
SECONDS_IN_DAY = 86400
SECONDS_IN_WEEK = 7 * SECONDS_IN_DAY

def time_to_seconds(t):
    h, m, s = map(int, t.split(":"))
    if h == 24:  # 24:00:00 → next day
        return SECONDS_IN_DAY
    return h * 3600 + m * 60 + s

def now_week_seconds():
    now = datetime.now()
    day_idx = now.weekday()  # mon=0 .. sun=6 (matches your DAY_INDEX)
    return day_idx * SECONDS_IN_DAY + (
        now.hour * 3600 + now.minute * 60 + now.second
    )


def build_week_intervals(schedule):
    intervals = []

    for day, ranges in schedule.items():
        base = DAY_INDEX[day] * SECONDS_IN_DAY

        for r in ranges:
            start = base + time_to_seconds(r["from"])
            end = base + time_to_seconds(r["to"])
            intervals.append((start, end))

    return sorted(intervals)

def merge_intervals(intervals):
    if not intervals:
        return []

    merged = [intervals[0]]

    for start, end in intervals[1:]:
        last_start, last_end = merged[-1]

        #  Touching or overlapping → merge
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))

    return merged

def is_full_week(intervals):
    return len(intervals) == 1 and intervals[0] == (0, SECONDS_IN_WEEK)

def re_schedule_recording(re_schedule_data):
    source_id = re_schedule_data["source_id"]
    source_name = re_schedule_data["source_name"]
    schedule = re_schedule_data["schedule_slots"]

    if isinstance(schedule, str):
        schedule = json.loads(schedule)

    logger.info("[RE-SCHEDULE] Updating schedule | source=%s", source_name)

    # ---- Cleanup existing scheduler jobs ----
    for job in scheduler.get_jobs():
        if job.id.startswith(f"start_{source_id}_") or job.id.startswith(f"stop_{source_id}_"):
            scheduler.remove_job(job.id)

    # ---- Build & merge intervals ----
    intervals = build_week_intervals(schedule)
    merged = merge_intervals(intervals)
    now_sec = now_week_seconds()

    # --------------------------------------------------
    # CASE 1: No slots → stop everything
    # --------------------------------------------------
    if not merged:
        logger.info("[RE-SCHEDULE] No slots → stopping | source=%s", source_name)
        if source_id in active_recordings:
            stop_recording(re_schedule_data)
        return

    # --------------------------------------------------
    # CASE 2: 24x7 schedule
    # --------------------------------------------------
    if is_full_week(merged):
        logger.info("[RE-SCHEDULE] 24x7 active | source=%s", source_name)

        if source_id not in active_recordings:
            start_recording(re_schedule_data, multiDay=True)
        else:
            logger.info("[RE-SCHEDULE] Already recording | source=%s", source_name)

        return  # no stop jobs for 24x7

    # --------------------------------------------------
    # CASE 3: Timed schedules
    # --------------------------------------------------
    active_interval = None

    for idx, (start, end) in enumerate(merged):
        start_day = (start // SECONDS_IN_DAY) % 7
        start_sec = start % SECONDS_IN_DAY
        end_day = (end // SECONDS_IN_DAY) % 7
        end_sec = end % SECONDS_IN_DAY

        # Handle 24:00 safely
        if end_sec == SECONDS_IN_DAY:
            end_sec = 0
            end_day = (end_day + 1) % 7

        sh, sm, ss = start_sec // 3600, (start_sec % 3600) // 60, start_sec % 60
        eh, em, es = end_sec // 3600, (end_sec % 3600) // 60, end_sec % 60

        multi_day = start_day != end_day

        # START job
        scheduler.add_job(
            start_recording,
            CronTrigger(day_of_week=start_day, hour=sh, minute=sm, second=ss),
            args=[re_schedule_data, multi_day],
            id=f"start_{source_id}_{idx}",
            replace_existing=True
        )

        # STOP job
        scheduler.add_job(
            stop_recording,
            CronTrigger(day_of_week=end_day, hour=eh, minute=em, second=es),
            args=[re_schedule_data],
            id=f"stop_{source_id}_{idx}",
            replace_existing=True
        )

        logger.info(
            "[RE-SCHEDULE] Slot | source=%s | %s %02d:%02d:%02d → %s %02d:%02d:%02d",
            source_name,
            DAY_NAME[start_day], sh, sm, ss,
            DAY_NAME[end_day], eh, em, es
        )

        # Detect currently active interval
        if start <= now_sec < end:
            active_interval = (end, multi_day)

    # --------------------------------------------------
    # CASE 4: Active slot handling
    # --------------------------------------------------
    if active_interval:
        end_sec, multi_day = active_interval

        if source_id not in active_recordings:
            logger.info("[RE-SCHEDULE] Immediate start | source=%s", source_name)
            start_recording(re_schedule_data, multiDay=multi_day)
        else:
            logger.info("[RE-SCHEDULE] Recording continues | source=%s", source_name)
    else:
        # No active slot → ensure stopped
        if source_id in active_recordings:
            logger.info("[RE-SCHEDULE] Outside slots → stopping | source=%s", source_name)
            stop_recording(re_schedule_data)



def schedule_recording(schedule_data):
    source_id = schedule_data["source_id"]
    schedule = schedule_data["schedule_slots"]

    if isinstance(schedule, str):
        schedule = json.loads(schedule)


    intervals = build_week_intervals(schedule)
    merged = merge_intervals(intervals)

    # 24x7 recording
    if is_full_week(merged):
        logger.info("[SCHEDULER] 24x7 recording started | source=%s", schedule_data["source_name"])
        start_recording(schedule_data,multiDay=True)
        #logger.info("24x7 recording — no stop scheduled")
        return

    now_sec = now_week_seconds()

    for idx, (start, end) in enumerate(merged):
        start_day = (start // SECONDS_IN_DAY) % 7
        start_sec = start % SECONDS_IN_DAY

        end_day = (end // SECONDS_IN_DAY) % 7
        end_sec = end % SECONDS_IN_DAY

        #  Handle 24:00:00 safely
        if end_sec == SECONDS_IN_DAY:
            end_sec = 0
            end_day = (end_day + 1) % 7

        sh = start_sec // 3600
        sm = (start_sec % 3600) // 60
        ss = start_sec % 60

        eh = end_sec // 3600
        em = (end_sec % 3600) // 60
        es = end_sec % 60

        multi_day = start_day != end_day
        logger.info("[SCHEDULER] START | source=%s | day=%s | time=%02d:%02d:%02d | multi_day=%s",schedule_data["source_name"],DAY_NAME[start_day],sh, sm, ss,multi_day)
        scheduler.add_job(
            start_recording,
            CronTrigger(day_of_week=start_day, hour=sh, minute=sm, second=ss),
            args=[schedule_data,multi_day],
            id=f"start_{source_id}_{idx}",
            replace_existing=True
        )

        logger.info("[SCHEDULER] STOP  | source=%s | day=%s | time=%02d:%02d:%02d",schedule_data["source_name"], DAY_NAME[end_day],eh, em, es )
        scheduler.add_job(
            stop_recording,
            CronTrigger(day_of_week=end_day, hour=eh, minute=em, second=es),
            args=[schedule_data],
            id=f"stop_{source_id}_{idx}",
            replace_existing=True
        )

        # immediate start if now is inside interval
        if start <= now_sec < end:
            logger.info("[SCHEDULER] IMMEDIATE START | source=%s (inside active slot)",schedule_data["source_name"])
            start_recording(schedule_data, multiDay=multi_day)


def resume_running_recordings():
    """Load all pending/running schedules and add them to APScheduler. on app startup"""
    execute_db("""
        UPDATE schedules 
        SET status = 'error', status_msg = 'App restarted — will auto-recover'
        WHERE status = 'restarting'
    """)
    
    schedules = query_db("""
        SELECT s.id, s.source_id, s.schedule_slots,
               i.url, i.record_folder_name,i.name AS source_name 
        FROM schedules s
        JOIN input_sources i ON i.id = s.source_id
    """)

    logger.info(f"[STARTUP] Resuming {len(schedules)} schedules...")

    for i, schedule in enumerate(schedules):
        try:
            schedule_recording(schedule)
            logger.info(f"[STARTUP] Scheduled {i+1}/{len(schedules)}: {schedule['source_name']}")
        except Exception as e:
            logger.error(f"[STARTUP] Failed to schedule {schedule['source_name']}: {e}")
        
        # Stagger every channel by 500ms to avoid FFmpeg/DB/socket storm
        time.sleep(0.5)

    logger.info("[STARTUP] All schedules loaded.")

def is_recording_stalled(output_dir, max_idle_sec):
    ts_files = glob.glob(os.path.join(output_dir, "**", "*.ts"), recursive=True)

    if not ts_files:
        return False  # stream may still be starting

    latest_ts = max(ts_files, key=os.path.getmtime)
    age = time.time() - os.path.getmtime(latest_ts)

    return age > max_idle_sec


    """
    Central FFmpeg monitoring loop.

    This function runs as a single background daemon thread and supervises
    all active FFmpeg recording processes stored in `active_recordings`.

    Responsibilities:
    - Periodically checks whether each FFmpeg process is still running.
    - Detects normal completion or unexpected termination using process exit codes.
    - Updates the database with the final recording status (completed / failed).
    - Monitors HLS output (.ts segment creation) as a heartbeat signal.
      If no new segments are written for a defined timeout, the recording is
      considered stalled (e.g., UDP stream freeze) and is forcefully stopped.
    - Cleans up `active_recordings` to prevent stale or orphaned processes.

    Design notes:
    - Uses a single supervisor thread for all recordings to minimize CPU usage.
    - Does NOT block on FFmpeg stdout/stderr.
    - Safe and scalable for dozens of concurrent multicast/UDP streams.
    - Intended to run for the lifetime of the application.

    This supervisor is started once at application startup.
    """
    """
def ffmpeg_supervisor():

    while True:
        time.sleep(2)

        for source_id, info in list(active_recordings.items()):
            proc = info["process"]
            output_dir = info["output_dir"]
            hls_time = info["hls_time"]

            # 1️⃣ Process exited → handle normally
            if proc.poll() is not None:
                exit_code = proc.returncode

                stderr_text = ""
                try:
                    stderr_text = proc.stderr.read() if proc.stderr else ""
                except Exception:
                    pass

                active_recordings.pop(source_id, None)

                if exit_code == 0:
                    status = "completed"
                    msg = "Recording finished normally"
                else:
                    status = "error"
                    msg = f"FFmpeg exited with code {exit_code}"

                update_recording_status_on_schedule_db(
                    source_id, status, msg, pid=0
                )
                continue

            # 2 Process alive → check TS heartbeat
            #max_idle = hls_time * 2 + 5
            #if max_idle < 60:
            #    max_idle = 60

            #if is_recording_stalled(output_dir, max_idle):
            #    proc.kill()
            #    active_recordings.pop(schedule_id, None)

            #    update_recording_status_on_schedule_db(
            #        schedule_id,
            #        "failed",
            #        "Stream stalled (no TS segments written)",
            #        pid=0
            #    )
    """

# ------------------- Flask Routes -------------------
@app.route("/")
def index():
    return render_template("index.html", demo=DEMO)

@app.route("/api/cameras", methods=["GET", "POST", "DELETE"])
def api_cameras():
    if request.method == "GET":
        cameras = query_db("SELECT * FROM input_sources ORDER BY id")
        for source in cameras:
            active_schedules = query_db(
                "SELECT status, status_msg FROM schedules WHERE source_id = ?",
                (source['id'], )
            )
            if active_schedules:
                source['current_status'] = active_schedules[0]['status']
                source['status_msg'] = active_schedules[0]['status_msg']
            else:
                source['current_status'] = 'Not Scheduled'
                source['status_msg'] = ''
        return jsonify(cameras)

    if request.method == "POST":
        data = request.get_json()
        name = data["name"]
        url = data["url"]
        sub_url = (data.get("sub_url") or "").strip()   # optional low-resolution stream for live tiles

        # Sanitize name for folder creation (keep alphanumeric, underscore, dash)
        safe_name = re.sub(r'[^A-Za-z0-9_-]', '', name.strip())
        if not safe_name:
            return jsonify({"error": "The name needs at least one letter or number."}), 400
        if query_db("SELECT 1 FROM input_sources WHERE LOWER(record_folder_name) = ?", (safe_name.lower(),), one=True):
            return jsonify({"error": f'A camera with the recording folder "{safe_name}" already exists. Use a different name.'}), 400

        # Insert first to get ID (so we can use it in folder name)
        cur = execute_and_return_cursor("INSERT INTO input_sources (name, record_folder_name, url, sub_url) VALUES (?, ?, ?, ?)",(name, "", url, sub_url), )
        new_id = cur.lastrowid

        # Build record folder name using id and safe_name
        record_folder_name = safe_name
        # Update the record with folder name
        execute_db( "UPDATE input_sources SET record_folder_name = ? WHERE id = ?",(record_folder_name, new_id), )

        go2rtc_client.register_source(new_id, url, sub_url)   # live view (no-op if go2rtc is not running)
        logger.info(f"➕ Camera added: id={new_id}, name={name}, folder={record_folder_name}")
        return jsonify({"status": "added", "id": new_id, "record_folder_name": record_folder_name})



    if request.method == "DELETE":
        sid = request.args.get("id", type=int)
        execute_db("DELETE FROM input_sources WHERE id = ?", (sid,))
        go2rtc_client.remove_source(sid)
        logger.info(f"🗑️ Camera deleted: id={sid}")
        return jsonify({"status": "deleted", "id": sid})


@app.route("/api/cameras/<int:source_id>", methods=["PUT"])
def api_update_camera(source_id):
    """Edit a camera's name / address / low-quality stream. The recording folder never changes."""
    row = query_db("SELECT * FROM input_sources WHERE id = ?", (source_id,), one=True)
    if not row:
        return jsonify({"error": "Camera not found"}), 404

    data = request.get_json() or {}
    name = (data.get("name") or "").strip()
    url = (data.get("url") or "").strip()
    sub_url = (data.get("sub_url") or "").strip()
    if not name or not url:
        return jsonify({"error": "Name and camera address are required"}), 400

    execute_db("UPDATE input_sources SET name = ?, url = ?, sub_url = ? WHERE id = ?",
               (name, url, sub_url, source_id))
    go2rtc_client.register_source(source_id, url, sub_url)     # live view picks up the new address

    # Address changed while a schedule exists -> restart the recording on the new address
    if url != row["url"]:
        sched = query_db("""
            SELECT s.source_id, s.schedule_slots, i.url, i.record_folder_name, i.name AS source_name
            FROM schedules s JOIN input_sources i ON i.id = s.source_id
            WHERE s.source_id = ?
        """, (source_id,), one=True)
        if sched:
            try:
                if source_id in active_recordings:
                    stop_recording(sched)
                recording_schedules.pop(source_id, None)     # drop the copy that still holds the old address
                re_schedule_recording(sched)
            except Exception as exc:
                logger.error(f"Could not restart recording for camera {source_id}: {exc}")

    logger.info(f"✏️ Camera updated: id={source_id}, name={name}")
    return jsonify({"status": "updated", "id": source_id})


_TEST_SCHEMES = ("rtsp://", "rtsps://", "rtmp://", "http://", "https://", "udp://", "rtp://", "srt://", "tcp://")

def _friendly_probe_error(text, url):
    text = (text or "").replace(url, "<address>")
    low = text.lower()
    if "401" in low or "unauthorized" in low:
        return "Wrong user name or password."
    if "404" in low or "not found" in low:
        return "The camera answered, but that stream path was not found. Check the end of the address."
    if "refused" in low:
        return "Connection refused. Check the IP address and port."
    if "timed out" in low or "timeout" in low:
        return "The camera did not answer in time. Check the IP address and that it is reachable."
    if "no route" in low or "unreachable" in low or "name or service" in low or "getaddrinfo" in low:
        return "Could not find that address on the network."
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    return (lines[-1] if lines else "No video found at that address.")[:200]


@app.route("/api/cameras/test", methods=["POST"])
def api_camera_test():
    """Open the stream for a few seconds and report codec / size / fps (nothing is saved)."""
    url = ((request.get_json(silent=True) or {}).get("url") or "").strip()
    if not url.lower().startswith(_TEST_SCHEMES):
        return jsonify({"ok": False, "error": "The address should start with rtsp://"})

    cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-select_streams", "v:0", "-show_streams"]
    if url.lower().startswith(("rtsp://", "rtsps://")):
        cmd += ["-rtsp_transport", "tcp", "-timeout", "8000000"]
    cmd += ["-i", url]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "The camera did not answer in time."})
    except FileNotFoundError:
        return jsonify({"ok": False, "error": "ffprobe is not installed or not on PATH."})

    try:
        streams = json.loads(res.stdout or "{}").get("streams") or []
    except ValueError:
        streams = []
    if res.returncode != 0 or not streams:
        return jsonify({"ok": False, "error": _friendly_probe_error(res.stderr, url)})

    st = streams[0]
    fps = None
    try:
        num, den = (st.get("avg_frame_rate") or "0/1").split("/")
        if float(den) and float(num):
            fps = round(float(num) / float(den))
    except (ValueError, ZeroDivisionError):
        pass
    return jsonify({"ok": True, "codec": st.get("codec_name"), "width": st.get("width"),
                    "height": st.get("height"), "fps": fps})


@app.route("/api/schedules/<int:source_id>", methods=["GET", "POST"])
def api_schedule_for_source(source_id):

    if request.method == "GET":
        row = query_db("""
            SELECT schedule_slots
            FROM schedules
            WHERE source_id = ?
        """, [source_id], one=True)

        if not row or not row["schedule_slots"]:
            return jsonify({})  # no saved schedule

        return jsonify(json.loads(row["schedule_slots"]))

    if request.method == "POST":
        data = request.json

        query_db("""
            INSERT INTO schedules (source_id, schedule_slots, status)
            VALUES (?, ?, 'active')
            ON CONFLICT(source_id)
            DO UPDATE SET schedule_slots=excluded.schedule_slots
        """, [source_id, json.dumps(data)])


        #  Fetch updated schedule with source info
        schedule_data = query_db("""
            SELECT s.source_id, s.schedule_slots,
                   i.url, i.record_folder_name, i.name AS source_name
            FROM schedules s
            JOIN input_sources i ON i.id = s.source_id
            WHERE s.source_id = ?
        """, [source_id], one=True)

        #  Re-schedule immediately
        re_schedule_recording(schedule_data)

        return jsonify({"status": "ok"})

#not using this now
'''
@app.route("/api/schedules", methods=["GET", "POST", "DELETE"])
def api_schedules():
    if request.method == "GET":
        rows = query_db("""
            SELECT s.id, s.source_id, i.name as source_name, 
                   s.schedule_slots, s.status
            FROM schedules s
            JOIN input_sources i ON i.id = s.source_id
        """)
        return jsonify(rows)
    if request.method == "POST":
        data = request.get_json()
        cur = execute_and_return_cursor(
                "INSERT INTO schedules (source_id, status, pid) VALUES ( ?, ?, ?)",
                (data["source_id"],  "pending", 0)
        )
        new_id = cur.lastrowid
        # add job to schedule 
        job = {
            "id": new_id,
            "source_id": data["source_id"],
            "start_datetime": data["start_datetime"],
            "end_datetime": data["end_datetime"],
            "url": query_db("SELECT url FROM input_sources WHERE id=?", [data["source_id"]])[0]["url"],
            "record_folder_name": query_db("SELECT record_folder_name FROM input_sources WHERE id=?", [data["source_id"]])[0]["record_folder_name"]
        }
        add_recording_job(job)

        logger.info(f"📅 Schedule added: id={new_id}, source_id={data['source_id']}, {data['start_datetime']} → {data['end_datetime']}")
        return jsonify({"status": "added", "id": new_id})
    
    if request.method == "DELETE":
        sid = request.args.get("id", type=int)
        source_id = request.args.get("source_id", type=int)
        delete_all_flag = request.args.get("all") == "true"   # ← new line


        if delete_all_flag:                          # ← check here
            # Remove all scheduled jobs
            rows = query_db("SELECT id FROM schedules")
            for row in rows:
                for job_type in ["start", "stop"]:
                    job_id = f"{job_type}_{row['id']}"
                    if scheduler.get_job(job_id):
                        scheduler.remove_job(job_id)
                        logger.info(f"🧹 Removed scheduled job: {job_id}")

            execute_db("DELETE FROM schedules")

            logger.warning("💥 ALL schedules have been deleted!")
            return jsonify({"status": "deleted", "message": "All schedules removed"})
        
        elif sid:
            # ── Delete single schedule ──────────────────────
            for job_type in ["start", "stop"]:
                job_id = f"{job_type}_{sid}"
                if scheduler.get_job(job_id):
                    scheduler.remove_job(job_id)
                    logger.info(f"🧹 Removed scheduled job: {job_id}")

            execute_db("DELETE FROM schedules WHERE id = ?", (sid,))

            logger.info(f"🗑️ Schedule deleted: id={sid}")
            return jsonify({"status": "deleted", "id": sid})

        elif source_id:
            # ── Delete all schedules for source ─────────────
            rows = query_db(
                "SELECT id FROM schedules WHERE source_id = ?",
                (source_id,)
            )

            for row in rows:
                for job_type in ["start", "stop"]:
                    job_id = f"{job_type}_{row['id']}"
                    if scheduler.get_job(job_id):
                        scheduler.remove_job(job_id)
                        logger.info(f"🧹 Removed scheduled job: {job_id}")

            execute_db(
                "DELETE FROM schedules WHERE source_id = ?",
                (source_id,)
            )

            logger.info(f"🗑️ All schedules deleted for source_id={source_id}")
            return jsonify({"status": "deleted", "source_id": source_id})

        else:
            return jsonify({"error": "Missing id or source_id"}), 400

'''
# ------------------- Live view (go2rtc) -------------------
@app.route("/api/live/config")
def api_live_config():
    """Tell the browser whether live view is available and where go2rtc is reachable."""
    host = request.host.split(":")[0] if not request.host.startswith("[") else request.host.split("]")[0] + "]"
    return jsonify({
        "available": go2rtc_client.is_up(),
        "base": f"http://{host}:{go2rtc_client.PUBLIC_PORT}",
        "demo": DEMO,
    })


@app.route("/api/live/sync", methods=["POST"])
def api_live_sync():
    """Re-register every camera with go2rtc (e.g. after restarting it)."""
    rows = query_db("SELECT id, url, sub_url FROM input_sources")
    done = sum(1 for r in rows if go2rtc_client.register_source(r["id"], r["url"], r.get("sub_url") or ""))
    return jsonify({"registered": done, "total": len(rows)})


# /api/settings (+ folder check, storage, system) lives in settings_api.py

# ------------------- Recordings API and Serving -------------------


def get_video_codec(ts_file_path):
    """Detect video codec of a TS file using ffprobe"""
    try:
        result = subprocess.check_output([
            'ffprobe', '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            ts_file_path
        ]).decode().strip()
        return result
    except subprocess.CalledProcessError:
        return None

def needs_transcoding(ts_file_path):
    """Check if file needs transcoding (MPEG-2)"""
    codec = get_video_codec(ts_file_path)
    if codec:
        # Split multiple lines and strip each
        codec_list = [c.strip() for c in codec.splitlines()]
    else:
        codec_list = []

    logger.info(f"Video Codec for file {ts_file_path} = {codec_list}")

    # Return True if any of the codecs is MPEG-2
    return any(c in ['mpeg2video', 'mpeg2'] for c in codec_list)

# To DO
# to improve the playlist generation time, use the duration on the filename itself, but cross verify ffprobe also give same.

def parse_duration_from_filename(ts_file: str):
    """
    Extract duration (in seconds) from filename like: 1_10_07-01-21.ts
    Returns float seconds or None if not parseable
    """
    # Match pattern: anything_duration_timestamp.ts
    match = re.search(r'_(\d+)_[\d-]+\.ts$', ts_file)
    if match:
        try:
            return float(match.group(1))
        except ValueError:
            return None
    return None

def get_segment_duration(full_path: Path, ts_file: str, use_filename=True):
    """
    Get duration of a .ts segment.
    Priority:
      1. Parse from filename (fast)   → if use_filename=True and format matches
      2. Fall back to ffprobe (accurate but slow)
    """
    if use_filename:
        duration = parse_duration_from_filename(ts_file)
        if duration is not None:
            return duration  # Success: fast path!

    # Fallback: use ffprobe
    try:
        result = subprocess.check_output(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', str(full_path)],
            stderr=subprocess.DEVNULL
        ).decode().strip()
        if result:
            return float(result)
    except Exception as e:
        logger.warning(f"ffprobe failed for {ts_file}: {e}")

    # Final fallback: assume 10 seconds (common for HLS)
    logger.warning(f"Could not determine duration for {ts_file}, assuming 10s")
    return 10.0

def generate_m3u8(date_folder_path, files, output_m3u8, thumbnail_path,rec_session_id):
    start_time = time.time()

    # Sort files by timestamp in filename (HH-MM-SS)
    # Format: session_duration_HH-MM-SS.ts
    def extract_time(f):
        try:
            parts = f.split('_')
            time_part = parts[2].replace('.ts', '')  # 3rd part = HH-MM-SS
            return datetime.strptime(time_part, '%H-%M-%S')
        except Exception:
            return datetime.min

    files = sorted(files, key=extract_time)

    from_time = None
    to_time = None
    transcode = False
    

    if files:
        try:
            first_time = extract_time(files[0])
            last_time = extract_time(files[-1])
            from_time = first_time.strftime('%H:%M:%S')
            to_time = last_time.strftime('%H:%M:%S')
        except Exception as e:
            logger.warning(f"Failed to parse from/to time for session {rec_session_id}: {e}")

        # Check first file for codec info
        first_ts_path = os.path.join(date_folder_path, files[0])
        if os.path.exists(first_ts_path):
            try:
                transcode = needs_transcoding(first_ts_path)
                logger.info(f"Session {rec_session_id}: Transcode needed = {transcode}")
            except Exception as e:
                logger.error(f"Error checking codec for {first_ts_path}: {e}")
                transcode = False

    # === Generate thumbnail from first file ===
   
    ''' if not os.path.exists(thumbnail_path) and files:
        first_ts_path = os.path.join(date_folder_path, files[0])
        try:
            subprocess.run([
                'ffmpeg', '-i', first_ts_path,
                '-ss', '00:00:01', '-vframes', '1',
                '-q:v', '2', '-y', thumbnail_path
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            logger.info(f"Generated thumbnail: {thumbnail_path}")
        except subprocess.CalledProcessError:
            logger.error(f"Failed to generate thumbnail for session {rec_session_id}")
    '''
    route_prefix = "/recordings_rout"

    max_duration = 1.0
    segment_lines = []
    recording_folder = get_setting("recording_folder", "RECORD")
    recording_root = Path(recording_folder)
  
    # === Generate the M3U8 playlist ===
    with open(output_m3u8, 'w') as m3u8:
      
        for ts_file in files:
            #rel_path = (Path(date_folder_path) / ts_file).relative_to(recording_root)
            full_path = Path(date_folder_path) / ts_file
            rel_path = full_path.relative_to(recording_root)
            segment_url = f"/recordings_rout/{rel_path.as_posix()}"
            try:
                duration = get_segment_duration(full_path, ts_file, use_filename=False)
                if duration > max_duration:
                    max_duration = duration
                
                segment_lines.append(f'#EXTINF:{duration:.3f},\n{segment_url}\n')
            except Exception as e:
                logger.error(f"Error processing {ts_file}: {e}")
                continue

        target_duration = math.ceil(max_duration)            
        # ✅ Write headers AFTER knowing target duration
        m3u8.write('#EXTM3U\n')
        m3u8.write('#EXT-X-VERSION:3\n')
        m3u8.write(f'#EXT-X-TARGETDURATION:{target_duration}\n')
        m3u8.write('#EXT-X-MEDIA-SEQUENCE:0\n')
        m3u8.write('#EXT-X-PLAYLIST-TYPE:VOD\n')

																																																																																																																																																																																																																																																																																																																																						
        # Write segments
        for line in segment_lines:
            m3u8.write(line)

        m3u8.write('#EXT-X-ENDLIST\n')

    elapsed = time.time() - start_time
    logger.info(f"Generated {output_m3u8} in {elapsed:.2f} seconds")

   
    return from_time, to_time, transcode

@app.route("/recordings_rout/<path:filename>")
def serve_recording(filename):
    # Security
    if ".." in filename:
        return "Invalid path", 400

    project_root = Path.cwd()
    recording_root = Path(get_setting("recording_folder", "RECORD"))

    # 1️⃣ If playlist / temp file → project directory
    project_path = project_root / filename
    if project_path.exists():
        return send_from_directory(project_path.parent, project_path.name)

    # 2️⃣ Else → real recordings folder
    recording_path = recording_root / filename
    if recording_path.exists():
        return send_from_directory(recording_path.parent, recording_path.name)

    # 3️⃣ Not found
    logger.warning(f"Recording not found: {filename}")
    return "File not found", 404


def serve_transcoded_playlist(full_path, filename):
    """Modify m3u8 playlist to add transcode parameter to .ts files"""
    with open(full_path, 'r') as f:
        content = f.read()
    
    # Get the directory path from filename for proper .ts file paths
    dir_path = os.path.dirname(filename)
    
    lines = content.split('\n')
    modified_lines = []
    
    for line in lines:
        if line.strip().endswith('.ts'):
            # Add transcode parameter to .ts file references
            modified_lines.append(f"{line}?transcode=true")
        else:
            modified_lines.append(line)
    
    return '\n'.join(modified_lines), 200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache'
    }

def transcode_and_stream(ts_file_path):
    """Transcode MPEG-2 to H.264 on-the-fly and stream"""
    logging.info(f"Transcoding and streaming file -------{ts_file_path}")
    def generate():
        process = subprocess.Popen([
            'ffmpeg',
            '-i', ts_file_path,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-f', 'mpegts',
            '-'
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        
        try:
            while True:
                chunk = process.stdout.read(8192)
                if not chunk:
                    break
                yield chunk
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
    
    return app.response_class(
        generate(),
        mimetype='video/mp2t',
        headers={
            'Cache-Control': 'no-cache',
            'Content-Type': 'video/mp2t'
        }
    )
    
@app.route("/api/recording_slots", methods=["GET"])
def api_recording_slots():
    """Generate 1-hour max continuous recording slots for given source/date."""
    logging.info("=== /api/recording_slots called ===")

    recording_folder = get_setting("recording_folder", "RECORD")
    source_filter = request.args.get("source")
    date_filter = request.args.get("date")
    user_session_id = request.args.get("session_id")

    if not source_filter or not date_filter:
        return jsonify({"error": "Missing source or date"}), 400

    date_folder = os.path.join(recording_folder, source_filter, date_filter)
    if not os.path.exists(date_folder):
        return jsonify({"error": "Date folder not found"}), 404

    # Find all .ts files
    all_ts_files = [f for f in os.listdir(date_folder) if f.endswith('.ts')]
    if not all_ts_files:
        logging.info("No .ts files found")
        return jsonify([])

    # Example filename pattern: 1_300_00-00-00.ts  (sessionId_duration_HH-MM-SS.ts)
    pattern = re.compile(r"(\d+)_(\d+)_([\d-]+)\.ts")
    parsed_files = []

    for f in all_ts_files:
        m = pattern.match(f)
        if not m:
            continue
        session_id, duration, time_str = m.groups()
        try:
            t = datetime.strptime(time_str, "%H-%M-%S")
            seconds = t.hour * 3600 + t.minute * 60 + t.second
            parsed_files.append((f, int(session_id), int(duration), seconds))
        except ValueError:
            continue

    if not parsed_files:
        logging.info("No valid parsed files")
        return jsonify([])

    # Sort by start time (seconds)
    parsed_files.sort(key=lambda x: x[3])

    # --- Group into 1-hour slots ---
    MAX_SLOT_DURATION = 3600/2  # 1/2 hour
    GAP_THRESHOLD = 60        # 1 min gap breaks continuity

    result = []
    slot_start = None
    slot_end = None

    last_end = None

    for fname, session_id, duration, start_sec in parsed_files:
        end_sec = start_sec + duration

        if slot_start is None:
            # start first slot
            slot_start = start_sec
            slot_end = end_sec
            last_end = end_sec
            continue

        gap = start_sec - last_end

        # If gap > 1 min OR slot would exceed 1 hour → close current slot
        if gap > GAP_THRESHOLD or (end_sec - slot_start) > MAX_SLOT_DURATION:
            result.append({
                "from_sec": slot_start,
                "to_sec": min(slot_start + MAX_SLOT_DURATION, slot_end),
                "source": source_filter,
                "date":date_filter
                
            })
            # start new slot
            slot_start = start_sec
            slot_end = end_sec
        else:
            # extend current slot
            slot_end = end_sec

        last_end = end_sec

    # Add last slot if exists
    if slot_start is not None:
        result.append({
            "from_sec": slot_start,
            "to_sec": min(slot_start + MAX_SLOT_DURATION, slot_end),
            "source": source_filter,
            "date":date_filter

        })

    logging.info(f"Generated {len(result)} slots for {source_filter} {date_filter}")
    return jsonify(result)

@app.route("/api/recordings", methods=["GET"])
def api_recordings():
    """List recordings filtered by source, date, and optional time range."""
    logging.info("=== /api/recordings called ===")

    recording_folder = get_setting("recording_folder", "RECORD")
    source_filter = request.args.get("source")
    date_filter = request.args.get("date")
    from_sec = request.args.get("from", type=int)
    to_sec = request.args.get("to", type=int)
    user_session_id = request.args.get("session_id")  

    logging.info(f"Params: source={source_filter}, date={date_filter}, from={from_sec}, to={to_sec}")

    if not source_filter or not date_filter:
        logging.warning("Missing source or date")
        return jsonify({"error": "Missing source or date"}), 400

    date_folder = os.path.join(recording_folder, source_filter, date_filter)
    if not os.path.exists(date_folder):
        logging.warning(f"Date folder not found: {date_folder}")
        return jsonify({"error": "Date folder not found"}), 404
    
    # ---- user-specific temp folder ----
    user_folder = get_user_session_folder(user_session_id)

    all_ts_files = [f for f in os.listdir(date_folder) if f.endswith('.ts')]
    if not all_ts_files:
        logging.info("No .ts files found")
        return jsonify([])

    # Parse filenames of format: session_duration_HH-MM-SS.ts
    pattern = re.compile(r"(\d+)_(\d+)_([\d-]+)\.ts")
    parsed_files = []

    for f in all_ts_files:
        m = pattern.match(f)
        if not m:
            continue
        rec_session_id, duration, time_str = m.groups()
        try:
            t = datetime.strptime(time_str, "%H-%M-%S")
            parsed_files.append((f, rec_session_id, int(duration), t))
        except ValueError:
            continue

    if not parsed_files:
        logging.info("No parsed_files found")
        return jsonify([])

    # Sort by time
    parsed_files.sort(key=lambda x: x[3])

    # Determine time window
    if from_sec is None:
        from_sec = 0
    if to_sec is None:
        to_sec = 24 * 3600

    logging.info(f"Filtering between {from_sec}s and {to_sec}s of the day")

    # Filter files within range. Compared as seconds of the day: comparing clock times broke when the
    # range ended at midnight (to=86400), which matched nothing.
    def _sec_of_day(t):
        return t.hour * 3600 + t.minute * 60 + t.second

    filtered_files = [
        f for f, rec_session_id, dur, t in parsed_files
        if from_sec <= _sec_of_day(t) <= to_sec
    ]

    if not filtered_files:
        logging.info("No files found in selected range")
        return jsonify([])

    # Take rec_session_id from the first file (or remove grouping logic if not needed)
    rec_session_id = parsed_files[0][1]

    # Playlist and thumbnail paths
    output_m3u8      = user_folder / f"{user_session_id}_playlist.m3u8"
    output_thumbnail = os.path.join(date_folder, f"{rec_session_id}_thumbnail.jpg")

    # Generate playlist
    try:
        from_time, to_time, transcode = generate_m3u8(date_folder, filtered_files, output_m3u8, output_thumbnail, rec_session_id)
    except Exception as e:
        logging.error(f"Failed to generate playlist: {e}")
        return jsonify({"error": "Failed to generate playlist"}), 500

    logging.info(f"Generated playlist: {output_m3u8}")

    project_root = Path.cwd()

    # Playlist: user_data/... → inside project_root
    rel_m3u8 = Path(output_m3u8).relative_to(project_root).as_posix()
    playlist_url = f"/recordings_rout/{rel_m3u8}"

  
    
    result = [{
        "playlist_url": playlist_url,
        #"thumbnail_url": thumbnail_url,
        "from_time": from_time,
        "to_time": to_time,
        "transcode": transcode
    }]

    return jsonify(result)

@app.route("/api/download_video", methods=["GET"])
def api_download_video():
    """
    Download combined video (MP4) for a given source, date, and time range.
    Concatenates matching .ts files without re-encoding.
    If the total duration exceeds the requested range, trims the last segment.
    """
    logging.info("=== /api/download_video called ===")

    recording_folder = get_setting("recording_folder", "RECORD")
    source_filter = request.args.get("source")
    date_filter = request.args.get("date")
    from_sec = request.args.get("from", type=int)
    to_sec = request.args.get("to", type=int)
    user_session_id = request.args.get("session_id")  
    logging.info(f"from_sec={from_sec}  to_sec={to_sec}")

    if not source_filter or not date_filter:
        return jsonify({"error": "Missing source or date"}), 400

    date_folder = os.path.join(recording_folder, source_filter, date_filter)
    if not os.path.exists(date_folder):
        return jsonify({"error": "Date folder not found"}), 404

    all_ts_files = [f for f in os.listdir(date_folder) if f.endswith(".ts")]
    if not all_ts_files:
        return jsonify({"error": "No TS files found"}), 404

    # File pattern: session_duration_HH-MM-SS.ts
    pattern = re.compile(r"(\d+)_(\d+)_([\d-]+)\.ts")
    parsed_files = []
    for f in all_ts_files:
        m = pattern.match(f)
        if not m:
            continue
        rec_session_id, duration, time_str = m.groups()
        try:
            t = datetime.strptime(time_str, "%H-%M-%S")
            start_sec = t.hour * 3600 + t.minute * 60 + t.second
            parsed_files.append((f, rec_session_id, int(duration), t, start_sec))
        except ValueError:
            continue

    if not parsed_files:
        return jsonify({"error": "No valid TS files found"}), 404

    parsed_files.sort(key=lambda x: x[4])  # Sort by start_sec (cumulative seconds from day start)

    if from_sec is None:
        from_sec = 0
    if to_sec is None:
        to_sec = 24 * 3600

    target_duration = to_sec - from_sec
    if target_duration <= 0:
        return jsonify({"error": "Invalid time range"}), 400

    rec_session_id = parsed_files[0][1]  # Assume shared across files

    selected_files = []  # List of (concat_path: str, clip_dur: int, is_temp: bool)
    total_duration = 0
    user_folder_path = Path(get_user_session_folder(user_session_id))

    for f, _, dur, t, file_start_sec in parsed_files:
        file_end_sec = file_start_sec + dur

        # Skip segments entirely before the requested range
        if file_end_sec <= from_sec:
            continue

        # No more overlap possible after this
        if file_start_sec >= to_sec:
            break

        overlap_start_sec = max(file_start_sec, from_sec)
        overlap_end_sec = min(file_end_sec, to_sec)
        if overlap_start_sec >= overlap_end_sec:
            continue

        seek_sec = overlap_start_sec - file_start_sec
        clip_dur = overlap_end_sec - overlap_start_sec

        input_path = os.path.join(date_folder, f)

        # Full segment (no trim needed)?
        if seek_sec == 0 and clip_dur == dur:
            concat_path = input_path
            is_temp = False
        else:
            # Trim to temp .ts (fast, no re-encode)
            temp_ts = user_folder_path / f"tmp_clip_{f}"
            cmd_trim = ["ffmpeg", "-y"]
            if seek_sec > 0:
                cmd_trim += ["-ss", str(seek_sec)]
            cmd_trim += ["-i", input_path]
            if clip_dur < dur: #if clip_dur < dur - seek_sec:
                cmd_trim += ["-t", str(clip_dur)]
            cmd_trim += ["-c", "copy", str(temp_ts)]

            logging.info(f"Trimming segment: {' '.join(cmd_trim)}")
            result = subprocess.run(cmd_trim, capture_output=True, text=True)
            if result.returncode != 0:
                logging.error(f"Failed to trim segment: {result.stderr}")
                return jsonify({"error": "Failed to trim segment", "details": result.stderr}), 500

            concat_path = str(temp_ts)
            is_temp = True

        selected_files.append((concat_path, clip_dur, is_temp))
        total_duration += clip_dur

    if not selected_files:
        return jsonify({"error": "No files in given time range"}), 404

    # Create concat list
    output_mp4 = user_folder_path / f"{source_filter}_{date_filter}_{from_sec}-{to_sec}.mp4"
    concat_list_path = os.path.join(date_folder, f"{rec_session_id}_concat_list.txt")
    with open(concat_list_path, "w", encoding="utf-8") as concat_file:
        for concat_path, _, _ in selected_files:
            abs_path = os.path.abspath(concat_path)
            concat_file.write(f"file '{Path(abs_path).as_posix()}'\n")

    # How the MP4 is made. Cameras that send H.264 (almost all IP cameras) are simply copied into an MP4:
    # instant and lossless, and it works on every computer. Other codecs (MPEG-2 from TV / multicast sources)
    # are converted to H.264 so browsers can play the file: on an NVIDIA GPU when there is one, else on the CPU.
    def _concat_cmd(video_args, audio_args):
        return ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list_path,
                "-map", "0:v:0", "-map", "0:a?", *video_args, *audio_args,
                "-movflags", "+faststart", str(output_mp4)]

    cmd_concat_copy = _concat_cmd(["-c:v", "copy"], ["-c:a", "copy"])
    cmd_concat_gpu = _concat_cmd(["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0"],
                                 ["-c:a", "aac"])
    cmd_concat_cpu = _concat_cmd(["-c:v", "libx264", "-preset", "fast", "-crf", "23"], ["-c:a", "aac"])

    try:
        convert_first = needs_transcoding(selected_files[0][0])
    except Exception:
        convert_first = False
    attempts = ([("GPU", cmd_concat_gpu), ("CPU", cmd_concat_cpu)] if convert_first
                else [("copy", cmd_concat_copy), ("GPU", cmd_concat_gpu), ("CPU", cmd_concat_cpu)])

    result = None
    for how, cmd_concat in attempts:
        logging.info(f"Running FFmpeg concat ({how}): {' '.join(cmd_concat)}")
        result = subprocess.run(cmd_concat, capture_output=True, text=True)
        if result.returncode == 0:
            break
        logging.warning(f"FFmpeg concat ({how}) failed, trying the next way: {result.stderr[-300:]}")
    if result is None or result.returncode != 0:
        logging.error(f"FFmpeg concat failed: {result.stderr}")
        return jsonify({"error": "Failed to create MP4", "details": result.stderr}), 500

    # Clean up temp clips (concat list cleaned below)
    for concat_path, _, is_temp in selected_files:
        if is_temp:
            try:
                os.remove(concat_path)
            except OSError:
                pass

    try:
        os.remove(concat_list_path)
    except OSError:
        pass

    # Timestamps for response (absolute day times)
    day_start = datetime.strptime("00-00-00", "%H-%M-%S")
    from_dt = day_start + timedelta(seconds=from_sec)
    actual_end_sec = from_sec + total_duration
    to_dt = day_start + timedelta(seconds=actual_end_sec)

    # Build download URL relative to project root
    project_root = Path.cwd()
    rel_mp4 = output_mp4.relative_to(project_root).as_posix()
    download_url = f"/recordings_rout/{rel_mp4}"

    return jsonify({
        "download_url": download_url,
        "from_time": from_dt.strftime("%H:%M:%S"),
        "to_time": to_dt.strftime("%H:%M:%S"),
        "file_count": len(selected_files),
        "final_duration_sec": total_duration
    })

USER_DATA_ROOT = Path.cwd() / "user_data"  
def get_user_session_folder(session_id: str) -> Path:
    if not session_id:
        raise ValueError("session_id is required")
    folder = USER_DATA_ROOT / session_id
    folder.mkdir(parents=True, exist_ok=True)
    return folder


@app.route("/api/system_stats")
def system_stats():
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    # System stats (unchanged)
    cpu = psutil.cpu_percent(interval=0.3)
    ram = psutil.virtual_memory().percent
    record_folder = get_setting("recording_folder", "RECORD") 
    disk = shutil.disk_usage(_nearest_existing(record_folder))   # works before the first recording exists
    disk_total = disk.total
    disk_used = disk.used
    
    disk_percent = round((disk_used / disk_total) * 100, 1) if disk_total else 0.0
    net = psutil.net_io_counters()
    #upload_mb = round(net.bytes_sent / 1024 / 1024, 2)
    #download_mb = round(net.bytes_recv / 1024 / 1024, 2)
    upload_gb = round(net.bytes_sent / 1024**3, 2)
    download_gb = round(net.bytes_recv / 1024**3, 2)

    # Get active recordings (running + error)
    active_sources = query_db("""
        SELECT 
            i.name,
            s.status,
            s.status_msg
        FROM schedules s
        JOIN input_sources i ON s.source_id = i.id
        WHERE s.status IN ('running', 'error')
        ORDER BY s.status, i.name
    """)

    # Count summary
    running_count = sum(1 for s in active_sources if s['status'].lower() == 'running')
    error_count = sum(1 for s in active_sources if s['status'].lower() == 'error')

    return jsonify({
        "cpu": cpu,
        "ram": ram,
        "disk_percent": disk_percent,
        "disk_free_gb": round((disk_total - disk_used) / 1024**3, 1),
        "disk_total_gb": round(disk_total / 1024**3, 1),
         "upload_gb": upload_gb,
         "download_gb": download_gb,
        
        # New fields for recording status
        "recording_summary": {
            "running": running_count,
            "error": error_count,
            "total_active": running_count + error_count
        },
        "active_sources": active_sources  # list of {name, status, status_msg}
    })


# -------- Run DB init if needed --------
if not os.path.exists(DB):
    logger.info("Database not found — creating %s", DB)
    os.makedirs(os.path.dirname(os.path.abspath(DB)), exist_ok=True)
    init_db(DB, recording_folder=f"{DEMO_DIR}/RECORD" if DEMO else "RECORD")

# -------- Small schema migration for databases created before live view existed --------
def migrate_db():
    cols = [r["name"] for r in query_db("PRAGMA table_info(input_sources)")]
    if "sub_url" not in cols:
        execute_db("ALTER TABLE input_sources ADD COLUMN sub_url TEXT DEFAULT ''")
        logger.info("Database migrated: added input_sources.sub_url")

migrate_db()


def _nearest_existing(path):
    """The folder itself, or the closest parent that exists (disk statistics need a real path)."""
    p = Path(path).expanduser().resolve()
    while not p.exists() and p != p.parent:
        p = p.parent
    return p


def ensure_recording_folder():
    """Create the recordings folder at start-up, so a fresh install has it before the first recording."""
    folder = get_setting("recording_folder", "RECORD")
    try:
        os.makedirs(folder, exist_ok=True)
    except OSError as exc:
        logger.warning("Could not create the recordings folder %s: %s - change it in Settings > Storage", folder, exc)


ensure_recording_folder()

   
# ------------------- Main -------------------

if __name__ == "__main__":
    # Live view: starts go2rtc next to the app if it is installed (go2rtc/go2rtc[.exe]); stops it on exit.
    # Not installed = live view off, everything else works. CAMVAULT_GO2RTC=0 never starts it.
    go2rtc_launcher.start()

    # Demo mode only: simulated cameras + their own database. Nothing of this runs in a normal start.
    if DEMO:
        from dev import demo_stack
        demo_stack.start(query_db, execute_db)

    threading.Thread(target=resume_running_recordings, daemon=True).start()

    # Keep go2rtc (live view) in sync with the camera list; harmless if go2rtc is not installed
    threading.Thread(
        target=go2rtc_client.sync_loop,
        args=(lambda: query_db("SELECT id, url, sub_url FROM input_sources"),),
        daemon=True,
    ).start()
        # === ADD THIS LINE TO SETUP DAILY JOBS ===
    setup_daily_jobs(get_setting, query_db, scheduler)
    #setup_transcoding_job(get_setting, query_db, scheduler,lock)

     # START THE FFMPEG SUPERVISOR HERE
    threading.Thread(
        target=ffmpeg_supervisor,
        args=(active_recordings, recording_schedules, recording_lock,
            start_recording, update_recording_status_on_schedule_db),
        daemon=True,
    ).start()

    threading.Thread(
        target=start_gap_checker,
        args=(active_recordings, recording_schedules, recording_lock,
            start_recording, update_recording_status_on_schedule_db),
        daemon=True,
    ).start()




    
    

    # CAMVAULT_HOST=127.0.0.1 keeps the app reachable from this computer only; CAMVAULT_PORT changes the port.
    host = os.environ.get("CAMVAULT_HOST", "0.0.0.0")
    port = int(os.environ.get("CAMVAULT_PORT", "5000"))
    logger.info(" Starting Flask app on http://%s:%s%s", host, port, "   [DEMO MODE]" if DEMO else "")
    if host not in ("127.0.0.1", "localhost", "::1"):
        logger.warning(" There is no login: anyone who can reach this computer on port %s can watch and delete "
                       "recordings. Use a trusted network only (CAMVAULT_HOST=127.0.0.1 limits it to this computer).", port)
    try:
        app.run(host=host, port=port, debug=False, use_reloader=False)
    finally:
        # Close all thread-local connections
        if hasattr(thread_local, "db_conn"):
            thread_local.db_conn.close()