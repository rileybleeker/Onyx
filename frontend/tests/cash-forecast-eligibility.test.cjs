// Run: node --test tests/cash-forecast-eligibility.test.cjs
// The safe-to-move gate of the cash forecast (lib/cash-forecast.ts `eligibility`, read through
// lib/cash-forecast-eligibility.ts): an actionable amount only from complete, fresh, readable inputs; a missing,
// stale or unreadable balance, a truncated history read, a failed plan read or too little history withholds it
// while the projection stays drawn as an estimate. The forecast tile, the what-if comparison and Today read the
// same result. SYNTHETIC DATA ONLY: every account, merchant, amount and date below is invented. No network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const F = loadTs("lib/cash-forecast.ts");
const E = loadTs("lib/cash-forecast-eligibility.ts");
const A = loadTs("lib/finance-alerts.ts");
const C = loadTs("lib/cash-forecast-config.ts");
const R = loadTs("lib/procurement-recurring.ts");

const TODAY = "2030-06-15";
const NOW = new Date("2030-06-15T16:00:00Z"); // noon ET
const HOUR = 3_600_000;
const ago = (h) => new Date(NOW.getTime() - h * HOUR).toISOString();

const ACCOUNTS = [
  { account_key: "chk", account_type: "Cash", label: "Demo Checking" },
  { account_key: "sav", account_type: "Cash", label: "Demo Savings" },
  { account_key: "card", account_type: "Credit Card", label: "Demo Card" },
];
const bal = (account_key, cents, at = ago(2), over = {}) => ({ account_key, captured_at: at, balance_cents: cents, currency: "USD", kind: account_key === "card" ? "liability" : "asset", ...over });
const FRESH = [bal("chk", 400_000), bal("sav", 900_000), bal("card", 50_000)];
const tx = (account_key, txn_date, amount_cents, name, category = "Shopping") => ({ account_key, txn_date, amount_cents, name, custom_name: null, currency: "USD", category, ignored_from: null });
const WORDS = ["ALDER", "BIRCH", "CEDAR", "DOGWOOD", "ELM", "FIR", "GINKGO", "HAZEL", "IVY", "JUNIPER", "KAPOK", "LARCH", "MAPLE", "NUTMEG", "OAK", "PINE", "QUINCE", "ROWAN", "SPRUCE", "TEAK"];
/** A month-end paycheck and two everyday debits a week, for `weeks` weeks. */
function world(weeks = 20) {
  const out = [];
  for (const m of ["2030-01", "2030-02", "2030-03", "2030-04", "2030-05"]) out.push(tx("chk", F.lastBusinessDayOfMonth(Number(m.slice(0, 4)), Number(m.slice(5, 7))), -600_000, "DEMO EMPLOYER PAYROLL", "Paycheck"));
  for (let w = 0; w < weeks; w++) {
    const d = R.addDays(TODAY, -7 * w - 1);
    out.push(tx("chk", d, 4_000 + (w % 3) * 1_000, `${WORDS[w % WORDS.length]} SHOP`), tx("chk", R.addDays(d, -2), 6_000, `${WORDS[w % WORDS.length]} DINER`));
  }
  return out;
}
const run = (over = {}) => F.forecastCash({ today: TODAY, now: NOW, accounts: ACCOUNTS, txns: world(), balances: FRESH, settings: { paths: 60, bufferCents: 50_000 }, ...over });
const codes = (r) => r.eligibility.reasons.map((x) => x.code);
const gate = (e) => ({ eligible: e.eligible, reasons: e.reasons });

// ─── complete and fresh: the amount, with unchanged arithmetic ──────────────────────────────────
test("complete fresh inputs: eligible, and safe to move is the same arithmetic as before the gate", () => {
  const out = run();
  assert.equal(out.state, "ok");
  assert.deepEqual(gate(out.eligibility), { eligible: true, reasons: [] });
  // The check holds until the oldest counted balance (2 h old) turns 48 hours old; that balance is the "as of" time.
  assert.equal(out.eligibility.validUntil, new Date(NOW.getTime() + 46 * HOUR).toISOString());
  assert.equal(out.eligibility.cashAsOf, ago(2));
  assert.equal("leftOut" in out.eligibility, false);
  const expected = Math.max(0, Math.min(out.opening.cents, out.headlines.lowest.cents) - 50_000);
  assert.equal(out.headlines.safeToMoveCents, expected);
  assert.equal(E.safeToMoveOf(out), expected);
  assert.equal(F.safeToMoveOf(out), expected, "the engine re-exports the same reader");
  // Explicit "everything was read" is the same input as no quality at all.
  const explicit = run({ quality: { historyTruncated: false, planUnavailable: false } });
  assert.deepEqual(explicit.days, out.days);
  assert.deepEqual(explicit.headlines, out.headlines);
  assert.deepEqual(explicit.warnings, out.warnings);
});

// ─── stale, missing, invalid balances ───────────────────────────────────────────────────────────
test("a stale cash balance withholds the amount; the projection is still drawn as an estimate", () => {
  const fresh = run();
  const stale = run({ balances: [bal("chk", 400_000, ago(49)), bal("sav", 900_000), bal("card", 50_000)] });
  assert.equal(stale.state, "ok");
  assert.equal(stale.eligibility.eligible, false);
  assert.deepEqual(codes(stale), ["stale-balance"]);
  assert.match(stale.eligibility.reasons[0].text, /Demo Checking/);
  assert.equal(stale.eligibility.reasons[0].account, "chk", "the reason names the account it is about");
  assert.doesNotMatch(stale.eligibility.reasons[0].text, /\$|\d{4,}/, "a reason never carries an amount");
  assert.equal(stale.headlines.safeToMoveCents, null);
  assert.equal(E.safeToMoveOf(stale), null);
  assert.equal(stale.opening.stale, true);
  assert.deepEqual(stale.days, fresh.days, "the estimate itself is unchanged");
  assert.deepEqual(stale.headlines.lowest, fresh.headlines.lowest);
  assert.ok(stale.warnings.some((w) => /older than 48 hours/.test(w)));
});

