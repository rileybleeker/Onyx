#!/usr/bin/env python3
"""
Onyx HRV Backfill Detection
============================
Decides whether the HRV analysis must be retrained because the HISTORY of one of its inputs
changed since the last retrain read its data: a backdated row, an edit, or a deletion. The
inputs and how a change to each is seen live in ONE manifest, hrv_feature_sources.py, which the
retrain also uses to record what it trained on (audit PIPE-09).

Emits a GitHub Actions output flag (backfill_detected) so the companion workflow can trigger a
full analysis retrain. A check that could not be made is UNKNOWN, never "no backfill": it writes a
partial hrv_analysis|backfill_check heartbeat ("GUARD hrv_backfill_detection: ...") and retrains as
a precaution once the last retrain is a few hours old. Logs and heartbeats carry source names and
error codes only.

Runs hourly via .github/workflows/hrv-retrain-on-backfill.yml.
"""

import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from supabase import create_client

import hrv_feature_sources as sources
from sync_log_helper import log_sync

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("hrv_backfill_check")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
supa = create_client(SUPABASE_URL, SUPABASE_KEY)

ET_TZ = ZoneInfo("America/New_York")

# Heartbeat of the detection itself. A partial row repeats at most every REPEAT_HOURS while the
# same problem lasts (the /status sync history shows only the newest 100 rows); one success row is
# written when the problem clears.
HEARTBEAT = ("hrv_analysis", "backfill_check")
REPEAT_HOURS = 6


def et_today():
    return datetime.now(ET_TZ).date()


def get_last_analysis_time() -> str | None:
    """Newest hrv_analysis_results.computed_at, None when there is none. Raises on a failed read."""
    resp = (
        supa.schema("pds")
        .from_("hrv_analysis_results")
        .select("computed_at")
        .order("computed_at", desc=True)
        .limit(1)
        .execute()
    )
    if not resp.data:
        return None
    return resp.data[0]["computed_at"]


def set_output(key: str, value: str) -> None:
    out_path = os.environ.get("GITHUB_OUTPUT")
    if out_path:
        with open(out_path, "a") as f:
            f.write(f"{key}={value}\n")
    log.info(f"output: {key}={value}")


def last_retrain_tripped_a_guard() -> str | None:
    """Error text if the newest hrv_analysis|retrain heartbeat is a failed GUARD row.

    A tripped alignment guard writes no results, so last_analysis never advances and a
    pending backfill would re-trigger (and re-fail) the retrain every hour. The daily
    12:00 UTC run stays the one re-check until someone fixes the cause."""
    try:
        resp = (
            supa.schema("pds").from_("sync_log")
            .select("status,error_message")
            .eq("source", "hrv_analysis").eq("data_type", "retrain")
            .order("sync_start", desc=True).limit(1).execute()
        )
    except Exception as e:  # noqa: BLE001
        log.warning(f"  guard check failed ({sources.error_code(e)}) — ignoring")
        return None
    row = (resp.data or [None])[0]
    if row and row.get("status") == "failed" and str(row.get("error_message") or "").startswith("GUARD"):
        return row["error_message"]
    return None


def report(status: str, message: str | None, started_at: datetime) -> bool:
    """Write the detection heartbeat unless it would repeat (see HEARTBEAT). Never raises.
    Returns True when a row was written."""
    source, data_type = HEARTBEAT
    last = None
    try:
        resp = (
            supa.schema("pds").from_("sync_log")
            .select("status,error_message,sync_start")
            .eq("source", source).eq("data_type", data_type)
            .order("sync_start", desc=True).limit(1).execute()
        )
        last = (resp.data or [None])[0]
    except Exception as e:  # noqa: BLE001 - the heartbeat must never stop the decision
        log.warning(f"  heartbeat lookup failed ({sources.error_code(e)}); writing it anyway")
    if status == "success":
        if last is None or last.get("status") == "success":
            return False
    elif last and last.get("status") == status and last.get("error_message") == message:
        start = sources.parse_ts(last.get("sync_start"))
        if start and datetime.now(timezone.utc) - start < timedelta(hours=REPEAT_HOURS):
            return False
    log_sync(supa, source=source, data_type=data_type, status=status, records=0,
             started_at=started_at, error=message)
    return True


def _age_hours(ts: str | None) -> float | None:
    parsed = sources.parse_ts(ts)
    if parsed is None:
        return None
    return max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds() / 3600)


def main() -> int:
    started_at = datetime.now(timezone.utc)
    guard = last_retrain_tripped_a_guard()
    if guard:
        log.warning(f"Last retrain stopped on a guard — no hourly retry (daily run re-checks): {guard[:200]}")
        set_output("backfill_detected", "false")
        return 0

    try:
        last_analysis = get_last_analysis_time()
    except Exception as e:  # noqa: BLE001
        code = sources.error_code(e)
        msg = (f"GUARD hrv_backfill_detection: could not read the last analysis time ({code}); "
               "retraining as a precaution")
        log.warning(msg)
        report("partial", msg, started_at)
        set_output("backfill_detected", "true")
        return 0
    if last_analysis is None:
        log.info("No prior hrv_analysis_results found — signaling initial run.")
        set_output("backfill_detected", "true")
        return 0

    today = et_today()
    log.info(f"Last analysis: {last_analysis}")
    log.info(f"Watching {len(sources.SOURCES)} sources (hrv_feature_sources.py); "
             f"history = rows dated before today - settle days")

    baseline, baseline_at, baseline_error = sources.read_baseline(supa)
    det = sources.detect(supa, today, last_analysis, baseline, baseline_at, baseline_error)
    decision = sources.decide(det, _age_hours(last_analysis))

    for label in det.changed:
        log.info(f"  changed: {label}")
    for label in det.unknown:
        log.warning(f"  unknown: {label}")
    if not det.fingerprint_installed:
        log.warning("  fingerprints: pds.hrv_source_fingerprint not installed — row scans and signals only")
    log.info(f"Decision: {'retrain' if decision.retrain else 'no retrain'} ({decision.reason})")

    report(decision.status, decision.message, started_at)
    set_output("backfill_detected", "true" if decision.retrain else "false")
    return 0


if __name__ == "__main__":
    sys.exit(main())
