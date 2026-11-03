"""
dev/fake_cameras.py - simulated RTSP cameras for the CamVault DEMO (and for testing without hardware).

Every video file in dev/samples/ becomes a looping RTSP "camera":

    dev/samples/entrance.mp4   ->   rtsp://127.0.0.1:8654/entrance

How it works: MediaMTX (a small RTSP server, dev/bin/mediamtx) listens on port 8654 and one FFmpeg per
video publishes the file to it again and again. Nothing here is used unless the app runs in demo mode.

How it runs
  * With the app:  python app.py --demo   (dev/demo_stack.py calls start(); everything stops when the app exits)
  * On its own:    python dev/fake_cameras.py        (Ctrl+C to stop) - handy to try the URLs in VLC

Set up the demo files first:  python dev/setup_demo.py
Put your own .mp4 / .mkv / .mov / .avi / .ts files into dev/samples/ to get more cameras.
Needs ffmpeg on the PATH (or set the FFMPEG environment variable to its full path).
Does nothing (quietly) when MediaMTX or the videos are missing.

Settings (environment variables, all optional)
  TEST_RTSP_PORT    RTSP port of the simulator   (default 8654, so it does not clash with go2rtc on 8554)
  TEST_REENCODE=1   convert to H.264/AAC instead of copying (use if a file's codec does not stream well)
  FFMPEG            path to ffmpeg
"""
from __future__ import annotations

import atexit
import logging
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent               # .../dev
BIN = HERE / "bin"                                    # mediamtx(.exe)          (python scripts/get_binaries.py --mediamtx)
SAMPLES = HERE / "samples"                            # the videos              (python dev/setup_demo.py)
RUNTIME = HERE / "demo_data" / "runtime"              # generated config and logs
RTSP_PORT = int(os.environ.get("TEST_RTSP_PORT", "8654"))
REENCODE = os.environ.get("TEST_REENCODE", "") == "1"
VIDEO_EXT = {".mp4", ".mkv", ".mov", ".avi", ".ts"}

log = logging.getLogger("demo_cameras")

_procs: list[subprocess.Popen] = []
_lock = threading.Lock()
_stop = threading.Event()
_started = False
_urls: list[str] = []


# ---------------------------------------------------------------- discovery
def _find_mediamtx() -> Path | None:
    for name in ("mediamtx.exe", "mediamtx"):
        p = BIN / name
        if p.is_file():
            return p
    found = shutil.which("mediamtx")
    return Path(found) if found else None


def _find_ffmpeg() -> str | None:
    return os.environ.get("FFMPEG") or shutil.which("ffmpeg")


def _videos() -> list[Path]:
    if not SAMPLES.is_dir():
        return []
    return sorted(p for p in SAMPLES.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_EXT)


def _camera_name(path: Path) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", path.stem)


def urls() -> list[str]:
    return list(_urls)


# ---------------------------------------------------------------- helpers
def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def _popen(cmd: list[str], log_name: str | None = None) -> subprocess.Popen:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    out = open(RUNTIME / log_name, "w", encoding="utf-8", errors="replace") if log_name else subprocess.DEVNULL
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    proc = subprocess.Popen(cmd, cwd=RUNTIME, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, **kwargs)
    with _lock:
        _procs.append(proc)
    return proc


def _write_mediamtx_config() -> Path:
    """Minimal MediaMTX config: RTSP only, on our own port."""
    RUNTIME.mkdir(parents=True, exist_ok=True)
    cfg = RUNTIME / "mediamtx_demo.yml"
    cfg.write_text(
        "logLevel: warn\n"
        "rtsp: yes\n"
        f"rtspAddress: :{RTSP_PORT}\n"
        "rtmp: no\nhls: no\nwebrtc: no\nsrt: no\napi: no\nmetrics: no\npprof: no\nplayback: no\n"
        "paths:\n  all_others:\n",
        encoding="utf-8",
    )
    return cfg


def _probe_video(ffmpeg: str, video: Path):
    """Return (codec_name, pix_fmt) of the first video stream, or (None, None)."""
    probe = Path(ffmpeg).with_name("ffprobe" + Path(ffmpeg).suffix)
    exe = str(probe) if probe.exists() else (shutil.which("ffprobe") or "")
    if not exe:
        return None, None
    try:
        out = subprocess.run(
            [exe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,pix_fmt",
             "-of", "csv=p=0", str(video)], capture_output=True, text=True, timeout=20).stdout.strip()
        codec, _, pix = out.partition(",")
        return codec or None, pix or None
    except Exception:
        return None, None


def _codec_args(ffmpeg: str, video: Path, name: str):
    """Browsers only play H.264 (8-bit 4:2:0). Copy such files untouched, convert everything else."""
    codec, pix = _probe_video(ffmpeg, video)
    if not REENCODE and codec == "h264" and pix in ("yuv420p", "yuvj420p"):
        return ["-c:v", "copy", "-c:a", "aac"]
    log.info("[DEMO-CAM] %s: video is %s/%s - converting to H.264 so browsers can play it",
             name, codec or "unknown", pix or "?")
    return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
            "-pix_fmt", "yuv420p", "-g", "50", "-c:a", "aac"]


