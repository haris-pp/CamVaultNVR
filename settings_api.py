"""
Settings API for RecoraCam.

    GET  /api/settings                 all settings, typed (with defaults for anything not saved yet)
    POST /api/settings                 save any subset of the settings; every value is checked first
    POST /api/settings/check_folder    can RecoraCam write to this folder?
    GET  /api/settings/browse          folders inside a folder, plus the drives (for the folder picker)
    POST /api/settings/make_folder     create a new folder inside a folder (folder picker)
    GET  /api/settings/storage         disk usage, size of the recordings, oldest recorded day
    GET  /api/settings/system          version, FFmpeg, time zone, uptime, log file, live-view status
    GET  /api/settings/recording_status   cameras recording with an older folder / segment length than Settings
    POST /api/settings/apply_recording    restart those cameras so they use the current Settings

Values live in the existing `settings` table (key / value text), so there is no database change.
"""
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

import psutil
from flask import Blueprint, jsonify, request

import go2rtc_client

# Shown on the Settings > System card. Change it when you tag a release.
APP_VERSION = "0.1.0"

log = logging.getLogger(__name__)
bp = Blueprint("settings_api", __name__)
_ctx = {}                      # filled in by init()

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------------------------------------------------------------- schema ---
def _int_range(lo, hi):
    def parse(v):
        try:
            n = int(float(v))
        except (TypeError, ValueError):
            raise ValueError(f"Enter a whole number between {lo} and {hi}")
        if n < lo or n > hi:
            raise ValueError(f"Enter a number between {lo} and {hi}")
        return n
    return parse


def _choice(options, cast):
    def parse(v):
        try:
            n = cast(v)
        except (TypeError, ValueError):
            raise ValueError("Pick one of the options")
        if n not in options:
            raise ValueError("Pick one of the options")
        return n
    return parse


def _bool(v):
    if isinstance(v, bool):
        return v
    if str(v).strip().lower() in ("1", "true", "yes", "on"):
        return True
    if str(v).strip().lower() in ("0", "false", "no", "off", ""):
        return False
    raise ValueError("Must be on or off")


def _folder(v):
    v = str(v or "").strip()
    if not v:
        raise ValueError("Enter a folder path")
    if len(v) > 500:
        raise ValueError("That path is too long")
    return v


def _times(v):
    if isinstance(v, str):
        v = [t for t in v.split(",") if t.strip()]
    if not isinstance(v, (list, tuple)):
        raise ValueError("Give a list of times like 05:00")
    out = []
    for t in v:
        t = str(t).strip()
        if not _TIME_RE.match(t):
            raise ValueError(f"'{t}' is not a time (use HH:MM)")
        if t not in out:
            out.append(t)
    if len(out) > 6:
        raise ValueError("At most 6 clean-up times")
    return sorted(out)


# key: (default, parse, to_text, from_text)
def _text(x): return str(x)
def _flag(x): return "1" if x else "0"
def _csv(x): return ",".join(x)


SCHEMA = {
    "recording_folder":      ("RECORD", _folder, _text, str),
    "chunk_duration":        (10, _int_range(1, 300), _text, int),
    "skip_duration":         (10, _int_range(1, 300), _text, int),
    "auto_clean_enabled":    (True, _bool, _flag, _bool),
    "disk_limit_percent":    (85, _int_range(50, 95), _text, int),
    "cleanup_times":         (["05:00", "22:30"], _times, _csv, _times),
    "download_keep_minutes": (60, _int_range(5, 1440), _text, int),
    "wall_refresh_seconds":  (10, _int_range(5, 300), _text, int),
    "default_speed":         (1.0, _choice((0.5, 1.0, 1.5, 2.0), float), _text, float),
    "max_play_range":        (7200, _choice((3600, 7200, 14400), int), _text, int),
    "time_format":           ("12h", _choice(("12h", "24h"), str), _text, str),
}


def read_all():
    """Every setting as a typed value; anything missing or unreadable falls back to its default."""
    get = _ctx["get_setting"]
    out = {}
    for key, (default, _parse, _to_text, from_text) in SCHEMA.items():
        raw = get(key)
        try:
            out[key] = from_text(raw) if raw not in (None, "") else default
        except (TypeError, ValueError):
            out[key] = default
    return out


@bp.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    if request.method == "GET":
        return jsonify(read_all())

    data = request.get_json(silent=True) or {}
    clean, errors = {}, {}
    for key, value in data.items():
        if key not in SCHEMA:
            continue
        try:
            clean[key] = SCHEMA[key][1](value)
        except ValueError as e:
            errors[key] = str(e)

    # clean-up needs at least one time to run at
    current = read_all()
    enabled = clean.get("auto_clean_enabled", current["auto_clean_enabled"])
    times = clean.get("cleanup_times", current["cleanup_times"])
    if enabled and not times and "cleanup_times" not in errors:
        errors["cleanup_times"] = "Add at least one time, or turn automatic clean-up off"

    if errors:
        field, message = next(iter(errors.items()))
        return jsonify({"error": message, "field": field, "errors": errors}), 400

    for key, value in clean.items():
        _ctx["set_setting"](key, SCHEMA[key][2](value))

    if "cleanup_times" in clean:
        try:
            _ctx["daily_jobs"].apply_cleanup_times(clean["cleanup_times"])
        except Exception as e:                       # the settings are saved either way
            log.warning("Could not re-schedule clean-up jobs: %s", e)

    log.info("Settings updated: %s", ", ".join(f"{k}={clean[k]}" for k in clean))
    return jsonify({"status": "updated", "settings": read_all()})


