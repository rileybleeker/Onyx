-- ============================================
-- RLS Policies for Onyx (pds schema)
-- ============================================
-- Run this in the Supabase SQL Editor.
--
-- Two-role model:
--   anon (read-only)       - frontend public reads via NEXT_PUBLIC_SUPABASE_ANON_KEY
--   service_role (writes)  - ETL + server-side API routes via SUPABASE_SERVICE_ROLE_KEY
--   authenticated          - Supabase Auth logged-in users; same read scope as anon by
--                            default, with two exceptions (habit_journal, habit_name_map)
--                            where the auth flow needs writes.
--
-- IMPORTANT: service_full_access policies must target service_role (NOT public).
-- Targeting public would silently widen the trust boundary if any anon write grant
-- ever lands. Audit re-2026-05-26 tightened this.

-- ---- 1) Enable RLS on every pds table ----
ALTER TABLE pds.garmin_daily_summary       ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_sleep               ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_heart_rate          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_hrv                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_stress              ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_training_status     ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_activities          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_activity_laps       ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_workouts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_sleep                ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_recovery             ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_cycles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_workouts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_journal              ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_body_measurements    ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.eight_sleep_trends         ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.habit_journal              ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.habit_metadata_history     ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.habit_name_map             ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.journal_entries            ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.meal_events                ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.myfitnesspal_nutrition     ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.spotify_artists            ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.spotify_playlists          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.spotify_plays              ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.spotify_tracks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.supplement_intake          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.supplement_products        ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.sync_log                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.user_tz_log                ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.weight_log                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.hrv_predictions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.hrv_model_metrics          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.hrv_analysis_results       ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.ci_tokens                  ENABLE ROW LEVEL SECURITY;

-- ---- 2) anon read-only policies ----
CREATE POLICY "anon_read" ON pds.garmin_daily_summary       FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_sleep               FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_heart_rate          FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_hrv                 FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_stress              FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_training_status     FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_activities          FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_activity_laps       FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_garmin_workouts" ON pds.garmin_workouts FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.whoop_sleep                FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.whoop_recovery             FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.whoop_cycles               FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.whoop_workouts             FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.whoop_journal              FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.eight_sleep_trends         FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.habit_journal              FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.habit_metadata_history     FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.habit_name_map             FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.journal_entries            FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.meal_events                FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.myfitnesspal_nutrition     FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.spotify_artists            FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.spotify_playlists          FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.spotify_plays              FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.spotify_tracks             FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.supplement_intake          FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.supplement_products        FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.sync_log                   FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.weight_log                 FOR SELECT TO anon USING (true);
CREATE POLICY "user_tz_log_anon_read" ON pds.user_tz_log    FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "anon_read_predictions" ON pds.hrv_predictions       FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_metrics"     ON pds.hrv_model_metrics     FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_analysis"    ON pds.hrv_analysis_results  FOR SELECT TO anon USING (true);

-- ---- 3) service_full_access — service_role only (never TO public) ----
-- Pattern: FOR ALL TO service_role USING (true) WITH CHECK (true).
-- Applies on every writeable pds table.
CREATE POLICY "service_full_access" ON pds.garmin_daily_summary       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.garmin_sleep               FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.garmin_heart_rate          FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.garmin_hrv                 FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.garmin_stress              FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.garmin_training_status     FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.garmin_activities          FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.garmin_activity_laps       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.garmin_workouts            FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.whoop_sleep                FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.whoop_recovery             FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.whoop_cycles               FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.whoop_workouts             FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.whoop_journal              FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.whoop_body_measurements    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.eight_sleep_trends         FOR ALL TO service_role USING (true) WITH CHECK (true);
-- habit_journal + habit_name_map intentionally also include `authenticated`:
-- the Notion-backed habit-rename + manual completion flow runs from the
-- authenticated session, not the service role.
CREATE POLICY "service_full_access" ON pds.habit_journal              FOR ALL TO authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.habit_metadata_history     FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.habit_name_map             FOR ALL TO authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.journal_entries            FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.meal_events                FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.myfitnesspal_nutrition     FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.spotify_artists            FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.spotify_playlists          FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.spotify_plays              FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.spotify_tracks             FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.supplement_intake          FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.supplement_products        FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.sync_log                   FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "user_tz_log_service_all" ON pds.user_tz_log            FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access" ON pds.weight_log                 FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_write_predictions" ON pds.hrv_predictions      FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_write_metrics"     ON pds.hrv_model_metrics    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_write_analysis"    ON pds.hrv_analysis_results FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---- 4) Schema-level grants ----
GRANT USAGE ON SCHEMA pds TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA pds TO anon, authenticated;
GRANT ALL    ON ALL TABLES IN SCHEMA pds TO service_role;

-- Auto-grant SELECT on any future tables created in pds schema
ALTER DEFAULT PRIVILEGES IN SCHEMA pds GRANT SELECT ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA pds GRANT ALL    ON TABLES TO service_role;

-- ---- 5) Defense-in-depth — revoke from PUBLIC ----
-- No current grants to public exist; this keeps any future GRANT ... TO PUBLIC
-- an explicit decision rather than an accidental widening.
REVOKE ALL ON ALL TABLES IN SCHEMA pds FROM PUBLIC;
REVOKE ALL ON SCHEMA pds FROM PUBLIC;
