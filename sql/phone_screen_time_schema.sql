-- ============================================================================
-- Phone screen time (2026-11-08) — iOS Shortcuts app open/close events
-- ============================================================================
-- Why this shape: Apple exposes NO Screen Time data off-device (the
-- DeviceActivityReport extension is sandboxed; Opal, which reads it, keeps it
-- on the phone and has no API/export). The only automatable signal is the
-- Shortcuts personal-automation trigger "App → Is Opened / Is Closed": one
-- automation with every app ticked posts each event to
-- POST /api/screen-time/event (x-onyx-ci-token). Totals work even when iOS
-- does not pass the triggering app's name (app = NULL); per-app minutes light
-- up automatically when it does.
--
-- Objects:
--   pds.phone_app_events  — raw event log (one row per open/close)
--   pds.phone_app_sessions — open → next-event pairing (view)
--   pds.phone_screen_daily — one row per behavioral day (view), incl.
--                            bedtime-anchored features vs the WHOOP main sleep
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.phone_app_events (
    event_id              BIGSERIAL PRIMARY KEY,
    event_time            TIMESTAMPTZ NOT NULL,       -- phone clock (Shortcuts "Current Date"), else server receive time
    event                 TEXT NOT NULL CHECK (event IN ('opened', 'closed')),
    app                   TEXT,                       -- NULL = iOS did not say which app
    device                TEXT NOT NULL DEFAULT 'iphone',
    time_source           TEXT NOT NULL DEFAULT 'client' CHECK (time_source IN ('client', 'server')),
    received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw_json              JSONB,
    -- ADR-0001 quad (trigger-populated)
    onyx_et_date          DATE,
    onyx_behavioral_date  DATE,
    onyx_local_date       DATE,
    onyx_tz_source        TEXT,
    -- Idempotent on re-sends (Shortcuts has no retry, but a duplicated
    -- automation or a manual replay must not double-count).
    CONSTRAINT phone_app_events_natural_key UNIQUE NULLS NOT DISTINCT (device, event_time, event, app)
);

CREATE INDEX IF NOT EXISTS phone_app_events_time_idx ON pds.phone_app_events (event_time);
CREATE INDEX IF NOT EXISTS phone_app_events_behavioral_idx ON pds.phone_app_events (onyx_behavioral_date);

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_phone_app_events()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(NEW.event_time, NULL, NULL);
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS phone_app_events_set_onyx_dates ON pds.phone_app_events;
CREATE TRIGGER phone_app_events_set_onyx_dates
    BEFORE INSERT OR UPDATE OF event_time ON pds.phone_app_events
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_phone_app_events();

ALTER TABLE pds.phone_app_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read"           ON pds.phone_app_events;
DROP POLICY IF EXISTS "service_full_access" ON pds.phone_app_events;
CREATE POLICY "anon_read"           ON pds.phone_app_events FOR SELECT TO anon         USING (true);
CREATE POLICY "service_full_access" ON pds.phone_app_events FOR ALL    TO service_role USING (true) WITH CHECK (true);
GRANT SELECT ON pds.phone_app_events TO anon, authenticated;
GRANT ALL    ON pds.phone_app_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE pds.phone_app_events_event_id_seq TO service_role;

-- ----------------------------------------------------------------------------
-- Sessions: every 'opened' event starts a session that ends at the NEXT event
-- of any kind on the same device.
--   * next = 'closed' of the same app (or both app NULL) → exact end
--     (sanity cap 4h for a phone left unlocked on a video).
--   * anything else (another 'opened', a mismatched close) → the close was
--     missed (e.g. locking the phone mid-scroll may not fire "Is Closed");
--     end = next event, capped at 30 min, flagged end_inferred.
--   * no next event yet → still open; counted up to now(), capped at 30 min.
-- Stray 'closed' events with no preceding open are ignored.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW pds.phone_app_sessions AS
WITH ordered AS (
    SELECT e.*,
           LEAD(event)      OVER w AS next_event,
           LEAD(app)        OVER w AS next_app,
           LEAD(event_time) OVER w AS next_time
    FROM pds.phone_app_events e
    WINDOW w AS (PARTITION BY device ORDER BY event_time, event_id)
)
SELECT
    event_id                             AS session_id,
    device,
    app,
    event_time                           AS start_time,
    CASE
        WHEN next_event = 'closed' AND app IS NOT DISTINCT FROM next_app
            THEN LEAST(next_time, event_time + INTERVAL '4 hours')
        WHEN next_time IS NOT NULL
            THEN LEAST(next_time, event_time + INTERVAL '30 minutes')
        ELSE LEAST(now(), event_time + INTERVAL '30 minutes')
    END                                  AS end_time,
    NOT (next_event = 'closed' AND app IS NOT DISTINCT FROM next_app) AS end_inferred,
    onyx_behavioral_date,
    onyx_et_date,
    onyx_local_date
