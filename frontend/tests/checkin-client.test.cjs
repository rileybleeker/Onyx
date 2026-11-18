// Execute the real CheckInClient and its event callbacks with a tiny hook scheduler.
// Synthetic data only: no DOM/browser, credentials, requests, database or delivery writes.
// Autosave (2026-11-15): answers save a short delay after the last tap. The real scheduler AND the real hook
// (lib/autosave.ts, lib/use-autosave.ts) run on a manual clock here (tests/helpers/autosave-harness.cjs): h.tick()
// fires what is due (default: the check-in's 600 ms delay), h.hide() is the browser hiding the page.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");
const { manualTimers, clockCache, advance, pageEvents, partGridPassThrough } = require("./helpers/autosave-harness.cjs");
const { contextShim } = require("./helpers/hook-harness.cjs");

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

async function mount(t, { initial = page(), draftStorage = storage(), onPost, onGet, onVoice, onJournal, hash } = {}) {
  const replaced = []; // addresses written by history.replaceState (the #say= hand-off clears its hash)
  let current = initial;
  let requested = null;
  let dirty = true;
  let frame;
  let effects = [];
  let tree;
  const frames = new Map();
  const posts = [];
  const postOptions = [];
  const gets = [];
  const done = [];
  // The autosave scheduler's clock only (other code keeps real timers).
  const timers = manualTimers();
  const browser = pageEvents(hash === undefined ? {} : { location: { hash, pathname: "/check-in", search: "" }, history: { replaceState: (_state, _title, url) => replaced.push(url) } });
  const equal = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const slot = () => [frame.slots, frame.index++];
  // React context (lib/use-unsaved-work.ts, under lib/use-autosave.ts, reads lib/feed-scope.ts's context).
  const context = contextShim();
  const hooks = {
    createContext: context.createContext,
    useContext: context.useContext,
    useId() { const [slots, i] = slot(); return slots[i] ??= `:synthetic${i}:`; },
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
    document: browser.document,
    window: browser.window,
    fetch: async (url, options = {}) => {
      if (url === "/api/habits/checkin/voice" && onVoice) return onVoice(JSON.parse(options.body));
      if (url === "/api/journal/entry" && onJournal) return onJournal(JSON.parse(options.body));
      assert.match(url, /^\/api\/habits\/checkin(?:\?date=\d{4}-\d{2}-\d{2})?$/);
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        posts.push(body);
        postOptions.push({ keepalive: !!options.keepalive });
        return onPost ? onPost(body, posts.length) : response({ success: true });
      }
      const date = new URL(url, "https://synthetic.invalid").searchParams.get("date");
      gets.push(date);
      const result = onGet ? await onGet(date, current, gets.length) : { ...current, date: date ?? current.date };
      return typeof result?.json === "function" ? result : response(result);
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
    // The trial question loads on its own (its own route, covered by tests/experiments.test.cjs).
    "./ExperimentAdherence": { __esModule: true, default: () => null },
    // /check-in is a personalized page since #272; the grid needs the personalize store and providers this shim does not
    // provide. The pass-through renders what the real grid renders, group headers included (the day tabs live in
    // one), and throws on any other prop that holds UI instead of dropping it.
    "@/components/personalize/PartGrid": partGridPassThrough(),
    // The /log Say it drafts (only the embedded check-in reads them; covered by tests/log-drafts.test.cjs).
    "@/lib/log-drafts": { useLogDrafts: () => ({ draft: null, clear: () => {} }), setLogDraft: () => {} },
    // The real scheduler on the manual clock, registered under its file (clockCache) so every import of it gets the
    // same module. lib/use-autosave.ts is NOT stubbed: the shipped hook runs, with its page-hidden (keepalive) and
    // unmount handling, and builds its saver from that module.
  }, { cache: clockCache(timers) }).default;
  function expand(node, id = "root") {
    if (node == null || typeof node === "boolean") return null;
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${id}/${child?.key ?? i}`));
    if (typeof node !== "object") return node;
    const provided = context.provide(node, (children) => expand(children, id));
    if (provided) return provided.rendered;
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
  let resumeOffset = 0;
  /** Advance the autosave clock: run every scheduler timer due within `ms`, rendering after each. */
  const tick = (ms = 600) => advance(timers, flush, ms);
  return { posts, postOptions, gets, done, flush, tick, text, button, click, replaced, storage: draftStorage,
    timersPending: () => timers.count(),
    /** Fire a window event (beforeunload, pageshow); false when nothing listens to it. */
    fire: (name, event) => browser.fire(name, event),
    /** The browser hides the page: the autosave hook sends what is waiting, with keepalive. */
    hide: async () => { browser.hide(); await flush(); },
    type: (label, value) => {
      const field = nodes().find((n) => n.props?.["aria-label"] === label && typeof n.props.onChange === "function");
      assert.ok(field, `field exists: ${label}`);
      field.props.onChange({ target: { value } });
    },
    hasButton: (label) => nodes().some((n) => n.type === "button" && (n.props["aria-label"] === label || text(n) === label)),
    setPage: (value) => { current = value; },
    navigate: (date) => { requested = date; dirty = true; },
    resume: async () => {
      const now = Date.now;
      resumeOffset += 61_000;
      Date.now = () => now() + resumeOffset;
      try { browser.fire("pageshow"); } finally { Date.now = now; }
      await flush();
    },
  };
}

test("client: taps save on their own after a short pause, one request per part touched, nothing before", async (t) => {
  const h = await mount(t);
  assert.equal(h.hasButton("Save"), false, "no Save button");
  assert.match(h.text(), /Answers save as you tap/);
  h.click(`${DAY}: yes`); await h.flush();
  h.click(`${SLEEP}: yes`); await h.flush();
  assert.ok(h.storage.values.has(dayKey("2031-03-05")), "the local draft is written first");
  await h.tick(599);
  assert.equal(h.posts.length, 0, "nothing until the pause after the last tap");
  await h.tick(1);
  assert.deepEqual(h.posts, [
    { date: "2031-03-05", answers: { [DAY]: "Yes" }, today: "2031-03-05" },
    { date: "2031-03-04", answers: { [SLEEP]: "Yes" }, today: "2031-03-05" },
  ]);
  assert.match(h.text(), /Saved/);
  assert.equal(h.storage.values.has(dayKey("2031-03-05")), false, "the saved draft is settled");
  assert.equal(h.storage.values.has(nightKey("2031-03-04")), false);
  await h.tick(60_000);
  assert.equal(h.posts.length, 2, "nothing more to send");
});

test("client: opening the check-in writes nothing, and a burst of taps is one request", async (t) => {
  const OTHER = "Synthetic second daytime question?";
  const base = page();
  base.items.push(question(OTHER, false));
  const h = await mount(t, { initial: base });
  await h.tick(60_000);
  assert.equal(h.posts.length, 0, "nothing is written on open");
  h.click("No for the other 2"); await h.flush();
  h.click(`${DAY}: yes`); await h.flush();
  await h.tick();
  assert.deepEqual(h.posts, [{ date: "2031-03-05", answers: { [DAY]: "Yes", [OTHER]: "No" }, today: "2031-03-05" }]);
});

test("client: the Agents card settles only once every core daytime question is saved, once per day", async (t) => {
  const OTHER = "Synthetic second daytime question?";
  const base = page();
  base.items.push(question(OTHER, false));
  // A synthetic server that keeps the day's answers, so the reload after each save shows them.
  const stored = {};
  const h = await mount(t, {
    initial: base,
    onPost: async (body) => { Object.assign(stored, body.answers); return response({ success: true }); },
    onGet: (date, current) => ({ ...current, date: date ?? current.date, answers: { ...stored } }),
  });
  h.click(`${DAY}: yes`); await h.flush();
  await h.tick();
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.done, [], "a half-answered day keeps its card");
  h.click(`${OTHER}: no`); await h.flush();
  await h.tick();
  assert.deepEqual(h.done, ["2031-03-05"], "settled when the day is complete");
  h.click(`${OTHER}: yes`); await h.flush();
  await h.tick();
  assert.equal(h.posts.length, 3);
  assert.deepEqual(h.done, ["2031-03-05"], "not again for the same day");
});

test("client: on today a tap is saved alone; the day's pre-fills are stored only in the save that completes the day", async (t) => {
  const SUGGESTED = "Synthetic pre-filled question?";
  const LAST = "Synthetic last daytime question?";
  const base = page();
  base.items.push(question(SUGGESTED, false), question(LAST, false));
  base.suggestions = { [SUGGESTED]: { answer: "Yes", source: "synthetic data" } };
  const stored = {};
  const h = await mount(t, {
    initial: base,
    onPost: async (body) => { Object.assign(stored, body.answers); return response({ success: true }); },
    onGet: (date, current) => ({ ...current, date: date ?? current.date, answers: { ...stored } }),
  });
  h.click(`${DAY}: yes`); await h.flush();
  await h.tick();
  assert.deepEqual(h.posts, [{ date: "2031-03-05", answers: { [DAY]: "Yes" }, today: "2031-03-05" }], "the pre-fill waits: it can still change today");
  assert.deepEqual(h.done, []);
  assert.match(h.text(), /from synthetic data/, "still shown as a suggestion");
  await h.tick(60_000);
  assert.equal(h.posts.length, 1, "a pre-fill alone is never sent");
  h.click(`${LAST}: no`); await h.flush();
  await h.tick();
  assert.deepEqual(h.posts[1], { date: "2031-03-05", answers: { [SUGGESTED]: "Yes", [LAST]: "No" }, today: "2031-03-05" }, "complete counting the pre-fill: stored with the last answer");
  assert.deepEqual(h.done, ["2031-03-05"], "and the card settles in the same save");
});

test("client: on a catch-up day the day's pre-fills go with the first tap", async (t) => {
  const SUGGESTED = "Synthetic pre-filled question?";
  const LAST = "Synthetic last daytime question?";
  const base = page();
  base.items.push(question(SUGGESTED, false), question(LAST, false));
  base.suggestions = { [SUGGESTED]: { answer: "Yes", source: "synthetic data" } };
  const h = await mount(t, { initial: base });
  h.navigate("2031-03-04"); await h.flush();
  h.click(`${DAY}: yes`); await h.flush();
  await h.tick();
  assert.deepEqual(h.posts, [{ date: "2031-03-04", answers: { [DAY]: "Yes", [SUGGESTED]: "Yes" }, today: "2031-03-05" }]);
});

test("client: a sleep-only save never settles the card", async (t) => {
  const h = await mount(t);
  h.click(`${SLEEP}: yes`); await h.flush();
  await h.tick();
  assert.deepEqual(h.posts.map((p) => p.date), ["2031-03-04"]);
  assert.deepEqual(h.done, []);
});

test("client: hiding the page sends a waiting tap at once, with keepalive", async (t) => {
  const h = await mount(t);
  h.click(`${DAY}: yes`); await h.flush();
  await h.hide();
  assert.deepEqual(h.posts, [{ date: "2031-03-05", answers: { [DAY]: "Yes" }, today: "2031-03-05" }]);
  assert.deepEqual(h.postOptions, [{ keepalive: true }]);
});

test("client: a refused save is shown, not retried by itself, and Retry sends it again", async (t) => {
  let refuse = true;
  const h = await mount(t, { onPost: async () => refuse ? response({ error: "Synthetic refusal" }, 400) : response({ success: true }) });
  h.click(`${DAY}: yes`); await h.flush();
  await h.tick();
  assert.match(h.text(), /Not saved: Couldn't save\. Try again\./);
  assert.doesNotMatch(h.text(), /Synthetic refusal/, "the server's own error text is never shown");
  await h.tick(120_000);
  assert.equal(h.posts.length, 1, "a refusal waits for Riley");
  refuse = false;
  h.click("Retry"); await h.flush();
  assert.equal(h.posts.length, 2);
  assert.match(h.text(), /Saved/);
});

test("client: an outage is retried on its own", async (t) => {
  let down = true;
  const h = await mount(t, { onPost: async () => down ? response({ error: "Synthetic outage" }, 503) : response({ success: true }) });
  h.click(`${DAY}: yes`); await h.flush();
  await h.tick();
  assert.match(h.text(), /Not saved: Save failed \(503\)\. Your answers are still here\. Trying again…/);
  assert.doesNotMatch(h.text(), /Synthetic outage/, "the server's own error text is never shown");
  down = false;
  await h.tick(2000);
  assert.equal(h.posts.length, 2);
  assert.match(h.text(), /Saved/);
  assert.equal(h.storage.values.has(dayKey("2031-03-05")), false);
});

test("client: answers left from an earlier visit are never sent on open; reviewing them saves them", async (t) => {
  const h = await mount(t, { draftStorage: storage({ [dayKey("2031-03-05")]: JSON.stringify({ [DAY]: { a: "Yes", base: null } }) }) });
  assert.match(h.text(), /Review preserved answers/);
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], false, "held for review, not on the form");
  assert.equal(h.hasButton("Save now"), false);
  await h.tick(60_000);
  assert.equal(h.posts.length, 0, "never on open");
  h.click("Use answers for Daytime 2031-03-05"); await h.flush();
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], true);
  await h.tick();
  assert.deepEqual(h.posts, [{ date: "2031-03-05", answers: { [DAY]: "Yes" }, today: "2031-03-05" }]);
});

test("client: switching the day tab saves a waiting tap under its own day first", async (t) => {
  const h = await mount(t);
  h.click(`${DAY}: yes`); await h.flush();
  h.click("Yesterdaynot started"); await h.flush();
  assert.deepEqual(h.posts, [{ date: "2031-03-05", answers: { [DAY]: "Yes" }, today: "2031-03-05" }]);
  assert.equal(h.gets.at(-1), "2031-03-04", "then the tab changes");
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], false, "the other day is independent");
  assert.equal(h.storage.values.has(dayKey("2031-03-04")), false);
});

test("client: stale before the first write preserves both original dates and requires review", async (t) => {
  const h = await mount(t, { onPost: async () => response({ stale: true }, 409) });
  h.click(`${DAY}: yes`); await h.flush();
  h.click(`${SLEEP}: yes`); await h.flush();
  h.setPage(page("2031-03-06"));
  await h.tick();
  assert.equal(h.posts.length, 1, "the rejected day stops the night request");
  assert.match(h.text(), /Daytime 2031-03-05/);
  assert.match(h.text(), /Night 2031-03-04 → 2031-03-05 morning/);
  assert.match(h.text(), /Unsaved answers are preserved/);
  assert.equal(h.hasButton("Save now"), false, "preserved answers are not offered for saving");
  await h.tick(120_000);
  assert.equal(h.posts.length, 1, "nothing is retried");
  assert.ok(h.storage.values.has(dayKey("2031-03-05")));
  assert.ok(h.storage.values.has(nightKey("2031-03-04")));
});

test("client: day success then night stale settles only the day; review saves the original night", async (t) => {
  const h = await mount(t, { onPost: async (_body, count) => count === 2 ? response({ stale: true }, 409) : response({ success: true }) });
  h.click(`${DAY}: yes`); await h.flush();
  h.click(`${SLEEP}: yes`); await h.flush();
  h.setPage(page("2031-03-06"));
  await h.tick();
  assert.deepEqual(h.done, ["2031-03-05"], "the one core daytime question is saved: the day is complete");
  assert.equal(h.storage.values.has(dayKey("2031-03-05")), false);
  assert.equal(h.hasButton("Save now"), false);
  h.click("Use answers for Night 2031-03-04 → 2031-03-05 morning"); await h.flush();
  assert.equal(h.posts.length, 2, "review itself sends nothing at once");
  await h.tick();
  assert.deepEqual(h.posts.map((p) => p.date), ["2031-03-05", "2031-03-04", "2031-03-04"], "the reviewed night then saves like a tap");
  assert.deepEqual(h.posts[2], { date: "2031-03-04", answers: { [SLEEP]: "Yes" }, today: "2031-03-06" });
});

test("client: a newer tap during a save survives the reload and is sent by the next save", async (t) => {
  const pending = deferred();
  const h = await mount(t, { onPost: (_body, count) => count === 1 ? pending.promise : response({ success: true }) });
  h.click(`${DAY}: yes`); await h.flush();
  await h.tick(); // the save of Yes starts and waits
  assert.match(h.text(), /Saving…/);
  h.click(`${DAY}: no`); await h.flush();
  const savedPage = page(); savedPage.answers[DAY] = "Yes";
  h.setPage(savedPage);
  pending.resolve(response({ success: true }));
  await h.flush();
  assert.equal(h.button(`${DAY}: no`).props["aria-pressed"], true);
  assert.deepEqual(JSON.parse(h.storage.values.get(dayKey(savedPage.date))), { [DAY]: { a: "No", base: "Yes" } });
  assert.equal(h.posts.length, 1, "single flight: one save at a time");
  await h.tick();
  assert.deepEqual(h.posts.map((p) => p.answers[DAY]), ["Yes", "No"]);
});

test("client: failed storage retains drafts through stale reload and warns before leaving", async (t) => {
  const h = await mount(t, { draftStorage: storage({}, true), onPost: async () => response({ stale: true }, 409) });
  h.click(`${DAY}: yes`); await h.flush();
  assert.match(h.text(), /Some drafts could not be read or stored/);
  let warned = false;
  assert.ok(h.fire("beforeunload", { preventDefault: () => { warned = true; } }), "a leave warning is registered");
  assert.equal(warned, true);
  h.setPage(page("2031-03-06"));
  await h.tick();
  assert.match(h.text(), /Daytime 2031-03-05/);
  assert.match(h.text(), /Synthetic daytime question\?: Yes/);
  assert.equal(h.posts.length, 1);
});

test("client: ordinary night failure retains pending answers without resubmitting the successful day", async (t) => {
  const h = await mount(t, { onPost: async (_body, count) => count === 2 ? response({ error: "Synthetic save failure" }, 500) : response({ success: true }) });
  h.click(`${DAY}: yes`); await h.flush();
  h.click(`${SLEEP}: no`); await h.flush();
  await h.tick();
  assert.match(h.text(), /Not saved: Couldn't save\. Try again\./);
  assert.doesNotMatch(h.text(), /Synthetic save failure/, "the server's own error text is never shown");
  assert.equal(h.storage.values.has(dayKey("2031-03-05")), false);
  assert.ok(h.storage.values.has(nightKey("2031-03-04")));
  h.click("Retry"); await h.flush();
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
  await h.tick(); // the save starts and waits
  h.navigate("2031-03-04"); await h.flush();
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], true, "the pending save keeps its original dated form");
  saved = true;
  pending.resolve(response({ success: true }));
  await h.flush();
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], false, "the newly selected day's answers are independent");
  assert.equal(h.hasButton("Save now"), false);
  assert.deepEqual(h.posts, [{ date: "2031-03-05", answers: { [DAY]: "Yes" }, today: "2031-03-05" }]);
  assert.equal(h.storage.values.has(dayKey("2031-03-04")), false);
});

test("client: reopening an old draft shows its original date, cannot submit it, and discard requires confirmation", async (t) => {
  const oldKey = dayKey("2030-01-01");
  const h = await mount(t, { draftStorage: storage({ [oldKey]: JSON.stringify({ [DAY]: { a: "No", base: null } }) }) });
  assert.match(h.text(), /Daytime 2030-01-01/);
  assert.match(h.text(), /no longer offered in check-in/);
  assert.equal(h.hasButton("Save now"), false, "an old draft is never offered for saving");
  await h.tick(60_000);
  h.click("Discard draft…"); await h.flush();
  assert.ok(h.storage.values.has(oldKey), "asking to discard does not remove the draft");
  h.click("Keep draft"); await h.flush();
  assert.ok(h.storage.values.has(oldKey));
  h.click("Discard draft…"); await h.flush();
  h.click("Discard these answers"); await h.flush();
  assert.equal(h.storage.values.has(oldKey), false);
  assert.equal(h.posts.length, 0);
});

test("client: reopening a non-null draft already equal to the saved answer does not block fresh edits", async (t) => {
  const saved = page(); saved.answers[DAY] = "Yes";
  const h = await mount(t, {
    initial: saved,
    draftStorage: storage({ [dayKey(saved.date)]: JSON.stringify({ [DAY]: { a: "Yes", base: "Yes" } }) }),
  });
  assert.doesNotMatch(h.text(), /Review preserved answers/);
  h.click(`${DAY}: no`); await h.flush();
  assert.equal(h.button(`${DAY}: no`).props["aria-pressed"], true);
  assert.deepEqual(JSON.parse(h.storage.values.get(dayKey(saved.date))), { [DAY]: { a: "No", base: "Yes" } });
  assert.equal(h.posts.length, 0, "the draft is written before the save");
  await h.tick();
  assert.deepEqual(h.posts, [{ date: saved.date, answers: { [DAY]: "No" }, today: saved.today }]);
});

for (const failure of ["network", "server"]) {
  test(`client: transient ${failure} failure on resume keeps the dated form and active draft editable`, async (t) => {
    const h = await mount(t, {
      onGet: (_date, current, count) => {
        if (count <= 2) return current; // the first load, and the reload after the save
        if (failure === "network") throw new TypeError("Synthetic offline transport");
        return response({ error: "Synthetic reload outage" }, 500);
      },
    });
    h.click(`${DAY}: yes`); await h.flush();
    const savedPage = page(); savedPage.answers[DAY] = "Yes";
    h.setPage(savedPage);
    await h.tick();
    assert.equal(h.posts.length, 1, "the tap saved");
    await h.resume();
    assert.equal(h.gets.length, 3, "resume issued a new GET");
    assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], true, "failed refresh retains the visible original answer");
    assert.match(h.text(), /2031-03-05/, "the retained form identifies its original date explicitly");
    assert.match(h.text(), /2031-03-04/, "the retained night also identifies its original date");
    assert.doesNotMatch(h.text(), /Last night|Daytime · Today/, "a failed clock refresh must not assert current relative labels");
    assert.doesNotMatch(h.text(), /Review preserved answers/);
    assert.match(h.text(), failure === "network" ? /Couldn't reach Onyx/ : /Couldn't load the check-in \(500\)\./);
    assert.doesNotMatch(h.text(), /Synthetic reload outage/, "the server's own error text is never shown");
    h.click(`${DAY}: no`); await h.flush();
    assert.equal(h.button(`${DAY}: no`).props["aria-pressed"], true);
    assert.deepEqual(JSON.parse(h.storage.values.get(dayKey("2031-03-05"))), { [DAY]: { a: "No", base: "Yes" } });
    assert.equal(h.posts.length, 1, "a failed refresh sends nothing by itself");
    await h.tick();
    assert.deepEqual(h.posts[1], { date: "2031-03-05", answers: { [DAY]: "No" }, today: "2031-03-05" }, "the new tap still saves under the original date");
  });
}

for (const status of [400, 401, 403]) {
  test(`client: authoritative GET refusal ${status} removes the usable form and preserves dated review`, async (t) => {
    // The tap's save fails (an outage), so it is still a draft when the refresh is refused.
    const h = await mount(t, {
      onPost: async () => response({ error: "Synthetic save outage" }, 503),
      onGet: (_date, current, count) => count === 1 ? current : response({ error: "Synthetic date or session refusal" }, status),
    });
    h.click(`${DAY}: yes`); await h.flush();
    await h.tick();
    await h.resume(); // tries the save once more first (it fails again), then the refused GET
    assert.equal(h.hasButton(`${DAY}: yes`), false);
    assert.equal(h.hasButton("Save now"), false);
    assert.ok(h.text().includes(`Couldn't load the check-in (${status}).`), "the fixed refusal sentence, not the server's text");
    assert.doesNotMatch(h.text(), /Synthetic date or session refusal/, "the server's own error text is never shown");
    assert.match(h.text(), /Review preserved answers/);
    assert.match(h.text(), /Daytime 2031-03-05/);
    assert.equal(h.posts.length, 2, "both attempts failed; nothing was stored");
    assert.ok(h.storage.values.has(dayKey("2031-03-05")));
  });
}

