-- Audit P1 (Group C): schema FKs for Garmin laps → activities and
-- Spotify plays → tracks/artists. Same pattern as the WHOOP cycle hub FKs
-- in sql/whoop_cycle_fks.sql.
--
-- Orphan check on 2026-05-26: 0 orphans across 3849 laps + 721 plays, so
-- plain ADD CONSTRAINT (no NOT VALID + VALIDATE two-step needed).

-- ---------------------------------------------------------------------------
-- 1. Garmin laps → activities
-- ---------------------------------------------------------------------------
-- pds.garmin_activities PK is (activity_id, ts) so activity_id alone is not
-- constraint-unique even though it is unique in practice (349 rows, 349
-- distinct activity_ids). Add a column-unique index first so the FK has a
-- target.
CREATE UNIQUE INDEX IF NOT EXISTS uq_garmin_activities_activity_id
    ON pds.garmin_activities(activity_id);

-- Laps have no independent meaning without the parent activity, so CASCADE.
ALTER TABLE pds.garmin_activity_laps
    ADD CONSTRAINT garmin_activity_laps_activity_id_fkey
    FOREIGN KEY (activity_id)
    REFERENCES pds.garmin_activities(activity_id)
    ON UPDATE CASCADE
    ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Spotify plays → tracks
-- ---------------------------------------------------------------------------
-- Audit recommended ON DELETE SET NULL, but spotify_plays.track_id is NOT NULL
-- (it is part of the (played_at, track_id) PK). SET NULL would fail at delete
-- time. RESTRICT is the safer alternative and matches reality: spotify_tracks
-- is a monotonically-growing dim — we don't routinely delete tracks. If a
-- track row ever needs to be removed (e.g. dedup), the caller has to deal
-- with referencing plays first.
--
-- DEFERRABLE INITIALLY DEFERRED preserves the audit's intent of avoiding
-- ingest-order pain — within a single transaction the constraint check is
-- deferred until commit.
ALTER TABLE pds.spotify_plays
    ADD CONSTRAINT spotify_plays_track_id_fkey
    FOREIGN KEY (track_id)
    REFERENCES pds.spotify_tracks(track_id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- 3. Spotify plays → artists
-- ---------------------------------------------------------------------------
-- artist_id is nullable so SET NULL works as the audit recommended. Captures
-- the primary artist per the existing ETL convention; collaborator artists
-- on the same track are tracked separately via spotify_tracks raw_json and
-- not enforced by this FK (a separate audit ticket covers the multi-artist
-- handling).
ALTER TABLE pds.spotify_plays
    ADD CONSTRAINT spotify_plays_artist_id_fkey
    FOREIGN KEY (artist_id)
    REFERENCES pds.spotify_artists(artist_id)
    ON UPDATE CASCADE
    ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;
