-- =============================================================================
-- daily_health_matrix_behavioral: expose Eight Sleep main-session columns
-- =============================================================================
-- Closes Notion roadmap "Bland-Altman: switch to main-only columns for
-- apples-to-apples cross-device comparisons"
-- (page 369bf5b4-4bf2-8149-803f-d81ff6b9f417).
--
-- Why: cross-device BA currently pairs WHOOP main-only sleep against Eight
-- Sleep nap-inclusive totals. The /bland-altman page reads this view to
-- compute the difference-vs-mean plots; without main-only Eight Sleep
-- columns the comparison silently biases toward "Eight Sleep shows more
-- sleep" on nap days. Now that pds.eight_sleep_trends carries both
-- nap-inclusive totals AND *_main_session_seconds columns (commit 501bd5b)
-- we can expose the main-only fields alongside the existing totals and
-- let the BA page pair them symmetrically.
--
-- The existing eight_sleep_duration_sec / eight_sleep_deep_sec /
-- eight_sleep_rem_sec stay (nap-inclusive totals, used elsewhere). The new
-- _main suffix columns are the apples-to-apples partners for WHOOP and
-- Garmin main-session-only durations.
-- =============================================================================

-- Drop CASCADE because we're widening the column list — CREATE OR REPLACE
-- can only widen, but the JSON shape changes affect downstream readers
-- that snapshot the column set, so we re-grant after recreate.
DROP VIEW IF EXISTS pds.daily_health_matrix_behavioral CASCADE;

