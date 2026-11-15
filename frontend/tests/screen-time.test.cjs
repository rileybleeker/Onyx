// Run: node --test tests/screen-time.test.cjs
// /screen-time logic (lib/screen-time.ts) and the page's access rules. SYNTHETIC rows only:
// invented dates, app names and minutes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const S = loadTs("lib/screen-time.ts");

// January: New York is UTC-5, so 06:00 ET = 11:00Z.
function row(date, over = {}) {
  return {
    behavioral_date: date,
    total_minutes: 300,
    late_night_minutes: 90,
    after_midnight_minutes: 30,
    pickups: 40,
    notifications: 100,
    apps_used: 12,
    sleep_start: `${S.addDays(date, 1)}T06:00:00+00:00`, // 01:00 ET
    minutes_last_hour_before_sleep_est: 25,
    minutes_during_sleep_est: 5,
    minutes_by_app: { "App One": 200, "App Two": 100 },
    minutes_by_category: { Alpha: 250, "(none)": 50 },
    synced_at: `${S.addDays(date, 1)}T15:00:00+00:00`, // 10:00 ET the next morning
    ...over,
  };
}
const PARTIAL = { synced_at: "2030-01-12T20:00:00Z" }; // same afternoon, for a row dated 2030-01-12

test("a day is complete only once a sync happened at or after 06:00 ET the next day", () => {
  assert.equal(S.isDayComplete("2030-01-10", "2030-01-11T10:59:00Z"), false); // 05:59 ET
  assert.equal(S.isDayComplete("2030-01-10", "2030-01-11T11:00:00Z"), true); // 06:00 ET
  assert.equal(S.isDayComplete("2030-01-10", "2030-01-10T23:00:00Z"), false);
  assert.equal(S.isDayComplete("2030-01-10", null), false);
  assert.equal(S.isDayComplete("2030-01-10", "not a time"), false);
  // July: UTC-4, so 06:00 ET = 10:00Z.
  assert.equal(S.isDayComplete("2030-07-10", "2030-07-11T09:59:00Z"), false);
  assert.equal(S.isDayComplete("2030-07-10", "2030-07-11T10:00:00Z"), true);
});

test("numeric strings parse, bad rows drop, one row per day, ascending", () => {
  const days = S.shapeScreenRows([
    row("2030-01-12", { total_minutes: "412.5" }),
    null,
    { behavioral_date: "nope" },
    row("2030-01-10"),
    row("2030-01-12", { total_minutes: 1 }),
  ]);
  assert.deepEqual(days.map((d) => d.date), ["2030-01-10", "2030-01-12"]);
  assert.equal(days[1].totalMin, 412.5);
});

test("bedtime estimates need a complete day, a scored sleep, and a sync an hour past sleep onset", () => {
  const ready = S.parseScreenRow(row("2030-01-10"));
  assert.equal(ready.bedtimeReady, true);
  assert.equal(ready.lastHourBeforeSleepMin, 25);

  const noSleep = S.parseScreenRow(row("2030-01-10", { sleep_start: null, minutes_last_hour_before_sleep_est: null }));
  assert.equal(noSleep.complete, true);
  assert.equal(noSleep.bedtimeReady, false);
  assert.equal(noSleep.lastHourBeforeSleepMin, null);

  const partial = S.parseScreenRow(row("2030-01-10", { synced_at: "2030-01-10T20:00:00Z" }));
  assert.equal(partial.complete, false);
  assert.equal(partial.lastHourBeforeSleepMin, null);

  // Complete (synced 06:30 ET) but sleep began 06:00 ET: the hour straddling onset was not all sent.
  const early = S.parseScreenRow(row("2030-01-10", { sleep_start: "2030-01-11T11:00:00Z", synced_at: "2030-01-11T11:30:00Z" }));
  assert.equal(early.complete, true);
  assert.equal(early.bedtimeReady, false);
  assert.equal(early.duringSleepMin, null);
});

