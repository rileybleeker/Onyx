// Run: node --test tests/medical-backup-status.test.cjs
// The /status "Medical Backup" card (lib/medical-backup-status.ts): thresholds, failure codes, no counts,
// and the wiring AGENTS.md "Every integration must appear on /status" names. Synthetic heartbeats only;
// no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC, loadTs } = require("./helpers/load-ts.cjs");

const S = loadTs("lib/medical-backup-status.ts");
const NOW = Date.parse("2026-11-20T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const card = (entry) => S.medicalBackupCard({ entry, nowMs: NOW });

test("no heartbeat yet reads unknown with the setup steps", () => {
  const c = card(null);
  assert.equal(c.status, "unknown");
  assert.match(c.errorMessage, /keygen/);
  assert.match(c.errorMessage, /register-task\.ps1/);
  assert.equal(c.recordsSynced, 0);
});

test("a fresh success is green; it ages to degraded after 8 days and red after 15", () => {
  assert.equal(card({ status: "success", sync_start: daysAgo(1) }).status, "success");
  assert.equal(card({ status: "success", sync_start: daysAgo(7.9) }).status, "success");
  const late = card({ status: "success", sync_start: daysAgo(8.5) });
  assert.equal(late.status, "partial");
  assert.match(late.errorMessage, /8 days/);
  const gone = card({ status: "success", sync_start: daysAgo(15.5) });
  assert.equal(gone.status, "failed");
  assert.match(gone.errorMessage, /Onyx Medical Backup/);
});

test("a failed run is red at once and names what to do", () => {
  const c = card({ status: "failed", sync_start: daysAgo(0.1), error_message: "age_missing" });
  assert.equal(c.status, "failed");
  assert.match(c.errorMessage, /winget install FiloSottile\.age/);
  assert.match(card({ status: "failed", sync_start: daysAgo(0), error_message: "recipient_missing" }).errorMessage, /keygen/);
  assert.match(card({ status: "failed", sync_start: daysAgo(0), error_message: "crash_OSError" }).errorMessage, /backup\.log/);
});

test("a partial run is degraded with the recovery-check pointer; a stale partial turns red", () => {
  const c = card({ status: "partial", sync_start: daysAgo(1), error_message: "files_missing" });
  assert.equal(c.status, "partial");
  assert.match(c.errorMessage, /recovery_check\.py/);
  assert.equal(card({ status: "partial", sync_start: daysAgo(16), error_message: "files_missing" }).status, "failed");
});

test("a stored text that is not a short code is never echoed", () => {
  const c = card({ status: "failed", sync_start: daysAgo(0), error_message: "LEAK some sentence with a title" });
  assert.equal(c.status, "failed");
  assert.doesNotMatch(c.errorMessage, /LEAK/);
  assert.equal(S.backupCode("files_missing"), "files_missing");
  assert.equal(S.backupCode("a b"), null);
  assert.equal(S.backupCode(42), null);
});

test("records are never shown, whatever the row says", () => {
  assert.equal(card({ status: "success", sync_start: daysAgo(1), records_synced: 99 }).recordsSynced, 0);
});

test("a malformed time reads unknown, never green", () => {
  assert.equal(card({ status: "success", sync_start: "not a time" }).status, "unknown");
  assert.equal(card({ status: "success" }).status, "unknown");
});

test("the card logic is pure (no imports)", () => {
  const src = fs.readFileSync(path.join(SRC, "lib", "medical-backup-status.ts"), "utf8");
  assert.doesNotMatch(src, /^import\s/m);
});

test("the status route and page wire the card in the three places", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/status/route.ts"), "utf8");
  const page = fs.readFileSync(path.join(SRC, "app/status/page.tsx"), "utf8");
  assert.match(route, /^\s+medical_backup: "Weekly/m);
  assert.match(route, /^\s+medical_backup: \{ method: "automated"/m);
  assert.match(route, /\["backup", "medical_records"\]/, "its own limit-1 heartbeat read (one row a week)");
  assert.match(route, /latestBySrcType\["backup\|medical_records"\]/);
  assert.doesNotMatch(route, /from\("medical_documents"\)|from\("lab_results"\)/, "no medical rows are read by /api/status");
  assert.match(page, /medical_backup: "PC"/);
  assert.match(page, /SOURCE_ORDER = \[[^\]]*"medical_backup"/s);
  assert.match(page, /backup: "Medical Backup"/);
  assert.match(page, /medical_records: "Medical Records"/);
});
