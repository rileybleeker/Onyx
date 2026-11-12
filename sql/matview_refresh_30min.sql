-- sql/matview_refresh_30min.sql — 2026-11-11 (devops agent)
--
-- WHY
-- ---
-- Supabase has warned ~weekly since 2026-05-20 that Onyx is running out of its
-- Disk IO budget, and on 2026-11-11 06:43Z the database stalled (a checkpoint
-- started and never finished, pg_cron skipped its 06:55/06:57 jobs, the REST API
-- returned 522s). pg_stat_statements (read 2026-11-04) shows the two pg_cron
-- matview refreshes are the top disk writers by more than 10x:
--   refresh_daily_health_matrix_behavioral_mat  915k blocks written, 2.3M dirtied
--   refresh_perf_matviews                       572k blocks written, 1.27M dirtied
-- Each run is a full rewrite (plain REFRESH), 4x/hour each = ~8 rewrites/hour.
-- Halving the cadence halves that write load. Reads are unaffected (cache).
--
-- WHAT
-- ----
--   matrix matview : '10,25,40,55 * * * *' -> '10,40 * * * *'
--     (:10 still catches the :00 Garmin/WHOOP ETL, which lands ~:02-:06)
--   perf matviews  : '12,27,42,57 * * * *' -> '12,42 * * * *'
--     (still +2 min after the matrix refresh, so the two never overlap)
-- The /status Matrix Matview and Perf Matviews cards move to the same
-- cadence in the same PR: partial > 40 min (one missed), failed > 75 min.
--
-- COST
-- ----
-- Frontend matview readers can lag the live data by up to 30 min instead of
-- 15 (e.g. a manual Cronometer import or an is_excluded toggle shows up on the
-- matview-backed charts up to 30 min later). The Python pipeline and the chat
-- tools read the LIVE views and are unaffected.
--
-- HOW TO APPLY (Riley, Supabase SQL editor, Onyx project)
-- ------------------------------------------------------
-- Run once the database answers again. Idempotent. Looks jobs up by command so
-- it does not depend on job ids (on 2026-11-11 they were 1 and 3).

SELECT cron.alter_job(
  job_id   := (SELECT jobid FROM cron.job
               WHERE command ILIKE '%refresh_daily_health_matrix_behavioral_mat%'),
  schedule := '10,40 * * * *'
);

SELECT cron.alter_job(
  job_id   := (SELECT jobid FROM cron.job
               WHERE command ILIKE '%refresh_perf_matviews%'),
  schedule := '12,42 * * * *'
);

-- Check: expect the two schedules above.
SELECT jobid, schedule, command FROM cron.job ORDER BY jobid;

-- ROLLBACK (back to every 15 min):
-- SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE command ILIKE '%refresh_daily_health_matrix_behavioral_mat%'), schedule := '10,25,40,55 * * * *');
-- SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE command ILIKE '%refresh_perf_matviews%'), schedule := '12,27,42,57 * * * *');
