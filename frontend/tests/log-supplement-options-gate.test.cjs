// Run: node --test tests/log-supplement-options-gate.test.cjs
// /log Supplements, "Log a product" gate (or-355): the product options show as soon as the products are known,
// whether or not the stacks and today reads have answered. Before the fix the section returned a SectionSkeleton
// (or a whole-card "Couldn't load supplements.") while both were pending/failed, hiding the picker even when the
// products were already cached. Now the stacks and logged-today areas each hold their own loading / error / Retry
// state, and a stale or failed stacks/today read never hides the options.
// SYNTHETIC DATA ONLY: invented product names, ids and dates; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");
const { mountClient, response, deferred, withGlobals } = require("./helpers/hook-harness.cjs");

const TODAY = loadTs("lib/checkin.ts").fallbackBehavioralToday(new Date());

const prod = (id, full_name, brand_name = "Synthetic Labs") => ({ product_id: id, brand_name, full_name, serving_size: 1, serving_unit: "capsule" });
const URL = {
  products: "/api/supplements/products",
  today: "/api/supplements/today",
  stacks: "/api/supplements/stacks",
  history: "/api/supplements/history?days=30&perPage=200",
};
const FIVE = [
  prod("p-alpha", "Synthetic Alpha"),
  prod("p-beta", "Synthetic Beta"),
  prod("p-gamma", "Synthetic Gamma"),
  prod("p-delta", "Synthetic Delta"),
  prod("p-eps", "Synthetic Epsilon"),
];
const STACK = { stack_id: 3, name: "Synthetic Night", remind_time: null, item_count: 2 };
const TODAY_RESP = { date: TODAY, intakes: [], reminders: [] };

/** Same fake cache + fetch mount as tests/log-supplement-options.test.cjs, tailored to the gate scenarios. */
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

function mountSection(t, { cache = new Map(), answers = {}, post } = {}) {
  const calls = { writes: [], gets: [] };
  const defaults = {
    [URL.products]: () => response({ products: FIVE }),
    [URL.today]: () => response(TODAY_RESP),
    [URL.stacks]: () => response({ stacks: [STACK] }),
    [URL.history]: () => response({ rows: [] }),
  };
  const fail = () => { throw new Error("synthetic network failure"); };
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
  h = mountClient("app/log/sections/Supplements.tsx", {
    stubs: {
      "@/components/FeedContext": { useInFeed: () => false },
      "lucide-react": { Check: () => null, Plus: () => null, X: () => null },
      "@/lib/client-cache": fakeCache(cache),
      "@/lib/log-early": {
        LOG_SUPPLEMENTS_TODAY_URL: URL.today,
        LOG_SUPPLEMENTS_STACKS_URL: URL.stacks,
        LOG_SUPPLEMENTS_PRODUCTS_URL: URL.products,
        LOG_SUPPLEMENTS_HISTORY_URL: URL.history,
        logEarlyGet: () => undefined,
      },
      "@/lib/log-drafts": { useLogDrafts: () => ({ current: { draft: null, clear: () => {} } }) },
    },
  });
  const options = () => h.find((n) => n.type === "button" && n.props.role === "radio");
  const optionNames = () => options().map((n) => h.text(n));
  const field = (label) => h.find((n) => (n.type === "input" || n.type === "select") && n.props["aria-label"] === label)[0];
  return { ...h, calls, options, optionNames, field, fail };
}

