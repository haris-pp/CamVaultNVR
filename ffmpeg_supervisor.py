"""
ffmpeg_supervisor.py — drop-in replacement for the supervisor block in app.py

Changes from previous version:
  1. Exponential backoff on restarts (10s → 20s → 40s … cap 600s)
  2. Cooldown resets after a sustained healthy run (5 min) — channel not penalised forever
  3. Schedule gap checker runs every 60s — restarts any channel that SHOULD be recording
     but isn't (covers missed starts, app restarts, or silent FFmpeg deaths)
"""

from __future__ import annotations

import time
import threading
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

# ── Shared state (add these near active_recordings at module level) ─────────
# recording_schedules: source_id → (schedule_data, multiDay)
# Populated inside start_recording() — see patch below.
recording_schedules = {}


# ── Backoff config ───────────────────────────────────────────────────────────
BACKOFF_BASE        = 10      # first retry after 10 s
BACKOFF_MULTIPLIER  = 2       # doubles each failure
BACKOFF_CAP         = 600     # never wait more than 10 min
MAX_RESTARTS        = 8       # give up after this many consecutive failures
HEALTHY_RUN_SEC     = 300     # 5 min of uptime resets the failure counter


def _backoff_delay(attempt: int) -> float:
    """Return seconds to wait before attempt N (0-indexed)."""
    return min(BACKOFF_BASE * (BACKOFF_MULTIPLIER ** attempt), BACKOFF_CAP)


# ── Per-source restart state ─────────────────────────────────────────────────
# {source_id: {"count": int, "next_retry_at": float, "started_at": float}}
_restart_state: dict = {}


def _record_crash(source_id: str) -> tuple[int, float]:
    """
    Register a crash, apply backoff, return (attempt_number, next_retry_at).
    Also checks whether the process ran long enough to reset the counter.
    """
    now = time.time()
    state = _restart_state.get(source_id, {"count": 0, "next_retry_at": 0, "started_at": now})

    # If the previous run was healthy for long enough, forgive past failures
    uptime = now - state.get("started_at", now)
    if uptime >= HEALTHY_RUN_SEC:
        logger.info("[SUPERVISOR] %s ran for %.0fs — resetting failure counter", source_id, uptime)
        state["count"] = 0

    attempt        = state["count"]
    delay          = _backoff_delay(attempt)
    next_retry_at  = now + delay
    state["count"] += 1
    state["next_retry_at"] = next_retry_at
    _restart_state[source_id] = state

    logger.warning(
        "[SUPERVISOR] %s crash #%d — retry in %.0fs (next attempt at %s)",
        source_id, state["count"], delay,
        datetime.fromtimestamp(next_retry_at).strftime("%H:%M:%S"),
    )
    return state["count"], next_retry_at


def _mark_started(source_id: str):
    """Call this right after a successful start_recording() to record start time."""
    state = _restart_state.get(source_id, {"count": 0, "next_retry_at": 0})
    state["started_at"] = time.time()
    _restart_state[source_id] = state


def _clear_restart_state(source_id: str):
    """Clean stop — wipe all failure history."""
    _restart_state.pop(source_id, None)


# ── Schedule gap checker ─────────────────────────────────────────────────────

