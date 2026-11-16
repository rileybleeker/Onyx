"""Medical records recovery check: counts-only evidence that /health/records is intact and private.

Read-only. It never writes to the database or the bucket, never prints a title, note, test name,
value, id or storage path, and never sends anything to a model. It answers three questions from
docs/medical-records-recovery.md:

  1. Do the metadata relationships hold?  Every confirmed document (status 'ready', removed or not:
     removal is soft and keeps the file for Undo) has its file in the bucket listing with the size and
     type its row declares; every lab result's document_id resolves; no file sits outside documents/.
     The listing (and a HEAD request) read the storage.objects ROW only, which comes back with a
     database restore even when the bytes did not, so the bytes themselves are proven only by opening
     the files on a drill target (below). On production that check is reported as unknown, never as
     a pass: this tool does not download real records.
  2. Is it still private?  The bucket is private with the 25 MB cap and the type list; the anon key
     and a signed-in user's token each reach neither table, list no file and cannot reach one file
     directly (a HEAD request: the same row-level check a download makes, no bytes sent), and the
     public URL of a file is refused (HEAD as well). A refusal counts only after the key itself was
     accepted: a table refusal must be PostgREST's permission answer (42501 or PGRST106), a listing
     must answer a list (or "bucket not found"); a stale or invalid key is "incomplete", never a pass.
  3. Is there a recent database backup?  Supabase's Management API backup list (needs a personal
     access token in SUPABASE_ACCESS_TOKEN; the Supabase MCP has no backup tool). Storage files are
     NOT in those backups (Supabase docs), which is why the doc's off-site plan exists.

On a DRILL target only (a local Supabase stack on localhost / 127.0.0.1, or a throwaway hosted
project named with --drill-project, never the production project) it can also open every file
(download into memory: are the bytes served at their declared size, SHA-256, "does it parse as its
declared type", and one file fetched through a 60-second signed link, the app's own viewing path) and
write or compare a manifest of every file's size and hash, every document's path / size / type /
state and every lab result's document link.
On production those options are refused: real records are never downloaded by this tool.
A missing key, a refused read (401 / 403) or a read that keeps failing is reported as "incomplete"
with the exact access to ask for, never as a pass.

Usage (from the repo root):
  python tools/medical_recovery/recovery_check.py                    # production, read-only
  python tools/medical_recovery/recovery_check.py --write-synthetic DIR   # made-up drill files
  python tools/medical_recovery/recovery_check.py --skip-backups --url http://127.0.0.1:54321 \
      --open-files --manifest drill-manifest.json                    # the recovery drill
Keys: SUPABASE_SERVICE_ROLE_KEY or ~/.onyx_supabase_secret (production only: a drill target reads
the environment variable or an explicit --key-file, never the production key file); SUPABASE_ANON_KEY
(or NEXT_PUBLIC_SUPABASE_ANON_KEY); SUPABASE_USER_ACCESS_TOKEN (a signed-in user's short-lived access
token) for the signed-in-user probe; SUPABASE_ACCESS_TOKEN (a personal access token: account-wide
admin, so set it for one shell only and revoke it after the run) for the backup list. Keys are never
printed.
Exit status: 0 pass, 1 a check failed, 2 incomplete (something could not be checked).
Standard library only. Tests: tests/test_medical_recovery_check.py (synthetic, no network).
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
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
# PostgREST's answers that mean "this role may not read it" (permission denied; schema not exposed
# to the request). Anything else (an invalid JWT, a missing table, a gateway error) proves nothing.
REFUSAL_CODES = frozenset({"42501", "PGRST106"})

# What to ask for when a read is refused or a key is missing, per stage.
ACCESS_ASK = {
    "documents": "service-role key (SUPABASE_SERVICE_ROLE_KEY or ~/.onyx_supabase_secret) able to read pds.medical_documents",
    "labs": "service-role key able to read pds.lab_results",
    "bucket": "service-role key able to read the storage bucket settings of medical-records",
    "objects": "service-role key able to list the medical-records bucket",
    "anon": "the project's current anon / publishable key in SUPABASE_ANON_KEY (public; it ships in the site's JS)",
    "authenticated": "a signed-in user's access token in SUPABASE_USER_ACCESS_TOKEN (it expires within an hour; "
                     "on production Riley's own sign-in, on the drill stack a made-up user's), with the anon key set",
    "backups": "the dates on Dashboard > Database > Backups, or a Supabase personal access token in "
               "SUPABASE_ACCESS_TOKEN for this one shell (dashboard > Account > Access Tokens; it is account-wide "
               "admin: shortest expiry, never a saved environment variable, revoke it after the run)",
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


# (method, url, headers, body, read_body) -> (status, body bytes[, response headers lower-cased])
Transport = Callable[[str, str, dict, Optional[bytes], bool], tuple]


def urllib_transport(method: str, url: str, headers: dict, body: Optional[bytes],
                     read_body: bool = True) -> tuple[int, bytes, dict]:
    # A generic client name: some API front ends refuse urllib's default User-Agent.
    try:
        req = urllib.request.Request(url, data=body, method=method,
                                     headers={"User-Agent": "onyx-recovery-check/1", **headers})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read() if read_body and method != "HEAD" else b""
            return resp.status, data, {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as e:
        try:
            data = e.read() if read_body and method != "HEAD" else b""
        except (OSError, http.client.HTTPException):
            data = b""
        return e.code, data, {k.lower(): v for k, v in (e.headers or {}).items()}
    except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError) as e:
        # a refused connection, a truncated or dropped answer, a malformed URL: never a traceback
        raise TransportError(type(getattr(e, "reason", e)).__name__) from None


def request(transport: Transport, stage: str, method: str, url: str, headers: dict,
            body: Optional[bytes] = None, *, read_body: bool = True, attempts: int = 3,
            sleep: Callable[[float], None] = time.sleep) -> tuple:
    """One HTTP call with retries for network errors, 429 and 5xx (1 s, 2 s backoff). Answers the last
    (status, body); raises Unreadable when every attempt hit a network error or a 5xx / 429."""
    last = "network"
    for attempt in range(1, attempts + 1):
        try:
            answer = transport(method, url, headers, body, read_body)
        except TransportError:
            last = "network"
        else:
            status, data = answer[0], answer[1]
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


def _error_body(data: bytes) -> dict:
    try:
        got = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def _said(data: bytes) -> str:
    err = _error_body(data)
    return " ".join(str(err.get(k) or "") for k in ("statusCode", "error", "message")).lower()


def _not_found(status: int, data: bytes) -> bool:
    """Storage's answer for an object (or bucket) it does not hold: HTTP 404, or HTTP 400 carrying
    statusCode 404 / not_found. A credential error is also HTTP 400 (statusCode 403), so it never
    matches."""
    if status == 404:
        return True
    err = _error_body(data)
    return status == 400 and (str(err.get("statusCode")) == "404" or "not found" in _said(data)
                              or str(err.get("error") or "").lower() in ("not_found", "nosuchkey"))


def norm_type(value) -> str:
    """A content type the way the app's complete route compares it: no parameters, lower case."""
    return str(value or "").split(";")[0].strip().lower()


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

    def list_objects(self, prefix: str) -> list[dict]:
        out: list[dict] = []
        while True:
            body = json.dumps({"prefix": prefix, "limit": PAGE, "offset": len(out),
                               "sortBy": {"column": "name", "order": "asc"}}).encode("utf-8")
            status, data = request(self.transport, "objects", "POST", f"{self.url}/storage/v1/object/list/{BUCKET}",
                                   self._h(**{"Content-Type": "application/json"}), body, sleep=self.sleep)
            _ok("objects", status)
            page = _json("objects", data)
            if not isinstance(page, list):
                raise Unreadable("objects", "answer was not a list")
            out.extend(page)
            if len(page) < PAGE:
                return out
            if len(out) >= MAX_ROWS:
                raise Unreadable("objects", f"more than {MAX_ROWS} files")

    # -- role probes: what the anon key, or a signed-in user's token, can reach
    def key_accepted(self, stage: str, apikey: str, bearer: str, check_path: str) -> None:
        """A positive control before any refusal is believed: the key (or the user's token) must be
        accepted by a read that every valid key may make. A stale, rotated or disabled key is refused
        here, so its later refusals are never counted as privacy."""
        status, _ = request(self.transport, stage, "GET", f"{self.url}{check_path}",
                            {"apikey": apikey, "Authorization": f"Bearer {bearer}"}, read_body=False,
                            sleep=self.sleep)
        if not 200 <= status < 300:
            raise Unreadable(stage, f"HTTP {status} from the key check (the key was not accepted)",
                             denied=status in (401, 403))

    def role_reaches_table(self, stage: str, apikey: str, bearer: str, table: str) -> bool:
        status, data = request(self.transport, stage, "GET", f"{self.url}/rest/v1/{table}?select=id&limit=1",
                               {"apikey": apikey, "Authorization": f"Bearer {bearer}", "Accept-Profile": "pds"},
                               sleep=self.sleep)
        if 200 <= status < 300:
            return True
        if status in (401, 403, 404, 406) and str(_error_body(data).get("code")) in REFUSAL_CODES:
            return False
        raise Unreadable(stage, f"table probe answered HTTP {status} without a permission refusal")

    def role_list_count(self, stage: str, apikey: str, bearer: str) -> int:
        body = json.dumps({"prefix": "documents", "limit": 1, "offset": 0}).encode("utf-8")
        status, data = request(self.transport, stage, "POST", f"{self.url}/storage/v1/object/list/{BUCKET}",
                               {"apikey": apikey, "Authorization": f"Bearer {bearer}",
                                "Content-Type": "application/json"}, body, sleep=self.sleep)
        if 200 <= status < 300:
            got = _json(stage, data)
            if not isinstance(got, list):
                raise Unreadable(stage, "file listing answer was not a list")
            return len([o for o in got if isinstance(o, dict) and o.get("id")])
        if status in (400, 404) and "bucket not found" in _said(data):
            return 0  # the bucket itself is hidden from this role (answered after the credential was accepted)
        # Without a storage policy a role's listing answers 200 []: any other answer (a credential error
        # such as "Invalid Compact JWS", a gateway error) proves nothing about privacy.
        raise Unreadable(stage, f"file listing answered HTTP {status} without a listing")

    def role_file_served(self, stage: str, apikey: str, bearer: str, path: str) -> bool:
        """Whether this role reaches one file directly: a HEAD request on the download route runs the
        same row-level check a download makes, and sends no bytes. Asked only after the role's own
        listing answered (proof that Storage accepted the credential), so a refusal here is the access
        decision, not a credential problem. Listing and download are separate permissions in Storage, so
        an empty listing alone does not prove a file is out of reach."""
        quoted = urllib.parse.quote(path)
        status, _ = request(self.transport, stage, "HEAD", f"{self.url}/storage/v1/object/{BUCKET}/{quoted}",
                            {"apikey": apikey, "Authorization": f"Bearer {bearer}"}, read_body=False,
                            sleep=self.sleep)
        if 200 <= status < 300:
            return True
        if status in (400, 401, 403, 404):
            return False
        raise Unreadable(stage, f"file probe answered HTTP {status}")

    def public_url_served(self, path: str) -> bool:
        # HEAD: even if the bucket were ever made public, no bytes of a real record are sent
        quoted = urllib.parse.quote(path)
        status, _ = request(self.transport, "anon", "HEAD", f"{self.url}/storage/v1/object/public/{BUCKET}/{quoted}",
                            {}, read_body=False, sleep=self.sleep)
        if 200 <= status < 300:
            return True
        if status in (400, 401, 403, 404):
            return False
        raise Unreadable("anon", f"public URL probe answered HTTP {status}")

    def download(self, path: str) -> Optional[bytes]:
        """The file's bytes (drill target only), or None when Storage does not serve them: a not-found
        answer (the hosted S3 backend), or a 5xx that persisted through the retries (the local file
        backend answers 500 for a row whose file is gone). A refused read, any other answer or a
        network failure raises Unreadable."""
        if not self.drill:
            raise PermissionError("files are opened on a drill target only")
        quoted = urllib.parse.quote(path)
        try:
            status, data = request(self.transport, "download", "GET",
                                   f"{self.url}/storage/v1/object/{BUCKET}/{quoted}", self._h(), sleep=self.sleep)
        except Unreadable as e:
            if e.reason.startswith("HTTP 5"):
                return None
            raise
        if _not_found(status, data):
            return None
        _ok("download", status)  # a refusal (401 / 403) or any other non-2xx answer raises
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
_PDF_OBJ = re.compile(rb"(\d+)\s+(\d+)\s+obj")
_PDF_SUB = re.compile(rb"\s*(\d+)\s+(\d+)[ \t]*\r?\n?")
_PDF_ENTRY = re.compile(rb"(\d{10}) (\d{5}) ([nf])[ \r\n]{1,2}")
_PDF_TRAILER = re.compile(rb"\s*trailer\s*<<(.*?)>>", re.S)
_PDF_TAIL = re.compile(rb"startxref\s+(\d+)\s+%%EOF\s*$")
_PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _pdf_ok(data: bytes) -> bool:
    """Header, a startxref that points at a cross-reference table (or stream), every in-use table entry
    pointing at its own "N 0 obj", and a trailer with /Root. A structural parse, not a rendering."""
    if not data.startswith(b"%PDF-"):
        return False
    at = data.rfind(b"startxref", max(0, len(data) - 1024))
    tail = _PDF_TAIL.match(data, at) if at >= 0 else None
    if not tail or int(tail.group(1)) >= at:
        return False
    off = int(tail.group(1))
    if not data.startswith(b"xref", off):  # PDF 1.5+: a cross-reference stream object
        return bool(_PDF_OBJ.match(data, off)) and b"/XRef" in data[off:off + 2048]
    pos, entries = off + 4, 0
    while True:
        sub = _PDF_SUB.match(data, pos)
        if not sub:
            break
        first, count = int(sub.group(1)), int(sub.group(2))
        pos = sub.end()
        for k in range(count):
            e = _PDF_ENTRY.match(data, pos)
            entries += 1
            if not e or entries > 1_000_000:
                return False
            pos = e.end()
            if e.group(3) == b"n":
                obj = _PDF_OBJ.match(data, int(e.group(1)))
                if not obj or int(obj.group(1)) != first + k:
                    return False
    trailer = _PDF_TRAILER.match(data, pos)
    return bool(entries and trailer and trailer.end() <= at and b"/Root" in trailer.group(1))


