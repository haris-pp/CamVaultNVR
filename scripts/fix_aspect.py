"""
scripts/fix_aspect.py - repair the picture shape of recordings made by the old recorder.

Why: an earlier CamVault forced "sample_aspect_ratio=16/9" into every H.264 recording. That value is the
shape of one pixel, so a normal 16:9 camera was stored as a 3.2:1 picture and looked stretched in browsers
and in VLC. New recordings are fine. This script puts the old ones right.

What it does: for every .ts segment whose picture shape is exactly that wrong 16:9 pixel value, it copies the
segment again (no re-encoding, the picture is not touched) with the pixel shape set to 1:1.
The segment keeps its name, its time stamps, its length and its last-modified time, so playlists, the
Playback page and downloads keep working. Segments that are fine are never touched.

Run it from the project folder, with the recorder and the app stopped or at least idle:

    python scripts/fix_aspect.py                       look only: which cameras and days are affected
    python scripts/fix_aspect.py --apply               repair everything affected
    python scripts/fix_aspect.py --apply --camera Entrance --since 2026-10-01

    --folder PATH   recordings folder (default: the folder saved in Settings, else RECORD)
    --sar 16/11     pixel shape to write instead of 1/1 (only for anamorphic DVR channels such as 704x576)
    --min-age 120   leave segments newer than this many seconds alone (they may still be written)
    --workers 4     segments repaired at the same time

It can be run again at any time: repaired segments are skipped. Needs ffmpeg and ffprobe on the PATH.
"""
import argparse
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEG_RE = re.compile(r"^\d+_\d+_\d{2}-\d{2}-\d{2}\.ts$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
BAD_SAR = "16:9"                       # what the old recorder wrote


def default_folder():
    try:
        db = Path(os.environ.get("CAMVAULT_DB") or "app_database.db")
        con = sqlite3.connect(str(db if db.is_absolute() else ROOT / db))
        row = con.execute("SELECT value FROM settings WHERE key='recording_folder'").fetchone()
        con.close()
        if row and row[0]:
            p = Path(row[0])
            return str(p if p.is_absolute() else ROOT / p)
    except Exception:
        pass
    return str(ROOT / "RECORD")


def probe(path):
    """(codec, sample aspect ratio, start time, duration, streams) of a segment, or None."""
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries",
             "stream=codec_type,codec_name,sample_aspect_ratio:format=start_time,duration",
             "-of", "compact=p=0", str(path)], stderr=subprocess.DEVNULL, timeout=60).decode()
    except Exception:
        return None
    info = {"codec": None, "sar": None, "start": None, "dur": None, "streams": 0}
    for line in out.splitlines():
        f = dict(kv.split("=", 1) for kv in line.split("|") if "=" in kv)
        if "codec_type" in f:                                   # a stream (it may be listed inside a program as well)
            info["streams"] += 1
            if f["codec_type"] == "video" and info["codec"] is None:
                info["codec"], info["sar"] = f.get("codec_name"), f.get("sample_aspect_ratio")
        elif "start_time" in f:                                 # the file itself
            try:
                info["start"], info["dur"] = float(f["start_time"]), float(f["duration"])
            except (KeyError, TypeError, ValueError):
                pass
    return info


def remux(src, dst, sar, ts_offset):
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-map", "0", "-c", "copy",
           "-copyts", "-output_ts_offset", f"{ts_offset:.6f}",
           "-bsf:v", f"h264_metadata=sample_aspect_ratio={sar}", "-f", "mpegts", str(dst)]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)


def calibrate(sample, sar, tmp):
    """The mpegts muxer adds a small start delay of its own. Measure it once so it can be taken off again."""
    before = probe(sample)
    test = Path(tmp) / "calibrate.ts"
    remux(sample, test, sar, 0.0)
    after = probe(test)
    if not before or not after or before["start"] is None or after["start"] is None:
        raise RuntimeError("could not measure the time stamps of a test segment")
    return -(after["start"] - before["start"])


