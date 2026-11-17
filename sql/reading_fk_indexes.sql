-- ============================================================================
-- sql/reading_fk_indexes.sql
-- Adds indexes on two reading foreign-key columns that had none. The reading
-- overview (frontend/src/lib/reading.ts, OVERVIEW_SELECT) joins through them,
-- and Postgres does not index foreign-key columns on its own, so each join
-- had to scan the whole child table.
--
--   * pds.reading_reviews.highlight_id  (review -> highlight it reviews)
--   * pds.reading_quizzes.book_id       (quiz -> book it belongs to)
--
-- pds.book_chapters.book_id is not listed: it is already the first column of
-- the table's primary key (book_id, chapter), so lookups by book_id use that.
--
-- Additive only: CREATE INDEX IF NOT EXISTS, no table or data changes. Plain
-- CREATE INDEX (not CONCURRENTLY) so the file can run inside a transaction.
-- The tables are small personal tables, so the brief write lock is harmless.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_reading_reviews_highlight ON pds.reading_reviews (highlight_id);

CREATE INDEX IF NOT EXISTS idx_reading_quizzes_book ON pds.reading_quizzes (book_id);
