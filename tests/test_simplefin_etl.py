"""SimpleFIN Bridge ETL (simplefin_etl.py).

Covers the Access URL / claim handling (credentials never in errors or output), the /accounts request, the
transaction normalization (sign, pending, dates), account matching, the Rocket Money cutover, the category rules,
balances, and run() end to end against a fake SimpleFIN + fake store: heartbeats on success / partial / failure,
dry-run writes nothing, routine output carries counts only.

Synthetic data only. No network, no credentials.

Run: python tests/test_simplefin_etl.py
"""
import base64
import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import simplefin_etl as sf  # noqa: E402

SECRET_USER, SECRET_PASS = "demo-user", "s3cret-pass"
ACCESS = f"https://{SECRET_USER}:{SECRET_PASS}@beta-bridge.simplefin.org/simplefin"
NOW = datetime(2026, 11, 20, 15, 0, tzinfo=timezone.utc)  # 10:00 ET, today = 2026-11-20


def ts(d: str, hour: int = 0) -> int:
    y, m, dd = map(int, d.split("-"))
    return int(datetime(y, m, dd, hour, tzinfo=timezone.utc).timestamp())


class Res:
    def __init__(self, status=200, body=None, text=""):
        self.status_code, self._body, self.text = status, body, text

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class Http:
    def __init__(self, get=None, post=None):
        self._get, self._post, self.calls = get, post, []

    def get(self, url, **kw):
        self.calls.append(("GET", url, kw))
        return self._get

    def post(self, url, **kw):
        self.calls.append(("POST", url, kw))
        return self._post


def assert_no_secret(text):
    for s in (SECRET_USER, SECRET_PASS, ACCESS):
        assert s not in str(text), f"secret leaked: {text!r}"


def expect_error(fn, *a):
    try:
        fn(*a)
    except sf.SimpleFinError as e:
        assert_no_secret(e)
        return str(e)
    raise AssertionError("expected SimpleFinError")


# --- Access URL + claim ----------------------------------------------------------------------------------------
def test_split_access_url():
    base, auth = sf.split_access_url(ACCESS)
    assert base == "https://beta-bridge.simplefin.org/simplefin"
    assert auth == (SECRET_USER, SECRET_PASS)
    expect_error(sf.split_access_url, "http://u:p@beta-bridge.simplefin.org/simplefin")
    expect_error(sf.split_access_url, "https://u:p@evil.example.com/simplefin")
    expect_error(sf.split_access_url, "https://beta-bridge.simplefin.org/simplefin")


def test_claim():
    claim_url = "https://beta-bridge.simplefin.org/simplefin/claim/DEMO"
    token = base64.b64encode(claim_url.encode()).decode()
    http = Http(post=Res(200, text=ACCESS + "\n"))
    assert sf.claim_access_url(token, http) == ACCESS
    assert http.calls[0][:2] == ("POST", claim_url)
    assert "403" not in expect_error(sf.claim_access_url, token, Http(post=Res(403)))
    bad = base64.b64encode(b"https://evil.example.com/claim/x").decode()
    expect_error(sf.claim_access_url, bad, Http(post=Res(200, text=ACCESS)))
    # A claim answer that is not a SimpleFIN Access URL is refused (and not echoed).
    expect_error(sf.claim_access_url, token, Http(post=Res(200, text="https://u:p@evil.example.com/x")))


# --- fetch ------------------------------------------------------------------------------------------------------
def test_fetch_params_and_errors():
    http = Http(get=Res(200, {"accounts": [], "errlist": [], "connections": []}))
    sf.fetch_accounts(ACCESS, date(2026, 9, 21), date(2026, 11, 21), http)
    method, url, kw = http.calls[0]
    assert url == "https://beta-bridge.simplefin.org/simplefin/accounts"
    assert kw["auth"] == (SECRET_USER, SECRET_PASS)
    assert kw["params"] == {"version": "2", "start-date": str(ts("2026-09-21")), "end-date": str(ts("2026-11-21"))}
    assert "revoked" in expect_error(sf.fetch_accounts, ACCESS, date(2026, 11, 1), date(2026, 11, 2), Http(get=Res(403)))
    assert "payment" in expect_error(sf.fetch_accounts, ACCESS, date(2026, 11, 1), date(2026, 11, 2), Http(get=Res(402)))
    expect_error(sf.fetch_accounts, ACCESS, date(2026, 11, 1), date(2026, 11, 2), Http(get=Res(200, {"oops": 1})))
    expect_error(sf.fetch_accounts, ACCESS, date(2026, 1, 1), date(2026, 11, 2), http)  # > 90 days


# --- normalization ----------------------------------------------------------------------------------------------
def acct(id_, name, conn="c1", txns=(), balance="-120.50", bal_date="2026-11-20"):
    return {"id": id_, "name": name, "conn_id": conn, "currency": "USD", "balance": balance,
            "balance-date": ts(bal_date, 12), "transactions": list(txns)}


def txn(id_, d, amount, desc, payee=None, pending=False, posted=None):
    t = {"id": id_, "posted": 0 if pending else (posted or ts(d, 12)), "amount": amount, "description": desc,
         "transacted_at": ts(d, 12)}
    if payee:
        t["payee"] = payee
    if pending:
        t["pending"] = True
    return t


def test_normalize_transactions():
    a = sf.parse_accounts({"connections": [{"conn_id": "c1", "name": "Demo Card Co"}], "accounts": [acct("A1", "Demo Card ...1234", txns=[
        txn("t1", "2026-11-18", "-12.34", "DEMO CAFE #123", payee="Demo Cafe"),
        txn("t2", "2026-11-18", "50.00", "PAYMENT RECEIVED - THANK YOU"),
        txn("t3", "2026-11-19", "-5.00", "PENDING THING", pending=True),
        txn("t4", "2026-11-17", "-1.00", "POSTED LATER", posted=ts("2026-11-19", 12)),
        {"id": "t5", "posted": ts("2026-11-18"), "amount": "abc", "description": "BAD"},
    ])]})[0][0]
    assert a.institution == "Demo Card Co" and a.mask == "1234" and a.balance_cents == -12050
    rows, skipped = sf.normalize_transactions(a, "K1")
    by = {r["source_txn_id"]: r for r in rows}
    assert by["sf:A1:t1"]["amount_cents"] == 1234          # a purchase is expense-positive
    assert by["sf:A1:t1"]["name"] == "Demo Cafe" and by["sf:A1:t1"]["description"] == "DEMO CAFE #123"
    assert by["sf:A1:t2"]["amount_cents"] == -5000         # a payment in is negative
    assert by["sf:A1:t4"]["txn_date"] == "2026-11-17" and by["sf:A1:t4"]["original_date"] == "2026-11-19"
    assert "sf:A1:t3" not in by and skipped["pending"] == 1 and skipped["unreadable"] == 1
    assert by["sf:A1:t1"]["txn_key"] == sf.txn_key("A1", "t1") and all(r["source"] == "simplefin" for r in rows)


# Provider text a heartbeat must never carry: an institution / person name, an email, URLs, long and short ids.
PII = ["Demo Bank", "Jane Q Example", "jane@example.com", "https://bank.example.com/login?u=42",
       "www.demo-bank.example", "12345678", "acct 42", "ACT-0042"]


def pii_msg(i=0):
    return f"Reconnect {PII[0]} for {PII[1]} <{PII[2]}> at {PII[3]} ({PII[4]}) account {PII[5]} / {PII[6]} / {PII[7]} #{i}"


def assert_no_pii(text):
    for s in PII + ["Reconnect", "for Jane"]:
        assert s not in str(text), f"provider text leaked: {s!r} in {text!r}"


