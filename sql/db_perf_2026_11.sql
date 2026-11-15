-- ============================================================================
-- sql/db_perf_2026_11.sql  (2026-11-14, claude for Riley; NOT applied yet)
-- DB perf follow-up to the 2026-06-07 re-audit: partitioning, materialized
-- supplement rollups, redundant indexes. Notion row 379bf5b4-4bf2-8116-8d00-f8de9c6a0572.
-- Measurements and the decision per finding: docs/db-perf-2026-11.md.
-- ============================================================================
--
-- WHAT IS WORTH DOING (numbers from pg_stat_statements / catalog, 2026-11-11 07:21Z
-- restart to 2026-11-15 03:22Z = 3.8 days):
--   * Supplement rollup (PART 2). pds.supplement_intake_by_compound expands every
--     intake x product ingredient (18,236 JSONB rows) and parses units with regexes
--     on every read. hrv_analysis.py reads it in 11 PostgREST pages and each page
--     recomputes it: 1,287 calls, 95 ms mean, 122 s total. /nutrition and the chat
--     tool read pds.daily_micronutrient_totals, which recomputes it too: 785 calls,
--     169-211 ms mean, 143 s total, plus 1.14 GB of temp-file writes (a hash
--     aggregate over work_mem). Together about as much DB time as the whole
--     refresh_perf_matviews job. A matview makes both reads cheap scans.
--   * whoop_cycles compaction (PART 4, by hand). 741 rows, 425 kB of live data in
--     a 40 MB heap (99% empty). It is the most-read table: 41.2M page reads in 3.8
--     days, every full read touching 5,107 pages instead of ~55.
--
-- NOT WORTH IT NOW: partitioning hrv_predictions (22,097 rows, 15 MB, ~1,800 new
-- rows a month: 1M rows is decades away) and whoop_journal (12,360 rows, frozen
-- since 2026-06-08). The garmin_activity_laps (activity_id, lap_index) index the
-- audit named was already removed on 2026-06-08 (migration 20260608015255).
-- PART 5 lists 12 other prefix-redundant indexes: 656 kB in total, no measurable
-- gain, optional hygiene.
--
-- HOW TO APPLY (Riley)
--   1. PART 1, dry run, read-only. Every check should come back as expected.
--   2. PART 2 as one migration: Supabase MCP apply_migration, or paste it into the
--      dashboard SQL editor. Everything above the PART 4 banner is free of the
--      words the MCP refuses, so "PART 2 banner to END OF PART 2" can be sent
--      as-is. It is additive: one matview, one 1-row state table, one function,
--      one pg_cron job, and daily_micronutrient_totals re-pointed at the matview
--      (same columns, same rows; the guard at the top of PART 2 stops the whole
--      migration before it creates anything if that view changed since this file
--      was written). Re-running PART 2 is safe.
--   3. PART 3, verification, read-only.
--   4. By hand in the SQL editor, one statement at a time, if you agree:
--      PART 4 (compaction) and PART 5 (redundant indexes). Both commented out.
--   PART 6 is the rollback for PART 2 (commented out).
--
-- FRESHNESS: the matview is refreshed by pg_cron every 5 minutes, and only when
-- its inputs changed (a fingerprint of supplement_intake, supplement_products, the
-- view definition and the unit-conversion functions), plus once a day regardless.
-- So a logged dose shows up in hrv_analysis.py and /nutrition's vitamin totals
-- within 5 minutes. /supplements and /api/supplements/today keep reading the live
-- tables and view, so the logging screen itself is unchanged and instant. No
-- trigger is added to the supplement tables: logging a dose costs exactly what it
-- costs today. Refresh cost about 0.3-0.5 s, about twice a day at today's logging
-- rate (6 write statements in 3.8 days). If a refresh fails, the matview keeps
-- its last good rows, a 'failed' heartbeat is written, and it retries hourly.
--
-- SCHEMA-DRIFT RULE (same as the other _mat copies): if a migration changes the
-- columns of pds.supplement_intake_by_compound, recreate
-- pds.supplement_intake_by_compound_mat (+ its unique index + grants) in the same
-- migration. A cascading removal of that view would now also take the matview and
-- daily_micronutrient_totals with it. A column mismatch is reported as a failed
-- 'supplement_mat' heartbeat in pds.sync_log. After changing the view or the
-- unit-conversion functions, the next 5-minute tick refreshes on its own (they
-- are part of the fingerprint); SELECT pds.refresh_supplement_intake_by_compound_mat(true)
-- forces it at once.


-- ============================================================================
-- PART 1 — DRY RUN (read-only; run before PART 2)
-- ============================================================================

-- 1a. The rollup's group key is unique, so the matview's unique index will build.
--     Expect 0. (2026-11-14: 0)
SELECT count(*) AS dup_group_keys
FROM (SELECT calendar_date, compound_key, ingredient_group, unii_code, unit_class
        FROM pds.supplement_intake_by_compound
       GROUP BY 1, 2, 3, 4, 5 HAVING count(*) > 1) d;

-- 1b. Size of what the matview will hold. (2026-11-14: 10,609 rows, ~2.1 MB, ~280 ms)
SELECT count(*) AS rows_, pg_size_pretty(sum(pg_column_size(t.*))) AS est_size,
       round(extract(epoch FROM clock_timestamp() - statement_timestamp()) * 1000) AS compute_ms
FROM pds.supplement_intake_by_compound t;

-- 1c. daily_micronutrient_totals is exactly the definition 2d was generated from,
--     and has no view options (CREATE OR REPLACE VIEW would reset them).
--     Expect true, true. If either is false, regenerate 2d first.
SELECT md5(pg_get_viewdef('pds.daily_micronutrient_totals'::regclass, true))
       = '2264c161d74ad870ddf18dc1bca572b6' AS dmt_unchanged,
       (SELECT reloptions FROM pg_class WHERE oid = 'pds.daily_micronutrient_totals'::regclass) IS NULL AS dmt_no_options;

