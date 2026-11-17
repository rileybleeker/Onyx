-- ============================================================
-- Onyx — Reading question bank: the checkpoint quiz's candidates (READ-QUIZ-01 S5, 2026-11-16)
-- ============================================================
-- A checkpoint quiz (10 questions, one per idea, from chapters 1..N) cannot be built from the daily deck: that deck
-- (pds.reading_bank_deck) holds only the ideas due, new or answered today, so an idea scheduled for next week is not in
-- it. These two read-only functions give lib/reading-checkpoint.ts what it needs, in two steps:
--   1. pds.reading_bank_checkpoint_pool(slug, chapter): every idea of chapters 1..N that may be asked (light rows:
--      the idea's id, chapter, importance, stage, last answered day, whether it has an explain variant) plus today's
--      answers (with the idea's chapter and the question's format), so a quiz opened again the same day finds the
--      cards it already has and the code can count every valid answer of the quiz, including one whose idea has left
--      the pool since (flagged "Not in this chapter").
--   2. pds.reading_bank_idea_cards(slug, ids): the full idea cards (questions with their rubrics, evidence) for the
--      few ideas the code picked, in the shape of pds.reading_bank_deck's ideas.
-- Both apply the same spoiler gate as every bank read: only ideas that unlock at or below
-- pds.reading_bank_quiz_through, of the current edition (chapter_hash), with valid evidence
-- (pds.reading_bank_idea_supported), never a locked row.
--
-- The 7-day rest counts every answer that is not voided, graded or still waiting for its grade, and every chapter
-- recall answer that covered the idea (the idea's own schedule moves only when a grade lands, so a pending answer is
-- not on it yet). Answers given today are listed for the code, which tells this quiz's own from the others.
--
-- Apply after sql/reading_question_bank.sql (it uses that file's functions). Additive only: two functions, no table,
-- no written row. service_role only, like every bank function.
-- ============================================================

-- 1. The pool ------------------------------------------------------------------------------------------------------
-- A detail idea is never a checkpoint question. An idea asked less than 7 days ago is left out (a pending answer and a
-- chapter recall answer count), except one asked today: it is listed so the code can keep it when this very quiz asked
-- it and leave it out when another round did (the code reads `answered_today`).
CREATE OR REPLACE FUNCTION pds.reading_bank_checkpoint_pool(p_slug TEXT, p_chapter INTEGER)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  WITH bk AS (SELECT pds.reading_bank_book_id(p_slug) AS book_id),
  today AS (SELECT pds.behavioral_today_now() AS d),
  t AS (SELECT pds.reading_bank_quiz_through((SELECT book_id FROM bk)) AS through),
  cur AS (   -- the current edition hash of every chapter up to the checkpoint that has active ideas
    SELECT x.chapter, pds.reading_bank_chapter_hash((SELECT book_id FROM bk), x.chapter) AS h
      FROM (SELECT DISTINCT i.chapter FROM pds.reading_ideas i
             WHERE i.book_id = (SELECT book_id FROM bk) AND i.status = 'active' AND i.chapter >= 1 AND i.chapter <= p_chapter) x
  ),
  done AS (   -- today's answers, as the daily deck lists them, plus the quiz key, the question's format and the idea's chapter
    SELECT a.attempt_key, a.question_id, a.idea_id, a.covers, a.round_key, a.round_kind, a.quiz_key, a.verdict, a.grading_status,
           q.format, di.chapter
      FROM pds.reading_question_attempts a
      JOIN pds.reading_questions q ON q.question_id = a.question_id
      LEFT JOIN pds.reading_ideas di ON di.idea_id = a.idea_id
     WHERE q.book_id = (SELECT book_id FROM bk) AND a.attempt_date = (SELECT d FROM today)
       AND a.ext_hash IS NOT NULL AND a.grading_status <> 'invalidated'
  ),
  recent AS (   -- ideas asked in the 6 days before today: the idea itself, or covered by a chapter recall answer
    SELECT x.idea_id, max(x.d) AS last_asked
      FROM (
        SELECT a.idea_id AS idea_id, a.attempt_date AS d
          FROM pds.reading_question_attempts a JOIN pds.reading_questions q ON q.question_id = a.question_id
         WHERE q.book_id = (SELECT book_id FROM bk) AND a.ext_hash IS NOT NULL AND a.grading_status <> 'invalidated'
           AND a.attempt_date < (SELECT d FROM today) AND a.attempt_date > (SELECT d FROM today) - 7
        UNION ALL
        SELECT cv.idea_id, a.attempt_date
          FROM pds.reading_question_attempts a JOIN pds.reading_questions q ON q.question_id = a.question_id
          CROSS JOIN LATERAL unnest(a.covers) AS cv(idea_id)
         WHERE q.book_id = (SELECT book_id FROM bk) AND a.ext_hash IS NOT NULL AND a.grading_status <> 'invalidated'
           AND a.attempt_date < (SELECT d FROM today) AND a.attempt_date > (SELECT d FROM today) - 7
      ) x
     WHERE x.idea_id IS NOT NULL
     GROUP BY x.idea_id
  ),
  live AS (
    SELECT i.idea_id, i.chapter, i.importance, COALESCE(s.stage, 0) AS stage, s.last_reviewed,
           EXISTS (SELECT 1 FROM pds.reading_questions q
                    WHERE q.idea_id = i.idea_id AND q.format = 'explain' AND q.superseded_at IS NULL AND q.retired_at IS NULL
                      AND q.unlock_chapter <= (SELECT through FROM t)) AS has_explain
      FROM pds.reading_ideas i
      JOIN cur ON cur.chapter = i.chapter AND cur.h = i.chapter_hash
      LEFT JOIN pds.reading_idea_state s ON s.idea_id = i.idea_id
     WHERE i.book_id = (SELECT book_id FROM bk) AND i.status = 'active' AND i.importance <> 'detail'
       AND i.chapter >= 1 AND i.chapter <= p_chapter
       AND i.unlock_chapter <= (SELECT through FROM t)
       AND pds.reading_bank_idea_supported(i.idea_id)
       AND ( ((s.last_reviewed IS NULL OR s.last_reviewed <= (SELECT d FROM today) - 7)
               AND NOT EXISTS (SELECT 1 FROM recent r WHERE r.idea_id = i.idea_id))
             OR i.idea_id IN (SELECT dn.idea_id FROM done dn WHERE dn.idea_id IS NOT NULL) )
       AND EXISTS (SELECT 1 FROM pds.reading_questions q
                    WHERE q.idea_id = i.idea_id AND q.format IN ('cued', 'explain', 'order')
                      AND q.superseded_at IS NULL AND q.retired_at IS NULL AND q.unlock_chapter <= (SELECT through FROM t))
  )
  SELECT CASE WHEN (SELECT book_id FROM bk) IS NULL THEN NULL ELSE jsonb_build_object(
    'book_id', (SELECT book_id FROM bk),
    'today', (SELECT d FROM today),
    'quiz_through', (SELECT through FROM t),
    'chapter', p_chapter,
    'enabled', COALESCE((SELECT bb.approved_at IS NOT NULL AND bb.paused_reason IS DISTINCT FROM 'owner'
                           FROM pds.reading_bank_books bb WHERE bb.book_id = (SELECT book_id FROM bk)), false),
    'ideas', COALESCE((SELECT jsonb_agg(jsonb_build_object('idea_id', l.idea_id, 'chapter', l.chapter, 'importance', l.importance,
                         'stage', l.stage, 'last_reviewed', l.last_reviewed, 'has_explain', l.has_explain) ORDER BY l.idea_id)
                         FROM live l), '[]'::jsonb),
    'answered_today', COALESCE((SELECT jsonb_agg(to_jsonb(dn) ORDER BY dn.attempt_key) FROM done dn), '[]'::jsonb)) END
$fn$;

-- 2. The cards of the picked ideas ---------------------------------------------------------------------------------
-- At most 25 ids are read. An id that is locked, stale, retired or unsupported is silently absent from the answer.
CREATE OR REPLACE FUNCTION pds.reading_bank_idea_cards(p_slug TEXT, p_ids BIGINT[])
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  WITH bk AS (SELECT pds.reading_bank_book_id(p_slug) AS book_id),
  t AS (SELECT pds.reading_bank_quiz_through((SELECT book_id FROM bk)) AS through),
  cur AS (
    SELECT x.chapter, pds.reading_bank_chapter_hash((SELECT book_id FROM bk), x.chapter) AS h
      FROM (SELECT DISTINCT i.chapter FROM pds.reading_ideas i
             WHERE i.book_id = (SELECT book_id FROM bk) AND i.idea_id = ANY(p_ids[1:25])) x
  ),
  live AS (
    SELECT i.idea_id, i.chapter, i.importance, i.kind, i.title, i.statement, i.key_points,
           COALESCE(s.stage, 0) AS stage, s.next_review, COALESCE(s.state_version, 0) AS state_version,
           COALESCE(s.dirty, false) AS dirty, COALESCE(s.last_question_ids, '{}') AS last_question_ids, s.last_verdict,
           COALESCE(s.ease, 2.50) AS ease, COALESCE(s.interval_days, 0) AS interval_days,
           COALESCE(s.review_count, 0) AS review_count, COALESCE(s.lapses, 0) AS lapses, s.stage_success_on, s.last_reviewed
      FROM pds.reading_ideas i
      JOIN cur ON cur.chapter = i.chapter AND cur.h = i.chapter_hash
      LEFT JOIN pds.reading_idea_state s ON s.idea_id = i.idea_id
     WHERE i.book_id = (SELECT book_id FROM bk) AND i.status = 'active' AND i.idea_id = ANY(p_ids[1:25])
       AND i.unlock_chapter <= (SELECT through FROM t)
       AND pds.reading_bank_idea_supported(i.idea_id)
  ),
  cards AS (
    SELECT l.*, ARRAY['checkpoint']::text[] AS why,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('question_id', q.question_id, 'version', q.version, 'format', q.format,
                 'prompt', q.prompt, 'rubric', q.rubric::jsonb) ORDER BY q.question_id), '[]'::jsonb)
         FROM pds.reading_questions q
        WHERE q.idea_id = l.idea_id AND q.superseded_at IS NULL AND q.retired_at IS NULL
          AND q.unlock_chapter <= (SELECT through FROM t)) AS questions,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', src.kind, 'url', src.url, 'domain', src.domain, 'title', src.title,
                 'cited_text', src.cited_text, 'highlight_id', src.highlight_id, 'passage', h.passage, 'location', h.location,
                 'page', h.page) ORDER BY src.source_id), '[]'::jsonb)
         FROM pds.reading_idea_evidence e
         JOIN pds.reading_bank_sources src ON src.source_id = e.source_id
         LEFT JOIN pds.book_highlights h ON h.highlight_id = src.highlight_id AND NOT h.archived
        WHERE e.idea_id = l.idea_id
          AND (src.kind = 'web' OR (h.highlight_id IS NOT NULL AND pds.reading_sha256(h.passage) = src.passage_sha))) AS sources
      FROM live l
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.idea_id), '[]'::jsonb) FROM cards c
$fn$;

-- 3. Access: service_role only, like every bank function ----------------------------------------------------------
REVOKE ALL ON FUNCTION pds.reading_bank_checkpoint_pool(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.reading_bank_checkpoint_pool(text, integer) TO service_role;
REVOKE ALL ON FUNCTION pds.reading_bank_idea_cards(text, bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.reading_bank_idea_cards(text, bigint[]) TO service_role;

COMMENT ON FUNCTION pds.reading_bank_checkpoint_pool(TEXT, INTEGER) IS
  'READ-QUIZ-01 S5: the ideas a checkpoint quiz up to chapter N may ask (spoiler gate applied), light rows plus today''s answers.';
COMMENT ON FUNCTION pds.reading_bank_idea_cards(TEXT, BIGINT[]) IS
  'READ-QUIZ-01 S5: full idea cards (questions, evidence) for up to 25 picked ideas, the same shape as the daily deck''s ideas.';
