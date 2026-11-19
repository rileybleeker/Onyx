import { clientCache } from "@/lib/client-cache";
import {
  BEHAVIORAL_TODAY_URL,
  LOG_EARLIER_DAYS,
  UBER_EATS_CHECK_KEY,
  deliveryWindowDays,
  deliveryWindowKey,
  initialBehavioralToday,
  type UberEatsCheck,
} from "@/lib/log-ubereats";
import type { DeliveryWindow } from "@/lib/queries-delivery";

/**
 * The Uber Eats section's first reads on a full load of /log (speed budget, 2026-11-15). They are Supabase reads
 * (supabase-js, owner session), which the page's inline script (lib/log-early.ts) cannot start, so LogLoader starts
 * them as soon as the page's own JavaScript runs, instead of after the section chunks have loaded and mounted:
 * today's dish window (the key and days the section paints first) and the "Uber Eats checked" heartbeat.
 *
 * READ-ONLY: two GETs, nothing written. Only after a full page load of /log (the inline script's mark), never for a
 * copy in the continuous scroll or an in-app visit (the client cache shows those at once). Each answer is taken
 * once, within EARLY_MAX_AGE_MS, by the routed page's section; otherwise it is left unused.
 */

/** Same limit as lib/early-fetch.ts: an older answer is not used. */
const EARLY_MAX_AGE_MS = 10_000;

interface Early<T> {
  key: string;
  at: number;
  p: Promise<T>;
}

let windowRead: Early<DeliveryWindow> | null = null;
let checkRead: Early<UberEatsCheck> | null = null;
let started = false;

/** Start both reads, once per page load. */
export function startEarlyDeliveryReads(now = Date.now()): void {
  if (started) return;
  started = true;
  // The day the section paints first (same rule and inputs as UberEats.tsx and the warm-up).
  const today = initialBehavioralToday(clientCache.peek(BEHAVIORAL_TODAY_URL), clientCache.fetchedAt(BEHAVIORAL_TODAY_URL), now);
  const days = deliveryWindowDays(today, LOG_EARLIER_DAYS);
  // lib/queries is large: loaded on demand, as everywhere else.
  const q = import("@/lib/queries-delivery");
  windowRead = { key: deliveryWindowKey(today, LOG_EARLIER_DAYS), at: now, p: q.then((m) => m.getDeliveryWindow(days)) };
  checkRead = { key: UBER_EATS_CHECK_KEY, at: now, p: q.then((m) => m.getUberEatsCheck()) };
  // Unused or failed: finish quietly (the section reads again on its own).
  windowRead.p.catch(() => {});
  checkRead.p.catch(() => {});
}

function take<T>(slot: Early<T> | null, key: string, now: number): Promise<T> | null {
  if (!slot || slot.key !== key || !(now - slot.at < EARLY_MAX_AGE_MS)) return null;
  return slot.p;
}

/**
 * The started dish-window read for `key`, once; null when there is none, it is for another day, or too old. A read
 * for another day stays (until it is too old) for the tab of that day.
 */
export function takeEarlyDeliveryWindow(key: string, now = Date.now()): Promise<DeliveryWindow> | null {
  const p = take(windowRead, key, now);
  if (p || (windowRead && !(now - windowRead.at < EARLY_MAX_AGE_MS))) windowRead = null;
  return p;
}

/** The started heartbeat read, once; null when there is none or it is too old. */
export function takeEarlyUberEatsCheck(now = Date.now()): Promise<UberEatsCheck> | null {
  const p = take(checkRead, UBER_EATS_CHECK_KEY, now);
  checkRead = null;
  return p;
}
