"""Medical records recovery check (tools/medical_recovery/recovery_check.py).

Covers, against a fake Supabase (PostgREST + Storage + Auth + Management API) with SYNTHETIC rows
and files:
  * a healthy store passes, prints counts only (no id, storage path, key or record text), and asks
    PostgREST for id / path / size / type / state columns only, never a text column;
  * failure-recovery: a restore that lost a file (from the listing, or only its bytes in the storage
    backend: proven by a download on the drill, whether Storage answers not-found or 500; on
    production that is unknown, never a pass, because HEAD and the listing read the row only),
    changed a size or type, left a lab result pointing at a missing document, cleared or reassigned
    a lab result's document link, brought back a removed document as live, or brought back a
    corrupted / truncated / look-alike file is a FAIL; a content type with parameters or capitals
    is compared the way the app's complete route compares it;
  * privacy / cross-user: a public bucket, a changed size cap or type list, the anon key or a
    signed-in user's token reaching a table, listing a file or reaching one file directly (with the
    listing still empty), or the public URL serving a file are each a FAIL; on the drill the file
    probes are real GETs of made-up files, so a GET-only exposure (HEAD refused, download served)
    fails; on production every file probe is a HEAD (no bytes), and a refused HEAD leaves the
    download refusal UNKNOWN, never a pass; a stale / invalid key, a table probe answered without a
    permission code, a listing answered with anything but a list or "bucket not found" (e.g.
    "Invalid Compact JWS"), a malformed listing and a listing with a malformed entry ([null],
    ["x"], a nameless entry) are INCOMPLETE, never a pass; each probe stands on its own, so a reach
    seen before a later probe failed (a listing error, a file or public-URL probe that kept failing,
    a key check answered by a gateway error) stays a FAIL, and so does a drill file that does not
    parse when a later download could not be read;
  * origins: only the exact production origin may receive the production keys; any other URL
    (another host, http, another port, a path, a user name, a look-alike host, a hosted project not
    named with --drill-project) is refused before any key is read; a drill target never gets
    SUPABASE_SERVICE_ROLE_KEY, SUPABASE_USER_ACCESS_TOKEN or the default key file, and a drill key or
    token whose JWT names production is refused; a redirect is never followed (a 3xx is unreadable,
    proven against urllib's own opener), a request to another origin is refused before it is sent,
    and a signed link to another origin or another file is never fetched;
  * retry: network errors and 5xx are retried with backoff and then pass; a read that keeps failing
    is INCOMPLETE (exit 2), never a pass; a 401 / 403 is not retried and becomes the exact access ask;
  * backups: no access token = incomplete with the access ask; a backup older than 36 h = fail;
    the backup summary keeps dates and counts only; a fresh point-in-time value does not hide
    failed daily backups when PITR is off;
  * the drill: files are opened, backups skipped and a manifest written only on a local stack or a
    named throwaway project, never on production (refused before any request); the manifest is
    written only from a PASS; a wipe is detected against the manifest and a full restore passes,
    including the signed-link fetch; a drill target never reads the production key file; the file
    check is reported as a structural parse, and "a restored file opens" as not checked;
  * paging past PostgREST's 1000-row cap; placeholder files and orphans warn instead of failing.

Synthetic data only. No network, no credentials.

Run: python tests/test_medical_recovery_check.py
"""
import base64
import email.message
import io
import json
import os
import sys
import tempfile
import urllib.parse
import urllib.request
import urllib.response
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "medical_recovery"))

import recovery_check as rc  # noqa: E402

PROD = "https://fewweioupmsnbccqtxdl.supabase.co"
LOCAL = "http://127.0.0.1:54321"
DRILL_REF = "abcdefghijklmnopqrst"
DRILL = f"https://{DRILL_REF}.supabase.co"
SERVICE = "service-key-SYNTHETIC-0001"
ANON = "anon-key-SYNTHETIC-0002"
TOKEN = "access-token-SYNTHETIC-0003"
USER = "user-token-SYNTHETIC-0004"
NOW = datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc)
FILES = rc.synthetic_files()
PDF = FILES["synthetic-drill-document.pdf"][1]
PNG = FILES["synthetic-drill-image.png"][1]
# a structurally valid, made-up baseline JPEG: SOI, JFIF APP0, SOF0 (1x1, one component), SOS, EOI
JPEG = (b"\xff\xd8"
        + b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
        + b"\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00"
        + b"\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00"
        + b"\x00\x00\x00\x00\xff\xd9")
TEXT_COLUMNS = ("title", "provider", "notes", "test_name", "value_num", "value_text", "unit", "ref_text", "lab")
INVALID_KEY = b'{"message":"Invalid API key"}'
NOT_FOUND = b'{"statusCode":"404","error":"not_found","message":"Object not found"}'
BAD_JWS = b'{"statusCode":"403","error":"Unauthorized","message":"Invalid Compact JWS"}'
INTERNAL = (500, b'{"statusCode":"500","error":"Internal","message":"Internal Server Error"}')
BYTE_CHECKS = ("files_stored", "stored_sizes_match")
# on production the file probes are HEADs: a refusal there proves nothing about a download
DOWNLOAD_CHECKS = ("anon_file_refused", "public_url_refused", "authenticated_file_refused")


