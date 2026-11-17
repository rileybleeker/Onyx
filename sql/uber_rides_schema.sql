-- ============================================================================
-- Uber rides (2026-11-17): one row per ride from Uber's own privacy download
-- ============================================================================
-- Source: the "Download your data" export at myprivacy.uber.com (Riley asks for it,
-- Uber emails a link, the ZIP holds Rider/trips_data.csv). Imported by
-- uber_rides_import.py. NO scraping of riders.uber.com: Uber's Agent Terms (US General
-- Terms s.10, 2026-11-04) let it suspend an account that an unidentified automated agent
-- reads, so this source is a file import only.
--
-- Stored: request / start / end times, product, city, status, distance, fare.
-- NOT stored: pickup and drop-off addresses, driver, phone numbers, payment details.
-- Idempotent, no statement that removes objects (the Supabase MCP refuses those).
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.uber_rides (
    ride_key              TEXT PRIMARY KEY,           -- sha256 of request time + start + end + fare (first 32 hex)
    requested_at          TIMESTAMPTZ NOT NULL,
    started_at            TIMESTAMPTZ,
    ended_at              TIMESTAMPTZ,
    product               TEXT,                       -- UberX, Comfort, Black, ...
    city                  TEXT,
    status                TEXT NOT NULL DEFAULT 'completed',
    distance_miles        NUMERIC(8,2),
    fare_amount           NUMERIC(10,2),
    fare_currency         TEXT,
    synced_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- ADR-0001 quad (trigger-populated from the ride's start, else request, instant)
    onyx_et_date          DATE,
    onyx_behavioral_date  DATE,
    onyx_local_date       DATE,
    onyx_tz_source        TEXT,
    CHECK (status IN ('completed', 'canceled', 'other'))
);

CREATE INDEX IF NOT EXISTS uber_rides_behavioral_idx ON pds.uber_rides (onyx_behavioral_date);

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_uber_rides()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(COALESCE(NEW.started_at, NEW.requested_at), NULL, NULL);
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER uber_rides_set_onyx_dates
    BEFORE INSERT OR UPDATE OF requested_at, started_at ON pds.uber_rides
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_uber_rides();

-- Service role only: RLS on, no policies, nothing granted to anon / authenticated.
ALTER TABLE pds.uber_rides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.uber_rides FROM anon, authenticated;
GRANT ALL ON pds.uber_rides TO service_role;

-- One row per behavioral day with a completed ride (late = started 22:00-05:59 local).
CREATE OR REPLACE VIEW pds.uber_rides_daily WITH (security_invoker = true) AS
WITH r AS (
    SELECT onyx_behavioral_date, distance_miles,
           EXTRACT(HOUR FROM (COALESCE(started_at, requested_at)
               AT TIME ZONE pds.tz_for_instant(COALESCE(started_at, requested_at))))::int AS local_hour
    FROM pds.uber_rides
    WHERE status = 'completed'
)
SELECT onyx_behavioral_date AS behavioral_date,
       COUNT(*)                                          AS rides,
       ROUND(SUM(distance_miles)::numeric, 1)            AS miles,
       COUNT(*) FILTER (WHERE local_hour >= 22 OR local_hour < 6) AS late_rides
FROM r
GROUP BY 1;
