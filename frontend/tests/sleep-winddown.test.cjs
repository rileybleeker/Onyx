// Run: node --test tests/sleep-winddown.test.cjs
// Sleep wind-down streak (PROD-SLEEP-01): lib/sleep-winddown.ts (progress, streaks, pauses, versions, saver,
// recovery), lib/sleep-winddown-server.ts (the read against a fake database), Today's attention adapter, the SQL
// contract and the auth boundary.
// SYNTHETIC DATA ONLY: invented habit names, ids, dates and sleep values; a fake database; no network.
process.env.TZ = "America/New_York";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const W = loadTs("lib/sleep-winddown.ts");
const A = loadTs("lib/today-attention.ts");
const S = loadTs("lib/sleep-winddown-server.ts", { "server-only": {} });
const ROOT = path.join(SRC, "..", "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const HABIT = "Synthetic evening routine?";
const HABIT_2 = "Synthetic lights-down routine?";
const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TODAY = "2031-03-20";

function rule(over = {}) {
  return { id: 1, effectiveFrom: "2031-03-01", habitPageId: ID_A, habitName: HABIT, habitCategory: "evening", targetTime: "22:30", tz: "America/New_York", winsNeeded: 5, windowNights: 7, ruleVersion: 1, createdAt: "2031-03-01T20:00:00Z", ...over };
}
function payload(over = {}) {
  return { status: "ready", today: TODAY, hidden: false, rules: [rule()], pauses: [], answers: [], starts: [], habitNames: { [ID_A]: HABIT }, sleep: { source: "WHOOP", nights: [], failed: false }, asOf: "2031-03-20T22:00:00Z", ...over };
}
const day = (n) => W.addDays(TODAY, n);
const yes = (n, q = HABIT) => ({ date: day(n), question: q, answer: "Yes" });
const no = (n, q = HABIT) => ({ date: day(n), question: q, answer: "No" });
const progress = (over) => W.windDownProgress(payload(over));

// ─── weekly progress ────────────────────────────────────────────────────────────────────────────────────────

test("0 of 7: nothing answered is open or unanswered, never a win", () => {
  const p = progress({});
  assert.equal(p.configured, true);
  assert.equal(p.window.size, 7);
  assert.equal(p.window.eligible, 7);
  assert.equal(p.window.wins, 0);
  assert.equal(p.window.pending, 3, "tonight and the two nights before can still be answered");
  assert.equal(p.window.unknown, 4, "older unanswered nights are unknown");
  assert.equal(p.window.met, false);
  assert.equal(p.streak.current, 0);
  assert.equal(p.streak.stoppedAt.status, "unknown", "an unanswered night ends a streak as unanswered, not as missed");
  assert.equal(p.total.wins, 0);
  assert.equal(p.tonight.status, "pending");
  assert.deepEqual(p.openNights.map((n) => n.date), [day(-1), day(-2)]);
});

test("5 of 7 meets the goal; the summary names what is open, unanswered and paused", () => {
  const p = progress({ answers: [yes(-6), yes(-5), no(-4), yes(-3), yes(-2), yes(-1)] });
  assert.equal(p.window.wins, 5);
  assert.equal(p.window.missed, 1);
  assert.equal(p.window.pending, 1);
  assert.equal(p.window.met, true);
  assert.equal(W.windowSummary(p.window), "5 of 7 nights · 1 open");
  assert.equal(p.streak.current, 3, "the miss four nights back ended the earlier run");
  assert.equal(p.milestone, "New personal best: 3 nights in a row.");
});

test("consecutive wins: the streak counts back from tonight, an open tonight neither counts nor breaks it", () => {
  const p = progress({ answers: [no(-4), yes(-3), yes(-2), yes(-1)] });
  assert.equal(p.streak.current, 3);
  assert.equal(p.streak.pendingNights, 1);
  assert.equal(p.streak.best, 3);
  const done = progress({ answers: [no(-4), yes(-3), yes(-2), yes(-1), yes(0)] });
  assert.equal(done.streak.current, 4);
  assert.equal(done.tonight.status, "win");
});

test("a confirmed miss ends the streak; the week, the total and the personal best stay", () => {
  const before = progress({ answers: [yes(-6), yes(-5), yes(-4), yes(-3), yes(-2)] });
  assert.equal(before.streak.current, 5);
  const after = progress({ answers: [yes(-6), yes(-5), yes(-4), yes(-3), yes(-2), no(-1)] });
  assert.equal(after.streak.current, 0);
  assert.deepEqual(after.streak.stoppedAt, { date: day(-1), status: "missed" });
  assert.equal(after.streak.best, 5);
  assert.equal(after.window.wins, 5);
  assert.equal(after.total.wins, 5);
  assert.equal(after.milestone.includes("goal met") || after.milestone === "A new streak can start tonight.", true);
  assert.ok(!/fail|lost|broke|reset/i.test(String(after.milestone)), "never a punitive reset message");
});

test("unknown and delayed nights: pending is shown as open, unknown as unanswered, neither as a win", () => {
  const p = progress({ answers: [yes(-6), yes(-5)] });
  const statuses = p.window.items.filter((i) => i.kind === "night").map((i) => i.night.status);
  assert.deepEqual(statuses, ["win", "win", "unknown", "unknown", "pending", "pending", "pending"]);
  assert.equal(p.window.wins, 2);
  assert.equal(p.window.reachable, true, "2 wins + 3 open nights could still reach 5");
  assert.equal(p.streak.current, 0);
  assert.equal(p.streak.stoppedAt.status, "unknown");
  assert.equal(p.total.decided, 17, "20 nights since the goal, 3 still open: those are not decided yet");
});

test("late corrections recompute deterministically and never count twice", () => {
  const base = { answers: [yes(-3), no(-2), yes(-1)] };
  assert.deepEqual(progress(base), progress(base), "the same payload always gives the same answer");
  const corrected = progress({ answers: [yes(-3), yes(-2), yes(-1)] });
  assert.equal(corrected.streak.current, 3);
  // A repeated fact (a replay, a duplicate row) is one record.
  const parsed = W.parseWindDownPayload(payload({ answers: [yes(-1), yes(-1), no(-1)] }));
  assert.equal(parsed.answers.length, 1);
  assert.equal(W.windDownProgress(parsed).window.wins, 1);
  // withAnswer replaces the night's answer instead of adding one.
  const p2 = W.withAnswer(payload({ answers: [no(-1)] }), day(-1), "Yes");
  assert.deepEqual(p2.answers, [yes(-1)]);
  assert.equal(W.answerOn(p2, day(-1)), "Yes");
  assert.equal(W.answerOn(W.withAnswer(p2, day(-1), null), day(-1)), "none");
});

test("paused nights are labelled and left out of every count, even when the habit says Yes", () => {
  const pauses = [{ id: 1, startDate: day(-4), endDate: day(-3), createdAt: "", endedAt: null }];
  const p = progress({ pauses, answers: [yes(-8), yes(-7), yes(-6), yes(-5), yes(-4), yes(-3), yes(-2), yes(-1)] });
  const paused = p.window.items.filter((i) => i.kind === "paused");
  assert.equal(paused.length, 1);
  assert.equal(paused[0].count, 2);
  assert.equal(p.window.pausedNights, 2);
  assert.equal(p.window.eligible, 7, "the window reaches back past the pause for 7 eligible nights");
  assert.equal(p.window.wins, 6);
  assert.equal(p.streak.current, 6, "a pause neither counts nor breaks the streak");
  assert.ok(p.window.items.every((i) => i.kind === "paused" || i.night.status !== "paused"));
  const tonightPaused = progress({ pauses: [{ id: 2, startDate: TODAY, endDate: null, createdAt: "", endedAt: null }], answers: [yes(0)] });
  assert.equal(tonightPaused.tonight.status, "paused");
  assert.equal(tonightPaused.window.wins, 0, "a Yes on a paused night is not a win");
  assert.equal(W.windDownAttention(tonightPaused).open, false);
  assert.ok(tonightPaused.pause);
});

test("target edits: a new version applies from its night; earlier nights keep their habit and target", () => {
  const v2 = rule({ id: 2, effectiveFrom: day(-1), habitPageId: ID_B, habitName: HABIT_2, targetTime: "23:00", winsNeeded: 4, windowNights: 6 });
  const p = W.windDownProgress(payload({
    rules: [v2, rule()], habitNames: { [ID_A]: HABIT, [ID_B]: HABIT_2 },
    answers: [yes(-3), yes(-2), yes(-1, HABIT_2), yes(-1, HABIT)],
    starts: [{ night: day(-2), startedAt: "", localTime: "22:40", tz: "America/New_York", ruleId: 1 }, { night: day(-1), startedAt: "", localTime: "22:40", tz: "America/New_York", ruleId: 2 }],
  }));
  assert.equal(p.rule.id, 2);
  assert.equal(p.window.size, 6);
  assert.equal(p.window.needed, 4);
  assert.equal(p.question, HABIT_2);
  const night = (d) => p.window.items.find((i) => i.kind === "night" && i.night.date === d).night;
  assert.equal(night(day(-2)).question, HABIT, "the old night keeps the old habit");
  assert.equal(night(day(-2)).targetTime, "22:30");
  assert.equal(night(day(-2)).start.onTime, false, "22:40 is after the 22:30 target of that night's version");
  assert.equal(night(day(-1)).start.onTime, true, "22:40 is on time for the 23:00 target of the new version");
  assert.equal(W.ruleFor([v2, rule()], day(-5)).id, 1);
  assert.equal(W.questionOf(rule(), { [ID_A]: "Renamed synthetic habit?" }), "Renamed synthetic habit?", "a rename in Notion follows");
});

test("midnight and behavioral-day boundaries: evening order, on-time, and the target instant", () => {
  assert.equal(W.eveningMinutes("21:00"), 900);
  assert.equal(W.eveningMinutes("00:30"), 1110);
  assert.equal(W.startedOnTime("23:50", "22:30"), false);
  assert.equal(W.startedOnTime("00:10", "23:30"), false, "after midnight is later than an 11:30 PM target");
  assert.equal(W.startedOnTime("23:20", "00:30"), true, "11:20 PM is before a 12:30 AM target");
  const t = new Date(W.targetInstant("2031-03-20", "00:30"));
  assert.equal(t.getDate(), 21, "a target before 06:00 is in the small hours of the next calendar day");
  assert.equal(t.getHours(), 0);
  assert.equal(new Date(W.targetInstant("2031-03-20", "22:30")).getDate(), 20);
  assert.equal(W.nightName(TODAY, TODAY), "Tonight");
  assert.equal(W.nightName(day(-1), TODAY), "Last night");
});

test("DST and travel: the target is wall-clock time on the DST day; the zone is kept with the version", () => {
  // 2031-03-09 is the US spring-forward day (02:00 -> 03:00) and 2031-11-02 the fall-back day.
  const spring = new Date(W.targetInstant("2031-03-08", "22:30"));
  assert.equal(spring.getHours(), 22);
  assert.equal(spring.getMinutes(), 30);
  const skipped = new Date(W.targetInstant("2031-03-08", "02:30"));
  assert.equal(skipped.getDate(), 9, "a target in the skipped hour stays on the next calendar day");
  const fall = new Date(W.targetInstant("2031-11-01", "22:30"));
  assert.equal(fall.getHours(), 22);
  const travel = rule({ tz: "America/Los_Angeles" });
  assert.equal(travel.tz, "America/Los_Angeles");
  assert.equal(W.isZone("America/Los_Angeles"), true);
  assert.equal(W.isZone("not a zone"), false);
});

// ─── saving: retry, refusal, replay, recovery ───────────────────────────────────────────────────────────────

function manualTimers() {
  const queue = [];
  return { timers: { set: (fn, ms) => { const h = { fn, ms }; queue.push(h); return h; }, clear: (h) => { const i = queue.indexOf(h); if (i >= 0) queue.splice(i, 1); } }, queue };
}
const flush = () => new Promise((r) => setImmediate(r));
const intent = (over = {}) => ({ night: TODAY, answer: "Yes", expect: "none", today: TODAY, ruleId: 1, ...over });

test("saver: a network failure is retried with backoff and saved once", async () => {
  const { timers, queue } = manualTimers();
  let calls = 0;
  const states = [];
  const saver = new W.WindDownSaver({ timers, send: async () => { calls++; if (calls === 1) throw new TypeError("offline"); return { changed: true }; }, onState: (s) => states.push(s.status) });
  saver.submit(intent());
  await flush();
  assert.equal(saver.current.status, "retrying");
  assert.equal(saver.current.error, "Couldn't reach Onyx.");
  assert.equal(saver.unsaved, true);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].ms, 2000);
  queue.shift().fn();
  await flush();
  assert.equal(saver.current.status, "saved");
  assert.equal(calls, 2);
  assert.equal(saver.unsaved, false);
  assert.deepEqual(states, ["saving", "retrying", "saving", "saved"]);
});

