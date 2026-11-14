"""Offline tests for journal_etl.py (Notion personal Journal -> pds.journal_entries).

Three things are pinned here, with a fake Notion, a fake Voyage and a fake Supabase
(synthetic text only, no network, no database, no credentials):

  1. Images. A Notion-hosted image is stored as `![caption](notion-image:<block id>)`,
     never as its signed download URL (it dies after about an hour, audit
     etl/gemini/F-006). The embedding text carries only the caption. A rotated signed
     URL changes neither the stored text nor the embedding text, and an unedited page
     is not re-fetched or re-embedded at all.

  2. Embeddings survive a sync. supabase-py sends a bulk upsert with the UNION of the
     batch's keys and PostgREST writes NULL for a key a row lacks. Unchanged rows carry
     no `embedding` key, so one edited page in the batch used to wipe the stored
     embedding of every unchanged page beside it, which were then re-embedded the next
     hour, wiping the others in turn (live 2026-11-13: 24 of 45 entries had no
     embedding, flipping every run). The fake Supabase applies the same rule, and one
     test shows it reproduces the old loss, so the passing tests mean something.

  3. Heartbeats. Every way a run can end writes a pds.sync_log row: success, Notion
     query failure (failed), embedding failure (partial), uncaught exception (failed).

Run: python tests/test_journal_etl.py
     python tests/run_offline_tests.py tests/test_journal_etl.py
"""
from __future__ import annotations

import contextlib
import os
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("NOTION_API_KEY", "stub")
os.environ.setdefault("VOYAGE_API_KEY", "stub")

import httpx  # noqa: E402

import journal_etl as je  # noqa: E402

STORED_EDIT = "2026-01-05T12:00:00+00:00"       # how PostgREST returns a TIMESTAMPTZ
NOTION_SAME_EDIT = "2026-01-05T12:00:00.000Z"   # the same instant, as Notion writes it
NOTION_NEW_EDIT = "2026-02-01T09:30:00.000Z"
OLD_VECTOR = [0.5, 0.5, 0.5, 0.5]
NEW_VECTOR = [0.1, 0.2, 0.3, 0.4]


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _Result:
    def __init__(self, data):
        self.data = data


class FakeSupabase:
    """In-memory pds.journal_entries + pds.sync_log.

    upsert() follows what supabase-py + PostgREST really do with a list: the column
    list is the union of every row's keys, and a row without one of them is written
    with NULL there (the stored value is overwritten).
    """

    def __init__(self, rows=(), fail_upsert: Exception | None = None):
        self.rows: dict[str, dict] = {r["notion_page_id"]: dict(r) for r in rows}
        self.upsert_requests: list[list[dict]] = []
        self.sync_logs: list[dict] = []
        self.fail_upsert = fail_upsert

    def schema(self, name):
        assert name == "pds", name
        return self

    def table(self, name):
        return _Query(self, name)

    from_ = table

    def null_embeddings(self) -> int:
        return sum(1 for r in self.rows.values() if r.get("embedding") is None)


class _Query:
    def __init__(self, db: FakeSupabase, table: str):
        self.db, self.table = db, table
        self.op, self.payload, self.cols, self.filters = None, None, None, []

    def select(self, cols):
        self.op, self.cols = "select", [c.strip() for c in cols.split(",")]
        return self

    def insert(self, row):
        self.op, self.payload = "insert", row
        return self

    def upsert(self, rows, on_conflict=""):
        assert on_conflict == "notion_page_id", on_conflict
        self.op, self.payload = "upsert", rows
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def eq(self, col, val):
        self.filters.append((col, val))
        return self

    def execute(self):
        db = self.db
        if self.table == "sync_log":
            assert self.op == "insert", self.op
            db.sync_logs.append(dict(self.payload))
            return _Result([self.payload])
        assert self.table == "journal_entries", self.table
        if self.op == "select":
            return _Result([{c: r.get(c) for c in self.cols} for r in db.rows.values()])
        if self.op == "upsert":
            if db.fail_upsert is not None:
                raise db.fail_upsert
            rows = [dict(r) for r in self.payload]
            db.upsert_requests.append(rows)
            columns = {k for r in rows for k in r}
            for r in rows:
                db.rows.setdefault(r["notion_page_id"], {}).update(
                    {c: r.get(c) for c in columns})
            return _Result(rows)
        if self.op == "update":
            for r in db.rows.values():
                if all(r.get(c) == v for c, v in self.filters):
                    r.update(self.payload)
            return _Result([])
        raise AssertionError(self.op)