for (const stale of [false, true]) {
  test(`client: queued navigation retains the ${stale ? "stale-day" : "save-failure"} explanation`, async (t) => {
    const pending = deferred();
    const h = await mount(t, { onPost: () => pending.promise });
    h.click(`${DAY}: yes`); await h.flush();
    await h.tick(); // the save starts and waits
    h.navigate("2031-03-04"); await h.flush();
    if (stale) h.setPage(page("2031-03-06"));
    pending.resolve(response(stale ? { stale: true } : { error: "Synthetic save failure that must stay visible" }, stale ? 409 : 500));
    await h.flush();
    assert.match(h.text(), stale ? /A new day started.*Unsaved answers are preserved/ : /Not saved: Couldn't save\. Try again\./);
    if (!stale) assert.doesNotMatch(h.text(), /Synthetic save failure that must stay visible/, "the server's own error text is never shown");
    // A failed save stops the switch (#608): the day stays on screen under its normal label. A stale-day rejection
    // still turns the form into the dated review.
    assert.match(h.text(), stale ? /Daytime 2031-03-05/ : /Daytime · TodayWed, Mar 5/);
    assert.equal(h.posts.length, 1);
    assert.equal(h.hasButton("Save now"), false, "unreviewed drafts never follow navigation into a save");
    if (!stale) {
      // The day switch that was put back must not resend the failed save at once; its backoff retry sends it later.
      await h.tick(2000);
      assert.equal(h.posts.length, 2, "the failed save is retried after its backoff");
      assert.deepEqual(h.posts[1], h.posts[0], "the retry carries the same answers under the same day");
    }
  });
}

test("client: failed refresh after a known stale-day rejection never restores the invalidated form", async (t) => {
  const h = await mount(t, {
    onPost: () => response({ stale: true }, 409),
    onGet: (_date, current, count) => {
      if (count === 1) return current;
      throw new TypeError("Synthetic offline after stale rejection");
    },
  });
  h.click(`${DAY}: yes`); await h.flush();
  await h.tick();
  assert.match(h.text(), /A new day started.*Unsaved answers are preserved/);
  assert.match(h.text(), /Daytime 2031-03-05/);
  assert.equal(h.hasButton(`${DAY}: yes`), false);
  assert.equal(h.hasButton("Save now"), false);
  assert.equal(h.posts.length, 1);
});

test("client: discard confirmation remains bound to its original review snapshot after another tab's additions reload", async (t) => {
  const key = dayKey("2031-03-04");
  const shared = storage({ [key]: JSON.stringify({ [DAY]: { a: "Yes", base: null } }) });
  const h = await mount(t, { draftStorage: shared });
  h.click("Discard draft…"); await h.flush();
  const unseen = "Synthetic second-tab answer?";
  shared.setItem(key, JSON.stringify({ [DAY]: { a: "Yes", base: null }, [unseen]: { a: "No", base: null } }));
  h.navigate("2031-03-04"); await h.flush();
  assert.equal(h.gets.length, 2, "navigation reloaded the recovery entries while confirmation stayed open");
  assert.match(h.text(), /Synthetic second-tab answer\?: No/, "the rerender includes the newer answer");
  h.click("Discard these answers"); await h.flush();
  assert.deepEqual(JSON.parse(shared.getItem(key)), { [unseen]: { a: "No", base: null } });
  assert.match(h.text(), /Synthetic second-tab answer\?: No/);
  assert.equal(h.posts.length, 0);
});

test("client: malformed stored JSON is retained while fresh in-memory answers remain usable", async (t) => {
  const key = dayKey("2031-03-05");
  const raw = "{synthetic malformed draft";
  const shared = storage({ [key]: raw });
  const h = await mount(t, { draftStorage: shared });
  assert.match(h.text(), /Some drafts could not be read or stored/);
  assert.doesNotMatch(h.text(), /Browser storage is unavailable/);
  h.click(`${DAY}: yes`); await h.flush();
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], true);
  assert.equal(shared.getItem(key), raw, "a failed read must not overwrite the unread original record");
  assert.equal(h.posts.length, 0);
  await h.tick();
  assert.equal(h.posts.length, 1, "the tap kept in memory still saves");
  assert.equal(shared.getItem(key), raw, "and the unread original record is still untouched");
});

