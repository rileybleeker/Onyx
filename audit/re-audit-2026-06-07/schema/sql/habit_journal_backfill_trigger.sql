-- ============================================
-- pds.habit_journal — backfill detection trigger
-- ============================================
-- Applied 2026-05-20 via the `habit_journal_backfill_signal_trigger`
-- migration. This .sql file is the canonical definition for git history.
--
-- When a habit completion is added/changed/removed for a historical date
-- (cycle_date < today ET), the trigger emits a pds.sync_log heartbeat so
-- hrv_backfill_check.py picks it up on the next hourly run and triggers
-- an HRV analysis retrain via the hrv-retrain-on-backfill workflow.
--
-- Why a trigger instead of logging from the API:
--   - Catches all write paths uniformly: POST /api/habits/complete (UI),
--     mark_habit_complete (chat tool), POST /api/habits/sync (Notion
--     hourly cron), and any direct SQL.
--   - Catches DELETE (undoing a past completion), which leaves no row
--     for the existing "WHERE synced_at > last_analysis" check to find.
--   - Catches the UPDATE branch of upsert, which doesn't bump synced_at
--     because the API call doesn't include it in the patch object.
--   - Centralized — no risk of a future write path forgetting to log.

CREATE OR REPLACE FUNCTION pds.habit_journal_backfill_signal()
RETURNS TRIGGER AS $$
DECLARE
    affected_date DATE;
    today_et      DATE;
BEGIN
    -- Pick the cycle_date from NEW (INSERT/UPDATE) or OLD (DELETE).
    affected_date := COALESCE(NEW.cycle_date, OLD.cycle_date);
    today_et      := (NOW() AT TIME ZONE 'America/New_York')::date;

    -- Only signal for historical writes. Today's mutations are picked up
    -- by the daily safety-net retrain at 12:00 UTC; an hourly retrain
    -- for every today-tap would be wasteful.
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

DROP TRIGGER IF EXISTS habit_journal_backfill_trigger ON pds.habit_journal;
CREATE TRIGGER habit_journal_backfill_trigger
AFTER INSERT OR UPDATE OR DELETE ON pds.habit_journal
FOR EACH ROW
EXECUTE FUNCTION pds.habit_journal_backfill_signal();