def notion_page(pid: str, edited: str = NOTION_SAME_EDIT, title: str | None = None) -> dict:
    return {
        "id": pid,
        "created_time": "2026-01-05T11:00:00.000Z",
        "last_edited_time": edited,
        "archived": False,
        "properties": {
            "Date": {"date": {"start": "2026-01-05"}},
            "Title": {"title": [{"plain_text": title or f"Synthetic entry {pid}"}]},
            "Mood": {"select": {"name": "good"}},
            "Source": {"select": {"name": "typed"}},
            "Confidence": {"select": {"name": "medium"}},
            "Topics": {"multi_select": [{"name": "reflection"}]},
        },
    }


def stored_row(pid: str, embedded: bool = True, content: str | None = None) -> dict:
    return {
        "notion_page_id": pid,
        "notion_edited_at": STORED_EDIT,
        "content_md": content if content is not None else f"Body of {pid}.",
        "embedding": list(OLD_VECTOR) if embedded else None,
        "embedding_model": je.VOYAGE_MODEL if embedded else None,
    }


def paragraph(text: str) -> dict:
    return {"id": "blk-p", "type": "paragraph",
            "paragraph": {"rich_text": [{"plain_text": text}]}}


def hosted_image(block_id: str, signature: str, caption: str = "A synthetic caption") -> dict:
    return {
        "id": block_id, "type": "image",
        "image": {
            "type": "file",
            "file": {"url": f"https://files.example.invalid/{block_id}.png"
                            f"?X-Amz-Signature={signature}&X-Amz-Expires=3600",
                     "expiry_time": "2026-01-05T13:00:00.000Z"},
            "caption": [{"plain_text": caption}] if caption else [],
        },
    }


def external_image(block_id: str, url: str, caption: str = "A chart") -> dict:
    return {"id": block_id, "type": "image",
            "image": {"type": "external", "external": {"url": url},
                      "caption": [{"plain_text": caption}]}}


class Run:
    """One journal_etl run against the fakes; records what was fetched and embedded."""

    def __init__(self, db: FakeSupabase, pages, blocks=None, query_error=None,
                 embed_error=None):
        self.db, self.pages = db, pages
        self.blocks = blocks or {}
        self.query_error, self.embed_error = query_error, embed_error
        self.fetched: list[str] = []
        self.embedded: list[str] = []

    def _query(self, _client):
        if self.query_error is not None:
            raise self.query_error
        return list(self.pages)

    def _blocks(self, _client, page_id):
        self.fetched.append(page_id)
        return self.blocks.get(page_id, [paragraph(f"Edited body of {page_id}.")])

    def _embed(self, _client, texts):
        if self.embed_error is not None:
            raise self.embed_error
        self.embedded.extend(texts)
        return [list(NEW_VECTOR) for _ in texts]

    @contextlib.contextmanager
    def patched(self):
        with patch.object(je, "create_client", lambda *_a, **_k: self.db), \
                patch.object(je, "query_database", self._query), \
                patch.object(je, "fetch_blocks", self._blocks), \
                patch.object(je, "embed_documents", self._embed), \
                patch.object(je.time, "sleep", lambda *_a: None):
            yield self

    def main(self, full=False, reembed=False) -> int:
        with self.patched():
            return je.main(full=full, reembed=reembed)


