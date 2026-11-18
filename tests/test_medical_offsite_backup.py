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
    failing, a wider table that cannot be read or is too large for a member are a PARTIAL run (written,
    flagged, no recovery manifest, and the drill does not pass it); a refused read, a failed
    encryption, a crash are a FAILED run with nothing in the backup folder and a failed heartbeat;
  * retry: a file answered 503 twice is fetched on the third try (1 s, 2 s backoff);
  * refusals before anything is sent: another origin, no public recipient, the private key given as the
    recipient, no age tool; a drill target needs its own --dest and its own key and writes no heartbeat;
  * tables: paging by primary key with a keyset cursor (never an OFFSET), single and composite keys, a row
    removed between two pages never skips an unread row, a table that keeps changing is not certified, a
    table without a usable primary key is not copied (partial), a table the schema does not know is listed
    as missing (not a failure), credentials and the trial seed / schedule are never requested; a listing
    that keeps changing is partial;
  * references between tables: a parent row and its child written between the two tables' reads are read
    again and copied together (success); a reference that stays broken is partial (tables_inconsistent)
    and the drill's references_hold fails; a row pointing into an excluded table is partial
    (parent_not_recoverable); experiment_days is an uncovered table (never requested, listed in the
    manifest);
  * off-site confirmation: the run's own ciphertext must be IN the OneDrive cloud before anything counts as
    off-site — its cloud-files state is read from the file's own attributes (the exact cfapi placeholder
    bits: OFFLINE, RECALL_ON_OPEN, RECALL_ON_DATA_ACCESS, PINNED, UNPINNED, REPARSE_POINT; a plain local
    file, an unreadable one, or a path outside OneDrive is pending_upload), polled for a bounded wait after
    the folder-level check passes; an unconfirmed backup is a PARTIAL run (pending_upload) that prunes
    nothing, and a later confirmed run prunes again; age alone is no longer evidence of an upload;
  * retention: newest 8 plus the first of each of the 3 latest months plus the newest backup whose
    completeness marker verifies (an empty or foreign marker is no evidence); only this job's names are
    removed; partial runs prune too but never the newest complete one; a marker that cannot be committed
    fails the run and prunes nothing; a marker that cannot be read, or whose stat fails (Path.is_file()
    would call it absent), stops the prune; ciphertext a killed run left in the temporary folder is
    removed after a day;
  * off-site durability (review finding R3): local completion is not remote durability. A run whose copy
    is not confirmed by the LOCAL record is partial (offsite_unconfirmed) and prunes nothing, whatever
    the OneDrive probe says; the record is written only by record_remote_confirmation (no confirmation
    mechanism is built, so it stays empty and every run answers partial), holds the backup name, size
    and confirmation time only, never lives under OneDrive or in the repo, and a missing or corrupt
    record is "unknown", never a guessed confirmation; prune() itself refuses when no backup is
    confirmed; a recorded confirmation protects the newest confirmed backup wherever it falls (elapsed
    time alone was never evidence) and lets retention run again; a confirmation whose file changed no
    longer counts;
  * the heartbeat goes to exactly the production origin with the key the backup resolved, whatever
    ONYX_SUPABASE_URL says, and a heartbeat that cannot be written never changes the run's outcome;
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
    # Full pds.lab_results columns, as the table has them (NOT NULL on unit, value_text, collected_on,
    # ref_text, strict flags): the recovery manifest validates every lab row's value / unit / range / date
    # state, so a row with those columns missing would be refused as a malformed manifest.
    return [{"id": LAB_1, "test_name": "LEAK test", "lab": "SYNTHETIC lab", "value_num": 1.5, "value_text": "",
             "unit": "mg/dL", "ref_low": 1.0, "ref_high": 2.0, "ref_text": "", "ref_low_strict": False,
             "ref_high_strict": False, "collected_on": "2026-03-01", "document_id": DOC_A, "removed_at": None},
            {"id": LAB_2, "test_name": "LEAK other", "lab": "SYNTHETIC lab", "value_num": None, "value_text": "LEAK",
             "unit": "", "ref_low": None, "ref_high": None, "ref_text": "", "ref_low_strict": False,
             "ref_high_strict": False, "collected_on": "2026-03-02", "document_id": None, "removed_at": None}]


def _split_top(text):
    """Splits a PostgREST logic tree's arguments on commas outside quotes and parentheses."""
    out, cur, depth, inq, esc = [], "", 0, False, False
    for ch in text:
        if inq:
            cur += ch
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                inq = False
            continue
        if ch == '"':
            inq = True
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
            continue
        cur += ch
    out.append(cur)
    return out


def _cond(text):
    col, op, val = text.split(".", 2)
    assert op in ("eq", "gt") and val[0] == '"' and val[-1] == '"', text
    out, esc = "", False
    for ch in val[1:-1]:
        if esc:
            out, esc = out + ch, False
        elif ch == "\\":
            esc = True
        else:
            out += ch
    return col, op, out


def parse_after(text):
    """The `or` filter the backup sends: a list of terms, each a list of (column, op, value)."""
    assert text[0] == "(" and text[-1] == ")", text
    terms = []
    for t in _split_top(text[1:-1]):
        terms.append([_cond(c) for c in _split_top(t[4:-1])] if t.startswith("and(") else [_cond(t)])
    return terms


def row_after(row, terms):
    def ok(col, op, v):
        x = str(row.get(col))
        return x == v if op == "eq" else x > v
    return any(all(ok(*c) for c in term) for term in terms)


