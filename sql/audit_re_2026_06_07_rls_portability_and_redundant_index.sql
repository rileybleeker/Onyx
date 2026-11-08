-- Repo mirror of Supabase migration 20260608015255
-- (audit_re_2026_06_07_rls_portability_and_redundant_index). Already applied live.

-- Re-audit 2026-06-07 (schema gpt-5/F-012, gemini/F-007, deepseek/F-004): add explicit
-- FOR ALL TO service_role policies to the 3 tables that relied solely on service_role's
-- BypassRLS (portability + consistency; does NOT widen anon access — service_role only).
DROP POLICY IF EXISTS service_full_access ON pds.ci_tokens;
CREATE POLICY service_full_access ON pds.ci_tokens
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_full_access ON pds.supplement_stack;
CREATE POLICY service_full_access ON pds.supplement_stack
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS service_full_access ON pds.supplement_stack_item;
CREATE POLICY service_full_access ON pds.supplement_stack_item
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Re-audit 2026-06-07 (schema gpt-5/F-006): idx_laps_activity (activity_id, lap_index) is a
-- redundant leftmost prefix of UNIQUE (activity_id, lap_index, ts) — drop it.
DROP INDEX IF EXISTS pds.idx_laps_activity;
