-- ============================================
-- Personal Data Scientist — Notion Journal Schema
-- ============================================
-- One row per Notion Journal entry. Source of truth = Notion; this table is
-- an analytical mirror with embeddings for semantic search.
--
-- NOTE on naming: pds.journal_entries (this table) holds the personal diary
-- from Notion. pds.journal (a view, defined elsewhere) UNIONs whoop_journal +
-- habit_journal and represents *behavior* booleans, not the diary. The names
-- are kept distinct on purpose; the view predates this table.
-- ============================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS pds.journal_entries (
    notion_page_id     UUID PRIMARY KEY,
    -- ET-aligned. Notion's Date property is naive-date (no time/zone),
    -- so we store it directly. Joins cleanly with daily_health_matrix.calendar_date.
    entry_date         DATE NOT NULL,
    title              TEXT,
    mood               TEXT,                          -- low | neutral | good | great
    source             TEXT,                          -- voice | remarkable | typed
    confidence         TEXT,                          -- high | medium | low
    topics             JSONB,                         -- array of strings, e.g. ["gym","reflection"]
    content_md         TEXT,                          -- page body as markdown
    word_count         INTEGER,                       -- derived; precomputed for fast length filters

    embedding          vector(1024),                  -- voyage-3-large dimensionality
    embedding_model    TEXT,                          -- provenance, e.g. 'voyage-3-large'

    notion_created_at  TIMESTAMPTZ,
    notion_edited_at   TIMESTAMPTZ,                   -- skip-if-unchanged guard for incremental sync
    archived           BOOLEAN NOT NULL DEFAULT FALSE, -- soft delete; preserves history

    synced_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_date
    ON pds.journal_entries (entry_date);

CREATE INDEX IF NOT EXISTS idx_journal_entries_mood
    ON pds.journal_entries (mood);

CREATE INDEX IF NOT EXISTS idx_journal_entries_topics
    ON pds.journal_entries USING GIN (topics);

CREATE INDEX IF NOT EXISTS idx_journal_entries_embedding
    ON pds.journal_entries USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- RLS — same pattern as the rest of pds: anon = read-only, service = full.
-- ---------------------------------------------------------------------------
ALTER TABLE pds.journal_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read" ON pds.journal_entries
    FOR SELECT TO anon USING (true);

GRANT SELECT ON pds.journal_entries TO anon;