def uid(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def doc(n: int, mime="application/pdf", data=PDF, status="ready", removed=False) -> dict:
    return {"id": uid(n), "storage_path": f"documents/{uid(n)}", "mime_type": mime, "size_bytes": len(data),
            "status": status, "removed_at": "2026-01-02T00:00:00+00:00" if removed else None,
            "title": f"Synthetic title {n}", "notes": "synthetic note", "provider": "Synthetic clinic"}


def lab(n: int, document=None) -> dict:
    return {"id": uid(10_000 + n), "document_id": document, "removed_at": None,
            "test_name": f"Synthetic test {n}", "value_num": 1.5, "unit": "u"}


def healthy():
    docs = [doc(1), doc(2, "image/png", PNG), doc(3, status="pending"), doc(4, removed=True)]
    files = {f"documents/{uid(1)}": ("application/pdf", PDF), f"documents/{uid(2)}": ("image/png", PNG),
             f"documents/{uid(4)}": ("application/pdf", PDF)}
    labs = [lab(1, uid(1)), lab(2)]
    return docs, labs, files


def recent_backups(hours_ago=5):
    newest = datetime.now(timezone.utc) - timedelta(hours=hours_ago)  # main() judges age against the clock
    return {"pitr_enabled": False, "walg_enabled": True, "backups": [
        {"status": "COMPLETED", "is_physical_backup": True, "inserted_at": (newest - timedelta(days=d)).isoformat()}
        for d in range(7)] + [{"status": "FAILED", "inserted_at": (newest - timedelta(days=8)).isoformat()}]}


class FakeServer:
    """PostgREST, Storage, Auth and the Management API as one transport. `fail` scripts answers per path
    prefix (a status, or "network") before the normal answer. Roles: the service key; the anon key;
    a signed-in user = the anon key as apikey with the user's token as the bearer."""

    def __init__(self, docs, labs, files, *, public=False, limit=rc.EXPECTED_LIMIT, types=rc.EXPECTED_TYPES,
                 anon_table=False, anon_list=False, user_table=False, user_list=False, anon_table_answer=None,
                 anon_list_answer=None, lost_bytes=(), fail=None, backups=None, extra_top=(), extra_docs=(),
                 signed_bytes=None, anon_file=False, user_file=False, lost_answer=None, get_only=False,
                 signed_link=None):
        self.tables = {"medical_documents": docs, "lab_results": labs}
        self.files = dict(files)
        self.public, self.limit, self.types = public, limit, sorted(types)
        self.anon_table, self.anon_list = anon_table, anon_list
        self.user_table, self.user_list = user_table, user_list
        self.anon_table_answer, self.anon_list_answer = anon_table_answer, anon_list_answer
        self.lost_bytes = set(lost_bytes)  # listed (storage.objects row) but the bytes are gone
        self.lost_answer = lost_answer or INTERNAL  # the local file backend answers 500 for a missing file
        self.anon_file, self.user_file = anon_file, user_file  # a policy letting the role read one file
        # a policy on the download (GET) operation only: HEAD / info stays refused (Storage checks them apart)
        self.get_only = get_only
        self.signed_link = signed_link  # obj -> the signed link the sign route answers (default: Storage's)
        self.fail = {k: list(v) for k, v in (fail or {}).items()}
        self.backups = backups if backups is not None else recent_backups()
        self.extra_top, self.extra_docs = list(extra_top), list(extra_docs)
        self.signed_bytes = signed_bytes
        self.calls, self.selects, self.heads, self.bearers = [], [], [], []

    def __call__(self, method, url, headers, body, read_body=True):
        parts = urllib.parse.urlsplit(url)
        path, q = parts.path, urllib.parse.parse_qs(parts.query)
        self.calls.append((method, parts.hostname, path))
        self.bearers.append(headers.get("Authorization"))
        for prefix, seq in self.fail.items():
            if path.startswith(prefix) and seq:
                v = seq.pop(0)
                if v == "network":
                    raise rc.TransportError("ConnectError")
                return v, b'{"code":"SYNTHETIC"}'
        key = headers.get("apikey")
        user = key == ANON and headers.get("Authorization") == f"Bearer {USER}"
        if parts.hostname == "api.supabase.com":
            return (200, json.dumps(self.backups).encode()) if headers.get("Authorization") == f"Bearer {TOKEN}" else (401, b"{}")
        if path == "/auth/v1/settings":
            return (200, b"{}") if key == ANON else (401, INVALID_KEY)
        if path == "/auth/v1/user":
            return (200, b"{}") if user else (401, INVALID_KEY if key != ANON else b'{"code":"bad_jwt"}')
        if path.startswith("/rest/v1/"):
            table = path.rsplit("/", 1)[1]
            if user:
                return (200, b"[]") if self.user_table else (403, b'{"code":"42501"}')
            if key == ANON:
                if self.anon_table_answer:
                    return self.anon_table_answer
                return (200, b"[]") if self.anon_table else (401, b'{"code":"42501"}')
            if key != SERVICE or headers.get("Accept-Profile") != "pds":
                return 401, INVALID_KEY
            cols = q["select"][0].split(",")
            self.selects.append((table, q["select"][0]))
            off, lim = int(q.get("offset", ["0"])[0]), int(q["limit"][0])
            rows = sorted(self.tables[table], key=lambda r: r["id"])[off:off + lim]
            return 200, json.dumps([{c: r.get(c) for c in cols} for r in rows]).encode()
        if path == f"/storage/v1/bucket/{rc.BUCKET}":
            if key != SERVICE:
                return 400, b"{}"
            return 200, json.dumps({"id": rc.BUCKET, "public": self.public, "file_size_limit": self.limit,
                                    "allowed_mime_types": self.types}).encode()
        if path == f"/storage/v1/object/list/{rc.BUCKET}":
            req = json.loads(body.decode())
            items = self._listing(req["prefix"])
            if user:
                return 200, json.dumps(items[:1] if self.user_list and req["prefix"] == "documents" else []).encode()
            if key == ANON:
                if self.anon_list_answer:
                    return self.anon_list_answer
                return 200, json.dumps(items[:1] if self.anon_list and req["prefix"] == "documents" else []).encode()
            if key != SERVICE:
                return 400, b"{}"
            return 200, json.dumps(items[req["offset"]:req["offset"] + req["limit"]]).encode()
        if path.startswith(f"/storage/v1/object/public/{rc.BUCKET}/"):
            if method == "HEAD":
                self.heads.append((path, "public"))
            return (200, b"") if self.public else (400, b"" if method == "HEAD" else NOT_FOUND)
        if path.startswith(f"/storage/v1/object/sign/{rc.BUCKET}/"):
            obj = urllib.parse.unquote(path.split(f"/object/sign/{rc.BUCKET}/", 1)[1])
            if method == "POST":
                if key != SERVICE or obj not in self.files:
                    return 400, b"{}"
                link = self.signed_link(obj) if self.signed_link else f"/object/sign/{rc.BUCKET}/{obj}?token=synthetic"
                return 200, json.dumps({"signedURL": link}).encode()
            if q.get("token") != ["synthetic"] or obj not in self.files:
                return 400, b"{}"
            return 200, self.signed_bytes if self.signed_bytes is not None else self.files[obj][1]
        if path.startswith(f"/storage/v1/object/{rc.BUCKET}/"):
            obj = urllib.parse.unquote(path.split(f"/object/{rc.BUCKET}/", 1)[1])
            who = "user" if user else "anon" if key == ANON else "service" if key == SERVICE else "other"
            if method == "HEAD":
                self.heads.append((obj, who))
            if who in ("user", "anon"):
                # row-level security on storage.objects: with no policy the row is invisible to the role
                if (self.user_file if who == "user" else self.anon_file) and obj in self.files:
                    return 200, b"" if method == "HEAD" else self.files[obj][1], {}
                if self.get_only and method == "GET" and obj in self.files:
                    return 200, self.files[obj][1], {}
                return 400, b"" if method == "HEAD" else NOT_FOUND, {}
            if who != "service":
                return 400, BAD_JWS, {}
            if obj not in self.files:
                return 400, b"" if method == "HEAD" else NOT_FOUND, {}
            mime, data = self.files[obj]
            if method == "HEAD":
                # like Storage: HEAD is answered from the storage.objects row and never asks the backend, so a
                # file whose bytes are gone still answers 200 (why HEAD is not byte evidence)
                return 200, b"", {"content-length": str(len(data)), "content-type": mime}
            if obj in self.lost_bytes:
                return self.lost_answer[0], self.lost_answer[1], {}
            return 200, data, {"content-length": str(len(data)), "content-type": mime}
        return 404, b"{}"

    def _listing(self, prefix):
        if prefix == "":
            return [{"name": "documents", "id": None, "metadata": None}] + self.extra_top
        docs = [{"name": p.split("/", 1)[1], "id": f"obj-{i}", "metadata": {"size": len(data), "mimetype": mime}}
                for i, (p, (mime, data)) in enumerate(sorted(self.files.items()))]
        return docs + self.extra_docs


class Env:
    """Set the anon key / user token / access token for one main() call (offline runs strip SUPABASE_* vars).
    The same synthetic anon key and user token go under the production names and the drill names
    (RECOVERY_DRILL_*), so a test runs the same on either target; `extra` overrides any variable."""

    def __init__(self, anon=ANON, token=TOKEN, user=USER, **extra):
        self.values = {"SUPABASE_ANON_KEY": anon, "SUPABASE_ACCESS_TOKEN": token, "SUPABASE_USER_ACCESS_TOKEN": user,
                       "SUPABASE_SERVICE_ROLE_KEY": None, "NEXT_PUBLIC_SUPABASE_ANON_KEY": None, "SUPABASE_URL": None,
                       "RECOVERY_DRILL_SERVICE_KEY": None, "RECOVERY_DRILL_ANON_KEY": anon,
                       "RECOVERY_DRILL_USER_TOKEN": user}
        self.values.update(extra)

    def __enter__(self):
        self.saved = {k: os.environ.get(k) for k in self.values}
        for k, v in self.values.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        return self

    def __exit__(self, *exc):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def run(server, *args, url=PROD, anon=ANON, token=TOKEN, key=SERVICE, user=USER):
    """main() with the fake server; answers (exit code, printed text, JSON report or None, sleeps)."""
    sleeps = []
    with tempfile.TemporaryDirectory() as tmp:
        key_file = Path(tmp) / "key"
        key_file.write_text(key or "", encoding="utf-8")
        out = io.StringIO()
        with Env(anon=anon, token=token, user=user):
            code = rc.main(["--url", url, "--key-file", str(key_file), "--json", *args],
                           transport=server, sleep=sleeps.append, out=out)
    text = out.getvalue()
    try:
        report = json.loads(text)
    except ValueError:
        report = None
    return code, text, report, sleeps


def result(report, name):
    return next(c for c in report["checks"] if c["name"] == name)


def only_bytes_unknown(report):
    """Production's best result: everything read; unknown are only the bytes (real records are never
    downloaded) and the download refusals (the file probes are HEADs, which prove nothing about a GET)."""
    unknown = {c["name"] for c in report["checks"] if c["result"] == "unknown"}
    return (report["status"] == "incomplete" and unknown == set(BYTE_CHECKS) | set(DOWNLOAD_CHECKS)
            and sorted(u["stage"] for u in report.get("incomplete", [])) == ["bytes", "download_privacy"])


def assert_private_output(text):
    for secret in (SERVICE, ANON, TOKEN, USER, "Synthetic title", "synthetic note", "Synthetic test", "documents/", uid(1)):
        assert secret not in text, secret


def jwt(payload: dict) -> str:
    """A made-up, unsigned JWT-shaped string carrying `payload` (never a real key)."""
    def part(d):
        return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return f"{part({'alg': 'none'})}.{part(payload)}.SYNTHETIC"


def seed_manifest(tmp, docs, labs, files):
    """The drill baseline: the manifest of the healthy synthetic store (written only from a PASS)."""
    manifest = Path(tmp) / "drill-manifest.json"
    code, text, _, _ = run(FakeServer(docs, labs, files), "--skip-backups", "--write-manifest", str(manifest), url=LOCAL)
    assert code == 0 and manifest.exists(), text
    return manifest


# ---------------------------------------------------------------- healthy store, counts only

def test_healthy_store_on_production_reads_everything_but_the_bytes():
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files, backups=recent_backups(hours_ago=5))
    code, text, report, _ = run(server)
    assert code == 2 and only_bytes_unknown(report), text  # never PASS without byte evidence
    assert report["counts"]["documents"] == 4 and report["counts"]["documents_ready"] == 3
    assert report["counts"]["files"] == 3 and report["counts"]["lab_results_linked"] == 1
    assert report["backups"]["state"] == "read" and report["backups"]["completed_backups"] == 7
    for name in ("anon_tables_refused", "anon_files_hidden", "authenticated_tables_refused",
                 "authenticated_files_hidden", "ready_documents_have_file", "file_sizes_match", "lab_links_resolve",
                 "database_backup_recent"):
        assert result(report, name)["result"] == "pass", name
    for name in DOWNLOAD_CHECKS:  # a refused HEAD is not a refused download: never a pass on production
        assert result(report, name)["result"] == "unknown", name
    assert result(report, "public_url_refused")["result"] == "unknown"
    assert_private_output(text)
    # only ids, paths, sizes, types and states are ever requested
    assert server.selects and all(not any(c in sel.split(",") for c in TEXT_COLUMNS) for _, sel in server.selects)
    assert ("medical_documents", rc.DOC_SELECT) in server.selects and ("lab_results", rc.LAB_SELECT) in server.selects
    # read-only, and no file is downloaded or signed on production: GET, HEAD (headers only) and list calls
    assert all(m in ("GET", "HEAD") or p.endswith(f"/object/list/{rc.BUCKET}") for m, _, p in server.calls), server.calls
    assert not any(m == "GET" and p.startswith("/storage/v1/object/") for m, _, p in server.calls)
    assert not any("/object/sign/" in p for _, _, p in server.calls)
    # a HEAD only from the role and public-URL probes, never with the service key
    assert sorted(w for _, w in server.heads) == ["anon", "public", "user"]


