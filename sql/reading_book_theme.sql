-- ============================================================
-- Onyx — Reading: a book's own flavour as data (READ-QUIZ-01 S7, 2026-11-16)
-- ============================================================
-- The level titles, the concept tags offered on a highlight and the labels of a few badges used to be a book's own
-- words kept in code. This repository is public and names no book, so they live on the book's row instead:
-- pds.books.theme (JSONB, NULL = the generic defaults in frontend/src/lib/reading.ts). Nothing in the app writes it;
-- it is set by hand, one statement per book (the example below uses an invented book).
--
-- Shape (every key optional; a missing or malformed part falls back to its own generic default):
--   {
--     "v": 1,
--     "level_titles": ["Newcomer", "Keeper", "Chief Keeper"],   -- level 1 first; at most 12 titles of 40 characters;
--                                                               -- the last one serves every level beyond the list
--     "concepts": ["Tide tables", "Ledger discipline"],         -- tags the highlight form offers; at most 40 of 80 characters
--     "badges": {"checkpoint-1": "Lamp lit", "checkpoint-2": "Past the shoals", "first-session": "First watch"}
--   }                                                           -- badge keys: first-session, checkpoint-1, checkpoint-2,
--                                                               -- finisher, streak-7, scribe, reviewer, quiz-master,
--                                                               -- on-pace, runner; a label is plain text of 40 characters
--
--   UPDATE pds.books SET theme = '{"v": 1, "level_titles": ["Newcomer", "Keeper"], "concepts": ["Tide tables"]}'::jsonb
--    WHERE slug = 'the-lighthouse-ledger';
--
-- Also here: pds.reading_bank_linked_idea_titles(slug), the second source of concept tags on the highlight form: the
-- titles of the question-bank ideas the book's highlights are linked to. It is read on demand by
-- GET /api/reading/idea-titles, never inside the overview.
--
-- Additive only, so it can go through the Supabase MCP: one nullable column with a shape check, one read-only function.
-- Apply after sql/reading_schema.sql. The function reads the question bank's tables, so for it to return anything
-- sql/reading_question_bank.sql must be applied too; it is written so that this file applies in either order (its
-- body is not checked against the bank's tables when it is created) and, until the bank exists, it answers an error
-- that the app treats as "no titles".
-- ============================================================

-- 1. The theme column ----------------------------------------------------------------------------------------------
-- An object, and small (the app reads at most 12 level titles, 40 concepts and 10 badge labels).
ALTER TABLE pds.books
    ADD COLUMN IF NOT EXISTS theme JSONB
    CONSTRAINT books_theme_shape CHECK (theme IS NULL OR (jsonb_typeof(theme) = 'object' AND length(theme::text) <= 6000));

COMMENT ON COLUMN pds.books.theme IS
  'READ-QUIZ-01 S7: the book''s own level titles, highlight concept tags and badge labels (see sql/reading_book_theme.sql); NULL = generic defaults.';

-- 2. Linked idea titles (read-only) ----------------------------------------------------------------------------------
-- Titles of the book's active ideas that (a) unlock at or below the spoiler gate pds.reading_bank_quiz_through, (b) are of
-- the current edition (chapter_hash), (c) still rest on valid evidence (pds.reading_bank_idea_supported) and (d) are
-- supported by at least one of Riley's highlights whose passage is unchanged since the link was stored. Detail ideas
-- are left out. Chapter order, core ideas first, at most 40. [] while the book's questions are not turned on, so a
-- book with the bank off behaves as it did before. A locked chapter's idea never appears here.
CREATE OR REPLACE FUNCTION pds.reading_bank_linked_idea_titles(p_slug TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_book    BIGINT := pds.reading_bank_book_id(p_slug);
  v_through INTEGER;
  v_titles  JSONB;
BEGIN
  IF v_book IS NULL OR NOT EXISTS (
       SELECT 1 FROM pds.reading_bank_books b
        WHERE b.book_id = v_book AND b.approved_at IS NOT NULL AND b.paused_reason IS DISTINCT FROM 'owner') THEN
    RETURN '[]'::jsonb;
  END IF;
  v_through := pds.reading_bank_quiz_through(v_book);
  WITH cur AS (
    SELECT x.chapter, pds.reading_bank_chapter_hash(v_book, x.chapter) AS h
      FROM (SELECT DISTINCT i.chapter FROM pds.reading_ideas i WHERE i.book_id = v_book AND i.status = 'active') x
  ),
  linked AS (
    SELECT i.idea_id, i.chapter, i.title,
           CASE i.importance WHEN 'core' THEN 0 ELSE 1 END AS tier
      FROM pds.reading_ideas i
      JOIN cur ON cur.chapter = i.chapter AND cur.h = i.chapter_hash
     WHERE i.book_id = v_book AND i.status = 'active' AND i.importance <> 'detail'
       AND i.unlock_chapter <= v_through
       AND pds.reading_bank_idea_supported(i.idea_id)
       AND EXISTS (SELECT 1 FROM pds.reading_idea_evidence e
                     JOIN pds.reading_bank_sources src ON src.source_id = e.source_id AND src.kind = 'highlight'
                     JOIN pds.book_highlights h ON h.highlight_id = src.highlight_id
                    WHERE e.idea_id = i.idea_id AND NOT h.archived AND pds.reading_sha256(h.passage) = src.passage_sha)
     ORDER BY i.chapter, tier, i.idea_id
     LIMIT 40
  )
  SELECT COALESCE(jsonb_agg(l.title ORDER BY l.chapter, l.tier, l.idea_id), '[]'::jsonb) INTO v_titles FROM linked l;
  RETURN v_titles;
END $fn$;

-- 3. Access: service_role only, like every question-bank function ------------------------------------------------------
REVOKE ALL ON FUNCTION pds.reading_bank_linked_idea_titles(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.reading_bank_linked_idea_titles(text) TO service_role;

COMMENT ON FUNCTION pds.reading_bank_linked_idea_titles(TEXT) IS
  'READ-QUIZ-01 S7: titles of the book''s question-bank ideas that its highlights are linked to (spoiler gate applied); [] while the bank is off.';
