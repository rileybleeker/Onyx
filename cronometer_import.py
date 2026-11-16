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
(check_trusted_export: well formed, inside the window, every nutrient cell blank or
a number, per-day servings sums equal the daily totals), and
pds.replace_cronometer_servings_window (sql/cronometer_replace_servings_window.sql)
then writes servings and daily totals in one transaction and also empties days that
have no food and lie between two days with food in that same export, once a second
export at least EMPTY_CONFIRM_HOURS later still shows them empty, with a backup copy
and a per-run limit. A manual export (inbox, this CLI) has no window and can never
empty a day; its servings and daily totals are written in one transaction too
(pds.replace_cronometer_servings_and_daily, same lock), and every day it writes
starts its empty-day count over.

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
import math
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
    """Blank cell -> None (NOT 0); Cronometer leaves missing values empty.

    An unreadable cell is None too, never 0, and so is "nan" / "inf" (float() reads
    them, but they are not amounts and JSON cannot carry them).
    """
    ok, num = strict_num(value)
    return num if ok else None


def strict_num(value: str | None) -> tuple[bool, float | None]:
    """(readable, number) for one nutrient cell: blank -> (True, None), a finite
    number -> (True, n), anything else -> (False, None). The completeness check
    uses it to tell a missing value from a cell it cannot read."""
    if value is None:
        return True, None
    v = value.strip()
    if v == "":
        return True, None
    try:
        num = float(v)
    except ValueError:
        return False, None
    return (True, num) if math.isfinite(num) else (False, None)


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
# Any doubt means nothing is emptied (partial heartbeat). The days in doubt keep
# their stored servings (their daily Total row is still upserted, unless that row
# is the doubt); the days that agree are written as usual. A file that is not well
# formed writes no servings at all. The reasons are counts and rules only, never a
# food, an amount or a date.
#
# Every nutrient column both files carry is compared, not a short list: a serving
# that only carries micronutrients (a vitamin pill: 0 kcal, 0 g of every macro)
# lost from a cut download changes no macro, only its own columns. Checked against
# the stored data on 2026-11-16: on every day held in both tables, every one of the
# 67 shared nutrient columns agrees to within 0.01.
#
# A cell that cannot be read is never a zero. Every nutrient cell must be blank (a
# value Cronometer does not have, which adds nothing to a total) or a finite
# number; a day with any other cell, or with a daily Total row that has no Energy
# value, is in doubt. Both files must have an Energy column, so the per-day
# comparison always has at least that to compare.
#
# Food seen is food seen, whether or not it is written: every day either file
# shows food on (an entry in servings.csv, a nutrient above 0 or a cell that
# cannot be read in dailysummary.csv; in a file that is not well formed, any row
# with a readable date) is sent along as food_dates, and the database forgets
# its empty-day record. Otherwise an export with food on a day whose rows are not
# written (the files disagree, a value cannot be read) would leave an older first
# look behind, and the next export that missed the day would empty it on one look.
#
# Elapsed time is not coverage. A day is only offered for emptying when the same
# export has food on a day before it AND on a day after it: then the export itself
# shows it covered that day. A day past the newest day with food (or before the
# oldest) may simply be missing from a cut-short export, so it is never emptied,
# and neither is anything in an export with fewer than two days with food (a blank
# export, a logging pause). Such a day is emptied later, once food on a later day
# brackets it.
#
# One run's two files are ONE look: both can miss the same day, and then they
# agree with each other. So a day is emptied only on a second look: the database
# function records the first complete export that shows a stored day empty and
# empties it when a later one, at least EMPTY_CONFIRM_HOURS after, still does.
# Food on that day in between (any automated export that shows food on it, written
# or not, and every manual import that writes it) forgets the record, so the count
# starts over.
MAX_WINDOW_DAYS = 400           # same bound as pds.replace_cronometer_servings_window
DEFAULT_MAX_EMPTY_DAYS = 3      # stored days one run may empty; more = refused, partial heartbeat
EMPTY_CONFIRM_HOURS = 6         # same as pds.replace_cronometer_servings_window (fixed there)
# Every recognized nutrient (NAME_TO_COL) present in both files is compared: its
# per-day servings sum must match the daily Total row. Energy must be one of them
# (both files are refused without it). Cronometer's daily total is the sum of that
# day's servings, so the tolerance only absorbs per-row rounding.
REQUIRED_NUTRIENT = "energy"
SUM_TOLERANCE_ABS = 0.5         # in the nutrient's own unit
SUM_TOLERANCE_REL = 0.001       # plus 0.1 % of the larger of the two values


