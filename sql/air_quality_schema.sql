-- ============================================================================
-- Air quality (PM2.5): one row per ET clock day (air_quality_etl.py)
-- ============================================================================
-- Source: the keyless Open-Meteo Air Quality API (CAMS model analysis, ~0.4 degree
-- grid outside Europe), hourly pm2_5 (ug/m3) and us_aqi. The ETL averages the hourly
-- values of each ET clock day and upserts one row per day for the home location
-- (Atlanta by default, overridable with AIR_QUALITY_LAT / AIR_QUALITY_LON).
--
-- calendar_date is the ET CLOCK date of the hourly values, not a behavioral day.
-- The HRV pipeline places day D's row on matrix row D (the sleep that closes
-- behavioral day D): every hour of clock day D except the last one before midnight
-- is before that sleep starts. See hrv_analysis.merge_air_quality_features.
--
-- This is a model analysis of the regional air, not a reading from a sensor at the
-- apartment, and it follows the fixed home location, not where Riley is on a trip.
-- latitude / longitude are stored on every row so a move (NYC) or a changed
-- location stays auditable.
--
-- n_hours counts the hours with a PM2.5 value. Hours after "now" are never stored,
-- so today's row is partial until the day ends; the pipeline ignores days with
-- fewer than 20 hours. Only the date is stored (no timestamptz instant), so there
-- are no onyx_*_date columns.
--
-- Access: service role only, like the other newer pds tables. The ETL writes with
-- the service-role key and /api/status reads with it; the browser never touches
-- the table, and anon / authenticated get nothing.
--
-- Safe to re-run (IF NOT EXISTS everywhere). Contains no statement that removes an
-- object, so the Supabase MCP connector will not refuse it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.air_quality_daily (
    calendar_date  DATE         PRIMARY KEY,                       -- ET clock date of the hourly values
    pm25_mean      NUMERIC(7,2) CHECK (pm25_mean >= 0),            -- ug/m3, mean of the day's hourly values
    pm25_max       NUMERIC(7,2) CHECK (pm25_max >= 0),             -- ug/m3, highest hourly value
    us_aqi_mean    NUMERIC(6,1) CHECK (us_aqi_mean >= 0),          -- US AQI (all pollutants), mean of the hours
    us_aqi_max     NUMERIC(6,1) CHECK (us_aqi_max >= 0),
    n_hours        SMALLINT     NOT NULL CHECK (n_hours BETWEEN 0 AND 25),  -- hours with a PM2.5 value (24 on a complete day, also on DST days)
    latitude       NUMERIC(8,4) NOT NULL,                          -- location requested from the API
    longitude      NUMERIC(8,4) NOT NULL,
    source         TEXT         NOT NULL DEFAULT 'open-meteo-cams',
    synced_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE pds.air_quality_daily IS
    'Daily PM2.5 / US AQI per ET clock day from the Open-Meteo Air Quality API (CAMS model analysis) for the fixed home location. Written by air_quality_etl.py every 3 hours; read by hrv_analysis.py (aqi_* features) and /api/status.';

-- ---------------------------------------------------------------------------
-- RLS + grants: service role only (mirrors sql/procurement_schema.sql)
-- ---------------------------------------------------------------------------
ALTER TABLE pds.air_quality_daily ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'air_quality_daily' AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.air_quality_daily
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

REVOKE ALL ON pds.air_quality_daily FROM anon, authenticated;
GRANT ALL ON pds.air_quality_daily TO service_role;

-- Make PostgREST pick up the new table without waiting for a restart.
NOTIFY pgrst, 'reload schema';
