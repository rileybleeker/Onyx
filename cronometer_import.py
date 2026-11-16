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
    - cronometer_servings        : the re-imported dates are replaced in ONE transaction by
                                   pds.replace_cronometer_servings (sql/cronometer_replace_servings.sql);
                                   reflects edits/deletes in the source export and survives
                                   re-import of the same range. Readers never see a half-replaced day.

Days that became empty upstream (the last food of a day removed in Cronometer) are
missing from an export, so the date-set replace above cannot see them. Only the
automated export (cronometer_etl.py) knows the exact window it asked for; it passes
that window to run_import, the export is checked for completeness
(check_trusted_export: well formed, inside the window, per-day servings sums equal
the daily totals), and pds.replace_cronometer_servings_window
(sql/cronometer_replace_servings_window.sql) then writes servings and daily totals in
one transaction and also empties the window's inner days that have no food, with a
backup copy and a per-run limit. A manual export (inbox, this CLI) has no window and
can never empty a day.

Conventions honored (see AGENTS.md):
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
from dataclasses import dataclass, field
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


# ── Completeness check for the automated export ────────────────────────────────
# The automated export may empty days, so it must first prove it is the whole
# window: both files present and well formed, every date inside the window it
# asked for, and the two files agreeing on every day (a servings day has a daily
# Total row whose nutrients equal the day's servings summed, and the daily summary
# shows no food on a day without servings). A download cut off between two rows
# still parses cleanly; the per-day sums are what catch it.
#
# Any doubt means nothing is emptied (partial heartbeat). The days in doubt are
# not written either (their stored rows stay as they are); the days that agree
# are written as usual. A file that is not well formed writes no servings at all.
# The reasons are counts and rules only, never a food, an amount or a date.
MAX_WINDOW_DAYS = 400           # same bound as pds.replace_cronometer_servings_window
DEFAULT_MAX_EMPTY_DAYS = 3      # stored days one run may empty; more = refused, partial heartbeat
# Nutrients (normalized header names) whose per-day servings sum must match the
# daily Total row; only those present in both files are compared. Cronometer's
# daily total is the sum of that day's servings, so the tolerance only absorbs
# per-row rounding.
COMPARE_NUTRIENTS = ("energy", "protein", "carbs", "fat", "caffeine", "water")
SUM_TOLERANCE_ABS = 0.5         # in the nutrient's own unit
SUM_TOLERANCE_REL = 0.001       # plus 0.1 % of the larger of the two values


@dataclass(frozen=True)
class FileScan:
    ok: bool
    reason: str | None = None
    # servings: date -> number of entries; daily: date -> largest energy of any row (blank = 0)
    by_date: dict[str, float] = field(default_factory=dict)
    # servings: date -> {nutrient: sum of the day's entries}; daily: date -> {nutrient: Total row value}
    totals: dict[str, dict[str, float]] = field(default_factory=dict)
    nutrients: frozenset = frozenset()


@dataclass(frozen=True)
class ExportCheck:
    usable: bool                   # both files well formed: the days that agree may be written
    complete: bool                 # usable and nothing in doubt: days without food may be emptied
    reason: str | None             # why the export is not complete (None when it is)
    daily_ok: bool                 # dailysummary.csv itself is well formed (else it is not upserted)
    daily_reason: str | None = None
    # Days in neither file: their servings AND their daily row are emptied.
    empty_dates: tuple[str, ...] = ()
    # Days the daily summary lists with no food and no servings: their servings are
    # emptied and their daily row is rewritten from the export.
    servings_empty_dates: tuple[str, ...] = ()
    # Days whose servings are not written (outside the window, or the files disagree).
    skip_dates: tuple[str, ...] = ()
    food_days: int = 0             # days with at least one serving in the export


