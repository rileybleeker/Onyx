"""Encrypted off-site backup of /health/records and its restore drill (tools/medical_recovery/offsite_backup.py).

Against a fake Supabase (PostgREST + Storage) with SYNTHETIC rows and files and a fake cipher (a reversible
byte transform standing in for age, so no age binary is needed). Every text column carries the marker "LEAK"
and every file the marker "SYNTHETIC"; the privacy tests fail if either reaches the backup folder in the clear,
the temporary folder, the printed output or the heartbeat. Covers:
  * a healthy run writes ONE ciphertext into the backup folder and nothing else anywhere, leaves no temporary
    file, and writes one count-free heartbeat (records 0, no error); the drill decrypts it into an isolated
    folder, every check passes (tables, rows, files and hashes, lab links, the recovery manifest) and the
    decrypted copy is removed;
  * failure recovery: a file missing from the listing or from storage, a size that differs, a read that keeps
    failing are a PARTIAL run (written, flagged, no pruning, no recovery manifest); a refused read, a failed
    encryption, a crash are a FAILED run with nothing in the backup folder and a failed heartbeat;
  * retry: a file answered 503 twice is fetched on the third try (1 s, 2 s backoff);
  * refusals before anything is sent: another origin, no public recipient, the private key given as the
    recipient, no age tool; a drill target needs its own --dest and its own key and writes no heartbeat;
  * tables: paging in primary-key order, a table the schema does not know is listed as missing (not a
    failure), credentials and the trial seed / schedule are never requested;
  * retention: newest 8 plus the first of each of the 3 latest months; only this job's names are removed,
    and only after a fully successful run;
  * the drill fails on a changed file, a member outside the pack's names (never extracted), a ciphertext that
    does not decrypt, and refuses a folder in the repo or under OneDrive; the decrypted copy is always removed.

Run: python tests/test_medical_offsite_backup.py
"""
import io
import json
import os
import sys
import tarfile
import tempfile
import unittest
import urllib.parse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "medical_recovery"))

import offsite_backup as ob  # noqa: E402
import recovery_check as rc  # noqa: E402

RECIPIENT = "age1" + "q" * 58
NOW = datetime(2026, 11, 22, 16, 10, tzinfo=timezone.utc)
DOC_A = "11111111-1111-4111-8111-111111111111"
DOC_B = "22222222-2222-4222-8222-222222222222"
DOC_C = "33333333-3333-4333-8333-333333333333"  # pending upload: no file required
LAB_1 = "44444444-4444-4444-8444-444444444444"
LAB_2 = "55555555-5555-4555-8555-555555555555"
FILES = rc.synthetic_files()  # {name: (mime, bytes)}: made-up PDF and PNG
PDF = FILES["synthetic-drill-document.pdf"][1] + b"\n% SYNTHETIC LEAK marker\n"
PNG = FILES["synthetic-drill-image.png"][1]


def docs():
    return [
        {"id": DOC_A, "title": "LEAK title A", "notes": "LEAK note", "storage_path": f"documents/{DOC_A}",
         "mime_type": "application/pdf", "size_bytes": len(PDF), "status": "ready", "removed_at": None},
        {"id": DOC_B, "title": "LEAK title B", "notes": None, "storage_path": f"documents/{DOC_B}",
         "mime_type": "image/png", "size_bytes": len(PNG), "status": "ready", "removed_at": "2026-11-01T00:00:00Z"},
        {"id": DOC_C, "title": "LEAK pending", "notes": None, "storage_path": f"documents/{DOC_C}",
         "mime_type": "image/png", "size_bytes": 10, "status": "pending", "removed_at": None},
    ]


def labs():
    return [{"id": LAB_1, "test_name": "LEAK test", "value_num": 1.5, "document_id": DOC_A, "removed_at": None},
            {"id": LAB_2, "test_name": "LEAK other", "value_text": "LEAK", "document_id": None, "removed_at": None}]


