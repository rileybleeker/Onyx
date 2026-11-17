-- Experiment framework (N-of-1 trials), second schema file: the check-in adherence question and the
-- store of the daily report job. Design: docs/experiment-framework.md 4.5, 10.3 and 12.1.
-- NOT APPLIED YET (2026-11-14). Apply it once, after sql/experiment_framework_schema.sql (applied
-- 2026-11-13) and before the first protocol is registered: experiment_admin.py register refuses
-- while pds.experiment_reports is missing. Until then:
--   * the check-in shows no trial question (GET /api/experiments/adherence answers not_connected);
--   * the report job (experiment_report.py) is a no-op while no trial is registered.
--
-- What it adds:
--   1. pds.experiment_reports, one row per (experiment, kind, as-of day):
--        progress  written daily while a trial runs: counts only (days elapsed, nights with an
--                  outcome, missing share, adherence). Never an effect: guard 2b refuses a
--                  progress payload that carries one.
--        final     written once, at or after the pre-registered end (or the day after an early
--                  stop): the registered analysis. Guard 2a refuses it earlier, so the rule
--                  "analyse only at the pre-registered end" (section 13, decision 1) also holds at
--                  the database, whatever a script does. A stored final report never changes; only
--                  the Notion mirror stamp (notion_synced_at, set by experiment_report.py once
--                  experiment_notion.py has written the page) does. An A/A check's verdict
--                  (aa_check) counts as an effect field: it exists in a final report only.
--   2. pds.experiment_adherence_day(date) and pds.experiment_record_adherence(date, text, text):
--      the only way the app reads or writes the "Followed today's arm?" answer in
--      pds.experiment_days. Both work on the behavioral today or the day before (an answer given
--      the next morning), only for a running trial, and only for a day whose arm was already shown
--      on Today (first_revealed_at is set): nobody can answer for an arm they never saw, and
--      neither function reveals anything that Today has not shown already.
--
-- SERVICE ROLE ONLY, like the other experiment tables: RLS on, no policies, nothing granted to anon
-- or authenticated, the functions are executable by service_role alone, and the service role can
-- read, insert and update report rows but has no way to take one out. The final payload publishes
-- the allocation seed (the trial is over by then).
--
-- This file is additive and safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. The report table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.experiment_reports (
    experiment_id     TEXT NOT NULL REFERENCES pds.experiments (experiment_id),
    report_kind       TEXT NOT NULL CHECK (report_kind IN ('progress', 'final')),
    as_of_date        DATE NOT NULL,          -- behavioral today of the run that wrote it
    payload           JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    notion_synced_at  TIMESTAMPTZ,            -- when this report was last mirrored to Notion
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (experiment_id, report_kind, as_of_date)
);

-- A trial has one final report.
CREATE UNIQUE INDEX IF NOT EXISTS experiment_reports_one_final
    ON pds.experiment_reports (experiment_id) WHERE report_kind = 'final';

-- ---------------------------------------------------------------------------
-- 2. Report guards
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.experiment_reports_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    e pds.experiments%ROWTYPE;
    last_day date;
    effect_keys text[] := ARRAY['estimate', 'ci_low', 'ci_high', 'p_value', 'carryover', 'two_night_total',
                                'decision', 'sensitivity', 'secondary_outcomes', 'allocation', 'aa_check',
                                'p_carryover', 'p_value_no_effect', 'p_carryover_no_effect',
                                'carryover_ci_low', 'carryover_ci_high', 'carryover_exceeds_half_mid',
                                'hac_se', 'hac_se_carryover', 'decision_if_supported', 'decision_firm',
                                'decision_withheld', 'inference'];
BEGIN
    NEW.updated_at := now();
    IF (NEW.payload ->> 'report_kind') IS DISTINCT FROM NEW.report_kind THEN
        RAISE EXCEPTION 'experiment report % : the payload must carry report_kind %', NEW.experiment_id, NEW.report_kind;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.experiment_id <> OLD.experiment_id OR NEW.report_kind <> OLD.report_kind
           OR NEW.as_of_date <> OLD.as_of_date THEN
            RAISE EXCEPTION 'experiment report % : the key of a report never changes', OLD.experiment_id;
        END IF;
        -- A final report is permanent. Re-sending the same payload is accepted (an idempotent
        -- re-run); anything else is refused. The Notion stamp may always be set.
        IF OLD.report_kind = 'final' AND NEW.payload IS DISTINCT FROM OLD.payload THEN
            RAISE EXCEPTION 'experiment report % : the final report is written once and never changes', OLD.experiment_id;
        END IF;
    END IF;

    IF NEW.report_kind = 'progress' THEN
        -- 2b. Progress is counts only.
        IF NEW.payload ?| effect_keys THEN
            RAISE EXCEPTION 'experiment report % : a progress report cannot carry an effect estimate', NEW.experiment_id;
        END IF;
        RETURN NEW;
    END IF;

    -- 2a. A final report only once the trial is over: after the pre-registered end, or after the
    --     day Riley stopped it. The outcome of day D is the HRV of the next morning, hence "after".
    SELECT * INTO e FROM pds.experiments WHERE experiment_id = NEW.experiment_id;
    IF e.locked_at IS NULL THEN
        RAISE EXCEPTION 'experiment report % : the experiment is not registered', NEW.experiment_id;
    END IF;
    last_day := LEAST(e.planned_end, COALESCE(e.stopped_on, e.planned_end));
    IF NEW.as_of_date <= last_day THEN
        RAISE EXCEPTION 'experiment report % : the effect is analysed only at the pre-registered end (last day %, report dated %)',
            NEW.experiment_id, last_day, NEW.as_of_date;
    END IF;
    IF NEW.as_of_date > pds.behavioral_today_now() THEN
        RAISE EXCEPTION 'experiment report % : a report cannot be dated after today', NEW.experiment_id;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER experiment_reports_guard
    BEFORE INSERT OR UPDATE ON pds.experiment_reports
    FOR EACH ROW EXECUTE FUNCTION pds.experiment_reports_guard();

