// Run: node --test tests/pc-activity-view.test.cjs
// The "PC" section of /screen-time (lib/pc-activity-view.ts, carried by lib/screen-time-view.ts and drawn by
// app/screen-time/ScreenTimeView.tsx). SYNTHETIC rows only: invented 2030 dates, programs code/excel/chrome/...,
// made-up minute counts.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const P = loadTs("lib/pc-activity-view.ts");
const V = loadTs("lib/screen-time-view.ts");

/** Next day, 08:00 ET (12:00 UTC in March 2030): after the day ended, so the day is complete.
 *  A malformed date (the skipped-row cases) has no next day: its synced_at stays an unparseable string. */
const COMPLETE = (date) => {
  const d = new Date(date + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return date + "T12:00:00Z";
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
};
/** The same day's afternoon: the day's evening hours may not be in yet. */
const INCOMPLETE = (date) => date + "T20:00:00Z";

function row(date, over = {}) {
  return {
    behavioral_date: date,
    active_minutes: 60,
    late_active_minutes: 0,
    minutes_by_app: { code: 60 },
    synced_at: COMPLETE(date),
    ...over,
  };
}

test("the column list is explicit", () => {
  assert.equal(P.PC_VIEW_COLUMNS, "behavioral_date,active_minutes,late_active_minutes,minutes_by_app,synced_at");
});

test("per-day means divide by complete days only; incomplete days are logged but left out", () => {
  const s = P.summarizePc([
    row("2030-03-01", { active_minutes: 120, late_active_minutes: 30 }),
    row("2030-03-02", { active_minutes: 60, late_active_minutes: 0 }),
    row("2030-03-03", { active_minutes: 500, late_active_minutes: 200, synced_at: INCOMPLETE("2030-03-03") }),
  ]);
  assert.equal(s.kind, "ok");
  assert.equal(s.completeDays, 2);
  assert.equal(s.loggedDays, 3);
  assert.equal(s.activePerDay, 90);
  assert.equal(s.latePerDay, 15);
  assert.equal(s.skippedRows, 0);
  // A row with no synced_at is not complete either.
  const t = P.summarizePc([row("2030-03-01", { active_minutes: 40 }), row("2030-03-02", { synced_at: null })]);
  assert.equal(t.completeDays, 1);
  assert.equal(t.activePerDay, 40);
  // Only aggregates leave: no day survives in the answer.
  assert.ok(!JSON.stringify(s).includes("2030-"));
});

test("a window with only an incomplete day has no means", () => {
  const s = P.summarizePc([row("2030-03-05", { active_minutes: 45, synced_at: INCOMPLETE("2030-03-05") })]);
  assert.equal(s.kind, "ok");
  assert.equal(s.completeDays, 0);
  assert.equal(s.loggedDays, 1);
  assert.equal(s.activePerDay, null);
  assert.equal(s.latePerDay, null);
  assert.deepEqual(s.topPrograms.map((p) => [p.key, p.minutes]), [["code", 60]]);
});

test("program minutes sum over every logged day, ranked by total with ties by name, capped at 10", () => {
  const s = P.summarizePc([
    row("2030-03-01", { minutes_by_app: { code: 60, excel: 30 } }),
    row("2030-03-02", { minutes_by_app: { code: 20, chrome: 50, notepad: 0 } }),
    row("2030-03-03", { minutes_by_app: { excel: 40, beta: 50 }, synced_at: INCOMPLETE("2030-03-03") }),
  ]);
  assert.deepEqual(
    s.topPrograms.map((p) => [p.key, p.label, p.minutes, p.daysUsed]),
    [
      ["code", "code", 80, 2],
      ["excel", "excel", 70, 2],
      ["beta", "beta", 50, 1],
      ["chrome", "chrome", 50, 1],
    ],
  );
  assert.ok(Math.abs(s.topPrograms.reduce((a, p) => a + p.share, 0) - 1) < 1e-9);

  const many = {};
  for (let i = 0; i < 12; i++) many[`prog${String(i).padStart(2, "0")}`] = 100 - i;
  const capped = P.summarizePc([row("2030-03-01", { minutes_by_app: many })]);
  assert.equal(capped.topPrograms.length, P.PC_TOP_PROGRAMS);
  assert.equal(P.PC_TOP_PROGRAMS, 10);
  assert.equal(capped.topPrograms[0].key, "prog00");
  assert.equal(capped.topPrograms[9].key, "prog09");
});

test("malformed rows are skipped and counted; only zero rows is empty, all-unreadable is unreadable (PC835-2)", () => {
  assert.deepEqual(P.summarizePc([]), { kind: "empty" });
  const bad = [
    null,
    "x",
    42,
    [],
    row("not-a-date"),
    row("2030-13-01"),
    row("2030-03-01", { active_minutes: "30" }),
    row("2030-03-01", { late_active_minutes: "5" }),
    row("2030-03-01", { active_minutes: null }),
    row("2030-03-01", { active_minutes: -1 }),
  ];
  assert.deepEqual(P.summarizePc(bad), { kind: "unreadable", skippedRows: bad.length });
  assert.deepEqual(P.summarizePc([null]), { kind: "unreadable", skippedRows: 1 });
  const hint = P.pcUnreadableHint(bad.length);
  assert.ok(hint.includes(String(bad.length)) && !/no (pc )?activity/i.test(hint), hint);
  const s = P.summarizePc([...bad, row("2030-03-01", { active_minutes: 12 })]);
  assert.equal(s.kind, "ok");
  assert.equal(s.skippedRows, bad.length);
  assert.equal(s.activePerDay, 12);
  assert.equal(s.loggedDays, 1);
});

// ── The field in ScreenTimeViewData ────────────────────────────────────────────────────────────
const SUMMARY = {
  completeDays: 0, partialDays: 0, unverifiedDays: 0, avgTotalMin: null, avgLateNightMin: null, avgAfterMidnightMin: null,
  avgPickups: null, avgNotifications: null, bedtimeDays: 0, avgLastHourBeforeSleepMin: null, avgDuringSleepMin: null,
};
const AI_EMPTY_SECTION = { kind: "empty", sync: null };
const okPc = () => ({
  ...P.summarizePc([row("2030-03-01", { minutes_by_app: { code: 50, excel: 10 } })]),
  sync: { status: "success", at: "2030-03-02T15:00:00Z" },
});
const okView = (pc) => {
  const v = { kind: "ok", windowDays: 30, sync: null, skippedRows: 0, summary: SUMMARY, points: [], topApps: [], topCategories: [], ai: AI_EMPTY_SECTION };
  return pc === undefined ? v : { ...v, pc };
};
const emptyView = (pc) => {
  const v = { kind: "empty", windowDays: 30, sync: null, ai: AI_EMPTY_SECTION };
  return pc === undefined ? v : { ...v, pc };
};

test("readScreenTimeViewData accepts a valid or absent pc and rejects a malformed one", () => {
  const valid = [
    okPc(),
    { ...P.summarizePc([row("2030-03-05", { synced_at: INCOMPLETE("2030-03-05") })]), sync: null },
    { kind: "empty", sync: null },
    { kind: "error", hint: "The PC activity query failed (code X). Try again in a moment." },
  ];
  for (const pc of valid) {
    const v = JSON.parse(JSON.stringify(okView(pc)));
    assert.deepEqual(V.readScreenTimeViewData(v), v);
    const e = JSON.parse(JSON.stringify(emptyView(pc)));
    assert.deepEqual(V.readScreenTimeViewData(e), e);
  }
  // A cached answer from before the field existed.
  assert.deepEqual(V.readScreenTimeViewData(okView()), okView());
  assert.deepEqual(V.readScreenTimeViewData(emptyView()), emptyView());

  const malformed = [
    null,
    [],
    "pc",
    { kind: "ok" },
    { kind: "error" },
    { kind: "empty" },
    { kind: "other", sync: null },
    { ...okPc(), topPrograms: "code" },
    { ...okPc(), activePerDay: "30" },
    { ...okPc(), completeDays: null },
    { ...okPc(), topPrograms: [{ key: "code" }] },
    { ...okPc(), sync: { at: 5 } },
  ];
  for (const pc of malformed) {
    assert.throws(() => V.readScreenTimeViewData(okView(pc)));
    assert.throws(() => V.readScreenTimeViewData(emptyView(pc)));
  }
});

const errorView = (ai, pc) => {
  const v = { kind: "error", hint: "The database query failed (code X). Try again in a moment." };
  return { ...v, ...(ai === undefined ? {} : { ai }), ...(pc === undefined ? {} : { pc }) };
};

test("an error answer validates with ai and pc, with neither, and throws on a malformed one (PC835-3)", () => {
  for (const v of [errorView(AI_EMPTY_SECTION, okPc()), errorView(AI_EMPTY_SECTION), errorView(undefined, okPc()), errorView()]) {
    const j = JSON.parse(JSON.stringify(v));
    assert.deepEqual(V.readScreenTimeViewData(j), j);
  }
  assert.throws(() => V.readScreenTimeViewData(errorView(AI_EMPTY_SECTION, { kind: "ok" })));
  assert.throws(() => V.readScreenTimeViewData(errorView(AI_EMPTY_SECTION, { ...okPc(), topPrograms: "code" })));
  assert.throws(() => V.readScreenTimeViewData(errorView({ kind: "other" }, okPc())));
  // The error answer passes through with both sections.
  const load = errorView(AI_EMPTY_SECTION, okPc());
  assert.deepEqual(V.screenTimeViewData(load), load);
});

test("screenTimeViewData carries pc on the ok and empty answers", () => {
  const pc = okPc();
  const v = V.screenTimeViewData({ kind: "ok", windowDays: 30, days: [], skippedRows: 0, sync: null, ai: AI_EMPTY_SECTION, pc });
  assert.deepEqual(v.pc, pc);
  const e = emptyView(pc);
  assert.deepEqual(V.screenTimeViewData(e), e);
});

// ── The section on screen: its own states, never hiding the phone or AI parts ─────────────────
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const chartStub = ({ points }) => React.createElement("div", { "data-charts": points.length });
const View = loadTs("app/screen-time/ScreenTimeView.tsx", {
  "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "./ScreenTimeCharts": { __esModule: true, DailyTotalChart: chartStub, LateNightChart: chartStub, PickupsChart: chartStub, SleepOnsetChart: chartStub },
}).default;
const draw = (data) => renderToStaticMarkup(React.createElement(View, { data, windowDays: 30, feed: true, onWindow: () => {} }));
const PHONE_EMPTY = "No Screen Time days in this window.";
const AI_EMPTY = "No AI tool sessions recorded in this window.";
const PC_EMPTY = "No PC activity recorded in this window.";

test("the PC section draws its tiles, top programs and upload line after the AI tools section", () => {
  const html = draw(okView(okPc()));
  for (const text of [
    "Active at the PC", "Late at the PC", "9 PM to 6 AM", "Days logged", "1 of 30", "Top programs", "code", "excel", "50m",
    "Last upload from the PC:", "per day, over 1 ended day", "Window total, includes partial days",
  ]) {
    assert.ok(html.includes(text), text);
  }
  // PC835-1: the PC tiles claim ended days, never complete ones.
  const pcHtml = html.slice(html.indexOf("Active at the PC"));
  assert.ok(!/complete day/i.test(pcHtml), "PC section says ended, not complete");
  assert.ok(html.indexOf(AI_EMPTY) < html.indexOf("Active at the PC"), "PC comes after AI tools");
  assert.ok(html.includes("data-charts")); // the phone charts are still there
  assert.ok(!html.includes(PC_EMPTY) && !html.includes("still uploading"));

  const failed = draw(okView({ ...okPc(), sync: { status: "failed", at: "2030-03-02T15:00:00Z" } }));
  assert.ok(failed.includes("PC Activity card on Status</a>"));
});

test("a window with only an incomplete day shows dashes and the still-uploading line", () => {
  const pc = { ...P.summarizePc([row("2030-03-05", { synced_at: INCOMPLETE("2030-03-05") })]), sync: null };
  const html = draw(okView(pc));
  assert.ok(html.includes("No ended day yet: the newest day is still uploading."));
  assert.ok(html.includes("per ended day"));
  assert.ok(!html.includes("No complete day yet") && !html.includes("per complete day"));
  assert.ok(/Active at the PC<\/p>.*?>-<\/p>/s.test(html), "active tile shows -");
});

test("a phone query failure still draws the AI and PC sections under the error box (PC835-3)", () => {
  const html = draw(errorView(AI_EMPTY_SECTION, okPc()));
  assert.ok(html.includes("Couldn&#x27;t load Screen Time."));
  assert.ok(html.includes(AI_EMPTY) && html.includes("Active at the PC") && html.includes("Top programs"));
  assert.ok(html.indexOf("Couldn&#x27;t load Screen Time.") < html.indexOf("Active at the PC"), "PC under the error box");
  assert.ok(html.includes("1 of 30"), "days logged uses the page's window");

  // Neither section (not configured, a throw): only the error box.
  const bare = draw(errorView());
  assert.ok(bare.includes("Couldn&#x27;t load Screen Time.") && !bare.includes(AI_EMPTY) && !bare.includes("Active at the PC"));
});

test("all-unreadable PC rows show the count as the PC error line, never 'No PC activity recorded' (PC835-2)", () => {
  const pc = { kind: "error", hint: P.pcUnreadableHint(3) };
  for (const html of [draw(okView(pc)), draw(emptyView(pc)), draw(errorView(AI_EMPTY_SECTION, pc))]) {
    assert.ok(html.includes("3 PC activity row(s) could not be read."));
    assert.ok(!html.includes(PC_EMPTY));
  }
});

test("the PC empty and error lines never hide the phone or AI parts, and show when the phone is empty", () => {
  const pcEmpty = draw(okView({ kind: "empty", sync: null }));
  assert.ok(pcEmpty.includes(PC_EMPTY) && pcEmpty.includes("data-charts") && pcEmpty.includes(AI_EMPTY));

  const hint = "The PC activity view is missing or not readable by the server (code 42P01).";
  const pcError = draw(okView({ kind: "error", hint }));
  assert.ok(pcError.includes(hint) && pcError.includes("data-charts") && pcError.includes(AI_EMPTY));
  assert.ok(!pcError.includes("Couldn&#x27;t load Screen Time."));

  const phoneEmpty = draw(emptyView(okPc()));
  assert.ok(phoneEmpty.includes(`>${PHONE_EMPTY}<`) && phoneEmpty.includes(AI_EMPTY));
  assert.ok(phoneEmpty.includes("Active at the PC") && phoneEmpty.includes("Top programs"));

  const allEmpty = draw(emptyView({ kind: "empty", sync: null }));
  assert.ok(allEmpty.includes(`>${PHONE_EMPTY}<`) && allEmpty.includes(AI_EMPTY) && allEmpty.includes(PC_EMPTY));

  // A cached answer without pc still draws the phone and AI parts, and no PC section.
  const old = draw(okView());
  assert.ok(old.includes("data-charts") && old.includes(AI_EMPTY) && !old.includes("Active at the PC"));
});
