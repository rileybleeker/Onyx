-- ============================================================
-- Onyx - WHOOP daily steps: pds.whoop_cycles.step_count (2026-11-13)
-- ============================================================
-- WHOOP's developer API returns step_count on every cycle from GET /v2/cycle
-- (rolled out 2026-09-23). whoop_etl.py now requests cycles from /v2/cycle and
-- stores the value here.
--
--   step_count  NULL = WHOOP has no step data for the cycle (strap not worn,
--               or a cycle from before the rollout). Never 0 for "unknown".
--
-- A cycle runs from one sleep onset to the next, so the count covers the
-- waking day AFTER the sleep that starts the cycle. That day is dated from the
-- cycle's own local start (hrv_alignment.cycle_waking_day: the date of local
-- start + 6 h). For a night-time onset it is onyx_behavioral_date + 1 (same as
-- strain and kilojoule); an onset between 06:00 and 18:00 local counts its own
-- clock day. Cycles that land on the same day are summed. The open cycle holds
-- the steps so far and is overwritten by each hourly run until the cycle closes.
--
-- Additive only: one nullable column. pds.daily_health_matrix_behavioral lists
-- its columns explicitly and is NOT changed (the HRV pipeline merges the
-- column in pandas, hrv_analysis.merge_whoop_steps_features), so its matview
-- needs no rebuild. Existing table grants and the owner_read policy cover the
-- new column.
-- ============================================================

ALTER TABLE pds.whoop_cycles
    ADD COLUMN IF NOT EXISTS step_count INTEGER;

COMMENT ON COLUMN pds.whoop_cycles.step_count IS
    'Steps counted over the WHOOP cycle (sleep onset to next sleep onset), from GET /v2/cycle. NULL = no step data. Belongs to the waking day after the cycle''s opening sleep: the date of local start + 6 h (hrv_alignment.cycle_waking_day; onyx_behavioral_date + 1 for a night-time onset).';
