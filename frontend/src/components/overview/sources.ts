/**
 * Where each overview card's numbers come from: existing GET endpoints and lib/queries reads only, each a
 * few rows (7-9 days). Every source is one client-cache key (lib/client-cache.ts rule 1): the URL for /api
 * reads, so Today, the page and the warm-up share one entry, and "<area>:overview-…" for Supabase reads.
 *
 * Privacy: finance, procurement and screen-time answers come from their server routes (service role, owner
 * session) and the cache keeps them in memory only (isSensitiveKey); medical records are never read here.
 * Care items stay in memory too (persist: false). Nothing here writes: GET reads only.
 *
 * lib/queries is loaded on demand (it is large; the same rule AppData.tsx follows).
 */
import { CACHE_KEYS, clientCache, fetchJsonValue, GONE } from "@/lib/client-cache";
import { agentsApi } from "@/lib/agents-api";
import { localDate, shiftDate } from "@/lib/calendar-events";
import { CHECKS } from "@/lib/overview-views";
import { OVERVIEW_CARD_IDS, OVERVIEW_PREF_KEY, mergeArrangement, parseArrangement, visibleIds } from "@/lib/overview-cards";
import { parseUiPref, uiPrefUrl } from "@/lib/ui-preferences";

export interface OverviewSource {
  key: string;
  fetch: () => Promise<unknown>;
  /** Throws on a malformed answer (checked before it is cached or shown, fresh or cached). */
  check: (raw: unknown) => void;
  /** A cached answer younger than this is shown without asking the server again. */
  freshMs: number;
  /** false = memory only (sensitive keys are memory only whatever this says). */
  persist?: boolean;
  /** Today's own panels already load this key on open: the card waits briefly for that answer first. */
  today?: boolean;
}

const MIN = 60_000;
const json = (url: string) => () => fetchJsonValue(url);
const queries = () => import("@/lib/queries");
const queriesHrv = () => import("@/lib/queries-hrv");

/** Same URL Today's calendar panel reads (today and tomorrow in this device's zone). */
export function todayCalendarUrl(now = new Date()): string {
  const firstDay = localDate(now);
  return `/api/calendar/events?from=${firstDay}&to=${shiftDate(firstDay, 1)}`;
}

