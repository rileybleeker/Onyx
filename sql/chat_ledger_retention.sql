-- ============================================================================
-- Onyx Chat replay ledger: 180-day retention (approved by Riley 2026-11-18)
-- ============================================================================
-- pds.chat_ledger_purge(p_days, p_dry_run) removes whole requests from
-- pds.chat_requests (their pds.chat_operations go with them through the FK's
-- ON DELETE CASCADE). A request is purged only when ALL hold:
--   * created_at is older than p_days (default 180) and last_attempt_at too;
--   * no lease is held (lease_until is NULL or already past);
--   * none of its operations was created or updated inside the window;
--   * none of its operations has a pds.chat_operation_tombstones row. A
--     tombstone cascades with its operation, and it is what stops a retry
--     from bringing a removed intake / session back, so such requests (and
--     their tombstones) are KEPT. Tombstones are tiny.
-- Never touched: supplement_intake, reading_sessions, spotify_playlists,
-- book_highlights or any other data table.
-- Replay identity is kept (Codex #817 CHAT795-1): in the same transaction as
-- the delete, every purged request leaves a compact marker in
-- pds.chat_retired_requests (owner, request id, conversation hash, when).
-- claimRequest (frontend/src/lib/chat-operations.ts) checks it before and
-- after its insert and refuses a retired id ("retired", HTTP 409), because
-- the request's writes still exist under operation ids a new ledger row would
-- not reuse, so running it as new could write them again. Markers are never
-- purged (one small row per request).
-- A real run locks each candidate request (skipping one a live claim holds),
-- re-checks every rule on the locked rows, and writes a marker only for a
-- request the same statement deletes (Codex #817 CHAT819-2), so a renewed
-- lease or a finished retry never leaves a marker on a request that stays.
-- Returns one row per table: would_delete (the candidates) / deleted (rows a
-- real run actually removed); chat_retired_requests counts the markers written.
-- Service role only. Additive: safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.chat_retired_requests (
    owner_id          UUID        NOT NULL,
    request_id        UUID        NOT NULL,
    conversation_sha  TEXT        NOT NULL,
    retired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, request_id)
);

COMMENT ON TABLE pds.chat_retired_requests IS
  'Onyx Chat replay ledger: request ids whose ledger rows retention removed. A retired id is refused, never run as new (its writes may exist). Service role only.';

ALTER TABLE pds.chat_retired_requests ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'pds' AND tablename = 'chat_retired_requests' AND policyname = 'service_full_access'
  ) THEN
    CREATE POLICY service_full_access ON pds.chat_retired_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

REVOKE ALL ON pds.chat_retired_requests FROM anon, authenticated;
GRANT ALL ON pds.chat_retired_requests TO service_role;

