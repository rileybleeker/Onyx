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

    with patch.object(wtb, "fetch_tz_log", return_value=[]):
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
    with patch.object(wtb, "fetch_tz_log", return_value=[]):
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
    with patch.object(wtb, "fetch_tz_log", return_value=[]):
        proposals = wtb.infer_proposed_inserts([cycle], history_map={})
    assert proposals == [], (
        f"expected skip on unknown offset; got proposal: {proposals}"
    )
    # And the direct infer_iana call should return None too.
    iana, reason = wtb.infer_iana("+05:45", {})
    assert iana is None, f"expected None, got {iana!r} ({reason})"


def _cycle(cycle_id: int, start: str, end: str, offset: str) -> dict:
    return {"cycle_id": cycle_id, "start_time": start, "end_time": end,
            "timezone_offset": offset}


def _ts(iso: str):
    return wtb._parse_ts(iso)


def test_wide_window_skips_trips_the_log_already_covers() -> None:
    """2026-11-14 roadmap bug: over a wide --since window the pass read the log
    only at the first cycle, so later trips that already had manual rows (at
    other instants than the cycle starts) were proposed again. Each cycle must
    be checked against the log at its own instant.

    Synthetic log: a Chicago trip (Jan 2025) and a Paris trip (Jul 2025), both
    with outbound and return rows. A Los Angeles trip (Feb 2025) has no rows,
    so only its two legs should be proposed."""
    tz_log = [
        (_ts("2025-01-10T20:00:00+00:00"), "America/Chicago"),
        (_ts("2025-01-14T22:00:00+00:00"), "America/New_York"),
        (_ts("2025-07-01T10:00:00+00:00"), "Europe/Paris"),
        (_ts("2025-07-08T20:00:00+00:00"), "America/New_York"),
    ]
    cycles = [
        _cycle(1, "2025-01-05T04:00:00+00:00", "2025-01-05T12:00:00+00:00", "-05:00"),
        _cycle(2, "2025-01-11T05:00:00+00:00", "2025-01-11T13:00:00+00:00", "-06:00"),
        _cycle(3, "2025-01-12T05:00:00+00:00", "2025-01-12T13:00:00+00:00", "-06:00"),
        _cycle(4, "2025-01-15T04:00:00+00:00", "2025-01-15T12:00:00+00:00", "-05:00"),
        # Uncovered trip: Los Angeles, no log rows.
        _cycle(5, "2025-02-20T07:00:00+00:00", "2025-02-20T15:00:00+00:00", "-08:00"),
        _cycle(6, "2025-02-21T07:00:00+00:00", "2025-02-21T15:00:00+00:00", "-08:00"),
        _cycle(7, "2025-02-23T04:00:00+00:00", "2025-02-23T12:00:00+00:00", "-05:00"),
        _cycle(8, "2025-06-30T03:00:00+00:00", "2025-06-30T11:00:00+00:00", "-04:00"),
        _cycle(9, "2025-07-02T21:00:00+00:00", "2025-07-03T05:00:00+00:00", "+02:00"),
        _cycle(10, "2025-07-03T21:00:00+00:00", "2025-07-04T05:00:00+00:00", "+02:00"),
        _cycle(11, "2025-07-09T03:00:00+00:00", "2025-07-09T11:00:00+00:00", "-04:00"),
    ]
    history_map = {
        "-08:00": "America/Los_Angeles",
        "-06:00": "America/Chicago",
        "-05:00": "America/New_York",
        "-04:00": "America/New_York",
        "+02:00": "Europe/Paris",
    }
    with patch.object(wtb, "fetch_tz_log", return_value=list(tz_log)):
        proposals = wtb.infer_proposed_inserts(cycles, history_map)

    got = [(p["effective_from"], p["tz"]) for p in proposals]
    assert got == [
        ("2025-02-20T07:00:00+00:00", "America/Los_Angeles"),
        ("2025-02-23T04:00:00+00:00", "America/New_York"),
    ], f"expected only the uncovered LA trip's two legs, got: {got}"

    # The same window with the LA trip logged too proposes nothing.
    full_log = tz_log + [
        (_ts("2025-02-19T23:00:00+00:00"), "America/Los_Angeles"),
        (_ts("2025-02-22T23:00:00+00:00"), "America/New_York"),
    ]
    with patch.object(wtb, "fetch_tz_log", return_value=sorted(full_log)):
        proposals = wtb.infer_proposed_inserts(cycles, history_map)
    assert proposals == [], f"log covers every trip; got: {proposals}"


def test_tz_at_matches_tz_for_instant_rule() -> None:
    """tz_at mirrors pds.tz_for_instant: latest row at or before the instant,
    America/New_York before the first row."""
    tz_log = [
        (_ts("2025-01-10T20:00:00+00:00"), "America/Chicago"),
        (_ts("2025-01-14T22:00:00+00:00"), "America/New_York"),
    ]
    assert wtb.tz_at(tz_log, _ts("2025-01-01T00:00:00+00:00")) == "America/New_York"
    assert wtb.tz_at(tz_log, _ts("2025-01-10T20:00:00+00:00")) == "America/Chicago"
    assert wtb.tz_at(tz_log, _ts("2025-01-12T00:00:00+00:00")) == "America/Chicago"
    assert wtb.tz_at(tz_log, _ts("2025-01-20T00:00:00+00:00")) == "America/New_York"
    assert wtb.tz_at([], _ts("2025-01-20T00:00:00+00:00")) == "America/New_York"


if __name__ == "__main__":
    test_infer_proposed_inserts_builds_notes_without_nameerror()
    test_dst_artifact_cycle_is_skipped()
    test_unknown_offset_skips_instead_of_proposing_etc_utc()
    test_wide_window_skips_trips_the_log_already_covers()
    test_tz_at_matches_tz_for_instant_rule()
    print("OK — whoop_tz_backfill regression tests passed.")