test("client: a transient failed day switch keeps the old date explicit and cannot submit onto the requested date", async (t) => {
  const h = await mount(t, { onGet: (_date, current, count) => count === 1 ? current : response({ error: "Synthetic navigation outage" }, 500) });
  h.click(`${DAY}: yes`); await h.flush();
  h.navigate("2031-03-04"); await h.flush(); // the waiting tap is saved under its own day before the switch
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], true);
  assert.match(h.text(), /2031-03-05/);
  assert.deepEqual(h.posts, [{ date: "2031-03-05", answers: { [DAY]: "Yes" }, today: "2031-03-05" }]);
  await h.tick(60_000);
  assert.equal(h.posts.length, 1);
  assert.equal(h.storage.values.has(dayKey("2031-03-04")), false);
});

test("client: a day switch whose pending save is refused stays on the day, keeps the draft and shows the reason", async (t) => {
  const h = await mount(t, { onPost: async () => response({ error: "Synthetic refusal" }, 400) });
  h.click(`${DAY}: yes`); await h.flush();
  h.navigate("2031-03-04"); await h.flush(); // the waiting tap is saved first; the refusal stops the switch
  assert.equal(h.gets.includes("2031-03-04"), false, "the other day is never fetched, so it never replaces the screen");
  assert.match(h.text(), /Daytime · TodayWed, Mar 5/, "the screen still shows the day the answer belongs to");
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], true, "the unsaved answer is still on screen");
  assert.match(h.text(), /Not saved: Couldn't save\. Try again\./);
  assert.equal(h.posts.length, 1, "a refusal is not retried by the switch");
  assert.ok(h.button("Retry"), "Retry is offered");
});

