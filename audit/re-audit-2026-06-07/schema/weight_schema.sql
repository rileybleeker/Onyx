-- ============================================================
-- Personal Data Scientist — Daily Weight Log Schema
-- ============================================================
-- Deployed to Supabase (Postgres 17) in the pds schema.
--
-- One row per ET date. The user logs daily weight via the /nutrition
-- page (body composition lives alongside calories + macros). Storage
-- canonical unit is kg (matches whoop_body_measurements); the frontend
-- accepts and displays pounds via a kg↔lb conversion.
--
-- Weight changes too slowly for daily-ATE causal modeling (per the
-- causal_inference.py exclusion list), so this table is intentionally
-- NOT joined into daily_health_matrix today. It's a standalone trend
-- store that the /nutrition page reads directly.
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.weight_log (
    log_date    DATE         NOT NULL,
    weight_kg   NUMERIC(6,3) NOT NULL CHECK (weight_kg > 0 AND weight_kg < 500),
    notes       TEXT,
    logged_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (log_date)
);

CREATE INDEX IF NOT EXISTS idx_weight_log_date
    ON pds.weight_log (log_date DESC);

-- Touch updated_at on row update (matches meal_events pattern).
CREATE OR REPLACE FUNCTION pds.weight_log_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS weight_log_touch_updated_at ON pds.weight_log;
CREATE TRIGGER weight_log_touch_updated_at
    BEFORE UPDATE ON pds.weight_log
    FOR EACH ROW
    EXECUTE FUNCTION pds.weight_log_touch_updated_at();

-- -----------------------------------------------------------
-- Row-Level Security — anon read, service-role full access
-- -----------------------------------------------------------
ALTER TABLE pds.weight_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read" ON pds.weight_log;
CREATE POLICY "anon_read" ON pds.weight_log
    FOR SELECT TO anon USING (true);

GRANT SELECT ON pds.weight_log TO anon;
