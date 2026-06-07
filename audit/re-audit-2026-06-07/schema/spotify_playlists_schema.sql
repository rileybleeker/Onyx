-- ============================================
-- Personal Data Scientist — Spotify Playlists Schema
-- ============================================
-- One row per playlist created by Onyx (via chat or button).
-- Audit log + UI history. Separate from spotify_plays/spotify_tracks
-- so listening-history tables stay focused on raw events.
-- ============================================

CREATE TABLE IF NOT EXISTS pds.spotify_playlists (
    playlist_id   TEXT PRIMARY KEY,         -- Spotify playlist ID
    name          TEXT NOT NULL,
    description   TEXT,
    is_public     BOOLEAN DEFAULT FALSE,
    track_count   INTEGER,
    track_ids     JSONB,                    -- ordered array of Spotify track IDs at creation time
    spotify_url   TEXT,                     -- external_urls.spotify from API response
    created_via   TEXT,                     -- 'chat' | 'button'
    prompt        TEXT,                     -- user's chat message that triggered creation, if any
    raw_json      JSONB,                    -- full Spotify API response
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spotify_playlists_created_at
    ON pds.spotify_playlists (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spotify_playlists_created_via
    ON pds.spotify_playlists (created_via);

ALTER TABLE pds.spotify_playlists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read" ON pds.spotify_playlists FOR SELECT TO anon USING (true);

GRANT SELECT ON pds.spotify_playlists TO anon;
