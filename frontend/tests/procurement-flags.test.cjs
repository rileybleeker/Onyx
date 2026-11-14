// Run: node --test tests/procurement-flags.test.cjs
// Waste flags on /procurement: lib/procurement-flags.ts (pure rules), lib/procurement-flags-server.ts
// (run against in-memory stand-ins), the PATCH route and the SQL file.
// SYNTHETIC DATA ONLY: every merchant, app id, amount and date below is invented. No network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const R = loadTs("lib/procurement-recurring.ts");
const F = loadTs("lib/procurement-flags.ts");
const TODAY = "2030-06-15";

const tx = (over) => ({
  txn_date: "2030-06-01", name: "Demo Service", custom_name: null, amount_cents: 1000,
  currency: "USD", category: "Entertainment", ignored_from: null, ...over,
});
/** A monthly subscription, last charged `ago` days before TODAY. `cents` may be one amount or one per charge (oldest first). */
const monthly = (name, cents = 1000, n = 5, ago = 10) =>
  Array.from({ length: n }, (_, i) => tx({
    name, txn_date: R.addDays(TODAY, -ago - 30 * (n - 1 - i)), amount_cents: Array.isArray(cents) ? cents[i] : cents,
  }));
const detect = (rows) => R.detectRecurring(rows, TODAY);
const one = (rows) => { const out = detect(rows); assert.equal(out.length, 1); return out[0]; };

// A synthetic catalog, so the tests do not depend on the real service list.
const CATALOG = [
  { id: "video", label: "Video streaming", services: [
    { name: "Demoflix", match: ["demoflix"], apps: ["com.demoflix."], sites: ["demoflix.example"] },
    { name: "Showbox", match: ["showbox"], apps: ["tv.showbox."] },
    { name: "Reelhouse", match: ["reelhouse", "reel house"], apps: ["com.reelhouse."] },
  ] },
  { id: "storage", label: "Cloud storage", services: [{ name: "Demo Vault", match: ["demovault"] }] },
];
const usage = (items, daysCovered = 30) => ({ daysCovered, items });
const app = (identifier, minutes) => ({ kind: "app", identifier, minutes });
const web = (identifier, minutes) => ({ kind: "web", identifier, minutes });
const advise = (rows, u = null, dismissed = new Set()) => F.buildAdvice(detect(rows), u, dismissed, CATALOG);
const kinds = (a) => a.flags.map((f) => f.kind);

// ─── service matching ────────────────────────────────────────────────────────────────────────
test("a merchant matches a service when one of its words starts with a keyword", () => {
  assert.equal(F.matchService("DEMOFLIX.COM 8812", CATALOG).service.name, "Demoflix");
  assert.equal(F.matchService("PP*DemoflixPremium", CATALOG).service.name, "Demoflix");
  assert.equal(F.matchService("Reel House Inc", CATALOG).category.id, "video");
  assert.equal(F.matchService("Undemoflix", CATALOG), null, "not at the start of a word");
  assert.equal(F.matchService("Corner Bakery", CATALOG), null);
});

test("the real catalog is small, explicit and well formed", () => {
  assert.ok(F.SERVICE_CATEGORIES.length >= 3 && F.SERVICE_CATEGORIES.length <= 12);
  const ids = F.SERVICE_CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of F.SERVICE_CATEGORIES) {
    assert.ok(c.label && c.services.length > 0, c.id);
    for (const s of c.services) {
      assert.ok(s.name && s.match.length > 0, s.name);
      for (const kw of s.match) assert.ok(kw === kw.toLowerCase() && kw.trim().length >= 3, `${s.name}: ${kw}`);
      for (const p of s.apps ?? []) assert.ok(p === p.toLowerCase() && p.includes("."), `${s.name}: ${p}`);
      for (const d of s.sites ?? []) assert.match(d, /^[a-z0-9.-]+\.[a-z]{2,}$/, `${s.name}: ${d}`);
    }
  }
});