test("client: a voice fill that answers late keeps the taps and clears made while it was read", async (t) => {
  const OTHER = "Synthetic second daytime question?";
  const THIRD = "Synthetic third daytime question?";
  const base = page();
  base.items.push(question(OTHER, false), question(THIRD, false));
  const reply = deferred();
  const h = await mount(t, { initial: base, onVoice: () => reply.promise });
  h.click(`${OTHER}: yes`); await h.flush(); // tapped before the text was sent: never overwritten either
  h.type("Say it once", "Synthetic dictation that answers everything."); await h.flush();
  const filling = h.click("Fill answers"); await h.flush();
  assert.equal(h.button("Filling…").props.disabled, true);
  h.click(`${DAY}: no`); await h.flush(); // tapped while the text is read
  h.click(`${OTHER}: yes`); await h.flush(); // cleared while the text is read
  reply.resolve(response({ answers: { [DAY]: "Yes", [OTHER]: "No", [THIRD]: "Yes" } }));
  await filling; await h.flush();
  assert.equal(h.button(`${DAY}: no`).props["aria-pressed"], true, "the tap made during the fill stands");
  assert.equal(h.button(`${OTHER}: yes`).props["aria-pressed"], false, "the clear made during the fill stands");
  assert.equal(h.button(`${OTHER}: no`).props["aria-pressed"], false);
  assert.equal(h.button(`${THIRD}: yes`).props["aria-pressed"], true, "an untouched row is filled");
  assert.match(h.text(), /Filled 1 answer\. They save on their own/);
  await h.tick();
  assert.deepEqual(h.posts[0].answers, { [DAY]: "No", [THIRD]: "Yes" });
});

