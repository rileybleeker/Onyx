-- ============================================================
-- Onyx — Reading learning questions: source versions + attempt receipts (PROD-T07, 2026-11-16)
-- ============================================================
-- Before: a checkpoint quiz stored only score / total / checkpoint / notes. Nothing recorded which questions
-- were asked, what they were drawn from, what Riley answered or how each answer was graded, so a score could not
-- be checked, and a wrong question could not be corrected.
--
-- Now:
--   * pds.reading_questions          one row per VERSION of a question: prompt, optional rubric (the expected
--                                    answer / grading guide), the permitted source it is drawn from, and a sha-256
--                                    of that source's text when the version was written. A correction is a new
--                                    version; the old one is kept and marked superseded. An edit of the SOURCE's
--                                    text alone (a highlight comment, a recall note) is also a new version, made
--                                    when the question is next answered, and leaves earlier answers valid.
--   * pds.reading_question_attempts  one row per answer, keyed by the client's UUID (attempt_key): the raw answer
--                                    (cleared by the retention function below), when it was answered, and, as a
--                                    SEPARATE later step, the grading (status pending -> graded, correct, grader,
--                                    feedback, graded_at). A correction of the question (prompt, rubric or source
--                                    reference) marks the attempts on older versions invalidated (kept, never
--                                    deleted); a version made because only the source's text moved does not.
--   * pds.reading_quizzes            two nullable columns: question_count (NULL = recorded without per-question
--                                    attempts, so the score is unverifiable; every row stored before this change)
--                                    and invalidated_count (answers in it whose question was corrected later).
--
-- Permitted sources (source_kind): 'highlight' (a book_highlights row of the same book, passage + comment, not
-- archived), 'session' (the recall note of a reading_sessions row of the same book; the session's `question`
-- column, a question for a client, is never a source), 'chapter' (a chapter of the same book: number + table of
-- contents title). Nothing else: journals, email, health, finance and client material cannot be a source.
--
-- Every write goes through pds.reading_question_apply(p), under the same advisory lock as review grades and quiz
-- results (pds.reading_practice, sql/reading_practice_receipts.sql): kinds 'answer', 'grade', 'correct'. Each is
-- replay safe: an answer or correction with the same key and request answers what was stored (replayed); the same
-- key with another request is 409 key_reused; a second answer to the same question in one quiz under a NEW key is
-- 409 already_answered; grading an attempt again with the same grade replays, another grade is 409 already_graded.
-- An answer whose prompt, rubric or source reference differs from the current version is 409 question_changed
-- (correct it first); one where only the source's TEXT differs makes the next version itself ("source text changed")
-- and is stored against it: the earlier answers were graded against their own version, whose source hash is kept,
-- so they stay counted. A correction invalidates the answers to older versions when the prompt, rubric or source
-- reference changes; `invalidate` (true | false) overrides that default, e.g. true when the source text itself was
-- wrong, false for a wording fix that changes nothing for the answers already given.
-- A quiz result recorded under quiz key K (pds.reading_quizzes.op_key) links the attempts answered with
-- quiz_key K: the trigger below refuses the quiz while any of them is ungraded (OXQ01), when its score / total
-- differ from the graded answers (OXQ02) or when any of them is about another book (OXQ03), and stores
-- question_count. All answers under one quiz key must be about one book (409 quiz_other_book at answer time).
--
-- Inspection and export: pds.reading_questions_export(book_id) returns every version (with whether its source is
-- the same, changed or removed now) and every attempt of the book. Retention: pds.reading_clear_question_answers
-- (days) clears the raw answer and feedback text of attempts graded or invalidated more than `days` ago (at least
-- 30), keeping the answer's hash, the grade and the timestamps. It is NOT scheduled by this file (docs/reading-
-- practice.md: proposed 180 days, a rollout decision).
--
-- Additive only: two new tables, two nullable columns, indexes, functions and one trigger. Existing quizzes are not
-- rewritten. Grants: tables and functions are service_role only (row level security on, no policies); the
-- browser never reads them, only the owner-session route /api/reading/questions does.
-- Apply after sql/reading_practice_receipts.sql (quiz results are recorded through its pds.reading_record_quiz),
-- and apply both BEFORE merging the code that calls them (rollout order in that file's header).
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.reading_questions (
    question_id       BIGSERIAL   PRIMARY KEY,
    question_key      UUID        NOT NULL,                       -- one question across its versions
    version           INTEGER     NOT NULL CHECK (version >= 1),
    book_id           BIGINT      NOT NULL REFERENCES pds.books(book_id),
    prompt            TEXT        NOT NULL CHECK (length(btrim(prompt)) BETWEEN 1 AND 1000),
    rubric            TEXT        CHECK (rubric IS NULL OR length(rubric) <= 2000),
    source_kind       TEXT        NOT NULL CHECK (source_kind IN ('highlight', 'session', 'chapter')),
    source_ref        BIGINT      NOT NULL CHECK (source_ref >= 0), -- highlight_id | session_id | chapter number
    source_hash       TEXT        NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    content_hash      TEXT        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'), -- prompt + rubric + source + source_hash
    op_key            UUID        UNIQUE,                         -- the correction that made this version (NULL for version 1)
    request_hash      TEXT,                                       -- sha-256 of that correction's request (replay check)
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    superseded_at     TIMESTAMPTZ,
    superseded_reason TEXT        CHECK (superseded_reason IS NULL OR length(superseded_reason) <= 500),
    UNIQUE (question_key, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reading_questions_current ON pds.reading_questions (question_key) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reading_questions_book ON pds.reading_questions (book_id, question_key, version);

CREATE TABLE IF NOT EXISTS pds.reading_question_attempts (
    attempt_key        UUID        PRIMARY KEY,                   -- the client's operation key for this answer
    question_id        BIGINT      NOT NULL REFERENCES pds.reading_questions(question_id), -- the exact version answered
    quiz_key           UUID,                                      -- the quiz result's op_key this answer belongs to (optional)
    attempt_date       DATE        NOT NULL,                      -- behavioral day (pds.behavioral_today_now())
    answer             TEXT        CHECK (answer IS NULL OR length(answer) <= 4000), -- raw answer; NULL once cleared
    answer_hash        TEXT        NOT NULL CHECK (answer_hash ~ '^[0-9a-f]{64}$'),
    request_hash       TEXT        NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    answered_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    grading_status     TEXT        NOT NULL DEFAULT 'pending' CHECK (grading_status IN ('pending', 'graded', 'invalidated')),
    correct            BOOLEAN,
    grader             TEXT        CHECK (grader IS NULL OR grader IN ('model', 'self')),
    feedback           TEXT        CHECK (feedback IS NULL OR length(feedback) <= 2000),
    graded_at          TIMESTAMPTZ,
    invalidated_at     TIMESTAMPTZ,
    invalidated_reason TEXT,
    answer_cleared_at  TIMESTAMPTZ,
    CHECK (grading_status <> 'graded' OR (correct IS NOT NULL AND grader IS NOT NULL AND graded_at IS NOT NULL)),
    CHECK (grading_status <> 'invalidated' OR invalidated_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_reading_question_attempts_question ON pds.reading_question_attempts (question_id);
CREATE INDEX IF NOT EXISTS idx_reading_question_attempts_quiz ON pds.reading_question_attempts (quiz_key) WHERE quiz_key IS NOT NULL;

ALTER TABLE pds.reading_quizzes
    ADD COLUMN IF NOT EXISTS op_key            UUID,   -- also added by reading_practice_receipts.sql, read by the trigger below
    ADD COLUMN IF NOT EXISTS question_count    INTEGER CHECK (question_count IS NULL OR question_count > 0),
    ADD COLUMN IF NOT EXISTS invalidated_count INTEGER CHECK (invalidated_count IS NULL OR invalidated_count >= 0);

COMMENT ON COLUMN pds.reading_quizzes.question_count IS
  'Graded answers this result was checked against (pds.reading_question_attempts.quiz_key = op_key); NULL = no per-question record, the score is unverifiable.';
COMMENT ON COLUMN pds.reading_quizzes.invalidated_count IS
  'Answers in this result whose question was corrected after it was recorded; > 0 = the score is invalidated (kept, shown as corrected, not counted).';

ALTER TABLE pds.reading_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.reading_question_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.reading_questions, pds.reading_question_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON pds.reading_questions, pds.reading_question_attempts TO service_role;
GRANT USAGE, SELECT ON SEQUENCE pds.reading_questions_question_id_seq TO service_role;

-- -----------------------------------------------------------
-- The normalized text of a permitted source, or NULL (not permitted, another book, archived or gone).
-- -----------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.reading_source_text(p_book BIGINT, p_kind TEXT, p_ref BIGINT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $fn$
  SELECT NULLIF(regexp_replace(btrim(x.t), '[[:space:]]+', ' ', 'g'), '')
    FROM (
      SELECT h.passage || ' ' || COALESCE(h.comment, '') AS t
        FROM pds.book_highlights h
       WHERE p_kind = 'highlight' AND h.highlight_id = p_ref AND h.book_id = p_book AND NOT h.archived
      UNION ALL
      SELECT s.recall
        FROM pds.reading_sessions s
       WHERE p_kind = 'session' AND s.session_id = p_ref AND s.book_id = p_book
      UNION ALL
      SELECT 'chapter ' || p_ref::text || COALESCE(': ' || c.title, '')
        FROM pds.books b
        LEFT JOIN pds.book_chapters c ON c.book_id = b.book_id AND c.chapter = p_ref
       WHERE p_kind = 'chapter' AND b.book_id = p_book AND p_ref >= 1
         AND (c.chapter IS NOT NULL OR p_ref <= COALESCE(b.total_chapters, 0))
    ) x
   LIMIT 1
$fn$;

CREATE OR REPLACE FUNCTION pds.reading_sha256(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pds, pg_temp
AS $fn$
  SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex')
$fn$;

-- -----------------------------------------------------------
-- Every question / attempt write.
-- answer : {kind, op_key (= attempt_key), book_id, question_key, prompt, rubric?, source_kind, source_ref, answer, quiz_key?}
--          -> {ok, attempt_key, question_id, question_key, version, source_hash, grading_status, source_revised, replayed}
-- grade  : {kind, op_key (= the attempt_key graded), correct, grader ('model'|'self'), feedback?}
--          -> {ok, attempt_key, grading_status, correct, replayed}
-- correct: {kind, op_key, question_key, expected_version, prompt, rubric?, source_kind, source_ref, reason, invalidate?}
--          -> {ok, question_key, version, invalidated, invalidated_attempts, affected_quizzes, replayed}
-- Refusals {ok: false, http, code} are not recorded. Any error rolls the whole call back.
-- -----------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.reading_question_apply(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $fn$
DECLARE
  v_kind     TEXT := p->>'kind';
  v_key      UUID;
  v_book     BIGINT;
  v_qkey     UUID;
  v_quiz     UUID;
  v_sref     BIGINT;
  v_expected INTEGER;
  v_correct  BOOLEAN;
  v_inval    BOOLEAN;
  v_wrong    BOOLEAN;
  v_revised  BOOLEAN := false;
  v_prompt   TEXT := btrim(COALESCE(p->>'prompt', ''));
  v_rubric   TEXT := NULLIF(btrim(COALESCE(p->>'rubric', '')), '');
  v_skind    TEXT := p->>'source_kind';
  v_answer   TEXT := p->>'answer';
  v_grader   TEXT := p->>'grader';
  v_feedback TEXT := NULLIF(btrim(COALESCE(p->>'feedback', '')), '');
  v_reason   TEXT := NULLIF(btrim(COALESCE(p->>'reason', '')), '');
  v_src      TEXT;
  v_shash    TEXT;
  v_chash    TEXT;
  v_rhash    TEXT;
  v_q        pds.reading_questions%ROWTYPE;
  v_new      pds.reading_questions%ROWTYPE;
  v_a        pds.reading_question_attempts%ROWTYPE;
  v_hit      UUID[];
  v_quizzes  INTEGER := 0;
BEGIN
  BEGIN
    v_key := (p->>'op_key')::uuid;
    v_book := NULLIF(p->>'book_id', '')::bigint;
    v_qkey := NULLIF(p->>'question_key', '')::uuid;
    v_quiz := NULLIF(p->>'quiz_key', '')::uuid;
    v_sref := NULLIF(p->>'source_ref', '')::bigint;
    v_expected := NULLIF(p->>'expected_version', '')::int;
    v_correct := NULLIF(p->>'correct', '')::boolean;
    v_inval := NULLIF(p->>'invalidate', '')::boolean;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END;
  IF v_key IS NULL OR v_kind IS NULL OR v_kind NOT IN ('answer', 'grade', 'correct') THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  IF v_kind IN ('answer', 'correct') AND (
       v_qkey IS NULL OR v_prompt = '' OR length(v_prompt) > 1000 OR length(COALESCE(v_rubric, '')) > 2000
       OR v_skind IS NULL OR v_skind NOT IN ('highlight', 'session', 'chapter') OR v_sref IS NULL OR v_sref < 0) THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));

  IF v_kind = 'answer' THEN
    IF v_book IS NULL OR v_answer IS NULL OR btrim(v_answer) = '' OR length(v_answer) > 4000 THEN
      RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
    END IF;
    v_rhash := pds.reading_sha256(jsonb_build_object(
      'book_id', v_book, 'question_key', v_qkey, 'prompt', v_prompt, 'rubric', v_rubric, 'source_kind', v_skind,
      'source_ref', v_sref, 'answer', v_answer, 'quiz_key', v_quiz)::text);

    SELECT * INTO v_a FROM pds.reading_question_attempts WHERE attempt_key = v_key;
    IF FOUND THEN
      IF v_a.request_hash <> v_rhash THEN
        RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'key_reused');
      END IF;
      SELECT * INTO v_q FROM pds.reading_questions WHERE question_id = v_a.question_id;
      RETURN jsonb_build_object('ok', true, 'attempt_key', v_a.attempt_key, 'question_id', v_q.question_id,
        'question_key', v_q.question_key, 'version', v_q.version, 'source_hash', v_q.source_hash,
        'grading_status', v_a.grading_status, 'replayed', true);
    END IF;

    -- A quiz result already recorded under this quiz key takes no more answers.
    IF v_quiz IS NOT NULL AND EXISTS (SELECT 1 FROM pds.reading_quizzes WHERE op_key = v_quiz) THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'quiz_closed');
    END IF;
    -- One counted answer per question per quiz: a second answer under a new key would raise the quiz's total.
    IF v_quiz IS NOT NULL AND EXISTS (
         SELECT 1 FROM pds.reading_question_attempts a
           JOIN pds.reading_questions q ON q.question_id = a.question_id
          WHERE a.quiz_key = v_quiz AND q.question_key = v_qkey AND a.grading_status <> 'invalidated') THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'already_answered');
    END IF;
    -- One book per quiz: the result is checked against these answers, so another book's answers cannot count.
    IF v_quiz IS NOT NULL AND EXISTS (
         SELECT 1 FROM pds.reading_question_attempts a
           JOIN pds.reading_questions q ON q.question_id = a.question_id
          WHERE a.quiz_key = v_quiz AND q.book_id <> v_book) THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'quiz_other_book');
    END IF;

    v_src := pds.reading_source_text(v_book, v_skind, v_sref);
    IF v_src IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'source_not_permitted');
    END IF;
    v_shash := pds.reading_sha256(v_src);
    v_chash := pds.reading_sha256(jsonb_build_object('prompt', v_prompt, 'rubric', v_rubric, 'source_kind', v_skind,
      'source_ref', v_sref, 'source_hash', v_shash)::text);

    SELECT * INTO v_q FROM pds.reading_questions WHERE question_key = v_qkey AND superseded_at IS NULL FOR UPDATE;
    IF FOUND THEN
      -- The question itself is not the version stored: correct it first, never silently.
      IF v_q.book_id <> v_book OR v_q.prompt <> v_prompt OR v_q.rubric IS DISTINCT FROM v_rubric
         OR v_q.source_kind <> v_skind OR v_q.source_ref <> v_sref THEN
        RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'question_changed', 'version', v_q.version);
      END IF;
      -- Only the source's text moved (a highlight comment or recall note was edited): the next version records the
      -- text this answer is given against. Earlier answers were graded against their own version and stay valid.
      IF v_q.content_hash <> v_chash THEN
        UPDATE pds.reading_questions SET superseded_at = NOW(), superseded_reason = 'source text changed'
         WHERE question_id = v_q.question_id;
        INSERT INTO pds.reading_questions (question_key, version, book_id, prompt, rubric, source_kind, source_ref, source_hash, content_hash)
        VALUES (v_qkey, v_q.version + 1, v_book, v_prompt, v_rubric, v_skind, v_sref, v_shash, v_chash)
        RETURNING * INTO v_q;
        v_revised := true;
      END IF;
    ELSE
      INSERT INTO pds.reading_questions (question_key, version, book_id, prompt, rubric, source_kind, source_ref, source_hash, content_hash)
      VALUES (v_qkey, 1, v_book, v_prompt, v_rubric, v_skind, v_sref, v_shash, v_chash)
      RETURNING * INTO v_q;
    END IF;

    INSERT INTO pds.reading_question_attempts (attempt_key, question_id, quiz_key, attempt_date, answer, answer_hash, request_hash)
    VALUES (v_key, v_q.question_id, v_quiz, pds.behavioral_today_now(), v_answer, pds.reading_sha256(v_answer), v_rhash)
    RETURNING * INTO v_a;
    RETURN jsonb_build_object('ok', true, 'attempt_key', v_a.attempt_key, 'question_id', v_q.question_id,
      'question_key', v_q.question_key, 'version', v_q.version, 'source_hash', v_q.source_hash,
      'grading_status', v_a.grading_status, 'source_revised', v_revised, 'replayed', false);

  ELSIF v_kind = 'grade' THEN
    IF v_correct IS NULL OR v_grader IS NULL OR v_grader NOT IN ('model', 'self') OR length(COALESCE(v_feedback, '')) > 2000 THEN
      RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
    END IF;
    SELECT * INTO v_a FROM pds.reading_question_attempts WHERE attempt_key = v_key FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;
    IF v_a.grading_status = 'invalidated' THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'invalidated');
    END IF;
    IF v_a.grading_status = 'graded' THEN
      -- Feedback cleared by the retention function can no longer be compared: the grade and grader decide then.
      IF v_a.correct = v_correct AND v_a.grader = v_grader
         AND (v_a.answer_cleared_at IS NOT NULL OR v_a.feedback IS NOT DISTINCT FROM v_feedback) THEN
        RETURN jsonb_build_object('ok', true, 'attempt_key', v_a.attempt_key, 'grading_status', 'graded', 'correct', v_a.correct, 'replayed', true);
      END IF;
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'already_graded');
    END IF;
    UPDATE pds.reading_question_attempts
       SET grading_status = 'graded', correct = v_correct, grader = v_grader, feedback = v_feedback, graded_at = NOW()
     WHERE attempt_key = v_key
    RETURNING * INTO v_a;
    RETURN jsonb_build_object('ok', true, 'attempt_key', v_a.attempt_key, 'grading_status', 'graded', 'correct', v_a.correct, 'replayed', false);

  ELSE -- correct
    IF v_expected IS NULL OR v_reason IS NULL OR length(v_reason) > 500 THEN
      RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
    END IF;
    v_rhash := pds.reading_sha256(jsonb_build_object(
      'question_key', v_qkey, 'expected_version', v_expected, 'prompt', v_prompt, 'rubric', v_rubric,
      'source_kind', v_skind, 'source_ref', v_sref, 'reason', v_reason, 'invalidate', v_inval)::text);

    SELECT * INTO v_new FROM pds.reading_questions WHERE op_key = v_key;
    IF FOUND THEN
      IF v_new.request_hash IS DISTINCT FROM v_rhash THEN
        RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'key_reused');
      END IF;
      RETURN jsonb_build_object('ok', true, 'question_key', v_new.question_key, 'version', v_new.version, 'replayed', true);
    END IF;

    SELECT * INTO v_q FROM pds.reading_questions WHERE question_key = v_qkey AND superseded_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;
    IF v_q.version <> v_expected THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'changed', 'version', v_q.version);
    END IF;
    v_src := pds.reading_source_text(v_q.book_id, v_skind, v_sref);
    IF v_src IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'source_not_permitted');
    END IF;
    v_shash := pds.reading_sha256(v_src);
    v_chash := pds.reading_sha256(jsonb_build_object('prompt', v_prompt, 'rubric', v_rubric, 'source_kind', v_skind,
      'source_ref', v_sref, 'source_hash', v_shash)::text);
    IF v_chash = v_q.content_hash THEN
      RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'no_change');
    END IF;
    -- The question itself changed (prompt, rubric or source reference): the answers given to it were judged against
    -- a wrong question, so by default they are invalidated. A change of the source's text alone is not.
    v_wrong := v_q.prompt <> v_prompt OR v_q.rubric IS DISTINCT FROM v_rubric
               OR v_q.source_kind <> v_skind OR v_q.source_ref <> v_sref;
    v_inval := COALESCE(v_inval, v_wrong);

    UPDATE pds.reading_questions SET superseded_at = NOW(), superseded_reason = v_reason WHERE question_id = v_q.question_id;
    INSERT INTO pds.reading_questions (question_key, version, book_id, prompt, rubric, source_kind, source_ref, source_hash, content_hash, op_key, request_hash)
    VALUES (v_qkey, v_q.version + 1, v_q.book_id, v_prompt, v_rubric, v_skind, v_sref, v_shash, v_chash, v_key, v_rhash)
    RETURNING * INTO v_new;

    -- Invalidating: answers to every older version are marked (kept, with the reason); results that counted them
    -- say so. Not invalidating: nothing is marked, every earlier answer keeps counting.
    SELECT COALESCE(array_agg(a.attempt_key), '{}') INTO v_hit
      FROM pds.reading_question_attempts a
      JOIN pds.reading_questions q ON q.question_id = a.question_id
     WHERE v_inval AND q.question_key = v_qkey AND q.question_id <> v_new.question_id AND a.grading_status <> 'invalidated';
    UPDATE pds.reading_question_attempts
       SET grading_status = 'invalidated', invalidated_at = NOW(),
           invalidated_reason = 'question corrected to version ' || v_new.version
     WHERE attempt_key = ANY(v_hit);
    UPDATE pds.reading_quizzes qz
       SET invalidated_count = COALESCE(qz.invalidated_count, 0) + x.n
      FROM (SELECT quiz_key, count(*)::int AS n FROM pds.reading_question_attempts
             WHERE attempt_key = ANY(v_hit) AND quiz_key IS NOT NULL GROUP BY quiz_key) x
     WHERE qz.op_key = x.quiz_key;
    GET DIAGNOSTICS v_quizzes = ROW_COUNT;

    RETURN jsonb_build_object('ok', true, 'question_key', v_qkey, 'version', v_new.version, 'invalidated', v_inval,
      'invalidated_attempts', cardinality(v_hit), 'affected_quizzes', v_quizzes, 'replayed', false);
  END IF;