# ---------------------------------------------------------- folder check ---
@bp.route("/api/settings/check_folder", methods=["POST"])
def check_folder():
    path = str((request.get_json(silent=True) or {}).get("path", "")).strip()
    if not path:
        return jsonify({"ok": False, "message": "Enter a folder path first."})

    p = Path(path).expanduser()
    absolute = str(p.resolve())

    if p.exists():
        if not p.is_dir():
            return jsonify({"ok": False, "path": absolute, "message": "That path is a file, not a folder."})
        probe = p / ".recoracam_write_test"
        try:
            probe.write_text("ok")
            probe.unlink()
        except OSError:
            return jsonify({"ok": False, "path": absolute,
                            "message": "The folder exists but RecoraCam cannot write to it."})
        free = shutil.disk_usage(p).free / 1024 ** 3
        return jsonify({"ok": True, "path": absolute, "message": f"Writable · {free:.0f} GB free on this drive"})

    parent = p.resolve()
    while not parent.exists() and parent != parent.parent:
        parent = parent.parent
    if os.access(parent, os.W_OK):
        return jsonify({"ok": True, "path": absolute,
                        "message": "The folder does not exist yet. It is created when the first recording starts."})
    return jsonify({"ok": False, "path": absolute,
                    "message": f"Cannot create it: no write access to {parent}"})


# --------------------------------------------------------- folder picker ---
_SKIP_MOUNTS = ("/snap", "/boot", "/var/lib", "/run", "/sys", "/proc", "/dev", "/etc", "/usr")
_BAD_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _is_hidden(entry):
    """Dot-folders, and on Windows folders marked hidden or system ($Recycle.Bin and so on)."""
    if entry.name.startswith("."):
        return True
    try:
        attrs = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
    except OSError:
        return False
    return bool(attrs & 0x2 or attrs & 0x4)          # FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM


def _drives():
    out, seen = [], set()
    for part in psutil.disk_partitions(all=False):
        mount = part.mountpoint
        if mount in seen or not part.fstype or "cdrom" in (part.opts or ""):
            continue
        if any(mount == m or mount.startswith(m + "/") for m in _SKIP_MOUNTS):
            continue
        try:
            usage = shutil.disk_usage(mount)
        except OSError:                                # empty card reader, disconnected network drive...
            continue
        if not usage.total:
            continue
        seen.add(mount)
        out.append({"path": mount, "total": usage.total, "free": usage.free})
    return out


def _places():
    places = [{"label": "RecoraCam folder", "path": str(Path.cwd())}]
    home = Path.home()
    if home.is_dir():
        places.append({"label": "Home", "path": str(home)})
    return places


@bp.route("/api/settings/browse")
def browse():
    raw = request.args.get("path", "").strip()
    try:
        p = (Path(raw).expanduser() if raw else Path.cwd()).resolve()
    except (OSError, RuntimeError, ValueError):
        return jsonify({"error": "That path is not valid"}), 400

    if request.args.get("nearest") == "1":            # first open: start at the closest folder that exists
        while not p.is_dir() and p != p.parent:
            p = p.parent
    if not p.is_dir():
        return jsonify({"error": "That folder does not exist"}), 404

    folders, error = [], None
    try:
        with os.scandir(p) as it:
            for entry in it:
                try:
                    if entry.is_dir() and not _is_hidden(entry):
                        folders.append({"name": entry.name, "path": str(Path(entry.path))})
                except OSError:
                    continue
    except PermissionError:
        error = "RecoraCam is not allowed to open this folder"
    except OSError as e:
        error = f"Could not read this folder ({e.strerror or e})"
    folders.sort(key=lambda f: f["name"].lower())

    out = {
        "path": str(p),
        "parent": None if p.parent == p else str(p.parent),
        "folders": folders[:1000],
        "truncated": len(folders) > 1000,
        "writable": os.access(p, os.W_OK),
        "error": error,
    }
    if request.args.get("drives") == "1":
        out["drives"] = _drives()
        out["places"] = _places()
    return jsonify(out)


