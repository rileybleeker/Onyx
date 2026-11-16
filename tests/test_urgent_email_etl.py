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


UNSET = object()


class FakeIMAP:
    """Read-only Gmail stand-in. `window` = UIDs the dated search returns (defaults to all);
    the membership search (X-GM-LABELS without SINCE) returns every UID carrying the label, any age.
    `membership_payload` / `window_payload` replace the SEARCH data verbatim (missing / ambiguous answers).
    `list_lines` replaces the LIST answer; `select_fail` names mailboxes whose SELECT answers NO."""

    def __init__(self, messages=None, window=None, fail_login=False, raw_search=True, all_mail=True,
                 fail_fetch=None, drop_labels=(), drop_msgid=(), membership_status="OK",
                 membership_malformed=False, membership_exclude=(), membership_payload=UNSET,
                 window_payload=UNSET, list_lines=None, select_fail=()):
        self.messages = dict(MESSAGES if messages is None else messages)
        self.window = sorted(self.messages if window is None else window, key=int)
        self.fail_login, self.raw_search, self.all_mail = fail_login, raw_search, all_mail
        self.fail_fetch = fail_fetch or {}
        self.drop_labels, self.drop_msgid = set(drop_labels), set(drop_msgid)
        self.membership_status, self.membership_malformed = membership_status, membership_malformed
        self.membership_exclude = set(membership_exclude)
        self.membership_payload, self.window_payload = membership_payload, window_payload
        self.list_lines, self.select_fail = list_lines, set(select_fail)
        self.commands, self.selected = [], []

    def login(self, user, password):
        self.commands.append(("LOGIN",))
        if self.fail_login:
            raise u.imaplib.IMAP4.error(b"[AUTHENTICATIONFAILED] Invalid credentials (Failure)")

    def list(self):
        if self.list_lines is not None:
            return "OK", list(self.list_lines)
        boxes = [b'(\\HasNoChildren) "/" "INBOX"']
        if self.all_mail:
            boxes.append(b'(\\All \\HasNoChildren) "/" "[Gmail]/All Mail"')
        return "OK", boxes

    def select(self, name, readonly=False):
        self.selected.append((name, readonly))
        if name in self.select_fail:
            return "NO", [b"[NONEXISTENT] Unknown Mailbox"]
        return "OK", [str(len(self.messages)).encode()]

    def _has(self, uid, label):
        return label.lower().encode() in self.messages[uid]["labels"].lower()

    def uid(self, cmd, *args):
        self.commands.append((cmd, *args))
        if cmd == "SEARCH":
            if args[1] == "X-GM-RAW":
                if not self.raw_search:
                    raise u.imaplib.IMAP4.error("unknown search key")
                if self.window_payload is not UNSET:
                    return "OK", self.window_payload
                return "OK", [b" ".join(self.window)]
            label = args[2].strip('"')
            if "SINCE" in args:
                return "OK", [b" ".join(x for x in self.window if self._has(x, label))]
            if self.membership_status != "OK":
                return self.membership_status, [b"failure"]
            if self.membership_payload is not UNSET:
                return "OK", self.membership_payload
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
                    gmid = b"" if m.get("no_gm") or m.get("no_attrs_gm") else b"X-GM-MSGID %s " % m["gm"].encode()
                    out.append(b"%d (X-GM-THRID %s %s%sUID %s FLAGS %s RFC822.SIZE %d)" % (
                        n, m["thr"].encode(), gmid, labels, uid, m["flags"], len(m["raw"])))
                elif kind == "msgid":
                    if uid not in self.drop_msgid and not m.get("no_gm"):
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

    def in_(self, col, vals):
        self.filters.append(("in", col, list(vals)))
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
            if op == "in" and row.get(col) not in val:
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
            else:
                hit = hit[:1000]  # PostgREST's default response cap, even for a small IN-filter list.
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


def run_with(fakes, accounts, supa=None, days=30, dry_run=None, **kw):
    queue = list(fakes)
    original = u.imaplib.IMAP4_SSL
    u.imaplib.IMAP4_SSL = lambda host: queue.pop(0)
    try:
        return u.run_detailed(supa, accounts, days, dry_run=(supa is None) if dry_run is None else dry_run, **kw)
    finally:
        u.imaplib.IMAP4_SSL = original