END
$fn$;

-- -----------------------------------------------------------
-- A quiz result recorded under op_key K is checked against the answers given with quiz_key K (if any).
-- Without such answers it stays as before: question_count NULL (unverifiable). Answers already invalidated by a
-- correction do not count; when every answer was invalidated there is nothing left to check the score against, so
-- the result is refused (OXQ02) rather than stored as unverifiable. Answers about another book than the result's
-- refuse it (OXQ03): they can never verify it.
-- -----------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.reading_quiz_link_attempts()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pds, pg_temp
AS $fn$
DECLARE
  v_all     INTEGER;
  v_total   INTEGER;
  v_pending INTEGER;
  v_right   INTEGER;
  v_other   INTEGER;
BEGIN
  IF NEW.op_key IS NULL THEN RETURN NEW; END IF;
  SELECT count(*),
         count(*) FILTER (WHERE a.grading_status <> 'invalidated'),
         count(*) FILTER (WHERE a.grading_status = 'pending'),
         count(*) FILTER (WHERE a.grading_status = 'graded' AND a.correct),
         count(*) FILTER (WHERE q.book_id <> NEW.book_id)
    INTO v_all, v_total, v_pending, v_right, v_other
    FROM pds.reading_question_attempts a
    JOIN pds.reading_questions q ON q.question_id = a.question_id
   WHERE a.quiz_key = NEW.op_key;
  IF v_all = 0 THEN RETURN NEW; END IF;
  IF v_other > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'OXQ03', MESSAGE = 'quiz result has answers about another book';
  END IF;
  IF v_pending > 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'OXQ01', MESSAGE = 'quiz result has ungraded answers';
  END IF;
  IF NEW.total <> v_total OR NEW.score <> v_right THEN
    RAISE EXCEPTION USING ERRCODE = 'OXQ02', MESSAGE = 'quiz score does not match its graded answers';
  END IF;
  NEW.question_count := v_total;
  NEW.invalidated_count := 0;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER trg_reading_quizzes_link_attempts
    BEFORE INSERT ON pds.reading_quizzes
    FOR EACH ROW EXECUTE FUNCTION pds.reading_quiz_link_attempts();