test("saver: Retry now (back online) sends at once; a refusal is shown and never retried", async () => {
  const { timers, queue } = manualTimers();
  let calls = 0;
  const saver = new W.WindDownSaver({ timers, send: async () => { calls++; if (calls === 1) throw new Error("HTTP 500"); throw new W.WindDownRefused("changed elsewhere", "changed"); } });
  saver.submit(intent());
  await flush();
  saver.retryNow();
  await flush();
  assert.equal(queue.length, 0, "the pending backoff timer was cancelled");
  assert.equal(saver.current.status, "refused");
  assert.equal(saver.current.code, "changed");
  saver.retryNow();
  await flush();
  assert.equal(calls, 2, "a refused tap is not retried");
  saver.dismiss();
  assert.equal(saver.current.status, "idle");
});

test("saver: a tap made while one is in flight waits; the newest waiting tap wins", async () => {
  const sent = [];
  let release;
  const saver = new W.WindDownSaver({ send: (i) => { sent.push(i.answer); return sent.length === 1 ? new Promise((r) => { release = r; }) : Promise.resolve({}); } });
  saver.submit(intent());
  saver.submit(intent({ answer: null, expect: "Yes" }));
  saver.submit(intent({ answer: "No", expect: "Yes" }));
  release({});
  await flush();
  await flush();
  assert.deepEqual(sent, ["Yes", "No"]);
});

