-- ============================================================================
-- Calendar events: one row per event instance (google_calendar_etl.py)
-- ============================================================================
-- Source: iCalendar feeds listed in the GOOGLE_CALENDAR_ICS_SECRET secret (Google
-- Calendar's "secret address in iCal format", one per calendar; any ICS feed
-- works). The ETL runs hourly, expands recurring events to single instances
-- inside ET today -400 d .. +400 d and upserts them here. One way only:
-- calendar -> Onyx. Nothing is ever written back to a calendar.
--
-- Stored per instance: title, start / end, all-day flag, inclusive dates, time
-- zone, location, status, the account + calendar labels from the secret, and
-- whether it belongs to a recurring series.
-- NOT stored: description, attendees, organizer, conference links, the event's
-- UID, the feed URL.
--
-- event_key = first 32 hex of sha256(account, calendar, UID, original slot).
-- The slot is empty for a one-off event (moving it updates the same row) and the
-- instance's original start for a series (a moved instance keeps its row).
--
-- Timed events: start_at / end_at are instants; start_date / end_date are the
-- local dates in `tz` (the event's own zone when the feed gives one, else the
-- calendar's zone). All-day events: start_at / end_at / tz are NULL and
-- start_date .. end_date (INCLUSIVE; the feed's exclusive end minus one day) are
-- plain dates. An all-day event has no instant, so there are no onyx_*_date
-- columns and no behavioral-day rule here: this is not a behavior source.
--
-- status 'cancelled' rows are kept so a previously confirmed instance flips;
-- readers leave them out. An event that vanishes from the feed is removed by the
-- ETL after a fully validated fetch (never after a failed one), which is why the
-- service role may remove rows.
--
-- Access: SERVICE ROLE ONLY. RLS on, no policies, nothing granted to anon or
-- authenticated. The browser never queries this table: the reader is
-- frontend/src/lib/calendar-events-server.ts behind the owner-only middleware
-- (GET /api/calendar/events).
--
-- Safe to re-run (IF NOT EXISTS everywhere). Contains no statement that takes an
-- object away, so the Supabase MCP connector will not refuse it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.calendar_events (
    event_key     TEXT PRIMARY KEY,
    account       TEXT NOT NULL,                    -- label from the secret, not an address
    calendar      TEXT NOT NULL,                    -- label from the secret
    title         TEXT NOT NULL DEFAULT '',
    start_at      TIMESTAMPTZ,                      -- NULL for an all-day event
    end_at        TIMESTAMPTZ,                      -- exclusive; NULL for an all-day event
    all_day       BOOLEAN NOT NULL DEFAULT false,
    start_date    DATE NOT NULL,                    -- local date in tz (timed) or the event's own date (all-day)
    end_date      DATE NOT NULL,                    -- INCLUSIVE last date
    tz            TEXT,                             -- IANA zone; NULL for an all-day event
    location      TEXT,
    status        TEXT NOT NULL DEFAULT 'confirmed',
    recurring     BOOLEAN NOT NULL DEFAULT false,   -- an instance of a recurring series
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),  -- start of the last run whose feed listed it
    synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT calendar_events_status_check CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
    CONSTRAINT calendar_events_dates_check CHECK (end_date >= start_date),
    CONSTRAINT calendar_events_timed_check CHECK (all_day OR start_at IS NOT NULL)
);

-- Range reads by day (month grid, today + tomorrow).
CREATE INDEX IF NOT EXISTS calendar_events_start_date_idx ON pds.calendar_events (start_date);
-- The ETL's "not seen this run" pass, per calendar.
CREATE INDEX IF NOT EXISTS calendar_events_calendar_seen_idx ON pds.calendar_events (account, calendar, last_seen_at);

ALTER TABLE pds.calendar_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pds.calendar_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pds.calendar_events TO service_role;

-- Make PostgREST pick up the new table without waiting for a restart.
NOTIFY pgrst, 'reload schema';
