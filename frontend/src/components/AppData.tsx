"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { AGENTS_API, agentsApi, type InboxResponse } from "@/lib/agents-api";
import { NAV_ITEMS } from "@/lib/nav";
import {
  CACHE_KEYS, clientCache, fetchJsonValue, reportSessionEnded, sessionEnded, setSessionEndedHandler, wipeClientData, writeInvalidates,
} from "@/lib/client-cache";
import { IdbCacheBackend, idbAvailable } from "@/lib/client-cache-idb";
import {
  REWARM_AFTER_MS, REWARM_EVERY_MS, VISITS_KEY, browserIdle, configureWarmup, orderTargets, parseVisits, recordVisit, routeOf, runWarmup,
  type DataWarmer, type PrefetchMode, type WarmRun, type WarmTarget, type WarmupDeps,
} from "@/lib/warmup";

/**
 * App-wide data plumbing, mounted once by AppShell for signed-in pages:
 * 1. attaches the persisted client cache for the signed-in user (another user or no session = wipe);
 * 2. watches fetch responses: a 401 or a redirect to /login wipes the client, a successful write invalidates
 *    the cache entries it changed;
 * 3. runs the background warm-up (lib/warmup.ts) after the first paint and again when the app comes back
 *    after a while, ordered by how often each page is opened.
 */

// Tabs, quick links and the log sheet first (in that order), then the rest of the nav.
const PINNED = ["/today", "/check-in", "/analytics/hrv", "/agents", "/supplements", "/habits", "/nutrition"];

// Server-rendered pages whose writes update the screen optimistically without router.refresh(): a full
// prefetch could later show the pre-write server answer, so only their code and loading skeleton are warmed.
const AUTO_ONLY = new Set(["/health", "/health/records", "/orders", "/procurement"]);

const json = (url: string): DataWarmer => ({ key: url, fetch: () => fetchJsonValue(url) });

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const inboxWarmer: DataWarmer = { key: CACHE_KEYS.agentsInbox, fetch: () => agentsApi.inbox() };

// GET reads each page's client makes when it opens. Same keys and the same raw values the pages store.
// /api/experiments/today is deliberately absent: reading it stamps the arm as revealed, so only Today asks.
const DATA: Record<string, () => DataWarmer[]> = {
  "/today": () => {
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 12);
    return [
      inboxWarmer,
      json("/api/reading"),
      json("/api/urgent-email"),
      json(`/api/calendar/events?from=${localDay(today)}&to=${localDay(tomorrow)}`),
      json("/api/orders/summary"),
      json("/api/procurement/renewals/summary"),
      json("/api/finance/alerts"),
    ];
  },
  "/check-in": () => [json("/api/habits/checkin")],
  "/agents": () => {
    const inbox = clientCache.peek<InboxResponse>(CACHE_KEYS.agentsInbox);
    const threads = Array.isArray(inbox?.threads)
      ? [...inbox.threads].sort((a, b) => (b.last?.id ?? 0) - (a.last?.id ?? 0)).slice(0, 3).map((t) => t.id)
      : [];
    return [
      inboxWarmer,
      ...threads.map((thread) => ({ key: CACHE_KEYS.agentsThread(thread), fetch: () => agentsApi.messages({ thread, limit: 60 }) })),
    ];
  },
  "/habits": () => [
    json("/api/habits/list"),
    // lib/queries is loaded on demand: it is large and would otherwise ride in every page's first load.
    { key: CACHE_KEYS.habitsJournal, fetch: () => import("@/lib/queries").then((q) => q.getHabitJournal(365)), freshMs: 5 * 60_000 },
    { key: CACHE_KEYS.habitsHistory, fetch: () => import("@/lib/queries").then((q) => q.getHabitMetadataHistory()), freshMs: 5 * 60_000 },
  ],
  "/reading": () => [json("/api/reading")],
  "/status": () => [json("/api/status")],
};

// The `dynamic(..., { ssr: false })` client chunks the router prefetch does not load (measured on production
// 2026-11-15: HRV fetched three chunks on click and drew its charts ~0.8 s later). Same modules as the
// pages' own dynamic imports, so webpack serves the page from the chunk loaded here.
const CODE: Record<string, () => Promise<unknown>> = {
  "/activities": () => import("@/app/activities/ActivitiesClient"),
  "/analytics/hrv": () => import("@/app/analytics/hrv/HrvAnalysisClient"),
  "/bland-altman": () => import("@/app/bland-altman/BlandAltmanClient"),
  "/caffeine": () => import("@/app/caffeine/CaffeineClient"),
  "/habits": () => import("@/app/habits/HabitsClient"),
  "/health/records": () => import("@/app/health/records/LabTrendChart"),
  "/nutrition": () => import("@/app/nutrition/NutritionClient"),
  "/nyc": () => import("@/app/nyc/NycClient"),
  "/reading": () => import("@/app/reading/BurnupChart"),
  "/sleep": () => import("@/app/sleep/SleepClient"),
  "/spotify": () => import("@/app/spotify/SpotifyClient"),
  "/supplements": () => import("@/app/supplements/SupplementsClient"),
};

export function warmTargets(): WarmTarget[] {
  const hrefs = [...PINNED, ...NAV_ITEMS.map((i) => i.href).filter((h) => !PINNED.includes(h))];
  return hrefs.map((href) => ({ href, prefetch: (AUTO_ONLY.has(href) ? "auto" : "full") as PrefetchMode, data: DATA[href], code: CODE[href] }));
}

