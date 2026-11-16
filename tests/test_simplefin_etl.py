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
    """Two identical Rocket Money rows; one SimpleFIN row on their day and two the next day. No group is one to one
    or of equal size, so nothing is guessed (Claude review: one row for two identical twins is not paired either,
    since key order would pick the twin): all three are kept, recorded with both candidates and reported."""
    hist = [hrow("h1", "2026-11-11", 700, "DEMO DELI ATLANTA"), hrow("h2", "2026-11-11", 700, "DEMO DELI ATLANTA")]
    sf_rows = [
        row("c", "2026-11-11", 700, desc="DEMO DELI ATLANTA"),     # exact text of both: which one, or neither?
        row("d", "2026-11-12", 700, desc="DEMO DELI ATLANTA"),     # a history row posted late, or a new purchase?
        row("e", "2026-11-12", 700, desc="DEMO DELI ATLANTA"),     # the same: never guessed
    ]
    kept, dropped, decisions = sf.apply_cutover(sf_rows, hist, CUT, set())
    assert decided(decisions) == {k: ("ambiguous", None, ("h1", "h2")) for k in ("c", "d", "e")}
    assert sorted(r["txn_key"] for r in kept) == ["c", "d", "e"] and not dropped
    assert sf.cutover_counts(decisions) == {"ambiguous": 3}
    assert sf.apply_cutover(list(reversed(sf_rows)), list(reversed(hist)), CUT, set())[2] == decisions, "order-independent"
    # Each review row is reported until a written heartbeat carried it (review_state 'reported'), then not again
    # while its decision is unchanged; a changed decision, or one still 'pending', is reported (again).
    assert sf.new_review_count(decisions, None) == 3
    same = {k: {"decision": "ambiguous", "review_state": "reported"} for k in ("c", "d", "e")}
    assert sf.new_review_count(decisions, same) == 0
    assert sf.new_review_count(decisions, {"d": {"decision": "ambiguous", "review_state": "reported"},
                                           "e": {"decision": "unconfirmed", "review_state": "reported"}}) == 2
    assert sf.new_review_count(decisions, dict(same, d={"decision": "ambiguous", "review_state": "pending"})) == 1
    assert sf.new_review_count(decisions, {k: {"decision": "ambiguous"} for k in ("c", "d", "e")}) == 3
    # Recoverable: the record names the candidates, by key only.
    rows = sf.decision_rows(decisions, NOW)
    assert {tuple(sorted(r)) for r in rows} == {tuple(sorted(
        ["sf_txn_key", "account_key", "decision", "evidence", "history_txn_keys", "cutover_date", "decided_at",
         "review_state"]))}
    assert {r["review_state"] for r in rows} == {"pending"}
    assert next(r for r in rows if r["sf_txn_key"] == "d")["history_txn_keys"] == ["h1", "h2"]
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
    hist = [hrow("h1", "2026-11-10", 500, "DEMO CAFE ATLANTA"), hrow("h2", "2026-11-11", 800, "DEMO BAKERY ATLANTA"),
            hrow("h3", "2026-11-11", 900, "DEMO PRINTS ATLANTA")]
    sf_rows = [row("s1", "2026-11-11", 500, desc="DEMO CAFE ATLANTA GA"),    # stored earlier, but a history twin exists
               row("n1", "2026-11-11", 800, desc="DEMO BAKERY ATLANTA"),     # exact twin of h2, not stored ...
               row("s2", "2026-11-11", 800, desc="DEMO BAKERY ATLANTA"),     # ... and a stored copy of the same
               row("n2", "2026-11-11", 900, desc="DEMO PRINTS ATLANTA")]     # exact twin, alone: dropped
    kept, dropped, decisions = sf.apply_cutover(sf_rows, hist, CUT, {"s1", "s2"})
    assert sorted(r["txn_key"] for r in kept) == ["n1", "s1", "s2"]
    assert dropped == {"already in the Rocket Money history": 1}
    got = decided(decisions)
    assert got["s1"] == ("stored_duplicate", "merchant", ("h1",)) and got["n2"] == ("matched", "exact", ("h3",))
    # Two SimpleFIN rows that cannot be told apart and one Rocket Money twin (Codex review): which one is the twin is
    # not known, so neither is matched, also when one of them was stored by an earlier run. Both are kept for review.
    assert got["n1"] == got["s2"] == ("ambiguous", None, ("h2",))


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


def test_cutover_generic_payee_words_are_not_identity():
    """Codex review (R1): identical bank descriptions with different payees that share only a generic word (STORE,
    COFFEE) are two purchases: never matched, kept and counted for review. A payee of generic words only is no
    evidence either way, and a processor payee still agrees with the merchant name."""
    desc = "PLAZA KIOSK 0042"
    hist = [hrow("h1", "2026-11-11", 640, desc, name="Other Store")]
    a = row("a", "2026-11-11", 640, desc=desc, name="Demo Store")
    assert sf.names_conflict(a, hist[0]) and not sf.merchant_evidence(a, hist[0])
    kept, dropped, decisions = sf.apply_cutover([a], hist, CUT, set())
    assert [r["txn_key"] for r in kept] == ["a"] and not dropped
    assert decided(decisions) == {"a": ("unconfirmed", None, ("h1",))}
    assert sf.cutover_counts(decisions) == {"unconfirmed": 1}
    # The same with kinds of business on both sides, and with a shared city ('Demo Atlanta' vs 'Other Atlanta').
    for mine, theirs in (("Demo Coffee Store", "Other Coffee Store"), ("Demo Atlanta", "Other Atlanta")):
        b = row("b", "2026-11-11", 640, desc=desc, name=mine)
        h = hrow("h2", "2026-11-11", 640, desc, name=theirs)
        assert sf.names_conflict(b, h), (mine, theirs)
        assert sf.apply_cutover([b], [h], CUT, set())[0] == [b], (mine, theirs)
    # A generic-only payee says nothing: the description (store number included) decides.
    store = row("c", "2026-11-11", 640, desc=desc, name="Store")
    assert not sf.names_conflict(store, hist[0])
    assert decided(sf.apply_cutover([store], hist, CUT, set())[2]) == {"c": ("matched", "exact", ("h1",))}
    # A processor as payee ('Square') agrees with the merchant name on the description.
    sq = row("d", "2026-11-11", 640, desc="SQ *DEMO CAFE", name="Square")
    assert not sf.names_conflict(sq, hrow("h3", "2026-11-11", 640, "SQ *DEMO CAFE", name="Demo Cafe"))
    # Store numbers are part of the exact text: two shops of one chain on one day pair by their numbers, not by
    # key order.
    shops = [row("s1", "2026-11-11", 300, desc="DEMO DELI 0099 ATLANTA"), row("s2", "2026-11-11", 300, desc="DEMO DELI 0042 ATLANTA")]
    twins = [hrow("k1", "2026-11-11", 300, "DEMO DELI 0042 ATLANTA"), hrow("k2", "2026-11-11", 300, "DEMO DELI 0099 ATLANTA")]
    assert sf.exact_key(shops[0]) != sf.exact_key(shops[1])
    kept, dropped, decisions = sf.apply_cutover(shops, twins, CUT, set())
    assert not kept and decided(decisions) == {"s1": ("matched", "exact", ("k2",)), "s2": ("matched", "exact", ("k1",))}


