// Run: node --test tests/screen-time-feed-window.test.cjs
// The /screen-time section of the continuous scroll, MOUNTED (Codex PR846-COVERAGE): app/screen-time/FeedSection.tsx
// with the real lib/server-page-data.ts hook, the real lib/client-cache.ts and the real ScreenTimeView, over a fake
// GET. Nothing injects `busy` or replaces the hook: the section works it out from the answers it receives.
// Only browser-only children are stubbed (charts, Personalize grid, the info popover, the retry button, next/link).
// SYNTHETIC rows only: invented 2030 dates, made-up program minutes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");
const { mountClient, response, deferred, withGlobals } = require("./helpers/hook-harness.cjs");

const P = loadTs("lib/pc-activity-view.ts");

const AI_EMPTY_SECTION = { kind: "empty", sync: null };
/** One logged PC day (complete: uploaded the next morning), as the server aggregates it. */
const pcSection = () => ({
  ...P.summarizePc([
    {
      behavioral_date: "2030-03-01",
      active_minutes: 60,
      late_active_minutes: 0,
      minutes_by_app: { code: 50, excel: 10 },
      synced_at: "2030-03-02T12:00:00.000Z",
    },
  ]),
  sync: { status: "success", at: "2030-03-02T15:00:00Z" },
});
/** The server's answer when the phone query failed but the AI and PC parts were read for `windowDays`. */
const phoneErrorAnswer = (windowDays) => ({
  kind: "error",
  hint: "The database query failed (code XX000). Try again in a moment.",
  windowDays,
  ai: AI_EMPTY_SECTION,
  pc: pcSection(),
});

const URL_30 = "/api/screen-time/page-data?days=30";
const URL_14 = "/api/screen-time/page-data?days=14";

const React = require("react");
const STUBS = {
  "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "./ScreenTimeCharts": { __esModule: true, DailyTotalChart: () => null, LateNightChart: () => null, PickupsChart: () => null, SleepOnsetChart: () => null },
  "@/components/personalize/PartGrid": { __esModule: true, PartGrid: () => null },
  "@/components/InfoHint": { __esModule: true, default: () => null },
  "./RetryButton": { __esModule: true, default: () => null },
};

test("mounted feed: 30 -> 14 days with a pending answer and a phone failure keeps 'N of 30', dimmed and busy, until 14 lands (PR846-COVERAGE)", async (t) => {
  const calls = [];
  const fourteen = deferred();
  withGlobals(t, {
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method ?? "GET" });
      if (url === URL_30) return response(phoneErrorAnswer(30));
      if (url === URL_14) return fourteen.promise;
      throw new Error(`unexpected request ${url}`);
    },
  });

  const h = mountClient("app/screen-time/FeedSection.tsx", { stubs: STUBS });
  t.after(() => h.unmount());

  const root = () => {
    const found = h.find((n) => n.type === "section" && n.props["aria-label"] === "Screen Time");
    assert.equal(found.length, 1, "one Screen Time section");
    return found[0];
  };
  const dimmed = () => h.find((n) => n.type === "div" && /\bopacity-60\b/.test(String(n.props.className ?? "")));
  const pressed = (label) => h.button(label).props["aria-pressed"];

  // The default window's answer: the phone query failed, AI and PC were read for 30 days.
  await h.flush();
  assert.deepEqual(calls, [{ url: URL_30, method: "GET" }]);
  assert.ok(h.text().includes("Couldn't load Screen Time."));
  assert.ok(h.text().includes("Active at the PC") && h.text().includes("1 of 30"));
  assert.equal(pressed("30d"), true);
  assert.equal(pressed("14d"), false);
  assert.equal(root().props["aria-busy"], undefined, "not busy once the picked window's answer is on screen");
  assert.equal(dimmed().length, 0);

  // 14 picked; its answer is still pending, so the 30-day answer stays up, dimmed, and the section is busy.
  h.click("14d");
  await h.flush();
  assert.deepEqual(calls, [{ url: URL_30, method: "GET" }, { url: URL_14, method: "GET" }], "one GET for the picked window");
  assert.equal(pressed("14d"), true, "the picked control is selected at once");
  assert.equal(pressed("30d"), false);
  assert.ok(h.text().includes("1 of 30"), "the denominator is the answer's window, not the picked one");
  assert.ok(!h.text().includes("1 of 14"));
  assert.equal(root().props["aria-busy"], true, "busy until the picked window's answer lands");
  const waiting = dimmed();
  assert.equal(waiting.length, 2, "the kept AI and PC sections are both dimmed");
  assert.ok(h.text(waiting[0]).includes("AI tools"));
  assert.ok(h.text(waiting[1]).includes("Days logged") && h.text(waiting[1]).includes("1 of 30"));

  // The 14-day answer lands (the phone query failed again): its own window, nothing dimmed, not busy.
  fourteen.resolve(response(phoneErrorAnswer(14)));
  await h.flush();
  assert.equal(calls.length, 2, "no further request");
  assert.ok(h.text().includes("1 of 14") && !h.text().includes("1 of 30"));
  assert.ok(h.text().includes("Couldn't load Screen Time."));
  assert.equal(pressed("14d"), true);
  assert.equal(root().props["aria-busy"], undefined, "busy cleared");
  assert.equal(dimmed().length, 0, "nothing dimmed once the answer matches the picked window");
});
