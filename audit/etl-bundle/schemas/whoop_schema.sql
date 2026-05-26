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
-- 6. WHOOP Journal Entries (from CSV export — one row per behavior per day)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.whoop_journal (
    cycle_date      DATE NOT NULL,              -- date bedtime BEGAN in WHOOP local TZ (what WHOOP exports)
    behaviors_date  DATE,                       -- calendar day the answer DESCRIBES (auto-computed by trigger; differs from cycle_date for post-midnight bedtimes)
    question        TEXT NOT NULL,              -- behavior name (e.g., "Caffeine", "Melatonin")
    category        TEXT,                       -- e.g., Supplements, Lifestyle, Nutrition
    answer          TEXT,                       -- "Yes"/"No", quantity, time, or free text
    notes           TEXT,                       -- optional user notes

    synced_at       TIMESTAMPTZ DEFAULT NOW(),

    PRIMARY KEY (cycle_date, question)
);

CREATE INDEX IF NOT EXISTS idx_whoop_journal_date ON pds.whoop_journal (cycle_date);
CREATE INDEX IF NOT EXISTS idx_whoop_journal_behaviors_date ON pds.whoop_journal (behaviors_date);
CREATE INDEX IF NOT EXISTS idx_whoop_journal_category ON pds.whoop_journal (category);

-- behaviors_date trigger: WHOOP's CSV cycle_date is the date bedtime began in
-- WHOOP's local TZ. For post-midnight bedtimes that's one calendar day AFTER
-- the behaviors-day the journal answer describes. behaviors_date is computed
-- as (start_time − 6h) in the cycle's local TZ — equals cycle_date for
-- pre-midnight bedtimes, cycle_date − 1 for post-midnight bedtimes.
CREATE OR REPLACE FUNCTION pds.compute_journal_behaviors_date()
RETURNS TRIGGER AS $$
BEGIN
  SELECT (((c.start_time AT TIME ZONE 'UTC') + (c.timezone_offset)::interval - INTERVAL '6 hours'))::date
    INTO NEW.behaviors_date
  FROM pds.whoop_cycles c
  WHERE (((c.start_time AT TIME ZONE 'UTC') + (c.timezone_offset)::interval))::date = NEW.cycle_date
  ORDER BY c.start_time
  LIMIT 1;
  IF NEW.behaviors_date IS NULL THEN
    NEW.behaviors_date := NEW.cycle_date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_behaviors_date_trigger ON pds.whoop_journal;
CREATE TRIGGER journal_behaviors_date_trigger
  BEFORE INSERT OR UPDATE OF cycle_date ON pds.whoop_journal
  FOR EACH ROW EXECUTE FUNCTION pds.compute_journal_behaviors_date();

-- Companion trigger: backfill behaviors_date on journal rows when a matching
-- whoop_cycle arrives or its start_time changes (handles journal-imported-
-- before-cycle ordering).
CREATE OR REPLACE FUNCTION pds.refresh_journal_behaviors_dates_for_cycle()
RETURNS TRIGGER AS $$
DECLARE
  cycle_bedtime_date DATE;
  new_behaviors DATE;
BEGIN
  cycle_bedtime_date := (((NEW.start_time AT TIME ZONE 'UTC') + (NEW.timezone_offset)::interval))::date;
  new_behaviors      := (((NEW.start_time AT TIME ZONE 'UTC') + (NEW.timezone_offset)::interval - INTERVAL '6 hours'))::date;
  UPDATE pds.whoop_journal
     SET behaviors_date = new_behaviors
   WHERE cycle_date = cycle_bedtime_date
     AND (behaviors_date IS NULL OR behaviors_date <> new_behaviors);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cycle_refresh_journal_behaviors_trigger ON pds.whoop_cycles;
CREATE TRIGGER cycle_refresh_journal_behaviors_trigger
  AFTER INSERT OR UPDATE OF start_time, timezone_offset ON pds.whoop_cycles
  FOR EACH ROW EXECUTE FUNCTION pds.refresh_journal_behaviors_dates_for_cycle();

-- ---------------------------------------------------------------------------
-- Enable RLS on all WHOOP tables
-- ---------------------------------------------------------------------------
ALTER TABLE pds.whoop_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_sleep ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_workouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_body_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_journal ENABLE ROW LEVEL SECURITY;

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
    -- Hours vs Needed (WHOOP "Sleep Sufficiency"): asleep_time / sleep_needed
    -- asleep = in_bed − awake − no_data
    -- need   = baseline + debt + strain + nap   (NOTE: WHOOP's API returns
    --         need_from_recent_nap_milli as a SIGNED value — negative when a
    --         recent nap credits toward tonight's need. ADD it directly; the
    --         prior `- need_from_recent_nap_milli` formulation inverted the
    --         credit and inflated the denominator on nap-heavy days.)
    CASE
        WHEN ws.total_in_bed_time_milli IS NULL THEN NULL
        ELSE ws.total_in_bed_time_milli
             - COALESCE(ws.total_awake_time_milli, 0)
             - COALESCE(ws.total_no_data_time_milli, 0)
    END AS whoop_asleep_milli,
    CASE
        WHEN ws.baseline_milli IS NULL THEN NULL
        ELSE ws.baseline_milli
             + COALESCE(ws.need_from_sleep_debt_milli, 0)
             + COALESCE(ws.need_from_recent_strain_milli, 0)
             + COALESCE(ws.need_from_recent_nap_milli, 0)
    END AS whoop_sleep_need_milli,
    CASE
        WHEN ws.total_in_bed_time_milli IS NULL OR ws.baseline_milli IS NULL THEN NULL
        ELSE ROUND(
            100.0 * (
                ws.total_in_bed_time_milli
                - COALESCE(ws.total_awake_time_milli, 0)
                - COALESCE(ws.total_no_data_time_milli, 0)
            )::numeric
            / NULLIF(
                ws.baseline_milli
                + COALESCE(ws.need_from_sleep_debt_milli, 0)
                + COALESCE(ws.need_from_recent_strain_milli, 0)
                + COALESCE(ws.need_from_recent_nap_milli, 0),
                0
            ),
            1
        )
    END AS whoop_hours_vs_needed_pct,
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
