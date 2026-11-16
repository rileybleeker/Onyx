-- ============================================================
-- Onyx — Reading question bank (READ-QUIZ-01, 2026-11-16)
-- ============================================================
-- A private, sourced question bank per book (docs/reading-question-bank.md):
--   * ideas written in Onyx's words, each tied to stored evidence (an API web citation snippet or one of Riley's
--     highlights); an idea without evidence is refused by the store function;
--   * questions stored as PROD-T07 question versions (pds.reading_questions, source_kind 'idea' or 'chapter');
--   * answers stored as PROD-T07 attempts (pds.reading_question_attempts) with added columns;
--   * a rebuildable per-idea schedule cache (pds.reading_idea_state; lib/reading-recall.ts replayIdeaState);
--   * a job queue that meters model spending (cost reserved at claim, charged at finish, per-book and monthly caps);
--   * flags that void scores openly (answers are kept, marked invalidated, never removed).
-- The spoiler boundary is ONE function, pds.reading_bank_quiz_through(book): every read here (round, summary,
-- chapter map, chapter sheet, T07's export) and the attempt function serve only ideas and questions whose
-- unlock_chapter is at or below it and whose chapter_hash is the current one, so locked or stale rows never leave
-- the server. A chapter recall rubric lists only ideas that unlock with that chapter, and it gets a new version
-- whenever a flag moves or retires one of them.
-- An idea is served only while it has valid evidence: a web citation, or a highlight whose passage still has the
-- sha256 it had when it was stored (pds.reading_bank_idea_supported). An edited highlight is offered to the
-- highlights step again; the idea it supported pauses until it is linked again or has other evidence.
--
-- APPLY ORDER: sql/reading_practice_receipts.sql, sql/reading_learning_questions.sql, then (only when
-- pds.reading_bank_schema_ok() reports a check missing) sql/reading_question_bank_checks.sql in the dashboard,
-- then this file. Re-apply this file whenever reading_learning_questions.sql is applied again: it re-defines two
-- T07 functions, pds.reading_source_text (an added 'idea' branch) and pds.reading_questions_export (bank rows above
-- the spoiler gate left out), and that file's own definitions lack both.
-- T07 paths are fenced off from bank rows by two triggers: a bank question takes answers only through
-- pds.reading_bank_attempt and grades only through the bank's grade functions (T07's 'grade' kind would leave the
-- verdict, score and schedule unset), and a new version of a bank question is made only by this file's functions.
--
-- Additive only, so it can go through the Supabase MCP: new tables, added columns, indexes, functions, triggers.
-- Every new table: row level security on, no policies, service_role only (the browser never reads them; an
-- owner-readable table would let a signed-in browser read locked chapters through PostgREST).
-- Every write function takes the advisory lock pds.reading_practice (questions, attempts, grades, flags, states)
-- or pds.reading_bank_claim (queue, approval, source map) before writing.
-- A queue run is fenced by TWO numbers from the claim's answer, and reserve, finish, store and the source-map write
-- all need both: `attempts` (the tries a job has used; the planner's re-queue resets it, so a number can come round
-- again) and `claim_seq` (one more with every claim and never reset, so a worker whose lease ran out can never match
-- a later claim's number, whatever the job went through in between).
-- ============================================================

-- 1. Per-book state: Riley's approval (the spending cap), the source map, a "Not read yet" hold -------------------
CREATE TABLE IF NOT EXISTS pds.reading_bank_books (
    book_id              BIGINT        PRIMARY KEY REFERENCES pds.books(book_id),
    approved_at          TIMESTAMPTZ,
    approved_cents       INTEGER       CHECK (approved_cents IS NULL OR approved_cents BETWEEN 100 AND 2500),
    spent_cents          NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
    paused_at            TIMESTAMPTZ,
    paused_reason        TEXT          CHECK (paused_reason IS NULL OR paused_reason IN ('owner', 'budget')),
    mapping              TEXT          NOT NULL DEFAULT 'unknown' CHECK (mapping IN ('unknown', 'ok', 'uncertain')),
    narrative            BOOLEAN,
    source_chapter_count INTEGER       CHECK (source_chapter_count IS NULL OR source_chapter_count >= 0),
    map_urls             JSONB         NOT NULL DEFAULT '[]'::jsonb
                                       CHECK (jsonb_typeof(map_urls) = 'array' AND jsonb_array_length(map_urls) <= 8),
    toc_hash             TEXT          CHECK (toc_hash IS NULL OR toc_hash ~ '^[0-9a-f]{64}$'),
    map_rebuilds         INTEGER       NOT NULL DEFAULT 0 CHECK (map_rebuilds >= 0), -- book-level Rebuild taps (part of the map job hash)
    hold_chapter         INTEGER       CHECK (hold_chapter IS NULL OR hold_chapter >= 1),
    hold_position        INTEGER,
    hold_at              TIMESTAMPTZ,
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CHECK ((paused_at IS NULL) = (paused_reason IS NULL)),
    CHECK ((hold_chapter IS NULL) = (hold_at IS NULL))
);
ALTER TABLE pds.reading_bank_books ADD COLUMN IF NOT EXISTS map_rebuilds INTEGER NOT NULL DEFAULT 0 CHECK (map_rebuilds >= 0);

-- 2. Per-chapter build state + when the chapter became quizzable ------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.reading_bank_chapters (
    book_id         BIGINT      NOT NULL REFERENCES pds.books(book_id),
    chapter         INTEGER     NOT NULL CHECK (chapter >= 0),          -- 0 = whole-book ideas (uncertain mapping)
    status          TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'ready', 'thin', 'anchors_only', 'no_sources', 'failed')),
    chapter_hash    TEXT        CHECK (chapter_hash IS NULL OR chapter_hash ~ '^[0-9a-f]{64}$'),
    ideas           INTEGER     NOT NULL DEFAULT 0,
    questions       INTEGER     NOT NULL DEFAULT 0,
    sources         INTEGER     NOT NULL DEFAULT 0,
    rejected        INTEGER     NOT NULL DEFAULT 0,
    rebuilds        INTEGER     NOT NULL DEFAULT 0 CHECK (rebuilds >= 0),  -- "Rebuild chapter" taps (part of job hashes)
    built_rebuilds  INTEGER     NOT NULL DEFAULT 0 CHECK (built_rebuilds >= 0), -- the rebuild counter the stored bank was built for
    built_at        TIMESTAMPTZ,
    prompt_version  TEXT,
    quizzable_since DATE,                                               -- behavioral day it first became quizzable
    quizzable_at    TIMESTAMPTZ,
    PRIMARY KEY (book_id, chapter)
);