@dataclass(frozen=True)
class FileScan:
    ok: bool
    reason: str | None = None
    # servings: date -> number of entries; daily: date -> largest value of ANY nutrient in
    # any of the day's rows (blank = 0; above 0 = the day has food, even a water-only day)
    by_date: dict[str, float] = field(default_factory=dict)
    # servings: date -> {nutrient: sum of the day's entries}; daily: date -> {nutrient: Total row value}
    totals: dict[str, dict[str, float]] = field(default_factory=dict)
    nutrients: frozenset = frozenset()
    # Days with a nutrient cell that is neither blank nor a finite number.
    invalid_dates: frozenset = frozenset()
    # daily: days whose Total row (or only row) has no Energy value.
    no_energy_dates: frozenset = frozenset()
    # Days the file shows (or may show) food on, filled in whether or not the file is
    # well formed: servings = every row with a readable date; daily = a row with a
    # nutrient above 0 or an unreadable cell, a Total row with no Energy value, and
    # any row of a file that is not well formed. Forgetting a day's empty-day record
    # can only delay emptying it, so anything that may be food counts.
    food_dates: frozenset = frozenset()


@dataclass(frozen=True)
class ExportCheck:
    usable: bool                   # both files well formed: the days that agree may be written
    complete: bool                 # usable and nothing in doubt: days without food may be emptied
    reason: str | None             # why the export is not complete (None when it is)
    daily_ok: bool                 # dailysummary.csv itself is well formed (else it is not upserted)
    daily_reason: str | None = None
    # Days with food in neither file, between two days with food: their servings AND
    # their daily row are emptied (on the second look).
    empty_dates: tuple[str, ...] = ()
    # Days the daily summary lists with no food and no servings, between two days with
    # food: their servings are emptied and their daily row is rewritten from the export.
    servings_empty_dates: tuple[str, ...] = ()
    # Days whose servings are not written (outside the window, the files disagree, or
    # a value the check needs cannot be read).
    skip_dates: tuple[str, ...] = ()
    # Days whose daily row is not written: the daily summary has an unreadable
    # nutrient cell or no Energy value for them (the stored row is kept, not
    # overwritten with blanks).
    daily_skip_dates: tuple[str, ...] = ()
    # Days either file shows (or may show) food on, written or not (FileScan.food_dates
    # of both files, inside the window or not). Never overlaps the two empty lists.
    # Each loses its empty-day record in the same transaction as the write.
    food_dates: tuple[str, ...] = ()