class FakeSupabase:
    """PostgREST (pds tables + the OpenAPI root) and Storage (listing + download) for one project."""

    def __init__(self):
        self.tables = {"medical_documents": docs(), "lab_results": labs(),
                       "weight_log": [{"log_date": f"2026-01-{d:02d}", "weight_kg": 80.0, "note": "LEAK"} for d in range(1, 4)]}
        self.pk = {"medical_documents": ["id"], "lab_results": ["id"], "weight_log": ["log_date"]}
        self.files = {f"documents/{DOC_A}": (PDF, "application/pdf"), f"documents/{DOC_B}": (PNG, "image/png")}
        self.unlisted: set = set()      # in storage, not in the listing
        self.bytes_gone: set = set()    # in the listing, download answers not found
        self.wrong_size: set = set()    # the listing says one byte more than the file has
        self.flaky: dict = {}           # path or table -> how many 503 answers before a good one
        self.always_500: set = set()    # paths or tables that never answer
        self.denied = False
        self.calls: list = []

    def spec(self):
        defs = {}
        for t, rows in self.tables.items():
            cols = sorted({k for r in rows for k in r} | set(self.pk.get(t, [])))
            defs[t] = {"properties": {c: {"format": "text", **({"description": "Note:\nThis is a Primary Key.<pk/>"}
                                                              if c in self.pk.get(t, []) else {})} for c in cols}}
        return {"swagger": "2.0", "definitions": defs}

    def _flake(self, key):
        if key in self.always_500:
            return True
        if self.flaky.get(key):
            self.flaky[key] -= 1
            return True
        return False

    def __call__(self, method, url, headers, body, read_body=True):
        self.calls.append((method, url, dict(headers)))
        if self.denied:
            return 401, b'{"message":"denied"}', {}
        parts = urllib.parse.urlsplit(url)
        q = dict(urllib.parse.parse_qsl(parts.query))
        path = parts.path
        if path == "/rest/v1/":
            return 200, json.dumps(self.spec()).encode(), {}
        if path.startswith("/rest/v1/"):
            table = path[len("/rest/v1/"):]
            if self._flake(table):
                return 503, b"{}", {}
            if table not in self.tables:
                return 404, json.dumps({"code": "PGRST205", "message": "LEAK"}).encode(), {}
            rows = list(self.tables[table])
            key = [c.split(".")[0] for c in q.get("order", "").split(",") if c]
            rows.sort(key=lambda r: tuple(str(r.get(c)) for c in key))
            off, lim = int(q.get("offset", 0)), int(q.get("limit", 1000))
            return 200, json.dumps(rows[off:off + lim]).encode(), {}
        if path == f"/storage/v1/object/list/{rc.BUCKET}":
            req = json.loads(body.decode())
            if req["prefix"] == "":
                entries = [{"name": "documents", "id": None, "metadata": None}]
            else:
                entries = [{"name": p.split("/", 1)[1], "id": "obj-" + p[-4:],
                            "metadata": {"size": len(b) + (1 if p in self.wrong_size else 0), "mimetype": m}}
                           for p, (b, m) in sorted(self.files.items()) if p not in self.unlisted]
            return 200, json.dumps(entries[req["offset"]:req["offset"] + req["limit"]]).encode(), {}
        prefix = f"/storage/v1/object/{rc.BUCKET}/"
        if path.startswith(prefix):
            p = urllib.parse.unquote(path[len(prefix):])
            if self._flake(p):
                return 503, b"{}", {}
            if p in self.bytes_gone or p not in self.files:
                return 400, json.dumps({"statusCode": "404", "error": "not_found"}).encode(), {}
            return 200, self.files[p][0], {}
        return 418, b"{}", {}


