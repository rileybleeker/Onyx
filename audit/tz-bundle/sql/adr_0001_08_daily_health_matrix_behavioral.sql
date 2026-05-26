-- =============================================================================
-- ADR-0001 Phase 1, step 8 — pds.daily_health_matrix_behavioral
-- =============================================================================
-- Per docs/adr/0001-timezone-and-behavioral-day-handling.md (D4 + D5).
--
-- Parallel join view to pds.daily_health_matrix. Same columns, but every
-- per-source join is keyed on onyx_behavioral_date instead of calendar_date
-- / +12h-ET cycle rule. This is the view Phase 2's HRV pipeline + Phase 3's
-- HRV/behavior consumers will read.
--
-- The existing pds.daily_health_matrix stays UNCHANGED — backward-compat
-- for existing consumers (MFP energy-balance, /status freshness, every
-- query in lib/queries.ts not yet migrated).
--
-- SPINE: union of every onyx_behavioral_date that any source has produced.
-- WHOOP cycle JOIN: deduplicated via LATERAL ... LIMIT 1 — on transition
--   days WHOOP can record an "arrival nap" + main cycle that both share the
--   same onyx_behavioral_date; pick the LONGEST as the main sleep.
-- onyx_is_transition_day: aggregated across ALL cycles on the day via
--   bool_or, so a transition shows even if the longest cycle wasn't the
--   transition one.
-- garmin_hrv JOIN: deduplicated via LATERAL too (defensive).
--
-- Depends on: every prior adr_0001_*.sql migration.
-- =============================================================================

DROP VIEW IF EXISTS pds.daily_health_matrix_behavioral;

