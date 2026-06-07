-- ============================================================
-- Personal Data Scientist — MyFitnessPal Schema
-- ============================================================
-- Deployed to Supabase (Postgres 17) in the pds schema.
-- Follows the pattern of eight_sleep_schema.sql.
-- ============================================================

-- -----------------------------------------------------------
-- 1. MyFitnessPal Nutrition (one row per day)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.myfitnesspal_nutrition (
    calendar_date  DATE           NOT NULL,

    -- Daily totals
    calories       INTEGER,                    -- kcal
    protein_g      NUMERIC(7,2),               -- grams
    carbs_g        NUMERIC(7,2),
    fat_g          NUMERIC(7,2),
    fiber_g        NUMERIC(7,2),
    sugar_g        NUMERIC(7,2),
    sodium_mg      NUMERIC(9,2),
    water_ml       NUMERIC(9,2),              -- converted from MFP cups × 236.588
    exercise_kcal  INTEGER,                    -- calories burned logged in MFP exercise log

    -- Per-meal breakdown (breakfast, lunch, dinner, snacks — null if no entries)
    -- Shape: { "breakfast": { calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg }, ... }
    meals_json     JSONB,

    raw_json       JSONB,
    synced_at      TIMESTAMPTZ DEFAULT NOW(),

    PRIMARY KEY (calendar_date)
);

CREATE INDEX IF NOT EXISTS idx_mfp_nutrition_date
    ON pds.myfitnesspal_nutrition (calendar_date);

-- -----------------------------------------------------------
-- 2. Row-Level Security
-- -----------------------------------------------------------
ALTER TABLE pds.myfitnesspal_nutrition ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read" ON pds.myfitnesspal_nutrition
    FOR SELECT TO anon USING (true);

GRANT SELECT ON pds.myfitnesspal_nutrition TO anon;

-- -----------------------------------------------------------
-- 3. Update daily_health_matrix to include key nutrition cols
-- -----------------------------------------------------------
DROP VIEW IF EXISTS pds.daily_health_matrix;

CREATE VIEW pds.daily_health_matrix AS
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
    gts.training_readiness_score,
    gts.training_readiness_level,
    -- MyFitnessPal nutrition (key macros for cross-source analysis)
    mfp.calories AS mfp_calories,
    mfp.protein_g AS mfp_protein_g,
    mfp.carbs_g AS mfp_carbs_g,
    mfp.fat_g AS mfp_fat_g
   FROM ((((((( pds.garmin_daily_summary gds
     LEFT JOIN LATERAL ( SELECT gs2.ts,
            gs2.calendar_date,
            gs2.sleep_id,
            gs2.sleep_start,
            gs2.sleep_end,
            gs2.sleep_duration_seconds,
            gs2.unmeasurable_seconds,
            gs2.deep_sleep_seconds,
            gs2.light_sleep_seconds,
            gs2.rem_sleep_seconds,
            gs2.awake_seconds,
            gs2.overall_sleep_score,
            gs2.quality_score,
            gs2.duration_score,
            gs2.recovery_score,
            gs2.rem_score,
            gs2.light_score,
            gs2.deep_score,
            gs2.restlessness_score,
            gs2.avg_sleep_heart_rate,
            gs2.avg_respiration_rate,
            gs2.avg_spo2,
            gs2.lowest_spo2,
            gs2.avg_hrv,
            gs2.hrv_status,
            gs2.avg_sleep_stress,
            gs2.sleep_need_seconds,
            gs2.sleep_debt_seconds,
            gs2.is_nap,
            gs2.auto_detected,
            gs2.sleep_result_type,
            gs2.source,
            gs2.raw_json,
            gs2.synced_at
           FROM pds.garmin_sleep gs2
          WHERE ((gs2.calendar_date = gds.calendar_date) AND (gs2.is_nap = false))
          ORDER BY gs2.overall_sleep_score DESC NULLS LAST
         LIMIT 1) gs ON (true))
     LEFT JOIN pds.garmin_training_status gts ON ((gds.calendar_date = gts.calendar_date)))
     LEFT JOIN pds.whoop_cycles wc ON ((gds.calendar_date = ((wc.start_time AT TIME ZONE 'UTC'::text))::date)))
     LEFT JOIN pds.whoop_recovery wr ON (((wc.cycle_id = wr.cycle_id) AND (wr.score_state = 'SCORED'::text))))
     LEFT JOIN pds.whoop_sleep ws ON (((wc.cycle_id = ws.cycle_id) AND (ws.is_nap = false) AND (ws.score_state = 'SCORED'::text))))
     LEFT JOIN pds.eight_sleep_trends es ON (((gds.calendar_date = es.calendar_date) AND (es.bed_side = 'left'::text))))
     LEFT JOIN pds.myfitnesspal_nutrition mfp ON (gds.calendar_date = mfp.calendar_date))
  ORDER BY gds.calendar_date DESC;
