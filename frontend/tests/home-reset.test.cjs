// Run: node --test tests/home-reset.test.cjs  (written, not run before merge: AGENTS.md testing policy)
// Apartment reset (lib/home-reset.ts): which single action is shown, partial progress, snooze / paused upkeep,
// missed upkeep periods never pile up, the ops overlay used for save recovery, body checks, and the SQL / route
// boundaries. SYNTHETIC DATA ONLY: invented actions, no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const H = loadTs("lib/home-reset.ts");
const A = "11111111-2222-4333-8444-555555555555";
const B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = new Date("2026-03-10T15:00:00Z"); // 11:00 ET
const item = (over = {}) => ({ id: A, area: "Kitchen", action: "Clear one surface", minutes: 2, remaining: null, status: "open", snoozedUntil: null, partialCount: 0, upkeep: null, upkeepPaused: false, nextDueOn: null, lastDoneOn: null, ...over });
const tap = (action, over = {}) => ({ receiptId: B, itemId: A, action, remaining: null, snoozeUntil: null, ...over });

test("only one action is active: the oldest open, un-snoozed, due item", () => {
  const items = [item({ id: A, snoozedUntil: "2026-03-10T20:00:00Z" }), item({ id: B, action: "Second" })];
  assert.equal(H.activeItem(items, NOW).id, B);
  assert.equal(H.activeItem([item({ status: "done" })], NOW), null);
});

test("snooze hides until the chosen time, then the item returns", () => {
  const it = H.applyTap(item(), tap("snooze", { snoozeUntil: "2026-03-10T19:00:00Z" }), NOW);
  assert.equal(H.activeItem([it], NOW), null);
  assert.equal(H.activeItem([it], new Date("2026-03-10T19:00:01Z")).id, A);
});

test("a snooze is capped at 14 days and never in the past", () => {
  const far = H.applyTap(item(), tap("snooze", { snoozeUntil: "2027-01-01T00:00:00Z" }), NOW);
  assert.equal(Date.parse(far.snoozedUntil), NOW.getTime() + 14 * 86400000);
  assert.equal(H.parseAct({ receipt_id: B, item_id: A, action: "snooze", snooze_until: "2027-01-01T00:00:00Z" }, NOW).ok, false);
});

test("partly done keeps the task open and remembers what is left", () => {
  const it = H.applyTap(item(), tap("partly", { remaining: "the sink" }), NOW);
  assert.equal(it.status, "open");
  assert.equal(it.partialCount, 1);
  assert.equal(it.remaining, "the sink");
  assert.equal(H.activeItem([it], NOW).id, A);
  assert.match(H.whyDue(it, NOW), /started/);
});

test("done without upkeep finishes the item and asks the upkeep question once", () => {
  const it = H.applyTap(item({ remaining: "x", partialCount: 2 }), tap("done"), NOW);
  assert.equal(it.status, "done");
  assert.equal(it.lastDoneOn, "2026-03-10");
  assert.equal(it.remaining, null);
  assert.equal(H.activeItem([it], NOW), null);
  assert.equal(H.upkeepOffer([it]).id, A);
  const declined = H.applyPatch(it, { upkeep: "none" }, NOW);
  assert.equal(H.upkeepOffer([declined]), null);
  assert.equal(declined.status, "done");
});

test("choosing upkeep reopens the item for the next period, not today", () => {
  const done = H.applyTap(item(), tap("done"), NOW);
  const weekly = H.applyPatch(done, { upkeep: "weekly" }, NOW);
  assert.equal(weekly.status, "open");
  assert.equal(weekly.nextDueOn, "2026-03-17");
  assert.equal(H.activeItem([weekly], NOW), null);
  assert.equal(H.activeItem([weekly], new Date("2026-03-17T15:00:00Z")).id, A);
});

