-- ============================================================
-- Onyx: meal timing from photo-logged meals (2026-11-16)
-- ============================================================
-- pds.meal_timing_from_photo_meals — meal-timing per behavioral day from
-- pds.photo_meals (meals logged from a plate photo, see sql/photo_meals.sql).
-- Mirrors the pds.meal_timing_from_cronometer shape (same column names, same
-- LATERAL longest-WHOOP-cycle bedtime anchor, ET decimal hours) so all three
-- timing sources COALESCE cleanly in the matrix.
--
-- PRIORITY (decision 2026-11-16): photo meals are the LOWEST-priority
-- fallback. Any later COALESCE in pds.daily_health_matrix_behavioral must
-- read, per column:
--     COALESCE(mtc.<x>, mt.<x>, mtp.<x>)
-- i.e. Cronometer Gold timing first, pds.meal_timing_daily (meal_events)
-- second, photo meals third. This file does NOT touch the matrix view or the
-- matview; the wiring is a separate migration.
--
-- ── MATVIEW RULE a later matrix migration MUST follow ──
-- The matrix view's SELECT-list change must ship in the SAME migration as a
-- full recreate of pds.daily_health_matrix_behavioral_mat (remove the old
-- materialized view, then CREATE it again):
--     1. remove pds.daily_health_matrix_behavioral_mat;
--     2. CREATE MATERIALIZED VIEW pds.daily_health_matrix_behavioral_mat AS
--            SELECT * FROM pds.daily_health_matrix_behavioral;
--     3. re-create the unique index on (onyx_behavioral_date) and the
--        calendar_date index;
--     4. REVOKE ALL FROM PUBLIC, anon, authenticated;
--        GRANT SELECT TO service_role (see sql/pds_owner_only_read.sql part 2
--        and the matview REVOKE rule, sql/pds_matview_revoke_authenticated.sql);
--     5. keep REFRESH ... CONCURRENTLY working (unique index required).
-- Never remove pds.daily_health_matrix_behavioral with CASCADE, and never let
-- the matview drift (its SELECT * is frozen at creation). Full recipe:
-- sql/perf_matrix_matview.sql.
-- ============================================================

CREATE OR REPLACE VIEW pds.meal_timing_from_photo_meals WITH (security_invoker = true) AS
 WITH agg AS (
     SELECT pm.eaten_date AS calendar_date,
            min(pm.eaten_at) AS first_meal_time,
            max(pm.eaten_at) AS last_meal_time,
            EXTRACT(epoch FROM (max(pm.eaten_at) AT TIME ZONE 'America/New_York') - date_trunc('day', (max(pm.eaten_at) AT TIME ZONE 'America/New_York'))) / 3600.0 AS last_meal_hour,
            EXTRACT(epoch FROM (min(pm.eaten_at) AT TIME ZONE 'America/New_York') - date_trunc('day', (min(pm.eaten_at) AT TIME ZONE 'America/New_York'))) / 3600.0 AS first_meal_hour,
            CASE WHEN count(*) > 1 THEN EXTRACT(epoch FROM max(pm.eaten_at) - min(pm.eaten_at)) / 3600.0 ELSE NULL::numeric END AS eating_window_hours,
            count(*)::int AS meal_event_count
       FROM pds.photo_meals pm
      WHERE pm.eaten_at IS NOT NULL
      GROUP BY pm.eaten_date
    )
 SELECT agg.calendar_date,
    agg.first_meal_time,
    agg.last_meal_time,
    agg.first_meal_hour,
    agg.last_meal_hour,
    agg.eating_window_hours,
    agg.meal_event_count,
    ws.start_time AS sleep_start_time,
    CASE WHEN ws.start_time IS NOT NULL AND agg.last_meal_time IS NOT NULL
         THEN EXTRACT(epoch FROM ws.start_time - agg.last_meal_time) / 60.0
         ELSE NULL::numeric END AS last_meal_to_bedtime_minutes
   FROM agg
     LEFT JOIN LATERAL ( SELECT wc2.cycle_id, wc2.start_time
           FROM pds.whoop_cycles wc2
          WHERE wc2.onyx_behavioral_date = agg.calendar_date
          ORDER BY (wc2.end_time - wc2.start_time) DESC NULLS LAST, wc2.start_time DESC
         LIMIT 1) wc ON true
     LEFT JOIN pds.whoop_sleep ws ON ws.cycle_id = wc.cycle_id AND ws.is_nap = false AND ws.score_state = 'SCORED'::text
  ORDER BY agg.calendar_date DESC;

COMMENT ON VIEW pds.meal_timing_from_photo_meals IS
    'Meal timing per behavioral day from photo-logged meals (pds.photo_meals). LOWEST-priority fallback: behind Cronometer Gold timing and pds.meal_timing_daily in any matrix COALESCE. Not yet wired into daily_health_matrix_behavioral.';

-- Access mirrors pds.photo_meal_daily: the owner reads in the browser through
-- the owner_read RLS policies on pds.photo_meals (security_invoker), the
-- service role reads for the pipeline. The anon key reads nothing in pds.
GRANT SELECT ON pds.meal_timing_from_photo_meals TO authenticated, service_role;
