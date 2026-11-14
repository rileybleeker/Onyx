/**
 * Purchase suggestions: things bought repeatedly, and when they are usually reordered.
 *
 * PURE and rule-based: no network, no clock (callers pass `today`), no Supabase, no model. The
 * input is the order history Onyx already keeps for /orders (pds.online_orders: shipping emails
 * and the personal Amazon order list), item NAMES only - that source carries no prices.
 * Restaurant delivery is out of scope. Read-only advice: there is no link to a cart, nothing here
 * orders anything.
 *
 * Rules, in plain words:
 * - an item counts when the same name (case, spacing and punctuation ignored) appears in orders
 *   on at least MIN_PURCHASES separate occasions; orders within MERGE_DAYS days of each other are
 *   one occasion (a split shipment, or one order seen twice);
 * - the reorder interval is the median gap between occasions; under MIN_INTERVAL_DAYS it is not a
 *   reorder pattern and the item is left out;
 * - "likely due" from 90% of the interval since the last order, "due soon" from 70%;
 * - an item not ordered for more than LAPSED_FACTOR intervals is treated as stopped and left out;
 * - canceled orders never count.
 */

export const MIN_PURCHASES = 3;
export const MERGE_DAYS = 3;
export const MIN_INTERVAL_DAYS = 7;
export const DUE_SHARE = 0.9;
export const SOON_SHARE = 0.7;
export const LAPSED_FACTOR = 3;
/** Gaps whose spread (longest minus shortest) is over half the usual gap make the interval a rough one. */
export const STEADY_SPREAD = 0.5;
/** How far back the loader reads order history. */
export const REORDER_WINDOW_DAYS = 540;
export const MAX_SUGGESTIONS = 40;

export interface OrderInput {
  merchant: string;
  items: string[];
  /** Day the order was placed (or first seen), YYYY-MM-DD. */
  orderedOn: string;
  status: string;
}

export type ReorderStatus = "due" | "soon" | "later";

export interface ReorderSuggestion {
  /** Normalized item name: stable React key, never shown. */
  key: string;
  item: string;
  /** Where it was last ordered from. */
  merchant: string;
  purchases: number;
  intervalDays: number;
  minGapDays: number;
  maxGapDays: number;
  /** "steady" when the gaps are close to each other, otherwise "rough". */
  regularity: "steady" | "rough";
  lastOrdered: string;
  daysSince: number;
  /** Last order plus the usual interval. */
  dueOn: string;
  status: ReorderStatus;
  reason: string;
}

export interface ReorderResult {
  suggestions: ReorderSuggestion[];
  /** Items seen on exactly two occasions: too few to estimate an interval. */
  boughtTwice: number;
  /** Repeat items not ordered for a long time (treated as stopped). */
  stopped: number;
}

export type ReorderLoad =
  | ({ state: "ok"; today: string; orders: number } & ReorderResult)
  | { state: "empty" }
  | { state: "not_connected" }
  | { state: "error"; code: string };

const DAY_MS = 86_400_000;
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const dayNumber = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const fromDayNumber = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const prettyDate = (iso: string): string => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Same item, however it was spelled: lowercase, punctuation to spaces, one space between words. */
export function normalizeItem(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9%.À-ɏ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse one pds.online_orders row; a row that cannot be used is dropped (null). */
export function parseOrderInput(raw: unknown, toDay: (instant: string) => string): OrderInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const instant = [r.ordered_at, r.shipped_at, r.first_event_at].find((v): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)));
  if (!instant) return null;
  const orderedOn = toDay(instant);
  if (!isDay(orderedOn)) return null;
  const items = Array.isArray(r.items) ? r.items.filter((i): i is string => typeof i === "string" && i.trim() !== "") : [];
  return {
    merchant: typeof r.merchant_name === "string" ? r.merchant_name.trim() : "",
    items,
    orderedOn,
    status: typeof r.status === "string" ? r.status : "",
  };
}

interface Occasion {
  day: number;
  merchant: string;
  label: string;
}

/** Items bought repeatedly, with their usual reorder interval. Due first, then soonest. */
export function reorderSuggestions(orders: readonly OrderInput[], today: string): ReorderResult {
  const todayN = dayNumber(today);
  const byItem = new Map<string, Occasion[]>();
  for (const o of orders) {
    if (o.status === "canceled" || !isDay(o.orderedOn)) continue;
    const day = dayNumber(o.orderedOn);
    if (day > todayN) continue;
    const seen = new Set<string>();
    for (const name of o.items) {
      const key = normalizeItem(name);
      if (key.length < 3 || seen.has(key)) continue;
      seen.add(key);
      const occasion = { day, merchant: o.merchant, label: name.trim() };
      const list = byItem.get(key);
      if (list) list.push(occasion);
      else byItem.set(key, [occasion]);
    }
  }

  const suggestions: ReorderSuggestion[] = [];
  let boughtTwice = 0;
  let stopped = 0;
  for (const [key, all] of byItem) {
    const sorted = [...all].sort((a, b) => a.day - b.day);
    // Orders close together are one occasion; the later one names it.
    const occasions: Occasion[] = [];
    for (const o of sorted) {
      const prev = occasions[occasions.length - 1];
      if (prev && o.day - prev.day <= MERGE_DAYS) occasions[occasions.length - 1] = { ...o, day: prev.day };
      else occasions.push(o);
    }
    if (occasions.length === 2) boughtTwice++;
    if (occasions.length < MIN_PURCHASES) continue;
    const gaps: number[] = [];
    for (let i = 1; i < occasions.length; i++) gaps.push(occasions[i].day - occasions[i - 1].day);
    const interval = Math.round(median(gaps));
    if (interval < MIN_INTERVAL_DAYS) continue;
    const last = occasions[occasions.length - 1];
    const daysSince = todayN - last.day;
    if (daysSince > LAPSED_FACTOR * interval) {
      stopped++;
      continue;
    }
    const minGap = Math.min(...gaps);
    const maxGap = Math.max(...gaps);
    const regularity = (maxGap - minGap) / interval <= STEADY_SPREAD ? "steady" : "rough";
    const status: ReorderStatus = daysSince >= DUE_SHARE * interval ? "due" : daysSince >= SOON_SHARE * interval ? "soon" : "later";
    const lastOrdered = fromDayNumber(last.day);
    const dueOn = fromDayNumber(last.day + interval);
    const remaining = interval - daysSince;
    const when =
      status === "due"
        ? remaining >= 0
          ? "Likely due about now."
          : `Likely due: ${-remaining} day${remaining === -1 ? "" : "s"} past the usual interval.`
        : `Due in about ${remaining} days.`;
    const spread = minGap === maxGap ? `always ${minGap} days apart` : `gaps of ${minGap} to ${maxGap} days${regularity === "rough" ? ", so a rough figure" : ""}`;
    suggestions.push({
      key,
      item: last.label,
      merchant: last.merchant,
      purchases: occasions.length,
      intervalDays: interval,
      minGapDays: minGap,
      maxGapDays: maxGap,
      regularity,
      lastOrdered,
      daysSince,
      dueOn,
      status,
      reason:
        `Ordered ${occasions.length} times${last.merchant ? `, last from ${last.merchant}` : ""}; usually reordered every ~${interval} days (${spread}). ` +
        `Last ordered ${prettyDate(lastOrdered)}, ${daysSince} day${daysSince === 1 ? "" : "s"} ago. ${when}`,
    });
  }
  const rank: Record<ReorderStatus, number> = { due: 0, soon: 1, later: 2 };
  suggestions.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return { suggestions: suggestions.slice(0, MAX_SUGGESTIONS), boughtTwice, stopped };
}
