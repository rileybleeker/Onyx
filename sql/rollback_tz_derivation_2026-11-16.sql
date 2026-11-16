-- =============================================================================
-- ROLLBACK for sql/tz_derivation_edge_cases.sql (saved 2026-11-16)
-- =============================================================================
-- The LIVE definitions (pg_get_functiondef, byte for byte, plus the closing
-- semicolon) and comments of every existing function that migration replaces,
-- read from production on 2026-11-16 before it was applied. Running this file
-- puts the old trigger behavior back exactly:
--   * garmin_hrv: instant branch when start_timestamp is set, else the noon-ET
--     probe, label 'garmin_calendar_date';
--   * habit_journal: noon-ET probe for onyx_local_date and the label;
--   * journal_entries: real time only when entry_date = ET date of
--     notion_created_at, else 'default_et_fallback';
--   * meal_events / supplement_intake / cronometer_servings without a time:
--     hard-coded 'default_et_fallback';
--   * derive_onyx_dates: tier 3+5 inline.
-- It changes no stored row. Rows that triggers re-derived while the migration
-- was live keep those values until their next write (journal_etl.py re-upserts
-- every journal entry hourly, so those return to the old rule within an hour).
--
-- The three helpers the migration added (pds.tz_log_resolve,
-- pds.derive_onyx_dates_for_day, pds.journal_entry_onyx_dates) are left in
-- place: after this file runs nothing calls them, and removing them would need
-- a destructive statement the Supabase MCP refuses. They read only and write
-- nothing.
--
-- Check after running (SELECT only): md5(replace(prosrc, chr(13), '')) of each
-- function below equals the value in its header line.
-- =============================================================================


-- derive_onyx_dates  body md5 ed3c6e0503c67325837e4e7185ef751e
CREATE OR REPLACE FUNCTION pds.derive_onyx_dates(ts timestamp with time zone, tz_offset_text text, tz_source_in text)
 RETURNS TABLE(onyx_et_date date, onyx_behavioral_date date, onyx_local_date date, onyx_tz_source text)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    local_instant     TIMESTAMP;
    resolved_offset   INTERVAL;
    resolved_tz       TEXT;
    resolved_source   TEXT;
    cycle_offset_text TEXT;
    log_tz            TEXT;
BEGIN
    IF ts IS NULL THEN
        RETURN QUERY SELECT NULL::DATE, NULL::DATE, NULL::DATE, NULL::TEXT;
        RETURN;
    END IF;

    onyx_et_date := (ts AT TIME ZONE 'America/New_York')::date;

    IF tz_offset_text IS NOT NULL AND tz_offset_text <> '' THEN
        -- Tier 1
        resolved_offset := tz_offset_text::interval;
        local_instant   := (ts AT TIME ZONE 'UTC') + resolved_offset;
        resolved_source := COALESCE(tz_source_in, 'source_field');
        onyx_local_date      := local_instant::date;
        onyx_behavioral_date := (local_instant - INTERVAL '6 hours')::date;
    ELSE
        cycle_offset_text := pds.cycle_offset_for_instant(ts);
        IF cycle_offset_text IS NOT NULL THEN
            -- Tier 2
            resolved_offset := cycle_offset_text::interval;
            local_instant   := (ts AT TIME ZONE 'UTC') + resolved_offset;
            resolved_source := COALESCE(tz_source_in, 'cycle_anchor');
            onyx_local_date      := local_instant::date;
            onyx_behavioral_date := (local_instant - INTERVAL '6 hours')::date;
        ELSE
            -- Tier 3+5
            SELECT tz INTO log_tz
              FROM pds.user_tz_log
             WHERE effective_from <= ts
             ORDER BY effective_from DESC
             LIMIT 1;
            IF log_tz IS NOT NULL THEN
                resolved_tz     := log_tz;
                resolved_source := COALESCE(tz_source_in, 'user_tz_log');
            ELSE
                resolved_tz     := 'America/New_York';
                resolved_source := COALESCE(tz_source_in, 'default_et_fallback');
            END IF;
            local_instant        := ts AT TIME ZONE resolved_tz;
            onyx_local_date      := local_instant::date;
            onyx_behavioral_date := (local_instant - INTERVAL '6 hours')::date;
        END IF;
    END IF;

    onyx_tz_source := resolved_source;
    RETURN QUERY SELECT
        onyx_et_date,
        onyx_behavioral_date,
        onyx_local_date,
        onyx_tz_source;
END;
$function$
;

COMMENT ON FUNCTION pds.derive_onyx_dates(TIMESTAMPTZ, TEXT, TEXT) IS
'Per ADR-0001 D1/D2/D3: derives the three onyx_* dates + provenance from a UTC instant. Triggers across source tables call this. Pass tz_offset_text from the source field when available (WHOOP timezone_offset); pass NULL to fall through to user_tz_log/ET. Behavioral day uses the -6h rule matching whoop_journal.behaviors_date.';