-- 3. Evidence: API web citations (snippet only, never a page) and references to Riley's highlights ---------------
CREATE TABLE IF NOT EXISTS pds.reading_bank_sources (
    source_id    BIGSERIAL   PRIMARY KEY,
    book_id      BIGINT      NOT NULL REFERENCES pds.books(book_id),
    chapter      INTEGER     CHECK (chapter IS NULL OR chapter >= 0),
    kind         TEXT        NOT NULL CHECK (kind IN ('web', 'highlight')),
    url          TEXT        CHECK (url IS NULL OR (url ~ '^https?://' AND length(url) <= 2000)),
    domain       TEXT        CHECK (domain IS NULL OR length(domain) <= 253),
    title        TEXT        CHECK (title IS NULL OR length(title) <= 300),
    cited_text   TEXT        CHECK (cited_text IS NULL OR length(cited_text) <= 300),
    highlight_id BIGINT      REFERENCES pds.book_highlights(highlight_id),
    passage_sha  TEXT        CHECK (passage_sha IS NULL OR passage_sha ~ '^[0-9a-f]{64}$'), -- the passage it was stored against
    content_hash TEXT        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    job_id       BIGINT,
    retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((kind = 'web' AND url IS NOT NULL AND cited_text IS NOT NULL AND highlight_id IS NULL AND passage_sha IS NULL)
        OR (kind = 'highlight' AND url IS NULL AND cited_text IS NULL AND highlight_id IS NOT NULL AND passage_sha IS NOT NULL)),
    UNIQUE (book_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_reading_bank_sources_highlight ON pds.reading_bank_sources (highlight_id) WHERE highlight_id IS NOT NULL;

-- Highlight contents a build or a highlights step has already looked at (a pair id + sha256 of the passage), so the
-- planner offers a highlight again only when it is new or its passage changed: a review or a Kindle re-import
-- touches updated_at but not the content, and costs nothing.
CREATE TABLE IF NOT EXISTS pds.reading_bank_highlight_seen (
    highlight_id BIGINT      NOT NULL REFERENCES pds.book_highlights(highlight_id),
    passage_sha  TEXT        NOT NULL CHECK (passage_sha ~ '^[0-9a-f]{64}$'),
    book_id      BIGINT      NOT NULL REFERENCES pds.books(book_id),
    chapter      INTEGER,
    job_id       BIGINT,
    seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (highlight_id, passage_sha)
);

-- 4. Ideas: immutable once stored (a correction retires the row and stores a new one) ----------------------------
CREATE TABLE IF NOT EXISTS pds.reading_ideas (
    idea_id        BIGSERIAL   PRIMARY KEY,
    book_id        BIGINT      NOT NULL REFERENCES pds.books(book_id),
    chapter        INTEGER     NOT NULL CHECK (chapter >= 0),
    unlock_chapter INTEGER     NOT NULL,
    chapter_hash   TEXT        NOT NULL CHECK (chapter_hash ~ '^[0-9a-f]{64}$'),
    kind           TEXT        NOT NULL CHECK (kind IN ('claim', 'concept', 'framework', 'example', 'term', 'person', 'event', 'number', 'lesson')),
    importance     TEXT        NOT NULL CHECK (importance IN ('core', 'supporting', 'detail')),
    title          TEXT        NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 90),
    statement      TEXT        NOT NULL CHECK (length(btrim(statement)) BETWEEN 1 AND 400),
    key_points     JSONB       NOT NULL CHECK (jsonb_typeof(key_points) = 'array' AND jsonb_array_length(key_points) BETWEEN 1 AND 5),
    facts          JSONB       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(facts) = 'array' AND jsonb_array_length(facts) <= 6),
    origin         TEXT        NOT NULL CHECK (origin IN ('web', 'highlight', 'both')),
    status         TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    retired_reason TEXT        CHECK (retired_reason IS NULL OR retired_reason IN ('wrong', 'rebuilt', 'toc_changed', 'duplicate')),
    retired_at     TIMESTAMPTZ,
    content_hash   TEXT        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    prompt_version TEXT        NOT NULL,
    job_id         BIGINT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (unlock_chapter >= chapter),
    CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reading_ideas_active_content ON pds.reading_ideas (book_id, content_hash) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_reading_ideas_unlock ON pds.reading_ideas (book_id, unlock_chapter) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_reading_ideas_chapter ON pds.reading_ideas (book_id, chapter);

CREATE TABLE IF NOT EXISTS pds.reading_idea_evidence (
    idea_id   BIGINT NOT NULL REFERENCES pds.reading_ideas(idea_id),
    source_id BIGINT NOT NULL REFERENCES pds.reading_bank_sources(source_id),
    PRIMARY KEY (idea_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_reading_idea_evidence_source ON pds.reading_idea_evidence (source_id);

-- 5. Schedule cache per idea (rebuildable by replaying its answers: lib/reading-recall.ts replayIdeaState) -------
CREATE TABLE IF NOT EXISTS pds.reading_idea_state (
    idea_id           BIGINT       PRIMARY KEY REFERENCES pds.reading_ideas(idea_id),
    book_id           BIGINT       NOT NULL REFERENCES pds.books(book_id),
    stage             SMALLINT     NOT NULL DEFAULT 0 CHECK (stage BETWEEN 0 AND 4), -- new, seen, recalled, explained, kept
    ease              NUMERIC(4,2) NOT NULL DEFAULT 2.50,
    interval_days     INTEGER      NOT NULL DEFAULT 0,
    review_count      INTEGER      NOT NULL DEFAULT 0,
    next_review       DATE,
    last_reviewed     DATE,
    lapses            INTEGER      NOT NULL DEFAULT 0,
    last_verdict      TEXT         CHECK (last_verdict IS NULL OR last_verdict IN ('correct', 'partial', 'incorrect', 'dont_know')),
    stage_success_on  DATE,
    last_question_ids BIGINT[]     NOT NULL DEFAULT '{}',
    state_version     INTEGER      NOT NULL DEFAULT 0,
    dirty             BOOLEAN      NOT NULL DEFAULT FALSE,    -- set by a flag; the next attempt or the worker replays it
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reading_idea_state_due ON pds.reading_idea_state (book_id, next_review);
CREATE INDEX IF NOT EXISTS idx_reading_idea_state_dirty ON pds.reading_idea_state (book_id) WHERE dirty;

-- 6. Job queue + spending ledger (text-free except the cited research notes in `output`) --------------------------
CREATE TABLE IF NOT EXISTS pds.reading_bank_jobs (
    job_id          BIGSERIAL     PRIMARY KEY,
    book_id         BIGINT        NOT NULL REFERENCES pds.books(book_id),
    step            TEXT          NOT NULL CHECK (step IN ('map', 'research', 'build', 'highlights', 'grade')),
    chapter         INTEGER       NOT NULL DEFAULT 0 CHECK (chapter >= 0),
    input_hash      TEXT          NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    prompt_version  TEXT          NOT NULL,
    attempt_key     UUID          REFERENCES pds.reading_question_attempts(attempt_key),
    status          TEXT          NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
    priority        INTEGER       NOT NULL DEFAULT 100,
    attempts        SMALLINT      NOT NULL DEFAULT 0,   -- tries used (a re-queue resets it); NOT the fence on its own
    claim_seq       BIGINT        NOT NULL DEFAULT 0,   -- claims made, never reset: with attempts, the fence of a queue run
    next_attempt_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    lease_until     TIMESTAMPTZ,
    reserved_cents  NUMERIC(10,2) NOT NULL DEFAULT 0,
    cost_cents      NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
    charged_at      TIMESTAMPTZ,  -- when cost_cents last grew: the month's spend is read from it, never from the queue's own times
    usage           JSONB,
    result          TEXT          CHECK (result IS NULL OR result IN ('ready', 'thin', 'anchors_only', 'no_sources')),
    counts          JSONB,
    output          JSONB         CHECK (output IS NULL OR length(output::text) <= 60000),
    store_receipt   JSONB,        -- what pds.reading_bank_store answered for this job (a repeated store replays it)
    error_code      TEXT          CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,40}$'),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    CHECK ((step = 'grade') = (attempt_key IS NOT NULL)),
    UNIQUE (book_id, step, chapter, input_hash)
);
CREATE INDEX IF NOT EXISTS idx_reading_bank_jobs_claim ON pds.reading_bank_jobs (status, priority, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_reading_bank_jobs_month ON pds.reading_bank_jobs (finished_at);
ALTER TABLE pds.reading_bank_jobs ADD COLUMN IF NOT EXISTS charged_at TIMESTAMPTZ;
ALTER TABLE pds.reading_bank_jobs ADD COLUMN IF NOT EXISTS claim_seq BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_reading_bank_jobs_charged ON pds.reading_bank_jobs (charged_at) WHERE charged_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reading_bank_jobs_book ON pds.reading_bank_jobs (book_id, step, chapter);

-- 7. Flags on questions (replay safe by flag_key) -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.reading_question_flags (
    flag_key             UUID        PRIMARY KEY,
    question_id          BIGINT      NOT NULL REFERENCES pds.reading_questions(question_id),
    idea_id              BIGINT      REFERENCES pds.reading_ideas(idea_id),
    kind                 TEXT        NOT NULL CHECK (kind IN ('wrong', 'unclear', 'not_in_chapter', 'not_read_yet')),
    via                  TEXT        NOT NULL DEFAULT 'app' CHECK (via IN ('app', 'chat')),
    request_hash         TEXT        NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    invalidated_attempts INTEGER     NOT NULL DEFAULT 0,
    prev_unlock          INTEGER,                                      -- not_in_chapter: the unlock chapter Restore puts back
    prompt_version       TEXT,
    restored_at          TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reading_question_flags_question ON pds.reading_question_flags (question_id);
CREATE INDEX IF NOT EXISTS idx_reading_question_flags_wrong_idea ON pds.reading_question_flags (idea_id) WHERE kind = 'wrong';

-- 8. PROD-T07 tables: added columns only ----------------------------------------------------------------------------
ALTER TABLE pds.reading_questions
    ADD COLUMN IF NOT EXISTS idea_id        BIGINT REFERENCES pds.reading_ideas(idea_id),
    ADD COLUMN IF NOT EXISTS bank_chapter   INTEGER,
    ADD COLUMN IF NOT EXISTS format         TEXT CHECK (format IS NULL OR format IN ('cued', 'explain', 'order', 'chapter_recall')),
    ADD COLUMN IF NOT EXISTS unlock_chapter INTEGER,
    ADD COLUMN IF NOT EXISTS chapter_hash   TEXT CHECK (chapter_hash IS NULL OR chapter_hash ~ '^[0-9a-f]{64}$'),
    ADD COLUMN IF NOT EXISTS retired_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS retired_reason TEXT CHECK (retired_reason IS NULL OR retired_reason IN ('wrong', 'unclear', 'idea_retired', 'rebuilt')),
    ADD COLUMN IF NOT EXISTS bank_job_id    BIGINT,
    ADD COLUMN IF NOT EXISTS prompt_version TEXT;
CREATE INDEX IF NOT EXISTS idx_reading_questions_bank_idea ON pds.reading_questions (idea_id) WHERE idea_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reading_questions_bank_live ON pds.reading_questions (book_id, unlock_chapter)
    WHERE format IS NOT NULL AND superseded_at IS NULL AND retired_at IS NULL;

ALTER TABLE pds.reading_question_attempts
    ADD COLUMN IF NOT EXISTS round_key     UUID,
    ADD COLUMN IF NOT EXISTS round_kind    TEXT CHECK (round_kind IS NULL OR round_kind IN ('daily', 'extra', 'chapter', 'checkpoint', 'chat')),
    ADD COLUMN IF NOT EXISTS idea_id       BIGINT,
    ADD COLUMN IF NOT EXISTS covers        BIGINT[],                    -- chapter recall: the ideas its rubric lists
    ADD COLUMN IF NOT EXISTS verdict       TEXT CHECK (verdict IS NULL OR verdict IN ('correct', 'partial', 'incorrect', 'dont_know')),
    ADD COLUMN IF NOT EXISTS score         NUMERIC(3,2) CHECK (score IS NULL OR score BETWEEN 0 AND 1),
    ADD COLUMN IF NOT EXISTS hinted        BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS rubric_hits   JSONB,                       -- [{id, hit}]; ids only, no text
    ADD COLUMN IF NOT EXISTS model_verdict TEXT CHECK (model_verdict IS NULL OR model_verdict IN ('correct', 'partial', 'incorrect')),
    ADD COLUMN IF NOT EXISTS model_score   NUMERIC(3,2),
    ADD COLUMN IF NOT EXISTS overridden_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS grade_tries   SMALLINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS grade_error   TEXT CHECK (grade_error IS NULL OR grade_error ~ '^[a-z0-9_]{1,40}$'),
    ADD COLUMN IF NOT EXISTS response_ms   INTEGER CHECK (response_ms IS NULL OR response_ms BETWEEN 0 AND 3600000),
    ADD COLUMN IF NOT EXISTS ext_hash      TEXT CHECK (ext_hash IS NULL OR ext_hash ~ '^[0-9a-f]{64}$');
CREATE INDEX IF NOT EXISTS idx_reading_question_attempts_round ON pds.reading_question_attempts (round_key) WHERE round_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reading_question_attempts_idea ON pds.reading_question_attempts (idea_id, attempt_date) WHERE idea_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reading_question_attempts_pending ON pds.reading_question_attempts (answered_at) WHERE grading_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_reading_question_attempts_date ON pds.reading_question_attempts (attempt_date) WHERE ext_hash IS NOT NULL;

-- 9. Ideas are immutable: only status / retirement / unlock may change ------------------------------------------
CREATE OR REPLACE FUNCTION pds.reading_ideas_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pds, pg_temp AS $fn$
BEGIN
  IF (NEW.book_id, NEW.chapter, NEW.chapter_hash, NEW.kind, NEW.importance, NEW.title, NEW.statement, NEW.key_points, NEW.facts, NEW.content_hash)
     IS DISTINCT FROM
     (OLD.book_id, OLD.chapter, OLD.chapter_hash, OLD.kind, OLD.importance, OLD.title, OLD.statement, OLD.key_points, OLD.facts, OLD.content_hash) THEN
    RAISE EXCEPTION USING ERRCODE = 'OXB10', MESSAGE = 'reading ideas are immutable: retire the row and store a new idea';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END $fn$;
CREATE OR REPLACE TRIGGER trg_reading_ideas_guard BEFORE UPDATE ON pds.reading_ideas
    FOR EACH ROW EXECUTE FUNCTION pds.reading_ideas_guard();

-- 9a. T07's own paths stay off bank rows (the /api/reading/questions route takes answer / grade / correct):
--   * an answer to a bank question (format set) is stored only by pds.reading_bank_attempt (it sets ext_hash);
--   * a bank answer is graded only with a verdict (pds.reading_bank_attempt / _grade / _override set it): T07's
--     'grade' kind would mark it graded with no verdict, score or schedule, and the bank could never repair it.
-- A refusal raises, so the whole T07 call rolls back (including a version its answer path made first).
CREATE OR REPLACE FUNCTION pds.reading_bank_attempt_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pds, pg_temp AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ext_hash IS NULL AND EXISTS (SELECT 1 FROM pds.reading_questions q WHERE q.question_id = NEW.question_id AND q.format IS NOT NULL) THEN
      RAISE EXCEPTION USING ERRCODE = 'OXB12', MESSAGE = 'a bank question is answered only through pds.reading_bank_attempt';
    END IF;
  ELSIF NEW.ext_hash IS NOT NULL AND NEW.grading_status = 'graded' AND OLD.grading_status IS DISTINCT FROM 'graded'
        AND NEW.verdict IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'OXB13', MESSAGE = 'a bank answer is graded only through the bank''s grade functions';
  END IF;
  RETURN NEW;
END $fn$;
CREATE OR REPLACE TRIGGER trg_reading_bank_attempt_guard BEFORE INSERT OR UPDATE ON pds.reading_question_attempts
    FOR EACH ROW EXECUTE FUNCTION pds.reading_bank_attempt_guard();

--   * a new version of a bank question (T07's 'correct' kind, or its answer path when the source text moved) is
--     made only while this file's functions say so (the transaction-local setting pds.reading_bank_write), because
--     the version T07 inserts carries none of the bank's columns and would take the question out of the bank.
CREATE OR REPLACE FUNCTION pds.reading_bank_question_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pds, pg_temp AS $fn$
BEGIN
  IF NEW.format IS NULL AND COALESCE(current_setting('pds.reading_bank_write', true), '') <> 'on'
     AND EXISTS (SELECT 1 FROM pds.reading_questions q WHERE q.question_key = NEW.question_key AND q.format IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'OXB14', MESSAGE = 'a bank question gets new versions only from the bank';
  END IF;
  RETURN NEW;
END $fn$;
CREATE OR REPLACE TRIGGER trg_reading_bank_question_guard BEFORE INSERT ON pds.reading_questions
    FOR EACH ROW EXECUTE FUNCTION pds.reading_bank_question_guard();

-- 10. Hashes, book lookup, the spoiler boundary ---------------------------------------------------------------------
-- The active book: the same rule as lib/reading.ts getBook (the slug, else the newest book being read).
CREATE OR REPLACE FUNCTION pds.reading_bank_book_id(p_slug TEXT)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  SELECT b.book_id FROM pds.books b
   WHERE (p_slug IS NOT NULL AND b.slug = p_slug) OR (p_slug IS NULL AND b.status = 'reading')
   ORDER BY b.created_at DESC LIMIT 1
$fn$;

-- Edition binding: sha256 of 'chapter|N|<title, whitespace collapsed, trimmed, lower case>'. lib/reading-bank.ts
-- chapterHash() mirrors it; the planner takes the database's value (reading_bank_plan_input) so the two never drift.
CREATE OR REPLACE FUNCTION pds.reading_bank_chapter_hash(p_book BIGINT, p_chapter INTEGER)
RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  SELECT pds.reading_sha256('chapter|' || p_chapter::text || '|' || COALESCE(
    (SELECT lower(btrim(regexp_replace(COALESCE(c.title, ''), '[[:space:]]+', ' ', 'g'))) FROM pds.book_chapters c
      WHERE c.book_id = p_book AND c.chapter = p_chapter), ''))
$fn$;

CREATE OR REPLACE FUNCTION pds.reading_bank_toc_hash(p_book BIGINT)
RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  SELECT pds.reading_sha256(COALESCE((SELECT total_chapters FROM pds.books WHERE book_id = p_book), 0)::text || '|' ||
         COALESCE((SELECT string_agg(c.chapter::text || ':' || lower(btrim(regexp_replace(COALESCE(c.title, ''), '[[:space:]]+', ' ', 'g'))),
                                     '|' ORDER BY c.start_position, c.chapter)
                     FROM pds.book_chapters c WHERE c.book_id = p_book), ''))
$fn$;

-- The highest chapter Riley may be quizzed on (docs/reading-question-bank.md "Spoiler gate"):
--   stated = highest chapter_through of a session he logged himself (Log or chat, source <> 'kindle');
--   kindle = highest chapter whose NEXT chapter (by start position) the reading position or a highlight reached;
--   last   = total_chapters when the book is finished or a session he logged himself reached the last chapter
--            (a Kindle-made session can count a chapter done up to 800 positions before its end, so it never
--            unlocks the last chapter; the book's `finished` status still does, by D9, even when the Kindle sync
--            set it inside that margin);
--   capped at total_chapters, and at hold_chapter - 1 while a "Not read yet" hold stands.
CREATE OR REPLACE FUNCTION pds.reading_bank_quiz_through(p_book BIGINT)
RETURNS INTEGER LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  WITH b AS (
    SELECT bk.book_id, bk.status, COALESCE(bk.total_chapters, 0) AS total, bk.last_position,
           bb.hold_chapter, bb.hold_position, bb.hold_at
      FROM pds.books bk LEFT JOIN pds.reading_bank_books bb ON bb.book_id = bk.book_id
     WHERE bk.book_id = p_book
  ),
  stated AS (
    SELECT COALESCE(max(s.chapter_through), 0) AS n FROM pds.reading_sessions s
     WHERE s.book_id = p_book AND s.source <> 'kindle'
  ),
  reached AS (
    SELECT GREATEST(COALESCE((SELECT last_position FROM b), -1),
                    COALESCE((SELECT max(h.position) FROM pds.book_highlights h WHERE h.book_id = p_book AND NOT h.archived), -1)) AS pos
  ),
  kindle AS (   -- a chapter counts once the next chapter (by start position) has been reached
    SELECT COALESCE(max(c.chapter), 0) AS n
      FROM pds.book_chapters c
      CROSS JOIN LATERAL (SELECT nx.start_position FROM pds.book_chapters nx
                           WHERE nx.book_id = c.book_id AND nx.start_position > c.start_position
                           ORDER BY nx.start_position LIMIT 1) nxt
     WHERE c.book_id = p_book AND (SELECT pos FROM reached) >= nxt.start_position
  ),
  last_ch AS (
    SELECT CASE WHEN (SELECT total FROM b) > 0 AND ((SELECT status FROM b) = 'finished'
                  OR EXISTS (SELECT 1 FROM pds.reading_sessions s WHERE s.book_id = p_book AND s.source <> 'kindle'
                               AND s.chapter_through >= (SELECT total FROM b)))
                THEN (SELECT total FROM b) ELSE 0 END AS n
  ),
  raw AS (SELECT GREATEST((SELECT n FROM stated), (SELECT n FROM kindle), (SELECT n FROM last_ch)) AS n),
  hold AS (
    SELECT CASE
      WHEN b.hold_chapter IS NULL OR b.status = 'finished' THEN NULL
      WHEN EXISTS (SELECT 1 FROM pds.reading_sessions s WHERE s.book_id = p_book AND s.source <> 'kindle'
                     AND s.chapter_through >= b.hold_chapter AND s.created_at > b.hold_at) THEN NULL
      WHEN b.last_position IS NOT NULL AND b.last_position > COALESCE(b.hold_position, -1)
           AND b.last_position >= COALESCE((SELECT min(c2.start_position) FROM pds.book_chapters c2
                                             WHERE c2.book_id = p_book AND c2.start_position >
                                                   (SELECT c1.start_position FROM pds.book_chapters c1
                                                     WHERE c1.book_id = p_book AND c1.chapter = b.hold_chapter)), 2147483647) THEN NULL
      ELSE b.hold_chapter - 1 END AS cap
      FROM b
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM b) THEN 0 ELSE
         LEAST(CASE WHEN (SELECT total FROM b) > 0 THEN (SELECT total FROM b) ELSE 2147483647 END,
               CASE WHEN (SELECT cap FROM hold) IS NULL THEN (SELECT n FROM raw) ELSE LEAST((SELECT n FROM raw), (SELECT cap FROM hold)) END) END
$fn$;

-- "The end of the book" as an unlock chapter: the chapter count, or 2147483647 (never reached) while the count is
-- unknown, so an unsure, whole-book or moved idea can never unlock early because the length is missing. lib/
-- reading-bank.ts UNKNOWN_END_CHAPTER mirrors the number; the store and the flag apply it, whatever a caller sent.
CREATE OR REPLACE FUNCTION pds.reading_bank_end_chapter(p_book BIGINT)
RETURNS INTEGER LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  SELECT CASE WHEN COALESCE(b.total_chapters, 0) > 0 THEN b.total_chapters ELSE 2147483647 END
    FROM (SELECT (SELECT total_chapters FROM pds.books WHERE book_id = p_book) AS total_chapters) b
$fn$;

-- 11. T07's permitted-source text, re-defined with one added branch: 'idea' (an active idea of the same book) ----
-- The first three branches are copied verbatim from sql/reading_learning_questions.sql; keep them identical
-- (frontend/tests/reading-bank-sql.test.cjs compares them).
CREATE OR REPLACE FUNCTION pds.reading_source_text(p_book BIGINT, p_kind TEXT, p_ref BIGINT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $fn$
  SELECT NULLIF(regexp_replace(btrim(x.t), '[[:space:]]+', ' ', 'g'), '')
    FROM (
      SELECT h.passage || ' ' || COALESCE(h.comment, '') AS t
        FROM pds.book_highlights h
       WHERE p_kind = 'highlight' AND h.highlight_id = p_ref AND h.book_id = p_book AND NOT h.archived
      UNION ALL
      SELECT s.recall
        FROM pds.reading_sessions s
       WHERE p_kind = 'session' AND s.session_id = p_ref AND s.book_id = p_book
      UNION ALL
      SELECT 'chapter ' || p_ref::text || COALESCE(': ' || c.title, '')
        FROM pds.books b
        LEFT JOIN pds.book_chapters c ON c.book_id = b.book_id AND c.chapter = p_ref
       WHERE p_kind = 'chapter' AND b.book_id = p_book AND p_ref >= 1
         AND (c.chapter IS NOT NULL OR p_ref <= COALESCE(b.total_chapters, 0))
      UNION ALL
      SELECT i.title || ': ' || i.statement || ' ' ||
             COALESCE((SELECT string_agg(kp.v, ' ' ORDER BY kp.o) FROM jsonb_array_elements_text(i.key_points) WITH ORDINALITY AS kp(v, o)), '')
        FROM pds.reading_ideas i
       WHERE p_kind = 'idea' AND i.idea_id = p_ref AND i.book_id = p_book AND i.status = 'active'
    ) x
   LIMIT 1
$fn$;

-- Whether the two T07 checks allow bank rows and whether this file's re-definitions of T07's functions are in place
-- (worker preflight; `all_ok` = every entry true). A check counts only when EVERY check constraint on that column's
-- value list allows the bank's value: a widened check added under another name next to T07's original would still
-- refuse the insert. The two function entries go false when sql/reading_learning_questions.sql was applied again
-- after this file (its own definitions lack the idea branch and the export's spoiler gate): re-apply this file.
CREATE OR REPLACE FUNCTION pds.reading_bank_schema_ok()
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  WITH c AS (
    SELECT conrelid, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE contype = 'c' AND conrelid IN ('pds.reading_questions'::regclass, 'pds.reading_question_attempts'::regclass)
  ),
  v AS (
    SELECT
      EXISTS (SELECT 1 FROM c WHERE conrelid = 'pds.reading_questions'::regclass AND def ~ '\msource_kind = ANY' AND def LIKE '%''idea''%')
        AND NOT EXISTS (SELECT 1 FROM c WHERE conrelid = 'pds.reading_questions'::regclass AND def ~ '\msource_kind = ANY'
                          AND def NOT LIKE '%''idea''%') AS source_kind_idea,
      EXISTS (SELECT 1 FROM c WHERE conrelid = 'pds.reading_question_attempts'::regclass AND def ~ '\mgrader = ANY' AND def LIKE '%''local''%')
        AND NOT EXISTS (SELECT 1 FROM c WHERE conrelid = 'pds.reading_question_attempts'::regclass AND def ~ '\mgrader = ANY'
                          AND def NOT LIKE '%''local''%') AS grader_local,
      position('reading_ideas' IN pg_get_functiondef('pds.reading_source_text(bigint,text,bigint)'::regprocedure)) > 0 AS idea_source_branch,
      position('reading_bank_question_open' IN pg_get_functiondef('pds.reading_questions_export(bigint)'::regprocedure)) > 0 AS export_gate
  )
  SELECT jsonb_build_object('source_kind_idea', v.source_kind_idea, 'grader_local', v.grader_local,
                            'idea_source_branch', v.idea_source_branch, 'export_gate', v.export_gate,
                            'all_ok', v.source_kind_idea AND v.grader_local AND v.idea_source_branch AND v.export_gate)
    FROM v
$fn$;

-- Whether an idea still rests on valid evidence: a web citation, or a live highlight whose passage has the sha256
-- it had when the evidence was stored (an edited or archived highlight no longer supports what was built on it).
-- Every read and the attempt serve an idea only while this holds (acceptance: no served idea without evidence).
CREATE OR REPLACE FUNCTION pds.reading_bank_idea_supported(p_idea BIGINT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM pds.reading_idea_evidence e
      JOIN pds.reading_bank_sources src ON src.source_id = e.source_id
      LEFT JOIN pds.book_highlights h ON h.highlight_id = src.highlight_id
     WHERE e.idea_id = p_idea
       AND (src.kind = 'web' OR (h.highlight_id IS NOT NULL AND NOT h.archived AND pds.reading_sha256(h.passage) = src.passage_sha)))
$fn$;

-- Whether a chapter recall rubric may be served or answered: it lists at least one idea, and every idea it lists is
-- still an active idea of that chapter that unlocks with it, of the current edition, with valid evidence. A rubric
-- that no longer holds (an idea's only highlight was edited or archived, the idea was retired) is not served and
-- not answered (409 question_changed) until pds.reading_bank_recall_sync gives the question a new version.
CREATE OR REPLACE FUNCTION pds.reading_bank_recall_valid(p_rubric TEXT, p_book BIGINT, p_ch INTEGER)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  SELECT COALESCE(jsonb_array_length(p_rubric::jsonb->'ideas'), 0) > 0
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_rubric::jsonb->'ideas') e
         LEFT JOIN pds.reading_ideas i ON i.idea_id = (e->>'idea_id')::bigint AND i.book_id = p_book
        WHERE i.idea_id IS NULL OR i.status <> 'active' OR i.chapter <> p_ch OR i.unlock_chapter <> p_ch
           OR i.chapter_hash <> pds.reading_bank_chapter_hash(p_book, p_ch)
           OR NOT pds.reading_bank_idea_supported(i.idea_id))
$fn$;

-- Whether a question version (and the answers to it) may leave the server in T07's export. A non-bank question
-- always may; a bank one only while it is unlocked, of the current edition, its idea unlocked, and (chapter recall)
-- every idea its rubric lists unlocked. So an older recall version that still lists an idea later moved to the end
-- of the book, or a version from a replaced table of contents, is not exported.
CREATE OR REPLACE FUNCTION pds.reading_bank_question_open(p_question BIGINT, p_through INTEGER)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  SELECT COALESCE((
    SELECT CASE WHEN q.format IS NULL THEN true ELSE
             q.unlock_chapter <= p_through
             AND q.chapter_hash IS NOT DISTINCT FROM pds.reading_bank_chapter_hash(q.book_id, q.bank_chapter)
             AND NOT EXISTS (SELECT 1 FROM pds.reading_ideas i WHERE i.idea_id = q.idea_id AND i.unlock_chapter > p_through)
             AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN q.format = 'chapter_recall' THEN q.rubric::jsonb->'ideas'
                                                                     ELSE '[]'::jsonb END) e
                               JOIN pds.reading_ideas i ON i.idea_id = (e->>'idea_id')::bigint
                              WHERE i.unlock_chapter > p_through) END
      FROM pds.reading_questions q WHERE q.question_id = p_question), false)
$fn$;

-- T07's export (GET /api/reading/questions?book=), re-defined with the spoiler gate: a bank question version
-- (format set) is listed only while pds.reading_bank_question_open says so (unlocked, current edition, every idea it
-- names unlocked), and so are the attempts on it. Everything else is T07's definition unchanged
-- (frontend/tests/reading-bank-sql.test.cjs compares the fields), so T07's questions and answers export as before.
CREATE OR REPLACE FUNCTION pds.reading_questions_export(p_book BIGINT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $fn$
  WITH t AS (SELECT pds.reading_bank_quiz_through(p_book) AS through)
  SELECT jsonb_build_object(
    'questions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'question_id', q.question_id, 'question_key', q.question_key, 'version', q.version,
               'prompt', q.prompt, 'rubric', q.rubric, 'source_kind', q.source_kind, 'source_ref', q.source_ref,
               'source_hash', q.source_hash,
               'source_status', CASE WHEN s.t IS NULL THEN 'removed'
                                     WHEN pds.reading_sha256(s.t) = q.source_hash THEN 'same' ELSE 'changed' END,
               'created_at', q.created_at, 'superseded_at', q.superseded_at, 'superseded_reason', q.superseded_reason)
             ORDER BY q.question_key, q.version)
        FROM pds.reading_questions q
        CROSS JOIN LATERAL (SELECT pds.reading_source_text(q.book_id, q.source_kind, q.source_ref) AS t) s
       WHERE q.book_id = p_book
         AND pds.reading_bank_question_open(q.question_id, (SELECT through FROM t))), '[]'::jsonb),
    'attempts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'attempt_key', a.attempt_key, 'question_id', a.question_id, 'quiz_key', a.quiz_key,
               'attempt_date', a.attempt_date, 'answer', a.answer, 'answered_at', a.answered_at,
               'grading_status', a.grading_status, 'correct', a.correct, 'grader', a.grader, 'feedback', a.feedback,
               'graded_at', a.graded_at, 'invalidated_at', a.invalidated_at, 'invalidated_reason', a.invalidated_reason,
               'answer_cleared_at', a.answer_cleared_at)
             ORDER BY a.answered_at, a.attempt_key)
        FROM pds.reading_question_attempts a
        JOIN pds.reading_questions q ON q.question_id = a.question_id
       WHERE q.book_id = p_book
         AND pds.reading_bank_question_open(q.question_id, (SELECT through FROM t))), '[]'::jsonb))
$fn$;

-- 12. Idea state: compare-and-set check + write ------------------------------------------------------------------
-- p_states: [{idea_id, basis_version, next: {stage, ease, interval_days, review_count, next_review, last_reviewed,
--             lapses, last_verdict, stage_success_on, last_question_ids}}] computed by lib/reading-recall.ts replay.
-- basis_version = the state_version the replay read (0 when the idea had no state row).
CREATE OR REPLACE FUNCTION pds.reading_bank_states_ok(p_states JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE v_s JSONB; v_ver INTEGER;
BEGIN
  IF p_states IS NOT NULL AND jsonb_typeof(p_states) <> 'array' THEN RETURN false; END IF;
  FOR v_s IN SELECT * FROM jsonb_array_elements(COALESCE(p_states, '[]'::jsonb)) LOOP
    v_ver := NULL;
    SELECT state_version INTO v_ver FROM pds.reading_idea_state WHERE idea_id = (v_s->>'idea_id')::bigint FOR UPDATE;
    IF COALESCE(v_ver, 0) <> COALESCE((v_s->>'basis_version')::int, -1) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $fn$;

CREATE OR REPLACE FUNCTION pds.reading_bank_states_write(p_states JSONB)
RETURNS INTEGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE v_s JSONB; v_n JSONB; v_rows INTEGER := 0; v_one INTEGER;
BEGIN
  -- Callers hold the lock already; advisory transaction locks are re-entrant, so this costs nothing there.
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));
  FOR v_s IN SELECT * FROM jsonb_array_elements(COALESCE(p_states, '[]'::jsonb)) LOOP
    v_n := v_s->'next';
    INSERT INTO pds.reading_idea_state AS s (idea_id, book_id, stage, ease, interval_days, review_count, next_review, last_reviewed,
                                             lapses, last_verdict, stage_success_on, last_question_ids, state_version, dirty, updated_at)
    SELECT i.idea_id, i.book_id, (v_n->>'stage')::smallint, (v_n->>'ease')::numeric, (v_n->>'interval_days')::int,
           (v_n->>'review_count')::int, NULLIF(v_n->>'next_review', '')::date, NULLIF(v_n->>'last_reviewed', '')::date,
           (v_n->>'lapses')::int, NULLIF(v_n->>'last_verdict', ''), NULLIF(v_n->>'stage_success_on', '')::date,
           COALESCE(ARRAY(SELECT q::bigint FROM jsonb_array_elements_text(COALESCE(v_n->'last_question_ids', '[]'::jsonb)) q), '{}'),
           1, false, NOW()
      FROM pds.reading_ideas i WHERE i.idea_id = (v_s->>'idea_id')::bigint
    ON CONFLICT (idea_id) DO UPDATE SET
      stage = EXCLUDED.stage, ease = EXCLUDED.ease, interval_days = EXCLUDED.interval_days, review_count = EXCLUDED.review_count,
      next_review = EXCLUDED.next_review, last_reviewed = EXCLUDED.last_reviewed, lapses = EXCLUDED.lapses,
      last_verdict = EXCLUDED.last_verdict, stage_success_on = EXCLUDED.stage_success_on,
      last_question_ids = EXCLUDED.last_question_ids, state_version = s.state_version + 1, dirty = false, updated_at = NOW();
    GET DIAGNOSTICS v_one = ROW_COUNT;
    v_rows := v_rows + v_one;
  END LOOP;
  RETURN v_rows;
