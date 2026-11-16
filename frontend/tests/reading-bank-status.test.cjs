// READ-QUIZ-01 S2: the /status card "Reading Questions" (lib/reading-bank-status.ts, pure). Synthetic counts only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");

const S = loadTs("lib/reading-bank-status.ts");
const NOW = Date.parse("2031-03-10T15:00:00Z");
const ago = (h) => new Date(NOW - h * 3_600_000).toISOString();
const hb = (status, hours, msg = "ch 3 ready 9/10 ideas 21 q 4 src") => ({ status, sync_start: ago(hours), records_synced: 9, duration_seconds: 42, error_message: msg });
const counts = (o = {}) => ({
  approved_books: 1, paused_budget: 0, uncertain: 0, queued: 0, failed_24h: 0, lagging_6h: 0, lagging_24h: 0, pending_grades: 0,
  month_cents: 420, schema: { all_ok: true }, ...o,
});
const card = (heartbeat, c, countsError = null) => S.readingBankCard({ heartbeat, counts: c, countsError, monthCapCents: 3000, nowMs: NOW });

test("unknown: not set up (the function is missing), off (no book turned on), on but no run yet", () => {
  const missing = card(null, null, { code: "PGRST202" });
  assert.equal(missing.status, "unknown");
  assert.match(missing.errorMessage, /sql\/reading_question_bank\.sql/);
  const off = card(null, counts({ approved_books: 0 }));
  assert.equal(off.status, "unknown");
  assert.match(off.errorMessage, /Off · turn it on per book on Reading/);
  const fresh = card(null, counts());
  assert.equal(fresh.status, "unknown");
});

test("a failed worker run while the SQL is missing is red, not unknown", () => {
  const c = card(hb("failed", 1, "failed 1; codes schema_missing; apply sql/reading_question_bank.sql"), null, { code: "42883" });
  assert.equal(c.status, "failed");
  assert.match(c.errorMessage, /schema_missing/);
});

test("success: a recent successful run; the spend row shows the month against the cap", () => {
  const c = card(hb("success", 1), counts());
  assert.equal(c.status, "success");
  assert.equal(c.errorMessage, null);
  assert.deepEqual(c.extraRows[0], { label: "Spend", value: "$4.20 of $30 this month" });
  assert.equal(c.recordsSynced, 9);
  assert.equal(c.lastSync, ago(1));
});

test("an old heartbeat with nothing queued is still healthy (quiet weeks are fine)", () => {
  assert.equal(card(hb("success", 30), counts()).status, "success");
});

test("degraded: partial run, a chapter waiting > 6 h, jobs queued and no run for 3 h, T07 checks not widened", () => {
  const partial = card(hb("partial", 1, "ch 4 thin 3/9 ideas 5 q 1 src; codes thin"), counts());
  assert.equal(partial.status, "partial");
  assert.match(partial.errorMessage, /thin/);
  assert.equal(card(hb("success", 1), counts({ lagging_6h: 1 })).status, "partial");
  assert.equal(card(hb("success", 4), counts({ queued: 2 })).status, "partial");
  assert.equal(card(hb("success", 2), counts({ queued: 2 })).status, "success");
  const checks = card(hb("success", 1), counts({ schema: { all_ok: false } }));
  assert.equal(checks.status, "partial");
  assert.match(checks.errorMessage, /sql\/reading_question_bank_checks\.sql/);
});

test("red: failed run, a chapter waiting > 24 h, jobs queued with no run for 24 h (or ever), a failed job in 24 h", () => {
  assert.equal(card(hb("failed", 1, "failed 1; codes server_error"), counts()).status, "failed");
  assert.equal(card(hb("success", 1), counts({ lagging_6h: 1, lagging_24h: 1 })).status, "failed");
  assert.equal(card(hb("success", 25), counts({ queued: 3 })).status, "failed");
  assert.equal(card(null, counts({ queued: 3 })).status, "failed");
  assert.equal(card(hb("success", 1), counts({ failed_24h: 1 })).status, "failed");
  const other = card(hb("success", 1), null, { code: "XX000" });
  assert.equal(other.status, "failed");
  assert.match(other.errorMessage, /XX000/);
});

test("a heartbeat message that is not counts and codes is never shown", () => {
  const c = card(hb("partial", 1, "Some <script> text the generator never writes"), counts());
  assert.equal(c.status, "partial");
  assert.equal(c.errorMessage.includes("script"), false);
});

test("paused books and pending grades are extra rows; money is formatted plainly", () => {
  const c = card(hb("partial", 1, "codes budget"), counts({ paused_budget: 1, pending_grades: 2 }));
  assert.deepEqual(c.extraRows.map((r) => r.label), ["Spend", "Paused", "Grading"]);
  assert.equal(S.money(1900), "$19");
  assert.equal(S.money(5), "$0.05");
});

test("/api/status and /status carry the card in every map the convention requires", () => {
  const route = fs.readFileSync(path.join(__dirname, "..", "src", "app", "api", "status", "route.ts"), "utf8");
  for (const needle of ['reading_bank: "With each Kindle harvest + hourly"', 'reading_bank:   { method: "automated",      label: "Claude + web sources" }', 'eq("source", "reading_bank").eq("data_type", "generate")', 'rpc("reading_bank_status")', "readingBankCard("]) {
    assert.ok(route.includes(needle), needle);
  }
  const page = fs.readFileSync(path.join(__dirname, "..", "src", "app", "status", "page.tsx"), "utf8");
  for (const needle of ['reading_bank: "CLAUDE"', '"reading_bank",', 'reading_bank: "Reading Questions"', 'generate: "Generate"', "info.extraRows?.map("]) {
    assert.ok(page.includes(needle), needle);
  }
});