test("saver: a tap for another night never replaces an unsaved one; the same night merges into one tap", async () => {
  const { timers, queue } = manualTimers();
  const sent = [];
  let fail = true;
  const saver = new W.WindDownSaver({ timers, send: async (i) => { sent.push(i); if (fail) throw new TypeError("offline"); return {}; } });
  assert.equal(saver.submit(intent({ night: day(-1), answer: "Yes", expect: "none" })), true);
  await flush();
  assert.equal(saver.current.status, "retrying");
  assert.equal(saver.canAccept(TODAY), false, "last night's tap is still waiting to be saved");
  assert.equal(saver.canAccept(day(-1)), true);
  assert.equal(saver.submit(intent({ night: TODAY })), false, "refused: nothing is cancelled or overwritten");
  assert.equal(queue.length, 1, "the retry of the first tap is still scheduled");
  assert.deepEqual(saver.unsavedNights, [day(-1)]);
  // The same night again while it waits: one tap from what the server last held (none) to the newest answer.
  fail = false;
  assert.equal(saver.submit(intent({ night: day(-1), answer: null, expect: "Yes" })), true);
  await flush();
  assert.equal(sent.length, 2);
  assert.deepEqual({ answer: sent[1].answer, expect: sent[1].expect }, { answer: null, expect: "none" });
  assert.equal(saver.unsaved, false);
  assert.equal(saver.submit(intent({ night: TODAY })), true, "free again once the first is saved");
});

test("saver: a failed tap with a same-night tap behind it goes out as one tap from the server's answer", async () => {
  let release;
  const sent = [];
  const saver = new W.WindDownSaver({ send: (i) => { sent.push(i); return sent.length === 1 ? new Promise((_, rej) => { release = rej; }) : Promise.resolve({}); } });
  saver.submit(intent({ answer: "Yes", expect: "none" }));
  saver.submit(intent({ answer: "No", expect: "Yes" }));
  release(new TypeError("offline"));
  await flush();
  await flush();
  assert.equal(sent.length, 2);
  assert.deepEqual({ answer: sent[1].answer, expect: sent[1].expect }, { answer: "No", expect: "none" });
});

test("a goal change refuses an old tap, a kept tap is not offered under another goal, undo uses the screen's answer", () => {
  const sql = fs.readFileSync(path.join(ROOT, "sql", "sleep_winddown.sql"), "utf8");
  assert.match(sql, /p_rule_id bigint DEFAULT NULL/);
  assert.match(sql, /IF p_rule_id IS NOT NULL AND r\.rule_id <> p_rule_id THEN\s+RAISE EXCEPTION [^;]*ERRCODE = 'OXW16'/);
  assert.equal(W.WINDDOWN_DB_ERRORS.OXW16.status, 409);
  const night = read("app/api/sleep/winddown/night/route.ts");
  assert.match(night, /p_rule_id: b\.ruleId/);
  const store = read("lib/use-winddown.ts");
  assert.match(store, /ruleFor\(p\.rules, night\)/, "the tap carries the goal version the screen showed");
  // Undo goes back to the answer the screen showed when the tap was made, not the server's "previous": a retry
  // after a lost answer comes back from the server as an unchanged night.
  assert.match(store, /previous: intent\.expect === "none" \? null : intent\.expect/);
  const kept = W.parsePending(W.pendingRecord(intent(), Date.parse("2031-03-20T22:00:00Z")));
  const now = Date.parse("2031-03-20T23:00:00Z");
  assert.ok(W.pendingToOffer(kept, payload(), now));
  const changed = payload({ rules: [rule(), rule({ id: 2, effectiveFrom: TODAY, habitPageId: ID_B, habitName: HABIT_2 })], habitNames: { [ID_A]: HABIT, [ID_B]: HABIT_2 } });
  assert.equal(W.pendingToOffer(kept, changed, now), null, "the goal changed since the tap: not offered");
  assert.equal(W.parsePending(JSON.stringify({ night: TODAY, answer: "Yes", expect: "none", today: TODAY, at: 1 })), null, "a kept tap without its goal is dropped");
});

