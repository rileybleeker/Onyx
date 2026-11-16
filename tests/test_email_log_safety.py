"""email_log_safety + the four email ETLs: no private mail content or exception text in public diagnostics.

Sentinel strings stand in for a subject, a body, a sender, an account address, a parsed value
(confirmation / merchant / order number) and upstream exception text. Each ETL is driven through
its routine, per-message, per-account, fatal and --file paths against a fake IMAP server and a
fake Supabase client, and every log record (tracebacks included), stdout/stderr and the sync_log
heartbeat row are checked for the sentinels.

Offline: every message is invented, every address uses reserved example domains.

Run: python tests/test_email_log_safety.py
"""
import contextlib
import imaplib
import io
import logging
import os
import re
import socket
import ssl
import sys
import tempfile
import unittest
from datetime import date, datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import email_log_safety as s  # noqa: E402
import delivery_email_etl as d  # noqa: E402
import flights_email_etl as f  # noqa: E402
import orders_email_etl as o  # noqa: E402
import urgent_email_etl as u  # noqa: E402

SUBJ = "SENTINEL-SUBJECT-7f3a"
BODY = "SENTINEL-BODY-91c2"
SENDER = "sentinel-sender-55aa@example.org"
ACCOUNT = "sentinel-account-4d1e@example.net"
EXC = "SENTINEL-EXCEPTION-b8e0"
CONF = "SNTL7Q"
MERCHANT = "Sentinelmerchant Kitchen"
ORDER_NO = "SNT-445566"
FAIL = "SENTINEL-FAIL-0c0c"
ALL = (SUBJ, BODY, SENDER, ACCOUNT, EXC, CONF, MERCHANT, ORDER_NO, "sentinel", "Sentinel")


def raw_email(subject, sender, body, mid, date_hdr="Tue, 10 Nov 2026 14:00:00 +0000", to=None):
    m = EmailMessage()
    m["Subject"], m["From"], m["Date"], m["Message-ID"] = subject, sender, date_hdr, mid
    if to:
        m["To"] = to
    m.set_content(body)
    return m.as_bytes()


class MailIMAP:
    """Read-only Gmail stand-in: every search returns every message; every message carries Agent/Action."""

    def __init__(self, raws=(), login_error=None):
        self.raws = {str(i).encode(): r for i, r in enumerate(raws, 1)}
        self.login_error = login_error

    def login(self, user, password):
        if self.login_error is not None:
            raise imaplib.IMAP4.error(self.login_error)

    def list(self):
        return "OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\All \\HasNoChildren) "/" "[Gmail]/All Mail"']

    def select(self, name, readonly=False):
        assert readonly
        return "OK", [str(len(self.raws)).encode()]

    def uid(self, cmd, *args):
        if cmd == "SEARCH":
            return "OK", [b" ".join(self.raws)]
        if cmd == "FETCH":
            uids, item = args[0].split(b","), args[1]
            out = []
            for n, uid in enumerate(uids, 1):
                raw, gm = self.raws[uid], b"9" + uid
                if "X-GM-LABELS" in item:
                    out.append(b'%d (X-GM-THRID %s X-GM-MSGID %s X-GM-LABELS ("\\\\Inbox" "Agent/Action") UID %s '
                               b'FLAGS () RFC822.SIZE %d)' % (n, gm, gm, uid, len(raw)))
                elif item == "(X-GM-MSGID)":
                    out.append(b"%d (X-GM-MSGID %s UID %s)" % (n, gm, uid))
                elif "HEADER.FIELDS" in item:
                    header = raw.split(b"\n\n", 1)[0] + b"\n\n"
                    out += [(b"%d (UID %s BODY[HEADER.FIELDS (SUBJECT DATE MESSAGE-ID FROM TO)] {%d}" % (n, uid, len(header)), header), b")"]
                else:
                    out += [(b"%d (UID %s BODY[] {%d}" % (n, uid, len(raw)), raw), b")"]
            return "OK", out
        raise AssertionError(f"unexpected IMAP command {cmd}")

    def logout(self):
        pass


