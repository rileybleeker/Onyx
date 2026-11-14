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
const K = loadTs("lib/checkin-cells.ts");

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
  for (const q of ["Have any alcoholic drinks?", "Feeling sick or ill?", "Experienced stress?", ...C.SLEEP_KIT, C.Q_SAME_BED, C.Q_SCREEN_IN_BED]) {
    assert.equal(C.OCCASIONAL.has(q), false, q);
  }
});

test("every sleep-kit question is a sleep question", () => {
  assert.equal(C.SLEEP_KIT.length, 5);
  assert.equal(C.SLEEP_QUESTIONS.size, 8);
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
  // loadItems moved to lib/checkin-server.ts (shared with the voice route)
  const server = fs.readFileSync(path.join(SRC, "lib/checkin-server.ts"), "utf8");
  assert.match(server, /groupFor\(h\.name, ch, h\.frequency\)/);
  assert.match(route, /loadItems\(\)/);
});

// ─── sleep is asked for finished nights only ─────────────────────────────────

test("sleepNights: last night and the one before, never tonight, never the frozen era", () => {
  assert.deepEqual(C.sleepNights("2031-03-05"), ["2031-03-04", "2031-03-03"]);
  assert.equal(C.sleepNights("2031-03-05").includes("2031-03-05"), false);
  assert.deepEqual(C.sleepNights("2031-03-05", "2031-03-03"), ["2031-03-04"]);
  assert.deepEqual(C.sleepNights("2031-03-05", "2031-03-04"), []);
  assert.deepEqual(C.sleepNights("2031-03-01"), ["2031-02-28", "2031-02-27"]); // month boundary
});

test("nightLabel names the night by the evening it started and the morning it ended", () => {
  // 2031-03-05 is a Wednesday.
  assert.deepEqual(C.nightLabel("2031-03-04", "2031-03-05"), { title: "Last night", span: "Tue night → Wed morning" });
  assert.deepEqual(C.nightLabel("2031-03-03", "2031-03-05"), { title: "Monday night", span: "Mon night → Tue morning" });
});

test("nightLabel after the day rolls over: the same night is no longer 'Last night'", () => {
  assert.equal(C.nightLabel("2031-03-04", "2031-03-05").title, "Last night");
  assert.equal(C.nightLabel("2031-03-04", "2031-03-06").title, "Tuesday night");
  assert.equal(C.nightLabel("2031-03-04", "2031-03-06").span, "Tue night → Wed morning"); // the span never changes
});

test("read-in-bed is a sleep question that stays optional", () => {
  assert.equal(C.SLEEP_QUESTIONS.has(C.Q_READ_IN_BED), true);
  assert.equal(C.groupFor(C.Q_READ_IN_BED, "whoop", "Ad Hoc"), "extra");
  // every other sleep question is asked (core)
  for (const q of C.SLEEP_QUESTIONS) if (q !== C.Q_READ_IN_BED) assert.equal(C.groupFor(q, "whoop", "Ad Hoc"), "core", q);
});

test("a sleep answer given now belongs to yesterday (the night that just ended)", () => {
  assert.equal(C.sleepAnswerDate("2031-03-05"), "2031-03-04");
  assert.equal(C.sleepAnswerDate("2031-03-01"), "2031-02-28");
});

test("fallbackBehavioralToday: Eastern time minus 6 hours", () => {
  // 2031-03-05 00:30 EST = 05:30 UTC: still behavior day 03-04
  assert.equal(C.fallbackBehavioralToday(new Date("2031-03-05T05:30:00Z")), "2031-03-04");
  // 05:59 EST: still 03-04; 06:00 EST: 03-05
  assert.equal(C.fallbackBehavioralToday(new Date("2031-03-05T10:59:00Z")), "2031-03-04");
  assert.equal(C.fallbackBehavioralToday(new Date("2031-03-05T11:00:00Z")), "2031-03-05");
  // 21:30 EDT in July (UTC-4)
  assert.equal(C.fallbackBehavioralToday(new Date("2031-07-10T01:30:00Z")), "2031-07-09");
  // Fall-back day (2026-11-01, clocks go 02:00 EDT -> 01:00 EST): 05:30 EST is still the day before
  assert.equal(C.fallbackBehavioralToday(new Date("2026-11-01T10:30:00Z")), "2026-10-31");
  assert.equal(C.fallbackBehavioralToday(new Date("2026-11-01T11:00:00Z")), "2026-11-01"); // 06:00 EST
  // Spring-forward day (2027-03-14): 05:30 EDT is still the day before, 06:30 EDT is the new day
  assert.equal(C.fallbackBehavioralToday(new Date("2027-03-14T09:30:00Z")), "2027-03-13");
  assert.equal(C.fallbackBehavioralToday(new Date("2027-03-14T10:30:00Z")), "2027-03-14");
});

