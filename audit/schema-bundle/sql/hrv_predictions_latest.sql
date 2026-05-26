-- pds.hrv_predictions_latest
--
-- Returns one row per (prediction_date, model, horizon_days) — preferring live
-- (non-backtest) predictions, with backtest rows used as fallback when no live
-- row exists. Readers (dashboard, notebooks, chat tools) use this view so they
-- don't have to reason about run-history or model_version freshness.
--
-- The earlier definition excluded backtest rows entirely. That broke the
-- dashboard's Prediction-vs-Actual chart, because the daily prediction job
-- only writes ONE row per day (tomorrow's forecast). All historical h=1
-- forecasts had model_version='backtest_initial' (a misleading legacy name —
-- they were genuine day-ahead forecasts, just made before the *_v1 naming
-- convention was introduced). The blanket exclusion swept all 57 of them out.
--
-- New behaviour: live wins when both exist for the same date; backtest fills
-- the gap when it doesn't. The DISTINCT ON tiebreaker is the CASE expression
-- below, followed by created_at DESC so the most recent run still wins
-- within each category.
--
-- pds.hrv_predictions keeps every row from every run (multiple rows per
-- date/model/horizon as model_version rolls). Generic fetches against the raw
-- table hit size limits quickly once the 30-day Prophet/SARIMAX fan-out
-- accumulates across days.

CREATE OR REPLACE VIEW pds.hrv_predictions_latest AS
SELECT DISTINCT ON (prediction_date, model, horizon_days)
  prediction_date,
  model,
  horizon_days,
  predicted_hrv,
  prediction_lower,
  prediction_upper,
  actual_hrv,
  residual,
  top_drivers,
  model_version,
  training_window_start,
  training_window_end,
  created_at,
  input_data_hash
FROM pds.hrv_predictions
ORDER BY
  prediction_date,
  model,
  horizon_days,
  CASE WHEN model_version LIKE 'backtest%' THEN 1 ELSE 0 END,
  created_at DESC;

COMMENT ON VIEW pds.hrv_predictions_latest IS
  'Latest forecast per (prediction_date, model, horizon_days). When both live and backtest rows exist for the same date, live wins; backtest is used as fallback so dates that only have backtest predictions still surface. Use this view for UI/analytics; use pds.hrv_predictions directly only when you need history across multiple runs.';
