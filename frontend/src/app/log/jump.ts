// Moving around the Log screen (AGENTS.md "Log screen"): the Say it box's "go to section" buttons and links such
// as /log#log-part-supplements (Today's quick links). Browser-only; no React, no request.

/** The Log screen's parts (LogClient's <Part id>s), in their default order. */
export const LOG_PART_IDS = ["say-it", "check-in", "journal", "supplements", "drinks", "uber-eats", "weight", "reading"] as const;
export type LogPartId = (typeof LOG_PART_IDS)[number];

/** The id of the zero-height anchor LogClient puts at the top of each part; `/log#<this>` opens the screen there. */
export const logAnchorId = (part: LogPartId) => `log-part-${part}`;

/** The part a `#log-part-…` hash names, or null. */
export function partFromHash(hash: string): LogPartId | null {
  let id = hash.replace(/^#/, "");
  try {
    id = decodeURIComponent(id);
  } catch {
    return null;
  }
  return LOG_PART_IDS.find((p) => logAnchorId(p) === id) ?? null;
}

/** A link to one part of the Log screen. */
export const logHref = (part: LogPartId) => `/log#${logAnchorId(part)}`;

/**
 * Scroll to a part's anchor. With `settle`, keep it at the top while the sections above it grow from their
 * skeletons (the screen just opened), until Riley scrolls, touches or types, or ~2.5 s pass.
 * Returns false when the part is not on the screen (hidden in Personalize).
 */
export function jumpToLogPart(part: LogPartId, { settle = false, smooth = false }: { settle?: boolean; smooth?: boolean } = {}): boolean {
  if (typeof document === "undefined") return false;
  const anchor = document.getElementById(logAnchorId(part));
  if (!anchor) return false;
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  anchor.scrollIntoView({ block: "start", behavior: smooth && !reduce ? "smooth" : "auto" });
  if (!settle || typeof ResizeObserver === "undefined") return true;

  const root = anchor.closest<HTMLElement>("[data-log-root]") ?? document.body;
  let done = false;
  const user = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  const stop = () => {
    if (done) return;
    done = true;
    ro.disconnect();
    clearTimeout(timer);
    for (const e of user) window.removeEventListener(e, stop, true);
  };
  const ro = new ResizeObserver(() => {
    if (!done && anchor.isConnected) anchor.scrollIntoView({ block: "start" });
  });
  ro.observe(root);
  const timer = setTimeout(stop, 2500);
  for (const e of user) window.addEventListener(e, stop, { capture: true, passive: true });
  return true;
}
