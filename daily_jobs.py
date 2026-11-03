# daily_jobs.py
import os
import shutil
import time
import logging
from pathlib import Path
from datetime import datetime, timedelta
from apscheduler.triggers.cron import CronTrigger

# These will be imported from main app at runtime
get_setting = None
query_db = None
scheduler = None

logger = logging.getLogger(__name__)

def get_disk_usage_percent(path):
    p = Path(path).expanduser().resolve()
    while not p.exists() and p != p.parent:        # the folder may not exist yet: measure the disk it will be on
        p = p.parent
    total, used, free = shutil.disk_usage(p)
    return round((used / total) * 100, 2)

def cleanup_old_playlists(base_folder):
    logger.info("=== CLEANING OLD PLAYLIST FILES ===")

    today = datetime.now().date()

    for source in os.listdir(base_folder):
        source_path = os.path.join(base_folder, source)
        if not os.path.isdir(source_path):
            continue

        for fname in os.listdir(source_path):
            if not fname.endswith("_playlist.m3u8"):
                continue

            fpath = os.path.join(source_path, fname)

            try:
                mtime = datetime.fromtimestamp(os.path.getmtime(fpath)).date()

                # Delete if not modified today
                if mtime != today:
                    os.remove(fpath)
                    logger.info(f"[PLAYLIST REMOVED] {fpath}")
            except Exception as e:
                logger.warning(f"Could not remove playlist {fpath}: {e}")


def recycle_until_disk_ok(base_folder, max_percent=85):
    logger.info("=== DISK-BASED RECORDING RECYCLE STARTED ===")

    if not os.path.exists(base_folder):
        logger.error(f"Base folder not found: {base_folder}")
        return

    current_usage = get_disk_usage_percent(base_folder)
    logger.info(f"Current disk usage: {current_usage}%")

    if current_usage <= max_percent:
        logger.info("Disk usage within limit. No recycling needed.")
        return

    # Collect ALL date folders across ALL sources
    date_folders = []

    for source in os.listdir(base_folder):
        source_path = os.path.join(base_folder, source)
        if not os.path.isdir(source_path):
            continue

        for d in os.listdir(source_path):
            folder_path = os.path.join(source_path, d)
            if not os.path.isdir(folder_path):
                continue
            try:
                folder_date = datetime.strptime(d, "%Y-%m-%d")
                date_folders.append((folder_date, folder_path))
            except ValueError:
                continue

    # Oldest first
    date_folders.sort(key=lambda x: x[0])

    if not date_folders:
        logger.warning("No date folders found for recycling.")
        return

    for folder_date, folder_path in date_folders:
        if current_usage <= max_percent:
            break

        try:
            shutil.rmtree(folder_path)
            logger.info(f"[RECYCLED] Deleted {folder_path}")
        except Exception as e:
            logger.error(f"Failed to delete {folder_path}: {e}")
            continue

        # Recalculate disk usage after deletion
        current_usage = get_disk_usage_percent(base_folder)
        logger.info(f"Disk usage after cleanup: {current_usage}%")

    if current_usage > max_percent:
        logger.warning(
            f"Cleanup finished but disk still above limit: {current_usage}%"
        )
    else:
        logger.info(
            f"Disk usage successfully reduced to {current_usage}%"
        )

def _setting_int(key, default, lo, hi):
    try:
        n = int(float(get_setting(key, default)))
    except (TypeError, ValueError):
        n = default
    return max(lo, min(hi, n))


def _setting_bool(key, default):
    raw = get_setting(key, None)
    if raw is None:
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def cleanup_user_data():
    """Delete the temporary folders where trimmed clips are prepared, once they are older than the keep time."""
    if get_setting is None:
        return
    keep_seconds = _setting_int("download_keep_minutes", 60, 5, 1440) * 60
    root = Path.cwd() / "user_data"
    if not root.exists():
        return
    now = time.time()
    for folder in list(root.iterdir()):
        if folder.is_dir():
            try:
                if now - folder.stat().st_mtime > keep_seconds:
                    shutil.rmtree(folder)
                    logger.info(f"Deleted old session folder: {folder.name}")
            except Exception as e:
                logger.warning(f"Could not delete {folder}: {e}")