def test_healthy_drill_target_passes_with_the_bytes_proven():
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files)
    code, text, report, _ = run(server, "--skip-backups", "--open-files", url=LOCAL)
    assert code == 0 and report["status"] == "pass", text
    for name in BYTE_CHECKS + DOWNLOAD_CHECKS + ("files_parse_as_declared_type", "signed_link_serves_file"):
        assert result(report, name)["result"] == "pass", name
    # the drill's file probes are real downloads (GET) of made-up files, never a HEAD
    assert server.heads == [] and not any(c["name"] == "files_open" for c in report["checks"])
    # the structural parse is not an opening: that stays a person's observation, outside the PASS
    assert report["not_checked"] == [rc.NOT_CHECKED] and report["not_checked"][0]["result"] == "unknown"
    assert_private_output(text)


def test_human_output_is_counts_only_too():
    docs, labs, files = healthy()
    out = io.StringIO()
    with tempfile.TemporaryDirectory() as tmp, Env():
        kf = Path(tmp) / "k"
        kf.write_text(SERVICE, encoding="utf-8")
        code = rc.main(["--url", PROD, "--key-file", str(kf)], transport=FakeServer(docs, labs, files),
                       sleep=lambda s: None, out=out)
    assert code == 2
    assert out.getvalue().startswith("medical records recovery check: INCOMPLETE")
    assert "incomplete: bytes:" in out.getvalue() and "incomplete: download_privacy:" in out.getvalue()
    assert "not checked by this tool: file_opened_in_viewer" in out.getvalue()
    assert_private_output(out.getvalue())


# ---------------------------------------------------------------- failure recovery

def test_restore_that_lost_a_file_fails():
    docs, labs, files = healthy()
    files.pop(f"documents/{uid(2)}")
    code, text, report, _ = run(FakeServer(docs, labs, files))
    assert code == 1 and report["status"] == "fail"
    assert result(report, "ready_documents_have_file") == {"name": "ready_documents_have_file", "result": "fail", "count": 1}
    assert result(report, "files_stored")["result"] == "unknown"  # production never claims the bytes
    assert_private_output(text)
    code, _, report, _ = run(FakeServer(docs, labs, files), "--skip-backups", "--open-files", url=LOCAL)
    assert code == 1 and result(report, "files_stored") == {"name": "files_stored", "result": "fail", "count": 1}


def test_list_entry_whose_bytes_are_gone_fails_on_the_drill_and_never_passes_on_production():
    # a database restore brings storage.objects rows back without the bytes: the listing AND a HEAD look fine
    docs, labs, files = healthy()
    lost = {f"documents/{uid(1)}"}
    code, text, report, _ = run(FakeServer(docs, labs, files, lost_bytes=lost))
    assert code == 2 and only_bytes_unknown(report), text
    # the drill: the local file backend answers 500 for the missing file, the hosted backend a not-found
    for answer in (None, (400, NOT_FOUND), (404, b"")):
        server = FakeServer(docs, labs, files, lost_bytes=lost, lost_answer=answer)
        code, text, report, _ = run(server, "--skip-backups", "--open-files", url=LOCAL)
        assert code == 1 and report["status"] == "fail", (answer, text)
        assert result(report, "ready_documents_have_file")["result"] == "pass"
        assert result(report, "files_stored") == {"name": "files_stored", "result": "fail", "count": 1}
        assert result(report, "signed_link_serves_file")["result"] == "pass"  # from a file that was served
        assert_private_output(text)


def test_download_refused_for_another_reason_is_incomplete():
    # a 400 that is not Storage's not-found answer (a credential error) proves nothing about the bytes
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files, lost_bytes={f"documents/{uid(1)}"}, lost_answer=(400, BAD_JWS))
    code, _, report, _ = run(server, "--skip-backups", "--open-files", url=LOCAL)
    assert code == 2 and result(report, "files_stored")["result"] == "unknown"


def test_removed_document_keeps_its_file_for_undo():
    docs, labs, files = healthy()
    files.pop(f"documents/{uid(4)}")  # the soft-removed document's file is gone: Undo would break
    _, _, report, _ = run(FakeServer(docs, labs, files))
    assert result(report, "ready_documents_have_file")["count"] == 1


def test_size_and_type_mismatches_fail():
    docs, labs, files = healthy()
    files[f"documents/{uid(1)}"] = ("image/png", PDF + b"x")
    _, _, report, _ = run(FakeServer(docs, labs, files))
    assert result(report, "file_sizes_match")["result"] == "fail"
    assert result(report, "file_types_match")["result"] == "fail"
    _, _, report, _ = run(FakeServer(docs, labs, files), "--skip-backups", "--open-files", url=LOCAL)
    assert result(report, "stored_sizes_match")["result"] == "fail"  # the downloaded bytes, not the row


def test_content_type_is_compared_like_the_complete_route():
    # the app's complete route accepts "Application/PDF; charset=binary" as application/pdf: no false alarm
    docs, labs, files = healthy()
    files[f"documents/{uid(1)}"] = ("Application/PDF; charset=binary", PDF)
    _, _, report, _ = run(FakeServer(docs, labs, files))
    assert result(report, "file_types_match")["result"] == "pass"


