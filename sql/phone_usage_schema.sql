-- ============================================================================
-- Phone screen time v2 (2026-11-09) — hourly usage from the Onyx Screen Time
-- iPhone app (tools/screentime_ios)
-- ============================================================================
-- Source: iOS 26.4 DeviceActivityData.activityData(filteredBy:using:) — Apple's
-- official Screen Time export API. It needs the "Family Controls App And
-- Website Usage" entitlement and the approvedWithDataAccess authorization;
-- outside the EU it only works in a development-signed build, which is what a
-- personal app is. The app reads hourly segments (every app, real bundle ids,
-- pickups, notifications) and POSTs them to /api/screen-time/usage.
--
-- This replaces the Shortcuts open/close event path (pds.phone_app_events) as
-- the intended primary source: nothing to tick per app, future installs are
-- covered automatically. Resolution is one hour (the API's finest segment), so
-- the bedtime features below are overlap-weighted ESTIMATES, not exact.
--
-- Objects:
--   pds.phone_usage_segments  one row per (device, hour)
--   pds.phone_usage_items     one row per (device, hour, app | web domain)
--   pds.phone_usage_daily     one row per behavioral day (view)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.phone_usage_segments (
    device                  TEXT NOT NULL DEFAULT 'iphone',
    segment_start           TIMESTAMPTZ NOT NULL,
    segment_end             TIMESTAMPTZ NOT NULL,
    total_seconds           NUMERIC(9,1) NOT NULL,
    first_pickup            TIMESTAMPTZ,
    pickups_without_app     INTEGER,                 -- pickups that opened no app
    longest_activity_start  TIMESTAMPTZ,
    longest_activity_end    TIMESTAMPTZ,
    device_name             TEXT,
    device_model            TEXT,
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- ADR-0001 quad (trigger-populated from segment_start)
    onyx_et_date            DATE,
    onyx_behavioral_date    DATE,
    onyx_local_date         DATE,
    onyx_tz_source          TEXT,
    PRIMARY KEY (device, segment_start),
    CHECK (segment_end > segment_start)
);

CREATE INDEX IF NOT EXISTS phone_usage_segments_behavioral_idx
    ON pds.phone_usage_segments (onyx_behavioral_date);

CREATE TABLE IF NOT EXISTS pds.phone_usage_items (
    device          TEXT NOT NULL DEFAULT 'iphone',
    segment_start   TIMESTAMPTZ NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('app', 'web')),
    identifier      TEXT NOT NULL,                   -- bundle id | web domain
    name            TEXT,                            -- display name (apps)
    category        TEXT,                            -- Screen Time category
    seconds         NUMERIC(9,1) NOT NULL,
    pickups         INTEGER,
    notifications   INTEGER,
    PRIMARY KEY (device, segment_start, kind, identifier),
    FOREIGN KEY (device, segment_start)
        REFERENCES pds.phone_usage_segments (device, segment_start) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_phone_usage_segments()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(NEW.segment_start, NULL, NULL);
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS phone_usage_segments_set_onyx_dates ON pds.phone_usage_segments;
CREATE TRIGGER phone_usage_segments_set_onyx_dates
    BEFORE INSERT OR UPDATE OF segment_start ON pds.phone_usage_segments
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_phone_usage_segments();

-- SERVICE ROLE ONLY. Unlike most pds tables these are NOT anon-readable: they
-- hold every app and web domain used, hour by hour, and the anon key ships in
-- the site's public JavaScript. Read them through a server route.
-- (The DROPs + REVOKE also undo the anon grants of the first version of this
-- file, and pds default privileges re-grant SELECT on every new relation.)
ALTER TABLE pds.phone_usage_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.phone_usage_items    ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_read"           ON pds.phone_usage_segments;
DROP POLICY IF EXISTS "service_full_access" ON pds.phone_usage_segments;
DROP POLICY IF EXISTS "anon_read"           ON pds.phone_usage_items;
DROP POLICY IF EXISTS "service_full_access" ON pds.phone_usage_items;
CREATE POLICY "service_full_access" ON pds.phone_usage_segments FOR ALL    TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.phone_usage_items    FOR ALL    TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON pds.phone_usage_segments, pds.phone_usage_items FROM anon, authenticated;
GRANT ALL  ON pds.phone_usage_segments, pds.phone_usage_items TO service_role;

-- ----------------------------------------------------------------------------
-- Daily rollup on the behavioral day of each hour's START (the −6h rule lands
-- on an hour boundary, so 00:00–05:59 local belongs to the day before).
--   late_night_minutes       hours starting 22:00–05:59 local
--   after_midnight_minutes   hours starting 00:00–05:59 local
-- Sleep-anchored columns use the WHOOP main sleep closing the day (same join
-- as pds.phone_screen_daily / caffeine). An hour that straddles sleep onset
-- contributes in proportion to its overlap — an estimate, hence the _est
-- suffix. NULL until that sleep is scored. They are matched to the sleep BY
-- TIME (sleep_use), not by behavioral day: hours from 06:00 on belong to the
-- next behavioral day, and about half of a typical night's sleep falls there.
-- security_invoker: a plain view runs as its owner and would bypass the
-- service-role-only RLS above.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW pds.phone_usage_daily WITH (security_invoker = true) AS
WITH seg AS (
    SELECT s.*,
           EXTRACT(HOUR FROM (s.segment_start AT TIME ZONE pds.tz_for_instant(s.segment_start)))::int AS local_hour
    FROM pds.phone_usage_segments s
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
item_day AS (
    SELECT s.onyx_behavioral_date AS behavioral_date, i.kind,
           COALESCE(i.name, i.identifier) AS label,
           COALESCE(i.category, '(none)') AS category,
           SUM(i.seconds)                 AS seconds,
           SUM(COALESCE(i.pickups, 0))        AS pickups,
           SUM(COALESCE(i.notifications, 0))  AS notifications
    FROM pds.phone_usage_items i
    JOIN pds.phone_usage_segments s USING (device, segment_start)
    GROUP BY 1, 2, 3, 4
),
apps AS (
    SELECT behavioral_date,
           jsonb_object_agg(label, ROUND((seconds / 60.0)::numeric, 1) ORDER BY seconds DESC)
               FILTER (WHERE kind = 'app')        AS minutes_by_app,
           SUM(pickups)                           AS app_pickups,
           SUM(notifications)                     AS notifications,
           COUNT(*) FILTER (WHERE kind = 'app')   AS apps_used
    FROM (
        SELECT behavioral_date, kind, label, SUM(seconds) AS seconds,
               SUM(pickups) AS pickups, SUM(notifications) AS notifications
        FROM item_day GROUP BY 1, 2, 3
    ) x
    GROUP BY behavioral_date
),
cats AS (
    SELECT behavioral_date,
           jsonb_object_agg(category, ROUND((seconds / 60.0)::numeric, 1) ORDER BY seconds DESC) AS minutes_by_category
    FROM (
        SELECT behavioral_date, category, SUM(seconds) AS seconds
        FROM item_day WHERE kind = 'app' GROUP BY 1, 2
    ) y
    GROUP BY behavioral_date
),
sleep_use AS (
    SELECT sl.behavioral_date,
           SUM(s.total_seconds
               * GREATEST(0, EXTRACT(EPOCH FROM (
                     LEAST(s.segment_end, sl.sleep_start)
                   - GREATEST(s.segment_start, sl.sleep_start - INTERVAL '60 minutes'))))
               / EXTRACT(EPOCH FROM (s.segment_end - s.segment_start))) / 60.0
                                                                        AS minutes_last_hour_before_sleep_est,
           SUM(s.total_seconds
               * GREATEST(0, EXTRACT(EPOCH FROM (
                     LEAST(s.segment_end, sl.sleep_end)
                   - GREATEST(s.segment_start, sl.sleep_start))))
               / EXTRACT(EPOCH FROM (s.segment_end - s.segment_start))) / 60.0
                                                                        AS minutes_during_sleep_est
    FROM sleep sl
    JOIN pds.phone_usage_segments s
      -- prune by day so the behavioral-date index is used; the two time tests below decide
      ON s.onyx_behavioral_date BETWEEN sl.behavioral_date - 2 AND sl.behavioral_date + 2
     AND s.segment_end   > sl.sleep_start - INTERVAL '60 minutes'
     AND s.segment_start < sl.sleep_end
    GROUP BY sl.behavioral_date
),
agg AS (
    SELECT
        seg.onyx_behavioral_date                                        AS behavioral_date,
        COUNT(*)                                                        AS hours_reported,
        SUM(seg.total_seconds) / 60.0                                   AS total_minutes,
        SUM(seg.total_seconds) FILTER (WHERE seg.local_hour >= 22 OR seg.local_hour < 6) / 60.0
                                                                        AS late_night_minutes,
        SUM(seg.total_seconds) FILTER (WHERE seg.local_hour < 6) / 60.0 AS after_midnight_minutes,
        SUM(COALESCE(seg.pickups_without_app, 0))                       AS pickups_without_app,
        MIN(seg.first_pickup)                                           AS first_pickup,
        MAX(seg.segment_end) FILTER (WHERE seg.total_seconds > 0)       AS last_active_hour_end,
        MIN(sl.sleep_start)                                             AS sleep_start,
        MAX(seg.synced_at)                                              AS synced_at
    FROM seg
    LEFT JOIN sleep sl ON sl.behavioral_date = seg.onyx_behavioral_date
    GROUP BY seg.onyx_behavioral_date
)
SELECT
    a.behavioral_date,
    a.hours_reported,
    ROUND(a.total_minutes::numeric, 1)                         AS total_minutes,
    ROUND(COALESCE(a.late_night_minutes, 0)::numeric, 1)       AS late_night_minutes,
    ROUND(COALESCE(a.after_midnight_minutes, 0)::numeric, 1)   AS after_midnight_minutes,
    a.pickups_without_app + COALESCE(ap.app_pickups, 0)        AS pickups,
    COALESCE(ap.notifications, 0)                              AS notifications,
    COALESCE(ap.apps_used, 0)                                  AS apps_used,
    a.first_pickup,
    a.last_active_hour_end,
    a.sleep_start,
    -- GREATEST(0, NULL) = 0 in Postgres, so gate on the sleep anchor explicitly.
    CASE WHEN a.sleep_start IS NOT NULL
         THEN ROUND(COALESCE(su.minutes_last_hour_before_sleep_est, 0)::numeric, 1) END AS minutes_last_hour_before_sleep_est,
    CASE WHEN a.sleep_start IS NOT NULL
         THEN ROUND(COALESCE(su.minutes_during_sleep_est, 0)::numeric, 1) END           AS minutes_during_sleep_est,
    ap.minutes_by_app,
    c.minutes_by_category,
    a.synced_at
FROM agg a
LEFT JOIN apps ap      ON ap.behavioral_date = a.behavioral_date
LEFT JOIN cats c       ON c.behavioral_date  = a.behavioral_date
LEFT JOIN sleep_use su ON su.behavioral_date = a.behavioral_date;

REVOKE ALL   ON pds.phone_usage_daily FROM anon, authenticated;
GRANT SELECT ON pds.phone_usage_daily TO service_role;
