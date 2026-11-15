-- =============================================================================
-- TZ derivation edge cases + one place for fallback labeling (2026-11-14)
-- =============================================================================
-- Roadmap row "TZ derivation edge-cases + centralize fallback labeling"
-- (Notion 379bf5b4-4bf2-8157-bc24-d0b6a86b878e). Settles the findings the
-- 2026-06-07 re-audit deferred (audit/re-audit-2026-06-07/_findings_digest.md,
-- BUNDLE tz). Bodies below start from the LIVE definitions (pg_get_functiondef,
-- 2026-11-14), not from the older repo files, which had drifted.
--
-- STATUS: written, NOT applied. Only Riley applies migrations. If the Supabase
-- MCP declines it (it scans the text for destructive keywords and this file
-- has a trigger that also fires on row removal), paste it into the dashboard
-- SQL editor instead. Run the DRY RUN block first.
--
-- What changes, in plain words
--   1. One helper decides the label when a TZ comes from pds.user_tz_log:
--      pds.tz_log_resolve(ts) -> (tz, 'user_tz_log' | 'default_et_fallback').
--      derive_onyx_dates (tier 3+5) now calls it. Same results as before.
--   2. One helper for rows that only have a date (no instant):
--      pds.derive_onyx_dates_for_day(date, tz_source_in). All three onyx_*
--      dates are the date itself; the label says whether user_tz_log covered
--      that day. Seven trigger functions used to hand-roll this (three with a
--      noon-ET probe, four with a hard-coded label); all seven call it now.
--      Fixes:
--        * far-east trips (Tokyo, Sydney): the noon-ET probe pushed
--          onyx_local_date one day forward (noon ET = 01:00 next day in
--          Tokyo). The date the row was logged under is now kept.
--          (gemini/F-005)
--        * same-day TZ change: the label is read at the END of the day, so a
--          log row that starts after noon (afternoon landing) still counts.
--          A date-only row has no time of day, so the label is all the TZ
--          affects. (deepseek/F-004)
--        * labels are uniform: meal_events / supplement_intake /
--          journal_entries / cronometer_servings rows without a time used
--          'default_et_fallback' even on days the log covered.
--          (gpt-5/F-005, F-010)
--   3. garmin_hrv: always keyed by Garmin's own calendar_date (the wake-up
--      day) in all three onyx_* dates, labelled 'source_field' like its
--      sibling eight_sleep_trends. Was 'garmin_calendar_date', a label
--      outside the ADR-0001 D6 list (gpt-5/F-001). Dates do not move: the
--      wake-up-day key is deliberate. hrv_alignment.py re-keys garmin_hrv_*
--      one day earlier (PREVIOUS_NIGHT_PREFIXES) and its runtime guard fails
--      the retrain if the column lines up with the wrong row, so shifting the
--      dates here (deepseek/F-003's suggestion) would double-shift the HRV
--      analysis. Live check 2026-11-14: the Garmin sleep with the same
--      calendar_date has onyx_behavioral_date = calendar_date - 1 in 234/237
--      rows, i.e. the reading IS the previous night; the analysis layer
--      handles that. The instant branch (start_timestamp, NULL in 272/272
--      rows) is gone so a future Garmin change cannot mix the two keys.
--      onyx_local_date stays calendar_date: Garmin dates it in the watch's
--      zone, which follows the phone (gpt-5/F-004, kept on purpose).
--   4. journal_entries backdating check: an entry counts as written in real
--      time when entry_date equals the ET, local OR behavioral date of
--      notion_created_at (was: ET date only). Fixes real-time entries
--      written abroad and the 00:30 "about yesterday" awake-tail entries.
--      (gemini/F-003)
--   5. whoop_journal (frozen archive, write-blocked): onyx_local_date is
--      cycle_date (WHOOP's local wake day) instead of the bedtime's clock
--      date, which split one day's answers across two dates depending on a
--      pre- or post-midnight bedtime (gemini/F-004); the dead
--      COALESCE(behaviors_date, ...) is gone (deepseek/F-005). Stored rows
--      cannot be rewritten (zzz_block_archive_writes), so nothing changes in
--      the data; this only matters if the archive is ever replayed.
--   6. WHOOP transition flag (deepseek/F-009): the AFTER trigger now also
--      refreshes the cycle after a row's OLD position when start_time moves,
--      and after a removed row; it compares against the cycle's real
--      predecessor. The BEFORE trigger no longer compares a moved cycle with
--      its own old row. Still one hop, still no cascade (the refresh only
--      sets onyx_is_transition_day, which no trigger listens to).
--      pds.recompute_whoop_transition_flags() is a manual full repair.
--   7. Comments only: cycle_offset_for_instant's comment said +-6h (the body
--      is +-18h since 2026-06-07); interval_to_tzd and tz_log_gaps round to
--      whole minutes on purpose (deepseek/F-008, F-010: real offsets are
--      whole minutes, so ROUND changes nothing for them and never truncates
--      a stray sub-minute value toward zero).
--
-- Already done, nothing here: index on whoop_cycles(start_time) exists
-- (idx_whoop_cycles_start, whoop_schema.sql) (gpt-5/F-007).
--
-- Not touched: pds.daily_health_matrix_behavioral and its matview (no view
-- change, so no matview rebuild), pds.tz_for_instant, derive_onyx_dates tiers
-- 1 and 2, every instant-based trigger.
-- =============================================================================


-- =============================================================================
-- DRY RUN (SELECT only; run before applying). Counts on 2026-11-14 in [].
-- =============================================================================
-- Label a date-only day would get from the new helper:
--   CASE WHEN EXISTS (SELECT 1 FROM pds.user_tz_log u
--                      WHERE u.effective_from <= ((d + 1)::timestamp
--                            AT TIME ZONE 'America/New_York') - INTERVAL '1 microsecond')
--        THEN 'user_tz_log' ELSE 'default_et_fallback' END
--
-- (a) garmin_hrv: label only, dates unchanged            [272 rows]
--   SELECT onyx_tz_source, count(*) FROM pds.garmin_hrv GROUP BY 1;
-- (b) supplement_intake without intake_time: label only   [2370 rows]
--   SELECT onyx_tz_source, count(*) FROM pds.supplement_intake
--    WHERE intake_time IS NULL GROUP BY 1;
-- (c) journal_entries                                      [45 rows: 19 label
--     only; 4 awake-tail entries move et/local +1 day (the clock day they were
--     written) and take the instant's label; 22 unchanged]
--   SELECT je.entry_date, je.onyx_et_date, je.onyx_local_date, je.onyx_tz_source,
--          d.onyx_et_date AS inst_et, d.onyx_local_date AS inst_local,
--          d.onyx_behavioral_date AS inst_beh
--     FROM pds.journal_entries je
--     LEFT JOIN LATERAL pds.derive_onyx_dates(je.notion_created_at, NULL, NULL) d ON TRUE
--    ORDER BY je.entry_date;
-- (d) habit_journal writable rows: no change               [0 of 1081]
-- (e) meal_events / cronometer_servings: no row takes the date-only branch
--     today (meal_events all have event_time; Cronometer rows carry labels
--     from cronometer_import.py, which the trigger keeps)  [0]
-- (f) whoop_cycles transition flags vs a full recompute: all agree [741/741]


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
                     WHERE u.effective_from <= ts
                     ORDER BY u.effective_from DESC
                     LIMIT 1) AS tz) AS hit;
