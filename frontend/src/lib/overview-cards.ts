/**
 * The overview cards under Today's panels: one card per area of the app, in an order Riley arranges.
 *
 * - OVERVIEW_CARDS lists the cards. Each names the page it opens and every nav page it summarizes
 *   (`covers`). A nav page (lib/nav.ts) that no card covers is listed on the "More pages" card, so a new
 *   page is on the overview from the day it is added; giving it a card of its own = one entry here plus its
 *   data in components/overview/sources.ts and lib/overview-views.ts.
 * - The arrangement (order + hidden cards) is stored as the UI preference "overview.cards"
 *   (pds.ui_preferences via /api/ui/preferences), so the phone and the desktop app show the same order.
 *   mergeArrangement() reconciles a saved arrangement with the current card list: a new card appears at
 *   its default place, a removed one drops out.
 *
 * Pure and import-free: tests/overview-cards.test.cjs runs it in plain node and tests/today-regression.cjs
 * bundles it by name.
 */

export const OVERVIEW_PREF_KEY = "overview.cards";
/** Stored shape version. A value with another version is ignored (the default order is used). */
export const ARRANGEMENT_VERSION = 1;
/** The card that lists every nav page without a card of its own. */
export const MORE_CARD_ID = "more";

export interface OverviewCardDef {
  id: string;
  title: string;
  /** The page the card opens (a NAV_SECTIONS href); null only for the "More pages" card. */
  href: string | null;
  /** Every nav page this card summarizes. The rest are listed on the "More pages" card. */
  covers: readonly string[];
  /** Other pages linked from the card, besides `href`. */
  links?: readonly string[];
}

// Default order: the day's body first (recovery, sleep, activity, food), then the logs, money and errands,
// then the tools. Today's own panels (requests, urgent email, calendar, packages, reading, check-in) stay above.
export const OVERVIEW_CARDS: readonly OverviewCardDef[] = [
  { id: "recovery", title: "Recovery & HRV forecast", href: "/analytics/hrv", covers: ["/analytics/hrv"] },
  { id: "sleep", title: "Sleep", href: "/sleep", covers: ["/sleep"] },
  { id: "activity", title: "Activity & steps", href: "/activities", covers: ["/activities"] },
  { id: "nutrition", title: "Nutrition & caffeine", href: "/nutrition", covers: ["/nutrition", "/caffeine"], links: ["/caffeine"] },
  { id: "supplements", title: "Supplements", href: "/supplements", covers: ["/supplements"] },
  { id: "habits", title: "Habits & reading", href: "/habits", covers: ["/habits", "/check-in", "/reading"], links: ["/check-in", "/reading"] },
  { id: "money", title: "Money", href: "/financials", covers: ["/financials", "/financials/budgets", "/financials/forecast", "/procurement"], links: ["/financials/budgets", "/financials/forecast", "/procurement"] },
  { id: "orders", title: "Orders", href: "/orders", covers: ["/orders"] },
  { id: "calendar", title: "Calendar & care", href: "/health", covers: ["/health"] },
  { id: "screen-time", title: "Screen time", href: "/screen-time", covers: ["/screen-time"] },
  { id: "agents", title: "Agents", href: "/agents", covers: ["/agents"] },
  { id: "nyc", title: "NYC search", href: "/nyc", covers: ["/nyc"] },
  { id: "status", title: "System status", href: "/status", covers: ["/status"] },
  { id: MORE_CARD_ID, title: "More pages", href: null, covers: [] },
];

export const OVERVIEW_CARD_IDS: readonly string[] = OVERVIEW_CARDS.map((c) => c.id);

export function cardDef(id: string): OverviewCardDef | undefined {
  return OVERVIEW_CARDS.find((c) => c.id === id);
}

/** Nav pages with no card of their own (Today itself is the top of the scroll), in nav order. */
export function moreHrefs(navHrefs: readonly string[], cards: readonly OverviewCardDef[] = OVERVIEW_CARDS): string[] {
  const covered = new Set<string>(["/today"]);
  for (const c of cards) for (const h of c.covers) covered.add(h);
  const out: string[] = [];
  for (const h of navHrefs) if (!covered.has(h) && !out.includes(h)) out.push(h);
  return out;
}

