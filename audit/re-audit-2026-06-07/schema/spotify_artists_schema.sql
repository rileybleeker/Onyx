-- ============================================
-- Personal Data Scientist — Spotify Artists Dim
-- ============================================
-- Per-artist enrichment (genres, popularity, followers) fetched from
-- Spotify's /v1/artists?ids=... endpoint. Sibling to pds.spotify_tracks.
--
-- Genres are an artist-level attribute on Spotify, NOT a track-level one,
-- which is why this lives in its own table rather than a column on tracks.
-- ============================================

CREATE TABLE IF NOT EXISTS pds.spotify_artists (
    artist_id           TEXT PRIMARY KEY,
    name                TEXT,
    genres              JSONB,       -- ["pop punk", "emo", ...] — empty array if Spotify has none
    popularity          INTEGER,     -- 0–100, Spotify's algorithmic score
    followers           INTEGER,     -- raw follower count
    image_url           TEXT,        -- largest image, if present

    raw_json            JSONB,
    fetched_at          TIMESTAMPTZ DEFAULT NOW(),
    synced_at           TIMESTAMPTZ DEFAULT NOW()
);

-- GIN index on genres so the analytics view (jsonb_array_elements_text)
-- doesn't full-scan when genre filters land later.
CREATE INDEX IF NOT EXISTS idx_spotify_artists_genres
    ON pds.spotify_artists USING GIN (genres);

ALTER TABLE pds.spotify_artists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read" ON pds.spotify_artists FOR SELECT TO anon USING (true);

GRANT SELECT ON pds.spotify_artists TO anon;