$function$;

COMMENT ON FUNCTION pds.tz_log_resolve(TIMESTAMPTZ) IS
'ADR-0001 D3 tier 3+5 / D6: the TZ in effect at ts per pds.user_tz_log, with its provenance label. A log row in effect -> (row tz, ''user_tz_log''); none -> (''America/New_York'', ''default_et_fallback''). Always one row. The single place these two labels are decided: pds.derive_onyx_dates and pds.derive_onyx_dates_for_day both call it (sql/tz_derivation_edge_cases.sql, 2026-11-14).';


-- =============================================================================
-- 2. pds.derive_onyx_dates_for_day: rows that only carry a date
-- =============================================================================
-- All three onyx_* dates are the date itself: the person or device that wrote
-- the row already chose the day, and projecting it through an instant (the old
-- noon-ET probe) only moved it on far-east trips. The label comes from
-- tz_log_resolve read at the last instant of that ET day, so a log row that
-- takes effect later the same day (afternoon landing) still counts.
-- tz_source_in, when given, overrides the label (same rule as
-- derive_onyx_dates). Always returns one row; a NULL date gives NULLs.
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
'ADR-0001 D6 for date-only rows: onyx_et/behavioral/local_date = the date itself; onyx_tz_source = tz_source_in, else whether user_tz_log covered that day (pds.tz_log_resolve at the end of the ET day, so a same-day TZ change counts). Used by every trigger branch that has no instant: habit_journal, whoop_journal orphans, journal_entries backdated, meal_events / supplement_intake / cronometer_servings without a time, garmin_hrv (sql/tz_derivation_edge_cases.sql, 2026-11-14).';


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
-- 4. Date-only call sites
-- =============================================================================

-- 4a. habit_journal: cycle_date IS the behavior day. behaviors_date fill and
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