class FakeSupabase:
    """PostgREST (pds tables + the OpenAPI root) and Storage (listing + download) for one project."""

    def __init__(self):
        self.tables = {"medical_documents": docs(), "lab_results": labs(),
                       "weight_log": [{"log_date": f"2026-01-{d:02d}", "weight_kg": 80.0, "note": "LEAK"} for d in range(1, 4)]}
        self.pk = {"medical_documents": ["id"], "lab_results": ["id"], "weight_log": ["log_date"]}
        self.fk: dict = {}              # table -> {column: (parent table, parent column)}, as PostgREST marks them
        self.files = {f"documents/{DOC_A}": (PDF, "application/pdf"), f"documents/{DOC_B}": (PNG, "image/png")}
        self.unlisted: set = set()      # in storage, not in the listing
        self.bytes_gone: set = set()    # in the listing, download answers not found
        self.wrong_size: set = set()    # the listing says one byte more than the file has
        self.flaky: dict = {}           # path or table -> how many 503 answers before a good one
        self.always_500: set = set()    # paths or tables that never answer
        self.denied = False
        self.calls: list = []
        self.posted: list = []          # heartbeat rows POSTed to /rest/v1/sync_log
        self.heartbeat_down = False
        self.on_read: dict = {}         # table -> fn(query) run before a read of it is answered (a concurrent change)
        self.on_list = None             # fn() run before each documents listing is answered

    def spec(self):
        defs = {}
        for t, rows in self.tables.items():
            cols = sorted({k for r in rows for k in r} | set(self.pk.get(t, [])))
            props = {}
            for c in cols:
                notes = []
                if c in self.pk.get(t, []):
                    notes.append("This is a Primary Key.<pk/>")
                if c in self.fk.get(t, {}):
                    parent, pcol = self.fk[t][c]
                    notes.append(f"This is a Foreign Key to `{parent}.{pcol}`.<fk table='{parent}' column='{pcol}'/>")
                props[c] = {"format": "text", **({"description": "Note:\n" + "\n".join(notes)} if notes else {})}
            defs[t] = {"properties": props}
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
        if method == "POST" and path == "/rest/v1/sync_log":
            self.posted.extend(json.loads(body.decode()))
            return (500, b"{}", {}) if self.heartbeat_down else (201, b"", {})
        if path == "/rest/v1/":
            return 200, json.dumps(self.spec()).encode(), {}
        if path.startswith("/rest/v1/"):
            table = path[len("/rest/v1/"):]
            if self._flake(table):
                return 503, b"{}", {}
            if table not in self.tables:
                return 404, json.dumps({"code": "PGRST205", "message": "LEAK"}).encode(), {}
            if table in self.on_read:
                self.on_read[table](q)
            rows = list(self.tables[table])
            key = [c.split(".")[0] for c in q.get("order", "").split(",") if c]
            rows.sort(key=lambda r: tuple(str(r.get(c)) for c in key))
            if "or" in q:
                rows = [r for r in rows if row_after(r, parse_after(q["or"]))]
            if q.get("select", "*") != "*":
                rows = [{c: r.get(c) for c in q["select"].split(",")} for r in rows]
            off, lim = int(q.get("offset", 0)), int(q.get("limit", 1000))
            return 200, json.dumps(rows[off:off + lim]).encode(), {}
        if path == f"/storage/v1/object/list/{rc.BUCKET}":
            req = json.loads(body.decode())
            if self.on_list and req["prefix"] == "documents":
                self.on_list()
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
        sync = mock.patch.object(ob, "onedrive_sync_ready", lambda d: True)
        sync.start()
        self.addCleanup(sync.stop)
        # A stand-in for the confirmation mechanism (none is built): confirms every backup that is in the
        # folder at read time, so the behaviour tests exercise success and pruning as before. The
        # off-site-durability tests override this with the REAL local record.
        self.real_load = ob.load_remote_confirmations

        def confirm_all(state_file=None):
            recs = {}
            if self.dest.is_dir():
                for p in self.dest.iterdir():
                    if ob.NAME_RE.match(p.name) and p.is_file():
                        recs[p.name] = {"size": p.stat().st_size, "evidence": ob.CONFIRMATION_EVIDENCE,
                                       "confirmed_at": NOW.isoformat(timespec="seconds")}
            return recs

        load = mock.patch.object(ob, "load_remote_confirmations", confirm_all)
        load.start()
        self.addCleanup(load.stop)
        # Blanket stub for the behaviour tests: every copy reads in sync. The confirmation tests (OffsiteConfirmation)
        # set their own cloud state, and the placeholder-bits test restores self.real_cloud.
        self.real_cloud = ob.onedrive_cloud_state
        cloud = mock.patch.object(ob, "onedrive_cloud_state", lambda p: "in_sync")
        cloud.start()
        self.addCleanup(cloud.stop)
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
        """What is in the backup folder, without the completeness markers of complete runs."""
        return sorted(p for p in self.dest.iterdir() if not ob.OK_RE.match(p.name)) if self.dest.is_dir() else []

    def markers(self):
        return sorted(p.name for p in self.dest.iterdir() if ob.OK_RE.match(p.name)) if self.dest.is_dir() else []

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
        self.assertEqual(self.markers(), [ob.ok_marker(files[0].name)], "a complete run is marked")
        marker = json.loads((self.dest / ob.ok_marker(files[0].name)).read_bytes())
        self.assertEqual(marker, {"backup": files[0].name, "size": files[0].stat().st_size}, "name and size only")
        self.assertTrue(ob.marker_valid(self.dest, files[0].name))
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
        self.assertEqual(self.markers(), [], "a partial backup is never marked complete")
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

    def test_partial_runs_prune_but_keep_the_newest_complete_backup(self):
        self.dest.mkdir()
        complete = self.dest / "onyx-backup-20250101T000000Z.tar.age"
        complete.write_bytes(b"x")
        ob.write_ok_marker(complete)
        older = self.dest / "onyx-backup-20240101T000000Z.tar.age"  # an empty marker is no evidence
        older.write_bytes(b"x")
        (self.dest / ob.ok_marker(older.name)).write_bytes(b"")
        later = [self.dest / f"onyx-backup-2026{m:02d}01T000000Z.tar.age" for m in range(1, 11)]  # partials
        for p in later:
            p.write_bytes(b"x")
        self.sb.unlisted.add(f"documents/{DOC_A}")
        code, _ = self.backup()
        self.assertEqual(code, 2)
        left = {p.name for p in self.written()}
        self.assertIn(complete.name, left, "the newest complete backup survives any run of partials")
        self.assertIn(ob.ok_marker(complete.name), self.markers())
        self.assertLessEqual(len(left), ob.KEEP_WEEKLY + ob.KEEP_MONTHLY + 1, "partial runs prune too")
        self.assertFalse(later[0].exists())
        self.assertFalse(older.exists(), "a backup whose marker does not verify is not protected")

    def test_a_marker_that_cannot_be_committed_fails_and_prunes_nothing(self):
        self.dest.mkdir()
        old = [self.dest / f"onyx-backup-2025{m:02d}01T000000Z.tar.age" for m in range(1, 13)]
        for p in old:
            p.write_bytes(b"x")
        with mock.patch.object(ob, "write_ok_marker", side_effect=OSError("disk")):
            code, out = self.backup()
        self.assertEqual(code, 1, out)
        self.assertIn("FAILED", out)
        hb = self.heartbeats()
        self.assertEqual((hb[0]["status"], hb[0]["error_message"]), ("failed", "marker_unwritable"))
        self.assertTrue(all(p.exists() for p in old), "nothing is pruned without durable completeness evidence")
        self.assertEqual(len(self.written()), len(old) + 1, "the new backup itself stays")
        self.assertEqual(self.markers(), [])

    def test_a_marker_that_does_not_read_back_fails(self):
        with mock.patch.object(ob, "marker_valid", return_value=False):
            code, out = self.backup()
        self.assertEqual(code, 1, out)
        self.assertEqual(self.heartbeats()[0]["error_message"], "marker_unwritable")

    def test_a_marker_read_error_stops_the_prune_with_nothing_removed(self):
        self.dest.mkdir()
        names = [f"onyx-backup-2025{m:02d}01T000000Z.tar.age" for m in range(1, 13)]
        for n in names:
            (self.dest / n).write_bytes(b"x")
        ob.write_ok_marker(self.dest / names[0])
        with mock.patch.object(ob, "marker_valid", side_effect=OSError("cloud file unavailable")):
            with self.assertRaises(OSError):
                ob.prune(self.dest, NOW)
        self.assertTrue(all((self.dest / n).exists() for n in names))

    def test_a_marker_whose_stat_fails_stops_the_prune_with_nothing_removed(self):
        # Path.is_file() answers False for any OSError on Python 3.14: the marker would look absent and the
        # only complete backup (the oldest) would be pruned. The explicit stat stops the prune instead.
        self.dest.mkdir()
        names = [f"onyx-backup-2025{m:02d}01T000000Z.tar.age" for m in range(1, 13)]
        for n in names:
            (self.dest / n).write_bytes(b"x")
        ob.write_ok_marker(self.dest / names[0])
        real_stat, marker = os.stat, ob.ok_marker(names[0])

        def denied(path, *a, **k):
            if Path(path).name == marker:
                raise PermissionError(13, "denied")
            return real_stat(path, *a, **k)
        with mock.patch.object(ob.os, "stat", side_effect=denied):
            with self.assertRaises(OSError):
                ob.prune(self.dest, NOW)
        self.assertTrue(all((self.dest / n).exists() for n in names))
        self.assertTrue((self.dest / marker).exists())

    def test_is_regular_answers_false_only_for_a_missing_file(self):
        self.dest.mkdir()
        (self.dest / "f").write_bytes(b"x")
        self.assertTrue(ob._is_regular(self.dest / "f"))
        self.assertFalse(ob._is_regular(self.dest / "missing"))
        self.assertFalse(ob._is_regular(self.dest))
        with mock.patch.object(ob.os, "stat", side_effect=PermissionError(13, "denied")):
            with self.assertRaises(PermissionError):
                ob._is_regular(self.dest / "f")

    def test_unreadable_rebuild_table_is_partial_and_missing_table_is_not(self):
        self.sb.always_500.add("weight_log")
        self.check_partial("rebuild_table_unreadable")
        report = ob.run_drill(dest=self.dest, identity=self.identity, cipher=self.cipher, root=self.tmp / "drill")
        self.assertTrue(report.checks["tables_match"], "what the pack holds still verifies")
        self.assertFalse(report.checks["backup_complete"], "but the omitted table is not ignored")
        self.assertEqual(report.status, "fail")

    def test_a_wider_table_too_large_for_a_member_is_left_out(self):
        self.sb.tables["weight_log"] = [{"log_date": f"2026-02-{d:02d}", "note": "LEAK" * 400} for d in range(1, 20)]
        with mock.patch.object(ob, "MAX_MEMBER_BYTES", 4096):
            names = self.check_partial("table_too_large")
        self.assertNotIn("tables/pds/weight_log.json", names, "never packed past the drill's limit")

    def test_a_medical_table_too_large_for_a_member_fails(self):
        with mock.patch.object(ob, "MAX_MEMBER_BYTES", 1):
            code, out = self.backup()
        self.assertEqual(code, 1, out)
        self.assertEqual(self.written(), [])
        self.assertEqual(self.heartbeats()[0]["error_message"], "medical_table_too_large")

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
        self.assertEqual(len(urls), 6, "3 pages of rows, then 3 pages of keys (the consistency check)")
        self.assertTrue(all("order=log_date.asc" in u for u in urls))
        self.assertFalse(any("offset=" in u for u in urls), "never an OFFSET")
        queries = [dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(u).query)) for u in urls]
        self.assertEqual(["or" in q for q in queries], [False, True, True, False, True, True])
        self.assertEqual([q["select"] for q in queries], ["*"] * 3 + ["log_date"] * 3)
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
            ob.read_table(rc.Target(rc.DEFAULT_URL, "k", transport=self.sb), "ci_tokens", ("id",))

    def test_table_key(self):
        pk = "Note:\nThis is a Primary Key.<pk/>"
        spec = {"definitions": {
            "t": {"properties": {"a": {"description": pk, "format": "uuid"}, "b": {"description": pk, "format": "date"},
                                 "c": {"format": "text"}}},
            "u": {"properties": {"id": {"format": "uuid"}, "x": {"format": "text"}}},  # no primary key
            "v": {"properties": {"j": {"description": pk, "format": "jsonb"}}},          # a key the cursor cannot compare
            "w": {"properties": {"f": {"description": pk, "format": "double precision"}}}}}
        self.assertEqual(ob.table_key(spec, "t"), ("a", "b"))
        self.assertEqual(ob.table_key(spec, "u"), ob.UNKEYED)
        self.assertEqual(ob.table_key(spec, "v"), ob.UNKEYED)
        self.assertEqual(ob.table_key(spec, "w"), ob.UNKEYED)
        self.assertIsNone(ob.table_key(spec, "absent"))
        self.assertEqual(ob.table_key(None, "anything"), ("id",))

    def test_after_filter_is_the_row_value_comparison_and_quotes_values(self):
        last = {"a": 'x"y\\z,(1)', "b": 7, "c": True}
        got = ob.after_filter("s", ("a", "b", "c"), last)
        self.assertEqual(got, '(a.gt."x\\"y\\\\z,(1)",and(a.eq."x\\"y\\\\z,(1)",b.gt."7"),'
                              'and(a.eq."x\\"y\\\\z,(1)",b.eq."7",c.gt."true"))')
        self.assertEqual(parse_after(got)[0], [("a", "gt", 'x"y\\z,(1)')], "the fake reads back what was sent")
        for bad in (None, 1.5, {"k": 1}):
            with self.assertRaises(rc.Unreadable):
                ob.after_filter("s", ("a",), {"a": bad})

    def test_a_composite_key_pages_without_skipping(self):
        self.sb.tables["book_chapters"] = [{"book_id": f"b{b}", "chapter": f"{c:04d}", "title": "LEAK"}
                                           for b in range(3) for c in range(900)]
        self.sb.pk["book_chapters"] = ["book_id", "chapter"]
        code, out = self.backup()
        self.assertEqual(code, 0, out)
        plain = self.cipher.open_plain(self.written()[0])
        with tarfile.open(fileobj=io.BytesIO(plain)) as tar:
            rows = json.loads(tar.extractfile("tables/pds/book_chapters.json").read())
        self.assertEqual(len({(r["book_id"], r["chapter"]) for r in rows}), 2700)

    def test_a_row_removed_between_pages_never_skips_an_unread_row(self):
        self.sb.tables["weight_log"] = [{"log_date": f"2020-{i:05d}", "note": "LEAK"} for i in range(2500)]
        state = {"done": False}

        def remove_a_read_row(q):
            if "or" in q and q.get("select") == "*" and not state["done"]:
                state["done"] = True
                del self.sb.tables["weight_log"][10]  # already on page 1; an OFFSET would now skip row 1010
        self.sb.on_read["weight_log"] = remove_a_read_row
        code, out = self.backup()
        self.assertEqual(code, 0, out)
        plain = self.cipher.open_plain(self.written()[0])
        with tarfile.open(fileobj=io.BytesIO(plain)) as tar:
            rows = json.loads(tar.extractfile("tables/pds/weight_log.json").read())
        self.assertEqual({r["log_date"] for r in rows}, {r["log_date"] for r in self.sb.tables["weight_log"]},
                         "the copy is exactly the table as it stands after the read")

    def test_a_table_that_keeps_changing_is_not_certified(self):
        counter = {"n": 0}

        def add_a_row(q):
            if q.get("select") != "*":  # between the rows and the key check: every read disagrees
                counter["n"] += 1
                self.sb.tables["weight_log"].append({"log_date": f"2027-{counter['n']:05d}", "note": "LEAK"})
        self.sb.on_read["weight_log"] = add_a_row
        PartialRuns.check_partial(self, "rebuild_table_unreadable")

    def test_a_table_without_a_primary_key_is_not_copied(self):
        self.sb.pk["weight_log"] = []
        names = PartialRuns.check_partial(self, "rebuild_table_unkeyed")
        self.assertNotIn("tables/pds/weight_log.json", names)
        self.assertFalse(any("/rest/v1/weight_log" in u for _, u, _ in self.sb.calls), "never read by OFFSET")

    def test_a_listing_that_keeps_changing_is_partial(self):
        def flip():
            if f"documents/{DOC_B}" in self.sb.unlisted:
                self.sb.unlisted.discard(f"documents/{DOC_B}")
            else:
                self.sb.unlisted.add(f"documents/{DOC_B}")
        self.sb.on_list = flip
        code, out = self.backup()
        self.assertEqual(code, 2, out)
        self.assertEqual(self.heartbeats()[0]["error_message"], "listing_changed")


