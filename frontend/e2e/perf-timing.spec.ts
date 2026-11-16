import { test, expect, devices, type Browser, type BrowserContext, type CDPSession, type Page, type Request } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const stats = require("./perf-stats.cjs");

/**
 * Production timing run (.github/workflows/perf-timing.yml: hourly at :23 and on workflow_dispatch). It samples
 * whatever production serves at that moment; it is not tied to one deployment, so every result file records the
 * build production served (/api/version, read at the start and the end of the page) and is bound to that SHA.
 *
 * For each key page: N full-document navigations in ONE browser context created
 * from the saved smoke-test login (auth.setup.ts). Navigation 1 starts with an
 * empty HTTP cache and is recorded as "cold" (browser cache; the Vercel function
 * and CDN state are not controllable and are recorded as observed, or "unknown").
 * Navigations 2..N reuse the context's cache and are the "warm" population the
 * percentiles are computed from.
 *
 * Per navigation it records: TTFB, FCP, LCP, time to the page's data-ready
 * element, time to the first drawn chart mark, and every network request the page
 * made (class, path only, duration, transferred bytes). Two observation windows:
 *   - the network-quiet window (harness version 1, unchanged): requests that started before the page had been
 *     network-quiet for QUIET_MS after data-ready (at most WINDOW_CAP_MS); `req`, `total` and `endpoints`, and the
 *     speed budget, use it;
 *   - a FIXED window (harness version 2, `window`) from the navigation itself (navigation start for a full load; for
 *     an in-app navigation, the press on the link (its pointerdown), so Playwright's actionability checks before the
 *     click never use the window up; a click whose press was not seen on the same document gets an unknown window,
 *     recorded with the reason and never counted): every request that started in it, split by purpose (routed = before data-ready,
 *     background = after it, prefetch = router prefetch) and by origin (network, memory / disk / prefetch cache,
 *     service worker, or unknown, from the browser's own network log). A fixed window makes request totals comparable
 *     between pages and runs; the quiet window closes at a different moment on each. The window's cost is decided at
 *     one moment, its end plus DRAIN_MS: a request that started in it and is still open then is reported as unfinished
 *     (cost unknown), never as free, however long the network-quiet wait went on.
 *     Windows are taken on the first FIXED_WINDOW_NAVS navigations of a page only (all of them in the hourly
 *     4-navigation run), so a manual deep run keeps version 1 spacing for the rest.
 * Plus long tasks (main-thread blocking) in the fixed window and when the continuous scroll's first neighbour page
 * appeared in it. Query strings, headers, cookies and response bodies are never recorded, so the JSON holds no
 * credentials and no health data (full URLs are held in memory only, to match the network log, and never written).
 *
 * A second test opens the app at / (Today), lets it settle (the idle warm-up included) and then CLICKS each page's
 * sidebar link in turn, timing click to data-ready: the in-app navigation Riley actually does, served from the client
 * cache. Its first round is the first visit of a session Today already PREWARMED (client cache, router prefetch,
 * HTTP cache), never a cold visit, and is labelled that way; each click records how long Today had been open
 * (`sinceTodayMs`). The first round keeps version 1 spacing (no fixed window), so the prewarm before each first visit
 * is as long as under version 1; later rounds get the fixed window from the click's observed input. `ready` is still
 * timed from just before Playwright's click (version 1, unchanged; a click that loaded a new document is timed on the
 * shared clock, so the reload counts and a negative time can never pass). Written as nav-<slug>.json, labelled
 * "<route> (in-app)".
 *
 * A phone scenario (390 px, Chromium iPhone emulation, CPU slowed 4x) loads Today and Log and times taps on the
 * bottom bar (input to next paint, tap to ready, blocking time). It is OBSERVED ONLY (`enforced: false`): reported on
 * every run that has it and never part of the budget's exit code until it has been repeated across scheduled runs.
 * Each phone test has a time budget (no navigation or tap starts after it; the rest are reported as not tried) and a
 * deadline of its own after the budget plus one worst-case step (`observeOnly`): a step that never returns (a page
 * that stopped answering, whose page.evaluate() has no timeout) is recorded as interrupted, not measured, and its
 * browser context is closed, before Playwright's test timeout, which cannot be caught inside the test and would fail
 * the run. Nor does a phone failure fail it (a bounce to the login page included): the workflow's speed-budget step
 * runs only when this measuring step passed, so the result file records why the phone loop ended (`stopped`) and the
 * report lists the rest as not measured, never as a pass; a bounce or a hang on a desktop page still fails the run.
 * A manual deep run (more than PHONE_MAX_RUN_NAVIGATIONS navigations per page) skips it, so the run stays inside the
 * job timeout and its speed budget is always evaluated. Its taps only navigate and open / close the menu; nothing is
 * written.
 *
 * This is NOT part of the smoke suite: playwright.config.ts only matches
 * smoke.spec.ts, and this file is run through e2e/perf.config.ts.
 */

const NAVIGATIONS = Math.max(2, Number(process.env.PERF_NAVIGATIONS || 15));
const PAUSE_MS = 1_000; // between navigations, so the run does not hammer production
const QUIET_MS = 1_500; // network must be idle this long after data-ready to close the window
const WINDOW_CAP_MS = 15_000; // never wait longer than this after data-ready
const READY_TIMEOUT_MS = 30_000;
const GOTO_TIMEOUT_MS = 45_000;
// Fixed observation windows from navigation start (harness 2). A full load covers the continuous scroll's start
// (2 s after the page opened) and the warm-up's start (2.5 s after load, then idle slots); a click has no document.
const FIXED_WINDOW_MS = 6_000;
const IN_APP_WINDOW_MS = 4_000;
// Fixed windows on the first navigations of a full-load series only (cold + 3 warm; the hourly run has 4 in all).
const FIXED_WINDOW_NAVS = 4;
// After the window: requests that started in it and finished by its end plus this long are measured; any still open
// then is unfinished (cost unknown), whatever happens later.
const DRAIN_MS = 2_000;
const FULL_LOAD_WINDOW_RULE = `navigations 1-${FIXED_WINDOW_NAVS} of each page`;
// The window a full-load navigation gets (0 = version 1 spacing, the network-quiet wait alone): its first
// FIXED_WINDOW_NAVS navigations only. The hourly run (4 navigations) is all windowed; a deeper manual run's later
// navigations are spaced differently, which is why each sample records its cadence and pooling keeps the two apart.
const fullLoadWindowMs = (i: number) => (i < FIXED_WINDOW_NAVS ? FIXED_WINDOW_MS : 0);
const IN_APP_WINDOW_RULE = "from the press on the link (pointerdown), rounds 2 and later (round 1 keeps version 1 spacing)";
// Worst case of one measured full load: about:blank and the CPU setting, the page load, data-ready, the network-quiet
// wait (or the fixed window, whichever is longer), the drain, the in-page reads and the pause.
const NAV_WORST_MS = GOTO_TIMEOUT_MS + READY_TIMEOUT_MS + Math.max(WINDOW_CAP_MS, FIXED_WINDOW_MS) + DRAIN_MS + PAUSE_MS + 10_000;
// After an observe-only test's loop: the production SHA read (10 s timeout), closing the context, writing the result.
const FINISH_MS = 30_000;
// An observe-only test's own deadline (observeOnly) comes this long before its Playwright timeout: room for its
// bounded cleanup (closing the context, then letting the body unwind, each at most DEADLINE_CLEANUP_MS) plus a margin,
// so the deadline always fires first and the test never times out.
const DEADLINE_CLEANUP_MS = 15_000;
const DEADLINE_RESERVE_MS = 2 * DEADLINE_CLEANUP_MS + 15_000;
// Mirror of AGENTS_API in src/lib/agents-api.ts (the sms-reminders Worker).
const AGENTS_HOST = "sms-reminders.rileybleeklm.workers.dev";

