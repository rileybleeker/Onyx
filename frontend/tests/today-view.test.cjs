// Run: node --test tests/today-view.test.cjs
// Today's quiet view settings (src/lib/today-view.ts, PROD-T05): off by default; stored under the UI preference
// today.quiet only after Riley's own change (opening Today only reads it); a newer copy from another device
// applies on the next mount, never mid-visit; a failed send stays on this device; the pre-paint script; the
// device-only snooze / hide marks; and row widths that fill whole desktop rows. SYNTHETIC DATA ONLY.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

// A fresh module per test: the settings live in module state, as in one page load.
const fresh = () => loadTs("lib/today-view.ts");
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}
function withWindow(t, storage) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const before = globalThis.window;
  globalThis.window = storage === "throws"
    ? Object.defineProperty({}, "localStorage", { get() { throw new Error("SecurityError"); } })
    : { localStorage: storage };
  t.after(() => { if (had) globalThis.window = before; else delete globalThis.window; });
}
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function recorder(handler) {
  const calls = [];
  const fn = async (url, init = {}) => { calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null }); return handler(url, init, calls.length); };
  fn.calls = calls;
  return fn;
}
const putOk = recorder((url, init) => answer(200, { key: JSON.parse(init.body).key, value: JSON.parse(init.body).value, updatedAt: "2030-03-05T12:00:00.000Z" }));

test("source: import-free, its own UI preference key, the same URL as lib/ui-preferences.ts", () => {
  const src = fs.readFileSync(path.join(SRC, "lib", "today-view.ts"), "utf8");
  for (const line of src.split(/\r?\n/)) if (/^\s*import\s/.test(line)) assert.match(line, /^\s*import type\s/, line);
  const V = fresh();
  const P = loadTs("lib/ui-preferences.ts");
  assert.equal(V.QUIET_PREF_URL, P.uiPrefUrl(V.QUIET_PREF_KEY));
  assert.equal(V.QUIET_PUT_URL, P.UI_PREFS_PATH);
  assert.ok(P.isUiPrefKey(V.QUIET_PREF_KEY) && V.QUIET_PREF_KEY.length <= 40);
  assert.ok(V.QUIET_PREF_KEY !== "layout.today" && !V.QUIET_PREF_KEY.startsWith("layout."), "not a Personalize layout key");
  assert.ok(P.parsePrefBody({ key: V.QUIET_PREF_KEY, value: V.quietValue(V.DEFAULT_QUIET) }).ok, "the route accepts the stored value");
  assert.ok(V.QUIET_DEVICE_KEY.startsWith("onyx.") && V.MARKS_DEVICE_KEY.startsWith("onyx."), "wiped with every onyx* key on sign-out");
});

test("settings: off by default; stored values are checked and clamped", (t) => {
  withWindow(t, memoryStorage());
  const V = fresh();
  assert.deepEqual(V.readQuiet(), { on: false, budget: 3, learning: true });
  assert.equal(V.serverQuiet().on, false, "the server render is the full page");
  assert.deepEqual(V.parseQuietSettings({ v: 1, on: true, budget: 9, learning: false }), { on: true, budget: 5, learning: false });
  assert.deepEqual(V.parseQuietSettings({ v: 1, on: true, budget: 0 }), { on: true, budget: 1, learning: true });
  for (const bad of [null, [], "on", { on: true }, { v: 2, on: true }, { v: 1, on: "yes" }]) assert.equal(V.parseQuietSettings(bad), null, JSON.stringify(bad));
});

