// Run: node --test tests/checkin.test.cjs
// The daily check-in's "less typing" rules (lib/checkin.ts): which questions are asked every day, the
// usual sleep kit, and the data-backed pre-fills (Screen Time, Eight Sleep, Notion journal, habit apps).
// SYNTHETIC DATA ONLY: invented dates and numbers; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const C = loadTs("lib/checkin.ts");

// ─── which questions are asked every day ─────────────────────────────────────

test("groupFor: WHOOP-derived and daily habits are core, weekly ones are extra", () => {
  assert.equal(C.groupFor("Experienced stress?", "whoop", "Ad Hoc"), "core");
  assert.equal(C.groupFor("AI", "habit", "daily"), "core");
  assert.equal(C.groupFor("Some weekday habit", "habit", "weekdays"), "core");
  assert.equal(C.groupFor("Some weekly habit", "habit", "weekly"), "extra");
});

test("groupFor: occasional questions move to Also did whatever their channel or frequency", () => {
  for (const q of C.OCCASIONAL) {
    assert.equal(C.groupFor(q, "whoop", "Ad Hoc"), "extra", q);
    assert.equal(C.groupFor(q, "habit", "daily"), "extra", q);
  }
});

test("questions the analysis leans on are never demoted", () => {
  for (const q of ["Have any alcoholic drinks?", "Feeling sick or ill?", "Experienced stress?", ...C.SLEEP_QUESTIONS]) {
    assert.equal(C.OCCASIONAL.has(q), false, q);
  }
});

test("every sleep-kit question is a sleep question", () => {
  assert.equal(C.SLEEP_KIT.length, 5);
  for (const q of C.SLEEP_KIT) assert.equal(C.SLEEP_QUESTIONS.has(q), true, q);
});

// ─── usual kit ───────────────────────────────────────────────────────────────

const [TAPE, GUARD, STRIP, PLUGS, MASK] = C.SLEEP_KIT;

test("usualKit takes the newest answer per question from days before the check-in day", () => {
  const rows = [
    { cycle_date: "2031-03-01", question: TAPE, answer: "No" },
    { cycle_date: "2031-03-04", question: TAPE, answer: "Yes" },
    { cycle_date: "2031-03-02", question: PLUGS, answer: "Yes" },
    { cycle_date: "2031-03-03", question: PLUGS, answer: "No" },
    { cycle_date: "2031-03-05", question: PLUGS, answer: "Yes" }, // the day itself: ignored
    { cycle_date: "2031-03-09", question: GUARD, answer: "No" }, // a later day: ignored
    { cycle_date: "2031-03-04", question: "Experienced stress?", answer: "Yes" }, // not a kit question
    { cycle_date: "2031-03-04", question: MASK, answer: "maybe" }, // not a valid answer
  ];
  assert.deepEqual(C.usualKit(rows, "2031-03-05"), { [TAPE]: "Yes", [PLUGS]: "No" });
});

test("usualKit is empty with no history and keeps the kit's own order", () => {
  assert.deepEqual(C.usualKit([], "2031-03-05"), {});
  const rows = [MASK, STRIP, TAPE].map((question) => ({ cycle_date: "2031-03-01", question, answer: "Yes" }));
  assert.deepEqual(Object.keys(C.usualKit(rows, "2031-03-05")), [TAPE, STRIP, MASK]);
});

test("usualKit only returns the questions it was asked for", () => {
  const rows = [TAPE, GUARD].map((question) => ({ cycle_date: "2031-03-01", question, answer: "Yes" }));
  assert.deepEqual(C.usualKit(rows, "2031-03-05", [GUARD]), { [GUARD]: "Yes" });
});

test("kitSummary lists what is worn, then what is not", () => {
  assert.equal(
    C.kitSummary({ [TAPE]: "Yes", [GUARD]: "Yes", [STRIP]: "Yes", [PLUGS]: "No", [MASK]: "No" }),
    "mouth tape, nightguard or retainer, nasal strip · no ear plugs, no sleep mask"
  );
  assert.equal(C.kitSummary({ [PLUGS]: "No" }), "no ear plugs");
  assert.equal(C.kitSummary({}), "");
});

// ─── pre-fills ───────────────────────────────────────────────────────────────

