-- =============================================================================
-- ROLLBACK for sql/tz_derivation_whoop_followups.sql (written 2026-11-17)
-- =============================================================================
-- Restores the CURRENT definitions of everything the staged WHOOP follow-up
-- file replaces, taken from the migrations that created them:
--   * pds.set_onyx_dates_whoop_journal()      <- sql/adr_0001_04_other_onyx_dates.sql
--   * pds.set_whoop_cycles_transition_flag()  <- sql/adr_0001_05_transition_day_flag.sql
--   * pds.refresh_next_transition_day()       <- sql/adr_0001_05_transition_day_flag.sql
--     and its trigger whoop_cycles_refresh_next_transition_day (back to
--     AFTER INSERT OR UPDATE OF timezone_offset, start_time, with no DELETE event)
--   * comments of pds.cycle_offset_for_instant, pds.interval_to_tzd and the
--     pds.tz_log_gaps view (from sql/adr_0001_01, _03 and _06)
-- It also removes the one object the follow-up file creates,
-- pds.recompute_whoop_transition_flags(), which has no earlier definition.
--
-- Use it only after the follow-up file has been applied and must be reverted.
-- It changes no stored row: it puts back trigger behaviour only. Rows the
-- follow-up already wrote keep their values until their next write.
--
-- Run it in the Supabase dashboard SQL editor, not through the MCP, because
-- the final statement is one the MCP refuses. Before any apply, save the live
-- definitions (pg_get_functiondef, pg_get_triggerdef, obj_description). The
-- bodies here come from the source files, so compare them with those first.
-- =============================================================================


-- 1. Trigger: back to the AFTER trigger without the DELETE event.
CREATE OR REPLACE TRIGGER whoop_cycles_refresh_next_transition_day
    AFTER INSERT OR UPDATE OF timezone_offset, start_time
    ON pds.whoop_cycles
    FOR EACH ROW EXECUTE FUNCTION pds.refresh_next_transition_day();


-- 2. Functions as in sql/adr_0001_05_transition_day_flag.sql.
CREATE OR REPLACE FUNCTION pds.set_whoop_cycles_transition_flag()
RETURNS TRIGGER AS $$
DECLARE
    prev_offset TEXT;
    next_cycle  RECORD;
BEGIN
    SELECT timezone_offset INTO prev_offset
    FROM pds.whoop_cycles
    WHERE start_time < NEW.start_time
    ORDER BY start_time DESC
    LIMIT 1;

    NEW.onyx_is_transition_day :=
        prev_offset IS NOT NULL
        AND NEW.timezone_offset IS NOT NULL
        AND prev_offset <> NEW.timezone_offset;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pds.refresh_next_transition_day()
RETURNS TRIGGER AS $$
DECLARE
    next_id      BIGINT;
    next_off     TEXT;
    correct_flag BOOLEAN;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    SELECT cycle_id, timezone_offset
      INTO next_id, next_off
      FROM pds.whoop_cycles
     WHERE start_time > NEW.start_time
     ORDER BY start_time ASC
     LIMIT 1;

    IF next_id IS NOT NULL THEN
        correct_flag := (NEW.timezone_offset IS NOT NULL
                         AND next_off IS NOT NULL
                         AND NEW.timezone_offset <> next_off);
        UPDATE pds.whoop_cycles
           SET onyx_is_transition_day = correct_flag
         WHERE cycle_id = next_id
           AND onyx_is_transition_day IS DISTINCT FROM correct_flag;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION pds.refresh_next_transition_day() IS NULL;


-- 3. Function as in sql/adr_0001_04_other_onyx_dates.sql (whoop_journal archive trigger).
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_whoop_journal()
RETURNS TRIGGER AS $$
DECLARE
    d                RECORD;
    cycle_start_time TIMESTAMPTZ;
    cycle_tz_offset  TEXT;