class GuardedFakeQuery(FakeQuery):
    """FakeQuery behind a stand-in of the preview transport guard: a select is 'sent', anything else is
    refused before it reaches the table (the real guard is tested in tests/test_email_preview_readonly.py)."""

    def __init__(self, guard, db, table):
        super().__init__(db, table)
        self.guard = guard

    def execute(self):
        if self.kind != "select":
            self.guard.blocked += 1
            raise RuntimeError("preview_request_blocked")
        self.guard.allowed += 1
        return super().execute()


class FakePreviewClient:
    """Stand-in for email_preview_readonly.PreviewReadClient over a FakeSupa table."""

    def __init__(self, supa):
        self.supa, self.allowed, self.blocked, self.closed = supa, 0, 0, False
        self.gate_at_open = u.HEARTBEAT.allowed

    def schema(self, name):
        assert name == "pds"
        return self

    def table(self, name):
        assert name == "inbox_emails"
        return GuardedFakeQuery(self, self.supa, name)

    def counters(self):
        return {"allowed_reads": self.allowed, "blocked_requests": self.blocked,
                "blocked_redirects": 0, "sent_writes": 0}

    def close(self):
        self.closed = True


def preview_with(fakes, accounts, supa, refresh_limit=1, **kw):
    """run_detailed exactly as --preview-db calls it, through the guarded stand-in."""
    client = FakePreviewClient(supa)
    r = run_with(fakes, accounts, client, dry_run=True, refresh_limit=refresh_limit, preview=True, **kw)
    return r, client


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

    def test_build_row_never_keys_by_mailbox_uid(self):
        header = EmailMessage()
        header["From"], header["Date"] = "a@example.org", "Tue, 10 Nov 2026 14:00:00 +0000"   # no Message-ID
        attrs = {"uid": b"5", "agent_labels": ["Agent/Action"], "gmail_message_id": None}
        self.assertIsNone(u.build_row(ACCT_A, attrs, header, None, "x"), "no Message-ID and no Gmail id: no row")
        row = u.build_row(ACCT_A, dict(attrs, gmail_message_id="1777"), header, None, "x")
        self.assertEqual(row["message_id"], "gmail:1777", "only Gmail's global id may stand in")

    def test_resolve_identities_uses_only_proven_stored_keys(self):
        rows = [{"message_id": "gmail:11", "gmail_message_id": "11"},      # header lost its Message-ID
                {"message_id": "new@example.org", "gmail_message_id": "22"},
                {"message_id": "twice@example.org", "gmail_message_id": "33"},
                {"message_id": "noid@example.org"}]
        existing = {"11": ["original@example.org"], "33": ["a@example.org", "b@example.org"]}
        out, ambiguous = u.resolve_identities(rows, existing)
        self.assertEqual(sorted(r["message_id"] for r in out), ["new@example.org", "noid@example.org", "original@example.org"])
        self.assertEqual(ambiguous, 1, "two stored rows for one Gmail id: not refreshed, nothing merged")

    def test_row_gmail_id_and_classification(self):
        self.assertEqual(u.row_gmail_id({"gmail_message_id": "77", "message_id": "a@x"}), "77")
        self.assertIsNone(u.row_gmail_id({"gmail_message_id": None, "message_id": "gmail:88"}),
                          "a gmail:<n> key may hold a legacy mailbox UID: never parsed as a Gmail id")
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
        cases = [
            ("membership_search_failed", dict(membership_status="NO")),
            ("membership_search_malformed", dict(membership_malformed=True)),
            # No untagged SEARCH response at all is NOT an empty result (that is [b'']).
            ("membership_search_malformed", dict(membership_payload=[None])),
            ("membership_search_malformed", dict(membership_payload=[])),
            ("membership_search_malformed", dict(membership_payload=None)),
            ("membership_search_malformed", dict(membership_payload=[b"", None])),
            ("membership_fetch_failed", dict(fail_fetch={"msgid": {b"101"}})),
            ("membership_fetch_incomplete", dict(drop_msgid={b"102"})),
            ("mailbox_not_all_mail", dict(all_mail=False)),
        ]
        for code, kw in cases:
            with self.subTest(code=code, kw=repr(kw)):
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