CREATE VIEW pds.daily_health_matrix_behavioral AS
WITH all_behavioral_dates AS (
    SELECT onyx_behavioral_date AS calendar_date FROM pds.whoop_cycles
        WHERE onyx_behavioral_date IS NOT NULL
    UNION
    SELECT onyx_behavioral_date FROM pds.garmin_activities WHERE onyx_behavioral_date IS NOT NULL
    UNION
    SELECT onyx_behavioral_date FROM pds.garmin_sleep WHERE onyx_behavioral_date IS NOT NULL
    UNION
    SELECT onyx_behavioral_date FROM pds.garmin_hrv WHERE onyx_behavioral_date IS NOT NULL
    UNION
    SELECT onyx_behavioral_date FROM pds.eight_sleep_trends WHERE onyx_behavioral_date IS NOT NULL
    UNION
    SELECT onyx_behavioral_date FROM pds.myfitnesspal_nutrition WHERE onyx_behavioral_date IS NOT NULL
    UNION
    SELECT onyx_behavioral_date FROM pds.meal_events WHERE onyx_behavioral_date IS NOT NULL
    UNION
    SELECT onyx_behavioral_date FROM pds.supplement_intake WHERE onyx_behavioral_date IS NOT NULL
    UNION
    SELECT calendar_date FROM pds.garmin_daily_summary WHERE calendar_date IS NOT NULL
)
SELECT
    s.calendar_date,
    s.calendar_date AS onyx_behavioral_date,
    s.calendar_date AS onyx_et_date,
    s.calendar_date AS onyx_local_date,

    -- Garmin Daily Summary
    gds.total_steps, gds.total_distance_meters, gds.floors_ascended, gds.floors_descended,
    gds.total_kilocalories, gds.active_kilocalories, gds.bmr_kilocalories,
    gds.resting_heart_rate AS garmin_rhr, gds.min_heart_rate AS garmin_min_hr,
    gds.max_heart_rate AS garmin_max_hr, gds.last_seven_days_avg_rhr AS garmin_7d_avg_rhr,
    gds.avg_stress_level, gds.max_stress_level,
    gds.rest_stress_duration_min, gds.low_stress_duration_min,
    gds.medium_stress_duration_min, gds.high_stress_duration_min, gds.stress_qualifier,
    gds.body_battery_highest, gds.body_battery_lowest, gds.body_battery_charged,
    gds.body_battery_drained, gds.body_battery_most_recent,
    gds.avg_spo2 AS garmin_spo2, gds.lowest_spo2 AS garmin_lowest_spo2,
    gds.avg_waking_respiration, gds.moderate_intensity_minutes,
    gds.vigorous_intensity_minutes, gds.highly_active_seconds, gds.active_seconds,
    gds.sedentary_seconds, gds.sleeping_seconds AS garmin_sleeping_seconds,

    -- Garmin Stress Buckets
    gstr.overall_stress_level AS garmin_stress_overall,
    gstr.rest_stress_duration_sec AS garmin_rest_stress_sec,
    gstr.low_stress_duration_sec AS garmin_low_stress_sec,
    gstr.medium_stress_duration_sec AS garmin_medium_stress_sec,
    gstr.high_stress_duration_sec AS garmin_high_stress_sec,

    -- Garmin Sleep (best non-nap per behavioral day)
    gs.overall_sleep_score AS garmin_sleep_score,
    gs.sleep_duration_seconds AS garmin_sleep_duration_sec,
    gs.deep_sleep_seconds AS garmin_deep_sleep_sec,
    gs.light_sleep_seconds AS garmin_light_sleep_sec,
    gs.rem_sleep_seconds AS garmin_rem_sleep_sec,
    gs.awake_seconds AS garmin_awake_sec,
    gs.avg_sleep_heart_rate AS garmin_sleep_hr,
    gs.avg_respiration_rate AS garmin_sleep_respiration,
    gs.avg_sleep_stress AS garmin_sleep_stress,

    -- Garmin HRV (most recent per behavioral day)
    ghrv.weekly_avg_ms AS garmin_hrv_weekly_avg,
    ghrv.last_night_avg_ms AS garmin_hrv_last_night,
    ghrv.last_night_5min_high_ms AS garmin_hrv_5min_high,
    ghrv.baseline_balanced_low_ms AS garmin_hrv_baseline_low,
    ghrv.baseline_balanced_upper_ms AS garmin_hrv_baseline_high,
    ghrv.hrv_status AS garmin_hrv_status,

    -- Garmin HR Zones
    ghr.zone_1_seconds AS garmin_hr_zone1_sec, ghr.zone_2_seconds AS garmin_hr_zone2_sec,
    ghr.zone_3_seconds AS garmin_hr_zone3_sec, ghr.zone_4_seconds AS garmin_hr_zone4_sec,
    ghr.zone_5_seconds AS garmin_hr_zone5_sec,

    -- Garmin Training Status
    gts.training_readiness_score, gts.training_readiness_level,
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

    -- Garmin Activities (aggregated)
    acts.activity_count AS garmin_activity_count,
    acts.activity_duration_sec AS garmin_activity_duration_sec,
    acts.activity_distance_m AS garmin_activity_distance_m,
    acts.activity_calories AS garmin_activity_calories,
    acts.activity_training_load AS garmin_activity_training_load,
    acts.activity_max_hr AS garmin_activity_max_hr,
    acts.activity_avg_hr AS garmin_activity_avg_hr,

    -- WHOOP Cycle (longest per behavioral day)
    wc.strain AS whoop_day_strain, wc.kilojoule AS whoop_kilojoule,
    wc.average_heart_rate AS whoop_cycle_avg_hr,
    wc.max_heart_rate AS whoop_cycle_max_hr,
    -- Transition flag: TRUE if ANY cycle on this behavioral day was a transition
    COALESCE(tx.any_transition, FALSE) AS onyx_is_transition_day,

    -- WHOOP Recovery (via picked cycle_id)
    wr.recovery_score AS whoop_recovery_score, wr.resting_heart_rate AS whoop_rhr,
    wr.hrv_rmssd_milli AS whoop_hrv_rmssd, wr.spo2_percentage AS whoop_spo2,
    wr.skin_temp_celsius AS whoop_skin_temp,

    -- WHOOP Sleep (via picked cycle_id)
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

    -- WHOOP Workouts (aggregated)
    wkts.whoop_workout_count, wkts.whoop_workout_strain, wkts.whoop_zone2_milli,

    -- Eight Sleep
    es.sleep_score AS eight_sleep_score,
    es.sleep_fitness_score AS eight_sleep_fitness_score,
    es.avg_hrv AS eight_sleep_hrv, es.avg_heart_rate AS eight_sleep_hr,
    es.avg_breath_rate AS eight_sleep_breath_rate,
    es.median_bed_temp AS eight_sleep_bed_temp,
    es.median_room_temp AS eight_sleep_room_temp,
    es.time_slept_seconds AS eight_sleep_duration_sec,
    es.deep_sleep_seconds AS eight_sleep_deep_sec,
    es.rem_sleep_seconds AS eight_sleep_rem_sec,
    es.toss_and_turns AS eight_sleep_toss_turns,

    -- MyFitnessPal
    mfp.calories AS mfp_calories, mfp.protein_g AS mfp_protein_g,
    mfp.carbs_g AS mfp_carbs_g, mfp.fat_g AS mfp_fat_g,
    mfp.fiber_g AS mfp_fiber_g, mfp.sugar_g AS mfp_sugar_g,
    mfp.sodium_mg AS mfp_sodium_mg, mfp.water_ml AS mfp_water_ml,
    mfp.exercise_kcal AS mfp_exercise_kcal,

    -- Meal Timing
    mt.last_meal_hour AS meal_last_hour,
    mt.first_meal_hour AS meal_first_hour,
    mt.eating_window_hours AS meal_eating_window_hours,
    mt.meal_event_count AS meal_event_count,
    mt.last_meal_to_bedtime_minutes AS meal_last_meal_to_bedtime_min

