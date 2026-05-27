-- =============================================================================
-- ADR-0001 Phase 1, step 4 — onyx_* columns on remaining tables
-- =============================================================================
-- Per docs/adr/0001-timezone-and-behavioral-day-handling.md (D4).
--
-- Sources covered:
--   pds.eight_sleep_trends — date-only; bed is stationary in NY ET
--   pds.spotify_plays      — TIMESTAMPTZ instant (played_at)
--   pds.supplement_intake  — Onyx-owned: behavioral_date already canonical
--                            (intake_date), enrich with instant-derived et/local
--   pds.meal_events        — same pattern as supplement_intake
--   pds.journal_entries    — Notion date-only + notion_created_at instant
--   pds.habit_journal      — date-only; behaviors_date already trigger-derived
--   pds.myfitnesspal_nutrition — date-only; MFP intentionally clock-date
--
-- Depends on: sql/adr_0001_01_user_tz_log.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. eight_sleep_trends — stationary bed, calendar_date is already correct
-- ---------------------------------------------------------------------------
ALTER TABLE pds.eight_sleep_trends
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

CREATE INDEX IF NOT EXISTS idx_eight_sleep_trends_behavioral_date
    ON pds.eight_sleep_trends (onyx_behavioral_date);

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_eight_sleep_trends()
RETURNS TRIGGER AS $$
BEGIN
    -- Bed is stationary in NY ET. Trends are pre-attributed by Eight Sleep
    -- backend (request hard-codes ?tz=America/New_York). All three onyx_*
    -- dates collapse to calendar_date.
    NEW.onyx_et_date         := NEW.calendar_date;
    NEW.onyx_behavioral_date := NEW.calendar_date;
    NEW.onyx_local_date      := NEW.calendar_date;
    NEW.onyx_tz_source       := 'source_field';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS eight_sleep_trends_set_onyx_dates ON pds.eight_sleep_trends;
CREATE TRIGGER eight_sleep_trends_set_onyx_dates
    BEFORE INSERT OR UPDATE OF calendar_date ON pds.eight_sleep_trends
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_eight_sleep_trends();

-- ---------------------------------------------------------------------------
-- 2. spotify_plays — true UTC instant
-- ---------------------------------------------------------------------------
ALTER TABLE pds.spotify_plays
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

CREATE INDEX IF NOT EXISTS idx_spotify_plays_behavioral_date
    ON pds.spotify_plays (onyx_behavioral_date);

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_spotify_plays()
RETURNS TRIGGER AS $$
DECLARE
    d RECORD;
BEGIN
    SELECT * INTO d FROM pds.derive_onyx_dates(NEW.played_at, NULL, NULL);
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_behavioral_date := d.onyx_behavioral_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_tz_source       := d.onyx_tz_source;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS spotify_plays_set_onyx_dates ON pds.spotify_plays;
CREATE TRIGGER spotify_plays_set_onyx_dates
    BEFORE INSERT OR UPDATE OF played_at ON pds.spotify_plays
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_spotify_plays();

-- ---------------------------------------------------------------------------
-- 3. supplement_intake — Onyx-owned behavioral date + optional instant
-- ---------------------------------------------------------------------------
ALTER TABLE pds.supplement_intake
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

CREATE INDEX IF NOT EXISTS idx_supplement_intake_behavioral_date
    ON pds.supplement_intake (onyx_behavioral_date);

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_supplement_intake()
RETURNS TRIGGER AS $$
DECLARE
    d RECORD;
BEGIN
    -- onyx_behavioral_date = the Onyx-owned intake_date (already behavioral
    -- per CLAUDE.md "Supplement intake — behavioral-day convention").
    NEW.onyx_behavioral_date := NEW.intake_date;

    -- If intake_time is captured, derive et/local from it. Otherwise default
    -- to intake_date for both (no instant to project, so the clock-date
    -- assumption is "same day in ET").
    IF NEW.intake_time IS NOT NULL THEN
        SELECT * INTO d FROM pds.derive_onyx_dates(NEW.intake_time, NULL, NULL);
        NEW.onyx_et_date    := d.onyx_et_date;
        NEW.onyx_local_date := d.onyx_local_date;
        NEW.onyx_tz_source  := d.onyx_tz_source;
    ELSE
        NEW.onyx_et_date    := NEW.intake_date;
        NEW.onyx_local_date := NEW.intake_date;
        NEW.onyx_tz_source  := 'default_et_fallback';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supplement_intake_set_onyx_dates ON pds.supplement_intake;
CREATE TRIGGER supplement_intake_set_onyx_dates
    BEFORE INSERT OR UPDATE OF intake_date, intake_time ON pds.supplement_intake
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_supplement_intake();

-- ---------------------------------------------------------------------------
-- 4. meal_events — same pattern as supplement_intake
-- ---------------------------------------------------------------------------
ALTER TABLE pds.meal_events
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