END $fn$;

-- Moves state_version of the given ideas (creating the state row of an idea that has none, at version 1), so a
-- replay computed before this moment cannot pass the compare-and-set: a flag (p_dirty true: the worker replays the
-- state), and a pending answer (p_dirty false: it changes the idea's history, holding its day's slot, before it is
-- graded). Without the row an idea's basis version stays 0 and an earlier replay would still pass.
CREATE OR REPLACE FUNCTION pds.reading_bank_touch_states(p_ideas BIGINT[], p_dirty BOOLEAN)
RETURNS INTEGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE v_n INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));
  INSERT INTO pds.reading_idea_state AS s (idea_id, book_id, state_version, dirty, updated_at)
  SELECT i.idea_id, i.book_id, 1, COALESCE(p_dirty, false), NOW()
    FROM pds.reading_ideas i WHERE i.idea_id = ANY(COALESCE(p_ideas, '{}'::bigint[]))
  ON CONFLICT (idea_id) DO UPDATE SET state_version = s.state_version + 1, dirty = s.dirty OR EXCLUDED.dirty, updated_at = NOW();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $fn$;

-- Repair path (flags, the worker): replayed states, compare-and-set, under the practice lock.
-- p: {states: [...]}
CREATE OR REPLACE FUNCTION pds.reading_bank_write_states(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));
  IF NOT pds.reading_bank_states_ok(p->'states') THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'raced');
  END IF;
  RETURN jsonb_build_object('ok', true, 'written', pds.reading_bank_states_write(p->'states'));
END $fn$;

-- The receipt of one bank attempt (ids, numbers, dates; never the answer text).
CREATE OR REPLACE FUNCTION pds.reading_bank_receipt(p_key UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  SELECT jsonb_build_object('ok', true, 'attempt_key', a.attempt_key, 'question_id', a.question_id, 'idea_id', a.idea_id,
           'attempt_date', a.attempt_date, 'grading_status', a.grading_status, 'verdict', a.verdict, 'score', a.score,
           'hinted', a.hinted, 'overridden', a.overridden_at IS NOT NULL,
           'next_review', (SELECT s.next_review FROM pds.reading_idea_state s WHERE s.idea_id = a.idea_id))
    FROM pds.reading_question_attempts a WHERE a.attempt_key = p_key
$fn$;

-- 13. The chapter recall question of one chapter, kept in step with its ideas -----------------------------------
-- Its rubric lists the chapter's active core + supporting ideas that unlock WITH the chapter (unlock_chapter = the
-- chapter: an unsure, whole-book or "Not in this chapter" idea unlocks at the end of the book and is never listed,
-- so its title cannot reach the browser early), of the current edition and with valid evidence; at most 12, fewer
-- when the titles are long, so the rubric stays within T07's 2,000 characters (pds.reading_bank_recall_rubric, the
-- one place it is built). Called by every store (a build, and the highlights step when it adds or links ideas), by
-- the flags that move or retire one of those ideas (and their Restore), and by pds.reading_bank_recall_sync (an
-- idea that lost its only evidence, e.g. an edited or archived highlight):
--   * no question yet, or the last one retired -> a new question (version 1);
--   * the rubric or prompt differs -> a new version through T07's 'correct' kind. p_invalidate NULL = T07's default
--     (answers to older versions are invalidated: a rebuild, whose ideas were all retired); false = they keep
--     counting (a flag, an added idea, a sync: the answers already given covered what they covered, and the
--     recall answers after it cover the new list);
--   * nothing left to recall -> the live question is retired (its answers stay as they are);
--   * a question Riley flagged Wrong / Unclear is left alone (Restore brings it back), unless p_rebuild.
-- Returns 1 when a question was created or given a new version, else 0.
CREATE OR REPLACE FUNCTION pds.reading_bank_recall_rubric(p_book BIGINT, p_ch INTEGER)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_hash  TEXT := pds.reading_bank_chapter_hash(p_book, p_ch);
  v_rj    JSONB;
  v_limit INTEGER := 12;
BEGIN
  LOOP
    SELECT jsonb_build_object('v', 1, 'format', 'chapter_recall', 'ideas',
             COALESCE(jsonb_agg(jsonb_build_object('idea_id', x.idea_id, 'title', x.title, 'importance', x.importance) ORDER BY x.ord, x.idea_id), '[]'::jsonb))
      INTO v_rj
      FROM (SELECT i.idea_id, i.title, i.importance, CASE i.importance WHEN 'core' THEN 0 ELSE 1 END AS ord
              FROM pds.reading_ideas i
             WHERE i.book_id = p_book AND i.chapter = p_ch AND i.unlock_chapter = p_ch AND i.chapter_hash = v_hash
               AND i.status = 'active' AND i.importance IN ('core', 'supporting')
               AND pds.reading_bank_idea_supported(i.idea_id)
             ORDER BY ord, i.idea_id LIMIT v_limit) x;
    EXIT WHEN length(v_rj::text) <= 2000 OR v_limit <= 4;
    v_limit := v_limit - 2;
  END LOOP;
  RETURN v_rj;
END $fn$;

CREATE OR REPLACE FUNCTION pds.reading_bank_recall_refresh(p_book BIGINT, p_ch INTEGER, p_job BIGINT, p_pv TEXT,
                                                           p_reason TEXT, p_invalidate BOOLEAN, p_rebuild BOOLEAN)
RETURNS INTEGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_hash   TEXT;
  v_old    pds.reading_questions%ROWTYPE;
  v_found  BOOLEAN;
  v_rj     JSONB;
  v_rub    TEXT;
  v_prompt TEXT;
  v_title  TEXT;
  v_shash  TEXT;
  v_r      JSONB;
BEGIN
  IF p_book IS NULL OR p_ch IS NULL OR p_ch < 1 THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));
  v_hash := pds.reading_bank_chapter_hash(p_book, p_ch);
  SELECT * INTO v_old FROM pds.reading_questions
   WHERE book_id = p_book AND format = 'chapter_recall' AND bank_chapter = p_ch AND superseded_at IS NULL
   ORDER BY question_id DESC LIMIT 1;
  v_found := FOUND;
  IF v_found AND v_old.retired_reason IN ('wrong', 'unclear') AND NOT COALESCE(p_rebuild, false) THEN RETURN 0; END IF;

  v_rj := pds.reading_bank_recall_rubric(p_book, p_ch);
  v_rub := v_rj::text;
  SELECT c.title INTO v_title FROM pds.book_chapters c WHERE c.book_id = p_book AND c.chapter = p_ch;
  v_prompt := 'In your own words: what happens and what is argued in chapter ' || p_ch::text ||
              COALESCE(' ("' || NULLIF(btrim(v_title), '') || '")', '') || '?';

  IF jsonb_array_length(v_rj->'ideas') = 0 OR length(v_rub) > 2000 THEN
    UPDATE pds.reading_questions SET retired_at = NOW(), retired_reason = 'rebuilt'
     WHERE book_id = p_book AND format = 'chapter_recall' AND bank_chapter = p_ch AND superseded_at IS NULL AND retired_at IS NULL;
    RETURN 0;
  END IF;

  IF NOT v_found OR v_old.retired_at IS NOT NULL THEN
    v_shash := pds.reading_sha256(pds.reading_source_text(p_book, 'chapter', p_ch));
    IF v_shash IS NULL THEN RETURN 0; END IF;
    -- Same content hash formula as pds.reading_question_apply (T07); pds.reading_bank_attempt re-checks it.
    INSERT INTO pds.reading_questions (question_key, version, book_id, prompt, rubric, source_kind, source_ref, source_hash,
                                       content_hash, bank_chapter, format, unlock_chapter, chapter_hash, bank_job_id, prompt_version)
    VALUES (gen_random_uuid(), 1, p_book, v_prompt, v_rub, 'chapter', p_ch, v_shash,
            pds.reading_sha256(jsonb_build_object('prompt', v_prompt, 'rubric', v_rub, 'source_kind', 'chapter',
              'source_ref', p_ch, 'source_hash', v_shash)::text),
            p_ch, 'chapter_recall', p_ch, v_hash, p_job, COALESCE(p_pv, v_old.prompt_version, 'unknown'));
    RETURN 1;
  END IF;

  IF v_old.rubric IS DISTINCT FROM v_rub OR v_old.prompt IS DISTINCT FROM v_prompt THEN
    -- A new version through T07's correction path (the question guard admits it while this setting is on).
    PERFORM set_config('pds.reading_bank_write', 'on', true);
    v_r := pds.reading_question_apply(jsonb_build_object('kind', 'correct', 'op_key', gen_random_uuid(),
             'question_key', v_old.question_key, 'expected_version', v_old.version, 'prompt', v_prompt, 'rubric', v_rub,
             'source_kind', 'chapter', 'source_ref', p_ch, 'reason', COALESCE(NULLIF(btrim(p_reason), ''), 'chapter questions changed'),
             'invalidate', p_invalidate));
    PERFORM set_config('pds.reading_bank_write', 'off', true);
    IF NOT COALESCE((v_r->>'ok')::boolean, false) THEN RETURN 0; END IF;
    UPDATE pds.reading_questions
       SET bank_chapter = p_ch, format = 'chapter_recall', unlock_chapter = p_ch, chapter_hash = v_hash,
           bank_job_id = COALESCE(p_job, v_old.bank_job_id), prompt_version = COALESCE(p_pv, v_old.prompt_version)
     WHERE question_key = v_old.question_key AND superseded_at IS NULL;
    RETURN 1;
  END IF;

  -- Same prompt and rubric: only the bank's own columns follow.
  UPDATE pds.reading_questions
     SET chapter_hash = v_hash, bank_job_id = COALESCE(p_job, bank_job_id), prompt_version = COALESCE(p_pv, prompt_version)
   WHERE question_id = v_old.question_id;
  RETURN 0;
END $fn$;

-- Every live chapter recall question of the book whose rubric is no longer the one pds.reading_bank_recall_rubric
-- builds now gets a new version (answers keep counting). Called by pds.reading_bank_enqueue, i.e. on every kick
-- (the Kindle import, Riley's highlight and session writes) and every worker pass, so an idea whose only highlight
-- was edited or archived leaves the recall rubric as soon as the next plan runs; until then the deck does not serve
-- that recall and the attempt refuses it (pds.reading_bank_recall_valid).
CREATE OR REPLACE FUNCTION pds.reading_bank_recall_sync(p_book BIGINT)
RETURNS INTEGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE v_ch INTEGER; v_n INTEGER := 0;
BEGIN
  IF p_book IS NULL THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));
  FOR v_ch IN SELECT DISTINCT q.bank_chapter FROM pds.reading_questions q
               WHERE q.book_id = p_book AND q.format = 'chapter_recall' AND q.superseded_at IS NULL AND q.retired_at IS NULL
                 AND q.rubric IS DISTINCT FROM pds.reading_bank_recall_rubric(p_book, q.bank_chapter)::text
               ORDER BY 1 LOOP
    v_n := v_n + pds.reading_bank_recall_refresh(p_book, v_ch, NULL, NULL, 'chapter ideas changed', false, false);
  END LOOP;
  RETURN v_n;
END $fn$;