def assert_only_allowlisted(note):
    """A heartbeat note is exactly what format_notes builds from allowlisted codes: no other text at all."""
    import re
    tokens = re.findall(r"\[([a-z][a-z0-9_]*)(?: x(\d+))?\]", note)
    assert tokens, note
    counts = {}
    for code, n in tokens:
        assert code in sf.NOTE_CODES, code
        counts[code] = counts.get(code, 0) + (int(n) if n else 1)
    assert note == sf.format_notes(counts), f"note has text beyond the allowlist: {note!r}"


def test_classify_error_codes():
    assert sf.classify_error("con.auth") == "sf_reauth"
    assert sf.classify_error("CON.AUTH ") == "sf_reauth"
    assert sf.classify_error("con.") == "sf_connection_error"
    assert sf.classify_error("con.something_new") == "sf_connection_error"   # unknown subcode = bare prefix
    assert sf.classify_error("act.failed") == "sf_account_failed"
    assert sf.classify_error("act.missingdata") == "sf_account_incomplete"
    assert sf.classify_error("act.other") == "sf_account_error"
    assert sf.classify_error("gen.auth") == "sf_server_auth"
    assert sf.classify_error("gen.api") == "sf_api_error"
    assert sf.classify_error("gen.") == "sf_general_error"
    for bad in ("zzz.auth", "", None, 42, "con", "con.auth please reconnect jane@example.com", "Reconnect Demo Bank",
                "https://bank.example.com", "x" * 200, {"code": "con.auth"}):
        assert sf.classify_error(bad) == "sf_unclassified", bad


def test_connection_errors_codes_only():
    body = {
        "errlist": [
            {"code": "con.auth", "msg": pii_msg(1), "conn_id": "CON-1"},
            {"code": "con.auth", "msg": pii_msg(2), "conn_id": "CON-1"},          # same issue twice: counted once
            {"code": "act.missingdata", "msg": pii_msg(3), "account_id": "S-AMEX"},
            {"code": "bogus.code", "msg": pii_msg(4)},
            {"msg": pii_msg(5)},                                                   # no code at all
            pii_msg(6),                                                            # malformed entry
        ],
        "errors": [pii_msg(7)],                                                    # v1 duplicate: ignored with an errlist
    }
    issues = sf.connection_errors(body)
    assert [i.code for i in issues] == ["sf_reauth", "sf_account_incomplete", "sf_unclassified"]
    assert issues[0].conn_id == "CON-1" and issues[1].account_id == "S-AMEX"
    for i in issues:
        assert_no_pii(i)
    # Only the deprecated strings: each is unclassified (never echoed); a non-list errlist is a format change.
    assert [i.code for i in sf.connection_errors({"errors": [pii_msg(8), pii_msg(9)]})] == ["sf_unclassified"]
    assert [i.code for i in sf.connection_errors({"errlist": pii_msg(10)})] == ["sf_unclassified"]
    assert sf.connection_errors({"errlist": [], "errors": []}) == []
    assert sf.connection_errors({}) == []


def test_format_notes():
    assert sf.format_notes({}) is None and sf.format_notes({"not_a_code": 3}) is None
    one = sf.format_notes({"sf_reauth": 1})
    assert one == f"{sf.NOTE_CODES['sf_reauth']} [sf_reauth]"
    two = sf.format_notes({"account_unmatched": 2, "sf_reauth": 1, "not_a_code": 5})
    assert two == f"{sf.NOTE_CODES['sf_reauth']} [sf_reauth]; {sf.NOTE_CODES['account_unmatched']} [account_unmatched x2]"
    assert "not_a_code" not in two
    assert sf.format_notes({"sf_reauth": 10 ** 9}).endswith("[sf_reauth x9999]")
    # Many codes: the later ones keep only their token, so no code is ever lost, and the length stays bounded.
    every = sf.format_notes({c: 2 for c in sf.NOTE_CODES})
    for c in sf.NOTE_CODES:
        assert f"[{c} x2]" in every, c
    assert "; also [" in every and len(every) < sf.NOTE_LIMIT + 30 * len(sf.NOTE_CODES)
    assert_only_allowlisted(every)
    # The wording never carries a bracket, a double quote or a backslash (the frontend parses tokens out of the
    # note and reads this table from the source), and one code with the largest count always fits the limit.
    for code, text in sf.NOTE_CODES.items():
        assert "[" not in text and "]" not in text and '"' not in text and "\\" not in text, code
        assert len(f"{text} [{code} x9999]") <= sf.NOTE_LIMIT, code


# --- matching ---------------------------------------------------------------------------------------------------
LEDGER = [
    {"account_key": "amex", "institution": "American Express", "account_name": "Demo Platinum", "account_type": "Credit Card", "mask": "1003"},
    {"account_key": "wf1", "institution": "Wells Fargo", "account_name": "EVERYDAY CHECKING ...7000", "account_type": "Cash", "mask": "7000"},
    {"account_key": "wf2", "institution": "Wells Fargo", "account_name": "WAY2SAVE SAVINGS ...3000", "account_type": "Cash", "mask": "3000"},
    {"account_key": "acard", "institution": "Apple", "account_name": "Apple Card", "account_type": "Credit Card", "mask": None},
    {"account_key": "acash", "institution": "Apple", "account_name": "Apple Cash", "account_type": "Cash", "mask": None},
    {"account_key": "citi", "institution": "Citibank Online", "account_name": "Citi Demo Card", "account_type": "Credit Card", "mask": "8000", "simplefin_id": "S-CITI"},
]


def sfa(id_, name, inst, hint=""):
    return sf.SfAccount(id_, name, inst, hint, sf.last_four(name), "USD", 0, None)


def test_match_accounts():
    m = sf.match_accounts([
        sfa("S-CITI", "Citi Demo Card (8000)", "Citi"),
        sfa("S-AMEX", "Platinum Card (1003)", "American Express"),
        sfa("S-WF", "Checking 7000", "Wells Fargo Bank", "wellsfargo.com"),
        sfa("S-WFNEW", "Savings 9999", "Wells Fargo"),
        sfa("S-APPLE", "Apple Card", "Apple Card (Updated Monthly)"),
        sfa("S-DISC", "Discover it Card 1232", "Discover"),
        sfa("S-WFX", "Some Account", "Wells Fargo"),
    ], LEDGER)
    owner_named = sf.match_accounts([sfa("S-AC", "Riley", "Apple Card (Updated Monthly) ")], LEDGER)
    assert (owner_named["S-AC"].action, owner_named["S-AC"].account_key) == ("matched", "acard")  # not Apple Cash
    assert sf.match_accounts([sfa("S-AX", "Riley", "Apple")], LEDGER)["S-AX"].action == "skip"
    assert (m["S-CITI"].action, m["S-CITI"].account_key) == ("linked", "citi")
    assert (m["S-AMEX"].action, m["S-AMEX"].account_key) == ("matched", "amex")
    assert (m["S-WF"].action, m["S-WF"].account_key) == ("matched", "wf1")
    assert m["S-WFNEW"].action == "new"               # its last four is not in the ledger
    assert (m["S-APPLE"].action, m["S-APPLE"].account_key) == ("matched", "acard")  # not Apple Cash
    assert m["S-DISC"].action == "new"                # no Discover account in this ledger
    assert m["S-WFX"].action == "skip"                # could be either Wells Fargo account: never guessed
    assert sf.canonical_institution("Citibank Online") == sf.canonical_institution("Citi") == "citi"
    assert sf.canonical_institution("Citizens Bank") != "citi"
    assert sf.canonical_institution("Some Bank", "americanexpress.com") == "amex"


# --- cutover ----------------------------------------------------------------------------------------------------
def row(key, d, cents, account="wf1", desc="X", source="simplefin", name=None, currency="USD", original=None):
    return {"txn_key": key, "account_key": account, "txn_date": d, "amount_cents": cents, "description": desc,
            "name": name or desc, "source": source, "category": None, "currency": currency, "original_date": original}