// ─── price increase ──────────────────────────────────────────────────────────────────────────
test("price increase: flagged from 5% and 50 cents, with the numbers in the reason", () => {
  const sub = one(monthly("Demo Plan", [1000, 1000, 1000, 1000, 1200]));
  assert.equal(sub.lastCents, 1200);
  assert.equal(sub.previousTypicalCents, 1000);
  const flag = F.priceIncreaseFlag(sub);
  assert.equal(flag.kind, "price_increase");
  assert.match(flag.key, /^price_increase:[0-9a-f]{16}$/);
  assert.match(flag.reason, /\$12\.00/);
  assert.match(flag.reason, /20% above the usual \$10\.00/);
  assert.match(flag.reason, /flagged from 5% and \$0\.50/);
});

test("price increase: under either threshold, equal, or lower is not flagged", () => {
  assert.equal(F.priceIncreaseFlag(one(monthly("Demo Plan", [1000, 1000, 1000, 1000, 1040]))), null, "4%");
  assert.equal(F.priceIncreaseFlag(one(monthly("Demo Plan", [500, 500, 500, 500, 540]))), null, "8% but only 40 cents");
  assert.ok(F.priceIncreaseFlag(one(monthly("Demo Plan", [500, 500, 500, 500, 550]))), "10% and 50 cents");
  assert.equal(F.priceIncreaseFlag(one(monthly("Demo Plan", 1000))), null, "unchanged");
  assert.equal(F.priceIncreaseFlag(one(monthly("Demo Plan", [1000, 1000, 1000, 1000, 900]))), null, "cheaper");
});

test("price increase: a jump of more than a quarter still counts as the same subscription", () => {
  const sub = one(monthly("Demo Plan", [1000, 1000, 1000, 1000, 1600]));
  assert.equal(sub.typicalCents, 1600, "the new price is what it costs now");
  assert.match(F.priceIncreaseFlag(sub).reason, /60% above/);
  // The month after, the higher price is still within one step and still flagged against the old usual amount.
  const next = one(monthly("Demo Plan", [1000, 1000, 1000, 1600, 1600]));
  assert.equal(next.typicalCents, 1600);
  assert.ok(F.priceIncreaseFlag(next));
  // Once the charges before it are mostly at the new price, the flag is gone.
  assert.equal(F.priceIncreaseFlag(one(monthly("Demo Plan", [1000, 1000, 1600, 1600, 1600]))), null);
  // More than double is not treated as one subscription at all.
  assert.deepEqual(detect(monthly("Demo Plan", [1000, 1000, 1000, 1000, 2500])), []);
});

test("price increase: an annual charge seen twice, and one charge only", () => {
  const rows = [tx({ txn_date: "2029-03-01", amount_cents: 12000 }), tx({ txn_date: "2030-03-01", amount_cents: 13900 })];
  const sub = one(rows);
  assert.equal(sub.previousTypicalCents, 12000);
  assert.match(F.priceIncreaseFlag(sub).reason, /16% above/);
  assert.deepEqual(detect([tx({ amount_cents: 99900 })]), [], "one charge is not a subscription, so nothing can be flagged");
});

test("price increase: the flag key changes with the new amount, so a later increase shows again", () => {
  const first = F.priceIncreaseFlag(one(monthly("Demo Plan", [1000, 1000, 1000, 1000, 1200])));
  const later = F.priceIncreaseFlag(one(monthly("Demo Plan", [1000, 1200, 1200, 1200, 1400])));
  assert.notEqual(first.key, later.key);
});

test("refunds, ignored rows and non-USD charges never raise a price flag", () => {
  const base = monthly("Demo Plan", 1000);
  const noise = [
    tx({ name: "Demo Plan", txn_date: R.addDays(TODAY, -5), amount_cents: -5000 }),
    tx({ name: "Demo Plan", txn_date: R.addDays(TODAY, -4), amount_cents: 5000, ignored_from: "budget" }),
    tx({ name: "Demo Plan", txn_date: R.addDays(TODAY, -3), amount_cents: 5000, currency: "EUR" }),
  ];
  const [a] = advise([...base, ...noise]);
  assert.deepEqual(a.flags, []);
});

