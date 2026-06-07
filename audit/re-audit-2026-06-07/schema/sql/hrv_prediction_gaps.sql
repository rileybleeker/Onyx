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
-- Definition of "missing": no live xgboost row exists for the day. xgboost
-- is the canonical "model ran end-to-end" signal — every successful
-- prediction job writes one. Backtest-only rows (model_version LIKE
-- 'backtest%' OR 'legacy_v0') don't count because they're after-the-fact
-- batch fills, not evidence the daily job worked. Today's prediction_date
-- is excluded because tomorrow's forecast may not have been generated yet.
-- =============================================================================

CREATE OR REPLACE VIEW pds.hrv_prediction_gaps AS
WITH expected AS (
    SELECT generate_series(
        CURRENT_DATE - INTERVAL '30 days',
        CURRENT_DATE - INTERVAL '1 day',
        INTERVAL '1 day'
    )::date AS expected_date
),
live_xgb AS (
    SELECT DISTINCT prediction_date
    FROM pds.hrv_predictions
    WHERE model = 'xgboost'
      AND horizon_days = 1
      AND COALESCE(model_version, '') NOT LIKE 'backtest%'
      AND COALESCE(model_version, '') <> 'legacy_v0'
),
any_model AS (
    SELECT DISTINCT prediction_date
    FROM pds.hrv_predictions
    WHERE horizon_days = 1
)
SELECT
    e.expected_date,
    CASE
        WHEN am.prediction_date IS NULL THEN 'no_row'
        WHEN lx.prediction_date IS NULL THEN 'backtest_only'
    END AS gap_type
FROM expected e
LEFT JOIN live_xgb  lx ON lx.prediction_date = e.expected_date
LEFT JOIN any_model am ON am.prediction_date = e.expected_date
WHERE lx.prediction_date IS NULL
ORDER BY e.expected_date DESC;

GRANT SELECT ON pds.hrv_prediction_gaps TO anon, authenticated;

COMMENT ON VIEW pds.hrv_prediction_gaps IS
'Last 30 days where the live xgboost daily forecast is missing. Empty = healthy. Read by the /status page to flag prediction-pipeline drift before it shows up in charts. gap_type: no_row = no prediction at all (workflow outage); backtest_only = only after-the-fact backtest rows exist (live job didn''t run that day).';
