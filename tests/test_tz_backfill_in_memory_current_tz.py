"""Regression test for the in-memory ``current_tz`` round-trip detection.

Audit re-2026-05-26 (gemini tz/F-001, P1): whoop_tz_backfill and gps_tz_backfill
previously queried ``pds.tz_for_instant`` for every cycle/activity, and never
updated any in-memory state when a proposal was generated. Within a single
run, an outbound-flight proposal therefore wasn't visible to subsequent rows'
comparisons — the return flight back to ET could be missed entirely because
the DB still resolved the home tz.

This test simulates a 4-cycle WHOOP run with a SAT outbound-to-Chicago
proposal at cycle 2 and the SUN return-to-NY at cycle 3. Under the fix:
  - cycle 1 (home, -05:00): no proposal (matches seeded ET).
  - cycle 2 (-06:00): outbound CHI proposal; current_tz -> Chicago.
  - cycle 3 (-05:00): EST matches Chicago's offset? NO. So return-NY
    proposal must fire from the current_tz=Chicago comparison.
  - cycle 4 (-05:00): matches NY (current_tz now NY), no proposal.

The pre-fix behavior would miss cycle 3's proposal because the mocked
tz_for_instant kept returning America/New_York every time.

Run: python tests/test_tz_backfill_in_memory_current_tz.py
"""
from __future__ import annotations
import os
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import whoop_tz_backfill as wtb  # noqa: E402


def _round_trip_cycles() -> list[dict]:
    """Four winter-2026 cycles: Sat home, Sun-Mon Chicago, Tue back home.

    Offsets used (winter, no DST in either zone):
      America/New_York = -05:00
      America/Chicago  = -06:00
    """
    return [
        # Sat night at home in NY
        {
            "cycle_id": 1001,
            "start_time": "2026-02-07T04:00:00+00:00",
            "end_time": "2026-02-07T13:00:00+00:00",
            "timezone_offset": "-05:00",
        },
        # Sun night in Chicago
        {
            "cycle_id": 1002,
            "start_time": "2026-02-08T05:00:00+00:00",
            "end_time": "2026-02-08T13:00:00+00:00",
            "timezone_offset": "-06:00",
        },
        # Mon night flying home — back in NY
        {
            "cycle_id": 1003,
            "start_time": "2026-02-09T05:00:00+00:00",
            "end_time": "2026-02-09T13:00:00+00:00",
            "timezone_offset": "-05:00",
        },
        # Tue night at home
        {
            "cycle_id": 1004,
            "start_time": "2026-02-10T04:00:00+00:00",
            "end_time": "2026-02-10T13:00:00+00:00",
            "timezone_offset": "-05:00",
        },
    ]


def test_round_trip_proposes_both_legs_on_single_run() -> None:
    cycles = _round_trip_cycles()
    history_map = {
        "-06:00": "America/Chicago",
        "-05:00": "America/New_York",
    }
    # Mock the log read: an empty user_tz_log, so the DB would answer
    # "America/New_York" at every instant and never see Chicago. The log is
    # read ONCE per run; the run's own proposals are added to the in-memory
    # copy (2026-11-14: per-cycle lookups go against that copy, not the DB).
    log_reads: list[int] = []

    def _log_mock() -> list:
        log_reads.append(1)
        return []

    with patch.object(wtb, "fetch_tz_log", side_effect=_log_mock):
        proposals = wtb.infer_proposed_inserts(cycles, history_map)

    print(f"  fetch_tz_log calls: {len(log_reads)}")
    print(f"  proposals: {[(p['effective_from'], p['tz']) for p in proposals]}")

    # Performance / leakage check: the log is read exactly once, not per-row.
    assert len(log_reads) == 1, (
        f"Expected 1 log read; saw {len(log_reads)}. The log should be read "
        f"once and looked up in memory rather than re-queried per row."
    )
    # Correctness check: both outbound AND return proposals fire on the
    # same run (under the bug, cycle 1003 would never produce a proposal
    # because the DB kept returning NY).
    assert len(proposals) == 2, (
        f"Expected 2 proposals (outbound + return). Got {len(proposals)}: "
        f"{[(p['effective_from'], p['tz']) for p in proposals]}"
    )
    outbound, ret = proposals[0], proposals[1]
    assert outbound["tz"] == "America/Chicago", outbound
    assert ret["tz"] == "America/New_York", ret
    assert outbound["effective_from"] == "2026-02-08T05:00:00+00:00"
    assert ret["effective_from"] == "2026-02-09T05:00:00+00:00"


if __name__ == "__main__":
    test_round_trip_proposes_both_legs_on_single_run()
    print("\nOK - round-trip detected on one run (in-memory current_tz).")
