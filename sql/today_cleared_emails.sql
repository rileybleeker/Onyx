-- ============================================================
-- Onyx: labelled email threads Riley cleared from Today's "Urgent email" panel
-- ============================================================
-- One row per cleared thread. GET /api/urgent-email leaves a thread out while its newest
-- message is no newer than cleared_through; a newer message in the thread shows it again.
-- Written only by POST /api/urgent-email/clear (owner session; undo removes the row).
-- Agent Inbox cards are cleared in the sms-reminders Worker (POST /onyx/dismiss), not here.
--
-- Stored: a SHA-256 of the thread key (the key names a mailbox and a Gmail thread id, so it is
-- not stored as such) and two times. Nothing is ever sent to Gmail.
--
-- SERVICE-ROLE ONLY, like pds.inbox_emails: RLS on, no policies, no anon / authenticated grant.
-- sql/pds_owner_only_read.sql skips it. Re-running this file is safe.
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.today_cleared_emails (
    key_hash        TEXT        PRIMARY KEY,
    cleared_through TIMESTAMPTZ NOT NULL,           -- newest message time of the thread when it was cleared
    cleared_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT today_cleared_emails_key_hash_hex CHECK (key_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS today_cleared_emails_through_idx ON pds.today_cleared_emails (cleared_through DESC);

ALTER TABLE pds.today_cleared_emails ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pds.today_cleared_emails FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pds.today_cleared_emails TO service_role;