-- set_onyx_dates_cronometer_servings  body md5 133f800cf40fb7a27fd378a0c986cab9
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
$function$
;


-- set_onyx_dates_garmin_hrv  body md5 f2498e3a81677eed34916acacef73d4e
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_garmin_hrv()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
        -- Fallback: synthesize an instant from calendar_date (treated as
        -- NY-local noon for ET derivation), but route through
        -- derive_onyx_dates so user_tz_log can shift behavioral_date on
        -- travel days. onyx_local_date stays watch-local (calendar_date is
        -- already pre-attributed by Garmin's backend in the wearer's TZ).
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
$function$
;

COMMENT ON FUNCTION pds.set_onyx_dates_garmin_hrv() IS NULL;


-- set_onyx_dates_habit_journal  body md5 406bf2df0a5430989fa05b838277d8c4
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_habit_journal()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    noon_et TIMESTAMPTZ;
    log_tz  TEXT;
BEGIN
    NEW.behaviors_date := COALESCE(NEW.behaviors_date, NEW.cycle_date);
    NEW.source := COALESCE(
        (SELECT channel FROM pds.habit_name_map WHERE habit_name = NEW.question),
        COALESCE(NEW.source, 'habit')
    );
    NEW.onyx_et_date         := NEW.cycle_date;
    NEW.onyx_behavioral_date := NEW.cycle_date;
    noon_et := (NEW.cycle_date::timestamp + INTERVAL '12 hours') AT TIME ZONE 'America/New_York';
    SELECT tz INTO log_tz FROM pds.user_tz_log
     WHERE effective_from <= noon_et ORDER BY effective_from DESC LIMIT 1;
    IF log_tz IS NOT NULL AND log_tz <> 'America/New_York' THEN
        NEW.onyx_local_date := (noon_et AT TIME ZONE log_tz)::date;
        NEW.onyx_tz_source  := 'user_tz_log';
    ELSIF log_tz = 'America/New_York' THEN
        NEW.onyx_local_date := NEW.cycle_date;
        NEW.onyx_tz_source  := 'user_tz_log';
    ELSE
        NEW.onyx_local_date := NEW.cycle_date;
        NEW.onyx_tz_source  := 'default_et_fallback';
    END IF;
    RETURN NEW;
END;
$function$
;


-- set_onyx_dates_journal_entries  body md5 2a4600eef9bdc4c4bbc27773c295fe89
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_journal_entries()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE d RECORD;
BEGIN
    NEW.onyx_behavioral_date := NEW.entry_date;
    IF NEW.notion_created_at IS NOT NULL
       AND NEW.entry_date = (NEW.notion_created_at AT TIME ZONE 'America/New_York')::date THEN
        SELECT * INTO d FROM pds.derive_onyx_dates(NEW.notion_created_at, NULL, NULL);
        NEW.onyx_et_date := d.onyx_et_date; NEW.onyx_local_date := d.onyx_local_date;
        NEW.onyx_tz_source := d.onyx_tz_source;
    ELSE
        NEW.onyx_et_date := NEW.entry_date; NEW.onyx_local_date := NEW.entry_date;
        NEW.onyx_tz_source := 'default_et_fallback';
    END IF;
    RETURN NEW;
END; $function$
;

COMMENT ON FUNCTION pds.set_onyx_dates_journal_entries() IS NULL;


-- set_onyx_dates_meal_events  body md5 767b55ebfa891e1282fb532b9ab9b686
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_meal_events()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE d RECORD;
BEGIN
    NEW.onyx_behavioral_date := NEW.event_date;
    IF NEW.event_time IS NOT NULL THEN
        SELECT * INTO d FROM pds.derive_onyx_dates(NEW.event_time, NULL, NULL);
        NEW.onyx_et_date := d.onyx_et_date; NEW.onyx_local_date := d.onyx_local_date;
        NEW.onyx_tz_source := d.onyx_tz_source;
    ELSE
        NEW.onyx_et_date := NEW.event_date; NEW.onyx_local_date := NEW.event_date;
        NEW.onyx_tz_source := 'default_et_fallback';
    END IF;
    RETURN NEW;
END; $function$
;


-- set_onyx_dates_supplement_intake  body md5 1a6080fa05819bf2ea71f4bf4bfac359
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_supplement_intake()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE d RECORD;
BEGIN
    NEW.onyx_behavioral_date := NEW.intake_date;
    IF NEW.intake_time IS NOT NULL THEN
        SELECT * INTO d FROM pds.derive_onyx_dates(NEW.intake_time, NULL, NULL);
        NEW.onyx_et_date := d.onyx_et_date; NEW.onyx_local_date := d.onyx_local_date;
        NEW.onyx_tz_source := d.onyx_tz_source;
    ELSE
        NEW.onyx_et_date := NEW.intake_date; NEW.onyx_local_date := NEW.intake_date;
        NEW.onyx_tz_source := 'default_et_fallback';
    END IF;
    RETURN NEW;
END; $function$
;