-- 13a. Store one verified chapter batch atomically --------------------------------------------------------------
-- p: {book_id, chapter, chapter_hash, job_id, attempts, claim_seq, prompt_version, replace (bool), status?, rebuilds (required
--     with replace), counts: {rejected},
--     sources: [{ref, kind, url?, domain?, title?, cited_text?, highlight_id?, passage_sha?}],
--     ideas: [{ref, unlock_chapter, kind, importance, title, statement, key_points, facts, origin, evidence: [ref],
--              questions: [{format: 'cued'|'explain'|'order', prompt, rubric (jsonb)}]}],
--     links?: [{idea_id, source_ref}],   (a highlight that states an idea already stored in this chapter)
--     seen?: [{highlight_id, passage_sha}]}   (the highlights the job sent to the model)
-- job_id is required: the job's receipt (reading_bank_jobs.store_receipt) makes a repeated store (a crash between
-- store and finish, a worker whose lease ran out) answer what the first one stored, with nothing retired or
-- inserted again. chapter_hash is required: the edition the job was planned for; when the table of contents
-- changed since, the answer is 409 chapter_changed and nothing is written (the planner queues the new edition).
-- A highlight source's passage_sha, when sent, must still be the passage's (409 highlight_changed otherwise).
-- Only the run that holds the live lease stores: attempts and claim_seq (both required) are the numbers the claim
-- answered, and a job that is not running (409 not_running), whose attempt or claim is not the current one (409
-- lease_lost) or that was planned for an older rebuild count of its chapter (409 stale_generation) writes nothing.
-- A receipt replay needs no lease.
-- replace = true (a build or a rebuild): the chapter's active ideas and their questions are retired first, and the
-- chapter recall question gets a new T07 version when its rubric changed. A replace that kept no idea while the
-- chapter has a working bank for this edition leaves that bank in place (a transient search failure must not
-- empty a chapter): only the rebuild counter and the rejected count move. replace = false (the highlights step):
-- ideas are added (and highlights linked); the chapter recall question is created when missing, or gets a new
-- version that lists the added core / supporting ideas, with T07's invalidation off, so the recall answers already
-- given keep counting for what they covered and later recalls also assess the additions. A chapter that had
-- no_sources and now has ideas (highlights added later) becomes anchors_only.
-- unlock_chapter: the chapter, or the end of the book (pds.reading_bank_end_chapter) for any idea the payload
-- unlocks later (an unsure placement) and for every chapter-0 idea, whatever number the caller sent.
-- Every highlight the job looked at is recorded in pds.reading_bank_highlight_seen with its passage hash (`seen`;
-- without it: a build's chapter highlights, a highlights step's cited ones), so the planner offers a highlight
-- again only once its content changes.
CREATE OR REPLACE FUNCTION pds.reading_bank_store(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_book    BIGINT;
  v_ch      INTEGER;
  v_job     BIGINT;
  v_att     INTEGER;
  v_seq     BIGINT;
  v_rebuild INTEGER;
  v_replace BOOLEAN;
  v_keep    BOOLEAN := false;
  v_pv      TEXT := p->>'prompt_version';
  v_chash   TEXT := p->>'chapter_hash';
  v_hash    TEXT;
  v_jobrow  pds.reading_bank_jobs%ROWTYPE;
  v_src     JSONB;
  v_idea    JSONB;
  v_q       JSONB;
  v_sid     BIGINT;
  v_iid     BIGINT;
  v_unlock  INTEGER;
  v_map     JSONB := '{}'::jsonb;
  v_ideas   INTEGER := 0;
  v_qs      INTEGER := 0;
  v_text    TEXT;
  v_psha    TEXT;
  v_shash   TEXT;
  v_prompt  TEXT;
  v_rub     TEXT;
  v_receipt JSONB;
  v_end     INTEGER;
BEGIN
  BEGIN
    v_book := (p->>'book_id')::bigint;
    v_ch := (p->>'chapter')::int;
    v_job := NULLIF(p->>'job_id', '')::bigint;
    v_att := NULLIF(p->>'attempts', '')::int;
    v_seq := NULLIF(p->>'claim_seq', '')::bigint;
    v_rebuild := NULLIF(p->>'rebuilds', '')::int;
    v_replace := COALESCE((p->>'replace')::boolean, false);
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END;
  IF v_book IS NULL OR v_ch IS NULL OR v_ch < 0 OR v_job IS NULL OR v_att IS NULL OR v_seq IS NULL OR v_pv IS NULL OR btrim(v_pv) = ''
     OR (v_replace AND v_rebuild IS NULL)
     OR v_chash IS NULL OR v_chash !~ '^[0-9a-f]{64}$'
     OR (p->'ideas' IS NOT NULL AND jsonb_typeof(p->'ideas') <> 'array')
     OR (p->'sources' IS NOT NULL AND jsonb_typeof(p->'sources') <> 'array')
     OR (p->'seen' IS NOT NULL AND jsonb_typeof(p->'seen') <> 'array') THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pds.books WHERE book_id = v_book) THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'book_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));
  SELECT * INTO v_jobrow FROM pds.reading_bank_jobs WHERE job_id = v_job FOR UPDATE;
  IF NOT FOUND OR v_jobrow.book_id <> v_book OR v_jobrow.chapter <> v_ch OR v_jobrow.step NOT IN ('build', 'highlights') THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'job_mismatch');
  END IF;
  IF v_jobrow.store_receipt IS NOT NULL THEN
    RETURN v_jobrow.store_receipt || jsonb_build_object('replayed', true);
  END IF;
  -- Only the run that holds the live lease may store (as finish and reserve fence it): a worker whose lease ran
  -- out has had its reservation charged and its job offered again, and a late store of its output must not
  -- replace what a newer run or rebuild put there. attempts + claim_seq = the numbers the claim answered.
  IF v_jobrow.status <> 'running' OR v_jobrow.lease_until IS NULL OR v_jobrow.lease_until < NOW() THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'not_running');
  END IF;
  IF v_att <> v_jobrow.attempts OR v_seq <> v_jobrow.claim_seq THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'lease_lost');
  END IF;
  -- A rebuild asked for after this job was planned makes its output obsolete (new rebuild count, new job hashes).
  IF v_rebuild IS NOT NULL AND v_rebuild < COALESCE(
       (SELECT c.rebuilds FROM pds.reading_bank_chapters c WHERE c.book_id = v_book AND c.chapter = v_ch), 0) THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'stale_generation');
  END IF;
  v_hash := pds.reading_bank_chapter_hash(v_book, v_ch);
  IF v_chash <> v_hash THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'chapter_changed');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p->'sources', '[]'::jsonb)) s
               LEFT JOIN pds.book_highlights h ON h.highlight_id = NULLIF(s->>'highlight_id', '')::bigint AND h.book_id = v_book
              WHERE s->>'kind' = 'highlight' AND s->>'passage_sha' IS NOT NULL
                AND (h.highlight_id IS NULL OR pds.reading_sha256(h.passage) <> s->>'passage_sha')) THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'highlight_changed');
  END IF;

  v_end := pds.reading_bank_end_chapter(v_book);
  v_keep := v_replace AND jsonb_array_length(COALESCE(p->'ideas', '[]'::jsonb)) = 0
            AND EXISTS (SELECT 1 FROM pds.reading_ideas WHERE book_id = v_book AND chapter = v_ch AND status = 'active' AND chapter_hash = v_hash);

  IF v_replace AND NOT v_keep THEN
    UPDATE pds.reading_questions q SET retired_at = NOW(), retired_reason = 'rebuilt'
      FROM pds.reading_ideas i
     WHERE q.idea_id = i.idea_id AND i.book_id = v_book AND i.chapter = v_ch AND i.status = 'active' AND q.retired_at IS NULL;
    UPDATE pds.reading_ideas
       SET status = 'retired', retired_at = NOW(),
           retired_reason = CASE WHEN chapter_hash <> v_hash THEN 'toc_changed' ELSE 'rebuilt' END
     WHERE book_id = v_book AND chapter = v_ch AND status = 'active';
  END IF;

  FOR v_src IN SELECT * FROM jsonb_array_elements(COALESCE(p->'sources', '[]'::jsonb)) LOOP
    IF v_src->>'ref' IS NULL OR v_src->>'kind' IS NULL OR v_src->>'kind' NOT IN ('web', 'highlight') THEN
      RAISE EXCEPTION USING ERRCODE = 'OXB01', MESSAGE = 'a source needs a ref and a kind';
    END IF;
    v_psha := NULL;
    IF v_src->>'kind' = 'highlight' THEN
      SELECT pds.reading_sha256(h.passage) INTO v_psha FROM pds.book_highlights h
       WHERE h.highlight_id = (v_src->>'highlight_id')::bigint AND h.book_id = v_book AND NOT h.archived;
      IF v_psha IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'OXB02', MESSAGE = 'highlight evidence is not a live highlight of this book';
      END IF;
    END IF;
    -- A highlight's evidence row is bound to the passage it was stored against (an edit makes another row).
    v_text := CASE WHEN v_src->>'kind' = 'web' THEN 'web|' || (v_src->>'url') || '|' || (v_src->>'cited_text')
                   ELSE 'highlight|' || (v_src->>'highlight_id') || '|' || v_psha END;
    INSERT INTO pds.reading_bank_sources (book_id, chapter, kind, url, domain, title, cited_text, highlight_id, passage_sha, content_hash, job_id)
    VALUES (v_book, v_ch, v_src->>'kind',
            CASE WHEN v_src->>'kind' = 'web' THEN v_src->>'url' END,
            CASE WHEN v_src->>'kind' = 'web' THEN v_src->>'domain' END,
            CASE WHEN v_src->>'kind' = 'web' THEN v_src->>'title' END,
            CASE WHEN v_src->>'kind' = 'web' THEN v_src->>'cited_text' END,
            CASE WHEN v_src->>'kind' = 'highlight' THEN (v_src->>'highlight_id')::bigint END,
            v_psha, pds.reading_sha256(v_text), v_job)
    ON CONFLICT (book_id, content_hash) DO UPDATE SET retrieved_at = EXCLUDED.retrieved_at
    RETURNING source_id INTO v_sid;
    v_map := v_map || jsonb_build_object(v_src->>'ref', v_sid);
  END LOOP;

  -- What the job looked at: the pairs it sent, else a build's live chapter highlights / a highlights step's cited ones.
  INSERT INTO pds.reading_bank_highlight_seen (highlight_id, passage_sha, book_id, chapter, job_id)
  SELECT DISTINCT h.highlight_id, s.sha, v_book, v_ch, v_job
    FROM (SELECT NULLIF(e->>'highlight_id', '')::bigint AS id, e->>'passage_sha' AS sha
            FROM jsonb_array_elements(COALESCE(p->'seen', '[]'::jsonb)) e
          UNION ALL
          SELECT h2.highlight_id, pds.reading_sha256(h2.passage)
            FROM pds.book_highlights h2
           WHERE p->'seen' IS NULL AND h2.book_id = v_book AND NOT h2.archived
             AND ((v_replace AND h2.chapter = v_ch)
                  OR h2.highlight_id IN (SELECT NULLIF(x->>'highlight_id', '')::bigint
                                           FROM jsonb_array_elements(COALESCE(p->'sources', '[]'::jsonb)) x WHERE x->>'kind' = 'highlight'))) s
    JOIN pds.book_highlights h ON h.highlight_id = s.id AND h.book_id = v_book
   WHERE s.sha ~ '^[0-9a-f]{64}$'
  ON CONFLICT (highlight_id, passage_sha) DO NOTHING;

  FOR v_idea IN SELECT * FROM jsonb_array_elements(COALESCE(p->'ideas', '[]'::jsonb)) LOOP
    -- (parenthesized: PL/pgSQL ends an IF condition at the first THEN outside parentheses, one inside a bare CASE included)
    IF (CASE WHEN jsonb_typeof(v_idea->'evidence') = 'array' THEN jsonb_array_length(v_idea->'evidence') = 0 ELSE true END) THEN
      RAISE EXCEPTION USING ERRCODE = 'OXB03', MESSAGE = 'an idea needs at least one piece of evidence';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_idea->'evidence') e WHERE v_map->>e IS NULL) THEN
      RAISE EXCEPTION USING ERRCODE = 'OXB05', MESSAGE = 'an idea cites evidence that is not in this batch';
    END IF;
    v_unlock := COALESCE(NULLIF(v_idea->>'unlock_chapter', '')::int, v_ch);
    v_unlock := CASE WHEN v_ch = 0 OR v_unlock > v_ch THEN GREATEST(v_ch, v_end) ELSE v_ch END;
    v_iid := NULL;
    INSERT INTO pds.reading_ideas (book_id, chapter, unlock_chapter, chapter_hash, kind, importance, title, statement,
                                   key_points, facts, origin, content_hash, prompt_version, job_id)
    VALUES (v_book, v_ch, v_unlock, v_hash,
            v_idea->>'kind', v_idea->>'importance', btrim(v_idea->>'title'), btrim(v_idea->>'statement'),
            v_idea->'key_points', COALESCE(v_idea->'facts', '[]'::jsonb), v_idea->>'origin',
            pds.reading_sha256(jsonb_build_object('chapter', v_ch, 'title', btrim(v_idea->>'title'),
              'statement', btrim(v_idea->>'statement'), 'key_points', v_idea->'key_points')::text),
            v_pv, v_job)
    ON CONFLICT (book_id, content_hash) WHERE status = 'active' DO NOTHING
    RETURNING idea_id INTO v_iid;
    IF v_iid IS NULL THEN CONTINUE; END IF;   -- the same idea is already active (the highlights step)
    v_ideas := v_ideas + 1;
    INSERT INTO pds.reading_idea_evidence (idea_id, source_id)
    SELECT DISTINCT v_iid, (v_map->>e)::bigint FROM jsonb_array_elements_text(v_idea->'evidence') e
    ON CONFLICT (idea_id, source_id) DO NOTHING;

    v_shash := pds.reading_sha256(pds.reading_source_text(v_book, 'idea', v_iid));
    FOR v_q IN SELECT * FROM jsonb_array_elements(COALESCE(v_idea->'questions', '[]'::jsonb)) LOOP
      v_prompt := btrim(COALESCE(v_q->>'prompt', ''));
      v_rub := (v_q->'rubric')::text;
      IF v_prompt = '' OR length(v_prompt) > 1000 OR v_rub IS NULL OR jsonb_typeof(v_q->'rubric') <> 'object'
         OR length(v_rub) > 2000 OR COALESCE(v_q->>'format', '') NOT IN ('cued', 'explain', 'order') THEN
        RAISE EXCEPTION USING ERRCODE = 'OXB04', MESSAGE = 'question out of bounds';
      END IF;
      -- Same content hash formula as pds.reading_question_apply (T07); pds.reading_bank_attempt re-checks it.
      INSERT INTO pds.reading_questions (question_key, version, book_id, prompt, rubric, source_kind, source_ref, source_hash,
                                         content_hash, idea_id, bank_chapter, format, unlock_chapter, chapter_hash, bank_job_id, prompt_version)
      VALUES (gen_random_uuid(), 1, v_book, v_prompt, v_rub, 'idea', v_iid, v_shash,
              pds.reading_sha256(jsonb_build_object('prompt', v_prompt, 'rubric', v_rub, 'source_kind', 'idea',
                'source_ref', v_iid, 'source_hash', v_shash)::text),
              v_iid, v_ch, v_q->>'format', v_unlock, v_hash, v_job, v_pv);
      v_qs := v_qs + 1;
    END LOOP;
  END LOOP;

  -- Highlights linked to an idea already stored in this chapter (the highlights step): that idea gains the evidence.
  FOR v_q IN SELECT * FROM jsonb_array_elements(COALESCE(p->'links', '[]'::jsonb)) LOOP
    IF NOT EXISTS (SELECT 1 FROM pds.reading_ideas WHERE idea_id = NULLIF(v_q->>'idea_id', '')::bigint AND book_id = v_book
                     AND chapter = v_ch AND status = 'active')
       OR v_map->>(v_q->>'source_ref') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'OXB06', MESSAGE = 'a link needs an active idea of this chapter and a source of this batch';
    END IF;
    INSERT INTO pds.reading_idea_evidence (idea_id, source_id)
    VALUES ((v_q->>'idea_id')::bigint, (v_map->>(v_q->>'source_ref'))::bigint)
    ON CONFLICT (idea_id, source_id) DO NOTHING;
    UPDATE pds.reading_ideas SET origin = 'both' WHERE idea_id = (v_q->>'idea_id')::bigint AND origin = 'web';
  END LOOP;

  -- The chapter recall question (section 13): rebuilt with a build (T07's default invalidation); after the
  -- highlights step, created when missing or re-versioned with the added ideas (answers keep counting).
  IF v_ch >= 1 AND NOT v_keep THEN
    v_qs := v_qs + pds.reading_bank_recall_refresh(v_book, v_ch, v_job, v_pv,
                     CASE WHEN v_replace THEN 'chapter questions rebuilt' ELSE 'chapter ideas added' END,
                     CASE WHEN v_replace THEN NULL ELSE false END, v_replace);
  END IF;

  INSERT INTO pds.reading_bank_chapters AS c (book_id, chapter, status, chapter_hash, ideas, questions, sources, rejected,
                                             built_rebuilds, built_at, prompt_version)
  VALUES (v_book, v_ch, CASE WHEN v_keep THEN 'ready' ELSE COALESCE(p->>'status', 'ready') END, v_hash,
          (SELECT count(*) FROM pds.reading_ideas WHERE book_id = v_book AND chapter = v_ch AND status = 'active'),
          (SELECT count(*) FROM pds.reading_questions WHERE book_id = v_book AND bank_chapter = v_ch AND superseded_at IS NULL AND retired_at IS NULL),
          (SELECT count(DISTINCT e.source_id) FROM pds.reading_idea_evidence e
             JOIN pds.reading_ideas i ON i.idea_id = e.idea_id
            WHERE i.book_id = v_book AND i.chapter = v_ch AND i.status = 'active'),
          COALESCE((p->'counts'->>'rejected')::int, 0), COALESCE(v_rebuild, 0), NOW(), v_pv)
  ON CONFLICT (book_id, chapter) DO UPDATE SET
    status = CASE WHEN v_keep THEN c.status
                  WHEN p->>'status' IS NOT NULL THEN p->>'status'
                  WHEN c.status = 'no_sources' AND EXCLUDED.ideas > 0 THEN 'anchors_only'
                  ELSE c.status END,
    chapter_hash = EXCLUDED.chapter_hash, ideas = EXCLUDED.ideas,
    questions = EXCLUDED.questions, sources = EXCLUDED.sources, rejected = c.rejected + EXCLUDED.rejected,
    built_rebuilds = CASE WHEN v_replace THEN COALESCE(v_rebuild, c.rebuilds) ELSE c.built_rebuilds END,
    built_at = CASE WHEN v_replace AND NOT v_keep THEN EXCLUDED.built_at ELSE c.built_at END,
    prompt_version = CASE WHEN v_keep THEN c.prompt_version ELSE EXCLUDED.prompt_version END;

  v_receipt := jsonb_build_object('ok', true, 'ideas', v_ideas, 'questions', v_qs, 'kept_existing', v_keep);
  UPDATE pds.reading_bank_jobs SET store_receipt = v_receipt WHERE job_id = v_job;
  RETURN v_receipt || jsonb_build_object('replayed', false);
END $fn$;

-- 14. One answer: a T07 attempt row + (when code can grade) the grade and the schedule, in one transaction -----
-- p: {attempt_key, question_id, answer, round_key, round_date, round_kind, hinted, response_ms, quiz_key?,
--     grader_version?, grade_inline?, local?: {verdict, score}, states?: [...]}
-- local + states only for code-graded answers (cued / order, a hinted choice, or "I don't know" on any format).
-- Any other answer is stored pending, moves the state_version of every idea it covers (it holds its day's slot,
-- so a replay computed before it must not pass), and queues a grade job. grade_inline = true (the chat tool, which
-- grades in the same request through pds.reading_bank_grade) queues that job 10 minutes later, as a safety net
-- only; a grade job whose answer is no longer pending is never claimed (pds.reading_bank_claim skips it).
CREATE OR REPLACE FUNCTION pds.reading_bank_attempt(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_key    UUID;
  v_qid    BIGINT;
  v_round  UUID;
  v_rdate  DATE;
  v_quiz   UUID;
  v_hinted BOOLEAN;
  v_ms     INTEGER;
  v_score  NUMERIC;
  v_inline BOOLEAN;
  v_kind   TEXT := p->>'round_kind';
  v_answer TEXT := p->>'answer';
  v_local  JSONB := CASE WHEN jsonb_typeof(p->'local') = 'object' THEN p->'local' END;
  v_today  DATE := pds.behavioral_today_now();
  v_hash   TEXT;
  v_src    TEXT;
  v_covers BIGINT[];
  v_need   BIGINT[];
  v_q      pds.reading_questions%ROWTYPE;
  v_a      pds.reading_question_attempts%ROWTYPE;
BEGIN
  BEGIN
    v_key    := (p->>'attempt_key')::uuid;
    v_qid    := (p->>'question_id')::bigint;
    v_round  := NULLIF(p->>'round_key', '')::uuid;
    v_rdate  := NULLIF(p->>'round_date', '')::date;
    v_quiz   := NULLIF(p->>'quiz_key', '')::uuid;
    v_hinted := COALESCE(NULLIF(p->>'hinted', '')::boolean, false);
    v_ms     := NULLIF(p->>'response_ms', '')::int;
    v_score  := (v_local->>'score')::numeric;
    v_inline := COALESCE(NULLIF(p->>'grade_inline', '')::boolean, false);
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END;
  IF v_key IS NULL OR v_qid IS NULL OR v_round IS NULL OR v_kind IS NULL
     OR v_kind NOT IN ('daily', 'extra', 'chapter', 'checkpoint', 'chat')
     OR (v_kind = 'checkpoint') <> (v_quiz IS NOT NULL)
     OR v_answer IS NULL OR btrim(v_answer) = '' OR length(v_answer) > 4000
     OR (v_ms IS NOT NULL AND (v_ms < 0 OR v_ms > 3600000))
     OR (v_local IS NOT NULL AND (COALESCE(v_local->>'verdict', '') NOT IN ('correct', 'partial', 'incorrect', 'dont_know')
                                  OR v_score IS NULL OR v_score < 0 OR v_score > 1)) THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  -- The request identity (an attempt key with another request is 409 key_reused). round_date is part of it as sent.
  v_hash := pds.reading_sha256(jsonb_build_object('question_id', v_qid, 'answer', v_answer, 'round_key', v_round,
              'round_date', p->>'round_date', 'round_kind', v_kind, 'hinted', v_hinted, 'quiz_key', v_quiz)::text);
  -- The round's day is kept across the 06:00 rollover (PROD-T06), never more than one day back.
  IF v_rdate IS NULL OR v_rdate > v_today OR v_rdate < v_today - 1 THEN v_rdate := v_today; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));

  SELECT * INTO v_a FROM pds.reading_question_attempts WHERE attempt_key = v_key;
  IF FOUND THEN
    IF v_a.ext_hash IS DISTINCT FROM v_hash THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'key_reused');
    END IF;
    RETURN pds.reading_bank_receipt(v_key) || jsonb_build_object('replayed', true);
  END IF;

  SELECT * INTO v_q FROM pds.reading_questions WHERE question_id = v_qid;
  IF NOT FOUND OR v_q.format IS NULL THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;
  IF v_q.superseded_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'question_changed'); END IF;
  IF v_q.retired_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'retired'); END IF;
  IF v_q.unlock_chapter > pds.reading_bank_quiz_through(v_q.book_id) THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'locked');
  END IF;
  IF v_q.chapter_hash IS DISTINCT FROM pds.reading_bank_chapter_hash(v_q.book_id, v_q.bank_chapter) THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'chapter_changed');
  END IF;
  -- An idea question needs its idea to rest on valid evidence still (an edited highlight pauses it).
  IF v_q.idea_id IS NOT NULL AND NOT pds.reading_bank_idea_supported(v_q.idea_id) THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'retired');
  END IF;
  -- A chapter recall answer covers the ideas its rubric lists. None of them may unlock later than the gate (the
  -- store and the flags keep the rubric to ideas that unlock with the chapter; this is the check at answer time).
  IF v_q.format = 'chapter_recall' THEN
    v_covers := ARRAY(SELECT (e->>'idea_id')::bigint FROM jsonb_array_elements(v_q.rubric::jsonb->'ideas') e);
    IF EXISTS (SELECT 1 FROM pds.reading_ideas i WHERE i.idea_id = ANY(v_covers)
                 AND i.unlock_chapter > pds.reading_bank_quiz_through(v_q.book_id)) THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'locked');
    END IF;
    -- Every listed idea must still be active, of this chapter and edition, with valid evidence: an idea that lost
    -- its only highlight is never scored through a recall answer (the next plan re-versions the rubric).
    IF NOT pds.reading_bank_recall_valid(v_q.rubric, v_q.book_id, v_q.bank_chapter) THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'question_changed');
    END IF;
  END IF;
  -- Code grades explain / chapter recall answers only as "I don't know"; everything else there is the model's.
  IF v_local IS NOT NULL AND v_q.format IN ('explain', 'chapter_recall') AND v_local->>'verdict' <> 'dont_know' THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  -- A code-graded answer carries the replayed schedule of every idea it moves (lib/reading-recall.ts
  -- replayIdeaState): the idea, or each active idea a chapter recall answer covers.
  v_need := CASE WHEN v_q.format = 'chapter_recall'
                 THEN ARRAY(SELECT i.idea_id FROM pds.reading_ideas i WHERE i.idea_id = ANY(v_covers) AND i.status = 'active')
                 WHEN v_q.idea_id IS NOT NULL THEN ARRAY[v_q.idea_id] ELSE '{}'::bigint[] END;
  IF v_local IS NOT NULL AND EXISTS (
       SELECT 1 FROM unnest(v_need) n(id)
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'states') = 'array' THEN p->'states' ELSE '[]'::jsonb END) st
                           WHERE st->>'idea_id' = n.id::text)) THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'states_missing');
  END IF;
  IF v_local IS NOT NULL AND NOT pds.reading_bank_states_ok(p->'states') THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'raced');
  END IF;

  -- PROD-T07's answer rules, applied here because pds.reading_question_apply accepts only the source kinds
  -- highlight | session | chapter: the same refusal codes, hash formulas and columns. One deliberate difference:
  -- T07 answers a question whose source TEXT moved by making the next version itself ("source text changed");
  -- here that is 409 question_changed. An idea's text is immutable (a change is a new idea), and a chapter's text
  -- moves only with its table of contents title, which the edition check above already refuses, so this branch
  -- is a guard; the bank never versions a question from inside an answer.
  IF v_quiz IS NOT NULL AND EXISTS (SELECT 1 FROM pds.reading_quizzes WHERE op_key = v_quiz) THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'quiz_closed');
  END IF;
  IF v_quiz IS NOT NULL AND EXISTS (
       SELECT 1 FROM pds.reading_question_attempts a
         JOIN pds.reading_questions q ON q.question_id = a.question_id
        WHERE a.quiz_key = v_quiz AND q.question_key = v_q.question_key AND a.grading_status <> 'invalidated') THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'already_answered');
  END IF;
  IF v_quiz IS NOT NULL AND EXISTS (
       SELECT 1 FROM pds.reading_question_attempts a
         JOIN pds.reading_questions q ON q.question_id = a.question_id
        WHERE a.quiz_key = v_quiz AND q.book_id <> v_q.book_id) THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'quiz_other_book');
  END IF;
  v_src := pds.reading_source_text(v_q.book_id, v_q.source_kind, v_q.source_ref);
  IF v_src IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'source_not_permitted');
  END IF;
  IF pds.reading_sha256(jsonb_build_object('prompt', v_q.prompt, 'rubric', v_q.rubric, 'source_kind', v_q.source_kind,
       'source_ref', v_q.source_ref, 'source_hash', pds.reading_sha256(v_src))::text) <> v_q.content_hash THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'question_changed');
  END IF;

  INSERT INTO pds.reading_question_attempts (attempt_key, question_id, quiz_key, attempt_date, answer, answer_hash, request_hash,
                                             round_key, round_kind, idea_id, covers, hinted, response_ms, ext_hash)
  VALUES (v_key, v_q.question_id, v_quiz, v_rdate, v_answer, pds.reading_sha256(v_answer),
          pds.reading_sha256(jsonb_build_object(
            'book_id', v_q.book_id, 'question_key', v_q.question_key, 'prompt', v_q.prompt, 'rubric', v_q.rubric, 'source_kind', v_q.source_kind,
            'source_ref', v_q.source_ref, 'answer', v_answer, 'quiz_key', v_quiz)::text),
          v_round, v_kind, v_q.idea_id, v_covers, v_hinted, v_ms, v_hash);

  IF v_local IS NOT NULL THEN
    -- The bank's code grade is written here, not through T07's 'grade' kind (which accepts only model | self).
    UPDATE pds.reading_question_attempts
       SET grading_status = 'graded', correct = (v_local->>'verdict') = 'correct', grader = 'local', graded_at = NOW(),
           verdict = v_local->>'verdict', score = v_score
     WHERE attempt_key = v_key;
    PERFORM pds.reading_bank_states_write(p->'states');
  ELSE
    PERFORM pds.reading_bank_touch_states(v_need, false);
    INSERT INTO pds.reading_bank_jobs (book_id, step, chapter, input_hash, prompt_version, priority, attempt_key, next_attempt_at)
    VALUES (v_q.book_id, 'grade', 0, pds.reading_sha256('grade|' || v_key::text), COALESCE(NULLIF(p->>'grader_version', ''), 'grade-1'), 5, v_key,
            CASE WHEN v_inline THEN NOW() + interval '10 minutes' ELSE NOW() END)
    ON CONFLICT (book_id, step, chapter, input_hash) DO NOTHING;
  END IF;
  RETURN pds.reading_bank_receipt(v_key) || jsonb_build_object('replayed', false);
