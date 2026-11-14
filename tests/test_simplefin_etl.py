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


def test_connection_errors_masked():
    body = {"errlist": [{"code": "con.auth", "msg": "Reconnect Demo Bank account 12345678"}], "errors": ["Rate limit warning"]}
    assert sf.connection_errors(body) == ["Reconnect Demo Bank account ####", "Rate limit warning"]


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
def row(key, d, cents, account="wf1", desc="X", source="simplefin", name=None):
    return {"txn_key": key, "account_key": account, "txn_date": d, "amount_cents": cents, "description": desc,
            "name": name or desc, "source": source, "category": None}


def test_cutover():
    hist = [row("h1", "2026-11-10", 500, source="rocketmoney"), row("h2", "2026-11-11", 700, source="rocketmoney"),
            row("h3", "2026-11-11", 700, source="rocketmoney")]
    sf_rows = [
        row("a", "2026-11-01", 900),      # long before the cutover: history has it
        row("b", "2026-11-11", 500),      # twin of h1 one day apart
        row("c", "2026-11-11", 700),      # twin of h2
        row("d", "2026-11-12", 700),      # twin of h3 (each history row is used once)
        row("e", "2026-11-12", 700),      # a third 7.00: no twin left, kept
        row("f", "2026-11-10", 300),      # pending when Rocket Money last looked: kept
        row("g", "2026-11-13", 999),      # after the cutover: kept
        row("s", "2026-11-02", 111),      # stored by an earlier SimpleFIN run: always rewritten
    ]
    kept, dropped = sf.apply_cutover(sf_rows, hist, date(2026, 11, 11), {"s"})
    assert sorted(r["txn_key"] for r in kept) == ["e", "f", "g", "s"]
    assert dropped["before the Rocket Money cutover"] == 1 and dropped["already in the Rocket Money history"] == 3
    again, _ = sf.apply_cutover(list(reversed(sf_rows)), hist, date(2026, 11, 11), {"s"})
    assert sorted(r["txn_key"] for r in again) == ["e", "f", "g", "s"]   # order-independent
    assert len(sf.apply_cutover(sf_rows, hist, None, set())[0]) == len(sf_rows)


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
class FakeStore:
    def __init__(self, accounts, kinds=None, cutovers=None, window=None, history=None):
        self._accounts, self.kinds, self.cutovers = accounts, kinds or {}, cutovers or {}
        self._window, self._history = window or [], history or []
        self.created, self.links, self.txns, self.balances, self.beats = [], [], [], [], []

    def accounts(self):
        return [dict(a) for a in self._accounts]

    def latest_kind(self, key):
        return self.kinds.get(key)

    def cutover(self, key):
        return self.cutovers.get(key)

    def window_rows(self, since):
        return list(self._window)

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
    code = sf.run(store, Http(get=Res(200, body([{"code": "con.auth", "msg": "Reconnect Wells Fargo"}]))), ACCESS, 60, False, now=NOW, out=lambda *_: None)
    assert code == 0 and store.beats[0][1] == "partial" and "Reconnect Wells Fargo" in store.beats[0][3]

    dry = FakeStore(ledger_with_fidelity())
    lines = []
    assert sf.run(dry, Http(get=Res(200, body())), ACCESS, 60, True, now=NOW, out=lines.append) == 0
    assert not (dry.txns or dry.balances or dry.created or dry.links or dry.beats)
    assert any("Platinum" in line for line in lines)   # the local dry run shows the matching


def test_run_failure_writes_failed_heartbeats():
    store = FakeStore(LEDGER)
    lines = []
    assert sf.run(store, Http(get=Res(403)), ACCESS, 60, False, now=NOW, out=lines.append) == 1
    assert [b[:2] for b in store.beats] == [("transactions", "failed"), ("balances", "failed")]
    assert_no_secret(store.beats[0][3])
    assert_no_secret("\n".join(lines))


def test_skipped_account_is_partial():
    b = body()
    b["accounts"].append(acct("S-WFX", "Some Account", "c2", [txn("9", "2026-11-18", "-1.00", "X")]))
    store = FakeStore(ledger_with_fidelity())
    sf.run(store, Http(get=Res(200, b)), ACCESS, 60, False, now=NOW, out=lambda *_: None)
    assert store.beats[0][1] == "partial" and "not imported" in store.beats[0][3]
    assert not any(t["source_txn_id"].startswith("sf:S-WFX") for t in store.txns)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"{len(tests)} passed")