def test_lab_result_pointing_at_a_missing_document_fails():
    docs, labs, files = healthy()
    labs.append(lab(3, uid(99)))
    _, _, report, _ = run(FakeServer(docs, labs, files))
    assert result(report, "lab_links_resolve") == {"name": "lab_links_resolve", "result": "fail", "count": 1}


def test_link_to_a_removed_document_only_warns():
    docs, labs, files = healthy()
    labs.append(lab(4, uid(4)))
    code, _, report, _ = run(FakeServer(docs, labs, files))
    assert result(report, "lab_links_live")["result"] == "warn" and code == 2 and only_bytes_unknown(report)


def test_placeholders_and_orphans_warn_but_do_not_fail():
    docs, labs, files = healthy()
    files[f"documents/{uid(50)}"] = ("application/pdf", PDF)  # a file with no row
    server = FakeServer(docs, labs, files, extra_top=[{"name": "stray.pdf", "id": "x", "metadata": {}}],
                        extra_docs=[{"name": ".emptyFolderPlaceholder", "id": "y", "metadata": {"size": 0}}])
    code, _, report, _ = run(server)
    assert code == 2 and only_bytes_unknown(report)  # warnings never fail the check
    assert result(report, "no_orphan_files") == {"name": "no_orphan_files", "result": "warn", "count": 1}
    assert result(report, "no_unexpected_paths") == {"name": "no_unexpected_paths", "result": "warn", "count": 2}


# ---------------------------------------------------------------- privacy / cross-user

def test_public_bucket_and_anon_access_fail():
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files, public=True, anon_table=True, anon_list=True,
                        limit=rc.EXPECTED_LIMIT * 2, types=list(rc.EXPECTED_TYPES) + ["text/html"])
    code, text, report, _ = run(server)
    assert code == 1
    for name in ("bucket_private", "bucket_size_limit", "bucket_types", "public_url_refused"):
        assert result(report, name)["result"] == "fail", name
    assert result(report, "anon_tables_refused") == {"name": "anon_tables_refused", "result": "fail", "count": 2}
    assert result(report, "anon_files_hidden")["result"] == "fail"
    assert_private_output(text)


def test_signed_in_user_reaching_a_table_or_a_file_fails():
    # another account (the authenticated role) must not read medical rows or files either
    docs, labs, files = healthy()
    code, text, report, _ = run(FakeServer(docs, labs, files, user_table=True, user_list=True))
    assert code == 1
    assert result(report, "authenticated_tables_refused") == {"name": "authenticated_tables_refused", "result": "fail",
                                                              "count": 2}
    assert result(report, "authenticated_files_hidden")["result"] == "fail"
    assert result(report, "anon_tables_refused")["result"] == "pass"
    assert_private_output(text)


def test_file_reachable_directly_while_the_listing_is_empty_fails():
    # listing and download are separate permissions in Storage: an empty listing alone proves nothing
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files, anon_file=True, user_file=True)
    code, text, report, _ = run(server)
    assert code == 1 and report["status"] == "fail"
    assert result(report, "anon_files_hidden")["result"] == "pass"
    assert result(report, "authenticated_files_hidden")["result"] == "pass"
    assert result(report, "anon_file_refused")["result"] == "fail"
    assert result(report, "authenticated_file_refused")["result"] == "fail"
    assert_private_output(text)
    # the probe is a HEAD: no bytes of a real record are sent even when the role may read them
    assert not any(m == "GET" and p.startswith("/storage/v1/object/") for m, _, p in server.calls)


def test_download_only_exposure_fails_on_the_drill_and_is_never_a_pass_on_production():
    # a policy on the download (GET) operation alone: HEAD / info is refused while the file is served
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files, get_only=True)
    code, text, report, _ = run(server, "--skip-backups", "--open-files", url=LOCAL)
    assert code == 1 and report["status"] == "fail", text
    for name in ("anon_file_refused", "authenticated_file_refused"):
        assert result(report, name)["result"] == "fail", name
    assert result(report, "anon_files_hidden")["result"] == "pass"  # the listing alone looked private
    assert result(report, "public_url_refused")["result"] == "pass"  # the bucket itself is still private
    # on production the probe stays a HEAD (no bytes of a real record): refused, so the download is unknown
    server = FakeServer(docs, labs, files, get_only=True)
    code, text, report, _ = run(server)
    assert code == 2 and only_bytes_unknown(report), text
    assert not any(m == "GET" and p.startswith("/storage/v1/object/") for m, _, p in server.calls)
    assert_private_output(text)


def test_exposure_seen_before_a_later_error_stays_a_fail():
    # each probe stands on its own: a table the role reached is a FAIL even when its listing, its file probe
    # or the public URL could not be read afterwards; it is never folded into "unknown"
    docs, labs, files = healthy()
    for later in ({"anon_list_answer": (400, BAD_JWS)},
                  {"fail": {f"/storage/v1/object/{rc.BUCKET}/": [503] * 3}},
                  {"fail": {f"/storage/v1/object/public/{rc.BUCKET}/": [503] * 3}}):
        code, text, report, _ = run(FakeServer(docs, labs, files, anon_table=True, **later))
        assert code == 1 and report["status"] == "fail", (later, text)
        assert result(report, "anon_tables_refused") == {"name": "anon_tables_refused", "result": "fail",
                                                         "count": 2}, later
        assert any(u["stage"] == "anon" for u in report["incomplete"]), later
        assert_private_output(text)
    # the key check itself unanswered (a gateway error): a reached table still fails, while a refusal of a
    # credential nobody confirmed (here the empty listing) stays unknown
    server = FakeServer(docs, labs, files, user_table=True, fail={"/auth/v1/user": [503] * 3})
    code, _, report, _ = run(server)
    assert code == 1 and result(report, "authenticated_tables_refused")["result"] == "fail"
    assert result(report, "authenticated_files_hidden")["result"] == "unknown"
    assert result(report, "authenticated_file_refused")["result"] == "unknown"
    code, _, report, _ = run(FakeServer(docs, labs, files, fail={"/auth/v1/settings": [503] * 3}))
    assert code == 2 and result(report, "anon_tables_refused")["result"] == "unknown"
    assert result(report, "anon_files_hidden")["result"] == "unknown"


def test_bad_file_seen_before_a_later_download_error_stays_a_fail():
    # the drill: a file that no longer parses stays a FAIL when a later download could not be read; the file
    # after the error was never tried, so whether it is stored stays unknown
    docs, labs, files = healthy()
    bad = dict(files)
    bad[f"documents/{uid(1)}"] = ("application/pdf", b"X" + PDF[1:])  # same size, no longer a PDF
    server = FakeServer(docs, labs, bad, lost_bytes={f"documents/{uid(4)}"}, lost_answer=(400, BAD_JWS))
    code, text, report, _ = run(server, "--skip-backups", "--open-files", url=LOCAL)
    assert code == 1 and report["status"] == "fail", text
    assert result(report, "files_parse_as_declared_type") == {"name": "files_parse_as_declared_type",
                                                              "result": "fail", "count": 1}
    assert result(report, "files_stored")["result"] == "unknown"
    assert any(u["stage"] == "download" for u in report["incomplete"])
    assert_private_output(text)


def test_missing_anon_key_is_incomplete_not_pass():
    docs, labs, files = healthy()
    code, _, report, _ = run(FakeServer(docs, labs, files), anon=None)
    assert code == 2 and report["status"] == "incomplete"
    assert result(report, "anon_tables_refused")["result"] == "unknown"
    assert result(report, "authenticated_tables_refused")["result"] == "unknown"
    assert any(u["stage"] == "anon" and "anon" in u["ask"] for u in report["incomplete"])


def test_invalid_anon_key_is_incomplete_not_a_privacy_pass():
    # a stale, rotated or disabled key is refused by the gateway: that refusal proves nothing about grants
    docs, labs, files = healthy()
    code, text, report, _ = run(FakeServer(docs, labs, files), anon="anon-key-STALE")
    assert code == 2 and report["status"] == "incomplete", text
    for name in ("anon_tables_refused", "anon_files_hidden", "anon_file_refused", "public_url_refused",
                 "authenticated_tables_refused", "authenticated_files_hidden", "authenticated_file_refused"):
        assert result(report, name)["result"] == "unknown", name
    ask = next(u for u in report["incomplete"] if u["stage"] == "anon")
    assert "401" in ask["reason"] and ask["ask"] == rc.ACCESS_ASK["anon"]
    assert "anon-key-STALE" not in text