class AnySupa:
    """Chainable Supabase stand-in: every query returns no rows; inserts/upserts are recorded.
    execute() raises `fail_with` when the current table is in `fail_tables` (or always when it is empty)."""

    def __init__(self, fail_with=None, fail_tables=()):
        self.fail_with, self.fail_tables = fail_with, set(fail_tables)
        self.inserts, self.upserts, self._table, self.created = [], [], None, 0

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)

        def method(*a, **k):
            if name == "insert":
                self.inserts.append((self._table, a[0]))
            elif name == "upsert":
                self.upserts.append((self._table, a[0]))
            return self
        return method

    @property
    def not_(self):
        return self

    def schema(self, name):
        return self

    def table(self, name):
        self._table = name
        return self

    from_ = table

    def execute(self):
        if self.fail_with is not None and (not self.fail_tables or self._table in self.fail_tables):
            raise self.fail_with
        return SimpleNamespace(data=[])

    def heartbeats(self):
        return [row for table, row in self.inserts if table == "sync_log"]


@contextlib.contextmanager
def fake_supabase(supa):
    """Stub `supabase.create_client`; supa.created counts client creations."""
    saved = sys.modules.get("supabase")
    supa.created = 0

    def create_client(url, key):
        supa.created += 1
        return supa
    sys.modules["supabase"] = SimpleNamespace(create_client=create_client)
    try:
        yield supa
    finally:
        if saved is None:
            sys.modules.pop("supabase", None)
        else:
            sys.modules["supabase"] = saved


@contextlib.contextmanager
def fake_imap(*fakes):
    queue = list(fakes)
    with mock.patch("imaplib.IMAP4_SSL", lambda host: queue.pop(0)):
        yield


IMAP_ENV = {"IMAP_EMAIL": ACCOUNT, "IMAP_APP_PASSWORD": "pw-for-tests",
            **{f"IMAP_EMAIL_{i}": "" for i in range(2, 6)}, **{f"IMAP_APP_PASSWORD_{i}": "" for i in range(2, 6)}}


class Capture:
    """Every log record (any logger, tracebacks rendered) plus stdout and stderr."""

    def __enter__(self):
        self.stream, self.out, self.err = io.StringIO(), io.StringIO(), io.StringIO()
        self.handler = logging.StreamHandler(self.stream)
        self.handler.setLevel(logging.DEBUG)
        self.handler.setFormatter(logging.Formatter("%(name)s %(levelname)s %(message)s"))
        self.records = []
        self.recorder = logging.Handler(logging.DEBUG)
        self.recorder.emit = self.records.append
        root = logging.getLogger()
        self.level = root.level
        root.setLevel(logging.INFO)
        root.addHandler(self.handler)
        root.addHandler(self.recorder)
        self._out = contextlib.redirect_stdout(self.out)
        self._err = contextlib.redirect_stderr(self.err)
        self._out.__enter__()
        self._err.__enter__()
        return self

    def __exit__(self, *exc):
        self._err.__exit__(*exc)
        self._out.__exit__(*exc)
        root = logging.getLogger()
        root.removeHandler(self.handler)
        root.removeHandler(self.recorder)
        root.setLevel(self.level)
        return False

    @property
    def text(self):
        return self.stream.getvalue() + self.out.getvalue() + self.err.getvalue()


class Clean(unittest.TestCase):
    def setUp(self):
        for module in (u, f, d, o):          # main() opens the gate for write runs; start every test closed
            module.HEARTBEAT.close()

    @contextlib.contextmanager
    def write_mode(self, module):
        module.HEARTBEAT.open()
        try:
            yield
        finally:
            module.HEARTBEAT.close()

    def assertClean(self, text, *extra):
        for secret in ALL + extra:
            self.assertNotIn(secret, text, "public diagnostics carry counts and codes only")

    def assertNoTracebacks(self, cap):
        self.assertTrue(all(r.exc_info is None and r.stack_info is None for r in cap.records),
                        "no exc_info / stack_info: a traceback prints source lines and values")


# ---------------------------------------------------------------------------
# The helper
# ---------------------------------------------------------------------------