def hrow(key, d, cents, desc, name=None, **kw):
    return row(key, d, cents, desc=desc, name=name, source="rocketmoney", **kw)


CUT = date(2026, 11, 11)


def decided(decisions):
    return {d.sf_txn_key: (d.decision, d.evidence, d.history_txn_keys) for d in decisions}


def test_merchant_evidence():
    a = row("a", "2026-11-11", 500, desc="DEMO CAFE 0042 ATLANTA GA")
    assert sf.merchant_evidence(a, hrow("h", "2026-11-10", 500, "Demo Cafe", name="Demo Cafe"))
    assert sf.merchant_evidence(a, hrow("h", "2026-11-10", 500, "SQ *DEMO CAFE ATLANTA"))
    assert not sf.merchant_evidence(a, hrow("h", "2026-11-11", 500, "OTHER SHOP 0042 ATLANTA GA"))  # city alone is not it
    assert not sf.merchant_evidence(row("a", "2026-11-11", 500, desc="DEMO ATLANTA"), hrow("h", "2026-11-11", 500, "SHOP ATLANTA"))
    assert not sf.merchant_evidence(row("a", "2026-11-11", 500, desc="POS DEBIT PURCHASE"), hrow("h", "2026-11-11", 500, "POS DEBIT PURCHASE"))
    assert not sf.merchant_evidence(row("a", "2026-11-11", 500, desc="#1234"), hrow("h", "2026-11-11", 500, "#1234"))
    assert sf.exact_key(row("a", "2026-11-11", 500, desc="#1234")) is None   # no letters: no exact evidence either
    # Codex review: two shops sharing the first word, the kind of business and the city are two merchants (most of
    # their words and the first word are shared, but each has a distinctive word the other lacks).
    bottle = row("a", "2026-11-11", 500, desc="DEMO BOTTLE COFFEE ATLANTA")
    assert not sf.merchant_evidence(bottle, hrow("h", "2026-11-11", 500, "DEMO DONKEY COFFEE ATLANTA"))
    assert not sf.merchant_evidence(bottle, hrow("h", "2026-11-11", 500, None, name="Demo Donkey Coffee"))
    assert sf.merchant_evidence(bottle, hrow("h", "2026-11-11", 500, None, name="Demo Bottle Coffee"))
    assert sf.merchant_evidence(bottle, hrow("h", "2026-11-11", 500, "DEMO BOTTLE COFFEE 0042 ATLANTA GA"))


def test_cutover_equal_amount_is_not_identity():
    """PIPE-04: an equal amount on a nearby date never drops a row on its own."""
    hist = [hrow("h1", "2026-11-11", 1500, "DEMO GROCER 0101 ATLANTA")]
    sf_rows = [
        row("a", "2026-11-11", 1500, desc="OTHER PHARMACY 0202 ATLANTA"),   # same day and amount, another merchant
        row("b", "2026-11-11", 1500, desc="DEMO GROCER 0101 ATLANTA", currency="EUR"),   # another currency
    ]
    kept, dropped, decisions = sf.apply_cutover(sf_rows, hist, CUT, set())
    assert sorted(r["txn_key"] for r in kept) == ["a", "b"] and not dropped
    assert decided(decisions) == {"a": ("unconfirmed", None, ("h1",))}     # flagged for review, still kept
    assert all(d.account_key == "wf1" and d.cutover_date == "2026-11-11" for d in decisions)


def test_cutover_true_duplicates_match_deterministically():
    hist = [
        hrow("h1", "2026-11-10", 500, "DEMO CAFE 0017 ATLANTA"),
        hrow("h2", "2026-11-11", 700, "DEMO DELI ATLANTA"), hrow("h3", "2026-11-11", 700, "DEMO DELI ATLANTA"),
        hrow("h4", "2026-11-09", 4200, "Demo Gym", name="Demo Gym", original="2026-11-12"),
    ]
    sf_rows = [
        row("a", "2026-11-01", 900, desc="LONG BEFORE"),                 # before the cutover window: history has it
        row("b", "2026-11-11", 500, desc="DEMO CAFE ATLANTA GA"),        # one day from h1, same merchant, one to one
        row("c", "2026-11-11", 700, desc="DEMO DELI ATLANTA"),           # two identical purchases on the same day:
        row("d", "2026-11-11", 700, desc="DEMO DELI ATLANTA"),           # ... both are in the history: both match
        row("e", "2026-11-14", 4200, desc="DEMO GYM MONTHLY"),           # 5 days from h4's date, 2 from its original
        row("f", "2026-11-10", 300, desc="NOT IN THE HISTORY"),          # pending when Rocket Money last looked: kept
        row("g", "2026-11-20", 999, desc="AFTER THE CUTOVER"),           # kept
        row("s", "2026-11-02", 111, desc="STORED EARLIER"),              # stored by an earlier SimpleFIN run: kept
    ]
    kept, dropped, decisions = sf.apply_cutover(sf_rows, hist, CUT, {"s"})
    assert sorted(r["txn_key"] for r in kept) == ["f", "g", "s"]
    assert dropped == {"before the Rocket Money cutover": 1, "already in the Rocket Money history": 4}
    got = decided(decisions)
    assert got["b"] == ("matched", "merchant", ("h1",)) and got["e"] == ("matched", "merchant", ("h4",))
    assert {got["c"][2], got["d"][2]} == {("h2",), ("h3",)} and got["c"][:2] == got["d"][:2] == ("matched", "exact")
    assert "f" not in got and "g" not in got
    # Order-independent, and idempotent: a second run that sees the kept rows as stored decides the same.
    again = sf.apply_cutover(list(reversed(sf_rows)), list(reversed(hist)), CUT, {"s"})
    assert [r["txn_key"] for r in again[0]] == [r["txn_key"] for r in kept] and again[2] == decisions
    rerun = sf.apply_cutover(sf_rows, hist, CUT, {"s"} | {r["txn_key"] for r in kept})
    assert sorted(r["txn_key"] for r in rerun[0]) == ["f", "g", "s"] and rerun[2] == decisions
    assert sf.apply_cutover(sf_rows, hist, None, set())[0] == sf_rows


def test_cutover_ambiguous_overlap_is_kept_and_visible():
    hist = [hrow("h1", "2026-11-11", 700, "DEMO DELI ATLANTA"), hrow("h2", "2026-11-11", 700, "DEMO DELI ATLANTA")]
    sf_rows = [
        row("c", "2026-11-11", 700, desc="DEMO DELI ATLANTA"),     # exact twin of one of them
        row("d", "2026-11-12", 700, desc="DEMO DELI ATLANTA"),     # the other history row, or a new purchase?
        row("e", "2026-11-12", 700, desc="DEMO DELI ATLANTA"),     # two candidates for one row: never guessed
    ]
    kept, dropped, decisions = sf.apply_cutover(sf_rows, hist, CUT, set())
    got = decided(decisions)
    assert got["c"] == ("matched", "exact", ("h1",))
    assert got["d"] == got["e"] == ("ambiguous", None, ("h2",))
    assert sorted(r["txn_key"] for r in kept) == ["d", "e"] and dropped["already in the Rocket Money history"] == 1
    assert sf.cutover_counts(decisions) == {"matched exact": 1, "ambiguous": 2}
    # Each review row is reported once: not again when the same decision is already recorded.
    assert sf.new_review_count(decisions, None) == 2
    assert sf.new_review_count(decisions, {"d": {"decision": "ambiguous"}, "e": {"decision": "ambiguous"}}) == 0
    assert sf.new_review_count(decisions, {"d": {"decision": "ambiguous"}, "e": {"decision": "unconfirmed"}}) == 1
    # Recoverable: the record names the candidates, by key only.
    rows = sf.decision_rows(decisions, NOW)
    assert {tuple(sorted(r)) for r in rows} == {tuple(sorted(
        ["sf_txn_key", "account_key", "decision", "evidence", "history_txn_keys", "cutover_date", "decided_at"]))}
    assert next(r for r in rows if r["sf_txn_key"] == "d")["history_txn_keys"] == ["h2"]
    assert not any("DEMO" in str(v) or v == 700 for r in rows for v in r.values())