-- -----------------------------------------------------------
-- Inspection / export of one book's questions and attempts (raw answers included: owner-session route only,
-- no-store, kept in memory only by the client cache).
-- -----------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.reading_questions_export(p_book BIGINT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $fn$
  SELECT jsonb_build_object(
    'questions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'question_id', q.question_id, 'question_key', q.question_key, 'version', q.version,
               'prompt', q.prompt, 'rubric', q.rubric, 'source_kind', q.source_kind, 'source_ref', q.source_ref,
               'source_hash', q.source_hash,
               'source_status', CASE WHEN s.t IS NULL THEN 'removed'
                                     WHEN pds.reading_sha256(s.t) = q.source_hash THEN 'same' ELSE 'changed' END,
               'created_at', q.created_at, 'superseded_at', q.superseded_at, 'superseded_reason', q.superseded_reason)
             ORDER BY q.question_key, q.version)
        FROM pds.reading_questions q
        CROSS JOIN LATERAL (SELECT pds.reading_source_text(q.book_id, q.source_kind, q.source_ref) AS t) s
       WHERE q.book_id = p_book), '[]'::jsonb),
    'attempts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'attempt_key', a.attempt_key, 'question_id', a.question_id, 'quiz_key', a.quiz_key,
               'attempt_date', a.attempt_date, 'answer', a.answer, 'answered_at', a.answered_at,
               'grading_status', a.grading_status, 'correct', a.correct, 'grader', a.grader, 'feedback', a.feedback,
               'graded_at', a.graded_at, 'invalidated_at', a.invalidated_at, 'invalidated_reason', a.invalidated_reason,
               'answer_cleared_at', a.answer_cleared_at)
             ORDER BY a.answered_at, a.attempt_key)
        FROM pds.reading_question_attempts a
        JOIN pds.reading_questions q ON q.question_id = a.question_id
       WHERE q.book_id = p_book), '[]'::jsonb))