def parse_times(text):
    out = []
    for t in str(text or "").split(","):
        t = t.strip()
        try:
            h, m = t.split(":")
            h, m = int(h), int(m)
        except ValueError:
            continue
        if 0 <= h < 24 and 0 <= m < 60 and (h, m) not in out:
            out.append((h, m))
    return sorted(out)


def apply_cleanup_times(times):
    """(Re)schedule the disk clean-up at the given 'HH:MM' times. Called at start-up and when Settings are saved."""
    if scheduler is None:
        return
    for job in scheduler.get_jobs():
        if job.id.startswith("daily_job_"):
            job.remove()
    for h, m in parse_times(",".join(times)):
        scheduler.add_job(
            daily_job,
            trigger=CronTrigger(hour=h, minute=m),
            id=f"daily_job_{h:02d}{m:02d}",
            name=f"Daily Job - {h:02d}:{m:02d}",
            replace_existing=True
        )
    logger.info("Clean-up times: " + (", ".join(f"{h:02d}:{m:02d}" for h, m in parse_times(",".join(times))) or "none"))


def daily_job():
    global get_setting, query_db
    logger.info("========== DAILY JOB STARTED ==========")

    if get_setting is None or query_db is None:
        logger.error("get_setting or query_db not initialized in daily_jobs!")
        return

    # === Part 1: Create tomorrow's folder for ongoing multi-day recordings ===
    base_folder = get_setting("recording_folder", "RECORD")
    running_schedules = query_db("SELECT * FROM schedules WHERE status != 'completed'")
    today = datetime.now().date()
    tomorrow = today + timedelta(days=1)
    tomorrow_str = tomorrow.strftime("%Y-%m-%d")
    
    
    logger.info(f"Checking {len(running_schedules)} active schedules for tomorrow folder creation...")

    for sched in running_schedules:
        try:
            start_dt = datetime.strptime(sched['start_datetime'], "%Y-%m-%d %H:%M:%S")
            end_dt = datetime.strptime(sched['end_datetime'], "%Y-%m-%d %H:%M:%S")

            if end_dt.date() >= tomorrow and start_dt.date() <= tomorrow:
                source = query_db(
                    "SELECT record_folder_name FROM input_sources WHERE id = ?",
                    (sched['source_id'],), one=True
                )
                if source:
                    record_folder_name = source['record_folder_name']
                    source_path = os.path.join(base_folder, record_folder_name)
                    tomorrow_folder = os.path.join(source_path, tomorrow_str)

                    if not os.path.exists(tomorrow_folder):
                        os.makedirs(tomorrow_folder, exist_ok=True)
                        logger.info(f"[CREATED] Tomorrow folder: {tomorrow_folder} (schedule ID: {sched['id']})")
                    else:
                        logger.debug(f"[SKIPPED] Tomorrow folder already exists: {tomorrow_folder}")
                else:
                    logger.warning(f"[SKIP] No input source found for schedule ID: {sched['id']}")
            else:
                logger.debug(f"[IGNORE] Schedule {sched['id']} does not span into tomorrow.")
        except Exception as e:
            logger.error(f"[ERROR] Failed to process schedule {sched.get('id', 'unknown')}: {e}")


    # === Part 2: Delete prepared download folders that are past their keep time ===
    cleanup_user_data()

    # === Part 3: Recycle the oldest recordings when the disk is above the limit (Settings > Storage) ===
    if _setting_bool("auto_clean_enabled", True):
        limit = _setting_int("disk_limit_percent", 85, 50, 95)
        recycle_until_disk_ok(base_folder, limit)
    else:
        logger.info("Automatic clean-up is off. Skipping disk recycle.")
    cleanup_old_playlists(base_folder)


def setup_daily_jobs(main_get_setting, main_query_db, main_scheduler):
    """Call this from main app to inject dependencies and schedule jobs"""
    global get_setting, query_db, scheduler
    get_setting = main_get_setting
    query_db = main_query_db
    scheduler = main_scheduler

    #daily_job()

    # Clean-up times come from Settings > Storage (default 05:00 and 22:30)
    apply_cleanup_times([f"{h:02d}:{m:02d}" for h, m in parse_times(get_setting("cleanup_times", "05:00,22:30"))])

    # Prepared download folders are checked every 10 minutes so the "keep for" setting is respected
    scheduler.add_job(
        cleanup_user_data,
        trigger="interval",
        minutes=10,
        id='user_data_cleanup',
        name='Delete old prepared downloads',
        replace_existing=True
    )
