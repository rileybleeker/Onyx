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

/** A cycle dated `day`: its opening sleep starts in the small hours of the next clock day. */
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

test("a WHOOP cycle's steps belong to the day after its behavioral date", () => {
  assert.equal(S.whoopStepsDay({ onyx_behavioral_date: "2030-01-01" }), "2030-01-02");
  assert.equal(S.whoopStepsDay({ onyx_behavioral_date: "2030-02-28" }), "2030-03-01");
  assert.equal(S.whoopStepsDay({ onyx_behavioral_date: "2030-12-31" }), "2031-01-01");
  for (const bad of [null, undefined, {}, { onyx_behavioral_date: null }, { onyx_behavioral_date: "soon" }]) {
    assert.equal(S.whoopStepsDay(bad), null);
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

test("WHOOP fills the days Garmin has no steps, and each day names its device", () => {
  const garmin = [
    { calendar_date: "2030-01-02", total_steps: 9100 },
    { calendar_date: "2030-01-03", total_steps: 0 },      // watch not worn: a row with 0
    { calendar_date: "2030-01-04", total_steps: null },
  ];
  const whoop = [cycle("2030-01-01", 8800), cycle("2030-01-02", 7000), cycle("2030-01-03", 6500)];
  assert.deepEqual(S.mergeDailySteps(garmin, whoop), [
    { day: "2030-01-02", steps: 9100, source: "GARMIN", partial: false },  // both exist: Garmin, never the sum
    { day: "2030-01-03", steps: 7000, source: "WHOOP", partial: false },
    { day: "2030-01-04", steps: 6500, source: "WHOOP", partial: false },
  ]);
});

test("a day neither device counted is absent, never zero", () => {
  const days = S.mergeDailySteps(
    [{ calendar_date: "2030-01-02", total_steps: 0 }],
    [cycle("2030-01-01", null), cycle("2030-01-05", 4000)],
  );
  assert.deepEqual(days.map((d) => d.day), ["2030-01-06"]);
});

test("the open cycle shows the count so far, flagged partial, and loses to a closed cycle", () => {
  const onlyOpen = S.whoopDailySteps([cycle("2030-01-01", 3200, { open: true })]);
  assert.deepEqual(onlyOpen, [{ day: "2030-01-02", steps: 3200, source: "WHOOP", partial: true }]);
  const both = S.whoopDailySteps([cycle("2030-01-01", 3200, { open: true }), cycle("2030-01-01", 9000, { startHour: 2 })]);
  assert.deepEqual(both, [{ day: "2030-01-02", steps: 9000, source: "WHOOP", partial: false }]);
});

test("two cycles on one day: the longest wins, in either order", () => {
  const short = cycle("2030-01-01", 300, { hours: 2 });
  const long = cycle("2030-01-01", 9000, { startHour: 9 });
  for (const order of [[short, long], [long, short]]) {
    assert.deepEqual(S.whoopDailySteps(order).map((d) => d.steps), [9000]);
  }
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