BEGIN
    -- Audit re-2026-05-26 P2 (trigger order cluster): the standalone
    -- behaviors_date trigger has been merged into this function so we no
    -- longer depend on alphabetical BEFORE-trigger ordering. The formula
    -- is the same as the dropped pds.compute_journal_behaviors_date so
    -- behaviors_date values are preserved verbatim.
    -- Re-audit 2026-06-07: order by longest cycle (real night sleep) DESC, not
    -- earliest start, so a transition-day arrival nap doesn't win the behaviors
    -- date. Matches the longest-cycle pick used for the onyx_* anchor below.
    -- Applied via Supabase migration 2026-06-07.
    SELECT (((c.start_time AT TIME ZONE 'UTC') + (c.timezone_offset)::interval - INTERVAL '6 hours'))::date
      INTO NEW.behaviors_date
      FROM pds.whoop_cycles c
     WHERE (((c.start_time AT TIME ZONE 'UTC') + (c.timezone_offset)::interval))::date = NEW.cycle_date
     ORDER BY (c.end_time - c.start_time) DESC NULLS LAST, c.start_time DESC
     LIMIT 1;

    IF NEW.behaviors_date IS NULL THEN
        NEW.behaviors_date := NEW.cycle_date;
    END IF;

    -- Audit P0 fix: pre-fix version set onyx_et_date := NEW.cycle_date and
    -- onyx_local_date := NEW.cycle_date, which silently mis-attributes on
    -- travel days. WHOOP's cycle_date is the user-local wake day; on a PT
    -- trip a 22:00 PT bedtime → cycle_date 2026-04-16 PT, but the ET clock
    -- day of that bedtime instant is 2026-04-16 too (often) or 2026-04-15
    -- (rarely). The pre-fix used PT-labeled date as both onyx_et_date and
    -- onyx_local_date — only one of those is wrong, but consumers can't
    -- tell which.
    --
    -- Fix: look up the cycle anchored to NEW.cycle_date and call
    -- pds.derive_onyx_dates with cycle.start_time + cycle.timezone_offset.
    -- Join key is (start_time + 12h) ET — the +12h trick maps any bedtime
    -- to its WHOOP-canonical wake day regardless of TZ (12h > any TZ
    -- offset, so always crosses midnight ET into the wake day, matching
    -- WHOOP CSV's cycle_date labeling).
    -- Audit re-2026-05-26 P2: pick the LONGEST cycle (real night sleep), not
    -- the earliest. Transition days have an "arrival nap" + main cycle that
    -- both map to the same cycle_date via the +12h-ET rule; the nap's
    -- timezone_offset is the OLD zone and would anchor the journal to the
    -- wrong TZ. Matches daily_health_matrix_behavioral's longest-cycle pick.
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
        NEW.onyx_et_date         := d.onyx_et_date;
        NEW.onyx_local_date      := d.onyx_local_date;
        -- behaviors_date (when the older trigger has computed it) wins for
        -- behavioral_date — that's the explicit user-typed answer to "what
        -- day are these behaviors about?" — fall back to derive's value
        -- otherwise.
        NEW.onyx_behavioral_date := COALESCE(NEW.behaviors_date, d.onyx_behavioral_date);
        NEW.onyx_tz_source       := d.onyx_tz_source;
    ELSE
        -- Orphaned journal entry (no matching cycle). TZ-aware fallback
        -- (audit P1, paired with the habit_journal fix): anchor at noon ET
        -- on cycle_date, consult user_tz_log so onyx_local_date reflects
        -- the user's TZ that day rather than blindly copying cycle_date.
        DECLARE
            noon_et TIMESTAMPTZ;
            log_tz  TEXT;
        BEGIN
            NEW.onyx_et_date         := NEW.cycle_date;
            NEW.onyx_behavioral_date := COALESCE(NEW.behaviors_date, NEW.cycle_date);

            noon_et := (NEW.cycle_date::timestamp + INTERVAL '12 hours')
                       AT TIME ZONE 'America/New_York';

            SELECT tz INTO log_tz
              FROM pds.user_tz_log
             WHERE effective_from <= noon_et
             ORDER BY effective_from DESC
             LIMIT 1;

            -- Re-audit 2026-06-07: prod collapsed the explicit-NY case back to
            -- 'user_tz_log' (a user_tz_log row matched, NY or not) — the
            -- 'user_tz_log_et' sub-label was dropped here. Applied via Supabase
            -- migration 2026-06-07.
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
        END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- 4. Comments as they were before the follow-up file.
COMMENT ON FUNCTION pds.cycle_offset_for_instant(TIMESTAMPTZ) IS
'Per ADR-0001 D3 tier 2: returns the WHOOP cycle.timezone_offset for ts. Prefers cycles whose [start, end) bracket ts; falls back to the nearest main-sleep cycle within ±18h so midday events still get an offset. NULL when no cycle is within ±18h — caller falls through to user_tz_log.';

COMMENT ON FUNCTION pds.interval_to_tzd(INTERVAL) IS
'Formats a signed INTERVAL as TZD string (+HH:MM / -HH:MM). Used to convert the (start_time_local - start_time_gmt) delta on garmin_activities into the format derive_onyx_dates expects.';

COMMENT ON VIEW pds.tz_log_gaps IS
'Per ADR-0001 drastic-TZ-abroad gap #3: WHOOP cycles whose timezone_offset disagrees with what pds.tz_for_instant returns from user_tz_log. gap_type=''dst_artifact'' when WHOOP offset matches log at cycle start OR end (cycle straddled NY DST transition); gap_type=''travel'' when WHOOP disagrees with both (real trip or forgot-to-log). /status banner filters on gap_type=''travel'' for clean UX; analytical queries can include both via direct SELECT.';


-- 5. Remove the object the follow-up file creates (no earlier definition).
DROP FUNCTION IF EXISTS pds.recompute_whoop_transition_flags();
