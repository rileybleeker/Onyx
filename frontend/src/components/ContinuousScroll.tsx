"use client";

import { Component, memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/lib/nav";
import {
  AREAS_LOCAL_KEY, AREAS_PREF_KEY, FEED_OFF_SESSION_KEY, areaOrder, feedRouteOf, feedSequence, feedTitle, isFeedExcluded, neighbourOf,
  parseAreaOrder,
  type AreaOrder,
} from "@/lib/feed-order";
import { hasFeedSection, loadFeedSection, loadedFeedSection } from "@/lib/feed-registry";
import { GONE, clientCache, fetchJsonValue } from "@/lib/client-cache";
import { parseUiPref, uiPrefUrl } from "@/lib/ui-preferences";
import { LAYOUT_EVENT, QUICK_ACCESS } from "@/lib/nav-areas";
import { browserIdle } from "@/lib/warmup";
import PageSkeleton from "./PageSkeleton";
import { InFeed, useSetActiveRoute } from "./FeedContext";

/**
 * The continuous scroll: the routed page, then the complete next page, and the next, in Riley's area order
 * (lib/feed-order.ts); scrolling up continues into the previous page. Mounted by AppShell around the routed
 * page. Rules (AGENTS.md, "Continuous scroll"):
 *
 * - The routed page (children) stays exactly as the router renders it and is always mounted. Other pages come
 *   from their FeedSection (lib/feed-registry.ts), loaded and mounted one per idle frame, about 1.5 viewports
 *   before the scroll reaches them (below) or 1 viewport (above).
 * - Only the page in view, its neighbours and pages within 1.5 viewports are mounted; a page more than 3
 *   viewports away is replaced by a placeholder of its measured height.
 * - Nothing jumps: native scroll anchoring is off inside the scroll (Safari has none) and an element near the
 *   top of the screen is kept in place by hand whenever anything above it changes height.
 * - The page covering the middle of the screen is the active page: the address bar (history.replaceState,
 *   no navigation), the page title and useActiveRoute() (sidebar, phone tab bar, command palette) follow it.
 *   A nav click still navigates normally and the scroll starts again from that page.
 * - Mounting a page is a React transition, so rendering a heavy page is split into short slices instead of one
 *   long main-thread task.
 * - sessionStorage[FEED_OFF_SESSION_KEY] = "off" turns the scroll off for that tab (the smoke suite does this:
 *   its checks are about the routed page alone).
 */

// The scroll follows the sidebar as Riley sees it: the Quick access pages (Today, Log) first, then the sections
// (Riley 2026-11-15: "scroll from Today -> Check-in -> Activities"; the check-in now sits inside Log). Personalize's
// saved order still wins over this.
const NAV_HREFS = [
  ...QUICK_ACCESS.filter((h) => NAV_ITEMS.some((i) => i.href === h)),
  ...NAV_ITEMS.map((i) => i.href).filter((h) => !QUICK_ACCESS.includes(h)),
];
const KNOWN = areaOrder(NAV_HREFS, null);
const LABELS = new Map(NAV_ITEMS.map((i) => [i.href, i.label] as const));
const PREF_URL = uiPrefUrl(AREAS_PREF_KEY);
/** Per page load: a history entry rewritten in another document (a reload) is never trusted. */
const DOC_ID = Math.random().toString(36).slice(2);

const BELOW_MARGIN = "0px 0px 150% 0px";
const ABOVE_MARGIN = "100% 0px 0px 0px";
const NEAR_MARGIN = "150% 0px 150% 0px";
const KEEP_MARGIN = "300% 0px 300% 0px";
const MIDDLE_MARGIN = "-50% 0px -50% 0px";
/** Between two pages of the scroll. */
const SEPARATOR = "mt-12 border-t border-border-subtle pt-8";
/** How long the routed page has the network to itself before the neighbouring pages start (unless Riley scrolls). */
const FEED_START_DELAY_MS = 2000;

interface FeedHistoryState {
  doc: string;
  routed: string;
  routedHref: string;
  at: string;
}

function sameOrder(a: AreaOrder | null, b: AreaOrder | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readLocalOrder(): AreaOrder | null {
  try {
    const raw = localStorage.getItem(AREAS_LOCAL_KEY);
    return raw ? parseAreaOrder(JSON.parse(raw), KNOWN) : null;
  } catch {
    return null;
  }
}

function orderFromPref(v: unknown): AreaOrder | null {
  try {
    return parseAreaOrder(parseUiPref(v, AREAS_PREF_KEY).value, KNOWN);
  } catch {
    return null;
  }
}

/** Riley's area order: this device's copy first, else the server preference (cached, revalidated when idle). */
function useAreaOrder(enabled: boolean): AreaOrder | null {
  const [order, setOrder] = useState<AreaOrder | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const apply = (next: AreaOrder | null) => {
      if (alive) setOrder((prev) => (sameOrder(prev, next) ? prev : next));
    };
    const fetcher = async () => {
      const data = await fetchJsonValue(PREF_URL);
      if (data !== GONE) parseUiPref(data, AREAS_PREF_KEY);
      return data;
    };
    clientCache.register(PREF_URL, fetcher);
    const off = clientCache.subscribe(PREF_URL, (v) => {
      if (!readLocalOrder()) apply(v === undefined ? null : orderFromPref(v));
    });
    const local = readLocalOrder();
    if (local) apply(local);
    else void clientCache.read(PREF_URL).then((v) => { if (v !== undefined && !readLocalOrder()) apply(orderFromPref(v)); });
    void browserIdle().then(() => (alive ? clientCache.revalidate(PREF_URL, fetcher) : undefined)).catch(() => {});
    const onStorage = (e: StorageEvent) => {
      if (e.key === AREAS_LOCAL_KEY) apply(readLocalOrder());
    };
    // Personalize saved or adopted the area order on this tab (lib/personalize-store.ts).
    const onLayout = (e: Event) => {
      if ((e as CustomEvent<string>).detail === AREAS_PREF_KEY) apply(readLocalOrder());
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(LAYOUT_EVENT, onLayout);
    return () => {
      alive = false;
      off();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LAYOUT_EVENT, onLayout);
    };
  }, [enabled]);
  return enabled ? order : null;
}