def repair(path, sar, offset, tmp):
    """Returns 'fixed', 'ok' (nothing to do), or a reason it was left alone."""
    before = probe(path)
    if not before:
        return "unreadable"
    if before["codec"] != "h264" or before["sar"] != BAD_SAR:
        return "ok"
    part = Path(tmp) / (path.name + ".part")
    try:
        st = path.stat()
        remux(path, part, sar, offset)
        after = probe(part)
        good = (after and after["sar"] == sar.replace("/", ":") and after["streams"] == before["streams"]
                and abs(after["start"] - before["start"]) < 0.05 and abs(after["dur"] - before["dur"]) < 0.05)
        if not good:
            return "check failed (left as it was)"
        shutil.copyfile(part, str(path) + ".fixing")
        os.utime(str(path) + ".fixing", (st.st_atime, st.st_mtime))      # keep the last-modified time
        os.replace(str(path) + ".fixing", path)
        return "fixed"
    except PermissionError:
        return "in use (left as it was)"
    except Exception as e:                                                # never leave a half-written file behind
        return f"failed: {e}"
    finally:
        for f in (part, Path(str(path) + ".fixing")):
            try:
                f.unlink()
            except OSError:
                pass


def main():
    ap = argparse.ArgumentParser(description="Repair the picture shape of recordings made by the old recorder.")
    ap.add_argument("--folder", default=default_folder())
    ap.add_argument("--apply", action="store_true", help="repair (without it, only look)")
    ap.add_argument("--camera", help="only this camera folder")
    ap.add_argument("--since", help="only days from YYYY-MM-DD")
    ap.add_argument("--sar", default="1/1", help="pixel shape to write (default 1/1)")
    ap.add_argument("--min-age", type=int, default=120)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()

    for exe in ("ffmpeg", "ffprobe"):
        if not shutil.which(exe):
            sys.exit(f"{exe} was not found on the PATH")
    root = Path(a.folder)
    if not root.is_dir():
        sys.exit(f"Recordings folder not found: {root}")
    print(f"Recordings folder: {root}")

    days = []
    for cam in sorted(p for p in root.iterdir() if p.is_dir()):
        if a.camera and cam.name != a.camera:
            continue
        for day in sorted(p for p in cam.iterdir() if p.is_dir() and DATE_RE.match(p.name)):
            if a.since and day.name < a.since:
                continue
            days.append(day)
    if not days:
        sys.exit("No camera folders with recorded days found.")

    now = time.time()
    with tempfile.TemporaryDirectory(prefix="camvault_fix_") as tmp:
        if not a.apply:
            # look only: three segments per day are checked, which is quick and enough to tell
            bad_days = 0
            for day in days:
                segs = sorted(p for p in day.iterdir() if SEG_RE.match(p.name) and now - p.stat().st_mtime > a.min_age)
                if not segs:
                    print(f"  {day.parent.name:<20} {day.name}  nothing old enough to look at yet")
                    continue
                look = {segs[0], segs[len(segs) // 2], segs[-1]}            # first, middle and last segment of the day
                hit = any((i := probe(s)) and i["codec"] == "h264" and i["sar"] == BAD_SAR for s in look)
                bad_days += hit
                print(f"  {day.parent.name:<20} {day.name}  {len(segs):>6} segments  "
                      f"{'STRETCHED (pixel shape ' + BAD_SAR + ')' if hit else 'ok'}")
            print(f"\n{bad_days} of {len(days)} days are stretched. Run again with --apply to repair them.")
            return

        offset = None
        counts = {}
        for day in days:
            segs = sorted(p for p in day.iterdir() if SEG_RE.match(p.name) and now - p.stat().st_mtime > a.min_age)
            if not segs:
                print(f"  {day.parent.name:<20} {day.name}  nothing old enough to repair yet")
                continue
            if offset is None:
                first = next((s for s in segs if (probe(s) or {}).get("sar") == BAD_SAR), None)
                if first is None:
                    print(f"  {day.parent.name:<20} {day.name}  nothing to repair")
                    continue
                offset = calibrate(first, a.sar, tmp)
                print(f"Time stamp calibration: {offset:+.3f} s")
            day_counts = {}
            with ThreadPoolExecutor(max_workers=max(1, a.workers)) as pool:
                for r in pool.map(lambda p: repair(p, a.sar, offset, tmp), segs):
                    day_counts[r] = day_counts.get(r, 0) + 1
                    counts[r] = counts.get(r, 0) + 1
            print(f"  {day.parent.name:<20} {day.name}  " + ", ".join(f"{k}: {v}" for k, v in sorted(day_counts.items())))
        print("\nTotal: " + (", ".join(f"{k}: {v}" for k, v in sorted(counts.items())) or "nothing found"))


if __name__ == "__main__":
    main()
