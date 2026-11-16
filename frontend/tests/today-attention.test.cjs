// Run: node --test tests/today-attention.test.cjs
// Today's attention model (src/lib/today-attention.ts, PROD-T04): one normalized list of every open obligation
// Today reads, deduplicated by source identity only, ranked deterministically, budgeted for the quiet view, with
// device-only snooze / "hide here" marks that lapse when the snooze ends or the circumstance changes, and sources
// that could not confirm their answer reported as unknown, never as a clear day. SYNTHETIC DATA ONLY.
// A zone with daylight saving time, so the snooze test can check the two days a year the clock changes. It is also
// the zone email, money and renewal deadlines are dated in, so the tests that build those days on the local clock
// mean Eastern days; the "Eastern deadlines" test switches the device to a zone west of it and back. Set before any
// Date is made.
process.env.TZ = "America/New_York";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const A = loadTs("lib/today-attention.ts");
const NOW = new Date(2030, 2, 5, 9, 0, 0); // local 09:00
const MS = NOW.getTime();
const H = 3_600_000;
const iso = (offsetMs) => new Date(MS + offsetMs).toISOString();

const ok = { load: "ready", asOf: iso(-5 * 60_000) };
const base = (over = {}) => ({
  id: "agents:R1",
  source: "agents",
  title: "Synthetic request",
  detail: null,
  href: "/agents?t=x#m1",
  external: false,
  urgency: "normal",
  dueAt: null,
  reason: "Synthetic reason",
  version: "v1",
  learning: false,
  ...over,
});
const quiet = (list, sources = [], over = {}) => A.selectQuiet(list, sources, { budget: 3, learning: true, marks: {}, nowMs: MS, ...over });