def scan_export_file(path: str | None, kind: str) -> FileScan:
    """Structural check of one automated-export file ('servings' or 'daily').

    Well formed = the expected header columns exist and every non-blank row has
    exactly as many cells as the header and a readable date. A row with fewer or
    more cells is how a garbled download shows up in a CSV.
    """
    label = "servings.csv" if kind == "servings" else "dailysummary.csv"
    if not path:
        return FileScan(False, f"the export has no {label}")
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            headers = next(reader)
            raw_rows = list(reader)
    except (StopIteration, OSError, csv.Error, UnicodeDecodeError):
        return FileScan(False, f"{label} could not be read")
    norm = [norm_header(h) for h in headers]
    col_index = {n: i for i, n in enumerate(norm)}
    if kind == "servings":
        date_cols = ("day", "date")
        if "food name" not in col_index:
            return FileScan(False, f"{label} has no Food Name column")
    else:
        date_cols = ("date", "day")
        if "energy" not in col_index:
            return FileScan(False, f"{label} has no Energy column")
    date_col = next((col_index[c] for c in date_cols if c in col_index), None)
    if date_col is None:
        return FileScan(False, f"{label} has no date column")
    nutrients = frozenset(n for n in COMPARE_NUTRIENTS if n in col_index)
    group_col = col_index.get("group") if kind == "daily" else None

    by_date: dict[str, float] = {}
    totals: dict[str, dict[str, float]] = {}
    bad_width = bad_date = 0
    for cells in raw_rows:
        if not any(c.strip() for c in cells):
            continue
        if len(cells) != len(headers):
            bad_width += 1
            continue
        day = parse_date(cells[date_col])
        if not day:
            bad_date += 1
            continue
        values = {n: to_num(cells[col_index[n]]) or 0.0 for n in nutrients}
        if kind == "servings":
            by_date[day] = by_date.get(day, 0) + 1
            sums = totals.setdefault(day, {})
            for n, v in values.items():
                sums[n] = sums.get(n, 0.0) + v
        else:
            energy = to_num(cells[col_index["energy"]]) or 0.0
            by_date[day] = max(by_date.get(day, 0.0), energy)
            # Same rule as build_daily_rows: the Total row (or the only row) is the day.
            if group_col is None or cells[group_col].strip().lower() == "total":
                totals[day] = values
    if bad_width:
        return FileScan(False, f"{bad_width} row(s) of {label} do not have {len(headers)} cells")
    if bad_date:
        return FileScan(False, f"{bad_date} row(s) of {label} have no readable date")
    return FileScan(True, None, by_date, totals, nutrients)


def _window_dates(start: date, end: date) -> list[str]:
    return [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]


def _sums_agree(servings: dict[str, float], daily: dict[str, float], nutrients) -> bool:
    for n in nutrients:
        a, b = servings.get(n, 0.0), daily.get(n, 0.0)
        if abs(a - b) > SUM_TOLERANCE_ABS + SUM_TOLERANCE_REL * max(abs(a), abs(b)):
            return False
    return True