def test_cutover_repeat_purchases_pair_by_nearest_date():
    """Claude review: the same purchase on consecutive days, one row a day in each feed, with descriptions that
    differ between the feeds, pairs day by day (the nearest date on both sides) instead of turning the whole run
    of days ambiguous; with and without a Rocket Money description."""
    days = ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"]
    sf_rows = [row(f"s{i}", d, 525, desc="SQ *DEMO CAFE ATLANTA GA") for i, d in enumerate(days)]
    for desc in (None, "DEMO CAFE ATLANTA"):
        hist = [hrow(f"h{i}", d, 525, desc, name="Demo Cafe") for i, d in enumerate(days)]
        kept, dropped, decisions = sf.apply_cutover(sf_rows, hist, CUT, set())
        assert not kept and dropped == {"already in the Rocket Money history": 4}, desc
        assert decided(decisions) == {f"s{i}": ("matched", "merchant", (f"h{i}",)) for i in range(4)}, desc
        again = sf.apply_cutover(list(reversed(sf_rows)), list(reversed(hist)), CUT, set())
        assert again[2] == decisions, "order-independent"
    # A day Rocket Money lacks (pending when it last looked): its neighbours are the nearer twins, so it is kept.
    hist = [hrow(f"h{i}", d, 525, None, name="Demo Cafe") for i, d in enumerate(days) if i != 2]
    kept, dropped, decisions = sf.apply_cutover(sf_rows, hist, CUT, set())
    assert [r["txn_key"] for r in kept] == ["s2"] and "s2" not in decided(decisions)
    assert {k: v[2] for k, v in decided(decisions).items()} == {"s0": ("h0",), "s1": ("h1",), "s3": ("h3",)}
    # Two such purchases on one day in each feed cannot be told apart on either side: paired one for one.
    two = [row("t1", "2026-11-10", 450, desc="SQ *DEMO CAFE ATLANTA GA"), row("t2", "2026-11-10", 450, desc="SQ *DEMO CAFE ATLANTA GA")]
    pair = [hrow("g1", "2026-11-10", 450, None, name="Demo Cafe"), hrow("g2", "2026-11-10", 450, None, name="Demo Cafe")]
    kept, dropped, decisions = sf.apply_cutover(two, pair, CUT, set())
    assert not kept and decided(decisions) == {"t1": ("matched", "merchant", ("g1",)), "t2": ("matched", "merchant", ("g2",))}
    # One Rocket Money row between two SimpleFIN rows a day either side: a tie, never guessed.
    tie = [row("u1", "2026-11-09", 610, desc="SQ *DEMO CAFE ATLANTA GA"), row("u2", "2026-11-11", 610, desc="SQ *DEMO CAFE ATLANTA GA")]
    kept, dropped, decisions = sf.apply_cutover(tie, [hrow("k1", "2026-11-10", 610, None, name="Demo Cafe")], CUT, set())
    assert sorted(r["txn_key"] for r in kept) == ["u1", "u2"]
    assert decided(decisions) == {"u1": ("ambiguous", None, ("k1",)), "u2": ("ambiguous", None, ("k1",))}


def test_cutover_stored_rows_are_never_dropped():
    hist = [hrow("h1", "2026-11-10", 500, "DEMO CAFE ATLANTA"), hrow("h2", "2026-11-11", 800, "DEMO BAKERY ATLANTA")]
    sf_rows = [row("s1", "2026-11-11", 500, desc="DEMO CAFE ATLANTA GA"),    # stored earlier, but a history twin exists
               row("n1", "2026-11-11", 800, desc="DEMO BAKERY ATLANTA"),     # exact twin, not stored: dropped
               row("s2", "2026-11-11", 800, desc="DEMO BAKERY ATLANTA")]     # stored copy of the same: kept, not paired
    kept, dropped, decisions = sf.apply_cutover(sf_rows, hist, CUT, {"s1", "s2"})
    assert sorted(r["txn_key"] for r in kept) == ["s1", "s2"]
    got = decided(decisions)
    assert got["s1"] == ("stored_duplicate", "merchant", ("h1",)) and got["n1"] == ("matched", "exact", ("h2",))
    assert "s2" not in got, "unstored rows pair first in an exact group; the stored copy stays as it was"


def test_cutover_late_posted_row_is_judged_on_evidence():
    """A row transacted before the cutover window but posted after the cutover date may have been pending when
    Rocket Money last looked: it is matched on evidence like any other, never dropped on its date alone. A row
    posted by the cutover date was posted while Rocket Money still read the account (Claude review): dropped."""
    hist = [hrow("h1", "2026-11-05", 900, "DEMO TOYS ATLANTA")]   # Rocket Money dates by transaction day
    sf_rows = [
        row("late", "2026-11-05", 1200, desc="DEMO BOOKS ATLANTA", original="2026-11-12"),  # no twin: kept
        row("twin", "2026-11-05", 900, desc="DEMO TOYS ATLANTA", original="2026-11-12"),    # its twin is h1: dropped
        row("old", "2026-11-05", 400, desc="DEMO LAMPS ATLANTA"),                           # every date before: dropped
        row("seen", "2026-11-05", 600, desc="DEMO MAPS ATLANTA", original="2026-11-09"),    # posted by the cutover date
        row("edge", "2026-11-05", 650, desc="DEMO KITES ATLANTA", original="2026-11-11"),   # ... on the cutover date
    ]
    kept, dropped, decisions = sf.apply_cutover(sf_rows, hist, CUT, set())
    assert [r["txn_key"] for r in kept] == ["late"]
    assert dropped == {"before the Rocket Money cutover": 3, "already in the Rocket Money history": 1}
    assert decided(decisions) == {"twin": ("matched", "exact", ("h1",))}
    assert sf.in_cutover_window(row("x", "2026-11-08", 1, original="2026-11-01"), CUT)   # transacted in the window
    assert not sf.in_cutover_window(row("x", "2026-11-07", 1, original="2026-11-11"), CUT)
    assert sf.in_cutover_window(row("x", "2026-11-07", 1, original="2026-11-12"), CUT)


def test_cutover_twin_before_the_window_takes_its_history_row():
    """A Rocket Money row whose SimpleFIN twin is before the window belongs to that twin: a later purchase of the
    same amount at the same merchant is never matched to it. The twin's match is recorded (Codex review), so the
    Rocket Money row stays taken on later runs."""
    hist = [hrow("h1", "2026-11-07", 525, "DEMO CAFE ATLANTA", name="Demo Cafe")]
    exact = [row("s1", "2026-11-07", 525, desc="DEMO CAFE ATLANTA"),         # before the window, exact twin of h1
             row("s2", "2026-11-09", 525, desc="DEMO CAFE ATLANTA")]         # a new purchase two days later
    kept, dropped, decisions = sf.apply_cutover(exact, hist, CUT, set())
    assert [r["txn_key"] for r in kept] == ["s2"] and decided(decisions) == {"s1": ("matched", "exact", ("h1",))}
    assert dropped == {"before the Rocket Money cutover": 1}
    # Merchant evidence only (the descriptions differ): s1 is on h1's date, s2 two days later, so the nearest date
    # on both sides makes s1 the twin; s2 is kept (and not reported: no candidate is left for it).
    merchant = [row("s1", "2026-11-07", 525, desc="SQ *DEMO CAFE"), row("s2", "2026-11-09", 525, desc="SQ *DEMO CAFE")]
    kept, dropped, decisions = sf.apply_cutover(merchant, hist, CUT, set())
    assert [r["txn_key"] for r in kept] == ["s2"]
    assert decided(decisions) == {"s1": ("matched", "merchant", ("h1",))}


