"""
Playback API for CamVault (the Playback page).

    GET /api/playback/days?source=<folder>
            every day that has footage for one camera  -> the green days in the calendar
    GET /api/playback/summary?date=YYYY-MM-DD
            for every camera: how much was recorded that day (camera list on the page)
    GET /api/playback/day?source=<folder>&date=YYYY-MM-DD
            recorded sessions of one camera and day (the green bars on the 24-hour slider)
    GET /api/playback/window?source=&date=&from=<sec>&to=<sec>&session_id=
            builds a playlist for a stretch of the day and returns where every segment sits,
            so the page can turn "20:18:22" into a position in the player and back

Nothing here writes to the database or touches the recordings. The only file written is the
temporary playlist, inside the same per-browser user_data folder the Download page already uses.

Timing. Segment files are named  <camera id>_<chunk seconds>_<HH-MM-SS>.ts , where the time is when
the segment started. Their length is worked out from the names (next start - this start) and the
file's last-modified time, so no ffprobe is needed and a day's playlist is built in milliseconds.
Where ffmpeg was restarted (a gap, or a new chunk length) the playlist gets #EXT-X-DISCONTINUITY so
the player does not stumble over the timestamp reset.
"""
import logging
import math
import os
import re
import threading
from datetime import date as _date, datetime, timedelta
from pathlib import Path

from flask import Blueprint, jsonify, request

log = logging.getLogger(__name__)
bp = Blueprint("playback_api", __name__)
_ctx = {}                       # filled in by init()

DAY_SEC = 86400
MAX_WINDOW = 4 * 3600           # never build a playlist longer than the largest "max play range" setting
GAP_TOL = 3.0                   # seconds of missing footage that count as a real gap
MIN_GAP_SHOW = 5.0              # gaps shorter than this are not shown as a break on the slider

_SEG_RE = re.compile(r"^(\d+)_(\d+)_(\d{2})-(\d{2})-(\d{2})\.ts$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")          # camera folder names are created with this rule

_codec_cache = {}               # (source, date) -> needs transcoding?
_codec_lock = threading.Lock()


def init(app, get_setting, query_db, user_folder, needs_transcoding=None):
    """get_setting(key, default) · query_db(sql, args) · user_folder(session_id) -> Path"""
    _ctx.update(get_setting=get_setting, query_db=query_db, user_folder=user_folder,
                needs_transcoding=needs_transcoding)
    app.register_blueprint(bp)


# ------------------------------------------------------------- helpers ---
def _root():
    return _ctx["get_setting"]("recording_folder", "RECORD")


def _bad(msg, code=400):
    return jsonify({"error": msg}), code


def _check_source(source):
    return bool(source) and bool(_NAME_RE.match(source))


