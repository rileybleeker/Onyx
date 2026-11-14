"""Read and update the Notion Tasks DB through the REST API (no MCP query allowance).

Why: the Notion MCP's SQL/rows query tool shares one workspace-wide allowance across
every agent session and locks for up to an hour when it runs out. The REST API has its
own (much higher) limits. The token is the "Personal agents backup" integration, kept in
~/.notion_token (or the NOTION_API_KEY env var); the Tasks DB is shared with it.

Usage:
    python tools/notion_tasks.py list [--all]            # open "Onyx Roadmap" rows (--all = include Done)
    python tools/notion_tasks.py notes <page-id|url>     # print a row's Notes
    python tools/notion_tasks.py append <page-id|url> "text"   # append one paragraph to Notes
    python tools/notion_tasks.py status <page-id|url> "Done"   # Not Started | In Progress | Blocked | Done

`append` reads the existing Notes rich-text objects and adds the new text to the end, so
earlier text, links and formatting are kept exactly. Notion refuses a write in which any
text object is longer than 2,000 UTF-16 code units, but it returns longer ones on read
(the Notion app and MCP write them), so every object - existing and new - is sent as
consecutive pieces of at most 2,000 units with the same link and annotations. The text is
unchanged; a write that would need more than 100 objects is refused, never truncated.
It never prints the token.
"""
from __future__ import annotations

import copy
import os
import pathlib
import re
import sys

DATA_SOURCE = "6149d32a-66be-4e54-ab1b-28c4a11c6543"  # Tasks
VERSION = "2025-09-03"
STATUSES = {"Not Started", "In Progress", "Blocked", "Done"}

# Notion request limits, checked 2026-11-13 against the live API's validation errors:
# text.content "length should be <= 2000" counts UTF-16 code units (1,001 emoji = 2,002 is
# refused; 2,000 euro signs = 6,000 UTF-8 bytes is accepted), and a rich_text property
# holds at most 100 objects.
MAX_TEXT_UNITS = 2000
MAX_RICH_ITEMS = 100
# GET /pages returns at most 25 inline page / person mentions per rich_text property.
# Past that the read is incomplete, and writing it back would delete the rest.
MAX_MENTIONS_READ = 25


class NotesLimitError(ValueError):
    """The Notes property cannot hold the result, or cannot be read back in full."""


def utf16_len(s: str) -> int:
    """Length the way Notion counts it: UTF-16 code units (a character above U+FFFF is 2)."""
    return len(s) + sum(1 for ch in s if ord(ch) > 0xFFFF)


def split_text(s: str, limit: int = MAX_TEXT_UNITS) -> list:
    """Cut s into consecutive pieces of at most `limit` UTF-16 code units.

    "".join(result) == s. A Python string is a sequence of code points and the cut is only
    ever made between two of them, so a surrogate pair is never divided.
    """
    if limit < 2:
        raise ValueError("limit must be at least 2 (one character can take 2 UTF-16 units)")
    pieces, start, units = [], 0, 0
    for i, ch in enumerate(s):
        width = 2 if ord(ch) > 0xFFFF else 1
        if units + width > limit:
            pieces.append(s[start:i])
            start, units = i, 0
        units += width
    if start < len(s) or not pieces:
        pieces.append(s[start:])
    return pieces


def writable_rich_text(rich: list) -> list:
    """Rich-text objects as read from the API -> objects the API accepts on write.

    A text object over the limit becomes several, each with a copy of the original's link
    and annotations. Mentions and equations are passed through unchanged.
    """
    out = []
    for t in rich:
        if t.get("type") != "text":
            out.append(t)
            continue
        text = t["text"]
        for piece in split_text(text.get("content", "")):
            item = {"type": "text", "text": {**copy.deepcopy(text), "content": piece}}
            if "annotations" in t:
                item["annotations"] = copy.deepcopy(t["annotations"])
            out.append(item)
    return out


def build_append(rich: list, text: str) -> list:
    """The full Notes rich_text to write: everything already there, then `text` at the end.

    The new text starts on a new line when Notes is not empty. Raises NotesLimitError
    instead of dropping anything.
    """
    if not text:
        raise NotesLimitError("Nothing to append: the text is empty")
    if sum(1 for t in rich if t.get("type") == "mention") >= MAX_MENTIONS_READ:
        raise NotesLimitError(
            f"Notes holds {MAX_MENTIONS_READ} or more page / person mentions; the API returns only the "
            f"first {MAX_MENTIONS_READ}, so writing it back would delete the rest. Nothing was written: "
            f"edit the row by hand")
    keep = writable_rich_text(rich)
    added = [{"type": "text", "text": {"content": piece}}
             for piece in split_text(("\n" if keep else "") + text)]
    new = keep + added
    if len(new) > MAX_RICH_ITEMS:
        raise NotesLimitError(
            f"Notes would need {len(new)} rich-text objects ({len(keep)} for the text already there, "
            f"{len(added)} for the new text, each at most {MAX_TEXT_UNITS} characters); Notion allows "
            f"{MAX_RICH_ITEMS} per property. Nothing was written and nothing was cut: shorten the note, "
            f"or move older notes into the page body by hand")
    return new