// ─── Say it once: last night's sleep, the journal draft, the Shortcut hand-off (2026-11-14) ────────────────

test("client: a voice fill puts last night's sleep answers in that night's block only, saved under that night", async (t) => {
  const sent = [];
  const h = await mount(t, {
    onVoice: async (body) => {
      sent.push(body);
      return response({ answers: { [DAY]: "Yes", [SLEEP]: "Yes" }, night: { date: "2031-03-04", answers: { [SLEEP]: "No" } }, journal: null });
    },
  });
  h.type("Say it once", "Synthetic note about the day and last night."); await h.flush();
  await h.click("Fill answers"); await h.flush();
  assert.deepEqual(sent, [{ date: "2031-03-05", text: "Synthetic note about the day and last night.", today: "2031-03-05" }]);
  assert.equal(h.button(`${SLEEP}: no`, 0).props["aria-pressed"], true, "last night's block");
  assert.equal(h.button(`${SLEEP}: no`, 1).props["aria-pressed"], false, "the night before is untouched");
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], true, "a sleep name in the day answers is ignored");
  assert.match(h.text(), /Filled 2 answers \(1 for last night\)\./);
  assert.equal(h.posts.length, 0, "Fill itself writes nothing");
  await h.tick(); // the filled answers save like taps
  assert.deepEqual(h.posts, [
    { date: "2031-03-05", answers: { [DAY]: "Yes" }, today: "2031-03-05" },
    { date: "2031-03-04", answers: { [SLEEP]: "No" }, today: "2031-03-05" },
  ]);
});