function isContiguous(list: readonly string[], sequence: readonly string[]): boolean {
  let prev = -1;
  for (const r of list) {
    const i = sequence.indexOf(r);
    if (i === -1 || (prev !== -1 && i !== prev + 1)) return false;
    prev = i;
  }
  return true;
}

function docTopOf(el: Element): number {
  return el.getBoundingClientRect().top + window.scrollY;
}

/** The page after `sec` in the scroll (null for the last one: after it comes the bottom edge marker). */
function nextPageOf(sec: Element | null): Element | null {
  const n = sec ? sec.nextElementSibling : null;
  return n && n.hasAttribute("data-feed-route") ? n : null;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

// ---- one page of the scroll --------------------------------------------------------------------------------

function FeedFailed({ route, label }: { route: string; label: string }) {
  return (
    <div className="rounded-card border border-border-subtle bg-surface-card p-5 space-y-3">
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.07em] text-text-secondary">{label}</h2>
      <p className="text-[13px] text-text-secondary">Couldn&apos;t show this page here.</p>
      <Link href={route} className="inline-flex items-center rounded-control border border-border-subtle px-3 py-2 text-[13px] text-text-primary hover:border-border-hover">
        Open {label}
      </Link>
    </div>
  );
}

class SectionBoundary extends Component<{ route: string; label: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    // The route only: never page data.
    console.error("[feed] section failed", this.props.route);
  }
  render() {
    if (this.state.failed) return <FeedFailed route={this.props.route} label={this.props.label} />;
    return this.props.children;
  }
}

/**
 * The page itself. Memoised on the route alone, so nothing the scroll does around it (another page mounting, the
 * list growing, a placeholder's height) re-renders a page that is already on screen: a page renders when it
 * mounts and then only on its own updates.
 */
