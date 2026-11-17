// Run: node --test tests/supplement-stack-read-plan.test.cjs (offline). The stacks GET remembers which optional
// columns (supplement_stack.version, supplement_products.ingredient_count) a read found missing, for 10 minutes, and
// starts later reads at the matching step. These checks cover the pure helpers in lib/supplement-stack-read-plan.ts
// with synthetic timestamps; the route's 42703 loop is the same as before, only its starting step differs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const plan = loadTs("lib/supplement-stack-read-plan.ts");
const T0 = 1_000_000;
const TTL = plan.MISSING_COLUMN_TTL_MS;

// Step indexes: 0 = full read, 1 = without version, 2 = without ingredient_count, 3 = without both.

test("no memo: the read starts at the full step", () => {
  assert.equal(plan.startStep(null, T0), 0);
});

test("a memo of a missing ingredient_count starts at the step without it, while fresh", () => {
  const memo = { version: false, count: true, at: T0 };
  assert.equal(plan.startStep(memo, T0 + TTL - 1), 2);
});

test("a memo of a missing version starts at the step without version", () => {
  const memo = { version: true, count: false, at: T0 };
  assert.equal(plan.startStep(memo, T0), 1);
});

test("both columns missing starts at the bare step", () => {
  const memo = { version: true, count: true, at: T0 };
  assert.equal(plan.startStep(memo, T0), 3);
});

test("an expired memo is ignored: the next read starts at the full step again", () => {
  const memo = { version: false, count: true, at: T0 };
  assert.equal(plan.startStep(memo, T0 + TTL), 0);
});

test("a full read that succeeds clears the memo", () => {
  assert.equal(plan.nextMemo(null, 0, 0, T0), null);
  const expired = { version: false, count: true, at: T0 };
  assert.equal(plan.nextMemo(expired, 0, 0, T0 + TTL), null);
});

test("a read that steps down from a full start records what it dropped, with the current time", () => {
  // Fresh start at 0, first read failed on ingredient_count, step 2 (without it) succeeded.
  assert.deepEqual(plan.nextMemo(null, 0, 2, T0), { version: false, count: true, at: T0 });
  // Both dropped: the bare step was reached.
  assert.deepEqual(plan.nextMemo(null, 0, 3, T0), { version: true, count: true, at: T0 });
});

test("a fresh memo confirmed by a read at its own start keeps its timestamp (expires on schedule)", () => {
  const memo = { version: false, count: true, at: T0 };
  const later = T0 + 5 * 60 * 1000;
  assert.equal(plan.nextMemo(memo, 2, 2, later), memo);
  assert.equal(plan.startStep(memo, T0 + TTL), 0);
});

test("a stale fresh memo that needed a further step down is replaced by what that read selected", () => {
  // Memo said count missing (start 2); count is now missing as well as version, so step 3 was needed.
  const memo = { version: false, count: true, at: T0 };
  const later = T0 + 60 * 1000;
  assert.deepEqual(plan.nextMemo(memo, 2, 3, later), { version: true, count: true, at: later });
});

test("steps are in the order the GET steps down (full, then one column dropped, then both)", () => {
  assert.deepEqual(plan.STACK_READ_STEPS.map(([v, c]) => [v, c]), [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ]);
});
