/** Public, editorial highlights only. Never put health data or private task text here. */
export const highlights = [
  { pr: 15, title: "A calmer place to start", summary: "Bring requests, reading, and check-ins into one focused starting point.", area: "Everyday experience" },
  { pr: 12, title: "Navigation that gets out of your way", summary: "Close mobile navigation reliably and return keyboard focus where it belongs.", area: "Everyday experience" },
  { pr: 8, title: "A stronger safety net for changes", summary: "Require offline and type checks to help catch regressions before changes merge.", area: "Reliability" },
  { pr: 13, title: "Spotting importers that go quiet", summary: "Detect a stopped importer even when the data timeline freezes.", area: "Reliability" },
  { pr: 9, title: "Keeping keyboard selection in sight", summary: "Keep the selected command-palette result visible during keyboard navigation.", area: "Everyday experience" },
] as const;
export type WinState = "merged" | "review" | "draft" | "closed" | "unknown";
export type Win = (typeof highlights)[number] & { state: WinState; mergedAt: string | null };
export type Board = { wins: Win[]; checkedAt: string | null };
export const labels: Record<WinState, string> = { merged: "Merged", review: "In review", draft: "Draft", closed: "Closed, not merged", unknown: "Status unavailable" };

/** Validate untrusted remote metadata; missing/invalid rows must never become wins. */
export function makeBoard(input: unknown, checkedAt: string | null): Board {
  const rows = Array.isArray(input) ? input : [];
  return { checkedAt, wins: highlights.map((item) => {
    const row = rows.find((value) => value && typeof value === "object" && value.number === item.pr);
    let state: WinState = "unknown";
    let mergedAt: string | null = null;
    if (row && row.state === "closed" && typeof row.merged_at === "string" && Number.isFinite(Date.parse(row.merged_at))) {
      state = "merged"; mergedAt = new Date(row.merged_at).toISOString();
    } else if (row && row.merged_at === null && row.state === "closed") state = "closed";
    else if (row && row.merged_at === null && row.state === "open" && typeof row.draft === "boolean") state = row.draft ? "draft" : "review";
    return { ...item, state, mergedAt };
  }) };
}