test("sleepDateError: a Yes/No to a sleep question is refused for today or later, never for a past night", () => {
  const q = C.SLEEP_KIT[0];
  assert.match(C.sleepDateError(q, "2031-03-05", "2031-03-05", "Yes"), /already happened/);
  assert.match(C.sleepDateError(q, "2031-03-06", "2031-03-05", "No"), /2031-03-04/); // names last night's date
  assert.equal(C.sleepDateError(q, "2031-03-04", "2031-03-05", "Yes"), null);
  assert.equal(C.sleepDateError(q, "2031-03-05", "2031-03-05", null), null); // clearing a stray row is allowed
  assert.equal(C.sleepDateError("Experienced stress?", "2031-03-05", "2031-03-05", "Yes"), null);
  assert.match(C.sleepDateError(C.Q_READ_IN_BED, "2031-03-05", "2031-03-05", "Yes"), /already happened/);
});

test("the night's screen-in-bed pre-fill goes through the Screen Time readiness gate", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/habits/checkin/route.ts"), "utf8");
  assert.match(route, /screenInBedSuggestion\(settledLastHourMinutes\(data, night\)\)/);
  assert.equal(/minutes_last_hour_before_sleep_est/.test(route), false); // never read raw in the route
});

test("a stale page cannot write: the POST refuses a `today` that is no longer today, before anything else", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/habits/checkin/route.ts"), "utf8");
  const post = route.slice(route.indexOf("export async function POST"));
  const guard = post.indexOf("body.today !== today");
  assert.ok(guard > 0);
  assert.ok(guard < post.indexOf(".upsert("), "the stale check runs before the write");
  assert.match(post, /status: 409/);
  const client = fs.readFileSync(path.join(SRC, "app/check-in/CheckInClient.tsx"), "utf8");
  assert.match(client, /today: data\.today/);
  assert.match(client, /visibilitychange/);
});

// ─── the screen's save rules (lib/checkin-cells.ts), exercised for real ──────

const item = (name, group = "core", sleep = false) => ({ name, notionPageId: "x", category: "health", frequency: "daily", channel: "whoop", group, sleep });
const REST = "Took a rest day?";
const STRESS = "Experienced stress?";
const DAY_ITEMS = [item(REST), item(STRESS)];
const SLEEP_ITEMS = [item(TAPE, "core", true), item(C.Q_SAME_BED, "core", true), item(C.Q_READ_IN_BED, "extra", true)];
const night = (date, answers = {}, suggestions = {}) => ({ date, answers, suggestions, usualKit: {} });
const plan = (o) => K.savePlan({ dayItems: DAY_ITEMS, dayAnswers: {}, cells: {}, sleepItems: SLEEP_ITEMS, nights: [], nightCells: {}, ...o });

test("a sleep-only save sends the night and leaves an untouched day's pre-fill alone, on every press", () => {
  const cells = K.buildCells(DAY_ITEMS, {}, { [REST]: { answer: "Yes", source: "No workouts recorded" } }, {});
  assert.equal(cells[REST].origin, "suggested");
  const n = night("2031-03-04");
  const nightCells = { [n.date]: K.buildCells(SLEEP_ITEMS, {}, {}, K.draftWith({}, { [TAPE]: "Yes" }, {})) };
  const first = plan({ cells, nights: [n], nightCells });
  assert.deepEqual(first.dayPatch, {}); // the day is not sent, so its card is not settled
  assert.deepEqual(first.nightPatches, [{ date: "2031-03-04", changes: { [TAPE]: "Yes" } }]);
  assert.equal(first.changeCount, 1);
  // after that save: the night is stored, the day's pre-fill is still only a suggestion -> nothing to save
  const saved = night("2031-03-04", { [TAPE]: "Yes" });
  const second = plan({ cells, nights: [saved], nightCells: { [saved.date]: K.buildCells(SLEEP_ITEMS, saved.answers, {}, {}) } });
  assert.deepEqual(second, { dayPatch: {}, nightPatches: [], changeCount: 0 });
});

