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

    // Stage 4 (Direction A): the Tomorrow's-HRV hero KpiTile must render.
    // data-testid (not class/color) so it survives further restyles.
    await expect(
      page.getByTestId("hero-tomorrow-hrv"),
      "Tomorrow's HRV hero tile did not render"
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

test.describe("Nutrition — Cronometer migration tripwire", () => {
  test("macros charts draw + Vitamins & Minerals panel renders", async ({ page }) => {
    await gotoAuthed(page, "/nutrition");
    await settle(page);

    await expect(
      page.getByRole("heading", { name: "Nutrition" })
    ).toBeVisible({ timeout: LOAD_TIMEOUT });

    // The macros block is now Cronometer-sourced (MFP fills pre-cutover history).
    // Its charts are the data-present signal — they must draw marks from the
    // COALESCE'd nutrition_* columns. A broken nutrition query empties them.
    const marks = page.locator(RECHARTS_MARKS);
    await expect(
      marks.first(),
      "Nutrition charts drew nothing"
    ).toBeVisible({ timeout: LOAD_TIMEOUT });
    expect(
      await marks.count(),
      "Nutrition charts drew no marks"
    ).toBeGreaterThan(0);

    // New Cronometer panels must render (catches a silently-broken nutrition_* /
    // micronutrient query). Section headings are structural — present even on a
    // thin day — so this won't false-fail when micronutrient coverage is sparse.
    await expect(
      page.getByText("Daily Macros", { exact: true }),
      "Cronometer macros section missing"
    ).toBeVisible();
    await expect(
      page.getByText("Vitamins & Minerals"),
      "Vitamins & Minerals panel missing"
    ).toBeVisible();

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

type Signal = "charts" | "status-cards" | "journal-list" | "page-loads";

interface SmokePage {
  route: string;
  heading: string; // stable text rendered on the page (load/shell gate)
  signal: Signal; // how we prove real data rendered
  hardEmpty: string[];
  // The page's own "nothing in the window" empty-state. If it is visible the
  // page is working but the user has not logged anything lately (manual-entry
  // sources) — SKIP with a reason rather than fail. Checked before the
  // data-present probe because the shared Sidebar sparkline is also a recharts
  // svg, so "charts" would otherwise fail with "no data marks" (2026-10-17).
  legitimateEmpty?: string;
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
    heading: "Nutrition",
    signal: "charts",
    // Meal-timing + body-weight are manual-entry sections that can be
    // legitimately empty; the Cronometer macro charts (COALESCE'd over MFP
    // history) are the data-present signal. Vitamins panel asserted separately.
    hardEmpty: [],
  },
  {
    route: "/caffeine",
    heading: "Caffeine",
    signal: "charts",
    // Caffeine comes only from manual logging (Cronometer food / supplement
    // intakes). The page windows 60 days, so a logging pause legitimately
    // empties it — skip, don't fail. The HRV scatter / window chart can be
    // thin (trusted-timestamp coverage) — not hard-asserted.
    hardEmpty: [],
    legitimateEmpty: "No caffeine days in the database yet.",
  },
  {
    route: "/reading",
    heading: "Reading",
    signal: "charts",
    // The burn-up chart always draws the pace line from books.start/target_date,
    // so a fresh book with zero sessions still has data marks. The session and
    // highlight lists are write-coupled and legitimately empty.
    hardEmpty: [],
  },
  {
    route: "/spotify",
    heading: "Spotify",
    signal: "charts",
    // "No featurized plays…" / "No plays in this range." can be legitimately
    // empty (ReccoBeats coverage gap; range windowing) — see AGENTS.md Spotify
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
    // Finance ledger (2026-11-12): a private server-rendered page over pds.finance_*. CI may run
    // against an empty ledger, so this is a page-loads check only: it must render behind the
    // login and must not show the query-failure state, but the honest empty state is allowed and
    // SKIPS (like /caffeine) rather than fails. It never asserts on any amount or name.
    route: "/financials",
    heading: "Financials",
    signal: "page-loads",
    hardEmpty: ["Couldn't load the ledger."],
    legitimateEmpty: "No ledger data yet - the harvester has not run.",
  },
  {
    route: "/journal",
    heading: "Journal",
    signal: "journal-list",
    hardEmpty: ["No entries match these filters.", "Error:"],
  },
];

async function assertDataPresent(page: Page, signal: Signal) {
  if (signal === "page-loads") return;
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

    if (p.legitimateEmpty) {
      const visible = await page
        .getByText(p.legitimateEmpty, { exact: true })
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) {
        await expectNoClientCrash(page);
        test.skip(
          true,
          `${p.route} shows its no-recent-data state ("${p.legitimateEmpty}") — page renders, nothing logged in-window.`
        );
      }
    }

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

// ---------------------------------------------------------------------------
// /caffeine with REAL rows: the default 60-day window is legitimately empty
// during a logging pause (the PAGES entry above skips), so this widens the
// window via the page's `?days=` override to a range that holds the recorded
// May–July 2026 caffeine days and asserts the intake chart actually draws.
// Verifies rendering against real data without fabricating any. If this ever
// skips too, there is no quantitative caffeine data in ~2 years — investigate.
// ---------------------------------------------------------------------------
test.describe("Caffeine — renders real historical rows", () => {
  test("/caffeine?days=720 draws intake bars and shows no empty-state", async ({ page }) => {
    await gotoAuthed(page, "/caffeine?days=720", /\/caffeine\?days=720/);
    await settle(page);
    await expect(
      page.getByText("Caffeine", { exact: true }).first()
    ).toBeVisible({ timeout: LOAD_TIMEOUT });

    // Wait for the non-silent fetch to land (the ISR seed is discarded for a
    // non-default window, so the page goes skeleton → data).
    await expect(
      page.getByText("No caffeine days in the database yet."),
      "no caffeine rows in a 720-day window"
    ).toHaveCount(0, { timeout: LOAD_TIMEOUT });
    await expect(
      page.getByText("last 720 days").first(),
      "window override did not apply"
    ).toBeVisible({ timeout: LOAD_TIMEOUT });

    const mgChart = page
      .locator("div.bg-surface-card")
      .filter({ has: page.getByText("Daily Caffeine Intake", { exact: false }) })
      .first();
    await expect(mgChart.locator(RECHARTS_SVG).first(), "intake chart did not render")
      .toBeVisible({ timeout: LOAD_TIMEOUT });
    expect(
      await mgChart.locator(RECHARTS_MARKS).count(),
      "intake chart drew no bars"
    ).toBeGreaterThan(0);

    await expectNoClientCrash(page);
  });
});

// ---------------------------------------------------------------------------
// Shared chrome (Stage 3): the mobile bottom tab bar must mount on a phone-sized
// viewport (primary nav surface) and stay hidden on desktop (where the Sidebar
// is primary). Targets data-testid, not classes/colors, so it survives restyles.
// ---------------------------------------------------------------------------
test.describe("Mobile chrome — bottom tab bar", () => {
  test("present on a phone viewport, hidden on desktop", async ({ page }) => {
    // iPhone 14-ish portrait — below Tailwind's md breakpoint (768px).
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoAuthed(page, "/sleep");
    await settle(page);

    const tabBar = page.getByTestId("mobile-tab-bar");
    await expect(
      tabBar,
      "bottom tab bar not visible on a mobile viewport"
    ).toBeVisible({ timeout: LOAD_TIMEOUT });
    // The five primary tabs.
    for (const label of ["Today", "Trends", "Log", "Chat", "More"]) {
      await expect(
        tabBar.getByText(label, { exact: true }),
        `tab "${label}" missing from the bottom tab bar`
      ).toBeVisible();
    }

    // On a desktop viewport the same element is display:none (md:hidden).
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(
      page.getByTestId("mobile-tab-bar"),
      "bottom tab bar should be hidden on desktop"
    ).toBeHidden();

    await expectNoClientCrash(page);
  });
});

// ---------------------------------------------------------------------------
// /nyc — the apartment search (2026-11-07). Data comes from the Notion "NYC
// Leads" database, not Supabase, so the generic recharts probe doesn't apply.
// A broken Notion share/key surfaces as the "Couldn't load leads" banner; an
// empty database as the "No leads yet" state — both are failures while the
// search is running. The default "Active" view can legitimately be empty
// (everything gone or passed), so the row check uses "All incl. gone".
// ---------------------------------------------------------------------------
test.describe("/nyc apartment search", () => {
  test("loads leads from Notion and plots them on the map", async ({ page }) => {
    await gotoAuthed(page, "/nyc");
    await settle(page);
    await expect(page.getByText("NYC Apartment Search", { exact: true }).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(page.getByText("Couldn't load leads", { exact: false }), "Notion read failed on /nyc").toHaveCount(0);
    await expect(page.getByText("No leads yet. nyc-scout fills this every morning."), "NYC Leads database is empty").toHaveCount(0);

    await page.getByRole("button", { name: "All incl. gone" }).click();
    await expect(page.locator('[data-testid="nyc-leads-table"] tbody tr').first()).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(page.locator(".leaflet-interactive").first(), "no lead markers on the map").toBeAttached({ timeout: LOAD_TIMEOUT });
    await expectNoClientCrash(page);
  });
});

// ---------------------------------------------------------------------------
// /check-in (2026-11-07): the daily habit check-in must load today's questions
// from Notion + Supabase. A Notion/API failure renders "Couldn't load…" with no
// question rows. Read-only: never taps or saves.
// ---------------------------------------------------------------------------
test("/check-in lists today's habit questions", async ({ page }) => {
  await gotoAuthed(page, "/check-in");
  await settle(page);
  await expect(page.getByText("Check-in", { exact: true }).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText(/Couldn't load|Couldn't reach Onyx/)).toHaveCount(0);
  const yesButtons = page.getByRole("button", { name: /: yes$/ });
  await expect(yesButtons.first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  expect(await yesButtons.count(), "expected the core check-in questions").toBeGreaterThanOrEqual(10);
  await expectNoClientCrash(page);
});

// Today is a read-only entry point. A legitimate empty inbox/book is allowed;
// unavailable data must be visible, never mistaken for an all-clear.
test.describe("Today home", () => {
  test("home opens Today and its independent sections settle", async ({ page }) => {
    await gotoAuthed(page, "/", /\/today$/);
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expect(page.getByText("Checking agent requests...")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
    await expect(page.getByText("Loading reading progress...")).toHaveCount(0, { timeout: LOAD_TIMEOUT });
    await expect(page.getByText("Couldn't check requests.", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Reading progress is unavailable right now.")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open check-in", exact: true })).toHaveAttribute("href", "/check-in");
    await expect(page.getByRole("link", { name: "System status", exact: true })).toHaveAttribute("href", "/status");
    await expectNoClientCrash(page);
  });
});

// /procurement (2026-11-11): planning workspace only. It holds no data of its own
// and talks to no merchant, so the tripwire is: the page renders behind the login,
// says it is disconnected, and the order button is still disabled. Read-only:
// never types into a form, never adds a draft.
test("/procurement renders as a disconnected planning page with ordering disabled", async ({ page }) => {
  await gotoAuthed(page, "/procurement");
  await expect(page.getByRole("heading", { name: "Procurement", exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("heading", { name: "Disconnected preview", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Track subscriptions", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Place order (unavailable)", exact: true })).toBeDisabled();
  await expectNoClientCrash(page);
});

// /wins (2026-11-11, PR #19): the Wins board reads public GitHub PR data. It holds no
// production data of its own and renders (with an "unverified" note) even when GitHub is
// unreachable, so the tripwire is: behind the login, heading + board landmarks render and
// the error boundary is absent. Never asserts on card counts or any PR title.
test("/wins renders the Wins board", async ({ page }) => {
  await gotoAuthed(page, "/wins");
  await expect(page.getByRole("heading", { name: "Worth celebrating", exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("region", { name: "Progress board", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Filter progress", exact: true })).toBeVisible();
  await expectNoClientCrash(page);
});

// /health (2026-11-11, PR #30): local-only care/appointments planner. Items live in the
// browser, sample data is opt-in, and the Google Calendar card is a read-only "not connected"
// stub. Tripwire: the planner finishes loading, sample data is NOT on by default, and the
// calendar connect button is still disabled. Read-only: never types, adds or toggles anything.
test("/health renders the care planner with sample data off and calendar disconnected", async ({ page }) => {
  await gotoAuthed(page, "/health");
  await expect(page.getByRole("heading", { name: "Health & appointments", exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("heading", { name: "Private planning, on this browser", exact: true })).toBeVisible();
  await expect(page.getByText(/Loading local planner/)).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("heading", { name: "Add care item", exact: true })).toBeVisible();
  await expect(page.getByLabel(/Show sample data/), "sample data must be opt-in").not.toBeChecked();
  await expect(page.getByRole("button", { name: /^Connect Google Calendar$/ })).toBeDisabled();
  await expectNoClientCrash(page);
});

// /orders (2026-11-12, PR #95): online orders tracked from shipping/delivery emails. Tripwire:
// behind the login, heading renders, and neither the load-error nor the never-synced state shows.
// "Nothing on the way right now." and an empty Needs attention section are legitimate, so they are
// not asserted. Asserts on page text only, never on store names or items.
test("/orders renders without the load-error or never-synced state", async ({ page }) => {
  await gotoAuthed(page, "/orders");
  await settle(page);
  await expect(page.getByRole("heading", { name: "Orders", exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByText("Couldn't load orders. Try again in a minute."), "orders failed to load").toHaveCount(0);
  await expect(page.getByText("The order email sync hasn't run yet."), "order email sync has never run").toHaveCount(0);
  await expectNoClientCrash(page);
});

// /financials keeps PR #28's browser-only CSV preview as a secondary tool behind a "Preview a CSV"
// disclosure (the page itself now reads the saved ledger; see the /financials entry in PAGES).
// Read-only: opens the disclosure, never chooses a file.
test("/financials keeps the CSV preview tool behind its disclosure", async ({ page }) => {
  await gotoAuthed(page, "/financials");
  await expect(page.getByRole("heading", { name: "Financials", exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  const summary = page.getByText("Preview a CSV", { exact: true });
  await expect(summary).toBeVisible();
  await summary.click();
  await expect(page.getByLabel(/Choose transaction CSV/)).toBeAttached();
  await expect(page.getByRole("heading", { name: "Your overview starts with your export", exact: true })).toBeVisible();
  await expect(page.locator("details").getByRole("alert"), "unexpected import error on a fresh load").toHaveCount(0);
  await expectNoClientCrash(page);
});
