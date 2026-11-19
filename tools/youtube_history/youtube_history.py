"""Onyx YouTube watch history importer: Google Takeout export in OneDrive -> pds.youtube_watch_events.

Why a file importer: YouTube has no API for watch history (the Data API returned none since 2016 and the
Data Portability API is not offered to US accounts), and a signed-in harvester of myactivity.google.com
would keep a live Google session on the PC that also opens Gmail (the email-risk rule). So Riley sets up
ONE scheduled Google Takeout export (history only, JSON, every 2 months for a year) whose destination is
OneDrive, and this script, run daily by Task Scheduler, finds new exports there, parses
`watch-history.json` and upserts the events. Onyx holds no Google credential. Setup: docs/youtube-watch-history.md.

What a Takeout watch event carries: time, title ("Watched <title>"), video url, channel name + url. No watch
duration. Ads ("From Google Ads") and YouTube Music plays are in the same file; they are flagged, not dropped.
Community-post views ("Viewed ...") are not videos and are skipped. A removed video has no url and is stored
under video_id 'removed'.

Where it looks:
  $ONYX_YOUTUBE_TAKEOUT_DIR (searched 3 levels deep)  else  ~/OneDrive/Takeout  and the top level of ~/OneDrive.
An export is a `takeout-*.zip` or an extracted `Takeout` folder that contains `watch-history.json`
(any language folder name). Already-imported exports are remembered in %LOCALAPPDATA%\\Onyx\\youtube-history;
re-importing anything is harmless (upsert on watched_at + video_id).

Privacy: titles and channels go only to the owner-only table. Nothing about a video (title, id, channel) is
printed, logged or put in the heartbeat; output is counts and dates only (these logs may be shared).

Commands:
  python youtube_history.py                 import new exports (what the scheduled task runs, via pythonw.exe)
  python youtube_history.py --dry-run       parse and print counts only; writes nothing, needs no key
  python youtube_history.py --dry-run --file PATH   parse one watch-history.json / zip / folder

Standard library only. Heartbeat youtube|history on every real run (success / partial / failed).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sys
import time
import zipfile
from datetime import date, datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Iterable, Iterator, Optional
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[2]
for _p in (ROOT, ROOT / "tools" / "pc_activity_logger"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from activity_logger import HttpError, Rest, make_client  # noqa: E402  (the PC's shared PostgREST writer)

SOURCE, DATA_TYPE = "youtube", "history"  # pds.sync_log heartbeat key
TABLE = "youtube_watch_events"
ON_CONFLICT = "watched_at,video_id"
HISTORY_FILE = "watch-history.json"
STALE_EXPORT_DAYS = 100  # Takeout runs every 2 months; past this the schedule has probably ended (it lasts a year)
MAX_FILE_BYTES = 1_500_000_000
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ROW_KEYS = frozenset({"watched_at", "video_id", "title", "channel_name", "channel_id", "is_music", "is_ad",
                      "export_label"})

log = logging.getLogger("youtube_history")


# ---------------------------------------------------------------- parsing (pure)
def parse_time(raw: object) -> Optional[str]:
    """Takeout times are ISO-8601 UTC ('2026-01-02T03:04:05.678Z', milliseconds sometimes absent)."""
    if not isinstance(raw, str) or not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds")


def video_id_from_url(url: object) -> Optional[str]:
    if not isinstance(url, str) or not url:
        return None
    try:
        u = urlparse(url)
    except ValueError:
        return None
    vid = (parse_qs(u.query).get("v") or [None])[0]
    if vid is None and u.netloc.endswith("youtu.be"):
        vid = u.path.strip("/") or None
    return vid if vid and VIDEO_ID_RE.match(vid) else None


def channel_id_from_url(url: object) -> Optional[str]:
    if not isinstance(url, str):
        return None
    m = re.search(r"/channel/([A-Za-z0-9_-]{1,64})", url)
    return m.group(1) if m else None


def clean_title(raw: object) -> Optional[str]:
    if not isinstance(raw, str):
        return None
    t = raw.strip()
    if t.startswith("Watched "):
        t = t[len("Watched "):]
    return t[:500] or None


def event_row(ev: object, export_label: str) -> Optional[dict]:
    """One Takeout entry -> a table row, or None when it is not a video watch."""
    if not isinstance(ev, dict):
        return None
    title_raw = ev.get("title")
    if isinstance(title_raw, str) and (title_raw.startswith("Viewed ") or title_raw.startswith("Visited ")):
        return None  # community posts, channel visits: not a video
    at = parse_time(ev.get("time"))
    if at is None:
        return None
    url = ev.get("titleUrl")
    vid = video_id_from_url(url)
    if vid is None:
        # No usable id: a removed video (no url) is kept, it was watched; a url that is not a watch link is not.
        if url:
            return None
        vid = "removed"
    subs = ev.get("subtitles") if isinstance(ev.get("subtitles"), list) else []
    first = subs[0] if subs and isinstance(subs[0], dict) else {}
    products = ev.get("products") if isinstance(ev.get("products"), list) else []
    details = ev.get("details") if isinstance(ev.get("details"), list) else []
    is_music = ev.get("header") == "YouTube Music" or "YouTube Music" in products
    is_ad = any(isinstance(d, dict) and "Google Ads" in str(d.get("name", "")) for d in details)
    name = first.get("name")
    return {
        "watched_at": at,
        "video_id": vid,
        "title": clean_title(title_raw),
        "channel_name": name.strip()[:200] if isinstance(name, str) and name.strip() else None,
        "channel_id": channel_id_from_url(first.get("url")),
        "is_music": bool(is_music),
        "is_ad": bool(is_ad),
        "export_label": export_label,
    }


def build_rows(events: Iterable[object], export_label: str) -> list:
    """Rows deduplicated on the table key (a batch with one key twice makes the upsert fail). Copies are
    merged: per field the last non-empty value wins, so a later copy without channel fields never erases
    what an earlier copy knew (the upsert would overwrite the stored event). Output is oldest first."""
    rows: dict = {}
    for ev in events:
        r = event_row(ev, export_label)
        if r is None:
            continue
        key = (r["watched_at"], r["video_id"])
        old = rows.get(key)
        if old is not None:
            r = {k: (r[k] if r[k] not in (None, "") else old[k]) if k not in ("is_music", "is_ad")
                 else bool(r[k] or old[k]) for k in r}
        rows[key] = r
    return [rows[k] for k in sorted(rows)]


def check_rows(rows: list) -> None:
    for r in rows:
        if set(r) != ROW_KEYS:
            raise ValueError("row has unexpected keys")


# ---------------------------------------------------------------- finding exports
def home() -> Path:
    return Path.home()


def search_roots() -> list:
    env = os.environ.get("ONYX_YOUTUBE_TAKEOUT_DIR")
    if env:
        return [(Path(env), 3)]
    od = home() / "OneDrive"
    return [(od / "Takeout", 3), (od, 1)]


def _walk(root: Path, depth: int) -> Iterator[Path]:
    try:
        entries = list(root.iterdir())
    except OSError:
        return
    for p in entries:
        yield p
        if depth > 0 and p.is_dir():
            yield from _walk(p, depth - 1)


def find_exports(roots: Optional[list] = None) -> list:
    """Candidate exports as (label, path, kind), oldest first. kind is 'zip' or 'dir' (a folder holding a
    watch-history.json somewhere inside). The label is the file / folder NAME only."""
    seen: dict = {}
    for root, depth in (roots if roots is not None else search_roots()):
        if not root.is_dir():
            continue
        for p in _walk(root, depth):
            name = p.name.lower()
            if p.is_file() and name.startswith("takeout") and name.endswith(".zip"):
                seen[str(p)] = (p.name, p, "zip")
            elif p.is_dir() and name == "takeout":
                seen[str(p)] = (p.name, p, "dir")
            elif p.is_file() and name == HISTORY_FILE:
                seen[str(p.parent)] = (p.parent.name or "export", p.parent, "dir")

    dirs = [Path(k) for k, v in seen.items() if v[2] == "dir"]
    for k in [k for k, v in seen.items() if v[2] == "dir" and any(o != Path(k) and o in Path(k).parents for o in dirs)]:
        del seen[k]  # a folder inside another export folder is the same export

    def mtime(item):
        try:
            return item[1].stat().st_mtime
        except OSError:
            return 0.0

    return sorted(seen.values(), key=mtime)


def fingerprint(path: Path) -> str:
    """Hash of the CONTENT of the actual input: the zip file, or every watch-history.json inside a folder
    (relative path + bytes), so any change to them changes it. Folder mtimes/sizes do not."""
    h = hashlib.sha256()

    def feed(p: Path) -> None:
        with open(p, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)

    if path.is_file():
        feed(path)
    else:
        files = sorted((p for p in _walk(path, 6) if p.is_file() and p.name == HISTORY_FILE),
                       key=lambda p: p.relative_to(path).as_posix())
        for p in files:
            h.update(p.relative_to(path).as_posix().encode() + b"\0")
            feed(p)
    return h.hexdigest()[:24]


def read_history(path: Path, kind: str) -> Optional[list]:
    """The parsed JSON list of one export, or None when it holds no watch-history.json (not finished, or
    history was not selected). A zip is read in memory; a folder is searched for the file."""
    if kind == "zip":
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if n.rsplit("/", 1)[-1] == HISTORY_FILE]
            if not names:
                return None
            if z.getinfo(names[0]).file_size > MAX_FILE_BYTES:
                raise ValueError("watch-history.json too large")
            with z.open(names[0]) as fh:
                return _as_list(json.load(fh))
    for p in _walk(path, 6):
        if p.is_file() and p.name == HISTORY_FILE:
            if p.stat().st_size > MAX_FILE_BYTES:
                raise ValueError("watch-history.json too large")
            with open(p, encoding="utf-8") as fh:
                return _as_list(json.load(fh))
    return None


def _as_list(data: object) -> list:
    if not isinstance(data, list):
        raise ValueError("watch-history.json is not a list (format changed?)")
    return data


# ---------------------------------------------------------------- state
def data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(home() / ".local" / "share")
    d = Path(base) / "Onyx" / "youtube-history"
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_state(d: Path) -> dict:
    try:
        s = json.loads((d / "state.json").read_text(encoding="utf-8"))
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(d: Path, state: dict) -> None:
    tmp = d / "state.json.tmp"
    tmp.write_text(json.dumps(state), encoding="utf-8")
    os.replace(tmp, d / "state.json")


# ---------------------------------------------------------------- run
def heartbeat(client: Optional[Rest], status: str, records: int, started_at: float,
              error: Optional[str] = None, newest: Optional[str] = None) -> None:
    from sync_log_helper import log_sync  # the one shared sync_log writer (swallows its own failures)

    if client is None:
        try:
            client = make_client()
        except HttpError as e:
            log.warning("heartbeat skipped: %s", e)
            return
    d = date.fromisoformat(newest) if newest else None
    log_sync(client, SOURCE, DATA_TYPE, status, records=records, started_at=started_at, error=error,
             date_range_end=d)


def summarize(rows: list) -> dict:
    if not rows:
        return {"events": 0}
    return {"events": len(rows), "first": rows[0]["watched_at"][:10], "last": rows[-1]["watched_at"][:10],
            "music": sum(r["is_music"] for r in rows), "ads": sum(r["is_ad"] for r in rows),
            "removed": sum(r["video_id"] == "removed" for r in rows)}


def run(dry_run: bool = False, only: Optional[Path] = None, roots: Optional[list] = None,
        client: Optional[Rest] = None) -> int:
    started = time.time()
    d = data_dir()
    state = load_state(d)
    done = state.setdefault("done", {})
    exports = ([(only.name, only, "zip" if only.suffix.lower() == ".zip" else "dir")] if only
               else find_exports(roots))
    total, newest, imported, skipped_empty = 0, state.get("newest"), 0, 0
    try:
        for label, path, kind in exports:
            fp = fingerprint(path)
            if fp in done and not only:
                continue
            events = read_history(path, kind)
            if events is None:
                skipped_empty += 1  # no watch-history.json (yet): look again next run
                continue
            rows = build_rows(events, label)
            if events and not rows:
                raise ValueError("no watch events recognised (format changed?)")
            check_rows(rows)
            print(json.dumps({"export": label, **summarize(rows)}))
            if not dry_run:
                client = client or make_client()
                if rows:
                    client.upsert(TABLE, rows, ON_CONFLICT)
                done[fp] = {"imported": datetime.now(timezone.utc).isoformat(), "events": len(rows)}
                save_state(d, state)
            total += len(rows)
            imported += 1
            if rows:
                newest = max(newest or "", rows[-1]["watched_at"][:10])
        if dry_run:
            print(json.dumps({"ok": True, "dry_run": True, "exports": imported, "events": total}))
            return 0
        if newest:
            state["newest"] = newest
        status, msg = "success", None
        last_import = max((v["imported"] for v in done.values()), default=None)
        if imported == 0 and not done:
            status = "partial"
            msg = ("No Takeout export found in OneDrive yet - set up the scheduled export "
                   "(docs/youtube-watch-history.md)." + (" One export has no watch-history.json." if skipped_empty else ""))
        elif imported == 0 and last_import:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(last_import)).days
            if age > STALE_EXPORT_DAYS:
                status = "partial"
                msg = (f"Last Takeout export imported {age} days ago; the scheduled export may have ended "
                       "(it lasts one year) - set it up again.")
        if newest and msg is None:
            msg = f"Newest watch {newest}"
        save_state(d, state)
        heartbeat(client, status, total, started, error=msg, newest=newest)
        print(json.dumps({"ok": True, "exports": imported, "events": total, "status": status}))
        return 0
    except Exception as e:  # noqa: BLE001 - every failure must reach /status
        msg = str(e) if isinstance(e, HttpError) else type(e).__name__
        log.error("import failed: %s", msg)
        if not dry_run:
            save_state(d, state)
            heartbeat(client, "failed", 0, started, error=msg)
        print(json.dumps({"ok": False, "dry_run": dry_run, "error": msg}))
        return 1


def setup_logging() -> None:
    d = data_dir()
    h = RotatingFileHandler(d / "youtube_history.log", maxBytes=200_000, backupCount=2, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(h)
    log.setLevel(logging.INFO)


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Import the Google Takeout YouTube watch history from OneDrive.")
    ap.add_argument("--dry-run", action="store_true", help="parse and print counts only; write nothing")
    ap.add_argument("--file", help="with --dry-run: one watch-history.json, takeout zip or folder")
    args = ap.parse_args(argv)
    setup_logging()
    only = None
    if args.file:
        if not args.dry_run:
            print(json.dumps({"ok": False, "error": "--file needs --dry-run"}))
            return 2
        p = Path(args.file)
        only = p.parent if p.is_file() and p.name == HISTORY_FILE else p
    return run(dry_run=args.dry_run, only=only)


if __name__ == "__main__":
    sys.exit(main())
