-- ============================================================
-- Reading practice: database fixture for the transaction guarantees (PROD-T02 / PROD-T07)
-- ============================================================
-- The node tests (frontend/tests/reading-practice.test.cjs, reading-questions.test.cjs) mock the database. This file
-- runs the real functions of sql/reading_practice_receipts.sql and sql/reading_learning_questions.sql:
--   * a grade replayed after a lost answer stores one review; the same key with another grade is key_reused;
--   * a grade on an older state is changed / raced, and a failing schedule write rolls the review back;
--   * a quiz result replays once; one with ungraded answers, a wrong score or another book's answers is refused;
--   * a correction invalidates the old answers (kept) and marks the result that counted them;
--   * an edit of a source's text alone makes a new version without invalidating anything, and a wording fix can
--     say so (invalidate = false); a grade replay still matches after retention cleared its feedback;
--   * invalidate = true needs no other change: after a wrong source text was fixed (and an answer already made the
--     version for the fixed text), it voids the answers given against the old text and keeps the newer ones.
--
-- Run ONLY on a disposable copy of the database (a local restore or a throwaway branch) with both SQL files
-- applied, never on production. It refuses to start without the session setting below, and the whole run is one
-- transaction that ends in ROLLBACK, so it leaves nothing behind (sequences excepted). Synthetic rows only.
--
--   PGOPTIONS="-c onyx.fixture_db=disposable" psql "$DISPOSABLE_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f tests/sql/reading_practice_fixture.sql
--
-- Success prints "reading practice fixture: all checks passed". Any failed ASSERT stops the run.
-- Concurrency needs two sessions, so it is the manual check at the end of this file.
-- ============================================================

BEGIN;

