-- ============================================
-- Personal Data Scientist — WHOOP Schema
-- ============================================
-- Deployed to Supabase (Postgres 17) in the pds schema.
-- Matches the pattern established by garmin_schema_v3.sql.
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. WHOOP Cycles (physiological day: sleep-wake-sleep)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.whoop_cycles (
    cycle_id        BIGINT NOT NULL,
    user_id         BIGINT,
    created_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ,
    start_time      TIMESTAMPTZ NOT NULL,
    end_time        TIMESTAMPTZ,              -- NULL if cycle is ongoing
    timezone_offset TEXT,
    score_state     TEXT,                      -- SCORED | PENDING_SCORE | UNSCORABLE

    -- CycleScore (only when score_state = 'SCORED')
    strain              NUMERIC(10,4),
    kilojoule           NUMERIC(12,4),
    average_heart_rate  INTEGER,
    max_heart_rate      INTEGER,

    raw_json    JSONB,
    synced_at   TIMESTAMPTZ DEFAULT NOW(),

    PRIMARY KEY (cycle_id)
);

CREATE INDEX IF NOT EXISTS idx_whoop_cycles_start ON pds.whoop_cycles (start_time);

-- ---------------------------------------------------------------------------
-- 2. WHOOP Recovery (source of truth for recovery & HRV)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.whoop_recovery (
    cycle_id        BIGINT NOT NULL,
    sleep_id        TEXT,                      -- UUID of associated sleep
    user_id         BIGINT,
    created_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ,
    score_state     TEXT,

    -- RecoveryScore
    recovery_score      INTEGER,              -- 0-100%
    resting_heart_rate  INTEGER,              -- bpm
    hrv_rmssd_milli     NUMERIC(10,4),        -- HRV in milliseconds (RMSSD)
    spo2_percentage     NUMERIC(5,2),         -- WHOOP 4.0+ only
    skin_temp_celsius   NUMERIC(5,2),         -- WHOOP 4.0+ only
    user_calibrating    BOOLEAN,

    raw_json    JSONB,
    synced_at   TIMESTAMPTZ DEFAULT NOW(),

    PRIMARY KEY (cycle_id)
);

CREATE INDEX IF NOT EXISTS idx_whoop_recovery_created ON pds.whoop_recovery (created_at);

-- ---------------------------------------------------------------------------
-- 3. WHOOP Sleep (source of truth for sleep scoring)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.whoop_sleep (
    sleep_id        TEXT NOT NULL,             -- UUID
    cycle_id        BIGINT,
    user_id         BIGINT,
    created_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ,
    start_time      TIMESTAMPTZ NOT NULL,
    end_time        TIMESTAMPTZ,
    timezone_offset TEXT,
    is_nap          BOOLEAN DEFAULT FALSE,
    score_state     TEXT,

    -- Stage summary (milliseconds)
    total_in_bed_time_milli         INTEGER,
    total_awake_time_milli          INTEGER,
    total_no_data_time_milli        INTEGER,
    total_light_sleep_time_milli    INTEGER,
    total_slow_wave_sleep_time_milli INTEGER,  -- deep sleep
    total_rem_sleep_time_milli      INTEGER,
    sleep_cycle_count               INTEGER,
    disturbance_count               INTEGER,

    -- Sleep need (milliseconds)
    baseline_milli                  INTEGER,
    need_from_sleep_debt_milli      INTEGER,
    need_from_recent_strain_milli   INTEGER,
    need_from_recent_nap_milli      INTEGER,

    -- Performance
    respiratory_rate                NUMERIC(5,2),
    sleep_performance_percentage    INTEGER,   -- 0-100
    sleep_consistency_percentage    INTEGER,   -- 0-100
    sleep_efficiency_percentage     NUMERIC(5,2),

    raw_json    JSONB,
    synced_at   TIMESTAMPTZ DEFAULT NOW(),

    PRIMARY KEY (sleep_id)
);

CREATE INDEX IF NOT EXISTS idx_whoop_sleep_start ON pds.whoop_sleep (start_time);
CREATE INDEX IF NOT EXISTS idx_whoop_sleep_cycle ON pds.whoop_sleep (cycle_id);

-- ---------------------------------------------------------------------------
-- 4. WHOOP Workouts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.whoop_workouts (
    workout_id      TEXT NOT NULL,             -- UUID
    user_id         BIGINT,
    created_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ,
    start_time      TIMESTAMPTZ NOT NULL,
    end_time        TIMESTAMPTZ,
    timezone_offset TEXT,
    sport_id        INTEGER,
    sport_name      TEXT,
    score_state     TEXT,

    -- WorkoutScore
    strain              NUMERIC(10,4),
    average_heart_rate  INTEGER,
    max_heart_rate      INTEGER,
    kilojoule           NUMERIC(12,4),
    percent_recorded    INTEGER,
    distance_meter      NUMERIC(12,4),
    altitude_gain_meter NUMERIC(10,4),
    altitude_change_meter NUMERIC(10,4),

    -- HR zone durations (milliseconds)
    zone_zero_milli     INTEGER,
    zone_one_milli      INTEGER,
    zone_two_milli      INTEGER,
    zone_three_milli    INTEGER,
    zone_four_milli     INTEGER,
    zone_five_milli     INTEGER,

    raw_json    JSONB,
    synced_at   TIMESTAMPTZ DEFAULT NOW(),

    PRIMARY KEY (workout_id)
);

CREATE INDEX IF NOT EXISTS idx_whoop_workouts_start ON pds.whoop_workouts (start_time);

-- ---------------------------------------------------------------------------
-- 5. WHOOP Body Measurements (tracked over time)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.whoop_body_measurements (
    measured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    height_meter    NUMERIC(5,3),
    weight_kilogram NUMERIC(6,3),
    max_heart_rate  INTEGER,

    raw_json    JSONB,
    synced_at   TIMESTAMPTZ DEFAULT NOW(),

    PRIMARY KEY (measured_at)
);

-- ---------------------------------------------------------------------------
-- Enable RLS on all WHOOP tables
-- ---------------------------------------------------------------------------
ALTER TABLE pds.whoop_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_sleep ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_workouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_body_measurements ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Update daily_health_matrix to pull HRV/recovery from WHOOP
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW pds.daily_health_matrix AS
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
    -- Garmin training
    gts.training_readiness_score,
    gts.training_readiness_level
FROM pds.garmin_daily_summary gds
LEFT JOIN pds.garmin_sleep gs
    ON gds.calendar_date = gs.calendar_date AND gs.is_nap = FALSE
LEFT JOIN pds.garmin_training_status gts
    ON gds.calendar_date = gts.calendar_date
-- Join WHOOP by matching cycle start date to calendar_date
LEFT JOIN pds.whoop_cycles wc
    ON gds.calendar_date = (wc.start_time AT TIME ZONE 'UTC')::DATE
LEFT JOIN pds.whoop_recovery wr
    ON wc.cycle_id = wr.cycle_id AND wr.score_state = 'SCORED'
LEFT JOIN pds.whoop_sleep ws
    ON wc.cycle_id = ws.cycle_id AND ws.is_nap = FALSE AND ws.score_state = 'SCORED'
ORDER BY gds.calendar_date DESC;
