-- ============================================================
-- Onyx — Reading review grades + quiz results, atomic with receipts (PROD-T02, 2026-11-16)
-- ============================================================
-- Before: a review grade was an insert into pds.reading_reviews followed by a separate update of the highlight's
-- schedule, so a failed update left the grade stored with the old schedule, and a retry stored a second grade. A
-- quiz result was a plain insert, so a retried request counted its points twice.
--
-- Now every grade and every quiz result is ONE call of a function below, run in a single transaction under one
-- advisory lock shared by both (pds.reading_practice):
--   * pds.reading_grade_review(p)  locks the highlight row, checks it is still in the state the schedule was
--     computed from, inserts the review, writes the new schedule and records the operation receipt. Any error
--     rolls all of it back.
--   * pds.reading_record_quiz(p)   inserts the quiz row and records the receipt.
-- Each call carries an operation key (UUID). pds.reading_practice_ops keeps one receipt per key with a sha-256 of
-- the normalized request: the same key and request answers the stored receipt again (replayed), the same key with
-- another request is refused (key_reused), so a retry after a lost answer never writes twice. Refusals are not
-- recorded (the key is not spent).
--
-- The schedule itself is computed by lib/reading-practice.ts scheduleAfterGrade (the same helper the review card
-- uses for its previews) from the row it read; the function refuses (code raced, the server re-reads and tries
-- again) when the locked row is no longer that state, and refuses (code changed, 409) when the screen's card was
-- an older state than the row (another screen graded it first).
--
-- Additive only: two nullable columns, two partial unique indexes, one table, two functions. Existing reviews and
-- quizzes stay as they are (no key; they keep counting as before). Nothing is deduplicated after the fact.
-- Grants: both functions are SECURITY INVOKER and executable by service_role only; the receipt table is
-- service_role only (row level security on, no policies). Grants on the existing tables are unchanged.
--
-- Until applied, POST /api/reading/review and /api/reading/quiz answer 503 practice_unavailable (no direct-write
-- fallback) and the review card keeps the card with Retry.
-- ============================================================

ALTER TABLE pds.reading_reviews ADD COLUMN IF NOT EXISTS op_key UUID;
ALTER TABLE pds.reading_quizzes ADD COLUMN IF NOT EXISTS op_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_reading_reviews_op_key ON pds.reading_reviews (op_key) WHERE op_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_reading_quizzes_op_key ON pds.reading_quizzes (op_key) WHERE op_key IS NOT NULL;

COMMENT ON COLUMN pds.reading_reviews.op_key IS
  'Operation key of the grade request that stored this review (pds.reading_practice_ops); NULL for reviews stored before 2026-11-16.';
COMMENT ON COLUMN pds.reading_quizzes.op_key IS
  'Operation key of the request that stored this quiz result (pds.reading_practice_ops); NULL for results stored before 2026-11-16.';

CREATE TABLE IF NOT EXISTS pds.reading_practice_ops (
    op_key       UUID        PRIMARY KEY,
    kind         TEXT        NOT NULL CHECK (kind IN ('review', 'quiz')),
    payload_hash TEXT        NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'), -- sha-256 of the normalized request
    result       JSONB       NOT NULL,                                         -- the answer given when it was applied (ids, numbers, dates; no text)
    applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE pds.reading_practice_ops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.reading_practice_ops FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON pds.reading_practice_ops TO service_role;

COMMENT ON TABLE pds.reading_practice_ops IS
  'One receipt per review grade / quiz result operation key: a retry with the same key and request answers it again (service_role only).';

-- -----------------------------------------------------------
-- Review grade.
-- p: {op_key, highlight_id, grade, review_date, basis: {review_count, interval_days, ease},
--     schedule: {ease, interval_days, next_review}, client_review_count?}
-- Answers {ok: true, review_id, highlight_id, grade, review_date, first_review_today, ease, interval_days,
--          next_review, review_count, replayed[, highlight]} or {ok: false, http, code[, review_count]}.
-- The request identity (hashed) is the highlight and the grade only: review_date and the schedule are server-made,
-- so a retry after midnight still answers the receipt of the first try.
-- -----------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.reading_grade_review(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $fn$
DECLARE
  v_key       UUID;
  v_hid       BIGINT;
  v_grade     TEXT := p->>'grade';
  v_date      DATE;
  v_interval  INTEGER;
  v_ease      NUMERIC;
  v_next      DATE;
  v_hash      TEXT;
  v_prior     pds.reading_practice_ops%ROWTYPE;
  v_h         pds.book_highlights%ROWTYPE;
  v_first     BOOLEAN;
  v_review_id BIGINT;
  v_result    JSONB;
BEGIN
  BEGIN
    v_key := (p->>'op_key')::uuid;
    v_hid := (p->>'highlight_id')::bigint;
    v_date := (p->>'review_date')::date;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END;
  IF v_key IS NULL OR v_hid IS NULL OR v_date IS NULL OR v_grade IS NULL OR v_grade NOT IN ('again', 'good', 'easy') THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  v_hash := encode(sha256(convert_to(jsonb_build_object('highlight_id', v_hid, 'grade', v_grade)::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));

  SELECT * INTO v_prior FROM pds.reading_practice_ops WHERE op_key = v_key;
  IF FOUND THEN
    IF v_prior.kind <> 'review' OR v_prior.payload_hash <> v_hash THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'key_reused');
    END IF;
    RETURN v_prior.result || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_h FROM pds.book_highlights WHERE highlight_id = v_hid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;
  IF v_h.archived THEN RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'archived'); END IF;

  -- The card on screen was an older state of this highlight: another screen graded it in between.
  IF NULLIF(p->>'client_review_count', '') IS NOT NULL AND v_h.review_count <> (p->>'client_review_count')::int THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'changed', 'review_count', v_h.review_count);
  END IF;
  -- The schedule was computed from another state than the locked row (a write landed between the read and now).
  IF v_h.review_count IS DISTINCT FROM (p->'basis'->>'review_count')::int
     OR v_h.interval_days IS DISTINCT FROM (p->'basis'->>'interval_days')::int
     OR v_h.ease IS DISTINCT FROM (p->'basis'->>'ease')::numeric THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'raced');
  END IF;

  v_interval := (p->'schedule'->>'interval_days')::int;
  v_ease := (p->'schedule'->>'ease')::numeric;
  v_next := (p->'schedule'->>'next_review')::date;
  IF v_interval IS NULL OR v_interval < 1 OR v_interval > 365 OR v_ease IS NULL OR v_ease < 1.3 OR v_ease > 3.0
     OR v_next IS DISTINCT FROM v_date + v_interval THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_schedule');
  END IF;

  v_first := NOT EXISTS (SELECT 1 FROM pds.reading_reviews WHERE review_date = v_date);
  INSERT INTO pds.reading_reviews (highlight_id, review_date, grade, op_key)
  VALUES (v_hid, v_date, v_grade, v_key)
  RETURNING review_id INTO v_review_id;
  UPDATE pds.book_highlights
     SET ease = v_ease, interval_days = v_interval, next_review = v_next, last_reviewed = v_date,
         review_count = v_h.review_count + 1
   WHERE highlight_id = v_hid
  RETURNING * INTO v_h;

  v_result := jsonb_build_object(
    'ok', true, 'review_id', v_review_id, 'highlight_id', v_hid, 'grade', v_grade, 'review_date', v_date,
    'first_review_today', v_first, 'ease', v_h.ease, 'interval_days', v_h.interval_days,
    'next_review', v_h.next_review, 'review_count', v_h.review_count);
  INSERT INTO pds.reading_practice_ops (op_key, kind, payload_hash, result) VALUES (v_key, 'review', v_hash, v_result);
  RETURN v_result || jsonb_build_object('replayed', false, 'highlight', to_jsonb(v_h));
