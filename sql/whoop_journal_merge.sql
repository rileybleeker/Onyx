-- ============================================================================
-- WHOOP journal → habit_journal merge (2026-06-11)
-- ============================================================================
-- Replaces the WHOOP in-app journal (manual CSV export → email ETL) with the
-- Onyx habits system. ALL behavior data now lives in ONE table:
-- pds.habit_journal. The 30 WHOOP questions active in the last export
-- (cycle_date 2026-06-08) became Notion-defined habits with VERBATIM question
-- text as the habit title — the question string is the variable identity the
-- HRV pipeline keys on (journal_* feature columns), so it must never change.
--
-- Design invariants (DO NOT BREAK):
--   1. pds.journal view keeps the exact column contract
--      (cycle_date, behaviors_date, question, category, answer, notes,
--       synced_at, source) — hrv_analysis.py pivots source='whoop' rows into
--      journal_* features keyed on behaviors_date, source='habit' rows into
--      habit_* features.
--   2. Migrated WHOOP rows keep cycle_date = WHOOP bedtime-day and their
--      trigger-computed behaviors_date / onyx_* values VERBATIM. New rows
--      written via habit channels use cycle_date = behavioral day and
--      behaviors_date = cycle_date — the behaviors_date axis is continuous
--      across the cutover; cycle_date is NOT (bedtime-day before 2026-06-09,
--      behavior-day after).
--   3. source routing is by QUESTION IDENTITY, not write path: any insert of
--      a question whose habit_name_map.channel = 'whoop' gets source='whoop'
--      (trigger), so post-cutover taps keep feeding the same journal_*
--      feature columns.
--   4. WHOOP-derived habit names are FROZEN. Renaming one in Notion would
--      change the pipeline slug (journal_have_any_alcoholic_drinks etc. are
--      hard-coded). Guard triggers RAISE on rename attempts for
--      channel='whoop' names. A rename requires a coordinated migration
--      (history rewrite + hrv_analysis.py/causal_inference.py reference
--      updates).
--   5. pds.whoop_journal is a FROZEN ARCHIVE post-merge (kept as immutable
--      backup; the email ETL is decommissioned; the whoop_cycles
--      behaviors_date-refresh trigger is dropped).
--
-- Applied as three migrations (M3+M4 combined into ONE transaction after
-- adversarial review: applied separately, the old UNION view would have
-- emitted the copied WHOOP rows a second time as source='habit' in the gap —
-- and the migration's own backfill signal schedules the retrain that would
-- have read that poisoned view):
--   whoop_journal_merge_01_schema       (additive schema + triggers)
--   whoop_journal_merge_02_name_map     (59 map rows: real Notion ids for the
--                                        30 active questions, synthetic
--                                        'whoop-archived:' ids for the 29
--                                        retired ones)
--   whoop_journal_merge_03_data_and_view (data copy + Journaled merge +
--                                        explicit-No backfill + view swap +
--                                        freeze guards, single transaction;
--                                        deployed AFTER the frontend guards)
--
-- Known intentional gap: behaviors-day 2026-06-08 is permanently un-loggable
-- for WHOOP-derived questions. The final export's coverage ends at
-- behaviors-day 2026-06-07 (its cycle_date 2026-06-08 rows describe 06-07),
-- and the (2026-06-08, question) PK slots are occupied by those frozen rows —
-- post-cutover rows use cycle_date = behavior-day and start at 2026-06-09.
-- journal_* features are NaN for that one day forever; do NOT relax the
-- freeze guard to "fix" it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- M1 — schema prep (additive)
-- ----------------------------------------------------------------------------
ALTER TABLE pds.habit_journal ADD COLUMN IF NOT EXISTS behaviors_date date;
ALTER TABLE pds.habit_journal ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'habit';
ALTER TABLE pds.habit_journal DROP CONSTRAINT IF EXISTS habit_journal_source_check;
ALTER TABLE pds.habit_journal ADD CONSTRAINT habit_journal_source_check
  CHECK (source IN ('whoop', 'habit'));
CREATE INDEX IF NOT EXISTS idx_habit_journal_behaviors_date ON pds.habit_journal (behaviors_date);
CREATE INDEX IF NOT EXISTS idx_habit_journal_source ON pds.habit_journal (source);

ALTER TABLE pds.habit_name_map ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'habit';
ALTER TABLE pds.habit_name_map DROP CONSTRAINT IF EXISTS habit_name_map_channel_check;
ALTER TABLE pds.habit_name_map ADD CONSTRAINT habit_name_map_channel_check
  CHECK (channel IN ('whoop', 'habit'));

