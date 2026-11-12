"""urgent_email_etl: read-only IMAP use, label parsing, row shape, stale-label clearing, heartbeat status.

Offline: a fake IMAP server and a fake Supabase client. Every message is invented and every
address uses the reserved example domains.

Run: python tests/test_urgent_email_etl.py
"""
import io
import logging
import os
import sys
import unittest
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import urgent_email_etl as u  # noqa: E402

ACCT_A, ACCT_B = "owner@example.com", "second@example.com"


def raw_email(subject, sender, date, mid, body):
    m = EmailMessage()
    m["Subject"], m["From"], m["Date"], m["Message-ID"] = subject, sender, date, mid
    m.set_content(body)
    return m.as_bytes()


MESSAGES = {
    b"101": dict(thr="1000000000000000101", gm="1000000000000000101",
                 labels=b'("\\\\Inbox" "Agent/Deadline" "Agent/Triaged")', flags=b"()",
                 raw=raw_email("Ballot closes soon", "Race Org <info@race.example>", "Tue, 10 Nov 2026 14:00:00 +0000",
                               "<ballot-1@race.example>", "The ballot closes in 48 hours.͏ ͏ Enter now.")),
    b"102": dict(thr="1000000000000000102", gm="1000000000000000102",
                 labels=b"(\\Important Agent/Action)", flags=b"(\\Seen)",
                 raw=raw_email("Review requested", "Code Host <noreply@code.example>", "Fri, 06 Nov 2026 16:00:51 +0000",
                               "<review-2@code.example>", "Someone asked for your review. https://code.example/x")),
    b"103": dict(thr="1000000000000000103", gm="1000000000000000103",
                 labels=b'("\\\\Inbox" "Agent/Triaged")', flags=b"()",
                 raw=raw_email("No agent label", "x@example.com", "Fri, 06 Nov 2026 16:00:51 +0000", "<n-3@example.com>", "hi")),
}


class FakeIMAP:
    def __init__(self, messages=MESSAGES, fail_login=False, raw_search=True):
        self.messages, self.fail_login, self.raw_search = messages, fail_login, raw_search
        self.commands, self.selected = [], []

    def login(self, user, password):
        self.commands.append(("LOGIN",))
        if self.fail_login:
            raise u.imaplib.IMAP4.error("[AUTHENTICATIONFAILED] Invalid credentials")

    def list(self):
        return "OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\All \\HasNoChildren) "/" "[Gmail]/All Mail"']

    def select(self, name, readonly=False):
        self.selected.append((name, readonly))
        return "OK", [b"3"]

    def uid(self, cmd, *args):
        self.commands.append((cmd, *args))
        if cmd == "SEARCH":
            if args[1] == "X-GM-RAW" and not self.raw_search:
                raise u.imaplib.IMAP4.error("unknown search key")
            return "OK", [b" ".join(self.messages)]
        if cmd == "FETCH":
            uids, item = args[0].split(b","), args[1]
            out = []
            for n, uid in enumerate(uids, 1):
                m = self.messages[uid]
                if "X-GM-LABELS" in item:
                    out.append(b"%d (X-GM-THRID %s X-GM-MSGID %s X-GM-LABELS %s UID %s FLAGS %s RFC822.SIZE %d)" % (
                        n, m["thr"].encode(), m["gm"].encode(), m["labels"], uid, m["flags"], len(m["raw"])))
                elif "HEADER.FIELDS" in item:
                    header = m["raw"].split(b"\n\n", 1)[0] + b"\n\n"
                    out += [(b"%d (UID %s BODY[HEADER.FIELDS (SUBJECT DATE MESSAGE-ID FROM)] {%d}" % (n, uid, len(header)), header), b")"]
                else:
                    out += [(b"%d (UID %s BODY[] {%d}" % (n, uid, len(m["raw"])), m["raw"]), b")"]
            return "OK", out
        raise AssertionError(f"unexpected IMAP command {cmd}")

    def logout(self):
        self.commands.append(("LOGOUT",))


