-- ============================================================================
-- Audit re-2026-05-26 P3: CHECK constraints on free-text enums (part 1)
-- ============================================================================
-- Notion: 36dbf5b4-4bf2-8100-b8fe-e19cf7e07864
--
-- Part 1 of the cluster ticket. Part 2 (journal_questions dim table + FK
-- from habit_journal/whoop_journal) has more ETL surface area; deferred.
--
-- Values verified against current production data before applying. The
-- audit-recommended bed_side IN ('left','right') would have rejected 8
-- existing rows where bed_side='away' (sleeping away from the bed) —
-- 'away' added to the allowed set.

ALTER TABLE pds.journal_entries
    ADD CONSTRAINT chk_journal_entries_mood
    CHECK (mood IS NULL OR mood IN ('low','neutral','good','great'));

ALTER TABLE pds.journal_entries
    ADD CONSTRAINT chk_journal_entries_confidence
    CHECK (confidence IS NULL OR confidence IN ('low','medium','high'));

ALTER TABLE pds.journal_entries
    ADD CONSTRAINT chk_journal_entries_source
    CHECK (source IS NULL OR source IN ('voice','typed','remarkable'));

ALTER TABLE pds.eight_sleep_trends
    ADD CONSTRAINT chk_eight_sleep_trends_bed_side
    CHECK (bed_side IS NULL OR bed_side IN ('left','right','away'));

ALTER TABLE pds.whoop_recovery
    ADD CONSTRAINT chk_whoop_recovery_score_state
    CHECK (score_state IS NULL OR score_state IN ('SCORED','PENDING_SCORE','UNSCORABLE'));

ALTER TABLE pds.whoop_sleep
    ADD CONSTRAINT chk_whoop_sleep_score_state
    CHECK (score_state IS NULL OR score_state IN ('SCORED','PENDING_SCORE','UNSCORABLE'));

ALTER TABLE pds.whoop_workouts
    ADD CONSTRAINT chk_whoop_workouts_score_state
    CHECK (score_state IS NULL OR score_state IN ('SCORED','PENDING_SCORE','UNSCORABLE'));

ALTER TABLE pds.whoop_cycles
    ADD CONSTRAINT chk_whoop_cycles_score_state
    CHECK (score_state IS NULL OR score_state IN ('SCORED','PENDING_SCORE','UNSCORABLE'));

ALTER TABLE pds.meal_events
    ADD CONSTRAINT chk_meal_events_kind
    CHECK (kind IS NULL OR kind IN ('last_meal','first_meal','snack','other'));
