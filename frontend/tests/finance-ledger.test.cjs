// Run: node --test tests/finance-ledger.test.cjs
// Finance ledger (/financials reading pds.finance_*): the pure functions in lib/finance-ledger.ts,
// the heartbeat logic in lib/finance-status.ts, the /status card, and static guards for the
// privacy rules (service-role server code only, no ISR, no select "*", no chat tool).
// SYNTHETIC DATA ONLY: every merchant, amount and account below is invented. No network, no
// credentials, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const L = loadTs("lib/finance-ledger.ts");
const S = loadTs("lib/finance-status.ts");
const F = loadTs("lib/format.ts");

const NOW = new Date("2030-03-15T12:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const tx = (over) => ({ account_key: "a1", txn_date: "2030-03-02", amount_cents: 1000, currency: "USD", category: "Shopping", ignored_from: null, ...over });
const acct = (key, over = {}) => ({ account_key: key, institution: "Demo Bank", account_name: `Account ${key}`, account_type: "Checking", mask: null, ...over });
const bal = (key, cents, kind, over = {}) => ({ account_key: key, captured_at: hoursAgo(2), balance_cents: cents, currency: "USD", kind, ...over });

// ─── spending vs movement of money ───────────────────────────────────────────

test("the transfer list is one constant and matching ignores case and padding", () => {
  assert.deepEqual([...L.NON_SPENDING_CATEGORIES], ["Internal Transfers", "Credit Card Payment", "Savings Transfer"]);
  for (const c of ["internal transfers", "  CREDIT CARD PAYMENT ", "Savings Transfer"]) assert.equal(L.isNonSpendingCategory(c), true, c);
  for (const c of ["Transfers", "Payment", "", null, undefined]) assert.equal(L.isNonSpendingCategory(c), false, String(c));
});

test("cashflow excludes transfers and card payments; refunds are money in", () => {
  const rows = [
    tx({ amount_cents: -300000, category: "Income" }), // paycheck, negative = money in
    tx({ amount_cents: 5000, category: "Groceries" }),
    tx({ amount_cents: 2500, category: "Groceries" }),
    tx({ amount_cents: -1500, category: "Shopping" }), // refund
    tx({ amount_cents: 100000, category: "Internal Transfers" }),
    tx({ amount_cents: 20000, category: "Credit Card Payment" }),
    tx({ amount_cents: -50000, category: "Savings Transfer" }),
  ];
  const s = L.summarizeFlows(rows);
  assert.equal(s.moneyInCents, 301500, "paycheck + refund");
  assert.equal(s.moneyOutCents, 7500);
  assert.equal(s.netCents, 294000);
  assert.equal(s.counted, 4);
  assert.equal(s.transfers, 3);
  assert.deepEqual(s.categories, [{ category: "Groceries", outCents: 7500, count: 2 }], "refunds and income are not outflow categories");
});

test("rows with a non-empty ignored_from are excluded; blank strings are not", () => {
  const s = L.summarizeFlows([
    tx({ amount_cents: 9999, ignored_from: "budget" }),
    tx({ amount_cents: -9999, ignored_from: "everything" }),
    tx({ amount_cents: 400, ignored_from: "   " }),
    tx({ amount_cents: 600, ignored_from: "" }),
  ]);
  assert.equal(s.ignored, 2);
  assert.equal(s.moneyOutCents, 1000);
  assert.equal(s.moneyInCents, 0);
  assert.equal(L.classifyTxn({ category: "Internal Transfers", ignored_from: "budget" }), "ignored");
});

test("non-USD rows are counted aside, never added to USD totals", () => {
  const s = L.summarizeFlows([tx({ amount_cents: 500 }), tx({ amount_cents: 70000, currency: "EUR" })]);
  assert.equal(s.moneyOutCents, 500);
  assert.equal(s.foreign, 1);
});

test("categories: largest first, ties by name, null becomes Uncategorized, __proto__ is just a name", () => {
  const s = L.summarizeFlows([
    tx({ amount_cents: 100, category: "Zed" }),
    tx({ amount_cents: 100, category: "Alpha" }),
    tx({ amount_cents: 900, category: null }),
    tx({ amount_cents: 50, category: "__proto__" }),
  ]);
  assert.deepEqual(s.categories.map((c) => c.category), ["Uncategorized", "Alpha", "Zed", "__proto__"]);
  assert.equal({}.polluted, undefined);
  const r = L.rankCategories(s.categories, 2);
  assert.equal(r.top.length, 2);
  assert.equal(r.otherCount, 2);
  assert.equal(r.otherCents, 150);
  assert.equal(r.maxCents, 900);
});

// ─── months and trend ────────────────────────────────────────────────────────

test("month helpers wrap years and reject malformed keys", () => {
  assert.equal(L.shiftMonth("2030-01", -1), "2029-12");
  assert.equal(L.shiftMonth("2029-12", 1), "2030-01");
  assert.deepEqual(L.trailingMonths("2030-02", 4), ["2029-11", "2029-12", "2030-01", "2030-02"]);
  assert.equal(L.trailingMonths("2030-02").length, 12);
  assert.deepEqual(L.monthsBetween("2029-11", "2030-01"), ["2030-01", "2029-12", "2029-11"]);
  assert.equal(L.monthsBetween("2000-01", "2030-01", 5).length, 5, "capped");
  for (const bad of ["2030-13", "2030-1", "2030-00", "30-01", "", null, undefined, "2030-01-01"]) assert.equal(L.isMonthKey(bad), false, String(bad));
  assert.equal(L.isMonthKey("2030-12"), true);
  assert.equal(L.monthLabel("2030-03"), "Mar 2030");
  assert.equal(L.monthLabel("2030-03", true), "Mar 30");
});

test("monthly trend zero-fills quiet months and applies the same exclusions", () => {
  const months = L.trailingMonths("2030-03", 3);
  const t = L.monthlyTrend(
    [
      tx({ txn_date: "2030-01-10", amount_cents: 1000 }),
      tx({ txn_date: "2030-03-01", amount_cents: 400 }),
      tx({ txn_date: "2030-03-02", amount_cents: 5000, category: "Credit Card Payment" }),
      tx({ txn_date: "2030-03-03", amount_cents: -250 }),
    ],
    months,
  );
  assert.deepEqual(t.map((p) => [p.month, p.outCents, p.inCents]), [["2030-01", 1000, 0], ["2030-02", 0, 0], ["2030-03", 400, 250]]);
});

// ─── balances and net worth ──────────────────────────────────────────────────

test("net worth: liabilities reduce it whichever sign the source used", () => {
  const accounts = ["a", "b", "c", "d", "e"].map((k) => acct(k));
  const nw = L.computeNetWorth(
    accounts,
    [bal("a", 100000, "asset"), bal("b", 30000, "liability"), bal("c", -20000, "liability"), bal("d", -2500, "asset"), bal("e", 0, "asset")],
    NOW,
  );
  assert.equal(nw.assetsCents, 97500, "an overdrawn asset reduces assets");
  assert.equal(nw.liabilitiesCents, 50000);
  assert.equal(nw.netWorthCents, 47500);
  assert.equal(nw.includedCount, 5);
  assert.equal(nw.assets[0].account.account_key, "a", "largest first");
  assert.equal(nw.liabilities[0].contributionCents, -30000);
});

test("kind null is surfaced as unclassified and left out, never guessed from the account type", () => {
  const accounts = [acct("a", { account_type: "Credit Card" }), acct("b", { account_type: "Investment" }), acct("c")];
  const nw = L.computeNetWorth(accounts, [bal("a", 999999, null), bal("b", 123400, "asset"), bal("c", 5000, "something odd")].map((b) => L.parseBalance(b)), NOW);
  assert.equal(nw.unclassified.length, 2, "a credit-card type with no kind is not assumed to be a liability");
  assert.equal(nw.netWorthCents, 123400);
  assert.equal(nw.unclassified[0].excluded, "unclassified");
  assert.equal(nw.unclassified[0].contributionCents, null);
});

test("non-USD balances are listed but not mixed into USD totals; accounts without a snapshot are listed", () => {
  const nw = L.computeNetWorth([acct("a"), acct("b"), acct("c")], [bal("a", 10000, "asset"), bal("b", 99999900, "asset", { currency: "EUR" })], NOW);
  assert.equal(nw.netWorthCents, 10000);
  assert.equal(nw.nonUsdCount, 1);
  assert.equal(nw.assets.find((l) => l.account.account_key === "b").excluded, "non-usd");
  assert.deepEqual(nw.noBalance.map((a) => a.account_key), ["c"]);
});

test("the newest snapshot per account wins", () => {
  const nw = L.computeNetWorth(
    [acct("a")],
    [bal("a", 111, "asset", { captured_at: hoursAgo(30) }), bal("a", 222, "asset", { captured_at: hoursAgo(3) }), bal("a", 333, "asset", { captured_at: hoursAgo(60) })],
    NOW,
  );
  assert.equal(nw.netWorthCents, 222);
});

test("stale badge: strictly older than 48 hours, unparseable counts as stale, future does not", () => {
  assert.equal(L.isStale(hoursAgo(47.9), NOW), false);
  assert.equal(L.isStale(hoursAgo(48), NOW), false);
  assert.equal(L.isStale(new Date(NOW.getTime() - 48 * 3_600_000 - 1).toISOString(), NOW), true);
  assert.equal(L.isStale("not a date", NOW), true);
  assert.equal(L.isStale(hoursAgo(-5), NOW), false);
  const nw = L.computeNetWorth([acct("a"), acct("b")], [bal("a", 1, "asset", { captured_at: hoursAgo(49) }), bal("b", 1, "asset")], NOW);
  assert.equal(nw.staleCount, 1);
  assert.equal(nw.oldestCapturedAt, hoursAgo(49));
  assert.equal(nw.assets.find((l) => l.account.account_key === "a").stale, true);
});

test("age labels", () => {
  assert.equal(L.ageLabel(hoursAgo(0), NOW), "just now");
  assert.equal(L.ageLabel(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW), "5m ago");
  assert.equal(L.ageLabel(hoursAgo(5), NOW), "5h ago");
  assert.equal(L.ageLabel(hoursAgo(72), NOW), "3d ago");
  assert.equal(L.ageLabel(null, NOW), "unknown");
  assert.equal(L.ageLabel("garbage", NOW), "unknown");
});

test("account labels never include more than the last four digits the source gave", () => {
  assert.equal(L.accountLabel({ institution: "Demo Bank", account_name: "Everyday", mask: "0000" }), "Demo Bank · Everyday ••0000");
  assert.equal(L.accountLabel({ institution: "Demo Bank", account_name: "Everyday", mask: null }), "Demo Bank · Everyday");
});

// ─── row parsing ─────────────────────────────────────────────────────────────

test("row parsers accept bigint strings and drop malformed rows", () => {
  assert.equal(L.toCents(1250), 1250);
  assert.equal(L.toCents("-1250"), -1250);
  for (const bad of [1.5, "12.5", "abc", null, undefined, NaN, 2 ** 60, "1".repeat(20)]) assert.equal(L.toCents(bad), null, String(bad));
  assert.equal(L.parseTxn({ account_key: "a", txn_date: "2030-03-01", amount_cents: "700", category: "X" }).amount_cents, 700);
  for (const bad of [null, {}, { account_key: "a", txn_date: "2030-3-1", amount_cents: 1 }, { account_key: "a", txn_date: "2030-03-01", amount_cents: null }, { txn_date: "2030-03-01", amount_cents: 1 }]) {
    assert.equal(L.parseTxn(bad), null);
  }
  assert.equal(L.parseBalance({ account_key: "a", captured_at: "x", balance_cents: 1, kind: " Asset " }).kind, "asset");
  assert.equal(L.parseBalance({ account_key: "a", captured_at: "x", balance_cents: 1, kind: "credit" }).kind, null);
  assert.equal(L.parseBalance({ account_key: "a", captured_at: "x", balance_cents: null }), null);
  assert.equal(L.parseAccount({ account_key: "a" }).institution, "Unknown institution");
  assert.equal(L.parseAccount({ institution: "x" }), null);
});

// ─── query string, search, paging ────────────────────────────────────────────

test("paging windows and counts", () => {
  assert.deepEqual(L.pageWindow(1), { from: 0, to: 49 });
  assert.deepEqual(L.pageWindow(3), { from: 100, to: 149 });
  assert.deepEqual(L.pageWindow(0), { from: 0, to: 49 }, "page below 1 is page 1");
  assert.equal(L.LIST_PAGE_SIZE, 50);
  assert.equal(L.pageCount(0), 1);
  assert.equal(L.pageCount(50), 1);
  assert.equal(L.pageCount(51), 2);
  assert.equal(L.pageCount(1000), 20);
});

test("query parsing validates every field and takes the first of repeated values", () => {
  const q = L.parseLedgerQuery({ month: ["2030-02", "2030-03"], account: "ABCDEF0123", q: "  coffee  ", page: "3", scope: "all" });
  assert.deepEqual(q, { month: "2030-02", account: "abcdef0123", q: "coffee", page: 3, allMonths: true });
  const bad = L.parseLedgerQuery({ month: "2030-13", account: "'; drop table", q: "a,b)(*%_\"", page: "-4", scope: "x" });
  assert.deepEqual(bad, { month: null, account: null, q: "a b", page: 1, allMonths: false });
  assert.equal(L.parseLedgerQuery({ page: "abc" }).page, 1);
  assert.equal(L.parseLedgerQuery({ page: "99999999" }).page, 100000);
  assert.deepEqual(L.parseLedgerQuery({}), { month: null, account: null, q: "", page: 1, allMonths: false });
});

test("links keep the filters, drop defaults and encode text", () => {
  const base = L.parseLedgerQuery({});
  assert.equal(L.ledgerHref(base), "/financials");
  const cur = { month: "2030-03", account: "ab12", q: "cafe & bar", page: 2, allMonths: false };
  assert.equal(L.ledgerHref(cur, { page: 3 }), "/financials?month=2030-03&account=ab12&q=cafe+%26+bar&page=3");
  assert.equal(L.ledgerHref(cur, { page: 1 }), "/financials?month=2030-03&account=ab12&q=cafe+%26+bar");
  assert.equal(L.ledgerHref(cur, { allMonths: true, page: 1 }), "/financials?month=2030-03&account=ab12&q=cafe+%26+bar&scope=all");
});

test("search text cannot inject PostgREST filter syntax or ILIKE wildcards", () => {
  for (const hostile of ["a,b", "x),(y", "50%", "under_score", "*", '"quoted"', "back\\slash", "name.eq.1,or(a.b)"]) {
    const f = L.buildSearchFilter(hostile);
    if (f === null) continue;
    const parts = f.split(",");
    assert.equal(parts.length, 4, `${hostile} -> ${f}`);
    for (const p of parts) assert.match(p, /^(name|custom_name|category|description)\.ilike\.\*[A-Za-z0-9 .'&#/+-]+\*$/, p);
  }
  assert.equal(L.buildSearchFilter(""), null);
  assert.equal(L.buildSearchFilter("%_*"), null);
  assert.equal(L.sanitizeSearch("x".repeat(200)).length, 60);
});

test("an amount in the search box also matches either sign of that amount", () => {
  assert.equal(L.searchAmountCents("12.50"), 1250);
  assert.equal(L.searchAmountCents("$1,234.5"), 123450);
  assert.equal(L.searchAmountCents("7"), 700);
  for (const no of ["12.505", "1,23", "abc", "12.5.0", "", "-5"]) assert.equal(L.searchAmountCents(no), null, no);
  const f = L.buildSearchFilter("$1,234.50");
  assert.ok(f.includes("amount_cents.eq.123450") && f.includes("amount_cents.eq.-123450"), f);
  assert.ok(f.includes("name.ilike.*1234.50*"), "commas stripped, digits kept");
});

// ─── money formatting ────────────────────────────────────────────────────────

test("formatCents", () => {
  assert.equal(F.formatCents(123456), "$1,234.56");
  assert.equal(F.formatCents(-500), "-$5.00");
  assert.equal(F.formatCents(0), "$0.00");
  assert.equal(F.formatCents(500, { signed: true }), "+$5.00");
  assert.equal(F.formatCents(-500, { signed: true }), "-$5.00");
  assert.equal(F.formatCents(500, { currency: "EUR" }), "€5.00");
  assert.equal(F.formatCents(500, { currency: "ZZZZ" }), "5.00 ZZZZ", "an unknown currency code never throws");
  for (const none of [null, undefined, NaN]) assert.equal(F.formatCents(none), "—");
});

// ─── heartbeats and the /status card ─────────────────────────────────────────

const beat = (hours, over = {}) => ({ status: "success", sync_start: hoursAgo(hours), records_synced: 10, duration_seconds: 4.5, error_message: null, ...over });
const card = (t, b) => S.financeLedgerCard(t, b, NOW.getTime());

test("status thresholds: >36h degraded, >72h failed, either heartbeat can drag it down", () => {
  assert.equal(card(beat(1), beat(2)).status, "success");
  assert.equal(card(beat(36), beat(36)).status, "success");
  assert.equal(card(beat(36.5), beat(1)).status, "partial");
  assert.equal(card(beat(1), beat(36.5)).status, "partial");
  assert.equal(card(beat(72), beat(1)).status, "partial");
  assert.equal(card(beat(73), beat(1)).status, "failed");
  assert.equal(card(beat(1), beat(100)).status, "failed");
});

test("a failed heartbeat shows the importer's own text, e.g. login required", () => {
  const c = card(beat(1, { status: "failed", error_message: "Login required: the Rocket Money session expired." }), beat(1));
  assert.equal(c.status, "failed");
  assert.equal(c.errorMessage, "Login required: the Rocket Money session expired.");
  assert.equal(card(beat(1), beat(1, { status: "error", error_message: "boom" })).status, "failed");
  assert.equal(card(beat(1, { status: "partial", error_message: "2 rows skipped" }), beat(1)).errorMessage, "2 rows skipped");
  // Text on a heartbeat that itself succeeded is not shown; a failure without text says so plainly.
  const quiet = card(beat(1, { error_message: "stale note" }), beat(1, { status: "failed" }));
  assert.equal(quiet.errorMessage, "The latest balances import failed (no error text recorded).");
  assert.equal(card(beat(1, { status: "failed", error_message: "y".repeat(900) }), beat(1)).errorMessage.length, 300);
});

test("stale or missing heartbeats say what is wrong in words", () => {
  assert.match(card(beat(40), beat(1)).errorMessage, /^Last transactions import was 40h ago/);
  assert.match(card(beat(1), null).errorMessage, /^No balances heartbeat yet/);
  assert.equal(card(beat(1), null).status, "partial", "half the pipeline silent is never green");
  assert.equal(card(null, null).status, "unknown");
  assert.equal(card(null, null).lastSync, null);
  assert.equal(card(beat(1, { status: "running" }), beat(1)).status, "partial");
});

test("card totals and newest sync", () => {
  const c = card(beat(5, { records_synced: 120 }), beat(2, { records_synced: 7, duration_seconds: 1.2 }));
  assert.equal(c.recordsSynced, 127);
  assert.equal(c.lastSync, hoursAgo(2));
  assert.equal(c.durationSeconds, 1.2);
  assert.equal(c.latestDataDate, hoursAgo(2).slice(0, 10));
});

function fakeSupabase(beats) {
  const reads = [];
  const from = (table) => {
    const q = { table, eq: {} };
    const b = {
      select() { return b; },
      eq(col, val) { q.eq[col] = val; return b; },
      not() { return b; },
      gte() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      then(resolve, reject) {
        reads.push(q);
        let data = [];
        if (table === "sync_log" && q.eq.source === "rocketmoney") data = beats[q.eq.data_type] ? [beats[q.eq.data_type]] : [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return b;
  };
  return { client: { from }, reads };
}

async function statusBody(beats) {
  const fake = fakeSupabase(beats);
  const stubs = {
    "@supabase/supabase-js": { createClient: () => fake.client },
    "next/server": { NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body }) } },
    "@/lib/nyc": { getNycScoutFreshness: async () => ({ lastVerified: null, liveCount: 0 }) },
  };
  const route = loadTs("app/api/status/route.ts", stubs);
  const res = await route.GET();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { body: res.body, reads: fake.reads };
}

test("/status has a Rocket Money card: automated, daily, worst-of-two heartbeats, heartbeats only", async () => {
  // The route reads the real clock, so these heartbeats are timed against it (not the fixed NOW above).
  const fresh = (h, over) => ({ source: "rocketmoney", status: "success", sync_start: new Date(Date.now() - h * 3_600_000).toISOString(), records_synced: 10, duration_seconds: 4.5, error_message: null, ...over });
  const ok = await statusBody({ transactions: fresh(2), balances: fresh(3) });
  const c = ok.body.sources.rocket_money;
  assert.equal(c.label, "Rocket Money");
  assert.equal(c.status, "success");
  assert.equal(c.integrationMethod, "automated");
  assert.ok(c.cadence && c.methodLabel);
  assert.equal(c.recordsSynced, 20);
  const dedicated = ok.reads.filter((q) => q.table === "sync_log" && q.eq.source === "rocketmoney").map((q) => q.eq.data_type).sort();
  assert.deepEqual(dedicated, ["balances", "transactions"], "each heartbeat has its own limit-1 read");
  assert.equal(ok.reads.some((q) => q.table.startsWith("finance_")), false, "the cacheable status endpoint never reads ledger rows");

  const login = await statusBody({ transactions: fresh(1), balances: fresh(1, { status: "failed", error_message: "Login required" }) });
  assert.equal(login.body.sources.rocket_money.status, "failed");
  assert.equal(login.body.sources.rocket_money.errorMessage, "Login required");

  const stale = await statusBody({ transactions: fresh(40), balances: fresh(40) });
  assert.equal(stale.body.sources.rocket_money.status, "partial");
  const dead = await statusBody({ transactions: fresh(80), balances: fresh(80) });
  assert.equal(dead.body.sources.rocket_money.status, "failed");
  const never = await statusBody({});
  assert.equal(never.body.sources.rocket_money.status, "unknown");
});

test("the status page lists the card and labels its history", () => {
  const page = fs.readFileSync(path.join(SRC, "app/status/page.tsx"), "utf8");
  assert.match(page, /rocket_money: "ROCKET MONEY"/);
  assert.match(page, /rocket_money: "text-/);
  assert.match(page, /SOURCE_ORDER = \[[^\]]*"rocket_money"/s);
  assert.match(page, /rocketmoney: "Rocket Money"/);
  assert.match(page, /transactions: "Transactions"/);
  assert.match(page, /balances: "Balances"/);
});

// ─── privacy and architecture guards ─────────────────────────────────────────

const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const financeFiles = ["lib/finance-ledger.ts", "lib/finance-ledger-server.ts", "lib/finance-status.ts", "app/financials/page.tsx", "app/financials/LedgerView.tsx", "app/financials/FilterBar.tsx", "app/financials/SpendingTrendChart.tsx"];

test("the page is rendered per request: force-dynamic, no ISR, no client fetching of ledger data", () => {
  const page = read("app/financials/page.tsx");
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.doesNotMatch(page, /export const revalidate/);
  assert.match(page, /robots: \{ index: false/);
  for (const f of financeFiles) {
    const src = read(f);
    assert.doesNotMatch(src, /\b(localStorage|sessionStorage|indexedDB|sendBeacon)\b/, f);
    assert.doesNotMatch(src, /\bfetch\(/, f);
    assert.doesNotMatch(src, /console\.(log|info|debug|warn)\b/, f);
  }
});

test("ledger tables are read only by server code with the service role, with explicit columns", () => {
  const server = read("lib/finance-ledger-server.ts");
  assert.match(server, /^import "server-only";/);
  assert.match(server, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(server, /ANON_KEY/);
  assert.doesNotMatch(server, /select\(\s*["'`]\*["'`]/, 'never select "*"');
  assert.match(server, /console\.error\("\[\/financials\] ledger query failed", code/, "only an error code is logged");
  // Nothing that ships to the browser may touch the ledger tables or the server module.
  const clientFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && /^\s*["']use client["']/.test(fs.readFileSync(p, "utf8"))) clientFiles.push(p);
    }
  };
  walk(SRC);
  assert.ok(clientFiles.length > 5, "found the client components");
  for (const f of clientFiles) {
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /finance_(accounts|transactions|balance_snapshots)/, f);
    assert.doesNotMatch(src, /finance-ledger-server/, f);
  }
});

test("no chat/LLM tool reads finance data", () => {
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const chat = [...walk(path.join(SRC, "app/api/chat")), path.join(SRC, "lib/chat-contract.ts")].filter((f) => fs.existsSync(f));
  assert.ok(chat.length > 0);
  for (const f of chat) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /finance[-_]ledger|finance_(accounts|transactions|balance)|rocketmoney/i, f);
});

test("every chart series on the page disables animation", () => {
  const chart = read("app/financials/SpendingTrendChart.tsx");
  const series = chart.match(/<Bar\b[^>]*>/g) ?? [];
  assert.ok(series.length >= 1);
  for (const s of series) assert.match(s, /isAnimationActive=\{false\}/);
});

test("the old CSV preview stays reachable and the page links the ledger copy honestly", () => {
  const page = read("app/financials/page.tsx");
  assert.match(page, /Preview a CSV/);
  assert.match(page, /<FinancialsClient embedded \/>/);
  assert.match(page, /No ledger data yet - the harvester has not run\./);
  assert.match(page, /Couldn't load the ledger|load\.message/);
});
