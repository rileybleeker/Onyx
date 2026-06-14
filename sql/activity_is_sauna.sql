-- activity_is_sauna.sql
-- ---------------------------------------------------------------------------
-- Manual "I was in a sauna" override flag for activities.
--
-- WHY: Onyx auto-derives the `sauna` category from the device sport label
--   (WHOOP sport_name = 'sauna'; Garmin activity_type ~ 'sauna'), and the HRV
--   pipeline's act_sauna / days_since_sauna read that auto signal. But not every
--   sauna session lands as a sport_name='sauna' workout — WHOOP sometimes records
--   a sauna under a generic sport, or bundled with another activity. is_sauna is
--   the manual override: it lets the user hand-mark a non-weightlifting WHOOP
--   activity as a sauna so it still counts. It REPLACES the old WHOOP-journal
--   "Used a sauna?" habit (deactivated 2026-06-14) — going forward, sauna is
--   sourced from the activity (auto sport_name OR this manual flag), not a habit.
--
-- HOW: is_sauna is set from the /activities page via POST /api/activities/categorize
--   (the same endpoint as the strength split/muscle tags), exactly mirroring the
--   is_excluded soft-delete pattern. It is deliberately NOT in the Garmin/WHOOP
--   ETL upsert payloads (whoop_etl.py / garmin_etl.py), so hourly re-syncs that
--   upsert ON CONFLICT only touch the columns they ship — is_sauna (like
--   is_excluded) is preserved across re-syncs.
--
-- DOWNSTREAM: hrv_analysis.py:aggregate_activity_categories() OR-s is_sauna into
--   act_sauna (WHOOP sport_name='sauna' OR is_sauna); days_since_sauna and the
--   causal act_sauna treatment (family='behavior') inherit it for free.
--
-- The UI surfaces the toggle only on non-'weightlifting_msk' WHOOP rows (lifting
--   rows show the split/muscle pills instead). The column lives on both tables for
--   symmetry with split_label/split_labels/muscle_groups and uniform API handling.
--
-- BOOLEAN NOT NULL DEFAULT FALSE mirrors is_excluded (a soft flag is never
--   "unknown"), not the nullable array tag columns.
--
-- Applied via Supabase MCP migration `add_is_sauna_to_workouts` (2026-06-14).
-- ---------------------------------------------------------------------------

ALTER TABLE pds.whoop_workouts
  ADD COLUMN IF NOT EXISTS is_sauna BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pds.garmin_activities
  ADD COLUMN IF NOT EXISTS is_sauna BOOLEAN NOT NULL DEFAULT FALSE;

-- RLS: both tables already have anon-read / service_role-full policies; the new
-- column inherits them. No new policy needed.