def test_cutover_match_before_the_window_holds_across_runs():
    """Codex review: a Rocket Money row taken by a SimpleFIN row before the window stays taken on a later run whose
    answer no longer has that row, so a new purchase of the same amount is kept, not matched to it."""
    hist = [hrow("h1", "2026-11-07", 525, "DEMO CAFE ATLANTA", name="Demo Cafe")]
    s1 = row("s1", "2026-11-07", 525, desc="SQ *DEMO CAFE")                          # before the window, h1's twin
    s2 = row("s2", "2026-11-08", 525, desc="SQ *DEMO CAFE", original="2026-11-13")   # posted after the first run
    kept, dropped, first = sf.apply_cutover([s1], hist, CUT, set())
    assert not kept and dropped == {"before the Rocket Money cutover": 1}
    assert decided(first) == {"s1": ("matched", "merchant", ("h1",))}
    claims = sf.recorded_claims({r["sf_txn_key"]: r for r in sf.decision_rows(first, NOW)})
    assert claims == {"h1": {"s1"}}
    kept, dropped, decisions = sf.apply_cutover([s2], hist, CUT, set(), claims)
    assert [r["txn_key"] for r in kept] == ["s2"] and not dropped and decided(decisions) == {}
    assert sf.apply_cutover([s2], hist, CUT, set())[0] == [], "without the record h1 would have taken it"
    # A row before the window with no twin records nothing.
    lone = row("s3", "2026-11-06", 333, desc="SQ *DEMO CAFE")
    assert sf.apply_cutover([lone], hist, CUT, set())[2] == []


def test_cutover_distinct_merchants_are_not_identity():
    """Codex review: a generic description with different payees, and two merchants that share only the kind of
    business and the city, are different purchases."""
    pos = [hrow("h1", "2026-11-11", 600, "POS PURCHASE", name="Other Shop")]
    kept, dropped, decisions = sf.apply_cutover([row("a", "2026-11-11", 600, desc="POS PURCHASE", name="Demo Cafe")], pos, CUT, set())
    assert [r["txn_key"] for r in kept] == ["a"] and not dropped
    assert decided(decisions) == {"a": ("unconfirmed", None, ("h1",))}
    assert sf.exact_key(row("a", "2026-11-11", 600, desc="POS PURCHASE")) is None
    assert sf.exact_key(row("a", "2026-11-11", 600, desc="COFFEE SHOP")) is None      # a kind of business, no name
    # Same distinctive description, contradicting payees: not exact either.
    kiosk = [hrow("h2", "2026-11-11", 650, "PLAZA KIOSK 0042", name="Other Shop")]
    b = row("b", "2026-11-11", 650, desc="PLAZA KIOSK 0042", name="Demo Cafe")
    kept, dropped, decisions = sf.apply_cutover([b], kiosk, CUT, set())
    assert [r["txn_key"] for r in kept] == ["b"] and decided(decisions) == {"b": ("unconfirmed", None, ("h2",))}
    assert sf.names_conflict(b, kiosk[0])
    # Two coffee shops in one city: two of three words shared, but not the one that names the business.
    a = row("c", "2026-11-11", 450, desc="DEMOBEANS COFFEE ATLANTA")
    h = hrow("h3", "2026-11-11", 450, "OTHERBREW COFFEE ATLANTA")
    assert not sf.merchant_evidence(a, h)
    kept, dropped, decisions = sf.apply_cutover([a], [h], CUT, set())
    assert [r["txn_key"] for r in kept] == ["c"] and decided(decisions) == {"c": ("unconfirmed", None, ("h3",))}
    assert sf.merchant_evidence(a, hrow("h4", "2026-11-10", 450, "DEMOBEANS #12", name="Demobeans Coffee"))
    # Two shops sharing their first word, the kind of business and the city (Codex review): kept for review.
    bottle = row("d", "2026-11-11", 475, desc="DEMO BOTTLE COFFEE ATLANTA")
    donkey = hrow("h5", "2026-11-11", 475, "DEMO DONKEY COFFEE ATLANTA", name="Demo Donkey Coffee")
    kept, dropped, decisions = sf.apply_cutover([bottle], [donkey], CUT, set())
    assert [r["txn_key"] for r in kept] == ["d"] and decided(decisions) == {"d": ("unconfirmed", None, ("h5",))}


def test_cutover_recorded_matches_hold_across_runs():
    """Codex review: a Rocket Money row an earlier run matched stays taken when its SimpleFIN row is missing from a
    later (narrower or incomplete) response, and a settled match is not reopened by a new same-merchant row."""
    hist = [hrow("h1", "2026-11-10", 800, "DEMO BAKERY ATLANTA", name="Demo Bakery")]
    s1 = row("s1", "2026-11-11", 800, desc="DEMO BAKERY 0042 ATLANTA GA")
    # A second purchase, transacted a day before h1 and posted after the first run: as near to h1 as s1 is.
    s2 = row("s2", "2026-11-09", 800, desc="DEMO BAKERY 0042 ATLANTA GA", original="2026-11-13")
    kept, dropped, first = sf.apply_cutover([s1], hist, CUT, set())
    assert not kept and decided(first) == {"s1": ("matched", "merchant", ("h1",))}
    saved = {r["sf_txn_key"]: r for r in sf.decision_rows(first, NOW)}
    claims = sf.recorded_claims(saved)
    assert claims == {"h1": {"s1"}}
    # s1 missing from this answer: h1 stays taken, s2 is kept (without the record it would have been dropped).
    kept, dropped, decisions = sf.apply_cutover([s2], hist, CUT, set(), claims)
    assert [r["txn_key"] for r in kept] == ["s2"] and not dropped and decided(decisions) == {}
    assert sf.apply_cutover([s2], hist, CUT, set())[0] == []
    # Both present: the settled match holds and the new row is kept (not both turned ambiguous).
    kept, dropped, decisions = sf.apply_cutover([s1, s2], hist, CUT, set(), claims)
    assert [r["txn_key"] for r in kept] == ["s2"] and decided(decisions) == {"s1": ("matched", "merchant", ("h1",))}
    assert decided(sf.apply_cutover([s1, s2], hist, CUT, set())[2]) == {
        "s1": ("ambiguous", None, ("h1",)), "s2": ("ambiguous", None, ("h1",))}
    # A record that no longer fits this row (another amount) is not forced on it.
    moved = dict(s1, amount_cents=900)
    assert sf.apply_cutover([moved], hist, CUT, set(), claims)[0] == [moved]
    assert sf.recorded_claims(None) == {}
    assert sf.recorded_claims({"x": {"decision": "ambiguous", "history_txn_keys": ["h1"]}}) == {}