test("gate: with the products cached and both the today and stacks GETs stalled, the options show without waiting", async (t) => {
  const held = deferred();
  const cache = new Map([[URL.products, { products: FIVE }]]);
  const pending = () => held.promise;
  const h = mountSection(t, {
    cache,
    answers: { [URL.products]: pending, [URL.today]: pending, [URL.stacks]: pending, [URL.history]: pending },
  });
  await h.flush();
  assert.deepEqual(h.optionNames(), ["Synthetic Alpha", "Synthetic Beta", "Synthetic Gamma", "Synthetic Delta", "Synthetic Epsilon"],
    "the product options paint from the cached products while the other reads are still out");
  assert.doesNotMatch(h.text(), /Couldn&apos;t load supplements\.|Couldn't load supplements\.|Couldn&apos;t load stacks\.|Couldn&apos;t load today&apos;s intakes\./);
  assert.equal(h.calls.writes.length, 0, "opening the section writes nothing");
  held.resolve(response({ stacks: [STACK] }));
  await h.flush();
  assert.deepEqual(h.optionNames(), ["Synthetic Alpha", "Synthetic Beta", "Synthetic Gamma", "Synthetic Delta", "Synthetic Epsilon"],
    "a late stacks answer does not disturb the options");
});

test("gate: with both the today and stacks GETs failing, the options stay usable and each area shows only its own error", async (t) => {
  const h = mountSection(t, {
    answers: {
      [URL.products]: () => response({ products: FIVE }),
      [URL.today]: () => h.fail(),
      [URL.stacks]: () => h.fail(),
      [URL.history]: () => response({ rows: [] }),
    },
  });
  await h.flush();
  assert.deepEqual(h.optionNames(), ["Synthetic Alpha", "Synthetic Beta", "Synthetic Gamma", "Synthetic Delta", "Synthetic Epsilon"],
    "a failed stacks/today read never hides the picker");
  assert.doesNotMatch(h.text(), /Couldn&apos;t load supplements\.|Couldn't load supplements\./, "no whole-card failure");
  assert.match(h.text(), /Couldn&apos;t load stacks\./);
  assert.match(h.text(), /Couldn&apos;t load today&apos;s intakes\./);
  // The picker still works end to end (a tap fills the form and writes nothing; Log is the only write).
  const gamma = h.options().find((n) => h.text(n) === "Synthetic Gamma");
  assert.ok(gamma);
  gamma.props.onClick();
  await h.flush();
  assert.equal(h.options().find((n) => h.text(n) === "Synthetic Gamma").props["aria-checked"], true, "the picker accepts a tap");
  assert.equal(h.field("Amount").props.value, "", "the form opens on a successful pick");
  assert.equal(h.calls.writes.length, 0, "a tap still writes nothing");
});

test("gate: the stacks and today Retry buttons still reload their area after a failure", async (t) => {
  // Round 1: stacks fails. Its Retry (the only one on screen) refetches everything and the row appears.
  let stacksDown = true;
  let todayDown = true;
  const h = mountSection(t, {
    answers: {
      [URL.products]: () => response({ products: FIVE }),
      [URL.today]: () => (todayDown ? h.fail() : response(TODAY_RESP)),
      [URL.stacks]: () => (stacksDown ? h.fail() : response({ stacks: [STACK] })),
      [URL.history]: () => response({ rows: [] }),
    },
  });
  await h.flush();
  assert.match(h.text(), /Couldn&apos;t load stacks\./);
  stacksDown = false;
  todayDown = false;
  // The stacks area comes before "Log a product" / "Logged today", so its Retry is the first.
  h.click("Retry", 0);
  await h.flush();
  assert.doesNotMatch(h.text(), /Couldn&apos;t load stacks\./);
  assert.match(h.text(), /Synthetic Night/, "the stack row appears after Retry");
  assert.ok(h.buttons("Log it").some((b) => !b.props.disabled), "the stack's Log it is usable");

  // Round 2: today only fails; its Retry (again the only one on screen) brings today's rows back.
  todayDown = true;
  const h2 = mountSection(t, {
    answers: {
      [URL.products]: () => response({ products: FIVE }),
      [URL.today]: () => (todayDown ? h2.fail() : response({ ...TODAY_RESP, intakes: [{ intake_id: 7, intake_date: TODAY, intake_time: null, product_id: "p-eps", doses: 1, notes: null, stack_id: null, brand_name: null, full_name: "Synthetic Epsilon" }] })),
      [URL.stacks]: () => response({ stacks: [STACK] }),
      [URL.history]: () => response({ rows: [] }),
    },
  });
  await h2.flush();
  assert.match(h2.text(), /Couldn&apos;t load today&apos;s intakes\./);
  todayDown = false;
  h2.click("Retry", 0);
  await h2.flush();
  assert.doesNotMatch(h2.text(), /Couldn&apos;t load today&apos;s intakes\./);
  assert.match(h2.text(), /Synthetic Epsilon/, "today's intake row appears after Retry");
  assert.equal(h2.calls.writes.length, 0, "Retry only re-reads; nothing is written");
});
