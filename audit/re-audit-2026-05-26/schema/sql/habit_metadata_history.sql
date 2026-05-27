-- =============================================================================
-- pds.habit_metadata_history — snapshot Frequency / Category over time
-- =============================================================================
-- Closes Notion roadmap "Habit metadata history: snapshot Frequency / Category
-- changes so streaks + rates don't silently recompute retroactively"
-- (page 36abf5b4-4bf2-81b5-bd37-ecde799fd280).
--
-- Problem: /habits reads Frequency + Category live from Notion and applies them
-- uniformly to all historical completions. Changing a habit's Frequency or
-- Category mid-cycle silently rewrites every KPI / chart / streak as if the
-- habit had ALWAYS been the new value. This table fixes that by storing
-- closed intervals of (frequency, category) per notion_page_id, so /habits
-- can resolve which values were in effect on any specific date.
--
-- Convention: ONE open interval (valid_to IS NULL) per habit at any time =
-- the current Notion state. Closed intervals (valid_to NOT NULL) are
-- historical. valid_from is inclusive; valid_to is inclusive of the last
-- day the prior values were in effect.
--
-- Population path (no separate backfill script): the existing
-- /api/habits/sync route gets a diff step. On every sync run, for each
-- active habit, compare the current Notion (frequency, category) against
-- the open interval. If none exists, seed one with valid_from = earliest
-- cycle_date in habit_journal for that habit (or today if no completions).
-- If exists and differs, close the prior (valid_to = today − 1) and insert
-- a new open interval (valid_from = today).
--
-- Pre-history (before the first row) is implicitly "always was the seed
-- values" — same assumption /habits made before this table existed.
-- =============================================================================

CREATE TABLE IF NOT EXISTS pds.habit_metadata_history (
    notion_page_id  TEXT NOT NULL,
    valid_from      DATE NOT NULL,
    valid_to        DATE NULL,        -- NULL = open interval (current state)
    frequency       TEXT NOT NULL,
    category        TEXT NULL,
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (notion_page_id, valid_from)
);

CREATE INDEX IF NOT EXISTS idx_habit_metadata_history_page_open
    ON pds.habit_metadata_history (notion_page_id)
    WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_habit_metadata_history_page_from
    ON pds.habit_metadata_history (notion_page_id, valid_from DESC);

-- A habit should have AT MOST one open interval at any time. Enforce via
-- partial unique index (Postgres expression indexes can't be UNIQUE
-- constraints, so this is the standard pattern).
CREATE UNIQUE INDEX IF NOT EXISTS uq_habit_metadata_history_one_open
    ON pds.habit_metadata_history (notion_page_id)
    WHERE valid_to IS NULL;

ALTER TABLE pds.habit_metadata_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON pds.habit_metadata_history;
CREATE POLICY "anon_read" ON pds.habit_metadata_history FOR SELECT TO anon USING (true);

GRANT SELECT ON pds.habit_metadata_history TO anon, authenticated;
