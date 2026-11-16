-- Behaviour check for sql/phone_usage_completeness.sql (audit PIPE-11).
--
-- SUPABASE BRANCH OR LOCAL POSTGRES ONLY. NEVER RUN THIS ON PRODUCTION. It writes synthetic Screen Time hours,
-- items, chunks and runs for a made-up device in a made-up year. Everything happens in ONE transaction that ends
-- in ROLLBACK, but production must not see even that: the guard at the top refuses to run on a database that holds
-- any Screen Time hour.
--
-- Run after sql/phone_usage_schema.sql and sql/phone_usage_completeness.sql are applied to the branch, with
-- privileged SQL access. The answer is one JSON object of booleans; any failed expectation raises instead.
--
-- Cases (the acceptance criteria of PIPE-11):
--   1. an upload without run metadata (an older app build) is stored and is never verified: completeness 'unknown'
--   2. a watchdog stop after non-empty data (stream_ended false) verifies nothing: 'stream_open', day 'partial'
--   3. a chunk that never arrived (failure, or the app stopped by iOS) verifies nothing: 'receiving'
--   4. chunks that disagree verify nothing: 'inconsistent'
--   5. a complete run verifies the hours it owns that ended before the export, removes items an hour no longer
--      lists, and the whole day reads export_complete; the hour still in progress stays unverified
--   6. finalizing again (a retried chunk) changes nothing
--   7. a verified hour is a snapshot: an ordinary upload cannot change it or its items
--   8. an export read earlier cannot replace an hour written by a later one
--   9. an item from a run applies only while that run owns the hour
--  10. an hour whose items do not all belong to the run is not verified; ordinary writes cannot set verified_*
--  11. the window check: a pre-sleep window with an unverified hour is not complete
--  12. anon and authenticated cannot call the functions or read the new tables
--  13. a later COMPLETE export of an already verified hour is staged, and its finalization replaces the snapshot
--      (corrected total, items it no longer lists are gone, the old run's copy is not mixed in)
--  14. a later export that never completes (stream_ended false) leaves the verified snapshot as it was
--  15. an export read before the snapshot's is not even staged
--  16. a stream that ends cleanly from a STALE source (Apple's own last update is before the export time) verifies
--      only the hours that ended by that update; the hours after it stay unverified, and a window reaching past it
--      is not complete even where no hour row exists (unknown, never "no usage"); a run with no source time covers
--      nothing; chunks that disagree on the source time are inconsistent
--  17. a legacy item (no run id) cannot enter an hour a run owns or an hour that is verified
--
-- Not scriptable in one transaction (run by hand on the branch with two sessions after the cases above pass):
--  A. session 1: BEGIN; the upsert of case 13 for an hour that run X owns and has not verified, but with run Y;
--     do not commit. Session 2: finalize run X. It must wait on the hour (its lock statement), and after session 1
--     commits it must NOT verify that hour for X (the hour now belongs to Y: hours_verified excludes it).
--  B. session 2 first: finalize run X inside an open transaction (BEGIN; SELECT pds.finalize_phone_usage_run(...);),
--     then session 1 upserts the same hour with run Y. The upsert must wait, and after session 2 commits it must be
--     staged or ignored (the hour is verified), never applied.
--  C. the item guard locks its hour (FOR SHARE) before it reads whether the hour is verified. Run X owns hour H,
--     unverified, with last_run_item_count = 1 and one item of X on it.
--     Session 1: BEGIN; INSERT an item for H with run id NULL (or run Y, or run X with a new identifier); do not commit.
--        The item is ignored (the hour belongs to X), the trigger has already read and locked H.
--     Session 2: BEGIN; SELECT pds.finalize_phone_usage_run(...) for X. It must WAIT on its lock statement until
--        session 1 commits, then verify H, and H must have exactly the item it had before (nothing from session 1).
--  D. the same, the other way round. Session 2 first: BEGIN; SELECT pds.finalize_phone_usage_run(...) for X, do not
--     commit. Session 1: INSERT an item for H with any run id. The insert must WAIT (the trigger's share lock), and
--     after session 2 commits it must be ignored: H is verified and its items are exactly the snapshot's. Before the
--     lock existed the trigger read H unverified, the finalization verified it, and the item landed in the snapshot.
BEGIN;
SET LOCAL statement_timeout = '60s';
DO $check$
DECLARE
    initial_role text := current_user;
    dev   constant text := 'zz-synthetic-check';
    -- Behavioral day 2001-02-03 runs 2001-02-03 11:00Z to 2001-02-04 11:00Z (06:00 ET to 06:00 ET).
    d0    constant timestamptz := '2001-02-03 11:00:00+00';
    wstart constant timestamptz := '2001-02-03 05:00:00+00';   -- local midnight
    wend   constant timestamptz := '2001-02-04 15:30:00+00';   -- export read at 10:30 ET the next morning
    r_watch constant uuid := '00000000-0000-4000-8000-0000000c0001';
    r_miss  constant uuid := '00000000-0000-4000-8000-0000000c0002';
    r_odd   constant uuid := '00000000-0000-4000-8000-0000000c0003';
    r_ok    constant uuid := '00000000-0000-4000-8000-0000000c0004';
    r_old   constant uuid := '00000000-0000-4000-8000-0000000c0005';
    r_a     constant uuid := '00000000-0000-4000-8000-0000000c0006';
    r_b     constant uuid := '00000000-0000-4000-8000-0000000c0007';
    r_c     constant uuid := '00000000-0000-4000-8000-0000000c0008';
    r_d     constant uuid := '00000000-0000-4000-8000-0000000c0009';
    r_e     constant uuid := '00000000-0000-4000-8000-0000000c000a';
    r_f     constant uuid := '00000000-0000-4000-8000-0000000c000b';
    r_g     constant uuid := '00000000-0000-4000-8000-0000000c000c';
    r_h     constant uuid := '00000000-0000-4000-8000-0000000c000d';
    r_i     constant uuid := '00000000-0000-4000-8000-0000000c000e';
    wend2   constant timestamptz := '2001-02-05 15:30:00+00';   -- a later export, the next day
    ans   jsonb;
    n     int;
    v     numeric;
    h     int;
BEGIN
    IF EXISTS (SELECT 1 FROM pds.phone_usage_segments) THEN
        RAISE EXCEPTION 'refusing to run: this database holds Screen Time hours. Run this only on a Supabase branch or a local copy without real data.';
    END IF;

    -- 12 (shape): invoker function, service role only, RLS on the new tables.
    IF (SELECT prosecdef FROM pg_proc WHERE oid = 'pds.finalize_phone_usage_run(text,uuid)'::regprocedure) THEN
        RAISE EXCEPTION 'finalize_phone_usage_run is SECURITY DEFINER';
    END IF;
    IF has_function_privilege('anon', 'pds.finalize_phone_usage_run(text,uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'pds.finalize_phone_usage_run(text,uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anon or authenticated may finalize a run';
    END IF;
    IF has_table_privilege('anon', 'pds.phone_usage_sync_runs', 'SELECT')
       OR has_table_privilege('authenticated', 'pds.phone_usage_sync_chunks', 'SELECT') THEN
        RAISE EXCEPTION 'a browser role can read the run tables';
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'pds.phone_usage_sync_runs'::regclass)
       OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'pds.phone_usage_sync_chunks'::regclass)
       OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'pds.phone_usage_pending_hours'::regclass) THEN
        RAISE EXCEPTION 'RLS is off on a run or staging table';
    END IF;
    IF has_table_privilege('anon', 'pds.phone_usage_pending_hours', 'SELECT')
       OR has_table_privilege('authenticated', 'pds.phone_usage_pending_hours', 'SELECT') THEN
        RAISE EXCEPTION 'a browser role can read the staging table';
    END IF;

    EXECUTE 'SET LOCAL ROLE service_role';

    -- 1. An older build: 24 hours, no run metadata.
    INSERT INTO pds.phone_usage_segments (device, segment_start, segment_end, total_seconds, synced_at)
    SELECT dev, d0 + make_interval(hours => g), d0 + make_interval(hours => g + 1), 600, wend
      FROM generate_series(0, 23) g;
    INSERT INTO pds.phone_usage_items (device, segment_start, kind, identifier, seconds)
    VALUES (dev, d0, 'app', 'com.example.stale', 300), (dev, d0, 'app', 'com.example.kept', 300);
    IF (SELECT completeness FROM pds.phone_usage_daily WHERE behavioral_date = '2001-02-03') IS DISTINCT FROM 'unknown'
       OR (SELECT export_complete FROM pds.phone_usage_daily WHERE behavioral_date = '2001-02-03') THEN
        RAISE EXCEPTION 'legacy day: expected unknown, not complete';
    END IF;

    -- 2. Watchdog stop: one chunk, all hours, stream_ended false.
    UPDATE pds.phone_usage_segments SET last_run_id = r_watch, last_run_item_count = 0, last_export_at = wend WHERE device = dev;
    INSERT INTO pds.phone_usage_sync_chunks (device, run_id, chunk_index, chunk_count, window_start, window_end, source_updated_at, stream_ended,
                                             run_segment_count, segment_count, first_segment_start, last_segment_end)
    VALUES (dev, r_watch, 0, 1, wstart, wend, wend, false, 24, 24, d0, d0 + INTERVAL '24 hours');
    ans := pds.finalize_phone_usage_run(dev, r_watch);
    IF ans ->> 'status' <> 'stream_open' OR (ans ->> 'hours_verified')::int <> 0 THEN
        RAISE EXCEPTION 'watchdog stop: %', ans;
    END IF;
    IF EXISTS (SELECT 1 FROM pds.phone_usage_segments WHERE device = dev AND verified_at IS NOT NULL) THEN
        RAISE EXCEPTION 'watchdog stop verified an hour';
    END IF;
    IF (SELECT completeness FROM pds.phone_usage_daily WHERE behavioral_date = '2001-02-03') IS DISTINCT FROM 'partial' THEN
        RAISE EXCEPTION 'watchdog day: expected partial';
    END IF;

    -- 3. Missing chunk: two chunks claimed, one received.
    INSERT INTO pds.phone_usage_sync_chunks (device, run_id, chunk_index, chunk_count, window_start, window_end, source_updated_at, stream_ended,
                                             run_segment_count, segment_count, first_segment_start, last_segment_end)
    VALUES (dev, r_miss, 0, 2, wstart, wend, wend, true, 24, 12, d0, d0 + INTERVAL '12 hours');
    ans := pds.finalize_phone_usage_run(dev, r_miss);
    IF ans ->> 'status' <> 'receiving' OR (ans ->> 'hours_verified')::int <> 0 THEN
        RAISE EXCEPTION 'missing chunk: %', ans;
    END IF;

    -- 4. Chunks that disagree on the window.
    INSERT INTO pds.phone_usage_sync_chunks (device, run_id, chunk_index, chunk_count, window_start, window_end, source_updated_at, stream_ended,
                                             run_segment_count, segment_count, first_segment_start, last_segment_end)
    VALUES (dev, r_odd, 0, 2, wstart, wend, wend, true, 24, 12, d0, d0 + INTERVAL '12 hours'),
           (dev, r_odd, 1, 2, wstart, wend + INTERVAL '1 hour', wend + INTERVAL '1 hour', true, 24, 12, d0 + INTERVAL '12 hours', d0 + INTERVAL '24 hours');
    ans := pds.finalize_phone_usage_run(dev, r_odd);
    IF ans ->> 'status' <> 'inconsistent' THEN RAISE EXCEPTION 'inconsistent chunks: %', ans; END IF;

    -- 5. A complete run: 24 whole hours plus the hour in progress at export time (ends after wend).
    UPDATE pds.phone_usage_segments SET last_run_id = r_ok, last_run_item_count = 0, last_export_at = wend WHERE device = dev;
    INSERT INTO pds.phone_usage_segments (device, segment_start, segment_end, total_seconds, synced_at, last_run_id, last_run_item_count, last_export_at)
    VALUES (dev, '2001-02-04 15:00:00+00', '2001-02-04 16:00:00+00', 60, wend, r_ok, 0, wend);
    -- The first hour lists one item now (com.example.kept); com.example.stale is gone from it.
    UPDATE pds.phone_usage_segments SET last_run_item_count = 1 WHERE device = dev AND segment_start = d0;
    UPDATE pds.phone_usage_items SET last_run_id = r_ok, seconds = 420 WHERE device = dev AND segment_start = d0 AND identifier = 'com.example.kept';
    INSERT INTO pds.phone_usage_sync_chunks (device, run_id, chunk_index, chunk_count, window_start, window_end, source_updated_at, stream_ended,
                                             run_segment_count, segment_count, first_segment_start, last_segment_end)
    VALUES (dev, r_ok, 0, 1, wstart, wend, wend, true, 25, 25, d0, '2001-02-04 16:00:00+00');
    ans := pds.finalize_phone_usage_run(dev, r_ok);
    IF ans ->> 'status' <> 'complete' OR (ans ->> 'hours_verified')::int <> 24 OR (ans ->> 'items_removed')::int <> 1 THEN
        RAISE EXCEPTION 'complete run: %', ans;
    END IF;
    IF EXISTS (SELECT 1 FROM pds.phone_usage_items WHERE device = dev AND identifier = 'com.example.stale') THEN
        RAISE EXCEPTION 'a verified hour kept an item its export no longer lists';
    END IF;
    IF (SELECT verified_at FROM pds.phone_usage_segments WHERE device = dev AND segment_start = '2001-02-04 15:00:00+00') IS NOT NULL THEN
        RAISE EXCEPTION 'the hour in progress at export time was verified';
    END IF;
    IF NOT (SELECT export_complete FROM pds.phone_usage_daily WHERE behavioral_date = '2001-02-03')
       OR (SELECT completeness FROM pds.phone_usage_daily WHERE behavioral_date = '2001-02-03') <> 'complete'
       OR (SELECT hours_verified FROM pds.phone_usage_daily WHERE behavioral_date = '2001-02-03') <> 24 THEN
        RAISE EXCEPTION 'complete day not reported complete';
    END IF;

    -- 6. Finalize again: nothing changes.
    ans := pds.finalize_phone_usage_run(dev, r_ok);
    IF ans ->> 'status' <> 'complete' OR NOT (ans ->> 'already')::boolean THEN RAISE EXCEPTION 'repeat: %', ans; END IF;

    -- 7. Snapshot: an ordinary upload over a verified hour changes neither it nor its items.
    INSERT INTO pds.phone_usage_segments AS s (device, segment_start, segment_end, total_seconds, synced_at, last_run_id)
    VALUES (dev, d0, d0 + INTERVAL '1 hour', 9, now(), NULL)
    ON CONFLICT (device, segment_start) DO UPDATE SET total_seconds = EXCLUDED.total_seconds, last_run_id = EXCLUDED.last_run_id;
    SELECT total_seconds INTO v FROM pds.phone_usage_segments WHERE device = dev AND segment_start = d0;
    IF v <> 600 THEN RAISE EXCEPTION 'a verified hour was overwritten (%)', v; END IF;
    INSERT INTO pds.phone_usage_items (device, segment_start, kind, identifier, seconds)
    VALUES (dev, d0, 'app', 'com.example.new', 5);
    UPDATE pds.phone_usage_items SET seconds = 1 WHERE device = dev AND segment_start = d0 AND identifier = 'com.example.kept';
    IF EXISTS (SELECT 1 FROM pds.phone_usage_items WHERE device = dev AND identifier = 'com.example.new')
       OR (SELECT seconds FROM pds.phone_usage_items WHERE device = dev AND segment_start = d0 AND identifier = 'com.example.kept') <> 420 THEN
        RAISE EXCEPTION 'a verified hour''s items changed';
    END IF;

    -- 8. An export read earlier cannot replace an hour a later one wrote (the unverified hour in progress).
    UPDATE pds.phone_usage_segments SET total_seconds = 5, last_run_id = r_old, last_export_at = wend - INTERVAL '1 day'
     WHERE device = dev AND segment_start = '2001-02-04 15:00:00+00';
    SELECT total_seconds INTO v FROM pds.phone_usage_segments WHERE device = dev AND segment_start = '2001-02-04 15:00:00+00';
    IF v <> 60 THEN RAISE EXCEPTION 'an older export replaced a newer hour (%)', v; END IF;

    -- 9. An item of run A is not mixed into an hour run B owns.
    INSERT INTO pds.phone_usage_segments (device, segment_start, segment_end, total_seconds, synced_at, last_run_id, last_run_item_count, last_export_at)
    VALUES (dev, '2001-02-05 12:00:00+00', '2001-02-05 13:00:00+00', 100, now(), r_b, 0, wend + INTERVAL '1 day');
    INSERT INTO pds.phone_usage_items (device, segment_start, kind, identifier, seconds, last_run_id)
    VALUES (dev, '2001-02-05 12:00:00+00', 'app', 'com.example.other', 50, r_a);
    IF EXISTS (SELECT 1 FROM pds.phone_usage_items WHERE device = dev AND identifier = 'com.example.other') THEN
        RAISE EXCEPTION 'an item of another run was mixed into the hour';
    END IF;

    -- 10. Item count mismatch: the hour claims 2 items, only 1 is the run's, so it is not verified.
    INSERT INTO pds.phone_usage_items (device, segment_start, kind, identifier, seconds, last_run_id)
    VALUES (dev, '2001-02-05 12:00:00+00', 'app', 'com.example.one', 50, r_b);
    UPDATE pds.phone_usage_segments SET last_run_item_count = 2 WHERE device = dev AND segment_start = '2001-02-05 12:00:00+00';
    INSERT INTO pds.phone_usage_sync_chunks (device, run_id, chunk_index, chunk_count, window_start, window_end, source_updated_at, stream_ended,
                                             run_segment_count, segment_count, first_segment_start, last_segment_end)
    VALUES (dev, r_b, 0, 1, '2001-02-05 05:00:00+00', wend + INTERVAL '1 day', wend + INTERVAL '1 day', true, 1, 1,
            '2001-02-05 12:00:00+00', '2001-02-05 13:00:00+00');
    ans := pds.finalize_phone_usage_run(dev, r_b);
    IF ans ->> 'status' <> 'complete' OR (ans ->> 'hours_verified')::int <> 0 THEN RAISE EXCEPTION 'count mismatch: %', ans; END IF;
    -- Ordinary writes cannot set the verification columns.
    INSERT INTO pds.phone_usage_segments (device, segment_start, segment_end, total_seconds, synced_at, verified_at, verified_run_id)
    VALUES (dev, '2001-02-06 12:00:00+00', '2001-02-06 13:00:00+00', 1, now(), now(), r_a);
    IF (SELECT verified_at FROM pds.phone_usage_segments WHERE device = dev AND segment_start = '2001-02-06 12:00:00+00') IS NOT NULL THEN
        RAISE EXCEPTION 'an ordinary insert set verified_at';
    END IF;

    -- 11. The window check: the hour in progress at export (unverified) makes its window incomplete.
    IF pds.phone_usage_window_complete('2001-02-04 14:30:00+00', '2001-02-04 15:30:00+00') THEN
        RAISE EXCEPTION 'a window with an unverified hour reads complete';
    END IF;
    IF NOT pds.phone_usage_window_complete('2001-02-04 01:00:00+00', '2001-02-04 02:00:00+00') THEN
        RAISE EXCEPTION 'a verified window inside a complete run reads incomplete';
    END IF;
    IF pds.phone_usage_window_complete(NULL, '2001-02-04 02:00:00+00') THEN
        RAISE EXCEPTION 'a window without a start reads complete';
    END IF;

    -- 13. A later complete export corrects a verified hour. Hour d0 is verified by r_ok (600 s, one item at 420 s,
    --     export read at wend). Run r_c, read a day later, uploads it with 700 s and the item at 690 s.
    INSERT INTO pds.phone_usage_segments AS s (device, segment_start, segment_end, total_seconds, synced_at, last_run_id, last_run_item_count, last_export_at)
    VALUES (dev, d0, d0 + INTERVAL '1 hour', 700, now(), r_c, 1, wend2)
    ON CONFLICT (device, segment_start) DO UPDATE SET segment_end = EXCLUDED.segment_end, total_seconds = EXCLUDED.total_seconds,
        synced_at = EXCLUDED.synced_at, last_run_id = EXCLUDED.last_run_id, last_run_item_count = EXCLUDED.last_run_item_count,
        last_export_at = EXCLUDED.last_export_at;
    INSERT INTO pds.phone_usage_items (device, segment_start, kind, identifier, seconds, last_run_id)
    VALUES (dev, d0, 'app', 'com.example.kept', 690, r_c)
    ON CONFLICT (device, segment_start, kind, identifier) DO UPDATE SET seconds = EXCLUDED.seconds, last_run_id = EXCLUDED.last_run_id;
    SELECT total_seconds INTO v FROM pds.phone_usage_segments WHERE device = dev AND segment_start = d0;
    IF v <> 600 OR (SELECT seconds FROM pds.phone_usage_items WHERE device = dev AND segment_start = d0 AND identifier = 'com.example.kept') <> 420 THEN
        RAISE EXCEPTION 'a later run changed the verified snapshot before it completed (%)', v;
    END IF;
    IF (SELECT count(*) FROM pds.phone_usage_pending_hours WHERE device = dev AND run_id = r_c AND segment_start = d0) <> 1
       OR (SELECT count(*) FROM pds.phone_usage_pending_hours h, jsonb_object_keys(h.items) WHERE h.device = dev AND h.run_id = r_c) <> 1 THEN
        RAISE EXCEPTION 'the later run hour and item were not staged';
    END IF;
    INSERT INTO pds.phone_usage_sync_chunks (device, run_id, chunk_index, chunk_count, window_start, window_end, source_updated_at, stream_ended,
                                             run_segment_count, segment_count, first_segment_start, last_segment_end)
    VALUES (dev, r_c, 0, 1, wstart, wend2, wend2, true, 1, 1, d0, d0 + INTERVAL '1 hour');
    ans := pds.finalize_phone_usage_run(dev, r_c);
    IF ans ->> 'status' <> 'complete' OR (ans ->> 'hours_replaced')::int <> 1 OR (ans ->> 'hours_verified')::int <> 1 THEN
        RAISE EXCEPTION 'correction: %', ans;
    END IF;
    SELECT total_seconds INTO v FROM pds.phone_usage_segments
     WHERE device = dev AND segment_start = d0 AND verified_run_id = r_c AND verified_export_at = wend2 AND last_run_id = r_c;
    IF v IS DISTINCT FROM 700 THEN RAISE EXCEPTION 'the verified hour was not replaced by the later complete export (%)', v; END IF;
    IF (SELECT count(*) FROM pds.phone_usage_items WHERE device = dev AND segment_start = d0) <> 1
       OR (SELECT seconds FROM pds.phone_usage_items WHERE device = dev AND segment_start = d0 AND last_run_id = r_c) IS DISTINCT FROM 690 THEN
        RAISE EXCEPTION 'the replaced hour kept an item of the old snapshot';
    END IF;
    IF EXISTS (SELECT 1 FROM pds.phone_usage_pending_hours WHERE device = dev AND run_id = r_c) THEN
        RAISE EXCEPTION 'a settled run left staged hours behind';
    END IF;

    -- 14. A later export that never completes (the watchdog stopped Apple's stream) leaves the snapshot as it is.
    INSERT INTO pds.phone_usage_segments AS s (device, segment_start, segment_end, total_seconds, synced_at, last_run_id, last_run_item_count, last_export_at)
    VALUES (dev, d0, d0 + INTERVAL '1 hour', 5, now(), r_d, 0, wend2 + INTERVAL '1 day')
    ON CONFLICT (device, segment_start) DO UPDATE SET segment_end = EXCLUDED.segment_end, total_seconds = EXCLUDED.total_seconds,
        synced_at = EXCLUDED.synced_at, last_run_id = EXCLUDED.last_run_id, last_run_item_count = EXCLUDED.last_run_item_count,
        last_export_at = EXCLUDED.last_export_at;
    INSERT INTO pds.phone_usage_sync_chunks (device, run_id, chunk_index, chunk_count, window_start, window_end, source_updated_at, stream_ended,
                                             run_segment_count, segment_count, first_segment_start, last_segment_end)
    VALUES (dev, r_d, 0, 1, wstart, wend2 + INTERVAL '1 day', wend2 + INTERVAL '1 day', false, 1, 1, d0, d0 + INTERVAL '1 hour');
    ans := pds.finalize_phone_usage_run(dev, r_d);
    IF ans ->> 'status' <> 'stream_open' OR (ans ->> 'hours_verified')::int <> 0 THEN RAISE EXCEPTION 'stopped later run: %', ans; END IF;
    SELECT total_seconds INTO v FROM pds.phone_usage_segments WHERE device = dev AND segment_start = d0 AND verified_run_id = r_c;
    IF v IS DISTINCT FROM 700 THEN RAISE EXCEPTION 'an incomplete later run replaced the snapshot (%)', v; END IF;

    -- 15. An export read before the snapshot's is not staged.
    INSERT INTO pds.phone_usage_segments AS s (device, segment_start, segment_end, total_seconds, synced_at, last_run_id, last_run_item_count, last_export_at)
    VALUES (dev, d0, d0 + INTERVAL '1 hour', 1, now(), r_e, 0, wend - INTERVAL '1 day')
    ON CONFLICT (device, segment_start) DO UPDATE SET total_seconds = EXCLUDED.total_seconds, last_run_id = EXCLUDED.last_run_id,
        last_export_at = EXCLUDED.last_export_at;
    IF EXISTS (SELECT 1 FROM pds.phone_usage_pending_hours WHERE device = dev AND run_id = r_e) THEN
        RAISE EXCEPTION 'an older export was staged';
    END IF;

    -- 16. A clean stream from a stale source. Day 2001-03-03, hours 12:00, 13:00 and 14:00 (UTC) exist, the export was
    --     read at 16:00 but Apple's data was last updated at 13:30: only the 12:00 hour ended by then.
    INSERT INTO pds.phone_usage_segments (device, segment_start, segment_end, total_seconds, synced_at, last_run_id, last_run_item_count, last_export_at)
    SELECT dev, '2001-03-03 12:00:00+00'::timestamptz + make_interval(hours => g),
           '2001-03-03 13:00:00+00'::timestamptz + make_interval(hours => g), 60, now(), r_f, 0, '2001-03-03 13:30:00+00'::timestamptz
      FROM generate_series(0, 2) g;
    INSERT INTO pds.phone_usage_sync_chunks (device, run_id, chunk_index, chunk_count, window_start, window_end, source_updated_at, stream_ended,
                                             run_segment_count, segment_count, first_segment_start, last_segment_end)
    VALUES (dev, r_f, 0, 1, '2001-03-03 05:00:00+00', '2001-03-03 16:00:00+00', '2001-03-03 13:30:00+00', true, 3, 3,
            '2001-03-03 12:00:00+00', '2001-03-03 15:00:00+00');
    ans := pds.finalize_phone_usage_run(dev, r_f);
    IF ans ->> 'status' <> 'complete' OR (ans ->> 'hours_verified')::int <> 1 THEN
        RAISE EXCEPTION 'stale source: only the hour that ended by the source update may be verified: %', ans;
    END IF;
    IF (ans ->> 'coverage_end')::timestamptz <> '2001-03-03 13:30:00+00'::timestamptz THEN
        RAISE EXCEPTION 'stale source: coverage end is not the source update: %', ans;
    END IF;
    IF (SELECT verified_at FROM pds.phone_usage_segments WHERE device = dev AND segment_start = '2001-03-03 13:00:00+00') IS NOT NULL THEN
        RAISE EXCEPTION 'an hour the stale source never saw was verified';
    END IF;
    IF NOT pds.phone_usage_window_complete('2001-03-03 12:15:00+00', '2001-03-03 12:45:00+00') THEN
        RAISE EXCEPTION 'a window the stale source did cover reads incomplete';
    END IF;
    IF pds.phone_usage_window_complete('2001-03-03 12:15:00+00', '2001-03-03 13:45:00+00') THEN
        RAISE EXCEPTION 'a window reaching past the source update reads complete';
    END IF;
    IF pds.phone_usage_window_complete('2001-03-03 15:00:00+00', '2001-03-03 15:30:00+00') THEN
        RAISE EXCEPTION 'a window with no hour rows past the source update reads complete (missing hours are unknown, not empty)';
    END IF;
    -- No source time at all: nothing is covered.
    INSERT INTO pds.phone_usage_segments (device, segment_start, segment_end, total_seconds, synced_at, last_run_id, last_run_item_count, last_export_at)
    VALUES (dev, '2001-03-04 12:00:00+00', '2001-03-04 13:00:00+00', 60, now(), r_g, 0, '2001-03-04 16:00:00+00');
    INSERT INTO pds.phone_usage_sync_chunks (device, run_id, chunk_index, chunk_count, window_start, window_end, stream_ended,
                                             run_segment_count, segment_count, first_segment_start, last_segment_end)
    VALUES (dev, r_g, 0, 1, '2001-03-04 05:00:00+00', '2001-03-04 16:00:00+00', true, 1, 1,
            '2001-03-04 12:00:00+00', '2001-03-04 13:00:00+00');
    ans := pds.finalize_phone_usage_run(dev, r_g);
    IF (ans ->> 'hours_verified')::int <> 0 THEN RAISE EXCEPTION 'a run with no source time verified an hour: %', ans; END IF;
    -- Chunks that disagree on the source time describe different runs.
    INSERT INTO pds.phone_usage_sync_chunks (device, run_id, chunk_index, chunk_count, window_start, window_end, source_updated_at, stream_ended,
                                             run_segment_count, segment_count, first_segment_start, last_segment_end)
    VALUES (dev, r_h, 0, 2, '2001-03-05 05:00:00+00', '2001-03-05 16:00:00+00', '2001-03-05 15:00:00+00', true, 2, 1,
            '2001-03-05 12:00:00+00', '2001-03-05 13:00:00+00'),
           (dev, r_h, 1, 2, '2001-03-05 05:00:00+00', '2001-03-05 16:00:00+00', '2001-03-05 14:00:00+00', true, 2, 1,
            '2001-03-05 13:00:00+00', '2001-03-05 14:00:00+00');
    ans := pds.finalize_phone_usage_run(dev, r_h);
    IF ans ->> 'status' <> 'inconsistent' THEN RAISE EXCEPTION 'chunks that disagree on the source time: %', ans; END IF;

    -- 17. An item with no run id (an older app build) is not mixed into an hour a run owns, or into a verified hour.
    INSERT INTO pds.phone_usage_segments (device, segment_start, segment_end, total_seconds, synced_at, last_run_id, last_run_item_count, last_export_at)
    VALUES (dev, '2001-03-06 12:00:00+00', '2001-03-06 13:00:00+00', 100, now(), r_i, 0, '2001-03-06 16:00:00+00');
    INSERT INTO pds.phone_usage_items (device, segment_start, kind, identifier, seconds)
    VALUES (dev, '2001-03-06 12:00:00+00', 'app', 'com.example.legacy', 5);
    IF EXISTS (SELECT 1 FROM pds.phone_usage_items WHERE device = dev AND identifier = 'com.example.legacy' AND segment_start = '2001-03-06 12:00:00+00') THEN
        RAISE EXCEPTION 'an item without a run id was mixed into an hour a run owns';
    END IF;
    INSERT INTO pds.phone_usage_items (device, segment_start, kind, identifier, seconds)
    VALUES (dev, d0, 'app', 'com.example.legacy2', 5);
    IF EXISTS (SELECT 1 FROM pds.phone_usage_items WHERE device = dev AND identifier = 'com.example.legacy2') THEN
        RAISE EXCEPTION 'an item without a run id entered a verified hour';
    END IF;

    -- 12. Browser roles cannot call the functions.
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
        PERFORM pds.finalize_phone_usage_run(dev, r_ok);
        RAISE EXCEPTION 'authenticated could finalize a run';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    EXECUTE format('SET LOCAL ROLE %I', initial_role);

    PERFORM set_config('onyx.phone_usage_completeness_verification', jsonb_build_object(
        'legacy_unknown', true, 'watchdog_not_verified', true, 'missing_chunk_not_verified', true,
        'inconsistent_not_verified', true, 'complete_verifies_closed_hours', true, 'stale_items_removed', true,
        'in_progress_hour_unverified', true, 'repeat_idempotent', true, 'verified_snapshot_kept', true,
        'older_export_refused', true, 'foreign_run_item_refused', true, 'item_mismatch_not_verified', true,
        'verified_columns_guarded', true, 'window_check', true, 'browser_roles_refused', true,
        'later_complete_export_replaces_snapshot', true, 'later_incomplete_export_keeps_snapshot', true,
        'older_export_not_staged', true, 'stale_source_limits_coverage', true, 'legacy_item_refused', true)::text, true);
END
$check$;
SELECT current_setting('onyx.phone_usage_completeness_verification')::jsonb AS verification;
ROLLBACK;