test("boundaries: exactly 48 hours is fresh, 48 hours and a minute is stale, whatever the balance's size", () => {
  assert.equal(C.FORECAST.staleBalanceHours, 48);
  assert.equal(run({ balances: [bal("chk", 400_000, ago(48)), bal("sav", 900_000)] }).eligibility.eligible, true);
  const justOver = new Date(NOW.getTime() - 48 * HOUR - 60_000).toISOString();
  assert.deepEqual(codes(run({ balances: [bal("chk", 400_000, justOver), bal("sav", 900_000)] })), ["stale-balance"]);
  const small = C.FORECAST.smallBalanceCents;
  for (const cents of [0, 1, small - 1, small, -1, -(small - 1), -small]) {
    assert.deepEqual(codes(run({ balances: [bal("chk", 400_000), bal("sav", cents, ago(24 * 10))] })), ["stale-balance"], `an old balance of ${cents} cents withholds the amount`);
  }
  // The projection's stale badge still ignores a small one (an account that rarely updates); only the amount is gated.
  assert.equal(run({ balances: [bal("chk", 400_000), bal("sav", small - 1, ago(24 * 10))] }).opening.stale, false);
  assert.equal(run({ balances: [bal("chk", 400_000), bal("sav", small, ago(24 * 10))] }).opening.stale, true);
});

test("a pool account with no balance withholds the amount (counted as $0 in the estimate)", () => {
  const out = run({ balances: [bal("chk", 400_000), bal("card", 50_000)] });
  assert.equal(out.state, "ok");
  assert.deepEqual(codes(out), ["missing-balance"]);
  assert.equal(out.eligibility.reasons[0].text, "No recent balance for Demo Savings.");
  assert.equal(out.eligibility.reasons[0].account, "sav");
  assert.equal(out.opening.cents, 400_000);
  assert.equal(out.headlines.safeToMoveCents, null);
  assert.ok(out.warnings.includes("No balance for Demo Savings: counted as $0."));
});

test("invalid balances withhold the amount: another currency only, no readable date, dated in the future", () => {
  const eur = run({ balances: [bal("chk", 400_000), bal("sav", 900_000, ago(2), { currency: "EUR" })] });
  assert.deepEqual(codes(eur), ["invalid-balance"]);
  assert.match(eur.eligibility.reasons[0].text, /Demo Savings.*US-dollar/);
  assert.equal(eur.opening.cents, 400_000, "never mixed into the USD total");
  const undated = run({ balances: [bal("chk", 400_000), bal("sav", 900_000, "not a time")] });
  assert.deepEqual(codes(undated), ["invalid-balance"]);
  assert.equal(undated.headlines.safeToMoveCents, null);
  const future = run({ balances: [bal("chk", 400_000), bal("sav", 900_000, new Date(NOW.getTime() + 2 * HOUR).toISOString())] });
  assert.deepEqual(codes(future), ["invalid-balance"]);
  // Inside the clock-skew allowance it is still a valid, fresh balance.
  assert.equal(run({ balances: [bal("chk", 400_000), bal("sav", 900_000, new Date(NOW.getTime() + 30 * 60_000).toISOString())] }).eligibility.eligible, true);
  const nan = run({ balances: [bal("chk", 400_000), bal("sav", Number.NaN)] });
  assert.deepEqual(codes(nan), ["invalid-balance"]);
  assert.ok(Number.isFinite(nan.opening.cents), "a bad amount never poisons the estimate");
});

test("the newest snapshot decides in any currency: a newer row in another currency withholds a fresh older US-dollar one", () => {
  // Savings: a fresh US-dollar balance 3 h old, then a newer one 1 h old in another currency.
  const newerEur = run({ balances: [bal("chk", 400_000), bal("sav", 900_000, ago(3)), bal("sav", 800_000, ago(1), { currency: "EUR" }), bal("card", 50_000)] });
  assert.equal(newerEur.state, "ok");
  assert.equal(newerEur.eligibility.eligible, false);
  assert.deepEqual(codes(newerEur), ["invalid-balance"]);
  assert.match(newerEur.eligibility.reasons[0].text, /Demo Savings.*US-dollar/);
  assert.equal(newerEur.eligibility.reasons[0].account, "sav", "Leave it out can clear it, like any unusable balance");
  assert.equal(newerEur.headlines.safeToMoveCents, null);
  assert.equal(E.safeToMoveOf(newerEur), null);
  assert.equal(newerEur.opening.cents, 1_300_000, "the estimate keeps the last US-dollar balance; the other currency is never mixed in");
  assert.ok(newerEur.warnings.some((w) => /Demo Savings.*not in US dollars/.test(w)));
  assert.equal(newerEur.eligibility.cashAsOf, ago(2), "the withheld balance is not one the amount counts");
  // A row in another currency with a date that cannot be compared: not known to be older, so withheld too.
  const undatedEur = run({ balances: [bal("chk", 400_000), bal("sav", 900_000), bal("sav", 800_000, "not a time", { currency: "EUR" })] });
  assert.deepEqual(codes(undatedEur), ["invalid-balance"]);
  // An OLDER row in another currency changes nothing: the newest snapshot is the fresh US-dollar one.
  const olderEur = run({ balances: [bal("chk", 400_000), bal("sav", 900_000), bal("sav", 800_000, ago(30), { currency: "EUR" }), bal("card", 50_000)] });
  assert.deepEqual(gate(olderEur.eligibility), { eligible: true, reasons: [] });
  assert.equal(olderEur.headlines.safeToMoveCents, run().headlines.safeToMoveCents);
  // Recovery: the next US-dollar snapshot is newest again and the amount comes back.
  const next = run({ balances: [bal("chk", 400_000), bal("sav", 800_000, ago(4), { currency: "EUR" }), bal("sav", 900_000, ago(2)), bal("card", 50_000)] });
  assert.equal(next.eligibility.eligible, true);
  // Riley leaving the account out clears the reason (his explicit choice), as for every other balance reason.
  const left = run({ balances: [bal("chk", 400_000), bal("sav", 900_000, ago(3)), bal("sav", 800_000, ago(1), { currency: "EUR" }), bal("card", 50_000)], settings: { paths: 60, bufferCents: 50_000, safeToMoveLeaveOut: ["sav"] } });
  assert.equal(left.eligibility.eligible, true);
  assert.deepEqual(left.eligibility.leftOut, [{ account: "sav", label: "Demo Savings", asOf: ago(3), why: "chosen" }]);
});

