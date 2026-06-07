-- =============================================================================
-- meal_timing_daily: switch WHOOP cycle join to onyx_behavioral_date (2026-05-25)
-- =============================================================================
-- Closes Notion roadmap "HRV walkthrough: date-attribution audit for every
-- variable in the analysis matrix" (page 369bf5b4-4bf2-812f-93a4-f25578dbf771).
--
-- Audit finding (the one real bug in the audit): pds.meal_timing_daily joins
-- WHOOP cycles via the legacy `(start_time + 12h) AT NY` ET rule:
--
--   LEFT JOIN pds.whoop_cycles wc
--     ON ((wc.start_time + 12h) AT NY)::date = (agg.calendar_date + 1)::date
--
-- That rule pre-dates ADR-0001 and is correct only as long as the user is in
-- ET. During travel, the cycle's behavioral_date is computed from the user's
-- local TZ (see whoop_cycles.onyx_behavioral_date) and diverges from
-- the +12h-ET shortcut. Result: meal_last_meal_to_bedtime_min would silently
-- pick the wrong cycle (off-by-one-day) on transition days and on stays in
-- foreign timezones, which is exactly the class of bug the HRV journal-
-- date fix (commit 562545d) was meant to catch.
--
-- Fix: join on `wc.onyx_behavioral_date = agg.calendar_date` directly. The
-- matrix's `wc` LATERAL already picks the longest cycle on transition days
-- (two cycles per behavioral_date); mirror that pattern here.
--
-- Rest of the audit was clean — see docs/date_attribution_audit_2026-05-25.md.
-- =============================================================================

-- CREATE OR REPLACE (not DROP CASCADE) to preserve dependents
-- (daily_health_matrix_behavioral, daily_health_matrix). Column list is
-- unchanged from the prior view, so REPLACE is safe.
CREATE OR REPLACE VIEW pds.meal_timing_daily AS
WITH ranked AS (
    SELECT
        event_date,
        event_time,
        kind,
        ROW_NUMBER() OVER (PARTITION BY event_date ORDER BY event_time DESC) AS rn_last,
        ROW_NUMBER() OVER (PARTITION BY event_date ORDER BY event_time ASC)  AS rn_first
    FROM pds.meal_events
),
agg AS (
    SELECT
        event_date AS calendar_date,
        MAX(event_time) FILTER (WHERE rn_last = 1)  AS last_meal_time,
        MIN(event_time) FILTER (WHERE rn_first = 1) AS first_meal_time,
        EXTRACT(
            EPOCH FROM (MAX(event_time) FILTER (WHERE rn_last = 1)  AT TIME ZONE 'America/New_York')
            - DATE_TRUNC('day', MAX(event_time) FILTER (WHERE rn_last = 1) AT TIME ZONE 'America/New_York')
        ) / 3600.0 AS last_meal_hour,
        EXTRACT(
            EPOCH FROM (MIN(event_time) FILTER (WHERE rn_first = 1) AT TIME ZONE 'America/New_York')
            - DATE_TRUNC('day', MIN(event_time) FILTER (WHERE rn_first = 1) AT TIME ZONE 'America/New_York')
        ) / 3600.0 AS first_meal_hour,
        CASE
            WHEN COUNT(*) > 1 THEN
                EXTRACT(EPOCH FROM (MAX(event_time) - MIN(event_time))) / 3600.0
            ELSE NULL
        END AS eating_window_hours,
        COUNT(*) AS meal_event_count,
        MAX(kind) FILTER (WHERE rn_last = 1) AS last_meal_kind
    FROM ranked
    GROUP BY event_date
)
SELECT
    agg.calendar_date,
    agg.last_meal_time,
    agg.first_meal_time,
    agg.last_meal_hour,
    agg.first_meal_hour,
    agg.eating_window_hours,
    agg.meal_event_count,
    agg.last_meal_kind,
    ws.start_time AS sleep_start_time,
    CASE
        WHEN ws.start_time IS NOT NULL AND agg.last_meal_time IS NOT NULL THEN
            EXTRACT(EPOCH FROM (ws.start_time - agg.last_meal_time)) / 60.0
        ELSE NULL
    END AS last_meal_to_bedtime_minutes
FROM agg
-- The WHOOP cycle closing behavioral day N is the cycle whose
-- onyx_behavioral_date = N. On transition days (rare: travel + DST) two
-- cycles can share a behavioral_date; pick the longest, mirroring the
-- daily_health_matrix_behavioral `wc` LATERAL.
LEFT JOIN LATERAL (
    SELECT wc2.cycle_id, wc2.start_time
    FROM pds.whoop_cycles wc2
    WHERE wc2.onyx_behavioral_date = agg.calendar_date
    ORDER BY (wc2.end_time - wc2.start_time) DESC NULLS LAST, wc2.start_time DESC
    LIMIT 1
) wc ON true
LEFT JOIN pds.whoop_sleep ws
    ON ws.cycle_id = wc.cycle_id
   AND ws.is_nap = false
   AND ws.score_state = 'SCORED'
ORDER BY agg.calendar_date DESC;

GRANT SELECT ON pds.meal_timing_daily TO anon, authenticated;