// ─── duplicates ──────────────────────────────────────────────────────────────────────────────
test("duplicate: two active subscriptions in one category are flagged on both, with the other one named", () => {
  const out = advise([...monthly("Demoflix", 1500), ...monthly("Showbox Plus", 900), ...monthly("Corner Gym", 3000)]);
  const by = Object.fromEntries(detect([...monthly("Demoflix", 1500), ...monthly("Showbox Plus", 900), ...monthly("Corner Gym", 3000)]).map((s) => [s.id, s.merchant]));
  const flix = out.find((a) => by[a.subId] === "Demoflix");
  const show = out.find((a) => by[a.subId] === "Showbox Plus");
  const gym = out.find((a) => by[a.subId] === "Corner Gym");
  assert.deepEqual(kinds(flix), ["duplicate"]);
  assert.match(flix.flags[0].reason, /You also pay for Showbox Plus in the same category \(Video streaming\)\./);
  assert.match(show.flags[0].reason, /Demoflix/);
  assert.equal(flix.category, "Video streaming");
  assert.equal(flix.service, "Demoflix");
  assert.deepEqual(gym.flags, []);
  assert.equal(gym.category, null);
});

test("duplicate: one in a category, or the other one lapsed, is not a duplicate", () => {
  assert.deepEqual(advise(monthly("Demoflix", 1500))[0].flags, []);
  const out = advise([...monthly("Demoflix", 1500), ...monthly("Showbox", 900, 5, 120)]);
  assert.equal(out.length, 1, "advice covers active subscriptions only");
  assert.deepEqual(out[0].flags, []);
});

test("duplicate: a third service in the category brings the flag back after a dismissal", () => {
  const two = advise([...monthly("Demoflix", 1500), ...monthly("Showbox", 900)]);
  const three = advise([...monthly("Demoflix", 1500), ...monthly("Showbox", 900), ...monthly("Reelhouse", 700)]);
  const keyOf = (out) => out.map((a) => a.flags.find((f) => f.kind === "duplicate").key);
  assert.equal(keyOf(two).filter((k) => keyOf(three).includes(k)).length, 0);
  assert.match(three[0].flags[0].reason, /,/, "both others are named");
});