def test_probe_without_a_permission_refusal_is_unknown():
    docs, labs, files = healthy()
    # PostgREST refused for another reason (an invalid JWT), not for missing grants
    code, _, report, _ = run(FakeServer(docs, labs, files, anon_table_answer=(401, b'{"code":"PGRST301"}')))
    assert code == 2 and result(report, "anon_tables_refused")["result"] == "unknown"
    assert any(u["stage"] == "anon" and "without a permission refusal" in u["reason"] for u in report["incomplete"])
    # a listing that is not a list, and a listing refused for a credential problem (whatever its wording)
    for answer in ((200, b'{"not":"a list"}'), (200, b"<html>"),
                   (400, b'{"error":"InvalidJWT","message":"invalid signature"}'), (400, BAD_JWS), (403, b"{}")):
        code, _, report, _ = run(FakeServer(docs, labs, files, anon_list_answer=answer))
        assert code == 2 and result(report, "anon_files_hidden")["result"] == "unknown", answer
    # the bucket itself hidden from the role is an answer given after the credential was accepted
    hidden = (400, b'{"statusCode":"404","error":"Bucket not found","message":"Bucket not found"}')
    code, _, report, _ = run(FakeServer(docs, labs, files, anon_list_answer=hidden))
    assert result(report, "anon_files_hidden")["result"] == "pass" and only_bytes_unknown(report)


def test_listing_with_a_malformed_entry_is_unknown_not_an_empty_listing():
    # a 200 list whose entries are not files or folders is unreadable: never filtered down to "nothing listed"
    docs, labs, files = healthy()
    for body in (b"[null]", b'["invalid"]', b"[1]", b'[{"id": "x"}]', b'[{"name": "", "id": null}]',
                 b'[{"name": "a", "id": 5}]', b'[{"name": "a", "id": "x", "metadata": "text"}]', b"[[]]"):
        code, text, report, _ = run(FakeServer(docs, labs, files, anon_list_answer=(200, body)))
        assert code == 2 and result(report, "anon_files_hidden")["result"] == "unknown", body
        assert any(u["stage"] == "anon" and "listing entry" in u["reason"] for u in report["incomplete"]), body
        assert_private_output(text)
    # a folder the role can see is a listed entry too: the role sees what is in the bucket
    code, _, report, _ = run(FakeServer(docs, labs, files, anon_list_answer=(200, b'[{"name": "x", "id": null}]')))
    assert code == 1 and result(report, "anon_files_hidden") == {"name": "anon_files_hidden", "result": "fail",
                                                                 "count": 1}
    # the service listing: a malformed entry makes every file check unknown, never a crash or a pass
    code, _, report, _ = run(FakeServer(docs, labs, files, extra_docs=[None]))
    assert code == 2 and result(report, "ready_documents_have_file")["result"] == "unknown"
    assert any(u["stage"] == "objects" for u in report["incomplete"])


def test_rows_that_are_not_objects_are_unreadable():
    target = rc.Target(PROD, SERVICE, transport=lambda *a: (200, b"[null]"), sleep=lambda s: None)
    try:
        target.rows("documents", "medical_documents", rc.DOC_SELECT)
        raise AssertionError("a row that is not an object must be unreadable")
    except rc.Unreadable as e:
        assert e.stage == "documents" and "not an object" in e.reason


def test_missing_or_invalid_user_token_is_an_access_ask():
    docs, labs, files = healthy()
    code, _, report, _ = run(FakeServer(docs, labs, files), user=None)
    assert code == 2 and report["status"] == "incomplete"
    assert result(report, "authenticated_tables_refused")["result"] == "unknown"
    ask = next(u for u in report["incomplete"] if u["stage"] == "authenticated")
    assert "SUPABASE_USER_ACCESS_TOKEN" in ask["ask"]
    code, text, report, _ = run(FakeServer(docs, labs, files), user="user-token-EXPIRED")
    assert code == 2 and result(report, "authenticated_files_hidden")["result"] == "unknown"
    assert next(u for u in report["incomplete"] if u["stage"] == "authenticated")["ask"] == rc.ACCESS_ASK["authenticated"]
    assert "user-token-EXPIRED" not in text


# ---------------------------------------------------------------- retry and access

def test_transient_errors_are_retried_then_pass():
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files, fail={"/rest/v1/medical_documents": [503, "network"],
                                                 f"/storage/v1/object/list/{rc.BUCKET}": [429]})
    code, _, report, sleeps = run(server)
    assert code == 2 and only_bytes_unknown(report)  # every retried read completed
    assert sleeps[:2] == [1.0, 2.0] and 1.0 in sleeps[2:]


def test_read_that_keeps_failing_is_incomplete_never_pass():
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files, fail={"/rest/v1/medical_documents": [503, 503, 503]})
    code, text, report, sleeps = run(server)
    assert code == 2 and report["status"] == "incomplete"
    assert sleeps == [1.0, 2.0]
    assert any(u["stage"] == "documents" and "HTTP 503" in u["reason"] for u in report["incomplete"])
    assert result(report, "ready_documents_have_file")["result"] == "unknown"
    assert result(report, "files_stored")["result"] == "unknown"
    assert_private_output(text)


def test_refused_read_is_not_retried_and_becomes_an_access_ask():
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files, fail={f"/storage/v1/bucket/{rc.BUCKET}": [403]})
    code, _, report, _ = run(server)
    assert code == 2
    assert sum(1 for _, _, p in server.calls if p == f"/storage/v1/bucket/{rc.BUCKET}") == 1
    ask = next(u for u in report["incomplete"] if u["stage"] == "bucket")
    assert "403" in ask["reason"] and ask["ask"] == rc.ACCESS_ASK["bucket"]
    assert result(report, "bucket_private")["result"] == "unknown"


def test_wrong_service_key_is_incomplete_with_asks():
    docs, labs, files = healthy()
    code, text, report, _ = run(FakeServer(docs, labs, files), key="not-the-key")
    assert code == 2 and report["status"] == "incomplete"
    assert {u["stage"] for u in report["incomplete"]} >= {"documents", "labs"}
    assert "not-the-key" not in text


def test_no_service_key_stops_before_any_request():
    server = FakeServer(*healthy())
    code, text, _, _ = run(server, key="")
    assert code == 2 and "service-role key" in text and server.calls == []


# ---------------------------------------------------------------- database backups

def test_missing_access_token_is_an_access_ask():
    docs, labs, files = healthy()
    code, _, report, _ = run(FakeServer(docs, labs, files), token=None)
    assert code == 2 and report["status"] == "incomplete"
    assert result(report, "database_backup_recent")["result"] == "unknown"
    ask = next(u for u in report["incomplete"] if u["stage"] == "backups")
    assert "personal access token" in ask["ask"] and "Database > Backups" in ask["ask"]


def test_stale_or_empty_backup_list_fails():
    docs, labs, files = healthy()
    real_now = datetime.now(timezone.utc)
    stale = {"pitr_enabled": False, "backups": [{"status": "COMPLETED", "inserted_at": (real_now - timedelta(hours=50)).isoformat()}]}
    code, _, report, _ = run(FakeServer(docs, labs, files, backups=stale))
    assert code == 1 and result(report, "database_backup_recent")["result"] == "fail"
    empty = {"pitr_enabled": False, "backups": [{"status": "FAILED", "inserted_at": real_now.isoformat()}]}
    code, _, report, _ = run(FakeServer(docs, labs, files, backups=empty))
    assert code == 1 and report["backups"]["completed_backups"] == 0


