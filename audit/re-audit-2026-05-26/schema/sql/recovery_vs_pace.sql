-- =============================================================================
-- pds.recovery_vs_pace — running activities × WHOOP recovery context
-- =============================================================================
-- Used by /activities page (frontend) to overlay each run with the morning's
-- WHOOP recovery / HRV / sleep performance. Joins runs against the WHOOP
-- cycle whose ET-wake-day matches activity_date (via the +12h trick).
--
-- Audit P1 (G4) 2026-05-26: column whoop_hrv renamed to whoop_hrv_rmssd_ms.
-- Pre-rename the name hid both the source (WHOOP RMSSD vs Garmin's algorithm
-- vs Eight Sleep's avg_hrv) and the unit (milliseconds). The three HRV
-- sources are deliberately NEVER combined statistically — each has its own
-- algorithm and unit (see CLAUDE.md HRV semantics note). View consumers
-- must pick a specific source column rather than a unified "HRV" metric.
-- =============================================================================

DROP VIEW IF EXISTS pds.recovery_vs_pace CASCADE;
CREATE VIEW pds.recovery_vs_pace AS
WITH running_activities AS (
    SELECT a.activity_id, a.activity_name, a.activity_type, a.start_time_local,
           a.start_time_local::date AS activity_date, a.training_effect_label,
           a.avg_speed_mps, a.distance_meters, a.duration_seconds,
           a.avg_heart_rate, a.max_heart_rate,
           ((a.raw_json #>> '{}'::text[])::jsonb) ->> 'workoutId' AS workout_id,
           (SELECT (elem.value ->> 'averageSpeed')::numeric
              FROM jsonb_array_elements(((a.raw_json #>> '{}'::text[])::jsonb) -> 'splitSummaries') elem(value)
             WHERE (elem.value ->> 'splitType') = 'INTERVAL_ACTIVE'
             LIMIT 1) AS interval_actual_pace_mps,
           (SELECT (elem.value ->> 'noOfSplits')::integer
              FROM jsonb_array_elements(((a.raw_json #>> '{}'::text[])::jsonb) -> 'splitSummaries') elem(value)
             WHERE (elem.value ->> 'splitType') = 'INTERVAL_ACTIVE'
             LIMIT 1) AS interval_split_count
      FROM pds.garmin_activities a
     WHERE a.activity_type = ANY (ARRAY['running','track_running','treadmill_running'])
), with_targets AS (
    SELECT ra.*, gw.interval_target_pace_low_mps, gw.interval_target_pace_high_mps,
           (gw.interval_target_pace_low_mps + gw.interval_target_pace_high_mps) / 2.0 AS target_pace_mid_mps,
           gw.interval_distance_meters AS target_interval_distance,
           gw.interval_count AS target_interval_count, gw.workout_name,
           gw.segment_targets,
           COALESCE(jsonb_array_length(gw.segment_targets), 0) AS segment_target_count
      FROM running_activities ra
      LEFT JOIN pds.garmin_workouts gw ON ra.workout_id = gw.workout_id::text
), with_recovery AS (
    SELECT wt.*,
           wr.recovery_score AS whoop_recovery,
           wr.resting_heart_rate AS whoop_rhr,
           wr.hrv_rmssd_milli AS whoop_hrv_rmssd_ms,
           wr.spo2_percentage AS whoop_spo2,
           ws.sleep_performance_percentage AS whoop_sleep_performance,
           ws.sleep_efficiency_percentage AS whoop_sleep_efficiency,
           ws.respiratory_rate AS whoop_resp_rate,
           CASE
               WHEN wt.segment_target_count > 1 THEN NULL::numeric
               WHEN wt.target_pace_mid_mps IS NOT NULL AND wt.interval_actual_pace_mps IS NOT NULL
                   THEN round((wt.target_pace_mid_mps - wt.interval_actual_pace_mps) / wt.target_pace_mid_mps * 100::numeric, 2)
               ELSE NULL::numeric
           END AS pace_delta_pct,
           CASE WHEN wt.interval_actual_pace_mps > 0::numeric
                THEN round(1609.34 / wt.interval_actual_pace_mps / 60::numeric, 2)
                ELSE NULL::numeric END AS actual_pace_min_per_mile,
           CASE WHEN wt.target_pace_mid_mps > 0::numeric
                THEN round(1609.34 / wt.target_pace_mid_mps / 60::numeric, 2)
                ELSE NULL::numeric END AS target_pace_min_per_mile,
           CASE WHEN wt.avg_speed_mps > 0::double precision
                THEN round((1609.34::double precision / wt.avg_speed_mps / 60::double precision)::numeric, 2)
                ELSE NULL::numeric END AS overall_pace_min_per_mile
      FROM with_targets wt
      LEFT JOIN pds.whoop_cycles wc ON wt.activity_date = ((wc.start_time + INTERVAL '12 hours') AT TIME ZONE 'America/New_York')::date
      LEFT JOIN pds.whoop_recovery wr ON wc.cycle_id = wr.cycle_id AND wr.score_state = 'SCORED'
      LEFT JOIN pds.whoop_sleep ws ON wc.cycle_id = ws.cycle_id AND ws.is_nap = false AND ws.score_state = 'SCORED'
)
SELECT activity_date, activity_name, activity_type, training_effect_label, workout_name,
       whoop_recovery, whoop_hrv_rmssd_ms, whoop_rhr, whoop_spo2,
       whoop_sleep_performance, whoop_sleep_efficiency,
       pace_delta_pct, actual_pace_min_per_mile, target_pace_min_per_mile,
       overall_pace_min_per_mile, interval_actual_pace_mps, target_pace_mid_mps,
       interval_split_count, distance_meters, duration_seconds,
       avg_heart_rate, max_heart_rate, activity_id,
       segment_targets, segment_target_count
  FROM with_recovery
 ORDER BY activity_date DESC;

GRANT SELECT ON pds.recovery_vs_pace TO anon, authenticated;
