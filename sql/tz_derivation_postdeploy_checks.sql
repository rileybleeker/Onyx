-- =============================================================================
-- Post-deploy checks for sql/tz_derivation_edge_cases.sql (SELECT only)
-- =============================================================================
-- Run right after applying the migration (Supabase SQL editor or execute_sql).
-- Before applying, run sql/tz_derivation_preapply_counts.sql and note its
-- results. One statement; it writes nothing and returns one row per check:
--   check_name, kind, passed, note
-- passed = NULL means the check could not be decided (its note says why).
--
-- What must hold, by kind (a failure = run
-- sql/rollback_tz_derivation_2026-11-16.sql and investigate):
--   definition, synthetic, live_context: passed = true right after applying.
--   rederived: true once journal_etl.py has run after applying (hourly at :35).
--     NULL before that is expected (live entries still carry the old rule's
--     values), false = an entry matches neither the old nor the new rule.
--   baseline: stored rows the migration does not rewrite (no backfill). Compare
--     with the value the pre-apply file reported under the same name: the same
--     value, or false -> true, is fine. true -> false is a failure. A false that
--     was already false before applying is historical: report it for the
--     separate backfill plan, it is not a deployment failure.
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
-- kind = 'live_context': the deployed functions on made-up inputs in a real
--   time-zone context. The journal_travel_* checks pick instants abroad (inside
--   a closed WHOOP cycle whose offset is not ET's, resolved through
--   pds.cycle_offset_for_instant, which the migration leaves untouched; or in a
--   non-ET user_tz_log period with no WHOOP cycle near) and run the journal
--   helper through its own zone lookup (no offset passed) on three entries per
--   instant: written in real time (entry_date = local date), the awake tail
--   (entry_date = local behavioral date) and backdated 3 days. Expected values
--   come from the cycle's offset or the log zone directly. Each check needs at
--   least one instant whose local date differs from its ET date (the case the
--   old ET-only journal rule got wrong), else it is NULL.
-- kind = 'rederived' / 'baseline': stored rows, see above. Booleans only: no
--   value or row leaves the database.
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
    SELECT (min(effective_from) AT TIME ZONE 'America/New_York')::date AS d,
           min(effective_from) AS t
      FROM pds.user_tz_log
),
-- Instants abroad, tier 2: inside a closed WHOOP cycle whose offset is not ET's
-- at that instant, and which pds.cycle_offset_for_instant resolves to it.
travel_cycle AS (
    SELECT c.start_time + make_interval(hours => g.k) AS ts, c.timezone_offset::interval AS off
      FROM pds.whoop_cycles c
     CROSS JOIN generate_series(0, 23) AS g (k)
     WHERE c.end_time IS NOT NULL AND c.timezone_offset IS NOT NULL
       AND c.start_time + make_interval(hours => g.k) < c.end_time
       AND c.timezone_offset::interval
           <> ((c.start_time + make_interval(hours => g.k)) AT TIME ZONE 'America/New_York')
            - ((c.start_time + make_interval(hours => g.k)) AT TIME ZONE 'UTC')
       AND pds.cycle_offset_for_instant(c.start_time + make_interval(hours => g.k)) = c.timezone_offset
),
-- Instants abroad, tier 3: within a day after a non-ET user_tz_log row (before
-- the next one) with no WHOOP cycle near, so the log decides.
travel_log AS (
    SELECT u.effective_from + make_interval(hours => g.k) AS ts, u.tz
      FROM pds.user_tz_log u
     CROSS JOIN generate_series(1, 24) AS g (k)
     WHERE ((u.effective_from + make_interval(hours => g.k)) AT TIME ZONE u.tz)
           <> ((u.effective_from + make_interval(hours => g.k)) AT TIME ZONE 'America/New_York')
       AND NOT EXISTS (SELECT 1 FROM pds.user_tz_log u2
                        WHERE u2.effective_from > u.effective_from
                          AND u2.effective_from <= u.effective_from + make_interval(hours => g.k))
       AND pds.cycle_offset_for_instant(u.effective_from + make_interval(hours => g.k)) IS NULL
),
travel AS (
    SELECT 'cycle_anchor' AS tier, t.ts,
           (t.ts AT TIME ZONE 'America/New_York')::date AS et,
           ((t.ts AT TIME ZONE 'UTC') + t.off)::date AS loc,
           ((t.ts AT TIME ZONE 'UTC') + t.off - INTERVAL '6 hours')::date AS beh
      FROM travel_cycle t
    UNION ALL
    SELECT 'user_tz_log', t.ts,
           (t.ts AT TIME ZONE 'America/New_York')::date,
           (t.ts AT TIME ZONE t.tz)::date,
           ((t.ts AT TIME ZONE t.tz) - INTERVAL '6 hours')::date
      FROM travel_log t
),
-- Per instant: real time (local date), awake tail (local behavioral date),
-- backdated 3 days (date-only: the date itself, label = log coverage of the
-- day at its last ET instant; never equal to the ET, local or behavioral date
-- of the instant, so never read as real time).
travel_results AS (
    SELECT c.tier, c.et, c.loc,
           (r.onyx_et_date, r.onyx_behavioral_date, r.onyx_local_date, r.onyx_tz_source)
           IS NOT DISTINCT FROM (e.want_et, e.want_beh, e.want_local, e.want_src) AS ok
      FROM travel c
     CROSS JOIN first_log f
     CROSS JOIN LATERAL (VALUES
         (c.loc,     c.et,      c.loc,     c.loc,     c.tier),
         (c.beh,     c.et,      c.beh,     c.loc,     c.tier),
         (c.loc - 3, c.loc - 3, c.loc - 3, c.loc - 3,
          CASE WHEN f.t IS NOT NULL
                AND f.t <= ((c.loc - 2)::timestamp AT TIME ZONE 'America/New_York')
                           - INTERVAL '1 microsecond'
               THEN 'user_tz_log' ELSE 'default_et_fallback' END)
     ) AS e (entry_date, want_et, want_beh, want_local, want_src)
     CROSS JOIN LATERAL pds.journal_entry_onyx_dates(e.entry_date, c.ts) r
),
-- Live journal entries (journal_etl.py re-upserts these hourly, archived ones
-- are not re-upserted): stored values vs the new rule and vs the old one.
journal_now AS (
    SELECT (je.onyx_et_date, je.onyx_behavioral_date, je.onyx_local_date, je.onyx_tz_source)
           IS NOT DISTINCT FROM (n.onyx_et_date, n.onyx_behavioral_date, n.onyx_local_date, n.onyx_tz_source)
               AS is_new,
           (je.onyx_et_date, je.onyx_behavioral_date, je.onyx_local_date, je.onyx_tz_source)
           IS NOT DISTINCT FROM (CASE WHEN o.rt THEN d.onyx_et_date ELSE je.entry_date END,
                                 je.entry_date,
                                 CASE WHEN o.rt THEN d.onyx_local_date ELSE je.entry_date END,
                                 CASE WHEN o.rt THEN d.onyx_tz_source ELSE 'default_et_fallback' END)
               AS is_old
      FROM pds.journal_entries je
     CROSS JOIN LATERAL pds.journal_entry_onyx_dates(je.entry_date, je.notion_created_at) n
     CROSS JOIN LATERAL pds.derive_onyx_dates(je.notion_created_at, NULL, NULL) d
     CROSS JOIN LATERAL (SELECT COALESCE(je.entry_date
                                         = (je.notion_created_at AT TIME ZONE 'America/New_York')::date,
                                         FALSE) AS rt) o
     WHERE je.archived IS NOT TRUE
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
    SELECT 'garmin_hrv_dates_are_wake_day', 'baseline',
           NOT EXISTS (SELECT 1 FROM pds.garmin_hrv
                        WHERE onyx_et_date IS DISTINCT FROM calendar_date
                           OR onyx_behavioral_date IS DISTINCT FROM calendar_date
                           OR onyx_local_date IS DISTINCT FROM calendar_date),
           'stored rows keyed by calendar_date (hrv_alignment.py does the one-day shift), compare with the pre-apply value'
    UNION ALL
    SELECT 'journal_entries_behavioral_is_entry_date', 'baseline',
           NOT EXISTS (SELECT 1 FROM pds.journal_entries
                        WHERE onyx_behavioral_date IS DISTINCT FROM entry_date),
           'the HRV pipeline groups journal entries by entry_date, compare with the pre-apply value'
    UNION ALL
    SELECT 'habit_journal_writable_rows_on_cycle_date', 'baseline',
           NOT EXISTS (SELECT 1 FROM pds.habit_journal
                        WHERE NOT (source = 'whoop' AND cycle_date <= DATE '2026-06-08')
                          AND (onyx_et_date IS DISTINCT FROM cycle_date
                               OR onyx_behavioral_date IS DISTINCT FROM cycle_date
                               OR onyx_local_date IS DISTINCT FROM cycle_date)),
           'stored rows outside the frozen WHOOP era carry cycle_date in all three dates, compare with the pre-apply value'
    UNION ALL
    SELECT 'journal_entries_rederived', 'rederived',
           CASE WHEN bool_and(j.is_new OR j.is_old) IS FALSE THEN FALSE
                WHEN bool_and(j.is_new) THEN TRUE END,
           CASE WHEN count(*) = 0 THEN 'undecidable: no live journal entries'
                WHEN bool_and(j.is_new OR j.is_old) IS FALSE THEN 'an entry matches neither the old nor the new rule'
                WHEN bool_and(j.is_new) THEN 'every live entry carries the new rule (pds.journal_entry_onyx_dates)'
                ELSE 'pending: some entries still carry the old rule, run again after the next journal sync (:35)' END
      FROM journal_now j
    UNION ALL
    SELECT 'journal_travel_' || tr.tier, 'live_context',
           CASE WHEN COALESCE(bool_or(x.loc <> x.et), FALSE) THEN bool_and(x.ok) END,
           CASE WHEN COALESCE(bool_or(x.loc <> x.et), FALSE)
                THEN 'pds.journal_entry_onyx_dates abroad (' || tr.tier || '): real time, awake tail, backdated'
                ELSE 'undecidable: no ' || tr.tier || ' instant abroad whose local date differs from its ET date' END
      FROM (VALUES ('cycle_anchor'), ('user_tz_log')) AS tr (tier)
      LEFT JOIN travel_results x ON x.tier = tr.tier
     GROUP BY tr.tier
    UNION ALL
    SELECT 'same_day_landing_first_log_day', 'live_context',
           CASE WHEN f.d IS NULL THEN NULL ELSE
               (SELECT r.onyx_tz_source FROM pds.derive_onyx_dates_for_day(f.d) r) = 'user_tz_log'
               AND (SELECT r.onyx_tz_source FROM pds.derive_onyx_dates_for_day(f.d - 1) r) = 'default_et_fallback'
           END,
           CASE WHEN f.d IS NULL THEN 'undecidable: user_tz_log is empty'
                ELSE 'the ET day the first log row starts on counts as covered, the day before does not' END
      FROM first_log f
    UNION ALL
    SELECT 'log_days_keep_their_date', 'live_context',
           NOT EXISTS (SELECT 1
                         FROM pds.user_tz_log u
                        CROSS JOIN LATERAL pds.derive_onyx_dates_for_day(
                                  (u.effective_from AT TIME ZONE u.tz)::date) r
                        WHERE r.onyx_local_date IS DISTINCT FROM (u.effective_from AT TIME ZONE u.tz)::date),
           'a date-only row on the local day of any log row (far-east included) keeps its date'
)
SELECT check_name, kind, passed, note
  FROM checks
 ORDER BY CASE kind WHEN 'definition' THEN 1 WHEN 'synthetic' THEN 2 WHEN 'live_context' THEN 3
                   WHEN 'rederived' THEN 4 ELSE 5 END, check_name;
