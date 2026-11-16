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
// `failing` answers a database error instead. `olderRead` = how the per-account newest-snapshot read (the one with
// eq on account_key) answers: "error" (a database error) or "reject" (the request itself fails); default: rows.
function fakeDb(now, { profile = PROFILE, txns = [], failing = [], accounts = [], balances = [], drivers = [], olderRead = "rows" } = {}) {
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
      const olderOne = () => table === "finance_balance_snapshots" && calls.some(([k, a]) => k === "eq" && a[0] === "account_key");
      const answer = () => {
        if (failing.includes(table)) return { data: null, error: { code: "57014", message: "synthetic failure" }, count: null };
        if (olderOne() && olderRead === "error") return { data: null, error: { code: "57014", message: "synthetic failure" }, count: null };
        const rows = rowsNow();
        return { data: rows, error: null, count: rows.length };
      };
      const b = new Proxy({}, {
        get: (_, k) =>
          k === "then"
            ? (res, rej) => (olderOne() && olderRead === "reject" ? Promise.reject(new Error("synthetic network failure")) : Promise.resolve(answer())).then(res, rej)
            : (...a) => (calls.push([k, a]), b),
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

test("a cash account the feed stopped refreshing withholds the amount whatever its size, until Riley leaves it out", async () => {
  const wallet = { account_key: "demo-wallet", institution: "Demo Pay", account_name: "Wallet", account_type: "Cash", mask: "0002" };
  const old = (cents) => ({ account_key: "demo-wallet", captured_at: new Date(Date.parse(AT) - 90 * 86_400_000).toISOString(), balance_cents: cents, currency: "USD", kind: "asset" });
  // Small: its newest snapshot (outside the 60-day read) is read on its own; too old to trust, so no amount.
  const small = await loader({ txns: everyday(AT), accounts: [wallet], balances: [old(4_000)] })(AT);
  assert.deepEqual(small.result.eligibility.reasons.map((r) => [r.code, r.account]), [["stale-balance", "demo-wallet"]]);
  assert.equal("leftOut" in small.result.eligibility, false, "nothing is left out automatically");
  assert.equal(small.result.opening.cents, 5_004_000, "the projection counts its last balance");
  assert.equal(small.result.headlines.safeToMoveCents, null);
  // Left out by Riley: the amount comes back and the account is named, dated by its last balance.
  const smallChosen = await loader({ txns: everyday(AT), accounts: [wallet], balances: [old(4_000)], drivers: [{ key: "safe-to-move", value: { leaveOut: ["demo-wallet"] } }] })(AT);
  assert.equal(smallChosen.result.eligibility.eligible, true);
  assert.deepEqual(smallChosen.result.eligibility.leftOut.map((l) => [l.account, l.why, l.asOf]), [["demo-wallet", "chosen", old(0).captured_at]]);
  assert.equal(typeof smallChosen.result.headlines.safeToMoveCents, "number");
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

test("an older overdraft in another currency is never left out as $0: no amount, and no Leave it out on it", async () => {
  const wallet = { account_key: "demo-wallet", institution: "Demo Pay", account_name: "Wallet", account_type: "Cash", mask: "0002" };
  const old = (cents, currency) => ({ account_key: "demo-wallet", captured_at: new Date(Date.parse(AT) - 90 * 86_400_000).toISOString(), balance_cents: cents, currency, kind: "asset" });
  const leave = [{ key: "safe-to-move", value: { leaveOut: ["demo-wallet"] } }];
  for (const drivers of [[], leave]) {
    const load = await loader({ txns: everyday(AT), accounts: [wallet], balances: [old(-400_000, "EUR")], drivers })(AT, { otherIncome: 6_000 });
    assert.equal(load.kind, "ok");
    assert.deepEqual(load.result.eligibility.reasons.map((r) => [r.code, r.account]), [["invalid-balance", undefined]], `left out: ${drivers.length > 0}`);
    assert.equal(load.result.headlines.safeToMoveCents, null);
    assert.deepEqual(load.scenario.result.eligibility.reasons.map((r) => r.code), ["invalid-balance"], "the what-if reads the same inputs");
  }
  // The same account with an older POSITIVE balance in another currency: Riley can leave it out, and the amount comes back.
  const positive = await loader({ txns: everyday(AT), accounts: [wallet], balances: [old(4_000, "EUR")], drivers: leave })(AT);
  assert.equal(positive.result.eligibility.eligible, true);
});

test("a failed older-balance read is unknown, not $0: no amount even when Riley left the account out; a good read recovers", async () => {
  const wallet = { account_key: "demo-wallet", institution: "Demo Pay", account_name: "Wallet", account_type: "Cash", mask: "0002" };
  const overdraft = { account_key: "demo-wallet", captured_at: new Date(Date.parse(AT) - 90 * 86_400_000).toISOString(), balance_cents: -400_000, currency: "USD", kind: "asset" };
  const leave = [{ key: "safe-to-move", value: { leaveOut: ["demo-wallet"] } }];
  for (const olderRead of ["error", "reject"]) {
    // Left out: the unread balance (here an overdraft) must not become $0 and an eligible amount.
    const failed = await loader({ txns: everyday(AT), accounts: [wallet], balances: [overdraft], drivers: leave, olderRead })(AT, { otherIncome: 6_000 });
    assert.equal(failed.kind, "ok", `${olderRead}: the forecast is still drawn`);
    assert.deepEqual(failed.result.eligibility.reasons.map((r) => [r.code, r.account]), [["balance-unreadable", undefined]], `${olderRead}: no Leave it out on it`);
    assert.equal(failed.result.headlines.safeToMoveCents, null);
    assert.deepEqual(failed.scenario.result.eligibility.reasons.map((r) => r.code), ["balance-unreadable"], "the what-if reads the same inputs");
    assert.equal(failed.scenario.result.headlines.safeToMoveCents, null);
    assert.ok(failed.result.days.length > 0);
    // Not left out: still "could not be read", never "no recent balance".
    const open = await loader({ txns: everyday(AT), accounts: [wallet], balances: [overdraft], olderRead })(AT);
    assert.deepEqual(open.result.eligibility.reasons.map((r) => r.code), ["balance-unreadable"]);
  }
  // Recovery: the same read answering again brings the amount back, with the debt still lowering it.
  const recovered = await loader({ txns: everyday(AT), accounts: [wallet], balances: [overdraft], drivers: leave })(AT);
  assert.equal(recovered.result.eligibility.eligible, true);
  assert.equal(recovered.result.opening.cents, 4_600_000, "the debt is read again");
  assert.equal(typeof recovered.result.headlines.safeToMoveCents, "number");
  // No older read is made (and none can fail) when every cash account has a balance in the 60-day read.
  const inWindow = await loader({ txns: everyday(AT), olderRead: "error" })(AT);
  assert.equal(inWindow.result.eligibility.eligible, true);
});

test("Leave it out on the server: every write is conditional on the version read, and a lost race is reported as a conflict", async () => {
  // A stand-in for pds.finance_plan_drivers that records each query and answers what `answers` says for it.
  function driversDb(answers) {
    const queries = [];
    return {
      queries,
      from(table) {
        assert.equal(table, "finance_plan_drivers");
        const q = { calls: [] };
        queries.push(q);
        const b = new Proxy({}, {
          get: (_, k) => (k === "then" ? (res, rej) => Promise.resolve(answers(q)).then(res, rej) : (...a) => (q.calls.push([k, ...a]), b)),
        });
        return b;
      },
    };
  }
  const kind = (q) => q.calls[0][0];
  const S = loadTs("lib/cash-forecast-server.ts", {
    "server-only": {},
    "@/lib/finance-ledger-server": { serviceClient: () => null, fetchPaged: async () => ({ rows: [], truncated: false }), loadCategoryFixes: async () => ({}) },
  });
  const V = "2030-06-15T16:00:00.000456+00:00";
  // read: the row's updated_at is its version.
  const reading = driversDb(() => ({ data: [{ value: { leaveOut: ["a"] }, updated_at: V }], error: null }));
  assert.deepEqual(await S.leaveOutStore(reading).read(), { ok: true, row: { value: { leaveOut: ["a"] }, version: V } });
  assert.deepEqual(reading.queries[0].calls, [["select", "value,updated_at"], ["eq", "key", "safe-to-move"]]);
  assert.deepEqual(await S.leaveOutStore(driversDb(() => ({ data: [], error: null }))).read(), { ok: true, row: null });
  assert.deepEqual(await S.leaveOutStore(driversDb(() => ({ data: null, error: { code: "57014" } }))).read(), { ok: false });
  assert.deepEqual(await S.leaveOutStore(driversDb(() => ({ data: [{ value: {}, updated_at: null }], error: null }))).read(), { ok: false }, "no version, no write");
  // update / remove: WHERE key AND updated_at = the version read; no row matched = a conflict, nothing written.
  for (const [method, args] of [["update", [V, { leaveOut: ["a", "b"] }]], ["remove", [V]]]) {
    const matched = driversDb(() => ({ data: [{ key: "safe-to-move" }], error: null }));
    assert.equal(await S.leaveOutStore(matched)[method](...args), "ok", method);
    const calls = matched.queries[0].calls;
    assert.equal(kind(matched.queries[0]), method === "update" ? "update" : "delete");
    assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "key" && c[2] === "safe-to-move"), `${method} names the key`);
    assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "updated_at" && c[2] === V), `${method} is conditional on the version read`);
    if (method === "update") assert.ok(calls[0][1].updated_at > "2030-06-15T16:00:00.000456", "the new version is later than the one read");
    assert.equal(await S.leaveOutStore(driversDb(() => ({ data: [], error: null })))[method](...args), "conflict", `${method}: lost the race`);
    assert.equal(await S.leaveOutStore(driversDb(() => ({ data: null, error: { code: "57014" } })))[method](...args), "error");
  }
  // insert: a row that appeared since the read (primary key) is a conflict, any other error an error.
  const inserted = driversDb(() => ({ data: null, error: null }));
  assert.equal(await S.leaveOutStore(inserted).insert({ leaveOut: ["a"] }), "ok");
  assert.equal(kind(inserted.queries[0]), "insert");
  assert.equal(inserted.queries[0].calls[0][1].key, "safe-to-move");
  assert.equal(await S.leaveOutStore(driversDb(() => ({ data: null, error: { code: "23505" } }))).insert({ leaveOut: ["a"] }), "conflict");
  assert.equal(await S.leaveOutStore(driversDb(() => ({ data: null, error: { code: "57014" } }))).insert({ leaveOut: ["a"] }), "error");
  // End to end over the stand-in: a second tab's change lands between this read and this write; both survive.
  let row = { value: { leaveOut: ["a"] }, updated_at: "v0" };
  let raced = false;
  const live = driversDb((q) => {
    const eq = (col) => q.calls.find((c) => c[0] === "eq" && c[1] === col)?.[2];
    if (kind(q) === "select") return { data: row ? [row] : [], error: null };
    if (!raced) {
      raced = true;
      row = { value: { leaveOut: ["a", "c"] }, updated_at: "v1" };
    }
    if (kind(q) === "update") {
      if (!row || eq("updated_at") !== row.updated_at) return { data: [], error: null };
      row = { value: q.calls[0][1].value, updated_at: q.calls[0][1].updated_at };
      return { data: [{ key: "safe-to-move" }], error: null };
    }
    throw new Error(`unexpected ${kind(q)}`);
  });
  const Store = loadTs("lib/cash-forecast-store.ts");
  assert.deepEqual(await Store.applyLeaveOut(S.leaveOutStore(live), "b", true), { ok: true });
  assert.deepEqual([...row.value.leaveOut].sort(), ["a", "b", "c"], "the other tab's choice is kept");
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
