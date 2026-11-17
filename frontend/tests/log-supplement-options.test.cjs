// Run: node --test tests/log-supplement-options.test.cjs
// /log Supplements, "Log a product" (2026-11-16, Riley: "I should be able to click the existing options, instead of
// having to search"; PR 527: several at once): every /supplements product is a checkbox option without typing, most
// used first (single doses in the last 30 days, then the most recent, then the name); checking one writes nothing and
// gives it its own amount and unit (one serving at first); "Log selected (N)" writes the checked products one at a
// time (a logged one is unchecked, a failed one stays checked with its error and its own Retry, a logged product is
// never sent again); the search box filters the same options and never unchecks; the options never wait for a network
// read of the history, and their order is fixed on first display while the section is mounted; Say it suggestions
// moved in with Edit keep their amount, unit and times.
// SYNTHETIC DATA ONLY: invented product names, ids and dates; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");
const { mountClient, response, deferred, withGlobals } = require("./helpers/hook-harness.cjs");

const O = loadTs("lib/log-supplement-options.ts");
const TODAY = loadTs("lib/checkin.ts").fallbackBehavioralToday(new Date());

const prod = (id, full_name, brand_name = "Synthetic Labs") => ({ product_id: id, brand_name, full_name, serving_size: 1, serving_unit: "capsule" });
const row = (intake_id, product_id, intake_date, over = {}) => ({ intake_id, product_id, intake_date, intake_time: null, notes: "Logged from /log", ...over });

// ---- pure: lib/log-supplement-options.ts ----

test("usage: single doses only (a stack's doses never count), one count per intake id, Undo rows skipped", () => {
  const rows = [
    row(1, "p-a", "2026-01-02"),
    row(2, "p-a", "2026-01-03", { intake_time: "2026-01-03T14:00:00+00:00" }),
    row(3, "p-b", "2026-01-03", { notes: "Logged from stack: Synthetic Night" }),
    row(4, "p-b", "2026-01-04", { stack_id: 7, notes: null }),
    // Today's copy of intake 2 replaces the history copy: counted once.
    row(2, "p-a", "2026-01-03", { intake_time: "2026-01-03T14:00:00+00:00", stack_id: null }),
    row(5, "p-c", "2026-01-01"),
  ];
  const u = O.usageByProduct(rows);
  assert.equal(u.get("p-a").count, 2);
  assert.equal(u.get("p-a").last, "2026-01-03|2026-01-03T14:00:00+00:00");
  assert.equal(u.has("p-b"), false, "doses a stack logged do not make a product a frequent pick");
  assert.equal(u.get("p-c").count, 1);
  assert.equal(O.usageByProduct(rows, new Set([5])).has("p-c"), false, "a row being removed (Undo) no longer counts");
  // Today's row says a stack logged it, so it overrides a history copy without the note.
  assert.equal(O.usageByProduct([row(9, "p-d", "2026-01-05"), row(9, "p-d", "2026-01-05", { stack_id: 3 })]).has("p-d"), false);
});

test("order: most doses first, then the most recent, then the name; never-logged products by name", () => {
  const products = [prod("p1", "Synthetic Zeta"), prod("p2", "Synthetic Alpha"), prod("p3", "Synthetic Mu"), prod("p4", "Synthetic Kappa"), prod("p5", "Synthetic Beta")];
  const usage = O.usageByProduct([
    row(1, "p3", "2026-02-01"), row(2, "p3", "2026-02-02"), row(3, "p3", "2026-02-03"),
    row(4, "p4", "2026-02-05"),
    row(5, "p1", "2026-02-01"),
  ]);
  const names = O.orderOptions(products, usage).map((p) => p.full_name);
  assert.deepEqual(names, ["Synthetic Mu", "Synthetic Kappa", "Synthetic Zeta", "Synthetic Alpha", "Synthetic Beta"]);
  assert.deepEqual(products.map((p) => p.product_id), ["p1", "p2", "p3", "p4", "p5"], "the input list is not reordered in place");
});

test("frozen order: a late history answer never moves an option; gone products drop out, new ones go last", () => {
  const a = prod("a", "Synthetic A"), b = prod("b", "Synthetic B"), c = prod("c", "Synthetic C"), d = prod("d", "Synthetic D");
  assert.deepEqual(O.keepOrder([c, b, a], null).map((p) => p.product_id), ["c", "b", "a"]);
  assert.deepEqual(O.keepOrder([c, d, a], ["a", "b", "c"]).map((p) => p.product_id), ["a", "c", "d"]);
});

