-- pds.hrv_predictions_latest
--
-- Returns one row per (prediction_date, model, horizon_days) — preferring the
-- canonical live predict path, then the retrain path, then backtest as fallback.
-- Readers (dashboard, notebooks, chat tools) use this view so they don't have to
-- reason about run-history or model_version freshness.
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
-- Tiebreak (2026-06-06): there are TWO live writers of forward forecasts:
--   * hrv_predict.py  -> model_version '{ET-date}_v1'           (the dedicated daily predict path)
--   * hrv_analysis.py -> model_version '{ET-date}_behavioral_v1' (the retrain path)
-- For the same (prediction_date, model, horizon_days) the canonical predict path
-- must win, so a later-in-the-day retrain can't shadow it. Priority is now 3-way:
--   0 = canonical (live '*_v1' + legacy_v0), 1 = '*behavioral*', 2 = 'backtest%'.
-- Then created_at DESC so the most recent run wins within each category.
-- (Context: hrv_analysis.py used to date these rows with a naive UTC date.today(),
-- so a late-ET-evening retrain mis-tagged prediction_date by +1 day; that bug was
-- fixed by ET-anchoring hrv_analysis.py and the 455 spurious rollover rows were
-- deleted. This tiebreak is the belt-and-suspenders guard.)
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
  CASE
    WHEN model_version LIKE 'backtest%'    THEN 2
    WHEN model_version LIKE '%behavioral%' THEN 1
    ELSE 0
  END,
  created_at DESC;

COMMENT ON VIEW pds.hrv_predictions_latest IS
  'Latest forecast per (prediction_date, model, horizon_days). Tiebreak: canonical live predict path (_v1 / legacy_v0) wins over the retrain path (_behavioral_v1) wins over backtest; then most recent created_at. Use this view for UI/analytics; use pds.hrv_predictions directly only when you need history across multiple runs.';

-- Composite index supporting the DISTINCT ON sort above. Without this, every
-- read of the view scans + sorts the whole table. The CASE expression matches
-- the view's tiebreak so PostgreSQL can use the index for the full ORDER BY.
DROP INDEX IF EXISTS pds.idx_hrv_predictions_tiebreak;
CREATE INDEX IF NOT EXISTS idx_hrv_predictions_tiebreak
  ON pds.hrv_predictions (
    prediction_date,
    model,
    horizon_days,
    ((CASE
        WHEN model_version LIKE 'backtest%'    THEN 2
        WHEN model_version LIKE '%behavioral%' THEN 1
        ELSE 0
      END)),
    created_at DESC
  );

COMMENT ON INDEX pds.idx_hrv_predictions_tiebreak IS
  'Supports the DISTINCT ON sort path in pds.hrv_predictions_latest. Canonical (_v1/legacy_v0) tiebreak before _behavioral_v1 before backtest for the same (prediction_date, model, horizon_days); then most recent created_at wins.';
