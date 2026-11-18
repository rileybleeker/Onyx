// Run: node --test tests/log-supplement-suggestion-event-key.test.cjs
// /log Supplements, Say it suggestions: the event_key sent with a suggested product is per draft AND per item.
// (a) two separate drafts, each with one product at index 0, send DIFFERENT event_keys (the old map was keyed by the
//     item position alone, so draft 2's item 0 reused draft 1's key and the server could replay the wrong intake);
// (b) an item that failed and is retried with "Retry" in the same draft sends the SAME event_key both times.
// SYNTHETIC DATA ONLY: invented product ids, names and dates; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");
const { mountClient, response, withGlobals } = require("./helpers/hook-harness.cjs");

const TODAY = loadTs("lib/checkin.ts").fallbackBehavioralToday(new Date());

const URL_ = {
  products: "/api/supplements/products",
  today: "/api/supplements/today",
  stacks: "/api/supplements/stacks",
  history: "/api/supplements/history?days=30&perPage=200",
};
const STACK = { stack_id: 3, name: "Synthetic Night", remind_time: null, item_count: 2 };
const prod = (id, full_name) => ({ product_id: id, brand_name: "Synthetic Labs", full_name, serving_size: 1, serving_unit: "capsule" });
const PRODUCTS = [prod("p-alpha", "Synthetic Alpha"), prod("p-beta", "Synthetic Beta"), prod("p-gamma", "Synthetic Gamma")];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fakeCache() {
  const store = new Map();
  const GONE = Symbol("gone");
  const clientCache = {
    peek: (k) => store.get(k),
    read: (k) => Promise.resolve(store.get(k)),
    put: (k, v) => { store.set(k, v); return true; },
    register: () => {},
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

// One mounted section whose Say it draft can be swapped between two renders (drafts.current), as the app does.
function mountWithDrafts(t, { post }) {
  const calls = { writes: [] };
  const defaults = {
    [URL_.products]: () => response({ products: PRODUCTS }),
    [URL_.today]: () => response({ date: TODAY, intakes: [], reminders: [] }),
    [URL_.stacks]: () => response({ stacks: [STACK] }),
    [URL_.history]: () => response({ rows: [] }),
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
        return post({ url, method, body, n: calls.writes.length });
      }
      const a = defaults[url];
      if (!a) throw new Error(`unexpected request ${method} ${url}`);
      return a();
    },
  });
  const drafts = { current: null };
  const clear = (id) => { if (drafts.current.draft && (id == null || drafts.current.draft.id === id)) drafts.current = { draft: null, clear }; };
  const setDraft = (draft) => { drafts.current = { draft, clear }; };
  setDraft(null);
  h = mountClient("app/log/sections/Supplements.tsx", {
    stubs: {
      "@/components/FeedContext": { useInFeed: () => false },
      "lucide-react": { Check: () => null, Plus: () => null, X: () => null },
      "@/lib/client-cache": fakeCache(),
      "@/lib/log-early": {
        LOG_SUPPLEMENTS_TODAY_URL: URL_.today,
        LOG_SUPPLEMENTS_STACKS_URL: URL_.stacks,
        LOG_SUPPLEMENTS_PRODUCTS_URL: URL_.products,
        LOG_SUPPLEMENTS_HISTORY_URL: URL_.history,
        logEarlyGet: () => undefined,
      },
      "@/lib/log-drafts": { useLogDrafts: () => drafts.current },
    },
  });
  return { h, calls, setDraft, rerender: async () => { h.rerender?.(); await h.flush(); } };
}

// A Say it draft with one product at index 0 (the position the old key used).
const oneProductDraft = (id, productId, name) => ({
  section: "supplements",
  id,
  at: Date.now(),
  said: "synthetic",
  value: [{ kind: "product", product_id: productId, name, amount: 1, unit: "capsule", times: ["08:30"], date: null }],
});

const okFor = (body, n) => response({ ok: true, product: body.product, product_id: body.product_id, logged: [{ intake_id: 200 + n, time: "8:30 AM" }], doses_each: body.amount ?? 1, intake_date: TODAY });

test("two separate Say it drafts, each with one product at index 0, send different event_keys", async (t) => {
  const { h, calls, setDraft, rerender } = mountWithDrafts(t, { post: ({ body, n }) => okFor(body, n) });
  await h.flush();

  // Draft 1: autosaved 0.8 s after it shows; the success clears the draft.
  setDraft(oneProductDraft(501, "p-alpha", "Synthetic Alpha"));
  await rerender();
  await new Promise((resolve) => setTimeout(resolve, 900));
  await h.flush();
  assert.equal(calls.writes.length, 1, "draft 1 is sent once");

  // Draft 2: a different product, also at index 0.
  setDraft(oneProductDraft(502, "p-beta", "Synthetic Beta"));
  await rerender();
  await new Promise((resolve) => setTimeout(resolve, 900));
  await h.flush();
  assert.equal(calls.writes.length, 2, "draft 2 is sent once");

  const [first, second] = calls.writes.map((w) => w.body);
  assert.equal(first.product_id, "p-alpha");
  assert.equal(second.product_id, "p-beta");
  assert.match(first.event_key, UUID_RE);
  assert.match(second.event_key, UUID_RE);
  assert.notEqual(second.event_key, first.event_key, "a new draft's item never reuses another draft's key");
});

// Since #773 a definite refusal (4xx) settles the attempt: nothing was written, so Retry sends a fresh key. A lost answer
// keeps the key across Retry and a remount: tests/log-suggestion-key-remount.test.cjs (b) and (d).
test("a refused Say it item retried with Retry in the same draft is sent again, with a fresh event_key", async (t) => {
  const { h, calls, setDraft, rerender } = mountWithDrafts(t, {
    post: ({ body, n }) => (n === 1 ? response({ ok: false, error: "Synthetic refusal" }, 400) : okFor(body, n)),
  });
  await h.flush();

  setDraft(oneProductDraft(503, "p-gamma", "Synthetic Gamma"));
  await rerender();
  await new Promise((resolve) => setTimeout(resolve, 900));
  await h.flush();
  assert.equal(calls.writes.length, 1, "the autosave sends once and is refused");
  assert.match(h.text(), /Synthetic refusal/);

  await h.click("Retry");
  await h.flush();
  assert.equal(calls.writes.length, 2, "Retry sends the same item again");
  assert.equal(calls.writes[1].body.product_id, "p-gamma");
  assert.match(calls.writes[0].body.event_key, UUID_RE);
  assert.match(calls.writes[1].body.event_key, UUID_RE);
  assert.notEqual(calls.writes[1].body.event_key, calls.writes[0].body.event_key, "a refusal drops the attempt (#773)");
});

test("source: the Say it event key map is namespaced by draft and item, and an item's entry is dropped once confirmed", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "app", "log", "sections", "Supplements.tsx"), "utf8");
  // Module scope since #773 (a remount keeps it); dropped on a settled outcome (confirmed or refused), not on done.push.
  assert.match(src, /^const suggestionAttempts = new Map<string, \{ eventKey: string; payload: SuggestionPayload \}>\(\);/m);
  assert.match(src, /const keyId = `\$\{draftId\}:\$\{s\.key\}`;/);
  assert.match(src, /suggestionAttempts\.get\(keyId\)/);
  assert.match(src, /suggestionAttempts\.set\(keyId, attempt\)/);
  assert.match(src, /if \(outcome\.settled\) suggestionAttempts\.delete\(keyId\);/);
});