const DESKTOP = devices["Desktop Chrome"];
// The 390 px phone: iPhone 13 metrics and user agent on Chromium (the run's only browser), CPU slowed like a phone.
const PHONE = devices["iPhone 13"];
const PHONE_CPU_SLOWDOWN = 4;
const PHONE_NAVIGATIONS = Math.min(4, NAVIGATIONS); // bounded: a manual 15-navigation run does not grow it
const PHONE_ROUNDS = Math.min(3, NAVIGATIONS);
// Observe-only, so bounded in wall-clock time: no phone navigation / tap starts after its budget (normally about a
// minute is used); the rest are reported as not tried. Skipped on a manual deep run (see the header).
const PHONE_THIS_RUN = NAVIGATIONS <= stats.PHONE_MAX_RUN_NAVIGATIONS;
const PHONE_SKIP_REASON = `deep run (${NAVIGATIONS} navigations per page): the observe-only phone scenario runs on runs of ${stats.PHONE_MAX_RUN_NAVIGATIONS} or fewer (the hourly run)`;
const PHONE_SERIES_BUDGET_MS = 150_000;
const PHONE_INPUT_BUDGET_MS = 180_000;
const PHONE_PAGES = ["today", "log"];
const INPUT_SETTLE_MS = 1_000; // after a tap's ready, long tasks are still collected this long
const TAP_PAUSE_MS = 500;
const TAP_TIMEOUT_MS = 10_000;
// Worst case of one tap: the tap, its ready wait, the settle time, and for a tap that failed the recovery load of the
// screen it should have left on (page load + ready), plus the in-page reads and the pause.
const TAP_WORST_MS = TAP_TIMEOUT_MS + READY_TIMEOUT_MS + INPUT_SETTLE_MS + GOTO_TIMEOUT_MS + READY_TIMEOUT_MS + TAP_PAUSE_MS + 10_000;
// Each phone test's own deadline: its time budget, one worst-case step started just before the budget ran out, and the
// normal finish. Only a step that never returns reaches it (see observeOnly); the test's timeout is DEADLINE_RESERVE_MS
// later.
const PHONE_SERIES_DEADLINE_MS = PHONE_SERIES_BUDGET_MS + NAV_WORST_MS + FINISH_MS;
const PHONE_INPUT_DEADLINE_MS = PHONE_INPUT_BUDGET_MS + TAP_WORST_MS + FINISH_MS;

const AUTH_FILE = path.join(__dirname, ".auth/state.json");
const OUT_DIR = path.join(__dirname, "..", "perf-results");

// A drawn recharts data mark inside <main> (the sidebar sparkline lives in
// <aside>, and legend icons are excluded, so neither can fake "chart drawn").
const CHART = "main svg.recharts-surface path:not(.recharts-legend-icon)";

// The continuous scroll (components/ContinuousScroll.tsx) draws the neighbouring pages above and below the routed
// one, each in a <section data-feed-route>; the routed page itself sits in a <div data-feed-route>. Only the routed
// page counts for its own data-ready and chart times (a neighbour's chart or skeleton must not decide them). Their
// network requests stay in the window: they are part of what opening the page costs.
const FEED_PAGE = "section[data-feed-route]";
// Text of the routed page alone (the whole body while the scroll is off or before it existed).
const ROUTED_TEXT = `((document.querySelector("[data-feed-root] > div[data-feed-route]") || document.body).innerText)`;

// Installed in every page before its scripts run: records the first frame in
// which a chart mark exists, on the page's own performance.now() clock. An in-app
// navigation restarts it with window.__pfWatchChart(); marks left over from the
// previous page (inside [data-pf-old]) never count. Also kept per document: long tasks ([start, duration]) and the
// first moment a neighbour page of the continuous scroll is in the DOM (polled every 100 ms, reset with the chart).
const INIT_SCRIPT = `(() => {
  const SEL = ${JSON.stringify(CHART)};
  const FEED = ${JSON.stringify(FEED_PAGE + ":not([data-pf-old])")};
  window.__pfWatchChart = () => {
    window.__pfChart = null;
    window.__pfFeedAt = null;
    const tick = () => {
      if (window.__pfChart == null && [...document.querySelectorAll(SEL)].some((e) => !e.closest("[data-pf-old]") && !e.closest(${JSON.stringify(FEED_PAGE)}))) window.__pfChart = performance.now();
      if (window.__pfChart == null) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  window.__pfWatchChart();
  window.__pfLong = [];
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__pfLong.push([e.startTime, e.duration]); })
      .observe({ type: "longtask", buffered: true });
  } catch (e) {}
  setInterval(() => {
    if (window.__pfFeedAt == null && document.querySelector(FEED)) window.__pfFeedAt = performance.now();
  }, 100);
})();`;

// Phone scenario only: per tap, the finger-down time, the click time and the first frame painted after the click
// handlers ran (requestAnimationFrame, then a task), plus Event Timing entries of interactions (16 ms and longer).
const INPUT_SCRIPT = `(() => {
  window.__pfInputs = [];
  let cur = null;
  const add = (rec) => { window.__pfInputs.push(rec); if (window.__pfInputs.length > 50) window.__pfInputs.shift(); return rec; };
  addEventListener("pointerdown", (e) => { cur = add({ down: e.timeStamp, click: null, paint: null }); }, { capture: true, passive: true });
  addEventListener("click", (e) => {
    const rec = cur && cur.click == null ? cur : (cur = add({ down: null, click: null, paint: null }));
    rec.click = e.timeStamp;
    requestAnimationFrame(() => setTimeout(() => { rec.paint = performance.now(); }, 0));
  }, { capture: true });
  window.__pfEvents = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.interactionId) window.__pfEvents.push([e.interactionId, e.startTime, e.duration]);
    }).observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch (e) {}
})();`;

// The route content sits in AppShell's <main><div>, inside the continuous scroll's routed wrapper
// ([data-feed-root] > div[data-feed-route]) next to the neighbouring pages' sections. Before an in-app click the
// routed page's elements and those sections are marked old, and the new page counts as shown only once none of them
// is left (the old page's chart cannot satisfy the new page's check). The scroll's own wrappers stay across a
// navigation, so they are never marked.
const ROUTE_CONTENT = [
  "main > div > :not([data-feed-root])",
  "main > div > [data-feed-root] > div[data-feed-route] > *",
  "main > div > [data-feed-root] > section[data-feed-route]",
].join(", ");
const OLD_CONTENT = "main [data-pf-old]";

interface PageSpec {
  slug: string;
  label: string;
  route: string;
  /** Expression evaluated in the page; truthy (a performance.now() value) once the page's data element is there. */
  ready: string;
  /** Text that, if present once settled, means the page is showing its empty state instead of data. */
  emptyText?: string;
  note?: string;
}

const ready = (cond: string) => `(() => { if (!(${cond})) return false; return performance.now(); })()`;
const notFeed = `!e.closest(${JSON.stringify(FEED_PAGE)})`;
const hasChart = `[...document.querySelectorAll(${JSON.stringify(CHART)})].some(e => ${notFeed})`;
const h = (text: string, tag = "h1,h2,h3,h4,h5,h6") =>
  `[...document.querySelectorAll(${JSON.stringify(tag)})].some(e => ${notFeed} && e.textContent.trim() === ${JSON.stringify(text)})`;
const leafText = (text: string) =>
  `[...document.querySelectorAll("p,div,span")].some(e => ${notFeed} && e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(text)})`;

// Today's own panels (not the overview cards, which read only near the screen): every panel settled, none busy, and
// no "Checking..." left in the Also checked list (Codex review 2026-11-14: readiness covered only three panels).
const TODAY_PANELS = `[...document.querySelectorAll("main section:not([data-card])")].filter(e => ${notFeed})`;
const TODAY_PENDING = /checking\.\.\.|checking agent requests|checking email|checking your calendar|loading reading progress/i;
const todayReady = ready(
  `${h("Today", "h1")} && !${TODAY_PANELS}.some((e) => e.getAttribute("aria-busy") === "true" || ${TODAY_PENDING}.test(e.innerText))`
);
// The Log screen (app/log/LogClient.tsx): the routed copy's root (a copy in the continuous scroll sits in a
// section[data-feed-route]), with the loaded frame's heading (the server skeleton's h1 has no test id), every shown
// section past its loading state (SectionSkeleton, the Uber Eats body and the inline list skeletons use .skeleton or
// aria-busy, the check-in's own loading rows .animate-pulse) and, when the check-in part is shown, its day loaded.
const LOG_ROOT = `[...document.querySelectorAll("[data-log-root]")].find(e => ${notFeed})`;
const logReady = ready(
  `((r) => !!r && !!r.querySelector('[data-testid="page-heading"]') && !r.querySelector('.skeleton, .animate-pulse, [aria-busy="true"]') && (!r.querySelector("#log-part-check-in") || /Daytime: /.test(r.innerText)))(${LOG_ROOT})`
);
// Server-rendered finance pages: the real heading (the loading.tsx skeleton's has no test id) with no skeleton left.
const serverPageReady = ready(
  `!!document.querySelector('[data-testid="page-heading"]') && ![...document.querySelectorAll('p[role="status"]')].some((e) => ${notFeed} && /^Loading /.test(e.textContent))`
);

