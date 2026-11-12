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

`append` reads the existing Notes rich-text objects and adds one more to the end, so
earlier text, links and formatting are kept exactly. It never prints the token.
"""
import os
import pathlib
import re
import sys

import httpx

DATA_SOURCE = "6149d32a-66be-4e54-ab1b-28c4a11c6543"  # Tasks
VERSION = "2025-09-03"
STATUSES = {"Not Started", "In Progress", "Blocked", "Done"}


def _token() -> str:
    tok = os.environ.get("NOTION_API_KEY")
    if not tok:
        path = pathlib.Path.home() / ".notion_token"
        if path.exists():
            tok = path.read_text().strip()
    if not tok:
        sys.exit("No Notion token: set NOTION_API_KEY or put it in ~/.notion_token")
    return tok


def _client() -> httpx.Client:
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


def _check(r: httpx.Response) -> dict:
    if r.status_code >= 400:
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        sys.exit(f"Notion {r.status_code}: {body.get('code')} - {body.get('message', r.text[:200])}")
    return r.json()


def _plain(rich: list) -> str:
    return "".join(t.get("plain_text", "") for t in rich)


def cmd_list(c: httpx.Client, show_all: bool) -> None:
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


def cmd_notes(c: httpx.Client, page: str) -> None:
    p = _check(c.get(f"/pages/{_page_id(page)}"))
    print(_plain(p["properties"]["Notes"]["rich_text"]))


def cmd_append(c: httpx.Client, page: str, text: str) -> None:
    pid = _page_id(page)
    p = _check(c.get(f"/pages/{pid}"))
    rich = p["properties"]["Notes"]["rich_text"]
    # Keep the existing objects verbatim (the API accepts them back as-is) and add new text
    # in <=2000-char pieces (Notion's per-item limit). A newline starts the new paragraph.
    keep = [{"type": "text", "text": t["text"], "annotations": t.get("annotations", {})}
            if t.get("type") == "text" else t for t in rich]
    chunks = ["\n" + text[i:i + 1999] if i == 0 else text[i:i + 2000] for i in range(0, len(text), 1999)]
    new = keep + [{"type": "text", "text": {"content": ch}} for ch in chunks]
    if len(new) > 100:
        sys.exit("Notes would exceed Notion's 100 rich-text items; shorten the note or edit by hand")
    _check(c.patch(f"/pages/{pid}", json={"properties": {"Notes": {"rich_text": new}}}))
    print(f"appended {len(text)} chars to {_plain(p['properties']['Task']['title'])[:60]!r}")


def cmd_status(c: httpx.Client, page: str, status: str) -> None:
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
