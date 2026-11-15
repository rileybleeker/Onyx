-- ============================================================
-- Onyx — reading session idempotency key (2026-11-15)
-- ============================================================
-- The /log Reading section saves a session by itself (autosave): its first
-- save creates the session with POST /api/reading/sessions and every later
-- edit updates it. A create whose answer is lost (network error, or a
-- timeout after the insert) is sent again, so each new session in the form
-- carries a random UUID, client_key. lib/reading.ts logSession returns the
-- session already stored under that key, with no second XP, habit stamp or
-- Notion entry. Sessions from chat and the Kindle harvester carry none.
--
-- Additive only: one nullable column and one partial unique index. Until it
-- is applied, logSession ignores the key and inserts as before.
-- ============================================================

ALTER TABLE pds.reading_sessions ADD COLUMN IF NOT EXISTS client_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_reading_sessions_client_key
  ON pds.reading_sessions (client_key)
  WHERE client_key IS NOT NULL;

COMMENT ON COLUMN pds.reading_sessions.client_key IS
  'Idempotency key of the autosaving /log Reading form (one UUID per new session); a retried create returns the stored session.';