test("filter: narrows the same options (every word must match brand or name), exact name first, empty = all", () => {
  const list = [prod("1", "Synthetic Cedar Blend"), prod("2", "Synthetic Cedar"), prod("3", "Synthetic Moss", "Cedar Works"), prod("4", "Synthetic Fern")];
  assert.deepEqual(O.filterOptions(list, "").map((p) => p.product_id), ["1", "2", "3", "4"]);
  assert.deepEqual(O.filterOptions(list, "  ").map((p) => p.product_id), ["1", "2", "3", "4"]);
  assert.deepEqual(O.filterOptions(list, "cedar").map((p) => p.product_id), ["1", "2", "3"], "the brand counts too; order kept");
  assert.deepEqual(O.filterOptions(list, "synthetic cedar").map((p) => p.product_id), ["2", "1", "3"], "the exact name first");
  assert.deepEqual(O.filterOptions(list, "fern synthetic").map((p) => p.product_id), ["4"]);
  assert.deepEqual(O.filterOptions(list, "quartz"), []);
});

test("visible: capped with a count of the rest, all with Show all, and a picked option further down stays on screen", () => {
  const list = Array.from({ length: 15 }, (_, i) => prod(`p${i}`, `Synthetic ${i}`));
  const capped = O.visibleOptions(list, false, null);
  assert.equal(capped.shown.length, O.OPTIONS_CAP);
  assert.equal(capped.more, 15 - O.OPTIONS_CAP);
  assert.equal(O.visibleOptions(list, true, null).shown.length, 15);
  assert.equal(O.visibleOptions(list, true, null).more, 0);
  const picked = O.visibleOptions(list, false, "p14");
  assert.equal(picked.shown.at(-1).product_id, "p14");
  assert.equal(picked.more, 15 - O.OPTIONS_CAP - 1);
  assert.equal(O.visibleOptions(list, false, "not-listed").shown.length, O.OPTIONS_CAP, "a pick filtered out is not added");
});

test("labels: the name; the brand only when two products share the name", () => {
  const labels = O.optionLabels([prod("1", "Synthetic Glycinate", "Brand One"), prod("2", "Synthetic Glycinate", "Brand Two"), prod("3", null, "Only Brand"), prod("4", "Synthetic Solo")]);
  assert.equal(labels.get("1"), "Synthetic Glycinate · Brand One");
  assert.equal(labels.get("2"), "Synthetic Glycinate · Brand Two");
  assert.equal(labels.get("3"), "Only Brand");
  assert.equal(labels.get("4"), "Synthetic Solo");
});

// unitAfterPick is exported but the picker no longer calls it (PR 527 gives each checked product its own amount and
// unit); this pins the pure rule only. See the PR body.
test("unitAfterPick (exported, not called by the picker): one serving on a fresh form; an amount stays only with a unit that applies to the new product", () => {
  assert.deepEqual(O.unitAfterPick("", "mg", "capsule"), { amount: "", unit: "serving" });
  assert.deepEqual(O.unitAfterPick("  ", "Scoop", "capsule"), { amount: "  ", unit: "serving" });
  assert.deepEqual(O.unitAfterPick("15", "mg", "capsule"), { amount: "15", unit: "mg" }, "15 mg never becomes 15 servings");
  assert.deepEqual(O.unitAfterPick("400", "IU", "Softgel"), { amount: "400", unit: "IU" });
  assert.deepEqual(O.unitAfterPick("2", "serving", "Scoop"), { amount: "2", unit: "serving" });
  // The new product's own count unit: kept, shown as that product's unit (plural or not, pill words as one).
  assert.deepEqual(O.unitAfterPick("2", "capsules", "Capsule(s)"), { amount: "2", unit: "Capsule(s)" });
  assert.deepEqual(O.unitAfterPick("2", "Capsule", "Tablet"), { amount: "2", unit: "Tablet" });
  // Another product's count unit: the form starts fresh, never read as servings and never refused on Log.
  assert.deepEqual(O.unitAfterPick("2", "Scoop", "Capsule"), { amount: "", unit: "serving" });
  assert.deepEqual(O.unitAfterPick("1", "Gummies", "g"), { amount: "", unit: "serving" });
  assert.deepEqual(O.unitAfterPick("5", "ml", null), { amount: "", unit: "serving" });
});

// ---- the section: app/log/sections/Supplements.tsx ----

