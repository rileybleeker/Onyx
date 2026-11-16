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
  assert.deepEqual(V.parseMoneyAnswer({ status: "ready", alerts: [alert], asOf: hoursAgo(5), updating: true }), { alerts: [alert], asOf: hoursAgo(5), updating: true, partial: null, refreshFailed: false, cash: null });
  assert.deepEqual(V.parseMoneyAnswer({ status: "ready", alerts: [] }), { alerts: [], asOf: null, updating: false, partial: null, refreshFailed: false, cash: null }, "an answer from before this change");
  assert.equal(V.parseMoneyAnswer({ status: "ready", alerts: [], partial: "budgets" }).partial, "budgets");
  assert.equal(V.parseMoneyAnswer({ status: "ready", alerts: [], partial: "x", asOf: "not a date" }).partial, null);
  assert.throws(() => V.parseMoneyAnswer({ status: "unavailable" }));
  assert.throws(() => V.parseMoneyAnswer(null));
  assert.equal(V.MONEY_FRESH_URL, `${V.MONEY_URL}?fresh=1`);
  assert.ok(V.MONEY_RECHECK_MS > 0 && V.MONEY_RECHECK_MS <= 10_000, "the follow-up is bounded");
});

test("panel: alerts, or an unverified 'nothing to act on'; a current empty answer shows nothing", () => {
  const v = (over) => ({ alerts: [], asOf: hoursAgo(5), updating: false, partial: null, refreshFailed: false, cash: null, ...over });
  assert.equal(V.showMoneyPanel(null), false);
  // A view built before the cash check existed (no `cash` field at all) is read the same as cash: null.
  assert.equal(V.showMoneyPanel({ alerts: [], asOf: hoursAgo(5), updating: false, partial: null, refreshFailed: false }), false);
  assert.equal(V.showMoneyPanel(v({})), false);
  assert.equal(V.showMoneyPanel(v({ updating: true })), false, "the follow-up lands in seconds");
  assert.equal(V.showMoneyPanel(v({ updating: true, refreshFailed: true })), true, "an older empty answer that could not be updated");
  assert.equal(V.showMoneyPanel(v({ refreshFailed: true })), false, "the last check was current");
  assert.equal(V.showMoneyPanel(v({ partial: "forecast" })), true);
  assert.equal(V.showMoneyPanel(v({ alerts: [alert] })), true);
});

test("note: says how old an answer is, and when it could not be brought up to date", () => {
  const v = (over) => ({ alerts: [alert], asOf: hoursAgo(5), updating: false, partial: null, refreshFailed: false, cash: null, ...over });
  assert.equal(V.moneyNote(v({}), NOW), null, "current and complete");
  assert.deepEqual(V.moneyNote(v({ updating: true }), NOW), { text: "From the check 5 h ago. Updating...", tone: "muted" });
  assert.deepEqual(V.moneyNote(v({ updating: true, refreshFailed: true }), NOW), { text: "Couldn't refresh: these are from the check 5 h ago and may have changed.", tone: "warn" });
  assert.equal(V.moneyNote(v({ refreshFailed: true }), NOW).tone, "warn");
  assert.deepEqual(V.moneyNote(v({ alerts: [], updating: true, refreshFailed: true, asOf: hoursAgo(50) }), NOW), { text: "No money alerts in the check 2 d ago, but it couldn't be brought up to date.", tone: "warn" });
  assert.equal(V.moneyNote(v({ alerts: [], refreshFailed: true }), NOW), null, "a current empty check that failed to refresh stays quiet");
  assert.deepEqual(V.moneyNote(v({ partial: "budgets" }), NOW), { text: "Your budgets couldn't be read, so an alert from it may be missing.", tone: "warn" });
  assert.match(V.moneyNote(v({ updating: true, asOf: null }), NOW).text, /an earlier check/);
});

