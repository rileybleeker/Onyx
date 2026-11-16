// Run: node --test tests/drink-capture.test.cjs
// Direct drink capture (PROD-CAFF-01 slice): the product list and matching (lib/drink-products.ts), the pure capture
// rules (lib/drink-capture.ts: bodies, quantities, time with DST / 06:00 / travel, replay identity, the Nutrition merge,
// readiness gates), the Say it parser's drinks (lib/log-voice.ts), the drinks route against an in-memory table
// (idempotency, conflicts, revisions, tombstones, kind pinning, missing migration), the photo route's kind pin, and
// source checks (no writes on open / scroll, both pages refresh). Offline and synthetic: no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const P = loadTs("lib/drink-products.ts");
const C = loadTs("lib/drink-capture.ts");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const WG = "gorilla-mind-energy-wild-grape-16oz";

// ---------- products and matching ----------

test("the Wild Grape can: a usable, versioned label snapshot with provenance", () => {
  const p = P.drinkProduct(WG);
  assert.ok(p);
  assert.equal(P.validateDrinkProduct(p), null);
  assert.equal(p.version, 1);
  assert.deepEqual(
    { kcal: p.label.kcal, carbs: p.label.carbs_g, protein: p.label.protein_g, fat: p.label.fat_g, sugar: p.label.sugar_g, sodium: p.label.sodium_mg, caffeine: p.label.caffeine_mg, oz: p.label.serving_fl_oz },
    { kcal: 5, carbs: 1, protein: 0, fat: 0, sugar: 0, sodium: 25, caffeine: 200, oz: 16 },
  );
  assert.match(p.source.page, /^https:\/\/gorillamind\.com\//);
  assert.equal(p.source.read_on, "2026-11-15");
  // The model sees ids and names, never the numbers.
  for (const c of P.drinkCandidates()) assert.deepEqual(Object.keys(c).sort(), ["id", "name"]);
});

test("a product with an unknown required value is not usable (never read as 0)", () => {
  const p = P.drinkProduct(WG);
  assert.match(P.validateDrinkProduct({ ...p, label: { ...p.label, caffeine_mg: null } }), /caffeine_mg unknown/);
  assert.match(P.validateDrinkProduct({ ...p, label: { ...p.label, kcal: -1 } }), /kcal unknown/);
  assert.equal(P.validateDrinkProduct({ ...p, label: { ...p.label, sodium_mg: null } }), null, "optional values may be unknown");
  assert.equal(P.drinkProduct("gorilla-mind"), null);
});

test("matching: stated phrase and reversed alias resolve; powder, no flavor, other flavor and other brands do not", () => {
  const m = (s, pick = null) => P.matchDrinkProduct(s, pick);
  assert.equal(m("one wild grape Gorilla Mind").product.id, WG);
  assert.equal(m("Gorilla Mind, Wild Grape").product.id, WG);
  assert.equal(m("gorillamind grape can").product.id, WG);
  assert.deepEqual(m("Gorilla Mind"), { kind: "unresolved", issue: "flavor" });
  assert.deepEqual(m("Gorilla Mind grape pre-workout"), { kind: "unresolved", issue: "powder" });
  assert.deepEqual(m("a scoop of Gorilla Mind wild grape powder"), { kind: "unresolved", issue: "powder" });
  assert.deepEqual(m("Gorilla Mode"), null, "no brand words for the drink at all");
  assert.deepEqual(m("Gorilla Mind gorilla mode"), { kind: "unresolved", issue: "powder" });
  assert.deepEqual(m("Gorilla Mind cherry"), { kind: "unresolved", issue: "unknown" });
  assert.equal(m("a red bull"), null);
  assert.deepEqual(m("my energy drink", WG), { kind: "unresolved", issue: "unknown" }, "the model's pick alone never resolves");
});

// ---------- quantities ----------

test("quantities: cans in quarter steps; fl oz converted from the label; anything unclean asks", () => {
  const p = P.drinkProduct(WG);
  assert.equal(C.servingsFrom(1, "can", p), 1);
  assert.equal(C.servingsFrom(0.5, "can", p), 0.5);
  assert.equal(C.servingsFrom(2, "can", null), 2);
  assert.equal(C.servingsFrom(8, "fl_oz", p), 0.5);
  assert.equal(C.servingsFrom(10, "fl_oz", p), null);
  assert.equal(C.servingsFrom(8, "fl_oz", null), null, "ounces need a known container");
  assert.equal(C.servingsFrom(0, "can", p), null);
  assert.equal(C.servingsFrom(1, null, p), null, "no unit = amount not said");
  assert.equal(C.servingsFrom(7, "can", p), null);
  assert.equal(C.isServings(0.3), false);
  assert.equal(C.servingsText(1), "1 can");
  assert.equal(C.servingsText(0.5), "½ can");
  assert.equal(C.servingsText(2), "2 cans");
  assert.equal(C.servingsText(1.5), "1½ cans");
});

test("totals come from the label snapshot: half, one, two cans; unknown optional stays null", () => {
  const p = P.drinkProduct(WG);
  assert.deepEqual(C.drinkTotals(p.label, 1), { kcal: 5, protein_g: 0, carbs_g: 1, fat_g: 0, sugar_g: 0, sodium_mg: 25, caffeine_mg: 200 });
  assert.equal(C.drinkTotals(p.label, 0.5).caffeine_mg, 100);
  assert.equal(C.drinkTotals(p.label, 0.5).kcal, 2.5);
  assert.equal(C.drinkTotals(p.label, 2).caffeine_mg, 400);
  assert.equal(C.drinkTotals({ ...p.label, sodium_mg: null }, 1).sodium_mg, null);
});

// ---------- time ----------

const NY = "America/New_York";
const iso = (s) => new Date(s).toISOString();

test("now keeps the captured instant and zone; behavioral day by the 06:00 rule", () => {
  const now = Date.parse("2026-11-15T19:05:30Z"); // 14:05 in New York
  const t = C.resolveDrinkTime({ mode: "now", at: iso("2026-11-15T19:05:30Z"), zone: NY }, now, "2026-11-15");
  assert.equal(t.ok, true);
  assert.equal(t.eaten_at, "2026-11-15T19:05:30.000Z");
  assert.equal(t.eaten_date, "2026-11-15");
  assert.equal(t.eaten_time, "14:05");
  assert.equal(t.time_source, "now");
  // 01:30 local belongs to the behavioral day before.
  const late = C.resolveDrinkTime({ mode: "now", at: iso("2026-11-16T06:30:00Z"), zone: NY }, Date.parse("2026-11-16T06:31:00Z"), "2026-11-15");
  assert.equal(late.eaten_date, "2026-11-15");
  assert.equal(late.eaten_time, "01:30");
  // Travel: the device's zone decides the local clock and day (never noon New York).
  const tokyo = C.resolveDrinkTime({ mode: "now", at: iso("2026-11-15T01:00:00Z"), zone: "Asia/Tokyo" }, Date.parse("2026-11-15T01:01:00Z"), "2026-11-14");
  assert.equal(tokyo.eaten_time, "10:00");
  assert.equal(tokyo.eaten_date, "2026-11-15");
});

test("now: future, too old and bad zones are refused", () => {
  const now = Date.parse("2026-11-15T19:00:00Z");
  assert.equal(C.resolveDrinkTime({ mode: "now", at: iso("2026-11-15T19:30:00Z"), zone: NY }, now, "2026-11-15").problem, "future");
  assert.equal(C.resolveDrinkTime({ mode: "now", at: iso("2026-11-12T19:00:00Z"), zone: NY }, now, "2026-11-15").problem, "too_old");
  assert.equal(C.resolveDrinkTime({ mode: "now", at: iso("2026-11-15T18:00:00Z"), zone: "Mars/Olympus" }, now, "2026-11-15").problem, "bad_zone");
});

test("manual clock time: converted in its zone; 01:30 closes the day; DST gap refused, repeated hour needs a choice", () => {
  const now = Date.parse("2026-11-15T23:00:00Z");
  const t = C.resolveDrinkTime({ mode: "manual", day: "2026-11-14", time: "01:30", zone: NY, fold: null }, now, "2026-11-15");
  assert.equal(t.ok, true);
  assert.equal(t.eaten_at, "2026-11-15T06:30:00.000Z", "01:30 on behavioral 11-14 is calendar 11-15 01:30 EST");
  assert.equal(t.eaten_date, "2026-11-14");

  // 2027-03-14 02:30 New York does not exist (spring forward); behavioral day 03-13 + 02:30 -> calendar 03-14.
  const spring = Date.parse("2027-03-14T20:00:00Z");
  assert.equal(C.resolveDrinkTime({ mode: "manual", day: "2027-03-13", time: "02:30", zone: NY, fold: null }, spring, "2027-03-14").problem, "nonexistent");

  // 2026-11-01 01:30 New York happened twice (fall back): behavioral day 10-31.
  const fall = Date.parse("2026-11-01T20:00:00Z");
  const amb = C.resolveDrinkTime({ mode: "manual", day: "2026-10-31", time: "01:30", zone: NY, fold: null }, fall, "2026-11-01");
  assert.equal(amb.problem, "ambiguous");
  assert.deepEqual(amb.choices, ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
  assert.equal(C.resolveDrinkTime({ mode: "manual", day: "2026-10-31", time: "01:30", zone: NY, fold: "earlier" }, fall, "2026-11-01").eaten_at, "2026-11-01T05:30:00.000Z");
  assert.equal(C.resolveDrinkTime({ mode: "manual", day: "2026-10-31", time: "01:30", zone: NY, fold: "later" }, fall, "2026-11-01").eaten_at, "2026-11-01T06:30:00.000Z");

  assert.equal(C.resolveDrinkTime({ mode: "manual", day: "2026-11-16", time: "09:00", zone: NY, fold: null }, now, "2026-11-15").problem, "future");
  assert.equal(C.resolveDrinkTime({ mode: "manual", day: "2026-11-15", time: "22:00", zone: NY, fold: null }, Date.parse("2026-11-15T20:00:00Z"), "2026-11-15").problem, "future");
  assert.equal(C.resolveDrinkTime({ mode: "manual", day: "2026-11-01", time: "09:00", zone: NY, fold: null }, now, "2026-11-15").problem, "too_old");
});

// ---------- bodies ----------

const KEY = "0b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b";
const NOW_TIME = { mode: "now", at: "2026-11-15T19:05:30.000Z", zone: NY };
const body = (over = {}) => ({ client_key: KEY, product_id: WG, servings: 1, time: NOW_TIME, overlap: "none", ...over });

test("bodies: exact keys, trusted product id, quarter-step amounts, a resolved time object", () => {
  assert.equal(C.parseDrinkCreate(body()).ok, true);
  assert.match(C.parseDrinkCreate({ ...body(), kcal: 5 }).error, /exactly/);
  assert.match(C.parseDrinkCreate({ ...body(), caffeine_mg: 0 }).error, /exactly/, "the browser cannot send nutrient values");
  assert.match(C.parseDrinkCreate(body({ product_id: "gorilla-mind" })).error, /not a known drink/);
  assert.match(C.parseDrinkCreate(body({ servings: 0.3 })).error, /quarter steps/);
  assert.match(C.parseDrinkCreate(body({ servings: 0 })).error, /quarter steps/);
  assert.match(C.parseDrinkCreate(body({ client_key: "nope" })).error, /UUID/);
  assert.match(C.parseDrinkCreate(body({ time: { mode: "manual", day: "2026-11-15", time: "", zone: NY, fold: null } })).error, /HH:MM/, "unknown time is never accepted");
  assert.match(C.parseDrinkCreate(body({ time: { mode: "manual", day: "2026-11-15", time: "12:00", zone: NY } })).error, /exactly/);
  assert.match(C.parseDrinkCreate(body({ overlap: "maybe" })).error, /overlap/);
  assert.equal(C.parseDrinkCreate(body({ client_key: KEY.toUpperCase() })).value.client_key, KEY);
  assert.equal(C.parseDrinkEdit({ ...body(), expected_revision: 2 }).ok, true);
  assert.match(C.parseDrinkEdit(body()).error, /exactly/);
  assert.match(C.parseDrinkEdit({ ...body(), expected_revision: 0 }).error, /positive/);
  assert.deepEqual(C.parseDrinkRemove({ client_key: KEY, expected_revision: 3 }).value, { client_key: KEY, expected_revision: 3 });
  assert.equal(C.parseDrinkRemove({ client_key: KEY }).ok, false);
});

// ---------- Nutrition merge ----------

test("Nutrition: a distinct drink adds to a Cronometer day, an estimate day, and alone makes a DRINKS day; zero kcal still counts", () => {
  const rows = [
    { calendar_date: "2026-11-13", nutrition_source: "cronometer", calories: 2100, protein_g: 150, carbs_g: 200, fat_g: 70, sugar_g: 40, sodium_mg: 2000 },
    { calendar_date: "2026-11-14", nutrition_source: "uber_eats", calories: 900, protein_g: 40, carbs_g: 90, fat_g: 30, sugar_g: null, sodium_mg: null },
  ];
  const day = (d, over = {}) => ({ behavioral_date: d, drink_count: 1, kcal: 5, protein_g: 0, carbs_g: 1, fat_g: 0, sugar_g: 0, sodium_mg: 25, ...over });
  const out = C.addDirectDrinks(rows, [day("2026-11-13"), day("2026-11-14"), day("2026-11-15", { kcal: 0, carbs_g: 0 })]);
  assert.equal(out.length, 3);
  assert.equal(out[0].calories, 2105, "the diary day keeps its source and adds the drink");
  assert.equal(out[0].carbs_g, 201);
  assert.equal(out[0].sodium_mg, 2025);
  assert.equal(out[0].nutrition_source, "cronometer");
  assert.equal(out[0].direct_drink_count, 1);
  assert.equal(out[1].calories, 905);
  assert.equal(out[1].sodium_mg, null, "an unknown day value stays unknown");
  assert.equal(out[2].nutrition_source, "direct_drink");
  assert.equal(out[2].calories, 0, "a zero-kcal drink day is still a row");
  assert.equal(out[2].direct_drink_count, 1);
  assert.equal(rows[0].calories, 2100, "input rows are not mutated");
  // Unknown drink sodium: the day total is unknown, never the diary value alone.
  assert.equal(C.addDirectDrinks([rows[0]], [day("2026-11-13", { sodium_mg: null })])[0].sodium_mg, null);
});

test("source labels: + DRINKS on any day kind, DRINKS alone", () => {
  const M = loadTs("lib/photo-meal.ts");
  assert.equal(M.daySourceLabel("cronometer", true), "CRONOMETER + DRINKS");
  assert.equal(M.daySourceLabel("photo", true), "PHOTO EST. + DRINKS");
  assert.equal(M.daySourceLabel("direct_drink"), "DRINKS");
  assert.equal(M.daySourceLabel("cronometer"), "CRONOMETER");
  assert.equal(M.rangeSourceLabel(["direct_drink"]), "DRINKS");
  assert.equal(M.rangeSourceLabel(["cronometer", "direct_drink"]), "CRONOMETER + DRINKS");
  assert.equal(M.rangeSourceLabel(["cronometer"], true), "CRONOMETER + DRINKS");
  assert.equal(M.rangeSourceLabel([]), "CRONOMETER");
  assert.equal(M.isEstimateSource("direct_drink"), false, "a label-snapshot drink is not an estimate");
  // The KPI tiles take the food source only (drinks are named in their sublabel).
  assert.equal(M.baseSourceLabel("direct_drink"), null);
  assert.equal(M.baseSourceLabel("cronometer"), "CRONOMETER");
  assert.match(read("app/nutrition/NutritionClient.tsx"), /const drinkNote = latest\?\.nutrition_source === "direct_drink" \? "drinks only"/);
});

// ---------- identity ----------

test("item keys: same capture + slot = same key (retry, remount); new capture = new keys; slots survive reordering", async () => {
  const cap = "11111111-2222-4333-8444-555555555555";
  const a = await C.itemKey(cap, `${WG}#1`);
  assert.equal(await C.itemKey(cap, `${WG}#1`), a);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(await C.itemKey(cap, `${WG}#2`), a, "two cans in one note are two drinks");
  assert.notEqual(await C.itemKey("11111111-2222-4333-8444-666666666666", `${WG}#1`), a, "a deliberate new capture is new");
  assert.deepEqual(C.itemSlots([{ product_id: WG, said: "x" }, { product_id: null, said: "Gorilla Mind" }, { product_id: WG, said: "y" }]), [`${WG}#1`, "gorillamind#1", `${WG}#2`]);
  assert.notEqual(C.newUuid(), C.newUuid());
});

test("replay identity: same normalized capture only", () => {
  const p = P.drinkProduct(WG);
  const save = C.parseDrinkCreate(body()).value;
  const t = C.resolveDrinkTime(save.time, Date.parse("2026-11-15T19:10:00Z"), "2026-11-15");
  const rec = C.toDrinkRecord({ meal_id: 7, client_key: KEY, capture_kind: "drink", deleted_at: null, revision: 1, ...C.drinkRowValues(C.snapshotOf(p), 1, t, "none") });
  assert.equal(C.sameCapture(rec, save, t), true);
  assert.equal(C.sameCapture(rec, { ...save, servings: 2 }, t), false);
  assert.equal(C.sameCapture(rec, { ...save, overlap: "in_diary" }, t), false);
  const later = C.resolveDrinkTime({ ...NOW_TIME, at: "2026-11-15T19:06:30.000Z" }, Date.parse("2026-11-15T19:10:00Z"), "2026-11-15");
  assert.equal(C.sameCapture(rec, save, later), false);
  // The stored row carries the frozen label with its provenance, the item shape of a photo meal, and no words.
  const v = C.drinkRowValues(C.snapshotOf(p), 1, t, "none");
  assert.equal(v.drink_label.source.read_on, "2026-11-15");
  assert.deepEqual(Object.keys(v.items[0]).sort(), ["carbs_g", "fat_g", "kcal", "name", "portion", "protein_g"]);
  assert.ok(!("said" in v) && !JSON.stringify(v).includes("one wild grape"));
  // saveFromRecord round-trips a stored drink for list edits.
  assert.deepEqual(C.saveFromRecord(rec), { client_key: KEY, product_id: WG, servings: 1, time: { mode: "now", at: rec.eaten_at, zone: NY }, overlap: "none" });
});

// ---------- readiness gates (what blocks autosave) ----------

function item(over = {}) {
  return {
    key: KEY, product_id: WG, said: "one wild grape gorilla mind", issue: null, servings: 1, timeMode: "now",
    capturedAt: Date.parse("2026-11-15T19:05:30Z"), day: null, time: null, fold: null, zone: NY,
    overlap: null, recent: null, status: "open", saved: null, ...over,
  };
}
const ctx = (check = { candidates: [], unchecked: [], drinks: [] }, today = "2026-11-15") => ({ today, nowMs: Date.parse("2026-11-15T19:10:00Z"), dayCheck: () => check });

test("readiness: an unambiguous product + amount + Now saves; missing amount, unresolved product, unknown historical time wait", () => {
  C.drinkSession.reset();
  const ok = C.itemSave(item(), ctx());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.save, { client_key: KEY, product_id: WG, servings: 1, time: { mode: "now", at: "2026-11-15T19:05:30.000Z", zone: NY }, overlap: "none" });
  assert.match(C.itemSave(item({ servings: null }), ctx()).reason, /How much/);
  assert.equal(C.itemSave(item({ product_id: null, issue: P.DRINK_ISSUE_TEXT.powder }), ctx()).reason, P.DRINK_ISSUE_TEXT.powder);
  const hist = C.itemSave(item({ timeMode: "manual", day: "2026-11-13", time: null }), ctx());
  assert.equal(hist.ok, false);
  assert.equal(hist.problem, "bad_time", "another day without a clock time is never saved");
  assert.equal(C.itemSave(item(), ctx(undefined, null)).ok, false, "nothing saves before behavioral today is known");
  assert.equal(C.itemSave(item(), { ...ctx(), dayCheck: () => null }).ok, false, "nothing saves before the day was checked");
});

test("readiness: likely overlap or an unchecked source asks; a nearby same drink asks; a legitimate second can goes through", () => {
  C.drinkSession.reset();
  const cron = { candidates: [{ source: "cronometer", name: "Gorilla Mind Energy, Wild Grape", time: "13:50" }], unchecked: [], drinks: [] };
  assert.equal(C.itemSave(item(), ctx(cron)).ask, "overlap");
  assert.equal(C.itemSave(item({ overlap: "in_diary" }), ctx(cron)).save.overlap, "in_diary");
  assert.equal(C.itemSave(item({ overlap: "none" }), ctx(cron)).ok, true);
  assert.equal(C.itemSave(item(), ctx({ candidates: [], unchecked: ["cronometer"], drinks: [] })).ask, "overlap", "could not check is not 'nothing there'");
  const earlier = { meal_id: 1, client_key: "99999999-9999-4999-8999-999999999999", product_id: WG, eaten_at: "2026-11-15T18:00:00.000Z", eaten_date: "2026-11-15" };
  const withEarlier = { candidates: [], unchecked: [], drinks: [earlier] };
  assert.equal(C.itemSave(item(), ctx(withEarlier)).ask, "recent");
  assert.equal(C.itemSave(item({ recent: "another" }), ctx(withEarlier)).ok, true, "two identical cans are legitimate once Riley says so");
  // Once acknowledged, the drink is edited without asking again.
  C.drinkSession.remember({ ...earlier, client_key: KEY, revision: 1 });
  assert.equal(C.itemSave(item(), ctx(withEarlier)).ok, true);
  C.drinkSession.reset();
});

test("session: the same key is adopted once (a repeated Fill keeps its state); state outlives the component", () => {
  C.drinkSession.reset();
  assert.equal(C.drinkSession.adopt(item()), true);
  C.drinkSession.update(KEY, { servings: 2 });
  assert.equal(C.drinkSession.adopt(item()), false);
  assert.equal(C.drinkSession.get(KEY).servings, 2);
  C.drinkSession.reset();
});

// ---------- the Say it parser ----------

test("Say it: a drink is a drink (never also a supplement), unknowns stay visible, amounts and times kept", () => {
  const V = loadTs("lib/log-voice.ts");
  const lists = { products: [{ product_id: "gm-mode", name: "Gorilla Mind Gorilla Mode" }], stacks: [], dishes: [], books: [] };
  const clock = { today: "2026-11-15", day: "2026-11-15", now: "14:10", weightToday: "2026-11-15" };
  const out = {
    supplements: [{ product_id: "gm-mode", said: "wild grape Gorilla Mind", amount: 0, unit: "", times: [], date: "" }],
    stacks: [], dishes: [],
    weight: { said: false, value: 0, unit: "lb", date: "" },
    reading: { read: false, book: "", minutes: 0, chapter_from: 0, chapter_through: 0, medium: "none", recall: "", date: "" },
    drinks: [
      { product_id: WG, said: "wild grape Gorilla Mind", amount: 1, unit: "can", time: "", date: "" },
      { product_id: "", said: "Gorilla Mind", amount: 0, unit: "none", time: "16:00", date: "" },
      { product_id: WG, said: "half a can of grape Gorilla Mind", amount: 0.5, unit: "can", time: "", date: "2026-11-14" },
      { product_id: "", said: "Celsius", amount: 1, unit: "can", time: "", date: "" },
    ],
    not_matched: ["Celsius", "a walk"],
    journal: { is_journal: false, excerpt: "", title: "", mood: "none", confidence: "none", topics: [] },
  };
  const r = V.parseLogVoice(JSON.stringify(out), lists, clock, "one wild grape Gorilla Mind, a Gorilla Mind at 4, half a can of grape Gorilla Mind yesterday, a Celsius");
  assert.ok(r);
  assert.equal(r.supplements.length, 0, "the drink did not become a supplement draft");
  assert.equal(r.drinks.length, 4);
  assert.deepEqual(r.drinks[0], { product_id: WG, said: "wild grape Gorilla Mind", issue: null, servings: 1, time: null, date: null });
  assert.deepEqual(r.drinks[1], { product_id: null, said: "Gorilla Mind", issue: "flavor", servings: null, time: "16:00", date: null });
  assert.equal(r.drinks[2].servings, 0.5);
  assert.equal(r.drinks[2].date, "2026-11-14");
  assert.equal(r.drinks[3].issue, "unknown");
  assert.deepEqual(r.not_matched, ["a walk"], "a drink is shown in Drinks, not again as not matched");
  assert.equal(r.summary.drinks.length, 4);
  assert.match(r.summary.drinks[0], /Wild Grape, 1 can/);
  // The model's input carries ids and names only.
  const input = V.modelInput("x", lists, clock);
  assert.ok(Array.isArray(input.drinks) && !JSON.stringify(input.drinks).includes("200"));
  assert.ok(V.LOG_VOICE_SCHEMA.required.includes("drinks"));
});

test("Say it: a powder the note also logs as a supplement stays the supplement", () => {
  const V = loadTs("lib/log-voice.ts");
  const lists = { products: [{ product_id: "gm-mode", name: "Gorilla Mind Gorilla Mode" }], stacks: [], dishes: [], books: [] };
  const clock = { today: "2026-11-15", day: "2026-11-15", now: "14:10", weightToday: "2026-11-15" };
  const out = {
    supplements: [{ product_id: "gm-mode", said: "scoop of Gorilla Mind pre-workout", amount: 1, unit: "scoop", times: [], date: "" }],
    stacks: [], dishes: [], weight: { said: false, value: 0, unit: "lb", date: "" },
    reading: { read: false, book: "", minutes: 0, chapter_from: 0, chapter_through: 0, medium: "none", recall: "", date: "" },
    drinks: [{ product_id: WG, said: "scoop of Gorilla Mind pre-workout", amount: 1, unit: "none", time: "", date: "" }],
    not_matched: [], journal: { is_journal: false, excerpt: "", title: "", mood: "none", confidence: "none", topics: [] },
  };
  const r = V.parseLogVoice(out, lists, clock, "a scoop of Gorilla Mind pre-workout");
  assert.equal(r.supplements.length, 1);
  assert.equal(r.drinks.length, 0);
});

// ---------- the drinks route, against an in-memory table ----------

const ORIGIN = "https://onyx.example";
const headers = (h) => ({ get: (n) => h[n.toLowerCase()] ?? null });

function fakeDb(state) {
  let nextId = 100;
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.op = "select"; }
    select() { return this; }
    insert(row) { this.op = "insert"; this.payload = row; return this; }
    update(values) { this.op = "update"; this.payload = values; return this; }
    delete() { this.op = "delete"; return this; }
    eq(col, v) { this.filters.push((r) => r[col] === v); return this; }
    is(col, v) { this.filters.push((r) => (r[col] ?? null) === v); return this; }
    in(col, vs) { this.filters.push((r) => vs.includes(r[col])); return this; }
    order() { return this; }
    limit() { return this; }
    then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
    run() {
      state.calls.push(`${this.op}:${this.table}`);
      const fail = state.fail?.[`${this.op}:${this.table}`];
      if (fail) return { data: null, error: { code: fail } };
      const rows = state.tables[this.table] ?? (state.tables[this.table] = []);
      const match = (r) => this.filters.every((f) => f(r));
      if (this.op === "select") return { data: rows.filter(match), error: null };
      if (this.op === "insert") {
        if (rows.some((r) => r.client_key === this.payload.client_key)) return { data: null, error: { code: "23505" } };
        const row = { meal_id: nextId++, deleted_at: null, capture_kind: "photo", ...this.payload };
        rows.push(row);
        return { data: [row], error: null };
      }
      if (this.op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) {
          // The table trigger's drink rules: revision advances by one, a tombstone stays.
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

function newState() {
  return { tables: { photo_meals: [] }, calls: [], revalidated: [], today: "2026-11-15", fail: {} };
}

// The route resolves "now" against the real clock: use an instant a minute ago.
const recentNow = () => ({ mode: "now", at: new Date(Date.now() - 60_000).toISOString(), zone: NY });

test("route: create, replay, conflict, revision edit, stale edit, Undo tombstone, no resurrection, second can", async () => {
  const state = newState();
  state.today = C.behavioralDayAt(Date.now() - 60_000, NY);
  const R = loadRoute(state);
  const time = recentNow();
  const create = { client_key: KEY, product_id: WG, servings: 1, time, overlap: "none" };

  const a = await R.POST(req(create));
  assert.equal(a.status, 201);
  assert.equal(a.body.record.caffeine_mg, 200);
  assert.equal(a.body.record.kcal, 5);
  assert.equal(a.body.record.carbs_g, 1);
  assert.equal(a.body.record.revision, 1);
  const row = state.tables.photo_meals[0];
  assert.equal(row.capture_kind, "drink");
  assert.equal(row.drink_label.version, 1);
  assert.equal(row.eaten_at, new Date(Date.parse(time.at)).toISOString(), "the captured instant, not noon");
  assert.ok(!state.calls.some((c) => c.includes("supplement_intake") && !c.startsWith("select")), "never a supplement write");
  assert.deepEqual(state.revalidated.sort(), ["/caffeine", "/nutrition", "/today"]);

  // Double tap / lost answer: the same row, still one drink.
  const b = await R.POST(req(create));
  assert.equal(b.status, 200);
  assert.equal(b.body.replay, true);
  assert.equal(state.tables.photo_meals.length, 1);

  // Same key, other details: an explicit conflict with the stored row, never a second drink or a silent no-op.
  const c = await R.POST(req({ ...create, servings: 2 }));
  assert.equal(c.status, 409);
  assert.equal(c.body.code, "changed");
  assert.equal(c.body.record.servings, 1);
  assert.equal(state.tables.photo_meals.length, 1);

  // Revision-checked edit.
  const e = await R.PATCH(req({ ...create, servings: 2, expected_revision: 1 }));
  assert.equal(e.status, 200);
  assert.equal(e.body.record.revision, 2);
  assert.equal(e.body.record.caffeine_mg, 400);
  // The same edit again (its answer lost): the stored row.
  assert.equal((await R.PATCH(req({ ...create, servings: 2, expected_revision: 1 }))).body.replay, true);
  // A stale edit with other details changes nothing.
  const s = await R.PATCH(req({ ...create, servings: 0.5, expected_revision: 1 }));
  assert.equal(s.status, 409);
  assert.equal(s.body.code, "stale");
  assert.equal(state.tables.photo_meals[0].drink_servings, 2);

  // Undo: tombstone with the revision; a repeat is done; late retries are 410, never a resurrection.
  assert.equal((await R.DELETE(req({ client_key: KEY, expected_revision: 1 }))).status, 409, "Undo needs the current revision");
  const u = await R.DELETE(req({ client_key: KEY, expected_revision: 2 }));
  assert.equal(u.status, 200);
  assert.ok(state.tables.photo_meals[0].deleted_at, "the row stays as a tombstone");
  assert.equal(state.tables.photo_meals[0].revision, 3);
  assert.equal((await R.DELETE(req({ client_key: KEY, expected_revision: 2 }))).status, 200, "a repeated Undo is done");
  assert.equal((await R.POST(req(create))).status, 410);
  assert.equal((await R.PATCH(req({ ...create, expected_revision: 3 }))).status, 410);
  assert.equal(state.tables.photo_meals.length, 1);

  // A deliberate second can (new key) is a second drink.
  const second = await R.POST(req({ ...create, client_key: "1b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b" }));
  assert.equal(second.status, 201);
  assert.equal(state.tables.photo_meals.length, 2);
});

test("route: guards, other-kind keys, ambiguous time, missing migration, turned off", async () => {
  const state = newState();
  state.today = C.behavioralDayAt(Date.now() - 60_000, NY);
  const R = loadRoute(state);
  const create = { client_key: KEY, product_id: WG, servings: 1, time: recentNow(), overlap: "none" };
  assert.equal((await R.POST(req(create, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await R.POST(req(create, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await R.POST(req({ ...create, caffeine_mg: 0 }))).status, 400);
  assert.equal((await R.POST(req("{not json"))).status, 400);
  assert.equal((await R.POST(req({ ...create, time: { ...create.time, at: new Date(Date.now() + 3_600_000).toISOString() } }))).status, 400);

  // A key that belongs to a photo meal is never answered as a drink.
  state.tables.photo_meals.push({ meal_id: 1, client_key: KEY, capture_kind: "photo", deleted_at: null, revision: 1 });
  const other = await R.POST(req(create));
  assert.equal(other.status, 409);
  assert.equal(other.body.code, "other_kind");
  assert.equal((await R.DELETE(req({ client_key: KEY, expected_revision: 1 }))).status, 404, "never removes a photo meal");

  // A repeated clock hour needs earlier / later (the route answers the two instants).
  const fallDay = { ...create, client_key: "2b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b", time: { mode: "manual", day: state.today, time: "12:00", zone: NY, fold: null } };
  assert.ok([201, 400].includes((await R.POST(req(fallDay))).status), "an ordinary hour either saves or is refused as future, never ambiguous");

  // Missing migration: a concrete 503, nothing saved.
  const m = newState();
  m.today = state.today;
  m.fail["insert:photo_meals"] = "PGRST204";
  const M = loadRoute(m);
  const res = await M.POST(req(create));
  assert.equal(res.status, 503);
  assert.match(res.body.error, /migration is pending/);
  m.fail = { "select:photo_meals": "42703" };
  assert.equal((await M.GET(req("", {}, `${ORIGIN}/api/nutrition/drinks`))).status, 503);
  m.fail = { "insert:photo_meals": "OXD00" };
  assert.match((await M.POST(req({ ...create, client_key: "3b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b" }))).body.error, /turned off/);
});

test("route GET: the day's live drinks plus likely overlaps; an unreadable source is named, not treated as empty", async () => {
  const state = newState();
  state.tables.photo_meals.push(
    { meal_id: 5, client_key: KEY, capture_kind: "drink", deleted_at: null, revision: 1, eaten_date: "2026-11-15", eaten_time: "14:05", eaten_at: "2026-11-15T19:05:00Z", time_zone: NY, time_source: "now", kcal: 5, protein_g: 0, carbs_g: 1, fat_g: 0, sugar_g: 0, sodium_mg: 25, caffeine_mg: 200, drink_product_id: WG, drink_product_version: 1, drink_servings: 1, drink_label: C.snapshotOf(P.drinkProduct(WG)), diary_overlap: "none" },
    { meal_id: 6, client_key: "4b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b", capture_kind: "drink", deleted_at: "2026-11-15T20:00:00Z", revision: 2, eaten_date: "2026-11-15" },
    { meal_id: 7, client_key: "5b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b", capture_kind: "photo", deleted_at: null, revision: 1, eaten_date: "2026-11-15" },
  );
  state.tables.cronometer_servings = [{ onyx_behavioral_date: "2026-11-15", food_name: "Gorilla Mind Energy, Wild Grape", event_time: "2026-11-15T18:50:00Z" }, { onyx_behavioral_date: "2026-11-15", food_name: "Eggs", event_time: null }];
  state.tables.delivery_order_items = [];
  state.fail["select:supplement_intake"] = "57014";
  const R = loadRoute(state);
  const g = await R.GET(req("", {}, `${ORIGIN}/api/nutrition/drinks`));
  assert.equal(g.status, 200);
  assert.equal(g.body.today, "2026-11-15");
  assert.deepEqual(g.body.drinks.map((d) => d.meal_id), [5], "removed drinks and photo meals are not listed");
  assert.deepEqual(g.body.overlaps.map((o) => o.name), ["Gorilla Mind Energy, Wild Grape"]);
  assert.deepEqual(g.body.unavailable, ["supplements"]);
  assert.equal((await R.GET(req("", {}, `${ORIGIN}/api/nutrition/drinks?day=2026-10-01`))).status, 400);
  assert.ok(!state.calls.some((c) => !c.startsWith("select")), "GET only reads");
});

// ---------- the photo route never touches drinks ----------

test("photo route: delete and re-read are pinned to photo rows (with a pre-migration fallback)", async () => {
  const src = read("app/api/nutrition/photo-meals/route.ts");
  assert.match(src, /q\.eq\("capture_kind", "photo"\)/);
  assert.match(src, /\.delete\(\)\.eq\("meal_id", id\);\s*return \(pin \? q\.eq\("capture_kind", "photo"\) : q\)\.select\("meal_id"\)/);
  assert.ok(!/capture_kind:\s*"drink"/.test(src));
  const state = newState();
  state.tables.photo_meals.push({ meal_id: 9, client_key: KEY, capture_kind: "drink", deleted_at: null, revision: 1 });
  const R = loadTs("app/api/nutrition/photo-meals/route.ts", {
    "next/server": { NextResponse: { json: (b, init) => ({ status: init?.status ?? 200, body: b }) } },
    "next/cache": { revalidatePath: () => {} },
    "@supabase/supabase-js": { createClient: () => fakeDb(state) },
  });
  const res = await R.DELETE(req({ meal_id: 9 }, {}, `${ORIGIN}/api/nutrition/photo-meals`));
  assert.equal(res.status, 404);
  assert.equal(state.tables.photo_meals.length, 1, "the drink row is still there");
});

// ---------- source checks: no writes on open / scroll; both pages refresh; one place to enter ----------

test("Drinks section: items only from a Fill or a tap; writes only from autosave / Undo / list buttons", () => {
  const src = read("app/log/sections/Drinks.tsx");
  const adopts = src.split("\n").filter((l) => l.includes("drinkSession.adopt("));
  assert.ok(adopts.length >= 3);
  // From the draft effect, a "+" tap, or "Log as a new drink" (a tap; a fresh key for a deliberate new drink).
  for (const l of adopts) assert.ok(/onClick|itemFromDraft|key: newUuid\(\)/.test(l), `adopt only from the draft effect or a tap: ${l.trim()}`);
  assert.ok(!/fetch\([^)]*method:\s*["']GET/.test(src));
  // GETs on mount go through cachedJson (read-only); writes only through call(), used by save / undo / list actions.
  const calls = (src.match(/\bcall\("(POST|PATCH|DELETE)"/g) ?? []).length;
  assert.ok(calls >= 4);
  assert.match(src, /useAutosave<DrinkSave \| null>/);
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(src), "no words or drafts on disk");
  assert.match(read("app/log/LogClient.tsx"), /<Part id="drinks" title="Drinks"><Anchor part="drinks" \/><Drinks \/><\/Part>/);
  assert.match(read("app/log/jump.ts"), /"supplements", "drinks", "uber-eats"/);
  assert.match(read("app/log/sections/ui.tsx"), /drinks: "Drinks"/);
});

test("Say it: the capture id is made at the Fill tap and kept for the same words; Clear starts a new one", () => {
  const src = read("app/log/sections/SayIt.tsx");
  const fill = src.indexOf("const capture = captureFor(words);");
  const request = src.indexOf('fetch("/api/log/voice"');
  assert.ok(fill > 0 && request > fill, "the identity exists before the request");
  assert.match(src, /if \(!keptCapture \|\| keptCapture\.text !== words\) keptCapture = \{ text: words, id: newUuid\(\), at: Date\.now\(\) \}/);
  assert.match(src, /keptCapture = null;/);
});

test("both pages refresh after a drink write: listeners registered, both cache areas invalidated", () => {
  assert.match(read("app/nutrition/NutritionClient.tsx"), /useEffect\(\(\) => onDrinkChange\(/);
  assert.match(read("app/caffeine/CaffeineClient.tsx"), /useEffect\(\(\) => onDrinkChange\(\(\) => setReload/);
  const CC = loadTs("lib/client-cache.ts");
  const inv = CC.writeInvalidates("/api/nutrition/drinks");
  for (const p of ["/api/nutrition", "nutrition:", "/api/caffeine", "caffeine:"]) assert.ok(inv.includes(p), p);
  assert.ok(!CC.writeInvalidates("/api/nutrition/photo-meals").includes("caffeine:"), "photo meals carry no caffeine");
  assert.match(read("app/api/nutrition/drinks/route.ts"), /revalidatePath\("\/caffeine"\)/);
  assert.match(read("lib/queries.ts"), /addDirectDrinks\(merged/);
});

test("SQL: additive, kind-pinned projections, one caffeine branch, invoker views, no anon grant", () => {
  const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "direct_drink_capture.sql"), "utf8");
  // The migration proper (before the commented appendices), without its comments.
  const migration = sql.split("-- APPENDIX A")[0];
  const live = migration.replace(/--.*$/gm, "");
  assert.ok(!/drop/i.test(sql), "the word never appears, comments included (MCP rule)");
  assert.ok(!/\bCASCADE\b/i.test(live));
  assert.ok(!/\bGRANT\b[^;]*\banon\b/i.test(live), "nothing granted to anon");
  // The appendices are inert comments.
  for (const line of sql.split("-- APPENDIX A")[1].split("\n")) assert.ok(line.trim() === "" || line.trimStart().startsWith("--"), line);
  assert.match(live, /ADD COLUMN IF NOT EXISTS capture_kind\s+TEXT\s+NOT NULL DEFAULT 'photo'/);
  assert.match(live, /CREATE OR REPLACE VIEW pds\.photo_meal_daily WITH \(security_invoker = true\)[\s\S]*WHERE capture_kind = 'photo'/);
  assert.match(live, /CREATE OR REPLACE VIEW pds\.direct_drink_daily WITH \(security_invoker = true\)[\s\S]*capture_kind = 'drink'[\s\S]*deleted_at IS NULL[\s\S]*diary_overlap = 'none'/);
  assert.match(live, /CREATE OR REPLACE VIEW pds\.caffeine_events WITH \(security_invoker = true\)/);
  assert.equal((live.match(/'direct_capture:'/g) ?? []).length, 1);
  assert.match(live, /'dietary'::text AS source,\s*'direct_capture:'/);
  // The photo branch of the trigger keeps the noon-of-day rule; the drink branch never overwrites eaten_at.
  const fn = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION"), migration.indexOf("$$ LANGUAGE plpgsql"));
  const drinkBranch = fn.slice(fn.indexOf("IF NEW.capture_kind = 'drink'"), fn.indexOf("-- Photo meals"));
  assert.ok(!/NEW\.eaten_at\s*:=/.test(drinkBranch));
  assert.match(fn, /-- Photo meals[\s\S]*NEW\.eaten_at := /);
});