class HelperTests(Clean):
    def test_error_codes_are_allowlisted_categories(self):
        class PostgrestLike(Exception):
            pass
        PostgrestLike.__module__ = "postgrest.exceptions"

        class MissingTable(Exception):
            code = "PGRST205"
        leaky_name = type("SentinelAccountLeakError", (Exception,), {})
        cases = [
            (imaplib.IMAP4.error(f"[AUTHENTICATIONFAILED] {EXC}".encode()), "imap_auth"),
            (imaplib.IMAP4.error(f"command FETCH {EXC}"), "imap_error"),
            (imaplib.IMAP4.abort(EXC), "imap_abort"),
            (imaplib.IMAP4.readonly(EXC), "imap_readonly"),
            (TimeoutError(EXC), "timeout"),
            (socket.gaierror(EXC), "dns_error"),
            (ssl.SSLError(EXC), "tls_error"),
            (ConnectionRefusedError(EXC), "connection_error"),
            (OSError(EXC), "os_error"),
            (KeyError(EXC), "missing_key"),
            (UnicodeDecodeError("utf-8", b"\xff", 0, 1, EXC), "decode_error"),
            (LookupError(EXC), "lookup_error"),
            (ValueError(EXC), "value_error"),
            (TypeError(EXC), "program_error"),
            (ImportError(EXC), "dependency_missing"),
            (MissingTable(EXC), "db_table_missing"),
            (PostgrestLike(EXC), "db_error"),
            (RuntimeError(EXC), "runtime_error"),
            (leaky_name(EXC), "unexpected_error"),
            (Exception(EXC), "unexpected_error"),
        ]
        for exc, code in cases:
            with self.subTest(code=code):
                self.assertEqual(s.error_code(exc), code)
                self.assertClean(s.failure("stage", exc), "SentinelAccountLeakError")
        self.assertEqual(s.error_code(RuntimeError(EXC), {RuntimeError: "custom"}), "custom")

    def test_log_failure_has_no_text_and_no_traceback(self):
        logger = logging.getLogger("email_log_safety_test")
        with Capture() as cap:
            try:
                raise ValueError(f"{EXC} {SUBJ} {ACCOUNT}")
            except ValueError as e:
                code = s.log_failure(logger, "message_failed", e, fp="abcd1234")
        self.assertEqual(code, "message_failed:value_error")
        self.assertIn("[fp=abcd1234] message_failed:value_error", cap.text)
        self.assertClean(cap.text)
        self.assertNoTracebacks(cap)

    def test_dependency_records_are_sanitized_at_every_level(self):
        s.quiet_dependency_loggers()
        s.quiet_dependency_loggers()                      # idempotent: no double wrapping
        child = logging.getLogger("httpcore.http11")
        future = logging.getLogger("supabase._sync.client.future_child")
        child.setLevel(logging.DEBUG)                     # an explicit level below the ancestor's WARNING
        future.setLevel(logging.INFO)
        try:
            with Capture() as cap:
                logging.getLogger("httpx").info(f'HTTP Request: GET https://db.example/rest/v1/x?account=eq.{ACCOUNT} "200"')
                child.debug(f"send_request_body {SUBJ}")
                future.info("row %s", BODY)
                logging.getLogger("httpx").warning(f"response body: {SUBJ} {ACCOUNT}")
                logging.getLogger("postgrest").error("failing row %s", ACCOUNT)
                logging.getLogger("urllib3.connectionpool").critical(EXC, stack_info=True)
                try:
                    raise ValueError(f"{EXC} {SUBJ}")
                except ValueError:
                    logging.getLogger("postgrest._sync.request").exception(f"request failed {ACCOUNT}")
                logging.getLogger("httpxish").warning("not a dependency namespace")
                logging.getLogger("urgent_email_etl").warning("[fp=abcd1234] account_read_failed:imap_auth")
        finally:
            child.setLevel(logging.NOTSET)
            future.setLevel(logging.NOTSET)
        self.assertClean(cap.text)
        self.assertNoTracebacks(cap)
        for marker in ("dependency_log:httpcore:debug", "dependency_log:supabase:info", "dependency_log:httpx:warning",
                       "dependency_log:postgrest:error", "dependency_log:urllib3:critical"):
            self.assertIn(marker, cap.text, "that a dependency logged stays visible; what it said does not")
        self.assertNotIn("dependency_log:httpx:info", cap.text, "INFO request lines stay below the ancestor level")
        self.assertIn("not a dependency namespace", cap.text, "other loggers are untouched")
        self.assertIn("account_read_failed:imap_auth", cap.text, "the ETL's own stage codes are untouched")
        self.assertEqual(imaplib.Debug, 0)

    def test_dependency_namespace_matching(self):
        self.assertEqual(s.dependency_namespace("httpx"), "httpx")
        self.assertEqual(s.dependency_namespace("httpcore.connection"), "httpcore")
        self.assertIsNone(s.dependency_namespace("httpxish"))
        self.assertIsNone(s.dependency_namespace("orders_email_etl"))

    def test_bounded_days(self):
        self.assertEqual(s.bounded_days("30"), 30)
        for bad in ("0", "-1", "1000000000", "x", str(s.MAX_DAYS + 1)):
            with self.subTest(bad=bad), self.assertRaises(Exception):
                s.bounded_days(bad)

    def test_modules_install_the_quiet_levels(self):
        for name in ("httpx", "httpcore", "postgrest", "supabase"):
            self.assertGreaterEqual(logging.getLogger(name).level, logging.WARNING)


