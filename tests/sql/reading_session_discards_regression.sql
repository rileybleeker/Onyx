-- Database regression for sql/reading_session_discards.sql. Run AFTER that file is applied, against the real database
-- (it exercises the actual functions, trigger and locks, not a model of them):
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f tests/sql/reading_session_discards_regression.sql
-- Everything runs in one transaction that is rolled back; it uses a synthetic book and leaves nothing behind.
-- Not run before merge (Onyx rule: no automated tests before deployment); run once after the SQL is applied.
--
-- Two-session lock check (manual, the one thing a single session cannot show): in session A run
--   BEGIN; SELECT pds.create_reading_session('00000000-0000-4000-8000-0000000000aa', <book>, CURRENT_DATE, 1, 1, NULL, NULL, NULL, NULL, 'manual');
-- then in session B run
--   SELECT pds.remove_reading_session(NULL, '00000000-0000-4000-8000-0000000000aa', NULL);   -- blocks on the key's lock
-- then COMMIT in A: B returns removed = true with the session, and a later create of that key raises OXR01.
--
-- Row versions: the habit cases compare the habit row's xmin. In production every stamp and every other write is its
-- own transaction. Here everything shares one transaction, and the cases still tell writes apart only because each
-- stamp runs inside an exception block (a subtransaction with its own xid), while the "answered elsewhere" UPDATE of
-- case 10 runs in the outer transaction. Check case 10 once more with separate transactions after the SQL is applied:
-- create + COMMIT, UPDATE the habit row + COMMIT, remove by key, and the Yes must stay.
BEGIN;

-- Case 16 needs a habit write that fails: a refusing trigger on one synthetic day, rolled back with everything else.
CREATE FUNCTION public.sql_regression_refuse_habit_write() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
    RAISE EXCEPTION 'refused for the regression' USING ERRCODE = 'P0001';
END;
$f$;
CREATE TRIGGER sql_regression_refuse_habit_write
    BEFORE UPDATE OR DELETE ON pds.habit_journal
    FOR EACH ROW
    WHEN (OLD.cycle_date = DATE '2030-01-20')
    EXECUTE FUNCTION public.sql_regression_refuse_habit_write();

DO $$
DECLARE
    k1 uuid := '00000000-0000-4000-8000-000000000001';
    k2 uuid := '00000000-0000-4000-8000-000000000002';
    k3 uuid := '00000000-0000-4000-8000-000000000003';
    v_book bigint;
    v_book2 bigint;
    r jsonb;
    v_status text;
    v_cat text;
    v_count integer;
    v_sid bigint;
