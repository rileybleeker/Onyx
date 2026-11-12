-- ============================================================================
-- Supplement stack reminders (additive only)
-- ============================================================================
-- A stack can carry a local "remind me at HH:MM" time. The sms-reminders
-- Worker polls POST /api/supplements/reminders/claim, posts a push card to the
-- /agents chat for each stack that is due and not yet logged, and routes the
-- Log it / Skip taps to POST /api/supplements/reminders/respond.
--
--   * pds.supplement_stack.remind_time   local wall-clock 'HH:MM', NULL = off
--   * pds.supplement_stack_reminder      one row per (stack, behavioral day):
--                                        the claim ledger. The primary key is
--                                        what stops two concurrent claim calls
--                                        from both prompting for the same day.
--
-- Service-role only: the Worker never talks to Supabase directly, it goes
-- through the Onyx routes, so neither anon nor the signed-in owner can read
-- the ledger.
-- ============================================================================

-- 1. Reminder time on the stack ---------------------------------------------
ALTER TABLE pds.supplement_stack
    ADD COLUMN IF NOT EXISTS remind_time TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'supplement_stack_remind_time_check'
           AND conrelid = 'pds.supplement_stack'::regclass
    ) THEN
        ALTER TABLE pds.supplement_stack
            ADD CONSTRAINT supplement_stack_remind_time_check
            CHECK (remind_time IS NULL OR remind_time ~ '^([01]\d|2[0-3]):[0-5]\d$');
    END IF;
END $$;

COMMENT ON COLUMN pds.supplement_stack.remind_time IS
    'Local wall-clock HH:MM (24h) at which the stack is offered as a push card in /agents; NULL = reminders off. The window is remind_time up to +4h on the TZ-aware clock (pds.tz_for_instant).';

-- 2. Claim ledger ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.supplement_stack_reminder (
    stack_id         BIGINT      NOT NULL REFERENCES pds.supplement_stack(stack_id) ON DELETE CASCADE,
    behavioral_date  DATE        NOT NULL,
    status           TEXT        NOT NULL DEFAULT 'prompted'
                                 CHECK (status IN ('prompted', 'logged', 'skipped')),
    prompted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at     TIMESTAMPTZ,
    PRIMARY KEY (stack_id, behavioral_date)
);

-- "Which prompts are still open?" (settle sweep in the claim route).
CREATE INDEX IF NOT EXISTS idx_supplement_stack_reminder_open
    ON pds.supplement_stack_reminder (behavioral_date)
    WHERE status = 'prompted';

-- 3. Access: service role only ------------------------------------------------
ALTER TABLE pds.supplement_stack_reminder ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'pds'
           AND tablename  = 'supplement_stack_reminder'
           AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.supplement_stack_reminder
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

REVOKE ALL ON pds.supplement_stack_reminder FROM anon, authenticated;
GRANT  ALL ON pds.supplement_stack_reminder TO service_role;

-- 4. Defaults for Riley's two stacks (editable in the stack editor) -----------
-- Only fills a NULL, so re-running never overwrites a time that was edited.
UPDATE pds.supplement_stack
   SET remind_time = '08:30'
 WHERE stack_id = 4 AND lower(name) = 'morning stack' AND remind_time IS NULL;

UPDATE pds.supplement_stack
   SET remind_time = '22:30'
 WHERE stack_id = 3 AND lower(name) = 'night stack' AND remind_time IS NULL;
