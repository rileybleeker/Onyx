// Run: node --test tests/log-suggestion-key-remount.test.cjs
// /log Supplements, Say it product suggestions (SUPP-SUGGESTION-KEY-2): each suggestion's write keeps its event key and
// its payload in module memory, so a save whose answer was lost, then an unmount and a remount (leaving /log and coming
// back), then Retry, resends the SAME event_key with the same product / amount / unit / times / date. Two drafts with
// the same item position never share a key (the PR #765 regression). A confirmed write or a definite refusal (4xx)
// drops the attempt, so a later Retry of a refused item uses a new key.
// SYNTHETIC DATA ONLY: invented product names, ids and dates; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");
const { mountClient, response, withGlobals } = require("./helpers/hook-harness.cjs");

const TODAY = loadTs("lib/checkin.ts").fallbackBehavioralToday(new Date());
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const URL = {
  products: "/api/supplements/products",
  today: "/api/supplements/today",
  stacks: "/api/supplements/stacks",
  history: "/api/supplements/history?days=30&perPage=200",
};
const PRODUCTS = [{ product_id: "p-beta", brand_name: "Synthetic Labs", full_name: "Synthetic Beta", serving_size: 1, serving_unit: "capsule" }];
const READS = {
  [URL.products]: () => response({ products: PRODUCTS }),
  [URL.today]: () => response({ date: TODAY, intakes: [], reminders: [] }),
  [URL.stacks]: () => response({ stacks: [] }),
  [URL.history]: () => response({ rows: [] }),
};

