-- Flight-day bridge: plane habit history <-> Delta flight tracker (2026-11-09)
-- ---------------------------------------------------------------------------
-- Riley retired the WHOOP-derived habit "Traveled on a plane?" (Notion
-- Active=false; name stays frozen, all history preserved) because pds.flights
-- (flights_email_etl.py, Delta emails from both Gmail accounts) now records
-- flights automatically. Same pattern as pds.melatonin_unified: a READ-ONLY view
-- that splices the frozen habit answers with the new source on the shared
-- behavioral-day axis, so the HRV pipeline keeps the full history while the
-- tracker becomes the source of truth going forward.
--
-- READ-ONLY by construction (SELECT only) -> no frozen-era guard, name-freeze or
-- channel-routing trigger ever fires.
--
-- One row per behavioral day from the first habit answer / tracker coverage
-- start through behavioral today:
--   calendar_date  behavioral day (ET-ish, TZ-aware). Flight side = a live
--                  segment's departure OR arrival behavioral date
--                  (onyx_behavioral_date / arr_behavioral_date); habit side =
--                  COALESCE(behaviors_date, cycle_date), same as pivot_journal.
--   flew           1 = a tracked flight that day, or the habit said Yes (the
--                      habit catches non-Delta flights the tracker can't see).
--                  0 = inside tracker coverage with no flight and no habit Yes,
--                      or the habit said No before coverage. A tracked flight
--                      OVERRIDES a habit No (9 such days at cutover).
--                  NULL = before coverage and no habit answer (unknown).
--   source_flag    'flight' | 'habit' | 'both' | 'tracker_no_flight' | 'habit_no'
--   flights        e.g. 'DL2714 YYZ->ATL, DL904 ATL->YYZ' (audit)
--
-- Tracker coverage starts at the behavioral day of the earliest successfully
-- parsed Delta email in pds.flight_email_log, so it widens automatically when
-- a longer IMAP backfill (`gh workflow run flights-email.yml -f days=N`) finds
-- older mail. Known gap: non-Delta flights after the habit retirement read 0.
--
-- Consumed by hrv_analysis.py:build_feature_matrix, which OVERWRITES the
-- journal_traveled_on_a_plane column with `flew` -- the feature identity (slug,
-- "Air Travel" label, journal family, causal binary enumeration) is unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW pds.flight_day_unified AS
WITH seg AS (
    SELECT onyx_behavioral_date AS d, flight_number, dep_iata, arr_iata, dep_time
    FROM pds.flights WHERE status IN ('confirmed', 'changed')
    UNION
    SELECT arr_behavioral_date, flight_number, dep_iata, arr_iata, dep_time
    FROM pds.flights WHERE status IN ('confirmed', 'changed') AND arr_behavioral_date IS NOT NULL
),
f AS (
    SELECT d,
           string_agg(flight_number || ' ' || coalesce(dep_iata, '?') || '->' || coalesce(arr_iata, '?'),
                      ', ' ORDER BY dep_time) AS flights
    FROM seg WHERE d IS NOT NULL GROUP BY d
),
h AS (
    SELECT COALESCE(behaviors_date, cycle_date) AS d,
           MAX((answer = 'Yes')::int)           AS habit_yes
    FROM pds.journal
    WHERE question = 'Traveled on a plane?' AND answer IN ('Yes', 'No')
    GROUP BY 1
),
cov AS (
    SELECT ((MIN(received_at) AT TIME ZONE 'America/New_York') - INTERVAL '6 hours')::date AS start_d
    FROM pds.flight_email_log WHERE status = 'parsed'
),
spine AS (
    SELECT generate_series(
               LEAST((SELECT MIN(d) FROM h), (SELECT start_d FROM cov), (SELECT MIN(d) FROM f)),
               pds.behavioral_today_now(),
               INTERVAL '1 day')::date AS d
)
SELECT
    s.d AS calendar_date,
    CASE
        WHEN f.d IS NOT NULL OR h.habit_yes = 1 THEN 1
        WHEN s.d >= (SELECT start_d FROM cov) THEN 0
        WHEN h.habit_yes = 0 THEN 0
    END AS flew,
    CASE
        WHEN f.d IS NOT NULL AND h.habit_yes = 1 THEN 'both'
        WHEN f.d IS NOT NULL THEN 'flight'
        WHEN h.habit_yes = 1 THEN 'habit'
        WHEN s.d >= (SELECT start_d FROM cov) THEN 'tracker_no_flight'
        WHEN h.habit_yes = 0 THEN 'habit_no'
    END AS source_flag,
    f.flights
FROM spine s
LEFT JOIN f ON f.d = s.d
LEFT JOIN h ON h.d = s.d;

COMMENT ON VIEW pds.flight_day_unified IS
    'Behavioral-day flight flag: Delta tracker (pds.flights) OR frozen "Traveled on a plane?" habit Yes; 0 inside tracker coverage, NULL before it when unanswered. Feeds journal_traveled_on_a_plane in hrv_analysis.py. See sql/flight_day_unified.sql.';

GRANT SELECT ON pds.flight_day_unified TO anon, authenticated;