END $fn$;

-- 15. Model or self grade for a pending answer, with the replayed schedule ---------------------------------------
-- p: {attempt_key, verdict, score, hits, feedback?, grader: 'model'|'self', states}
CREATE OR REPLACE FUNCTION pds.reading_bank_grade(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_key     UUID;
  v_score   NUMERIC;
  v_verdict TEXT := p->>'verdict';
  v_grader  TEXT := p->>'grader';
  v_fb      TEXT := NULLIF(btrim(COALESCE(p->>'feedback', '')), '');
  v_hits    JSONB := p->'hits';
  v_a       pds.reading_question_attempts%ROWTYPE;
BEGIN
  BEGIN
    v_key := (p->>'attempt_key')::uuid;
    v_score := (p->>'score')::numeric;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END;
  IF v_key IS NULL OR v_verdict IS NULL OR v_verdict NOT IN ('correct', 'partial', 'incorrect')
     OR v_grader IS NULL OR v_grader NOT IN ('model', 'self') OR v_score IS NULL OR v_score < 0 OR v_score > 1
     OR length(COALESCE(v_fb, '')) > 300
     OR (v_hits IS NOT NULL AND jsonb_typeof(v_hits) <> 'array' AND jsonb_typeof(v_hits) <> 'null') THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));
  SELECT * INTO v_a FROM pds.reading_question_attempts WHERE attempt_key = v_key FOR UPDATE;
  IF NOT FOUND OR v_a.ext_hash IS NULL THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;
  IF v_a.grading_status = 'invalidated' THEN RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'invalidated'); END IF;
  IF v_a.grading_status = 'graded' THEN
    IF v_a.verdict = v_verdict AND v_a.grader = v_grader THEN
      RETURN pds.reading_bank_receipt(v_key) || jsonb_build_object('replayed', true);
    END IF;
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'already_graded');
  END IF;
  -- The replayed schedule of every idea the grade moves: the idea, or each active idea a chapter recall answer covers
  -- (a missed core idea there must come back as due tomorrow).
  IF EXISTS (
       SELECT 1 FROM unnest(CASE WHEN v_a.idea_id IS NOT NULL THEN ARRAY[v_a.idea_id]
                                 ELSE ARRAY(SELECT i.idea_id FROM pds.reading_ideas i
                                             WHERE i.idea_id = ANY(COALESCE(v_a.covers, '{}'::bigint[])) AND i.status = 'active') END) n(id)
        WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'states') = 'array' THEN p->'states' ELSE '[]'::jsonb END) st
                           WHERE st->>'idea_id' = n.id::text)) THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'states_missing');
  END IF;
  IF NOT pds.reading_bank_states_ok(p->'states') THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'raced');
  END IF;
  UPDATE pds.reading_question_attempts
     SET grading_status = 'graded', correct = (v_verdict = 'correct'), grader = v_grader, feedback = v_fb, graded_at = NOW(),
         verdict = v_verdict, score = v_score, rubric_hits = CASE WHEN jsonb_typeof(v_hits) = 'array' THEN v_hits END, grade_error = NULL
   WHERE attempt_key = v_key;
  PERFORM pds.reading_bank_states_write(p->'states');
  RETURN pds.reading_bank_receipt(v_key) || jsonb_build_object('replayed', false);
END $fn$;

-- 16. Disagree: one override of a model grade (not for chapter recall, not after its quiz was recorded) --------
-- p: {attempt_key, verdict, states}
CREATE OR REPLACE FUNCTION pds.reading_bank_override(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_key     UUID;
  v_verdict TEXT := p->>'verdict';
  v_a       pds.reading_question_attempts%ROWTYPE;
  v_fmt     TEXT;
BEGIN
  BEGIN v_key := (p->>'attempt_key')::uuid;
  EXCEPTION WHEN others THEN RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request'); END;
  IF v_key IS NULL OR v_verdict IS NULL OR v_verdict NOT IN ('correct', 'partial', 'incorrect') THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));
  SELECT * INTO v_a FROM pds.reading_question_attempts WHERE attempt_key = v_key FOR UPDATE;
  IF NOT FOUND OR v_a.ext_hash IS NULL THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;
  SELECT format INTO v_fmt FROM pds.reading_questions WHERE question_id = v_a.question_id;
  IF v_a.overridden_at IS NOT NULL THEN
    IF v_a.verdict = v_verdict THEN RETURN pds.reading_bank_receipt(v_key) || jsonb_build_object('replayed', true); END IF;
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'already_overridden');
  END IF;
  IF v_a.grading_status <> 'graded' OR v_a.grader IS DISTINCT FROM 'model' OR v_fmt = 'chapter_recall' THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'not_overridable');
  END IF;
  IF v_a.quiz_key IS NOT NULL AND EXISTS (SELECT 1 FROM pds.reading_quizzes WHERE op_key = v_a.quiz_key) THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'quiz_closed');
  END IF;
  IF v_a.idea_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'states') = 'array' THEN p->'states' ELSE '[]'::jsonb END) st
        WHERE st->>'idea_id' = v_a.idea_id::text) THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'states_missing');
  END IF;
  IF NOT pds.reading_bank_states_ok(p->'states') THEN RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'raced'); END IF;
  UPDATE pds.reading_question_attempts
     SET model_verdict = v_a.verdict, model_score = v_a.score, verdict = v_verdict,
         score = CASE v_verdict WHEN 'correct' THEN 1.00 WHEN 'partial' THEN 0.60 ELSE 0.00 END,
         correct = (v_verdict = 'correct'), grader = 'self', overridden_at = NOW()
   WHERE attempt_key = v_key;
  PERFORM pds.reading_bank_states_write(p->'states');
  RETURN pds.reading_bank_receipt(v_key) || jsonb_build_object('replayed', false);
END $fn$;

-- 17. Flags and Restore ---------------------------------------------------------------------------------------------
-- p: {flag_key, question_id, kind, via?}  or  {flag_key, restore: true}
-- wrong          : the idea is retired with all its questions (a chapter recall question: that question only); every
--                  answer to them is invalidated (kept, with the reason); quiz results that counted them say so;
--                  the chapter recall answers that covered the idea stop counting for it (pds.reading_bank_events:
--                  the rest of each such answer stays valid) and the chapter recall question gets a new version
--                  without it; the affected ideas' states are marked dirty (the caller replays them).
-- unclear        : that question is retired and its answers invalidated; the idea stays.
-- not_in_chapter : the idea and its questions unlock at the end of the book; answers stay valid; the chapter recall
--                  question gets a new version without it (its title must not stay listed for the chapter).
-- not_read_yet   : a hold on that chapter (pds.reading_bank_quiz_through); nothing else changes.
-- Restore un-retires / un-holds (and puts the idea back into the chapter recall question); answers a flag voided
-- stay voided. Marking states dirty also moves state_version (pds.reading_bank_touch_states, which also creates the
-- row of an idea that has none), so a replay computed before the flag cannot pass the compare-and-set and write
-- back what the flag voided.
-- A flag sent for an older version of a question (a chapter recall question re-versioned in the seconds before the
-- deferred flag left the screen) acts on the question's current version; the flag row records that version, the
-- request hash keeps the id that was sent. A question whose versions are all superseded is 409 question_changed.
-- Restore of a chapter recall question is refused (409 superseded) when the chapter has another live recall question
-- by now (a rebuild made a new one), so a chapter never has two.
CREATE OR REPLACE FUNCTION pds.reading_bank_flag(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_key    UUID;
  v_qid    BIGINT;
  v_kind   TEXT := p->>'kind';
  v_via    TEXT := COALESCE(p->>'via', 'app');
  v_hash   TEXT;
  v_f      pds.reading_question_flags%ROWTYPE;
  v_q      pds.reading_questions%ROWTYPE;
  v_i      pds.reading_ideas%ROWTYPE;
  v_qids   BIGINT[] := '{}';
  v_hit    UUID[] := '{}';
  v_ideas  BIGINT[] := '{}';
  v_total  INTEGER;
  v_pos    INTEGER;
  v_prev   INTEGER;
BEGIN
  BEGIN
    v_key := (p->>'flag_key')::uuid;
    v_qid := NULLIF(p->>'question_id', '')::bigint;
  EXCEPTION WHEN others THEN RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request'); END;
  IF v_key IS NULL THEN RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_practice'));

  IF COALESCE((p->>'restore')::boolean, false) THEN
    SELECT * INTO v_f FROM pds.reading_question_flags WHERE flag_key = v_key FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;
    IF v_f.restored_at IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'restored', true, 'kind', v_f.kind, 'replayed', true); END IF;
    SELECT * INTO v_q FROM pds.reading_questions WHERE question_id = v_f.question_id;
    IF v_f.kind = 'wrong' AND v_f.idea_id IS NOT NULL THEN
      SELECT * INTO v_i FROM pds.reading_ideas WHERE idea_id = v_f.idea_id;
      -- A rebuild of the chapter since the flag, or the same idea stored again, supersedes it.
      IF EXISTS (SELECT 1 FROM pds.reading_ideas d
                  WHERE d.book_id = v_i.book_id AND d.status = 'active' AND d.idea_id <> v_i.idea_id AND d.content_hash = v_i.content_hash)
         OR EXISTS (SELECT 1 FROM pds.reading_ideas d
                     WHERE d.book_id = v_i.book_id AND d.chapter = v_i.chapter AND d.status = 'retired'
                       AND d.retired_reason IN ('rebuilt', 'toc_changed') AND d.retired_at > v_f.created_at) THEN
        RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'superseded');
      END IF;
      UPDATE pds.reading_ideas SET status = 'active', retired_at = NULL, retired_reason = NULL
       WHERE idea_id = v_f.idea_id AND retired_reason = 'wrong';
      UPDATE pds.reading_questions SET retired_at = NULL, retired_reason = NULL
       WHERE idea_id = v_f.idea_id AND retired_reason IN ('wrong', 'idea_retired') AND superseded_at IS NULL;
      v_ideas := ARRAY[v_f.idea_id];
      PERFORM pds.reading_bank_touch_states(v_ideas, true);
      PERFORM pds.reading_bank_recall_refresh(v_i.book_id, v_i.chapter, NULL, NULL, 'flag restored', false, false);
    ELSIF v_f.kind IN ('wrong', 'unclear') THEN
      IF v_q.format = 'chapter_recall' AND EXISTS (
           SELECT 1 FROM pds.reading_questions o
            WHERE o.book_id = v_q.book_id AND o.format = 'chapter_recall' AND o.bank_chapter = v_q.bank_chapter
              AND o.question_key <> v_q.question_key AND o.superseded_at IS NULL AND o.retired_at IS NULL) THEN
        RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'superseded');
      END IF;
      UPDATE pds.reading_questions SET retired_at = NULL, retired_reason = NULL
       WHERE question_id = v_f.question_id AND retired_reason IN ('wrong', 'unclear') AND superseded_at IS NULL;
      IF v_q.format = 'chapter_recall' THEN   -- back in step with ideas that changed while it was retired
        PERFORM pds.reading_bank_recall_refresh(v_q.book_id, v_q.bank_chapter, NULL, NULL, 'flag restored', false, false);
      END IF;
    ELSIF v_f.kind = 'not_in_chapter' THEN
      UPDATE pds.reading_ideas SET unlock_chapter = GREATEST(chapter, COALESCE(v_f.prev_unlock, chapter)) WHERE idea_id = v_f.idea_id;
      UPDATE pds.reading_questions SET unlock_chapter = GREATEST(bank_chapter, COALESCE(v_f.prev_unlock, bank_chapter)) WHERE idea_id = v_f.idea_id;
      PERFORM pds.reading_bank_recall_refresh(v_q.book_id, v_q.bank_chapter, NULL, NULL, 'flag restored', false, false);
    ELSE
      -- Only the hold this flag set (a later hold stays).
      UPDATE pds.reading_bank_books SET hold_chapter = NULL, hold_position = NULL, hold_at = NULL, updated_at = NOW()
       WHERE book_id = v_q.book_id AND hold_at = v_f.created_at;
    END IF;
    UPDATE pds.reading_question_flags SET restored_at = NOW() WHERE flag_key = v_key;
    RETURN jsonb_build_object('ok', true, 'restored', true, 'kind', v_f.kind, 'affected_ideas', to_jsonb(v_ideas), 'replayed', false);
  END IF;

  IF v_qid IS NULL OR v_kind IS NULL OR v_kind NOT IN ('wrong', 'unclear', 'not_in_chapter', 'not_read_yet') OR v_via NOT IN ('app', 'chat') THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  v_hash := pds.reading_sha256(jsonb_build_object('question_id', v_qid, 'kind', v_kind, 'via', v_via)::text);
  SELECT * INTO v_f FROM pds.reading_question_flags WHERE flag_key = v_key;
  IF FOUND THEN
    IF v_f.request_hash <> v_hash THEN RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'key_reused'); END IF;
    RETURN jsonb_build_object('ok', true, 'kind', v_f.kind, 'invalidated', v_f.invalidated_attempts, 'replayed', true);
  END IF;
  SELECT * INTO v_q FROM pds.reading_questions WHERE question_id = v_qid;
  IF NOT FOUND OR v_q.format IS NULL THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;
  IF v_q.superseded_at IS NOT NULL THEN   -- act on the current version of the same question
    SELECT * INTO v_q FROM pds.reading_questions WHERE question_key = v_q.question_key AND superseded_at IS NULL;
    IF NOT FOUND OR v_q.format IS NULL THEN RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'question_changed'); END IF;
  END IF;
  -- A flag is about a question Riley could see: never one of a locked chapter.
  IF v_q.unlock_chapter > pds.reading_bank_quiz_through(v_q.book_id) AND v_kind <> 'not_read_yet' THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'locked');
  END IF;
  IF v_kind = 'not_in_chapter' AND v_q.idea_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request'); END IF;

  IF v_kind IN ('wrong', 'unclear') THEN
    IF v_kind = 'wrong' AND v_q.idea_id IS NOT NULL THEN
      UPDATE pds.reading_ideas SET status = 'retired', retired_reason = 'wrong', retired_at = NOW()
       WHERE idea_id = v_q.idea_id AND status = 'active';
      SELECT COALESCE(array_agg(question_id), '{}') INTO v_qids FROM pds.reading_questions
       WHERE idea_id = v_q.idea_id AND retired_at IS NULL AND superseded_at IS NULL;
      v_qids := array_append(v_qids, v_q.question_id);
      v_ideas := ARRAY[v_q.idea_id];
    ELSE
      v_qids := ARRAY[v_q.question_id];
      v_ideas := CASE WHEN v_q.idea_id IS NOT NULL THEN ARRAY[v_q.idea_id]
                      ELSE COALESCE(ARRAY(SELECT (e->>'idea_id')::bigint FROM jsonb_array_elements(v_q.rubric::jsonb->'ideas') e), '{}') END;
    END IF;
    UPDATE pds.reading_questions
       SET retired_at = NOW(), retired_reason = CASE WHEN question_id = v_q.question_id THEN v_kind ELSE 'idea_retired' END
     WHERE question_id = ANY(v_qids) AND retired_at IS NULL;
    SELECT COALESCE(array_agg(a.attempt_key), '{}') INTO v_hit
      FROM pds.reading_question_attempts a JOIN pds.reading_questions q ON q.question_id = a.question_id
     WHERE q.question_key IN (SELECT question_key FROM pds.reading_questions WHERE question_id = ANY(v_qids))
       AND a.grading_status <> 'invalidated';
    UPDATE pds.reading_question_attempts
       SET grading_status = 'invalidated', invalidated_at = NOW(), invalidated_reason = 'question flagged ' || v_kind
     WHERE attempt_key = ANY(v_hit);
    UPDATE pds.reading_quizzes qz
       SET invalidated_count = COALESCE(qz.invalidated_count, 0) + x.n
      FROM (SELECT quiz_key, count(*)::int AS n FROM pds.reading_question_attempts
             WHERE attempt_key = ANY(v_hit) AND quiz_key IS NOT NULL GROUP BY quiz_key) x
     WHERE qz.op_key = x.quiz_key;
    -- Every idea a voided answer fed, read off the answers themselves: they span every version of the question,
    -- and an older chapter recall rubric may list ideas the current one no longer does. Their schedules and stages
    -- were built partly on those answers, so each is marked for a replay.
    SELECT COALESCE(array_agg(DISTINCT t.id), '{}') INTO v_ideas FROM (
      SELECT unnest(v_ideas) AS id
      UNION SELECT a.idea_id FROM pds.reading_question_attempts a WHERE a.attempt_key = ANY(v_hit) AND a.idea_id IS NOT NULL
      UNION SELECT unnest(a.covers) FROM pds.reading_question_attempts a WHERE a.attempt_key = ANY(v_hit) AND a.covers IS NOT NULL
    ) t WHERE t.id IS NOT NULL;
    PERFORM pds.reading_bank_touch_states(v_ideas, true);
    IF v_kind = 'wrong' AND v_q.idea_id IS NOT NULL THEN
      PERFORM pds.reading_bank_recall_refresh(v_q.book_id, v_q.bank_chapter, NULL, NULL, 'an idea was flagged wrong', false, false);
    END IF;
  ELSIF v_kind = 'not_in_chapter' THEN
    v_total := pds.reading_bank_end_chapter(v_q.book_id);   -- the end of the book (never reached while unknown)
    SELECT unlock_chapter INTO v_prev FROM pds.reading_ideas WHERE idea_id = v_q.idea_id;
    UPDATE pds.reading_ideas SET unlock_chapter = GREATEST(chapter, v_total) WHERE idea_id = v_q.idea_id;
    UPDATE pds.reading_questions SET unlock_chapter = GREATEST(bank_chapter, v_total) WHERE idea_id = v_q.idea_id;
    v_ideas := ARRAY[v_q.idea_id];
    PERFORM pds.reading_bank_recall_refresh(v_q.book_id, v_q.bank_chapter, NULL, NULL, 'an idea was moved out of the chapter', false, false);
  ELSE -- not_read_yet
    SELECT last_position INTO v_pos FROM pds.books WHERE book_id = v_q.book_id;
    INSERT INTO pds.reading_bank_books (book_id, hold_chapter, hold_position, hold_at)
    VALUES (v_q.book_id, GREATEST(1, v_q.bank_chapter), v_pos, NOW())
    ON CONFLICT (book_id) DO UPDATE SET hold_chapter = EXCLUDED.hold_chapter, hold_position = EXCLUDED.hold_position,
                                        hold_at = EXCLUDED.hold_at, updated_at = NOW();
  END IF;

  INSERT INTO pds.reading_question_flags (flag_key, question_id, idea_id, kind, via, request_hash, invalidated_attempts, prev_unlock, prompt_version)
  VALUES (v_key, v_q.question_id, v_q.idea_id, v_kind, v_via, v_hash, cardinality(v_hit), v_prev, v_q.prompt_version);
  RETURN jsonb_build_object('ok', true, 'kind', v_kind, 'invalidated', cardinality(v_hit), 'affected_ideas', to_jsonb(v_ideas), 'replayed', false);
END $fn$;

