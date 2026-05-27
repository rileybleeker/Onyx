"""Regression test for garmin_etl.sync_date error propagation.

Audit re-2026-05-26 finding (etl/gemini/F-002, P0): `sync_date` wrapped each
per-type sync function in `try: ...; except Exception: counts[name] = 0`,
silently coercing exceptions to zero records. The outer loop then accumulated
total_records (0 contribution) and never incremented `errors`, so a day where
every upsert raised looked identical to a day with no Garmin data — green
sync_log row with `records=0`, no signal on /status.

Fix: `sync_date` now returns `(counts, errors)` and the outer loop folds
per-type errors into the run-level error count. Run status flips to 'failed'
when any error accumulates (records>0 or records==0).

This test simulates the "rename a required column in one upsert call site"
verification the ticket calls for, by monkeypatching `sync_daily_summary` to
raise a fake constraint-violation exception. We assert (a) sync_date returns
errors=1, (b) the other five sync functions still get called and their counts
are included, and (c) total errors propagate.

Run: python tests/test_garmin_sync_date_errors.py
"""
from __future__ import annotations
import os
import sys
from datetime import date
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("GARMIN_EMAIL", "stub@example.com")
os.environ.setdefault("GARMIN_PASSWORD", "stub")

import garmin_etl as g  # noqa: E402


class _FakeUpsertError(Exception):
    """Stand-in for a Postgres constraint violation propagated by supabase-py."""


def test_single_upsert_failure_returns_error_count() -> None:
    """sync_daily_summary raises -> sync_date returns errors=1, counts={'daily_summary': 0, ...}."""
    target = date(2026, 5, 25)

    def boom(*_args, **_kwargs):
        raise _FakeUpsertError("null value in column \"calendar_date\" violates not-null constraint")

    with patch.object(g, "sync_daily_summary", side_effect=boom), \
         patch.object(g, "sync_sleep",          return_value=1), \
         patch.object(g, "sync_heart_rate",     return_value=288), \
         patch.object(g, "sync_hrv",            return_value=1), \
         patch.object(g, "sync_stress",         return_value=1), \
         patch.object(g, "sync_training_status", return_value=1):
        counts, errors = g.sync_date(garmin=None, sb=None, target_date=target)

    assert errors == 1, f"expected 1 error, got {errors}"
    assert counts["daily_summary"] == 0
    assert counts["sleep"] == 1
    assert counts["heart_rate"] == 288
    assert sum(counts.values()) == 292  # five successful + zero from the failure


def test_all_upserts_failing_returns_six_errors_and_zero_records() -> None:
    """Worst case: every sync_* raises. sync_date must return errors=6, records=0.

    This is the bug repro: pre-fix, this scenario returned `counts={... all
    zeroes}` with NO error signal, so the outer loop saw `day_total=0` and
    silently moved on.
    """
    target = date(2026, 5, 25)

    def boom(*_args, **_kwargs):
        raise _FakeUpsertError("simulated broken upsert")

    with patch.object(g, "sync_daily_summary", side_effect=boom), \
         patch.object(g, "sync_sleep",          side_effect=boom), \
         patch.object(g, "sync_heart_rate",     side_effect=boom), \
         patch.object(g, "sync_hrv",            side_effect=boom), \
         patch.object(g, "sync_stress",         side_effect=boom), \
         patch.object(g, "sync_training_status", side_effect=boom):
        counts, errors = g.sync_date(garmin=None, sb=None, target_date=target)

    assert errors == 6, f"expected 6 errors, got {errors}"
    assert all(c == 0 for c in counts.values())
    assert sum(counts.values()) == 0


def test_no_failure_returns_zero_errors() -> None:
    target = date(2026, 5, 25)
    with patch.object(g, "sync_daily_summary", return_value=1), \
         patch.object(g, "sync_sleep",          return_value=1), \
         patch.object(g, "sync_heart_rate",     return_value=288), \
         patch.object(g, "sync_hrv",            return_value=1), \
         patch.object(g, "sync_stress",         return_value=1), \
         patch.object(g, "sync_training_status", return_value=1):
        counts, errors = g.sync_date(garmin=None, sb=None, target_date=target)
    assert errors == 0
    assert sum(counts.values()) == 293


if __name__ == "__main__":
    test_single_upsert_failure_returns_error_count()
    test_all_upserts_failing_returns_six_errors_and_zero_records()
    test_no_failure_returns_zero_errors()
    print("OK — garmin sync_date error-propagation tests passed.")
