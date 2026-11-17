// Run: node --test tests/pollen-a11y.test.cjs
// Screen-reader text in PollenPanel.tsx, checked against the component source. SYNTHETIC values only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

const src = fs.readFileSync(path.join(SRC, "components/PollenPanel.tsx"), "utf8");

test("loading placeholder is a status region with visually hidden text, not an aria-label on a bare div", () => {
  assert.match(src, /<div role="status" className="animate-pulse[^"]*"[^>]*>\s*<span className="sr-only">Loading pollen<\/span>\s*<\/div>/);
  assert.ok(!src.includes('aria-label="Loading pollen"'));
});

test("chart summary is visually hidden and only rendered when the newest count has level parts", () => {
  assert.match(src, /\{newest && hasParts && \(\s*<p className="sr-only">/);
  assert.match(src, /Newest count on \{newest\.airDate\}/);
});

test("panel reuses a copy fetched in the last 5 minutes (freshMs) instead of a GET on every visit", () => {
  assert.match(src, /const POLLEN_FRESH_MS = 5 \* 60_000;/);
  assert.match(src, /cachedJson\(POLLEN_URL, \{ check: checkAnswer, freshMs: POLLEN_FRESH_MS \}\)/);
});

test("chart summary builds only from the newest count's tree, grass, weed and mold levels", () => {
  const m = src.match(/<p className="sr-only">([\s\S]*?)<\/p>/);
  assert.ok(m, "summary paragraph exists");
  const summary = m[1];
  for (const field of ["tree", "grass", "weed", "mold"]) {
    assert.match(summary, new RegExp(`${field} \\{newest\\.${field} \\?\\? "n/a"\\}`));
  }
  assert.ok(!/\btotal\b/.test(summary), "summary does not repeat the total");
});
