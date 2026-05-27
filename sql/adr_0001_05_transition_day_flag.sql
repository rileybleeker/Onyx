-- =============================================================================
-- ADR-0001 Phase 1, step 5 — onyx_is_transition_day flag on whoop_cycles
-- =============================================================================
-- Per docs/adr/0001-timezone-and-behavioral-day-handling.md Open Question #9
-- and the drastic-TZ-abroad gap #1.
--
-- Surfaces the "WHOOP picked one offset for a cycle that physically spanned
-- two TZs" imprecision as a queryable flag. True when the cycle's offset
-- differs from the previous cycle's offset (Riley flew between them).
--
-- Downstream consumers (HRV lag features, _days_since cascades) opt to
-- filter, weight-down, or interpolate transition rows.
--
-- Depends on: sql/adr_0001_02_whoop_onyx_dates.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Column
-- ---------------------------------------------------------------------------
ALTER TABLE pds.whoop_cycles
    ADD COLUMN IF NOT EXISTS onyx_is_transition_day BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_whoop_cycles_transition_day
    ON pds.whoop_cycles (onyx_is_transition_day)
    WHERE onyx_is_transition_day = TRUE;

-- ---------------------------------------------------------------------------
-- 2. Trigger — set flag on insert/update by comparing to prior cycle
-- ---------------------------------------------------------------------------
-- Compares NEW.timezone_offset to the offset of the most recent prior cycle
-- (strict <). If they differ, NEW is a transition. Also reflexively updates
-- the NEXT cycle if it already exists (rare: backfill order).
CREATE OR REPLACE FUNCTION pds.set_whoop_cycles_transition_flag()
RETURNS TRIGGER AS $$
DECLARE
    prev_offset TEXT;
    next_cycle  RECORD;
BEGIN
    SELECT timezone_offset INTO prev_offset
    FROM pds.whoop_cycles
    WHERE start_time < NEW.start_time
    ORDER BY start_time DESC
    LIMIT 1;

    NEW.onyx_is_transition_day :=
        prev_offset IS NOT NULL
        AND NEW.timezone_offset IS NOT NULL
        AND prev_offset <> NEW.timezone_offset;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS whoop_cycles_set_transition_flag ON pds.whoop_cycles;
CREATE TRIGGER whoop_cycles_set_transition_flag
    BEFORE INSERT OR UPDATE OF start_time, timezone_offset ON pds.whoop_cycles
    FOR EACH ROW EXECUTE FUNCTION pds.set_whoop_cycles_transition_flag();

-- ---------------------------------------------------------------------------
-- 3. Backfill — window-function pass (one SQL, no per-row trigger cascade)
-- ---------------------------------------------------------------------------
-- An earlier iteration of this migration had an AFTER trigger that
-- propagated the flag to the NEXT cycle when a new row arrived; combined
-- with the backfill UPDATE it caused O(N^2) cascade timeouts. Removed in
-- favor of a single SQL pass using LAG(). Forward inserts via WHOOP ETL
-- arrive in chronological order, so the BEFORE INSERT trigger gets the
-- correct prev_offset in one query.

WITH flagged AS (
    SELECT
        cycle_id,
        timezone_offset,
        LAG(timezone_offset) OVER (ORDER BY start_time) AS prev_offset
    FROM pds.whoop_cycles
)
UPDATE pds.whoop_cycles wc
   SET onyx_is_transition_day =
       (f.prev_offset IS NOT NULL
        AND f.timezone_offset IS NOT NULL
        AND f.prev_offset <> f.timezone_offset)
  FROM flagged f
 WHERE wc.cycle_id = f.cycle_id;

-- ---------------------------------------------------------------------------
-- 4. Forward-insert propagation (audit re-2026-05-26)
-- ---------------------------------------------------------------------------
-- When a cycle arrives/updates out of order, the immediately-NEXT cycle's
-- flag (computed against ITS prev cycle, which was someone-else before this
-- insert) may now be stale. This AFTER trigger refreshes it.
--
-- Cascade safety: pg_trigger_depth() > 1 short-circuits, so the chain
-- terminates after one hop. The IS DISTINCT FROM filter avoids a no-op
-- UPDATE that would still fire the BEFORE trigger.
CREATE OR REPLACE FUNCTION pds.refresh_next_transition_day()
RETURNS TRIGGER AS $$
DECLARE
    next_id      BIGINT;
    next_off     TEXT;
    correct_flag BOOLEAN;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    SELECT cycle_id, timezone_offset
      INTO next_id, next_off
      FROM pds.whoop_cycles
     WHERE start_time > NEW.start_time
     ORDER BY start_time ASC
     LIMIT 1;

    IF next_id IS NOT NULL THEN
        correct_flag := (NEW.timezone_offset IS NOT NULL
                         AND next_off IS NOT NULL
                         AND NEW.timezone_offset <> next_off);
        UPDATE pds.whoop_cycles
           SET onyx_is_transition_day = correct_flag
         WHERE cycle_id = next_id
           AND onyx_is_transition_day IS DISTINCT FROM correct_flag;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS whoop_cycles_refresh_next_transition_day ON pds.whoop_cycles;
CREATE TRIGGER whoop_cycles_refresh_next_transition_day
    AFTER INSERT OR UPDATE OF timezone_offset, start_time
    ON pds.whoop_cycles
    FOR EACH ROW EXECUTE FUNCTION pds.refresh_next_transition_day();

-- ---------------------------------------------------------------------------
-- 5. Sanity check (optional manual probe)
-- ---------------------------------------------------------------------------
-- Expected: ~8 transitions across history (4 trips × 2 direction-changes).
-- SELECT cycle_id, start_time, timezone_offset, onyx_is_transition_day
--   FROM pds.whoop_cycles
--  WHERE onyx_is_transition_day = TRUE
--  ORDER BY start_time;