class References(Base):
    def stacks(self, n_items=2):
        self.sb.tables["supplement_stack"] = [{"id": "s1", "name": "LEAK stack"}]
        self.sb.tables["supplement_stack_item"] = [{"id": f"i{k}", "stack_id": "s1", "doses": 1} for k in range(n_items)]
        self.sb.pk.update({"supplement_stack": ["id"], "supplement_stack_item": ["id"]})
        self.sb.fk["supplement_stack_item"] = {"stack_id": ("supplement_stack", "id")}

    def pack_tables(self):
        plain = self.cipher.open_plain(self.written()[0])
        with tarfile.open(fileobj=io.BytesIO(plain)) as tar:
            names = tar.getnames()
            return names, {n[len("tables/pds/"):-5]: json.loads(tar.extractfile(n).read())
                           for n in names if n.startswith("tables/pds/")}

    def test_a_stack_and_its_items_created_between_two_reads_are_copied_together(self):
        self.stacks()
        state = {"done": False}

        def create_stack_and_item(q):
            if not state["done"]:  # the stack table was already read: its new row is not in the copy yet
                state["done"] = True
                self.sb.tables["supplement_stack"].append({"id": "s2", "name": "LEAK new"})
                self.sb.tables["supplement_stack_item"].append({"id": "i9", "stack_id": "s2", "doses": 1})
        self.sb.on_read["supplement_stack_item"] = create_stack_and_item
        code, out = self.backup()
        self.assertEqual(code, 0, out)
        _, tables = self.pack_tables()
        self.assertEqual({r["id"] for r in tables["supplement_stack"]}, {"s1", "s2"}, "the stack was read again")
        self.assertIn("i9", {r["id"] for r in tables["supplement_stack_item"]})
        report = ob.run_drill(dest=self.dest, identity=self.identity, cipher=self.cipher, root=self.tmp / "drill")
        self.assertTrue(report.checks["references_hold"])
        self.assertEqual(report.status, "pass", report.as_dict())

    def test_a_reference_that_stays_broken_is_partial_and_the_drill_fails_it(self):
        self.stacks()
        self.sb.tables["supplement_stack_item"].append({"id": "i8", "stack_id": "gone", "doses": 1})
        PartialRuns.check_partial(self, "tables_inconsistent")
        reads = [u for _, u, _ in self.sb.calls if "/rest/v1/supplement_stack_item?" in u and "select=%2A" in u]
        self.assertEqual(len(reads), 1 + ob.REFERENCE_ROUNDS, "read again a bounded number of times, then refused")
        report = ob.run_drill(dest=self.dest, identity=self.identity, cipher=self.cipher, root=self.tmp / "drill")
        self.assertFalse(report.checks["references_hold"])
        self.assertEqual(report.status, "fail")

    def test_a_row_pointing_into_an_excluded_table_is_partial(self):
        self.sb.tables["weight_log"][0]["schedule_ref"] = "LEAK"
        self.sb.fk["weight_log"] = {"schedule_ref": ("experiment_schedule", "experiment_id")}
        PartialRuns.check_partial(self, "parent_not_recoverable")
        report = ob.run_drill(dest=self.dest, identity=self.identity, cipher=self.cipher, root=self.tmp / "drill")
        self.assertFalse(report.checks["references_hold"])

    def test_a_null_reference_into_an_excluded_table_is_fine(self):
        self.sb.tables["weight_log"][0]["schedule_ref"] = None
        self.sb.fk["weight_log"] = {"schedule_ref": ("experiment_schedule", "experiment_id")}
        code, out = self.backup()
        self.assertEqual(code, 0, out)

    def test_experiment_days_is_uncovered_and_never_requested(self):
        self.assertNotIn("experiment_days", ob.REBUILD_TABLES)
        self.assertIn("experiment_days", ob.UNCOVERED_TABLES)
        self.sb.tables["experiment_days"] = [{"experiment_id": "x", "behavioral_date": "2026-01-01", "note": "LEAK"}]
        code, out = self.backup()
        self.assertEqual(code, 0, out)
        self.assertFalse(any("/rest/v1/experiment_days" in u for _, u, _ in self.sb.calls))
        plain = self.cipher.open_plain(self.written()[0])
        with tarfile.open(fileobj=io.BytesIO(plain)) as tar:
            manifest = json.loads(tar.extractfile("manifest.json").read())
        self.assertEqual(manifest["uncovered_tables"], ["experiment_days"])

    def test_broken_references_is_column_by_column_between_copied_tables(self):
        spec = {"definitions": {"child": {"properties": {
            "a": {"description": "Note:\n<fk table='parent' column='x'/>"},
            "b": {"description": "Note:\n<fk table='parent' column='y'/>"}}}}}
        parent = [{"x": 1, "y": "p"}]
        self.assertEqual(ob.broken_references({"child": [{"a": 1, "b": "p"}], "parent": parent}, spec), set())
        self.assertEqual(ob.broken_references({"child": [{"a": 2, "b": "p"}], "parent": parent}, spec),
                         {("child", "parent")})
        self.assertEqual(ob.broken_references({"child": [{"a": None, "b": None}], "parent": parent}, spec), set())
        self.assertEqual(ob.broken_references({"child": [{"a": 2}]}, spec), set(), "a parent not copied is not judged here")