# --- categories -------------------------------------------------------------------------------------------------
def test_categories():
    types = {"wf1": "Cash", "wf2": "Cash", "amex": "Credit Card"}
    rows = [
        row("p1", "2026-11-15", 25000, "wf1", "AMEX EPAYMENT ACH PMT"),             # bank side of a card payment
        row("p2", "2026-11-16", -25000, "amex", "AUTOPAY PAYMENT - THANK YOU"),     # card side
        row("t1", "2026-11-15", 10000, "wf1", "ONLINE TRANSFER TO SAVINGS"),
        row("t2", "2026-11-15", -10000, "wf2", "ONLINE TRANSFER FROM CHECKING"),
        row("z1", "2026-11-15", 4000, "wf1", "ZELLE TO DEMO FRIEND"),
        row("z2", "2026-11-15", -4000, "wf2", "ZELLE FROM DEMO FRIEND"),
        row("l1", "2026-11-15", 1800, "amex", "DEMO CAFE 0042 ATLANTA"),
        row("n1", "2026-11-15", 900, "amex", "SOMETHING NEW", name="Demo Gym"),
        row("k1", "2026-11-15", -3000, "amex", "PAYMENT RECEIVED THANK YOU"),       # unpaired card payment
        row("u1", "2026-11-15", 700, "amex", "NEVER SEEN BEFORE"),
        row("r1", "2026-11-15", -1800, "wf2", "DEMO REFUND"),                       # same size as nothing paired
    ]
    history = [
        {"description": "DEMO CAFE 0017 ATLANTA", "name": "Demo Cafe", "category": "Dining & Drinks"},
        {"description": "DEMO CAFE 0099 ATLANTA", "name": "Demo Cafe", "category": "Dining & Drinks"},
        {"description": "x1", "name": "Demo Gym", "category": "Health & Wellness"},
        {"description": "x2", "name": "Demo Gym", "category": "Health & Wellness"},
        {"description": "x3", "name": "Demo Gym", "category": "Health & Wellness"},
        {"description": "MIXED", "name": "Mixed", "category": "Shopping"},
        {"description": "MIXED", "name": "Mixed", "category": "Groceries"},
    ]
    learned = sf.learn_categories(history)
    assert learned["desc"]["DEMO CAFE ATLANTA"] == "Dining & Drinks" and "MIXED" not in learned["desc"]
    how = sf.assign_categories(rows, [], learned, types)
    cat = {r["txn_key"]: r["category"] for r in rows}
    assert cat["p1"] == cat["p2"] == "Credit Card Payment"
    assert cat["t1"] == cat["t2"] == "Internal Transfers"
    assert cat["z1"] is None and cat["z2"] is None      # person-to-person is never an internal transfer
    assert cat["l1"] == "Dining & Drinks" and cat["n1"] == "Health & Wellness"
    assert cat["k1"] == "Credit Card Payment" and cat["u1"] is None and cat["r1"] is None
    assert how["paired transfer"] == 4


def test_pair_with_history_row():
    # The Wells Fargo side came from Rocket Money; the new SimpleFIN card-side row pairs with it.
    pool = [row("h", "2026-11-10", 5000, "wf1", "APPLECARD GSBANK PAYMENT", source="rocketmoney")]
    rows = [row("s", "2026-11-11", -5000, "acard", "PAYMENT")]
    sf.assign_categories(rows, pool, {}, {"wf1": "Cash", "acard": "Credit Card"})
    assert rows[0]["category"] == "Credit Card Payment"


# --- balances ---------------------------------------------------------------------------------------------------
def test_balance_row():
    a = sf.SfAccount("A", "Card", "Demo", "", None, "USD", -12050, datetime(2026, 11, 20, 12, tzinfo=timezone.utc))
    assert sf.balance_row(a, "k", "liability")["balance_cents"] == 12050
    assert sf.balance_row(a, "k", None)["balance_cents"] == -12050
    a.balance_at = None
    assert sf.balance_row(a, "k", "asset") is None


# --- run() end to end -------------------------------------------------------------------------------------------
class FakeApiError(Exception):
    """Like postgrest's APIError: the code is an attribute, the message is free text (never to be shown)."""

    def __init__(self, code, message="synthetic"):
        super().__init__(message)
        self.code = code


class FakeStore:
    def __init__(self, accounts, kinds=None, cutovers=None, window=None, history=None):
        self._accounts, self.kinds, self.cutovers = accounts, kinds or {}, cutovers or {}
        self._window, self._history = window or [], history or []
        self.created, self.links, self.txns, self.balances, self.beats = [], [], [], [], []
        self.saved, self.saved_rows = {}, []
        self.read_error = None   # raised by cutover_decisions when set

    def accounts(self):
        return [dict(a) for a in self._accounts]

    def latest_kind(self, key):
        return self.kinds.get(key)

    def cutover(self, key):
        return self.cutovers.get(key)

    def window_rows(self, since):
        stored = {t["txn_key"]: dict(t) for t in self.txns}   # what earlier runs on this store wrote
        return list(self._window) + list(stored.values())

    def cutover_decisions(self):
        if self.read_error is not None:
            raise self.read_error
        return dict(self.saved)

    def save_cutover_decisions(self, rows):
        self.saved_rows.extend(rows)
        self.saved.update({r["sf_txn_key"]: {"decision": r["decision"], "history_txn_keys": list(r["history_txn_keys"])}
                           for r in rows})

    def history_for_learning(self, since):
        return list(self._history)

    def link_account(self, key, sf_id, today):
        self.links.append((key, sf_id))

    def create_account(self, r):
        self.created.append(r)

    def upsert_transactions(self, rows):
        self.txns.extend(rows)

    def upsert_balances(self, rows):
        self.balances.extend(rows)

    def heartbeat(self, data_type, status, records, started, error, start=None, end=None):
        self.beats.append((data_type, status, records, error))


def body(errlist=()):
    return {
        "errlist": list(errlist),
        "connections": [{"conn_id": "c1", "name": "American Express"}, {"conn_id": "c2", "name": "Wells Fargo"},
                        {"conn_id": "c3", "name": "Fidelity Investments"}],
        "accounts": [
            acct("S-AMEX", "Platinum Card (1003)", "c1", [txn("1", "2026-11-18", "-18.00", "DEMO CAFE 0042 ATLANTA")], "-300.00"),
            acct("S-WF", "Checking 7000", "c2", [txn("2", "2026-11-18", "-250.00", "AMEX EPAYMENT ACH PMT")], "1500.00"),
            acct("S-FID", "Demo 401k", "c3", [txn("3", "2026-11-18", "100.00", "DIVIDEND")], "9000.00"),
        ],
    }


def ledger_with_fidelity():
    return LEDGER + [{"account_key": "fid", "institution": "Fidelity", "account_name": "Demo 401k", "account_type": "Investment", "mask": None}]


def test_run_success_counts_only():
    store = FakeStore(ledger_with_fidelity(), kinds={"amex": "liability", "wf1": "asset", "fid": "asset"},
                      cutovers={"amex": date(2026, 11, 11), "wf1": date(2026, 11, 11)})
    lines = []
    code = sf.run(store, Http(get=Res(200, body())), ACCESS, 60, False, now=NOW, out=lines.append)
    assert code == 0
    assert [b[:2] for b in store.beats] == [("transactions", "success"), ("balances", "success")]
    assert len(store.txns) == 2 and all(t["source"] == "simplefin" for t in store.txns)   # Fidelity: balances only
    assert {b["account_key"] for b in store.balances} == {"amex", "wf1", "fid"}
    assert next(b for b in store.balances if b["account_key"] == "amex")["balance_cents"] == 30000
    assert sorted(store.links) == [("amex", "S-AMEX"), ("fid", "S-FID"), ("wf1", "S-WF")]
    out = "\n".join(lines)
    for private in ("DEMO CAFE", "AMEX EPAYMENT", "Platinum", "Checking", "1003", "-18", "250"):
        assert private not in out, f"routine output must be counts only, found {private!r}"
    assert_no_secret(out)


