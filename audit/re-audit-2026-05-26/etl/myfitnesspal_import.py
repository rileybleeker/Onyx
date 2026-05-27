"""
Personal Data Scientist — MyFitnessPal CSV Importer
====================================================
Imports MyFitnessPal nutrition data from CSV export into Supabase.

Usage:
    python myfitnesspal_import.py nutrition.csv
    python myfitnesspal_import.py nutrition.csv --dry-run

How to get the CSV:
    1. Open MyFitnessPal app → More → Settings → Export Data
    2. Select "Nutrition" and tap Export
    3. Wait for the email, download the CSV (or ZIP containing the CSV)
    4. Drop the CSV in mfp_inbox/ for auto-import, or run this script directly

MFP CSV format:
    Date,Meal,Calories,Carbohydrates (g),Fat (g),Protein (g),Sodium (mg),Sugar (g),Fiber (g)
    2026-04-01,Breakfast,450,50,12,30,300,8,4
    2026-04-01,Lunch,600,65,15,40,450,12,6
    2026-04-01,Dinner,700,70,20,50,500,15,8
    2026-04-01,Snacks,200,25,5,10,150,10,2
    2026-04-01,Daily Totals,1950,210,52,120,1400,45,18
"""

import os
import sys
import csv
import json
import argparse
import logging
from datetime import datetime
from collections import defaultdict

from dotenv import load_dotenv
from supabase import create_client, Client

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("myfitnesspal_import")

MEAL_NAMES = {"breakfast", "lunch", "dinner", "snacks", "snack"}
TOTALS_NAMES = {"daily totals", "totals"}


def parse_date(value: str) -> str | None:
    """Try common date formats and return YYYY-MM-DD."""
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y-%m-%dT%H:%M:%S",
                "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(value.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def normalise_col(name: str) -> str:
    """Strip unit suffixes and lowercase a column header for matching.

    e.g. "Carbohydrates (g)" → "carbohydrates"
         "Sodium (mg)"       → "sodium"
         "Fat (g)"           → "fat"
    """
    import re
    return re.sub(r"\s*\([^)]*\)", "", name).strip().lower()


def parse_float(value: str) -> float | None:
    """Parse a numeric cell, returning None on blank or non-numeric."""
    v = value.strip().replace(",", "")
    if not v or v.lower() in ("n/a", "-", "none", ""):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def parse_int(value: str) -> int | None:
    f = parse_float(value)
    return int(round(f)) if f is not None else None


def build_macro_dict(row: list[str], col_map: dict[str, int]) -> dict:
    """Extract macro fields from a CSV row using normalised column map."""

    def get(key):
        idx = col_map.get(key)
        return row[idx].strip() if idx is not None and idx < len(row) else ""

    return {
        "calories": parse_int(get("calories")),
        "protein_g": parse_float(get("protein")),
        "carbs_g": parse_float(get("carbohydrates")),
        "fat_g": parse_float(get("fat")),
        "fiber_g": parse_float(get("fiber")),
        "sugar_g": parse_float(get("sugar")),
        "sodium_mg": parse_float(get("sodium")),
    }