for (const [night, what] of [["2031-03-05", "tonight"], ["2031-03-01", "a night not on screen"]]) {
  test(`client: sleep answers for ${what} are dropped`, async (t) => {
    const h = await mount(t, { onVoice: async () => response({ answers: {}, night: { date: night, answers: { [SLEEP]: "Yes" } }, journal: null }) });
    h.type("Say it once", "Synthetic note."); await h.flush();
    await h.click("Fill answers"); await h.flush();
    assert.equal(h.button(`${SLEEP}: yes`, 0).props["aria-pressed"], false);
    assert.equal(h.button(`${SLEEP}: yes`, 1).props["aria-pressed"], false);
    assert.match(h.text(), /Nothing in the text matched a question\./);
  });
}

test("client: a stale screen reloads instead of filling", async (t) => {
  const h = await mount(t, { onVoice: async () => response({ error: "A new day started since this page loaded.", stale: true }, 409) });
  h.type("Say it once", "Synthetic note."); await h.flush();
  await h.click("Fill answers"); await h.flush();
  assert.equal(h.gets.length, 2, "reloaded");
  assert.match(h.text(), /A new day started since this page loaded\. It has reloaded/);
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], false);
});

test("client: the journal draft is written only by Save to journal (never automatically), with the words verbatim and every label", async (t) => {
  const JOURNALED = "Journaled your thoughts?";
  const base = page();
  base.items.push(question(JOURNALED, false));
  const words = "Synthetic reflection, first part.\n\nSynthetic second part.";
  const written = [];
  const h = await mount(t, {
    initial: base,
    onVoice: async () => response({ answers: {}, night: null, journal: { title: "Synthetic reflective evening", mood: "good", confidence: "high", topics: ["reflection"] } }),
    onJournal: async (body) => { written.push(body); return response({ url: "https://www.notion.so/synthetic-page" }); },
  });
  h.type("Say it once", words); await h.flush();
  await h.click("Fill answers"); await h.flush();
  assert.match(h.text(), /Journal entry/);
  assert.match(h.text(), /draft · not saved/);
  await h.tick(60_000);
  assert.equal(written.length, 0, "Fill never writes the journal, and autosave never files it");
  await h.click("Save to journal"); await h.flush();
  assert.deepEqual(written, [{ date: "2031-03-05", title: "Synthetic reflective evening", mood: "good", confidence: "high", source: "voice", topics: ["reflection"], body: words }]);
  assert.match(h.text(), /Saved to your journal/);
  assert.equal(h.button(`${JOURNALED}: yes`).props["aria-pressed"], true, "a draft Yes for the day");
  assert.match(h.text(), /from the journal entry you saved/);
  assert.equal(h.posts.length, 0, "the check-in answer waits for the autosave pause");
  await h.tick();
  assert.deepEqual(h.posts[0].answers, { [JOURNALED]: "Yes" });
});

