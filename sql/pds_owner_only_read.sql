-- ============================================================================
-- pds: owner-only reads (2026-11-10)
-- ============================================================================
-- Before: 53 SELECT policies let the anon role read almost every pds table,
-- and every view/matview was granted to anon. The anon key ships in the
-- site's public JavaScript and the repo is public, so the whole health
-- schema (journal entries included) was readable without logging in.
--
-- After:
--   anon           no USAGE on schema pds -> cannot read or call anything in it
--   authenticated  reads tables only through owner_read (auth.uid() = the one
--                  Onyx account); views/matviews keep their SELECT grant
--                  (they run as their owner, so they are guarded by the
--                  login + the middleware owner pin + sign-ups being off)
--   service_role   unchanged (ETLs, API routes, ISR prefetch)
-- Frontend side: lib/supabase.ts reads with the service role on the server
-- and with the signed-in session in the browser; middleware.ts only accepts
-- the owner account.
--
-- New tables: GRANTs to anon in older schema files no longer matter (no
-- schema USAGE). A new table the browser reads still needs
--   GRANT SELECT ON pds.<t> TO authenticated;
--   CREATE POLICY owner_read ON pds.<t> FOR SELECT TO authenticated
--     USING ((SELECT auth.uid()) = 'dc041abc-115a-4252-8536-803f2ac75557'::uuid);
-- or just re-run PART 1 below. Never GRANT USAGE ON SCHEMA pds TO anon.
--
-- Safe to re-run. Contains no statement that removes an object (the Supabase
-- MCP connector refuses migrations that do).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PART 1 (additive): owner read access for the signed-in account.
-- Service-role-only relations are skipped.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    owner_id CONSTANT uuid := 'dc041abc-115a-4252-8536-803f2ac75557';
    r record;
BEGIN
    FOR r IN
        SELECT c.relname, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pds'
          AND c.relkind IN ('r', 'p', 'v', 'm')
          AND c.relname NOT IN ('ci_tokens', 'phone_usage_segments', 'phone_usage_items', 'phone_usage_daily', 'inbox_emails',
                                'online_order_events', 'online_orders', 'online_order_marks',
                                'finance_accounts', 'finance_transactions', 'finance_balance_snapshots')
          AND (has_table_privilege('anon', c.oid, 'SELECT')
               OR has_table_privilege('authenticated', c.oid, 'SELECT'))
    LOOP
        EXECUTE format('GRANT SELECT ON pds.%I TO authenticated', r.relname);
        IF r.relkind IN ('r', 'p') AND NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE schemaname = 'pds' AND tablename = r.relname AND policyname = 'owner_read'
        ) THEN
            EXECUTE format(
                'CREATE POLICY owner_read ON pds.%I FOR SELECT TO authenticated USING ((SELECT auth.uid()) = %L::uuid)',
                r.relname, owner_id);
        END IF;
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- PART 2 (closes the public read). Run after the frontend reads as the
-- signed-in account (lib/supabase.ts), or the dashboards go empty.
-- ---------------------------------------------------------------------------

-- Every older read policy that let anon (or ANY signed-in account) read is
-- handed to service_role, which bypasses RLS anyway, so it no longer grants
-- anything to anyone else.
DO $$
DECLARE p record;
BEGIN
    FOR p IN
        SELECT tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'pds'
          AND cmd = 'SELECT'
          AND policyname <> 'owner_read'
          AND roles && ARRAY['anon', 'authenticated', 'public']::name[]
    LOOP
        EXECUTE format('ALTER POLICY %I ON pds.%I TO service_role', p.policyname, p.tablename);
    END LOOP;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA pds FROM anon;      -- tables, views, matviews
REVOKE ALL ON ALL SEQUENCES IN SCHEMA pds FROM anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pds FROM anon;
REVOKE USAGE ON SCHEMA pds FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA pds REVOKE ALL ON TABLES FROM anon;