test("averages use complete days only", () => {
  const days = S.shapeScreenRows([
    row("2030-01-10", { total_minutes: 200, pickups: 20 }),
    row("2030-01-11", { total_minutes: 400, pickups: 60 }),
    row("2030-01-12", { total_minutes: 10, pickups: 1, ...PARTIAL }),
  ]);
  const s = S.summarize(days);
  assert.equal(s.completeDays, 2);
  assert.equal(s.partialDays, 1);
  assert.equal(s.avgTotalMin, 300);
  assert.equal(s.avgPickups, 40);
  assert.equal(s.bedtimeDays, 2);
  assert.equal(s.avgLastHourBeforeSleepMin, 25);
});

test("no rows and no complete rows give null averages, not zeros", () => {
  const empty = S.summarize([]);
  assert.equal(empty.avgTotalMin, null);
  assert.equal(empty.completeDays, 0);
  const onlyPartial = S.shapeScreenRows([row("2030-01-12", PARTIAL)]);
  assert.equal(S.summarize(onlyPartial).avgTotalMin, null);
  assert.equal(S.summarize(onlyPartial).avgLastHourBeforeSleepMin, null);
  assert.deepEqual(S.topEntries(onlyPartial, "byApp"), []);
});

test("top apps rank by total minutes over complete days, ties by name, limited", () => {
  const days = S.shapeScreenRows([
    row("2030-01-10", { minutes_by_app: { "App One": 100, "App Two": 50, "App Zed": 10 } }),
    row("2030-01-11", { minutes_by_app: { "App Two": 50, "App Three": 100 } }),
    row("2030-01-12", { minutes_by_app: { "App Zed": 999 }, ...PARTIAL }),
  ]);
  const top = S.topEntries(days, "byApp", 3);
  assert.deepEqual(top.map((e) => e.label), ["App One", "App Three", "App Two"]);
  assert.equal(top[2].minutes, 100);
  assert.equal(top[2].daysUsed, 2);
  assert.equal(top[2].perDay, 50);
  assert.equal(Math.round(top[0].share * 1000), Math.round((100 / 310) * 1000));
});

test("bundle ids get a readable name; real names and odd keys pass through", () => {
  assert.equal(S.appLabel("com.example.SomeGreatApp"), "Some Great App");
  assert.equal(S.appLabel("com.example.reader"), "Reader");
  assert.equal(S.appLabel("com.example.ios"), "Example");
  assert.equal(S.appLabel("com.example-co.thing.iphone"), "Thing");
  assert.equal(S.appLabel("org.example.my_tool-kit"), "My tool kit");
  assert.equal(S.appLabel("App One"), "App One");
  assert.equal(S.appLabel("nodots"), "nodots");
  assert.equal(S.appLabel("app.ios"), "Ios"); // nothing but generic segments: keep the last one
  const days = S.shapeScreenRows([row("2030-01-10", { minutes_by_app: { "com.example.SomeGreatApp": 50, "net.example.SomeGreatApp": 20 } })]);
  const top = S.topEntries(days, "byApp");
  assert.deepEqual(top.map((e) => [e.key, e.label]), [["com.example.SomeGreatApp", "Some Great App"], ["net.example.SomeGreatApp", "Some Great App"]]);
});

test("the uncategorised bucket is renamed and bad map values are ignored", () => {
  const days = S.shapeScreenRows([row("2030-01-10", { minutes_by_category: { Alpha: 30, "(none)": 60, Bad: "x", Zero: 0 } })]);
  const top = S.topEntries(days, "byCategory");
  assert.deepEqual(top.map((e) => e.label), [S.NO_CATEGORY_LABEL, "Alpha"]);
  const none = S.shapeScreenRows([row("2030-01-10", { minutes_by_category: null, minutes_by_app: ["x"] })]);
  assert.deepEqual(S.topEntries(none, "byApp"), []);
});

