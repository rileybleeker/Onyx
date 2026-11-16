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
--   pds.move_reading_session(...)         an edit that moves a session to
--                                         another day or book, with the habit
--                                         part of the move, in ONE transaction
--   pds.reading_habit_provenance          what reading stamps did to a day's
--                                         habit row (whether they made it, the
--                                         answer they replaced, the row version
--                                         they left), one row per habit row, so
--                                         the last session of that day going
--                                         takes it back without any answer from
--                                         the browser (pds.stamp_reading_habit /
--                                         pds.settle_reading_habit)
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
-- The habit part of a removal is decided on the server too (Codex T01-R7):
-- whether the create made the day's habit row used to travel only in the
-- create's answer, so a Discard after a lost answer left the Yes behind. The
-- create now writes that down, and the removal reads it. It is kept per habit
-- row, not per session (round 2 of the review): several sessions of one day
-- share the row, so only the last of them going takes the Yes back, in
-- whichever order they go, and a session moved to another day takes its old
-- day's Yes back the same way (also after a replayed create, whose answer
-- carried no habit day). A failed habit part rolls its removal or move back
-- and is reported, never swallowed.
--
-- lib/reading.ts does not fall back to separate requests when a function of
-- this file is missing (or not yet in PostgREST's schema cache): a keyed
-- create, every removal and every move answer 503 and the form retries.
--
-- What is stored: a random UUID the browser made, session / book ids, the
-- session's day, a Notion block id, the habit's name with the answer and
-- category reading replaced, a row version and times. No reading text. Service role
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

-- Who made the day's habit Yes (Codex T01-R7, and the round-2 review of PR 376). One row per habit row a reading
-- stamp touched, keyed by the habit row itself (day, question), NOT by the session: several sessions of one day share
-- the habit row, so a record per session could only describe the first stamp (a second session's stamp over the
-- first one's Yes looked like "the row was already Yes", and removing both sessions in either order left a Yes with no
-- session behind it). Every reading stamp (pds.stamp_reading_habit: the keyed create, a moved session, the keyless
-- chat create) writes it in the same transaction as the habit row:
--   had_row / prev_answer / prev_category  the row as it was before reading first stamped it (kept across later
--                                          reading stamps while nothing else wrote the row in between)
--   row_version                            the row's xmin as the latest reading stamp left it
-- pds.settle_reading_habit reads it once the last session of that day and habit is gone (removed or moved away):
-- while the row is still that version, a row reading made is deleted and a row it changed gets its earlier answer
-- and category back. Any later write to the row (Riley answering the habit on /check-in or /habits, another tool)
-- gives it a new xmin, and that answer is kept; a version that does not compare equal (the row rewritten, removed and
-- re-added) reads as changed, so the answer is kept: the safe direction. No answer from the browser is needed, so a
-- Discard after a lost create answer, or a move after a replayed create, takes the Yes back too.
-- The xmin comparison assumes the stamp and the other writer are different transactions, as every request is.
CREATE TABLE IF NOT EXISTS pds.reading_habit_provenance (
    cycle_date     date        NOT NULL,
    question       text        NOT NULL,
    had_row        boolean     NOT NULL,
    prev_answer    text,
    prev_category  text,
    row_version    text        NOT NULL,
    stamped_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cycle_date, question)
);

ALTER TABLE pds.reading_habit_provenance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.reading_habit_provenance FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pds.reading_habit_provenance TO service_role;

COMMENT ON TABLE pds.reading_habit_provenance IS
  'What reading sessions did to a day''s habit row, so the last of them going takes it back (PROD-T01, Codex T01-R7).';

-- The habit row's lock: every stamp and settle of one (day, question) runs one after the other, so a settle never
-- misses a session committed by a stamp it raced with, and a stamp never misses a settle. Always taken AFTER the
-- client_key lock and any book row lock; two of them (a move) are taken in one fixed order.
CREATE OR REPLACE FUNCTION pds.reading_habit_lock(p_cycle_date date, p_question text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('pds.habit_journal.reading:' || p_cycle_date::text || ':' || p_question, 0));
END;
$$;

