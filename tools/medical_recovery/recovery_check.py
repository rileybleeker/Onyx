"""Medical records recovery check: counts-only evidence that /health/records is intact and private.

Read-only. It never writes to the database or the bucket, never prints a title, note, test name,
value, id or storage path, and never sends anything to a model. It answers three questions from
docs/medical-records-recovery.md:

  1. Do the metadata relationships hold?  Every confirmed document (status 'ready', removed or not:
     removal is soft and keeps the file for Undo) has its file in the bucket with the size and type
     its row declares; every lab result's document_id resolves; no file sits outside documents/.
  2. Is it still private?  The bucket is private with the 25 MB cap and the type list; the anon key
     reaches neither table, lists no file and the public URL of a file is refused.
  3. Is there a recent database backup?  Supabase's Management API backup list (needs a personal
     access token in SUPABASE_ACCESS_TOKEN; the Supabase MCP has no backup tool). Storage files are
     NOT in those backups (Supabase docs), which is why the doc's off-site plan exists.

On a DRILL target only (a local Supabase stack on localhost / 127.0.0.1, or a throwaway hosted
project named with --drill-project, never the production project) it can also open every file
(download into memory, SHA-256, "does it parse as its declared type", and one file fetched through a
60-second signed link, the app's own viewing path) and write or compare a manifest of sizes and
hashes. On production those options are refused: real records are never downloaded by this tool.
A missing key, a refused read (401 / 403) or a read that keeps failing is reported as "incomplete"
with the exact access to ask for, never as a pass.

Usage (from the repo root):
  python tools/medical_recovery/recovery_check.py                    # production, read-only
  python tools/medical_recovery/recovery_check.py --write-synthetic DIR   # made-up drill files
  python tools/medical_recovery/recovery_check.py --skip-backups --url http://127.0.0.1:54321 \
      --open-files --manifest drill-manifest.json                    # the recovery drill
Keys: SUPABASE_SERVICE_ROLE_KEY or ~/.onyx_supabase_secret; SUPABASE_ANON_KEY (or
NEXT_PUBLIC_SUPABASE_ANON_KEY); SUPABASE_ACCESS_TOKEN for the backup list. Keys are never printed.
Exit status: 0 pass, 1 a check failed, 2 incomplete (something could not be checked).
Standard library only. Tests: tests/test_medical_recovery_check.py (synthetic, no network).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

BUCKET = "medical-records"
EXPECTED_LIMIT = 26214400
EXPECTED_TYPES = frozenset({
    "application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
})
PATH_RE = re.compile(r"^documents/[0-9a-f-]{36}$")
# Only ids, paths, sizes, types and states: no text column (title, provider, notes, test name,
# value, unit, range, lab) is ever requested.
DOC_SELECT = "id,storage_path,mime_type,size_bytes,status,removed_at"
LAB_SELECT = "id,document_id,removed_at"
TABLES = ("medical_documents", "lab_results")
PAGE = 1000
MAX_ROWS = 50_000
BACKUP_MAX_AGE_HOURS = 36
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
DEFAULT_URL = "https://fewweioupmsnbccqtxdl.supabase.co"
PRODUCTION_REF = "fewweioupmsnbccqtxdl"
DEFAULT_KEY_FILE = Path.home() / ".onyx_supabase_secret"
MANAGEMENT_API = "https://api.supabase.com"
MANIFEST_VERSION = 1

# What to ask for when a read is refused or a key is missing, per stage.
ACCESS_ASK = {
    "documents": "service-role key (SUPABASE_SERVICE_ROLE_KEY or ~/.onyx_supabase_secret) able to read pds.medical_documents",
    "labs": "service-role key able to read pds.lab_results",
    "bucket": "service-role key able to read the storage bucket settings of medical-records",
    "objects": "service-role key able to list the medical-records bucket",
    "anon": "the project's anon / publishable key in SUPABASE_ANON_KEY (public; it ships in the site's JS)",
    "backups": "a Supabase personal access token in SUPABASE_ACCESS_TOKEN (dashboard > Account > Access Tokens), "
               "or the dates on Dashboard > Database > Backups",
    "download": "service-role key able to download from the drill bucket",
    "signed": "service-role key able to sign a download link in the drill bucket",
}


class Unreadable(Exception):
    """A read that could not be completed. Carries the stage and an HTTP status or 'network' only."""

    def __init__(self, stage: str, reason: str, denied: bool = False) -> None:
        super().__init__(f"{stage}: {reason}")
        self.stage, self.reason, self.denied = stage, reason, denied


class TransportError(Exception):
    pass


# (method, url, headers, body, read_body) -> (status, body bytes)
Transport = Callable[[str, str, dict, Optional[bytes], bool], "tuple[int, bytes]"]


def urllib_transport(method: str, url: str, headers: dict, body: Optional[bytes], read_body: bool = True) -> tuple[int, bytes]:
    # A generic client name: some API front ends refuse urllib's default User-Agent.
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"User-Agent": "onyx-recovery-check/1", **headers})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, (resp.read() if read_body else b"")
    except urllib.error.HTTPError as e:
        try:
            data = e.read() if read_body else b""
        except OSError:
            data = b""
        return e.code, data
    except (urllib.error.URLError, OSError) as e:
        raise TransportError(type(getattr(e, "reason", e)).__name__) from None


def request(transport: Transport, stage: str, method: str, url: str, headers: dict,
            body: Optional[bytes] = None, *, read_body: bool = True, attempts: int = 3,
            sleep: Callable[[float], None] = time.sleep) -> tuple[int, bytes]:
    """One HTTP call with retries for network errors, 429 and 5xx (1 s, 2 s backoff). Answers the last
    status; raises Unreadable when every attempt hit a network error or a 5xx / 429."""
    last = "network"
    for attempt in range(1, attempts + 1):
        try:
            status, data = transport(method, url, headers, body, read_body)
        except TransportError:
            last = "network"
        else:
            if status != 429 and status < 500:
                return status, data
            last = f"HTTP {status}"
        if attempt < attempts:
            sleep(float(2 ** (attempt - 1)))
    raise Unreadable(stage, f"{last} after {attempts} attempts")


def _json(stage: str, data: bytes):
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Unreadable(stage, "answer was not JSON") from None


def _ok(stage: str, status: int) -> None:
    if status in (401, 403):
        raise Unreadable(stage, f"HTTP {status} (access refused)", denied=True)
    if not 200 <= status < 300:
        raise Unreadable(stage, f"HTTP {status}")


def is_local(url: str) -> bool:
    return (urllib.parse.urlsplit(url).hostname or "") in LOCAL_HOSTS


def project_ref(url: str) -> Optional[str]:
    host = urllib.parse.urlsplit(url).hostname or ""
    m = re.fullmatch(r"([a-z0-9]{20})\.supabase\.co", host)
    return m.group(1) if m else None


def drill_allowed(url: str, drill_project: Optional[str]) -> bool:
    """Files may be opened only on a local stack, or on a hosted project explicitly named as the drill
    target that is not the production project."""
    if is_local(url):
        return True
    ref = project_ref(url)
    return bool(ref and drill_project and ref == drill_project and ref != PRODUCTION_REF)


@dataclass
class Target:
    url: str
    service_key: str
    transport: Transport = urllib_transport
    sleep: Callable[[float], None] = time.sleep
    drill: bool = False  # True only on a drill target: enables download() and signed_fetch()

    def __post_init__(self) -> None:
        self.url = self.url.rstrip("/")
        if self.drill and not drill_allowed(self.url, project_ref(self.url)):
            raise PermissionError("the production project is never a drill target")

    def _h(self, key: Optional[str] = None, **extra: str) -> dict:
        k = self.service_key if key is None else key
        return {"apikey": k, "Authorization": f"Bearer {k}", **extra}

    def rows(self, stage: str, table: str, select: str) -> list[dict]:
        out: list[dict] = []
        while True:
            q = urllib.parse.urlencode({"select": select, "order": "id.asc", "limit": PAGE, "offset": len(out)})
            status, data = request(self.transport, stage, "GET", f"{self.url}/rest/v1/{table}?{q}",
                                   self._h(**{"Accept-Profile": "pds"}), sleep=self.sleep)
            _ok(stage, status)
            page = _json(stage, data)
            if not isinstance(page, list):
                raise Unreadable(stage, "answer was not a list")
            out.extend(page)
            if len(page) < PAGE:
                return out
            if len(out) >= MAX_ROWS:
                raise Unreadable(stage, f"more than {MAX_ROWS} rows")

    def bucket(self) -> dict:
        status, data = request(self.transport, "bucket", "GET", f"{self.url}/storage/v1/bucket/{BUCKET}",
                               self._h(), sleep=self.sleep)
        _ok("bucket", status)
        got = _json("bucket", data)
        if not isinstance(got, dict):
            raise Unreadable("bucket", "answer was not an object")
        return got

    def list_objects(self, prefix: str, key: Optional[str] = None, stage: str = "objects") -> list[dict]:
        out: list[dict] = []
        while True:
            body = json.dumps({"prefix": prefix, "limit": PAGE, "offset": len(out),
                               "sortBy": {"column": "name", "order": "asc"}}).encode("utf-8")
            status, data = request(self.transport, stage, "POST", f"{self.url}/storage/v1/object/list/{BUCKET}",
                                   self._h(key, **{"Content-Type": "application/json"}), body, sleep=self.sleep)
            _ok(stage, status)
            page = _json(stage, data)
            if not isinstance(page, list):
                raise Unreadable(stage, "answer was not a list")
            out.extend(page)
            if len(page) < PAGE:
                return out
            if len(out) >= MAX_ROWS:
                raise Unreadable(stage, f"more than {MAX_ROWS} files")

    def anon_reaches_table(self, anon_key: str, table: str) -> bool:
        status, _ = request(self.transport, "anon", "GET", f"{self.url}/rest/v1/{table}?select=id&limit=1",
                            self._h(anon_key, **{"Accept-Profile": "pds"}), read_body=False, sleep=self.sleep)
        return 200 <= status < 300

    def anon_list_count(self, anon_key: str) -> int:
        body = json.dumps({"prefix": "documents", "limit": 1, "offset": 0}).encode("utf-8")
        status, data = request(self.transport, "anon", "POST", f"{self.url}/storage/v1/object/list/{BUCKET}",
                               self._h(anon_key, **{"Content-Type": "application/json"}), body, sleep=self.sleep)
        if not 200 <= status < 300:
            return 0
        try:
            got = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return 0
        return len([o for o in got if isinstance(o, dict) and o.get("id")]) if isinstance(got, list) else 0

    def public_url_served(self, path: str) -> bool:
        quoted = urllib.parse.quote(path)
        status, _ = request(self.transport, "anon", "GET", f"{self.url}/storage/v1/object/public/{BUCKET}/{quoted}",
                            {}, read_body=False, sleep=self.sleep)
        return 200 <= status < 300

    def download(self, path: str) -> bytes:
        if not self.drill:
            raise PermissionError("files are opened on a drill target only")
        quoted = urllib.parse.quote(path)
        status, data = request(self.transport, "download", "GET", f"{self.url}/storage/v1/object/{BUCKET}/{quoted}",
                               self._h(), sleep=self.sleep)
        _ok("download", status)
        return data

    def signed_fetch(self, path: str) -> bytes:
        """The file through a 60-second signed link, fetched with no key: how /health/records serves it."""
        if not self.drill:
            raise PermissionError("files are opened on a drill target only")
        quoted = urllib.parse.quote(path)
        status, data = request(self.transport, "signed", "POST", f"{self.url}/storage/v1/object/sign/{BUCKET}/{quoted}",
                               self._h(**{"Content-Type": "application/json"}),
                               json.dumps({"expiresIn": 60}).encode("utf-8"), sleep=self.sleep)
        _ok("signed", status)
        link = _json("signed", data)
        rel = (link.get("signedURL") or link.get("signedUrl")) if isinstance(link, dict) else None
        if not rel:
            raise Unreadable("signed", "no signed link in the answer")
        full = rel if rel.startswith("http") else f"{self.url}/storage/v1{rel if rel.startswith('/') else '/' + rel}"
        status, body = request(self.transport, "signed", "GET", full, {}, sleep=self.sleep)
        _ok("signed", status)
        return body


# ---------------------------------------------------------------- file checks (pure)
def synthetic_files() -> dict[str, tuple[str, bytes]]:
    """Two made-up, valid files for the drill: a one-page PDF and a 1x1 PNG. No real content."""
    import struct
    import zlib

    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>"]
    pdf = bytearray(b"%PDF-1.4\n% SYNTHETIC RECOVERY DRILL DOCUMENT\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(pdf))
        pdf += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(pdf)
    pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    pdf += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(b"\x00\xff\x6a\x1a")) + chunk(b"IEND", b""))
    return {"synthetic-drill-document.pdf": ("application/pdf", bytes(pdf)),
            "synthetic-drill-image.png": ("image/png", png)}


_HEIF_BRANDS = {b"heic", b"heix", b"hevc", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1", b"heif"}


def opens_as(mime: str, data: bytes) -> bool:
    """Whether the bytes are a whole file of the declared type (header AND end marker where the format
    has one), so a truncated or swapped file is caught."""
    if not data:
        return False
    if mime == "application/pdf":
        return data.startswith(b"%PDF-") and b"%%EOF" in data[-1024:]
    if mime == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n") and b"IEND" in data[-16:]
    if mime == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff") and b"\xff\xd9" in data[-64:]
    if mime == "image/webp":
        return (len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"
                and int.from_bytes(data[4:8], "little") + 8 == len(data))
    if mime in ("image/heic", "image/heif"):
        return len(data) >= 12 and data[4:8] == b"ftyp" and data[8:12] in _HEIF_BRANDS
    return False


# ---------------------------------------------------------------- evaluation (pure)
@dataclass
class Inventory:
    documents: list[dict] = field(default_factory=list)   # DOC_SELECT columns
    labs: list[dict] = field(default_factory=list)        # LAB_SELECT columns
    objects: dict[str, dict] = field(default_factory=dict)  # "documents/<id>" -> {"size", "type"}
    unexpected_paths: int = 0                              # files or folders outside documents/<id>
    bucket: Optional[dict] = None
    anon: Optional[dict] = None       # {"tables_reached": n, "files_listed": n, "public_url_served": bool|None}
    opened: Optional[dict] = None     # path -> {"sha256": hex, "opens": bool} (drill target only)
    signed_ok: Optional[bool] = None  # one file fetched through a signed link matched its download
    manifest: Optional[dict] = None
    backups: Optional[dict] = None    # summarize_backups() output
    unreadable: list[dict] = field(default_factory=list)  # [{"stage", "reason", "ask"?}]


def _check(name: str, result: str, count: Optional[int] = None) -> dict:
    out = {"name": name, "result": result}
    if count is not None:
        out["count"] = count
    return out


def evaluate(inv: Inventory) -> dict:
    """The report: counts and pass / fail / warn / unknown per check. Never an id, path or text."""
    checks: list[dict] = []
    unread = {u["stage"] for u in inv.unreadable}

    def add(name: str, failures: int, *, warn: bool = False, stage: Optional[str] = None) -> None:
        if stage and stage in unread:
            checks.append(_check(name, "unknown"))
        else:
            checks.append(_check(name, ("warn" if warn else "fail") if failures else "pass", failures))

    # privacy
    if inv.bucket is None:
        checks += [_check(n, "unknown") for n in ("bucket_private", "bucket_size_limit", "bucket_types")]
    else:
        b = inv.bucket
        checks.append(_check("bucket_private", "pass" if b.get("public") is False else "fail"))
        checks.append(_check("bucket_size_limit", "pass" if b.get("file_size_limit") == EXPECTED_LIMIT else "fail"))
        types = b.get("allowed_mime_types")
        checks.append(_check("bucket_types", "pass" if isinstance(types, list) and set(types) == EXPECTED_TYPES else "fail"))
    if inv.anon is None:
        checks += [_check(n, "unknown") for n in ("anon_tables_refused", "anon_files_hidden", "public_url_refused")]
    else:
        add("anon_tables_refused", int(inv.anon.get("tables_reached", 0)))
        add("anon_files_hidden", int(inv.anon.get("files_listed", 0)))
        served = inv.anon.get("public_url_served")
        checks.append(_check("public_url_refused", "skip" if served is None else ("fail" if served else "pass")))

    # metadata relationships
    docs_ok = "documents" not in unread
    objs_ok = "objects" not in unread
    doc_ids = {d.get("id") for d in inv.documents}
    paths = {d.get("storage_path") for d in inv.documents}
    ready = [d for d in inv.documents if d.get("status") == "ready"]
    missing = size_bad = type_bad = 0
    for d in ready:
        obj = inv.objects.get(d.get("storage_path"))
        if obj is None:
            missing += 1
            continue
        if obj.get("size") != d.get("size_bytes"):
            size_bad += 1
        if obj.get("type") != d.get("mime_type"):
            type_bad += 1
    both = None if docs_ok and objs_ok else "documents" if not docs_ok else "objects"
    add("ready_documents_have_file", missing, stage=both)
    add("file_sizes_match", size_bad, stage=both)
    add("file_types_match", type_bad, stage=both)
    add("storage_paths_valid", sum(1 for d in inv.documents if not PATH_RE.match(str(d.get("storage_path") or ""))),
        stage="documents" if not docs_ok else None)
    labs_ok = "labs" not in unread
    dangling = sum(1 for r in inv.labs if r.get("document_id") and r.get("document_id") not in doc_ids)
    add("lab_links_resolve", dangling, stage=None if labs_ok and docs_ok else ("labs" if not labs_ok else "documents"))
    by_id = {d.get("id"): d for d in inv.documents}
    unready_links = sum(1 for r in inv.labs if r.get("removed_at") is None and r.get("document_id") in by_id
                        and (by_id[r["document_id"]].get("status") != "ready" or by_id[r["document_id"]].get("removed_at")))
    add("lab_links_live", unready_links, warn=True, stage=None if labs_ok and docs_ok else ("labs" if not labs_ok else "documents"))
    add("no_orphan_files", sum(1 for p in inv.objects if p not in paths), warn=True, stage=both)
    pending_with_file = sum(1 for d in inv.documents if d.get("status") == "pending" and d.get("storage_path") in inv.objects)
    add("uploads_confirmed", pending_with_file, warn=True, stage=both)
    add("no_unexpected_paths", inv.unexpected_paths, warn=True, stage="objects" if not objs_ok else None)

    # opened files (drill target only)
    if inv.opened is not None:
        add("files_open", sum(1 for v in inv.opened.values() if not v.get("opens")),
            stage="download" if "download" in unread else None)
        if "signed" in unread:
            checks.append(_check("signed_link_serves_file", "unknown"))
        elif inv.signed_ok is not None:
            checks.append(_check("signed_link_serves_file", "pass" if inv.signed_ok else "fail"))

    # manifest (a backup's, or the drill's seed)
    if inv.manifest is not None:
        m_objects = inv.manifest.get("objects") or {}
        add("manifest_files_present", sum(1 for p in m_objects if p not in inv.objects), stage=both)
        add("manifest_sizes_match", sum(1 for p, v in m_objects.items()
                                        if p in inv.objects and inv.objects[p].get("size") != v.get("size")), stage=both)
        if inv.opened is None:
            checks.append(_check("manifest_hashes_match", "skip"))
        else:
            add("manifest_hashes_match", sum(1 for p, v in m_objects.items()
                                             if p in inv.opened and inv.opened[p].get("sha256") != v.get("sha256")))
        add("manifest_document_rows", max(0, int(inv.manifest.get("documents", 0)) - len(inv.documents)),
            stage="documents" if not docs_ok else None)
        add("manifest_lab_rows", max(0, int(inv.manifest.get("labs", 0)) - len(inv.labs)),
            stage="labs" if not labs_ok else None)
        add("files_newer_than_manifest", sum(1 for p in inv.objects if p not in m_objects), warn=True, stage=both)

    # database backups
    bk = inv.backups or {"state": "unknown"}
    if bk.get("state") == "skipped":
        checks.append(_check("database_backup_recent", "skip"))
    elif bk.get("state") != "read":
        checks.append(_check("database_backup_recent", "unknown"))
    else:
        age = bk.get("newest_age_hours")
        checks.append(_check("database_backup_recent",
                             "pass" if age is not None and age <= BACKUP_MAX_AGE_HOURS else "fail"))

    results = {c["result"] for c in checks}
    status = "fail" if "fail" in results else "incomplete" if "unknown" in results or inv.unreadable else "pass"
    counts = {
        "documents": len(inv.documents),
        "documents_ready": len(ready),
        "documents_pending": sum(1 for d in inv.documents if d.get("status") == "pending"),
        "documents_removed": sum(1 for d in inv.documents if d.get("removed_at")),
        "lab_results": len(inv.labs),
        "lab_results_linked": sum(1 for r in inv.labs if r.get("document_id")),
        "files": len(inv.objects),
        "file_bytes": sum(int(o.get("size") or 0) for o in inv.objects.values()),
    }
    report = {"status": status, "counts": counts, "checks": checks}
    if inv.backups is not None:
        report["backups"] = dict(inv.backups)
    if inv.unreadable:
        report["incomplete"] = inv.unreadable
    return report


def _parse_time(v) -> Optional[datetime]:
    if isinstance(v, (int, float)) and v > 0:
        return datetime.fromtimestamp(float(v), tz=timezone.utc)
    if isinstance(v, str) and v:
        try:
            t = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    return None


def summarize_backups(answer, now: datetime) -> dict:
    """The Management API's backup list as dates and counts: PITR on / off, completed backups, the oldest
    and newest restore point and the newest one's age."""
    if not isinstance(answer, dict):
        return {"state": "unreadable"}
    completed = [b for b in answer.get("backups") or [] if isinstance(b, dict) and b.get("status") == "COMPLETED"]
    times = [t for t in (_parse_time(b.get("inserted_at")) for b in completed) if t]
    phys = answer.get("physical_backup_data") or {}
    for key in ("earliest_physical_backup_date_unix", "latest_physical_backup_date_unix"):
        t = _parse_time(phys.get(key)) if isinstance(phys, dict) else None
        if t:
            times.append(t)
    newest = max(times) if times else None
    oldest = min(times) if times else None
    return {
        "state": "read",
        "pitr_enabled": answer.get("pitr_enabled") if isinstance(answer.get("pitr_enabled"), bool) else None,
        "completed_backups": len(completed),
        "oldest": oldest.date().isoformat() if oldest else None,
        "newest": newest.isoformat(timespec="minutes") if newest else None,
        "newest_age_hours": round((now - newest).total_seconds() / 3600, 1) if newest else None,
    }