test("chart points fill missing days as gaps and dim a partial day", () => {
  const pts = S.chartPoints(
    S.shapeScreenRows([
      row("2030-01-10", { late_night_minutes: 90, after_midnight_minutes: 30 }),
      row("2030-01-12", { total_minutes: 44, ...PARTIAL }),
    ]),
  );
  assert.deepEqual(pts.map((p) => p.date), ["2030-01-10", "2030-01-11", "2030-01-12"]);
  assert.equal(pts[0].label, "1/10");
  assert.deepEqual([pts[0].total, pts[0].totalPartial, pts[0].evening, pts[0].afterMidnight], [300, null, 60, 30]);
  assert.deepEqual([pts[1].total, pts[1].totalPartial, pts[1].pickups, pts[1].lastHour], [null, null, null, null]);
  assert.deepEqual([pts[2].total, pts[2].totalPartial, pts[2].evening, pts[2].pickups], [null, 44, null, null]);
  assert.deepEqual(S.chartPoints([]), []);
});

test("window parsing clamps and defaults", () => {
  assert.equal(S.parseWindowDays(undefined), 30);
  assert.equal(S.parseWindowDays("abc"), 30);
  assert.equal(S.parseWindowDays("-5"), 30);
  assert.equal(S.parseWindowDays("90"), 90);
  assert.equal(S.parseWindowDays(["14", "90"]), 14);
  assert.equal(S.parseWindowDays("1"), 7);
  assert.equal(S.parseWindowDays("9999"), 180);
});

test("the window starts days-1 before behavioral today (ET clock minus 6 h)", () => {
  // 2030-01-15 08:00Z = 03:00 ET on Jan 15 -> behavioral day Jan 14.
  assert.equal(S.windowStart(new Date("2030-01-15T08:00:00Z"), 30), "2029-12-16");
  // 2030-01-15 20:00Z = 15:00 ET -> behavioral day Jan 15.
  assert.equal(S.windowStart(new Date("2030-01-15T20:00:00Z"), 7), "2030-01-09");
});

test("minutes format", () => {
  assert.equal(S.formatMinutes(null), "-");
  assert.equal(S.formatMinutes(42.4), "42m");
  assert.equal(S.formatMinutes(120), "2h");
  assert.equal(S.formatMinutes(135), "2h 15m");
});