-- 1d. pg_cron is installed and the job name is free. Expect a version and 0.
SELECT (SELECT extversion FROM pg_extension WHERE extname = 'pg_cron') AS pg_cron,
       (SELECT count(*) FROM cron.job WHERE jobname = 'refresh_supplement_rollup_mat') AS existing_job;

-- 1e. None of the new objects exist yet. Expect 0 rows.
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'pds'
  AND c.relname IN ('supplement_intake_by_compound_mat', 'supplement_rollup_refresh_state');

-- (Also run on 2026-11-14, too long to repeat here: the 2d definition evaluated
--  over a snapshot of the live rollup matched today's daily_micronutrient_totals
--  row for row, 179 = 179 rows, 0 differences in either direction.)


-- ============================================================================
-- PART 2 — APPLY (additive; one migration; safe to re-run)
-- ============================================================================

-- Guard first, so nothing is created if it fails: daily_micronutrient_totals must
-- be the 2026-11-14 definition (or already point at the matview, on a re-run)
-- and carry no view options.
DO $guard$
DECLARE
  def text := pg_get_viewdef('pds.daily_micronutrient_totals'::regclass, true);
BEGIN
  IF (SELECT reloptions FROM pg_class WHERE oid = 'pds.daily_micronutrient_totals'::regclass) IS NOT NULL THEN
    RAISE EXCEPTION 'pds.daily_micronutrient_totals has view options that section 2d would reset; add them to 2d first';
  END IF;
  IF md5(def) <> '2264c161d74ad870ddf18dc1bca572b6' AND position('supplement_intake_by_compound_mat' IN def) = 0 THEN
    RAISE EXCEPTION 'pds.daily_micronutrient_totals changed after 2026-11-14; regenerate section 2d of sql/db_perf_2026_11.sql before applying it';
  END IF;
END
$guard$;

-- 2a. The matview: a 1:1 copy of the live rollup. The unique index is the
--     rollup's own GROUP BY key (NULLS NOT DISTINCT, as GROUP BY treats NULLs),
--     leads with calendar_date for date-range reads, and is a tripwire: a
--     duplicate key would make the refresh fail loudly instead of serving doubles.
--     Plain CREATE INDEX (not CONCURRENTLY) on purpose: the matview is brand new
--     and unread, and CONCURRENTLY cannot run inside a migration's transaction.
CREATE MATERIALIZED VIEW IF NOT EXISTS pds.supplement_intake_by_compound_mat AS
  SELECT * FROM pds.supplement_intake_by_compound
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplement_intake_by_compound_mat_key
  ON pds.supplement_intake_by_compound_mat
     (calendar_date, compound_key, ingredient_group, unii_code, unit_class) NULLS NOT DISTINCT;

-- Readable by service_role only (hrv_analysis.py). daily_micronutrient_totals
-- runs with its owner's rights, so /nutrition and chat need no grant here, and
-- the matview stays off the Data API for anon/authenticated, like the Garmin
-- matviews since security_lockdown_2026_06_06.sql.
REVOKE ALL ON pds.supplement_intake_by_compound_mat FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pds.supplement_intake_by_compound_mat TO service_role;

-- 2b. One-row state: the fingerprint of the inputs at the last refresh.
CREATE TABLE IF NOT EXISTS pds.supplement_rollup_refresh_state (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  source_fingerprint text,
  refreshed_at       timestamptz,
  failed_at          timestamptz
);
ALTER TABLE pds.supplement_rollup_refresh_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.supplement_rollup_refresh_state FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE pds.supplement_rollup_refresh_state IS
  'One row. Fingerprint of the supplement rollup inputs at the last refresh of supplement_intake_by_compound_mat (sql/db_perf_2026_11.sql). Written only by pds.refresh_supplement_intake_by_compound_mat().';

