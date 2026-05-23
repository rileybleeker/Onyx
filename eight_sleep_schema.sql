-- ============================================
-- Personal Data Scientist — Eight Sleep Schema
-- ============================================
-- Deployed to Supabase (Postgres 17) in the pds schema.
-- Matches the pattern established by garmin_schema_v3.sql and whoop_schema.sql.
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. Eight Sleep Trend Data (one row per night per bed side)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.eight_sleep_trends (
    calendar_date   DATE NOT NULL,
    bed_side        TEXT NOT NULL,              -- 'left' or 'right'

    -- Sleep scores
    sleep_score             INTEGER,            -- 0-100
    sleep_fitness_score     INTEGER,
    sleep_quality_score     INTEGER,
    sleep_duration_score    INTEGER,
    latency_asleep_score    INTEGER,
    latency_out_score       INTEGER,
    wakeup_consistency_score INTEGER,
    sleep_routine_score     INTEGER,

    -- Biometrics
    avg_heart_rate          NUMERIC(5,2),       -- bpm
    avg_hrv                 NUMERIC(8,4),       -- ms
    avg_breath_rate         NUMERIC(5,2),       -- breaths/min (per-night)

    -- Environment
    avg_bed_temp            NUMERIC(5,2),       -- °C or °F (as returned by API)
    avg_room_temp           NUMERIC(5,2),

    -- Sleep stages (seconds) — TOTAL across all sessions (main + naps).
    -- These match what the Eight Sleep app shows as the day's total sleep.
    -- Use for user-facing display.
    time_slept_seconds      INTEGER,
    awake_seconds           INTEGER,
    light_sleep_seconds     INTEGER,
    deep_sleep_seconds      INTEGER,
    rem_sleep_seconds       INTEGER,
    -- Sleep stages (seconds) — MAIN session only. WHOOP filters is_nap=false,
    -- so for any cross-device comparison (Bland-Altman, HRV pipeline joins)
    -- the symmetric Eight Sleep value to compare is main-session-only, not the
    -- nap-inclusive totals above. Computed from the session in raw_json.sessions[]
    -- whose `id` matches raw_json.mainSessionId.
    time_slept_main_session_seconds   INTEGER,
    awake_main_session_seconds        INTEGER,
    light_sleep_main_session_seconds  INTEGER,
    deep_sleep_main_session_seconds   INTEGER,
    rem_sleep_main_session_seconds    INTEGER,

    -- Other
    toss_and_turns          INTEGER,
    latency_asleep_seconds  INTEGER,            -- seconds from in-bed (presenceStart) to first sleep (sleepStart)
    snore_duration_seconds        INTEGER,      -- Pod microphone-detected snore time
    heavy_snore_duration_seconds  INTEGER,
    session_date            TEXT,               -- ISO date string from Eight Sleep

    raw_json    JSONB,
    synced_at   TIMESTAMPTZ DEFAULT NOW(),

    PRIMARY KEY (calendar_date, bed_side)
);

CREATE INDEX IF NOT EXISTS idx_eight_sleep_trends_date
    ON pds.eight_sleep_trends (calendar_date);

-- ---------------------------------------------------------------------------
-- 2. Enable RLS
-- ---------------------------------------------------------------------------
ALTER TABLE pds.eight_sleep_trends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read" ON pds.eight_sleep_trends
    FOR SELECT TO anon USING (true);

GRANT SELECT ON pds.eight_sleep_trends TO anon;