-- Stamp the habit Yes for a reading session on that day and record it (above), in one step. Raises on failure: a
-- caller that keeps going without the stamp wraps it in an exception block, so the row and its record both roll back.
-- Answers {marked, created}; created = no row existed for that day before.
CREATE OR REPLACE FUNCTION pds.stamp_reading_habit(p_cycle_date date, p_question text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
    v_had     boolean;
    v_ans     text;
    v_cat     text;
    v_cur     text;
    v_prov    pds.reading_habit_provenance%ROWTYPE;
    v_keep    boolean;
    v_version text;
    v_n       integer;
BEGIN
    IF p_cycle_date IS NULL OR p_question IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('marked', false, 'created', false);
    END IF;
    PERFORM pds.reading_habit_lock(p_cycle_date, p_question);

    -- Insert first and tell insertion from conflict by the row count, then lock the row that was there. A SELECT ...
    -- FOR UPDATE before the upsert locks nothing when the row is absent, so a check-in answer inserted in between
    -- would have been recorded as "no row" and taken away again by a Discard (review of PR 376, round 3). The loop
    -- covers a row deleted between the conflict and the lock.
    LOOP
        INSERT INTO pds.habit_journal (cycle_date, question, category, answer)
        VALUES (p_cycle_date, p_question, 'learning', 'Yes')
        ON CONFLICT (cycle_date, question) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n > 0 THEN
            v_had := false;
            EXIT;
        END IF;
        SELECT h.answer, h.category, h.xmin::text INTO v_ans, v_cat, v_cur FROM pds.habit_journal AS h
         WHERE h.cycle_date = p_cycle_date AND h.question = p_question
         FOR UPDATE;
        IF FOUND THEN
            v_had := true;
            UPDATE pds.habit_journal AS h SET category = 'learning', answer = 'Yes'
             WHERE h.cycle_date = p_cycle_date AND h.question = p_question;
            EXIT;
        END IF;
    END LOOP;
    SELECT h.xmin::text INTO v_version FROM pds.habit_journal AS h
     WHERE h.cycle_date = p_cycle_date AND h.question = p_question;
    SELECT * INTO v_prov FROM pds.reading_habit_provenance AS p
     WHERE p.cycle_date = p_cycle_date AND p.question = p_question
     FOR UPDATE;
    -- An earlier reading stamp's record still describes this row only while nothing else wrote it since.
    v_keep := FOUND AND v_had AND v_prov.row_version = v_cur;

    IF v_keep THEN
        UPDATE pds.reading_habit_provenance AS p SET row_version = v_version, stamped_at = now()
         WHERE p.cycle_date = p_cycle_date AND p.question = p_question;
    ELSE
        INSERT INTO pds.reading_habit_provenance (cycle_date, question, had_row, prev_answer, prev_category, row_version)
        VALUES (p_cycle_date, p_question, v_had, CASE WHEN v_had THEN v_ans END, CASE WHEN v_had THEN v_cat END, v_version)
        ON CONFLICT (cycle_date, question) DO UPDATE SET
            had_row = EXCLUDED.had_row, prev_answer = EXCLUDED.prev_answer, prev_category = EXCLUDED.prev_category,
            row_version = EXCLUDED.row_version, stamped_at = now();
    END IF;

    RETURN pg_catalog.jsonb_build_object('marked', true, 'created', NOT v_had);
END;
$$;

-- A reading session left (day, question): removed, or moved to another day or book. Call it AFTER the session row is
-- deleted or moved, in the same transaction. While another session of a book with that habit is still on that day
-- nothing changes (its Yes stands, and the record stays for it). Otherwise:
--   * the record above decides: a row reading made is deleted, a row it changed gets its earlier answer and category
--     back, but only while the row is still the version reading left (a later answer given anywhere else is kept);
--     the record goes either way;
--   * no record (a session stamped before this file): p_habit_created_on = that day (the browser's word that its
--     create made the row) deletes the day's Yes, as before.
-- Raises on failure (Codex review of PR 376, round 2): a removal or a move whose habit part fails rolls back whole and
-- is retried, instead of reporting success with a Yes left behind.
CREATE OR REPLACE FUNCTION pds.settle_reading_habit(p_cycle_date date, p_question text, p_habit_created_on date)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
    v_prov     pds.reading_habit_provenance%ROWTYPE;
    v_cur      text;
    v_n        integer;
    v_removed  boolean := false;
    v_restored boolean := false;
BEGIN
    IF p_cycle_date IS NULL OR p_question IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('removed', false, 'restored', false, 'kept', false);
    END IF;
    PERFORM pds.reading_habit_lock(p_cycle_date, p_question);

    IF EXISTS (SELECT 1 FROM pds.reading_sessions AS s JOIN pds.books AS b ON b.book_id = s.book_id
                WHERE s.session_date = p_cycle_date AND b.habit_name = p_question) THEN
        RETURN pg_catalog.jsonb_build_object('removed', false, 'restored', false, 'kept', true);
    END IF;

    SELECT * INTO v_prov FROM pds.reading_habit_provenance AS p
     WHERE p.cycle_date = p_cycle_date AND p.question = p_question
     FOR UPDATE;
    IF FOUND THEN
        SELECT h.xmin::text INTO v_cur FROM pds.habit_journal AS h
         WHERE h.cycle_date = p_cycle_date AND h.question = p_question
         FOR UPDATE;
        IF FOUND AND v_cur = v_prov.row_version THEN
            IF NOT v_prov.had_row THEN
                DELETE FROM pds.habit_journal AS h WHERE h.cycle_date = p_cycle_date AND h.question = p_question;
                GET DIAGNOSTICS v_n = ROW_COUNT;
                v_removed := v_n > 0;
            ELSE
                UPDATE pds.habit_journal AS h
                   SET answer = v_prov.prev_answer, category = v_prov.prev_category
                 WHERE h.cycle_date = p_cycle_date AND h.question = p_question
                   AND (h.answer IS DISTINCT FROM v_prov.prev_answer OR h.category IS DISTINCT FROM v_prov.prev_category);
                GET DIAGNOSTICS v_n = ROW_COUNT;
                v_restored := v_n > 0;
                v_removed := v_restored AND v_prov.prev_answer IS DISTINCT FROM 'Yes';
            END IF;
        END IF;
        -- The record belongs to the reading stamps of that day, and the last of them is gone.
        DELETE FROM pds.reading_habit_provenance AS p WHERE p.cycle_date = p_cycle_date AND p.question = p_question;
    ELSIF p_habit_created_on IS NOT NULL AND p_habit_created_on = p_cycle_date THEN
        DELETE FROM pds.habit_journal AS h
         WHERE h.cycle_date = p_cycle_date AND h.question = p_question AND h.answer = 'Yes';
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_removed := v_n > 0;
    END IF;

    RETURN pg_catalog.jsonb_build_object('removed', v_removed, 'restored', v_restored, 'kept', false);
END;
$$;

-- Remove a manual or chat session in ONE transaction: by id ("Remove this session") or by the client_key of its
-- create (Discard after a lost create answer). Exactly one of p_session_id / p_client_key.
--  * The session's key is recorded as discarded under the key's lock first, so a create of it still committing
--    is waited for (and its session removed here) and one arriving later is refused by the trigger.
--  * The delete, the finish it caused (back to reading when no other session reaches the last chapter, the same
--    rule as lib/reading.ts undoFinishIfOnlyThis) and the habit change it made commit together with the cleanup row
--    above, so a removal whose answer is lost leaves nothing half done in the database. The habit part is
--    pds.settle_reading_habit: taken back only when no other session of a book with the same habit is on that day,
--    from the habit row's own record (no answer from the browser needed, Codex T01-R7), else by p_habit_created_on
--    for a session stamped before this file.
--  * A failure of any part (the habit part included) rolls the whole removal back and is reported, so the form
--    retries it; nothing is ever reported removed with its habit Yes left behind (Codex review of PR 376, round 2).
--  * Nothing found: answers removed = false and the cleanup row of an earlier removal of that id or key (or
--    null), so the caller can replay what that removal still owes outside the database.
-- Raises OXR02 for a Kindle session (lib/reading.ts answers 409) and OXR03 when the session's book is missing (404,
-- the session still stored).
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
    v_settle     jsonb;
    v_unfinished boolean := false;
    v_habit_gone boolean := false;
    v_restored   boolean := false;
    v_next       date;
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

    -- The finish this session may have made. finished_on names the first session that reached the last chapter, so
    -- when that session goes: back to reading if no other session reaches the last chapter, else the finish day moves
    -- to the earliest remaining one (two sessions finishing on different days, removed oldest first, used to leave the
    -- book finished for good; review of PR 376, round 3).
    IF v_book.status = 'finished'
       AND v_book.total_chapters IS NOT NULL AND v_book.total_chapters > 0
       AND COALESCE(v_row.chapter_through, 0) >= v_book.total_chapters
       AND v_book.finished_on = v_row.session_date THEN
        SELECT pg_catalog.min(s.session_date) INTO v_next FROM pds.reading_sessions AS s
         WHERE s.book_id = v_book.book_id AND s.chapter_through >= v_book.total_chapters;
        IF v_next IS NULL THEN
            UPDATE pds.books AS b SET status = 'reading', finished_on = NULL WHERE b.book_id = v_book.book_id;
            v_unfinished := true;
            v_book.status := 'reading';
            v_book.finished_on := NULL;
        ELSIF v_next IS DISTINCT FROM v_book.finished_on THEN
            UPDATE pds.books AS b SET finished_on = v_next WHERE b.book_id = v_book.book_id;
            v_book.finished_on := v_next;
        END IF;
    END IF;

    -- No exception block: a failed habit part rolls the removal back (the caller answers an error and is retried).
    IF v_book.habit_name IS NOT NULL THEN
        v_settle := pds.settle_reading_habit(v_row.session_date, v_book.habit_name, p_habit_created_on);
        v_habit_gone := COALESCE((v_settle ->> 'removed')::boolean, false);
        v_restored := COALESCE((v_settle ->> 'restored')::boolean, false);
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
        'habit_restored', v_restored,
        'removal', pg_catalog.to_jsonb(v_rem));
