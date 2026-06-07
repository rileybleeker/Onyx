-- =============================================================================
-- daily_health_matrix_behavioral: behavioral-spine matrix with main-only sleep
-- =============================================================================
-- Closes Notion roadmap "Bland-Altman: switch to main-only columns for
-- apples-to-apples cross-device comparisons" (page 369bf5b4-4bf2-8149-803f-d81ff6b9f417).
--
-- Production state captured 2026-05-27. Source-prefixed columns (audit P1 G4),
-- per-behavioral-date helper views for Garmin sleep / Garmin HRV / WHOOP main
-- cycle (refactor from LATERAL subqueries), and main-only Eight Sleep
-- durations appended at the end so the /bland-altman page can pair WHOOP
-- main-only sleep against Eight Sleep main-only sleep symmetrically. WHOOP
-- main is already enforced via ws.is_nap = false; Garmin main is enforced via
-- pds.garmin_sleep_best_per_behavioral_date which picks one row per night by
-- overall_sleep_score DESC.
--
-- Migration history (latest first):
--   audit_re_2026_05_27_add_eight_sleep_main_cols — appended 5 _main_sec cols
--   audit_p1_g3_dhm_behavioral_drop_gds_spine     — (claimed) GDS out of UNION
--   audit_p1_g4_recovery_vs_pace_rename_hrv_column — renamed hrv_rmssd_milli
--
-- NOTE on garmin_daily_summary in the spine: audit P1 G3 was supposed to
-- remove GDS from the UNION (its calendar_date is watch-local and can drift
-- from onyx_behavioral_date on travel days). The committed file removed it
-- but the deployed view still includes it; the migration is pending. Per
-- ADR-0001 D5 the spine should be canonically behavioral.
-- =============================================================================

