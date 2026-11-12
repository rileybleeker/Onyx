/**
 * Public, editorial highlights only. Never put health data or private task text here.
 *
 * `surface` says whether the change reaches the website:
 *  - "site": a website change. It can show as "Live on the site" once GitHub records a
 *    successful Vercel production deployment made after the merge.
 *  - "behind": tests, automation, database scripts, planning or the iPhone prototype.
 *    There is no website deployment to confirm, so it tops out at "Merged".
 * Wording describes the PR as written. The live stage always comes from GitHub, so a
 * draft or a proposal can never be shown as delivered by editing text here.
 */
export const highlights = [
  { pr: 27, surface: "behind", area: "Reliability", title: "Protecting the live database from test bursts", summary: "Queue the pull-request stats tests so only one runs against the database at a time.", benefit: "Pushing several changes at once should no longer pile test traffic onto the live database." },
  { pr: 26, surface: "behind", area: "iPhone", title: "A first step toward focus rules on iPhone", summary: "Add a disabled-by-default Focus rules prototype to the iPhone app, with policy tests and an unsigned build check. Groundwork only: nothing is installed and no apps are blocked yet.", benefit: "Lays the foundation for time-based app limits you set yourself, without changing the existing Screen Time export." },
  { pr: 25, surface: "behind", area: "Reliability", title: "Easing the load on the database", summary: "Refresh the two heaviest summary tables every 30 minutes instead of every 15, and loosen the matching Status thresholds. The database script is run separately and is not confirmed applied here.", benefit: "Aims to cut the disk strain behind the database stall; charts on those tables may lag by up to 30 minutes." },
  { pr: 18, surface: "behind", area: "Reliability", title: "Automated checks match the new start page", summary: "Update the sign-in smoke check to expect Today and fix a stale nutrition heading check.", benefit: "The post-login check tests what you actually see, so real breakage is easier to spot." },
  { pr: 17, surface: "behind", area: "Reliability", title: "Kindle import problems get reported", summary: "Detect HTTP errors, partial imports and startup failures in the Kindle reading importer.", benefit: "A broken reading import shows up as a failure instead of failing quietly." },
  { pr: 15, surface: "site", area: "Everyday experience", title: "A calmer place to start", summary: "Bring requests, reading, and check-ins into one focused starting point.", benefit: "Open Onyx and see what needs you first, with last-known data kept visible while it refreshes." },
  { pr: 12, surface: "site", area: "Everyday experience", title: "Navigation that gets out of your way", summary: "Close mobile navigation reliably and return keyboard focus where it belongs.", benefit: "Menus close when you expect, and keyboard users keep their place." },
  { pr: 11, surface: "site", area: "Everyday experience", title: "Delivery meals count in Nutrition", summary: "Show estimated figures from delivery orders on days with no food-log entries, labelled as estimates.", benefit: "Nutrition no longer looks empty on days you ate delivery and did not log it." },
  { pr: 8, surface: "behind", area: "Reliability", title: "A stronger safety net for changes", summary: "Require offline and type checks to help catch regressions before changes merge.", benefit: "Broken changes are far more likely to be caught before they reach the live site." },
  { pr: 24, surface: "site", area: "Everyday experience", title: "A broader Onyx Chat", summary: "Let Onyx Chat help with planning, writing and general questions while keeping its connected-data tools and being clear about what it cannot access.", benefit: "One assistant for everyday questions as well as health data, with honest limits." },
  { pr: 20, surface: "site", area: "Performance", title: "A lighter HRV analysis page", summary: "Batch the HRV analysis panels' data requests (17 down to 3 in synthetic tests) with identical results.", benefit: "The page should ask the database for far less. No page-speed gain is claimed yet." },
  { pr: 13, surface: "site", area: "Reliability", title: "Spotting importers that go quiet", summary: "Detect a stopped importer even when the data timeline freezes.", benefit: "A total import outage should no longer hide behind a green Status page." },
  { pr: 10, surface: "site", area: "Reliability", title: "Failed food imports look failed", summary: "Treat an error check-in from the food importers as a failure on the Status page.", benefit: "A failed import should no longer read as healthy." },
  { pr: 9, surface: "site", area: "Everyday experience", title: "Keeping keyboard selection in sight", summary: "Keep the selected command-palette result visible during keyboard navigation.", benefit: "Arrow keys never select a result you cannot see." },
  { pr: 22, surface: "behind", area: "Planning", title: "A plan for iPhone Messages, with nothing turned on", summary: "A documentation-only plan for a possible iPhone Messages integration. It adds no access, reads no messages and sends nothing.", benefit: "Lets the idea be reviewed, with its limits written down, before any access exists." },
] as const;
export type Surface = (typeof highlights)[number]["surface"];
/** Delivery stages, from furthest along to least. Each highlight is in exactly one. */
export type WinState = "deployed" | "merged" | "review" | "draft" | "closed" | "unknown";
export type Production = { sha: string; committedAt: string } | null;
export type Win = (typeof highlights)[number] & { state: WinState; mergedAt: string | null };
export type Board = { wins: Win[]; checkedAt: string | null };
export const stageOrder: readonly WinState[] = ["deployed", "merged", "review", "draft", "closed", "unknown"];
export const labels: Record<WinState, string> = { deployed: "Live on the site", merged: "Merged", review: "Proposed, in review", draft: "Draft", closed: "Closed, not merged", unknown: "Status unavailable" };
export const stageNotes: Record<WinState, string> = {
  deployed: "Merged, and GitHub records a successful production deployment made after the merge.",
  merged: "Merged into the main branch. Either there is no website deployment to confirm, or one could not be confirmed.",
  review: "Proposed changes waiting for review. Not merged.",
  draft: "Work in progress. Not merged.",
  closed: "Closed without being merged.",
  unknown: "GitHub status could not be verified, so these are not counted as delivered.",
};

/** Validate untrusted remote metadata; missing/invalid rows must never become wins. */
export function makeBoard(input: unknown, checkedAt: string | null, production: Production = null): Board {
  const rows = Array.isArray(input) ? input : [];
  const shippedAt = production ? Date.parse(production.committedAt) : NaN;
  return { checkedAt, wins: highlights.map((item) => {
    const row = rows.find((value) => value && typeof value === "object" && value.number === item.pr);
    let state: WinState = "unknown";
    let mergedAt: string | null = null;
    if (row && row.state === "closed" && typeof row.merged_at === "string" && Number.isFinite(Date.parse(row.merged_at))) {
      state = "merged"; mergedAt = new Date(row.merged_at).toISOString();
      // Live only for website changes, and only if the latest successful production deploy
      // is the merge commit itself or a later commit on the production branch.
      const live = production !== null && (row.merge_commit_sha === production.sha || Date.parse(mergedAt) <= shippedAt);
      if (item.surface === "site" && live) state = "deployed";
    } else if (row && row.merged_at === null && row.state === "closed") state = "closed";
    else if (row && row.merged_at === null && row.state === "open" && typeof row.draft === "boolean") state = row.draft ? "draft" : "review";
    return { ...item, state, mergedAt };
  }) };
}

/** Non-empty stage groups in delivery order, so each stage is shown apart from the rest. */
export function groupByStage(wins: readonly Win[]): { state: WinState; wins: Win[] }[] {
  return stageOrder.map((state) => ({ state, wins: wins.filter((win) => win.state === state) })).filter((group) => group.wins.length > 0);
}