FROM all_behavioral_dates s
LEFT JOIN pds.garmin_daily_summary gds ON gds.calendar_date = s.calendar_date
LEFT JOIN pds.garmin_stress        gstr ON gstr.calendar_date = s.calendar_date
LEFT JOIN pds.garmin_heart_rate    ghr  ON ghr.calendar_date  = s.calendar_date
LEFT JOIN pds.garmin_training_status gts ON gts.calendar_date = s.calendar_date

LEFT JOIN LATERAL (
    SELECT * FROM pds.garmin_sleep gs2
    WHERE gs2.onyx_behavioral_date = s.calendar_date
      AND gs2.is_nap = false AND gs2.sleep_id IS NOT NULL
    ORDER BY gs2.overall_sleep_score DESC NULLS LAST LIMIT 1
) gs ON true

LEFT JOIN LATERAL (
    SELECT * FROM pds.garmin_hrv ghrv2
    WHERE ghrv2.onyx_behavioral_date = s.calendar_date
    ORDER BY ghrv2.calendar_date DESC NULLS LAST LIMIT 1
) ghrv ON true

LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS activity_count,
        SUM(duration_seconds) AS activity_duration_sec,
        SUM(distance_meters) AS activity_distance_m,
        SUM(calories) AS activity_calories,
        SUM(training_load) AS activity_training_load,
        MAX(max_heart_rate) AS activity_max_hr,
        AVG(avg_heart_rate) AS activity_avg_hr
    FROM pds.garmin_activities ga
    WHERE ga.onyx_behavioral_date = s.calendar_date
) acts ON true

-- WHOOP cycle: pick the longest cycle as the "main" sleep for that day.
-- On transition days WHOOP records an "arrival nap" + main cycle that share
-- the same behavioral_date; the longer one is the real night sleep.
LEFT JOIN LATERAL (
    SELECT * FROM pds.whoop_cycles wc2
    WHERE wc2.onyx_behavioral_date = s.calendar_date
    ORDER BY (wc2.end_time - wc2.start_time) DESC NULLS LAST,
             wc2.start_time DESC
    LIMIT 1
) wc ON true

-- Aggregate any-transition flag across all cycles on the day (so transition
-- shows even if the longest cycle wasn't the transition one).
LEFT JOIN LATERAL (
    SELECT bool_or(onyx_is_transition_day) AS any_transition
    FROM pds.whoop_cycles wcx
    WHERE wcx.onyx_behavioral_date = s.calendar_date
) tx ON true

LEFT JOIN pds.whoop_recovery wr
    ON wr.cycle_id = wc.cycle_id AND wr.score_state = 'SCORED'
LEFT JOIN pds.whoop_sleep ws
    ON ws.cycle_id = wc.cycle_id AND ws.is_nap = false AND ws.score_state = 'SCORED'

LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS whoop_workout_count,
        SUM(strain) AS whoop_workout_strain,
        SUM(zone_two_milli) AS whoop_zone2_milli
    FROM pds.whoop_workouts ww
    WHERE ww.onyx_behavioral_date = s.calendar_date
      AND ww.score_state = 'SCORED'
) wkts ON true

LEFT JOIN pds.eight_sleep_trends es
    ON es.onyx_behavioral_date = s.calendar_date AND es.bed_side = 'left'
LEFT JOIN pds.myfitnesspal_nutrition mfp
    ON mfp.onyx_behavioral_date = s.calendar_date
LEFT JOIN pds.meal_timing_daily mt
    ON mt.calendar_date = s.calendar_date

ORDER BY s.calendar_date DESC;

GRANT SELECT ON pds.daily_health_matrix_behavioral TO anon, authenticated;

COMMENT ON VIEW pds.daily_health_matrix_behavioral IS
'Per ADR-0001 D4/D5: parallel join view to pds.daily_health_matrix. Spine is the union of every onyx_behavioral_date across all sources. Every per-source join is keyed on onyx_behavioral_date instead of calendar_date / +12h ET rule. WHOOP cycle deduplicated via LATERAL (picks longest cycle per behavioral day). onyx_is_transition_day aggregated via bool_or across all cycles on the day. Used by Phase 2 HRV pipeline and Phase 3 HRV/behavior consumers. The original pds.daily_health_matrix stays unchanged for backward-compat (MFP energy balance, /status freshness).';