def test_run_partial_and_dry_run():
    store = FakeStore(ledger_with_fidelity())
    code = sf.run(store, Http(get=Res(200, body([{"code": "con.auth", "msg": "Reconnect Wells Fargo", "conn_id": "c2"}]))),
                  ACCESS, 60, False, now=NOW, out=lambda *_: None)
    assert code == 0 and store.beats[0][1] == "partial"
    assert store.beats[0][3] == sf.format_notes({"sf_reauth": 1}) == store.beats[1][3]
    assert "Wells Fargo" not in store.beats[0][3], "the institution never reaches sync_log"

    dry = FakeStore(ledger_with_fidelity())
    lines = []
    errs = [{"code": "con.auth", "msg": pii_msg(), "conn_id": "c2"}]
    assert sf.run(dry, Http(get=Res(200, body(errs))), ACCESS, 60, True, now=NOW, out=lines.append) == 0
    assert not (dry.txns or dry.balances or dry.created or dry.links or dry.beats)
    assert any("Platinum" in line for line in lines)   # the local dry run shows the matching
    # ... flags the account whose connection SimpleFIN named, by our code; SimpleFIN's own text is never printed
    assert any("Checking 7000" in line and "SimpleFIN issue: sf_reauth" in line for line in lines), lines
    assert not any("SimpleFIN issue" in line for line in lines if "Platinum" in line)
    assert_no_pii("\n".join(lines))


def test_provider_text_never_reaches_heartbeats_or_output():
    """SEC-07: provider errors full of names, emails, URLs and short / long ids -> approved codes only."""
    errs = [{"code": c, "msg": pii_msg(i), "conn_id": f"c{i}", "account_id": PII[5]}
            for i, c in enumerate(["con.auth", "con.weird", "act.failed", "act.missingdata", "gen.auth", "gen.api",
                                   "gen.", "nope.x", "", None, pii_msg()])]
    errs += [pii_msg(99), 12345678, None]
    b = body(errs)
    b["errors"] = [pii_msg(100)]
    b["accounts"].append({"name": pii_msg(101), "conn_id": "c2"})               # account without an id
    b["accounts"].append(acct("S-WFX", "Some Account", "c2", [txn("9", "2026-11-18", "-1.00", "X")]))  # unmatched
    store = FakeStore(ledger_with_fidelity())
    lines = []
    assert sf.run(store, Http(get=Res(200, b)), ACCESS, 60, False, now=NOW, out=lines.append) == 0
    assert {beat[1] for beat in store.beats} == {"partial"}
    for beat in store.beats:
        assert_no_pii(beat[3])
        assert_only_allowlisted(beat[3])
        assert "Wells Fargo" not in beat[3] and "American Express" not in beat[3]
    note = store.beats[0][3]
    for code in ("sf_reauth", "sf_connection_error", "sf_account_failed", "sf_account_incomplete", "sf_server_auth",
                 "sf_api_error", "sf_general_error", "sf_unclassified", "account_no_id", "account_unmatched"):
        assert f"[{code}" in note, code
    out = "\n".join(lines)
    assert_no_pii(out)
    assert_no_secret(out)
    assert "heartbeat codes: sf_reauth x1" in out and "Wells Fargo" not in out


def test_run_failure_writes_failed_heartbeats():
    store = FakeStore(LEDGER)
    lines = []
    assert sf.run(store, Http(get=Res(403)), ACCESS, 60, False, now=NOW, out=lines.append) == 1
    assert [b[:2] for b in store.beats] == [("transactions", "failed"), ("balances", "failed")]
    assert store.beats[0][3] == sf.format_notes({"sf_access_refused": 1}) == store.beats[1][3]
    assert_no_secret(store.beats[0][3])
    assert_no_secret("\n".join(lines))


def test_failure_codes_and_recovery():
    cases = [
        (Res(402), "sf_payment_required", None),
        (Res(503), "sf_http_error", "HTTP 503"),
        (Res(200, None), "sf_bad_answer", None),
        (Res(200, {"accounts": "nope"}), "sf_bad_answer", None),
    ]
    for res, code, detail in cases:
        store, lines = FakeStore(LEDGER), []
        assert sf.run(store, Http(get=res), ACCESS, 60, False, now=NOW, out=lines.append) == 1
        assert [b[3] for b in store.beats] == [sf.format_notes({code: 1})] * 2, code
        assert (detail in lines[0]) if detail else "HTTP" not in lines[0]
    # A network error and an unexpected crash carry no exception text: only our code (+ the type name in the log).
    class Boom(Exception):
        pass

    class RaisingHttp(Http):
        def __init__(self, exc):
            super().__init__()
            self.exc = exc

        def get(self, url, **kw):
            raise self.exc

    store, lines = FakeStore(LEDGER), []
    assert sf.run(store, RaisingHttp(Boom(pii_msg())), ACCESS, 60, False, now=NOW, out=lines.append) == 1
    assert store.beats[0][3] == sf.format_notes({"sf_unreachable": 1})
    assert_no_pii("\n".join(lines))

    class CrashingStore(FakeStore):
        def accounts(self):
            raise KeyError(pii_msg())

    crash, lines = CrashingStore(LEDGER), []
    assert sf.run(crash, Http(get=Res(200, body())), ACCESS, 60, False, now=NOW, out=lines.append) == 1
    assert crash.beats[0][3] == sf.format_notes({"etl_error": 1}) and "(KeyError)" in lines[0]
    assert_no_pii(crash.beats[0][3] + "\n".join(lines))

    class WriteFails(FakeStore):
        def upsert_transactions(self, rows):
            raise RuntimeError(f"duplicate key value violates unique constraint; row: {pii_msg()}")

    wf, lines = WriteFails(ledger_with_fidelity()), []
    assert sf.run(wf, Http(get=Res(200, body())), ACCESS, 60, False, now=NOW, out=lines.append) == 1
    assert [b[1] for b in wf.beats] == ["failed", "failed"] and wf.beats[0][3] == sf.format_notes({"db_write_failed": 1})
    assert_no_pii(wf.beats[0][3] + "\n".join(lines))
    # Recovery: the next good run writes success with no note at all (nothing sticks from the failure).
    good = FakeStore(ledger_with_fidelity())
    assert sf.run(good, Http(get=Res(200, body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert [(b[1], b[3]) for b in good.beats] == [("success", None), ("success", None)]
    # The not-connected path (main) and a malformed Access URL map to their own codes.
    assert sf.failure_code(sf.SimpleFinError("sf_not_connected")) == ("sf_not_connected", None)
    bad_url = expect_error(sf.split_access_url, "https://u:p@evil.example.com/x")
    assert "evil.example.com" not in bad_url
    store = FakeStore(LEDGER)
    assert sf.run(store, Http(get=Res(200, body())), "https://u:p@evil.example.com/x", 60, False, now=NOW, out=lambda *_: None) == 1
    assert store.beats[0][3] == sf.format_notes({"sf_access_url_invalid": 1})
    assert sf.failure_code(sf.SimpleFinError("claim_failed", "x")) == ("etl_error", "SimpleFinError")


def test_skipped_account_is_partial():
    b = body()
    b["accounts"].append(acct("S-WFX", "Some Account", "c2", [txn("9", "2026-11-18", "-1.00", "X")]))
    store = FakeStore(ledger_with_fidelity())
    sf.run(store, Http(get=Res(200, b)), ACCESS, 60, False, now=NOW, out=lambda *_: None)
    assert store.beats[0][1] == "partial" and store.beats[0][3] == sf.format_notes({"account_unmatched": 1})
    assert "Wells Fargo" not in store.beats[0][3] and "Some Account" not in store.beats[0][3]
    assert not any(t["source_txn_id"].startswith("sf:S-WFX") for t in store.txns)


def cutover_body():
    b = body()
    wf = next(a for a in b["accounts"] if a["id"] == "S-WF")
    wf["transactions"] = [
        txn("w1", "2026-11-11", "-15.00", "OTHER PHARMACY 0202 ATLANTA"),   # same day and amount as a grocer row
        txn("w2", "2026-11-10", "-7.00", "DEMO DELI ATLANTA"),              # the history has exactly this
    ]
    return b


def cutover_store(cls=None):
    window = [hrow("rm-1", "2026-11-11", 1500, "DEMO GROCER 0101 ATLANTA"), hrow("rm-2", "2026-11-10", 700, "DEMO DELI ATLANTA")]
    return (cls or FakeStore)(ledger_with_fidelity(), kinds={"wf1": "asset"}, cutovers={"wf1": CUT}, window=window)


def test_run_cutover_review_reported_once_and_recorded():
    store = cutover_store()
    lines = []
    assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lines.append) == 0
    written = {t["source_txn_id"] for t in store.txns}
    assert "sf:S-WF:w1" in written, "a different purchase of the same amount is kept"
    assert "sf:S-WF:w2" not in written, "the exact duplicate is not written twice"
    assert store.beats[0][1] == "partial" and store.beats[0][3] == sf.format_notes({"cutover_review": 1})
    assert sorted(r["decision"] for r in store.saved_rows) == ["matched", "unconfirmed"]
    out = "\n".join(lines)
    assert "cutover decisions: {" in out
    for private in ("PHARMACY", "GROCER", "DELI", "rm-1", "rm-2", "15.00", "1500"):
        assert private not in out, f"routine output must be counts only, found {private!r}"
    # The next run: the kept row is stored now and its decision is recorded, so nothing new to report.
    lines2 = []
    assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lines2.append) == 0
    assert [(b[1], b[3]) for b in store.beats[2:]] == [("success", None), ("success", None)]
    assert sum(1 for t in store.txns if t["source_txn_id"] == "sf:S-WF:w1") == 2   # rewritten in place (same key)
    assert len({t["txn_key"] for t in store.txns if t["source_txn_id"] == "sf:S-WF:w1"}) == 1
    assert not any(t["source_txn_id"] == "sf:S-WF:w2" for t in store.txns)
    # Reported once, but the dry run keeps listing the rows recorded for review (all runs), counts only.
    lines4, before = [], (len(store.txns), len(store.saved_rows), len(store.beats))
    assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, True, now=NOW, out=lines4.append) == 0
    assert "recorded for review (all runs): {'unconfirmed': 1}" in "\n".join(lines4)
    assert (len(store.txns), len(store.saved_rows), len(store.beats)) == before
    # The dry run is the reconciliation preview: counts per account, nothing written.
    dry, lines3 = cutover_store(), []
    assert sf.run(dry, Http(get=Res(200, cutover_body())), ACCESS, 60, True, now=NOW, out=lines3.append) == 0
    assert not (dry.txns or dry.saved_rows or dry.beats)
    preview = "\n".join(lines3)
    assert "kept for review {'unconfirmed': 1}" in preview and "new for review: 1" in preview
    assert "PHARMACY" not in preview and "GROCER" not in preview


