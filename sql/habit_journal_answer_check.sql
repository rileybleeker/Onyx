-- Tri-state habit answers (2026-06-11): the UI/API/chat now write explicit
-- 'No' rows alongside 'Yes'; "null / not logged" is represented by row
-- ABSENCE (the missing=No pipeline fill and the (cycle_date, question) PK
-- depend on that). Constrain answer so no write path can introduce a third
-- spelling ('TRUE', 'yes', '1', …) that would silently fall out of
-- pivot_journal/pivot_habits' is_yes mapping and every answer='Yes' filter.
-- Verified before adding: pds.habit_journal contained exactly
-- {'Yes': 4363, 'No': 8085} and zero NULLs.
-- Applied as Supabase migration `habit_journal_answer_check` on 2026-06-11.
ALTER TABLE pds.habit_journal
  ADD CONSTRAINT habit_journal_answer_check
  CHECK (answer IN ('Yes', 'No'));
