// Run: node --test tests/finance-ledger-view.test.cjs
// Renders the real /financials server components (LedgerView, page.tsx) to HTML with the
// interactive pieces stubbed, over SYNTHETIC ledger data: every account, merchant and amount
// below is invented. No network, no credentials, no database, no browser.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./helpers/load-ts.cjs");

const h = React.createElement;
const L = loadTs("lib/finance-ledger.ts");
const S = loadTs("lib/finance-status.ts");

const NOW = new Date("2030-03-15T12:00:00Z");
const hoursAgo = (n) => new Date(NOW.getTime() - n * 3_600_000).toISOString();
const beat = (n, over = {}) => ({ status: "success", sync_start: hoursAgo(n), records_synced: 10, duration_seconds: 1, error_message: null, ...over });
const tx = (over) => ({ account_key: "a1", txn_date: "2030-03-02", amount_cents: 1000, currency: "USD", category: "Shopping", ignored_from: null, ...over });
const acct = (key, over = {}) => ({ account_key: key, institution: "Demo Bank", account_name: `Account ${key}`, account_type: "Checking", mask: null, ...over });
const bal = (key, cents, kind, over = {}) => ({ account_key: key, captured_at: hoursAgo(2), balance_cents: cents, currency: "USD", kind, ...over });

const viewStubs = {
  "next/link": { __esModule: true, default: ({ href, children, className }) => h("a", { href, className }, children) },
  "@/components/ChartCard": { __esModule: true, default: ({ title, children }) => h("section", { "data-chartcard": title }, children) },
  "@/components/StatCard": {
    __esModule: true,
    default: ({ label, value, sublabel }) => h("div", { "data-stat": label }, h("b", null, value ?? "none"), sublabel ? h("i", null, sublabel) : null),
  },
  "./FilterBar": {
    __esModule: true,
    default: (p) => h("div", { "data-filter": p.month, "data-accounts": p.accounts.length, "data-months": p.months.length }),
  },
  "./SpendingTrendChart": { __esModule: true, default: (p) => h("div", { "data-chart": p.data.length, "data-selected": p.selectedMonth }) },
};
const View = loadTs("app/financials/LedgerView.tsx", viewStubs);

function ledgerData(over = {}) {
  const accounts = [
    acct("a1", { account_name: "Everyday", mask: "0000" }),
    acct("a2", { account_name: "Card", account_type: "Credit Card" }),
    acct("a3", { account_name: "Mystery" }),
  ];
  const balances = [
    bal("a1", 250000, "asset", { captured_at: hoursAgo(60) }), // older than 48h: stale
    bal("a2", 40000, "liability"),
    bal("a3", 7700, null), // no kind from the source: listed, not counted
  ];
  const monthRows = [
    tx({ amount_cents: -100000, category: "Income" }),
    tx({ amount_cents: 12000, category: "Groceries" }),
    tx({ amount_cents: -2000, category: "Groceries" }), // refund
    tx({ amount_cents: 30000, category: "Credit Card Payment" }),
  ];
  return {
    query: { month: "2030-03", account: null, q: "", page: 2, allMonths: false },
    accounts,
    accountLabels: Object.fromEntries(accounts.map((a) => [a.account_key, L.accountLabel(a)])),
    months: ["2030-03", "2030-02"],
    netWorth: L.computeNetWorth(accounts, balances, NOW),
    flows: L.summarizeFlows(monthRows),
    trend: L.monthlyTrend(monthRows, L.trailingMonths("2030-03")),
    list: {
      rows: [
        { txn_key: "k1", account_key: "a1", txn_date: "2030-03-04", title: "<script>alert(1)</script> Demo Market", amount_cents: 12000, currency: "USD", category: "Groceries", excluded: null },
        { txn_key: "k2", account_key: "a2", txn_date: "2030-03-03", title: "Card payment", amount_cents: 30000, currency: "USD", category: "Credit Card Payment", excluded: "transfer" },
        { txn_key: "k3", account_key: "a1", txn_date: "2030-03-02", title: "Refund", amount_cents: -2000, currency: "USD", category: null, excluded: null },
        { txn_key: "k4", account_key: "a1", txn_date: "2030-03-01", title: "Hidden", amount_cents: 500, currency: "USD", category: "Fun", excluded: "ignored" },
        { txn_key: "k5", account_key: "a1", txn_date: "2030-03-01", title: "Overseas", amount_cents: 900, currency: "EUR", category: "Fun", excluded: null },
      ],
      total: 123,
      page: 2,
      pageCount: 3,
      pageSize: 50,
    },
    freshness: S.financeLedgerCard(beat(1), beat(1, { status: "failed", error_message: "Login required" }), NOW.getTime()),
    skippedRows: 0,
    windowTruncated: false,
    pageClamped: false,
    ...over,
  };
}
const html = (data) => renderToStaticMarkup(h(View.default, { data, now: NOW }));

test("net worth: liabilities subtract, unclassified is surfaced not counted, stale balance is badged", () => {
  const out = html(ledgerData());
  assert.match(out, /data-stat="Net worth"><b>\$2,100\.00<\/b>/, "2,500 asset minus 400 owed; the unclassified 77 is left out");
  assert.match(out, /data-stat="Assets"><b>\$2,500\.00<\/b>/);
  assert.match(out, /data-stat="Liabilities \(owed\)"><b>\$400\.00<\/b>/);
  assert.match(out, /2 accounts counted/);
  assert.match(out, /captured 2d ago/);
  assert.match(out, /captured 2h ago/);
  assert.equal((out.match(/>stale</g) || []).length, 1, "only the old balance carries the badge");
  assert.match(out, /1 balance is older than 48 hours/);
  assert.match(out, /1 account has no asset or liability label/);
  assert.match(out, /Not counted in net worth until the source labels them/);
  assert.match(out, /••0000/);
  assert.match(out, /Rocket Money sync:/);
  assert.match(out, /Login required/, "a failed heartbeat shows its own text");
});

