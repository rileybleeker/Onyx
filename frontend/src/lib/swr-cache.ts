// Server-side stale-while-revalidate cache for slow external reads (Notion) on a request path.
//
// Backed by Next's unstable_cache, which on Vercel is the shared Data Cache: every function
// instance sees the same entry, so a cold instance does not pay the external call either.
//   - Entry younger than `revalidateSeconds`: returned as is.
//   - Older: returned at once, and Next refreshes it in the background (waitUntil).
//   - Older than `maxAgeMs` (nothing has read it for a long time and every background refresh
//     failed or never ran): read directly, so a value is never served more than maxAgeMs old.
// A failed load is never cached: the error reaches the caller exactly as without the cache.
// Outside a Next request (node scripts, offline tests) there is no cache and `load` runs directly.
import { unstable_cache } from "next/cache";

interface Entry<T> {
  at: number;
  value: T;
}

export function swrCache<T>(
  key: string,
  load: () => Promise<T>,
  opts: { revalidateSeconds: number; maxAgeMs: number },
): () => Promise<T> {
  const cached = unstable_cache(async (): Promise<Entry<T>> => ({ at: Date.now(), value: await load() }), [key], {
    revalidate: opts.revalidateSeconds,
  });
  return async () => {
    let entry: Entry<T> | null = null;
    try {
      entry = await cached();
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes("incrementalCache missing")) throw e;
    }
    if (entry && typeof entry.at === "number" && Date.now() - entry.at <= opts.maxAgeMs) return entry.value;
    return load();
  };
}