def test_backup_summary_keeps_dates_and_counts_only():
    s = rc.summarize_backups({
        "pitr_enabled": True, "region": "synthetic", "backups": [
            {"status": "COMPLETED", "inserted_at": "2026-01-14T03:00:00Z"},
            {"status": "COMPLETED", "inserted_at": "2026-01-10T03:00:00Z"},
            {"status": "FAILED", "inserted_at": "2026-01-15T03:00:00Z"}],
        "physical_backup_data": {"latest_physical_backup_date_unix": int(datetime(2026, 1, 15, 9, 0, tzinfo=timezone.utc).timestamp())},
    }, NOW)
    assert s == {"state": "read", "pitr_enabled": True, "completed_backups": 2, "oldest": "2026-01-10",
                 "newest": "2026-01-15T09:00+00:00", "newest_age_hours": 3.0}
    assert rc.summarize_backups(["not", "a", "dict"], NOW) == {"state": "unreadable"}


def test_fresh_pitr_point_does_not_hide_failed_daily_backups():
    # PITR off: only COMPLETED daily backups count, whatever physical_backup_data says
    latest = int(datetime(2026, 1, 15, 11, 0, tzinfo=timezone.utc).timestamp())
    s = rc.summarize_backups({"pitr_enabled": False,
                              "backups": [{"status": "FAILED", "inserted_at": "2026-01-15T03:00:00Z"}],
                              "physical_backup_data": {"latest_physical_backup_date_unix": latest}}, NOW)
    assert s["completed_backups"] == 0 and s["newest"] is None and s["newest_age_hours"] is None
    assert result(rc.evaluate(rc.Inventory(backups=s)), "database_backup_recent")["result"] == "fail"


def test_skip_backups_is_explicit_in_the_report_on_a_drill_target():
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files)
    code, _, report, _ = run(server, "--skip-backups", "--open-files", token=None, url=LOCAL)
    assert code == 0 and result(report, "database_backup_recent")["result"] == "skip"
    assert server.calls and not any(h == "api.supabase.com" for _, h, _ in server.calls)


def test_skip_backups_is_refused_on_production():
    # a production report must never read PASS without backup evidence
    server = FakeServer(*healthy())
    code, text, _, _ = run(server, "--skip-backups", token=None)
    assert code == 2 and text.startswith("refused:") and "SUPABASE_ACCESS_TOKEN" in text
    assert server.calls == [], "refused before any request"


# ---------------------------------------------------------------- the drill: never on production

def test_production_is_never_a_drill_target():
    server = FakeServer(*healthy())
    for args in (["--open-files"], ["--write-manifest", "m.json"], ["--skip-backups"],
                 ["--open-files", "--drill-project", rc.PRODUCTION_REF]):
        code, text, _, _ = run(server, *args)
        assert code == 2 and text.startswith("refused:"), args
    assert server.calls == [], "refused before any request"
    assert rc.drill_allowed(LOCAL, None) and rc.drill_allowed(DRILL, DRILL_REF)
    assert not rc.drill_allowed(DRILL, None) and not rc.drill_allowed(DRILL, "another")
    try:
        rc.Target(PROD, SERVICE, transport=server, drill=True)
        raise AssertionError("a production drill target must be refused")
    except PermissionError:
        pass
    plain = rc.Target(LOCAL, SERVICE, transport=server)
    for call in (plain.download, plain.signed_fetch):
        try:
            call(f"documents/{uid(1)}")
            raise AssertionError("files are opened on a drill target only")
        except PermissionError:
            pass


# ---------------------------------------------------------------- origins, redirects and signed links

UNKNOWN_ORIGINS = (
    "https://evil.example", "http://fewweioupmsnbccqtxdl.supabase.co", "https://fewweioupmsnbccqtxdl.supabase.co:8443",
    "https://fewweioupmsnbccqtxdl.supabase.co.evil.example", "https://user@fewweioupmsnbccqtxdl.supabase.co",
    "https://user:pw@fewweioupmsnbccqtxdl.supabase.co", "https://evil.example\\@fewweioupmsnbccqtxdl.supabase.co",
    "https://fewweioupmsnbccqtxdl.supabase.co/rest/v1", "https://fewweioupmsnbccqtxdl.supabase.co?x=1",
    "https://fewweioupmsnbccqtxdl.supabase.co#x", DRILL, "ftp://127.0.0.1", "http://127.0.0.1.evil.example:54321",
    "https://fewweioupmsnbccqtxdl.supabase.co:443", "not a url", "",
)


def test_unknown_origin_is_refused_before_any_key_is_read():
    # not a drill target is not proof of production: only the exact production origin gets its keys
    reads = []
    saved = rc._read_key
    rc._read_key = lambda *a, **k: reads.append(a) or SERVICE
    try:
        for url in UNKNOWN_ORIGINS:
            server = FakeServer(*healthy())
            for extra in ([], ["--skip-backups"], ["--open-files"]):
                out = io.StringIO()
                with Env(SUPABASE_SERVICE_ROLE_KEY=SERVICE):  # a production key sitting in the shell
                    code = rc.main(["--url", url, *extra], transport=server, sleep=lambda s: None, out=out)
                assert code == 2 and out.getvalue().startswith("refused:"), (url, extra, out.getvalue())
                assert SERVICE not in out.getvalue()
            assert server.calls == [], url
        assert reads == [], "no key was read for an unknown origin"
    finally:
        rc._read_key = saved
    assert rc.classify(PROD, None) == "production" and rc.classify(PROD + "/", None) == "production"
    assert rc.classify(PROD.upper().replace("HTTPS", "https"), None) == "production"
    assert rc.classify(LOCAL, None) == "drill" and rc.classify("http://localhost:54321", None) == "drill"
    assert rc.classify("http://[::1]:54321", None) == "drill" and rc.classify(DRILL, DRILL_REF) == "drill"
    assert rc.classify(DRILL, None) is None and rc.classify(PROD, rc.PRODUCTION_REF) == "production"
    assert rc.classify(DRILL, DRILL_REF.upper()) == "drill"  # a ref typed in capitals names the same project
    assert rc.DEFAULT_URL == PROD  # one constant, PRODUCTION_REF, names production
    for url in UNKNOWN_ORIGINS:
        assert rc.classify(url, None) is None, url


def test_drill_target_never_gets_production_credentials():
    docs, labs, files = healthy()
    # the production variables in the shell are not read for a drill target: no drill key = stop, nothing sent
    server = FakeServer(docs, labs, files)
    out = io.StringIO()
    with Env(SUPABASE_SERVICE_ROLE_KEY=SERVICE, RECOVERY_DRILL_ANON_KEY=None, RECOVERY_DRILL_USER_TOKEN=None):
        code = rc.main(["--url", LOCAL, "--skip-backups", "--open-files"], transport=server, sleep=lambda s: None,
                       out=out)
    assert code == 2 and "RECOVERY_DRILL_SERVICE_KEY" in out.getvalue() and server.calls == []
    # with a drill key but no drill user token, the production user token is never sent to the drill target
    server = FakeServer(docs, labs, files)
    out = io.StringIO()
    with Env(RECOVERY_DRILL_SERVICE_KEY=SERVICE, RECOVERY_DRILL_USER_TOKEN=None):
        code = rc.main(["--url", LOCAL, "--skip-backups", "--open-files", "--json"], transport=server,
                       sleep=lambda s: None, out=out)
    report = json.loads(out.getvalue())
    assert code == 2 and result(report, "authenticated_tables_refused")["result"] == "unknown"
    assert f"Bearer {USER}" not in server.bearers and server.calls
    # a drill key or user token that names the production project is refused before any request
    for extra in ({"RECOVERY_DRILL_SERVICE_KEY": jwt({"ref": rc.PRODUCTION_REF, "role": "service_role"})},
                  {"RECOVERY_DRILL_SERVICE_KEY": SERVICE,
                   "RECOVERY_DRILL_USER_TOKEN": jwt({"iss": f"https://{rc.PRODUCTION_REF}.supabase.co/auth/v1"})}):
        server = FakeServer(docs, labs, files)
        out = io.StringIO()
        with Env(**extra):
            code = rc.main(["--url", LOCAL, "--skip-backups", "--open-files"], transport=server, sleep=lambda s: None,
                           out=out)
        assert code == 2 and out.getvalue().startswith("refused:") and server.calls == [], extra
    assert not rc._names_production(jwt({"ref": DRILL_REF})) and not rc._names_production(SERVICE)


