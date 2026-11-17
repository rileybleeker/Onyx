-- ============================================================
-- Onyx - iPhone texts pushed by a Shortcuts automation (pds.phone_messages)
-- ============================================================
-- Additive and idempotent. Source: a personal automation on Riley's iPhone
-- (Message trigger) that POSTs each new text it is scoped to into
-- POST /api/phone-messages/ingest (CI token, flag ONYX_PHONE_MESSAGES_ENABLED=true).
-- iOS has no API to read the existing inbox, so this holds only what the phone pushed.
--
-- Stored: sender as the phone shows it, the text, when it arrived. Never stored:
-- one-time / verification codes (dropped by the route), attachments, recipients.
-- Retention: 90 days (the route deletes older rows on each push); Riley can delete
-- everything with DELETE /api/phone-messages/messages {"all": true}.
-- SERVICE-ROLE ONLY: RLS on, no policy for anyone else, no anon / authenticated grant.
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.phone_messages (
    message_key  TEXT PRIMARY KEY,                       -- sha256(sender | received_at | text), first 32 hex
    sender       TEXT        NOT NULL,
    body         TEXT        NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL,
    ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT phone_messages_sender_len CHECK (char_length(sender) BETWEEN 1 AND 200),
    CONSTRAINT phone_messages_body_len   CHECK (char_length(body) BETWEEN 1 AND 4000)
);

CREATE INDEX IF NOT EXISTS phone_messages_received_idx ON pds.phone_messages (received_at DESC);

ALTER TABLE pds.phone_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.phone_messages FROM anon, authenticated;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'phone_messages' AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.phone_messages FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

GRANT SELECT, INSERT, DELETE ON pds.phone_messages TO service_role;
