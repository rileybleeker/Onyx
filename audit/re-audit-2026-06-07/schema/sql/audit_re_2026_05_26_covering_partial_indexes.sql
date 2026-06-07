-- ============================================================================
-- Audit re-2026-05-26 P2: covering/partial indexes for hot JOIN filters.
-- ============================================================================
-- Notion: 36dbf5b4-4bf2-8195-bda2-c6d172f7d622
--
-- Two clusters of hot joins repeatedly filter by predicates the existing
-- single-column indexes don't exploit:
--   1. daily_health_matrix_behavioral's JOINs to whoop_recovery /
--      whoop_sleep filter score_state='SCORED' (+ is_nap=false on sleep).
--      garmin_sleep_best_per_behavioral_date orders by (onyx_behavioral_date,
--      overall_sleep_score DESC NULLS LAST).
--   2. spotify_daily_signature aggregates by played_date_et and LEFT JOINs
--      to spotify_tracks WHERE valence IS NOT NULL.
--
-- Partial indexes for (1) keep the index payload tight and let the planner
-- skip the score_state column entirely. Composite + partial for (2) match
-- the GROUP BY / LEFT JOIN keys.

-- ---- WHOOP SCORED filters ----
CREATE INDEX IF NOT EXISTS idx_whoop_recovery_cycle_scored
    ON pds.whoop_recovery (cycle_id)
    WHERE score_state = 'SCORED';

CREATE INDEX IF NOT EXISTS idx_whoop_sleep_cycle_scored_main
    ON pds.whoop_sleep (cycle_id)
    WHERE score_state = 'SCORED' AND is_nap = false;

-- ---- garmin_sleep best-of-day support ----
CREATE INDEX IF NOT EXISTS idx_garmin_sleep_behavioral_score
    ON pds.garmin_sleep (onyx_behavioral_date, overall_sleep_score DESC)
    WHERE overall_sleep_score IS NOT NULL;

-- ---- spotify_daily_signature aggregate / LEFT JOIN ----
CREATE INDEX IF NOT EXISTS idx_spotify_plays_date_track
    ON pds.spotify_plays (played_date_et, track_id);

CREATE INDEX IF NOT EXISTS idx_spotify_tracks_featurized
    ON pds.spotify_tracks (track_id)
    WHERE valence IS NOT NULL;