const URL = {
  products: "/api/supplements/products",
  today: "/api/supplements/today",
  stacks: "/api/supplements/stacks",
  history: "/api/supplements/history?days=30&perPage=200",
};
const STACK = { stack_id: 3, name: "Synthetic Night", remind_time: null, item_count: 2 };
const FIVE = [
  prod("p-alpha", "Synthetic Alpha"),
  prod("p-beta", "Synthetic Beta"),
  prod("p-gamma", "Synthetic Gamma"),
  prod("p-delta", "Synthetic Delta"),
  prod("p-eps", "Synthetic Epsilon"),
];
const HISTORY_ROWS = [
  row(11, "p-beta", "2026-01-03"), row(12, "p-beta", "2026-01-04"), row(13, "p-beta", "2026-01-05"),
  row(14, "p-gamma", "2026-01-10"),
  row(15, "p-eps", "2026-01-01"),
  ...[16, 17, 18, 19, 20].map((id) => row(id, "p-delta", "2026-01-06", { notes: "Logged from stack: Synthetic Night" })),
];
const todayIntake = (intake_id, product_id, stack_id) => ({ intake_id, intake_date: TODAY, intake_time: null, product_id, doses: 1, notes: null, stack_id, brand_name: null, full_name: "Synthetic" });
const TODAY_RESP = { date: TODAY, intakes: [todayIntake(21, "p-eps", null), todayIntake(22, "p-delta", 3)], reminders: [] };

/**
 * The section's client cache, as a plain map: peek / read for the first paint, cachedJson for the server read.
 * `disk`: copies only the persisted store has (read finds them, peek does not). `hang`: keys whose persisted read
 * never answers (a store slow to open).
 */
