-- =============================================================================
-- TZ derivation edge cases: date-only rows and journal entries (2026-11-14,
-- reviewed against the live definitions 2026-11-16)
-- =============================================================================
-- Roadmap row "TZ derivation edge-cases + centralize fallback labeling"
-- (Notion 379bf5b4-4bf2-8157-bc24-d0b6a86b878e), audit item HIST-TZ-01.
-- Settles the date-only and journal findings the 2026-06-07 re-audit deferred
-- (audit/re-audit-2026-06-07/_findings_digest.md, BUNDLE tz). Every body below
-- replaces a function whose LIVE definition (pg_get_functiondef, 2026-11-16) is
-- saved in sql/rollback_tz_derivation_2026-11-16.sql.
--
-- STATUS: NOT applied. Apply only after its reviews pass. Run the DRY RUN
-- queries first and the post-deploy checks
-- (sql/tz_derivation_postdeploy_checks.sql) right after.
--
-- Scope: this file changes how FUTURE trigger runs derive the onyx_* dates and
-- labels. It contains no UPDATE of stored rows (no backfill; that is a separate
-- plan) and does not touch the frozen WHOOP journal archive. The WHOOP-journal
-- trigger and the WHOOP transition-flag changes that were staged with it live in
-- sql/tz_derivation_whoop_followups.sql (not applied, separate review).
-- Heads-up: journal_etl.py upserts every Notion page each hour (entry_date and
-- notion_created_at are in the payload, which fires the trigger), so within an
-- hour of applying, journal_entries rows are re-derived by the new rule; the
-- DRY RUN (c) query shows exactly which rows change. garmin_etl.py re-upserts its
-- recent days the same way (labels only, see (a)).
--
-- What changes, in plain words
--   1. One helper decides the label when a TZ comes from pds.user_tz_log:
--      pds.tz_log_resolve(ts) -> (tz, 'user_tz_log' | 'default_et_fallback').
--      derive_onyx_dates (tier 3+5) now calls it. Same results as before.
--   2. One helper for rows that only have a date (no instant):
--      pds.derive_onyx_dates_for_day(date, tz_source_in). All three onyx_*
--      dates are the date itself; the label says whether user_tz_log covered
--      that day. Six trigger functions used to hand-roll this (two with a
--      noon-ET probe, four with a hard-coded label); all six call it now.
--      Fixes:
--        * far-east trips (Tokyo, Sydney): the noon-ET probe pushed
--          onyx_local_date of a habit row one day forward (noon ET = 01:00 next
--          day in Tokyo). The date the row was logged under is now kept.
--          (gemini/F-005)
--        * same-day TZ change: the label is read at the END of the ET day
--          (DST-safe: midnight of the next day in America/New_York, minus 1
--          microsecond), so a log row that starts after noon (afternoon
--          landing) still counts. A date-only row has no time of day, so the
--          label is all the TZ affects. (deepseek/F-004)
--        * labels are uniform: meal_events / supplement_intake /
--          journal_entries / cronometer_servings rows without a time used
--          'default_et_fallback' even on days the log covered.
--          (gpt-5/F-005, F-010)
--   3. garmin_hrv: always keyed by Garmin's own calendar_date (the wake-up
--      day) in all three onyx_* dates, labelled 'source_field' like its
--      sibling eight_sleep_trends. Was 'garmin_calendar_date', a label outside
--      the ADR-0001 D6 list (gpt-5/F-001). Dates do not move: the wake-up-day
--      key is deliberate. The matrix joins garmin_hrv on onyx_behavioral_date
--      (pds.garmin_hrv_latest_per_behavioral_date) and hrv_alignment.py then
--      re-keys garmin_hrv_* one day earlier (PREVIOUS_NIGHT_PREFIXES); its
--      runtime guard fails the retrain if the column lines up with the wrong
--      row. Shifting the dates here (deepseek/F-003's suggestion) would shift
--      the HRV analysis twice. The live instant branch (start_timestamp) is
--      gone for the same reason: garmin_etl.py fills start_timestamp whenever
--      Garmin sends startTimestampGMT, and that branch would date the row by
--      the sleep onset (the night before), which the alignment layer would then
--      move a second day. onyx_local_date stays calendar_date: Garmin dates it
--      in the watch's zone, which follows the phone (gpt-5/F-004, on purpose).
--   4. journal_entries: the dating moves into a callable helper,
--      pds.journal_entry_onyx_dates(entry_date, written_at), so the rule can be
--      checked with a plain SELECT. An entry counts as written in real time
--      when entry_date equals the ET, local OR behavioral date of
--      notion_created_at (was: ET date only). Fixes real-time entries written
--      abroad and the 00:30 "about yesterday" awake-tail entries, whose
--      onyx_et_date / onyx_local_date become the clock day they were written.
--      onyx_behavioral_date stays entry_date, the column the HRV pipeline
--      reads (it groups by entry_date). (gemini/F-003)
--
-- Not touched: pds.daily_health_matrix_behavioral and its matview (no view
-- change, so no matview rebuild), pds.tz_for_instant, derive_onyx_dates tiers
-- 1 and 2, every instant-based trigger, every trigger definition (only the
-- functions they call are replaced), pds.whoop_journal and its trigger, the
-- WHOOP-era rows of pds.habit_journal (zzz_block_frozen_whoop_era still rejects
-- any write to them before the new function's result could be stored).
-- Grants: the new functions get the default (EXECUTE for PUBLIC), the same ACL
-- as pds.derive_onyx_dates; anon has no USAGE on schema pds.
-- =============================================================================


-- =============================================================================
-- DRY RUN (SELECT only; run before applying). Each query counts the stored
-- rows the new rule would derive differently. Report counts, never rows.
-- =============================================================================
-- Label a date-only day gets from the new helper:
--   CASE WHEN EXISTS (SELECT 1 FROM pds.user_tz_log u
--                      WHERE u.effective_from <= ((d + 1)::timestamp
--                            AT TIME ZONE 'America/New_York') - INTERVAL '1 microsecond')
--        THEN 'user_tz_log' ELSE 'default_et_fallback' END
--
-- (a) garmin_hrv: expected label-only (dates unchanged)
--   SELECT count(*) FILTER (WHERE onyx_et_date IS DISTINCT FROM calendar_date
--                              OR onyx_behavioral_date IS DISTINCT FROM calendar_date
--                              OR onyx_local_date IS DISTINCT FROM calendar_date) AS date_changes,
--          count(*) FILTER (WHERE onyx_tz_source IS DISTINCT FROM 'source_field') AS label_changes,
--          count(*) FILTER (WHERE start_timestamp IS NOT NULL) AS instant_rows
--     FROM pds.garmin_hrv;
-- (b) supplement_intake without intake_time: expected label-only
--   SELECT count(*) FILTER (WHERE onyx_et_date IS DISTINCT FROM intake_date
--                              OR onyx_local_date IS DISTINCT FROM intake_date) AS date_changes,
--          count(*) FILTER (WHERE onyx_tz_source IS DISTINCT FROM <label for intake_date>) AS label_changes
--     FROM pds.supplement_intake WHERE intake_time IS NULL;
-- (c) journal_entries: date changes only on awake-tail entries (+1 day to the
--     clock day written, onyx_behavioral_date unchanged); the rest label-only.
--   SELECT count(*) FILTER (WHERE je.onyx_et_date IS DISTINCT FROM n.onyx_et_date
--                              OR je.onyx_local_date IS DISTINCT FROM n.onyx_local_date) AS date_changes,
--          count(*) FILTER (WHERE je.onyx_behavioral_date IS DISTINCT FROM n.onyx_behavioral_date) AS behavioral_changes,
--          count(*) FILTER (WHERE je.onyx_tz_source IS DISTINCT FROM n.onyx_tz_source) AS label_changes
--     FROM pds.journal_entries je
--     CROSS JOIN LATERAL (<pds.journal_entry_onyx_dates written inline with
--                          pds.derive_onyx_dates(je.notion_created_at, NULL, NULL)
--                          and the label above>) n;
-- (d) habit_journal rows outside the frozen WHOOP era (source = 'whoop' AND
--     cycle_date <= '2026-06-08'): expected no change; frozen rows cannot be
--     rewritten and are not counted.
-- (e) meal_events / cronometer_servings rows with no time: meal_events expected
--     none; Cronometer rows carry labels from cronometer_import.py, which the
--     trigger keeps (it only fills NULLs), so expected no change.


-- =============================================================================
-- 1. pds.tz_log_resolve: the ONE place that labels a user_tz_log lookup
-- =============================================================================
CREATE OR REPLACE FUNCTION pds.tz_log_resolve(ts TIMESTAMPTZ)
RETURNS TABLE (tz TEXT, tz_source TEXT)
LANGUAGE sql
STABLE
AS $function$
    SELECT COALESCE(hit.tz, 'America/New_York'),
           CASE WHEN hit.tz IS NOT NULL THEN 'user_tz_log'
                ELSE 'default_et_fallback' END
      FROM (SELECT (SELECT u.tz
                      FROM pds.user_tz_log u
                     WHERE u.effective_from <= tz_log_resolve.ts
                     ORDER BY u.effective_from DESC
                     LIMIT 1) AS tz) AS hit;
$function$;

COMMENT ON FUNCTION pds.tz_log_resolve(TIMESTAMPTZ) IS
'ADR-0001 D3 tier 3+5 / D6: the TZ in effect at ts per pds.user_tz_log, with its provenance label. A log row in effect -> (row tz, ''user_tz_log''); none -> (''America/New_York'', ''default_et_fallback''). Always one row. The single place these two labels are decided: pds.derive_onyx_dates and pds.derive_onyx_dates_for_day both call it (sql/tz_derivation_edge_cases.sql).';


-- =============================================================================
-- 2. pds.derive_onyx_dates_for_day: rows that only carry a date
-- =============================================================================
-- All three onyx_* dates are the date itself: the person or device that wrote
-- the row already chose the day, and projecting it through an instant (the old
-- noon-ET probe) only moved it on far-east trips. The label comes from
-- tz_log_resolve read at the last instant of that ET day (midnight of the next
-- day in America/New_York minus 1 microsecond, so 23- and 25-hour DST days are
-- handled), so a log row that takes effect later the same day (afternoon
-- landing) still counts. tz_source_in, when given, overrides the label (same
-- rule as derive_onyx_dates). Always returns one row; a NULL date gives NULLs.
CREATE OR REPLACE FUNCTION pds.derive_onyx_dates_for_day(
    src_date     DATE,
    tz_source_in TEXT DEFAULT NULL
)
RETURNS TABLE (
    onyx_et_date          DATE,
    onyx_behavioral_date  DATE,
    onyx_local_date       DATE,
    onyx_tz_source        TEXT
)
LANGUAGE sql
STABLE
AS $function$
    SELECT src_date,
           src_date,
           src_date,
           CASE WHEN src_date IS NULL THEN NULL::TEXT
                ELSE COALESCE(tz_source_in, r.tz_source) END
      FROM pds.tz_log_resolve(
               ((src_date + 1)::timestamp AT TIME ZONE 'America/New_York')
               - INTERVAL '1 microsecond'
           ) AS r;
$function$;

COMMENT ON FUNCTION pds.derive_onyx_dates_for_day(DATE, TEXT) IS
'ADR-0001 D6 for date-only rows: onyx_et/behavioral/local_date = the date itself; onyx_tz_source = tz_source_in, else whether user_tz_log covered that day (pds.tz_log_resolve at the end of the ET day, so a same-day TZ change counts). Used by every trigger branch that has no instant: habit_journal, journal_entries backdated (via pds.journal_entry_onyx_dates), meal_events / supplement_intake / cronometer_servings without a time, garmin_hrv (sql/tz_derivation_edge_cases.sql).';


-- =============================================================================
-- 3. pds.derive_onyx_dates: tier 3+5 now asks tz_log_resolve (no other change)
-- =============================================================================
CREATE OR REPLACE FUNCTION pds.derive_onyx_dates(
    ts                TIMESTAMPTZ,
    tz_offset_text    TEXT,
    tz_source_in      TEXT
)
RETURNS TABLE (
    onyx_et_date          DATE,
    onyx_behavioral_date  DATE,
    onyx_local_date       DATE,
    onyx_tz_source        TEXT
)
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
    local_instant     TIMESTAMP;
    resolved_offset   INTERVAL;
    resolved_tz       TEXT;
    resolved_source   TEXT;
    cycle_offset_text TEXT;
BEGIN
    IF ts IS NULL THEN
        RETURN QUERY SELECT NULL::DATE, NULL::DATE, NULL::DATE, NULL::TEXT;
        RETURN;
    END IF;

    onyx_et_date := (ts AT TIME ZONE 'America/New_York')::date;

    IF tz_offset_text IS NOT NULL AND tz_offset_text <> '' THEN
        -- Tier 1: the source gave its own offset.
        resolved_offset := tz_offset_text::interval;
        local_instant   := (ts AT TIME ZONE 'UTC') + resolved_offset;
        resolved_source := COALESCE(tz_source_in, 'source_field');
        onyx_local_date      := local_instant::date;
        onyx_behavioral_date := (local_instant - INTERVAL '6 hours')::date;
    ELSE
        cycle_offset_text := pds.cycle_offset_for_instant(ts);
        IF cycle_offset_text IS NOT NULL THEN
            -- Tier 2: WHOOP cycle anchor.
            resolved_offset := cycle_offset_text::interval;
            local_instant   := (ts AT TIME ZONE 'UTC') + resolved_offset;
            resolved_source := COALESCE(tz_source_in, 'cycle_anchor');
            onyx_local_date      := local_instant::date;
            onyx_behavioral_date := (local_instant - INTERVAL '6 hours')::date;
        ELSE
            -- Tier 3+5: user_tz_log, else ET. tz and label both come from
            -- pds.tz_log_resolve, the one place that labels this lookup.
            SELECT r.tz, r.tz_source
              INTO resolved_tz, resolved_source
              FROM pds.tz_log_resolve(ts) AS r;
            resolved_source      := COALESCE(tz_source_in, resolved_source);
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
$function$;

COMMENT ON FUNCTION pds.derive_onyx_dates(TIMESTAMPTZ, TEXT, TEXT) IS
'Per ADR-0001 D1/D2/D3: derives the three onyx_* dates + provenance from a UTC instant. Triggers across source tables call this. Pass tz_offset_text from the source field when available (WHOOP timezone_offset); pass NULL to fall through to the WHOOP cycle anchor, then user_tz_log/ET (labelled by pds.tz_log_resolve). Behavioral day uses the -6h rule matching whoop_journal.behaviors_date. Rows with only a date use pds.derive_onyx_dates_for_day.';


-- =============================================================================
-- 4. pds.journal_entry_onyx_dates: the journal rule, callable on its own
-- =============================================================================
-- entry_date is the behavioral day. written_at (notion_created_at) is trusted
-- as the moment of writing when entry_date equals its ET, local or behavioral
-- date: same ET day; same day where Riley was (abroad); or the post-midnight
-- awake tail (00:30 about the day that just ended). Otherwise the entry was
-- backdated (or forward-dated) and is date-only. Always returns one row.
CREATE OR REPLACE FUNCTION pds.journal_entry_onyx_dates(
    p_entry_date DATE,
    p_written_at TIMESTAMPTZ
)
RETURNS TABLE (
    onyx_et_date          DATE,
    onyx_behavioral_date  DATE,
    onyx_local_date       DATE,
    onyx_tz_source        TEXT
)
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
    d        RECORD;
    realtime BOOLEAN := FALSE;
BEGIN
    IF p_written_at IS NOT NULL THEN
        SELECT * INTO d FROM pds.derive_onyx_dates(p_written_at, NULL, NULL);
        realtime := COALESCE(
            p_entry_date IN (d.onyx_et_date, d.onyx_local_date, d.onyx_behavioral_date),
            FALSE
        );
    END IF;
    IF NOT realtime THEN
        SELECT * INTO d FROM pds.derive_onyx_dates_for_day(p_entry_date);
    END IF;
    RETURN QUERY SELECT d.onyx_et_date, p_entry_date, d.onyx_local_date, d.onyx_tz_source;
END;
$function$;

COMMENT ON FUNCTION pds.journal_entry_onyx_dates(DATE, TIMESTAMPTZ) IS
'journal_entries dating: onyx_behavioral_date = entry_date. written_at (notion_created_at) gives et/local dates and the label when entry_date equals its ET, local or behavioral date (written in real time, also abroad and in the post-midnight awake tail); otherwise the entry was backdated and pds.derive_onyx_dates_for_day(entry_date) applies. Called by the journal_entries trigger; read-only, so it can be checked with a SELECT (sql/tz_derivation_postdeploy_checks.sql).';


-- =============================================================================
-- 5. Date-only call sites (trigger functions; the triggers themselves stay)
-- =============================================================================

-- 5a. habit_journal: cycle_date IS the behavior day. behaviors_date fill and
-- channel routing unchanged (sql/whoop_journal_merge.sql). The frozen WHOOP-era
-- rows are never rewritten (zzz_block_frozen_whoop_era).
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_habit_journal()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    d RECORD;
BEGIN
    NEW.behaviors_date := COALESCE(NEW.behaviors_date, NEW.cycle_date);
    NEW.source := COALESCE(
        (SELECT channel FROM pds.habit_name_map WHERE habit_name = NEW.question),
        COALESCE(NEW.source, 'habit')
    );
    SELECT * INTO d FROM pds.derive_onyx_dates_for_day(NEW.cycle_date);
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$function$;

-- 5b. journal_entries: pds.journal_entry_onyx_dates decides (section 4).
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_journal_entries()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    d RECORD;
BEGIN
    SELECT * INTO d FROM pds.journal_entry_onyx_dates(NEW.entry_date, NEW.notion_created_at);
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$function$;

-- 5c. meal_events: event_date is the behavioral day; event_time when known.
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_meal_events()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    d RECORD;
BEGIN
    NEW.onyx_behavioral_date := NEW.event_date;
    IF NEW.event_time IS NOT NULL THEN
        SELECT * INTO d FROM pds.derive_onyx_dates(NEW.event_time, NULL, NULL);
    ELSE
        SELECT * INTO d FROM pds.derive_onyx_dates_for_day(NEW.event_date);
    END IF;
    NEW.onyx_et_date    := d.onyx_et_date;
    NEW.onyx_local_date := d.onyx_local_date;
    NEW.onyx_tz_source  := d.onyx_tz_source;
    RETURN NEW;
END;
$function$;

-- 5d. supplement_intake: intake_date is the behavioral day; intake_time when
-- known. A retro-logged dose keeps intake_date as its behavioral day either way.
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_supplement_intake()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    d RECORD;
BEGIN
    NEW.onyx_behavioral_date := NEW.intake_date;
    IF NEW.intake_time IS NOT NULL THEN
        SELECT * INTO d FROM pds.derive_onyx_dates(NEW.intake_time, NULL, NULL);
    ELSE
        SELECT * INTO d FROM pds.derive_onyx_dates_for_day(NEW.intake_date);
    END IF;
    NEW.onyx_et_date    := d.onyx_et_date;
    NEW.onyx_local_date := d.onyx_local_date;
    NEW.onyx_tz_source  := d.onyx_tz_source;
    RETURN NEW;
END;
$function$;

-- 5e. cronometer_servings: values cronometer_import.py already set are kept
-- (COALESCE); only missing ones are filled.
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_cronometer_servings()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    d RECORD;
BEGIN
    IF NEW.onyx_behavioral_date IS NULL OR NEW.onyx_et_date IS NULL
       OR NEW.onyx_local_date IS NULL OR NEW.onyx_tz_source IS NULL THEN
        IF NEW.event_time IS NOT NULL THEN
            SELECT * INTO d FROM pds.derive_onyx_dates(NEW.event_time, NULL, 'cronometer_serving');
        ELSE
            SELECT * INTO d FROM pds.derive_onyx_dates_for_day(NEW.calendar_date);
        END IF;
        NEW.onyx_et_date         := COALESCE(NEW.onyx_et_date,         d.onyx_et_date);
        NEW.onyx_behavioral_date := COALESCE(NEW.onyx_behavioral_date, d.onyx_behavioral_date);
        NEW.onyx_local_date      := COALESCE(NEW.onyx_local_date,      d.onyx_local_date);
        NEW.onyx_tz_source       := COALESCE(NEW.onyx_tz_source,       d.onyx_tz_source);
    END IF;
    RETURN NEW;
END;
$function$;

-- 5f. garmin_hrv: Garmin's calendar_date (the wake-up day, in the watch's
-- zone) in all three dates, labelled 'source_field' like eight_sleep_trends.
-- Keep the wake-up-day key: hrv_alignment.py moves garmin_hrv_* one day
-- earlier (PREVIOUS_NIGHT_PREFIXES) and check_alignment fails the retrain if
-- the column sits on the wrong row. See the header, point 3.
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_garmin_hrv()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates_for_day(NEW.calendar_date, 'source_field');
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION pds.set_onyx_dates_garmin_hrv() IS
'garmin_hrv is keyed by Garmin''s calendar_date = the wake-up day (the night before it). All three onyx_* dates = calendar_date, onyx_tz_source = ''source_field''. Deliberate: hrv_alignment.py re-keys garmin_hrv_* one day earlier and its runtime guard checks it, so do not shift these dates here, and do not date the row by start_timestamp (sql/tz_derivation_edge_cases.sql).';

COMMENT ON FUNCTION pds.set_onyx_dates_journal_entries() IS
'journal_entries: the dates come from pds.journal_entry_onyx_dates(entry_date, notion_created_at): onyx_behavioral_date = entry_date; et/local from notion_created_at when the entry was written in real time (ET, local or behavioral date of the instant = entry_date), else entry_date (sql/tz_derivation_edge_cases.sql).';


-- =============================================================================
-- 6. After applying: run sql/tz_derivation_postdeploy_checks.sql (SELECT only).
--    Every row must have passed = true; a NULL means its precondition failed
--    (read the note). It also confirms the live function bodies are exactly
--    the bodies in this file.
-- =============================================================================