CREATE INDEX IF NOT EXISTS idx_meal_events_behavioral_date
    ON pds.meal_events (onyx_behavioral_date);

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_meal_events()
RETURNS TRIGGER AS $$
DECLARE
    d RECORD;
BEGIN
    NEW.onyx_behavioral_date := NEW.event_date;

    IF NEW.event_time IS NOT NULL THEN
        SELECT * INTO d FROM pds.derive_onyx_dates(NEW.event_time, NULL, NULL);
        NEW.onyx_et_date    := d.onyx_et_date;
        NEW.onyx_local_date := d.onyx_local_date;
        NEW.onyx_tz_source  := d.onyx_tz_source;
    ELSE
        NEW.onyx_et_date    := NEW.event_date;
        NEW.onyx_local_date := NEW.event_date;
        NEW.onyx_tz_source  := 'default_et_fallback';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meal_events_set_onyx_dates ON pds.meal_events;
CREATE TRIGGER meal_events_set_onyx_dates
    BEFORE INSERT OR UPDATE OF event_date, event_time ON pds.meal_events
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_meal_events();

-- ---------------------------------------------------------------------------
-- 5. journal_entries — Notion date-only + notion_created_at instant
-- ---------------------------------------------------------------------------
ALTER TABLE pds.journal_entries
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

CREATE INDEX IF NOT EXISTS idx_journal_entries_behavioral_date
    ON pds.journal_entries (onyx_behavioral_date);

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_journal_entries()
RETURNS TRIGGER AS $$
DECLARE
    d RECORD;