-- 2c. Refresh-if-changed. Called by pg_cron every 5 minutes; refreshes only when
--     the fingerprint moved or the last refresh is over a day old (or force).
--     Never raises: any failure is a 'failed' heartbeat and the matview keeps its
--     last good rows. Heartbeat only when it refreshes (about twice a day). After
--     a failure it waits an hour before retrying, so a persistent error writes at
--     most 24 heartbeats a day instead of 288 (the /status history window is the
--     newest 100 sync_log rows).
CREATE OR REPLACE FUNCTION pds.refresh_supplement_intake_by_compound_mat(force boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pds', 'pg_catalog'
SET lock_timeout TO '5s'
AS $function$
DECLARE
  t0        timestamptz := clock_timestamp();
  fp        text;
  prev_fp   text;
  last_ok   timestamptz;
  last_fail timestamptz;
  n         integer;
  drift     text;
BEGIN
  -- Everything the rollup's output depends on. ~10-25 ms (2026-11-14).
  SELECT concat_ws(':',
           (SELECT count(*) || '/' || coalesce(sum(hashtextextended(
                     concat_ws('|', i.intake_id, i.intake_date, i.product_id, i.doses), 0)), 0)
              FROM pds.supplement_intake i),
           (SELECT count(*) || '/' || coalesce(sum(hashtextextended(
                     concat_ws('|', p.product_id, p.ingredients), 0)), 0)
              FROM pds.supplement_products p),
           md5(pg_get_viewdef('pds.supplement_intake_by_compound'::regclass)),
           (SELECT md5(string_agg(p.prosrc, '|' ORDER BY p.proname))
              FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
             WHERE ns.nspname = 'pds' AND p.proname IN ('unit_to_mg_factor', 'unit_to_mg_factor_for')))
    INTO fp;

  SELECT s.source_fingerprint, s.refreshed_at, s.failed_at INTO prev_fp, last_ok, last_fail
    FROM pds.supplement_rollup_refresh_state s WHERE s.id = 1;

  IF NOT force AND last_fail > now() - interval '1 hour' THEN
    RETURN;  -- failed within the hour: back off
  END IF;
  IF NOT force AND fp IS NOT DISTINCT FROM prev_fp AND last_ok > now() - interval '1 day' THEN
    RETURN;  -- inputs unchanged: no write, no heartbeat
  END IF;

  -- Columns of the live view missing from the matview (atttypid 0 = a removed column).
  SELECT string_agg(attname, ', ') INTO drift FROM (
    SELECT a.attname FROM pg_attribute a
     WHERE a.attrelid = 'pds.supplement_intake_by_compound'::regclass AND a.attnum > 0 AND a.atttypid <> 0
    EXCEPT
    SELECT a.attname FROM pg_attribute a
     WHERE a.attrelid = 'pds.supplement_intake_by_compound_mat'::regclass AND a.attnum > 0 AND a.atttypid <> 0) d;

  -- Plain REFRESH: about two ~2.4 MB rebuilds a day, so the simple form is enough.
  -- Readers wait for the ~0.3-0.5 s rebuild; lock_timeout (5 s, on the function)
  -- makes it give up instead of queueing behind a long reader.
  REFRESH MATERIALIZED VIEW pds.supplement_intake_by_compound_mat;
  SELECT count(*) INTO n FROM pds.supplement_intake_by_compound_mat;

  INSERT INTO pds.supplement_rollup_refresh_state (id, source_fingerprint, refreshed_at, failed_at)
  VALUES (1, fp, clock_timestamp(), NULL)
  ON CONFLICT (id) DO UPDATE
    SET source_fingerprint = EXCLUDED.source_fingerprint, refreshed_at = EXCLUDED.refreshed_at,
        failed_at = NULL;

  INSERT INTO pds.sync_log (source, data_type, status, records_synced, error_message,
                            sync_start, sync_end, duration_seconds)
  VALUES ('supplement_mat', 'refresh',
          CASE WHEN drift IS NULL THEN 'success' ELSE 'failed' END, n,
          CASE WHEN drift IS NULL THEN NULL
               ELSE 'schema drift: view columns missing from supplement_intake_by_compound_mat '
                    '(recreate it in the same migration as the view change): ' || drift END,
          t0, clock_timestamp(), EXTRACT(EPOCH FROM clock_timestamp() - t0));
EXCEPTION WHEN OTHERS THEN
  -- Everything above was rolled back; record the failure time for the back-off.
  BEGIN
    INSERT INTO pds.supplement_rollup_refresh_state (id, failed_at) VALUES (1, clock_timestamp())
    ON CONFLICT (id) DO UPDATE SET failed_at = EXCLUDED.failed_at;
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- state table unusable: still write the heartbeat below
  END;
  INSERT INTO pds.sync_log (source, data_type, status, records_synced, error_message,
                            sync_start, sync_end, duration_seconds)
  VALUES ('supplement_mat', 'refresh', 'failed', 0, SQLERRM,
          t0, clock_timestamp(), EXTRACT(EPOCH FROM clock_timestamp() - t0));
END
$function$;

REVOKE ALL ON FUNCTION pds.refresh_supplement_intake_by_compound_mat(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.refresh_supplement_intake_by_compound_mat(boolean) TO service_role;

COMMENT ON MATERIALIZED VIEW pds.supplement_intake_by_compound_mat IS
  '1:1 copy of pds.supplement_intake_by_compound for bulk reads (hrv_analysis.py, daily_micronutrient_totals). Refreshed within 5 min of an input change by pds.refresh_supplement_intake_by_compound_mat() (pg_cron refresh_supplement_rollup_mat); heartbeat source supplement_mat. Point reads (/api/supplements/today) stay on the live view. sql/db_perf_2026_11.sql.';

-- Record the fingerprint now and write the first heartbeat (also a smoke test of
-- the function; the matview already holds the same rows).
SELECT pds.refresh_supplement_intake_by_compound_mat(true);

-- Every 5 minutes at :03, :08, ... :58, clear of the :10/:12/:40/:42 matview
-- refreshes. A tick with unchanged inputs only computes the fingerprint.
-- cron.schedule with a job name updates the job if it exists (idempotent).
SELECT cron.schedule(
  'refresh_supplement_rollup_mat',
  '3-58/5 * * * *',
  'SELECT pds.refresh_supplement_intake_by_compound_mat()'
);

-- 2d. daily_micronutrient_totals reads the matview instead of re-expanding the
--     JSONB rollup. Only the FROM of the supp CTE changes (aliased to the old name
--     so every column reference stays identical); same columns, same rows. The
--     guard at the top of PART 2 checked that the live view is the one this was
--     made from. Grants on the view are kept by CREATE OR REPLACE.
CREATE OR REPLACE VIEW pds.daily_micronutrient_totals AS
 WITH supp AS (
         SELECT supplement_intake_by_compound.calendar_date AS d,
            sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin A'::text) AS vit_a_rae_mcg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin C'::text) AS vit_c_mg,
            sum(supplement_intake_by_compound.total_amount * 40000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin D'::text) AS vit_d_iu,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin E'::text) AS vit_e_mg,
            sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin K'::text) AS vit_k_mcg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Thiamin'::text) AS b1_thiamine_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Riboflavin'::text) AS b2_riboflavin_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Niacin'::text) AS b3_niacin_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = ANY (ARRAY['Pantothenic Acid (Vitamin B5)'::text, 'Vitamin B5 (Pantothenic Acid)'::text])) AS b5_pantothenic_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin B6'::text) AS b6_pyridoxine_mg,
            sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group ~~* 'Vitamin B12%'::text) AS b12_cobalamin_mcg,
            sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Folate'::text) AS folate_mcg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Calcium'::text) AS calcium_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Iron'::text) AS iron_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Magnesium'::text) AS magnesium_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Phosphorus'::text) AS phosphorus_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Potassium'::text) AS potassium_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Zinc'::text) AS zinc_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Copper'::text) AS copper_mg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Manganese'::text) AS manganese_mg,
            sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Selenium'::text) AS selenium_mcg,
            sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Sodium'::text) AS sodium_mg,
            sum(supplement_intake_by_compound.total_amount / 1000.0) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Omega-3'::text) AS omega3_g,
            sum(supplement_intake_by_compound.total_amount / 1000.0) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'EPA (Eicosapentaenoic Acid)'::text) AS epa_g,
            sum(supplement_intake_by_compound.total_amount / 1000.0) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'DHA (Docosahexaenoic Acid)'::text) AS dha_g
           FROM pds.supplement_intake_by_compound_mat supplement_intake_by_compound
          GROUP BY supplement_intake_by_compound.calendar_date
        )
 SELECT COALESCE(cn.onyx_behavioral_date, supp.d) AS onyx_behavioral_date,
    cn.vit_a_rae_mcg AS vit_a_dietary_mcg,
    supp.vit_a_rae_mcg AS vit_a_supplement_mcg,
    COALESCE(cn.vit_a_rae_mcg, 0::numeric) + COALESCE(supp.vit_a_rae_mcg, 0::numeric) AS vit_a_total_mcg,
    cn.vit_c_mg AS vit_c_dietary_mg,
    supp.vit_c_mg AS vit_c_supplement_mg,
    COALESCE(cn.vit_c_mg, 0::numeric) + COALESCE(supp.vit_c_mg, 0::numeric) AS vit_c_total_mg,
    cn.vit_d_iu AS vit_d_dietary_iu,
    supp.vit_d_iu AS vit_d_supplement_iu,
    COALESCE(cn.vit_d_iu, 0::numeric) + COALESCE(supp.vit_d_iu, 0::numeric) AS vit_d_total_iu,
    cn.vit_e_mg AS vit_e_dietary_mg,
    supp.vit_e_mg AS vit_e_supplement_mg,
    COALESCE(cn.vit_e_mg, 0::numeric) + COALESCE(supp.vit_e_mg, 0::numeric) AS vit_e_total_mg,
    cn.vit_k_mcg AS vit_k_dietary_mcg,
    supp.vit_k_mcg AS vit_k_supplement_mcg,
    COALESCE(cn.vit_k_mcg, 0::numeric) + COALESCE(supp.vit_k_mcg, 0::numeric) AS vit_k_total_mcg,
    cn.b1_thiamine_mg AS b1_dietary_mg,
    supp.b1_thiamine_mg AS b1_supplement_mg,
    COALESCE(cn.b1_thiamine_mg, 0::numeric) + COALESCE(supp.b1_thiamine_mg, 0::numeric) AS b1_total_mg,
    cn.b2_riboflavin_mg AS b2_dietary_mg,
    supp.b2_riboflavin_mg AS b2_supplement_mg,
    COALESCE(cn.b2_riboflavin_mg, 0::numeric) + COALESCE(supp.b2_riboflavin_mg, 0::numeric) AS b2_total_mg,
    cn.b3_niacin_mg AS b3_dietary_mg,
    supp.b3_niacin_mg AS b3_supplement_mg,
    COALESCE(cn.b3_niacin_mg, 0::numeric) + COALESCE(supp.b3_niacin_mg, 0::numeric) AS b3_total_mg,
    cn.b5_pantothenic_mg AS b5_dietary_mg,
    supp.b5_pantothenic_mg AS b5_supplement_mg,
    COALESCE(cn.b5_pantothenic_mg, 0::numeric) + COALESCE(supp.b5_pantothenic_mg, 0::numeric) AS b5_total_mg,
    cn.b6_pyridoxine_mg AS b6_dietary_mg,
    supp.b6_pyridoxine_mg AS b6_supplement_mg,
    COALESCE(cn.b6_pyridoxine_mg, 0::numeric) + COALESCE(supp.b6_pyridoxine_mg, 0::numeric) AS b6_total_mg,
    cn.b12_cobalamin_mcg AS b12_dietary_mcg,
    supp.b12_cobalamin_mcg AS b12_supplement_mcg,
    COALESCE(cn.b12_cobalamin_mcg, 0::numeric) + COALESCE(supp.b12_cobalamin_mcg, 0::numeric) AS b12_total_mcg,
    cn.folate_mcg AS folate_dietary_mcg,
    supp.folate_mcg AS folate_supplement_mcg,
    COALESCE(cn.folate_mcg, 0::numeric) + COALESCE(supp.folate_mcg, 0::numeric) AS folate_total_mcg,
    cn.calcium_mg AS calcium_dietary_mg,
    supp.calcium_mg AS calcium_supplement_mg,
    COALESCE(cn.calcium_mg, 0::numeric) + COALESCE(supp.calcium_mg, 0::numeric) AS calcium_total_mg,
    cn.iron_mg AS iron_dietary_mg,
    supp.iron_mg AS iron_supplement_mg,
    COALESCE(cn.iron_mg, 0::numeric) + COALESCE(supp.iron_mg, 0::numeric) AS iron_total_mg,
    cn.magnesium_mg AS magnesium_dietary_mg,
    supp.magnesium_mg AS magnesium_supplement_mg,
    COALESCE(cn.magnesium_mg, 0::numeric) + COALESCE(supp.magnesium_mg, 0::numeric) AS magnesium_total_mg,
    cn.phosphorus_mg AS phosphorus_dietary_mg,
    supp.phosphorus_mg AS phosphorus_supplement_mg,
    COALESCE(cn.phosphorus_mg, 0::numeric) + COALESCE(supp.phosphorus_mg, 0::numeric) AS phosphorus_total_mg,
    cn.potassium_mg AS potassium_dietary_mg,
    supp.potassium_mg AS potassium_supplement_mg,
    COALESCE(cn.potassium_mg, 0::numeric) + COALESCE(supp.potassium_mg, 0::numeric) AS potassium_total_mg,
    cn.zinc_mg AS zinc_dietary_mg,
    supp.zinc_mg AS zinc_supplement_mg,
    COALESCE(cn.zinc_mg, 0::numeric) + COALESCE(supp.zinc_mg, 0::numeric) AS zinc_total_mg,
    cn.copper_mg AS copper_dietary_mg,
    supp.copper_mg AS copper_supplement_mg,
    COALESCE(cn.copper_mg, 0::numeric) + COALESCE(supp.copper_mg, 0::numeric) AS copper_total_mg,
    cn.manganese_mg AS manganese_dietary_mg,
    supp.manganese_mg AS manganese_supplement_mg,
    COALESCE(cn.manganese_mg, 0::numeric) + COALESCE(supp.manganese_mg, 0::numeric) AS manganese_total_mg,
    cn.selenium_mcg AS selenium_dietary_mcg,
    supp.selenium_mcg AS selenium_supplement_mcg,
    COALESCE(cn.selenium_mcg, 0::numeric) + COALESCE(supp.selenium_mcg, 0::numeric) AS selenium_total_mcg,
    cn.sodium_mg AS sodium_dietary_mg,
    supp.sodium_mg AS sodium_supplement_mg,
    COALESCE(cn.sodium_mg, 0::numeric) + COALESCE(supp.sodium_mg, 0::numeric) AS sodium_total_mg,
    cn.omega3_g AS omega3_dietary_g,
    supp.omega3_g AS omega3_supplement_g,
    COALESCE(cn.omega3_g, 0::numeric) + COALESCE(supp.omega3_g, 0::numeric) AS omega3_total_g,
    cn.epa_g AS epa_dietary_g,
    supp.epa_g AS epa_supplement_g,
    COALESCE(cn.epa_g, 0::numeric) + COALESCE(supp.epa_g, 0::numeric) AS epa_total_g,
    cn.dha_g AS dha_dietary_g,
    supp.dha_g AS dha_supplement_g,
    COALESCE(cn.dha_g, 0::numeric) + COALESCE(supp.dha_g, 0::numeric) AS dha_total_g
   FROM pds.cronometer_nutrition_behavioral_daily cn
     FULL JOIN supp ON supp.d = cn.onyx_behavioral_date
  ORDER BY (COALESCE(cn.onyx_behavioral_date, supp.d)) DESC;