class FakeCipher:
    """Stands in for age: a reversible byte transform, so the stored bytes never hold the plaintext."""
    MAGIC = b"FAKE-AGE-1\n"

    def __init__(self, fail_on_close=False, fail_on_decrypt=False):
        self.fail_on_close, self.fail_on_decrypt = fail_on_close, fail_on_decrypt

    @staticmethod
    def flip(data: bytes) -> bytes:
        return bytes(b ^ 0x5A for b in data)

    @contextmanager
    def encrypt_to(self, recipient, out_path):
        buf = io.BytesIO()
        yield buf
        if self.fail_on_close:
            raise ob.CipherError("encrypt_failed")
        Path(out_path).write_bytes(self.MAGIC + recipient.encode() + b"\n" + self.flip(buf.getvalue()))

    @contextmanager
    def decrypt_from(self, identity, in_path):
        raw = Path(in_path).read_bytes()
        if self.fail_on_decrypt or not raw.startswith(self.MAGIC):
            raise ob.CipherError("decrypt_failed")
        _, rest = raw[len(self.MAGIC):].split(b"\n", 1)
        yield io.BytesIO(self.flip(rest))

    def reseal(self, path: Path, tar_bytes: bytes):
        Path(path).write_bytes(self.MAGIC + RECIPIENT.encode() + b"\n" + self.flip(tar_bytes))

    def open_plain(self, path: Path) -> bytes:
        with self.decrypt_from(None, path) as s:
            return s.read()


class FakeClient:
    """The supabase-py shape sync_log_helper.log_sync uses."""

    def __init__(self):
        self.rows = []

    def schema(self, _):
        return self

    def table(self, name):
        self._t = name
        return self

    def insert(self, row):
        self.rows.append((self._t, row))
        return self

    def execute(self):
        return None


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="onyx-backup-test-"))
        self.dest = self.tmp / "dest"
        self.local = self.tmp / "local"
        self.rfile = self.tmp / "recipient.txt"
        self.rfile.write_text(f"# public key\n{RECIPIENT}\n", encoding="utf-8")
        self.identity = self.tmp / "identity.txt"
        self.identity.write_text("FAKE identity\n", encoding="utf-8")
        self.env = mock.patch.dict(os.environ, {"LOCALAPPDATA": str(self.local), "SUPABASE_SERVICE_ROLE_KEY": "fake-service",
                                                "SUPABASE_URL": "", "RECOVERY_DRILL_SERVICE_KEY": ""})
        self.env.start()
        self.sb = FakeSupabase()
        self.client = FakeClient()
        self.sleeps = []
        self.cipher = FakeCipher()
        self.addCleanup(lambda: ob.setup_logging.__globals__["log"].handlers.clear())

    def tearDown(self):
        self.env.stop()
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def backup(self, *extra, cipher="default"):
        out = io.StringIO()
        c = self.cipher if cipher == "default" else cipher
        code = ob.main(["backup", "--recipient-file", str(self.rfile), "--dest", str(self.dest), *extra],
                       transport=self.sb, sleep=self.sleeps.append, cipher_factory=lambda: c,
                       heartbeat_client=self.client, out=out)
        return code, out.getvalue()

    def written(self):
        return sorted(p for p in self.dest.iterdir()) if self.dest.is_dir() else []

    def heartbeats(self):
        return [r for t, r in self.client.rows if t == "sync_log"]

    def assert_no_plaintext_on_disk(self):
        for p in list(self.dest.rglob("*")) + list(self.local.rglob("*")):
            if p.is_file():
                data = p.read_bytes()
                for marker in (b"SYNTHETIC", b"LEAK", DOC_A.encode(), b"documents/"):
                    self.assertNotIn(marker, data, f"plaintext on disk in {p.name}")


