"""Medical records recovery check: counts-only evidence that /health/records is intact and private.

Read-only. It never writes to the database or the bucket, never prints a title, note, test name,
value, id or storage path, and never sends anything to a model. It answers three questions from
docs/medical-records-recovery.md:

  1. Do the metadata relationships hold?  Every confirmed document (status 'ready', removed or not:
     removal is soft and keeps the file for Undo) has its file in the bucket listing with the size and
     type its row declares; every lab result's document_id resolves; no file sits outside documents/.
     The listing (and a HEAD request) read the storage.objects ROW only, which comes back with a
     database restore even when the bytes did not, so the bytes themselves are proven only by
     downloading the files on a drill target (below). On production that check is reported as unknown,
     never as a pass: this tool does not download real records.
  2. Is it still private?  The bucket is private with the 25 MB cap and the type list; the anon key
     and a signed-in user's token each reach neither table, list no file and cannot reach one file
     directly, and the public URL of a file is refused. A refusal counts only after the key itself was
     accepted: a table refusal must be PostgREST's permission answer (42501 or PGRST106), a listing
     must answer a list of well-formed entries (or "bucket not found"); a stale or invalid key or a
     malformed listing is "incomplete", never a pass. Storage checks a download (GET) and a HEAD / info
     request as separate operations, so the direct-file probes are a real GET on a drill target (made-up
     files) and a HEAD on production (no byte of a real record is sent): there a HEAD that succeeds is a
     FAIL, and a refused HEAD leaves the download refusal unknown, never a pass. Each probe stands on
     its own: a reach one probe saw (a table, a listed entry, a served file) is a FAIL even when a later
     probe could not be read, and the same holds for a downloaded drill file that is missing, the wrong
     size or does not parse.
  3. Is there a recent database backup?  Supabase's Management API backup list (needs a personal
     access token in SUPABASE_ACCESS_TOKEN; the Supabase MCP has no backup tool). Storage files are
     NOT in those backups (Supabase docs), which is why the doc's off-site plan exists.

Where requests go: the target is decided from the exact origin before any key is read. Production is
exactly https://<PRODUCTION_REF>.supabase.co (one constant, with no flag or variable to change it: a move
to a new project changes it in a reviewed commit first); a drill target is a local Supabase stack (localhost /
127.0.0.1 / ::1) or a throwaway hosted project named with --drill-project, never production. Any other
URL is refused with nothing read or sent. Every request is checked against that one origin before it
is sent (the personal access token against the Management API's), redirects are never followed (a 3xx
is unreadable), no proxy from the environment is used, and a signed download link is fetched only when
it is the target's own signed route for that very file.

On a DRILL target only it can also download every file into memory (are the bytes served at their
declared size, SHA-256, does each parse as its declared type, and one file fetched through a 60-second
signed link, the app's own viewing path) and write or compare a manifest of every file's size and
hash, every document's path / size / type / state and every lab result's state (document link,
removal, value, unit, reference range and collection date). The parse is
structural (no decoder renders a page), so "a restored file opens" is reported as not checked: a
person opens one in a viewer during the drill. On production those options are refused: real records
are never downloaded by this tool. A manifest is compared only once manifest_problem() accepts it (the
shape build_manifest() writes, counts that match its rows, every ready document's file listed, every lab
link inside it, not empty): the comparisons walk its entries, so an emptied or cut-short manifest would
otherwise let an empty restore PASS. One that is refused is never compared and never written.
A missing key, a refused read (401 / 403) or a read that keeps failing is reported as "incomplete"
with the exact access to ask for, never as a pass.

Usage (from the repo root):
  python tools/medical_recovery/recovery_check.py                    # production, read-only
  python tools/medical_recovery/recovery_check.py --write-synthetic DIR   # made-up drill files
  python tools/medical_recovery/recovery_check.py --skip-backups --url http://127.0.0.1:54321 \
      --open-files --manifest drill-manifest.json                    # the recovery drill
Keys on production: SUPABASE_SERVICE_ROLE_KEY or ~/.onyx_supabase_secret; SUPABASE_ANON_KEY (or
NEXT_PUBLIC_SUPABASE_ANON_KEY); SUPABASE_USER_ACCESS_TOKEN (a signed-in user's short-lived access token)
for the signed-in-user probe. Keys on a drill target, its own names only (a shell may hold the
production ones): RECOVERY_DRILL_SERVICE_KEY or an explicit --key-file that is not the production key
file; RECOVERY_DRILL_ANON_KEY; RECOVERY_DRILL_USER_TOKEN; a drill key or token whose JWT names the
production project is refused. SUPABASE_ACCESS_TOKEN (a personal access token: account-wide admin, so
set it for one shell only and revoke it after the run) for the backup list. Keys are never printed.
Exit status: 0 pass, 1 a check failed, 2 incomplete (something could not be checked) or refused.
Standard library only. Tests: tests/test_medical_recovery_check.py (synthetic, no network).
"""
from __future__ import annotations

import argparse
import base64
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
ID_RE = re.compile(r"^[0-9a-f-]{36}$")  # a row id (UUID), the same shape as the id in a storage path
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# Only ids, paths, sizes, types and states: no text column (title, provider, notes, test name,
# value, unit, range, lab) is ever requested. Production (the "no text column" rule) reads a lab
# result's identity, document link and removal only; a drill target adds the value / unit / range /
# date columns a restore must preserve.
DOC_SELECT = "id,storage_path,mime_type,size_bytes,status,removed_at"
LAB_SELECT = "id,document_id,removed_at"
LAB_SELECT_DRILL = ("id,document_id,removed_at,value_num,value_text,unit,"
                    "ref_low,ref_high,ref_text,ref_low_strict,ref_high_strict,collected_on")