def import_nutrition(csv_path: str, dry_run: bool = False) -> int:
    """Parse a MyFitnessPal nutrition CSV and upsert to Supabase.

    Returns the number of rows upserted.
    """
    log.info(f"Reading {csv_path}...")

    with open(csv_path, "r", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        raw_headers = next(reader)
        rows = list(reader)

    # Build normalised column index map
    col_map: dict[str, int] = {}
    for i, h in enumerate(raw_headers):
        col_map[normalise_col(h)] = i

    if "date" not in col_map or "meal" not in col_map or "calories" not in col_map:
        raise ValueError(
            f"Expected Date, Meal, Calories columns. Found: {raw_headers}"
        )

    date_idx = col_map["date"]
    meal_idx = col_map["meal"]

    # Group rows by calendar_date
    by_date: dict[str, dict] = defaultdict(lambda: {"totals": None, "meals": {}})

    skipped = 0
    for row in rows:
        if len(row) <= max(date_idx, meal_idx):
            skipped += 1
            continue

        calendar_date = parse_date(row[date_idx])
        if not calendar_date:
            skipped += 1
            continue

        meal = row[meal_idx].strip().lower()
        macros = build_macro_dict(row, col_map)

        if meal in TOTALS_NAMES:
            by_date[calendar_date]["totals"] = macros
        elif meal in MEAL_NAMES:
            # Store under canonical name (normalise "snack" → "snacks")
            key = "snacks" if meal == "snack" else meal
            by_date[calendar_date]["meals"][key] = macros

    if skipped:
        log.debug(f"Skipped {skipped} malformed/empty rows")

    if not by_date:
        log.warning("No nutrition entries found in CSV")
        return 0

    # Build one db row per date
    db_rows = []
    for calendar_date in sorted(by_date.keys()):
        entry = by_date[calendar_date]
        totals = entry["totals"]
        meals = entry["meals"]

        # If no Daily Totals row, sum the individual meals
        if totals is None and meals:
            totals = {"calories": 0, "protein_g": 0.0, "carbs_g": 0.0,
                      "fat_g": 0.0, "fiber_g": 0.0, "sugar_g": 0.0,
                      "sodium_mg": 0.0}
            for m in meals.values():
                for k in totals:
                    if m.get(k) is not None:
                        totals[k] = (totals[k] or 0) + m[k]

        if totals is None:
            continue

        db_rows.append({
            "calendar_date": calendar_date,
            "calories": totals.get("calories"),
            "protein_g": totals.get("protein_g"),
            "carbs_g": totals.get("carbs_g"),
            "fat_g": totals.get("fat_g"),
            "fiber_g": totals.get("fiber_g"),
            "sugar_g": totals.get("sugar_g"),
            "sodium_mg": totals.get("sodium_mg"),
            "meals_json": json.dumps(meals) if meals else None,
            "raw_json": json.dumps({"totals": totals, "meals": meals}),
        })

    dates = [r["calendar_date"] for r in db_rows]
    log.info(f"Parsed {len(db_rows)} days of nutrition data")
    if dates:
        log.info(f"  Date range: {min(dates)} — {max(dates)}")

    if dry_run:
        log.info("Dry run — skipping database insert")
        for r in db_rows[:5]:
            log.info(f"  {r['calendar_date']}: {r['calories']} kcal | "
                     f"P:{r['protein_g']}g C:{r['carbs_g']}g F:{r['fat_g']}g")
        if len(db_rows) > 5:
            log.info(f"  ... and {len(db_rows) - 5} more")
        return len(db_rows)

    # Upsert to Supabase in batches
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    batch_size = 500
    total = 0

    for i in range(0, len(db_rows), batch_size):
        batch = db_rows[i:i + batch_size]
        result = (
            sb.schema("pds")
            .table("myfitnesspal_nutrition")
            .upsert(batch, on_conflict="calendar_date")
            .execute()
        )
        count = len(result.data) if result.data else 0
        total += count
        log.info(f"  Batch {i // batch_size + 1}: {count} rows upserted")

    log.info(f"Done! {total} nutrition days synced to Supabase")
    return total


def main():
    parser = argparse.ArgumentParser(description="MyFitnessPal CSV → Supabase")
    parser.add_argument("csv_file", help="Path to nutrition CSV from MFP export")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse and summarize without writing to database")
    args = parser.parse_args()

    if not os.path.exists(args.csv_file):
        log.error(f"File not found: {args.csv_file}")
        sys.exit(1)

    log.info("=" * 60)
    log.info("Personal Data Scientist — MyFitnessPal Import")
    log.info("=" * 60)

    import_nutrition(args.csv_file, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