class SourceScan(unittest.TestCase):
    """Source-level guard: no traceback logging and no exception text in the four ETLs."""
    FILES = ("urgent_email_etl.py", "flights_email_etl.py", "delivery_email_etl.py", "orders_email_etl.py",
             "sync_log_helper.py")
    BANNED = (r"log\.exception\(", r"exc_info\s*=\s*True", r"stack_info\s*=\s*True", r"repr\(e\)", r"str\(e\)",
              r"\{e\}", r"\{e!r\}", r"\{e!s\}", r"traceback\.", r"type\(e\)\.__name__",
              r"\[\{acct\}\]", r"\[\{account\}\]", r"\{acct\}:", r"\{', '\.join\(missing\)\}")

    def test_no_banned_patterns(self):
        for name in self.FILES:
            src = (ROOT / name).read_text(encoding="utf-8")
            for pattern in self.BANNED:
                with self.subTest(file=name, pattern=pattern):
                    self.assertIsNone(re.search(pattern, src))

    def test_per_message_logs_never_name_subject_or_parsed_values(self):
        for name in self.FILES:
            src = (ROOT / name).read_text(encoding="utf-8")
            for line in src.splitlines():
                if re.search(r"\blog\.(info|warning|error|debug)\(", line):
                    with self.subTest(file=name, line=line.strip()[:60]):
                        for field in ("['subject']", "['confirmation']", "merchant_name']", "['notes']", "order_key']",
                                      "subject[:", "text_head", "dep_city", "['total']"):
                            self.assertNotIn(field, line)


# ---------------------------------------------------------------------------
# urgent_email_etl
# ---------------------------------------------------------------------------

def urgent_mail():
    return [raw_email(SUBJ, f"Sentinel Person <{SENDER}>", f"{BODY} due Friday.", "<sentinel-1@example.org>")]


