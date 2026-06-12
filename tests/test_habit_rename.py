"""Habit-rename cascade regression test (audit Tier 3 #33).

Exercises the habit_name_map → habit_journal rename machinery using a
SYNTHETIC test habit ID + name, never touching real habits. Inserts test
fixtures, runs the rename, asserts historical journal rows updated, then
deletes everything it created.

Updated 2026-06-11 (WHOOP journal merge):
- fk_habit_journal_question (added 2026-05-27) requires the map row to exist
  BEFORE journal rows, and makes a direct UPDATE habit_journal.question to an
  unmapped name an FK violation — the old version of this test did both and
  failed. The rename is now performed the way production does it post-merge:
  UPDATE habit_name_map.habit_name and let ON UPDATE CASCADE migrate the
  journal rows.
- New case: channel='whoop' names are FROZEN (HRV pipeline variable
  identity); the habit_name_map_block_whoop_rename trigger must RAISE.

Run: python tests/test_habit_rename.py
"""
from __future__ import annotations
import os
import sys
import uuid
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env")

from supabase import create_client

SUPA = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

# Synthetic identifiers — clearly tagged so they cannot collide with real habits.
TEST_PAGE_ID = f"test-rename-{uuid.uuid4().hex[:12]}"
TEST_OLD_NAME = f"__TEST_HABIT_OLD_{uuid.uuid4().hex[:6]}__"
TEST_NEW_NAME = f"__TEST_HABIT_NEW_{uuid.uuid4().hex[:6]}__"
TEST_WHOOP_PAGE_ID = f"test-whoop-{uuid.uuid4().hex[:12]}"
TEST_WHOOP_NAME = f"__TEST_WHOOP_FROZEN_{uuid.uuid4().hex[:6]}__"


def _journal_rows_with(question: str) -> int:
    res = (
        SUPA.schema("pds")
        .from_("habit_journal")
        .select("cycle_date", count="exact")
        .eq("question", question)
        .execute()
    )
    return res.count or 0


def main() -> int:
    print(f"Test page_id : {TEST_PAGE_ID}")
    print(f"Old name     : {TEST_OLD_NAME}")
    print(f"New name     : {TEST_NEW_NAME}")

    # Pre-flight: nothing in the DB with these names yet
    assert _journal_rows_with(TEST_OLD_NAME) == 0, "test old name already in habit_journal"
    assert _journal_rows_with(TEST_NEW_NAME) == 0, "test new name already in habit_journal"

    # 1. Seed the map row FIRST (fk_habit_journal_question requires it), then
    #    3 historical journal entries under the OLD name.
    today = date.today()
    SUPA.schema("pds").from_("habit_name_map").insert({
        "notion_page_id": TEST_PAGE_ID, "habit_name": TEST_OLD_NAME,
    }).execute()
    journal_rows = [
        {"cycle_date": (today - timedelta(days=i)).isoformat(),
         "question": TEST_OLD_NAME, "category": "Test",
         "answer": "Yes", "notes": None}
        for i in range(1, 4)
    ]
    SUPA.schema("pds").from_("habit_journal").insert(journal_rows).execute()
    assert _journal_rows_with(TEST_OLD_NAME) == 3, "seed insert did not land 3 rows"

    try:
        # 2. Rename the way production does post-merge: update the map row and
        #    let fk_habit_journal_question's ON UPDATE CASCADE migrate the
        #    historical journal rows atomically.
        SUPA.schema("pds").from_("habit_name_map").update(
            {"habit_name": TEST_NEW_NAME}
        ).eq("notion_page_id", TEST_PAGE_ID).execute()

        # 3. Verify the cascade worked
        assert _journal_rows_with(TEST_OLD_NAME) == 0, \
            "rename did not migrate all old-name rows"
        assert _journal_rows_with(TEST_NEW_NAME) == 3, \
            "rename did not produce 3 new-name rows"
        map_rows = (
            SUPA.schema("pds").from_("habit_name_map")
            .select("habit_name").eq("notion_page_id", TEST_PAGE_ID).execute()
        )
        assert map_rows.data and map_rows.data[0]["habit_name"] == TEST_NEW_NAME, \
            "habit_name_map did not update"
        print("OK — rename cascade migrated all 3 historical rows + map entry")

        # 4. Guard coverage: a channel='whoop' name must be UN-renameable
        #    (habit_name_map_block_whoop_rename RAISEs — these names are the
        #    HRV pipeline's journal_* variable identities).
        SUPA.schema("pds").from_("habit_name_map").insert({
            "notion_page_id": TEST_WHOOP_PAGE_ID,
            "habit_name": TEST_WHOOP_NAME,
            "channel": "whoop",
        }).execute()
        guard_raised = False
        try:
            SUPA.schema("pds").from_("habit_name_map").update(
                {"habit_name": TEST_WHOOP_NAME + "_RENAMED"}
            ).eq("notion_page_id", TEST_WHOOP_PAGE_ID).execute()
        except Exception as exc:  # APIError carries the RAISE message
            guard_raised = "frozen" in str(exc).lower()
        assert guard_raised, \
            "renaming a channel='whoop' map row did not RAISE the freeze guard"
        print("OK — whoop-channel rename guard RAISEd as designed")
    finally:
        # 5. Cleanup — always runs, even on assert failure
        SUPA.schema("pds").from_("habit_journal").delete().in_(
            "question", [TEST_OLD_NAME, TEST_NEW_NAME]
        ).execute()
        SUPA.schema("pds").from_("habit_name_map").delete().in_(
            "notion_page_id", [TEST_PAGE_ID, TEST_WHOOP_PAGE_ID]
        ).execute()
        # Sanity check: nothing of ours left in the DB
        assert _journal_rows_with(TEST_OLD_NAME) == 0
        assert _journal_rows_with(TEST_NEW_NAME) == 0
        print("Cleanup complete — no test fixtures left in production DB")

    return 0


if __name__ == "__main__":
    sys.exit(main())
