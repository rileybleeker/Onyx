"""Encrypted off-site backup of /health/records, and its restore drill (SEC-06, option A).

docs/medical-records-recovery.md sections 4 and 9. Runs on Riley's PC (weekly Task Scheduler job,
register-task.ps1); standard-library Python plus the `age` command-line tool (X25519 public-key encryption).

  backup   Reads, read-only with the service role (~/.onyx_supabase_secret), every column of
           pds.medical_documents and pds.lab_results, every file in the private bucket medical-records
           (documents/<id>), the PostgREST schema description of pds and a fixed list of hand-entered pds
           tables (REBUILD_TABLES: what Onyx cannot fetch again from a source). It packs them into ONE tar
           stream that goes straight into `age -r <public recipient>`: plaintext exists only in this process's
           memory and in the pipe to age, never in a file. The ciphertext is written to
           %LOCALAPPDATA%\\Onyx\\backup-tmp, then copied into the OneDrive folder (default
           ~/OneDrive/Backups/onyx) under a temporary name and renamed when complete, so a run that stops part
           way leaves no restore point. The pack's manifest.json (written last, inside the ciphertext) holds
           each table's row count and SHA-256 and each file's size and SHA-256; recovery-manifest.json (the
           format recovery_check.py --manifest reads) is added when the copy is complete. Tables are paged by
           primary key (a keyset cursor, never an OFFSET) and their keys are read again after the last page;
           the copy counts only when both agree. Every foreign key between two copied tables is then
           checked; the tables on both sides of a broken one are read again (a bounded number of times),
           and a copy still broken, or one pointing into a table no backup holds, is partial
           (tables_inconsistent / parent_not_recoverable). UNCOVERED_TABLES lists the hand-entered tables
           deliberately not copied (experiment_days), recorded in every manifest. A fully successful run
           commits a completeness marker (.ok, checked after it is written); a run whose marker cannot be
           committed FAILS and prunes nothing. Files are checked by an explicit stat (never Path.is_file(),
           which hides errors), and an error checking any of this job's files stops the prune.
  remote    LOCAL COMPLETION IS NOT REMOTE DURABILITY (review finding R3): a ciphertext in the OneDrive
           folder is "pending" until there is positive evidence that the remote copy exists — never
           inferred from the OneDrive process running, the folder existing or the file's age. The
           evidence is a small local record (the backup name, its size and the confirmation time;
           %LOCALAPPDATA%\\Onyx\\backup-state\\remote-confirmations.json — never under OneDrive, never in
           the repo) written ONLY by record_remote_confirmation, the one code path that obtains a
           confirmation. No confirmation mechanism is built, so the record stays empty ("unknown") and
           every run answers partial with the code offsite_unconfirmed, and prunes nothing, until one
           exists. Retention after every run that wrote a backup: the newest 8 backups, the first
           backup of each of the 3 most recent months, the newest backup whose marker verifies AND the
           newest backup the record confirms (a confirmation whose file changed no longer counts);
           prune() refuses (BackupError offsite_unconfirmed) when no backup is confirmed at all, so
           retention can never delete the last backup that really reached remote storage. Only this
           job's names (onyx-backup-<UTC time>.tar.age / .ok) in the backup folder are ever removed.
  drill    Decrypts the newest backup (with the private key file) into an isolated folder under
           %LOCALAPPDATA%\\Onyx\\backup-drill (never into Supabase, never under OneDrive), checks every member
           against the manifest (SHA-256 per file and per table, row counts, lab links, the recovery manifest),
           prints counts and booleans only, and removes the decrypted copy, also on failure.
  keygen   Creates the age key pair once: the private key at ~/.onyx_backup_age_key (access limited to the
           signed-in user), the public recipient at ~/.onyx_backup_age_recipient. The backup reads ONLY the
           recipient file; the private key is read only by `drill` (and age itself). Copy the private key into
           the password manager right after.

Output and logging are counts and short codes only: never a title, note, value, id, path, key or URL with a
credential. Every production backup run writes ONE count-free heartbeat (pds.sync_log source "backup",
data_type "medical_records": success / partial / failed with a short code; decision 5 of the doc), also when
it crashes. A dry run and a drill write nothing. The target rules are recovery_check.py's: production is the
exact production origin; a drill target (local stack, or a throwaway project named with --drill-project) gets
its own credentials and an explicit --dest, and writes no heartbeat.

Exit: 0 success, 2 partial or incomplete, 1 failed or refused.
Tests: tests/test_medical_offsite_backup.py (synthetic rows and files, a fake Supabase, a fake cipher).
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import os
import re
import secrets
import shutil
import stat as stat_mod
import subprocess
import sys
import tarfile
import time
import urllib.parse
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Callable, Iterator, Optional

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
for _p in (HERE, ROOT):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import recovery_check as rc  # noqa: E402  (target rules, retrying requests, listing checks, manifest format)

log = logging.getLogger("medical_backup")

SOURCE, DATA_TYPE = "backup", "medical_records"  # pds.sync_log heartbeat key (count-free)
FORMAT, FORMAT_VERSION = "onyx-offsite-backup", 1
TOOL_VERSION = "1"
NAME_RE = re.compile(r"^onyx-backup-(\d{8}T\d{6}Z)\.tar\.age$")
DEST_PARTIAL_RE = re.compile(r"^\.onyx-backup-\d{8}T\d{6}Z\.(tar\.age|ok)\.partial$")
TMP_RE = re.compile(r"^onyx-backup-\d{8}T\d{6}Z\.tar\.age\.tmp$")
# The completeness marker next to a backup whose run was fully successful: {"backup": <its name>, "size": <its
# bytes>} (no counts, no names of anything inside). Retention counts a backup as complete only when its marker
# reads back and matches the backup file, and always keeps the newest such backup, so a run of partial
# backups can never push the last complete one out. A run whose marker cannot be committed is a failed run.
OK_RE = re.compile(r"^onyx-backup-(\d{8}T\d{6}Z)\.ok$")
KEEP_WEEKLY, KEEP_MONTHLY = 8, 3
RECIPIENT_RE = re.compile(r"^age1[02-9ac-hj-np-z]{58}$")
TABLE_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
MEDICAL_TABLES = ("medical_documents", "lab_results")
# Hand-entered pds tables Onyx cannot fetch again from a source (an ETL table can be re-synced). Copied with
# every column, encrypted with the rest. A table not in the schema (renamed, not applied yet) is listed in the
# manifest as missing and does not fail the run; a table that cannot be read makes the run partial.
REBUILD_TABLES = (
    "habit_journal", "habit_name_map",
    "supplement_products", "supplement_intake", "supplement_stack", "supplement_stack_item",
    "weight_log", "meal_events", "photo_meals",
    "books", "book_chapters", "book_highlights", "reading_sessions", "reading_reviews", "reading_quizzes",
    "care_items", "ui_preferences", "user_tz_log", "focus_unlock_config",
    "delivery_order_items", "delivery_item_nutrition", "delivery_item_leftovers", "online_order_marks",
    "finance_accounts", "finance_transactions", "finance_balance_snapshots", "finance_plan_items",
    "finance_plan_drivers", "finance_category_rules", "finance_txn_categories", "finance_budgets",
    "finance_goals", "finance_cancel_marks", "procurement_subscriptions", "procurement_flag_dismissals",
    "experiments",
)
# Never copied: credentials, and the N-of-1 trial seed / schedule (the arm must stay concealed from the app).
EXCLUDED_TABLES = frozenset({"ci_tokens", "experiment_secrets", "experiment_schedule"})
# Hand-entered tables this backup does NOT cover, and why. pds.experiment_days (trial adherence) has a
# required foreign key into pds.experiment_schedule, which is excluded above, so a copy of it could not be
# restored into the declared schema: it stays uncovered until the trial schedule has a recovery path of its
# own. Listed in every manifest (uncovered_tables) and in docs/medical-records-recovery.md section 9, so the
# gap is reported rather than hidden. Not a partial run: the gap is the same every week.
UNCOVERED_TABLES = {"experiment_days": "parent_excluded"}
assert not EXCLUDED_TABLES & set(REBUILD_TABLES) and not set(MEDICAL_TABLES) & set(REBUILD_TABLES)
assert not set(UNCOVERED_TABLES) & (set(REBUILD_TABLES) | set(MEDICAL_TABLES) | EXCLUDED_TABLES)
# Rounds of re-reading the tables on either side of a broken reference (a row and its parent written or
# removed between the two tables' reads) before the copy is reported inconsistent.
REFERENCE_ROUNDS = 3
PAGE = 1000
MAX_TABLE_ROWS = 500_000
# One limit for both sides: the backup never packs a member larger than this (a wider table over it is left
# out and the run is partial; a medical table over it fails the run), and a drill refuses any member over it,
# so every backup the job reports is one the drill can read. Files are capped at 25 MB by the bucket.
MAX_MEMBER_BYTES = 64 * 1024 * 1024
# The pack's members: nothing else is written, and a drill refuses (and never extracts) anything else.
MEMBER_RE = re.compile(r"^(manifest\.json|recovery-manifest\.json|schema/openapi\.json|tables/pds/[a-z_][a-z0-9_]{0,62}\.json"
                       r"|objects/documents/[0-9a-f-]{36})$")
MIME_EXT = {"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
            "image/heic": ".heic", "image/heif": ".heif"}

DEFAULT_RECIPIENT_FILE = Path.home() / ".onyx_backup_age_recipient"
DEFAULT_IDENTITY_FILE = Path.home() / ".onyx_backup_age_key"
DEFAULT_DEST = Path.home() / "OneDrive" / "Backups" / "onyx"


def local_root() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / "Onyx"


def tmp_dir() -> Path:
    return local_root() / "backup-tmp"


def drill_root() -> Path:
    return local_root() / "backup-drill"


def log_dir() -> Path:
    return local_root() / "medical-backup"


class BackupError(Exception):
    """A run that cannot go on. `code` is a short fixed code (the heartbeat's error text); never a value."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class CipherError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


# ---------------------------------------------------------------- places (pure)
def _resolved(p: Path) -> Path:
    try:
        return p.expanduser().resolve()
    except OSError:
        return p.expanduser().absolute()


def is_under(path: Path, root: Path) -> bool:
    a, b = _resolved(path), _resolved(root)
    return a == b or b in a.parents


def onedrive_roots() -> list[Path]:
    roots = [Path.home() / "OneDrive"]
    for name in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        if os.environ.get(name):
            roots.append(Path(os.environ[name]))
    return roots


def under_onedrive(path: Path) -> bool:
    return any(is_under(path, r) for r in onedrive_roots())


def onedrive_sync_ready(dest: Path) -> bool:
    """A cheap NEGATIVE pre-check only: `dest` lies under a OneDrive folder that exists, and (on Windows)
    the OneDrive client process is running. A paused, signed-out, offline or stuck client passes it, so it
    is never evidence that a copy was uploaded — that needs a recorded remote confirmation
    (load_remote_confirmations). A run whose destination fails this check is never a success."""
    try:
        if not any(is_under(dest, r) and r.is_dir() for r in onedrive_roots()):
            return False
        if os.name == "nt":
            res = subprocess.run(["tasklist", "/FI", "IMAGENAME eq OneDrive.exe", "/NH"], capture_output=True,
                                 text=True, check=False, timeout=20, creationflags=_no_window())
            return "onedrive.exe" in (res.stdout or "").lower()
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def check_places(dest: Path, tmp: Path) -> None:
    """The ciphertext goes to `dest`; plaintext never touches disk at all. `tmp` (ciphertext before it is
    complete) is local, never under OneDrive or the repo, and `dest` is never inside the repo."""
    if is_under(dest, ROOT):
        raise BackupError("dest_in_repo")
    if is_under(tmp, ROOT) or under_onedrive(tmp):
        raise BackupError("tmp_unsafe")


# ---------------------------------------------------------------- the age tool
def find_tool(name: str) -> Optional[str]:
    """age / age-keygen: ONYX_AGE_DIR, PATH, then winget's link and package folders."""
    exe = name + (".exe" if os.name == "nt" else "")
    if os.environ.get("ONYX_AGE_DIR"):
        cand = Path(os.environ["ONYX_AGE_DIR"]) / exe
        if cand.is_file():
            return str(cand)
    found = shutil.which(name)
    if found:
        return found
    winget = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / "Microsoft" / "WinGet"
    cand = winget / "Links" / exe
    if cand.is_file():
        return str(cand)
    for c in sorted((winget / "Packages").glob(f"FiloSottile.age*/**/{exe}")):
        if c.is_file():
            return str(c)
    return None


def _no_window() -> int:
    # pythonw (the scheduled task) has no console: without this every age call would flash one
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


class AgeCli:
    """Streams through the `age` command. stderr is discarded (never logged); a non-zero exit is a CipherError."""

    def __init__(self, age_bin: str) -> None:
        self.age = age_bin

    @contextmanager
    def encrypt_to(self, recipient: str, out_path: Path) -> Iterator[BinaryIO]:
        proc = subprocess.Popen([self.age, "--encrypt", "--recipient", recipient, "--output", str(out_path)],
                                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                creationflags=_no_window())
        try:
            yield proc.stdin  # type: ignore[misc]
        except BaseException:
            _kill(proc)
            raise
        try:
            proc.stdin.close()  # type: ignore[union-attr]
        except OSError:
            _kill(proc)
            raise CipherError("encrypt_failed") from None
        if proc.wait(timeout=900) != 0:
            raise CipherError("encrypt_failed")

    @contextmanager
    def decrypt_from(self, identity: Path, in_path: Path) -> Iterator[BinaryIO]:
        proc = subprocess.Popen([self.age, "--decrypt", "--identity", str(identity), str(in_path)],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                creationflags=_no_window())
        try:
            yield proc.stdout  # type: ignore[misc]
        except BaseException:
            _kill(proc)
            raise
        try:
            while proc.stdout.read(1 << 20):  # type: ignore[union-attr]  # drain: age checks the last chunk at EOF
                pass
            proc.stdout.close()  # type: ignore[union-attr]
        except OSError:
            _kill(proc)
            raise CipherError("decrypt_failed") from None
        if proc.wait(timeout=900) != 0:
            raise CipherError("decrypt_failed")


def _kill(proc: subprocess.Popen) -> None:
    for s in (proc.stdin, proc.stdout):
        try:
            if s:
                s.close()
        except OSError:
            pass
    try:
        proc.kill()
    except OSError:
        pass
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        pass


def read_recipient(path: Path) -> str:
    """The public recipient only (one age1... line; comments allowed). Never the private key file."""
    if _resolved(path) == _resolved(DEFAULT_IDENTITY_FILE):
        raise BackupError("recipient_invalid")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        raise BackupError("recipient_missing") from None
    if "AGE-SECRET-KEY" in text.upper():
        raise BackupError("recipient_invalid")  # that is a private key: the job must never be given one
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    if len(lines) != 1 or not RECIPIENT_RE.match(lines[0]):
        raise BackupError("recipient_invalid")
    return lines[0]


# ---------------------------------------------------------------- reading Supabase (read-only)
def read_openapi(target: rc.Target) -> tuple[Optional[bytes], Optional[dict]]:
    """PostgREST's schema description of pds (tables, columns, types, primary keys): the schema-only part of
    the copy, and where each table's primary key comes from. (None, None) when it cannot be read."""
    try:
        status, data = target._get("schema", "GET", f"{target.url}/rest/v1/",
                                   target._h(**{"Accept-Profile": "pds", "Accept": "application/openapi+json"}))
    except rc.Unreadable:
        return None, None
    if not 200 <= status < 300:
        return None, None
    try:
        spec = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, None
    return (data, spec) if isinstance(spec, dict) else (None, None)


# Column types a keyset cursor can compare exactly as Postgres orders them (a float or a jsonb key could not).
KEY_FORMATS = frozenset({"text", "character varying", "character", "uuid", "integer", "bigint", "smallint",
                         "date", "boolean", "timestamp with time zone", "timestamp without time zone",
                         "time without time zone"})
UNKEYED: tuple[str, ...] = ()


def table_key(spec: Optional[dict], table: str) -> Optional[tuple[str, ...]]:
    """The table's primary key columns (PostgREST marks them <pk/>), which the keyset cursor pages by. None
    when the schema description lists no such table (not backed up, reported as missing); UNKEYED (an empty
    tuple) when it has no primary key, or one of a type the cursor cannot compare: such a table is never
    copied as if complete (the run is partial). Without a schema description, ("id",) (the run is then
    partial anyway: schema_unread)."""
    if spec is None:
        return ("id",)
    props = ((spec.get("definitions") or {}).get(table) or {}).get("properties")
    if not isinstance(props, dict) or not props:
        return None
    pk = [c for c, v in props.items() if isinstance(v, dict) and "<pk/>" in str(v.get("description") or "")]
    if not pk or not all(re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", c) for c in pk):
        return UNKEYED
    if not all(str(props[c].get("format") or "") in KEY_FORMATS for c in pk):
        return UNKEYED
    return tuple(pk)


FK_RE = re.compile(r"<fk table='([a-z_][a-z0-9_]{0,62})' column='([a-z_][a-z0-9_]{0,62})'/>")
# Always checked, whatever the schema description says: a lab result's source document.
MEDICAL_REFERENCES = (("lab_results", "document_id", "medical_documents", "id"),)


def references(spec: Optional[dict], tables) -> list[tuple[str, str, str, str]]:
    """(table, column, parent table, parent column) for every column of `tables` that PostgREST marks as a
    foreign key (<fk table='..' column='..'/>), plus MEDICAL_REFERENCES. A composite key is checked column
    by column (each column against its own parent column): weaker than the row check, never a false alarm."""
    out = list(MEDICAL_REFERENCES)
    defs = (spec or {}).get("definitions") or {}
    for table in tables:
        props = (defs.get(table) or {}).get("properties")
        for col, v in (props.items() if isinstance(props, dict) else ()):
            if isinstance(v, dict):
                for parent, pcol in FK_RE.findall(str(v.get("description") or "")):
                    if (table, col, parent, pcol) not in out:
                        out.append((table, col, parent, pcol))
    return out


def _ref_value(v):
    return v if isinstance(v, (str, int, bool)) else json.dumps(v, sort_keys=True)


def broken_references(tables: dict, spec: Optional[dict]) -> set[tuple[str, str]]:
    """(table, parent) pairs where a copied row points at a parent row the copy does not hold. Only pairs
    whose two tables are both copied: a parent this job never copies is judged by unrecoverable_parents()
    (an excluded or uncovered table) or is an ETL table Onyx fetches again from its source."""
    broken: set[tuple[str, str]] = set()
    for table, col, parent, pcol in references(spec, tables):
        if table not in tables or parent not in tables:
            continue
        have = {_ref_value(r.get(pcol)) for r in tables[parent] if isinstance(r, dict) and r.get(pcol) is not None}
        if any(isinstance(r, dict) and r.get(col) is not None and _ref_value(r.get(col)) not in have
               for r in tables[table]):
            broken.add((table, parent))
    return broken


def unrecoverable_parents(tables: dict, spec: Optional[dict]) -> bool:
    """True when a copied row points into a table no backup holds (EXCLUDED_TABLES, UNCOVERED_TABLES): such
    a copy could not be restored into the declared schema, so it never counts as complete."""
    gone = EXCLUDED_TABLES | set(UNCOVERED_TABLES)
    return any(parent in gone and table in tables
               and any(isinstance(r, dict) and r.get(col) is not None for r in tables[table])
               for table, col, parent, _ in references(spec, tables))


class TableMissing(Exception):
    pass


def _quote(stage: str, value) -> str:
    """One key value as a double-quoted PostgREST filter value (a backslash escapes a double quote and a backslash)."""
    if isinstance(value, bool):
        text = "true" if value else "false"
    elif isinstance(value, int):
        text = str(value)
    elif isinstance(value, str):
        text = value
    else:  # None, a float, an object: no exact comparison, so no cursor
        raise rc.Unreadable(stage, "a key value the cursor cannot compare")
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def after_filter(stage: str, key: tuple[str, ...], last: dict) -> str:
    """The `or` filter for rows strictly after `last` in key order:
    (k1 > v1) or (k1 = v1 and k2 > v2) or ... (the row-value comparison (k1, k2, ...) > (v1, v2, ...))."""
    terms = []
    for i, col in enumerate(key):
        parts = [f"{c}.eq.{_quote(stage, last.get(c))}" for c in key[:i]] + [f"{col}.gt.{_quote(stage, last.get(col))}"]
        terms.append(parts[0] if len(parts) == 1 else f"and({','.join(parts)})")
    return f"({','.join(terms)})"


def _key_of(row: dict, key: tuple[str, ...]) -> str:
    return json.dumps([row.get(c) for c in key], sort_keys=True, separators=(",", ":"))


def _keyset_read(target: rc.Target, stage: str, table: str, select: str, key: tuple[str, ...], max_rows: int) -> list[dict]:
    """Every row of pds.<table> in primary-key order, each page asking for the rows AFTER the last key it has
    (never an OFFSET: a row removed or added between two pages cannot shift an unread row out of the read)."""
    out: list[dict] = []
    order = ",".join(f"{c}.asc" for c in key)
    last: Optional[dict] = None
    while True:
        params = {"select": select, "order": order, "limit": PAGE}
        if last is not None:
            params["or"] = after_filter(stage, key, last)
        status, data = target._get(stage, "GET", f"{target.url}/rest/v1/{table}?{urllib.parse.urlencode(params)}",
                                   target._h(**{"Accept-Profile": "pds"}))
        if status in (400, 404) and str(rc._error_body(data).get("code") or "") in ("PGRST205", "42P01"):
            raise TableMissing(table)
        rc._ok(stage, status)
        page = rc._json(stage, data)
        if not isinstance(page, list) or not all(isinstance(r, dict) for r in page):
            raise rc.Unreadable(stage, "answer was not a list of rows")
        if any(r.get(c) is None for r in page for c in key):
            raise rc.Unreadable(stage, "a row without its key")
        out.extend(page)
        if len(page) < PAGE:
            return out
        if len(out) >= max_rows:
            raise rc.Unreadable(stage, f"more than {max_rows} rows")
        last = page[-1]


def read_table(target: rc.Target, table: str, key: tuple[str, ...], *, max_rows: int = MAX_TABLE_ROWS,
               attempts: int = 2) -> list[dict]:
    """Every row and column of pds.<table>, paged by its primary key. The consistency boundary: after the
    last page the table's keys are read again, and the copy is answered only when they are exactly the keys
    it holds (so a row added or removed while the table was being read is never certified as a complete
    copy: the read is repeated, then refused). TableMissing when PostgREST does not know the table;
    Unreadable for anything else (the reason carries a status or a fixed text only)."""
    if not TABLE_RE.match(table) or table in EXCLUDED_TABLES:
        raise ValueError("not a table this job copies")
    if not key or not all(re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", c) for c in key):
        raise ValueError("a table is read only by its primary key")
    stage = f"table_{table}"
    for _ in range(attempts):
        rows = _keyset_read(target, stage, table, "*", key, max_rows)
        keys = [_key_of(r, key) for r in rows]
        if len(set(keys)) != len(keys):
            raise rc.Unreadable(stage, "the key is not unique")
        again = _keyset_read(target, stage, table, ",".join(key), key, max_rows)
        if [_key_of(r, key) for r in again] == keys:
            return rows
    raise rc.Unreadable(stage, "the table changed during the read")


def list_documents(target: rc.Target) -> tuple[dict[str, dict], int]:
    """documents/<id> -> {"size", "type"} from the bucket listing, and the count of entries that are not a
    document's file (a top-level file, a nested folder, a placeholder): those are not copied."""
    objects: dict[str, dict] = {}
    unexpected = 0
    for item in target.list_objects(""):
        if item.get("id") or item.get("name") != "documents":
            unexpected += 1
    for item in target.list_objects("documents"):
        path = f"documents/{item.get('name')}"
        if not item.get("id") or not rc.PATH_RE.match(path):
            unexpected += 1
            continue
        meta = item.get("metadata") or {}
        objects[path] = {"size": meta.get("size"), "type": meta.get("mimetype")}
    return objects, unexpected


def fetch_object(target: rc.Target, path: str) -> Optional[bytes]:
    """One file's bytes with the service role (read-only GET), or None when Storage does not hold them.
    Raises Unreadable for a refusal (denied=True), a redirect, or a read that kept failing after the retries."""
    if not rc.PATH_RE.match(path):
        raise ValueError("not a document path")
    status, data = target._get("download", "GET",
                               f"{target.url}/storage/v1/object/{rc.BUCKET}/{urllib.parse.quote(path)}", target._h())
    if rc._not_found(status, data):
        return None
    rc._ok("download", status)
    return data


# ---------------------------------------------------------------- the pack
@dataclass
class Snapshot:
    tables: dict[str, list[dict]] = field(default_factory=dict)  # name -> rows (medical tables first)
    missing_tables: list[str] = field(default_factory=list)
    unkeyed_tables: list[str] = field(default_factory=list)       # no primary key the cursor can page by: not copied
    objects: dict[str, dict] = field(default_factory=dict)        # documents/<id> -> {"size", "type"}
    unexpected_paths: int = 0
    openapi: Optional[bytes] = None
    problems: list[str] = field(default_factory=list)             # partial-run codes, in order, no duplicates

    def problem(self, code: str) -> None:
        if code not in self.problems:
            self.problems.append(code)


def collect(target: rc.Target, *, rebuild_tables: tuple[str, ...] = REBUILD_TABLES) -> Snapshot:
    """Everything except the file bytes, read BEFORE any encryption starts, so a failed core read leaves no
    ciphertext. A refused or failed read of a medical table or of the listing stops the run."""
    snap = Snapshot()
    raw, spec = read_openapi(target)
    snap.openapi = raw
    if raw is None:
        snap.problem("schema_unread")
    for table in MEDICAL_TABLES:
        try:
            snap.tables[table] = read_table(target, table, ("id",))  # both keyed by their uuid primary key
        except TableMissing:
            raise BackupError("medical_table_missing") from None
        except rc.Unreadable as e:
            raise BackupError("read_denied" if e.denied else f"read_failed_{table}") from None
    # Storage pages its listing by OFFSET (no cursor there): it is read twice and must agree, so a file
    # removed or added while it was listed is never missed silently (once more, then the run is partial).
    try:
        snap.objects, snap.unexpected_paths = list_documents(target)
        for _ in range(2):
            again = list_documents(target)
            if again == (snap.objects, snap.unexpected_paths):
                break
            snap.objects, snap.unexpected_paths = again
        else:
            snap.problem("listing_changed")
    except rc.Unreadable as e:
        raise BackupError("read_denied" if e.denied else "read_failed_objects") from None
    if snap.unexpected_paths:
        snap.problem("unexpected_paths")
    for table in rebuild_tables:
        key = table_key(spec, table)
        if key is None:
            snap.missing_tables.append(table)
            continue
        if key == UNKEYED:
            snap.unkeyed_tables.append(table)
            snap.problem("rebuild_table_unkeyed")  # never copied as if it were complete
            continue
        try:
            snap.tables[table] = read_table(target, table, key)
        except TableMissing:
            snap.missing_tables.append(table)
        except rc.Unreadable as e:
            if e.denied:
                raise BackupError("read_denied") from None
            snap.problem("rebuild_table_unreadable")
    reconcile_references(target, snap, spec)
    return snap


def reconcile_references(target: rc.Target, snap: Snapshot, spec: Optional[dict]) -> None:
    """Each table is consistent on its own (read_table), but they are read one after another: a stack and its
    items created (or removed) between the two reads would leave an item whose stack the copy does not hold.
    Every reference between two copied tables is checked; the tables on both sides of a broken one are read
    again (up to REFERENCE_ROUNDS times), and a copy still broken after that is partial
    (tables_inconsistent), never complete. A row pointing into a table no backup holds is partial too
    (parent_not_recoverable)."""
    broken = broken_references(snap.tables, spec)
    rounds = 0
    while broken and rounds < REFERENCE_ROUNDS:
        rounds += 1
        involved = {t for pair in broken for t in pair}
        for table in [t for t in list(snap.tables) if t in involved]:  # the copy's own order: medical first
            _reread(target, snap, spec, table)
        broken = broken_references(snap.tables, spec)
    if broken:
        snap.problem("tables_inconsistent")
    if unrecoverable_parents(snap.tables, spec):
        snap.problem("parent_not_recoverable")


def _reread(target: rc.Target, snap: Snapshot, spec: Optional[dict], table: str) -> None:
    """One table read again for reconcile_references(), with the first read's outcomes: a medical table that
    cannot be read stops the run; a wider one is dropped from the copy and the run is partial."""
    try:
        snap.tables[table] = read_table(target, table, ("id",) if table in MEDICAL_TABLES else table_key(spec, table))
    except TableMissing:
        if table in MEDICAL_TABLES:
            raise BackupError("medical_table_missing") from None
        snap.tables.pop(table, None)
        snap.missing_tables.append(table)
    except rc.Unreadable as e:
        if e.denied:
            raise BackupError("read_denied") from None
        if table in MEDICAL_TABLES:
            raise BackupError(f"read_failed_{table}") from None
        snap.tables.pop(table, None)
        snap.problem("rebuild_table_unreadable")


def _add(tar: tarfile.TarFile, name: str, data: bytes, mtime: float) -> None:
    if not MEMBER_RE.match(name):
        raise ValueError("not a pack member name")
    info = tarfile.TarInfo(name)
    info.size, info.mtime, info.mode = len(data), int(mtime), 0o600
    tar.addfile(info, io.BytesIO(data))


def _dump(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def write_pack(stream: BinaryIO, snap: Snapshot, target: rc.Target, now: datetime,
               fetch: Callable[[rc.Target, str], Optional[bytes]] = fetch_object) -> dict:
    """Writes the tar stream (into age's stdin) and answers the manifest it wrote last. The file bytes are
    downloaded one at a time, added and dropped: at most one file is held in memory."""
    mtime = now.timestamp()
    manifest: dict = {"format": FORMAT, "version": FORMAT_VERSION, "tool": TOOL_VERSION,
                      "created_at": now.isoformat(timespec="seconds"), "tables": {}, "missing_tables": [],
                      "objects": {}, "schema": False, "recovery_manifest": False, "unexpected_paths": snap.unexpected_paths}
    with tarfile.open(fileobj=stream, mode="w|", format=tarfile.PAX_FORMAT) as tar:
        if snap.openapi is not None and len(snap.openapi) > MAX_MEMBER_BYTES:
            snap.problem("schema_too_large")
        elif snap.openapi is not None:
            _add(tar, "schema/openapi.json", snap.openapi, mtime)
            manifest["schema"] = True
        for table, rows in snap.tables.items():
            data = _dump(rows)
            if len(data) > MAX_MEMBER_BYTES:  # the drill could not read it back: never report it as copied
                if table in MEDICAL_TABLES:
                    raise BackupError("medical_table_too_large")
                snap.problem("table_too_large")
                continue
            _add(tar, f"tables/pds/{table}.json", data, mtime)
            manifest["tables"][table] = {"rows": len(rows), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        manifest["missing_tables"] = sorted(snap.missing_tables)
        manifest["unkeyed_tables"] = sorted(snap.unkeyed_tables)
        manifest["uncovered_tables"] = sorted(UNCOVERED_TABLES)  # known gaps, by design (see UNCOVERED_TABLES)

        opened: dict[str, dict] = {}
        docs = {d.get("storage_path"): d for d in snap.tables.get("medical_documents", [])}
        ready = {p for p, d in docs.items() if d.get("status") == "ready" and rc.PATH_RE.match(str(p or ""))}
        for path in sorted(set(snap.objects) | ready):
            if path not in snap.objects:
                snap.problem("files_missing")  # a confirmed document whose file is not in the listing
                continue
            try:
                data = fetch(target, path)
            except rc.Unreadable as e:
                if e.denied:
                    raise BackupError("read_denied") from None
                snap.problem("files_unread")
                continue
            if data is None:
                snap.problem("files_missing")
                continue
            if len(data) > MAX_MEMBER_BYTES:
                snap.problem("files_too_large")
                continue
            declared = (docs.get(path) or {}).get("size_bytes")
            listed = snap.objects[path].get("size")
            if len(data) != listed or (declared is not None and declared != len(data)):
                snap.problem("size_mismatch")
            sha = hashlib.sha256(data).hexdigest()
            _add(tar, f"objects/{path}", data, mtime)
            manifest["objects"][path] = {"size": len(data), "sha256": sha,
                                         "type": rc.norm_type((docs.get(path) or {}).get("mime_type")
                                                              or snap.objects[path].get("type"))}
            opened[path] = {"served": True, "size": len(data), "sha256": sha}
            del data

        # The format recovery_check.py --manifest reads, only when it is a usable reference.
        inv = rc.Inventory(documents=snap.tables.get("medical_documents", []), labs=snap.tables.get("lab_results", []),
                           objects={p: v for p, v in snap.objects.items() if p in opened}, opened=opened)
        recovery = rc.build_manifest(inv, now)
        if rc.manifest_problem(recovery) is None:
            _add(tar, "recovery-manifest.json", _dump(recovery), mtime)
            manifest["recovery_manifest"] = True
        elif inv.documents or inv.labs or opened:
            snap.problem("recovery_manifest_refused")
        manifest["problems"] = list(snap.problems)
        _add(tar, "manifest.json", _dump(manifest), mtime)  # last: a pack is a restore point once this is in
    return manifest


# ---------------------------------------------------------------- retention (pure) and the destination
def backup_time(name: str) -> Optional[datetime]:
    m = NAME_RE.match(name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def ok_marker(backup_name: str) -> str:
    m = NAME_RE.match(backup_name)
    if not m:
        raise ValueError("not a backup name")
    return f"onyx-backup-{m.group(1)}.ok"


def write_ok_marker(backup: Path) -> None:
    """Commits the completeness marker for `backup`: written under a hidden .partial name, renamed, then
    read back and checked. Raises OSError or BackupError("marker_unwritable") when it is not durable."""
    marker = backup.parent / ok_marker(backup.name)
    partial = backup.parent / f".{marker.name}.partial"
    partial.write_bytes(_dump({"backup": backup.name, "size": backup.stat().st_size}))
    os.replace(partial, marker)
    if not marker_valid(backup.parent, backup.name):
        raise BackupError("marker_unwritable")


def _is_regular(path: Path) -> bool:
    """Whether `path` is a regular file, by an explicit stat: False only when it does not exist. Any other
    filesystem error (access denied, a OneDrive file that cannot be reached) propagates. Never Path.is_file():
    since Python 3.14 it answers False for ANY OSError, which would make an unreadable completeness marker
    look absent and let retention prune the last complete backup."""
    try:
        st = os.stat(path)
    except (FileNotFoundError, NotADirectoryError):
        return False
    return stat_mod.S_ISREG(st.st_mode)


def marker_valid(dest: Path, backup_name: str) -> bool:
    """True when the backup's completeness marker exists, names it and matches its size. A marker that is
    missing, empty, not this job's or for another file is not evidence. An OSError while checking or reading
    one (including its stat) propagates: prune() then removes nothing (a marker it could not read must
    never let the last complete backup look incomplete)."""
    marker, backup = dest / ok_marker(backup_name), dest / backup_name
    if not _is_regular(marker) or not _is_regular(backup):
        return False
    try:
        got = json.loads(marker.read_bytes().decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return False
    return (isinstance(got, dict) and got.get("backup") == backup_name and type(got.get("size")) is int
            and got["size"] == backup.stat().st_size)


# ------------------------------------------------------------- remote durability (local record)
def remote_state_file() -> Path:
    """The local record of which backups have positive evidence of a REMOTE copy: the job's own state
    folder under %LOCALAPPDATA% — never under OneDrive (it describes OneDrive), never in the repo, never
    the backup folder. Holds the backup name, its size and the confirmation time only."""
    return local_root() / "backup-state" / "remote-confirmations.json"


def load_remote_confirmations(state_file: Optional[Path] = None) -> dict:
    """name -> {"size", "confirmed_at"} for every backup whose remote copy is confirmed. A missing or
    unreadable record answers {} — "unknown", never a guessed confirmation."""
    p = state_file or remote_state_file()
    try:
        raw = json.loads(p.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return {}
    backups = raw.get("backups") if isinstance(raw, dict) else None
    if not isinstance(backups, dict):
        return {}
    return {n: r for n, r in backups.items() if isinstance(r, dict)}


def record_remote_confirmation(dest: Path, backup_name: str, *, now: Optional[datetime] = None,
                               state_file: Optional[Path] = None) -> None:
    """The ONLY writer of a remote confirmation: called by the code path that obtained positive evidence
    that the remote copy exists (none is built yet — until one is, the record stays empty and every run
    answers offsite_unconfirmed). Records the backup name, its size and the confirmation time, and
    nothing else. Refuses a name that is not one of this job's backups (and an error reading the file
    propagates: a file that is not there is not confirmed) and a state file under OneDrive or in the repo."""
    if not NAME_RE.match(backup_name):
        raise ValueError("not a backup name")
    p = state_file or remote_state_file()
    if under_onedrive(p) or is_under(p, ROOT):
        raise BackupError("state_unsafe")
    size = (dest / backup_name).stat().st_size
    recs = load_remote_confirmations(p)
    recs[backup_name] = {"size": size, "confirmed_at": (now or datetime.now(timezone.utc)).isoformat(timespec="seconds")}
    p.parent.mkdir(parents=True, exist_ok=True)
    partial = p.parent / f".{p.name}.partial"
    partial.write_bytes(_dump({"backups": recs}))
    os.replace(partial, p)


def remote_confirmed_names(dest: Path, confirmations: dict) -> set:
    """Which of the record's confirmations still describe a backup in `dest`: the name is one of this
    job's, the file is a regular file and its size is the recorded size (a record whose file changed no
    longer describes it). A stat error propagates, so a confirmation that cannot be checked stops the
    prune rather than letting the backup look unconfirmed."""
    out: set = set()
    for name, rec in (confirmations or {}).items():
        if not NAME_RE.match(name) or not isinstance(rec, dict):
            continue
        path = dest / name
        if not _is_regular(path):
            continue
        size = rec.get("size")
        if type(size) is int and size == path.stat().st_size:
            out.add(name)
    return out


def retention_keep(names: list[str], complete: set[str], remote: Optional[set] = None) -> set:
    """The newest KEEP_WEEKLY backups, plus the FIRST backup of each of the KEEP_MONTHLY most recent
    months, plus — wherever they fall — the newest backup in `complete` (its completeness marker
    verified) and the newest in `remote` (positive evidence that a remote copy exists; never process
    presence, folder existence or file age, which are not evidence of upload). Names that are not
    backups are never in the answer, and never pruned either (prune() looks only at this job's names)."""
    dated = sorted(((t, n) for n in names if (t := backup_time(n)) is not None), reverse=True)
    keep = {n for _, n in dated[:KEEP_WEEKLY]}
    for group in (complete, remote or set()):
        verified = [n for _, n in dated if n in group]
        if verified:
            keep.add(verified[0])
    first_of_month: dict[tuple[int, int], str] = {}
    for t, n in dated:  # newest first, so the last assignment per month is its earliest backup
        first_of_month[(t.year, t.month)] = n
    for month in sorted(first_of_month, reverse=True)[:KEEP_MONTHLY]:
        keep.add(first_of_month[month])
    return keep


def prune(dest: Path, now: datetime, unlink: Callable[[Path], None] = lambda p: p.unlink(),
          state_file: Optional[Path] = None) -> int:
    """Removes backups outside retention_keep(), markers whose backup is not kept, and this job's own
    unfinished copies older than a day. Only names this job writes are touched (OneDrive keeps a removed
    file in its recycle bin for 30 days). Every marker is checked BEFORE anything is removed; an error while
    reading one stops the prune with nothing removed. Raises BackupError("offsite_unconfirmed") when no
    backup in the folder has a recorded remote confirmation: without one, removing anything could delete
    the last backup that really reached remote storage, so nothing is removed at all. Every entry with one
    of this job's names is checked by an explicit stat (_is_regular), and every removal is decided before
    the first one is made: a filesystem error anywhere in that stops the prune with nothing removed.
    Returns how many backups and stale copies were removed."""
    ours = [p for p in dest.iterdir() if NAME_RE.match(p.name) or OK_RE.match(p.name) or DEST_PARTIAL_RE.match(p.name)]
    names = [p.name for p in ours if _is_regular(p)]
    complete = {n for n in names if NAME_RE.match(n) and ok_marker(n) in names and marker_valid(dest, n)}
    confirmed = remote_confirmed_names(dest, load_remote_confirmations(state_file)) & set(names)
    if not confirmed:
        raise BackupError("offsite_unconfirmed")
    keep = retention_keep(names, complete, remote=confirmed)
    kept_markers = {ok_marker(n) for n in keep}
    plan: list[tuple[Path, bool]] = []  # (path, counts as a removed backup or stale copy)
    for name in names:
        path = dest / name
        stale_partial = bool(DEST_PARTIAL_RE.match(name)) and now.timestamp() - path.stat().st_mtime > 86400
        if (NAME_RE.match(name) and name not in keep) or stale_partial:
            plan.append((path, True))
        elif OK_RE.match(name) and name not in kept_markers:
            plan.append((path, False))
    for path, _counted in plan:
        unlink(path)
    return sum(1 for _, counted in plan if counted)


def clear_stale_tmp(tmp: Path, now: datetime) -> None:
    """Ciphertext a killed run left in the temporary folder (an exception removes its own): this job's
    .tmp names only, older than a day, in that folder only."""
    try:
        entries = list(tmp.iterdir()) if tmp.is_dir() else []
    except OSError:
        return
    for p in entries:
        try:
            if TMP_RE.match(p.name) and p.is_file() and now.timestamp() - p.stat().st_mtime > 86400:
                p.unlink()
        except OSError:
            pass


def newest_backup(dest: Path) -> Optional[Path]:
    dated = sorted(((t, p) for p in dest.iterdir() if p.is_file() and (t := backup_time(p.name))), reverse=True) \
        if dest.is_dir() else []
    return dated[0][1] if dated else None


def place(tmp_file: Path, dest: Path, final_name: str) -> Path:
    """Copies the finished ciphertext into the backup folder under a hidden temporary name and renames it, so
    the folder never holds a half-written backup under a backup name."""
    dest.mkdir(parents=True, exist_ok=True)
    partial = dest / f".{final_name}.partial"
    shutil.copyfile(tmp_file, partial)
    if partial.stat().st_size != tmp_file.stat().st_size:
        partial.unlink()
        raise BackupError("dest_unwritable")
    final = dest / final_name
    os.replace(partial, final)
    return final


# ---------------------------------------------------------------- the backup run
@dataclass
class RunResult:
    status: str               # success | partial | failed
    code: Optional[str]       # the first problem, or the failure
    written: Optional[Path] = None
    counts: dict = field(default_factory=dict)  # printed locally only; never in the heartbeat
    pruned: int = 0


def run_backup(target: rc.Target, *, recipient: str, cipher, dest: Path, tmp: Path, now: Optional[datetime] = None,
               dry_run: bool = False, rebuild_tables: tuple[str, ...] = REBUILD_TABLES,
               fetch: Callable[[rc.Target, str], Optional[bytes]] = fetch_object,
               sync_probe: Optional[Callable[[Path], bool]] = None) -> RunResult:
    now = now or datetime.now(timezone.utc)
    check_places(dest, tmp)
    snap = collect(target, rebuild_tables=rebuild_tables)
    final_name = f"onyx-backup-{now.strftime('%Y%m%dT%H%M%SZ')}.tar.age"
    if dry_run:
        sink = _Counting()
        manifest = write_pack(sink, snap, target, now, fetch=fetch)
        return _result(snap, manifest, None, sink.bytes)
    try:
        tmp.mkdir(parents=True, exist_ok=True)
    except OSError:
        raise BackupError("tmp_unwritable") from None
    clear_stale_tmp(tmp, now)
    tmp_file = tmp / f"{final_name}.tmp"
    try:
        try:
            with cipher.encrypt_to(recipient, tmp_file) as stream:
                manifest = write_pack(stream, snap, target, now, fetch=fetch)
        except CipherError as e:
            raise BackupError(e.code) from None
        except (OSError, tarfile.TarError):
            raise BackupError("encrypt_failed") from None
        size = tmp_file.stat().st_size if tmp_file.exists() else 0
        if size == 0:
            raise BackupError("encrypt_failed")
        try:
            written = place(tmp_file, dest, final_name)
        except OSError:
            raise BackupError("dest_unwritable") from None
    finally:
        try:
            if tmp_file.exists():
                tmp_file.unlink()  # ciphertext only: the plaintext was never written
        except OSError:
            pass
    result = _result(snap, manifest, written, size)
    if not (sync_probe or onedrive_sync_ready)(dest):
        # a copy that only exists on this PC is not an off-site backup, and removing older backups from a
        # folder that is not syncing could leave no uploaded copy at all
        log.warning("destination is not a syncing OneDrive folder; nothing pruned")
        return RunResult("partial", "offsite_unsynced", written, result.counts)
    if result.status == "success":
        # Success needs durable evidence: without a marker that reads back, this backup would not count as
        # complete for retention, so the run fails and nothing is pruned (the backup itself stays).
        try:
            write_ok_marker(written)
        except (OSError, BackupError):
            log.warning("retention: could not commit the completeness marker; nothing pruned")
            return RunResult("failed", "marker_unwritable", written, result.counts)
    # Retention runs after partial runs too (so they cannot grow the folder without bound); the newest
    # backup whose marker verifies, and the newest the record confirms, are always kept.
    # Local completion is not remote durability: the OneDrive probe above says the folder syncs, not
    # that this copy was uploaded (a paused, signed-out, offline or stuck client passes it), and elapsed
    # time is not evidence either. Only a confirmation recorded by the one code path that obtained it
    # (record_remote_confirmation) is; no mechanism is built, so the record stays empty ("unknown") and
    # the run is partial (offsite_unconfirmed) until one exists.
    confirmed = remote_confirmed_names(dest, load_remote_confirmations())
    if written.name not in confirmed:
        if result.status == "success":
            result.status, result.code = "partial", "offsite_unconfirmed"
        if not confirmed:
            # Never prune when no remote confirmation exists at all: removing older backups from a folder
            # that may never have uploaded anything could delete the last backup that really is off-site.
            log.warning("retention: no backup is confirmed off-site; nothing pruned")
            return RunResult("partial", result.code or "offsite_unconfirmed", written, result.counts)
    try:
        result.pruned = prune(dest, now)
    except OSError:
        log.warning("retention: could not prune old backups (OSError)")
    except BackupError as e:
        log.warning("retention: %s; nothing pruned", e.code)
    return result


class _Counting(io.RawIOBase):
    """The dry run's sink: counts bytes, keeps nothing."""

    def __init__(self) -> None:
        self.bytes = 0

    def writable(self) -> bool:
        return True

    def write(self, b) -> int:
        self.bytes += len(b)
        return len(b)


def _result(snap: Snapshot, manifest: dict, written: Optional[Path], size: int) -> RunResult:
    counts = {"tables": len(manifest["tables"]), "rows": sum(t["rows"] for t in manifest["tables"].values()),
              "documents": len(snap.tables.get("medical_documents", [])), "lab_results": len(snap.tables.get("lab_results", [])),
              "files": len(manifest["objects"]), "file_bytes": sum(o["size"] for o in manifest["objects"].values()),
              "missing_tables": len(manifest["missing_tables"]), "pack_bytes": size}
    status = "partial" if snap.problems else "success"
    return RunResult(status, snap.problems[0] if snap.problems else None, written, counts)


# ---------------------------------------------------------------- the restore drill
@dataclass
class DrillReport:
    status: str = "incomplete"  # pass | fail | incomplete
    checks: dict = field(default_factory=dict)  # name -> True / False / None (not established)
    counts: dict = field(default_factory=dict)
    seconds: float = 0.0
    backup_age_days: Optional[float] = None

    def as_dict(self) -> dict:
        return {"status": self.status, "checks": self.checks, "counts": self.counts,
                "seconds": round(self.seconds, 1), "backup_age_days": self.backup_age_days}


def _safe_member(m: tarfile.TarInfo) -> bool:
    name = m.name
    p = PurePosixPath(name)
    return (m.isreg() and bool(MEMBER_RE.match(name)) and not p.is_absolute() and ".." not in p.parts
            and 0 <= m.size <= MAX_MEMBER_BYTES)


def run_drill(*, dest: Path, identity: Path, cipher, root: Optional[Path] = None, now: Optional[datetime] = None,
              hold: Optional[Callable[[Path], None]] = None) -> DrillReport:
    """Decrypts the newest backup into a new folder under `root`, checks it against its manifest and removes
    the folder (also when a check or the decryption fails). Never writes to Supabase."""
    report = DrillReport()
    now = now or datetime.now(timezone.utc)
    root = root or drill_root()
    if under_onedrive(root) or is_under(root, ROOT) or is_under(root, dest):
        report.checks["isolated_target"] = False
        report.status = "fail"
        return report
    report.checks["isolated_target"] = True
    newest = newest_backup(dest)
    if newest is None:
        report.checks["backup_found"] = False
        return report
    report.checks["backup_found"] = True
    t = backup_time(newest.name)
    report.backup_age_days = round((now - t).total_seconds() / 86400, 1) if t else None
    if not identity.is_file():
        report.checks["private_key_found"] = False
        return report
    root.mkdir(parents=True, exist_ok=True)
    run_dir = root / f"run-{secrets.token_hex(8)}"
    run_dir.mkdir()
    t0 = time.monotonic()
    seen: dict[str, dict] = {}
    unexpected = 0
    try:
        try:
            with cipher.decrypt_from(identity, newest) as stream:
                with tarfile.open(fileobj=stream, mode="r|") as tar:
                    for m in tar:
                        if not _safe_member(m) or m.name in seen:
                            unexpected += 1  # never extracted
                            continue
                        src = tar.extractfile(m)
                        out_path = run_dir.joinpath(*PurePosixPath(m.name).parts)
                        if not is_under(out_path, run_dir):
                            unexpected += 1
                            continue
                        out_path.parent.mkdir(parents=True, exist_ok=True)
                        h, n = hashlib.sha256(), 0
                        with open(out_path, "wb") as f:
                            while src is not None and (chunk := src.read(1 << 20)):
                                h.update(chunk)
                                n += len(chunk)
                                f.write(chunk)
                        seen[m.name] = {"size": n, "sha256": h.hexdigest()}
            report.checks["decrypted"] = True
        except (CipherError, tarfile.TarError, OSError, EOFError):
            report.checks["decrypted"] = False
        report.checks["no_unexpected_members"] = unexpected == 0
        _verify(run_dir, seen, report)
        if hold and report.checks.get("decrypted"):
            _view_copy(run_dir)
            hold(run_dir)
    finally:
        report.seconds = time.monotonic() - t0
        _remove_run_dir(run_dir, root)
        report.checks["decrypted_copy_removed"] = not run_dir.exists()
    vals = list(report.checks.values())
    report.status = "fail" if False in vals else ("pass" if None not in vals else "incomplete")
    return report


def _verify(run_dir: Path, seen: dict, report: DrillReport) -> None:
    c = report.checks
    manifest = None
    if "manifest.json" in seen:
        try:
            manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            manifest = None
    ok = (isinstance(manifest, dict) and manifest.get("format") == FORMAT and manifest.get("version") == FORMAT_VERSION
          and isinstance(manifest.get("tables"), dict) and isinstance(manifest.get("objects"), dict)
          and isinstance(manifest.get("problems"), list))
    c["manifest_valid"] = ok
    if not ok:
        for k in ("backup_complete", "tables_match", "objects_match", "no_unlisted_members", "medical_links_hold",
                  "references_hold", "recovery_manifest_valid"):
            c[k] = False if "decrypted" in c and c["decrypted"] else None
        return
    # A backup that recorded a problem (a wider table it could not read, a file it could not copy) is not a
    # full restore point, even when everything it does hold verifies: the drill never passes it.
    c["backup_complete"] = manifest["problems"] == []
    tables, objects = manifest["tables"], manifest["objects"]
    rows_total, tables_ok = 0, True
    parsed: dict[str, list] = {}
    for name, meta in tables.items():
        member = f"tables/pds/{name}.json"
        got = seen.get(member)
        if not (isinstance(meta, dict) and got and got["sha256"] == meta.get("sha256") and got["size"] == meta.get("bytes")):
            tables_ok = False
            continue
        try:
            rows = json.loads((run_dir / "tables" / "pds" / f"{name}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            tables_ok = False
            continue
        if not isinstance(rows, list) or len(rows) != meta.get("rows"):
            tables_ok = False
            continue
        parsed[name] = rows
        rows_total += len(rows)
    c["tables_match"] = tables_ok and all(t in tables for t in MEDICAL_TABLES)
    objects_ok = True
    for path, meta in objects.items():
        got = seen.get(f"objects/{path}")
        if not (isinstance(meta, dict) and got and got["sha256"] == meta.get("sha256") and got["size"] == meta.get("size")):
            objects_ok = False
    c["objects_match"] = objects_ok
    listed = {"manifest.json"} | {f"tables/pds/{t}.json" for t in tables} | {f"objects/{p}" for p in objects}
    if manifest.get("schema"):
        listed.add("schema/openapi.json")
    if manifest.get("recovery_manifest"):
        listed.add("recovery-manifest.json")
    c["no_unlisted_members"] = set(seen) <= listed and listed <= set(seen)
    docs = parsed.get("medical_documents", [])
    labs = parsed.get("lab_results", [])
    doc_ids = {d.get("id") for d in docs if isinstance(d, dict)}
    links_ok = all(isinstance(r, dict) and (r.get("document_id") is None or r.get("document_id") in doc_ids) for r in labs)
    ready_ok = all(f"objects/{d.get('storage_path')}" in seen for d in docs
                   if isinstance(d, dict) and d.get("status") == "ready")
    c["medical_links_hold"] = links_ok and ready_ok if "medical_documents" in parsed and "lab_results" in parsed else False
    # Every reference the pack's own schema declares, between the tables it holds (a row whose parent row is
    # not in the copy could not be restored), and none into a table no backup holds. Unknown without a schema.
    spec = None
    if manifest.get("schema") and "schema/openapi.json" in seen:
        try:
            spec = json.loads((run_dir / "schema" / "openapi.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            spec = None
    if isinstance(spec, dict) and tables_ok:
        c["references_hold"] = not broken_references(parsed, spec) and not unrecoverable_parents(parsed, spec)
    else:
        c["references_hold"] = False if not tables_ok else None
    if manifest.get("recovery_manifest"):
        try:
            rec = json.loads((run_dir / "recovery-manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            rec = None
        c["recovery_manifest_valid"] = bool(
            rec is not None and rc.manifest_problem(rec) is None
            and all((objects.get(p) or {}).get("sha256") == v.get("sha256") and (objects.get(p) or {}).get("size") == v.get("size")
                    for p, v in rec["objects"].items()))
    else:
        c["recovery_manifest_valid"] = None  # the backup was partial: no reference to judge a restore by
    report.counts = {"tables": len(parsed), "rows": rows_total, "documents": len(docs), "lab_results": len(labs),
                     "files": sum(1 for p in objects if f"objects/{p}" in seen),
                     "file_bytes": sum(seen[f"objects/{p}"]["size"] for p in objects if f"objects/{p}" in seen)}


def _view_copy(run_dir: Path) -> None:
    """For a person to open one restored file: a copy of the first restored document with its extension."""
    try:
        docs = json.loads((run_dir / "tables" / "pds" / "medical_documents.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    for d in docs if isinstance(docs, list) else []:
        src = run_dir / "objects" / str(d.get("storage_path") or "x")
        if isinstance(d, dict) and rc.PATH_RE.match(str(d.get("storage_path") or "")) and src.is_file():
            shutil.copyfile(src, run_dir / ("open-me" + MIME_EXT.get(rc.norm_type(d.get("mime_type")), "")))
            return


def _remove_run_dir(run_dir: Path, root: Path) -> None:
    # only this run's own folder, under the drill root: never anything else
    if run_dir.parent.resolve() == root.resolve() and run_dir.name.startswith("run-") and run_dir.exists():
        shutil.rmtree(run_dir, ignore_errors=True)


# ---------------------------------------------------------------- the key pair
def keygen(identity: Path = DEFAULT_IDENTITY_FILE, recipient_file: Path = DEFAULT_RECIPIENT_FILE,
           run: Callable = subprocess.run, out=None) -> int:
    out = out or _stdout()
    for p in (identity, recipient_file):
        if under_onedrive(p) or is_under(p, ROOT):
            print("refused: a key file never goes under OneDrive or into the repo", file=out)
            return 1
    if _resolved(identity) == _resolved(recipient_file):
        print("refused: the private key and the public recipient need two different files", file=out)
        return 1
    if identity.exists() or recipient_file.exists():
        print("refused: a backup key already exists; nothing was changed (a new key could not read the old backups)",
              file=out)
        return 1
    keygen_bin = find_tool("age-keygen")
    if not keygen_bin:
        print("incomplete: age-keygen not found; install it with: winget install FiloSottile.age", file=out)
        return 2
    flags = {"creationflags": _no_window(), "stdin": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if run([keygen_bin, "-o", str(identity)], stdout=subprocess.DEVNULL, check=False, **flags).returncode != 0:
        print("failed: age-keygen could not create the key", file=out)
        return 1
    if os.name == "nt":
        user = os.environ.get("USERNAME") or ""
        res = run(["icacls", str(identity), "/inheritance:r", "/grant:r", f"{user}:F"],
                  stdout=subprocess.DEVNULL, check=False, **flags)
        if not user or res.returncode != 0:
            print("warning: could not limit the key file's access to this user; do it by hand", file=out)
    else:
        os.chmod(identity, 0o600)
    got = run([keygen_bin, "-y", str(identity)], stdout=subprocess.PIPE, check=False, **flags)
    pub = (got.stdout or b"").decode("ascii", "replace").strip()
    if got.returncode != 0 or not RECIPIENT_RE.match(pub):
        print("failed: could not read the public recipient from the new key", file=out)
        return 1
    recipient_file.write_text(pub + "\n", encoding="utf-8")
    print(f"created the backup key pair: private key {identity}, public recipient {recipient_file}", file=out)
    print("NOW copy the private key file's contents into the password manager (and print one copy): "
          "without it no backup can ever be decrypted. Never put it under OneDrive or in the repo.", file=out)
    return 0


# ---------------------------------------------------------------- heartbeat, logging, CLI
class _HeartbeatClient:
    """The supabase-py shape sync_log_helper.log_sync speaks (schema().table().insert().execute()), over the
    backup's own request path: exactly the production origin (checked before anything is sent), a redirect
    never followed, the service-role key the backup resolved and read with. Deliberately not
    activity_logger.make_client(), which has its own URL and key settings the backup never checked."""

    def __init__(self, target: rc.Target) -> None:
        self._target, self._table, self._row = target, None, None

    def schema(self, _name: str) -> "_HeartbeatClient":
        return self

    def table(self, name: str) -> "_HeartbeatClient":
        if name != "sync_log":
            raise ValueError("the backup writes only its heartbeat")
        self._table = name
        return self

    def insert(self, row: dict) -> "_HeartbeatClient":
        self._row = row
        return self

    def execute(self) -> None:
        t = self._target
        status, _ = rc.request(t.transport, "heartbeat", "POST", f"{rc.base_url(rc.PRODUCTION_ORIGIN)}/rest/v1/sync_log",
                               t._h(**{"Content-Type": "application/json", "Content-Profile": "pds",
                                       "Prefer": "return=minimal"}),
                               json.dumps([self._row]).encode("utf-8"), origin=rc.PRODUCTION_ORIGIN,
                               attempts=2, sleep=t.sleep)
        rc._ok("heartbeat", status)


def production_client(target: rc.Target) -> Optional[_HeartbeatClient]:
    """The heartbeat's writer for a production target; None for anything else."""
    if target.origin != rc.PRODUCTION_ORIGIN or target.drill:
        return None
    return _HeartbeatClient(target)


def heartbeat(client, status: str, started_at: float, code: Optional[str]) -> None:
    """ONE count-free row: status, a short code, the time (decision 5). records is always 0. Never raises:
    a heartbeat that cannot be written is logged by its exception type only."""
    if client is None:
        log.warning("heartbeat skipped: no production client (the key was not resolved)")
        return
    safe = code if code and re.fullmatch(r"[A-Za-z0-9_]{1,60}", code) else None
    try:
        from sync_log_helper import log_sync  # the one shared sync_log writer

        log_sync(client, SOURCE, DATA_TYPE, status, records=0, started_at=started_at, error=safe)
    except Exception as e:  # noqa: BLE001 - the run's own outcome stands; the type name only
        log.warning("heartbeat not written: %s", type(e).__name__)


def _stdout():
    return sys.stdout if sys.stdout is not None else open(os.devnull, "w")  # pythonw has no stdout


_HANDLER: Optional[logging.Handler] = None


def setup_logging() -> None:
    """One rotating log file (counts and codes only) under %LOCALAPPDATA%/Onyx/medical-backup."""
    global _HANDLER
    path = log_dir() / "backup.log"
    if _HANDLER is not None and getattr(_HANDLER, "baseFilename", None) == str(path.absolute()):
        return
    if _HANDLER is not None:
        log.removeHandler(_HANDLER)
        _HANDLER.close()
        _HANDLER = None
    try:
        log_dir().mkdir(parents=True, exist_ok=True)
        _HANDLER = RotatingFileHandler(path, maxBytes=512_000, backupCount=3, encoding="utf-8")
        _HANDLER.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        log.addHandler(_HANDLER)
        log.setLevel(logging.INFO)
    except OSError:
        pass


def _target(args, out) -> tuple[Optional[rc.Target], Optional[str]]:
    """The read target and its kind, decided from the exact origin before any key is read (recovery_check's
    rules). A drill target gets its own credentials only."""
    kind = rc.classify(args.url, args.drill_project)
    if kind is None:
        print("refused: the target must be exactly the production project or a drill target given as a bare "
              "origin; no key was read and nothing was sent", file=out)
        return None, None
    if kind == "drill":
        key_file = args.key_file if args.key_file and not rc._same_file(args.key_file, rc.DEFAULT_KEY_FILE) else None
        key = rc._read_key((rc.DRILL_ENV["service"],), key_file)
        if key and rc._names_production(key):
            print("refused: a drill credential belongs to the production project; nothing was sent", file=out)
            return None, None
    else:
        key = rc._read_key(("SUPABASE_SERVICE_ROLE_KEY",), args.key_file or rc.DEFAULT_KEY_FILE)
    if not key:
        raise BackupError("key_missing")
    return rc.Target(args.url, key, transport=args.transport, sleep=args.sleep, drill=False), kind


def cmd_backup(args, out, cipher_factory, heartbeat_client) -> int:
    started = time.time()
    kind = rc.classify(args.url, args.drill_project)
    production = kind == "production" and not args.dry_run
    if kind == "drill" and (args.dest is None or rc._same_file(args.dest, DEFAULT_DEST)):
        print("refused: a drill target needs its own --dest (never the real backup folder)", file=out)
        return 1
    dest = args.dest or DEFAULT_DEST
    hb = heartbeat_client  # tests inject one; production builds it from the validated target below
    try:
        target, kind = _target(args, out)
        if target is None:
            return 1
        if production and hb is None:
            hb = production_client(target)
        recipient = read_recipient(args.recipient_file)
        cipher = None
        if not args.dry_run:
            cipher = cipher_factory()
            if cipher is None:
                raise BackupError("age_missing")
        result = run_backup(target, recipient=recipient, cipher=cipher, dest=dest, tmp=args.tmp,
                            dry_run=args.dry_run)
    except BackupError as e:
        log.warning("backup failed: %s", e.code)
        print(f"medical backup: FAILED ({e.code})", file=out)
        if production:
            heartbeat(hb, "failed", started, e.code)
        return 1
    except Exception as e:  # noqa: BLE001 - a crash still writes its heartbeat; the type name only
        code = f"crash_{type(e).__name__}"[:60]
        log.warning("backup crashed: %s", code)
        print(f"medical backup: FAILED ({code})", file=out)
        if production:
            heartbeat(hb, "failed", started, code)
        return 1
    counts = ", ".join(f"{k} {v}" for k, v in result.counts.items())
    label = "DRY RUN (nothing written)" if args.dry_run else result.status.upper()
    print(f"medical backup: {label}" + (f" ({result.code})" if result.code else ""), file=out)
    print(f"counts: {counts}; old backups pruned {result.pruned}", file=out)
    log.info("backup %s%s; %s", result.status, f" ({result.code})" if result.code else "", counts)
    if production:
        heartbeat(hb, result.status, started, result.code)
    return {"success": 0, "partial": 2}.get(result.status, 1)


def cmd_drill(args, out, cipher_factory) -> int:
    cipher = cipher_factory()
    if cipher is None:
        print("incomplete: age not found; install it with: winget install FiloSottile.age", file=out)
        return 2

    def hold(run_dir: Path) -> None:
        print(f"open {run_dir / 'open-me'}.* in a viewer, note that it opens, then press Enter "
              "(the decrypted copy is removed afterwards)", file=out)
        try:
            input()
        except EOFError:
            pass

    report = run_drill(dest=args.dest or DEFAULT_DEST, identity=args.identity, cipher=cipher,
                       hold=hold if args.hold else None)
    print(json.dumps(report.as_dict(), indent=2) if args.json else
          f"medical backup drill: {report.status.upper()}\n" +
          "\n".join(f"  {('pass' if v else 'FAIL' if v is False else 'unknown'):<8} {k}" for k, v in report.checks.items()) +
          "\ncounts: " + ", ".join(f"{k} {v}" for k, v in report.counts.items()) +
          f"\nrestore time {report.seconds:.1f} s; backup age {report.backup_age_days} days", file=out)
    return {"pass": 0, "fail": 1}.get(report.status, 2)


def _age_cipher() -> Optional[AgeCli]:
    b = find_tool("age")
    return AgeCli(b) if b else None


def main(argv: Optional[list[str]] = None, *, transport: rc.Transport = rc.urllib_transport,
         sleep: Callable[[float], None] = time.sleep, cipher_factory: Callable[[], object] = _age_cipher,
         heartbeat_client=None, out=None) -> int:
    out = out or _stdout()
    ap = argparse.ArgumentParser(description="Encrypted off-site backup of /health/records, and its restore drill.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backup", help="read, pack, encrypt to the public recipient, write the ciphertext to OneDrive")
    b.add_argument("--url", default=os.environ.get("SUPABASE_URL") or rc.DEFAULT_URL)
    b.add_argument("--drill-project", help="ref of a throwaway hosted project used as a drill target")
    b.add_argument("--key-file", type=Path, help="service-role key file (default ~/.onyx_supabase_secret on production)")
    b.add_argument("--recipient-file", type=Path, default=DEFAULT_RECIPIENT_FILE)
    b.add_argument("--dest", type=Path, help=f"backup folder (default {DEFAULT_DEST})")
    b.add_argument("--dry-run", action="store_true", help="read and pack in memory, print counts, write nothing")
    d = sub.add_parser("drill", help="decrypt the newest backup into an isolated folder, verify, remove it")
    d.add_argument("--dest", type=Path, help=f"backup folder (default {DEFAULT_DEST})")
    d.add_argument("--identity", type=Path, default=DEFAULT_IDENTITY_FILE, help="the private key file")
    d.add_argument("--hold", action="store_true", help="pause so a person can open one restored file")
    d.add_argument("--json", action="store_true")
    k = sub.add_parser("keygen", help="create the age key pair once")
    k.add_argument("--identity", type=Path, default=DEFAULT_IDENTITY_FILE)
    k.add_argument("--recipient-file", type=Path, default=DEFAULT_RECIPIENT_FILE)
    args = ap.parse_args(argv)
    setup_logging()
    if args.cmd == "keygen":
        return keygen(args.identity, args.recipient_file, out=out)
    if args.cmd == "drill":
        return cmd_drill(args, out, cipher_factory)
    args.transport, args.sleep, args.tmp = transport, sleep, tmp_dir()
    lock = tmp_dir() / ".lock"
    try:
        tmp_dir().mkdir(parents=True, exist_ok=True)
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            fresh = time.time() - lock.stat().st_mtime < 6 * 3600
        except OSError:
            fresh = False
        if fresh:
            print("medical backup: another run is in progress (locked)", file=out)
            return 2
        try:
            lock.unlink(missing_ok=True)  # a lock left by a run that died hours ago
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except OSError:
            print("medical backup: another run is in progress (locked)", file=out)
            return 2
    except OSError:
        fd = None
    try:
        return cmd_backup(args, out, cipher_factory, heartbeat_client)
    finally:
        if fd is not None:
            os.close(fd)
            lock.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
