-- ============================================
-- RLS Policies for Onyx Frontend (anon key)
-- ============================================
-- Run this in the Supabase SQL Editor.
-- Grants read-only access to all pds tables via the anon key.
-- Since this is a personal project (single user), we allow
-- all SELECT queries but deny INSERT/UPDATE/DELETE via anon.

-- Enable RLS on all tables
ALTER TABLE pds.garmin_daily_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_sleep ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_heart_rate ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_hrv ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_stress ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_training_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_activity_laps ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.garmin_body_composition ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_sleep ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_workouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.whoop_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.sync_log ENABLE ROW LEVEL SECURITY;

-- Read-only policies for anon role
CREATE POLICY "anon_read" ON pds.garmin_daily_summary FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_sleep FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_heart_rate FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_hrv FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_stress FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_training_status FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_activities FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_activity_laps FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.garmin_body_composition FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.whoop_sleep FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.whoop_recovery FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.whoop_cycles FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.whoop_workouts FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.whoop_journal FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.sync_log FOR SELECT TO anon USING (true);

-- Grant usage on the pds schema to anon and authenticated
GRANT USAGE ON SCHEMA pds TO anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA pds TO anon, authenticated;

-- Auto-grant SELECT on any future tables created in pds schema
-- (GRANT SELECT ON ALL TABLES only covers tables that exist at run time;
--  new tables need this default privilege or they'll get 401 from PostgREST)
ALTER DEFAULT PRIVILEGES IN SCHEMA pds GRANT SELECT ON TABLES TO anon, authenticated;