TABLES = ("medical_documents", "lab_results")
PAGE = 1000
MAX_ROWS = 50_000
BACKUP_MAX_AGE_HOURS = 36
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
# The production project: the one constant to change, in a reviewed commit, if production ever moves to a
# new project (docs/medical-records-recovery.md section 5). There is deliberately no flag or variable for it:
# it decides which origin may receive the production keys and on which project files are never downloaded.
PRODUCTION_REF = "fewweioupmsnbccqtxdl"
DEFAULT_URL = f"https://{PRODUCTION_REF}.supabase.co"
DEFAULT_KEY_FILE = Path.home() / ".onyx_supabase_secret"
MANAGEMENT_API = "https://api.supabase.com"
# (scheme, host, port): the only origin that may receive the production keys, and the only origin the
# personal access token is ever sent to
PRODUCTION_ORIGIN = ("https", f"{PRODUCTION_REF}.supabase.co", 443)
MANAGEMENT_ORIGIN = ("https", "api.supabase.com", 443)
# A drill target's credentials have their own names, so a shell that holds the production keys (from
# .env, say) never sends them to a drill stack or a throwaway project.
DRILL_ENV = {"service": "RECOVERY_DRILL_SERVICE_KEY", "anon": "RECOVERY_DRILL_ANON_KEY",
             "user": "RECOVERY_DRILL_USER_TOKEN"}
MANIFEST_VERSION = 1
# The fields build_manifest() writes, at the top level and per row: a manifest with any other shape is
# refused before it is compared with anything (manifest_problem()).
MANIFEST_KEYS = frozenset({"version", "created_at", "documents", "labs", "lab_results_linked", "objects",
                           "document_rows", "lab_rows"})
DOC_STATE_KEYS = frozenset({"storage_path", "size_bytes", "mime_type", "status", "removed"})
# The fields build_manifest() writes per lab row: the document link, removal and the value / unit /
# reference-range state a restore must preserve. Free-text name / note columns (test_name, lab, notes)
# are deliberately not part of it.
LAB_STATE_KEYS = frozenset({"document_id", "removed",
                            "value_num", "value_text", "unit",
                            "ref_low", "ref_high", "ref_text",
                            "ref_low_strict", "ref_high_strict", "collected_on"})
# The lab-state fields grouped under one count each in the drill comparison: (fields, check name,
# always_fetched). document link and removal are in LAB_SELECT (production too); the value / unit /
# range / date fields need LAB_SELECT_DRILL, so on a production read they are unknown, never a pass.
LAB_STATE_GROUPS = (
    (("document_id",), "manifest_lab_links_match", True),
    (("removed",), "manifest_lab_removed_match", True),
    (("value_num", "value_text"), "manifest_lab_values_match", False),
    (("unit",), "manifest_lab_units_match", False),
    (("ref_low", "ref_high", "ref_text", "ref_low_strict", "ref_high_strict"),
     "manifest_lab_ranges_match", False),
    (("collected_on",), "manifest_lab_collected_match", False),
)
LAB_STATE_CHECK_NAMES = tuple(n for _, n, _ in LAB_STATE_GROUPS)
# PostgREST's answers that mean "this role may not read it" (permission denied; schema not exposed
# to the request). Anything else (an invalid JWT, a missing table, a gateway error) proves nothing.
REFUSAL_CODES = frozenset({"42501", "PGRST106"})

# What a PASS of this tool does not cover. Its file check parses structure (no decoder renders a page),
# so "a restored file opens" stays a person's observation in the drill (section 6 step 10).
NOT_CHECKED = {"name": "file_opened_in_viewer", "result": "unknown",
               "how": "a person opens one restored drill file in a viewer and notes it in the private receipt "
                      "(docs/medical-records-recovery.md, section 6 step 10); files_parse_as_declared_type is "
                      "a structural parse, not an opening"}