-- ---------------------------------------------------------------------------
-- 3. Update daily_health_matrix view to include Eight Sleep
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS pds.daily_health_matrix;
CREATE VIEW pds.daily_health_matrix AS
SELECT
    gds.calendar_date,
    -- Garmin daily wellness
    gds.total_steps,
    gds.total_kilocalories,
    gds.resting_heart_rate  AS garmin_rhr,
    gds.avg_stress_level,
    gds.max_stress_level,
    gds.body_battery_highest,
    gds.body_battery_lowest,
    gds.avg_spo2            AS garmin_spo2,
    gds.moderate_intensity_minutes,
    gds.vigorous_intensity_minutes,
    -- Garmin sleep (cross-validation)
    gs.overall_sleep_score  AS garmin_sleep_score,
    gs.sleep_duration_seconds AS garmin_sleep_duration_sec,
    gs.deep_sleep_seconds   AS garmin_deep_sleep_sec,
    gs.avg_hrv              AS garmin_hrv,
    -- WHOOP recovery (source of truth for RHR, HRV, SpO2)
    wr.recovery_score       AS whoop_recovery_score,
    wr.resting_heart_rate   AS whoop_rhr,
    wr.hrv_rmssd_milli      AS whoop_hrv_rmssd,
    wr.spo2_percentage      AS whoop_spo2,
    wr.skin_temp_celsius    AS whoop_skin_temp,
    -- WHOOP sleep (source of truth for all sleep metrics)
    ws.total_in_bed_time_milli      AS whoop_sleep_duration_milli,
    ws.sleep_performance_percentage AS whoop_sleep_performance,
    ws.sleep_efficiency_percentage  AS whoop_sleep_efficiency,
    ws.sleep_consistency_percentage AS whoop_sleep_consistency,
    ws.total_slow_wave_sleep_time_milli AS whoop_deep_sleep_milli,
    ws.total_rem_sleep_time_milli   AS whoop_rem_sleep_milli,
    ws.total_light_sleep_time_milli AS whoop_light_sleep_milli,
    ws.total_awake_time_milli       AS whoop_awake_milli,
    ws.disturbance_count    AS whoop_disturbances,
    ws.respiratory_rate     AS whoop_respiratory_rate,
    -- WHOOP strain
    wc.strain               AS whoop_day_strain,
    wc.kilojoule            AS whoop_kilojoule,
    -- Eight Sleep
    es.sleep_score          AS eight_sleep_score,
    es.sleep_fitness_score  AS eight_sleep_fitness_score,
    es.avg_hrv              AS eight_sleep_hrv,
    es.avg_heart_rate       AS eight_sleep_hr,
    es.avg_breath_rate      AS eight_sleep_breath_rate,
    es.avg_bed_temp         AS eight_sleep_bed_temp,
    es.avg_room_temp        AS eight_sleep_room_temp,
    es.time_slept_seconds   AS eight_sleep_duration_sec,
    es.deep_sleep_seconds   AS eight_sleep_deep_sec,
    es.rem_sleep_seconds    AS eight_sleep_rem_sec,
    es.toss_and_turns       AS eight_sleep_toss_turns,
    es.latency_asleep_seconds AS eight_sleep_latency_asleep_sec,
    -- Garmin training
    gts.training_readiness_score,
    gts.training_readiness_level
FROM pds.garmin_daily_summary gds
LEFT JOIN LATERAL (
    SELECT * FROM pds.garmin_sleep gs2
    WHERE gs2.calendar_date = gds.calendar_date AND gs2.is_nap = FALSE
    ORDER BY gs2.overall_sleep_score DESC NULLS LAST
    LIMIT 1
) gs ON true
LEFT JOIN pds.garmin_training_status gts
    ON gds.calendar_date = gts.calendar_date
-- WHOOP joins
LEFT JOIN pds.whoop_cycles wc
    ON gds.calendar_date = (wc.start_time AT TIME ZONE 'UTC')::DATE
LEFT JOIN pds.whoop_recovery wr
    ON wc.cycle_id = wr.cycle_id AND wr.score_state = 'SCORED'
LEFT JOIN pds.whoop_sleep ws
    ON wc.cycle_id = ws.cycle_id AND ws.is_nap = FALSE AND ws.score_state = 'SCORED'
-- Eight Sleep join (pick one side — defaults to 'left'; adjust if needed)
LEFT JOIN pds.eight_sleep_trends es
    ON gds.calendar_date = es.calendar_date AND es.bed_side = 'left'
ORDER BY gds.calendar_date DESC;
