-- =============================================================================
-- pds.hrv_prediction_gaps — drift monitor for missing daily forecasts
-- =============================================================================
-- Closes Notion roadmap "Investigate 2026-05-01 HRV prediction gap"
-- (page 369bf5b4-4bf2-816a-b050-e2b1ade1ec3d). Root cause of THAT
-- specific gap: the HRV-prediction GitHub Actions workflow was blocked
-- from starting between 2026-04-29 19:31 UTC and 2026-05-01 00:43 UTC
-- because of an Actions billing-limit issue ("The job was not started
-- because recent account payments have failed"). Live xgboost / sarimax
-- / prophet rows for prediction_date 2026-04-30 + 2026-05-01 + 2026-05-02
-- never got written. Backtests later filled some baselines but not all.
--
-- Durable fix: a view that surfaces ANY missing-prediction day in the
-- last 30 days. The /status page reads this and degrades the HRV Analysis
-- card when gaps exist, so future workflow outages — billing, code bug,
-- upstream ETL crash, anything — get flagged immediately instead of
-- discovered six weeks later in a chart.
--
-- ⚠ Refreshed 2026-06-11 to match the LIVE definition, which had drifted
-- from this file (the perf round-3 audit caught it): production defines
-- "the daily job worked" via a 36-HOUR TIMELINESS GATE — min(created_at)
-- for the day's xgboost h=1 group must be within prediction_date + 36h —
-- instead of the older model_version NOT LIKE 'backtest%' filter. A
-- late backfill therefore still counts as a gap ('backfill_only'), which
-- is the intended semantics. If you re-apply this file, you get the same
-- behavior production has.
--
-- ⚠ MATVIEW DEPENDENT (perf round 3, 2026-06-11): /api/status reads
-- pds.hrv_prediction_gaps_mat (15-min pg_cron refresh via
-- pds.refresh_perf_matviews(), heartbeat source='perf_mats'). Any change
-- to THIS view must drop+recreate the matview (+ unique index on
-- expected_date + grants) in the same migration. Never DROP ... CASCADE.
-- See sql/perf_tier2_matviews.sql.
-- =============================================================================

CREATE OR REPLACE VIEW pds.hrv_prediction_gaps AS
WITH expected AS (
    SELECT generate_series(
        CURRENT_DATE - INTERVAL '30 days',
        CURRENT_DATE - INTERVAL '1 day',
        INTERVAL '1 day'
    )::date AS expected_date
),
xgb_live AS (
    -- "The daily job worked" = a live xgboost h=1 row landed within 36h of
    -- its prediction_date. Rows written later (backtest/backfill) don't count.
    SELECT prediction_date
    FROM pds.hrv_predictions
    WHERE model = 'xgboost' AND horizon_days = 1
    GROUP BY prediction_date
    HAVING min(created_at) <= prediction_date::timestamptz + INTERVAL '36 hours'
),
any_row AS (
    SELECT DISTINCT prediction_date
    FROM pds.hrv_predictions
    WHERE horizon_days = 1
)
SELECT
    e.expected_date,
    CASE
        WHEN ar.prediction_date IS NULL THEN 'no_row'
        ELSE 'backfill_only'
    END AS gap_type
FROM expected e
LEFT JOIN xgb_live lx ON lx.prediction_date = e.expected_date
LEFT JOIN any_row  ar ON ar.prediction_date = e.expected_date
WHERE lx.prediction_date IS NULL
ORDER BY e.expected_date DESC;

GRANT SELECT ON pds.hrv_prediction_gaps TO anon, authenticated;

COMMENT ON VIEW pds.hrv_prediction_gaps IS
'Last 30 days where the live xgboost daily forecast is missing or late (>36h). Empty = healthy. Read via pds.hrv_prediction_gaps_mat by the /status page to flag prediction-pipeline drift. gap_type: no_row = no prediction at all (workflow outage); backfill_only = rows exist but none arrived within 36h of the prediction date (live job didn''t run on time).';
