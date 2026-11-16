-- =============================================================================
-- Pre-apply impact preview for sql/tz_derivation_edge_cases.sql (SELECT only)
-- =============================================================================
-- Run BEFORE applying the migration (Supabase SQL editor or execute_sql). One
-- statement; it writes nothing and needs none of the functions the migration
-- adds: the new rules are written out inline below, on top of what exists
-- today (pds.derive_onyx_dates, whose results the migration does not change,
-- and pds.user_tz_log). It returns counts and booleans only, never a row or a
-- value: report them in the review, keep them out of the repo (it is public).
--
-- Columns: check_name, kind, rows_in_scope, date_changes, behavioral_changes,
--          label_changes, outside_intended, baseline, note
--
-- kind = 'impact': per table, how many stored rows a trigger run under the NEW
--   rule would store differently (stored value vs new-rule value, row by row).
--   date_changes counts onyx_et_date / onyx_local_date, behavioral_changes
--   onyx_behavioral_date, label_changes onyx_tz_source.
--   GATE: outside_intended = 0 on every impact row. The intended changes are
--   the fixes the migration header lists; each note says what they are.
-- kind = 'baseline': the same booleans sql/tz_derivation_postdeploy_checks.sql
--   reports under the same names (same predicates; the offline test checks the
--   text is identical). Note each value: after applying, each must keep it or
--   turn true; true -> false is a failure.
--
-- Not counted, because the migration cannot change them: rows with an instant
-- (pds.derive_onyx_dates gives the same result before and after), the frozen
-- WHOOP-era rows of pds.habit_journal (zzz_block_frozen_whoop_era rejects any
-- write to them) and pds.whoop_journal (write-blocked archive, its trigger is
-- not replaced).
--
-- When the changes land: journal_entries within an hour of applying
-- (journal_etl.py re-upserts every live entry hourly; archived entries keep
-- their values until written again), garmin_hrv for the days garmin_etl.py
-- re-reads, every other row only when it is written again. No backfill.
--
-- The label a date-only day gets under the new rule
-- (pds.derive_onyx_dates_for_day): 'user_tz_log' when a user_tz_log row is in
-- effect at the last instant of that ET day, else 'default_et_fallback'. A row
-- is in effect at t when effective_from <= t, so that is the same as: the
-- earliest effective_from <= that last instant (first_log below).
-- =============================================================================
WITH
first_log AS (
    SELECT min(effective_from) AS t FROM pds.user_tz_log
),
garmin AS (
    SELECT g.calendar_date, g.start_timestamp,
           g.onyx_et_date, g.onyx_behavioral_date, g.onyx_local_date, g.onyx_tz_source
      FROM pds.garmin_hrv g
),
habit AS (
    SELECT h.cycle_date,
           h.onyx_et_date, h.onyx_behavioral_date, h.onyx_local_date, h.onyx_tz_source,
           CASE WHEN f.t IS NOT NULL
                 AND f.t <= ((h.cycle_date + 1)::timestamp AT TIME ZONE 'America/New_York')
                            - INTERVAL '1 microsecond'
                THEN 'user_tz_log' ELSE 'default_et_fallback' END AS new_label,
           -- the live rule's onyx_local_date: noon ET projected into the log zone
           (noon.t AT TIME ZONE COALESCE(
                (SELECT u.tz FROM pds.user_tz_log u
                  WHERE u.effective_from <= noon.t
                  ORDER BY u.effective_from DESC LIMIT 1),
                'America/New_York'))::date AS old_local
      FROM pds.habit_journal h
     CROSS JOIN first_log f
     CROSS JOIN LATERAL (SELECT (h.cycle_date::timestamp + INTERVAL '12 hours')
                                AT TIME ZONE 'America/New_York' AS t) noon
     WHERE NOT (h.source = 'whoop' AND h.cycle_date <= DATE '2026-06-08')
),
journal AS (
    SELECT j.*,
           CASE WHEN j.new_rt THEN j.i_et ELSE j.entry_date END AS new_et,
           CASE WHEN j.new_rt THEN j.i_local ELSE j.entry_date END AS new_local,
           CASE WHEN j.new_rt THEN j.i_src ELSE j.day_label END AS new_label
      FROM (
        SELECT je.entry_date,
               je.onyx_et_date, je.onyx_behavioral_date, je.onyx_local_date, je.onyx_tz_source,
               i.onyx_et_date AS i_et, i.onyx_local_date AS i_local, i.onyx_tz_source AS i_src,
               COALESCE(je.entry_date IN (i.onyx_et_date, i.onyx_local_date, i.onyx_behavioral_date),
                        FALSE) AS new_rt,
               COALESCE(je.entry_date = (je.notion_created_at AT TIME ZONE 'America/New_York')::date,
                        FALSE) AS old_rt,
               CASE WHEN f.t IS NOT NULL
                     AND f.t <= ((je.entry_date + 1)::timestamp AT TIME ZONE 'America/New_York')
                                - INTERVAL '1 microsecond'
                    THEN 'user_tz_log' ELSE 'default_et_fallback' END AS day_label
          FROM pds.journal_entries je
         CROSS JOIN first_log f
         CROSS JOIN LATERAL pds.derive_onyx_dates(je.notion_created_at, NULL, NULL) i
      ) j
),
untimed (tbl, day, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source) AS (
    SELECT 'supplement_intake', s.intake_date,
           s.onyx_et_date, s.onyx_behavioral_date, s.onyx_local_date, s.onyx_tz_source
      FROM pds.supplement_intake s WHERE s.intake_time IS NULL
    UNION ALL
    SELECT 'meal_events', m.event_date,
           m.onyx_et_date, m.onyx_behavioral_date, m.onyx_local_date, m.onyx_tz_source
      FROM pds.meal_events m WHERE m.event_time IS NULL
),
untimed_labelled AS (
    SELECT x.*,
           CASE WHEN f.t IS NOT NULL
                 AND f.t <= ((x.day + 1)::timestamp AT TIME ZONE 'America/New_York')
                            - INTERVAL '1 microsecond'
                THEN 'user_tz_log' ELSE 'default_et_fallback' END AS new_label
      FROM untimed x CROSS JOIN first_log f
),
checks (check_name, kind, rows_in_scope, date_changes, behavioral_changes,
        label_changes, outside_intended, baseline, note) AS (
    SELECT 'garmin_hrv', 'impact',
           count(*),
           count(*) FILTER (WHERE onyx_et_date IS DISTINCT FROM calendar_date
                               OR onyx_local_date IS DISTINCT FROM calendar_date),
           count(*) FILTER (WHERE onyx_behavioral_date IS DISTINCT FROM calendar_date),
           count(*) FILTER (WHERE onyx_tz_source IS DISTINCT FROM 'source_field'),
           count(*) FILTER (WHERE start_timestamp IS NULL
                              AND (onyx_et_date IS DISTINCT FROM calendar_date
                                   OR onyx_behavioral_date IS DISTINCT FROM calendar_date
                                   OR onyx_local_date IS DISTINCT FROM calendar_date)),
           NULL::BOOLEAN,
           'all rows. Intended: every label -> source_field, date changes only on rows with start_timestamp (dated by the sleep onset, the double shift the migration removes). outside = date changes on rows without start_timestamp'
      FROM garmin
    UNION ALL
    SELECT 'habit_journal_writable', 'impact',
           count(*),
           count(*) FILTER (WHERE onyx_et_date IS DISTINCT FROM cycle_date
                               OR onyx_local_date IS DISTINCT FROM cycle_date),
           count(*) FILTER (WHERE onyx_behavioral_date IS DISTINCT FROM cycle_date),
           count(*) FILTER (WHERE onyx_tz_source IS DISTINCT FROM new_label),
           count(*) FILTER (WHERE onyx_et_date IS DISTINCT FROM cycle_date
                               OR onyx_behavioral_date IS DISTINCT FROM cycle_date
                               OR (onyx_local_date IS DISTINCT FROM cycle_date
                                   AND onyx_local_date IS DISTINCT FROM old_local)
                               OR onyx_tz_source NOT IN ('user_tz_log', 'default_et_fallback')),
           NULL::BOOLEAN,
           'rows outside the frozen WHOOP era. Intended: onyx_local_date back to cycle_date where the noon-ET probe moved it (far-east days), label user_tz_log on a day a log row starts after noon. outside = any other date or label change'
      FROM habit
    UNION ALL
    SELECT 'journal_entries', 'impact',
           count(*),
           count(*) FILTER (WHERE onyx_et_date IS DISTINCT FROM new_et
                               OR onyx_local_date IS DISTINCT FROM new_local),
           count(*) FILTER (WHERE onyx_behavioral_date IS DISTINCT FROM entry_date),
           count(*) FILTER (WHERE onyx_tz_source IS DISTINCT FROM new_label),
           count(*) FILTER (WHERE onyx_behavioral_date IS DISTINCT FROM entry_date
                               OR ((onyx_et_date IS DISTINCT FROM new_et
                                    OR onyx_local_date IS DISTINCT FROM new_local
                                    OR onyx_tz_source IS DISTINCT FROM new_label)
                                   AND NOT (new_rt AND NOT old_rt)
                                   AND NOT (NOT new_rt
                                            AND onyx_et_date IS NOT DISTINCT FROM new_et
                                            AND onyx_local_date IS NOT DISTINCT FROM new_local
                                            AND onyx_tz_source = 'default_et_fallback'))),
           NULL::BOOLEAN,
           'all rows (archived ones change only when written again). Intended: entries now read as real time (entry_date = local or behavioral date of notion_created_at, not its ET date: awake tail, abroad) take et/local/label from the instant, backdated entries move from default_et_fallback to the day label. onyx_behavioral_date never changes. outside = anything else'
      FROM journal
    UNION ALL
    SELECT 'untimed_' || t.tbl, 'impact',
           count(x.tbl),
           count(x.tbl) FILTER (WHERE x.onyx_et_date IS DISTINCT FROM x.day
                                   OR x.onyx_local_date IS DISTINCT FROM x.day),
           count(x.tbl) FILTER (WHERE x.onyx_behavioral_date IS DISTINCT FROM x.day),
           count(x.tbl) FILTER (WHERE x.onyx_tz_source IS DISTINCT FROM x.new_label),
           count(x.tbl) FILTER (WHERE x.onyx_et_date IS DISTINCT FROM x.day
                                   OR x.onyx_behavioral_date IS DISTINCT FROM x.day
                                   OR x.onyx_local_date IS DISTINCT FROM x.day
                                   OR (x.onyx_tz_source IS DISTINCT FROM x.new_label
                                       AND x.onyx_tz_source IS DISTINCT FROM 'default_et_fallback')),
           NULL::BOOLEAN,
           'rows without a time. Intended: label default_et_fallback -> user_tz_log on days the log covers, dates unchanged. outside = any date change or another label change'
      FROM (VALUES ('supplement_intake'), ('meal_events')) AS t (tbl)
      LEFT JOIN untimed_labelled x ON x.tbl = t.tbl
     GROUP BY t.tbl
    UNION ALL
    SELECT 'cronometer_servings_unfilled', 'impact',
           count(*),
           count(*) FILTER (WHERE c.onyx_et_date IS NULL OR c.onyx_local_date IS NULL),
           count(*) FILTER (WHERE c.onyx_behavioral_date IS NULL),
           count(*) FILTER (WHERE c.onyx_tz_source IS NULL),
           count(*),
           NULL::BOOLEAN,
           'rows with a NULL onyx_* column, the only ones the trigger fills (cronometer_import.py sets all four). Expected none: review any row counted here'
      FROM pds.cronometer_servings c
     WHERE c.onyx_et_date IS NULL OR c.onyx_behavioral_date IS NULL
        OR c.onyx_local_date IS NULL OR c.onyx_tz_source IS NULL
    UNION ALL
    SELECT 'garmin_hrv_dates_are_wake_day', 'baseline', NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, NULL::BIGINT,
           NOT EXISTS (SELECT 1 FROM pds.garmin_hrv
                        WHERE onyx_et_date IS DISTINCT FROM calendar_date
                           OR onyx_behavioral_date IS DISTINCT FROM calendar_date
                           OR onyx_local_date IS DISTINCT FROM calendar_date),
           'stored garmin_hrv rows keyed by calendar_date'
    UNION ALL
    SELECT 'journal_entries_behavioral_is_entry_date', 'baseline', NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, NULL::BIGINT,
           NOT EXISTS (SELECT 1 FROM pds.journal_entries
                        WHERE onyx_behavioral_date IS DISTINCT FROM entry_date),
           'stored journal_entries rows: onyx_behavioral_date = entry_date'
    UNION ALL
    SELECT 'habit_journal_writable_rows_on_cycle_date', 'baseline', NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, NULL::BIGINT, NULL::BIGINT,
           NOT EXISTS (SELECT 1 FROM pds.habit_journal
                        WHERE NOT (source = 'whoop' AND cycle_date <= DATE '2026-06-08')
                          AND (onyx_et_date IS DISTINCT FROM cycle_date
                               OR onyx_behavioral_date IS DISTINCT FROM cycle_date
                               OR onyx_local_date IS DISTINCT FROM cycle_date)),
           'stored habit_journal rows outside the frozen WHOOP era carry cycle_date in all three dates'
)
SELECT check_name, kind, rows_in_scope, date_changes, behavioral_changes,
       label_changes, outside_intended, baseline, note
  FROM checks
 ORDER BY CASE kind WHEN 'impact' THEN 1 ELSE 2 END, check_name;