test("screenInBedSuggestion: Yes from 20 min, No up to 1 min, nothing in between or without data", () => {
  assert.equal(C.SCREEN_IN_BED_YES_MIN, 20);
  assert.equal(C.screenInBedSuggestion(28.3).answer, "Yes");
  assert.match(C.screenInBedSuggestion("28.3").source, /28 min/);
  assert.equal(C.screenInBedSuggestion(20).answer, "Yes");
  // The Yes label states the threshold it was suggested at.
  assert.equal(C.screenInBedSuggestion(20).source, "Screen Time: 20 min on the phone in the hour before sleep (20+ min suggests Yes)");
  assert.equal(C.screenInBedSuggestion(0).answer, "No");
  assert.equal(C.screenInBedSuggestion(1).answer, "No");
  assert.equal(C.screenInBedSuggestion(0).source, "Screen Time: no phone use in the hour before sleep");
  // 10 to 19.9 min suggested Yes before 2026-11-13; up to 15 of those minutes can come from use 60 to 90 min before sleep.
  for (const v of [5, 10, 15, 19.9, 1.1, null, undefined, "", "abc", NaN]) assert.equal(C.screenInBedSuggestion(v), null, String(v));
});

test("sameBedSuggestion: a recorded night is Yes; a missing night is No only after a later night synced", () => {
  const day = "2031-03-05"; // its night is the Eight Sleep row dated 2031-03-06
  assert.equal(C.sameBedSuggestion(day, 7.2 * 3600, "2031-03-06").answer, "Yes");
  assert.match(C.sameBedSuggestion(day, 7.2 * 3600, "2031-03-06").source, /7\.2 h/);
  assert.equal(C.sameBedSuggestion(day, null, "2031-03-07").answer, "No");
  assert.equal(C.sameBedSuggestion(day, null, "2031-03-06"), null); // not synced past that night yet
  assert.equal(C.sameBedSuggestion(day, null, null), null);
  assert.equal(C.sameBedSuggestion(day, 3600, "2031-03-09"), null); // a short row: unclear, stays blank
});

test("appHabitSuggestions: Yes from 3 minutes in the app, never a No", () => {
  const names = new Set(["Duolingo Spanish", "Substack", "News"]);
  const out = C.appHabitSuggestions({ "com.duolingo.DuolingoMobile": 12.4, "com.substack.Substack": 0, "com.apple.news": 2.9 }, names);
  assert.deepEqual(Object.keys(out), ["Duolingo Spanish"]);
  assert.deepEqual(out["Duolingo Spanish"], { answer: "Yes", source: "Screen Time: 12 min in Duolingo" });
  assert.deepEqual(C.appHabitSuggestions({ "com.duolingo.DuolingoMobile": 30 }, new Set(["News"])), {});
  assert.deepEqual(C.appHabitSuggestions(null, names), {});
  assert.deepEqual(C.appHabitSuggestions({ "com.duolingo.DuolingoMobile": "x" }, names), {});
});

test("journaledSuggestion: an entry is Yes; no entry is No only for a finished day", () => {
  assert.equal(C.journaledSuggestion("2031-03-05", "2031-03-05", 1).answer, "Yes");
  assert.match(C.journaledSuggestion("2031-03-05", "2031-03-05", 2).source, /2 journal entries/);
  assert.equal(C.journaledSuggestion("2031-03-05", "2031-03-05", 0), null);
  assert.equal(C.journaledSuggestion("2031-03-04", "2031-03-05", 0).answer, "No");
});

// ─── the route and the screen use these rules ────────────────────────────────

test("the route never writes a pre-fill: habit_journal is only written in POST", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/habits/checkin/route.ts"), "utf8");
  const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.equal(/\.(upsert|insert|update|delete)\(/.test(get), false);
  const suggestions = route.slice(route.indexOf("async function suggestionsFor"), route.indexOf("export async function GET"));
  assert.equal(/\.(upsert|insert|update|delete)\(/.test(suggestions), false);
  assert.match(route, /groupFor\(h\.name, ch, h\.frequency\)/);
});

test("the one-tap buttons leave tonight's sleep questions out of 'No for the rest'", () => {
  const client = fs.readFileSync(path.join(SRC, "app/check-in/CheckInClient.tsx"), "utf8");
  assert.match(client, /core\.filter\(\(i\) => !i\.sleep && !cells\[i\.name\]\)/);
});
