-- ============================================================================
-- Apple Health from the Onyx iPhone app (2026-11-17, tools/screentime_ios,
-- POST /api/apple-health/import)
-- ============================================================================
-- HealthKit is readable only by code running on the iPhone, and never while the
-- phone is locked, so the app reads it and posts it (a Shortcuts automation
-- "when Onyx is opened" runs the "Sync Apple Health to Onyx" action).
--
-- What is stored (phone-measured data that WHOOP / Garmin / Eight Sleep do not
-- already carry; heart rate, HRV and sleep in Health would only be copies):
--   pds.apple_health_hourly    one row per (device, metric, hour): steps,
--                              walking+running distance, flights climbed, walking
--                              speed, walking steadiness, headphone audio level,
--                              mindful minutes. Cumulative metrics are SUMS for the
--                              hour, the others are AVERAGES (samples = how many).
--   pds.apple_health_workouts  workouts other apps wrote to Health (the terms-clean
--                              way to get Strava / Peloton activities: their
--                              "send to Health" switch). One row per workout uuid.
--   pds.apple_health_mind      State of Mind entries (iOS 18+): valence -1..1,
--                              labels, associations.
--   pds.apple_health_daily     one row per behavioral day (view).
--
-- Not stored: raw samples, source device names of samples, locations, routes.
-- Lab results (Health Records, FHIR) are NOT part of this file: they need the
-- Clinical Health Records entitlement and a connected provider; see the
-- roadmap row.
--
-- SERVICE ROLE ONLY (not even the signed-in owner): health data read through a
-- server route, like pds.phone_usage_*. Safe to re-run; no statement removes
-- objects (the Supabase MCP connector refuses migrations that do).
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.apple_health_hourly (
    device                  TEXT NOT NULL DEFAULT 'iphone',
    metric                  TEXT NOT NULL,           -- steps | distance_m | flights | mindful_seconds | walking_speed_ms | walking_steadiness_pct | headphone_db
    hour_start              TIMESTAMPTZ NOT NULL,
    value                   NUMERIC(14,3) NOT NULL,  -- sum (cumulative metrics) or average (the others)
    unit                    TEXT NOT NULL,
    samples                 INTEGER,                 -- readings behind an average; NULL for sums
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    onyx_et_date            DATE,
    onyx_behavioral_date    DATE,
    onyx_local_date         DATE,
    onyx_tz_source          TEXT,
    PRIMARY KEY (device, metric, hour_start)
);

CREATE INDEX IF NOT EXISTS apple_health_hourly_behavioral_idx
    ON pds.apple_health_hourly (onyx_behavioral_date, metric);

CREATE TABLE IF NOT EXISTS pds.apple_health_workouts (
    workout_uuid            TEXT PRIMARY KEY,        -- HKWorkout uuid
    device                  TEXT NOT NULL DEFAULT 'iphone',
    activity_type           TEXT NOT NULL,           -- workout type name, e.g. running, cycling
    start_time              TIMESTAMPTZ NOT NULL,
    end_time                TIMESTAMPTZ NOT NULL,
    duration_s              NUMERIC(10,1) NOT NULL,
    distance_m              NUMERIC(12,1),
    energy_kcal             NUMERIC(9,1),
    source_name             TEXT,                    -- the app that wrote it (Strava, Peloton, Fitness ...)
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    onyx_et_date            DATE,
    onyx_behavioral_date    DATE,
    onyx_local_date         DATE,
    onyx_tz_source          TEXT,
    CHECK (end_time >= start_time)
);

CREATE INDEX IF NOT EXISTS apple_health_workouts_behavioral_idx
    ON pds.apple_health_workouts (onyx_behavioral_date);

CREATE TABLE IF NOT EXISTS pds.apple_health_mind (
    sample_uuid             TEXT PRIMARY KEY,        -- state of mind sample uuid
    device                  TEXT NOT NULL DEFAULT 'iphone',
    logged_at               TIMESTAMPTZ NOT NULL,
    kind                    TEXT NOT NULL,           -- momentary_emotion | daily_mood
    valence                 NUMERIC(5,4) NOT NULL CHECK (valence BETWEEN -1 AND 1),
    labels                  TEXT[] NOT NULL DEFAULT '{}',
    associations            TEXT[] NOT NULL DEFAULT '{}',
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    onyx_et_date            DATE,
    onyx_behavioral_date    DATE,
    onyx_local_date         DATE,
    onyx_tz_source          TEXT
);

CREATE INDEX IF NOT EXISTS apple_health_mind_behavioral_idx
    ON pds.apple_health_mind (onyx_behavioral_date);

-- ADR-0001 quad, derived from each row's own instant.
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_apple_health_hourly()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(NEW.hour_start, NULL, NULL);
    NEW.onyx_et_date := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date := d.onyx_local_date;
    NEW.onyx_tz_source := d.onyx_tz_source;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_apple_health_workouts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(NEW.start_time, NULL, NULL);
    NEW.onyx_et_date := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date := d.onyx_local_date;
    NEW.onyx_tz_source := d.onyx_tz_source;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_apple_health_mind()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(NEW.logged_at, NULL, NULL);
    NEW.onyx_et_date := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date := d.onyx_local_date;
    NEW.onyx_tz_source := d.onyx_tz_source;
    RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER apple_health_hourly_set_onyx_dates
    BEFORE INSERT OR UPDATE OF hour_start ON pds.apple_health_hourly
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_apple_health_hourly();

