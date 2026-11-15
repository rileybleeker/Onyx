/**
 * Background warm-up: once the first page has painted, load in idle time the code + server payload of every
 * other page (router prefetch) and the data its client fetches (into lib/client-cache.ts), one step at a
 * time, most-visited pages first. Hover, focus and pointer-down on a nav link warm that page at once.
 *
 * Replaces Next's default <Link> viewport prefetch on the nav (20+ requests fired together at startup, which
 * produced one ~570 ms main-thread task). Only GET reads run here: nothing is written, nothing is marked read.
 *
 * Import-free (unit-tested in plain node: tests/warmup.test.cjs). components/AppData.tsx wires it to the
 * router, the cache and the page list.
 */

export type PrefetchMode = "full" | "auto";

export interface DataWarmer {
  key: string;
  fetch: () => Promise<unknown>;
  /** Skip the fetch when the cached value is younger than this (default 60 s). */
  freshMs?: number;
}

export interface WarmTarget {
  href: string;
  /** "full": the server payload too (static, ISR and read-only pages). "auto": code + loading skeleton only. */
  prefetch: PrefetchMode;
  /** GET reads the page's client makes on mount. Called when the step runs, so keys can carry today's date. */
  data?: () => DataWarmer[];
  /**
   * The page's client code that the router prefetch does not load: a `dynamic(..., { ssr: false })` chunk.
   * Loading it here means a click renders at once instead of fetching JS first.
   */
  code?: () => Promise<unknown>;
}

export interface WarmCache {
  fetchedAt(key: string): number | undefined;
  revalidate(key: string, fetcher: () => Promise<unknown>): Promise<unknown>;
  register(key: string, fetcher: () => Promise<unknown>): void;
}

export interface WarmupDeps {
  prefetchRoute(href: string, mode: PrefetchMode): void;
  cache: WarmCache;
  now(): number;
  /** Resolve in the next idle slot. */
  idle(): Promise<void>;
  wait(ms: number): Promise<void>;
  /** The user asked the browser to save data: warm only the first few pages. */
  saveData?(): boolean;
}

export const STEP_GAP_MS = 200;
export const DEFAULT_FRESH_MS = 60_000;
export const SAVE_DATA_LIMIT = 4;
/** Warm again when the app comes back after being hidden this long. */
export const REWARM_AFTER_MS = 10 * 60_000;
/** While the app is in active use, warm again this often (the router's prefetches last 5 minutes). */
export const REWARM_EVERY_MS = 5 * 60_000;