def check_trusted_export(window: tuple[date, date], servings_path: str | None,
                         daily_path: str | None) -> ExportCheck:
    """Decide what an automated export of `window` may write and empty.

    Not usable (write no servings) when a file is missing or not well formed.
    Complete (days without food may be emptied) only when, in addition, every date
    lies in the window, every servings day has a daily Total row with the same
    nutrient sums, and the daily summary shows no food on a day without servings.
    Otherwise the days in doubt are listed in skip_dates and nothing is emptied.

    The first and last day of the window are never emptied: nothing has checked
    that Cronometer's start and end are both inclusive, and the windows of the
    twice-daily runs overlap, so each edge day is an inner day of another run.
    """
    start, end = window
    s = scan_export_file(servings_path, "servings")
    d = scan_export_file(daily_path, "daily")
    if not s.ok or not d.ok:
        reason = s.reason if not s.ok else d.reason
        return ExportCheck(False, False, reason or "the export is not usable", d.ok, d.reason)

    lo, hi = start.isoformat(), end.isoformat()
    outside = {x for x in (*s.by_date, *d.by_date) if not (lo <= x <= hi)}
    inside = set(s.by_date) - outside
    no_total = {x for x in inside if x not in d.totals}
    nutrients = s.nutrients & d.nutrients
    mismatch = {x for x in inside - no_total if not _sums_agree(s.totals[x], d.totals[x], nutrients)}
    food_without_servings = {x for x, kcal in d.by_date.items()
                             if kcal > 0 and x not in s.by_date and x not in outside}
    reasons = []
    if outside:
        reasons.append(f"{len(outside)} date(s) lie outside the requested window")
    if no_total:
        reasons.append(f"{len(no_total)} day(s) have servings but no daily Total row")
    if mismatch:
        reasons.append(f"on {len(mismatch)} day(s) the servings do not add up to the daily total")
    if food_without_servings:
        reasons.append(f"the daily summary shows food on {len(food_without_servings)} day(s) "
                       "that have no servings")
    if reasons:
        return ExportCheck(True, False, "; ".join(reasons), True, None,
                           skip_dates=tuple(sorted(outside | no_total | mismatch)),
                           food_days=len(s.by_date))

    inner = _window_dates(start, end)[1:-1]
    empty = tuple(x for x in inner if x not in s.by_date and x not in d.by_date)
    servings_empty = tuple(x for x in inner
                           if x not in s.by_date and x in d.totals and d.by_date.get(x, 0.0) == 0)
    return ExportCheck(True, True, None, True, None, empty, servings_empty, (), len(s.by_date))


def trusted_window(window) -> tuple[date, date] | None:
    """Validate the window the automated export asked for; None = treat as manual."""
    if window is None:
        return None
    start, end = window
    if not isinstance(start, date) or not isinstance(end, date) or end < start:
        raise ValueError("window must be (start_date, end_date) with start <= end")
    if (end - start).days + 1 > MAX_WINDOW_DAYS:
        return None   # a very long backfill: replace the dates with rows, empty nothing
    return start, end


# ── Writers ─────────────────────────────────────────────────────────────────────
REPLACE_SERVINGS_RPC = "replace_cronometer_servings"
REPLACE_SERVINGS_SQL = "sql/cronometer_replace_servings.sql"
REPLACE_WINDOW_RPC = "replace_cronometer_servings_window"
REPLACE_WINDOW_SQL = "sql/cronometer_replace_servings_window.sql"


def _is_missing_function(exc: Exception, name: str = REPLACE_SERVINGS_RPC) -> bool:
    """True when PostgREST / Postgres says the function `name` does not exist.

    The name must appear as a whole word: replace_cronometer_servings is a prefix
    of replace_cronometer_servings_window, and one missing must not read as the other.
    """
    code = str(getattr(exc, "code", "") or "")
    text = f"{getattr(exc, 'message', '') or ''} {exc}"
    return (code in ("PGRST202", "42883")
            or "Could not find the function" in text) and \
        re.search(rf"\b{re.escape(name)}\b", text) is not None


def import_servings(rows: list[dict], dry_run: bool, sb=None) -> int:
    """Replace the servings of every date in `rows`, in one database transaction.

    One RPC call per import: pds.replace_cronometer_servings removes the rows of
    exactly the dates present in `rows` and inserts `rows`, atomically. A reader
    sees the old day or the new day, never an empty one, and any failure leaves
    the stored servings as they were (audit deepseek/F-005; the old code cleared
    the dates and inserted in separate requests).

    An empty export makes no call, so it can never clear stored days.

    There is deliberately NO fallback to separate delete + insert requests when
    the function is missing or fails: that is the non-atomic path this replaces,
    and running it after a failed attempt is how days end up empty. The import
    stops with an error that names the SQL file, and nothing is changed.
    """
    if not rows:
        return 0
    if dry_run:
        return len(rows)
    if sb is None:
        sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    dates = sorted({r["calendar_date"] for r in rows})
    try:
        res = (
            sb.schema("pds")
            .rpc(REPLACE_SERVINGS_RPC, {"p_dates": dates, "p_rows": rows})
            .execute()
        )
    except Exception as e:  # noqa: BLE001
        if _is_missing_function(e):
            raise RuntimeError(
                f"pds.{REPLACE_SERVINGS_RPC} does not exist in the database. Apply "
                f"{REPLACE_SERVINGS_SQL} once (Supabase SQL editor), then re-run. "
                "No servings were changed."
            ) from e
        raise
    data = res.data
    inserted = data.get("inserted") if isinstance(data, dict) else None
    if inserted != len(rows):
        raise RuntimeError(
            f"pds.{REPLACE_SERVINGS_RPC} answered {data!r} for {len(rows)} rows sent; "
            "the import cannot be confirmed."
        )
    return inserted


