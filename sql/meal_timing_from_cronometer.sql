-- pds.meal_timing_from_cronometer — automatic meal-timing per behavioral day from
-- Cronometer Gold per-entry timestamps (cronometer_servings.event_time).
-- Applied via Supabase migration `meal_timing_from_cronometer` (2026-05-31).
--
-- Mirrors the LIVE pds.meal_timing_daily shape (LATERAL longest-cycle bedtime anchor,
-- ET decimal hours) so the two COALESCE cleanly in daily_health_matrix_behavioral
-- (Cronometer-first, meal_events fallback). Only timestamped entries (event_time NOT
-- NULL — i.e. Gold) participate; until Gold data lands this returns nothing and the
-- matrix falls back to pds.meal_events.
--
-- event_time is set by cronometer_import.py:behavioral_dates() — Cronometer's naive
-- local clock time is localized to the TZ Riley was in that day (pds.user_tz_log
-- ladder; ET at home), so first/last-meal hours and the bedtime gap are TZ-correct.
CREATE OR REPLACE VIEW pds.meal_timing_from_cronometer AS
 WITH ts AS (
     SELECT cs.onyx_behavioral_date AS calendar_date,
            cs.event_time
       FROM pds.cronometer_servings cs
      WHERE cs.event_time IS NOT NULL
        AND cs.onyx_behavioral_date IS NOT NULL
    ), agg AS (
     SELECT ts.calendar_date,
        min(ts.event_time) AS first_meal_time,
        max(ts.event_time) AS last_meal_time,
        EXTRACT(epoch FROM (max(ts.event_time) AT TIME ZONE 'America/New_York') - date_trunc('day', (max(ts.event_time) AT TIME ZONE 'America/New_York'))) / 3600.0 AS last_meal_hour,
        EXTRACT(epoch FROM (min(ts.event_time) AT TIME ZONE 'America/New_York') - date_trunc('day', (min(ts.event_time) AT TIME ZONE 'America/New_York'))) / 3600.0 AS first_meal_hour,
        CASE WHEN count(DISTINCT ts.event_time) > 1 THEN EXTRACT(epoch FROM max(ts.event_time) - min(ts.event_time)) / 3600.0 ELSE NULL::numeric END AS eating_window_hours,
        count(DISTINCT ts.event_time) AS meal_event_count
       FROM ts
      GROUP BY ts.calendar_date
    )
 SELECT agg.calendar_date,
    agg.first_meal_time,
    agg.last_meal_time,
    agg.first_meal_hour,
    agg.last_meal_hour,
    agg.eating_window_hours,
    agg.meal_event_count,
    ws.start_time AS sleep_start_time,
    CASE WHEN ws.start_time IS NOT NULL AND agg.last_meal_time IS NOT NULL
         THEN EXTRACT(epoch FROM ws.start_time - agg.last_meal_time) / 60.0
         ELSE NULL::numeric END AS last_meal_to_bedtime_minutes
   FROM agg
     LEFT JOIN LATERAL ( SELECT wc2.cycle_id, wc2.start_time
           FROM pds.whoop_cycles wc2
          WHERE wc2.onyx_behavioral_date = agg.calendar_date
          ORDER BY (wc2.end_time - wc2.start_time) DESC NULLS LAST, wc2.start_time DESC
         LIMIT 1) wc ON true
     LEFT JOIN pds.whoop_sleep ws ON ws.cycle_id = wc.cycle_id AND ws.is_nap = false AND ws.score_state = 'SCORED'::text
  ORDER BY agg.calendar_date DESC;

GRANT SELECT ON pds.meal_timing_from_cronometer TO anon, authenticated;

-- Matrix wiring (migration daily_health_matrix_behavioral_cronometer_meal_timing):
-- the 5 meal_* columns in daily_health_matrix_behavioral became
--   COALESCE(mtc.<x>, mt.<x>)   -- Cronometer Gold timing first, meal_events fallback
-- via a new `LEFT JOIN pds.meal_timing_from_cronometer mtc ON mtc.calendar_date = s.calendar_date`.
