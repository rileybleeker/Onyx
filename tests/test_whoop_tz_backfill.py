"""Regression test for whoop_tz_backfill.py notes-building branch.

Audit re-2026-05-26 finding (tz/gpt-5/F-001, promoted P1->P0): the proposal
notes f-string referenced `log_offset_str`, a name never bound in scope. Any
real-travel cycle that survived the DST-artifact filter would hit a NameError
and the script would abort before inserting anything.

The fix renamed it to `log_offset_at_start`. This test exercises the
notes-building branch end-to-end with a mocked Supabase RPC + a synthetic
cycle whose offset disagrees with the log — the exact path the bug lived on —
so a future rename that drops back to an undefined name fails CI.

Run: python tests/test_whoop_tz_backfill.py
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


def test_infer_proposed_inserts_builds_notes_without_nameerror() -> None:
    """A non-ET WHOOP cycle whose offset disagrees with the log must produce a
    proposal — and the notes string must build without raising NameError."""
    # Synthetic cycle: -06:00 (Chicago) while log says America/New_York (-05:00 EST).
    cycle = {
        "cycle_id": 9999,
        "start_time": "2026-02-01T05:00:00+00:00",
        "end_time": "2026-02-02T05:00:00+00:00",
        "timezone_offset": "-06:00",
    }
    history_map = {"-06:00": "America/Chicago"}

    with patch.object(wtb, "tz_for_instant_via_pg", return_value="America/New_York"):
        proposals = wtb.infer_proposed_inserts([cycle], history_map)

    assert len(proposals) == 1, f"expected 1 proposal, got {len(proposals)}"
    p = proposals[0]
    assert p["tz"] == "America/Chicago"
    notes = p["notes"]
    assert "cycle 9999" in notes
    assert "-06:00" in notes
    # The bug was that this branch crashed instead of rendering — assert the
    # offset got templated into the notes, not just any string.
    assert "(-05:00)" in notes, f"expected log offset '(-05:00)' rendered, got: {notes}"


def test_dst_artifact_cycle_is_skipped() -> None:
    """When WHOOP's offset matches log_offset_at_start OR log_offset_at_end, the
    cycle is a DST artifact and must not produce a proposal."""
    # log_tz America/New_York; cycle's whoop offset matches start_at_offset.
    cycle = {
        "cycle_id": 1,
        "start_time": "2026-03-01T05:00:00+00:00",
        "end_time": "2026-03-02T05:00:00+00:00",
        "timezone_offset": "-05:00",  # matches NY EST at start
    }
    with patch.object(wtb, "tz_for_instant_via_pg", return_value="America/New_York"):
        proposals = wtb.infer_proposed_inserts([cycle], history_map={})
    assert proposals == []


def test_unknown_offset_skips_instead_of_proposing_etc_utc() -> None:
    """When an offset is not in user history AND not in the generic map, the
    backfill must SKIP the proposal rather than fall back to Etc/UTC. The old
    Etc/UTC fallback (gemini tz/F-003) would propose Etc/UTC on every cycle of
    a trip because Etc/UTC's offset (+00:00) never matches the WHOOP offset
    that triggered the proposal — infinite oscillation."""
    # Use an offset the generic map definitely doesn't cover (+05:45 = Nepal).
    cycle = {
        "cycle_id": 4242,
        "start_time": "2026-04-01T18:00:00+00:00",
        "end_time": "2026-04-02T18:00:00+00:00",
        "timezone_offset": "+05:45",
    }
    # Ensure the generic-map fallback doesn't accidentally cover this offset.
    assert "+05:45" not in wtb.GENERIC_OFFSET_IANA, (
        "test premise broken: +05:45 is now in the generic map; pick a new "
        "obscure offset for this test."
    )
    with patch.object(wtb, "tz_for_instant_via_pg", return_value="America/New_York"):
        proposals = wtb.infer_proposed_inserts([cycle], history_map={})
    assert proposals == [], (
        f"expected skip on unknown offset; got proposal: {proposals}"
    )
    # And the direct infer_iana call should return None too.
    iana, reason = wtb.infer_iana("+05:45", {})
    assert iana is None, f"expected None, got {iana!r} ({reason})"


if __name__ == "__main__":
    test_infer_proposed_inserts_builds_notes_without_nameerror()
    test_dst_artifact_cycle_is_skipped()
    test_unknown_offset_skips_instead_of_proposing_etc_utc()
    print("OK — whoop_tz_backfill regression tests passed.")
