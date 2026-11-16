// Run: node --test tests/log-reading-retain.test.cjs (offline). PROD-T01, 2026-11-16: the /log Reading section
// (app/log/sections/Reading.tsx) keeps an entry that is not saved yet when the section is unmounted (the continuous
// scroll dropping the Log page, a navigation, a hidden part) and shows it again on the next mount; a create that
// failed offline keeps its client_key, so Retry creates the session once; opening the section never sends anything;
// an entry made before the behavioral day rolls keeps its own day, also when 06:00 comes later on this device's clock
// than on the Eastern one (travelling west); Discard / Remove / New session pressed while a
// field has focus are never pre-empted by the form's blur save (the press keeps focus, Tab to them skips the save, a
// touch press that still blurs the field is remembered, a touch that became a scroll is not); a session end stops a
// save under way (no replay PATCH, no refetch); a copy mounted while the previous copy's create was out shows the day
// the server stored; a background retry landing between a render and its effects leaves the form live; Discard drops
// the Say it words the entry was made from.
// Executes the real section, lib/use-autosave.ts, lib/autosave-retain.ts, lib/autosave.ts and AutosaveStatus with a
// tiny hook scheduler and a manual autosave clock. SYNTHETIC DATA ONLY: invented book, chapters and dates; the only
// "server" is the in-memory fetch below.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

// One copy of each shared module: loadTs has no module cache, and a second copy of lib/autosave.ts would give the
// section its own AutosaveRefused class (the scheduler's instanceof check would not recognise it).
const autosaveLib = loadTs("lib/autosave.ts");
const unsavedLib = loadTs("lib/unsaved-work.ts");
const retainLib = loadTs("lib/autosave-retain.ts", { "./autosave": autosaveLib, "./unsaved-work": unsavedLib });

const D1 = "2031-04-10";
const D2 = "2031-04-11";
const answer = (today = D1) => ({
  overview: {
    book: { slug: "synthetic-book", title: "A Synthetic Book", status: "reading" },
    today,
    totalChapters: 12,
    chaptersDone: 2,
    percent: 17,
    pace: { aheadBy: 0 },
    streak: { current: 1 },
    position: null,
    sessions: [],
  },
  books: [],
});
/** No book in progress any more (the current one was finished or set aside elsewhere); the list still has it. */
const noBookAnswer = () => ({
  overview: null,
  books: [{ slug: "synthetic-book", title: "A Synthetic Book", total_chapters: 12, status: "finished" }],
});
/** The same day with another current book (the first one finished, or a Kindle harvest moved on). */
const otherBookAnswer = (today = D1) => {
  const a = answer(today);
  a.overview.book = { slug: "another-synthetic-book", title: "Another Synthetic Book", status: "reading" };
  return a;
};

function manualTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    set: (fn, ms) => { const id = next++; pending.set(id, { at: now + ms, fn }); return id; },
    clear: (id) => { pending.delete(id); },
    due(ms) {
      const until = now + ms;
      const hit = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!hit) { now = until; return null; }
      pending.delete(hit[0]);
      const left = until - hit[1].at;
      now = hit[1].at;
      return { fn: hit[1].fn, left };
    },
    count: () => pending.size,
  };
}

// ---- a tiny renderer: function components, hooks, mount / unmount ----
const R = { frames: new Map(), frame: null, dirty: true, mounted: false, gen: 0 };
const equal = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const slot = () => [R.frame.slots, R.frame.index++];
let effects = [];
const hooks = {
  useId() { const [slots, i] = slot(); return slots[i] ??= `:synthetic${i}:`; },
  useState(initialValue) {
    const [slots, i] = slot();
    if (!(i in slots)) slots[i] = typeof initialValue === "function" ? initialValue() : initialValue;
    const gen = R.gen;
    return [slots[i], (value) => {
      if (gen !== R.gen || !R.mounted) return; // an unmounted copy: ignored, like React
      const next = typeof value === "function" ? value(slots[i]) : value;
      if (Object.is(next, slots[i])) return;
      slots[i] = next;
      R.dirty = true;
    }];
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
    if (!slots[i] || deps === undefined || !equal(slots[i].deps, deps)) {
      const old = slots[i];
      const cell = { deps, cleanup: undefined };
      slots[i] = cell;
      effects.push(() => { old?.cleanup?.(); cell.cleanup = effect(); });
    }
  },
};

