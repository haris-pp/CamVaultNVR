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
    total, used, free = shutil.disk_usage(path)
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

def daily_job():
    global get_setting, query_db
    logger.info("========== DAILY JOB STARTED ==========")

    if get_setting is None or query_db is None:
        logger.error("get_setting or query_db not initialized in daily_jobs!")
        return

    # === Part 1: Create tomorrow's folder for ongoing multi-day recordings ===
    base_folder = get_setting("recording_folder", "/mnt/RECORD")
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


    # === Part 2: Delete user session folders older than 1 hour ===
    USER_DATA_ROOT = Path.cwd() / "user_data"
    if USER_DATA_ROOT.exists():
        current_time = time.time()
        for folder in list(USER_DATA_ROOT.iterdir()):
            if folder.is_dir():
                try:
                    mtime = folder.stat().st_mtime
                    if current_time - mtime > 3600:  # 1 hour
                        shutil.rmtree(folder)
                        logger.info(f"Deleted old session folder: {folder.name}")
                except Exception as e:
                    logger.warning(f"Could not delete {folder}: {e}")

    # === Part 3 Recycle recording ts file old date ==
    recycle_thr =  85
    recycle_until_disk_ok(base_folder, recycle_thr)
    cleanup_old_playlists(base_folder)


def setup_daily_jobs(main_get_setting, main_query_db, main_scheduler):
    """Call this from main app to inject dependencies and schedule jobs"""
    global get_setting, query_db, scheduler
    get_setting = main_get_setting
    query_db = main_query_db
    scheduler = main_scheduler

    #daily_job()

    # Schedule the job twice daily: 5 AM and 10 PM
    scheduler.add_job(
        daily_job,
        trigger=CronTrigger(hour=5, minute=0),
        id='daily_job_5am',
        name='Daily Job - 5 AM',
        replace_existing=True
    )
    scheduler.add_job(
        daily_job,
        trigger=CronTrigger(hour=22, minute=30),
        id='daily_job_10pm',
        name='Daily Job - 10 PM',
        replace_existing=True
    )
    logger.info("Daily jobs scheduled at 5:00 AM and 10:30 PM")