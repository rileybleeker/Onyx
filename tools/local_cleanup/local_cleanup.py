"""Onyx local cleanup: sends leftover agent scratch and test temp folders in %TEMP% to the Recycle Bin.

A DRY RUN IS THE DEFAULT. It prints, per category, how many items and how much space it would
recycle, and how many it keeps and why. It changes nothing on disk.

    python local_cleanup.py              # dry run (same as --dry-run)
    python local_cleanup.py --list       # dry run, plus every item, its size and why it is kept
    python local_cleanup.py --apply      # send the selected items to the Recycle Bin

Only %TEMP% is looked at, and in it only these names (case does not matter):

    claude-scratch  claude\\<project>\\<session-uuid>      Claude Code session scratch folders
    ui-copies       onyx-*-ui-XXXXXX   (folders)           frontend copies made by UI test scripts
    test-temp       onyx-wins-*, onyx-install-builds-*, onyx-supp-reminders-*   (folders)
    edit-scripts    edit_*.py, patch*.py   (files)         one-off agent edit scripts
    claude-cwd      claude-*-cwd   (files)                 Claude Code shell working-directory files
    playwright      playwright-artifacts-*, playwright_chromiumdev_profile-*   (folders)

An item is KEPT when any of these holds:
  - it is, or contains anywhere, something named .git (git worktrees belong to the personal-agents
    "Branch Cleanup" task);
  - it is the scratch folder of a Claude session listed in ~\\.claude\\sessions\\*.json ("sessionId");
    if any of those files cannot be read, no scratch folder is touched that run;
  - anything in it was modified or created in the last 12 hours;
  - its path, or the path of anything in it, is longer than 259 characters (the Recycle Bin call
    cannot take those, and a half-recycled folder is worse than none);
  - it is itself a link or junction. Links INSIDE an item are never followed (their target is not
    measured, read or recycled; on the same drive the Recycle Bin moves the link itself);
  - it lies in %LOCALAPPDATA%\\Onyx, ~\\.codex or ~\\.claude\\projects (all outside %TEMP%; checked anyway,
    and the run refuses to start if %TEMP% overlaps one of them);
  - it is over 10 GB, or past this run's limit (--max-items, --max-gb; the oldest go first).

--apply checks every item again right before recycling it and skips it if anything changed. It
recycles with shell32 SHFileOperationW (FO_DELETE with FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT
| FOF_NOERRORUI, plus FOF_WANTNUKEWARNING so Windows asks instead of silently deleting anything it
could not put in the Recycle Bin). Nothing is ever deleted permanently: restore from the Recycle Bin.
One run at a time (a named mutex). --apply appends what it did to
%LOCALAPPDATA%\\Onyx\\local-cleanup\\cleanup.log (paths, sizes and counts; no file contents).
Standard library only. It starts no child processes. Docs: docs/local-cleanup.md.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

RECENT_HOURS = 12
MAX_PATH_CHARS = 259          # SHFileOperationW takes MAX_PATH (260) including the closing NUL
MAX_ITEM_BYTES = 10 * 1024 ** 3
DEFAULT_MAX_ITEMS = 2000
DEFAULT_MAX_GB = 20.0
LOG_MAX_BYTES = 1024 ** 2
FILE_ATTRIBUTE_REPARSE_POINT = 0x400

SCRATCH = "claude-scratch"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
# (category, kind, name pattern) for items directly in %TEMP%. The first match wins.
TOP_LEVEL = (
    ("ui-copies", "dir", re.compile(r"^onyx-.+-ui-[A-Za-z0-9_]{6}$", re.I)),
    ("test-temp", "dir", re.compile(r"^onyx-(wins|install-builds|supp-reminders)-.+$", re.I)),
    ("edit-scripts", "file", re.compile(r"^(edit_|patch).*\.py$", re.I)),
    ("claude-cwd", "file", re.compile(r"^claude-.*-cwd$", re.I)),
    ("playwright", "dir", re.compile(r"^(playwright-artifacts-|playwright_chromiumdev_profile-).+$", re.I)),
)
CATEGORIES = (SCRATCH,) + tuple(c for c, _, _ in TOP_LEVEL)

# Why an item is kept, in the order they are checked (the first one that holds is reported).
REASONS = {
    "protected": "inside a protected folder",
    "link": "is a link or junction (not followed)",
    "sessions-unreadable": "Claude session list unreadable",
    "active-session": "scratch of a listed Claude session",
    "unreadable": "could not be read in full",
    "git": "contains .git (worktree)",
    "recent": f"modified in the last {RECENT_HOURS} h",
    "long-path": f"path over {MAX_PATH_CHARS} characters",
    "too-big": f"over {MAX_ITEM_BYTES // 1024 ** 3} GB",
    "run-limit": "over this run's limit (next run)",
}

# shell32 SHFileOperationW
FO_DELETE = 0x0003
FOF_SILENT = 0x0004
FOF_NOCONFIRMATION = 0x0010
FOF_ALLOWUNDO = 0x0040
FOF_NOERRORUI = 0x0400
FOF_WANTNUKEWARNING = 0x4000
RECYCLE_FLAGS = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING


@dataclass
class Item:
    path: str
    category: str
    is_dir: bool = False
    size: int = 0
    newest: float = 0.0
    links: int = 0
    reason: str = ""  # "" = selected for recycling; otherwise a key of REASONS


@dataclass
class Walk:
    size: int = 0
    newest: float = 0.0
    longest: int = 0
    links: int = 0
    git: bool = False
    error: bool = False


@dataclass
class Result:
    recycled: list = field(default_factory=list)   # Items
    changed: list = field(default_factory=list)    # (Item, reason key)
    failed: list = field(default_factory=list)     # (Item, error text)


# ---------------------------------------------------------------- paths and rules (pure, tested)
def _norm(p) -> str:
    return os.path.normcase(os.path.abspath(str(p))).rstrip("\\/") or os.sep


def _within(path, root) -> bool:
    p, r = _norm(path), _norm(root)
    return p == r or p.startswith(r + os.sep)


def _lstat(path):
    try:
        return os.lstat(path)
    except OSError:
        return None


def _is_link(st) -> bool:
    """Symlink, junction or any other reparse point: never followed."""
    return stat.S_ISLNK(st.st_mode) or bool(getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT)


def _stamp(st) -> float:
    """Newest of modified and created (Windows) / changed (elsewhere): a fresh copy with old mtimes counts as new."""
    born = getattr(st, "st_birthtime", None)
    if born is None:
        born = st.st_ctime
    return max(st.st_mtime, born)


def protected_roots() -> list:
    home = Path.home()
    local = os.environ.get("LOCALAPPDATA") or str(home / "AppData" / "Local")
    roots = [os.path.join(local, "Onyx"), str(home / ".codex"), str(home / ".claude" / "projects")]
    return roots + [os.path.realpath(r) for r in roots]


def sessions_dir() -> Path:
    return Path.home() / ".claude" / "sessions"


def temp_root() -> str:
    import tempfile

    raw = os.environ.get("TEMP") or os.environ.get("TMP") or tempfile.gettempdir()
    return os.path.realpath(raw)  # junctions on the way resolved, so the overlap checks see the real place


def check_root(root: str, protected: list) -> str:
    """'' when root is a sane place to clean, else why not."""
    st = _lstat(root)
    if st is None or not stat.S_ISDIR(st.st_mode) or _is_link(st):
        return "is not a plain folder"
    r, home = _norm(root), _norm(Path.home())
    if os.path.dirname(r) == r:
        return "is a drive root"
    if r == home or home.startswith(r + os.sep):
        return "is the home folder or above it"
    for p in protected:
        if _within(r, p) or _within(p, r):
            return f"overlaps the protected folder {p}"
    return ""


def active_session_ids(sessions: Path):
    """sessionId of every sessions/*.json, lower case; None if the list cannot be read in full."""
    try:
        files = sorted(Path(sessions).glob("*.json")) if Path(sessions).is_dir() else None
    except OSError:
        return None
    if files is None:
        return None
    ids = set()
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        sid = data.get("sessionId") if isinstance(data, dict) else None
        if not isinstance(sid, str) or not sid:
            return None
        ids.add(sid.lower())
    return ids


def _scandir(path) -> list:
    try:
        with os.scandir(path) as it:
            return list(it)
    except OSError:
        return []


def _plain_dir(path) -> bool:
    st = _lstat(path)
    return st is not None and stat.S_ISDIR(st.st_mode) and not _is_link(st)


def find_candidates(root: str) -> list:
    """(path, category) for every name in root that matches a category. No keep rule applied yet."""
    out = []
    for e in _scandir(root):
        if e.name.lower() == "claude":
            if _plain_dir(e.path):
                for proj in _scandir(e.path):
                    if not _plain_dir(proj.path):
                        continue
                    for s in _scandir(proj.path):
                        st = _lstat(s.path)
                        if UUID.match(s.name) and st is not None and (_is_link(st) or stat.S_ISDIR(st.st_mode)):
                            out.append((s.path, SCRATCH))
            continue
        for category, kind, rx in TOP_LEVEL:
            if rx.match(e.name):
                st = _lstat(e.path)
                if st is not None and (_is_link(st) or stat.S_ISDIR(st.st_mode) == (kind == "dir")):
                    out.append((e.path, category))
                break
    return out


def walk(path: str) -> Walk:
    """Size, newest time, longest path, links, .git, errors of a folder tree. Links are counted, never entered."""
    w = Walk(longest=len(path))
    st = _lstat(path)
    if st is None:
        w.error = True
        return w
    w.newest = _stamp(st)
    stack = [path]
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for e in it:
                    w.longest = max(w.longest, len(e.path))
                    if e.name.lower() == ".git":
                        w.git = True
                    try:
                        est = e.stat(follow_symlinks=False)
                    except OSError:
                        w.error = True
                        continue
                    w.newest = max(w.newest, _stamp(est))
                    if _is_link(est):
                        w.links += 1
                    elif stat.S_ISDIR(est.st_mode):
                        stack.append(e.path)
                    else:
                        w.size += est.st_size
        except OSError:
            w.error = True
    return w


def evaluate(path: str, category: str, now: float, active, protected: list,
             max_path: int = MAX_PATH_CHARS) -> Item:
    """One candidate with every keep rule applied. `active` = active_session_ids() (None = unreadable)."""
    it = Item(path=path, category=category)
    if any(_within(path, p) or _within(p, path) for p in protected):
        it.reason = "protected"
        return it
    st = _lstat(path)
    if st is None:
        it.reason = "unreadable"
        return it
    it.is_dir = stat.S_ISDIR(st.st_mode)
    it.newest = _stamp(st)
    if _is_link(st):
        it.reason = "link"
        return it
    if len(path) > max_path:
        it.reason = "long-path"
        return it
    reasons = []
    if category == SCRATCH:
        if active is None:
            reasons.append("sessions-unreadable")
        elif os.path.basename(path).lower() in active:
            reasons.append("active-session")
    if it.is_dir:
        w = walk(path)
        it.size, it.newest, it.links = w.size, max(it.newest, w.newest), w.links
        if w.error:
            reasons.append("unreadable")
        if w.git:
            reasons.append("git")
        longest = w.longest
    else:
        it.size, longest = st.st_size, len(path)
    if it.newest > now - RECENT_HOURS * 3600:
        reasons.append("recent")
    if longest > max_path:
        reasons.append("long-path")
    if it.size > MAX_ITEM_BYTES:
        reasons.append("too-big")
    order = list(REASONS)
    it.reason = min(reasons, key=order.index) if reasons else ""
    return it


def scan(root: str, sessions, protected: list, now: float, max_path: int = MAX_PATH_CHARS) -> list:
    active = active_session_ids(sessions)
    return [evaluate(p, c, now, active, protected, max_path) for p, c in find_candidates(root)]


def apply_limits(items: list, max_items: int, max_bytes: float) -> None:
    """Oldest first; whatever does not fit this run is kept for the next one."""
    n, total = 0, 0
    for it in sorted((i for i in items if not i.reason), key=lambda i: i.newest):
        if n + 1 > max_items or total + it.size > max_bytes:
            it.reason = "run-limit"
            continue
        n, total = n + 1, total + it.size


# ---------------------------------------------------------------- Recycle Bin (Windows only)
def recycle(path: str):
    """-> (ok, error text). Sends one file or folder to the Recycle Bin; never a permanent delete."""
    if os.name != "nt":
        return False, "the Recycle Bin needs Windows"
    if not os.path.isabs(path) or len(path) > MAX_PATH_CHARS or any(ch in path for ch in "*?"):
        return False, "path not accepted"
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        if ctypes.sizeof(ctypes.c_void_p) == 4:  # shellapi.h packs it to 1 byte on 32-bit only
            _pack_ = 1
        _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", ctypes.c_void_p),
                    ("pTo", ctypes.c_void_p), ("fFlags", ctypes.c_ushort),
                    ("fAnyOperationsAborted", wintypes.BOOL), ("hNameMappings", ctypes.c_void_p),
                    ("lpszProgressTitle", ctypes.c_void_p)]

    shell32 = ctypes.WinDLL("shell32")
    shell32.SHFileOperationW.argtypes = [ctypes.POINTER(SHFILEOPSTRUCTW)]
    shell32.SHFileOperationW.restype = ctypes.c_int
    buf = ctypes.create_unicode_buffer(path + "\0")  # pFrom is a list that ends with a second NUL
    op = SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = FO_DELETE
    op.pFrom = ctypes.addressof(buf)
    op.pTo = None
    op.fFlags = RECYCLE_FLAGS
    rc = shell32.SHFileOperationW(ctypes.byref(op))
    if rc != 0:
        return False, f"SHFileOperationW returned 0x{rc:x}"
    if op.fAnyOperationsAborted:
        return False, "aborted"
    if os.path.lexists(path):
        return False, "still there after the call"
    return True, ""


def single_instance():
    """A handle to keep for the run; False when another run holds the lock; True off Windows (no lock)."""
    if os.name != "nt":
        return True
    import ctypes
    from ctypes import wintypes

    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    k.CreateMutexW.restype = wintypes.HANDLE
    h = k.CreateMutexW(None, False, "Local\\OnyxLocalCleanup")
    if not h or ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        return False
    return h


# ---------------------------------------------------------------- run
def apply_items(items: list, sessions, protected: list, now: float, max_path: int = MAX_PATH_CHARS,
                log=None) -> Result:
    """Recycle every selected item, each checked again right before (anything changed = skipped)."""
    res = Result()
    for it in sorted((i for i in items if not i.reason), key=lambda i: i.newest):
        active = active_session_ids(sessions) if it.category == SCRATCH else set()
        fresh = evaluate(it.path, it.category, max(now, time.time()), active, protected, max_path)
        if fresh.reason:
            res.changed.append((it, fresh.reason))
            _log(log, [f"kept   {it.path}  (changed since the scan: {REASONS[fresh.reason]})"])
            continue
        ok, err = recycle(it.path)
        if ok:
            it.size = fresh.size
            res.recycled.append(it)
            _log(log, [f"recycled {human(it.size):>10}  {it.category:<14} {it.path}"])
        else:
            res.failed.append((it, err))
            _log(log, [f"FAILED {it.path}: {err}"])
    return res


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def report(items: list, root: str, apply: bool, list_items: bool = False) -> list:
    sel = [i for i in items if not i.reason]
    lines = [f"Onyx local cleanup: {'APPLY, recycling' if apply else 'DRY RUN, nothing is changed'}",
             f"Temp folder: {root}  ({len(items)} matching items)", "",
             f"{'Recycle' if apply else 'Would recycle'}".ljust(40) + f"{'items':>7} {'size':>11}"]
    for c in CATEGORIES:
        part = [i for i in sel if i.category == c]
        lines.append(f"  {c:<38}{len(part):>7} {human(sum(i.size for i in part)):>11}")
    lines.append(f"  {'total':<38}{len(sel):>7} {human(sum(i.size for i in sel)):>11}")
    linked = sum(1 for i in sel if i.links)
    if linked:
        lines.append(f"  ({linked} of them hold links or junctions: the link is recycled, never its target)")
    lines += ["", "Kept".ljust(40) + f"{'items':>7} {'size':>11}"]
    for key, text in REASONS.items():
        part = [i for i in items if i.reason == key]
        lines.append(f"  {text:<38}{len(part):>7} {human(sum(i.size for i in part)):>11}")
    if list_items:
        lines += ["", "Items (oldest first):"]
        for i in sorted(items, key=lambda i: i.newest):
            age = datetime.fromtimestamp(i.newest).strftime("%Y-%m-%d %H:%M") if i.newest else "?"
            lines.append(f"  {('recycle' if not i.reason else 'keep: ' + i.reason):<26} {human(i.size):>10}  "
                         f"{age}  {i.path}")
    return lines


def _log(path, lines: list) -> None:
    if not path:
        return
    try:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(p, "a", encoding="utf-8") as fh:
            for line in lines:
                fh.write(f"{stamp}  {line}\n")
    except OSError:
        pass


def log_file() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    p = Path(base) / "Onyx" / "local-cleanup" / "cleanup.log"
    try:
        if p.stat().st_size > LOG_MAX_BYTES:
            os.replace(p, p.with_name("cleanup.log.1"))  # keep the last two logs
    except OSError:
        pass
    return p


def run(root: str, sessions, protected: list, now: float, apply: bool = False,
        max_items: int = DEFAULT_MAX_ITEMS, max_gb: float = DEFAULT_MAX_GB, list_items: bool = False,
        log=None, out=print, max_path: int = MAX_PATH_CHARS) -> int:
    items = scan(root, sessions, protected, now, max_path)
    apply_limits(items, max_items, max_gb * 1024 ** 3)
    lines = report(items, root, apply, list_items)
    for line in lines:
        out(line)
    if not apply:
        out("")
        out('Run again with --apply to send the items under "Would recycle" to the Recycle Bin.')
        return 0
    _log(log, [line for line in lines if line.strip()])
    res = apply_items(items, sessions, protected, now, max_path, log)
    done = [f"Recycled {len(res.recycled)} items, {human(sum(i.size for i in res.recycled))} "
            f"(restore from the Recycle Bin); kept {len(res.changed)} that changed since the scan; "
            f"{len(res.failed)} failed."]
    done += [f"  FAILED {i.path}: {err}" for i, err in res.failed]
    for line in [""] + done:
        out(line)
    _log(log, done)
    return 1 if res.failed else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Recycle leftover agent scratch and test temp folders in %TEMP%. "
                                             "Dry run unless --apply.")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="the default: print what would be recycled, change nothing")
    mode.add_argument("--apply", action="store_true", help="send the selected items to the Recycle Bin")
    ap.add_argument("--list", action="store_true", help="also print every item, its size and why it is kept")
    ap.add_argument("--max-items", type=int, default=DEFAULT_MAX_ITEMS, help="most items recycled per run")
    ap.add_argument("--max-gb", type=float, default=DEFAULT_MAX_GB, help="most GB recycled per run")
    args = ap.parse_args(argv)
    if args.max_items < 0 or args.max_gb < 0:
        ap.error("--max-items and --max-gb cannot be negative")
    if sys.stdout is not None:  # None under pythonw.exe; print() then writes nowhere
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    lock = single_instance()
    log = log_file() if args.apply else None
    if lock is False:
        print("Another cleanup run is in progress; nothing done.")
        _log(log, ["another run holds the lock; nothing done"])
        return 2
    root, protected = temp_root(), protected_roots()
    problem = check_root(root, protected)
    if problem:
        print(f"Refusing to run: the temp folder {root} {problem}.")
        _log(log, [f"refused: temp folder {root} {problem}"])
        return 2
    if args.apply and os.name != "nt":
        print("--apply needs Windows (the Recycle Bin).")
        return 2
    try:
        return run(root, sessions_dir(), protected, time.time(), apply=args.apply, max_items=args.max_items,
                   max_gb=args.max_gb, list_items=args.list, log=log)
    except Exception:
        _log(log, ["CRASH " + traceback.format_exc().replace("\n", "\n    ")])
        raise


if __name__ == "__main__":
    sys.exit(main())
