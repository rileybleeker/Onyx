// Run: node --test tests/ai-usage-view.test.cjs
// The "AI tools" section of /screen-time (lib/ai-usage.ts, carried by lib/screen-time-view.ts and drawn by
// app/screen-time/ScreenTimeView.tsx). SYNTHETIC rows only: invented 2030 dates, projects alpha/beta/gamma...,
// devices pc-a/pc-b and made-up minute counts.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const A = loadTs("lib/ai-usage.ts");
const V = loadTs("lib/screen-time-view.ts");

function row(date, tool, project, over = {}) {
  return {
    device: "pc-a",
    behavioral_date: date,
    tool,
    project,
    sessions: 1,
    active_minutes: 30,
    late_active_minutes: 0,
    ...over,
  };
}

test("the column list is explicit and carries no tokens or model names", () => {
  assert.equal(A.AI_USAGE_COLUMNS, "behavioral_date,tool,project,sessions,active_minutes,late_active_minutes");
});

test("one day sums every device and project row", () => {
  const s = A.summarizeAi([
    row("2030-03-01", "claude_code", "alpha", { device: "pc-a", sessions: 2, active_minutes: 60, late_active_minutes: 20 }),
    row("2030-03-01", "claude_code", "alpha", { device: "pc-b", sessions: 1, active_minutes: 30, late_active_minutes: 10 }),
    row("2030-03-01", "codex", "beta", { device: "pc-a", sessions: 1, active_minutes: 30 }),
  ]);
  assert.equal(s.kind, "ok");
  assert.equal(s.spanDays, 1);
  assert.equal(s.activePerDay, 120);
  assert.equal(s.latePerDay, 30);
  assert.equal(s.sessionsPerDay, 4);
  assert.equal(s.skippedRows, 0);
  assert.deepEqual(
    s.topProjects.map((p) => [p.key, p.minutes, p.perDay, p.daysUsed, p.share]),
    [
      ["alpha", 90, 90, 1, 0.75],
      ["beta", 30, 30, 1, 0.25],
    ],
  );
  // Only aggregates: no day, device or row survives in the answer.
  const json = JSON.stringify(s);
  assert.ok(!json.includes("2030-") && !json.includes("pc-a") && !json.includes("pc-b"));
});

test("per day divides by the first-to-newest span, with days inside it counted as zero", () => {
  const s = A.summarizeAi([
    row("2030-03-04", "codex", "alpha", { active_minutes: 80, late_active_minutes: 40, sessions: 3 }),
    row("2030-03-01", "claude_code", "alpha", { active_minutes: 40, sessions: 1 }),
  ]);
  assert.equal(s.kind, "ok");
  assert.equal(s.spanDays, 4);
  assert.equal(s.activePerDay, 30);
  assert.equal(s.latePerDay, 10);
  assert.equal(s.sessionsPerDay, 1);
  assert.equal(s.topProjects[0].perDay, 30);
  assert.equal(s.topProjects[0].daysUsed, 2);
});

test("the tool split labels Claude Code and Codex, merges spellings, and its shares add to 1", () => {
  const s = A.summarizeAi([
    row("2030-03-01", "claude_code", "alpha", { active_minutes: 45 }),
    row("2030-03-01", "claude-code", "beta", { active_minutes: 15 }),
    row("2030-03-02", "codex", "gamma", { active_minutes: 40 }),
  ]);
  assert.deepEqual(
    s.byTool.map((t) => [t.tool, t.label, t.minutes, t.perDay]),
    [
      ["claude_code", "Claude Code", 60, 30],
      ["codex", "Codex", 40, 20],
    ],
  );
  assert.ok(Math.abs(s.byTool.reduce((a, t) => a + t.share, 0) - 1) < 1e-9);
  // Both tools are always listed, even when one had no use.
  const only = A.summarizeAi([row("2030-03-01", "codex", "alpha")]);
  assert.deepEqual(only.byTool.map((t) => [t.label, t.share]), [["Claude Code", 0], ["Codex", 1]]);
  assert.equal(A.toolLabel("other-tool"), "other-tool");
});

test("top projects are sorted by minutes, ties by name, capped at 5", () => {
  const minutes = { alpha: 50, beta: 50, gamma: 70, delta: 10, epsilon: 20, zeta: 30, eta: 5 };
  const s = A.summarizeAi(Object.entries(minutes).map(([p, m]) => row("2030-03-01", "codex", p, { active_minutes: m })));
  assert.deepEqual(s.topProjects.map((p) => p.key), ["gamma", "alpha", "beta", "zeta", "epsilon"]);
  assert.equal(s.topProjects.length, A.AI_TOP_PROJECTS);
});