# ---------------------------------------------------------------- collection
def collect(target: Target, *, anon_key: Optional[str], access_token: Optional[str], skip_backups: bool,
            open_files: bool, manifest: Optional[dict], now: Optional[datetime] = None) -> Inventory:
    inv = Inventory(manifest=manifest)
    now = now or datetime.now(timezone.utc)

    def note(err: Unreadable) -> None:
        item = {"stage": err.stage, "reason": err.reason}
        if err.denied:
            item["ask"] = ACCESS_ASK.get(err.stage, "access to " + err.stage)
        inv.unreadable.append(item)

    try:
        inv.documents = target.rows("documents", "medical_documents", DOC_SELECT)
    except Unreadable as e:
        note(e)
    try:
        inv.labs = target.rows("labs", "lab_results", LAB_SELECT)
    except Unreadable as e:
        note(e)
    try:
        inv.bucket = target.bucket()
    except Unreadable as e:
        note(e)
    try:
        for item in target.list_objects(""):
            # the top level should hold only the documents/ folder (a folder entry has no id)
            if item.get("id") or item.get("name") != "documents":
                inv.unexpected_paths += 1
        for item in target.list_objects("documents"):
            if not item.get("id"):
                inv.unexpected_paths += 1  # a nested folder
                continue
            path = f"documents/{item.get('name')}"
            if not PATH_RE.match(path):
                inv.unexpected_paths += 1  # e.g. a placeholder file: never a document's path
                continue
            meta = item.get("metadata") or {}
            inv.objects[path] = {"size": meta.get("size"), "type": meta.get("mimetype")}
    except Unreadable as e:
        note(e)
        inv.objects = {}

    if anon_key:
        try:
            sample = next(iter(sorted(inv.objects)), None)
            inv.anon = {
                "tables_reached": sum(1 for t in TABLES if target.anon_reaches_table(anon_key, t)),
                "files_listed": target.anon_list_count(anon_key),
                "public_url_served": target.public_url_served(sample) if sample else None,
            }
        except Unreadable as e:
            note(e)
    else:
        inv.unreadable.append({"stage": "anon", "reason": "no anon key", "ask": ACCESS_ASK["anon"]})

    if open_files:
        inv.opened = {}
        types = {d.get("storage_path"): d.get("mime_type") for d in inv.documents}
        try:
            for path in sorted(inv.objects):
                data = target.download(path)
                inv.opened[path] = {"sha256": hashlib.sha256(data).hexdigest(),
                                    "opens": opens_as(str(types.get(path) or inv.objects[path].get("type")), data)}
        except Unreadable as e:
            note(e)
        if inv.opened:
            first = sorted(inv.opened)[0]
            try:
                inv.signed_ok = hashlib.sha256(target.signed_fetch(first)).hexdigest() == inv.opened[first]["sha256"]
            except Unreadable as e:
                note(e)

    if skip_backups:
        inv.backups = {"state": "skipped"}
    else:
        ref = project_ref(target.url)
        if not ref:
            inv.backups = {"state": "unknown"}
            inv.unreadable.append({"stage": "backups", "reason": "not a hosted Supabase project URL"})
        elif not access_token:
            inv.backups = {"state": "unknown"}
            inv.unreadable.append({"stage": "backups", "reason": "no access token", "ask": ACCESS_ASK["backups"]})
        else:
            try:
                status, data = request(target.transport, "backups", "GET",
                                       f"{MANAGEMENT_API}/v1/projects/{ref}/database/backups",
                                       {"Authorization": f"Bearer {access_token}"}, sleep=target.sleep)
                _ok("backups", status)
                inv.backups = summarize_backups(_json("backups", data), now)
                if inv.backups.get("state") != "read":
                    inv.unreadable.append({"stage": "backups", "reason": "answer was not a backup list"})
            except Unreadable as e:
                inv.backups = {"state": "unknown"}
                note(e)
    return inv


