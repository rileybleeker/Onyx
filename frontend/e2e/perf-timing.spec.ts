import { test, expect, devices, type Page, type Request } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const stats = require("./perf-stats.cjs");

/**
 * Production timing run (.github/workflows/perf-timing.yml: hourly at :23 and on workflow_dispatch). It samples
 * whatever production serves at that moment; it is not tied to one deployment.
 *
 * For each key page: N full-document navigations in ONE browser context created
 * from the saved smoke-test login (auth.setup.ts). Navigation 1 starts with an
 * empty HTTP cache and is recorded as "cold" (browser cache; the Vercel function
 * and CDN state are not controllable). Navigations 2..N reuse the context's cache
 * and are the "warm" population the percentiles are computed from.
 *
 * Per navigation it records: TTFB, FCP, LCP, time to the page's data-ready
 * element, time to the first drawn chart mark, and every network request the page
 * made (class, path only, duration, transferred bytes) until the page has been
 * network-quiet for QUIET_MS. Query strings, headers, cookies and response bodies
 * are never recorded, so the JSON holds no credentials and no health data.
 *
 * A second test opens the app at / (Today), lets it settle (the idle warm-up included) and then CLICKS each page's
 * sidebar link in turn, timing click to data-ready: the in-app navigation Riley actually does, served from the client
 * cache. Its first round is the first visit of the session ("cold"), later rounds are warm. Written as
 * nav-<slug>.json, labelled "<route> (in-app)".
 *
 * This is NOT part of the smoke suite: playwright.config.ts only matches
 * smoke.spec.ts, and this file is run through e2e/perf.config.ts.
 */

const NAVIGATIONS = Math.max(2, Number(process.env.PERF_NAVIGATIONS || 15));
const PAUSE_MS = 1_000; // between navigations, so the run does not hammer production
const QUIET_MS = 1_500; // network must be idle this long after data-ready to close the window
const WINDOW_CAP_MS = 15_000; // never wait longer than this after data-ready
const READY_TIMEOUT_MS = 30_000;
// Mirror of AGENTS_API in src/lib/agents-api.ts (the sms-reminders Worker).
const AGENTS_HOST = "sms-reminders.rileybleeklm.workers.dev";

const AUTH_FILE = path.join(__dirname, ".auth/state.json");
const OUT_DIR = path.join(__dirname, "..", "perf-results");

// A drawn recharts data mark inside <main> (the sidebar sparkline lives in
// <aside>, and legend icons are excluded, so neither can fake "chart drawn").
const CHART = "main svg.recharts-surface path:not(.recharts-legend-icon)";

// Installed in every page before its scripts run: records the first frame in
// which a chart mark exists, on the page's own performance.now() clock. An in-app
// navigation restarts it with window.__pfWatchChart(); marks left over from the
// previous page (inside [data-pf-old]) never count.
const INIT_SCRIPT = `(() => {
  const SEL = ${JSON.stringify(CHART)};
  window.__pfWatchChart = () => {
    window.__pfChart = null;
    const tick = () => {
      if (window.__pfChart == null && [...document.querySelectorAll(SEL)].some((e) => !e.closest("[data-pf-old]"))) window.__pfChart = performance.now();
      if (window.__pfChart == null) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  window.__pfWatchChart();
})();`;

