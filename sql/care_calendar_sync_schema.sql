-- Google Calendar sync for /health care items (2026-11-13). Additive: two new tables.
--
--   pds.care_calendar_sync    ONE row: which Google calendar Onyx created ("Onyx care"), when
--                             Riley connected, and the result of the last sync (counts and a
--                             short error code; never event text).
--   pds.care_calendar_links   one row per care item that has (or had) an event: the event id
--                             Onyx chose, its generation, a digest of what was last written
--                             (so an unchanged item costs no Google call), and whether the
--                             event is still on the calendar ('present') or was taken off
--                             ('gone'). Rows are kept; the app only ever inserts and updates.
--
-- The refresh token itself is NOT here: it is in pds.ci_tokens (service = 'google_calendar'),
-- the same place as the other integrations' tokens.
--
-- SERVICE ROLE ONLY: RLS on, no policies, nothing granted to anon / authenticated. Read and
-- written only by lib/care-google-server.ts behind the owner-session /api/care/google/* routes.
-- Both tables stay empty until Riley sets the Google credentials and presses Connect.

CREATE TABLE IF NOT EXISTS pds.care_calendar_sync (
    id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    calendar_id       TEXT,                 -- the Google calendar Onyx created; kept across reconnects
    connected_at      TIMESTAMPTZ,          -- NULL = not connected
    last_sync_at      TIMESTAMPTZ,
    last_sync_ok      BOOLEAN,
    last_sync_counts  JSONB,                -- {created, updated, removed, unchanged, failed, foreign}
    last_error        TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 100),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pds.care_calendar_links (
    item_id      UUID PRIMARY KEY REFERENCES pds.care_items (id),
    calendar_id  TEXT NOT NULL,
    event_id     TEXT NOT NULL CHECK (event_id ~ '^[a-v0-9]{5,1024}$'),
    generation   INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    fingerprint  TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('present', 'gone')),
    synced_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pds.care_calendar_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.care_calendar_links ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pds.care_calendar_sync FROM PUBLIC, anon, authenticated;
REVOKE ALL ON pds.care_calendar_links FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON pds.care_calendar_sync TO service_role;
GRANT SELECT, INSERT, UPDATE ON pds.care_calendar_links TO service_role;
