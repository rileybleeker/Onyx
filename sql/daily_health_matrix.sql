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
--             activities (aggregated), body_composition (LVCF)
--   WHOOP   : cycles (avg/max HR), recovery, sleep, workouts (aggregated)
--   Eight Sleep : trends (left side)
--   MyFitnessPal: nutrition
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

  -- ── Garmin Activities (aggregated per day) ────────────────────────────────
  acts.activity_count             AS garmin_activity_count,
  acts.activity_duration_sec      AS garmin_activity_duration_sec,
  acts.activity_distance_m        AS garmin_activity_distance_m,
  acts.activity_calories          AS garmin_activity_calories,
  acts.activity_training_load     AS garmin_activity_training_load,
  acts.activity_max_hr            AS garmin_activity_max_hr,
  acts.activity_avg_hr            AS garmin_activity_avg_hr,

  -- ── Garmin Body Composition (most recent on or before date) ──────────────
  -- Last-value-carried-forward: fills days without a weigh-in
  gbc.weight_kg,
  gbc.bmi,
  gbc.body_fat_pct,
  gbc.body_water_pct,
  gbc.muscle_mass_grams,
  gbc.bone_mass_grams,
  gbc.visceral_fat,
  gbc.metabolic_age,

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
  es.avg_bed_temp                 AS eight_sleep_bed_temp,
  es.avg_room_temp                AS eight_sleep_room_temp,
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
  mfp.exercise_kcal               AS mfp_exercise_kcal

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
) acts ON true

-- Garmin Body Composition: last known measurement on or before this date (LVCF)
LEFT JOIN LATERAL (
  SELECT *
  FROM pds.garmin_body_composition gbc2
  WHERE gbc2.calendar_date <= gds.calendar_date
  ORDER BY gbc2.calendar_date DESC
  LIMIT 1
) gbc ON true

-- WHOOP Cycles
LEFT JOIN pds.whoop_cycles wc
  ON (wc.start_time AT TIME ZONE 'UTC')::date = gds.calendar_date

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
  WHERE (ww.start_time AT TIME ZONE 'UTC')::date = gds.calendar_date
    AND ww.score_state = 'SCORED'
) wkts ON true

-- Eight Sleep (left side only)
LEFT JOIN pds.eight_sleep_trends es
  ON es.calendar_date = gds.calendar_date AND es.bed_side = 'left'

-- MyFitnessPal Nutrition
LEFT JOIN pds.myfitnesspal_nutrition mfp
  ON mfp.calendar_date = gds.calendar_date

ORDER BY gds.calendar_date DESC;

GRANT SELECT ON pds.daily_health_matrix TO anon, authenticated;