FROM ordered
WHERE event = 'opened';

-- ----------------------------------------------------------------------------
-- Daily rollup on the behavioral day of each session's START.
-- Sleep anchor = the WHOOP main sleep closing behavioral day N (same join as
-- pds.caffeine_timing_daily). Bedtime features are NULL until that sleep is
-- scored (i.e. today's row fills in after waking).
--   last_use_to_sleep_minutes   sleep start − end of the last session that
--                               began before sleep (NEGATIVE = still on the
--                               phone after WHOOP-detected sleep onset)
--   minutes_last_hour_before_sleep  overlap with [sleep−60m, sleep)
--   minutes_during_sleep        overlap with [sleep start, sleep end)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW pds.phone_screen_daily AS
WITH s AS (
    SELECT *, EXTRACT(EPOCH FROM (end_time - start_time)) / 60.0 AS minutes
    FROM pds.phone_app_sessions
),
per_app AS (
    SELECT onyx_behavioral_date, COALESCE(app, '(unknown)') AS app, SUM(minutes) AS minutes
    FROM s
    GROUP BY 1, 2
),
apps AS (
    SELECT onyx_behavioral_date,
           jsonb_object_agg(app, ROUND(minutes::numeric, 1) ORDER BY minutes DESC) AS minutes_by_app
    FROM per_app
    GROUP BY 1
),
sleep AS (
    SELECT wcm.onyx_behavioral_date AS behavioral_date,
           MIN(ws.start_time)       AS sleep_start,
           MAX(ws.end_time)         AS sleep_end
    FROM pds.whoop_main_cycle_per_behavioral_date wcm
    JOIN pds.whoop_sleep ws
      ON ws.cycle_id = wcm.cycle_id
     AND ws.is_nap = false
     AND ws.score_state = 'SCORED'
    GROUP BY wcm.onyx_behavioral_date
),
agg AS (
    SELECT
        s.onyx_behavioral_date                       AS behavioral_date,
        ROUND(SUM(s.minutes)::numeric, 1)            AS total_minutes,
        COUNT(*)                                     AS session_count,
        COUNT(DISTINCT s.app)                        AS apps_used,
        COUNT(*) FILTER (WHERE s.end_inferred)       AS inferred_end_sessions,
        MIN(s.start_time)                            AS first_use_time,
        MAX(s.end_time)                              AS last_use_time,
        MAX(s.end_time) FILTER (WHERE s.start_time < sl.sleep_start) AS last_use_before_sleep,
        SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                LEAST(s.end_time, sl.sleep_start)
              - GREATEST(s.start_time, sl.sleep_start - INTERVAL '60 minutes'))) / 60.0))
                                                     AS minutes_last_hour_before_sleep,
        SUM(GREATEST(0, EXTRACT(EPOCH FROM (
                LEAST(s.end_time, sl.sleep_end)
              - GREATEST(s.start_time, sl.sleep_start))) / 60.0))
                                                     AS minutes_during_sleep,
        MIN(sl.sleep_start)                          AS sleep_start
    FROM s
    LEFT JOIN sleep sl ON sl.behavioral_date = s.onyx_behavioral_date
    GROUP BY s.onyx_behavioral_date
)
SELECT
    a.behavioral_date,
    a.total_minutes,
    a.session_count,
    a.apps_used,
    a.inferred_end_sessions,
    a.first_use_time,
    a.last_use_time,
    a.sleep_start,
    ROUND((EXTRACT(EPOCH FROM (a.sleep_start - a.last_use_before_sleep)) / 60.0)::numeric, 1)
                                                     AS last_use_to_sleep_minutes,
    -- GREATEST(0, NULL) = 0 in Postgres, so gate on the sleep anchor explicitly.
    CASE WHEN a.sleep_start IS NOT NULL
         THEN ROUND(a.minutes_last_hour_before_sleep::numeric, 1) END AS minutes_last_hour_before_sleep,
    CASE WHEN a.sleep_start IS NOT NULL
         THEN ROUND(a.minutes_during_sleep::numeric, 1) END        AS minutes_during_sleep,
    ap.minutes_by_app
FROM agg a
LEFT JOIN apps ap ON ap.onyx_behavioral_date = a.behavioral_date;

GRANT SELECT ON pds.phone_app_sessions, pds.phone_screen_daily TO anon, authenticated, service_role;