test("a debt in another currency, or a balance with no usable amount, withholds the amount even when Riley left the account out", () => {
  const leave = { paths: 60, bufferCents: 50_000, safeToMoveLeaveOut: ["sav"] };
  const why = (r) => r.eligibility.reasons.map((x) => [x.code, x.account]);
  // Only an overdraft in another currency: withheld, with no Leave it out (leaving it out would count the debt as $0).
  const eurDebt = [bal("chk", 400_000), bal("sav", -50_000, ago(2), { currency: "EUR" })];
  const open = run({ balances: eurDebt });
  assert.deepEqual(why(open), [["invalid-balance", undefined]]);
  assert.match(open.eligibility.reasons[0].text, /Demo Savings is a debt in another currency/);
  assert.equal(open.headlines.safeToMoveCents, null);
  assert.deepEqual(E.safeToMoveTile(open, 50_000).reasons.map((r) => r.account), [undefined], "the tile offers no Leave it out for it");
  const left = run({ balances: eurDebt, settings: leave });
  assert.equal(left.eligibility.eligible, false);
  assert.deepEqual(why(left), [["invalid-balance", undefined]]);
  assert.equal(left.headlines.safeToMoveCents, null);
  assert.equal(E.safeToMoveOf(JSON.parse(JSON.stringify(left))), null, "also when stored");
  assert.deepEqual(left.eligibility.leftOut.map((l) => [l.account, l.why]), [["sav", "chosen"]], "still named as left out, and can be counted again");
  // A balance owed (liability, stored as its size) in another currency is a debt too.
  const owed = run({ balances: [bal("chk", 400_000), bal("sav", 30_000, ago(2), { currency: "EUR", kind: "liability" })], settings: leave });
  assert.deepEqual(why(owed), [["invalid-balance", undefined]]);
  // A debt in another currency NEWER than a fresh US-dollar balance: the newest snapshot decides, left out or not.
  const newerRows = [bal("chk", 400_000), bal("sav", 900_000, ago(3)), bal("sav", -80_000, ago(1), { currency: "EUR" }), bal("card", 50_000)];
  const newer = run({ balances: newerRows, settings: leave });
  assert.deepEqual(why(newer), [["invalid-balance", undefined]]);
  assert.equal(newer.headlines.safeToMoveCents, null);
  const newerOpen = run({ balances: newerRows });
  assert.deepEqual(why(newerOpen), [["invalid-balance", undefined]], "one reason, no Leave it out that could not clear it");
  assert.equal(newerOpen.opening.cents, 1_300_000, "the estimate keeps the last US-dollar balance");
  // A debt row whose date cannot be compared may be the current one: withheld too.
  assert.equal(run({ balances: [bal("chk", 400_000), bal("sav", 900_000), bal("sav", -80_000, "not a time", { currency: "EUR" })], settings: leave }).eligibility.eligible, false);
  // No usable amount: it could be a debt, so the same.
  const nan = run({ balances: [bal("chk", 400_000), bal("sav", Number.NaN)], settings: leave });
  assert.deepEqual(why(nan), [["invalid-balance", undefined]]);
  assert.match(nan.eligibility.reasons[0].text, /balance record for Demo Savings could not be read \(no usable amount or date\), so it could be a debt/);
  // A debt OLDER than the US-dollar balance changes nothing; a positive balance in another currency can be left out.
  const older = run({ balances: [bal("chk", 400_000), bal("sav", 900_000, ago(3)), bal("sav", -80_000, ago(30), { currency: "EUR" }), bal("card", 50_000)] });
  assert.deepEqual(gate(older.eligibility), { eligible: true, reasons: [] });
  assert.equal(run({ balances: [bal("chk", 400_000), bal("sav", 900_000, ago(2), { currency: "EUR" })], settings: leave }).eligibility.eligible, true);
  // Recovery: a newer US-dollar snapshot is the current one again; left out, the amount comes back.
  const next = run({ balances: [...eurDebt, bal("sav", 20_000, ago(1))], settings: leave });
  assert.equal(next.eligibility.eligible, true);
  assert.equal(typeof next.headlines.safeToMoveCents, "number");
});

test("a NEWER balance row with no usable amount withholds the amount, left out or not; the estimate keeps the last usable one", () => {
  const leave = { paths: 60, bufferCents: 50_000, safeToMoveLeaveOut: ["sav"] };
  const why = (r) => r.eligibility.reasons.map((x) => [x.code, x.account]);
  // Savings: a fresh usable balance 3 h old, then a newer row 1 h old the loader could not read an amount from.
  const rows = [bal("chk", 400_000), bal("sav", 900_000, ago(3)), bal("sav", Number.NaN, ago(1)), bal("card", 50_000)];
  for (const settings of [undefined, leave]) {
    const out = run({ balances: rows, ...(settings ? { settings } : {}) });
    assert.equal(out.state, "ok");
    assert.equal(out.eligibility.eligible, false, `left out: ${!!settings}`);
    assert.deepEqual(why(out), [["invalid-balance", undefined]], "no Leave it out: it could be a debt");
    assert.match(out.eligibility.reasons[0].text, /balance record for Demo Savings could not be read \(no usable amount or date\), so it could be a debt/);
    assert.equal(out.headlines.safeToMoveCents, null);
    assert.equal(E.safeToMoveOf(JSON.parse(JSON.stringify(out))), null, "also when stored");
    assert.equal(out.opening.cents, 1_300_000, "the estimate starts from the last usable balance, never NaN or $0");
  }
  assert.ok(run({ balances: rows }).warnings.some((w) => /Demo Savings has no usable amount: the estimate uses its last usable balance/.test(w)));
  // A row with no usable amount AND no date may be the current one: withheld too.
  assert.deepEqual(why(run({ balances: [bal("chk", 400_000), bal("sav", 900_000), bal("sav", Number.NaN, "")], settings: leave })), [["invalid-balance", undefined]]);
  // An OLDER unusable row changes nothing: the newest snapshot is the usable one.
  const older = run({ balances: [bal("chk", 400_000), bal("sav", Number.NaN, ago(30)), bal("sav", 900_000), bal("card", 50_000)] });
  assert.deepEqual(gate(older.eligibility), { eligible: true, reasons: [] });
  assert.equal(older.headlines.safeToMoveCents, run().headlines.safeToMoveCents);
  // A card whose only row is unusable: never NaN in the card or net worth projection.
  const card = run({ balances: [bal("chk", 400_000), bal("sav", 900_000), bal("card", Number.NaN)] });
  assert.ok(card.netWorth.every((p) => Object.values(p).every((v) => typeof v !== "number" || Number.isFinite(v))), "no NaN in net worth");
});