function setup(t) {
  const timers = manualTimers();
  const work = new unsavedLib.UnsavedWork();
  const retainer = new retainLib.FormRetainer({ work, timers });
  let current = answer();
  const subscribers = new Set();
  const calls = [];
  const rows = new Map();
  /** "up", "offline", or "lost": the server stores the create, but its answer never arrives (a network failure). */
  let mode = "up";
  let readMode = "up";
  /** Reads of the reading overview through cachedJson (the mount's load, and the refetch after every save). */
  let reads = 0;
  /** While set, every save request waits for it (the request is in flight, as between a press and its click). */
  let hold = null;
  // The server's behavioral today (a create without a date is stored on it) and the clock's guess of the same day:
  // D1 until rollDay(), then D2 for every instant from then on.
  let serverToday = D1;
  let rollAt = Infinity;
  // This device's own clock (lib/checkin deviceBehavioralDay): null = it is on Eastern time and rolls with rollAt;
  // a number = it is in another zone and rolls on its own (travelling west: 06:00 local comes after 06:00 Eastern).
  let deviceRollAt = null;
  // The shared Say it draft store (lib/log-drafts.ts), reading section only: one draft or none.
  let draft = null;
  let draftSeq = 0;
  const clearDraft = (id) => {
    if (!draft || (id !== undefined && draft.id !== id)) return;
    draft = null;
    R.dirty = true;
  };
  // Run once between the next render and its effects (a background save landing before React's passive effects).
  let beforeEffects = null;
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });
  const replacements = {
    document: { visibilityState: "visible", activeElement: null, body: {}, addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: init.method, body });
      if (hold && (init.method === "POST" || init.method === "PATCH")) await hold.promise;
      if (mode === "offline") throw new TypeError("Failed to fetch");
      if (init.method === "POST" && url === "/api/reading/sessions") {
        const replayed = rows.has(body.client_key);
        if (!replayed) rows.set(body.client_key, { session_id: 500 + rows.size + 1, session_date: body.date ?? serverToday, ...body });
        if (mode === "lost") throw new TypeError("Failed to fetch");
        const row = rows.get(body.client_key);
        return reply({ session: row, replayed, xp_gained: replayed ? 0 : 10, finished: false, habit_created_on: row.session_date, overview: null });
      }
      if (init.method === "PATCH") return reply({ session: { session_id: Number(url.split("/").pop()) }, xp_gained: 0, finished: false, overview: null });
      if (init.method === "DELETE" && url.startsWith("/api/reading/sessions/")) return reply({ overview: null });
      throw new Error(`unexpected request ${init.method} ${url}`);
    },
  };
  for (const [name, value] of Object.entries(replacements)) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => (prior ? Object.defineProperty(globalThis, name, prior) : delete globalThis[name]));
  }
  const stubs = {
    react: hooks,
    "lucide-react": { Check: () => null },
    "@/components/FeedContext": { useInFeed: () => true },
    "@/lib/feed-scope": { useFeedScope: () => "/log" },
    "@/lib/autosave": autosaveLib,
    "@/lib/unsaved-work": { ...unsavedLib, unsavedWork: work },
    "@/lib/autosave-retain": { ...retainLib, formRetainer: retainer },
    "@/lib/checkin": {
      fallbackBehavioralToday: (d) => (d.getTime() >= rollAt ? D2 : D1),
      deviceBehavioralDay: (d) => (d.getTime() >= (deviceRollAt ?? rollAt) ? D2 : D1),
    },
    "@/lib/client-cache": {
      cachedJson: async () => {
        reads += 1;
        if (readMode === "offline") throw new TypeError("Failed to fetch");
        return structuredClone(current);
      },
      clientCache: {
        peek: () => structuredClone(current),
        read: async () => structuredClone(current),
        subscribe: (_url, fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
      },
    },
    "@/lib/format": { sameJson: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
    "@/lib/log-drafts": { useLogDrafts: () => ({ draft, clear: clearDraft }) },
    "@/lib/log-early": { LOG_READING_URL: "/api/reading", logEarlyGet: () => undefined },
  };
  const Section = loadTs("app/log/sections/Reading.tsx", stubs).default;

  let tree = null;
  function expand(node, id = "root") {
    if (node == null || typeof node === "boolean") return null;
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${id}/${child?.key ?? i}`));
    if (typeof node !== "object") return node;
    if (typeof node.type === "function") {
      const key = `${id}:${node.type.name}`;
      if (!R.frames.has(key)) R.frames.set(key, { slots: [], index: 0 });
      R.frame = R.frames.get(key);
      R.frame.index = 0;
      return expand(node.type(node.props), key);
    }
    return { type: node.type, props: { ...node.props, children: expand(node.props.children, id) } };
  }
  async function flush() {
    for (let i = 0; i < 16; i++) {
      if (R.dirty && R.mounted) {
        R.dirty = false;
        effects = [];
        tree = expand({ type: Section, props: {} });
        if (beforeEffects) {
          const between = beforeEffects;
          beforeEffects = null;
          await between();
        }
        for (const effect of effects) effect();
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  const nodes = (node = tree) => (Array.isArray(node) ? node.flatMap((n) => nodes(n)) : !node || typeof node !== "object" ? [] : [node, ...nodes(node.props.children)]);
  const text = (node = tree) => (Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props.children) : node == null ? "" : String(node));
  const field = (label) => {
    const holder = nodes().find((n) => n.type === "label" && text(n).startsWith(label));
    assert.ok(holder, `field exists: ${label}`);
    const input = nodes(holder).find((n) => n.type === "input" || n.type === "textarea");
    assert.ok(input, `input in ${label}`);
    return input;
  };
  const button = (label) => {
    const b = nodes().find((n) => n.type === "button" && text(n) === label);
    assert.ok(b, `button exists: ${label}`);
    return b;
  };
  /** The element focus moves to, as a blur event's relatedTarget: answers closest("[attr]") from its props. */
  const asTarget = (node) => ({
    closest: (selector) => {
      const m = /^\[([^\]=]+)\]$/.exec(selector);
      return m && node && m[1] in node.props ? {} : null;
    },
  });
  const formNode = () => {
    const form = nodes().find((n) => n.type === "form");
    assert.ok(form, "the session form is drawn");
    return form;
  };
  /** Focus leaves a field of the session form for `label`'s button (null = out of the form): the form's onBlur. */
  const blurTo = async (label) => {
    formNode().props.onBlur({ relatedTarget: label === null ? null : asTarget(button(label)) });
    await flush();
  };
  /** A click on `label`'s button, if it is still drawn and enabled, bubbling to the form (as a browser delivers it). */
  const clickIfEnabled = async (label) => {
    const b = nodes().find((n) => n.type === "button" && text(n) === label);
    if (b && !b.props.disabled) {
      await b.props.onClick();
      nodes().find((n) => n.type === "form")?.props.onClick?.();
    }
    await flush();
  };
  const h = {
    timers, work, retainer, calls, rows,
    get reads() { return reads; },
    set mode(m) { mode = m; },
    /** The overview read fails (offline): the section keeps what the cache showed it. */
    set readMode(m) { readMode = m; },
    set serverToday(d) { serverToday = d; },
    /** The behavioral day rolls now (06:00): the clock says D2 from here on; nothing is re-read. */
    async rollDay() {
      await new Promise((resolve) => setTimeout(resolve, 3));
      rollAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 3));
    },
    /** This device is in a zone west of Eastern (Pacific): from now on its clock rolls only on rollDeviceDay(). */
    awayFromEastern() {
      deviceRollAt = Infinity;
    },
    /** 06:00 on this device's own clock passes now (after awayFromEastern); nothing is re-read. */
    async rollDeviceDay() {
      await new Promise((resolve) => setTimeout(resolve, 3));
      deviceRollAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 3));
    },
    posts: () => calls.filter((c) => c.method === "POST"),
    text: () => text(),
    value: (label) => field(label).props.value,
    hasButton: (label) => nodes().some((n) => n.type === "button" && text(n) === label),
    button,
    type: async (label, value) => { field(label).props.onChange({ target: { value } }); await flush(); },
    click: async (label) => { await button(label).props.onClick(); await flush(); },
    blurTo,
    /**
     * A pointer press on a button while a field of the form has focus, in a browser's order: mousedown, whose default
     * action moves focus to the button (so the field blurs) unless it is prevented; then the click, which a browser
     * never delivers to a button that became disabled or left the page in between.
     */
    async press(label) {
      const b = button(label);
      b.props.onPointerDown?.({});
      const down = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      b.props.onMouseDown?.(down);
      if (!down.defaultPrevented) await blurTo(label);
      await clickIfEnabled(label);
    },
    /**
     * A tap on a touch screen while a field of the form has focus, in the worst order a phone browser uses: pointerdown
     * and touchstart, then the field blurs whatever mousedown did, with no relatedTarget (iOS Safari never focuses a
     * tapped button), then the click.
     */
    async tap(label) {
      const b = button(label);
      b.props.onPointerDown?.({});
      b.props.onTouchStart?.({});
      b.props.onMouseDown?.({ preventDefault() {} });
      await blurTo(null);
      await clickIfEnabled(label);
    },
    /** Hold every save request in flight until the returned release() is called. */
    holdSaves() {
      let release;
      hold = { promise: new Promise((resolve) => { release = resolve; }) };
      return async () => { const h0 = hold; hold = null; release(); await h0.promise; await flush(); };
    },
    async mount() { R.gen += 1; R.frames = new Map(); R.mounted = true; R.dirty = true; await flush(); },
    /** Mount, running `between` after the first render and before its effects (attach) run. */
    async mountThen(between) { beforeEffects = between; await h.mount(); },
    /**
     * Run every autosave timer due within `ms` WITHOUT rendering (as when a kept saver's own retry fires while a
     * render is waiting for its effects).
     */
    async runTimers(ms) {
      for (let left = ms; ;) {
        const hit = timers.due(left);
        if (!hit) break;
        left = hit.left;
        hit.fn();
        for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
      }
    },
    /** Riley's Say it words for this section (a ReadingLogDraft): written to the shared store. */
    async say(value) {
      draft = {
        section: "reading", id: ++draftSeq, at: 0, said: "synthetic words",
        value: { book: null, minutes: null, chapter_from: null, chapter_through: null, medium: null, recall: null, date: null, ...value },
      };
      R.dirty = true;
      await flush();
    },
    get draft() { return draft; },
    async unmount() {
      const cells = [...R.frames.values()].flatMap((f) => f.slots.filter((s) => s && typeof s === "object" && "cleanup" in s));
      R.mounted = false;
      R.gen += 1;
      for (const cell of cells) cell.cleanup?.();
      R.frames = new Map();
      tree = null;
      await flush();
    },
    /** Advance the autosave clock: run every timer due within `ms`, rendering after each. */
    async tick(ms) {
      for (let left = ms; ;) {
        const hit = timers.due(left);
        if (!hit) break;
        left = hit.left;
        hit.fn();
        await flush();
      }
      await flush();
    },
    /** The server's reading answer changes (a new behavioral day): every subscriber hears it. */
    async serve(next) { current = next; for (const fn of [...subscribers]) fn(structuredClone(next)); await flush(); },
  };
  return h;
}

test("opening the section sends nothing, also after a long wait", async (t) => {
  const h = setup(t);
  await h.mount();
  assert.match(h.text(), /A Synthetic Book/);
  await h.tick(120_000);
  assert.equal(h.calls.length, 0);
  assert.equal(h.work.has(), false, "an untouched form is not unsaved work");
  await h.unmount();
  assert.equal(h.retainer.size, 0, "nothing to keep");
});

test("an incomplete entry survives the section being unmounted and comes back as it was", async (t) => {
  const h = setup(t);
  await h.mount();
  await h.type("Minutes", "25");
  await h.type("Recall note", "Synthetic note, kept verbatim.");
  assert.match(h.text(), /Enter the chapter you read through to save\./, "the reason is shown next to the form");
  await h.unmount();
  assert.equal(h.calls.length, 0, "an incomplete entry is never sent");
  assert.equal(h.retainer.size, 1);
  assert.equal(h.work.has(), true, "still unsaved work: the updater never reloads over it");

  await h.mount();
  assert.equal(h.value("Minutes"), "25");
  assert.equal(h.value("Recall note"), "Synthetic note, kept verbatim.");
  assert.match(h.text(), /Enter the chapter you read through to save\./);
  assert.equal(h.calls.length, 0, "taking the entry over sends nothing");

  await h.type("Through ch.", "3");
  assert.match(h.text(), /Not saved yet/, "waiting for the pause: not shown as saving or saved");
  assert.doesNotMatch(h.text(), /Saved/);
  await h.tick(1500);
  assert.equal(h.posts().length, 1);
  const body = h.posts()[0].body;
  assert.equal(body.chapter_through, 3);
  assert.equal(body.minutes, 25);
  assert.equal(body.recall, "Synthetic note, kept verbatim.");
  assert.match(h.text(), /Saved · \+10 XP/);
  assert.match(h.text(), /This session/);
});

test("offline: a failed create keeps its client_key through an unmount, and Retry on the next mount creates it once", async (t) => {
  const h = setup(t);
  h.mode = "offline";
  await h.mount();
  await h.type("Through ch.", "3");
  await h.tick(1500);
  assert.match(h.text(), /Not saved: Couldn't reach Onyx\. Trying again…/);
  assert.ok(h.hasButton("Retry"), "a clear retry next to the form");
  await h.unmount(); // sends once more on the way out: still offline
  assert.equal(h.posts().length, 2);
  assert.equal(h.retainer.size, 1);
  assert.equal(h.work.has(), true);

  await h.mount();
  assert.equal(h.value("Through ch."), "3", "the entry is back");
  assert.match(h.text(), /Not saved: Couldn't reach Onyx\./, "and so is its failure");
  h.mode = "up";
  await h.click("Retry");
  assert.match(h.text(), /Saved · \+10 XP/, "confirmed only after the server answered");
  assert.match(h.text(), /This session/);
  const keys = new Set(h.posts().map((p) => p.body.client_key));
  assert.equal(keys.size, 1, "every attempt carried the same client_key");
  assert.ok([...keys][0], "a key was sent");
  assert.equal(h.rows.size, 1, "one session, never two");

  await h.type("Minutes", "40");
  await h.tick(1500);
  const last = h.calls[h.calls.length - 1];
  assert.equal(last.method, "PATCH", "later edits update the session the retry made");
  assert.match(last.url, /^\/api\/reading\/sessions\/\d+$/);
  await h.unmount();
  assert.equal(h.retainer.size, 0, "all saved: nothing kept");
  assert.equal(h.work.has(), false);
});

test("a retry that gets through while the section is away releases the entry; it comes back blank", async (t) => {
  const h = setup(t);
  h.mode = "offline";
  await h.mount();
  await h.type("Through ch.", "2");
  await h.tick(1500);
  await h.unmount();
  h.mode = "up";
  await h.tick(60_000); // the kept saver's own retry timer
  assert.equal(h.rows.size, 1, "created once, by the background retry");
  assert.equal(new Set(h.posts().map((p) => p.body.client_key)).size, 1);
  assert.equal(h.retainer.size, 0);
  assert.equal(h.work.has(), false);
  const before = h.calls.length;
  await h.mount();
  assert.equal(h.value("Through ch."), "", "a new, empty session form");
  assert.equal(h.calls.length, before, "nothing sent on mount");
});

test("day boundary: an entry made on one behavioral day and not saved keeps that day after the day rolls", async (t) => {
  const h = setup(t);
  await h.mount();
  await h.serve(answer(D2)); // nothing entered: the day just follows
  assert.match(h.text(), /For today/);
  assert.equal(h.calls.length, 0, "a new day alone sends nothing");

  await h.serve(answer(D1));
  h.mode = "offline";
  await h.type("Through ch.", "4");
  await h.tick(1500);
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].body.date, null, "on its own day the server's behavioral today applies");
  await h.unmount();
  await h.serve(answer(D2));
  h.mode = "up";
  await h.mount();
  assert.match(h.text(), /For Apr 10/, "the kept entry still says which day it is for");
  await h.tick(1500);
  const last = h.posts()[h.posts().length - 1];
  assert.equal(last.body.date, D1, "sent with its own day, not the new one");
  assert.equal(h.rows.size, 1);
});

test("day boundary: emptying an entry that kept its day lets the form follow today again", async (t) => {
  const h = setup(t);
  await h.mount();
  h.mode = "offline";
  await h.type("Through ch.", "4");
  await h.tick(1500);
  await h.serve(answer(D2)); // the day rolls while the failed entry is on screen
  assert.match(h.text(), /For Apr 10/);
  const sent = h.calls.length;
  await h.type("Through ch.", "");
  assert.match(h.text(), /For today/, "nothing left of the entry: the day follows again");
  assert.doesNotMatch(h.text(), /Not saved/);
  assert.equal(h.work.has(), false, "an emptied form is not unsaved work");
  await h.tick(60_000);
  assert.equal(h.calls.length, sent, "and nothing more is sent");
});

test("day boundary without a remount: a failed create keeps its day on every later send, mounted or away", async (t) => {
  const h = setup(t);
  h.mode = "offline";
  await h.mount();
  await h.type("Through ch.", "5");
  await h.tick(1500);
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].body.date, null, "the first send lets the server's behavioral today apply");
  await h.unmount(); // sends once more on the way out: still offline
  await h.serve(answer(D2)); // the day rolls while the Log page is away; nothing re-reads it for the kept form
  h.mode = "up";
  await h.tick(60_000); // the kept saver's own retry timer, with no copy mounted
  assert.equal(h.rows.size, 1, "created once, by the background retry");
  const later = h.posts().slice(1);
  assert.ok(later.length >= 2, "the unmount send and the retry");
  assert.ok(later.every((p) => p.body.date === D1), "every later send carries the day the entry was made for");
  assert.equal(new Set(h.posts().map((p) => p.body.client_key)).size, 1);
  assert.equal(h.retainer.size, 0);
});

test("day boundary while mounted: a background retry keeps the entry's day before the overview is read again", async (t) => {
  const h = setup(t);
  h.mode = "offline";
  await h.mount();
  await h.type("Through ch.", "6");
  await h.tick(1500);
  h.mode = "up";
  await h.tick(60_000);
  const sent = h.posts();
  assert.equal(sent[0].body.date, null);
  assert.equal(sent[sent.length - 1].body.date, D1, "the retry is sent for the day of the first send");
  assert.equal(h.rows.size, 1);
});

test("a restored entry and the session it made keep their book when the current book changes", async (t) => {
  const h = setup(t);
  await h.mount();
  await h.type("Minutes", "20"); // incomplete: no chapter yet
  await h.unmount();
  await h.serve(otherBookAnswer()); // the current book changed while the section was away
  await h.mount();
  assert.equal(h.value("Minutes"), "20", "the entry is back");
  assert.match(h.text(), /Book: synthetic-book/, "and says which book it is for");
  await h.type("Through ch.", "3");
  await h.tick(1500);
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].body.book, "synthetic-book", "created for its own book, not the new current one");

  await h.type("Minutes", "35");
  await h.tick(1500);
  const last = h.calls[h.calls.length - 1];
  assert.equal(last.method, "PATCH");
  assert.equal(last.body.book, "synthetic-book", "a later edit never moves the session to another book");
});

test("day boundary with no new answer: an entry started before the day rolls and finished after is created for its own day", async (t) => {
  const h = setup(t);
  await h.mount();
  await h.type("Minutes", "25"); // started on D1: incomplete, nothing sent
  assert.equal(h.calls.length, 0);
  await h.rollDay(); // 06:00 passes; the overview is not read again
  h.serverToday = D2;
  await h.type("Through ch.", "3");
  await h.tick(1500);
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].body.date, D1, "sent for the day it was started on, which the form still shows");
  assert.equal(h.value("Day"), D1);
  const row = [...h.rows.values()][0];
  assert.equal(row.session_date, D1, "never the new day");
});

test("an entry started on its own day, before the roll, still lets the server's today apply when sent the same day", async (t) => {
  const h = setup(t);
  await h.mount();
  await h.type("Minutes", "25");
  await h.type("Through ch.", "3");
  await h.tick(1500);
  assert.equal(h.posts()[0].body.date, null);
  assert.equal([...h.rows.values()][0].session_date, D1);
});

test("travelling west: an entry started before 06:00 local and sent after is created for its own day, though 06:00 Eastern passed earlier", async (t) => {
  // Riley is on Pacific time. 06:00 Eastern (03:00 local) has passed, so the Eastern clock already says D2, but the
  // server, which follows where Riley is, still says D1 and confirms it. The entry is started then and sent after
  // 06:00 local, with no new answer in between: an Eastern-only rollover check saw no roll and sent no day.
  const h = setup(t);
  h.awayFromEastern();
  await h.rollDay(); // 06:00 Eastern
  await h.mount(); // the overview is read: D1, confirmed after 06:00 Eastern
  await h.type("Minutes", "25"); // started on D1, local time
  assert.equal(h.calls.length, 0);
  await h.rollDeviceDay(); // 06:00 local passes; the overview is not read again
  h.serverToday = D2;
  await h.type("Through ch.", "3");
  await h.tick(1500);
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].body.date, D1, "sent for the day it was started on: the server's own today has moved on");
  assert.equal([...h.rows.values()][0].session_date, D1, "never the next day");
  assert.equal(h.value("Day"), D1);
});

test("travelling west: an entry started after 06:00 local, on a screen last read before it, leaves the day to the server", async (t) => {
  // The other side of the same clock: the day on screen (D1) is stale by the time the entry is started, so it is not
  // pinned to the entry; the server's behavioral today applies and the form then shows the stored day.
  const h = setup(t);
  h.awayFromEastern();
  await h.rollDay(); // 06:00 Eastern
  await h.mount(); // confirmed D1
  await h.rollDeviceDay(); // 06:00 local passes before anything is entered; nothing is re-read
  h.serverToday = D2;
  await h.type("Minutes", "25");
  await h.type("Through ch.", "3");
  await h.tick(1500);
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].body.date, null, "the day on screen is stale: the server's behavioral today applies");
  assert.equal([...h.rows.values()][0].session_date, D2);
  assert.equal(h.value("Day"), D2, "and the form shows the day the session was stored on");
});

test("travelling west, overview unreadable: a cached day that is this device's day is kept when the entry is sent after 06:00 local", async (t) => {
  // No answer confirms the day (the read fails); the cached D1 is the day on this device's clock, though not on the
  // Eastern one, so the entry keeps it and carries it once 06:00 local has passed.
  const h = setup(t);
  h.awayFromEastern();
  await h.rollDay(); // 06:00 Eastern
  h.readMode = "offline";
  await h.mount();
  await h.type("Minutes", "25");
  await h.rollDeviceDay();
  h.serverToday = D2;
  await h.type("Through ch.", "3");
  await h.tick(1500);
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].body.date, D1);
  assert.equal([...h.rows.values()][0].session_date, D1);
});

test("a stale day on screen (cached answer, read failing, clock already on the next day): the server decides and the form shows that day", async (t) => {
  const h = setup(t);
  await h.rollDay(); // the clock is on D2 before the section opens; the cache still says D1
  h.serverToday = D2;
  h.readMode = "offline";
  await h.mount();
  assert.match(h.text(), /A Synthetic Book/, "drawn from the cached answer");
  await h.type("Through ch.", "4");
  await h.tick(1500);
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].body.date, null, "the day on screen could be stale: the server's behavioral today applies");
  assert.equal([...h.rows.values()][0].session_date, D2);
  assert.equal(h.value("Day"), D2, "the form then shows the day the session was stored on");
  assert.match(h.text(), /For Apr 11/);
  await h.type("Minutes", "30");
  await h.tick(1500);
  const last = h.calls[h.calls.length - 1];
  assert.equal(last.method, "PATCH");
  assert.equal(last.body.date, null, "an edit keeps the session's own day");
});

test("no book in progress any more: a kept incomplete entry stays on screen with its fields and reason, and saves for its book", async (t) => {
  const h = setup(t);
  await h.mount();
  await h.type("Minutes", "20");
  await h.unmount();
  await h.serve(noBookAnswer()); // the book was finished elsewhere while the section was away
  await h.mount();
  assert.match(h.text(), /No book in progress\./);
  assert.equal(h.value("Minutes"), "20", "the entry is still reachable");
  assert.match(h.text(), /Book: A Synthetic Book/, "named from the book list");
  assert.match(h.text(), /Enter the chapter you read through to save\./);
  assert.equal(h.calls.length, 0, "showing it sends nothing");
  await h.type("Through ch.", "12");
  await h.tick(1500);
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].body.book, "synthetic-book");
  assert.match(h.text(), /Saved · \+10 XP/);
  assert.match(h.text(), /This session/);
  await h.click("New session");
  assert.match(h.text(), /No book in progress\./);
  assert.equal(h.hasButton("New session"), false, "nothing left: the empty form is not drawn without a book");
});

test("no book in progress any more: a failed create keeps its Retry, and Discard drops the entry", async (t) => {
  const h = setup(t);
  h.mode = "offline";
  await h.mount();
  await h.type("Through ch.", "5");
  await h.tick(1500);
  await h.unmount();
  await h.serve(noBookAnswer());
  await h.mount();
  assert.match(h.text(), /Not saved: Couldn't reach Onyx\./);
  assert.ok(h.hasButton("Retry"), "Retry is still offered");
  assert.equal(h.value("Through ch."), "5");
  await h.click("Discard this entry");
  assert.match(h.text(), /No book in progress\./);
  assert.equal(h.hasButton("Retry"), false);
  assert.equal(h.work.has(), false, "a discarded entry is not unsaved work");
  const sent = h.calls.length;
  await h.tick(60_000);
  assert.equal(h.calls.length, sent, "and nothing more is sent");
  await h.unmount();
  assert.equal(h.retainer.size, 0);
});

test("no book in progress and nothing kept: only the line, no form", async (t) => {
  const h = setup(t);
  await h.serve(noBookAnswer());
  await h.mount();
  assert.match(h.text(), /No book in progress\./);
  assert.equal(h.hasButton("Audio"), false);
  assert.equal(h.calls.length, 0);
});

/** No book in progress any more, and a kept entry that is complete and waiting for its pause (would be saved on blur). */
async function keptCompleteEntryWithoutBook(h) {
  await h.mount();
  await h.type("Minutes", "20");
  await h.unmount();
  await h.serve(noBookAnswer());
  await h.mount();
  await h.type("Through ch.", "5"); // the field keeps focus; the entry is complete now
  assert.match(h.text(), /Not saved yet/);
  assert.ok(h.hasButton("Discard this entry"));
  assert.equal(h.calls.length, 0);
}

test("Discard pressed while a field has focus drops the entry: the field's blur never saves it first", async (t) => {
  const h = setup(t);
  await keptCompleteEntryWithoutBook(h);
  await h.press("Discard this entry");
  assert.equal(h.posts().length, 0, "nothing was created on the way to the button");
  assert.equal(h.rows.size, 0);
  assert.match(h.text(), /No book in progress\./, "the click landed: the entry is gone");
  assert.equal(h.hasButton("Audio"), false, "no form without a book once nothing is kept");
  assert.equal(h.work.has(), false, "a discarded entry is not unsaved work");
  await h.tick(60_000);
  assert.equal(h.calls.length, 0, "and nothing is sent later (its pause timer went with it)");
  await h.unmount();
  assert.equal(h.retainer.size, 0);
});

test("Discard reached with the keyboard: Tab to it does not save, Enter discards, nothing is sent", async (t) => {
  const h = setup(t);
  await keptCompleteEntryWithoutBook(h);
  await h.blurTo("Discard this entry"); // Tab from the field to the button
  assert.equal(h.calls.length, 0, "moving focus to Discard is not a reason to save");
  await h.click("Discard this entry");
  assert.equal(h.calls.length, 0);
  assert.match(h.text(), /No book in progress\./);
  assert.equal(h.work.has(), false);
});

test("leaving the form from a field still saves at once; Remove pressed with an edit waiting deletes without sending it", async (t) => {
  const h = setup(t);
  await h.mount();
  await h.type("Through ch.", "3");
  await h.blurTo(null); // focus leaves the form
  assert.equal(h.posts().length, 1, "blur out of the form saves without waiting for the pause");
  assert.match(h.text(), /This session/);

  await h.type("Minutes", "40"); // an edit of that session, waiting; the field keeps focus
  const before = h.calls.length;
  await h.press("Remove this session");
  const after = h.calls.slice(before);
  assert.deepEqual(after.map((c) => c.method), ["DELETE"], "the waiting edit belongs to the removed session: never sent");
  assert.match(h.text(), /Audio or paper session/, "the removal landed: a new, empty form");
  assert.equal(h.value("Through ch."), "");
});

test("New session pressed while a field has focus and a save would be in flight: the click lands, the edit is saved once, then a new form", async (t) => {
  const h = setup(t);
  await h.mount();
  await h.type("Through ch.", "3");
  await h.tick(1500);
  assert.match(h.text(), /This session/);
  await h.type("Minutes", "40");
  const before = h.calls.length;
  const release = h.holdSaves(); // the request stays in flight, as it would between the press and the click
  await h.press("New session");
  await release();
  const after = h.calls.slice(before);
  assert.deepEqual(after.map((c) => c.method), ["PATCH"], "the waiting edit is sent once");
  assert.equal(after[0].body.minutes, 40);
  assert.match(h.text(), /Audio or paper session/, "and the click was not lost to a disabled button");
  assert.equal(h.value("Minutes"), "");
});

test("Discard tapped on a touch screen: the field blurs with no target, the press is remembered, nothing is saved", async (t) => {
  const h = setup(t);
  await keptCompleteEntryWithoutBook(h);
  await h.tap("Discard this entry");
  assert.equal(h.posts().length, 0, "the blur the tap caused did not create the session");
  assert.equal(h.rows.size, 0);
  assert.match(h.text(), /No book in progress\./, "the click landed: the entry is gone");
  assert.equal(h.work.has(), false);
  await h.tick(60_000);
  assert.equal(h.calls.length, 0, "and nothing is sent later");
});

test("a press does not linger: after Remove (mouse, then touch), leaving the form saves the next entry at once", async (t) => {
  const h = setup(t);
  await h.mount();
  await h.type("Through ch.", "3");
  await h.tick(1500);
  assert.equal(h.posts().length, 1);
  await h.press("Remove this session"); // mouse: no blur at all, the click clears the press
  assert.match(h.text(), /Audio or paper session/);

  await h.type("Through ch.", "4");
  await h.blurTo(null);
  assert.equal(h.posts().length, 2, "a later blur out of the form saves without waiting for the pause");

  await h.tap("Remove this session"); // touch: the blur it causes is skipped and uses the press up
  assert.deepEqual(h.calls.slice(-1).map((c) => c.method), ["DELETE"]);
  await h.type("Through ch.", "5");
  await h.blurTo(null);
  assert.equal(h.posts().length, 3, "and so does the next one after a tap");
});

test("session end during a background retry whose create had landed: the replayed answer sends no PATCH and reads nothing", async (t) => {
  const h = setup(t);
  await h.mount();
  await h.type("Through ch.", "3");
  h.mode = "lost"; // the server stores the session; the answer never arrives
  await h.tick(1500);
  assert.equal(h.rows.size, 1, "stored on the server");
  assert.match(h.text(), /Not saved: Couldn't reach Onyx\./);
  await h.unmount(); // sends once more on the way out; that answer is lost too
  assert.equal(h.retainer.size, 1, "kept, retrying on its own");

  h.mode = "up";
  const release = h.holdSaves();
  await h.tick(60_000); // the kept saver's retry goes out and is held in flight
  const before = h.calls.length;
  assert.equal(h.calls[before - 1].method, "POST", "the retry of the create is out");
  const reads = h.reads;
  h.retainer.clear(); // the session ends (wipeClientData fires CLIENT_WIPE_EVENT) while it is out
  await release(); // its answer arrives: the row already existed (replayed)
  assert.deepEqual(h.calls.slice(before).map((c) => c.method), [], "no PATCH writes the old session's values after the session ended");
  assert.equal(h.reads, reads, "and nothing is read back into the wiped cache");
  assert.equal(h.retainer.size, 0);
  assert.equal(h.work.has(), false, "no unsaved work is left registered");
  assert.equal(h.timers.count(), 0, "no retry is waiting");
  await h.tick(120_000);
  assert.equal(h.calls.length, before, "nothing more is ever sent");
  assert.equal(h.rows.size, 1, "one row on the server, from before the session ended");

  await h.mount();
  assert.equal(h.value("Through ch."), "", "the next session starts with an empty form");
  assert.equal(h.calls.length, before, "and opening it sends nothing");
});

test("remounted while the previous copy's create is out: the day the server stored is shown by the new copy", async (t) => {
  const h = setup(t);
  await h.rollDay(); // the clock is on D2 before the section opens; the cache still says D1
  h.serverToday = D2;
  h.readMode = "offline";
  await h.mount();
  await h.type("Through ch.", "4");
  const release = h.holdSaves();
  await h.tick(1500); // the create is out (the day on screen could be stale: the server decides)
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].body.date, null);
  await h.unmount(); // its send is still pending
  await h.mount(); // a new copy takes the entry over before the answer arrives
  assert.equal(h.value("Day"), D1, "until the answer, the day on screen");
  await release();
  assert.equal([...h.rows.values()][0].session_date, D2);
  assert.match(h.text(), /This session/, "the new copy shows the session the old copy's create made");
  assert.equal(h.value("Day"), D2, "and the day it was stored on");
  assert.match(h.text(), /For Apr 11/);
  assert.equal(h.posts().length, 1, "created once");
});

test("a background retry that gets through after the section rendered and before its effects ran: later edits are still saved", async (t) => {
  const h = setup(t);
  h.mode = "offline";
  await h.mount();
  await h.type("Through ch.", "2");
  await h.tick(1500);
  await h.unmount(); // kept, with its retry timer set
  assert.equal(h.retainer.size, 1);
  h.mode = "up";
  // The next copy renders (it finds the kept entry); the retry lands before its effects attach it.
  await h.mountThen(() => h.runTimers(60_000));
  assert.equal(h.rows.size, 1, "created once, by the background retry");
  assert.equal(new Set(h.posts().map((p) => p.body.client_key)).size, 1, "every attempt carried the same client_key");
  assert.match(h.text(), /This session/, "the new copy shows the session the retry made");
  assert.match(h.text(), /Saved · \+10 XP/);
  assert.equal(h.work.has(), false, "nothing unsaved");

  const before = h.calls.length;
  await h.type("Minutes", "40");
  await h.tick(1500);
  const after = h.calls.slice(before);
  assert.deepEqual(after.map((c) => c.method), ["PATCH"], "the edit updates that session: not dropped by a disposed saver");
  assert.match(after[0].url, /^\/api\/reading\/sessions\/\d+$/);
  assert.equal(after[0].body.minutes, 40);
  assert.match(h.text(), /Saved/);
  await h.unmount();
  assert.equal(h.retainer.size, 0, "all saved: nothing kept");
});

test("Discard drops the Say it words the entry was made from: the next mount neither applies them again nor saves them", async (t) => {
  const h = setup(t);
  h.mode = "offline";
  await h.mount();
  await h.say({ chapter_through: 5, minutes: 20 });
  assert.equal(h.value("Through ch."), "5", "the words filled the form");
  await h.tick(1500); // the create fails offline
  assert.match(h.text(), /Not saved: Couldn't reach Onyx\./);
  await h.unmount();
  await h.serve(noBookAnswer()); // the book was finished elsewhere meanwhile
  await h.mount();
  assert.equal(h.value("Through ch."), "5", "the kept entry is still reachable");
  await h.click("Discard this entry");
  assert.match(h.text(), /No book in progress\./);
  assert.equal(h.draft, null, "its words left the draft store with it");
  assert.equal(h.work.has(), false);

  h.mode = "up";
  await h.serve(answer()); // a book in progress again
  await h.unmount();
  await h.mount();
  assert.equal(h.value("Through ch."), "", "a blank form: the discarded words are not applied again");
  assert.equal(h.value("Minutes"), "");
  const posts = h.posts().length;
  await h.tick(60_000);
  assert.equal(h.posts().length, posts, "and nothing is saved");
  assert.equal(h.rows.size, 0);
});

test("a touch on Discard that turns into a scroll is no press: the next blur out of the form saves at once", async (t) => {
  const h = setup(t);
  await keptCompleteEntryWithoutBook(h);
  const b = h.button("Discard this entry");
  b.props.onPointerDown?.({});
  b.props.onTouchStart?.({});
  b.props.onTouchCancel?.({}); // the browser took the touch over for scrolling: no click follows
  b.props.onPointerCancel?.({});
  await h.blurTo(null); // later, focus leaves the form
  assert.equal(h.posts().length, 1, "saved at once, not skipped as if Discard had been pressed");
  assert.equal(h.posts()[0].body.chapter_through, 5);
});
