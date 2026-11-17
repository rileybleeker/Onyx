// Run: node --test tests/log-supplement-multi.test.cjs
// /log Supplements, "Log a product" as a multi-select (acceptance from the Codex post-deploy review of PR #478): tap
// several products (checkboxes), each with its own amount + unit, shared times + day, ONE "Log selected (N)" button
// that sends one POST /api/supplements/log-product per product (the existing route, no new write route); each product
// shows its own outcome (Saved + Undo / Already logged / Not saved + Retry / Not confirmed); a retry never sends a
// confirmed item again; an item whose answer was lost is not confirmed, not saved, and goes out again only on its own
// "Log again"; the search box filters options and never clears a selection; a Say it product suggestion moved in with
// Edit is selected with its amount.
// SYNTHETIC DATA ONLY: invented product names, ids and dates; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");
const { mountClient, response, deferred, withGlobals } = require("./helpers/hook-harness.cjs");

const M = loadTs("lib/log-supplement-multi.ts");
const O = loadTs("lib/log-supplement-options.ts");
const TODAY = loadTs("lib/checkin.ts").fallbackBehavioralToday(new Date());

const prod = (id, full_name, brand_name = "Synthetic Labs") => ({ product_id: id, brand_name, full_name, serving_size: 1, serving_unit: "capsule" });
const ids = (sel) => sel.map((i) => i.productId);

// ---- pure: lib/log-supplement-multi.ts ----

const SAVED = (n = 1) => ({ kind: "saved", label: "Synthetic", doses: 1, intakeDate: "2026-01-02", logged: Array.from({ length: n }, (_, i) => ({ intake_id: 100 + i, time: null })), skipped: 0 });
const answer = (status, json) => ({ ok: status >= 200 && status < 300, status, json });

test("select / deselect: a tap adds one serving, a second tap removes it, selection order is tap order, an item being saved stays", () => {
  let sel = M.EMPTY_SELECTION;
  sel = M.toggleItem(sel, "b");
  sel = M.toggleItem(sel, "a");
  sel = M.toggleItem(sel, "c");
  assert.deepEqual(ids(sel), ["b", "a", "c"]);
  assert.ok(sel.every((i) => i.amount === "" && i.unit === "serving" && i.outcome === null), "one serving each, nothing sent");
  sel = M.toggleItem(sel, "a");
  assert.deepEqual(ids(sel), ["b", "c"], "a second tap unselects");
  assert.equal(M.isSelected(sel, "a"), false);
  assert.equal(M.isSelected(sel, "b"), true);
  // An item whose request is out cannot be unselected (its answer is on its way).
  const busy = M.beginSend(sel, ["b"]);
  assert.deepEqual(ids(M.toggleItem(busy, "b")), ["b", "c"]);
  assert.equal(M.toggleItem(busy, "b")[0].outcome.kind, "saving");
  // A confirmed one can leave this list (the dose stays logged, it is under Logged today).
  const done = M.settle(busy, "b", SAVED());
  assert.deepEqual(ids(M.toggleItem(done, "b")), ["c"]);
  // The input is never changed in place.
  assert.deepEqual(ids(sel), ["b", "c"]);
});

test("each selected product has its own amount and unit; only a waiting item can change; a changed dose drops an old refusal", () => {
  let sel = M.toggleItem(M.toggleItem(M.EMPTY_SELECTION, "a"), "b");
  sel = M.setItemDose(sel, "a", { amount: "15", unit: "mg" });
  sel = M.setItemDose(sel, "b", { amount: "2" });
  assert.deepEqual(sel.map((i) => [i.productId, i.amount, i.unit]), [["a", "15", "mg"], ["b", "2", "serving"]]);
  // After a refusal the dose that was refused is replaced by an edit, so the item is simply waiting again.
  let r = M.beginSend(sel, ["a"]);
  r = M.settle(r, "a", { kind: "refused", error: "Synthetic refusal" });
  assert.equal(r[0].outcome.kind, "refused");
  r = M.setItemDose(r, "a", { amount: "20" });
  assert.equal(r[0].outcome, null);
  assert.equal(r[0].amount, "20");
  // Saved / saving / unconfirmed items do not change (an edit there would not be what was sent).
  for (const outcome of [SAVED(), { kind: "saving" }, { kind: "unconfirmed", error: "x" }, { kind: "already", label: "x", intakeDate: null, skipped: 1 }]) {
    const fixed = [{ productId: "a", amount: "1", unit: "serving", outcome }];
    assert.deepEqual(M.setItemDose(fixed, "a", { amount: "9", unit: "mg" }), fixed);
  }
  // A Say it suggestion moved in with Edit: a new product is selected with its amount; one waiting gets the dose;
  // a confirmed one is replaced by a fresh entry; one being saved is left alone.
  assert.deepEqual(M.addWithDose(M.EMPTY_SELECTION, "z", { amount: "400", unit: "IU" }), [{ productId: "z", amount: "400", unit: "IU", outcome: null }]);
  assert.equal(M.addWithDose(sel, "a", { amount: "7", unit: "g" })[0].amount, "7");
  assert.equal(M.addWithDose(M.settle(M.beginSend(sel, ["a"]), "a", SAVED()), "a", { amount: "7", unit: "g" })[0].outcome, null);
  const inFlight = M.beginSend(sel, ["a"]);
  assert.deepEqual(M.addWithDose(inFlight, "a", { amount: "7", unit: "g" }), inFlight);
  assert.deepEqual(M.parseAmount(""), null);
  assert.equal(M.parseAmount("1.5"), 1.5);
  for (const bad of ["0", "-2", "abc", "1e999"]) assert.equal(M.parseAmount(bad), "invalid", bad);
});

