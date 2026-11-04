"""
go2rtc_launcher.py - starts go2rtc (the live-view gateway) together with the app and stops it again on exit.

Called once from app.py:

    import go2rtc_launcher
    go2rtc_launcher.start()

go2rtc is OPTIONAL. Without it, recording, schedules, playback and downloads work exactly the same;
only the live picture on the Home page is missing.

How it finds go2rtc
  1. GO2RTC_BIN (environment variable) - full path of the program
  2. go2rtc/go2rtc.exe (Windows) or go2rtc/go2rtc (Linux, macOS) inside the project folder
  3. a program called "go2rtc" on the PATH
  Install it with:   python scripts/get_binaries.py

How to switch it off
  * Do not install it (nothing to start), or
  * set RECORACAM_GO2RTC=0 before starting the app (it is then never started, even if installed), or
  * point GO2RTC_API at a go2rtc that runs somewhere else - the app then uses that one and starts nothing.

Its settings are in go2rtc/go2rtc.yaml. The log is Logs/go2rtc.log (reset at every start).
Cameras are never listed in that file: the app registers them itself (see go2rtc_client.py).
"""
from __future__ import annotations

import atexit
import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import go2rtc_client

log = logging.getLogger("go2rtc_launcher")

ROOT = Path(__file__).resolve().parent
FOLDER = ROOT / "go2rtc"
CONFIG = FOLDER / "go2rtc.yaml"
LOG_FILE = ROOT / "Logs" / "go2rtc.log"
IS_WIN = os.name == "nt"

_proc: subprocess.Popen | None = None
_log_handle = None


def find_binary() -> Path | None:
    env = os.environ.get("GO2RTC_BIN", "").strip()
    if env:
        p = Path(env)
        return p if p.is_file() else None
    for name in (("go2rtc.exe",) if IS_WIN else ("go2rtc",)):
        p = FOLDER / name
        if p.is_file():
            return p
    found = shutil.which("go2rtc")
    return Path(found) if found else None


def _api_is_local() -> bool:
    host = (urlparse(go2rtc_client.API_URL).hostname or "").lower()
    return host in ("127.0.0.1", "localhost", "::1", "")


def _kill_tree(proc: subprocess.Popen):
    """Stop a process and what it started (go2rtc starts ffmpeg for snapshots)."""
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


def start() -> bool:
    """Start go2rtc if it is installed and not running yet. Never raises. True when live view is available."""
    global _proc, _log_handle
    try:
        if os.environ.get("RECORACAM_GO2RTC", "1").strip() == "0":
            log.info("[GO2RTC] switched off (RECORACAM_GO2RTC=0) - live view disabled")
            return False
        if go2rtc_client.is_up():
            log.info("[GO2RTC] already running at %s - using it", go2rtc_client.API_URL)
            return True
        if not _api_is_local():
            log.warning("[GO2RTC] %s is not reachable - live view disabled", go2rtc_client.API_URL)
            return False

        exe = find_binary()
        if not exe:
            log.info("[GO2RTC] not installed - live view disabled (install it with: python scripts/get_binaries.py)")
            return False

        LOG_FILE.parent.mkdir(exist_ok=True)
        _log_handle = open(LOG_FILE, "wb")
        cmd = [str(exe)]
        if CONFIG.is_file():
            cmd += ["-config", str(CONFIG)]
        _proc = subprocess.Popen(
            cmd, cwd=str(FOLDER if FOLDER.is_dir() else ROOT),
            stdin=subprocess.DEVNULL, stdout=_log_handle, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if IS_WIN else 0,
        )
        atexit.register(stop)
        _install_signal_handlers()

        for _ in range(50):                                   # wait up to ~10 s for the API
            if go2rtc_client.is_up():
                log.info("[GO2RTC] started (%s) - live view on", exe)
                return True
            if _proc.poll() is not None:
                break
            time.sleep(0.2)
        log.error("[GO2RTC] did not start - see %s", LOG_FILE)
        return False
    except Exception as exc:                                  # live view must never stop the app from starting
        log.warning("[GO2RTC] not started: %s", exc)
        return False


def stop():
    global _proc, _log_handle
    if _proc is not None:
        _kill_tree(_proc)
        log.info("[GO2RTC] stopped")
        _proc = None
    if _log_handle is not None:
        try:
            _log_handle.close()
        except OSError:
            pass
        _log_handle = None


def _install_signal_handlers():
    """A plain 'terminate' (service stop, task kill) should clean up too; Ctrl+C already does."""
    if threading.current_thread() is not threading.main_thread():
        return
    for name in ("SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, lambda signum, frame: sys.exit(0))     # exiting runs the atexit clean-up
            except (ValueError, OSError):
                pass
