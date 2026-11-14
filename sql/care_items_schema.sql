-- Care items for /health (health and recurring appointments), 2026-11-13.
--
--   pds.care_items   one row per care item / appointment Riley entered on /health: a short label,
--                    a kind, a calendar date with an optional wall-clock time and the IANA time zone
--                    that time is in, a "repeat N months after completion" rule, a note, and the
--                    booked / archived / last-completed flags.
--
-- Health-adjacent personal data. SERVICE ROLE ONLY: RLS on, no policies, nothing granted to anon /
-- authenticated. The browser never reads this table; /health and /api/care/* read and write it
-- server-side behind the owner session check (the routes are not in the CI-token carve-out).
-- Rows are never physically removed by the app: "Remove" stamps removed_at, and Undo clears it.
-- Additive only: this file creates one table and two indexes and changes nothing that exists.

CREATE TABLE IF NOT EXISTS pds.care_items (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title              TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
    kind               TEXT NOT NULL DEFAULT 'other'
                       CHECK (kind IN ('medical', 'dental', 'vision', 'wellness', 'personal', 'other')),
    due_date           DATE NOT NULL,                 -- calendar day in time_zone
    due_time           TIME,                          -- wall clock in time_zone; NULL = no time (all day)
    time_zone          TEXT NOT NULL DEFAULT 'America/New_York' CHECK (char_length(time_zone) BETWEEN 1 AND 64),
    repeat_months      INTEGER NOT NULL DEFAULT 0 CHECK (repeat_months IN (0, 1, 3, 6, 12, 24)),
    booked             BOOLEAN NOT NULL DEFAULT false, -- Riley confirmed an appointment exists
    notes              TEXT NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
    archived           BOOLEAN NOT NULL DEFAULT false,
    last_completed_on  DATE,                          -- day Riley last marked it complete
    import_key         TEXT UNIQUE CHECK (import_key IS NULL OR char_length(import_key) BETWEEN 1 AND 100),
                                                      -- id the item had in a browser's local planner
                                                      -- (makes the one-time copy idempotent)
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at         TIMESTAMPTZ                    -- soft removal; NULL = live
);

CREATE INDEX IF NOT EXISTS care_items_live_due_idx ON pds.care_items (due_date) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS care_items_updated_idx ON pds.care_items (updated_at DESC);

ALTER TABLE pds.care_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pds.care_items FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON pds.care_items TO service_role;