class HappyPath(Base):
    def test_one_ciphertext_count_free_heartbeat_and_a_passing_drill(self):
        code, out = self.backup()
        self.assertEqual(code, 0, out)
        files = self.written()
        self.assertEqual(len(files), 1)
        self.assertRegex(files[0].name, ob.NAME_RE)
        self.assert_no_plaintext_on_disk()
        self.assertEqual([p for p in ob.tmp_dir().iterdir() if p.name != ".lock"], [], "no temporary file is left")
        for marker in ("LEAK", DOC_A, "documents/", "fake-service", RECIPIENT):
            self.assertNotIn(marker, out)
        hb = self.heartbeats()
        self.assertEqual(len(hb), 1)
        self.assertEqual((hb[0]["source"], hb[0]["data_type"], hb[0]["status"]), ("backup", "medical_records", "success"))
        self.assertEqual(hb[0]["records_synced"], 0, "the heartbeat carries no counts")
        self.assertIsNone(hb[0].get("error_message"))

        plain = self.cipher.open_plain(files[0])
        with tarfile.open(fileobj=io.BytesIO(plain)) as tar:
            names = tar.getnames()
        self.assertEqual(names[-1], "manifest.json", "the manifest is written last")
        self.assertIn("recovery-manifest.json", names)
        self.assertIn(f"objects/documents/{DOC_A}", names)

        report = ob.run_drill(dest=self.dest, identity=self.identity, cipher=self.cipher, root=self.tmp / "drill", now=NOW)
        self.assertEqual(report.status, "pass", report.as_dict())
        self.assertTrue(all(v is True for v in report.checks.values()), report.checks)
        self.assertEqual(report.counts["documents"], 3)
        self.assertEqual(report.counts["lab_results"], 2)
        self.assertEqual(report.counts["files"], 2)
        self.assertEqual(list((self.tmp / "drill").iterdir()), [], "the decrypted copy is removed")
        self.assertNotIn("LEAK", json.dumps(report.as_dict()))

    def test_the_private_key_is_never_read_by_the_backup(self):
        key = self.tmp / ".onyx_backup_age_key"
        key.write_text("AGE-SECRET-KEY-1FAKE\n", encoding="utf-8")
        real_text, real_bytes, real_open = Path.read_text, Path.read_bytes, Path.open

        def guard(fn):
            def wrapped(p, *a, **k):
                self.assertNotEqual(Path(p).name, key.name, "the backup opened the private key file")
                return fn(p, *a, **k)
            return wrapped

        with mock.patch.object(ob, "DEFAULT_IDENTITY_FILE", key), \
                mock.patch.object(Path, "read_text", guard(real_text)), \
                mock.patch.object(Path, "read_bytes", guard(real_bytes)), \
                mock.patch.object(Path, "open", guard(real_open)):
            code, _ = self.backup()
        self.assertEqual(code, 0)

    def test_the_log_holds_counts_and_codes_only(self):
        with self.assertLogs("medical_backup", "INFO") as cm:
            self.backup()
        text = "\n".join(cm.output)
        for marker in ("LEAK", DOC_A, "documents/", "fake-service", RECIPIENT):
            self.assertNotIn(marker, text)

    def test_dry_run_writes_nothing_and_no_heartbeat(self):
        code, out = self.backup("--dry-run", cipher=None)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.written(), [])
        self.assertEqual(self.heartbeats(), [])
        self.assertIn("DRY RUN", out)


