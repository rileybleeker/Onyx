// Run: node --test tests/early-fetch.test.cjs
// lib/early-fetch.ts: the page's first GET started by an inline script, taken once by the client (speed budget,
// 2026-11-15). SYNTHETIC ONLY: no network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const E = loadTs("lib/early-fetch.ts");

function withWindow(t, search = "") {
  const calls = [];
  const prev = { window: global.window, location: global.location, fetch: global.fetch };
  global.window = global;
  global.location = { search };
  global.fetch = (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true, url }); };
  t.after(() => {
    delete global[E.EARLY_FETCH_KEY];
    global.window = prev.window; global.location = prev.location; global.fetch = prev.fetch;
  });
  return calls;
}

test("the script starts one same-origin, uncached GET and the client takes it once", async (t) => {
  const calls = withWindow(t);
  new Function(E.earlyFetchScript("/api/habits/checkin", true))();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/habits/checkin");
  assert.equal(calls[0].init.cache, "no-store");
  const p = E.takeEarlyFetch("/api/habits/checkin");
  assert.ok(p);
  assert.equal((await p).url, "/api/habits/checkin");
  assert.equal(E.takeEarlyFetch("/api/habits/checkin"), null, "a second load fetches for itself");
});

test("the page's ?date= is copied onto the URL, as the client builds it", (t) => {
  const calls = withWindow(t, "?date=2031-03-05");
  new Function(E.earlyFetchScript("/api/habits/checkin", true))();
  assert.equal(calls[0].url, "/api/habits/checkin?date=2031-03-05");
  assert.equal(E.takeEarlyFetch("/api/habits/checkin"), null, "another URL is not used");
});

test("an answer older than the limit is not used", (t) => {
  withWindow(t);
  new Function(E.earlyFetchScript("/api/habits/checkin"))();
  assert.equal(E.takeEarlyFetch("/api/habits/checkin", Date.now() + E.EARLY_FETCH_MAX_AGE_MS + 1), null);
});
