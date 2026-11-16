"""Medical records recovery check (tools/medical_recovery/recovery_check.py).

Covers, against a fake Supabase (PostgREST + Storage + Management API) with SYNTHETIC rows and files:
  * a healthy store passes, prints counts only (no id, storage path, key or record text), and asks
    PostgREST for id / path / size / type / state columns only, never a text column;
  * failure-recovery: a restore that lost a file, changed a size or type, left a lab result pointing
    at a missing document, or brought back a corrupted / truncated file is a FAIL;
  * privacy / cross-user: a public bucket, a changed size cap or type list, the anon key reaching a
    table, listing a file or the public URL serving a file are each a FAIL;
  * retry: network errors and 5xx are retried with backoff and then pass; a read that keeps failing
    is INCOMPLETE (exit 2), never a pass; a 401 / 403 is not retried and becomes the exact access ask;
  * backups: no access token = incomplete with the access ask; a backup older than 36 h = fail;
    the backup summary keeps dates and counts only;
  * the drill: files are opened and a manifest written only on a local stack or a named throwaway
    project, never on production (refused before any request); a wipe is detected against the
    manifest and a full restore passes, including the signed-link fetch;
  * paging past PostgREST's 1000-row cap; placeholder files and orphans warn instead of failing.

Synthetic data only. No network, no credentials.

Run: python tests/test_medical_recovery_check.py
"""
import io
import json
import os
import sys
import tempfile
import urllib.parse
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
NOW = datetime(2026, 1, 15, 12, 0, tzinfo=timezone.utc)
FILES = rc.synthetic_files()
PDF = FILES["synthetic-drill-document.pdf"][1]
PNG = FILES["synthetic-drill-image.png"][1]
TEXT_COLUMNS = ("title", "provider", "notes", "test_name", "value_num", "value_text", "unit", "ref_text", "lab")


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
    """PostgREST, Storage and the Management API as one transport. `fail` scripts answers per path
    prefix (a status, or "network") before the normal answer."""

    def __init__(self, docs, labs, files, *, public=False, limit=rc.EXPECTED_LIMIT, types=rc.EXPECTED_TYPES,
                 anon_table=False, anon_list=False, fail=None, backups=None, extra_top=(), extra_docs=(),
                 signed_bytes=None):
        self.tables = {"medical_documents": docs, "lab_results": labs}
        self.files = dict(files)
        self.public, self.limit, self.types = public, limit, sorted(types)
        self.anon_table, self.anon_list = anon_table, anon_list
        self.fail = {k: list(v) for k, v in (fail or {}).items()}
        self.backups = backups if backups is not None else recent_backups()
        self.extra_top, self.extra_docs = list(extra_top), list(extra_docs)
        self.signed_bytes = signed_bytes
        self.calls, self.selects = [], []

    def __call__(self, method, url, headers, body, read_body=True):
        parts = urllib.parse.urlsplit(url)
        path, q = parts.path, urllib.parse.parse_qs(parts.query)
        self.calls.append((method, parts.hostname, path))
        for prefix, seq in self.fail.items():
            if path.startswith(prefix) and seq:
                v = seq.pop(0)
                if v == "network":
                    raise rc.TransportError("ConnectError")
                return v, b'{"code":"SYNTHETIC"}'
        key = headers.get("apikey")
        if parts.hostname == "api.supabase.com":
            return (200, json.dumps(self.backups).encode()) if headers.get("Authorization") == f"Bearer {TOKEN}" else (401, b"{}")
        if path.startswith("/rest/v1/"):
            table = path.rsplit("/", 1)[1]
            if key == ANON:
                return (200, b"[]") if self.anon_table else (401, b'{"code":"42501"}')
            if key != SERVICE or headers.get("Accept-Profile") != "pds":
                return 401, b"{}"
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
            if key == ANON:
                return 200, json.dumps(items[:1] if self.anon_list and req["prefix"] == "documents" else []).encode()
            if key != SERVICE:
                return 400, b"{}"
            return 200, json.dumps(items[req["offset"]:req["offset"] + req["limit"]]).encode()
        if path.startswith(f"/storage/v1/object/public/{rc.BUCKET}/"):
            return (200, b"") if self.public else (400, b"{}")
        if path.startswith(f"/storage/v1/object/sign/{rc.BUCKET}/"):
            obj = urllib.parse.unquote(path.split(f"/object/sign/{rc.BUCKET}/", 1)[1])
            if method == "POST":
                if key != SERVICE or obj not in self.files:
                    return 400, b"{}"
                return 200, json.dumps({"signedURL": f"/object/sign/{rc.BUCKET}/{obj}?token=synthetic"}).encode()
            if q.get("token") != ["synthetic"] or obj not in self.files:
                return 400, b"{}"
            return 200, self.signed_bytes if self.signed_bytes is not None else self.files[obj][1]
        if path.startswith(f"/storage/v1/object/{rc.BUCKET}/"):
            obj = urllib.parse.unquote(path.split(f"/object/{rc.BUCKET}/", 1)[1])
            if key != SERVICE or obj not in self.files:
                return 400, b"{}"
            return 200, self.files[obj][1]
        return 404, b"{}"

    def _listing(self, prefix):
        if prefix == "":
            return [{"name": "documents", "id": None, "metadata": None}] + self.extra_top
        docs = [{"name": p.split("/", 1)[1], "id": f"obj-{i}", "metadata": {"size": len(data), "mimetype": mime}}
                for i, (p, (mime, data)) in enumerate(sorted(self.files.items()))]
        return docs + self.extra_docs


