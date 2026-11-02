# transcoding_job.py

import os
import re
import logging
import subprocess
from pathlib import Path
from datetime import datetime, timedelta
from multiprocessing import Process, Queue
from apscheduler.triggers.cron import CronTrigger  # Adjust if different schedule

# Dependencies to be injected from main app
get_setting = None
query_db = None
scheduler = None
lock = None  # Assuming you have a lock from main for DB access
is_transcoding_running = False  # Global runtime flag

logger = logging.getLogger(__name__)

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

        # Take ONLY the first non-empty line
        codec = result.splitlines()[0].strip()
        return codec

    except Exception:
        return None

def needs_transcoding(codec):
    """Check if transcoding is needed based on codec"""
    if not codec:
        return False
    codec_list = [c.strip() for c in codec.splitlines()]
    return any(c in ['mpeg2video', 'mpeg2'] for c in codec_list)

def get_gpu_count():
    """Detect number of NVIDIA GPUs"""
    try:
        output = subprocess.check_output(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'])
        gpus = output.decode().strip().split('\n')
        return len(gpus)
    except Exception:
        logger.warning("Failed to detect GPUs, falling back to CPU")
        return 0

def transcode_file(date_folder, filename, gpu_id=None):
    """Transcode a single .ts file to H.264"""
    input_path = os.path.join(date_folder, filename)
    temp_out = os.path.join(date_folder, filename + '.tmp.ts')
    
    logger.info(f"[START] Transcoding file: {input_path} (GPU: {gpu_id if gpu_id is not None else 'CPU'})")

    cmd = ['ffmpeg', '-y']
    
    if gpu_id is not None:
        cmd += ['-hwaccel', 'cuda', '-hwaccel_device', str(gpu_id)]
        cmd += ['-i', input_path, '-c:v', 'h264_nvenc', '-preset', 'medium', '-cq', '23']
    else:
        cmd += ['-i', input_path, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']
    
    cmd += ['-c:a', 'copy', temp_out]
    
    logger.info(f"Transcoding {filename} with cmd: {' '.join(cmd)}")
    
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        logger.error(f"Transcoding failed for {filename}: {result.stderr}")
        if os.path.exists(temp_out):
            os.remove(temp_out)
        return False
    
    # Replace original
    os.remove(input_path)
    os.rename(temp_out, input_path)
    logger.info(f"Transcoded and replaced {filename}")
    return True

def gpu_worker(gpu_id, queue):
    """Worker process for transcoding on a specific GPU"""
    while True:
        try:
            task = queue.get(timeout=1)
            transcode_file(task['date_folder'], task['filename'], gpu_id)
        except:
            break

def transcode_date_folder(date_folder, files_to_transcode, gpu_count, is_today):
    """Transcode files in a date folder in parallel using available GPUs"""
    if not files_to_transcode:
        return
    
    task_queue = Queue()
    for f in files_to_transcode:
        task_queue.put({'date_folder': date_folder, 'filename': f})
    
    if gpu_count > 0:
        logger.info(f"Detected {gpu_count} GPU(s), transcoding in parallel mode")
        processes = []
        for gpu_id in range(gpu_count):
            p = Process(target=gpu_worker, args=(gpu_id, task_queue))
            p.start()
            processes.append(p)
        
        for p in processes:
            p.join()
    else:
        # CPU sequential
        while not task_queue.empty():
            task = task_queue.get()
            transcode_file(task['date_folder'], task['filename'])
    
    # Write status based on date
    status_file = os.path.join(date_folder, "transcode_status.txt")
    with open(status_file, 'w') as sf:
        if is_today:
            # For today, write last transcoded filename to resume from next file
            sf.write(files_to_transcode[-1])
            logger.info(f"Wrote last transcoded file: {files_to_transcode[-1]}")
        else:
            # For past dates, mark as done
            sf.write("done")
            logger.info(f"Marked folder as done: {date_folder}")

    logger.info(f"=== Completed transcoding for folder: {date_folder} ===")
    

def transcoding_job():
    global get_setting, query_db, lock,is_transcoding_running
    if get_setting is None or query_db is None or lock is None:
        logger.error("Dependencies not initialized in transcoding_job!")
        return


    sources = query_db("""
        SELECT id, record_folder_name, codec
        FROM input_sources
    """)

    for row in sources:
        print(row)

    if is_transcoding_running:
        logger.warning("Previous transcoding job still running, skipping new run.")
        return

    is_transcoding_running = True
    logger.info("Starting transcoding job...")

    
    base_folder = get_setting("recording_folder", "RECORD")
    today = datetime.now().date()


    # Get ALL sources whose codec is NA or mpeg2/mpeg2video
    sources = query_db("""
        SELECT id, record_folder_name, codec
        FROM input_sources
        WHERE codec = 'NA' OR codec IN ('mpeg2video', 'mpeg2')
    """)

    if not sources:
        logger.info("No eligible sources found.")
        return

    for source in sources:
        source_id = source["id"]
        codec = source["codec"]
        record_folder = os.path.join(base_folder, source["record_folder_name"])

        logger.info(f"Processing source={source_id}, codec={codec}, folder={record_folder}")

        # Get all date folders (YYYY-MM-DD)
        date_folders = []
        for entry in os.listdir(record_folder):
            full_path = os.path.join(record_folder, entry)
            if os.path.isdir(full_path):
                try:
                    datetime.strptime(entry, "%Y-%m-%d")  # validate format
                    date_folders.append(full_path)
                except ValueError:
                    pass

        date_folders.sort()  # optional
        logger.info(f"Found date folders: {date_folders}")

        
        # If codec is NA → auto detect from any date folder
        if codec == "NA":
            sample_ts = None

            for df in date_folders:
                ts_files = [f for f in os.listdir(df) if f.endswith('.ts')]
                if ts_files:
                    sample_ts = os.path.join(df, sorted(ts_files)[0])
                    break  # only need ONE TS file to detect codec

            if not sample_ts:
                logger.warning(f"No TS file found in ANY date folder for source {source_id}")
                continue

            # Detect codec
            new_codec = get_video_codec(sample_ts)
            if new_codec:
                query_db("UPDATE input_sources SET codec = ? WHERE id = ?", (new_codec, source_id))
                codec = new_codec
                logger.info(f"Updated codec for source {source_id} → {new_codec}")
            else:
                logger.warning(f"Failed to detect codec for source {source_id}")
                continue

        # After updating codec → check if transcoding needed
        if needs_transcoding(codec):
            gpu_count = get_gpu_count()
            logger.info(f"GPU count available = {gpu_count}")

            for date_folder in date_folders:

                status_file = os.path.join(date_folder, "transcode_status.txt")
                last_done = None
                if os.path.exists(status_file):
                    with open(status_file, 'r') as sf:
                        content = sf.read().strip()
                        if content == "done":
                            logger.info(f"Skipping (already done): {date_folder}")
                            continue
                        else:
                            last_done = content if content.endswith('.ts') else None
                
                # Get TS files for this schedule
                all_ts_files = [f for f in os.listdir(date_folder) if f.endswith('.ts')]
                #logger.info(f"Found TS files: {all_ts_files}")


                if not all_ts_files:
                    continue
                
                pattern = re.compile(r"(\d+)_(\d+)_([\d-]+)\.ts")
                parsed_files = []
                for f in all_ts_files:
                    m = pattern.match(f)
                    if m:
                        rec_session_id, duration, time_str = m.groups()
                        try:
                            t = datetime.strptime(time_str, "%H-%M-%S")
                            parsed_files.append((f, int(rec_session_id), int(duration), t))
                        except ValueError:
                            continue
                
                parsed_files.sort(key=lambda x: x[3])

                files_to_transcode = [p[0] for p in parsed_files]
                logger.info(f"Ordered TS files: {files_to_transcode}")

                if last_done:
                    try:
                        idx = files_to_transcode.index(last_done)
                        files_to_transcode = files_to_transcode[idx + 1:]
                    except ValueError:
                        pass

                 # Skip last file of today (to avoid partial write)
                if os.path.basename(date_folder) == today.strftime("%Y-%m-%d"):
                    if len(files_to_transcode) > 1:
                        skipped_file = files_to_transcode[-1]
                        logger.info(f"Skipping (today) last file {skipped_file}")
                        files_to_transcode = files_to_transcode[:-1]
                    else:
                        logger.info(f"Skipping single file for today to avoid partial write")
                        files_to_transcode = []

                if not files_to_transcode:
                    continue
                
                is_today_date = (os.path.basename(date_folder) == today.strftime("%Y-%m-%d"))
                # Transcode
                transcode_date_folder(date_folder, files_to_transcode, gpu_count, is_today_date)
            pass
        else:
            logger.info(f"No transcoding needed for source {source_id} (codec={codec})")
    

    is_transcoding_running = False
    logger.info("Transcoding job finished.")

def setup_transcoding_job(main_get_setting, main_query_db, main_scheduler, main_lock):
    """Call this from main app to inject dependencies and schedule jobs"""
    global get_setting, query_db, scheduler, lock
    get_setting = main_get_setting
    query_db = main_query_db
    scheduler = main_scheduler
    lock = main_lock
    transcoding_job()
    # Example: Run every 30 minutes; adjust as needed (user didn't specify)
    scheduler.add_job(
        transcoding_job,
        trigger=CronTrigger(minute='*/10'),  # Every 30 minutes
        id='transcoding_job',
        name='Transcoding Job',
        replace_existing=True,
        max_instances=1,  # prevent overlap
        coalesce=True,    # skip missed runs, run only once
    )
    logger.info("Transcoding job scheduled every 10 minutes")