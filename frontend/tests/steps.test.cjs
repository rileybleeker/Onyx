// Run: node --test tests/steps.test.cjs
// Daily steps from two devices (lib/steps.ts): which day a WHOOP cycle's count belongs to, one
// device per day, and that the pages that show steps actually read the new column.
// SYNTHETIC numbers only; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const S = loadTs("lib/steps.ts");

/**
 * A cycle dated `day`: its opening sleep starts at `startHour` UTC on the next clock day. No
 * timezone_offset, so the ET fallback applies (06:00 UTC in January = 01:00 EST).
 */
function cycle(day, steps, { hours = 24, startHour = 6, open = false } = {}) {
  const start = new Date(`${day}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + 1);
  start.setUTCHours(startHour);
  const end = new Date(start.getTime() + hours * 3600 * 1000);
  return {
    start_time: start.toISOString(),
    end_time: open ? null : end.toISOString(),
    onyx_behavioral_date: day,
    step_count: steps,
  };
}

/** A cycle given by its LOCAL start ("YYYY-MM-DDTHH:MM") and WHOOP offset. */
function local(localStart, hours, steps, { offset = "-04:00", open = false } = {}) {
  const start = new Date(`${localStart}:00${offset}`);
  return {
    start_time: start.toISOString(),
    end_time: open ? null : new Date(start.getTime() + hours * 3600 * 1000).toISOString(),
    timezone_offset: offset,
    step_count: steps,
  };
}

test("a WHOOP cycle's steps belong to the waking day after its own local start", () => {
  assert.equal(S.whoopStepsDay(local("2030-02-28T23:10", 24, 1)), "2030-03-01");   // evening onset: next day
  assert.equal(S.whoopStepsDay(local("2030-03-01T01:40", 24, 1)), "2030-03-01");   // after midnight: same clock day
  assert.equal(S.whoopStepsDay(local("2030-03-01T06:00", 24, 1)), "2030-03-01");   // daytime onset: its own day
  assert.equal(S.whoopStepsDay(local("2030-03-01T17:59", 24, 1)), "2030-03-01");
  assert.equal(S.whoopStepsDay(local("2030-03-01T18:00", 24, 1)), "2030-03-02");
  assert.equal(S.whoopStepsDay(local("2030-12-31T22:00", 24, 1, { offset: "+01:00" })), "2031-01-01");
  // the cycle's own offset wins; ET (with daylight time) only when it is missing or unreadable
  const west = { start_time: "2030-01-10T23:30:00+00:00", timezone_offset: "-08:00" };
  assert.equal(S.whoopStepsDay(west), "2030-01-10");
  for (const missing of [undefined, null, "", "garbage", "+99:00"]) {
    assert.equal(S.whoopStepsDay({ ...west, timezone_offset: missing }), "2030-01-11");
  }
  assert.equal(S.whoopStepsDay({ start_time: "2030-07-10T22:30:00Z" }), "2030-07-11");   // 18:30 EDT
  assert.equal(S.offsetMinutes("+0530"), 330);
  assert.equal(S.offsetMinutes("-04"), -240);
  for (const bad of [null, undefined, {}, { start_time: null }, { start_time: "soon" }, { onyx_behavioral_date: "2030-01-01" }]) {
    assert.equal(S.whoopStepsDay(bad), null);
  }
});

test("two cycles that share a behavioral date go to different days (onset after 06:00)", () => {
  // the 2026-11-14 review case, synthetic numbers: the first cycle is a minute longer
  const first = local("2030-01-03T06:27", 21.65, 5374);
  const second = local("2030-01-04T04:06", 21.6, 751);
  for (const order of [[first, second], [second, first]]) {
    assert.deepEqual(S.whoopDailySteps(order).map((d) => [d.day, d.steps]), [["2030-01-03", 5374], ["2030-01-04", 751]]);
  }
});

test("parseSteps keeps whole non-negative counts and nothing else", () => {
  assert.equal(S.parseSteps(8234), 8234);
  assert.equal(S.parseSteps("8234"), 8234);
  assert.equal(S.parseSteps(0), 0);
  for (const bad of [null, undefined, "", "n/a", true, false, -1, 12.5, NaN, Infinity, {}, []]) {
    assert.equal(S.parseSteps(bad), null, `expected ${String(bad)} to be missing`);
  }
});

test("each day shows the larger device count, labelled, never the sum", () => {
  const garmin = [
    { calendar_date: "2030-01-02", total_steps: 9100 },   // watch worn all day: Garmin is larger
    { calendar_date: "2030-01-03", total_steps: 0 },      // watch not worn: a row with 0
    { calendar_date: "2030-01-04", total_steps: null },
    { calendar_date: "2030-01-05", total_steps: 742 },    // watch worn for part of the day
    { calendar_date: "2030-01-06", total_steps: 4000 },   // a tie goes to WHOOP
    { calendar_date: "2030-01-08", total_steps: 3000 },   // Garmin only
  ];
  const whoop = [
    cycle("2030-01-01", 8800), cycle("2030-01-02", 7000), cycle("2030-01-03", 6500),
    cycle("2030-01-04", 6858), cycle("2030-01-05", 4000),
  ];
  assert.deepEqual(S.mergeDailySteps(garmin, whoop), [
    { day: "2030-01-02", steps: 9100, source: "GARMIN", partial: false },
    { day: "2030-01-03", steps: 7000, source: "WHOOP", partial: false },
    { day: "2030-01-04", steps: 6500, source: "WHOOP", partial: false },
    { day: "2030-01-05", steps: 6858, source: "WHOOP", partial: false },  // not the partial-wear 742
    { day: "2030-01-06", steps: 4000, source: "WHOOP", partial: false },
    { day: "2030-01-08", steps: 3000, source: "GARMIN", partial: false },
  ]);
});

test("a day neither device counted is absent, never zero", () => {
  const days = S.mergeDailySteps(
    [{ calendar_date: "2030-01-02", total_steps: 0 }],
    [cycle("2030-01-01", null), cycle("2030-01-05", 4000)],
  );
  assert.deepEqual(days.map((d) => d.day), ["2030-01-06"]);
});

test("the open cycle shows the count so far, flagged partial", () => {
  const onlyOpen = S.whoopDailySteps([cycle("2030-01-01", 3200, { open: true })]);
  assert.deepEqual(onlyOpen, [{ day: "2030-01-02", steps: 3200, source: "WHOOP", partial: true }]);
  // a closed cycle and the open one on the same waking day: added up, still partial
  const both = S.whoopDailySteps([local("2030-01-01T19:30", 8, 900), local("2030-01-02T03:30", 20, 3200, { open: true })]);
  assert.deepEqual(both, [{ day: "2030-01-02", steps: 4100, source: "WHOOP", partial: true }]);
});

test("two cycles on one waking day are added up, in either order", () => {
  const evening = local("2030-01-01T19:00", 9, 300);     // counts Jan 2
  const night = local("2030-01-02T04:00", 20, 9000);     // counts Jan 2 as well
  for (const order of [[evening, night], [night, evening]]) {
    assert.deepEqual(S.whoopDailySteps(order).map((d) => [d.day, d.steps]), [["2030-01-02", 9300]]);
  }
  // a cycle without a count adds nothing
  assert.deepEqual(S.whoopDailySteps([evening, { ...night, step_count: null }]).map((d) => d.steps), [300]);
});

test("output is sorted by day and tolerates junk rows", () => {
  const days = S.mergeDailySteps(
    [null, { calendar_date: "nope", total_steps: 5 }, { calendar_date: "2030-01-09T00:00:00", total_steps: "4200" }],
    [undefined, cycle("2030-01-03", 100), cycle("2030-01-01", 200), { step_count: 5 }],
  );
  assert.deepEqual(days.map((d) => [d.day, d.steps, d.source]), [
    ["2030-01-02", 200, "WHOOP"], ["2030-01-04", 100, "WHOOP"], ["2030-01-09", 4200, "GARMIN"],
  ]);
  assert.deepEqual(S.mergeDailySteps([], []), []);
  assert.deepEqual(S.mergeDailySteps(undefined, undefined), []);
});

test("the chart badge names the device, or both", () => {
  const g = { day: "2030-01-01", steps: 1, source: "GARMIN", partial: false };
  const w = { day: "2030-01-02", steps: 1, source: "WHOOP", partial: false };
  assert.equal(S.stepsSourceLabel([g]), "GARMIN");
  assert.equal(S.stepsSourceLabel([w]), "WHOOP");
  assert.equal(S.stepsSourceLabel([g, w]), "GARMIN + WHOOP");
  assert.equal(S.stepsSourceLabel([]), undefined);
});

// ─── wiring ──────────────────────────────────────────────────────────────────

const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

test("the WHOOP cycle column list carries step_count and never raw_json", () => {
  const m = /const WHOOP_CYCLE_COLS =\s*"([^"]+)"/.exec(read("lib/queries.ts"));
  assert.ok(m, "WHOOP_CYCLE_COLS not found");
  const cols = m[1].split(",").map((c) => c.trim());
  for (const needed of ["step_count", "start_time", "end_time", "onyx_behavioral_date"]) assert.ok(cols.includes(needed), needed);
  assert.ok(!cols.includes("raw_json"));
});

test("/activities draws both devices through lib/steps, without animation", () => {
  const src = read("app/activities/ActivitiesClient.tsx");
  assert.match(src, /mergeDailySteps\(summaries, whoopCycles\)/);
  const bars = src.match(/<Bar dataKey="(?:garmin|whoop)"[^>]*>/g) ?? [];
  assert.equal(bars.length, 2);
  for (const bar of bars) {
    assert.match(bar, /isAnimationActive=\{false\}/);
    assert.match(bar, /stackId="steps"/);
    assert.match(bar, /name="(Garmin|WHOOP)"/);
  }
  assert.doesNotMatch(src, /title="Daily Steps"[^>]*source="GARMIN"/, "the chart badge must follow the data");
});

test("the chat tool tells the model where WHOOP steps live and which day they are", () => {
  const src = read("app/api/chat/route.ts");
  assert.match(src, /steps_day: r\.step_count == null \? null : whoopStepsDay\(/);
  const tool = /name: "query_whoop_cycles",\s*description: "([^"]+)"/.exec(src);
  assert.ok(tool && /step_count/.test(tool[1]) && /steps_day/.test(tool[1]));
});