def _should_be_recording_now(schedule_data: dict) -> tuple[bool, bool]:
    """
    Re-evaluate whether this source should be recording right now.
    Returns (should_record, multi_day).
    Reuses the same interval logic already in app.py.
    """
    import json
    from app import (
        build_week_intervals, merge_intervals,
        is_full_week, now_week_seconds,
        SECONDS_IN_DAY, DAY_NAME,
    )

    schedule = schedule_data.get("schedule_slots", {})
    if isinstance(schedule, str):
        schedule = json.loads(schedule)

    if not schedule:
        return False, False

    intervals = build_week_intervals(schedule)
    merged    = merge_intervals(intervals)

    if not merged:
        return False, False

    if is_full_week(merged):
        return True, True  # 24×7

    now_sec = now_week_seconds()
    for start, end in merged:
        if start <= now_sec < end:
            start_day = (start // SECONDS_IN_DAY) % 7
            end_day   = (end   // SECONDS_IN_DAY) % 7
            multi_day = start_day != end_day
            return True, multi_day

    return False, False


def _gap_checker(active_recordings, recording_schedules, recording_lock,
                 start_recording_fn, update_status_fn):
    """
    Runs every 60 s. For every known schedule, checks:
      - Is it supposed to be recording right now?
      - Is it actually recording?
    If the answer is "yes / no" — restart it.
    """
    while True:
        time.sleep(60)
        logger.debug("[GAP-CHECK] Running schedule gap check ...")

        # Snapshot so we don't hold the lock while doing I/O
        with recording_lock:
            currently_active = set(active_recordings.keys())

        for source_id, (sched_data, _) in list(recording_schedules.items()):
            try:
                should_record, multi_day = _should_be_recording_now(sched_data)

                if not should_record:
                    continue  # not in an active slot — nothing to do

                if source_id in currently_active:
                    continue  # already running — fine

                state      = _restart_state.get(source_id, {})
                attempt    = state.get("count", 0)
                retry_at   = state.get("next_retry_at", 0)

                if attempt >= MAX_RESTARTS:
                    logger.warning(
                        "[GAP-CHECK] %s should be recording but hit MAX_RESTARTS — skipping",
                        source_id,
                    )
                    continue

                if time.time() < retry_at:
                    remaining = retry_at - time.time()
                    logger.debug(
                        "[GAP-CHECK] %s gap detected but in backoff cooldown (%.0fs left)",
                        source_id, remaining,
                    )
                    continue

                logger.warning(
                    "[GAP-CHECK] %s SHOULD be recording but is NOT — restarting now",
                    source_id,
                )
                update_status_fn(source_id, "restarting", "Gap detected — auto-restart")

                try:
                    start_recording_fn(sched_data, multi_day)
                    _mark_started(source_id)
                except Exception as exc:
                    logger.error("[GAP-CHECK] Restart failed for %s: %s", source_id, exc)
                    update_status_fn(source_id, "error", f"Gap-restart failed: {exc}")
                    _record_crash(source_id)

            except Exception as exc:
                logger.error("[GAP-CHECK] Unexpected error for %s: %s", source_id, exc)


# ── Main supervisor loop ─────────────────────────────────────────────────────

def ffmpeg_supervisor(active_recordings, recording_schedules, recording_lock,
                      start_recording_fn, update_status_fn):
    """
    Replaces the inline ffmpeg_supervisor() in app.py.

    Call it as a daemon thread:
        t = threading.Thread(
                target=ffmpeg_supervisor,
                args=(active_recordings, recording_schedules, recording_lock,
                      start_recording, update_recording_status_on_schedule_db),
                daemon=True,
            )
        t.start()

    Also start the gap checker thread:
        g = threading.Thread(
                target=start_gap_checker,
                args=(active_recordings, recording_schedules, recording_lock,
                      start_recording, update_recording_status_on_schedule_db),
                daemon=True,
            )
        g.start()
    """
    while True:
        time.sleep(2)

        for source_id, info in list(active_recordings.items()):
            proc       = info["process"]
            output_dir = info["output_dir"]

            if proc.poll() is None:
                continue  # still alive

            # ── Process exited ───────────────────────────────────────────────
            exit_code = proc.returncode

            with recording_lock:
                if active_recordings.get(source_id) is info:     # never remove a newer entry for the same camera
                    active_recordings.pop(source_id, None)

            # stop_recording() ended this one on purpose (end of a slot, or a restart after a Settings change)
            if info.get("stopping"):
                logger.info("[SUPERVISOR] %s was stopped on purpose", source_id)
                _clear_restart_state(source_id)
                continue

            # exit 0 or 255 (SIGTERM from stop_recording) = intentional stop
            if exit_code in (0, -15, 255):
                logger.info("[SUPERVISOR] %s stopped cleanly (code %d)", source_id, exit_code)
                update_status_fn(source_id, "completed", "Recording stopped normally", pid=0)
                _clear_restart_state(source_id)
                continue

            # ── Unexpected crash ─────────────────────────────────────────────
            attempt, next_retry_at = _record_crash(source_id)

            if attempt > MAX_RESTARTS:
                logger.error("[SUPERVISOR] %s exceeded MAX_RESTARTS — not restarting", source_id)
                update_status_fn(
                    source_id, "error",
                    f"FFmpeg crashed {attempt}x — auto-restart disabled. Fix the source.",
                    pid=0,
                )
                continue

            sched_entry = recording_schedules.get(source_id)
            if not sched_entry:
                logger.warning("[SUPERVISOR] %s crashed but no schedule data — cannot restart", source_id)
                update_status_fn(source_id, "error", f"Crashed (code {exit_code}), no restart data", pid=0)
                continue

            schedule_data, multi_day = sched_entry

            # Check the schedule: if we're outside a recording slot, don't restart
            should_record, multi_day_now = _should_be_recording_now(schedule_data)
            if not should_record:
                logger.info(
                    "[SUPERVISOR] %s crashed but outside schedule slot — not restarting",
                    source_id,
                )
                update_status_fn(source_id, "completed", "Crashed outside schedule window", pid=0)
                _clear_restart_state(source_id)
                continue

            delay = next_retry_at - time.time()
            update_status_fn(
                source_id, "restarting",
                f"Crashed (code {exit_code}) — retry #{attempt} in {delay:.0f}s",
                pid=0,
            )

            # Spawn a one-shot timer thread so the supervisor loop isn't blocked
            def _delayed_restart(sid, sdata, mday, retry_at):
                wait = max(0.0, retry_at - time.time())
                logger.info("[SUPERVISOR] %s waiting %.0fs before restart ...", sid, wait)
                time.sleep(wait)

                # Re-check schedule at restart time (slot may have ended during backoff)
                ok, mday2 = _should_be_recording_now(sdata)
                if not ok:
                    logger.info("[SUPERVISOR] %s slot ended during backoff — skip restart", sid)
                    update_status_fn(sid, "completed", "Slot ended during backoff delay", pid=0)
                    _clear_restart_state(sid)
                    return

                if sid in active_recordings:
                    logger.info("[SUPERVISOR] %s already recording by the time retry fired", sid)
                    return

                logger.warning("[SUPERVISOR] %s restarting now (attempt #%d)", sid, attempt)
                try:
                    start_recording_fn(sdata, mday2)
                    _mark_started(sid)
                except Exception as exc:
                    logger.error("[SUPERVISOR] Restart failed for %s: %s", sid, exc)
                    update_status_fn(sid, "error", f"Restart failed: {exc}", pid=0)
                    _record_crash(sid)   # count another failure → longer next backoff

            threading.Thread(
                target=_delayed_restart,
                args=(source_id, schedule_data, multi_day, next_retry_at),
                daemon=True,
            ).start()


def start_gap_checker(active_recordings, recording_schedules, recording_lock,
                      start_recording_fn, update_status_fn):
    """Entry point for the gap-checker daemon thread."""
    _gap_checker(active_recordings, recording_schedules, recording_lock,
                 start_recording_fn, update_status_fn)