let fetchObserved = false;
// Set when the session ended (401 / redirect to /login): the warm-up stops asking for anything.
let sessionOver = false;
function observeFetch() {
  if (fetchObserved || typeof window === "undefined") return;
  fetchObserved = true;
  const original = window.fetch.bind(window);
  const agentsOrigin = new URL(AGENTS_API).origin;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, window.location.href);
      const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
      const own = url.origin === window.location.origin;
      if (own && url.pathname.startsWith("/api/") && sessionEnded(res)) reportSessionEnded();
      else if (res.ok && method !== "GET" && method !== "HEAD" && (own || url.origin === agentsOrigin)) {
        clientCache.invalidate(writeInvalidates(url.pathname));
      }
    } catch { /* observing never breaks a request */ }
    return res;
  };
}

function readVisits() {
  try { return parseVisits(localStorage.getItem(VISITS_KEY)); } catch { return {}; }
}

export default function AppData() {
  const router = useRouter();
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  // Cache scope, session-end handling and write invalidation.
  useEffect(() => {
    let alive = true;
    const supabase = createSupabaseBrowser();
    const backend = new IdbCacheBackend();
    setSessionEndedHandler(() => {
      sessionOver = true;
      configureWarmup(null);
      void wipeClientData().then(() => { if (alive) clientCache.detach(); });
    });
    observeFetch();
    void (async () => {
      let userId: string | null = null;
      let unsure = false;
      try {
        const { data, error } = await supabase.auth.getSession();
        userId = data.session?.user?.id ?? null;
        unsure = !!error; // e.g. offline with an expired token: not proof of a sign-out
      } catch { unsure = true; }
      if (!alive) return;
      if (!userId) {
        if (unsure) clientCache.detach();
        else await wipeClientData().then(() => clientCache.detach());
        return;
      }
      // A signed-in session (again, after a session end earlier in this tab): warm-up and cache back on.
      sessionOver = false;
      if (!idbAvailable()) { clientCache.detach(); return; }
      await clientCache.attach(backend, userId);
    })();
    const { data: auth } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") void wipeClientData().then(() => clientCache.detach());
    });
    // The daily sweep (sweep() itself skips until 24 h have passed since the last one).
    const sweep = setInterval(() => { void clientCache.sweep(); }, 3_600_000);
    return () => {
      alive = false;
      auth.subscription.unsubscribe();
      clearInterval(sweep);
    };
  }, []);

  // Order the warm-up by use: count page opens (decayed over two weeks; this app's key, wiped on sign-out).
  useEffect(() => {
    const route = routeOf(pathname);
    if (!route.startsWith("/")) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(VISITS_KEY, JSON.stringify(recordVisit(readVisits(), route, Date.now()))); } catch { /* private mode */ }
    }, 2000);
    return () => clearTimeout(t);
  }, [pathname]);

  // The warm-up: after the first page has painted and loaded, then again after the app was away a while.
  useEffect(() => {
    const deps: WarmupDeps = {
      prefetchRoute: (href, mode) => {
        if (!sessionOver) router.prefetch(href, { kind: mode } as unknown as Parameters<typeof router.prefetch>[1]);
      },
      cache: {
        fetchedAt: (key) => clientCache.fetchedAt(key),
        register: (key, fetcher) => clientCache.register(key, fetcher),
        revalidate: (key, fetcher) => (sessionOver ? Promise.resolve(undefined) : clientCache.revalidate(key, fetcher)),
      },
      now: () => Date.now(),
      idle: () => browserIdle(),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      saveData: () => !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData,
    };
    const targets = warmTargets();
    configureWarmup(deps, targets);
    for (const t of targets) for (const w of t.data?.() ?? []) clientCache.register(w.key, w.fetch);
    let run: WarmRun | null = null;
    let hiddenAt = 0;
    const start = () => {
      run?.cancel();
      if (sessionOver) return;
      run = runWarmup(orderTargets(targets, readVisits(), PINNED, Date.now()), deps, pathRef.current);
    };
    // Let the opened page finish its own requests first.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const afterLoad = () => { timer = setTimeout(() => { void browserIdle().then(start); }, 1200); };
    if (document.readyState === "complete") afterLoad();
    else window.addEventListener("load", afterLoad, { once: true });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > REWARM_AFTER_MS) {
        hiddenAt = 0;
        timer = setTimeout(() => { void browserIdle().then(start); }, 1500);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    // Router prefetches go stale after 5 minutes: while Riley is actively using the app, warm again every
    // 5 minutes (only what expired is refetched). An idle or hidden window costs nothing.
    let lastActive = Date.now();
    let lastRun = Date.now();
    const active = () => { lastActive = Date.now(); };
    window.addEventListener("pointerdown", active, { passive: true });
    window.addEventListener("keydown", active);
    const periodic = setInterval(() => {
      if (document.visibilityState !== "visible" || lastActive < lastRun) return;
      lastRun = Date.now();
      void browserIdle().then(start);
    }, REWARM_EVERY_MS);
    return () => {
      run?.cancel();
      if (timer) clearTimeout(timer);
      clearInterval(periodic);
      window.removeEventListener("pointerdown", active);
      window.removeEventListener("keydown", active);
      window.removeEventListener("load", afterLoad);
      document.removeEventListener("visibilitychange", onVisibility);
      configureWarmup(null);
    };
  }, [router]);

  return null;
}

/** Rendered on /login (no session by construction: middleware sends a signed-in visitor to Today). */
export function SignedOutWipe() {
  useEffect(() => { void wipeClientData(); }, []);
  return null;
}
