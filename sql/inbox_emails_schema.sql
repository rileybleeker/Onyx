-- ============================================================
-- Onyx — Inbox emails (metadata only) for the Today "Urgent email" panel
-- ============================================================
-- PROPOSED, NOT APPLIED. Run it in the Supabase SQL editor, then let
-- urgent_email_etl.py (.github/workflows/urgent-email.yml, hourly) fill it.
-- Until it exists, GET /api/urgent-email answers "not_connected" and Today shows
-- "No urgent email source connected yet".
--
-- What is stored: ONLY messages that inbox-triage labelled Agent/Action or
-- Agent/Deadline (not the whole inbox): who sent it, the subject, a short plain-text
-- snippet, when it arrived, whether it is still unread / still in the inbox, its
-- Agent/* labels, the Gmail thread + message ids and the RFC 5322 Message-ID.
-- What is NOT stored: full bodies, HTML, attachments, recipients, or any credentials.
-- Rows are never deleted: a message that loses its label (or leaves the 30-day search
-- window) is set labeled = false by the next run. Re-running this file is safe.
--
-- Privacy: unlike most of pds this table is SERVICE-ROLE ONLY. No anon or authenticated
-- grant and no owner_read policy, so the Data API and the browser cannot read it; only
-- the Next.js API route (service-role key, behind the owner-login middleware) does, and
-- it never returns the snippet.
-- Re-running sql/pds_owner_only_read.sql does not expose it: that script only touches
-- relations that already carry an anon/authenticated SELECT grant.
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.inbox_emails (
    email_id      BIGSERIAL PRIMARY KEY,

    account       TEXT        NOT NULL,                 -- mailbox the message sits in, e.g. the Gmail address
    message_id    TEXT        NOT NULL,                 -- RFC 5322 Message-ID, without angle brackets
    received_at   TIMESTAMPTZ NOT NULL,                 -- Date header resolved to an instant

    from_name     TEXT,                                 -- display name as printed
    from_address  TEXT        NOT NULL,                 -- bare address, lower-cased by the ingestion job
    subject       TEXT        NOT NULL DEFAULT '',
    snippet       TEXT,                                 -- first ~240 characters of the plain-text body, never HTML
    is_unread     BOOLEAN     NOT NULL DEFAULT TRUE,    -- the ingestion job refreshes this each run

    synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT inbox_emails_account_message_key UNIQUE (account, message_id),
    CONSTRAINT inbox_emails_snippet_len CHECK (snippet IS NULL OR char_length(snippet) <= 500)
);

CREATE INDEX IF NOT EXISTS inbox_emails_received_idx ON pds.inbox_emails (received_at DESC);

ALTER TABLE pds.inbox_emails ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pds.inbox_emails FROM anon, authenticated;
REVOKE ALL ON SEQUENCE pds.inbox_emails_email_id_seq FROM anon, authenticated;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'inbox_emails' AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.inbox_emails FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON pds.inbox_emails TO service_role;   -- the ETL upserts and unlabels; it never removes rows
GRANT USAGE, SELECT ON SEQUENCE pds.inbox_emails_email_id_seq TO service_role;

-- ------------------------------------------------------------
-- Label-sourced columns (2026-11-11). ADD COLUMN IF NOT EXISTS so this also
-- upgrades a table created from the first version of this file.
-- ------------------------------------------------------------
ALTER TABLE pds.inbox_emails ADD COLUMN IF NOT EXISTS gmail_thread_id  TEXT;                          -- X-GM-THRID (decimal) = thread-f:<n> in Gmail links
ALTER TABLE pds.inbox_emails ADD COLUMN IF NOT EXISTS gmail_message_id TEXT;                          -- X-GM-MSGID (decimal)
ALTER TABLE pds.inbox_emails ADD COLUMN IF NOT EXISTS agent_labels     TEXT[]      NOT NULL DEFAULT '{}';  -- subset of {Agent/Action, Agent/Deadline}
ALTER TABLE pds.inbox_emails ADD COLUMN IF NOT EXISTS in_inbox         BOOLEAN     NOT NULL DEFAULT TRUE;  -- false once archived
ALTER TABLE pds.inbox_emails ADD COLUMN IF NOT EXISTS labeled          BOOLEAN     NOT NULL DEFAULT TRUE;  -- false once no Agent/* label is seen
ALTER TABLE pds.inbox_emails ADD COLUMN IF NOT EXISTS last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(); -- start of the last run that saw it labeled

CREATE INDEX IF NOT EXISTS inbox_emails_labeled_received_idx ON pds.inbox_emails (received_at DESC) WHERE labeled;
CREATE INDEX IF NOT EXISTS inbox_emails_account_seen_idx     ON pds.inbox_emails (account, last_seen_at) WHERE labeled;
