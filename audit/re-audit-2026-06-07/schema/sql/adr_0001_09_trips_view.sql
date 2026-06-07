-- =============================================================================
-- ADR-0001 Phase D — pds.trips view
-- =============================================================================
-- Auto-segments consecutive non-ET behavioral dates into trip rows.
-- Decoupled from WHOOP-cycle existence: generates the full date range from
-- WHOOP coverage and looks up each date's TZ via pds.tz_for_instant (which
-- reads user_tz_log + WHOOP/GPS auto-extensions). A trip is a maximal run
-- of consecutive dates whose resolved TZ is NOT America/New_York. A new
-- trip starts at a gap (TZ change OR ≥1 NY day between).
--
-- Powers the /analytics/travel dashboard.
-- Depends on: every prior adr_0001_*.sql migration + populated user_tz_log.
-- =============================================================================

DROP VIEW IF EXISTS pds.trips;

CREATE VIEW pds.trips AS
WITH date_range AS (
    SELECT generate_series(
        (SELECT MIN(onyx_behavioral_date) FROM pds.whoop_cycles WHERE timezone_offset IS NOT NULL),
        (SELECT MAX(onyx_behavioral_date) FROM pds.whoop_cycles WHERE timezone_offset IS NOT NULL),
        '1 day'::interval
    )::date AS d
),
date_tz AS (
    SELECT
        d,
        pds.tz_for_instant(((d + INTERVAL '12 hours') AT TIME ZONE 'America/New_York')) AS resolved_tz
    FROM date_range
),
non_ny AS (
    SELECT * FROM date_tz WHERE resolved_tz != 'America/New_York'
),
lagged AS (
    SELECT *,
        LAG(d)            OVER (ORDER BY d) AS prev_d,
        LAG(resolved_tz)  OVER (ORDER BY d) AS prev_tz
    FROM non_ny
),
flagged AS (
    SELECT *,
        CASE
            WHEN prev_d IS NULL                              THEN 1
            WHEN prev_tz IS DISTINCT FROM resolved_tz         THEN 1
            WHEN d - prev_d > 1                               THEN 1
            ELSE 0
        END AS new_trip_marker
    FROM lagged
),
grouped AS (
    SELECT *,
        SUM(new_trip_marker) OVER (ORDER BY d ROWS UNBOUNDED PRECEDING) AS trip_grp
    FROM flagged
),
trips_aggregated AS (
    SELECT
        trip_grp,
        MIN(d) AS start_date,
        MAX(d) AS end_date,
        (MAX(d) - MIN(d) + 1)::int AS duration_days,
        resolved_tz AS iana_tz
    FROM grouped
    GROUP BY trip_grp, resolved_tz
)
SELECT
    ROW_NUMBER() OVER (ORDER BY t.start_date) AS trip_id,
    t.start_date,
    t.end_date,
    t.duration_days,
    t.iana_tz,
    (SELECT (EXTRACT(EPOCH FROM wc.timezone_offset::interval) / 3600)::numeric(4,1)
       FROM pds.whoop_cycles wc
      WHERE wc.onyx_behavioral_date BETWEEN t.start_date AND t.end_date
        AND wc.timezone_offset IS NOT NULL
        AND pds.tz_for_instant(wc.start_time) = t.iana_tz
      ORDER BY wc.start_time
      LIMIT 1) AS offset_hours,
    (SELECT COUNT(*)
       FROM pds.whoop_cycles wc
      WHERE wc.onyx_behavioral_date BETWEEN t.start_date AND t.end_date) AS n_cycles
FROM trips_aggregated t
ORDER BY t.start_date DESC;

GRANT SELECT ON pds.trips TO anon, authenticated;
