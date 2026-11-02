"""
tools/dev_stack.py - starts everything the app needs for local testing, and stops it again.

Called once from app.py:

    from tools import dev_stack
    dev_stack.start_all(query_db, execute_db)

What it does (every step is skipped quietly if its files are missing):
  1. go2rtc      - live-view gateway.  Looks for tools/go2rtc/go2rtc(.exe) or go2rtc/go2rtc(.exe).
  2. fake cameras - MediaMTX + ffmpeg turn every .mp4 in tools/ into a looping RTSP camera
                    (rtsp://127.0.0.1:8654/<file name>)  - see tools/fake_cameras.py.
  3. camera list - each fake camera is added to the Sources list (and registered with go2rtc)
                   if it is not there yet.  An old test camera that points at a wrong local port
                   (8554 / 8654) is re-pointed to the right URL.  Real cameras are never touched.

Everything it started is stopped when the app exits (Ctrl+C, closing the window, normal exit).
Set CAMVAULT_DEV=0 to switch the whole thing off (for a real deployment with real cameras).
"""
from __future__ import annotations

import atexit
import logging
import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

log = logging.getLogger("dev_stack")

HERE = Path(__file__).resolve().parent          # .../tools
ROOT = HERE.parent                              # project root
IS_WIN = os.name == "nt"

_g2r_proc: subprocess.Popen | None = None
_started = False


# ------------------------------------------------------------------ go2rtc
def _find_go2rtc() -> Path | None:
    names = ("go2rtc.exe", "go2rtc") if IS_WIN else ("go2rtc", "go2rtc.exe")
    for folder in (HERE / "go2rtc", ROOT / "go2rtc", HERE):
        for n in names:
            p = folder / n
            if p.is_file():
                return p
    return None


def _kill_tree(proc: subprocess.Popen):
    """Stop a process and anything it started (go2rtc spawns ffmpeg for snapshots)."""
    if proc.poll() is not None:
        return
    if IS_WIN:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def start_go2rtc() -> bool:
    global _g2r_proc
    import go2rtc_client

    if go2rtc_client.is_up():
        log.info("[DEV] go2rtc is already running - using it")
        return True
    exe = _find_go2rtc()
    if not exe:
        log.info("[DEV] go2rtc not found (tools/go2rtc/go2rtc.exe) - live view disabled")
        return False

    logfile = open(exe.parent / "go2rtc.log", "ab")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if IS_WIN else 0
    _g2r_proc = subprocess.Popen(
        [str(exe)], cwd=str(exe.parent),            # go2rtc.yaml is read from its own folder
        stdin=subprocess.DEVNULL, stdout=logfile, stderr=subprocess.STDOUT, creationflags=flags,
    )
    for _ in range(50):                              # wait up to ~10 s for the API
        if go2rtc_client.is_up():
            log.info("[DEV] go2rtc started (%s)", exe)
            return True
        if _g2r_proc.poll() is not None:
            break
        time.sleep(0.2)
    log.error("[DEV] go2rtc did not start - see %s", exe.parent / "go2rtc.log")
    return False


# ------------------------------------------------------------ camera list
_LOCAL_TEST_URL = re.compile(r"^rtsp://[^/]+:(8554|8654)/", re.I)


def _seed_sources(query_db, execute_db, urls: list[str]):
    """Make sure every fake camera is in the Sources list with the right URL."""
    import go2rtc_client

    rows = query_db("SELECT id, name, url, sub_url FROM input_sources")
    for url in urls:
        stem = url.rsplit("/", 1)[-1]                               # e.g. "parking"
        name = stem.replace("_", " ").title()                       # e.g. "Parking"
        if any(r["url"] == url for r in rows):
            continue

        same_name = next((r for r in rows if r["name"].strip().lower() == name.lower()), None)
        if same_name:
            if _LOCAL_TEST_URL.match(same_name["url"] or ""):
                execute_db("UPDATE input_sources SET url = ? WHERE id = ?", (url, same_name["id"]))
                go2rtc_client.register_source(same_name["id"], url, same_name["sub_url"] or "")
                log.info("[DEV] camera '%s' re-pointed: %s -> %s", same_name["name"], same_name["url"], url)
            else:
                log.info("[DEV] camera '%s' already exists with another URL - left as is", name)
            continue

        folder = re.sub(r"[^A-Za-z0-9_-]", "", name.strip())
        execute_db(
            "INSERT INTO input_sources (name, record_folder_name, url, sub_url) VALUES (?, ?, ?, '')",
            (name, folder, url),
        )
        new = query_db("SELECT id FROM input_sources WHERE url = ?", (url,), one=True)
        if new:
            go2rtc_client.register_source(new["id"], url, "")
        log.info("[DEV] test camera added: %s  ->  %s", name, url)
        rows = query_db("SELECT id, name, url, sub_url FROM input_sources")


# --------------------------------------------------------------- public API
def start_all(query_db, execute_db):
    """Start go2rtc + fake cameras and add the fake cameras to the Sources list. Never raises."""
    global _started
    if _started or os.environ.get("CAMVAULT_DEV", "1") == "0":
        return
    _started = True

    atexit.register(stop_all)

    try:
        start_go2rtc()
    except Exception as exc:
        log.warning("[DEV] go2rtc not started: %s", exc)

    try:
        from tools import fake_cameras
        if fake_cameras.start():
            _seed_sources(query_db, execute_db, fake_cameras.urls())
    except Exception as exc:
        log.warning("[DEV] fake cameras not started: %s", exc)

    _install_signal_handlers()


def stop_all():
    global _g2r_proc
    try:
        from tools import fake_cameras
        fake_cameras.stop()
    except Exception:
        pass
    if _g2r_proc is not None:
        _kill_tree(_g2r_proc)
        log.info("[DEV] go2rtc stopped")
        _g2r_proc = None


def _install_signal_handlers():
    """Closing the console window / 'terminate' should clean up too (Ctrl+C already does)."""
    if threading.current_thread() is not threading.main_thread():
        return

    def _handler(signum, frame):
        stop_all()
        sys.exit(0)

    for name in ("SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, _handler)
            except (ValueError, OSError):
                pass