const PAGES: PageSpec[] = [
  {
    slug: "today",
    label: "/ (Today)",
    route: "/",
    // The start page (manifest start_url): what opening the app loads.
    ready: todayReady,
  },
  {
    slug: "check-in",
    label: "/check-in",
    route: "/check-in",
    // The subtitle with "Daytime:" renders only once the day's questions have loaded (not on the error screen).
    ready: ready(`${h("Check-in", "h2")} && /Daytime: /.test(${ROUTED_TEXT})`),
  },
  {
    slug: "log",
    label: "/log",
    route: "/log",
    // Every section of the Log screen with its data (Say it, Check-in, Journal, Supplements, Uber Eats, Weight, Reading).
    ready: logReady,
  },
  {
    slug: "analytics-hrv",
    label: "/analytics/hrv",
    route: "/analytics/hrv",
    ready: ready(`!!document.querySelector('[data-testid="hero-tomorrow-hrv"]') && ${hasChart}`),
  },
  { slug: "sleep", label: "/sleep", route: "/sleep", ready: ready(hasChart) },
  { slug: "nutrition", label: "/nutrition", route: "/nutrition", ready: ready(hasChart) },
  {
    slug: "supplements",
    label: "/supplements",
    route: "/supplements",
    ready: ready(`${h("Supplements", "h1")} && !${leafText("Loading…")} && ${h("Today's compound totals")}`),
  },
  {
    slug: "agents",
    label: "/agents",
    route: "/agents",
    // Cross-origin Worker inbox call; ready when the "Loading…" line is replaced by the list or the caught-up state.
    ready: ready(`${h("Agents", "h1")} && !${leafText("Loading…")}`),
  },
  {
    slug: "status",
    label: "/status",
    route: "/status",
    ready: ready(`(${ROUTED_TEXT}.match(/last sync/gi) || []).length > 4`),
  },
  {
    slug: "caffeine",
    label: "/caffeine",
    route: "/caffeine",
    // The default 60-day window is empty during a caffeine logging pause; the empty state then IS the settled page.
    ready: ready(`${hasChart} || ${ROUTED_TEXT}.toLowerCase().includes("no caffeine days in the database yet.")`),
    emptyText: "No caffeine days in the database yet.",
    note: "default 60-day window; the empty state counts as settled",
  },
  {
    slug: "caffeine-720",
    label: "/caffeine?days=720",
    route: "/caffeine?days=720",
    // Non-default window: the ISR seed is discarded, so this is skeleton then client fetch with real rows.
    ready: ready(`${hasChart}`),
    note: "extra: non-default window, client fetch with no ISR seed",
  },
  { slug: "financials", label: "/financials", route: "/financials", ready: serverPageReady },
  { slug: "financials-budgets", label: "/financials/budgets", route: "/financials/budgets", ready: serverPageReady },
  { slug: "financials-forecast", label: "/financials/forecast", route: "/financials/forecast", ready: serverPageReady },
];

// Pages timed as in-app navigations (sidebar links). Routes with a query string have no sidebar link.
const IN_APP = ["/log", "/check-in", "/sleep", "/nutrition", "/supplements", "/analytics/hrv", "/caffeine", "/status", "/financials", "/financials/budgets", "/financials/forecast"];

/** What a result file says about how it was measured (harness 2). `enforced: false` = observed only. */
interface ScenarioMeta {
  name: "full-load" | "in-app-prewarmed" | "phone-full-load" | "phone-input";
  device: string;
  viewport: string;
  cpuSlowdown: number;
  firstNavigation: string;
  laterNavigations: string;
  enforced: boolean;
  /** In-app only: how long Today had been open (its load and warm-up) before the first click. */
  prewarmedForMs?: number | null;
}

const viewportOf = (d: { viewport?: { width: number; height: number } | null }) => (d.viewport ? `${d.viewport.width}x${d.viewport.height}` : "unknown");
const SCENARIO: Record<"fullLoad" | "inApp" | "phoneLoad" | "phoneInput", ScenarioMeta> = {
  fullLoad: {
    name: "full-load", device: "Desktop Chrome", viewport: viewportOf(DESKTOP), cpuSlowdown: 1, enforced: true,
    firstNavigation: "empty browser cache (new context); CDN and function state not controlled, recorded as observed",
    laterNavigations: "warm browser cache, same context",
  },
  inApp: {
    name: "in-app-prewarmed", device: "Desktop Chrome", viewport: viewportOf(DESKTOP), cpuSlowdown: 1, enforced: true,
    firstNavigation: "first click of the session, after Today loaded and its warm-up ran (prewarmed: client cache, router prefetch, HTTP cache); not a cold visit",
    laterNavigations: "later rounds of the same session",
  },
  phoneLoad: {
    name: "phone-full-load", device: "iPhone 13 metrics on Chromium", viewport: viewportOf(PHONE), cpuSlowdown: PHONE_CPU_SLOWDOWN, enforced: false,
    firstNavigation: "empty browser cache (new context); CDN and function state not controlled, recorded as observed",
    laterNavigations: "warm browser cache, same context",
  },
  phoneInput: {
    name: "phone-input", device: "iPhone 13 metrics on Chromium", viewport: viewportOf(PHONE), cpuSlowdown: PHONE_CPU_SLOWDOWN, enforced: false,
    firstNavigation: "taps on the bottom bar after Log loaded at 390 px (the session is prewarmed by then)",
    laterNavigations: "later rounds of the same session",
  },
};

interface Rec {
  cls: string;
  key: string;
  /** Full URL, held in memory only to match the browser's network log; never written to a result file. */
  url: string;
  startMs: number;
  endMs?: number;
  durMs?: number;
  bytes: number;
  failed: boolean;
  prefetch: boolean;
  via?: string;
}

interface Sample {
  i: number;
  cold: boolean;
  ok: boolean;
  /**
   * How this navigation was observed: "fixed-window" (observed to the window's end plus the drain) or "network-quiet"
   * (version 1 spacing: the network-quiet wait alone). Samples of the two cadences are different methods and are never
   * pooled together (perf-stats.cjs CADENCES). Set before anything can fail, so a failed navigation carries it too.
   */
  cadence?: string;
  error?: string;
  status?: number | null;
  ttfb?: number | null;
  serverWait?: number | null;
  fcp?: number | null;
  lcp?: number | null;
  dcl?: number | null;
  load?: number | null;
  ready?: number | null;
  firstChart?: number | null;
  docBytes?: number | null;
  quietTimedOut?: boolean;
  degraded?: boolean;
  emptyState?: boolean;
  cache?: string | null;
  region?: string | null;
  req?: Record<string, unknown>;
  total?: { n: number; bytes: number };
  endpoints?: Record<string, unknown>;
  // Harness 2.
  cacheState?: Record<string, string>;
  firstVisit?: boolean;
  /** Request clock (ms since this navigation started): data-ready, the click, the network-quiet close. */
  readyAtMs?: number | null;
  clickAtMs?: number | null;
  /**
   * In-app only: the press on the link (request clock), where the fixed window starts. Null when it was not observed:
   * the window is then recorded as unknown (`window.anchor: "unobserved"` and its reason), never counted.
   */
  pointerAtMs?: number | null;
  /** In-app only: the event that set it (pointerdown; mousedown or click only if no pointerdown was seen), or null. */
  pointerEvent?: string | null;
  /** In-app only: Playwright's actionability wait, from just before the click call to that press (ms). */
  clickWaitMs?: number | null;
  /** In-app only: the click loaded a new document (a full reload); its times are on the shared clock. */
  newDocument?: boolean;
  /** In-app only: ms since Today was opened (its load and warm-up) when this click was made. */
  sinceTodayMs?: number | null;
  quietAtMs?: number | null;
  window?: Record<string, unknown>;
  longTasks?: Record<string, unknown>;
  feedAtMs?: number | null;
  firstPrefetchAtMs?: number | null;
}