test("change: shown at once, kept on this device, sent once as {key, value}", async (t) => {
  const store = memoryStorage();
  withWindow(t, store);
  const V = fresh();
  let renders = 0;
  V.subscribeQuiet(() => { renders++; });
  const fetchImpl = recorder((url, init) => answer(200, { key: "today.quiet", value: JSON.parse(init.body).value, updatedAt: "2030-03-05T12:00:00.000Z" }));
  const saving = V.setQuiet({ on: true, budget: 2, learning: false }, fetchImpl);
  assert.equal(V.readQuiet().on, true, "applies before the request answers");
  assert.equal(renders, 1);
  assert.equal(await saving, true);
  assert.deepEqual(fetchImpl.calls, [{ url: "/api/ui/preferences", method: "PUT", body: { key: "today.quiet", value: { v: 1, on: true, budget: 2, learning: false } } }]);
  const rec = JSON.parse(store.getItem(V.QUIET_DEVICE_KEY));
  assert.equal(rec.dirty, false);
  assert.equal(rec.updatedAt, "2030-03-05T12:00:00.000Z");
  assert.equal(V.quietUnsent(), false);
});

test("failure + retry: a failed send stays on this device (dirty) and Retry sends it", async (t) => {
  const store = memoryStorage();
  withWindow(t, store);
  const V = fresh();
  const failing = recorder(() => answer(500, { error: "x" }));
  assert.equal(await V.setQuiet({ on: true, budget: 3, learning: true }, failing), false);
  assert.equal(V.readQuiet().on, true, "the change still applies here");
  assert.equal(V.quietUnsent(), true);
  const offline = recorder(() => { throw new TypeError("network down"); });
  assert.equal(await V.pushQuiet(offline), false, "a network error is a failure, not a throw");
  assert.equal(V.quietUnsent(), true);
  const ok = recorder((url, init) => answer(200, { key: "today.quiet", value: JSON.parse(init.body).value, updatedAt: "2030-03-05T12:00:00.000Z" }));
  assert.equal(await V.pushQuiet(ok), true);
  assert.equal(V.quietUnsent(), false);
  assert.equal(ok.calls.length, 1);
  assert.equal(await V.pushQuiet(ok), true, "nothing dirty: nothing sent");
  assert.equal(ok.calls.length, 1);
  const wrongKey = recorder(() => answer(200, { key: "other", value: {} }));
  assert.equal(await V.setQuiet({ on: false, budget: 3, learning: true }, wrongKey), false, "an answer for another key is not a save");
  assert.equal(V.quietUnsent(), true);
});