class UrgentSentinels(Clean):
    def test_routine_and_dry_run(self):
        for supa, dry in ((AnySupa(), False), (None, True)):
            with self.subTest(dry_run=dry), Capture() as cap, fake_imap(MailIMAP(urgent_mail())):
                status, total, error = u.run(supa, [(ACCOUNT, "pw")], 30, dry_run=dry)
            self.assertEqual(total, 1)
            self.assertClean(cap.text + (error or ""))
            self.assertNoTracebacks(cap)

    def test_per_message_failure(self):
        with Capture() as cap, fake_imap(MailIMAP(urgent_mail())), \
                mock.patch.object(u, "build_row", side_effect=ValueError(f"{EXC} {SUBJ}")):
            status, total, error = u.run(AnySupa(), [(ACCOUNT, "pw")], 30)
        self.assertEqual((status, total), ("partial", 0))
        self.assertIn("unreadable", error)
        self.assertClean(cap.text + error)
        self.assertNoTracebacks(cap)

    def test_account_read_and_store_failures(self):
        login = f"[AUTHENTICATIONFAILED] {EXC} for {ACCOUNT}".encode()
        with Capture() as cap, fake_imap(MailIMAP(login_error=login)):
            status, _, error = u.run(AnySupa(), [(ACCOUNT, "pw")], 30)
        self.assertEqual(status, "failed")
        self.assertIn("account_read_failed:imap_auth", error)
        self.assertClean(cap.text + error)
        failing = AnySupa(fail_with=Exception(f"Failing row contains ({ACCOUNT}, {SUBJ}) {EXC}"))
        with Capture() as cap, fake_imap(MailIMAP(urgent_mail())):
            status, _, error = u.run(failing, [(ACCOUNT, "pw")], 30)
        self.assertIn("account_store_failed:unexpected_error", error)
        self.assertClean(cap.text + error)
        self.assertNoTracebacks(cap)

    def test_fatal(self):
        supa = AnySupa()
        with Capture() as cap, fake_supabase(supa), self.write_mode(u):
            u.fatal(RuntimeError(f"{EXC} {ACCOUNT} {SUBJ}"))
        self.assertEqual([h["error_message"] for h in supa.heartbeats()], ["fatal:runtime_error"])
        self.assertClean(cap.text)
        self.assertNoTracebacks(cap)


# ---------------------------------------------------------------------------
# flights_email_etl
# ---------------------------------------------------------------------------

def flights_mail():
    return [
        raw_email(f"Your Flight Receipt - {SUBJ}", f"Delta <{SENDER.replace('example.org', 't.delta.com')}>",
                  f"Confirmation Number: {CONF}\nName: SENTINEL TRAVELER\n{BODY}", "<sentinel-f1@t.delta.com>"),
        raw_email(f"It's Time To Check In For Your Flight {SUBJ}", "Delta <checkin@t.delta.com>",
                  f"{FAIL} {BODY}", "<sentinel-f2@t.delta.com>"),
    ]


def run_main(module, argv, *fakes, supa=None):
    supa = supa if supa is not None else AnySupa()
    with Capture() as cap, fake_supabase(supa), fake_imap(*fakes), \
            mock.patch.dict(os.environ, IMAP_ENV), mock.patch.object(sys, "argv", argv):
        rc = module.main()
    return rc, cap, supa


class FlightsSentinels(Clean):
    def _parse_or_fail(self):
        original = f.parse_email

        def parse(kind, lines, email_date):
            if any(FAIL in l for l in lines):
                raise ValueError(f"{EXC} {SUBJ} {CONF}")
            return original(kind, lines, email_date)
        return mock.patch.object(f, "parse_email", side_effect=parse)

    def test_routine_and_per_message(self):
        with self._parse_or_fail():
            rc, cap, supa = run_main(f, ["flights_email_etl.py", "--days", "30"], MailIMAP(flights_mail()))
        self.assertEqual(rc, 0)
        [hb] = supa.heartbeats()
        self.assertEqual(hb["status"], "partial")
        self.assertIn("1 email(s) failed to parse", hb["error_message"])
        self.assertClean(cap.text + hb["error_message"])
        self.assertNoTracebacks(cap)
        errors = [row.get("error") for table, row in supa.upserts if table == "flight_email_log" and row.get("status") == "error"]
        self.assertEqual(errors, ["message_failed:checkin:value_error"], "the stored error is a code too")

    def test_dry_run(self):
        with self._parse_or_fail():
            rc, cap, _ = run_main(f, ["flights_email_etl.py", "--dry-run"], MailIMAP(flights_mail()))
        self.assertEqual(rc, 0)
        self.assertClean(cap.text)

    def test_account_failure(self):
        login = f"[AUTHENTICATIONFAILED] {EXC} for {ACCOUNT}".encode()
        rc, cap, supa = run_main(f, ["flights_email_etl.py"], MailIMAP(login_error=login))
        self.assertEqual(rc, 1)
        [hb] = supa.heartbeats()
        self.assertEqual(hb["status"], "failed")
        self.assertIn("account_failed:imap_auth", hb["error_message"])
        self.assertClean(cap.text + hb["error_message"])
        self.assertNoTracebacks(cap)

    def test_fatal(self):
        supa = AnySupa()
        with Capture() as cap, fake_supabase(supa), self.write_mode(f):
            f.fatal(KeyError(f"{EXC} {ACCOUNT}"))
        self.assertEqual([h["error_message"] for h in supa.heartbeats()], ["fatal:missing_key"])
        self.assertClean(cap.text)

    def test_file_output_is_flags_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "receipt_synthetic.txt"
            path.write_text(f"Confirmation Number: {CONF}\nName: SENTINEL TRAVELER\n{BODY}\n", encoding="utf-8")
            with Capture() as cap:
                f.run_file(str(path))
        self.assertIn('"confirmation": "found"', cap.text)
        self.assertClean(cap.text, "SENTINEL TRAVELER")

    def test_tz_proposals_log_counts_only(self):
        store = f.Store(AnySupa(), dry_run=True)
        with Capture() as cap:
            f.apply_tz_entries(store, [{"effective_from": "2026-11-01T10:00:00+00:00", "tz": "Europe/Madrid",
                                        "notes": f"flight-auto: DL1 ATL→MAD conf {CONF}"}])
        self.assertIn("1 proposal(s)", cap.text)
        self.assertClean(cap.text, "Europe/Madrid", "ATL")


