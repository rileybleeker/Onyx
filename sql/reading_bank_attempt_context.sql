-- ============================================================
-- Onyx — Reading question bank: one read for an answer (READ-QUIZ-01 S3, 2026-11-16)
-- ============================================================
-- POST /api/reading/practice/attempt is one read plus one write: this function is the read, pds.reading_bank_attempt
-- is the write (docs/reading-question-bank.md, speed budget: the attempt call is under 400 ms). Before it, the route
-- made four requests in three steps (the question, the day, the idea's events, then the write).
--
-- It answers, from ONE statement (one snapshot): the question version, whether its book has the bank turned on, the
-- behavioral day, the ideas the answer would move (the idea, or the ideas a chapter recall rubric lists, extracted
-- the way pds.reading_bank_attempt extracts them), each idea's state_version (0 = no state row yet, as
-- pds.reading_bank_states_ok counts it) and the answer events of those ideas (pds.reading_bank_events, invalidated
-- answers excluded). The versions and the events come from the same snapshot, so a replay built on them can only
-- fail the write's compare-and-set after a later write, never pass it on stale input.
--
-- Read only. It does no spoiler gating of its own: a locked, retired, superseded or edited question is refused by
-- pds.reading_bank_attempt (which takes the lock and looks the attempt key up first, so a retry of a stored answer
-- still gets its receipt); the question text this returns goes to the same server code that already holds the
-- question id, and never reaches the browser (the route answers a receipt, not this).
--
-- events_total is the exact row count; the events themselves are returned only up to 20000 rows (the same bound
-- the paged reader keeps: 20 pages of 1000), and the caller refuses to replay when the two numbers differ.
-- attempt_stored tells a retry (an answer stored under p_attempt already) from a new answer on a book turned off.
--
-- Additive and idempotent: it only defines a function, so it can go through the Supabase MCP.
-- APPLY ORDER: after sql/reading_question_bank.sql (it calls pds.reading_bank_events). Run once; re-running is safe.
-- ============================================================

CREATE OR REPLACE FUNCTION pds.reading_bank_attempt_context(p_question BIGINT, p_attempt UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  WITH q AS (
    SELECT * FROM pds.reading_questions WHERE question_id = p_question
  ),
  ids AS (
    SELECT COALESCE(array_agg(DISTINCT x.id ORDER BY x.id), '{}'::bigint[]) AS ids
      FROM (
        SELECT q.idea_id AS id FROM q WHERE q.format IS DISTINCT FROM 'chapter_recall' AND q.idea_id IS NOT NULL
        UNION ALL
        SELECT (e->>'idea_id')::bigint
          FROM q
          CROSS JOIN LATERAL jsonb_array_elements(
                 -- nested CASEs: the rubric text is cast to JSON only for a chapter recall question
                 CASE WHEN q.format = 'chapter_recall'
                      THEN CASE WHEN jsonb_typeof(q.rubric::jsonb->'ideas') = 'array' THEN q.rubric::jsonb->'ideas' END
                 END) e
         WHERE e->>'idea_id' ~ '^[0-9]{1,15}$'
      ) x
  ),
  vers AS (
    SELECT COALESCE(jsonb_object_agg(i.id::text, COALESCE(s.state_version, 0)), '{}'::jsonb) AS v
      FROM unnest((SELECT ids FROM ids)) AS i(id)
      LEFT JOIN pds.reading_idea_state s ON s.idea_id = i.id
  ),
  ev AS (
    SELECT e.*
      FROM q
      CROSS JOIN LATERAL pds.reading_bank_events(q.book_id, (SELECT ids FROM ids)) e
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM q) THEN NULL ELSE jsonb_build_object(
    'today', pds.behavioral_today_now(),
    'question', (SELECT jsonb_build_object(
                   'question_id', q.question_id, 'version', q.version, 'book_id', q.book_id, 'format', q.format,
                   'prompt', q.prompt, 'rubric', q.rubric, 'idea_id', q.idea_id, 'bank_chapter', q.bank_chapter,
                   'unlock_chapter', q.unlock_chapter, 'superseded_at', q.superseded_at, 'retired_at', q.retired_at)
                   FROM q),
    -- Turned on: approved once and not turned off since (a budget pause stops generation, not practice); the same
    -- rule pds.reading_bank_deck reports as `enabled`.
    'enabled', COALESCE((SELECT bb.approved_at IS NOT NULL AND bb.paused_reason IS DISTINCT FROM 'owner'
                           FROM pds.reading_bank_books bb JOIN q ON bb.book_id = q.book_id), false),
    'idea_ids', to_jsonb((SELECT ids FROM ids)),
    'state_versions', (SELECT v FROM vers),
    'events_total', (SELECT count(*) FROM ev),
    'events', CASE WHEN (SELECT count(*) FROM ev) <= 20000
                   THEN COALESCE((SELECT jsonb_agg(to_jsonb(ev) ORDER BY ev.idea_id, ev.answered_at, ev.attempt_key) FROM ev), '[]'::jsonb)
                   ELSE '[]'::jsonb END,
    'attempt_stored', CASE WHEN p_attempt IS NULL THEN false
                           ELSE EXISTS (SELECT 1 FROM pds.reading_question_attempts a WHERE a.attempt_key = p_attempt) END
  ) END
$fn$;

REVOKE ALL ON FUNCTION pds.reading_bank_attempt_context(bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.reading_bank_attempt_context(bigint, uuid) TO service_role;

COMMENT ON FUNCTION pds.reading_bank_attempt_context(BIGINT, UUID) IS
  'READ-QUIZ-01: the one read of POST /api/reading/practice/attempt: question, book switch, behavioral day, idea state versions and answer events in one snapshot; read only.';