const FeedPage = memo(function FeedPage({ route, label }: { route: string; label: string }) {
  const Comp = loadedFeedSection(route);
  if (!Comp) return <FeedFailed route={route} label={label} />;
  return (
    <InFeed>
      <SectionBoundary route={route} label={label}>
        <Comp />
      </SectionBoundary>
    </InFeed>
  );
});

const FeedSlot = memo(function FeedSlot({
  route, mounted, height, separated, bind,
}: {
  route: string;
  mounted: boolean;
  /** Not the first page of the scroll: a rule and some space above it. */
  separated: boolean;
  /** Unmounted only: measured height (px) when the page was last mounted; null = never shown (or mounted). */
  height: number | null;
  bind: (el: HTMLElement | null) => void;
}) {
  const label = LABELS.get(route) ?? route;
  const body: ReactNode = mounted ? <FeedPage route={route} label={label} /> : <PageSkeleton title={label} />;
  // Unmounted with a known height: exactly that height, so swapping content for the placeholder moves nothing.
  // svh: the small viewport height does not change while the phone's toolbar slides in and out.
  // Never shown yet: taller than the screen, so one page prepended above the routed page is enough to move the
  // top edge out of reach (a shorter one let a second page be prepended, and loaded, on every direct visit).
  const style = mounted ? { minHeight: "80svh" } : height ? { height, overflow: "hidden" as const } : { minHeight: "120svh" };
  return (
    <section ref={bind} data-feed-route={route} aria-label={label} className={separated ? SEPARATOR : undefined} style={style}>
      {body}
    </section>
  );
});

// ---- the scroll --------------------------------------------------------------------------------------------

/** Read once per tab, after hydration (the server always renders the scroll's frame). */
function useFeedSwitchedOff(): boolean {
  const [off, setOff] = useState(false);
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(FEED_OFF_SESSION_KEY) === "off") setOff(true);
    } catch { /* storage blocked: the scroll stays on */ }
  }, []);
  return off;
}