-- 18. Answer events per idea (input to the replay; invalidated answers excluded; pending ones keep their day slot) -
-- A chapter recall answer is one event for every idea it covered, with that idea's rubric hit as the verdict (yes
-- correct, partial partial, no incorrect). A covered idea with no hit takes the answer's own verdict: a self grade
-- after a failed model grade and the chat tool's grade carry one verdict and no per-idea hits, and Riley's
-- "correct" there must not become a lapse for every idea. Except for an idea flagged Wrong after the answer: that
-- hit was graded against a wrong statement, so it is void for that idea (and stays void after a Restore), while
-- the answer keeps counting for the other ideas.
CREATE OR REPLACE FUNCTION pds.reading_bank_events(p_book BIGINT, p_ideas BIGINT[] DEFAULT NULL)
RETURNS TABLE (idea_id BIGINT, attempt_key UUID, question_id BIGINT, attempt_date DATE, answered_at TIMESTAMPTZ,
               grading_status TEXT, verdict TEXT, format TEXT, hinted BOOLEAN, round_kind TEXT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  SELECT a.idea_id, a.attempt_key, a.question_id, a.attempt_date, a.answered_at, a.grading_status, a.verdict, q.format, a.hinted, a.round_kind
    FROM pds.reading_question_attempts a JOIN pds.reading_questions q ON q.question_id = a.question_id
   WHERE q.book_id = p_book AND a.idea_id IS NOT NULL AND a.ext_hash IS NOT NULL AND a.grading_status <> 'invalidated'
     AND (p_ideas IS NULL OR a.idea_id = ANY(p_ideas))
  UNION ALL
  SELECT c.idea_id, a.attempt_key, a.question_id, a.attempt_date, a.answered_at, a.grading_status,
         CASE WHEN a.grading_status <> 'graded' THEN NULL
              WHEN a.verdict = 'dont_know' THEN 'dont_know'
              WHEN h.hit = 'yes' THEN 'correct' WHEN h.hit = 'partial' THEN 'partial' WHEN h.hit = 'no' THEN 'incorrect'
              ELSE a.verdict END,
         'chapter_recall', false, a.round_kind
    FROM pds.reading_question_attempts a JOIN pds.reading_questions q ON q.question_id = a.question_id
    CROSS JOIN LATERAL unnest(a.covers) AS c(idea_id)
    LEFT JOIN LATERAL (SELECT e->>'hit' AS hit FROM jsonb_array_elements(COALESCE(a.rubric_hits, '[]'::jsonb)) e
                        WHERE e->>'id' = 'i' || c.idea_id::text OR e->>'idea_id' = c.idea_id::text LIMIT 1) h ON true
   WHERE q.book_id = p_book AND q.format = 'chapter_recall' AND a.ext_hash IS NOT NULL AND a.grading_status <> 'invalidated'
     AND (p_ideas IS NULL OR c.idea_id = ANY(p_ideas))
     AND NOT EXISTS (SELECT 1 FROM pds.reading_question_flags f
                      WHERE f.kind = 'wrong' AND f.idea_id = c.idea_id AND f.created_at > a.answered_at)
   ORDER BY 1, 5, 2
$fn$;

-- 19. Today's round candidates for one book (read only; locked and stale rows never leave the server) ----------
-- p_chapter set = one chapter's ideas only (the chapter sheet's "Practice 5"): no chapter recall, no highlights.
CREATE OR REPLACE FUNCTION pds.reading_bank_deck(p_book BIGINT, p_today DATE, p_chapter INTEGER DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  WITH t AS (SELECT pds.reading_bank_quiz_through(p_book) AS through),
  cur AS (   -- the current edition hash of every chapter that has active ideas, computed once per chapter
    SELECT x.chapter, pds.reading_bank_chapter_hash(p_book, x.chapter) AS h
      FROM (SELECT DISTINCT i.chapter FROM pds.reading_ideas i WHERE i.book_id = p_book AND i.status = 'active') x
  ),
  done AS (
    SELECT a.attempt_key, a.question_id, a.idea_id, a.covers, a.round_key, a.round_kind, a.verdict, a.grading_status
      FROM pds.reading_question_attempts a JOIN pds.reading_questions q ON q.question_id = a.question_id
     WHERE q.book_id = p_book AND a.attempt_date = p_today AND a.ext_hash IS NOT NULL AND a.grading_status <> 'invalidated'
  ),
  live AS (
    SELECT i.idea_id, i.chapter, i.importance, i.kind, i.title, i.statement, i.key_points,
           COALESCE(s.stage, 0) AS stage, s.next_review, COALESCE(s.state_version, 0) AS state_version,
           COALESCE(s.dirty, false) AS dirty, COALESCE(s.last_question_ids, '{}') AS last_question_ids, s.last_verdict,
           COALESCE(s.ease, 2.50) AS ease, COALESCE(s.interval_days, 0) AS interval_days,
           COALESCE(s.review_count, 0) AS review_count, COALESCE(s.lapses, 0) AS lapses, s.stage_success_on, s.last_reviewed
      FROM pds.reading_ideas i
      JOIN cur ON cur.chapter = i.chapter AND cur.h = i.chapter_hash
      LEFT JOIN pds.reading_idea_state s ON s.idea_id = i.idea_id
     WHERE i.book_id = p_book AND i.status = 'active' AND i.unlock_chapter <= (SELECT through FROM t)
       AND (p_chapter IS NULL OR i.chapter = p_chapter)
       AND pds.reading_bank_idea_supported(i.idea_id)
  ),
  pick AS (
    (SELECT idea_id, 'due' AS why FROM live WHERE p_chapter IS NULL AND next_review IS NOT NULL AND next_review <= p_today
      ORDER BY next_review, chapter, idea_id LIMIT 25)
    UNION ALL
    (SELECT idea_id, 'new' FROM live WHERE p_chapter IS NULL AND next_review IS NULL
      ORDER BY CASE importance WHEN 'core' THEN 0 WHEN 'supporting' THEN 1 ELSE 2 END, chapter, idea_id LIMIT 15)
    UNION ALL
    (SELECT idea_id, 'newest' FROM live WHERE p_chapter IS NULL AND next_review IS NULL
        AND chapter = (SELECT max(chapter) FROM live WHERE chapter >= 1)
      ORDER BY CASE importance WHEN 'core' THEN 0 ELSE 1 END, idea_id LIMIT 3)
    UNION ALL   -- ideas answered today stay in the deck, so the day's round can be rebuilt and resumed
    (SELECT idea_id, 'answered' FROM live WHERE idea_id IN (SELECT d.idea_id FROM done d WHERE d.idea_id IS NOT NULL))
    UNION ALL
    (SELECT idea_id, CASE WHEN next_review IS NULL THEN 'new' WHEN next_review <= p_today THEN 'due' ELSE 'later' END
       FROM live WHERE p_chapter IS NOT NULL
      ORDER BY next_review NULLS FIRST, CASE importance WHEN 'core' THEN 0 WHEN 'supporting' THEN 1 ELSE 2 END, idea_id LIMIT 20)
  ),
  cards AS (
    SELECT l.*, (SELECT array_agg(DISTINCT pk.why ORDER BY pk.why) FROM pick pk WHERE pk.idea_id = l.idea_id) AS why,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('question_id', q.question_id, 'version', q.version, 'format', q.format,
                 'prompt', q.prompt, 'rubric', q.rubric::jsonb) ORDER BY q.question_id), '[]'::jsonb)
         FROM pds.reading_questions q
        WHERE q.idea_id = l.idea_id AND q.superseded_at IS NULL AND q.retired_at IS NULL
          AND q.unlock_chapter <= (SELECT through FROM t)) AS questions,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', src.kind, 'url', src.url, 'domain', src.domain, 'title', src.title,
                 'cited_text', src.cited_text, 'highlight_id', src.highlight_id, 'passage', h.passage, 'location', h.location,
                 'page', h.page) ORDER BY src.source_id), '[]'::jsonb)
         FROM pds.reading_idea_evidence e
         JOIN pds.reading_bank_sources src ON src.source_id = e.source_id
         LEFT JOIN pds.book_highlights h ON h.highlight_id = src.highlight_id AND NOT h.archived
        WHERE e.idea_id = l.idea_id
          AND (src.kind = 'web' OR (h.highlight_id IS NOT NULL AND pds.reading_sha256(h.passage) = src.passage_sha))) AS sources
      FROM live l WHERE l.idea_id IN (SELECT idea_id FROM pick)
  ),
  recall AS (
    SELECT c.chapter, c.quizzable_since, q.question_id, q.question_key, q.version, q.prompt, q.rubric::jsonb AS rubric,
           (SELECT count(DISTINCT a.attempt_date) FROM pds.reading_question_attempts a
              JOIN pds.reading_questions q2 ON q2.question_id = a.question_id
             WHERE q2.question_key = q.question_key AND a.grading_status <> 'invalidated' AND a.ext_hash IS NOT NULL
               AND a.attempt_date < p_today)::int AS done_n
      FROM pds.reading_bank_chapters c
      JOIN pds.reading_questions q ON q.book_id = c.book_id AND q.format = 'chapter_recall' AND q.bank_chapter = c.chapter
                                  AND q.superseded_at IS NULL AND q.retired_at IS NULL
     WHERE p_chapter IS NULL AND c.book_id = p_book AND c.chapter >= 1 AND c.chapter <= (SELECT through FROM t)
       AND c.quizzable_since IS NOT NULL AND q.chapter_hash = pds.reading_bank_chapter_hash(p_book, c.chapter)
       -- never a rubric that lists an idea unlocking later (the store and the flags keep it so; this is the backstop)
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(q.rubric::jsonb->'ideas') e
                         JOIN pds.reading_ideas i ON i.idea_id = (e->>'idea_id')::bigint
                        WHERE i.unlock_chapter > (SELECT through FROM t))
       -- and never one listing an idea that is no longer active, current or supported (until the sync re-versions it)
       AND pds.reading_bank_recall_valid(q.rubric, p_book, c.chapter)
  ),
  hl AS (   -- unlinked highlights due today, plus those already reviewed today (so a resumed round counts them as done)
    SELECT h.highlight_id, h.chapter, h.passage, h.comment, h.location, h.page, h.review_count, h.interval_days, h.ease,
           h.next_review, h.last_reviewed
      FROM pds.book_highlights h
     WHERE p_chapter IS NULL AND h.book_id = p_book AND NOT h.archived
       AND (h.next_review IS NULL OR h.next_review <= p_today OR h.last_reviewed = p_today)
       AND NOT EXISTS (SELECT 1 FROM pds.reading_bank_sources src
                         JOIN pds.reading_idea_evidence e ON e.source_id = src.source_id
                         JOIN pds.reading_ideas i ON i.idea_id = e.idea_id AND i.status = 'active'
                        WHERE src.highlight_id = h.highlight_id AND src.passage_sha = pds.reading_sha256(h.passage))
     ORDER BY (h.last_reviewed = p_today) DESC NULLS LAST, h.next_review NULLS FIRST, h.highlight_id LIMIT 5
  )
  SELECT jsonb_build_object(
    'book_id', p_book, 'today', p_today, 'quiz_through', (SELECT through FROM t), 'chapter', p_chapter,
    'enabled', COALESCE((SELECT bb.approved_at IS NOT NULL AND bb.paused_reason IS DISTINCT FROM 'owner'
                           FROM pds.reading_bank_books bb WHERE bb.book_id = p_book), false),
    'ideas', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.idea_id) FROM cards c), '[]'::jsonb),
    'chapter_recall', COALESCE((SELECT jsonb_agg(jsonb_build_object('chapter', r.chapter, 'question_id', r.question_id, 'version', r.version,
                                  'prompt', r.prompt, 'rubric', r.rubric, 'done_n', r.done_n,
                                  'due_on', r.quizzable_since + (ARRAY[1, 7, 21])[r.done_n + 1]) ORDER BY r.chapter)
                                  FROM recall r
                                 WHERE r.done_n < 3 AND r.quizzable_since + (ARRAY[1, 7, 21])[r.done_n + 1] <= p_today), '[]'::jsonb),
    'highlights', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.highlight_id) FROM hl x), '[]'::jsonb),
    'answered_today', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.attempt_key) FROM done d), '[]'::jsonb))
$fn$;

CREATE OR REPLACE FUNCTION pds.reading_bank_round(p_slug TEXT DEFAULT NULL, p_chapter INTEGER DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  WITH bk AS (SELECT pds.reading_bank_book_id(p_slug) AS book_id)
  SELECT CASE WHEN (SELECT book_id FROM bk) IS NULL THEN NULL
              ELSE pds.reading_bank_deck((SELECT book_id FROM bk), pds.behavioral_today_now(), p_chapter) END
$fn$;

-- 20. Overview summary (runs in parallel with the /api/reading book query; counts only) ---------------------------
CREATE OR REPLACE FUNCTION pds.reading_bank_summary(p_slug TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  WITH bk AS (SELECT pds.reading_bank_book_id(p_slug) AS book_id),
  today AS (SELECT pds.behavioral_today_now() AS d),
  bb AS (SELECT * FROM pds.reading_bank_books WHERE book_id = (SELECT book_id FROM bk)),
  t AS (SELECT pds.reading_bank_quiz_through((SELECT book_id FROM bk)) AS through),
  cur AS (
    SELECT x.chapter, pds.reading_bank_chapter_hash((SELECT book_id FROM bk), x.chapter) AS h
      FROM (SELECT DISTINCT i.chapter FROM pds.reading_ideas i WHERE i.book_id = (SELECT book_id FROM bk) AND i.status = 'active') x
  ),
  live AS (
    SELECT i.importance, COALESCE(s.stage, 0) AS stage, s.next_review
      FROM pds.reading_ideas i
      JOIN cur ON cur.chapter = i.chapter AND cur.h = i.chapter_hash
      LEFT JOIN pds.reading_idea_state s ON s.idea_id = i.idea_id
     WHERE i.book_id = (SELECT book_id FROM bk) AND i.status = 'active' AND i.unlock_chapter <= (SELECT through FROM t)
       AND pds.reading_bank_idea_supported(i.idea_id)
  ),
  ev AS (SELECT e.*, row_number() OVER (PARTITION BY e.idea_id, e.attempt_date ORDER BY e.answered_at, e.attempt_key) AS rn
           FROM pds.reading_bank_events((SELECT book_id FROM bk), NULL) e),
  firsts AS (SELECT * FROM ev WHERE rn = 1 AND grading_status = 'graded'),
  -- One row per idea and day, so the preceding rows are the earlier days: the last right answer before this one.
  gaps AS (
    SELECT f.verdict, f.attempt_date, f.round_kind,
           f.attempt_date - max(CASE WHEN f.verdict = 'correct' THEN f.attempt_date END)
                              OVER (PARTITION BY f.idea_id ORDER BY f.attempt_date ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS gap
      FROM firsts f
  ),
  delayed AS (
    SELECT g.verdict, g.gap FROM gaps g
     WHERE g.attempt_date >= (SELECT d FROM today) - 30 AND g.round_kind IS DISTINCT FROM 'checkpoint'
  )
  SELECT CASE WHEN (SELECT book_id FROM bk) IS NULL THEN NULL ELSE jsonb_build_object(
    'book_id', (SELECT book_id FROM bk),
    'today', (SELECT d FROM today),
    'enabled', COALESCE((SELECT approved_at IS NOT NULL AND paused_reason IS DISTINCT FROM 'owner' FROM bb), false),
    'paused_reason', (SELECT paused_reason FROM bb),
    'approved_cents', (SELECT approved_cents FROM bb),
    'spent_cents', COALESCE((SELECT spent_cents FROM bb), 0),
    'mapping', COALESCE((SELECT mapping FROM bb), 'unknown'),
    'quiz_through', (SELECT through FROM t),
    'due', (SELECT count(*) FROM live WHERE next_review <= (SELECT d FROM today)),
    'new_ready', (SELECT count(*) FROM live WHERE next_review IS NULL),
    'stages', (SELECT jsonb_build_object('new', count(*) FILTER (WHERE stage = 0), 'seen', count(*) FILTER (WHERE stage = 1),
                 'recalled', count(*) FILTER (WHERE stage = 2), 'explained', count(*) FILTER (WHERE stage = 3),
                 'kept', count(*) FILTER (WHERE stage = 4)) FROM live WHERE importance <> 'detail'),
    'chapters', (SELECT COALESCE(jsonb_agg(jsonb_build_object('chapter', c.chapter, 'status', c.status,
                   'ideas', CASE WHEN c.chapter <= (SELECT through FROM t) THEN c.ideas END,
                   'questions', CASE WHEN c.chapter <= (SELECT through FROM t) THEN c.questions END,
                   'sources', CASE WHEN c.chapter <= (SELECT through FROM t) THEN c.sources END) ORDER BY c.chapter), '[]'::jsonb)
                   FROM pds.reading_bank_chapters c WHERE c.book_id = (SELECT book_id FROM bk)),
    'xp', (SELECT jsonb_build_object('correct', count(*) FILTER (WHERE verdict = 'correct'),
                                     'partial', count(*) FILTER (WHERE verdict = 'partial'))
             FROM firsts WHERE round_kind IS DISTINCT FROM 'checkpoint'),
    'practice_days', (SELECT COALESCE(jsonb_agg(DISTINCT attempt_date), '[]'::jsonb) FROM firsts WHERE round_kind IS DISTINCT FROM 'checkpoint'),
    'voided', (SELECT count(*) FROM pds.reading_question_attempts a JOIN pds.reading_questions q ON q.question_id = a.question_id
                WHERE q.book_id = (SELECT book_id FROM bk) AND a.ext_hash IS NOT NULL AND a.grading_status = 'invalidated'),
    'pending', (SELECT count(*) FROM pds.reading_question_attempts a JOIN pds.reading_questions q ON q.question_id = a.question_id
                 WHERE q.book_id = (SELECT book_id FROM bk) AND a.ext_hash IS NOT NULL AND a.grading_status = 'pending'),
    'recall_7d', (SELECT jsonb_build_object('n', count(*), 'right', count(*) FILTER (WHERE verdict = 'correct')) FROM delayed WHERE gap BETWEEN 7 AND 20),
    'recall_21d', (SELECT jsonb_build_object('n', count(*), 'right', count(*) FILTER (WHERE verdict = 'correct')) FROM delayed WHERE gap >= 21)
  ) END
$fn$;

-- 21. Chapter map + one chapter's sheet (statements only for ideas asked at least once) --------------------------
CREATE OR REPLACE FUNCTION pds.reading_bank_overview(p_slug TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  WITH bk AS (SELECT b.book_id, COALESCE(b.total_chapters, 0) AS total FROM pds.books b WHERE b.book_id = pds.reading_bank_book_id(p_slug)),
  bb AS (SELECT * FROM pds.reading_bank_books WHERE book_id = (SELECT book_id FROM bk)),
  t AS (SELECT pds.reading_bank_quiz_through((SELECT book_id FROM bk)) AS through),
  cur AS (
    SELECT x.chapter, pds.reading_bank_chapter_hash((SELECT book_id FROM bk), x.chapter) AS h
      FROM (SELECT DISTINCT i.chapter FROM pds.reading_ideas i WHERE i.book_id = (SELECT book_id FROM bk) AND i.status = 'active') x
  ),
  per AS (
    SELECT i.chapter, count(*) FILTER (WHERE i.importance <> 'detail') AS ideas,
           count(*) FILTER (WHERE i.importance <> 'detail' AND COALESCE(s.stage, 0) >= 2) AS recalled,
           count(*) FILTER (WHERE i.importance = 'core') AS core,
           count(*) FILTER (WHERE i.importance = 'core' AND COALESCE(s.stage, 0) >= 3) AS core_explained,
           count(*) FILTER (WHERE s.lapses >= 2 AND s.last_reviewed >= pds.behavioral_today_now() - 7) AS lapsing
      FROM pds.reading_ideas i
      JOIN cur ON cur.chapter = i.chapter AND cur.h = i.chapter_hash
      LEFT JOIN pds.reading_idea_state s ON s.idea_id = i.idea_id
     WHERE i.book_id = (SELECT book_id FROM bk) AND i.status = 'active' AND i.unlock_chapter <= (SELECT through FROM t)
       AND pds.reading_bank_idea_supported(i.idea_id)
     GROUP BY i.chapter
  )
  SELECT CASE WHEN (SELECT book_id FROM bk) IS NULL THEN NULL ELSE jsonb_build_object(
    'book_id', (SELECT book_id FROM bk), 'quiz_through', (SELECT through FROM t), 'total_chapters', (SELECT total FROM bk),
    'enabled', COALESCE((SELECT approved_at IS NOT NULL AND paused_reason IS DISTINCT FROM 'owner' FROM bb), false),
    'approved_cents', (SELECT approved_cents FROM bb), 'spent_cents', COALESCE((SELECT spent_cents FROM bb), 0),
    'paused_reason', (SELECT paused_reason FROM bb), 'mapping', COALESCE((SELECT mapping FROM bb), 'unknown'),
    'narrative', (SELECT narrative FROM bb), 'hold_chapter', (SELECT hold_chapter FROM bb),
    -- The "Not read yet" flag behind the standing hold, so the map can offer Restore (the held chapter's own sheet
    -- is locked by that hold). The key and the chapter number only, never the question.
    'hold_flag_key', (SELECT f.flag_key FROM pds.reading_question_flags f
                        JOIN pds.reading_questions q ON q.question_id = f.question_id
                       WHERE q.book_id = (SELECT book_id FROM bk) AND f.kind = 'not_read_yet' AND f.restored_at IS NULL
                         AND f.created_at = (SELECT hold_at FROM bb)
                       ORDER BY f.created_at DESC LIMIT 1),
    'chapters', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'chapter', g.n,
        'title', CASE WHEN g.n > (SELECT through FROM t) AND COALESCE((SELECT narrative FROM bb), false) THEN NULL ELSE bc.title END,
        'locked', g.n > (SELECT through FROM t),
        'status', COALESCE(c.status, 'pending'),
        'ideas', CASE WHEN g.n <= (SELECT through FROM t) THEN COALESCE(per.ideas, 0) END,
        'recalled', CASE WHEN g.n <= (SELECT through FROM t) THEN COALESCE(per.recalled, 0) END,
        'covered', CASE WHEN g.n <= (SELECT through FROM t) THEN COALESCE(per.core, 0) > 0 AND per.core_explained = per.core END,
        'needs_review', CASE WHEN g.n <= (SELECT through FROM t) THEN COALESCE(per.lapsing, 0) > 0 END,
        'sources', CASE WHEN g.n <= (SELECT through FROM t) THEN COALESCE(c.sources, 0) END) ORDER BY g.n), '[]'::jsonb)
      FROM generate_series(1, (SELECT total FROM bk)) g(n)
      LEFT JOIN pds.book_chapters bc ON bc.book_id = (SELECT book_id FROM bk) AND bc.chapter = g.n
      LEFT JOIN pds.reading_bank_chapters c ON c.book_id = (SELECT book_id FROM bk) AND c.chapter = g.n
      LEFT JOIN per ON per.chapter = g.n)
  ) END
