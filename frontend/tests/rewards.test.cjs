// Run: node --test tests/rewards.test.cjs   (written, not run before merge: AGENTS.md testing policy)
// Rewards (/rewards, lib/rewards.ts): earn estimates, expiry, credits, best card, settings validation, Today alerts,
// and static guards for the privacy rules. SYNTHETIC DATA ONLY: every merchant, amount and account is invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const R = loadTs("lib/rewards.ts");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const accounts = [
  { account_key: "p", institution: "American Express", account_name: "Platinum Card" },
  { account_key: "a", institution: "Apple", account_name: "Apple Card" },
  { account_key: "d", institution: "Discover", account_name: "Discover it Card" },
  { account_key: "c", institution: "Citibank Online", account_name: "Citi Simplicity Card" },
  { account_key: "b", institution: "Demo Bank", account_name: "Checking" },
];
const tx = (over) => ({ account_key: "p", txn_date: "2030-03-02", name: "DEMO STORE", custom_name: null, amount_cents: 10000, category: "Shopping", ignored_from: null, ...over });
const MONTHS = R.trailingMonths("2030-03-15", 12);
const build = (over) => R.buildRewards({ today: "2030-03-15", balances: [], settings: R.EMPTY_SETTINGS, accounts, windowTxns: [], hotelTxns: [], flights: null, earliest: "2024-01-01", ...over });

test("accounts are identified by institution and name only", () => {
  assert.equal(R.identifyCard(accounts[0]), "amex_platinum");
  assert.equal(R.identifyCard(accounts[1]), "apple_card");
  assert.equal(R.identifyCard(accounts[2]), "discover_it");
  assert.equal(R.identifyCard(accounts[3]), "citi_simplicity");
  assert.equal(R.identifyCard(accounts[4]), null);
});

test("Amex Platinum earns 5x on airlines and Amex Travel, 1x otherwise; refunds, transfers and ignored rows earn nothing", () => {
  const rows = [
    tx({ name: "DELTA AIR LINES", amount_cents: 20000 }),
    tx({ name: "AMEX TRAVEL HOTEL", amount_cents: 10000 }),
    tx({ name: "DEMO CAFE", amount_cents: 5000 }),
    tx({ name: "DEMO REFUND", amount_cents: -9000 }),
    tx({ name: "PAYMENT", amount_cents: 7000, category: "Credit Card Payment" }),
    tx({ name: "IGNORED", amount_cents: 7000, ignored_from: "budget" }),
  ];
  const e = R.estimateEarn(rows, accounts, R.EMPTY_SETTINGS, MONTHS).find((x) => x.card === "amex_platinum");
  assert.equal(e.total, 1000 + 500 + 50);
  assert.equal(e.txnCount, 3);
});

test("Apple Card earns 2% and 3% at listed merchants; Discover 1% and 5% only in the stored quarter, capped", () => {
  const settings = R.parseSettings([{ key: "discover_quarter", value: { quarter: "2030-Q1", keywords: ["grocery"] } }]);
  const rows = [
    tx({ account_key: "a", amount_cents: 10000 }),
    tx({ account_key: "a", name: "APPLE.COM/BILL", amount_cents: 10000 }),
    tx({ account_key: "d", name: "DEMO GROCERY", amount_cents: 10000 }),
    tx({ account_key: "d", name: "OTHER", amount_cents: 10000 }),
    tx({ account_key: "d", name: "BIG GROCERY", amount_cents: 200000 }),
  ];
  const earn = R.estimateEarn(rows, accounts, settings, MONTHS);
  assert.equal(earn.find((x) => x.card === "apple_card").total, 200 + 300);
  // $100 and $1,400 of the big purchase at 5% (the $1,500 cap), the other $600 and the $100 at 1%
  assert.equal(earn.find((x) => x.card === "discover_it").total, Math.round(10000 * 0.05 + 140000 * 0.05 + 60000 * 0.01 + 10000 * 0.01));
  assert.ok(earn.every((x) => x.card !== "citi_simplicity" || x.total === 0));
});

