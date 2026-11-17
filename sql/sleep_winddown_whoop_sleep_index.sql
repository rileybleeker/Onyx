-- ============================================================================
-- Wind-down feedback read: index for pds.whoop_sleep (PROD-SLEEP-01).
-- ============================================================================
-- ADDITIVE: this file only creates one index, and only if it is missing. It removes nothing and changes no rows.
-- It must be applied by the release owner through the protected SQL process (sql/ migrations applied via the
-- Supabase MCP or dashboard by the release owner), not by a builder or an agent.
--
-- Why: GET /api/sleep/winddown (readSleepNights in frontend/src/lib/sleep-winddown-server.ts) reads the last 14 nights
-- with: onyx_behavioral_date >= from AND < today, is_nap = false, score_state = 'SCORED', ordered by
-- (onyx_behavioral_date, start_time). The existing index idx_whoop_sleep_behavioral_date covers only the date, so the
-- planner still has to sort the matching rows by start_time and filter the two flags row by row. This partial index
-- matches the two literal filters and returns rows already in the read's order.

CREATE INDEX IF NOT EXISTS idx_whoop_sleep_winddown_feedback
    ON pds.whoop_sleep (onyx_behavioral_date, start_time)
    WHERE score_state = 'SCORED' AND is_nap = false;