class Retention(Base):
    def test_unsynced_destination_is_partial_and_prunes_nothing(self):
        self.backup()
        old = self.dest / "onyx-backup-20200101T000000Z.tar.age"
        old.write_bytes(b"x")
        with mock.patch.object(ob, "onedrive_sync_ready", lambda d: False):
            code, out = self.backup()
        self.assertEqual(code, 2)
        self.assertIn("offsite_unsynced", out)
        self.assertTrue(old.exists())

    def test_keeps_the_newest_remotely_confirmed_backup(self):
        # Elapsed time is not evidence of upload (the old UPLOAD_GRACE_HOURS rule): only a recorded
        # confirmation is, and it protects the newest confirmed backup wherever it falls.
        names = [f"onyx-backup-202611{d:02d}T000000Z.tar.age" for d in range(2, 13)]
        complete = {"onyx-backup-20261112T000000Z.tar.age"}
        remote = {"onyx-backup-20261104T000000Z.tar.age"}  # outside the newest 8, not a month's first
        keep = ob.retention_keep(names, complete, remote=remote)
        self.assertIn("onyx-backup-20261104T000000Z.tar.age", keep)
        self.assertNotIn("onyx-backup-20261104T000000Z.tar.age", ob.retention_keep(names, complete))
        self.assertIn("onyx-backup-20261112T000000Z.tar.age", keep)
    def test_a_complete_backup_is_kept_only_by_the_rules_not_by_its_age(self):
        # the old UPLOAD_GRACE_HOURS rule (kept because it was "old enough to have uploaded") is gone: age is
        # not evidence of an upload, the file's own cloud state is (tested below).
        names = [f"onyx-backup-202611{d:02d}T000000Z.tar.age" for d in range(2, 13)]
        complete = {"onyx-backup-20261112T000000Z.tar.age", "onyx-backup-20261104T000000Z.tar.age"}
        keep = ob.retention_keep(names, complete)
        self.assertNotIn("onyx-backup-20261104T000000Z.tar.age", keep,
                         "an older complete backup is not kept on age alone")
        self.assertIn("onyx-backup-20261112T000000Z.tar.age", keep, "the newest complete backup is kept")

    def test_cloud_state_needs_the_explicit_in_sync_state(self):
        # State: the REAL onedrive_cloud_state (Base stubs it to in_sync). The cloud-filter placeholder state
        # is a synthetic fixture, and the path counts as under a OneDrive root. A pin, a placeholder or any
        # other attribute alone is not evidence: only PLACEHOLDER + IN_SYNC reads in sync (BACKUP449-1).
        real = mock.patch.object(ob, "onedrive_cloud_state", self.real_cloud)
        real.start()
        self.addCleanup(real.stop)
        PH, SYNC, PARTIAL = 0x1, 0x8, 0x10
        cases = {
            "pinned but not in sync (placeholder, essential props, no IN_SYNC)": (PH | 0x4, "pending_upload"),
            "unpinned but not in sync (online-only placeholder still uploading)": (PH | PARTIAL, "pending_upload"),
            "placeholder not in sync": (PH, "pending_upload"),
            "IN_SYNC without being a placeholder": (SYNC, "pending_upload"),
            "a plain local file": (0, "pending_upload"),
            "unreadable or invalid state": (None, "pending_upload"),
            "positively in sync": (PH | SYNC, "in_sync"),
            "positively in sync, online-only": (PH | SYNC | PARTIAL, "in_sync"),
        }
        with mock.patch.object(ob.os, "name", "nt"), mock.patch.object(ob, "under_onedrive", lambda p: True):
            for label, (state, want) in cases.items():
                with mock.patch.object(ob, "placeholder_state", return_value=state):
                    self.assertEqual(ob.onedrive_cloud_state(self.dest), want, label)
        with mock.patch.object(ob, "under_onedrive", lambda p: False), \
                mock.patch.object(ob, "placeholder_state", return_value=PH | SYNC):  # outside every OneDrive root
            self.assertEqual(ob.onedrive_cloud_state(self.dest), "pending_upload")
        with mock.patch.object(ob.os, "name", "posix"), mock.patch.object(ob, "under_onedrive", lambda p: True), \
                mock.patch.object(ob, "placeholder_state", return_value=PH | SYNC):  # off Windows
            self.assertEqual(ob.onedrive_cloud_state(self.dest), "pending_upload")

    def test_placeholder_state_is_unreadable_off_windows(self):
        with mock.patch.object(ob.os, "name", "posix"):
            self.assertIsNone(ob.placeholder_state(self.dest))

    def test_offsite_confirmed_polls_until_the_cloud_takes_the_file(self):
        reads = iter(["pending_upload", "pending_upload", "in_sync"])
        sleeps, ticks = [], iter([0.0, 10.0, 20.0, 30.0])
        with mock.patch.object(ob, "onedrive_cloud_state", lambda p: next(reads)):
            self.assertTrue(ob.offsite_confirmed(self.dest, self.dest, wait_seconds=30,
                                                 sleep=sleeps.append, clock=lambda: next(ticks)))
        self.assertEqual(sleeps, [ob.SYNC_POLL_SECONDS] * 2, "it waits between checks")

    def test_offsite_confirmed_gives_up_when_the_wait_runs_out(self):
        reads, sleeps = [], []
        with mock.patch.object(ob, "onedrive_cloud_state", lambda p: reads.append(p) or "pending_upload"):
            self.assertFalse(ob.offsite_confirmed(self.dest, self.dest, wait_seconds=0,
                                                  sleep=sleeps.append, clock=lambda: 0.0))
        self.assertEqual(len(reads), 1, "with no wait budget it checks once, then reports pending")

    def test_pending_upload_is_partial_writes_no_marker_and_prunes_nothing(self):
        self.dest.mkdir()
        old = [self.dest / f"onyx-backup-2025{m:02d}01T000000Z.tar.age" for m in range(1, 13)]
        for p in old:
            p.write_bytes(b"x")
        ob.write_ok_marker(old[0])
        with mock.patch.object(ob, "onedrive_cloud_state", lambda p: "pending_upload"):
            code, out = self.backup("--sync-wait", "0")
        self.assertEqual(code, 2, out)
        self.assertIn("pending_upload", out)
        self.assertTrue(all(p.exists() for p in old), "a replacement the cloud does not hold prunes nothing")
        self.assertEqual(self.markers(), [ob.ok_marker(old[0].name)], "the old marker is untouched")
        self.assertEqual(len(self.written()), len(old) + 1, "the new ciphertext itself stays")
        hb = self.heartbeats()
        self.assertEqual((hb[0]["status"], hb[0]["error_message"]), ("partial", "pending_upload"))

    def test_pending_upload_does_not_stop_a_later_confirmed_run_from_pruning(self):
        self.dest.mkdir()
        old = [self.dest / f"onyx-backup-2025{m:02d}01T000000Z.tar.age" for m in range(1, 13)]
        for p in old:
            p.write_bytes(b"x")
        with mock.patch.object(ob, "onedrive_cloud_state", lambda p: "pending_upload"):
            code, _ = self.backup("--sync-wait", "0")
        self.assertEqual(code, 2)
        code, out = self.backup()  # the next run's backup IS confirmed in the cloud
        self.assertEqual(code, 0, out)
        self.assertLessEqual(len(self.written()), ob.KEEP_WEEKLY + ob.KEEP_MONTHLY + 1)

    def names(self, times):
        return [f"onyx-backup-{t.strftime('%Y%m%dT%H%M%SZ')}.tar.age" for t in times]

    def test_newest_eight_plus_first_of_three_months(self):
        weekly = [datetime(2026, 7, 5, 11, tzinfo=timezone.utc) + timedelta(weeks=i) for i in range(20)]
        names = self.names(weekly)
        keep = ob.retention_keep(names + ["notes.txt"], set())
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

    def test_markers_of_pruned_backups_go_with_them(self):
        self.dest.mkdir()
        weekly = [datetime(2026, 1, 4, tzinfo=timezone.utc) + timedelta(weeks=i) for i in range(20)]
        for n in self.names(weekly):
            (self.dest / n).write_bytes(b"x")
            ob.write_ok_marker(self.dest / n)
        ob.prune(self.dest, NOW)
        backups = {p.name for p in self.written()}
        self.assertEqual({ob.ok_marker(n) for n in backups}, set(self.markers()))

    def test_stale_ciphertext_in_the_temporary_folder_is_removed(self):
        ob.tmp_dir().mkdir(parents=True, exist_ok=True)
        stale = ob.tmp_dir() / "onyx-backup-20260101T000000Z.tar.age.tmp"
        fresh = ob.tmp_dir() / "onyx-backup-20261122T150000Z.tar.age.tmp"
        other = ob.tmp_dir() / "notes.txt"
        old_time = NOW.timestamp() - 3 * 86400
        for f in (stale, fresh, other):
            f.write_bytes(b"x")
            os.utime(f, (old_time, old_time))
        os.utime(fresh, (NOW.timestamp() - 60, NOW.timestamp() - 60))
        ob.clear_stale_tmp(ob.tmp_dir(), NOW)
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists() and other.exists())

    def test_a_successful_run_prunes(self):
        self.dest.mkdir()
        for n in self.names([datetime(2025, m, 1, tzinfo=timezone.utc) for m in range(1, 13)]):
            (self.dest / n).write_bytes(b"x")
        code, _ = self.backup()
        self.assertEqual(code, 0)
        self.assertLessEqual(len(self.written()), ob.KEEP_WEEKLY + ob.KEEP_MONTHLY)


