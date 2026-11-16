-- ============================================================
-- Onyx — discarded reading entries (2026-11-16, PROD-T01)
-- ============================================================
-- The /log Reading form creates its session with POST /api/reading/sessions
-- carrying a client_key (sql/reading_sessions_client_key.sql). When that
-- create's answer is lost the browser cannot tell whether the session was
-- stored, so Discard asks the server to remove whatever that key made:
-- DELETE /api/reading/sessions?client_key=<uuid>.
--
-- A lookup alone cannot answer that: a create whose connection failed in the
-- browser can still be running on the server and commit after the lookup
-- found nothing, leaving a session (with its habit stamp, XP and Notion
-- entry) that nothing on screen can remove any more. So the discard is
-- recorded here, and a create of a discarded key is refused:
--
--   pds.reading_session_discards          one row per discarded client_key
--   pds.discard_reading_session_key(key)  records the discard, then answers the
--                                         session that key made (or NULL); the
--                                         caller removes that session
--   trigger on pds.reading_sessions       refuses an insert (or a client_key
--                                         update) to a discarded key, SQLSTATE
--                                         OXR01 (lib/reading.ts answers 409)
--
-- Both take the same transaction-scoped advisory lock per key, so a create
-- and a discard of one key run one after the other: a discard that comes
-- second waits for the create to commit and then finds its session; a create
-- that comes second waits for the discard to commit and then sees the
-- discard. Both are VOLATILE plpgsql, so each statement after the lock reads
-- a fresh snapshot (READ COMMITTED, the PostgREST default).
--
-- A removal by session id (lib/reading.ts deleteSession) records the
-- session's key here too, so a create of it still under way cannot bring the
-- session back.
--
-- What is stored: a random UUID the browser made and the time. No reading
-- data. Service role only (RLS on, no policies, nothing for anon or the
-- signed-in owner).
--
-- Additive and safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.reading_session_discards (
    client_key    uuid        PRIMARY KEY,
    discarded_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pds.reading_session_discards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.reading_session_discards FROM anon, authenticated;
GRANT SELECT, INSERT ON pds.reading_session_discards TO service_role;

COMMENT ON TABLE pds.reading_session_discards IS
  'client_key values of /log Reading entries that were discarded: a create of one of them is refused (PROD-T01).';

CREATE OR REPLACE FUNCTION pds.reading_sessions_refuse_discarded_key()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
BEGIN
    -- The same lock as pds.discard_reading_session_key: whichever comes second waits for the other to commit.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('pds.reading_sessions.client_key:' || NEW.client_key::text, 0));
    IF EXISTS (SELECT 1 FROM pds.reading_session_discards AS d WHERE d.client_key = NEW.client_key) THEN
        RAISE EXCEPTION 'this reading entry was discarded' USING ERRCODE = 'OXR01';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER reading_sessions_refuse_discarded_key
    BEFORE INSERT OR UPDATE OF client_key ON pds.reading_sessions
    FOR EACH ROW
    WHEN (NEW.client_key IS NOT NULL)
    EXECUTE FUNCTION pds.reading_sessions_refuse_discarded_key();

CREATE OR REPLACE FUNCTION pds.discard_reading_session_key(p_key uuid)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
    v_id bigint;
BEGIN
    IF p_key IS NULL THEN
        RAISE EXCEPTION 'client_key is required' USING ERRCODE = '22023';
    END IF;
    -- A create of this key still committing is waited for here, so its session is found below.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('pds.reading_sessions.client_key:' || p_key::text, 0));
    INSERT INTO pds.reading_session_discards (client_key) VALUES (p_key)
    ON CONFLICT (client_key) DO NOTHING;
    SELECT s.session_id INTO v_id FROM pds.reading_sessions AS s WHERE s.client_key = p_key;
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION pds.reading_sessions_refuse_discarded_key() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.discard_reading_session_key(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.discard_reading_session_key(uuid) TO service_role;

-- Make PostgREST pick up the new function without waiting for a restart.
NOTIFY pgrst, 'reload schema';
