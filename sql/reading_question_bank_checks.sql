-- ============================================================
-- Onyx — Reading question bank: widen two PROD-T07 checks (READ-QUIZ-01, 2026-11-16)
-- ============================================================
-- Bank questions are stored as PROD-T07 question versions with source_kind 'idea', and code-graded answers carry
-- grader 'local'. sql/reading_learning_questions.sql allows neither, so these two column checks are widened.
--
-- Run in the Supabase dashboard SQL editor (it replaces two constraints, which the MCP refuses), BEFORE
-- sql/reading_question_bank.sql's functions are used. Skip it when pds.reading_bank_schema_ok() already reports
-- source_kind_idea and grader_local as true (the reading lane may have folded both values into T07's file).
-- Idempotent; one transaction. It only widens: every value T07 allows stays allowed.
--
-- T07's own function (pds.reading_question_apply) and its client parser (SOURCE_KINDS in lib/reading-questions.ts)
-- keep refusing 'idea', so a browser cannot answer a bank question through /api/reading/questions and bypass the
-- bank's own rules (pds.reading_bank_attempt).
-- ============================================================
BEGIN;
ALTER TABLE pds.reading_questions DROP CONSTRAINT IF EXISTS reading_questions_source_kind_check;
ALTER TABLE pds.reading_questions ADD CONSTRAINT reading_questions_source_kind_check
  CHECK (source_kind IN ('highlight', 'session', 'chapter', 'idea'));
ALTER TABLE pds.reading_question_attempts DROP CONSTRAINT IF EXISTS reading_question_attempts_grader_check;
ALTER TABLE pds.reading_question_attempts ADD CONSTRAINT reading_question_attempts_grader_check
  CHECK (grader IS NULL OR grader IN ('model', 'self', 'local'));
COMMIT;
