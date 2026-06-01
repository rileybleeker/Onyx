#!/usr/bin/env python3
"""Import a Cronometer CSV export into Supabase (pds.cronometer_*).

Cronometer (cronometer.com) replaced MyFitnessPal as Onyx's new-day nutrition
source on 2026-05-31. Cronometer has no scheduled/emailed export and no official
API, so ingestion is a manual web download (More -> Account -> Account Data ->
Export Data) dropped into cronometer_inbox/ and picked up by cronometer_watcher.py,
or imported directly with this CLI.

Usage:
    python cronometer_import.py <path> [<path> ...] [--dry-run]

<path> may be any mix of:
    - a .zip bundle of Cronometer CSVs
    - a directory containing the CSVs
    - servings.csv and/or dailysummary.csv directly

Files are classified by their header row (not filename), so renamed exports work.

Idempotency:
    - cronometer_nutrition_daily : upsert on calendar_date (from dailysummary "Total" rows).
    - cronometer_servings        : delete-by-calendar_date + insert (reflects edits/deletes
                                   in the source export; survives re-import of the same range).

Conventions honored (see CLAUDE.md):
    - utf-8-sig read (Cronometer exports carry a BOM; micro sign is UTF-8 'µ').
    - JSONB columns get raw dicts, NEVER json.dumps (supabase-py serializes natively).
    - pds.sync_log heartbeat on EVERY run, success AND failure, one per data_type.
    - ADR-0001 triple-date: with no per-entry Time (Gold-only), behavioral = et = local
      = calendar_date (manual-backdate convention, same as MFP). If a Gold "Time" column
      is present, event_time is parsed and behavioral_date is derived via the -6h rule.
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import sys
import tempfile
import zipfile
from datetime import date, datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from supabase import create_client

from sync_log_helper import log_sync, now_epoch

load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ET = ZoneInfo("America/New_York")
BATCH = 500

# ── Cronometer nutrient header (paren-unit stripped, lowercased) -> db column ──
# Names are unique after removing the "(unit)" groups, so we key on the name and
# carry the unit in the column name. Future-proof entries (beta-carotene, biotin,
# choline, iodine, chromium, molybdenum) are not in the current default export but
# map cleanly if Cronometer ever emits them.
NAME_TO_COL: dict[str, str] = {
    "energy": "calories",
    "alcohol": "alcohol_g",
    "caffeine": "caffeine_mg",
    "oxalate": "oxalate_mg",
    "phytate": "phytate_mg",
    "water": "water_g",
    "b1": "b1_thiamine_mg",
    "b2": "b2_riboflavin_mg",
    "b3": "b3_niacin_mg",
    "b5": "b5_pantothenic_mg",
    "b6": "b6_pyridoxine_mg",
    "b12": "b12_cobalamin_mcg",
    "folate": "folate_mcg",
    "vitamin a": "vit_a_rae_mcg",
    "vitamin c": "vit_c_mg",
    "vitamin d": "vit_d_iu",
    "vitamin e": "vit_e_mg",
    "vitamin k": "vit_k_mcg",
    "calcium": "calcium_mg",
    "copper": "copper_mg",
    "iron": "iron_mg",
    "magnesium": "magnesium_mg",
    "manganese": "manganese_mg",
    "phosphorus": "phosphorus_mg",
    "potassium": "potassium_mg",
    "selenium": "selenium_mcg",
    "sodium": "sodium_mg",
    "zinc": "zinc_mg",
    "net carbs": "net_carbs_g",
    "carbs": "carbs_g",
    "fiber": "fiber_g",
    "insoluble fiber": "insoluble_fiber_g",
    "soluble fiber": "soluble_fiber_g",
    "starch": "starch_g",
    "sugars": "sugars_g",
    "added sugars": "added_sugars_g",
    "fat": "fat_g",
    "cholesterol": "cholesterol_mg",
    "monounsaturated": "monounsaturated_g",
    "polyunsaturated": "polyunsaturated_g",
    "saturated": "saturated_g",
    "trans-fats": "trans_fat_g",
    "omega-3": "omega3_g",
    "ala": "ala_g",
    "dha": "dha_g",
    "epa": "epa_g",
    "omega-6": "omega6_g",
    "aa": "aa_g",
    "la": "la_g",
    "cystine": "cystine_g",
    "histidine": "histidine_g",
    "isoleucine": "isoleucine_g",
    "leucine": "leucine_g",
    "lysine": "lysine_g",
    "methionine": "methionine_g",
    "phenylalanine": "phenylalanine_g",
    "protein": "protein_g",
    "threonine": "threonine_g",
    "tryptophan": "tryptophan_g",
    "tyrosine": "tyrosine_g",
    "valine": "valine_g",
    # future-proof (not in current export)
    "beta-carotene": "beta_carotene_mcg",
    "biotin": "b7_biotin_mcg",
    "b7": "b7_biotin_mcg",
    "choline": "choline_mg",
    "iodine": "iodine_mcg",
    "chromium": "chromium_mcg",
    "molybdenum": "molybdenum_mcg",
}

_PAREN = re.compile(r"\s*\([^)]*\)")
_WS = re.compile(r"\s+")


def norm_header(h: str) -> str:
    """Strip unit parentheses, lowercase, collapse whitespace.

    'B12 (Cobalamin) (µg)' -> 'b12'; 'Net Carbs (g)' -> 'net carbs'.
    """
    return _WS.sub(" ", _PAREN.sub("", h)).strip().lower()


def to_num(value: str | None):
    """Blank cell -> None (NOT 0); Cronometer leaves missing values empty."""
    if value is None:
        return None
    v = value.strip()
    if v == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def parse_date(value: str) -> str | None:
    """Normalize a Cronometer date cell to YYYY-MM-DD (ISO or US M/D/YYYY)."""
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d"):
        try:
            return datetime.strptime(value.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def parse_time(value: str | None) -> dtime | None:
    """Parse a Cronometer Gold 'Time' cell ('9:59 AM') -> datetime.time. NULL otherwise."""
    if not value:
        return None
    v = value.strip()
    if v == "":
        return None
    for fmt in ("%I:%M %p", "%I:%M:%S %p", "%H:%M", "%H:%M:%S"):
        try:
            return datetime.strptime(v, fmt).time()
        except ValueError:
            continue
    return None


_AMOUNT = re.compile(r"^\s*([0-9]*\.?[0-9]+)\s+(.*)$")


def parse_amount(raw: str | None):
    """'40.00 g' -> (40.0, 'g'); '1.00 x 3.0 scoops' -> (1.0, 'x 3.0 scoops')."""
    if not raw:
        return None, None
    m = _AMOUNT.match(raw.strip())
    if not m:
        return None, None
    try:
        amount = float(m.group(1))
    except ValueError:
        amount = None
    unit = m.group(2).strip() or None
    return amount, unit


def load_tz_log(sb) -> list[tuple[datetime, str]]:
    """Load pds.user_tz_log — the materialized TZ ladder (manual + GPS-auto +
    WHOOP-auto entries all land here). Returns [(effective_from_utc, iana_tz), ...]
    sorted ascending. Empty list (→ ET fallback) on dry-run or any error.
    """
    if sb is None:
        return []
    try:
        rows = (
            sb.schema("pds").table("user_tz_log")
            .select("effective_from,tz").order("effective_from").execute().data
        ) or []
    except Exception:  # noqa: BLE001
        return []
    out: list[tuple[datetime, str]] = []
    for r in rows:
        try:
            eff = datetime.fromisoformat(str(r["effective_from"]).replace("Z", "+00:00"))
            out.append((eff, r["tz"]))
        except Exception:  # noqa: BLE001
            continue
    return out


def resolve_tz(tz_log: list[tuple[datetime, str]], day_iso: str) -> str:
    """IANA TZ Riley was physically in on `day_iso`, via the user_tz_log ladder
    (latest effective_from <= noon of that day). Defaults to America/New_York (home).
    Cronometer's export time carries no offset, so this is how we recover the TZ —
    the same ladder every other source resolves through (Resolution: Manual > GPS > WHOOP).
    """
    probe = datetime.strptime(day_iso, "%Y-%m-%d").replace(hour=12, tzinfo=timezone.utc)
    tz = "America/New_York"
    for eff, name in tz_log:  # ascending
        if eff <= probe:
            tz = name
        else:
            break
    return tz


def behavioral_dates(day_iso: str, t: dtime | None, tz_log: list[tuple[datetime, str]] | None = None):
    """Return (event_time, et_date, behavioral_date, local_date, tz_source).

    No per-entry time (free tier / untimed entry) → all three Onyx dates collapse to
    the clock day (manual-backdate convention). With a Gold time, localize the naive
    clock time to the TZ Riley was in that day (user_tz_log ladder; ET at home), then
    derive the ADR-0001 triple:
      onyx_local_date      = clock day in that TZ (= Cronometer's Day)
      onyx_et_date         = clock day of the instant in America/New_York (canonical key)
      onyx_behavioral_date = (local wall-clock instant - 6h)::date (bedtime-to-bedtime)
    Behavioral attribution is automatic — a 12:30 AM pre-bed entry lands on the prior
    day with no manual backdating.
    """
    d = datetime.strptime(day_iso, "%Y-%m-%d").date()
    if t is None:
        return None, day_iso, day_iso, day_iso, "cronometer_csv_date"
    tz_name = resolve_tz(tz_log or [], day_iso)
    local_tz = ZoneInfo(tz_name)
    local_dt = datetime.combine(d, t, tzinfo=local_tz)
    et_date = local_dt.astimezone(ET).date()
    behavioral = (local_dt - timedelta(hours=6)).date()
    return (
        local_dt.isoformat(),
        et_date.isoformat(),
        behavioral.isoformat(),
        day_iso,
        f"cronometer_gold_time:{tz_name}",
    )


# ── File resolution ───────────────────────────────────────────────────────────
def _read_header(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8-sig") as f:
        return next(csv.reader(f))


def classify(path: str) -> str | None:
    """'servings' | 'daily' | None, by header content."""
    try:
        norm = {norm_header(h) for h in _read_header(path)}
    except (StopIteration, OSError):
        return None
    if "food name" in norm:
        return "servings"
    if "completed" in norm:
        return "daily"
    # dailysummary without Completed (older format): has Date but no Food Name
    if "date" in norm and "food name" not in norm:
        return "daily"
    return None


def resolve_inputs(paths: list[str], tmpdir: str) -> tuple[str | None, str | None]:
    """Expand zips/dirs/csvs into (servings_path, daily_path)."""
    candidates: list[str] = []
    for p in paths:
        if p.lower().endswith(".zip"):
            with zipfile.ZipFile(p) as zf:
                for name in zf.namelist():
                    if name.lower().endswith(".csv"):
                        out = zf.extract(name, tmpdir)
                        candidates.append(out)
        elif os.path.isdir(p):
            for name in os.listdir(p):
                if name.lower().endswith(".csv"):
                    candidates.append(os.path.join(p, name))
        elif p.lower().endswith(".csv"):
            candidates.append(p)
        else:
            print(f"  ! skipping unrecognized input: {p}")

    servings_path = daily_path = None
    for c in candidates:
        kind = classify(c)
        if kind == "servings" and servings_path is None:
            servings_path = c
        elif kind == "daily" and daily_path is None:
            daily_path = c
    return servings_path, daily_path


# ── Row builders ────────────────────────────────────────────────────────────────
def _nutrient_cols(row: dict[str, str], col_index: dict[str, int], cells: list[str]) -> dict:
    """Map every recognized nutrient header in this row to its db column + numeric value."""
    out: dict = {}
    for name, idx in col_index.items():
        col = NAME_TO_COL.get(name)
        if col is None:
            continue
        val = cells[idx] if idx < len(cells) else None
        out[col] = to_num(val)
    return out


def build_serving_rows(csv_path: str, tz_log: list[tuple[datetime, str]] | None = None) -> list[dict]:
    with open(csv_path, "r", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        headers = next(reader)
        raw_rows = list(reader)

    norm = [norm_header(h) for h in headers]
    col_index = {n: i for i, n in enumerate(norm)}  # normalized header -> column index

    def cell(cells, name):
        i = col_index.get(name)
        return cells[i] if (i is not None and i < len(cells)) else None

    rows: list[dict] = []
    for cells in raw_rows:
        if not any(c.strip() for c in cells):
            continue
        day = parse_date(cell(cells, "day") or cell(cells, "date") or "")
        if not day:
            continue
        t = parse_time(cell(cells, "time"))
        event_time, et_d, beh_d, loc_d, tz_src = behavioral_dates(day, t, tz_log)
        amount_raw = (cell(cells, "amount") or "").strip() or None
        amount, unit = parse_amount(amount_raw)
        record = {
            "event_time": event_time,
            "calendar_date": day,
            "onyx_et_date": et_d,
            "onyx_behavioral_date": beh_d,
            "onyx_local_date": loc_d,
            "onyx_tz_source": tz_src,
            "food_name": (cell(cells, "food name") or "").strip() or None,
            "amount_raw": amount_raw,
            "amount": amount,
            "unit": unit,
            "meal_group": (cell(cells, "group") or "").strip() or None,
            "food_category": (cell(cells, "category") or "").strip() or None,
            "raw_json": {h: (cells[i] if i < len(cells) else None) for i, h in enumerate(headers)},
        }
        record.update(_nutrient_cols(record, col_index, cells))
        rows.append(record)
    return rows


def build_daily_rows(csv_path: str) -> list[dict]:
    with open(csv_path, "r", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        headers = next(reader)
        raw_rows = list(reader)

    norm = [norm_header(h) for h in headers]
    col_index = {n: i for i, n in enumerate(norm)}

    def cell(cells, name):
        i = col_index.get(name)
        return cells[i] if (i is not None and i < len(cells)) else None

    has_group = "group" in col_index
    # Daily totals = the Group='Total' rows; capture other meal-group rows for raw_json.
    totals: dict[str, dict] = {}
    by_group: dict[str, dict] = {}
    for cells in raw_rows:
        if not any(c.strip() for c in cells):
            continue
        day = parse_date(cell(cells, "date") or cell(cells, "day") or "")
        if not day:
            continue
        group = (cell(cells, "group") or "").strip() if has_group else "Total"
        row_dict = {h: (cells[i] if i < len(cells) else None) for i, h in enumerate(headers)}
        if group.lower() == "total" or not has_group:
            _, et_d, beh_d, loc_d, tz_src = behavioral_dates(day, None)
            completed_raw = (cell(cells, "completed") or "").strip().lower()
            completed = True if completed_raw == "true" else False if completed_raw == "false" else None
            record = {
                "calendar_date": day,
                "onyx_et_date": et_d,
                "onyx_behavioral_date": beh_d,
                "onyx_local_date": loc_d,
                "onyx_tz_source": tz_src,
                "completed": completed,
            }
            record.update(_nutrient_cols(record, col_index, cells))
            totals[day] = record
        else:
            by_group.setdefault(day, {})[group] = row_dict

    # If the export had no Total rows (older one-row-per-day format), each date's
    # single row already lives in `totals` via the `not has_group` branch above.
    for day, rec in totals.items():
        rec["raw_json"] = {"by_group": by_group.get(day, {})}
    return list(totals.values())


# ── Writers ─────────────────────────────────────────────────────────────────────
def import_servings(rows: list[dict], dry_run: bool) -> int:
    if not rows:
        return 0
    if dry_run:
        return len(rows)
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    dates = sorted({r["calendar_date"] for r in rows})
    # Idempotent: clear the affected dates, then insert fresh (reflects edits/deletes).
    for i in range(0, len(dates), 100):
        chunk = dates[i:i + 100]
        sb.schema("pds").table("cronometer_servings").delete().in_("calendar_date", chunk).execute()
    inserted = 0
    for i in range(0, len(rows), BATCH):
        batch = rows[i:i + BATCH]
        res = sb.schema("pds").table("cronometer_servings").insert(batch).execute()
        inserted += len(res.data) if res.data else 0
    return inserted


def import_daily(rows: list[dict], dry_run: bool) -> int:
    if not rows:
        return 0
    if dry_run:
        return len(rows)
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    upserted = 0
    for i in range(0, len(rows), BATCH):
        batch = rows[i:i + BATCH]
        res = (
            sb.schema("pds").table("cronometer_nutrition_daily")
            .upsert(batch, on_conflict="calendar_date")
            .execute()
        )
        upserted += len(res.data) if res.data else 0
    return upserted


# ── Orchestration ────────────────────────────────────────────────────────────────
def run_import(paths: list[str], dry_run: bool = False) -> tuple[int, int]:
    """Return (servings_count, daily_count). Emits a sync_log heartbeat per data_type."""
    sb = None if dry_run else create_client(SUPABASE_URL, SUPABASE_KEY)
    tz_log = load_tz_log(sb)  # materialized TZ ladder for Gold-timestamp localization
    with tempfile.TemporaryDirectory() as tmp:
        servings_path, daily_path = resolve_inputs(paths, tmp)
        if not servings_path and not daily_path:
            raise SystemExit("No Cronometer servings.csv or dailysummary.csv found in inputs.")

        # ── servings ──
        t0 = now_epoch()
        try:
            srows = build_serving_rows(servings_path, tz_log) if servings_path else []
            scount = import_servings(srows, dry_run)
            print(f"  servings: {scount} entries {'(dry-run)' if dry_run else 'imported'}"
                  f"{' from ' + os.path.basename(servings_path) if servings_path else ' (no file)'}")
            if sb and srows:
                dr = sorted({r["calendar_date"] for r in srows})
                log_sync(sb, "cronometer", "servings", "success", records=scount,
                         started_at=t0, date_range_start=date.fromisoformat(dr[0]),
                         date_range_end=date.fromisoformat(dr[-1]))
        except Exception as e:  # noqa: BLE001
            if sb:
                log_sync(sb, "cronometer", "servings", "error", error=str(e)[:500], started_at=t0)
            raise

        # ── daily ──
        t1 = now_epoch()
        try:
            drows = build_daily_rows(daily_path) if daily_path else []
            dcount = import_daily(drows, dry_run)
            print(f"  daily:    {dcount} days   {'(dry-run)' if dry_run else 'imported'}"
                  f"{' from ' + os.path.basename(daily_path) if daily_path else ' (no file)'}")
            if sb and drows:
                dd = sorted(r["calendar_date"] for r in drows)
                log_sync(sb, "cronometer", "daily", "success", records=dcount,
                         started_at=t1, date_range_start=date.fromisoformat(dd[0]),
                         date_range_end=date.fromisoformat(dd[-1]))
        except Exception as e:  # noqa: BLE001
            if sb:
                log_sync(sb, "cronometer", "daily", "error", error=str(e)[:500], started_at=t1)
            raise

        return scount, dcount


def main() -> None:
    ap = argparse.ArgumentParser(description="Import a Cronometer CSV export into Supabase.")
    ap.add_argument("paths", nargs="+", help="zip / directory / servings.csv / dailysummary.csv")
    ap.add_argument("--dry-run", action="store_true", help="parse + report counts, no writes")
    args = ap.parse_args()
    print(f"Cronometer import: {', '.join(args.paths)}")
    scount, dcount = run_import(args.paths, dry_run=args.dry_run)
    print(f"Done — {scount} servings, {dcount} daily rows.")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(1)