// ─── usage ───────────────────────────────────────────────────────────────────────────────────
test("usage: minutes are summed over the service's apps and sites", () => {
  const u = usage([app("com.demoflix.ios", 30), app("com.demoflix.kids", 12), web("www.demoflix.example", 3), app("com.other.app", 500), web("notdemoflix.example", 99)]);
  const note = F.usageFor("Demoflix", CATALOG[0].services[0], u);
  assert.equal(note.state, "known");
  assert.equal(note.minutes, 45);
  assert.deepEqual(note.matched, ["com.demoflix.ios", "com.demoflix.kids", "www.demoflix.example"]);
  assert.equal(note.basis, "service list");
  assert.match(F.usageLine(note), /^iPhone use, last 30 days: 45 min \(com\.demoflix\.ios, /);
});

test("no recent use: flagged under 10 minutes, with the reason and the caveat; not at 10 or more", () => {
  const tiny = advise(monthly("Demoflix", 1500), usage([app("com.demoflix.ios", 4)]))[0];
  assert.deepEqual(kinds(tiny), ["no_recent_use"]);
  assert.match(tiny.flags[0].reason, /Screen Time shows 4 min in com\.demoflix\.ios over the last 30 days \(30 days of data; flagged under 10 minutes\)/);
  assert.match(tiny.flags[0].reason, /Use on a computer or TV is not visible to Onyx\./);
  const enough = advise(monthly("Demoflix", 1500), usage([app("com.demoflix.ios", 10)]))[0];
  assert.deepEqual(enough.flags, []);
});

test("no recent use: a listed service that never appears in a covered window is zero use", () => {
  const a = advise(monthly("Demoflix", 1500), usage([app("com.other.app", 500)]))[0];
  assert.deepEqual(kinds(a), ["no_recent_use"]);
  assert.match(a.flags[0].reason, /no time in the Demoflix app or site/);
  assert.equal(a.usage.minutes, 0);
});

test("usage unknown, never a guess: no data, thin coverage, no app for the service, or no matching app", () => {
  const rows = monthly("Demoflix", 1500);
  const none = advise(rows, null)[0];
  assert.deepEqual([none.usage.state, none.flags.length], ["unknown", 0]);
  assert.match(F.usageLine(none.usage), /^iPhone use: unknown \(Screen Time data is not available\)\.$/);

  const thin = advise(rows, usage([], 19))[0];
  assert.deepEqual([thin.usage.state, thin.flags.length], ["unknown", 0]);
  assert.match(thin.usage.why, /covers only 19 of the last 30 days/);
  assert.equal(advise(rows, usage([], 20))[0].usage.state, "known", "20 days is enough");

  const storage = advise(monthly("DemoVault Storage", 300), usage([app("com.demovault.files", 0)]))[0];
  assert.deepEqual([storage.usage.state, storage.flags.length], ["unknown", 0]);
  assert.match(storage.usage.why, /not used through an app/);

  const unlisted = advise(monthly("Corner Gym", 3000), usage([app("com.other.app", 500)]))[0];
  assert.deepEqual([unlisted.usage.state, unlisted.flags.length], ["unknown", 0]);
  assert.match(unlisted.usage.why, /no app or site in Screen Time matches/);

  const generic = advise(monthly("Premium Subscription", 800), usage([app("com.premium.app", 0)]))[0];
  assert.deepEqual([generic.usage.state, generic.flags.length], ["unknown", 0]);
  assert.match(generic.usage.why, /too generic/);
});

test("a merchant outside the list is tied to an app only by a distinctive word that is part of its id", () => {
  const seen = advise(monthly("Lumenly Fitness", 1200), usage([app("com.lumenly.Trainer", 2), app("com.lumenlyx.other", 400)]))[0];
  assert.equal(seen.usage.state, "known");
  assert.equal(seen.usage.basis, "name match");
  assert.deepEqual(seen.usage.matched, ["com.lumenly.Trainer"]);
  assert.deepEqual(kinds(seen), ["no_recent_use"]);
  assert.match(seen.flags[0].reason, /matched by name/);
  const used = advise(monthly("Lumenly Fitness", 1200), usage([app("com.lumenly.Trainer", 240)]))[0];
  assert.deepEqual(used.flags, []);
  assert.match(F.usageLine(used.usage), /4 h \(com\.lumenly\.Trainer, matched by name\)/);
});

test("sumUsage adds seconds per app and skips rows it cannot read", () => {
  const totals = F.sumUsage([
    { kind: "app", identifier: "com.demo.one", seconds: 600 },
    { kind: "app", identifier: "com.demo.one", seconds: "300.5" },
    { kind: "web", identifier: "demo.example", seconds: 60 },
    { kind: "app", identifier: "", seconds: 60 },
    { kind: "tv", identifier: "com.demo.two", seconds: 60 },
    { kind: "app", identifier: "com.demo.two", seconds: -5 },
    { kind: "app", identifier: "com.demo.two", seconds: "x" },
    null,
  ], 12);
  assert.equal(totals.daysCovered, 12);
  assert.equal(totals.items.length, 2);
  assert.ok(Math.abs(totals.items.find((i) => i.identifier === "com.demo.one").minutes - 15.008) < 0.01);
  assert.equal(F.minutesLabel(0), "no time");
  assert.equal(F.minutesLabel(0.4), "under a minute");
  assert.equal(F.minutesLabel(125), "2 h 5 min");
  assert.equal(F.minutesLabel(120), "2 h");
});

// ─── dismissing ──────────────────────────────────────────────────────────────────────────────
test("a dismissed flag stays dismissed and is not counted as open", () => {
  const rows = [...monthly("Demoflix", [1500, 1500, 1500, 1500, 1800]), ...monthly("Showbox", 900)];
  const fresh = advise(rows, usage([app("com.demoflix.ios", 1), app("tv.showbox.ios", 300)]));
  const flix = fresh.find((a) => a.service === "Demoflix");
  assert.deepEqual(kinds(flix).sort(), ["duplicate", "no_recent_use", "price_increase"]);
  assert.equal(F.openFlagCount(fresh), 4);
  const dismissed = new Set(flix.flags.filter((f) => f.kind !== "duplicate").map((f) => F.dismissalKey(flix.subId, f.key)));
  const again = advise(rows, usage([app("com.demoflix.ios", 1), app("tv.showbox.ios", 300)]), dismissed);
  const flixAgain = again.find((a) => a.service === "Demoflix");
  assert.deepEqual(flixAgain.flags.map((f) => [f.kind, f.dismissed]).sort(), [["duplicate", false], ["no_recent_use", true], ["price_increase", true]]);
  assert.equal(F.openFlagCount(again), 2);
});

test("the PATCH body is exactly {sub, flag, dismissed}", () => {
  const sub = "0123456789abcdef";
  const flag = "price_increase:0123456789abcdef";
  assert.deepEqual(F.parseFlagBody({ sub, flag, dismissed: true }), { ok: true, mark: { sub, flag, dismissed: true } });
  assert.equal(F.parseFlagBody({ sub, flag: "duplicate:fedcba9876543210", dismissed: false }).ok, true);
  for (const bad of [
    null, [], "x", {}, { sub, flag }, { sub, flag, dismissed: "yes" }, { sub: "nope", flag, dismissed: true },
    { sub: sub.toUpperCase(), flag, dismissed: true }, { sub, flag: "cancel:0123456789abcdef", dismissed: true },
    { sub, flag: "price_increase:123", dismissed: true }, { sub, flag, dismissed: true, merchant: "Demo" },
  ]) assert.equal(F.parseFlagBody(bad).ok, false, JSON.stringify(bad));
  assert.equal(F.MAX_FLAG_BODY_BYTES, 256);
});

// ─── server: Screen Time read, dismissals, save ──────────────────────────────────────────────
function server({ segments = [], items = [], truncated = false, fail = null, dismissals = { data: [], error: null }, upsert = { error: null }, configured = true }) {
  class LedgerQueryError extends Error {
    constructor(code) { super(code ?? "query failed"); this.code = code; }
  }
  const logged = [];
  const calls = { tables: [], upserts: [] };
  const db = {
    from(table) {
      calls.tables.push(table);
      const b = {
        select() { return b; }, gte() { return b; }, eq() { return b; }, order() { return b; }, range() { return b; },
        limit() { return Promise.resolve(dismissals); },
        upsert(row, opts) { calls.upserts.push({ table, row, opts }); return Promise.resolve(upsert); },
        table,
      };
      return b;
    },
  };
  const stubs = {
    "server-only": {},
    "@/lib/finance-ledger-server": {
      LedgerQueryError,
      serviceClient: () => { if (!configured) throw new LedgerQueryError("not-configured"); return db; },
      fetchPaged: async (build) => {
        const table = build(0, 999).table;
        if (fail) throw new LedgerQueryError(fail);
        return { rows: table === "phone_usage_segments" ? segments : items, truncated };
      },
    },
  };
  const mod = loadTs("lib/procurement-flags-server.ts", stubs);
  const wrap = async (fn) => {
    const orig = console.error;
    console.error = (...a) => logged.push(a.join(" "));
    try { return await fn(); } finally { console.error = orig; }
  };
  return { mod, db, calls, logged, wrap };
}
const hours = (days) => Array.from({ length: days }, (_, d) => ({ segment_start: `2030-05-${String(17 + d).padStart(2, "0")}T14:00:00+00:00` }))
  .map((r) => (r.segment_start.startsWith("2030-05-3") && Number(r.segment_start.slice(8, 10)) > 31 ? null : r)).filter(Boolean);

test("server: usage totals carry the days covered; a failed or cut-off read is unknown, not zero", async () => {
  const s = server({ segments: [...hours(12), ...hours(12)], items: [{ kind: "app", identifier: "com.demoflix.ios", seconds: 1200 }] });
  const totals = await s.wrap(() => s.mod.loadUsageTotals(s.db, new Date(`${TODAY}T12:00:00Z`)));
  assert.equal(totals.daysCovered, 12, "two hours on one day count as one day");
  assert.equal(totals.items[0].minutes, 20);

  const cut = server({ segments: hours(12), items: [], truncated: true });
  assert.equal(await cut.wrap(() => cut.mod.loadUsageTotals(cut.db, new Date())), null);

  const broken = server({ fail: "42501" });
  assert.equal(await broken.wrap(() => broken.mod.loadUsageTotals(broken.db, new Date())), null);
  assert.equal(broken.logged.length, 1);
  assert.match(broken.logged[0], /42501/);
});

test("server: advice is built from the usage and the stored dismissals; missing pieces fail open honestly", async () => {
  const subs = detect([...monthly("Demoflix", [1500, 1500, 1500, 1500, 1800])]);
  const key = F.dismissalKey(subs[0].id, F.priceIncreaseFlag(subs[0]).key);
  const [sub_id, flag_key] = key.split("|");

  const ok = server({ segments: hours(12), dismissals: { data: [{ sub_id, flag_key }], error: null } });
  const load = await ok.wrap(() => ok.mod.loadSubscriptionAdvice(subs, new Date()));
  assert.equal(load.usageAvailable, true);
  assert.equal(load.canDismiss, true);
  assert.deepEqual(load.advice[0].flags.map((f) => [f.kind, f.dismissed]), [["price_increase", true]]);

  const noTable = server({ fail: "57014", dismissals: { data: null, error: { code: "PGRST205", message: "missing" } } });
  const open = await noTable.wrap(() => noTable.mod.loadSubscriptionAdvice(subs, new Date()));
  assert.deepEqual([open.usageAvailable, open.canDismiss], [false, false]);
  assert.deepEqual(open.advice[0].flags.map((f) => [f.kind, f.dismissed]), [["price_increase", false]], "without the table every flag shows");
  assert.equal(open.advice[0].usage.state, "unknown");

  const unconfigured = server({ configured: false });
  const bare = await unconfigured.wrap(() => unconfigured.mod.loadSubscriptionAdvice(subs, new Date()));
  assert.deepEqual([bare.usageAvailable, bare.canDismiss, bare.advice.length], [false, false, 1]);
});

test("server: saving writes one row of hashes to the dismissals table and nothing else", async () => {
  const mark = { sub: "0123456789abcdef", flag: "duplicate:0123456789abcdef", dismissed: true };
  const s = server({});
  assert.deepEqual(await s.wrap(() => s.mod.saveFlagMark(s.db, mark, "2030-06-15T12:00:00.000Z")), { ok: true });
  assert.deepEqual(s.calls.tables, ["procurement_flag_dismissals"]);
  assert.deepEqual(s.calls.upserts[0].row, { sub_id: mark.sub, flag_key: mark.flag, dismissed: true, updated_at: "2030-06-15T12:00:00.000Z" });
  assert.deepEqual(s.calls.upserts[0].opts, { onConflict: "sub_id,flag_key" });

  const pending = server({ upsert: { error: { code: "42P01", message: "relation does not exist" } } });
  assert.deepEqual(await pending.wrap(() => pending.mod.saveFlagMark(pending.db, mark, "t")), { ok: false, status: 503, setupPending: true });
  const broken = server({ upsert: { error: { code: "42501", message: "denied for a secret merchant" } } });
  assert.deepEqual(await broken.wrap(() => broken.mod.saveFlagMark(broken.db, mark, "t")), { ok: false, status: 500, setupPending: false });
  assert.doesNotMatch(broken.logged.join(" "), /secret merchant/, "only the error code is logged");
});

// ─── the PATCH route ─────────────────────────────────────────────────────────────────────────
function route({ configured = true, saved = { ok: true } } = {}) {
  const saves = [];
  const stubs = {
    "next/server": { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers ?? {} }) } },
    "@/lib/finance-ledger-server": { serviceClient: () => { if (!configured) throw new Error("not-configured"); return {}; } },
    "@/lib/procurement-flags-server": { saveFlagMark: async (_db, mark) => { saves.push(mark); return saved; } },
  };
  return { mod: loadTs("app/api/procurement/flags/route.ts", stubs), saves };
}
const ORIGIN = "https://onyx.example";
const request = (body, headers = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const h = { origin: ORIGIN, host: "onyx.example", "content-type": "application/json", ...headers };
  return { headers: { get: (k) => h[k.toLowerCase()] ?? null }, nextUrl: { origin: ORIGIN }, text: async () => text };
};
const GOOD = { sub: "0123456789abcdef", flag: "no_recent_use:0123456789abcdef", dismissed: true };

