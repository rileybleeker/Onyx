"""urgent_email_etl: read-only IMAP use, label parsing, row shape, conservative reconciliation, heartbeat status.

Offline: a fake IMAP server and a stateful fake Supabase table. Every message is invented and every
address uses the reserved example domains.

Reconciliation contract under test: a stored row is set labeled=false ONLY when a complete, all-age
Agent/* label membership was read in verified All Mail and the row's Gmail message id is absent from
it. Every unknown (failed / malformed / partial / INBOX fallback / over cap) keeps the row.

Run: python tests/test_urgent_email_etl.py
"""
import io
import logging
import os
import sys
import unittest
from email.message import EmailMessage
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import urgent_email_etl as u  # noqa: E402

ACCT_A, ACCT_B = "owner@example.com", "second@example.com"
OLD_SEEN = "2000-01-01T00:00:00+00:00"


def raw_email(subject, sender, date, mid, body):
    m = EmailMessage()
    if subject is not None:
        m["Subject"] = subject
    m["From"], m["Date"] = sender, date
    if mid is not None:
        m["Message-ID"] = mid
    m.set_content(body)
    return m.as_bytes()


def render_labels(labels):
    return b"(" + b" ".join(b'"' + l.replace("\\", "\\\\").encode() + b'"' for l in labels) + b")"


def msg(n, labels, subject="Synthetic notice", sender="Sender Example <sender@example.org>",
        date="Tue, 10 Nov 2026 14:00:00 +0000", body="Synthetic body text.", mid="default", flags=b"()"):
    gm = str(1000000000000000000 + n)
    if mid == "default":
        mid = f"<synthetic-{n}@example.org>"
    return dict(thr=gm, gm=gm, labels=render_labels(labels) if isinstance(labels, list) else labels,
                flags=flags, raw=raw_email(subject, sender, date, mid, body))


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
    """Read-only Gmail stand-in. `window` = UIDs the dated search returns (defaults to all);
    the membership search (X-GM-LABELS without SINCE) returns every UID carrying the label, any age."""

    def __init__(self, messages=None, window=None, fail_login=False, raw_search=True, all_mail=True,
                 fail_fetch=None, drop_labels=(), drop_msgid=(), membership_status="OK",
                 membership_malformed=False, membership_exclude=()):
        self.messages = dict(MESSAGES if messages is None else messages)
        self.window = sorted(self.messages if window is None else window, key=int)
        self.fail_login, self.raw_search, self.all_mail = fail_login, raw_search, all_mail
        self.fail_fetch = fail_fetch or {}
        self.drop_labels, self.drop_msgid = set(drop_labels), set(drop_msgid)
        self.membership_status, self.membership_malformed = membership_status, membership_malformed
        self.membership_exclude = set(membership_exclude)
        self.commands, self.selected = [], []

    def login(self, user, password):
        self.commands.append(("LOGIN",))
        if self.fail_login:
            raise u.imaplib.IMAP4.error(b"[AUTHENTICATIONFAILED] Invalid credentials (Failure)")

    def list(self):
        boxes = [b'(\\HasNoChildren) "/" "INBOX"']
        if self.all_mail:
            boxes.append(b'(\\All \\HasNoChildren) "/" "[Gmail]/All Mail"')
        return "OK", boxes

    def select(self, name, readonly=False):
        self.selected.append((name, readonly))
        return "OK", [str(len(self.messages)).encode()]

    def _has(self, uid, label):
        return label.lower().encode() in self.messages[uid]["labels"].lower()

    def uid(self, cmd, *args):
        self.commands.append((cmd, *args))
        if cmd == "SEARCH":
            if args[1] == "X-GM-RAW":
                if not self.raw_search:
                    raise u.imaplib.IMAP4.error("unknown search key")
                return "OK", [b" ".join(self.window)]
            label = args[2].strip('"')
            if "SINCE" in args:
                return "OK", [b" ".join(x for x in self.window if self._has(x, label))]
            if self.membership_status != "OK":
                return self.membership_status, [b"failure"]
            if self.membership_malformed:
                return "OK", [b"12 not-a-uid"]
            hits = [x for x in sorted(self.messages, key=int) if self._has(x, label) and x not in self.membership_exclude]
            return "OK", [b" ".join(hits)]
        if cmd == "FETCH":
            uids, item = args[0].split(b","), args[1]
            kind = ("attrs" if "X-GM-LABELS" in item else "msgid" if item == "(X-GM-MSGID)"
                    else "headers" if "HEADER.FIELDS" in item else "body")
            if set(uids) & set(self.fail_fetch.get(kind, ())):
                return "NO", [b"Some messages could not be FETCHed (Failure)"]
            out = []
            for n, uid in enumerate(uids, 1):
                m = self.messages[uid]
                if kind == "attrs":
                    labels = b"" if uid in self.drop_labels else b"X-GM-LABELS %s " % m["labels"]
                    out.append(b"%d (X-GM-THRID %s X-GM-MSGID %s %sUID %s FLAGS %s RFC822.SIZE %d)" % (
                        n, m["thr"].encode(), m["gm"].encode(), labels, uid, m["flags"], len(m["raw"])))
                elif kind == "msgid":
                    if uid not in self.drop_msgid:
                        out.append(b"%d (X-GM-MSGID %s UID %s)" % (n, m["gm"].encode(), uid))
                elif kind == "headers":
                    header = m["raw"].split(b"\n\n", 1)[0] + b"\n\n"
                    out += [(b"%d (UID %s BODY[HEADER.FIELDS (SUBJECT DATE MESSAGE-ID FROM)] {%d}" % (n, uid, len(header)), header), b")"]
                else:
                    out += [(b"%d (UID %s BODY[] {%d}" % (n, uid, len(m["raw"])), m["raw"]), b")"]
            return "OK", out
        raise AssertionError(f"unexpected IMAP command {cmd}")

    def logout(self):
        self.commands.append(("LOGOUT",))