-- Onyx-dates trigger fn gains: behaviors_date fill + channel-based source
-- routing. For habit-channel rows cycle_date IS the behavior day, so
-- behaviors_date := cycle_date. For whoop-channel questions the map lookup
-- routes source='whoop' regardless of which write path inserted the row.
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_habit_journal()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    noon_et TIMESTAMPTZ;
    log_tz  TEXT;
BEGIN
    NEW.behaviors_date := COALESCE(NEW.behaviors_date, NEW.cycle_date);
    NEW.source := COALESCE(
        (SELECT channel FROM pds.habit_name_map WHERE habit_name = NEW.question),
        COALESCE(NEW.source, 'habit')
    );
    NEW.onyx_et_date         := NEW.cycle_date;
    NEW.onyx_behavioral_date := NEW.cycle_date;
    noon_et := (NEW.cycle_date::timestamp + INTERVAL '12 hours') AT TIME ZONE 'America/New_York';
    SELECT tz INTO log_tz FROM pds.user_tz_log
     WHERE effective_from <= noon_et ORDER BY effective_from DESC LIMIT 1;
    IF log_tz IS NOT NULL AND log_tz <> 'America/New_York' THEN
        NEW.onyx_local_date := (noon_et AT TIME ZONE log_tz)::date;
        NEW.onyx_tz_source  := 'user_tz_log';
    ELSIF log_tz = 'America/New_York' THEN
        NEW.onyx_local_date := NEW.cycle_date;
        NEW.onyx_tz_source  := 'user_tz_log';
    ELSE
        NEW.onyx_local_date := NEW.cycle_date;
        NEW.onyx_tz_source  := 'default_et_fallback';
    END IF;
    RETURN NEW;
END;
$function$;

-- Rename guards: WHOOP-derived question strings are pipeline variable
-- identities; block renames at both chokepoints (map rename would cascade
-- via the FK; direct journal UPDATEs come from the sync route's rename path).
CREATE OR REPLACE FUNCTION pds.block_whoop_habit_rename_map()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.channel = 'whoop' AND NEW.habit_name IS DISTINCT FROM OLD.habit_name THEN
        RAISE EXCEPTION 'WHOOP-derived habit name "%" is frozen — it is the HRV pipeline variable identity (journal_* feature slug). Renaming requires a coordinated migration (see sql/whoop_journal_merge.sql).', OLD.habit_name;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS habit_name_map_block_whoop_rename ON pds.habit_name_map;
CREATE TRIGGER habit_name_map_block_whoop_rename
BEFORE UPDATE ON pds.habit_name_map
FOR EACH ROW EXECUTE FUNCTION pds.block_whoop_habit_rename_map();

CREATE OR REPLACE FUNCTION pds.block_whoop_habit_rename_journal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.question IS DISTINCT FROM OLD.question
       AND EXISTS (SELECT 1 FROM pds.habit_name_map m
                   WHERE m.habit_name = OLD.question AND m.channel = 'whoop') THEN
        RAISE EXCEPTION 'Rows for WHOOP-derived question "%" cannot be renamed — frozen variable identity (see sql/whoop_journal_merge.sql).', OLD.question;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS habit_journal_block_whoop_rename ON pds.habit_journal;
CREATE TRIGGER habit_journal_block_whoop_rename
BEFORE UPDATE OF question ON pds.habit_journal
FOR EACH ROW EXECUTE FUNCTION pds.block_whoop_habit_rename_journal();

-- ----------------------------------------------------------------------------
-- M2 — habit_name_map rows (FK prerequisite for the data copy)
-- ----------------------------------------------------------------------------
-- 30 ACTIVE questions get REAL Notion page ids (created 2026-06-11, verbatim
-- titles). The 29 RETIRED questions get synthetic 'whoop-archived:<md5>' ids
-- (59 distinct questions all-time) — they exist only to satisfy
-- fk_habit_journal_question for historical rows; the Notion sync never
-- touches them (it iterates Active Notion pages by real id).
-- Applied with the actual id list — see the whoop_journal_merge_02_name_map
-- migration in Supabase for the exact rows.
-- Template:
--   INSERT INTO pds.habit_name_map (notion_page_id, habit_name, channel)
--   VALUES ('<notion-page-id>', '<verbatim question>', 'whoop')
--   ON CONFLICT (notion_page_id)
--   DO UPDATE SET habit_name = EXCLUDED.habit_name, channel = 'whoop';
-- Plus channel backstop for any row the hourly sync inserted first:
--   UPDATE pds.habit_name_map SET channel='whoop' WHERE habit_name IN (<60 questions>);

-- ----------------------------------------------------------------------------
-- M3 — data migration + view swap + freeze (ONE transaction)
-- ----------------------------------------------------------------------------
-- Applied as whoop_journal_merge_03_data_and_view AFTER the frontend guards
-- deployed (the previously-live code could corrupt frozen rows via the
-- undo → Notion-LC → hourly-sync path). Statements, in order:
--  0) No-op suppression for the backfill-signal trigger fn: the hourly sync's
--     idempotent LC upserts were firing 3 signals/hour → a full HRV retrain
--     EVERY hour (31 retrains in 48h observed pre-merge).
--  1) Copy all 12,360 whoop_journal rows VERBATIM (row triggers disabled so
--     the onyx-dates trigger can't overwrite bedtime-anchored values and the
--     backfill trigger can't emit 12k signals).
--  2) Merge the native 'Journaled' habit (13 Yes rows) into the WHOOP
--     variable 'Journaled your thoughts?' matched on behaviors_date (Yes
--     wins; verified: all 13 match, 6 flip No→Yes), delete the native rows,
--     and remove the orphaned map row (the Notion page was set Active=false).
--  3) behaviors_date := cycle_date for remaining native habit rows.
--  4) Explicit-No backfill for native daily habits with a tracking window
--     (AI, Lumosity): every day from first completion to yesterday
--     (behavioral) without a row gets answer='No' — "yes not marked = no"
--     (Riley, 2026-06-11). WHOOP history already carries explicit No rows.
--  5) View swap via CREATE OR REPLACE (grants survive; column contract
--     byte-identical to the old UNION view).
--  6) Drop the whoop_cycles → whoop_journal behaviors_date refresh trigger:
--     whoop-era rows are frozen history, and NEW rows use cycle_date =
--     behavior-day (a bedtime-day-keyed refresh would corrupt them).
--  7) Frozen-era guard on habit_journal + hard-freeze on whoop_journal
--     (RAISE on any write; bypass for future coordinated migrations via
--     SET onyx.allow_frozen_writes = 'on').
--  8) ONE manual backfill signal, as the LAST statement.

