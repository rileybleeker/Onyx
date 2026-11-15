"""Onyx AI tool usage harvester: daily metadata about Riley's Claude Code and Codex sessions on this PC.

Reads the session logs both tools keep on the PC:
  Claude Code  ~/.claude/projects/<project>/<session>.jsonl           one file per session
               ~/.claude/projects/<project>/<session>/**/*.jsonl      that session's subagent transcripts
  Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]     one file per thread (older ones zstd)
and upserts ONE row per (device, behavioral day, tool, project folder name) to pds.ai_tool_usage_daily
(sql/ai_tool_usage_schema.sql) with the service-role key in ~/.onyx_supabase_secret, the write path of
the PC activity logger. Every run writes an ai_usage|sessions heartbeat to pds.sync_log, success or failure.

PRIVACY (the point of this file). The logs hold whole conversations: prompts, replies, file contents,
command output and possibly secrets. Each line is parsed in memory and only these are taken from it:
its time, its record type, the model name, token counts, whether it is a user prompt or a tool call,
the client it came from (only to leave out SDK / exec runs) and, once per session, the working folder,
cut to the folder NAME. No prompt or reply text, tool input or output, file path, branch, title or id is
kept, printed, logged or uploaded. Rows are checked against an allow-list (check_row) before anything is
sent; a row that fails stops the upload and writes a failed "GUARD privacy:" heartbeat.
tests/test_ai_usage_harvest.py feeds synthetic logs full of sentinel strings and fails if any of them
reaches the rows, the printed summary or the heartbeat.

Counting rules:
  - sessions / prompts / active minutes: top-level sessions only (Claude Code subagent transcripts and
    Codex subagent threads are not sessions); tokens, tool calls and the subagent count include them.
  - SDK runs (Claude Code entrypoint sdk-*) and Codex exec runs are left out: they are automation, not
    Riley at the PC.
  - A record goes to the behavioral day of its local time (ADR-0001: 00:00-05:59 belongs to the day
    before), in the PC's time zone. Late = local 21:00-05:59, after midnight = 00:00-05:59.
  - Records repeated by a resumed or forked session are counted once (record uuid / message id / line).
  - Codex times come from its turn / item events (started_at, completed_at_ms) where present: the
    desktop app sometimes writes a turn's lines later in one batch (see read_codex).
  - A day is uploaded until it has ended (plus an hour); after that it is final and never sent again,
    so Claude Code deleting old logs (after ~30 days) can never shrink a stored day. Claude Code days
    older than CLAUDE_SAFE_DAYS are not sent on the first run either (some of their files may be gone).

Commands:
  python ai_usage_harvest.py            harvest and upload (what the scheduled task runs, via pythonw.exe)
  python ai_usage_harvest.py --dry-run  read the logs and print aggregate counts only; writes nothing

Standard library only (zstd needs Python 3.14+; without it the .zst files are skipped and counted).
The JSONL layouts are undocumented and change between versions: unknown records are ignored, never fatal.
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
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, time as dtime, timedelta, timezone, tzinfo
from logging.handlers import RotatingFileHandler
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Iterable, Iterator, Optional

ROOT = Path(__file__).resolve().parents[2]
for _p in (ROOT, ROOT / "tools" / "pc_activity_logger"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

# The PC's Supabase write path, shared with the PC activity logger: PostgREST over urllib, the
# service-role key read from ~/.onyx_supabase_secret (never printed or logged), errors that carry the
# HTTP status and Postgres code only.
from activity_logger import HttpError, Rest, make_client, safe_device  # noqa: E402

SOURCE, DATA_TYPE = "ai_usage", "sessions"  # pds.sync_log heartbeat key
TABLE = "ai_tool_usage_daily"
ON_CONFLICT = "device,behavioral_date,tool,project"
CLAUDE, CODEX = "claude_code", "codex"
TOOLS = (CLAUDE, CODEX)

BEHAVIORAL_SHIFT = timedelta(hours=6)  # ADR-0001: 00:00-05:59 local belongs to the day before
SETTLE = timedelta(hours=1)            # a day is final once it ended this long before a run started
CLAUDE_SAFE_DAYS = 25                  # Claude Code removes logs ~30 days after their last write
SCAN_MARGIN_S = 86400                  # files changed this long before the first open day are still read
MAX_MODELS = 10

COLUMNS = (
    "device", "behavioral_date", "tool", "project",
    "sessions", "subagents", "prompts", "tool_calls",
    "active_minutes", "late_active_minutes", "after_midnight_active_minutes", "session_minutes",
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    "models", "first_activity", "last_activity", "synced_at",
)
INT_COLUMNS = COLUMNS[4:16]
TOKEN_COLUMNS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")

_PROJECT_OK = re.compile(r"^[a-z0-9._-]{1,64}$")
_PROJECT_BAD = re.compile(r"[^a-z0-9._-]")
_MODEL_OK = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,63}$")
_DEVICE_OK = re.compile(r"^[a-z0-9._-]{1,40}$")
_DATE_OK = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TS_OK = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$")
_CLAUDE_MSG = re.compile(r'"type"\s*:\s*"(?:user|assistant)"')  # cheap filter before json.loads

CODEX_CALLS = frozenset({"function_call", "custom_tool_call", "local_shell_call", "web_search_call"})
CODEX_ITEM_CALLS = frozenset({"CommandExecution", "FileChange", "McpToolCall", "WebSearch", "ImageView"})
CODEX_TOKEN_FIELDS = ("input_tokens", "cached_input_tokens", "output_tokens", "cache_write_input_tokens")

log = logging.getLogger("ai_usage")


class PrivacyGuard(Exception):
    """A row failed the allow-list. The message names the rule, never the value."""


class ZstdUnavailable(Exception):
    """A .zst log and no zstd module (Python < 3.14)."""


# ---------------------------------------------------------------- small pure helpers (unit tested)
def parse_ts(v) -> Optional[float]:
    """ISO-8601 timestamp -> epoch seconds. Anything else -> None."""
    if not isinstance(v, str) or not 10 <= len(v) <= 40:
        return None
    try:
        dt = datetime.fromisoformat(v[:-1] + "+00:00" if v.endswith("Z") else v)
    except ValueError:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp()


def _int(v) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else 0


def clean_model(v) -> Optional[str]:
    """A model name such as 'claude-opus-5-5' or 'gpt-5.5-codex'; anything else (e.g. '<synthetic>') -> None."""
    if not isinstance(v, str):
        return None
    m = v.strip().lower()
    return m if _MODEL_OK.match(m) else None


def project_name(cwd, home: Optional[str] = None, excluded: frozenset = frozenset()) -> str:
    """Working folder -> its folder NAME only, lower case, [a-z0-9._-], at most 64 chars.

    'C:\\Users\\riley\\Onyx' -> 'onyx'; a Claude Code worktree '...\\Onyx\\.claude\\worktrees\\agent-x' -> 'onyx'
    (the repo, not the throwaway worktree); the home folder itself -> 'home' (its name is the user name);
    a name listed in exclude.txt -> 'other'. The rest of the path is never kept.
    """
    if not isinstance(cwd, str) or not cwd.strip():
        return "unknown"
    raw = cwd.strip()
    windows = "\\" in raw or re.match(r"^[A-Za-z]:", raw) is not None
    path = PureWindowsPath(raw) if windows else PurePosixPath(raw)
    if home:
        def norm(s: str) -> str:
            return s.replace("\\", "/").rstrip("/").lower()
        if norm(raw) == norm(home):
            return "home"
    parts = path.parts
    lower = [p.lower() for p in parts]
    name = path.name  # "" for a drive or root
    for i in range(2, len(lower)):
        if lower[i] == "worktrees" and lower[i - 1] == ".claude":
            name = parts[i - 2]
            break
    name = _PROJECT_BAD.sub("_", name.lower())[:64].strip("._-")
    if not name:
        return "unknown"
    return "other" if name in excluded else name


def is_prompt(content) -> bool:
    """A Claude Code user record that Riley typed (text / image), not a tool result. Reads block types only."""
    if isinstance(content, str):
        return bool(content.strip())
    if not isinstance(content, list):
        return False
    types = {b.get("type") for b in content if isinstance(b, dict)}
    return "tool_result" not in types and bool(types & {"text", "image"})


def is_automated(tool: str, client: Optional[str]) -> bool:
    """SDK-driven Claude Code runs and Codex exec runs are automation, not interactive use."""
    c = (client or "").lower()
    return c.startswith("sdk") if tool == CLAUDE else "exec" in c


def codex_token_delta(prev: Optional[tuple], total, last) -> Optional[tuple]:
    """One Codex token_count event -> (uncached input, output, cache read, cache write) it adds, or None.

    total_token_usage is cumulative per thread, so the usage of this event is the difference from the
    previous one (a repeated event adds 0). The first event of a file uses last_token_usage instead: a
    forked thread starts from its parent's total, which was already counted in the parent's file.
    Codex counts cached tokens inside input_tokens, so the uncached part is input - cached.
    """
    def fields(d):
        return tuple(_int(d.get(f)) for f in CODEX_TOKEN_FIELDS) if isinstance(d, dict) else None

    tot, lst = fields(total), fields(last)
    if tot is not None and prev is not None and all(a >= b for a, b in zip(tot, prev)):
        d = tuple(a - b for a, b in zip(tot, prev))
    else:
        d = lst if lst is not None else (tot if prev is None else None)
    if not d or not any(d):
        return None
    inp, cached, out, cache_write = d
    return (max(0, inp - cached), out, cached, cache_write)


def local_dt(ts: float, tz: Optional[tzinfo] = None) -> datetime:
    """Epoch -> aware local time (the PC's zone, or tz in tests)."""
    return datetime.fromtimestamp(ts, tz) if tz else datetime.fromtimestamp(ts, timezone.utc).astimezone()


def behavioral_day(ts: float, tz: Optional[tzinfo] = None) -> date:
    return (local_dt(ts, tz) - BEHAVIORAL_SHIFT).date()


def last_complete_day(now_local: datetime) -> date:
    """The newest behavioral day that ended at least SETTLE before now_local."""
    return (now_local - BEHAVIORAL_SHIFT - SETTLE).date() - timedelta(days=1)


def scan_cutoff(final_through: Optional[date], tz: Optional[tzinfo] = None) -> float:
    """Files last written before this epoch hold nothing for the days still open (-inf: read everything)."""
    if final_through is None:
        return float("-inf")
    start = datetime.combine(final_through + timedelta(days=1), dtime(6), tzinfo=tz)  # naive = PC local
    return start.timestamp() - SCAN_MARGIN_S


def in_window(tool: str, day: date, final_through: Optional[date], today_b: date) -> bool:
    if final_through is not None and day <= final_through:
        return False
    return not (tool == CLAUDE and day < today_b - timedelta(days=CLAUDE_SAFE_DAYS))


# ---------------------------------------------------------------- reading the logs
@dataclass
class Transcript:
    """What one log file contributes. Times are epoch seconds; nothing here is text from the log."""

    tool: str
    main: bool                                        # a top-level session (False: subagent transcript)
    project: str = "unknown"
    client: Optional[str] = None                      # entrypoint / originator, only for is_automated()
    activity: list = field(default_factory=list)      # conversation records (top-level sessions only)
    prompts: list = field(default_factory=list)
    tool_calls: list = field(default_factory=list)
    usage: list = field(default_factory=list)         # (epoch, model|None, input, output, cache_read, cache_write)


class Seen:
    """Keys already counted in this run (in memory only): resumed / forked sessions repeat records."""

    def __init__(self) -> None:
        self._keys: set = set()

    def dup(self, kind: str, key) -> bool:
        if isinstance(key, str):
            key = hashlib.blake2b(key.encode("utf-8", "replace"), digest_size=16).digest()
        k = (kind, key)
        if k in self._keys:
            return True
        self._keys.add(k)
        return False


def _zstd_open():
    try:
        from compression import zstd  # Python 3.14+
    except ImportError:
        return None
    return zstd.open


def iter_lines(path: Path) -> Iterator[str]:
    if path.name.endswith(".zst"):
        opener = _zstd_open()
        if opener is None:
            raise ZstdUnavailable()
        fh = opener(path, "rt", encoding="utf-8", errors="replace")
    else:
        fh = open(path, encoding="utf-8", errors="replace")
    with fh:
        for line in fh:
            line = line.strip()
            if line:
                yield line


def _loads(line: str) -> Optional[dict]:
    try:
        row = json.loads(line)
    except ValueError:  # a torn last line (the session is still writing) or a foreign line
        return None
    return row if isinstance(row, dict) else None


def read_claude(path: Path, main: bool, seen: Seen, home: Optional[str], excluded: frozenset) -> Transcript:
    tr = Transcript(CLAUDE, main)
    cwd = None
    by_message: dict = {}  # message id -> [first epoch, model, input, output, cache_read, cache_write]
    for line in iter_lines(path):
        if not _CLAUDE_MSG.search(line):
            continue
        r = _loads(line)
        if r is None or r.get("type") not in ("user", "assistant"):
            continue
        ts = parse_ts(r.get("timestamp"))
        if ts is None:
            continue
        uid = r.get("uuid")
        if seen.dup("claude_record", uid if isinstance(uid, str) and uid else line):
            continue
        if tr.client is None and isinstance(r.get("entrypoint"), str):
            tr.client = r["entrypoint"][:40]
        if cwd is None and isinstance(r.get("cwd"), str):
            cwd = r["cwd"]
        side = not main or r.get("isSidechain") is True  # an old-style subagent record inside the session file
        msg = r.get("message") if isinstance(r.get("message"), dict) else {}
        if not side:
            tr.activity.append(ts)
        if r["type"] == "user":
            if not side and not r.get("isMeta") and not r.get("isCompactSummary") and is_prompt(msg.get("content")):
                tr.prompts.append(ts)
            continue
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    bid = block.get("id")
                    if not (isinstance(bid, str) and bid and seen.dup("claude_call", bid)):
                        tr.tool_calls.append(ts)
        usage = msg.get("usage")
        if isinstance(usage, dict):
            # Claude Code writes one record per content block, each repeating the message's usage.
            mid = msg.get("id")
            if not (isinstance(mid, str) and mid):
                mid = uid if isinstance(uid, str) and uid else line
            vals = (_int(usage.get("input_tokens")), _int(usage.get("output_tokens")),
                    _int(usage.get("cache_read_input_tokens")), _int(usage.get("cache_creation_input_tokens")))
            prev = by_message.get(mid)
            if prev is None:
                by_message[mid] = [ts, clean_model(msg.get("model")), *vals]
            else:
                prev[2:] = [max(a, b) for a, b in zip(prev[2:], vals)]
                prev[1] = prev[1] or clean_model(msg.get("model"))
    for mid, (ts, model, *vals) in by_message.items():
        if not seen.dup("claude_message", mid):
            tr.usage.append((ts, model, *vals))
    tr.project = project_name(cwd, home, excluded)
    return tr


def epoch_any(v) -> Optional[float]:
    """An event time as Codex writes it (epoch seconds, epoch ms or ISO) -> epoch seconds, or None."""
    if isinstance(v, str):
        t = parse_ts(v)
    elif isinstance(v, (int, float)) and not isinstance(v, bool):
        t = v / 1000 if v > 1e11 else float(v)
    else:
        return None
    return t if t is not None and 1.5e9 < t < 4.1e9 else None


def codex_event_times(kind, ptype, p: dict) -> tuple:
    """(start, end) event times carried inside a Codex line's payload; either may be None."""
    if kind != "event_msg":
        return None, None
    if ptype == "item_completed":
        return epoch_any(p.get("started_at_ms")), epoch_any(p.get("completed_at_ms"))
    if ptype == "task_complete":
        return epoch_any(p.get("started_at")), epoch_any(p.get("completed_at"))
    if ptype in ("task_started", "turn_aborted"):
        return None, epoch_any(p.get("started_at"))
    return None, None


def read_codex(path: Path, seen: Seen, home: Optional[str], excluded: frozenset) -> Transcript:
    """One Codex thread file -> Transcript.

    When things happened: a line's own "timestamp" is when it was WRITTEN, and the Codex desktop app
    sometimes writes a turn's lines later in one batch (checked 2026-11-14: over an hour apart for ~10%
    of lines). Turn and item events carry the real times (started_at, completed_at_ms), so those are
    used; the other lines take the time of the event before them, unless the file's write times agree
    with its event times (then they are trusted as they are).
    """
    tr = Transcript(CODEX, True)
    cwd, meta_seen, model, prev_total, meta_ts = None, False, None, None, None
    entries = []  # (write time, event time, tag, data) in file order
    for line in iter_lines(path):
        if seen.dup("codex_line", line):  # a fork repeats its parent's lines
            continue
        r = _loads(line)
        if r is None:
            continue
        line_ts = parse_ts(r.get("timestamp"))
        kind = r.get("type")
        p = r.get("payload") if isinstance(r.get("payload"), dict) else {}
        ptype = p.get("type")
        if kind == "session_meta":
            if not meta_seen:  # the file's own thread; a fork can carry its parent's meta later on
                meta_seen = True
                cwd = p.get("cwd")
                tr.client = p.get("originator")[:40] if isinstance(p.get("originator"), str) else None
                tr.main = not (isinstance(p.get("source"), dict) or p.get("parent_thread_id"))
                meta_ts = parse_ts(p.get("timestamp")) or line_ts
            continue
        started, event_ts = codex_event_times(kind, ptype, p)
        tag, data = None, None
        if kind == "turn_context":
            model = clean_model(p.get("model")) or model
        elif ptype == "thread_settings_applied" and isinstance(p.get("thread_settings"), dict):
            model = clean_model(p["thread_settings"].get("model")) or model
        elif kind == "response_item" and ptype in CODEX_CALLS:
            tag = "call_response"
        elif kind == "event_msg" and ptype == "user_message":
            tag = "prompt_event"
        elif kind == "event_msg" and ptype == "item_completed" and isinstance(p.get("item"), dict):
            itype = p["item"].get("type")
            tag = "prompt_item" if itype == "UserMessage" else "call_item" if itype in CODEX_ITEM_CALLS else None
        elif kind == "event_msg" and ptype == "token_count" and isinstance(p.get("info"), dict):
            info = p["info"]
            delta = codex_token_delta(prev_total, info.get("total_token_usage"), info.get("last_token_usage"))
            if isinstance(info.get("total_token_usage"), dict):
                prev_total = tuple(_int(info["total_token_usage"].get(f)) for f in CODEX_TOKEN_FIELDS)
            if delta:
                tag, data = "usage", (model, *delta)
        if started is not None:
            entries.append((None, started, None, None))
        entries.append((line_ts, event_ts, tag, data))

    pairs = [(a, b) for a, b, _, _ in entries if a is not None and b is not None]
    trust_writes = not pairs or sum(abs(a - b) <= 120 for a, b in pairs) >= 0.9 * len(pairs)
    clock = meta_ts
    found: dict = {"prompt_event": [], "prompt_item": [], "call_response": [], "call_item": []}
    for line_ts, event_ts, tag, data in entries:
        if event_ts is not None:
            ts = clock = event_ts
        elif trust_writes and line_ts is not None:
            ts = clock = line_ts
        else:
            ts = clock if clock is not None else line_ts
        if ts is None:
            continue
        tr.activity.append(ts)
        if tag == "usage":
            tr.usage.append((ts, *data))
        elif tag:
            found[tag].append(ts)
    # Codex versions log prompts and tool calls in one of two places, some in both: take the fuller one.
    tr.prompts = max(found["prompt_event"], found["prompt_item"], key=len)
    tr.tool_calls = max(found["call_response"], found["call_item"], key=len)
    if not tr.main:
        tr.activity, tr.prompts = [], []
    tr.project = project_name(cwd, home, excluded)
    return tr


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return float("inf")


def claude_files(base: Path) -> list:
    """(path, is_top_level_session), oldest first so a resumed session's copy comes after the original."""
    out = []
    if base.is_dir():
        for proj in base.iterdir():
            if not proj.is_dir():
                continue
            out += [(f, True) for f in proj.glob("*.jsonl")]
            for sub in proj.iterdir():
                if sub.is_dir():
                    out += [(f, False) for f in sub.rglob("*.jsonl")]
    return sorted(out, key=lambda x: (_mtime(x[0]), str(x[0])))


def codex_files(base: Path) -> list:
    out = list(base.rglob("*.jsonl")) + list(base.rglob("*.jsonl.zst")) if base.is_dir() else []
    return sorted(out, key=lambda f: (_mtime(f), str(f)))


def collect(claude_dir: Path, codex_dir: Path, final_through: dict, home: Optional[str],
            excluded: frozenset, tz: Optional[tzinfo] = None) -> tuple:
    """Read every log file that can hold an open day -> (transcripts, counts)."""
    seen, stats, out = Seen(), Counter(), []
    sources = [(CLAUDE, claude_files(claude_dir)), (CODEX, [(f, True) for f in codex_files(codex_dir)])]
    for tool, files in sources:
        cutoff = scan_cutoff(final_through.get(tool), tz)
        for path, main in files:
            if _mtime(path) < cutoff:
                stats[f"{tool}.files_unchanged"] += 1
                continue
            try:
                tr = read_claude(path, main, seen, home, excluded) if tool == CLAUDE \
                    else read_codex(path, seen, home, excluded)
            except ZstdUnavailable:
                stats[f"{tool}.files_zst_unsupported"] += 1
                continue
            except Exception:  # noqa: BLE001 - locked file or a layout this parser does not know: skip it
                stats[f"{tool}.files_unreadable"] += 1
                continue
            stats[f"{tool}.files_read"] += 1
            if is_automated(tool, tr.client):
                stats[f"{tool}.files_automated_left_out"] += 1
                continue
            out.append(tr)
    return out, stats


# ---------------------------------------------------------------- aggregation (pure, unit tested)
@dataclass
class Group:
    sessions: int = 0
    subagents: int = 0
    prompts: int = 0
    tool_calls: int = 0
    minutes: set = field(default_factory=set)
    late: set = field(default_factory=set)
    after_midnight: set = field(default_factory=set)
    session_seconds: float = 0.0
    tokens: list = field(default_factory=lambda: [0, 0, 0, 0])
    models: set = field(default_factory=set)
    first: Optional[float] = None
    last: Optional[float] = None


def aggregate(transcripts: Iterable[Transcript], tz: Optional[tzinfo] = None) -> dict:
    """Transcripts -> {(behavioral_date, tool, project): Group}."""
    groups: dict = {}

    def group(ts: float, tr: Transcript):
        key = (behavioral_day(ts, tz), tr.tool, tr.project)
        g = groups.get(key)
        if g is None:
            g = groups[key] = Group()
        return g

    for tr in transcripts:
        if tr.main and tr.activity:
            acts = sorted(tr.activity)
            group(acts[0], tr).sessions += 1
            spans: dict = {}
            for ts in acts:
                g, lt = group(ts, tr), local_dt(ts, tz)
                minute = int(ts // 60)
                g.minutes.add(minute)
                if lt.hour >= 21 or lt.hour < 6:
                    g.late.add(minute)
                if lt.hour < 6:
                    g.after_midnight.add(minute)
                g.first = ts if g.first is None else min(g.first, ts)
                g.last = ts if g.last is None else max(g.last, ts)
                span = spans.setdefault(id(g), [g, ts, ts])
                span[2] = ts
            for g, a, b in spans.values():
                g.session_seconds += b - a
        elif not tr.main:
            work = [u[0] for u in tr.usage] + tr.tool_calls
            if work:
                group(min(work), tr).subagents += 1
        for ts in tr.prompts:
            group(ts, tr).prompts += 1
        for ts in tr.tool_calls:
            group(ts, tr).tool_calls += 1
        for ts, model, *vals in tr.usage:
            g = group(ts, tr)
            g.tokens = [a + b for a, b in zip(g.tokens, vals)]
            if model:
                g.models.add(model)
    return groups


def _iso(ts: Optional[float]) -> Optional[str]:
    return None if ts is None else datetime.fromtimestamp(int(ts), timezone.utc).isoformat()


def build_rows(groups: dict, device: str, synced_at: str) -> list:
    """Rows for pds.ai_tool_usage_daily: built from the allow-listed fields only."""
    rows = []
    for (day, tool, project), g in sorted(groups.items()):
        rows.append({
            "device": device, "behavioral_date": day.isoformat(), "tool": tool, "project": project,
            "sessions": g.sessions, "subagents": g.subagents, "prompts": g.prompts, "tool_calls": g.tool_calls,
            "active_minutes": len(g.minutes), "late_active_minutes": len(g.late),
            "after_midnight_active_minutes": len(g.after_midnight),
            "session_minutes": int(round(g.session_seconds / 60)),
            **dict(zip(TOKEN_COLUMNS, g.tokens)),
            "models": sorted(g.models)[:MAX_MODELS],
            "first_activity": _iso(g.first), "last_activity": _iso(g.last),
            "synced_at": synced_at,
        })
    return rows


def check_row(row: dict) -> None:
    """The allow-list every row passes before upload. Raises PrivacyGuard naming the rule, never the value."""
    if set(row) != set(COLUMNS):
        raise PrivacyGuard("unexpected columns")
    if not (isinstance(row["device"], str) and _DEVICE_OK.match(row["device"])):
        raise PrivacyGuard("device fails the allow-list")
    if row["tool"] not in TOOLS:
        raise PrivacyGuard("unknown tool")
    if not (isinstance(row["project"], str) and _PROJECT_OK.match(row["project"])):
        raise PrivacyGuard("project fails the allow-list")
    if not (isinstance(row["behavioral_date"], str) and _DATE_OK.match(row["behavioral_date"])):
        raise PrivacyGuard("behavioral_date is not a date")
    for c in INT_COLUMNS:
        v = row[c]
        if not isinstance(v, int) or isinstance(v, bool) or v < 0:
            raise PrivacyGuard(f"{c} is not a count")
    models = row["models"]
    if not (isinstance(models, list) and len(models) <= MAX_MODELS
            and all(isinstance(m, str) and _MODEL_OK.match(m) for m in models)):
        raise PrivacyGuard("models fail the allow-list")
    for c in ("first_activity", "last_activity", "synced_at"):
        v = row[c]
        if not (v is None and c != "synced_at") and not (isinstance(v, str) and _TS_OK.match(v)):
            raise PrivacyGuard(f"{c} is not a UTC timestamp")


def summarize(rows: list, stats: Counter, extra: Optional[dict] = None) -> dict:
    """Aggregate counts for the dry run / log line. No project names, models or dates beyond the range."""
    out: dict = {}
    for tool in TOOLS:
        mine = [r for r in rows if r["tool"] == tool]
        t = {k.split(".", 1)[1]: v for k, v in sorted(stats.items()) if k.startswith(tool + ".")}
        t.update({"rows": len(mine), "days": len({r["behavioral_date"] for r in mine}),
                  "projects": len({r["project"] for r in mine})})
        for c in INT_COLUMNS:
            t[c] = sum(r[c] for r in mine)
        out[tool] = t
    days = sorted({r["behavioral_date"] for r in rows})
    out["first_day"], out["last_day"] = (days[0], days[-1]) if days else (None, None)
    out.update(extra or {})
    return out


# ---------------------------------------------------------------- local state, Supabase, commands
def data_dir() -> Path:
    base = os.environ.get("ONYX_AI_USAGE_DIR") or os.path.join(
        os.environ.get("LOCALAPPDATA") or str(Path.home()), "Onyx", "ai-usage")
    p = Path(base)
    p.mkdir(parents=True, exist_ok=True)
    return p


def default_claude_dir() -> Path:
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(base) if base else Path.home() / ".claude") / "projects"


def default_codex_dir() -> Path:
    base = os.environ.get("CODEX_HOME")
    return (Path(base) if base else Path.home() / ".codex") / "sessions"


def load_state(d: Path) -> dict:
    try:
        state = json.loads((d / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


def save_state(d: Path, state: dict) -> None:
    tmp = d / "state.json.tmp"
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(tmp, d / "state.json")


def final_days(state: dict) -> dict:
    out = {}
    for tool in TOOLS:
        try:
            out[tool] = date.fromisoformat(str(state.get("final_through", {}).get(tool)))
        except (ValueError, AttributeError):
            out[tool] = None
    return out


def load_excluded(d: Path) -> frozenset:
    """exclude.txt: one project folder name per line; those are stored as 'other'."""
    try:
        lines = (d / "exclude.txt").read_text(encoding="utf-8").splitlines()
    except OSError:
        return frozenset()
    names = (project_name("/" + x.strip()) for x in lines if x.strip() and not x.lstrip().startswith("#"))
    return frozenset(n for n in names if n != "unknown")


def device_name() -> str:
    return safe_device(os.environ.get("ONYX_PC_DEVICE") or os.environ.get("COMPUTERNAME") or "pc")


def heartbeat(client: Optional[Rest], status: str, records: int, started_at: float,
              error: Optional[str] = None, rows: Optional[list] = None) -> None:
    from sync_log_helper import log_sync  # the one shared sync_log writer (swallows its own failures)

    if client is None:
        try:
            client = make_client()
        except HttpError as e:
            log.warning("heartbeat skipped: %s", e)
            return
    days = sorted({r["behavioral_date"] for r in rows or []})
    log_sync(client, SOURCE, DATA_TYPE, status, records=records, started_at=started_at, error=error,
             date_range_start=date.fromisoformat(days[0]) if days else None,
             date_range_end=date.fromisoformat(days[-1]) if days else None)


def run(dry_run: bool = False, *, claude_dir: Optional[Path] = None, codex_dir: Optional[Path] = None,
        data: Optional[Path] = None, tz: Optional[tzinfo] = None, now: Optional[datetime] = None,
        client: Optional[Rest] = None, home: Optional[str] = None) -> int:
    """One harvest. Prints one JSON line of counts. Returns 0 ok, 1 failed."""
    started = time.time()
    d = data or data_dir()
    state = load_state(d)
    final = final_days(state)
    now_local = now or (datetime.now(tz) if tz else datetime.now().astimezone())
    today_b = (now_local - BEHAVIORAL_SHIFT).date()
    rows: list = []
    try:
        transcripts, stats = collect(claude_dir or default_claude_dir(), codex_dir or default_codex_dir(),
                                     final, home if home is not None else str(Path.home()), load_excluded(d), tz)
        groups = aggregate(transcripts, tz)
        kept = {k: g for k, g in groups.items() if in_window(k[1], k[0], final.get(k[1]), today_b)}
        rows = build_rows(kept, device_name(), datetime.now(timezone.utc).isoformat())
        for row in rows:
            check_row(row)
        summary = summarize(rows, stats, {"ok": True, "dry_run": dry_run,
                                          "groups_outside_window": len(groups) - len(kept)})
        if not dry_run:
            if rows:
                client = client or make_client()
                client.upsert(TABLE, rows, ON_CONFLICT)
            skipped = sum(v for k, v in stats.items() if k.endswith((".files_unreadable", ".files_zst_unsupported")))
            if not skipped:
                done = last_complete_day(now_local)  # every day up to here was read complete and sent
                state["final_through"] = {t: max(done, final[t]).isoformat() if final[t] else done.isoformat()
                                          for t in TOOLS}
                save_state(d, state)
            heartbeat(client, "partial" if skipped else "success", len(rows), started, rows=rows,
                      error=f"{skipped} log files could not be read; their days stay open" if skipped else None)
        log.info("harvest ok%s: %d rows", " (dry run)" if dry_run else "", len(rows))
        print(json.dumps(summary))
        return 0
    except Exception as e:  # noqa: BLE001 - every failure must reach /status
        # Only our own messages or the exception's type name: a parser error's text could quote a log line.
        if isinstance(e, PrivacyGuard):
            msg = f"GUARD privacy: {e}"
        elif isinstance(e, HttpError):
            msg = str(e)
        else:
            msg = type(e).__name__
        log.error("harvest failed: %s", msg)
        if not dry_run:
            heartbeat(client, "failed", 0, started, error=msg)
        print(json.dumps({"ok": False, "dry_run": dry_run, "error": msg}))
        return 1


def setup_logging() -> None:
    handler = RotatingFileHandler(data_dir() / "harvest.log", maxBytes=256_000, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Onyx AI tool usage harvester (metadata only)")
    ap.add_argument("--dry-run", action="store_true", help="print aggregate counts only; write nothing")
    args = ap.parse_args(argv)
    setup_logging()
    return run(dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