test("a touched day is sent with its pre-fills; an untouched night's pre-fill is not", () => {
  const cells = K.buildCells(DAY_ITEMS, {}, { [REST]: { answer: "Yes", source: "x" } }, K.draftWith({}, { [STRESS]: "No" }, {}));
  const n = night("2031-03-04", {}, { [C.Q_SAME_BED]: { answer: "Yes", source: "Eight Sleep: 7.0 h in your bed" } });
  const nightCells = { [n.date]: K.buildCells(SLEEP_ITEMS, n.answers, n.suggestions, {}) };
  const p = plan({ cells, nights: [n], nightCells });
  assert.deepEqual(p.dayPatch, { [REST]: "Yes", [STRESS]: "No" });
  assert.deepEqual(p.nightPatches, []);
  // one kit tap makes the night touched: its pre-fill goes with it
  const tapped = { [n.date]: K.buildCells(SLEEP_ITEMS, n.answers, n.suggestions, K.draftWith({}, { [TAPE]: "Yes" }, {})) };
  assert.deepEqual(plan({ nights: [n], nightCells: tapped }).nightPatches, [{ date: n.date, changes: { [TAPE]: "Yes", [C.Q_SAME_BED]: "Yes" } }]);
});

test("pre-fills alone are never sent; clearing a saved answer is", () => {
  const cells = K.buildCells(DAY_ITEMS, {}, { [REST]: { answer: "Yes", source: "x" } }, {});
  assert.equal(plan({ cells }).changeCount, 0);
  const cleared = K.buildCells(DAY_ITEMS, { [STRESS]: "Yes" }, {}, K.draftWith({}, { [STRESS]: null }, { [STRESS]: "Yes" }));
  assert.deepEqual(plan({ dayAnswers: { [STRESS]: "Yes" }, cells: cleared }).dayPatch, { [STRESS]: null });
});

test("drafts: a tap made mid-save survives, a sent one is dropped, a no-op or outdated one is ignored", () => {
  let draft = K.draftWith({}, { [REST]: "Yes" }, {});
  draft = K.draftWith(draft, { [STRESS]: "Yes" }, {}); // tapped while the save was in flight
  assert.deepEqual(K.draftSettled(draft, { [REST]: "Yes" }), { [STRESS]: { a: "Yes", base: null } });
  // re-tapped to a different answer mid-save: stays
  assert.deepEqual(Object.keys(K.draftSettled(K.draftWith({}, { [REST]: "No" }, {}), { [REST]: "Yes" })), [REST]);
  // the stored answer changed elsewhere since the tap (base differs): server wins
  const outdated = K.draftWith({}, { [REST]: null }, {}); // blanked a pre-fill when nothing was stored
  assert.equal(K.buildCells(DAY_ITEMS, { [REST]: "No" }, {}, outdated)[REST].origin, "saved");
  // a null that blanks a still-present pre-fill is kept; one with nothing to blank is a no-op
  assert.equal(K.buildCells(DAY_ITEMS, {}, { [REST]: { answer: "Yes", source: "x" } }, outdated)[REST], undefined);
  assert.deepEqual(plan({ cells: K.buildCells(DAY_ITEMS, {}, {}, outdated) }).dayPatch, {});
  // a draft equal to what is stored is not pending
  assert.equal(K.buildCells(DAY_ITEMS, { [REST]: "Yes" }, {}, K.parseDraft({ [REST]: "Yes" }))[REST].origin, "saved");
});

test("parseDraft reads old bare answers and the new shape, and drops junk", () => {
  assert.deepEqual(K.parseDraft({ a: "Yes", b: null, c: { a: "No", base: "Yes" }, d: { a: null, base: null }, e: 5, f: { a: "maybe" }, g: { a: "Yes" } }), {
    a: { a: "Yes" },
    b: { a: null },
    c: { a: "No", base: "Yes" },
    d: { a: null, base: null },
    g: { a: "Yes", base: undefined },
  });
  for (const junk of [null, "x", 3, [1, 2]]) assert.deepEqual(K.parseDraft(junk), {});
});