DO $guard$
BEGIN
  IF current_setting('onyx.fixture_db', true) IS DISTINCT FROM 'disposable' THEN
    RAISE EXCEPTION 'reading practice fixture: set onyx.fixture_db = disposable (and never run this on production)';
  END IF;
  IF to_regprocedure('pds.reading_grade_review(jsonb)') IS NULL OR to_regprocedure('pds.reading_question_apply(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'reading practice fixture: apply sql/reading_practice_receipts.sql and sql/reading_learning_questions.sql first';
  END IF;
END
$guard$;

-- A schedule write that fails on a sentinel interval (77 days), to prove the review insert does not survive it.
CREATE FUNCTION pds.zz_fixture_fail_schedule() RETURNS TRIGGER LANGUAGE plpgsql AS $t$
BEGIN
  IF NEW.interval_days = 77 THEN
    RAISE EXCEPTION USING ERRCODE = 'OXF01', MESSAGE = 'fixture: the schedule write fails';
  END IF;
  RETURN NEW;
END
$t$;
CREATE TRIGGER zz_fixture_fail_schedule BEFORE UPDATE ON pds.book_highlights
  FOR EACH ROW EXECUTE FUNCTION pds.zz_fixture_fail_schedule();

DO $fx$
DECLARE
  v_a   BIGINT;
  v_b   BIGINT;
  v_h   BIGINT;
  v_h2  BIGINT;
  k1    UUID := gen_random_uuid();
  k2    UUID := gen_random_uuid();
  k3    UUID := gen_random_uuid();
  k4    UUID := gen_random_uuid();
  kq    UUID := gen_random_uuid();
  qz1   UUID := gen_random_uuid();
  qz2   UUID := gen_random_uuid();
  qk1   UUID := gen_random_uuid();
  qk2   UUID := gen_random_uuid();
  a1    UUID := gen_random_uuid();
  a2    UUID := gen_random_uuid();
  a3    UUID := gen_random_uuid();
  kc    UUID := gen_random_uuid();
  kc2   UUID := gen_random_uuid();
  kc3   UUID := gen_random_uuid();
  qk3   UUID := gen_random_uuid();
  qz3   UUID := gen_random_uuid();
  a4    UUID := gen_random_uuid();
  a5    UUID := gen_random_uuid();
  v_h3  BIGINT;
  qk4   UUID := gen_random_uuid();
  qz4   UUID := gen_random_uuid();
  a6    UUID := gen_random_uuid();
  a7    UUID := gen_random_uuid();
  kc4   UUID := gen_random_uuid();
  kc5   UUID := gen_random_uuid();
  n2    INTEGER;
  r     JSONB;
  r2    JSONB;
  n     INTEGER;
  hit   BOOLEAN;
  d0    DATE := DATE '2030-01-10';
BEGIN
  INSERT INTO pds.books (slug, title, total_chapters, status) VALUES ('fixture-practice-a', 'Fixture book A', 10, 'reading')
    RETURNING book_id INTO v_a;
  INSERT INTO pds.books (slug, title, total_chapters, status) VALUES ('fixture-practice-b', 'Fixture book B', 10, 'reading')
    RETURNING book_id INTO v_b;
  INSERT INTO pds.book_highlights (book_id, chapter, passage, comment)
    VALUES (v_a, 1, 'Fixture passage about a bottleneck.', 'Fixture comment.')
    RETURNING highlight_id INTO v_h;

  -- ---- Review grades ----------------------------------------------------------------------------------------
  r := pds.reading_grade_review(jsonb_build_object(
    'op_key', k1, 'highlight_id', v_h, 'grade', 'good', 'review_date', d0, 'client_review_count', 0,
    'basis', jsonb_build_object('review_count', 0, 'interval_days', 0, 'ease', 2.5),
    'schedule', jsonb_build_object('ease', 2.5, 'interval_days', 1, 'next_review', d0 + 1)));
  ASSERT (r->>'ok')::boolean AND NOT (r->>'replayed')::boolean, 'first grade applies: ' || r::text;
  ASSERT (r->>'first_review_today')::boolean, 'first review of the day';

  -- The same key after midnight (the server re-read the row, so its basis is the new state): the first receipt.
  r2 := pds.reading_grade_review(jsonb_build_object(
    'op_key', k1, 'highlight_id', v_h, 'grade', 'good', 'review_date', d0 + 1, 'client_review_count', 1,
    'basis', jsonb_build_object('review_count', 1, 'interval_days', 1, 'ease', 2.5),
    'schedule', jsonb_build_object('ease', 2.5, 'interval_days', 3, 'next_review', d0 + 4)));
  ASSERT (r2->>'replayed')::boolean AND r2->>'review_id' = r->>'review_id' AND r2->>'review_date' = d0::text,
    'a retry answers the first receipt: ' || r2::text;
  SELECT count(*) INTO n FROM pds.reading_reviews WHERE highlight_id = v_h;
  ASSERT n = 1, 'one review stored, got ' || n;
  SELECT review_count INTO n FROM pds.book_highlights WHERE highlight_id = v_h;
  ASSERT n = 1, 'the schedule moved once, review_count ' || n;

  r := pds.reading_grade_review(jsonb_build_object(
    'op_key', k1, 'highlight_id', v_h, 'grade', 'easy', 'review_date', d0, 'client_review_count', 1,
    'basis', jsonb_build_object('review_count', 1, 'interval_days', 1, 'ease', 2.5),
    'schedule', jsonb_build_object('ease', 2.65, 'interval_days', 3, 'next_review', d0 + 3)));
  ASSERT r->>'code' = 'key_reused', 'the same key with another grade: ' || r::text;

  r := pds.reading_grade_review(jsonb_build_object(
    'op_key', k2, 'highlight_id', v_h, 'grade', 'good', 'review_date', d0, 'client_review_count', 0,
    'basis', jsonb_build_object('review_count', 1, 'interval_days', 1, 'ease', 2.5),
    'schedule', jsonb_build_object('ease', 2.5, 'interval_days', 3, 'next_review', d0 + 3)));
  ASSERT r->>'code' = 'changed' AND (r->>'http')::int = 409, 'a card older than the row: ' || r::text;

  r := pds.reading_grade_review(jsonb_build_object(
    'op_key', k3, 'highlight_id', v_h, 'grade', 'good', 'review_date', d0, 'client_review_count', 1,
    'basis', jsonb_build_object('review_count', 0, 'interval_days', 0, 'ease', 2.5),
    'schedule', jsonb_build_object('ease', 2.5, 'interval_days', 1, 'next_review', d0 + 1)));
  ASSERT r->>'code' = 'raced', 'a schedule computed from another state: ' || r::text;

  r := pds.reading_grade_review(jsonb_build_object(
    'op_key', k3, 'highlight_id', v_h, 'grade', 'good', 'review_date', d0, 'client_review_count', 'x'));
  ASSERT r->>'code' = 'bad_request', 'a malformed call is 400, not an error: ' || r::text;

  -- A failing schedule write: the review insert before it is rolled back with it (the route's call is one statement).
  hit := false;
  BEGIN
    PERFORM pds.reading_grade_review(jsonb_build_object(
      'op_key', k4, 'highlight_id', v_h, 'grade', 'good', 'review_date', d0, 'client_review_count', 1,
      'basis', jsonb_build_object('review_count', 1, 'interval_days', 1, 'ease', 2.5),
      'schedule', jsonb_build_object('ease', 2.5, 'interval_days', 77, 'next_review', d0 + 77)));
  EXCEPTION WHEN SQLSTATE 'OXF01' THEN
    hit := true;
  END;
  ASSERT hit, 'the sentinel schedule write failed';
  SELECT count(*) INTO n FROM pds.reading_reviews WHERE op_key = k4;
  ASSERT n = 0, 'no review survives a failed schedule write';
  SELECT count(*) INTO n FROM pds.reading_practice_ops WHERE op_key = k4;
  ASSERT n = 0, 'no receipt either, so the key is not spent';
  SELECT review_count INTO n FROM pds.book_highlights WHERE highlight_id = v_h;
  ASSERT n = 1, 'the schedule is unchanged';

  -- ---- Quiz results without per-question answers -------------------------------------------------------------
  r := pds.reading_record_quiz(jsonb_build_object('op_key', kq, 'book_id', v_a, 'checkpoint', 'ch3', 'score', 4, 'total', 5, 'quiz_date', d0));
  ASSERT (r->>'ok')::boolean AND NOT (r->>'replayed')::boolean, 'quiz result stored: ' || r::text;
  r2 := pds.reading_record_quiz(jsonb_build_object('op_key', kq, 'book_id', v_a, 'checkpoint', 'ch3', 'score', 4, 'total', 5, 'quiz_date', d0));
  ASSERT (r2->>'replayed')::boolean AND r2->>'quiz_id' = r->>'quiz_id', 'a retry answers the first receipt';
  SELECT count(*) INTO n FROM pds.reading_quizzes WHERE op_key = kq;
  ASSERT n = 1, 'one quiz row, got ' || n;
  r := pds.reading_record_quiz(jsonb_build_object('op_key', kq, 'book_id', v_a, 'checkpoint', 'ch3', 'score', 5, 'total', 5, 'quiz_date', d0));
  ASSERT r->>'code' = 'key_reused', 'the same key with another score';
  SELECT question_count INTO n FROM pds.reading_quizzes WHERE op_key = kq;
  ASSERT n IS NULL, 'a result without answers stays unverifiable';

  -- ---- Learning questions -------------------------------------------------------------------------------------
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'answer', 'op_key', a1, 'book_id', v_a, 'question_key', qk1, 'prompt', 'Fixture question one?',
    'source_kind', 'highlight', 'source_ref', v_h, 'answer', 'Fixture answer.', 'quiz_key', qz1));
  ASSERT (r->>'ok')::boolean AND r->>'grading_status' = 'pending' AND (r->>'version')::int = 1, 'answer stored: ' || r::text;
  r2 := pds.reading_question_apply(jsonb_build_object(
    'kind', 'answer', 'op_key', a1, 'book_id', v_a, 'question_key', qk1, 'prompt', 'Fixture question one?',
    'source_kind', 'highlight', 'source_ref', v_h, 'answer', 'Fixture answer.', 'quiz_key', qz1));
  ASSERT (r2->>'replayed')::boolean, 'the same answer replays';
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'answer', 'op_key', gen_random_uuid(), 'book_id', v_a, 'question_key', qk1, 'prompt', 'Fixture question one?',
    'source_kind', 'highlight', 'source_ref', v_h, 'answer', 'Another answer.', 'quiz_key', qz1));
  ASSERT r->>'code' = 'already_answered', 'one counted answer per question per quiz: ' || r::text;
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'answer', 'op_key', gen_random_uuid(), 'book_id', v_b, 'question_key', qk2, 'prompt', 'Fixture question two?',
    'source_kind', 'chapter', 'source_ref', 1, 'answer', 'Fixture answer.', 'quiz_key', qz1));
  ASSERT r->>'code' = 'quiz_other_book', 'another book cannot answer into this quiz: ' || r::text;

  hit := false;
  BEGIN
    PERFORM pds.reading_record_quiz(jsonb_build_object('op_key', qz1, 'book_id', v_a, 'checkpoint', 'ch3', 'score', 1, 'total', 1, 'quiz_date', d0));
  EXCEPTION WHEN SQLSTATE 'OXQ01' THEN
    hit := true;
  END;
  ASSERT hit, 'a result with ungraded answers is refused';
  SELECT count(*) INTO n FROM pds.reading_practice_ops WHERE op_key = qz1;
  ASSERT n = 0, 'a refused result spends no key';

  r := pds.reading_question_apply(jsonb_build_object('kind', 'grade', 'op_key', a1, 'correct', true, 'grader', 'self'));
  ASSERT (r->>'ok')::boolean AND r->>'grading_status' = 'graded', 'graded: ' || r::text;
  r := pds.reading_question_apply(jsonb_build_object('kind', 'grade', 'op_key', a1, 'correct', false, 'grader', 'self'));
  ASSERT r->>'code' = 'already_graded', 'another grade for the same answer';

  hit := false;
  BEGIN
    PERFORM pds.reading_record_quiz(jsonb_build_object('op_key', qz1, 'book_id', v_a, 'checkpoint', 'ch3', 'score', 0, 'total', 1, 'quiz_date', d0));
  EXCEPTION WHEN SQLSTATE 'OXQ02' THEN
    hit := true;
  END;
  ASSERT hit, 'a score that differs from the graded answers is refused';

  r := pds.reading_record_quiz(jsonb_build_object('op_key', qz1, 'book_id', v_a, 'checkpoint', 'ch3', 'score', 1, 'total', 1, 'quiz_date', d0));
  ASSERT (r->>'ok')::boolean, 'a matching result is stored: ' || r::text;
  SELECT question_count INTO n FROM pds.reading_quizzes WHERE op_key = qz1;
  ASSERT n = 1, 'verified against one answer';
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'answer', 'op_key', gen_random_uuid(), 'book_id', v_a, 'question_key', qk2, 'prompt', 'Fixture question two?',
    'source_kind', 'chapter', 'source_ref', 1, 'answer', 'Late answer.', 'quiz_key', qz1));
  ASSERT r->>'code' = 'quiz_closed', 'a recorded result takes no more answers';

  -- Graded answers about book B cannot verify a result recorded for book A.
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'answer', 'op_key', a3, 'book_id', v_b, 'question_key', qk2, 'prompt', 'Fixture question two?',
    'source_kind', 'chapter', 'source_ref', 1, 'answer', 'Fixture answer.', 'quiz_key', qz2));
  ASSERT (r->>'ok')::boolean, 'answer for book B: ' || r::text;
  PERFORM pds.reading_question_apply(jsonb_build_object('kind', 'grade', 'op_key', a3, 'correct', true, 'grader', 'model', 'feedback', 'Fixture feedback.'));
  hit := false;
  BEGIN
    PERFORM pds.reading_record_quiz(jsonb_build_object('op_key', qz2, 'book_id', v_a, 'checkpoint', 'ch3', 'score', 1, 'total', 1, 'quiz_date', d0));
  EXCEPTION WHEN SQLSTATE 'OXQ03' THEN
    hit := true;
  END;
  ASSERT hit, 'a result for book A with book B answers is refused';

  -- A correction makes version 2, invalidates the answer to version 1 (kept) and marks the result that counted it.
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'correct', 'op_key', kc, 'question_key', qk1, 'expected_version', 1, 'prompt', 'Fixture question one, corrected?',
    'source_kind', 'highlight', 'source_ref', v_h, 'reason', 'Fixture correction.'));
  ASSERT (r->>'ok')::boolean AND (r->>'version')::int = 2 AND (r->>'invalidated_attempts')::int = 1
    AND (r->>'affected_quizzes')::int = 1, 'correction: ' || r::text;
  r2 := pds.reading_question_apply(jsonb_build_object(
    'kind', 'correct', 'op_key', kc, 'question_key', qk1, 'expected_version', 1, 'prompt', 'Fixture question one, corrected?',
    'source_kind', 'highlight', 'source_ref', v_h, 'reason', 'Fixture correction.'));
  ASSERT (r2->>'replayed')::boolean, 'the same correction replays';
  SELECT count(*) INTO n FROM pds.reading_question_attempts WHERE attempt_key = a1 AND grading_status = 'invalidated' AND correct;
  ASSERT n = 1, 'the old answer is kept, with its grade, as invalidated';
  SELECT invalidated_count INTO n FROM pds.reading_quizzes WHERE op_key = qz1;
  ASSERT n = 1, 'the result that counted it is marked';
  SELECT count(*) INTO n FROM pds.reading_questions WHERE question_key = qk1;
  ASSERT n = 2, 'both versions are kept';
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'answer', 'op_key', a2, 'book_id', v_a, 'question_key', qk1, 'prompt', 'Fixture question one?',
    'source_kind', 'highlight', 'source_ref', v_h, 'answer', 'Answer to the old wording.'));
  ASSERT r->>'code' = 'question_changed', 'the old wording is not answered silently: ' || r::text;

  -- Only the source's text moves (the highlight's comment is edited): the next answer makes the next version itself,
  -- and the earlier graded answer keeps counting, so its quiz stays verified.
  INSERT INTO pds.book_highlights (book_id, chapter, passage, comment)
    VALUES (v_a, 2, 'Fixture passage about throughput.', 'Fixture comment before the edit.')
    RETURNING highlight_id INTO v_h2;
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'answer', 'op_key', a4, 'book_id', v_a, 'question_key', qk3, 'prompt', 'Fixture question three?',
    'source_kind', 'highlight', 'source_ref', v_h2, 'answer', 'Fixture answer.', 'quiz_key', qz3));
  ASSERT (r->>'ok')::boolean AND (r->>'version')::int = 1 AND NOT (r->>'source_revised')::boolean, 'answer: ' || r::text;
  PERFORM pds.reading_question_apply(jsonb_build_object('kind', 'grade', 'op_key', a4, 'correct', true, 'grader', 'self'));
  r := pds.reading_record_quiz(jsonb_build_object('op_key', qz3, 'book_id', v_a, 'checkpoint', 'ch3', 'score', 1, 'total', 1, 'quiz_date', d0));
  ASSERT (r->>'ok')::boolean, 'quiz verified against one answer: ' || r::text;
  UPDATE pds.book_highlights SET comment = 'Fixture comment after the edit.' WHERE highlight_id = v_h2;
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'answer', 'op_key', a5, 'book_id', v_a, 'question_key', qk3, 'prompt', 'Fixture question three?',
    'source_kind', 'highlight', 'source_ref', v_h2, 'answer', 'Fixture answer after the edit.'));
  ASSERT (r->>'ok')::boolean AND (r->>'version')::int = 2 AND (r->>'source_revised')::boolean,
    'an edited source makes version 2, it is not a refusal: ' || r::text;
  SELECT count(*) INTO n FROM pds.reading_questions
   WHERE question_key = qk3 AND version = 1 AND superseded_reason = 'source text changed';
  ASSERT n = 1, 'version 1 is kept, superseded because its source text changed';
  SELECT count(*) INTO n FROM pds.reading_question_attempts WHERE attempt_key = a4 AND grading_status = 'graded';
  ASSERT n = 1, 'the earlier answer stays graded';
  SELECT question_count, invalidated_count INTO n, n2 FROM pds.reading_quizzes WHERE op_key = qz3;
  ASSERT n = 1 AND n2 = 0, 'the old quiz is still verified, not corrected';

  -- A wording fix that says it changes nothing for the answers given: a new version, nothing invalidated.
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'correct', 'op_key', kc2, 'question_key', qk3, 'expected_version', 2, 'prompt', 'Fixture question three, reworded?',
    'source_kind', 'highlight', 'source_ref', v_h2, 'reason', 'Fixture wording.', 'invalidate', false));
  ASSERT (r->>'ok')::boolean AND (r->>'version')::int = 3 AND NOT (r->>'invalidated')::boolean
    AND (r->>'invalidated_attempts')::int = 0, 'a wording fix: ' || r::text;
  SELECT invalidated_count INTO n FROM pds.reading_quizzes WHERE op_key = qz3;
  ASSERT n = 0, 'the quiz is untouched by the wording fix';
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'correct', 'op_key', kc2, 'question_key', qk3, 'expected_version', 2, 'prompt', 'Fixture question three, reworded?',
    'source_kind', 'highlight', 'source_ref', v_h2, 'reason', 'Fixture wording.'));
  ASSERT r->>'code' = 'key_reused', 'the same key without the flag is another request: ' || r::text;

  -- A changed prompt without the flag: the default invalidates the answers to every older version.
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'correct', 'op_key', kc3, 'question_key', qk3, 'expected_version', 3, 'prompt', 'Fixture question three, corrected?',
    'source_kind', 'highlight', 'source_ref', v_h2, 'reason', 'Fixture correction.'));
  ASSERT (r->>'ok')::boolean AND (r->>'invalidated')::boolean AND (r->>'invalidated_attempts')::int = 2
    AND (r->>'affected_quizzes')::int = 1, 'a real correction: ' || r::text;
  SELECT invalidated_count INTO n FROM pds.reading_quizzes WHERE op_key = qz3;
  ASSERT n = 1, 'now the quiz is marked corrected';

  -- The source text was wrong: the answers given against it must stop counting, even after the next answer made the
  -- version for the fixed text by itself (same prompt, rubric and source, so the content no longer differs).
  INSERT INTO pds.book_highlights (book_id, chapter, passage, comment)
    VALUES (v_a, 3, 'Fixture passage about inventory.', 'Fixture comment that turns out to be wrong.')
    RETURNING highlight_id INTO v_h3;
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'answer', 'op_key', a6, 'book_id', v_a, 'question_key', qk4, 'prompt', 'Fixture question four?',
    'source_kind', 'highlight', 'source_ref', v_h3, 'answer', 'Fixture answer.', 'quiz_key', qz4));
  ASSERT (r->>'ok')::boolean AND (r->>'version')::int = 1, 'answer: ' || r::text;
  PERFORM pds.reading_question_apply(jsonb_build_object('kind', 'grade', 'op_key', a6, 'correct', true, 'grader', 'self'));
  r := pds.reading_record_quiz(jsonb_build_object('op_key', qz4, 'book_id', v_a, 'checkpoint', 'ch3', 'score', 1, 'total', 1, 'quiz_date', d0));
  ASSERT (r->>'ok')::boolean, 'quiz verified against one answer: ' || r::text;
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'correct', 'op_key', kc4, 'question_key', qk4, 'expected_version', 1, 'prompt', 'Fixture question four?',
    'source_kind', 'highlight', 'source_ref', v_h3, 'reason', 'Fixture: nothing changed.'));
  ASSERT r->>'code' = 'no_change', 'no change and no flag is still no correction: ' || r::text;
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'correct', 'op_key', kc4, 'question_key', qk4, 'expected_version', 1, 'prompt', 'Fixture question four?',
    'source_kind', 'highlight', 'source_ref', v_h3, 'reason', 'Fixture: nothing changed.', 'invalidate', true));
  ASSERT r->>'code' = 'no_change', 'answers to the current content are not voided by the flag alone: ' || r::text;
  UPDATE pds.book_highlights SET comment = 'Fixture comment, fixed.' WHERE highlight_id = v_h3;
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'answer', 'op_key', a7, 'book_id', v_a, 'question_key', qk4, 'prompt', 'Fixture question four?',
    'source_kind', 'highlight', 'source_ref', v_h3, 'answer', 'Fixture answer against the fixed text.'));
  ASSERT (r->>'ok')::boolean AND (r->>'version')::int = 2 AND (r->>'source_revised')::boolean, 'auto version 2: ' || r::text;
  PERFORM pds.reading_question_apply(jsonb_build_object('kind', 'grade', 'op_key', a7, 'correct', true, 'grader', 'self'));
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'correct', 'op_key', kc4, 'question_key', qk4, 'expected_version', 2, 'prompt', 'Fixture question four?',
    'source_kind', 'highlight', 'source_ref', v_h3, 'reason', 'Fixture: the source text was wrong.', 'invalidate', true));
  ASSERT (r->>'ok')::boolean AND (r->>'version')::int = 3 AND (r->>'invalidated')::boolean
    AND (r->>'invalidated_attempts')::int = 1 AND (r->>'affected_quizzes')::int = 1,
    'an explicit invalidation with nothing else changed: ' || r::text;
  r2 := pds.reading_question_apply(jsonb_build_object(
    'kind', 'correct', 'op_key', kc4, 'question_key', qk4, 'expected_version', 2, 'prompt', 'Fixture question four?',
    'source_kind', 'highlight', 'source_ref', v_h3, 'reason', 'Fixture: the source text was wrong.', 'invalidate', true));
  ASSERT (r2->>'replayed')::boolean AND (r2->>'version')::int = 3, 'the same invalidation replays: ' || r2::text;
  SELECT count(*) INTO n FROM pds.reading_question_attempts WHERE attempt_key = a6 AND grading_status = 'invalidated' AND correct;
  ASSERT n = 1, 'the answer given against the wrong text is kept, as invalidated';
  SELECT count(*) INTO n FROM pds.reading_question_attempts WHERE attempt_key = a7 AND grading_status = 'graded';
  ASSERT n = 1, 'the answer given against the fixed text keeps counting';
  SELECT invalidated_count INTO n FROM pds.reading_quizzes WHERE op_key = qz4;
  ASSERT n = 1, 'the quiz that counted the old answer is marked corrected';
  r := pds.reading_question_apply(jsonb_build_object(
    'kind', 'correct', 'op_key', kc5, 'question_key', qk4, 'expected_version', 3, 'prompt', 'Fixture question four?',
    'source_kind', 'highlight', 'source_ref', v_h3, 'reason', 'Fixture: again.', 'invalidate', true));
  ASSERT r->>'code' = 'no_change', 'nothing left against another content: ' || r::text;

  -- Retention clears the feedback text; the same grade sent again still replays instead of conflicting.
  UPDATE pds.reading_question_attempts SET graded_at = NOW() - INTERVAL '40 days' WHERE attempt_key = a3;
  n := pds.reading_clear_question_answers(30);
  ASSERT n >= 1, 'the old answer was cleared';
  SELECT count(*) INTO n FROM pds.reading_question_attempts
   WHERE attempt_key = a3 AND answer IS NULL AND feedback IS NULL AND answer_cleared_at IS NOT NULL AND correct;
  ASSERT n = 1, 'text cleared, grade and hash kept';
  r := pds.reading_question_apply(jsonb_build_object('kind', 'grade', 'op_key', a3, 'correct', true, 'grader', 'model', 'feedback', 'Fixture feedback.'));
  ASSERT (r->>'ok')::boolean AND (r->>'replayed')::boolean, 'the original grade replays after clearing: ' || r::text;
  r := pds.reading_question_apply(jsonb_build_object('kind', 'grade', 'op_key', a3, 'correct', false, 'grader', 'model'));
  ASSERT r->>'code' = 'already_graded', 'another grade is still refused';

  RAISE NOTICE 'reading practice fixture: all checks passed';
END
$fx$;

ROLLBACK;

-- ============================================================
-- Manual concurrency check (two sessions on the same disposable database, both with the session setting above).
-- Session 1 holds the practice lock until it commits, so session 2 waits and then sees the new state:
--   S1: BEGIN;
--   S1: SELECT pds.reading_grade_review('{"op_key": "<uuid A>", "highlight_id": <h>, "grade": "good",
--         "review_date": "<d>", "client_review_count": 0, "basis": {"review_count": 0, "interval_days": 0, "ease": 2.5},
--         "schedule": {"ease": 2.5, "interval_days": 1, "next_review": "<d + 1>"}}');
--   S2: SELECT pds.reading_grade_review(<the same body with "op_key": "<uuid B>">);   -- blocks
--   S1: COMMIT;
--   S2: returns {"ok": false, "http": 409, "code": "changed", ...}: the second grade is refused, not stacked.
-- Remove the synthetic book and highlight afterwards (or use a throwaway database).
-- ============================================================