export default function ContinuousScroll({ children }: { children: ReactNode }) {
  const routerRoute = feedRouteOf(usePathname() || "/");
  const setActiveRoute = useSetActiveRoute();
  const switchedOff = useFeedSwitchedOff();
  const enabled = !switchedOff && !isFeedExcluded(routerRoute) && KNOWN.includes(routerRoute);

  // Reset to just the routed page whenever the router shows another page (a nav click starts again there).
  const [routedKey, setRoutedKey] = useState(routerRoute);
  const [routes, setRoutes] = useState<string[]>([routerRoute]);
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set());
  const [live, setLive] = useState(false);
  if (routedKey !== routerRoute) {
    setRoutedKey(routerRoute);
    setRoutes([routerRoute]);
    setMounted(new Set());
    setLive(false);
  }

  const saved = useAreaOrder(enabled);
  const sequence = useMemo(
    () => (enabled ? feedSequence(NAV_HREFS, saved, routedKey, hasFeedSection) : []),
    [enabled, saved, routedKey],
  );
  const feedOn = sequence.length > 1;

  // Mirrors of state for observer callbacks.
  const routedRef = useRef(routedKey);
  const routesRef = useRef(routes);
  const sequenceRef = useRef(sequence);
  const mountedRef = useRef<Set<string>>(new Set());
  const activeRef = useRef(routedKey);
  const genRef = useRef(0);
  routedRef.current = routedKey;
  routesRef.current = routes;
  sequenceRef.current = sequence;
  mountedRef.current = new Set(mounted);

  const rootRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const heights = useRef(new Map<string, number>());
  const refFns = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const routedHrefRef = useRef<string>(routerRoute);
  const routedTitleRef = useRef<string | null>(null);
  const middle = useRef(new Set<string>());
  const near = useRef(new Set<string>());
  const keep = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const draining = useRef(false);
  /**
   * The element under the top of the screen and the page (section) holding it, with their document positions.
   * The page is the fallback when the element itself is replaced (a skeleton swapped for content, a list
   * re-keyed): the page's wrapper element stays for as long as the page is in the scroll.
   */
  const anchor = useRef<{ el: Element; docTop: number; sec: Element | null; secTop: number; next: Element | null; nextTop: number } | null>(null);
  /** The reader's last scroll direction (the scroll's own corrections do not count) and where it left the page. */
  const dir = useRef<1 | -1>(1);
  const lastY = useRef(0);
  const observers = useRef<{ middle: IntersectionObserver; near: IntersectionObserver; keep: IntersectionObserver; ro: ResizeObserver } | null>(null);
  const edgeObservers = useRef<{ below: IntersectionObserver; above: IntersectionObserver } | null>(null);

  // ---- keep the screen still when something above it changes height ----

  const pickAnchor = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const x = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
    // The first element under the top edge of the visible content (below the phone's fixed header).
    for (const y of [8, 64, 112, 160, 240]) {
      if (y >= window.innerHeight) break;
      const el = document.elementFromPoint(x, y);
      if (el && el !== root && root.contains(el)) {
        const sec = el.closest("[data-feed-route]");
        const next = nextPageOf(sec);
        anchor.current = { el, docTop: docTopOf(el), sec, secTop: sec ? docTopOf(sec) : 0, next, nextTop: next ? docTopOf(next) : 0 };
        return;
      }
    }
    // Nothing of the scroll under the probes (the page at the top is still empty or loading): hold that page
    // itself. Without this a page loading above an empty one pushed it away, and the next one, up to Today.
    const pages = Array.from(root.querySelectorAll(":scope > [data-feed-route]"));
    for (const sec of pages) {
      const r = sec.getBoundingClientRect();
      if (r.bottom > 0) {
        const top = r.top + window.scrollY;
        const next = nextPageOf(sec);
        anchor.current = { el: sec, docTop: top, sec, secTop: top, next, nextTop: next ? docTopOf(next) : 0 };
        return;
      }
    }
    anchor.current = null;
  }, []);

  const correct = useCallback(() => {
    const a = anchor.current;
    if (!a) return;
    const secTop = a.sec && a.sec.isConnected ? docTopOf(a.sec) : null;
    const nextTop = a.next && a.next.isConnected ? docTopOf(a.next) : null;
    let d: number;
    if (a.el.isConnected) {
      const docTop = docTopOf(a.el);
      d = docTop - a.docTop;
      a.docTop = docTop;
    } else if (dir.current < 0 && nextTop !== null) {
      // The element was replaced (a skeleton swapped for the page) while the reader scrolls up into that page:
      // hold the page below it, so the page grows upward and its end is what comes into view.
      d = nextTop - a.nextTop;
    } else if (secTop !== null) {
      // Scrolling down into it: hold its top, so it grows downward from where the reader is.
      d = secTop - a.secTop;
    } else if (nextTop !== null) {
      d = nextTop - a.nextTop;
    } else {
      return;
    }
    if (secTop !== null) a.secTop = secTop;
    if (nextTop !== null) a.nextTop = nextTop;
    // The two-number form is always instant (no smooth scrolling is set anywhere in the app). Document
    // positions do not change with the scroll, so the stored ones stay right after it.
    if (Math.abs(d) >= 1) window.scrollBy(0, d);
    lastY.current = window.scrollY;
  }, []);

  // ---- address bar, title and the active page ----

  const showActive = useCallback((route: string) => {
    const prev = activeRef.current;
    if (prev === route) return;
    activeRef.current = route;
    const routed = routedRef.current;
    setActiveRoute({ routed, active: route === routed ? null : route });
    try {
      if (prev === routed) {
        // Leaving the routed page: remember its own address and title as they are now (the page may have
        // changed its query while in view), to put them back when the scroll returns to it.
        routedHrefRef.current = window.location.pathname + window.location.search;
        routedTitleRef.current = document.title;
      }
      if (route === routed) {
        if (routedTitleRef.current) document.title = routedTitleRef.current;
      } else {
        document.title = feedTitle(LABELS.get(route));
      }
    } catch { /* title is cosmetic */ }
    syncUrl(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setActiveRoute]);

  /**
   * Show the page in view in the address bar without navigating. `back` = also restore the routed page's own
   * address; otherwise the routed page's address is its own business (it may change its query itself).
   */
  function syncUrl(back: boolean) {
    const route = activeRef.current;
    const routed = routedRef.current;
    if (route === routed && !back) return;
    const href = route === routed ? routedHrefRef.current : route;
    try {
      if (window.location.pathname + window.location.search === href) return;
      const state = window.history.state as Record<string, unknown> | null;
      // Without the router's own marker the call would be treated as a navigation: leave the address alone.
      if (!state || !state.__NA) return;
      const onyxFeed: FeedHistoryState = { doc: DOC_ID, routed, routedHref: routedHrefRef.current, at: route };
      window.history.replaceState({ ...state, onyxFeed }, "", href);
    } catch { /* browsers rate-limit replaceState; the next change retries */ }
  }

  // ---- mounting, one page per idle frame ----

  const neighbours = useCallback((route: string): string[] => {
    const list = routesRef.current;
    const i = list.indexOf(route);
    return i === -1 ? [] : [list[i - 1], list[i + 1]].filter((r): r is string => !!r);
  }, []);

  const wanted = useCallback((route: string): boolean => {
    if (route === routedRef.current || !routesRef.current.includes(route)) return false;
    return near.current.has(route) || route === activeRef.current || neighbours(activeRef.current).includes(route);
  }, [neighbours]);

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    const gen = genRef.current;
    try {
      while (queue.current.length) {
        const route = queue.current.shift()!;
        if (gen !== genRef.current) return;
        if (mountedRef.current.has(route) || !wanted(route)) continue;
        await loadFeedSection(route);
        await browserIdle();
        if (gen !== genRef.current) return;
        if (mountedRef.current.has(route) || !wanted(route)) continue;
        mountedRef.current.add(route);
        // A transition: React renders the page in short slices and keeps the screen responsive meanwhile.
        startTransition(() => {
          setMounted((prev) => {
            if (prev.has(route)) return prev;
            const next = new Set(prev);
            next.add(route);
            return next;
          });
        });
        await nextFrame();
      }
    } finally {
      draining.current = false;
      if (gen !== genRef.current && queue.current.length) void drain();
    }
  }, [wanted]);

  const schedule = useCallback((route: string) => {
    if (mountedRef.current.has(route) || queue.current.includes(route)) return;
    queue.current.push(route);
    void drain();
  }, [drain]);

  const prune = useCallback(() => {
    const drop: string[] = [];
    mountedRef.current.forEach((route) => {
      if (!routesRef.current.includes(route) || (!keep.current.has(route) && !wanted(route))) drop.push(route);
    });
    if (!drop.length) return;
    for (const r of drop) mountedRef.current.delete(r);
    setMounted((prev) => {
      const next = new Set(prev);
      for (const r of drop) next.delete(r);
      return next;
    });
  }, [wanted]);

  // ---- growing the scroll ----

  const extend = useCallback((dir: -1 | 1) => {
    setRoutes((list) => {
      const edge = dir === 1 ? list[list.length - 1] : list[0];
      const next = neighbourOf(sequenceRef.current, edge, dir);
      if (!next || list.includes(next)) return list;
      void loadFeedSection(next); // usually warmed already; mounting follows once it is near
      return dir === 1 ? [...list, next] : [next, ...list];
    });
  }, []);

  // ---- per-element observation ----

  const refFor = useCallback((route: string) => {
    let fn = refFns.current.get(route);
    if (!fn) {
      fn = (el: HTMLElement | null) => {
        const prev = els.current.get(route);
        const obs = observers.current;
        if (prev && prev !== el && obs) {
          obs.middle.unobserve(prev);
          obs.near.unobserve(prev);
          obs.keep.unobserve(prev);
          obs.ro.unobserve(prev);
        }
        if (el) {
          el.dataset.feedRoute = route;
          els.current.set(route, el);
          if (obs && prev !== el) {
            obs.middle.observe(el);
            obs.near.observe(el);
            obs.keep.observe(el);
            obs.ro.observe(el);
          }
        } else if (prev) {
          els.current.delete(route);
          middle.current.delete(route);
          near.current.delete(route);
          keep.current.delete(route);
        }
      };
      refFns.current.set(route, fn);
    }
    return fn;
  }, []);

  // A new routed page: forget the old scroll; start once the page has painted and the browser is idle.
  useEffect(() => {
    genRef.current++;
    activeRef.current = routedKey;
    queue.current = [];
    middle.current.clear();
    near.current.clear();
    keep.current.clear();
    anchor.current = null;
    routedTitleRef.current = null;
    setActiveRoute({ routed: null, active: null });
    try {
      routedHrefRef.current = window.location.pathname + window.location.search;
      // Back / forward into an entry this scroll rewrote: the router restored the URL of the page that was in
      // view but the content of the page it started from. Point the router back at that page (its own content).
      const fs = (window.history.state as { onyxFeed?: FeedHistoryState } | null)?.onyxFeed;
      if (fs && fs.doc === DOC_ID && fs.at === routedKey && fs.routed !== routedKey && typeof fs.routedHref === "string") {
        window.history.replaceState({ onyxFeed: null }, "", fs.routedHref);
        return;
      }
    } catch { /* ignore */ }
    // The routed page first (speed budget, 2026-11-15): its own requests get the network, the server and the
    // database to themselves while it loads, and the neighbouring pages start FEED_START_DELAY_MS later (then in an
    // idle slot), or at once when Riley starts to scroll. Mounting them at the first idle slot sent their 20-40
    // reads out together with the opened page's own and slowed those to over a second (perf-timing run 43668835523).
    let alive = true;
    let started = false;
    // Gestures only, not "scroll": the router scrolls to the top on a navigation, which is not Riley scrolling.
    const intents = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
    const start = () => {
      if (!alive || started) return;
      started = true;
      for (const t of intents) window.removeEventListener(t, onIntent);
      setLive(true);
    };
    const onIntent = () => start();
    for (const t of intents) window.addEventListener(t, onIntent, { passive: true });
    const timer = window.setTimeout(() => { void browserIdle().then(start); }, FEED_START_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      for (const t of intents) window.removeEventListener(t, onIntent);
    };
  }, [routedKey, setActiveRoute]);

  // Leaving the scroll altogether (e.g. to the Agents chat): nothing stays highlighted.
  useEffect(() => () => setActiveRoute({ routed: null, active: null }), [setActiveRoute]);

  // Riley changed the order: keep what is on screen if it still fits, else start again from the routed page.
  useEffect(() => {
    setRoutes((list) => (list.length <= 1 || isContiguous(list, sequence) ? list : [routedRef.current]));
  }, [sequence]);

  // Observers: only while the scroll is live and has somewhere to go.
  useEffect(() => {
    if (!live || !feedOn) return;
    const midObs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const r = (e.target as HTMLElement).dataset.feedRoute;
        if (!r) continue;
        if (e.isIntersecting) middle.current.add(r);
        else middle.current.delete(r);
      }
      // The page across the middle of the screen; between two pages, the later one.
      const list = routesRef.current;
      let active: string | null = null;
      for (const r of list) if (middle.current.has(r)) active = r;
      if (!active) return;
      showActive(active);
      for (const r of neighbours(active)) if (r !== routedRef.current) schedule(r);
      prune();
    }, { rootMargin: MIDDLE_MARGIN, threshold: 0 });
    const nearObs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const r = (e.target as HTMLElement).dataset.feedRoute;
        if (!r) continue;
        if (e.isIntersecting) {
          near.current.add(r);
          if (r !== routedRef.current) schedule(r);
        } else near.current.delete(r);
      }
    }, { rootMargin: NEAR_MARGIN, threshold: 0 });
    const keepObs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const r = (e.target as HTMLElement).dataset.feedRoute;
        if (!r) continue;
        if (e.isIntersecting) keep.current.add(r);
        else keep.current.delete(r);
      }
      prune();
    }, { rootMargin: KEEP_MARGIN, threshold: 0 });
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const r = (e.target as HTMLElement).dataset.feedRoute;
        const h = e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).getBoundingClientRect().height;
        if (r && h > 0 && mountedRef.current.has(r)) heights.current.set(r, h);
      }
      correct();
    });
    observers.current = { middle: midObs, near: nearObs, keep: keepObs, ro };
    els.current.forEach((el) => {
      midObs.observe(el);
      nearObs.observe(el);
      keepObs.observe(el);
      ro.observe(el);
    });

    const below = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) extend(1); }, { rootMargin: BELOW_MARGIN, threshold: 0 });
    const above = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) extend(-1); }, { rootMargin: ABOVE_MARGIN, threshold: 0 });
    if (bottomRef.current) below.observe(bottomRef.current);
    if (topRef.current) above.observe(topRef.current);
    edgeObservers.current = { below, above };

    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // The reader's direction, before any correction of ours (corrections move lastY with them).
        const y = window.scrollY;
        if (y !== lastY.current) {
          dir.current = y < lastY.current ? -1 : 1;
          lastY.current = y;
        }
        correct();
        pickAnchor();
        // The router rewrites the address after its own updates (e.g. a refresh): put the page in view back.
        syncUrl(false);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    dir.current = 1;
    lastY.current = window.scrollY;
    pickAnchor();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      midObs.disconnect();
      nearObs.disconnect();
      keepObs.disconnect();
      ro.disconnect();
      below.disconnect();
      above.disconnect();
      observers.current = null;
      edgeObservers.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, feedOn, routedKey, correct, pickAnchor, showActive, neighbours, schedule, prune, extend]);

  // The router writes its own address back after any update of its tree (a refresh, a server action): show the
  // page in view again. Runs after every render; a no-op unless another page is in view and the address differs.
  useEffect(() => {
    if (live && feedOn) syncUrl(false);
  });

  // A new routed page: the element held for the old one means nothing now (the routed wrapper stays across a
  // navigation, so holding it would "correct" the scroll by the height of the pages that were above it). Runs
  // before the correction below, in the same commit.
  useLayoutEffect(() => {
    anchor.current = null;
  }, [routedKey]);

  // After the list grows or shrinks: keep the screen still, then look again at both ends (an observer only
  // reports changes, and an end that is still within reach must keep growing).
  useLayoutEffect(() => {
    correct();
  }, [routes, mounted, correct]);
  useEffect(() => {
    const edges = edgeObservers.current;
    if (!edges) return;
    if (bottomRef.current) { edges.below.unobserve(bottomRef.current); edges.below.observe(bottomRef.current); }
    if (topRef.current) { edges.above.unobserve(topRef.current); edges.above.observe(topRef.current); }
  }, [routes]);

  const style = feedOn ? { overflowAnchor: "none" as const } : undefined;
  return (
    <div ref={rootRef} data-feed-root="" style={style}>
      {feedOn && <div ref={topRef} aria-hidden="true" style={{ height: 1 }} />}
      {routes.map((route, i) =>
        route === routedKey ? (
          // Same key on every page: navigating never remounts the router's own tree.
          <div key="__routed" ref={refFor(route)} data-feed-route={route} className={i > 0 ? SEPARATOR : undefined}>
            {children}
          </div>
        ) : (
          // A mounted page gets no height (its own content sets it): the slot's props stay the same while it is
          // on screen, so the memo holds and the page is not re-rendered by the scroll.
          <FeedSlot
            key={route}
            route={route}
            mounted={mounted.has(route)}
            height={mounted.has(route) ? null : heights.current.get(route) ?? null}
            separated={i > 0}
            bind={refFor(route)}
          />
        ),
      )}
      {feedOn && <div ref={bottomRef} aria-hidden="true" style={{ height: 1 }} />}
    </div>
  );
}