$fn$;

-- -----------------------------------------------------------
-- Retention of the raw exchange: clear answer + feedback text of attempts graded / invalidated more than p_days ago.
-- Keeps the answer hash, the grade and every timestamp. Not scheduled here.
-- -----------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.reading_clear_question_answers(p_days INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $fn$
DECLARE
  v_n INTEGER;
BEGIN
  IF p_days IS NULL OR p_days < 30 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'p_days must be at least 30';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));
  UPDATE pds.reading_question_attempts
     SET answer = NULL, feedback = NULL, answer_cleared_at = NOW()
   WHERE answer_cleared_at IS NULL
     AND grading_status <> 'pending'
     AND COALESCE(invalidated_at, graded_at) < NOW() - make_interval(days => p_days);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

REVOKE ALL ON FUNCTION pds.reading_source_text(BIGINT, TEXT, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.reading_sha256(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.reading_question_apply(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.reading_quiz_link_attempts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.reading_questions_export(BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.reading_clear_question_answers(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.reading_source_text(BIGINT, TEXT, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION pds.reading_sha256(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION pds.reading_question_apply(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION pds.reading_quiz_link_attempts() TO service_role;
GRANT EXECUTE ON FUNCTION pds.reading_questions_export(BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION pds.reading_clear_question_answers(INTEGER) TO service_role;

COMMENT ON TABLE pds.reading_questions IS
  'Reading learning questions, one row per version, with the permitted source and its sha-256 at that version (service_role only).';
COMMENT ON TABLE pds.reading_question_attempts IS
  'One answer per client attempt key; grading is a separate step; corrections invalidate and keep every row (service_role only).';
COMMENT ON FUNCTION pds.reading_question_apply(JSONB) IS
  'Reading questions: answer / grade / correct, one transaction under the practice lock, replay safe (service_role only).';