-- ======================= END OF PART 2 ======================================


-- ============================================================================
-- PART 3 — VERIFY (read-only; run after PART 2)
-- ============================================================================

-- 3a. The matview equals the live view in both directions. Expect 0, 0.
--     (Within 5 minutes of a logged dose it can briefly differ; run again.)
SELECT (SELECT count(*) FROM (SELECT * FROM pds.supplement_intake_by_compound
                              EXCEPT ALL SELECT * FROM pds.supplement_intake_by_compound_mat) a) AS view_minus_mat,
       (SELECT count(*) FROM (SELECT * FROM pds.supplement_intake_by_compound_mat
                              EXCEPT ALL SELECT * FROM pds.supplement_intake_by_compound) b) AS mat_minus_view;

-- 3b. The refresh ran and logged success. Expect status 'success', ~10.6k records, < 1 s.
SELECT status, records_synced, error_message, round(duration_seconds::numeric, 2) AS secs, sync_start
FROM pds.sync_log WHERE source = 'supplement_mat' ORDER BY sync_start DESC LIMIT 3;

-- 3c. The job is scheduled and active.
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'refresh_supplement_rollup_mat';

-- 3d. daily_micronutrient_totals now scans the matview. Expect a scan on
--     supplement_intake_by_compound_mat and no jsonb_array_elements / supplement_products.
EXPLAIN SELECT * FROM pds.daily_micronutrient_totals WHERE onyx_behavioral_date >= current_date - 30;