test("filtering hides options and never clears or changes a selection; a selected option further down stays visible", () => {
  const list = Array.from({ length: 15 }, (_, i) => prod(`p${i}`, `Synthetic ${["Amber", "Birch", "Cedar", "Dune", "Ember", "Fjord", "Grove", "Harbor", "Iris", "Juniper", "Kelp", "Lumen", "Moss", "Nectar", "Opal"][i]}`));
  let sel = M.EMPTY_SELECTION;
  for (const id of ["p2", "p13"]) sel = M.toggleItem(sel, id); // Cedar (shown) and Nectar (below the cap of 12)
  sel = M.setItemDose(sel, "p13", { amount: "3", unit: "mg" });
  const before = JSON.stringify(sel);
  for (const query of ["cedar", "quartz", "  ", "synthetic n", ""]) {
    const matches = O.filterOptions(list, query);
    O.visibleOptions(matches, false, ids(sel));
    assert.equal(JSON.stringify(sel), before, `the selection is the same after filtering "${query}"`);
  }
  // Filtered out = not an option on screen, still selected (the section lists every selected product on its own).
  const matches = O.filterOptions(list, "cedar");
  assert.deepEqual(matches.map((p) => p.product_id), ["p2"]);
  assert.deepEqual(O.visibleOptions(matches, false, ids(sel)).shown.map((p) => p.product_id), ["p2"], "an id that is not in the filtered list is not added");
  assert.equal(M.isSelected(sel, "p13"), true);
  assert.equal(M.countToLog(sel), 2, "both are still to be logged");
  // Unfiltered and capped: the selected option beyond the cap is added after the capped ones, so it can be unticked in place.
  const capped = O.visibleOptions(list, false, ids(sel));
  assert.equal(capped.shown.length, O.OPTIONS_CAP + 1);
  assert.equal(capped.shown.at(-1).product_id, "p13");
  assert.equal(capped.more, 15 - O.OPTIONS_CAP - 1);
});

test("retry skips what is confirmed: only waiting and refused items are sent, never a saved, already-logged or in-flight one", () => {
  let sel = ["a", "b", "c", "d", "e"].reduce((s, id) => M.toggleItem(s, id), M.EMPTY_SELECTION);
  assert.deepEqual(M.sendable(sel).map((i) => i.productId), ["a", "b", "c", "d", "e"]);
  sel = M.beginSend(sel, ["a", "b", "c", "d"]);
  assert.deepEqual(M.sendable(sel).map((i) => i.productId), ["e"], "the ones whose requests are out are not sent again");
  sel = M.settle(sel, "a", SAVED());
  sel = M.settle(sel, "b", { kind: "already", label: "B", intakeDate: "2026-01-02", skipped: 1 });
  sel = M.settle(sel, "c", { kind: "refused", error: "Synthetic refusal" });
  sel = M.settle(sel, "d", { kind: "unconfirmed", error: "No answer from Onyx" });
  // "Log selected (N)": the refused one and the one never sent; not the two confirmed, not the one whose answer was lost.
  assert.deepEqual(M.sendable(sel).map((i) => i.productId), ["c", "e"]);
  assert.equal(M.countToLog(sel), 2);
  // An item's own Retry / Log again names it: refused and unconfirmed go; a confirmed one never does, named or not.
  assert.deepEqual(M.sendable(sel, { only: ["c"], includeUnconfirmed: true }).map((i) => i.productId), ["c"]);
  assert.deepEqual(M.sendable(sel, { only: ["d"], includeUnconfirmed: true }).map((i) => i.productId), ["d"]);
  assert.deepEqual(M.sendable(sel, { only: ["a", "b"], includeUnconfirmed: true }), [], "confirmed items are never sent again");
  assert.deepEqual(M.sendable(sel, { includeUnconfirmed: true }).map((i) => i.productId), ["c", "e"], "includeUnconfirmed alone (no named item) sends no lost-answer item");
  // A late answer never overwrites an outcome: settle only fills an item that is waiting for its answer.
  assert.equal(M.settle(sel, "a", { kind: "refused", error: "late" })[0].outcome.kind, "saved");
  assert.equal(M.settle(sel, "e", SAVED())[4].outcome, null, "an answer for an item never sent is dropped");
  // The summary line counts each kind.
  assert.equal(M.summaryText(M.summarize(sel)), "1 saved, 1 already logged, 1 not saved, 1 not confirmed");
});

