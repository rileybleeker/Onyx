-- activity_split_label.sql
-- ---------------------------------------------------------------------------
-- Manual leg / pull / push split label for strength sessions.
--
-- WHY: Onyx auto-categorizes every workout it ingests EXCEPT the strength split.
--   - run   → derivable from sport label (Garmin 'running'/'treadmill_running',
--             WHOOP sport_name 'running')
--   - sauna → derivable from WHOOP sport_name = 'sauna'
--   - leg / pull / push → NOT derivable: WHOOP logs all resistance training under
--             one generic sport ('weightlifting_msk') with no muscle-group detail,
--             and Garmin records no strength activity at all. The split is the one
--             dimension only the user holds, so it is reported manually.
--
-- HOW: split_label is set from the /activities page via POST /api/activities/categorize,
--   exactly mirroring the is_excluded soft-delete pattern. It is deliberately NOT in
--   the Garmin/WHOOP ETL upsert payloads (whoop_etl.py / garmin_etl.py), so hourly
--   re-syncs that upsert ON CONFLICT only touch the columns they ship — split_label
--   (like is_excluded) is preserved across re-syncs.
--
-- DOWNSTREAM: hrv_analysis.py derives per-behavioral-day act_leg_day / act_pull_day /
--   act_push_day (plus auto act_run / act_sauna) from these rows; causal_inference.py
--   registers the five as EXPLICIT_BINARY_TREATMENTS (family='behavior').
--
-- Applied via Supabase MCP migration `add_split_label_to_workouts` (2026-06-02).
-- ---------------------------------------------------------------------------

ALTER TABLE pds.whoop_workouts
  ADD COLUMN IF NOT EXISTS split_label TEXT
  CHECK (split_label IS NULL OR split_label IN ('leg', 'pull', 'push'));

ALTER TABLE pds.garmin_activities
  ADD COLUMN IF NOT EXISTS split_label TEXT
  CHECK (split_label IS NULL OR split_label IN ('leg', 'pull', 'push'));

-- RLS: both tables already have anon-read / service_role-full policies; adding a
-- nullable column inherits them. No new policy needed.
