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
--   trigger on pds.reading_sessions       refuses an insert (or a client_key
--                                         update) to a discarded key, SQLSTATE
--                                         OXR01 (lib/reading.ts answers 409)
--   pds.create_reading_session(...)       a keyed create in ONE transaction:
--                                         the session, the finish of the book
--                                         and the day's habit Yes, all under
--                                         the key's lock
--   pds.remove_reading_session(...)       a removal in ONE transaction, by id
--                                         or by key: records the key as
--                                         discarded, deletes the session,
--                                         undoes the finish (and the habit Yes
--                                         it made) and records the Notion
--                                         cleanup still owed
--   pds.reading_session_removals          that cleanup ledger: a retried
--                                         removal whose answer was lost
--                                         replays it
--
-- All take the same transaction-scoped advisory lock per key, so a create
-- and a removal of one key run one after the other: a removal that comes
-- second waits for the create to commit and then finds its session; a create
-- that comes second waits for the removal to commit and then sees the
-- discard. All are VOLATILE plpgsql, so each statement after the lock reads
-- a fresh snapshot (READ COMMITTED, the PostgREST default).
--
-- The side effects are part of that (Codex review of PR 376). A keyed create
-- used to insert the session in one request and finish the book and stamp the
-- habit in later ones, so a discard landing between them left a finished book
-- or a habit Yes for a removed session (T01-R4). A removal used to delete the
-- session and undo the finish in separate requests, so one whose answer was
-- lost could leave the book finished and its Notion entry in place, and its
-- retry found nothing to do. Both are one transaction now, and the removal's
-- Notion cleanup is written down with it so a retry can finish it.
--
-- lib/reading.ts does not fall back to separate requests when a function of
-- this file is missing (or not yet in PostgREST's schema cache): a keyed
-- create and every removal answer 503 and the form retries.
--
-- What is stored: a random UUID the browser made, session / book ids, the
-- session's day, a Notion block id and times. No reading text. Service role
-- only (RLS on, no policies, nothing for anon or the signed-in owner).
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
    -- The same lock as pds.create_reading_session and pds.remove_reading_session: whichever comes second waits.
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

-- What a removal still owes outside the database: the session's Notion entry (trashed) and the book page's
-- progress line (rewritten). The removal writes this row in the same transaction as the delete, and the route marks
-- it done (mirror_done_at) once the entry is trashed. A removal whose answer was lost finds the session gone on
-- its retry and answers this row instead, so the route replays the cleanup (Codex review of PR 376: before this,
-- a retry found nothing and the Notion entry stayed). Stored: ids, the session's day, the Notion block id. No
-- reading text.
CREATE TABLE IF NOT EXISTS pds.reading_session_removals (
    session_id       bigint      PRIMARY KEY,
    client_key       uuid,
    book_id          bigint      NOT NULL,
    session_date     date,
    notion_block_id  text,
    unfinished       boolean     NOT NULL DEFAULT false,
    removed_at       timestamptz NOT NULL DEFAULT now(),
    mirror_done_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_reading_session_removals_key
    ON pds.reading_session_removals (client_key) WHERE client_key IS NOT NULL;

ALTER TABLE pds.reading_session_removals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.reading_session_removals FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON pds.reading_session_removals TO service_role;

COMMENT ON TABLE pds.reading_session_removals IS
  'Removed /log Reading sessions whose Notion cleanup may still be owed (mirror_done_at NULL); replayed on a retried removal (PROD-T01).';

-- Remove a manual or chat session in ONE transaction: by id ("Remove this session") or by the client_key of its
-- create (Discard after a lost create answer). Exactly one of p_session_id / p_client_key.
--  * The session's key is recorded as discarded under the key's lock first, so a create of it still committing
--    is waited for (and its session removed here) and one arriving later is refused by the trigger.
--  * The delete, the finish it caused (back to reading when no other session reaches the last chapter, the same
--    rule as lib/reading.ts undoFinishIfOnlyThis) and the habit Yes it made (p_habit_created_on = its day, and no
--    other session of a book with the same habit on that day) commit together with the cleanup row above, so a
--    removal whose answer is lost leaves nothing half done in the database.
--  * Nothing found: answers removed = false and the cleanup row of an earlier removal of that id or key (or
--    null), so the caller can replay what that removal still owes outside the database.
-- Raises OXR02 for a Kindle session (lib/reading.ts answers 409) and OXR03 when the session's book is missing (404).
CREATE OR REPLACE FUNCTION pds.remove_reading_session(
    p_session_id       bigint,
    p_client_key       uuid,
    p_habit_created_on date
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
    v_key        uuid;
    v_row        pds.reading_sessions%ROWTYPE;
    v_book       pds.books%ROWTYPE;
    v_rem        pds.reading_session_removals%ROWTYPE;
    v_unfinished boolean := false;
    v_habit_gone boolean := false;
    v_n          integer;
BEGIN
    IF (p_session_id IS NULL) = (p_client_key IS NULL) THEN
        RAISE EXCEPTION 'exactly one of session_id and client_key is required' USING ERRCODE = '22023';
    END IF;
    IF p_client_key IS NOT NULL THEN
        v_key := p_client_key;
    ELSE
        SELECT s.client_key INTO v_key FROM pds.reading_sessions AS s WHERE s.session_id = p_session_id;
    END IF;

    IF v_key IS NOT NULL THEN
        -- The same lock as the trigger and pds.create_reading_session: a create of this key still committing is
        -- waited for here, so its session is found below.
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended('pds.reading_sessions.client_key:' || v_key::text, 0));
        INSERT INTO pds.reading_session_discards (client_key) VALUES (v_key)
        ON CONFLICT (client_key) DO NOTHING;
    END IF;

    IF p_client_key IS NOT NULL THEN
        SELECT * INTO v_row FROM pds.reading_sessions AS s WHERE s.client_key = p_client_key FOR UPDATE;
    ELSE
        SELECT * INTO v_row FROM pds.reading_sessions AS s WHERE s.session_id = p_session_id FOR UPDATE;
    END IF;

    IF NOT FOUND THEN
        IF p_client_key IS NOT NULL THEN
            SELECT * INTO v_rem FROM pds.reading_session_removals AS r
             WHERE r.client_key = p_client_key ORDER BY r.removed_at DESC LIMIT 1;
        ELSE
            SELECT * INTO v_rem FROM pds.reading_session_removals AS r WHERE r.session_id = p_session_id;
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'removed', false,
            'removal', CASE WHEN FOUND THEN pg_catalog.to_jsonb(v_rem) ELSE NULL END);
    END IF;

    IF v_row.source IS DISTINCT FROM 'manual' AND v_row.source IS DISTINCT FROM 'chat' THEN
        RAISE EXCEPTION 'Kindle sessions are written by the harvester' USING ERRCODE = 'OXR02';
    END IF;

    SELECT * INTO v_book FROM pds.books AS b WHERE b.book_id = v_row.book_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'the book of this session no longer exists' USING ERRCODE = 'OXR03';
    END IF;

    DELETE FROM pds.reading_sessions AS s WHERE s.session_id = v_row.session_id;

    IF v_book.status = 'finished'
       AND v_book.total_chapters IS NOT NULL AND v_book.total_chapters > 0
       AND COALESCE(v_row.chapter_through, 0) >= v_book.total_chapters
       AND v_book.finished_on = v_row.session_date
       AND NOT EXISTS (SELECT 1 FROM pds.reading_sessions AS s
                        WHERE s.book_id = v_book.book_id AND s.chapter_through >= v_book.total_chapters) THEN
        UPDATE pds.books AS b SET status = 'reading', finished_on = NULL WHERE b.book_id = v_book.book_id;
        v_unfinished := true;
        v_book.status := 'reading';
        v_book.finished_on := NULL;
    END IF;

    IF p_habit_created_on IS NOT NULL AND p_habit_created_on = v_row.session_date AND v_book.habit_name IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pds.reading_sessions AS s
                        WHERE s.session_date = v_row.session_date
                          AND s.book_id IN (SELECT b.book_id FROM pds.books AS b WHERE b.habit_name = v_book.habit_name)) THEN
        -- Best-effort, as before (lib/reading.ts unstampHabitIfUnused): a refused habit delete keeps the removal.
        BEGIN
            DELETE FROM pds.habit_journal AS h
             WHERE h.cycle_date = v_row.session_date AND h.question = v_book.habit_name AND h.answer = 'Yes';
            GET DIAGNOSTICS v_n = ROW_COUNT;
            v_habit_gone := v_n > 0;
        EXCEPTION WHEN OTHERS THEN
            v_habit_gone := false;
        END;
    END IF;

    INSERT INTO pds.reading_session_removals (session_id, client_key, book_id, session_date, notion_block_id, unfinished)
    VALUES (v_row.session_id, v_row.client_key, v_row.book_id, v_row.session_date, v_row.notion_block_id, v_unfinished)
    ON CONFLICT (session_id) DO UPDATE SET notion_block_id = EXCLUDED.notion_block_id, mirror_done_at = NULL
    RETURNING * INTO v_rem;

    RETURN pg_catalog.jsonb_build_object(
        'removed', true,
        'session', pg_catalog.to_jsonb(v_row),
        'book', pg_catalog.to_jsonb(v_book),
        'unfinished', v_unfinished,
        'habit_removed', v_habit_gone,
        'removal', pg_catalog.to_jsonb(v_rem));
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
REVOKE ALL ON FUNCTION pds.remove_reading_session(bigint, uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.remove_reading_session(bigint, uuid, date) TO service_role;
REVOKE ALL ON FUNCTION pds.create_reading_session(uuid, bigint, date, integer, integer, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.create_reading_session(uuid, bigint, date, integer, integer, integer, text, text, text, text) TO service_role;

-- Make PostgREST pick up the new function without waiting for a restart.
NOTIFY pgrst, 'reload schema';
