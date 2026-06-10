-- ============================================================
-- Personal Data Scientist — Tanita Health Planet Schema
-- ============================================================
-- Deployed to Supabase (Postgres 17) in the pds schema.
--
-- Raw store for Tanita Health Planet innerscan measurements pulled by
-- tanita_etl.py (OAuth'd against healthplanet.jp). One row per measurement
-- instant — the API reports one array item per tag (6021=weight kg,
-- 6022=body fat %) sharing a `date`+`model`; the ETL groups those into a
-- single row keyed on the measurement instant.
--
-- The daily rollup lives in pds.weight_log (earliest measurement per ET
-- day wins — morning weigh-in convention). weight_log gains a `source`
-- column here; tanita only ever inserts/updates weight_log rows it owns
-- (source='tanita') — manual /nutrition entries are never overwritten.
--
-- Post-2020-06-29 the public API only serves tags 6021/6022, so the
-- schema deliberately has no muscle-mass/BMR/bone columns; anything else
-- the API ever returns lands in raw_json.
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.tanita_measurements (
    measured_at   TIMESTAMPTZ  NOT NULL,
    weight_kg     NUMERIC(6,3) CHECK (weight_kg > 0 AND weight_kg < 500),
    body_fat_pct  NUMERIC(5,2) CHECK (body_fat_pct >= 0 AND body_fat_pct <= 100),
    model         TEXT,        -- Tanita internal device code (e.g. '01000145')
    raw_json      JSONB,       -- the grouped API items for this instant
    synced_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- ADR-0001 triple-date + provenance (trigger-populated from measured_at).
    onyx_et_date          DATE,
    onyx_behavioral_date  DATE,
    onyx_local_date       DATE,
    onyx_tz_source        TEXT,

    PRIMARY KEY (measured_at)
);

COMMENT ON TABLE pds.tanita_measurements IS
    'Raw Tanita Health Planet innerscan measurements (tag 6021 weight kg + 6022 body fat %), one row per measurement instant. Synced by tanita_etl.py; rolled up daily into pds.weight_log (earliest per ET day, source=''tanita'').';

CREATE INDEX IF NOT EXISTS idx_tanita_meas_et_date
    ON pds.tanita_measurements (onyx_et_date);
CREATE INDEX IF NOT EXISTS idx_tanita_meas_behavioral
    ON pds.tanita_measurements (onyx_behavioral_date);

-- -----------------------------------------------------------
-- ADR-0001 trigger — derive the quad from the measurement instant.
-- Pure-instant variant (same pattern as spotify_plays): no source TZ
-- offset, so derive_onyx_dates walks the tier ladder (user_tz_log → ET).
-- -----------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_tanita_measurements()
RETURNS TRIGGER AS $$
DECLARE
    d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(NEW.measured_at, NULL, NULL);
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tanita_measurements_set_onyx_dates ON pds.tanita_measurements;
CREATE TRIGGER tanita_measurements_set_onyx_dates
    BEFORE INSERT OR UPDATE OF measured_at ON pds.tanita_measurements
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_tanita_measurements();

-- -----------------------------------------------------------
-- Row-Level Security — anon read, service-role full access
-- -----------------------------------------------------------
ALTER TABLE pds.tanita_measurements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read"           ON pds.tanita_measurements;
DROP POLICY IF EXISTS "service_full_access" ON pds.tanita_measurements;
CREATE POLICY "anon_read"           ON pds.tanita_measurements FOR SELECT TO anon         USING (true);
CREATE POLICY "service_full_access" ON pds.tanita_measurements FOR ALL    TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON pds.tanita_measurements TO anon, authenticated;
GRANT ALL    ON pds.tanita_measurements TO service_role;

-- ============================================================
-- pds.weight_log — provenance column for the Tanita rollup
-- ============================================================
-- 'manual'  = logged from the /nutrition quick-log (the pre-Tanita default,
--             and the override path going forward — manual always wins)
-- 'tanita'  = written by tanita_etl.py's daily rollup
-- No CHECK constraint (matches the onyx_tz_source convention) so a future
-- scale/source doesn't need a migration to land rows.
ALTER TABLE pds.weight_log
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

COMMENT ON COLUMN pds.weight_log.source IS
    'Provenance: ''manual'' (/nutrition quick-log; takes precedence, never overwritten by ETL) | ''tanita'' (tanita_etl.py daily rollup — earliest measurement per ET day).';
