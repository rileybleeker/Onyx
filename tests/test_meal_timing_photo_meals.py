"""Structure test: sql/meal_timing_from_photo_meals.sql (2026-11-16).

Pins the shape of the photo-meal timing view offline, without a database:
  - one row per behavioral day over pds.photo_meals, real meals only
    (capture_kind = 'photo', deleted_at IS NULL — drinks and tombstones
    excluded),
  - local-zone decimal hours via pds.tz_for_instant (not hardcoded ET),
  - the same columns and WHOOP main-cycle bedtime anchor as
    pds.meal_timing_from_cronometer, so the two COALESCE cleanly later,
  - additive only (CREATE OR REPLACE, no DROP), security_invoker, owner /
    service-role access only, and the documented note that it is not yet in
    the matrix (no touching of the matview or the canonical view).

Synthetic only: greps the SQL file, no live data, no network.

Run: python tests/test_meal_timing_photo_meals.py
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQL = ROOT / "sql" / "meal_timing_from_photo_meals.sql"

REQUIRED_COLUMNS = [
    "calendar_date",
    "first_meal_time",
    "last_meal_time",
    "first_meal_hour",
    "last_meal_hour",
    "eating_window_hours",
    "meal_event_count",
    "sleep_start_time",
    "last_meal_to_bedtime_minutes",
]


def main() -> int:
    failures: list[str] = []
    text = SQL.read_text(encoding="utf-8")

    def check(name: str, pattern: str, flags: int = 0) -> None:
        if not re.search(pattern, text, flags):
            failures.append(name)

    check("creates the view (CREATE OR REPLACE, no DROP)",
          r"CREATE OR REPLACE VIEW pds\.meal_timing_from_photo_meals")
    for bad in re.findall(r"\bDROP\s+(TABLE|VIEW|MATERIALIZED|FUNCTION|POLICY|INDEX|TRIGGER)\b", text, re.I):
        failures.append(f"no DROP statements allowed, found: DROP {bad}")

    for col in REQUIRED_COLUMNS:
        check(f"column {col}", rf"AS {col}\b")

    # Real meals only: photo kind, soft-delete tombstone excluded.
    check("filters capture_kind = 'photo'", r"capture_kind\s*=\s*'photo'")
    check("excludes soft-deleted rows (deleted_at IS NULL)", r"deleted_at\s+IS\s+NULL")
    check("reads eaten_at (the truthful instant)", r"pm\.eaten_at\b")

    # Local zone, not hardcoded ET.
    check("local decimal hour via pds.tz_for_instant",
          r"pds\.tz_for_instant\(pm\.eaten_at\)")

    # Same WHOOP main-cycle bedtime anchor as the Cronometer view.
    check("WHOOP main-cycle LATERAL (longest cycle of the day)",
          r"onyx_behavioral_date = agg\.calendar_date")
    check("longest-cycle ordering", r"\(wc2\.end_time - wc2\.start_time\) DESC NULLS LAST")
    check("non-nap SCORED sleep join", r"ws\.is_nap = false AND ws\.score_state = 'SCORED'")
    check("bedtime gap in minutes from sleep_start_time",
          r"ws\.start_time - agg\.last_meal_time\) / 60\.0")

    # Additive-only matrix discipline.
    check("does not touch daily_health_matrix_behavioral",
          r"NOT\s+wired\s+into\s+pds\.daily_health_matrix_behavioral")
    check("documents the later COALESCE wiring",
          r"COALESCE\(mtc\.<x>,\s*mtpm\.<x>,\s*mt\.<x>\)")
    check("does not recreate the matview itself",
          r"daily_health_matrix_behavioral_mat\b")
    if re.search(r"CREATE\s+(OR\s+REPLACE\s+)?MATERIALIZED\s+VIEW", text, re.I):
        failures.append("must not create or recreate the matview in this file")

    # Access: security_invoker, owner/service only.
    check("security_invoker", r"security_invoker\s*=\s*true")
    check("revokes anon", r"REVOKE ALL ON pds\.meal_timing_from_photo_meals FROM anon")
    check("grants authenticated", r"GRANT SELECT ON pds\.meal_timing_from_photo_meals TO authenticated")
    check("grants service_role", r"GRANT SELECT ON pds\.meal_timing_from_photo_meals TO authenticated, service_role")

    if failures:
        print("test_meal_timing_photo_meals: FAILED")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("test_meal_timing_photo_meals: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