# ---------------------------------------------------------------------------
# delivery_email_etl
# ---------------------------------------------------------------------------

def delivery_mail():
    subject = f"[{SUBJ}] Your Monday evening order with Uber Eats"
    return [
        raw_email(subject, "Uber Receipts <noreply@uber.com>",
                  f"Nov 9, 2026 7:57 PM\nHere's your receipt for {MERCHANT}.\nTotal $12.34\n{BODY}",
                  "<sentinel-d1@uber.com>"),
        raw_email(subject, "Uber Receipts <noreply@uber.com>", f"{BODY} nothing parseable here", "<sentinel-d2@uber.com>"),
        raw_email(subject, "Uber Receipts <noreply@uber.com>", f"{FAIL} {BODY}", "<sentinel-d3@uber.com>"),
    ]


class DeliverySentinels(Clean):
    def _parse_or_fail(self):
        original = d.parse_receipt

        def parse(lines):
            if any(FAIL in l for l in lines):
                raise ValueError(f"{EXC} {MERCHANT}")
            return original(lines)
        return mock.patch.object(d, "parse_receipt", side_effect=parse)

    def test_routine_unmatched_and_per_message(self):
        with self._parse_or_fail():
            rc, cap, supa = run_main(d, ["delivery_email_etl.py", "--days", "30"], MailIMAP(delivery_mail()))
        self.assertEqual(rc, 0)
        [hb] = supa.heartbeats()
        self.assertEqual(hb["status"], "partial")
        self.assertIn("1 error(s), 1 unmatched", hb["error_message"])
        self.assertIn("1 order write(s)", cap.text)
        self.assertClean(cap.text + hb["error_message"], "12.34")
        self.assertNoTracebacks(cap)
        errors = [row.get("error") for table, row in supa.upserts if table == "delivery_email_log" and row.get("status") == "error"]
        self.assertEqual(errors, ["message_failed:value_error"])

    def test_dry_run_summary(self):
        with self._parse_or_fail():
            rc, cap, _ = run_main(d, ["delivery_email_etl.py", "--dry-run"], MailIMAP(delivery_mail()))
        self.assertEqual(rc, 0)
        self.assertIn("dry run: 1 order(s)", cap.text)
        self.assertClean(cap.text, "12.34", "restaurant")

    def test_account_failure(self):
        rc, cap, supa = run_main(d, ["delivery_email_etl.py"],
                                 MailIMAP(login_error=f"[AUTHENTICATIONFAILED] {EXC} {ACCOUNT}".encode()))
        self.assertEqual(rc, 1)
        [hb] = supa.heartbeats()
        self.assertIn("account_failed:imap_auth", hb["error_message"])
        self.assertClean(cap.text + hb["error_message"])

    def test_fatal(self):
        supa = AnySupa()
        with Capture() as cap, fake_supabase(supa), self.write_mode(d):
            d.fatal(OSError(f"{EXC} {ACCOUNT}"))
        self.assertEqual([h["error_message"] for h in supa.heartbeats()], ["fatal:os_error"])
        self.assertClean(cap.text)

    def test_file_output_is_flags_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "receipt.txt"
            path.write_text(f"Nov 9, 2026 7:57 PM\nHere's your receipt for {MERCHANT}.\nTotal $12.34\n{BODY}\n",
                            encoding="utf-8")
            with Capture() as cap:
                d.run_file(str(path))
        self.assertIn('"merchant": "found"', cap.text)
        self.assertIn('"row": "buildable"', cap.text)
        self.assertClean(cap.text, "12.34", "2026-11-09")