test("REW828-11: non-USD rows never enter dollar earn or credit math, and are counted", () => {
  // Synthetic: a USD 100 purchase and an EUR 100 purchase, both amount_cents 10000 on the Platinum card.
  const rows = [
    tx({ amount_cents: 10000, currency: "USD" }),
    tx({ amount_cents: 10000, currency: "eur" }),
    tx({ account_key: "a", amount_cents: 10000, currency: " GBP " }),
    tx({ account_key: "a", amount_cents: 10000 }), // missing currency = USD, like the ledger
    tx({ account_key: "b", amount_cents: 10000, currency: "EUR" }), // not a card account: not counted
  ];
  const earn = R.estimateEarn(rows, accounts, R.EMPTY_SETTINGS, MONTHS);
  const plat = earn.find((x) => x.card === "amex_platinum");
  assert.equal(plat.spendCents, 10000);
  assert.equal(plat.total, 100);
  assert.equal(plat.txnCount, 1);
  const apple = earn.find((x) => x.card === "apple_card");
  assert.equal(apple.spendCents, 10000);
  assert.equal(apple.total, 200);
  assert.equal(R.countNonUsd(rows, accounts), 2);
  assert.equal(build({ windowTxns: rows }).nonUsdCount, 2);
  assert.equal(build({ windowTxns: [tx({})] }).nonUsdCount, 0);
});

test("REW828-11: a foreign-currency benefit credit is not compared with a USD allowance", () => {
  const rows = [
    tx({ name: "RESY CREDIT", amount_cents: -10000, txn_date: "2030-03-03", currency: "EUR" }),
    tx({ name: "LULULEMON CREDIT", amount_cents: -7500, txn_date: "2030-03-03", currency: "USD" }),
  ];
  const c = Object.fromEntries(R.creditStatuses(rows, accounts, R.EMPTY_SETTINGS, "2030-03-15").map((x) => [x.id, x]));
  assert.equal(c.resy.usedCents, 0);
  assert.equal(c.resy.state, "unused");
  assert.equal(c.lululemon.usedCents, 7500);
  assert.equal(c.lululemon.state, "used");
});

test("REW828-11: the server reader selects currency and keeps it on every row", () => {
  const src = read("lib/rewards-server.ts");
  const cols = src.match(/const TXN_COLS = "([^"]+)"/);
  assert.ok(cols && cols[1].split(",").includes("currency"), "TXN_COLS selects currency");
  assert.match(src, /currency: \(typeof r\.currency === "string"/);
});

test("Hilton and Marriott brands count; ordinary words alone do not", () => {
  assert.equal(R.hotelFamily("HAMPTON INN ATLANTA"), "hilton_honors");
  assert.equal(R.hotelFamily("COURTYARD BY MARRIOTT"), "marriott_bonvoy");
  assert.equal(R.hotelFamily("SPARK PLUMBING"), null);
  assert.equal(R.hotelFamily("SPARK BY HILTON HOTEL"), "hilton_honors");
  assert.equal(R.hotelFamily("ELEMENT STUDIO"), null);
});

test("expiry: 24 months after the last stay is an estimate, a harvested date wins, no stay is unknown", () => {
  const def = R.programDef("hilton_honors");
  const est = R.expiryOf(def, null, "2028-12-20", "2030-03-15", "2024-01-01");
  assert.equal(est.date, "2030-12-20");
  assert.equal(est.basis, "estimated");
  assert.equal(est.atRisk, false);
  assert.equal(R.expiryOf(def, null, "2028-04-01", "2030-03-15", "2024-01-01").atRisk, true);
  const bal = { program: "hilton_honors", captured_at: "2030-03-14T10:00:00Z", balance: 5, unit: "points", status_tier: null, status_progress: null, expires_on: "2031-01-31", source: "harvest" };
  assert.equal(R.expiryOf(def, bal, "2028-04-01", "2030-03-15", null).basis, "harvested");
  const none = R.expiryOf(def, null, null, "2030-03-15", "2024-01-01");
  assert.equal(none.basis, "unknown");
  assert.equal(none.date, null);
  assert.equal(R.expiryOf(R.programDef("delta_skymiles"), null, null, "2030-03-15", null).basis, "none");
});