test("cash forecast check: parsed strictly; an incomplete forecast shows the panel with its reason, never an all-clear", () => {
  const stale = "The balance for Synthetic Checking is older than 48 hours.";
  assert.deepEqual(V.parseMoneyAnswer({ status: "ready", alerts: [], cash: { eligible: true, reasons: [] } }).cash, { eligible: true, reasons: [] });
  assert.deepEqual(V.parseMoneyAnswer({ status: "ready", alerts: [], cash: { eligible: false, reasons: [stale, 7, ""] } }).cash, { eligible: false, reasons: [stale] });
  assert.equal(V.parseMoneyAnswer({ status: "ready", alerts: [], cash: { eligible: true, reasons: [stale] } }).cash.eligible, false, "a reason means not eligible");
  assert.equal(V.parseMoneyAnswer({ status: "ready", alerts: [], cash: { eligible: "yes" } }).cash, null);
  assert.equal(V.parseMoneyAnswer({ status: "ready", alerts: [], cash: "ok" }).cash, null);
  assert.equal(V.parseMoneyAnswer({ status: "ready", alerts: [], cash: { eligible: false, reasons: ["a", "b", "c", "d"] } }).cash.reasons.length, 3);

  const v = (over) => ({ alerts: [], asOf: hoursAgo(1), updating: false, partial: null, refreshFailed: false, cash: null, ...over });
  assert.equal(V.showMoneyPanel(v({ cash: { eligible: true, reasons: [] } })), false, "a complete forecast with nothing to act on stays quiet");
  assert.equal(V.moneyNote(v({ cash: { eligible: true, reasons: [] } }), NOW), null);
  const limited = v({ cash: { eligible: false, reasons: [stale] } });
  assert.equal(V.showMoneyPanel(limited), true);
  assert.deepEqual(V.moneyNote(limited, NOW), { text: `Cash forecast incomplete. ${stale} A low-cash alert may be off or missing.`, tone: "warn" });
  assert.deepEqual(V.moneyNote(v({ cash: { eligible: false, reasons: [] } }), NOW), { text: "Cash forecast incomplete. A low-cash alert may be off or missing.", tone: "warn" });
  // With a partial read too, both are said; the tone stays a warning.
  const both = V.moneyNote(v({ cash: { eligible: false, reasons: [stale] }, partial: "budgets" }), NOW);
  assert.equal(both.tone, "warn");
  assert.match(both.text, /budgets couldn't be read.*Cash forecast incomplete/);
});

test("quiet view: an incomplete cash forecast or a part that couldn't be read is never complete", () => {
  const v = (over) => ({ alerts: [], asOf: hoursAgo(1), updating: false, partial: null, refreshFailed: false, cash: null, ...over });
  assert.equal(V.moneyIncomplete(v({})), null, "no cash check in the answer (no ledger, or an older answer)");
  assert.equal(V.moneyIncomplete(v({ cash: { eligible: true, reasons: [] } })), null, "complete");
  assert.equal(V.moneyIncomplete(v({ cash: { eligible: false, reasons: ["Synthetic reason."] } })), "the cash forecast's inputs are incomplete, so an alert may be missing");
  assert.equal(V.moneyIncomplete(v({ partial: "budgets" })), "your budgets couldn't be read, so an alert may be missing");
  assert.equal(V.moneyIncomplete(v({ partial: "forecast", cash: { eligible: false, reasons: [] } })), "your forecast couldn't be read and the cash forecast's inputs are incomplete, so an alert may be missing");
  // Today's quiet view probes the Money source with it: partial + this note, so the day is never called clear.
  const today = fs.readFileSync(path.join(SRC, "app", "today", "TodayClient.tsx"), "utf8");
  assert.match(today, /const moneyGap = money \? moneyIncomplete\(money\) : null;/);
  assert.match(today, /partial: moneyGap !== null, \.\.\.\(moneyGap \? \{ partialNote: moneyGap \} : \{\}\)/);
  assert.doesNotMatch(today, /partial: money\.partial !== null/, "the cash check is not left out of the quiet view");
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
