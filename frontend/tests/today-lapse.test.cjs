// today-lapse.test.cjs — lapseDelay for the quiet Today view's self-resurfacing timer.
// Pure helper (frontend/src/lib/today-lapse.ts); a fake clock pins the delay logic.
const test = require("node:test");
const assert = require("node:assert/strict");

const { lapseDelay, LAPSE_CAP_MS, LAPSE_MARGIN_MS } = require("../src/lib/today-lapse.ts");

// A fake now keeps the assertions stable regardless of wall-clock time.
const now = Date.UTC(2026, 10, 17, 12, 0, 0);

test("null nextChange schedules nothing", () => {
  assert.equal(lapseDelay(null, now), null);
});

test("nextChange in the past or at now schedules nothing", () => {
  assert.equal(lapseDelay(now - 1, now), null);
  assert.equal(lapseDelay(now, now), null);
});

test("nextChange within the cap is a short wait plus the 250 ms margin", () => {
  const next = now + 60_000;
  assert.equal(lapseDelay(next, now), next - now + LAPSE_MARGIN_MS);
});

test("nextChange more than six hours ahead is capped so the timer re-arms", () => {
  const fifteenHours = 15 * 3_600_000;
  const delay = lapseDelay(now + fifteenHours, now);
  assert.equal(delay, LAPSE_CAP_MS); // fires at the cap, not at fifteen hours
  // Re-arming from the capped fire: the remaining wait (9 hours, still past the cap) reports the cap again.
  const afterFirstFire = now + LAPSE_CAP_MS;
  assert.equal(lapseDelay(now + fifteenHours, afterFirstFire), LAPSE_CAP_MS);
  // Once the real time draws within the cap, the delay drops to the actual remaining wait plus the margin.
  const close = now + 10 * 3_600_000; // 5 hours left
  assert.equal(lapseDelay(now + fifteenHours, close), now + fifteenHours - close + LAPSE_MARGIN_MS);
});

test("cap is exactly six hours", () => {
  assert.equal(LAPSE_CAP_MS, 6 * 3_600_000);
  assert.equal(LAPSE_MARGIN_MS, 250);
});