test("one unsaved tap at a time: the answer buttons wait; every mount, the day rollover and the Habits page follow", () => {
  const panel = read("components/sleep/WindDownPanel.tsx");
  assert.match(panel, /const saving = s\.saver\.status === "saving" \|\| s\.saver\.status === "retrying" \|\| !!s\.recovery;/);
  const store = read("lib/use-winddown.ts");
  assert.match(store, /if \(snap\.recovery \|\| !saver\.canAccept\(night\)\) return false;/);
  assert.match(store, /if \(!saver\.unsaved\) overlay = null;/, "a tap still waiting keeps its optimistic answer");
  assert.match(store, /else if \(Date\.now\(\) - lastLoad > REMOUNT_RELOAD_MS && !saver\.unsaved\)/, "a later mount revalidates");
  assert.match(store, /msUntilRollover\(new Date\(\)\)/);
  const habits = read("app/habits/HabitsClient.tsx");
  assert.match(habits, /addEventListener\(WINDDOWN_SAVED_EVENT/);
  assert.match(habits, /togglingRef\.current\.size > 0\) return;/, "a tap of the Habits page still in flight is not overwritten");
  assert.equal(W.msUntilRollover(new Date(2031, 2, 20, 5, 59, 0)), 65_000);
  assert.ok(W.msUntilRollover(new Date(2031, 2, 20, 6, 0, 10)) > 23 * 3_600_000, "after 06:00 the next rollover is tomorrow");
});

test("replay: the server treats a repeated tap as a no-op, so a retry after a lost answer counts once", () => {
  const sql = fs.readFileSync(path.join(ROOT, "sql", "sleep_winddown.sql"), "utf8");
  assert.match(sql, /IF COALESCE\(v_current, 'none'\) IS DISTINCT FROM COALESCE\(p_answer, 'none'\) THEN/);
  assert.match(sql, /ON CONFLICT \(cycle_date, question\) DO UPDATE SET answer = EXCLUDED\.answer/);
  assert.match(sql, /ON CONFLICT \(night\) DO NOTHING/, "the first Started tap's time is kept on a replay");
  assert.match(sql, /pg_advisory_xact_lock/);
  // No row yet: the insert never overwrites one a concurrent check-in or Habits write made (FOR UPDATE locks nothing then).
  assert.match(sql, /ELSIF v_current IS NULL AND p_expect IS NOT NULL THEN[\s\S]*ON CONFLICT \(cycle_date, question\) DO NOTHING;[\s\S]*GET DIAGNOSTICS v_rows = ROW_COUNT;/);
  assert.match(sql, /IF v_current IS DISTINCT FROM p_answer THEN\s+RAISE EXCEPTION [^;]*ERRCODE = 'OXW15'/);
  // The start time is the moment of the tap that wrote the first answer, never a later report or a correction.
  assert.match(sql, /IF p_answer = 'Yes' AND p_night = v_today AND v_changed AND v_prior IS NULL THEN/);
});

test("offline recovery: a kept tap is offered (never sent) only while it still applies", () => {
  const now = Date.parse("2031-03-21T13:00:00Z");
  const kept = W.parsePending(W.pendingRecord(intent({ night: TODAY }), now - 3600_000));
  assert.equal(kept.night, TODAY);
  const tomorrow = payload({ today: day(1) });
  assert.deepEqual(W.pendingToOffer(kept, tomorrow, now), { night: TODAY, answer: "Yes", expect: "none", today: day(1), ruleId: 1 }, "resent for the same night with the new day");
  assert.equal(W.pendingToOffer(kept, payload({ today: day(1), answers: [yes(0)] }), now), null, "it landed: nothing to offer");
  assert.equal(W.pendingToOffer(kept, payload({ today: day(3) }), now), null, "the night is outside the answer window");
  assert.equal(W.pendingToOffer(kept, tomorrow, now + W.PENDING_MAX_AGE_MS + 1), null, "too old");
  assert.equal(W.pendingToOffer(kept, payload({ status: "not_set_up", rules: [] }), now), null);
  assert.equal(W.parsePending("{bad json"), null);
  assert.equal(W.parsePending(JSON.stringify({ night: TODAY, answer: "Maybe", expect: "none", today: TODAY, ruleId: 1, at: 1 })), null);
  assert.ok(W.WINDDOWN_PENDING_KEY.startsWith("onyx"), "wiped on sign-out with every onyx* key");
});