def _token() -> str:
    tok = os.environ.get("NOTION_API_KEY")
    if not tok:
        path = pathlib.Path.home() / ".notion_token"
        if path.exists():
            tok = path.read_text().strip()
    if not tok:
        sys.exit("No Notion token: set NOTION_API_KEY or put it in ~/.notion_token")
    return tok


def _client() -> "httpx.Client":
    import httpx  # imported here so the pure helpers above (and their test) need no install

    return httpx.Client(
        base_url="https://api.notion.com/v1",
        headers={
            "Authorization": f"Bearer {_token()}",
            "Notion-Version": VERSION,
            "Content-Type": "application/json",
        },
        timeout=30,
    )


def _page_id(arg: str) -> str:
    m = re.search(r"([0-9a-fA-F]{32})(?:[?#].*)?$", arg.replace("-", ""))
    if not m:
        sys.exit(f"Could not find a page id in: {arg}")
    return m.group(1)


def _check(r: "httpx.Response") -> dict:
    if r.status_code >= 400:
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        sys.exit(f"Notion {r.status_code}: {body.get('code')} - {body.get('message', r.text[:200])}")
    return r.json()


def _plain(rich: list) -> str:
    return "".join(t.get("plain_text", "") for t in rich)


def cmd_list(c: "httpx.Client", show_all: bool) -> None:
    flt = {"and": [{"property": "Source", "select": {"equals": "Onyx Roadmap"}}]}
    if not show_all:
        flt["and"].append({"property": "Status", "select": {"does_not_equal": "Done"}})
    cursor = None
    while True:
        body = {"filter": flt, "page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        data = _check(c.post(f"/data_sources/{DATA_SOURCE}/query", json=body))
        for p in data["results"]:
            pr = p["properties"]
            title = _plain(pr["Task"]["title"])
            status = (pr["Status"]["select"] or {}).get("name", "")
            prio = (pr["Priority"]["select"] or {}).get("name", "")
            print(f"{status:<12} {prio:<8} {title[:90]}  {p['url']}")
        if not data.get("has_more"):
            break
        cursor = data["next_cursor"]


def cmd_notes(c: "httpx.Client", page: str) -> None:
    p = _check(c.get(f"/pages/{_page_id(page)}"))
    print(_plain(p["properties"]["Notes"]["rich_text"]))


def cmd_append(c: "httpx.Client", page: str, text: str) -> None:
    pid = _page_id(page)
    p = _check(c.get(f"/pages/{pid}"))
    rich = p["properties"]["Notes"]["rich_text"]
    before = _plain(rich)
    try:
        new = build_append(rich, text)
    except NotesLimitError as e:
        sys.exit(str(e))
    after = _check(c.patch(f"/pages/{pid}", json={"properties": {"Notes": {"rich_text": new}}}))
    # Notion answers with the page as stored: check the earlier text is still there, unchanged.
    stored = _plain(after["properties"]["Notes"]["rich_text"])
    where = after.get("url", pid)
    if not stored.startswith(before):
        sys.exit(f"WROTE, BUT THE EARLIER NOTES TEXT CHANGED ({len(before)} chars before, {len(stored)} "
                 f"stored now). Restore it from the page history: {where}")
    if stored[len(before):] != ("\n" if rich else "") + text:
        sys.exit(f"Wrote; earlier text is unchanged, but the new note is not stored exactly as sent "
                 f"({len(stored) - len(before)} chars stored). Check the row: {where}")
    print(f"appended {len(text)} chars to {_plain(p['properties']['Task']['title'])[:60]!r} "
          f"(earlier {len(before)} chars unchanged, {len(new)} rich-text objects)")


def cmd_status(c: "httpx.Client", page: str, status: str) -> None:
    if status not in STATUSES:
        sys.exit(f"Status must be one of {sorted(STATUSES)}")
    _check(c.patch(f"/pages/{_page_id(page)}", json={"properties": {"Status": {"select": {"name": status}}}}))
    print(f"status -> {status}")


def main(argv: list) -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles default to cp1252
    if len(argv) < 2 or argv[1] not in {"list", "notes", "append", "status"}:
        sys.exit(__doc__)
    cmd = argv[1]
    with _client() as c:
        if cmd == "list":
            cmd_list(c, "--all" in argv)
        elif cmd == "notes" and len(argv) == 3:
            cmd_notes(c, argv[2])
        elif cmd == "append" and len(argv) == 4:
            cmd_append(c, argv[2], argv[3])
        elif cmd == "status" and len(argv) == 4:
            cmd_status(c, argv[2], argv[3])
        else:
            sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
