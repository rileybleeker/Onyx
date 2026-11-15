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

async function mount(t, { initial = page(), draftStorage = storage(), onPost, onGet, onVoice } = {}) {
  let current = initial;
  let requested = null;
  let dirty = true;
  let frame;
  let effects = [];
  let tree;
  const frames = new Map();
  const posts = [];
  const gets = [];
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
      if (url === "/api/habits/checkin/voice" && onVoice) return onVoice(JSON.parse(options.body));
      assert.match(url, /^\/api\/habits\/checkin(?:\?date=\d{4}-\d{2}-\d{2})?$/);
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        posts.push(body);
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
  let resumeOffset = 0;
  return { posts, gets, done, flush, text, button, click, windowEvents, storage: draftStorage,
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
      try { windowEvents.get("pageshow")?.(); } finally { Date.now = now; }
      await flush();
    },
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
  assert.match(h.text(), /Some drafts could not be read or stored/);
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
  assert.equal(h.posts.length, 0);
});

for (const failure of ["network", "server"]) {
  test(`client: transient ${failure} failure on resume keeps the dated form and active draft editable`, async (t) => {
    const h = await mount(t, {
      onGet: (_date, current, count) => {
        if (count === 1) return current;
        if (failure === "network") throw new TypeError("Synthetic offline transport");
        return response({ error: "Synthetic reload outage" }, 500);
      },
    });
    h.click(`${DAY}: yes`); await h.flush();
    await h.resume();
    assert.equal(h.gets.length, 2, "resume issued a new GET");
    assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], true, "failed refresh retains the visible original answer");
    assert.match(h.text(), /2031-03-05/, "the retained form identifies its original date explicitly");
    assert.match(h.text(), /2031-03-04/, "the retained night also identifies its original date");
    assert.doesNotMatch(h.text(), /Last night|Daytime · Today/, "a failed clock refresh must not assert current relative labels");
    assert.doesNotMatch(h.text(), /Review preserved answers/);
    assert.match(h.text(), failure === "network" ? /Couldn't reach Onyx/ : /Synthetic reload outage/);
    h.click(`${DAY}: no`); await h.flush();
    assert.equal(h.button(`${DAY}: no`).props["aria-pressed"], true);
    assert.equal(h.button("Save").props.disabled, false);
    assert.deepEqual(JSON.parse(h.storage.values.get(dayKey("2031-03-05"))), { [DAY]: { a: "No", base: null } });
    assert.equal(h.posts.length, 0, "refresh or local editing must not submit anything");
  });
}

for (const status of [400, 401, 403]) {
  test(`client: authoritative GET refusal ${status} removes the usable form and preserves dated review`, async (t) => {
    const h = await mount(t, { onGet: (_date, current, count) => count === 1 ? current : response({ error: "Synthetic date or session refusal" }, status) });
    h.click(`${DAY}: yes`); await h.flush();
    await h.resume();
    assert.equal(h.hasButton(`${DAY}: yes`), false);
    assert.equal(h.hasButton("Save"), false);
    assert.match(h.text(), /Synthetic date or session refusal/);
    assert.match(h.text(), /Review preserved answers/);
    assert.match(h.text(), /Daytime 2031-03-05/);
    assert.equal(h.posts.length, 0);
  });
}

for (const stale of [false, true]) {
  test(`client: queued navigation retains the ${stale ? "stale-day" : "save-failure"} explanation`, async (t) => {
    const pending = deferred();
    const h = await mount(t, { onPost: () => pending.promise });
    h.click(`${DAY}: yes`); await h.flush();
    const saving = h.click("Save"); await h.flush();
    h.navigate("2031-03-04"); await h.flush();
    if (stale) h.setPage(page("2031-03-06"));
    pending.resolve(response(stale ? { stale: true } : { error: "Synthetic save failure that must stay visible" }, stale ? 409 : 500));
    await saving; await h.flush();
    assert.match(h.text(), stale ? /A new day started.*Unsaved answers are preserved/ : /Synthetic save failure that must stay visible/);
    assert.match(h.text(), /Daytime 2031-03-05/);
    assert.equal(h.posts.length, 1);
    assert.equal(h.button("Save").props.disabled, true, "unreviewed drafts cannot follow navigation into Save");
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
  await h.click("Save"); await h.flush();
  assert.match(h.text(), /A new day started.*Unsaved answers are preserved/);
  assert.match(h.text(), /Daytime 2031-03-05/);
  assert.equal(h.hasButton(`${DAY}: yes`), false);
  assert.equal(h.hasButton("Save"), false);
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
  assert.equal(h.button("Save").props.disabled, false);
  assert.equal(shared.getItem(key), raw, "a failed read must not overwrite the unread original record");
  assert.equal(h.posts.length, 0);
});

test("client: a transient failed day switch keeps the old date explicit and cannot submit onto the requested date", async (t) => {
  const h = await mount(t, { onGet: (_date, current, count) => count === 1 ? current : response({ error: "Synthetic navigation outage" }, 500) });
  h.click(`${DAY}: yes`); await h.flush();
  h.navigate("2031-03-04"); await h.flush();
  assert.equal(h.button(`${DAY}: yes`).props["aria-pressed"], true);
  assert.match(h.text(), /2031-03-05/);
  await h.click("Save"); await h.flush();
  assert.deepEqual(h.posts, [{ date: "2031-03-05", answers: { [DAY]: "Yes" }, today: "2031-03-05" }]);
  assert.equal(h.storage.values.has(dayKey("2031-03-04")), false);
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
  assert.match(h.text(), /Filled 1 answer\./);
  await h.click("Save"); await h.flush();
  assert.deepEqual(h.posts[0].answers, { [DAY]: "No", [THIRD]: "Yes" });
});
