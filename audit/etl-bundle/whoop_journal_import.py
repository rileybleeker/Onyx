"""
Personal Data Scientist — WHOOP Journal CSV Importer
=====================================================
Imports WHOOP Journal data from CSV export into Supabase.

Usage:
    python whoop_journal_import.py journal_entries.csv

How to get the CSV:
    1. Open WHOOP app → More → App Settings → Data Export
    2. Wait for email, download the ZIP
    3. Extract journal_entries.csv
    4. Run this script

The script auto-detects two common CSV formats:
    A) Wide format — one row per day, columns = behaviors (most common)
    B) Long format — one row per entry with question/answer columns
"""

import os
import sys
import csv
import argparse
import logging
from datetime import datetime

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
log = logging.getLogger("whoop_journal_import")

# Known WHOOP journal categories (best-effort mapping)
CATEGORY_MAP = {
    # Supplements
    "ashwagandha": "Supplements", "cbd": "Supplements", "creatine": "Supplements",
    "electrolytes": "Supplements", "fish oil": "Supplements", "iron": "Supplements",
    "magnesium": "Supplements", "melatonin": "Supplements", "multivitamin": "Supplements",
    "probiotic": "Supplements", "protein supplement": "Supplements",
    "turmeric": "Supplements", "vitamin b": "Supplements", "vitamin c": "Supplements",
    "vitamin d": "Supplements", "zinc": "Supplements",
    # Lifestyle
    "alcohol": "Lifestyle", "caffeine": "Lifestyle", "nicotine": "Lifestyle",
    "sex": "Lifestyle", "working from home": "Lifestyle", "travel": "Lifestyle",
    "time in nature": "Lifestyle", "social activity": "Lifestyle",
    # Nutrition
    "late meal": "Nutrition", "paleo": "Nutrition", "plant-based": "Nutrition",
    "intermittent fasting": "Nutrition", "keto": "Nutrition", "hydration": "Nutrition",
    # Sleep
    "blue-light blocking glasses": "Sleep", "sound machine": "Sleep",
    "sleep mask": "Sleep", "reading before bed": "Sleep",
    "screen time before bed": "Sleep", "nap": "Sleep",
    # Recovery
    "acupuncture": "Recovery", "cold exposure": "Recovery", "ice bath": "Recovery",
    "massage": "Recovery", "sauna": "Recovery", "stretching": "Recovery",
    "foam rolling": "Recovery", "compression": "Recovery", "epsom salt bath": "Recovery",
    # Mental Health
    "anxiety": "Mental Health", "meditation": "Mental Health",
    "journaling": "Mental Health", "therapy": "Mental Health",
    "breathwork": "Mental Health", "gratitude practice": "Mental Health",
    # Health & Symptoms
    "fever": "Health & Symptoms", "headache": "Health & Symptoms",
    "illness": "Health & Symptoms", "allergy": "Health & Symptoms",
    "pain": "Health & Symptoms",
    # Medication
    "antibiotic": "Medication", "anti-inflammatory": "Medication",
    "pain reliever": "Medication", "birth control": "Medication",
    # Hormonal Health
    "cramps": "Hormonal Health", "hot flash": "Hormonal Health",
    "period": "Hormonal Health", "pms": "Hormonal Health",
}


def guess_category(question: str) -> str | None:
    """Best-effort category assignment from question text."""
    q = question.lower().strip()
    return CATEGORY_MAP.get(q)


def parse_date(value: str) -> str | None:
    """Try common date formats and return YYYY-MM-DD."""
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y-%m-%dT%H:%M:%S",
                "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(value.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def detect_format(headers: list[str]) -> str:
    """Detect whether the CSV is wide-format or long-format."""
    lower = [h.lower().strip() for h in headers]

    # Long format: has explicit question/answer columns
    if "question" in lower and "answer" in lower:
        return "long"

    # Long format: WHOOP data export uses "question text" + "answered yes"
    if any("question" in h for h in lower) and any("answer" in h for h in lower):
        return "long"

    # Wide format: has a date column + many behavior columns
    date_cols = {"date", "cycle start time", "cycle_start", "cycle date",
                 "cycle_date", "created at", "created_at"}
    if date_cols & set(lower):
        return "wide"

    # Default: assume wide if many columns, long if few
    return "wide" if len(headers) > 5 else "long"


def find_date_column(headers: list[str]) -> int:
    """Find the index of the date column in wide-format CSV."""
    candidates = {"date", "cycle start time", "cycle_start", "cycle date",
                  "cycle_date", "created at", "created_at"}
    for i, h in enumerate(headers):
        if h.lower().strip() in candidates:
            return i
    return 0  # Fall back to first column


