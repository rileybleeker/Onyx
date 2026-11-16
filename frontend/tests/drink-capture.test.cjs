// Run: node --test tests/drink-capture.test.cjs
// Direct drink capture (PROD-CAFF-01 slice): the product list and matching (lib/drink-products.ts), the pure capture
// rules (lib/drink-capture.ts: bodies, strict instants, quantities, time with DST / 06:00 / travel, replay identity,
// the Nutrition merge, readiness gates and truthful overlap), the Say it parser's drinks (lib/log-voice.ts: unusable
// days / times stay unresolved), the drinks route against an in-memory table (replay before age rules, conflicts,
// revisions, tombstones, verified overlap, complete candidate reads, read by key, kind pinning, missing migration),
// the photo route's kind pin, and the SQL text. Offline and synthetic: no network, no database, no real records.
// Session / recovery / CAS client rules: tests/drink-session.test.cjs. UI source checks: tests/drink-ui.test.cjs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const P = loadTs("lib/drink-products.ts");
const C = loadTs("lib/drink-capture.ts");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const WG = "gorilla-mind-energy-wild-grape-16oz";
const NY = "America/New_York";

// ---------- products and matching ----------

test("the Wild Grape can: a usable, versioned label snapshot with provenance; the model sees ids and names only", () => {
  const p = P.drinkProduct(WG);
  assert.equal(P.validateDrinkProduct(p), null);
  assert.equal(p.version, 1);
  assert.deepEqual(
    { kcal: p.label.kcal, carbs: p.label.carbs_g, protein: p.label.protein_g, fat: p.label.fat_g, sugar: p.label.sugar_g, sodium: p.label.sodium_mg, caffeine: p.label.caffeine_mg, oz: p.label.serving_fl_oz },
    { kcal: 5, carbs: 1, protein: 0, fat: 0, sugar: 0, sodium: 25, caffeine: 200, oz: 16 },
  );
  assert.equal(p.source.read_on, "2026-11-15");
  for (const c of P.drinkCandidates()) assert.deepEqual(Object.keys(c).sort(), ["id", "name"]);
  assert.match(P.validateDrinkProduct({ ...p, label: { ...p.label, caffeine_mg: null } }), /caffeine_mg unknown/);
  assert.equal(P.validateDrinkProduct({ ...p, label: { ...p.label, sodium_mg: null } }), null);
});

test("matching: stated phrase and reversed alias resolve; powder, no flavor, other flavor and other brands do not", () => {
  const m = (s, pick = null) => P.matchDrinkProduct(s, pick);
  assert.equal(m("one wild grape Gorilla Mind").product.id, WG);
  assert.equal(m("Gorilla Mind, Wild Grape").product.id, WG);
  assert.deepEqual(m("Gorilla Mind"), { kind: "unresolved", issue: "flavor" });
  assert.deepEqual(m("Gorilla Mind grape pre-workout"), { kind: "unresolved", issue: "powder" });
  assert.deepEqual(m("Gorilla Mind gorilla mode"), { kind: "unresolved", issue: "powder" });
  assert.deepEqual(m("Gorilla Mind cherry"), { kind: "unresolved", issue: "unknown" });
  assert.equal(m("a red bull"), null);
  assert.deepEqual(m("my energy drink", WG), { kind: "unresolved", issue: "unknown" }, "the model's pick alone never resolves");
});

test("quantities and totals: quarter-step cans from the label snapshot", () => {
  const p = P.drinkProduct(WG);
  assert.equal(C.servingsFrom(1, "can", p), 1);
  assert.equal(C.servingsFrom(8, "fl_oz", p), 0.5);
  assert.equal(C.servingsFrom(10, "fl_oz", p), null);
  assert.equal(C.servingsFrom(1, null, p), null, "no unit = amount not said");
  assert.equal(C.isServings(0.3), false);
  assert.equal(C.servingsText(1.5), "1½ cans");
  assert.deepEqual(C.drinkTotals(p.label, 1), { kcal: 5, protein_g: 0, carbs_g: 1, fat_g: 0, sugar_g: 0, sodium_mg: 25, caffeine_mg: 200 });
  assert.equal(C.drinkTotals(p.label, 2).caffeine_mg, 400);
});

// ---------- time ----------

const iso = (s) => new Date(s).toISOString();

test("instants: only a full ISO timestamp with Z or an offset is accepted (never date-only or zone-less)", () => {
  assert.equal(C.isIsoInstant("2026-11-15T19:05:30Z"), true);
  assert.equal(C.isIsoInstant("2026-11-15T19:05:30.123Z"), true);
  assert.equal(C.isIsoInstant("2026-11-15T14:05:30-05:00"), true);
  assert.equal(C.isIsoInstant("2026-11-15"), false);
  assert.equal(C.isIsoInstant("2026-11-15T14:05"), false);
  assert.equal(C.isIsoInstant("2026-11-15T14:05:30"), false);
  assert.equal(C.isIsoInstant("2026-02-30T14:05:30Z"), false);
  assert.equal(C.isIsoInstant("Sun Nov 15 2026 14:05:30 GMT-0500"), false);
  const now = Date.parse("2026-11-15T19:10:00Z");
  assert.equal(C.resolveDrinkTime({ mode: "now", at: "2026-11-15T14:05", zone: NY }, now, "2026-11-15").problem, "bad_time");
  assert.equal(C.resolveDrinkTime({ mode: "now", at: "2026-11-15", zone: NY }, now, "2026-11-15").problem, "bad_time");
  const body = { client_key: "0b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b", product_id: WG, servings: 1, overlap: "none" };
  assert.match(C.parseDrinkCreate({ ...body, time: { mode: "now", at: "2026-11-15T14:05", zone: NY } }).error, /ISO instant/);
  assert.match(C.parseDrinkCreate({ ...body, time: { mode: "now", at: "2026-11-15", zone: NY } }).error, /ISO instant/);
  assert.equal(C.parseDrinkCreate({ ...body, time: { mode: "now", at: "2026-11-15T14:05:30-05:00", zone: NY } }).ok, true);
});