/** The sources of one card, in the order its view reads them (lib/overview-views.ts). */
export function cardSources(id: string): OverviewSource[] {
  switch (id) {
    case "recovery":
      return [
        { key: "sleep:overview-recovery", fetch: () => queries().then(async (q) => ({ rows: await q.getWhoopRecovery(9) })), check: CHECKS.rows, freshMs: 5 * MIN },
        { key: "hrv:overview-forecast", fetch: () => queriesHrv().then(async (q) => ({ prediction: (await q.getTomorrowPrediction()) ?? null })), check: CHECKS.prediction, freshMs: 5 * MIN },
      ];
    case "sleep":
      return [{ key: "sleep:overview-sleep", fetch: () => queries().then(async (q) => ({ rows: await q.getWhoopSleep(9) })), check: CHECKS.rows, freshMs: 5 * MIN }];
    case "activity":
      return [
        { key: "activities:overview-cycles", fetch: () => queries().then(async (q) => ({ rows: await q.getWhoopCycles(9) })), check: CHECKS.rows, freshMs: 5 * MIN },
        { key: "activities:overview-garmin", fetch: () => queries().then(async (q) => ({ rows: await q.getDailySummaries(9) })), check: CHECKS.rows, freshMs: 5 * MIN },
      ];
    case "nutrition":
      return [
        { key: "nutrition:overview-days", fetch: () => queries().then(async (q) => ({ rows: await q.getNutrition(8) })), check: CHECKS.rows, freshMs: 5 * MIN },
        // The URL /nutrition reads at its default range, so both share one cache entry.
        { key: "/api/weight?days=90", fetch: json("/api/weight?days=90"), check: CHECKS.rows, freshMs: 5 * MIN },
        { key: "caffeine:overview-days", fetch: () => queries().then(async (q) => ({ rows: await q.getCaffeineDaily(8) })), check: CHECKS.rows, freshMs: 5 * MIN },
      ];
    case "supplements":
      return [{ key: "/api/supplements/today", fetch: json("/api/supplements/today"), check: CHECKS.supplements, freshMs: MIN }];
    case "habits":
      return [
        { key: "/api/habits/checkin", fetch: json("/api/habits/checkin"), check: CHECKS.checkin, freshMs: MIN },
        { key: "/api/reading", fetch: json("/api/reading"), check: CHECKS.reading, freshMs: MIN, today: true },
      ];
    case "money":
      return [
        { key: "/api/finance/alerts", fetch: json("/api/finance/alerts"), check: CHECKS.alerts, freshMs: MIN, today: true },
        { key: "/api/procurement/renewals/summary", fetch: json("/api/procurement/renewals/summary"), check: CHECKS.renewals, freshMs: MIN, today: true },
      ];
    case "orders":
      return [{ key: "/api/orders/summary", fetch: json("/api/orders/summary"), check: CHECKS.orders, freshMs: MIN, today: true }];
    case "calendar": {
      const url = todayCalendarUrl();
      return [
        { key: url, fetch: json(url), check: CHECKS.calendar, freshMs: MIN, today: true },
        { key: "/api/care/items", fetch: json("/api/care/items"), check: CHECKS.care, freshMs: 5 * MIN, persist: false },
      ];
    }
    case "screen-time":
      // A sensitive key (lib/client-cache.ts isSensitiveKey): memory only, never on the device.
      return [{ key: "/api/screen-time/summary", fetch: json("/api/screen-time/summary"), check: CHECKS.screenTime, freshMs: 10 * MIN }];
    case "agents":
      return [{ key: CACHE_KEYS.agentsInbox, fetch: () => agentsApi.inbox(), check: CHECKS.inbox, freshMs: MIN, today: true }];
    case "nyc":
      // A Notion read: the scout writes once a day, so a half-hour-old answer is fine.
      return [{ key: "/api/nyc/leads", fetch: json("/api/nyc/leads"), check: CHECKS.leads, freshMs: 30 * MIN }];
    case "status":
      return [{ key: "/api/status", fetch: json("/api/status"), check: CHECKS.status, freshMs: 2 * MIN }];
    default:
      return [];
  }
}

/** The fetcher the cache stores: a malformed answer is never cached. */
export function checkedFetch(s: OverviewSource): () => Promise<unknown> {
  return async () => {
    const raw = await s.fetch();
    if (raw !== GONE) s.check(raw);
    return raw;
  };
}

export const ARRANGEMENT_URL = uiPrefUrl(OVERVIEW_PREF_KEY);

/** The cards shown in the cached arrangement (default when none is cached yet). */
export function cachedVisibleCards(): string[] {
  const raw = clientCache.peek(ARRANGEMENT_URL);
  let saved = null;
  try { saved = raw === undefined ? null : parseArrangement(parseUiPref(raw, OVERVIEW_PREF_KEY).value); } catch { saved = null; }
  return visibleIds(mergeArrangement(saved, OVERVIEW_CARD_IDS));
}

/**
 * The overview's reads for the background warm-up (lib/warmup.ts DataWarmer shape), for the cards that are
 * shown, skipping keys Today loads itself and memory-only ones. Long freshness: the cards revalidate when they come into view.
 */
export function overviewWarmers(): { key: string; fetch: () => Promise<unknown>; freshMs: number }[] {
  const out: { key: string; fetch: () => Promise<unknown>; freshMs: number }[] = [];
  for (const id of cachedVisibleCards()) {
    for (const s of cardSources(id)) {
      // The warm-up stores with the default persistence, so memory-only sources are left to the card itself.
      if (s.today || s.persist === false || out.some((w) => w.key === s.key)) continue;
      out.push({ key: s.key, fetch: checkedFetch(s), freshMs: Math.max(s.freshMs, 10 * MIN) });
    }
  }
  return out;
}
