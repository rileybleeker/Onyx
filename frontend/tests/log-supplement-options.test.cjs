// Run: node --test tests/log-supplement-options.test.cjs
// /log Supplements, "Log a product" (2026-11-16, Riley: "I should be able to click the existing options, instead of
// having to search"): every /supplements product is a tappable option without typing, most used first (single
// doses in the last 30 days, then the most recent, then the name); the search box filters the same options; tapping
// one fills the form like choosing a search result did and writes nothing (Log stays the write); the options never
// wait for a network read of the history, and their order is fixed on first display while the section is mounted;
// the options are checkboxes (several can be selected: tests/log-supplement-multi.test.cjs covers the selection, the
// batch and the outcomes); a Log answering late never clears a newer pick; Say it suggestions moved in with Edit
// keep their amount, unit and times.
// SYNTHETIC DATA ONLY: invented product names, ids and dates; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");
const { mountClient, response, deferred, withGlobals } = require("./helpers/hook-harness.cjs");

const O = loadTs("lib/log-supplement-options.ts");
// Every "Log selected" POST carries its own event_key (a fresh UUID per product; see lib/log-supplement-multi.ts).
// The key's own rules are pinned in log-supplement-multi.test.cjs; here it is checked and set aside.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sentBody = (write) => {
  const { event_key, ...rest } = write.body;
  assert.match(event_key, UUID_RE, "the POST carries an event_key");
  return rest;
};
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
  // Several selected: each one below the cap is kept on screen (in list order); ids not in the list are ignored.
  const many = O.visibleOptions(list, false, ["p14", "p3", "p12", "not-listed"]);
  assert.deepEqual(many.shown.slice(O.OPTIONS_CAP).map((p) => p.product_id), ["p12", "p14"]);
  assert.equal(many.more, 15 - O.OPTIONS_CAP - 2);
  assert.equal(O.visibleOptions(list, false, []).shown.length, O.OPTIONS_CAP);
});

