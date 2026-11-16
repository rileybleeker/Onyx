-- =============================================================================
-- TZ derivation follow-ups: WHOOP journal archive trigger + WHOOP transition flag
-- =============================================================================
-- STATUS: staged, NOT applied, and NOT part of the reviewed date-only migration
-- (sql/tz_derivation_edge_cases.sql). Split out on 2026-11-16 so that migration
-- changes only the date-only and journal derivation and leaves the frozen WHOOP
-- journal archive untouched. Each part below needs its own review before anyone
-- applies it:
--   1. set_onyx_dates_whoop_journal: the archive is write-blocked
--      (zzz_block_archive_writes), so this changes no stored row; it only matters
--      if the archive is ever replayed, which AGENTS.md forbids without a separate
--      review of the freeze. It calls pds.derive_onyx_dates_for_day, so it can
--      only be applied after sql/tz_derivation_edge_cases.sql.
--   2. The WHOOP transition-day flag triggers (moved and removed cycles) and the
--      manual repair function. The trigger event list includes row removal,
--      which the Supabase MCP may refuse; use the dashboard SQL editor.
--   3. Comment-only fixes (cycle_offset_for_instant, interval_to_tzd,
--      tz_log_gaps).
-- Before applying: save the live definitions of every object below
-- (pg_get_functiondef, pg_get_triggerdef, obj_description) into a rollback
-- file, as sql/rollback_tz_derivation_2026-11-16.sql does for the main part.
-- Bodies are as staged on 2026-11-14 from the live definitions of that day.
-- =============================================================================


-- =============================================================================
-- 1. WHOOP journal archive trigger
-- =============================================================================
-- whoop_journal (frozen archive). behaviors_date and the cycle pick are
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


-- =============================================================================
-- 2. WHOOP transition-day flag: cover moved and removed cycles
-- =============================================================================
-- 2a. BEFORE trigger: never compare a cycle with its own old row (an UPDATE
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

-- 2b. AFTER trigger: refresh the cycle that follows each changed position
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
'AFTER INSERT / UPDATE OF start_time, timezone_offset / row removal on whoop_cycles: recomputes onyx_is_transition_day of the cycle that follows NEW (and OLD, when start_time moved or the row was removed) against its actual predecessor. One hop: it only writes onyx_is_transition_day, which fires no trigger; pg_trigger_depth() > 1 is a backstop. Full repair: SELECT pds.recompute_whoop_transition_flags(); (sql/tz_derivation_whoop_followups.sql, staged 2026-11-14).';

CREATE OR REPLACE TRIGGER whoop_cycles_refresh_next_transition_day
    AFTER INSERT OR UPDATE OF timezone_offset, start_time OR DELETE
    ON pds.whoop_cycles
    FOR EACH ROW EXECUTE FUNCTION pds.refresh_next_transition_day();

-- 2c. Manual full repair (same LAG() pass as sql/adr_0001_05). Returns how
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
'Manual repair: recomputes every whoop_cycles.onyx_is_transition_day with one LAG() pass (offset differs from the previous cycle''s). Returns the number of flags changed. Run after bulk out-of-order cycle writes (sql/tz_derivation_whoop_followups.sql, staged 2026-11-14).';

REVOKE ALL ON FUNCTION pds.recompute_whoop_transition_flags() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.recompute_whoop_transition_flags() TO service_role;


-- =============================================================================
-- 3. Comments only (no behavior change)
-- =============================================================================
COMMENT ON FUNCTION pds.cycle_offset_for_instant(TIMESTAMPTZ) IS
'Per ADR-0001 D3 tier 2: returns the WHOOP cycle.timezone_offset for ts. Prefers cycles whose [start, end) bracket ts; falls back to the nearest cycle starting within ±18h, main-sleep cycles (≥3h) first, so midday events still get an offset and an arrival nap with the old zone does not outrank the night. NULL when no cycle is within ±18h — caller falls through to user_tz_log.';

COMMENT ON FUNCTION pds.interval_to_tzd(INTERVAL) IS
'Formats an interval as a TZD offset (+HH:MM / -HH:MM). Rounds to the nearest whole minute on purpose (re-audit 2026-06-07 deepseek/F-008): real offsets are whole minutes, so ROUND changes nothing for them, and a stray sub-minute input is rounded rather than truncated toward zero.';

COMMENT ON VIEW pds.tz_log_gaps IS
'Per ADR-0001 drastic-TZ-abroad gap #3: WHOOP cycles whose timezone_offset disagrees with what pds.tz_for_instant returns from user_tz_log. gap_type=''dst_artifact'' when WHOOP offset matches log at cycle start OR end (cycle straddled NY DST transition); gap_type=''travel'' when WHOOP disagrees with both (real trip or forgot-to-log). /status banner filters on gap_type=''travel'' for clean UX; analytical queries can include both via direct SELECT. Offset minutes use ROUND(epoch / 60.0) on purpose (deepseek/F-010): identical to integer division for whole-minute offsets, and never truncates toward zero.';
