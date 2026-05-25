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
        wc.timezone_offset,
        -- What IANA TZ is implied by the WHOOP offset for this start_time.
        -- Without a name we can't know — but we CAN compute "the offset that
        -- pds.tz_for_instant would have returned for the same instant" and
        -- compare. We do that by reading user_tz_log → tz IANA → offset
        -- at that instant.
        (
            SELECT EXTRACT(EPOCH FROM (
                (wc.start_time AT TIME ZONE pds.tz_for_instant(wc.start_time)) -
                (wc.start_time AT TIME ZONE 'UTC')
            ))::int / 60
        ) AS log_offset_minutes,
        EXTRACT(EPOCH FROM wc.timezone_offset::interval)::int / 60
            AS source_offset_minutes,
        pds.tz_for_instant(wc.start_time) AS resolved_tz
    FROM pds.whoop_cycles wc
    WHERE wc.timezone_offset IS NOT NULL
)
SELECT
    cycle_id,
    start_time,
    timezone_offset                          AS source_offset,
    resolved_tz                              AS log_resolved_tz,
    log_offset_minutes,
    source_offset_minutes,
    (source_offset_minutes - log_offset_minutes) AS delta_minutes,
    (start_time AT TIME ZONE 'America/New_York')::date AS gap_et_date
FROM whoop_inferred
WHERE log_offset_minutes IS DISTINCT FROM source_offset_minutes
ORDER BY start_time DESC;

GRANT SELECT ON pds.tz_log_gaps TO anon, authenticated;

COMMENT ON VIEW pds.tz_log_gaps IS
'Per ADR-0001 drastic-TZ-abroad gap #3: WHOOP cycles whose timezone_offset disagrees with what pds.tz_for_instant returns for the same start_time. Each row = a day where Riley likely traveled but forgot to add a user_tz_log entry. /status reads this view and renders a yellow banner with a one-click prompt to fix.';