test("client: the journal draft needs a mood and a topic, and a refused save keeps it", async (t) => {
  const written = [];
  const h = await mount(t, {
    onVoice: async () => response({ answers: {}, night: null, journal: { title: "Synthetic title words", mood: null, confidence: "medium", topics: [] } }),
    onJournal: async (body) => { written.push(body); return response({ error: "Synthetic Notion refusal" }, 502); },
  });
  h.type("Say it once", "Synthetic words."); await h.flush();
  await h.click("Fill answers"); await h.flush();
  assert.equal(h.button("Save to journal").props.disabled, true);
  assert.match(h.text(), /Add a mood, a topic first\./);
  h.click("neutral"); await h.flush();
  h.type("Add topic", "reflection"); await h.flush();
  await h.click("Save to journal"); await h.flush();
  assert.equal(written.length, 1);
  assert.equal(written[0].mood, "neutral");
  assert.deepEqual(written[0].topics, ["reflection"]);
  assert.match(h.text(), /Couldn't save the journal entry \(502\)\. It is still here\./);
  assert.doesNotMatch(h.text(), /Synthetic Notion refusal/, "the server's own error text is never shown");
  assert.equal(h.button("Save to journal").props.disabled, false, "still there to try again");
});

test("client: the Shortcut hand-off (#say=) clears the address and fills once from the fresh check-in", async (t) => {
  const sent = [];
  const h = await mount(t, {
    hash: "#say=Synthetic%20handed%20over%20words",
    onVoice: async (body) => { sent.push(body); return response({ answers: { [DAY]: "Yes" }, night: null, journal: null }); },
  });
  await h.flush();
  assert.deepEqual(h.replaced, ["/check-in"], "the words leave the address bar at once");
  assert.equal(sent.length, 1, "filled exactly once");
  assert.equal(sent[0].text, "Synthetic handed over words");
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], true);
  assert.equal(h.posts.length, 0, "Fill itself writes nothing");
  await h.tick();
  assert.deepEqual(h.posts, [{ date: "2031-03-05", answers: { [DAY]: "Yes" }, today: "2031-03-05" }], "its answers save like taps");
});