CREATE OR REPLACE FUNCTION pds.chat_ledger_purge(p_days integer DEFAULT 180, p_dry_run boolean DEFAULT true)
RETURNS TABLE (table_name text, dry_run boolean, would_delete bigint, deleted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pds
AS $$
DECLARE
  cutoff timestamptz;
  n_req  bigint;
  n_ops  bigint;
  d_req  bigint := 0;
  d_ops  bigint := 0;
  d_ret  bigint := 0;
  rec    record;
BEGIN
  IF p_days IS NULL OR p_days < 30 THEN
    RAISE EXCEPTION 'chat_ledger_purge: p_days must be at least 30';
  END IF;
  cutoff := now() - make_interval(days => p_days);

  -- Session temp tables, emptied at commit and before each use (so two calls in one transaction work).
  CREATE TEMP TABLE IF NOT EXISTS _chat_purge_keys (owner_id uuid, request_id uuid) ON COMMIT DELETE ROWS;
  CREATE TEMP TABLE IF NOT EXISTS _chat_purge_locked (owner_id uuid, request_id uuid, PRIMARY KEY (owner_id, request_id)) ON COMMIT DELETE ROWS;
  DELETE FROM _chat_purge_keys;
  DELETE FROM _chat_purge_locked;

  INSERT INTO _chat_purge_keys (owner_id, request_id)
  SELECT r.owner_id, r.request_id
  FROM pds.chat_requests r
  WHERE r.created_at < cutoff
    AND r.last_attempt_at < cutoff
    AND (r.lease_until IS NULL OR r.lease_until < now())
    AND NOT EXISTS (
      SELECT 1 FROM pds.chat_operations o
      WHERE o.owner_id = r.owner_id AND o.request_id = r.request_id
        AND (o.created_at >= cutoff OR o.updated_at >= cutoff
             OR EXISTS (SELECT 1 FROM pds.chat_operation_tombstones t WHERE t.op_id = o.op_id))
    );

  SELECT count(*) INTO n_req FROM _chat_purge_keys;
  SELECT count(*) INTO n_ops FROM pds.chat_operations o
    JOIN _chat_purge_keys k ON k.owner_id = o.owner_id AND k.request_id = o.request_id;

  IF NOT p_dry_run THEN
    -- Codex #817 CHAT819-2: a marker is written only for a request this run really deletes. The candidate list
    -- above can be stale by now (a claim renewed the lease, a retry finished), so:
    -- 1. Lock each candidate request row and re-check its own eligibility in the same statement. SKIP LOCKED
    --    leaves a request a live claim is touching for a later run. While the row is locked, no claim can renew
    --    its lease and no operation or tombstone can be added under it (their foreign keys need a key-share lock).
    FOR rec IN
      SELECT r.owner_id, r.request_id
      FROM pds.chat_requests r
      JOIN _chat_purge_keys k ON k.owner_id = r.owner_id AND k.request_id = r.request_id
      WHERE r.created_at < cutoff
        AND r.last_attempt_at < cutoff
        AND (r.lease_until IS NULL OR r.lease_until < now())
      ORDER BY r.owner_id, r.request_id
      FOR UPDATE OF r SKIP LOCKED
    LOOP
      INSERT INTO _chat_purge_locked (owner_id, request_id) VALUES (rec.owner_id, rec.request_id);
    END LOOP;
    -- 2. Lock their operations too, so an in-flight update of one (a retry) finishes before the re-check below.
    PERFORM 1 FROM pds.chat_operations o
      JOIN _chat_purge_locked l ON l.owner_id = o.owner_id AND l.request_id = o.request_id
      ORDER BY o.op_id
      FOR UPDATE OF o;
    -- 3. Re-check the operation rules on what is now committed (a new statement reads a new snapshot).
    DELETE FROM _chat_purge_locked l
      WHERE EXISTS (
        SELECT 1 FROM pds.chat_operations o
        WHERE o.owner_id = l.owner_id AND o.request_id = l.request_id
          AND (o.created_at >= cutoff OR o.updated_at >= cutoff
               OR EXISTS (SELECT 1 FROM pds.chat_operation_tombstones t WHERE t.op_id = o.op_id))
      );
    -- 4. Delete the locked, still-eligible requests and write one marker per row the DELETE actually removed, in
    --    one statement. Counts come from the affected rows: the operations are counted from the same snapshot
    --    the DELETE reads (the foreign key's ON DELETE CASCADE removes exactly those).
    WITH del AS (
      DELETE FROM pds.chat_requests r USING _chat_purge_locked l
        WHERE r.owner_id = l.owner_id AND r.request_id = l.request_id
        RETURNING r.owner_id, r.request_id, r.conversation_sha
    ), ins AS (
      INSERT INTO pds.chat_retired_requests (owner_id, request_id, conversation_sha)
        SELECT owner_id, request_id, conversation_sha FROM del
        ON CONFLICT (owner_id, request_id) DO NOTHING
        RETURNING 1
    )
    SELECT (SELECT count(*) FROM del),
           (SELECT count(*) FROM pds.chat_operations o JOIN del ON del.owner_id = o.owner_id AND del.request_id = o.request_id),
           (SELECT count(*) FROM ins)
      INTO d_req, d_ops, d_ret;
  END IF;

  RETURN QUERY VALUES
    ('chat_requests'::text, p_dry_run, n_req, d_req),
    ('chat_operations'::text, p_dry_run, n_ops, d_ops),
    ('chat_retired_requests'::text, p_dry_run, n_req, d_ret);
END;
$$;

REVOKE ALL ON FUNCTION pds.chat_ledger_purge(integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.chat_ledger_purge(integer, boolean) TO service_role;

COMMENT ON FUNCTION pds.chat_ledger_purge(integer, boolean) IS
  'Onyx Chat replay ledger retention: removes requests (and their operations) older than p_days with no lease, no recent operation and no tombstone, leaving a pds.chat_retired_requests marker for each. Dry run by default. Service role only.';

-- Daily job at 04:20 UTC (pg_cron). Re-running replaces the job.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chat-ledger-purge') THEN
      PERFORM cron.unschedule('chat-ledger-purge');
    END IF;
    PERFORM cron.schedule('chat-ledger-purge', '20 4 * * *', 'select pds.chat_ledger_purge(180, false)');
  END IF;
END $$;