$fn$;

CREATE OR REPLACE FUNCTION pds.reading_bank_chapter(p_book BIGINT, p_chapter INTEGER)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  WITH t AS (SELECT pds.reading_bank_quiz_through(p_book) AS through,
                    pds.reading_bank_chapter_hash(p_book, p_chapter) AS h)
  SELECT CASE WHEN p_chapter IS NULL OR p_chapter < 0 OR p_chapter > (SELECT through FROM t)
                   OR NOT EXISTS (SELECT 1 FROM pds.books WHERE book_id = p_book) THEN NULL ELSE jsonb_build_object(
    'chapter', p_chapter,
    'title', (SELECT c.title FROM pds.book_chapters c WHERE c.book_id = p_book AND c.chapter = p_chapter),
    'status', COALESCE((SELECT c.status FROM pds.reading_bank_chapters c WHERE c.book_id = p_book AND c.chapter = p_chapter), 'pending'),
    'built_at', (SELECT c.built_at FROM pds.reading_bank_chapters c WHERE c.book_id = p_book AND c.chapter = p_chapter),
    'prompt_version', (SELECT c.prompt_version FROM pds.reading_bank_chapters c WHERE c.book_id = p_book AND c.chapter = p_chapter),
    'rebuilds', COALESCE((SELECT c.rebuilds FROM pds.reading_bank_chapters c WHERE c.book_id = p_book AND c.chapter = p_chapter), 0),
    'ideas', COALESCE((SELECT jsonb_agg(jsonb_build_object('idea_id', i.idea_id, 'title', i.title, 'importance', i.importance,
               'stage', COALESCE(s.stage, 0),
               'statement', CASE WHEN COALESCE(s.stage, 0) >= 1 THEN i.statement END,
               'sources', (SELECT count(DISTINCT COALESCE(src.domain, 'highlight')) FROM pds.reading_idea_evidence e
                             JOIN pds.reading_bank_sources src ON src.source_id = e.source_id
                             LEFT JOIN pds.book_highlights h ON h.highlight_id = src.highlight_id AND NOT h.archived
                            WHERE e.idea_id = i.idea_id
                              AND (src.kind = 'web' OR (h.highlight_id IS NOT NULL AND pds.reading_sha256(h.passage) = src.passage_sha))))
               ORDER BY CASE i.importance WHEN 'core' THEN 0 WHEN 'supporting' THEN 1 ELSE 2 END, i.idea_id)
               FROM pds.reading_ideas i LEFT JOIN pds.reading_idea_state s ON s.idea_id = i.idea_id
              WHERE i.book_id = p_book AND i.chapter = p_chapter AND i.status = 'active'
                AND i.unlock_chapter <= (SELECT through FROM t) AND i.chapter_hash = (SELECT h FROM t)
                AND pds.reading_bank_idea_supported(i.idea_id)), '[]'::jsonb),
    'flags', COALESCE((SELECT jsonb_agg(jsonb_build_object('flag_key', f.flag_key, 'kind', f.kind, 'prompt', q.prompt, 'created_at', f.created_at)
               ORDER BY f.created_at DESC)
               FROM pds.reading_question_flags f JOIN pds.reading_questions q ON q.question_id = f.question_id
              WHERE q.book_id = p_book AND q.bank_chapter = p_chapter AND f.restored_at IS NULL
                AND (q.unlock_chapter <= (SELECT through FROM t)
                     -- "Not in this chapter" moved the idea's unlock to the end of the book, which would hide the flag
                     -- (and its Restore) until the book is finished: it is listed by the unlock it was sent from. The
                     -- prompt shown is the one Riley already saw when he flagged it.
                     OR (f.kind = 'not_in_chapter' AND COALESCE(f.prev_unlock, q.bank_chapter) <= (SELECT through FROM t)))), '[]'::jsonb)
  ) END
$fn$;

