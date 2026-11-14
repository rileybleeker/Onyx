// Execute the real CheckInClient and its event callbacks with a tiny hook scheduler.
// Synthetic data only: no DOM/browser, credentials, requests, database or delivery writes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const DAY = "Synthetic daytime question?";
const SLEEP = "Synthetic sleep question?";
const dayKey = (date) => `onyx:checkin:${date}`;
const nightKey = (date) => `onyx:checkin:night:${date}`;
const addDay = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const question = (name, sleep) => ({ name, sleep, group: "core", category: "health", channel: "habit", frequency: "daily", notionPageId: name });
const page = (today = "2031-03-05", date = today) => ({
  today, date, items: [question(DAY, false), question(SLEEP, true)], answers: {}, suggestions: {},
  nights: [-1, -2].map((n) => ({ date: addDay(today, n), answers: {}, suggestions: {}, usualKit: {} })),
  days: [0, -1, -2].map((n) => ({ date: addDay(today, n), answered: 0, total: 1 })),
});
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
function storage(initial = {}, unavailable = false) {
  const values = new Map(Object.entries(initial));
  const check = () => { if (unavailable) throw new Error("Synthetic unavailable storage"); };
  return {
    values,
    get length() { check(); return values.size; },
    key: (i) => { check(); return [...values.keys()][i] ?? null; },
    getItem: (key) => { check(); return values.get(key) ?? null; },
    setItem: (key, value) => { check(); values.set(key, value); },
    removeItem: (key) => { check(); values.delete(key); },
  };
}