test("labels: the name; the brand only when two products share the name", () => {
  const labels = O.optionLabels([prod("1", "Synthetic Glycinate", "Brand One"), prod("2", "Synthetic Glycinate", "Brand Two"), prod("3", null, "Only Brand"), prod("4", "Synthetic Solo")]);
  assert.equal(labels.get("1"), "Synthetic Glycinate · Brand One");
  assert.equal(labels.get("2"), "Synthetic Glycinate · Brand Two");
  assert.equal(labels.get("3"), "Only Brand");
  assert.equal(labels.get("4"), "Synthetic Solo");
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

// One scope per test. Its single t.after unmounts every section mounted in the test (last first) and is registered
// before the stand-in globals' restore hook: node runs t.after hooks first-in-first-out, and each section's cleanup
// removes its listener from `document`, so the unmounts must run while the stand-in globals are still set.
const testScopes = new WeakMap();
function testScope(t) {
  let scope = testScopes.get(t);
  if (!scope) {
    scope = { handles: [], current: null };
    testScopes.set(t, scope);
    t.after(() => { while (scope.handles.length) scope.handles.pop().unmount(); });
    withGlobals(t, {
      document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
      fetch: (url, init) => scope.current.fetch(url, init),
    });
  }
  return scope;
}

function mountSection(t, { cache = new Map(), registered = new Map(), hang = new Set(), disk = new Map(), answers = {}, post, draft = null } = {}) {
  const calls = { writes: [], gets: [] };
  const defaults = {
    [URL.products]: () => response({ products: FIVE }),
    [URL.today]: () => response(TODAY_RESP),
    [URL.stacks]: () => response({ stacks: [STACK] }),
    [URL.history]: () => response({ rows: HISTORY_ROWS }),
  };
  const scope = testScope(t);
  // This section's fetch stand-in; the global `fetch` installed by testScope forwards to whichever section mounted last.
  scope.current = {
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
  };
  const drafts = { current: null };
  const clear = (id) => { if (drafts.current.draft && (id == null || drafts.current.draft.id === id)) drafts.current = { draft: null, clear }; };
  drafts.current = { draft, clear };
  const h = mountClient("app/log/sections/Supplements.tsx", {
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
  scope.handles.push(h);
  const options = () => h.find((n) => n.type === "button" && n.props.role === "checkbox");
  const optionNames = () => options().map((n) => h.text(n));
  const option = (name) => {
    const found = options().find((n) => h.text(n) === name);
    assert.ok(found, `option exists: ${name}`);
    return found;
  };
  const field = (label) => h.find((n) => (n.type === "input" || n.type === "select") && n.props["aria-label"] === label)[0];
  return { ...h, calls, options, optionNames, option, field };
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
  assert.ok(h.options().every((n) => n.props["aria-checked"] === false), "nothing selected yet");
  assert.equal(h.field("Filter your supplements"), undefined, "a short list needs no search box");
  assert.equal(h.calls.writes.length, 0, "opening the section writes nothing");
});

test("section: tapping an option selects it like a checkbox and writes nothing; Log selected is the write", async (t) => {
  const h = mountSection(t, {
    post: () => response({ ok: true, product: "Synthetic Beta", logged: [{ intake_id: 99, time: null }], doses_each: 1, intake_date: TODAY }),
  });
  await h.flush();
  assert.deepEqual(h.optionNames(), ["Synthetic Beta", "Synthetic Epsilon", "Synthetic Gamma", "Synthetic Alpha", "Synthetic Delta"], "ordered from the server's answers");
  assert.equal(h.field("Amount for Synthetic Gamma"), undefined, "no amount before a pick");

  h.option("Synthetic Gamma").props.onClick();
  await h.flush();
  assert.equal(h.option("Synthetic Gamma").props["aria-checked"], true, "the tapped option is marked");
  assert.equal(h.options().filter((n) => n.props["aria-checked"]).length, 1);
  assert.equal(h.field("Amount for Synthetic Gamma").props.value, "", "amount = one serving (the label's)");
  assert.equal(h.field("Unit for Synthetic Gamma").props.value, "serving");
  assert.equal(h.field("Day").props.value, "today", "behavioral today");
  assert.match(h.text(), /Now/, "time = now");
  assert.equal(h.calls.writes.length, 0, "a tap writes nothing");

  h.option("Synthetic Beta").props.onClick();
  await h.flush();
  assert.equal(h.option("Synthetic Beta").props["aria-checked"], true, "another tap adds a second product");
  assert.equal(h.option("Synthetic Gamma").props["aria-checked"], true, "the first stays selected");
  assert.equal(h.calls.writes.length, 0);

  h.option("Synthetic Gamma").props.onClick();
  await h.flush();
  assert.equal(h.option("Synthetic Gamma").props["aria-checked"], false, "a second tap unselects it");
  assert.equal(h.field("Amount for Synthetic Gamma"), undefined);
  assert.equal(h.calls.writes.length, 0);

  await h.click("Log selected (1)");
  await h.flush();
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.writes[0].url, "/api/supplements/log-product");
  assert.deepEqual(sentBody(h.calls.writes[0]), { product_id: "p-beta", product: "Synthetic Beta", amount: null, unit: null, times: [], date: null });
  assert.equal(h.field("Amount for Synthetic Beta"), undefined, "a saved product is no longer edited");
  assert.match(h.text(), /Saved/);
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

  h.field("Filter your supplements").props.onChange({ target: { value: "cedar" } });
  await h.flush();
  assert.deepEqual(h.optionNames(), ["Synthetic Cedar"], "the filter narrows the options");
  h.field("Filter your supplements").props.onChange({ target: { value: "quartz" } });
  await h.flush();
  assert.equal(h.options().length, 0);
  assert.match(h.text(), /No match in your supplements/);
  h.field("Filter your supplements").props.onChange({ target: { value: "" } });
  await h.flush();
  assert.equal(h.options().length, 14, "clearing the filter brings every option back");
  assert.equal(h.calls.writes.length, 0);
});

// Without the history: today's single dose first (Epsilon; Delta's dose today came from a stack), then by name.
const WITHOUT_HISTORY = ["Synthetic Epsilon", "Synthetic Alpha", "Synthetic Beta", "Synthetic Delta", "Synthetic Gamma"];
const skeletonPills = (h) => h.find((n) => typeof n.props?.className === "string" && n.props.className.includes("skeleton h-11 w-28"));

test("section: cached products show on the first flush while the history read is still out (no network wait); its answer moves nothing, nor do a Log and Clear", async (t) => {
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

  h.option("Synthetic Alpha").props.onClick();
  await h.flush();
  await h.click("Log selected (1)");
  await h.flush();
  assert.equal(h.calls.writes.length, 1);
  assert.ok(todayReads >= 2, "today was read again after the Log");
  assert.deepEqual(h.optionNames(), WITHOUT_HISTORY, "a dose just logged does not move the options");
  h.option("Synthetic Gamma").props.onClick();
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

test("section: the options are a group of checkboxes, each its own Tab stop; every selected product has its own amount and unit", async (t) => {
  const h = mountSection(t);
  await h.flush();
  const group = h.find((n) => n.props?.role === "group" && n.props["aria-label"] === "Your supplements")[0];
  assert.ok(group, "a labelled group");
  assert.equal(h.find((n) => n.props?.role === "radiogroup").length, 0, "not a radio group any more");
  assert.ok(h.options().every((n) => n.props.tabIndex === undefined && n.props.type === "button"), "no roving tabindex: Tab reaches each checkbox, Space / Enter toggles it");
  h.option("Synthetic Epsilon").props.onClick();
  h.option("Synthetic Delta").props.onClick();
  await h.flush();
  h.field("Amount for Synthetic Epsilon").props.onChange({ target: { value: "2" } });
  h.field("Unit for Synthetic Delta").props.onChange({ target: { value: "mg" } });
  await h.flush();
  assert.equal(h.field("Amount for Synthetic Epsilon").props.value, "2");
  assert.equal(h.field("Unit for Synthetic Epsilon").props.value, "serving", "the other unit is untouched");
  assert.equal(h.field("Unit for Synthetic Delta").props.value, "mg");
  assert.equal(h.field("Amount for Synthetic Delta").props.value, "");
  assert.equal(h.calls.writes.length, 0, "choosing and editing write nothing");
});

test("section: a batch answering after Riley selected another product keeps that selection and what he typed; only the first dose was sent", async (t) => {
  const first = deferred();
  const second = deferred();
  const h = mountSection(t, { post: (url, n) => (n === 1 ? first.promise : second.promise) });
  await h.flush();
  h.option("Synthetic Alpha").props.onClick();
  await h.flush();
  await h.click("Log selected (1)");
  await h.flush();
  h.option("Synthetic Beta").props.onClick();
  await h.flush();
  h.field("Amount for Synthetic Beta").props.onChange({ target: { value: "3" } });
  await h.flush();
  first.resolve(response({ ok: true, product: "Synthetic Alpha", logged: [{ intake_id: 50, time: null }], doses_each: 1, intake_date: TODAY }));
  await h.flush();
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.writes[0].body.product_id, "p-alpha", "the dose sent is the one selected when Log selected was tapped");
  assert.equal(h.option("Synthetic Beta").props["aria-checked"], true, "the new selection survives the first answer");
  assert.equal(h.field("Amount for Synthetic Beta").props.value, "3", "and so does what was typed");
  assert.match(h.text(), /1 saved/);

  // The same when the next Log is refused: the error is on that product, a product selected meanwhile stays.
  await h.click("Log selected (1)");
  await h.flush();
  h.option("Synthetic Gamma").props.onClick();
  await h.flush();
  second.resolve(response({ ok: false, error: "Synthetic refusal" }, 422));
  await h.flush();
  assert.equal(h.calls.writes.length, 2);
  assert.deepEqual(sentBody(h.calls.writes[1]), { product_id: "p-beta", product: "Synthetic Beta", amount: 3, unit: "serving", times: [], date: null });
  assert.equal(h.option("Synthetic Gamma").props["aria-checked"], true);
  assert.match(h.text(), /Not saved: Synthetic refusal/);
});

test("section: a Say it product moved in with Edit keeps its amount, unit and time when another option is tapped", async (t) => {
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
  assert.equal(h.option("Synthetic Beta").props["aria-checked"], true, "Edit selects the suggested product");
  assert.equal(h.field("Amount for Synthetic Beta").props.value, "15");
  assert.equal(h.field("Unit for Synthetic Beta").props.value, "mg");
  assert.equal(h.field("Time 1").props.value, "08:30");

  h.option("Synthetic Gamma").props.onClick();
  await h.flush();
  assert.equal(h.field("Unit for Synthetic Beta").props.value, "mg", "15 mg stays 15 mg");
  assert.equal(h.field("Unit for Synthetic Gamma").props.value, "serving", "a second product has its own dose");
  assert.equal(h.calls.writes.length, 1, "the tap writes nothing");
  await h.click("Log selected (2)");
  await h.flush();
  assert.equal(h.calls.writes.length, 3);
  assert.deepEqual(sentBody(h.calls.writes[1]), { product_id: "p-beta", product: "Synthetic Beta", amount: 15, unit: "mg", times: ["08:30"], date: null });
  assert.deepEqual(sentBody(h.calls.writes[2]), { product_id: "p-gamma", product: "Synthetic Gamma", amount: null, unit: null, times: ["08:30"], date: null });
});

test("source: the options are checkboxes with 44 px targets, accent when selected, visible focus; a tap only sets state", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "app/log/sections/Supplements.tsx"), "utf8");
  assert.match(src, /const pill =\s*"[^"]*min-h-11[^"]*max-w-full|const pill =\s*"[^"]*max-w-full[^"]*min-h-11/);
  assert.match(src, /const pill =\s*"[^"]*min-w-11/, "44 px wide as well as high");
  assert.match(src, /const pill =\s*"[^"]*focus-visible:outline-accent/);
  assert.match(src, /const pillOn = "border-accent bg-accent\/15/);
  assert.match(src, /role="group" aria-label="Your supplements" className="flex flex-wrap gap-2"/);
  assert.match(src, /role="checkbox"\s+aria-checked=\{on\}/);
  const pick = src.slice(src.indexOf("function onToggleOption("), src.indexOf("/** Empty the selection"));
  assert.ok(pick.length > 0 && !/fetch\(|postJson|sendProduct\(|logProduct\(/.test(pick), "a tap on an option writes nothing");
  // The history is one of the HTML's early reads (the options never wait for it, it only orders them).
  assert.match(src, /const HISTORY_URL = LOG_SUPPLEMENTS_HISTORY_URL;/);
  const early = loadTs("lib/log-early.ts");
  assert.equal(early.LOG_SUPPLEMENTS_HISTORY_URL, URL.history);
  assert.ok(early.LOG_EARLY_GETS.includes(URL.history));
});
