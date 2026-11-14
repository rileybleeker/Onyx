// Run: node --test tests/checkin-screen.test.cjs
// Readiness gate for the "Viewed a screen device in bed?" pre-fill (lib/checkin-screen.ts) and its
// one call site in /api/habits/checkin. SYNTHETIC rows only: invented dates and minutes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const G = loadTs("lib/checkin-screen.ts");
const C = loadTs("lib/checkin.ts");

const DAY = "2030-01-10";
// January: New York is UTC-5. Sleep onset 01:00 ET on the 11th, sync 10:00 ET on the 11th.
function row(over = {}) {
  return {
    behavioral_date: DAY,
    sleep_start: "2030-01-11T06:00:00+00:00",
    synced_at: "2030-01-11T15:00:00+00:00",
    minutes_last_hour_before_sleep_est: 28.3,
    minutes_by_app: {},
    ...over,
  };
}
const suggest = (r, date = DAY) => C.screenInBedSuggestion(G.settledLastHourMinutes(r, date));

test("a settled day passes its minutes through, so the existing Yes / No rule applies", () => {
  assert.equal(G.settledLastHourMinutes(row(), DAY), 28.3);
  assert.equal(G.settledLastHourMinutes(row({ minutes_last_hour_before_sleep_est: "12.5" }), DAY), 12.5);
  assert.equal(suggest(row()).answer, "Yes");
  assert.equal(suggest(row({ minutes_last_hour_before_sleep_est: 0 })).answer, "No");
  assert.equal(suggest(row({ minutes_last_hour_before_sleep_est: 5 })), null);
  assert.equal(suggest(row({ minutes_last_hour_before_sleep_est: 19.9 })), null);
  assert.equal(suggest(row({ minutes_last_hour_before_sleep_est: 20 })).answer, "Yes");
});

test("sleep scored but the phone has not synced since: blank, not a No from missing data", () => {
  // The view reports 0 here. Last sync was the morning of the day itself (10:00 ET on the 10th).
  const beforeSync = row({ minutes_last_hour_before_sleep_est: 0, synced_at: "2030-01-10T15:00:00+00:00" });
  assert.equal(C.screenInBedSuggestion(0).answer, "No"); // what the ungated rule would have said
  assert.equal(G.settledLastHourMinutes(beforeSync, DAY), null);
  assert.equal(suggest(beforeSync), null);
});

test("blank at 05:59 ET the next day, offered from 06:00 ET when the sync is an hour past sleep onset", () => {
  assert.equal(suggest(row({ synced_at: "2030-01-11T10:59:00Z" })), null);
  assert.equal(suggest(row({ synced_at: "2030-01-11T11:00:00Z" })).answer, "Yes");
  // Sleep began 05:30 ET; a 06:10 ET sync has not sent the whole hour that straddles onset.
  const late = { sleep_start: "2030-01-11T10:30:00Z" };
  assert.equal(suggest(row({ ...late, synced_at: "2030-01-11T11:10:00Z" })), null);
  assert.equal(suggest(row({ ...late, synced_at: "2030-01-11T11:30:00Z" })).answer, "Yes");
});

test("no scored sleep, no sync time, no row, or another day's row: blank", () => {
  assert.equal(suggest(row({ sleep_start: null, minutes_last_hour_before_sleep_est: null })), null);
  assert.equal(suggest(row({ synced_at: null })), null);
  assert.equal(suggest(row({ minutes_last_hour_before_sleep_est: null })), null);
  assert.equal(suggest(null), null);
  assert.equal(suggest(undefined), null);
  assert.equal(suggest({}), null);
  assert.equal(suggest(row(), "2030-01-11"), null);
});

test("the question text is the frozen habit name and the gate does not touch the answer rule", () => {
  assert.equal(C.Q_SCREEN_IN_BED, "Viewed a screen device in bed?");
  const gate = fs.readFileSync(path.join(SRC, "lib/checkin-screen.ts"), "utf8");
  assert.ok(!/answer:/.test(gate));
});

test("the route reads the gate's columns and passes the minutes through the gate", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/habits/checkin/route.ts"), "utf8");
  // Since the sleep questions moved to the per-night blocks, the gate is asked about that night's behavior day.
  assert.match(route, /screenInBedSuggestion\(settledLastHourMinutes\(data, night\)\)/);
  assert.match(route, /\.from\("phone_usage_daily"\)\s*\.select\(CHECKIN_SCREEN_COLUMNS\)/);
  assert.ok(!/screenInBedSuggestion\(row\./.test(route));
  for (const col of ["behavioral_date", "sleep_start", "synced_at", "minutes_last_hour_before_sleep_est", "minutes_by_app"]) {
    assert.ok(G.CHECKIN_SCREEN_COLUMNS.includes(col), col);
  }
});

test("app-habit pre-fills (Yes only) still read the same row", () => {
  const out = C.appHabitSuggestions({ "com.duolingo.DuolingoMobile": 12 }, new Set(["Duolingo Spanish"]));
  assert.equal(out["Duolingo Spanish"].answer, "Yes");
  const route = fs.readFileSync(path.join(SRC, "app/api/habits/checkin/route.ts"), "utf8");
  assert.match(route, /appHabitSuggestions\(row\.minutes_by_app, names\)/);
});