export interface Arrangement {
  /** Every card, in the order shown (hidden ones keep their place for when they are shown again). */
  order: string[];
  /** Cards not shown. */
  hidden: string[];
}

export interface StoredArrangement {
  v: number;
  order: string[];
  hidden: string[];
}

const MAX_IDS = 100;
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

function uniqueIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_IDS) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !ID_RE.test(v)) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export function defaultArrangement(ids: readonly string[] = OVERVIEW_CARD_IDS): Arrangement {
  return { order: [...ids], hidden: [] };
}

/** A stored arrangement ({v, order, hidden}), or null when it is missing or malformed. */
export function parseArrangement(raw: unknown): Arrangement | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { v?: unknown; order?: unknown; hidden?: unknown };
  if (r.v !== ARRANGEMENT_VERSION) return null;
  const order = uniqueIds(r.order);
  const hidden = uniqueIds(r.hidden ?? []);
  if (!order || !hidden) return null;
  return { order, hidden };
}

export function toStored(a: Arrangement): StoredArrangement {
  return { v: ARRANGEMENT_VERSION, order: [...a.order], hidden: [...a.hidden] };
}

/**
 * The saved arrangement fitted to the current card list: unknown ids drop out, a card the saved order has
 * never seen is inserted right after the nearest card that comes before it in the default order (or first
 * when none does), and hidden ids are kept only for known cards. No saved arrangement = the default.
 */
export function mergeArrangement(saved: Arrangement | null, ids: readonly string[] = OVERVIEW_CARD_IDS): Arrangement {
  if (!saved) return defaultArrangement(ids);
  const known = new Set(ids);
  const order = saved.order.filter((id, i) => known.has(id) && saved.order.indexOf(id) === i);
  ids.forEach((id, i) => {
    if (order.includes(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = order.indexOf(ids[j]);
      if (k !== -1) { at = k + 1; break; }
    }
    order.splice(at, 0, id);
  });
  const hidden = order.filter((id) => saved.hidden.includes(id));
  return { order, hidden };
}

/** The cards to render, in order. */
export function visibleIds(a: Arrangement): string[] {
  return a.order.filter((id) => !a.hidden.includes(id));
}

/** Move one card `delta` places (−1 = up) in the full order; out of range = unchanged. */
export function moveBy(a: Arrangement, id: string, delta: number): Arrangement {
  const from = a.order.indexOf(id);
  if (from === -1) return a;
  return moveTo(a, id, from + delta);
}

/** Put one card at `index` of the full order (clamped). Unchanged when it is already there. */
export function moveTo(a: Arrangement, id: string, index: number): Arrangement {
  const from = a.order.indexOf(id);
  if (from === -1) return a;
  const to = Math.max(0, Math.min(a.order.length - 1, Math.trunc(index)));
  if (to === from) return a;
  const order = a.order.filter((x) => x !== id);
  order.splice(to, 0, id);
  return { order, hidden: a.hidden };
}

export function setHidden(a: Arrangement, id: string, hidden: boolean): Arrangement {
  if (!a.order.includes(id) || a.hidden.includes(id) === hidden) return a;
  return { order: a.order, hidden: hidden ? a.order.filter((x) => x === id || a.hidden.includes(x)) : a.hidden.filter((x) => x !== id) };
}

export function sameArrangement(a: Arrangement, b: Arrangement): boolean {
  return a.order.length === b.order.length && a.order.every((id, i) => b.order[i] === id)
    && a.hidden.length === b.hidden.length && a.hidden.every((id) => b.hidden.includes(id));
}

export function isDefaultArrangement(a: Arrangement, ids: readonly string[] = OVERVIEW_CARD_IDS): boolean {
  return sameArrangement(a, defaultArrangement(ids));
}