test("reads the loader reports as incomplete: a capped plan or category read and an unmatched balance row each withhold the amount", () => {
  const fresh = run();
  const plan = run({ quality: { planTruncated: true } });
  assert.deepEqual(codes(plan), ["plan-unavailable"]);
  assert.match(plan.eligibility.reasons[0].text, /Not all planned items or plan settings were read/);
  assert.equal(plan.headlines.safeToMoveCents, null);
  assert.deepEqual(plan.days, fresh.days, "the estimate stays");
  const cats = run({ quality: { categoriesTruncated: true } });
  assert.deepEqual(codes(cats), ["categories-unavailable"]);
  assert.match(cats.eligibility.reasons[0].text, /Not all of your category fixes were read/);
  assert.equal(cats.headlines.safeToMoveCents, null);
  // A balance row matched to no account could be any pool account's newest: withheld, even with every pool account left out.
  const everyLeft = { paths: 60, bufferCents: 50_000, safeToMoveLeaveOut: ["chk", "sav"] };
  for (const settings of [undefined, everyLeft]) {
    const out = run({ quality: { balanceRowsUnmatched: 1 }, ...(settings ? { settings } : {}) });
    assert.deepEqual(out.eligibility.reasons.map((r) => [r.code, r.account]), [["invalid-balance", undefined]]);
    assert.equal(out.headlines.safeToMoveCents, null);
  }
  assert.deepEqual(gate(run({ quality: { planTruncated: false, categoriesTruncated: false, balanceRowsUnmatched: 0 } }).eligibility), { eligible: true, reasons: [] }, "nothing missing, nothing withheld");
  // Known codes: a stored copy is read back with the same reasons.
  assert.deepEqual(E.eligibilityOf(JSON.parse(JSON.stringify(plan))).reasons, plan.eligibility.reasons);
});

test("two pool accounts with the same label each keep their own reason and Leave it out", () => {
  const twins = [...ACCOUNTS, { account_key: "sav2", account_type: "Cash", label: "Demo Savings" }];
  const out = run({ accounts: twins, balances: [bal("chk", 400_000), bal("sav", 900_000, ago(60)), bal("sav2", 10_000, ago(60))] });
  assert.deepEqual(out.eligibility.reasons.map((r) => [r.code, r.account]), [["stale-balance", "sav"], ["stale-balance", "sav2"]]);
  // A reason with no account is still listed once.
  assert.equal(run({ accounts: twins, balances: [bal("chk", 400_000), bal("sav", 900_000), bal("sav2", 10_000)], quality: { historyTruncated: true } }).eligibility.reasons.length, 1);
});

test("without a clock the freshness cannot be verified; a backtest opening needs no balance rows", () => {
  const noClock = run({ now: undefined });
  assert.deepEqual(codes(noClock), ["freshness-unknown"]);
  assert.equal(noClock.headlines.safeToMoveCents, null);
  const backtest = F.forecastCash({ today: TODAY, accounts: ACCOUNTS, txns: world(), balances: [], settings: { paths: 60, openingOverride: { cents: 800_000, asOf: TODAY } } });
  assert.deepEqual(backtest.eligibility, { eligible: true, reasons: [] }, "no balance checked: no expiry, nothing left out");
});

// ─── reads the caller reports, and too little history ───────────────────────────────────────────
test("a truncated history read and a failed plan read each withhold the amount; the estimate stays", () => {
  const fresh = run();
  const truncated = run({ quality: { historyTruncated: true } });
  assert.deepEqual(codes(truncated), ["history-truncated"]);
  assert.equal(truncated.headlines.safeToMoveCents, null);
  assert.equal(truncated.warnings.filter((w) => /page limit/.test(w)).length, 1, "the warning once, from the engine");
  assert.deepEqual(truncated.days, fresh.days);
  const noPlan = run({ quality: { planUnavailable: true } });
  assert.deepEqual(codes(noPlan), ["plan-unavailable"]);
  assert.match(noPlan.eligibility.reasons[0].text, /planned payments and taxes may be missing/);
  assert.equal(noPlan.headlines.safeToMoveCents, null);
  const both = run({ quality: { historyTruncated: true, planUnavailable: true }, balances: [bal("chk", 400_000, ago(72)), bal("sav", 900_000)] });
  assert.deepEqual(codes(both).sort(), ["history-truncated", "plan-unavailable", "stale-balance"]);
  // A saved tax profile or move plan that no longer parses: its taxes or move costs are missing, so no amount.
  const invalid = run({ quality: { planInvalid: true } });
  assert.deepEqual(codes(invalid), ["plan-invalid"]);
  assert.match(invalid.eligibility.reasons[0].text, /tax profile or move plan could not be read/);
  assert.equal(invalid.headlines.safeToMoveCents, null);
  assert.deepEqual(invalid.days, fresh.days);
  assert.deepEqual(E.eligibilityOf(JSON.parse(JSON.stringify(invalid))).reasons.map((r) => r.code), ["plan-invalid"], "a known code");
});

test("fewer than the minimum weeks of history: everyday spending is not projected, so no amount", () => {
  const short = run({ txns: world(2).filter((t) => t.txn_date >= R.addDays(TODAY, -15)) });
  assert.equal(short.baseline.projected, false);
  assert.deepEqual(codes(short), ["short-history"]);
  assert.equal(short.headlines.safeToMoveCents, null);
});

