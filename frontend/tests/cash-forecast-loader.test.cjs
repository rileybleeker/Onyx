// Run: node --test tests/cash-forecast-loader.test.cjs
// The cash forecast loader (lib/cash-forecast-server.ts loadForecast) end to end against an in-memory stand-in
// for the finance tables: which tax years reach the forecast across New Year, and the full what-if result of the
// other-income lever, and the safe-to-move gate (a failed plan read, a truncated read, a stale balance withhold the
// amount in the base plan and the what-if alike). SYNTHETIC DATA ONLY: invented accounts, salary, dates and amounts.
// No network, no database.
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

// Every table the loader reads; each query resolves to the table's rows (filters are not needed here, except on the
// balance snapshots: gte / eq / order / limit, so the 60-day read and the newest-snapshot read differ). A table in
// `failing` answers a database error instead.
function fakeDb(now, { profile = PROFILE, txns = [], failing = [], accounts = [], balances = [], drivers = [] } = {}) {
  const tables = {
    finance_accounts: [{ account_key: "demo-checking", institution: "Demo Bank", account_name: "Checking", account_type: "Cash", mask: "0001" }, ...accounts],
    finance_balance_snapshots: [{ account_key: "demo-checking", captured_at: new Date(now.getTime() - 3_600_000).toISOString(), balance_cents: 5_000_000, currency: "USD", kind: "asset" }, ...balances],
    finance_transactions: txns,
    finance_plan_items: [],
    finance_plan_drivers: [...(profile ? [{ key: "tax", value: profile }] : []), ...drivers],
    finance_forecast_snapshots: [],
    finance_goals: [],
    finance_category_rules: [],
    finance_txn_categories: [],
  };
  return {
    from(table) {
      assert.ok(table in tables, `unexpected table ${table}`);
      const calls = [];
      const rowsNow = () => {
        let rows = tables[table];
        if (table !== "finance_balance_snapshots") return rows;
        for (const [k, a] of calls) {
          if (k === "gte") rows = rows.filter((r) => r[a[0]] >= a[1]);
          else if (k === "eq") rows = rows.filter((r) => r[a[0]] === a[1]);
          else if (k === "order") rows = [...rows].sort((x, y) => (x[a[0]] < y[a[0]] ? -1 : x[a[0]] > y[a[0]] ? 1 : 0) * (a[1]?.ascending === false ? -1 : 1));
          else if (k === "limit") rows = rows.slice(0, a[0]);
        }
        return rows;
      };
      const answer = () => {
        if (failing.includes(table)) return { data: null, error: { code: "57014", message: "synthetic failure" }, count: null };
        const rows = rowsNow();
        return { data: rows, error: null, count: rows.length };
      };
      const b = new Proxy({}, {
        get: (_, k) => (k === "then" ? (res, rej) => Promise.resolve(answer()).then(res, rej) : (...a) => (calls.push([k, a]), b)),
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
        return { rows: r.data ?? [], truncated: !!opts?.truncated };
      },
      loadCategoryFixes: async () => ({ rules: new Map(), overrides: new Map(), ...(opts?.fixesFailed ? { failed: true } : {}) }),
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

// ─── the safe-to-move gate (lib/cash-forecast.ts eligibility) through the loader ─────────────────
/** Synthetic everyday debits from checking, every 3 days for 16 weeks before `iso` (enough history for the baseline). */
function everyday(iso) {
  const out = [];
  for (let i = 1; i <= 37; i++) {
    const d = new Date(Date.parse(iso) - i * 3 * 86_400_000).toISOString().slice(0, 10);
    out.push({ txn_key: `e${i}`, account_key: "demo-checking", txn_date: d, name: `Demo Shop ${String.fromCharCode(65 + (i % 26))}`, custom_name: null, amount_cents: 3_000 + (i % 4) * 500, currency: "USD", category: "Shopping", ignored_from: null });
  }
  return out;
}
const AT = "2026-11-14T17:00:00Z";

test("complete, fresh reads: the base plan and the what-if both carry an amount, from the same gate", async () => {
  const load = await loader({ txns: everyday(AT) })(AT, { otherIncome: 6_000 });
  assert.equal(load.setupPending, false);
  assert.equal(load.result.eligibility.eligible, true);
  assert.deepEqual(load.result.eligibility.reasons, []);
  assert.equal(typeof load.result.headlines.safeToMoveCents, "number");
  assert.deepEqual(load.scenario.result.eligibility, load.result.eligibility, "the what-if reads the same inputs");
  assert.equal(typeof load.scenario.result.headlines.safeToMoveCents, "number");
});

test("a failed plan read: setupPending, and no amount in the base plan or the what-if", async () => {
  for (const failing of [["finance_plan_items"], ["finance_plan_drivers"]]) {
    const load = await loader({ txns: everyday(AT), failing })(AT, { otherIncome: 6_000 });
    assert.equal(load.setupPending, true, failing[0]);
    assert.deepEqual(load.result.eligibility.reasons.map((r) => r.code), ["plan-unavailable"], failing[0]);
    assert.equal(load.result.headlines.safeToMoveCents, null);
    assert.deepEqual(load.scenario.result.eligibility, load.result.eligibility);
    assert.equal(load.scenario.result.headlines.safeToMoveCents, null);
    assert.ok(load.result.days.length > 0, "the projection is still drawn");
  }
  // The goals or the snapshots failing does not touch the gate (they are not inputs to the amount).
  const goals = await loader({ txns: everyday(AT), failing: ["finance_goals", "finance_forecast_snapshots"] })(AT);
  assert.equal(goals.result.eligibility.eligible, true);
});

test("a truncated history read: no amount, and the warning appears once", async () => {
  const load = await loader({ txns: everyday(AT), truncated: true })(AT);
  assert.deepEqual(load.result.eligibility.reasons.map((r) => r.code), ["history-truncated"]);
  assert.equal(load.result.headlines.safeToMoveCents, null);
  assert.equal(load.result.warnings.filter((w) => /page limit/.test(w)).length, 1);
});

test("a balance older than 48 hours at load time: no amount until the next sync", async () => {
  const fresh = await loader({ txns: everyday(AT) })(AT);
  assert.equal(fresh.result.eligibility.eligible, true);
  // Three days on with no new snapshot: the stand-in's balance stays dated 1 h before AT.
  const later = new Date(Date.parse(AT) + 3 * 86_400_000).toISOString();
  const S = loadTs("lib/cash-forecast-server.ts", {
    "server-only": {},
    "@/lib/finance-ledger-server": {
      serviceClient: () => fakeDb(new Date(AT), { txns: everyday(AT) }),
      fetchPaged: async (build) => ({ rows: (await build(0, 999, true)).data ?? [], truncated: false }),
      loadCategoryFixes: async () => ({ rules: new Map(), overrides: new Map() }),
    },
  });
  const stale = await S.loadForecast(new Date(later));
  assert.equal(stale.kind, "ok");
  assert.deepEqual(stale.result.eligibility.reasons.map((r) => r.code), ["stale-balance"]);
  assert.equal(stale.result.headlines.safeToMoveCents, null);
});

test("category fixes that could not be read: no amount in the base plan or the what-if", async () => {
  const load = await loader({ txns: everyday(AT), fixesFailed: true })(AT, { otherIncome: 6_000 });
  assert.deepEqual(load.result.eligibility.reasons.map((r) => r.code), ["categories-unavailable"]);
  assert.equal(load.result.headlines.safeToMoveCents, null);
  assert.deepEqual(load.scenario.result.eligibility.reasons.map((r) => r.code), ["categories-unavailable"]);
});

test("a cash account the feed stopped refreshing: a small one is left out and named, a larger one waits for Riley", async () => {
  const wallet = { account_key: "demo-wallet", institution: "Demo Pay", account_name: "Wallet", account_type: "Cash", mask: "0002" };
  const old = (cents) => ({ account_key: "demo-wallet", captured_at: new Date(Date.parse(AT) - 90 * 86_400_000).toISOString(), balance_cents: cents, currency: "USD", kind: "asset" });
  // Small: its newest snapshot (outside the 60-day read) is read on its own; the amount leaves it out and names it.
  const small = await loader({ txns: everyday(AT), accounts: [wallet], balances: [old(4_000)] })(AT);
  assert.equal(small.result.eligibility.eligible, true);
  assert.deepEqual(small.result.eligibility.leftOut.map((l) => [l.account, l.why]), [["demo-wallet", "small"]]);
  assert.equal(small.result.opening.cents, 5_004_000, "the projection counts its last balance");
  assert.equal(typeof small.result.headlines.safeToMoveCents, "number");
  // Larger: it stays missing (the projection counts it as $0) and withholds the amount, naming the account.
  const large = await loader({ txns: everyday(AT), accounts: [wallet], balances: [old(400_000)] })(AT);
  assert.deepEqual(large.result.eligibility.reasons.map((r) => [r.code, r.account]), [["missing-balance", "demo-wallet"]]);
  assert.equal(large.result.opening.cents, 5_000_000);
  assert.equal(large.result.headlines.safeToMoveCents, null);
  // Riley leaves it out (driver "safe-to-move"): the amount comes back, the account is named as left out.
  const chosen = await loader({ txns: everyday(AT), accounts: [wallet], balances: [old(400_000)], drivers: [{ key: "safe-to-move", value: { leaveOut: ["demo-wallet"] } }] })(AT);
  assert.equal(chosen.result.eligibility.eligible, true);
  assert.deepEqual(chosen.result.eligibility.leftOut.map((l) => [l.account, l.why, l.asOf]), [["demo-wallet", "chosen", null]]);
  assert.equal(typeof chosen.result.headlines.safeToMoveCents, "number");
});

test("an overdraft older than the 60-day read still lowers the amount, even when Riley left the account out", async () => {
  const wallet = { account_key: "demo-wallet", institution: "Demo Pay", account_name: "Wallet", account_type: "Cash", mask: "0002" };
  const old = (cents, days = 90) => ({ account_key: "demo-wallet", captured_at: new Date(Date.parse(AT) - days * 86_400_000).toISOString(), balance_cents: cents, currency: "USD", kind: "asset" });
  const leave = [{ key: "safe-to-move", value: { leaveOut: ["demo-wallet"] } }];
  // Not left out: a large overdraft too old to trust is read (not dropped to $0) and withholds the amount.
  const open = await loader({ txns: everyday(AT), accounts: [wallet], balances: [old(-400_000)] })(AT);
  assert.deepEqual(open.result.eligibility.reasons.map((r) => [r.code, r.account]), [["stale-balance", "demo-wallet"]]);
  assert.equal(open.result.opening.cents, 4_600_000, "the projection counts the debt");
  assert.equal(open.result.headlines.safeToMoveCents, null);
  // Left out: the amount comes back, and the debt keeps lowering it (only a positive balance is taken out).
  const debt = await loader({ txns: everyday(AT), accounts: [wallet], balances: [old(-400_000)], drivers: leave })(AT);
  const none = await loader({ txns: everyday(AT), accounts: [wallet], balances: [old(400_000)], drivers: leave })(AT);
  assert.equal(debt.result.eligibility.eligible, true);
  assert.deepEqual(debt.result.eligibility.leftOut.map((l) => [l.account, l.why, l.asOf]), [["demo-wallet", "chosen", old(0).captured_at]]);
  assert.equal(typeof debt.result.headlines.safeToMoveCents, "number");
  assert.ok(Math.abs(debt.result.headlines.safeToMoveCents - (none.result.headlines.safeToMoveCents - 400_000)) <= 1, "$4,000 less than with no debt");
  // Crossing the boundary changes nothing: the same overdraft read inside the 60-day window gives the same amount.
  const inside = await loader({ txns: everyday(AT), accounts: [wallet], balances: [old(-400_000, 59)], drivers: leave })(AT);
  assert.equal(inside.result.headlines.safeToMoveCents, debt.result.headlines.safeToMoveCents);
  // A liability-kind snapshot is a debt whatever its sign.
  const owed = await loader({ txns: everyday(AT), accounts: [wallet], balances: [{ ...old(400_000), kind: "liability" }], drivers: leave })(AT);
  assert.equal(owed.result.headlines.safeToMoveCents, debt.result.headlines.safeToMoveCents);
});

test("a saved tax profile or move plan that no longer parses withholds the amount, in the base plan and the what-if", async () => {
  const badTax = await loader({ txns: everyday(AT), profile: { salaryAnnualCents: "lots" } })(AT, { otherIncome: 6_000 });
  assert.equal(badTax.profile, null);
  assert.deepEqual(badTax.result.eligibility.reasons.map((r) => r.code), ["plan-invalid"]);
  assert.equal(badTax.result.headlines.safeToMoveCents, null);
  assert.deepEqual(badTax.scenario.result.eligibility.reasons.map((r) => r.code), ["plan-invalid"]);
  assert.ok(badTax.result.days.length > 0, "the projection is still drawn");
  const badMove = await loader({ txns: everyday(AT), drivers: [{ key: "move", value: { when: "soon" } }] })(AT);
  assert.equal(badMove.move, null);
  assert.deepEqual(badMove.result.eligibility.reasons.map((r) => r.code), ["plan-invalid"]);
  // No tax profile or move plan saved at all is not a reason (nothing is missing).
  const none = await loader({ txns: everyday(AT), profile: null })(AT);
  assert.equal(none.result.eligibility.eligible, true);
});
