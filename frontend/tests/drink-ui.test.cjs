// Run: node --test tests/drink-ui.test.cjs
// Log Drinks / Say it / Nutrition / Caffeine wiring for direct drink capture (PROD-CAFF-01 slice). Static source
// checks plus the key-derivation facts that make the frozen Say it interpretation necessary. Offline, synthetic.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const C = loadTs("lib/drink-capture.ts");
const WG = "gorilla-mind-energy-wild-grape-16oz";

test("why the interpretation is frozen: differing model answers for the same words derive different keys", async () => {
  const cap = "11111111-2222-4333-8444-555555555555";
  // First answer: one item of two cans. Second answer for the SAME words: two items of one can each.
  const first = C.itemSlots([{ product_id: WG, said: "two wild grape Gorilla Minds" }]);
  const second = C.itemSlots([{ product_id: WG, said: "a wild grape Gorilla Mind" }, { product_id: WG, said: "another one" }]);
  const k1 = await Promise.all(first.map((s) => C.itemKey(cap, s)));
  const k2 = await Promise.all(second.map((s) => C.itemKey(cap, s)));
  assert.equal(k2[0], k1[0]);
  assert.ok(!k1.includes(k2[1]), "the second answer would add a key: a third can if it were adopted");
  // Unresolved first, resolved second: different slots too.
  assert.notEqual(C.itemSlots([{ product_id: null, said: "Gorilla Mind" }])[0], C.itemSlots([{ product_id: WG, said: "Gorilla Mind" }])[0]);
});