class Env:
    """Set the anon key / access token for one main() call (offline runs strip SUPABASE_* vars)."""

    def __init__(self, anon=ANON, token=TOKEN):
        self.values = {"SUPABASE_ANON_KEY": anon, "SUPABASE_ACCESS_TOKEN": token, "SUPABASE_SERVICE_ROLE_KEY": None,
                       "NEXT_PUBLIC_SUPABASE_ANON_KEY": None, "SUPABASE_URL": None}

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


def run(server, *args, url=PROD, anon=ANON, token=TOKEN, key=SERVICE):
    """main() with the fake server; answers (exit code, printed text, JSON report or None, sleeps)."""
    sleeps = []
    with tempfile.TemporaryDirectory() as tmp:
        key_file = Path(tmp) / "key"
        key_file.write_text(key or "", encoding="utf-8")
        out = io.StringIO()
        with Env(anon=anon, token=token):
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


def assert_private_output(text):
    for secret in (SERVICE, ANON, TOKEN, "Synthetic title", "synthetic note", "Synthetic test", "documents/", uid(1)):
        assert secret not in text, secret


# ---------------------------------------------------------------- healthy store, counts only

def test_healthy_store_passes_with_counts_only():
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files, backups=recent_backups(hours_ago=5))
    code, text, report, _ = run(server)
    assert code == 0, text
    assert report["status"] == "pass"
    assert report["counts"]["documents"] == 4 and report["counts"]["documents_ready"] == 3
    assert report["counts"]["files"] == 3 and report["counts"]["lab_results_linked"] == 1
    assert report["backups"]["state"] == "read" and report["backups"]["completed_backups"] == 7
    assert result(report, "public_url_refused")["result"] == "pass"
    assert_private_output(text)
    # only ids, paths, sizes, types and states are ever requested
    assert server.selects and all(not any(c in sel.split(",") for c in TEXT_COLUMNS) for _, sel in server.selects)
    assert ("medical_documents", rc.DOC_SELECT) in server.selects and ("lab_results", rc.LAB_SELECT) in server.selects
    # read-only: nothing but GET / list / sign-free reads on production
    assert all(m == "GET" or p.endswith(f"/object/list/{rc.BUCKET}") for m, _, p in server.calls), server.calls


def test_human_output_is_counts_only_too():
    docs, labs, files = healthy()
    out = io.StringIO()
    with tempfile.TemporaryDirectory() as tmp, Env():
        kf = Path(tmp) / "k"
        kf.write_text(SERVICE, encoding="utf-8")
        code = rc.main(["--url", PROD, "--key-file", str(kf)], transport=FakeServer(docs, labs, files),
                       sleep=lambda s: None, out=out)
    assert code == 0
    assert out.getvalue().startswith("medical records recovery check: PASS")
    assert_private_output(out.getvalue())


# ---------------------------------------------------------------- failure recovery