DEFAULTS = {"subject": "", "snippet": None, "from_name": None, "is_unread": True, "in_inbox": True,
            "labeled": True, "agent_labels": [], "gmail_thread_id": None, "gmail_message_id": None}


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.kind, self.payload, self.filters, self.rng, self.cols = None, None, [], None, None

    def upsert(self, rows, on_conflict=None):
        self.kind, self.payload, self.on_conflict = "upsert", rows, on_conflict
        return self

    def update(self, values):
        self.kind, self.payload = "update", values
        return self

    def select(self, cols):
        self.kind, self.cols = "select", cols.split(",")
        return self

    def eq(self, col, val):
        self.filters.append(("eq", col, val))
        return self

    def lt(self, col, val):
        self.filters.append(("lt", col, val))
        return self

    def order(self, col):
        return self

    def range(self, a, b):
        self.rng = (a, b)
        return self

    def _match(self, row):
        for op, col, val in self.filters:
            if op == "eq" and row.get(col) != val:
                return False
            if op == "lt" and not (row.get(col) is not None and row[col] < val):
                return False
        return True

    def execute(self):
        if self.db.fail is not None:
            raise self.db.fail
        self.db.log.append((self.kind, self.table, self.payload, list(self.filters)))
        if self.kind == "upsert":
            assert self.on_conflict == "account,message_id"
            assert len({tuple(sorted(r)) for r in self.payload}) == 1, "PostgREST bulk upserts need uniform keys"
            for r in self.payload:
                key = (r["account"], r["message_id"])
                if key in self.db.rows:
                    self.db.rows[key].update(r)          # ON CONFLICT DO UPDATE: only the columns sent
                else:
                    self.db.rows[key] = {**DEFAULTS, **r}
            return SimpleNamespace(data=self.payload)
        if self.kind == "update":
            hit = [r for r in self.db.rows.values() if self._match(r)]
            for r in hit:
                r.update(self.payload)
            return SimpleNamespace(data=hit)
        if self.kind == "select":
            hit = sorted((r for r in self.db.rows.values() if self._match(r)), key=lambda r: r["message_id"])
            if self.rng:
                hit = hit[self.rng[0]:self.rng[1] + 1]
            return SimpleNamespace(data=[{c: r.get(c) for c in self.cols} for r in hit])
        raise AssertionError(f"unexpected query {self.kind}")


