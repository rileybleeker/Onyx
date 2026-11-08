-- =============================================================================
-- daily_health_matrix — canonical view definition
-- =============================================================================
-- One row per calendar_date. Joins every data source onto the
-- garmin_daily_summary spine. Previous partial definitions in
-- whoop_schema.sql, eight_sleep_schema.sql, and myfitnesspal_schema.sql
-- are superseded by this file.
--
-- Sources included:
--   Garmin  : daily_summary, sleep, hrv, heart_rate (zones), training_status,
--             activities (aggregated)
--   WHOOP   : cycles (avg/max HR), recovery, sleep, workouts (aggregated)
--   Eight Sleep : trends (left side)
--   MyFitnessPal: nutrition
--   Meal events: timing (last-meal hour, eating-window, last-meal-to-bedtime gap)
--
-- Apply: run in Supabase SQL Editor or via MCP apply_migration.
-- =============================================================================

DROP VIEW IF EXISTS pds.daily_health_matrix;

CREATE VIEW pds.daily_health_matrix AS
SELECT
  gds.calendar_date,

  -- ── Garmin Daily Summary ──────────────────────────────────────────────────
  gds.total_steps,
  gds.total_distance_meters,
  gds.floors_ascended,
  gds.floors_descended,
  gds.total_kilocalories,
  gds.active_kilocalories,
  gds.bmr_kilocalories,
  gds.resting_heart_rate          AS garmin_rhr,
  gds.min_heart_rate              AS garmin_min_hr,
  gds.max_heart_rate              AS garmin_max_hr,
  gds.last_seven_days_avg_rhr     AS garmin_7d_avg_rhr,
  gds.avg_stress_level,
  gds.max_stress_level,
  gds.rest_stress_duration_min,
  gds.low_stress_duration_min,
  gds.medium_stress_duration_min,
  gds.high_stress_duration_min,
  gds.stress_qualifier,
  gds.body_battery_highest,
  gds.body_battery_lowest,
  gds.body_battery_charged,
  gds.body_battery_drained,
  gds.body_battery_most_recent,
  gds.avg_spo2                    AS garmin_spo2,
  gds.lowest_spo2                 AS garmin_lowest_spo2,
  gds.avg_waking_respiration,
  gds.moderate_intensity_minutes,
  gds.vigorous_intensity_minutes,
  gds.highly_active_seconds,
  gds.active_seconds,
  gds.sedentary_seconds,
  gds.sleeping_seconds            AS garmin_sleeping_seconds,

  -- ── Garmin Stress Buckets (granular, not just average) ───────────────────
  gstr.overall_stress_level       AS garmin_stress_overall,
  gstr.rest_stress_duration_sec   AS garmin_rest_stress_sec,
  gstr.low_stress_duration_sec    AS garmin_low_stress_sec,
  gstr.medium_stress_duration_sec AS garmin_medium_stress_sec,
  gstr.high_stress_duration_sec   AS garmin_high_stress_sec,

  -- ── Garmin Sleep ─────────────────────────────────────────────────────────
  -- Best non-nap sleep per day (lateral join below)
  gs.overall_sleep_score          AS garmin_sleep_score,
  gs.sleep_duration_seconds       AS garmin_sleep_duration_sec,
  gs.deep_sleep_seconds           AS garmin_deep_sleep_sec,
  gs.light_sleep_seconds          AS garmin_light_sleep_sec,
  gs.rem_sleep_seconds            AS garmin_rem_sleep_sec,
  gs.awake_seconds                AS garmin_awake_sec,
  gs.avg_sleep_heart_rate         AS garmin_sleep_hr,
  gs.avg_respiration_rate         AS garmin_sleep_respiration,
  gs.avg_sleep_stress             AS garmin_sleep_stress,
  -- NOTE: gs.avg_hrv was previously aliased here as `garmin_hrv` but is 100% NULL
  -- across history (Garmin's sleep DTO does not populate hrvAverage in our data).
  -- Use `garmin_hrv_last_night` (from the dedicated garmin_hrv table) below instead.

  -- ── Garmin HRV ───────────────────────────────────────────────────────────
  ghrv.weekly_avg_ms              AS garmin_hrv_weekly_avg,
  ghrv.last_night_avg_ms          AS garmin_hrv_last_night,
  ghrv.last_night_5min_high_ms    AS garmin_hrv_5min_high,
  ghrv.baseline_balanced_low_ms   AS garmin_hrv_baseline_low,
  ghrv.baseline_balanced_upper_ms AS garmin_hrv_baseline_high,
  ghrv.hrv_status                 AS garmin_hrv_status,

  -- ── Garmin Heart Rate Zones ───────────────────────────────────────────────
  ghr.zone_1_seconds              AS garmin_hr_zone1_sec,
  ghr.zone_2_seconds              AS garmin_hr_zone2_sec,
  ghr.zone_3_seconds              AS garmin_hr_zone3_sec,
  ghr.zone_4_seconds              AS garmin_hr_zone4_sec,
  ghr.zone_5_seconds              AS garmin_hr_zone5_sec,

  -- ── Garmin Training Status ────────────────────────────────────────────────
  gts.training_readiness_score,
  gts.training_readiness_level,
  gts.acute_training_load         AS garmin_acute_training_load,
  gts.chronic_training_load       AS garmin_chronic_training_load,
  gts.training_load_balance       AS garmin_training_load_balance,
  gts.training_load_factor        AS garmin_training_load_factor,
  gts.training_status             AS garmin_training_status,
  gts.recovery_time_hours         AS garmin_recovery_time_hours,
  gts.recovery_time_factor        AS garmin_recovery_time_factor,
  gts.recovery_heart_rate         AS garmin_recovery_hr,
  gts.hrv_factor                  AS garmin_hrv_factor,
  gts.sleep_score_factor          AS garmin_sleep_score_factor,
  gts.sleep_history_factor        AS garmin_sleep_history_factor,
  gts.stress_history_factor       AS garmin_stress_history_factor,
  gts.vo2_max_running             AS garmin_vo2_max_running,
  gts.vo2_max_cycling             AS garmin_vo2_max_cycling,
  gts.fitness_age                 AS garmin_fitness_age,

  -- ── Garmin Activities (aggregated per day) ────────────────────────────────
  acts.activity_count             AS garmin_activity_count,
  acts.activity_duration_sec      AS garmin_activity_duration_sec,
  acts.activity_distance_m        AS garmin_activity_distance_m,
  acts.activity_calories          AS garmin_activity_calories,
  acts.activity_training_load     AS garmin_activity_training_load,
  acts.activity_max_hr            AS garmin_activity_max_hr,
  acts.activity_avg_hr            AS garmin_activity_avg_hr,

  -- ── WHOOP Cycles ─────────────────────────────────────────────────────────
  wc.strain                       AS whoop_day_strain,
  wc.kilojoule                    AS whoop_kilojoule,
  wc.average_heart_rate           AS whoop_cycle_avg_hr,
  wc.max_heart_rate               AS whoop_cycle_max_hr,

  -- ── WHOOP Recovery ────────────────────────────────────────────────────────
  wr.recovery_score               AS whoop_recovery_score,
  wr.resting_heart_rate           AS whoop_rhr,
  wr.hrv_rmssd_milli              AS whoop_hrv_rmssd,
  wr.spo2_percentage              AS whoop_spo2,
  wr.skin_temp_celsius            AS whoop_skin_temp,

  -- ── WHOOP Sleep ───────────────────────────────────────────────────────────
  ws.total_in_bed_time_milli      AS whoop_sleep_duration_milli,
  ws.sleep_performance_percentage AS whoop_sleep_performance,
  ws.sleep_efficiency_percentage  AS whoop_sleep_efficiency,
  ws.sleep_consistency_percentage AS whoop_sleep_consistency,
  ws.total_slow_wave_sleep_time_milli AS whoop_deep_sleep_milli,
  ws.total_rem_sleep_time_milli   AS whoop_rem_sleep_milli,
  ws.total_light_sleep_time_milli AS whoop_light_sleep_milli,
  ws.total_awake_time_milli       AS whoop_awake_milli,
  ws.disturbance_count            AS whoop_disturbances,
  ws.respiratory_rate             AS whoop_respiratory_rate,

  -- ── WHOOP Workouts (aggregated per day) ───────────────────────────────────
  wkts.whoop_workout_count,
  wkts.whoop_workout_strain,
  wkts.whoop_zone2_milli,

  -- ── Eight Sleep ───────────────────────────────────────────────────────────
  es.sleep_score                  AS eight_sleep_score,
  es.sleep_fitness_score          AS eight_sleep_fitness_score,
  es.avg_hrv                      AS eight_sleep_hrv,
  es.avg_heart_rate               AS eight_sleep_hr,
  es.avg_breath_rate              AS eight_sleep_breath_rate,
  es.median_bed_temp              AS eight_sleep_bed_temp,
  es.median_room_temp             AS eight_sleep_room_temp,
  es.time_slept_seconds           AS eight_sleep_duration_sec,
  es.deep_sleep_seconds           AS eight_sleep_deep_sec,
  es.rem_sleep_seconds            AS eight_sleep_rem_sec,
  es.toss_and_turns               AS eight_sleep_toss_turns,

  -- ── MyFitnessPal Nutrition ────────────────────────────────────────────────
  mfp.calories                    AS mfp_calories,
  mfp.protein_g                   AS mfp_protein_g,
  mfp.carbs_g                     AS mfp_carbs_g,
  mfp.fat_g                       AS mfp_fat_g,
  mfp.fiber_g                     AS mfp_fiber_g,
  mfp.sugar_g                     AS mfp_sugar_g,
  mfp.sodium_mg                   AS mfp_sodium_mg,
  mfp.water_ml                    AS mfp_water_ml,
  mfp.exercise_kcal               AS mfp_exercise_kcal,

  -- ── Meal timing (pds.meal_timing_daily) ───────────────────────────────────
  -- The bedtime-anchored gap (meal_last_meal_to_bedtime_minutes) is the
  -- primary feature the HRV pipeline reads; it's monotonic in physiological
  -- lateness regardless of clock wraparound, which the absolute last_hour
  -- isn't (a 1:30 AM meal numerically reads as 1.5, not 25.5).
  mt.last_meal_hour               AS meal_last_hour,
  mt.first_meal_hour              AS meal_first_hour,
  mt.eating_window_hours          AS meal_eating_window_hours,
  mt.meal_event_count             AS meal_event_count,
  mt.last_meal_to_bedtime_minutes AS meal_last_meal_to_bedtime_min,

  -- ── Caffeine timing (pds.caffeine_timing_daily) ───────────────────────────
  -- Bedtime-anchored caffeine_to_bedtime_min is the primary HRV-pipeline
  -- feature (monotonic across midnight); the clock-hour fields exist for
  -- descriptive/UI use. See sql/caffeine_timing_daily.sql for rationale.
  ct.first_caffeine_hour          AS caffeine_first_hour,
  ct.last_caffeine_hour           AS caffeine_last_hour,
  ct.caffeine_window_hours        AS caffeine_window_hours,
  ct.caffeine_intake_count        AS caffeine_intake_count,
  ct.last_caffeine_to_bedtime_minutes AS caffeine_to_bedtime_min

FROM pds.garmin_daily_summary gds

-- Garmin Sleep: best non-nap sleep per day. Filter out placeholder rows where the
-- ETL wrote an empty record (sleep_id IS NULL) — Postgres treats NULLs as distinct
-- in unique constraints, so hourly runs accumulated ~70 placeholders per empty day.
LEFT JOIN LATERAL (
  SELECT *
  FROM pds.garmin_sleep gs2
  WHERE gs2.calendar_date = gds.calendar_date
    AND gs2.is_nap = false
    AND gs2.sleep_id IS NOT NULL
  ORDER BY gs2.overall_sleep_score DESC NULLS LAST
  LIMIT 1
) gs ON true

-- Garmin HRV
LEFT JOIN pds.garmin_hrv ghrv
  ON ghrv.calendar_date = gds.calendar_date

-- Garmin Heart Rate Zones
LEFT JOIN pds.garmin_heart_rate ghr
  ON ghr.calendar_date = gds.calendar_date

-- Garmin Stress (granular buckets — daily summary only stores the average)
LEFT JOIN pds.garmin_stress gstr
  ON gstr.calendar_date = gds.calendar_date

-- Garmin Training Status
LEFT JOIN pds.garmin_training_status gts
  ON gts.calendar_date = gds.calendar_date

-- Garmin Activities: aggregate all activities for the day
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::int         AS activity_count,
    SUM(duration_seconds) AS activity_duration_sec,
    SUM(distance_meters)  AS activity_distance_m,
    SUM(calories)         AS activity_calories,
    SUM(training_load)    AS activity_training_load,
    MAX(max_heart_rate)   AS activity_max_hr,
    AVG(avg_heart_rate)   AS activity_avg_hr
  FROM pds.garmin_activities ga
  WHERE ga.start_time_local::date = gds.calendar_date
    AND NOT ga.is_excluded
) acts ON true

