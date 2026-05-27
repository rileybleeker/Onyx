-- =============================================================================
-- ADR-0001 Phase 1, step 3 — onyx_* columns + triggers on Garmin tables
-- =============================================================================
-- Per docs/adr/0001-timezone-and-behavioral-day-handling.md (D3/D4).
--
-- garmin_activities — has start_time_local + start_time_gmt; per-row offset
--   is recoverable (D3 tier-1). Trigger derives TZD from the delta.
-- garmin_sleep — has sleep_start (true UTC); no source TZ. Falls through to
--   user_tz_log (D3 tier-3) → ET fallback. Behavioral-day is (sleep_start in
--   local TZ - 6h)::date which equals the day Riley went to bed.
-- garmin_hrv — has start_timestamp (true UTC). Same path as garmin_sleep.
--
-- Other Garmin tables (garmin_daily_summary, garmin_stress, garmin_heart_rate,
-- garmin_training_status) carry only a synthetic midnight-UTC `ts` + the
-- `calendar_date` already pre-attributed by Garmin's backend in watch-local
-- TZ. Per the audit, these are onyx_local_date == calendar_date (Garmin
-- attribution accepted as-is). We add columns but populate inline rather
-- than via instant-based trigger — the local-date IS the calendar_date.
--
-- Depends on: sql/adr_0001_01_user_tz_log.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. garmin_activities — full instant-based derivation via per-row offset
-- ---------------------------------------------------------------------------
ALTER TABLE pds.garmin_activities
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

CREATE INDEX IF NOT EXISTS idx_garmin_activities_behavioral_date
    ON pds.garmin_activities (onyx_behavioral_date);

-- Helper: format an INTERVAL as TZD ('+02:00' / '-04:30'). Postgres has no
-- built-in for this on intervals; build it manually.
CREATE OR REPLACE FUNCTION pds.interval_to_tzd(diff INTERVAL)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    total_min  INT;
    sign_char  TEXT;
    abs_min    INT;
    hours      INT;
    mins       INT;
BEGIN
    IF diff IS NULL THEN RETURN NULL; END IF;
    total_min := EXTRACT(EPOCH FROM diff)::INT / 60;
    IF total_min >= 0 THEN sign_char := '+'; ELSE sign_char := '-'; END IF;
    abs_min := abs(total_min);
    hours   := abs_min / 60;
    mins    := abs_min % 60;
    RETURN sign_char || lpad(hours::text, 2, '0') || ':' || lpad(mins::text, 2, '0');
END;
$$;

COMMENT ON FUNCTION pds.interval_to_tzd(INTERVAL) IS
'Formats a signed INTERVAL as TZD string (+HH:MM / -HH:MM). Used to convert the (start_time_local - start_time_gmt) delta on garmin_activities into the format derive_onyx_dates expects.';

-- Trigger: compute offset from local-gmt delta, pass to derive_onyx_dates.
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_garmin_activities()
RETURNS TRIGGER AS $$
DECLARE
    d            RECORD;
    tzd          TEXT;
BEGIN
    -- Audit P1 fix: when start_time_gmt is NULL, refuse the start_time_local
    -- fallback. Garmin stores start_time_local as wall-clock labeled +00, so
    -- treating it as a true UTC instant silently mis-attributes by the
    -- user's offset. Refusing (option a) leaves onyx_* NULL on degenerate
    -- rows so they show up as "missing" rather than as wrong dates. Today
    -- 0/349 rows have NULL start_time_gmt — this is purely defensive against
    -- future degenerate ingest.
    IF NEW.start_time_gmt IS NULL THEN
        NEW.onyx_et_date         := NULL;
        NEW.onyx_behavioral_date := NULL;
        NEW.onyx_local_date      := NULL;
        NEW.onyx_tz_source       := 'missing_gmt_instant';
        RETURN NEW;
    END IF;

    IF NEW.start_time_local IS NOT NULL THEN
        tzd := pds.interval_to_tzd(NEW.start_time_local - NEW.start_time_gmt);
    ELSE
        tzd := NULL;
    END IF;

    SELECT * INTO d FROM pds.derive_onyx_dates(
        NEW.start_time_gmt,
        tzd,
        CASE WHEN tzd IS NOT NULL THEN 'source_field' ELSE NULL END
    );
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS garmin_activities_set_onyx_dates ON pds.garmin_activities;
CREATE TRIGGER garmin_activities_set_onyx_dates
    BEFORE INSERT OR UPDATE OF start_time_gmt, start_time_local ON pds.garmin_activities
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_garmin_activities();

