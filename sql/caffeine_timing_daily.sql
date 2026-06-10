-- ============================================
-- Personal Data Scientist — Unified Caffeine Layer
-- ============================================
-- Two views, applied via Supabase migration `caffeine_unified_events_and_timing`
-- (2026-06-09). Replaces the original supplement-only caffeine_timing_daily.
--
-- 1) pds.caffeine_events — one row per caffeine-containing event from BOTH
--    channels:
--      - supplement: pds.supplement_intake × caffeine-bearing ingredients
--        (FDA UNII 3G6A5W338E, or ingredient_group/name ILIKE '%caffeine%').
--        caffeine_mg = SUM(ingredient quantity × doses), unit-normalized
--        (g ×1000, mcg/µg ÷1000, mg passthrough).
--      - dietary: pds.cronometer_servings rows with caffeine_mg > 0 (coffee,
--        espresso, tea, chocolate…). event_time is the Cronometer Gold
--        per-entry timestamp (NULL on pre-Gold or batch-logged rows).
--    Both channels key on the BEHAVIORAL day (supplement intake_date /
--    cronometer onyx_behavioral_date) per the ADR-0001 convention.
--
--    time_trusted — the timestamp QUALITY GATE. An event's clock instant is
--    only used for timing aggregates when its own behavioral attribution
--    (((event_time AT local tz) − 6h)::date via pds.tz_for_instant) matches
--    the claimed behavioral day. This neutralizes the retro-log artifact:
--    the /supplements date-override keeps intake_time = "now", so a dose
--    logged a day late carries a timestamp that lands AFTER that night's
--    sleep start (two such rows existed as of 2026-06-09, producing
--    -1285/-1119 min "to-bedtime" gaps). Untrusted events still count
--    toward mg totals and caffeine_intake_count — only their timestamps
--    are quarantined.
--
-- 2) pds.caffeine_timing_daily — one row per behavioral day. CREATE OR
--    REPLACE keeps the original 9 columns in place (the matrix view joins
--    them by position-stable names) and APPENDS the unified mg columns:
--      total_caffeine_mg / dietary_caffeine_mg / supplement_caffeine_mg —
--        sum over ALL events (timestamped or not).
--      caffeine_mg_at_bedtime — pharmacokinetic load proxy: Σ mg × 0.5^(Δt/5h)
--        over timed events, where Δt = sleep_start − event_time (clamped at
--        0). 5h half-life is the adult population midpoint (range ~4-6h);
--        treat as a relative, not absolute, measure. NULL unless EVERY event
--        that day has a trusted timestamp — partial timing would silently
--        under-count the dose-weighted sum. First/last-hour and window keep
--        the trusted SUBSET (best-known timing), documented trade-off.
--      timed_event_count — events that passed the trust gate (QA signal).
--    SEMANTIC CHANGE vs the original view: caffeine_intake_count now counts
--    ALL caffeine events from both channels (pills + caffeinated foods,
--    timestamped or not), not just timestamped supplement intakes.
--
--    Sleep join: pds.whoop_main_cycle_per_behavioral_date (the cycle that
--    STARTS at the bedtime closing behavioral day N) instead of the legacy
--    raw `+12h` formula — robust on travel days where device-timezone makes
--    onyx_et_date disagree with the +12h ET cast, and dedup-safe (MIN over
--    the main cycle's scored non-nap sleeps guarantees one row per day, so
--    the matrix LEFT JOIN can never fan out).
--
-- Matrix integration (migration `daily_health_matrix_behavioral_caffeine_unified`):
--    pds.daily_health_matrix_behavioral's existing caffeine_* timing columns
--    pick up the unified semantics automatically (same column names), and
--    four columns are appended at the tail: caffeine_total_mg,
--    caffeine_dietary_mg, caffeine_supplement_mg, caffeine_mg_at_bedtime.
--    See sql/caffeine_matrix_columns.sql.
-- ============================================