def build_manifest(inv: Inventory, now: datetime) -> dict:
    """Sizes and hashes of every file plus the row counts: what a backup (or the drill's seed) holds."""
    if inv.opened is None:
        raise ValueError("a manifest needs the files opened (local drill target only)")
    return {
        "version": MANIFEST_VERSION,
        "created_at": now.isoformat(timespec="seconds"),
        "documents": len(inv.documents),
        "labs": len(inv.labs),
        "objects": {p: {"size": inv.objects[p].get("size"), "sha256": inv.opened[p]["sha256"]}
                    for p in sorted(inv.opened)},
    }


def load_manifest(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("version") != MANIFEST_VERSION or not isinstance(data.get("objects"), dict):
        raise ValueError("not a version-1 recovery manifest")
    return data


def format_report(report: dict) -> str:
    lines = [f"medical records recovery check: {report['status'].upper()}"]
    lines.append("counts: " + ", ".join(f"{k} {v}" for k, v in report["counts"].items()))
    for c in report["checks"]:
        lines.append(f"  {c['result']:<8} {c['name']}" + (f" ({c['count']})" if c.get("count") else ""))
    bk = report.get("backups")
    if bk and bk.get("state") == "read":
        lines.append(f"backups: PITR {bk.get('pitr_enabled')}, {bk.get('completed_backups')} completed, "
                     f"oldest {bk.get('oldest')}, newest {bk.get('newest')} ({bk.get('newest_age_hours')} h ago)")
    for u in report.get("incomplete", []):
        lines.append(f"incomplete: {u['stage']}: {u['reason']}" + (f"; ask for: {u['ask']}" if u.get("ask") else ""))
    return "\n".join(lines)


def _read_key(env_names: tuple[str, ...], key_file: Optional[Path]) -> Optional[str]:
    for name in env_names:
        if os.environ.get(name):
            return os.environ[name].strip()
    if key_file and key_file.is_file():
        return key_file.read_text(encoding="utf-8").strip() or None
    return None


def main(argv: Optional[list[str]] = None, transport: Transport = urllib_transport,
         sleep: Callable[[float], None] = time.sleep, out=None) -> int:
    out = out or sys.stdout
    ap = argparse.ArgumentParser(description="Counts-only, read-only recovery check of /health/records.")
    ap.add_argument("--url", default=os.environ.get("SUPABASE_URL") or DEFAULT_URL)
    ap.add_argument("--key-file", type=Path, default=DEFAULT_KEY_FILE, help="service-role key file")
    ap.add_argument("--skip-backups", action="store_true", help="do not read the backup list (drill target)")
    ap.add_argument("--open-files", action="store_true", help="download and open every file (drill target only)")
    ap.add_argument("--manifest", type=Path, help="compare with this manifest (sizes, hashes, row counts)")
    ap.add_argument("--write-manifest", type=Path, help="write the manifest of this target (drill target only)")
    ap.add_argument("--drill-project", help="ref of a throwaway hosted project used as the drill target")
    ap.add_argument("--write-synthetic", type=Path, help="write the two made-up drill files to this folder and stop")
    ap.add_argument("--json", action="store_true", help="print the report as JSON")
    args = ap.parse_args(argv)

    if args.write_synthetic:
        files = synthetic_files()
        args.write_synthetic.mkdir(parents=True, exist_ok=True)
        for name, (_mime, data) in files.items():
            (args.write_synthetic / name).write_bytes(data)
        print(f"wrote {len(files)} synthetic drill files", file=out)
        return 0
    drill = bool(args.open_files or args.write_manifest)
    if drill and not drill_allowed(args.url, args.drill_project):
        print("refused: --open-files and --write-manifest run on a drill target only (a local stack, or a "
              "throwaway project named with --drill-project); real records are never downloaded by this check",
              file=out)
        return 2
    key = _read_key(("SUPABASE_SERVICE_ROLE_KEY",), args.key_file)
    if not key:
        print(f"incomplete: no service-role key; ask for: {ACCESS_ASK['documents']}", file=out)
        return 2
    manifest = None
    if args.manifest:
        try:
            manifest = load_manifest(args.manifest)
        except (OSError, ValueError) as e:
            print(f"incomplete: manifest could not be read ({type(e).__name__})", file=out)
            return 2
    now = datetime.now(timezone.utc)
    target = Target(args.url, key, transport=transport, sleep=sleep, drill=drill)
    inv = collect(target, anon_key=_read_key(("SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"), None),
                  access_token=os.environ.get("SUPABASE_ACCESS_TOKEN") or None, skip_backups=args.skip_backups,
                  open_files=bool(args.open_files or args.write_manifest), manifest=manifest, now=now)
    report = evaluate(inv)
    if args.write_manifest:
        if any(u["stage"] in ("documents", "labs", "objects", "download") for u in inv.unreadable):
            print("refused: the manifest would be incomplete", file=out)
            return 2
        args.write_manifest.write_text(json.dumps(build_manifest(inv, now), indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2) if args.json else format_report(report), file=out)
    return {"pass": 0, "fail": 1}.get(report["status"], 2)


if __name__ == "__main__":
    sys.exit(main())