BEGIN
    INSERT INTO pds.books (slug, title, total_chapters, status)
    VALUES ('sql-regression-book', 'Synthetic', 3, 'reading') RETURNING book_id INTO v_book;

    -- 1. A keyed create reaching the last chapter commits the session and the finish together.
    r := pds.create_reading_session(k1, v_book, DATE '2026-01-05', 1, 3, NULL, NULL, NULL, NULL, 'manual');
    ASSERT (r->>'finished')::boolean, 'create to the last chapter finishes the book';
    SELECT status INTO v_status FROM pds.books WHERE book_id = v_book;
    ASSERT v_status = 'finished', 'book is finished';

    -- 2. A second create of the same key is refused by the unique index (the app then replays the stored session).
    BEGIN
        PERFORM pds.create_reading_session(k1, v_book, DATE '2026-01-05', 1, 3, NULL, NULL, NULL, NULL, 'manual');
        ASSERT false, 'a repeated key must raise';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    -- 3. Removing by key deletes the session, takes back the finish and records the discard, in one call.
    r := pds.remove_reading_session(NULL, k1, NULL);
    ASSERT (r->>'removed')::boolean, 'the session is removed';
    ASSERT (r->>'unfinished')::boolean, 'the finish it caused is taken back';
    SELECT status INTO v_status FROM pds.books WHERE book_id = v_book;
    ASSERT v_status = 'reading', 'book is back to reading';
    SELECT count(*) INTO v_count FROM pds.reading_sessions WHERE book_id = v_book;
    ASSERT v_count = 0, 'no session left';
    SELECT count(*) INTO v_count FROM pds.reading_session_discards WHERE client_key = k1;
    ASSERT v_count = 1, 'the discard is recorded';

    -- 4. A create of a discarded key is refused (OXR01) and stores nothing, also for a late retry.
    BEGIN
        PERFORM pds.create_reading_session(k1, v_book, DATE '2026-01-05', 1, 3, NULL, NULL, NULL, NULL, 'manual');
        ASSERT false, 'a discarded key must not create';
    EXCEPTION WHEN SQLSTATE 'OXR01' THEN NULL;
    END;
    SELECT count(*) INTO v_count FROM pds.reading_sessions WHERE book_id = v_book;
    ASSERT v_count = 0, 'still nothing stored';

    -- 5. A repeat removal finds nothing and reports the earlier removal (so the caller can replay its cleanup).
    r := pds.remove_reading_session(NULL, k1, NULL);
    ASSERT NOT (r->>'removed')::boolean, 'nothing left to remove';
    ASSERT r->'removal' IS NOT NULL AND r->'removal' <> 'null'::jsonb, 'the earlier removal is reported';

    -- 6. A discard before any create fences the key (the lost-answer case), and removal by id works for keyed sessions.
    r := pds.remove_reading_session(NULL, k2, NULL);
    ASSERT NOT (r->>'removed')::boolean, 'nothing stored for k2';
    BEGIN
        PERFORM pds.create_reading_session(k2, v_book, DATE '2026-01-06', 1, 1, NULL, NULL, NULL, NULL, 'manual');
        ASSERT false, 'k2 was discarded first';
    EXCEPTION WHEN SQLSTATE 'OXR01' THEN NULL;
    END;
    r := pds.create_reading_session(k3, v_book, DATE '2026-01-07', 1, 1, NULL, NULL, NULL, NULL, 'manual');
    r := pds.remove_reading_session((r->'session'->>'session_id')::bigint, NULL, NULL);
    ASSERT (r->>'removed')::boolean, 'removal by id';
    BEGIN
        PERFORM pds.create_reading_session(k3, v_book, DATE '2026-01-07', 1, 1, NULL, NULL, NULL, NULL, 'manual');
        ASSERT false, 'removal by id also fences the key';
    EXCEPTION WHEN SQLSTATE 'OXR01' THEN NULL;
    END;

    -- 7. Argument rules: exactly one of id and key.
    BEGIN
        PERFORM pds.remove_reading_session(NULL, NULL, NULL);
        ASSERT false, 'needs an id or a key';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;

    -- 8. Rollback: a failing create leaves neither the session nor the finish (one transaction per call).
    BEGIN
        PERFORM pds.create_reading_session('00000000-0000-4000-8000-000000000004', v_book, DATE '2026-01-08', 1, -1, NULL, NULL, NULL, NULL, 'manual');
        ASSERT false, 'a check violation must raise';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    SELECT count(*) INTO v_count FROM pds.reading_sessions WHERE client_key = '00000000-0000-4000-8000-000000000004';
    ASSERT v_count = 0, 'nothing stored by a failed create';

    -- Habit cases (Codex T01-R7): a synthetic habit on a synthetic book, on future days (no frozen era, no retrain
    -- signal). Every removal below passes p_habit_created_on = NULL, as a Discard after a lost create answer does.
    INSERT INTO pds.habit_name_map (notion_page_id, habit_name) VALUES ('sql-regression-page', 'SQL regression habit?');
    INSERT INTO pds.books (slug, title, total_chapters, status, habit_name)
    VALUES ('sql-regression-habit-book', 'Synthetic', 30, 'reading', 'SQL regression habit?') RETURNING book_id INTO v_book;

    -- 9. Lost create answer, no habit row before: the create's record decides and the Yes it made goes.
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000009', v_book, DATE '2030-01-10', 1, 1, NULL, NULL, NULL, NULL, 'manual');
    ASSERT (r->>'habit_created')::boolean, 'the create made the habit row';
    r := pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000009', NULL);
    ASSERT (r->>'removed')::boolean AND (r->>'habit_removed')::boolean, 'the Yes the create made is taken back';
    SELECT count(*) INTO v_count FROM pds.habit_journal WHERE cycle_date = DATE '2030-01-10' AND question = 'SQL regression habit?';
    ASSERT v_count = 0, 'no habit row left';
    SELECT count(*) INTO v_count FROM pds.reading_habit_provenance WHERE cycle_date = DATE '2030-01-10' AND question = 'SQL regression habit?';
    ASSERT v_count = 0, 'the record goes with the last session of the day';

    -- 10. Lost create answer, then an independent answer to the habit (a later write gives the row a new version):
    --     the removal keeps that answer.
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000010', v_book, DATE '2030-01-11', 1, 1, NULL, NULL, NULL, NULL, 'manual');
    UPDATE pds.habit_journal SET answer = 'Yes', notes = 'answered elsewhere'
     WHERE cycle_date = DATE '2030-01-11' AND question = 'SQL regression habit?';
    r := pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000010', NULL);
    ASSERT (r->>'removed')::boolean AND NOT (r->>'habit_removed')::boolean, 'an independent answer is kept';
    SELECT count(*) INTO v_count FROM pds.habit_journal
     WHERE cycle_date = DATE '2030-01-11' AND question = 'SQL regression habit?' AND answer = 'Yes';
    ASSERT v_count = 1, 'the independent Yes stays';

    -- 11. Lost create answer over an explicit No: the removal gives the No (and its category) back.
    INSERT INTO pds.habit_journal (cycle_date, question, category, answer)
    VALUES (DATE '2030-01-12', 'SQL regression habit?', 'other', 'No');
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000011', v_book, DATE '2030-01-12', 1, 1, NULL, NULL, NULL, NULL, 'manual');
    ASSERT NOT (r->>'habit_created')::boolean, 'the row existed';
    r := pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000011', NULL);
    ASSERT (r->>'habit_restored')::boolean AND (r->>'habit_removed')::boolean, 'the earlier answer is restored';
    SELECT answer, category INTO v_status, v_cat FROM pds.habit_journal
     WHERE cycle_date = DATE '2030-01-12' AND question = 'SQL regression habit?';
    ASSERT v_status = 'No' AND v_cat = 'other', 'answer No and category other again';

    -- 12. Another session with the same habit on that day keeps the Yes.
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000012', v_book, DATE '2030-01-13', 1, 1, NULL, NULL, NULL, NULL, 'manual');
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000013', v_book, DATE '2030-01-13', 2, 2, NULL, NULL, NULL, NULL, 'manual');
    r := pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000012', NULL);
    ASSERT NOT (r->>'habit_removed')::boolean, 'the other session still holds the Yes';
    SELECT count(*) INTO v_count FROM pds.habit_journal
     WHERE cycle_date = DATE '2030-01-13' AND question = 'SQL regression habit?' AND answer = 'Yes';
    ASSERT v_count = 1, 'Yes stays while another session is on the day';
    -- ... and the last of them going takes it back (the record is per habit row, not per session; round 2).
    r := pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000013', NULL);
    ASSERT (r->>'habit_removed')::boolean, 'the last session of the day takes the Yes back';
    SELECT count(*) INTO v_count FROM pds.habit_journal WHERE cycle_date = DATE '2030-01-13' AND question = 'SQL regression habit?';
    ASSERT v_count = 0, 'no Yes left after both sessions went (first created, then second)';

    -- 13. Two sessions on one day, the second removed first: no Yes left either.
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000014', v_book, DATE '2030-01-14', 1, 1, NULL, NULL, NULL, NULL, 'manual');
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000015', v_book, DATE '2030-01-14', 2, 2, NULL, NULL, NULL, NULL, 'manual');
    r := pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000015', NULL);
    ASSERT NOT (r->>'habit_removed')::boolean, 'the first session still holds the Yes';
    r := pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000014', NULL);
    ASSERT (r->>'habit_removed')::boolean, 'the last one going takes it back';
    SELECT count(*) INTO v_count FROM pds.habit_journal WHERE cycle_date = DATE '2030-01-14' AND question = 'SQL regression habit?';
    ASSERT v_count = 0, 'no Yes left after both sessions went (second first)';

    -- 14. Two sessions over an explicit No, both removed: the No comes back.
    INSERT INTO pds.habit_journal (cycle_date, question, category, answer)
    VALUES (DATE '2030-01-15', 'SQL regression habit?', 'other', 'No');
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000016', v_book, DATE '2030-01-15', 1, 1, NULL, NULL, NULL, NULL, 'manual');
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000017', v_book, DATE '2030-01-15', 2, 2, NULL, NULL, NULL, NULL, 'manual');
    r := pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000016', NULL);
    r := pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000017', NULL);
    SELECT answer, category INTO v_status, v_cat FROM pds.habit_journal
     WHERE cycle_date = DATE '2030-01-15' AND question = 'SQL regression habit?';
    ASSERT v_status = 'No' AND v_cat = 'other', 'the No from before both sessions again';

    -- 15. A move after a replayed create (the browser knows no habit day, p_habit_created_on NULL): the old day's Yes
    --     goes with the session, the new day gets one, and removing it then takes that back too.
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000018', v_book, DATE '2030-01-16', 1, 1, NULL, NULL, NULL, NULL, 'manual');
    v_sid := (r->'session'->>'session_id')::bigint;
    r := pds.move_reading_session(v_sid, v_book, DATE '2030-01-17', 1, 1, NULL, NULL, NULL, NULL, NULL);
    ASSERT (r->>'moved')::boolean AND (r->>'habit_marked')::boolean AND (r->>'habit_removed')::boolean, 'moved with its Yes';
    ASSERT r->'session'->>'session_date' = '2030-01-17', 'the session is on its new day';
    SELECT count(*) INTO v_count FROM pds.habit_journal WHERE cycle_date = DATE '2030-01-16' AND question = 'SQL regression habit?';
    ASSERT v_count = 0, 'no Yes left on the day the session left';
    r := pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000018', NULL);
    ASSERT (r->>'habit_removed')::boolean, 'the Yes of the new day goes with the session';
    SELECT count(*) INTO v_count FROM pds.habit_journal WHERE cycle_date = DATE '2030-01-17' AND question = 'SQL regression habit?';
    ASSERT v_count = 0, 'no Yes left on the new day either';
    r := pds.move_reading_session(987654321, v_book, DATE '2030-01-17', 1, 1, NULL, NULL, NULL, NULL, NULL);
    ASSERT NOT (r->>'moved')::boolean, 'a session that no longer exists is not moved';

    -- 16. A habit part that fails rolls the whole removal back (and it is reported): the session is still stored, no
    --     discard or removal is on record, so a retry can finish it.
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000019', v_book, DATE '2030-01-20', 1, 1, NULL, NULL, NULL, NULL, 'manual');
    BEGIN
        PERFORM pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000019', NULL);
        ASSERT false, 'a failed habit part must raise';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
    END;
    SELECT count(*) INTO v_count FROM pds.reading_sessions WHERE client_key = '00000000-0000-4000-8000-000000000019';
    ASSERT v_count = 1, 'the session is still stored';
    SELECT count(*) INTO v_count FROM pds.reading_session_discards WHERE client_key = '00000000-0000-4000-8000-000000000019';
    ASSERT v_count = 0, 'no discard recorded either';
    SELECT count(*) INTO v_count FROM pds.reading_session_removals WHERE client_key = '00000000-0000-4000-8000-000000000019';
    ASSERT v_count = 0, 'no removal on record';

    -- 17. Two sessions reach the last chapter on different days and are removed oldest first: the finish day moves to
    --     the remaining one, then the book goes back to reading when that one goes (it used to stay finished).
    INSERT INTO pds.books (slug, title, total_chapters, status)
    VALUES ('sql-regression-finish-book', 'Synthetic', 3, 'reading') RETURNING book_id INTO v_book;
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000020', v_book, DATE '2030-02-01', 1, 3, NULL, NULL, NULL, NULL, 'manual');
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000021', v_book, DATE '2030-02-02', 3, 3, NULL, NULL, NULL, NULL, 'manual');
    r := pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000020', NULL);
    ASSERT NOT (r->>'unfinished')::boolean, 'still finished: another session reaches the last chapter';
    SELECT status INTO v_status FROM pds.books WHERE book_id = v_book;
    ASSERT v_status = 'finished', 'book stays finished';
    ASSERT (SELECT finished_on FROM pds.books WHERE book_id = v_book) = DATE '2030-02-02', 'the finish day moved to the remaining session';
    r := pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000021', NULL);
    ASSERT (r->>'unfinished')::boolean, 'the last finishing session going takes the finish back';
    SELECT status INTO v_status FROM pds.books WHERE book_id = v_book;
    ASSERT v_status = 'reading', 'book is back to reading';

    -- 18. A habit row that already exists is recorded as existing (the stamp tells insertion from conflict).
    INSERT INTO pds.books (slug, title, total_chapters, status, habit_name)
    VALUES ('sql-regression-habit-book-2', 'Synthetic', 30, 'reading', 'SQL regression habit?') RETURNING book_id INTO v_book;
    INSERT INTO pds.habit_journal (cycle_date, question, category, answer)
    VALUES (DATE '2030-02-10', 'SQL regression habit?', 'other', 'No');
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000022', v_book, DATE '2030-02-10', 1, 1, NULL, NULL, NULL, NULL, 'manual');
    ASSERT NOT (r->>'habit_created')::boolean, 'the row was already there';
    r := pds.remove_reading_session(NULL, '00000000-0000-4000-8000-000000000022', NULL);
    SELECT answer INTO v_status FROM pds.habit_journal WHERE cycle_date = DATE '2030-02-10' AND question = 'SQL regression habit?';
    ASSERT v_status = 'No', 'the earlier answer comes back';

    -- 19. An edit takes back the finish it no longer holds in its own transaction, so a retry of a call whose answer
    --     was lost (the same values again) finds nothing left to change (Codex review of PR 376, round 4).
    INSERT INTO pds.books (slug, title, total_chapters, status)
    VALUES ('sql-regression-edit-book-a', 'Synthetic', 3, 'reading') RETURNING book_id INTO v_book;
    INSERT INTO pds.books (slug, title, total_chapters, status)
    VALUES ('sql-regression-edit-book-b', 'Synthetic', 3, 'reading') RETURNING book_id INTO v_book2;
    r := pds.create_reading_session('00000000-0000-4000-8000-000000000023', v_book, DATE '2030-03-01', 1, 3, NULL, NULL, NULL, NULL, 'manual');
    v_sid := (r->'session'->>'session_id')::bigint;
    r := pds.move_reading_session(v_sid, v_book2, DATE '2030-03-01', 1, 2, NULL, NULL, NULL, NULL, NULL);
    ASSERT (r->>'unfinished')::boolean, 'moved to another book below its end: the first book is unfinished';
    SELECT status INTO v_status FROM pds.books WHERE book_id = v_book;
    ASSERT v_status = 'reading', 'in the same call';
    r := pds.move_reading_session(v_sid, v_book2, DATE '2030-03-01', 1, 2, NULL, NULL, NULL, NULL, NULL);
    ASSERT NOT (r->>'unfinished')::boolean AND NOT (r->>'finished')::boolean, 'the replay changes nothing';
    -- The same session reaching the last chapter of its new book finishes that one, moving it a day moves the finish
    -- day, and editing it below the end on that day takes the finish back.
    r := pds.move_reading_session(v_sid, v_book2, DATE '2030-03-01', 1, 3, NULL, NULL, NULL, NULL, NULL);
    ASSERT (r->>'finished')::boolean AND r->'book'->>'status' = 'finished', 'finished in the edit';
    r := pds.move_reading_session(v_sid, v_book2, DATE '2030-03-02', 1, 3, NULL, NULL, NULL, NULL, NULL);
    ASSERT (SELECT finished_on FROM pds.books WHERE book_id = v_book2) = DATE '2030-03-02', 'the finish day followed';
    r := pds.move_reading_session(v_sid, v_book2, DATE '2030-03-02', 1, 2, NULL, NULL, NULL, NULL, NULL);
    ASSERT (r->>'unfinished')::boolean AND r->'book'->>'status' = 'reading', 'below the end: back to reading';
    SELECT status INTO v_status FROM pds.books WHERE book_id = v_book2;
    ASSERT v_status = 'reading', 'stored so';
END $$;

ROLLBACK;