test("an input that is not a number withholds the amount instead of showing a broken one", () => {
  const out = run({ settings: { paths: 60, bufferCents: 50_000, inflationPct: Number.NaN } });
  assert.deepEqual(codes(out), ["invalid-input"]);
  assert.equal(out.headlines.safeToMoveCents, null);
  const badOpening = F.forecastCash({ today: TODAY, accounts: ACCOUNTS, txns: world(), balances: [], settings: { paths: 60, openingOverride: { cents: Number.NaN, asOf: TODAY } } });
  assert.deepEqual(codes(badOpening), ["invalid-input"]);
  assert.equal(E.safeToMoveOf(badOpening), null);
});

test("no pool and no balance: not eligible, with the reason, and no amount", () => {
  const noPool = F.forecastCash({ today: TODAY, now: NOW, accounts: ACCOUNTS.filter((a) => a.account_type !== "Cash"), txns: [], balances: [] });
  assert.equal(noPool.state, "no-pool");
  assert.deepEqual(codes(noPool), ["no-pool"]);
  assert.equal(noPool.headlines.safeToMoveCents, null);
  const noBal = F.forecastCash({ today: TODAY, now: NOW, accounts: ACCOUNTS, txns: [], balances: [], quality: { planUnavailable: true } });
  assert.equal(noBal.state, "no-balance");
  assert.deepEqual(codes(noBal).sort(), ["missing-balance", "missing-balance", "no-balance", "plan-unavailable"], "one per pool account");
  assert.equal(E.safeToMoveOf(noBal), null);
});

test("recovery: the next sync's fresh balance and a later successful plan read bring the amount back", () => {
  const stale = run({ balances: [bal("chk", 400_000, ago(60)), bal("sav", 900_000)], quality: { planUnavailable: true } });
  assert.equal(stale.headlines.safeToMoveCents, null);
  const synced = run({ balances: [bal("chk", 400_000, ago(60)), bal("chk", 400_000, ago(1)), bal("sav", 900_000)] });
  assert.equal(synced.eligibility.eligible, true, "the newest snapshot per account is the one checked");
  assert.equal(synced.headlines.safeToMoveCents, run().headlines.safeToMoveCents);
});

// ─── stored results and the readers ─────────────────────────────────────────────────────────────
test("stored results: the gate survives JSON; a body from older code is never eligible", () => {
  const stale = run({ balances: [bal("chk", 400_000, ago(60)), bal("sav", 900_000)] });
  const back = JSON.parse(JSON.stringify(stale));
  assert.deepEqual(E.eligibilityOf(back), stale.eligibility);
  assert.equal(E.safeToMoveOf(back), null);
  const ok = JSON.parse(JSON.stringify(run()));
  assert.equal(E.safeToMoveOf(ok), run().headlines.safeToMoveCents);
  // A forecast stored before the gate existed: a number with no eligibility.
  const old = { ...ok, eligibility: undefined, headlines: { ...ok.headlines, safeToMoveCents: 123_400 } };
  assert.equal(E.eligibilityOf(old).eligible, false);
  assert.deepEqual(E.eligibilityOf(old).reasons.map((r) => r.code), ["unverified"]);
  assert.equal(E.safeToMoveOf(old), null);
  assert.equal(E.safeToMoveOf({ ...ok, eligibility: { eligible: true, reasons: [{ code: "made-up", text: "x" }] } }), null, "an unknown reason code");
  assert.equal(E.safeToMoveOf({ ...ok, eligibility: { eligible: true, reasons: [] }, headlines: { ...ok.headlines, safeToMoveCents: Number.NaN } }), null);
  assert.equal(E.eligibilityOf(null).eligible, false);
  // The reader hands out copies: changing one never changes the next answer.
  E.eligibilityOf(old).reasons.push({ code: "unverified", text: "mutated" });
  assert.equal(E.eligibilityOf(old).reasons.length, 1);
});

test("tile: the amount with the buffer and the balance time, or the reasons in its place", () => {
  const amount = E.safeToMoveTile(run(), 50_000);
  assert.equal(amount.kind, "amount");
  assert.equal(amount.cents, run().headlines.safeToMoveCents);
  assert.equal(amount.perWeekCents, amount.cents > 0 ? Math.floor(amount.cents / 13) : null);
  assert.deepEqual([amount.bufferCents, amount.bufferSet], [50_000, true]);
  assert.match(amount.asOf, /^Jun 15, \d{1,2}:\d{2}\s?[AP]M ET$/);
  const noBuffer = E.safeToMoveTile(run({ settings: { paths: 60 } }), 0);
  assert.deepEqual([noBuffer.kind, noBuffer.bufferSet], ["amount", false]);
  const withheld = E.safeToMoveTile(run({ balances: [bal("chk", 400_000, ago(60)), bal("sav", 900_000, ago(60))], quality: { historyTruncated: true, planUnavailable: true } }), 50_000);
  assert.equal(withheld.kind, "unavailable");
  assert.equal(withheld.reasons.length, 3, "three reasons in the tile");
  assert.equal(withheld.more.length, 1, "the rest are folded, never dropped");
  assert.ok([...withheld.reasons, ...withheld.more].every((r) => typeof r.text === "string"));
  assert.deepEqual([...withheld.reasons, ...withheld.more].filter((r) => r.account).map((r) => r.account).sort(), ["chk", "sav"], "balance reasons carry their account");
  assert.ok(withheld.asOf, "the balance time is still shown");
  assert.equal("cents" in withheld, false, "no amount at all when withheld");
  assert.equal(E.safeToMoveTile({ headlines: { safeToMoveCents: 5_000 }, opening: { asOf: null } }, 0).kind, "unavailable", "no eligibility = no amount");
  assert.equal(E.cashAsOfLabel("2030-06-15"), "Jun 15");
  assert.equal(E.cashAsOfLabel("garbage"), null);
  assert.equal(E.cashAsOfLabel(null), null);
});

test("Today reads the same gate: cashForecastCheck mirrors the forecast's eligibility", () => {
  assert.equal(A.cashForecastCheck(null), null);
  assert.deepEqual(A.cashForecastCheck(run()), { eligible: true, reasons: [], validUntil: run().eligibility.validUntil });
  const stale = run({ balances: [bal("chk", 400_000, ago(60)), bal("sav", 900_000)], quality: { planUnavailable: true } });
  const check = A.cashForecastCheck(stale);
  assert.equal(check.eligible, false);
  assert.deepEqual(check.reasons, stale.eligibility.reasons.map((r) => r.text));
  assert.deepEqual(A.cashForecastCheck(JSON.parse(JSON.stringify(stale))), check, "the stored copy gives the same check");
  assert.equal(A.cashForecastCheck({ ...run(), eligibility: undefined }).eligible, false, "an older stored forecast is not an all-clear");
});