class PartialRuns(Base):
    def check_partial(self, code_name):
        code, out = self.backup()
        self.assertEqual(code, 2, out)
        self.assertEqual(len(self.written()), 1, "a partial backup is still written")
        hb = self.heartbeats()
        self.assertEqual((hb[0]["status"], hb[0]["error_message"], hb[0]["records_synced"]), ("partial", code_name, 0))
        self.assert_no_plaintext_on_disk()
        plain = self.cipher.open_plain(self.written()[0])
        with tarfile.open(fileobj=io.BytesIO(plain)) as tar:
            return tar.getnames()

    def test_file_missing_from_listing(self):
        self.sb.unlisted.add(f"documents/{DOC_A}")
        names = self.check_partial("files_missing")
        self.assertNotIn("recovery-manifest.json", names, "a partial copy is no reference for a restore")
        report = ob.run_drill(dest=self.dest, identity=self.identity, cipher=self.cipher, root=self.tmp / "drill")
        self.assertIsNone(report.checks["recovery_manifest_valid"])
        self.assertFalse(report.checks["medical_links_hold"], "a ready document without its file")
        self.assertEqual(report.status, "fail")

    def test_bytes_gone_from_storage(self):
        self.sb.bytes_gone.add(f"documents/{DOC_B}")
        self.check_partial("files_missing")

    def test_size_differs(self):
        self.sb.wrong_size.add(f"documents/{DOC_A}")
        self.check_partial("size_mismatch")

    def test_a_file_that_never_answers(self):
        self.sb.always_500.add(f"documents/{DOC_A}")
        self.check_partial("files_unread")
        self.assertEqual(self.sleeps.count(1.0), 1)

    def test_partial_runs_never_prune(self):
        self.dest.mkdir()
        old = [self.dest / f"onyx-backup-2025{m:02d}01T000000Z.tar.age" for m in range(1, 13)]
        for p in old:
            p.write_bytes(b"x")
        self.sb.unlisted.add(f"documents/{DOC_A}")
        self.backup()
        self.assertTrue(all(p.exists() for p in old))

    def test_unreadable_rebuild_table_is_partial_and_missing_table_is_not(self):
        self.sb.always_500.add("weight_log")
        self.check_partial("rebuild_table_unreadable")

    def test_missing_rebuild_table_is_listed_not_failed(self):
        code, out = self.backup()
        self.assertEqual(code, 0, out)
        plain = self.cipher.open_plain(self.written()[0])
        with tarfile.open(fileobj=io.BytesIO(plain)) as tar:
            manifest = json.loads(tar.extractfile("manifest.json").read())
        self.assertIn("habit_journal", manifest["missing_tables"], "not in this fake schema")
        self.assertEqual(manifest["tables"]["weight_log"]["rows"], 3)


class Retry(Base):
    def test_503_twice_then_ok(self):
        self.sb.flaky[f"documents/{DOC_A}"] = 2
        code, out = self.backup()
        self.assertEqual(code, 0, out)
        self.assertEqual(self.sleeps[:2], [1.0, 2.0])
        self.assertEqual(self.heartbeats()[0]["status"], "success")


class FailedRuns(Base):
    def check_failed(self, code_name, *extra, cipher="default", calls_allowed=True):
        code, out = self.backup(*extra, cipher=cipher)
        self.assertEqual(code, 1, out)
        self.assertEqual(self.written(), [], "nothing reaches the backup folder")
        if ob.tmp_dir().exists():
            self.assertEqual([p for p in ob.tmp_dir().iterdir() if p.name != ".lock"], [])
        hb = self.heartbeats()
        self.assertEqual(len(hb), 1)
        self.assertEqual((hb[0]["status"], hb[0]["error_message"], hb[0]["records_synced"]), ("failed", code_name, 0))
        if not calls_allowed:
            self.assertEqual(self.sb.calls, [], "refused before any request")
        self.assertNotIn("LEAK", out)

    def test_refused_read(self):
        self.sb.denied = True
        self.check_failed("read_denied")

    def test_medical_table_read_keeps_failing(self):
        self.sb.always_500.add("lab_results")
        self.check_failed("read_failed_lab_results")

    def test_encryption_fails(self):
        self.check_failed("encrypt_failed", cipher=FakeCipher(fail_on_close=True))

    def test_no_recipient(self):
        self.rfile.unlink()
        self.check_failed("recipient_missing", calls_allowed=False)

    def test_private_key_given_as_recipient(self):
        self.rfile.write_text("# created\nAGE-SECRET-KEY-1" + "Q" * 58 + "\n", encoding="utf-8")
        self.check_failed("recipient_invalid", calls_allowed=False)

    def test_no_age_tool(self):
        self.check_failed("age_missing", cipher=None, calls_allowed=False)

    def test_no_service_key(self):
        with mock.patch.dict(os.environ, {"SUPABASE_SERVICE_ROLE_KEY": ""}), \
                mock.patch.object(rc, "DEFAULT_KEY_FILE", self.tmp / "absent"):
            self.check_failed("key_missing", "--key-file", str(self.tmp / "absent"), calls_allowed=False)

    def test_crash_still_writes_its_heartbeat(self):
        def boom(*a, **k):
            raise RuntimeError("LEAK detail")
        self.sb.__class__ = type("Boom", (FakeSupabase,), {"__call__": boom})
        self.check_failed("crash_RuntimeError")

    def test_dest_inside_the_repo_is_refused(self):
        code, out = ob.main(["backup", "--recipient-file", str(self.rfile), "--dest", str(ROOT / "analysis_output" / "x")],
                            transport=self.sb, sleep=self.sleeps.append, cipher_factory=lambda: self.cipher,
                            heartbeat_client=self.client, out=io.StringIO()), None
        self.assertEqual(code, 1)
        self.assertEqual(self.heartbeats()[0]["error_message"], "dest_in_repo")
        self.assertFalse((ROOT / "analysis_output" / "x").exists())