test("a lost answer is unconfirmed, not saved: a thrown request, a 5xx, a timeout, an unreadable 200 and the server's own may-be-saved flag", () => {
  for (const lost of [
    null,
    answer(500, { ok: false, error: "could not save" }),
    answer(503, {}),
    answer(408, {}),
    answer(200, {}),
    answer(200, { ok: true, logged: [] }),
    answer(400, { ok: false, error: "The database did not confirm this intake", incomplete: true }),
  ]) {
    const o = M.outcomeFromAnswer(lost, "Synthetic");
    assert.equal(o.kind, "unconfirmed", JSON.stringify(lost));
    assert.equal(M.isConfirmed(o), false);
  }
  // Definite answers.
  const saved = M.outcomeFromAnswer(answer(200, { ok: true, product: "Synthetic Beta", logged: [{ intake_id: 7, time: "8:30 AM" }, { intake_id: 8, time: "9:30 AM" }], doses_each: 2, intake_date: "2026-01-02" }), "x");
  assert.deepEqual(saved, { kind: "saved", label: "Synthetic Beta", doses: 2, intakeDate: "2026-01-02", logged: [{ intake_id: 7, time: "8:30 AM" }, { intake_id: 8, time: "9:30 AM" }], skipped: 0 });
  const already = M.outcomeFromAnswer(answer(200, { ok: true, product: "Synthetic Beta", logged: [], skipped_duplicates: ["8:30 AM"], intake_date: "2026-01-02" }), "x");
  assert.equal(already.kind, "already");
  assert.equal(M.isConfirmed(already), true, "an entry the server skipped as a duplicate exists: confirmed");
  const partial = M.outcomeFromAnswer(answer(200, { ok: true, logged: [{ intake_id: 9, time: null }], skipped_duplicates: ["8:30 AM"] }), "Fallback");
  assert.equal(partial.kind, "saved");
  assert.equal(partial.skipped, 1);
  assert.equal(partial.label, "Fallback");
  const refused = M.outcomeFromAnswer(answer(400, { ok: false, error: "\"x\" matches more than one product. Ask which one.", candidates: ["A", "B"] }), "x");
  assert.deepEqual(refused, { kind: "refused", error: "\"x\" matches more than one product. (A, B)" });
  assert.equal(M.outcomeFromAnswer(answer(400, { ok: false }), "x").error, "Not saved (400)");
  assert.equal(M.outcomeFromAnswer(answer(401, {}), "x").kind, "refused");
});

test("undo: a saved item waits again; a partly failed undo keeps the rows still logged", () => {
  let sel = M.beginSend(M.toggleItem(M.EMPTY_SELECTION, "a"), ["a"]);
  sel = M.settle(sel, "a", SAVED(3));
  assert.equal(M.undone(sel, "a")[0].outcome, null);
  assert.equal(M.countToLog(M.undone(sel, "a")), 1, "the dose is waiting again and can be logged again");
  const kept = M.keepLogged(sel, "a", [101]);
  assert.deepEqual(kept[0].outcome.logged, [{ intake_id: 101, time: null }]);
  assert.equal(M.keepLogged(sel, "a", [])[0].outcome, null);
  // Nothing but a saved item is touched.
  const waiting = M.toggleItem(M.EMPTY_SELECTION, "w");
  assert.deepEqual(M.undone(waiting, "w"), waiting);
});

