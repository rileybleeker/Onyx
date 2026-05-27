-- =============================================================================
-- ADR-0001 Phase 1, step 2 — onyx_* columns + triggers on WHOOP tables
-- =============================================================================
-- Per docs/adr/0001-timezone-and-behavioral-day-handling.md (D4).
--
-- Adds (et_date, behavioral_date, local_date, tz_source) to:
--   - pds.whoop_cycles
--   - pds.whoop_sleep
--   - pds.whoop_workouts
--
-- All three already capture timezone_offset (TZD) — D3 tier-1, free. The
-- behavioral_date rule generalizes pds.compute_journal_behaviors_date() —
-- (instant_in_local_tz - 6h)::date.
--
-- Depends on: sql/adr_0001_01_user_tz_log.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE pds.whoop_cycles
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

ALTER TABLE pds.whoop_sleep
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

ALTER TABLE pds.whoop_workouts
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

-- Indexes for join performance — every analytical surface joins on
-- onyx_behavioral_date per D5.
CREATE INDEX IF NOT EXISTS idx_whoop_cycles_behavioral_date
    ON pds.whoop_cycles (onyx_behavioral_date);
CREATE INDEX IF NOT EXISTS idx_whoop_sleep_behavioral_date
    ON pds.whoop_sleep (onyx_behavioral_date);
CREATE INDEX IF NOT EXISTS idx_whoop_workouts_behavioral_date
    ON pds.whoop_workouts (onyx_behavioral_date);

-- ---------------------------------------------------------------------------
-- 2. Triggers — recompute onyx_dates on insert/update of source fields
-- ---------------------------------------------------------------------------
-- Note: derive_onyx_dates returns a row of 4 values. We unpack via SELECT
-- INTO instead of using it as a table function in an UPDATE because BEFORE
-- triggers operate on NEW directly.

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_whoop_cycles()
RETURNS TRIGGER AS $$
DECLARE
    d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(
        NEW.start_time,
        NEW.timezone_offset,
        'source_field'
    );
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS whoop_cycles_set_onyx_dates ON pds.whoop_cycles;
CREATE TRIGGER whoop_cycles_set_onyx_dates
    BEFORE INSERT OR UPDATE OF start_time, timezone_offset ON pds.whoop_cycles
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_whoop_cycles();

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_whoop_sleep()
RETURNS TRIGGER AS $$
DECLARE
    d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(
        NEW.start_time,
        NEW.timezone_offset,
        'source_field'
    );
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS whoop_sleep_set_onyx_dates ON pds.whoop_sleep;
CREATE TRIGGER whoop_sleep_set_onyx_dates
    BEFORE INSERT OR UPDATE OF start_time, timezone_offset ON pds.whoop_sleep
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_whoop_sleep();

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_whoop_workouts()
RETURNS TRIGGER AS $$
DECLARE
    d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(
        NEW.start_time,
        NEW.timezone_offset,
        'source_field'
    );
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS whoop_workouts_set_onyx_dates ON pds.whoop_workouts;
CREATE TRIGGER whoop_workouts_set_onyx_dates
    BEFORE INSERT OR UPDATE OF start_time, timezone_offset ON pds.whoop_workouts
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_whoop_workouts();

-- ---------------------------------------------------------------------------
-- 3. Backfill — recompute onyx_dates on existing rows via no-op UPDATE
-- ---------------------------------------------------------------------------
-- Use UPDATE SET <col> = <col> to fire BEFORE UPDATE OF triggers without
-- changing data. The triggers populate onyx_* from existing start_time +
-- timezone_offset values.
UPDATE pds.whoop_cycles   SET start_time = start_time WHERE start_time IS NOT NULL;
UPDATE pds.whoop_sleep    SET start_time = start_time WHERE start_time IS NOT NULL;
UPDATE pds.whoop_workouts SET start_time = start_time WHERE start_time IS NOT NULL;