test("the low-cash alert counts the same cash as the amount: an account Riley left out cannot hide it", () => {
  const leave = { paths: 60, bufferCents: 50_000, safeToMoveLeaveOut: ["sav"] };
  // Checking under the $500 line; savings stale (the feed stopped) and left out, so the amount is eligible again.
  const rows = [bal("chk", 40_000), bal("sav", 900_000, ago(24 * 30))];
  const out = run({ balances: rows, settings: leave });
  assert.equal(out.eligibility.eligible, true);
  assert.equal(out.eligibility.leftOutCents, 900_000);
  assert.equal(out.headlines.safeToMoveCents, 0);
  // The projection still counts the savings balance, so on its own it never comes near the line...
  assert.ok(Math.min(...out.days.slice(0, 30).map((d) => d.low)) > 50_000);
  // ...but the alert takes it out, the way the amount does, and says so.
  const alert = A.moneyAlerts(out, null, 50_000, TODAY).find((a) => a.kind === "low-cash");
  assert.ok(alert, "Today is not told there is nothing to act on");
  assert.match(alert.detail, /not counting the accounts you left out/);
  assert.deepEqual(A.moneyAlerts(JSON.parse(JSON.stringify(out)), null, 50_000, TODAY), A.moneyAlerts(out, null, 50_000, TODAY), "the same from a stored result");
  // Counted (a fresh savings balance, not left out): no low-cash alert, and no left-out total.
  const counted = run({ balances: [bal("chk", 40_000), bal("sav", 900_000)] });
  assert.equal("leftOutCents" in counted.eligibility, false);
  assert.equal(A.moneyAlerts(counted, null, 50_000, TODAY).some((a) => a.kind === "low-cash"), false);
  // An overdraft left out keeps lowering both (only a positive balance is taken out).
  assert.equal(run({ balances: [bal("chk", 400_000), bal("sav", -30_000, ago(24 * 30))], settings: leave }).eligibility.leftOutCents, 0);
  // A stored check with left-out accounts but no (or a malformed) total is never eligible.
  const stored = JSON.parse(JSON.stringify(out));
  const { leftOutCents: _drop, ...noTotal } = stored.eligibility;
  assert.equal(E.eligibilityOf({ ...stored, eligibility: noTotal }).reasons[0].code, "unverified");
  assert.equal(E.eligibilityOf({ ...stored, eligibility: { ...stored.eligibility, leftOutCents: -1 } }).reasons[0].code, "unverified");
  assert.equal(E.eligibilityOf(stored).leftOutCents, 900_000);
});

// ─── stale small balances, accounts Riley leaves out, unreadable balances, a check that stops holding ──
test("an old zero, small or overdrawn balance withholds the amount until Riley leaves the account out", () => {
  const small = C.FORECAST.smallBalanceCents - 1;
  const leave = { paths: 60, bufferCents: 50_000, safeToMoveLeaveOut: ["sav"] };
  for (const cents of [0, small, -small]) {
    const old = run({ balances: [bal("chk", 400_000), bal("sav", cents, ago(24 * 10))] });
    assert.equal(old.eligibility.eligible, false, `${cents}: an old balance is no proof the account is not overdrawn now`);
    assert.deepEqual(old.eligibility.reasons.map((r) => [r.code, r.account]), [["stale-balance", "sav"]], "offers Leave it out");
    assert.equal(old.headlines.safeToMoveCents, null);
    assert.equal("leftOut" in old.eligibility, false, "nothing is left out automatically");
    const tile = E.safeToMoveTile(old, 50_000);
    assert.equal(tile.kind, "unavailable");
    assert.deepEqual(tile.leftOut, []);
    assert.match(tile.asOf, /^Jun 15,/, "dated by the balances it would count, never by the old one");
    // Riley's explicit choice narrows what the amount counts: it comes back, the account is named.
    const chosen = run({ balances: [bal("chk", 400_000), bal("sav", cents, ago(24 * 10))], settings: leave });
    assert.equal(chosen.eligibility.eligible, true, `${cents}: left out`);
    assert.deepEqual(chosen.eligibility.leftOut, [{ account: "sav", label: "Demo Savings", asOf: ago(24 * 10), why: "chosen" }]);
    const fresh = run({ balances: [bal("chk", 400_000), bal("sav", cents)], settings: leave });
    assert.equal(chosen.headlines.safeToMoveCents, fresh.headlines.safeToMoveCents, "only its positive part is taken out; an overdraft keeps lowering it");
    assert.deepEqual(chosen.days, run({ balances: [bal("chk", 400_000), bal("sav", cents, ago(24 * 10))] }).days, "the projection still counts it");
  }
  // A stored result written with an automatic "small" left-out entry is malformed: never eligible.
  const ok = JSON.parse(JSON.stringify(run()));
  assert.equal(E.eligibilityOf({ ...ok, eligibility: { ...ok.eligibility, leftOut: [{ account: "sav", label: "Demo Savings", asOf: ago(240), why: "small" }] } }).reasons[0].code, "unverified");
});