class SearchPayloadTests(unittest.TestCase):
    def test_uid_list_requires_an_explicit_answer(self):
        self.assertEqual(u._uid_list([b""]), [], "'* SEARCH' with no numbers is the only empty answer")
        self.assertEqual(u._uid_list([b"3 1 2"]), [b"3", b"1", b"2"])
        for bad in (None, [], [None], (None,), [b"", None], [b"1 x"], "1 2", [123]):
            with self.subTest(bad=repr(bad)), self.assertRaises(u.SearchMalformed):
                u._uid_list(bad)

    def test_missing_window_payload_reads_nothing_and_clears_nothing(self):
        for payload in ([None], [], None):
            with self.subTest(payload=repr(payload)):
                supa = FakeSupa([stored(ACCT_A, "unlabeled-elsewhere@example.org", GM(999))])
                r = run_with([FakeIMAP(window_payload=payload)], [(ACCT_A, "pw")], supa)
                self.assertEqual(r["status"], "failed")
                self.assertIn("account_read_failed:search_malformed", r["error"])
                self.assertEqual([op for op in supa.log if op[0] != "select"], [], "no write at all")
                self.assertTrue(supa.row(ACCT_A, "unlabeled-elsewhere@example.org")["labeled"])


class IdentityTests(unittest.TestCase):
    def test_recovered_header_without_gmail_attribute_cannot_create_a_twin(self):
        gm = MESSAGES[b"101"]["gm"]
        old_key = f"gmail:{gm}"
        supa = FakeSupa([stored(ACCT_A, old_key, gm)])
        message = dict(MESSAGES[b"101"], no_attrs_gm=True)
        report = run_with([FakeIMAP(messages={b"101": message})], [(ACCT_A, "pw")], supa)
        self.assertEqual(set(supa.rows), {(ACCT_A, old_key)})
        self.assertTrue(supa.row(ACCT_A, old_key)["labeled"])
        self.assertEqual(supa.row(ACCT_A, old_key)["last_seen_at"], OLD_SEEN)
        self.assertEqual(report["accounts"][0]["stats"]["identity_missing"], 1)
        self.assertEqual(report["accounts"][0]["stats"]["membership"], u.RECONCILE_COMPLETE)
        self.assertEqual(report["status"], "partial")
        self.assertEqual(supa.ops("upsert"), [])
        self.assertEqual(supa.ops("update"), [])
        # A later complete response updates the original key rather than creating the RFC-key twin.
        run_with([FakeIMAP(messages={b"101": MESSAGES[b"101"]})], [(ACCT_A, "pw")], supa)
        self.assertEqual(set(supa.rows), {(ACCT_A, old_key)})
        self.assertNotEqual(supa.row(ACCT_A, old_key)["last_seen_at"], OLD_SEEN)

    def test_identity_lookup_does_not_hide_ambiguity_after_a_database_page(self):
        gm = GM(101)
        mids = [f"copy-{n:04d}@example.org" for n in range(1001)]
        supa = FakeSupa([stored(ACCT_A, mid, gm) for mid in mids])
        identities = u.stored_identities(supa, ACCT_A, [gm])
        self.assertEqual(set(identities[gm]), set(mids))
        rows, ambiguous = u.resolve_identities([{"message_id": "new@example.org", "gmail_message_id": gm}], identities)
        self.assertEqual((rows, ambiguous), ([], 1))

    def test_partial_header_without_message_id_updates_the_stored_row(self):
        messages = {b"801": msg(801, ["Agent/Action"], mid=None, subject="Refreshed subject")}
        supa = FakeSupa([stored(ACCT_A, "synthetic-801@example.org", GM(801))])
        r = run_with([FakeIMAP(messages=messages)], [(ACCT_A, "pw")], supa)
        self.assertEqual(set(supa.rows), {(ACCT_A, "synthetic-801@example.org")}, "no gmail:<id> twin is inserted")
        row = supa.row(ACCT_A, "synthetic-801@example.org")
        self.assertEqual(row["subject"], "Refreshed subject")
        self.assertNotEqual(row["last_seen_at"], OLD_SEEN)
        self.assertEqual(r["accounts"][0]["reconcile"]["seen"], 1)

    def test_header_regaining_message_id_keeps_the_gmail_keyed_row(self):
        messages = {b"802": msg(802, ["Agent/Action"])}
        supa = FakeSupa([stored(ACCT_A, f"gmail:{GM(802)}", GM(802))])
        run_with([FakeIMAP(messages=messages)], [(ACCT_A, "pw")], supa)
        self.assertEqual(set(supa.rows), {(ACCT_A, f"gmail:{GM(802)}")}, "the proven stored key wins; no fork")

    def test_neither_identifier_skips_and_keeps(self):
        m = msg(803, ["Agent/Action"], mid=None)
        m["no_gm"] = True
        supa = FakeSupa([stored(ACCT_A, "synthetic-803@example.org", GM(803))])
        r = run_with([FakeIMAP(messages={b"803": m})], [(ACCT_A, "pw")], supa)
        self.assertEqual(r["accounts"][0]["stats"]["identity_missing"], 1)
        self.assertEqual(supa.ops("upsert"), [], "no identity is manufactured (never gmail:<UID>)")
        self.assertEqual(set(supa.rows), {(ACCT_A, "synthetic-803@example.org")})
        self.assertTrue(supa.row(ACCT_A, "synthetic-803@example.org")["labeled"])
        self.assertIn("identity 1", r["error"])

    def test_ambiguous_stored_identity_is_not_refreshed(self):
        messages = {b"804": msg(804, ["Agent/Action"])}
        supa = FakeSupa([stored(ACCT_A, "first@example.org", GM(804)), stored(ACCT_A, "second@example.org", GM(804))])
        r = run_with([FakeIMAP(messages=messages)], [(ACCT_A, "pw")], supa)
        self.assertEqual(supa.ops("upsert"), [])
        self.assertEqual(len(supa.rows), 2, "nothing merged, nothing inserted")
        self.assertTrue(all(row["labeled"] for row in supa.rows.values()), "still labeled per the membership")
        self.assertEqual(r["accounts"][0]["reconcile"]["identity_ambiguous"], 1)
        self.assertIn("match several stored rows", r["error"])


