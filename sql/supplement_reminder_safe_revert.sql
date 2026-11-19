-- ============================================================================
-- Supplement reminder: safe revert after a refused intake insert (additive)
-- ============================================================================
-- Two taps on one reminder can race: tap A wins the 'logged' claim, its intake
-- insert is definitely refused (e.g. 23514), while tap B's insert succeeds.
-- A used to put the reminder back to 'prompted' unconditionally, leaving two
-- saved intake rows under a prompted reminder.
--
-- This function does the revert atomically: lock the reminder row, look for a
-- successful intake for that (stack, day), and revert only if there is none and
-- the row is still 'logged'. A delayed revert that arrives after a success is a
-- no-op. Returns true only when it actually reverted.
--
-- The lock serializes only callers that also take it: the success path's re-assert in
-- frontend/src/lib/supplement-reminders.ts (SUCCESS_RECONCILE_FROM) matches 'logged' too, so it waits for an
-- in-flight revert instead of skipping the locked row (Codex #834 SUP833-1;
-- tests/test_supplement_reminder_revert_pg.py runs that interleaving). This file is unchanged otherwise.
-- ============================================================================

CREATE OR REPLACE FUNCTION pds.revert_supplement_reminder(
    p_stack_id     BIGINT,
    p_date         DATE,
    p_status       TEXT,
    p_responded_at TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $$
DECLARE
    v_status TEXT;
BEGIN
    SELECT status INTO v_status
      FROM pds.supplement_stack_reminder
     WHERE stack_id = p_stack_id AND behavioral_date = p_date
       FOR UPDATE;
    IF NOT FOUND OR v_status <> 'logged' THEN
        RETURN FALSE;
    END IF;
    IF EXISTS (
        SELECT 1 FROM pds.supplement_intake
         WHERE stack_id = p_stack_id AND intake_date = p_date
    ) THEN
        RETURN FALSE;
    END IF;
    UPDATE pds.supplement_stack_reminder
       SET status = p_status, responded_at = p_responded_at
     WHERE stack_id = p_stack_id AND behavioral_date = p_date;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION pds.revert_supplement_reminder(BIGINT, DATE, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.revert_supplement_reminder(BIGINT, DATE, TEXT, TIMESTAMPTZ) TO service_role;