def test_restore_that_lost_a_file_fails():
    docs, labs, files = healthy()
    files.pop(f"documents/{uid(2)}")
    code, text, report, _ = run(FakeServer(docs, labs, files))
    assert code == 1 and report["status"] == "fail"
    assert result(report, "ready_documents_have_file") == {"name": "ready_documents_have_file", "result": "fail", "count": 1}
    assert_private_output(text)


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


def test_lab_result_pointing_at_a_missing_document_fails():
    docs, labs, files = healthy()
    labs.append(lab(3, uid(99)))
    _, _, report, _ = run(FakeServer(docs, labs, files))
    assert result(report, "lab_links_resolve") == {"name": "lab_links_resolve", "result": "fail", "count": 1}


def test_link_to_a_removed_document_only_warns():
    docs, labs, files = healthy()
    labs.append(lab(4, uid(4)))
    code, _, report, _ = run(FakeServer(docs, labs, files))
    assert result(report, "lab_links_live")["result"] == "warn" and code == 0


def test_placeholders_and_orphans_warn_but_do_not_fail():
    docs, labs, files = healthy()
    files[f"documents/{uid(50)}"] = ("application/pdf", PDF)  # a file with no row
    server = FakeServer(docs, labs, files, extra_top=[{"name": "stray.pdf", "id": "x", "metadata": {}}],
                        extra_docs=[{"name": ".emptyFolderPlaceholder", "id": "y", "metadata": {"size": 0}}])
    code, _, report, _ = run(server)
    assert code == 0 and report["status"] == "pass"
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


def test_missing_anon_key_is_incomplete_not_pass():
    docs, labs, files = healthy()
    code, _, report, _ = run(FakeServer(docs, labs, files), anon=None)
    assert code == 2 and report["status"] == "incomplete"
    assert result(report, "anon_tables_refused")["result"] == "unknown"
    assert any(u["stage"] == "anon" and "anon" in u["ask"] for u in report["incomplete"])


# ---------------------------------------------------------------- retry and access

def test_transient_errors_are_retried_then_pass():
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files, fail={"/rest/v1/medical_documents": [503, "network"],
                                                 f"/storage/v1/object/list/{rc.BUCKET}": [429]})
    code, _, report, sleeps = run(server)
    assert code == 0 and report["status"] == "pass"
    assert sleeps[:2] == [1.0, 2.0] and 1.0 in sleeps[2:]


def test_read_that_keeps_failing_is_incomplete_never_pass():
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files, fail={"/rest/v1/medical_documents": [503, 503, 503]})
    code, text, report, sleeps = run(server)
    assert code == 2 and report["status"] == "incomplete"
    assert sleeps == [1.0, 2.0]
    assert any(u["stage"] == "documents" and "HTTP 503" in u["reason"] for u in report["incomplete"])
    assert result(report, "ready_documents_have_file")["result"] == "unknown"
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


def test_skip_backups_is_explicit_in_the_report():
    docs, labs, files = healthy()
    server = FakeServer(docs, labs, files)
    code, _, report, _ = run(server, "--skip-backups", token=None)
    assert code == 0 and result(report, "database_backup_recent")["result"] == "skip"
    assert server.calls and not any(h == "api.supabase.com" for _, h, _ in server.calls)


# ---------------------------------------------------------------- the drill: never on production

