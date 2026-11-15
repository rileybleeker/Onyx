"""Onyx PC activity logger: coarse active / idle time per hour and minutes per program, from Riley's PC.

What it records, every 30 seconds, and nothing else:
  - how many seconds since the last keyboard or mouse input (GetLastInputInfo returns a timestamp
    only, never what was typed or where the mouse went)
  - the executable name of the foreground program, lower case, without ".exe" (e.g. "excel", "code")
What it never reads: window titles, URLs, file or document names, keystrokes, the clipboard or
the screen. The full program path is read from Windows and cut to its file name before anything
is kept.

Samples are appended to %LOCALAPPDATA%\\Onyx\\pc-activity\\samples-YYYY-MM-DD.jsonl (local date,
on the PC only, not OneDrive). Every hour the running logger turns each day's file into hourly
totals and upserts them to pds.pc_activity_hours / pds.pc_activity_apps with the service-role key
in ~/.onyx_supabase_secret (the Rocket Money harvester's write path), and writes a
pc_activity|usage heartbeat to pds.sync_log on every upload, success or failure.

Commands (python activity_logger.py <command>):
  run                 the logger itself (Task Scheduler starts it with pythonw.exe: no window)
  upload [--dry-run]  upload the pending days now; --dry-run prints counts and writes nothing
  probe               print one sample (idle seconds + foreground program) to check it works

Only standard-library modules, so the PC needs no pip install. The aggregation is pure and
unit tested (tests/test_pc_activity_aggregation.py); the Windows calls are only made on Windows.
"""
from __future__ import annotations

import argparse
import json
import logging
import ntpath
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Iterable, Optional

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SOURCE, DATA_TYPE = "pc_activity", "usage"  # pds.sync_log heartbeat key
DEFAULT_URL = "https://fewweioupmsnbccqtxdl.supabase.co"
DEFAULT_KEY_FILE = Path.home() / ".onyx_supabase_secret"

SAMPLE_INTERVAL_S = 30
# No input for this long = idle (ActivityWatch's AFK default). A locked screen is always idle.
IDLE_THRESHOLD_S = 180
# A sample credits the time since the previous one, at most this much: after sleep or hibernation
# the gap is not counted as anything.
MAX_CREDIT_S = 2 * SAMPLE_INTERVAL_S
HOUR_S = 3600
UPLOAD_EVERY_S = 3600
FIRST_UPLOAD_AFTER_S = 120
KEEP_DAYS = 30
LOCK_APPS = frozenset({"lockapp", "logonui"})
UNKNOWN_APP = "unknown"  # input seen but no foreground program could be read
OTHER_APP = "other"      # a program named in exclude.txt: counted as active, name never stored
_APP_OK = re.compile(r"[^a-z0-9._+-]")

log = logging.getLogger("pc_activity")


# ---------------------------------------------------------------- pure logic (unit tested)
def normalize_app(raw: Optional[str]) -> Optional[str]:
    """'C:\\Program Files\\...\\EXCEL.EXE' -> 'excel'. Lower case, no '.exe', [a-z0-9._+-], at most 64 chars."""
    if not raw:
        return None
    name = ntpath.basename(str(raw).strip()).lower()
    if name.endswith(".exe"):
        name = name[:-4]
    name = _APP_OK.sub("_", name)[:64].strip("._-")
    return name or None


def is_active(idle_s: Optional[float], app: Optional[str], threshold_s: int = IDLE_THRESHOLD_S) -> bool:
    if idle_s is None or app in LOCK_APPS or (app or "").endswith(".scr"):
        return False
    return idle_s < threshold_s