function pathOnly(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

/** A route key without query or hash ("/agents?t=x#m1" -> "/agents"); "/" counts as Today. */
export function routeOf(href: string): string {
  const path = pathOnly(href);
  return path === "/" ? "/today" : path;
}

// ---- visit counts: order the warm-up by how often each page is opened ----

export const VISITS_KEY = "onyx.warmup.visits";
const HALF_LIFE_MS = 14 * 24 * 3_600_000;
/** Pages opened from the mobile tab bar or the quick links lead until another page is clearly more used. */
const PINNED_BONUS = 3;

export type Visits = Record<string, { score: number; at: number }>;

export function decayed(entry: { score: number; at: number } | undefined, now: number): number {
  if (!entry) return 0;
  return entry.score * Math.pow(0.5, Math.max(0, now - entry.at) / HALF_LIFE_MS);
}

export function recordVisit(visits: Visits, href: string, now: number): Visits {
  const route = routeOf(href);
  return { ...visits, [route]: { score: decayed(visits[route], now) + 1, at: now } };
}

export function parseVisits(raw: string | null): Visits {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return {};
    const out: Visits = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      const e = v as { score?: unknown; at?: unknown };
      if (k.startsWith("/") && typeof e?.score === "number" && typeof e?.at === "number" && Number.isFinite(e.score)) out[k] = { score: e.score, at: e.at };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Most-visited first. `targets` arrive in the base order (tabs and quick links first, then the nav); a pinned
 * page gets a small head start, ties keep the base order.
 */
export function orderTargets<T extends { href: string }>(targets: T[], visits: Visits, pinned: string[], now: number): T[] {
  const score = (t: T) => decayed(visits[routeOf(t.href)], now) + (pinned.includes(t.href) ? PINNED_BONUS : 0);
  return targets
    .map((t, i) => ({ t, i, s: score(t) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.t);
}

// ---- the run ----

export interface WarmRun {
  cancel(): void;
  done: Promise<void>;
}

async function warmData(deps: WarmupDeps, warmers: DataWarmer[], urgent: boolean, alive: () => boolean) {
  for (const w of warmers) {
    if (!alive()) return;
    deps.cache.register(w.key, w.fetch);
    const at = deps.cache.fetchedAt(w.key);
    if (at !== undefined && deps.now() - at < (w.freshMs ?? DEFAULT_FRESH_MS)) continue;
    if (!urgent) await deps.idle();
    if (!alive()) return;
    // One request at a time; a failure only means the page fetches it itself when opened.
    await deps.cache.revalidate(w.key, w.fetch).catch(() => {});
  }
}

/**
 * Warm every target except the current page, one step per idle slot with a short gap between steps, so no
 * single task holds the main thread. Cancel stops after the step in progress.
 */
export function runWarmup(targets: WarmTarget[], deps: WarmupDeps, current: string | null): WarmRun {
  let cancelled = false;
  const alive = () => !cancelled;
  // The page on screen fetches its own data; skip it entirely. "/" and "/today" are different URLs to the
  // router, so only the exact path is skipped.
  const here = current ? pathOnly(current) : null;
  const list = deps.saveData?.() ? targets.slice(0, SAVE_DATA_LIMIT) : targets;
  const done = (async () => {
    for (const target of list) {
      if (cancelled) return;
      await deps.idle();
      if (cancelled) return;
      if (pathOnly(target.href) === here) continue;
      try { deps.prefetchRoute(target.href, target.prefetch); } catch { /* a failed prefetch costs only speed */ }
      if (target.code) {
        await deps.idle();
        if (cancelled) return;
        await target.code().catch(() => {});
      }
      let warmers: DataWarmer[] = [];
      try { warmers = target.data?.() ?? []; } catch { warmers = []; }
      await warmData(deps, warmers, false, alive);
      if (cancelled) return;
      await deps.wait(STEP_GAP_MS);
    }
  })();
  return { cancel: () => { cancelled = true; }, done };
}

// ---- intent: hover / focus / pointer-down on a link ----

let active: { deps: WarmupDeps; targets: Map<string, WarmTarget> } | null = null;

export function configureWarmup(deps: WarmupDeps | null, targets: WarmTarget[] = []) {
  active = deps ? { deps, targets: new Map(targets.map((t) => [routeOf(t.href), t])) } : null;
}

/** Warm one page now (no idle wait): its route payload and its data. */
export function warmRoute(href: string): void {
  if (!active) return;
  const { deps, targets } = active;
  const target = targets.get(routeOf(href));
  try { deps.prefetchRoute(href, target?.prefetch ?? "auto"); } catch { /* ignore */ }
  if (target?.code) void target.code().catch(() => {});
  if (!target?.data) return;
  let warmers: DataWarmer[] = [];
  try { warmers = target.data(); } catch { return; }
  void warmData(deps, warmers, true, () => true);
}

/**
 * Props for a nav <Link>: no automatic viewport prefetch (the scheduled warm-up does it) and an immediate
 * warm on hover, keyboard focus and pointer-down (which lands ~100 ms before the click).
 */
export function navIntentProps(href: string) {
  const warm = () => warmRoute(href);
  return { prefetch: false as const, onMouseEnter: warm, onFocus: warm, onPointerDown: warm };
}

/** One idle slot in the browser: requestIdleCallback where there is one (not Safari), else a short timeout. */
export function browserIdle(timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    const g = globalThis as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void };
    if (typeof g.requestIdleCallback === "function") g.requestIdleCallback(() => resolve(), { timeout: timeoutMs });
    else setTimeout(resolve, 60);
  });
}
