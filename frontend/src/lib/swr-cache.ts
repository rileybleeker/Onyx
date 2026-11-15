// Server-side stale-while-revalidate cache for slow external reads (Notion) on a request path.
//
// Backed by Next's unstable_cache, which on Vercel is the shared Data Cache: every function
// instance sees the same entry, so a cold instance does not pay the external call either.
//   - Entry younger than `revalidateSeconds`: returned as is.
//   - Older: returned at once, and Next refreshes it in the background (waitUntil).
//   - Older than `maxAgeMs` (nothing has read it for a long time and every background refresh
//     failed or never ran): read directly, so a value is never served more than maxAgeMs old.
// A failed load is never cached: the error reaches the caller exactly as without the cache.
// A failed BACKGROUND refresh keeps the older entry, though, so a caller that reports health
// (/api/status) must use swrCacheTimed and say how old the answer is (Codex review 2026-11-14).
// `tag` lets a writer that sees the source change drop the entry (revalidateTag) instead of
// waiting for the next refresh.
// Outside a Next request (node scripts, offline tests) there is no cache and `load` runs directly.
import { unstable_cache } from "next/cache";

interface Entry<T> {
  at: number;
  value: T;
}

export interface Timed<T> {
  value: T;
  /** When the value was read from the source (epoch ms): now for a direct read, older for a cached one. */
  checkedAt: number;
}

interface Opts {
  revalidateSeconds: number;
  maxAgeMs: number;
  tag?: string;
}

export function swrCacheTimed<T>(key: string, load: () => Promise<T>, opts: Opts): () => Promise<Timed<T>> {
  const cached = unstable_cache(async (): Promise<Entry<T>> => ({ at: Date.now(), value: await load() }), [key], {
    revalidate: opts.revalidateSeconds,
    ...(opts.tag ? { tags: [opts.tag] } : {}),
  });
  return async () => {
    let entry: Entry<T> | null = null;
    try {
      entry = await cached();
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes("incrementalCache missing")) throw e;
    }
    if (entry && typeof entry.at === "number" && Date.now() - entry.at <= opts.maxAgeMs) {
      return { value: entry.value, checkedAt: entry.at };
    }
    const checkedAt = Date.now();
    return { value: await load(), checkedAt };
  };
}

export function swrCache<T>(key: string, load: () => Promise<T>, opts: Opts): () => Promise<T> {
  const timed = swrCacheTimed(key, load, opts);
  return async () => (await timed()).value;
}

/**
 * Pure: a health answer read from a cache is current only while it is younger than `limitMs` (a few refresh
 * intervals). Older means the background refreshes have been failing or not running: returns the sentence that says
 * so, or null while the answer is current.
 */
export function staleCheckNote(checkedAt: number, now: number, limitMs: number, source: string): string | null {
  const age = now - checkedAt;
  if (!(age > limitMs)) return null;
  const minutes = Math.round(age / 60000);
  const ago = minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  return `Showing the last good ${source} check, ${ago} old: newer checks failed or have not run.`;
}
