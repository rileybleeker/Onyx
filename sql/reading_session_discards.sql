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
--   pds.create_reading_session(...)       a keyed create in ONE transaction:
--                                         the session, the finish of the book
--                                         and the day's habit Yes, all under
--                                         the key's lock
--
-- Both take the same transaction-scoped advisory lock per key, so a create
-- and a discard of one key run one after the other: a discard that comes
-- second waits for the create to commit and then finds its session; a create
-- that comes second waits for the discard to commit and then sees the
-- discard. Both are VOLATILE plpgsql, so each statement after the lock reads
-- a fresh snapshot (READ COMMITTED, the PostgREST default).
--
-- The create's side effects are part of that: a keyed create used to insert
-- the session in one request and finish the book and stamp the habit in later
-- ones, so a discard landing between them removed the session and the create
-- then finished the book (or stamped the habit) for a session that no longer
-- existed (Codex review T01-R4 of PR 376). pds.create_reading_session does
-- the insert, the finish and the habit stamp in one transaction holding the
-- key's lock, so a discard sees either none of them (and the create is then
-- refused) or all of them (and removes the session and undoes the finish).
--
-- A removal by session id (lib/reading.ts deleteSession) records the
-- session's key here too, so a create of it still under way cannot bring the
-- session back. Before this file is applied a removal of a keyed session is
-- refused (503) rather than done without that record.
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

-- A keyed create (the /log Reading form's POST): the session, the book's finish
-- when it reaches the last chapter, and the day's habit Yes, in one transaction
-- under the key's lock (the same lock as the trigger and the discard). Answers
-- the stored row and what happened. A discarded key raises OXR01 (the trigger);
-- a second create of the same key raises 23505 (the unique index), and
-- lib/reading.ts then answers the stored session. A failed habit stamp does not
-- stop the create (as in lib/reading.ts stampHabit): habit_marked is false.
CREATE OR REPLACE FUNCTION pds.create_reading_session(
    p_client_key      uuid,
    p_book_id         bigint,
    p_session_date    date,
    p_chapter_from    integer,
    p_chapter_through integer,
    p_minutes         integer,
    p_medium          text,
    p_recall          text,
    p_question        text,
    p_source          text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
    v_row      pds.reading_sessions%ROWTYPE;
    v_total    integer;
    v_habit    text;
    v_n        integer;
    v_finished boolean := false;
    v_marked   boolean := false;
    v_created  boolean := false;
    v_had      boolean;
BEGIN
    IF p_client_key IS NULL THEN
        RAISE EXCEPTION 'client_key is required' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('pds.reading_sessions.client_key:' || p_client_key::text, 0));

    INSERT INTO pds.reading_sessions
        (book_id, session_date, chapter_from, chapter_through, minutes, medium, recall, question, source, client_key)
    VALUES
        (p_book_id, p_session_date, p_chapter_from, p_chapter_through, p_minutes, p_medium, p_recall, p_question,
         p_source, p_client_key)
    RETURNING * INTO v_row;

    SELECT b.total_chapters, b.habit_name INTO v_total, v_habit FROM pds.books AS b WHERE b.book_id = p_book_id;

    IF v_total IS NOT NULL AND v_total > 0 AND p_chapter_through >= v_total THEN
        UPDATE pds.books AS b SET status = 'finished', finished_on = p_session_date
         WHERE b.book_id = p_book_id AND b.status IS DISTINCT FROM 'finished';
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_finished := v_n > 0;
    END IF;

    IF v_habit IS NOT NULL THEN
        BEGIN
            v_had := EXISTS (SELECT 1 FROM pds.habit_journal AS h WHERE h.cycle_date = p_session_date AND h.question = v_habit);
            INSERT INTO pds.habit_journal (cycle_date, question, category, answer)
            VALUES (p_session_date, v_habit, 'learning', 'Yes')
            ON CONFLICT (cycle_date, question) DO UPDATE SET category = EXCLUDED.category, answer = EXCLUDED.answer;
            v_marked := true;
            v_created := NOT v_had;
        EXCEPTION WHEN OTHERS THEN
            v_marked := false;
            v_created := false;
        END;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'session', pg_catalog.to_jsonb(v_row),
        'finished', v_finished,
        'habit_marked', v_marked,
        'habit_created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION pds.reading_sessions_refuse_discarded_key() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.discard_reading_session_key(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.discard_reading_session_key(uuid) TO service_role;
REVOKE ALL ON FUNCTION pds.create_reading_session(uuid, bigint, date, integer, integer, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.create_reading_session(uuid, bigint, date, integer, integer, integer, text, text, text, text) TO service_role;

-- Make PostgREST pick up the new function without waiting for a restart.
NOTIFY pgrst, 'reload schema';