-- 3e. Only service_role reads the matview directly; /nutrition still reads
--     daily_micronutrient_totals. Expect false, true, false, true.
SELECT has_table_privilege('authenticated', 'pds.supplement_intake_by_compound_mat', 'SELECT') AS authenticated_reads,
       has_table_privilege('service_role',  'pds.supplement_intake_by_compound_mat', 'SELECT') AS service_role_reads,
       has_table_privilege('anon',          'pds.supplement_intake_by_compound_mat', 'SELECT') AS anon_reads,
       has_table_privilege('authenticated', 'pds.daily_micronutrient_totals', 'SELECT') AS nutrition_view_reads;

-- 3f. A few days later: read cost. Baseline 2026-11-14: rollup pages 95 ms mean,
--     daily_micronutrient_totals 169-211 ms mean with temp writes. Expect single-digit
--     ms on the matview and no temp_blks_written on new daily_micronutrient_totals calls
--     (pg_stat_statements is cumulative since the last restart, so old calls are mixed in).
SELECT calls, round(mean_exec_time::numeric, 1) AS mean_ms, temp_blks_written,
       left(regexp_replace(query, '\s+', ' ', 'g'), 100) AS q
FROM pg_stat_statements
WHERE query ILIKE '%supplement_intake_by_compound%' OR query ILIKE '%daily_micronutrient_totals%'
ORDER BY total_exec_time DESC LIMIT 6;