-- 22. Status counts for /api/status (no text) ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.reading_bank_status()
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  SELECT jsonb_build_object(
    'approved_books', (SELECT count(*) FROM pds.reading_bank_books WHERE approved_at IS NOT NULL AND paused_reason IS DISTINCT FROM 'owner'),
    'paused_budget',  (SELECT count(*) FROM pds.reading_bank_books WHERE paused_reason = 'budget'),
    'uncertain',      (SELECT count(*) FROM pds.reading_bank_books WHERE approved_at IS NOT NULL AND mapping = 'uncertain'),
    'queued',         (SELECT count(*) FROM pds.reading_bank_jobs WHERE status IN ('queued', 'running')),
    'failed_24h',     (SELECT count(*) FROM pds.reading_bank_jobs WHERE status = 'failed' AND finished_at > NOW() - interval '24 hours'),
    'lagging_6h',     (SELECT count(*) FROM pds.reading_bank_chapters c JOIN pds.reading_bank_books b ON b.book_id = c.book_id
                        WHERE b.approved_at IS NOT NULL AND b.paused_at IS NULL AND c.status IN ('pending', 'failed')
                          AND c.quizzable_at < NOW() - interval '6 hours'),
    'lagging_24h',    (SELECT count(*) FROM pds.reading_bank_chapters c JOIN pds.reading_bank_books b ON b.book_id = c.book_id
                        WHERE b.approved_at IS NOT NULL AND b.paused_at IS NULL AND c.status IN ('pending', 'failed')
                          AND c.quizzable_at < NOW() - interval '24 hours'),
    'pending_grades', (SELECT count(*) FROM pds.reading_question_attempts WHERE ext_hash IS NOT NULL AND grading_status = 'pending'),
    'month_cents',    (SELECT COALESCE(sum(cost_cents), 0) FROM pds.reading_bank_jobs
                        WHERE charged_at >= (date_trunc('month', NOW() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')),
    'schema',         pds.reading_bank_schema_ok())
$fn$;

-- 23. Planner input (one read for lib/reading-bank.ts planBankJobs; book details + structure, never highlight text)
CREATE OR REPLACE FUNCTION pds.reading_bank_plan_input(p_book BIGINT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
  WITH bk AS (SELECT book_id, title, author, COALESCE(total_chapters, 0) AS total, status FROM pds.books WHERE book_id = p_book),
  bb AS (SELECT * FROM pds.reading_bank_books WHERE book_id = p_book)
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM bk) THEN NULL ELSE jsonb_build_object(
    'book_id', p_book, 'title', (SELECT title FROM bk), 'author', (SELECT author FROM bk),
    'total_chapters', (SELECT total FROM bk), 'status', (SELECT status FROM bk),
    'approved', COALESCE((SELECT approved_at IS NOT NULL FROM bb), false),
    'paused_reason', (SELECT paused_reason FROM bb),
    'mapping', COALESCE((SELECT mapping FROM bb), 'unknown'), 'narrative', (SELECT narrative FROM bb),
    'map_urls', COALESCE((SELECT map_urls FROM bb), '[]'::jsonb), 'toc_hash_stored', (SELECT toc_hash FROM bb),
    'map_rebuilds', COALESCE((SELECT map_rebuilds FROM bb), 0),
    'toc_hash', pds.reading_bank_toc_hash(p_book), 'quiz_through', pds.reading_bank_quiz_through(p_book),
    'chapter0_hash', pds.reading_bank_chapter_hash(p_book, 0),
    'chapters', COALESCE((SELECT jsonb_agg(jsonb_build_object('chapter', c.chapter, 'title', c.title, 'start_page', c.start_page,
                   'end_page', c.end_page, 'chapter_hash', pds.reading_bank_chapter_hash(p_book, c.chapter)) ORDER BY c.chapter)
                   FROM pds.book_chapters c WHERE c.book_id = p_book), '[]'::jsonb),
    'bank', COALESCE((SELECT jsonb_agg(jsonb_build_object('chapter', c.chapter, 'status', c.status, 'chapter_hash', c.chapter_hash,
                'rebuilds', c.rebuilds, 'built_rebuilds', c.built_rebuilds, 'built_at', c.built_at,
                'quizzable_since', c.quizzable_since) ORDER BY c.chapter)
                FROM pds.reading_bank_chapters c WHERE c.book_id = p_book), '[]'::jsonb),
    'jobs', COALESCE((SELECT jsonb_agg(jsonb_build_object('job_id', j.job_id, 'step', j.step, 'chapter', j.chapter,
                'input_hash', j.input_hash, 'status', j.status, 'result', j.result) ORDER BY j.job_id)
                FROM pds.reading_bank_jobs j WHERE j.book_id = p_book AND j.step <> 'grade'), '[]'::jsonb),
    -- Highlights to offer the highlights step: live, not cited by an active idea for their current passage, and whose
    -- current content (id + sha256 of the passage) no build or highlights job has looked at yet. Freshness is keyed
    -- on content, never on a row timestamp (a review or a Kindle re-import touches the row and must cost nothing);
    -- an edited passage is new content, so an edited highlight (linked or not) is offered again.
    'highlights', COALESCE((SELECT jsonb_agg(jsonb_build_object('highlight_id', x.highlight_id, 'chapter', x.chapter,
                'passage_sha', x.sha) ORDER BY x.highlight_id)
                FROM (SELECT h.highlight_id, h.chapter, pds.reading_sha256(h.passage) AS sha
                        FROM pds.book_highlights h WHERE h.book_id = p_book AND NOT h.archived) x
               WHERE NOT EXISTS (SELECT 1 FROM pds.reading_bank_highlight_seen sn
                                  WHERE sn.highlight_id = x.highlight_id AND sn.passage_sha = x.sha)
                 AND NOT EXISTS (SELECT 1 FROM pds.reading_bank_sources src
                                   JOIN pds.reading_idea_evidence e ON e.source_id = src.source_id
                                   JOIN pds.reading_ideas i ON i.idea_id = e.idea_id AND i.status = 'active'
                                  WHERE src.highlight_id = x.highlight_id AND src.passage_sha = x.sha)), '[]'::jsonb)
  ) END
$fn$;

-- 24. Queue: enqueue, claim (reserves cost), finish, approval, the source map, the rebuild counter --------------
-- p: {book_id, jobs: [{step, chapter, input_hash, prompt_version, priority}], quizzable: [chapter], skip_jobs: [job_id]}
-- A chapter is recorded as quizzable only when it is at or below pds.reading_bank_quiz_through (the planner's word
-- is not enough), and its first quizzable day is never moved later.
-- A planned job that exists already is left as it is, except: one skipped earlier is queued again, and one that
-- failed with web_search_disabled at least 6 hours ago is tried again (Riley turns web search on in the Console;
-- that refusal is a 400 before any token, so the retry costs nothing while it is still off). Any other failure
-- waits for Riley's Rebuild (a new rebuild count = a new job hash; for the source map, chapter 0's book-level
-- Rebuild: pds.reading_bank_rebuild).
-- A re-queue resets the tries used (attempts) and leaves claim_seq alone: a worker that held the job before can
-- never match a later claim (see the header).
-- Every call also brings the book's chapter recall rubrics in step with their ideas (pds.reading_bank_recall_sync).
CREATE OR REPLACE FUNCTION pds.reading_bank_enqueue(p JSONB)
RETURNS INTEGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE v_book BIGINT := (p->>'book_id')::bigint; v_n INTEGER; v_through INTEGER;
BEGIN
  IF v_book IS NULL OR NOT EXISTS (SELECT 1 FROM pds.books WHERE book_id = v_book) THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'));
  -- The recall sync first: it takes the practice lock, and taking it before this function locks any job row keeps
  -- one lock order everywhere (claim lock, then practice lock, then rows), so a store (practice lock, then its job
  -- row) and an enqueue can never wait on each other.
  PERFORM pds.reading_bank_recall_sync(v_book);
  v_through := pds.reading_bank_quiz_through(v_book);
  INSERT INTO pds.reading_bank_chapters AS c (book_id, chapter, quizzable_since, quizzable_at)
  SELECT v_book, q::int, pds.behavioral_today_now(), NOW()
    FROM jsonb_array_elements_text(COALESCE(p->'quizzable', '[]'::jsonb)) q
   WHERE q::int BETWEEN 1 AND v_through
  ON CONFLICT (book_id, chapter) DO UPDATE SET
    quizzable_since = COALESCE(c.quizzable_since, EXCLUDED.quizzable_since),
    quizzable_at = COALESCE(c.quizzable_at, EXCLUDED.quizzable_at);
  UPDATE pds.reading_bank_jobs SET status = 'skipped', finished_at = NOW()
   WHERE book_id = v_book AND status = 'queued' AND step <> 'grade'
     AND job_id IN (SELECT j::bigint FROM jsonb_array_elements_text(COALESCE(p->'skip_jobs', '[]'::jsonb)) j);
  -- A job skipped earlier (its chapter left the planning window, e.g. under a hold) is queued again when planned again.
  -- Its cost_cents and charged_at stay as they were: what it already spent keeps counting in its month.
  -- finished_at is left as it is: it dates the charge in cost_cents, which this month's spend is summed from, so a job
  -- that was charged earlier (a retry, then a refusal at a cap) keeps counting toward the monthly cap when it is queued
  -- again (clearing it let that spend fall out of the month's sum and reopened the headroom).
  INSERT INTO pds.reading_bank_jobs AS jb (book_id, step, chapter, input_hash, prompt_version, priority)
  SELECT v_book, j->>'step', (j->>'chapter')::int, j->>'input_hash', j->>'prompt_version', COALESCE((j->>'priority')::int, 100)
    FROM jsonb_array_elements(COALESCE(p->'jobs', '[]'::jsonb)) j
   WHERE j->>'step' IN ('map', 'research', 'build', 'highlights')
  ON CONFLICT (book_id, step, chapter, input_hash) DO UPDATE
     SET status = 'queued', attempts = 0, next_attempt_at = NOW(), error_code = NULL, priority = EXCLUDED.priority
   WHERE jb.status = 'skipped'
      OR (jb.status = 'failed' AND jb.error_code = 'web_search_disabled' AND jb.finished_at < NOW() - interval '6 hours');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $fn$;

-- p: {lease_seconds, month_cap_cents, estimates: {step: cents}, bounds?: {step: cents}, job_id?, steps?: [step]}
-- -> {ok, job, headroom_cents} (the claimed job, or null with code 'monthly_cap' | 'budget' when spending stops it)
-- estimates = what a claimed job reserves up front. bounds (optional) = the most its FIRST model request can cost
-- (lib/reading-model.ts requestBoundCents, which is several times the estimate): a job whose bound does not fit
-- under a cap is refused here with the code, and the book pause, that pds.reading_bank_reserve would give it one
-- request later, instead of being claimed, refused and finished. Without bounds the estimate is the test.
-- Every claim makes claim_seq one larger (the answer's job row carries it with attempts).
-- A running job whose lease ran out (a crash, a function stopped at its maxDuration) most likely made a billed
-- call that never reported: its reservation is CHARGED (cost_cents, this month's spend and, for generation, the
-- book's spent_cents) before the job is offered again, or failed after 3 attempts, so neither cap leaks. A late
-- finish from that run is refused (not_running / lease_lost), so the charge is never doubled.
-- A claimed job whose store_receipt is set has stored its batch already (its earlier run stopped before finish):
-- the worker finishes it without a new model call.
-- A queued grade job whose answer is no longer pending (graded inline by the chat tool, self graded, voided by a
-- flag) is marked skipped and never claimed, so no model grade is paid for (and no answer sent) a second time.
-- Every running job's reservation counts against both caps until its lease is settled here, an expired one included.
-- headroom_cents = what the claimed job may spend in all, its reservation included, before a cap is reached (the
-- smaller of the monthly and, for generation, the book's): bankModelCall's maxCostCents for a caller with no
-- `reserve`. A worker that reserves leaves it out: pds.reading_bank_reserve counts every running job live and is the
-- only gate that also pauses the book at its cap.
CREATE OR REPLACE FUNCTION pds.reading_bank_claim(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_job   pds.reading_bank_jobs%ROWTYPE;
  v_exp   RECORD;
  v_head  NUMERIC;
  v_jid   BIGINT := NULLIF(p->>'job_id', '')::bigint;
  v_lease INTEGER := LEAST(GREATEST(COALESCE(NULLIF(p->>'lease_seconds', '')::int, 300), 30), 1800);
  v_capm  NUMERIC := COALESCE(NULLIF(p->>'month_cap_cents', '')::numeric, 3000);
  v_est   NUMERIC;
  v_need  NUMERIC;
  v_month NUMERIC;
  v_used  NUMERIC;
  v_cap   INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'));
  FOR v_exp IN SELECT j.job_id, j.book_id, j.step, j.chapter, j.attempts, j.reserved_cents, j.attempt_key
                 FROM pds.reading_bank_jobs j WHERE j.status = 'running' AND j.lease_until < NOW() FOR UPDATE LOOP
    UPDATE pds.reading_bank_jobs
       SET status = CASE WHEN v_exp.attempts >= 3 THEN 'failed' ELSE 'queued' END, error_code = 'lease_expired',
           lease_until = NULL, cost_cents = cost_cents + reserved_cents, reserved_cents = 0,
           charged_at = CASE WHEN reserved_cents > 0 THEN NOW() ELSE charged_at END,   -- the month's spend reads this
           finished_at = NOW()
     WHERE job_id = v_exp.job_id;
    IF v_exp.step <> 'grade' AND v_exp.reserved_cents > 0 THEN
      UPDATE pds.reading_bank_books SET spent_cents = spent_cents + v_exp.reserved_cents, updated_at = NOW() WHERE book_id = v_exp.book_id;
    END IF;
    IF v_exp.attempts >= 3 AND v_exp.step = 'grade' THEN
      UPDATE pds.reading_question_attempts SET grade_tries = grade_tries + 1, grade_error = 'lease_expired'
       WHERE attempt_key = v_exp.attempt_key;
    ELSIF v_exp.attempts >= 3 AND v_exp.step IN ('build', 'research') THEN
      INSERT INTO pds.reading_bank_chapters AS c (book_id, chapter, status) VALUES (v_exp.book_id, v_exp.chapter, 'failed')
      ON CONFLICT (book_id, chapter) DO UPDATE SET status = CASE WHEN c.status = 'pending' THEN 'failed' ELSE c.status END;
    END IF;
  END LOOP;
  UPDATE pds.reading_bank_jobs j SET status = 'skipped', finished_at = NOW(), error_code = 'not_pending'
   WHERE j.step = 'grade' AND j.status = 'queued'
     AND NOT EXISTS (SELECT 1 FROM pds.reading_question_attempts a WHERE a.attempt_key = j.attempt_key AND a.grading_status = 'pending');
  SELECT j.* INTO v_job FROM pds.reading_bank_jobs j
   WHERE (v_jid IS NULL OR j.job_id = v_jid)
     AND j.status = 'queued'
     AND j.next_attempt_at <= NOW()
     AND (p->'steps' IS NULL OR j.step IN (SELECT jsonb_array_elements_text(p->'steps')))
     AND (j.step = 'grade' OR EXISTS (SELECT 1 FROM pds.reading_bank_books b WHERE b.book_id = j.book_id AND b.approved_at IS NOT NULL AND b.paused_at IS NULL))
     AND (j.step = 'grade' OR NOT EXISTS (SELECT 1 FROM pds.reading_bank_jobs r WHERE r.book_id = j.book_id AND r.step <> 'grade'
                                             AND r.status = 'running' AND r.lease_until >= NOW()))
   ORDER BY j.priority, j.created_at, j.job_id
   LIMIT 1 FOR UPDATE OF j SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'job', NULL); END IF;
  v_est := GREATEST(COALESCE((p->'estimates'->>v_job.step)::numeric, 50), 0);
  v_need := GREATEST(v_est, LEAST(GREATEST(COALESCE(NULLIF(p->'bounds'->>v_job.step, '')::numeric, 0), 0), 100000));
  SELECT COALESCE(sum(cost_cents) FILTER (WHERE charged_at >= (date_trunc('month', NOW() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')), 0)
       + COALESCE(sum(reserved_cents) FILTER (WHERE status = 'running'), 0)
    INTO v_month FROM pds.reading_bank_jobs;
  IF v_month + v_need > v_capm THEN
    RETURN jsonb_build_object('ok', true, 'job', NULL, 'code', 'monthly_cap');
  END IF;
  v_head := v_capm - v_month;
  IF v_job.step <> 'grade' THEN
    SELECT b.spent_cents + COALESCE((SELECT sum(r.reserved_cents) FROM pds.reading_bank_jobs r
                                      WHERE r.book_id = b.book_id AND r.status = 'running'), 0),
           b.approved_cents
      INTO v_used, v_cap FROM pds.reading_bank_books b WHERE b.book_id = v_job.book_id FOR UPDATE;
    IF v_cap IS NULL OR v_used + v_need > v_cap THEN
      UPDATE pds.reading_bank_books SET paused_at = NOW(), paused_reason = 'budget', updated_at = NOW()
       WHERE book_id = v_job.book_id AND paused_at IS NULL;
      RETURN jsonb_build_object('ok', true, 'job', NULL, 'code', 'budget', 'book_id', v_job.book_id);
    END IF;
    v_head := LEAST(v_head, v_cap - v_used);
  END IF;
  UPDATE pds.reading_bank_jobs
     SET status = 'running', attempts = attempts + 1, claim_seq = claim_seq + 1, started_at = NOW(),
         lease_until = NOW() + make_interval(secs => v_lease), reserved_cents = v_est
   WHERE job_id = v_job.job_id RETURNING * INTO v_job;
  RETURN jsonb_build_object('ok', true, 'job', to_jsonb(v_job), 'headroom_cents', GREATEST(v_head, v_est));
END $fn$;

-- p: {job_id, attempts, claim_seq, total_cents, month_cap_cents}
-- Before every model request (lib/reading-model.ts bankModelCall's `reserve`): raises the running job's reservation
-- to total_cents, the most the job may have spent once that request is done (what it spent so far plus a
-- conservative bound on the request), when both caps still allow it with every other running job's reservation
-- counted, in one step under the claim lock. So two jobs that run at once cannot each spend the same headroom, and
-- no request is sent that could pass a cap by more than its bound misjudges. A smaller total changes nothing.
-- Every running job's reservation counts until the next claim settles its lease, an expired one included: an
-- expired lease is billed work not yet charged, so it must not free its headroom to a job that starts meanwhile.
-- A generation job also needs its book still ON: a book turned off by Riley (paused 'owner') or stopped at its cap
-- (paused 'budget') refuses every further request, a total no larger than the reservation included, so turning a
-- book off stops a job that already holds a claim at its next request.
-- -> {ok, reserved_cents}, or {ok: false, code: 'monthly_cap' | 'budget' (the book is paused, as at claim) |
--    'paused' (the book is off) | 'not_running' | 'lease_lost'}: the worker then sends nothing and finishes the job
--    as skipped (queued again when planned again) or as a retry carrying that code with no cost, which does not use
--    up a try (reading_bank_finish).
CREATE OR REPLACE FUNCTION pds.reading_bank_reserve(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_job   pds.reading_bank_jobs%ROWTYPE;
  v_bk    pds.reading_bank_books%ROWTYPE;
  v_total NUMERIC;
  v_att   INTEGER;
  v_seq   BIGINT;
  v_capm  NUMERIC;
  v_delta NUMERIC;
  v_month NUMERIC;
  v_used  NUMERIC;
BEGIN
  BEGIN
    v_total := round((p->>'total_cents')::numeric, 2);
    v_att := NULLIF(p->>'attempts', '')::int;
    v_seq := NULLIF(p->>'claim_seq', '')::bigint;
    v_capm := COALESCE(NULLIF(p->>'month_cap_cents', '')::numeric, 3000);
  EXCEPTION WHEN others THEN RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request'); END;
  IF v_total IS NULL OR v_total < 0 OR v_total > 100000 OR v_att IS NULL OR v_seq IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'));
  SELECT * INTO v_job FROM pds.reading_bank_jobs WHERE job_id = (p->>'job_id')::bigint FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;
  IF v_job.status <> 'running' OR v_job.lease_until IS NULL OR v_job.lease_until < NOW() THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'not_running');
  END IF;
  IF v_att <> v_job.attempts OR v_seq <> v_job.claim_seq THEN RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'lease_lost'); END IF;
  IF v_job.step <> 'grade' THEN
    SELECT * INTO v_bk FROM pds.reading_bank_books WHERE book_id = v_job.book_id FOR UPDATE;
    IF NOT FOUND OR v_bk.approved_at IS NULL OR v_bk.paused_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'book_id', v_job.book_id,
                                'code', CASE WHEN v_bk.paused_reason = 'budget' THEN 'budget' ELSE 'paused' END);
    END IF;
  END IF;
  IF v_total <= v_job.reserved_cents THEN RETURN jsonb_build_object('ok', true, 'reserved_cents', v_job.reserved_cents); END IF;
  v_delta := v_total - v_job.reserved_cents;
  SELECT COALESCE(sum(cost_cents) FILTER (WHERE charged_at >= (date_trunc('month', NOW() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')), 0)
       + COALESCE(sum(reserved_cents) FILTER (WHERE status = 'running'), 0)
    INTO v_month FROM pds.reading_bank_jobs;
  IF v_month + v_delta > v_capm THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'monthly_cap');
  END IF;
  IF v_job.step <> 'grade' THEN
    SELECT v_bk.spent_cents + COALESCE((SELECT sum(r.reserved_cents) FROM pds.reading_bank_jobs r
                                         WHERE r.book_id = v_bk.book_id AND r.status = 'running'), 0)
      INTO v_used;
    IF v_bk.approved_cents IS NULL OR v_used + v_delta > v_bk.approved_cents THEN
      UPDATE pds.reading_bank_books SET paused_at = NOW(), paused_reason = 'budget', updated_at = NOW()
       WHERE book_id = v_job.book_id AND paused_at IS NULL;
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'budget', 'book_id', v_job.book_id);
    END IF;
  END IF;
  UPDATE pds.reading_bank_jobs SET reserved_cents = v_total WHERE job_id = v_job.job_id;
  RETURN jsonb_build_object('ok', true, 'reserved_cents', v_total);
END $fn$;

-- p: {job_id, attempts, claim_seq, outcome: 'done'|'retry'|'failed'|'skipped', cost_cents, usage?, result?, counts?,
--     output?, error_code?, retry_minutes?}
-- attempts + claim_seq (both required) = the numbers the claim answered: a worker whose lease ran out answers 409
-- not_running (its reservation was charged when the lease was settled) or, once another worker claimed the job
-- again, 409 lease_lost, instead of finishing the other worker's run.
-- A refusal to spend is not a failed try: a retry whose error_code is cost_limit, monthly_cap, budget or paused and
-- whose cost_cents is 0 (nothing was billed, so nothing is lost by waiting) puts the job back in the queue and gives
-- the try back, so no number of refusals ever fails the job or its chapter or counts as a grade try. The worker's
-- other choice for such a refusal is 'skipped', which the planner queues again when it plans the job again. A retry
-- that did bill something still uses up its try, so a request that always stops half way cannot repeat for ever.
CREATE OR REPLACE FUNCTION pds.reading_bank_finish(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_job   pds.reading_bank_jobs%ROWTYPE;
  v_out   TEXT := p->>'outcome';
  v_cost  NUMERIC;
  v_att   INTEGER;
  v_seq   BIGINT;
  v_defer BOOLEAN;
BEGIN
  BEGIN
    v_cost := COALESCE((p->>'cost_cents')::numeric, 0);
    v_att := NULLIF(p->>'attempts', '')::int;
    v_seq := NULLIF(p->>'claim_seq', '')::bigint;
  EXCEPTION WHEN others THEN RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request'); END;
  IF v_out IS NULL OR v_out NOT IN ('done', 'retry', 'failed', 'skipped') OR v_cost < 0 OR v_att IS NULL OR v_seq IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'));
  SELECT * INTO v_job FROM pds.reading_bank_jobs WHERE job_id = (p->>'job_id')::bigint FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;
  IF v_job.status <> 'running' THEN RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'not_running'); END IF;
  IF v_att <> v_job.attempts OR v_seq <> v_job.claim_seq THEN RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'lease_lost'); END IF;
  v_defer := v_out = 'retry' AND v_cost = 0 AND COALESCE(p->>'error_code', '') IN ('cost_limit', 'monthly_cap', 'budget', 'paused');
  UPDATE pds.reading_bank_jobs SET
    status = CASE v_out WHEN 'retry' THEN CASE WHEN attempts >= 3 AND NOT v_defer THEN 'failed' ELSE 'queued' END ELSE v_out END,
    attempts = CASE WHEN v_defer THEN GREATEST(attempts - 1, 0) ELSE attempts END,
    next_attempt_at = CASE WHEN v_out = 'retry' THEN NOW() + make_interval(mins => LEAST(GREATEST(COALESCE((p->>'retry_minutes')::int, 30), 1), 1440)) ELSE next_attempt_at END,
    lease_until = NULL, reserved_cents = 0, cost_cents = cost_cents + v_cost,
    charged_at = CASE WHEN v_cost > 0 THEN NOW() ELSE charged_at END,   -- the month's spend reads this, whatever the outcome
    usage = COALESCE(p->'usage', usage), result = COALESCE(p->>'result', result), counts = COALESCE(p->'counts', counts),
    output = COALESCE(p->'output', output), error_code = p->>'error_code',
    finished_at = NOW()
   WHERE job_id = v_job.job_id RETURNING * INTO v_job;
  IF v_job.step <> 'grade' AND v_cost > 0 THEN
    UPDATE pds.reading_bank_books SET spent_cents = spent_cents + v_cost, updated_at = NOW() WHERE book_id = v_job.book_id;
  END IF;
  IF v_job.step = 'grade' AND v_out <> 'done' AND NOT v_defer THEN
    UPDATE pds.reading_question_attempts SET grade_tries = grade_tries + 1, grade_error = p->>'error_code'
     WHERE attempt_key = v_job.attempt_key;
  END IF;
  IF v_job.step IN ('build', 'research') AND v_job.status = 'failed' THEN
    INSERT INTO pds.reading_bank_chapters AS c (book_id, chapter, status) VALUES (v_job.book_id, v_job.chapter, 'failed')
    ON CONFLICT (book_id, chapter) DO UPDATE SET status = CASE WHEN c.status = 'pending' THEN 'failed' ELSE c.status END;
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_job.status);
END $fn$;

-- p: {book_id, on: bool, cap_cents}. Turning a book on is Riley's spending approval for it (the cap is checked
-- against the server's estimate by the route; here only its bounds). Turning it off keeps every stored row.
CREATE OR REPLACE FUNCTION pds.reading_bank_approve(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE v_book BIGINT; v_on BOOLEAN; v_cap INTEGER;
BEGIN
  BEGIN
    v_book := (p->>'book_id')::bigint;
    v_on := COALESCE((p->>'on')::boolean, false);
    v_cap := NULLIF(p->>'cap_cents', '')::int;
  EXCEPTION WHEN others THEN RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request'); END;
  IF v_book IS NULL OR NOT EXISTS (SELECT 1 FROM pds.books WHERE book_id = v_book) THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'book_not_found');
  END IF;
  IF v_on AND (v_cap IS NULL OR v_cap < 100 OR v_cap > 2500) THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_cap');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'));
  INSERT INTO pds.reading_bank_books AS b (book_id, approved_at, approved_cents, paused_at, paused_reason)
  VALUES (v_book, CASE WHEN v_on THEN NOW() END, CASE WHEN v_on THEN v_cap END,
          CASE WHEN v_on THEN NULL ELSE NOW() END, CASE WHEN v_on THEN NULL ELSE 'owner' END)
  ON CONFLICT (book_id) DO UPDATE SET
    approved_at    = CASE WHEN v_on THEN NOW() ELSE b.approved_at END,
    approved_cents = CASE WHEN v_on THEN v_cap ELSE b.approved_cents END,
    paused_at      = CASE WHEN v_on THEN NULL ELSE NOW() END,
    paused_reason  = CASE WHEN v_on THEN NULL ELSE 'owner' END,
    updated_at     = NOW();
  RETURN jsonb_build_object('ok', true, 'on', v_on, 'cap_cents', v_cap);
END $fn$;

-- p: {job_id, attempts, claim_seq, book_id, mapping, narrative, source_chapter_count, map_urls, toc_hash}
-- Only the run that holds the live lease of the book's map job writes the map (as reserve, finish and store fence it):
-- the job must be the book's 'map' job, running with an unexpired lease and the attempt and claim the caller was
-- given, otherwise 409 job_mismatch / not_running / lease_lost and nothing is written, so a worker that ran
-- out of time can never overwrite what a later run mapped. A map made for a table of contents the book no longer has
-- (toc_hash is not pds.reading_bank_toc_hash now) is not written either: the answer is {ok: true, stored: false,
-- code: 'toc_changed'}, the planner then queues the map for the new table of contents (its hash names it), and the
-- worker finishes the job as it would after a store, without a retry that would only repeat the stale result.
CREATE OR REPLACE FUNCTION pds.reading_bank_set_map(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE
  v_job  pds.reading_bank_jobs%ROWTYPE;
  v_jid  BIGINT;
  v_book BIGINT;
  v_att  INTEGER;
  v_seq  BIGINT;
  v_toc  TEXT;
BEGIN
  BEGIN
    v_jid := NULLIF(p->>'job_id', '')::bigint;
    v_book := (p->>'book_id')::bigint;
    v_att := NULLIF(p->>'attempts', '')::int;
    v_seq := NULLIF(p->>'claim_seq', '')::bigint;
    v_toc := NULLIF(p->>'toc_hash', '');
  EXCEPTION WHEN others THEN RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request'); END;
  IF v_book IS NULL OR v_jid IS NULL OR v_att IS NULL OR v_seq IS NULL
     OR COALESCE(p->>'mapping', '') NOT IN ('unknown', 'ok', 'uncertain')
     OR (p->'map_urls' IS NOT NULL AND jsonb_typeof(p->'map_urls') <> 'array')
     OR (v_toc IS NOT NULL AND v_toc !~ '^[0-9a-f]{64}$') THEN
    RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'));
  SELECT * INTO v_job FROM pds.reading_bank_jobs WHERE job_id = v_jid FOR UPDATE;
  IF NOT FOUND OR v_job.book_id <> v_book OR v_job.step <> 'map' THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'job_mismatch');
  END IF;
  IF v_job.status <> 'running' OR v_job.lease_until IS NULL OR v_job.lease_until < NOW() THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'not_running');
  END IF;
  IF v_att <> v_job.attempts OR v_seq <> v_job.claim_seq THEN
    RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'lease_lost');
  END IF;
  IF v_toc IS NOT NULL AND v_toc <> pds.reading_bank_toc_hash(v_book) THEN
    RETURN jsonb_build_object('ok', true, 'stored', false, 'code', 'toc_changed');
  END IF;
  UPDATE pds.reading_bank_books
     SET mapping = p->>'mapping', narrative = NULLIF(p->>'narrative', '')::boolean,
         source_chapter_count = NULLIF(p->>'source_chapter_count', '')::int,
         map_urls = COALESCE(p->'map_urls', '[]'::jsonb), toc_hash = v_toc, updated_at = NOW()
   WHERE book_id = v_book;
  RETURN jsonb_build_object('ok', FOUND, 'stored', FOUND);
END $fn$;

-- p: {book_id, chapter}. "Rebuild chapter": a new rebuild count makes new job hashes, so the planner queues a fresh
-- research + build; the stored ideas stay served until the rebuilt batch replaces them. Chapter 0 (or no chapter)
-- is the book level: it also counts a map rebuild (part of the map job's hash), so a source map that failed
-- (refusal, bad output, an expired lease, web search off) is tried again, and the whole-book build with it.
CREATE OR REPLACE FUNCTION pds.reading_bank_rebuild(p JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path = pds, pg_temp AS $fn$
DECLARE v_book BIGINT; v_ch INTEGER; v_n INTEGER; v_m INTEGER;
BEGIN
  BEGIN
    v_book := (p->>'book_id')::bigint;
    v_ch := COALESCE(NULLIF(p->>'chapter', '')::int, 0);
  EXCEPTION WHEN others THEN RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request'); END;
  IF v_book IS NULL OR v_ch IS NULL OR v_ch < 0 THEN RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pds.books WHERE book_id = v_book) THEN
    RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'book_not_found');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'));
  INSERT INTO pds.reading_bank_chapters AS c (book_id, chapter, rebuilds) VALUES (v_book, v_ch, 1)
  ON CONFLICT (book_id, chapter) DO UPDATE SET rebuilds = c.rebuilds + 1
  RETURNING rebuilds INTO v_n;
  IF v_ch = 0 THEN
    INSERT INTO pds.reading_bank_books AS b (book_id, map_rebuilds) VALUES (v_book, 1)
    ON CONFLICT (book_id) DO UPDATE SET map_rebuilds = b.map_rebuilds + 1, updated_at = NOW()
    RETURNING map_rebuilds INTO v_m;
  END IF;
  RETURN jsonb_build_object('ok', true, 'chapter', v_ch, 'rebuilds', v_n, 'map_rebuilds', v_m);
END $fn$;

-- 25. Access: every table and function is service_role only ----------------------------------------------------------
ALTER TABLE pds.reading_bank_books     ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.reading_bank_chapters  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.reading_bank_sources   ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.reading_ideas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.reading_idea_evidence  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.reading_idea_state     ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.reading_bank_jobs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.reading_question_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.reading_bank_highlight_seen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.reading_bank_books, pds.reading_bank_chapters, pds.reading_bank_sources, pds.reading_ideas,
              pds.reading_idea_evidence, pds.reading_idea_state, pds.reading_bank_jobs, pds.reading_question_flags,
              pds.reading_bank_highlight_seen
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON pds.reading_bank_books, pds.reading_bank_chapters, pds.reading_bank_sources, pds.reading_ideas,
              pds.reading_idea_evidence, pds.reading_idea_state, pds.reading_bank_jobs, pds.reading_question_flags,
              pds.reading_bank_highlight_seen TO service_role;
GRANT USAGE, SELECT ON SEQUENCE pds.reading_bank_sources_source_id_seq, pds.reading_ideas_idea_id_seq, pds.reading_bank_jobs_job_id_seq TO service_role;

DO $grants$
DECLARE f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'pds.reading_ideas_guard()', 'pds.reading_bank_attempt_guard()', 'pds.reading_bank_question_guard()',
    'pds.reading_bank_book_id(text)', 'pds.reading_bank_chapter_hash(bigint,integer)',
    'pds.reading_bank_toc_hash(bigint)', 'pds.reading_bank_quiz_through(bigint)', 'pds.reading_bank_end_chapter(bigint)',
    'pds.reading_source_text(bigint,text,bigint)',
    'pds.reading_bank_schema_ok()', 'pds.reading_bank_idea_supported(bigint)',
    'pds.reading_bank_recall_valid(text,bigint,integer)', 'pds.reading_bank_question_open(bigint,integer)',
    'pds.reading_questions_export(bigint)',
    'pds.reading_bank_states_ok(jsonb)', 'pds.reading_bank_states_write(jsonb)', 'pds.reading_bank_touch_states(bigint[],boolean)',
    'pds.reading_bank_write_states(jsonb)', 'pds.reading_bank_receipt(uuid)', 'pds.reading_bank_recall_rubric(bigint,integer)',
    'pds.reading_bank_recall_refresh(bigint,integer,bigint,text,text,boolean,boolean)', 'pds.reading_bank_recall_sync(bigint)',
    'pds.reading_bank_store(jsonb)',
    'pds.reading_bank_attempt(jsonb)', 'pds.reading_bank_grade(jsonb)', 'pds.reading_bank_override(jsonb)',
    'pds.reading_bank_flag(jsonb)', 'pds.reading_bank_events(bigint,bigint[])', 'pds.reading_bank_deck(bigint,date,integer)',
    'pds.reading_bank_round(text,integer)', 'pds.reading_bank_summary(text)', 'pds.reading_bank_overview(text)',
    'pds.reading_bank_chapter(bigint,integer)', 'pds.reading_bank_status()', 'pds.reading_bank_plan_input(bigint)',
    'pds.reading_bank_enqueue(jsonb)', 'pds.reading_bank_claim(jsonb)', 'pds.reading_bank_reserve(jsonb)', 'pds.reading_bank_finish(jsonb)',
    'pds.reading_bank_approve(jsonb)', 'pds.reading_bank_set_map(jsonb)', 'pds.reading_bank_rebuild(jsonb)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $grants$;

COMMENT ON TABLE pds.reading_ideas IS
  'READ-QUIZ-01: one idea of a chapter in Onyx''s words, tied to stored evidence; immutable; service_role only.';
COMMENT ON TABLE pds.reading_bank_jobs IS
  'READ-QUIZ-01: generation / grading queue and model-spend ledger (cost reserved at claim); service_role only.';
COMMENT ON TABLE pds.reading_bank_sources IS
  'READ-QUIZ-01: evidence for ideas: an API web citation snippet (<= 300 characters, never a page) or a highlight reference; service_role only.';
COMMENT ON FUNCTION pds.reading_bank_quiz_through(BIGINT) IS
  'READ-QUIZ-01: the highest chapter that may be quizzed (the spoiler gate every bank read and the attempt function apply).';
