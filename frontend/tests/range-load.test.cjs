// Run: node --test tests/range-load.test.cjs
// Dashboard range labels stay with the rows that loaded (Codex review #191, UI item 4): the picker shows the
// range being loaded, every label keeps the shown range until the new one has loaded, a failed load says so
// with Retry, and a slow answer for an older range never lands under a newer range's label.
// SYNTHETIC DATA ONLY: no network, no database; the query functions are stubs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");
const { mountClient, deferred } = require("./helpers/hook-harness.cjs");

const R = loadTs("lib/range-load.ts");
const label = (r) => `L${r}`;

// ─── pure rules ───────────────────────────────────────────────────────────────

test("a load keeps the shown range until it answers OK", () => {
  let v = R.rangeView("30d");
  v = R.startRange(v, "90d", 1);
  assert.deepEqual([v.shown, v.pending, v.failed, R.selectedRange(v)], ["30d", "90d", null, "90d"]);
  assert.deepEqual(R.rangeStatus(v, label), { tone: "loading", text: "Loading L90d…" });
  v = R.finishRange(v, 1, "90d", true);
  assert.deepEqual([v.shown, v.pending, v.failed], ["90d", null, null]);
  assert.equal(R.rangeStatus(v, label), null);
});

test("a failed load keeps the old rows' range, selected and labelled, and says what failed", () => {
  let v = R.startRange(R.rangeView("30d"), "90d", 1);
  v = R.finishRange(v, 1, "90d", false);
  assert.deepEqual([v.shown, v.pending, v.failed, R.selectedRange(v)], ["30d", null, "90d", "30d"]);
  assert.deepEqual(R.rangeStatus(v, label), { tone: "error", text: "Couldn't load L90d. Showing L30d." });
  v = R.startRange(v, "90d", 2); // Retry clears the failure while it loads
  assert.equal(v.failed, null);
});

test("a failed refresh of the shown range is a refresh failure, not a range mismatch", () => {
  const v = R.finishRange(R.startRange(R.rangeView("30d"), "30d", 1, true), 1, "30d", false);
  assert.deepEqual(R.rangeStatus(v, label), { tone: "error", text: "Couldn't refresh L30d." });
  assert.equal(R.startRange(R.rangeView("30d"), "30d", 1, true).pending, null, "a silent revalidation shows no Loading hint");
});

test("only the newest load moves the view: a slow older answer is ignored", () => {
  let v = R.startRange(R.rangeView("30d"), "90d", 1);
  v = R.startRange(v, "365d", 2);
  const before = v;
  assert.equal(R.finishRange(v, 1, "90d", true), before, "older success ignored");
  assert.equal(R.finishRange(v, 1, "90d", false), before, "older failure ignored");
  v = R.finishRange(v, 2, "365d", true);
  assert.equal(v.shown, "365d");
  assert.equal(R.finishRange(v, 1, "90d", true), v);
});

// ─── the real Sleep page ──────────────────────────────────────────────────────

function mountSleep() {
  const loads = new Map(); // days -> [deferred, ...] for getWhoopSleepAll, the call the test controls
  const queue = (days) => {
    const d = deferred();
    if (!loads.has(days)) loads.set(days, []);
    loads.get(days).push(d);
    return d.promise;
  };
  const empty = async () => [];
  const DAYS = { "1d": 1, "7d": 7, "30d": 30, "60d": 60, "90d": 90, "365d": 365, all: 36500 };
  const LABELS = { "30d": "last 30 days", "90d": "last 90 days", "365d": "last year" };
  const picker = { current: null };
  const anything = new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : () => null) });
  const h = mountClient("app/sleep/SleepClient.tsx", {
    props: { initial: { whoopSleepAll: [], whoopRecovery: [], whoopCycles: [], journal: [], eightSleep: [], summaries: [] } },
    stubs: {
      recharts: anything,
      "@/lib/queries": {
        getWhoopSleepAll: (days) => (days === 30 && !loads.has(30) ? (loads.set(30, []), Promise.resolve([])) : queue(days)),
        getWhoopRecovery: empty, getWhoopCycles: empty, getBehaviorLog: empty, getEightSleepTrends: empty, getDailySummaries: empty,
        rangeDays: (r) => DAYS[r], rangeLabel: (r) => LABELS[r] ?? r,
      },
      "@/components/StatCard": { __esModule: true, default: () => null },
      "@/components/MetricRing": { __esModule: true, default: () => null },
      "@/components/ChartCard": { __esModule: true, default: () => null },
      "@/components/DeferredMount": { __esModule: true, default: () => null },
      "@/components/RangeFilter": { __esModule: true, default: (p) => { picker.current = p; return null; } },
    },
  });
  const last = (days) => loads.get(days).at(-1);
  return { ...h, pick: (r) => picker.current.onChange(r), selected: () => picker.current.value, last, count: (days) => loads.get(days)?.length ?? 0 };
}

test("Sleep: the label waits for the new range; a failure keeps the old label and offers Retry", async (t) => {
  const h = mountSleep();
  t.after(() => h.unmount());
  await h.flush();
  assert.match(h.text(), /trends — last 30 days/);
  h.pick("90d"); await h.flush();
  assert.equal(h.selected(), "90d");
  assert.match(h.text(), /trends — last 30 days/, "old rows keep their label while 90 days load");
  assert.match(h.text(), /Loading last 90 days…/);
  const origError = console.error;
  console.error = () => {};
  t.after(() => { console.error = origError; });
  h.last(90).reject(new Error("synthetic outage")); await h.flush();
  assert.match(h.text(), /trends — last 30 days/);
  assert.match(h.text(), /Couldn't load last 90 days\. Showing last 30 days\./);
  assert.equal(h.selected(), "30d", "the picker shows the range on screen");
  h.click("Retry"); await h.flush();
  assert.match(h.text(), /Loading last 90 days…/);
  h.last(90).resolve([]); await h.flush();
  assert.match(h.text(), /trends — last 90 days/);
  assert.doesNotMatch(h.text(), /Couldn't|Loading/);
});

test("Sleep: a slow answer for an older range never lands under the newer range's label", async (t) => {
  const h = mountSleep();
  t.after(() => h.unmount());
  await h.flush();
  h.pick("90d"); await h.flush();
  h.pick("365d"); await h.flush();
  h.last(365).resolve([]); await h.flush();
  assert.match(h.text(), /trends — last year/);
  h.last(90).resolve([]); await h.flush();
  assert.match(h.text(), /trends — last year/);
  assert.equal(h.selected(), "365d");
  assert.doesNotMatch(h.text(), /Loading/);
});

test("Sleep: picking the range that just failed tries it again", async (t) => {
  const h = mountSleep();
  t.after(() => h.unmount());
  await h.flush();
  h.pick("90d"); await h.flush();
  const origError = console.error;
  console.error = () => {};
  t.after(() => { console.error = origError; });
  h.last(90).reject(new Error("synthetic outage")); await h.flush();
  h.pick("90d"); await h.flush();
  assert.match(h.text(), /Loading last 90 days…/);
  assert.equal(h.count(90), 2, "a second load of 90 days started");
});