-- 4b. whoop_journal (frozen archive). behaviors_date and the cycle pick are
-- unchanged. behaviors_date is never NULL after the fill, so it is the
-- behavioral date directly. onyx_local_date = cycle_date, WHOOP's local wake
-- day, so a pre- or post-midnight bedtime no longer splits a day's answers
-- across two local dates. onyx_et_date still comes from the cycle instant.
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_whoop_journal()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    d                RECORD;
    cycle_start_time TIMESTAMPTZ;
    cycle_tz_offset  TEXT;
BEGIN
    SELECT (((c.start_time AT TIME ZONE 'UTC') + (c.timezone_offset)::interval - INTERVAL '6 hours'))::date
      INTO NEW.behaviors_date
      FROM pds.whoop_cycles c
     WHERE (((c.start_time AT TIME ZONE 'UTC') + (c.timezone_offset)::interval))::date = NEW.cycle_date
     ORDER BY (c.end_time - c.start_time) DESC NULLS LAST, c.start_time DESC
     LIMIT 1;

    IF NEW.behaviors_date IS NULL THEN
        NEW.behaviors_date := NEW.cycle_date;
    END IF;
    NEW.onyx_behavioral_date := NEW.behaviors_date;

    SELECT wc.start_time, wc.timezone_offset
      INTO cycle_start_time, cycle_tz_offset
      FROM pds.whoop_cycles wc
     WHERE ((wc.start_time + INTERVAL '12 hours')
            AT TIME ZONE 'America/New_York')::date = NEW.cycle_date
     ORDER BY (wc.end_time - wc.start_time) DESC NULLS LAST,
              wc.start_time DESC
     LIMIT 1;

    IF cycle_start_time IS NOT NULL THEN
        SELECT * INTO d
          FROM pds.derive_onyx_dates(cycle_start_time, cycle_tz_offset, 'cycle_anchor');
    ELSE
        -- Orphan (no matching cycle): date-only helper.
        SELECT * INTO d FROM pds.derive_onyx_dates_for_day(NEW.cycle_date);
    END IF;
    NEW.onyx_et_date    := d.onyx_et_date;
    NEW.onyx_local_date := NEW.cycle_date;
    NEW.onyx_tz_source  := d.onyx_tz_source;
    RETURN NEW;
END;
$function$;

-- 4c. journal_entries: entry_date is the behavioral day. notion_created_at is
-- trusted as the moment of writing when entry_date matches its ET, local or
-- behavioral date; otherwise the entry was backdated and is date-only.
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_journal_entries()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    d         RECORD;
    realtime  BOOLEAN := FALSE;
BEGIN
    NEW.onyx_behavioral_date := NEW.entry_date;
    IF NEW.notion_created_at IS NOT NULL THEN
        SELECT * INTO d FROM pds.derive_onyx_dates(NEW.notion_created_at, NULL, NULL);
        realtime := COALESCE(
            NEW.entry_date IN (d.onyx_et_date, d.onyx_local_date, d.onyx_behavioral_date),
            FALSE
        );
    END IF;
    IF NOT realtime THEN
        SELECT * INTO d FROM pds.derive_onyx_dates_for_day(NEW.entry_date);
    END IF;
    NEW.onyx_et_date    := d.onyx_et_date;
    NEW.onyx_local_date := d.onyx_local_date;
    NEW.onyx_tz_source  := d.onyx_tz_source;
    RETURN NEW;
END;
$function$;

-- 4d. meal_events: event_date is the behavioral day; event_time when known.
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

-- 4e. supplement_intake: intake_date is the behavioral day; intake_time when known.
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

-- 4f. cronometer_servings: values cronometer_import.py already set are kept
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

-- 4g. garmin_hrv: Garmin's calendar_date (the wake-up day, in the watch's
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
'garmin_hrv is keyed by Garmin''s calendar_date = the wake-up day (the night before it). All three onyx_* dates = calendar_date, onyx_tz_source = ''source_field''. Deliberate: hrv_alignment.py re-keys garmin_hrv_* one day earlier and its runtime guard checks it, so do not shift these dates here (sql/tz_derivation_edge_cases.sql, 2026-11-14).';

COMMENT ON FUNCTION pds.set_onyx_dates_journal_entries() IS
'journal_entries: onyx_behavioral_date = entry_date. notion_created_at gives et/local dates when entry_date equals its ET, local or behavioral date (written in real time, also abroad and in the post-midnight awake tail); otherwise the entry was backdated and pds.derive_onyx_dates_for_day(entry_date) applies (sql/tz_derivation_edge_cases.sql, 2026-11-14).';


