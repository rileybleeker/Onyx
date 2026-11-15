// Run: node --test tests/cash-forecast-loader.test.cjs
// The cash forecast loader (lib/cash-forecast-server.ts loadForecast) end to end against an in-memory stand-in
// for the finance tables: which tax years reach the forecast across New Year, and the full what-if result of the
// other-income lever. SYNTHETIC DATA ONLY: invented accounts, salary, dates and amounts. No network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const PROFILE = {
  salaryAnnualCents: 12_000_000, // $120k, invented
  employmentStart: "2026-01-01",
  oneOffs: [],
  moveDate: null,
  ncWorkSharePct: 0,
  preTaxAnnualCents: 0,
  otherIncomeAnnualCents: 0,
  ytd: null,
  priorYear: null,
  estimatesPaid: [],
};

// Every table the loader reads; each query resolves to the table's rows (filters are not needed here).
function fakeDb(now, { profile = PROFILE, txns = [] } = {}) {
  const tables = {
    finance_accounts: [{ account_key: "demo-checking", institution: "Demo Bank", account_name: "Checking", account_type: "Cash", mask: "0001" }],
    finance_balance_snapshots: [{ account_key: "demo-checking", captured_at: new Date(now.getTime() - 3_600_000).toISOString(), balance_cents: 5_000_000, currency: "USD", kind: "asset" }],
    finance_transactions: txns,
    finance_plan_items: [],
    finance_plan_drivers: profile ? [{ key: "tax", value: profile }] : [],
    finance_forecast_snapshots: [],
    finance_goals: [],
    finance_category_rules: [],
    finance_txn_categories: [],
  };
  return {
    from(table) {
      assert.ok(table in tables, `unexpected table ${table}`);
      const rows = tables[table];
      const b = new Proxy({}, {
        get: (_, k) => (k === "then" ? (res, rej) => Promise.resolve({ data: rows, error: null, count: rows.length }).then(res, rej) : () => b),
      });
      return b;
    },
  };
}
function loader(opts) {
  const box = { now: null };
  const S = loadTs("lib/cash-forecast-server.ts", {
    "server-only": {},
    "@/lib/finance-ledger-server": {
      serviceClient: () => fakeDb(box.now, opts),
      fetchPaged: async (build) => {
        const r = await build(0, 999, true);
        return { rows: r.data ?? [], truncated: false };
      },
      loadCategoryFixes: async () => ({ rules: new Map(), overrides: new Map() }),
    },
  });
  return async (iso, levers) => {
    box.now = new Date(iso);
    const load = await S.loadForecast(box.now, levers);
    assert.equal(load.kind, "ok");
    return load;
  };
}
const taxLines = (result, year) => result.lines.filter((l) => l.sourceId.startsWith(`tax:${year}:`)).map((l) => `${l.sourceId}=${l.amountCents}`);

test("Dec 31 -> Jan 1: last year's January estimate and April refund stay in the forecast", async () => {
  const load = loader();
  const dec31 = await load("2026-12-31T17:00:00Z"); // noon ET
  const jan1 = await load("2027-01-01T17:00:00Z");
  const before = taxLines(dec31.result, 2026);
  assert.ok(before.some((l) => l.startsWith("tax:2026:GA:2027-01-15=-")), "a Georgia payment on Jan 15");
  assert.ok(before.some((l) => l.startsWith("tax:2026:NC:2027-04-30=")), "the NC refund on Apr 30");
  assert.deepEqual(taxLines(jan1.result, 2026), before, "nothing was paid or received at New Year");
  assert.deepEqual(jan1.tax.map((t) => t.year), [2026, 2027, 2028], "2026 is still shown on the page");
  assert.deepEqual(dec31.tax.map((t) => t.year), [2026, 2027, 2028]);
  // The years follow the two-year horizon, not "this year + 2".
  const may = await load("2027-05-01T16:00:00Z");
  assert.deepEqual(may.tax.map((t) => t.year), [2026, 2027, 2028, 2029]);
  assert.ok(taxLines(may.result, 2029).length > 0, "the April 2029 estimate is inside the horizon");
  const june = await load("2027-06-01T16:00:00Z");
  assert.deepEqual(june.tax.map((t) => t.year), [2027, 2028, 2029], "2026 leaves once its lines are past the late-match window");
});

