import type { ComponentType } from "react";

/**
 * Continuous scroll: route -> the page's FeedSection chunk (app/<route>/FeedSection.tsx, "use client", default
 * export, no props). A FeedSection renders the page's complete content client-side, heading included, from the
 * shared client cache (lib/client-cache.ts); finance, procurement, medical records and screen time stay
 * memory-only there. The page's own page.tsx is never used here and never changes: a direct visit or a reload
 * still renders the routed page normally.
 *
 * A route without an entry is skipped by the scroll (except when it is the routed page itself). Each entry is
 * a dynamic import, so a page's code loads only when the scroll is about to reach it.
 */
export type FeedSectionModule = { default: ComponentType };

export const FEED_SECTIONS: Record<string, () => Promise<FeedSectionModule>> = {
  "/today": () => import("@/app/today/FeedSection"),
  // /log holds the check-in (its Check-in section), so /check-in has no entry: the scroll never shows it twice.
  // A visit to /check-in itself (the 21:30 card's link) still renders it as the routed page.
  "/log": () => import("@/app/log/FeedSection"),
  "/activities": () => import("@/app/activities/FeedSection"),
  "/nutrition": () => import("@/app/nutrition/FeedSection"),
  "/supplements": () => import("@/app/supplements/FeedSection"),
  "/caffeine": () => import("@/app/caffeine/FeedSection"),
  "/habits": () => import("@/app/habits/FeedSection"),
  "/reading": () => import("@/app/reading/FeedSection"),
  "/sleep": () => import("@/app/sleep/FeedSection"),
  "/analytics/hrv": () => import("@/app/analytics/hrv/FeedSection"),
  "/analytics/travel": () => import("@/app/analytics/travel/FeedSection"),
  "/bland-altman": () => import("@/app/bland-altman/FeedSection"),
  "/screen-time": () => import("@/app/screen-time/FeedSection"),
  "/spotify": () => import("@/app/spotify/FeedSection"),
  "/journal": () => import("@/app/journal/FeedSection"),
  "/wins": () => import("@/app/wins/FeedSection"),
  "/health": () => import("@/app/health/FeedSection"),
  "/health/records": () => import("@/app/health/records/FeedSection"),
  "/orders": () => import("@/app/orders/FeedSection"),
  "/procurement": () => import("@/app/procurement/FeedSection"),
  "/financials": () => import("@/app/financials/FeedSection"),
  "/rewards": () => import("@/app/rewards/FeedSection"),
  "/financials/budgets": () => import("@/app/financials/budgets/FeedSection"),
  "/financials/forecast": () => import("@/app/financials/forecast/FeedSection"),
  "/nyc": () => import("@/app/nyc/FeedSection"),
  "/status": () => import("@/app/status/FeedSection"),
};

export function hasFeedSection(route: string): boolean {
  return Object.prototype.hasOwnProperty.call(FEED_SECTIONS, route);
}

const loaded = new Map<string, ComponentType>();
const loading = new Map<string, Promise<ComponentType | null>>();

/** The FeedSection component when its chunk has already loaded (synchronous; no flash on a remount). */
export function loadedFeedSection(route: string): ComponentType | null {
  return loaded.get(route) ?? null;
}

/** Load a FeedSection chunk once; null when the route has none or the chunk failed (retried on the next call). */
export function loadFeedSection(route: string): Promise<ComponentType | null> {
  const done = loaded.get(route);
  if (done) return Promise.resolve(done);
  const running = loading.get(route);
  if (running) return running;
  const load = FEED_SECTIONS[route];
  if (!load) return Promise.resolve(null);
  const job = load()
    .then((mod) => {
      loaded.set(route, mod.default);
      return mod.default;
    })
    .catch(() => null)
    .finally(() => { loading.delete(route); });
  loading.set(route, job);
  return job;
}
