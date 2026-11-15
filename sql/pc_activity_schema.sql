-- ============================================================================
-- PC activity (2026-11-14): coarse active / idle time per hour and minutes per
-- program from Riley's Windows PC (tools/pc_activity_logger)
-- ============================================================================
-- Source: a small local logger samples every 30 s: seconds since the last
-- keyboard / mouse input (GetLastInputInfo: a timestamp only, never what was
-- typed) and the executable name of the foreground program (e.g. "excel",
-- "code"). It never reads window titles, URLs, documents, keystrokes or the
-- screen. Samples stay on the PC (%LOCALAPPDATA%\Onyx\pc-activity) and each
-- day's hourly totals are upserted here with the service-role key.
--
-- Objects:
--   pds.pc_activity_hours   one row per (device, UTC hour): active + idle seconds
--   pds.pc_activity_apps    one row per (device, UTC hour, program): active seconds
--   pds.pc_activity_daily   one row per behavioral day (view)
--
-- Idempotent: safe to re-run. Contains no statement that removes objects (the
-- Supabase MCP connector refuses migrations that do).
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.pc_activity_hours (
    device                  TEXT NOT NULL,
    hour_start              TIMESTAMPTZ NOT NULL,      -- start of the UTC hour
    active_seconds          INTEGER NOT NULL CHECK (active_seconds BETWEEN 0 AND 3600),
    idle_seconds            INTEGER NOT NULL CHECK (idle_seconds BETWEEN 0 AND 3600),
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- ADR-0001 quad (trigger-populated from hour_start)
    onyx_et_date            DATE,
    onyx_behavioral_date    DATE,
    onyx_local_date         DATE,
    onyx_tz_source          TEXT,
    PRIMARY KEY (device, hour_start),
    CHECK (EXTRACT(EPOCH FROM hour_start) % 3600 = 0),
    CHECK (active_seconds + idle_seconds <= 3600)
);

CREATE INDEX IF NOT EXISTS pc_activity_hours_behavioral_idx
    ON pds.pc_activity_hours (onyx_behavioral_date);

CREATE TABLE IF NOT EXISTS pds.pc_activity_apps (
    device          TEXT NOT NULL,
    hour_start      TIMESTAMPTZ NOT NULL,
    app             TEXT NOT NULL CHECK (app ~ '^[a-z0-9._+-]{1,64}$'),  -- executable name, lower case, no ".exe"
    active_seconds  INTEGER NOT NULL CHECK (active_seconds BETWEEN 1 AND 3600),
    PRIMARY KEY (device, hour_start, app),
    FOREIGN KEY (device, hour_start)
        REFERENCES pds.pc_activity_hours (device, hour_start) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_pc_activity_hours()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(NEW.hour_start, NULL, NULL);
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER pc_activity_hours_set_onyx_dates
    BEFORE INSERT OR UPDATE OF hour_start ON pds.pc_activity_hours
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_pc_activity_hours();

-- SERVICE ROLE ONLY, like the iPhone Screen Time tables: RLS on with no
-- policies, nothing granted to anon or the signed-in owner (the REVOKE undoes
-- the grants pds default privileges add to every new relation). Read it
-- through a server route.
ALTER TABLE pds.pc_activity_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.pc_activity_apps  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.pc_activity_hours, pds.pc_activity_apps FROM anon, authenticated;
GRANT ALL  ON pds.pc_activity_hours, pds.pc_activity_apps TO service_role;

-- ----------------------------------------------------------------------------
-- Daily rollup on the behavioral day of each hour's START (00:00-05:59 local
-- belongs to the day before, ADR-0001).
--   late_active_minutes             active in hours starting 21:00-05:59 local
--   after_midnight_active_minutes   active in hours starting 00:00-05:59 local
--   minutes_by_app / late_minutes_by_app   active minutes per program
-- A day the logger never ran has no row (a gap, never zero).
-- security_invoker: a plain view runs as its owner and would bypass the
-- service-role-only RLS above.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW pds.pc_activity_daily WITH (security_invoker = true) AS
WITH hrs AS (
    SELECT h.*,
           EXTRACT(HOUR FROM (h.hour_start AT TIME ZONE pds.tz_for_instant(h.hour_start)))::int AS local_hour
    FROM pds.pc_activity_hours h
),
app_day AS (
    SELECT hrs.onyx_behavioral_date AS behavioral_date,
           a.app,
           SUM(a.active_seconds) AS seconds,
           SUM(a.active_seconds) FILTER (WHERE hrs.local_hour >= 21 OR hrs.local_hour < 6) AS late_seconds
    FROM pds.pc_activity_apps a
    JOIN hrs USING (device, hour_start)
    GROUP BY 1, 2
),
apps AS (
    SELECT behavioral_date,
           jsonb_object_agg(app, ROUND((seconds / 60.0)::numeric, 1) ORDER BY seconds DESC) AS minutes_by_app,
           jsonb_object_agg(app, ROUND((late_seconds / 60.0)::numeric, 1) ORDER BY late_seconds DESC)
               FILTER (WHERE late_seconds > 0)                                              AS late_minutes_by_app,
           COUNT(*)                                                                         AS apps_used
    FROM app_day
    GROUP BY behavioral_date
),
agg AS (
    SELECT
        onyx_behavioral_date                                               AS behavioral_date,
        COUNT(*)                                                           AS hours_reported,
        SUM(active_seconds) / 60.0                                         AS active_minutes,
        SUM(idle_seconds) / 60.0                                           AS idle_minutes,
        SUM(active_seconds) FILTER (WHERE local_hour >= 21 OR local_hour < 6) / 60.0
                                                                           AS late_active_minutes,
        SUM(active_seconds) FILTER (WHERE local_hour < 6) / 60.0           AS after_midnight_active_minutes,
        MIN(hour_start) FILTER (WHERE active_seconds > 0)                  AS first_active_hour_start,
        MAX(hour_start + INTERVAL '1 hour') FILTER (WHERE active_seconds > 0)
                                                                           AS last_active_hour_end,
        MAX(synced_at)                                                     AS synced_at
    FROM hrs
    GROUP BY onyx_behavioral_date
)
SELECT
    a.behavioral_date,
    a.hours_reported,
    ROUND(a.active_minutes::numeric, 1)                                 AS active_minutes,
    ROUND(a.idle_minutes::numeric, 1)                                   AS idle_minutes,
    ROUND(COALESCE(a.late_active_minutes, 0)::numeric, 1)               AS late_active_minutes,
    ROUND(COALESCE(a.after_midnight_active_minutes, 0)::numeric, 1)     AS after_midnight_active_minutes,
    a.first_active_hour_start,
    a.last_active_hour_end,
    COALESCE(ap.apps_used, 0)                                           AS apps_used,
    ap.minutes_by_app,
    ap.late_minutes_by_app,
    a.synced_at
FROM agg a
LEFT JOIN apps ap ON ap.behavioral_date = a.behavioral_date;

REVOKE ALL   ON pds.pc_activity_daily FROM anon, authenticated;
GRANT SELECT ON pds.pc_activity_daily TO service_role;
