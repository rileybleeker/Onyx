-- Experiment framework (N-of-1 trials): definitions, the concealed allocation schedule,
-- per-day adherence, the lock guards and the "today's arm" reveal function.
-- Design: docs/experiment-framework.md (sections 4.3, 4.4, 4.5, 6.2). Applied 2026-11-13.
--
-- SERVICE ROLE ONLY. RLS is on with no policies, nothing is granted to anon or authenticated,
-- and the functions are executable by service_role alone. The browser never queries these
-- tables: the only readers are the server route GET /api/experiments/today (owner session,
-- calls pds.experiment_today()) and the Python admin CLI experiment_admin.py. That is what
-- keeps the allocation concealed: the page can show today's arm and nothing later.
--
-- service_role may read, insert and update, but not remove rows: a registered protocol, its
-- seed and its schedule are permanent records (a trial that should not run is stopped, and a
-- corrected one gets a new id).
--
-- This file is additive and safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Experiment definitions (one row per pre-registered protocol)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.experiments (
    experiment_id      TEXT PRIMARY KEY CHECK (experiment_id ~ '^EXP-[0-9]{3}$'),
    title              TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'registered', 'running', 'paused', 'stopped_early', 'complete')),
    -- pre-registered protocol (filled by pds.experiment_register, frozen once locked_at is set)
    question           TEXT,
    arm_a_instruction  TEXT,
    arm_b_instruction  TEXT,
    control_arm        TEXT NOT NULL DEFAULT 'B' CHECK (control_arm IN ('A', 'B')),
    outcome_primary    TEXT,
    alignment_version  TEXT,          -- hrv_alignment.ALIGNMENT_VERSION at registration
    mid_ms             NUMERIC,       -- minimal important difference, ms
    design_type        TEXT CHECK (design_type IN ('daily_4day_permuted_blocks', 'period_ab')),
    block_len          INT,
    n_a_per_block      INT,
    n_blocks           INT,
    n_days             INT,
    washout_days       INT NOT NULL DEFAULT 0,
    start_date         DATE,          -- first behavioral day
    planned_end        DATE,          -- last behavioral day (start_date + n_days - 1)
    alpha              NUMERIC,
    n_redraws          INT,
    adherence          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- self-report + objective rule
    protocol           JSONB,         -- the whole parsed protocol front matter
    protocol_path      TEXT,          -- docs/experiments/EXP-NNN.md
    protocol_sha256    TEXT CHECK (protocol_sha256 IS NULL OR protocol_sha256 ~ '^[0-9a-f]{64}$'),
    git_commit         TEXT,
    -- allocation commitment: sha256 of the 32-byte seed (the seed is in pds.experiment_secrets)
    seed_sha256        TEXT NOT NULL CHECK (seed_sha256 ~ '^[0-9a-f]{64}$'),
    generator          TEXT,
    locked_at          TIMESTAMPTZ,
    -- the only fields that may change after the lock
    stopped_on         DATE,
    stop_reason        TEXT,
    notion_page_id     TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT experiments_locked_is_complete CHECK (
        locked_at IS NULL OR (
            question IS NOT NULL AND arm_a_instruction IS NOT NULL AND arm_b_instruction IS NOT NULL
            AND outcome_primary IS NOT NULL AND alignment_version IS NOT NULL AND mid_ms > 0
            AND design_type IS NOT NULL AND block_len > 1 AND n_a_per_block BETWEEN 1 AND block_len - 1
            AND n_blocks > 0 AND n_days = n_blocks * block_len
            AND start_date IS NOT NULL AND planned_end = start_date + (n_days - 1)
            AND alpha > 0 AND alpha < 1 AND n_redraws >= 999
            AND protocol IS NOT NULL AND protocol_sha256 IS NOT NULL AND git_commit IS NOT NULL
        )
    ),
    CONSTRAINT experiments_status_needs_lock CHECK (status = 'draft' OR locked_at IS NOT NULL)
);

-- One trial at a time (docs/experiment-framework.md 7.5).
CREATE UNIQUE INDEX IF NOT EXISTS experiments_one_active
    ON pds.experiments ((true)) WHERE status IN ('registered', 'running', 'paused');