test("two quick changes: one request at a time, the newest value is the last one sent", async (t) => {
  withWindow(t, memoryStorage());
  const V = fresh();
  const gates = [];
  const fetchImpl = recorder((url, init) => new Promise((resolve) => gates.push(() => resolve(answer(200, { key: "today.quiet", value: JSON.parse(init.body).value, updatedAt: new Date().toISOString() })))));
  const first = V.setQuiet({ on: true, budget: 3, learning: true }, fetchImpl);
  const second = V.setQuiet({ on: true, budget: 1, learning: true }, fetchImpl);
  await new Promise((r) => setImmediate(r));
  assert.equal(fetchImpl.calls.length, 1, "the second waits for the first");
  gates.shift()();
  for (let i = 0; i < 20 && fetchImpl.calls.length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.equal(fetchImpl.calls.length, 2);
  gates.shift()();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(fetchImpl.calls.map((c) => c.body.value.budget), [3, 1]);
  assert.equal(V.quietUnsent(), false);
  assert.equal(V.readQuiet().budget, 1);
});

test("sync: GET only, at most every 15 minutes; a newer server copy applies on the next mount, never mid-visit", async (t) => {
  const store = memoryStorage();
  withWindow(t, store);
  const V = fresh();
  const NOW = Date.parse("2030-03-05T12:00:00Z");
  assert.equal(V.readQuiet().on, false);
  const server = recorder(() => answer(200, { key: "today.quiet", value: { v: 1, on: true, budget: 4, learning: true }, updatedAt: "2030-03-05T11:00:00.000Z" }));
  assert.equal(await V.syncQuiet(server, NOW), "adopted");
  assert.deepEqual(server.calls.map((c) => [c.url, c.method]), [["/api/ui/preferences?key=today.quiet", "GET"]], "reading the setting writes nothing");
  assert.equal(V.readQuiet().on, false, "not mid-visit");
  V.adoptQuiet();
  assert.deepEqual(V.readQuiet(), { on: true, budget: 4, learning: true }, "applied as Today opens");
  assert.equal(await V.syncQuiet(server, NOW + 60_000), "skipped");
  assert.equal(server.calls.length, 1);
  assert.equal(await V.syncQuiet(server, NOW + V.QUIET_SYNC_EVERY_MS + 1), "same");
  const failing = recorder(() => answer(500, {}));
  assert.equal(await V.syncQuiet(failing, NOW + 3 * V.QUIET_SYNC_EVERY_MS), "failed");
  assert.deepEqual(V.readQuiet(), { on: true, budget: 4, learning: true }, "a failed read changes nothing");
});

test("sync: a newer change made here that was not sent yet wins over an older server copy", async (t) => {
  withWindow(t, memoryStorage());
  const V = fresh();
  await V.setQuiet({ on: true, budget: 2, learning: true }, recorder(() => answer(500, {})));
  const older = recorder(() => answer(200, { key: "today.quiet", value: { v: 1, on: false, budget: 3, learning: true }, updatedAt: "2000-01-01T00:00:00.000Z" }));
  assert.equal(await V.syncQuiet(older, Date.now()), "kept");
  V.adoptQuiet();
  assert.deepEqual(V.readQuiet(), { on: true, budget: 2, learning: true });
  assert.equal(V.quietUnsent(), true, "still waiting for Retry or the next change");
});

test("sync: nothing stored yet keeps this device's choice and remembers when it checked", async (t) => {
  withWindow(t, memoryStorage());
  const V = fresh();
  const none = recorder(() => answer(200, { key: "today.quiet", value: null, updatedAt: null }));
  assert.equal(await V.syncQuiet(none, 1_000_000), "same");
  assert.equal(await V.syncQuiet(none, 1_000_000 + 60_000), "skipped", "one GET per 15 minutes, also when nothing is stored");
  assert.equal(none.calls.length, 1);
  assert.equal(V.readQuiet().on, false);
});

test("storage off: the change still applies on screen and is still sent", async (t) => {
  withWindow(t, "throws");
  const V = fresh();
  assert.equal(V.readQuiet().on, false);
  const ok = recorder((url, init) => answer(200, { key: "today.quiet", value: JSON.parse(init.body).value, updatedAt: "2030-03-05T12:00:00.000Z" }));
  assert.equal(await V.setQuiet({ on: true, budget: 3, learning: true }, ok), true);
  assert.equal(V.readQuiet().on, true);
  assert.equal(ok.calls.length, 1);
  assert.equal(V.writeMarks({ a: { v: "x", hidden: true, at: 1 } }), false, "marks say when they could not be kept");
  assert.deepEqual(V.readMarks(() => ({ never: true }), (m) => m), {});
});

test("storage readable but full: the newer change in this page load wins over the older stored copy and is sent", async (t) => {
  const store = memoryStorage({ "onyx.today.quiet": JSON.stringify({ settings: { v: 1, on: false, budget: 3, learning: true }, savedAt: 1, updatedAt: "2030-03-05T10:00:00.000Z", dirty: false, checkedAt: 1 }) });
  store.setItem = () => { throw new Error("QuotaExceededError"); };
  withWindow(t, store);
  const V = fresh();
  assert.equal(V.readQuiet().on, false, "the stored copy is read");
  assert.equal(await V.setQuiet({ on: true, budget: 2, learning: true }, recorder(() => answer(500, {}))), false);
  assert.equal(V.readQuiet().on, true);
  assert.equal(V.quietUnsent(), true, "the failed send is still waiting, not lost behind the older stored copy");
  const ok = recorder((url, init) => answer(200, { key: "today.quiet", value: JSON.parse(init.body).value, updatedAt: "2030-03-05T12:00:00.000Z" }));
  assert.equal(await V.pushQuiet(ok), true);
  assert.deepEqual(ok.calls.map((c) => c.body.value), [{ v: 1, on: true, budget: 2, learning: true }], "Retry sends the new value");
  assert.equal(V.quietUnsent(), false);
});

test("sync: a GET that was out while Riley changed a setting never replaces it (nor does an older answer)", async (t) => {
  const store = memoryStorage();
  withWindow(t, store);
  const V = fresh();
  let release;
  const slow = recorder(() => new Promise((resolve) => { release = () => resolve(answer(200, { key: "today.quiet", value: { v: 1, on: false, budget: 3, learning: true }, updatedAt: "2030-03-05T11:00:00.000Z" })); }));
  const reading = V.syncQuiet(slow, Date.parse("2030-03-05T12:00:00Z"));
  await new Promise((r) => setImmediate(r));
  assert.equal(slow.calls.length, 1);
  const put = recorder((url, init) => answer(200, { key: "today.quiet", value: JSON.parse(init.body).value, updatedAt: "2030-03-05T12:00:01.000Z" }));
  assert.equal(await V.setQuiet({ on: true, budget: 4, learning: true }, put), true, "saved while the GET is out");
  release();
  assert.equal(await reading, "kept", "the older answer is not adopted");
  V.adoptQuiet();
  assert.deepEqual(V.readQuiet(), { on: true, budget: 4, learning: true });
  assert.equal(JSON.parse(store.getItem(V.QUIET_DEVICE_KEY)).settings.on, true, "the next visit keeps the saved choice");
  // A clean copy stored by a save is newer than a cached or delayed answer: kept as well.
  const older = recorder(() => answer(200, { key: "today.quiet", value: { v: 1, on: false, budget: 3, learning: true }, updatedAt: "2030-03-05T11:30:00.000Z" }));
  assert.equal(await V.syncQuiet(older, Date.parse("2030-03-05T13:00:00Z")), "kept");
  assert.equal(JSON.parse(store.getItem(V.QUIET_DEVICE_KEY)).settings.on, true);
});

test("pre-paint script: hides the full page only when this device says on; never throws", () => {
  const V = fresh();
  const run = (stored) => {
    const appended = [];
    const ctx = {
      localStorage: { getItem: () => stored },
      document: { getElementById: (id) => appended.find((e) => e.id === id) ?? null, createElement: () => ({}), head: { appendChild: (e) => appended.push(e) } },
      JSON,
    };
    vm.runInNewContext(V.quietBootScript(), ctx);
    vm.runInNewContext(V.quietBootScript(), ctx);
    return appended;
  };
  const on = run(JSON.stringify({ settings: { v: 1, on: true, budget: 3, learning: true }, savedAt: 1, updatedAt: null, dirty: false, checkedAt: 1 }));
  assert.equal(on.length, 1, "added once");
  assert.equal(on[0].id, V.QUIET_BOOT_ID);
  assert.match(on[0].textContent, /\[data-today-full\]\{display:none!important\}/);
  assert.match(on[0].textContent, /\[data-today-quiet\]\{display:block!important\}/);
  assert.equal(run(JSON.stringify({ settings: { v: 1, on: false, budget: 3, learning: true } })).length, 0);
  assert.equal(run(null).length, 0);
  assert.equal(run("{not json").length, 0, "junk is ignored");
  assert.doesNotThrow(() => vm.runInNewContext(V.quietBootScript(), { JSON }), "no storage at all");
});

test("marks: read and written on this device only (hashes only), parsed and pruned by the attention model", (t) => {
  const store = memoryStorage();
  withWindow(t, store);
  const V = fresh();
  const A = loadTs("lib/today-attention.ts");
  const NOW = Date.parse("2030-03-05T12:00:00Z");
  const item = { id: "agents:R1", version: "normal||" };
  const marks = { [A.markKey(item)]: A.markFor(item, "hide", NOW) };
  assert.equal(V.writeMarks(marks), true);
  assert.deepEqual(V.readMarks(A.parseMarks, A.pruneMarks, NOW), marks);
  assert.ok(!store.getItem(V.MARKS_DEVICE_KEY).includes("R1"), "no obligation text on the device");
  store.setItem(V.MARKS_DEVICE_KEY, "{broken");
  assert.deepEqual(V.readMarks(A.parseMarks, A.pruneMarks, NOW), {}, "a broken copy is ignored");
  assert.equal(V.writeMarks({}), true);
  assert.equal(store.getItem(V.MARKS_DEVICE_KEY), null, "no marks: the key is removed");
});

test("row widths: every desktop row of 'Keep life moving' is full, whatever number of panels shows", () => {
  const V = fresh();
  const span = { full: 12, half: 6, third: 4 };
  for (let n = 0; n <= 9; n++) {
    const widths = V.lifeWidths(n);
    assert.equal(widths.length, n);
    let row = 0;
    for (const w of widths) {
      assert.ok(row + span[w] <= 12, `n=${n}: a panel never straddles a row`);
      row = (row + span[w]) % 12;
    }
    assert.equal(row, 0, `n=${n}: the last row is full (no empty track)`);
  }
  assert.deepEqual(V.lifeWidths(1), ["full"]);
  assert.deepEqual(V.lifeWidths(2), ["half", "half"]);
  assert.deepEqual(V.lifeWidths(5), ["third", "third", "third", "half", "half"]);
  assert.deepEqual(V.lifeWidths(NaN), []);
});

test("Today: opening reads the setting, never writes it; the quiet view hides (not removes) the full page", () => {
  const today = fs.readFileSync(path.join(SRC, "app", "today", "TodayClient.tsx"), "utf8");
  // The only calls that send the setting are behind Riley's taps (changeQuiet / retryQuiet).
  const effects = today.split("useEffect(").slice(1).map((s) => s.slice(0, s.search(/\n {2}\}(, \[[^\]]*\])?\);/)));
  for (const body of effects) assert.ok(!/setQuiet\(|pushQuiet\(|writeMarks\(/.test(body), `no write from an effect: ${body.slice(0, 80)}`);
  assert.match(today, /if \(feed\) return undefined;\s*const timer = setTimeout\(\(\) => \{\s*void syncQuiet\(\)/, "only the routed page reads the server copy, after the page settles");
  // A data attribute, never the HTML hidden attribute: Tailwind's base layer makes [hidden] display:none !important.
  assert.match(today, /data-today-full="" data-quiet-off=\{selection && !showFull \? "" : undefined\}/);
  assert.ok(!/data-today-(?:full|quiet)="" hidden/.test(today), "the quiet markup never uses the hidden attribute");
  assert.match(today, /<div data-today-quiet="" className=\{`\$\{panelStyle\} \$\{styles\.quiet\} \$\{styles\.quietBoot\}`\}>/, "the pre-paint slot is hidden by its class");
  assert.match(today, /\{!feed && <script dangerouslySetInnerHTML=\{\{ __html: quietBootScript\(\) \}\} \/>\}/);
  const css = fs.readFileSync(path.join(SRC, "app", "today", "Today.module.css"), "utf8");
  assert.match(css, /\.full\[data-quiet-off\] \{ display: none; \}/);
  assert.match(css, /\.full\[data-quiet-off\]:has\(\[data-pz-editing\]\) \{ display: flex; \}/, "Personalize still edits the full page while the quiet view is on");
  assert.match(css, /\.quietBoot \{ display: none; \}/);
  assert.ok(!/!important/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), "no !important here: the pre-paint style's must win");
  const regression = fs.readFileSync(path.join(SRC, "..", "..", "tests", "today-regression.cjs"), "utf8");
  assert.match(regression, /lib\/today-attention\.ts/);
  assert.match(regression, /lib\/today-view\.ts/);
});
