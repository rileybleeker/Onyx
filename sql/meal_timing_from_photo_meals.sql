-- ============================================================
-- Onyx: photo-meal timing per behavioral day (2026-11-16)
-- ============================================================
-- pds.meal_timing_from_photo_meals — one row per behavioral day with a
-- photo-logged meal (sql/photo_meals.sql), mirroring the shape of
-- pds.meal_timing_from_cronometer so the two COALESCE cleanly later.
--
-- Scope: real meals only. capture_kind = 'photo' (sql/direct_drink_capture.sql
-- added 'drink' rows for the caffeine layer — a drink is not a meal-timing
-- event) and deleted_at IS NULL (the soft-delete tombstone, counted nowhere).
-- eaten_at is the truthful instant set by the photo_meals_set_eaten_at trigger
-- (EXIF capture time, or the confirmed clock time), so first/last-meal hours
-- are computed in the LOCAL zone Riley was in (pds.tz_for_instant), not
-- hardcoded ET — the same ladder the trigger itself uses.
--
-- Bedtime anchor: the same WHOOP main-cycle LATERAL as
-- pds.meal_timing_from_cronometer (longest cycle of the behavioral day,
-- non-nap SCORED sleep) so last_meal_to_bedtime_minutes is comparable.
--
-- NOT wired into pds.daily_health_matrix_behavioral on purpose: changing that
-- view requires dropping + recreating pds.daily_health_matrix_behavioral_mat
-- in the SAME migration (the matview's SELECT * is frozen at creation — see
-- the matview rule in AGENTS.md / sql/perf_matrix_matview.sql), which is a
-- coordinated change this additive file must not make. When it is wired:
--   ALTER VIEW pds.daily_health_matrix_behavioral ... (or recreate it) so the
--   5 meal_* columns become
--     COALESCE(mtc.<x>, mtpm.<x>, mt.<x>)
--   -- Cronometer Gold timing first, photo meals second, meal_events last
--   via LEFT JOIN pds.meal_timing_from_photo_meals mtpm
--      ON mtpm.calendar_date = s.calendar_date
--   and then drop + recreate the matview (+ unique index, service-role grants)
--   in the same migration. Never drop the canonical view with CASCADE.
--
-- Additive only: CREATE OR REPLACE VIEW, no DROP statements. Nothing for the
-- anon role. View written, not applied, not in matrix.
-- ============================================================

CREATE OR REPLACE VIEW pds.meal_timing_from_photo_meals WITH (security_invoker = true) AS
 WITH meals AS (
     SELECT pm.eaten_date AS calendar_date,
            pm.eaten_at,
            (pm.eaten_at AT TIME ZONE COALESCE(pds.tz_for_instant(pm.eaten_at), 'America/New_York')) AS local_ts
       FROM pds.photo_meals pm
      WHERE pm.capture_kind = 'photo'
        AND pm.deleted_at IS NULL
        AND pm.eaten_at IS NOT NULL
    ), agg AS (
     SELECT m.calendar_date,
        min(m.eaten_at) AS first_meal_time,
        max(m.eaten_at) AS last_meal_time,
        EXTRACT(epoch FROM max(m.local_ts) - date_trunc('day', max(m.local_ts))) / 3600.0 AS last_meal_hour,
        EXTRACT(epoch FROM min(m.local_ts) - date_trunc('day', min(m.local_ts))) / 3600.0 AS first_meal_hour,
        CASE WHEN count(*) > 1 THEN EXTRACT(epoch FROM max(m.eaten_at) - min(m.eaten_at)) / 3600.0 ELSE NULL::numeric END AS eating_window_hours,
        count(*) AS meal_event_count
       FROM meals m
      GROUP BY m.calendar_date
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
    'Photo-logged meals (pds.photo_meals capture_kind = photo, not removed) per behavioral day: first/last meal hour (local zone via pds.tz_for_instant), eating window, count, bedtime-anchored gap via the WHOOP main cycle. Same shape as pds.meal_timing_from_cronometer; not yet COALESCEd into daily_health_matrix_behavioral.';

REVOKE ALL ON pds.meal_timing_from_photo_meals FROM PUBLIC;
REVOKE ALL ON pds.meal_timing_from_photo_meals FROM anon;
GRANT SELECT ON pds.meal_timing_from_photo_meals TO authenticated, service_role;