END
$fn$;

-- -----------------------------------------------------------
-- Quiz result.
-- p: {op_key, book_id, checkpoint, score, total, notes?, quiz_date?}
-- Answers {ok: true, quiz_id, book_id, checkpoint, score, total, quiz_date, passed, replayed}
--      or {ok: false, http, code}. quiz_date absent = behavioral today (pds.behavioral_today_now()).
-- -----------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.reading_record_quiz(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $fn$
DECLARE
  v_key    UUID;
  v_book   BIGINT;
  v_cp     TEXT := btrim(COALESCE(p->>'checkpoint', ''));
  v_score  INTEGER;
  v_total  INTEGER;
  v_notes  TEXT := NULLIF(btrim(COALESCE(p->>'notes', '')), '');
  v_date   DATE;
  v_hash   TEXT;
  v_prior  pds.reading_practice_ops%ROWTYPE;
  v_q      pds.reading_quizzes%ROWTYPE;
  v_result JSONB;
BEGIN
  BEGIN
    v_key := (p->>'op_key')::uuid;
    v_book := (p->>'book_id')::bigint;
    v_score := (p->>'score')::int;
    v_total := (p->>'total')::int;
    v_date := NULLIF(p->>'quiz_date', '')::date;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END;
  IF v_key IS NULL OR v_book IS NULL OR v_cp = '' OR length(v_cp) > 40
     OR v_total IS NULL OR v_total <= 0 OR v_score IS NULL OR v_score < 0 OR v_score > v_total THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  v_hash := encode(sha256(convert_to(jsonb_build_object(
    'book_id', v_book, 'checkpoint', v_cp, 'score', v_score, 'total', v_total, 'notes', v_notes, 'quiz_date', v_date)::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));

  SELECT * INTO v_prior FROM pds.reading_practice_ops WHERE op_key = v_key;
  IF FOUND THEN
    IF v_prior.kind <> 'quiz' OR v_prior.payload_hash <> v_hash THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'key_reused');
    END IF;
    RETURN v_prior.result || jsonb_build_object('replayed', true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pds.books WHERE book_id = v_book) THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found');
  END IF;

  INSERT INTO pds.reading_quizzes (book_id, checkpoint, score, total, notes, quiz_date, op_key)
  VALUES (v_book, v_cp, v_score, v_total, v_notes, COALESCE(v_date, pds.behavioral_today_now()), v_key)
  RETURNING * INTO v_q;

  v_result := jsonb_build_object(
    'ok', true, 'quiz_id', v_q.quiz_id, 'book_id', v_q.book_id, 'checkpoint', v_q.checkpoint,
    'score', v_q.score, 'total', v_q.total, 'quiz_date', v_q.quiz_date,
    'passed', (v_q.score::numeric / v_q.total) >= 0.8);
  INSERT INTO pds.reading_practice_ops (op_key, kind, payload_hash, result) VALUES (v_key, 'quiz', v_hash, v_result);
  RETURN v_result || jsonb_build_object('replayed', false);
END
$fn$;

REVOKE ALL ON FUNCTION pds.reading_grade_review(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.reading_record_quiz(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.reading_grade_review(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION pds.reading_record_quiz(JSONB) TO service_role;

COMMENT ON FUNCTION pds.reading_grade_review(JSONB) IS
  'Reading review grade: review row + highlight schedule + receipt in one transaction under the practice lock (service_role only).';
COMMENT ON FUNCTION pds.reading_record_quiz(JSONB) IS
  'Reading checkpoint quiz result: quiz row + receipt in one transaction under the practice lock (service_role only).';