function fakeCache(store, registered = new Map(), hang = new Set(), disk = new Map()) {
  const GONE = Symbol("gone");
  const clientCache = {
    peek: (k) => store.get(k),
    read: (k) => (hang.has(k) ? new Promise(() => {}) : Promise.resolve(store.get(k) ?? disk.get(k))),
    put: (k, v) => { store.set(k, v); return true; },
    register: (k, fetcher) => { registered.set(k, fetcher); },
  };
  async function fetchJsonValue(url, get) {
    const r = await (get ? get() : fetch(url, { cache: "no-store" }));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function cachedJson(url, { check, get } = {}) {
    const v = await fetchJsonValue(url, get);
    check?.(v);
    clientCache.put(url, v);
    return v;
  }
  return { clientCache, cachedJson, fetchJsonValue, GONE };
}

function mountSection(t, { cache = new Map(), registered = new Map(), hang = new Set(), disk = new Map(), answers = {}, post, draft = null } = {}) {
  const calls = { writes: [], gets: [] };
  const defaults = {
    [URL.products]: () => response({ products: FIVE }),
    [URL.today]: () => response(TODAY_RESP),
    [URL.stacks]: () => response({ stacks: [STACK] }),
    [URL.history]: () => response({ rows: HISTORY_ROWS }),
  };
  // Registered before withGlobals: node runs t.after hooks first-in-first-out, and the section's cleanup removes its
  // visibilitychange listener from `document`, so the unmount has to run while the stand-in globals are still set.
  let h;
  t.after(() => h?.unmount());
  withGlobals(t, {
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    fetch: async (url, init = {}) => {
      const method = init.method ?? "GET";
      if (method !== "GET") {
        calls.writes.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
        return post ? post(url, calls.writes.length) : response({ ok: true, logged: [], intake_date: TODAY });
      }
      calls.gets.push(url);
      const answer = answers[url] ?? defaults[url];
      if (!answer) throw new Error(`unexpected request ${method} ${url}`);
      return answer();
    },
  });
  const drafts = { current: null };
  const clear = (id) => { if (drafts.current.draft && (id == null || drafts.current.draft.id === id)) drafts.current = { draft: null, clear }; };
  drafts.current = { draft, clear };
  h = mountClient("app/log/sections/Supplements.tsx", {
    stubs: {
      "@/components/FeedContext": { useInFeed: () => false },
      "lucide-react": { Check: () => null, Plus: () => null, X: () => null },
      "@/lib/client-cache": fakeCache(cache, registered, hang, disk),
      "@/lib/log-early": {
        LOG_SUPPLEMENTS_TODAY_URL: URL.today,
        LOG_SUPPLEMENTS_STACKS_URL: URL.stacks,
        LOG_SUPPLEMENTS_PRODUCTS_URL: URL.products,
        LOG_SUPPLEMENTS_HISTORY_URL: URL.history,
        logEarlyGet: () => undefined,
      },
      "@/lib/log-drafts": { useLogDrafts: () => drafts.current },
    },
  });
  // An option is its <label> (the title is the product's label); its checkbox is the <input> inside it.
  const options = () => h.find((n) => n.type === "label" && typeof n.props.title === "string");
  const optionNames = () => options().map((n) => h.text(n));
  const option = (name) => {
    const found = options().find((n) => h.text(n) === name);
    assert.ok(found, `option exists: ${name}`);
    return found;
  };
  const box = (name) => {
    const input = option(name).props.children.find((c) => c && c.type === "input" && c.props.type === "checkbox");
    assert.ok(input, `checkbox exists: ${name}`);
    return input;
  };
  const isOn = (name) => box(name).props.checked === true;
  const tick = (name, on = true) => box(name).props.onChange({ target: { checked: on } });
  const field = (label) => h.find((n) => (n.type === "input" || n.type === "select") && n.props["aria-label"] === label)[0];
  const selectedText = () => h.text(h.find((n) => n.props?.["aria-label"] === "Selected supplements")[0]);
  return { ...h, calls, options, optionNames, option, box, isOn, tick, field, selectedText };
}

test("section: the options show from this device's cache before any read answers, most used first, and nothing is written", async (t) => {
  const held = deferred();
  const cache = new Map([
    [URL.products, { products: FIVE }],
    [URL.today, TODAY_RESP],
    [URL.stacks, { stacks: [STACK] }],
    [URL.history, { rows: HISTORY_ROWS }],
  ]);
  const pending = () => held.promise;
  const h = mountSection(t, { cache, answers: { [URL.products]: pending, [URL.today]: pending, [URL.stacks]: pending, [URL.history]: pending } });
  await h.flush();
  // Beta 3 single doses, Epsilon 1 + today's 1, Gamma 1; Delta's doses all came from a stack (= never), Alpha never.
  assert.deepEqual(h.optionNames(), ["Synthetic Beta", "Synthetic Epsilon", "Synthetic Gamma", "Synthetic Alpha", "Synthetic Delta"]);
  assert.ok(h.optionNames().every((name) => h.isOn(name) === false), "nothing checked yet");
  assert.match(h.text(), /Nothing selected/, "the selected list says so");
  assert.equal(h.field("Filter your supplements"), undefined, "a short list needs no search box");
  assert.equal(h.calls.writes.length, 0, "opening the section writes nothing");
});

test("section: checking a product writes nothing and gives it its own amount and unit; Log selected is the write", async (t) => {
  const h = mountSection(t, {
    post: () => response({ ok: true, product: "Synthetic Beta", logged: [{ intake_id: 99, time: null }], doses_each: 1, intake_date: TODAY }),
  });
  await h.flush();
  assert.deepEqual(h.optionNames(), ["Synthetic Beta", "Synthetic Epsilon", "Synthetic Gamma", "Synthetic Alpha", "Synthetic Delta"], "ordered from the server's answers");
  assert.equal(h.field("Amount of Synthetic Gamma"), undefined, "no amount field before a check");
  assert.equal(h.buttons("Log selected (0)").length, 1, "the count starts at zero");
  assert.equal(h.buttons("Log selected (0)")[0].props.disabled, true, "nothing to log yet");

  h.tick("Synthetic Gamma");
  await h.flush();
  assert.equal(h.isOn("Synthetic Gamma"), true, "the checked option is marked");
  assert.equal(h.field("Amount of Synthetic Gamma").props.value, "", "amount starts empty = one serving (the label's)");
  assert.equal(h.field("Unit of Synthetic Gamma").props.value, "serving");
  assert.equal(h.field("Day").props.value, "today", "behavioral today");
  assert.match(h.text(), /Now/, "time = now");
  assert.equal(h.calls.writes.length, 0, "a check writes nothing");

  h.tick("Synthetic Beta");
  await h.flush();
  assert.equal(h.isOn("Synthetic Beta"), true, "a second check adds a product");
  assert.equal(h.isOn("Synthetic Gamma"), true, "and the first stays checked");
  assert.match(h.selectedText(), /Synthetic Gamma[\s\S]*Synthetic Beta/, "the selected list keeps the order of the checks");
  assert.equal(h.buttons("Log selected (2)").length, 1, "the count shows both");
  assert.equal(h.calls.writes.length, 0);

  h.tick("Synthetic Gamma", false);
  await h.flush();
  assert.equal(h.isOn("Synthetic Gamma"), false, "unchecking removes it");
  assert.equal(h.field("Amount of Synthetic Gamma"), undefined);
  assert.equal(h.buttons("Log selected (1)").length, 1);
  assert.equal(h.calls.writes.length, 0);

  await h.click("Log selected (1)");
  await h.flush();
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.writes[0].url, "/api/supplements/log-product");
  assert.equal(h.calls.writes[0].body.product_id, "p-beta");
  assert.equal(h.calls.writes[0].body.product, "Synthetic Beta");
  assert.equal(h.calls.writes[0].body.amount, null, "no amount typed: the product's one serving");
  assert.equal(h.calls.writes[0].body.unit, null);
  assert.equal(h.calls.writes[0].body.date, null, "today: no date sent");
  assert.equal(h.calls.writes[0].body.times.length, 1, "one time: now, as the label says");
  assert.match(h.calls.writes[0].body.times[0], /^\d{2}:\d{2}$/);
  assert.equal(h.isOn("Synthetic Beta"), false, "a logged product is unchecked");
  assert.equal(h.field("Amount of Synthetic Beta"), undefined, "its form row goes with the check");
});

