import { test, expect, type Page } from "@playwright/test";

/**
 * Production smoke-test tripwire.
 *
 * This audit cycle shipped three regressions that `tsc` + `lint` waved through
 * and that only surfaced when Riley clicked around production — each one a panel
 * that should have had data silently rendering its empty-state fallback:
 *   - Spotify FK ordering        → empty Spotify panels
 *   - HRV charts JSON.parse(jsonb)→ empty HRV correlation charts
 *   - supplements renamed columns → empty "Today's compound totals"
 *
 * The precise tripwire these tests encode: **an empty-state fallback string
 * visible where data should exist = test failure.** Where a page has no
 * empty-state string, we fall back to "a real data element rendered and the
 * page didn't crash / bounce to /login".
 *
 * Auth is handled once in auth.setup.ts (the `setup` project) and reused via
 * storageState — see playwright.config.ts.
 */

// Recharts draws one <path> per data mark inside svg.recharts-surface (bars =
// .recharts-rectangle, line/area = .recharts-curve, scatter = .recharts-symbols,
// pie = .recharts-sector, ...). Axes/grid are <line>/<text>, so counting paths
// is a robust "this chart actually drew data" signal that survives selector
// churn — an empty chart renders the surface + axes but no data paths.
const RECHARTS_SVG = "svg.recharts-surface";
const RECHARTS_MARKS = "svg.recharts-surface path";

// Production cold-loads (Vercel function spin-up + Supabase round-trips) can run
// well past 15s, which was the original source of flakiness — assertions raced
// the data fetch. Give them room.
const LOAD_TIMEOUT = 30_000;

/**
 * Best-effort "data settled" wait. Client data fetches (Supabase queries fired
 * in useEffect) are normal network requests, so once they go quiet the page has
 * rendered its final state (data OR empty) and the assertions are deterministic
 * instead of racing the load. /status polls every 60s and never reaches
 * networkidle, so we swallow the timeout and fall through to the positive
 * assertion — never hang.
 */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

/**
 * Next.js' production client-side error boundary. If a page throws during
 * render (the class of bug the supplements rename would have been, had it
 * thrown rather than silently emptied), the user sees this banner instead of
 * the dashboard. Must never be present.
 */
async function expectNoClientCrash(page: Page) {
  await expect(
    page.getByText(/application error/i),
    "Next.js client-side error boundary is showing"
  ).toHaveCount(0);
  await expect(
    page.getByText(/client-side exception/i),
    "Next.js client-side exception banner is showing"
  ).toHaveCount(0);
}

/**
 * Navigate and assert we landed on a real, authenticated page: not a 4xx/5xx,
 * and not bounced to /login by middleware (which is how an invalid/expired
 * session manifests). `expectFinalUrl` is for routes that redirect server-side
 * (e.g. /eight-sleep → /sleep).
 */
async function gotoAuthed(page: Page, pathname: string, expectFinalUrl?: RegExp) {
  const resp = await page.goto(pathname, { waitUntil: "domcontentloaded" });
  expect(resp, `no HTTP response for ${pathname}`).toBeTruthy();
  expect(
    resp!.status(),
    `HTTP ${resp!.status()} for ${pathname}`
  ).toBeLessThan(400);
  await expect(
    page,
    `${pathname} bounced to /login — session not valid`
  ).not.toHaveURL(/\/login(\?|$)/);
  if (expectFinalUrl) await expect(page).toHaveURL(expectFinalUrl);
}

// ---------------------------------------------------------------------------
// High-value targets: the two pages whose regressions actually shipped.
// ---------------------------------------------------------------------------