class Targets(Base):
    def test_another_origin_is_refused_with_nothing_sent(self):
        code, out = self.backup("--url", "https://example.com")
        self.assertEqual(code, 1)
        self.assertEqual(self.sb.calls, [])
        self.assertEqual(self.heartbeats(), [])

    def test_drill_target_needs_its_own_dest_and_key_and_writes_no_heartbeat(self):
        out = io.StringIO()
        code = ob.main(["backup", "--url", "http://127.0.0.1:54321", "--recipient-file", str(self.rfile)],
                       transport=self.sb, cipher_factory=lambda: self.cipher, heartbeat_client=self.client, out=out)
        self.assertEqual(code, 1)
        self.assertEqual(self.sb.calls, [])
        with mock.patch.dict(os.environ, {"RECOVERY_DRILL_SERVICE_KEY": "drill-service"}):
            code, out = self.backup("--url", "http://127.0.0.1:54321")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.heartbeats(), [], "a drill target writes no heartbeat")
        sent = {h.get("apikey") for _, _, h in self.sb.calls}
        self.assertEqual(sent, {"drill-service"}, "the production key never goes to a drill target")


class Tables(Base):
    def test_paging_in_primary_key_order(self):
        self.sb.tables["weight_log"] = [{"log_date": f"2020-{i:05d}", "note": "LEAK"} for i in range(2500)][::-1]
        code, out = self.backup()
        self.assertEqual(code, 0, out)
        urls = [u for _, u, _ in self.sb.calls if "/rest/v1/weight_log" in u]
        self.assertEqual(len(urls), 3)
        self.assertTrue(all("order=log_date.asc" in u for u in urls))
        plain = self.cipher.open_plain(self.written()[0])
        with tarfile.open(fileobj=io.BytesIO(plain)) as tar:
            rows = json.loads(tar.extractfile("tables/pds/weight_log.json").read())
        self.assertEqual(len(rows), 2500)
        self.assertEqual(len({r["log_date"] for r in rows}), 2500)

    def test_credentials_and_trial_secrets_are_never_requested(self):
        self.backup()
        for _, url, _ in self.sb.calls:
            for t in ob.EXCLUDED_TABLES:
                self.assertNotIn(f"/rest/v1/{t}", url)
        with self.assertRaises(ValueError):
            ob.read_table(rc.Target(rc.DEFAULT_URL, "k", transport=self.sb), "ci_tokens", "id.asc")

    def test_table_order(self):
        spec = {"definitions": {"t": {"properties": {"a": {"description": "x <pk/>"}, "b": {"description": "<pk/>"}, "c": {}}},
                                "u": {"properties": {"id": {}, "x": {}}},
                                "v": {"properties": {"n": {"format": "text"}, "j": {"format": "jsonb"}}}}}
        self.assertEqual(ob.table_order(spec, "t"), "a.asc,b.asc")
        self.assertEqual(ob.table_order(spec, "u"), "id.asc")
        self.assertEqual(ob.table_order(spec, "v"), "n.asc")
        self.assertIsNone(ob.table_order(spec, "absent"))
        self.assertEqual(ob.table_order(None, "anything"), "id.asc")