-- ---------------------------------------------------------------------------
-- 2. garmin_sleep — UTC instant + user_tz_log lookup
-- ---------------------------------------------------------------------------
ALTER TABLE pds.garmin_sleep
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

CREATE INDEX IF NOT EXISTS idx_garmin_sleep_behavioral_date
    ON pds.garmin_sleep (onyx_behavioral_date);

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_garmin_sleep()
RETURNS TRIGGER AS $$
DECLARE
    d RECORD;
BEGIN
    -- Use sleep_start as the canonical instant (matches WHOOP cycle's
    -- start_time semantic — the bedtime instant). behavioral_date will
    -- correctly land on the day Riley went to bed = the day this sleep
    -- closes per D2.
    SELECT * INTO d FROM pds.derive_onyx_dates(
        NEW.sleep_start,
        NULL,    -- no source TZ; fall through to user_tz_log → ET
        NULL
    );
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS garmin_sleep_set_onyx_dates ON pds.garmin_sleep;
CREATE TRIGGER garmin_sleep_set_onyx_dates
    BEFORE INSERT OR UPDATE OF sleep_start ON pds.garmin_sleep
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_garmin_sleep();

-- ---------------------------------------------------------------------------
-- 3. garmin_hrv — UTC instant + user_tz_log lookup
-- ---------------------------------------------------------------------------
ALTER TABLE pds.garmin_hrv
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

CREATE INDEX IF NOT EXISTS idx_garmin_hrv_behavioral_date
    ON pds.garmin_hrv (onyx_behavioral_date);

-- garmin_hrv.start_timestamp is 100% NULL in our history (Garmin doesn't
-- populate it via our ETL). Fall back to calendar_date which is already
-- wake-day attributed by Garmin's backend.
--
-- Audit re-2026-05-26 P1 fix: the previous fallback set behavioral_date
-- directly to calendar_date (watch-local) but labelled provenance as
-- 'default_et_fallback' (a non-ET date masquerading as ET). It also missed
-- user_tz_log lookups so travel days got the wrong behavioral_date.
-- New behaviour: synthesize an NY-noon instant from calendar_date and route
-- it through derive_onyx_dates so user_tz_log can shift behavioral_date when
-- Riley was abroad. onyx_local_date stays watch-local (calendar_date is
-- already pre-attributed by Garmin's backend in the wearer's TZ). Provenance
-- is now 'garmin_calendar_date'.
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_garmin_hrv()
RETURNS TRIGGER AS $$
DECLARE
    d RECORD;
BEGIN
    IF NEW.start_timestamp IS NOT NULL THEN
        SELECT * INTO d FROM pds.derive_onyx_dates(NEW.start_timestamp, NULL, NULL);
        NEW.onyx_et_date         := d.onyx_et_date;
        NEW.onyx_behavioral_date := d.onyx_behavioral_date;
        NEW.onyx_local_date      := d.onyx_local_date;
        NEW.onyx_tz_source       := d.onyx_tz_source;
    ELSE
        SELECT * INTO d FROM pds.derive_onyx_dates(
            (NEW.calendar_date + INTERVAL '12 hours') AT TIME ZONE 'America/New_York',
            NULL,
            'garmin_calendar_date'
        );
        NEW.onyx_et_date         := d.onyx_et_date;
        NEW.onyx_behavioral_date := d.onyx_behavioral_date;
        NEW.onyx_local_date      := NEW.calendar_date;
        NEW.onyx_tz_source       := 'garmin_calendar_date';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS garmin_hrv_set_onyx_dates ON pds.garmin_hrv;
CREATE TRIGGER garmin_hrv_set_onyx_dates
    BEFORE INSERT OR UPDATE OF start_timestamp, calendar_date ON pds.garmin_hrv
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_garmin_hrv();

-- ---------------------------------------------------------------------------
-- 4. Backfill
-- ---------------------------------------------------------------------------
UPDATE pds.garmin_activities SET start_time_gmt = start_time_gmt
    WHERE start_time_gmt IS NOT NULL OR start_time_local IS NOT NULL;
UPDATE pds.garmin_sleep      SET sleep_start = sleep_start
    WHERE sleep_start IS NOT NULL;
UPDATE pds.garmin_hrv        SET start_timestamp = start_timestamp
    WHERE start_timestamp IS NOT NULL;
