"""
dev/demo_stack.py - what "python app.py --demo" adds to the normal start.

Called once from app.py, and only in demo mode:

    from dev import demo_stack
    demo_stack.start(query_db, execute_db)

What it does
  1. starts the simulated cameras (dev/fake_cameras.py: MediaMTX + one looping FFmpeg per video in dev/samples/)
  2. adds each of them to the Cameras page, once (a camera that is already there is left alone)
  3. gives every camera it just added a 24/7 recording schedule, so the Playback page has footage within minutes

The demo has its own database and its own recordings folder (dev/demo_data/), so it never touches the
cameras or recordings of a normal installation. The simulated cameras stop when the app exits.
Live view in the demo needs go2rtc as usual (python scripts/get_binaries.py).

Switch the demo off by starting the app without --demo. Delete dev/demo_data/ to reset it.
"""
from __future__ import annotations

import json
import logging
import re

log = logging.getLogger("demo_stack")

# Every day, midnight to midnight: the same JSON the Schedules page saves.
ALWAYS = {d: [{"from": "00:00:00", "to": "24:00:00"}] for d in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}


def _camera_name(url: str) -> str:
    stem = url.rsplit("/", 1)[-1]                                    # "parking_lot"
    words = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", stem.replace("_", " ").replace("-", " ")).split()
    return " ".join(w[:1].upper() + w[1:] for w in words) or stem    # "Parking Lot"


def _seed_cameras(query_db, execute_db, urls: list[str]):
    """Add the simulated cameras that are not in the Cameras list yet, each with a 24/7 schedule."""
    import go2rtc_client

    for url in urls:
        if query_db("SELECT id FROM input_sources WHERE url = ?", (url,), one=True):
            continue
        name = _camera_name(url)
        folder = re.sub(r"[^A-Za-z0-9_-]", "", name.strip()) or "camera"
        execute_db("INSERT INTO input_sources (name, record_folder_name, url, sub_url) VALUES (?, ?, ?, '')",
                   (name, folder, url))
        new = query_db("SELECT id FROM input_sources WHERE url = ?", (url,), one=True)
        if not new:
            continue
        execute_db("INSERT OR IGNORE INTO schedules (source_id, schedule_slots, status) VALUES (?, ?, 'active')",
                   (new["id"], json.dumps(ALWAYS)))
        go2rtc_client.register_source(new["id"], url, "")
        log.info("[DEMO] camera added: %s  ->  %s  (recording 24/7)", name, url)


def start(query_db, execute_db) -> bool:
    """Start the simulated cameras and put them on the Cameras page. Never raises."""
    log.warning("[DEMO] DEMO MODE - simulated cameras, data in dev/demo_data/ (a normal start has none of this)")
    try:
        from dev import fake_cameras
        if not fake_cameras.start():
            return False
        _seed_cameras(query_db, execute_db, fake_cameras.urls())
        return True
    except Exception as exc:
        log.warning("[DEMO] simulated cameras not started: %s", exc)
        return False
