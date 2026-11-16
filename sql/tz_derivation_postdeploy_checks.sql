-- =============================================================================
-- Post-deploy checks for sql/tz_derivation_edge_cases.sql (SELECT only)
-- =============================================================================
-- Run right after applying the migration (Supabase SQL editor or execute_sql).
-- One statement; it writes nothing and returns one row per check:
--   check_name, kind, passed, note
-- Every row must have passed = true. passed = NULL means the check could not be
-- decided (its note says why); false is a failure: run
-- sql/rollback_tz_derivation_2026-11-16.sql and investigate.
--
-- kind = 'synthetic': the date-only, awake-tail, backdate, far-east / far-west,
--   both-DST-transition and NULL cases, on made-up 1990 inputs. No real row is
--   read: 1990 has no user_tz_log row and no WHOOP cycle (checked first), so
--   the instant cases fall through to the ET fallback and every expected value
--   is fixed. Far-east / far-west instants use an explicit source offset.
--   tests/test_tz_derivation_edge_cases.py recomputes every expected value
--   below with its Python model of the rule, so a typo here fails that test.
-- kind = 'definition': the live function bodies are exactly the bodies in the
--   migration (md5 of prosrc, carriage returns removed; the same test checks
--   these hashes against the migration file), the WHOOP journal archive and the
--   other functions the migration must not touch still have their 2026-11-16
--   bodies, and every trigger still calls its function.
-- kind = 'data': read-only consistency of stored rows, reported as booleans
--   only (no value leaves the database).
-- =============================================================================
WITH
pre AS (
    SELECT NOT EXISTS (SELECT 1 FROM pds.user_tz_log
                        WHERE effective_from < TIMESTAMPTZ '1991-01-01 00:00+00')
       AND NOT EXISTS (SELECT 1 FROM pds.whoop_cycles
                        WHERE start_time < TIMESTAMPTZ '1991-01-02 00:00+00') AS ok
),
day_cases (name, d, src_in, e_et, e_beh, e_local, e_src) AS (VALUES
    ('day_plain', DATE '1990-06-15', NULL::TEXT, DATE '1990-06-15', DATE '1990-06-15', DATE '1990-06-15', 'default_et_fallback'::TEXT),
    ('day_garmin_wake_day_kept', DATE '1990-06-15', 'source_field', DATE '1990-06-15', DATE '1990-06-15', DATE '1990-06-15', 'source_field'),
    ('day_dst_spring_forward', DATE '1990-04-01', NULL::TEXT, DATE '1990-04-01', DATE '1990-04-01', DATE '1990-04-01', 'default_et_fallback'),
    ('day_dst_fall_back', DATE '1990-10-28', NULL::TEXT, DATE '1990-10-28', DATE '1990-10-28', DATE '1990-10-28', 'default_et_fallback'),
    ('day_null', NULL::DATE, NULL::TEXT, NULL::DATE, NULL::DATE, NULL::DATE, NULL::TEXT)
),
inst_cases (name, ts, off, src_in, e_et, e_beh, e_local, e_src) AS (VALUES
    ('inst_et_evening', TIMESTAMPTZ '1990-06-16 00:00:00+00', NULL::TEXT, NULL::TEXT, DATE '1990-06-15', DATE '1990-06-15', DATE '1990-06-15', 'default_et_fallback'::TEXT),
    ('inst_awake_tail_0030', TIMESTAMPTZ '1990-06-16 04:30:00+00', NULL::TEXT, NULL::TEXT, DATE '1990-06-16', DATE '1990-06-15', DATE '1990-06-16', 'default_et_fallback'),
    ('inst_awake_tail_0559', TIMESTAMPTZ '1990-06-16 09:59:59+00', NULL::TEXT, NULL::TEXT, DATE '1990-06-16', DATE '1990-06-15', DATE '1990-06-16', 'default_et_fallback'),
    ('inst_morning_0600', TIMESTAMPTZ '1990-06-16 10:00:00+00', NULL::TEXT, NULL::TEXT, DATE '1990-06-16', DATE '1990-06-16', DATE '1990-06-16', 'default_et_fallback'),
    ('inst_dst_spring_0330_edt', TIMESTAMPTZ '1990-04-01 07:30:00+00', NULL::TEXT, NULL::TEXT, DATE '1990-04-01', DATE '1990-03-31', DATE '1990-04-01', 'default_et_fallback'),
    ('inst_dst_spring_0559_edt', TIMESTAMPTZ '1990-04-01 09:59:59+00', NULL::TEXT, NULL::TEXT, DATE '1990-04-01', DATE '1990-03-31', DATE '1990-04-01', 'default_et_fallback'),
    ('inst_dst_spring_0600_edt', TIMESTAMPTZ '1990-04-01 10:00:00+00', NULL::TEXT, NULL::TEXT, DATE '1990-04-01', DATE '1990-04-01', DATE '1990-04-01', 'default_et_fallback'),
    ('inst_dst_fall_0130_edt', TIMESTAMPTZ '1990-10-28 05:30:00+00', NULL::TEXT, NULL::TEXT, DATE '1990-10-28', DATE '1990-10-27', DATE '1990-10-28', 'default_et_fallback'),
    ('inst_dst_fall_0130_est', TIMESTAMPTZ '1990-10-28 06:30:00+00', NULL::TEXT, NULL::TEXT, DATE '1990-10-28', DATE '1990-10-27', DATE '1990-10-28', 'default_et_fallback'),
    ('inst_dst_fall_0559_est', TIMESTAMPTZ '1990-10-28 10:59:59+00', NULL::TEXT, NULL::TEXT, DATE '1990-10-28', DATE '1990-10-27', DATE '1990-10-28', 'default_et_fallback'),
    ('inst_dst_fall_0600_est', TIMESTAMPTZ '1990-10-28 11:00:00+00', NULL::TEXT, NULL::TEXT, DATE '1990-10-28', DATE '1990-10-28', DATE '1990-10-28', 'default_et_fallback'),
    ('inst_far_east_plus09', TIMESTAMPTZ '1990-06-15 23:00:00+00', '+09:00', NULL::TEXT, DATE '1990-06-15', DATE '1990-06-16', DATE '1990-06-16', 'source_field'),
    ('inst_far_east_plus09_awake_tail', TIMESTAMPTZ '1990-06-15 16:30:00+00', '+09:00', NULL::TEXT, DATE '1990-06-15', DATE '1990-06-15', DATE '1990-06-16', 'source_field'),
    ('inst_far_east_plus13', TIMESTAMPTZ '1990-06-15 12:00:00+00', '+13:00', NULL::TEXT, DATE '1990-06-15', DATE '1990-06-15', DATE '1990-06-16', 'source_field'),
    ('inst_far_west_minus10', TIMESTAMPTZ '1990-06-16 09:00:00+00', '-10:00', NULL::TEXT, DATE '1990-06-16', DATE '1990-06-15', DATE '1990-06-15', 'source_field'),
    ('inst_label_override', TIMESTAMPTZ '1990-06-16 00:00:00+00', NULL::TEXT, 'cronometer_serving', DATE '1990-06-15', DATE '1990-06-15', DATE '1990-06-15', 'cronometer_serving'),
    ('inst_null', NULL::TIMESTAMPTZ, NULL::TEXT, NULL::TEXT, NULL::DATE, NULL::DATE, NULL::DATE, NULL::TEXT)
),
journal_cases (name, entry_date, written_at, e_et, e_beh, e_local, e_src) AS (VALUES
    ('journal_realtime_same_et_day', DATE '1990-06-15', TIMESTAMPTZ '1990-06-16 00:00:00+00', DATE '1990-06-15', DATE '1990-06-15', DATE '1990-06-15', 'default_et_fallback'::TEXT),
    ('journal_awake_tail_0030', DATE '1990-06-15', TIMESTAMPTZ '1990-06-16 04:30:00+00', DATE '1990-06-16', DATE '1990-06-15', DATE '1990-06-16', 'default_et_fallback'),
    ('journal_awake_tail_0559', DATE '1990-06-15', TIMESTAMPTZ '1990-06-16 09:59:59+00', DATE '1990-06-16', DATE '1990-06-15', DATE '1990-06-16', 'default_et_fallback'),
    ('journal_next_morning_backdated', DATE '1990-06-15', TIMESTAMPTZ '1990-06-16 10:00:00+00', DATE '1990-06-15', DATE '1990-06-15', DATE '1990-06-15', 'default_et_fallback'),
    ('journal_backdated_days', DATE '1990-06-10', TIMESTAMPTZ '1990-06-16 16:00:00+00', DATE '1990-06-10', DATE '1990-06-10', DATE '1990-06-10', 'default_et_fallback'),
    ('journal_forward_dated', DATE '1990-06-20', TIMESTAMPTZ '1990-06-16 16:00:00+00', DATE '1990-06-20', DATE '1990-06-20', DATE '1990-06-20', 'default_et_fallback'),
    ('journal_no_written_at', DATE '1990-06-15', NULL::TIMESTAMPTZ, DATE '1990-06-15', DATE '1990-06-15', DATE '1990-06-15', 'default_et_fallback'),
    ('journal_dst_spring_awake_tail', DATE '1990-03-31', TIMESTAMPTZ '1990-04-01 07:30:00+00', DATE '1990-04-01', DATE '1990-03-31', DATE '1990-04-01', 'default_et_fallback'),
    ('journal_dst_fall_awake_tail', DATE '1990-10-27', TIMESTAMPTZ '1990-10-28 06:30:00+00', DATE '1990-10-28', DATE '1990-10-27', DATE '1990-10-28', 'default_et_fallback')
),
bodies (fname, md5) AS (VALUES
    ('tz_log_resolve', 'c2a2047107021110bcd5cc189077ab9f'),
    ('derive_onyx_dates_for_day', '264556844d14548e70f73e15f5a3b62b'),
    ('derive_onyx_dates', '0594e2443b49f80bcdd70f00a2c47331'),
    ('journal_entry_onyx_dates', 'c88255a9ff0fc74a88189d731f9a6bdc'),
    ('set_onyx_dates_habit_journal', 'de1e22a767884c432772cfeff8bd9de9'),
    ('set_onyx_dates_journal_entries', '3b0b7cd27d599ee00202e0c9e11b75db'),
    ('set_onyx_dates_meal_events', 'c980936a23aa54879f15932217080bca'),
    ('set_onyx_dates_supplement_intake', '2400bd852b239ba1d091e3eb95dd5338'),
    ('set_onyx_dates_cronometer_servings', 'c98045e8e66cdff4f3a41bbed7139f6e'),
    ('set_onyx_dates_garmin_hrv', '64e1183364154257d1afab02563d8467')
),
untouched (fname, md5) AS (VALUES
    ('set_onyx_dates_whoop_journal', '7138304c73f7b908d53216b435188402'),
    ('block_whoop_journal_archive_writes', 'edea2bdc6c10526724ac909cb95a6a9e'),
    ('block_frozen_whoop_era_writes', '01b2a23561a3cefb0d824d0f394c8b4d'),
    ('tz_for_instant', '66816f8be61cb8442acc7678c1012403'),
    ('cycle_offset_for_instant', 'a62d34213e614a46f89093901f655879')
),
bindings (tbl, tg, fname) AS (VALUES
    ('garmin_hrv', 'garmin_hrv_set_onyx_dates', 'set_onyx_dates_garmin_hrv'),
    ('habit_journal', 'habit_journal_set_onyx_dates', 'set_onyx_dates_habit_journal'),
    ('habit_journal', 'zzz_block_frozen_whoop_era', 'block_frozen_whoop_era_writes'),
    ('journal_entries', 'journal_entries_set_onyx_dates', 'set_onyx_dates_journal_entries'),
    ('meal_events', 'meal_events_set_onyx_dates', 'set_onyx_dates_meal_events'),
    ('supplement_intake', 'supplement_intake_set_onyx_dates', 'set_onyx_dates_supplement_intake'),
    ('cronometer_servings', 'set_onyx_dates_cronometer_servings', 'set_onyx_dates_cronometer_servings'),
    ('whoop_journal', 'whoop_journal_set_onyx_dates', 'set_onyx_dates_whoop_journal'),
    ('whoop_journal', 'zzz_block_archive_writes', 'block_whoop_journal_archive_writes')
),
live_body AS (
    SELECT p.proname AS fname, md5(replace(p.prosrc, chr(13), '')) AS md5, count(*) OVER (PARTITION BY p.proname) AS n
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'pds'
),
first_log AS (
    SELECT (min(effective_from) AT TIME ZONE 'America/New_York')::date AS d FROM pds.user_tz_log
),
checks (check_name, kind, passed, note) AS (
    SELECT c.name, 'synthetic',
           CASE WHEN pre.ok THEN
               (r.onyx_et_date, r.onyx_behavioral_date, r.onyx_local_date, r.onyx_tz_source)
               IS NOT DISTINCT FROM (c.e_et, c.e_beh, c.e_local, c.e_src) END,
           CASE WHEN pre.ok THEN 'pds.derive_onyx_dates_for_day'
                ELSE 'undecidable: a user_tz_log row or WHOOP cycle exists before 1991' END
      FROM day_cases c CROSS JOIN pre
      CROSS JOIN LATERAL pds.derive_onyx_dates_for_day(c.d, c.src_in) r
    UNION ALL
    SELECT c.name, 'synthetic',
           CASE WHEN pre.ok THEN
               (r.onyx_et_date, r.onyx_behavioral_date, r.onyx_local_date, r.onyx_tz_source)
               IS NOT DISTINCT FROM (c.e_et, c.e_beh, c.e_local, c.e_src) END,
           CASE WHEN pre.ok THEN 'pds.derive_onyx_dates'
                ELSE 'undecidable: a user_tz_log row or WHOOP cycle exists before 1991' END
      FROM inst_cases c CROSS JOIN pre
      CROSS JOIN LATERAL pds.derive_onyx_dates(c.ts, c.off, c.src_in) r
    UNION ALL
    SELECT c.name, 'synthetic',
           CASE WHEN pre.ok THEN
               (r.onyx_et_date, r.onyx_behavioral_date, r.onyx_local_date, r.onyx_tz_source)
               IS NOT DISTINCT FROM (c.e_et, c.e_beh, c.e_local, c.e_src) END,
           CASE WHEN pre.ok THEN 'pds.journal_entry_onyx_dates'
                ELSE 'undecidable: a user_tz_log row or WHOOP cycle exists before 1991' END
      FROM journal_cases c CROSS JOIN pre
      CROSS JOIN LATERAL pds.journal_entry_onyx_dates(c.entry_date, c.written_at) r
    UNION ALL
    SELECT 'body_' || b.fname, 'definition',
           COALESCE(l.n = 1 AND l.md5 = b.md5, FALSE),
           'live body equals the migration body'
      FROM bodies b LEFT JOIN live_body l ON l.fname = b.fname
    UNION ALL
    SELECT 'untouched_' || u.fname, 'definition',
           COALESCE(l.n = 1 AND l.md5 = u.md5, FALSE),
           'body as on 2026-11-16 (changes only if sql/tz_derivation_whoop_followups.sql is applied)'
      FROM untouched u LEFT JOIN live_body l ON l.fname = u.fname
    UNION ALL
    SELECT 'trigger_' || x.tg, 'definition',
           EXISTS (SELECT 1
                     FROM pg_trigger t
                     JOIN pg_class cl ON cl.oid = t.tgrelid
                     JOIN pg_namespace ns ON ns.oid = cl.relnamespace
                     JOIN pg_proc p ON p.oid = t.tgfoid
                    WHERE ns.nspname = 'pds' AND cl.relname = x.tbl
                      AND t.tgname = x.tg AND p.proname = x.fname
                      AND t.tgenabled <> 'D'),
           'trigger exists, is enabled and calls its function'
      FROM bindings x
    UNION ALL
    SELECT 'garmin_hrv_dates_are_wake_day', 'data',
           NOT EXISTS (SELECT 1 FROM pds.garmin_hrv
                        WHERE onyx_et_date IS DISTINCT FROM calendar_date
                           OR onyx_behavioral_date IS DISTINCT FROM calendar_date
                           OR onyx_local_date IS DISTINCT FROM calendar_date),
           'every garmin_hrv row keyed by calendar_date (hrv_alignment.py does the one-day shift)'
    UNION ALL
    SELECT 'journal_entries_behavioral_is_entry_date', 'data',
           NOT EXISTS (SELECT 1 FROM pds.journal_entries
                        WHERE onyx_behavioral_date IS DISTINCT FROM entry_date),
           'the HRV pipeline groups journal entries by entry_date'
    UNION ALL
    SELECT 'habit_journal_writable_rows_on_cycle_date', 'data',
           NOT EXISTS (SELECT 1 FROM pds.habit_journal
                        WHERE NOT (source = 'whoop' AND cycle_date <= DATE '2026-06-08')
                          AND (onyx_et_date IS DISTINCT FROM cycle_date
                               OR onyx_behavioral_date IS DISTINCT FROM cycle_date
                               OR onyx_local_date IS DISTINCT FROM cycle_date)),
           'rows outside the frozen WHOOP era carry cycle_date in all three dates'
    UNION ALL
    SELECT 'same_day_landing_first_log_day', 'data',
           CASE WHEN f.d IS NULL THEN NULL ELSE
               (SELECT r.onyx_tz_source FROM pds.derive_onyx_dates_for_day(f.d) r) = 'user_tz_log'
               AND (SELECT r.onyx_tz_source FROM pds.derive_onyx_dates_for_day(f.d - 1) r) = 'default_et_fallback'
           END,
           CASE WHEN f.d IS NULL THEN 'undecidable: user_tz_log is empty'
                ELSE 'the ET day the first log row starts on counts as covered, the day before does not' END
      FROM first_log f
    UNION ALL
    SELECT 'log_days_keep_their_date', 'data',
           NOT EXISTS (SELECT 1
                         FROM pds.user_tz_log u
                        CROSS JOIN LATERAL pds.derive_onyx_dates_for_day(
                                  (u.effective_from AT TIME ZONE u.tz)::date) r
                        WHERE r.onyx_local_date IS DISTINCT FROM (u.effective_from AT TIME ZONE u.tz)::date),
           'a date-only row on the local day of any log row (far-east included) keeps its date'
)
SELECT check_name, kind, passed, note
  FROM checks
 ORDER BY CASE kind WHEN 'definition' THEN 1 WHEN 'synthetic' THEN 2 ELSE 3 END, check_name;