class MailboxProofTests(unittest.TestCase):
    def _reconcile(self, **kw):
        supa = FakeSupa([stored(ACCT_A, "unlabeled-elsewhere@example.org", GM(999))])
        fake = FakeIMAP(**kw)
        r = run_with([fake], [(ACCT_A, "pw")], supa)
        return r, fake, supa

    def test_all_token_in_the_name_is_not_the_all_flag(self):
        for line in (b'(\\HasNoChildren) "/" "Archive \\\\All"',     # quoted name holding "\All"
                     b'(\\HasNoChildren) "/" Archive\\All',          # atom name holding "\All"
                     b'(\\HasNoChildren \\Allmost) "/" "Other"',     # a flag that only starts with \All
                     b'garbage \\All',                              # malformed line
                     (b'(\\All) "/" {8}', b"All Mail")):            # literal name: not trusted
            with self.subTest(line=repr(line)):
                r, fake, supa = self._reconcile(list_lines=[b'(\\HasNoChildren) "/" "INBOX"', line])
                self.assertEqual(fake.selected[-1], ("INBOX", True))
                self.assertEqual(r["accounts"][0]["stats"]["membership"], "mailbox_not_all_mail")
                self.assertTrue(supa.row(ACCT_A, "unlabeled-elsewhere@example.org")["labeled"])

    def test_failed_select_of_the_all_box_is_not_proof(self):
        r, fake, supa = self._reconcile(select_fail={'"[Gmail]/All Mail"'})
        self.assertEqual(fake.selected, [('"[Gmail]/All Mail"', True), ("INBOX", True)])
        self.assertEqual(r["accounts"][0]["stats"]["membership"], "mailbox_not_all_mail")
        self.assertTrue(supa.row(ACCT_A, "unlabeled-elsewhere@example.org")["labeled"])

    def test_exact_flag_is_case_insensitive(self):
        r, fake, supa = self._reconcile(list_lines=[b'(\\HasNoChildren \\all) "/" "[Gmail]/All Mail"'])
        self.assertEqual(r["accounts"][0]["stats"]["membership"], "complete")
        self.assertFalse(supa.row(ACCT_A, "unlabeled-elsewhere@example.org")["labeled"])


def membership_commands(fake):
    """The all-age reconciliation reads: undated X-GM-LABELS searches and X-GM-MSGID fetches."""
    return [c for c in fake.commands
            if (c[0] == "SEARCH" and c[2] == "X-GM-LABELS" and "SINCE" not in c)
            or (c[0] == "FETCH" and c[2] == "(X-GM-MSGID)")]


