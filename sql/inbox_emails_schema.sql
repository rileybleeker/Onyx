-- ============================================================
-- Onyx — Inbox emails (metadata only) for the Today "Urgent email" panel
-- ============================================================
-- PROPOSED, NOT APPLIED. Nothing in Onyx writes this table yet. Run it in the Supabase
-- SQL editor only after the ingestion decision is made (see the PR for the options).
-- Until it exists, GET /api/urgent-email answers "not_connected" and Today shows
-- "No urgent email source connected yet".
--
-- What is stored: who sent it, the subject, a short plain-text snippet, when it arrived,
-- whether it is still unread, and the RFC 5322 Message-ID (used to build a Gmail link).
-- What is NOT stored: full bodies, HTML, attachments, recipients, or any credentials.
-- The ingestion job should keep only the last ~30 days (DELETE older rows each run).
--
-- Privacy: unlike most of pds this table is SERVICE-ROLE ONLY. No anon or authenticated
-- grant and no owner_read policy, so the Data API and the browser cannot read it; only
-- the Next.js API route (service-role key, behind the owner-login middleware) does.
-- sql/pds_owner_only_read.sql lists inbox_emails in its skip list, so re-running it (or
-- rls_policies.sql followed by it) never grants SELECT or an owner_read policy here.
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
    -- Length caps: the ingestion job truncates to these; the database refuses anything longer.
    CONSTRAINT inbox_emails_account_len      CHECK (char_length(account) <= 320),
    CONSTRAINT inbox_emails_message_id_len   CHECK (char_length(message_id) BETWEEN 1 AND 500),  -- 500 = the Gmail-link limit in the app
    CONSTRAINT inbox_emails_from_name_len    CHECK (from_name IS NULL OR char_length(from_name) <= 200),
    CONSTRAINT inbox_emails_from_address_len CHECK (char_length(from_address) <= 320),
    CONSTRAINT inbox_emails_subject_len      CHECK (char_length(subject) <= 500),
    CONSTRAINT inbox_emails_snippet_len      CHECK (snippet IS NULL OR char_length(snippet) <= 500)
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

GRANT SELECT, INSERT, UPDATE, DELETE ON pds.inbox_emails TO service_role;
GRANT USAGE, SELECT ON SEQUENCE pds.inbox_emails_email_id_seq TO service_role;