def scan_export_file(path: str | None, kind: str) -> FileScan:
    """Structural check of one automated-export file ('servings' or 'daily').

    Well formed = the expected header columns exist (Food Name for servings, and
    Energy in both files) and every non-blank row has exactly as many cells as the
    header and a readable date. A row with fewer or more cells is how a garbled
    download shows up in a CSV.

    Every nutrient cell is read with strict_num: blank adds nothing (a value
    Cronometer does not have for that food or day), a finite number counts, and
    any other cell puts its day in invalid_dates instead of counting as 0. A daily
    Total row with a blank Energy cell puts its day in no_energy_dates: a day can
    only be "listed with no food" by an explicit 0. Every recognized nutrient
    column (NAME_TO_COL) is read and summed, so the comparison covers them all.

    food_dates is filled in even when the file is not well formed (any row with a
    readable date then counts), so food seen in a broken download still starts
    that day's empty-day count over.
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
    date_cols = ("day", "date") if kind == "servings" else ("date", "day")
    date_col = next((col_index[c] for c in date_cols if c in col_index), None)

    def dated_rows() -> frozenset:
        # A file that is not well formed: every row whose date cell reads counts as
        # possible food (it only makes a day wait longer before it is emptied).
        if date_col is None:
            return frozenset()
        return frozenset(d for d in (parse_date(cells[date_col]) if len(cells) > date_col else None
                                     for cells in raw_rows if any(c.strip() for c in cells)) if d)

    if kind == "servings" and "food name" not in col_index:
        return FileScan(False, f"{label} has no Food Name column", food_dates=dated_rows())
    # Both files: without Energy the two could share no nutrient, and two files
    # that compare nothing agree on everything.
    if REQUIRED_NUTRIENT not in col_index:
        return FileScan(False, f"{label} has no Energy column", food_dates=dated_rows())
    if date_col is None:
        return FileScan(False, f"{label} has no date column")
    group_col = col_index.get("group") if kind == "daily" else None
    # Every recognized nutrient column is read and compared (a pill that only carries
    # micronutrients changes no macro); in the daily summary every one also decides
    # whether a day has food: a day with only water or a zero-calorie drink has 0
    # energy but is not empty.
    nutrient_cols = [(n, i) for n, i in col_index.items() if n in NAME_TO_COL]
    nutrients = frozenset(n for n, _i in nutrient_cols)
    energy_col = col_index[REQUIRED_NUTRIENT]

    by_date: dict[str, float] = {}
    totals: dict[str, dict[str, float]] = {}
    invalid: set[str] = set()
    no_energy: set[str] = set()
    food: set[str] = set()
    bad_width = bad_date = 0
    for cells in raw_rows:
        if not any(c.strip() for c in cells):
            continue
        if len(cells) != len(headers):
            bad_width += 1
            day = parse_date(cells[date_col]) if len(cells) > date_col else None
            if day:
                food.add(day)
            continue
        day = parse_date(cells[date_col])
        if not day:
            bad_date += 1
            continue
        # name -> number, for the cells that hold one; blank cells are left out, and
        # an unreadable cell is left out AND marks the day (it is never a 0).
        values: dict[str, float] = {}
        unreadable = False
        for n, i in nutrient_cols:
            ok, num = strict_num(cells[i])
            if not ok:
                unreadable = True
            elif num is not None:
                values[n] = num
        if unreadable:
            invalid.add(day)
        if kind == "servings":
            food.add(day)                     # every entry is food, whatever its values
            by_date[day] = by_date.get(day, 0) + 1
            sums = totals.setdefault(day, {})
            for n in nutrients:
                sums[n] = sums.get(n, 0.0) + values.get(n, 0.0)
        else:
            content = max((abs(v) for v in values.values()), default=0.0)
            by_date[day] = max(by_date.get(day, 0.0), content)
            if content > 0 or unreadable:
                food.add(day)
            # Same rule as build_daily_rows: the Total row (or the only row) is the day.
            if group_col is None or cells[group_col].strip().lower() == "total":
                if cells[energy_col].strip() == "":
                    no_energy.add(day)
                    food.add(day)             # unknown, so it may be food
                totals[day] = {n: values.get(n, 0.0) for n in nutrients}
    food_dates = frozenset(food)
    if bad_width:
        return FileScan(False, f"{bad_width} row(s) of {label} do not have {len(headers)} cells",
                        food_dates=food_dates)
    if bad_date:
        return FileScan(False, f"{bad_date} row(s) of {label} have no readable date",
                        food_dates=food_dates)
    return FileScan(True, None, by_date, totals, nutrients, frozenset(invalid), frozenset(no_energy),
                    food_dates)


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
    Complete (days without food are passed to the database, which empties a stored
    one on its second look) only when, in addition, every date lies in the window,
    every nutrient cell the files carry for the window is blank or a finite number,
    every daily Total row has an Energy value, every servings day has a daily Total
    row whose every nutrient the two files share (Energy always among them) equals
    the day's servings summed, and the daily summary shows no food (no nutrient
    above 0) on a day without servings. Otherwise the days in doubt are listed in
    skip_dates and nothing is emptied; days whose daily row is the doubt are listed
    in daily_skip_dates too.

    food_dates (every return): the days either file shows or may show food on,
    whether or not they are written, so each loses its empty-day record.

    Only a day strictly between the first and last day with servings in this
    export is offered for emptying: the export shows food on both sides of it, so
    it covered that date. That also keeps the first and last day of the window out
    (nothing has checked that Cronometer's start and end are both inclusive; the
    windows of the twice-daily runs overlap), and an export with fewer than two
    days with food offers nothing.
    """
    start, end = window
    s = scan_export_file(servings_path, "servings")
    d = scan_export_file(daily_path, "daily")
    daily_skip = tuple(sorted(d.invalid_dates | d.no_energy_dates)) if d.ok else ()
    food = tuple(sorted(s.food_dates | d.food_dates))
    if not s.ok or not d.ok:
        reason = s.reason if not s.ok else d.reason
        return ExportCheck(False, False, reason or "the export is not usable", d.ok, d.reason,
                           daily_skip_dates=daily_skip, food_dates=food)
    nutrients = s.nutrients & d.nutrients
    if REQUIRED_NUTRIENT not in nutrients:     # both scans refuse a file without it; belt and braces
        return ExportCheck(False, False, "the two files have no Energy column to compare", True, None,
                           daily_skip_dates=daily_skip, food_dates=food)

    lo, hi = start.isoformat(), end.isoformat()
    outside = {x for x in (*s.by_date, *d.by_date) if not (lo <= x <= hi)}
    inside = set(s.by_date) - outside
    invalid = (s.invalid_dates | d.invalid_dates) - outside
    no_energy = d.no_energy_dates - outside
    doubt = invalid | no_energy                 # a value the comparison needs is not known
    no_total = {x for x in inside if x not in d.totals}
    mismatch = {x for x in inside - no_total - doubt
                if not _sums_agree(s.totals[x], d.totals[x], nutrients)}
    food_without_servings = {x for x, content in d.by_date.items()
                             if content > 0 and x not in s.by_date and x not in outside}
    reasons = []
    if outside:
        reasons.append(f"{len(outside)} date(s) lie outside the requested window")
    if invalid:
        reasons.append(f"{len(invalid)} day(s) have a nutrient value that is not a number")
    if no_energy:
        reasons.append(f"{len(no_energy)} day(s) have a daily Total row with no Energy value")
    if no_total:
        reasons.append(f"{len(no_total)} day(s) have servings but no daily Total row")
    if mismatch:
        reasons.append(f"on {len(mismatch)} day(s) the servings do not add up to the daily total")
    if food_without_servings:
        reasons.append(f"the daily summary shows food on {len(food_without_servings)} day(s) "
                       "that have no servings")
    if reasons:
        return ExportCheck(True, False, "; ".join(reasons), True, None,
                           skip_dates=tuple(sorted(outside | doubt | no_total | mismatch)),
                           daily_skip_dates=daily_skip, food_dates=food)

    food_days = sorted(s.by_date)
    if len(food_days) < 2:
        return ExportCheck(True, True, None, True, None, food_dates=food)
    first, last = food_days[0], food_days[-1]
    between = [x for x in _window_dates(start, end) if first < x < last]
    # A day with food (food_dates) is never offered: disjoint by construction (an
    # empty day is in neither file; a servings-empty day has no entry, no nutrient
    # above 0 and, the export being complete, nothing unreadable), and filtered
    # anyway, since the database function refuses an overlap.
    seen = set(food)
    empty = tuple(x for x in between if x not in s.by_date and x not in d.by_date and x not in seen)
    servings_empty = tuple(x for x in between
                           if x not in s.by_date and x in d.totals and d.by_date.get(x, 0.0) == 0
                           and x not in seen)
    return ExportCheck(True, True, None, True, None, empty, servings_empty, (), food_dates=food)