test.describe("HRV analytics — JSONB-parse regression tripwire", () => {
  test("HRV Correlates renders bars; no 'not computed' fallbacks", async ({
    page,
  }) => {
    await gotoAuthed(page, "/analytics/hrv");
    await settle(page);

    // The page returns ONLY a skeleton while loading; the heading appears once
    // the fetch resolves, so waiting for it gates "load complete".
    await expect(
      page.getByRole("heading", { name: "HRV Deep Analysis" })
    ).toBeVisible({ timeout: LOAD_TIMEOUT });

    // The HRV Correlates (Historical) chart must actually draw bars. The
    // jsonb-double-parse bug left correlations=[] → the empty branch rendered
    // instead of this chart.
    const correlatesCard = page
      .locator("div.bg-surface-card")
      .filter({
        has: page.getByRole("heading", { name: "HRV Correlates (Historical)" }),
      });
    await expect(correlatesCard).toBeVisible();
    const bars = correlatesCard.locator(RECHARTS_MARKS);
    await expect(
      bars.first(),
      "HRV Correlates chart drew no bars"
    ).toBeVisible({ timeout: LOAD_TIMEOUT });
    expect(
      await bars.count(),
      "HRV Correlates chart drew no bars"
    ).toBeGreaterThan(0);

    // Precise tripwire strings — present only when the correlation / journal /
    // habit result_json failed to load or parse.
    for (const fallback of [
      "Run hrv_analysis.py to compute correlations",
      "Journal behavior correlations not yet computed",
      "Habit correlations not yet computed",
    ]) {
      await expect(
        page.getByText(fallback),
        `HRV empty-state present: "${fallback}"`
      ).toHaveCount(0);
    }

    await expectNoClientCrash(page);
  });
});

test.describe("Supplements — renamed-view-column regression tripwire", () => {
  test("compound totals table is populated when intakes exist today", async ({
    page,
    request,
  }) => {
    // Gate on the SAME endpoint the page renders from, so we never false-fail
    // on a legitimately empty day. page.request shares the auth cookies.
    const res = await request.get("/api/supplements/today");
    expect(
      res.ok(),
      `/api/supplements/today returned ${res.status()}`
    ).toBeTruthy();
    const body = await res.json();
    const compounds: unknown[] = body.compounds ?? [];

    test.skip(
      compounds.length === 0,
      "No supplement intakes logged today — nothing to assert."
    );

    await gotoAuthed(page, "/supplements");
    await settle(page);
    await expect(
      page.getByRole("heading", { name: "Supplements", exact: true })
    ).toBeVisible({ timeout: LOAD_TIMEOUT });

    const totalsCard = page
      .locator("div.bg-surface-card")
      .filter({
        has: page.getByRole("heading", { name: "Today's compound totals" }),
      });
    await expect(totalsCard).toBeVisible();

    // Data exists (API said so) → the empty-state must be gone...
    await expect(
      totalsCard.getByText("No intakes logged today yet."),
      "compound totals shows empty-state despite today's intakes existing"
    ).toHaveCount(0);
    // ...and the rollup table must have rows (one per compound from the API).
    const rows = totalsCard.locator("table tbody tr");
    await expect(
      rows.first(),
      "compound totals table rendered no rows"
    ).toBeVisible({ timeout: LOAD_TIMEOUT });
    expect(
      await rows.count(),
      "compound totals row count does not match /api/supplements/today"
    ).toBe(compounds.length);

    await expectNoClientCrash(page);
  });
});

// ---------------------------------------------------------------------------
// Every other page: render without crashing / bouncing, show a real data
// element, and have no "data should be here but isn't" empty-state visible.
//
// hardEmpty = empty-state strings that mean a genuine break for an active user
// (assert ABSENT). Strings that can be legitimately empty (manual-entry
// sections, ReccoBeats-coverage-thin subsets, range-windowed lists) are
// intentionally NOT asserted to avoid false failures — noted inline.
// ---------------------------------------------------------------------------

type Signal = "charts" | "status-cards" | "journal-list";

interface SmokePage {
  route: string;
  heading: string; // stable text rendered on the page (load/shell gate)
  signal: Signal; // how we prove real data rendered
  hardEmpty: string[];
  finalUrl?: RegExp; // for server-side redirects
}

