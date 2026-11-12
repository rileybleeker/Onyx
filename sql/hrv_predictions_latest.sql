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
-- removed. This tiebreak is the belt-and-suspenders guard.)
--
-- pds.hrv_predictions keeps every row from every run (multiple rows per
-- date/model/horizon as model_version rolls). Generic fetches against the raw
-- table hit size limits quickly once the 30-day Prophet/SARIMAX fan-out
-- accumulates across days.

-- Stale backtest rows (2026-11-11, applied as migration hrv_predictions_latest_hide_stale_backtest):
-- a 'backtest_initial' prediction is served only if its input_data_hash equals the hash of
-- the newest backtest metrics row (the latest retrain). Older backtest rows are left behind
-- when the current backtest stops producing their (date, model, horizon) keys, so its
-- upsert never overwrites them; they predict the old HRV pairing and used to show up on
-- /analytics/hrv (408 served rows, 6 of them xgboost h=1 in Dec-Mar). The rows stay in
-- pds.hrv_predictions; only this view hides them. Caveat: between store_predictions and
-- store_metrics inside a retrain (tens of seconds) freshly written backtest rows are hidden
-- until the metrics row lands. Undo = the previous definition (same columns, same order):
-- the SELECT in git history before this change.

CREATE OR REPLACE VIEW pds.hrv_predictions_latest AS
SELECT DISTINCT ON (p.prediction_date, p.model, p.horizon_days)
  p.prediction_date,
  p.model,
  p.horizon_days,
  p.predicted_hrv,
  p.prediction_lower,
  p.prediction_upper,
  p.actual_hrv,
  p.residual,
  p.top_drivers,
  p.model_version,
  p.training_window_start,
  p.training_window_end,
  p.created_at,
  p.input_data_hash
FROM pds.hrv_predictions p
WHERE p.model_version IS DISTINCT FROM 'backtest_initial'
   OR p.input_data_hash = (
        SELECT m.input_data_hash FROM pds.hrv_model_metrics m
        WHERE m.model_version = 'backtest_initial' AND m.input_data_hash IS NOT NULL
        ORDER BY m.eval_date DESC, m.created_at DESC
        LIMIT 1)
ORDER BY
  p.prediction_date,
  p.model,
  p.horizon_days,
  CASE
    WHEN p.model_version LIKE 'backtest%'    THEN 2
    WHEN p.model_version LIKE '%behavioral%' THEN 1
    ELSE 0
  END,
  p.created_at DESC;

COMMENT ON VIEW pds.hrv_predictions_latest IS
  'Latest forecast per (prediction_date, model, horizon_days). Tiebreak: canonical live predict path (_v1 / legacy_v0) wins over the retrain path (_behavioral_v1) wins over backtest; then most recent created_at. Backtest rows from superseded retrains (input_data_hash not the newest backtest hash) are hidden, not removed. Use this view for UI/analytics; use pds.hrv_predictions directly only when you need history across multiple runs.';

-- Composite index supporting the DISTINCT ON sort above. Without this, every
-- read of the view scans + sorts the whole table. The CASE expression matches
-- the view's tiebreak so PostgreSQL can use the index for the full ORDER BY.
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
