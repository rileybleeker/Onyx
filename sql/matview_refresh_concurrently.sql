-- Matview refreshes that never make a reader wait (speed budget, 2026-11-15).
--
-- pds.refresh_daily_health_matrix_behavioral_mat() (pg_cron :10/:40) and pds.refresh_perf_matviews() (:12/:42)
-- used a plain REFRESH MATERIALIZED VIEW, which holds an ACCESS EXCLUSIVE lock on the matview until the function's
-- transaction commits: every page read of the matrix matview waited up to ~1.1 s twice an hour, and every read of
-- the five tier-2 matviews (/api/status reads two of them) waited for the whole perf-mats run (1-5 s; 3.25 s at
-- 04:12 UTC on 2026-11-15, when 20 production reads in a row took 1.2-1.9 s and the hourly speed check went red).
-- Waiting readers also hold PostgREST pool connections, so the stall spread to unrelated reads.
--
-- REFRESH ... CONCURRENTLY takes an EXCLUSIVE lock instead, which does not block SELECT: readers keep the previous
-- contents until the refresh commits. It needs a unique, non-partial index on plain columns; every matview here
-- has one (uq_dhmb_mat_behavioral_date, uq_tz_log_gaps_mat_cycle, uq_hrv_prediction_gaps_mat_date,
-- uq_spotify_daily_signature_mat_date, uq_recovery_vs_pace_mat_activity, uq_hrv_residuals_mat_key), and the
-- duplicate-key tripwire still holds (a duplicate natural key makes the refresh fail -> failed heartbeat).
-- The earlier comments said CONCURRENTLY is not allowed inside a function; it is (checked on the live database
-- 2026-11-15 with a rolled-back DO block). Same heartbeats, same drift checks, same grants (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION pds.refresh_daily_health_matrix_behavioral_mat()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pds', 'pg_catalog'
AS $function$
DECLARE
  t0 timestamptz := clock_timestamp();
  drift_cols text;
  n integer;
BEGIN
  SELECT string_agg(attname, ', ') INTO drift_cols FROM (
    SELECT a.attname FROM pg_attribute a
     WHERE a.attrelid = 'pds.daily_health_matrix_behavioral'::regclass AND a.attnum > 0 AND NOT a.attisdropped
    EXCEPT
    SELECT a.attname FROM pg_attribute a
     WHERE a.attrelid = 'pds.daily_health_matrix_behavioral_mat'::regclass AND a.attnum > 0 AND NOT a.attisdropped
  ) d;
  -- CONCURRENTLY: readers are never blocked; they see the previous contents until this commits.
  REFRESH MATERIALIZED VIEW CONCURRENTLY pds.daily_health_matrix_behavioral_mat;
  SELECT count(*) INTO n FROM pds.daily_health_matrix_behavioral_mat;
  IF drift_cols IS NOT NULL THEN
    INSERT INTO pds.sync_log (source, data_type, status, records_synced, error_message, sync_start, sync_end, duration_seconds)
    VALUES ('matrix_mat', 'refresh', 'failed', n,
            'schema drift — view columns missing from matview (recreate matview in the same migration as the view change): ' || drift_cols,
            t0, clock_timestamp(), EXTRACT(EPOCH FROM clock_timestamp() - t0));
  ELSE
    INSERT INTO pds.sync_log (source, data_type, status, records_synced, sync_start, sync_end, duration_seconds)
    VALUES ('matrix_mat', 'refresh', 'success', n, t0, clock_timestamp(), EXTRACT(EPOCH FROM clock_timestamp() - t0));
  END IF;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO pds.sync_log (source, data_type, status, records_synced, error_message, sync_start, sync_end, duration_seconds)
  VALUES ('matrix_mat', 'refresh', 'failed', 0, SQLERRM, t0, clock_timestamp(), EXTRACT(EPOCH FROM clock_timestamp() - t0));
END $function$;

CREATE OR REPLACE FUNCTION pds.refresh_perf_matviews()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pds', 'pg_catalog'
AS $function$
DECLARE
  t0 timestamptz := clock_timestamp();
  failures text := '';
  total_rows integer := 0;
  n integer;
  mv record;
  drift text;
BEGIN
  FOR mv IN SELECT * FROM (VALUES
      ('tz_log_gaps',             'tz_log_gaps_mat'),
      ('hrv_prediction_gaps',     'hrv_prediction_gaps_mat'),
      ('spotify_daily_signature', 'spotify_daily_signature_mat'),
      ('recovery_vs_pace',        'recovery_vs_pace_mat'),
      (NULL,                      'hrv_residuals_mat')  -- narrow slice: no 1:1 drift check; breakage surfaces as a refresh error
    ) AS v(view_name, mat_name)
  LOOP
    BEGIN
      IF mv.view_name IS NOT NULL THEN
        SELECT string_agg(attname, ', ') INTO drift FROM (
          SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = ('pds.' || mv.view_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped
          EXCEPT
          SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = ('pds.' || mv.mat_name)::regclass AND a.attnum > 0 AND NOT a.attisdropped) d;
        IF drift IS NOT NULL THEN
          failures := failures || mv.mat_name || ': schema drift — view columns missing from matview (recreate in same migration as the view change): ' || drift || '; ';
        END IF;
      END IF;
      -- CONCURRENTLY: readers are never blocked (the lock is held until this whole function commits, so a plain
      -- REFRESH blocked reads of all five matviews for the full run). The UNIQUE index doubles as a
      -- duplicate-natural-key tripwire (e.g. recovery_vs_pace on a future two-cycle transition day): refresh
      -- fails -> failed heartbeat.
      EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY pds.%I', mv.mat_name);
      EXECUTE format('SELECT count(*) FROM pds.%I', mv.mat_name) INTO n;
      total_rows := total_rows + n;
    EXCEPTION WHEN OTHERS THEN
      failures := failures || mv.mat_name || ': ' || SQLERRM || '; ';
    END;
  END LOOP;
  INSERT INTO pds.sync_log (source, data_type, status, records_synced, error_message, sync_start, sync_end, duration_seconds)
  VALUES ('perf_mats','refresh', CASE WHEN failures = '' THEN 'success' ELSE 'failed' END,
          total_rows, NULLIF(failures,''), t0, clock_timestamp(), EXTRACT(EPOCH FROM clock_timestamp() - t0));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO pds.sync_log (source, data_type, status, records_synced, error_message, sync_start, sync_end, duration_seconds)
  VALUES ('perf_mats','refresh','failed',0,SQLERRM,t0,clock_timestamp(),EXTRACT(EPOCH FROM clock_timestamp() - t0));
END $function$;
