// Run: node --test tests/log-early-delivery-start.test.cjs
// app/log/early-delivery-start.ts: the /log Uber Eats early reads start on a full page load regardless of whether the
// head script's mark was set before or after the starter module ran, at most once per load, never on an in-app visit
// (2026-11-16). SYNTHETIC ONLY: ./early-delivery is stubbed, no network, no Supabase.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const { LOG_EARLY_MARK } = loadTs("lib/log-early.ts");

/**
 * One fresh "page load": a fresh module cache (the starter's top-level code runs at import) with a stubbed
 * ./early-delivery that only counts starts. The mark's owner is `global` (window), readyState is whatever the
 * head script's rules see. t.after ends the "load" so any pending poll tick stops.
 */
function pageLoad(t, { readyState = "loading", markAt = null } = {}) {
  const starts = [];
  const prev = { window: global.window, document: global.document };
  global.window = global;
  global.document = { readyState };
  if (markAt !== null) global[LOG_EARLY_MARK] = markAt;
  const starter = loadTs(
    "app/log/early-delivery-start.ts",
    { "./early-delivery": { startEarlyDeliveryReads: () => { starts.push(Date.now()); } } },
    { cache: new Map() }
  );
  t.after(() => {
    if (markAt !== null || LOG_EARLY_MARK in global) delete global[LOG_EARLY_MARK];
    // End the "load" first so a pending poll tick stops at its next look.
    if (global.document && global.document.readyState !== "complete") global.document.readyState = "complete";
    global.window = prev.window;
    global.document = prev.document;
  });
  return { starter, starts };
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("mark set before the starter runs: the reads start at import, once, and the mark is consumed", (t) => {
  const { starter, starts } = pageLoad(t, { readyState: "complete", markAt: Date.now() });
  assert.equal(starts.length, 1, "started at import");
  assert.equal(starter.tryStartEarlyDelivery(), true, "a later call reports started");
  assert.equal(starts.length, 1, "no second start");
  assert.equal(loadTs("lib/log-early.ts").takeLogEarlyMark(), false, "the mark was consumed");
});

test("mark set after the starter runs: the poll sees it and starts once, not twice", async (t) => {
  const { starter, starts } = pageLoad(t, { readyState: "loading" });
  assert.equal(starts.length, 0, "nothing started yet");
  // The head script runs now, after the starter module was evaluated.
  global[LOG_EARLY_MARK] = Date.now();
  await settle(80);
  assert.equal(starts.length, 1, "the poll started the reads");
  // "Run twice": a manual call while/after the poll started adds nothing.
  assert.equal(starter.tryStartEarlyDelivery(), true);
  assert.equal(starter.tryStartEarlyDelivery(), true);
  assert.equal(starts.length, 1, "still exactly one start");
});

test("an expired mark does not start the reads", (t) => {
  const { starts } = pageLoad(t, { readyState: "complete", markAt: Date.now() - 10_001 });
  assert.equal(starts.length, 0, "older than the 10 s validity");
});

test("in-app visit (document complete, no mark): nothing starts, now or later", async (t) => {
  const { starts } = pageLoad(t, { readyState: "complete" });
  assert.equal(starts.length, 0, "no mark, no start");
  await settle(60);
  assert.equal(starts.length, 0, "and no poll either");
});

test("a copy in the continuous scroll or a server import: window/document checks keep it client-only", (t) => {
  const starts = [];
  const prevWindow = global.window;
  delete global.window;
  try {
    loadTs(
      "app/log/early-delivery-start.ts",
      { "./early-delivery": { startEarlyDeliveryReads: () => { starts.push(Date.now()); } } },
      { cache: new Map() }
    );
  } finally {
    if (prevWindow !== undefined) global.window = prevWindow;
    else delete global.window;
  }
  assert.equal(starts.length, 0, "no window: the starter starts nothing");
});