class FakeSupa:
    """pds.inbox_emails as a dict keyed (account, message_id). No delete(): a delete would raise."""

    def __init__(self, rows=()):
        self.rows = {(r["account"], r["message_id"]): {**DEFAULTS, **r} for r in rows}
        self.log, self.fail = [], None

    def schema(self, name):
        assert name == "pds"
        return self

    def table(self, name):
        assert name == "inbox_emails"
        return FakeQuery(self, name)

    def ops(self, kind):
        return [op for op in self.log if op[0] == kind]

    def row(self, account, mid):
        return self.rows[(account, mid)]


def stored(account, mid, gm, **kw):
    return {"account": account, "message_id": mid, "gmail_message_id": gm, "received_at": "2026-09-01T00:00:00+00:00",
            "from_address": "sender@example.org", "subject": "Stored subject", "snippet": "Stored snippet.",
            "agent_labels": ["Agent/Action"], "labeled": True, "last_seen_at": OLD_SEEN, "synced_at": OLD_SEEN, **kw}


def run_with(fakes, accounts, supa=None, days=30, dry_run=None):
    queue = list(fakes)
    original = u.imaplib.IMAP4_SSL
    u.imaplib.IMAP4_SSL = lambda host: queue.pop(0)
    try:
        return u.run_detailed(supa, accounts, days, dry_run=(supa is None) if dry_run is None else dry_run)
    finally:
        u.imaplib.IMAP4_SSL = original


GM = lambda n: str(1000000000000000000 + n)  # noqa: E731


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
        self.assertEqual(b["agent_labels"], [], "an explicit empty label list is known-empty")
        self.assertTrue(b["labels_known"])
        self.assertFalse(b["in_inbox"])
        self.assertTrue(b["unread"])
        self.assertIsNone(u.parse_attrs(b"garbage"))

    def test_missing_or_malformed_labels_are_unknown_not_empty(self):
        for meta in (b"1 (X-GM-THRID 1 X-GM-MSGID 2 UID 3 FLAGS ())",              # item missing
                     b'1 (X-GM-MSGID 2 X-GM-LABELS ("Agent/Action UID 3)',         # unterminated quoted label
                     b"1 (UID 3)"):                                                # FLAGS missing too
            a = u.parse_attrs(meta)
            self.assertFalse(a["labels_known"])
            self.assertIsNone(a["agent_labels"])
            self.assertIsNone(a["in_inbox"])
        self.assertIsNone(u.parse_attrs(b"1 (UID 3)")["unread"], "missing FLAGS is unknown, not unread")

    def test_snippet_strips_padding_links_and_is_bounded(self):
        self.assertEqual(u.clean_snippet(["Closes in 48 hours.͏ ͏​", "https://x.example/a Enter now."]),
                         "Closes in 48 hours. Enter now.")
        long = u.clean_snippet(["word " * 200])
        self.assertLessEqual(len(long), u.SNIPPET_MAX)
        self.assertIsNone(u.clean_snippet(["͏ ​"]))

    def test_build_row_omits_unknown_fields(self):
        attrs = {"uid": b"5", "agent_labels": ["Agent/Action"], "thread_id": None, "gmail_message_id": None,
                 "unread": None, "in_inbox": None}
        header = EmailMessage()
        header["From"], header["Date"], header["Message-ID"] = "a@example.org", "Tue, 10 Nov 2026 14:00:00 +0000", "<m@example.org>"
        row = u.build_row(ACCT_A, attrs, header, None, "2026-11-15T00:00:00+00:00", snippet_known=False)
        for key in ("subject", "snippet", "from_name", "is_unread", "in_inbox", "gmail_thread_id", "gmail_message_id"):
            self.assertNotIn(key, row, f"{key} unknown -> left out so the stored value stays")
        self.assertEqual(row["message_id"], "m@example.org")
        self.assertIsNone(u.build_row(ACCT_A, dict(attrs, agent_labels=None), header, None, "x"), "unknown labels: no row")

    def test_row_gmail_id_and_classification(self):
        self.assertEqual(u.row_gmail_id({"gmail_message_id": "77", "message_id": "a@x"}), "77")
        self.assertEqual(u.row_gmail_id({"gmail_message_id": None, "message_id": "gmail:88"}), "88")
        self.assertIsNone(u.row_gmail_id({"gmail_message_id": None, "message_id": "a@x"}))
        rows = [{"message_id": "seen", "gmail_message_id": "1"}, {"message_id": "kept", "gmail_message_id": "2"},
                {"message_id": "gone", "gmail_message_id": "3"}, {"message_id": "noid", "gmail_message_id": None}]
        split = u.classify_rows(rows, {"seen"}, {"2"})
        self.assertEqual((split["seen"], split["retained"], split["clear"], split["unidentified"]),
                         (["seen"], ["kept"], ["gone"], ["noid"]))
        unknown = u.classify_rows(rows, {"seen"}, None)
        self.assertEqual((unknown["clear"], sorted(unknown["unknown"])), ([], ["gone", "kept", "noid"]))