test("a balance read that failed withholds the amount, also when Riley left the account out; a later good read recovers", () => {
  const unread = { balanceUnreadable: ["sav"] };
  // The 60-day read had no row for savings and its older read failed: unknown, not missing.
  const failed = run({ balances: [bal("chk", 400_000)], quality: unread });
  assert.deepEqual(failed.eligibility.reasons.map((r) => [r.code, r.account]), [["balance-unreadable", undefined]], "no Leave it out on this reason");
  assert.match(failed.eligibility.reasons[0].text, /Demo Savings could not be read/);
  assert.equal(failed.headlines.safeToMoveCents, null);
  const tile = E.safeToMoveTile(failed, 50_000);
  assert.equal(tile.kind, "unavailable");
  assert.deepEqual(tile.reasons.map((r) => r.account), [undefined], "the tile offers no Leave it out for it");
  // Left out: the read failure still withholds the amount (an unread balance could be an overdraft).
  const leftOut = run({ balances: [bal("chk", 400_000)], quality: unread, settings: { paths: 60, bufferCents: 50_000, safeToMoveLeaveOut: ["sav"] } });
  assert.equal(leftOut.eligibility.eligible, false);
  assert.deepEqual(codes(leftOut), ["balance-unreadable"]);
  assert.equal(leftOut.headlines.safeToMoveCents, null);
  assert.deepEqual(leftOut.eligibility.leftOut.map((l) => [l.account, l.why]), [["sav", "chosen"]], "still named as left out, and can be counted again");
  // Every pool account it names withholds; one that is not a pool account changes nothing.
  assert.equal(run({ quality: { balanceUnreadable: ["card"] } }).eligibility.eligible, true);
  assert.deepEqual(E.eligibilityOf(JSON.parse(JSON.stringify(failed))).reasons.map((r) => r.code), ["balance-unreadable"], "a known code when stored");
  // Recovery: the next read answers (no failure reported) and the account is left out again: the amount comes back.
  const recovered = run({ balances: [bal("chk", 400_000)], settings: { paths: 60, bufferCents: 50_000, safeToMoveLeaveOut: ["sav"] } });
  assert.equal(recovered.eligibility.eligible, true);
  assert.equal(typeof recovered.headlines.safeToMoveCents, "number");
  // Without the choice it is an ordinary missing balance again, with Leave it out offered.
  assert.deepEqual(run({ balances: [bal("chk", 400_000)] }).eligibility.reasons.map((r) => [r.code, r.account]), [["missing-balance", "sav"]]);
});

test("an account Riley leaves out clears its reason, is not counted in the amount, and can be counted again", () => {
  const leave = (keys) => ({ paths: 60, bufferCents: 50_000, safeToMoveLeaveOut: keys });
  // Stale (a feed that no longer refreshes it): left out, the amount comes back without its balance.
  const stale = run({ balances: [bal("chk", 400_000), bal("sav", 900_000, ago(24 * 30))], settings: leave(["sav"]) });
  assert.equal(stale.eligibility.eligible, true);
  assert.deepEqual(stale.eligibility.leftOut, [{ account: "sav", label: "Demo Savings", asOf: ago(24 * 30), why: "chosen" }]);
  const freshBoth = run({ balances: [bal("chk", 400_000), bal("sav", 900_000)] });
  assert.equal(stale.headlines.safeToMoveCents, Math.max(0, freshBoth.headlines.safeToMoveCents - 900_000));
  assert.equal(stale.eligibility.validUntil, new Date(NOW.getTime() + 46 * HOUR).toISOString(), "only the counted balances set the expiry");
  // No balance at all (a closed account): left out, eligible, named with no date.
  const missing = run({ balances: [bal("chk", 400_000)], settings: leave(["sav"]) });
  assert.equal(missing.eligibility.eligible, true);
  assert.deepEqual(missing.eligibility.leftOut, [{ account: "sav", label: "Demo Savings", asOf: null, why: "chosen" }]);
  const tile = E.safeToMoveTile(missing, 50_000);
  assert.deepEqual(tile.leftOut, [{ account: "sav", text: "Demo Savings is not counted: you left it out.", chosen: true }]);
  // Leaving out nothing changes nothing; a key that is not a pool account changes nothing.
  assert.equal(run({ settings: leave([]) }).headlines.safeToMoveCents, run().headlines.safeToMoveCents);
  assert.equal(run({ settings: leave(["card", "nope"]) }).headlines.safeToMoveCents, run().headlines.safeToMoveCents, "only pool accounts matter");
});

test("a stored result stops being actionable once a counted balance turns 48 hours old", () => {
  const out = JSON.parse(JSON.stringify(run()));
  const until = Date.parse(out.eligibility.validUntil);
  assert.equal(E.eligibilityOf(out, until - 60_000).eligible, true, "a minute before");
  assert.equal(E.safeToMoveOf(out, until - 60_000), out.headlines.safeToMoveCents);
  const at = E.eligibilityOf(out, until);
  assert.equal(at.eligible, false, "at the limit");
  assert.deepEqual(at.reasons, [E.EXPIRED_REASON]);
  assert.equal(E.safeToMoveOf(out, new Date(until + HOUR)), null);
  assert.equal(E.safeToMoveTile(out, 50_000, until + HOUR).kind, "unavailable");
  assert.equal(E.eligibilityOf(out).eligible, true, "without a clock the stored check is read as stored");
  // asOfNow: the same object while it holds; past it, eligibility and the amount agree.
  assert.equal(E.asOfNow(out, until - 1), out);
  const expired = E.asOfNow(out, until + 1);
  assert.notEqual(expired, out);
  assert.equal(expired.headlines.safeToMoveCents, null);
  assert.equal(expired.eligibility.eligible, false);
  assert.equal(E.safeToMoveOf(expired), null, "a reader without a clock agrees");
  assert.equal(typeof out.headlines.safeToMoveCents, "number", "the stored copy itself is not changed");
  // nextExpiry: when a view left open must look again (the earliest expiry still ahead, base plan or what-if).
  assert.equal(E.nextExpiry([out], until - 1), until);
  assert.equal(E.nextExpiry([out, { eligibility: { ...out.eligibility, validUntil: new Date(until - HOUR).toISOString() } }], until - 2 * HOUR), until - HOUR);
  assert.equal(E.nextExpiry([out], until), null, "already passed: nothing to wait for");
  assert.equal(E.nextExpiry([null, undefined, { eligibility: { eligible: false, reasons: [] } }], until), null, "no expiry");
  assert.equal(E.nextExpiry([{ eligibility: { ...out.eligibility, validUntil: "soon" } }], 0), null, "an unreadable one is ignored (it is never eligible anyway)");
  // A malformed expiry, left-out entry or reason account is never eligible.
  assert.equal(E.eligibilityOf({ ...out, eligibility: { ...out.eligibility, validUntil: "soon" } }).eligible, false);
  assert.equal(E.eligibilityOf({ ...out, eligibility: { ...out.eligibility, leftOut: [{ account: "x" }] } }).eligible, false);
  assert.equal(E.eligibilityOf({ ...out, eligibility: { ...out.eligibility, reasons: [{ code: "stale-balance", text: "x", account: 7 }] } }).reasons[0].code, "unverified");
});