test("a program with no harvested row is not connected (null), never 0; the newest row wins; stale after 7 days", () => {
  const rows = [
    R.parseBalanceRow({ program: "amex_mr", captured_at: "2030-03-01T00:00:00Z", balance: "100", unit: "points" }),
    R.parseBalanceRow({ program: "amex_mr", captured_at: "2030-03-10T00:00:00Z", balance: 250, unit: "points", status_progress: { mqd: 5, mqd_goal: 10 } }),
  ];
  const data = build({ balances: rows });
  const mr = data.programs.find((p) => p.id === "amex_mr");
  assert.equal(mr.balance.balance, 250);
  assert.equal(mr.stale, false);
  assert.equal(mr.valueCents, 250);
  assert.equal(data.programs.find((p) => p.id === "delta_skymiles").balance, null);
  assert.equal(data.programs.find((p) => p.id === "delta_skymiles").valueCents, null);
  assert.equal(build({ today: "2030-03-25", balances: rows }).programs.find((p) => p.id === "amex_mr").stale, true);
  assert.equal(R.parseBalanceRow({ program: "nope", captured_at: "2030-03-01T00:00:00Z", balance: 1, unit: "points" }), null);
  assert.deepEqual(R.progressBars({ mqd: 5, mqd_goal: 10, x: 1 }).map((b) => [b.label, b.pct]), [["MQD", 50]]);
});

test("credit periods follow the calendar", () => {
  assert.deepEqual(R.periodBounds("monthly", "2030-02-10"), { start: "2030-02-01", end: "2030-02-28", label: "2030-02" });
  assert.equal(R.periodBounds("quarterly", "2030-05-10").end, "2030-06-30");
  assert.equal(R.periodBounds("semiannual", "2030-08-10").start, "2030-07-01");
  assert.equal(R.periodBounds("annual", "2030-08-10").end, "2030-12-31");
});

test("a credit is used only by a matching credit row inside the period; no row is 'not used yet'", () => {
  const rows = [
    tx({ name: "PLATINUM RESY CREDIT", amount_cents: -10000, txn_date: "2030-02-20" }), // inside Q1 2030
    tx({ name: "PLATINUM DIGITAL ENTERTAINMENT", amount_cents: -2500, txn_date: "2030-02-05" }), // last month
    tx({ name: "DEMO RESY CHARGE", amount_cents: 4000, txn_date: "2030-03-04" }), // a purchase, not a credit
    tx({ account_key: "b", name: "PLATINUM LULULEMON CREDIT", amount_cents: -7500, txn_date: "2030-03-04" }), // another account
  ];
  const c = Object.fromEntries(R.creditStatuses(rows, accounts, R.EMPTY_SETTINGS, "2030-03-15").map((x) => [x.id, x]));
  assert.equal(c.resy.state, "used");
  assert.equal(c.digital_entertainment.state, "unused");
  assert.equal(c.digital_entertainment.leftCents, 2500);
  assert.equal(c.uber_cash.state, "untracked");
  assert.equal(c.lululemon.state, "unused");
  const edited = R.creditStatuses(rows, accounts, R.parseSettings([{ key: "credits", value: { resy: 20000 } }]), "2030-03-15").find((x) => x.id === "resy");
  assert.equal(edited.state, "partly");
  assert.equal(edited.estimate, false);
});

