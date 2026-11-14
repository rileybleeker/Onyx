-- ============================================================================
-- Focus habit unlock (2026-11-13): which Onyx habits unlock the iPhone Focus
-- block, and how they combine with the phone's unlock time.
-- ============================================================================
-- One row (id = 1). No row means the default: no habits chosen, rule 'or',
-- which the phone treats exactly like the time-only Focus it had before.
--
--   rule            'or'  = finishing the chosen habits unlocks early; the
--                           unlock time unlocks regardless
--                   'and' = stays blocked after the unlock time until the
--                           chosen habits are done
--   habit_page_ids  Notion page ids of the chosen habits = the primary key of
--                   pds.habit_name_map (so a renamed habit stays chosen). The
--                   name is resolved through that map when the status is read;
--                   "done" = a pds.habit_journal row with answer 'Yes' for the
--                   behavioral day.
--
-- Written by PUT /api/focus/config (owner session). Read by
-- GET /api/focus/unlock-status (the iPhone app, CI token) and GET /api/focus/config.
--
-- SERVICE ROLE ONLY: RLS on, no policies, nothing granted to anon or
-- authenticated. The browser never queries this table; it goes through the
-- two routes above.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.focus_unlock_config (
    id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    rule            TEXT NOT NULL DEFAULT 'or' CHECK (rule IN ('or', 'and')),
    habit_page_ids  TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(habit_page_ids) <= 10),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pds.focus_unlock_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pds.focus_unlock_config FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON pds.focus_unlock_config TO service_role;