test("section: a long list is capped with Show all, and the search box filters the same options", async (t) => {
  const words = ["Amber", "Birch", "Cedar", "Dune", "Ember", "Fjord", "Grove", "Harbor", "Iris", "Juniper", "Kelp", "Lumen", "Moss", "Nectar"];
  const many = words.map((w, i) => prod(`p-${i}`, `Synthetic ${w}`));
  const h = mountSection(t, { answers: { [URL.products]: () => response({ products: many }), [URL.history]: () => response({ rows: [] }) } });
  await h.flush();
  assert.equal(h.options().length, 12, "capped");
  assert.deepEqual(h.optionNames().slice(0, 3), ["Synthetic Amber", "Synthetic Birch", "Synthetic Cedar"], "never-logged products by name");
  await h.click("Show all (14)");
  await h.flush();
  assert.equal(h.options().length, 14);
  assert.ok(h.buttons("Show fewer").length === 1);

  // A checked product is kept while the filter hides it: filtering never unchecks.
  h.tick("Synthetic Cedar");
  await h.flush();
  h.field("Filter your supplements").props.onChange({ target: { value: "cedar" } });
  await h.flush();
  assert.deepEqual(h.optionNames(), ["Synthetic Cedar"], "the filter narrows the options");
  assert.equal(h.isOn("Synthetic Cedar"), true);
  h.field("Filter your supplements").props.onChange({ target: { value: "quartz" } });
  await h.flush();
  assert.equal(h.options().length, 0);
  assert.match(h.text(), /No match in your supplements/);
  assert.match(h.selectedText(), /Synthetic Cedar/, "the checked product stays in the selected list while filtered out");
  assert.equal(h.buttons("Log selected (1)").length, 1, "and still counts");
  h.field("Filter your supplements").props.onChange({ target: { value: "" } });
  await h.flush();
  assert.equal(h.options().length, 14, "clearing the filter brings every option back");
  assert.equal(h.isOn("Synthetic Cedar"), true, "still checked after the filter cleared");
  assert.equal(h.calls.writes.length, 0);
});

// Without the history: today's single dose first (Epsilon; Delta's dose today came from a stack), then by name.
const WITHOUT_HISTORY = ["Synthetic Epsilon", "Synthetic Alpha", "Synthetic Beta", "Synthetic Delta", "Synthetic Gamma"];
const skeletonPills = (h) => h.find((n) => typeof n.props?.className === "string" && n.props.className.includes("skeleton h-11 w-28"));

test("section: cached products show on the first flush while the history read is still out (no network wait); its answer moves nothing, nor do a Log and Cancel", async (t) => {
  const held = deferred();
  let todayReads = 0;
  // After the Log, today's answer carries four new single doses of Alpha: sorted again, Alpha would jump to the top.
  const later = { ...TODAY_RESP, intakes: [...TODAY_RESP.intakes, ...[31, 32, 33, 34].map((id) => todayIntake(id, "p-alpha", null))] };
  const cache = new Map([[URL.products, { products: FIVE }], [URL.today, TODAY_RESP], [URL.stacks, { stacks: [STACK] }]]);
  const h = mountSection(t, {
    cache,
    answers: { [URL.history]: () => held.promise, [URL.today]: () => response(todayReads++ === 0 ? TODAY_RESP : later) },
    post: () => response({ ok: true, product: "Synthetic Alpha", logged: [{ intake_id: 35, time: null }], doses_each: 1, intake_date: TODAY }),
  });
  await h.flush();
  assert.deepEqual(h.optionNames(), WITHOUT_HISTORY, "shown in the order known, without waiting for the history's answer");
  assert.equal(skeletonPills(h).length, 0, "no skeleton pills left");
  assert.ok(h.calls.gets.includes(URL.history), "the history is still read (it orders the next mount)");
  held.resolve(response({ rows: HISTORY_ROWS }));
  await h.flush();
  assert.deepEqual(h.optionNames(), WITHOUT_HISTORY, "a later history answer never moves an option under the finger");

  h.tick("Synthetic Alpha");
  await h.flush();
  await h.click("Log selected (1)");
  await h.flush();
  assert.equal(h.calls.writes.length, 1);
  assert.ok(todayReads >= 2, "today was read again after the Log");
  assert.deepEqual(h.optionNames(), WITHOUT_HISTORY, "a dose just logged does not move the options");
  h.tick("Synthetic Gamma");
  await h.flush();
  await h.click("Clear");
  await h.flush();
  assert.deepEqual(h.optionNames(), WITHOUT_HISTORY, "nor does Clear: the order is fixed while the section is mounted");
});

