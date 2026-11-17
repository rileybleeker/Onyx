// Run: node --test tests/checkin-pc-activity.test.cjs
// The /check-in pre-fills from PC activity (lib/checkin-pc-activity.ts): which questions the PC's
// per-program minutes answer, the completeness gate, and the never-No rule.
// SYNTHETIC DATA ONLY: invented dates, minutes and program names; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const P = loadTs("lib/checkin-pc-activity.ts");

const Q_TOOLS = "BI/Python/AL/Excel"; // the frozen occasional question (OCCASIONAL in lib/checkin.ts)
const Q_LATE = "Worked late?";

/** A complete day: synced_at is 07:00 ET of the day AFTER the behavioral day, so all its hours are in. */
function day(over = {}) {
  return P.parsePcActivityRow({
    behavioral_date: "2031-03-05",
    active_minutes: 120,
    late_active_minutes: 30,
    minutes_by_app: { code: 34, chrome: 60 },
    synced_at: "2031-03-06T07:00:00-05:00",
    ...over,
  });
}

// ─── parse ─────────────────────────────────────────────────────────────────────

test("parsePcActivityRow: null on garbage, a day on a real row", () => {
  assert.equal(P.parsePcActivityRow(null), null);
  assert.equal(P.parsePcActivityRow("row"), null);
  assert.equal(P.parsePcActivityRow({ behavioral_date: "not-a-date" }), null);
  const d = day();
  assert.equal(d.date, "2031-03-05");
  assert.equal(d.dayComplete, true);
  assert.deepEqual(d.byApp, { code: 34, chrome: 60 });
});

test("parsePcActivityRow: a sync before the day ended leaves the day incomplete (the settled rule)", () => {
  // 05:00 ET of the next day is before 06:00: the day's last hours may not be uploaded yet.
  assert.equal(day({ synced_at: "2031-03-06T05:00:00-05:00" }).dayComplete, false);
  assert.equal(day({ synced_at: "2031-03-06T06:00:00-05:00" }).dayComplete, true);
  assert.equal(day({ synced_at: null }).dayComplete, false);
  // DST: 2031 switches to EDT on March 9, so on March 6 -04:00 is 05:00 ET (not complete). In summer
  // (EDT) 06:00 ET is 10:00 UTC, which is -04:00 on the wall clock, and still counts.
  assert.equal(day({ synced_at: "2031-03-06T06:00:00-04:00" }).dayComplete, false);
  assert.equal(
    P.parsePcActivityRow({ behavioral_date: "2031-07-05", synced_at: "2031-07-06T06:00:00-04:00" }).dayComplete,
    true,
  );
});

test("parsePcActivityRow: byApp keeps only positive finite minutes", () => {
  const d = day({ minutes_by_app: { code: 10, chrome: 0, editor: -1, ghost: "x", empty: "", other: "12.5" } });
  assert.deepEqual(d.byApp, { code: 10, other: 12.5 });
});

// ─── which questions apply ─────────────────────────────────────────────────────

test("questionTokens splits a title into its words", () => {
  assert.deepEqual([...P.questionTokens(Q_TOOLS)].sort(), ["al", "bi", "excel", "python"]);
});

test("pcActivityApplies: tooling and worked-late questions, nothing else", () => {
  assert.equal(P.pcActivityApplies([Q_TOOLS]), true);
  assert.equal(P.pcActivityApplies([Q_LATE]), true);
  assert.equal(P.pcActivityApplies(["Have any alcoholic drinks?", "Meditated", "AI"]), false);
  assert.equal(P.pcActivityApplies([]), false);
});

// ─── suggestions ───────────────────────────────────────────────────────────────

test("a tooling question is Yes at 20+ minutes of a mapped program (code / python)", () => {
  const s = P.pcActivitySuggestions(day(), new Set([Q_TOOLS]));
  assert.deepEqual(s, { [Q_TOOLS]: { answer: "Yes", source: "PC activity: 34 min in Python, 34 min in AL" } });
});

test("excel and pbidesktop answer through their own words", () => {
  const s = P.pcActivitySuggestions(day({ minutes_by_app: { excel: 21, pbidesktop: 40, code: 1 } }), new Set([Q_TOOLS]));
  assert.deepEqual(s, { [Q_TOOLS]: { answer: "Yes", source: "PC activity: 40 min in Power BI, 21 min in Excel" } });
});

test("below the threshold there is no suggestion at all — never a No", () => {
  const s = P.pcActivitySuggestions(day({ minutes_by_app: { code: 19.6 } }), new Set([Q_TOOLS]));
  assert.deepEqual(s, {});
  assert.deepEqual(P.pcActivitySuggestions(day({ minutes_by_app: {} }), new Set([Q_TOOLS])), {});
});

test("an incomplete day suggests nothing, whatever the minutes", () => {
  const partial = day({ minutes_by_app: { code: 300 }, synced_at: "2031-03-05T23:00:00-05:00" });
  assert.equal(partial.dayComplete, false);
  assert.deepEqual(P.pcActivitySuggestions(partial, new Set([Q_TOOLS, Q_LATE])), {});
});

test("a question whose words merely contain a token's letters is never matched", () => {
  // "alcoholic" contains "al" as a substring; token matching must not fire.
  const s = P.pcActivitySuggestions(day({ minutes_by_app: { code: 500 } }), new Set(["Have any alcoholic drinks?"]));
  assert.deepEqual(s, {});
});

test("a worked-late question is Yes at 45+ late minutes, nothing below", () => {
  const names = new Set([Q_LATE]);
  assert.deepEqual(P.pcActivitySuggestions(day({ late_active_minutes: 45 }), names), {
    [Q_LATE]: { answer: "Yes", source: "PC activity: 45 min at the PC from 21:00 on" },
  });
  assert.deepEqual(P.pcActivitySuggestions(day({ late_active_minutes: 44.5 }), names), {});
  assert.deepEqual(P.pcActivitySuggestions(day({ late_active_minutes: null }), names), {});
});

test("only the questions asked for are filled", () => {
  const s = P.pcActivitySuggestions(day(), new Set(["Meditated"]));
  assert.deepEqual(s, {});
});

test(`a "worked late" style title in other wording still matches`, () => {
  const s = P.pcActivitySuggestions(day({ late_active_minutes: 60 }), new Set(["Worked late on the laptop?"]));
  assert.deepEqual(s, { "Worked late on the laptop?": { answer: "Yes", source: "PC activity: 60 min at the PC from 21:00 on" } });
});