def test_cutover_unequal_groups_are_never_guessed():
    """Codex + Claude review (R3): a group with unequal numbers of SimpleFIN and Rocket Money rows is never paired by
    key order, in the exact step and the merchant step: more SimpleFIN rows than twins, and fewer (one row for two
    identical twins: which twin, or whether either, is not known). All of its rows are kept and recorded as
    ambiguous, and the twins are held so no other row takes them. Twins that can be told apart competing for one
    row are never guessed either."""
    hist = [hrow("h1", "2026-11-11", 820, "DEMO DELI ATLANTA")]
    d = row("d", "2026-11-11", 820, desc="DEMO DELI ATLANTA")
    e = row("e", "2026-11-11", 820, desc="DEMO DELI ATLANTA")
    f = row("f", "2026-11-12", 820, desc="DEMO DELI ATLANTA GA")    # the next day, same merchant: h1 is held
    assert sf.merchant_evidence(f, hist[0]), "without the hold f would be matched to h1"
    kept, dropped, decisions = sf.apply_cutover([e, f, d], hist, CUT, set())
    assert sorted(r["txn_key"] for r in kept) == ["d", "e", "f"] and not dropped
    assert decided(decisions) == {k: ("ambiguous", None, ("h1",)) for k in ("d", "e", "f")}
    assert sf.new_review_count(decisions, {}) == 3
    assert sf.apply_cutover([d, e, f], list(hist), CUT, set())[2] == decisions, "order-independent"
    # Merchant step (descriptions differ between the feeds): two identical rows, one twin -> both ambiguous.
    m = [row("m1", "2026-11-10", 410, desc="SQ *DEMO CAFE ATLANTA GA"), row("m2", "2026-11-10", 410, desc="SQ *DEMO CAFE ATLANTA GA")]
    kept, dropped, decisions = sf.apply_cutover(m, [hrow("g1", "2026-11-10", 410, None, name="Demo Cafe")], CUT, set())
    assert len(kept) == 2 and decided(decisions) == {"m1": ("ambiguous", None, ("g1",)), "m2": ("ambiguous", None, ("g1",))}
    # One row for two identical twins (Claude review): never paired by key order. Kept, with both candidates.
    two = [hrow("h1", "2026-11-11", 820, "DEMO DELI ATLANTA"), hrow("h2", "2026-11-11", 820, "DEMO DELI ATLANTA")]
    kept, dropped, decisions = sf.apply_cutover([d], two, CUT, set())
    assert kept == [d] and not dropped and decided(decisions) == {"d": ("ambiguous", None, ("h1", "h2"))}
    assert sf.new_review_count(decisions, {}) == 1
    # ... in the merchant step too, where a row a day later cannot take either twin (both are nearer to m1).
    g = [hrow("g1", "2026-11-10", 410, None, name="Demo Cafe"), hrow("g2", "2026-11-10", 410, None, name="Demo Cafe")]
    m1 = row("m1", "2026-11-10", 410, desc="SQ *DEMO CAFE ATLANTA GA")
    m2 = row("m2", "2026-11-11", 410, desc="SQ *DEMO CAFE ATLANTA GA")
    kept, dropped, decisions = sf.apply_cutover([m2, m1], g, CUT, set())
    assert sorted(r["txn_key"] for r in kept) == ["m1", "m2"] and not dropped
    assert decided(decisions) == {"m1": ("ambiguous", None, ("g1", "g2")), "m2": ("ambiguous", None, ("g1", "g2"))}
    # Two twins that can be told apart (different merchant names) for one row: never guessed.
    told = [hrow("t1", "2026-11-11", 820, "DEMO DELI ATLANTA", name="Demo Deli"),
            hrow("t2", "2026-11-11", 820, "DEMO DELI ATLANTA", name="Demo Deli Midtown")]
    kept, dropped, decisions = sf.apply_cutover([dict(d, name="Demo Deli")], told, CUT, set())
    assert len(kept) == 1 and decided(decisions) == {"d": ("ambiguous", None, ("t1", "t2"))}


def test_cutover_store_numbers_are_identity():
    """Codex review: two shops of one chain share every word once the digits are dropped. Different store numbers on
    the same day and amount are two purchases, never matched in the merchant step either: the row is kept and
    listed for review. A number on one side only, or one side's numbers all on the other, still agrees."""
    h = hrow("h1", "2026-11-11", 300, "DEMO DELI 0099")
    a = row("a", "2026-11-11", 300, desc="DEMO DELI 0042")
    assert sf.exact_key(a) != sf.exact_key(h) and sf.numbers_conflict(a, h) and sf.identity_conflict(a, h)
    assert not sf.merchant_evidence(a, h) and sf.same_purchase(a, h) is None
    kept, dropped, decisions = sf.apply_cutover([a], [h], CUT, set())
    assert kept == [a] and not dropped and decided(decisions) == {"a": ("unconfirmed", None, ("h1",))}
    assert sf.new_review_count(decisions, {}) == 1
    # The same number written differently ('#', leading zeros) is one number.
    assert sf.store_numbers(row("x", "2026-11-11", 1, desc="DEMO DELI #0042 ATLANTA")) == {"42"}
    assert sf.merchant_evidence(a, hrow("h2", "2026-11-12", 300, "DEMO DELI #042 ATLANTA GA"))
    # A number on one side only (the other feed left it out), or an extra number on one side, agrees.
    assert sf.merchant_evidence(a, hrow("h3", "2026-11-10", 300, None, name="Demo Deli"))
    extra = row("b", "2026-11-11", 300, desc="DEMO DELI 0042 1114")
    assert sf.merchant_evidence(extra, hrow("h4", "2026-11-11", 300, "DEMO DELI 0042"))
    # ... but two shops with the same extra number still differ.
    assert sf.numbers_conflict(extra, hrow("h5", "2026-11-11", 300, "DEMO DELI 0099 1114"))
    # Dates and short numbers are not store numbers.
    assert sf.store_numbers(row("y", "2026-11-11", 1, desc="DEMO DELI 11/14 #7")) == frozenset()
    # Same description, payees naming two store numbers: not exact either.
    p1 = row("p", "2026-11-11", 300, desc="PLAZA KIOSK", name="Demo Deli 0042")
    p2 = hrow("h6", "2026-11-11", 300, "PLAZA KIOSK", name="Demo Deli 0099")
    assert sf.exact_key(p1) == sf.exact_key(p2) and sf.same_purchase(p1, p2) is None
    assert decided(sf.apply_cutover([p1], [p2], CUT, set())[2]) == {"p": ("unconfirmed", None, ("h6",))}


def test_cutover_different_kinds_of_business_are_not_identity():
    """Codex review (round 7): a word that names a kind of business is no evidence FOR a match, but two different
    kinds are evidence AGAINST one. 'DEMO CAFE ATLANTA' and 'DEMO HOTEL ATLANTA' agree on every other word and are
    two businesses: the row is kept and listed for review, in the merchant step and in the exact step (one bank text,
    payees of two kinds). A kind on one side only, or one side's kinds all on the other, still agrees."""
    cafe = row("a", "2026-11-11", 1250, desc="DEMO CAFE ATLANTA")
    hotel = hrow("h1", "2026-11-11", 1250, "DEMO HOTEL ATLANTA")
    assert sf.trades_conflict(cafe, hotel) and sf.identity_conflict(cafe, hotel)
    assert not sf.merchant_evidence(cafe, hotel) and sf.same_purchase(cafe, hotel) is None
    kept, dropped, decisions = sf.apply_cutover([cafe], [hotel], CUT, set())
    assert kept == [cafe] and not dropped and decided(decisions) == {"a": ("unconfirmed", None, ("h1",))}
    assert sf.new_review_count(decisions, {}) == 1
    assert sf.same_purchase(dict(cafe, txn_date="2026-11-10"), hotel) is None, "a day apart: the merchant step"
    # The exact step: the same bank text, payees naming two kinds of business.
    p1 = row("p", "2026-11-11", 1250, desc="SQ *DEMO ATLANTA", name="Demo Cafe")
    p2 = hrow("h2", "2026-11-11", 1250, "SQ *DEMO ATLANTA", name="Demo Hotel")
    assert sf.exact_key(p1) == sf.exact_key(p2) and not sf.names_conflict(p1, p2) and sf.trades_conflict(p1, p2)
    kept, dropped, decisions = sf.apply_cutover([p1], [p2], CUT, set())
    assert kept == [p1] and decided(decisions) == {"p": ("unconfirmed", None, ("h2",))}
    # Still one business: a kind on one side only, or one side's kinds all on the other.
    bar = row("b", "2026-11-11", 900, desc="DEMO COFFEE BAR ATLANTA")
    assert sf.merchant_evidence(bar, hrow("h3", "2026-11-11", 900, None, name="Demo Coffee"))
    assert sf.merchant_evidence(cafe, hrow("h4", "2026-11-10", 1250, None, name="Demo"))
    assert not sf.trades_conflict(cafe, hrow("h5", "2026-11-11", 1250, "DEMO CAFE BAKERY ATLANTA"))