BEGIN
    -- entry_date is user-typed (Notion Date prop, date-only). Treat that as
    -- the canonical behavioral_date. notion_created_at is the underlying
    -- UTC instant when the page was first written — use it to derive et/
    -- local but only when entry_date matches the created_at date (so an
    -- intentional backdated entry doesn't get its et/local overwritten).
    NEW.onyx_behavioral_date := NEW.entry_date;

    IF NEW.notion_created_at IS NOT NULL
       AND NEW.entry_date = (NEW.notion_created_at AT TIME ZONE 'America/New_York')::date
    THEN
        SELECT * INTO d FROM pds.derive_onyx_dates(NEW.notion_created_at, NULL, NULL);
        NEW.onyx_et_date    := d.onyx_et_date;
        NEW.onyx_local_date := d.onyx_local_date;
        NEW.onyx_tz_source  := d.onyx_tz_source;
    ELSE
        NEW.onyx_et_date    := NEW.entry_date;
        NEW.onyx_local_date := NEW.entry_date;
        NEW.onyx_tz_source  := 'default_et_fallback';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_set_onyx_dates ON pds.journal_entries;
CREATE TRIGGER journal_entries_set_onyx_dates
    BEFORE INSERT OR UPDATE OF entry_date, notion_created_at ON pds.journal_entries
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_journal_entries();

-- ---------------------------------------------------------------------------
-- 6. habit_journal — date-only; NO behaviors_date column (only whoop_journal has it)
-- ---------------------------------------------------------------------------
-- Audit assumed habit_journal mirrored whoop_journal's schema, but it
-- doesn't have the behaviors_date column. cycle_date is what the user typed
-- when they tapped — treat it as the behavioral date directly. Forward fix
-- for awake-tail attribution: the api/habits/complete bug fix (UTC -> ET)
-- closes the most common offender; deeper attribution would need a tap-
-- instant timestamp the table doesn't capture.
ALTER TABLE pds.habit_journal
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

CREATE INDEX IF NOT EXISTS idx_habit_journal_behavioral_date
    ON pds.habit_journal (onyx_behavioral_date);

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_habit_journal()
RETURNS TRIGGER AS $$
DECLARE
    noon_et TIMESTAMPTZ;
    log_tz  TEXT;
BEGIN
    NEW.onyx_et_date         := NEW.cycle_date;
    NEW.onyx_behavioral_date := NEW.cycle_date;

    -- Audit P1 fix: previously tagged every row as 'default_et_fallback' and
    -- copied cycle_date into onyx_local_date verbatim — wrong on any travel
    -- day. Anchor at noon ET on cycle_date and consult user_tz_log; if a row
    -- matches and tz is non-NY, the user was in that TZ on this date, so
    -- shift onyx_local_date to the local clock day.
    noon_et := (NEW.cycle_date::timestamp + INTERVAL '12 hours')
               AT TIME ZONE 'America/New_York';

    SELECT tz INTO log_tz
      FROM pds.user_tz_log
     WHERE effective_from <= noon_et
     ORDER BY effective_from DESC
     LIMIT 1;

    IF log_tz IS NOT NULL AND log_tz <> 'America/New_York' THEN
        NEW.onyx_local_date := (noon_et AT TIME ZONE log_tz)::date;
        NEW.onyx_tz_source  := 'user_tz_log';
    ELSE
        NEW.onyx_local_date := NEW.cycle_date;
        NEW.onyx_tz_source  := CASE WHEN log_tz IS NOT NULL
                                    THEN 'user_tz_log'   -- explicit NY hit
                                    ELSE 'default_et_fallback'
                               END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS habit_journal_set_onyx_dates ON pds.habit_journal;
CREATE TRIGGER habit_journal_set_onyx_dates
    BEFORE INSERT OR UPDATE OF cycle_date ON pds.habit_journal
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_habit_journal();

-- ---------------------------------------------------------------------------
-- 7. whoop_journal — same as habit_journal (already has behaviors_date)
-- ---------------------------------------------------------------------------
ALTER TABLE pds.whoop_journal
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

CREATE INDEX IF NOT EXISTS idx_whoop_journal_behavioral_date_onyx
    ON pds.whoop_journal (onyx_behavioral_date);

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
    SELECT (((c.start_time AT TIME ZONE 'UTC') + (c.timezone_offset)::interval - INTERVAL '6 hours'))::date
      INTO NEW.behaviors_date
      FROM pds.whoop_cycles c
     WHERE (((c.start_time AT TIME ZONE 'UTC') + (c.timezone_offset)::interval))::date = NEW.cycle_date
     ORDER BY c.start_time
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

            IF log_tz IS NOT NULL AND log_tz <> 'America/New_York' THEN
                NEW.onyx_local_date := (noon_et AT TIME ZONE log_tz)::date;
                NEW.onyx_tz_source  := 'user_tz_log';
            ELSE
                NEW.onyx_local_date := NEW.cycle_date;
                NEW.onyx_tz_source  := CASE WHEN log_tz IS NOT NULL
                                            THEN 'user_tz_log'
                                            ELSE 'default_et_fallback'
                                       END;
            END IF;
        END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS whoop_journal_set_onyx_dates ON pds.whoop_journal;
-- Fire AFTER the existing behaviors_date trigger so we see its computed value.
CREATE TRIGGER whoop_journal_set_onyx_dates
    BEFORE INSERT OR UPDATE OF cycle_date, behaviors_date ON pds.whoop_journal
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_whoop_journal();

-- ---------------------------------------------------------------------------
-- 8. myfitnesspal_nutrition — clock-date by design (energy balance)
-- ---------------------------------------------------------------------------
ALTER TABLE pds.myfitnesspal_nutrition
    ADD COLUMN IF NOT EXISTS onyx_et_date         DATE,
    ADD COLUMN IF NOT EXISTS onyx_behavioral_date DATE,
    ADD COLUMN IF NOT EXISTS onyx_local_date      DATE,
    ADD COLUMN IF NOT EXISTS onyx_tz_source       TEXT;

CREATE INDEX IF NOT EXISTS idx_myfitnesspal_nutrition_behavioral_date
    ON pds.myfitnesspal_nutrition (onyx_behavioral_date);

CREATE OR REPLACE FUNCTION pds.set_onyx_dates_myfitnesspal_nutrition()
RETURNS TRIGGER AS $$
BEGIN
    -- Per ADR D5, MFP is intentionally clock-date (energy balance semantics).
    -- All three onyx_* dates collapse to calendar_date. Consumers join on
    -- onyx_et_date for energy balance and onyx_behavioral_date for HRV-
    -- adjacent analytics (both = calendar_date here).
    NEW.onyx_et_date         := NEW.calendar_date;
    NEW.onyx_behavioral_date := NEW.calendar_date;
    NEW.onyx_local_date      := NEW.calendar_date;
    NEW.onyx_tz_source       := 'source_field';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mfp_nutrition_set_onyx_dates ON pds.myfitnesspal_nutrition;
CREATE TRIGGER mfp_nutrition_set_onyx_dates
    BEFORE INSERT OR UPDATE OF calendar_date ON pds.myfitnesspal_nutrition
    FOR EACH ROW EXECUTE FUNCTION pds.set_onyx_dates_myfitnesspal_nutrition();

-- ---------------------------------------------------------------------------
-- 9. Backfill all 8 tables (no-op UPDATE fires triggers)
-- ---------------------------------------------------------------------------
UPDATE pds.eight_sleep_trends      SET calendar_date = calendar_date
    WHERE calendar_date IS NOT NULL;
UPDATE pds.spotify_plays           SET played_at = played_at
    WHERE played_at IS NOT NULL;
UPDATE pds.supplement_intake       SET intake_date = intake_date
    WHERE intake_date IS NOT NULL;
UPDATE pds.meal_events             SET event_date = event_date
    WHERE event_date IS NOT NULL;
UPDATE pds.journal_entries         SET entry_date = entry_date
    WHERE entry_date IS NOT NULL;
UPDATE pds.habit_journal           SET cycle_date = cycle_date
    WHERE cycle_date IS NOT NULL;
UPDATE pds.whoop_journal           SET cycle_date = cycle_date
    WHERE cycle_date IS NOT NULL;
UPDATE pds.myfitnesspal_nutrition  SET calendar_date = calendar_date
    WHERE calendar_date IS NOT NULL;