# ---------------------------------------------------------------------------
# orders_email_etl
# ---------------------------------------------------------------------------

def orders_mail():
    sender = f"Sentinel Shop <{SENDER}>"
    return [
        raw_email(f"Your order {ORDER_NO} has shipped {SUBJ}", sender, f"Order number: {ORDER_NO}\n{BODY}",
                  "<sentinel-o1@example.org>", to="Pat Example <pat@example.com>"),
        raw_email(f"Your order {ORDER_NO} was delivered {SUBJ}", sender, f"{FAIL} {BODY}",
                  "<sentinel-o2@example.org>", to="Pat Example <pat@example.com>"),
    ]


class OrdersSentinels(Clean):
    def _parse_or_fail(self):
        original = o.parse_message

        def parse(header, lines, hrefs):
            if any(FAIL in l for l in lines):
                raise ValueError(f"{EXC} {ORDER_NO}")
            return original(header, lines, hrefs)
        return mock.patch.object(o, "parse_message", side_effect=parse)

    def test_routine_and_per_message(self):
        with self._parse_or_fail(), Capture() as cap, fake_imap(MailIMAP(orders_mail())):
            status, total, error = o.run(None, [(ACCOUNT, "pw")], 45, dry_run=True)
        self.assertEqual(status, "partial")
        self.assertIn("1 email(s) failed to parse", error)
        self.assertClean(cap.text + error)
        self.assertNoTracebacks(cap)

    def test_error_row_note_is_a_code(self):
        synced = datetime.now(timezone.utc).isoformat()
        with self._parse_or_fail(), fake_imap(MailIMAP(orders_mail())):
            rows, stats = o.process_account(ACCOUNT, "pw", date(2026, 1, 1), set(), False, synced)
        [err] = [r for r in rows if r["parse_status"] == "error"]
        self.assertEqual(err["note"], "parse_error:value_error")
        self.assertIsNone(err["subject"])

    def test_account_failure(self):
        with Capture() as cap, fake_imap(MailIMAP(login_error=f"[AUTHENTICATIONFAILED] {EXC} {ACCOUNT}".encode())):
            status, _, error = o.run(None, [(ACCOUNT, "pw")], 45, dry_run=True)
        self.assertEqual(status, "failed")
        self.assertIn("account_failed:imap_auth", error)
        self.assertClean(cap.text + error)

    def test_run_failure_in_main(self):
        supa = AnySupa(fail_with=Exception(f"{EXC} Failing row contains ({ACCOUNT})"), fail_tables={"online_order_events"})
        rc, cap, supa = run_main(o, ["orders_email_etl.py"], supa=supa)
        self.assertEqual(rc, 1)
        [hb] = supa.heartbeats()
        self.assertEqual((hb["status"], hb["error_message"]), ("failed", "run_failed:unexpected_error"))
        self.assertClean(cap.text)

    def test_recompute_refusal_is_coded(self):
        self.assertEqual(s.error_code(o.RecomputeRefused("x"), o.ERROR_CODES), "recompute_refused")
        self.assertEqual(s.error_code(o.SearchFailed("x"), o.ERROR_CODES), "search_failed")

    def test_fatal(self):
        supa = AnySupa()
        with Capture() as cap, fake_supabase(supa), self.write_mode(o):
            o.fatal(o.RecomputeRefused(f"{EXC}"))
        self.assertEqual([h["error_message"] for h in supa.heartbeats()], ["fatal:recompute_refused"])
        self.assertClean(cap.text)

    def test_file_output_is_flags_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "order.eml"
            path.write_bytes(orders_mail()[0])
            with Capture() as cap:
                o.run_file(str(path))
        self.assertIn("parsed", cap.text)
        self.assertClean(cap.text, "Pat Example")


