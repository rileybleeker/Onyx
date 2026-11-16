-- ============================================================================
-- Screen Time export completeness (PIPE-11, 2026-11-16): EXPAND step
-- ============================================================================
-- Run after sql/phone_usage_schema.sql. Safe to re-run.
--
-- Before this file a day counted as complete once any upload arrived after it
-- ended (synced_at >= day + 1 at 06:00). An export the app's watchdog cut short,
-- a chunk that failed, or an app stopped by iOS halfway through a sync still
-- looked complete, and could supply objective experiment adherence.
--
-- After it, completeness is a property of the EXPORT, recorded per sync run:
--   * The app (builds from 2026-11-16) sends `run` with every chunk: a run id,
--     the requested window, whether Apple's stream ended on its own
--     (stream_ended = false: stopped by the app's watchdog), the number of
--     hours in the whole run, and this chunk's index and count. The route
--     writes the chunk's hours first and only then records the chunk in
--     pds.phone_usage_sync_chunks and calls pds.finalize_phone_usage_run.
--   * A run is complete only when every chunk arrived, the chunks agree on the
--     run's metadata, the hour counts add up and the stream ended. Then, and
--     only then, the hours the run still owns that had ended at export time
--     are marked verified, and items such an hour no longer lists are removed
--     (a completed hour cannot keep stale usage).
--   * A verified hour is a snapshot: an ordinary upload never changes it, and an
--     upload that carries a newer run is STAGED in pds.phone_usage_pending_hours
--     instead. Only the finalization of that later run, and only when it is
--     complete, replaces the snapshot (hours and items), so a newer complete
--     export corrects totals and removes items the old snapshot still listed,
--     while a newer export that never completes (watchdog stop, failed chunk)
--     leaves the last verified snapshot exactly as it was. Uploads without
--     `run` (every app build before this change) write as before and are
--     never verified.
--   * pds.phone_usage_daily gains, at the end: hours_verified, export_complete,
--     completeness ('complete' | 'partial' | 'unknown'), pre_sleep_complete,
--     during_sleep_complete. Readers count a day or an estimate only when the
--     flag is true: 'unknown' (an older build) is never complete.
--
-- Additive only: nullable columns, three new tables, functions, triggers and
-- appended view columns. ORDER: apply this file BEFORE the route that writes
-- the new columns is deployed (the route sends last_run_id, last_run_item_count
-- and last_export_at on every hour, run metadata or not). After it, the route
-- deployed before this change keeps working (it sends none of the new fields,
-- so its rows stay unverified).
-- Uploaded hours are never removed; the only usage rows a finalization removes
-- are items of an hour it verifies or replaces that the verifying export no
-- longer lists, and staged copies older than three days.
--
-- Rollback without data loss: the readers can go back to ignoring the new
-- columns (the view's existing columns are unchanged). Replacing the two guard
-- trigger functions with bodies that just RETURN NEW re-opens verified hours
-- to ordinary uploads. The behaviour check is
-- sql/checks/verify_phone_usage_completeness_branch.sql (branch only).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Provenance and verification columns (all nullable).
--   last_run_id          the run of the upload that last wrote the hour (NULL: an app build
--                        without completeness metadata)
--   last_run_item_count  how many items that upload listed for the hour
--   last_export_at       when that upload's export was read on the phone (its window end)
--   verified_*           set only by pds.finalize_phone_usage_run
-- ----------------------------------------------------------------------------
ALTER TABLE pds.phone_usage_segments
    ADD COLUMN IF NOT EXISTS last_run_id          UUID,
    ADD COLUMN IF NOT EXISTS last_run_item_count  INTEGER,
    ADD COLUMN IF NOT EXISTS last_export_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verified_at          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verified_run_id      UUID,
    ADD COLUMN IF NOT EXISTS verified_export_at   TIMESTAMPTZ;

ALTER TABLE pds.phone_usage_items
    ADD COLUMN IF NOT EXISTS last_run_id UUID;

CREATE INDEX IF NOT EXISTS phone_usage_segments_unverified_idx
    ON pds.phone_usage_segments (segment_start) WHERE verified_at IS NULL;
CREATE INDEX IF NOT EXISTS phone_usage_segments_run_idx
    ON pds.phone_usage_segments (device, last_run_id) WHERE last_run_id IS NOT NULL AND verified_at IS NULL;

-- ----------------------------------------------------------------------------
-- 2. One row per received chunk (written by the route after the chunk's hours),
--    one row per run (written by pds.finalize_phone_usage_run) and the staging
--    table for corrections of verified hours.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.phone_usage_sync_chunks (
    device               TEXT NOT NULL,
    run_id               UUID NOT NULL,
    chunk_index          INTEGER NOT NULL CHECK (chunk_index >= 0),
    chunk_count          INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 100),
    window_start         TIMESTAMPTZ NOT NULL,
    window_end           TIMESTAMPTZ NOT NULL,
    stream_ended         BOOLEAN NOT NULL,
    run_segment_count    INTEGER NOT NULL CHECK (run_segment_count >= 1),
    segment_count        INTEGER NOT NULL CHECK (segment_count >= 1),
    first_segment_start  TIMESTAMPTZ NOT NULL,
    last_segment_end     TIMESTAMPTZ NOT NULL,
    app_version          TEXT,
    received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device, run_id, chunk_index),
    CHECK (chunk_index < chunk_count),
    CHECK (window_end > window_start),
    CHECK (segment_count <= run_segment_count),
    CHECK (last_segment_end > first_segment_start)
);

CREATE TABLE IF NOT EXISTS pds.phone_usage_sync_runs (
    device             TEXT NOT NULL,
    run_id             UUID NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('receiving', 'stream_open', 'inconsistent', 'complete')),
    window_start       TIMESTAMPTZ NOT NULL,
    window_end         TIMESTAMPTZ NOT NULL,
    stream_ended       BOOLEAN NOT NULL,
    chunk_count        INTEGER NOT NULL,
    chunks_received    INTEGER NOT NULL,
    segment_count      INTEGER NOT NULL,
    segments_received  INTEGER NOT NULL,
    hours_verified     INTEGER NOT NULL DEFAULT 0,
    app_version        TEXT,
    first_received_at  TIMESTAMPTZ NOT NULL,
    checked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at       TIMESTAMPTZ,
    PRIMARY KEY (device, run_id),
    CHECK ((status = 'complete') = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS phone_usage_sync_runs_complete_idx
    ON pds.phone_usage_sync_runs (window_start, window_end) WHERE status = 'complete';

-- Staged copy of an hour a NEWER run uploaded over an already verified hour (written only by the
-- guard triggers below, one row per run and hour; `segment` is the uploaded hour row and `items` its
-- items keyed kind|identifier, both as the table rows they would have been). The finalization of
-- that run promotes them when the run is complete; otherwise they are never used and are removed
-- after three days. The live hour and its items stay the last verified snapshot meanwhile.
CREATE TABLE IF NOT EXISTS pds.phone_usage_pending_hours (
    device         TEXT NOT NULL,
    run_id         UUID NOT NULL,
    segment_start  TIMESTAMPTZ NOT NULL,
    segment        JSONB NOT NULL,
    items          JSONB NOT NULL DEFAULT '{}'::jsonb,
    staged_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device, run_id, segment_start)
);

-- SERVICE ROLE ONLY, like the usage tables they describe.
ALTER TABLE pds.phone_usage_sync_chunks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.phone_usage_sync_runs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.phone_usage_pending_hours ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['phone_usage_sync_chunks', 'phone_usage_sync_runs', 'phone_usage_pending_hours'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'pds' AND tablename = t AND policyname = 'service_full_access') THEN
            EXECUTE format('CREATE POLICY service_full_access ON pds.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
        END IF;
    END LOOP;
END $$;
REVOKE ALL ON pds.phone_usage_sync_chunks, pds.phone_usage_sync_runs, pds.phone_usage_pending_hours FROM PUBLIC, anon, authenticated;
GRANT ALL  ON pds.phone_usage_sync_chunks, pds.phone_usage_sync_runs, pds.phone_usage_pending_hours TO service_role;

-- ----------------------------------------------------------------------------
-- 3. Guards. Only pds.finalize_phone_usage_run (which sets the transaction-local
--    setting onyx.phone_usage_verified_write) may write a verified hour, its
--    items, or the verified_* columns. An integrity rule, not an access rule:
--    the service role is the only writer either way.
--    An upload that carries a NEWER run for a verified hour is not lost: it is
--    staged in pds.phone_usage_pending_hours (the hour row here, its items in the
--    items guard) and the finalization of that run replaces the snapshot only
--    when the run is complete.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.phone_usage_segments_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pds, pg_temp
AS $$
BEGIN
    IF current_setting('onyx.phone_usage_verified_write', true) = 'on' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        -- The snapshot of a complete export: ordinary uploads leave it as it is. A newer run's copy
        -- is staged (a repeat of the verifying run, or an older export, is simply ignored).
        IF OLD.verified_at IS NOT NULL THEN
            IF NEW.last_run_id IS NOT NULL AND NEW.last_export_at IS NOT NULL
               AND (OLD.verified_export_at IS NULL OR NEW.last_export_at > OLD.verified_export_at) THEN
                INSERT INTO pds.phone_usage_pending_hours AS h (device, run_id, segment_start, segment)
                VALUES (NEW.device, NEW.last_run_id, NEW.segment_start, to_jsonb(NEW))
                ON CONFLICT (device, run_id, segment_start)
                DO UPDATE SET segment = EXCLUDED.segment, items = '{}'::jsonb, staged_at = now();
            END IF;
            RETURN NULL;
        END IF;
        -- An export read before the one that wrote this hour must not replace it.
        IF OLD.last_export_at IS NOT NULL AND NEW.last_export_at IS NOT NULL
           AND NEW.last_export_at < OLD.last_export_at THEN
            RETURN NULL;
        END IF;
    END IF;
    NEW.verified_at        := NULL;
    NEW.verified_run_id    := NULL;
    NEW.verified_export_at := NULL;
    RETURN NEW;
END;
$$;

-- Named so it sorts before phone_usage_segments_set_onyx_dates: a skipped row skips both.
CREATE OR REPLACE TRIGGER phone_usage_segments_guard
    BEFORE INSERT OR UPDATE ON pds.phone_usage_segments
    FOR EACH ROW EXECUTE FUNCTION pds.phone_usage_segments_guard();

CREATE OR REPLACE FUNCTION pds.phone_usage_items_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pds, pg_temp
AS $$
DECLARE
    parent_verified     TIMESTAMPTZ;
    parent_run          UUID;
    parent_verified_run UUID;
BEGIN
    IF current_setting('onyx.phone_usage_verified_write', true) = 'on' THEN
        RETURN NEW;
    END IF;
    SELECT s.verified_at, s.last_run_id, s.verified_run_id
      INTO parent_verified, parent_run, parent_verified_run
      FROM pds.phone_usage_segments s
     WHERE s.device = NEW.device AND s.segment_start = NEW.segment_start;
    IF NOT FOUND THEN
        RETURN NEW;          -- the foreign key answers for a missing hour
    END IF;
    IF parent_verified IS NOT NULL THEN
        -- A verified hour's items are part of its snapshot. A newer run's item goes to that run's staged
        -- copy of the hour (none staged = its hour was refused as older, so the item is ignored too).
        IF NEW.last_run_id IS NOT NULL AND NEW.last_run_id IS DISTINCT FROM parent_verified_run THEN
            UPDATE pds.phone_usage_pending_hours h
               SET items = h.items || jsonb_build_object(NEW.kind || '|' || NEW.identifier, to_jsonb(NEW))
             WHERE h.device = NEW.device AND h.run_id = NEW.last_run_id AND h.segment_start = NEW.segment_start;
        END IF;
        RETURN NULL;
    END IF;
    -- An item from a run applies only while that run owns the hour: when another upload's run
    -- took the hour over (or this run's hour write was refused), the item is not mixed in.
    IF NEW.last_run_id IS NOT NULL AND parent_run IS DISTINCT FROM NEW.last_run_id THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER phone_usage_items_guard
    BEFORE INSERT OR UPDATE ON pds.phone_usage_items
    FOR EACH ROW EXECUTE FUNCTION pds.phone_usage_items_guard();

-- ----------------------------------------------------------------------------
-- 4. Finalization: called by the route after every chunk it recorded. Idempotent
--    (a complete run answers 'complete' again and changes nothing), one call per
--    run at a time (advisory lock), and a run that is not complete changes no
--    usage row. Answers {status, hours_verified, hours_replaced, items_removed,
--    chunks_received, chunk_count, already}; status is one of 'unknown_run',
--    'inconsistent', 'stream_open', 'receiving', 'complete'.
--    An hour is verified when this run still owns it (last_run_id), it had ended
--    at export time (segment_end <= window_end) and is a whole hour (an in-progress
--    hour that Apple clips to the export time is shorter), and every item the run
--    sent for it is still the run's (last_run_item_count).
--    A complete run also REPLACES the snapshot of an hour an earlier run verified
--    when it staged its own copy of that hour (same whole-hour and item-count
--    rules, and its export must have been read later than the snapshot's): the
--    hour row and all its items become the later export's, so totals are
--    corrected and items the old snapshot listed but this export does not are
--    gone. hours_verified counts both; hours_replaced only the second kind.
--    Before it decides anything the finalization locks every hour it may change
--    (in key order), so a concurrent upload cannot slip between the ownership
--    check and the marking: it waits, then finds the hour verified and stages or
--    ignores its copy.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.finalize_phone_usage_run(p_device TEXT, p_run_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $$
DECLARE
    c          RECORD;
    v_prior    pds.phone_usage_sync_runs%ROWTYPE;
    v_status   TEXT;
    v_verified INTEGER := 0;
    v_removed  INTEGER := 0;
    v_fix      TIMESTAMPTZ[] := ARRAY[]::timestamptz[];
    v_fixed    INTEGER := 0;
BEGIN
    IF p_device IS NULL OR p_run_id IS NULL THEN
        RAISE EXCEPTION 'finalize_phone_usage_run: device and run id are required' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('pds.phone_usage_run:' || p_device || ':' || p_run_id::text, 0));

    SELECT * INTO v_prior FROM pds.phone_usage_sync_runs r WHERE r.device = p_device AND r.run_id = p_run_id;
    IF FOUND AND v_prior.status = 'complete' THEN
        RETURN jsonb_build_object('status', 'complete', 'hours_verified', v_prior.hours_verified, 'hours_replaced', 0,
                                  'items_removed', 0, 'chunks_received', v_prior.chunks_received,
                                  'chunk_count', v_prior.chunk_count, 'already', true);
    END IF;

    SELECT count(*)                       AS n,
           count(DISTINCT k.chunk_index)  AS chunks,
           min(k.chunk_count)             AS chunk_count,
           max(k.chunk_count)             AS chunk_count_max,
           min(k.window_start)            AS window_start,
           max(k.window_start)            AS window_start_max,
           min(k.window_end)              AS window_end,
           max(k.window_end)              AS window_end_max,
           bool_and(k.stream_ended)       AS ended_all,
           bool_or(k.stream_ended)        AS ended_any,
           min(k.run_segment_count)       AS segment_total,
           max(k.run_segment_count)       AS segment_total_max,
           sum(k.segment_count)::int      AS segments_received,
           max(k.app_version)             AS app_version,
           min(k.received_at)             AS first_received_at
      INTO c
      FROM pds.phone_usage_sync_chunks k
     WHERE k.device = p_device AND k.run_id = p_run_id;

    IF c.n = 0 THEN
        RETURN jsonb_build_object('status', 'unknown_run', 'hours_verified', 0, 'hours_replaced', 0, 'items_removed', 0,
                                  'chunks_received', 0, 'chunk_count', NULL, 'already', false);
    END IF;

    IF c.chunk_count <> c.chunk_count_max OR c.window_start <> c.window_start_max
       OR c.window_end <> c.window_end_max OR c.ended_all <> c.ended_any
       OR c.segment_total <> c.segment_total_max THEN
        v_status := 'inconsistent';           -- the chunks describe different runs
    ELSIF NOT c.ended_all THEN
        v_status := 'stream_open';            -- the watchdog stopped Apple's stream: never complete
    ELSIF c.chunks < c.chunk_count THEN
        v_status := 'receiving';              -- a chunk failed, is still on its way, or the app was stopped
    ELSIF c.segments_received <> c.segment_total THEN
        v_status := 'inconsistent';           -- every chunk arrived but the hours do not add up
    ELSE
        v_status := 'complete';
    END IF;

    IF v_status = 'complete' THEN
        PERFORM set_config('onyx.phone_usage_verified_write', 'on', true);
        -- Lock first, decide second: from here until this transaction ends no other writer can change an
        -- hour this run owns or has staged (a waiting upload then finds it verified). The ownership test
        -- below runs in a later statement, so it sees whatever the writers we waited for committed.
        PERFORM 1
          FROM pds.phone_usage_segments s
         WHERE s.device = p_device
           AND ((s.last_run_id = p_run_id AND s.verified_at IS NULL)
                OR s.segment_start IN (SELECT h.segment_start FROM pds.phone_usage_pending_hours h
                                        WHERE h.device = p_device AND h.run_id = p_run_id))
         ORDER BY s.segment_start
           FOR UPDATE;

        WITH owned AS (
            SELECT s.device, s.segment_start
              FROM pds.phone_usage_segments s
             WHERE s.device = p_device
               AND s.last_run_id = p_run_id
               AND s.verified_at IS NULL
               AND s.segment_end <= c.window_end
               AND s.segment_end - s.segment_start >= INTERVAL '1 hour'
               AND s.last_run_item_count IS NOT NULL
               AND s.last_run_item_count = (
                       SELECT count(*) FROM pds.phone_usage_items i
                        WHERE i.device = s.device AND i.segment_start = s.segment_start
                          AND i.last_run_id = p_run_id)
        ), removed AS (
            DELETE FROM pds.phone_usage_items i
             USING owned o
             WHERE i.device = o.device AND i.segment_start = o.segment_start
               AND i.last_run_id IS DISTINCT FROM p_run_id
            RETURNING 1
        ), marked AS (
            UPDATE pds.phone_usage_segments s
               SET verified_at = now(), verified_run_id = p_run_id, verified_export_at = c.window_end
              FROM owned o
             WHERE s.device = o.device AND s.segment_start = o.segment_start
               AND s.last_run_id = p_run_id AND s.verified_at IS NULL
            RETURNING 1
        )
        SELECT (SELECT count(*) FROM marked), (SELECT count(*) FROM removed) INTO v_verified, v_removed;

        -- Hours an earlier run verified that this complete run uploaded again: its staged copy replaces the snapshot.
        SELECT COALESCE(array_agg(x.segment_start ORDER BY x.segment_start), ARRAY[]::timestamptz[])
          INTO v_fix
          FROM (
              SELECT h.segment_start
                FROM pds.phone_usage_pending_hours h
                JOIN pds.phone_usage_segments s ON s.device = h.device AND s.segment_start = h.segment_start
               WHERE h.device = p_device AND h.run_id = p_run_id
                 AND s.verified_at IS NOT NULL
                 AND s.verified_export_at < c.window_end
                 AND (h.segment ->> 'segment_end')::timestamptz <= c.window_end
                 AND (h.segment ->> 'segment_end')::timestamptz - h.segment_start >= INTERVAL '1 hour'
                 AND (h.segment ->> 'last_run_item_count')::int = (SELECT count(*) FROM jsonb_object_keys(h.items))
          ) x;

        IF COALESCE(array_length(v_fix, 1), 0) > 0 THEN
            DELETE FROM pds.phone_usage_items i
             WHERE i.device = p_device AND i.segment_start = ANY (v_fix);

            UPDATE pds.phone_usage_segments s
               SET segment_end            = (h.segment ->> 'segment_end')::timestamptz,
                   total_seconds          = (h.segment ->> 'total_seconds')::numeric,
                   first_pickup           = (h.segment ->> 'first_pickup')::timestamptz,
                   pickups_without_app    = (h.segment ->> 'pickups_without_app')::int,
                   longest_activity_start = (h.segment ->> 'longest_activity_start')::timestamptz,
                   longest_activity_end   = (h.segment ->> 'longest_activity_end')::timestamptz,
                   device_name            = h.segment ->> 'device_name',
                   device_model           = h.segment ->> 'device_model',
                   synced_at              = (h.segment ->> 'synced_at')::timestamptz,
                   last_run_id            = p_run_id,
                   last_run_item_count    = (h.segment ->> 'last_run_item_count')::int,
                   last_export_at         = c.window_end,
                   verified_at            = now(),
                   verified_run_id        = p_run_id,
                   verified_export_at     = c.window_end
              FROM pds.phone_usage_pending_hours h
             WHERE h.device = p_device AND h.run_id = p_run_id AND h.segment_start = ANY (v_fix)
               AND s.device = h.device AND s.segment_start = h.segment_start;
            GET DIAGNOSTICS v_fixed = ROW_COUNT;

            INSERT INTO pds.phone_usage_items
                   (device, segment_start, kind, identifier, name, category, seconds, pickups, notifications, last_run_id)
            SELECT h.device, h.segment_start, e.value ->> 'kind', e.value ->> 'identifier', e.value ->> 'name',
                   e.value ->> 'category', (e.value ->> 'seconds')::numeric, (e.value ->> 'pickups')::int,
                   (e.value ->> 'notifications')::int, p_run_id
              FROM pds.phone_usage_pending_hours h
             CROSS JOIN LATERAL jsonb_each(h.items) e
             WHERE h.device = p_device AND h.run_id = p_run_id AND h.segment_start = ANY (v_fix);

            v_verified := v_verified + v_fixed;
        END IF;

        -- The run is settled: its staged copies have done their job (an hour it could not replace keeps the
        -- snapshot), and copies of runs that never completed are removed after three days.
        DELETE FROM pds.phone_usage_pending_hours h WHERE h.device = p_device AND h.run_id = p_run_id;
        DELETE FROM pds.phone_usage_pending_hours h WHERE h.staged_at < now() - INTERVAL '3 days';
        PERFORM set_config('onyx.phone_usage_verified_write', 'off', true);
    END IF;

    INSERT INTO pds.phone_usage_sync_runs AS r
           (device, run_id, status, window_start, window_end, stream_ended, chunk_count, chunks_received,
            segment_count, segments_received, hours_verified, app_version, first_received_at, checked_at, completed_at)
    VALUES (p_device, p_run_id, v_status, c.window_start, c.window_end, c.ended_all, c.chunk_count_max, c.chunks,
            c.segment_total_max, c.segments_received, v_verified, c.app_version, c.first_received_at, now(),
            CASE WHEN v_status = 'complete' THEN now() END)
    ON CONFLICT (device, run_id) DO UPDATE SET
        status            = EXCLUDED.status,
        window_start      = EXCLUDED.window_start,
        window_end        = EXCLUDED.window_end,
        stream_ended      = EXCLUDED.stream_ended,
        chunk_count       = EXCLUDED.chunk_count,
        chunks_received   = EXCLUDED.chunks_received,
        segment_count     = EXCLUDED.segment_count,
        segments_received = EXCLUDED.segments_received,
        hours_verified    = EXCLUDED.hours_verified,
        app_version       = EXCLUDED.app_version,
        checked_at        = EXCLUDED.checked_at,
        completed_at      = EXCLUDED.completed_at;

    RETURN jsonb_build_object('status', v_status, 'hours_verified', v_verified, 'hours_replaced', v_fixed,
                              'items_removed', v_removed, 'chunks_received', c.chunks,
                              'chunk_count', c.chunk_count_max, 'already', false);
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Is [p_from, p_to) backed by a complete export? True only when one complete
--    run's window covers it AND no stored hour overlapping it is unverified (an
--    hour from an older app build, from a run that did not complete, or one a
--    complete run could not claim). An hour with no row inside a complete run's
--    window had no usage. Device-agnostic on purpose: an unverified hour from any
--    device makes the window incomplete.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.phone_usage_window_complete(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pds, pg_temp
AS $$
    SELECT COALESCE(p_from < p_to, false)
       AND EXISTS (SELECT 1 FROM pds.phone_usage_sync_runs r
                    WHERE r.status = 'complete' AND r.window_start <= p_from AND r.window_end >= p_to)
       AND NOT EXISTS (SELECT 1 FROM pds.phone_usage_segments s
                        WHERE s.verified_at IS NULL AND s.segment_start < p_to AND s.segment_end > p_from)
$$;

REVOKE ALL ON FUNCTION pds.phone_usage_segments_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.phone_usage_items_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.finalize_phone_usage_run(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION pds.phone_usage_window_complete(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.phone_usage_segments_guard() TO service_role;
GRANT EXECUTE ON FUNCTION pds.phone_usage_items_guard() TO service_role;
GRANT EXECUTE ON FUNCTION pds.finalize_phone_usage_run(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION pds.phone_usage_window_complete(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;

-- ----------------------------------------------------------------------------
-- 6. pds.phone_usage_daily with the completeness columns appended. Everything up
--    to synced_at is the definition in sql/phone_usage_schema.sql, unchanged.
--      hours_verified         hours of the day marked verified
--      export_complete        the whole behavioral day (06:00 to 06:00 local, widened to the
--                             day's own hours) is backed by a complete export
--      completeness           'complete' | 'unknown' (no hour carries run metadata: an older
--                             app build) | 'partial' (anything else)
--      pre_sleep_complete     the hour before the closing sleep's onset is backed (NULL: no sleep)
--      during_sleep_complete  the closing sleep itself is backed (NULL: no sleep)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW pds.phone_usage_daily WITH (security_invoker = true) AS
WITH seg AS (
    SELECT s.*,
           EXTRACT(HOUR FROM (s.segment_start AT TIME ZONE pds.tz_for_instant(s.segment_start)))::int AS local_hour
    FROM pds.phone_usage_segments s
),
sleep AS (
    SELECT wcm.onyx_behavioral_date AS behavioral_date,
           MIN(ws.start_time)       AS sleep_start,
           MAX(ws.end_time)         AS sleep_end
    FROM pds.whoop_main_cycle_per_behavioral_date wcm
    JOIN pds.whoop_sleep ws
      ON ws.cycle_id = wcm.cycle_id
     AND ws.is_nap = false
     AND ws.score_state = 'SCORED'
    GROUP BY wcm.onyx_behavioral_date
),
item_day AS (
    SELECT s.onyx_behavioral_date AS behavioral_date, i.kind,
           COALESCE(i.name, i.identifier) AS label,
           COALESCE(i.category, '(none)') AS category,
           SUM(i.seconds)                 AS seconds,
           SUM(COALESCE(i.pickups, 0))        AS pickups,
           SUM(COALESCE(i.notifications, 0))  AS notifications
    FROM pds.phone_usage_items i
    JOIN pds.phone_usage_segments s USING (device, segment_start)
    GROUP BY 1, 2, 3, 4
),
apps AS (
    SELECT behavioral_date,
           jsonb_object_agg(label, ROUND((seconds / 60.0)::numeric, 1) ORDER BY seconds DESC)
               FILTER (WHERE kind = 'app')        AS minutes_by_app,
           SUM(pickups)                           AS app_pickups,
           SUM(notifications)                     AS notifications,
           COUNT(*) FILTER (WHERE kind = 'app')   AS apps_used
    FROM (
        SELECT behavioral_date, kind, label, SUM(seconds) AS seconds,
               SUM(pickups) AS pickups, SUM(notifications) AS notifications
        FROM item_day GROUP BY 1, 2, 3
    ) x
    GROUP BY behavioral_date
),
cats AS (
    SELECT behavioral_date,
           jsonb_object_agg(category, ROUND((seconds / 60.0)::numeric, 1) ORDER BY seconds DESC) AS minutes_by_category
    FROM (
        SELECT behavioral_date, category, SUM(seconds) AS seconds
        FROM item_day WHERE kind = 'app' GROUP BY 1, 2
    ) y
    GROUP BY behavioral_date
),
sleep_use AS (
    SELECT sl.behavioral_date,
           SUM(s.total_seconds
               * GREATEST(0, EXTRACT(EPOCH FROM (
                     LEAST(s.segment_end, sl.sleep_start)
                   - GREATEST(s.segment_start, sl.sleep_start - INTERVAL '60 minutes'))))
               / EXTRACT(EPOCH FROM (s.segment_end - s.segment_start))) / 60.0
                                                                        AS minutes_last_hour_before_sleep_est,
           SUM(s.total_seconds
               * GREATEST(0, EXTRACT(EPOCH FROM (
                     LEAST(s.segment_end, sl.sleep_end)
                   - GREATEST(s.segment_start, sl.sleep_start))))
               / EXTRACT(EPOCH FROM (s.segment_end - s.segment_start))) / 60.0
                                                                        AS minutes_during_sleep_est
    FROM sleep sl
    JOIN pds.phone_usage_segments s
      -- prune by day so the behavioral-date index is used; the two time tests below decide
      ON s.onyx_behavioral_date BETWEEN sl.behavioral_date - 2 AND sl.behavioral_date + 2
     AND s.segment_end   > sl.sleep_start - INTERVAL '60 minutes'
     AND s.segment_start < sl.sleep_end
    GROUP BY sl.behavioral_date
),
agg AS (
    SELECT
        seg.onyx_behavioral_date                                        AS behavioral_date,
        COUNT(*)                                                        AS hours_reported,
        SUM(seg.total_seconds) / 60.0                                   AS total_minutes,
        SUM(seg.total_seconds) FILTER (WHERE seg.local_hour >= 22 OR seg.local_hour < 6) / 60.0
                                                                        AS late_night_minutes,
        SUM(seg.total_seconds) FILTER (WHERE seg.local_hour < 6) / 60.0 AS after_midnight_minutes,
        SUM(COALESCE(seg.pickups_without_app, 0))                       AS pickups_without_app,
        MIN(seg.first_pickup)                                           AS first_pickup,
        MAX(seg.segment_end) FILTER (WHERE seg.total_seconds > 0)       AS last_active_hour_end,
        MIN(sl.sleep_start)                                             AS sleep_start,
        MAX(seg.synced_at)                                              AS synced_at,
        -- completeness inputs (PIPE-11)
        COUNT(*) FILTER (WHERE seg.verified_at IS NOT NULL)             AS hours_verified,
        bool_and(seg.last_run_id IS NULL)                               AS no_run_metadata,
        MIN(seg.segment_start)                                          AS first_hour_start,
        MAX(seg.segment_end)                                            AS last_hour_end,
        MAX(sl.sleep_end)                                               AS sleep_end
    FROM seg
    LEFT JOIN sleep sl ON sl.behavioral_date = seg.onyx_behavioral_date
    GROUP BY seg.onyx_behavioral_date
),
bounds AS (
    -- The behavioral day runs 06:00 to 06:00 local (zone in effect at noon ET of the day),
    -- widened to the day's own hours so a travel day is never checked over a shorter span.
    SELECT a.behavioral_date,
           LEAST(((a.behavioral_date + TIME '06:00') AT TIME ZONE z.tz), a.first_hour_start)      AS day_from,
           GREATEST((((a.behavioral_date + 1) + TIME '06:00') AT TIME ZONE z.tz), a.last_hour_end) AS day_to
    FROM agg a
    CROSS JOIN LATERAL (
        SELECT pds.tz_for_instant((a.behavioral_date + TIME '12:00') AT TIME ZONE 'America/New_York') AS tz
    ) z
),
day_check AS (
    SELECT b.behavioral_date,
           COALESCE(pds.phone_usage_window_complete(b.day_from, b.day_to), false) AS export_complete
    FROM bounds b
)
SELECT
    a.behavioral_date,
    a.hours_reported,
    ROUND(a.total_minutes::numeric, 1)                         AS total_minutes,
    ROUND(COALESCE(a.late_night_minutes, 0)::numeric, 1)       AS late_night_minutes,
    ROUND(COALESCE(a.after_midnight_minutes, 0)::numeric, 1)   AS after_midnight_minutes,
    a.pickups_without_app + COALESCE(ap.app_pickups, 0)        AS pickups,
    COALESCE(ap.notifications, 0)                              AS notifications,
    COALESCE(ap.apps_used, 0)                                  AS apps_used,
    a.first_pickup,
    a.last_active_hour_end,
    a.sleep_start,
    -- GREATEST(0, NULL) = 0 in Postgres, so gate on the sleep anchor explicitly.
    CASE WHEN a.sleep_start IS NOT NULL
         THEN ROUND(COALESCE(su.minutes_last_hour_before_sleep_est, 0)::numeric, 1) END AS minutes_last_hour_before_sleep_est,
    CASE WHEN a.sleep_start IS NOT NULL
         THEN ROUND(COALESCE(su.minutes_during_sleep_est, 0)::numeric, 1) END           AS minutes_during_sleep_est,
    ap.minutes_by_app,
    c.minutes_by_category,
    a.synced_at,
    -- appended by sql/phone_usage_completeness.sql (PIPE-11)
    a.hours_verified,
    dc.export_complete,
    CASE WHEN dc.export_complete THEN 'complete'
         WHEN a.no_run_metadata THEN 'unknown'
         ELSE 'partial' END                                                    AS completeness,
    CASE WHEN a.sleep_start IS NOT NULL
         THEN pds.phone_usage_window_complete(a.sleep_start - INTERVAL '60 minutes', a.sleep_start) END
                                                                               AS pre_sleep_complete,
    CASE WHEN a.sleep_start IS NOT NULL AND a.sleep_end IS NOT NULL
         THEN pds.phone_usage_window_complete(a.sleep_start, a.sleep_end) END  AS during_sleep_complete
FROM agg a
JOIN day_check dc      ON dc.behavioral_date = a.behavioral_date
LEFT JOIN apps ap      ON ap.behavioral_date = a.behavioral_date
LEFT JOIN cats c       ON c.behavioral_date  = a.behavioral_date
LEFT JOIN sleep_use su ON su.behavioral_date = a.behavioral_date;

REVOKE ALL   ON pds.phone_usage_daily FROM anon, authenticated;
GRANT SELECT ON pds.phone_usage_daily TO service_role;