# What to ask for when a read is refused or a key is missing, per stage.
ACCESS_ASK = {
    "documents": "service-role key (SUPABASE_SERVICE_ROLE_KEY or ~/.onyx_supabase_secret) able to read pds.medical_documents",
    "labs": "service-role key able to read pds.lab_results",
    "bucket": "service-role key able to read the storage bucket settings of medical-records",
    "objects": "service-role key able to list the medical-records bucket",
    "anon": "the project's current anon / publishable key in SUPABASE_ANON_KEY (public; it ships in the site's JS; "
            "on a drill target the drill stack's in RECOVERY_DRILL_ANON_KEY)",
    "authenticated": "a signed-in user's access token in SUPABASE_USER_ACCESS_TOKEN (it expires within an hour; "
                     "on production Riley's own sign-in; on a drill target a made-up user's, in "
                     "RECOVERY_DRILL_USER_TOKEN), with the anon key set",
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


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: the 3xx comes back as the answer (an HTTPError), so a key or a token is
    never sent on to wherever a server points. request() then reports it as unreadable."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - urllib's signature
        return None


def _build_opener() -> urllib.request.OpenerDirector:
    """No redirects and no proxy from the environment: every header goes to the origin it was checked
    against. (Passing a subclass of the default redirect handler replaces it.)"""
    return urllib.request.build_opener(_NoRedirect, urllib.request.ProxyHandler({}))


_OPENER = _build_opener()


def urllib_transport(method: str, url: str, headers: dict, body: Optional[bytes],
                     read_body: bool = True) -> tuple[int, bytes, dict]:
    # A generic client name: some API front ends refuse urllib's default User-Agent.
    try:
        req = urllib.request.Request(url, data=body, method=method,
                                     headers={"User-Agent": "onyx-recovery-check/1", **headers})
        with _OPENER.open(req, timeout=60) as resp:
            data = resp.read() if read_body and method != "HEAD" else b""
            return resp.status, data, {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as e:
        try:
            data = e.read() if read_body and method != "HEAD" else b""
        except (OSError, http.client.HTTPException, ValueError):  # a closed or truncated error body
            data = b""
        return e.code, data, {k.lower(): v for k, v in (e.headers or {}).items()}
    except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError) as e:
        # a refused connection, a truncated or dropped answer, a malformed URL: never a traceback
        raise TransportError(type(getattr(e, "reason", e)).__name__) from None


def origin_of(url: str) -> Optional[tuple[str, str, int]]:
    """(scheme, host, port) of a plain http(s) URL, or None for anything else: another scheme, no host,
    a user name or password in it, a malformed port."""
    try:
        p = urllib.parse.urlsplit(url)
        port = p.port
    except ValueError:
        return None
    if p.scheme not in ("http", "https") or not p.hostname or p.username is not None or p.password is not None:
        return None
    return p.scheme, p.hostname.lower(), port or (443 if p.scheme == "https" else 80)


def base_url(origin: tuple[str, str, int]) -> str:
    scheme, host, port = origin
    netloc = f"[{host}]" if ":" in host else host
    if port != (443 if scheme == "https" else 80):
        netloc += f":{port}"
    return f"{scheme}://{netloc}"


def classify(url: str, drill_project: Optional[str]) -> Optional[str]:
    """'production' for exactly the production origin, 'drill' for a local stack or the hosted project
    named with --drill-project (never production), None for anything else. Judged on the whole URL as
    given: it must be the bare origin (no path, query or fragment), so nothing a parser could read two
    ways reaches a credential."""
    origin = origin_of(url)
    if origin is None or str(url).rstrip("/").lower() != base_url(origin).lower():
        return None
    scheme, host, port = origin
    if origin == PRODUCTION_ORIGIN:
        return "production"
    if host in LOCAL_HOSTS:
        return "drill"
    m = re.fullmatch(r"([a-z0-9]{20})\.supabase\.co", host)
    if (m and scheme == "https" and port == 443 and drill_project and m.group(1) == drill_project.strip().lower()
            and m.group(1) != PRODUCTION_REF):
        return "drill"
    return None


def request(transport: Transport, stage: str, method: str, url: str, headers: dict,
            body: Optional[bytes] = None, *, origin: tuple[str, str, int], read_body: bool = True,
            attempts: int = 3, sleep: Callable[[float], None] = time.sleep) -> tuple:
    """One HTTP call with retries for network errors, 429 and 5xx (1 s, 2 s backoff). Answers the last
    (status, body); raises Unreadable when every attempt hit a network error or a 5xx / 429. `origin` is
    the only origin this call may go to (checked before anything is sent), and a redirect is never
    followed and never an answer: a 3xx is unreadable."""
    if origin_of(url) != origin:
        raise Unreadable(stage, "refused: a request to another origin (nothing was sent)")
    last = "network"
    for attempt in range(1, attempts + 1):
        try:
            answer = transport(method, url, headers, body, read_body)
        except TransportError:
            last = "network"
        else:
            status, data = answer[0], answer[1]
            if 300 <= status < 400:
                raise Unreadable(stage, f"HTTP {status} redirect, not followed")
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


def project_ref(url: str) -> Optional[str]:
    origin = origin_of(url)
    m = re.fullmatch(r"([a-z0-9]{20})\.supabase\.co", origin[1]) if origin else None
    return m.group(1) if m else None


def drill_allowed(url: str, drill_project: Optional[str]) -> bool:
    """Files may be opened only on a local stack, or on a hosted project explicitly named as the drill
    target that is not the production project."""
    return classify(url, drill_project) == "drill"


def _listing(stage: str, got) -> list[dict]:
    """A Storage listing, every entry checked: a file (a non-empty string id, metadata an object or
    absent) or a folder (id null). Anything else (null, a string, a nameless entry) makes the listing
    unreadable: it is never filtered down to an empty, "private" listing."""
    if not isinstance(got, list):
        raise Unreadable(stage, "answer was not a list")
    for o in got:
        if not (isinstance(o, dict) and isinstance(o.get("name"), str) and o["name"]
                and (o.get("id") is None or (isinstance(o.get("id"), str) and o["id"]))
                and (o.get("metadata") is None or isinstance(o.get("metadata"), dict))):
            raise Unreadable(stage, "a listing entry was neither a file nor a folder")
    return got


@dataclass
class Target:
    url: str
    service_key: str
    transport: Transport = urllib_transport
    sleep: Callable[[float], None] = time.sleep
    # True only on a drill target: enables download(), signed_fetch() and the GET file probes
    drill: bool = False

    def __post_init__(self) -> None:
        origin = origin_of(self.url)
        if origin is None:
            raise ValueError("not an http(s) origin")
        if self.drill and (origin == PRODUCTION_ORIGIN or not drill_allowed(base_url(origin), project_ref(self.url))):
            raise PermissionError("a drill target is a local stack or a named project that is not production")
        # every request this target makes goes to exactly this origin (request() checks it)
        self.origin, self.url = origin, base_url(origin)

    def _get(self, stage: str, method: str, url: str, headers: dict, body: Optional[bytes] = None,
             read_body: bool = True) -> tuple:
        return request(self.transport, stage, method, url, headers, body, origin=self.origin,
                       read_body=read_body, sleep=self.sleep)

    def _h(self, key: Optional[str] = None, **extra: str) -> dict:
        k = self.service_key if key is None else key
        return {"apikey": k, "Authorization": f"Bearer {k}", **extra}

    def rows(self, stage: str, table: str, select: str) -> list[dict]:
        out: list[dict] = []
        while True:
            q = urllib.parse.urlencode({"select": select, "order": "id.asc", "limit": PAGE, "offset": len(out)})
            status, data = self._get(stage, "GET", f"{self.url}/rest/v1/{table}?{q}",
                                     self._h(**{"Accept-Profile": "pds"}))
            _ok(stage, status)
            page = _json(stage, data)
            if not isinstance(page, list):
                raise Unreadable(stage, "answer was not a list")
            if not all(isinstance(r, dict) for r in page):
                raise Unreadable(stage, "a row was not an object")
            out.extend(page)
            if len(page) < PAGE:
                return out
            if len(out) >= MAX_ROWS:
                raise Unreadable(stage, f"more than {MAX_ROWS} rows")

    def bucket(self) -> dict:
        status, data = self._get("bucket", "GET", f"{self.url}/storage/v1/bucket/{BUCKET}", self._h())
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
            status, data = self._get("objects", "POST", f"{self.url}/storage/v1/object/list/{BUCKET}",
                                     self._h(**{"Content-Type": "application/json"}), body)
            _ok("objects", status)
            page = _listing("objects", _json("objects", data))
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
        status, _ = self._get(stage, "GET", f"{self.url}{check_path}",
                              {"apikey": apikey, "Authorization": f"Bearer {bearer}"}, read_body=False)
        if not 200 <= status < 300:
            raise Unreadable(stage, f"HTTP {status} from the key check (the key was not accepted)",
                             denied=status in (401, 403))

    def role_reaches_table(self, stage: str, apikey: str, bearer: str, table: str) -> bool:
        status, data = self._get(stage, "GET", f"{self.url}/rest/v1/{table}?select=id&limit=1",
                                 {"apikey": apikey, "Authorization": f"Bearer {bearer}", "Accept-Profile": "pds"})
        if 200 <= status < 300:
            return True
        if status in (401, 403, 404, 406) and str(_error_body(data).get("code")) in REFUSAL_CODES:
            return False
        raise Unreadable(stage, f"table probe answered HTTP {status} without a permission refusal")

    def role_list_count(self, stage: str, apikey: str, bearer: str) -> int:
        """How many entries (files or folders) the role's listing shows: any entry at all means the role
        sees what is in the bucket."""
        body = json.dumps({"prefix": "documents", "limit": 1, "offset": 0}).encode("utf-8")
        status, data = self._get(stage, "POST", f"{self.url}/storage/v1/object/list/{BUCKET}",
                                 {"apikey": apikey, "Authorization": f"Bearer {bearer}",
                                  "Content-Type": "application/json"}, body)
        if 200 <= status < 300:
            return len(_listing(stage, _json(stage, data)))
        if status in (400, 404) and "bucket not found" in _said(data):
            return 0  # the bucket itself is hidden from this role (answered after the credential was accepted)
        # Without a storage policy a role's listing answers 200 []: any other answer (a credential error
        # such as "Invalid Compact JWS", a gateway error) proves nothing about privacy.
        raise Unreadable(stage, f"file listing answered HTTP {status} without a listing")

    @property
    def file_probe(self) -> str:
        """How a role's reach to one file is probed. On a drill target: a real GET of a made-up file,
        because Storage checks a download (GET) and a HEAD / info request as separate operations, so only
        a refused GET proves a download is refused. On production: a HEAD, so no byte of a real record is
        ever sent; a HEAD that succeeds proves the file is reachable, a refused HEAD proves nothing about
        GET (reported as unknown)."""
        return "get" if self.drill else "head"

    def _file_reached(self, stage: str, url: str, headers: dict, what: str) -> bool:
        if self.drill:
            status, data = self._get(stage, "GET", url, headers)
            if 200 <= status < 300:
                return True
            # Storage hides an object the role may not read ("not found"); 401 / 403 refuse it outright.
            # Any other answer (another 400) proves nothing about the download.
            if status in (401, 403) or _not_found(status, data):
                return False
            raise Unreadable(stage, f"{what} answered HTTP {status} without a refusal")
        status, _ = self._get(stage, "HEAD", url, headers, read_body=False)
        if 200 <= status < 300:
            return True
        if status in (400, 401, 403, 404):
            return False  # a refused HEAD: evaluate() reports the download refusal as unknown
        raise Unreadable(stage, f"{what} answered HTTP {status}")

    def role_file_served(self, stage: str, apikey: str, bearer: str, path: str) -> bool:
        """Whether this role reaches one file directly on the download route (see file_probe). Asked only
        after the role's own listing answered (proof that Storage accepted the credential), so a refusal
        here is the access decision, not a credential problem. Listing and download are separate
        permissions in Storage, so an empty listing alone does not prove a file is out of reach."""
        quoted = urllib.parse.quote(path)
        return self._file_reached(stage, f"{self.url}/storage/v1/object/{BUCKET}/{quoted}",
                                  {"apikey": apikey, "Authorization": f"Bearer {bearer}"}, "file probe")

    def public_url_served(self, path: str) -> bool:
        """Whether the file's public URL serves it (see file_probe: GET on a drill target, HEAD on
        production)."""
        quoted = urllib.parse.quote(path)
        return self._file_reached("anon", f"{self.url}/storage/v1/object/public/{BUCKET}/{quoted}", {},
                                  "public URL probe")

    def download(self, path: str) -> Optional[bytes]:
        """The file's bytes (drill target only), or None when Storage does not serve them: a not-found
        answer (the hosted S3 backend), or a 5xx that persisted through the retries (the local file
        backend answers 500 for a row whose file is gone). A refused read, a redirect, any other answer
        or a network failure raises Unreadable."""
        if not self.drill:
            raise PermissionError("files are opened on a drill target only")
        quoted = urllib.parse.quote(path)
        try:
            status, data = self._get("download", "GET", f"{self.url}/storage/v1/object/{BUCKET}/{quoted}", self._h())
        except Unreadable as e:
            if e.reason.startswith("HTTP 5"):
                return None
            raise
        if _not_found(status, data):
            return None
        _ok("download", status)  # a refusal (401 / 403) or any other non-2xx answer raises
        return data

    def signed_link(self, path: str, link) -> str:
        """The URL a signed link answer points at, accepted only when it is this target's own signed
        download route for this very file: Storage's relative form (/object/sign/<bucket>/<path>?token=)
        or the same as an absolute URL on this origin. Anything else (another host, a protocol-relative
        //host, another path) is refused before it is fetched."""
        if not isinstance(link, str) or not link:
            raise Unreadable("signed", "no signed link in the answer")
        if link.startswith("/object/sign/"):
            full = f"{self.url}/storage/v1{link}"
        elif link.startswith("/"):
            raise Unreadable("signed", "the signed link is not a signed download route")
        else:
            full = link
        parts = urllib.parse.urlsplit(full)
        if (origin_of(full) != self.origin or parts.username is not None
                or urllib.parse.unquote(parts.path) != f"/storage/v1/object/sign/{BUCKET}/{path}" or not parts.query):
            raise Unreadable("signed", "the signed link points somewhere else (not fetched)")
        return full

    def signed_fetch(self, path: str) -> bytes:
        """The file through a 60-second signed link, fetched with no key: how /health/records serves it."""
        if not self.drill:
            raise PermissionError("files are opened on a drill target only")
        quoted = urllib.parse.quote(path)
        status, data = self._get("signed", "POST", f"{self.url}/storage/v1/object/sign/{BUCKET}/{quoted}",
                                 self._h(**{"Content-Type": "application/json"}),
                                 json.dumps({"expiresIn": 60}).encode("utf-8"))
        _ok("signed", status)
        link = _json("signed", data)
        full = self.signed_link(path, (link.get("signedURL") or link.get("signedUrl")) if isinstance(link, dict) else None)
        status, body = self._get("signed", "GET", full, {})
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


def parses_as(mime: str, data: bytes) -> bool:
    """Whether the bytes parse as a whole file of the declared type: the format's structure from start
    to end (PDF cross-reference table, PNG chunks and pixel data, JPEG segments, WebP chunks, HEIF
    boxes), so a truncated, swapped or merely look-alike file is caught. A structural parse, NOT an
    opening: a JPEG's scan data, for one, is never decoded. That a restored file opens is a separate
    observation (a person opens one in a viewer, docs/medical-records-recovery.md section 6 step 10),
    which this tool reports as not checked."""
    if not data:
        return False
    checker = {"application/pdf": _pdf_ok, "image/png": _png_ok, "image/jpeg": _jpeg_ok,
               "image/webp": _webp_ok, "image/heic": _heif_ok, "image/heif": _heif_ok}.get(mime)
    return bool(checker and checker(data))


# ---------------------------------------------------------------- evaluation (pure)
@dataclass
class Inventory:
    documents: list[dict] = field(default_factory=list)   # DOC_SELECT columns
    labs: list[dict] = field(default_factory=list)        # LAB_SELECT (production) / LAB_SELECT_DRILL (drill)
    objects: dict[str, dict] = field(default_factory=dict)  # "documents/<id>" -> {"size", "type"}
    unexpected_paths: int = 0                              # files or folders outside documents/<id>
    bucket: Optional[dict] = None
    # {"tables_reached": n, "files_listed": n|None, "file_served": bool|None (None: no file to probe),
    #  "public_url_served": bool|None, "file_probe": "get" (drill: a refusal proves a download is refused) |
    #  "head" (production: it does not), "unknown": [fields not established: "tables", "files_listed",
    #  "file_served", "public_url_served"]}. A reach in a field stands even when another field is unknown.
    anon: Optional[dict] = None
    # the same without "public_url_served", for a signed-in user
    authenticated: Optional[dict] = None
    # drill target only: path -> {"served": False} or {"served": True, "size", "sha256", "parses"}, for every
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
    """What a restore must bring back for one lab result row: its document link, removal, value (number
    or text), unit, reference range with its strict flags, and collection date. Free-text name and note
    columns (test_name, lab, notes) are not compared."""
    return {"document_id": r.get("document_id") or None,
            "removed": bool(r.get("removed_at")),
            "value_num": r.get("value_num"),
            "value_text": r.get("value_text") or "",
            "unit": r.get("unit") or "",
            "ref_low": r.get("ref_low"),
            "ref_high": r.get("ref_high"),
            "ref_text": r.get("ref_text") or "",
            "ref_low_strict": bool(r.get("ref_low_strict")),
            "ref_high_strict": bool(r.get("ref_high_strict")),
            "collected_on": r.get("collected_on")}


def evaluate(inv: Inventory) -> dict:
    """The report: counts and pass / fail / warn / unknown per check. Never an id, path or text."""
    checks: list[dict] = []
    unread = {u["stage"] for u in inv.unreadable}

    def add(name: str, failures: int, *, warn: bool = False, stage: Optional[str] = None) -> None:
        # for counts worked out from a read that may be missing (an empty list would read as failures)
        if stage and stage in unread:
            checks.append(_check(name, "unknown"))
        else:
            checks.append(_check(name, ("warn" if warn else "fail") if failures else "pass", failures))

    def observed(name: str, failures: int, unknown: bool) -> None:
        # for failures each seen directly (a reach, a file that does not parse): they stand whatever else
        # could not be read; with none seen, a gap in the reading leaves the check unknown, never a pass
        if failures:
            checks.append(_check(name, "fail", failures))
        else:
            checks.append(_check(name, "unknown" if unknown else "pass", None if unknown else failures))

    # privacy
    if inv.bucket is None:
        checks += [_check(n, "unknown") for n in ("bucket_private", "bucket_size_limit", "bucket_types")]
    else:
        b = inv.bucket
        checks.append(_check("bucket_private", "pass" if b.get("public") is False else "fail"))
        checks.append(_check("bucket_size_limit", "pass" if b.get("file_size_limit") == EXPECTED_LIMIT else "fail"))
        types = b.get("allowed_mime_types")
        checks.append(_check("bucket_types", "pass" if isinstance(types, list) and set(types) == EXPECTED_TYPES else "fail"))

    def refused(name: str, role: dict, fld: str) -> None:
        # reached = fail, whatever else is unknown; not established = unknown; no file to probe = skip;
        # refused = pass only when the probe was a GET (a download), because Storage checks HEAD / info and
        # GET as separate operations: a refused HEAD leaves the download unknown
        served = role.get(fld)
        if served:
            checks.append(_check(name, "fail"))
        elif fld in (role.get("unknown") or ()):
            checks.append(_check(name, "unknown"))
        elif served is None:
            checks.append(_check(name, "skip"))
        else:
            checks.append(_check(name, "pass" if role.get("file_probe") == "get" else "unknown"))

    def role_checks(prefix: str, role: Optional[dict], extra: tuple[str, ...] = ()) -> None:
        names = (f"{prefix}_tables_refused", f"{prefix}_files_hidden", f"{prefix}_file_refused")
        if role is None:
            checks.extend(_check(n, "unknown") for n in names + extra)
            return
        unknown = set(role.get("unknown") or ())
        observed(names[0], int(role.get("tables_reached") or 0), "tables" in unknown)
        observed(names[1], int(role.get("files_listed") or 0),
                 "files_listed" in unknown or role.get("files_listed") is None)
        refused(names[2], role, "file_served")
        if extra:
            refused(extra[0], role, "public_url_served")

    role_checks("anon", inv.anon, ("public_url_refused",))
    role_checks("authenticated", inv.authenticated)

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
    # with a database restore while the bytes may not; only a download proves them (drill target only).
    # A file found missing or the wrong size stays a failure when a later download could not be read; the
    # files not tried by then leave the check unknown.
    download_cut = "download" in unread
    if inv.opened is None or not docs_ok:
        checks += [_check(n, "unknown") for n in ("files_stored", "stored_sizes_match")]
    else:
        declared = {d.get("storage_path"): d.get("size_bytes") for d in ready
                    if PATH_RE.match(str(d.get("storage_path") or ""))}
        tried = {p: inv.opened[p] for p in declared if p in inv.opened}
        served = {p: v for p, v in tried.items() if v.get("served")}
        untried = len(declared) > len(tried)
        observed("files_stored", len(tried) - len(served), untried)
        observed("stored_sizes_match", sum(1 for p, v in served.items() if v.get("size") != declared[p]), untried)
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

    # downloaded files (drill target only): their structure, which is not the same as opening them
    if inv.opened is not None:
        observed("files_parse_as_declared_type",
                 sum(1 for v in inv.opened.values() if v.get("served") and not v.get("parses")), download_cut)
        if "signed" in unread:
            checks.append(_check("signed_link_serves_file", "unknown"))
        elif inv.signed_ok is not None:
            checks.append(_check("signed_link_serves_file", "pass" if inv.signed_ok else "fail"))

    # manifest (a backup's, or the drill's seed): files, and every row's identity, state and link. The
    # comparisons walk the manifest's own entries, so a manifest that is malformed, cut short or empty is
    # never compared (an empty restore would match it): it leaves the restore unknown.
    manifest_issue = manifest_problem(inv.manifest) if inv.manifest is not None else None
    if manifest_issue:
        checks.append(_check("manifest_valid", "unknown"))
    elif inv.manifest is not None:
        checks.append(_check("manifest_valid", "pass"))
        m_objects = inv.manifest["objects"]
        add("manifest_files_present", sum(1 for p in m_objects if p not in inv.objects), stage=both)
        add("manifest_sizes_match", sum(1 for p, v in m_objects.items()
                                        if p in inv.objects and inv.objects[p].get("size") != v.get("size")), stage=both)
        if inv.opened is None:
            checks.append(_check("manifest_hashes_match", "skip"))
        else:
            observed("manifest_hashes_match", sum(1 for p, v in m_objects.items()
                                                  if p in inv.opened and inv.opened[p].get("sha256") != v.get("sha256")),
                     download_cut)
        m_docs = inv.manifest["document_rows"]
        m_labs = inv.manifest["lab_rows"]
        labs_by_id = {r.get("id"): r for r in inv.labs}
        doc_stage = "documents" if not docs_ok else None
        add("manifest_document_rows", sum(1 for i in m_docs if i not in by_id), stage=doc_stage)
        add("manifest_document_state_match", sum(1 for i, s in m_docs.items()
                                                 if i in by_id and doc_state(by_id[i]) != s), stage=doc_stage)
        add("manifest_lab_rows", sum(1 for i in m_labs if i not in labs_by_id), stage="labs" if not labs_ok else None)
        # the full lab state a restore must preserve, compared per field group: counts and pass / fail
        # only, never a value, unit, range or id. The value / unit / range / date fields need the drill
        # select; on a production read they are unknown, never a pass or a fail.
        lab_diff: dict[str, int] = {n: 0 for n in LAB_STATE_CHECK_NAMES}
        for i, s in m_labs.items():
            if i not in labs_by_id:
                continue
            got = lab_state(labs_by_id[i])
            for fields, name, _ in LAB_STATE_GROUPS:
                if any(got[f] != s[f] for f in fields):
                    lab_diff[name] += 1
        labs_full = all("value_num" in r for r in labs_by_id.values()) if labs_by_id else True
        for _fields, name, always in LAB_STATE_GROUPS:
            if not always and not labs_full:
                checks.append(_check(name, "unknown"))
            else:
                add(name, lab_diff[name], stage=link_stage)
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

    incomplete = list(inv.unreadable)
    if manifest_issue:
        incomplete.append({"stage": "manifest", "reason": f"the manifest was not compared: {manifest_issue}"})
    results = {c["result"] for c in checks}
    status = "fail" if "fail" in results else "incomplete" if "unknown" in results or incomplete else "pass"
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
    if incomplete:
        report["incomplete"] = incomplete
    # Never a check of this tool, so never part of its PASS: recovery acceptance also needs it, recorded in
    # the private drill receipt.
    report["not_checked"] = [dict(NOT_CHECKED)]
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
                sample: Optional[str], note: Callable[[Unreadable], None]) -> dict:
    """What one role (the anon key, or a signed-in user's token) reaches, each probe on its own.

    A reach one probe observed (a table that answered, a listed entry, a served file) stays a FAIL
    whatever a later probe answers: an error further on never turns a confirmed exposure into
    "unknown". A refusal counts only once the credential was accepted: a table or listing refusal after
    the key check passed, a file refusal after that and once the role's own listing answered. Every
    error is noted, and what could not be established is named in "unknown". A credential the key check
    refused outright (401 / 403) can reach nothing, so the role's other probes are not sent."""
    out: dict = {"tables_reached": 0, "files_listed": None, "file_served": None, "file_probe": target.file_probe,
                 "unknown": []}
    try:
        target.key_accepted(stage, apikey, bearer, check_path)
        key_ok = True
    except Unreadable as e:
        note(e)
        if e.denied:
            out["unknown"] += ["tables", "files_listed", "file_served"]
            return out
        key_ok = False  # neither refused nor confirmed (a gateway error, say): reaches still count
    tables_open = 0
    for table in TABLES:
        try:
            if target.role_reaches_table(stage, apikey, bearer, table):
                out["tables_reached"] += 1
            elif not key_ok:
                tables_open += 1  # a refusal, but of a credential nobody confirmed
        except Unreadable as e:
            note(e)
            tables_open += 1
    if tables_open:
        out["unknown"].append("tables")
    listed = False
    try:
        out["files_listed"] = target.role_list_count(stage, apikey, bearer)
        listed = True
        if not out["files_listed"] and not key_ok:
            out["unknown"].append("files_listed")
    except Unreadable as e:
        note(e)
        out["unknown"].append("files_listed")
    if sample:
        # can the role reach one file directly? (listing and download are separate permissions)
        try:
            served = target.role_file_served(stage, apikey, bearer, sample)
        except Unreadable as e:
            note(e)
            out["unknown"].append("file_served")
        else:
            if served or (key_ok and listed):
                out["file_served"] = served
            else:
                out["unknown"].append("file_served")
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
        inv.labs = target.rows("labs", "lab_results", LAB_SELECT_DRILL if target.drill else LAB_SELECT)
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
        inv.anon = _probe_role(target, "anon", anon_key, anon_key, "/auth/v1/settings", sample, note)
        inv.anon["public_url_served"] = None
        if sample:
            # no credential is sent on the public URL, so its answer stands on its own
            try:
                inv.anon["public_url_served"] = target.public_url_served(sample)
            except Unreadable as e:
                note(e)
                inv.anon["unknown"].append("public_url_served")
    else:
        inv.unreadable.append({"stage": "anon", "reason": "no anon key", "ask": ACCESS_ASK["anon"]})
    if not user_token:
        inv.unreadable.append({"stage": "authenticated", "reason": "no signed-in user token",
                               "ask": ACCESS_ASK["authenticated"]})
    elif not anon_key:
        inv.unreadable.append({"stage": "authenticated", "reason": "the anon key is needed as the apikey",
                               "ask": ACCESS_ASK["anon"]})
    else:
        inv.authenticated = _probe_role(target, "authenticated", anon_key, user_token, "/auth/v1/user", sample, note)
    if target.file_probe == "head" and any(p and False in (p.get("file_served"), p.get("public_url_served"))
                                           for p in (inv.anon, inv.authenticated)):
        inv.unreadable.append({"stage": "download_privacy", "reason": (
            "the file and public-URL probes are HEAD requests here (no byte of a real record is sent), and "
            "Storage checks a HEAD and a download as separate operations, so a refused HEAD does not prove a "
            "download is refused; that is proven on a drill target (a GET of made-up files), and for "
            "production by the catalog read (no policy on any storage table)")})

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
                                    "parses": parses_as(mime, data)}
        except Unreadable as e:
            note(e)
        first = next((p for p in sorted(inv.opened) if inv.opened[p].get("served")), None)
        if first:
            try:
                inv.signed_ok = hashlib.sha256(target.signed_fetch(first)).hexdigest() == inv.opened[first]["sha256"]
            except Unreadable as e:
                note(e)
    else:
        inv.unreadable.append({"stage": "bytes", "reason": "file bytes are not checked without downloading the "
                               "files: the listing and HEAD read the database row only, and files are downloaded "
                               "on a drill target only (--open-files), never on production"})

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
                # the personal access token goes to the Management API's own origin and nowhere else
                status, data = request(target.transport, "backups", "GET",
                                       f"{MANAGEMENT_API}/v1/projects/{ref}/database/backups",
                                       {"Authorization": f"Bearer {access_token}"}, origin=MANAGEMENT_ORIGIN,
                                       sleep=target.sleep)
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
    size / type / state, every lab result's state (document link, removal, value, unit, reference
    range and collection date) and the row counts. It holds ids and values, so it is kept privately
    (drill folder, or encrypted with the off-site copy), never in the repo. main() writes it only when
    manifest_problem() accepts it, the same rule --manifest applies."""
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


class ManifestInvalid(ValueError):
    """A manifest that cannot be the reference for a restore. Its message is one of manifest_problem()'s
    fixed reasons: it names a rule, never an id, a path or a value, so it may be printed."""


def _whole(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _num(v) -> bool:
    """A NUMERIC value as PostgREST encodes it (a JSON number; a bool is not one)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def manifest_problem(data) -> Optional[str]:
    """Why a manifest cannot be the reference a restore is judged against, or None when it can.

    The comparisons in evaluate() walk the manifest's own entries, so a manifest whose maps are empty, cut
    short or malformed would let an empty or broken restore PASS. Accepted only when: it has exactly the
    fields build_manifest() writes, every entry has the shape and the values the database allows (the
    checks of sql/medical_records_schema.sql), the counts agree with the rows it lists, every ready document
    (removed or not: removal keeps the file) has its file in objects at its declared size, every lab link
    names a document in the manifest, no two documents share a path, and it holds something to compare.
    That is what any manifest written from a PASS holds. The reason names a rule, never an id or a path."""
    if not isinstance(data, dict) or data.get("version") != MANIFEST_VERSION:
        return "not a version-1 recovery manifest"
    if set(data) != MANIFEST_KEYS:
        return "unexpected or missing top-level fields"
    if not isinstance(data["created_at"], str) or _parse_time(data["created_at"]) is None:
        return "created_at is not a time"
    objects, docs, labs = data["objects"], data["document_rows"], data["lab_rows"]
    if not all(isinstance(m, dict) for m in (objects, docs, labs)):
        return "objects, document_rows and lab_rows must be maps"
    if not all(_whole(data[k]) for k in ("documents", "labs", "lab_results_linked")):
        return "a count is not a whole number"
    for path, v in objects.items():
        if not (isinstance(path, str) and PATH_RE.match(path) and isinstance(v, dict) and set(v) == {"size", "sha256"}
                and _whole(v["size"]) and v["size"] <= EXPECTED_LIMIT
                and isinstance(v["sha256"], str) and SHA256_RE.match(v["sha256"])):
            return "an objects entry is malformed"
    paths: set[str] = set()
    for i, s in docs.items():
        if not (isinstance(i, str) and ID_RE.match(i) and isinstance(s, dict) and set(s) == DOC_STATE_KEYS
                and isinstance(s["storage_path"], str) and PATH_RE.match(s["storage_path"])
                and _whole(s["size_bytes"]) and 1 <= s["size_bytes"] <= EXPECTED_LIMIT
                and isinstance(s["mime_type"], str) and s["mime_type"] in EXPECTED_TYPES
                and s["status"] in ("pending", "ready") and isinstance(s["removed"], bool)):
            return "a document_rows entry is malformed"
        if s["storage_path"] in paths:
            return "two document rows share a storage path"
        paths.add(s["storage_path"])
        if s["status"] == "ready":
            obj = objects.get(s["storage_path"])
            if obj is None:
                return "a ready document's file is not in objects"
            if obj["size"] != s["size_bytes"]:
                return "a ready document's file size differs from its row"
    for i, s in labs.items():
        if not (isinstance(i, str) and ID_RE.match(i) and isinstance(s, dict) and set(s) == LAB_STATE_KEYS
                and (s["document_id"] is None or (isinstance(s["document_id"], str) and ID_RE.match(s["document_id"])))
                and isinstance(s["removed"], bool)
                and (s["value_num"] is None or _num(s["value_num"]))
                and isinstance(s["value_text"], str)
                and isinstance(s["unit"], str)
                and (s["ref_low"] is None or _num(s["ref_low"]))
                and (s["ref_high"] is None or _num(s["ref_high"]))
                and isinstance(s["ref_text"], str)
                and isinstance(s["ref_low_strict"], bool)
                and isinstance(s["ref_high_strict"], bool)
                and isinstance(s["collected_on"], str)
                and re.fullmatch(r"\d{4}-\d{2}-\d{2}", s["collected_on"]) is not None):
            return "a lab_rows entry is malformed"
        if s["document_id"] is not None and s["document_id"] not in docs:
            return "a lab link names a document that is not in the manifest"
    if (data["documents"] != len(docs) or data["labs"] != len(labs)
            or data["lab_results_linked"] != sum(1 for s in labs.values() if s["document_id"] is not None)):
        return "the counts do not match the rows it lists"
    if not (objects or docs or labs):
        return "it holds nothing to compare a restore against"
    return None


