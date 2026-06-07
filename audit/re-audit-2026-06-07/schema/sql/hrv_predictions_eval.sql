-- pds.hrv_predictions_eval
--
-- Latest prediction per (prediction_date, model, horizon_days) INCLUDING
-- backtest model_versions. Used by the dashboard's Prediction-vs-Actual
-- chart, which needs the historical backtest series to evaluate model
-- accuracy over time.
--
-- Contrast with pds.hrv_predictions_latest (DDL: hrv_predictions_latest.sql)
-- which excludes backtest rows to keep generic UI fetches small. That view
-- is correct for "what's the freshest forecast for tomorrow?" — but the
-- backtest filter renders it nearly empty for "what did we predict last
-- month vs what actually happened?"
--
-- If both a backtest_initial row and a later live-prediction row exist for
-- the same (date, model, horizon), the DISTINCT ON keeps whichever was
-- written most recently — typically the live prediction once it lands.

CREATE OR REPLACE VIEW pds.hrv_predictions_eval AS
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
ORDER BY prediction_date, model, horizon_days, created_at DESC;

COMMENT ON VIEW pds.hrv_predictions_eval IS
  'Latest forecast per (prediction_date, model, horizon_days), backtest rows INCLUDED. Use this for historical evaluation charts; use pds.hrv_predictions_latest for live forecast queries that should exclude backtest.';
