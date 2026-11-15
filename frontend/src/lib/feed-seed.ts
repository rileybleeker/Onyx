import { clientCache } from "./client-cache";

/**
 * Continuous scroll: the first-load data of an ISR dashboard, kept in the shared client cache so the page
 * renders at once when the scroll reaches it (its FeedSection passes it as the Loader's `initial`, exactly
 * like the server seed). The page's client writes it after each successful load of its DEFAULT view (same
 * shape and same default-state args as its server prefetch); the client still revalidates silently on mount.
 *
 * Memory only (persist: false): the seeds can be large and they are rebuilt by the first visit of a session.
 * The key is "<area>:feed", so a write to /api/<area>/... drops it (writeInvalidates) and the sensitive-area
 * patterns in lib/client-cache.ts apply to it like to any other key of that area.
 */
export const FEED_SEED_MAX_AGE_MS = 6 * 3_600_000;

export function feedSeedKey(route: string): string {
  return `${route.replace(/^\/+/, "").replace(/\//g, "-")}:feed`;
}

export function readFeedSeed<T>(route: string): T | null {
  try {
    return clientCache.peek<T>(feedSeedKey(route)) ?? null;
  } catch {
    return null;
  }
}

/** Store a page's default-view data. Off the critical path: the comparison with the last copy runs when idle. */
export function writeFeedSeed(route: string, value: unknown): void {
  const run = () => {
    try { clientCache.put(feedSeedKey(route), value, { persist: false, maxAgeMs: FEED_SEED_MAX_AGE_MS }); } catch { /* never breaks a page */ }
  };
  const g = globalThis as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void };
  if (typeof g.requestIdleCallback === "function") g.requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 50);
}
