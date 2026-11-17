// Run: node --test tests/habits-load-error.test.cjs
// A failed first load on /habits shows "Could not load habits." with a Retry button, never the "No active habits
// found." copy (that copy is for a successful load that returns zero habits). Static source checks, offline.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const habits = fs.readFileSync(path.join(SRC, "app/habits/HabitsClient.tsx"), "utf8");

test("the initial load sets a load-error flag in its catch and clears it on success", () => {
  assert.match(habits, /const \[loadError, setLoadError\] = useState\(false\);/);
  const catchStart = habits.indexOf("setHistory(keep(historyData ?? []));");
  const catchBlock = habits.indexOf("setLoadError(true);", catchStart);
  const success = habits.indexOf("setLoadError(false);", catchStart);
  assert.ok(catchStart > 0 && success > catchStart && success < catchBlock, "success clears the flag before the catch sets it");
  assert.ok(catchBlock > 0 && catchBlock < habits.indexOf("} finally {", catchStart), "the flag is set inside the load catch");
});

test("a failed load shows the plain error and Retry instead of the empty copy", () => {
  assert.match(habits, /habits\.length === 0 && loadError && \(/);
  assert.match(habits, /Could not load habits\./);
  assert.match(habits, /onClick=\{\(\) => \{ void load\(\); \}\}/);
  assert.match(habits, /habits\.length === 0 && !loadError && \(/);
  assert.match(habits, /No active habits found\./);
});

test("the error copy never renders raw error text", () => {
  const errorBlock = habits.slice(habits.indexOf("habits.length === 0 && loadError"), habits.indexOf("habits.length === 0 && !loadError"));
  assert.ok(!/\{e\b|\{error\b|\.message/.test(errorBlock), "no raw error interpolation in the error block");
});