test("best card: Amex wins flights, Apple wins everyday, a tie is not a recommendation, the Discover quarter lifts dining", () => {
  const t = R.bestCardTable(R.EMPTY_SETTINGS);
  assert.equal(t.find((r) => r.category.startsWith("Flights")).best, "amex_platinum");
  assert.equal(t.find((r) => r.category === "Everything else").best, "apple_card");
  assert.equal(t.find((r) => r.category.startsWith("Apple")).best, "apple_card");
  const quarter = R.parseSettings([{ key: "discover_quarter", value: { quarter: "2030-Q1", keywords: ["dining"] } }]);
  assert.equal(R.bestCardTable(quarter).find((r) => r.category === "Dining").best, "discover_it");
  const richer = R.parseSettings([{ key: "valuations", value: { amex_mr: 2 } }]);
  assert.equal(R.bestCardTable(richer).find((r) => r.category === "Everything else").best, null);
});

test("Today alerts: expiry within 60 days and a credit with 7 days left; an unknown expiry and an untracked credit never alert", () => {
  const stay = [tx({ name: "HAMPTON INN", amount_cents: 20000, txn_date: "2028-04-20", account_key: "b" })];
  const alerts = R.rewardsAlerts(build({ today: "2030-03-25", hotelTxns: stay }));
  const hilton = alerts.find((a) => a.title.startsWith("Hilton Honors"));
  assert.ok(hilton);
  assert.equal(hilton.due, "2030-04-20");
  const endOfMonth = R.rewardsAlerts(build({ today: "2030-03-27" }));
  assert.ok(endOfMonth.some((a) => a.title === "Digital entertainment credit: $25 unused"));
  assert.ok(!endOfMonth.some((a) => a.title.startsWith("Uber Cash")));
  assert.ok(!endOfMonth.some((a) => a.title.includes("expire")));
  assert.ok(endOfMonth.every((a) => a.kind === "rewards" && a.href === "/rewards"));
});

test("settings: valid values are read, malformed ones are ignored; a PUT refuses unknown fields and bad numbers", () => {
  const s = R.parseSettings([
    { key: "valuations", value: { amex_mr: 1.5, hilton_honors: -1, nope: 3 } },
    { key: "credits", value: { resy: 5000, nope: 1, lululemon: 1.5 } },
    { key: "discover_quarter", value: { quarter: "2030-Q2", keywords: ["gas", 4] } },
  ]);
  assert.equal(R.cppOf(s, "amex_mr"), 1.5);
  assert.equal(R.cppOf(s, "hilton_honors"), 0.5);
  assert.deepEqual(s.creditCents, { resy: 5000 });
  assert.equal(s.discoverQuarter.quarter, "2030-Q2");
  assert.deepEqual(Array.from(s.discoverQuarter.keywords), ["GAS"]);
  assert.equal(R.parseSettingsPatch({ key: "valuations", value: { amex_mr: 1.2 } }).ok, true);
  assert.equal(R.parseSettingsPatch({ key: "valuations", value: { amex_mr: 0 } }).ok, false);
  assert.equal(R.parseSettingsPatch({ key: "valuations", value: {}, extra: 1 }).ok, false);
  assert.equal(R.parseSettingsPatch({ key: "other", value: {} }).ok, false);
  assert.equal(R.parseSettingsPatch({ key: "discover_quarter", value: { quarter: "Q9", keywords: [] } }).ok, false);
});

test("static guards: service-role server module, no select *, never a CI route, memory-only cache, status card", () => {
  const server = read("lib/rewards-server.ts");
  assert.match(server, /^import "server-only";/);
  assert.ok(!/select\(\s*["'`]\*["'`]/.test(server));
  assert.ok(!read("middleware.ts").includes("/api/rewards"));
  const cache = read("lib/client-cache.ts");
  assert.ok(cache.includes("finance|rewards|"));
  assert.ok(cache.includes("financials|rewards|"));
  const route = read("app/api/status/route.ts");
  assert.ok(route.includes('["rewards", "balances"]') && route.includes("rewards:        { method"));
  assert.ok(read("app/rewards/page.tsx").includes('dynamic = "force-dynamic"'));
  assert.ok(read("lib/feed-registry.ts").includes('"/rewards"'));
  const client = read("app/rewards/RewardsClient.tsx");
  assert.ok(!client.includes("isAnimationActive={true}") && client.includes("isAnimationActive={false}"));
});