def _publisher(ffmpeg: str, video: Path, name: str):
    """Keep one looping ffmpeg publishing `video` to rtsp://127.0.0.1:PORT/name (restarts if it dies)."""
    url = f"rtsp://127.0.0.1:{RTSP_PORT}/{name}"
    codec = _codec_args(ffmpeg, video, name)
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "warning", "-nostdin",
           "-re", "-stream_loop", "-1", "-i", str(video),
           "-map", "0:v:0", "-map", "0:a:0?", *codec,
           "-f", "rtsp", "-rtsp_transport", "tcp", url]
    quick_failures = 0
    while not _stop.is_set():
        began = time.time()
        proc = _popen(cmd, f"ffmpeg_{name}.log")
        proc.wait()
        if _stop.is_set():
            break
        quick_failures = quick_failures + 1 if time.time() - began < 5 else 0
        if quick_failures == 3:
            log.error("[DEMO-CAM] %s keeps failing - see dev/demo_data/runtime/ffmpeg_%s.log "
                      "(is the file a valid video?)", name, name)
        time.sleep(3)


# ---------------------------------------------------------------- public API
def start() -> bool:
    """Start the RTSP server and one looping camera per video. Safe to call twice. Returns True if running."""
    global _started
    if _started:
        return True

    mtx, ffmpeg, vids = _find_mediamtx(), _find_ffmpeg(), _videos()
    if not mtx or not vids:
        log.warning("[DEMO-CAM] not started: %s - run  python dev/setup_demo.py  first",
                    "MediaMTX not found (dev/bin)" if not mtx else "no video files found (dev/samples)")
        return False
    if not ffmpeg:
        log.warning("[DEMO-CAM] skipped: ffmpeg not found on PATH")
        return False
    if _port_open(RTSP_PORT):
        log.warning("[DEMO-CAM] port %s is already in use (old mediamtx still running?) - skipped", RTSP_PORT)
        return False

    _stop.clear()
    _popen([str(mtx), str(_write_mediamtx_config())], "mediamtx.log")

    for _ in range(50):                      # wait up to ~10 s for the RTSP port
        if _port_open(RTSP_PORT):
            break
        time.sleep(0.2)
    else:
        log.error("[DEMO-CAM] mediamtx did not start - see dev/demo_data/runtime/mediamtx.log")
        stop()
        return False

    _started = True
    atexit.register(stop)
    _install_signal_handlers()
    for video in vids:
        name = _camera_name(video)
        _urls.append(f"rtsp://127.0.0.1:{RTSP_PORT}/{name}")
        threading.Thread(target=_publisher, args=(ffmpeg, video, name), daemon=True).start()

    _wait_streams_ready([_camera_name(v) for v in vids])
    log.info("[DEMO-CAM] fake cameras running:")
    for u in _urls:
        log.info("[DEMO-CAM]   %s", u)
    return True


def _stream_ready(name: str) -> bool:
    """True once ffmpeg is publishing /<name> (RTSP DESCRIBE answers 200)."""
    try:
        with socket.create_connection(("127.0.0.1", RTSP_PORT), timeout=1) as c:
            c.settimeout(1)
            c.sendall(f"DESCRIBE rtsp://127.0.0.1:{RTSP_PORT}/{name} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n".encode())
            return b" 200 " in c.recv(256).split(b"\r\n")[0]
    except OSError:
        return False


def _wait_streams_ready(names, timeout=15.0):
    end = time.time() + timeout
    pending = set(names)
    while pending and time.time() < end:
        pending = {n for n in pending if not _stream_ready(n)}
        if pending:
            time.sleep(0.3)
    if pending:
        log.warning("[DEMO-CAM] not publishing yet: %s", ", ".join(sorted(pending)))


def stop():
    """Stop every ffmpeg publisher and the RTSP server."""
    global _started
    _stop.set()
    with _lock:
        procs = list(_procs)
        _procs.clear()
    for p in procs:
        if p.poll() is None:
            p.terminate()
    for p in procs:
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()
    if _started:
        log.info("[DEMO-CAM] stopped")
    _started = False
    _urls.clear()


def _install_signal_handlers():
    """Make a plain 'terminate' of the app also stop the test cameras (Ctrl+C already does)."""
    if threading.current_thread() is not threading.main_thread():
        return
    def _handler(signum, frame):
        stop()
        sys.exit(0)
    for name in ("SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            try:
                signal.signal(sig, _handler)
            except (ValueError, OSError):
                pass


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    if start():
        print("\nOpen these URLs in VLC, or add them on the Cameras page. Press Ctrl+C to stop.\n")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        stop()
    else:
        sys.exit(1)