def import_daily(rows: list[dict], dry_run: bool, sb=None) -> int:
    if not rows:
        return 0
    if dry_run:
        return len(rows)
    if sb is None:
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


_WINDOW_REPLY_INTS = ("inserted", "daily_upserted", "cleared_days", "cleared_servings",
                      "cleared_daily", "refused_days")


def import_servings_window(rows: list[dict], daily_rows: list[dict], window: tuple[date, date],
                           empty_dates, servings_empty_dates, max_empty_days: int,
                           dry_run: bool, sb=None) -> dict:
    """Automated export only: in ONE transaction (pds.replace_cronometer_servings_window)
    replace the servings of the dates with rows, upsert the daily totals, and empty
    the confirmed-empty days.

    empty_dates: days in neither file (servings and daily row are emptied).
    servings_empty_dates: days the daily summary lists with no food (servings are
    emptied; their daily row is in daily_rows and is rewritten from the export).
    Both must come from check_trusted_export on the same files. Writing the daily
    totals in the same transaction means two overlapping imports can never leave
    one import's daily total next to the other import's servings.

    Returns a dict with the function's counts plus "mode":
      "window"   the function ran (cleared_days / refused_days say what it did)
      "fallback" the function is not in the database yet: the failed call changed
                 nothing, so the date-set function replaced the dates with rows
                 (one transaction as well), the daily totals were upserted as
                 before, and nothing was emptied
      "dry_run" / "none"  no call was made
    """
    if not isinstance(max_empty_days, int) or isinstance(max_empty_days, bool) or max_empty_days < 0:
        raise ValueError("max_empty_days must be an integer >= 0")
    empty = sorted(set(empty_dates))
    s_empty = sorted(set(servings_empty_dates))
    base = {"inserted": 0, "daily_upserted": 0, "empty_dates": len(empty) + len(s_empty),
            "cleared_days": 0, "cleared_servings": 0, "cleared_daily": 0, "refused_days": 0}
    if not rows and not daily_rows and not empty and not s_empty:
        return {**base, "mode": "none"}
    if dry_run:
        return {**base, "inserted": len(rows), "daily_upserted": len(daily_rows), "mode": "dry_run"}
    if sb is None:
        sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    start, end = window
    params = {
        "p_window_start": start.isoformat(),
        "p_window_end": end.isoformat(),
        "p_dates": sorted({r["calendar_date"] for r in rows}),
        "p_rows": rows,
        "p_empty_dates": empty,
        "p_servings_empty_dates": s_empty,
        "p_daily_rows": daily_rows,
        "p_max_cleared_days": max_empty_days,
    }
    try:
        res = sb.schema("pds").rpc(REPLACE_WINDOW_RPC, params).execute()
    except Exception as e:  # noqa: BLE001
        if _is_missing_function(e, REPLACE_WINDOW_RPC):
            # Rollout order: the code can ship before the SQL. The failed call was
            # rejected before it ran, so nothing changed; the date-set function is
            # its own single transaction and never empties a day.
            inserted = import_servings(rows, dry_run=False, sb=sb)
            return {**base, "inserted": inserted, "daily_upserted": import_daily(daily_rows, False, sb),
                    "mode": "fallback"}
        raise
    data = res.data
    ok = isinstance(data, dict) and all(
        isinstance(data.get(k), int) and not isinstance(data.get(k), bool) and data[k] >= 0
        for k in _WINDOW_REPLY_INTS)
    if not ok or data["inserted"] != len(rows) or data["daily_upserted"] != len(daily_rows):
        raise RuntimeError(
            f"pds.{REPLACE_WINDOW_RPC} answered {data!r} for {len(rows)} serving and "
            f"{len(daily_rows)} daily rows sent; the import cannot be confirmed."
        )
    return {**base, **{k: data[k] for k in _WINDOW_REPLY_INTS}, "mode": "window"}