CREATE OR REPLACE TRIGGER apple_health_workouts_set_onyx_dates
    BEFORE INSERT OR UPDATE OF start_time ON pds.apple_health_workouts
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_apple_health_workouts();

CREATE OR REPLACE TRIGGER apple_health_mind_set_onyx_dates
    BEFORE INSERT OR UPDATE OF logged_at ON pds.apple_health_mind
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_apple_health_mind();

-- Service role only: RLS on, no policy for anyone else, no grants.
ALTER TABLE pds.apple_health_hourly   ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.apple_health_workouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.apple_health_mind     ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['apple_health_hourly', 'apple_health_workouts', 'apple_health_mind'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'pds' AND tablename = t AND policyname = 'service_full_access') THEN
            EXECUTE format('CREATE POLICY service_full_access ON pds.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
        END IF;
    END LOOP;
END $$;
REVOKE ALL ON pds.apple_health_hourly, pds.apple_health_workouts, pds.apple_health_mind FROM anon, authenticated;
GRANT ALL  ON pds.apple_health_hourly, pds.apple_health_workouts, pds.apple_health_mind TO service_role;

-- ----------------------------------------------------------------------------
-- One row per behavioral day (the -6 h rule is already in onyx_behavioral_date
-- of each hour). Cumulative metrics sum; the others are sample-weighted means.
-- A day with no row for a metric has NULL there (never 0): Health holds nothing
-- for a phone that was not carried. security_invoker so the table's RLS applies.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW pds.apple_health_daily WITH (security_invoker = true) AS
WITH hourly AS (
    SELECT onyx_behavioral_date AS behavioral_date,
           SUM(value) FILTER (WHERE metric = 'steps')            AS steps,
           SUM(value) FILTER (WHERE metric = 'distance_m')       AS distance_m,
           SUM(value) FILTER (WHERE metric = 'flights')          AS flights_climbed,
           SUM(value) FILTER (WHERE metric = 'mindful_seconds') / 60.0 AS mindful_minutes,
           SUM(value * COALESCE(samples, 1)) FILTER (WHERE metric = 'walking_speed_ms')
               / NULLIF(SUM(COALESCE(samples, 1)) FILTER (WHERE metric = 'walking_speed_ms'), 0)
                                                                 AS walking_speed_ms,
           SUM(value * COALESCE(samples, 1)) FILTER (WHERE metric = 'walking_steadiness_pct')
               / NULLIF(SUM(COALESCE(samples, 1)) FILTER (WHERE metric = 'walking_steadiness_pct'), 0)
                                                                 AS walking_steadiness_pct,
           SUM(value * COALESCE(samples, 1)) FILTER (WHERE metric = 'headphone_db')
               / NULLIF(SUM(COALESCE(samples, 1)) FILTER (WHERE metric = 'headphone_db'), 0)
                                                                 AS headphone_db_avg,
           MAX(value) FILTER (WHERE metric = 'headphone_db')     AS headphone_db_hour_max,
           COUNT(DISTINCT hour_start)                            AS hours_reported,
           MAX(synced_at)                                        AS synced_at
    FROM pds.apple_health_hourly
    GROUP BY onyx_behavioral_date
),
wk AS (
    SELECT onyx_behavioral_date AS behavioral_date,
           COUNT(*)                         AS workouts,
           SUM(duration_s) / 60.0           AS workout_minutes,
           SUM(energy_kcal)                 AS workout_kcal
    FROM pds.apple_health_workouts
    GROUP BY onyx_behavioral_date
),
mind AS (
    SELECT onyx_behavioral_date AS behavioral_date,
           COUNT(*)           AS mind_entries,
           AVG(valence)       AS mind_valence_avg,
           MIN(valence)       AS mind_valence_min
    FROM pds.apple_health_mind
    GROUP BY onyx_behavioral_date
),
days AS (
    SELECT behavioral_date FROM hourly
    UNION SELECT behavioral_date FROM wk
    UNION SELECT behavioral_date FROM mind
)
SELECT d.behavioral_date,
       h.steps, h.distance_m, h.flights_climbed, h.mindful_minutes,
       h.walking_speed_ms, h.walking_steadiness_pct, h.headphone_db_avg, h.headphone_db_hour_max,
       h.hours_reported, h.synced_at,
       wk.workouts, wk.workout_minutes, wk.workout_kcal,
       mind.mind_entries, mind.mind_valence_avg, mind.mind_valence_min
FROM days d
LEFT JOIN hourly h ON h.behavioral_date = d.behavioral_date
LEFT JOIN wk       ON wk.behavioral_date = d.behavioral_date
LEFT JOIN mind     ON mind.behavioral_date = d.behavioral_date;

REVOKE ALL ON pds.apple_health_daily FROM anon, authenticated;
GRANT SELECT ON pds.apple_health_daily TO service_role;