def test_run_cutover_record_unavailable_is_partial_and_keeps_rows():
    for missing in ("PGRST205", "42P01"):   # PostgREST / Postgres: the table is not applied yet
        class NoTable(FakeStore):
            def cutover_decisions(self):
                raise FakeApiError(missing, "relation pds.finance_cutover_matches does not exist")

        store = cutover_store(NoTable)
        lines = []
        assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lines.append) == 0
        assert "sf:S-WF:w1" in {t["source_txn_id"] for t in store.txns}
        assert store.beats[0][1] == "partial"
        # Only the missing record is reported while it cannot be read (every run says so; the review rows wait) ...
        assert store.beats[0][3] == sf.format_notes({"cutover_provenance_unsaved": 1})
        assert "does not exist" not in "\n".join(lines)
        assert store.saved_rows == [], "decisions made without the record are never saved over it"
    # A save that fails after a good read is reported the same way.
    class SaveFails(FakeStore):
        def save_cutover_decisions(self, rows):
            raise FakeApiError("57014", pii_msg())

    failing = cutover_store(SaveFails)
    assert sf.run(failing, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert failing.beats[0][3] == sf.format_notes({"cutover_provenance_unsaved": 1})
    # ... and the first run that records the decisions (after the table is applied) reports the review rows, once.
    applied = cutover_store()
    applied.txns = list(store.txns)
    assert sf.run(applied, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert applied.beats[0][3] == sf.format_notes({"cutover_review": 1})
    assert sf.run(applied, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert applied.beats[2][1] == "success"


def test_run_recorded_match_survives_a_response_without_its_row():
    """End to end through the record: run 1 matches a row to its Rocket Money twin; run 2's answer lacks that row
    and has a new same-merchant purchase, which is written, not matched to the taken twin."""
    window = [hrow("rm-3", "2026-11-10", 800, "DEMO BAKERY ATLANTA", name="Demo Bakery")]
    store = FakeStore(ledger_with_fidelity(), kinds={"wf1": "asset"}, cutovers={"wf1": CUT}, window=window)
    first, second = body(), body()
    next(a for a in first["accounts"] if a["id"] == "S-WF")["transactions"] = [
        txn("b1", "2026-11-11", "-8.00", "DEMO BAKERY 0042 ATLANTA GA")]
    next(a for a in second["accounts"] if a["id"] == "S-WF")["transactions"] = [
        txn("b2", "2026-11-12", "-8.00", "DEMO BAKERY 0042 ATLANTA GA")]
    assert sf.run(store, Http(get=Res(200, first)), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert not any(t["source_txn_id"] == "sf:S-WF:b1" for t in store.txns)
    assert [r["decision"] for r in store.saved_rows] == ["matched"]
    assert sf.run(store, Http(get=Res(200, second)), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert any(t["source_txn_id"] == "sf:S-WF:b2" for t in store.txns), "the new purchase is kept"
    assert store.beats[2][1] == "success"


def test_run_cutover_record_read_error_fails_before_writing():
    """Claude + Codex review: a failed read of the record (anything but 'not applied yet') stops the run before any
    write, so matching without the record can neither write a duplicate nor save over recorded matches; the next
    good run recovers, with the original claimant absent from its answer."""
    window = [hrow("rm-4", "2026-11-10", 800, "DEMO BAKERY ATLANTA", name="Demo Bakery")]
    store = FakeStore(ledger_with_fidelity(), kinds={"wf1": "asset"}, cutovers={"wf1": CUT}, window=window)
    first, second = body(), body()
    next(a for a in first["accounts"] if a["id"] == "S-WF")["transactions"] = [
        txn("b1", "2026-11-11", "-8.00", "DEMO BAKERY 0042 ATLANTA GA")]
    next(a for a in second["accounts"] if a["id"] == "S-WF")["transactions"] = [
        txn("b2", "2026-11-12", "-8.00", "DEMO BAKERY 0042 ATLANTA GA")]
    assert sf.run(store, Http(get=Res(200, first)), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    recorded, written, rows_saved = dict(store.saved), list(store.txns), list(store.saved_rows)
    assert [r["decision"] for r in rows_saved] == ["matched"]
    for err in (FakeApiError("57014", pii_msg()), RuntimeError(pii_msg()), TimeoutError(), FakeApiError(None, pii_msg())):
        store.read_error = err
        lines = []
        assert sf.run(store, Http(get=Res(200, second)), ACCESS, 60, False, now=NOW, out=lines.append) == 1, err
        assert [b[:2] for b in store.beats[-2:]] == [("transactions", "failed"), ("balances", "failed")]
        assert store.beats[-1][3] == store.beats[-2][3] == sf.format_notes({"db_read_failed": 1})
        assert store.txns == written and store.saved == recorded and store.saved_rows == rows_saved, "nothing written"
        assert_no_pii("\n".join(lines) + store.beats[-1][3])
    # Recovery: the record is read again, so b1's twin stays taken and the new purchase is written.
    store.read_error = None
    assert sf.run(store, Http(get=Res(200, second)), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert any(t["source_txn_id"] == "sf:S-WF:b2" for t in store.txns)
    assert store.beats[-1][1] == "success" and store.saved == recorded


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"{len(tests)} passed")