@bp.route("/api/settings/make_folder", methods=["POST"])
def make_folder():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    parent = Path(str(data.get("parent", "")).strip() or ".").expanduser()

    if not name:
        return jsonify({"ok": False, "message": "Enter a folder name"})
    if name in (".", "..") or name.endswith(".") or _BAD_NAME.search(name):
        return jsonify({"ok": False, "message": 'A folder name cannot contain  < > : " / \\ | ? *'})
    if not parent.is_dir():
        return jsonify({"ok": False, "message": "The folder you are in no longer exists"})

    target = parent / name
    if target.exists():
        return jsonify({"ok": False, "message": f"'{name}' already exists here"})
    try:
        target.mkdir()
    except PermissionError:
        return jsonify({"ok": False, "message": "RecoraCam is not allowed to create a folder here"})
    except OSError as e:
        return jsonify({"ok": False, "message": f"Could not create the folder ({e.strerror or e})"})
    log.info("Created folder %s", target)
    return jsonify({"ok": True, "path": str(target.resolve())})


# --------------------------------------------------------------- storage ---
_size = {"bytes": None, "at": 0.0, "busy": False, "folder": None}


def _walk_size(folder):
    total, stack = 0, [folder]
    while stack:
        try:
            with os.scandir(stack.pop()) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def _refresh_size(folder):
    try:
        _size["bytes"] = _walk_size(folder)
        _size["at"] = time.time()
        _size["folder"] = folder
    finally:
        _size["busy"] = False


def _oldest_day(folder):
    """Oldest YYYY-MM-DD folder under <folder>/<camera>/."""
    oldest = None
    try:
        for cam in os.scandir(folder):
            if not cam.is_dir():
                continue
            for day in os.scandir(cam.path):
                if day.is_dir() and _DATE_RE.match(day.name) and (oldest is None or day.name < oldest):
                    oldest = day.name
    except OSError:
        pass
    return oldest


@bp.route("/api/settings/storage")
def storage():
    s = read_all()
    folder = Path(s["recording_folder"]).expanduser().resolve()
    exists = folder.is_dir()

    probe = folder
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    disk = shutil.disk_usage(probe)

    # Adding up a big recordings folder can take a while, so it runs in the background and is cached.
    folder_key = str(folder)
    stale = _size["folder"] != folder_key or time.time() - _size["at"] > 300
    if exists and stale and not _size["busy"]:
        _size["busy"] = True
        threading.Thread(target=_refresh_size, args=(folder_key,), daemon=True).start()
    have = exists and _size["folder"] == folder_key and _size["bytes"] is not None

    return jsonify({
        "folder": folder_key,
        "exists": exists,
        "total": disk.total,
        "used": disk.used,
        "free": disk.free,
        "percent": round(disk.used / disk.total * 100, 1) if disk.total else 0,
        "recordings_bytes": _size["bytes"] if have else (0 if not exists else None),
        "calculating": exists and not have,
        "oldest_day": _oldest_day(folder_key) if exists else None,
        "limit_percent": s["disk_limit_percent"],
        "auto_clean": s["auto_clean_enabled"],
    })


# ---------------------------------------------------------------- system ---
_ffmpeg = {"text": None}


def _ffmpeg_version():
    if _ffmpeg["text"] is None:
        text = "not found"
        try:
            out = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, timeout=5).stdout
            m = re.search(r"ffmpeg version (\S+)", out)
            text = m.group(1) if m else "unknown"
        except Exception:
            pass
        _ffmpeg["text"] = text
    return _ffmpeg["text"]


@bp.route("/api/settings/system")
def system():
    log_file = None
    for h in logging.getLogger().handlers:
        if isinstance(h, logging.FileHandler):
            try:
                log_file = os.path.relpath(h.baseFilename)
            except ValueError:
                log_file = h.baseFilename
            break

    try:
        uptime = int(time.time() - psutil.Process().create_time())
    except Exception:
        uptime = None

    return jsonify({
        "version": APP_VERSION,
        "ffmpeg": _ffmpeg_version(),
        "timezone": str(_ctx["scheduler"].timezone),
        "uptime_seconds": uptime,
        "database": _ctx["db_path"],
        "log_file": log_file,
        "live_available": bool(go2rtc_client.is_up()),
        "live_port": go2rtc_client.PUBLIC_PORT,
    })


# ------------------------------------------- cameras that are recording now ---
_recorder = {"outdated": lambda: [], "restart": lambda: {"restarted": [], "failed": []}}


def set_recorder(outdated, restart):
    """app.py hands over the two functions that know about the running ffmpeg processes."""
    _recorder["outdated"] = outdated
    _recorder["restart"] = restart


@bp.route("/api/settings/recording_status")
def recording_status():
    return jsonify({"outdated": _recorder["outdated"]()})


@bp.route("/api/settings/apply_recording", methods=["POST"])
def apply_recording():
    return jsonify(_recorder["restart"]())


# ------------------------------------------------------------------ init ---
def init(app, get_setting, set_setting, scheduler, daily_jobs_module, db_path):
    """Call once from app.py after get_setting / set_setting exist."""
    _ctx.update(get_setting=get_setting, set_setting=set_setting, scheduler=scheduler,
                daily_jobs=daily_jobs_module, db_path=db_path)
    app.register_blueprint(bp)
