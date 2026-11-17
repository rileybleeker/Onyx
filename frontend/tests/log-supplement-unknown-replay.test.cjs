// Run: node --test tests/log-supplement-unknown-replay.test.cjs
// /log Supplements multi-select, review finding SUPPM-R1: a save whose outcome is unknown (timeout, dropped response)
// must replay with its ORIGINAL event_key and payload until it is confirmed saved or definitively refused. A replay
// can be refused (401 seen) while the first send committed, so that refusal does not end the attempt. A later change to
// Day, times, amount, unit or the selection must not alter the pending replay; a fresh key is only for a new save.
// SYNTHETIC DATA ONLY: invented product ids, names and dates; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");

const M = loadTs("lib/log-supplement-multi.ts");

const KEY = "22222222-2222-4222-8222-222222222222";
const fresh = () => KEY;
const ids = (sel) => sel.map((i) => i.productId);

// What the section does for one product on "Log selected": the attempt is built from the values on screen at that
// moment, then the item is queued with it (beginSend), then the answer settles it (settle).
function sendFirst(sel, productId, payload, key = fresh) {
  const item = sel.find((i) => i.productId === productId);
  const attempt = M.attemptFor(item, payload, key);
  return M.beginSend(sel, [productId], new Map(), new Map([[productId, attempt]]));
}
function replay(sel, productId, currentPayload, key = () => { throw new Error("a replay must not mint a key"); }) {
  // Same as logBatch for a lost item: the payload argument is ignored because the attempt is kept.
  const item = sel.find((i) => i.productId === productId);
  const attempt = M.attemptFor(item, currentPayload, key);
  return M.beginSend(sel, [productId], new Map(), new Map([[productId, attempt]]));
}

test("unknown outcome, then a 401 on replay, then Day changed: the replay keeps the original key and payload", () => {
  // 1. Riley taps Log selected with 2 mg, 08:30, today. The answer is lost (timeout).
  const original = { amount: 2, unit: "mg", times: ["08:30"], date: null };
  let sel = M.toggleItem(M.EMPTY_SELECTION, "p-synthetic-a");
  sel = sendFirst(sel, "p-synthetic-a", original);
  const firstAttempt = sel[0].attempt;
  assert.equal(firstAttempt.eventKey, KEY);
  sel = M.settle(sel, "p-synthetic-a", { kind: "unconfirmed", error: "No answer from Onyx" });
  assert.equal(sel[0].outcome.kind, "unconfirmed");
  assert.equal(sel[0].attempt.lost, true, "the attempt is kept, marked lost");

  // 2. Riley changes Day to yesterday before the replay (the shared control; the item's own dose is locked).
  const changedDay = { amount: 5, unit: "g", times: ["19:45"], date: "2030-01-01" };

  // 3. Log again: the replay is refused (401). The first send may have committed, so it stays unconfirmed.
  sel = replay(sel, "p-synthetic-a", changedDay);
  assert.deepEqual(sel[0].attempt.eventKey, KEY, "the replay repeats the original key");
  assert.deepEqual(
    { amount: sel[0].attempt.amount, unit: sel[0].attempt.unit, times: sel[0].attempt.times, date: sel[0].attempt.date },
    original,
    "the replay repeats the original payload, not the Day / time / dose on screen now",
  );
  sel = M.settle(sel, "p-synthetic-a", { kind: "refused", error: "Not saved (401)" });
  assert.equal(sel[0].outcome.kind, "unconfirmed", "a 401 on a replay is not a definitive refusal");
  assert.match(sel[0].outcome.error, /401/);
  assert.equal(sel[0].attempt.lost, true);

  // 4. Another Log again (Day still changed): the same key and the same original payload go out again.
  sel = replay(sel, "p-synthetic-a", changedDay);
  assert.equal(sel[0].attempt.eventKey, KEY);
  assert.deepEqual(sel[0].attempt.times, ["08:30"]);
  assert.equal(sel[0].attempt.date, null);
  assert.equal(sel[0].attempt.amount, 2);
  assert.equal(sel[0].attempt.unit, "mg");
});

