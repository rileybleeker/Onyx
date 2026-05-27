-- =============================================================================
-- hrv_predictions surrogate PK + 4-tuple unique index
-- =============================================================================
-- The pds.hrv_predictions_latest view's DISTINCT ON tiebreak logic
-- anticipates multiple rows per (prediction_date, model, horizon_days)
-- triple (one per model_version). A composite PK over the triple alone
-- would forbid multi-version rows and silently lose retrain history.
--
-- Design: surrogate id PK + unique index on the 4-tuple with
-- NULLS NOT DISTINCT (Postgres 15+) so NULL model_versions don't get
-- treated as distinct (which would let multiple NULL-version rows
-- duplicate the same triple).
--
-- ETL upserts target:
--   hrv_predict.py — backfill + daily predict use on_conflict on the 4-tuple
--   hrv_analysis.py — store_predictions() uses the same 4-tuple
-- =============================================================================

ALTER TABLE pds.hrv_predictions DROP CONSTRAINT IF EXISTS hrv_predictions_pkey;
ALTER TABLE pds.hrv_predictions ADD COLUMN IF NOT EXISTS id BIGSERIAL PRIMARY KEY;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hrv_predictions_quad
    ON pds.hrv_predictions(prediction_date, model, horizon_days, model_version)
    NULLS NOT DISTINCT;