class Retention(Base):
    def names(self, times):
        return [f"onyx-backup-{t.strftime('%Y%m%dT%H%M%SZ')}.tar.age" for t in times]

    def test_newest_eight_plus_first_of_three_months(self):
        weekly = [datetime(2026, 7, 5, 11, tzinfo=timezone.utc) + timedelta(weeks=i) for i in range(20)]
        names = self.names(weekly)
        keep = ob.retention_keep(names + ["notes.txt"])
        self.assertTrue(set(names[-8:]) <= keep)
        newest_months = sorted({(t.year, t.month) for t in weekly}, reverse=True)[:3]
        firsts = {m: min(n for t, n in zip(weekly, names) if (t.year, t.month) == m) for m in newest_months}
        self.assertTrue(set(firsts.values()) <= keep)
        self.assertEqual(len(keep - set(names[-8:]) - set(firsts.values())), 0)
        self.assertNotIn("notes.txt", keep)

    def test_prune_touches_only_this_jobs_names(self):
        self.dest.mkdir()
        weekly = [datetime(2026, 1, 4, tzinfo=timezone.utc) + timedelta(weeks=i) for i in range(20)]
        for n in self.names(weekly):
            (self.dest / n).write_bytes(b"x")
        other = self.dest / "Riley's file.pdf"
        other.write_bytes(b"keep")
        stale = self.dest / ".onyx-backup-20260101T000000Z.tar.age.partial"
        stale.write_bytes(b"x")
        os.utime(stale, (NOW.timestamp() - 3 * 86400, NOW.timestamp() - 3 * 86400))
        removed = ob.prune(self.dest, NOW)
        left = {p.name for p in self.dest.iterdir()}
        self.assertIn(other.name, left)
        self.assertNotIn(stale.name, left)
        self.assertEqual(removed, 20 - len(left - {other.name}) + 1)
        self.assertLessEqual(len(left - {other.name}), ob.KEEP_WEEKLY + ob.KEEP_MONTHLY)

    def test_a_successful_run_prunes(self):
        self.dest.mkdir()
        for n in self.names([datetime(2025, m, 1, tzinfo=timezone.utc) for m in range(1, 13)]):
            (self.dest / n).write_bytes(b"x")
        code, _ = self.backup()
        self.assertEqual(code, 0)
        self.assertLessEqual(len(self.written()), ob.KEEP_WEEKLY + ob.KEEP_MONTHLY)