CREATE VIEW pds.daily_health_matrix_behavioral AS
WITH all_behavioral_dates AS (
    SELECT onyx_behavioral_date AS calendar_date FROM pds.whoop_cycles
        WHERE onyx_behavioral_date IS NOT NULL
    UNION SELECT onyx_behavioral_date FROM pds.garmin_activities
        WHERE onyx_behavioral_date IS NOT NULL
    UNION SELECT onyx_behavioral_date FROM pds.garmin_sleep
        WHERE onyx_behavioral_date IS NOT NULL
    UNION SELECT onyx_behavioral_date FROM pds.garmin_hrv
        WHERE onyx_behavioral_date IS NOT NULL
    UNION SELECT onyx_behavioral_date FROM pds.eight_sleep_trends
        WHERE onyx_behavioral_date IS NOT NULL
    UNION SELECT onyx_behavioral_date FROM pds.myfitnesspal_nutrition
        WHERE onyx_behavioral_date IS NOT NULL
    UNION SELECT onyx_behavioral_date FROM pds.meal_events
        WHERE onyx_behavioral_date IS NOT NULL
    UNION SELECT onyx_behavioral_date FROM pds.supplement_intake
        WHERE onyx_behavioral_date IS NOT NULL
    -- garmin_daily_summary intentionally NOT in the spine (audit P1 G3): its
    -- calendar_date is Garmin watch-local, which can diverge from
    -- onyx_behavioral_date on travel days. GDS still LEFT JOINs below via
    -- calendar_date, accepting that travel-day rows may miss GDS data. Per
    -- ADR-0001 D5 the spine must be canonically behavioral.
)
SELECT s.calendar_date,
    s.calendar_date AS onyx_behavioral_date,
    s.calendar_date AS onyx_et_date,
    s.calendar_date AS onyx_local_date,
    gds.total_steps,
    gds.total_distance_meters,
    gds.floors_ascended,
    gds.floors_descended,
    gds.total_kilocalories,
    gds.active_kilocalories,
    gds.bmr_kilocalories,
    gds.resting_heart_rate AS garmin_rhr,
    gds.min_heart_rate AS garmin_min_hr,
    gds.max_heart_rate AS garmin_max_hr,
    gds.last_seven_days_avg_rhr AS garmin_7d_avg_rhr,
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
    gds.avg_spo2 AS garmin_spo2,
    gds.lowest_spo2 AS garmin_lowest_spo2,
    gds.avg_waking_respiration,
    gds.moderate_intensity_minutes,
    gds.vigorous_intensity_minutes,
    gds.highly_active_seconds,
    gds.active_seconds,
    gds.sedentary_seconds,
    gds.sleeping_seconds AS garmin_sleeping_seconds,
    gstr.overall_stress_level AS garmin_stress_overall,
    gstr.rest_stress_duration_sec AS garmin_rest_stress_sec,
    gstr.low_stress_duration_sec AS garmin_low_stress_sec,
    gstr.medium_stress_duration_sec AS garmin_medium_stress_sec,
    gstr.high_stress_duration_sec AS garmin_high_stress_sec,
    gs.overall_sleep_score AS garmin_sleep_score,
    gs.sleep_duration_seconds AS garmin_sleep_duration_sec,
    gs.deep_sleep_seconds AS garmin_deep_sleep_sec,
    gs.light_sleep_seconds AS garmin_light_sleep_sec,
    gs.rem_sleep_seconds AS garmin_rem_sleep_sec,
    gs.awake_seconds AS garmin_awake_sec,
    gs.avg_sleep_heart_rate AS garmin_sleep_hr,
    gs.avg_respiration_rate AS garmin_sleep_respiration,
    gs.avg_sleep_stress AS garmin_sleep_stress,
    ghrv.weekly_avg_ms AS garmin_hrv_weekly_avg,
    ghrv.last_night_avg_ms AS garmin_hrv_last_night,
    ghrv.last_night_5min_high_ms AS garmin_hrv_5min_high,
    ghrv.baseline_balanced_low_ms AS garmin_hrv_baseline_low,
    ghrv.baseline_balanced_upper_ms AS garmin_hrv_baseline_high,
    ghrv.hrv_status AS garmin_hrv_status,
    ghr.zone_1_seconds AS garmin_hr_zone1_sec,
    ghr.zone_2_seconds AS garmin_hr_zone2_sec,
    ghr.zone_3_seconds AS garmin_hr_zone3_sec,
    ghr.zone_4_seconds AS garmin_hr_zone4_sec,
    ghr.zone_5_seconds AS garmin_hr_zone5_sec,
    gts.training_readiness_score,
    gts.training_readiness_level,
    gts.acute_training_load AS garmin_acute_training_load,
    gts.chronic_training_load AS garmin_chronic_training_load,
    gts.training_load_balance AS garmin_training_load_balance,
    gts.training_load_factor AS garmin_training_load_factor,
    gts.training_status AS garmin_training_status,
    gts.recovery_time_hours AS garmin_recovery_time_hours,
    gts.recovery_time_factor AS garmin_recovery_time_factor,
    gts.recovery_heart_rate AS garmin_recovery_hr,
    gts.hrv_factor AS garmin_hrv_factor,
    gts.sleep_score_factor AS garmin_sleep_score_factor,
    gts.sleep_history_factor AS garmin_sleep_history_factor,
    gts.stress_history_factor AS garmin_stress_history_factor,
    gts.vo2_max_running AS garmin_vo2_max_running,
    gts.vo2_max_cycling AS garmin_vo2_max_cycling,
    gts.fitness_age AS garmin_fitness_age,
    acts.activity_count AS garmin_activity_count,
    acts.activity_duration_sec AS garmin_activity_duration_sec,
    acts.activity_distance_m AS garmin_activity_distance_m,
    acts.activity_calories AS garmin_activity_calories,
    acts.activity_training_load AS garmin_activity_training_load,
    acts.activity_max_hr AS garmin_activity_max_hr,
    acts.activity_avg_hr AS garmin_activity_avg_hr,
    wc.strain AS whoop_day_strain,
    wc.kilojoule AS whoop_kilojoule,
    wc.average_heart_rate AS whoop_cycle_avg_hr,
    wc.max_heart_rate AS whoop_cycle_max_hr,
    COALESCE(tx.any_transition, false) AS onyx_is_transition_day,
    wr.recovery_score AS whoop_recovery_score,
    wr.resting_heart_rate AS whoop_rhr,
    wr.hrv_rmssd_milli AS whoop_hrv_rmssd,
    wr.spo2_percentage AS whoop_spo2,
    wr.skin_temp_celsius AS whoop_skin_temp,
    ws.total_in_bed_time_milli AS whoop_sleep_duration_milli,
    ws.sleep_performance_percentage AS whoop_sleep_performance,
    ws.sleep_efficiency_percentage AS whoop_sleep_efficiency,
    ws.sleep_consistency_percentage AS whoop_sleep_consistency,
    ws.total_slow_wave_sleep_time_milli AS whoop_deep_sleep_milli,
    ws.total_rem_sleep_time_milli AS whoop_rem_sleep_milli,
    ws.total_light_sleep_time_milli AS whoop_light_sleep_milli,
    ws.total_awake_time_milli AS whoop_awake_milli,
    ws.disturbance_count AS whoop_disturbances,
    ws.respiratory_rate AS whoop_respiratory_rate,
    wkts.whoop_workout_count,
    wkts.whoop_workout_strain,
    wkts.whoop_zone2_milli,
    es.sleep_score AS eight_sleep_score,
    es.sleep_fitness_score AS eight_sleep_fitness_score,
    es.avg_hrv AS eight_sleep_hrv,
    es.avg_heart_rate AS eight_sleep_hr,
    es.avg_breath_rate AS eight_sleep_breath_rate,
    es.median_bed_temp AS eight_sleep_bed_temp,
    es.median_room_temp AS eight_sleep_room_temp,
    -- Nap-inclusive totals (existing — match the Eight Sleep app's daily display)
    es.time_slept_seconds AS eight_sleep_duration_sec,
    es.deep_sleep_seconds AS eight_sleep_deep_sec,
    es.rem_sleep_seconds AS eight_sleep_rem_sec,
    -- Main-session-only durations (new — apples-to-apples partner for WHOOP
    -- main-only sleep on the Bland-Altman page and for any cross-device
    -- comparison that needs to exclude naps).
    es.time_slept_main_session_seconds AS eight_sleep_duration_main_sec,
    es.deep_sleep_main_session_seconds AS eight_sleep_deep_main_sec,
    es.light_sleep_main_session_seconds AS eight_sleep_light_main_sec,
    es.rem_sleep_main_session_seconds AS eight_sleep_rem_main_sec,
    es.awake_main_session_seconds AS eight_sleep_awake_main_sec,
    es.toss_and_turns AS eight_sleep_toss_turns,
    mfp.calories AS mfp_calories,
    mfp.protein_g AS mfp_protein_g,
    mfp.carbs_g AS mfp_carbs_g,
    mfp.fat_g AS mfp_fat_g,
    mfp.fiber_g AS mfp_fiber_g,
    mfp.sugar_g AS mfp_sugar_g,
    mfp.sodium_mg AS mfp_sodium_mg,
    mfp.water_ml AS mfp_water_ml,
    mfp.exercise_kcal AS mfp_exercise_kcal,
    mt.last_meal_hour AS meal_last_hour,
    mt.first_meal_hour AS meal_first_hour,
    mt.eating_window_hours AS meal_eating_window_hours,
    mt.meal_event_count,
    mt.last_meal_to_bedtime_minutes AS meal_last_meal_to_bedtime_min
FROM all_behavioral_dates s
LEFT JOIN pds.garmin_daily_summary gds ON gds.calendar_date = s.calendar_date
LEFT JOIN pds.garmin_stress gstr ON gstr.calendar_date = s.calendar_date
LEFT JOIN pds.garmin_heart_rate ghr ON ghr.calendar_date = s.calendar_date
LEFT JOIN pds.garmin_training_status gts ON gts.calendar_date = s.calendar_date
LEFT JOIN LATERAL (
    SELECT gs2.*
    FROM pds.garmin_sleep gs2
    WHERE gs2.onyx_behavioral_date = s.calendar_date
      AND gs2.is_nap = false AND gs2.sleep_id IS NOT NULL
    ORDER BY gs2.overall_sleep_score DESC NULLS LAST
    LIMIT 1
) gs ON true
LEFT JOIN LATERAL (
    SELECT ghrv2.*
    FROM pds.garmin_hrv ghrv2
    WHERE ghrv2.onyx_behavioral_date = s.calendar_date
    ORDER BY ghrv2.calendar_date DESC NULLS LAST
    LIMIT 1
) ghrv ON true
LEFT JOIN LATERAL (
    SELECT COUNT(*)::integer AS activity_count,
        SUM(ga.duration_seconds) AS activity_duration_sec,
        SUM(ga.distance_meters) AS activity_distance_m,
        SUM(ga.calories) AS activity_calories,
        SUM(ga.training_load) AS activity_training_load,
        MAX(ga.max_heart_rate) AS activity_max_hr,
        AVG(ga.avg_heart_rate) AS activity_avg_hr
    FROM pds.garmin_activities ga
    WHERE ga.onyx_behavioral_date = s.calendar_date
) acts ON true
LEFT JOIN LATERAL (
    SELECT wc2.*
    FROM pds.whoop_cycles wc2
    WHERE wc2.onyx_behavioral_date = s.calendar_date
    ORDER BY (wc2.end_time - wc2.start_time) DESC NULLS LAST, wc2.start_time DESC
    LIMIT 1
) wc ON true
LEFT JOIN LATERAL (
    SELECT BOOL_OR(wcx.onyx_is_transition_day) AS any_transition
    FROM pds.whoop_cycles wcx
    WHERE wcx.onyx_behavioral_date = s.calendar_date
) tx ON true
LEFT JOIN pds.whoop_recovery wr ON wr.cycle_id = wc.cycle_id AND wr.score_state = 'SCORED'
LEFT JOIN pds.whoop_sleep ws ON ws.cycle_id = wc.cycle_id AND ws.is_nap = false AND ws.score_state = 'SCORED'
LEFT JOIN LATERAL (
    SELECT COUNT(*)::integer AS whoop_workout_count,
        SUM(ww.strain) AS whoop_workout_strain,
        SUM(ww.zone_two_milli) AS whoop_zone2_milli
    FROM pds.whoop_workouts ww
    WHERE ww.onyx_behavioral_date = s.calendar_date
      AND ww.score_state = 'SCORED'
) wkts ON true
LEFT JOIN pds.eight_sleep_trends es ON es.onyx_behavioral_date = s.calendar_date
    AND es.bed_side = 'left'
LEFT JOIN pds.myfitnesspal_nutrition mfp ON mfp.onyx_behavioral_date = s.calendar_date
LEFT JOIN pds.meal_timing_daily mt ON mt.calendar_date = s.calendar_date
ORDER BY s.calendar_date DESC;

GRANT SELECT ON pds.daily_health_matrix_behavioral TO anon, authenticated;
