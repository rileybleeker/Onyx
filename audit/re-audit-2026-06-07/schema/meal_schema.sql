-- ============================================
-- Personal Data Scientist — Meal Events Schema
-- ============================================
-- Captures clock-instant meal timing events so HRV analysis can answer:
--   "Does the time I last ate affect my HRV?"
--
-- Deliberately separate from pds.myfitnesspal_nutrition. MFP carries
-- the *macros side* (calories, protein, carbs) at the daily-totals grain
-- with NO timestamps — its CSV export drops per-meal times. This table
-- carries the *timing side* at clock-instant grain with NO macros. The
-- two are joined at view-time (pds.meal_timing_daily) and again into
-- pds.daily_health_matrix.
--
-- Same behavioral-day convention as pds.supplement_intake — a meal
-- eaten at 12:05 AM ET *before bed* belongs to the previous behavioral
-- day, not the new clock date. See CLAUDE.md "Supplement intake" bullet
-- for the full reasoning; the same logic applies here because the
-- downstream HRV pipeline uses the same shift(-1) on the matrix.
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. meal_events (fact, one row per logged meal event)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.meal_events (
    event_id          BIGSERIAL PRIMARY KEY,
    event_date        DATE NOT NULL,                      -- behavioral day, ET
    event_time        TIMESTAMPTZ NOT NULL,               -- truthful clock instant
    kind              TEXT NOT NULL DEFAULT 'last_meal',  -- last_meal | first_meal | snack | other
    notes             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meal_events_date
    ON pds.meal_events (event_date DESC);
CREATE INDEX IF NOT EXISTS idx_meal_events_kind_date
    ON pds.meal_events (kind, event_date DESC);

-- Touch updated_at on every row change so the /status page can show
-- "last edited" if we ever want it. Same pattern as other pds tables.
CREATE OR REPLACE FUNCTION pds.touch_meal_events_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_meal_events_updated_at ON pds.meal_events;
CREATE TRIGGER trg_meal_events_updated_at
    BEFORE UPDATE ON pds.meal_events
    FOR EACH ROW EXECUTE FUNCTION pds.touch_meal_events_updated_at();

-- ---------------------------------------------------------------------------
-- 2. meal_timing_daily (view — one row per ET behavioral date)
-- ---------------------------------------------------------------------------
-- Aggregates raw events into per-day timing features, then joins WHOOP sleep
-- on the cycle that closes the behavioral day (the bedtime immediately
-- following the last meal):
--   last_meal_time                 — clock instant of the last meal event that day
--   last_meal_hour                 — ET hour as float (0-23.99); 19.75 = 7:45 PM
--   first_meal_time                — clock instant of the earliest event that day
--   first_meal_hour                — ET hour as float
--   eating_window_hours            — last - first, NULL when only one event
--   meal_event_count               — total events logged for the day
--   last_meal_kind                 — kind of the last event (usually 'last_meal')
--   sleep_start_time               — start_time of the WHOOP cycle that closes day N
--                                    (cycle tagged to N+1 via the +12h ET rule)
--   last_meal_to_bedtime_minutes   — bedtime-anchored gap (sidesteps clock
--                                    wraparound: a 1:30 AM meal + 1:35 AM
--                                    bedtime = 5 minutes, not -19 hours).
--                                    NULL when either side is missing.
--
-- Why anchor to bedtime, not to clock-of-day: `last_meal_hour` numerically
-- wraps at midnight (0.083 < 19.75) which would invert the "later meal =
-- worse HRV" relationship for post-midnight meals. `last_meal_to_bedtime_
-- minutes` is monotonic in physiological lateness and the actual signal
-- the HRV pipeline reads.
--
-- All hour fields are computed in ET so they're comparable across DST.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS pds.meal_timing_daily CASCADE;
CREATE VIEW pds.meal_timing_daily AS
WITH ranked AS (
    SELECT
        event_date,
        event_time,
        kind,
        ROW_NUMBER() OVER (PARTITION BY event_date ORDER BY event_time DESC) AS rn_last,
        ROW_NUMBER() OVER (PARTITION BY event_date ORDER BY event_time ASC)  AS rn_first
    FROM pds.meal_events
),
agg AS (
    SELECT
        event_date AS calendar_date,
        MAX(event_time) FILTER (WHERE rn_last = 1)  AS last_meal_time,
        MIN(event_time) FILTER (WHERE rn_first = 1) AS first_meal_time,
        EXTRACT(
            EPOCH FROM (MAX(event_time) FILTER (WHERE rn_last = 1)  AT TIME ZONE 'America/New_York')
            - DATE_TRUNC('day', MAX(event_time) FILTER (WHERE rn_last = 1) AT TIME ZONE 'America/New_York')
        ) / 3600.0 AS last_meal_hour,
        EXTRACT(
            EPOCH FROM (MIN(event_time) FILTER (WHERE rn_first = 1) AT TIME ZONE 'America/New_York')
            - DATE_TRUNC('day', MIN(event_time) FILTER (WHERE rn_first = 1) AT TIME ZONE 'America/New_York')
        ) / 3600.0 AS first_meal_hour,
        CASE
            WHEN COUNT(*) > 1 THEN
                EXTRACT(EPOCH FROM (MAX(event_time) - MIN(event_time))) / 3600.0
            ELSE NULL
        END AS eating_window_hours,
        COUNT(*) AS meal_event_count,
        MAX(kind) FILTER (WHERE rn_last = 1) AS last_meal_kind
    FROM ranked
    GROUP BY event_date
)
SELECT
    agg.calendar_date,
    agg.last_meal_time,
    agg.first_meal_time,
    agg.last_meal_hour,
    agg.first_meal_hour,
    agg.eating_window_hours,
    agg.meal_event_count,
    agg.last_meal_kind,
    ws.start_time AS sleep_start_time,
    CASE
        WHEN ws.start_time IS NOT NULL AND agg.last_meal_time IS NOT NULL THEN
            EXTRACT(EPOCH FROM (ws.start_time - agg.last_meal_time)) / 60.0
        ELSE NULL
    END AS last_meal_to_bedtime_minutes
FROM agg
-- The WHOOP cycle closing behavioral day N is tagged to N+1 (the wake day)
-- via the codebase's `(start_time + 12h) AT NY ::date` rule. So we join
-- on (agg.calendar_date + 1).
LEFT JOIN pds.whoop_cycles wc
    ON ((wc.start_time + INTERVAL '12 hours') AT TIME ZONE 'America/New_York')::date
       = (agg.calendar_date + INTERVAL '1 day')::date
LEFT JOIN pds.whoop_sleep ws
    ON ws.cycle_id = wc.cycle_id
   AND ws.is_nap = false
   AND ws.score_state = 'SCORED'
ORDER BY agg.calendar_date DESC;

-- ---------------------------------------------------------------------------
-- 3. RLS + grants
-- ---------------------------------------------------------------------------
ALTER TABLE pds.meal_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON pds.meal_events;
CREATE POLICY "anon_read" ON pds.meal_events FOR SELECT TO anon USING (true);

GRANT SELECT ON pds.meal_events      TO anon;
GRANT SELECT ON pds.meal_timing_daily TO anon;