class OffsiteConfirmation(Base):
    """Local completion is not remote durability (review finding R3): the OneDrive process running, the
    folder existing and file age are never evidence that the remote copy exists. These tests use the REAL
    local record (empty in every test unless record_remote_confirmation wrote one — the only writer)."""

    def setUp(self):
        super().setUp()
        real = mock.patch.object(ob, "load_remote_confirmations", self.real_load)
        real.start()
        self.addCleanup(real.stop)

    def run_direct(self):
        """run_backup with an explicit sync probe, so the cloud check and the record write are skipped and the
        local record is the only confirmation. Zero sync wait."""
        return ob.run_backup(rc.Target(rc.DEFAULT_URL, "fake-service", transport=self.sb), recipient=RECIPIENT,
                             cipher=self.cipher, dest=self.dest, tmp=ob.tmp_dir(), now=NOW,
                             sync_probe=lambda d: True, sync_wait=0, sleep=self.sleeps.append)

    def seed(self, times):
        self.dest.mkdir(parents=True, exist_ok=True)
        made = []
        for t in times:
            p = self.dest / f"onyx-backup-{t.strftime('%Y%m%dT%H%M%SZ')}.tar.age"
            p.write_bytes(b"x")
            made.append(p)
        return made

    def backups_here(self):
        return sorted(p.name for p in self.dest.iterdir() if ob.NAME_RE.match(p.name))

    def test_a_run_with_no_remote_confirmation_is_partial_and_prunes_nothing(self):
        # State: no local record, and the new copy's cloud state reads pending_upload (a plain local file).
        # The run stops at the cloud check, before retention, so it reports pending_upload.
        made = self.seed([datetime(2025, m, 1, tzinfo=timezone.utc) for m in range(1, 13)])
        ob.write_ok_marker(made[0])
        with mock.patch.object(ob, "onedrive_cloud_state", lambda p: "pending_upload"):
            code, out = self.backup("--sync-wait", "0")
        self.assertEqual(code, 2, out)
        self.assertIn("pending_upload", out)
        hb = self.heartbeats()
        self.assertEqual((hb[0]["status"], hb[0]["error_message"], hb[0]["records_synced"]),
                         ("partial", "pending_upload", 0))
        self.assertTrue({p.name for p in made} <= set(self.backups_here()),
                        "nothing is pruned without a confirmed remote copy")
        self.assertEqual(len(self.backups_here()), len(made) + 1, "the new copy itself stays")

    def test_prune_refuses_when_no_backup_is_confirmed(self):
        made = self.seed([datetime(2025, m, 1, tzinfo=timezone.utc) for m in range(1, 4)])
        with self.assertRaises(ob.BackupError) as cm:
            ob.prune(self.dest, NOW)
        self.assertEqual(cm.exception.code, "offsite_unconfirmed")
        self.assertTrue(all(p.exists() for p in made))

    def test_a_recorded_confirmation_lets_a_run_prune_and_keeps_the_confirmed_backup(self):
        made = self.seed([datetime(2025, m, 1, tzinfo=timezone.utc) for m in range(1, 13)])
        # State: made[0] (the oldest) has a matching local record; the new copy has none (run_direct).
        ob.record_remote_confirmation(self.dest, made[0].name, now=NOW)
        result = self.run_direct()
        self.assertEqual((result.status, result.code), ("partial", "offsite_unconfirmed"),
                         "this run's own new copy is still unconfirmed")
        self.assertTrue(made[0].exists(), "the newest confirmed backup survives wherever it falls")
        self.assertFalse(made[1].exists(), "older unconfirmed backups are pruned")
        self.assertLessEqual(len(self.backups_here()), ob.KEEP_WEEKLY + ob.KEEP_MONTHLY + 2)

    def test_a_confirmation_that_no_longer_matches_its_file_prunes_nothing(self):
        made = self.seed([datetime(2025, m, 1, tzinfo=timezone.utc) for m in range(1, 13)])
        # State: made[0] has a local record, then its file changed, so the record no longer matches (run_direct).
        ob.record_remote_confirmation(self.dest, made[0].name, now=NOW)
        made[0].write_bytes(b"changed since")
        result = self.run_direct()
        self.assertEqual((result.status, result.code), ("partial", "offsite_unconfirmed"))
        self.assertEqual(len(self.backups_here()), len(made) + 1, "a failed confirmation never deletes anything")

    def test_a_confirmation_from_the_old_attribute_predicate_is_not_trusted(self):
        # State: a record shaped like the ones the old attribute-bit predicate wrote (name, size, time, no
        # evidence) matches its file exactly; it must not count as a remote copy, so nothing is pruned.
        made = self.seed([datetime(2025, m, 1, tzinfo=timezone.utc) for m in range(1, 13)])
        state = ob.remote_state_file()
        state.parent.mkdir(parents=True, exist_ok=True)
        legacy = {made[0].name: {"size": made[0].stat().st_size, "confirmed_at": NOW.isoformat(timespec="seconds")}}
        state.write_bytes(ob._dump({"backups": legacy}))
        self.assertEqual(ob.remote_confirmed_names(self.dest, ob.load_remote_confirmations()), set())
        with self.assertRaises(ob.BackupError) as cm:
            ob.prune(self.dest, NOW)
        self.assertEqual(cm.exception.code, "offsite_unconfirmed")
        self.assertTrue(all(p.exists() for p in made), "an untrusted old confirmation never deletes anything")

    def test_the_record_holds_name_size_and_time_only_and_stays_local(self):
        made = self.seed([datetime(2026, 3, 1, tzinfo=timezone.utc)])
        ob.record_remote_confirmation(self.dest, made[0].name, now=NOW)
        recs = self.real_load()
        self.assertEqual(set(recs), {made[0].name})
        self.assertEqual(set(recs[made[0].name]), {"size", "evidence", "confirmed_at"})
        self.assertEqual(recs[made[0].name]["evidence"], ob.CONFIRMATION_EVIDENCE)
        self.assertEqual(recs[made[0].name]["size"], made[0].stat().st_size)
        state = ob.remote_state_file()
        self.assertFalse(ob.under_onedrive(state), "the record never lives under OneDrive")
        self.assertFalse(ob.is_under(state, ob.ROOT), "the record never lives in the repo")
        self.assertTrue(ob.is_under(state, ob.local_root()))
        data = state.read_bytes()
        for marker in (b"LEAK", b"SYNTHETIC", str(self.dest).encode()):
            self.assertNotIn(marker, data, f"the record holds the name, size and time only, not {marker!r}")
        self.assertEqual(ob.load_remote_confirmations(self.dest / "missing.json"), {}, "a missing record is unknown")

    def test_record_refuses_bad_names_missing_files_and_unsafe_state(self):
        self.seed([datetime(2026, 3, 1, tzinfo=timezone.utc)])
        with self.assertRaises(ValueError):
            ob.record_remote_confirmation(self.dest, "not-a-backup.tar.age", now=NOW)
        with self.assertRaises(OSError):
            ob.record_remote_confirmation(self.dest, "onyx-backup-20260101T000000Z.tar.age", now=NOW)
        with mock.patch.object(ob, "remote_state_file", lambda: ob.ROOT / "state.json"):
            with self.assertRaises(ob.BackupError):
                ob.record_remote_confirmation(self.dest, "onyx-backup-20260301T000000Z.tar.age", now=NOW)
        self.assertEqual(ob.load_remote_confirmations(), {}, "nothing was written by a refused record")

    def test_a_corrupt_record_is_unknown_never_a_guessed_confirmation(self):
        self.seed([datetime(2026, 3, 1, tzinfo=timezone.utc)])
        ob.remote_state_file().parent.mkdir(parents=True, exist_ok=True)
        ob.remote_state_file().write_bytes(b"{not json")
        self.assertEqual(ob.remote_confirmed_names(self.dest, ob.load_remote_confirmations()), set())
        with self.assertRaises(ob.BackupError):
            ob.prune(self.dest, NOW)


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
        self.assertEqual(r.status, "incomplete")
        self.make()
        self.identity.unlink()
        r = self.drill()
        self.assertFalse(r.checks["private_key_found"])
        self.assertEqual(r.status, "incomplete")

    def test_a_manifest_without_its_problems_list_is_invalid(self):
        p = self.make()

        def drop(ms):
            for m in ms:
                if m[0] == "manifest.json":
                    d = json.loads(m[1])
                    d.pop("problems")
                    m[1] = json.dumps(d).encode()
        self.rebuild(p, drop)
        r = self.drill()
        self.assertFalse(r.checks["manifest_valid"])
        self.assertEqual(r.status, "fail")

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
    def test_refuses_one_path_for_both_files(self):
        out = io.StringIO()
        same = self.tmp / "k" / "same.txt"
        same.parent.mkdir()
        self.assertEqual(ob.keygen(same, same, run=None, out=out), 1)
        self.assertEqual(ob.keygen(same, same.parent / ".." / "k" / "same.txt", run=None, out=out), 1)
        self.assertFalse(same.exists())

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
    def test_goes_to_the_production_origin_with_the_resolved_key(self):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"ONYX_SUPABASE_URL": "https://example.com",
                                          "ONYX_SUPABASE_SECRET_FILE": str(self.tmp / "other-key")}):
            code = ob.main(["backup", "--recipient-file", str(self.rfile), "--dest", str(self.dest)],
                           transport=self.sb, sleep=self.sleeps.append, cipher_factory=lambda: self.cipher, out=out)
        self.assertEqual(code, 0, out.getvalue())
        posts = [(u, h) for m, u, h in self.sb.calls if m == "POST" and "/rest/v1/" in u]
        self.assertEqual(len(posts), 1)
        self.assertTrue(posts[0][0].startswith(rc.DEFAULT_URL + "/rest/v1/sync_log"))
        self.assertEqual(posts[0][1]["apikey"], "fake-service")
        self.assertEqual([(r["source"], r["status"], r["records_synced"]) for r in self.sb.posted],
                         [("backup", "success", 0)])

    def test_a_heartbeat_that_cannot_be_written_does_not_change_the_outcome(self):
        self.sb.heartbeat_down = True
        out = io.StringIO()
        code = ob.main(["backup", "--recipient-file", str(self.rfile), "--dest", str(self.dest)],
                       transport=self.sb, sleep=self.sleeps.append, cipher_factory=lambda: self.cipher, out=out)
        self.assertEqual(code, 0, out.getvalue())

        class Boom:
            def schema(self, _):
                raise RuntimeError("LEAK")
        ob.heartbeat(Boom(), "failed", NOW.timestamp(), "x")  # never raises

    def test_only_a_short_code_is_ever_stored(self):
        ob.heartbeat(self.client, "failed", NOW.timestamp(), "a sentence with LEAK in it")
        ob.heartbeat(self.client, "partial", NOW.timestamp(), "files_missing")
        rows = self.heartbeats()
        self.assertIsNone(rows[0].get("error_message"))
        self.assertEqual(rows[1]["error_message"], "files_missing")
        self.assertTrue(all(r["records_synced"] == 0 for r in rows))


if __name__ == "__main__":
    unittest.main()
