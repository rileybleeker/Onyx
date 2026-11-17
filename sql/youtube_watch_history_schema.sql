-- ============================================================================
-- YouTube watch history (2026-11-17): what was watched, from Google Takeout
-- ============================================================================
-- Source: a scheduled Google Takeout export (history only, JSON) delivered to
-- OneDrive; tools/youtube_history on the PC parses watch-history.json and
-- upserts it here with the service-role key in ~/.onyx_supabase_secret.
-- No Google credential is held by Onyx. One row per watch event: Takeout has
-- a timestamp, title, video id and channel, NO watch duration. Ads and
-- YouTube Music plays are mixed into the history; they are flagged
-- (is_ad / is_music), not dropped, so a reader can leave them out.
--
-- Natural key (watched_at, video_id): re-importing the same or a later,
-- overlapping export is idempotent. Removed videos have no id; the harvester
-- stores them under video_id 'removed' (title kept as Takeout gives it).
-- ADR-0001 quad derived from the instant by trigger (pure-instant variant,
-- same as pds.tanita_measurements).
--
-- Access: RLS on; owner may read in the browser (owner_read), service role
-- writes. anon gets nothing. Safe to re-run; no destructive statement.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.youtube_watch_events (
    watched_at           TIMESTAMPTZ NOT NULL,
    video_id             TEXT        NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{1,64}$'),
    title                TEXT,
    channel_name         TEXT,
    channel_id           TEXT,
    is_music             BOOLEAN     NOT NULL DEFAULT FALSE,
    is_ad                BOOLEAN     NOT NULL DEFAULT FALSE,
    export_label         TEXT,        -- the export's folder / zip name (no path), for audit
    onyx_et_date         DATE,
    onyx_behavioral_date DATE,
    onyx_local_date      DATE,
    onyx_tz_source       TEXT,
    synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (watched_at, video_id)
);

CREATE INDEX IF NOT EXISTS youtube_watch_events_behavioral_idx
    ON pds.youtube_watch_events (onyx_behavioral_date);
CREATE INDEX IF NOT EXISTS youtube_watch_events_channel_idx
    ON pds.youtube_watch_events (channel_name);

COMMENT ON TABLE pds.youtube_watch_events IS
    'YouTube watch events from the scheduled Google Takeout export (tools/youtube_history). Timestamp, title, video id, channel; no watch duration. Heartbeat youtube|history.';

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_youtube_watch_events()
RETURNS TRIGGER AS $$
DECLARE
    d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(NEW.watched_at, NULL, NULL);
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER youtube_watch_events_set_onyx_dates
    BEFORE INSERT OR UPDATE OF watched_at ON pds.youtube_watch_events
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_youtube_watch_events();

ALTER TABLE pds.youtube_watch_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'youtube_watch_events' AND policyname = 'owner_read'
    ) THEN
        CREATE POLICY owner_read ON pds.youtube_watch_events FOR SELECT TO authenticated
            USING ((SELECT auth.uid()) = 'dc041abc-115a-4252-8536-803f2ac75557'::uuid);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'youtube_watch_events' AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.youtube_watch_events
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

REVOKE ALL ON pds.youtube_watch_events FROM anon, authenticated;
GRANT SELECT ON pds.youtube_watch_events TO authenticated;
GRANT ALL    ON pds.youtube_watch_events TO service_role;