CREATE OR REPLACE VIEW pds.caffeine_events AS
SELECT
    'supplement'::text                          AS source,
    'supplement_intake:' || i.intake_id::text   AS event_key,
    i.intake_date                               AS behavioral_date,
    i.intake_time                               AS event_time,
    SUM(
        (ing->>'quantity')::numeric * i.doses *
        CASE lower(COALESCE(ing->>'unit', 'mg'))
            WHEN 'g'   THEN 1000
            WHEN 'mcg' THEN 0.001
            WHEN 'µg'  THEN 0.001
            WHEN 'ug'  THEN 0.001  -- DSLD sometimes emits the non-micro-sign form
            ELSE 1                 -- unknown units assumed mg (all live data is mg)
        END
    )                                           AS caffeine_mg,
    -- Trust rule caveat: a genuinely-timed post-sleep dose between midnight
    -- and 6 AM local logged for the new clock day (e.g. a 5 AM coffee after
    -- a full night's sleep) would map to the PREVIOUS behavioral day under
    -- the -6h rule and be quarantined here. No such event exists as of
    -- 2026-06-09 (all 8 untrusted events are true retro-logs); this is an
    -- ADR-0001 convention boundary, not a defect of this view.
    (i.intake_time IS NOT NULL
     AND ((i.intake_time AT TIME ZONE pds.tz_for_instant(i.intake_time))
          - INTERVAL '6 hours')::date = i.intake_date
    )                                           AS time_trusted
FROM pds.supplement_intake i
JOIN pds.supplement_products p ON p.product_id = i.product_id
CROSS JOIN LATERAL jsonb_array_elements(p.ingredients) ing
WHERE ((ing->>'unii_code') = '3G6A5W338E'
       OR (ing->>'ingredient_group') ILIKE '%caffeine%'
       OR (ing->>'name') ILIKE '%caffeine%')
  -- strict numeric: '1.2.3' would pass '^[0-9.]+$' and blow up the ::numeric
  -- cast at query time, taking the whole view (and matrix) down with it
  AND (ing->>'quantity') ~ '^[0-9]+(\.[0-9]+)?$'
GROUP BY i.intake_id, i.intake_date, i.intake_time

UNION ALL

SELECT
    'dietary'::text,
    'cronometer_serving:' || s.serving_id::text,
    COALESCE(s.onyx_behavioral_date, s.calendar_date),
    s.event_time,
    s.caffeine_mg,
    (s.event_time IS NOT NULL
     AND ((s.event_time AT TIME ZONE pds.tz_for_instant(s.event_time))
          - INTERVAL '6 hours')::date = COALESCE(s.onyx_behavioral_date, s.calendar_date))
FROM pds.cronometer_servings s
WHERE s.caffeine_mg IS NOT NULL AND s.caffeine_mg > 0;

GRANT SELECT ON pds.caffeine_events TO anon, authenticated;

COMMENT ON VIEW pds.caffeine_events IS
'One row per caffeine-containing event, unified across supplements (UNII 3G6A5W338E / ILIKE caffeine, mg = quantity x doses, unit-normalized) and Cronometer servings (caffeine_mg > 0). behavioral_date follows ADR-0001. time_trusted gates timestamps whose own behavioral attribution (via pds.tz_for_instant, -6h rule) disagrees with the claimed behavioral day (retro-log artifact); untrusted events keep their mg but are excluded from timing aggregates.';


CREATE OR REPLACE VIEW pds.caffeine_timing_daily AS
WITH sleep_per_day AS (
    -- The main cycle whose onyx_behavioral_date = N starts at the bedtime
    -- closing behavioral day N; its scored non-nap sleep is that night.
    -- MIN() guarantees one row per day (no matrix fan-out).
    SELECT wcm.onyx_behavioral_date AS behavioral_date,
           MIN(ws.start_time)       AS sleep_start_time
    FROM pds.whoop_main_cycle_per_behavioral_date wcm
    JOIN pds.whoop_sleep ws
      ON ws.cycle_id = wcm.cycle_id
     AND ws.is_nap = false
     AND ws.score_state = 'SCORED'
    GROUP BY wcm.onyx_behavioral_date
),
agg AS (
    SELECT
        e.behavioral_date,
        sp.sleep_start_time,
        MIN(e.event_time) FILTER (WHERE e.time_trusted) AS first_t,
        MAX(e.event_time) FILTER (WHERE e.time_trusted) AS last_t,
        COUNT(*) FILTER (WHERE e.time_trusted)          AS timed_n,
        COUNT(*)                                        AS event_n,
        SUM(e.caffeine_mg)                              AS total_mg,
        SUM(e.caffeine_mg) FILTER (WHERE e.source = 'dietary')    AS dietary_mg,
        SUM(e.caffeine_mg) FILTER (WHERE e.source = 'supplement') AS supplement_mg,
        -- residual caffeine at sleep onset: first-order decay, 5h half-life.
        -- Dose-weighted, so it is only honest when EVERY event that day has a
        -- trusted timestamp — a 654 mg day with one trusted 4 mg event would
        -- otherwise report "0.6 mg at bedtime". The all-trusted gate is
        -- applied in the outer SELECT (timed_n = event_n).
        SUM(e.caffeine_mg * POWER(0.5::numeric,
              GREATEST(EXTRACT(EPOCH FROM sp.sleep_start_time - e.event_time), 0)
              / 3600.0 / 5.0))
            FILTER (WHERE e.time_trusted AND sp.sleep_start_time IS NOT NULL)
                                                        AS mg_at_bedtime
    FROM pds.caffeine_events e
    LEFT JOIN sleep_per_day sp ON sp.behavioral_date = e.behavioral_date
    GROUP BY e.behavioral_date, sp.sleep_start_time
)
SELECT
    behavioral_date AS calendar_date,
    first_t         AS first_caffeine_time,
    last_t          AS last_caffeine_time,
    EXTRACT(EPOCH FROM (first_t AT TIME ZONE 'America/New_York')
            - DATE_TRUNC('day', first_t AT TIME ZONE 'America/New_York')) / 3600.0
                    AS first_caffeine_hour,
    EXTRACT(EPOCH FROM (last_t AT TIME ZONE 'America/New_York')
            - DATE_TRUNC('day', last_t AT TIME ZONE 'America/New_York')) / 3600.0
                    AS last_caffeine_hour,
    CASE WHEN timed_n > 1
         THEN EXTRACT(EPOCH FROM last_t - first_t) / 3600.0
    END             AS caffeine_window_hours,
    event_n         AS caffeine_intake_count,
    sleep_start_time,
    CASE WHEN sleep_start_time IS NOT NULL AND last_t IS NOT NULL
         THEN EXTRACT(EPOCH FROM sleep_start_time - last_t) / 60.0
    END             AS last_caffeine_to_bedtime_minutes,
    total_mg        AS total_caffeine_mg,
    dietary_mg      AS dietary_caffeine_mg,
    supplement_mg   AS supplement_caffeine_mg,
    CASE WHEN timed_n = event_n THEN mg_at_bedtime END
                    AS caffeine_mg_at_bedtime,
    timed_n         AS timed_event_count
FROM agg
ORDER BY behavioral_date DESC;

GRANT SELECT ON pds.caffeine_timing_daily TO anon, authenticated;

COMMENT ON VIEW pds.caffeine_timing_daily IS
'One row per behavioral day (ET) of unified caffeine: timing (first/last trusted-timestamp event, window, bedtime-anchored gap via the main WHOOP cycle closing the day) + mg totals across dietary (Cronometer servings) and supplement (UNII rollup) channels, + caffeine_mg_at_bedtime (5h half-life decay over trusted timed events). caffeine_intake_count counts ALL caffeine events (both channels, timestamped or not). Joined into pds.daily_health_matrix_behavioral.';
