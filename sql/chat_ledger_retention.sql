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
-- Returns one row per table: would_delete (dry run) / deleted (real run);
-- chat_retired_requests counts the markers written.
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
BEGIN
  IF p_days IS NULL OR p_days < 30 THEN
    RAISE EXCEPTION 'chat_ledger_purge: p_days must be at least 30';
  END IF;
  cutoff := now() - make_interval(days => p_days);

  CREATE TEMP TABLE _chat_purge_keys ON COMMIT DROP AS
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
    -- Count the operations first (the cascade removes them with the request).
    d_ops := n_ops;
    -- Replay identity first, in this same transaction: a purged id is refused later, never run as new.
    INSERT INTO pds.chat_retired_requests (owner_id, request_id, conversation_sha)
      SELECT r.owner_id, r.request_id, r.conversation_sha
      FROM pds.chat_requests r JOIN _chat_purge_keys k
        ON r.owner_id = k.owner_id AND r.request_id = k.request_id
      WHERE r.lease_until IS NULL OR r.lease_until < now()
      ON CONFLICT (owner_id, request_id) DO NOTHING;
    GET DIAGNOSTICS d_ret = ROW_COUNT;
    DELETE FROM pds.chat_requests r USING _chat_purge_keys k
      WHERE r.owner_id = k.owner_id AND r.request_id = k.request_id
        AND (r.lease_until IS NULL OR r.lease_until < now())
        AND EXISTS (SELECT 1 FROM pds.chat_retired_requests x
                    WHERE x.owner_id = r.owner_id AND x.request_id = r.request_id);
    GET DIAGNOSTICS d_req = ROW_COUNT;
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