-- WHOOP Cycles — tag each cycle to its "wake day" ET date.
-- WHOOP cycles run bedtime-to-bedtime, so start_time is the previous evening.
-- Using (start_time + 12h) in ET lands on midday of the day the cycle represents
-- (the day whose sleep ended the morning after start, whose day-strain accumulates
-- during, and whose next bedtime closes the cycle). This is stable across bedtime
-- shifts, unlike a plain UTC cast or ET-of-start. Workouts below, by contrast, are
-- point-in-time events, so they use plain ET-of-start.
LEFT JOIN pds.whoop_cycles wc
  ON ((wc.start_time + INTERVAL '12 hours') AT TIME ZONE 'America/New_York')::date = gds.calendar_date

-- WHOOP Recovery
LEFT JOIN pds.whoop_recovery wr
  ON wr.cycle_id = wc.cycle_id AND wr.score_state = 'SCORED'

-- WHOOP Sleep
LEFT JOIN pds.whoop_sleep ws
  ON ws.cycle_id = wc.cycle_id AND ws.is_nap = false AND ws.score_state = 'SCORED'

-- WHOOP Workouts: aggregate scored workouts for the day
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::int       AS whoop_workout_count,
    SUM(strain)         AS whoop_workout_strain,
    SUM(zone_two_milli) AS whoop_zone2_milli
  FROM pds.whoop_workouts ww
  WHERE (ww.start_time AT TIME ZONE 'America/New_York')::date = gds.calendar_date
    AND ww.score_state = 'SCORED'
    AND NOT ww.is_excluded
) wkts ON true

-- Eight Sleep (left side only)
LEFT JOIN pds.eight_sleep_trends es
  ON es.calendar_date = gds.calendar_date AND es.bed_side = 'left'

-- MyFitnessPal Nutrition
LEFT JOIN pds.myfitnesspal_nutrition mfp
  ON mfp.calendar_date = gds.calendar_date

-- Meal timing — keyed by behavioral day (event_date in pds.meal_events).
-- The view itself handles the +1-day shift to find the WHOOP cycle that
-- closes the day; we just join on the behavioral date directly.
LEFT JOIN pds.meal_timing_daily mt
  ON mt.calendar_date = gds.calendar_date

-- Caffeine timing — keyed by behavioral day (intake_date in
-- pds.supplement_intake follows the behavioral-day convention).
LEFT JOIN pds.caffeine_timing_daily ct
  ON ct.calendar_date = gds.calendar_date

ORDER BY gds.calendar_date DESC;

GRANT SELECT ON pds.daily_health_matrix TO anon, authenticated;
