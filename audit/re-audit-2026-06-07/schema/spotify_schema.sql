-- ============================================
-- Personal Data Scientist — Spotify Schema
-- ============================================
-- Deployed to Supabase (Postgres 17) in the pds schema.
-- Matches the pattern established by eight_sleep_schema.sql / whoop_schema.sql.
--
-- Two tables — intentionally NOT joined to daily_health_matrix.
-- Listening behavior stands on its own; any health correlation happens at
-- view/query time, never at storage. See memory: project_onyx_spotify.
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. Spotify Plays (append-only log, one row per played track)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.spotify_plays (
    played_at       TIMESTAMPTZ NOT NULL,
    -- ET-aligned date column matches canonical TZ used across the project
    played_date_et  DATE GENERATED ALWAYS AS
                        ((played_at AT TIME ZONE 'America/New_York')::date) STORED,
    track_id        TEXT NOT NULL,
    track_name      TEXT,
    artist_id       TEXT,
    artist_name     TEXT,
    album_id        TEXT,
    album_name      TEXT,
    duration_ms     INTEGER,
    context_type    TEXT,        -- 'playlist' | 'album' | 'artist' | 'collection' | null
    context_uri     TEXT,

    raw_json        JSONB,
    synced_at       TIMESTAMPTZ DEFAULT NOW(),

    PRIMARY KEY (played_at, track_id)
);

CREATE INDEX IF NOT EXISTS idx_spotify_plays_date
    ON pds.spotify_plays (played_date_et);
CREATE INDEX IF NOT EXISTS idx_spotify_plays_track
    ON pds.spotify_plays (track_id);
CREATE INDEX IF NOT EXISTS idx_spotify_plays_artist
    ON pds.spotify_plays (artist_id);

-- ---------------------------------------------------------------------------
-- 2. Spotify Tracks (dim table, one row per unique track)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.spotify_tracks (
    track_id        TEXT PRIMARY KEY,
    name            TEXT,
    artists         JSONB,       -- [{id, name}, ...]
    album           JSONB,       -- {id, name, release_date, images}
    duration_ms     INTEGER,
    popularity      INTEGER,
    explicit        BOOLEAN,
    isrc            TEXT,

    -- Audio features (nullable; populated from ReccoBeats for post-Nov-2024 apps)
    valence             NUMERIC(5,4),
    energy              NUMERIC(5,4),
    tempo               NUMERIC(7,3),
    danceability        NUMERIC(5,4),
    acousticness        NUMERIC(7,6),
    instrumentalness    NUMERIC(7,6),
    liveness            NUMERIC(5,4),
    speechiness         NUMERIC(5,4),
    loudness            NUMERIC(6,3),       -- dB, can be negative
    key                 SMALLINT,
    mode                SMALLINT,
    time_signature      SMALLINT,

    features_source     TEXT,               -- 'spotify' | 'reccobeats' | null
    features_fetched_at TIMESTAMPTZ,

    raw_json    JSONB,
    synced_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spotify_tracks_features_source
    ON pds.spotify_tracks (features_source);

-- ---------------------------------------------------------------------------
-- 3. Daily Audio Signature view (per-ET-date aggregate)
-- ---------------------------------------------------------------------------
-- Pushes the heavy aggregation into Postgres so the frontend reads a small
-- pre-shaped result. Mirrors the hrv_predictions_latest pattern (CLAUDE.md L125).
-- Only counts plays whose track has audio features attached, so the means
-- aren't biased by the unfeaturized tail.
DROP VIEW IF EXISTS pds.spotify_daily_signature;
CREATE VIEW pds.spotify_daily_signature AS
SELECT
    p.played_date_et                    AS calendar_date,
    COUNT(*)                            AS play_count,
    COUNT(DISTINCT p.track_id)          AS unique_tracks,
    COUNT(DISTINCT p.artist_id)         AS unique_artists,
    SUM(p.duration_ms) / 60000.0        AS total_minutes,
    AVG(t.valence)                      AS avg_valence,
    AVG(t.energy)                       AS avg_energy,
    AVG(t.tempo)                        AS avg_tempo,
    AVG(t.danceability)                 AS avg_danceability,
    AVG(t.acousticness)                 AS avg_acousticness,
    AVG(t.instrumentalness)             AS avg_instrumentalness,
    AVG(t.liveness)                     AS avg_liveness,
    AVG(t.speechiness)                  AS avg_speechiness,
    AVG(t.loudness)                     AS avg_loudness,
    COUNT(t.valence)                    AS featurized_plays    -- denominator for the feature means
FROM pds.spotify_plays p
LEFT JOIN pds.spotify_tracks t ON t.track_id = p.track_id
GROUP BY p.played_date_et
ORDER BY p.played_date_et DESC;

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE pds.spotify_plays  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.spotify_tracks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read" ON pds.spotify_plays  FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON pds.spotify_tracks FOR SELECT TO anon USING (true);

GRANT SELECT ON pds.spotify_plays           TO anon;
GRANT SELECT ON pds.spotify_tracks          TO anon;
GRANT SELECT ON pds.spotify_daily_signature TO anon;