test("section: a history copy on this device (the persisted cache) orders the options before they show", async (t) => {
  // In memory: the products and today. Only on disk (read after mount): the history. The network answers never come.
  const held = deferred();
  const cache = new Map([[URL.products, { products: FIVE }], [URL.today, TODAY_RESP]]);
  const disk = new Map([[URL.history, { rows: HISTORY_ROWS }]]);
  const pending = () => held.promise;
  const h = mountSection(t, { cache, disk, answers: { [URL.products]: pending, [URL.today]: pending, [URL.stacks]: pending, [URL.history]: pending } });
  await h.flush();
  assert.deepEqual(h.optionNames(), ["Synthetic Beta", "Synthetic Epsilon", "Synthetic Gamma", "Synthetic Alpha", "Synthetic Delta"], "most used first");
  assert.equal(h.calls.writes.length, 0);
});

test("section: on a first visit (nothing on this device) the options show with the products' answer, not after the history's", async (t) => {
  const held = deferred();
  const h = mountSection(t, { answers: { [URL.history]: () => held.promise } });
  await h.flush();
  assert.deepEqual(h.optionNames(), WITHOUT_HISTORY);
  held.resolve(response({ rows: HISTORY_ROWS }));
  await h.flush();
  assert.deepEqual(h.optionNames(), WITHOUT_HISTORY, "nothing moved under the finger");
  assert.equal(h.calls.writes.length, 0);
});

test("section: a persisted store that never answers holds the options at most a moment (LOCAL_WAIT_MS), then they show", async (t) => {
  const held = deferred();
  const h = mountSection(t, { hang: new Set([URL.history]), answers: { [URL.history]: () => held.promise } });
  await h.flush();
  assert.equal(h.options().length, 0, "the device's copy is still being looked at");
  assert.ok(skeletonPills(h).length > 0);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await h.flush();
  assert.deepEqual(h.optionNames(), WITHOUT_HISTORY);
  assert.equal(h.calls.writes.length, 0);
});

test("section: the history read is registered, so a supplement write's cache invalidation refetches it (checked like the section's read)", async (t) => {
  const registered = new Map();
  let answer = () => response({ rows: HISTORY_ROWS });
  const h = mountSection(t, { registered, answers: { [URL.history]: () => answer() } });
  await h.flush();
  const refetch = registered.get(URL.history);
  assert.equal(typeof refetch, "function");
  assert.deepEqual(await refetch(), { rows: HISTORY_ROWS });
  answer = () => response({ nope: true });
  await assert.rejects(() => refetch(), /bad supplements\/history answer/);
  assert.equal(h.calls.writes.length, 0);
});

test("section: several products can be checked; each keeps its own amount and unit, and Log selected counts and sends each one", async (t) => {
  const h = mountSection(t);
  await h.flush();
  const group = h.find((n) => n.props?.role === "group" && n.props["aria-label"] === "Your supplements")[0];
  assert.ok(group, "the options are one group named for the supplements");
  h.tick("Synthetic Beta");
  h.tick("Synthetic Delta");
  await h.flush();
  assert.equal(h.isOn("Synthetic Beta"), true);
  assert.equal(h.isOn("Synthetic Delta"), true, "a check does not uncheck the others");
  assert.equal(h.buttons("Log selected (2)").length, 1);

  h.field("Amount of Synthetic Beta").props.onChange({ target: { value: "3" } });
  h.field("Unit of Synthetic Beta").props.onChange({ target: { value: "mg" } });
  await h.flush();
  assert.equal(h.field("Amount of Synthetic Beta").props.value, "3");
  assert.equal(h.field("Unit of Synthetic Beta").props.value, "mg");
  assert.equal(h.field("Amount of Synthetic Delta").props.value, "", "Delta's amount is its own: still one serving");
  assert.equal(h.field("Unit of Synthetic Delta").props.value, "serving");
  assert.equal(h.calls.writes.length, 0, "typing writes nothing");

  await h.click("Log selected (2)");
  await h.flush();
  assert.equal(h.calls.writes.length, 2, "one write per checked product");
  assert.equal(h.calls.writes[0].body.product_id, "p-beta");
  assert.equal(h.calls.writes[0].body.amount, 3);
  assert.equal(h.calls.writes[0].body.unit, "mg");
  assert.equal(h.calls.writes[1].body.product_id, "p-delta");
  assert.equal(h.calls.writes[1].body.amount, null, "Delta: no amount typed, so one serving");
  assert.equal(h.calls.writes[1].body.unit, null);
  assert.equal(h.buttons("Log selected (0)")[0].props.disabled, true, "both logged: nothing left checked");
  assert.equal(h.isOn("Synthetic Beta"), false);
  assert.equal(h.isOn("Synthetic Delta"), false);
});