test("runPool: at most `size` in flight, every item runs once, an empty list resolves", async () => {
  let inFlight = 0;
  let max = 0;
  const seen = [];
  await M.runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    seen.push(n);
    inFlight -= 1;
  });
  assert.equal(max, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
  await M.runPool([], 3, async () => assert.fail("nothing to run"));
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
const TODAY_RESP = { date: TODAY, intakes: [], reminders: [] };
const NAMES = Object.fromEntries(FIVE.map((p) => [p.product_id, p.full_name]));

function fakeCache(store, registered = new Map()) {
  const GONE = Symbol("gone");
  const clientCache = {
    peek: (k) => store.get(k),
    read: (k) => Promise.resolve(store.get(k)),
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

/** An ok answer of the route for the product in the request body: one dose row (id 100 + a counter). */
function okFor(body, counter) {
  return response({ ok: true, product: NAMES[body.product_id] ?? body.product, product_id: body.product_id, logged: [{ intake_id: 100 + counter, time: "8:30 AM" }], doses_each: body.amount ?? 1, intake_date: TODAY });
}

function mountSection(t, { products = FIVE, post, draft = null, answers = {} } = {}) {
  const calls = { writes: [], gets: [] };
  const defaults = {
    [URL.products]: () => response({ products }),
    [URL.today]: () => response(TODAY_RESP),
    [URL.stacks]: () => response({ stacks: [STACK] }),
    [URL.history]: () => response({ rows: [] }),
  };
  let h;
  t.after(() => h?.unmount());
  withGlobals(t, {
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    fetch: async (url, init = {}) => {
      const method = init.method ?? "GET";
      if (method !== "GET") {
        const body = init.body ? JSON.parse(init.body) : null;
        calls.writes.push({ url, method, body });
        return post ? post({ url, method, body, n: calls.writes.length }) : response({ ok: true, logged: [], intake_date: TODAY });
      }
      calls.gets.push(url);
      const a = answers[url] ?? defaults[url];
      if (!a) throw new Error(`unexpected request ${method} ${url}`);
      return a();
    },
  });
  const drafts = { current: null };
  const clear = (id) => { if (drafts.current.draft && (id == null || drafts.current.draft.id === id)) drafts.current = { draft: null, clear }; };
  drafts.current = { draft, clear };
  h = mountClient("app/log/sections/Supplements.tsx", {
    stubs: {
      "@/components/FeedContext": { useInFeed: () => false },
      "lucide-react": { Check: () => null, Plus: () => null, X: () => null },
      "@/lib/client-cache": fakeCache(new Map()),
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
  const options = () => h.find((n) => n.type === "button" && n.props.role === "checkbox");
  const option = (name) => {
    const found = options().find((n) => h.text(n) === name);
    assert.ok(found, `option exists: ${name}`);
    return found;
  };
  const checked = () => options().filter((n) => n.props["aria-checked"]).map((n) => h.text(n));
  const field = (label) => h.find((n) => (n.type === "input" || n.type === "select") && n.props["aria-label"] === label)[0];
  const selectedList = () => h.find((n) => n.type === "ul" && n.props["aria-label"] === "Selected supplements")[0];
  const rows = () => (selectedList() ? selectedList().props.children.map((li) => h.text(li)) : []);
  const tap = async (...names) => { for (const name of names) option(name).props.onClick(); await h.flush(); };
  return { ...h, calls, options, option, checked, field, selectedList, rows, tap };
}

test("section: several products are selected by tapping (checkbox semantics), nothing is written, and the primary button counts them", async (t) => {
  const h = mountSection(t);
  await h.flush();
  const group = h.find((n) => n.props?.role === "group" && n.props["aria-label"] === "Your supplements")[0];
  assert.ok(group, "the options are a labelled group of checkboxes (not a radio group)");
  assert.equal(h.find((n) => n.props?.role === "radiogroup" || n.props?.role === "radio").length, 0);
  assert.ok(h.options().every((n) => n.props["aria-checked"] === false && n.props.type === "button"), "every option is a checkbox, none checked");
  assert.ok(h.options().every((n) => n.props.tabIndex === undefined), "each checkbox is its own Tab stop (Space / Enter toggles it)");
  assert.equal(h.selectedList(), undefined, "no selection area before a tap");
  assert.equal(h.buttons("Log selected (0)").length, 0);

  await h.tap("Synthetic Gamma", "Synthetic Alpha", "Synthetic Beta");
  assert.deepEqual(h.checked().sort(), ["Synthetic Alpha", "Synthetic Beta", "Synthetic Gamma"], "several checked at once");
  assert.equal(h.rows().length, 3);
  assert.ok(h.field("Amount for Synthetic Gamma") && h.field("Unit for Synthetic Gamma"), "each selected product has its own amount and unit");
  assert.equal(h.field("Amount for Synthetic Gamma").props.value, "", "default one serving");
  assert.equal(h.field("Unit for Synthetic Gamma").props.value, "serving");
  assert.equal(h.field("Day").props.value, "today");
  assert.match(h.text(), /Now/);
  assert.equal(h.buttons("Log selected (3)").length, 1);
  assert.equal(h.calls.writes.length, 0, "taps write nothing");

  await h.tap("Synthetic Alpha");
  assert.deepEqual(h.checked().sort(), ["Synthetic Beta", "Synthetic Gamma"], "a second tap unchecks");
  assert.equal(h.buttons("Log selected (2)").length, 1);
  assert.equal(h.calls.writes.length, 0);
});

test("section: Log selected sends one request per product to the existing route, each with its own amount and unit, sharing times and day", async (t) => {
  let counter = 0;
  const h = mountSection(t, { post: ({ body }) => okFor(body, ++counter) });
  await h.flush();
  await h.tap("Synthetic Beta", "Synthetic Gamma", "Synthetic Alpha");
  h.field("Amount for Synthetic Gamma").props.onChange({ target: { value: "2" } });
  h.field("Unit for Synthetic Alpha").props.onChange({ target: { value: "mg" } });
  h.field("Amount for Synthetic Alpha").props.onChange({ target: { value: "15" } });
  h.field("Day").props.onChange({ target: { value: "yesterday" } });
  await h.flush();
  assert.equal(h.calls.writes.length, 0, "editing writes nothing");
  await h.click("Log selected (3)");
  await h.flush();
  assert.equal(h.calls.writes.length, 3, "one request per product");
  assert.ok(h.calls.writes.every((w) => w.url === "/api/supplements/log-product" && w.method === "POST"), "only the existing route");
  const by = Object.fromEntries(h.calls.writes.map((w) => [w.body.product_id, w.body]));
  const yesterday = new Date(`${TODAY}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const date = yesterday.toISOString().slice(0, 10);
  assert.deepEqual(by["p-beta"], { product_id: "p-beta", product: "Synthetic Beta", amount: null, unit: null, times: [], date });
  assert.deepEqual(by["p-gamma"], { product_id: "p-gamma", product: "Synthetic Gamma", amount: 2, unit: "serving", times: [], date });
  assert.deepEqual(by["p-alpha"], { product_id: "p-alpha", product: "Synthetic Alpha", amount: 15, unit: "mg", times: [], date });
  assert.equal(h.rows().filter((r) => /Saved/.test(r)).length, 3, "each product shows its own Saved");
  assert.equal(h.buttons("Log selected (0)").length, 0, "nothing left to log: the button gives way to Done");
  assert.equal(h.buttons("Done").length, 1);
  await h.click("Done");
  await h.flush();
  assert.equal(h.selectedList(), undefined, "Done empties the list");
  assert.equal(h.calls.writes.length, 3, "Done writes nothing");
});

test("section: a batch runs at most three requests at once", async (t) => {
  const answers = [];
  let inFlight = 0;
  let max = 0;
  const h = mountSection(t, {
    post: ({ body }) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      const d = deferred();
      answers.push({ body, d });
      return d.promise.finally(() => { inFlight -= 1; });
    },
  });
  await h.flush();
  await h.tap("Synthetic Alpha", "Synthetic Beta", "Synthetic Gamma", "Synthetic Delta", "Synthetic Epsilon");
  await h.click("Log selected (5)");
  await h.flush();
  assert.equal(h.calls.writes.length, 3, "three started, two queued");
  assert.equal(h.buttons("Saving…").length, 1);
  assert.ok(h.buttons("Saving…")[0].props.disabled, "the primary button is off while a batch is out");
  answers[0].d.resolve(okFor(answers[0].body, 1));
  await h.flush();
  assert.equal(h.calls.writes.length, 4, "a finished request lets the next one start");
  for (const a of answers.slice(1)) a.d.resolve(okFor(a.body, 2));
  await h.flush();
  for (const a of answers.slice(3)) a.d.resolve(okFor(a.body, 3));
  await h.flush();
  assert.equal(h.calls.writes.length, 5);
  assert.equal(max, 3);
  assert.equal(h.rows().filter((r) => /Saved/.test(r)).length, 5);
});

test("section: a second tap on Log selected before the screen re-renders sends nothing more (no doubled dose)", async (t) => {
  let counter = 0;
  const h = mountSection(t, { post: ({ body }) => okFor(body, ++counter) });
  await h.flush();
  await h.tap("Synthetic Alpha", "Synthetic Beta");
  const button = h.buttons("Log selected (2)")[0];
  button.props.onClick();
  button.props.onClick(); // the same handler again, as a double tap that lands before the re-render
  await h.flush();
  assert.equal(h.calls.writes.length, 2, "each product was sent once");
  assert.equal(h.rows().filter((r) => /Saved/.test(r)).length, 2);
});

test("section: a refused item shows Not saved with Retry; Retry (and Log selected) send only that item, never a saved one again", async (t) => {
  let betaTries = 0;
  const counts = {};
  const h = mountSection(t, {
    post: ({ body }) => {
      counts[body.product_id] = (counts[body.product_id] ?? 0) + 1;
      if (body.product_id === "p-beta" && ++betaTries === 1) return response({ ok: false, error: "Synthetic refusal" }, 400);
      return okFor(body, 10 + h.calls.writes.length);
    },
  });
  await h.flush();
  await h.tap("Synthetic Alpha", "Synthetic Beta", "Synthetic Gamma");
  await h.click("Log selected (3)");
  await h.flush();
  assert.deepEqual(counts, { "p-alpha": 1, "p-beta": 1, "p-gamma": 1 });
  assert.match(h.rows().find((r) => /Synthetic Beta/.test(r)), /Not saved: Synthetic refusal/);
  assert.equal(h.rows().filter((r) => /Saved/.test(r)).length, 2);
  assert.match(h.text(), /2 saved, 1 not saved/);
  assert.equal(h.buttons("Log selected (1)").length, 1, "N counts only what still has to be logged");
  assert.equal(h.buttons("Retry Synthetic Beta").length, 1, "the refused item has its own Retry");
  assert.equal(h.buttons("Undo Synthetic Alpha").length, 1, "a saved item has its own Undo");
  assert.ok(h.field("Amount for Synthetic Beta"), "a refused item stays editable");
  assert.equal(h.field("Amount for Synthetic Alpha"), undefined, "a saved item is no longer editable");

  await h.click("Log selected (1)");
  await h.flush();
  assert.deepEqual(counts, { "p-alpha": 1, "p-beta": 2, "p-gamma": 1 }, "the retry sent Beta only");
  assert.equal(h.calls.writes.length, 4);
  assert.equal(h.rows().filter((r) => /Saved/.test(r)).length, 3);
  assert.equal(h.buttons("Done").length, 1);
  // Nothing is left to send: even a stray call of the handler (a double tap) writes nothing.
  assert.equal(h.buttons("Log selected (0)").length, 0);
});

test("section: a lost answer is Not confirmed, not Saved: Log selected leaves it alone and only its own Log again sends it", async (t) => {
  let betaTries = 0;
  const h = mountSection(t, {
    post: ({ body, n }) => {
      if (body.product_id === "p-beta" && ++betaTries === 1) return Promise.reject(new Error("synthetic network failure"));
      return okFor(body, n);
    },
  });
  await h.flush();
  await h.tap("Synthetic Alpha", "Synthetic Beta");
  await h.click("Log selected (2)");
  await h.flush();
  const beta = h.rows().find((r) => /Synthetic Beta/.test(r));
  assert.match(beta, /Not confirmed: No answer from Onyx/);
  assert.doesNotMatch(beta, /Saved/, "a lost answer is never shown as saved");
  assert.match(h.text(), /1 saved, 1 not confirmed/);
  assert.equal(h.field("Amount for Synthetic Beta"), undefined, "its dose is frozen: what may have been saved is what was sent");
  const primary = h.buttons("Log selected (0)")[0];
  assert.ok(primary && primary.props.disabled, "nothing a plain Log selected may send");
  assert.equal(h.calls.writes.length, 2);
  await primary.props.onClick?.();
  await h.flush();
  assert.equal(h.calls.writes.length, 2, "a plain Log selected never re-sends a lost answer");

  await h.click("Log Synthetic Beta again");
  await h.flush();
  assert.equal(h.calls.writes.length, 3, "its own Log again sends it");
  assert.equal(h.calls.writes[2].body.product_id, "p-beta");
  assert.equal(h.rows().filter((r) => /Saved/.test(r)).length, 2);
});

test("section: a 5xx is Not confirmed too, and a server answer that nothing new was written is Already logged (confirmed, never re-sent)", async (t) => {
  const h = mountSection(t, {
    post: ({ body }) => {
      if (body.product_id === "p-beta") return response({ ok: false, error: "could not save" }, 500);
      return response({ ok: true, product: "Synthetic Alpha", logged: [], skipped_duplicates: ["8:30 AM"], doses_each: 1, intake_date: TODAY });
    },
  });
  await h.flush();
  await h.tap("Synthetic Alpha", "Synthetic Beta");
  await h.click("Log selected (2)");
  await h.flush();
  assert.match(h.rows().find((r) => /Synthetic Beta/.test(r)), /Not confirmed/);
  assert.match(h.rows().find((r) => /Synthetic Alpha/.test(r)), /Already logged/);
  assert.equal(h.buttons("Undo Synthetic Alpha").length, 0, "nothing was written now, so there is nothing to undo here");
  assert.match(h.text(), /1 already logged, 1 not confirmed/);
  assert.equal(h.buttons("Log selected (0)").length, 1);
  assert.equal(h.calls.writes.length, 2);
});

test("section: an amount that is not a number is refused on screen without a request; the others are still sent", async (t) => {
  const h = mountSection(t, { post: ({ body, n }) => okFor(body, n) });
  await h.flush();
  await h.tap("Synthetic Alpha", "Synthetic Beta");
  h.field("Amount for Synthetic Beta").props.onChange({ target: { value: "-3" } });
  await h.flush();
  await h.click("Log selected (2)");
  await h.flush();
  assert.equal(h.calls.writes.length, 1);
  assert.equal(h.calls.writes[0].body.product_id, "p-alpha");
  assert.match(h.rows().find((r) => /Synthetic Beta/.test(r)), /Not saved: Amount must be a positive number/);
  h.field("Amount for Synthetic Beta").props.onChange({ target: { value: "3" } });
  await h.flush();
  assert.doesNotMatch(h.rows().find((r) => /Synthetic Beta/.test(r)), /Not saved/, "editing the dose clears the old refusal");
  await h.click("Log selected (1)");
  await h.flush();
  assert.equal(h.calls.writes.length, 2);
  assert.deepEqual(h.calls.writes[1].body, { product_id: "p-beta", product: "Synthetic Beta", amount: 3, unit: "serving", times: [], date: null });
});

test("section: an empty time is refused for the whole batch before anything is sent", async (t) => {
  const h = mountSection(t, { post: ({ body, n }) => okFor(body, n) });
  await h.flush();
  await h.tap("Synthetic Alpha", "Synthetic Beta");
  await h.click("Time");
  await h.flush();
  h.field("Time 1").props.onChange({ target: { value: "" } });
  await h.flush();
  await h.click("Log selected (2)");
  await h.flush();
  assert.equal(h.calls.writes.length, 0);
  assert.match(h.text(), /Fill in or remove the empty time/);
  h.field("Time 1").props.onChange({ target: { value: "08:30" } });
  await h.flush();
  await h.click("Log selected (2)");
  await h.flush();
  assert.equal(h.calls.writes.length, 2);
  assert.ok(h.calls.writes.every((w) => JSON.stringify(w.body.times) === JSON.stringify(["08:30"])), "the times are shared by every product");
});

test("section: Undo removes only that product's rows (the existing DELETE) and the product is waiting to be logged again", async (t) => {
  let counter = 0;
  const h = mountSection(t, {
    post: ({ method, body }) => (method === "DELETE" ? response({ ok: true }) : okFor(body, ++counter)),
  });
  await h.flush();
  await h.tap("Synthetic Alpha", "Synthetic Beta");
  await h.click("Log selected (2)");
  await h.flush();
  await h.click("Undo Synthetic Alpha");
  await h.flush();
  const deletes = h.calls.writes.filter((w) => w.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.match(deletes[0].url, /^\/api\/supplements\/log-intake\?intake_id=10[12]$/);
  assert.equal(h.buttons("Undo Synthetic Beta").length, 1, "the other product is untouched");
  assert.equal(h.rows().filter((r) => /Saved/.test(r)).length, 1);
  assert.equal(h.buttons("Log selected (1)").length, 1, "the undone product can be logged again");
});

test("section: filtering the options never clears the selection; selected products not matching stay listed with their amounts", async (t) => {
  const words = ["Amber", "Birch", "Cedar", "Dune", "Ember", "Fjord", "Grove", "Harbor", "Iris", "Juniper", "Kelp", "Lumen", "Moss", "Nectar"];
  const many = words.map((w, i) => prod(`p-${i}`, `Synthetic ${w}`));
  let counter = 0;
  const h = mountSection(t, { products: many, post: ({ body }) => okFor({ ...body, product_id: body.product_id }, ++counter) });
  await h.flush();
  await h.tap("Synthetic Amber", "Synthetic Birch");
  h.field("Amount for Synthetic Birch").props.onChange({ target: { value: "4" } });
  await h.flush();
  h.field("Filter your supplements").props.onChange({ target: { value: "cedar" } });
  await h.flush();
  assert.deepEqual(h.options().map((n) => h.text(n)), ["Synthetic Cedar"], "the filter narrows the options");
  assert.equal(h.rows().length, 2, "the two picks stay listed although the filter hides their options");
  assert.equal(h.field("Amount for Synthetic Birch").props.value, "4", "with the amount typed");
  await h.tap("Synthetic Cedar");
  assert.equal(h.rows().length, 3);
  h.field("Filter your supplements").props.onChange({ target: { value: "quartz" } });
  await h.flush();
  assert.equal(h.options().length, 0);
  assert.match(h.text(), /No match in your supplements/);
  assert.equal(h.rows().length, 3, "no match: still all three");
  assert.equal(h.buttons("Log selected (3)").length, 1, "and still loggable");
  h.field("Filter your supplements").props.onChange({ target: { value: "" } });
  await h.flush();
  assert.deepEqual(h.checked().sort(), ["Synthetic Amber", "Synthetic Birch", "Synthetic Cedar"], "clearing the filter shows them checked again");
  // Logging with the filter hiding them sends them all.
  h.field("Filter your supplements").props.onChange({ target: { value: "quartz" } });
  await h.flush();
  await h.click("Log selected (3)");
  await h.flush();
  assert.deepEqual(h.calls.writes.map((w) => w.body.product_id).sort(), ["p-0", "p-1", "p-2"]);
  assert.equal(h.calls.writes.find((w) => w.body.product_id === "p-1").body.amount, 4);
});

test("section: a selected option below the cap stays on screen (so it can be unticked); Clear empties selection and filter", async (t) => {
  const words = ["Amber", "Birch", "Cedar", "Dune", "Ember", "Fjord", "Grove", "Harbor", "Iris", "Juniper", "Kelp", "Lumen", "Moss", "Nectar"];
  const many = words.map((w, i) => prod(`p-${i}`, `Synthetic ${w}`));
  const h = mountSection(t, { products: many });
  await h.flush();
  assert.equal(h.options().length, 12);
  await h.click("Show all (14)");
  await h.flush();
  await h.tap("Synthetic Nectar");
  await h.click("Show fewer");
  await h.flush();
  assert.equal(h.options().length, 13, "the capped list plus the selected option below it");
  assert.ok(h.checked().includes("Synthetic Nectar"));
  await h.click("Clear");
  await h.flush();
  assert.equal(h.selectedList(), undefined);
  assert.equal(h.options().length, 12);
  assert.equal(h.calls.writes.length, 0);
});

test("section: a Say it product moved in with Edit is selected with its amount, unit and time; another tap adds a second product with its own dose", async (t) => {
  const draft = { section: "supplements", id: 41, at: Date.now(), said: "synthetic", value: [{ kind: "product", product_id: "p-beta", name: "Synthetic Beta", amount: 15, unit: "mg", times: ["08:30"], date: null }] };
  const h = mountSection(t, {
    draft,
    post: ({ body, n }) => (n === 1 ? response({ ok: false, error: "Synthetic refusal" }, 400) : okFor(body, n)),
  });
  await h.flush();
  // The suggestion is logged on its own after 0.8 s; the refusal leaves it listed with Edit.
  await new Promise((resolve) => setTimeout(resolve, 900));
  await h.flush();
  assert.equal(h.calls.writes.length, 1, "the suggestion's own autosave");
  assert.match(h.text(), /Synthetic refusal/);
  await h.click("Edit");
  await h.flush();
  assert.deepEqual(h.checked(), ["Synthetic Beta"], "Edit selects the suggested product");
  assert.equal(h.field("Amount for Synthetic Beta").props.value, "15");
  assert.equal(h.field("Unit for Synthetic Beta").props.value, "mg");
  assert.equal(h.field("Time 1").props.value, "08:30");

  await h.tap("Synthetic Gamma");
  assert.deepEqual(h.checked().sort(), ["Synthetic Beta", "Synthetic Gamma"]);
  assert.equal(h.field("Amount for Synthetic Beta").props.value, "15", "15 mg stays 15 mg");
  assert.equal(h.field("Unit for Synthetic Beta").props.value, "mg");
  assert.equal(h.field("Amount for Synthetic Gamma").props.value, "", "the new product starts at one serving");
  assert.equal(h.calls.writes.length, 1, "the tap writes nothing");
  await h.click("Log selected (2)");
  await h.flush();
  assert.equal(h.calls.writes.length, 3);
  const by = Object.fromEntries(h.calls.writes.slice(1).map((w) => [w.body.product_id, w.body]));
  assert.deepEqual(by["p-beta"], { product_id: "p-beta", product: "Synthetic Beta", amount: 15, unit: "mg", times: ["08:30"], date: null });
  assert.deepEqual(by["p-gamma"], { product_id: "p-gamma", product: "Synthetic Gamma", amount: null, unit: null, times: ["08:30"], date: null });
});

test("section: the picker and its selection do not wait for the stacks or today reads (PR #478 stays true)", async (t) => {
  const held = deferred();
  const pending = () => held.promise;
  const h = mountSection(t, { post: ({ body, n }) => okFor(body, n), answers: { [URL.today]: pending, [URL.stacks]: pending } });
  await h.flush();
  assert.equal(h.options().length, 5, "the options show while stacks and today are still out");
  await h.tap("Synthetic Alpha", "Synthetic Beta");
  await h.click("Log selected (2)");
  await h.flush();
  assert.equal(h.calls.writes.length, 2);
  assert.equal(h.rows().filter((r) => /Saved/.test(r)).length, 2);
});

test("source: checkboxes with 44 px targets and visible focus; a tap writes nothing; the primary button is explicit on purpose; one existing route", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "app/log/sections/Supplements.tsx"), "utf8");
  assert.match(src, /const pill =\s*"[^"]*min-h-11[^"]*min-w-11|const pill =\s*"[^"]*min-w-11[^"]*min-h-11/);
  assert.match(src, /const pill =\s*"[^"]*focus-visible:outline-accent/);
  assert.match(src, /role="group" aria-label="Your supplements" className="flex flex-wrap gap-2"/);
  assert.match(src, /role="checkbox"\s+aria-checked=\{on\}/);
  assert.doesNotMatch(src, /role="radio/);
  const tap = src.slice(src.indexOf("function onToggleOption("), src.indexOf("/** Empty the selection"));
  assert.ok(tap.length > 0 && !/fetch\(|postJson|sendProduct\(|logProduct\(/.test(tap), "a tap on an option writes nothing");
  assert.match(src, /An explicit button on purpose \(AGENTS\.md "Input saves itself" exception\)/);
  // The only route the multi-select writes to is the existing log-product route; Undo is the existing DELETE.
  assert.equal((src.match(/postJson\("\/api\/supplements\/[a-z\/-]+"/g) ?? []).length, 3, "log-product, stacks/log and reminders/respond: no new write route");
  assert.match(src, /postJson\("\/api\/supplements\/log-product"/);
  assert.doesNotMatch(src, /log-selected|log-products|log-batch/);
  assert.match(src, /api\/supplements\/log-intake\?intake_id=/);
  // What may be sent is decided by the pure module, never re-derived on screen.
  assert.match(src, /sendable\(selection, \{ only, includeUnconfirmed: !!only \}\)/);
  // Opening and scrolling still write nothing: the writes are in handlers (and the Say it autosave), not in the mount effects.
  const route = fs.readFileSync(path.join(__dirname, "..", "src", "app/api/supplements/log-product/route.ts"), "utf8");
  assert.match(route, /export async function POST/);
  assert.doesNotMatch(route, /event_key/, "the route is unchanged by the multi-select");
});