class PreviewTests(unittest.TestCase):
    """--preview-db: production classification over real-shaped stored rows; reads only."""

    def three_labeled(self):
        messages = {b"901": msg(901, ["Agent/Action"]), b"902": msg(902, ["Agent/Deadline"]),
                    b"903": msg(903, ["\\Inbox", "Agent/Action"])}
        rows = [stored(ACCT_A, f"synthetic-{n}@example.org", GM(n)) for n in (901, 902, 903)]
        return messages, rows

    def test_refresh_limit_one_retains_unrefreshed_rows_with_complete_membership(self):
        messages, rows = self.three_labeled()
        supa = FakeSupa(rows)
        before = {k: dict(v) for k, v in supa.rows.items()}
        fake = FakeIMAP(messages=messages)
        r, client = preview_with([fake], [(ACCT_A, "pw")], supa, refresh_limit=1)
        stats, rec = r["accounts"][0]["stats"], r["accounts"][0]["reconcile"]
        self.assertEqual((stats["window_candidates"], stats["messages"], stats["dropped_by_cap"]), (3, 1, 2))
        self.assertEqual(stats["membership"], u.RECONCILE_COMPLETE)
        self.assertEqual(stats["membership_size"], 3, "membership is all-age and unaffected by the limit")
        self.assertEqual((rec["refreshed"], rec["seen"], rec["retained"], rec["would_clear"]), (1, 1, 2, 0))
        self.assertEqual((rec["upserted"], rec["cleared"]), (0, 0), "actual mutation counters")
        self.assertEqual({op[0] for op in supa.log}, {"select"})
        self.assertEqual(supa.rows, before, "stored rows unchanged")
        self.assertEqual((client.blocked, r["refresh_cap"], r["preview"]), (0, 1, True))
        self.assertGreater(client.allowed, 0)
        self.assertIn("beyond the refresh cap 1 not refreshed", r["error"])
        self.assertEqual(r["accounts"][0]["fp"], "acct1", "preview output carries no fingerprint")
        # The same account at the normal 300 cap issues identical membership reads.
        normal = FakeIMAP(messages=messages)
        preview_with([normal], [(ACCT_A, "pw")], FakeSupa(rows), refresh_limit=300)
        self.assertEqual(membership_commands(fake), membership_commands(normal))
        self.assertTrue(membership_commands(fake))

    def test_removed_membership_reports_would_clear_without_changing_rows(self):
        messages, rows = self.three_labeled()
        messages[b"902"] = msg(902, ["\\Inbox"])           # label removed in Gmail
        supa = FakeSupa(rows)
        before = {k: dict(v) for k, v in supa.rows.items()}
        r, client = preview_with([FakeIMAP(messages=messages)], [(ACCT_A, "pw")], supa, refresh_limit=1)
        rec = r["accounts"][0]["reconcile"]
        self.assertEqual((rec["would_clear"], rec["cleared"], rec["upserted"]), (1, 0, 0))
        self.assertEqual(supa.rows, before)
        self.assertTrue(supa.row(ACCT_A, "synthetic-902@example.org")["labeled"])
        self.assertEqual((supa.ops("update"), supa.ops("upsert"), client.blocked), ([], [], 0))

    def test_unknown_or_malformed_membership_keeps_rows_unknown(self):
        cases = [dict(membership_status="NO"), dict(membership_malformed=True), dict(membership_payload=[None]),
                 dict(drop_msgid={b"901"}), dict(all_mail=False)]
        for kw in cases:
            with self.subTest(kw=repr(kw)):
                messages, rows = self.three_labeled()
                supa = FakeSupa(rows + [stored(ACCT_A, "unlabeled-elsewhere@example.org", GM(999))])
                before = {k: dict(v) for k, v in supa.rows.items()}
                r, _ = preview_with([FakeIMAP(messages=messages, **kw)], [(ACCT_A, "pw")], supa, refresh_limit=1)
                rec = r["accounts"][0]["reconcile"]
                self.assertEqual((rec["would_clear"], rec["retained"]), (0, 0))
                self.assertEqual(rec["unknown"], 4 - rec["seen"])
                self.assertEqual(supa.rows, before)
                self.assertIn("reconcile=unknown(", r["error"])

    def test_missing_identity_and_ambiguity_stay_safe(self):
        m = msg(904, ["Agent/Action"], mid=None)
        m["no_gm"] = True
        supa = FakeSupa([stored(ACCT_A, "synthetic-904@example.org", GM(904)),
                         stored(ACCT_A, "first@example.org", GM(905)), stored(ACCT_A, "second@example.org", GM(905))])
        before = {k: dict(v) for k, v in supa.rows.items()}
        r, _ = preview_with([FakeIMAP(messages={b"904": m, b"905": msg(905, ["Agent/Action"])})],
                            [(ACCT_A, "pw")], supa, refresh_limit=300)
        stats, rec = r["accounts"][0]["stats"], r["accounts"][0]["reconcile"]
        self.assertEqual(stats["identity_missing"], 1, "no identity is manufactured")
        self.assertEqual(rec["identity_ambiguous"], 1)
        self.assertEqual(rec["refreshed"], 0)
        self.assertEqual(supa.rows, before)

    def test_more_than_a_page_of_stored_rows_is_read_in_order(self):
        rows = [stored(ACCT_A, f"page-{n:04d}@example.org", GM(5000 + n)) for n in range(1001)]
        rows.append(stored(ACCT_B, "other-account@example.org", GM(9999)))
        supa = FakeSupa(rows)
        r, _ = preview_with([FakeIMAP(messages={})], [(ACCT_A, "pw")], supa, refresh_limit=1)
        rec = r["accounts"][0]["reconcile"]
        self.assertEqual(rec["labeled_rows"], 1001, "second page read; other account not included")
        self.assertEqual(rec["would_clear"], 1001)
        self.assertTrue(all(row["labeled"] for row in supa.rows.values()))
        ranges = [f for op in supa.log for f in op[3] if f[0] == "eq" and f[1] == "account"]
        self.assertTrue(all(f[2] == ACCT_A for f in ranges), "every read is account-scoped")

    def test_identity_paging_over_a_thousand_rows_is_kept(self):
        gm = GM(906)
        supa = FakeSupa([stored(ACCT_A, f"copy-{n:04d}@example.org", gm) for n in range(1001)])
        r, _ = preview_with([FakeIMAP(messages={b"906": msg(906, ["Agent/Action"])})], [(ACCT_A, "pw")], supa)
        self.assertEqual(r["accounts"][0]["reconcile"]["identity_ambiguous"], 1)

    def test_accidental_write_through_the_preview_client_is_refused(self):
        messages, rows = self.three_labeled()
        supa = FakeSupa(rows)
        client = FakePreviewClient(supa)
        with self.assertRaises(RuntimeError):
            u.upsert_rows(client, [dict(rows[0])])
        with self.assertRaises(RuntimeError):
            u.store_account(client, ACCT_A, [], "2026-11-15T00:00:00+00:00", membership=set(), dry_run=False)
        self.assertEqual((supa.ops("upsert"), supa.ops("update")), ([], []))
        self.assertEqual(client.blocked, 2)

    def test_normal_default_is_unchanged_and_limits_are_bounded(self):
        self.assertEqual(u.MAX_MESSAGES, 300)
        r = run_with([FakeIMAP()], [(ACCT_A, "pw")], FakeSupa())
        self.assertEqual((r["refresh_cap"], r["preview"]), (300, False))
        for bad in (0, 301, -1, True, "1", 1.0, None):
            with self.subTest(bad=repr(bad)), self.assertRaises(ValueError):
                u.run_detailed(FakeSupa(), [(ACCT_A, "pw")], 30, refresh_limit=bad)
        with self.assertRaises(ValueError):
            u.run_detailed(FakePreviewClient(FakeSupa()), [(ACCT_A, "pw")], 30, dry_run=False, preview=True)
        with self.assertRaises(ValueError):
            u.run_detailed(None, [(ACCT_A, "pw")], 30, dry_run=True, preview=True)