test("Today's check expires the same way when it is served (cashCheckAt)", () => {
  const check = A.cashForecastCheck(run());
  const until = Date.parse(check.validUntil);
  assert.deepEqual(A.cashCheckAt(check, new Date(until - 60_000)), { eligible: true, reasons: [] }, "the answer never carries validUntil");
  assert.deepEqual(A.cashCheckAt(check, new Date(until)), { eligible: false, reasons: [E.EXPIRED_REASON.text] });
  const stale = A.cashForecastCheck(run({ balances: [bal("chk", 400_000, ago(60)), bal("sav", 900_000)] }));
  const later = A.cashCheckAt(stale, new Date(Date.parse(stale.validUntil) + 1));
  assert.equal(later.eligible, false);
  assert.equal(later.reasons[0], E.EXPIRED_REASON.text);
  assert.ok(later.reasons.includes(stale.reasons[0]));
  assert.equal(A.cashCheckAt({ eligible: true, reasons: [], validUntil: "junk" }, NOW).eligible, false, "an unreadable expiry is not an all-clear");
  assert.deepEqual(A.cashCheckAt({ eligible: true, reasons: [] }, NOW), { eligible: true, reasons: [] }, "no balance checked: nothing to expire");
});

test("category fixes that could not be read withhold the amount", () => {
  const out = run({ quality: { categoriesUnavailable: true } });
  assert.deepEqual(codes(out), ["categories-unavailable"]);
  assert.equal(out.headlines.safeToMoveCents, null);
  assert.deepEqual(out.days, run().days, "the estimate itself is unchanged");
  assert.deepEqual(E.eligibilityOf(JSON.parse(JSON.stringify(out))).reasons.map((r) => r.code), ["categories-unavailable"], "a known code");
});

// ─── where the views read it ────────────────────────────────────────────────────────────────────
test("source: the tile shows the reason inside the same part as the amount; every view reads the shared gate", () => {
  const view = fs.readFileSync(path.join(SRC, "app/financials/forecast/ForecastView.tsx"), "utf8");
  const part = view.slice(view.indexOf('<Part id="safe-to-move"'), view.indexOf("</Part>", view.indexOf('<Part id="safe-to-move"')));
  assert.ok(part.length > 0);
  assert.match(part, /safe\.reasons/, "the reasons render inside the safe-to-move part");
  assert.match(part, /safe\.asOf/, "with the balance time");
  assert.match(part, /safe\.more\.map/, "every reason is reachable inside the part");
  assert.match(part, /safe\.leftOut\.map/, "accounts left out are named inside the part");
  assert.doesNotMatch(view, /headlines\.safeToMoveCents|h\.safeToMoveCents/, "never the raw headline");
  assert.match(view, /safeToMoveTile\(result, buffer, checkNow\)/, "checked against the browser's clock once mounted");
  assert.match(view, /useCheckClock\(\[result, scenario\?\.result\]\)/);
  assert.match(view, /nextExpiry\(/, "re-checked at the next expiry");
  assert.match(view, /visibilitychange/, "and when the page comes back into view");
  assert.match(view, /<CompareTable [^>]*now=\{checkNow\}/, "the what-if uses the same clock");
  assert.match(view, /\{ key: "safe-to-move", account, leaveOut: out \}/, "one account per change, applied on the server with a compare-and-swap");
  // Two accounts can share a label: each reason row (and its Leave it out button) is keyed by its account too.
  const reasonKey = view.match(/const reasonItem = [\s\S]*?<li key=\{(.*)\}>/);
  assert.ok(reasonKey, "reasonItem renders a keyed <li>");
  assert.match(reasonKey[1], /r\.account/, "the React key includes the account key");
  assert.doesNotMatch(view, /<li key=\{r\.text\}>/, "never the label text alone");
  const compare = fs.readFileSync(path.join(SRC, "app/financials/forecast/TaxAndWhatIf.tsx"), "utf8");
  assert.match(compare, /safeToMoveOf\(base, now\), safeToMoveOf\(scen, now\)/);
  assert.match(compare, /eligibilityOf\(base, now\)/);
  assert.doesNotMatch(compare, /headlines\.safeToMoveCents/);
  // Client views never bundle the engine: types only from lib/cash-forecast.
  for (const src of [view, compare]) {
    for (const line of src.split(/\r?\n/)) if (/from "@\/lib\/cash-forecast"/.test(line)) assert.match(line, /^import type /, line);
  }
  const reader = fs.readFileSync(path.join(SRC, "lib/cash-forecast-eligibility.ts"), "utf8");
  for (const line of reader.split(/\r?\n/)) if (/^\s*import\s/.test(line)) assert.match(line, /^import type /, line);
  const server = fs.readFileSync(path.join(SRC, "lib/finance-result-cache-server.ts"), "utf8");
  assert.match(server, /cashForecastCheck\(/, "Today's alerts answer carries the same check");
  const loader = fs.readFileSync(path.join(SRC, "lib/cash-forecast-server.ts"), "utf8");
  assert.match(loader, /planUnavailable: setupPending,\s+planTruncated,\s+planInvalid/);
  assert.match(loader, /historyTruncated: acc\.truncated \|\| bal\.truncated \|\| txn\.truncated/);
  assert.match(loader, /categoriesTruncated: fixes\.truncated === true/, "a capped category-fix read reaches the gate");
  assert.match(loader, /forecastBalanceRows\(bal\.rows\)/, "rejected balance rows are kept, not filtered out");
  assert.match(loader, /balanceRowsUnmatched: unmatched/);
  assert.doesNotMatch(loader, /\.map\(parseBalance\)\.filter/, "no balance row is dropped before the gate");
  assert.match(loader, /balanceUnreadable: unreadable/, "a failed older-balance read reaches the gate");
  assert.match(loader, /applyLeaveOut\(leaveOutStore\(/, "Leave it out goes through the compare-and-swap");
});
