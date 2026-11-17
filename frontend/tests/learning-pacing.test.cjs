// Run after deployment (not before merge): node --test tests/learning-pacing.test.cjs
// Voluntary learning pacing (PROD-T06): lib/learning-pacing.ts. SYNTHETIC DATA ONLY: invented book, dates, counts.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");
const P = loadTs("lib/learning-pacing.ts");
const U = loadTs("lib/ui-preferences.ts");

const TODAY = "2031-03-19"; // a Wednesday; its week starts Monday 2031-03-17
const BOOK = { title: "Synthetic Book", status: "reading", chaptersDone: 4, totalChapters: 12 };
const base = (over = {}) => ({ prefs: { ...P.DEFAULT_PREFS, ...(over.prefs || {}) }, configured: true, today: TODAY, sessionDates: [], dueReviews: 0, book: BOOK, ...over, prefs: { ...P.DEFAULT_PREFS, ...(over.prefs || {}) } });

test("the stored key and URL agree with the preferences store", () => {
  assert.equal(P.LEARNING_PREF_URL, U.uiPrefUrl(P.LEARNING_PREF_KEY));
  assert.ok(U.isUiPrefKey(P.LEARNING_PREF_KEY));
});

test("nothing saved: defaults keep today's behaviour (incentives shown, not configured)", () => {
  for (const v of [null, undefined, "x", [], 3]) {
    const r = P.parsePrefs(v);
    assert.equal(r.configured, false);
    assert.equal(r.prefs.showIncentives, true);
  }
});

test("a malformed saved value falls back field by field and never throws", () => {
  const r = P.parsePrefs({ goal: 5, weeklySessions: 99, sessionMinutes: "20", pauseUntil: "2031-13-40", showIncentives: "no" });
  assert.equal(r.configured, true);
  assert.deepEqual(r.prefs, { ...P.DEFAULT_PREFS });
  assert.equal(P.parsePrefs({ showIncentives: false }).prefs.showIncentives, false);
  assert.equal(P.parsePrefs({ goal: "  a   b  " }).prefs.goal, "a b");
});

test("the saved body is a small object the preferences route accepts", () => {
  const body = P.prefsBody({ ...P.DEFAULT_PREFS, goal: "x".repeat(500) });
  assert.equal(body.value.goal.length, P.GOAL_MAX);
  assert.deepEqual(U.parsePrefBody(body).ok, true);
});

test("validation refuses a bad rhythm, a bad date and a pause longer than a year", () => {
  assert.equal(P.prefsError(P.DEFAULT_PREFS, TODAY), null);
  assert.ok(P.prefsError({ ...P.DEFAULT_PREFS, weeklySessions: 9 }, TODAY));
  assert.ok(P.prefsError({ ...P.DEFAULT_PREFS, sessionMinutes: 7 }, TODAY));
  assert.ok(P.prefsError({ ...P.DEFAULT_PREFS, pauseUntil: "soon" }, TODAY));
  assert.ok(P.prefsError({ ...P.DEFAULT_PREFS, pauseUntil: "2033-01-01" }, TODAY));
  assert.equal(P.prefsError({ ...P.DEFAULT_PREFS, pauseUntil: P.addDays(TODAY, 6) }, TODAY), null);
});

test("weeks run Monday to Sunday and count distinct days up to today", () => {
  assert.equal(P.weekStart("2031-03-19"), "2031-03-17");
  assert.equal(P.weekStart("2031-03-23"), "2031-03-17"); // Sunday
  assert.equal(P.weekStart("2031-03-24"), "2031-03-24"); // Monday
  assert.equal(P.sessionDaysThisWeek(["2031-03-16", "2031-03-17", "2031-03-17", "2031-03-18", "2031-03-20"], TODAY), 2);
});

test("pause: nothing is suggested through the last paused day, then it resumes, with no debt", () => {
  const prefs = { pauseUntil: "2031-03-22" };
  const paused = P.nextAction(base({ prefs, dueReviews: 5 }));
  assert.equal(paused.kind, "paused");
  assert.equal(P.nextAction(base({ prefs, today: "2031-03-22", dueReviews: 5 })).kind, "paused");
  const after = P.nextAction(base({ prefs, today: "2031-03-23", dueReviews: 5 }));
  assert.equal(after.kind, "review");
  assert.ok(!/behind|overdue|missed|owe/i.test(P.actionText(paused) + P.actionText(after)));
});