def test_cutover_claim_whose_twin_is_not_in_the_history():
    """Codex review (round 7): a recorded claim is carried for its row whether or not the Rocket Money row it names is
    in this run's history. build_plan reads every named row by key, so one missing here is not in the ledger any
    more: the row is decided again and kept for review ('unconfirmed', naming the recorded key), never written
    unremarked while the record still says 'matched'."""
    s1 = row("s1", "2026-11-11", 800, desc="DEMO BAKERY 0042 ATLANTA GA")
    for decision in ("matched", "stored_duplicate"):
        rec = {"s1": {"decision": decision, "history_txn_keys": ["gone"], "review_state": None}}
        stored = {"s1"} if decision == "stored_duplicate" else set()
        kept, dropped, decisions = sf.apply_cutover([s1], [], CUT, stored, records=rec)
        assert kept == [s1] and not dropped and decided(decisions) == {"s1": ("unconfirmed", None, ("gone",))}, decision
        assert sf.new_review_count(decisions, rec) == 1
    # A claim of another account's Rocket Money row (not this account's history, its claimant not here) is left alone.
    other = {"x9": {"decision": "matched", "history_txn_keys": ["elsewhere"]}}
    assert sf.apply_cutover([s1], [], CUT, set(), records=other)[2] == []


def test_cutover_every_candidate_is_recorded_and_held():
    """Codex review: the record names every candidate of an ambiguous row, never a first few. Twelve identical
    purchases competing for eleven identical Rocket Money rows record all eleven, so when a later answer lacks them
    all eleven stay held: a new purchase of that amount is kept for review instead of being matched to an eleventh
    row a cut record would have left free."""
    hist = [hrow(f"h{i:02d}", "2026-11-11", 330, "DEMO DELI ATLANTA") for i in range(11)]
    twelve = [row(f"s{i:02d}", "2026-11-11", 330, desc="DEMO DELI ATLANTA") for i in range(12)]
    every = tuple(h["txn_key"] for h in hist)
    kept, dropped, first = sf.apply_cutover(twelve, hist, CUT, set())
    assert len(kept) == 12 and not dropped
    assert decided(first) == {r["txn_key"]: ("ambiguous", None, every) for r in twelve}
    saved = {r["sf_txn_key"]: r for r in sf.decision_rows(first, NOW)}
    assert all(r["history_txn_keys"] == list(every) for r in saved.values())
    assert set(sf.recorded_holds(saved).values()) == {every}
    new = row("n", "2026-11-12", 330, desc="DEMO DELI ATLANTA GA")
    kept, dropped, decisions = sf.apply_cutover([new], hist, CUT, {r["txn_key"] for r in twelve}, records=saved)
    assert kept == [new] and not dropped and decided(decisions) == {"n": ("ambiguous", None, every)}
    # A record that named only the first ten would leave the eleventh row free. Here the ten held rows are as near
    # to the new purchase as the eleventh, so they still block it (R4: a held contender counts for the nearest
    # date); an eleventh row a day nearer would be matched, and only the full record holds it.
    cut = {k: dict(r, history_txn_keys=r["history_txn_keys"][:10]) for k, r in saved.items()}
    assert sf.apply_cutover([new], hist, CUT, set(), records=cut)[0] == [new]
    nearer = hist[:10] + [dict(hist[10], txn_date="2026-11-12")]
    assert sf.apply_cutover([new], nearer, CUT, set(), records=cut)[0] == []
    assert decided(sf.apply_cutover([new], nearer, CUT, set(), records=saved)[2]) == {"n": ("ambiguous", None, every)}


def test_cutover_nearest_held_candidate_is_never_skipped():
    """Codex review (R4): the nearest date is judged over every contender, held rows included. A row whose nearest
    Rocket Money candidate is held (by a recorded ambiguity, or by an ambiguous group of this run) is never paired
    with a farther, otherwise eligible purchase instead: it is kept and recorded as ambiguous with both. The same
    from the Rocket Money side: a row whose nearest SimpleFIN row is ambiguous is not given to a farther one."""
    h1 = hrow("h1", "2026-11-09", 610, None, name="Demo Cafe")
    h2 = hrow("h2", "2026-11-11", 610, None, name="Demo Cafe")
    s = row("s", "2026-11-09", 610, desc="SQ *DEMO CAFE ATLANTA GA")
    assert sf.merchant_evidence(s, h2) and sf.date_gap(s, h2) == 2
    assert decided(sf.apply_cutover([s], [h2], CUT, set())[2]) == {"s": ("matched", "merchant", ("h2",))}, \
        "alone, the farther purchase would be its twin"
    assert decided(sf.apply_cutover([s], [h1, h2], CUT, set())[2]) == {"s": ("matched", "merchant", ("h1",))}
    # h1 held by a row recorded as ambiguous and missing from this answer: s is kept, never matched to h2.
    held = {"x1": {"decision": "ambiguous", "history_txn_keys": ["h1"]}}
    kept, dropped, decisions = sf.apply_cutover([s], [h1, h2], CUT, set(), records=held)
    assert kept == [s] and not dropped and decided(decisions) == {"s": ("ambiguous", None, ("h1", "h2"))}
    assert sf.new_review_count(decisions, held) == 1
    # Held by this run's exact step: two identical rows for one Rocket Money row (ambiguous), and a third row on the
    # same day whose text differs. Its nearest candidate k1 is held, so it does not take k2 two days later. The two
    # ambiguous rows record k2 too, so it stays held while they are missing from a later answer.
    k1 = hrow("k1", "2026-11-09", 820, "DEMO DELI ATLANTA")
    k2 = hrow("k2", "2026-11-11", 820, "DEMO DELI ATLANTA")
    d = row("d", "2026-11-09", 820, desc="DEMO DELI ATLANTA")
    e = row("e", "2026-11-09", 820, desc="DEMO DELI ATLANTA")
    f = row("f", "2026-11-09", 820, desc="DEMO DELI ATLANTA GA")
    assert sf.exact_key(f) != sf.exact_key(k1) and sf.merchant_evidence(f, k2)
    kept, dropped, decisions = sf.apply_cutover([d, e, f], [k1, k2], CUT, set())
    assert sorted(r["txn_key"] for r in kept) == ["d", "e", "f"] and not dropped
    assert decided(decisions) == {k: ("ambiguous", None, ("k1", "k2")) for k in ("d", "e", "f")}
    assert sf.apply_cutover([f, e, d], [k2, k1], CUT, set())[2] == decisions, "order-independent"
    # Rocket Money side: a is the only SimpleFIN row for two identical Rocket Money rows m1 and m1b (ambiguous) and is
    # a day from m2; b is two days from m2. m2's nearest SimpleFIN row is a, so b is not matched to it.
    m1 = hrow("m1", "2026-11-09", 930, "DEMO DELI ATLANTA")
    m1b = hrow("m1b", "2026-11-09", 930, "DEMO DELI ATLANTA")
    m2 = hrow("m2", "2026-11-10", 930, "DEMO DELI ATLANTA")
    a = row("a", "2026-11-09", 930, desc="DEMO DELI ATLANTA")
    b = row("b", "2026-11-12", 930, desc="DEMO DELI ATLANTA GA")
    assert decided(sf.apply_cutover([b], [m2], CUT, set())[2]) == {"b": ("matched", "merchant", ("m2",))}
    kept, dropped, decisions = sf.apply_cutover([a, b], [m1, m1b, m2], CUT, set())
    assert sorted(r["txn_key"] for r in kept) == ["a", "b"] and not dropped
    assert decided(decisions) == {k: ("ambiguous", None, ("m1", "m1b", "m2")) for k in ("a", "b")}


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


