-- Repo mirror of Supabase migration 20260608015651
-- (audit_re_2026_06_07_consolidate_identical_onyx_triggers). Already applied live.

-- Re-audit 2026-06-07 (schema gpt-5/F-010, deepseek/F-007): consolidate the two clusters of
-- BYTE-IDENTICAL set_onyx_dates trigger functions (same bodies AND same column names) into
-- one shared function each, so a future fix touches one place. The other ~11 functions use
-- different columns / bespoke logic and are intentionally left distinct (consolidating them
-- would need slower, less-readable dynamic field access). Bodies are identical, so this is a
-- pure refactor with zero behavior change — no data re-derivation needed.

-- Cluster B: WHOOP cycle-child tables (start_time + timezone_offset).
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_whoop_cycle_child()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(NEW.start_time, NEW.timezone_offset, 'source_field');
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER whoop_cycles_set_onyx_dates
    BEFORE INSERT OR UPDATE OF start_time, timezone_offset ON pds.whoop_cycles
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_whoop_cycle_child();
CREATE OR REPLACE TRIGGER whoop_sleep_set_onyx_dates
    BEFORE INSERT OR UPDATE OF start_time, timezone_offset ON pds.whoop_sleep
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_whoop_cycle_child();
CREATE OR REPLACE TRIGGER whoop_workouts_set_onyx_dates
    BEFORE INSERT OR UPDATE OF start_time, timezone_offset ON pds.whoop_workouts
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_whoop_cycle_child();
DROP FUNCTION IF EXISTS pds.set_onyx_dates_whoop_cycles();
DROP FUNCTION IF EXISTS pds.set_onyx_dates_whoop_sleep();
DROP FUNCTION IF EXISTS pds.set_onyx_dates_whoop_workouts();

-- Cluster A: date-only passthrough tables (onyx_* := calendar_date).
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_calendar_passthrough()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.onyx_et_date         := NEW.calendar_date;
    NEW.onyx_behavioral_date := NEW.calendar_date;
    NEW.onyx_local_date      := NEW.calendar_date;
    NEW.onyx_tz_source       := 'source_field';
    RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER eight_sleep_trends_set_onyx_dates
    BEFORE INSERT OR UPDATE OF calendar_date ON pds.eight_sleep_trends
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_calendar_passthrough();
CREATE OR REPLACE TRIGGER mfp_nutrition_set_onyx_dates
    BEFORE INSERT OR UPDATE OF calendar_date ON pds.myfitnesspal_nutrition
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_calendar_passthrough();
DROP FUNCTION IF EXISTS pds.set_onyx_dates_eight_sleep_trends();
DROP FUNCTION IF EXISTS pds.set_onyx_dates_myfitnesspal_nutrition();