def trusted_window(window) -> tuple[date, date] | None:
    """Validate the window the automated export asked for; None = treat as manual."""
    if window is None:
        return None
    start, end = window
    # type(...) is date, not isinstance: a datetime is a date subclass, and its
    # isoformat() ("YYYY-MM-DDT00:00:00") would match no exported day, so every
    # inner day would look empty.
    if type(start) is not date or type(end) is not date or end < start:
        raise ValueError("window must be (start_date, end_date) of datetime.date with start <= end")
    if (end - start).days + 1 > MAX_WINDOW_DAYS:
        return None   # a very long backfill: replace the dates with rows, empty nothing
    return start, end


# ── Writers ─────────────────────────────────────────────────────────────────────
REPLACE_SERVINGS_RPC = "replace_cronometer_servings"
REPLACE_SERVINGS_SQL = "sql/cronometer_replace_servings.sql"
REPLACE_WINDOW_RPC = "replace_cronometer_servings_window"
REPLACE_WINDOW_SQL = "sql/cronometer_replace_servings_window.sql"
# Defined in the same file as the window function, so both exist or neither does.
REPLACE_IMPORT_RPC = "replace_cronometer_servings_and_daily"
EMPTY_CANDIDATES_TABLE = "cronometer_empty_day_candidates"


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