class FakeQuery:
    def __init__(self, log, table):
        self.log, self.table, self.op = log, table, None

    def upsert(self, rows, on_conflict=None):
        self.op = ("upsert", self.table, rows, on_conflict)
        return self

    def update(self, values):
        self.op = ["update", self.table, values, []]
        return self

    def eq(self, col, val):
        self.op[3].append(("eq", col, val))
        return self

    def lt(self, col, val):
        self.op[3].append(("lt", col, val))
        return self

    def execute(self):
        self.log.append(self.op)
        return self


class FakeSupa:
    def __init__(self):
        self.log = []

    def schema(self, name):
        assert name == "pds"
        return self

    def table(self, name):
        return FakeQuery(self.log, name)


def run_with(fakes, accounts, supa=None, days=30):
    queue = list(fakes)
    original = u.imaplib.IMAP4_SSL
    u.imaplib.IMAP4_SSL = lambda host: queue.pop(0)
    try:
        return u.run(supa, accounts, days, dry_run=supa is None)
    finally:
        u.imaplib.IMAP4_SSL = original


class ParsingTests(unittest.TestCase):
    def test_label_list_quoted_and_atoms(self):
        self.assertEqual(u.parse_label_list(b'"\\\\Inbox" "Agent/Action" \\Important "Two Words"'),
                         ["\\Inbox", "Agent/Action", "\\Important", "Two Words"])

    def test_attrs(self):
        a = u.parse_attrs(b'7 (X-GM-THRID 42 X-GM-MSGID 43 X-GM-LABELS ("\\\\Inbox" "agent/deadline" "Agent/Action") UID 9 FLAGS (\\Seen \\Flagged) RFC822.SIZE 1200)')
        self.assertEqual((a["uid"], a["thread_id"], a["gmail_message_id"], a["size"]), (b"9", "42", "43", 1200))
        self.assertEqual(a["agent_labels"], ["Agent/Action", "Agent/Deadline"])
        self.assertTrue(a["in_inbox"])
        self.assertFalse(a["unread"])
        b = u.parse_attrs(b"1 (X-GM-THRID 1 X-GM-MSGID 2 X-GM-LABELS () UID 3 FLAGS ())")
        self.assertEqual(b["agent_labels"], [])
        self.assertFalse(b["in_inbox"])
        self.assertTrue(b["unread"])
        self.assertIsNone(u.parse_attrs(b"garbage"))

    def test_snippet_strips_padding_links_and_is_bounded(self):
        self.assertEqual(u.clean_snippet(["Closes in 48 hours.͏ ͏​", "https://x.example/a Enter now."]),
                         "Closes in 48 hours. Enter now.")
        long = u.clean_snippet(["word " * 200])
        self.assertLessEqual(len(long), u.SNIPPET_MAX)
        self.assertIsNone(u.clean_snippet(["͏ ​"]))


