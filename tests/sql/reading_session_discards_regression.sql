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
BEGIN;

DO $$
DECLARE
    k1 uuid := '00000000-0000-4000-8000-000000000001';
    k2 uuid := '00000000-0000-4000-8000-000000000002';
    k3 uuid := '00000000-0000-4000-8000-000000000003';
    v_book bigint;
    r jsonb;
    v_status text;
    v_count integer;
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
END $$;

ROLLBACK;
