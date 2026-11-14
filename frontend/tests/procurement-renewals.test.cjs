// Run: node --test tests/procurement-renewals.test.cjs
// Renewal alerts (lib/procurement-renewals.ts) and the Today summary route
// (app/api/procurement/renewals/summary/route.ts, run against a stubbed loader).
// SYNTHETIC DATA ONLY: every merchant, amount and date below is invented. No network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const R = loadTs("lib/procurement-recurring.ts");
const N = loadTs("lib/procurement-renewals.ts");
const TODAY = "2030-06-15";

const tx = (over) => ({
  txn_date: "2030-06-01", name: "Demo Service", custom_name: null, amount_cents: 1000,
  currency: "USD", category: "Entertainment", ignored_from: null, ...over,
});
/** A monthly subscription whose next charge is estimated `inDays` days after TODAY (fixed 30-day cycle). */
const monthly = (name, inDays, cents = 1000, n = 5) =>
  Array.from({ length: n }, (_, i) => tx({ name, amount_cents: cents, txn_date: R.addDays(TODAY, inDays - 30 * (n - i)) }));
const detect = (rows) => R.detectRecurring(rows, TODAY);

test("rows: active subscriptions only, soonest first, with the days to the estimate", () => {
  const subs = detect([...monthly("Demo Later", 20), ...monthly("Demo Soon", 2), ...monthly("Demo Gone", -100)]);
  assert.equal(subs.length, 3);
  const rows = N.renewalRows(subs, TODAY);
  assert.deepEqual(rows.map((r) => [r.merchant, r.days]), [["Demo Soon", 2], ["Demo Later", 20]]);
  assert.equal(rows[0].date, R.addDays(TODAY, 2));
  assert.equal(rows[0].alertable, true);
  assert.equal(rows[0].typicalCents, 1000);
});

test("within: today through N days ahead, inclusive; overdue and later ones are left out", () => {
  const subs = detect([
    ...monthly("Demo Today", 0), ...monthly("Demo Three", 3), ...monthly("Demo Four", 4), ...monthly("Demo Overdue", -2),
  ]);
  assert.deepEqual(N.renewalsWithin(subs, TODAY, 3).map((r) => r.merchant), ["Demo Today", "Demo Three"]);
  assert.deepEqual(N.renewalsWithin(subs, TODAY, 0).map((r) => r.merchant), ["Demo Today"]);
  // The overdue one is still a row on /procurement, with a negative day count.
  assert.equal(N.renewalRows(subs, TODAY).find((r) => r.merchant === "Demo Overdue").days, -2);
});

test("a low-confidence estimate is listed but never alerts", () => {
  const dates = ["2030-02-01", "2030-03-08", "2030-04-06", "2030-05-11", "2030-06-07"]; // gaps 35, 29, 35, 27
  const subs = R.detectRecurring(dates.map((d) => tx({ name: "Demo Wobbly", txn_date: d })), "2030-07-05");
  assert.equal(subs.length, 1);
  assert.equal(subs[0].confidence, "low");
  const today = R.addDays(subs[0].nextExpected, -1);
  const rows = N.renewalRows(subs, today);
  assert.equal(rows[0].days, 1);
  assert.equal(rows[0].alertable, false);
  assert.deepEqual(N.renewalsWithin(subs, today, 3), []);
});

test("phrases", () => {
  assert.equal(N.renewalPhrase(0), "renews today");
  assert.equal(N.renewalPhrase(1), "renews tomorrow");
  assert.equal(N.renewalPhrase(3), "renews in 3 days");
  assert.match(N.renewalPhrase(-1), /expected yesterday/);
  assert.match(N.renewalPhrase(-4), /expected 4 days ago/);
});

test("the estimate note states the method and the confidence", () => {
  const sub = detect(monthly("Demo Soon", 2))[0];
  const note = N.estimateNote(sub);
  assert.match(note, /^Estimate: every 30 days/);
  assert.match(note, /High confidence: the last 4 gaps fit exactly\.$/);
  assert.match(N.estimateNote({ nextMethod: "m", confidence: "medium", checkedGaps: 1, maxMissDays: 1 }), /Medium confidence: the one gap seen fits within 1 day\./);
  assert.match(N.estimateNote({ nextMethod: "m", confidence: "low", checkedGaps: 3, maxMissDays: 6 }), /Low confidence, a rough date: the last 3 gaps fit within 6 days\./);
});

test("summary: only what Today needs, no amounts, at most three named", () => {
  const subs = detect([
    ...monthly("Demo A", 0, 1111), ...monthly("Demo B", 1, 2222), ...monthly("Demo C", 2, 3333), ...monthly("Demo D", 3, 4444),
    ...monthly("Demo Far", 9, 5555),
  ]);
  const s = N.renewalSummary({ state: "ok", subs, irregular: [], total: 0, today: TODAY });
  assert.equal(s.status, "ready");
  assert.equal(s.count, 4);
  assert.equal(s.withinDays, 3);
  assert.deepEqual(s.soon.map((i) => i.merchant), ["Demo A", "Demo B", "Demo C"]);
  assert.deepEqual(Object.keys(s.soon[0]).sort(), ["date", "days", "label", "merchant"]);
  assert.deepEqual(s.soon.map((i) => i.label), ["renews today", "renews tomorrow", "renews in 2 days"]);
  assert.doesNotMatch(JSON.stringify(s), /1111|2222|3333|4444|5555|[Cc]ents|amount/);
});

test("summary: nothing due is ready with a zero count; an empty ledger is its own state", () => {
  const quiet = N.renewalSummary({ state: "ok", subs: detect(monthly("Demo Far", 9)), irregular: [], total: 0, today: TODAY });
  assert.deepEqual(quiet, { status: "ready", count: 0, soon: [], withinDays: 3 });
  assert.deepEqual(N.renewalSummary({ state: "empty" }), { status: "empty" });
});

// ─── the route: ready / empty / failed are distinct, nothing cached ──────────────────────────
function route(load) {
  const stubs = {
    "next/server": {
      NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers ?? {} }) },
    },
    "@/lib/procurement-recurring-server": { loadDetectedSubscriptions: async () => load },
  };
  return loadTs("app/api/procurement/renewals/summary/route.ts", stubs);
}

test("route: a renewal due soon is returned, uncached", async () => {
  const subs = detect([...monthly("Demo Soon", 2), ...monthly("Demo Far", 12)]);
  const mod = route({ state: "ok", subs, irregular: [], total: 2000, today: TODAY });
  assert.equal(mod.dynamic, "force-dynamic");
  const res = await mod.GET();
  assert.equal(res.status, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(res.body, { status: "ready", count: 1, soon: [{ merchant: "Demo Soon", days: 2, date: R.addDays(TODAY, 2), label: "renews in 2 days" }], withinDays: 3 });
});

test("route: an empty ledger and a failed read are different answers", async () => {
  const empty = await route({ state: "empty" }).GET();
  assert.deepEqual([empty.status, empty.body], [200, { status: "empty" }]);
  const failed = await route({ state: "error", code: "42501" }).GET();
  assert.equal(failed.status, 500);
  assert.equal(failed.headers["Cache-Control"], "no-store");
  assert.deepEqual(failed.body, { error: "renewals unavailable" });
});

test("route source: read-only GET, session-only, no write or outbound call", () => {
  const src = fs.readFileSync(path.join(SRC, "app/api/procurement/renewals/summary/route.ts"), "utf8");
  assert.deepEqual([...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ["GET"]);
  assert.doesNotMatch(src, /\.(insert|update|upsert|delete|rpc)\(/);
  assert.doesNotMatch(fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8"), /api\/procurement/);
});