test("a lost attempt cannot be edited, removed, replaced by Say it, or cleared out of the selection", () => {
  let sel = sendFirst(M.toggleItem(M.EMPTY_SELECTION, "p-synthetic-a"), "p-synthetic-a", { amount: 2, unit: "mg", times: ["08:30"], date: null });
  sel = M.settle(sel, "p-synthetic-a", { kind: "unconfirmed", error: "No answer from Onyx" });
  const before = JSON.stringify(sel);
  assert.equal(JSON.stringify(M.setItemDose(sel, "p-synthetic-a", { amount: "9", unit: "g" })), before, "the dose is locked");
  assert.equal(JSON.stringify(M.toggleItem(sel, "p-synthetic-a")), before, "removing it would drop its key");
  assert.equal(JSON.stringify(M.addWithDose(sel, "p-synthetic-a", { amount: "9", unit: "g" })), before, "Say it cannot replace it with a new key");
  assert.deepEqual(ids(M.sendable(sel, { only: ["p-synthetic-a"], includeUnconfirmed: true })), ["p-synthetic-a"], "its own Log again still replays it");
  assert.deepEqual(ids(M.sendable(sel)), [], "Log selected never sends it by itself");
});

test("a definite refusal of a send that never lost its answer is refused, and its next send is a genuinely new save", () => {
  let sel = sendFirst(M.toggleItem(M.EMPTY_SELECTION, "p-synthetic-b"), "p-synthetic-b", { amount: 1, unit: "serving", times: ["08:30"], date: null });
  sel = M.settle(sel, "p-synthetic-b", { kind: "refused", error: "Not saved (400)" });
  assert.equal(sel[0].outcome.kind, "refused");
  assert.equal(sel[0].attempt, undefined, "nothing was written, so nothing is kept");
  const next = M.attemptFor(sel[0], { amount: 1, unit: "serving", times: ["08:30"], date: null }, () => "33333333-3333-4333-8333-333333333333");
  assert.equal(next.eventKey, "33333333-3333-4333-8333-333333333333");
  assert.equal(next.lost, false);
});

test("a confirmed save ends its attempt: the next Log selected is a new save with a new key", () => {
  let sel = sendFirst(M.toggleItem(M.EMPTY_SELECTION, "p-synthetic-c"), "p-synthetic-c", { amount: null, unit: "serving", times: [], date: null });
  sel = M.settle(sel, "p-synthetic-c", { kind: "saved", label: "Synthetic", doses: 1, intakeDate: "2030-01-01", logged: [{ intake_id: 7, time: null }], skipped: 0 });
  assert.equal(sel[0].attempt, undefined);
  assert.notEqual(M.attemptFor(sel[0], { amount: null, unit: "serving", times: [], date: null }, () => "44444444-4444-4444-8444-444444444444").eventKey, KEY);
});

test("source: the section replays a lost attempt from its stored values and gates Remove and Clear on it", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "app/log/sections/Supplements.tsx"), "utf8");
  assert.match(src, /attemptFor\(item, payload, \(\) => crypto\.randomUUID\(\)\)/, "a new key only through attemptFor");
  assert.match(src, /const hasNewSend = targets\.some\(\(t\) => !t\.attempt\?\.lost\)/, "a replay does not re-check the shared fields");
  assert.match(src, /times: a\.times, date: a\.date, event_key: a\.eventKey/, "the POST carries the attempt's own times, day and key");
  assert.match(src, /disabled=\{saving \|\| busy\[k\] \|\| o\?\.kind === "unconfirmed"\}/, "a lost item cannot be removed from the selection");
  assert.match(src, /disabled=\{batchBusy \|\| anyLost\}/, "Clear waits until no lost attempt is pending");
  assert.match(src, /useState<Selection>\(\(\) => unconfirmedItems\)/, "an unconfirmed save survives a remount of the section");
  assert.match(src, /disabled=\{batchBusy \|\| anyLost\} onChange=\{\(e\) => setDayChoice/, "the Day control is locked while a save is unconfirmed");
  assert.match(src, /disabled=\{batchBusy \|\| anyLost \|\| times\.length >= 12\}/, "adding a time is locked while a save is unconfirmed");
  const lib = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "log-supplement-multi.ts"), "utf8");
  assert.doesNotMatch(lib, /eventKeyFor/, "the old per-item key helper is gone");
});
