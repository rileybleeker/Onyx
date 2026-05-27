"""
Personal Data Scientist — Notion Journal ETL
================================================
Syncs the personal Journal (Notion DB "Entries", parent page "Journal") into
Supabase pds.journal_entries. One row per Notion page.

Each entry gets:
  - Metadata: title, date, mood, source, confidence, topics
  - Content: full page body as markdown (blocks fetched recursively)
  - Embedding: Voyage AI voyage-3-large (1024-dim), input_type='document'
  - Archive flag: pages no longer returned by the live Notion query

The Notion `last_edited_time` is the skip-if-unchanged guard — pages whose
edit time hasn't advanced since the last sync are not re-fetched or re-embedded.

Usage:
    python journal_etl.py             # Incremental sync (default)
    python journal_etl.py --full      # Ignore edit-time guard, re-fetch every page
    python journal_etl.py --reembed   # Keep content, regenerate every embedding
"""

import os
import sys
import time
import json
import argparse
import logging
from datetime import datetime, timezone

import httpx
from dotenv import load_dotenv
from supabase import create_client, Client

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

NOTION_API_KEY = os.environ["NOTION_API_KEY"]
NOTION_JOURNAL_DB = os.environ.get(
    "NOTION_JOURNAL_DB", "96541038264d45aba2a9601d9b175a7e"
)
NOTION_VERSION = "2022-06-28"
NOTION_API = "https://api.notion.com/v1"

VOYAGE_API_KEY = os.environ.get("VOYAGE_API_KEY", "")
VOYAGE_API = "https://api.voyageai.com/v1/embeddings"
VOYAGE_MODEL = "voyage-3-large"
VOYAGE_DIM = 1024

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("journal_etl")

# ---------------------------------------------------------------------------
# Notion client helpers
# ---------------------------------------------------------------------------

