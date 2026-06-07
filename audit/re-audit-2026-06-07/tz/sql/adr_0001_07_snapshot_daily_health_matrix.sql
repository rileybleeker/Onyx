-- =============================================================================
-- ADR-0001 Phase 1, step 7 — snapshot daily_health_matrix to pds_legacy
-- =============================================================================
-- Per docs/adr/0001-timezone-and-behavioral-day-handling.md D7 (full
-- historical backfill + snapshot for A/B comparison and rollback).
--
-- Materializes the current view contents into a new schema before Phase 1
-- step 8 swaps the view definition. Lets Phase 2 step 4 sensitivity test
-- compare top correlations, SHAP rankings, model RMSE between the two
-- attribution regimes.
--
-- Apply this BEFORE adr_0001_08_daily_health_matrix_v1.sql.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS pds_legacy;

-- Drop any prior snapshot from a previous attempt.
DROP TABLE IF EXISTS pds_legacy.daily_health_matrix_v0;

-- Materialize the current view contents as a plain table (NOT a materialized
-- view — we want it frozen, not refreshable).
CREATE TABLE pds_legacy.daily_health_matrix_v0 AS
SELECT *, NOW() AS snapshot_taken_at
FROM pds.daily_health_matrix;

CREATE INDEX idx_legacy_dhm_v0_calendar_date
    ON pds_legacy.daily_health_matrix_v0 (calendar_date);

ALTER TABLE pds_legacy.daily_health_matrix_v0 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS legacy_dhm_v0_service_all ON pds_legacy.daily_health_matrix_v0;
CREATE POLICY legacy_dhm_v0_service_all ON pds_legacy.daily_health_matrix_v0
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS legacy_dhm_v0_anon_read ON pds_legacy.daily_health_matrix_v0;
CREATE POLICY legacy_dhm_v0_anon_read ON pds_legacy.daily_health_matrix_v0
    FOR SELECT TO anon, authenticated USING (true);

COMMENT ON TABLE pds_legacy.daily_health_matrix_v0 IS
'Per ADR-0001 D7: snapshot of pds.daily_health_matrix taken before the ADR-0001 attribution rewrite landed. Used by Phase 2 step 4 sensitivity test to A/B compare the old and new HRV models. Retain until the new attribution is validated and adopted; safe to drop afterward.';
