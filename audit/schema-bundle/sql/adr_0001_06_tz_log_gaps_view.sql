-- =============================================================================
-- ADR-0001 Phase 1, step 6 — pds.tz_log_gaps view
-- =============================================================================
-- Per docs/adr/0001-timezone-and-behavioral-day-handling.md
-- drastic-TZ-abroad gap #3: detect when Riley travels but forgets to add
-- the user_tz_log entry.
--
-- WHOOP's per-cycle timezone_offset is the canary. If a cycle's offset
-- disagrees with the IANA TZ that pds.tz_for_instant returns for that
-- cycle's start_time, the log is incomplete.
--
-- v2 (2026-05-25): gap_type column distinguishes 'travel' (real
-- forgot-to-log) from 'dst_artifact' (cycle straddled NY's DST transition;
-- WHOOP picks one offset per cycle but the log offset shifts mid-cycle).
-- /status banner filters gap_type='travel'; analytical consumers can read
-- the full view including DST artifacts via SELECT * directly.
--
-- One row per disagreeing cycle. /status reads this view and surfaces a
-- yellow banner with a one-click prompt to add the entry.
--
-- Depends on: sql/adr_0001_01_user_tz_log.sql, sql/adr_0001_02_whoop_onyx_dates.sql
-- =============================================================================

DROP VIEW IF EXISTS pds.tz_log_gaps;

CREATE VIEW pds.tz_log_gaps AS
WITH whoop_inferred AS (
    SELECT
        wc.cycle_id,
        wc.start_time,
        wc.end_time,
        wc.timezone_offset,
        (
            SELECT EXTRACT(EPOCH FROM (
                (wc.start_time AT TIME ZONE pds.tz_for_instant(wc.start_time)) -
                (wc.start_time AT TIME ZONE 'UTC')
            ))::int / 60
        ) AS log_offset_minutes_at_start,
        CASE WHEN wc.end_time IS NOT NULL THEN
            (
                SELECT EXTRACT(EPOCH FROM (
                    (wc.end_time AT TIME ZONE pds.tz_for_instant(wc.end_time)) -
                    (wc.end_time AT TIME ZONE 'UTC')
                ))::int / 60
            )
        ELSE NULL END AS log_offset_minutes_at_end,
        EXTRACT(EPOCH FROM wc.timezone_offset::interval)::int / 60
            AS source_offset_minutes,
        pds.tz_for_instant(wc.start_time) AS resolved_tz
    FROM pds.whoop_cycles wc
    WHERE wc.timezone_offset IS NOT NULL
)
SELECT
    cycle_id,
    start_time,
    end_time,
    timezone_offset                          AS source_offset,
    resolved_tz                              AS log_resolved_tz,
    log_offset_minutes_at_start              AS log_offset_minutes,
    log_offset_minutes_at_end,
    source_offset_minutes,
    (source_offset_minutes - log_offset_minutes_at_start) AS delta_minutes,
    (start_time AT TIME ZONE 'America/New_York')::date AS gap_et_date,
    -- gap_type:
    --   'dst_artifact' when WHOOP offset matches log offset at either
    --     start or end (cycle straddled a DST transition; not a real trip).
    --   'travel' when WHOOP offset disagrees with BOTH endpoints
    --     (real trip or forgot-to-log).
    CASE
        WHEN source_offset_minutes = log_offset_minutes_at_start
          OR source_offset_minutes = log_offset_minutes_at_end
        THEN 'dst_artifact'
        ELSE 'travel'
    END AS gap_type
FROM whoop_inferred
WHERE log_offset_minutes_at_start IS DISTINCT FROM source_offset_minutes
ORDER BY start_time DESC;

GRANT SELECT ON pds.tz_log_gaps TO anon, authenticated;

COMMENT ON VIEW pds.tz_log_gaps IS
'Per ADR-0001 drastic-TZ-abroad gap #3: WHOOP cycles whose timezone_offset disagrees with what pds.tz_for_instant returns from user_tz_log. gap_type=''dst_artifact'' when WHOOP offset matches log at cycle start OR end (cycle straddled NY DST transition); gap_type=''travel'' when WHOOP disagrees with both (real trip or forgot-to-log). /status banner filters on gap_type=''travel'' for clean UX; analytical queries can include both via direct SELECT.';