BEGIN;

-- (0) backfill-signal storm fix: ignore no-op UPDATEs
CREATE OR REPLACE FUNCTION pds.habit_journal_backfill_signal()
RETURNS TRIGGER AS $$
DECLARE
    affected_date DATE;
    today_et      DATE;
BEGIN
    -- No-op UPDATE (e.g. the hourly Notion sync re-upserting an existing
    -- completion) must not signal — it caused an hourly retrain storm.
    IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
    END IF;

    affected_date := COALESCE(NEW.cycle_date, OLD.cycle_date);
    today_et      := (NOW() AT TIME ZONE 'America/New_York')::date;

    IF affected_date < today_et THEN
        INSERT INTO pds.sync_log (
            source, data_type, sync_start, sync_end, status,
            records_synced, date_range_start, date_range_end
        ) VALUES (
            'habit_journal', 'backfill_signal', NOW(), NOW(), 'success',
            1, affected_date, affected_date
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- (1) verbatim copy
ALTER TABLE pds.habit_journal DISABLE TRIGGER habit_journal_backfill_trigger;
ALTER TABLE pds.habit_journal DISABLE TRIGGER habit_journal_set_onyx_dates;

INSERT INTO pds.habit_journal
  (cycle_date, question, category, answer, notes, synced_at, behaviors_date,
   onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source, source)
SELECT cycle_date, question, category, answer, notes, synced_at, behaviors_date,
       onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source, 'whoop'
FROM pds.whoop_journal;

-- (2) Journaled merge
UPDATE pds.habit_journal t
SET answer = 'Yes',
    notes  = COALESCE(t.notes || ' · ', '') || 'merged native Journaled completion'
FROM pds.habit_journal n
WHERE t.question = 'Journaled your thoughts?' AND t.source = 'whoop'
  AND n.question = 'Journaled' AND n.source = 'habit' AND n.answer = 'Yes'
  AND t.behaviors_date = n.cycle_date
  AND t.answer = 'No';

DELETE FROM pds.habit_journal n
WHERE n.question = 'Journaled' AND n.source = 'habit'
  AND EXISTS (SELECT 1 FROM pds.habit_journal w
              WHERE w.question = 'Journaled your thoughts?' AND w.source = 'whoop'
                AND w.behaviors_date = n.cycle_date);

DELETE FROM pds.habit_name_map WHERE habit_name = 'Journaled';

-- (3) behaviors_date for native habit rows
UPDATE pds.habit_journal SET behaviors_date = cycle_date
WHERE source = 'habit' AND behaviors_date IS NULL;

ALTER TABLE pds.habit_journal ENABLE TRIGGER habit_journal_set_onyx_dates;

-- (4) explicit-No backfill (AI, Lumosity)
INSERT INTO pds.habit_journal (cycle_date, question, category, answer, notes, source, behaviors_date)
SELECT d::date, h.question, h.category, 'No',
       'Backfilled No — no completion logged (merge migration 2026-06-11)',
       'habit', d::date
FROM (SELECT question, min(cycle_date) AS first_yes, max(category) AS category
      FROM pds.habit_journal
      WHERE source = 'habit' AND answer = 'Yes' AND question IN ('AI', 'Lumosity')
      GROUP BY question) h
CROSS JOIN LATERAL generate_series(h.first_yes, pds.behavioral_today_now() - 1, interval '1 day') d
WHERE NOT EXISTS (SELECT 1 FROM pds.habit_journal e
                  WHERE e.question = h.question AND e.cycle_date = d::date);

ALTER TABLE pds.habit_journal ENABLE TRIGGER habit_journal_backfill_trigger;

-- (5) view swap
CREATE OR REPLACE VIEW pds.journal AS
SELECT cycle_date,
       COALESCE(behaviors_date, cycle_date) AS behaviors_date,
       question, category, answer, notes, synced_at, source
FROM pds.habit_journal;

-- (6) retire the bedtime-day-keyed behaviors_date refresh
DROP TRIGGER IF EXISTS cycle_refresh_journal_behaviors_trigger ON pds.whoop_cycles;
DROP FUNCTION IF EXISTS pds.refresh_journal_behaviors_dates_for_cycle();

-- (7a) frozen-era guard on the merged table: whoop-era rows are immutable
-- from every write path (UI backdate picker, chat, sync, direct SQL).
CREATE OR REPLACE FUNCTION pds.block_frozen_whoop_era_writes()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('onyx.allow_frozen_writes', true) = 'on' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE')
       AND OLD.source = 'whoop' AND OLD.cycle_date <= DATE '2026-06-08' THEN
        RAISE EXCEPTION 'Frozen WHOOP-era row (%, "%") is immutable — the WHOOP journal historical record ends 2026-06-08. SET onyx.allow_frozen_writes = ''on'' only for coordinated migrations (sql/whoop_journal_merge.sql).',
            OLD.cycle_date, OLD.question;
    END IF;
    IF TG_OP = 'INSERT'
       AND NEW.source = 'whoop' AND NEW.cycle_date <= DATE '2026-06-08' THEN
        RAISE EXCEPTION 'Cannot insert into the frozen WHOOP era (%, "%") — post-cutover rows start at 2026-06-09 (sql/whoop_journal_merge.sql).',
            NEW.cycle_date, NEW.question;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;
-- zzz prefix: BEFORE triggers fire in name order; set_onyx_dates must run
-- first so NEW.source is populated when the INSERT branch checks it.
DROP TRIGGER IF EXISTS zzz_block_frozen_whoop_era ON pds.habit_journal;
CREATE TRIGGER zzz_block_frozen_whoop_era
BEFORE INSERT OR UPDATE OR DELETE ON pds.habit_journal
FOR EACH ROW EXECUTE FUNCTION pds.block_frozen_whoop_era_writes();

-- (7b) hard-freeze the archive (comment alone wouldn't stop a stray manual
-- run of the decommissioned email importer from writing rows nothing reads)
CREATE OR REPLACE FUNCTION pds.block_whoop_journal_archive_writes()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('onyx.allow_frozen_writes', true) = 'on' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    RAISE EXCEPTION 'pds.whoop_journal is a FROZEN ARCHIVE (2026-06-11) — all behavior data lives in pds.habit_journal. See sql/whoop_journal_merge.sql.';
END;
$$;
DROP TRIGGER IF EXISTS zzz_block_archive_writes ON pds.whoop_journal;
CREATE TRIGGER zzz_block_archive_writes
BEFORE INSERT OR UPDATE OR DELETE ON pds.whoop_journal
FOR EACH ROW EXECUTE FUNCTION pds.block_whoop_journal_archive_writes();

COMMENT ON TABLE pds.whoop_journal IS
  'FROZEN ARCHIVE (2026-06-11): full history merged into pds.habit_journal (source=''whoop''). Immutable backup — writes blocked by zzz_block_archive_writes. WHOOP email ETL decommissioned; see sql/whoop_journal_merge.sql.';

-- (8) one retrain signal, LAST — by now the view is already swapped, so the
-- retrain it schedules reads the merged single-table view.
INSERT INTO pds.sync_log (source, data_type, sync_start, sync_end, status,
                          records_synced, date_range_start, date_range_end)
VALUES ('habit_journal', 'backfill_signal', NOW(), NOW(), 'success',
        1, '2024-10-27', CURRENT_DATE);

COMMIT;