def _is_count(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def import_servings_and_daily(rows: list[dict], daily_rows: list[dict], dry_run: bool,
                              sb=None) -> tuple[int, int, str]:
    """Replace the servings of the dates in `rows` AND upsert `daily_rows`, in ONE
    transaction (pds.replace_cronometer_servings_and_daily, which takes the same lock
    as the automated export's write). Used by every import without a window (a
    manual export, a run with emptying off, a very long backfill), and by the
    automated export while the window function is not applied yet. Only dates that
    have rows are replaced, so nothing is emptied.
    Every date it writes (servings or a daily row) also loses its empty-day record,
    so a day an earlier automated export showed empty needs two new looks again.

    One transaction matters since the automated export can empty a day: with the
    daily upsert as a separate request, a manual import's servings could land, the
    automated export empty that day, and the manual daily row then put the day's
    old total back with no servings under it.

    Returns (servings inserted, daily rows upserted, mode): "combined" (one call),
    "fallback" (the function is not in the database yet: the failed call changed
    nothing, so the date-set function replaced the servings and the daily rows were
    upserted as separate requests, as before), "dry_run" or "none" (no call).
    """
    if not rows and not daily_rows:
        return 0, 0, "none"
    if dry_run:
        return len(rows), len(daily_rows), "dry_run"
    if sb is None:
        sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    params = {"p_dates": sorted({r["calendar_date"] for r in rows}), "p_rows": rows,
              "p_daily_rows": daily_rows}
    try:
        res = sb.schema("pds").rpc(REPLACE_IMPORT_RPC, params).execute()
    except Exception as e:  # noqa: BLE001
        if _is_missing_function(e, REPLACE_IMPORT_RPC):
            return import_servings(rows, False, sb), import_daily(daily_rows, False, sb), "fallback"
        raise
    data = res.data
    ok = isinstance(data, dict) and _is_count(data.get("inserted")) and _is_count(data.get("daily_upserted"))
    if not ok or data["inserted"] != len(rows) or data["daily_upserted"] != len(daily_rows):
        raise RuntimeError(
            f"pds.{REPLACE_IMPORT_RPC} answered {data!r} for {len(rows)} serving and "
            f"{len(daily_rows)} daily rows sent; the import cannot be confirmed."
        )
    return data["inserted"], data["daily_upserted"], "combined"


_WINDOW_REPLY_INTS = ("inserted", "daily_upserted", "cleared_days", "cleared_servings",
                      "cleared_daily", "refused_days", "pending_days")


def import_servings_window(rows: list[dict], daily_rows: list[dict], window: tuple[date, date],
                           empty_dates, servings_empty_dates, max_empty_days: int,
                           dry_run: bool, sb=None, food_dates=()) -> dict:
    """Automated export only: in ONE transaction (pds.replace_cronometer_servings_window)
    replace the servings of the dates with rows, upsert the daily totals, and handle
    the days without food.

    empty_dates: days in neither file (servings and daily row are emptied).
    servings_empty_dates: days the daily summary lists with no food (servings are
    emptied; their daily row is in daily_rows and is rewritten from the export).
    Both must come from check_trusted_export on the same files, and every one of
    them must lie strictly between the first and last date of `rows` (the function
    refuses the call otherwise).
    food_dates: every day the export shows (or may show) food on, written or not
    (check_trusted_export's food_dates, for every export, usable or not): each loses
    its empty-day record, so food seen on a day whose rows are not written still
    starts its count over. A call may carry nothing else. A stored one of
    these days is emptied only on its second look: the function records the first
    export that shows it empty and empties it when an export at least
    EMPTY_CONFIRM_HOURS later still does (pending_days = recorded, not emptied yet).
    Writing the daily totals in the same transaction means two overlapping imports
    can never leave one import's daily total next to the other import's servings.

    Returns a dict with the function's counts plus "mode":
      "window"   the function ran (cleared_days / pending_days / refused_days say
                 what it did)
      "fallback" the function is not in the database yet: the failed call changed
                 nothing, so import_servings_and_daily wrote the dates with rows
                 and the daily totals (falling back further to the date-set
                 function when that is missing too), and nothing was emptied
      "dry_run" / "none"  no call was made
    """
    if not isinstance(max_empty_days, int) or isinstance(max_empty_days, bool) or max_empty_days < 0:
        raise ValueError("max_empty_days must be an integer >= 0")
    empty = sorted(set(empty_dates))
    s_empty = sorted(set(servings_empty_dates))
    food = sorted(set(food_dates))
    base = {"inserted": 0, "daily_upserted": 0, "empty_dates": len(empty) + len(s_empty),
            "cleared_days": 0, "cleared_servings": 0, "cleared_daily": 0, "refused_days": 0,
            "pending_days": 0}
    if not rows and not daily_rows and not empty and not s_empty and not food:
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
        "p_food_dates": food,
        "p_daily_rows": daily_rows,
        "p_max_cleared_days": max_empty_days,
    }
    try:
        res = sb.schema("pds").rpc(REPLACE_WINDOW_RPC, params).execute()
    except Exception as e:  # noqa: BLE001
        if _is_missing_function(e, REPLACE_WINDOW_RPC):
            # Rollout order: the code can ship before the SQL. The failed call was
            # rejected before it ran, so nothing changed; neither fallback can
            # empty a day (and without this file there is no empty-day record to
            # forget: the candidates table is created by the same file).
            inserted, daily_upserted, _mode = import_servings_and_daily(rows, daily_rows, False, sb)
            return {**base, "inserted": inserted, "daily_upserted": daily_upserted, "mode": "fallback"}
        raise
    data = res.data
    ok = isinstance(data, dict) and all(_is_count(data.get(k)) for k in _WINDOW_REPLY_INTS)
    if not ok or data["inserted"] != len(rows) or data["daily_upserted"] != len(daily_rows):
        raise RuntimeError(
            f"pds.{REPLACE_WINDOW_RPC} answered {data!r} for {len(rows)} serving and "
            f"{len(daily_rows)} daily rows sent; the import cannot be confirmed."
        )
    return {**base, **{k: data[k] for k in _WINDOW_REPLY_INTS}, "mode": "window"}