def window_outcome(result: dict, check: ExportCheck, max_empty_days: int,
                   blank_export: bool = False) -> tuple[str, str | None]:
    """(servings heartbeat status, note) for an automated import. Counts only.

    A success note (days were emptied) is kept on the servings heartbeat only, so
    sync_log records the removal without turning the /status card (which reads
    the daily heartbeat) red.
    """
    notes = []
    if not check.complete:
        skipped = len(check.skip_dates)
        notes.append(f"nothing emptied{f' and {skipped} day(s) not written' if skipped else ''}: "
                     f"{check.reason}")
    if result.get("mode") == "fallback":
        notes.append(f"days with no food in Cronometer were not emptied: apply {REPLACE_WINDOW_SQL} "
                     "once; days with food were replaced as before")
    refused = result.get("refused_days", 0)
    if refused and blank_export:
        notes.append(f"the export has no food anywhere in the window, so {refused} stored day(s) were "
                     "not emptied; a later export that lists food on another day empties them")
    elif refused:
        notes.append(f"{refused} stored day(s) have no food in Cronometer any more, more than the limit "
                     f"of {max_empty_days}, so none were emptied; check them in Cronometer, then run "
                     f"cronometer_etl.py --max-empty-days {refused} on a PC with the Cronometer and "
                     "Supabase keys (the scheduled run keeps the limit)")
    if notes:
        return "partial", "; ".join(notes)
    if result.get("cleared_days"):
        return "success", (f"emptied {result['cleared_days']} day(s) with no food in Cronometer any more "
                           f"({result['cleared_servings']} serving row(s), {result['cleared_daily']} daily "
                           "row(s); copies in pds.cronometer_cleared_rows)")
    return "success", None


def _read_client():
    """A client for the dry run's read-only count; None when it cannot be made."""
    try:
        return create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception:  # noqa: BLE001
        return None


def count_stored_days(sb, empty_dates, servings_empty_dates) -> int | None:
    """READ ONLY (dry run): how many of these days hold stored rows, i.e. the number
    pds.replace_cronometer_servings_window compares with the limit. None = could not
    be read. Same rule as the function: a day in empty_dates counts when it has
    servings or a daily row, a day in servings_empty_dates when it has servings.
    """
    empty, s_empty = set(empty_dates), set(servings_empty_dates)
    if not empty and not s_empty:
        return 0
    if sb is None:
        return None
    try:
        with_servings = set()
        for day in sorted(empty | s_empty):
            got = (sb.schema("pds").table("cronometer_servings")
                   .select("calendar_date").eq("calendar_date", day).limit(1).execute().data)
            if got:
                with_servings.add(day)
        with_daily = set()
        if empty:
            got = (sb.schema("pds").table("cronometer_nutrition_daily")
                   .select("calendar_date").in_("calendar_date", sorted(empty)).execute().data) or []
            with_daily = {str(r["calendar_date"]) for r in got}
    except Exception:  # noqa: BLE001
        return None
    return len({x for x in empty if x in with_servings or x in with_daily}) + len(s_empty & with_servings)


