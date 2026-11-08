-- ============================================================
-- Onyx — Reading module (2026-11-07)
-- ============================================================
-- Books Riley is reading, the sessions he logs (with a from-memory recall
-- note), highlights + comments (with spaced-repetition scheduling), review
-- grades, and checkpoint quiz results. Rendered on /reading as a "quest"
-- (progress ring, pace line, streak, XP, badges) and mirrored to a Notion
-- reading-log page per book. The habit_journal row for the book's habit
-- (books.habit_name) is stamped Yes on every session day so the existing
-- /habits streak and the HRV pipeline's habit_* columns see it too.
--
-- Not joined into daily_health_matrix (same isolation principle as
-- Spotify / supplements): reading is a behavior log, joined at query time.
-- XP, levels, badges and pace are DERIVED in the frontend (lib/reading.ts)
-- from these rows — nothing gamified is stored, so the rules can change
-- without a migration.
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.books (
    book_id        BIGSERIAL PRIMARY KEY,
    slug           TEXT        NOT NULL UNIQUE,            -- 'the-goal'
    title          TEXT        NOT NULL,
    author         TEXT,
    total_chapters INTEGER     CHECK (total_chapters IS NULL OR total_chapters > 0),
    start_date     DATE,
    target_date    DATE,
    status         TEXT        NOT NULL DEFAULT 'reading'
                   CHECK (status IN ('queued', 'reading', 'finished', 'abandoned')),
    finished_on    DATE,
    notion_page_id TEXT,                                   -- reading-log page (mirror target)
    habit_name     TEXT,                                   -- habit_journal question stamped on session days
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pds.reading_sessions (
    session_id      BIGSERIAL PRIMARY KEY,
    book_id         BIGINT      NOT NULL REFERENCES pds.books(book_id) ON DELETE CASCADE,
    session_date    DATE        NOT NULL,                  -- behavioral day (pds.behavioral_today_now)
    chapter_from    INTEGER     CHECK (chapter_from IS NULL OR chapter_from >= 0),
    chapter_through INTEGER     CHECK (chapter_through IS NULL OR chapter_through >= 0),
    minutes         INTEGER     CHECK (minutes IS NULL OR minutes >= 0),
    medium          TEXT        CHECK (medium IS NULL OR medium IN ('audio', 'kindle', 'paper', 'other')),
    recall          TEXT,                                  -- from-memory note (the retention step)
    question        TEXT,                                  -- one question for the client / plant manager
    notion_block_id TEXT,                                  -- set once mirrored to Notion
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_book_date ON pds.reading_sessions (book_id, session_date DESC);

CREATE TABLE IF NOT EXISTS pds.book_highlights (
    highlight_id    BIGSERIAL PRIMARY KEY,
    book_id         BIGINT      NOT NULL REFERENCES pds.books(book_id) ON DELETE CASCADE,
    chapter         INTEGER,
    location        TEXT,                                  -- Kindle location / page / audio timestamp
    passage         TEXT        NOT NULL,
    comment         TEXT,                                  -- Riley's annotation
    concept         TEXT,                                  -- concept tag (the TOC -> BC mapping key)
    source          TEXT        NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual', 'kindle', 'audible', 'paper', 'photo')),
    -- spaced repetition (SM-2 lite; see lib/reading.ts:gradeHighlight)
    review_count    INTEGER     NOT NULL DEFAULT 0,
    ease            NUMERIC(4,2) NOT NULL DEFAULT 2.50,
    interval_days   INTEGER     NOT NULL DEFAULT 0,
    next_review     DATE,                                  -- due when <= behavioral today
    last_reviewed   DATE,
    archived        BOOLEAN     NOT NULL DEFAULT FALSE,
    notion_block_id TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (book_id, passage)                              -- idempotent Kindle notebook re-import
);
CREATE INDEX IF NOT EXISTS idx_book_highlights_due ON pds.book_highlights (book_id, next_review) WHERE NOT archived;

CREATE TABLE IF NOT EXISTS pds.reading_reviews (
    review_id    BIGSERIAL PRIMARY KEY,
    highlight_id BIGINT      NOT NULL REFERENCES pds.book_highlights(highlight_id) ON DELETE CASCADE,
    review_date  DATE        NOT NULL,                     -- behavioral day
    grade        TEXT        NOT NULL CHECK (grade IN ('again', 'good', 'easy')),
    reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reading_reviews_date ON pds.reading_reviews (review_date DESC);

CREATE TABLE IF NOT EXISTS pds.reading_quizzes (
    quiz_id    BIGSERIAL PRIMARY KEY,
    book_id    BIGINT      NOT NULL REFERENCES pds.books(book_id) ON DELETE CASCADE,
    checkpoint TEXT        NOT NULL,                       -- e.g. 'ch12', 'ch26', 'ch40', 'review'
    score      INTEGER     NOT NULL CHECK (score >= 0),
    total      INTEGER     NOT NULL CHECK (total > 0),
    notes      TEXT,
    quiz_date  DATE        NOT NULL,
    taken_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- updated_at touch (same pattern as weight_log / meal_events)
CREATE OR REPLACE FUNCTION pds.reading_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Additive only (no DROP statements): applied 2026-11-07 via the Supabase MCP,
-- whose guard refuses DROP in ad-hoc SQL. CREATE OR REPLACE TRIGGER is PG14+.
CREATE OR REPLACE TRIGGER books_touch_updated_at
    BEFORE UPDATE ON pds.books FOR EACH ROW EXECUTE FUNCTION pds.reading_touch_updated_at();
CREATE OR REPLACE TRIGGER book_highlights_touch_updated_at
    BEFORE UPDATE ON pds.book_highlights FOR EACH ROW EXECUTE FUNCTION pds.reading_touch_updated_at();

-- -----------------------------------------------------------
-- RLS — anon read, service role full (mirrors weight_log)
-- -----------------------------------------------------------
ALTER TABLE pds.books            ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.reading_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.book_highlights  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.reading_reviews  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.reading_quizzes  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['books','reading_sessions','book_highlights','reading_reviews','reading_quizzes'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='pds' AND tablename=t AND policyname='anon_read') THEN
      EXECUTE format('CREATE POLICY "anon_read" ON pds.%I FOR SELECT TO anon USING (true)', t);
    END IF;
  END LOOP;
END $$;


GRANT SELECT ON pds.books, pds.reading_sessions, pds.book_highlights, pds.reading_reviews, pds.reading_quizzes TO anon, authenticated;
GRANT ALL    ON pds.books, pds.reading_sessions, pds.book_highlights, pds.reading_reviews, pds.reading_quizzes TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pds TO service_role;

-- -----------------------------------------------------------
-- Seed: The Goal (Goldratt), 40 chapters, Nov 8 -> Nov 30 2026.
-- Habit map row first: habit_journal.question has an FK to
-- habit_name_map.habit_name, and the hourly Notion sync may not have
-- created the 'Read The Goal' row yet.
-- -----------------------------------------------------------
INSERT INTO pds.habit_name_map (notion_page_id, habit_name, channel)
VALUES ('412bf5b4-4bf2-81dc-a2f2-c46a56364273', 'Read The Goal', 'habit')
ON CONFLICT DO NOTHING;

INSERT INTO pds.books (slug, title, author, total_chapters, start_date, target_date, status, notion_page_id, habit_name)
VALUES ('the-goal', 'The Goal: A Process of Ongoing Improvement', 'Eliyahu M. Goldratt', 40,
        DATE '2026-11-08', DATE '2026-11-30', 'reading',
        '412bf5b4-4bf2-81ac-a675-de1ae4ab1021', 'Read The Goal')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2026-11-08 — Automatic progress from Kindle (tools/kindle_harvest + lib/reading.ts:syncKindleSessions)
--
-- The harvester now reads the Kindle for Web reader (not the Notebook DOM): the book's table of
-- contents (chapter start positions), its location map (print page labels), every highlight/note
-- with Kindle position + real timestamp, and the Whispersync "most recent position read".
-- Onyx derives sessions from that, so Riley never logs a Kindle session by hand:
--   * a highlight on a chapter's last page (or within ~800 positions of its end) completes it;
--     a highlight inside chapter N proves N-1 is done; the reading position works the same way;
--   * every behavioral day with a new highlight/note gets ONE source='kindle' session (unique
--     index below) whose recall = that day's notes verbatim; chapter_from/through are set only
--     when the day advanced the cumulative chapter count, else in_chapter records where he read.
-- Manual / chat sessions keep source='manual' | 'chat' and are never touched by the sync.
-- Applied live 2026-11-08 via execute_sql (additive form).
-- ---------------------------------------------------------------------------
ALTER TABLE pds.books
    ADD COLUMN IF NOT EXISTS asin             TEXT,          -- Kindle ASIN (reader URL key)
    ADD COLUMN IF NOT EXISTS last_position    INTEGER,       -- Whispersync most-recent position (monotonic in Onyx)
    ADD COLUMN IF NOT EXISTS last_position_at TIMESTAMPTZ,   -- when last_position last advanced
    ADD COLUMN IF NOT EXISTS total_positions  INTEGER;       -- metadata.lastPositionId

CREATE TABLE IF NOT EXISTS pds.book_chapters (
    book_id        BIGINT  NOT NULL REFERENCES pds.books(book_id) ON DELETE CASCADE,
    chapter        INTEGER NOT NULL CHECK (chapter >= 0),
    title          TEXT,
    start_position INTEGER NOT NULL,                         -- toc.json tocPositionId
    end_position   INTEGER,                                  -- next entry's start - 1
    start_page     INTEGER,                                  -- print page label at start_position
    end_page       INTEGER,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (book_id, chapter)
);
ALTER TABLE pds.book_chapters ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='pds' AND tablename='book_chapters' AND policyname='anon_read') THEN
    CREATE POLICY anon_read ON pds.book_chapters FOR SELECT TO anon, authenticated USING (true);
  END IF;
END $$;
GRANT SELECT ON pds.book_chapters TO anon, authenticated;
GRANT ALL ON pds.book_chapters TO service_role;

ALTER TABLE pds.book_highlights
    ADD COLUMN IF NOT EXISTS position        INTEGER,        -- Kindle Mobi7 position (start)
    ADD COLUMN IF NOT EXISTS position_end    INTEGER,
    ADD COLUMN IF NOT EXISTS page            INTEGER,        -- print page label
    ADD COLUMN IF NOT EXISTS highlighted_at  TIMESTAMPTZ,    -- Kindle modifiedTimestamp of the highlight
    ADD COLUMN IF NOT EXISTS note_at         TIMESTAMPTZ,    -- Kindle modifiedTimestamp of the attached note
    ADD COLUMN IF NOT EXISTS behavioral_date DATE;           -- trigger-set from highlighted_at (−6h rule, TZ-aware)

ALTER TABLE pds.reading_sessions
    ADD COLUMN IF NOT EXISTS source          TEXT NOT NULL DEFAULT 'manual',   -- manual | chat | kindle
    ADD COLUMN IF NOT EXISTS in_chapter      INTEGER,        -- chapter being read when no chapter completed that day
    ADD COLUMN IF NOT EXISTS highlight_count INTEGER,
    ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='reading_sessions_source_check') THEN
    ALTER TABLE pds.reading_sessions ADD CONSTRAINT reading_sessions_source_check CHECK (source IN ('manual','chat','kindle'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_reading_sessions_kindle_day ON pds.reading_sessions (book_id, session_date) WHERE source = 'kindle';

-- Behavioral day for any instant (same rule as pds.behavioral_today_now, TZ-aware via user_tz_log).
CREATE OR REPLACE FUNCTION pds.behavioral_date_for(ts TIMESTAMPTZ) RETURNS DATE LANGUAGE sql STABLE AS $$
    SELECT ((ts AT TIME ZONE pds.tz_for_instant(ts)) - INTERVAL '6 hours')::date;
$$;

CREATE OR REPLACE FUNCTION pds.set_book_highlight_behavioral_date() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.behavioral_date := pds.behavioral_date_for(COALESCE(NEW.highlighted_at, NEW.note_at, NEW.created_at, NOW()));
    RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_book_highlights_behavioral_date
    BEFORE INSERT OR UPDATE OF highlighted_at, note_at ON pds.book_highlights
    FOR EACH ROW EXECUTE FUNCTION pds.set_book_highlight_behavioral_date();

CREATE OR REPLACE TRIGGER trg_reading_sessions_touch
    BEFORE UPDATE ON pds.reading_sessions FOR EACH ROW EXECUTE FUNCTION pds.reading_touch_updated_at();

UPDATE pds.book_highlights SET behavioral_date = pds.behavioral_date_for(created_at) WHERE behavioral_date IS NULL;