// The route content sits in AppShell's <main><div>; before an in-app click its children are marked old, and the new
// page counts as shown only once none of them is left (the old page's chart cannot satisfy the new page's check).
const ROUTE_CONTENT = "main > div > *";
const OLD_CONTENT = "main > div > [data-pf-old]";

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
const hasChart = `!!document.querySelector(${JSON.stringify(CHART)})`;
const h = (text: string, tag = "h1,h2,h3,h4,h5,h6") =>
  `[...document.querySelectorAll(${JSON.stringify(tag)})].some(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const leafText = (text: string) =>
  `[...document.querySelectorAll("p,div,span")].some(e => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(text)})`;

// Today's own panels (not the overview cards, which read only near the screen): every panel settled, none busy, and
// no "Checking..." left in the Also checked list (Codex review 2026-11-14: readiness covered only three panels).
const TODAY_PANELS = `[...document.querySelectorAll("main section:not([data-card])")]`;
const TODAY_PENDING = /checking\.\.\.|checking agent requests|checking email|checking your calendar|loading reading progress/i;
const todayReady = ready(
  `${h("Today", "h1")} && !${TODAY_PANELS}.some((e) => e.getAttribute("aria-busy") === "true" || ${TODAY_PENDING}.test(e.innerText))`
);
// Server-rendered finance pages: the real heading (the loading.tsx skeleton's has no test id) with no skeleton left.
const serverPageReady = ready(
  `!!document.querySelector('[data-testid="page-heading"]') && ![...document.querySelectorAll('p[role="status"]')].some((e) => /^Loading /.test(e.textContent))`
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
    ready: ready(`${h("Check-in", "h2")} && /Daytime: /.test(document.body.innerText)`),
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
    ready: ready(`(document.body.innerText.match(/last sync/gi) || []).length > 4`),
  },
  {
    slug: "caffeine",
    label: "/caffeine",
    route: "/caffeine",
    // The default 60-day window is empty during a caffeine logging pause; the empty state then IS the settled page.
    ready: ready(`${hasChart} || document.body.innerText.toLowerCase().includes("no caffeine days in the database yet.")`),
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
const IN_APP = ["/check-in", "/sleep", "/nutrition", "/supplements", "/analytics/hrv", "/caffeine", "/status", "/financials", "/financials/budgets", "/financials/forecast"];

interface Sample {
  i: number;
  cold: boolean;
  ok: boolean;
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
}

async function measureOnce(page: Page, spec: PageSpec, origin: string, i: number, mode: "load" | "click" = "load"): Promise<Sample> {
  const sample: Sample = { i, cold: i === 0, ok: false };
  if (mode === "load") await page.goto("about:blank");

  const records: Array<{
    cls: string;
    key: string;
    startMs: number;
    endMs?: number;
    durMs?: number;
    bytes: number;
    failed: boolean;
  }> = [];
  const open = new Map<Request, (typeof records)[number]>();
  const sizeJobs: Promise<void>[] = [];
  const t0 = Date.now();
  let lastActivity = t0;

  const onRequest = (req: Request) => {
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return;
    const { cls, key } = stats.classifyRequest(url, req.resourceType(), origin, AGENTS_HOST);
    const rec = { cls, key, startMs: Date.now() - t0, bytes: 0, failed: false };
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

  let clickedAt = 0; // page clock at the click (in-app mode); its timings are measured from it
  try {
    if (mode === "load") {
      const resp = await page.goto(spec.route, { waitUntil: "domcontentloaded", timeout: 45_000 });
      sample.status = resp ? resp.status() : null;
      const headers = resp ? resp.headers() : {};
      sample.cache = headers["x-vercel-cache"] ?? null;
      const vid = headers["x-vercel-id"];
      // "iad1::<request-id>" (CDN) or "iad1::iad1::<request-id>" (function ran): keep the regions only.
      sample.region = vid ? vid.split("::").slice(0, -1).join(">") : null;
    } else {
      const link = page.locator(`aside a[href="${spec.route}"]`).first();
      await link.scrollIntoViewIfNeeded({ timeout: 10_000 });
      clickedAt = await page.evaluate((sel) => {
        document.querySelectorAll(sel).forEach((e) => e.setAttribute("data-pf-old", ""));
        (window as unknown as { __pfWatchChart: () => void }).__pfWatchChart();
        return performance.now();
      }, ROUTE_CONTENT);
      await link.click({ timeout: 10_000 });
    }

    const finalPath = new URL(page.url()).pathname;
    if (/^\/login/.test(finalPath)) throw new Error("bounced-to-login: saved session is not valid");

    const readyExpr = mode === "load" ? spec.ready
      : `(location.pathname === ${JSON.stringify(spec.route)} && !document.querySelector(${JSON.stringify(OLD_CONTENT)})) ? ${spec.ready} : false`;
    try {
      const handle = await page.waitForFunction(readyExpr, undefined, {
        timeout: READY_TIMEOUT_MS,
        polling: "raf",
      });
      sample.ready = ((await handle.jsonValue()) as number) - clickedAt;
    } catch (e) {
      if ((e as Error).message.includes("bounced")) throw e;
      sample.error = "ready-timeout";
    }

    // Keep the window open until the page has been network-quiet (silent
    // revalidations and late chart fetches are part of the cost of a page view).
    const winStart = Date.now();
    for (;;) {
      if (open.size === 0 && Date.now() - lastActivity >= QUIET_MS) break;
      if (Date.now() - winStart >= WINDOW_CAP_MS) {
        sample.quietTimedOut = true;
        break;
      }
      await page.waitForTimeout(100);
    }
    await Promise.allSettled(sizeJobs);

    const m = await page.evaluate(
      async ({ emptyText }) => {
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
        return {
          ttfb: nav.responseStart,
          serverWait: nav.responseStart - nav.requestStart,
          dcl: nav.domContentLoadedEventEnd,
          load: nav.loadEventEnd,
          docBytes: nav.transferSize,
          fcp: fcpEntry ? fcpEntry.startTime : null,
          lcp,
          firstChart: (window as unknown as { __pfChart?: number }).__pfChart ?? null,
          degraded: /Application error|client-side exception/i.test(text),
          emptyState: emptyText ? text.toLowerCase().includes(emptyText.toLowerCase()) : false,
        };
      },
      { emptyText: spec.emptyText ?? "" }
    );
    if (mode === "click") {
      // The document was loaded before the click: its TTFB / FCP / LCP belong to Today, not to this page.
      Object.assign(sample, { degraded: m.degraded, emptyState: m.emptyState, firstChart: m.firstChart == null ? null : m.firstChart - clickedAt });
    } else {
      Object.assign(sample, m);
    }

    const folded = stats.foldRequests(records);
    sample.req = folded.req;
    sample.total = folded.total;
    sample.endpoints = folded.endpoints;
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

for (const spec of PAGES) {
  test(`timing ${spec.label}`, async ({ browser }) => {
    test.setTimeout(NAVIGATIONS * (READY_TIMEOUT_MS + WINDOW_CAP_MS + PAUSE_MS + 5_000) + 60_000);

    // Fresh context per page => navigation 1 really has an empty HTTP cache.
    const context = await browser.newContext({
      ...devices["Desktop Chrome"],
      storageState: AUTH_FILE,
    });
    await context.addInitScript(INIT_SCRIPT);
    const page = await context.newPage();
    const origin = new URL(test.info().project.use.baseURL as string).origin;

    const samples: Sample[] = [];
    const startedAt = new Date().toISOString();
    try {
      for (let i = 0; i < NAVIGATIONS; i++) {
        const s = await measureOnce(page, spec, origin, i);
        samples.push(s);
        // Two navigations in a row that never reach data-ready mean the page (or this
        // script's selector for it) is broken: stop instead of burning 30 s per navigation.
        if (i >= 1 && samples.every((x) => !x.ok)) break;
        if (i < NAVIGATIONS - 1) await page.waitForTimeout(PAUSE_MS);
      }
    } finally {
      await context.close();
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const payload = {
        meta: {
          slug: spec.slug,
          label: spec.label,
          route: spec.route,
          note: spec.note ?? null,
          navigations: NAVIGATIONS,
          startedAt,
          finishedAt: new Date().toISOString(),
          quietMs: QUIET_MS,
          windowCapMs: WINDOW_CAP_MS,
          github: {
            runId: process.env.GITHUB_RUN_ID ?? null,
            runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
            sha: process.env.GITHUB_SHA ?? null,
            ref: process.env.GITHUB_REF_NAME ?? null,
          },
          runner: {
            platform: process.platform,
            cpus: os.cpus().length,
            memGB: Math.round(os.totalmem() / 2 ** 30),
            chromium: browser.version(),
          },
        },
        samples,
      };
      fs.writeFileSync(path.join(OUT_DIR, `${spec.slug}.json`), JSON.stringify(payload, null, 1));
    }

    const okCount = samples.filter((s) => s.ok).length;
    console.log(`${spec.label}: ${okCount}/${samples.length} navigations reached data-ready`);
    // A page that never reached data-ready in ANY navigation is a failed measurement, not a slow one.
    // (A page that reached it only sometimes is caught by the speed budget: every missing navigation is a breach.)
    expect(okCount, `${spec.label} never reached its data-ready state`).toBeGreaterThan(0);
  });
}

function writeResult(slug: string, label: string, route: string, note: string | null, navigations: number, startedAt: string, browserVersion: string, samples: Sample[]) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    meta: {
      slug, label, route, note, navigations, startedAt,
      finishedAt: new Date().toISOString(),
      quietMs: QUIET_MS,
      windowCapMs: WINDOW_CAP_MS,
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
  fs.writeFileSync(path.join(OUT_DIR, `${slug}.json`), JSON.stringify(payload, null, 1));
}

// In-app navigation: open the app, let Today and the idle warm-up settle, then click through the sidebar.
const ROUNDS = Math.min(4, NAVIGATIONS);
test("timing in-app navigation from Today", async ({ browser }) => {
  test.setTimeout((ROUNDS * IN_APP.length + 1) * (READY_TIMEOUT_MS + WINDOW_CAP_MS + PAUSE_MS + 15_000) + 60_000);
  const context = await browser.newContext({ ...devices["Desktop Chrome"], storageState: AUTH_FILE });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  const startedAt = new Date().toISOString();
  const specs = IN_APP.map((route) => PAGES.find((p) => p.route === route)).filter((p): p is PageSpec => !!p);
  const byRoute = new Map<string, Sample[]>(specs.map((p) => [p.route, []]));
  try {
    const opened = await measureOnce(page, PAGES.find((p) => p.slug === "today")!, origin, 0, "load");
    expect(opened.ok, "Today did not load, so no in-app navigation could be timed").toBe(true);
    for (let round = 0; round < ROUNDS; round++) {
      for (const spec of specs) {
        byRoute.get(spec.route)!.push(await measureOnce(page, spec, origin, round, "click"));
        await page.waitForTimeout(PAUSE_MS);
      }
      // A first round with no page reaching data-ready means the clicking itself is broken: stop (the missing rounds
      // are reported as incomplete pages by the speed budget) instead of burning 45 s per click.
      if (round === 0 && ![...byRoute.values()].some((xs) => xs[0]?.ok)) break;
    }
  } finally {
    await context.close();
    for (const spec of specs) {
      writeResult(`nav-${spec.slug}`, `${spec.route} (in-app)`, spec.route,
        "clicked from the sidebar after Today settled; the first round is the first visit of the session",
        ROUNDS, startedAt, browser.version(), byRoute.get(spec.route)!);
    }
  }
  const ok = [...byRoute.values()].flat().filter((s) => s.ok).length;
  console.log(`in-app: ${ok}/${ROUNDS * specs.length} navigations reached data-ready`);
  expect(ok, "no in-app navigation reached its data-ready state").toBeGreaterThan(0);
});
