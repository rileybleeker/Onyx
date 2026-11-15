// Run: node --test tests/money-alerts-view.test.cjs
// How Today shows the money alerts and how current they are (lib/money-alerts-view.ts): an older stored answer
// is labelled and followed up once, a failed follow-up or a partial check is never shown as an all-clear.
// SYNTHETIC DATA ONLY.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const V = loadTs("lib/money-alerts-view.ts");
const NOW = new Date("2030-06-16T13:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const alert = { kind: "budget", severity: "high", title: "Synthetic category: $40 over budget", detail: "Synthetic.", href: "/financials/budgets" };

test("parse: the route's answer, older answers without metadata, junk rejected", () => {
  assert.deepEqual(V.parseMoneyAnswer({ status: "ready", alerts: [alert], asOf: hoursAgo(5), updating: true }), { alerts: [alert], asOf: hoursAgo(5), updating: true, partial: null, refreshFailed: false });
  assert.deepEqual(V.parseMoneyAnswer({ status: "ready", alerts: [] }), { alerts: [], asOf: null, updating: false, partial: null, refreshFailed: false }, "an answer from before this change");
  assert.equal(V.parseMoneyAnswer({ status: "ready", alerts: [], partial: "budgets" }).partial, "budgets");
  assert.equal(V.parseMoneyAnswer({ status: "ready", alerts: [], partial: "x", asOf: "not a date" }).partial, null);
  assert.throws(() => V.parseMoneyAnswer({ status: "unavailable" }));
  assert.throws(() => V.parseMoneyAnswer(null));
  assert.equal(V.MONEY_FRESH_URL, `${V.MONEY_URL}?fresh=1`);
  assert.ok(V.MONEY_RECHECK_MS > 0 && V.MONEY_RECHECK_MS <= 10_000, "the follow-up is bounded");
});

test("panel: alerts, or an unverified 'nothing to act on'; a current empty answer shows nothing", () => {
  const v = (over) => ({ alerts: [], asOf: hoursAgo(5), updating: false, partial: null, refreshFailed: false, ...over });
  assert.equal(V.showMoneyPanel(null), false);
  assert.equal(V.showMoneyPanel(v({})), false);
  assert.equal(V.showMoneyPanel(v({ updating: true })), false, "the follow-up lands in seconds");
  assert.equal(V.showMoneyPanel(v({ updating: true, refreshFailed: true })), true, "an older empty answer that could not be updated");
  assert.equal(V.showMoneyPanel(v({ refreshFailed: true })), false, "the last check was current");
  assert.equal(V.showMoneyPanel(v({ partial: "forecast" })), true);
  assert.equal(V.showMoneyPanel(v({ alerts: [alert] })), true);
});

test("note: says how old an answer is, and when it could not be brought up to date", () => {
  const v = (over) => ({ alerts: [alert], asOf: hoursAgo(5), updating: false, partial: null, refreshFailed: false, ...over });
  assert.equal(V.moneyNote(v({}), NOW), null, "current and complete");
  assert.deepEqual(V.moneyNote(v({ updating: true }), NOW), { text: "From the check 5 h ago. Updating...", tone: "muted" });
  assert.deepEqual(V.moneyNote(v({ updating: true, refreshFailed: true }), NOW), { text: "Couldn't refresh: these are from the check 5 h ago and may have changed.", tone: "warn" });
  assert.equal(V.moneyNote(v({ refreshFailed: true }), NOW).tone, "warn");
  assert.deepEqual(V.moneyNote(v({ alerts: [], updating: true, refreshFailed: true, asOf: hoursAgo(50) }), NOW), { text: "No money alerts in the check 2 d ago, but it couldn't be brought up to date.", tone: "warn" });
  assert.equal(V.moneyNote(v({ alerts: [], refreshFailed: true }), NOW), null, "a current empty check that failed to refresh stays quiet");
  assert.deepEqual(V.moneyNote(v({ partial: "budgets" }), NOW), { text: "Your budgets couldn't be read, so an alert from it may be missing.", tone: "warn" });
  assert.match(V.moneyNote(v({ updating: true, asOf: null }), NOW).text, /an earlier check/);
});

test("source: import-free (bundled by name in tests/today-regression.cjs) and used by Today", () => {
  const lib = fs.readFileSync(path.join(SRC, "lib", "money-alerts-view.ts"), "utf8");
  for (const line of lib.split(/\r?\n/)) if (/^\s*import\s/.test(line)) assert.match(line, /^\s*import type\s/, line);
  const today = fs.readFileSync(path.join(SRC, "app", "today", "TodayClient.tsx"), "utf8");
  assert.match(today, /from "@\/lib\/money-alerts-view"/);
  assert.match(today, /MONEY_FRESH_URL/);
  const regression = fs.readFileSync(path.join(SRC, "..", "..", "tests", "today-regression.cjs"), "utf8");
  assert.match(regression, /lib\/money-alerts-view\.ts/);
});