test("now keeps the captured instant and zone; 06:00 rule; travel uses the device zone", () => {
  const t = C.resolveDrinkTime({ mode: "now", at: iso("2026-11-15T19:05:30Z"), zone: NY }, Date.parse("2026-11-15T19:06:00Z"), "2026-11-15");
  assert.equal(t.eaten_at, "2026-11-15T19:05:30.000Z");
  assert.equal(t.eaten_time, "14:05");
  const late = C.resolveDrinkTime({ mode: "now", at: iso("2026-11-16T06:30:00Z"), zone: NY }, Date.parse("2026-11-16T06:31:00Z"), "2026-11-15");
  assert.equal(late.eaten_date, "2026-11-15");
  const tokyo = C.resolveDrinkTime({ mode: "now", at: iso("2026-11-15T01:00:00Z"), zone: "Asia/Tokyo" }, Date.parse("2026-11-15T01:01:00Z"), "2026-11-14");
  assert.equal(tokyo.eaten_time, "10:00");
  assert.equal(C.resolveDrinkTime({ mode: "now", at: iso("2026-11-12T19:00:00Z"), zone: NY }, Date.parse("2026-11-15T19:00:00Z"), "2026-11-15").problem, "too_old");
  // Without the new-capture window (comparing with a stored drink) the same old instant resolves.
  assert.equal(C.resolveDrinkTime({ mode: "now", at: iso("2026-11-12T19:00:00Z"), zone: NY }, Date.parse("2026-11-15T19:00:00Z"), "2026-11-15", { bounds: false }).ok, true);
});

