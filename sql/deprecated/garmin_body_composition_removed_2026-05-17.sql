-- =============================================================================
-- pds.garmin_body_composition — REMOVED 2026-05-17
-- =============================================================================
-- This table was dropped from Project Onyx scope on 2026-05-17. Reasons:
--   - The upsert had been failing every run since inception (`on_conflict=ts`
--     with no unique constraint on `ts`) so the table was always empty.
--   - Body composition data was judged to add no analytical value.
--
-- Captured here for revertability. Live schema had: no primary key, no unique
-- constraints, no indexes, no triggers. Re-creating from this file alone is
-- enough to restore the table to its dropped state.
--
-- If you ever want this back, you'll also need to:
--   - Re-add the `sync_body_composition` function in `garmin_etl.py` and its
--     entry in the `sync_date` orchestrator dict.
--   - Add a unique constraint on `ts` (or `calendar_date,ts`) so upserts work.
--   - Re-add the `gbc` LATERAL JOIN block to `sql/daily_health_matrix.sql`.
--   - Re-add the RLS ALTER + POLICY to `sql/rls_policies.sql`.
-- =============================================================================

CREATE TABLE pds.garmin_body_composition (
  ts                  TIMESTAMPTZ      NOT NULL,
  weight_grams        DOUBLE PRECISION,
  weight_kg           DOUBLE PRECISION,
  bmi                 DOUBLE PRECISION,
  body_fat_pct        DOUBLE PRECISION,
  body_water_pct      DOUBLE PRECISION,
  bone_mass_grams     DOUBLE PRECISION,
  muscle_mass_grams   DOUBLE PRECISION,
  visceral_fat        DOUBLE PRECISION,
  physique_rating     DOUBLE PRECISION,
  metabolic_age       INTEGER,
  basal_met_rate      DOUBLE PRECISION,
  source_type         TEXT,
  calendar_date       DATE,
  source              TEXT             DEFAULT 'garmin',
  raw_json            JSONB,
  synced_at           TIMESTAMPTZ      DEFAULT now()
);

ALTER TABLE pds.garmin_body_composition ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read" ON pds.garmin_body_composition FOR SELECT TO anon USING (true);