const PAGES: SmokePage[] = [
  { route: "/sleep", heading: "Sleep & Recovery", signal: "charts", hardEmpty: [] },
  // /eight-sleep is a server redirect to /sleep — verify the redirect + content.
  {
    route: "/eight-sleep",
    finalUrl: /\/sleep(\?|$)/,
    heading: "Sleep & Recovery",
    signal: "charts",
    hardEmpty: [],
  },
  { route: "/heart", heading: "Heart & HRV", signal: "charts", hardEmpty: [] },
  { route: "/whoop", heading: "WHOOP", signal: "charts", hardEmpty: [] },
  {
    route: "/activities",
    heading: "Activities",
    signal: "charts",
    // The activities-list empty-state renders "No activities found" AND "No
    // activities recorded in this range." together whenever the SELECTED range
    // has no rows (page.tsx:536) — it's range-dependent, not all-data-empty, so
    // a quiet week legitimately trips it. Not a hard fail. The training-load /
    // stress charts (from daily summaries, always present) are the real
    // data-present tripwire for this page.
    hardEmpty: [],
  },
  {
    route: "/nutrition",
    heading: "Nutrition / Meal Timing",
    signal: "charts",
    // Meal-timing + body-weight are manual-entry sections that can be
    // legitimately empty; the MFP macro charts are the data-present signal.
    hardEmpty: [],
  },
  {
    route: "/spotify",
    heading: "Spotify",
    signal: "charts",
    // "No featurized plays…" / "No plays in this range." can be legitimately
    // empty (ReccoBeats coverage gap; range windowing) — see CLAUDE.md Spotify
    // coverage notes. The page-level + top-list emptiness are hard fails.
    hardEmpty: [
      "No Spotify plays in the database yet.",
      "No artists yet.",
      "No tracks yet.",
      "No genres yet.",
    ],
  },
  {
    route: "/bland-altman",
    heading: "Bland-Altman Analysis",
    signal: "charts",
    hardEmpty: ["No data available. Make sure your ETL pipelines have synced data."],
  },
  {
    route: "/habits",
    heading: "Habits",
    signal: "charts",
    hardEmpty: ["No active habits found."],
  },
  { route: "/status", heading: "System Status", signal: "status-cards", hardEmpty: [] },
  {
    route: "/journal",
    heading: "Journal",
    signal: "journal-list",
    hardEmpty: ["No entries match these filters.", "Error:"],
  },
];

async function assertDataPresent(page: Page, signal: Signal) {
  if (signal === "charts") {
    await expect(
      page.locator(RECHARTS_SVG).first(),
      "no recharts chart rendered"
    ).toBeVisible({ timeout: LOAD_TIMEOUT });
    expect(
      await page.locator(RECHARTS_MARKS).count(),
      "charts rendered but drew no data marks"
    ).toBeGreaterThan(0);
  } else if (signal === "status-cards") {
    // Each SourceCard renders a "Last Sync" detail row; if /api/status fails,
    // data is null and no cards render.
    const lastSync = page.getByText("Last Sync");
    await expect(
      lastSync.first(),
      "no source cards rendered (/api/status likely failed)"
    ).toBeVisible({ timeout: LOAD_TIMEOUT });
    expect(
      await lastSync.count(),
      "too few source cards rendered"
    ).toBeGreaterThan(4);
  } else {
    // journal — one <li> per entry under ul.space-y-2.
    const items = page.locator("ul.space-y-2 > li");
    await expect(
      items.first(),
      "no journal entries rendered"
    ).toBeVisible({ timeout: LOAD_TIMEOUT });
    expect(await items.count(), "journal list is empty").toBeGreaterThan(0);
  }
}

for (const p of PAGES) {
  test(`${p.route} renders with data and no broken panels`, async ({ page }) => {
    await gotoAuthed(page, p.route, p.finalUrl);
    await settle(page);
    await expect(
      page.getByText(p.heading, { exact: true }).first(),
      `${p.route} did not render its "${p.heading}" heading`
    ).toBeVisible({ timeout: LOAD_TIMEOUT });

    await assertDataPresent(page, p.signal);

    for (const s of p.hardEmpty) {
      await expect(
        page.getByText(s),
        `empty-state present on ${p.route}: "${s}"`
      ).toHaveCount(0);
    }

    await expectNoClientCrash(page);
  });
}
