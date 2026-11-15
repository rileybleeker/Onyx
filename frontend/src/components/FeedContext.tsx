"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { feedRouteOf } from "@/lib/feed-order";

/**
 * Which page is "the one in view" while the continuous scroll (components/ContinuousScroll.tsx) moves through
 * the pages. The sidebar, the phone's tab bar and drawer and the command palette highlight useActiveRoute()
 * instead of the router's pathname. Outside the scroll (or on the routed page itself) it is the pathname.
 */
export interface ActiveRouteState {
  /** The routed page the scroll started from (feedRouteOf(pathname) when it was set). */
  routed: string | null;
  /** The page in view when it is not the routed page; null = the routed page. */
  active: string | null;
}

const EMPTY: ActiveRouteState = { routed: null, active: null };
const ActiveCtx = createContext<ActiveRouteState>(EMPTY);
const SetActiveCtx = createContext<(next: ActiveRouteState) => void>(() => {});

export function ActiveRouteProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ActiveRouteState>(EMPTY);
  // Stable: the scroll's effects depend on it.
  const set = useCallback((next: ActiveRouteState) => {
    setState((prev) => (prev.routed === next.routed && prev.active === next.active ? prev : next));
  }, []);
  return (
    <SetActiveCtx.Provider value={set}>
      <ActiveCtx.Provider value={state}>{children}</ActiveCtx.Provider>
    </SetActiveCtx.Provider>
  );
}

/** The page in view: a route key like "/sleep" ("/" counts as "/today"). */
export function useActiveRoute(): string {
  const routed = feedRouteOf(usePathname() || "/");
  const s = useContext(ActiveCtx);
  // A stale value from before a navigation never wins over the new page.
  return s.active && s.routed === routed ? s.active : routed;
}

export function useSetActiveRoute(): (next: ActiveRouteState) => void {
  return useContext(SetActiveCtx);
}

/**
 * Smoothly scroll a nav list (found by `selector`) so its aria-current item is visible whenever `active`
 * changes. Only the list scrolls, never the page; nothing happens while the list is hidden (phones).
 */
export function useRevealActiveNavItem(selector: string, active: string): void {
  useEffect(() => {
    const list = document.querySelector<HTMLElement>(selector);
    if (!list || list.clientHeight === 0) return;
    const link = list.querySelector<HTMLElement>('[aria-current="page"]');
    if (!link) return;
    const box = list.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    if (item.top >= box.top && item.bottom <= box.bottom) return;
    const top = list.scrollTop + (item.top - box.top) - (list.clientHeight - item.height) / 2;
    list.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [selector, active]);
}

// ---- inside a page of the scroll ---------------------------------------------------------------------------

const InFeedCtx = createContext(false);

/** Wraps a FeedSection: the page renders as one page of the continuous scroll, not as the routed page. */
export function InFeed({ children }: { children: ReactNode }) {
  return <InFeedCtx.Provider value={true}>{children}</InFeedCtx.Provider>;
}

export function useInFeed(): boolean {
  return useContext(InFeedCtx);
}

/**
 * The page heading's test id: "page-heading" on the routed page, "feed-page-heading" inside the scroll, so the
 * smoke suite (which looks for page-heading on the routed page) never finds several.
 */
export function usePageHeadingTestId(): "page-heading" | "feed-page-heading" {
  return useContext(InFeedCtx) ? "feed-page-heading" : "page-heading";
}