-- 3g. Bloat watch for PART 4 (any time). bytes_per_row near est_row_bytes = compact.
--     2026-11-14: whoop_cycles 56,460 vs ~581; garmin_activity_laps 3,094 vs ~1,588;
--     garmin_sleep 9,918 vs ~1,557.
SELECT c.relname, c.reltuples::bigint AS est_rows, pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       round(c.relpages::numeric * 8192 / NULLIF(c.reltuples, 0)) AS bytes_per_row,
       (SELECT sum(avg_width) + 28 FROM pg_stats s WHERE s.schemaname = 'pds' AND s.tablename = c.relname) AS est_row_bytes
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'pds' AND c.relname IN ('whoop_cycles', 'garmin_activity_laps', 'garmin_sleep');


-- ============================================================================
-- PART 4 — COMPACT BLOATED TABLES (by hand, one statement at a time)
-- ============================================================================
-- VACUUM FULL rewrites the table into a new compact file and rebuilds its
-- indexes. Data is not changed. It holds an exclusive lock while it runs (well
-- under a second for these sizes), so pick a quiet minute away from :00-:12 and
-- :40-:42 (ETL and matview refreshes). It cannot run inside a transaction or a
-- migration, so not through apply_migration.
-- SQL editor: run each VACUUM line ON ITS OWN (the editor wraps several
-- statements in one transaction, which VACUUM refuses). If one does not finish
-- within a few seconds it is waiting for a lock: cancel it and retry later.
-- psql: run `SET lock_timeout = '3s';` first in the same session, so it gives up
-- by itself instead of queueing behind a long reader.
--
-- VACUUM (FULL, ANALYZE, VERBOSE) pds.whoop_cycles;          -- 40 MB -> ~0.5 MB
-- VACUUM (FULL, ANALYZE, VERBOSE) pds.garmin_activity_laps;  -- 12 MB -> ~6 MB
-- VACUUM (FULL, ANALYZE, VERBOSE) pds.garmin_sleep;          -- 2.3 MB -> ~1.2 MB
-- Then re-run 3g. If whoop_cycles grows back past a few MB, something rewrites
-- it in bulk (a backfill) and that job is the thing to fix.


