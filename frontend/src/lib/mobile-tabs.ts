/**
 * The phone's bottom tab bar: [tab, tab, Log, tab, More]. Log (the quick-log sheet) sits in the centre and
 * More (the drawer) is always last; the three other tabs are pages from lib/nav.ts. Each tab's label is the
 * name of the page it opens. Import-free (tests/mobile-tabs.test.cjs).
 */

/** Today, Agents and Chat (Onyx Chat, /chat) around Log; More is always the last tab. */
export const DEFAULT_MOBILE_TABS = ["/today", "/agents", "/chat"];
export const MOBILE_TAB_COUNT = 3;

// Short names for the bar (the nav label when it already fits).
const SHORT: Record<string, string> = {
  "/chat": "Chat",
  "/supplements": "Supplement",
  "/sleep": "Sleep",
  "/analytics/hrv": "HRV",
  "/analytics/travel": "Travel",
  "/bland-altman": "Bland-Alt",
  "/health": "Health",
  "/health/records": "Records",
  "/financials": "Financials",
  "/financials/budgets": "Budgets",
  "/financials/forecast": "Forecast",
  "/nyc": "NYC",
  "/screen-time": "Screen",
  "/procurement": "Procure",
};

export function tabLabel(item: { href: string; label: string }): string {
  return SHORT[item.href] ?? item.label;
}

/** Is this tab the current page? "/" is Today; a tab also owns its sub-pages (/agents?t=..., /chat/...). */
export function isTabActive(href: string, pathname: string): boolean {
  const path = pathname === "/" ? "/today" : pathname;
  if (path === href) return true;
  // A page with its own tab-able sub-page (Health -> Records) is not active on that sub-page.
  if (href === "/health" || href === "/financials") return false;
  return path.startsWith(href + "/");
}

/** The three page tabs: the saved choice (pages that exist, no repeats), filled from the defaults. */
export function mobileTabs(saved: string[] | undefined | null, exists: (href: string) => boolean): string[] {
  const out: string[] = [];
  for (const h of [...(saved ?? []), ...DEFAULT_MOBILE_TABS]) {
    if (out.length === MOBILE_TAB_COUNT) break;
    if (exists(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

/** "9+" past nine; nothing for zero. */
export function badgeText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n > 9 ? "9+" : String(Math.floor(n));
}