test("cashflow: refunds are money in, card payments are not spending, excluded rows are labelled", () => {
  const data = ledgerData();
  const out = html(data);
  assert.equal(data.flows.moneyInCents, 102000);
  assert.equal(data.flows.moneyOutCents, 12000);
  assert.match(out, /data-stat="Money in"><b>\$1,020\.00<\/b><i>Includes refunds/);
  assert.match(out, /data-stat="Money out"><b>\$120\.00<\/b>/);
  assert.match(out, /data-stat="Net cashflow"><b>\+\$900\.00<\/b>/);
  assert.match(out, />not spending</);
  assert.match(out, />ignored</);
  assert.match(out, /3 transactions counted\. Left out: 1 transfer, card-payment or ignored row/);
  assert.match(out, /Groceries/);
  assert.match(out, /100%/, "the only outflow category takes the whole ranking");
  assert.match(out, /data-chart="12" data-selected="2030-03"/);
  assert.match(out, /data-filter="2030-03" data-accounts="3" data-months="2"/);
});

test("transaction list: signs, foreign currency, escaping and paging links", () => {
  const out = html(ledgerData());
  assert.doesNotMatch(out, /<script>/, "text from the source is escaped, never raw HTML");
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, />-\$120\.00</, "a purchase reads as money out");
  assert.match(out, />\+\$20\.00</, "a refund reads as money in");
  assert.match(out, />-€9\.00</, "a non-USD row shows its own currency");
  assert.match(out, /Showing 51–55 of 123/);
  assert.match(out, /Page 2 of 3/);
  assert.match(out, /href="\/financials\?month=2030-03"[^>]*>Newer/, "page 1 drops the page parameter");
  assert.match(out, /href="\/financials\?month=2030-03&amp;page=3"[^>]*>Older/);
  assert.match(out, />Uncategorized</);
});

test("empty month, no balances, warnings", () => {
  const accounts = [acct("a1")];
  const out = html(
    ledgerData({
      accounts,
      accountLabels: { a1: "x" },
      netWorth: L.computeNetWorth(accounts, [], NOW),
      flows: L.summarizeFlows([]),
      list: { rows: [], total: 0, page: 1, pageCount: 1, pageSize: 50 },
      freshness: null,
      skippedRows: 2,
      windowTruncated: true,
      pageClamped: true,
    }),
  );
  assert.match(out, /No transactions for this month and account\./);
  assert.match(out, /No matching transactions\./);
  assert.match(out, /No balances captured yet/);
  assert.match(out, /1 account has no balance snapshot yet/);
  assert.match(out, /data-stat="Net worth"><b>none<\/b>/, "net worth is not shown as $0 when nothing was counted");
  assert.match(out, /2 stored row\(s\) could not be read/);
  assert.match(out, /oldest months may be incomplete/);
  assert.match(out, /no heartbeat recorded yet/);
  assert.match(out, /That page is past the end/);
  assert.doesNotMatch(out, /<table/, "no empty table");
});

function pageFor(load) {
  return loadTs("app/financials/page.tsx", {
    "@/lib/finance-ledger-server": { loadLedger: async () => load },
    "./FinancialsClient": { __esModule: true, default: ({ embedded }) => h("div", { "data-csv": String(!!embedded) }) },
    "./LedgerView": { __esModule: true, default: () => h("div", { "data-ledger": "yes" }), FreshnessLine: View.FreshnessLine },
  });
}
async function renderPage(load) {
  const page = pageFor(load);
  assert.equal(page.dynamic, "force-dynamic");
  assert.equal(page.revalidate, undefined, "no ISR");
  return renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({}) }));
}

test("page states: empty ledger, query failure and data are three different things", async () => {
  const empty = await renderPage({ kind: "empty", freshness: null });
  assert.match(empty, /No ledger data yet - the harvester has not run\./);
  assert.doesNotMatch(empty, /Couldn(&#x27;|')t load the ledger/);
  assert.match(empty, /Preview a CSV/);
  assert.match(empty, /data-csv="true"/);

  const ranButEmpty = await renderPage({
    kind: "empty",
    freshness: S.financeLedgerCard(beat(1, { status: "failed", error_message: "Login required" }), null, NOW.getTime()),
  });
  assert.match(ranButEmpty, /the harvester has run but imported nothing/);
  assert.match(ranButEmpty, /Login required/);

  const failed = await renderPage({ kind: "error", message: "Couldn't load the ledger.", hint: "The database query failed (code 57014). Try again in a moment." });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Couldn(&#x27;|')t load the ledger\./);
  assert.match(failed, /failed query, not an empty ledger/);
  assert.doesNotMatch(failed, /No ledger data yet/);

  const ok = await renderPage({ kind: "ok", data: ledgerData() });
  assert.match(ok, /data-ledger="yes"/);
  assert.doesNotMatch(ok, /No ledger data yet|role="alert"/);
  assert.match(ok, /data-csv="true"/, "the CSV preview stays reachable alongside the ledger");
});
