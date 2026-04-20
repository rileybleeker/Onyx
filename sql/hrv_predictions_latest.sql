-- pds.hrv_predictions_latest
--
-- Returns one row per (prediction_date, model, horizon_days) — always the
-- freshest prediction — and excludes backtest rows. Readers (dashboard,
-- notebooks, chat tools) use this view so they don't have to reason about
-- run-history or model_version freshness.
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
WHERE model_version IS NULL OR model_version NOT LIKE 'backtest%'
ORDER BY prediction_date, model, horizon_days, created_at DESC;

COMMENT ON VIEW pds.hrv_predictions_latest IS
  'Latest forecast per (prediction_date, model, horizon_days). Excludes backtest rows. Use this for UI/analytics; use pds.hrv_predictions directly only when you need history across multiple runs.';
