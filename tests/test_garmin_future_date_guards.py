"""Regression test for per-sync future-date guards in garmin_etl.

Audit re-2026-05-26 (deepseek etl F-002, P1): main() now sources `today`
from ET-local at the iteration boundary, but sync_heart_rate / sync_hrv /
sync_stress / sync_training_status individually had no future-date guard.
A direct call (manual one-shot, --backfill, future refactor) could hand
them a date past today and they would happily query the Garmin API and
upsert a stub row. The defense-in-depth fix adds `_is_future_et(...)` at
the top of every sync_* function.

This test patches the Garmin client + Supabase client to fakes that would
fail loudly if invoked, then calls each sync_* with a date set 5 days in
the future. Each must return 0 (clean no-op) without touching the API.

Run: python tests/test_garmin_future_date_guards.py
"""
from __future__ import annotations
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("GARMIN_EMAIL", "stub@example.com")
os.environ.setdefault("GARMIN_PASSWORD", "stub")

import garmin_etl as g  # noqa: E402


class _BoomGarmin:
    """Every API method raises — verifies guard short-circuits before any call."""
    def __getattr__(self, name):
        def _boom(*args, **kwargs):
            raise AssertionError(
                f"Garmin client method {name!r} should not be reached for "
                f"a future-dated sync. Future guard regressed."
            )
        return _boom


class _BoomSupabase:
    def schema(self, *a, **kw):
        raise AssertionError("Supabase write attempted for future date.")


def _future_date() -> date:
    return datetime.now(ZoneInfo("America/New_York")).date() + timedelta(days=5)


def test_all_sync_functions_skip_future_dates() -> None:
    fut = _future_date()
    garmin = _BoomGarmin()
    sb = _BoomSupabase()
    guarded = [
        g.sync_daily_summary,
        g.sync_sleep,
        g.sync_heart_rate,
        g.sync_hrv,
        g.sync_stress,
        g.sync_training_status,
    ]
    for fn in guarded:
        result = fn(garmin, sb, fut)
        assert result == 0, (
            f"{fn.__name__}({fut}) should return 0 for a future date; got {result}"
        )
        print(f"  {fn.__name__:<28} -> 0 (future-date guard fired)")


def test_helper_recognizes_today_as_not_future() -> None:
    today = datetime.now(ZoneInfo("America/New_York")).date()
    yesterday = today - timedelta(days=1)
    tomorrow = today + timedelta(days=1)
    assert g._is_future_et(yesterday, "test") is False
    assert g._is_future_et(today, "test") is False
    assert g._is_future_et(tomorrow, "test") is True


if __name__ == "__main__":
    test_helper_recognizes_today_as_not_future()
    test_all_sync_functions_skip_future_dates()
    print("\nOK - all per-function future-date guards fire correctly.")
