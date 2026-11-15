-- ============================================================================
-- Pollen (Atlanta): one row per published daily count (pollen_etl.py)
-- ============================================================================
-- Source: the keyless public pollen page of Atlanta Allergy & Asthma
-- (atlantaallergy.com/pollen_counts), the Atlanta counting station certified by
-- the National Allergy Bureau. Polite scraping of a clinic site (robots.txt allows
-- all, no reuse statement): stored privately, one request per routine run.
--
-- count_date is the date the count is PUBLISHED for. The count is the number of
-- pollen grains per cubic metre of air over the previous 24 hours, sampled up to
-- the morning of count_date, so it mostly describes clock day count_date - 1.
-- Anything that lines it up with other data (e.g. a future HRV feature) moves it
-- one day EARLIER by date, the same move hrv_alignment.wake_date_to_closing_day
-- makes; it is deliberately not named calendar_date so nobody joins it same-day
-- by accident.
--
-- Missing is missing: the station does not count most weekends and holidays and
-- some days are published as "N/A". Those days have NO row (never a zero), and the
-- ETL never overwrites a stored count with an empty cell. A published 0 is a 0.
--
-- Columns from the month calendar (every day of the month, refreshed each run):
--   total_count, count_level. Columns from the day's own block (only the day the
--   ETL fetched; NULL for days seen only in the calendar): the tree / grass / weed
--   levels and top contributors, and the mold level. Levels are the site's own
--   bands: low / medium / high / extreme (mold "Moderate" = medium, "Extremely
--   High" = extreme).
--
-- Atlanta only: the series ends at the NYC move. Only a date is stored (no
-- timestamptz instant), so there are no onyx_*_date columns.
--
-- Access: RLS on; the owner account may read it in the browser (owner_read, the
-- pattern in sql/pds_owner_only_read.sql), the service role writes it (ETL) and
-- /api/status reads it. anon gets nothing.
--
-- Safe to re-run (IF NOT EXISTS everywhere). Contains no statement that removes an
-- object, so the Supabase MCP connector will not refuse it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.pollen_daily (
    count_date          DATE        PRIMARY KEY,                        -- date the count is published for (covers the 24 h before that morning)
    total_count         INTEGER     NOT NULL CHECK (total_count >= 0),  -- grains per m3 of air over 24 h, all pollen
    count_level         TEXT        CHECK (count_level IN ('low', 'medium', 'high', 'extreme')),
    tree_level          TEXT        CHECK (tree_level  IN ('low', 'medium', 'high', 'extreme')),
    grass_level         TEXT        CHECK (grass_level IN ('low', 'medium', 'high', 'extreme')),
    weed_level          TEXT        CHECK (weed_level  IN ('low', 'medium', 'high', 'extreme')),
    mold_level          TEXT        CHECK (mold_level  IN ('low', 'medium', 'high', 'extreme')),
    tree_contributors   TEXT,                                           -- as published, e.g. 'OAK, PINE, BIRCH'
    grass_contributors  TEXT,
    weed_contributors   TEXT,
    source              TEXT        NOT NULL DEFAULT 'atlanta-allergy-nab',
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE pds.pollen_daily IS
    'Daily pollen count for Atlanta (Atlanta Allergy & Asthma, NAB-certified station), one row per published count. count_date = publication date; the count covers the previous 24 hours (mostly clock day count_date - 1). Days without a count have no row. Written by pollen_etl.py; read by /api/status.';

-- ---------------------------------------------------------------------------
-- RLS + grants: owner reads, service role writes (mirrors sql/photo_meals.sql)
-- ---------------------------------------------------------------------------
ALTER TABLE pds.pollen_daily ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'pollen_daily' AND policyname = 'owner_read'
    ) THEN
        CREATE POLICY owner_read ON pds.pollen_daily FOR SELECT TO authenticated
            USING ((SELECT auth.uid()) = 'dc041abc-115a-4252-8536-803f2ac75557'::uuid);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'pollen_daily' AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.pollen_daily
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

REVOKE ALL ON pds.pollen_daily FROM anon, authenticated;
GRANT SELECT ON pds.pollen_daily TO authenticated;
GRANT ALL    ON pds.pollen_daily TO service_role;

-- Make PostgREST pick up the new table without waiting for a restart.
NOTIFY pgrst, 'reload schema';