class RunTests(unittest.TestCase):
    def test_read_only_imap_and_rows(self):
        fake, supa = FakeIMAP(), FakeSupa()
        status, total, error = run_with([fake], [(ACCT_A, "pw")], supa)
        self.assertEqual(fake.selected, [('"[Gmail]/All Mail"', True)], "mailbox must be selected readonly")
        for cmd in fake.commands:
            self.assertIn(cmd[0], ("LOGIN", "SEARCH", "FETCH", "LOGOUT"), "no STORE/COPY/MOVE/EXPUNGE ever")
            if cmd[0] == "FETCH" and "BODY" in cmd[2]:
                self.assertIn("BODY.PEEK[", cmd[2], "body reads must not set \\Seen")
        search = [c for c in fake.commands if c[0] == "SEARCH"][0]
        self.assertIn("label:agent-action", search[3])
        self.assertIn("label:agent-deadline", search[3])
        upserts = [op for op in supa.log if op[0] == "upsert"]
        self.assertEqual(len(upserts), 1)
        rows = {r["message_id"]: r for r in upserts[0][2]}
        self.assertEqual(upserts[0][3], "account,message_id")
        self.assertEqual(set(rows), {"ballot-1@race.example", "review-2@code.example"}, "unlabeled message is not stored")
        ballot, review = rows["ballot-1@race.example"], rows["review-2@code.example"]
        self.assertEqual(ballot["agent_labels"], ["Agent/Deadline"])
        self.assertTrue(ballot["in_inbox"] and ballot["is_unread"])
        self.assertEqual(ballot["gmail_thread_id"], "1000000000000000101")
        self.assertEqual(ballot["snippet"], "The ballot closes in 48 hours. Enter now.")
        self.assertEqual((ballot["from_name"], ballot["from_address"]), ("Race Org", "info@race.example"))
        self.assertEqual(ballot["received_at"], "2026-11-10T14:00:00+00:00")
        self.assertEqual(review["agent_labels"], ["Agent/Action"])
        self.assertFalse(review["in_inbox"] or review["is_unread"])
        self.assertNotIn("http", review["snippet"])
        for r in rows.values():
            self.assertEqual(set(r) & {"body", "html", "to", "recipients"}, set())
        self.assertEqual((status, total), ("partial", 2), "required accounts missing -> partial")
        self.assertIn("not configured", error)

    def test_rows_not_seen_are_unlabeled_not_deleted(self):
        supa = FakeSupa()
        run_with([FakeIMAP()], [(ACCT_A, "pw")], supa)
        updates = [op for op in supa.log if op[0] == "update"]
        self.assertEqual(len(updates), 1)
        _, table, values, filters = updates[0]
        self.assertEqual((table, values["labeled"]), ("inbox_emails", False))
        self.assertIn(("eq", "account", ACCT_A), filters)
        self.assertIn(("eq", "labeled", True), filters)
        self.assertEqual([f[1] for f in filters if f[0] == "lt"], ["last_seen_at"])
        self.assertTrue(all(op[0] in ("upsert", "update") for op in supa.log), "never deletes")

    def test_empty_search_still_clears_stale_rows(self):
        supa = FakeSupa()
        status, total, _ = run_with([FakeIMAP(messages={})], [(ACCT_A, "pw")], supa)
        self.assertEqual(total, 0)
        self.assertEqual([op[0] for op in supa.log], ["update"])

    def test_label_search_fallback(self):
        fake = FakeIMAP(raw_search=False)
        run_with([fake], [(ACCT_A, "pw")], FakeSupa())
        self.assertEqual([c[2] for c in fake.commands if c[0] == "SEARCH"], ["X-GM-RAW", "X-GM-LABELS", "X-GM-LABELS"])

    def test_heartbeat_status(self):
        required = [(a, "pw") for a in u.REQUIRED_ACCOUNTS]
        self.assertEqual(run_with([FakeIMAP(), FakeIMAP()], required, FakeSupa())[0], "success")
        one_failed = run_with([FakeIMAP(), FakeIMAP(fail_login=True)], required, FakeSupa())
        self.assertEqual(one_failed[0], "partial")
        self.assertNotIn("pw", one_failed[2])
        self.assertEqual(run_with([FakeIMAP(fail_login=True)], [(ACCT_A, "pw")], FakeSupa())[0], "failed")
        self.assertEqual(run_with([], [], FakeSupa())[:2], ("failed", 0))

    def test_dry_run_touches_no_database_and_logs_no_content(self):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        u.log.addHandler(handler)
        try:
            status, total, _ = run_with([FakeIMAP()], [(ACCT_A, "pw")], None)
        finally:
            u.log.removeHandler(handler)
        self.assertEqual(total, 2)
        text = stream.getvalue()
        for secret in ("Ballot closes soon", "Review requested", "race.example", ACCT_A):
            self.assertNotIn(secret, text, "CI logs are public: counts only")


if __name__ == "__main__":
    unittest.main(verbosity=2)