def test_a_request_to_another_origin_is_never_sent():
    sent = []

    def transport(*a):
        sent.append(a)
        return 200, b"{}"

    for url, origin in (("https://elsewhere.example/v1/projects", rc.MANAGEMENT_ORIGIN),
                        ("https://api.supabase.com.evil.example/v1", rc.MANAGEMENT_ORIGIN),
                        (f"{LOCAL}/rest/v1/x", rc.PRODUCTION_ORIGIN), ("http://api.supabase.com/v1", rc.MANAGEMENT_ORIGIN)):
        try:
            rc.request(transport, "backups", "GET", url, {"Authorization": f"Bearer {TOKEN}"}, origin=origin)
            raise AssertionError(url)
        except rc.Unreadable as e:
            assert "another origin" in e.reason
    assert sent == []


def test_redirects_are_never_followed():
    docs, labs, files = healthy()
    # a 3xx is unreadable, not retried and not followed (production rows; the drill's file probes and downloads)
    server = FakeServer(docs, labs, files, fail={"/rest/v1/medical_documents": [307]})
    code, _, report, sleeps = run(server)
    assert code == 2 and result(report, "ready_documents_have_file")["result"] == "unknown"
    assert any(u["stage"] == "documents" and "redirect, not followed" in u["reason"] for u in report["incomplete"])
    assert sleeps == []  # not retried
    server = FakeServer(docs, labs, files, fail={f"/storage/v1/object/{rc.BUCKET}/": [302] * 10})
    code, _, report, _ = run(server, "--skip-backups", "--open-files", url=LOCAL)
    assert code == 2 and report["status"] == "incomplete"
    for name in ("anon_file_refused", "authenticated_file_refused", "files_stored"):
        assert result(report, name)["result"] == "unknown", name
    # urllib's own opener: the one this tool uses never follows a Location header; the default one would
    class Redirecting(urllib.request.BaseHandler):
        handler_order = 100  # ahead of the real HTTP handler: no network

        def __init__(self):
            self.opened = []

        def http_open(self, req):
            self.opened.append((req.host, req.get_header("Authorization")))
            hdrs = email.message.Message()
            hdrs["Location"] = "http://elsewhere.invalid/collect"
            resp = urllib.response.addinfourl(io.BytesIO(b""), hdrs, req.full_url, 302)
            resp.msg = "Found"
            return resp

    saved = rc._OPENER
    try:
        # the control keeps urllib's default redirect handling (only the environment's proxies are left out)
        control = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        for opener, followed in ((rc._build_opener(), False), (control, True)):
            fake = Redirecting()
            opener.add_handler(fake)
            rc._OPENER = opener
            try:
                status = rc.urllib_transport("GET", "http://origin.invalid/x", {"Authorization": f"Bearer {SERVICE}"},
                                             None)[0]
            except rc.TransportError:
                status = None  # the default opener gave up after following the loop
            hosts = [h for h, _ in fake.opened]
            if followed:
                assert "elsewhere.invalid" in hosts  # the control: urllib's default does follow it
            else:
                assert status == 302 and hosts == ["origin.invalid"], hosts
    finally:
        rc._OPENER = saved
    assert any(isinstance(h, rc._NoRedirect) for h in rc._OPENER.handlers)
    assert not any(type(h) is urllib.request.HTTPRedirectHandler for h in rc._OPENER.handlers)
    assert all(h.proxies == {} for h in rc._OPENER.handlers if isinstance(h, urllib.request.ProxyHandler))


def test_signed_link_to_another_origin_or_file_is_never_fetched():
    docs, labs, files = healthy()
    other = f"documents/{uid(2)}"
    for link in (lambda o: f"https://elsewhere.example/storage/v1/object/sign/{rc.BUCKET}/{o}?token=synthetic",
                 lambda o: f"//elsewhere.example/storage/v1/object/sign/{rc.BUCKET}/{o}?token=synthetic",
                 lambda o: f"http://127.0.0.1:9999/storage/v1/object/sign/{rc.BUCKET}/{o}?token=synthetic",
                 lambda o: f"/object/sign/{rc.BUCKET}/{other}?token=synthetic",
                 lambda o: f"/object/sign/{rc.BUCKET}/{o}/../../../../rest/v1/medical_documents?token=synthetic",
                 lambda o: f"/object/sign/{rc.BUCKET}/{o}",
                 lambda o: "/../rest/v1/medical_documents?token=synthetic",
                 lambda o: None):
        server = FakeServer(docs, labs, files, signed_link=link)
        code, _, report, _ = run(server, "--skip-backups", "--open-files", url=LOCAL)
        assert code == 2 and result(report, "signed_link_serves_file")["result"] == "unknown"
        assert all(h == "127.0.0.1" for _, h, _ in server.calls), server.calls  # nothing left the drill origin
        assert not any(m == "GET" and "/object/sign/" in p for m, _, p in server.calls)  # the link was not fetched
    # the same route as an absolute URL on the target's own origin is accepted
    server = FakeServer(docs, labs, files,
                        signed_link=lambda o: f"{LOCAL}/storage/v1/object/sign/{rc.BUCKET}/{o}?token=synthetic")
    code, text, report, _ = run(server, "--skip-backups", "--open-files", url=LOCAL)
    assert code == 0 and result(report, "signed_link_serves_file")["result"] == "pass", text


def test_drill_target_never_reads_the_production_key_file():
    # the default key file holds the production key: a drill stack (whose logs may keep headers) never gets it
    server = FakeServer(*healthy())
    saved = rc.DEFAULT_KEY_FILE
    with tempfile.TemporaryDirectory() as tmp:
        prod_file = Path(tmp) / "onyx_supabase_secret"
        prod_file.write_text(SERVICE, encoding="utf-8")
        rc.DEFAULT_KEY_FILE = prod_file
        try:
            for extra in ([], ["--key-file", str(prod_file)]):
                out = io.StringIO()
                with Env():
                    code = rc.main(["--url", LOCAL, "--skip-backups", "--open-files", *extra], transport=server,
                                   sleep=lambda s: None, out=out)
                assert code == 2 and "drill stack's service key" in out.getvalue(), extra
            assert server.calls == [], "nothing was sent to the drill target"
            out = io.StringIO()
            with Env():  # on production the same file is the key
                code = rc.main(["--url", PROD], transport=server, sleep=lambda s: None, out=out)
            assert code == 2 and out.getvalue().startswith("medical records recovery check: INCOMPLETE")
            assert server.calls
        finally:
            rc.DEFAULT_KEY_FILE = saved


def test_drill_wipe_is_detected_and_full_restore_passes():
    docs, labs, files = healthy()
    with tempfile.TemporaryDirectory() as tmp:
        # 1. seed: the manifest of the synthetic store
        manifest = seed_manifest(tmp, docs, labs, files)
        raw = manifest.read_text(encoding="utf-8")
        m = json.loads(raw)
        assert m["version"] == 1 and m["documents"] == 4 and m["labs"] == 2 and len(m["objects"]) == 3
        assert len(m["document_rows"]) == 4 and len(m["lab_rows"]) == 2 and m["lab_results_linked"] == 1
        assert all(set(v) == {"storage_path", "size_bytes", "mime_type", "status", "removed"}
                   for v in m["document_rows"].values())
        assert "Synthetic title" not in raw and "Synthetic test" not in raw  # never a text column
        # 2. after the wipe, only the schema is back: everything is missing
        code, _, report, _ = run(FakeServer([], [], {}), "--skip-backups", "--manifest", str(manifest), "--open-files", url=LOCAL)
        assert code == 1
        assert result(report, "manifest_files_present") == {"name": "manifest_files_present", "result": "fail", "count": 3}
        assert result(report, "manifest_document_rows")["count"] == 4 and result(report, "manifest_lab_rows")["count"] == 2
        # 3. after the restore: every file opens, hashes match, the signed link serves the same bytes
        code, text, report, _ = run(FakeServer(docs, labs, files), "--skip-backups", "--manifest", str(manifest),
                                    "--open-files", url=LOCAL)
        assert code == 0, text
        for name in ("files_parse_as_declared_type", "manifest_hashes_match", "manifest_sizes_match",
                     "signed_link_serves_file",
                     "bucket_private", "anon_tables_refused", "authenticated_tables_refused", "files_stored",
                     "anon_file_refused", "authenticated_file_refused", "stored_sizes_match",
                     "lab_links_resolve", "manifest_document_state_match", "manifest_lab_links_match"):
            assert result(report, name)["result"] == "pass", name
        assert_private_output(text)


