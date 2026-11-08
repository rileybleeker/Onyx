-- Exact live definition of pds.daily_health_matrix at the time it was dropped
-- (2026-11-07, see sql/drop_legacy_daily_health_matrix.sql). Re-run this file
-- to restore it. Note the WHOOP join uses the UTC date of cycle start — the
-- travel-day attribution bug that motivated the drop.
CREATE OR REPLACE VIEW pds.daily_health_matrix AS
 SELECT gds.calendar_date,
    gds.total_steps,
    gds.total_kilocalories,
    gds.resting_heart_rate AS garmin_rhr,
    gds.avg_stress_level,
    gds.max_stress_level,
    gds.body_battery_highest,
    gds.body_battery_lowest,
    gds.avg_spo2 AS garmin_spo2,
    gds.moderate_intensity_minutes,
    gds.vigorous_intensity_minutes,
    gs.overall_sleep_score AS garmin_sleep_score,
    gs.sleep_duration_seconds AS garmin_sleep_duration_sec,
    gs.deep_sleep_seconds AS garmin_deep_sleep_sec,
    gs.avg_hrv AS garmin_hrv,
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
    wc.strain AS whoop_day_strain,
    wc.kilojoule AS whoop_kilojoule,
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
    es.latency_asleep_seconds AS eight_sleep_latency_asleep_sec,
    gts.training_readiness_score,
    gts.training_readiness_level
   FROM pds.garmin_daily_summary gds
     LEFT JOIN LATERAL ( SELECT gs2.*
           FROM pds.garmin_sleep gs2
          WHERE gs2.calendar_date = gds.calendar_date AND gs2.is_nap = false
          ORDER BY gs2.overall_sleep_score DESC NULLS LAST
         LIMIT 1) gs ON true
     LEFT JOIN pds.garmin_training_status gts ON gds.calendar_date = gts.calendar_date
     LEFT JOIN pds.whoop_cycles wc ON gds.calendar_date = (wc.start_time AT TIME ZONE 'UTC'::text)::date
     LEFT JOIN pds.whoop_recovery wr ON wc.cycle_id = wr.cycle_id AND wr.score_state = 'SCORED'::text
     LEFT JOIN pds.whoop_sleep ws ON wc.cycle_id = ws.cycle_id AND ws.is_nap = false AND ws.score_state = 'SCORED'::text
     LEFT JOIN pds.eight_sleep_trends es ON gds.calendar_date = es.calendar_date AND es.bed_side = 'left'::text
  ORDER BY gds.calendar_date DESC;

GRANT SELECT ON pds.daily_health_matrix TO anon, authenticated;
GRANT ALL ON pds.daily_health_matrix TO service_role;
