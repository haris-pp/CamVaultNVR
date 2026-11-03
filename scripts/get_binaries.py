"""
scripts/get_binaries.py - download the optional helper programs CamVault can use.

    python scripts/get_binaries.py              go2rtc only (live view in the browser)
    python scripts/get_binaries.py --mediamtx   MediaMTX only (needed by the demo cameras)
    python scripts/get_binaries.py --all        both
    python scripts/get_binaries.py --force      download again even if already installed

Where things go (all of these folders are git-ignored, nothing is ever committed):
    go2rtc/go2rtc(.exe)       live view      https://github.com/AlexxIT/go2rtc            MIT licence
    dev/bin/mediamtx(.exe)    demo cameras   https://github.com/bluenviron/mediamtx       MIT licence

Nothing here is needed to RECORD. Without go2rtc the Home page just shows no live picture,
and MediaMTX is only used by the demo (python app.py --demo).

Options
    --go2rtc-version v1.9.14     use a fixed go2rtc release instead of the latest one
    --mediamtx-version 1.15.1    use another MediaMTX release (the default one is the one the demo was tested with)

Only Python's standard library is used. The programs come straight from the projects' GitHub releases;
the script prints the address it downloads from, and runs "<program> --version" afterwards to prove it works.
"""
import argparse
import io
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IS_WIN = os.name == "nt"
EXE = ".exe" if IS_WIN else ""

MEDIAMTX_DEFAULT = "1.15.1"
UA = {"User-Agent": "camvault-nvr/get_binaries"}


# ------------------------------------------------------------- platform ---
def platform_key():
    """('windows' | 'linux' | 'darwin', 'amd64' | 'arm64' | 'armv7' | '386')"""
    system = platform.system().lower()
    system = {"windows": "windows", "linux": "linux", "darwin": "darwin"}.get(system)
    machine = platform.machine().lower()
    arch = {"x86_64": "amd64", "amd64": "amd64", "x64": "amd64",
            "aarch64": "arm64", "arm64": "arm64",
            "armv7l": "armv7", "armv8l": "armv7", "armv6l": "armv6",
            "i386": "386", "i686": "386", "x86": "386"}.get(machine)
    if not system or not arch:
        sys.exit(f"Unsupported system: {platform.system()} / {platform.machine()}. "
                 "Download go2rtc / MediaMTX by hand from their GitHub releases pages.")
    return system, arch


def go2rtc_assets(system, arch):
    """Release file names of go2rtc for this computer, best first."""
    if system == "windows":
        return {"amd64": ["go2rtc_win64.zip"], "arm64": ["go2rtc_win_arm64.zip"],
                "386": ["go2rtc_win32.zip"]}.get(arch, [])
    if system == "darwin":
        return {"amd64": ["go2rtc_mac_amd64.zip"], "arm64": ["go2rtc_mac_arm64.zip"]}.get(arch, [])
    return {"amd64": ["go2rtc_linux_amd64"], "arm64": ["go2rtc_linux_arm64"],
            "armv7": ["go2rtc_linux_arm"], "armv6": ["go2rtc_linux_armv6"],
            "386": ["go2rtc_linux_i386"]}.get(arch, [])


def mediamtx_assets(system, arch, version):
    """Release file names of MediaMTX for this computer. Several are tried: the project renamed some of them over time."""
    v = f"mediamtx_v{version}"
    if system == "windows":
        return [f"{v}_windows_amd64.zip"] if arch == "amd64" else []
    if system == "darwin":
        return [f"{v}_darwin_{arch}.tar.gz"] if arch in ("amd64", "arm64") else []
    names = {"amd64": [f"{v}_linux_amd64.tar.gz"],
             "arm64": [f"{v}_linux_arm64.tar.gz", f"{v}_linux_arm64v8.tar.gz"],
             "armv7": [f"{v}_linux_armv7.tar.gz"], "armv6": [f"{v}_linux_armv6.tar.gz"]}
    return names.get(arch, [])


# ------------------------------------------------------------- download ---
def fetch(url):
    """Download `url` into memory with a simple progress line. Returns bytes, or None on 404."""
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            buf, got = io.BytesIO(), 0
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                buf.write(chunk)
                got += len(chunk)
                if sys.stdout.isatty():
                    pct = f"{got * 100 // total}%" if total else ""
                    print(f"\r    {got / 1e6:6.1f} MB {pct}   ", end="", flush=True)
            if sys.stdout.isatty():
                print()
            return buf.getvalue()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def pick_from_archive(data, name, wanted):
    """Return the bytes of the file called `wanted` (any folder) inside a .zip / .tar.gz held in memory."""
    if name.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                if not info.is_dir() and Path(info.filename).name == wanted:
                    return z.read(info)
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as t:
            for m in t.getmembers():
                if m.isfile() and Path(m.name).name == wanted:
                    return t.extractfile(m).read()
    raise RuntimeError(f"{wanted} was not found inside {name}")