def load_manifest(path: Path) -> dict:
    """The manifest at `path`, refused (ManifestInvalid) unless manifest_problem() accepts it. A file that
    is not JSON raises the plain ValueError json gives (its message is not printed)."""
    data = json.loads(path.read_text(encoding="utf-8"))
    problem = manifest_problem(data)
    if problem:
        raise ManifestInvalid(problem)
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
    for n in report.get("not_checked", []):
        lines.append(f"not checked by this tool: {n['name']}: {n['how']}")
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


def _names_production(token: str) -> bool:
    """Whether a JWT-style key or token says it belongs to the production project (its payload's "ref",
    or the issuer URL). Decoded without verification and never printed; anything else answers False."""
    parts = token.split(".")
    if len(parts) != 3:
        return False
    try:
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    except ValueError:  # bad base64, bytes that are not UTF-8, not JSON
        return False
    return isinstance(payload, dict) and (payload.get("ref") == PRODUCTION_REF
                                          or PRODUCTION_REF in str(payload.get("iss") or ""))


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
    # Which target this is, decided from the exact origin before any key is read: production is exactly
    # PRODUCTION_ORIGIN; a drill target is a local stack or the project named with --drill-project. Anything
    # else (another host, http, another port, a path, a user name in the URL) is refused, so no key, token or
    # header can reach a server nobody chose.
    kind = classify(args.url, args.drill_project)
    if kind is None:
        print(f"refused: the target must be exactly the production project ({base_url(PRODUCTION_ORIGIN)}) or a "
              "drill target (a local stack, or a throwaway project named with --drill-project), given as a bare "
              "origin; no key was read and nothing was sent", file=out)
        return 2
    opening = bool(args.open_files or args.write_manifest)
    if opening and kind != "drill":
        print("refused: --open-files and --write-manifest run on a drill target only (a local stack, or a "
              "throwaway project named with --drill-project); real records are never downloaded by this check",
              file=out)
        return 2
    if args.skip_backups and kind != "drill":
        print("refused: --skip-backups is for a drill target only; on production the backup list is part of the "
              f"check (without SUPABASE_ACCESS_TOKEN it is reported as incomplete; ask for: {ACCESS_ASK['backups']})",
              file=out)
        return 2
    if kind == "drill":
        # A drill target (whose logs may record headers) gets its own credentials only: the RECOVERY_DRILL_*
        # variables or a key file named explicitly, never SUPABASE_SERVICE_ROLE_KEY / SUPABASE_USER_ACCESS_TOKEN
        # (a shell may hold the production ones) and never the default key file (it holds the production key).
        key_file = args.key_file if args.key_file and not _same_file(args.key_file, DEFAULT_KEY_FILE) else None
        key = _read_key((DRILL_ENV["service"],), key_file)
        anon_key = _read_key((DRILL_ENV["anon"],), None)
        user_token = os.environ.get(DRILL_ENV["user"]) or None
        if not key:
            print(f"incomplete: set the drill stack's service key in {DRILL_ENV['service']}, or name a key file with "
                  "--key-file (SUPABASE_SERVICE_ROLE_KEY and the production key file are never used for a drill "
                  "target)", file=out)
            return 2
        if any(_names_production(t) for t in (key, user_token) if t):
            print("refused: a drill credential belongs to the production project; nothing was sent", file=out)
            return 2
    else:
        key = _read_key(("SUPABASE_SERVICE_ROLE_KEY",), args.key_file or DEFAULT_KEY_FILE)
        anon_key = _read_key(("SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"), None)
        user_token = os.environ.get("SUPABASE_USER_ACCESS_TOKEN") or None
        if not key:
            print(f"incomplete: no service-role key; ask for: {ACCESS_ASK['documents']}", file=out)
            return 2
    manifest = None
    if args.manifest:
        try:
            manifest = load_manifest(args.manifest)
        except ManifestInvalid as e:
            # a malformed, cut-short or empty reference would let an empty restore PASS: never compared
            print(f"incomplete: the manifest was refused ({e}); nothing was compared or sent", file=out)
            return 2
        except (OSError, ValueError) as e:
            print(f"incomplete: manifest could not be read ({type(e).__name__})", file=out)
            return 2
    now = datetime.now(timezone.utc)
    target = Target(args.url, key, transport=transport, sleep=sleep, drill=kind == "drill")
    inv = collect(target, anon_key=anon_key, access_token=os.environ.get("SUPABASE_ACCESS_TOKEN") or None,
                  skip_backups=args.skip_backups, open_files=opening, manifest=manifest, now=now,
                  user_token=user_token)
    report = evaluate(inv)
    print(json.dumps(report, indent=2) if args.json else format_report(report), file=out)
    code = {"pass": 0, "fail": 1}.get(report["status"], 2)
    if args.write_manifest:
        if report["status"] != "pass":
            # a broken or partly read state must never become the reference a restore is judged against
            print(f"refused: the baseline is {report['status']}, not PASS; no manifest written", file=out)
            return code
        built = build_manifest(inv, now)
        problem = manifest_problem(built)
        if problem:
            # never write a reference that a later --manifest run would refuse (an empty store, say)
            print(f"refused: this baseline does not make a usable manifest ({problem}); no manifest written", file=out)
            return 2
        args.write_manifest.write_text(json.dumps(built, indent=2), encoding="utf-8")
    return code


if __name__ == "__main__":
    sys.exit(main())