def _notion_headers() -> dict:
    return {
        "Authorization": f"Bearer {NOTION_API_KEY}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }

def query_database(client: httpx.Client) -> list[dict]:
    """Fetch all pages in the journal DB, following pagination."""
    pages: list[dict] = []
    cursor: str | None = None
    while True:
        body: dict = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        r = client.post(
            f"{NOTION_API}/databases/{NOTION_JOURNAL_DB}/query",
            headers=_notion_headers(),
            json=body,
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        pages.extend(data.get("results", []))
        if not data.get("has_more"):
            break
        cursor = data.get("next_cursor")
    return pages

def fetch_blocks(client: httpx.Client, block_id: str) -> list[dict]:
    """Recursively fetch all child blocks under a given block id."""
    blocks: list[dict] = []
    cursor: str | None = None
    while True:
        params: dict = {"page_size": 100}
        if cursor:
            params["start_cursor"] = cursor
        r = client.get(
            f"{NOTION_API}/blocks/{block_id}/children",
            headers=_notion_headers(),
            params=params,
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        for block in data.get("results", []):
            blocks.append(block)
            if block.get("has_children"):
                block["_children"] = fetch_blocks(client, block["id"])
        if not data.get("has_more"):
            break
        cursor = data.get("next_cursor")
    return blocks

# ---------------------------------------------------------------------------
# Block → markdown conversion
# ---------------------------------------------------------------------------

def _rich_text(rt: list[dict] | None) -> str:
    if not rt:
        return ""
    return "".join(t.get("plain_text", "") for t in rt)

def _block_to_md(block: dict, list_index: int | None = None, depth: int = 0) -> str:
    btype = block.get("type", "")
    data = block.get(btype, {}) if btype else {}
    text = _rich_text(data.get("rich_text"))
    indent = "  " * depth

    if btype == "paragraph":
        out = f"{indent}{text}" if text else ""
    elif btype == "heading_1":
        out = f"# {text}"
    elif btype == "heading_2":
        out = f"## {text}"
    elif btype == "heading_3":
        out = f"### {text}"
    elif btype == "bulleted_list_item":
        out = f"{indent}- {text}"
    elif btype == "numbered_list_item":
        n = list_index if list_index is not None else 1
        out = f"{indent}{n}. {text}"
    elif btype == "to_do":
        checked = data.get("checked", False)
        out = f"{indent}- [{'x' if checked else ' '}] {text}"
    elif btype == "quote":
        out = f"> {text}"
    elif btype == "callout":
        emoji = (data.get("icon") or {}).get("emoji", "") or ""
        prefix = f"{emoji} " if emoji else ""
        out = f"> {prefix}{text}"
    elif btype == "code":
        lang = data.get("language", "")
        out = f"```{lang}\n{text}\n```"
    elif btype == "divider":
        out = "---"
    elif btype == "toggle":
        out = f"{indent}▸ {text}" if text else ""
    elif btype == "image":
        img = data
        url = (img.get("file") or img.get("external") or {}).get("url", "")
        cap = _rich_text(img.get("caption"))
        out = f"![{cap}]({url})" if url else ""
    else:
        out = f"[unsupported: {btype}]"

    # Recurse into children. Numbered-list children renumber from 1 at each nesting.
    children = block.get("_children", [])
    if children:
        child_lines: list[str] = []
        n = 0
        for ch in children:
            if ch.get("type") == "numbered_list_item":
                n += 1
                child_lines.append(_block_to_md(ch, list_index=n, depth=depth + 1))
            else:
                n = 0
                child_lines.append(_block_to_md(ch, depth=depth + 1))
        children_md = "\n".join(filter(None, child_lines))
        if out:
            out = f"{out}\n{children_md}"
        else:
            out = children_md
    return out

def blocks_to_markdown(blocks: list[dict]) -> str:
    lines: list[str] = []
    n = 0
    for b in blocks:
        if b.get("type") == "numbered_list_item":
            n += 1
            lines.append(_block_to_md(b, list_index=n))
        else:
            n = 0
            lines.append(_block_to_md(b))
    return "\n\n".join(s for s in lines if s).strip()

# ---------------------------------------------------------------------------
# Page property extraction
# ---------------------------------------------------------------------------

def _select(prop: dict | None) -> str | None:
    if not prop:
        return None
    sel = prop.get("select")
    return sel.get("name") if sel else None

def _multi_select(prop: dict | None) -> list[str]:
    if not prop:
        return []
    return [x.get("name") for x in prop.get("multi_select", []) if x.get("name")]

def _title(prop: dict | None) -> str:
    if not prop:
        return ""
    return _rich_text(prop.get("title", []))

def _date_start(prop: dict | None) -> str | None:
    if not prop:
        return None
    d = prop.get("date")
    return d.get("start") if d else None

def extract_metadata(page: dict) -> dict:
    props = page.get("properties", {})
    return {
        "notion_page_id": page["id"],
        "entry_date": _date_start(props.get("Date")),
        "title": _title(props.get("Title")),
        "mood": _select(props.get("Mood")),
        "source": _select(props.get("Source")),
        "confidence": _select(props.get("Confidence")),
        "topics": _multi_select(props.get("Topics")),
        "notion_created_at": page.get("created_time"),
        "notion_edited_at": page.get("last_edited_time"),
        "archived": page.get("archived", False),
    }

# ---------------------------------------------------------------------------
# Voyage embeddings
# ---------------------------------------------------------------------------

def embed_documents(client: httpx.Client, texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts as 'document' inputs. Voyage allows 128 inputs/call."""
    if not texts:
        return []
    if not VOYAGE_API_KEY:
        raise RuntimeError("VOYAGE_API_KEY is not set")
    r = client.post(
        VOYAGE_API,
        headers={
            "Authorization": f"Bearer {VOYAGE_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "input": texts,
            "model": VOYAGE_MODEL,
            "input_type": "document",
            "output_dimension": VOYAGE_DIM,
        },
        timeout=60,
    )
    r.raise_for_status()
    data = r.json()
    return [d["embedding"] for d in data["data"]]

# ---------------------------------------------------------------------------
# sync_log (matches spotify_etl.log_sync_entry pattern)
# ---------------------------------------------------------------------------

def log_sync(sb: Client, status: str, records: int, started_at: float, error: str | None = None):
    duration = int(time.time() - started_at)
    try:
        sb.schema("pds").table("sync_log").insert({
            "source": "notion_journal",
            "data_type": "entries",
            "status": status,
            "records_synced": records,
            "duration_seconds": duration,
            "error_message": error,
            "sync_start": datetime.fromtimestamp(started_at, tz=timezone.utc).isoformat(),
        }).execute()
    except Exception as e:
        log.warning(f"sync_log insert failed: {e}")

# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------

def main(full: bool, reembed: bool) -> int:
    started = time.time()
    sb: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    # 1. Load existing edit-times so we can skip unchanged pages.
    existing: dict[str, dict] = {}
    if not full:
        res = sb.schema("pds").table("journal_entries").select(
            "notion_page_id,notion_edited_at,content_md,embedding_model"
        ).execute()
        for row in (res.data or []):
            existing[row["notion_page_id"]] = row

    log.info(f"Loaded {len(existing)} existing entries")

    with httpx.Client() as nc:
        # 2. Query the journal database.
        try:
            pages = query_database(nc)
        except httpx.HTTPStatusError as e:
            log.error(f"Notion query failed: {e.response.status_code} {e.response.text[:200]}")
            log_sync(sb, "failed", 0, started, str(e))
            return 1

        log.info(f"Notion returned {len(pages)} pages")
        live_ids = {p["id"] for p in pages}

        # 3. For each page: extract metadata; fetch content if edited; embed if needed.
        rows_to_upsert: list[dict] = []
        rows_needing_embed: list[tuple[int, str]] = []  # (index_in_rows, text)
        edited = 0
        embedded = 0

        for page in pages:
            meta = extract_metadata(page)
            if not meta["entry_date"]:
                log.warning(f"Skipping {meta['title']!r} ({page['id']}) — no Date")
                continue

            stored = existing.get(meta["notion_page_id"])
            edited_changed = (
                full
                or stored is None
                or stored.get("notion_edited_at") != meta["notion_edited_at"]
            )

            if edited_changed:
                edited += 1
                try:
                    blocks = fetch_blocks(nc, page["id"])
                except httpx.HTTPStatusError as e:
                    log.error(f"Block fetch failed for {meta['title']!r}: {e.response.status_code}")
                    continue
                content_md = blocks_to_markdown(blocks)
                meta["content_md"] = content_md
                meta["word_count"] = len(content_md.split())
            else:
                meta["content_md"] = stored.get("content_md")
                meta["word_count"] = len((meta["content_md"] or "").split())

            rows_to_upsert.append(meta)

            # Decide whether to (re-)embed.
            needs_embed = (
                edited_changed
                or reembed
                or (stored is not None and stored.get("embedding_model") != VOYAGE_MODEL)
            )
            if needs_embed and meta.get("content_md"):
                idx = len(rows_to_upsert) - 1
                head = (meta["title"] or "") + "\n\n" + meta["content_md"]
                rows_needing_embed.append((idx, head))

        # 4. Embed in batches of 64.
        if rows_needing_embed:
            BATCH = 64
            for i in range(0, len(rows_needing_embed), BATCH):
                batch = rows_needing_embed[i:i + BATCH]
                texts = [t for _, t in batch]
                try:
                    vectors = embed_documents(nc, texts)
                except httpx.HTTPStatusError as e:
                    log.error(f"Voyage embedding failed: {e.response.status_code} {e.response.text[:200]}")
                    log_sync(sb, "partial", len(rows_to_upsert), started, str(e))
                    return 2
                for (idx, _), vec in zip(batch, vectors):
                    rows_to_upsert[idx]["embedding"] = vec
                    rows_to_upsert[idx]["embedding_model"] = VOYAGE_MODEL
                    embedded += 1

    # 5. Upsert in chunks of 25 (vectors are large).
    CHUNK = 25
    for i in range(0, len(rows_to_upsert), CHUNK):
        chunk = rows_to_upsert[i:i + CHUNK]
        # supabase-py serializes lists fine; pgvector accepts JSON arrays.
        sb.schema("pds").table("journal_entries").upsert(
            chunk, on_conflict="notion_page_id"
        ).execute()

    # 6. Mark archived pages (in Supabase but not in the live query).
    archived = 0
    if existing:
        stale_ids = [pid for pid in existing if pid not in live_ids]
        for pid in stale_ids:
            sb.schema("pds").table("journal_entries").update(
                {"archived": True, "synced_at": datetime.now(timezone.utc).isoformat()}
            ).eq("notion_page_id", pid).execute()
            archived += 1

    log.info(
        f"Done: synced={len(rows_to_upsert)} edited={edited} embedded={embedded} archived={archived}"
    )
    log_sync(sb, "success", len(rows_to_upsert), started)
    return 0

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", action="store_true",
                        help="Ignore edit-time guard, re-fetch every page")
    parser.add_argument("--reembed", action="store_true",
                        help="Regenerate every embedding, even if content unchanged")
    args = parser.parse_args()
    sys.exit(main(full=args.full, reembed=args.reembed))