def parse_wide_format(reader, headers: list[str]) -> list[dict]:
    """Parse wide-format CSV: one row per day, columns = behaviors."""
    date_idx = find_date_column(headers)
    behavior_cols = [(i, h.strip()) for i, h in enumerate(headers) if i != date_idx and h.strip()]

    rows = []
    for line in reader:
        if not line or len(line) <= date_idx:
            continue

        cycle_date = parse_date(line[date_idx])
        if not cycle_date:
            continue

        for col_idx, question in behavior_cols:
            if col_idx >= len(line):
                continue
            answer = line[col_idx].strip() if line[col_idx] else None
            if not answer or answer.lower() in ("", "n/a", "nan", "none"):
                continue

            rows.append({
                "cycle_date": cycle_date,
                "question": question,
                "category": guess_category(question),
                "answer": answer,
                "notes": None,
            })

    return rows


def parse_long_format(reader, headers: list[str]) -> list[dict]:
    """Parse long-format CSV: one row per question-answer pair."""
    lower = [h.lower().strip() for h in headers]

    date_idx = None
    question_idx = None
    answer_idx = None
    category_idx = None
    notes_idx = None

    for i, h in enumerate(lower):
        if h in ("date", "cycle_date", "cycle date", "cycle start time"):
            date_idx = i
        elif h in ("question", "behavior", "behaviour", "journal_question",
                    "question text"):
            question_idx = i
        elif h in ("answer", "response", "value", "answered yes"):
            answer_idx = i
        elif h in ("category", "group", "type"):
            category_idx = i
        elif h in ("notes", "note", "comment"):
            notes_idx = i

    if date_idx is None or question_idx is None or answer_idx is None:
        raise ValueError(
            f"Long-format CSV must have date, question, and answer columns. "
            f"Found headers: {headers}"
        )

    rows = []
    for line in reader:
        if len(line) <= max(date_idx, question_idx, answer_idx):
            continue

        cycle_date = parse_date(line[date_idx])
        question = line[question_idx].strip() if line[question_idx] else None
        answer = line[answer_idx].strip() if line[answer_idx] else None

        if not cycle_date or not question or not answer:
            continue
        if answer.lower() in ("n/a", "nan", "none"):
            continue
        # Normalize boolean answers from WHOOP export
        if answer.lower() == "true":
            answer = "Yes"
        elif answer.lower() == "false":
            answer = "No"

        category = None
        if category_idx is not None and category_idx < len(line):
            category = line[category_idx].strip() or None
        if not category:
            category = guess_category(question)

        notes = None
        if notes_idx is not None and notes_idx < len(line):
            notes = line[notes_idx].strip() or None

        rows.append({
            "cycle_date": cycle_date,
            "question": question,
            "category": category,
            "answer": answer,
            "notes": notes,
        })

    return rows


def import_journal(csv_path: str, dry_run: bool = False) -> int:
    """Parse a WHOOP journal CSV and upsert into Supabase."""
    log.info(f"Reading {csv_path}...")

    with open(csv_path, "r", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        headers = next(reader)
        fmt = detect_format(headers)
        log.info(f"Detected format: {fmt} ({len(headers)} columns)")

        if fmt == "wide":
            rows = parse_wide_format(reader, headers)
        else:
            rows = parse_long_format(reader, headers)

    # Deduplicate by (cycle_date, question), keeping last occurrence
    seen = {}
    for row in rows:
        seen[(row["cycle_date"], row["question"])] = row
    rows = list(seen.values())

    log.info(f"Parsed {len(rows)} journal entries")

    if not rows:
        log.warning("No journal entries found in CSV")
        return 0

    # Summary
    dates = sorted(set(r["cycle_date"] for r in rows))
    questions = sorted(set(r["question"] for r in rows))
    log.info(f"  Date range: {dates[0]} — {dates[-1]}")
    log.info(f"  Unique behaviors: {len(questions)}")

    if dry_run:
        log.info("Dry run — skipping database insert")
        for q in questions[:20]:
            log.info(f"    • {q}")
        if len(questions) > 20:
            log.info(f"    ... and {len(questions) - 20} more")
        return len(rows)

    # Upsert to Supabase in batches
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    batch_size = 500
    total = 0

    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        result = (
            sb.schema("pds")
            .table("whoop_journal")
            .upsert(batch, on_conflict="cycle_date,question")
            .execute()
        )
        count = len(result.data) if result.data else 0
        total += count
        log.info(f"  Batch {i // batch_size + 1}: {count} rows upserted")

    log.info(f"Done! {total} journal entries synced to Supabase")
    return total


def main():
    parser = argparse.ArgumentParser(description="WHOOP Journal CSV → Supabase")
    parser.add_argument("csv_file", help="Path to journal_entries.csv from WHOOP export")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse and summarize without writing to database")
    args = parser.parse_args()

    if not os.path.exists(args.csv_file):
        log.error(f"File not found: {args.csv_file}")
        sys.exit(1)

    log.info("=" * 60)
    log.info("Personal Data Scientist — WHOOP Journal Import")
    log.info("=" * 60)

    import_journal(args.csv_file, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
