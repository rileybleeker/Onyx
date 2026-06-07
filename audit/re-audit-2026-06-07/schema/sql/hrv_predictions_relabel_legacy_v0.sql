-- =============================================================================
-- Relabel pre-naming-convention live predictions: backtest_initial → legacy_v0
-- =============================================================================
-- Closes Notion roadmap "Backfill 'backtest_initial' model_version to a
-- clearer label". 44 historical h=1 rows in pds.hrv_predictions were
-- written before the *_v1 naming convention and were mislabeled as
-- 'backtest_initial' even though their created_at pattern (18-23h before
-- prediction_date) shows they were genuine live day-ahead forecasts.
-- Rename to 'legacy_v0' so they're distinguishable from actual backtest
-- rows that share the 'backtest_initial' label.
--
-- The hrv_predictions_latest view's CASE WHEN model_version LIKE 'backtest%'
-- tiebreak (commit d3e36c9) now correctly DEPRIORITIZES real backtest_initial
-- rows while legacy_v0 rows tie with live predictions ('legacy_v0' doesn't
-- match 'backtest%'). View definition unchanged — the relabel makes the
-- tiebreak's semantics line up with intent without rewriting the SQL.
-- =============================================================================

UPDATE pds.hrv_predictions
SET model_version = 'legacy_v0'
WHERE model_version = 'backtest_initial'
  AND horizon_days = 1
  AND ABS(EXTRACT(EPOCH FROM (created_at - prediction_date::timestamptz))/86400.0) < 2;
