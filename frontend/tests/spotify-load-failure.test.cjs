// Run: node --test tests/spotify-load-failure.test.cjs
// A failed Spotify read is not an empty install (2026-11-17): the page-load and ledger failures set flags the UI
// shows (an alert with Retry, and a ledger message with Retry). The empty-state text shows only after a successful
// load that returned zero plays (since #639 it is plain words, no developer commands). Static source checks, offline.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "app", "spotify", "SpotifyClient.tsx"),
  "utf8",
);

test("page-load failure sets loadFailed (guarded by cancelled) and keeps the console.error", () => {
  assert.match(src, /const \[loadFailed, setLoadFailed\] = useState\(false\);/);
  assert.match(src, /console\.error\("Spotify page load:", err\);\s*if \(!cancelled\) setLoadFailed\(true\);/);
  // Every load starts with the flag cleared.
  assert.match(src, /if \(!silent\) setLoading\(true\);\s*setLoadFailed\(false\);/);
  assert.match(src, /\}, \[range, retryCount\]\);/);
});

test("the alert replaces charts and the empty panel; empty-state text only after a successful zero-play load", () => {
  assert.match(src, /\{!loading && loadFailed && \(\s*<div role="alert"/);
  assert.match(src, /Couldn&apos;t load Spotify/);
  assert.match(src, /Couldn&apos;t load your Spotify data\. Try again\./);
  assert.match(src, /\{!loading && !loadFailed && hasData && \(/);
  assert.match(src, /\{!loading && !loadFailed && !hasData && \(/);
  // The empty-state text sits after the guard that requires !loadFailed, and names no developer command (#639).
  const guard = src.indexOf("{!loading && !loadFailed && !hasData && (");
  const emptyText = src.indexOf("Plays appear here after the first Spotify sync.");
  assert.ok(guard > 0 && emptyText > guard, "the empty-state text is behind the !loadFailed guard");
  assert.doesNotMatch(src, /spotify_etl\.py --auth/);
});

test("Retry re-runs the page-load effect for the current range", () => {
  assert.match(src, /onClick=\{\(\) => setRetryCount\(\(c\) => c \+ 1\)\}/);
});

test("ledger failure sets ledgerFailed, shows its own message with Retry, and re-runs the ledger effect", () => {
  assert.match(src, /const \[ledgerFailed, setLedgerFailed\] = useState\(false\);/);
  assert.match(src, /console\.error\("Spotify ledger:", err\);\s*setLedgerFailed\(true\);/);
  assert.match(src, /\}, \[range, ledgerPage, ledgerRetry\]\);/);
  assert.match(src, /onClick=\{\(\) => setLedgerRetry\(\(c\) => c \+ 1\)\}/);
  assert.match(src, /Couldn&apos;t load the plays list\. Try again\./);
  // "No plays in this range." only when the ledger did not fail.
  assert.match(src, /\{!ledgerLoading && ledger\.length === 0 && !ledgerFailed && \(/);
});