test("client to handler: the tap's request body is what the night route reads (rule_id, no unknown field)", () => {
  for (const i of [intent(), intent({ answer: null, expect: "Yes" }), intent({ night: day(-1), answer: "No", expect: "none" })]) {
    const parsed = W.parseNightBody(W.nightRequestBody(i));
    assert.equal(parsed.ok, true, parsed.error);
    assert.deepEqual({ ...parsed.value }, { night: i.night, answer: i.answer, expect: i.expect, today: i.today, ruleId: i.ruleId });
  }
  // The saver's own intent (camelCase ruleId) is not a valid body: the route refuses unknown fields and needs rule_id.
  const asIs = W.parseNightBody(intent());
  assert.equal(asIs.ok, false);
  const store = read("lib/use-winddown.ts");
  assert.match(store, /send\(WINDDOWN_NIGHT_URL, "POST", nightRequestBody\(intent\)/);
  assert.ok(!/send\(WINDDOWN_NIGHT_URL, "POST", intent\)/.test(store), "the intent is never sent as it is");
});

test("a 200 is a saved answer only when it is the server's answer to this tap", () => {
  const i = intent();
  assert.doesNotThrow(() => W.confirmNightReply({ night: TODAY, answer: "Yes", previous: null, changed: true }, i));
  assert.doesNotThrow(() => W.confirmNightReply({ night: TODAY, answer: null, previous: "Yes", changed: true }, intent({ answer: null, expect: "Yes" })), "a cleared night answers null");
  for (const bad of [null, undefined, {}, "<html>sign in</html>", [], { night: day(-1), answer: "Yes" }, { night: TODAY }, { night: TODAY, answer: "Maybe" }]) {
    assert.throws(() => W.confirmNightReply(bad, i), /confirm/);
  }
  const store = read("lib/use-winddown.ts");
  assert.match(store, /confirmNightReply\(d, intent\)/);
  assert.match(store, /if \(sessionEnded\(res\)\) \{\s+reportSessionEnded\(\);/, "a redirect to sign-in is a session end, never an answer");
  assert.match(store, /if \(!data\) throw new Error\("Couldn't confirm it was saved\."\);/, "an unreadable 200 is retried, not confirmed");
  // The goal, pause and hide writes are checked the same way.
  assert.match(store, /hasKey\("rule"\)/);
  assert.match(store, /hasKey\("pause"\)/);
  assert.match(store, /d\.key !== WINDDOWN_PREF_KEY/);
});

test("a tap that reaches the server after 06:00 is refused as stale and its kept copy stays to be offered again", async () => {
  const { timers, queue } = manualTimers();
  const refusals = [];
  let calls = 0;
  const saver = new W.WindDownSaver({
    timers,
    send: async () => { calls++; if (calls === 1) throw new TypeError("offline"); throw new W.WindDownRefused(W.WINDDOWN_STALE_MESSAGE, W.WINDDOWN_STALE_CODE); },
    onRefused: (_i, e) => refusals.push(e.code),
  });
  saver.submit(intent());
  await flush();
  assert.equal(saver.current.status, "retrying", "queued offline");
  saver.retryNow();
  await flush();
  assert.equal(saver.current.status, "refused");
  assert.equal(saver.current.code, "stale");
  assert.deepEqual(refusals, ["stale"]);
  assert.equal(queue.length, 0);
  // The kept record of that tap (written while it was saving / retrying) is offered again on the new day.
  const kept = W.parsePending(W.pendingRecord(intent({ today: TODAY }), Date.parse("2031-03-21T09:00:00Z")));
  const offer = W.pendingToOffer(kept, payload({ today: day(1) }), Date.parse("2031-03-21T11:00:00Z"));
  assert.deepEqual(offer, { night: TODAY, answer: "Yes", expect: "none", today: day(1), ruleId: 1 }, "the night Riley tapped, sent with the new day");
  const store = read("lib/use-winddown.ts");
  assert.match(store, /if \(e\.code !== WINDDOWN_STALE_CODE\) keep\(null\);/, "only a stale refusal keeps the tap");
  assert.match(store, /if \(!snap\.recovery && !stale\) keep\(null\);/, "OK on the message does not drop the offered tap");
});

test("the session ending empties the store: no data, no retry, no write to the device afterwards", async () => {
  const { timers, queue } = manualTimers();
  const states = [];
  let calls = 0;
  let release;
  const saver = new W.WindDownSaver({
    timers,
    send: () => { calls++; return calls === 1 ? Promise.reject(new TypeError("offline")) : new Promise((r) => { release = r; }); },
    onState: (s) => states.push(s.status),
    onSaved: () => states.push("onSaved"),
  });
  saver.submit(intent());
  await flush();
  assert.equal(saver.current.status, "retrying");
  assert.equal(queue.length, 1);
  saver.reset();
  assert.equal(queue.length, 0, "the pending retry is cancelled");
  assert.equal(saver.unsaved, false);
  assert.equal(saver.current.status, "idle");
  // A send that was already in flight when the session ended answers late: nothing happens.
  saver.submit(intent({ night: day(-1) }));
  await flush();
  assert.equal(saver.current.status, "saving");
  const before = states.length;
  saver.reset();
  release({ night: day(-1), answer: "Yes" });
  await flush();
  assert.equal(states.length, before, "no state, no onSaved, no retry after the reset");
  assert.equal(saver.unsaved, false);
  assert.equal(saver.submit(intent()), true, "a new session can tap again");
  // The store hooks the cache's wipe (sign-out, 401, redirect to sign-in) and ignores reads that started before it.
  const store = read("lib/use-winddown.ts");
  assert.match(store, /clientCache\.onWipe\(resetAfterSessionEnd\)/);
  const reset = store.slice(store.indexOf("function resetAfterSessionEnd()"), store.indexOf("function scheduleRollover"));
  for (const part of [/epoch\+\+/, /saver\.reset\(\)/, /server = null/, /overlay = null/, /keep\(null\)/, /started = false/, /snap = INITIAL/]) assert.match(reset, part);
  assert.match(store, /if \(mine === epoch\) accept\(raw, true\)/);
  const cache = read("lib/client-cache.ts");
  assert.match(cache, /onWipe\(listener: \(\) => void\)/);
  assert.match(cache.slice(cache.indexOf("async wipe()")), /this\.generation\+\+;\s+for \(const fn of Array\.from\(this\.wipeListeners\)\)/);
});

test("opening a page writes nothing: the store only reads until a tap", () => {
  const store = read("lib/use-winddown.ts");
  const sub = store.slice(store.indexOf("function subscribe("), store.indexOf("const getSnapshot"));
  assert.ok(sub.length > 100);
  assert.ok(!/send\(|saver\.submit|answerNight|resolveRecovery\(true/.test(sub), "subscribe (mount) never writes");
  const acceptFn = store.slice(store.indexOf("function accept("), store.indexOf("export function reloadWindDown"));
  assert.ok(!/send\(|saver\.submit/.test(acceptFn), "a kept tap is offered, not sent, when the answer arrives");
  assert.match(store, /export function resolveRecovery\(save: boolean\)/);
});

// ─── Today's quiet view ─────────────────────────────────────────────────────────────────────────────────────

test("Today: one ordinary item from 3 h before the target while tonight is open, never urgent", () => {
  const p = progress({ answers: [yes(-2), yes(-1)] });
  const a = W.windDownAttention(p);
  assert.equal(a.targetLabel, "10:30 PM");
  assert.equal(a.listFrom, a.dueAt - W.WINDDOWN_LEAD_MS);
  assert.deepEqual(A.windDownObligations(a, new Date(a.listFrom - 1)), [], "not listed in the morning");
  const [o] = A.windDownObligations(a, new Date(a.listFrom + 60_000));
  assert.equal(o.id, `winddown:${TODAY}`);
  assert.equal(o.source, "winddown");
  assert.equal(o.urgency, "normal");
  assert.equal(o.pinned, undefined);
  assert.equal(o.href, "/log#log-part-wind-down");
  assert.match(o.title, /10:30 PM/);
  assert.match(o.detail, /2-night streak/);
  assert.equal(A.canSetAside(o, a.dueAt + 3600_000), true, "it can be snoozed or hidden like any item");
  assert.deepEqual(A.windDownObligations({ ...a, open: false }, new Date(a.dueAt)), [], "answered or paused: nothing listed");
  assert.deepEqual(A.windDownObligations(null, new Date(a.dueAt)), []);
  const hidden = W.windDownProgress(payload({ hidden: true }));
  assert.equal(W.windDownAttention(hidden), null, "hidden from Today");
});

test("Today: the wind-down is a source only once it is known to be set up", () => {
  const now = new Date(Date.parse("2031-03-21T01:00:00Z"));
  const empty = { probe: { load: "ready", asOf: now.toISOString() }, items: [] };
  const base = {
    now, requests: empty, urgentEmail: { ...empty, emails: [] }, calendar: { probe: empty.probe, events: [] },
    money: { probe: empty.probe, alerts: [] }, renewals: { probe: empty.probe, summary: null }, packages: { probe: empty.probe, summary: null },
    reading: { probe: empty.probe, overview: null },
  };
  assert.ok(!A.todayAttention(base).sources.some((s) => s.source === "winddown"));
  const a = W.windDownAttention(progress({}));
  const out = A.todayAttention({ ...base, windDown: { probe: { load: "ready", asOf: now.toISOString() }, attention: { ...a, listFrom: 0 } } });
  assert.ok(out.sources.some((s) => s.source === "winddown" && s.label === "Wind-down"));
  assert.equal(out.obligations.filter((o) => o.source === "winddown").length, 1);
  assert.ok(A.SOURCE_ORDER.includes("winddown"));
});

// ─── bodies, errors, SQL, boundary ──────────────────────────────────────────────────────────────────────────

test("request bodies: exact fields, Riley's own values, no assumed bedtime", () => {
  assert.equal(W.parseNightBody({ night: TODAY, answer: "Yes", expect: "none", today: TODAY, rule_id: 1 }).ok, true);
  assert.equal(W.parseNightBody({ night: TODAY, answer: "Yes", today: TODAY, rule_id: 1, extra: 1 }).ok, false);
  assert.equal(W.parseNightBody({ night: TODAY, answer: "Maybe", today: TODAY, rule_id: 1 }).ok, false);
  assert.equal(W.parseNightBody({ night: TODAY, answer: null, today: TODAY, rule_id: 1 }).value.expect, null);
  assert.equal(W.parseNightBody({ night: TODAY, answer: "Yes", expect: "none", today: TODAY }).ok, false, "the goal the screen showed is required");
  assert.equal(W.parseNightBody({ night: TODAY, answer: "Yes", today: TODAY, rule_id: 0 }).ok, false);
  assert.equal(W.parseNightBody({ night: TODAY, answer: "Yes", today: TODAY, rule_id: 7 }).value.ruleId, 7);
  const goal = { habit_page_id: ID_A, target_time: "22:30", wins_needed: 5, window_nights: 7, tz: "America/New_York", today: TODAY };
  assert.equal(W.parseRuleBody(goal).ok, true);
  assert.equal(W.parseRuleBody({ ...goal, target_time: "" }).ok, false, "a target time must be chosen");
  assert.equal(W.parseRuleBody({ ...goal, wins_needed: 8 }).ok, false, "wins needed cannot exceed the window");
  assert.equal(W.parseRuleBody({ ...goal, window_nights: 2 }).ok, false);
  assert.equal(W.parseRuleBody({ ...goal, habit_page_id: "not-an-id" }).ok, false);
  assert.equal(W.parsePauseBody({ start_date: TODAY, end_date: null, today: TODAY }, "POST").ok, true);
  assert.equal(W.parsePauseBody({ start_date: TODAY, end_date: day(-1), today: TODAY }, "POST").ok, false);
  assert.equal(W.parsePauseBody({ pause_id: 3 }, "PATCH").value.pauseId, 3);
  assert.equal(W.parsePauseBody({ pause_id: 0 }, "PATCH").ok, false);
});

test("every database refusal in the SQL has a message; missing tables read as not connected", () => {
  const sql = fs.readFileSync(path.join(ROOT, "sql", "sleep_winddown.sql"), "utf8");
  const codes = new Set([...sql.matchAll(/ERRCODE = '(OXW\d\d)'/g)].map((m) => m[1]));
  assert.ok(codes.size >= 10);
  for (const c of codes) assert.ok(W.WINDDOWN_DB_ERRORS[c], c);
  assert.equal(W.windDownRefusal({ code: "OXW15" }).status, 409);
  assert.equal(W.windDownRefusal({ code: "23505" }), null);
  assert.equal(W.isMissingStorage({ code: "PGRST205" }), true);
  assert.equal(W.isMissingStorage({ code: "42501" }), false);
});

test("SQL contract: additive, service role only, guarded history", () => {
  const sql = fs.readFileSync(path.join(ROOT, "sql", "sleep_winddown.sql"), "utf8");
  assert.ok(!/\bdrop\b/i.test(sql), "no destructive statement (the Supabase MCP refuses one)");
  for (const t of ["sleep_winddown_rules", "sleep_winddown_pauses", "sleep_winddown_starts"]) {
    assert.match(sql, new RegExp(`ALTER TABLE pds\\.${t}\\s+ENABLE ROW LEVEL SECURITY`), t);
    assert.match(sql, new RegExp(`REVOKE ALL ON pds\\.${t}\\s+FROM PUBLIC, anon, authenticated`), t);
  }
  assert.ok(!/^\s*GRANT[^;]*TO\s+(anon|authenticated)/im.test(sql), "nothing granted to the browser roles");
  assert.ok(!/CREATE POLICY/i.test(sql), "no policy: service role only");
  for (const fn of ["sleep_winddown_add_rule", "sleep_winddown_set_night", "sleep_winddown_add_pause", "sleep_winddown_end_pause"]) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION pds\\.${fn}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated`), fn);
  }
  assert.match(sql, /'wind-down goal versions are kept as they were' USING ERRCODE = 'OXW02'/, "goal versions are append-only");
  assert.match(sql, /p_night < v_today - 2/, "only the check-in's three-night window");
  assert.ok(!/SECURITY DEFINER/i.test(sql));
});

test("auth boundary: the wind-down routes are owner-session only and check origin, type and size", () => {
  const mw = read("middleware.ts");
  const ci = mw.slice(mw.indexOf("function isCiRoute"), mw.indexOf("}", mw.indexOf("function isCiRoute")));
  assert.ok(!ci.includes("/api/sleep"), "never a CI-token route");
  for (const f of ["app/api/sleep/winddown/night/route.ts", "app/api/sleep/winddown/rule/route.ts", "app/api/sleep/winddown/pause/route.ts"]) {
    const src = read(f);
    assert.match(src, /checkPortionRequest\(req\.headers, req\.nextUrl\.origin, MAX_WINDDOWN_BODY_BYTES\)/, f);
    assert.match(src, /readJsonBody\(req, MAX_WINDDOWN_BODY_BYTES\)/, f);
    assert.ok(!/console\.error\([^)]*(question|answer|habit_name|body)/.test(src), `${f} never logs record content`);
  }
  const rule = read("app/api/sleep/winddown/rule/route.ts");
  assert.match(rule, /SLEEP_QUESTIONS\.has\(name\)/, "a sleep question cannot be the wind-down habit");
  const get = read("app/api/sleep/winddown/route.ts");
  assert.ok(!/rpc\("sleep_winddown_(set|add|end)/.test(get), "the GET never writes");
});

// ─── the server read (fake database) ────────────────────────────────────────────────────────────────────────

function fakeDb(tables, { today = TODAY, fail = {} } = {}) {
  const calls = [];
  const builder = (table) => {
    const ops = [];
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve, reject) => Promise.resolve().then(() => {
            calls.push({ table, ops });
            if (fail[table]) return { data: null, error: { code: fail[table] } };
            let rows = (tables[table] ?? []).slice();
            for (const [op, a, v] of ops) {
              if (op === "eq") rows = rows.filter((r) => r[a] === v);
              if (op === "in") rows = rows.filter((r) => v.includes(r[a]));
              if (op === "gte") rows = rows.filter((r) => r[a] >= v);
              if (op === "lte") rows = rows.filter((r) => r[a] <= v);
              if (op === "lt") rows = rows.filter((r) => r[a] < v);
              if (op === "is") rows = rows.filter((r) => (r[a] ?? null) === v);
              if (op === "range") rows = rows.slice(a, v + 1);
            }
            if (ops.some(([op]) => op === "maybeSingle")) return { data: rows[0] ?? null, error: null };
            return { data: rows, error: null };
          }).then(resolve, reject);
        }
        return (...args) => { ops.push([prop, ...args]); return b; };
      },
    });
    return b;
  };
  return {
    calls,
    from: (t) => builder(t),
    rpc: (fn) => Promise.resolve(fn === "behavioral_today_now" ? { data: today, error: null } : { data: null, error: { code: "unexpected" } }),
  };
}
const RULE_ROW = { rule_id: 1, effective_from: "2031-03-01", habit_page_id: ID_A, habit_name: HABIT, habit_category: "evening", target_time: "22:30", tz: "America/New_York", wins_needed: 5, window_nights: 7, rule_version: 1, created_at: "2031-03-01T20:00:00Z" };

test("server read: not connected before the SQL is applied, not set up before the first goal", async () => {
  const missing = await S.readWindDown(fakeDb({}, { fail: { sleep_winddown_rules: "PGRST205" } }));
  assert.equal(missing.status, "not_connected");
  const none = await S.readWindDown(fakeDb({ sleep_winddown_rules: [], sleep_winddown_pauses: [] }));
  assert.equal(none.status, "not_set_up");
  assert.equal(none.today, TODAY);
  await assert.rejects(S.readWindDown(fakeDb({}, { fail: { sleep_winddown_rules: "57014" } })), (e) => e instanceof S.WindDownReadError && e.step === "rules");
});

test("server read: the habit's own answers since the goal, the starts and WHOOP feedback", async () => {
  const journal = [];
  for (let i = 1; i <= 19; i++) journal.push({ cycle_date: W.addDays("2031-03-01", i - 1), question: HABIT, answer: i % 4 === 0 ? "No" : "Yes" });
  journal.push({ cycle_date: "2031-02-20", question: HABIT, answer: "Yes" }, { cycle_date: day(-1), question: "Another synthetic habit?", answer: "Yes" });
  const db = fakeDb({
    sleep_winddown_rules: [RULE_ROW],
    sleep_winddown_pauses: [{ pause_id: 1, start_date: "2031-03-25", end_date: null, created_at: "", ended_at: null, removed_at: null }],
    ui_preferences: [{ key: W.WINDDOWN_PREF_KEY, value: { hidden: true } }],
    habit_name_map: [{ notion_page_id: ID_A, habit_name: HABIT }],
    habit_journal: journal,
    sleep_winddown_starts: [{ night: day(-1), started_at: "2031-03-20T02:10:00Z", local_time: "22:10", tz: "America/New_York", rule_id: 1 }],
    whoop_sleep: [
      { onyx_behavioral_date: day(-1), start_time: "2031-03-20T03:40:00Z", end_time: "2031-03-20T11:00:00Z", timezone_offset: "-04:00", total_light_sleep_time_milli: 3 * 3600_000, total_slow_wave_sleep_time_milli: 3600_000, total_rem_sleep_time_milli: 3600_000 + 30 * 60_000, synced_at: "2031-03-20T12:00:00Z", is_nap: false, score_state: "SCORED" },
      { onyx_behavioral_date: day(-1), start_time: "2031-03-20T09:00:00Z", end_time: "2031-03-20T09:30:00Z", timezone_offset: "-04:00", total_light_sleep_time_milli: 0, total_slow_wave_sleep_time_milli: 0, total_rem_sleep_time_milli: 0, synced_at: "", is_nap: false, score_state: "SCORED" },
    ],
  });
  const p = await S.readWindDown(db, "2031-03-20T22:00:00Z");
  assert.equal(p.status, "ready");
  assert.equal(p.hidden, true);
  assert.equal(p.answers.length, 19, "only the chosen habit, only since the goal started");
  assert.ok(p.answers.every((a) => a.question === HABIT && a.date >= "2031-03-01"));
  assert.equal(p.starts.length, 1);
  assert.equal(p.sleep.nights.length, 1, "the longest sleep of the night");
  assert.equal(p.sleep.nights[0].asleepMin, 330);
  assert.equal(p.sleep.nights[0].onset, "23:40");
  assert.equal(p.pauses.length, 1);
  assert.deepEqual(W.parseWindDownPayload(JSON.parse(JSON.stringify(p))).answers.length, 19, "the answer survives the client check");
  const answerRead = db.calls.find((c) => c.table === "habit_journal");
  assert.ok(answerRead.ops.some(([op]) => op === "range"), "paged in a fixed order");
  assert.ok(!db.calls.some((c) => c.ops.some(([op]) => ["insert", "upsert", "update", "delete"].includes(op))), "the read writes nothing");
});

test("server read: after a rename in Notion the answers are read under the habit's current name", async () => {
  const db = fakeDb({
    sleep_winddown_rules: [RULE_ROW], sleep_winddown_pauses: [],
    habit_name_map: [{ notion_page_id: ID_A, habit_name: "Renamed synthetic routine?" }],
    habit_journal: [{ cycle_date: day(-1), question: "Renamed synthetic routine?", answer: "Yes" }, { cycle_date: day(-1), question: "Unrelated synthetic habit?", answer: "No" }],
  });
  const p = await S.readWindDown(db);
  assert.deepEqual(p.answers.map((a) => a.question), ["Renamed synthetic routine?"]);
  assert.equal(db.calls.filter((c) => c.table === "habit_journal").length, 2, "one read under the stored name, one under the new name");
  assert.equal(W.windDownProgress(p).question, "Renamed synthetic routine?");
});

test("server read: a failed WHOOP read is shown as failed, never as zeros", async () => {
  const db = fakeDb({ sleep_winddown_rules: [RULE_ROW], sleep_winddown_pauses: [], habit_name_map: [{ notion_page_id: ID_A, habit_name: HABIT }], habit_journal: [] }, { fail: { whoop_sleep: "57014" } });
  const p = await S.readWindDown(db);
  assert.equal(p.sleep.failed, true);
  assert.deepEqual(p.sleep.nights, []);
  assert.equal(W.sleepFeedback(p).failed, true);
  assert.equal(S.localClock("2031-03-20T03:40:00Z", "-04:00"), "23:40");
  assert.equal(S.localClock("2031-03-20T03:40:00Z", "bad"), null);
});

test("sleep feedback: onset spread across midnight, freshness, and it never changes a night", () => {
  const p = payload({ sleep: { source: "WHOOP", failed: false, nights: [
    { night: day(-1), asleepMin: 420, onset: "00:20", syncedAt: "2031-03-20T12:00:00Z" },
    { night: day(-2), asleepMin: 400, onset: "23:40", syncedAt: "2031-03-19T12:00:00Z" },
  ] } });
  const f = W.sleepFeedback(p);
  assert.equal(f.lastNight.asleepMin, 420);
  assert.deepEqual(f.onsetRange, { earliest: "23:40", latest: "00:20", spreadMin: 40, nights: 2 });
  assert.equal(f.newestSync, "2031-03-20T12:00:00Z");
  assert.deepEqual(W.windDownProgress(p), W.windDownProgress(payload({})), "sleep data never marks a night");
  assert.equal(W.durationLabel(330), "5 h 30 min");
});
