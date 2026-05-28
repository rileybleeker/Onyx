-- pds.hrv_predictions_latest
--
-- Returns one row per (prediction_date, model, horizon_days) — preferring live
-- (non-backtest) predictions, with backtest rows used as fallback when no live
-- row exists. Readers (dashboard, notebooks, chat tools) use this view so they
-- don't have to reason about run-history or model_version freshness.
--
-- Historical context: an earlier definition excluded backtest rows entirely.
-- That broke the dashboard's Prediction-vs-Actual chart, because the daily
-- prediction job only writes ONE row per day (tomorrow's forecast). Pre-naming-
-- convention live forecasts had been written with model_version='backtest_initial'
-- (a misleading legacy name — they were genuine day-ahead forecasts) and were
-- swept out by the blanket exclusion. Those rows have since been relabeled to
-- 'legacy_v0' via migration audit_re_2026_05_26_relabel_backtest_initial; the
-- relabel only touched h=1 rows whose created_at was within 2 days of
-- prediction_date, so the ~10K true-backtest rows (h=1..7 from walk-forward
-- runs created months after prediction_date) still carry the 'backtest_initial'
-- label and the CASE WHEN tiebreak below still correctly deprioritizes them.
--
-- Behaviour: live wins when both exist for the same date; backtest fills the
-- gap when it doesn't. The DISTINCT ON tiebreaker is the CASE expression below
-- (legacy_v0 and live *_v1 share priority 0; backtest_initial gets priority 1
-- and loses), followed by created_at DESC so the most recent run still wins
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

-- Composite index supporting the DISTINCT ON sort above. Without this, every
-- read of the view scans + sorts the whole table. The CASE expression matches
-- the view's tiebreak so PostgreSQL can use the index for the full ORDER BY.
CREATE INDEX IF NOT EXISTS idx_hrv_predictions_tiebreak
  ON pds.hrv_predictions (
    prediction_date,
    model,
    horizon_days,
    ((CASE WHEN model_version LIKE 'backtest%' THEN 1 ELSE 0 END)),
    created_at DESC
  );

COMMENT ON INDEX pds.idx_hrv_predictions_tiebreak IS
  'Supports the DISTINCT ON sort path in pds.hrv_predictions_latest. Live (non-backtest) rows tiebreak before backtest rows for the same (prediction_date, model, horizon_days); then most recent created_at wins.';
