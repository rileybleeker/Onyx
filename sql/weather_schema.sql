-- ============================================================================
-- Daily weather: one row per ET clock day (weather_etl.py)
-- ============================================================================
-- Source: the keyless Open-Meteo archive API (ECMWF IFS + ERA5 reanalysis, hourly),
-- for the home location (the same AIR_QUALITY_LAT / AIR_QUALITY_LON constants as
-- pds.air_quality_daily, Atlanta by default). The ETL asks for UTC hours, converts
-- each one to America/New_York itself and aggregates the hours of every ET clock
-- day (the API applies one UTC offset to a whole response, so its own "local day"
-- is an hour off for dates in the other DST season).
--
-- calendar_date is the ET CLOCK date of the hourly values, not a behavioral day.
-- Units are metric: C, %, hPa, mm, km/h, hours.
--
-- Row placement in the HRV pipeline (hrv_analysis.merge_weather_features):
--   * the daytime columns of clock day D sit on matrix row D (the sleep that closes
--     behavioral day D), like pds.air_quality_daily;
--   * night_temp_mean / night_temp_min are the hourly values at 01:00-08:00 ET of
--     the row's clock day. Those hours fall inside the sleep that started the
--     evening BEFORE, so the pipeline places them one row earlier (clock day D + 1
--     on matrix row D);
--   * temperature_min is the lowest hourly value of the clock day. It usually
--     falls near dawn, inside that earlier sleep, so it is stored for display and
--     is NOT an HRV feature.
--
-- uv_index_max comes from a second Open-Meteo API (historical forecast, stitched
-- forecast runs) because the archive returns null for it; uv_source says so. It
-- is best-effort and may be null.
--
-- This is model data for a regional grid cell, not a sensor at the apartment, and
-- it follows the fixed home location, not where Riley is on a trip. latitude /
-- longitude are stored on every row so a move (NYC) stays auditable.
--
-- n_hours counts the hours with a temperature value. Hours after "now" are never
-- stored, so today's row is partial until the day ends; the pipeline and the page
-- count a day only once it is over (date before ET today) and has at least 23 hours
-- (the shortest full ET day). Only the date is stored (no timestamptz instant), so
-- there are no onyx_*_date columns.
--
-- Access: service role only. The ETL writes with the service-role key; /api/status
-- and /api/weather read with it on the server. anon / authenticated get nothing.
--
-- Safe to re-run (IF NOT EXISTS everywhere). Additive only: it contains no
-- statement that removes an object.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.weather_daily (
    calendar_date       DATE         PRIMARY KEY,                          -- ET clock date of the hourly values
    temperature_max     NUMERIC(5,2),                                      -- C, highest hourly value
    temperature_min     NUMERIC(5,2),                                      -- C, lowest hourly value (display only, see header)
    temperature_mean    NUMERIC(5,2),                                      -- C, mean of the day's hourly values
    apparent_temp_mean  NUMERIC(5,2),                                      -- C, "feels like"
    apparent_temp_max   NUMERIC(5,2),
    humidity_mean       NUMERIC(5,2) CHECK (humidity_mean BETWEEN 0 AND 100),     -- % relative humidity
    dew_point_mean      NUMERIC(5,2),                                      -- C
    pressure_mean       NUMERIC(7,2) CHECK (pressure_mean > 0),            -- hPa at the surface (not sea level)
    precipitation_sum   NUMERIC(7,2) CHECK (precipitation_sum >= 0),       -- mm, rain + snow water
    wind_speed_max      NUMERIC(6,2) CHECK (wind_speed_max >= 0),          -- km/h at 10 m, highest hourly value
    cloud_cover_mean    NUMERIC(5,2) CHECK (cloud_cover_mean BETWEEN 0 AND 100),  -- %
    daylight_hours      NUMERIC(5,2) CHECK (daylight_hours BETWEEN 0 AND 24),     -- sunrise to sunset (astronomy)
    sunshine_hours      NUMERIC(5,2) CHECK (sunshine_hours BETWEEN 0 AND 25),     -- hours of direct sun (so far, on a partial day)
    uv_index_max        NUMERIC(5,2) CHECK (uv_index_max >= 0),            -- highest hourly UV index, null when unavailable
    uv_source           TEXT,                                              -- where uv_index_max came from
    night_temp_mean     NUMERIC(5,2),                                      -- C, mean of the 01:00-08:00 ET values; null until 08:00
    night_temp_min      NUMERIC(5,2),
    night_hours         SMALLINT     NOT NULL DEFAULT 0 CHECK (night_hours BETWEEN 0 AND 9),   -- 8 normally, 7 / 9 on DST days
    n_hours             SMALLINT     NOT NULL CHECK (n_hours BETWEEN 0 AND 25),                -- hours with a temperature value
    latitude            NUMERIC(8,4) NOT NULL,                             -- location requested from the API
    longitude           NUMERIC(8,4) NOT NULL,
    source              TEXT         NOT NULL DEFAULT 'open-meteo-archive',
    synced_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE pds.weather_daily IS
    'Daily outdoor weather per ET clock day from the Open-Meteo archive API for the fixed home location (same coordinates as pds.air_quality_daily). Written by weather_etl.py every 3 hours; read by hrv_analysis.py (wx_* features), /api/status and /api/weather.';

-- ---------------------------------------------------------------------------
-- RLS + grants: service role only (mirrors sql/air_quality_schema.sql)
-- ---------------------------------------------------------------------------
ALTER TABLE pds.weather_daily ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'weather_daily' AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.weather_daily
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

REVOKE ALL ON pds.weather_daily FROM anon, authenticated;
GRANT ALL ON pds.weather_daily TO service_role;

-- Make PostgREST pick up the new table without waiting for a restart.
NOTIFY pgrst, 'reload schema';