class DeliveryRetryWindow(Clean):
    def test_widened_window_logs_a_stage_not_the_private_date(self):
        store = d.Store(None, dry_run=True)
        with Capture() as cap, fake_imap(MailIMAP(delivery_mail()[:1])), \
                mock.patch.object(d.Store, "oldest_error_day", return_value=date(2024, 2, 29)):
            stats = d.process_account(ACCOUNT, "pw", store, date(2026, 11, 1), False)
        self.assertEqual(stats["candidates"], 1)
        self.assertIn("retry_window_widened", cap.text)
        self.assertIn("window=widened", cap.text)
        self.assertClean(cap.text, "2024", "02-28", "02-29")


class ReadOnlyCrashPaths(Clean):
    """--dry-run and --file never create a database client or write a heartbeat, even when they crash;
    an out-of-range --days is rejected by argparse before anything runs."""

    def _cli(self, module, argv, crash=None):
        supa = AnySupa()
        patches = [mock.patch.object(sys, "argv", argv), mock.patch.dict(os.environ, IMAP_ENV)]
        if crash:
            patches.append(mock.patch.object(module, crash, side_effect=RuntimeError(f"{EXC} {ACCOUNT}")))
        with Capture() as cap, fake_supabase(supa), fake_imap(), contextlib.ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            try:
                rc = module.cli()
            except SystemExit as e:
                rc = ("exit", e.code)
        return rc, supa, cap

    def test_dry_run_and_file_crashes_write_nothing(self):
        missing = str(ROOT / "tests" / "no-such-synthetic-input.eml")
        cases = [
            (u, ["urgent_email_etl.py", "--dry-run"], "imap_accounts"),
            (f, ["flights_email_etl.py", "--dry-run"], "imap_accounts"),
            (f, ["flights_email_etl.py", "--file", missing], None),
            (d, ["delivery_email_etl.py", "--dry-run"], "imap_accounts"),
            (d, ["delivery_email_etl.py", "--file", missing], None),
            (o, ["orders_email_etl.py", "--dry-run"], "imap_accounts"),
            (o, ["orders_email_etl.py", "--file", missing], None),
        ]
        for module, argv, crash in cases:
            with self.subTest(argv=argv[1:]):
                rc, supa, cap = self._cli(module, argv, crash)
                self.assertEqual(rc, 1)
                self.assertEqual(supa.heartbeats(), [], "no heartbeat after a read-only invocation")
                self.assertEqual((supa.inserts, supa.upserts), ([], []))
                if module is not f or "--file" in argv:
                    self.assertEqual(supa.created, 0, "no database client at all")
                self.assertIn("fatal:", cap.text)
                self.assertClean(cap.text)
                self.assertFalse(module.HEARTBEAT.allowed)

    def test_out_of_range_days_is_rejected_for_every_etl(self):
        for module, name in ((u, "urgent"), (f, "flights"), (d, "delivery"), (o, "orders")):
            for mode in (["--dry-run"], []):
                with self.subTest(etl=name, mode=mode):
                    rc, supa, _ = self._cli(module, [f"{name}_email_etl.py", *mode, "--days", "1000000000"])
                    self.assertEqual(rc, ("exit", 2))
                    self.assertEqual((supa.created, supa.heartbeats()), (0, []))

    def test_write_mode_crash_still_heartbeats(self):
        for module, name in ((u, "urgent"), (d, "delivery"), (o, "orders"), (f, "flights")):
            with self.subTest(etl=name):
                rc, supa, cap = self._cli(module, [f"{name}_email_etl.py"], "imap_accounts")
                self.assertEqual(rc, 1)
                self.assertEqual([h["error_message"] for h in supa.heartbeats()], ["fatal:runtime_error"])
                self.assertClean(cap.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