class RefreshTests(unittest.TestCase):
    def test_read_only_imap_and_rows(self):
        fake, supa = FakeIMAP(), FakeSupa()
        r = run_with([fake], [(ACCT_A, "pw")], supa)
        status, total, error = r["status"], r["records"], r["error"]
        self.assertEqual(fake.selected, [('"[Gmail]/All Mail"', True)], "mailbox must be selected readonly")
        for cmd in fake.commands:
            self.assertIn(cmd[0], ("LOGIN", "SEARCH", "FETCH", "LOGOUT"), "no STORE/COPY/MOVE/EXPUNGE ever")
            if cmd[0] == "FETCH" and "BODY" in cmd[2]:
                self.assertIn("BODY.PEEK[", cmd[2], "body reads must not set \\Seen")
        search = [c for c in fake.commands if c[0] == "SEARCH"][0]
        self.assertIn("label:agent-action", search[3])
        self.assertIn("label:agent-deadline", search[3])
        upserts = supa.ops("upsert")
        rows = {r["message_id"]: r for op in upserts for r in op[2]}
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

    def test_over_cap_candidates_are_bounded_and_kept(self):
        n = u.MAX_MESSAGES + 5
        messages = {str(1000 + i).encode(): msg(i, ["\\Inbox", "Agent/Action"]) for i in range(n)}
        oldest = sorted(messages, key=int)[:5]
        supa = FakeSupa([stored(ACCT_A, f"synthetic-{int(x) - 1000}@example.org", GM(int(x) - 1000)) for x in oldest])
        fake = FakeIMAP(messages=messages)
        r = run_with([fake], [(ACCT_A, "pw")], supa)
        st = r["accounts"][0]["stats"]
        self.assertEqual((st["window_candidates"], st["messages"], st["dropped_by_cap"]), (n, u.MAX_MESSAGES, 5))
        self.assertEqual(r["records"], u.MAX_MESSAGES)
        body_uids = sum(len(c[1].split(b",")) for c in fake.commands if c[0] == "FETCH" and c[2] == "(BODY.PEEK[])")
        self.assertLessEqual(body_uids, u.MAX_MESSAGES, "body reads stay bounded by the cap")
        for x in oldest:
            row = supa.row(ACCT_A, f"synthetic-{int(x) - 1000}@example.org")
            self.assertTrue(row["labeled"], "a still-labeled message beyond the cap is never cleared")
            self.assertEqual(row["last_seen_at"], OLD_SEEN, "and was not refreshed")
        self.assertEqual(r["accounts"][0]["reconcile"]["retained"], 5)
        self.assertEqual(r["status"], "partial")
        self.assertIn("beyond the refresh cap", r["error"])

    def test_failed_attr_chunk_reads_nothing_and_keeps_rows(self):
        supa = FakeSupa([stored(ACCT_A, "ballot-1@race.example", "1000000000000000101")])
        r = run_with([FakeIMAP(fail_fetch={"attrs": {b"101"}})], [(ACCT_A, "pw")], supa)
        st = r["accounts"][0]["stats"]
        self.assertEqual((st["attr_failed_chunks"], st["attrs_missing"], r["records"]), (1, 3, 0))
        self.assertTrue(supa.row(ACCT_A, "ballot-1@race.example")["labeled"])
        self.assertEqual(supa.row(ACCT_A, "ballot-1@race.example")["subject"], "Stored subject")
        self.assertEqual(r["status"], "partial")
        self.assertIn("fetch chunk(s) failed", r["error"])

    def test_missing_label_item_is_unknown_and_keeps_the_row(self):
        supa = FakeSupa([stored(ACCT_A, "ballot-1@race.example", "1000000000000000101")])
        r = run_with([FakeIMAP(drop_labels={b"101"})], [(ACCT_A, "pw")], supa)
        st = r["accounts"][0]["stats"]
        self.assertEqual((st["labels_unknown"], st["unlabeled"]), (1, 1), "only 103 (explicit labels) is 'unlabeled'")
        row = supa.row(ACCT_A, "ballot-1@race.example")
        self.assertTrue(row["labeled"])
        self.assertEqual(row["last_seen_at"], OLD_SEEN, "unknown labels: not refreshed, not cleared")
        self.assertIn("labels 1", r["error"])

    def test_failed_body_keeps_stored_snippet_and_headers_gap_keeps_row(self):
        supa = FakeSupa([stored(ACCT_A, "ballot-1@race.example", "1000000000000000101", snippet="Earlier snippet.")])
        r = run_with([FakeIMAP(fail_fetch={"body": {b"101"}})], [(ACCT_A, "pw")], supa)
        row = supa.row(ACCT_A, "ballot-1@race.example")
        self.assertEqual(row["snippet"], "Earlier snippet.", "a failed body read never erases the snippet")
        self.assertNotEqual(row["last_seen_at"], OLD_SEEN, "the labels and headers were still refreshed")
        self.assertIn("snippet(s) not refreshed", r["error"])

        supa = FakeSupa([stored(ACCT_A, "ballot-1@race.example", "1000000000000000101")])
        r = run_with([FakeIMAP(fail_fetch={"headers": {b"101"}})], [(ACCT_A, "pw")], supa)
        self.assertEqual(r["accounts"][0]["stats"]["headers_missing"], 2)
        row = supa.row(ACCT_A, "ballot-1@race.example")
        self.assertTrue(row["labeled"])
        self.assertEqual((row["subject"], row["snippet"]), ("Stored subject", "Stored snippet."))

    def test_missing_subject_header_keeps_stored_subject(self):
        messages = {b"201": msg(201, ["Agent/Action"], subject=None)}
        supa = FakeSupa([stored(ACCT_A, "synthetic-201@example.org", GM(201), subject="Earlier subject")])
        run_with([FakeIMAP(messages=messages)], [(ACCT_A, "pw")], supa)
        self.assertEqual(supa.row(ACCT_A, "synthetic-201@example.org")["subject"], "Earlier subject")

    def test_mixed_known_and_unknown_snippets_upsert_in_uniform_batches(self):
        supa = FakeSupa()
        big = dict(msg(301, ["Agent/Action"]))
        big["raw"] = big["raw"] + b"x" * (u.MAX_BODY_BYTES + 1)     # over the body cap: snippet unknown
        messages = {b"301": big, b"302": msg(302, ["Agent/Deadline"])}
        r = run_with([FakeIMAP(messages=messages)], [(ACCT_A, "pw")], supa)
        self.assertEqual(r["records"], 2)
        self.assertEqual(r["accounts"][0]["stats"]["body_oversize"], 1)
        self.assertEqual(len(supa.ops("upsert")), 2, "rows with and without a snippet go in separate batches")
        self.assertIsNone(supa.row(ACCT_A, "synthetic-301@example.org")["snippet"], "new row: column default")


