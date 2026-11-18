-- ============================================================================
-- Sleep wind-down streak (PROD-SLEEP-01, 2026-11-16)
-- ============================================================================
-- Riley chose progress and streaks as the incentive for a better evening
-- routine. Opt-in: nothing here exists until he picks a habit and a target
-- time on the Log screen. Rules and screens: docs/sleep-winddown.md.
--
-- The CANONICAL record of a night is the chosen habit's row in
-- pds.habit_journal (cycle_date = the behavioral day the evening belongs to,
-- answer 'Yes' / 'No', no row = not answered). The check-in, the /habits
-- heatmap, chat and the wind-down button all write that same row, so there is
-- one record per habit and night and a repeated tap cannot count twice. The
-- tables below hold only what habit_journal cannot:
--
--   pds.sleep_winddown_rules     the goal, one row per version, append-only:
--                                habit (Notion page id + its name then),
--                                target time (local wall clock), the zone it
--                                was set in, wins needed in N eligible
--                                nights, rule version. A version applies from
--                                its effective_from night on; earlier nights
--                                keep the version they had.
--   pds.sleep_winddown_pauses    planned pauses (start tonight or later; an
--                                open end = until resumed). Paused nights are
--                                left out of every count, never counted won.
--   pds.sleep_winddown_starts    when "Started wind-down" was tapped for a
--                                night (server clock, local wall clock where
--                                Riley was, the rule in force, the habit that
--                                rule named): shown against the target time.
--                                A start is bound to the habit it was tapped
--                                under: after the goal names another habit it
--                                is ignored, never shown or judged. Never
--                                written by a report made after the night.
--   pds.sleep_winddown_ops       one row per tap (the id the screen made for
--                                it): 'applied' with the answer given back, or
--                                'cancelled' when Riley stopped a tap whose
--                                outcome was unknown. Append-only. It is what
--                                makes a repeated request a true replay (the
--                                same result, no new write, even after the
--                                answer was changed elsewhere) and what keeps a
--                                cancelled request that is still on its way
--                                from landing later.
-- "Hide from Today" is a layout choice: the UI preference sleep.winddown
-- (pds.ui_preferences), not a table here.
--
-- Writes go through the functions below (service role, called by the
-- owner-session routes under /api/sleep/winddown). Opening a page never
-- calls them. Custom SQLSTATEs, mapped to messages in
-- frontend/src/lib/sleep-winddown.ts (WINDDOWN_DB_ERRORS):
--   OXW01 goal version dated before tonight   OXW02 goal history is kept as is
--   OXW10 the screen's day is over            OXW11 that night has not started
--   OXW12 older than the answer window        OXW13 not set up for that night
--   OXW14 the chosen habit is gone            OXW15 the answer changed elsewhere
--   OXW16 the goal changed since the tap was made
--   OXW17 that tap was cancelled before it landed
--   OXW20 pause starting on a past night      OXW21 pause ends before it starts
--   OXW22 overlaps another pause              OXW23 no such pause
--   OXW24 a past night's pause cannot change
--
-- SERVICE ROLE ONLY: RLS on, no policies, nothing granted to anon or
-- authenticated. Additive only (new objects; CREATE OR REPLACE). Rollback:
-- the app reads these tables only through /api/sleep/winddown; reverting the
-- code leaves them unused (no other object depends on them), and the habit
-- rows the button wrote stay ordinary habit answers.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.sleep_winddown_rules (
    rule_id         BIGSERIAL PRIMARY KEY,
    effective_from  DATE NOT NULL,
    habit_page_id   TEXT NOT NULL CHECK (habit_page_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    habit_name      TEXT NOT NULL CHECK (length(habit_name) BETWEEN 1 AND 300),
    habit_category  TEXT CHECK (habit_category IS NULL OR length(habit_category) <= 100),
    target_time     TEXT NOT NULL CHECK (target_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    tz              TEXT NOT NULL CHECK (length(tz) BETWEEN 1 AND 64),
    wins_needed     SMALLINT NOT NULL CHECK (wins_needed BETWEEN 1 AND 14),
    window_nights   SMALLINT NOT NULL CHECK (window_nights BETWEEN 3 AND 14),
    rule_version    SMALLINT NOT NULL DEFAULT 1 CHECK (rule_version >= 1),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sleep_winddown_rules_goal_check CHECK (wins_needed <= window_nights)
);
CREATE INDEX IF NOT EXISTS idx_sleep_winddown_rules_from ON pds.sleep_winddown_rules (effective_from, rule_id);

CREATE TABLE IF NOT EXISTS pds.sleep_winddown_pauses (
    pause_id    BIGSERIAL PRIMARY KEY,
    start_date  DATE NOT NULL,
    end_date    DATE,                  -- inclusive; NULL = until resumed
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at    TIMESTAMPTZ,           -- when Resume closed it
    removed_at  TIMESTAMPTZ,           -- cancelled before its first night
    CONSTRAINT sleep_winddown_pauses_range_check CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_sleep_winddown_pauses_start ON pds.sleep_winddown_pauses (start_date);

CREATE TABLE IF NOT EXISTS pds.sleep_winddown_starts (
    night       DATE PRIMARY KEY,
    started_at  TIMESTAMPTZ NOT NULL,
    local_time  TEXT NOT NULL CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    tz          TEXT NOT NULL CHECK (length(tz) BETWEEN 1 AND 64),
    rule_id     BIGINT REFERENCES pds.sleep_winddown_rules (rule_id),
    habit_page_id TEXT,                 -- the habit the goal named when the tap was made: a start never transfers to another habit
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tables created before habit_page_id was added to this file lack the column (idempotent).
ALTER TABLE pds.sleep_winddown_starts ADD COLUMN IF NOT EXISTS habit_page_id TEXT;

-- One row per tap, keyed by the id the screen made for it. A tap is retried with
-- the SAME id until the server answers, so a lost answer never writes twice and a
-- replay returns what the first request returned. Riley's Cancel on a tap whose
-- outcome is unknown writes a 'cancelled' row (or finds the 'applied' one): a
-- request with that id that reaches the server later is refused (OXW17).
CREATE TABLE IF NOT EXISTS pds.sleep_winddown_ops (
    op_id       UUID PRIMARY KEY,
    night       DATE NOT NULL,
    state       TEXT NOT NULL CHECK (state IN ('applied', 'cancelled')),
    result      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((state = 'applied') = (result IS NOT NULL))
);

COMMENT ON TABLE pds.sleep_winddown_rules IS
    'Wind-down goal versions (PROD-SLEEP-01), append-only. A version applies from effective_from on; the night record itself is the habit''s pds.habit_journal row.';
COMMENT ON TABLE pds.sleep_winddown_pauses IS
    'Planned wind-down pauses: paused nights are left out of every count. Start tonight or later; past nights keep their pause state.';
COMMENT ON TABLE pds.sleep_winddown_starts IS
    'When Started wind-down was tapped for a night (server clock; wall clock where Riley was). Shown against the target time, never counted.';
COMMENT ON TABLE pds.sleep_winddown_ops IS
    'One row per wind-down tap, by the id the screen made for it: applied (a repeat replays its result) or cancelled (a late arrival is refused). Append-only; a few rows a day.';

-- ---------------------------------------------------------------------------
-- 2. Guards: goal history is append-only; past nights keep their pause state
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.sleep_winddown_rules_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.effective_from < pds.behavioral_today_now() THEN
            RAISE EXCEPTION 'a goal version applies from tonight on' USING ERRCODE = 'OXW01';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'wind-down goal versions are kept as they were' USING ERRCODE = 'OXW02';
END $$;

CREATE OR REPLACE TRIGGER sleep_winddown_rules_guard
    BEFORE INSERT OR UPDATE OR DELETE ON pds.sleep_winddown_rules
    FOR EACH ROW EXECUTE FUNCTION pds.sleep_winddown_rules_guard();

CREATE OR REPLACE FUNCTION pds.sleep_winddown_pauses_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    v_today date := pds.behavioral_today_now();
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.start_date < v_today THEN
            RAISE EXCEPTION 'a pause starts tonight or later' USING ERRCODE = 'OXW20';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a pause is ended or cancelled, never removed' USING ERRCODE = 'OXW24';
    END IF;
    IF NEW.start_date <> OLD.start_date THEN
        RAISE EXCEPTION 'a pause is ended or cancelled, never rewritten' USING ERRCODE = 'OXW24';
    END IF;
    -- Nights before tonight keep the paused state they had.
    IF OLD.start_date < v_today THEN
        IF (OLD.removed_at IS NULL) <> (NEW.removed_at IS NULL)
           OR LEAST(COALESCE(OLD.end_date, 'infinity'::date), v_today - 1)
              <> LEAST(COALESCE(NEW.end_date, 'infinity'::date), v_today - 1) THEN
            RAISE EXCEPTION 'nights that already passed keep their pause state' USING ERRCODE = 'OXW24';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER sleep_winddown_pauses_guard
    BEFORE INSERT OR UPDATE OR DELETE ON pds.sleep_winddown_pauses
    FOR EACH ROW EXECUTE FUNCTION pds.sleep_winddown_pauses_guard();

-- ---------------------------------------------------------------------------
-- 3. A new goal version, from tonight on (Log: Start / Save goal)
-- ---------------------------------------------------------------------------
-- Every field is Riley's choice; nothing is assumed. The habit must be one
-- Onyx knows (pds.habit_name_map); its name and category are kept with the
-- version so the history stays readable after a rename.
CREATE OR REPLACE FUNCTION pds.sleep_winddown_add_rule(
    p_habit_page_id text, p_target_time text, p_tz text,
    p_wins_needed integer, p_window_nights integer, p_today date)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    v_today    date := pds.behavioral_today_now();
    v_name     text;
    v_category text;
    r          pds.sleep_winddown_rules%ROWTYPE;
BEGIN
    IF p_today IS NOT NULL AND p_today <> v_today THEN
        RAISE EXCEPTION 'a new day started' USING ERRCODE = 'OXW10';
    END IF;
    SELECT habit_name INTO v_name FROM pds.habit_name_map WHERE notion_page_id = p_habit_page_id;
    IF v_name IS NULL THEN
        RAISE EXCEPTION 'the chosen habit is not in Onyx' USING ERRCODE = 'OXW14';
    END IF;
    SELECT category INTO v_category FROM pds.habit_metadata_history
     WHERE notion_page_id = p_habit_page_id AND valid_to IS NULL
     ORDER BY valid_from DESC LIMIT 1;
    INSERT INTO pds.sleep_winddown_rules
        (effective_from, habit_page_id, habit_name, habit_category, target_time, tz, wins_needed, window_nights)
    VALUES (v_today, p_habit_page_id, v_name, v_category, p_target_time, p_tz, p_wins_needed, p_window_nights)
    RETURNING * INTO r;
    RETURN to_jsonb(r);
END $$;

-- ---------------------------------------------------------------------------
-- 4. Answer one night (the button on Today / Log, the "Did it / Didn't" rows)
-- ---------------------------------------------------------------------------
-- p_night   the behavioral day the evening belongs to (today or the 2 before:
--           the check-in's window; older nights are corrected on /habits)
-- p_answer  'Yes' | 'No' | NULL (NULL = clear: not answered)
-- p_expect  the answer the screen showed ('Yes' | 'No' | 'none'), or NULL for
--           no check. A different stored answer refuses (OXW15) unless it is
--           already the requested one: a repeated request is a no-op. The check
--           also holds when there was no row yet: a row the check-in or Habits
--           inserted in the meantime is never overwritten.
-- p_today   the behavioral today the screen was drawn with (OXW10 when over)
-- p_rule_id the goal version the screen showed for that night (NULL = no
--           check). When another version applies to the night now (the goal was
--           changed from another device or tab), the tap refuses (OXW16): an
--           old tap can never complete a different habit than the one it showed.
-- p_op_id   the id the screen made for this tap (NULL = none). A request whose id
--           is already 'applied' is a replay: it returns that first result with
--           replayed = true and writes nothing, even when the answer was changed
--           elsewhere since (a lost answer must never restore a cleared one). An
--           id that was cancelled refuses (OXW17). Checked before any other rule,
--           under the same lock as the cancel function.
-- Writes the habit_journal row and, for a Yes this call wrote on tonight when
-- there was no answer before, the start time (the first tap wins: a replay or a
-- later correction keeps it, and records none). A clear or a No removes the
-- start time.
CREATE OR REPLACE FUNCTION pds.sleep_winddown_set_night(p_night date, p_answer text, p_expect text, p_today date, p_rule_id bigint DEFAULT NULL, p_op_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    v_today    date := pds.behavioral_today_now();
    r          pds.sleep_winddown_rules%ROWTYPE;
    v_question text;
    v_channel  text;
    v_category text;
    v_current  text;
    v_prior    text;
    v_changed  boolean := false;
    v_rows     integer;
    v_tz       text;
    s          pds.sleep_winddown_starts%ROWTYPE;
    o          pds.sleep_winddown_ops%ROWTYPE;
    v_result   jsonb;
BEGIN
    IF p_answer IS NOT NULL AND p_answer NOT IN ('Yes', 'No') THEN
        RAISE EXCEPTION 'the answer must be Yes, No or empty' USING ERRCODE = '22023';
    END IF;
    IF p_expect IS NOT NULL AND p_expect NOT IN ('Yes', 'No', 'none') THEN
        RAISE EXCEPTION 'expect must be Yes, No or none' USING ERRCODE = '22023';
    END IF;

    -- One answer at a time: two taps (or a tap and its retry, or a tap and its
    -- cancel) never interleave. Taken first, so every check below sees the
    -- state this call will write on.
    PERFORM pg_advisory_xact_lock(hashtext('pds.sleep_winddown_set_night'));

    -- A repeat of a tap that already landed, or a tap Riley cancelled.
    IF p_op_id IS NOT NULL THEN
        SELECT * INTO o FROM pds.sleep_winddown_ops WHERE op_id = p_op_id;
        IF FOUND THEN
            IF o.state = 'cancelled' THEN
                RAISE EXCEPTION 'that tap was cancelled before it landed' USING ERRCODE = 'OXW17';
            END IF;
            IF o.night IS DISTINCT FROM p_night OR (o.result ->> 'answer') IS DISTINCT FROM p_answer THEN
                RAISE EXCEPTION 'that tap id belongs to a different tap' USING ERRCODE = '22023';
            END IF;
            RETURN o.result || jsonb_build_object('replayed', true, 'changed', false);
        END IF;
    END IF;

    IF p_today IS NOT NULL AND p_today <> v_today THEN
        RAISE EXCEPTION 'a new day started' USING ERRCODE = 'OXW10';
    END IF;
    IF p_night IS NULL OR p_night > v_today THEN
        RAISE EXCEPTION 'that night has not started' USING ERRCODE = 'OXW11';
    END IF;
    IF p_night < v_today - 2 THEN
        RAISE EXCEPTION 'older nights are corrected on the Habits page' USING ERRCODE = 'OXW12';
    END IF;

    SELECT * INTO r FROM pds.sleep_winddown_rules
     WHERE effective_from <= p_night
     ORDER BY effective_from DESC, rule_id DESC
     LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'the wind-down goal is not set up for that night' USING ERRCODE = 'OXW13';
    END IF;
    IF p_rule_id IS NOT NULL AND r.rule_id <> p_rule_id THEN
        RAISE EXCEPTION 'the wind-down goal changed since this screen loaded' USING ERRCODE = 'OXW16';
    END IF;
    SELECT habit_name, channel INTO v_question, v_channel FROM pds.habit_name_map WHERE notion_page_id = r.habit_page_id;
    IF v_question IS NULL THEN
        RAISE EXCEPTION 'the chosen habit is no longer in Onyx' USING ERRCODE = 'OXW14';
    END IF;
    -- The habit's current category (as the check-in writes it), else the one kept with the goal.
    SELECT category INTO v_category FROM pds.habit_metadata_history
     WHERE notion_page_id = r.habit_page_id AND valid_to IS NULL
     ORDER BY valid_from DESC LIMIT 1;

    -- FOR UPDATE locks the row when there is one. When there is none it locks nothing, so the insert below is
    -- made conflict-safe instead (a row the check-in or Habits inserts in between is never overwritten).
    SELECT answer INTO v_current FROM pds.habit_journal
     WHERE cycle_date = p_night AND question = v_question
     FOR UPDATE;
    v_prior := v_current;

    IF COALESCE(v_current, 'none') IS DISTINCT FROM COALESCE(p_answer, 'none') THEN
        IF p_expect IS NOT NULL AND COALESCE(v_current, 'none') <> p_expect THEN
            RAISE EXCEPTION 'that night''s answer changed elsewhere' USING ERRCODE = 'OXW15';
        END IF;
        IF p_answer IS NULL THEN
            DELETE FROM pds.habit_journal WHERE cycle_date = p_night AND question = v_question;
            v_changed := true;
        ELSIF v_current IS NULL AND p_expect IS NOT NULL THEN
            -- No row was there and none was expected: write only if there is still none. A different answer that
            -- landed since the read refuses; the same answer landing meanwhile is a no-op.
            INSERT INTO pds.habit_journal (cycle_date, question, category, answer)
            VALUES (p_night, v_question, COALESCE(v_category, r.habit_category), p_answer)
            ON CONFLICT (cycle_date, question) DO NOTHING;
            GET DIAGNOSTICS v_rows = ROW_COUNT;
            IF v_rows = 1 THEN
                v_changed := true;
            ELSE
                SELECT answer INTO v_current FROM pds.habit_journal
                 WHERE cycle_date = p_night AND question = v_question;
                IF v_current IS DISTINCT FROM p_answer THEN
                    RAISE EXCEPTION 'that night''s answer changed elsewhere' USING ERRCODE = 'OXW15';
                END IF;
            END IF;
        ELSE
            INSERT INTO pds.habit_journal (cycle_date, question, category, answer)
            VALUES (p_night, v_question, COALESCE(v_category, r.habit_category), p_answer)
            ON CONFLICT (cycle_date, question) DO UPDATE SET answer = EXCLUDED.answer;
            v_changed := true;
        END IF;
    END IF;

    -- The start time is the moment of THIS tap: only a Yes that this call wrote on a night that had no answer. A
    -- replay of a tap that already landed, or a No corrected to Yes later, keeps what is there (never a made-up time).
    IF p_answer = 'Yes' AND p_night = v_today AND v_changed AND v_prior IS NULL THEN
        v_tz := COALESCE(pds.tz_for_instant(now()), 'America/New_York');
        INSERT INTO pds.sleep_winddown_starts (night, started_at, local_time, tz, rule_id, habit_page_id)
        VALUES (p_night, now(), to_char(now() AT TIME ZONE v_tz, 'HH24:MI'), v_tz, r.rule_id, r.habit_page_id)
        ON CONFLICT (night) DO NOTHING;
    ELSIF p_answer IS DISTINCT FROM 'Yes' THEN
        DELETE FROM pds.sleep_winddown_starts WHERE night = p_night;
    END IF;
    SELECT * INTO s FROM pds.sleep_winddown_starts WHERE night = p_night;

    v_result := jsonb_build_object(
        'night', p_night, 'answer', p_answer, 'previous', v_current, 'changed', v_changed,
        'question', v_question, 'channel', v_channel, 'habit_page_id', r.habit_page_id, 'rule_id', r.rule_id,
        'started_at', s.started_at, 'local_time', s.local_time, 'tz', s.tz);
    -- Written in the same transaction as the answer: both are there or neither.
    IF p_op_id IS NOT NULL THEN
        INSERT INTO pds.sleep_winddown_ops (op_id, night, state, result)
        VALUES (p_op_id, p_night, 'applied', v_result);
    END IF;
    RETURN v_result;
END $$;

-- ---------------------------------------------------------------------------
-- 4b. Stop a tap whose outcome is unknown (Cancel on "Not saved yet")
-- ---------------------------------------------------------------------------
-- The screen sent a tap and never heard back, so it cannot know whether it
-- landed. This settles it under the same lock as the write:
--   landed = true   the tap had been applied: the answer stands (the screen
--                   shows it saved, with Undo)
--   landed = false  it had not, and now never will: a request with this id that
--                   is still on its way is refused (OXW17)
-- Nothing is written to habit_journal here.
CREATE OR REPLACE FUNCTION pds.sleep_winddown_cancel_op(p_op_id uuid, p_night date)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    o pds.sleep_winddown_ops%ROWTYPE;
BEGIN
    IF p_op_id IS NULL OR p_night IS NULL THEN
        RAISE EXCEPTION 'a tap id and its night are needed' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('pds.sleep_winddown_set_night'));
    SELECT * INTO o FROM pds.sleep_winddown_ops WHERE op_id = p_op_id;
    IF FOUND THEN
        IF o.night IS DISTINCT FROM p_night THEN
            RAISE EXCEPTION 'that tap id belongs to a different tap' USING ERRCODE = '22023';
        END IF;
        IF o.state = 'applied' THEN
            RETURN jsonb_build_object('landed', true, 'night', o.night, 'answer', o.result -> 'answer');
        END IF;
        RETURN jsonb_build_object('landed', false, 'night', o.night);
    END IF;
    INSERT INTO pds.sleep_winddown_ops (op_id, night, state) VALUES (p_op_id, p_night, 'cancelled');
    RETURN jsonb_build_object('landed', false, 'night', p_night);
END $$;

-- ---------------------------------------------------------------------------
-- 5. Pauses
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.sleep_winddown_add_pause(p_start date, p_end date, p_today date)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    v_today date := pds.behavioral_today_now();
    p pds.sleep_winddown_pauses%ROWTYPE;
BEGIN
    IF p_today IS NOT NULL AND p_today <> v_today THEN
        RAISE EXCEPTION 'a new day started' USING ERRCODE = 'OXW10';
    END IF;
    IF p_start IS NULL OR p_start < v_today THEN
        RAISE EXCEPTION 'a pause starts tonight or later' USING ERRCODE = 'OXW20';
    END IF;
    IF p_end IS NOT NULL AND p_end < p_start THEN
        RAISE EXCEPTION 'the pause ends before it starts' USING ERRCODE = 'OXW21';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('pds.sleep_winddown_pauses'));
    IF EXISTS (
        SELECT 1 FROM pds.sleep_winddown_pauses
         WHERE removed_at IS NULL
           AND start_date <= COALESCE(p_end, 'infinity'::date)
           AND COALESCE(end_date, 'infinity'::date) >= p_start) THEN
        RAISE EXCEPTION 'that overlaps a planned pause' USING ERRCODE = 'OXW22';
    END IF;
    INSERT INTO pds.sleep_winddown_pauses (start_date, end_date) VALUES (p_start, p_end) RETURNING * INTO p;
    RETURN to_jsonb(p);
END $$;

-- Resume (or cancel) a pause: one that has not reached its first night is
-- cancelled; a running one ends with last night (tonight counts again); one
-- that is already over is left as it is.
CREATE OR REPLACE FUNCTION pds.sleep_winddown_end_pause(p_pause_id bigint)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    v_today date := pds.behavioral_today_now();
    p pds.sleep_winddown_pauses%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('pds.sleep_winddown_pauses'));
    SELECT * INTO p FROM pds.sleep_winddown_pauses WHERE pause_id = p_pause_id AND removed_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no such pause' USING ERRCODE = 'OXW23';
    END IF;
    IF p.start_date >= v_today THEN
        UPDATE pds.sleep_winddown_pauses SET removed_at = now() WHERE pause_id = p_pause_id RETURNING * INTO p;
    ELSIF p.end_date IS NULL OR p.end_date >= v_today THEN
        UPDATE pds.sleep_winddown_pauses SET end_date = v_today - 1, ended_at = now() WHERE pause_id = p_pause_id RETURNING * INTO p;
    END IF;
    RETURN to_jsonb(p);
END $$;

-- ---------------------------------------------------------------------------
-- 6. Access: service role only
-- ---------------------------------------------------------------------------
ALTER TABLE pds.sleep_winddown_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.sleep_winddown_pauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.sleep_winddown_starts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.sleep_winddown_ops    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pds.sleep_winddown_rules  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON pds.sleep_winddown_pauses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON pds.sleep_winddown_starts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON pds.sleep_winddown_ops    FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT                 ON pds.sleep_winddown_rules  TO service_role;
GRANT SELECT, INSERT, UPDATE         ON pds.sleep_winddown_pauses TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON pds.sleep_winddown_starts TO service_role;
GRANT SELECT, INSERT                 ON pds.sleep_winddown_ops    TO service_role;
REVOKE ALL ON SEQUENCE pds.sleep_winddown_rules_rule_id_seq   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE pds.sleep_winddown_pauses_pause_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE pds.sleep_winddown_rules_rule_id_seq   TO service_role;
GRANT USAGE, SELECT ON SEQUENCE pds.sleep_winddown_pauses_pause_id_seq TO service_role;

REVOKE ALL ON FUNCTION pds.sleep_winddown_add_rule(text, text, text, integer, integer, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.sleep_winddown_set_night(date, text, text, date, bigint, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.sleep_winddown_cancel_op(uuid, date)                            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.sleep_winddown_add_pause(date, date, date)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.sleep_winddown_end_pause(bigint)                                 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.sleep_winddown_add_rule(text, text, text, integer, integer, date) TO service_role;
GRANT EXECUTE ON FUNCTION pds.sleep_winddown_set_night(date, text, text, date, bigint, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION pds.sleep_winddown_cancel_op(uuid, date)                            TO service_role;
GRANT EXECUTE ON FUNCTION pds.sleep_winddown_add_pause(date, date, date)                       TO service_role;
GRANT EXECUTE ON FUNCTION pds.sleep_winddown_end_pause(bigint)                                 TO service_role;