def test_cutover_ambiguous_rows_hold_their_twin_across_runs():
    """Codex review: rows competing for one Rocket Money row are recorded as ambiguous (also before the window,
    where they are dropped all the same), and that row stays held while they are missing from a later answer: a new
    purchase of the same amount at that merchant is kept and listed for review, never matched to it."""
    hist = [hrow("h1", "2026-11-07", 525, None, name="Demo Cafe")]
    s1 = row("s1", "2026-11-07", 525, desc="SQ *DEMO CAFE")   # two identical purchases before the window ...
    s2 = row("s2", "2026-11-07", 525, desc="SQ *DEMO CAFE")   # ... and one Rocket Money row: never guessed
    s3 = row("s3", "2026-11-09", 525, desc="SQ *DEMO CAFE")   # a new purchase two days later, in the window
    kept, dropped, first = sf.apply_cutover([s1, s2], hist, CUT, set())
    assert not kept and dropped == {"before the Rocket Money cutover": 2}
    assert decided(first) == {"s1": ("ambiguous", None, ("h1",)), "s2": ("ambiguous", None, ("h1",))}
    assert not any(d.kept for d in first) and sf.new_review_count(first, {}) == 0, "dropped rows are not for review"
    assert sf.cutover_counts(first) == {"ambiguous before the window": 2}
    saved = {r["sf_txn_key"]: r for r in sf.decision_rows(first, NOW)}
    assert sf.recorded_holds(saved) == {"s1": ("h1",), "s2": ("h1",)} and sf.recorded_claims(saved) == {}
    assert "kept" not in sf.decision_rows(first, NOW)[0], "the record has no such column"
    # The later answer has only s3: h1 is held, so s3 is kept and reported (until a written heartbeat carries it).
    kept, dropped, decisions = sf.apply_cutover([s3], hist, CUT, set(), records=saved)
    assert kept == [s3] and not dropped
    assert decided(decisions) == {"s3": ("ambiguous", None, ("h1",))} and sf.new_review_count(decisions, saved) == 1
    assert sf.apply_cutover([s3], hist, CUT, set())[0] == [], "without the record s3 would be matched to h1"
    # One of the two back in the answer, the other still missing: h1 stays held, nothing is guessed.
    kept, dropped, decisions = sf.apply_cutover([s3, s1], hist, CUT, set(), records=saved)
    assert kept == [s3]
    assert decided(decisions) == {"s1": ("ambiguous", None, ("h1",)), "s3": ("ambiguous", None, ("h1",))}
    # A claim recorded for the held row takes it: a taken row is not a candidate, so nothing is left to hold.
    taken = dict(saved, s9={"decision": "matched", "history_txn_keys": ["h1"]})
    kept, dropped, decisions = sf.apply_cutover([s3], hist, CUT, set(), records=taken)
    assert kept == [s3] and decided(decisions) == {}
    # The same in the window: two kept rows competing for one twin, then an answer without them.
    deli = [hrow("k1", "2026-11-11", 820, "DEMO DELI ATLANTA")]
    d = row("d", "2026-11-11", 820, desc="DEMO DELI ATLANTA")
    e = row("e", "2026-11-11", 820, desc="DEMO DELI ATLANTA")
    f = row("f", "2026-11-12", 820, desc="DEMO DELI ATLANTA GA")
    kept, dropped, first = sf.apply_cutover([d, e], deli, CUT, set())
    assert len(kept) == 2 and sf.new_review_count(first, {}) == 2
    saved = {r["sf_txn_key"]: r for r in sf.decision_rows(first, NOW)}
    kept, dropped, decisions = sf.apply_cutover([f], deli, CUT, {"d", "e"}, records=saved)
    assert kept == [f] and decided(decisions) == {"f": ("ambiguous", None, ("k1",))}
    assert sf.apply_cutover([f], deli, CUT, {"d", "e"})[0] == []


def test_cutover_claim_that_no_longer_holds_is_replaced():
    """Codex review: a matched row whose amount changed no longer holds its Rocket Money row. It is kept and recorded
    as 'unconfirmed' (listed for review) in place of the claim, so when a later answer lacks it the Rocket Money row
    is free for its real twin instead of being held by a stale claim. The same for an ambiguity this run no longer
    makes: replaced, never left as a hold."""
    hist = [hrow("h1", "2026-11-10", 800, "DEMO BAKERY ATLANTA", name="Demo Bakery")]
    s1 = row("s1", "2026-11-11", 800, desc="DEMO BAKERY 0042 ATLANTA GA")
    kept, dropped, first = sf.apply_cutover([s1], hist, CUT, set())
    assert not kept and decided(first) == {"s1": ("matched", "merchant", ("h1",))}
    saved = {r["sf_txn_key"]: r for r in sf.decision_rows(first, NOW)}
    corrected = dict(s1, amount_cents=850)   # SimpleFIN corrected the amount
    kept, dropped, second = sf.apply_cutover([corrected], hist, CUT, set(), records=saved)
    assert kept == [corrected] and not dropped
    assert decided(second) == {"s1": ("unconfirmed", None, ("h1",))} and sf.new_review_count(second, saved) == 1
    saved.update({r["sf_txn_key"]: r for r in sf.decision_rows(second, NOW)})
    assert sf.recorded_claims(saved) == {} and sf.recorded_holds(saved) == {}
    # The later answer lacks s1 and has h1's real twin: matched to it.
    twin = row("s2", "2026-11-10", 800, desc="DEMO BAKERY 0042 ATLANTA GA")
    kept, dropped, third = sf.apply_cutover([twin], hist, CUT, set(), records=saved)
    assert not kept and decided(third) == {"s2": ("matched", "merchant", ("h1",))}
    stale = {"s1": {"decision": "matched", "history_txn_keys": ["h1"]}}
    assert sf.apply_cutover([twin], hist, CUT, set(), records=stale)[0] == [twin], "a stale claim keeps a duplicate"
    # A stored claimant (stored_duplicate) that changed is replaced the same way, and stays in the ledger.
    dup = {"s1": {"decision": "stored_duplicate", "history_txn_keys": ["h1"]}}
    kept, dropped, decisions = sf.apply_cutover([corrected], hist, CUT, {"s1"}, records=dup)
    assert kept == [corrected] and decided(decisions) == {"s1": ("unconfirmed", None, ("h1",))}
    # Still evidenced: the claim is kept as it was (not replaced).
    assert decided(sf.apply_cutover([s1], hist, CUT, set(), records=stale)[2]) == {"s1": ("matched", "merchant", ("h1",))}
    # A row recorded as ambiguous that is here again but has no candidate left (it changed): replaced, not kept as a
    # hold the run no longer makes.
    amb = {"s1": {"decision": "ambiguous", "history_txn_keys": ["h1"]}}
    kept, dropped, decisions = sf.apply_cutover([corrected], hist, CUT, set(), records=amb)
    assert kept == [corrected] and decided(decisions) == {"s1": ("unconfirmed", None, ("h1",))}
    # Before the window the replacement is recorded too (the row is dropped all the same, not for review).
    early = row("s4", "2026-11-06", 850, desc="DEMO BAKERY 0042 ATLANTA GA")
    kept, dropped, decisions = sf.apply_cutover([early], hist, CUT, set(), records={"s4": stale["s1"]})
    assert not kept and decided(decisions) == {"s4": ("unconfirmed", None, ("h1",))}
    assert sf.new_review_count(decisions, {}) == 0 and sf.cutover_counts(decisions) == {"unconfirmed before the window": 1}


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
        self.beat_ok = True      # what heartbeat() answers: False = the sync_log write was lost; a set = only the
                                 # heartbeats of these data types are written (one write lost, the other landed)
        self.marked = []         # keys passed to mark_reported, per call

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

    def ledger_keys(self, keys):
        return set(keys) & {t["txn_key"] for t in self.window_rows(None)}

    def history_rows(self, keys):
        return [dict(r) for r in self._window if r["txn_key"] in set(keys) and r.get("source") != "simplefin"]

    def save_cutover_decisions(self, rows):
        assert len({tuple(sorted(r)) for r in rows}) <= 1, "one upsert carries one key set"
        self.saved_rows.extend(rows)
        self.saved.update({r["sf_txn_key"]: {"decision": r["decision"], "history_txn_keys": list(r["history_txn_keys"]),
                                             "review_state": r["review_state"]}
                           for r in rows})

    def mark_reported(self, keys):
        self.marked.append(sorted(keys))
        for k in keys:
            if k in self.saved and self.saved[k].get("review_state") == "pending":
                self.saved[k] = dict(self.saved[k], review_state="reported")

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
        return self.beat_ok if isinstance(self.beat_ok, bool) else data_type in self.beat_ok


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


def wf_answer(*txns):
    """body() with these transactions on the Wells Fargo checking account."""
    b = body()
    next(a for a in b["accounts"] if a["id"] == "S-WF")["transactions"] = list(txns)
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
    assert "kept for review {'unconfirmed': 1}" in preview and "to report: 1" in preview
    assert "PHARMACY" not in preview and "GROCER" not in preview