test("source: import-free at run time (bundled by name in tests/today-regression.cjs)", () => {
  const src = fs.readFileSync(path.join(SRC, "lib", "today-attention.ts"), "utf8");
  for (const line of src.split(/\r?\n/)) if (/^\s*import\s/.test(line)) assert.match(line, /^\s*import type\s/, line);
  const ts = require("typescript");
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  assert.ok(!/\brequire\(/.test(out), "no run-time require in the transpiled module");
});

test("dedup: only by stable source identity; the same wording under two ids stays two", () => {
  const a = base({ id: "agents:R1", title: "Reply to the synthetic note" });
  const b = base({ id: "agents:R2", title: "Reply to the synthetic note" });
  const c = base({ id: "urgent-email:email:thread:x", source: "urgent-email", title: "Reply to the synthetic note" });
  const out = A.collectObligations([[a, b], [c]]);
  assert.deepEqual(out.map((o) => o.id), ["agents:R1", "agents:R2", "urgent-email:email:thread:x"], "similar wording never merges");
  // The same identity seen twice is one obligation, its more urgent copy.
  const again = A.collectObligations([[base({ id: "agents:R1", urgency: "normal" })], [base({ id: "agents:R1", urgency: "urgent", reason: "Expires soon" })]]);
  assert.equal(again.length, 1);
  assert.equal(again[0].urgency, "urgent");
  assert.equal(again[0].reason, "Expires soon");
});

test("ranking: deterministic and explainable (tier, due time, source order, id) whatever the input order", () => {
  const list = [
    base({ id: "reading:b", source: "reading", urgency: "low", learning: true }),
    base({ id: "money:budget:x", source: "money", urgency: "high" }),
    base({ id: "agents:Z", urgency: "urgent", dueAt: MS + 3 * H }),
    base({ id: "agents:A", urgency: "urgent", dueAt: MS + 1 * H }),
    base({ id: "calendar:k", source: "calendar", urgency: "high", dueAt: MS + H }),
    base({ id: "urgent-email:email:k", source: "urgent-email", urgency: "high" }),
    base({ id: "agents:B", urgency: "normal" }),
    base({ id: "agents:C", urgency: "normal" }),
  ];
  const expected = ["agents:A", "agents:Z", "calendar:k", "urgent-email:email:k", "money:budget:x", "agents:B", "agents:C", "reading:b"];
  assert.deepEqual(A.rankObligations(list).map((o) => o.id), expected);
  for (let i = 0; i < 10; i++) {
    const shuffled = list.slice().sort(() => Math.random() - 0.5);
    assert.deepEqual(A.rankObligations(shuffled).map((o) => o.id), expected, "same input, same order");
  }
  for (const o of A.rankObligations(list)) assert.ok(o.reason && o.reason.length > 0, "every item carries its reason");
});

test("budget: ordinary items fill it; urgent items bypass it and say so", () => {
  const list = [
    base({ id: "agents:U1", urgency: "urgent", reason: "Expires in 2 h" }),
    base({ id: "agents:U2", urgency: "urgent", reason: "Expires in 3 h" }),
    base({ id: "agents:U3", urgency: "urgent", reason: "Expires in 4 h" }),
    base({ id: "agents:N1" }),
    base({ id: "agents:N2" }),
  ];
  const one = quiet(list, [], { budget: 1 });
  assert.deepEqual(one.shown.map((s) => [s.item.id, s.overBudget]), [["agents:U1", false], ["agents:U2", true], ["agents:U3", true]]);
  assert.equal(one.urgentOver, 2, "the overflow is counted for the visible note");
  assert.equal(one.more, 2, "the ordinary items wait in the full list");
  const three = quiet(list.slice(3), [], { budget: 3 });
  assert.deepEqual(three.shown.map((s) => s.item.id), ["agents:N1", "agents:N2"]);
  assert.equal(three.more, 0);
  assert.equal(A.clampBudget(0), 1);
  assert.equal(A.clampBudget(99), 5);
  assert.equal(A.clampBudget("3"), A.DEFAULT_BUDGET, "junk falls back to the default");
});

test("learning action: at most one, optional, never counted as an obligation", () => {
  const read = base({ id: "reading:book", source: "reading", urgency: "low", learning: true });
  const on = quiet([read], [{ source: "reading", label: "Reading", state: "ok", note: "checked" }]);
  assert.equal(on.learning.id, "reading:book");
  assert.equal(on.shown.length, 0);
  assert.equal(on.verdict, "clear", "a reading suggestion does not make the day not clear");
  const off = quiet([read], [], { learning: false });
  assert.equal(off.learning, null);
  assert.equal(off.more, 0);
});

test("unknown: a source that is checking, failed, stale or partial never yields an all-clear", () => {
  const healthy = [A.sourceStatus("agents", ok, NOW), A.sourceStatus("money", ok, NOW)];
  assert.equal(quiet([], healthy).verdict, "clear");
  for (const probe of [
    { load: "loading" },
    { load: "error" },
    { load: "ready", refreshFailed: true, asOf: iso(-2 * H) },
    { load: "ready", partial: true },
    { load: "ready", syncLate: true, asOf: iso(-6 * H) },
    { load: "ready", checking: true },
  ]) {
    const s = A.sourceStatus("calendar", probe, NOW);
    assert.ok(A.isUnknown(s.state), JSON.stringify(probe));
    const sel = quiet([], [...healthy, s]);
    assert.equal(sel.verdict, "unknown", `${JSON.stringify(probe)} is not a clear day`);
    assert.deepEqual(sel.unknown.map((u) => u.source), ["calendar"]);
  }
  // Not connected is a normal answer (nothing to confirm), reported apart.
  const off = A.sourceStatus("packages", { load: "ready", connected: false }, NOW);
  assert.equal(off.state, "not_connected");
  assert.equal(quiet([], [...healthy, off]).verdict, "clear");
  assert.deepEqual(quiet([], [...healthy, off]).notConnected.map((s) => s.source), ["packages"]);
  // With items to show the unknown sources are still listed (the page warns that something may be missing).
  const withItems = quiet([base()], [A.sourceStatus("money", { load: "error" }, NOW)]);
  assert.equal(withItems.verdict, "items");
  assert.equal(withItems.unknown.length, 1);
});

test("not connected is trusted only from a current answer: a cached one being refreshed, or whose refresh failed, is unknown", () => {
  const failed = A.sourceStatus("packages", { load: "ready", connected: false, refreshFailed: true, asOf: iso(-2 * H) }, NOW);
  assert.equal(failed.state, "stale");
  const checking = A.sourceStatus("packages", { load: "ready", connected: false, checking: true }, NOW);
  assert.equal(checking.state, "checking");
  const partial = A.sourceStatus("urgent-email", { load: "ready", connected: false, partial: true }, NOW);
  assert.equal(partial.state, "partial");
  const healthy = [A.sourceStatus("agents", ok, NOW)];
  for (const st of [failed, checking, partial]) assert.equal(quiet([], [...healthy, st]).verdict, "unknown", `${st.state} is never "every source answered"`);
  assert.equal(A.sourceStatus("packages", { load: "ready", connected: false }, NOW).state, "not_connected", "a current answer is");
});

test("retry: a failed check that later succeeds turns unknown into an answer", () => {
  const failed = A.sourceStatus("urgent-email", { load: "error" }, NOW);
  assert.equal(failed.state, "failed");
  assert.equal(failed.note, "couldn't check");
  const stale = A.sourceStatus("urgent-email", { load: "ready", refreshFailed: true, asOf: iso(-20 * 60_000) }, NOW);
  assert.equal(stale.state, "stale");
  assert.match(stale.note, /couldn't refresh; showing the check from 20 min ago/);
  const recovered = A.sourceStatus("urgent-email", { load: "ready", asOf: iso(-60_000) }, NOW);
  assert.equal(recovered.state, "ok");
  assert.equal(recovered.note, "checked just now");
  assert.equal(quiet([], [failed]).verdict, "unknown");
  assert.equal(quiet([], [recovered]).verdict, "clear");
});

test("marks: a hidden item stays open (full list) and returns when its circumstance changes", () => {
  const item = base({ id: "agents:R9", version: "normal||" });
  const marks = { [A.markKey(item)]: A.markFor(item, "hide", MS) };
  const sel = quiet([item], [], { marks });
  assert.equal(sel.shown.length, 0, "hidden from the quiet list");
  assert.deepEqual(sel.setAside.map((s) => [s.item.id, s.state]), [["agents:R9", "hidden"]]);
  assert.equal(sel.verdict, "set_aside", "set aside is not a clear day either");
  const full = A.fullList([item], marks, MS);
  assert.deepEqual(full.map((l) => [l.item.id, l.state]), [["agents:R9", "hidden"]], "still listed in the full list, still unresolved");
  const changed = { ...item, version: "urgent||" };
  assert.equal(A.markApplies(marks[A.markKey(item)], changed, MS), null, "a materially changed item comes back");
  assert.deepEqual(quiet([changed], [], { marks }).shown.map((s) => s.item.id), ["agents:R9"]);
  // The marks store hashes only, never the obligation's text.
  const stored = JSON.stringify(marks);
  assert.ok(!stored.includes("R9") && !stored.includes("Synthetic"), stored);
});

test("snooze: lasts until 06:00 on the next behavioral day, then the item returns", () => {
  const at = (h, m = 0) => new Date(2030, 2, 5, h, m, 0);
  const six = (d) => new Date(2030, 2, d, 6, 0, 0).getTime();
  assert.equal(A.snoozeUntil(at(9)), six(6), "09:00 -> tomorrow 06:00");
  assert.equal(A.snoozeUntil(at(23, 30)), six(6), "late evening -> tomorrow 06:00");
  assert.equal(A.snoozeUntil(new Date(2030, 2, 6, 1, 0, 0)), six(6), "01:00 (still the previous behavioral day) -> 06:00 the same morning");
  assert.equal(A.snoozeUntil(new Date(2030, 2, 6, 5, 59, 0)), six(6), "05:59 -> 06:00");
  assert.equal(A.snoozeUntil(new Date(2030, 2, 6, 6, 0, 0)), six(7), "06:00 starts a new behavioral day -> next morning");
  const item = base({ id: "money:budget:x", source: "money" });
  const until = A.snoozeUntil(NOW);
  const marks = { [A.markKey(item)]: A.markFor(item, "snooze", MS, until) };
  assert.equal(A.markApplies(marks[A.markKey(item)], item, until - 1), "snoozed");
  assert.equal(A.markApplies(marks[A.markKey(item)], item, until), null, "expired at the snooze time");
  const full = A.fullList([item], marks, MS);
  assert.deepEqual([full[0].state, full[0].until], ["snoozed", until]);
  assert.deepEqual(quiet([item], [], { marks, nowMs: until + 1 }).shown.map((s) => s.item.id), ["money:budget:x"]);
});

test("snooze: the next 06:00 on the local clock, also on the days the clock changes", () => {
  // Clocks go forward 2030-03-10 and back 2030-11-03 in America/New_York (set at the top of this file).
  assert.notEqual(new Date(2030, 2, 9, 12).getTimezoneOffset(), new Date(2030, 2, 11, 12).getTimezoneOffset(), "this zone has daylight saving time");
  const spring = new Date(2030, 2, 10, 6, 30);
  assert.equal(A.snoozeUntil(spring), new Date(2030, 2, 11, 6, 0).getTime(), "spring forward, 06:30: tomorrow 06:00, not 06:00 today (already past)");
  assert.ok(A.snoozeUntil(spring) > spring.getTime(), "a snooze never ends before it starts");
  assert.equal(A.snoozeUntil(new Date(2030, 2, 10, 1, 30)), new Date(2030, 2, 10, 6, 0).getTime());
  assert.equal(A.snoozeUntil(new Date(2030, 10, 3, 5, 30)), new Date(2030, 10, 3, 6, 0).getTime(), "fall back, 05:30: 06:00 the same morning, not a day later");
  assert.equal(A.snoozeUntil(new Date(2030, 10, 3, 6, 30)), new Date(2030, 10, 4, 6, 0).getTime());
});

test("marks: stored copies are validated and pruned (age, count)", () => {
  assert.deepEqual(A.parseMarks(null), {});
  assert.deepEqual(A.parseMarks([1, 2]), {});
  const good = { v: "abc123", hidden: true, at: MS };
  const parsed = A.parseMarks({ k1: good, "BAD KEY": good, k2: { v: 3, at: MS }, k3: { v: "x", at: "now" }, k4: { v: "x", at: MS }, k5: { v: "y", until: MS + H, at: MS } });
  assert.deepEqual(Object.keys(parsed).sort(), ["k1", "k5"], "junk and marks that set nothing aside are dropped");
  const many = {};
  for (let i = 0; i < A.MAX_MARKS + 20; i++) many["m" + i] = { v: "v", hidden: true, at: MS - i };
  many.old = { v: "v", hidden: true, at: MS - A.MARK_KEEP_MS - 1 };
  many.snoozeEnded = { v: "v", until: MS - A.MARK_KEEP_MS - 1, at: MS - A.MARK_KEEP_MS - 2 };
  const pruned = A.pruneMarks(many, MS);
  assert.equal(Object.keys(pruned).length, A.MAX_MARKS);
  assert.ok(!("old" in pruned) && !("snoozeEnded" in pruned));
  assert.ok("m0" in pruned && !("m" + (A.MAX_MARKS + 19) in pruned), "the newest are kept");
  assert.equal(A.attentionHash("x"), A.attentionHash("x"));
  assert.notEqual(A.attentionHash("agents:R1"), A.attentionHash("agents:R2"));
});

test("adapter: agent requests keep the card code; expiry drives urgency; date-only expiry is the end of that day", () => {
  const req = (code, expires, over = {}) => ({ thread: "fixture-agent", messageId: 7, created_at: "2030-03-05 12:00:00", card: { code, agent: "Planning assistant", name: "Synthetic choice", expires, updated: false, ...over } });
  const out = A.requestObligations([
    req("a1", null),
    req("a2", iso(2 * H)),
    req("a3", iso(30 * H)),
    req("a4", iso(-H)),
  ], NOW);
  assert.deepEqual(out.map((o) => [o.id, o.urgency]), [["agents:A1", "normal"], ["agents:A2", "urgent"], ["agents:A3", "high"], ["agents:A4", "normal"]]);
  assert.equal(out[1].reason, "Expires in 2 h");
  assert.equal(out[3].reason, "Its expiry has passed; Planning assistant is still waiting for your answer", "an expired request says so");
  assert.equal(out[0].href, "/agents?t=fixture-agent#m7");
  assert.equal(A.expiryInstant("2030-03-05"), new Date(2030, 2, 5, 23, 59, 59).getTime());
  assert.equal(A.expiryInstant("2030-03-05T23:59:59"), new Date(2030, 2, 5, 23, 59, 59).getTime(), "the Worker's date-only form, local time");
  assert.equal(A.expiryInstant("2030-03-05 12:00:00"), Date.UTC(2030, 2, 5, 12, 0, 0), "the database form is UTC");
  assert.equal(A.expiryInstant("not a date"), null);
  const v1 = req("a5", iso(30 * H));
  const v2 = req("a5", iso(30 * H), { updated: true });
  assert.notEqual(A.requestObligations([v1], NOW)[0].version, A.requestObligations([v2], NOW)[0].version, "an updated card is a new circumstance");
});

test("adapter: urgent email keeps Today's merged key; deadlines and inbox-triage drive urgency", () => {
  const item = (key, over = {}) => ({ key, sources: ["Gmail"], sourceDetail: "Gmail, owner@: Agent/Action", title: "Synthetic subject " + key, from: "Synthetic sender", reasons: [], nextStep: "Reply in Gmail", at: iso(-H), atVerb: "Received", gmailHref: "https://mail.google.com/mail/#all/thread-f:1", requestHref: null, clear: { cards: [], emails: [] }, ...over });
  const email = (key, deadline) => ({ key, threadId: "1", messageId: "m", account: "owner@example.com", from: "x", subject: "s", receivedAt: iso(-H), labels: ["Agent/Deadline"], deadline, reasons: [], nextStep: "x", href: null });
  const out = A.urgentEmailObligations([
    item("email:t1"),
    item("email:t2"),
    item("email:t3"),
    item("card:E9", { sources: ["Agent Inbox"], gmailHref: null, requestHref: "/agents?t=inbox-triage#m3" }),
  ], [email("t2", { daysLeft: 1, label: "Thu, Mar 6" }), email("t3", { daysLeft: 3, label: "Sat, Mar 8" })], NOW);
  assert.deepEqual(out.map((o) => [o.id, o.urgency]), [["urgent-email:email:t1", "normal"], ["urgent-email:email:t2", "urgent"], ["urgent-email:email:t3", "high"], ["urgent-email:card:E9", "urgent"]]);
  assert.equal(out[0].external, true, "a Gmail link opens outside Onyx");
  assert.equal(out[3].external, false);
  assert.equal(out[3].href, "/agents?t=inbox-triage#m3");
  assert.equal(out[1].reason, "Deadline tomorrow (Thu, Mar 6)");
  const later = A.urgentEmailObligations([item("email:t1", { at: iso(-10 * 60_000) })], [], NOW)[0];
  assert.notEqual(later.version, out[0].version, "a newer message in the thread is a new circumstance");
});

test("adapter: an agent request's version follows its message and everything the card says", () => {
  const req = (over = {}, card = {}) => ({ thread: "fixture-agent", messageId: 7, created_at: "2030-03-05 12:00:00", ...over, card: { code: "a1", agent: "Planning assistant", name: "Synthetic choice", details: "Pick one", link: "", expires: null, updated: true, ...card } });
  const v = (r) => A.requestObligations([r], NOW)[0].version;
  assert.equal(v(req()), v(req()));
  assert.notEqual(v(req()), v(req({}, { details: "Pick another one" })), "new instructions under the same title");
  assert.notEqual(v(req()), v(req({}, { link: "https://example.com/synthetic" })), "a new link");
  assert.notEqual(v(req()), v(req({ messageId: 8, created_at: "2030-03-05 13:00:00" })), "the card posted again");
});

test("adapter: urgent email: the deadline countdown keeps a mark, a higher tier or a new date lifts it; unreturned threads are one aggregate", () => {
  const item = (key) => ({ key, sources: ["Gmail"], sourceDetail: "Gmail, owner@: Agent/Deadline", title: "Synthetic subject", from: null, reasons: [], nextStep: "Reply in Gmail", at: iso(-H), atVerb: "Received", gmailHref: null, requestHref: null, clear: { cards: [], emails: [] } });
  const email = (deadline) => ({ key: "t1", threadId: "1", messageId: "m", account: "owner@example.com", from: "x", subject: "s", receivedAt: iso(-H), labels: ["Agent/Deadline"], deadline, reasons: [], nextStep: "x", href: null });
  const at = (daysLeft, label = "Sat, Mar 8") => A.urgentEmailObligations([item("email:t1")], [email({ daysLeft, label })], NOW)[0];
  assert.equal(at(3).version, at(2).version, "the next morning alone is not a new circumstance");
  assert.notEqual(at(2).version, at(1).version, "crossing into urgent is");
  assert.notEqual(at(3, "Sun, Mar 9").version, at(3).version, "a new deadline date is");
  const withRest = A.urgentEmailObligations([item("email:t1")], [], NOW, 7);
  assert.deepEqual(withRest.map((o) => [o.id, o.aggregate ?? false]), [["urgent-email:email:t1", false], ["urgent-email:more", true]]);
  assert.equal(withRest[1].title, "7 more labelled emails not listed here");
  assert.equal(A.urgentEmailObligations([item("email:t1")], [], NOW, 0).length, 1);
});

test("adapter: packages are versioned by which orders are in each group; a count Today cannot name is never set aside", () => {
  const ready = (over = {}) => ({ status: "ready", attention: 1, arrivingToday: 1, onTheWay: 2, top: [{ merchant: "Synthetic store", label: "Item", reason: "Late" }], attentionVersion: "aaaa", arrivingVersion: "bbbb", ...over });
  const [att, arr] = A.packageObligations(ready());
  const [att2, arr2] = A.packageObligations(ready({ attentionVersion: "cccc", arrivingVersion: "dddd" }));
  assert.notEqual(att.version, att2.version, "a different package with the same count is a new circumstance");
  assert.notEqual(arr.version, arr2.version);
  assert.ok(!att.aggregate && !arr.aggregate);
  // An older answer without the fingerprints: the listed orders identify the group only when they are all of it.
  const old = A.packageObligations(ready({ attentionVersion: undefined, arrivingVersion: undefined }));
  assert.deepEqual(old.map((o) => o.aggregate ?? false), [false, true]);
  const big = A.packageObligations(ready({ attention: 5, attentionVersion: undefined, arrivingVersion: undefined }))[0];
  assert.equal(big.aggregate, true);
  const marks = { [A.markKey(big)]: A.markFor(big, "hide", MS) };
  assert.deepEqual(quiet([big], [], { marks }).shown.map((x) => x.item.id), ["packages:attention"], "a mark never applies to an aggregate");
  assert.equal(A.fullList([big], marks, MS)[0].state, "open");
  assert.equal(A.renewalObligations({ status: "ready", count: 3, withinDays: 3, soon: [] })[0].aggregate, true);
});

test("adapter: money alerts get an identity from kind + subject, numbered on a repeat; amount drift is not a change", () => {
  const alert = (kind, title, severity = "medium") => ({ kind, severity, title, detail: "Synthetic.", href: "/financials/budgets" });
  const out = A.moneyObligations([alert("budget", "Synthetic A: heading $40 over budget"), alert("budget", "Synthetic A: heading $45 over budget"), alert("promo", "Synthetic card: 0% ends Aug 1", "high")]);
  assert.deepEqual(out.map((o) => o.id), ["money:budget:Synthetic A", "money:budget:Synthetic A#2", "money:promo:Synthetic card"]);
  assert.equal(out[2].urgency, "high");
  const drift = A.moneyObligations([alert("budget", "Synthetic A: heading $41 over budget")])[0];
  assert.equal(drift.version, out[0].version, "a dollar of drift keeps the version (a snooze stays)");
  const over = A.moneyObligations([alert("budget", "Synthetic A: $40 over budget", "high")])[0];
  assert.notEqual(over.version, out[0].version, "heading over -> over is a new circumstance");
});

test("adapter: renewals, packages, calendar, experiment, reading", () => {
  const ren = A.renewalObligations({ status: "ready", count: 3, withinDays: 3, soon: [{ merchant: "Synthetic plan", days: 2, date: "2030-03-07", label: "renews in 2 days" }, { merchant: "Synthetic box", days: 0, date: "2030-03-05", label: "renews today" }] });
  assert.deepEqual(ren.map((o) => [o.id, o.urgency]), [["renewals:Synthetic plan:2030-03-07", "normal"], ["renewals:Synthetic box:2030-03-05", "high"], ["renewals:more", "low"]]);
  const tomorrow = A.renewalObligations({ status: "ready", count: 1, withinDays: 3, soon: [{ merchant: "Synthetic plan", days: 1, date: "2030-03-07", label: "renews tomorrow" }] })[0];
  assert.equal(tomorrow.version, ren[0].version, "the countdown alone is not a new circumstance");
  assert.deepEqual(A.renewalObligations({ status: "empty" }), []);
  assert.deepEqual(A.renewalObligations(null), []);
  const pk = A.packageObligations({ status: "ready", attention: 2, arrivingToday: 1, onTheWay: 4, top: [{ merchant: "Synthetic store", label: "Late", reason: "No update in 9 days" }] });
  assert.deepEqual(pk.map((o) => o.id), ["packages:attention", "packages:arriving"]);
  assert.deepEqual(A.packageObligations({ status: "not_connected" }), []);
  const ev = (key, startOffset, over = {}) => ({ key, title: "Synthetic " + key, allDay: false, startAt: iso(startOffset), endAt: iso(startOffset + H), startDate: "2030-03-05", endDate: "2030-03-05", calendar: "main", account: "acct", location: null, status: "confirmed", recurring: false, ...over });
  const cal = A.calendarObligations([ev("soon", 45 * 60_000), ev("later", 5 * H), ev("past", -10 * 60_000), ev("day", 0, { allDay: true, startAt: null, endAt: null })], NOW);
  assert.deepEqual(cal.map((o) => [o.id, o.reason]), [["calendar:soon", "Starts in 45 min"]], "only timed events starting within 2 h");
  assert.deepEqual(A.experimentObligations({ status: "none" }), []);
  const arm = A.experimentObligations({ status: "active", experimentId: "EXP-901", behavioralDate: "2030-03-05", arm: "A", instruction: "Synthetic instruction." });
  assert.deepEqual([arm[0].id, arm[0].href, arm[0].urgency], ["experiment:EXP-901:2030-03-05", null, "high"]);
  const overview = (over = {}) => ({ book: { slug: "synthetic-book", title: "A synthetic book", status: "reading" }, today: "2030-03-05", chaptersDone: 3, totalChapters: 12, streak: { current: 4, loggedToday: false, atRisk: true }, dueReviews: [], ...over });
  const r = A.readingObligations(overview());
  assert.deepEqual([r[0].id, r[0].learning, r[0].reason], ["reading:synthetic-book", true, "Keep your 4-day streak"]);
  assert.deepEqual(A.readingObligations(overview({ streak: { current: 4, loggedToday: true, atRisk: false } })), [], "logged today: nothing to suggest");
  assert.deepEqual(A.readingObligations(overview({ book: { slug: "x", title: "x", status: "finished" } })), []);
  assert.deepEqual(A.readingObligations(null), []);
  assert.notEqual(A.readingObligations(overview({ today: "2030-03-06" }))[0].version, r[0].version, "a new behavioral day: yesterday's mark lapses");
});

test("todayAttention: every source in one call, the experiment only when given", () => {
  const empty = { probe: ok };
  const input = {
    now: NOW,
    requests: { ...empty, items: [] },
    urgentEmail: { ...empty, items: [], emails: [] },
    calendar: { ...empty, events: [] },
    money: { ...empty, alerts: [] },
    renewals: { ...empty, summary: { status: "ready", count: 0, soon: [], withinDays: 3 } },
    packages: { ...empty, summary: { status: "ready", attention: 0, arrivingToday: 0, onTheWay: 0, top: [] } },
    reading: { ...empty, overview: null },
  };
  const a = A.todayAttention(input);
  assert.deepEqual(a.obligations, []);
  assert.deepEqual(a.sources.map((s) => s.source), ["urgent-email", "agents", "calendar", "money", "renewals", "packages", "reading"]);
  assert.equal(A.selectQuiet(a.obligations, a.sources, { budget: 3, learning: true, marks: {}, nowMs: MS }).verdict, "clear");
  const b = A.todayAttention({ ...input, experiment: { probe: { load: "loading" }, trial: null } });
  assert.ok(b.sources.some((s) => s.source === "experiment"));
  assert.equal(A.selectQuiet(b.obligations, b.sources, { budget: 3, learning: true, marks: {}, nowMs: MS }).verdict, "unknown", "an arm still being checked is not a clear day");
});

test("pinned: today's experiment arm is never cut by the budget, snoozed or hidden", () => {
  const arm = A.experimentObligations({ status: "active", experimentId: "EXP-901", behavioralDate: "2030-03-05", arm: "A", instruction: "Synthetic instruction." })[0];
  assert.equal(arm.pinned, true);
  const list = [
    base({ id: "urgent-email:email:t1", source: "urgent-email", urgency: "urgent" }),
    base({ id: "urgent-email:email:t2", source: "urgent-email", urgency: "urgent" }),
    arm,
    base({ id: "agents:N1" }),
  ];
  const one = quiet(list, [], { budget: 1 });
  assert.deepEqual(one.shown.map((s) => [s.item.id, s.overBudget]), [["urgent-email:email:t1", false], ["urgent-email:email:t2", true], [arm.id, true]], "urgent first, then the arm, both past the budget");
  assert.equal(one.urgentOver, 1);
  assert.equal(one.more, 1, "the ordinary item waits in the full list");
  const marks = { [A.markKey(arm)]: A.markFor(arm, "hide", MS) };
  const marked = quiet([arm], [], { marks });
  assert.deepEqual(marked.shown.map((s) => s.item.id), [arm.id], "a mark never applies to the arm");
  assert.deepEqual(marked.setAside, []);
  assert.equal(A.fullList([arm], marks, MS)[0].state, "open");
});

test("sync freshness: missing, unreadable, old or failed is late, never a current answer", () => {
  const STALE = 3 * H;
  assert.equal(A.syncLateness(null, MS, STALE), true, "never ran, or its heartbeat could not be read");
  assert.equal(A.syncLateness(undefined, MS, STALE), true);
  assert.equal(A.syncLateness({ at: "not a time", status: "success" }, MS, STALE), true);
  assert.equal(A.syncLateness({ at: iso(-4 * H), status: "success" }, MS, STALE), true);
  assert.equal(A.syncLateness({ at: iso(-10 * 60_000), status: "failed" }, MS, STALE), true);
  assert.equal(A.syncLateness({ at: iso(-10 * 60_000), status: "success" }, MS, STALE), false);
  const never = A.sourceStatus("urgent-email", { load: "ready", syncLate: true, syncAt: null, asOf: iso(-60_000) }, NOW);
  assert.equal(never.state, "stale");
  assert.equal(never.note, "its sync hasn't reported a run, so items may be missing");
  const late = A.sourceStatus("packages", { load: "ready", syncLate: true, syncAt: iso(-7 * H), asOf: iso(-60_000) }, NOW);
  assert.equal(late.note, "its sync is late (last ran 7 h ago); newer items may be missing", "the note names the sync's own time, not the check's");
  assert.equal(quiet([], [never]).verdict, "unknown");
});

test("versions: a budget alert is per month, a calendar event follows what it says, repeated renewals stay apart", () => {
  const alert = { kind: "budget", severity: "high", title: "Synthetic A: $40 over budget", detail: "Synthetic.", href: "/financials/budgets" };
  const nov = A.moneyObligations([alert], "2030-11")[0];
  assert.equal(A.moneyObligations([alert], "2030-11")[0].version, nov.version);
  assert.notEqual(A.moneyObligations([alert], "2030-12")[0].version, nov.version, "next month's alert is a new circumstance");
  const promo = { ...alert, kind: "promo", title: "Synthetic card: 0% ends Aug 1" };
  assert.equal(A.moneyObligations([promo], "2030-11")[0].version, A.moneyObligations([promo], "2030-12")[0].version, "only budgets are monthly");
  const ev = (over = {}) => ({ key: "e1", title: "Synthetic meeting", allDay: false, startAt: iso(30 * 60_000), endAt: iso(90 * 60_000), startDate: "2030-03-05", endDate: "2030-03-05", calendar: "main", account: "acct", location: "Room 1", status: "confirmed", recurring: false, ...over });
  const v = (e) => A.calendarObligations([e], NOW)[0].version;
  assert.notEqual(v(ev({ location: "Room 2" })), v(ev()), "a new place is a new circumstance");
  assert.notEqual(v(ev({ title: "Synthetic meeting (moved)" })), v(ev()), "a new title is");
  const same = { merchant: "Synthetic plan", days: 1, date: "2030-03-06", label: "renews tomorrow" };
  const ren = A.renewalObligations({ status: "ready", count: 2, withinDays: 3, soon: [same, { ...same }] });
  assert.deepEqual(ren.map((o) => o.id), ["renewals:Synthetic plan:2030-03-06", "renewals:Synthetic plan:2030-03-06#2"], "same name and date: still two");
  assert.equal(A.collectObligations([ren]).length, 2);
});

test("due time: a snooze or hide never keeps an item out of sight past its own due time", () => {
  const req = (code, expiresMs) => ({ thread: "fixture-agent", messageId: 7, created_at: "2030-03-05 12:00:00", card: { code, agent: "Planning assistant", name: "Synthetic choice " + code, expires: iso(expiresMs), updated: false } });
  // Expires in 2 h (urgent): a snooze ends DUE_LEAD_MS before the expiry, not at 06:00 tomorrow.
  const soon = A.requestObligations([req("d1", 2 * H)], NOW)[0];
  assert.equal(soon.urgency, "urgent");
  assert.equal(A.canSetAside(soon, MS), true);
  assert.equal(A.snoozeEnd(soon, NOW), MS + 2 * H - A.DUE_LEAD_MS);
  const snooze = { [A.markKey(soon)]: A.markFor(soon, "snooze", MS, A.snoozeEnd(soon, NOW)) };
  assert.equal(A.markApplies(snooze[A.markKey(soon)], soon, MS + H - 1), "snoozed");
  assert.equal(A.markApplies(snooze[A.markKey(soon)], soon, MS + H), null, "back before it expires");
  // A hide lapses at the same instant, and so does a snooze stored with a later end.
  const hide = { [A.markKey(soon)]: A.markFor(soon, "hide", MS) };
  assert.equal(A.markApplies(hide[A.markKey(soon)], soon, MS + H - 1), "hidden");
  assert.equal(A.markApplies(hide[A.markKey(soon)], soon, MS + H), null);
  const late = { [A.markKey(soon)]: A.markFor(soon, "snooze", MS, A.snoozeUntil(NOW)) };
  assert.equal(A.markApplies(late[A.markKey(soon)], soon, MS + H), null, "a snooze from before the cap still ends at the due time");
  assert.deepEqual(A.fullList([soon], hide, MS).map((l) => [l.state, l.until]), [["hidden", MS + H]], "the full list says when it comes back");
  const sel = quiet([soon], [], { marks: hide });
  assert.deepEqual(sel.setAside.map((s) => [s.state, s.until]), [["hidden", MS + H]]);
  assert.equal(sel.nextChange, MS + H, "the page renders again when it is due");
  assert.deepEqual(quiet([soon], [], { marks: hide, nowMs: MS + H }).shown.map((s) => s.item.id), [soon.id]);
  // Expires in 30 min: already inside the lead, so it cannot be set aside and an old mark does not apply.
  const now30 = A.requestObligations([req("d2", 30 * 60_000)], NOW)[0];
  assert.equal(A.canSetAside(now30, MS), false);
  assert.equal(A.markApplies(A.markFor(now30, "hide", MS - H), now30, MS), null);
  // An email whose deadline is today is due now; one due tomorrow snoozes until the start of that day at the latest.
  const item = (key) => ({ key, sources: ["Gmail"], sourceDetail: "Gmail", title: "Synthetic " + key, from: null, reasons: [], nextStep: "Reply", at: iso(-H), atVerb: "Received", gmailHref: null, requestHref: null, clear: { cards: [], emails: [] } });
  const email = (key, daysLeft) => ({ key, threadId: "1", messageId: "m" + key, account: "owner@example.com", from: "x", subject: "s", receivedAt: iso(-H), labels: ["Agent/Deadline"], deadline: { daysLeft, label: "Synthetic day " + daysLeft }, reasons: [], nextStep: "x", href: null });
  const [today, tomorrow] = A.urgentEmailObligations([item("email:t0"), item("email:t1")], [email("t0", 0), email("t1", 1)], NOW);
  assert.equal(A.canSetAside(today, MS), false, "a deadline today cannot be snoozed or hidden");
  assert.equal(A.markApplies(A.markFor(today, "hide", MS - 24 * H), today, MS), null, "nor stay hidden from yesterday");
  assert.equal(A.snoozeEnd(tomorrow, NOW), new Date(2030, 2, 6, 0, 0, 0).getTime(), "back at the start of the deadline day, before 06:00");
  // A calendar event: back DUE_LEAD_MS before it starts; inside that, it stays.
  const ev = (key, startMs) => ({ key, title: "Synthetic " + key, allDay: false, startAt: iso(startMs), endAt: iso(startMs + H), startDate: "2030-03-05", endDate: "2030-03-05", calendar: "main", account: "acct", location: null, status: "confirmed", recurring: false });
  const [in90, in45] = A.calendarObligations([ev("e90", 90 * 60_000), ev("e45", 45 * 60_000)], NOW);
  assert.equal(A.snoozeEnd(in90, NOW), MS + 30 * 60_000);
  assert.equal(A.canSetAside(in45, MS), false);
  // No due time: the ordinary snooze, and nothing to wait for.
  const plain = base({ id: "agents:P1" });
  assert.equal(A.snoozeEnd(plain, NOW), A.snoozeUntil(NOW));
  assert.equal(A.canSetAside(plain, MS), true);
  assert.equal(quiet([plain], []).nextChange, null);
});

test("money: an alert dated today or tomorrow is urgent and bypasses the budget", () => {
  const alert = (kind, due, severity = "high", title = `Synthetic ${kind}: due soon`) => ({ kind, severity, title, detail: "Synthetic.", href: "/financials/forecast", ...(due ? { due } : {}) });
  const out = A.moneyObligations([
    alert("tax", "2030-03-06"),
    alert("tax", "2030-03-05", "high", "Synthetic other tax: due today"),
    alert("tax", "2030-03-10", "high", "Synthetic later tax: due later"),
    alert("promo", "2030-03-06", "medium"),
    alert("low-cash", "2030-03-06", "medium"),
    alert("low-cash", "2030-03-06", "high", "Synthetic cash: likely below the line"),
    alert("tax", null, "high", "Synthetic undated tax: stored before the field"),
  ], "2030-03", NOW);
  assert.deepEqual(out.map((o) => o.urgency), ["urgent", "urgent", "high", "urgent", "normal", "urgent", "high"]);
  assert.deepEqual([out[0].reason, out[1].reason, out[3].reason, out[5].reason], ["A tax payment is due tomorrow", "A tax payment is due today", "A 0% promo ends tomorrow", "Cash may drop below your line tomorrow"]);
  assert.equal(out[0].dueAt, new Date(2030, 2, 6, 23, 59, 59, 999).getTime(), "ranked by the end of its day, like an email deadline");
  assert.equal(out[0].resurfaceAt, new Date(2030, 2, 6, 0, 0, 0).getTime());
  assert.equal(A.canSetAside(out[1], MS), false, "due today: cannot be set aside");
  assert.equal(out[6].dueAt, null, "no readable date: no deadline (as before)");
  // Crossing into the urgent tier is a new circumstance: a mark made two days before lapses.
  const tax = alert("tax", "2030-03-07");
  const before = A.moneyObligations([tax], "", NOW)[0];
  const after = A.moneyObligations([tax], "", new Date(2030, 2, 6, 9, 0, 0))[0];
  assert.deepEqual([before.urgency, after.urgency], ["high", "urgent"]);
  assert.notEqual(before.version, after.version);
  // Budget 1 with two ordinary items: the tax payment due tomorrow is still shown, first.
  const list = [base({ id: "agents:N1", urgency: "high" }), base({ id: "agents:N2" }), out[0]];
  const sel = quiet(list, [], { budget: 1 });
  assert.deepEqual(sel.shown.map((s) => s.item.id), [out[0].id]);
  assert.equal(sel.more, 2);
});

test("money: a low-cash alert dated by its first day below the line cannot be hidden past that day", () => {
  // The cautious path crosses the line today; the lowest point is later in the month (finance-alerts.ts dates the
  // alert by the crossing, keeps the lowest day for its title).
  const cash = (severity) => ({ kind: "low-cash", severity, title: "Cash may drop to -$500 around Mar 25", detail: "Synthetic.", href: "/financials/forecast", due: "2030-03-05", lowest: "2030-03-25" });
  const [likely, cautious] = A.moneyObligations([cash("high"), { ...cash("medium"), title: "Synthetic second: cautious only" }], "2030-03", NOW);
  assert.deepEqual([likely.urgency, likely.reason], ["urgent", "Cash may drop below your line today"]);
  assert.equal(cautious.urgency, "normal", "the likely path stays above the line: its ordinary tier");
  for (const o of [likely, cautious]) {
    assert.equal(o.resurfaceAt, new Date(2030, 2, 5, 0, 0, 0).getTime());
    assert.equal(A.canSetAside(o, MS), false, "below the line today: cannot be snoozed or hidden");
    assert.equal(A.markApplies(A.markFor(o, "hide", MS - 24 * H), o, MS), null, "nor stay hidden from yesterday");
  }
  // Urgent alerts reach the urgent list past the budget.
  const sel = quiet([base({ id: "agents:N1", urgency: "high" }), likely], [], { budget: 1 });
  assert.deepEqual(sel.shown.map((s) => [s.item.id, s.overBudget]), [[likely.id, false]]);
});

test("money: the likely path below the line tomorrow is urgent even when the cautious low point is later", () => {
  // The cautious path is lowest late in the month, where the likely balance is back above the line, but the likely
  // balance is negative tomorrow (finance-alerts.ts likelyDue). Severity alone would leave it in the ordinary tier.
  const cash = { kind: "low-cash", severity: "medium", title: "Cash may drop to -$900 around Mar 25", detail: "Synthetic.", href: "/financials/forecast", due: "2030-03-06", lowest: "2030-03-25", likelyDue: "2030-03-06" };
  const [o] = A.moneyObligations([cash], "2030-03", NOW);
  assert.deepEqual([o.urgency, o.reason], ["urgent", "Cash may drop below your line tomorrow"]);
  assert.equal(o.resurfaceAt, new Date(2030, 2, 6, 0, 0, 0).getTime());
  const sel = quiet([base({ id: "agents:N1", urgency: "high" }), base({ id: "agents:N2", urgency: "high" }), o], [], { budget: 1 });
  assert.ok(sel.shown.some((s) => s.item.id === o.id), "never budgeted out");
  // The likely path's day comes first even when the alert's own date is later: it is the deadline.
  const [early] = A.moneyObligations([{ ...cash, due: "2030-03-20", likelyDue: "2030-03-05" }], "", NOW);
  assert.deepEqual([early.urgency, early.reason], ["urgent", "Cash may drop below your line today"]);
  assert.equal(early.resurfaceAt, new Date(2030, 2, 5, 0, 0, 0).getTime());
  assert.equal(A.canSetAside(early, MS), false);
  // A likely breach weeks away keeps the alert's tier; its first day is still the deadline for a mark.
  const [later] = A.moneyObligations([{ ...cash, severity: "high", due: "2030-03-20", likelyDue: "2030-03-22" }], "", NOW);
  assert.equal(later.urgency, "high");
  assert.equal(later.resurfaceAt, new Date(2030, 2, 20, 0, 0, 0).getTime());
});

test("urgent email: a request merged into a thread keeps its expiry; a snooze or hide lapses before it", () => {
  const item = (key, over = {}) => ({ key, sources: ["Gmail", "Agent Inbox"], sourceDetail: "Gmail + Agent Inbox", title: "Synthetic " + key, from: null, reasons: [], nextStep: "Reply", at: iso(-H), atVerb: "Received", gmailHref: null, requestHref: "/agents?t=inbox-triage#m1", clear: { cards: ["E1"], emails: [] }, ...over });
  const [merged, alone, none] = A.urgentEmailObligations([
    item("email:t1", { cardExpires: [iso(5 * H), iso(2 * H)] }),
    item("card:E2", { sources: ["Agent Inbox"], clear: { cards: ["E2"], emails: [] }, cardExpires: [iso(3 * H)] }),
    item("email:t3", { cardExpires: [] }),
  ], [], NOW);
  assert.equal(merged.urgency, "urgent");
  assert.equal(merged.reason, "inbox-triage flagged it as urgent; the request expires in 2 h", "the earliest expiry counts");
  assert.equal(merged.dueAt, MS + 2 * H);
  assert.equal(merged.resurfaceAt, MS + 2 * H - A.DUE_LEAD_MS);
  assert.equal(A.snoozeEnd(merged, NOW), MS + H, "a snooze ends an hour before the request expires, not at 06:00");
  const hide = { [A.markKey(merged)]: A.markFor(merged, "hide", MS) };
  assert.equal(A.markApplies(hide[A.markKey(merged)], merged, MS + H - 1), "hidden");
  assert.equal(A.markApplies(hide[A.markKey(merged)], merged, MS + H), null, "back before it expires");
  assert.equal(quiet([merged], [], { marks: hide }).nextChange, MS + H);
  assert.equal(alone.resurfaceAt, MS + 3 * H - A.DUE_LEAD_MS, "a request with no labelled thread too");
  assert.equal(none.resurfaceAt, null, "no expiry and no deadline: no due time");
  // An email deadline tomorrow and a request expiring sooner: the request comes first.
  const email = { key: "t4", threadId: "4", messageId: "m4", account: "owner@example.com", from: "x", subject: "s", receivedAt: iso(-H), labels: ["Agent/Deadline"], deadline: { daysLeft: 1, label: "Thu, Mar 6", date: "2030-03-06" }, reasons: [], nextStep: "x", href: null };
  const both = A.urgentEmailObligations([item("email:t4", { cardExpires: [iso(4 * H)] })], [email], NOW)[0];
  assert.equal(both.resurfaceAt, MS + 3 * H);
  assert.equal(both.reason, "Deadline tomorrow (Thu, Mar 6)");
  assert.notEqual(A.urgentEmailObligations([item("email:t1", { cardExpires: [iso(6 * H)] })], [], NOW)[0].version, merged.version, "a new expiry is a new circumstance");
});

test("urgent email: a deadline keeps its own day past midnight when the refresh failed", () => {
  const item = { key: "email:t1", sources: ["Gmail"], sourceDetail: "Gmail", title: "Synthetic subject", from: null, reasons: [], nextStep: "Reply", at: iso(-H), atVerb: "Received", gmailHref: null, requestHref: null, clear: { cards: [], emails: [] } };
  // The answer read on Mar 5 (deadline tomorrow), kept on screen after its refresh failed.
  const cached = { key: "t1", threadId: "1", messageId: "m", account: "owner@example.com", from: "x", subject: "s", receivedAt: iso(-H), labels: ["Agent/Deadline"], deadline: { daysLeft: 1, label: "Thu, Mar 6", date: "2030-03-06" }, reasons: [], nextStep: "x", href: null };
  const before = A.urgentEmailObligations([item], [cached], NOW)[0];
  assert.equal(before.reason, "Deadline tomorrow (Thu, Mar 6)");
  assert.equal(before.resurfaceAt, new Date(2030, 2, 6, 0, 0, 0).getTime());
  const hide = { [A.markKey(before)]: A.markFor(before, "hide", MS) };
  // After midnight, same cached answer: the deadline is today, not moved to Mar 7.
  const after = new Date(2030, 2, 6, 0, 30, 0);
  const o = A.urgentEmailObligations([item], [cached], after)[0];
  assert.equal(o.reason, "Deadline today (Thu, Mar 6)");
  assert.equal(o.dueAt, new Date(2030, 2, 6, 23, 59, 59, 999).getTime());
  assert.equal(o.resurfaceAt, before.resurfaceAt, "the same day, whatever the countdown said");
  assert.equal(A.canSetAside(o, after.getTime()), false);
  assert.equal(A.markApplies(hide[A.markKey(o)], o, after.getTime()), null, "the hide from yesterday no longer applies");
  assert.deepEqual(A.fullList([o], hide, after.getTime()).map((l) => l.state), ["open"]);
  // A day later still: the deadline has passed, and it says so.
  const passed = A.urgentEmailObligations([item], [cached], new Date(2030, 2, 7, 9, 0, 0))[0];
  assert.deepEqual([passed.urgency, passed.reason], ["urgent", "Deadline passed (Thu, Mar 6)"]);
});

test("urgent email: a request posted on a merged thread is a new circumstance; codes in any order are the same one", () => {
  const item = (cards, requestHref = null) => ({ key: "email:t1", sources: cards.length ? ["Gmail", "Agent Inbox"] : ["Gmail"], sourceDetail: "Gmail", title: "Synthetic subject", from: null, reasons: [], nextStep: "Reply", at: iso(-H), atVerb: "Received", gmailHref: null, requestHref, clear: { cards, emails: [] } });
  const v = (it) => A.urgentEmailObligations([it], [], NOW)[0].version;
  const one = v(item(["E1"], "/agents?t=inbox-triage#m1"));
  assert.notEqual(v(item([])), one, "the first request on the thread");
  assert.notEqual(v(item(["E1", "E2"], "/agents?t=inbox-triage#m1")), one, "a second request on the same thread");
  assert.equal(v(item(["E2", "E1"], "/agents?t=inbox-triage#m1")), v(item(["E1", "E2"], "/agents?t=inbox-triage#m1")));
  assert.notEqual(v(item(["E1"], "/agents?t=inbox-triage#m9")), one, "the request posted again");
  // A hide made before the new request no longer applies.
  const hidden = A.urgentEmailObligations([item(["E1"], "/agents?t=inbox-triage#m1")], [], NOW)[0];
  const marks = { [A.markKey(hidden)]: A.markFor(hidden, "hide", MS) };
  const next = A.urgentEmailObligations([item(["E1", "E2"], "/agents?t=inbox-triage#m1")], [], NOW)[0];
  assert.equal(next.id, hidden.id);
  assert.equal(A.markApplies(marks[A.markKey(next)], next, MS), null);
});

test("Eastern deadlines: a device west of Eastern time counts email, money and renewal days in Eastern time", () => {
  const was = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const utc = (d, h, m = 0) => Date.UTC(2030, 2, d, h, m, 0);
    // The device really is three hours behind Eastern (EST) here, or this test proves nothing.
    assert.equal(new Date(utc(7, 4)).getHours(), 20, "device clock: 20:00 Pacific");
    const item = (key) => ({ key, sources: ["Gmail"], sourceDetail: "Gmail", title: "Synthetic " + key, from: null, reasons: [], nextStep: "Reply", at: new Date(utc(6, 12)).toISOString(), atVerb: "Received", gmailHref: null, requestHref: null, clear: { cards: [], emails: [] } });
    const email = (key, date, daysLeft = 1) => ({ key, threadId: "1", messageId: "m" + key, account: "owner@example.com", from: "x", subject: "s", receivedAt: new Date(utc(6, 12)).toISOString(), labels: ["Agent/Deadline"], deadline: { daysLeft, label: "Synthetic day", date }, reasons: [], nextStep: "x", href: null });

    // 20:00 Pacific on Mar 6 is 23:00 Eastern: a deadline on Mar 7 is tomorrow, and the day starts at 00:00 Eastern
    // (05:00 UTC), three hours before the device's own midnight.
    const evening = new Date(utc(7, 4));
    const [o] = A.urgentEmailObligations([item("email:t1")], [email("t1", "2030-03-07")], evening);
    assert.deepEqual([o.urgency, o.reason], ["urgent", "Deadline tomorrow (Synthetic day)"]);
    assert.equal(o.resurfaceAt, utc(7, 5), "back at 00:00 Eastern, not at the device's midnight");
    assert.equal(o.dueAt, utc(8, 5) - 1, "due until the end of the Eastern day");
    assert.equal(A.canSetAside(o, evening.getTime()), true);
    assert.equal(A.snoozeEnd(o, evening), utc(7, 5), "a snooze never outlasts the start of the Eastern deadline day");
    const hide = A.markFor(o, "hide", evening.getTime());
    assert.equal(A.markApplies(hide, o, utc(7, 5) - 1), "hidden");
    // 21:30 Pacific on Mar 6 = 00:30 Eastern on Mar 7: the deadline is today, so nothing keeps it aside.
    const after = new Date(utc(7, 5, 30));
    const [today] = A.urgentEmailObligations([item("email:t1")], [email("t1", "2030-03-07")], after);
    assert.equal(today.reason, "Deadline today (Synthetic day)");
    assert.equal(A.canSetAside(today, after.getTime()), false);
    assert.equal(A.markApplies(hide, today, after.getTime()), null);
    // An answer from before `deadline.date` existed counts its days from today's Eastern day too.
    const [old] = A.urgentEmailObligations([item("email:t2")], [{ ...email("t2", undefined, 0), deadline: { daysLeft: 0, label: "Synthetic day" } }], after);
    assert.deepEqual([old.resurfaceAt, old.dueAt], [utc(7, 5), utc(8, 5) - 1]);

    // A tax payment due Mar 8, seen at 22:00 Pacific on Mar 6 (01:00 Eastern on Mar 7): tomorrow, so urgent. On the
    // device's clock it would still be two days away and only "high".
    const night = new Date(utc(7, 6));
    const tax = { kind: "tax", severity: "high", title: "Synthetic tax: due soon", detail: "Synthetic.", href: "/financials/forecast", due: "2030-03-08" };
    const [money] = A.moneyObligations([tax], "2030-03", night);
    assert.deepEqual([money.urgency, money.reason], ["urgent", "A tax payment is due tomorrow"]);
    assert.deepEqual([money.resurfaceAt, money.dueAt], [utc(8, 5), utc(9, 5) - 1]);
    assert.equal(A.snoozeEnd(money, night), utc(7, 14), "the ordinary snooze (06:00 on the device) is earlier here");
    assert.equal(A.canSetAside(money, utc(8, 5)), false, "from 00:00 Eastern on its day it cannot be set aside");

    // A renewal on Mar 8 is due from 00:00 Eastern that day.
    const [ren] = A.renewalObligations({ status: "ready", count: 1, withinDays: 3, soon: [{ merchant: "Synthetic plan", days: 1, date: "2030-03-08", label: "renews tomorrow" }] }, night);
    assert.deepEqual([ren.dueAt, ren.resurfaceAt], [utc(8, 5), utc(8, 5)]);

    // The day the clock changes (Sun Mar 10, 2030) is 23 hours long in Eastern time: it starts at 05:00 UTC and ends
    // at 04:00 UTC the next day.
    const [dst] = A.moneyObligations([{ ...tax, due: "2030-03-10" }], "2030-03", new Date(utc(9, 18)));
    assert.equal(dst.urgency, "urgent");
    assert.deepEqual([dst.resurfaceAt, dst.dueAt], [utc(10, 5), utc(11, 4) - 1]);

    // The budget month and the Eastern date follow Eastern time: 22:00 Pacific on Mar 31 is already April 1.
    assert.equal(A.easternDate(new Date(Date.UTC(2030, 3, 1, 5, 0, 0))), "2030-04-01");
    assert.equal(A.easternDate(night), "2030-03-07");
  } finally {
    process.env.TZ = was;
  }
});