test("missed upkeep periods never pile up: the next date counts from the day it was done", () => {
  const weekly = item({ upkeep: "weekly", lastDoneOn: "2026-03-10", nextDueOn: "2026-03-17" });
  const late = new Date("2026-05-01T15:00:00Z"); // weeks later, nothing done
  assert.equal(H.activeItem([weekly], late).id, A); // still ONE open instance
  const done = H.applyTap(weekly, tap("done"), late);
  assert.equal(done.nextDueOn, "2026-05-08");
  assert.equal(done.status, "open");
});

test("paused upkeep stops prompts and resuming does not owe the paused weeks", () => {
  const weekly = item({ upkeep: "weekly", lastDoneOn: "2026-03-10", nextDueOn: "2026-03-17" });
  const paused = H.applyPatch(weekly, { upkeepPaused: true }, NOW);
  assert.equal(H.activeItem([paused], new Date("2026-06-01T15:00:00Z")), null);
  const resumeAt = new Date("2026-06-01T15:00:00Z");
  const resumed = H.applyPatch({ ...paused, status: "done", nextDueOn: null }, { upkeepPaused: false }, resumeAt);
  assert.equal(resumed.nextDueOn, "2026-06-08");
});

test("changing cadence keeps history (lastDoneOn)", () => {
  const weekly = item({ upkeep: "weekly", lastDoneOn: "2026-03-10", nextDueOn: "2026-03-17" });
  const next = H.applyPatch(weekly, { upkeep: "biweekly" }, NOW);
  assert.equal(next.lastDoneOn, "2026-03-10");
  assert.equal(next.upkeep, "biweekly");
});

test("save recovery: unsaved ops are laid over the server list in order and never double-add", () => {
  const ops = [{ kind: "create", item: { id: B, area: "Bedroom", action: "Gather laundry", minutes: 5 } }, { kind: "tap", tap: tap("partly", { itemId: B, remaining: "socks" }) }];
  const a = H.overlayOps([item()], ops, NOW);
  assert.equal(a.length, 2);
  assert.equal(a[1].partialCount, 1);
  const again = H.overlayOps(a, [ops[0]], NOW);
  assert.equal(again.length, 2);
  assert.equal(H.overlayOps([item()], [{ kind: "patch", id: A, patch: { removed: true } }], NOW).length, 0);
});

test("request bodies: strict fields, UUIDs and lengths", () => {
  assert.equal(H.parseNewItem({ id: A, area: "Kitchen", action: "Dishes", minutes: 5 }).ok, true);
  assert.equal(H.parseNewItem({ id: A, area: "Kitchen", action: "Dishes", minutes: 7 }).ok, false);
  assert.equal(H.parseNewItem({ id: "x", area: "K", action: "D", minutes: 5 }).ok, false);
  assert.equal(H.parseNewItem({ id: A, area: "K", action: "D", minutes: 5, extra: 1 }).ok, false);
  assert.equal(H.parseNewItem({ id: A, area: "K", action: "x".repeat(121), minutes: 5 }).ok, false);
  assert.equal(H.parseAct({ receipt_id: B, item_id: A, action: "done" }, NOW).ok, true);
  assert.equal(H.parseAct({ receipt_id: B, item_id: A, action: "wipe" }, NOW).ok, false);
  assert.equal(H.parsePatch({ upkeep: "daily" }).ok, false);
  assert.equal(H.parsePatch({}).ok, false);
  assert.equal(H.parsePatch({ upkeep_paused: true }).ok, true);
});

test("the SQL is additive, service-role only and applies a receipt exactly once", () => {
  const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "home_reset.sql"), "utf8");
  assert.doesNotMatch(sql, /\bDROP\b/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON pds\.home_reset_items, pds\.home_reset_receipts FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /ON CONFLICT \(receipt_id\) DO NOTHING/);
  assert.match(sql, /RETURN 'replayed'/);
});

test("the routes stay behind the owner session and the card never writes on open", () => {
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  assert.doesNotMatch(mw, /home-reset/);
  const panel = fs.readFileSync(path.join(SRC, "components", "HomeResetPanel.tsx"), "utf8");
  assert.doesNotMatch(panel, /useEffect/);
});