interface InputSample {
  i: number;
  round: number;
  action: string;
  ok: boolean;
  error?: string;
  inputMs?: number | null;
  eventMs?: number | null;
  readyMs?: number | null;
  longTasks?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Browser network log: where each response came from (network, memory / disk / prefetch cache, service worker).
// Chromium only (the run's only browser). Requests are matched to Playwright's by URL in order; anything the log
// did not report (probe unavailable, request still open, a hop it never saw) is "unknown", never "network".
// ---------------------------------------------------------------------------

interface NetInfo {
  servedFromCache?: boolean;
  fromDiskCache?: boolean;
  fromPrefetchCache?: boolean;
  fromServiceWorker?: boolean;
  responded?: boolean;
  lowPriority?: boolean;
}
interface CacheProbe {
  reset(): void;
  take(url: string): NetInfo | undefined;
  detach(): Promise<void>;
}

async function attachCacheProbe(page: Page): Promise<CacheProbe> {
  let byUrl = new Map<string, NetInfo[]>();
  let byId = new Map<string, NetInfo>();
  let session: CDPSession | null = null;
  try {
    session = await page.context().newCDPSession(page);
    await session.send("Network.enable");
    session.on("Network.requestWillBeSent", (e) => {
      if (String(e.type) === "Preflight") return; // CORS preflights are not page requests in Playwright's events
      if (e.redirectResponse) {
        const prev = byId.get(e.requestId);
        if (prev) Object.assign(prev, { responded: true, fromDiskCache: !!e.redirectResponse.fromDiskCache, fromServiceWorker: !!e.redirectResponse.fromServiceWorker });
      }
      const pr = String(e.request.initialPriority || "");
      const info: NetInfo = { lowPriority: pr === "Low" || pr === "VeryLow" };
      byId.set(e.requestId, info);
      const q = byUrl.get(e.request.url);
      if (q) q.push(info);
      else byUrl.set(e.request.url, [info]);
    });
    session.on("Network.requestServedFromCache", (e) => {
      const info = byId.get(e.requestId);
      if (info) info.servedFromCache = true;
    });
    session.on("Network.responseReceived", (e) => {
      const info = byId.get(e.requestId);
      if (!info) return;
      info.responded = true;
      info.fromDiskCache = !!e.response.fromDiskCache;
      info.fromPrefetchCache = !!e.response.fromPrefetchCache;
      info.fromServiceWorker = !!e.response.fromServiceWorker;
    });
  } catch {
    session = null;
  }
  return {
    reset() {
      byUrl = new Map();
      byId = new Map();
    },
    take(url) {
      if (!session) return undefined;
      return byUrl.get(url)?.shift();
    },
    async detach() {
      try {
        await session?.detach();
      } catch {
        /* the context may already be closed */
      }
    },
  };
}

/**
 * Slow the page's CPU like a phone (Chrome DevTools protocol), on one session kept for the page. `applied` is the
 * slowdown actually in force (1 when the browser refused it, which the result file then says); `reapply` sets it
 * again before each measured navigation, in case a new renderer process did not inherit it.
 */
async function slowCpu(page: Page, rate: number): Promise<{ applied: number; reapply: () => Promise<void> }> {
  if (rate <= 1) return { applied: 1, reapply: async () => {} };
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate });
    return {
      applied: rate,
      reapply: async () => {
        try {
          await session.send("Emulation.setCPUThrottlingRate", { rate });
        } catch {
          /* the first setting stays in force */
        }
      },
    };
  } catch {
    return { applied: 1, reapply: async () => {} };
  }
}

