-- ============================================================================
-- Audit re-2026-05-26 P1: FK habit_journal.question → habit_name_map.habit_name
-- ============================================================================
-- Notion: 36dbf5b4-4bf2-8139-b424-ddf07927dfb6
--
-- Background:
--   - habit_journal.question is free-text and loosely joined to
--     habit_name_map. No FK means typos / Notion renames could silently orphan
--     rows. Per CLAUDE.md, the habit-rename flow already auto-updates
--     historical habit_journal entries; this just promotes that invariant to
--     a constraint.
--   - Verified no orphans exist before applying; habit_name has no duplicates.
--   - The original ticket says `habit_name_map.name` — actual column is
--     `habit_name`. Same semantics.

-- 1) habit_name_map.habit_name must be UNIQUE for any table to FK it.
ALTER TABLE pds.habit_name_map
  ADD CONSTRAINT habit_name_map_habit_name_key UNIQUE (habit_name);

-- 2) FK on habit_journal.question.
--    ON UPDATE CASCADE       — matches the Notion-rename → propagate behaviour
--                              already implemented in the habit-sync code.
--    ON DELETE RESTRICT      — keep a habit definition while journal rows
--                              reference it (no silent loss of history).
ALTER TABLE pds.habit_journal
  ADD CONSTRAINT fk_habit_journal_question
  FOREIGN KEY (question)
  REFERENCES pds.habit_name_map (habit_name)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;