test("Say it freezes the first accepted drinks for retained words and replays them on every later Fill", () => {
  const src = read("app/log/sections/SayIt.tsx");
  assert.match(src, /if \(capture\.drinks == null\) \{\s*capture\.drinks = await drinkDrafts\(/);
  assert.match(src, /if \(capture\.drinks\.length\) drafts\.drinks = capture\.drinks;/);
  assert.match(src, /result: \{ \.\.\.json, drinks: capture\.drinks, summary: \{ \.\.\.json\.summary, drinks: capture\.drinkLines \} \}/);
  // A new capture (new keys, nothing frozen) only for changed words or Clear.
  assert.match(src, /keptCapture = \{ text: words, id: newUuid\(\), at: Date\.now\(\), drinks: null, drinkLines: \[\] \}/);
  assert.match(src, /keptCapture = null;/);
  const fill = src.indexOf("const capture = captureFor(words);");
  assert.ok(fill > 0 && src.indexOf('fetch("/api/log/voice"') > fill, "the identity exists before the request");
});

test("Drinks: no same-Fill sibling exclusion (it let a re-interpretation add a can); recent check sees every saved drink", () => {
  const src = read("app/log/sections/Drinks.tsx");
  assert.ok(!/siblings/.test(src));
  assert.ok(!/capturedAt === item\.capturedAt/.test(src));
  assert.match(src, /itemSave\(item, \{ today, nowMs: Date\.now\(\), dayCheck, acknowledged: !!ack, blocked \}\)/);
});

test("Drinks: an unusable said day / time never becomes Now or today", () => {
  const src = read("app/log/sections/Drinks.tsx");
  assert.match(src, /const manual = !!d\.time \|\| !!d\.date \|\| !!whenIssue;/);
  assert.match(src, /\{needsDay && <option value="">Pick a day<\/option>\}/);
  assert.match(src, /whenIssue: e\.target\.value \? afterWhenEdit\(item\.whenIssue, "day"\) : item\.whenIssue/);
});

test("Drinks: conflicts stay conflicts; writes only through the session's save / undo; held items never autosave", () => {
  const src = read("app/log/sections/Drinks.tsx");
  assert.match(src, /await saveDrinkWith\(call, v, ctx\.keepalive\);/);
  assert.match(src, /const r = await undoDrinkWith\(call, key\);/);
  assert.ok(!/code === "changed"/.test(src) && !/code === "stale"/.test(src), "no conflict-to-edit shortcut in the UI");
  assert.match(src, /const live = item\.status === "open" && item\.hold == null;/);
  assert.match(src, /if \(!live\) return;\s*change\(value\);/);
  // A deliberate change ends the conflict hold (and then edits with the revision now shown).
  assert.match(src, /item\.hold === "conflict" \? \{ \.\.\.patch, hold: null, note: null \} : patch/);
  // SavedDrink: a conflict is shown, never retried.
  const listed = src.slice(src.indexOf("function SavedDrink"));
  assert.equal((listed.match(/await call\(/g) ?? []).length, 1);
});

test("Drinks: opening / scrolling only reads (today's list, and each kept drink by its key)", () => {
  const src = read("app/log/sections/Drinks.tsx");
  // Each effect body: up to its dependency list ("}, [" or "),\n [").
  const effects = src.split("useEffect(").slice(1).map((s) => s.slice(0, s.search(/[})]\s*,\s*\[/)));
  assert.ok(effects.length >= 6 && effects.every((b) => b.length > 0 && b.length < 1200), "effect bodies parsed");
  for (const body of effects) assert.ok(!/call\(|saveDrinkWith|undoDrinkWith/.test(body), `no write from an effect: ${body.slice(0, 80)}`);
  assert.match(src, /for \(const key of drinkSession\.restore\(\)\) recover\(key\);/);
  const readKey = src.slice(src.indexOf("async function readKey"), src.indexOf("const reading"));
  assert.match(readKey, /fetch\(`\$\{DRINKS_URL\}\?key=\$\{encodeURIComponent\(key\)\}`, \{ cache: "no-store" \}\)/);
  assert.ok(!/method/.test(readKey), "a plain GET");
  // Explicit retry after a recovery found nothing.
  assert.match(src, /item\.hold === "retry"[\s\S]*Save it/);
  // The device copy lives in lib/drink-session.ts only.
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(src));
  const session = read("lib/drink-session.ts");
  assert.ok(!/fetch\(/.test(session.replace(/^\s*(\*|\/\/).*$/gm, "")), "the session never fetches by itself");
  assert.match(session, /\.map\(\(\{ said: _said, \.\.\.rest \}\)/, "the words are dropped before storing");
});

test("Drinks: 'Already counted in Cronometer' only for a dual-channel Cronometer entry; others: count here or don't add", () => {
  const src = read("app/log/sections/Drinks.tsx");
  assert.match(src, /\{dual\.length > 0 && <Chip on=\{false\} onClick=\{\(\) => set\(\{ overlap: "in_diary" \}\)\}>Already counted in Cronometer<\/Chip>\}/);
  assert.match(src, /Don&apos;t add/);
  assert.match(src, /const canMarkCounted = rec\.overlap === "none" && !!product && !!check && dualChannelOverlaps\(product, check\)\.length > 0;/);
  assert.match(src, /"Supplements \(caffeine only\)"/);
  assert.ok(!/Already counted there/.test(src));
});

test("Drinks: missing schema is a concrete error and blocks saving; Saved only after acknowledgement", () => {
  const src = read("app/log/sections/Drinks.tsx");
  assert.match(src, /const blocked = baseState === "unavailable" \? UNAVAILABLE : null;/);
  assert.match(src, /role="alert" className="mb-3 text-\[13px\] text-down">\{UNAVAILABLE\}/);
  assert.match(src, /const settled = !!ack && item\.hold == null && \(saver\.state\.status === "idle" \|\| saver\.state\.status === "saved"\);/);
});

test("Drinks: a failed save shows fixed copy keyed on status; server error text is never rendered", () => {
  const src = read("app/log/sections/Drinks.tsx");
  assert.doesNotMatch(src, /setErr\(typeof r\.json\.error/);
  assert.match(src, /setErr\(saveFailureText\(r\.status, r\.json\)\);/);
  assert.match(src, /"Sign in again to keep saving drinks\."/);
  assert.match(src, /"This drink changed somewhere else\. Refresh to see the latest\."/);
  assert.match(src, /"Could not save this drink\. Try again in a moment\."/);
  assert.match(src, /"Could not save this drink\. Try again\."/);
  assert.match(src, /setErr\("Couldn't reach Onyx\."\);/);
});

test("both pages refresh after a drink write; known zero-kcal drinks stay listed", () => {
  assert.match(read("app/nutrition/NutritionClient.tsx"), /useEffect\(\(\) => onDrinkChange\(\(\) => \{\s*setDrinkReload\(\(n\) => n \+ 1\);\s*refreshNutritionSilently\(\);/);
  assert.match(read("app/caffeine/CaffeineClient.tsx"), /useEffect\(\(\) => onDrinkChange\(\(\) => setReload\(\(n\) => n \+ 1\)\), \[\]\);/);
  assert.match(read("app/caffeine/CaffeineClient.tsx"), /\}, \[windowDays, hrvDays, qualityDays, reload\]\);/);
  const CC = loadTs("lib/client-cache.ts");
  for (const p of ["/api/nutrition", "nutrition:", "/api/caffeine", "caffeine:"]) assert.ok(CC.writeInvalidates("/api/nutrition/drinks").includes(p), p);
  // Nutrition lists drinks without a kcal filter; getNutrition reads the day view without one.
  assert.match(read("lib/queries.ts"), /\/\/ No kcal filter: a zero-calorie drink still counts/);
  assert.match(read("app/nutrition/NutritionClient.tsx"), /\{dayDrinks\.length > 0 && \(/);
});

test("StatCard is untouched: the tiles take the base food source, drinks are named in the sublabel", () => {
  assert.ok(!/DRINKS/.test(read("components/StatCard.tsx")));
  assert.match(read("app/nutrition/NutritionClient.tsx"), /const latestSource = baseSourceLabel\(latest\?\.nutrition_source\) \?\? undefined;/);
});