test("page is force-dynamic, not ISR, noindex; reader is server-only with explicit columns", () => {
  const page = fs.readFileSync(path.join(SRC, "app/screen-time/page.tsx"), "utf8");
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.ok(!/export const revalidate/.test(page));
  assert.match(page, /index: false/);
  assert.ok(!page.includes('"use client"'));

  const reader = fs.readFileSync(path.join(SRC, "lib/screen-time-server.ts"), "utf8");
  assert.ok(reader.startsWith('import "server-only";'));
  assert.ok(!/select\(\s*["'`]\*/.test(reader));
  assert.ok(!S.SCREEN_TIME_COLUMNS.includes("*"));

  // The client chart file gets rows as props: no Supabase import, no fetch.
  const charts = fs.readFileSync(path.join(SRC, "app/screen-time/ScreenTimeCharts.tsx"), "utf8");
  assert.ok(!/supabase|fetch\(/.test(charts));
  const series = [...charts.matchAll(/<(Bar|Line) [^>]*>/g)];
  assert.ok(series.length >= 8);
  for (const m of series) assert.match(m[0], /isAnimationActive=\{false\}/);
});

test("the page is not a token route and is in the nav", () => {
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  assert.ok(!mw.includes('"/screen-time"'));
  const nav = fs.readFileSync(path.join(SRC, "lib/nav.ts"), "utf8");
  assert.match(nav, /href: "\/screen-time"/);
});

// ── The page's three states, rendered offline with a stubbed reader ─────────────────────────────
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

// The four chart parts (one component each); every stub draws the number of rows it got.
const chartStub = ({ points }) => React.createElement("div", { "data-charts": points.length });
const CHARTS_STUB = { __esModule: true, DailyTotalChart: chartStub, LateNightChart: chartStub, PickupsChart: chartStub, SleepOnsetChart: chartStub };

async function renderPage(load, search = {}) {
  let asked = null;
  const page = loadTs("app/screen-time/page.tsx", {
    "@/lib/screen-time-server": {
      loadScreenTime: async (days) => {
        asked = days;
        return typeof load === "function" ? load(days) : load;
      },
    },
    "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) },
    "next/headers": { cookies: async () => ({ get: () => undefined }) },
    "./ScreenTimeCharts": CHARTS_STUB,
  });
  const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve(search) }));
  return { html, asked };
}

const FAILED = "Couldn&#x27;t load Screen Time.";
const EMPTY = "No Screen Time days in this window.";

test("failed query, empty window and data are three different screens", async () => {
  const failed = await renderPage({ kind: "error", hint: "The database query failed (code X). Try again in a moment." });
  assert.ok(failed.html.includes(FAILED));
  assert.ok(failed.html.includes('role="alert"'));
  assert.ok(!failed.html.includes(EMPTY));
  assert.ok(!failed.html.includes("data-charts"));

  const empty = await renderPage({ kind: "empty", windowDays: 30, sync: null });
  assert.ok(empty.html.includes(`>${EMPTY}<`)); // exact text of one element: the smoke test's legitimateEmpty
  assert.ok(empty.html.includes("has not reported a sync yet"));
  assert.ok(!empty.html.includes(FAILED));
  assert.ok(!empty.html.includes("data-charts"));

  const days = S.shapeScreenRows([row("2030-01-10"), row("2030-01-11"), row("2030-01-12", PARTIAL)]);
  const ok = await renderPage({ kind: "ok", windowDays: 30, days, skippedRows: 0, sync: { status: "success", at: "2030-01-12T15:00:00Z" } });
  assert.ok(ok.html.includes('data-charts="3"'));
  assert.ok(ok.html.includes("App One"));
  const ids = await renderPage({ kind: "ok", windowDays: 30, days: S.shapeScreenRows([row("2030-01-10", { minutes_by_app: { "com.example.SomeGreatApp": 50 } })]), skippedRows: 0, sync: null });
  assert.ok(ids.html.includes("Some Great App") && ids.html.includes("com.example.SomeGreatApp"));
  assert.ok(ok.html.includes("Uncategorised"));
  assert.ok(ok.html.includes("2 complete days"));
  assert.ok(ok.html.includes("1 day is still syncing"));
  assert.ok(ok.html.includes("5h")); // average daily total of the two complete days (300 min)
  assert.ok(!ok.html.includes(FAILED) && !ok.html.includes(EMPTY));
  for (const r of [failed, empty, ok]) assert.ok(r.html.includes('data-testid="page-heading"'));
});

test("a failed last sync is called out, and ?days= reaches the reader clamped", async () => {
  const days = S.shapeScreenRows([row("2030-01-10")]);
  const r = await renderPage({ kind: "ok", windowDays: 90, days, skippedRows: 0, sync: { status: "failed", at: "2030-01-12T15:00:00Z" } }, { days: "90" });
  assert.equal(r.asked, 90);
  assert.ok(r.html.includes("it failed"));
  assert.match(r.html, /aria-current="page"[^>]*>90d</);
  assert.equal((await renderPage({ kind: "empty", windowDays: 180, sync: null }, { days: "9999" })).asked, 180);
});

// ── The page's section of the continuous scroll (FeedSection.tsx) ──────────────────────────────
const V = loadTs("lib/screen-time-view.ts");
const fakeNext = { NextResponse: { json: (body, init = {}) => ({ status: init.status ?? 200, body, headers: init.headers ?? {} }) } };

test("feed: the view data is what the screen shows, never the day rows", () => {
  const days = S.shapeScreenRows([row("2030-01-10"), row("2030-01-11"), row("2030-01-12", PARTIAL)]);
  const v = V.screenTimeViewData({ kind: "ok", windowDays: 30, days, skippedRows: 1, sync: null });
  assert.equal(v.kind, "ok");
  assert.ok(!("days" in v));
  assert.equal(v.skippedRows, 1);
  assert.deepEqual(v.summary, S.summarize(days));
  assert.deepEqual(v.points, S.chartPoints(days));
  assert.deepEqual(v.topApps, S.topEntries(days, "byApp"));
  assert.deepEqual(v.topCategories, S.topEntries(days, "byCategory"));
  const empty = { kind: "empty", windowDays: 14, sync: null };
  assert.deepEqual(V.screenTimeViewData(empty), empty);
  const roundTrip = JSON.parse(JSON.stringify(v));
  assert.deepEqual(V.readScreenTimeViewData(roundTrip), roundTrip);
  for (const bad of [null, [], {}, { kind: "ok" }, { kind: "empty" }, { kind: "error" }, { kind: "other", hint: "x" }]) {
    assert.throws(() => V.readScreenTimeViewData(bad));
  }
  // Memory only in the client cache, like the page's own payload.
  assert.equal(loadTs("lib/client-cache.ts").isSensitiveKey("/api/screen-time/page-data?days=30"), true);
});

test("feed: /api/screen-time/page-data answers the page's view data for ?days=; GET only, same-origin, no-store", async () => {
  let asked = null;
  const route = loadTs("app/api/screen-time/page-data/route.ts", {
    "next/server": fakeNext,
    "@/lib/screen-time-server": {
      loadScreenTime: async (d) => {
        asked = d;
        return { kind: "empty", windowDays: d, sync: null };
      },
    },
  });
  assert.deepEqual(Object.keys(route).filter((k) => typeof route[k] === "function"), ["GET"]);
  const req = (qs, site = "same-origin") => ({
    headers: new Headers({ "sec-fetch-site": site }),
    nextUrl: new URL(`https://onyx.example/api/screen-time/page-data${qs}`),
  });
  const res = await route.GET(req("?days=90"));
  assert.deepEqual([res.status, res.body, res.headers["Cache-Control"]], [200, { kind: "empty", windowDays: 90, sync: null }, "no-store"]);
  await route.GET(req("?days=9999"));
  assert.equal(asked, 180);
  await route.GET(req(""));
  assert.equal(asked, 30);
  assert.equal((await route.GET(req("", "cross-site"))).status, 403);
  // Session only: not in middleware's CI-token carve-out.
  assert.ok(!fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8").includes("/api/screen-time/page-data"));
});

test("feed: the scroll section draws the same screen, with window buttons and the feed heading", () => {
  const View = loadTs("app/screen-time/ScreenTimeView.tsx", {
    "next/link": { __esModule: true, default: ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children) },
    "./ScreenTimeCharts": CHARTS_STUB,
  }).default;
  const draw = (props) => renderToStaticMarkup(React.createElement(View, { feed: true, onWindow: () => {}, ...props }));
  const empty = draw({ data: { kind: "empty", windowDays: 14, sync: null }, windowDays: 14 });
  assert.ok(empty.startsWith("<section"));
  assert.ok(empty.includes('data-testid="feed-page-heading"') && !empty.includes('data-testid="page-heading"'));
  assert.ok(empty.includes(`>${EMPTY}<`));
  assert.match(empty, /aria-pressed="true"[^>]*>14d</);
  assert.doesNotMatch(empty, /href="\/screen-time\?days=/);
  const days = S.shapeScreenRows([row("2030-01-10"), row("2030-01-11")]);
  const ok = draw({ data: V.screenTimeViewData({ kind: "ok", windowDays: 30, days, skippedRows: 0, sync: null }), windowDays: 30 });
  assert.ok(ok.includes('data-charts="2"') && ok.includes("App One") && ok.includes("2 complete days"));
  const loading = draw({ data: null, windowDays: 30 });
  assert.ok(loading.includes("Loading Screen Time") && loading.includes('aria-busy="true"'));
  assert.ok(!loading.includes(FAILED) && !loading.includes(EMPTY));
});