def http_error(status: int) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://api.example.invalid/x")
    return httpx.HTTPStatusError(f"status {status}", request=request,
                                 response=httpx.Response(status, request=request, text="nope"))


# ---------------------------------------------------------------------------
# 1. Images
# ---------------------------------------------------------------------------

def test_notion_hosted_image_is_stored_by_block_id_not_signed_url() -> None:
    md = je.blocks_to_markdown([paragraph("Before."), hosted_image("blk-img-1", "sig-AAA")])
    assert md == "Before.\n\n![A synthetic caption](notion-image:blk-img-1)", md
    for dead in ("X-Amz", "sig-AAA", "files.example.invalid", "https://"):
        assert dead not in md, (dead, md)


def test_rotated_signed_url_changes_neither_stored_text_nor_embedding_text() -> None:
    first = je.blocks_to_markdown([paragraph("Body."), hosted_image("blk-img-1", "sig-AAA")])
    later = je.blocks_to_markdown([paragraph("Body."), hosted_image("blk-img-1", "sig-BBB")])
    assert first == later
    assert je.embedding_text("T", first) == je.embedding_text("T", later)


def test_external_image_keeps_its_own_url() -> None:
    url = "https://example.invalid/charts/weekly.png"
    md = je.blocks_to_markdown([external_image("blk-img-2", url)])
    assert md == f"![A chart]({url})", md


def test_embedding_text_carries_the_caption_only() -> None:
    md = je.blocks_to_markdown([
        paragraph("Walked by the river."),
        hosted_image("blk-img-1", "sig-AAA", caption="River at dusk"),
        external_image("blk-img-2", "https://example.invalid/a.png", caption=""),
    ])
    text = je.embedding_text("A walk", md)
    assert text == "A walk\n\nWalked by the river.\n\n[image: River at dusk]\n\n[image]", text
    for noise in ("blk-img-1", "notion-image", "example.invalid", "![", "]("):
        assert noise not in text, (noise, text)


def test_embedding_text_is_unchanged_for_an_entry_without_images() -> None:
    # No behaviour change for the existing journal (no entry has an image today).
    assert je.embedding_text("Title", "Line one.\n\n- item [x] (y)") == \
        "Title\n\nLine one.\n\n- item [x] (y)"
    assert je.embedding_text(None, None) == "\n\n"


def test_caption_is_kept_on_one_line_and_parseable() -> None:
    md = je.image_markdown(hosted_image("blk-9", "sig", caption="Notes [draft]\nsecond line"))
    assert md == "![Notes (draft) second line](notion-image:blk-9)", md
    assert je.embedding_text("", md) == "\n\n[image: Notes (draft) second line]"


def test_image_nested_under_a_toggle_gets_the_placeholder_too() -> None:
    toggle = {"id": "blk-t", "type": "toggle",
              "toggle": {"rich_text": [{"plain_text": "Photos"}]},
              "_children": [hosted_image("blk-img-3", "sig-CCC", caption="")]}
    md = je.blocks_to_markdown([toggle])
    assert md.endswith("![](notion-image:blk-img-3)") and "X-Amz" not in md, md


def test_unedited_page_is_not_refetched_or_reembedded_when_its_signed_url_rotates() -> None:
    placeholder = "Body.\n\n![A synthetic caption](notion-image:blk-img-1)"
    db = FakeSupabase([stored_row("p1", content=placeholder)])
    # Notion would now hand out a different signed URL, but the page was not edited.
    run = Run(db, [notion_page("p1")],
              blocks={"p1": [paragraph("Body."), hosted_image("blk-img-1", "sig-NEW")]})
    assert run.main() == 0
    assert run.fetched == [] and run.embedded == []
    assert db.rows["p1"]["content_md"] == placeholder
    assert db.rows["p1"]["embedding"] == OLD_VECTOR


