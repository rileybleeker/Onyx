-- =============================================================================
-- Re-audit 2026-06-07 — synced_at bump trigger + Cronometer onyx-date triggers
-- =============================================================================
-- These objects were applied DIRECTLY to prod via Supabase migrations during
-- the 2026-06-07 session (recorded in the Supabase migration history) but the
-- repo SQL hadn't captured them. This file is the byte-accurate repo copy,
-- transcribed from live prod via pg_get_functiondef / pg_get_triggerdef so the
-- repo matches production. Idempotent (CREATE OR REPLACE + DROP TRIGGER IF
-- EXISTS) so re-applying is a no-op.
--
-- Two unrelated clusters bundled here:
--
--   1. pds.bump_synced_at_on_change() — a generic BEFORE UPDATE trigger that
--      refreshes synced_at to now() whenever any column OTHER than synced_at
--      actually changed. Attached as `zzz_bump_synced_at` (the zzz_ prefix
--      makes it fire LAST in alphabetical BEFORE-trigger order, after the
--      onyx-date triggers have populated their columns) on the four tables
--      whose upsert path doesn't include synced_at in the patch object, so the
--      UPDATE branch of an upsert would otherwise leave a stale synced_at and
--      defeat /status freshness + hrv_backfill_check change detection:
--          garmin_daily_summary, eight_sleep_trends,
--          myfitnesspal_nutrition, whoop_journal
--
--   2. pds.set_onyx_dates_cronometer_daily() / _servings() — the ADR-0001
--      onyx-date triggers for the two Cronometer tables (cronometer_schema.sql
--      defines the tables; these triggers were added separately). Daily totals
--      collapse all three onyx_* dates to calendar_date (manual-backdate
--      convention, same as MFP). Servings derive from event_time when present
--      (Cronometer Gold), else fall back to calendar_date.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. synced_at bump trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.bump_synced_at_on_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF (to_jsonb(OLD) - 'synced_at') IS DISTINCT FROM (to_jsonb(NEW) - 'synced_at') THEN
        NEW.synced_at := now();
    END IF;
    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION pds.bump_synced_at_on_change() IS
'BEFORE UPDATE trigger: bump synced_at to now() whenever any non-synced_at column changed. Compensates for upsert UPDATE branches that omit synced_at from the patch object, keeping /status freshness + hrv_backfill_check change detection accurate. Applied via Supabase migration 2026-06-07.';

DROP TRIGGER IF EXISTS zzz_bump_synced_at ON pds.garmin_daily_summary;
CREATE TRIGGER zzz_bump_synced_at BEFORE UPDATE ON pds.garmin_daily_summary
    FOR EACH ROW EXECUTE FUNCTION pds.bump_synced_at_on_change();

DROP TRIGGER IF EXISTS zzz_bump_synced_at ON pds.eight_sleep_trends;
CREATE TRIGGER zzz_bump_synced_at BEFORE UPDATE ON pds.eight_sleep_trends
    FOR EACH ROW EXECUTE FUNCTION pds.bump_synced_at_on_change();

DROP TRIGGER IF EXISTS zzz_bump_synced_at ON pds.myfitnesspal_nutrition;
CREATE TRIGGER zzz_bump_synced_at BEFORE UPDATE ON pds.myfitnesspal_nutrition
    FOR EACH ROW EXECUTE FUNCTION pds.bump_synced_at_on_change();

DROP TRIGGER IF EXISTS zzz_bump_synced_at ON pds.whoop_journal;
CREATE TRIGGER zzz_bump_synced_at BEFORE UPDATE ON pds.whoop_journal
    FOR EACH ROW EXECUTE FUNCTION pds.bump_synced_at_on_change();

-- ---------------------------------------------------------------------------
-- 2a. Cronometer daily totals — collapse onyx_* dates to calendar_date
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_cronometer_daily()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.onyx_behavioral_date := COALESCE(NEW.onyx_behavioral_date, NEW.calendar_date);
    NEW.onyx_et_date         := COALESCE(NEW.onyx_et_date,         NEW.calendar_date);
    NEW.onyx_local_date      := COALESCE(NEW.onyx_local_date,      NEW.calendar_date);
    NEW.onyx_tz_source       := COALESCE(NEW.onyx_tz_source,       'cronometer_daily');
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS set_onyx_dates_cronometer_daily ON pds.cronometer_nutrition_daily;
CREATE TRIGGER set_onyx_dates_cronometer_daily
    BEFORE INSERT OR UPDATE ON pds.cronometer_nutrition_daily
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_cronometer_daily();

-- ---------------------------------------------------------------------------
-- 2b. Cronometer servings — derive from event_time (Gold) else calendar_date
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_cronometer_servings()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE d RECORD;
BEGIN
    IF NEW.onyx_behavioral_date IS NULL OR NEW.onyx_et_date IS NULL
       OR NEW.onyx_local_date IS NULL OR NEW.onyx_tz_source IS NULL THEN
        IF NEW.event_time IS NOT NULL THEN
            SELECT * INTO d FROM pds.derive_onyx_dates(NEW.event_time, NULL, 'cronometer_serving');
            NEW.onyx_et_date         := COALESCE(NEW.onyx_et_date,         d.onyx_et_date);
            NEW.onyx_behavioral_date := COALESCE(NEW.onyx_behavioral_date, d.onyx_behavioral_date);
            NEW.onyx_local_date      := COALESCE(NEW.onyx_local_date,      d.onyx_local_date);
            NEW.onyx_tz_source       := COALESCE(NEW.onyx_tz_source,       d.onyx_tz_source);
        ELSE
            NEW.onyx_et_date         := COALESCE(NEW.onyx_et_date,         NEW.calendar_date);
            NEW.onyx_behavioral_date := COALESCE(NEW.onyx_behavioral_date, NEW.calendar_date);
            NEW.onyx_local_date      := COALESCE(NEW.onyx_local_date,      NEW.calendar_date);
            NEW.onyx_tz_source       := COALESCE(NEW.onyx_tz_source,       'default_et_fallback');
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS set_onyx_dates_cronometer_servings ON pds.cronometer_servings;
CREATE TRIGGER set_onyx_dates_cronometer_servings
    BEFORE INSERT OR UPDATE ON pds.cronometer_servings
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_cronometer_servings();