class ReconcileTests(unittest.TestCase):
    def test_explicit_label_removal_clears_only_that_row(self):
        messages = {b"401": msg(401, ["\\Inbox", "Agent/Action"]), b"402": msg(402, ["\\Inbox"])}   # 402 lost its label
        supa = FakeSupa([stored(ACCT_A, "synthetic-401@example.org", GM(401)),
                         stored(ACCT_A, "synthetic-402@example.org", GM(402))])
        r = run_with([FakeIMAP(messages=messages, window=[b"401"])], [(ACCT_A, "pw")], supa)
        self.assertTrue(supa.row(ACCT_A, "synthetic-401@example.org")["labeled"])
        self.assertFalse(supa.row(ACCT_A, "synthetic-402@example.org")["labeled"])
        updates = supa.ops("update")
        self.assertEqual(len(updates), 1)
        _, table, values, filters = updates[0]
        self.assertEqual((table, values["labeled"]), ("inbox_emails", False))
        self.assertIn(("eq", "account", ACCT_A), filters)
        self.assertIn(("eq", "message_id", "synthetic-402@example.org"), filters)
        self.assertIn(("eq", "labeled", True), filters)
        self.assertEqual([f[1] for f in filters if f[0] == "lt"], ["last_seen_at"])
        self.assertEqual(r["accounts"][0]["reconcile"]["cleared"], 1)
        self.assertTrue(all(op[0] in ("upsert", "update", "select") for op in supa.log), "never deletes")

    def test_still_labeled_older_than_window_is_kept(self):
        messages = {b"501": msg(501, ["Agent/Deadline"]), b"502": msg(502, ["Agent/Action"])}
        supa = FakeSupa([stored(ACCT_A, "synthetic-501@example.org", GM(501))])
        r = run_with([FakeIMAP(messages=messages, window=[b"502"])], [(ACCT_A, "pw")], supa)
        row = supa.row(ACCT_A, "synthetic-501@example.org")
        self.assertTrue(row["labeled"], "outside the 30-day window but still labeled: kept")
        self.assertEqual(r["accounts"][0]["reconcile"]["retained"], 1)
        self.assertEqual(supa.ops("update"), [])
        self.assertEqual(r["status"], "partial")      # only because the required accounts are not both configured

    def test_empty_search_with_complete_membership_clears_proven_rows_only(self):
        supa = FakeSupa([stored(ACCT_A, "gone@example.org", GM(601))])
        r = run_with([FakeIMAP(messages={})], [(ACCT_A, "pw")], supa)
        self.assertEqual(r["records"], 0)
        self.assertFalse(supa.row(ACCT_A, "gone@example.org")["labeled"], "complete empty membership proves removal")
        self.assertEqual([op[0] for op in supa.log if op[0] != "select"], ["update"])

        old = {b"602": msg(602, ["Agent/Action"])}
        supa = FakeSupa([stored(ACCT_A, "synthetic-602@example.org", GM(602))])
        run_with([FakeIMAP(messages=old, window=[])], [(ACCT_A, "pw")], supa)
        self.assertTrue(supa.row(ACCT_A, "synthetic-602@example.org")["labeled"], "empty window, old label still there")

    def test_every_unknown_membership_keeps_rows(self):
        cases = {
            "membership_search_failed": dict(membership_status="NO"),
            "membership_search_malformed": dict(membership_malformed=True),
            "membership_fetch_failed": dict(fail_fetch={"msgid": {b"101"}}),
            "membership_fetch_incomplete": dict(drop_msgid={b"102"}),
            "mailbox_not_all_mail": dict(all_mail=False),
        }
        for code, kw in cases.items():
            with self.subTest(code=code):
                supa = FakeSupa([stored(ACCT_A, "unlabeled-elsewhere@example.org", GM(999))])
                fake = FakeIMAP(**kw)
                r = run_with([fake], [(ACCT_A, "pw")], supa)
                self.assertTrue(supa.row(ACCT_A, "unlabeled-elsewhere@example.org")["labeled"])
                self.assertEqual(supa.ops("update"), [])
                self.assertEqual(r["accounts"][0]["stats"]["membership"], code)
                self.assertEqual(r["accounts"][0]["reconcile"]["unknown"], 1)
                self.assertEqual(r["status"], "partial")
                self.assertIn(f"reconcile=unknown({code})", r["error"])

    def test_inbox_fallback_refreshes_but_never_reconciles(self):
        fake = FakeIMAP(all_mail=False)
        supa = FakeSupa([stored(ACCT_A, "unlabeled-elsewhere@example.org", GM(999))])
        r = run_with([fake], [(ACCT_A, "pw")], supa)
        self.assertEqual(fake.selected, [("INBOX", True)])
        self.assertEqual(r["records"], 2, "labeled inbox mail is still refreshed")
        membership_searches = [c for c in fake.commands if c[0] == "SEARCH" and c[2] == "X-GM-LABELS" and "SINCE" not in c]
        self.assertEqual(membership_searches, [], "INBOX is never treated as All Mail")
        self.assertTrue(supa.row(ACCT_A, "unlabeled-elsewhere@example.org")["labeled"])
        self.assertIn("mailbox=inbox_fallback", r["error"])

    def test_membership_over_cap_is_unknown(self):
        original = u.MAX_MEMBERSHIP
        u.MAX_MEMBERSHIP = 1
        try:
            supa = FakeSupa([stored(ACCT_A, "unlabeled-elsewhere@example.org", GM(999))])
            r = run_with([FakeIMAP()], [(ACCT_A, "pw")], supa)
        finally:
            u.MAX_MEMBERSHIP = original
        self.assertEqual(r["accounts"][0]["stats"]["membership"], "membership_over_cap")
        self.assertTrue(supa.row(ACCT_A, "unlabeled-elsewhere@example.org")["labeled"])

    def test_row_refreshed_this_run_is_never_cleared(self):
        # The dated search saw 101 labeled, the membership search (racing a label change) did not.
        supa = FakeSupa([stored(ACCT_A, "ballot-1@race.example", "1000000000000000101")])
        r = run_with([FakeIMAP(membership_exclude={b"101"})], [(ACCT_A, "pw")], supa)
        self.assertTrue(supa.row(ACCT_A, "ballot-1@race.example")["labeled"])
        self.assertEqual(r["accounts"][0]["reconcile"]["seen"], 2, "101 and 102 were both refreshed")
        self.assertEqual(supa.ops("update"), [])

    def test_row_without_gmail_id_is_kept_and_reported(self):
        supa = FakeSupa([stored(ACCT_A, "legacy@example.org", None)])
        r = run_with([FakeIMAP()], [(ACCT_A, "pw")], supa)
        self.assertTrue(supa.row(ACCT_A, "legacy@example.org")["labeled"])
        self.assertEqual(r["accounts"][0]["reconcile"]["unidentified"], 1)
        self.assertIn("without a Gmail id", r["error"])

    def test_independent_accounts(self):
        supa = FakeSupa([stored(ACCT_A, "shared@example.org", GM(999)), stored(ACCT_B, "shared@example.org", GM(999))])
        r = run_with([FakeIMAP(membership_status="NO"), FakeIMAP()], [(ACCT_A, "pw"), (ACCT_B, "pw")], supa)
        self.assertTrue(supa.row(ACCT_A, "shared@example.org")["labeled"], "A's unknown reconcile keeps A's row")
        self.assertFalse(supa.row(ACCT_B, "shared@example.org")["labeled"], "B's complete reconcile clears B's row")
        for _, _, _, filters in supa.ops("update"):
            self.assertIn(("eq", "account", ACCT_B), filters)
        self.assertEqual(supa.row(ACCT_A, "ballot-1@race.example")["account"], ACCT_A)
        self.assertEqual(supa.row(ACCT_B, "ballot-1@race.example")["account"], ACCT_B, "identity is (account, message_id)")

    def test_recovery_and_repeated_processing(self):
        supa = FakeSupa([stored(ACCT_A, "unlabeled-elsewhere@example.org", GM(999))])
        run_with([FakeIMAP(fail_fetch={"msgid": {b"101"}})], [(ACCT_A, "pw")], supa)
        self.assertTrue(supa.row(ACCT_A, "unlabeled-elsewhere@example.org")["labeled"], "run 1 unknown: kept")
        r2 = run_with([FakeIMAP()], [(ACCT_A, "pw")], supa)
        self.assertFalse(supa.row(ACCT_A, "unlabeled-elsewhere@example.org")["labeled"], "run 2 complete: cleared")
        self.assertEqual(r2["accounts"][0]["reconcile"]["cleared"], 1)
        before = {k: dict(v) for k, v in supa.rows.items()}
        r3 = run_with([FakeIMAP()], [(ACCT_A, "pw")], supa)
        self.assertEqual(r3["accounts"][0]["reconcile"]["cleared"], 0, "nothing left to clear")
        self.assertEqual(set(supa.rows), set(before), "same identities, no duplicates")
        self.assertTrue(supa.row(ACCT_A, "ballot-1@race.example")["labeled"])

    def test_label_search_fallback(self):
        fake = FakeIMAP(raw_search=False)
        run_with([fake], [(ACCT_A, "pw")], FakeSupa())
        searches = [c for c in fake.commands if c[0] == "SEARCH"]
        self.assertEqual([c[2] for c in searches], ["X-GM-RAW", "X-GM-LABELS", "X-GM-LABELS", "X-GM-LABELS", "X-GM-LABELS"])
        self.assertTrue(all("SINCE" in c for c in searches[1:3]), "fallback window search is dated")
        self.assertTrue(all("SINCE" not in c for c in searches[3:]), "membership search has no date limit")