def test_full_refetch_stores_identical_text_whatever_the_signature() -> None:
    stored = []
    for signature in ("sig-ONE", "sig-TWO"):
        db = FakeSupabase()
        run = Run(db, [notion_page("p1")],
                  blocks={"p1": [paragraph("Body."), hosted_image("blk-img-1", signature)]})
        assert run.main(full=True) == 0
        stored.append((db.rows["p1"]["content_md"], tuple(run.embedded)))
    assert stored[0] == stored[1], stored
    assert "sig-" not in stored[0][0] and "sig-" not in stored[0][1][0]


# ---------------------------------------------------------------------------
# 2. Stored embeddings survive a sync
# ---------------------------------------------------------------------------

def test_uniform_batches_never_mixes_key_sets() -> None:
    with_vec = [{"notion_page_id": f"e{i}", "title": "t", "embedding": [1.0],
                 "embedding_model": "m"} for i in range(7)]
    without = [{"notion_page_id": f"u{i}", "title": "t"} for i in range(60)]
    rows = []
    for i, row in enumerate(without):          # interleave the two shapes
        rows.append(row)
        if i < len(with_vec):
            rows.append(with_vec[i])
    batches = list(je.uniform_batches(rows, 25))
    assert all(len({frozenset(r) for r in b}) == 1 for b in batches), "mixed batch"
    assert all(0 < len(b) <= 25 for b in batches)
    seen = [r["notion_page_id"] for b in batches for r in b]
    assert sorted(seen) == sorted(r["notion_page_id"] for r in rows)
    assert len(seen) == len(set(seen)) == 67
    assert list(je.uniform_batches([], 25)) == []


def _thirty_embedded_one_edited():
    ids = [f"p{i:02d}" for i in range(30)]
    db = FakeSupabase([stored_row(pid) for pid in ids])
    pages = [notion_page(pid, NOTION_NEW_EDIT if pid == "p03" else NOTION_SAME_EDIT)
             for pid in ids]
    return db, Run(db, pages)


def test_one_edited_page_does_not_wipe_the_other_embeddings() -> None:
    db, run = _thirty_embedded_one_edited()
    assert run.main() == 0
    assert run.fetched == ["p03"] and len(run.embedded) == 1
    assert db.null_embeddings() == 0, f"{db.null_embeddings()} embeddings wiped"
    assert db.rows["p03"]["embedding"] == NEW_VECTOR
    assert db.rows["p03"]["content_md"] == "Edited body of p03."
    assert all(db.rows[p]["embedding"] == OLD_VECTOR and
               db.rows[p]["embedding_model"] == je.VOYAGE_MODEL
               for p in db.rows if p != "p03")
    assert all(len({frozenset(r) for r in req}) == 1 for req in db.upsert_requests)
    assert db.sync_logs[-1]["status"] == "success" and db.sync_logs[-1]["records_synced"] == 30


def test_the_fake_reproduces_the_old_loss_with_plain_chunking() -> None:
    """Guard on the test itself: with the pre-fix chunking (rows of both shapes in one
    request) the same scenario loses embeddings, so the test above can fail."""
    def plain_chunks(rows, size):
        for i in range(0, len(rows), size):
            yield rows[i:i + size]

    db, run = _thirty_embedded_one_edited()
    with patch.object(je, "uniform_batches", plain_chunks):
        assert run.main() == 0
    assert db.null_embeddings() == 24, db.null_embeddings()   # the rest of p03's chunk of 25


def test_wiped_embeddings_heal_in_one_run_and_stay_healed() -> None:
    # The shape found live: most of one chunk without an embedding.
    ids = [f"p{i:02d}" for i in range(45)]
    db = FakeSupabase([stored_row(pid, embedded=(i == 0 or i >= 25))
                       for i, pid in enumerate(ids)])
    assert db.null_embeddings() == 24
    pages = [notion_page(pid) for pid in ids]

    first = Run(db, pages)
    assert first.main() == 0
    assert len(first.embedded) == 24 and first.fetched == []
    assert db.null_embeddings() == 0

    second = Run(db, pages)
    assert second.main() == 0
    assert second.embedded == [] and second.fetched == []
    assert db.null_embeddings() == 0