def _png_ok(data: bytes) -> bool:
    """Every chunk's length and CRC, IHDR first and IEND last, and the pixel data inflating to exactly
    the size the header declares."""
    if not data.startswith(_PNG_SIG):
        return False
    pos, ihdr, idat, ended = 8, None, bytearray(), False
    while pos + 12 <= len(data):
        n = int.from_bytes(data[pos:pos + 4], "big")
        kind, end = data[pos + 4:pos + 8], pos + 12 + n
        if end > len(data):
            return False
        body = data[pos + 8:pos + 8 + n]
        if zlib.crc32(kind + body) & 0xFFFFFFFF != int.from_bytes(data[end - 4:end], "big"):
            return False
        if ihdr is None and kind != b"IHDR":
            return False
        if kind == b"IHDR":
            if n != 13:
                return False
            ihdr = body
        elif kind == b"IDAT":
            idat += body
        pos = end
        if kind == b"IEND":
            ended = True
            break
    if not ended or pos != len(data) or ihdr is None or not idat:
        return False
    width, height = int.from_bytes(ihdr[0:4], "big"), int.from_bytes(ihdr[4:8], "big")
    depth, channels, interlace = ihdr[8], {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(ihdr[9]), ihdr[12]
    if not channels or not width or not height or depth not in (1, 2, 4, 8, 16):
        return False
    expected = height * (1 + (width * channels * depth + 7) // 8)
    cap = expected + 1 if interlace == 0 else 2 * expected + 64
    if cap > 512 * 1024 * 1024:
        return False
    inflate = zlib.decompressobj()
    try:
        raw = inflate.decompress(bytes(idat), cap)
    except zlib.error:
        return False
    return inflate.eof and (len(raw) == expected if interlace == 0 else len(raw) > 0)


def _jpeg_ok(data: bytes) -> bool:
    """The marker segments from start-of-image to start-of-scan (each with a sane length, a frame
    header before the scan), then an end-of-image marker at the end."""
    if not data.startswith(b"\xff\xd8"):
        return False
    pos, frame = 2, False
    while pos + 4 <= len(data):
        if data[pos] != 0xFF:
            return False
        marker = data[pos + 1]
        if marker == 0xFF:  # fill byte
            pos += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:  # markers without a length
            pos += 2
            continue
        if marker in (0xD8, 0xD9):  # a second start, or the end before any scan
            return False
        size = int.from_bytes(data[pos + 2:pos + 4], "big")
        if size < 2 or pos + 2 + size > len(data):
            return False
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            frame = True
        if marker == 0xDA:  # start of scan: entropy-coded data runs to the end-of-image marker
            rest = data[pos + 2 + size:]
            return frame and b"\xff\xd9" in rest[-64:]
        pos += 2 + size
    return False


def _webp_ok(data: bytes) -> bool:
    """The RIFF size, then every chunk inside it (padded to even), the first being an image chunk."""
    if len(data) < 20 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return False
    if int.from_bytes(data[4:8], "little") + 8 != len(data):
        return False
    pos, first = 12, True
    while pos < len(data):
        if pos + 8 > len(data):
            return False
        kind, size = data[pos:pos + 4], int.from_bytes(data[pos + 4:pos + 8], "little")
        if pos + 8 + size > len(data):
            return False
        if first:
            if kind not in (b"VP8 ", b"VP8L", b"VP8X"):
                return False
            if kind == b"VP8 " and data[pos + 11:pos + 14] != b"\x9d\x01\x2a":
                return False
            if kind == b"VP8L" and (size < 1 or data[pos + 8] != 0x2F):
                return False
            first = False
        pos += 8 + size + (size & 1)
    return not first and pos == len(data)


def _heif_ok(data: bytes) -> bool:
    """Top-level boxes that add up to the file exactly: ftyp first with a HEIF brand, and a meta box."""
    pos, brands, meta = 0, set(), False
    while pos < len(data):
        if pos + 8 > len(data):
            return False
        size, kind, head = int.from_bytes(data[pos:pos + 4], "big"), data[pos + 4:pos + 8], 8
        if size == 1:
            if pos + 16 > len(data):
                return False
            size, head = int.from_bytes(data[pos + 8:pos + 16], "big"), 16
        elif size == 0:
            size = len(data) - pos
        if size < head or pos + size > len(data):
            return False
        if pos == 0:
            body = data[pos + head:pos + size]
            if kind != b"ftyp" or len(body) < 8:
                return False
            brands = {body[0:4]} | {body[i:i + 4] for i in range(8, len(body) - 3, 4)}
        elif kind == b"meta":
            meta = True
        pos += size
    return bool(brands & _HEIF_BRANDS) and meta


def opens_as(mime: str, data: bytes) -> bool:
    """Whether the bytes parse as a whole file of the declared type: the format's structure from start
    to end (PDF cross-reference table, PNG chunks and pixel data, JPEG segments, WebP chunks, HEIF
    boxes), so a truncated, swapped or merely look-alike file is caught. Not a rendering: the drill
    adds a human opening one restored file (docs/medical-records-recovery.md, section 6)."""
    if not data:
        return False
    checker = {"application/pdf": _pdf_ok, "image/png": _png_ok, "image/jpeg": _jpeg_ok,
               "image/webp": _webp_ok, "image/heic": _heif_ok, "image/heif": _heif_ok}.get(mime)
    return bool(checker and checker(data))


# ---------------------------------------------------------------- evaluation (pure)
@dataclass
class Inventory:
    documents: list[dict] = field(default_factory=list)   # DOC_SELECT columns
    labs: list[dict] = field(default_factory=list)        # LAB_SELECT columns
    objects: dict[str, dict] = field(default_factory=dict)  # "documents/<id>" -> {"size", "type"}
    unexpected_paths: int = 0                              # files or folders outside documents/<id>
    bucket: Optional[dict] = None
    # {"tables_reached": n, "files_listed": n, "file_served": bool|None, "public_url_served": bool|None}
    anon: Optional[dict] = None
    authenticated: Optional[dict] = None  # {"tables_reached", "files_listed", "file_served"} for a signed-in user
    # drill target only: path -> {"served": False} or {"served": True, "size", "sha256", "opens"}, for every
    # listed file and every ready document's path
    opened: Optional[dict] = None
    signed_ok: Optional[bool] = None  # one file fetched through a signed link matched its download
    manifest: Optional[dict] = None
    backups: Optional[dict] = None    # summarize_backups() output
    unreadable: list[dict] = field(default_factory=list)  # [{"stage", "reason", "ask"?}]


def _check(name: str, result: str, count: Optional[int] = None) -> dict:
    out = {"name": name, "result": result}
    if count is not None:
        out["count"] = count
    return out


def doc_state(d: dict) -> dict:
    """What a restore must bring back for one document row (no text column)."""
    return {"storage_path": d.get("storage_path"), "size_bytes": d.get("size_bytes"), "mime_type": d.get("mime_type"),
            "status": d.get("status"), "removed": bool(d.get("removed_at"))}


def lab_state(r: dict) -> dict:
    """What a restore must bring back for one lab result row: its document link and removal."""
    return {"document_id": r.get("document_id") or None, "removed": bool(r.get("removed_at"))}


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

    def refused(name: str, served) -> None:
        checks.append(_check(name, "skip" if served is None else ("fail" if served else "pass")))

    if inv.anon is None:
        checks += [_check(n, "unknown") for n in ("anon_tables_refused", "anon_files_hidden", "anon_file_refused",
                                                   "public_url_refused")]
    else:
        add("anon_tables_refused", int(inv.anon.get("tables_reached", 0)))
        add("anon_files_hidden", int(inv.anon.get("files_listed", 0)))
        refused("anon_file_refused", inv.anon.get("file_served"))
        refused("public_url_refused", inv.anon.get("public_url_served"))
    if inv.authenticated is None:
        checks += [_check(n, "unknown") for n in ("authenticated_tables_refused", "authenticated_files_hidden",
                                                   "authenticated_file_refused")]
    else:
        add("authenticated_tables_refused", int(inv.authenticated.get("tables_reached", 0)))
        add("authenticated_files_hidden", int(inv.authenticated.get("files_listed", 0)))
        refused("authenticated_file_refused", inv.authenticated.get("file_served"))

    # metadata relationships
    docs_ok = "documents" not in unread
    objs_ok = "objects" not in unread
    labs_ok = "labs" not in unread
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
        if norm_type(obj.get("type")) != norm_type(d.get("mime_type")):
            type_bad += 1
    both = None if docs_ok and objs_ok else "documents" if not docs_ok else "objects"
    add("ready_documents_have_file", missing, stage=both)
    add("file_sizes_match", size_bad, stage=both)
    add("file_types_match", type_bad, stage=both)
    # the bytes themselves: the listing (and a HEAD request) read the storage.objects row, which comes back
    # with a database restore while the bytes may not; only a download proves them (drill target only)
    if inv.opened is None or not docs_ok or "download" in unread:
        checks += [_check(n, "unknown") for n in ("files_stored", "stored_sizes_match")]
    else:
        declared = {d.get("storage_path"): d.get("size_bytes") for d in ready
                    if PATH_RE.match(str(d.get("storage_path") or ""))}
        served = {p: inv.opened[p] for p in declared if (inv.opened.get(p) or {}).get("served")}
        add("files_stored", len(declared) - len(served))
        add("stored_sizes_match", sum(1 for p, v in served.items() if v.get("size") != declared[p]))
    add("storage_paths_valid", sum(1 for d in inv.documents if not PATH_RE.match(str(d.get("storage_path") or ""))),
        stage="documents" if not docs_ok else None)
    link_stage = None if labs_ok and docs_ok else ("labs" if not labs_ok else "documents")
    dangling = sum(1 for r in inv.labs if r.get("document_id") and r.get("document_id") not in doc_ids)
    add("lab_links_resolve", dangling, stage=link_stage)
    by_id = {d.get("id"): d for d in inv.documents}
    unready_links = sum(1 for r in inv.labs if r.get("removed_at") is None and r.get("document_id") in by_id
                        and (by_id[r["document_id"]].get("status") != "ready" or by_id[r["document_id"]].get("removed_at")))
    add("lab_links_live", unready_links, warn=True, stage=link_stage)
    add("no_orphan_files", sum(1 for p in inv.objects if p not in paths), warn=True, stage=both)
    pending_with_file = sum(1 for d in inv.documents if d.get("status") == "pending" and d.get("storage_path") in inv.objects)
    add("uploads_confirmed", pending_with_file, warn=True, stage=both)
    add("no_unexpected_paths", inv.unexpected_paths, warn=True, stage="objects" if not objs_ok else None)

    # opened files (drill target only)
    if inv.opened is not None:
        add("files_open", sum(1 for v in inv.opened.values() if v.get("served") and not v.get("opens")),
            stage="download" if "download" in unread else None)
        if "signed" in unread:
            checks.append(_check("signed_link_serves_file", "unknown"))
        elif inv.signed_ok is not None:
            checks.append(_check("signed_link_serves_file", "pass" if inv.signed_ok else "fail"))

    # manifest (a backup's, or the drill's seed): files, and every row's identity, state and link
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
        m_docs = inv.manifest.get("document_rows") or {}
        m_labs = inv.manifest.get("lab_rows") or {}
        labs_by_id = {r.get("id"): r for r in inv.labs}
        doc_stage = "documents" if not docs_ok else None
        add("manifest_document_rows", sum(1 for i in m_docs if i not in by_id), stage=doc_stage)
        add("manifest_document_state_match", sum(1 for i, s in m_docs.items()
                                                 if i in by_id and doc_state(by_id[i]) != s), stage=doc_stage)
        add("manifest_lab_rows", sum(1 for i in m_labs if i not in labs_by_id), stage="labs" if not labs_ok else None)
        add("manifest_lab_links_match", sum(1 for i, s in m_labs.items()
                                            if i in labs_by_id and lab_state(labs_by_id[i]) != s), stage=link_stage)
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
    pitr = answer.get("pitr_enabled") if isinstance(answer.get("pitr_enabled"), bool) else None
    # The point-in-time range counts only when PITR is on (it then replaces the daily backups); otherwise
    # freshness comes from COMPLETED daily backups alone, so a fresh WAL point cannot hide failed backups.
    phys = answer.get("physical_backup_data") or {}
    for key in ("earliest_physical_backup_date_unix", "latest_physical_backup_date_unix"):
        t = _parse_time(phys.get(key)) if pitr is True and isinstance(phys, dict) else None
        if t:
            times.append(t)
    newest = max(times) if times else None
    oldest = min(times) if times else None
    return {
        "state": "read",
        "pitr_enabled": pitr,
        "completed_backups": len(completed),
        "oldest": oldest.date().isoformat() if oldest else None,
        "newest": newest.isoformat(timespec="minutes") if newest else None,
        "newest_age_hours": round((now - newest).total_seconds() / 3600, 1) if newest else None,
    }


# ---------------------------------------------------------------- collection
def _probe_role(target: Target, stage: str, apikey: str, bearer: str, check_path: str,
                sample: Optional[str]) -> dict:
    target.key_accepted(stage, apikey, bearer, check_path)
    out = {"tables_reached": sum(1 for t in TABLES if target.role_reaches_table(stage, apikey, bearer, t)),
           "files_listed": target.role_list_count(stage, apikey, bearer)}
    # after the listing answered (the credential is accepted): can the role reach one file directly?
    out["file_served"] = target.role_file_served(stage, apikey, bearer, sample) if sample else None
    return out


def collect(target: Target, *, anon_key: Optional[str], access_token: Optional[str], skip_backups: bool,
            open_files: bool, manifest: Optional[dict], now: Optional[datetime] = None,
            user_token: Optional[str] = None) -> Inventory:
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

    sample = next(iter(sorted(inv.objects)), None)
    if anon_key:
        try:
            anon = _probe_role(target, "anon", anon_key, anon_key, "/auth/v1/settings", sample)
            anon["public_url_served"] = target.public_url_served(sample) if sample else None
            inv.anon = anon
        except Unreadable as e:
            note(e)
    else:
        inv.unreadable.append({"stage": "anon", "reason": "no anon key", "ask": ACCESS_ASK["anon"]})
    if not user_token:
        inv.unreadable.append({"stage": "authenticated", "reason": "no signed-in user token",
                               "ask": ACCESS_ASK["authenticated"]})
    elif not anon_key:
        inv.unreadable.append({"stage": "authenticated", "reason": "the anon key is needed as the apikey",
                               "ask": ACCESS_ASK["anon"]})
    else:
        try:
            inv.authenticated = _probe_role(target, "authenticated", anon_key, user_token, "/auth/v1/user", sample)
        except Unreadable as e:
            note(e)

    if open_files:
        inv.opened = {}
        types = {d.get("storage_path"): d.get("mime_type") for d in inv.documents}
        # every listed file, and every ready document's path even when the listing lost it
        ready_paths = {d.get("storage_path") for d in inv.documents if d.get("status") == "ready"
                       and PATH_RE.match(str(d.get("storage_path") or ""))}
        try:
            for path in sorted(set(inv.objects) | ready_paths):
                data = target.download(path)
                if data is None:
                    inv.opened[path] = {"served": False}
                    continue
                mime = norm_type(types.get(path) or (inv.objects.get(path) or {}).get("type"))
                inv.opened[path] = {"served": True, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                                    "opens": opens_as(mime, data)}
        except Unreadable as e:
            note(e)
        first = next((p for p in sorted(inv.opened) if inv.opened[p].get("served")), None)
        if first:
            try:
                inv.signed_ok = hashlib.sha256(target.signed_fetch(first)).hexdigest() == inv.opened[first]["sha256"]
            except Unreadable as e:
                note(e)
    else:
        inv.unreadable.append({"stage": "bytes", "reason": "file bytes are not checked without opening the files: "
                               "the listing and HEAD read the database row only, and files are opened on a "
                               "drill target only (--open-files), never on production"})

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
    """What a backup (or the drill's seed) holds: every file's size and hash, every document's path /
    size / type / state, every lab result's document link and removal, and the row counts. It holds
    ids, so it is kept privately (drill folder, or encrypted with the off-site copy), never in the repo."""
    if inv.opened is None:
        raise ValueError("a manifest needs the files opened (local drill target only)")
    return {
        "version": MANIFEST_VERSION,
        "created_at": now.isoformat(timespec="seconds"),
        "documents": len(inv.documents),
        "labs": len(inv.labs),
        "lab_results_linked": sum(1 for r in inv.labs if r.get("document_id")),
        "objects": {p: {"size": inv.objects[p].get("size"), "sha256": inv.opened[p]["sha256"]}
                    for p in sorted(inv.opened) if p in inv.objects and inv.opened[p].get("served")},
        "document_rows": {d.get("id"): doc_state(d) for d in inv.documents},
        "lab_rows": {r.get("id"): lab_state(r) for r in inv.labs},
    }


def load_manifest(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(data, dict) or data.get("version") != MANIFEST_VERSION
            or not all(isinstance(data.get(k), dict) for k in ("objects", "document_rows", "lab_rows"))):
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


def _same_file(a: Path, b: Path) -> bool:
    try:
        return a.expanduser().resolve() == b.expanduser().resolve()
    except OSError:
        return True  # cannot tell: treat it as the production key file


def main(argv: Optional[list[str]] = None, transport: Transport = urllib_transport,
         sleep: Callable[[float], None] = time.sleep, out=None) -> int:
    out = out or sys.stdout
    ap = argparse.ArgumentParser(description="Counts-only, read-only recovery check of /health/records.")
    ap.add_argument("--url", default=os.environ.get("SUPABASE_URL") or DEFAULT_URL)
    ap.add_argument("--key-file", type=Path,
                    help="service-role key file (default ~/.onyx_supabase_secret, on production only)")
    ap.add_argument("--skip-backups", action="store_true", help="do not read the backup list (drill target only)")
    ap.add_argument("--open-files", action="store_true", help="download and open every file (drill target only)")
    ap.add_argument("--manifest", type=Path, help="compare with this manifest (files, row states, lab links)")
    ap.add_argument("--write-manifest", type=Path,
                    help="write the manifest of this target (drill target only, and only after a PASS)")
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
    if args.skip_backups and not drill_allowed(args.url, args.drill_project):
        print("refused: --skip-backups is for a drill target only; on production the backup list is part of the "
              f"check (without SUPABASE_ACCESS_TOKEN it is reported as incomplete; ask for: {ACCESS_ASK['backups']})",
              file=out)
        return 2
    on_drill = drill_allowed(args.url, args.drill_project)
    if on_drill:
        # The default key file holds the PRODUCTION key; a drill target (whose logs may record headers) only
        # ever gets SUPABASE_SERVICE_ROLE_KEY or a key file named explicitly that is not that file.
        key_file = args.key_file if args.key_file and not _same_file(args.key_file, DEFAULT_KEY_FILE) else None
    else:
        key_file = args.key_file or DEFAULT_KEY_FILE
    key = _read_key(("SUPABASE_SERVICE_ROLE_KEY",), key_file)
    if not key:
        if on_drill:
            print("incomplete: set the drill stack's service key in SUPABASE_SERVICE_ROLE_KEY (the production key "
                  "file is never read for a drill target)", file=out)
        else:
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
                  open_files=drill, manifest=manifest, now=now,
                  user_token=os.environ.get("SUPABASE_USER_ACCESS_TOKEN") or None)
    report = evaluate(inv)
    print(json.dumps(report, indent=2) if args.json else format_report(report), file=out)
    code = {"pass": 0, "fail": 1}.get(report["status"], 2)
    if args.write_manifest:
        if report["status"] != "pass":
            # a broken or partly read state must never become the reference a restore is judged against
            print(f"refused: the baseline is {report['status']}, not PASS; no manifest written", file=out)
            return code
        args.write_manifest.write_text(json.dumps(build_manifest(inv, now), indent=2), encoding="utf-8")
    return code


if __name__ == "__main__":
    sys.exit(main())