function fakeCache() {
  const store = new Map();
  const GONE = Symbol("gone");
  const clientCache = {
    peek: (k) => store.get(k),
    read: (k) => Promise.resolve(store.get(k)),
    put: (k, v) => { store.set(k, v); return true; },
    register: () => {},
  };
  const fetchJsonValue = async (url, get) => {
    const r = await (get ? get() : fetch(url, { cache: "no-store" }));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  async function cachedJson(url, { check, get } = {}) {
    const v = await fetchJsonValue(url, get);
    check?.(v);
    clientCache.put(url, v);
    return v;
  }
  return { clientCache, cachedJson, fetchJsonValue, GONE };
}

/** A confirmed answer of the route for the body's product: one dose row. */
const okFor = ({ body, n }) => response({ ok: true, product: body.product, product_id: body.product_id, logged: [{ intake_id: 100 + n, time: "8:30 AM" }], doses_each: body.amount ?? 1, intake_date: TODAY });
const refusal = () => response({ ok: false, error: "Synthetic refusal" }, 400);

/**
 * One environment per test, shared by every mount in it: the module cache (so the section's module memory survives a
 * remount, as the module does in the app), the drafts store, and the write answers. The section's React hooks are
 * delegated to the mount that is live, so a remounted section reads its own state (a mount that is gone is unreachable).
 */
function makeEnv(t) {
  const env = { cache: new Map(), hooks: null, draft: null, writes: [], post: okFor };
  const reactHooks = {};
  for (const name of ["useState", "useRef", "useMemo", "useCallback", "useEffect", "useId", "createContext", "useContext"]) {
    reactHooks[name] = (...args) => env.hooks[name](...args);
  }
  env.stubs = {
    react: reactHooks,
    "@/components/FeedContext": { useInFeed: () => false },
    "lucide-react": { Check: () => null, Plus: () => null, X: () => null },
    "@/lib/client-cache": fakeCache(),
    "@/lib/log-early": {
      LOG_SUPPLEMENTS_TODAY_URL: URL.today,
      LOG_SUPPLEMENTS_STACKS_URL: URL.stacks,
      LOG_SUPPLEMENTS_PRODUCTS_URL: URL.products,
      LOG_SUPPLEMENTS_HISTORY_URL: URL.history,
      logEarlyGet: () => undefined,
    },
    "@/lib/log-drafts": {
      useLogDrafts: () => ({ draft: env.draft, clear: (id) => { if (env.draft && (id == null || env.draft.id === id)) env.draft = null; } }),
    },
  };
  withGlobals(t, {
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    fetch: async (url, init = {}) => {
      const method = init.method ?? "GET";
      if (method !== "GET") {
        const body = init.body ? JSON.parse(init.body) : null;
        env.writes.push(body);
        return env.post({ body, n: env.writes.length });
      }
      const read = READS[url];
      if (!read) throw new Error(`unexpected request ${method} ${url}`);
      return read();
    },
  });
  return env;
}

/** Mount the section (a fresh instance on the same module); the caller unmounts it, as leaving /log does. */
function mount(env) {
  return mountClient((load, hooks) => {
    env.hooks = hooks;
    return load("app/log/sections/Supplements.tsx").default;
  }, { stubs: env.stubs, cache: env.cache });
}

/** Mount, let the autosave run (0.8 s after the suggestion shows, once the stacks are in), and settle. */
async function mountAndAutosave(env) {
  const h = mount(env);
  await h.flush();
  await new Promise((resolve) => setTimeout(resolve, 900));
  await h.flush();
  return h;
}

const draftOf = (id, item = {}) => ({
  section: "supplements",
  id,
  at: Date.now(),
  said: "synthetic",
  value: [{ kind: "product", product_id: "p-beta", name: "Synthetic Beta", amount: 15, unit: "mg", times: ["08:30"], date: null, ...item }],
});

test("(a) two consecutive one-product drafts get different event keys (the PR #765 regression)", async (t) => {
  const env = makeEnv(t);
  env.draft = draftOf(51);
  const first = await mountAndAutosave(env);
  assert.equal(env.writes.length, 1, "the first draft's own autosave");
  first.unmount();

  env.draft = draftOf(52);
  const second = await mountAndAutosave(env);
  assert.equal(env.writes.length, 2, "the second draft's own autosave");
  second.unmount();

  const [a, b] = env.writes;
  assert.match(a.event_key, UUID_RE);
  assert.match(b.event_key, UUID_RE);
  assert.notEqual(a.event_key, b.event_key, "item 0 of draft 51 and item 0 of draft 52 never share a key");
});

test("(b) a lost answer, an unmount, a remount, then Retry: the same event_key and the same payload are sent again", async (t) => {
  const env = makeEnv(t);
  env.draft = draftOf(61);
  env.post = () => Promise.reject(new Error("synthetic network failure: the answer was lost"));
  const first = await mountAndAutosave(env);
  assert.equal(env.writes.length, 1);
  assert.match(first.text(), /Not confirmed/, "the lost answer is not shown as saved or refused");
  first.unmount();

  env.post = okFor;
  const second = mount(env);
  await second.flush();
  assert.equal(env.writes.length, 1, "the remount does not send anything by itself");
  second.click("Retry");
  await second.flush();

  assert.equal(env.writes.length, 2, "Retry sends the item once more");
  const [lost, retry] = env.writes;
  assert.match(lost.event_key, UUID_RE);
  assert.equal(retry.event_key, lost.event_key, "the same event key: the route replays the lost write instead of writing it twice");
  assert.deepEqual(
    { ...retry, event_key: undefined },
    { ...lost, event_key: undefined },
    "the same product, amount, unit, times and date",
  );
  assert.deepEqual(retry, { product_id: "p-beta", product: "Synthetic Beta", amount: 15, unit: "mg", times: ["08:30"], date: null, event_key: lost.event_key });
  assert.match(second.text(), /Saved Synthetic Beta/, "the confirmed retry shows the saved row");
  second.unmount();
});

test("(c) a confirmed write drops its attempt: the item leaves the draft for good, and a new item gets a new key", async (t) => {
  const env = makeEnv(t);
  env.draft = draftOf(71);
  const first = await mountAndAutosave(env);
  assert.equal(env.writes.length, 1);
  assert.match(first.text(), /Saved Synthetic Beta/);
  first.unmount();

  // The same draft again (a remount): the logged item is not offered, so nothing is sent and no key is reused.
  const again = await mountAndAutosave(env);
  assert.equal(env.writes.length, 1, "a logged item is never sent again");
  assert.equal(again.buttons("Retry").length, 0, "no suggestion is listed");
  again.unmount();

  // A new draft with the same item is a new item: it gets its own key.
  env.draft = draftOf(72);
  const next = await mountAndAutosave(env);
  assert.equal(env.writes.length, 2);
  assert.notEqual(env.writes[1].event_key, env.writes[0].event_key, "a new item is a new log, with a new key");
  next.unmount();
});

test("(d) a definite refusal (4xx) drops the attempt: Retry after it sends a new key", async (t) => {
  const env = makeEnv(t);
  env.draft = draftOf(81);
  env.post = refusal;
  const first = await mountAndAutosave(env);
  assert.equal(env.writes.length, 1);
  assert.match(first.text(), /Synthetic refusal/, "the refusal is shown on the item");
  first.unmount();

  env.post = okFor;
  const second = mount(env);
  await second.flush();
  second.click("Retry");
  await second.flush();
  assert.equal(env.writes.length, 2);
  const [refused, retry] = env.writes;
  assert.match(retry.event_key, UUID_RE);
  assert.notEqual(retry.event_key, refused.event_key, "a refused write is known not to exist, so the retry is a new log with a new key");
  assert.equal(retry.product_id, refused.product_id);
  assert.equal(retry.amount, refused.amount);
  assert.equal(retry.unit, refused.unit);
  assert.deepEqual(retry.times, refused.times);
  assert.equal(retry.date, refused.date);
  second.unmount();
});

test("source: the attempt store is module scope, created before the send, and dropped only on a settled outcome", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "app", "log", "sections", "Supplements.tsx"), "utf8");
  assert.match(src, /^const suggestionAttempts = new Map</m, "the attempt store lives at module scope, so a remount keeps it");
  assert.doesNotMatch(src, /suggestionKeys/, "the per-mount ref it replaces is gone");
  assert.match(src, /if \(outcome\.settled\) suggestionAttempts\.delete\(keyId\);/, "dropped only when the write is confirmed or refused");
  const deletes = src.match(/suggestionAttempts\.delete\(/g) ?? [];
  assert.equal(deletes.length, 1, "exactly one place drops an attempt");
});
