// Run: node --test tests/status-first-visit.test.cjs
// /status first in-app visit (speed budget, 2026-11-17: perf-timing run 44148312755 saw /api/status take 1010 ms on
// a visit prewarmed by Today). Today's sweep (components/AppData.tsx) already fetches /api/status into memory; the
// page must reuse that copy on its first load when it is fresh, and the route's CDN/no-store headers stay as they are.
// Static checks on the source; no network, no database, no credentials.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

const route = fs.readFileSync(path.join(SRC, "app/api/status/route.ts"), "utf8");
const page = fs.readFileSync(path.join(SRC, "app/status/page.tsx"), "utf8");
const warm = fs.readFileSync(path.join(SRC, "components/AppData.tsx"), "utf8");

test("Today's sweep warms /api/status into the memory cache", () => {
  assert.match(warm, /"\/status": \(\) => \[json\("\/api\/status"\)\]/);
});

test("the first load takes the prewarmed copy when it is under 2 minutes old, before any request", () => {
  assert.match(page, /const STATUS_PREWARM_MAX_AGE_MS = 2 \* 60_000;/);
  const start = page.indexOf("const load = useCallback(async () => {");
  const fetchAt = page.indexOf("const get = () => fetch(STATUS_URL);", start);
  const branch = page.slice(start, fetchAt);
  assert.match(branch, /if \(firstLoad\.current\) \{/);
  assert.match(branch, /clientCache\.fetchedAt\(STATUS_URL\)/);
  assert.match(branch, /Date\.now\(\) - at < STATUS_PREWARM_MAX_AGE_MS/);
  assert.match(branch, /clientCache\.peek\(STATUS_URL\) !== undefined/);
  // The copy's own time is shown as "refreshed", and the first-load flag is spent so the poll fetches for itself.
  assert.match(branch, /refreshedAtRef\.current = new Date\(at\);/);
  assert.match(branch, /firstLoad\.current = false;[\s\S]*return;/);
});

test("the poll and later loads still fetch; the copy is never written to the device", () => {
  const start = page.indexOf("const load = useCallback(async () => {");
  const end = page.indexOf("}, []);", start);
  const body = page.slice(start, end);
  assert.match(body, /const get = \(\) => fetch\(STATUS_URL\);/);
  assert.match(body, /clientCache\.put\(STATUS_URL, fresh\);/);
  assert.doesNotMatch(body, /localStorage|sessionStorage|indexedDB/);
});

test("the route keeps its CDN caching and the browser no-store rule", () => {
  assert.match(route, /"Cache-Control": "private, no-store"/);
  assert.match(route, /"Vercel-CDN-Cache-Control": "max-age=30, stale-while-revalidate=30"/);
});
