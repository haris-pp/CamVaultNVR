"""
dev/setup_demo.py - get everything the CamVault demo needs, or remove it again.

    python dev/setup_demo.py              prepare the demo (safe to run again, it only does what is missing)
    python dev/setup_demo.py --no-live    ... without go2rtc (the demo then has no live picture on the Home page)
    python dev/setup_demo.py --regenerate make the sample videos again
    python dev/setup_demo.py --reset      delete the demo's database and recordings (dev/demo_data), keep the downloads
    python dev/setup_demo.py --clean      remove EVERYTHING the demo added: downloads, sample videos, demo data

What "prepare" does
  1. downloads MediaMTX (the RTSP server of the simulator) into dev/bin/      - python scripts/get_binaries.py
  2. downloads go2rtc into go2rtc/ unless it is installed already            - live view in the browser
  3. makes four short sample videos with FFmpeg into dev/samples/            - generated test patterns,
     so there is no copyrighted footage in the project and nothing large in git

Then start the demo with   python app.py --demo   (or run_demo_windows.bat).
Needs: Python 3.10+, FFmpeg on the PATH, internet access for step 1 and 2.
"""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SAMPLES = HERE / "samples"
BIN = HERE / "bin"
DATA = HERE / "demo_data"
IS_WIN = os.name == "nt"
W, H, FPS, SECONDS = 1280, 720, 15, 20

# name -> (video source, label colour). Each source is an animated test pattern made by FFmpeg itself.
CLIPS = {
    "entrance":  (f"testsrc2=size={W}x{H}:rate={FPS}", "white"),
    "parking":   (f"gradients=size={W}x{H}:rate={FPS}:speed=0.015:nb_colors=4:seed=11", "white"),
    "lobby":     (f"life=size=320x180:rate={FPS}:mold=12:ratio=0.08:random_seed=7:life_color=#33ff99:death_color=#0b2a3a,"
                  f"scale={W}:{H}:flags=neighbor", "white"),
    "warehouse": (f"testsrc=size={W}x{H}:rate={FPS}", "white"),
}

FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]


def find_font():
    return next((f for f in FONTS if Path(f).is_file()), None)


def ff_path(p):
    """A file path inside an FFmpeg filter: the drive colon of a Windows path has to be escaped."""
    return p.replace("\\", "/").replace(":", r"\:")


def make_clip(name, source, out, label=True):
    vf = ""
    font = find_font() if label else None
    if font:
        title = name.upper()
        vf = (f",drawtext=fontfile='{ff_path(font)}':text='{title}':fontcolor=white:fontsize=56:x=40:y=36:"
              f"box=1:boxcolor=black@0.55:boxborderw=14,"
              f"drawtext=fontfile='{ff_path(font)}':text='CamVault demo - simulated camera':fontcolor=white:fontsize=26:"
              f"x=40:y=116:box=1:boxcolor=black@0.55:boxborderw=8")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"{source}{vf}",
           "-t", str(SECONDS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
           "-g", str(FPS * 2), "-keyint_min", str(FPS * 2), "-sc_threshold", "0",
           "-movflags", "+faststart", "-an", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        if label and font:                                  # labels are a nicety: try again without them
            return make_clip(name, source, out, label=False)
        raise RuntimeError(r.stderr.strip() or "ffmpeg failed")


def generate(force):
    if not shutil.which("ffmpeg"):
        sys.exit("FFmpeg was not found on the PATH. Install it first (Windows: https://ffmpeg.org/download.html, "
                 "Linux: sudo apt install ffmpeg, macOS: brew install ffmpeg).")
    SAMPLES.mkdir(parents=True, exist_ok=True)
    for name, (source, _) in CLIPS.items():
        out = SAMPLES / f"{name}.mp4"
        if out.is_file() and not force:
            print(f"  {out.relative_to(ROOT)}  already there")
            continue
        print(f"  making {out.relative_to(ROOT)} ...", end=" ", flush=True)
        make_clip(name, source, out)
        print(f"{out.stat().st_size / 1e6:.1f} MB")


def run_get_binaries(*flags):
    return subprocess.run([sys.executable, str(ROOT / "scripts" / "get_binaries.py"), *flags]).returncode == 0


def remove(folder):
    if folder.is_dir():
        shutil.rmtree(folder, ignore_errors=True)
        if folder.is_dir():
            print(f"  could not remove all of {folder.relative_to(ROOT)} - is the demo still running?")
            return
        print(f"  removed {folder.relative_to(ROOT)}")
    else:
        print(f"  {folder.relative_to(ROOT)}  not there")


def main():
    ap = argparse.ArgumentParser(description="Prepare or remove the CamVault demo.")
    ap.add_argument("--no-live", action="store_true", help="do not download go2rtc")
    ap.add_argument("--regenerate", action="store_true", help="make the sample videos again")
    ap.add_argument("--reset", action="store_true", help="delete the demo database and recordings (dev/demo_data)")
    ap.add_argument("--clean", action="store_true", help="remove everything the demo added (downloads, samples, data)")
    a = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)

    if a.clean or a.reset:
        print("Stop the demo first (Ctrl+C in its window) if it is running.\n")
        remove(DATA)
        if a.clean:
            remove(BIN)
            remove(SAMPLES)
            print("\nThe demo is gone. go2rtc/ was left alone (it also serves real cameras): delete go2rtc/go2rtc(.exe) yourself if you want.")
        return

    print("1/3  MediaMTX (RTSP server for the simulated cameras)")
    ok = run_get_binaries("--mediamtx")
    if not a.no_live:
        print("\n2/3  go2rtc (live picture on the Home page)")
        ok = run_get_binaries("--go2rtc") and ok
    else:
        print("\n2/3  go2rtc skipped (--no-live)")
    print("\n3/3  Sample videos (generated test patterns)")
    generate(a.regenerate)

    print("\n" + ("Ready." if ok else "Finished, but a download failed (see above)."))
    print("Start the demo with:   python app.py --demo      (Windows: run_demo_windows.bat)")
    print("Stop it with Ctrl+C. Start the app WITHOUT --demo for normal use.")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