test("an unpaid prior-year balance is still counted after its date; the payment settles it", async () => {
  const gaLine = (r) => r.planned.find((p) => p.id.startsWith("tax:2026:GA:"));
  const unpaid = await loader()("2027-04-25T16:00:00Z");
  const line = gaLine(unpaid.result);
  assert.equal(line.date, "2027-04-15", "with the 2026 return");
  assert.equal(line.status, "late-kept");
  assert.ok(unpaid.result.lines.some((l) => l.sourceId === line.id && l.date === "2027-04-26"), "counted as of tomorrow");
  // The same balance paid from checking on Apr 14 (expense-positive in the ledger).
  const paidTxn = { txn_key: "t1", account_key: "demo-checking", txn_date: "2027-04-14", name: "Demo state tax payment", custom_name: null, amount_cents: -line.amountCents, currency: "USD", category: "Taxes", ignored_from: null };
  const paid = await loader({ txns: [paidTxn] })("2027-04-25T16:00:00Z");
  const settled = gaLine(paid.result);
  assert.equal(settled.status, "realized");
  assert.ok(!paid.result.lines.some((l) => l.sourceId === settled.id), "not counted twice");
});

test("other income what-if: the full scenario result gets the income, not only its tax", async () => {
  const load = loader();
  const base = await load("2026-11-14T17:00:00Z", { otherIncome: 0 });
  const what = await load("2026-11-14T17:00:00Z", { otherIncome: 12_000 });
  assert.deepEqual(base.scenario.result.lines.filter((l) => l.sourceId.startsWith("wi:other:")), [], "no change, no receipts");
  const receipts = what.scenario.result.lines.filter((l) => l.sourceId.startsWith("wi:other:"));
  assert.equal(receipts[0].date, "2026-12-31", "from next month, at each month end");
  assert.ok(receipts.every((l) => l.amountCents === 100_000 && l.layer === "planned"));
  // Each year's taxed income goes up by exactly the receipts dated in it (2028 runs past the two-year window: all
  // twelve of its receipts are taxed, the lines stop at the horizon).
  const extraIncomeFor = (year) => what.scenario.tax.find((x) => x.year === year).agiCents - base.scenario.tax.find((x) => x.year === year).agiCents;
  for (const year of [2026, 2027]) assert.equal(extraIncomeFor(year), receipts.filter((l) => l.date.startsWith(`${year}-`)).reduce((s, l) => s + l.amountCents, 0), `income for ${year}`);
  assert.equal(extraIncomeFor(2026), 100_000, "one December receipt");
  assert.equal(extraIncomeFor(2028), 1_200_000);
  // Cash: the receipts minus the extra tax, so the what-if ends HIGHER than the base.
  const sum = (r, pred) => r.lines.filter((l) => l.layer === "planned" && pred(l)).reduce((s, l) => s + l.amountCents, 0);
  const end = what.scenario.result.headlines.end12m;
  const endDate = what.scenario.result.days[364].date; // end12m is day 365
  const byEnd = (l) => l.date <= endDate;
  const extraTax = sum(what.scenario.result, (l) => byEnd(l) && l.sourceId.startsWith("tax:")) - sum(base.scenario.result, (l) => byEnd(l) && l.sourceId.startsWith("tax:"));
  const extraIncome = sum(what.scenario.result, (l) => byEnd(l) && l.sourceId.startsWith("wi:other:"));
  assert.ok(extraTax < 0, "the income is taxed");
  assert.ok(extraIncome > -extraTax, "and still leaves more cash");
  assert.equal(end.likely - base.scenario.result.headlines.end12m.likely, extraIncome + extraTax);
  assert.ok(end.likely > what.result.headlines.end12m.likely, "the what-if beats the base plan");
});

test("other income the tax profile already has is not added again; no tax profile counts it before tax", async () => {
  const withOther = loader({ profile: { ...PROFILE, otherIncomeAnnualCents: 500_000 } });
  const same = await withOther("2026-11-14T17:00:00Z", { otherIncome: 5_000 });
  assert.deepEqual(same.scenario.result.lines, same.result.lines, "the same figure as the profile changes nothing");
  assert.deepEqual(same.scenario.tax, same.tax);
  const more = await withOther("2026-11-14T17:00:00Z", { otherIncome: 12_000 });
  const receipts = more.scenario.result.lines.filter((l) => l.sourceId.startsWith("wi:other:"));
  assert.ok(receipts.length > 0 && receipts.every((l) => l.amountCents === Math.round(700_000 / 12)), "only the $7k change");
  const noProfile = await loader({ profile: null })("2026-11-14T17:00:00Z", { otherIncome: 12_000, otherIncomeStart: "2027-02-01" });
  const gross = noProfile.scenario.result.lines.filter((l) => l.sourceId.startsWith("wi:other:"));
  assert.equal(gross[0].date, "2027-02-26");
  assert.ok(noProfile.scenario.result.warnings.some((w) => /before tax/.test(w)));
});
