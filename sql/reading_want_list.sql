-- ============================================================
-- Onyx — Reading "Want to read" list (PROD-READLIST-01, 2026-11-16)
-- ============================================================
-- The list is pds.books rows with the existing status 'queued'. No new table
-- of books: a planned book is an ordinary books row, so starting it keeps its
-- book_id, slug, highlights and history (status 'queued' -> 'reading' only).
--
-- Every list change goes through ONE function, pds.reading_list_apply(jsonb),
-- which runs in a single transaction under one advisory lock for the whole
-- list: the duplicate check and the insert, a reorder's renumbering and swap,
-- and the operation record either all happen or none do, and list changes
-- never interleave. pds.reading_list_ops records each applied operation by its
-- client key with a hash of its normalized payload: the same key + payload is
-- answered from the record, the same key with another payload is refused.
--
-- Additive only: four columns (nullable, or an integer with a default), one
-- new table, one index, one check constraint, one function. Existing rows are
-- not rewritten. No uniqueness is imposed on historical identifiers: existing
-- duplicates stay as they are; the function only stops the list from adding
-- or editing into one. The Kindle harvester's writes to books.asin do not take
-- the list lock (it never creates books).
--
-- Grants: the function is SECURITY INVOKER and executable by service_role
-- only; the ledger table is service_role only. Grants and row level security
-- on pds.books are unchanged.
--
-- Until applied, GET /api/reading/list answers 503 list_unavailable and the
-- screen keeps what was typed (nothing is reported as saved).
-- Not applied by this change. Rollback notes: docs/reading-list.md.
-- ============================================================

ALTER TABLE pds.books
    ADD COLUMN IF NOT EXISTS edition_identifier TEXT,          -- ISBN-13 (ISBN-10 stored converted) or ASIN typed on the list; never copied into asin
    ADD COLUMN IF NOT EXISTS list_position      BIGINT,        -- Want to read order (ascending, ties by book_id, NULL last)
    ADD COLUMN IF NOT EXISTS list_removed_at    TIMESTAMPTZ,   -- taken off the list (reversible; the row and its history stay)
    ADD COLUMN IF NOT EXISTS list_version       INTEGER NOT NULL DEFAULT 0; -- bumped by every content/status change from the list