def install(label, urls, dest, wanted_in_archive):
    """Try every url until one exists; write the program to `dest`; check it runs."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    for url in urls:
        name = url.rsplit("/", 1)[-1]
        print(f"  downloading {url}")
        data = fetch(url)
        if data is None:
            print("    not found, trying the next name" if url != urls[-1] else "    not found")
            continue
        payload = data if wanted_in_archive is None else pick_from_archive(data, name, wanted_in_archive)
        tmp = dest.with_name(dest.name + ".part")
        tmp.write_bytes(payload)
        tmp.chmod(tmp.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        try:
            os.replace(tmp, dest)
        except PermissionError:
            tmp.unlink(missing_ok=True)
            sys.exit(f"  {dest.name} is in use - close CamVault (and go2rtc / MediaMTX) and run this again.")
        return True
    return False


def check_runs(exe, flag):
    try:
        out = subprocess.run([str(exe), flag], capture_output=True, text=True, timeout=15)
        text = (out.stdout or out.stderr).strip().splitlines()
        return text[0] if text else "ok"
    except Exception as exc:
        return f"DID NOT RUN ({exc})"


# ------------------------------------------------------------- programs ---
def get_go2rtc(args, system, arch):
    dest = ROOT / "go2rtc" / f"go2rtc{EXE}"
    print("go2rtc  (live view)")
    if dest.is_file() and not args.force:
        print(f"  already installed: {dest.relative_to(ROOT)}   [{check_runs(dest, '-version')}]")
        return True
    names = go2rtc_assets(system, arch)
    if not names:
        print(f"  no go2rtc build for {system}/{arch} - get one from https://github.com/AlexxIT/go2rtc/releases")
        return False
    base = ("https://github.com/AlexxIT/go2rtc/releases/latest/download" if not args.go2rtc_version
            else f"https://github.com/AlexxIT/go2rtc/releases/download/{args.go2rtc_version}")
    ok = install("go2rtc", [f"{base}/{n}" for n in names], dest, f"go2rtc{EXE}" if names[0].endswith(".zip") else None)
    if ok:
        print(f"  installed: {dest.relative_to(ROOT)}   [{check_runs(dest, '-version')}]")
    else:
        print("  could not download go2rtc (no internet? blocked by a firewall?). "
              "Download it by hand from https://github.com/AlexxIT/go2rtc/releases and put it in the go2rtc folder.")
    return ok


def get_mediamtx(args, system, arch):
    dest = ROOT / "dev" / "bin" / f"mediamtx{EXE}"
    print("MediaMTX  (RTSP server for the demo cameras)")
    if dest.is_file() and not args.force:
        print(f"  already installed: {dest.relative_to(ROOT)}   [{check_runs(dest, '--version')}]")
        return True
    names = mediamtx_assets(system, arch, args.mediamtx_version)
    if not names:
        print(f"  no MediaMTX build for {system}/{arch} - get one from https://github.com/bluenviron/mediamtx/releases")
        return False
    base = f"https://github.com/bluenviron/mediamtx/releases/download/v{args.mediamtx_version}"
    ok = install("MediaMTX", [f"{base}/{n}" for n in names], dest, f"mediamtx{EXE}")
    if ok:
        print(f"  installed: {dest.relative_to(ROOT)}   [{check_runs(dest, '--version')}]")
    else:
        print("  could not download MediaMTX. Download it by hand from https://github.com/bluenviron/mediamtx/releases "
              "and put mediamtx(.exe) into dev/bin/")
    return ok


def main():
    ap = argparse.ArgumentParser(description="Download the optional helper programs (go2rtc, MediaMTX).")
    ap.add_argument("--go2rtc", action="store_true", help="download go2rtc (default when nothing is chosen)")
    ap.add_argument("--mediamtx", action="store_true", help="download MediaMTX (demo cameras)")
    ap.add_argument("--all", action="store_true", help="download both")
    ap.add_argument("--force", action="store_true", help="download again even if already installed")
    ap.add_argument("--go2rtc-version", default="", metavar="TAG", help="e.g. v1.9.14 (default: latest)")
    ap.add_argument("--mediamtx-version", default=MEDIAMTX_DEFAULT, metavar="X.Y.Z")
    args = ap.parse_args()

    want_g = args.go2rtc or args.all or not args.mediamtx
    want_m = args.mediamtx or args.all
    system, arch = platform_key()
    print(f"System: {system}/{arch}\n")

    results = []
    if want_g:
        results.append(get_go2rtc(args, system, arch))
    if want_m:
        results.append(get_mediamtx(args, system, arch))
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