def aggregate(samples: Iterable[dict], threshold_s: int = IDLE_THRESHOLD_S):
    """Samples -> (hours, apps).

    A sample {t, dt, idle, app} describes the dt seconds that END at epoch second t. Its time goes
    to the UTC hour containing t, but never reaches back past that hour's start, so an hour can
    never hold more than 3600 seconds and every hour is built from one day's file (local midnight is
    an hour boundary in Eastern time). A sample is active when there was input in the last
    threshold_s seconds and the screen was not locked; only active time is given to a program.

    hours: {hour_start_epoch: {"active": s, "idle": s}}
    apps:  {(hour_start_epoch, app): active seconds}
    """
    rows = []
    for s in samples:
        try:
            t, dt = int(s["t"]), int(s["dt"])
        except (KeyError, TypeError, ValueError):
            continue
        if dt > 0:
            rows.append((t, dt, s.get("idle"), s.get("app")))
    rows.sort(key=lambda r: r[0])
    hours: dict[int, dict[str, int]] = {}
    apps: dict[tuple[int, str], int] = {}
    for t, dt, idle, app in rows:
        bucket = t - t % HOUR_S
        tot = hours.setdefault(bucket, {"active": 0, "idle": 0})
        credit = min(dt, MAX_CREDIT_S, t - bucket, HOUR_S - tot["active"] - tot["idle"])
        if credit <= 0:
            continue
        try:
            idle_s = None if idle is None else float(idle)
        except (TypeError, ValueError):
            idle_s = None
        name = normalize_app(app)
        if is_active(idle_s, name, threshold_s):
            tot["active"] += credit
            key = (bucket, name or UNKNOWN_APP)
            apps[key] = apps.get(key, 0) + credit
        else:
            tot["idle"] += credit
    return {h: v for h, v in hours.items() if v["active"] or v["idle"]}, apps


def build_rows(hours: dict, apps: dict, device: str, synced_at: str):
    """Rows for pds.pc_activity_hours and pds.pc_activity_apps (hour_start as ISO UTC)."""
    iso = lambda h: datetime.fromtimestamp(h, tz=timezone.utc).isoformat()  # noqa: E731
    hour_rows = [
        {"device": device, "hour_start": iso(h), "active_seconds": v["active"], "idle_seconds": v["idle"],
         "synced_at": synced_at}
        for h, v in sorted(hours.items())
    ]
    app_rows = [
        {"device": device, "hour_start": iso(h), "app": app, "active_seconds": s}
        for (h, app), s in sorted(apps.items()) if s > 0 and h in hours
    ]
    return hour_rows, app_rows


def parse_lines(lines: Iterable[str]) -> list[dict]:
    """JSONL -> sample dicts. A torn last line (crash, power cut) or any bad line is skipped."""
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            out.append(row)
    return out


def pending_days(file_days: Iterable[str], final_days: Iterable[str], today: str) -> list[str]:
    """Days still to upload: every day with a sample file that was not uploaded after it ended."""
    done = set(final_days)
    return sorted(d for d in set(file_days) if d not in done and d <= today)


def sample_credit(now: float, last: Optional[float]) -> int:
    """Seconds a sample taken at `now` stands for: the time since the previous one, capped."""
    if last is None:
        return 0
    return int(max(0.0, min(now - last, float(MAX_CREDIT_S))))


def safe_device(raw: str) -> str:
    return (re.sub(r"[^a-z0-9._-]", "-", (raw or "").lower())[:40].strip("-")) or "pc"


# ---------------------------------------------------------------- local buffer
def data_dir() -> Path:
    base = os.environ.get("ONYX_PC_ACTIVITY_DIR") or os.path.join(
        os.environ.get("LOCALAPPDATA") or str(Path.home()), "Onyx", "pc-activity")
    p = Path(base)
    p.mkdir(parents=True, exist_ok=True)
    return p


def sample_file(d: Path, day: str) -> Path:
    return d / f"samples-{day}.jsonl"


def file_days(d: Path) -> list[str]:
    out = []
    for p in d.glob("samples-*.jsonl"):
        day = p.stem[len("samples-"):]
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            out.append(day)
    return out


