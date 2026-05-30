-- ============================================
-- Personal Data Scientist — Caffeine Timing Daily
-- ============================================
-- One row per behavioral day with caffeine intake timing features for the
-- HRV pipeline. Mirrors the meal_timing_daily pattern: clock-anchored hour
-- fields plus a bedtime-anchored gap that stays monotonic across midnight.
--
-- The raw timestamps already live in pds.supplement_intake.intake_time;
-- this view filters that to caffeine-containing intakes (via UNII or name
-- match in supplement_products.ingredients) and aggregates per behavioral
-- day. intake_date follows the behavioral-day convention (see CLAUDE.md
-- "Supplement intake" bullet) so it joins cleanly to onyx_behavioral_date.
--
-- Caffeine match rule:
--   - FDA UNII 3G6A5W338E (canonical caffeine), OR
--   - ingredient_group or name ILIKE '%caffeine%'
-- The UNII catches caffeine in proprietary blends that may not have a
-- clean ingredient_group label; the ILIKE catches products seeded before
-- DSLD populated UNII for that ingredient.
--
-- Why bedtime-anchored: caffeine_last_hour wraps at midnight (a 12:30 AM
-- pre-bed dose numerically reads as 0.5, not 24.5), inverting the
-- "later caffeine = worse HRV" relationship. caffeine_to_bedtime_min is
-- the dose-to-bedtime gap measured against the WHOOP cycle that closes
-- the behavioral day — monotonic in physiological lateness, identical
-- semantics to last_meal_to_bedtime_minutes.
-- ============================================

DROP VIEW IF EXISTS pds.caffeine_timing_daily CASCADE;
CREATE VIEW pds.caffeine_timing_daily AS
WITH caffeine_intakes AS (
    SELECT DISTINCT
        i.intake_id,
        i.intake_date,
        i.intake_time
    FROM pds.supplement_intake i
    JOIN pds.supplement_products p ON p.product_id = i.product_id
    CROSS JOIN LATERAL jsonb_array_elements(p.ingredients) ing
    WHERE i.intake_time IS NOT NULL
      AND (
          ing->>'unii_code' = '3G6A5W338E'
          OR ing->>'ingredient_group' ILIKE '%caffeine%'
          OR ing->>'name' ILIKE '%caffeine%'
      )
),
agg AS (
    SELECT
        intake_date AS calendar_date,
        MIN(intake_time) AS first_caffeine_time,
        MAX(intake_time) AS last_caffeine_time,
        EXTRACT(
            EPOCH FROM (MIN(intake_time) AT TIME ZONE 'America/New_York')
            - DATE_TRUNC('day', MIN(intake_time) AT TIME ZONE 'America/New_York')
        ) / 3600.0 AS first_caffeine_hour,
        EXTRACT(
            EPOCH FROM (MAX(intake_time) AT TIME ZONE 'America/New_York')
            - DATE_TRUNC('day', MAX(intake_time) AT TIME ZONE 'America/New_York')
        ) / 3600.0 AS last_caffeine_hour,
        CASE
            WHEN COUNT(*) > 1 THEN
                EXTRACT(EPOCH FROM (MAX(intake_time) - MIN(intake_time))) / 3600.0
            ELSE NULL
        END AS caffeine_window_hours,
        COUNT(*) AS caffeine_intake_count
    FROM caffeine_intakes
    GROUP BY intake_date
)
SELECT
    agg.calendar_date,
    agg.first_caffeine_time,
    agg.last_caffeine_time,
    agg.first_caffeine_hour,
    agg.last_caffeine_hour,
    agg.caffeine_window_hours,
    agg.caffeine_intake_count,
    ws.start_time AS sleep_start_time,
    CASE
        WHEN ws.start_time IS NOT NULL AND agg.last_caffeine_time IS NOT NULL THEN
            EXTRACT(EPOCH FROM (ws.start_time - agg.last_caffeine_time)) / 60.0
        ELSE NULL
    END AS last_caffeine_to_bedtime_minutes
FROM agg
-- Same WHOOP-cycle join as meal_timing_daily: the cycle closing behavioral
-- day N is tagged to N+1 via (start_time + 12h) AT NY ::date.
LEFT JOIN pds.whoop_cycles wc
    ON ((wc.start_time + INTERVAL '12 hours') AT TIME ZONE 'America/New_York')::date
       = (agg.calendar_date + INTERVAL '1 day')::date
LEFT JOIN pds.whoop_sleep ws
    ON ws.cycle_id = wc.cycle_id
   AND ws.is_nap = false
   AND ws.score_state = 'SCORED'
ORDER BY agg.calendar_date DESC;

GRANT SELECT ON pds.caffeine_timing_daily TO anon, authenticated;

COMMENT ON VIEW pds.caffeine_timing_daily IS
'One row per behavioral day (ET) with caffeine intake timing features. Filters pds.supplement_intake by caffeine UNII (3G6A5W338E) or ingredient_group/name ILIKE caffeine. Exposes clock-anchored first/last hours plus the bedtime-anchored last_caffeine_to_bedtime_minutes (monotonic in physiological lateness, joined via the standard +12h ET cycle rule). Joined into pds.daily_health_matrix and pds.daily_health_matrix_behavioral. Only intakes with non-null intake_time count — caffeine logged without a timestamp does not appear here (would corrupt the timing aggregate).';