def test_emptied_body_clears_the_stale_embedding() -> None:
    db = FakeSupabase([stored_row("p1"), stored_row("p2")])
    run = Run(db, [notion_page("p1", NOTION_NEW_EDIT), notion_page("p2")], blocks={"p1": []})
    assert run.main() == 0
    assert run.fetched == ["p1"] and run.embedded == []
    assert db.rows["p1"]["content_md"] == "" and db.rows["p1"]["embedding"] is None
    assert db.rows["p1"]["embedding_model"] is None
    assert db.rows["p2"]["embedding"] == OLD_VECTOR


# ---------------------------------------------------------------------------
# 3. A heartbeat on every outcome
# ---------------------------------------------------------------------------

def _only_heartbeat(db: FakeSupabase) -> dict:
    assert len(db.sync_logs) == 1, db.sync_logs
    row = db.sync_logs[0]
    assert (row["source"], row["data_type"]) == ("notion_journal", "entries")
    assert row["sync_start"] and row["sync_end"] and row["duration_seconds"] >= 0
    return row


def test_success_writes_one_success_heartbeat() -> None:
    db = FakeSupabase([stored_row("p1")])
    assert Run(db, [notion_page("p1")]).main() == 0
    row = _only_heartbeat(db)
    assert row["status"] == "success" and row["records_synced"] == 1 and row["error_message"] is None


def test_notion_query_failure_writes_a_failed_heartbeat() -> None:
    db = FakeSupabase([stored_row("p1")])
    assert Run(db, [], query_error=http_error(502)).main() == 1
    row = _only_heartbeat(db)
    assert row["status"] == "failed" and row["records_synced"] == 0 and row["error_message"]
    assert db.upsert_requests == [] and db.rows["p1"]["embedding"] == OLD_VECTOR


def test_embedding_failure_is_partial_and_keeps_everything_else() -> None:
    db = FakeSupabase([stored_row("p1"), stored_row("p2")])
    run = Run(db, [notion_page("p1", NOTION_NEW_EDIT), notion_page("p2")],
              embed_error=http_error(429))
    assert run.main() == 2
    row = _only_heartbeat(db)
    assert row["status"] == "partial" and row["records_synced"] == 1
    assert "embedding failed for 1 row" in row["error_message"]
    # The edited page was not written, so its old edit time makes the next run retry it.
    assert db.rows["p1"]["notion_edited_at"] == STORED_EDIT
    assert db.rows["p1"]["embedding"] == OLD_VECTOR and db.rows["p2"]["embedding"] == OLD_VECTOR


def test_uncaught_exception_writes_a_failed_heartbeat_and_still_raises() -> None:
    db = FakeSupabase([stored_row("p1")], fail_upsert=RuntimeError("synthetic database outage"))
    run = Run(db, [notion_page("p1")])
    raised = None
    with run.patched():
        try:
            je.cli([])
        except RuntimeError as exc:
            raised = exc
    assert raised is not None and "synthetic database outage" in str(raised)
    row = _only_heartbeat(db)
    assert row["status"] == "failed"
    assert row["error_message"] == "Uncaught exception: synthetic database outage"


def test_cli_exits_with_the_run_result() -> None:
    for run, expected in ((Run(FakeSupabase(), [notion_page("p1")]), 0),
                          (Run(FakeSupabase(), [], query_error=http_error(500)), 1)):
        code = None
        with run.patched():
            try:
                je.cli([])
            except SystemExit as exc:
                code = exc.code
        assert code == expected, (code, expected)
        assert len(run.db.sync_logs) == 1, "exactly one heartbeat per run"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {exc!r}")
    if failures:
        print(f"{failures} failure(s)")
        sys.exit(1)
    print("OK - journal_etl tests passed.")
