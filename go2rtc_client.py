from __future__ import annotations

"""
go2rtc_client.py — tiny helper that keeps go2rtc (the live-view gateway) in sync
with the camera list stored in SQLite.

go2rtc is OPTIONAL: if it is not running, every function here fails quietly and
the rest of the app (recording, playback, schedules) is not affected.

Stream naming (one name per camera, plus an optional low-resolution substream):
    cam_<id>        main stream   (full resolution, used for full-screen live view)
    cam_<id>_sub    substream     (low resolution, used for tiles when available)
"""

import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request

logger = logging.getLogger(__name__)

# Where Flask talks to go2rtc (same machine) and which port browsers use to reach it.
API_URL     = os.environ.get("GO2RTC_API", "http://127.0.0.1:1984").rstrip("/")
PUBLIC_PORT = os.environ.get("GO2RTC_PUBLIC_PORT", "1984")


def main_name(source_id) -> str:
    return f"cam_{source_id}"


def sub_name(source_id) -> str:
    return f"cam_{source_id}_sub"


def _call(method: str, path: str, params: dict | None = None, timeout: float = 3.0):
    url = API_URL + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def is_up() -> bool:
    try:
        _call("GET", "/api/streams", timeout=1.5)
        return True
    except Exception:
        return False


def list_streams() -> dict:
    """Return {stream_name: {...}} currently known to go2rtc ({} if unreachable)."""
    try:
        return json.loads(_call("GET", "/api/streams", timeout=2.0) or b"{}")
    except Exception:
        return {}


def _to_src(url: str) -> str:
    """go2rtc reads rtsp/http/rtmp natively; plain udp/rtp/srt inputs go through FFmpeg (stream copy)."""
    if url.lower().startswith(("udp://", "rtp://", "srt://", "tcp://")):
        return f"ffmpeg:{url}#video=copy#audio=copy"
    return url


def register_source(source_id, url: str, sub_url: str = "") -> bool:
    """Create/replace the go2rtc streams for one camera."""
    try:
        _call("PUT", "/api/streams", {"name": main_name(source_id), "src": _to_src(url)})
        if sub_url:
            _call("PUT", "/api/streams", {"name": sub_name(source_id), "src": _to_src(sub_url)})
        else:
            try:
                _call("DELETE", "/api/streams", {"src": sub_name(source_id)})
            except Exception:
                pass
        return True
    except Exception as exc:
        logger.warning("[GO2RTC] could not register source %s: %s", source_id, exc)
        return False


def remove_source(source_id) -> bool:
    ok = True
    for name in (main_name(source_id), sub_name(source_id)):
        try:
            _call("DELETE", "/api/streams", {"src": name})
        except Exception as exc:
            ok = False
            logger.debug("[GO2RTC] remove %s failed: %s", name, exc)
    return ok


def sync_loop(get_sources, interval: int = 30):
    """
    Daemon loop: every `interval` seconds make sure every camera in the database
    exists in go2rtc. This covers go2rtc starting after Flask, or being restarted
    (streams added through the API are not saved by go2rtc itself).

    get_sources: callable returning a list of dicts with keys id, url, sub_url.
    """
    was_up = None
    while True:
        try:
            up = is_up()
            if up != was_up:
                logger.info("[GO2RTC] %s", "connected" if up else "not reachable (live view disabled)")
                was_up = up
            if up:
                known = set(list_streams().keys())
                for src in get_sources():
                    sid = src["id"]
                    wanted_sub = bool(src.get("sub_url"))
                    missing = main_name(sid) not in known or (wanted_sub and sub_name(sid) not in known)
                    if missing:
                        register_source(sid, src["url"], src.get("sub_url") or "")
        except Exception as exc:
            logger.error("[GO2RTC] sync error: %s", exc)
        time.sleep(interval)
