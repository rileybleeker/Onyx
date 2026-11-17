// Run: node --test tests/spotify-ledger-page-failure.test.cjs
// A failed ledger page change with rows still on screen shows an inline alert with Retry (the rows stay),
// and a superseded ledger request never sets state. Static source checks, offline.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "src", "app", "spotify", "SpotifyClient.tsx"),
  "utf8",
);

test("ledger request ignores superseded responses", () => {
  const effect = src.slice(src.indexOf("getSpotifyLedger(range, ledgerPage"));
  const body = effect.slice(0, effect.indexOf("[range, ledgerPage, ledgerRetry]"));
  assert.match(body, /let cancelled = false;/);
  assert.match(body, /if \(cancelled\) return;\s*setLedger\(rows\);/);
  assert.match(body, /if \(cancelled\) return;\s*console\.error\("Spotify ledger:"/);
  assert.match(body, /if \(!cancelled\) setLedgerLoading\(false\);/);
  assert.match(body, /return \(\) => \{ cancelled = true; \};/);
});

test("a failed page change with rows on screen shows an alert with Retry", () => {
  const start = src.indexOf("{ledger.length > 0 && (");
  const notice = src.slice(start, src.indexOf("overflow-x-auto -mx-1", start));
  assert.match(notice, /\{ledgerFailed && \(/);
  assert.match(notice, /role="alert"/);
  assert.match(notice, /Couldn&apos;t load that page of plays\. Showing the last page that loaded\./);
  assert.match(notice, /onClick=\{\(\) => setLedgerRetry\(\(c\) => c \+ 1\)\}/);
  // Retry re-requests the same page: it bumps ledgerRetry and never resets ledgerPage.
  assert.doesNotMatch(notice, /setLedgerPage/);
});