class RunTests(unittest.TestCase):
    def test_heartbeat_status(self):
        required = [(a, "pw") for a in u.REQUIRED_ACCOUNTS]
        self.assertEqual(run_with([FakeIMAP(), FakeIMAP()], required, FakeSupa())["status"], "success")
        one_failed = run_with([FakeIMAP(), FakeIMAP(fail_login=True)], required, FakeSupa())
        self.assertEqual(one_failed["status"], "partial")
        self.assertIn("account_read_failed:imap_auth", one_failed["error"])
        self.assertNotIn("pw", one_failed["error"])
        self.assertNotIn("Invalid credentials", one_failed["error"])
        self.assertEqual(run_with([FakeIMAP(fail_login=True)], [(ACCT_A, "pw")], FakeSupa())["status"], "failed")
        self.assertEqual(run_with([], [], FakeSupa())["status"], "failed")

    def test_run_keeps_its_tuple_interface(self):
        original = u.imaplib.IMAP4_SSL
        u.imaplib.IMAP4_SSL = lambda host: FakeIMAP()
        try:
            status, total, error = u.run(FakeSupa(), [(ACCT_A, "pw")], 30)
        finally:
            u.imaplib.IMAP4_SSL = original
        self.assertEqual((status, total), ("partial", 2))
        self.assertIsInstance(error, str)

    def test_missing_table_is_a_coded_failure_with_a_hint(self):
        class MissingTable(Exception):
            code = "PGRST205"
        supa = FakeSupa()
        supa.fail = MissingTable("relation pds.inbox_emails does not exist; row (owner@example.com, ...)")
        r = run_with([FakeIMAP()], [(ACCT_A, "pw")], supa)
        self.assertEqual(r["status"], "failed")
        self.assertIn("account_store_failed:db_table_missing", r["error"])
        self.assertIn("apply sql/inbox_emails_schema.sql", r["error"])
        self.assertNotIn(ACCT_A, r["error"])

    def test_dry_run_without_database_is_zero_write_and_reports_unknown(self):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        u.log.addHandler(handler)
        try:
            r = run_with([FakeIMAP()], [(ACCT_A, "pw")], None)
        finally:
            u.log.removeHandler(handler)
        self.assertEqual(r["records"], 2)
        rec = r["accounts"][0]["reconcile"]
        self.assertEqual((rec["upserted"], rec["cleared"]), (0, 0))
        self.assertIsNone(rec["would_clear"], "no database read: unknown, never guessed")
        self.assertIn("would-clear count unknown", r["error"])
        text = stream.getvalue()
        for secret in ("Ballot closes soon", "Review requested", "race.example", ACCT_A):
            self.assertNotIn(secret, text, "CI logs are public: counts only")

    def test_dry_run_with_database_reads_only_and_counts(self):
        messages = {b"701": msg(701, ["Agent/Action"]), b"702": msg(702, ["\\Inbox"]), b"703": msg(703, ["Agent/Deadline"])}
        supa = FakeSupa([stored(ACCT_A, "synthetic-702@example.org", GM(702)),     # would clear
                         stored(ACCT_A, "synthetic-703@example.org", GM(703)),     # retained (old, still labeled)
                         stored(ACCT_A, "legacy@example.org", None)])              # unidentified
        before = {k: dict(v) for k, v in supa.rows.items()}
        r = run_with([FakeIMAP(messages=messages, window=[b"701"])], [(ACCT_A, "pw")], supa, dry_run=True)
        self.assertEqual({op[0] for op in supa.log}, {"select"}, "dry run is zero-write")
        self.assertEqual(supa.rows, before)
        rec = r["accounts"][0]["reconcile"]
        self.assertEqual((rec["would_clear"], rec["retained"], rec["unidentified"], rec["cleared"]), (1, 1, 1, 0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
