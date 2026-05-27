-- ============================================================================
-- Audit re-2026-05-26 P3: drop redundant single-column indexes
-- ============================================================================
-- Notion: 36dbf5b4-4bf2-81f4-9f03-fb93eeab9783
--
-- The ticket named idx_mfp_nutrition_date / idx_weight_log_date /
-- idx_whoop_journal_<date>; none exist today (audit list was stale —
-- likely already dropped in an earlier cleanup pass). A current scan for
-- single-column indexes that duplicate a PK/UNIQUE leading column found
-- two true duplicates, both dropped here:
--
--   1. idx_habit_metadata_history_page_open
--      Same partial WHERE valid_to IS NULL on the same column as
--      uq_habit_metadata_history_one_open. Byte-for-byte duplicate.
--
--   2. idx_user_tz_log_effective_from (effective_from DESC)
--      Postgres btree scans the PK index in either direction; the explicit
--      DESC index buys nothing over user_tz_log_pkey.
--
-- The partial indexes added in audit_re_2026_05_26_covering_partial_indexes
-- (idx_spotify_tracks_featurized, idx_whoop_recovery_cycle_scored) are
-- intentionally KEPT — they share a leading column with the PK but apply
-- different WHERE predicates, so they're smaller-subset scans the planner
-- can pick when the filter matches.

DROP INDEX IF EXISTS pds.idx_habit_metadata_history_page_open;
DROP INDEX IF EXISTS pds.idx_user_tz_log_effective_from;