/** The commit SHA production serves (/api/version, the signed-in context's cookies); null when it cannot be read. */
async function deployedSha(context: BrowserContext, origin: string): Promise<string | null> {
  try {
    const res = await context.request.get(`${origin}/api/version`, { timeout: 10_000, failOnStatusCode: false });
    if (!res.ok()) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && /^[0-9a-f]{7,40}$/i.test(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

interface MeasureOptions {
  probe?: CacheProbe;
  /** Observe a fixed window of this many ms from the navigation (0 = network-quiet window only, harness 1). */
  windowMs?: number;
  /** In-app only: Date.now() when Today was opened, so each click records how long the session had been warming. */
  sessionStartedAt?: number;
  /** Runs after about:blank, before the measured navigation (re-applies the phone CPU slowdown). */
  beforeGoto?: () => Promise<unknown>;
}

async function measureOnce(page: Page, spec: PageSpec, origin: string, i: number, mode: "load" | "click" = "load", opts: MeasureOptions = {}): Promise<Sample> {
  const windowMs = opts.windowMs ?? 0;
  const sample: Sample = { i, cold: i === 0, ok: false, cadence: stats.cadenceFor(windowMs) };
  if (mode === "click") sample.firstVisit = i === 0;
  if (mode === "load") {
    await page.goto("about:blank");
    if (opts.beforeGoto) await opts.beforeGoto();
  }
  opts.probe?.reset();

  const records: Rec[] = [];
  const open = new Map<Request, Rec>();
  const sizeJobs: Promise<void>[] = [];
  const t0 = Date.now();
  let lastActivity = t0;

  const onRequest = (req: Request) => {
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return;
    const { cls, key } = stats.classifyRequest(url, req.resourceType(), origin, AGENTS_HOST);
    const hd = req.headers();
    // Next's router prefetch header (auto prefetch, segment prefetch) or a browser prefetch purpose header.
    const prefetch = "next-router-prefetch" in hd || "next-router-segment-prefetch" in hd || /prefetch/i.test(hd["purpose"] || hd["sec-purpose"] || "");
    const rec: Rec = { cls, key, url, startMs: Date.now() - t0, bytes: 0, failed: false, prefetch };
    open.set(req, rec);
    records.push(rec);
    lastActivity = Date.now();
  };
  const settle = (req: Request, failed: boolean) => {
    const rec = open.get(req);
    if (!rec) return;
    open.delete(req);
    rec.endMs = Date.now() - t0;
    rec.failed = failed;
    lastActivity = Date.now();
    if (failed) return;
    const t = req.timing();
    rec.durMs = t.responseEnd >= 0 ? t.responseEnd : rec.endMs - rec.startMs;
    sizeJobs.push(
      req
        .sizes()
        .then((s) => {
          rec.bytes = s.responseBodySize + s.responseHeadersSize;
        })
        .catch(() => {})
    );
  };
  const onFinished = (req: Request) => settle(req, false);
  const onFailed = (req: Request) => settle(req, true);
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);

  let clickedAt = 0; // page clock just before the click call (in-app mode); `ready` and the chart are timed from it
  let clickOrigin = 0; // that document's time origin (a different one later = the click reloaded the document)
  let vercelCache: string | undefined;
  let vercelId: string | undefined;
  try {
    if (mode === "load") {
      const resp = await page.goto(spec.route, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
      sample.status = resp ? resp.status() : null;
      const headers = resp ? resp.headers() : {};
      vercelCache = headers["x-vercel-cache"];
      vercelId = headers["x-vercel-id"];
      sample.cache = vercelCache ?? null;
      // "iad1::<request-id>" (CDN) or "iad1::iad1::<request-id>" (function ran): keep the regions only.
      sample.region = vercelId ? vercelId.split("::").slice(0, -1).join(">") : null;
    } else {
      // Shown copy only: every page also has an off (display:none) copy in Quick access or its section.
      const linkSel = `aside a[href="${spec.route}"]:not([data-off])`;
      const link = page.locator(linkSel).first();
      await link.scrollIntoViewIfNeeded({ timeout: 10_000 });
      // Mark the old page, restart the chart watch and listen for the press on the link (pointerdown, which comes
      // before mousedown and click): when the click really began, after Playwright's actionability checks. The pointer
      // merely arriving over the link (pointerover) is not used: a link moving under a mouse resting from the previous
      // click (the sidebar scrolls its active item into view) fires it before Playwright's own move, too early.
      [clickedAt, clickOrigin] = await page.evaluate(({ sel, link }) => {
        document.querySelectorAll(sel).forEach((e) => e.setAttribute("data-pf-old", ""));
        const w = window as unknown as {
          __pfWatchChart: () => void;
          __pfPointerAt?: number | null;
          __pfPointerType?: string | null;
          __pfPointerOff?: () => void;
        };
        w.__pfWatchChart();
        w.__pfPointerOff?.();
        w.__pfPointerAt = null;
        w.__pfPointerType = null;
        const types = ["pointerdown", "mousedown", "click"];
        const onPointer = (e: Event) => {
          if (w.__pfPointerAt == null && e.target instanceof Element && e.target.closest(link)) {
            w.__pfPointerAt = e.timeStamp;
            w.__pfPointerType = e.type;
          }
        };
        for (const t of types) addEventListener(t, onPointer, { capture: true, passive: true });
        w.__pfPointerOff = () => {
          for (const t of types) removeEventListener(t, onPointer, { capture: true });
        };
        return [performance.now(), performance.timeOrigin] as [number, number];
      }, { sel: ROUTE_CONTENT, link: linkSel });
      sample.clickAtMs = Date.now() - t0;
      if (opts.sessionStartedAt != null) sample.sinceTodayMs = Date.now() - opts.sessionStartedAt;
      await link.click({ timeout: 10_000 });
    }
    sample.cacheState = stats.cacheStateOf({ mode, first: i === 0, vercelCache, vercelId });

    const finalPath = new URL(page.url()).pathname;
    if (/^\/login/.test(finalPath)) throw new Error("bounced-to-login: saved session is not valid");

    const routeReady = mode === "load" ? spec.ready
      : `(location.pathname === ${JSON.stringify(spec.route)} && !document.querySelector(${JSON.stringify(OLD_CONTENT)})) ? ${spec.ready} : false`;
    // [page clock at ready, that document's time origin]: the time origin puts data-ready on the request clock.
    const readyExpr = `(() => { const v = ${routeReady}; return v ? [v, performance.timeOrigin] : false; })()`;
    try {
      const handle = await page.waitForFunction(readyExpr, undefined, {
        timeout: READY_TIMEOUT_MS,
        polling: "raf",
      });
      const [at, timeOrigin] = (await handle.jsonValue()) as [number, number];
      // In-app: from just before the click call (version 1). A click that loaded a new document is timed on the shared
      // clock (its page clock restarted at 0), so the reload is counted and the time is never negative.
      if (mode === "click") {
        sample.newDocument = timeOrigin !== clickOrigin;
        sample.ready = stats.sinceClickMs(at, timeOrigin, clickedAt, clickOrigin);
        if (sample.ready == null) sample.error = "ready-not-timed"; // a clock was missing: not measured, never a pass
      } else {
        sample.ready = at;
      }
      const onRequestClock = timeOrigin + at - t0;
      sample.readyAtMs = Number.isFinite(onRequestClock) && onRequestClock >= 0 ? onRequestClock : Date.now() - t0;
    } catch (e) {
      if ((e as Error).message.includes("bounced")) throw e;
      sample.error = "ready-timeout";
    }

    // Keep observing until the page has been network-quiet (silent revalidations and late chart fetches are part of
    // the cost of a page view; harness 1, unchanged) AND, in harness 2, the fixed window is over. The window starts at
    // the navigation itself: navigation start for a full load; for an in-app one, the press on the link (pointerdown;
    // scrolling to the link, marking the old page and Playwright's actionability checks come before it and never use
    // the window up). When that input was not observed (the read failed, no press was seen, or the click loaded a new
    // document) the window's start is unknown: it is recorded as unknown with the reason and nothing is counted in it
    // (perf-stats.cjs ANCHOR_KINDS). The click call's time is never used instead, because Playwright's actionability
    // wait comes after it and could use the window up. The quiet moment is kept: the version 1 totals count only
    // requests that started before it, and data ready keeps its version 1 timing either way.
    let anchor = 0;
    let anchorKind = "navigation-start";
    let anchorReason: string | null = null;
    if (mode === "click") {
      const read = await page
        .evaluate(() => {
          const w = window as unknown as { __pfPointerAt?: number | null; __pfPointerType?: string | null; __pfPointerOff?: () => void };
          w.__pfPointerOff?.();
          w.__pfPointerOff = undefined;
          return { pointer: [w.__pfPointerAt ?? null, performance.timeOrigin] as [number | null, number], type: w.__pfPointerType ?? null };
        })
        .catch(() => null);
      const pointer = read ? read.pointer : null;
      // Same document only, measured on the page's own clock from the mark, then put on the request clock.
      const input = stats.inputAnchorOf({ pointer, clickOrigin, markedAt: clickedAt, clickAtMs: sample.clickAtMs });
      anchorKind = input.kind;
      anchorReason = input.reason;
      sample.clickWaitMs = input.clickWaitMs;
      sample.pointerAtMs = input.anchorMs;
      sample.pointerEvent = input.kind === "input" && read ? read.type : null;
      // Unobserved: observation still runs to the click call plus the window, so the spacing before the next click is
      // unchanged; nothing in that span is counted.
      anchor = input.anchorMs ?? sample.clickAtMs ?? 0;
    }
    const windowed = windowMs > 0 && anchorKind !== "unobserved";
    const winEnd = anchor + windowMs;
    const winStart = Date.now();
    let quietAt: number | null = null;
    for (;;) {
      const now = Date.now();
      if (quietAt == null) {
        if (open.size === 0 && now - lastActivity >= QUIET_MS) quietAt = now - t0;
        else if (now - winStart >= WINDOW_CAP_MS) {
          sample.quietTimedOut = true;
          quietAt = now - t0;
        }
      }
      if (quietAt != null && (windowMs <= 0 || now - t0 >= winEnd)) break;
      await page.waitForTimeout(100);
    }
    const observedMs = Date.now() - t0;
    sample.quietAtMs = quietAt;
    // The window's cost is decided at ONE moment, its end plus DRAIN_MS: a request that started in the window and
    // finished by then is measured, one still open then is unfinished (cost unknown), even if it finished later while
    // the network-quiet wait above went on (that wait closes at a different moment on every navigation, so it must not
    // decide which requests count as finished). Observation goes on to that moment only while such a request is open.
    const settleBy = winEnd + DRAIN_MS;
    if (windowed) {
      const openInWindow = () => [...open.values()].some((r) => r.startMs >= anchor && r.startMs < winEnd);
      while (openInWindow() && Date.now() - t0 < settleBy) await page.waitForTimeout(100);
    }
    await Promise.allSettled(sizeJobs);

    const m = await page.evaluate(
      async ({ emptyText, routedSel, since }) => {
        const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
        const fcpEntry = performance.getEntriesByName("first-contentful-paint")[0];
        const lcp = await new Promise<number | null>((resolve) => {
          let last: number | null = null;
          const po = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) last = e.startTime;
          });
          try {
            po.observe({ type: "largest-contentful-paint", buffered: true });
          } catch {
            resolve(null);
            return;
          }
          setTimeout(() => {
            po.disconnect();
            resolve(last);
          }, 150);
        });
        const text = document.body.innerText;
        // The empty state is the routed page's own, not a neighbour's in the continuous scroll.
        const routedText = (document.querySelector(routedSel) as HTMLElement | null)?.innerText ?? text;
        const w = window as unknown as { __pfChart?: number; __pfFeedAt?: number | null; __pfLong?: Array<[number, number]> };
        return {
          ttfb: nav.responseStart,
          serverWait: nav.responseStart - nav.requestStart,
          dcl: nav.domContentLoadedEventEnd,
          load: nav.loadEventEnd,
          docBytes: nav.transferSize,
          fcp: fcpEntry ? fcpEntry.startTime : null,
          lcp,
          firstChart: w.__pfChart ?? null,
          degraded: /Application error|client-side exception/i.test(text),
          emptyState: emptyText ? routedText.toLowerCase().includes(emptyText.toLowerCase()) : false,
          timeOrigin: performance.timeOrigin,
          feedAt: w.__pfFeedAt ?? null,
          long: (w.__pfLong || []).filter((x) => x[0] >= since),
        };
      },
      { emptyText: spec.emptyText ?? "", routedSel: "[data-feed-root] > div[data-feed-route]", since: clickedAt }
    );
    const { timeOrigin, feedAt, long, ...timings } = m;
    if (mode === "click") {
      // The document was loaded before the click: its TTFB / FCP / LCP belong to Today, not to this page. The first chart
      // is timed like data ready (shared clock when the click loaded a new document).
      const firstChart = timings.firstChart == null ? null : stats.sinceClickMs(timings.firstChart, timeOrigin, clickedAt, clickOrigin);
      Object.assign(sample, { degraded: timings.degraded, emptyState: timings.emptyState, firstChart });
    } else {
      Object.assign(sample, timings);
    }
    const toRequestClock = (pageMs: number) => timeOrigin + pageMs - t0;
    // Sizes of requests that finished during the in-page reads above (the first wait took a snapshot of the list).
    await Promise.allSettled(sizeJobs);

    // Origin and purpose of every request, in the order they started (the network log is matched by URL in order).
    for (const rec of records) {
      const info = opts.probe?.take(rec.url);
      rec.via = stats.viaOf(info);
      if (!rec.prefetch && rec.cls === "rsc" && info?.lowPriority) rec.prefetch = true; // full prefetches go at low priority
    }
    // Moments reported relative to the window start, and only inside the window (null otherwise), so they describe
    // the same span as the window's counts.
    const inWindow = (t: number | null) => (t != null && Number.isFinite(t) && t >= anchor && t < winEnd ? t - anchor : null);
    const prefetchStarts = records.filter((r) => r.prefetch && r.startMs >= anchor && r.startMs < winEnd).map((r) => r.startMs);

    // Harness 1 totals: the requests that started before the network-quiet moment.
    const folded = stats.foldRequests(quietAt == null ? records : records.filter((r) => r.startMs <= quietAt!));
    sample.req = folded.req;
    sample.total = folded.total;
    sample.endpoints = folded.endpoints;
    if (windowMs > 0) {
      // An unobserved click input gives a window of unknown start: foldWindow records it as such (no counts, never
      // complete), and the moments measured from the window start are left unset (not measured, never zero).
      sample.window = stats.foldWindow(records, { windowMs, readyAtMs: sample.readyAtMs, observedMs, anchorMs: anchor, settleByMs: settleBy, anchorKind, anchorReason });
      if (windowed) {
        sample.longTasks = stats.foldLongTasks(long.map((x) => [toRequestClock(x[0]), x[1]]), anchor, winEnd, sample.readyAtMs);
        sample.feedAtMs = feedAt == null ? null : inWindow(toRequestClock(feedAt));
        sample.firstPrefetchAtMs = prefetchStarts.length ? Math.min(...prefetchStarts) - anchor : null;
      }
    }
    sample.ok = !sample.error && sample.ready != null;
  } catch (e) {
    sample.ok = false;
    sample.error = sample.error || (e as Error).message.slice(0, 200);
    if (sample.error.startsWith("bounced")) throw e;
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
  }
  return sample;
}