test("visibleNights: last night always; an earlier night while incomplete or holding an unsaved tap", () => {
  const last = night("2031-03-04", { [TAPE]: "Yes", [C.Q_SAME_BED]: "Yes" });
  const earlierDone = night("2031-03-03", { [TAPE]: "Yes", [C.Q_SAME_BED]: "Yes" });
  const earlierOpen = night("2031-03-03", { [TAPE]: "Yes" });
  const dates = (ns, nc = {}) => K.visibleNights(ns, SLEEP_ITEMS, nc).map((n) => n.date);
  assert.deepEqual(dates([last, earlierDone]), ["2031-03-04"]); // the optional read-in-bed row does not keep it open
  assert.deepEqual(dates([last, earlierOpen]), ["2031-03-04", "2031-03-03"]);
  // complete, but with an unsaved tap on the optional row: stays so the tap can be saved
  const tapped = { "2031-03-03": K.buildCells(SLEEP_ITEMS, earlierDone.answers, {}, K.draftWith({}, { [C.Q_READ_IN_BED]: "Yes" }, earlierDone.answers)) };
  assert.deepEqual(dates([last, earlierDone], tapped), ["2031-03-04", "2031-03-03"]);
  assert.deepEqual(K.visibleNights([last], [], {}), []);
});

test("the screen wires the save plan: day under its date with the card settle, nights under theirs", () => {
  const client = fs.readFileSync(path.join(SRC, "app/check-in/CheckInClient.tsx"), "utf8");
  assert.match(client, /savePlan\(\{ dayItems, dayAnswers: data\?\.answers \?\? \{\}, cells, sleepItems, nights, nightCells \}\)/);
  const save = client.slice(client.indexOf("const save = async"), client.indexOf("const goTo"));
  const dayBranch = save.slice(save.indexOf("if (Object.keys(dayPatch).length)"), save.indexOf("for (const n of nightPatches)"));
  assert.match(dayBranch, /agentsApi\.checkinDone\(data\.date\)/); // only when the day was sent
  assert.equal((save.match(/checkinDone/g) || []).length, 1);
  // a refused stale page drops its unsaved taps before redrawing
  const stale = save.slice(save.indexOf("e instanceof StaleDayError"));
  assert.ok(stale.indexOf("settleDraft(dayDraftKey(data.date), dayPatch)") < stale.indexOf("await load(requested)"));
});

test("other write paths keep sleep answers off today", () => {
  const chat = fs.readFileSync(path.join(SRC, "app/api/chat/route.ts"), "utf8");
  assert.match(chat, /if \(!date\) date = sleepAnswerDate\(today\)/);
  assert.match(chat, /const tonight = sleepDateError\(habit, date, today, answer\)/);
  assert.equal(/toLocaleDateString\("en-CA", \{ timeZone: "America\/New_York" \}\)/.test(chat.slice(chat.indexOf('name === "mark_habit_complete"'), chat.indexOf("WHOOP-era rows"))), false);
  const complete = fs.readFileSync(path.join(SRC, "app/api/habits/complete/route.ts"), "utf8");
  assert.match(complete, /sleepDateError\(habit, completionDate, today, answer\)/);
  const checkin = fs.readFileSync(path.join(SRC, "app/api/habits/checkin/route.ts"), "utf8");
  assert.match(checkin, /sleepDateError\(name, date, today, raw\)/);
  const habits = fs.readFileSync(path.join(SRC, "app/habits/HabitsClient.tsx"), "utf8");
  assert.match(habits, /habits\.filter\(\(h\) => !SLEEP_QUESTIONS\.has\(h\.name\)\)\.map/);
});

test("the route builds nights from sleepNights and keeps sleep answers out of the day", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/habits/checkin/route.ts"), "utf8");
  assert.match(route, /sleepNights\(today, WHOOP_JOURNAL_FROZEN_THROUGH\)/);
  assert.match(route, /suggestionsFor\(date, today, dayNames\)/);
  assert.match(route, /total: dayCore\.size/);
  assert.equal(/usualKit: kit\b/.test(route), false);
});

test("the screen saves each night under the night's own date, and never asks about tonight", () => {
  const client = fs.readFileSync(path.join(SRC, "app/check-in/CheckInClient.tsx"), "utf8");
  assert.match(client, /await post\(n\.date, n\.changes\)/);
  assert.match(client, /await post\(data\.date, dayPatch\)/);
  assert.match(client, /Tonight is asked tomorrow/);
  assert.equal(/Tonight's sleep/.test(client), false);
  // sleep questions are not part of the day tab: "No for the rest" and the progress bar only see daytime items
  assert.match(client, /const dayItems = items\.filter\(\(i\) => !isNightItem\(i\)\)/);
  assert.match(client, /const core = dayItems\.filter/);
});