-- ---------------------------------------------------------------------------
-- 2. The seed (published only in the final report) and the schedule
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.experiment_secrets (
    experiment_id  TEXT PRIMARY KEY REFERENCES pds.experiments (experiment_id),
    seed_hex       TEXT NOT NULL CHECK (seed_hex ~ '^[0-9a-f]{64}$'),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pds.experiment_schedule (
    experiment_id      TEXT NOT NULL REFERENCES pds.experiments (experiment_id),
    behavioral_date    DATE NOT NULL,          -- ADR-0001 behavioral day the arm applies to
    day_index          INT  NOT NULL CHECK (day_index >= 0),
    block_index        INT  NOT NULL CHECK (block_index >= 0),
    pos_in_block       INT  NOT NULL CHECK (pos_in_block >= 0),
    arm                TEXT NOT NULL CHECK (arm IN ('A', 'B')),
    first_revealed_at  TIMESTAMPTZ,            -- when the arm was first shown (pds.experiment_today)
    PRIMARY KEY (experiment_id, behavioral_date),
    UNIQUE (experiment_id, day_index)
);

-- ---------------------------------------------------------------------------
-- 3. Adherence and verification per day. Deliberately NOT pds.habit_journal: a habit row would
--    be picked up as a treatment by causal_inference.py and could fire the backfill retrain.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.experiment_days (
    experiment_id         TEXT NOT NULL,
    behavioral_date       DATE NOT NULL,
    self_report           TEXT CHECK (self_report IN ('yes', 'partly', 'no')),   -- "Followed today's arm?"
    self_report_note      TEXT,
    self_reported_at      TIMESTAMPTZ,
    excluded              BOOLEAN NOT NULL DEFAULT false,   -- illness / travel pause declared ahead
    exclusion_reason      TEXT,
    exclusion_declared_at TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (experiment_id, behavioral_date),
    FOREIGN KEY (experiment_id, behavioral_date)
        REFERENCES pds.experiment_schedule (experiment_id, behavioral_date),
    CONSTRAINT experiment_days_exclusion_has_reason CHECK (NOT excluded OR exclusion_reason IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- 4. Guards
-- ---------------------------------------------------------------------------
-- 4a. Protocol lock. Before the lock only the seed commitment is fixed. Once locked_at is set
--     the protocol can never change; only the status may move forward, plus the stop fields
--     and the Notion page id.
CREATE OR REPLACE FUNCTION pds.experiments_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    open_fields text[] := ARRAY['status', 'stopped_on', 'stop_reason', 'notion_page_id', 'updated_at'];
    n_sched int;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'draft' OR NEW.locked_at IS NOT NULL THEN
            RAISE EXCEPTION 'an experiment starts as a draft; register it with pds.experiment_register';
        END IF;
        RETURN NEW;
    END IF;

    NEW.updated_at := now();
    IF NEW.experiment_id <> OLD.experiment_id OR NEW.seed_sha256 <> OLD.seed_sha256 THEN
        RAISE EXCEPTION 'experiment % : the id and the seed commitment never change', OLD.experiment_id;
    END IF;

    IF OLD.locked_at IS NULL THEN
        IF NEW.status = 'draft' THEN
            IF NEW.locked_at IS NOT NULL THEN
                RAISE EXCEPTION 'experiment % : a draft cannot carry a lock', OLD.experiment_id;
            END IF;
            RETURN NEW;
        END IF;
        IF NEW.status <> 'registered' THEN
            RAISE EXCEPTION 'experiment % : a draft can only become registered', OLD.experiment_id;
        END IF;
        IF NEW.start_date <= (now() AT TIME ZONE 'America/New_York')::date THEN
            RAISE EXCEPTION 'experiment % : the first day (%) must be after today; a protocol is registered before it starts',
                OLD.experiment_id, NEW.start_date;
        END IF;
        SELECT count(*) INTO n_sched FROM pds.experiment_schedule WHERE experiment_id = OLD.experiment_id;
        IF n_sched IS DISTINCT FROM NEW.n_days THEN
            RAISE EXCEPTION 'experiment % : % schedule rows for % days', OLD.experiment_id, n_sched, NEW.n_days;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pds.experiment_secrets WHERE experiment_id = OLD.experiment_id) THEN
            RAISE EXCEPTION 'experiment % : no stored seed', OLD.experiment_id;
        END IF;
        NEW.locked_at := now();
        RETURN NEW;
    END IF;

    IF (to_jsonb(NEW) - open_fields) IS DISTINCT FROM (to_jsonb(OLD) - open_fields) THEN
        RAISE EXCEPTION 'experiment % is locked (registered %): the protocol cannot change. Amend with a new protocol file.',
            OLD.experiment_id, OLD.locked_at;
    END IF;
    IF NEW.status <> OLD.status AND NOT (
           (OLD.status = 'registered' AND NEW.status IN ('running', 'stopped_early'))
        OR (OLD.status = 'running'    AND NEW.status IN ('paused', 'stopped_early', 'complete'))
        OR (OLD.status = 'paused'     AND NEW.status IN ('running', 'stopped_early'))
    ) THEN
        RAISE EXCEPTION 'experiment % : status cannot go from % to %', OLD.experiment_id, OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'stopped_early' AND NEW.stopped_on IS NULL THEN
        RAISE EXCEPTION 'experiment % : stopped_early needs stopped_on', OLD.experiment_id;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER experiments_guard
    BEFORE INSERT OR UPDATE ON pds.experiments
    FOR EACH ROW EXECUTE FUNCTION pds.experiments_guard();

-- 4b. The seed must match the commitment and never changes.
CREATE OR REPLACE FUNCTION pds.experiment_secrets_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    commitment text;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'experiment % : the seed never changes', OLD.experiment_id;
    END IF;
    SELECT seed_sha256 INTO commitment FROM pds.experiments WHERE experiment_id = NEW.experiment_id;
    IF commitment IS DISTINCT FROM encode(sha256(decode(NEW.seed_hex, 'hex')), 'hex') THEN
        RAISE EXCEPTION 'experiment % : the seed does not match the commitment', NEW.experiment_id;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER experiment_secrets_guard
    BEFORE INSERT OR UPDATE ON pds.experiment_secrets
    FOR EACH ROW EXECUTE FUNCTION pds.experiment_secrets_guard();

-- 4c. Schedule rows are written while the experiment is a draft (inside
--     pds.experiment_register) and never change; only the first-reveal stamp may be set, once.
CREATE OR REPLACE FUNCTION pds.experiment_schedule_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    parent_status text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT status INTO parent_status FROM pds.experiments WHERE experiment_id = NEW.experiment_id;
        IF parent_status IS DISTINCT FROM 'draft' THEN
            RAISE EXCEPTION 'experiment % : the schedule is fixed at registration', NEW.experiment_id;
        END IF;
        IF NEW.first_revealed_at IS NOT NULL THEN
            RAISE EXCEPTION 'experiment % : a new schedule row cannot be revealed already', NEW.experiment_id;
        END IF;
        RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - 'first_revealed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'first_revealed_at')
       OR OLD.first_revealed_at IS NOT NULL OR NEW.first_revealed_at IS NULL THEN
        RAISE EXCEPTION 'experiment % : schedule rows never change (only the first reveal is stamped, once)',
            OLD.experiment_id;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER experiment_schedule_guard
    BEFORE INSERT OR UPDATE ON pds.experiment_schedule
    FOR EACH ROW EXECUTE FUNCTION pds.experiment_schedule_guard();

-- 4d. Adherence can only be reported for a day that has started; an exclusion (pause) may be
--     declared for later days, which is the point of declaring it ahead.
CREATE OR REPLACE FUNCTION pds.experiment_days_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
BEGIN
    NEW.updated_at := now();
    IF NEW.self_report IS NOT NULL AND NEW.behavioral_date > pds.behavioral_today_now() THEN
        RAISE EXCEPTION 'experiment % : adherence for % cannot be reported before that day', NEW.experiment_id, NEW.behavioral_date;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER experiment_days_guard
    BEFORE INSERT OR UPDATE ON pds.experiment_days
    FOR EACH ROW EXECUTE FUNCTION pds.experiment_days_guard();

-- ---------------------------------------------------------------------------
-- 5. Registration: protocol fields + the whole schedule + the lock, in one transaction.
--    Called by experiment_admin.py register (service role). p_fields carries the validated
--    protocol; p_schedule is a JSON array of {behavioral_date, day_index, block_index,
--    pos_in_block, arm}. Any failure leaves the draft exactly as it was.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.experiment_register(p_experiment_id text, p_fields jsonb, p_schedule jsonb)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    e pds.experiments%ROWTYPE;
    bad int;
BEGIN
    SELECT * INTO e FROM pds.experiments WHERE experiment_id = p_experiment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'experiment % has no draft; run the seed step first', p_experiment_id;
    END IF;
    IF e.status <> 'draft' THEN
        RAISE EXCEPTION 'experiment % is already % and cannot be registered again', p_experiment_id, e.status;
    END IF;
    IF (p_fields ->> 'seed_sha256') IS DISTINCT FROM e.seed_sha256 THEN
        RAISE EXCEPTION 'experiment % : the protocol''s seed commitment is not the stored one', p_experiment_id;
    END IF;

    UPDATE pds.experiments SET
        title             = p_fields ->> 'title',
        question          = p_fields ->> 'question',
        arm_a_instruction = p_fields ->> 'arm_a_instruction',
        arm_b_instruction = p_fields ->> 'arm_b_instruction',
        control_arm       = p_fields ->> 'control_arm',
        outcome_primary   = p_fields ->> 'outcome_primary',
        alignment_version = p_fields ->> 'alignment_version',
        mid_ms            = (p_fields ->> 'mid_ms')::numeric,
        design_type       = p_fields ->> 'design_type',
        block_len         = (p_fields ->> 'block_len')::int,
        n_a_per_block     = (p_fields ->> 'n_a_per_block')::int,
        n_blocks          = (p_fields ->> 'n_blocks')::int,
        n_days            = (p_fields ->> 'n_days')::int,
        washout_days      = (p_fields ->> 'washout_days')::int,
        start_date        = (p_fields ->> 'start_date')::date,
        planned_end       = (p_fields ->> 'planned_end')::date,
        alpha             = (p_fields ->> 'alpha')::numeric,
        n_redraws         = (p_fields ->> 'n_redraws')::int,
        adherence         = COALESCE(p_fields -> 'adherence', '{}'::jsonb),
        protocol          = p_fields -> 'protocol',
        protocol_path     = p_fields ->> 'protocol_path',
        protocol_sha256   = p_fields ->> 'protocol_sha256',
        git_commit        = p_fields ->> 'git_commit',
        generator         = p_fields ->> 'generator'
    WHERE experiment_id = p_experiment_id
    RETURNING * INTO e;

    INSERT INTO pds.experiment_schedule (experiment_id, behavioral_date, day_index, block_index, pos_in_block, arm)
    SELECT p_experiment_id, (r ->> 'behavioral_date')::date, (r ->> 'day_index')::int,
           (r ->> 'block_index')::int, (r ->> 'pos_in_block')::int, r ->> 'arm'
    FROM jsonb_array_elements(p_schedule) AS r;

    -- The stored schedule must be exactly one arm per day from the first day, in whole blocks,
    -- every block holding the registered number of A days.
    SELECT count(*) INTO bad FROM pds.experiment_schedule s
    WHERE s.experiment_id = p_experiment_id
      AND (s.behavioral_date <> e.start_date + s.day_index
           OR s.block_index <> s.day_index / e.block_len
           OR s.pos_in_block <> s.day_index % e.block_len
           OR s.day_index >= e.n_days);
    IF bad > 0 THEN
        RAISE EXCEPTION 'experiment % : % schedule rows are not on the registered day grid', p_experiment_id, bad;
    END IF;
    SELECT count(*) INTO bad FROM (
        SELECT block_index FROM pds.experiment_schedule WHERE experiment_id = p_experiment_id
        GROUP BY block_index
        HAVING count(*) <> e.block_len OR count(*) FILTER (WHERE arm = 'A') <> e.n_a_per_block
    ) AS unbalanced;
    IF bad > 0 THEN
        RAISE EXCEPTION 'experiment % : % blocks are not balanced', p_experiment_id, bad;
    END IF;

    -- The guard checks the row count, the start date and the seed, then sets locked_at.
    UPDATE pds.experiments SET status = 'registered' WHERE experiment_id = p_experiment_id RETURNING * INTO e;

    RETURN jsonb_build_object('experiment_id', e.experiment_id, 'status', e.status, 'locked_at', e.locked_at,
                              'start_date', e.start_date, 'planned_end', e.planned_end, 'n_days', e.n_days);
END $$;

-- ---------------------------------------------------------------------------
-- 6. Reveal: today's arm and nothing else (docs/experiment-framework.md 4.3 / 4.4).
--    "Today" is pds.behavioral_today_now(): travel-aware, and it rolls over at 06:00 local, so
--    the arm appears at the start of the behavioral day and still shows after midnight.
--    The first call of a day stamps first_revealed_at (the commit-then-reveal audit trail) and
--    the first reveal of a trial moves it from registered to running. Those two stamps are the
--    only writes; nothing about Riley's behaviour is recorded here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.experiment_today() RETURNS jsonb
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    today date := pds.behavioral_today_now();
    e pds.experiments%ROWTYPE;
    s pds.experiment_schedule%ROWTYPE;
    base jsonb;
BEGIN
    SELECT * INTO e FROM pds.experiments
    WHERE status IN ('registered', 'running', 'paused') ORDER BY start_date LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'none', 'behavioral_date', today);
    END IF;

    base := jsonb_build_object('experiment_id', e.experiment_id, 'title', e.title, 'behavioral_date', today,
                               'start_date', e.start_date, 'planned_end', e.planned_end, 'n_days', e.n_days);
    IF today < e.start_date THEN
        RETURN base || jsonb_build_object('status', 'upcoming');
    END IF;
    IF today > e.planned_end THEN
        RETURN base || jsonb_build_object('status', 'ended');
    END IF;
    IF e.status = 'paused' THEN
        RETURN base || jsonb_build_object('status', 'paused');
    END IF;

    SELECT * INTO s FROM pds.experiment_schedule
    WHERE experiment_id = e.experiment_id AND behavioral_date = today;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'GUARD experiment_schedule: % has no schedule row for %', e.experiment_id, today;
    END IF;

    IF s.first_revealed_at IS NULL THEN
        UPDATE pds.experiment_schedule SET first_revealed_at = now()
        WHERE experiment_id = e.experiment_id AND behavioral_date = today AND first_revealed_at IS NULL;
        SELECT * INTO s FROM pds.experiment_schedule
        WHERE experiment_id = e.experiment_id AND behavioral_date = today;
    END IF;
    IF e.status = 'registered' THEN
        UPDATE pds.experiments SET status = 'running'
        WHERE experiment_id = e.experiment_id AND status = 'registered';
    END IF;

    RETURN base || jsonb_build_object(
        'status', 'active',
        'day_number', s.day_index + 1,
        'arm', s.arm,
        'instruction', CASE s.arm WHEN 'A' THEN e.arm_a_instruction ELSE e.arm_b_instruction END,
        'first_revealed_at', s.first_revealed_at);
END $$;

-- ---------------------------------------------------------------------------
-- 7. Per-day status of PAST days: the arm, the self-report and the objective check.
--    Today and later days are left out, so nothing built on this view can show an arm early.
--    Objective adherence is read live from the source the protocol names
--    (adherence.objective = {source, max, arm}); the only source wired so far is Screen Time's
--    pre-bed minutes. It applies to the days of the named arm only (the other arm is "usual
--    behaviour", so there is nothing to check).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW pds.experiment_day_status
WITH (security_invoker = true) AS
SELECT s.experiment_id,
       s.behavioral_date,
       s.day_index,
       s.block_index,
       s.pos_in_block,
       s.arm,
       s.first_revealed_at,
       d.self_report,
       d.self_report_note,
       p.minutes_last_hour_before_sleep_est                       AS objective_value,
       CASE
           WHEN p.minutes_last_hour_before_sleep_est IS NULL THEN NULL
           WHEN s.arm IS DISTINCT FROM (e.adherence #>> '{objective,arm}') THEN NULL
           ELSE p.minutes_last_hour_before_sleep_est <= (e.adherence #>> '{objective,max}')::numeric
       END                                                        AS objective_adherent,
       COALESCE(d.excluded, false)                                AS excluded,
       d.exclusion_reason,
       COALESCE(f.flew = 1, false)                                AS flight_day
FROM pds.experiment_schedule s
JOIN pds.experiments e ON e.experiment_id = s.experiment_id
LEFT JOIN pds.experiment_days d
       ON d.experiment_id = s.experiment_id AND d.behavioral_date = s.behavioral_date
LEFT JOIN pds.phone_usage_daily p
       ON p.behavioral_date = s.behavioral_date
      AND (e.adherence #>> '{objective,source}') = 'pds.phone_usage_daily.minutes_last_hour_before_sleep_est'
LEFT JOIN pds.flight_day_unified f ON f.calendar_date = s.behavioral_date
WHERE s.behavioral_date < pds.behavioral_today_now();

-- ---------------------------------------------------------------------------
-- 8. Access: service role only, and no row removal.
-- ---------------------------------------------------------------------------
ALTER TABLE pds.experiments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.experiment_secrets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.experiment_schedule  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.experiment_days      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pds.experiments, pds.experiment_secrets, pds.experiment_schedule, pds.experiment_days,
              pds.experiment_day_status
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON pds.experiments         TO service_role;
GRANT SELECT, INSERT         ON pds.experiment_secrets  TO service_role;
GRANT SELECT, INSERT, UPDATE ON pds.experiment_schedule TO service_role;
GRANT SELECT, INSERT, UPDATE ON pds.experiment_days     TO service_role;
GRANT SELECT                 ON pds.experiment_day_status TO service_role;

REVOKE ALL ON FUNCTION pds.experiment_today()                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.experiment_register(text, jsonb, jsonb)     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.experiment_today()                       TO service_role;
GRANT EXECUTE ON FUNCTION pds.experiment_register(text, jsonb, jsonb)  TO service_role;
