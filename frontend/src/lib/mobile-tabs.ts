/**
 * The phone's bottom tab bar: [slot, slot, Log, slot, slot]. Log (the Log screen, /log) sits in the centre; the four
 * slots around it are pages from lib/nav.ts or More (the drawer), by default Today, Agents | Log | Chat, More, and
 * Riley can choose them in Personalize (phone drawer). Each tab's label is the name of the page it opens.
 * Import-free (tests/mobile-tabs.test.cjs).
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

// ---- the four slots around Log (Personalize, phone drawer; saved in layout.areas, grids.tabs) ------------------

/** The More menu (the drawer) as a slot value; same text as MORE_TAB in lib/nav-areas.ts. */
export const MORE_SLOT = "more";
export const TAB_SLOT_COUNT = 4;
/** [slot 1, slot 2] Log [slot 3, slot 4]: Today, Agents | Log | Chat, More. */
export const DEFAULT_TAB_SLOTS: readonly string[] = [...DEFAULT_MOBILE_TABS, MORE_SLOT];

/**
 * The four slots: the saved choice per slot (a page that exists or More, no repeats), an empty or invalid slot
 * filled with its default, else the first default not used yet.
 */
export function tabSlots(saved: readonly (string | null | undefined)[] | null | undefined, exists: (href: string) => boolean): string[] {
  const ok = (h: unknown): h is string => typeof h === "string" && (h === MORE_SLOT || exists(h));
  const out: (string | null)[] = [];
  for (let i = 0; i < TAB_SLOT_COUNT; i++) {
    const h = saved?.[i];
    out.push(ok(h) && !out.includes(h) ? h : null);
  }
  for (let i = 0; i < TAB_SLOT_COUNT; i++) {
    if (out[i] !== null) continue;
    const d = DEFAULT_TAB_SLOTS[i];
    out[i] = ok(d) && !out.includes(d) ? d : DEFAULT_TAB_SLOTS.find((x) => ok(x) && !out.includes(x)) ?? null;
  }
  return out.filter((x): x is string => x !== null);
}

/** `value` put in `slot`; when it already sits in another slot the two swap, so nothing repeats or drops out. */
export function chooseTab(slots: readonly string[], slot: number, value: string): string[] {
  const next = slots.slice();
  if (slot < 0 || slot >= next.length || next[slot] === value) return next;
  const was = next.indexOf(value);
  if (was !== -1) next[was] = next[slot];
  next[slot] = value;
  return next;
}

/** "9+" past nine; nothing for zero. */
export function badgeText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n > 9 ? "9+" : String(Math.floor(n));
}