interface ResultMeta {
  slug: string;
  label: string;
  route: string;
  note: string | null;
  navigations: number;
  startedAt: string;
  scenario: ScenarioMeta;
  deployed: { start: string | null; end: string | null };
  windowMs: number;
  /** Which navigations got the fixed window (part of the method: pooling keeps different rules apart). */
  windowRule: string | null;
  kind?: "input";
  planned?: number;
  /** Observe-only: why the loop stopped before every planned navigation / tap was tried (its time budget ran out). */
  stopped?: string | null;
}

function writeResult(meta: ResultMeta, browserVersion: string, samples: unknown[]) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    meta: {
      ...meta,
      harness: stats.HARNESS_VERSION,
      finishedAt: new Date().toISOString(),
      quietMs: QUIET_MS,
      windowCapMs: WINDOW_CAP_MS,
      fixedWindowMs: meta.windowMs,
      github: {
        runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        sha: process.env.GITHUB_SHA ?? null,
        ref: process.env.GITHUB_REF_NAME ?? null,
      },
      runner: { platform: process.platform, cpus: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), chromium: browserVersion },
    },
    samples,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${meta.slug}.json`), JSON.stringify(payload, null, 1));
}

interface SeriesOptions {
  device: typeof DESKTOP;
  scenario: ScenarioMeta;
  navigations: number;
  slug: string;
  label: string;
  /** Observe-only: no navigation starts once this long has passed since the test began (the rest are not tried). */
  budgetMs?: number;
  /**
   * Observe-only: the test's own deadline (observeOnly). Given the context to close and how to write the result file
   * as interrupted; the series starts no navigation once it fired. Absent for an enforced page.
   */
  run?: ObserveRun | null;
}

/** N full loads of one page in a fresh context (navigation 1 = empty browser cache), written as <slug>.json. */
async function timePageSeries(browser: Browser, spec: PageSpec, o: SeriesOptions) {
  const began = Date.now();
  // An enforced page keeps its version 1 allowance. An observe-only (phone) series is run through observeOnly(), which
  // set its timeout: its time budget plus one navigation's worst case plus the finish (PHONE_SERIES_DEADLINE_MS, its
  // own deadline) and the deadline's cleanup reserve, so it cannot time out.
  if (o.budgetMs == null) {
    test.setTimeout(o.navigations * (READY_TIMEOUT_MS + WINDOW_CAP_MS + FIXED_WINDOW_MS + DRAIN_MS + PAUSE_MS + 5_000) + 90_000);
  }

  // Fresh context per page => navigation 1 really has an empty HTTP cache.
  const context = await browser.newContext({ ...o.device, storageState: AUTH_FILE });
  o.run?.own(context);
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  const probe = await attachCacheProbe(page);
  const cpu = await slowCpu(page, o.scenario.cpuSlowdown);
  const beforeGoto = cpu.applied > 1 ? cpu.reapply : undefined;

  const samples: Sample[] = [];
  const startedAt = new Date().toISOString();
  const deployed = { start: await deployedSha(context, origin), end: null as string | null };
  let stopped: string | null = null;
  const meta = (why: string | null): ResultMeta => ({
    slug: o.slug, label: o.label, route: spec.route, note: spec.note ?? null, navigations: o.navigations, startedAt,
    scenario: { ...o.scenario, cpuSlowdown: cpu.applied }, deployed, windowMs: FIXED_WINDOW_MS, windowRule: FULL_LOAD_WINDOW_RULE, stopped: why,
  });
  // The navigation in progress (observe-only deadline: it is recorded as interrupted, not measured, never a pass).
  let inFlight: number | null = null;
  o.run?.onInterrupt((deadlineMs) => {
    const rows: Sample[] = inFlight == null ? [...samples] : [...samples, { i: inFlight, cold: inFlight === 0, ok: false, cadence: stats.cadenceFor(fullLoadWindowMs(inFlight)), error: stats.INTERRUPTED_ERROR }];
    writeResult(meta(stats.interruptedStop(deadlineMs, rows.length, o.navigations, "navigations")), browser.version(), rows);
  });
  try {
    for (let i = 0; i < o.navigations; i++) {
      if (o.run?.interrupted) break;
      if (o.budgetMs != null && Date.now() - began >= o.budgetMs) {
        stopped = `time budget of ${o.budgetMs / 1000} s used up: ${i} of ${o.navigations} navigations tried`;
        break;
      }
      const windowMs = fullLoadWindowMs(i);
      let s: Sample;
      inFlight = i;
      try {
        s = await measureOnce(page, spec, origin, i, "load", { probe, windowMs, beforeGoto });
      } catch (e) {
        // measureOnce throws only on a bounce to the login page. On an observe-only page that navigation is kept as
        // not measured (the catch below ends the series); an enforced page fails as before, its file unchanged.
        if (!o.scenario.enforced) samples.push({ i, cold: i === 0, ok: false, cadence: stats.cadenceFor(windowMs), error: stats.errorLine(e) });
        inFlight = null;
        throw e;
      }
      samples.push(s);
      inFlight = null;
      // Two navigations in a row that never reach data-ready mean the page (or this
      // script's selector for it) is broken: stop instead of burning 30 s per navigation.
      if (i >= 1 && samples.every((x) => !x.ok)) break;
      if (i < o.navigations - 1) await page.waitForTimeout(PAUSE_MS);
    }
  } catch (e) {
    // Observe-only (the phone): a failure, a bounce to the login page included, ends the series and is recorded as not
    // measured (`stopped`, written below); the test does not fail, so the run's exit code and the enforced speed-budget
    // step (which runs only when the measuring step passed) depend on the enforced pages alone. An enforced page still
    // fails the test, exactly as before.
    if (o.scenario.enforced) throw e;
    stopped = stats.observeOnlyStop(e, samples.length, o.navigations, "navigations");
  } finally {
    deployed.end = await deployedSha(context, origin);
    await probe.detach();
    await context.close();
    // Observe-only: written once, here or by the deadline if that came first (its file then stands). Enforced: as before.
    const write = () => writeResult(meta(stopped), browser.version(), samples);
    if (o.run) o.run.writeOnce(write);
    else write();
  }
  // Interrupted at the deadline: the result file and the log line were written by it; nothing more to say.
  if (o.run?.interrupted) return;

  const okCount = samples.filter((s) => s.ok).length;
  console.log(`${o.label}: ${okCount}/${samples.length} navigations reached data-ready${stopped ? ` (${stopped})` : ""}`);
  // A page that never reached data-ready in ANY navigation is a failed measurement, not a slow one.
  // (A page that reached it only sometimes is caught by the speed budget: every missing navigation is a breach.)
  // An observe-only scenario (the phone) is reported, never fails the run: the report lists its missing
  // navigations as not measured, never as fast.
  if (o.scenario.enforced) expect(okCount, `${o.label} never reached its data-ready state`).toBeGreaterThan(0);
}

for (const spec of PAGES) {
  test(`timing ${spec.label}`, async ({ browser }) => {
    await timePageSeries(browser, spec, { device: DESKTOP, scenario: SCENARIO.fullLoad, navigations: NAVIGATIONS, slug: spec.slug, label: spec.label });
  });
}

// In-app navigation: open the app, let Today and the idle warm-up settle, then click through the sidebar.
const ROUNDS = Math.min(4, NAVIGATIONS);
test("timing in-app navigation from Today", async ({ browser }) => {
  test.setTimeout((ROUNDS * IN_APP.length + 1) * (READY_TIMEOUT_MS + WINDOW_CAP_MS + IN_APP_WINDOW_MS + DRAIN_MS + PAUSE_MS + 15_000) + 90_000);
  const context = await browser.newContext({ ...DESKTOP, storageState: AUTH_FILE });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  const probe = await attachCacheProbe(page);
  const startedAt = new Date().toISOString();
  const specs = IN_APP.map((route) => PAGES.find((p) => p.route === route)).filter((p): p is PageSpec => !!p);
  const byRoute = new Map<string, Sample[]>(specs.map((p) => [p.route, []]));
  const deployed = { start: await deployedSha(context, origin), end: null as string | null };
  let prewarmedForMs: number | null = null;
  try {
    // Today is opened exactly as in harness 1 (network-quiet window only), so the prewarmed state the first click
    // starts from is unchanged; how long Today had been open by the first click is recorded.
    const openedAt = Date.now();
    const opened = await measureOnce(page, PAGES.find((p) => p.slug === "today")!, origin, 0, "load");
    expect(opened.ok, "Today did not load, so no in-app navigation could be timed").toBe(true);
    prewarmedForMs = Date.now() - openedAt;
    for (let round = 0; round < ROUNDS; round++) {
      for (const spec of specs) {
        // Round 1 keeps version 1 spacing (network-quiet only): its clicks are the enforced first in-app visits, and a
        // fixed window there would give every later route a longer Today warm-up before its first click than under
        // version 1. Later rounds are warm and get the fixed window from the click.
        const windowMs = round === 0 ? 0 : IN_APP_WINDOW_MS;
        byRoute.get(spec.route)!.push(await measureOnce(page, spec, origin, round, "click", { probe, windowMs, sessionStartedAt: openedAt }));
        await page.waitForTimeout(PAUSE_MS);
      }
      // A first round with no page reaching data-ready means the clicking itself is broken: stop (the missing rounds
      // are reported as incomplete pages by the speed budget) instead of burning 45 s per click.
      if (round === 0 && ![...byRoute.values()].some((xs) => xs[0]?.ok)) break;
    }
  } finally {
    deployed.end = await deployedSha(context, origin);
    await probe.detach();
    await context.close();
    for (const spec of specs) {
      writeResult(
        {
          slug: `nav-${spec.slug}`, label: `${spec.route} (in-app)`, route: spec.route,
          note: "clicked from the sidebar after Today settled; the first round is the first visit of a prewarmed session",
          navigations: ROUNDS, startedAt, scenario: { ...SCENARIO.inApp, prewarmedForMs }, deployed, windowMs: IN_APP_WINDOW_MS, windowRule: IN_APP_WINDOW_RULE,
        },
        browser.version(),
        byRoute.get(spec.route)!
      );
    }
  }
  const ok = [...byRoute.values()].flat().filter((s) => s.ok).length;
  console.log(`in-app: ${ok}/${ROUNDS * specs.length} navigations reached data-ready`);
  expect(ok, "no in-app navigation reached its data-ready state").toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Phone, 390 px (observed only, `enforced: false`): full loads of Today and Log, then taps on the bottom bar.
// ---------------------------------------------------------------------------

/**
 * What an observe-only test body shares with its deadline (observeOnly): the browser context to close and how to
 * write its result file as interrupted. The result file is written ONCE: by the body's own finally, or by the deadline
 * when that came first (the body may still unwind afterwards, once its context is closed, and must not overwrite it).
 */
class ObserveRun {
  /** True once the deadline fired: the body starts no new navigation or tap. */
  interrupted = false;
  private context: BrowserContext | null = null;
  private interruptWrite: ((deadlineMs: number) => void) | null = null;
  private written = false;

  /** The body's context: the deadline closes it, which ends any call still waiting on it. */
  own(context: BrowserContext) {
    this.context = context;
  }

  /** How to write the result file as interrupted (the step in progress not measured). Not set yet = no file. */
  onInterrupt(write: (deadlineMs: number) => void) {
    this.interruptWrite = write;
  }

  /** Writes the result file unless it was already written. */
  writeOnce(write: () => void) {
    if (this.written) return;
    this.written = true;
    write();
  }

  /** The deadline: stop the body, write its file as interrupted, close its context (observeOnly bounds the close). */
  async interrupt(deadlineMs: number) {
    this.interrupted = true;
    const write = this.interruptWrite;
    if (write) {
      try {
        this.writeOnce(() => write(deadlineMs));
      } catch (e) {
        console.log(`could not write the interrupted result file (${stats.errorLine(e, 120)}); reported as not measured`);
      }
    }
    await this.context?.close().catch(() => {});
  }
}

/**
 * Runs the body of an observe-only test (`scenario.enforced: false`) so that it never fails the run: the workflow's
 * enforced speed-budget step runs only when the measuring step passed, so a phone failure (a bounce to the login page,
 * a context that could not be set up, a step that never returns) must not decide the run's exit code or keep the
 * budget from being evaluated.
 *   - Failures inside a series or the taps are recorded in the result file as not measured (`stopped`); one before a
 *     result file was written leaves that file absent, which the report lists as "no result file written (not
 *     measured, not a pass)".
 *   - Its own deadline, `deadlineMs` after the start (stats.withDeadline): Playwright's test timeout cannot be caught
 *     inside the test, and a step that never returns (page.evaluate() on a page that stopped answering has no
 *     timeout) would reach it. At the deadline the result file is written as interrupted (the step in progress not
 *     measured, the rest not tried; `stopped` says so), the context is closed (at most DEADLINE_CLEANUP_MS) and the
 *     test ends, DEADLINE_RESERVE_MS before its timeout. A deadline before the result file could be set up leaves it
 *     absent (not measured).
 * Logged as one line with no address. The test's timeout is set here: the deadline plus the reserve. An enforced
 * scenario gets the same timeout but runs the body as it is, so it fails as before (a hang included); the desktop
 * pages never go through this.
 */
async function observeOnly(scenario: ScenarioMeta, label: string, deadlineMs: number, body: (run: ObserveRun | null) => Promise<void>): Promise<void> {
  test.setTimeout(deadlineMs + DEADLINE_RESERVE_MS);
  if (scenario.enforced) return body(null);
  const run = new ObserveRun();
  const r = await stats.withDeadline(() => body(run), {
    deadlineMs,
    cleanupMs: DEADLINE_CLEANUP_MS,
    onDeadline: () => run.interrupt(deadlineMs),
  });
  if (r.outcome === "failed") {
    console.log(`${label}: not measured (${stats.errorLine(r.error, 160)}); observe-only, so it does not fail the run, and it is not a pass`);
  } else if (r.outcome === "interrupted") {
    console.log(`${label}: interrupted at its ${Math.round(deadlineMs / 1000)} s deadline (a step did not finish); recorded as not measured, not a pass; observe-only, so it does not fail the run`);
  }
}

for (const slug of PHONE_PAGES) {
  const spec = PAGES.find((p) => p.slug === slug)!;
  test(`timing phone ${spec.label}`, async ({ browser }) => {
    test.skip(!PHONE_THIS_RUN, PHONE_SKIP_REASON);
    const label = `${spec.label}, 390 px`;
    await observeOnly(SCENARIO.phoneLoad, label, PHONE_SERIES_DEADLINE_MS, (run) =>
      timePageSeries(browser, spec, {
        device: PHONE, scenario: SCENARIO.phoneLoad, navigations: PHONE_NAVIGATIONS, slug: `phone-${spec.slug}`, label,
        budgetMs: PHONE_SERIES_BUDGET_MS, run,
      })
    );
  });
}

interface TapStep {
  action: string;
  /** The control to tap (the shown copy is used). */
  target: string;
  /** Truthy (performance.now()) once what the tap opens is ready. */
  ready: string;
  /** For a tap that navigates: the paths it may land on (the old page's content must be gone too). */
  paths?: string[];
  /** Where the screen should be after the step: a failed step is recovered by loading it (not measured). */
  leaveAt: string;
  timeoutMs: number;
  /** Skipped (and counted as not measured) when the step before it was not measured. */
  needsPrevious?: boolean;
}

const TAB_BAR = '[data-testid="mobile-tab-bar"]';
const DRAWER_OPEN = `!!document.querySelector('#mobile-navigation[role="dialog"]')`;
// Read-only taps: two bottom-bar pages and the menu. Nothing on these screens is tapped that could write.
const PHONE_STEPS: TapStep[] = [
  { action: "tap Today tab", target: `${TAB_BAR} a[href="/today"], ${TAB_BAR} a[href="/"]`, ready: todayReady, paths: ["/today", "/"], leaveAt: "/today", timeoutMs: READY_TIMEOUT_MS },
  { action: "open More menu", target: `${TAB_BAR} button[aria-haspopup="dialog"], header button[aria-label="More"]`, ready: ready(DRAWER_OPEN), leaveAt: "/today", timeoutMs: 5_000 },
  { action: "close More menu", target: '#mobile-navigation button[aria-label="Close navigation"]', ready: ready(`!(${DRAWER_OPEN})`), leaveAt: "/today", timeoutMs: 5_000, needsPrevious: true },
  { action: "tap Log tab", target: `${TAB_BAR} a[href="/log"]`, ready: logReady, paths: ["/log"], leaveAt: "/log", timeoutMs: READY_TIMEOUT_MS },
];

type OpenResult = "ready" | "not-ready" | "bounced";
/** The reason a phone loop ends on a bounce to the login page (perf-stats.cjs isLoginBounce recognises it). */
const BOUNCED = "bounced-to-login: saved session is not valid";
/**
 * Load a phone screen and wait until it is ready: "ready", "not-ready" (it did not load or get ready in time) or
 * "bounced" (it ended on the login page: the saved session was not accepted, also when the app sent it there after the
 * load). Never throws: the phone scenario is observe-only, and the caller records a bounce as not measured.
 */
async function openAndWait(page: Page, route: string, readyExpr: string): Promise<OpenResult> {
  const onLogin = () => {
    try {
      return /^\/login/.test(new URL(page.url()).pathname);
    } catch {
      return false;
    }
  };
  try {
    await page.goto(route, { waitUntil: "domcontentloaded", timeout: GOTO_TIMEOUT_MS });
    if (onLogin()) return "bounced";
    await page.waitForFunction(readyExpr, undefined, { timeout: READY_TIMEOUT_MS, polling: "raf" });
    return "ready";
  } catch {
    return onLogin() ? "bounced" : "not-ready";
  }
}

async function measureTap(page: Page, step: TapStep, round: number, i: number): Promise<InputSample> {
  const s: InputSample = { i, round, action: step.action, ok: false };
  try {
    const target = page.locator(step.target).filter({ visible: true }).first();
    if ((await target.count()) === 0) {
      s.error = "control not on screen";
      return s;
    }
    const before = await page.evaluate(({ sel, nav }) => {
      if (nav) {
        document.querySelectorAll(sel).forEach((e) => e.setAttribute("data-pf-old", ""));
        (window as unknown as { __pfWatchChart?: () => void }).__pfWatchChart?.();
      }
      return { since: performance.now(), origin: performance.timeOrigin };
    }, { sel: ROUTE_CONTENT, nav: !!step.paths });
    await target.tap({ timeout: TAP_TIMEOUT_MS });
    const readyExpr = step.paths
      ? `(${JSON.stringify(step.paths)}.includes(location.pathname) && !document.querySelector(${JSON.stringify(OLD_CONTENT)})) ? ${step.ready} : false`
      : step.ready;
    let readyAt: number | null = null;
    try {
      const handle = await page.waitForFunction(readyExpr, undefined, { timeout: step.timeoutMs, polling: "raf" });
      readyAt = (await handle.jsonValue()) as number;
    } catch {
      s.error = "ready-timeout";
    }
    await page.waitForTimeout(INPUT_SETTLE_MS);
    const m = await page.evaluate((since) => {
      const w = window as unknown as {
        __pfInputs?: Array<{ down: number | null; click: number | null; paint: number | null }>;
        __pfEvents?: Array<[number, number, number]>;
        __pfLong?: Array<[number, number]>;
      };
      const rec = (w.__pfInputs || []).find((x) => (x.down ?? x.click ?? -1) >= since);
      const events = (w.__pfEvents || []).filter((x) => x[1] >= since).map((x) => x[2]);
      return {
        origin: performance.timeOrigin,
        down: rec ? rec.down : null,
        click: rec ? rec.click : null,
        paint: rec ? rec.paint : null,
        eventMax: events.length ? Math.max(...events) : null,
        long: (w.__pfLong || []).filter((x) => x[0] >= since),
      };
    }, before.since);
    if (m.origin !== before.origin) {
      s.error = s.error || "document reloaded";
      return s;
    }
    const start = m.down ?? m.click;
    if (start == null || m.click == null || m.paint == null) {
      s.error = s.error || "no input recorded";
      return s;
    }
    s.inputMs = m.paint - start;
    s.eventMs = m.eventMax;
    s.readyMs = readyAt != null ? readyAt - start : null;
    s.longTasks = stats.foldLongTasks(m.long, start, (readyAt ?? start) + INPUT_SETTLE_MS, readyAt);
    s.ok = !s.error && s.readyMs != null;
  } catch (e) {
    s.error = s.error || (e as Error).message.split("\n")[0].slice(0, 120);
  }
  return s;
}

test("timing phone input responsiveness, 390 px", async ({ browser }) => {
  test.skip(!PHONE_THIS_RUN, PHONE_SKIP_REASON);
  const began = Date.now();
  const planned = PHONE_ROUNDS * PHONE_STEPS.length;
  // Observe-only, so bounded: no tap starts after PHONE_INPUT_BUDGET_MS, and its own deadline (observeOnly, which also
  // sets the timeout) comes after the budget plus one tap's worst case (its ready wait and the recovery load included)
  // plus the finish: only a step that never returns reaches it, and the test still cannot time out.
  await observeOnly(SCENARIO.phoneInput, "Phone taps, 390 px", PHONE_INPUT_DEADLINE_MS, async (run) => {
    const context = await browser.newContext({ ...PHONE, storageState: AUTH_FILE });
    run?.own(context);
    await context.addInitScript(INIT_SCRIPT);
    await context.addInitScript(INPUT_SCRIPT);
    const page = await context.newPage();
    const origin = new URL(test.info().project.use.baseURL as string).origin;
    const cpu = await slowCpu(page, PHONE_CPU_SLOWDOWN);
    const startedAt = new Date().toISOString();
    const deployed = { start: await deployedSha(context, origin), end: null as string | null };
    const samples: InputSample[] = [];
    let stopped: string | null = null;
    const meta = (why: string | null): ResultMeta => ({
      slug: "phone-input", label: "Phone taps, 390 px", route: "/log", kind: "input", planned,
      note: "taps on the bottom bar and the More menu; read-only", navigations: PHONE_ROUNDS, startedAt,
      scenario: { ...SCENARIO.phoneInput, cpuSlowdown: cpu.applied }, deployed, windowMs: 0, windowRule: null, stopped: why,
    });
    // The tap in progress (deadline: it is recorded as interrupted, not measured, never a pass).
    let inFlight: { round: number; action: string } | null = null;
    run?.onInterrupt((deadlineMs) => {
      const rows: InputSample[] = inFlight == null
        ? [...samples]
        : [...samples, { i: samples.length, round: inFlight.round, action: inFlight.action, ok: false, error: stats.INTERRUPTED_ERROR }];
      writeResult(meta(stats.interruptedStop(deadlineMs, rows.length, planned, "taps")), browser.version(), rows);
    });
    try {
      // Log not loading leaves every tap untried: the report shows "0 of N taps were tried" and why, never a pass.
      const opened = await openAndWait(page, "/log", logReady);
      if (opened === "bounced") stopped = stats.observeOnlyStop(BOUNCED, 0, planned, "taps");
      else if (opened === "not-ready") stopped = `Log did not load or get ready: 0 of ${planned} taps tried`;
      rounds: for (let round = 0; opened === "ready" && round < PHONE_ROUNDS; round++) {
        let previousOk = true;
        for (const step of PHONE_STEPS) {
          if (run?.interrupted) break rounds;
          if (Date.now() - began >= PHONE_INPUT_BUDGET_MS) {
            stopped = `time budget of ${PHONE_INPUT_BUDGET_MS / 1000} s used up: ${samples.length} of ${planned} taps tried`;
            break rounds;
          }
          inFlight = { round, action: step.action };
          const s: InputSample = step.needsPrevious && !previousOk
            ? { i: samples.length, round, action: step.action, ok: false, error: "skipped: the step before was not measured" }
            : await measureTap(page, step, round, samples.length);
          samples.push(s);
          inFlight = null;
          previousOk = s.ok;
          if (!s.ok) {
            const back = step.leaveAt === "/log" ? logReady : todayReady;
            // Sent to the login page: no later tap can be measured, so stop and say why (not measured, not a pass).
            if ((await openAndWait(page, step.leaveAt, back)) === "bounced") {
              stopped = stats.observeOnlyStop(BOUNCED, samples.length, planned, "taps");
              break rounds;
            }
          }
          await page.waitForTimeout(TAP_PAUSE_MS);
        }
        // A first round with no tap measured means the taps themselves are broken: stop (the report shows the
        // untried taps as missing, never as fast).
        if (round === 0 && !samples.some((x) => x.ok)) break;
      }
    } catch (e) {
      // Observe-only: any other failure ends the taps and is recorded as not measured; the test does not fail on it (see
      // timePageSeries), so the run's exit code and the enforced speed-budget step depend on the desktop pages alone.
      if (SCENARIO.phoneInput.enforced) throw e;
      stopped = stats.observeOnlyStop(e, samples.length, planned, "taps");
    } finally {
      deployed.end = await deployedSha(context, origin);
      await context.close();
      // Written once: here, or by the deadline if that came first (its file then stands).
      const write = () => writeResult(meta(stopped), browser.version(), samples);
      if (run) run.writeOnce(write);
      else write();
    }
    if (run?.interrupted) return; // the deadline wrote the result file and the log line
    // Observed only: never fails the run. A tap that could not be measured is listed as missing in the report and in
    // the budget step's "observed only" lines, never counted as fast.
    console.log(`phone taps: ${samples.filter((s) => s.ok).length}/${planned} measured${stopped ? ` (${stopped})` : ""}`);
  });
});