def load_state(d: Path) -> dict:
    try:
        return json.loads((d / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(d: Path, state: dict) -> None:
    tmp = d / "state.json.tmp"
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(tmp, d / "state.json")


def load_excluded(d: Path) -> frozenset:
    """exclude.txt: one program name per line; those count as active but are stored as 'other'."""
    try:
        lines = (d / "exclude.txt").read_text(encoding="utf-8").splitlines()
    except OSError:
        return frozenset()
    return frozenset(n for n in (normalize_app(x) for x in lines if not x.lstrip().startswith("#")) if n)


def append_sample(d: Path, sample: dict) -> None:
    day = datetime.fromtimestamp(sample["t"]).strftime("%Y-%m-%d")  # local date
    with open(sample_file(d, day), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(sample, separators=(",", ":")) + "\n")


def prune(d: Path, state: dict, today: str) -> None:
    """Sample files older than KEEP_DAYS that were uploaded in full are removed (the buffer only)."""
    cutoff = (date.fromisoformat(today) - timedelta(days=KEEP_DAYS)).isoformat()
    final = set(state.get("final", []))
    for day in file_days(d):
        if day < cutoff and day in final:
            try:
                sample_file(d, day).unlink()
            except OSError:
                pass
    state["final"] = sorted(x for x in final if x >= cutoff)


# ---------------------------------------------------------------- Windows (ctypes, read-only calls)
class Win32:
    """GetLastInputInfo + the foreground window's process image name. No titles, no input content."""

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    ERROR_ALREADY_EXISTS = 183

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        self.ct, self.wt = ctypes, wintypes
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]

        self.LASTINPUTINFO = LASTINPUTINFO
        u, k = self.user32, self.kernel32
        u.GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
        u.GetLastInputInfo.restype = wintypes.BOOL
        k.GetTickCount.restype = wintypes.DWORD
        u.GetForegroundWindow.restype = wintypes.HWND
        u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        u.GetWindowThreadProcessId.restype = wintypes.DWORD
        self.WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        u.EnumChildWindows.argtypes = [wintypes.HWND, self.WNDENUMPROC, wintypes.LPARAM]
        u.EnumChildWindows.restype = wintypes.BOOL
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.OpenProcess.restype = wintypes.HANDLE
        k.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                                 ctypes.POINTER(wintypes.DWORD)]
        k.QueryFullProcessImageNameW.restype = wintypes.BOOL
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.CloseHandle.restype = wintypes.BOOL
        k.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
        k.CreateMutexW.restype = wintypes.HANDLE

    def idle_seconds(self) -> Optional[float]:
        lii = self.LASTINPUTINFO()
        lii.cbSize = self.ct.sizeof(self.LASTINPUTINFO)
        if not self.user32.GetLastInputInfo(self.ct.byref(lii)):
            return None
        return ((self.kernel32.GetTickCount() - lii.dwTime) & 0xFFFFFFFF) / 1000.0  # 32-bit tick wrap

    def _pid(self, hwnd) -> int:
        pid = self.wt.DWORD(0)
        self.user32.GetWindowThreadProcessId(hwnd, self.ct.byref(pid))
        return pid.value

    def _process_name(self, pid: int) -> Optional[str]:
        if not pid:
            return None
        h = self.kernel32.OpenProcess(self.PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return None
        try:
            size = self.wt.DWORD(1024)
            buf = self.ct.create_unicode_buffer(size.value)
            if not self.kernel32.QueryFullProcessImageNameW(h, 0, buf, self.ct.byref(size)):
                return None
            return normalize_app(buf.value)  # file name only; the path is not kept
        finally:
            self.kernel32.CloseHandle(h)

    def foreground_app(self) -> Optional[str]:
        hwnd = self.user32.GetForegroundWindow()
        if not hwnd:
            return None
        pid = self._pid(hwnd)
        name = self._process_name(pid)
        if name == "applicationframehost":  # Store apps: the real program owns a child window
            found = []

            def cb(child, _lparam):
                cpid = self._pid(child)
                if cpid and cpid != pid:
                    found.append(cpid)
                    return False
                return True

            self.user32.EnumChildWindows(hwnd, self.WNDENUMPROC(cb), 0)
            if found:
                name = self._process_name(found[0]) or name
        return name

    def single_instance(self, name: str = "Local\\OnyxPcActivityLogger"):
        h = self.kernel32.CreateMutexW(None, False, name)
        if not h or self.ct.get_last_error() == self.ERROR_ALREADY_EXISTS:
            return None
        return h  # keep the handle for the life of the process


# ---------------------------------------------------------------- Supabase (PostgREST, stdlib only)
class HttpError(Exception):
    pass


class Rest:
    """Minimal PostgREST client for the pds schema. Errors carry the HTTP status and Postgres error code
    only (never the response body, which can quote row values). The key is never logged."""

    def __init__(self, url: str, key: str, timeout: int = 30) -> None:
        self.url, self._key, self.timeout = url.rstrip("/"), key, timeout

    def post(self, table: str, rows: list, prefer: str, on_conflict: Optional[str] = None) -> None:
        path = f"{self.url}/rest/v1/{table}" + (f"?on_conflict={on_conflict}" if on_conflict else "")
        req = urllib.request.Request(path, data=json.dumps(rows).encode("utf-8"), method="POST", headers={
            "apikey": self._key, "Authorization": f"Bearer {self._key}", "Content-Type": "application/json",
            "Content-Profile": "pds", "Prefer": prefer,
        })
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                resp.read()
        except urllib.error.HTTPError as e:
            code = ""
            try:
                code = str(json.loads(e.read().decode("utf-8", "replace")).get("code") or "")
            except (ValueError, AttributeError, OSError):
                pass
            raise HttpError(f"write {table}: HTTP {e.code}" + (f" ({code})" if code else "")) from None
        except (urllib.error.URLError, OSError) as e:
            raise HttpError(f"write {table}: network error ({type(getattr(e, 'reason', e)).__name__})") from None

    def upsert(self, table: str, rows: list, on_conflict: str, chunk: int = 500) -> None:
        for i in range(0, len(rows), chunk):
            self.post(table, rows[i:i + chunk], "resolution=merge-duplicates,return=minimal", on_conflict)

    # sync_log_helper.log_sync() speaks the supabase-py shape: supa.schema("pds").table(t).insert(row).execute()
    def schema(self, _name: str) -> "Rest":
        return self

    def table(self, name: str) -> "_Insert":
        return _Insert(self, name)


class _Insert:
    def __init__(self, rest: Rest, table: str) -> None:
        self.rest, self.name, self.row = rest, table, None

    def insert(self, row: dict) -> "_Insert":
        self.row = row
        return self

    def execute(self) -> None:
        self.rest.post(self.name, [self.row], "return=minimal")


def make_client() -> Rest:
    key_file = Path(os.environ.get("ONYX_SUPABASE_SECRET_FILE") or DEFAULT_KEY_FILE)
    try:
        key = key_file.read_text(encoding="utf-8").strip()
    except OSError:
        raise HttpError(f"no service-role key file at {key_file}") from None
    if not key:
        raise HttpError(f"the key file {key_file} is empty")
    return Rest(os.environ.get("ONYX_SUPABASE_URL") or DEFAULT_URL, key)


def heartbeat(client: Optional[Rest], status: str, records: int, started_at: float,
              error: Optional[str] = None, days: Optional[list] = None) -> None:
    from sync_log_helper import log_sync  # the one shared sync_log writer (swallows its own failures)

    if client is None:
        try:
            client = make_client()
        except HttpError as e:
            log.warning("heartbeat skipped: %s", e)
            return
    log_sync(client, SOURCE, DATA_TYPE, status, records=records, started_at=started_at, error=error,
             date_range_start=date.fromisoformat(min(days)) if days else None,
             date_range_end=date.fromisoformat(max(days)) if days else None)


# ---------------------------------------------------------------- commands
def device_name() -> str:
    return safe_device(os.environ.get("ONYX_PC_DEVICE") or os.environ.get("COMPUTERNAME") or "pc")


def upload(dry_run: bool = False) -> int:
    """Upserts every pending day; one heartbeat per call. Returns 0 ok, 1 failed."""
    started = time.time()
    d = data_dir()
    state = load_state(d)
    today = datetime.now().strftime("%Y-%m-%d")
    days = pending_days(file_days(d), state.get("final", []), today)
    device, synced_at = device_name(), datetime.now(timezone.utc).isoformat()
    client: Optional[Rest] = None
    n_hours = n_apps = 0
    try:
        for day in days:
            with open(sample_file(d, day), encoding="utf-8") as fh:
                hours, apps = aggregate(parse_lines(fh))
            hour_rows, app_rows = build_rows(hours, apps, device, synced_at)
            n_hours, n_apps = n_hours + len(hour_rows), n_apps + len(app_rows)
            if dry_run:
                active = sum(r["active_seconds"] for r in hour_rows) // 60
                print(json.dumps({"day": day, "hours": len(hour_rows), "app_rows": len(app_rows),
                                  "active_minutes": active}))
                continue
            if client is None:
                client = make_client()
            if hour_rows:  # the hours first: each app row points at its hour
                client.upsert("pc_activity_hours", hour_rows, "device,hour_start")
            if app_rows:
                client.upsert("pc_activity_apps", app_rows, "device,hour_start,app")
            if day < today:  # uploaded after the day ended: complete, never read again
                state.setdefault("final", []).append(day)
        if not dry_run:
            prune(d, state, today)
            save_state(d, state)
            heartbeat(client, "success", n_hours + n_apps, started, days=days)
        log.info("upload ok: %d days, %d hour rows, %d app rows%s", len(days), n_hours, n_apps,
                 " (dry run)" if dry_run else "")
        print(json.dumps({"ok": True, "dry_run": dry_run, "days": len(days), "hour_rows": n_hours,
                          "app_rows": n_apps}))
        return 0
    except Exception as e:  # noqa: BLE001 - every failure must reach /status
        msg = str(e) if isinstance(e, HttpError) else f"{type(e).__name__}"
        log.error("upload failed: %s", msg)
        if not dry_run:
            save_state(d, state)  # keep the days that did finish
            heartbeat(client, "failed", 0, started, error=msg, days=days)
        print(json.dumps({"ok": False, "dry_run": dry_run, "error": msg}))
        return 1


def take_sample(win: Win32, excluded: frozenset, now: float, last: Optional[float]) -> dict:
    idle = win.idle_seconds()
    app = win.foreground_app()
    if app in excluded:
        app = OTHER_APP
    return {"t": int(now), "dt": sample_credit(now, last),
            "idle": None if idle is None else int(min(idle, 86400)), "app": app}


def run(interval: int = SAMPLE_INTERVAL_S, upload_enabled: bool = True) -> int:
    win = Win32()
    if win.single_instance() is None:
        log.info("another logger is already running; exiting")
        return 0
    d = data_dir()
    excluded = load_excluded(d)
    log.info("logger started (every %ds, idle after %ds, %d excluded programs)", interval, IDLE_THRESHOLD_S,
             len(excluded))
    last: Optional[float] = None
    next_upload = time.time() + FIRST_UPLOAD_AFTER_S
    try:
        while True:
            now = time.time()
            sample = take_sample(win, excluded, now, last)
            last = now
            if sample["dt"] > 0:
                append_sample(d, sample)
            if upload_enabled and now >= next_upload:
                upload()
                excluded = load_excluded(d)  # picks up edits to exclude.txt
                next_upload = now + UPLOAD_EVERY_S
            time.sleep(interval)
    except KeyboardInterrupt:
        return 0
    except Exception as e:  # noqa: BLE001 - a crash must reach /status; Task Scheduler restarts the logger
        log.exception("logger crashed")
        heartbeat(None, "failed", 0, time.time(), error=f"logger crashed: {type(e).__name__}")
        return 1


def probe() -> int:
    win = Win32()
    idle, app = win.idle_seconds(), win.foreground_app()
    print(json.dumps({"idle_seconds": idle, "app": app, "active": is_active(idle, app)}))
    return 0


def setup_logging() -> None:
    handler = RotatingFileHandler(data_dir() / "logger.log", maxBytes=256_000, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(logging.INFO)


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(description="Onyx PC activity logger")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="sample every 30 s and upload hourly (what the scheduled task runs)")
    r.add_argument("--interval", type=int, default=SAMPLE_INTERVAL_S)
    r.add_argument("--no-upload", action="store_true")
    u = sub.add_parser("upload", help="upload the pending days now")
    u.add_argument("--dry-run", action="store_true")
    sub.add_parser("probe", help="print one sample")
    args = ap.parse_args(argv)
    if sys.platform != "win32" and args.cmd in ("run", "probe"):
        print("run and probe need Windows", file=sys.stderr)
        return 2
    setup_logging()
    if args.cmd == "run":
        return run(max(5, args.interval), not args.no_upload)
    if args.cmd == "upload":
        return upload(dry_run=args.dry_run)
    return probe()


if __name__ == "__main__":
    sys.exit(main())