test("an empty window is empty, and malformed rows are skipped and counted", () => {
  assert.deepEqual(A.summarizeAi([]), { kind: "empty" });
  const bad = [
    null,
    "x",
    row("not-a-date", "codex", "alpha"),
    row("2030-13-01", "codex", "alpha"),
    row("2030-03-01", "", "alpha"),
    row("2030-03-01", "codex", null),
    row("2030-03-01", "codex", "alpha", { active_minutes: 1.5 }),
    row("2030-03-01", "codex", "alpha", { sessions: -1 }),
    row("2030-03-01", "codex", "alpha", { late_active_minutes: null }),
  ];
  assert.deepEqual(A.summarizeAi(bad), { kind: "empty" });
  const s = A.summarizeAi([...bad, row("2030-03-01", "codex", "alpha", { active_minutes: 12 })]);
  assert.equal(s.kind, "ok");
  assert.equal(s.skippedRows, bad.length);
  assert.equal(s.activePerDay, 12);
  assert.equal(A.parseAiRow(row("2030-03-01", "codex", "alpha", { active_minutes: "12" })).activeMin, 12);
});

// ── The field in ScreenTimeViewData ────────────────────────────────────────────────────────────
const SUMMARY = {
  completeDays: 0, partialDays: 0, unverifiedDays: 0, avgTotalMin: null, avgLateNightMin: null, avgAfterMidnightMin: null,
  avgPickups: null, avgNotifications: null, bedtimeDays: 0, avgLastHourBeforeSleepMin: null, avgDuringSleepMin: null,
};
const okAi = () => ({ ...A.summarizeAi([row("2030-03-01", "codex", "alpha")]), sync: { status: "success", at: "2030-03-01T15:00:00Z" } });
const okView = (ai) => ({ kind: "ok", windowDays: 30, sync: null, skippedRows: 0, summary: SUMMARY, points: [], topApps: [], topCategories: [], ai });

test("readScreenTimeViewData accepts an ok, empty or error ai and rejects a malformed one", () => {
  for (const ai of [okAi(), { kind: "empty", sync: null }, { kind: "error", hint: "The AI tool usage query failed (code X)." }]) {
    const v = JSON.parse(JSON.stringify(okView(ai)));
    assert.deepEqual(V.readScreenTimeViewData(v), v);
    const e = { kind: "empty", windowDays: 14, sync: null, ai };
    assert.deepEqual(V.readScreenTimeViewData(e), e);
  }
  const malformed = [
    undefined,
    null,
    [],
    { kind: "ok" },
    { kind: "error" },
    { kind: "empty" },
    { kind: "other", sync: null },
    { ...okAi(), topProjects: "alpha" },
    { ...okAi(), activePerDay: "30" },
    { ...okAi(), byTool: [{ label: "Codex" }] },
  ];
  for (const ai of malformed) {
    assert.throws(() => V.readScreenTimeViewData(okView(ai)));
    assert.throws(() => V.readScreenTimeViewData({ kind: "empty", windowDays: 14, sync: null, ai }));
  }
});

test("screenTimeViewData carries ai on the ok and empty answers", () => {
  const ai = okAi();
  const v = V.screenTimeViewData({ kind: "ok", windowDays: 30, days: [], skippedRows: 0, sync: null, ai });
  assert.deepEqual(v.ai, ai);
  const e = { kind: "empty", windowDays: 30, sync: null, ai };
  assert.deepEqual(V.screenTimeViewData(e), e);
});

// ── The section on screen: its own states, never hiding the phone parts ──────────────────────
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

test("the AI section draws its tiles, split and top projects next to the phone parts", () => {
  const ai = {
    ...A.summarizeAi([
      row("2030-03-01", "claude_code", "alpha", { active_minutes: 90, late_active_minutes: 30, sessions: 2 }),
      row("2030-03-01", "codex", "beta", { device: "pc-b", active_minutes: 30, sessions: 2 }),
    ]),
    sync: { status: "success", at: "2030-03-01T15:00:00Z" },
  };
  const html = draw(okView(ai));
  for (const text of ["AI tools", "2h", "9 PM to 6 AM, per day", "Sessions", "Claude Code vs Codex", "75% / 25%", "Top projects", "alpha", "beta", "Last upload from the PC:"]) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.includes("data-charts")); // the phone charts are still there
  assert.ok(!html.includes(AI_EMPTY));

  const failed = draw(okView({ ...ai, sync: { status: "failed", at: "2030-03-01T15:00:00Z" } }));
  assert.ok(failed.includes("see the AI Tool Usage card on Status"));
});

test("the AI empty and error lines never hide the phone screen, and the section shows when the phone is empty", () => {
  const aiEmpty = draw(okView({ kind: "empty", sync: null }));
  assert.ok(aiEmpty.includes(AI_EMPTY) && aiEmpty.includes("data-charts"));

  const hint = "The AI tool usage query failed (code X). Try again in a moment.";
  const aiError = draw(okView({ kind: "error", hint }));
  assert.ok(aiError.includes(hint) && aiError.includes("data-charts"));
  assert.ok(!aiError.includes("Couldn&#x27;t load Screen Time."));

  const phoneEmpty = draw({ kind: "empty", windowDays: 30, sync: null, ai: okAi() });
  assert.ok(phoneEmpty.includes(`>${PHONE_EMPTY}<`));
  assert.ok(phoneEmpty.includes("AI tools") && phoneEmpty.includes("Top projects") && phoneEmpty.includes("alpha"));

  const bothEmpty = draw({ kind: "empty", windowDays: 30, sync: null, ai: { kind: "empty", sync: null } });
  assert.ok(bothEmpty.includes(`>${PHONE_EMPTY}<`) && bothEmpty.includes(AI_EMPTY));
});