test("section: each product's unit list is its own: a scoop product offers its count unit, a capsule product does not", async (t) => {
  const scoop = (id, name) => ({ ...prod(id, name), serving_unit: "Scoop" });
  const three = [scoop("p-aa", "Synthetic Aa"), prod("p-bb", "Synthetic Bb"), scoop("p-cc", "Synthetic Cc")];
  const h = mountSection(t, {
    answers: {
      [URL.products]: () => response({ products: three }),
      [URL.history]: () => response({ rows: [] }),
      [URL.today]: () => response({ date: TODAY, intakes: [], reminders: [] }),
    },
  });
  await h.flush();
  assert.deepEqual(h.optionNames(), ["Synthetic Aa", "Synthetic Bb", "Synthetic Cc"]);
  h.tick("Synthetic Aa");
  h.tick("Synthetic Bb");
  await h.flush();
  h.field("Amount of Synthetic Aa").props.onChange({ target: { value: "2" } });
  h.field("Unit of Synthetic Aa").props.onChange({ target: { value: "Scoop" } });
  await h.flush();
  const unitsOf = (label) => h.find((n) => n.type === "select" && n.props["aria-label"] === label)[0].props.children
    .flatMap((c) => (Array.isArray(c) ? c : [c])).filter((o) => o && o.type === "option").map((o) => o.props.value);
  assert.ok(unitsOf("Unit of Synthetic Aa").includes("Scoop"), "a scoop product offers scoops");
  assert.ok(!unitsOf("Unit of Synthetic Bb").includes("Scoop"), "a capsule product does not");
  assert.equal(h.field("Amount of Synthetic Bb").props.value, "", "Bb's amount is not Aa's");
  assert.equal(h.field("Unit of Synthetic Bb").props.value, "serving");
  h.tick("Synthetic Cc");
  await h.flush();
  assert.equal(h.field("Amount of Synthetic Cc").props.value, "", "a product checked later starts at one serving");
  assert.equal(h.field("Amount of Synthetic Aa").props.value, "2", "the earlier one keeps its amount");
  assert.equal(h.field("Unit of Synthetic Aa").props.value, "Scoop");
  assert.equal(h.calls.writes.length, 0);
});

test("section: Log selected sends each checked product in turn; a refused one stays checked with its error and its own Retry, and Retry sends only that one", async (t) => {
  // Write 1 (Alpha) is held; the checks are locked while the batch runs. Write 2 (Beta) is refused; write 3 (Gamma) saves.
  const first = deferred();
  const h = mountSection(t, {
    post: (url, n) => {
      if (n === 1) return first.promise;
      if (n === 2) return response({ ok: false, error: "Synthetic refusal" }, 422);
      return response({ ok: true, product: "Synthetic", logged: [{ intake_id: 60 + n, time: null }], doses_each: 1, intake_date: TODAY });
    },
  });
  await h.flush();
  h.tick("Synthetic Alpha");
  h.tick("Synthetic Beta");
  h.tick("Synthetic Gamma");
  await h.flush();
  await h.click("Log selected (3)");
  await h.flush();
  assert.equal(h.calls.writes.length, 1, "the first one is in flight; the next waits for it");
  assert.equal(h.box("Synthetic Gamma").props.disabled, true, "the checks are locked while the batch runs");

  first.resolve(response({ ok: true, product: "Synthetic Alpha", logged: [{ intake_id: 50, time: null }], doses_each: 1, intake_date: TODAY }));
  await h.flush();
  assert.deepEqual(h.calls.writes.map((w) => w.body.product_id), ["p-alpha", "p-beta", "p-gamma"], "each in turn, one refusal does not stop the next");
  assert.equal(h.isOn("Synthetic Alpha"), false, "a saved one is unchecked");
  assert.equal(h.isOn("Synthetic Gamma"), false, "and so is the one after the refusal");
  assert.equal(h.isOn("Synthetic Beta"), true, "the refused one stays checked");
  assert.match(h.text(), /Synthetic refusal/, "with its error");
  const beta = h.calls.writes[1].body;
  assert.equal(h.field("Amount of Synthetic Beta").props.value, "", "its amount is what was typed (none)");
  assert.equal(h.box("Synthetic Beta").props.disabled, false, "unlocked again after the batch");

  // Retry: only Beta is sent again, at the times its first attempt used; Alpha and Gamma are not sent again.
  await h.click("Retry");
  await h.flush();
  assert.equal(h.calls.writes.length, 4);
  assert.equal(h.calls.writes[3].body.product_id, "p-beta");
  assert.deepEqual(h.calls.writes[3].body.times, beta.times, "the retry sends the same time as the first attempt");
  assert.equal(h.isOn("Synthetic Beta"), false, "saved on retry: unchecked");
  assert.equal(h.buttons("Retry").length, 0);
  assert.equal(h.calls.writes.filter((w) => w.body.product_id === "p-alpha").length, 1, "Alpha was never sent twice");
  assert.equal(h.calls.writes.filter((w) => w.body.product_id === "p-gamma").length, 1, "Gamma was never sent twice");
});