class Drill(Base):
    def make(self):
        code, out = self.backup()
        self.assertEqual(code, 0, out)
        return self.written()[0]

    def rebuild(self, path, change):
        """Decrypt, let `change(members)` edit the {name: bytes} list, re-encrypt in place."""
        plain = self.cipher.open_plain(path)
        members = []
        with tarfile.open(fileobj=io.BytesIO(plain)) as tar:
            for m in tar.getmembers():
                members.append([m.name, tar.extractfile(m).read()])
        change(members)
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            for name, data in members:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        self.cipher.reseal(path, buf.getvalue())

    def drill(self):
        return ob.run_drill(dest=self.dest, identity=self.identity, cipher=self.cipher, root=self.tmp / "drill")

    def assert_removed(self):
        self.assertEqual(list((self.tmp / "drill").iterdir()), [])

    def test_a_changed_file_fails(self):
        p = self.make()
        self.rebuild(p, lambda ms: [m.__setitem__(1, m[1][:-1] + b"!") for m in ms if m[0].startswith("objects/")])
        r = self.drill()
        self.assertFalse(r.checks["objects_match"])
        self.assertEqual(r.status, "fail")
        self.assert_removed()

    def test_a_member_outside_the_pack_names_is_never_extracted(self):
        p = self.make()
        self.rebuild(p, lambda ms: ms.insert(0, ["../escaped.txt", b"x"]))
        r = self.drill()
        self.assertFalse(r.checks["no_unexpected_members"])
        self.assertEqual(r.status, "fail")
        self.assertFalse((self.tmp / "escaped.txt").exists())
        self.assertFalse((self.tmp / "drill" / "escaped.txt").exists())
        self.assert_removed()

    def test_a_dropped_table_fails(self):
        p = self.make()
        self.rebuild(p, lambda ms: ms.__setitem__(slice(None), [m for m in ms if m[0] != "tables/pds/lab_results.json"]))
        r = self.drill()
        self.assertFalse(r.checks["tables_match"])
        self.assertEqual(r.status, "fail")

    def test_a_ciphertext_that_does_not_decrypt(self):
        p = self.make()
        p.write_bytes(b"garbage")
        r = self.drill()
        self.assertFalse(r.checks["decrypted"])
        self.assertEqual(r.status, "fail")
        self.assert_removed()

    def test_no_backup_or_no_key_is_incomplete(self):
        r = self.drill()
        self.assertFalse(r.checks["backup_found"])
        self.assertEqual(r.status, "fail")
        self.make()
        self.identity.unlink()
        r = self.drill()
        self.assertFalse(r.checks["private_key_found"])

    def test_the_drill_folder_must_be_isolated(self):
        self.make()
        r = ob.run_drill(dest=self.dest, identity=self.identity, cipher=self.cipher, root=ROOT / "analysis_output" / "drill")
        self.assertFalse(r.checks["isolated_target"])
        r = ob.run_drill(dest=self.dest, identity=self.identity, cipher=self.cipher, root=self.dest / "drill")
        self.assertFalse(r.checks["isolated_target"])

    def test_hold_gets_a_viewable_copy_then_it_is_removed(self):
        self.make()
        seen = []
        r = ob.run_drill(dest=self.dest, identity=self.identity, cipher=self.cipher, root=self.tmp / "drill",
                         hold=lambda d: seen.extend(p.name for p in d.iterdir()))
        self.assertEqual(r.status, "pass", r.checks)
        self.assertIn("open-me.pdf", seen)
        self.assert_removed()


class Keygen(Base):
    def test_refuses_to_overwrite_and_refuses_the_repo(self):
        out = io.StringIO()
        self.assertEqual(ob.keygen(self.identity, self.tmp / "r.txt", run=None, out=out), 1)
        self.assertEqual(ob.keygen(ROOT / ".k", self.tmp / "r2.txt", run=None, out=out), 1)
        self.assertFalse((ROOT / ".k").exists())

    def test_writes_the_recipient_only_after_checking_it(self):
        calls = []

        class R:
            def __init__(self, code=0, stdout=b""):
                self.returncode, self.stdout = code, stdout

        def run(cmd, **k):
            calls.append(cmd)
            if "-o" in cmd:
                Path(cmd[cmd.index("-o") + 1]).write_text("AGE-SECRET-KEY-1FAKE\n")
                return R()
            if "-y" in cmd:
                return R(stdout=(RECIPIENT + "\n").encode())
            return R()

        ident, rec = self.tmp / "k" / "key.txt", self.tmp / "k" / "rec.txt"
        ident.parent.mkdir()
        out = io.StringIO()
        with mock.patch.object(ob, "find_tool", lambda n: "age-keygen"):
            self.assertEqual(ob.keygen(ident, rec, run=run, out=out), 0)
        self.assertEqual(ob.read_recipient(rec), RECIPIENT)
        self.assertNotIn("AGE-SECRET-KEY", out.getvalue(), "the private key is never printed")
        self.assertIn("password manager", out.getvalue())


class Heartbeat(Base):
    def test_only_a_short_code_is_ever_stored(self):
        ob.heartbeat(self.client, "failed", NOW.timestamp(), "a sentence with LEAK in it")
        ob.heartbeat(self.client, "partial", NOW.timestamp(), "files_missing")
        rows = self.heartbeats()
        self.assertIsNone(rows[0].get("error_message"))
        self.assertEqual(rows[1]["error_message"], "files_missing")
        self.assertTrue(all(r["records_synced"] == 0 for r in rows))


if __name__ == "__main__":
    unittest.main()
