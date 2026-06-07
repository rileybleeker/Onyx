-- security_lockdown_2026_06_06.sql
-- ---------------------------------------------------------------------------
-- Closes the concrete anon/authenticated WRITE exposure flagged by the Supabase
-- security advisors. Applied via migration `lock_down_habit_writes_and_garmin_matviews`.
--
-- Context: the frontend reads with the public anon key; once logged in, supabase-js
-- attaches the user JWT so reads run as `authenticated`. `authenticated` has NO RLS
-- on the base tables — it only sees data through the pds SECURITY DEFINER views,
-- which is why those views are deliberately NOT flipped to security_invoker (that
-- would empty the dashboard). The real anon-read exposure (public key can read all
-- base tables) is an auth-model decision tracked separately.
--
-- What this DOES fix:
--   1. habit_journal / habit_name_map had an always-true `service_full_access`
--      policy (FOR ALL to authenticated) + anon/authenticated table-level write
--      grants, so the public key could INSERT/UPDATE/DELETE/TRUNCATE habit data
--      (advisor 0024). App writes go only via service_role API routes, so:
--        - scope service_full_access to service_role,
--        - preserve anon + authenticated SELECT (dashboard /habits reads these),
--        - revoke all writes from anon + authenticated.
--   2. Three Garmin aggregate matviews were anon/authenticated-readable over the
--      Data API (advisor 0016) and can't enforce RLS. Frontend doesn't use them →
--      revoke anon/authenticated SELECT.
--   3. Drop the redundant duplicate permissive anon SELECT policy on whoop_journal
--      (advisor 0006).
--
-- Deliberately deferred (separate decisions, NOT applied here):
--   * 23 SECURITY DEFINER views -> security_invoker: would break the authenticated
--     dashboard (see above); the meaningful fix is the require-auth-for-reads
--     architectural decision.
--   * 44 functions with mutable search_path (advisor 0011): pin to
--     `pds, public, pg_temp` (must keep `public` so pgvector/pg_partman resolve in
--     search_journal_entries etc.) — deferred to avoid the extension-resolution risk.
--   * Extensions in public, leaked-password protection toggle — low severity.
-- ---------------------------------------------------------------------------

-- habit_journal: service_role full; anon+authenticated read-only.
DROP POLICY IF EXISTS service_full_access ON pds.habit_journal;
CREATE POLICY service_full_access ON pds.habit_journal FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY authenticated_read ON pds.habit_journal FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON pds.habit_journal FROM anon, authenticated;

-- habit_name_map: same treatment.
DROP POLICY IF EXISTS service_full_access ON pds.habit_name_map;
CREATE POLICY service_full_access ON pds.habit_name_map FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY authenticated_read ON pds.habit_name_map FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON pds.habit_name_map FROM anon, authenticated;

-- Garmin aggregate matviews: not on the Data API surface.
REVOKE SELECT ON pds.garmin_weekly_summary, pds.garmin_weekly_sleep, pds.garmin_monthly_summary FROM anon, authenticated;

-- Remove the duplicate permissive anon SELECT policy on whoop_journal (keep anon_read).
DROP POLICY IF EXISTS "Allow anon read access on whoop_journal" ON pds.whoop_journal;