CREATE INDEX IF NOT EXISTS idx_books_want_list
    ON pds.books (list_position, book_id)
    WHERE status = 'queued' AND list_removed_at IS NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'books_edition_identifier_check') THEN
    ALTER TABLE pds.books ADD CONSTRAINT books_edition_identifier_check
      CHECK (edition_identifier IS NULL OR edition_identifier ~ '^(97[89][0-9]{10}|B[0-9A-Z]{9})$');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS pds.reading_list_ops (
    op_key       UUID        PRIMARY KEY,
    kind         TEXT        NOT NULL CHECK (kind IN ('create','edit','move','remove','restore','start')),
    payload_hash TEXT        NOT NULL,   -- sha-256 of the normalized payload (lib/reading-list.ts canonicalPayload)
    book_id      BIGINT,                 -- plain reference (no foreign key: never blocks or cascades anything on books)
    result       JSONB       NOT NULL,   -- the answer given when it was applied (book_id, version, started, reused, removed)
    applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE pds.reading_list_ops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.reading_list_ops FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON pds.reading_list_ops TO service_role;

-- p: {op_key, kind, payload_hash, book_id, expected_version, title, author, edition,
--     identity_forms[], title_key, resolve ('distinct'|'reuse'|null), reuse_id, reuse_version, reuse_listed, slug, slug_long,
--     direction, expected_order[], start_date}
-- Answers {ok: true, book_id, version, replayed, started?, reused?, removed?}
--      or {ok: false, http, code, book_id?, candidates?, distinct_allowed?, book_status?}.
-- Refusals are not recorded (the key is not spent); any error rolls the whole call back.
CREATE OR REPLACE FUNCTION pds.reading_list_apply(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pds, pg_temp
AS $fn$
DECLARE
  v_key     UUID   := (p->>'op_key')::uuid;
  v_kind    TEXT   := p->>'kind';
  v_hash    TEXT   := p->>'payload_hash';
  v_book    BIGINT := NULLIF(p->>'book_id', '')::bigint;
  v_forms   TEXT[] := COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(p->'identity_forms', '[]'::jsonb))), '{}');
  v_prior   pds.reading_list_ops%ROWTYPE;
  v_row     pds.books%ROWTYPE;
  v_cands   JSONB;
  v_by_id   BOOLEAN;
  v_ids     BIGINT[];
  v_expect  BIGINT[];
  v_idx     INT;
  v_other   BIGINT;
  v_slug    TEXT;
  v_result  JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pds.reading_list'));

  SELECT * INTO v_prior FROM pds.reading_list_ops WHERE op_key = v_key;
  IF FOUND THEN
    IF v_prior.kind <> v_kind OR v_prior.payload_hash <> v_hash THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'key_reused');
    END IF;
    RETURN v_prior.result || jsonb_build_object('replayed', true);
  END IF;

  IF v_kind IN ('create', 'edit') THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'book_id', b.book_id, 'version', b.list_version, 'status', b.status,
             'listed', (b.status = 'queued' AND b.list_removed_at IS NULL), 'match', m.match)
             ORDER BY m.rank, b.book_id), '[]'::jsonb),
           COALESCE(bool_or(m.match = 'identifier'), false)
      INTO v_cands, v_by_id
      FROM pds.books b
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN cardinality(v_forms) > 0 AND (
                        b.edition_identifier = ANY(v_forms)
                        OR upper(regexp_replace(COALESCE(b.asin, ''), '[[:space:]-]', '', 'g')) = ANY(v_forms))
                   THEN 'identifier'
                 WHEN v_kind = 'create'
                      AND lower(regexp_replace(btrim(b.title), '[[:space:]]+', ' ', 'g')) = p->>'title_key'
                      AND (cardinality(v_forms) = 0 OR (b.edition_identifier IS NULL AND NULLIF(btrim(COALESCE(b.asin, '')), '') IS NULL))
                   THEN 'title'
               END AS match,
               CASE WHEN cardinality(v_forms) > 0 AND (b.edition_identifier = ANY(v_forms)
                        OR upper(regexp_replace(COALESCE(b.asin, ''), '[[:space:]-]', '', 'g')) = ANY(v_forms)) THEN 0 ELSE 1 END AS rank
      ) m
     WHERE m.match IS NOT NULL
       AND (v_kind <> 'edit' OR b.book_id <> v_book);
  END IF;

  IF v_kind = 'create' THEN
    IF p->>'resolve' = 'reuse' THEN
      SELECT * INTO v_row FROM pds.books WHERE book_id = (p->>'reuse_id')::bigint FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;
      -- The duplicate choice is based on the candidate Riley actually saw. Never restore a row removed later.
      IF v_row.list_version IS DISTINCT FROM (p->>'reuse_version')::int
         OR (v_row.status = 'queued' AND v_row.list_removed_at IS NULL) IS DISTINCT FROM (p->>'reuse_listed')::boolean THEN
        RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'changed', 'book_id', v_row.book_id);
      END IF;
      IF v_row.status <> 'queued' THEN
        RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'not_queued', 'book_id', v_row.book_id, 'book_status', v_row.status);
      END IF;
      IF v_row.list_removed_at IS NOT NULL THEN
        UPDATE pds.books SET list_removed_at = NULL, list_version = list_version + 1
         WHERE book_id = v_row.book_id RETURNING * INTO v_row;
      END IF;
      v_result := jsonb_build_object('ok', true, 'book_id', v_row.book_id, 'version', v_row.list_version, 'reused', true);
    ELSE
      IF v_by_id OR (jsonb_array_length(v_cands) > 0 AND COALESCE(p->>'resolve', '') <> 'distinct') THEN
        RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'duplicate', 'candidates', v_cands, 'distinct_allowed', NOT v_by_id);
      END IF;
      v_slug := p->>'slug';
      IF EXISTS (SELECT 1 FROM pds.books WHERE slug = v_slug) THEN v_slug := p->>'slug_long'; END IF;
      IF v_slug IS NULL OR EXISTS (SELECT 1 FROM pds.books WHERE slug = v_slug) THEN
        RETURN jsonb_build_object('ok', false, 'http', 500, 'code', 'failed');
      END IF;
      INSERT INTO pds.books (slug, title, author, edition_identifier, status, list_position, list_version)
      VALUES (v_slug, p->>'title', NULLIF(p->>'author', ''), NULLIF(p->>'edition', ''), 'queued',
              COALESCE((SELECT max(list_position) FROM pds.books WHERE status = 'queued' AND list_removed_at IS NULL), 0) + 1024, 1)
      RETURNING * INTO v_row;
      v_result := jsonb_build_object('ok', true, 'book_id', v_row.book_id, 'version', v_row.list_version);
    END IF;

  ELSE
    SELECT * INTO v_row FROM pds.books WHERE book_id = v_book FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'http', 404, 'code', 'not_found'); END IF;

    IF v_kind <> 'move' AND v_row.list_version <> (p->>'expected_version')::int THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'changed', 'book_id', v_book);
    END IF;
    IF v_row.status <> 'queued' OR (v_kind <> 'restore' AND v_row.list_removed_at IS NOT NULL) THEN
      RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'not_queued', 'book_id', v_book, 'book_status', v_row.status);
    END IF;

    IF v_kind = 'edit' THEN
      IF v_by_id THEN
        RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'duplicate', 'candidates', v_cands, 'distinct_allowed', false);
      END IF;
      UPDATE pds.books
         SET title = p->>'title', author = NULLIF(p->>'author', ''), edition_identifier = NULLIF(p->>'edition', ''),
             list_version = list_version + 1
       WHERE book_id = v_book RETURNING * INTO v_row;
      v_result := jsonb_build_object('ok', true, 'book_id', v_book, 'version', v_row.list_version);

    ELSIF v_kind = 'remove' THEN
      UPDATE pds.books SET list_removed_at = NOW(), list_version = list_version + 1
       WHERE book_id = v_book RETURNING * INTO v_row;
      v_result := jsonb_build_object('ok', true, 'book_id', v_book, 'version', v_row.list_version, 'removed', true);

    ELSIF v_kind = 'restore' THEN
      IF v_row.list_removed_at IS NOT NULL THEN
        UPDATE pds.books SET list_removed_at = NULL, list_version = list_version + 1
         WHERE book_id = v_book RETURNING * INTO v_row;
      END IF;
      v_result := jsonb_build_object('ok', true, 'book_id', v_book, 'version', v_row.list_version);

    ELSIF v_kind = 'start' THEN
      IF NULLIF(p->>'start_date', '') IS NOT NULL AND (p->>'start_date')::date > pds.behavioral_today_now() THEN
        RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_date');
      END IF;
      -- Status only (plus the day, when Riley picked one). No session, progress, habit or purchase is recorded.
      UPDATE pds.books
         SET status = 'reading',
             start_date = COALESCE(NULLIF(p->>'start_date', '')::date, start_date),
             list_version = list_version + 1
       WHERE book_id = v_book RETURNING * INTO v_row;
      v_result := jsonb_build_object('ok', true, 'book_id', v_book, 'version', v_row.list_version, 'started', v_row.slug);

    ELSIF v_kind = 'move' THEN
      SELECT array_agg(book_id ORDER BY list_position ASC NULLS LAST, book_id) INTO v_ids
        FROM pds.books WHERE status = 'queued' AND list_removed_at IS NULL;
      v_expect := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p->'expected_order', '[]'::jsonb))::bigint);
      IF v_ids IS DISTINCT FROM v_expect THEN
        RETURN jsonb_build_object('ok', false, 'http', 409, 'code', 'changed', 'book_id', v_book);
      END IF;
      v_idx := array_position(v_ids, v_book);
      IF (p->>'direction' = 'up' AND v_idx > 1) OR (p->>'direction' = 'down' AND v_idx < cardinality(v_ids)) THEN
        v_other := v_ids[CASE WHEN p->>'direction' = 'up' THEN v_idx - 1 ELSE v_idx + 1 END];
        -- Renumber in the current order, then swap the two: one transaction, positions only (no version change).
        UPDATE pds.books b SET list_position = o.n * 1024
          FROM (SELECT x.id, x.n FROM unnest(v_ids) WITH ORDINALITY AS x(id, n)) o
         WHERE b.book_id = o.id AND b.list_position IS DISTINCT FROM o.n * 1024;
        UPDATE pds.books SET list_position = array_position(v_ids, v_other) * 1024 WHERE book_id = v_book;
        UPDATE pds.books SET list_position = v_idx * 1024 WHERE book_id = v_other;
      END IF;
      v_result := jsonb_build_object('ok', true, 'book_id', v_book, 'version', v_row.list_version);
    ELSE
      RETURN jsonb_build_object('ok', false, 'http', 400, 'code', 'bad_request');
    END IF;
  END IF;

  INSERT INTO pds.reading_list_ops (op_key, kind, payload_hash, book_id, result)
  VALUES (v_key, v_kind, v_hash, (v_result->>'book_id')::bigint, v_result);
  RETURN v_result || jsonb_build_object('replayed', false);
END
$fn$;

REVOKE ALL ON FUNCTION pds.reading_list_apply(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.reading_list_apply(JSONB) TO service_role;

COMMENT ON FUNCTION pds.reading_list_apply(JSONB) IS
  'Want to read list: applies one operation atomically under the list lock and records it in pds.reading_list_ops (service_role only).';
COMMENT ON COLUMN pds.books.edition_identifier IS
  'Optional edition identifier typed on the Want to read list: ISBN-13 (ISBN-10 stored converted) or an ASIN. Never written into asin (the Kindle harvester owns that).';
COMMENT ON COLUMN pds.books.list_removed_at IS
  'Set when a queued book is taken off the Want to read list; cleared by Undo. The book row is never deleted.';