# ── Orchestration ────────────────────────────────────────────────────────────────
def run_import(paths: list[str], dry_run: bool = False, window: tuple[date, date] | None = None,
               max_empty_days: int = DEFAULT_MAX_EMPTY_DAYS) -> tuple[int, int]:
    """Return (servings_count, daily_count). Emits a sync_log heartbeat per data_type.

    window: ONLY the automated export passes it: the (start, end) dates it asked
    Cronometer for. With a window the export goes through check_trusted_export and
    one transaction writes the servings and daily totals; if the export is
    complete, the window's inner days without food are emptied too (at most
    max_empty_days stored days per run). A file that is not well formed writes no
    servings; days the two files disagree on are not written; in both cases
    nothing is emptied (partial heartbeat). Without a window (manual export) the
    behaviour is the date-set replace, which never empties a day.
    """
    trusted = trusted_window(window)
    if window is not None and trusted is None:
        print(f"  note: window longer than {MAX_WINDOW_DAYS} days; days with no food are not emptied")
    sb = None if dry_run else create_client(SUPABASE_URL, SUPABASE_KEY)
    tz_log = load_tz_log(sb)  # materialized TZ ladder for Gold-timestamp localization
    with tempfile.TemporaryDirectory() as tmp:
        servings_path, daily_path = resolve_inputs(paths, tmp)
        if not servings_path and not daily_path:
            raise SystemExit("No Cronometer servings.csv or dailysummary.csv found in inputs.")
        if trusted is None:
            return _import_dates(servings_path, daily_path, dry_run, sb, tz_log)
        return _import_window(trusted, servings_path, daily_path, dry_run, sb, tz_log, max_empty_days)


def _log_range(sb, data_type: str, status: str, rows: list[dict], count: int, started: float,
               note: str | None) -> None:
    if not sb:
        return
    dr = sorted({r["calendar_date"] for r in rows}) if rows else []
    log_sync(sb, "cronometer", data_type, status, records=count, started_at=started,
             error=note[:500] if note else None,
             date_range_start=date.fromisoformat(dr[0]) if dr else None,
             date_range_end=date.fromisoformat(dr[-1]) if dr else None)


def _import_dates(servings_path, daily_path, dry_run, sb, tz_log) -> tuple[int, int]:
    """Manual export (inbox, CLI, a very long backfill): the date-set replace."""
    # ── servings ──
    t0 = now_epoch()
    try:
        srows = build_serving_rows(servings_path, tz_log) if servings_path else []
        scount = import_servings(srows, dry_run, sb)
        print(f"  servings: {scount} entries {'(dry-run)' if dry_run else 'imported'}"
              f"{' from ' + os.path.basename(servings_path) if servings_path else ' (no file)'}")
        # Heartbeat on EVERY run, including a zero-row export (no food logged
        # in the window). Without this the /status card read "no heartbeat
        # since July" while the workflow itself was green (2026-10-17).
        _log_range(sb, "servings", "success", srows, scount, t0, None)
    except Exception as e:  # noqa: BLE001
        if sb:
            log_sync(sb, "cronometer", "servings", "error", error=str(e)[:500], started_at=t0)
        raise

    # ── daily ──
    t1 = now_epoch()
    try:
        drows = build_daily_rows(daily_path) if daily_path else []
        dcount = import_daily(drows, dry_run, sb)
        print(f"  daily:    {dcount} days   {'(dry-run)' if dry_run else 'imported'}"
              f"{' from ' + os.path.basename(daily_path) if daily_path else ' (no file)'}")
        _log_range(sb, "daily", "success", drows, dcount, t1, None)
    except Exception as e:  # noqa: BLE001
        if sb:
            log_sync(sb, "cronometer", "daily", "error", error=str(e)[:500], started_at=t1)
        raise
    return scount, dcount


