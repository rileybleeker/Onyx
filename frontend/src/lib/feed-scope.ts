"use client";

import { createContext, useContext } from "react";

/**
 * The page of the continuous scroll a component is drawn in (components/ContinuousScroll.tsx provides it around each
 * FeedSection): "/log" for the Log page drawn below Today, null on the routed page and outside the scroll. Forms
 * report their unsaved work under it (lib/use-unsaved-work.ts), so the scroll never unmounts a page that holds some.
 * Its own tiny module (React only) so the form hooks do not pull in the router.
 */
export const FeedScopeContext = createContext<string | null>(null);

export function useFeedScope(): string | null {
  return useContext(FeedScopeContext);
}