class CliTests(unittest.TestCase):
    """--dry-run is zero-write on every path, crashes included; write mode still heartbeats on a crash."""

    def _cli(self, argv, **patches):
        created = []
        fake_module = SimpleNamespace(create_client=lambda url, key: created.append(1) or FakeSupa())
        saved = sys.modules.get("supabase")
        sys.modules["supabase"] = fake_module
        heartbeats = []
        import sync_log_helper
        original_log_sync = sync_log_helper.log_sync
        sync_log_helper.log_sync = lambda *a, **k: heartbeats.append(k.get("error"))
        originals = {name: getattr(u, name) for name in patches}
        for name, value in patches.items():
            setattr(u, name, value)
        old_argv = sys.argv
        sys.argv = argv
        try:
            try:
                rc = u.cli()
            except SystemExit as e:
                rc = ("exit", e.code)
        finally:
            sys.argv = old_argv
            for name, value in originals.items():
                setattr(u, name, value)
            sync_log_helper.log_sync = original_log_sync
            if saved is None:
                sys.modules.pop("supabase", None)
            else:
                sys.modules["supabase"] = saved
        return rc, created, heartbeats

    def _boom(self, *a, **k):
        raise RuntimeError("synthetic crash")

    def test_out_of_range_days_is_rejected_before_anything(self):
        with mock_stderr():
            rc, created, heartbeats = self._cli(["urgent_email_etl.py", "--dry-run", "--days", "1000000000"])
        self.assertEqual(rc, ("exit", 2))
        self.assertEqual((created, heartbeats), ([], []))

    def test_dry_run_crash_writes_nothing(self):
        rc, created, heartbeats = self._cli(["urgent_email_etl.py", "--dry-run"], imap_accounts=self._boom)
        self.assertEqual(rc, 1)
        self.assertEqual((created, heartbeats), ([], []), "no client created, no heartbeat")
        rc, created, heartbeats = self._cli(["urgent_email_etl.py", "--dry-run"], run=self._boom)
        self.assertEqual((rc, created, heartbeats), (1, [], []))
        self.assertFalse(u.HEARTBEAT.allowed)

    def test_write_mode_crash_still_heartbeats_a_code(self):
        rc, created, heartbeats = self._cli(["urgent_email_etl.py"], imap_accounts=lambda: [], run=self._boom)
        self.assertEqual(rc, 1)
        self.assertEqual(heartbeats, ["fatal:runtime_error"])
        self.assertFalse(u.HEARTBEAT.allowed, "the gate closes after every invocation")

    # --- --preview-db -------------------------------------------------------------------------

    PREVIEW = ["urgent_email_etl.py", "--preview-db", "--refresh-limit", "1"]

    def _preview(self, argv=None, fakes=None, supa=None, factory=None, **patches):
        supa = supa if supa is not None else FakeSupa(
            [stored(ACCT_A, f"synthetic-{n}@example.org", GM(n)) for n in (901, 902, 903)])
        messages = {b"901": msg(901, ["Agent/Action"]), b"902": msg(902, ["Agent/Deadline"]),
                    b"903": msg(903, ["Agent/Action"])}
        opened = []

        def default_factory():
            client = FakePreviewClient(supa)
            opened.append(client)
            return client
        patches.setdefault("_open_preview_client", factory or default_factory)
        patches.setdefault("imap_accounts", lambda: [(ACCT_A, "pw")])
        queue = list(fakes) if fakes is not None else [FakeIMAP(messages=messages)]
        original = u.imaplib.IMAP4_SSL
        u.imaplib.IMAP4_SSL = lambda host: queue.pop(0)
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        old_level = u.log.level
        u.log.addHandler(handler)
        u.log.setLevel(logging.INFO)
        try:
            rc, created, heartbeats = self._cli(argv or self.PREVIEW, **patches)
        finally:
            u.imaplib.IMAP4_SSL = original
            u.log.removeHandler(handler)
            u.log.setLevel(old_level)
        return SimpleNamespace(rc=rc, created=created, heartbeats=heartbeats, opened=opened, supa=supa,
                               text=stream.getvalue())

    def assertNoWriteSideEffects(self, res):
        self.assertEqual(res.created, [], "no normal (write) database client is ever created")
        self.assertEqual(res.heartbeats, [], "no heartbeat")
        self.assertEqual([op for op in res.supa.log if op[0] != "select"], [])
        self.assertFalse(u.HEARTBEAT.allowed)
        for client in res.opened:
            self.assertFalse(client.gate_at_open, "the heartbeat gate is closed while the preview runs")
            self.assertTrue(client.closed, "the preview client is closed")

    def test_preview_success_reads_and_writes_nothing(self):
        res = self._preview()
        self.assertEqual(res.rc, 0)
        self.assertNoWriteSideEffects(res)
        for row in res.supa.rows.values():
            self.assertEqual((row["labeled"], row["last_seen_at"], row["synced_at"]), (True, OLD_SEEN, OLD_SEEN))
        self.assertEqual(len(res.opened), 1)
        self.assertGreater(res.opened[0].allowed, 0)
        for counter in ("refresh_limit=1", "db_reads=", "blocked_requests=0", "sent_writes=0",
                        "heartbeat_gate=closed", "would_refresh=1", "retained=2", "would_clear=0",
                        "upserted=0", "cleared=0", "reconcile=complete"):
            self.assertIn(counter, res.text)
        for private in (ACCT_A, u.account_fingerprint(ACCT_A), "synthetic-90", GM(901), "example.org",
                        "Synthetic notice", "http"):
            self.assertNotIn(private, res.text, "counts and codes only")

    def test_preview_default_limit_is_the_normal_cap(self):
        res = self._preview(["urgent_email_etl.py", "--preview-db"])
        self.assertEqual(res.rc, 0)
        self.assertIn("refresh_limit=300", res.text)
        self.assertNoWriteSideEffects(res)

    def test_invalid_or_mixed_mode_is_rejected_before_any_client(self):
        for argv in (["--refresh-limit", "1"], ["--dry-run", "--refresh-limit", "1"],
                     ["--preview-db", "--dry-run"], ["--preview-db", "--refresh-limit", "0"],
                     ["--preview-db", "--refresh-limit", "301"], ["--preview-db", "--refresh-limit", "x"],
                     ["--preview-db", "--days", "0"]):
            with self.subTest(argv=argv), mock_stderr():
                res = self._preview(["urgent_email_etl.py", *argv], imap_accounts=self._boom)
                self.assertEqual(res.rc, ("exit", 2))
                self.assertEqual(res.opened, [])
                self.assertNoWriteSideEffects(res)

    def test_preview_failures_are_nonzero_and_never_heartbeat(self):
        failing_db = FakeSupa([stored(ACCT_A, "synthetic-901@example.org", GM(901))])
        failing_db.fail = RuntimeError("synthetic db failure owner@example.com")
        cases = {
            "accounts": dict(imap_accounts=self._boom),
            "client_creation": dict(factory=self._boom),
            "account_read": dict(fakes=[FakeIMAP(fail_login=True)]),
            "db_read": dict(supa=failing_db),
            "classification": dict(classify_rows=self._boom),
            "run": dict(run_detailed=self._boom),
            "report": dict(_emit_preview=self._boom),
        }
        for stage, kw in cases.items():
            with self.subTest(stage=stage):
                res = self._preview(**kw)
                self.assertEqual(res.rc, 1)
                self.assertNoWriteSideEffects(res)
                self.assertNotIn(ACCT_A, res.text)
                self.assertNotIn("synthetic db failure", res.text)

    def test_incomplete_membership_fails_preview_without_writes(self):
        for options in ({"all_mail": False}, {"membership_payload": [None]},
                        {"membership_status": "NO"}, {"drop_msgid": (b"101",)}):
            with self.subTest(options=options):
                res = self._preview(fakes=[FakeIMAP(**options)])
                self.assertEqual(res.rc, 1)
                self.assertNoWriteSideEffects(res)
                self.assertIn("preview_failed:incomplete", res.text)

    def test_blocked_request_fails_the_preview(self):
        original = u.store_account

        def accidental_write(supa, account, rows, seen_at, membership=None, dry_run=False):
            return original(supa, account, rows, seen_at, membership, dry_run=False)
        res = self._preview(store_account=accidental_write)
        self.assertEqual(res.rc, 1)
        self.assertNoWriteSideEffects(res)
        self.assertGreater(res.opened[0].blocked, 0)
        self.assertIn("preview_failed:boundary_refused_request", res.text)

    def test_prior_write_mode_cannot_leave_the_gate_open_for_a_preview(self):
        rc, _, heartbeats = self._cli(["urgent_email_etl.py"], imap_accounts=lambda: [], run=self._boom)
        self.assertEqual((rc, heartbeats), (1, ["fatal:runtime_error"]))
        u.HEARTBEAT.open()                     # even a gate left open by something else is closed by cli()
        res = self._preview(_emit_preview=self._boom)
        self.assertEqual(res.rc, 1)
        self.assertNoWriteSideEffects(res)

    def test_dry_run_still_creates_no_database_client(self):
        res = self._preview(["urgent_email_etl.py", "--dry-run"], fakes=[FakeIMAP()])
        self.assertEqual(res.rc, 0)
        self.assertEqual(res.opened, [], "the Gmail-only dry run never opens the preview client")
        self.assertEqual((res.created, res.heartbeats, res.supa.log), ([], [], []))


class mock_stderr:
    def __enter__(self):
        self.saved, sys.stderr = sys.stderr, io.StringIO()

    def __exit__(self, *exc):
        sys.stderr = self.saved
        return False


if __name__ == "__main__":
    unittest.main(verbosity=2)