def _import_window(window, servings_path, daily_path, dry_run, sb, tz_log,
                   max_empty_days) -> tuple[int, int]:
    """Automated export: checked, then one transaction (see run_import)."""
    check = check_trusted_export(window, servings_path, daily_path)
    t0 = now_epoch()

    if not check.usable:
        # The export could not prove it is the whole window: write no servings and
        # empty nothing (a replace of a cut-off day would lose its missing rows). A
        # well-formed daily summary is still upserted the usual way; a garbled one
        # is not (a short row would write NULL over a stored total).
        servings_note = f"servings not written, nothing emptied: {check.reason}"
        print(f"  servings: {servings_note}")
        _log_range(sb, "servings", "partial", [], 0, t0, servings_note)
        t1 = now_epoch()
        try:
            if check.daily_ok:
                drows = build_daily_rows(daily_path) if daily_path else []
                dcount = import_daily(drows, dry_run, sb)
                daily_note = f"servings: {servings_note}"
                print(f"  daily:    {dcount} days   {'(dry-run)' if dry_run else 'imported'}")
            else:
                drows, dcount = [], 0
                daily_note = f"daily totals not written: {check.daily_reason}"
                print(f"  daily:    {daily_note}")
            # /status reads the daily heartbeat for the Cronometer card, so a
            # servings problem has to show there too.
            _log_range(sb, "daily", "partial", drows, dcount, t1, daily_note)
        except Exception as e:  # noqa: BLE001
            if sb:
                log_sync(sb, "cronometer", "daily", "error", error=str(e)[:500], started_at=t1)
            raise
        return 0, dcount

    lo, hi = window[0].isoformat(), window[1].isoformat()
    skip = set(check.skip_dates)
    srows = [r for r in build_serving_rows(servings_path, tz_log) if r["calendar_date"] not in skip]
    drows = [r for r in build_daily_rows(daily_path) if lo <= r["calendar_date"] <= hi]
    # An export with no food at all in the window is not trusted to empty days (a
    # blank export from a broken session or another account looks the same).
    blank = check.complete and check.food_days == 0
    cap = 0 if blank else max_empty_days
    try:
        result = import_servings_window(srows, drows, window, check.empty_dates,
                                        check.servings_empty_dates, cap, dry_run, sb)
    except Exception as e:  # noqa: BLE001
        if sb:
            log_sync(sb, "cronometer", "servings", "error", error=str(e)[:500], started_at=t0)
        raise

    n_empty = len(check.empty_dates) + len(check.servings_empty_dates)
    if dry_run:
        print(f"  servings: {result['inserted']} entries (dry-run); "
              f"{len(check.skip_dates)} day(s) not written")
        print(f"  daily:    {result['daily_upserted']} days   (dry-run, same transaction)")
        if not check.complete:
            print(f"  empty days: none would be emptied: {check.reason}")
        else:
            stored = count_stored_days(_read_client(), check.empty_dates, check.servings_empty_dates)
            if stored is None:
                print(f"  empty days: {n_empty} inner day(s) have no food; the stored days could not "
                      "be read, so the count of days a real run would empty is unknown")
            elif blank and stored:
                print(f"  empty days: the export has no food anywhere; {stored} stored day(s) would "
                      "NOT be emptied (a blank export is not trusted)")
            elif stored > cap:
                print(f"  empty days: {stored} stored day(s) have no food any more, more than the limit "
                      f"of {cap}: a real run would empty none")
            else:
                print(f"  empty days: a real run would empty {stored} stored day(s) "
                      f"(limit {cap}; {n_empty} inner day(s) have no food)")
        return result["inserted"], result["daily_upserted"]

    status, note = window_outcome(result, check, max_empty_days, blank)
    print(f"  servings: {result['inserted']} entries imported"
          f"{f'; {len(check.skip_dates)} day(s) not written' if check.skip_dates else ''}")
    print(f"  daily:    {result['daily_upserted']} days   imported"
          f"{' (same transaction)' if result['mode'] == 'window' else ''}")
    print(f"  emptied {result['cleared_days']} day(s) with no food in Cronometer any more "
          f"({result['cleared_servings']} serving row(s), {result['cleared_daily']} daily row(s))")
    if status != "success" and note:
        print(f"  servings: {note}")
    _log_range(sb, "servings", status, srows, result["inserted"], t0, note)
    # /status reads the daily heartbeat for the Cronometer card: a partial servings
    # run shows there too; a success note (days emptied) stays on servings only.
    daily_status, daily_note = ("success", None) if status == "success" else ("partial", f"servings: {note}")
    _log_range(sb, "daily", daily_status, drows, result["daily_upserted"], t0, daily_note)
    return result["inserted"], result["daily_upserted"]


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
