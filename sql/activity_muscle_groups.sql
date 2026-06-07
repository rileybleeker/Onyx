-- activity_muscle_groups.sql
-- ---------------------------------------------------------------------------
-- Multi-select strength tagging: split_labels[] + muscle_groups[].
--
-- WHY: The original strength taxonomy (activity_split_label.sql) stored a SINGLE
--   leg/pull/push value per session in `split_label`. A real session is often two
--   things at once — an upper day is push + pull, a full day touches everything —
--   and "muscle group" is finer than the three coarse splits. This migration adds
--   two MULTI-VALUE dimensions so one session can carry any combination:
--     - split_labels  TEXT[]  — coarse split, elements ⊆ {leg, pull, push}
--     - muscle_groups TEXT[]  — granular muscles, elements ⊆ the 11-tag set below
--   Both nullable; NULL/absent = untagged (the API stores NULL, not '{}', for empty).
--
--   The legacy scalar `split_label` is KEPT (not dropped) as a passive mirror of the
--   PRIMARY split (= split_labels[0]) so any un-migrated reader and a code rollback
--   stay safe. `split_labels` is the canonical source of truth going forward; the
--   API (/api/activities/categorize) writes both on every save.
--
-- HOW: set from the /activities page via POST /api/activities/categorize, which now
--   accepts { source, id, split_labels[], muscle_groups[] }. ETL-preserving exactly
--   like split_label / is_excluded — neither array is in the Garmin/WHOOP upsert
--   payloads, so hourly re-syncs (ON CONFLICT DO UPDATE on payload columns) never
--   clobber them.
--
-- CHECK constraints use array-containment (`<@`): every element must be in the
--   allowed set; an empty/absent value is NULL. No per-element trigger needed.
--
-- DOWNSTREAM: hrv_analysis.py:aggregate_activity_categories() now reads split_labels
--   (array membership, so push+pull sets BOTH act_push_day and act_pull_day) and
--   derives 11 per-behavioral-day act_mg_<muscle> flags from muscle_groups.
--   causal_inference.py registers the act_mg_* set as EXPLICIT_BINARY_TREATMENTS
--   (family='behavior'); the act_ prefix already grants SHAP-actionable + SARIMAX/
--   Prophet exog-seed coverage.
--
-- Applied via Supabase MCP migration `add_split_labels_and_muscle_groups` (2026-06-07).
-- ---------------------------------------------------------------------------

-- Coarse split (multi-select) -------------------------------------------------
ALTER TABLE pds.whoop_workouts
  ADD COLUMN IF NOT EXISTS split_labels TEXT[]
  CHECK (split_labels IS NULL OR split_labels <@ ARRAY['leg','pull','push']::text[]);

ALTER TABLE pds.garmin_activities
  ADD COLUMN IF NOT EXISTS split_labels TEXT[]
  CHECK (split_labels IS NULL OR split_labels <@ ARRAY['leg','pull','push']::text[]);

-- Granular muscle groups (multi-select) --------------------------------------
-- Canonical 11-tag set, grouped by the split they usually belong to:
--   push : chest, shoulders, triceps
--   pull : back, biceps, forearms
--   legs : quads, hamstrings, glutes, calves
--   core : core
ALTER TABLE pds.whoop_workouts
  ADD COLUMN IF NOT EXISTS muscle_groups TEXT[]
  CHECK (muscle_groups IS NULL OR muscle_groups <@ ARRAY[
    'chest','back','shoulders','biceps','triceps','forearms',
    'quads','hamstrings','glutes','calves','core']::text[]);

ALTER TABLE pds.garmin_activities
  ADD COLUMN IF NOT EXISTS muscle_groups TEXT[]
  CHECK (muscle_groups IS NULL OR muscle_groups <@ ARRAY[
    'chest','back','shoulders','biceps','triceps','forearms',
    'quads','hamstrings','glutes','calves','core']::text[]);

-- Backfill split_labels from the legacy single split_label (idempotent) -------
UPDATE pds.whoop_workouts   SET split_labels = ARRAY[split_label]
  WHERE split_label IS NOT NULL AND split_labels IS NULL;
UPDATE pds.garmin_activities SET split_labels = ARRAY[split_label]
  WHERE split_label IS NOT NULL AND split_labels IS NULL;

-- RLS: both tables already have anon-read / service_role-full policies; adding
-- nullable columns inherits them. No new policy needed.