-- ---------------------------------------------------------------------------
-- 3. The check-in question "Followed today's arm?" (docs/experiment-framework.md 4.5)
-- ---------------------------------------------------------------------------
-- 3a. The state of one day's question. p_date NULL = the behavioral today. Answers:
--       {status: 'none', behavioral_date}            no running trial on that day, or the day is
--                                                    neither today nor yesterday
--       {status: 'not_revealed', experiment_id, title, behavioral_date}
--                                                    a trial day whose arm Today has not shown yet
--       {status: 'open', experiment_id, title, behavioral_date, day_number, n_days, arm,
--        instruction, self_report, self_report_note, self_reported_at}
--     It writes nothing and stamps nothing: only pds.experiment_today() (the Today card) reveals.
CREATE OR REPLACE FUNCTION pds.experiment_adherence_day(p_date date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    v_today date := pds.behavioral_today_now();
    v_day   date := COALESCE(p_date, v_today);
    e pds.experiments%ROWTYPE;
    s pds.experiment_schedule%ROWTYPE;
    d pds.experiment_days%ROWTYPE;
BEGIN
    IF v_day > v_today OR v_day < v_today - 1 THEN
        RETURN jsonb_build_object('status', 'none', 'behavioral_date', v_day);
    END IF;
    -- 'registered' means no day has been revealed yet (the first reveal moves it to 'running');
    -- a paused, stopped or complete trial takes no answers.
    SELECT * INTO e FROM pds.experiments
    WHERE status IN ('registered', 'running') AND start_date <= v_day AND planned_end >= v_day
    ORDER BY start_date LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'none', 'behavioral_date', v_day);
    END IF;
    SELECT * INTO s FROM pds.experiment_schedule
    WHERE experiment_id = e.experiment_id AND behavioral_date = v_day;
    IF NOT FOUND OR s.first_revealed_at IS NULL THEN
        RETURN jsonb_build_object('status', 'not_revealed', 'experiment_id', e.experiment_id, 'title', e.title,
                                  'behavioral_date', v_day);
    END IF;
    SELECT * INTO d FROM pds.experiment_days
    WHERE experiment_id = e.experiment_id AND behavioral_date = v_day;
    RETURN jsonb_build_object(
        'status', 'open', 'experiment_id', e.experiment_id, 'title', e.title, 'behavioral_date', v_day,
        'day_number', s.day_index + 1, 'n_days', e.n_days, 'arm', s.arm,
        'instruction', CASE s.arm WHEN 'A' THEN e.arm_a_instruction ELSE e.arm_b_instruction END,
        'self_report', d.self_report, 'self_report_note', d.self_report_note,
        'self_reported_at', d.self_reported_at);
END $$;

-- 3b. Record (or change) the answer for an open day. A day that is not open is left untouched and
--     its state is returned, so the caller can tell "saved" from "nothing to answer".
CREATE OR REPLACE FUNCTION pds.experiment_record_adherence(p_date date, p_answer text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = pds, pg_temp AS $$
DECLARE
    state  jsonb;
    v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
    IF p_answer IS NULL OR p_answer NOT IN ('yes', 'partly', 'no') THEN
        RAISE EXCEPTION 'the answer must be yes, partly or no' USING ERRCODE = '22023';
    END IF;
    IF length(v_note) > 500 THEN
        RAISE EXCEPTION 'the note is longer than 500 characters' USING ERRCODE = '22023';
    END IF;
    state := pds.experiment_adherence_day(p_date);
    IF (state ->> 'status') IS DISTINCT FROM 'open' THEN
        RETURN state;
    END IF;
    INSERT INTO pds.experiment_days (experiment_id, behavioral_date, self_report, self_report_note, self_reported_at)
    VALUES (state ->> 'experiment_id', (state ->> 'behavioral_date')::date, p_answer, v_note, now())
    ON CONFLICT (experiment_id, behavioral_date) DO UPDATE
        SET self_report      = EXCLUDED.self_report,
            self_report_note = EXCLUDED.self_report_note,
            self_reported_at = EXCLUDED.self_reported_at;
    RETURN pds.experiment_adherence_day((state ->> 'behavioral_date')::date);
END $$;

-- ---------------------------------------------------------------------------
-- 4. Access: service role only, and no row removal.
-- ---------------------------------------------------------------------------
ALTER TABLE pds.experiment_reports ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pds.experiment_reports FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON pds.experiment_reports TO service_role;

REVOKE ALL ON FUNCTION pds.experiment_adherence_day(date)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.experiment_record_adherence(date, text, text)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.experiment_adherence_day(date)               TO service_role;
GRANT EXECUTE ON FUNCTION pds.experiment_record_adherence(date, text, text) TO service_role;