def _check_date(day):
    if not day or not _DATE_RE.match(day):
        return False
    try:
        datetime.strptime(day, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def _day_epoch(day):
    return datetime.strptime(day, "%Y-%m-%d").timestamp()


def read_day(source, day, use_mtime=True):
    """
    Segments of one camera and day, in time order:
        [{"start": sec of day, "dur": seconds, "brk": True if the video restarts here, "name": file}]
    Returns None when the day folder does not exist.
    """
    folder = os.path.join(_root(), source, day)
    raw = []
    try:
        with os.scandir(folder) as it:
            for e in it:
                m = _SEG_RE.match(e.name)
                if not m:
                    continue
                nominal = int(m.group(2))
                sec = int(m.group(3)) * 3600 + int(m.group(4)) * 60 + int(m.group(5))
                mtime = None
                if use_mtime:
                    try:
                        mtime = e.stat(follow_symlinks=False).st_mtime
                    except OSError:
                        pass
                raw.append((sec, nominal, mtime, e.name))
    except (FileNotFoundError, NotADirectoryError):
        return None
    raw.sort()
    return _measure(raw, _day_epoch(day))


def _file_lengths(raw, day_epoch):
    """How long each file really is, from the time it was last written. None where that cannot be trusted."""
    n = len(raw)
    out = []
    for sec, nom, mtime, _ in raw:
        r = None if mtime is None else mtime - (day_epoch + sec)
        out.append(r if r is not None and 0.5 <= r <= nom * 4 + 30 else None)
    # If many files end long before the next one starts, the times on this disk are not usable
    # (copied or restored files, a share that keeps the creation time...): measure by the names only.
    short = sum(1 for i in range(n - 1)
                if out[i] is not None and (raw[i + 1][0] - raw[i][0]) - out[i] > GAP_TOL)
    if short > max(3, 0.2 * n):
        return [None] * n
    return out


def _measure(raw, day_epoch):
    """Work out each segment's length and where the recording was interrupted."""
    segs = []
    brk = True                                              # the first segment always starts a new run
    n = len(raw)
    lengths = _file_lengths(raw, day_epoch)
    for i, (sec, nom, mtime, name) in enumerate(raw):
        real = lengths[i]

        break_after = False
        if i + 1 < n:
            nsec, nnom = raw[i + 1][0], raw[i + 1][1]
            delta = nsec - sec
            if delta <= 0:                                  # two files started in the same second
                dur, break_after = (real or float(nom)), True
            elif real is not None and delta - real > GAP_TOL:
                dur, break_after = real, True               # file ended well before the next one began
            elif delta > nom * 4 + 30 or (real is None and delta > nom * 2.5 + 10):
                dur, break_after = (real or float(nom)), True   # a long hole
            else:
                dur = float(delta)                          # back to back: the gap to the next start is the length
                break_after = nnom != nom                   # chunk length was changed: ffmpeg was restarted
        else:
            dur = real or float(nom)

        segs.append({"start": float(sec), "dur": max(0.5, dur), "brk": brk, "name": name})
        brk = break_after
    return segs


def sessions_of(segs):
    """Merge segments into continuous blocks: [{"from": sec, "to": sec}]"""
    out = []
    for s in segs:
        end = s["start"] + s["dur"]
        if out and s["start"] - out[-1]["to"] < MIN_GAP_SHOW:
            out[-1]["to"] = max(out[-1]["to"], end)
        else:
            out.append({"from": s["start"], "to": end})
    for b in out:
        b["to"] = min(b["to"], DAY_SEC)
    return out


def _has_footage(folder):
    try:
        with os.scandir(folder) as it:
            return any(e.name.endswith(".ts") for e in it)
    except OSError:
        return False


# ------------------------------------------------------------- routes ---
@bp.route("/api/playback/days")
def api_days():
    source = request.args.get("source", "")
    if not _check_source(source):
        return _bad("Missing or invalid camera")
    base = os.path.join(_root(), source)
    days = []
    try:
        with os.scandir(base) as it:
            for e in it:
                if e.is_dir() and _DATE_RE.match(e.name) and _has_footage(e.path):
                    days.append(e.name)
    except OSError:
        pass
    days.sort()
    return jsonify({"source": source, "days": days, "latest": days[-1] if days else None,
                    "today": _date.today().isoformat()})


@bp.route("/api/playback/summary")
def api_summary():
    day = request.args.get("date", "")
    if not _check_date(day):
        return _bad("Missing or invalid date")
    cams = []
    for c in _ctx["query_db"]("SELECT id, name, record_folder_name FROM input_sources ORDER BY id"):
        folder = c["record_folder_name"] or ""
        item = {"id": c["id"], "name": c["name"], "folder": folder, "secs": 0, "sessions": 0}
        if _check_source(folder):
            segs = read_day(folder, day, use_mtime=False)
            if segs:
                blocks = sessions_of(segs)
                item["secs"] = int(round(sum(min(b["to"], DAY_SEC) - b["from"] for b in blocks)))
                item["sessions"] = len(blocks)
        cams.append(item)
    return jsonify({"date": day, "cameras": cams})


@bp.route("/api/playback/day")
def api_day():
    source = request.args.get("source", "")
    day = request.args.get("date", "")
    if not _check_source(source) or not _check_date(day):
        return _bad("Missing or invalid camera or date")
    segs = read_day(source, day)
    if segs is None:
        return jsonify({"source": source, "date": day, "total": 0, "count": 0, "sessions": []})
    blocks = sessions_of(segs)
    total = sum(b["to"] - b["from"] for b in blocks)
    return jsonify({
        "source": source, "date": day, "count": len(segs),
        "total": int(round(total)),
        "sessions": [{"from": round(b["from"], 1), "to": round(b["to"], 1)} for b in blocks],
    })


@bp.route("/api/playback/window")
def api_window():
    source = request.args.get("source", "")
    day = request.args.get("date", "")
    sid = request.args.get("session_id", "")
    frm = request.args.get("from", 0, type=float)
    to = request.args.get("to", DAY_SEC, type=float)
    if not _check_source(source) or not _check_date(day) or not sid:
        return _bad("Missing or invalid camera, date or session")
    frm = max(0.0, min(frm, DAY_SEC))
    to = max(frm, min(to, DAY_SEC, frm + MAX_WINDOW))

    segs = read_day(source, day)
    if not segs:
        return jsonify({"error": "No recordings on this day"}), 404

    # the segment that contains `from` is included, so playback can start exactly where it was asked to
    picked = [s for s in segs if s["start"] + s["dur"] > frm and s["start"] < to]
    if not picked:
        return jsonify({"error": "No recordings in this range"}), 404

    # ---- playlist ----
    lines, table, offset = [], [], 0.0
    longest = 1.0
    for s in picked:
        if s["brk"] and lines:
            lines.append("#EXT-X-DISCONTINUITY\n")
        longest = max(longest, s["dur"])
        lines.append(f'#EXTINF:{s["dur"]:.3f},\n/recordings_rout/{source}/{day}/{s["name"]}\n')
        table.append([round(s["start"], 2), round(s["dur"], 3), round(offset, 3), 1 if s["brk"] else 0])
        offset += s["dur"]

    safe_sid = re.sub(r"[^A-Za-z0-9_-]", "", sid)[:80]
    if not safe_sid:
        return _bad("Invalid session")
    folder = Path(_ctx["user_folder"](safe_sid))
    fname = f"pb_{source}_{day}_{int(picked[0]['start'])}_{int(to)}.m3u8"
    path = folder / fname
    with open(path, "w", encoding="utf-8") as f:
        f.write("#EXTM3U\n#EXT-X-VERSION:3\n")
        f.write(f"#EXT-X-TARGETDURATION:{math.ceil(longest)}\n")
        f.write("#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n")
        f.writelines(lines)
        f.write("#EXT-X-ENDLIST\n")

    try:
        rel = path.relative_to(Path.cwd()).as_posix()
    except ValueError:
        rel = path.as_posix()

    return jsonify({
        "playlist_url": f"/recordings_rout/{rel}",
        "transcode": _needs_transcode(source, day, picked[0]["name"]),
        "date": day,
        "from": round(picked[0]["start"], 2),
        "to": round(picked[-1]["start"] + picked[-1]["dur"], 2),
        "duration": round(offset, 3),
        "segments": table,                       # [start of day, length, offset in playlist, restart?]
    })


def _needs_transcode(source, day, first_name):
    fn = _ctx.get("needs_transcoding")
    if not fn:
        return False
    key = (source, day)
    with _codec_lock:
        if key in _codec_cache:
            return _codec_cache[key]
    try:
        result = bool(fn(os.path.join(_root(), source, day, first_name)))
    except Exception as e:
        log.warning("codec check failed: %s", e)
        result = False
    with _codec_lock:
        if len(_codec_cache) > 500:
            _codec_cache.clear()
        _codec_cache[key] = result
    return result
