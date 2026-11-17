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
--                         refused (409). lease_id / lease_until: the try that
--                         is running the request now (one try at a time). A
--                         retry that arrives while another try holds an
--                         unexpired lease is refused (409) before the model
--                         runs. The lease (6 min) is longer than the route's
--                         maxDuration (300 s), so no try outlives it; a try
--                         gives it back when it ends. context: the first
--                         try's local time, time zone and behavioral day; a
--                         retry answers and logs as of then.
--   pds.chat_operations   one row per write-tool call of a request, keyed by
--                         (owner, request_id, tool, n-th call of that tool):
--                         the call's canonical input and its hash, a status
--                         (pending -> done | refused | unknown), the result
--                         the model got, the receipt Riley saw and the context
--                         it first ran with (the behavioral day and the book
--                         being read, so a re-run after the day rolled over or
--                         a new book was started keeps the first ones). A
--                         retry's calls are matched to the stored rows by
--                         content: a match gets the stored result back (or is
--                         re-run when nothing was written, or when the write
--                         is keyed by the operation id; a habit answer or a
--                         highlight is re-run in check mode, which never
--                         overwrites a change made since); a call that matches
--                         nothing (or matches a call that was refused) is
--                         refused once an earlier try wrote, or may have
--                         written, anything. A Spotify playlist is never
--                         re-run: it is looked up read-only in
--                         pds.spotify_playlists by its client_key. A quiz
--                         result is re-run under its op_key
--                         (sql/reading_practice_receipts.sql), which answers
--                         the stored receipt instead of recording it again.
--   pds.chat_operation_tombstones
--                         one row per operation whose keyed supplement intake
--                         or reading session was removed after it was saved
--                         (Undo on /log, a removal on /supplements or
--                         /reading), written by a trigger. A retry of the
--                         message then writes nothing again, and the database
--                         refuses an insert under that key (SQLSTATE OXC01).
--
-- The operation id (op_id) is also passed into the write itself, so a write
-- that happened before the ledger could record it is found again:
--   pds.supplement_intake.client_event_key / client_event_line
--       one event = all rows of one stack log or one single-product log,
--       inserted in ONE statement, so a retry either finds the whole set or
--       none of it (lib/supplement-stacks.ts, lib/supplement-intake.ts).
--   pds.reading_sessions.client_key (sql/reading_sessions_client_key.sql,
--       repeated below so this file alone is enough; both are IF NOT EXISTS).
--   pds.spotify_playlists.client_key: the audit row of a playlist created
--       from chat (lib/spotify-server.ts createPlaylist).
--   pds.book_highlights.client_key: a highlight created from chat
--       (lib/reading.ts addHighlight, set on insert only), so a retry finds
--       the highlight its earlier try made even after its passage or note
--       was edited.
--
-- Access: service-role only (RLS on, no policy for anon / authenticated, no
-- grants to them). Only the /api/chat route reads or writes these tables.
-- What is stored: the tool inputs of Riley's own chat writes, their results
-- and receipts. The inputs can include text Riley dictated that the target
-- tables store too (a reading recall note, a highlight passage and comment,
-- quiz notes); a refused or unfinished call keeps only its error line, never
-- the lists it carried. Never the conversation, the model's reply or any
-- credential. There is no retention window yet (a scheduled clean-up needs
-- Riley's approval; roadmap follow-up).
--
-- Additive and safe to re-run (IF NOT EXISTS everywhere). Fail closed: while
-- it is not applied (or after a rollback) a request with a request_id runs no
-- write tool (questions are still answered), and a keyed intake, session,
-- highlight or playlist is refused rather than written without its key (also
-- while the tombstone table is missing).
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.chat_requests (
    owner_id          UUID        NOT NULL,
    request_id        UUID        NOT NULL,
    conversation_sha  TEXT        NOT NULL CHECK (conversation_sha ~ '^[0-9a-f]{64}$'),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_id          UUID,
    lease_until       TIMESTAMPTZ,
    context           JSONB,
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
    context      JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chat_operations_call_key UNIQUE (owner_id, request_id, tool, ordinal),
    CONSTRAINT chat_operations_request_fk FOREIGN KEY (owner_id, request_id)
        REFERENCES pds.chat_requests (owner_id, request_id) ON DELETE CASCADE
);

-- For a database where an earlier draft of this file was applied.
ALTER TABLE pds.chat_operations ADD COLUMN IF NOT EXISTS context JSONB;
ALTER TABLE pds.chat_requests   ADD COLUMN IF NOT EXISTS lease_id    UUID;
ALTER TABLE pds.chat_requests   ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
-- What the first try of the request ran with ({now, time_zone, behavioral_today}), written with the row: a retry
-- uses it for its prompt and for every new operation's default day, so a first try that stopped before any
-- operation was recorded cannot move "today" to the next day on a retry after midnight / 06:00.
ALTER TABLE pds.chat_requests   ADD COLUMN IF NOT EXISTS context     JSONB;

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

-- ---------------------------------------------------------------------------
-- Spotify playlists created from chat: the audit row carries the operation id,
-- so a retry whose first try may have created the playlist finds it here
-- (read-only) instead of creating a second one. From chat the row is written
-- right after Spotify made the playlist, with track_count NULL until every
-- track was added. Rows from /spotify and older rows keep client_key NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE pds.spotify_playlists ADD COLUMN IF NOT EXISTS client_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_spotify_playlists_client_key
  ON pds.spotify_playlists (client_key)
  WHERE client_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Highlights created from chat: the operation id as client_key, set on insert
-- only (a call that updates an existing highlight leaves it alone). Rows from
-- every other path keep it NULL. Highlights are never hard removed (removing
-- one archives it), so they need no tombstone.
-- ---------------------------------------------------------------------------
ALTER TABLE pds.book_highlights ADD COLUMN IF NOT EXISTS client_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_book_highlights_client_key
  ON pds.book_highlights (client_key)
  WHERE client_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Removed since: tombstones for keyed chat writes Riley removed afterwards
-- ---------------------------------------------------------------------------
-- A chat write keyed by its operation id can be removed after it was saved.
-- If the answer to that chat message was lost before the ledger recorded the
-- write, a retry re-runs it under the same operation id, and with the row
-- gone it would be written a second time. So removing such a row leaves a
-- tombstone (the operation id and the table, nothing else): the chat route
-- reads it before a keyed write and answers "removed since, not written
-- again", and the insert guard below refuses an insert under that key
-- (SQLSTATE OXC01), also when a removal and a retry cross: the removal and
-- the insert each take the same per-key transaction lock first (an advisory
-- lock on the operation id), so the insert's tombstone check waits for a
-- removal of that key that is still running and then sees its tombstone.
-- Without the lock the check could run before the removal committed, the
-- insert would then wait on the unique index for the removed row and go in
-- once the removal committed, bringing the removed write back. Only keys that are
-- chat operation ids get one (the /log reading form's own client keys never
-- do), so every other path is unchanged. A tombstone goes with its operation
-- (ON DELETE CASCADE), so a future ledger retention window covers it too.
CREATE TABLE IF NOT EXISTS pds.chat_operation_tombstones (
    op_id       UUID        PRIMARY KEY
                            REFERENCES pds.chat_operations (op_id) ON DELETE CASCADE,
    target      TEXT        NOT NULL CHECK (target IN ('supplement_intake', 'reading_sessions')),
    removed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE pds.chat_operation_tombstones IS
  'Onyx Chat replay ledger: operations whose keyed supplement intake or reading session was removed after it was saved, so a retried chat message never writes it again. Written by trigger only. Service role only.';

ALTER TABLE pds.chat_operation_tombstones ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'pds' AND tablename = 'chat_operation_tombstones' AND policyname = 'service_full_access'
  ) THEN
    CREATE POLICY service_full_access ON pds.chat_operation_tombstones
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON pds.chat_operation_tombstones FROM anon, authenticated;
GRANT ALL ON pds.chat_operation_tombstones TO service_role;

-- One transaction lock per operation id (pg_advisory_xact_lock on a hash of
-- it), held until commit or rollback. The removal takes it in a BEFORE DELETE
-- trigger (so before the row is removed and before the tombstone is written)
-- and the insert guard takes it before it looks for a tombstone. In READ
-- COMMITTED each statement of a plpgsql function reads a fresh snapshot, so a
-- guard that waited for the lock sees the tombstone the removal committed. An
-- insert that holds the lock first and meets the row being removed gets a
-- unique violation at once (that row is only locked at that point, not yet
-- removed), so the two never wait on each other. A hash collision with another
-- key only makes the two wait in turn.
--
-- TG_ARGV[0] = the key column. Takes the key's lock before the row is removed.
CREATE OR REPLACE FUNCTION pds.chat_operation_lock_removed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pds
AS $$
DECLARE
  k UUID := (to_jsonb(OLD) ->> TG_ARGV[0])::uuid;
BEGIN
  IF k IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('pds.chat_operation:' || k::text, 0));
  END IF;
  RETURN OLD;