def test_run_cutover_record_is_saved_before_the_ledger():
    """Codex review (R2): a row is left out of the ledger only on a match already on record. The decisions are saved
    BEFORE the ledger; a run that cannot save them (the table missing, or a failed write) writes nothing and fails,
    so a later answer without the claimant can never let another purchase take the same Rocket Money row on a
    match that was not recorded. The retry records the claim first, and the claim then holds."""
    for missing in ("PGRST205", "42P01"):   # PostgREST / Postgres: the table is not applied yet
        class NoTable(FakeStore):
            def cutover_decisions(self):
                raise FakeApiError(missing, "relation pds.finance_cutover_matches does not exist")

        store = cutover_store(NoTable)
        lines = []
        assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lines.append) == 1
        assert not (store.txns or store.balances or store.created or store.links or store.saved_rows), "nothing written"
        assert [b[:2] for b in store.beats] == [("transactions", "failed"), ("balances", "failed")]
        assert store.beats[0][3] == store.beats[1][3] == sf.format_notes({"cutover_provenance_unsaved": 1})
        assert "does not exist" not in "\n".join(lines)
        # The dry run says a real run would stop (counts only) and writes nothing.
        dry, preview = cutover_store(NoTable), []
        assert sf.run(dry, Http(get=Res(200, cutover_body())), ACCESS, 60, True, now=NOW, out=preview.append) == 0
        assert any("a real run would stop before writing" in line for line in preview) and not (dry.beats or dry.txns)
    # With the table missing and nothing to decide (no Rocket Money row near), the run is not stopped.
    quiet = FakeStore(ledger_with_fidelity(), kinds={"wf1": "asset"}, cutovers={"wf1": CUT})
    quiet.cutover_decisions = lambda: (_ for _ in ()).throw(FakeApiError("PGRST205"))
    assert sf.run(quiet, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert quiet.beats[0][1] == "success" and quiet.saved_rows == []

    # A failed save after a good read: nothing written, the record keeps what it had.
    class SaveFails(FakeStore):
        failing = True

        def save_cutover_decisions(self, rows):
            if self.failing:
                raise FakeApiError("57014", pii_msg())
            super().save_cutover_decisions(rows)

    store = cutover_store(SaveFails)
    lines = []
    assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lines.append) == 1
    assert not (store.txns or store.balances or store.saved_rows) and store.saved == {}
    assert store.beats[0][3] == sf.format_notes({"db_write_failed": 1})
    assert_no_pii("\n".join(lines) + store.beats[0][3])
    # Retry: the record is saved, then the ledger; the matched row stays out and the kept one is reported (once its
    # heartbeat is written it is marked reported).
    store.failing = False
    assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert {r["sf_txn_key"]: r["decision"] for r in store.saved_rows} == {
        sf.txn_key("S-WF", "w1"): "unconfirmed", sf.txn_key("S-WF", "w2"): "matched"}
    written = {t["source_txn_id"] for t in store.txns}
    assert "sf:S-WF:w1" in written and "sf:S-WF:w2" not in written
    assert store.beats[-1][3] == sf.format_notes({"cutover_review": 1})
    # A later answer without the claimant w2 and with a new purchase of the same amount at that merchant: the taken
    # Rocket Money row stays taken, so the new purchase is written.
    later = cutover_body()
    next(a for a in later["accounts"] if a["id"] == "S-WF")["transactions"] = [
        txn("w1", "2026-11-11", "-15.00", "OTHER PHARMACY 0202 ATLANTA"), txn("w3", "2026-11-11", "-7.00", "DEMO DELI ATLANTA GA")]
    assert sf.run(store, Http(get=Res(200, later)), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert "sf:S-WF:w3" in {t["source_txn_id"] for t in store.txns}
    assert store.beats[-1][1] == "success"

    # The record saved but the ledger write failing: the failed heartbeat reports the rows kept for review (they
    # are recorded now, so a later run does not report them again); the next run writes the ledger.
    class LedgerFails(FakeStore):
        failing = True

        def upsert_transactions(self, rows):
            if self.failing:
                raise RuntimeError(pii_msg())
            super().upsert_transactions(rows)

    lf = cutover_store(LedgerFails)
    assert sf.run(lf, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 1
    assert lf.beats[0][1] == "failed" and lf.beats[0][3] == sf.format_notes({"db_write_failed": 1, "cutover_review": 1})
    assert sorted(r["decision"] for r in lf.saved_rows) == ["matched", "unconfirmed"] and not lf.txns
    assert_no_pii(lf.beats[0][3])
    lf.failing = False
    assert sf.run(lf, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert [(b[1], b[3]) for b in lf.beats[2:]] == [("success", None), ("success", None)]
    assert {t["source_txn_id"] for t in lf.txns} == {"sf:S-WF:w1", "sf:S-AMEX:1"}


def test_run_partly_saved_record_reports_review():
    """Codex review: a failed save of the record may have written it all the same (the write went through and its
    answer was lost; the save is one statement, so it is all of the set or none of it: R5). The rows kept for review
    that are pending on record are reported on that failed heartbeat and marked reported once it is written, so the
    retry does not report them again; nothing is written to the ledger. When the record cannot be read back, every
    such row is reported there (the retry may report it again, but it is never left unreported)."""
    class PartSave(FakeStore):
        mode = "all"              # what the failing save writes before it raises; "ok" = a normal save
        readback_fails = False

        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self.reads = 0

        def cutover_decisions(self):
            self.reads += 1
            if self.readback_fails and self.reads > 1:
                raise FakeApiError("57014", pii_msg())
            return super().cutover_decisions()

        def save_cutover_decisions(self, rows):
            if self.mode == "ok":
                return super().save_cutover_decisions(rows)
            if self.mode == "all":             # written, but the answer was lost
                super().save_cutover_decisions(rows)
            raise FakeApiError("57014", pii_msg())

    w1, w2 = sf.txn_key("S-WF", "w1"), sf.txn_key("S-WF", "w2")
    store = cutover_store(PartSave)
    store.mode = "all"
    lines = []
    assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lines.append) == 1
    assert [b[:2] for b in store.beats] == [("transactions", "failed"), ("balances", "failed")]
    note = sf.format_notes({"db_write_failed": 1, "cutover_review": 1})
    assert store.beats[0][3] == store.beats[1][3] == note
    assert not (store.txns or store.balances or store.created or store.links), "nothing written to the ledger"
    assert store.saved[w1]["decision"] == "unconfirmed"
    assert_no_pii("\n".join(lines) + store.beats[0][3])
    # The retry records the set again and writes the ledger; the review row is not reported a second time.
    store.mode = "ok"
    assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert [(b[1], b[3]) for b in store.beats[2:]] == [("success", None), ("success", None)]
    assert store.saved[w2]["decision"] == "matched"
    written = {t["source_txn_id"] for t in store.txns}
    assert "sf:S-WF:w1" in written and "sf:S-WF:w2" not in written
    # Nothing written and the record unreadable after the failure: reported on the failed heartbeat all the same,
    # and again by the retry that records it.
    store = cutover_store(PartSave)
    store.mode, store.readback_fails = "none", True
    assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 1
    assert store.beats[0][3] == sf.format_notes({"db_write_failed": 1, "cutover_review": 1}) and store.saved == {}
    store.mode, store.readback_fails = "ok", False
    assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert store.beats[-1][3] == sf.format_notes({"cutover_review": 1})
    # Nothing written and the record readable: nothing is on record, so only the retry reports it (as before).
    store = cutover_store(PartSave)
    store.mode = "none"
    assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 1
    assert store.beats[0][3] == sf.format_notes({"db_write_failed": 1})


class OneStatementDb:
    """A fake Supabase client for Store.save_cutover_decisions. Like PostgREST, each request is one statement in one
    transaction: it lands whole or not at all. `fail` names the requests that fail, by number from 0."""

    def __init__(self, fail=()):
        self.fail, self.requests, self.rows = set(fail), [], {}

    def schema(self, name):
        assert name == "pds"
        return self

    def from_(self, table):
        self._table = table
        return self

    def upsert(self, rows, on_conflict=None):
        self._pending = (self._table, [dict(r) for r in rows], on_conflict)
        return self

    def execute(self):
        table, rows, on_conflict = self._pending
        n = len(self.requests)
        self.requests.append((table, len(rows), on_conflict))
        if n in self.fail:
            raise FakeApiError("57014", pii_msg())   # rolled back: none of its rows land
        assert len({r["sf_txn_key"] for r in rows}) == len(rows), "one statement cannot upsert a key twice"
        self.rows.update({r["sf_txn_key"]: r for r in rows})


def test_cutover_record_is_saved_in_one_statement():
    """Codex review (R5): the run's whole decision set goes in ONE upsert request, so it is on record completely or
    not at all. Saved in requests of CHUNK rows, a request after the first failing left part of the set on record."""
    decisions = [sf.CutoverDecision(f"s{i:04d}", "wf1", "ambiguous", None, ("h1",), "2026-11-11")
                 for i in range(2 * sf.CHUNK + 7)]
    rows = sf.decision_rows(decisions, NOW)
    db = OneStatementDb(fail=range(1, 10))   # a second request would fail, as a second chunk did
    sf.Store(db).save_cutover_decisions(rows)
    assert db.requests == [("finance_cutover_matches", len(rows), "sf_txn_key")] and len(db.rows) == len(rows)
    db = OneStatementDb(fail={0})            # the one request fails: nothing is on record
    try:
        sf.Store(db).save_cutover_decisions(rows)
    except FakeApiError:
        pass
    else:
        raise AssertionError("a failed save must raise")
    assert db.rows == {} and len(db.requests) == 1
    db = OneStatementDb()
    sf.Store(db).save_cutover_decisions([])
    assert db.requests == [], "nothing to record: no request"
    # A key twice (a run never decides one row twice, but one statement could not upsert it): one row, the last.
    db = OneStatementDb()
    sf.Store(db).save_cutover_decisions(rows[:2] + [dict(rows[0], decision="unconfirmed")])
    assert db.requests[0][1] == 2 and db.rows[rows[0]["sf_txn_key"]]["decision"] == "unconfirmed"


def test_run_failed_record_save_never_leaves_part_of_the_set():
    """Codex review (R5), end to end with the real Store save: two identical purchases compete for one Rocket Money
    row (ambiguous) among more than CHUNK other decisions, the case where saving in chunks could put one contender
    on record and lose the other. On a database where every request after the first fails (as a second chunk did),
    the whole set is on record, so a later answer without one contender keeps the other ambiguous and in the ledger.
    When the one request fails, nothing is on record and nothing is written: the failed run leaves no trace, so the
    next answer (one without a contender) is decided exactly as on a store that never saw that run. A record that
    holds one contender and not the other can no longer exist."""
    n = sf.CHUNK + 20
    window = [hrow("rm-x", "2026-11-09", 820, "DEMO DELI ATLANTA")] + [
        hrow(f"rm-f{i:04d}", "2026-11-01", 100 + i, f"DEMO SHOP {i:04d}") for i in range(n)]
    fillers = [txn(f"f{i:04d}", "2026-11-01", f"-{(100 + i) / 100:.2f}", f"DEMO SHOP {i:04d}") for i in range(n)]

    def answer(*contenders):
        return wf_answer(*[txn(k, "2026-11-09", "-8.20", "DEMO DELI ATLANTA") for k in contenders], *fillers)

    class RealSave(FakeStore):
        def __init__(self, db):
            super().__init__(ledger_with_fidelity(), kinds={"wf1": "asset"}, cutovers={"wf1": CUT}, window=window)
            self.db = db

        def cutover_decisions(self):
            return {k: {"decision": r["decision"], "history_txn_keys": list(r["history_txn_keys"]),
                        "review_state": r["review_state"]}
                    for k, r in self.db.rows.items()}

        def save_cutover_decisions(self, rows):
            sf.Store(self.db).save_cutover_decisions(rows)

        def mark_reported(self, keys):
            for k in keys:
                if self.db.rows.get(k, {}).get("review_state") == "pending":
                    self.db.rows[k]["review_state"] = "reported"

    quiet = lambda *_: None  # noqa: E731
    x1, x2 = sf.txn_key("S-WF", "x1"), sf.txn_key("S-WF", "x2")
    # Every request after the first fails: the set is one request, so it is all on record.
    store = RealSave(OneStatementDb(fail=range(1, 10)))
    assert sf.run(store, Http(get=Res(200, answer("x1", "x2"))), ACCESS, 60, False, now=NOW, out=quiet) == 0
    assert [r[1] for r in store.db.requests] == [n + 2]
    rec = store.cutover_decisions()
    assert rec[x1] == rec[x2] == {"decision": "ambiguous", "history_txn_keys": ["rm-x"], "review_state": "reported"}
    assert sum(1 for r in rec.values() if r["decision"] == "matched") == n
    assert {sf.txn_key("S-WF", "x1"), sf.txn_key("S-WF", "x2")} <= {t["txn_key"] for t in store.txns}
    # The next answer lacks x2: rm-x stays held, so x1 stays ambiguous (never matched to it) and in the ledger.
    store.db.fail = set()
    assert sf.run(store, Http(get=Res(200, answer("x1"))), ACCESS, 60, False, now=NOW, out=quiet) == 0
    assert store.cutover_decisions()[x1] == {"decision": "ambiguous", "history_txn_keys": ["rm-x"],
                                             "review_state": "reported"}
    # The one request fails: nothing on record, nothing written, the run fails.
    store = RealSave(OneStatementDb(fail={0}))
    assert sf.run(store, Http(get=Res(200, answer("x1", "x2"))), ACCESS, 60, False, now=NOW, out=quiet) == 1
    assert store.db.rows == {} and not (store.txns or store.balances or store.created or store.links)
    # Nothing is on record, so the review rows are reported by the run that records them (pending), not here.
    assert store.beats[0][1] == "failed" and store.beats[0][3] == sf.format_notes({"db_write_failed": 1})
    # The answer after it lacks x2 and is decided exactly as on a store that never saw the failed run.
    store.db.fail = set()
    fresh = RealSave(OneStatementDb())
    for s in (store, fresh):
        assert sf.run(s, Http(get=Res(200, answer("x1"))), ACCESS, 60, False, now=NOW, out=quiet) == 0
    assert store.cutover_decisions() == fresh.cutover_decisions()
    assert sorted(t["txn_key"] for t in store.txns) == sorted(t["txn_key"] for t in fresh.txns)
    # With the full answer instead, the retry records both contenders in one statement, and they hold as above.
    store = RealSave(OneStatementDb(fail={0}))
    assert sf.run(store, Http(get=Res(200, answer("x1", "x2"))), ACCESS, 60, False, now=NOW, out=quiet) == 1
    store.db.fail = set()
    assert sf.run(store, Http(get=Res(200, answer("x1", "x2"))), ACCESS, 60, False, now=NOW, out=quiet) == 0
    assert sf.run(store, Http(get=Res(200, answer("x1"))), ACCESS, 60, False, now=NOW, out=quiet) == 0
    assert store.cutover_decisions()[x1]["decision"] == "ambiguous"
    assert sf.txn_key("S-WF", "x1") in {t["txn_key"] for t in store.txns}


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


def test_run_ambiguous_rows_hold_their_twin_across_responses():
    """Codex review, end to end (two-response replay): run 1 has two identical purchases before the window competing
    for one Rocket Money row (dropped, recorded as ambiguous, not reported, not listed by the dry run); run 2's
    answer has only a new purchase two days later, which is written and reported for review instead of being
    matched to the held row."""
    window = [hrow("rm-7", "2026-11-07", 525, None, name="Demo Cafe")]
    store = FakeStore(ledger_with_fidelity(), kinds={"wf1": "asset"}, cutovers={"wf1": CUT}, window=window)
    first = wf_answer(txn("x1", "2026-11-07", "-5.25", "SQ *DEMO CAFE"), txn("x2", "2026-11-07", "-5.25", "SQ *DEMO CAFE"))
    assert sf.run(store, Http(get=Res(200, first)), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert {store.saved[sf.txn_key("S-WF", k)]["decision"] for k in ("x1", "x2")} == {"ambiguous"}
    assert not any(t["source_txn_id"].startswith("sf:S-WF:x") for t in store.txns)
    assert store.beats[-2][:2] == ("transactions", "success"), "dropped before the window: nothing for review"
    dry = []
    assert sf.run(store, Http(get=Res(200, first)), ACCESS, 60, True, now=NOW, out=dry.append) == 0
    assert not any("recorded for review" in line for line in dry), "not in the ledger: not listed for review"
    assert any("ambiguous before the window" in line for line in dry)
    second = wf_answer(txn("x3", "2026-11-09", "-5.25", "SQ *DEMO CAFE"))
    assert sf.run(store, Http(get=Res(200, second)), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert any(t["source_txn_id"] == "sf:S-WF:x3" for t in store.txns), "the new purchase is written"
    assert store.saved[sf.txn_key("S-WF", "x3")] == {"decision": "ambiguous", "history_txn_keys": ["rm-7"],
                                                     "review_state": "reported"}
    assert store.beats[-2][3] == sf.format_notes({"cutover_review": 1})


def test_run_replaced_claim_is_saved_before_the_ledger():
    """Codex review, end to end: run 1 matches a row; in run 2 SimpleFIN has corrected its amount, so the row is
    written and its claim replaced by an 'unconfirmed' decision, recorded BEFORE the ledger write; run 3's answer
    lacks it (incomplete) and has the Rocket Money row's real twin, which is matched and not written. A failed save
    of the replacement writes nothing."""
    class Ordered(FakeStore):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self.events = []

        def save_cutover_decisions(self, rows):
            self.events.append("record")
            super().save_cutover_decisions(rows)

        def upsert_transactions(self, rows):
            self.events.append("ledger")
            super().upsert_transactions(rows)

    window = [hrow("rm-6", "2026-11-10", 800, "DEMO BAKERY ATLANTA", name="Demo Bakery")]
    store = Ordered(ledger_with_fidelity(), kinds={"wf1": "asset"}, cutovers={"wf1": CUT}, window=window)
    b1, b2 = sf.txn_key("S-WF", "b1"), sf.txn_key("S-WF", "b2")
    run1 = wf_answer(txn("b1", "2026-11-11", "-8.00", "DEMO BAKERY 0042 ATLANTA GA"))
    assert sf.run(store, Http(get=Res(200, run1)), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert store.saved[b1]["decision"] == "matched" and not any(t["txn_key"] == b1 for t in store.txns)
    store.events.clear()
    run2 = wf_answer(txn("b1", "2026-11-11", "-8.50", "DEMO BAKERY 0042 ATLANTA GA"))
    assert sf.run(store, Http(get=Res(200, run2)), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert store.saved[b1] == {"decision": "unconfirmed", "history_txn_keys": ["rm-6"], "review_state": "reported"}
    assert any(t["txn_key"] == b1 for t in store.txns), "no longer evidenced: written"
    assert store.events == ["record", "ledger"], "the replaced claim is on record before the ledger is written"
    assert store.beats[-2][3] == sf.format_notes({"cutover_review": 1})
    run3 = wf_answer(txn("b2", "2026-11-10", "-8.00", "DEMO BAKERY 0042 ATLANTA GA"))
    assert sf.run(store, Http(get=Res(200, run3)), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 0
    assert store.saved[b2] == {"decision": "matched", "history_txn_keys": ["rm-6"], "review_state": None}
    assert not any(t["txn_key"] == b2 for t in store.txns), "the real twin is not written twice"

    class SaveFails(Ordered):
        def save_cutover_decisions(self, rows):
            raise FakeApiError("57014", pii_msg())

    failing = SaveFails(ledger_with_fidelity(), kinds={"wf1": "asset"}, cutovers={"wf1": CUT}, window=window)
    failing.saved = {b1: {"decision": "matched", "history_txn_keys": ["rm-6"]}}
    assert sf.run(failing, Http(get=Res(200, run2)), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 1
    assert not failing.txns and failing.saved[b1]["decision"] == "matched" and failing.events == []
    assert failing.beats[0][3] == sf.format_notes({"db_write_failed": 1})


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


class DatedStore(FakeStore):
    """window_rows honours `since` like the real read (txn_date >= since). `floor` narrows it further, standing in
    for a window that misses a row whatever was asked; `by_key` records the history_rows calls."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.floor, self.since, self.by_key = None, [], []

    def window_rows(self, since):
        rows = super().window_rows(since)
        if since is None:
            return rows
        self.since.append(since)
        lo = max(since, self.floor) if self.floor else since
        return [r for r in rows if r["txn_date"] >= lo.isoformat()]

    def history_rows(self, keys):
        self.by_key.append(sorted(keys))
        return super().history_rows(keys)


def test_run_recorded_twin_outside_the_date_window():
    """Codex review (round 7): a row posted late, transacted long before the window, whose Rocket Money twin is dated
    alike. (1) The ledger is read from before EVERY date in SimpleFIN's answer, so the first run matches it. (2) A
    later run whose date read misses the twin reads it by key (the record names it), so the match is replayed and
    the row is not written again. (3) With the twin gone from the ledger, the row is written and reported for
    review, never written unremarked. (4) A failed read of the named rows stops the run before anything is written."""
    window = [hrow("rm-t", "2026-08-14", 6400, "DEMO TAILOR ATLANTA")]
    store = DatedStore(ledger_with_fidelity(), kinds={"wf1": "asset"}, cutovers={"wf1": CUT}, window=window)
    late = sf.txn_key("S-WF", "t1")
    answer = wf_answer(txn("t1", "2026-08-14", "-64.00", "DEMO TAILOR ATLANTA", posted=ts("2026-11-12", 12)))
    quiet = lambda *_: None  # noqa: E731
    assert sf.run(store, Http(get=Res(200, answer)), ACCESS, 45, False, now=NOW, out=quiet) == 0
    assert store.since == [date(2026, 8, 3)], "read from the earliest date in the answer, less the margins"
    assert store.saved[late]["decision"] == "matched" and not any(t["txn_key"] == late for t in store.txns)
    assert store.by_key == [] and store.beats[-2][1] == "success"
    # (2) The date read misses the twin: it is read by key and the recorded match holds.
    store.floor = date(2026, 11, 1)
    assert sf.run(store, Http(get=Res(200, answer)), ACCESS, 45, False, now=NOW, out=quiet) == 0
    assert store.by_key == [["rm-t"]]
    assert store.saved[late]["decision"] == "matched" and not any(t["txn_key"] == late for t in store.txns)
    assert store.beats[-2][:2] == ("transactions", "success")
    # (3) The twin is gone from the ledger: the row is written and reported for review.
    store._window = []
    assert sf.run(store, Http(get=Res(200, answer)), ACCESS, 45, False, now=NOW, out=quiet) == 0
    assert store.saved[late]["decision"] == "unconfirmed" and any(t["txn_key"] == late for t in store.txns)
    assert store.beats[-2][3] == sf.format_notes({"cutover_review": 1})

    # (4) A failed read of the named rows: nothing written, the run fails like a failed read of the record.
    class ByKeyFails(DatedStore):
        def history_rows(self, keys):
            raise FakeApiError("57014", pii_msg())

    failing = ByKeyFails(ledger_with_fidelity(), kinds={"wf1": "asset"}, cutovers={"wf1": CUT}, window=window)
    failing.floor = date(2026, 11, 1)
    failing.saved = {late: {"decision": "matched", "history_txn_keys": ["rm-t"], "review_state": None}}
    lines = []
    assert sf.run(failing, Http(get=Res(200, answer)), ACCESS, 45, False, now=NOW, out=lines.append) == 1
    assert not (failing.txns or failing.balances or failing.saved_rows or failing.created or failing.links)
    assert [b[3] for b in failing.beats] == [sf.format_notes({"db_read_failed": 1})] * 2
    assert_no_pii("\n".join(lines))


def test_run_review_is_reported_until_a_heartbeat_carries_it():
    """Codex review (round 7): reporting is tracked apart from the decision (review_state). A row kept for review is
    'pending' on record until both heartbeats carrying it are WRITTEN, then 'reported'. When the heartbeat writes are
    lost, the run stops after it saved the record, or the mark fails, the next run reports it again, also when the
    row is no longer in SimpleFIN's answer; once both written heartbeats carried it, it is not reported again."""
    w1 = sf.txn_key("S-WF", "w1")
    review = sf.format_notes({"cutover_review": 1})
    quiet = lambda *_: None  # noqa: E731
    # Both heartbeat writes lost: the row stays pending; the next run reports it and marks it; then nothing more.
    store, lines = cutover_store(), []
    store.beat_ok = False
    assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lines.append) == 0
    assert store.beats[0][3] == review and store.saved[w1]["review_state"] == "pending" and store.marked == []
    assert any("stay pending for the next run" in line for line in lines)
    store.beat_ok = True
    assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lines.append) == 0
    assert [b[3] for b in store.beats[-2:]] == [review] * 2
    assert store.marked == [[w1]] and store.saved[w1]["review_state"] == "reported"
    assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lines.append) == 0
    assert [(b[1], b[3]) for b in store.beats[-2:]] == [("success", None), ("success", None)]
    out = "\n".join(lines)
    assert w1 not in out and "rm-1" not in out, "counts only"

    # The process stops after the record was saved, before any heartbeat: the next run reports the row.
    class Stops(FakeStore):
        stopping = True

        def upsert_transactions(self, rows):
            if self.stopping:
                raise SystemExit(1)
            super().upsert_transactions(rows)

    st = cutover_store(Stops)
    try:
        sf.run(st, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=quiet)
    except SystemExit:
        pass
    else:
        raise AssertionError("the stand-in for a stopped process must stop the run")
    assert st.beats == [] and st.saved[w1]["review_state"] == "pending"
    st.stopping = False
    assert sf.run(st, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=quiet) == 0
    assert st.beats[-2][3] == review and st.saved[w1]["review_state"] == "reported"

    # A pending row is reported also when it is no longer in SimpleFIN's answer (no cutover decision this run).
    gone = cutover_store()
    gone.beat_ok = False
    assert sf.run(gone, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=quiet) == 0
    gone.beat_ok = True
    assert sf.run(gone, Http(get=Res(200, wf_answer())), ACCESS, 60, False, now=NOW, out=quiet) == 0
    assert gone.beats[-2][3] == review and gone.marked == [[w1]]
    # The dry run counts it among the rows to report, and writes nothing.
    dry = cutover_store()
    dry.saved = {w1: {"decision": "unconfirmed", "history_txn_keys": ["rm-1"], "review_state": "pending"}}
    preview = []
    assert sf.run(dry, Http(get=Res(200, wf_answer())), ACCESS, 60, True, now=NOW, out=preview.append) == 0
    assert any("cutover review to report" in line and line.endswith(": 1") for line in preview), preview
    assert not (dry.beats or dry.marked or dry.saved_rows)

    # The mark fails: the row stays pending and the next run reports it again (twice at worst, never not at all).
    class MarkFails(FakeStore):
        def mark_reported(self, keys):
            raise FakeApiError("57014", pii_msg())

    mf, lines = cutover_store(MarkFails), []
    for _ in range(2):
        assert sf.run(mf, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lines.append) == 0
        assert mf.beats[-2][3] == review and mf.saved[w1]["review_state"] == "pending"
    assert any("could not be marked reported (FakeApiError)" in line for line in lines)
    assert_no_pii("\n".join(lines))

    # A failed run reports the pending rows on its red heartbeat and marks them once that heartbeat is written.
    class LedgerFails(FakeStore):
        def upsert_transactions(self, rows):
            raise RuntimeError(pii_msg())

    lf = cutover_store(LedgerFails)
    lf.beat_ok = False
    assert sf.run(lf, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=quiet) == 1
    assert lf.beats[0][3] == sf.format_notes({"db_write_failed": 1, "cutover_review": 1}) and lf.marked == []
    lf.beat_ok = True
    assert sf.run(lf, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=quiet) == 1
    assert lf.beats[-1][3] == sf.format_notes({"db_write_failed": 1, "cutover_review": 1}) and lf.marked == [[w1]]


def test_run_review_stays_pending_when_one_heartbeat_is_lost():
    """Codex review (round 8): the SimpleFIN card shows the worse of the two newest heartbeats with that one's text,
    so when only one of a run's two heartbeats lands, the other kind's older heartbeat can be the one shown (an older
    failed transactions heartbeat outranks this run's partial balances one) and the review note is hidden. A row kept
    for review is therefore marked reported only when BOTH heartbeats were written; with either lost it stays
    pending and the next run reports it again, on the successful path and on a failed run alike."""
    w1 = sf.txn_key("S-WF", "w1")
    review = sf.format_notes({"cutover_review": 1})
    for landed in ({"balances"}, {"transactions"}):
        store, lines = cutover_store(), []
        store.beat_ok = set(landed)
        assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lines.append) == 0
        assert [b[3] for b in store.beats] == [review] * 2, "both heartbeats carry the review"
        assert store.saved[w1]["review_state"] == "pending" and store.marked == [], landed
        assert any("a heartbeat was not written" in line and "stay pending for the next run" in line for line in lines)
        # The next run writes both: it reports the row again and only then marks it.
        store.beat_ok = True
        assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lines.append) == 0
        assert [b[3] for b in store.beats[-2:]] == [review] * 2
        assert store.marked == [[w1]] and store.saved[w1]["review_state"] == "reported"
        out = "\n".join(lines)
        assert w1 not in out and "rm-1" not in out, "counts only"

    # A failed run (the ledger write fails) with one of its red heartbeats lost: still pending, reported again.
    class LedgerFails(FakeStore):
        def upsert_transactions(self, rows):
            raise RuntimeError(pii_msg())

    red = sf.format_notes({"db_write_failed": 1, "cutover_review": 1})
    for landed in ({"balances"}, {"transactions"}):
        lf = cutover_store(LedgerFails)
        lf.beat_ok = set(landed)
        assert sf.run(lf, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 1
        assert [b[3] for b in lf.beats] == [red] * 2 and lf.marked == []
        assert lf.saved[w1]["review_state"] == "pending", landed
        lf.beat_ok = True
        assert sf.run(lf, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lambda *_: None) == 1
        assert lf.beats[-1][3] == red and lf.marked == [[w1]] and lf.saved[w1]["review_state"] == "reported"


def test_run_record_without_review_state_fails_before_writing():
    """The table without its review_state column (that statement of sql/finance_cutover_matches.sql not applied):
    the run fails before anything is written, with the code that says to apply the file; the error text is never
    shown."""
    for code in ("42703", "PGRST204"):
        store = cutover_store()
        store.read_error = FakeApiError(code, "column finance_cutover_matches.review_state does not exist")
        lines = []
        assert sf.run(store, Http(get=Res(200, cutover_body())), ACCESS, 60, False, now=NOW, out=lines.append) == 1
        assert not (store.txns or store.balances or store.saved_rows or store.created or store.links)
        assert [b[3] for b in store.beats] == [sf.format_notes({"cutover_provenance_unsaved": 1})] * 2
        assert "does not exist" not in "\n".join(lines)


class ChainDb:
    """A fake Supabase client that records each request's calls ([('from', table), (method, args), ...])."""

    def __init__(self, answer=()):
        self.calls, self.answer, self.cur = [], list(answer), None

    def schema(self, name):
        assert name == "pds"
        return self

    def from_(self, table):
        self.cur = [("from", table)]
        return self

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        def call(*args, **kw):
            self.cur.append((name, args))
            return self
        return call

    def execute(self):
        self.calls.append(self.cur)
        return type("Answer", (), {"data": list(self.answer)})()


def test_store_marks_reported_and_reads_named_rows_by_key():
    """Store.mark_reported moves only 'pending' rows to 'reported', in batches; Store.history_rows reads Rocket Money
    rows by key (never SimpleFIN rows), whatever their date."""
    keys = [f"k{i:03d}" for i in range(150)]
    db = ChainDb()
    sf.Store(db).mark_reported(keys + ["k000"])
    assert db.calls == [[("from", "finance_cutover_matches"), ("update", ({"review_state": "reported"},)),
                         ("in_", ("sf_txn_key", part)), ("eq", ("review_state", "pending"))]
                        for part in (keys[:100], keys[100:])]
    db = ChainDb(answer=[{"txn_key": "h1", "source": "rocketmoney"}])
    assert sf.Store(db).history_rows({"h1"}) == [{"txn_key": "h1", "source": "rocketmoney"}]
    [call] = db.calls
    assert call[0] == ("from", "finance_transactions")
    assert ("in_", ("txn_key", ["h1"])) in call and ("neq", ("source", "simplefin")) in call
    db = ChainDb()
    assert sf.Store(db).history_rows(set()) == [] and db.calls == []


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"{len(tests)} passed")