async function mount(t, { initial = page(), draftStorage = storage(), onPost, onGet } = {}) {
  let current = initial;
  let requested = null;
  let dirty = true;
  let frame;
  let effects = [];
  let tree;
  const frames = new Map();
  const posts = [];
  const done = [];
  const windowEvents = new Map();
  const equal = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const slot = () => [frame.slots, frame.index++];
  const hooks = {
    useState(initialValue) {
      const [slots, i] = slot();
      if (!(i in slots)) slots[i] = typeof initialValue === "function" ? initialValue() : initialValue;
      return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; dirty = true; }];
    },
    useRef(value) { const [slots, i] = slot(); return slots[i] ??= { current: value }; },
    useMemo(create, deps) {
      const [slots, i] = slot();
      if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { deps, value: create() };
      return slots[i].value;
    },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const [slots, i] = slot();
      if (!slots[i] || !equal(slots[i].deps, deps)) {
        const old = slots[i];
        slots[i] = { deps };
        effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); });
      }
    },
  };
  const replacements = {
    localStorage: draftStorage,
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    window: { addEventListener: (name, fn) => windowEvents.set(name, fn), removeEventListener: (name) => windowEvents.delete(name) },
    fetch: async (url, options = {}) => {
      assert.match(url, /^\/api\/habits\/checkin(?:\?date=\d{4}-\d{2}-\d{2})?$/);
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        posts.push(body);
        return onPost ? onPost(body, posts.length) : response({ success: true });
      }
      const date = new URL(url, "https://synthetic.invalid").searchParams.get("date");
      return response(onGet ? onGet(date, current) : { ...current, date: date ?? current.date });
    },
  };
  for (const [name, value] of Object.entries(replacements)) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => prior ? Object.defineProperty(globalThis, name, prior) : delete globalThis[name]);
  }
  const Client = loadTs("app/check-in/CheckInClient.tsx", {
    react: hooks,
    "next/navigation": {
      useSearchParams: () => new URLSearchParams(requested ? { date: requested } : {}),
      useRouter: () => ({ replace: (url) => { requested = new URL(url, "https://synthetic.invalid").searchParams.get("date"); dirty = true; } }),
    },
    "lucide-react": Object.fromEntries(["Check", "ChevronDown", "Moon", "Sun", "X"].map((name) => [name, () => null])),
    "@/lib/agents-api": { agentsApi: { checkinDone: async (date) => { done.push(date); } } },
    "@/components/DeliveryPortions": { useDeliveryDishes: () => ({ groups: [], leftovers: [] }), DeliveryDishList: () => null, LeftoverList: () => null },
  }).default;
  function expand(node, id = "root") {
    if (node == null || typeof node === "boolean") return null;
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${id}/${child?.key ?? i}`));
    if (typeof node !== "object") return node;
    if (typeof node.type === "function") {
      const key = `${id}:${node.type.name}`;
      if (!frames.has(key)) frames.set(key, { slots: [], index: 0 });
      frame = frames.get(key);
      frame.index = 0;
      return expand(node.type(node.props), key);
    }
    return { type: node.type, props: { ...node.props, children: expand(node.props.children, id) } };
  }
  async function flush() {
    // Bounded microtask turns also drain the async GET and its state updates; unresolved POSTs stay pending.
    for (let i = 0; i < 12; i++) {
      if (dirty) {
        dirty = false;
        effects = [];
        tree = expand({ type: Client, props: {} });
        for (const effect of effects) effect();
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(dirty, false, "the synthetic hook scheduler settled");
  }
  function nodes(node = tree) {
    if (Array.isArray(node)) return node.flatMap((n) => nodes(n));
    if (!node || typeof node !== "object") return [];
    return [node, ...nodes(node.props.children)];
  }
  const text = (node = tree) => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props.children) : node == null ? "" : String(node);
  function button(label, index = 0) {
    const matches = nodes().filter((n) => n.type === "button" && (n.props["aria-label"] === label || text(n) === label));
    assert.ok(matches[index], `button exists: ${label}`);
    return matches[index];
  }
  const click = (label, index = 0) => {
    const node = button(label, index);
    assert.ok(!node.props.disabled, `button enabled: ${label}`);
    return node.props.onClick();
  };
  await flush();
  return { posts, done, flush, text, button, click, windowEvents, storage: draftStorage,
    setPage: (value) => { current = value; },
    navigate: (date) => { requested = date; dirty = true; },
  };
}

test("client: stale before the first write preserves both original dates and requires review before Save", async (t) => {
  const h = await mount(t, { onPost: async () => response({ stale: true }, 409) });
  h.click(`${DAY}: yes`); await h.flush();
  h.click(`${SLEEP}: yes`); await h.flush();
  h.setPage(page("2031-03-06"));
  await h.click("Save"); await h.flush();
  assert.equal(h.posts.length, 1, "the rejected day stops the night request");
  assert.match(h.text(), /Daytime 2031-03-05/);
  assert.match(h.text(), /Night 2031-03-04 → 2031-03-05 morning/);
  assert.match(h.text(), /Unsaved answers are preserved/);
  assert.equal(h.button("Save").props.disabled, true);
  assert.ok(h.storage.values.has(dayKey("2031-03-05")));
  assert.ok(h.storage.values.has(nightKey("2031-03-04")));
});

test("client: day success then night stale settles only the day; review is local and saves the original night", async (t) => {
  const h = await mount(t, { onPost: async (_body, count) => count === 2 ? response({ stale: true }, 409) : response({ success: true }) });
  h.click(`${DAY}: yes`); await h.flush();
  h.click(`${SLEEP}: yes`); await h.flush();
  h.setPage(page("2031-03-06"));
  await h.click("Save"); await h.flush();
  assert.deepEqual(h.done, ["2031-03-05"]);
  assert.equal(h.storage.values.has(dayKey("2031-03-05")), false);
  assert.equal(h.button("Save").props.disabled, true);
  h.click("Use answers for Night 2031-03-04 → 2031-03-05 morning"); await h.flush();
  assert.equal(h.posts.length, 2, "review never POSTs");
  await h.click("Save"); await h.flush();
  assert.deepEqual(h.posts.map((p) => p.date), ["2031-03-05", "2031-03-04", "2031-03-04"]);
  assert.deepEqual(h.posts[2], { date: "2031-03-04", answers: { [SLEEP]: "Yes" }, today: "2031-03-06" });
});

test("client: a newer tap during a successful save survives reload and can be saved next", async (t) => {
  const pending = deferred();
  const h = await mount(t, { onPost: (_body, count) => count === 1 ? pending.promise : response({ success: true }) });
  h.click(`${DAY}: yes`); await h.flush();
  const saving = h.click("Save"); await h.flush();
  h.click(`${DAY}: no`); await h.flush();
  const savedPage = page(); savedPage.answers[DAY] = "Yes";
  h.setPage(savedPage);
  pending.resolve(response({ success: true }));
  await saving; await h.flush();
  assert.equal(h.button(`${DAY}: no`).props["aria-pressed"], true);
  assert.deepEqual(JSON.parse(h.storage.values.get(dayKey(savedPage.date))), { [DAY]: { a: "No", base: "Yes" } });
  await h.click("Save"); await h.flush();
  assert.deepEqual(h.posts.map((p) => p.answers[DAY]), ["Yes", "No"]);
});

test("client: failed storage retains drafts through stale reload and warns before leaving", async (t) => {
  const h = await mount(t, { draftStorage: storage({}, true), onPost: async () => response({ stale: true }, 409) });
  h.click(`${DAY}: yes`); await h.flush();
  assert.match(h.text(), /Browser storage is unavailable/);
  let warned = false;
  h.windowEvents.get("beforeunload")({ preventDefault: () => { warned = true; } });
  assert.equal(warned, true);
  h.setPage(page("2031-03-06"));
  await h.click("Save"); await h.flush();
  assert.match(h.text(), /Daytime 2031-03-05/);
  assert.match(h.text(), /Synthetic daytime question\?: Yes/);
  assert.equal(h.posts.length, 1);
});

test("client: ordinary night failure retains pending answers without resubmitting the successful day", async (t) => {
  const h = await mount(t, { onPost: async (_body, count) => count === 2 ? response({ error: "Synthetic save failure" }, 500) : response({ success: true }) });
  h.click(`${DAY}: yes`); await h.flush();
  h.click(`${SLEEP}: no`); await h.flush();
  await h.click("Save"); await h.flush();
  assert.match(h.text(), /Synthetic save failure/);
  assert.equal(h.storage.values.has(dayKey("2031-03-05")), false);
  assert.ok(h.storage.values.has(nightKey("2031-03-04")));
  await h.click("Save"); await h.flush();
  assert.deepEqual(h.posts.map((p) => p.date), ["2031-03-05", "2031-03-04", "2031-03-04"]);
  assert.deepEqual(h.done, ["2031-03-05"]);
});

test("client: navigation during a save waits for settlement and never copies answers onto the new day", async (t) => {
  const pending = deferred();
  let saved = false;
  const h = await mount(t, {
    onPost: () => pending.promise,
    onGet: (date) => {
      const result = page("2031-03-05", date ?? "2031-03-05");
      if (saved && result.date === "2031-03-05") result.answers[DAY] = "Yes";
      return result;
    },
  });
  h.click(`${DAY}: yes`); await h.flush();
  const saving = h.click("Save"); await h.flush();
  h.navigate("2031-03-04"); await h.flush();
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], true, "the pending save keeps its original dated form");
  saved = true;
  pending.resolve(response({ success: true }));
  await saving; await h.flush();
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], false, "the newly selected day's answers are independent");
  assert.equal(h.button("Save").props.disabled, true);
  assert.deepEqual(h.posts, [{ date: "2031-03-05", answers: { [DAY]: "Yes" }, today: "2031-03-05" }]);
  assert.equal(h.storage.values.has(dayKey("2031-03-04")), false);
});

test("client: reopening an old draft shows its original date, cannot submit it, and discard requires confirmation", async (t) => {
  const oldKey = dayKey("2030-01-01");
  const h = await mount(t, { draftStorage: storage({ [oldKey]: JSON.stringify({ [DAY]: { a: "No", base: null } }) }) });
  assert.match(h.text(), /Daytime 2030-01-01/);
  assert.match(h.text(), /no longer offered in check-in/);
  assert.equal(h.button("Save").props.disabled, true);
  h.click("Discard draft…"); await h.flush();
  assert.ok(h.storage.values.has(oldKey), "asking to discard does not remove the draft");
  h.click("Keep draft"); await h.flush();
  assert.ok(h.storage.values.has(oldKey));
  h.click("Discard draft…"); await h.flush();
  h.click("Discard these answers"); await h.flush();
  assert.equal(h.storage.values.has(oldKey), false);
  assert.equal(h.posts.length, 0);
});