END;
$$;

-- TG_ARGV[0] = the key column of the table the trigger is on. SECURITY DEFINER
-- so a removal by any role allowed to remove the row also records its
-- tombstone (the ledger tables are service-role only).
CREATE OR REPLACE FUNCTION pds.chat_operation_tombstone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pds
AS $$
DECLARE
  k UUID := (to_jsonb(OLD) ->> TG_ARGV[0])::uuid;
BEGIN
  IF k IS NOT NULL THEN
    -- Already held since the BEFORE DELETE trigger ran (taking it again only stacks it).
    PERFORM pg_advisory_xact_lock(hashtextextended('pds.chat_operation:' || k::text, 0));
    INSERT INTO pds.chat_operation_tombstones (op_id, target)
    SELECT o.op_id, TG_TABLE_NAME FROM pds.chat_operations o WHERE o.op_id = k
    ON CONFLICT (op_id) DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION pds.chat_operation_not_removed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pds
AS $$
DECLARE
  k UUID := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
BEGIN
  -- Wait for a removal of this key that is still running, then check (a fresh snapshot sees its tombstone).
  PERFORM pg_advisory_xact_lock(hashtextextended('pds.chat_operation:' || k::text, 0));
  IF EXISTS (
    SELECT 1 FROM pds.chat_operation_tombstones t
    WHERE t.op_id = k
  ) THEN
    RAISE EXCEPTION 'this chat write was removed after it was saved' USING ERRCODE = 'OXC01';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION pds.chat_operation_lock_removed() FROM PUBLIC;
