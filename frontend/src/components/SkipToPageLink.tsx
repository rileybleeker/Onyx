"use client";

import { useActiveRoute } from "./FeedContext";
import { skipToPage } from "@/lib/skip-to-page";

/**
 * "Skip to page content", rendered once by AppShell at every width. It sits outside the side panel (which is
 * hidden below 768 px), so phone-width keyboard users have the same bypass as desktop. Rendered first in the
 * Tab order, visually hidden until focused.
 */
export default function SkipToPageLink() {
  const current = useActiveRoute();
  return (
    <a
      href="#page-content"
      onClick={(e) => skipToPage(e, current)}
      className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-control focus:bg-accent focus:px-3 focus:py-2 focus:text-[13px] focus:font-semibold focus:text-on-accent"
    >
      Skip to page content
    </a>
  );
}