END;
$$;

-- A keyed create (the /log Reading form's POST): the session, the book's finish
-- when it reaches the last chapter, and the day's habit Yes, in one transaction
-- under the key's lock (the same lock as the trigger and the discard). Answers
-- the stored row and what happened. A discarded key raises OXR01 (the trigger);
-- a second create of the same key raises 23505 (the unique index), and
-- lib/reading.ts then answers the stored session. A failed habit stamp does not
-- stop the create (as in lib/reading.ts stampHabit): habit_marked is false, and
-- the stamp's record (pds.reading_habit_provenance) rolls back with it.
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
    v_stamp    jsonb;
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
            v_stamp := pds.stamp_reading_habit(p_session_date, v_habit);
            v_marked := COALESCE((v_stamp ->> 'marked')::boolean, false);
            v_created := COALESCE((v_stamp ->> 'created')::boolean, false);
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

-- An edit that moves a manual or chat session to another day or book (PATCH /api/reading/sessions/[id]): the
-- session's new values and the habit part of the move in ONE transaction (Codex review of PR 376, round 2). The new
-- day's habit is stamped (best-effort, as on a create) and the old day's is settled (pds.settle_reading_habit: from
-- the habit row's own record, so a session whose create answer was lost and replayed, which the browser knows no
-- habit_created_on for, still takes its old day's Yes back). A failed settle rolls the whole move back, so the
-- session never sits on its new day with the old day's Yes left behind and nothing to retry. The book's finish
-- follows in lib/reading.ts as for any edit.
-- Answers {moved: false} when the session no longer exists, else {moved: true, session, habit_marked,
-- habit_created, habit_removed, habit_restored}. Raises OXR02 for a Kindle session and OXR03 when the target book
-- does not exist.
CREATE OR REPLACE FUNCTION pds.move_reading_session(
    p_session_id       bigint,
    p_book_id          bigint,
    p_session_date     date,
    p_chapter_from     integer,
    p_chapter_through  integer,
    p_minutes          integer,
    p_medium           text,
    p_recall           text,
    p_question         text,
    p_habit_created_on date
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
    v_row       pds.reading_sessions%ROWTYPE;
    v_old_date  date;
    v_old_habit text;
    v_new_habit text;
    v_old_lock  text;
    v_new_lock  text;
    v_stamp     jsonb;
    v_settle    jsonb;
    v_marked    boolean := false;
    v_created   boolean := false;
    v_removed   boolean := false;
    v_restored  boolean := false;
BEGIN
    IF p_session_id IS NULL OR p_book_id IS NULL OR p_session_date IS NULL THEN
        RAISE EXCEPTION 'session_id, book_id and session_date are required' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_row FROM pds.reading_sessions AS s WHERE s.session_id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('moved', false);
    END IF;
    IF v_row.source IS DISTINCT FROM 'manual' AND v_row.source IS DISTINCT FROM 'chat' THEN
        RAISE EXCEPTION 'Kindle sessions are written by the harvester' USING ERRCODE = 'OXR02';
    END IF;

    v_old_date := v_row.session_date;
    SELECT b.habit_name INTO v_old_habit FROM pds.books AS b WHERE b.book_id = v_row.book_id;
    SELECT b.habit_name INTO v_new_habit FROM pds.books AS b WHERE b.book_id = p_book_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no such book' USING ERRCODE = 'OXR03';
    END IF;

    -- Both habit rows' locks in one fixed order, so two moves crossing the same days cannot wait on each other.
    IF v_old_habit IS NOT NULL THEN v_old_lock := v_old_date::text || ':' || v_old_habit; END IF;
    IF v_new_habit IS NOT NULL THEN v_new_lock := p_session_date::text || ':' || v_new_habit; END IF;
    IF v_old_lock IS NOT NULL AND v_new_lock IS NOT NULL AND v_new_lock < v_old_lock THEN
        PERFORM pds.reading_habit_lock(p_session_date, v_new_habit);
        PERFORM pds.reading_habit_lock(v_old_date, v_old_habit);
    ELSE
        IF v_old_lock IS NOT NULL THEN PERFORM pds.reading_habit_lock(v_old_date, v_old_habit); END IF;
        IF v_new_lock IS NOT NULL THEN PERFORM pds.reading_habit_lock(p_session_date, v_new_habit); END IF;
    END IF;

    UPDATE pds.reading_sessions AS s
       SET book_id = p_book_id, session_date = p_session_date, chapter_from = p_chapter_from,
           chapter_through = p_chapter_through, minutes = p_minutes, medium = p_medium, recall = p_recall,
           question = p_question
     WHERE s.session_id = p_session_id
    RETURNING * INTO v_row;

    IF v_new_habit IS NOT NULL THEN
        BEGIN
            v_stamp := pds.stamp_reading_habit(p_session_date, v_new_habit);
            v_marked := COALESCE((v_stamp ->> 'marked')::boolean, false);
            v_created := COALESCE((v_stamp ->> 'created')::boolean, false);
        EXCEPTION WHEN OTHERS THEN
            v_marked := false;
            v_created := false;
        END;
    END IF;

    -- The day the session left (a no-op while it, or another session, is still on that day and habit). No exception
    -- block: a failure rolls the move back.
    IF v_old_habit IS NOT NULL THEN
        v_settle := pds.settle_reading_habit(v_old_date, v_old_habit, p_habit_created_on);
        v_removed := COALESCE((v_settle ->> 'removed')::boolean, false);
        v_restored := COALESCE((v_settle ->> 'restored')::boolean, false);
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'moved', true,
        'session', pg_catalog.to_jsonb(v_row),
        'habit_marked', v_marked,
        'habit_created', v_created,
        'habit_removed', v_removed,
        'habit_restored', v_restored);
END;
$$;

REVOKE ALL ON FUNCTION pds.reading_sessions_refuse_discarded_key() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.reading_habit_lock(date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.reading_habit_lock(date, text) TO service_role;
REVOKE ALL ON FUNCTION pds.stamp_reading_habit(date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.stamp_reading_habit(date, text) TO service_role;
REVOKE ALL ON FUNCTION pds.settle_reading_habit(date, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.settle_reading_habit(date, text, date) TO service_role;
REVOKE ALL ON FUNCTION pds.remove_reading_session(bigint, uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.remove_reading_session(bigint, uuid, date) TO service_role;
REVOKE ALL ON FUNCTION pds.create_reading_session(uuid, bigint, date, integer, integer, integer, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.create_reading_session(uuid, bigint, date, integer, integer, integer, text, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION pds.move_reading_session(bigint, bigint, date, integer, integer, integer, text, text, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.move_reading_session(bigint, bigint, date, integer, integer, integer, text, text, text, date) TO service_role;

-- Make PostgREST pick up the new functions without waiting for a restart.
NOTIFY pgrst, 'reload schema';