REVOKE ALL ON FUNCTION pds.chat_operation_tombstone() FROM PUBLIC;
REVOKE ALL ON FUNCTION pds.chat_operation_not_removed() FROM PUBLIC;

CREATE OR REPLACE TRIGGER supplement_intake_chat_lock
  BEFORE DELETE ON pds.supplement_intake
  FOR EACH ROW WHEN (OLD.client_event_key IS NOT NULL)
  EXECUTE FUNCTION pds.chat_operation_lock_removed('client_event_key');

CREATE OR REPLACE TRIGGER reading_sessions_chat_lock
  BEFORE DELETE ON pds.reading_sessions
  FOR EACH ROW WHEN (OLD.client_key IS NOT NULL)
  EXECUTE FUNCTION pds.chat_operation_lock_removed('client_key');

CREATE OR REPLACE TRIGGER supplement_intake_chat_tombstone
  AFTER DELETE ON pds.supplement_intake
  FOR EACH ROW WHEN (OLD.client_event_key IS NOT NULL)
  EXECUTE FUNCTION pds.chat_operation_tombstone('client_event_key');

CREATE OR REPLACE TRIGGER reading_sessions_chat_tombstone
  AFTER DELETE ON pds.reading_sessions
  FOR EACH ROW WHEN (OLD.client_key IS NOT NULL)
  EXECUTE FUNCTION pds.chat_operation_tombstone('client_key');

CREATE OR REPLACE TRIGGER supplement_intake_chat_not_removed
  BEFORE INSERT ON pds.supplement_intake
  FOR EACH ROW WHEN (NEW.client_event_key IS NOT NULL)
  EXECUTE FUNCTION pds.chat_operation_not_removed('client_event_key');

CREATE OR REPLACE TRIGGER reading_sessions_chat_not_removed
  BEFORE INSERT ON pds.reading_sessions
  FOR EACH ROW WHEN (NEW.client_key IS NOT NULL)
  EXECUTE FUNCTION pds.chat_operation_not_removed('client_key');

-- Make PostgREST pick up the new tables and columns without waiting for a restart.
NOTIFY pgrst, 'reload schema';