CREATE OR REPLACE VIEW pds.daily_health_matrix_behavioral AS
 WITH all_behavioral_dates AS (
         SELECT whoop_cycles.onyx_behavioral_date AS calendar_date
           FROM pds.whoop_cycles
          WHERE whoop_cycles.onyx_behavioral_date IS NOT NULL
        UNION
         SELECT garmin_activities.onyx_behavioral_date
           FROM pds.garmin_activities
          WHERE garmin_activities.onyx_behavioral_date IS NOT NULL
        UNION
         SELECT garmin_sleep.onyx_behavioral_date
           FROM pds.garmin_sleep
          WHERE garmin_sleep.onyx_behavioral_date IS NOT NULL
        UNION
         SELECT garmin_hrv.onyx_behavioral_date
           FROM pds.garmin_hrv
          WHERE garmin_hrv.onyx_behavioral_date IS NOT NULL
        UNION
         SELECT eight_sleep_trends.onyx_behavioral_date
           FROM pds.eight_sleep_trends
          WHERE eight_sleep_trends.onyx_behavioral_date IS NOT NULL
        UNION
         SELECT myfitnesspal_nutrition.onyx_behavioral_date
           FROM pds.myfitnesspal_nutrition
          WHERE myfitnesspal_nutrition.onyx_behavioral_date IS NOT NULL
        UNION
         SELECT meal_events.onyx_behavioral_date
           FROM pds.meal_events
          WHERE meal_events.onyx_behavioral_date IS NOT NULL
        UNION
         SELECT supplement_intake.onyx_behavioral_date
           FROM pds.supplement_intake
          WHERE supplement_intake.onyx_behavioral_date IS NOT NULL
        UNION
         SELECT garmin_daily_summary.calendar_date
           FROM pds.garmin_daily_summary
          WHERE garmin_daily_summary.calendar_date IS NOT NULL
        )
 SELECT s.calendar_date,
    s.calendar_date AS onyx_behavioral_date,
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
    es.time_slept_seconds AS eight_sleep_duration_sec,
    es.deep_sleep_seconds AS eight_sleep_deep_sec,
    es.rem_sleep_seconds AS eight_sleep_rem_sec,
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
    mt.last_meal_to_bedtime_minutes AS meal_last_meal_to_bedtime_min,
    -- Main-session-only Eight Sleep durations (added 2026-05-27 for /bland-altman
    -- apples-to-apples cross-device comparison; WHOOP filters is_nap=false above
    -- and Garmin uses garmin_sleep_best_per_behavioral_date which also restricts
    -- to main sleep, so these complete the symmetric main-only triplet).
    es.time_slept_main_session_seconds AS eight_sleep_duration_main_sec,
    es.deep_sleep_main_session_seconds AS eight_sleep_deep_main_sec,
    es.light_sleep_main_session_seconds AS eight_sleep_light_main_sec,
    es.rem_sleep_main_session_seconds AS eight_sleep_rem_main_sec,
    es.awake_main_session_seconds AS eight_sleep_awake_main_sec
   FROM all_behavioral_dates s
     LEFT JOIN pds.garmin_daily_summary gds ON gds.calendar_date = s.calendar_date
     LEFT JOIN pds.garmin_stress gstr ON gstr.calendar_date = s.calendar_date
     LEFT JOIN pds.garmin_heart_rate ghr ON ghr.calendar_date = s.calendar_date
     LEFT JOIN pds.garmin_training_status gts ON gts.calendar_date = s.calendar_date
     LEFT JOIN pds.garmin_sleep_best_per_behavioral_date gs ON gs.onyx_behavioral_date = s.calendar_date
     LEFT JOIN pds.garmin_hrv_latest_per_behavioral_date ghrv ON ghrv.onyx_behavioral_date = s.calendar_date
     LEFT JOIN pds.whoop_main_cycle_per_behavioral_date wc ON wc.onyx_behavioral_date = s.calendar_date
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS activity_count,
            sum(ga.duration_seconds) AS activity_duration_sec,
            sum(ga.distance_meters) AS activity_distance_m,
            sum(ga.calories) AS activity_calories,
            sum(ga.training_load) AS activity_training_load,
            max(ga.max_heart_rate) AS activity_max_hr,
            avg(ga.avg_heart_rate) AS activity_avg_hr
           FROM pds.garmin_activities ga
          WHERE ga.onyx_behavioral_date = s.calendar_date
            AND NOT ga.is_excluded) acts ON true
     LEFT JOIN LATERAL ( SELECT bool_or(wcx.onyx_is_transition_day) AS any_transition
           FROM pds.whoop_cycles wcx
          WHERE wcx.onyx_behavioral_date = s.calendar_date) tx ON true
     LEFT JOIN pds.whoop_recovery wr ON wr.cycle_id = wc.cycle_id AND wr.score_state = 'SCORED'::text
     LEFT JOIN pds.whoop_sleep ws ON ws.cycle_id = wc.cycle_id AND ws.is_nap = false AND ws.score_state = 'SCORED'::text
     LEFT JOIN LATERAL ( SELECT count(*)::integer AS whoop_workout_count,
            sum(ww.strain) AS whoop_workout_strain,
            sum(ww.zone_two_milli) AS whoop_zone2_milli
           FROM pds.whoop_workouts ww
          WHERE ww.onyx_behavioral_date = s.calendar_date AND ww.score_state = 'SCORED'::text
            AND NOT ww.is_excluded) wkts ON true
     LEFT JOIN pds.eight_sleep_trends es ON es.onyx_behavioral_date = s.calendar_date AND es.bed_side = 'left'::text
     LEFT JOIN pds.myfitnesspal_nutrition mfp ON mfp.onyx_behavioral_date = s.calendar_date
     LEFT JOIN pds.meal_timing_daily mt ON mt.calendar_date = s.calendar_date
  ORDER BY s.calendar_date DESC;

GRANT SELECT ON pds.daily_health_matrix_behavioral TO anon, authenticated;