def window_outcome(result: dict, check: ExportCheck, max_empty_days: int) -> tuple[str, str | None]:
    """(servings heartbeat status, note) for an automated import. Counts only.

    A success note (days emptied, or days waiting for their second look) is kept on
    the servings heartbeat only, so sync_log records it without turning the /status
    card (which reads the daily heartbeat) red.
    """
    notes = []
    if not check.complete:
        skipped = len(check.skip_dates)
        notes.append(f"nothing emptied{f' and the servings of {skipped} day(s) not written' if skipped else ''}: "
                     f"{check.reason}")
    if result.get("mode") == "fallback":
        notes.append(f"days with no food in Cronometer were not emptied: apply {REPLACE_WINDOW_SQL} "
                     "once; days with food were replaced as before")
    refused = result.get("refused_days", 0)
    if refused:
        # The scheduled workflow has no input for the limit, so the override is a run
        # on a PC, between the session download and upload (the run rotates the saved
        # Cronometer session; without the upload the next scheduled run logs in fresh).
        notes.append(f"{refused} stored day(s) have no food in Cronometer any more, more than the limit "
                     f"of {max_empty_days} per run, so none were emptied; check them in Cronometer, then "
                     "on a PC with the Cronometer and Supabase keys run python ci_token_helper.py download "
                     f"cronometer, python cronometer_etl.py --max-empty-days {refused}, python "
                     "ci_token_helper.py upload cronometer (the scheduled run keeps the limit; a day is "
                     f"emptied once exports at least {EMPTY_CONFIRM_HOURS} h apart both showed it empty)")
    if notes:
        return "partial", "; ".join(notes)
    done = []
    if result.get("cleared_days"):
        done.append(f"emptied {result['cleared_days']} day(s) with no food in Cronometer any more, seen "
                    f"empty by exports at least {EMPTY_CONFIRM_HOURS} h apart ({result['cleared_servings']} "
                    f"serving row(s), {result['cleared_daily']} daily row(s); copies in "
                    "pds.cronometer_cleared_rows)")
    if result.get("pending_days"):
        done.append(f"{result['pending_days']} stored day(s) have no food in Cronometer any more; each is "
                    f"emptied once an export at least {EMPTY_CONFIRM_HOURS} h after the first that showed "
                    "it empty still does")
    return "success", "; ".join(done) or None


def _read_client():
    """A client for the dry run's read-only counts; None when it cannot be made."""
    try:
        return create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception:  # noqa: BLE001
        return None


def stored_empty_days(sb, empty_dates, servings_empty_dates) -> set[str] | None:
    """READ ONLY (dry run): which of these days hold stored rows, i.e. the days
    pds.replace_cronometer_servings_window counts against the limit. None = could not
    be read. Same rule as the function: a day in empty_dates counts when it has
    servings or a daily row, a day in servings_empty_dates when it has servings.
    """
    empty, s_empty = set(empty_dates), set(servings_empty_dates)
    if not empty and not s_empty:
        return set()
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
    return {x for x in empty if x in with_servings or x in with_daily} | (s_empty & with_servings)