def test_restore_that_cleared_or_moved_a_lab_link_fails():
    docs, labs, files = healthy()
    with tempfile.TemporaryDirectory() as tmp:
        manifest = seed_manifest(tmp, docs, labs, files)
        # the link nulled, then the link pointing at another (existing) document: both still "resolve"
        for restored in ([lab(1, None), lab(2)], [lab(1, uid(2)), lab(2)]):
            code, text, report, _ = run(FakeServer(docs, restored, files), "--skip-backups", "--manifest",
                                        str(manifest), url=LOCAL)
            assert code == 1, text
            assert result(report, "manifest_lab_links_match") == {"name": "manifest_lab_links_match", "result": "fail",
                                                                  "count": 1}
            assert result(report, "lab_links_resolve")["result"] == "pass"
            assert result(report, "manifest_lab_rows")["result"] == "pass"


def test_restore_that_revived_a_removed_document_fails():
    docs, labs, files = healthy()
    with tempfile.TemporaryDirectory() as tmp:
        manifest = seed_manifest(tmp, docs, labs, files)
        revived = [doc(1), doc(2, "image/png", PNG), doc(3, status="pending"), doc(4)]  # removed_at lost
        code, text, report, _ = run(FakeServer(revived, labs, files), "--skip-backups", "--manifest", str(manifest),
                                    url=LOCAL)
        assert code == 1, text
        assert result(report, "manifest_document_state_match") == {"name": "manifest_document_state_match",
                                                                   "result": "fail", "count": 1}
        assert result(report, "manifest_document_rows")["result"] == "pass"


def test_drill_catches_corrupted_and_truncated_restores():
    docs, labs, files = healthy()
    with tempfile.TemporaryDirectory() as tmp:
        manifest = seed_manifest(tmp, docs, labs, files)
        flipped = bytearray(PDF)
        flipped[20] ^= 0x01  # same size, different bytes: only the hash can tell
        bad = dict(files)
        bad[f"documents/{uid(1)}"] = ("application/pdf", bytes(flipped))
        _, _, report, _ = run(FakeServer(docs, labs, bad), "--skip-backups", "--manifest", str(manifest), "--open-files", url=LOCAL)
        assert result(report, "manifest_hashes_match")["result"] == "fail"
        assert result(report, "files_parse_as_declared_type")["result"] == "pass"
        truncated = dict(files)
        truncated[f"documents/{uid(2)}"] = ("image/png", PNG[:-12])
        _, _, report, _ = run(FakeServer(docs, labs, truncated), "--skip-backups", "--manifest", str(manifest),
                              "--open-files", url=LOCAL)
        assert result(report, "files_parse_as_declared_type")["result"] == "fail"
        assert result(report, "manifest_sizes_match")["result"] == "fail"


def test_signed_link_serving_other_bytes_fails():
    docs, labs, files = healthy()
    code, _, report, _ = run(FakeServer(docs, labs, files, signed_bytes=b"other"), "--skip-backups", "--open-files",
                             url=DRILL)
    assert code == 2  # no --drill-project: refused
    code, _, report, _ = run(FakeServer(docs, labs, files, signed_bytes=b"other"), "--skip-backups", "--open-files",
                             "--drill-project", DRILL_REF, url=DRILL)
    assert result(report, "signed_link_serves_file")["result"] == "fail" and code == 1


def test_manifest_is_not_written_from_an_incomplete_read():
    docs, labs, files = healthy()
    with tempfile.TemporaryDirectory() as tmp:
        manifest = Path(tmp) / "m.json"
        server = FakeServer(docs, labs, files, fail={"/rest/v1/lab_results": [503, 503, 503]})
        code, text, _, _ = run(server, "--skip-backups", "--write-manifest", str(manifest), url=LOCAL)
        assert code == 2 and "refused" in text and not manifest.exists()


def test_manifest_is_not_written_from_a_failing_baseline():
    # a broken state must never become the reference a restore is judged against
    docs, labs, files = healthy()
    files[f"documents/{uid(1)}"] = ("application/pdf", PDF + b"x")  # the file's size no longer matches its row
    with tempfile.TemporaryDirectory() as tmp:
        manifest = Path(tmp) / "m.json"
        code, text, _, _ = run(FakeServer(docs, labs, files), "--skip-backups", "--write-manifest", str(manifest), url=LOCAL)
        assert code == 1 and "refused" in text and not manifest.exists()


# ---------------------------------------------------------------- files and paging

def test_parses_as_checks_the_structure_not_just_the_ends():
    assert rc.parses_as("application/pdf", PDF) and rc.parses_as("image/png", PNG) and rc.parses_as("image/jpeg", JPEG)
    # truncated, swapped, or only the start and end markers of the format
    assert not rc.parses_as("application/pdf", PDF[: len(PDF) // 2])
    assert not rc.parses_as("application/pdf", PNG) and not rc.parses_as("image/png", PDF)
    assert not rc.parses_as("application/pdf", b"%PDF-junk%%EOF")
    assert not rc.parses_as("application/pdf", b"%PDF-1.4\nstartxref\n9\n%%EOF\n")
    assert not rc.parses_as("application/pdf", PDF[:9] + b" " + PDF[9:])  # every offset now points one byte early
    assert not rc.parses_as("image/png", PNG[:-12])  # no IEND chunk
    bad_crc = bytearray(PNG)
    bad_crc[-20] ^= 0x01  # inside the pixel data: its chunk CRC no longer matches
    assert not rc.parses_as("image/png", bytes(bad_crc))
    assert not rc.parses_as("image/png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 20 + b"IEND\xaeB`\x82")
    assert not rc.parses_as("image/jpeg", JPEG[:-2])  # no end-of-image marker
    assert not rc.parses_as("image/jpeg", b"\xff\xd8\xff\xe0" + b"\x00" * 40 + b"\xff\xd9")
    chunk = b"VP8L" + (5).to_bytes(4, "little") + b"\x2f\x00\x00\x00\x00" + b"\x00"  # odd size: one pad byte
    payload = b"WEBP" + chunk
    webp = b"RIFF" + len(payload).to_bytes(4, "little") + payload
    assert rc.parses_as("image/webp", webp) and not rc.parses_as("image/webp", webp + b"extra")
    assert not rc.parses_as("image/webp", b"RIFF" + (8).to_bytes(4, "little") + b"WEBPVP8 ")  # a chunk with no size
    meta = b"\x00\x00\x00\x0cmeta" + b"\x00" * 4
    assert rc.parses_as("image/heic", b"\x00\x00\x00\x18ftypheic" + b"\x00" * 12 + meta)
    assert not rc.parses_as("image/heic", b"\x00\x00\x00\x18ftypheic" + b"\x00" * 12)  # no meta box
    assert not rc.parses_as("image/heif", b"\x00\x00\x00\x18ftypisom" + b"\x00" * 12 + meta)
    assert not rc.parses_as("application/pdf", b"") and not rc.parses_as("text/html", b"<html>")


def test_every_row_is_read_past_the_1000_row_cap():
    docs, _, files = healthy()
    labs = [lab(i) for i in range(rc.PAGE + 1)]
    server = FakeServer(docs, labs, files)
    _, _, report, _ = run(server)
    assert report["counts"]["lab_results"] == rc.PAGE + 1
    assert sum(1 for t, _ in server.selects if t == "lab_results") == 2  # service reads (the role probes are separate)


def test_write_synthetic_files_are_valid_and_made_up():
    with tempfile.TemporaryDirectory() as tmp:
        out = io.StringIO()
        assert rc.main(["--write-synthetic", tmp], transport=lambda *a: (_ for _ in ()).throw(AssertionError("no network")),
                       out=out) == 0
        written = sorted(p.name for p in Path(tmp).iterdir())
        assert written == sorted(FILES)
        for name, (mime, _) in FILES.items():
            data = (Path(tmp) / name).read_bytes()
            assert rc.parses_as(mime, data), name
        assert b"SYNTHETIC" in (Path(tmp) / "synthetic-drill-document.pdf").read_bytes()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