def test_production_is_never_a_drill_target():
    server = FakeServer(*healthy())
    for args in (["--open-files"], ["--write-manifest", "m.json"],
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


def test_drill_wipe_is_detected_and_full_restore_passes():
    docs, labs, files = healthy()
    with tempfile.TemporaryDirectory() as tmp:
        manifest = Path(tmp) / "drill-manifest.json"
        # 1. seed: the manifest of the synthetic store
        code, _, report, _ = run(FakeServer(docs, labs, files), "--skip-backups", "--write-manifest", str(manifest), url=LOCAL)
        assert code == 0, report
        m = json.loads(manifest.read_text(encoding="utf-8"))
        assert m["version"] == 1 and m["documents"] == 4 and m["labs"] == 2 and len(m["objects"]) == 3
        # 2. after the wipe, only the schema is back: everything is missing
        code, _, report, _ = run(FakeServer([], [], {}), "--skip-backups", "--manifest", str(manifest), "--open-files", url=LOCAL)
        assert code == 1
        assert result(report, "manifest_files_present") == {"name": "manifest_files_present", "result": "fail", "count": 3}
        assert result(report, "manifest_document_rows")["count"] == 4 and result(report, "manifest_lab_rows")["count"] == 2
        # 3. after the restore: every file opens, hashes match, the signed link serves the same bytes
        code, text, report, _ = run(FakeServer(docs, labs, files), "--skip-backups", "--manifest", str(manifest),
                                    "--open-files", url=LOCAL)
        assert code == 0, text
        for name in ("files_open", "manifest_hashes_match", "manifest_sizes_match", "signed_link_serves_file",
                     "bucket_private", "anon_tables_refused", "lab_links_resolve"):
            assert result(report, name)["result"] == "pass", name
        assert_private_output(text)


def test_drill_catches_corrupted_and_truncated_restores():
    docs, labs, files = healthy()
    with tempfile.TemporaryDirectory() as tmp:
        manifest = Path(tmp) / "m.json"
        run(FakeServer(docs, labs, files), "--skip-backups", "--write-manifest", str(manifest), url=LOCAL)
        flipped = bytearray(PDF)
        flipped[20] ^= 0x01  # same size, different bytes: only the hash can tell
        bad = dict(files)
        bad[f"documents/{uid(1)}"] = ("application/pdf", bytes(flipped))
        _, _, report, _ = run(FakeServer(docs, labs, bad), "--skip-backups", "--manifest", str(manifest), "--open-files", url=LOCAL)
        assert result(report, "manifest_hashes_match")["result"] == "fail"
        assert result(report, "files_open")["result"] == "pass"
        truncated = dict(files)
        truncated[f"documents/{uid(2)}"] = ("image/png", PNG[:-12])
        _, _, report, _ = run(FakeServer(docs, labs, truncated), "--skip-backups", "--manifest", str(manifest),
                              "--open-files", url=LOCAL)
        assert result(report, "files_open")["result"] == "fail"
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


# ---------------------------------------------------------------- files and paging

def test_opens_as_checks_header_and_end():
    assert rc.opens_as("application/pdf", PDF) and rc.opens_as("image/png", PNG)
    assert not rc.opens_as("application/pdf", PDF[: len(PDF) // 2])
    assert not rc.opens_as("application/pdf", PNG) and not rc.opens_as("image/png", PDF)
    assert rc.opens_as("image/jpeg", b"\xff\xd8\xff\xe0" + b"\x00" * 40 + b"\xff\xd9")
    assert not rc.opens_as("image/jpeg", b"\xff\xd8\xff\xe0" + b"\x00" * 200)
    webp = b"RIFF" + (12).to_bytes(4, "little") + b"WEBP" + b"VP8 "
    assert rc.opens_as("image/webp", webp) and not rc.opens_as("image/webp", webp + b"extra")
    assert rc.opens_as("image/heic", b"\x00\x00\x00\x18ftypheic" + b"\x00" * 12)
    assert not rc.opens_as("image/heif", b"\x00\x00\x00\x18ftypisom" + b"\x00" * 12)
    assert not rc.opens_as("application/pdf", b"") and not rc.opens_as("text/html", b"<html>")


def test_every_row_is_read_past_the_1000_row_cap():
    docs, _, files = healthy()
    labs = [lab(i) for i in range(rc.PAGE + 1)]
    server = FakeServer(docs, labs, files)
    _, _, report, _ = run(server)
    assert report["counts"]["lab_results"] == rc.PAGE + 1
    assert sum(1 for t, _ in server.selects if t == "lab_results") == 2  # service reads (the anon probe is separate)


def test_write_synthetic_files_are_valid_and_made_up():
    with tempfile.TemporaryDirectory() as tmp:
        out = io.StringIO()
        assert rc.main(["--write-synthetic", tmp], transport=lambda *a: (_ for _ in ()).throw(AssertionError("no network")),
                       out=out) == 0
        written = sorted(p.name for p in Path(tmp).iterdir())
        assert written == sorted(FILES)
        for name, (mime, _) in FILES.items():
            data = (Path(tmp) / name).read_bytes()
            assert rc.opens_as(mime, data), name
        assert b"SYNTHETIC" in (Path(tmp) / "synthetic-drill-document.pdf").read_bytes()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