-- =============================================================================
-- 5. WHOOP transition-day flag: cover moved and removed cycles
-- =============================================================================
-- 5a. BEFORE trigger: never compare a cycle with its own old row (an UPDATE
-- that moves start_time later used to find itself as the previous cycle).
CREATE OR REPLACE FUNCTION pds.set_whoop_cycles_transition_flag()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    prev_offset TEXT;
BEGIN
    SELECT timezone_offset INTO prev_offset
      FROM pds.whoop_cycles
     WHERE start_time < NEW.start_time
       AND cycle_id <> NEW.cycle_id
     ORDER BY start_time DESC
     LIMIT 1;

    NEW.onyx_is_transition_day :=
        prev_offset IS NOT NULL
        AND NEW.timezone_offset IS NOT NULL
        AND prev_offset <> NEW.timezone_offset;
    RETURN NEW;
END;
$function$;

-- 5b. AFTER trigger: refresh the cycle that follows each changed position
-- (NEW; plus OLD when start_time moved or the row was removed), comparing it
-- with its actual predecessor. For a plain insert or update this is the same
-- comparison as before (the predecessor of NEW's successor is NEW). The
-- refresh writes only onyx_is_transition_day, which no trigger listens to, so
-- there is no chain; the pg_trigger_depth guard stays as a backstop.
CREATE OR REPLACE FUNCTION pds.refresh_next_transition_day()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    anchors      TIMESTAMPTZ[];
    anchor       TIMESTAMPTZ;
    next_id      BIGINT;
    next_start   TIMESTAMPTZ;
    next_off     TEXT;
    prev_off     TEXT;
    correct_flag BOOLEAN;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'DELETE' THEN
        anchors := ARRAY[OLD.start_time];
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.start_time IS DISTINCT FROM NEW.start_time THEN
            anchors := ARRAY[NEW.start_time, OLD.start_time];
        ELSE
            anchors := ARRAY[NEW.start_time];
        END IF;
    ELSE
        anchors := ARRAY[NEW.start_time];
    END IF;

    FOREACH anchor IN ARRAY anchors LOOP
        SELECT cycle_id, start_time, timezone_offset
          INTO next_id, next_start, next_off
          FROM pds.whoop_cycles
         WHERE start_time > anchor
         ORDER BY start_time ASC
         LIMIT 1;
        CONTINUE WHEN next_id IS NULL;

        SELECT timezone_offset INTO prev_off
          FROM pds.whoop_cycles
         WHERE start_time < next_start
         ORDER BY start_time DESC
         LIMIT 1;

        correct_flag := (prev_off IS NOT NULL
                         AND next_off IS NOT NULL
                         AND prev_off <> next_off);
        UPDATE pds.whoop_cycles
           SET onyx_is_transition_day = correct_flag
         WHERE cycle_id = next_id
           AND onyx_is_transition_day IS DISTINCT FROM correct_flag;
    END LOOP;

    RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION pds.refresh_next_transition_day() IS
'AFTER INSERT / UPDATE OF start_time, timezone_offset / row removal on whoop_cycles: recomputes onyx_is_transition_day of the cycle that follows NEW (and OLD, when start_time moved or the row was removed) against its actual predecessor. One hop: it only writes onyx_is_transition_day, which fires no trigger; pg_trigger_depth() > 1 is a backstop. Full repair: SELECT pds.recompute_whoop_transition_flags(); (sql/tz_derivation_edge_cases.sql, 2026-11-14).';

CREATE OR REPLACE TRIGGER whoop_cycles_refresh_next_transition_day
    AFTER INSERT OR UPDATE OF timezone_offset, start_time OR DELETE
    ON pds.whoop_cycles
    FOR EACH ROW EXECUTE FUNCTION pds.refresh_next_transition_day();

-- 5c. Manual full repair (same LAG() pass as sql/adr_0001_05). Returns how
-- many flags it changed; 0 means every flag was already right. Writes only
-- onyx_is_transition_day, so no trigger fires. Riley / service role only.
CREATE OR REPLACE FUNCTION pds.recompute_whoop_transition_flags()
RETURNS INTEGER
LANGUAGE plpgsql
AS $function$
DECLARE
    changed INTEGER;
BEGIN
    WITH flagged AS (
        SELECT cycle_id,
               (LAG(timezone_offset) OVER (ORDER BY start_time) IS NOT NULL
                AND timezone_offset IS NOT NULL
                AND LAG(timezone_offset) OVER (ORDER BY start_time) <> timezone_offset) AS correct_flag
          FROM pds.whoop_cycles
    )
    UPDATE pds.whoop_cycles wc
       SET onyx_is_transition_day = f.correct_flag
      FROM flagged f
     WHERE wc.cycle_id = f.cycle_id
       AND wc.onyx_is_transition_day IS DISTINCT FROM f.correct_flag;
    GET DIAGNOSTICS changed = ROW_COUNT;
    RETURN changed;
END;
$function$;

COMMENT ON FUNCTION pds.recompute_whoop_transition_flags() IS
'Manual repair: recomputes every whoop_cycles.onyx_is_transition_day with one LAG() pass (offset differs from the previous cycle''s). Returns the number of flags changed. Run after bulk out-of-order cycle writes (sql/tz_derivation_edge_cases.sql, 2026-11-14).';

REVOKE ALL ON FUNCTION pds.recompute_whoop_transition_flags() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.recompute_whoop_transition_flags() TO service_role;


-- =============================================================================
-- 6. Comments only (no behavior change)
-- =============================================================================
COMMENT ON FUNCTION pds.cycle_offset_for_instant(TIMESTAMPTZ) IS
'Per ADR-0001 D3 tier 2: returns the WHOOP cycle.timezone_offset for ts. Prefers cycles whose [start, end) bracket ts; falls back to the nearest cycle starting within ±18h, main-sleep cycles (≥3h) first, so midday events still get an offset and an arrival nap with the old zone does not outrank the night. NULL when no cycle is within ±18h — caller falls through to user_tz_log.';

COMMENT ON FUNCTION pds.interval_to_tzd(INTERVAL) IS
'Formats an interval as a TZD offset (+HH:MM / -HH:MM). Rounds to the nearest whole minute on purpose (re-audit 2026-06-07 deepseek/F-008): real offsets are whole minutes, so ROUND changes nothing for them, and a stray sub-minute input is rounded rather than truncated toward zero.';

COMMENT ON VIEW pds.tz_log_gaps IS
'Per ADR-0001 drastic-TZ-abroad gap #3: WHOOP cycles whose timezone_offset disagrees with what pds.tz_for_instant returns from user_tz_log. gap_type=''dst_artifact'' when WHOOP offset matches log at cycle start OR end (cycle straddled NY DST transition); gap_type=''travel'' when WHOOP disagrees with both (real trip or forgot-to-log). /status banner filters on gap_type=''travel'' for clean UX; analytical queries can include both via direct SELECT. Offset minutes use ROUND(epoch / 60.0) on purpose (deepseek/F-010): identical to integer division for whole-minute offsets, and never truncates toward zero.';


-- =============================================================================
-- 7. Re-derive the rows whose stored values change (fires the triggers above)
-- =============================================================================
-- Dates stay the same except the 4 journal_entries awake-tail rows (DRY RUN c).
-- None of these tables feeds the matrix by label, and none is watched by
-- hrv_backfill_check, so no HRV retrain is triggered. habit_journal,
-- whoop_journal, meal_events and cronometer_servings need no pass (DRY RUN d, e).
UPDATE pds.garmin_hrv
   SET calendar_date = calendar_date;

UPDATE pds.supplement_intake
   SET intake_date = intake_date
 WHERE intake_time IS NULL;

UPDATE pds.journal_entries
   SET entry_date = entry_date;


-- =============================================================================
-- 8. Smoke checks after applying (SELECT only)
-- =============================================================================
-- SELECT * FROM pds.tz_log_resolve('2026-05-01 12:00+00');
--   -> Europe/Madrid, user_tz_log
-- SELECT * FROM pds.tz_log_resolve('2024-01-01 12:00+00');
--   -> America/New_York, default_et_fallback
-- SELECT * FROM pds.derive_onyx_dates_for_day('2026-05-01');
--   -> 2026-05-01 x3, user_tz_log
-- SELECT * FROM pds.derive_onyx_dates_for_day('2024-04-05');
--   -> 2024-04-05 x3, user_tz_log (first log row starts 23:18 ET that day:
--      the end-of-day read sees it; the old noon probe did not)
-- SELECT * FROM pds.derive_onyx_dates_for_day(NULL);
--   -> NULL x4
-- SELECT onyx_tz_source, count(*) FROM pds.garmin_hrv GROUP BY 1;
--   -> source_field 272
-- SELECT onyx_tz_source, count(*) FROM pds.supplement_intake
--  WHERE intake_time IS NULL GROUP BY 1;
--   -> user_tz_log 2370
-- SELECT onyx_tz_source, count(*) FROM pds.journal_entries GROUP BY 1;
--   -> cycle_anchor 11, user_tz_log 19, default_et_fallback 15
-- SELECT pds.recompute_whoop_transition_flags();
--   -> 0
