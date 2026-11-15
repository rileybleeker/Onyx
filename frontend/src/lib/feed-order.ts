/**
 * Continuous scroll (components/ContinuousScroll.tsx): which pages follow each other, in which order.
 *
 * The scroll is the complete pages one after another: below the end of Today the whole next page continues,
 * and so on. The order is Riley's area order (the UI preference "layout.areas", owned by Personalize) when one
 * is saved, else the nav order (lib/nav.ts) with Today first. Areas marked hidden are skipped, pages without a
 * FeedSection (lib/feed-registry.ts) are skipped, and the routed page always keeps its own place.
 *
 * Pure and import-free (tests/feed-order.test.cjs runs it in plain node).
 */

/** UI preference key (pds.ui_preferences via /api/ui/preferences) holding Riley's area order. */
export const AREAS_PREF_KEY = "layout.areas";
/** The same value as this device last saved it (Personalize keeps a local copy; an "onyx" key, wiped on sign-out). */
export const AREAS_LOCAL_KEY = "onyx.layout.areas";

/**
 * sessionStorage key: "off" turns the scroll off in that tab (only the routed page is drawn). Set by the smoke
 * suite (e2e/smoke.spec.ts), whose checks are about the routed page alone; nothing in the app sets it.
 */
export const FEED_OFF_SESSION_KEY = "onyx.feed";

/** Routes that never join the scroll and never get one: sign-in, the full-screen chats, account and install. */
export const FEED_EXCLUDED: readonly string[] = ["/login", "/auth", "/agents", "/chat", "/account", "/install"];

/** A route key without query or hash; "/" is Today. */
export function feedRouteOf(href: string): string {
  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  if (path === "" || path === "/") return "/today";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export function isFeedExcluded(route: string): boolean {
  const r = feedRouteOf(route);
  return FEED_EXCLUDED.some((x) => r === x || r.startsWith(x + "/"));
}

/** Riley's order of the areas, as hrefs. `hidden` = left out of the scroll (the page itself still exists). */
export interface AreaOrder {
  order: string[];
  hidden: string[];
}

/** Ways an area can be named in a stored value: "/analytics/hrv", "analytics/hrv", "analytics.hrv", "analytics-hrv". */
export function areaIdsOf(href: string): string[] {
  const bare = href.replace(/^\/+/, "");
  return [href, bare, bare.replace(/\//g, "."), bare.replace(/\//g, "-")];
}

function hrefFor(id: unknown, known: readonly string[]): string | null {
  if (typeof id !== "string" || !id) return null;
  if (known.length === 0) return id.startsWith("/") ? feedRouteOf(id) : null;
  for (const href of known) if (areaIdsOf(href).includes(id)) return href;
  return null;
}

function idList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Read a stored area order. Accepted shapes (the first one that fits wins; anything else is null = default):
 * - { order: [id], hidden: [id] }                                  (like overview.cards)
 * - { v: 1, grids: { main: { order: [id], hide: { id: true } } } }  (a Personalize page layout)
 * - [ id | { href | id, hidden?: boolean } ]                        (an ordered list with hidden flags)
 * - { l: <any of the above> }                                      (Personalize's local copy)
 * An id is an href or one of areaIdsOf(href). Ids that name no known page are dropped.
 */
export function parseAreaOrder(raw: unknown, known: readonly string[] = []): AreaOrder | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object" && !Array.isArray(raw) && "l" in (raw as Record<string, unknown>)) {
    return parseAreaOrder((raw as { l: unknown }).l, known);
  }
  const order: string[] = [];
  const hidden: string[] = [];
  const add = (id: unknown, hide: boolean) => {
    const href = hrefFor(id, known);
    if (!href || order.includes(href)) return;
    order.push(href);
    if (hide) hidden.push(href);
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object") {
        const o = item as { href?: unknown; id?: unknown; hidden?: unknown };
        add(o.href ?? o.id, o.hidden === true);
      } else add(item, false);
    }
    return order.length ? { order, hidden } : null;
  }
  if (typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.order)) {
    const hide = new Set(idList(r.hidden).map((id) => hrefFor(id, known)).filter((h): h is string => !!h));
    for (const id of r.order) {
      const href = hrefFor(id, known);
      add(id, !!href && hide.has(href));
    }
    // A hidden area missing from the order still counts as hidden.
    for (const h of Array.from(hide)) if (!hidden.includes(h)) hidden.push(h);
    return order.length || hidden.length ? { order, hidden } : null;
  }
  const grid = (r.grids as Record<string, unknown> | undefined)?.main as { order?: unknown; hide?: unknown } | undefined;
  if (grid && typeof grid === "object") {
    const hideMap = grid.hide && typeof grid.hide === "object" ? (grid.hide as Record<string, unknown>) : {};
    const hiddenHrefs = new Set<string>();
    for (const [id, v] of Object.entries(hideMap)) {
      const href = hrefFor(id, known);
      if (href && v === true) hiddenHrefs.add(href);
    }
    for (const id of idList(grid.order)) {
      const href = hrefFor(id, known);
      add(id, !!href && hiddenHrefs.has(href));
    }
    for (const h of Array.from(hiddenHrefs)) if (!hidden.includes(h)) hidden.push(h);
    return order.length || hidden.length ? { order, hidden } : null;
  }
  return null;
}

/**
 * The full area order: Riley's saved order of the known pages, then any page the saved order does not name
 * (a page added later) after its nearest predecessor in the default order. Default = `navHrefs` with Today
 * first. Excluded routes never appear.
 */
export function areaOrder(navHrefs: readonly string[], saved: AreaOrder | null): string[] {
  const base: string[] = [];
  for (const h of ["/today", ...navHrefs]) {
    const r = feedRouteOf(h);
    if (!isFeedExcluded(r) && !base.includes(r)) base.push(r);
  }
  if (!saved || saved.order.length === 0) return base;
  const known = new Set(base);
  const out: string[] = [];
  for (const h of saved.order) if (known.has(h) && !out.includes(h)) out.push(h);
  for (let i = 0; i < base.length; i++) {
    const h = base[i];
    if (out.includes(h)) continue;
    // After the nearest default predecessor that is already placed; first when none is.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const p = out.indexOf(base[j]);
      if (p !== -1) { at = p + 1; break; }
    }
    out.splice(at, 0, h);
  }
  return out;
}

/**
 * The pages of the scroll around the routed page, in order: every area that has a FeedSection and is not
 * hidden, plus the routed page in its own place (even when it is hidden or has no FeedSection). Empty when
 * the routed page is excluded or is not an area at all (no scroll on that page).
 */
export function feedSequence(
  navHrefs: readonly string[],
  saved: AreaOrder | null,
  routed: string,
  hasSection: (route: string) => boolean,
): string[] {
  const here = feedRouteOf(routed);
  if (isFeedExcluded(here)) return [];
  const order = areaOrder(navHrefs, saved);
  if (!order.includes(here)) return [];
  const hidden = new Set(saved?.hidden ?? []);
  return order.filter((r) => r === here || (!hidden.has(r) && hasSection(r)));
}

/** The page before / after `route` in the sequence, or null at either end. */
export function neighbourOf(sequence: readonly string[], route: string, step: -1 | 1): string | null {
  const i = sequence.indexOf(route);
  if (i === -1) return null;
  return sequence[i + step] ?? null;
}

/** Browser tab title for a page of the scroll (the routed page keeps the title its server gave it). */
export function feedTitle(label: string | undefined): string {
  return label ? `${label} - Onyx` : "Onyx";
}