test("a quiet week is never a miss: the week line is a plain count and unknown sessions show no count", () => {
  assert.equal(P.weekLine(base({ sessionDates: [] })), "0 of 2 sessions this week");
  assert.equal(P.weekLine(base({ sessionDates: null })), null);
  assert.equal(P.weekLine(base({ prefs: { pauseUntil: "2031-03-25" } })), null);
  assert.equal(P.weekLine({ ...base(), configured: false }), null);
  // sessions unreadable: no rest verdict either, just the next action
  assert.equal(P.nextAction(base({ sessionDates: null })).kind, "read");
});

test("rest: a week that holds the chosen number of sessions says rest is fine, and low energy still offers 5 minutes", () => {
  const two = ["2031-03-17", "2031-03-18"];
  const a = P.nextAction(base({ sessionDates: two }));
  assert.equal(a.kind, "rest");
  assert.match(P.actionText(a), /2 of 2 sessions this week\. Rest is fine\./);
  const low = P.nextAction(base({ sessionDates: two, lowEnergy: true }));
  assert.equal(low.kind, "read");
  assert.equal(low.minutes, P.LOW_ENERGY_MINUTES);
});

test("unconfigured: only the next action, no weekly rest verdict, no pause", () => {
  const i = { ...base({ sessionDates: ["2031-03-17", "2031-03-18", "2031-03-19"], prefs: { pauseUntil: "2031-03-30" } }), configured: false };
  assert.equal(P.nextAction(i).kind, "read");
});

test("order: a due review comes before the next chapter; unknown due reviews are skipped, not zero", () => {
  const r = P.nextAction(base({ dueReviews: 3 }));
  assert.equal(r.kind, "review");
  assert.match(P.actionText(r), /Review 3 highlights/);
  assert.equal(P.nextAction(base({ dueReviews: null })).kind, "read");
  const read = P.nextAction(base());
  assert.equal(read.chapter, 5);
  assert.match(P.actionText(read), /Synthetic Book, chapter 5 for about 20 min/);
  assert.equal(P.actionHref(read), "/reading");
});

test("no book in progress, or a finished one: nothing to suggest", () => {
  assert.equal(P.nextAction(base({ book: null })).kind, "none");
  assert.equal(P.nextAction(base({ book: { ...BOOK, status: "finished" } })).kind, "none");
  assert.equal(P.actionText({ kind: "none" }), "");
  assert.equal(P.nextAction(base({ book: { ...BOOK, totalChapters: 0 } })).chapter, null);
});

test("the day rolls over by the behavioral date it is given, never by the clock", () => {
  const sessions = ["2031-03-23"]; // Sunday
  assert.equal(P.sessionDaysThisWeek(sessions, "2031-03-23"), 1);
  assert.equal(P.sessionDaysThisWeek(sessions, "2031-03-24"), 0); // a new week starts clean
});

test("wiring: incentives hidden hides XP, level, streak, badges, burn-up and due dates, and history stays", () => {
  const rc = fs.readFileSync(path.join(SRC, "app/reading/ReadingClient.tsx"), "utf8");
  assert.match(rc, /\{incentives && <Part id="burnup"/);
  assert.match(rc, /\{incentives && <Part id="badges"/);
  assert.match(rc, /if \(!incentives\)/);
  assert.ok(!/Health Q&amp;A/.test(rc), "the quiz link says Onyx Chat");
  assert.match(rc, /Onyx Chat/);
  // opening a page only reads: the hook has no write
  const hook = fs.readFileSync(path.join(SRC, "lib/use-learning-prefs.ts"), "utf8");
  assert.ok(!/method:\s*["']?(PUT|POST|PATCH|DELETE)/.test(hook));
  const card = fs.readFileSync(path.join(SRC, "app/reading/PacingCard.tsx"), "utf8");
  assert.match(card, /useAutosave/);
  assert.ok(!/Save<\/button>/.test(card), "no Save button");
});