test("route: a valid same-origin dismissal is saved and answered uncached", async () => {
  const r = route();
  assert.equal(r.mod.dynamic, "force-dynamic");
  const res = await r.mod.PATCH(request(GOOD));
  assert.equal(res.status, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(res.body, { ok: true, ...GOOD });
  assert.deepEqual(r.saves, [GOOD]);
  const undo = await r.mod.PATCH(request({ ...GOOD, dismissed: false }));
  assert.equal(undo.body.dismissed, false);
});

test("route: cross-origin, wrong type, oversize, bad JSON and bad fields are refused before anything is written", async () => {
  const r = route();
  const cases = [
    [request(GOOD, { origin: "https://evil.example" }), 403],
    [request(GOOD, { origin: undefined }), 403],
    [request(GOOD, { "content-type": "text/plain" }), 415],
    [request(GOOD, { "content-length": "999" }), 413],
    [request(JSON.stringify({ ...GOOD, pad: "x".repeat(300) })), 413],
    [request("{not json"), 400],
    [request({ ...GOOD, sub: "DROP" }), 400],
    [request({ ...GOOD, extra: 1 }), 400],
  ];
  for (const [req, status] of cases) assert.equal((await r.mod.PATCH(req)).status, status);
  assert.deepEqual(r.saves, []);
});

test("route: a missing table or an unconfigured deploy is a 503, a database error a 500", async () => {
  const pending = await route({ saved: { ok: false, status: 503, setupPending: true } }).mod.PATCH(request(GOOD));
  assert.deepEqual([pending.status, pending.body.setupPending], [503, true]);
  assert.equal((await route({ saved: { ok: false, status: 500, setupPending: false } }).mod.PATCH(request(GOOD))).status, 500);
  assert.equal((await route({ configured: false }).mod.PATCH(request(GOOD))).status, 503);
});

test("route source: PATCH only, session-only, no outbound call", () => {
  const src = fs.readFileSync(path.join(SRC, "app/api/procurement/flags/route.ts"), "utf8");
  assert.deepEqual([...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ["PATCH"]);
  assert.doesNotMatch(src, /\bfetch\(|https?:\/\//);
  assert.doesNotMatch(fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8"), /api\/procurement/);
});

// ─── no model, no purchase action, SQL guards ────────────────────────────────────────────────
test("the flag code is rule-based: no model client, no network, no purchase or cancel function", () => {
  for (const file of ["lib/procurement-flags.ts", "lib/procurement-flags-server.ts", "app/api/procurement/flags/route.ts"]) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    assert.doesNotMatch(src, /anthropic-ai|openai\/|@ai-sdk|messages\.create|\bfetch\(/, file);
  }
  const FORBIDDEN = /^(place|submit|buy|purchase|checkout|pay|order|cancel|subscribe|charge|execute|approve)/i;
  for (const key of Object.keys(F)) if (typeof F[key] === "function") assert.doesNotMatch(key, FORBIDDEN, key);
});

test("the SQL is additive, service-role only and idempotent", () => {
  const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "procurement_flag_dismissals.sql"), "utf8");
  assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i, "not even in a comment");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(code, /CREATE TABLE IF NOT EXISTS pds\.procurement_flag_dismissals/);
  assert.match(code, /ENABLE ROW LEVEL SECURITY/);
  assert.match(code, /REVOKE ALL ON pds\.procurement_flag_dismissals FROM anon, authenticated/);
  assert.doesNotMatch(code, /TO anon|TO authenticated|TO public/i);
  for (const col of ["sub_id", "flag_key", "dismissed", "created_at", "updated_at"]) assert.match(code, new RegExp(`\\b${col}\\b`), col);
  const table = code.slice(code.indexOf("CREATE TABLE"), code.indexOf(");"));
  assert.doesNotMatch(table, /merchant|amount|name|date\b/i, "only hashes, a boolean and timestamps are stored");
});