test("manual clock: 01:30 closes the day; DST gap refused; repeated hour needs earlier / later; bounds still apply", () => {
  const t = C.resolveDrinkTime({ mode: "manual", day: "2026-11-14", time: "01:30", zone: NY, fold: null }, Date.parse("2026-11-15T23:00:00Z"), "2026-11-15");
  assert.equal(t.eaten_at, "2026-11-15T06:30:00.000Z");
  assert.equal(C.resolveDrinkTime({ mode: "manual", day: "2027-03-13", time: "02:30", zone: NY, fold: null }, Date.parse("2027-03-14T20:00:00Z"), "2027-03-14").problem, "nonexistent");
  const fall = Date.parse("2026-11-01T20:00:00Z");
  const amb = C.resolveDrinkTime({ mode: "manual", day: "2026-10-31", time: "01:30", zone: NY, fold: null }, fall, "2026-11-01");
  assert.deepEqual(amb.choices, ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
  assert.equal(C.resolveDrinkTime({ mode: "manual", day: "2026-10-31", time: "01:30", zone: NY, fold: "later" }, fall, "2026-11-01").eaten_at, "2026-11-01T06:30:00.000Z");
  assert.equal(C.resolveDrinkTime({ mode: "manual", day: "2026-11-01", time: "09:00", zone: NY, fold: null }, Date.parse("2026-11-15T23:00:00Z"), "2026-11-15").problem, "too_old");
  assert.equal(C.resolveDrinkTime({ mode: "manual", day: "2026-11-01", time: "09:00", zone: NY, fold: null }, Date.parse("2026-11-15T23:00:00Z"), "2026-11-15", { bounds: false }).ok, true);
  // bounds: false never skips the DST rules.
  assert.equal(C.resolveDrinkTime({ mode: "manual", day: "2026-10-31", time: "01:30", zone: NY, fold: null }, fall, "2026-11-01", { bounds: false }).problem, "ambiguous");
});

test("behavioral today without the database: Eastern wall clock then 06:00, correct across DST", () => {
  // 2026-11-01 05:30 EST (10:30Z), after the fall-back change: still the 10-31 behavioral day (before 06:00 local).
  // Subtracting 6 elapsed hours (04:30Z = 00:30 EDT on 11-01) would wrongly say 11-01.
  assert.equal(C.fallbackBehavioralToday(Date.parse("2026-11-01T10:30:00Z")), "2026-10-31");
  assert.equal(C.fallbackBehavioralToday(Date.parse("2026-11-01T11:30:00Z")), "2026-11-01");
  // Spring forward: 2027-03-14 06:15 EDT (10:15Z) is the new day; "minus 6 h" (04:15Z = 23:15 EST 03-13) is not.
  assert.equal(C.fallbackBehavioralToday(Date.parse("2027-03-14T10:15:00Z")), "2027-03-14");
  assert.match(read("app/api/nutrition/drinks/route.ts"), /return fallbackBehavioralToday\(Date\.now\(\)\);/);
  assert.ok(!/Date\.now\(\) - 6 \* 3_600_000/.test(read("app/api/nutrition/drinks/route.ts")));
});

// ---------- bodies ----------

const KEY = "0b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b";
const NOW_TIME = { mode: "now", at: "2026-11-15T19:05:30.000Z", zone: NY };
const body = (over = {}) => ({ client_key: KEY, product_id: WG, servings: 1, time: NOW_TIME, overlap: "none", ...over });

test("bodies: exact keys, product id shape (catalogue checked by the route), quarter steps, resolved time object", () => {
  assert.equal(C.parseDrinkCreate(body()).ok, true);
  assert.match(C.parseDrinkCreate({ ...body(), caffeine_mg: 0 }).error, /exactly/, "the browser cannot send nutrient values");
  assert.match(C.parseDrinkCreate(body({ product_id: "Gorilla Mind!" })).error, /drink id/);
  assert.equal(C.parseDrinkCreate(body({ product_id: "retired-drink" })).ok, true, "a retired id still parses (replays answer the stored drink)");
  assert.match(C.parseDrinkCreate(body({ servings: 0.3 })).error, /quarter steps/);
  assert.match(C.parseDrinkCreate(body({ time: { mode: "manual", day: "2026-11-15", time: "", zone: NY, fold: null } })).error, /HH:MM/);
  assert.match(C.parseDrinkCreate(body({ overlap: "maybe" })).error, /overlap/);
  assert.match(C.parseDrinkEdit({ ...body(), expected_revision: 0 }).error, /positive/);
  assert.deepEqual(C.parseDrinkRemove({ client_key: KEY, expected_revision: 3 }).value, { client_key: KEY, expected_revision: 3 });
});

// ---------- Nutrition merge ----------

test("Nutrition: a drink adds to any day; an unknown day value stays unknown (never a drink-only 'known' total)", () => {
  const rows = [
    { calendar_date: "2026-11-13", nutrition_source: "cronometer", calories: 2100, protein_g: 150, carbs_g: 200, fat_g: 70, sugar_g: 40, sodium_mg: 2000 },
    { calendar_date: "2026-11-14", nutrition_source: "cronometer", calories: 900, protein_g: null, carbs_g: null, fat_g: null, sugar_g: null, sodium_mg: null },
  ];
  const day = (d, over = {}) => ({ behavioral_date: d, drink_count: 1, kcal: 5, protein_g: 0, carbs_g: 1, fat_g: 0, sugar_g: 0, sodium_mg: 25, ...over });
  const out = C.addDirectDrinks(rows, [day("2026-11-13"), day("2026-11-14"), day("2026-11-15", { kcal: 0, carbs_g: 0 })]);
  assert.equal(out[0].calories, 2105);
  assert.equal(out[0].carbs_g, 201);
  assert.equal(out[0].sodium_mg, 2025);
  assert.equal(out[1].calories, 905);
  assert.equal(out[1].carbs_g, null, "the diary's unknown carbs stay unknown, not the drink's 1 g");
  assert.equal(out[1].protein_g, null);
  assert.equal(out[1].fat_g, null);
  assert.equal(out[2].nutrition_source, "direct_drink");
  assert.equal(out[2].calories, 0, "a zero-kcal drink day is still a row");
  assert.equal(out[2].direct_drink_count, 1);
  assert.equal(C.addDirectDrinks([rows[0]], [day("2026-11-13", { sodium_mg: null })])[0].sodium_mg, null);
  assert.equal(rows[1].calories, 900, "input not mutated");
});

test("getNutrition: only a missing view means 'no drinks'; any other drink read failure propagates", () => {
  const src = read("lib/queries.ts");
  assert.match(src, /if \(drinks\.error && !isMissingRelation\(drinks\.error\.code\)\) throw drinks\.error;/);
  assert.ok(!/console\.error\("direct_drink_daily:/.test(src));
});

test("source labels: + DRINKS, DRINKS alone; KPI tiles take the food source and name drinks in the sublabel", () => {
  const M = loadTs("lib/photo-meal.ts");
  assert.equal(M.daySourceLabel("cronometer", true), "CRONOMETER + DRINKS");
  assert.equal(M.daySourceLabel("direct_drink"), "DRINKS");
  assert.equal(M.rangeSourceLabel(["cronometer", "direct_drink"]), "CRONOMETER + DRINKS");
  assert.equal(M.rangeSourceLabel([]), "CRONOMETER");
  assert.equal(M.baseSourceLabel("direct_drink"), null);
  assert.match(read("app/nutrition/NutritionClient.tsx"), /const drinkNote = latest\?\.nutrition_source === "direct_drink" \? "drinks only"/);
});

// ---------- identity ----------

test("item keys: same capture + slot = same key; slots survive reordering; new capture = new keys", async () => {
  const cap = "11111111-2222-4333-8444-555555555555";
  const a = await C.itemKey(cap, `${WG}#1`);
  assert.equal(await C.itemKey(cap, `${WG}#1`), a);
  assert.notEqual(await C.itemKey(cap, `${WG}#2`), a);
  assert.notEqual(await C.itemKey("11111111-2222-4333-8444-666666666666", `${WG}#1`), a);
  assert.deepEqual(C.itemSlots([{ product_id: WG, said: "x" }, { product_id: null, said: "Gorilla Mind" }, { product_id: WG, said: "y" }]), [`${WG}#1`, "gorillamind#1", `${WG}#2`]);
});

test("replay identity and sameSave compare instants as instants", () => {
  const p = P.drinkProduct(WG);
  const save = C.parseDrinkCreate(body()).value;
  const t = C.resolveDrinkTime(save.time, Date.parse("2026-11-15T19:10:00Z"), "2026-11-15");
  const rec = C.toDrinkRecord({ meal_id: 7, client_key: KEY, capture_kind: "drink", deleted_at: null, revision: 1, ...C.drinkRowValues(C.snapshotOf(p), 1, t, "none") });
  assert.equal(C.sameCapture(rec, save, t), true);
  assert.equal(C.sameCapture(rec, { ...save, servings: 2 }, t), false);
  assert.equal(C.sameSave(save, { ...save, time: { ...NOW_TIME, at: "2026-11-15T14:05:30-05:00" } }), true);
  assert.equal(C.sameSave(save, { ...save, servings: 2 }), false);
  assert.equal(C.sameSave(save, C.saveFromRecord(rec)), true);
  const v = C.drinkRowValues(C.snapshotOf(p), 1, t, "none");
  assert.ok(!JSON.stringify(v).includes("one wild grape"), "no words stored");
});

// ---------- readiness gates ----------

function item(over = {}) {
  return {
    key: KEY, product_id: WG, said: "one wild grape gorilla mind", issue: null, servings: 1, timeMode: "now",
    capturedAt: Date.parse("2026-11-15T19:05:30Z"), day: null, time: null, fold: null, zone: NY, whenIssue: null,
    overlap: null, recent: null, status: "open", saved: null, hold: null, note: null, pending: null, ...over,
  };
}
const check0 = { candidates: [], unchecked: [], drinks: [] };
const ctx = (check = check0, today = "2026-11-15", acknowledged = false) => ({ today, nowMs: Date.parse("2026-11-15T19:10:00Z"), dayCheck: () => check, acknowledged });

test("readiness: product + amount + Now saves; missing amount, unresolved product, unknown or unusable time wait", () => {
  assert.equal(C.itemSave(item(), ctx()).ok, true);
  assert.match(C.itemSave(item({ servings: null }), ctx()).reason, /How much/);
  assert.equal(C.itemSave(item({ product_id: null, issue: P.DRINK_ISSUE_TEXT.powder }), ctx()).reason, P.DRINK_ISSUE_TEXT.powder);
  assert.equal(C.itemSave(item({ timeMode: "manual", day: "2026-11-13", time: null }), ctx()).problem, "bad_time");
  assert.equal(C.itemSave(item({ timeMode: "manual", day: null, time: "09:00", whenIssue: C.WHEN_ISSUE.day }), ctx()).reason, C.WHEN_ISSUE.day, "an unusable said day never becomes today");
  assert.equal(C.itemSave(item(), ctx(check0, null)).ok, false);
  assert.equal(C.itemSave(item(), { ...ctx(), dayCheck: () => null }).ok, false);
  assert.equal(C.itemSave(item(), { ...ctx(), blocked: "Drinks are not set up yet: the database migration is pending." }).ok, false);
  assert.equal(C.afterWhenEdit(C.WHEN_ISSUE.both, "time"), C.WHEN_ISSUE.day);
  assert.equal(C.afterWhenEdit(C.WHEN_ISSUE.day, "time"), C.WHEN_ISSUE.day, "setting the time never resolves a bad day");
  assert.equal(C.afterWhenEdit(C.WHEN_ISSUE.day, "day"), null);
});

test("overlap requires verified nutrition and caffeine independently", () => {
  const cronCaf = { source: "cronometer", name: "Gorilla Mind Energy, Wild Grape", time: "13:50", caffeine_mg: 200, counts_in_nutrition: true };
  const cronNoCaf = { ...cronCaf, caffeine_mg: null };
  const cronNoNutrition = { ...cronCaf, counts_in_nutrition: false };
  const supp = { source: "supplement", name: "Gorilla Mind Gorilla Mode", time: "08:00", caffeine_mg: null };
  const dish = { source: "delivery", name: "Gorilla Mind Energy Drink", time: null, caffeine_mg: null };
  const p = P.drinkProduct(WG);
  for (const cand of [cronCaf, cronNoCaf, supp, dish]) assert.equal(C.itemSave(item(), ctx({ ...check0, candidates: [cand] })).ask, "overlap");
  assert.equal(C.dualChannelOverlaps(p, { ...check0, candidates: [cronCaf, cronNoCaf, supp, dish] }).length, 1);
  assert.equal(C.itemSave(item({ overlap: "in_diary" }), ctx({ ...check0, candidates: [cronCaf] })).save.overlap, "in_diary");
  for (const cand of [cronNoCaf, cronNoNutrition, supp, dish]) {
    const r = C.itemSave(item({ overlap: "in_diary" }), ctx({ ...check0, candidates: [cand] }));
    assert.equal(r.ok, false, `${cand.source}: cannot stand in for both channels`);
    assert.equal(r.ask, "overlap");
  }
  assert.equal(C.itemSave(item({ overlap: "none" }), ctx({ ...check0, candidates: [supp] })).ok, true, "count it here");
  assert.equal(C.itemSave(item(), ctx({ ...check0, unchecked: ["cronometer"] })).ask, "overlap", "could not check is not 'nothing there'");
  assert.equal(C.itemSave(item({ overlap: "in_diary" }), ctx({ ...check0, unchecked: ["cronometer"] })).ok, false);
});

test("readiness: a nearby same drink asks; a legitimate second can goes through; an acknowledged drink is edited without asking", () => {
  const earlier = { meal_id: 1, client_key: "99999999-9999-4999-8999-999999999999", product_id: WG, eaten_at: "2026-11-15T18:00:00.000Z", eaten_date: "2026-11-15" };
  const withEarlier = { ...check0, drinks: [earlier] };
  assert.equal(C.itemSave(item(), ctx(withEarlier)).ask, "recent");
  assert.equal(C.itemSave(item({ recent: "another" }), ctx(withEarlier)).ok, true);
  assert.equal(C.itemSave(item(), ctx(withEarlier, "2026-11-15", true)).ok, true);
});

// ---------- the Say it parser ----------

const V = loadTs("lib/log-voice.ts");
const lists = { products: [{ product_id: "gm-mode", name: "Gorilla Mind Gorilla Mode" }], stacks: [], dishes: [], books: [] };
const clock = { today: "2026-11-15", day: "2026-11-15", now: "14:10", weightToday: "2026-11-15" };
const modelOut = (drinks, extra = {}) => ({
  supplements: [], stacks: [], dishes: [],
  weight: { said: false, value: 0, unit: "lb", date: "" },
  reading: { read: false, book: "", minutes: 0, chapter_from: 0, chapter_through: 0, medium: "none", recall: "", date: "" },
  drinks, not_matched: [],
  journal: { is_journal: false, excerpt: "", title: "", mood: "none", confidence: "none", topics: [] },
  ...extra,
});
const drinkOut = (over = {}) => ({ product_id: WG, said: "wild grape Gorilla Mind", amount: 1, unit: "can", time: "", date: "", ...over });

test("Say it: a drink is a drink (never also a supplement); unknowns stay visible; not_matched deduped", () => {
  const out = modelOut(
    [drinkOut(), drinkOut({ product_id: "", said: "Gorilla Mind", amount: 0, unit: "none", time: "16:00" }), drinkOut({ product_id: "", said: "Celsius" })],
    { supplements: [{ product_id: "gm-mode", said: "wild grape Gorilla Mind", amount: 0, unit: "", times: [], date: "" }], not_matched: ["Celsius", "a walk"] },
  );
  const r = V.parseLogVoice(JSON.stringify(out), lists, clock, "one wild grape Gorilla Mind, a Gorilla Mind at 4, a Celsius");
  assert.equal(r.supplements.length, 0);
  assert.deepEqual(r.drinks[0], { product_id: WG, said: "wild grape Gorilla Mind", issue: null, servings: 1, time: null, date: null, when_issue: null });
  assert.deepEqual(r.drinks[1], { product_id: null, said: "Gorilla Mind", issue: "flavor", servings: null, time: "16:00", date: null, when_issue: null });
  assert.equal(r.drinks[2].issue, "unknown");
  assert.deepEqual(r.not_matched, ["a walk"]);
  assert.ok(!JSON.stringify(V.modelInput("x", lists, clock).drinks).includes("200"));
});

test("Say it: an unusable SAID day or time is kept as an issue, never erased into today / Now", () => {
  const cases = [
    [{ date: "2026-11-07" }, "bad_date"], // eight days back
    [{ date: "2026-11-16" }, "bad_date"], // future
    [{ date: "2026-02-30" }, "bad_date"], // impossible
    [{ date: "last tuesday" }, "bad_date"], // malformed
    [{ time: "25:00" }, "bad_time"],
    [{ time: "noonish" }, "bad_time"],
    [{ date: "2026-11-01", time: "7pm-ish" }, "bad_date_time"],
  ];
  for (const [over, issue] of cases) {
    const r = V.parseLogVoice(modelOut([drinkOut(over)]), lists, clock, "a wild grape Gorilla Mind");
    assert.equal(r.drinks[0].when_issue, issue, JSON.stringify(over));
    if (issue !== "bad_time") assert.equal(r.drinks[0].date, null);
    if (issue !== "bad_date") assert.equal(r.drinks[0].time, null);
    assert.match(r.summary.drinks[0], /when\?/);
  }
  // Absent stays "not said"; a usable earlier day is kept.
  assert.equal(V.parseLogVoice(modelOut([drinkOut({ date: "  ", time: "" })]), lists, clock, "x").drinks[0].when_issue, null);
  const ok = V.parseLogVoice(modelOut([drinkOut({ date: "2026-11-13", time: "9:05" })]), lists, clock, "x").drinks[0];
  assert.deepEqual([ok.date, ok.time, ok.when_issue], ["2026-11-13", "09:05", null]);
  assert.deepEqual(V.drinkWhen(undefined, undefined, clock), { date: null, time: null, issue: null });
  assert.equal(V.drinkWhen(20261113, "", clock).issue, "bad_date", "a non-string value was said");
});

test("Say it: a powder the note also logs as a supplement stays the supplement", () => {
  const out = modelOut([drinkOut({ said: "scoop of Gorilla Mind pre-workout", unit: "none" })], {
    supplements: [{ product_id: "gm-mode", said: "scoop of Gorilla Mind pre-workout", amount: 1, unit: "scoop", times: [], date: "" }],
  });
  const r = V.parseLogVoice(out, lists, clock, "a scoop of Gorilla Mind pre-workout");
  assert.equal(r.supplements.length, 1);
  assert.equal(r.drinks.length, 0);
});

// ---------- the drinks route, against an in-memory table ----------

const ORIGIN = "https://onyx.example";
const headers = (h) => ({ get: (n) => h[n.toLowerCase()] ?? null });

function splitTop(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const likeRe = (p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i");
function orTerm(term) {
  if (term.startsWith("and(")) {
    const parts = splitTop(term.slice(4, -1)).map(orTerm);
    return (r) => parts.every((f) => f(r));
  }
  const [col, op, ...rest] = term.split(".");
  const val = rest.join(".");
  if (op === "eq") return (r) => String(r[col] ?? "") === val;
  if (op === "is") return (r) => (val === "null" ? r[col] == null : false);
  if (op === "ilike") return (r) => typeof r[col] === "string" && likeRe(val).test(r[col]);
  throw new Error(`fake or(): ${term}`);
}

function fakeDb(state) {
  let nextId = 100;
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.op = "select"; this.window = null; this.sortCol = null; }
    select() { return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    update(values) { this.op = "update"; this.payload = values; return this; }
    delete() { this.op = "delete"; return this; }
    eq(col, v) { this.filters.push((r) => r[col] === v); return this; }
    is(col, v) { this.filters.push((r) => (r[col] ?? null) === v); return this; }
    in(col, vs) { this.filters.push((r) => vs.includes(r[col])); return this; }
    gt(col, v) { this.filters.push((r) => Number(r[col]) > v); return this; }
    ilike(col, p) { this.filters.push((r) => typeof r[col] === "string" && likeRe(p).test(r[col])); return this; }
    or(expr) { const terms = splitTop(expr).map(orTerm); this.filters.push((r) => terms.some((f) => f(r))); return this; }
    order(col) { if (!this.sortCol) this.sortCol = col; return this; }
    limit() { return this; }
    range(from, to) { this.window = [from, to]; return this; }
    then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
    run() {
      state.calls.push(`${this.op}:${this.table}`);
      const fail = state.fail?.[`${this.op}:${this.table}`];
      if (fail) return { data: null, error: { code: fail } };
      const rows = state.tables[this.table] ?? (state.tables[this.table] = []);
      const match = (r) => this.filters.every((f) => f(r));
      if (this.op === "select") {
        let hit = rows.filter(match);
        if (this.sortCol) hit = [...hit].sort((a, b) => (a[this.sortCol] < b[this.sortCol] ? -1 : a[this.sortCol] > b[this.sortCol] ? 1 : 0));
        if (this.window) hit = hit.slice(this.window[0], this.window[1] + 1);
        return { data: hit, error: null };
      }
      if (this.op === "insert") {
        if (rows.some((r) => r.client_key === this.payload.client_key)) return { data: null, error: { code: "23505" } };
        const row = { meal_id: nextId++, deleted_at: null, capture_kind: "photo", ...this.payload };
        rows.push(row);
        return { data: [row], error: null };
      }
      if (this.op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) {
          if (r.capture_kind === "drink" && this.payload.revision !== r.revision + 1) return { data: null, error: { code: "OXD04" } };
          if (r.deleted_at && this.payload.deleted_at === null) return { data: null, error: { code: "OXD03" } };
          Object.assign(r, this.payload);
        }
        return { data: hit, error: null };
      }
      const gone = rows.filter(match);
      state.tables[this.table] = rows.filter((r) => !match(r));
      return { data: gone, error: null };
    }
  }
  return {
    from: (table) => new Query(table),
    rpc: async (fn) => (fn === "behavioral_today_now" ? { data: state.today, error: null } : { data: null, error: null }),
  };
}

function loadRoute(state, file = "app/api/nutrition/drinks/route.ts") {
  return loadTs(file, {
    "next/server": { NextResponse: { json: (b, init) => ({ status: init?.status ?? 200, body: b }) } },
    "next/cache": { revalidatePath: (p) => state.revalidated.push(p) },
    "@supabase/supabase-js": { createClient: () => fakeDb(state) },
  });
}

function req(b, over = {}, url = `${ORIGIN}/api/nutrition/drinks`) {
  const text = typeof b === "string" ? b : JSON.stringify(b);
  const u = new URL(url);
  return {
    headers: headers({ origin: ORIGIN, host: "onyx.example", "content-type": "application/json", ...over }),
    nextUrl: { origin: ORIGIN, searchParams: u.searchParams },
    text: async () => text,
  };
}
const get = (R, q) => R.GET(req("", {}, `${ORIGIN}/api/nutrition/drinks${q}`));

function newState() {
  const s = { tables: { photo_meals: [], cronometer_servings: [], delivery_order_items: [], supplement_products: [], supplement_intake: [] }, calls: [], revalidated: [], today: "", fail: {} };
  s.today = C.behavioralDayAt(Date.now() - 60_000, NY);
  return s;
}
const recentNow = () => ({ mode: "now", at: new Date(Date.now() - 60_000).toISOString(), zone: NY });
const K2 = "1b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b";
const K3 = "2b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b";

test("route: create, replay, conflict (never merged), revision edit, stale edit, Undo tombstone, no resurrection, second can", async () => {
  const state = newState();
  const R = loadRoute(state);
  const create = { client_key: KEY, product_id: WG, servings: 1, time: recentNow(), overlap: "none" };

  const a = await R.POST(req(create));
  assert.equal(a.status, 201);
  assert.deepEqual([a.body.record.caffeine_mg, a.body.record.kcal, a.body.record.carbs_g, a.body.record.revision], [200, 5, 1, 1]);
  assert.equal(state.tables.photo_meals[0].capture_kind, "drink");
  assert.ok(!state.calls.some((c) => c.includes("supplement_intake") && !c.startsWith("select")), "never a supplement write");
  assert.deepEqual([...state.revalidated].sort(), ["/caffeine", "/nutrition", "/today"]);

  assert.equal((await R.POST(req(create))).body.replay, true);
  const c = await R.POST(req({ ...create, servings: 2 }));
  assert.equal(c.status, 409);
  assert.equal(c.body.code, "changed");
  assert.equal(state.tables.photo_meals[0].drink_servings, 1, "a conflicting create changes nothing");

  const e = await R.PATCH(req({ ...create, servings: 2, expected_revision: 1 }));
  assert.equal(e.body.record.revision, 2);
  assert.equal((await R.PATCH(req({ ...create, servings: 2, expected_revision: 1 }))).body.replay, true);
  // The stale original create arriving late (lost answer) can never overwrite the later edit.
  const late = await R.POST(req(create));
  assert.equal(late.status, 409);
  assert.equal(state.tables.photo_meals[0].drink_servings, 2);
  const s = await R.PATCH(req({ ...create, servings: 0.5, expected_revision: 1 }));
  assert.equal(s.body.code, "stale");
  assert.equal(state.tables.photo_meals[0].drink_servings, 2);

  // A stale Undo never removes the newer edit.
  assert.equal((await R.DELETE(req({ client_key: KEY, expected_revision: 1 }))).status, 409);
  assert.equal(state.tables.photo_meals[0].deleted_at, null);
  assert.equal((await R.DELETE(req({ client_key: KEY, expected_revision: 2 }))).status, 200);
  assert.ok(state.tables.photo_meals[0].deleted_at);
  assert.equal((await R.DELETE(req({ client_key: KEY, expected_revision: 2 }))).status, 200, "a repeated Undo is done");
  assert.equal((await R.POST(req(create))).status, 410);
  assert.equal((await R.PATCH(req({ ...create, expected_revision: 3 }))).status, 410);

  assert.equal((await R.POST(req({ ...create, client_key: K2 }))).status, 201, "a deliberate second can (new key)");
  assert.equal(state.tables.photo_meals.length, 2);
});

function storedRow(over = {}) {
  const p = P.drinkProduct(WG);
  const at = "2026-11-01T18:00:00.000Z"; // weeks before "now": older than every new-capture window
  const t = C.resolveDrinkTime({ mode: "now", at, zone: NY }, Date.parse(at), "2026-11-01");
  return { meal_id: 5, client_key: KEY, capture_kind: "drink", deleted_at: null, revision: 1, ...C.drinkRowValues(C.snapshotOf(p), 1, t, "none"), ...over };
}

test("route: a stored key is answered before age and catalogue rules (replay / 410 days later); a changed payload is not", async () => {
  const state = newState();
  state.tables.photo_meals.push(storedRow());
  const R = loadRoute(state);
  const old = { client_key: KEY, product_id: WG, servings: 1, time: { mode: "now", at: "2026-11-01T18:00:00.000Z", zone: NY }, overlap: "none" };
  const replay = await R.POST(req(old));
  assert.equal(replay.status, 200, "the original acknowledgement, not too_old");
  assert.equal(replay.body.replay, true);
  assert.equal((await R.PATCH(req({ ...old, expected_revision: 1 }))).body.replay, true);
  const changed = await R.POST(req({ ...old, servings: 2 }));
  assert.equal(changed.status, 409, "a changed payload under an old key is a conflict");
  // An amount edit keeps the stored (old) instant; moving the time back to an old day is refused.
  assert.equal((await R.PATCH(req({ ...old, servings: 2, expected_revision: 1 }))).status, 200);
  const moved = await R.PATCH(req({ ...old, servings: 2, time: { mode: "manual", day: "2026-10-01", time: "12:00", zone: NY, fold: null }, expected_revision: 2 }));
  assert.equal(moved.status, 400, "a changed time must pass the window");
  // A retired product id under its stored key still replays.
  state.tables.photo_meals.push(storedRow({ meal_id: 6, client_key: K2, drink_product_id: "retired-drink", drink_label: { ...C.snapshotOf(P.drinkProduct(WG)), product_id: "retired-drink" } }));
  assert.equal((await R.POST(req({ ...old, client_key: K2, product_id: "retired-drink" }))).status, 200);
  assert.equal((await R.POST(req({ ...old, client_key: K3, product_id: "retired-drink" }))).status, 400, "but not as a new drink");
  // Tombstoned weeks ago: 410, not too_old.
  state.tables.photo_meals[0].deleted_at = "2026-11-02T00:00:00Z";
  assert.equal((await R.POST(req({ ...old, servings: 2 }))).status, 410);
});

test("route: caffeine-only and unattributed Cronometer entries cannot suppress nutrition", async () => {
  const state = newState();
  const R = loadRoute(state);
  const create = (k, over = {}) => ({ client_key: k, product_id: WG, servings: 1, time: recentNow(), overlap: "in_diary", ...over });
  state.tables.supplement_products.push({ product_id: "gm-mode", brand_name: "Gorilla Mind", full_name: "Gorilla Mode" });
  state.tables.supplement_intake.push({ intake_id: 1, product_id: "gm-mode", intake_date: state.today, intake_time: null });
  state.tables.delivery_order_items.push({ item_id: 1, title: "Gorilla Mind Energy Drink", onyx_behavioral_date: state.today, is_cancelled: false, completed_at: null });
  const refused = await R.POST(req(create(KEY)));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "overlap_unverified");
  assert.equal(state.tables.photo_meals.length, 0);
  state.tables.cronometer_servings.push({ serving_id: 1, food_name: "Gorilla Mind Energy Drink, Wild Grape", onyx_behavioral_date: state.today, calendar_date: state.today, event_time: null, caffeine_mg: null });
  assert.equal((await R.POST(req(create(KEY)))).status, 409, "a Cronometer entry without caffeine counts in Nutrition only");
  // A NULL-attribution serving counts on its calendar_date (the caffeine view's COALESCE): it is found.
  state.tables.cronometer_servings.push({ serving_id: 2, food_name: "GorillaMind wild grape", onyx_behavioral_date: null, calendar_date: state.today, event_time: null, caffeine_mg: 200 });
  assert.equal((await R.POST(req(create(KEY)))).status, 409, "caffeine day fallback alone does not prove nutrition");
  Object.assign(state.tables.cronometer_servings[1], { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, sugars_g: 0, sodium_mg: 0 });
  assert.equal((await R.POST(req(create(KEY)))).status, 409, "known values still require nutrition day attribution");
  state.tables.cronometer_servings[1].onyx_behavioral_date = state.today;
  const ok = await R.POST(req(create(KEY)));
  assert.equal(ok.status, 201);
  assert.equal(ok.body.record.overlap, "in_diary");
  state.fail["select:cronometer_servings"] = "57014";
  assert.equal((await R.POST(req(create(K2)))).status, 409, "an unreadable Cronometer cannot verify");
});

test("route GET: complete candidate reads past the first page; truncation and failure are named, never 'none'", async () => {
  const state = newState();
  const d = state.today;
  // 1,200 brand-matching servings the day before... and the 1,201st (by serving_id) on the day: still found.
  for (let i = 1; i <= 1200; i++) state.tables.cronometer_servings.push({ serving_id: i, food_name: `Gorilla Mind Energy #${i}`, onyx_behavioral_date: d, calendar_date: d, event_time: null, caffeine_mg: 0 });
  state.tables.cronometer_servings.push({ serving_id: 5000, food_name: "Gorilla Mind Energy, Wild Grape", onyx_behavioral_date: d, calendar_date: d, event_time: null, caffeine_mg: 200 });
  state.tables.cronometer_servings.push({ serving_id: 5001, food_name: "Eggs", onyx_behavioral_date: d, calendar_date: d, event_time: null, caffeine_mg: 0 });
  state.tables.photo_meals.push(storedRow({ eaten_date: d }), storedRow({ meal_id: 6, client_key: K2, deleted_at: "x", eaten_date: d }), { meal_id: 7, client_key: K3, capture_kind: "photo", deleted_at: null, eaten_date: d });
  const R = loadRoute(state);
  const g = await get(R, "");
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.drinks.map((x) => x.meal_id), [5], "removed drinks and photo meals are not listed");
  assert.ok(g.body.overlaps.some((o) => o.name === "Gorilla Mind Energy, Wild Grape" && o.caffeine_mg === 200), "match beyond the first page");
  assert.ok(!g.body.overlaps.some((o) => o.name === "Eggs"));
  assert.deepEqual(g.body.unavailable, []);
  state.fail["select:supplement_products"] = "57014";
  assert.deepEqual((await get(R, "")).body.unavailable, ["supplements"]);
  // Past the read cap: named as unchecked.
  delete state.fail["select:supplement_products"];
  for (let i = 6000; i < 11100; i++) state.tables.cronometer_servings.push({ serving_id: i, food_name: "Gorilla Mind x", onyx_behavioral_date: d, calendar_date: d, event_time: null, caffeine_mg: 0 });
  assert.deepEqual((await get(R, "")).body.unavailable, ["cronometer"]);
  assert.ok(!state.calls.some((c) => !c.startsWith("select")), "GET only reads");
});

test("route GET ?key=: found / removed / none / other kind; read-only", async () => {
  const state = newState();
  state.tables.photo_meals.push(storedRow(), storedRow({ meal_id: 6, client_key: K2, deleted_at: "2026-11-02T00:00:00Z" }), { meal_id: 7, client_key: K3, capture_kind: "photo", deleted_at: null });
  const R = loadRoute(state);
  assert.equal((await get(R, `?key=${KEY}`)).body.status, "found");
  assert.equal((await get(R, `?key=${KEY}`)).body.record.client_key, KEY);
  assert.equal((await get(R, `?key=${K2}`)).body.status, "removed");
  assert.equal((await get(R, "?key=3b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b")).body.status, "none");
  assert.equal((await get(R, `?key=${K3}`)).status, 409);
  assert.equal((await get(R, "?key=nope")).status, 400);
  assert.ok(!state.calls.some((c) => !c.startsWith("select")));
});

test("route: guards, other-kind keys, missing migration, turned off", async () => {
  const state = newState();
  const R = loadRoute(state);
  const create = { client_key: KEY, product_id: WG, servings: 1, time: recentNow(), overlap: "none" };
  assert.equal((await R.POST(req(create, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await R.POST(req(create, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await R.POST(req({ ...create, caffeine_mg: 0 }))).status, 400);
  assert.equal((await R.POST(req({ ...create, product_id: "not-a-drink" }))).status, 400);
  assert.equal((await R.POST(req({ ...create, time: { ...create.time, at: new Date(Date.now() + 3_600_000).toISOString() } }))).status, 400);
  state.tables.photo_meals.push({ meal_id: 1, client_key: KEY, capture_kind: "photo", deleted_at: null, revision: 1 });
  assert.equal((await R.POST(req(create))).body.code, "other_kind");
  assert.equal((await R.DELETE(req({ client_key: KEY, expected_revision: 1 }))).status, 404, "never removes a photo meal");
  const m = newState();
  m.fail["select:photo_meals"] = "42703";
  const M = loadRoute(m);
  const res = await M.POST(req({ ...create, client_key: K2 }));
  assert.equal(res.status, 503);
  assert.match(res.body.error, /migration is pending/);
  assert.equal((await get(M, "")).status, 503);
  m.fail = { "insert:photo_meals": "OXD00" };
  assert.match((await M.POST(req({ ...create, client_key: K3 }))).body.error, /turned off/);
});

test("photo route: delete and re-read are pinned to photo rows", async () => {
  const src = read("app/api/nutrition/photo-meals/route.ts");
  assert.match(src, /q\.eq\("capture_kind", "photo"\)/);
  const state = newState();
  state.tables.photo_meals.push({ meal_id: 9, client_key: KEY, capture_kind: "drink", deleted_at: null, revision: 1 });
  const R = loadTs("app/api/nutrition/photo-meals/route.ts", {
    "next/server": { NextResponse: { json: (b, init) => ({ status: init?.status ?? 200, body: b }) } },
    "next/cache": { revalidatePath: () => {} },
    "@supabase/supabase-js": { createClient: () => fakeDb(state) },
  });
  assert.equal((await R.DELETE(req({ meal_id: 9 }, {}, `${ORIGIN}/api/nutrition/photo-meals`))).status, 404);
  assert.equal(state.tables.photo_meals.length, 1);
});

// ---------- the SQL ----------

test("SQL: additive, NULL-safe drink constraint, kind-pinned projections, one caffeine branch, invoker views, no anon grant", () => {
  const root = path.join(SRC, "..", "..", "sql");
  const sql = fs.readFileSync(path.join(root, "direct_drink_capture.sql"), "utf8");
  const off = fs.readFileSync(path.join(root, "direct_drink_capture_off.sql"), "utf8");
  const check = fs.readFileSync(path.join(root, "checks", "verify_direct_drink_capture.sql"), "utf8");
  const code = (s) => s.replace(/--.*$/gm, "");
  for (const s of [sql, off, check]) assert.ok(!/drop/i.test(s), "the word never appears, comments included (MCP rule)");
  for (const s of [sql, off]) {
    assert.ok(!/\bCASCADE\b/i.test(code(s)));
    assert.ok(!/\bGRANT\b[^;]*\banon\b/i.test(code(s)));
  }
  assert.ok(!/APPENDIX/.test(sql), "no commented duplicate of the off switch / check in the migration");
  assert.match(sql, /sql\/direct_drink_capture_off\.sql/);
  const live = code(sql);
  assert.match(live, /ADD COLUMN IF NOT EXISTS capture_kind\s+TEXT\s+NOT NULL DEFAULT 'photo'/);
  // NULL-safe: COALESCE(..., false) and explicit IS NOT NULL on every required drink field; quarter steps.
  assert.match(live, /CHECK \(\s*COALESCE\(/);
  for (const f of ["drink_product_id", "drink_product_version", "drink_servings", "drink_label", "caffeine_mg", "time_zone", "eaten_at"]) {
    assert.match(live, new RegExp(`${f} IS NOT NULL`), f);
  }
  assert.match(live, /drink_servings \* 4 = round\(drink_servings \* 4\)/);
  assert.match(live, /drink_servings >= 0\.25 AND drink_servings <= 6/);
  assert.match(live, /CREATE OR REPLACE VIEW pds\.photo_meal_daily WITH \(security_invoker = true\)[\s\S]*WHERE capture_kind = 'photo'/);
  assert.match(live, /CREATE OR REPLACE VIEW pds\.direct_drink_daily WITH \(security_invoker = true\)[\s\S]*deleted_at IS NULL[\s\S]*diary_overlap = 'none'/);
  assert.equal((live.match(/'direct_capture:'/g) ?? []).length, 1);
  // The existing two caffeine branches are identical in the migration and the off switch (deployed semantics).
  const branches = (s) => code(s).slice(code(s).indexOf("CREATE OR REPLACE VIEW pds.caffeine_events"), code(s).indexOf("FROM pds.cronometer_servings s") + 80);
  assert.equal(branches(sql), branches(off));
  assert.ok(!/direct_capture/.test(code(off)), "off: drinks leave Caffeine");
  assert.match(code(off), /WHERE false/);
  assert.match(code(off), /drink capture is turned off' USING ERRCODE = 'OXD00'/);
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION"), sql.indexOf("$$ LANGUAGE plpgsql"));
  const drinkBranch = fn.slice(fn.indexOf("IF NEW.capture_kind = 'drink'"), fn.indexOf("-- Photo meals"));
  assert.ok(!/NEW\.eaten_at\s*:=/.test(drinkBranch));
  assert.match(check, /BEGIN;[\s\S]*ROLLBACK;\s*$/);
  assert.match(check, /NULL drink_product_version allowed/);
  assert.match(check, /non-quarter servings allowed/);
});
