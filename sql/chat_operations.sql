-- ============================================================================
-- Onyx Chat: replay-safe write tools (SEC-04, 2026-11-16)
-- ============================================================================
-- /chat runs a model that can call write tools (habit answer, supplement
-- intake, stack, reading session, highlight, quiz result, Spotify playlist).
-- When the answer to a chat request is lost (network loss, timeout, a closed
-- tab) Riley sends the same message again. Before this file every write of the
-- first try could happen a second time.
--
-- The page now sends one request_id (a UUID) per message and the SAME id when
-- the message is retried unchanged. lib/chat-operations.ts keeps a ledger:
--
--   pds.chat_requests     one row per (owner, request_id): which conversation
--                         the id was first sent with (a SHA-256 of it, never
--                         the text). A retry whose conversation differs is
--                         refused (409).
--   pds.chat_operations   one row per write-tool call of a request, keyed by
--                         (owner, request_id, tool, n-th call of that tool):
--                         the call's canonical input and its hash, a status
--                         (pending -> done | refused | unknown), the result
--                         the model got and the receipt Riley saw. A retry
--                         that makes the same call gets the stored result and
--                         receipt back; a different call in the same place is
--                         refused; a refused call (nothing written) can run
--                         again. A call left pending or unknown is re-run only
--                         when the write itself is keyed by the operation id
--                         (below) or naturally idempotent; a Spotify playlist
--                         or quiz result is first looked up (read-only) in
--                         pds.spotify_playlists / pds.reading_quizzes and is
--                         never created again by the retry.
--
-- The operation id (op_id) is also passed into the write itself, so a write
-- that happened before the ledger could record it is found again:
--   pds.supplement_intake.client_event_key / client_event_line
--       one event = all rows of one stack log or one single-product log,
--       inserted in ONE statement, so a retry either finds the whole set or
--       none of it (lib/supplement-stacks.ts, lib/supplement-intake.ts).
--   pds.reading_sessions.client_key (sql/reading_sessions_client_key.sql,
--       repeated below so this file alone is enough; both are IF NOT EXISTS).
--
-- Access: service-role only (RLS on, no policy for anon / authenticated, no
-- grants to them). Only the /api/chat route reads or writes these tables.
-- What is stored: tool inputs, results and receipts of Riley's own chat
-- writes, i.e. the same facts the target tables already hold. No message
-- text, no model reply, no credentials.
--
-- Additive and safe to re-run (IF NOT EXISTS everywhere). Until it is applied
-- the route detects the missing table and runs as before (no ledger); the new
-- intake columns are ignored the same way.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.chat_requests (
    owner_id          UUID        NOT NULL,
    request_id        UUID        NOT NULL,
    conversation_sha  TEXT        NOT NULL CHECK (conversation_sha ~ '^[0-9a-f]{64}$'),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, request_id)
);

CREATE TABLE IF NOT EXISTS pds.chat_operations (
    op_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     UUID        NOT NULL,
    request_id   UUID        NOT NULL,
    tool         TEXT        NOT NULL CHECK (tool ~ '^[a-z][a-z_]{0,63}$'),
    ordinal      INTEGER     NOT NULL CHECK (ordinal BETWEEN 1 AND 1000),
    intent_sha   TEXT        NOT NULL CHECK (intent_sha ~ '^[0-9a-f]{64}$'),
    intent       JSONB       NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'done', 'refused', 'unknown')),
    result       JSONB,
    receipt      JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chat_operations_call_key UNIQUE (owner_id, request_id, tool, ordinal),
    CONSTRAINT chat_operations_request_fk FOREIGN KEY (owner_id, request_id)
        REFERENCES pds.chat_requests (owner_id, request_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_operations_request
    ON pds.chat_operations (owner_id, request_id, created_at);

COMMENT ON TABLE pds.chat_requests IS
  'Onyx Chat replay ledger: one row per chat request id (SHA-256 of its conversation, never the text). Service role only.';
COMMENT ON TABLE pds.chat_operations IS
  'Onyx Chat replay ledger: one row per write-tool call of a request (input, status, result, receipt), so a retried message returns what was already written instead of writing it again. Service role only.';

ALTER TABLE pds.chat_requests   ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.chat_operations ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_requests', 'chat_operations'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'pds' AND tablename = t AND policyname = 'service_full_access'
    ) THEN
      EXECUTE format('CREATE POLICY service_full_access ON pds.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON pds.chat_requests, pds.chat_operations FROM anon, authenticated;
GRANT ALL ON pds.chat_requests, pds.chat_operations TO service_role;

-- ---------------------------------------------------------------------------
-- Supplement intake event identity (stack logs and single-product logs)
-- ---------------------------------------------------------------------------
-- client_event_key = the chat operation id; client_event_line = the row's
-- place in that event (0..n-1). All rows of one event are inserted in a single
-- statement, so the unique index makes a second insert of the same event fail
-- as a whole; the writer then reads the stored rows back. Rows written by
-- every other path keep both columns NULL.
ALTER TABLE pds.supplement_intake ADD COLUMN IF NOT EXISTS client_event_key  UUID;
ALTER TABLE pds.supplement_intake ADD COLUMN IF NOT EXISTS client_event_line SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'supplement_intake_client_event_pair'
      AND conrelid = 'pds.supplement_intake'::regclass
  ) THEN
    ALTER TABLE pds.supplement_intake
      ADD CONSTRAINT supplement_intake_client_event_pair
      CHECK ((client_event_key IS NULL) = (client_event_line IS NULL)
             AND (client_event_line IS NULL OR client_event_line >= 0));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplement_intake_client_event
  ON pds.supplement_intake (client_event_key, client_event_line)
  WHERE client_event_key IS NOT NULL;

COMMENT ON COLUMN pds.supplement_intake.client_event_key IS
  'Idempotency key of one logging event (the Onyx Chat operation id): every row of one stack log or single-product log shares it, so a retried event finds the rows already written.';
COMMENT ON COLUMN pds.supplement_intake.client_event_line IS
  'Place of this row within its client_event_key event (0..n-1).';

-- ---------------------------------------------------------------------------
-- Reading sessions: the client_key of sql/reading_sessions_client_key.sql
-- (no change when that file is already applied). The chat tool passes the
-- operation id as the key, so lib/reading.ts logSession returns the stored
-- session on a retry with no second XP, habit stamp or Notion entry.
-- ---------------------------------------------------------------------------
ALTER TABLE pds.reading_sessions ADD COLUMN IF NOT EXISTS client_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_reading_sessions_client_key
  ON pds.reading_sessions (client_key)
  WHERE client_key IS NOT NULL;

-- Make PostgREST pick up the new tables and columns without waiting for a restart.
NOTIFY pgrst, 'reload schema';