-- ============================================================================
-- PART 5 — REDUNDANT INDEXES (by hand, SQL editor, one statement at a time;
--          the Supabase MCP refuses these statements)
-- ============================================================================
-- Each index below is a leading-column prefix of another btree index on the same
-- table with the same (absent) predicate, so every lookup it serves the other
-- index serves too (btree scans either direction, so DESC is covered). Proven by
-- pg_index on 2026-11-14. Together 656 kB; no measurable speedup, they only add
-- write work and planner noise. Optional hygiene: skip the whole part if you like.
-- Scan counts since the 2026-11-11 restart; the planner will use the wider index.
--
--   index (size, scans)                              covered by
--   idx_habit_journal_date (136 kB, 8,303)           habit_journal_pkey (cycle_date, question)
--   idx_spotify_plays_date (80 kB, 3,854)            idx_spotify_plays_date_track (played_date_et, track_id)
--   idx_supplement_intake_date (64 kB, 5,697)        idx_supplement_intake_date_product (intake_date, product_id)
--   idx_sleep_calendar (56 kB, 8)                    garmin_sleep_unique (calendar_date, sleep_id, ts)
--   idx_hr_calendar (56 kB, 559,962)                 garmin_heart_rate_unique (calendar_date, ts)
--   idx_daily_calendar (56 kB, 563,376)              garmin_daily_summary_unique (calendar_date, ts)
--   idx_stress_calendar (56 kB, 389,684)             garmin_stress_unique (calendar_date, ts)
--   idx_training_cal (48 kB, 559,302)                garmin_training_status_unique (calendar_date, ts)
--   idx_hrv_calendar (40 kB, 13)                     garmin_hrv_unique (calendar_date, ts)
--   idx_eight_sleep_trends_date (32 kB, 2,106)       eight_sleep_trends_pkey (calendar_date, bed_side)
--   idx_supplement_stack_item_stack (16 kB, 399)     supplement_stack_item_stack_id_product_id_key (stack_id, product_id)
--   idx_habit_metadata_history_page_from (16 kB, 0)  habit_metadata_history_pkey (notion_page_id, valid_from)
--
-- DROP INDEX CONCURRENTLY IF EXISTS pds.idx_habit_journal_date;
-- DROP INDEX CONCURRENTLY IF EXISTS pds.idx_spotify_plays_date;
-- DROP INDEX CONCURRENTLY IF EXISTS pds.idx_supplement_intake_date;
-- DROP INDEX CONCURRENTLY IF EXISTS pds.idx_sleep_calendar;
-- DROP INDEX CONCURRENTLY IF EXISTS pds.idx_hr_calendar;
-- DROP INDEX CONCURRENTLY IF EXISTS pds.idx_daily_calendar;
-- DROP INDEX CONCURRENTLY IF EXISTS pds.idx_stress_calendar;
-- DROP INDEX CONCURRENTLY IF EXISTS pds.idx_training_cal;
-- DROP INDEX CONCURRENTLY IF EXISTS pds.idx_hrv_calendar;
-- DROP INDEX CONCURRENTLY IF EXISTS pds.idx_eight_sleep_trends_date;
-- DROP INDEX CONCURRENTLY IF EXISTS pds.idx_supplement_stack_item_stack;
-- DROP INDEX CONCURRENTLY IF EXISTS pds.idx_habit_metadata_history_page_from;
--
-- Rollback (exact definitions from pg_get_indexdef, 2026-11-14):
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_habit_journal_date ON pds.habit_journal USING btree (cycle_date);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_spotify_plays_date ON pds.spotify_plays USING btree (played_date_et);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_supplement_intake_date ON pds.supplement_intake USING btree (intake_date DESC);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sleep_calendar ON pds.garmin_sleep USING btree (calendar_date DESC);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hr_calendar ON pds.garmin_heart_rate USING btree (calendar_date DESC);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_daily_calendar ON pds.garmin_daily_summary USING btree (calendar_date DESC);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stress_calendar ON pds.garmin_stress USING btree (calendar_date DESC);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_training_cal ON pds.garmin_training_status USING btree (calendar_date DESC);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_hrv_calendar ON pds.garmin_hrv USING btree (calendar_date DESC);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_eight_sleep_trends_date ON pds.eight_sleep_trends USING btree (calendar_date);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_supplement_stack_item_stack ON pds.supplement_stack_item USING btree (stack_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_habit_metadata_history_page_from ON pds.habit_metadata_history USING btree (notion_page_id, valid_from DESC);
--
-- NOT in this list on purpose: hrv_predictions_input_hash_idx (3.4 MB, 0 scans)
-- is unused, not redundant. It is your call; see docs/db-perf-2026-11.md.


-- ============================================================================
-- PART 6 — ROLLBACK OF PART 2 (by hand, SQL editor; in this order)
-- ============================================================================
-- hrv_analysis.py falls back to the live view by itself once the matview is gone.
--
-- 6a. Point daily_micronutrient_totals back at the live view (the exact
--     2026-11-14 definition, md5 2264c161d74ad870ddf18dc1bca572b6):
-- CREATE OR REPLACE VIEW pds.daily_micronutrient_totals AS
--  WITH supp AS (
--          SELECT supplement_intake_by_compound.calendar_date AS d,
--             sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin A'::text) AS vit_a_rae_mcg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin C'::text) AS vit_c_mg,
--             sum(supplement_intake_by_compound.total_amount * 40000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin D'::text) AS vit_d_iu,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin E'::text) AS vit_e_mg,
--             sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin K'::text) AS vit_k_mcg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Thiamin'::text) AS b1_thiamine_mg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Riboflavin'::text) AS b2_riboflavin_mg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Niacin'::text) AS b3_niacin_mg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = ANY (ARRAY['Pantothenic Acid (Vitamin B5)'::text, 'Vitamin B5 (Pantothenic Acid)'::text])) AS b5_pantothenic_mg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Vitamin B6'::text) AS b6_pyridoxine_mg,
--             sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group ~~* 'Vitamin B12%'::text) AS b12_cobalamin_mcg,
--             sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Folate'::text) AS folate_mcg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Calcium'::text) AS calcium_mg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Iron'::text) AS iron_mg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Magnesium'::text) AS magnesium_mg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Phosphorus'::text) AS phosphorus_mg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Potassium'::text) AS potassium_mg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Zinc'::text) AS zinc_mg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Copper'::text) AS copper_mg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Manganese'::text) AS manganese_mg,
--             sum(supplement_intake_by_compound.total_amount * 1000::numeric) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Selenium'::text) AS selenium_mcg,
--             sum(supplement_intake_by_compound.total_amount) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Sodium'::text) AS sodium_mg,
--             sum(supplement_intake_by_compound.total_amount / 1000.0) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'Omega-3'::text) AS omega3_g,
--             sum(supplement_intake_by_compound.total_amount / 1000.0) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'EPA (Eicosapentaenoic Acid)'::text) AS epa_g,
--             sum(supplement_intake_by_compound.total_amount / 1000.0) FILTER (WHERE supplement_intake_by_compound.ingredient_group = 'DHA (Docosahexaenoic Acid)'::text) AS dha_g
--            FROM pds.supplement_intake_by_compound
--           GROUP BY supplement_intake_by_compound.calendar_date
--         )
--  SELECT COALESCE(cn.onyx_behavioral_date, supp.d) AS onyx_behavioral_date,
--     cn.vit_a_rae_mcg AS vit_a_dietary_mcg,
--     supp.vit_a_rae_mcg AS vit_a_supplement_mcg,
--     COALESCE(cn.vit_a_rae_mcg, 0::numeric) + COALESCE(supp.vit_a_rae_mcg, 0::numeric) AS vit_a_total_mcg,
--     cn.vit_c_mg AS vit_c_dietary_mg,
--     supp.vit_c_mg AS vit_c_supplement_mg,
--     COALESCE(cn.vit_c_mg, 0::numeric) + COALESCE(supp.vit_c_mg, 0::numeric) AS vit_c_total_mg,
--     cn.vit_d_iu AS vit_d_dietary_iu,
--     supp.vit_d_iu AS vit_d_supplement_iu,
--     COALESCE(cn.vit_d_iu, 0::numeric) + COALESCE(supp.vit_d_iu, 0::numeric) AS vit_d_total_iu,
--     cn.vit_e_mg AS vit_e_dietary_mg,
--     supp.vit_e_mg AS vit_e_supplement_mg,
--     COALESCE(cn.vit_e_mg, 0::numeric) + COALESCE(supp.vit_e_mg, 0::numeric) AS vit_e_total_mg,
--     cn.vit_k_mcg AS vit_k_dietary_mcg,
--     supp.vit_k_mcg AS vit_k_supplement_mcg,
--     COALESCE(cn.vit_k_mcg, 0::numeric) + COALESCE(supp.vit_k_mcg, 0::numeric) AS vit_k_total_mcg,
--     cn.b1_thiamine_mg AS b1_dietary_mg,
--     supp.b1_thiamine_mg AS b1_supplement_mg,
--     COALESCE(cn.b1_thiamine_mg, 0::numeric) + COALESCE(supp.b1_thiamine_mg, 0::numeric) AS b1_total_mg,
--     cn.b2_riboflavin_mg AS b2_dietary_mg,
--     supp.b2_riboflavin_mg AS b2_supplement_mg,
--     COALESCE(cn.b2_riboflavin_mg, 0::numeric) + COALESCE(supp.b2_riboflavin_mg, 0::numeric) AS b2_total_mg,
--     cn.b3_niacin_mg AS b3_dietary_mg,
--     supp.b3_niacin_mg AS b3_supplement_mg,
--     COALESCE(cn.b3_niacin_mg, 0::numeric) + COALESCE(supp.b3_niacin_mg, 0::numeric) AS b3_total_mg,
--     cn.b5_pantothenic_mg AS b5_dietary_mg,
--     supp.b5_pantothenic_mg AS b5_supplement_mg,
--     COALESCE(cn.b5_pantothenic_mg, 0::numeric) + COALESCE(supp.b5_pantothenic_mg, 0::numeric) AS b5_total_mg,
--     cn.b6_pyridoxine_mg AS b6_dietary_mg,
--     supp.b6_pyridoxine_mg AS b6_supplement_mg,
--     COALESCE(cn.b6_pyridoxine_mg, 0::numeric) + COALESCE(supp.b6_pyridoxine_mg, 0::numeric) AS b6_total_mg,
--     cn.b12_cobalamin_mcg AS b12_dietary_mcg,
--     supp.b12_cobalamin_mcg AS b12_supplement_mcg,
--     COALESCE(cn.b12_cobalamin_mcg, 0::numeric) + COALESCE(supp.b12_cobalamin_mcg, 0::numeric) AS b12_total_mcg,
--     cn.folate_mcg AS folate_dietary_mcg,
--     supp.folate_mcg AS folate_supplement_mcg,
--     COALESCE(cn.folate_mcg, 0::numeric) + COALESCE(supp.folate_mcg, 0::numeric) AS folate_total_mcg,
--     cn.calcium_mg AS calcium_dietary_mg,
--     supp.calcium_mg AS calcium_supplement_mg,
--     COALESCE(cn.calcium_mg, 0::numeric) + COALESCE(supp.calcium_mg, 0::numeric) AS calcium_total_mg,
--     cn.iron_mg AS iron_dietary_mg,
--     supp.iron_mg AS iron_supplement_mg,
--     COALESCE(cn.iron_mg, 0::numeric) + COALESCE(supp.iron_mg, 0::numeric) AS iron_total_mg,
--     cn.magnesium_mg AS magnesium_dietary_mg,
--     supp.magnesium_mg AS magnesium_supplement_mg,
--     COALESCE(cn.magnesium_mg, 0::numeric) + COALESCE(supp.magnesium_mg, 0::numeric) AS magnesium_total_mg,
--     cn.phosphorus_mg AS phosphorus_dietary_mg,
--     supp.phosphorus_mg AS phosphorus_supplement_mg,
--     COALESCE(cn.phosphorus_mg, 0::numeric) + COALESCE(supp.phosphorus_mg, 0::numeric) AS phosphorus_total_mg,
--     cn.potassium_mg AS potassium_dietary_mg,
--     supp.potassium_mg AS potassium_supplement_mg,
--     COALESCE(cn.potassium_mg, 0::numeric) + COALESCE(supp.potassium_mg, 0::numeric) AS potassium_total_mg,
--     cn.zinc_mg AS zinc_dietary_mg,
--     supp.zinc_mg AS zinc_supplement_mg,
--     COALESCE(cn.zinc_mg, 0::numeric) + COALESCE(supp.zinc_mg, 0::numeric) AS zinc_total_mg,
--     cn.copper_mg AS copper_dietary_mg,
--     supp.copper_mg AS copper_supplement_mg,
--     COALESCE(cn.copper_mg, 0::numeric) + COALESCE(supp.copper_mg, 0::numeric) AS copper_total_mg,
--     cn.manganese_mg AS manganese_dietary_mg,
--     supp.manganese_mg AS manganese_supplement_mg,
--     COALESCE(cn.manganese_mg, 0::numeric) + COALESCE(supp.manganese_mg, 0::numeric) AS manganese_total_mg,
--     cn.selenium_mcg AS selenium_dietary_mcg,
--     supp.selenium_mcg AS selenium_supplement_mcg,
--     COALESCE(cn.selenium_mcg, 0::numeric) + COALESCE(supp.selenium_mcg, 0::numeric) AS selenium_total_mcg,
--     cn.sodium_mg AS sodium_dietary_mg,
--     supp.sodium_mg AS sodium_supplement_mg,
--     COALESCE(cn.sodium_mg, 0::numeric) + COALESCE(supp.sodium_mg, 0::numeric) AS sodium_total_mg,
--     cn.omega3_g AS omega3_dietary_g,
--     supp.omega3_g AS omega3_supplement_g,
--     COALESCE(cn.omega3_g, 0::numeric) + COALESCE(supp.omega3_g, 0::numeric) AS omega3_total_g,
--     cn.epa_g AS epa_dietary_g,
--     supp.epa_g AS epa_supplement_g,
--     COALESCE(cn.epa_g, 0::numeric) + COALESCE(supp.epa_g, 0::numeric) AS epa_total_g,
--     cn.dha_g AS dha_dietary_g,
--     supp.dha_g AS dha_supplement_g,
--     COALESCE(cn.dha_g, 0::numeric) + COALESCE(supp.dha_g, 0::numeric) AS dha_total_g
--    FROM pds.cronometer_nutrition_behavioral_daily cn
--      FULL JOIN supp ON supp.d = cn.onyx_behavioral_date
--   ORDER BY (COALESCE(cn.onyx_behavioral_date, supp.d)) DESC;
--
-- 6b. Then remove the rest (no CASCADE needed once 6a has run):
-- SELECT cron.unschedule('refresh_supplement_rollup_mat');
-- DROP MATERIALIZED VIEW IF EXISTS pds.supplement_intake_by_compound_mat;
-- DROP FUNCTION IF EXISTS pds.refresh_supplement_intake_by_compound_mat(boolean);
-- DROP TABLE IF EXISTS pds.supplement_rollup_refresh_state;