def confirmed_count(sb, days) -> int | None:
    """READ ONLY (dry run): how many of these stored empty days an earlier export,
    at least EMPTY_CONFIRM_HOURS ago, already showed empty (the days a real run
    would empty now). None = could not be read (e.g. the SQL is not applied yet)."""
    days = sorted(days)
    if not days:
        return 0
    if sb is None:
        return None
    cutoff = datetime.now(timezone.utc) - timedelta(hours=EMPTY_CONFIRM_HOURS)
    try:
        got = (sb.schema("pds").table(EMPTY_CANDIDATES_TABLE)
               .select("calendar_date,first_seen_at").in_("calendar_date", days).execute().data) or []
        seen = {str(r["calendar_date"]): datetime.fromisoformat(str(r["first_seen_at"]).replace("Z", "+00:00"))
                for r in got}
    except Exception:  # noqa: BLE001
        return None
    return sum(1 for d in days if d in seen and seen[d] <= cutoff)


# ── Orchestration ────────────────────────────────────────────────────────────────
def run_import(paths: list[str], dry_run: bool = False, window: tuple[date, date] | None = None,
               max_empty_days: int = DEFAULT_MAX_EMPTY_DAYS) -> tuple[int, int]:
    """Return (servings_count, daily_count). Emits a sync_log heartbeat per data_type.

    window: ONLY the automated export passes it: the (start, end) dates it asked
    Cronometer for. With a window the export goes through check_trusted_export and
    one transaction writes the servings and daily totals; if the export is
    complete, its days without food that lie between two days with food are passed
    along too, and a stored one is emptied once a second export at least
    EMPTY_CONFIRM_HOURS after the first look still shows it empty (at most
    max_empty_days stored days per run). A file that is not well formed writes no
    servings; days the two files disagree on, or with a value that cannot be read,
    keep their stored servings; in both cases nothing is emptied (partial
    heartbeat). Every day either file shows food on, written or not, loses its
    empty-day record in the same call. Without a window (manual export) the
    servings of the dates with rows are replaced and the daily totals upserted in
    one call, which never empties a day and starts the empty-day count of every
    day it writes over.
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
    """Manual export (inbox, CLI, a very long backfill): the date-set replace of the
    servings plus the daily upsert, in one call (import_servings_and_daily)."""
    t0 = now_epoch()
    try:
        srows = build_serving_rows(servings_path, tz_log) if servings_path else []
        drows = build_daily_rows(daily_path) if daily_path else []
        scount, dcount, _mode = import_servings_and_daily(srows, drows, dry_run, sb)
    except Exception as e:  # noqa: BLE001
        if sb:
            for data_type in ("servings", "daily"):
                log_sync(sb, "cronometer", data_type, "error", error=str(e)[:500], started_at=t0)
        raise
    print(f"  servings: {scount} entries {'(dry-run)' if dry_run else 'imported'}"
          f"{' from ' + os.path.basename(servings_path) if servings_path else ' (no file)'}")
    print(f"  daily:    {dcount} days   {'(dry-run)' if dry_run else 'imported'}"
          f"{' from ' + os.path.basename(daily_path) if daily_path else ' (no file)'}")
    # Heartbeat on EVERY run, including a zero-row export (no food logged in the
    # window). Without this the /status card read "no heartbeat since July" while
    # the workflow itself was green (2026-10-17).
    _log_range(sb, "servings", "success", srows, scount, t0, None)
    _log_range(sb, "daily", "success", drows, dcount, t0, None)
    return scount, dcount


def _import_window(window, servings_path, daily_path, dry_run, sb, tz_log,
                   max_empty_days) -> tuple[int, int]:
    """Automated export: checked, then one transaction (see run_import)."""
    check = check_trusted_export(window, servings_path, daily_path)
    t0 = now_epoch()
    lo, hi = window[0].isoformat(), window[1].isoformat()
    daily_skip = set(check.daily_skip_dates)

    def window_daily_rows() -> list[dict]:
        # Days inside the window (the scope the window function accepts), minus the
        # days whose daily row has an unreadable value or no Energy value: their
        # stored row is kept instead of being overwritten with blanks.
        return [r for r in build_daily_rows(daily_path)
                if lo <= r["calendar_date"] <= hi and r["calendar_date"] not in daily_skip]

    if not check.usable:
        # The export could not prove it is the whole window: write no servings and
        # empty nothing (a replace of a cut-off day would lose its missing rows). A
        # well-formed daily summary is still upserted; a garbled one is not (a short
        # row would write NULL over a stored total). Either way the days the export
        # shows food on lose their empty-day record: one call under the shared lock.
        servings_note = f"servings not written, nothing emptied: {check.reason}"
        print(f"  servings: {servings_note}")
        _log_range(sb, "servings", "partial", [], 0, t0, servings_note)
        t1 = now_epoch()
        try:
            drows = window_daily_rows() if check.daily_ok and daily_path else []
            result = import_servings_window([], drows, window, (), (), max_empty_days, dry_run, sb,
                                            food_dates=check.food_dates)
            dcount = result["daily_upserted"]
            if check.daily_ok and daily_path:
                daily_note = f"servings: {servings_note}"
                print(f"  daily:    {dcount} days   {'(dry-run)' if dry_run else 'imported'}")
            else:
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

    skip = set(check.skip_dates)
    srows = [r for r in build_serving_rows(servings_path, tz_log) if r["calendar_date"] not in skip]
    drows = window_daily_rows()
    # A blank export (no food anywhere in the window, e.g. a logging pause) offers no
    # day for emptying: nothing in it shows which dates it covered. The days left out
    # of srows / drows still go along in food_dates (their empty-day record is
    # forgotten even though their rows are not written).
    try:
        result = import_servings_window(srows, drows, window, check.empty_dates,
                                        check.servings_empty_dates, max_empty_days, dry_run, sb,
                                        food_dates=check.food_dates)
    except Exception as e:  # noqa: BLE001
        if sb:
            log_sync(sb, "cronometer", "servings", "error", error=str(e)[:500], started_at=t0)
        raise

    n_empty = len(check.empty_dates) + len(check.servings_empty_dates)
    skipped = len(check.skip_dates)
    if dry_run:
        print(f"  servings: {result['inserted']} entries (dry-run); "
              f"the servings of {skipped} day(s) not written")
        print(f"  daily:    {result['daily_upserted']} days   (dry-run, same transaction)")
        if not check.complete:
            print(f"  empty days: none would be emptied: {check.reason}")
        else:
            client = _read_client()
            stored = stored_empty_days(client, check.empty_dates, check.servings_empty_dates)
            if stored is None:
                print(f"  empty days: {n_empty} day(s) between days with food have none; the stored days "
                      "could not be read, so the count of days a real run would empty is unknown")
            elif len(stored) > max_empty_days:
                print(f"  empty days: {len(stored)} stored day(s) have no food any more, more than the "
                      f"limit of {max_empty_days}: a real run would empty none")
            else:
                confirmed = confirmed_count(client, stored)
                if confirmed is None:
                    print(f"  empty days: {len(stored)} stored day(s) have no food any more (limit "
                          f"{max_empty_days}); whether an earlier export already showed them empty could "
                          "not be read")
                else:
                    print(f"  empty days: a real run would empty {confirmed} of {len(stored)} stored "
                          f"day(s) with no food any more (limit {max_empty_days}; {n_empty} day(s) between "
                          f"days with food have none); the other {len(stored) - confirmed} wait for an "
                          f"export at least {EMPTY_CONFIRM_HOURS} h after the first that showed them empty")
        return result["inserted"], result["daily_upserted"]

    status, note = window_outcome(result, check, max_empty_days)
    not_written = f"; the servings of {skipped} day(s) not written" if skipped else ""
    print(f"  servings: {result['inserted']} entries imported{not_written}")
    print(f"  daily:    {result['daily_upserted']} days   imported"
          f"{' (same transaction)' if result['mode'] == 'window' else ''}")
    print(f"  emptied {result['cleared_days']} day(s) with no food in Cronometer any more "
          f"({result['cleared_servings']} serving row(s), {result['cleared_daily']} daily row(s)); "
          f"{result['pending_days']} wait for a second look")
    if status != "success" and note:
        print(f"  servings: {note}")
    _log_range(sb, "servings", status, srows, result["inserted"], t0, note)
    # /status reads the daily heartbeat for the Cronometer card: a partial servings
    # run shows there too; a success note (days emptied or waiting) stays on servings only.
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
