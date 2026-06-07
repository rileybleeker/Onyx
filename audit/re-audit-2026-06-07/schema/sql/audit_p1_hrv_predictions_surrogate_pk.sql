-- =============================================================================
-- Audit P1 (G1): hrv_predictions surrogate PK + 4-tuple unique index
-- =============================================================================
-- Pre-fix PK: (prediction_date, model, horizon_days).
-- The pds.hrv_predictions_latest view's DISTINCT ON tiebreak logic
-- anticipates multiple rows per triple (one per model_version) but the PK
-- forbids them, so retrain history is silently lost.
--
-- Fix: surrogate id PK + unique index on the 4-tuple with NULLS NOT DISTINCT
-- (Postgres 15+) so NULL model_versions don't get treated as distinct
-- (which would let multiple NULL-version rows duplicate the same triple).
--
-- Migration: audit_p1_g1_hrv_predictions_pk_surrogate (applied 2026-05-26).
--
-- ETL upserts updated correspondingly:
--   hrv_predict.py — backfill path + daily predict path now target
--     on_conflict="prediction_date,model,horizon_days,model_version"
--   hrv_analysis.py — store_predictions() targets the same 4-tuple
-- =============================================================================

ALTER TABLE pds.hrv_predictions DROP CONSTRAINT IF EXISTS hrv_predictions_pkey;
ALTER TABLE pds.hrv_predictions ADD COLUMN IF NOT EXISTS id BIGSERIAL PRIMARY KEY;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hrv_predictions_quad
    ON pds.hrv_predictions(prediction_date, model, horizon_days, model_version)
    NULLS NOT DISTINCT;