test("section: a Say it product moved into the form with Edit keeps its amount, unit and time when another option is tapped", async (t) => {
  const draft = { section: "supplements", id: 41, at: Date.now(), said: "synthetic", value: [{ kind: "product", product_id: "p-beta", name: "Synthetic Beta", amount: 15, unit: "mg", times: ["08:30"], date: null }] };
  const h = mountSection(t, {
    draft,
    post: (url, n) => (n === 1
      ? response({ ok: false, error: "Synthetic refusal" }, 422)
      : response({ ok: true, product: "Synthetic Gamma", logged: [{ intake_id: 98, time: null }], doses_each: 1, intake_date: TODAY })),
  });
  await h.flush();
  // The suggestion is logged on its own after 0.8 s; the refusal leaves it listed with Edit.
  await new Promise((resolve) => setTimeout(resolve, 900));
  await h.flush();
  assert.equal(h.calls.writes.length, 1, "the suggestion's own autosave");
  assert.match(h.text(), /Synthetic refusal/);
  await h.click("Edit");
  await h.flush();
  assert.equal(h.isOn("Synthetic Beta"), true, "Edit checks the suggested product");
  assert.equal(h.field("Amount of Synthetic Beta").props.value, "15");
  assert.equal(h.field("Unit of Synthetic Beta").props.value, "mg");
  assert.equal(h.field("Time 1").props.value, "08:30");

  // Another check keeps the suggestion's own amount and unit; the new product has its own (one serving).
  h.tick("Synthetic Gamma");
  await h.flush();
  assert.equal(h.isOn("Synthetic Beta"), true);
  assert.equal(h.field("Unit of Synthetic Beta").props.value, "mg", "15 mg stays 15 mg");
  assert.equal(h.field("Amount of Synthetic Gamma").props.value, "", "Gamma starts at one serving");
  assert.equal(h.calls.writes.length, 1, "the check writes nothing");
  await h.click("Log selected (2)");
  await h.flush();
  assert.equal(h.calls.writes.length, 3);
  assert.deepEqual(h.calls.writes[1].body, { product_id: "p-beta", product: "Synthetic Beta", amount: 15, unit: "mg", times: ["08:30"], date: null });
  assert.deepEqual(h.calls.writes[2].body, { product_id: "p-gamma", product: "Synthetic Gamma", amount: null, unit: null, times: ["08:30"], date: null });
});

test("source: the options are checkboxes in one group, 44 px targets, accent when checked, visible focus; a check only sets state, Log selected is the write", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "app/log/sections/Supplements.tsx"), "utf8");
  assert.match(src, /const pill =\s*"[^"]*min-h-11[^"]*max-w-full|const pill =\s*"[^"]*max-w-full[^"]*min-h-11/);
  assert.match(src, /const pill =\s*"[^"]*focus-visible:outline-accent/);
  assert.match(src, /const pillOn = "border-accent bg-accent\/15/);
  assert.match(src, /role="group" aria-label="Your supplements" className="flex flex-wrap gap-2"/);
  assert.match(src, /type="checkbox"\s+checked=\{on\}/);
  assert.match(src, /onChange=\{\(e\) => toggleProduct\(p, e\.target\.checked\)\}/);
  assert.match(src, /onClick=\{\(\) => void submit\(\[\.\.\.checked\.keys\(\)\]\)\}/, "Log selected sends every checked product");
  assert.match(src, /`Log selected \(\$\{checked\.size\}\)`/);
  const pick = src.slice(src.indexOf("function toggleProduct("), src.indexOf("/** One product write"));
  assert.ok(pick.length > 0 && !/fetch\(|postJson|logProduct\(/.test(pick), "toggleProduct writes nothing");
  // The history is one of the HTML's early reads (the options never wait for it, it only orders them).
  assert.match(src, /const HISTORY_URL = LOG_SUPPLEMENTS_HISTORY_URL;/);
  const early = loadTs("lib/log-early.ts");
  assert.equal(early.LOG_SUPPLEMENTS_HISTORY_URL, URL.history);
  assert.ok(early.LOG_EARLY_GETS.includes(URL.history));
});
