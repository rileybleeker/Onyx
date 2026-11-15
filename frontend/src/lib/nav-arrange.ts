/**
 * Personalize mode: rearranging the side panel / phone drawer. Items move within their section, sections move as a
 * block; either way the result is stored as the app's single area order (`layout.areas`, `grids.main.order`), the
 * order the continuous scroll follows too. Also pins (Quick access), hiding from the side panel or from the scroll,
 * and the phone bottom bar's tabs, each a grid entry of the same layout. Loaded only with the editor.
 *
 * Pure (tests/nav-areas.test.cjs).
 */

import {
  MORE_TAB, NAV_HIDE_GRID, PIN_GRID, QUICK_ACCESS, TABS_GRID, areaId, areaPrefsOf, arrangeNav, navDefaultIds, orderNav,
  type NavSectionLike,
} from "./nav-areas";
import type { GridOverlay, PageLayout, PartDef } from "./personalize-layout";
import { moveBefore, normalizeLayout, setGridOrder, setPartHidden } from "./personalize-ops";

function defs(sections: readonly NavSectionLike[]): PartDef[] {
  return navDefaultIds(sections).map((id) => ({ id, title: id, width: "full", hidden: false, collapsed: false }));
}

function savedOrder(layout: PageLayout): string[] | null {
  const o = layout.grids?.main?.order;
  return o && o.length ? o : null;
}

function store(layout: PageLayout, sections: readonly NavSectionLike[], ordered: { items: { href: string }[] }[]): PageLayout {
  const flat = ordered.flatMap((s) => s.items.map((i) => areaId(i.href)));
  return setGridOrder(layout, "main", defs(sections), flat);
}

/** `href` moved to just before `beforeHref` in its own section (null: to the end of its section). */
export function moveNavItem(layout: PageLayout, sections: readonly NavSectionLike[], href: string, beforeHref: string | null): PageLayout {
  const ordered = orderNav(sections, savedOrder(layout));
  const sec = ordered.find((s) => s.items.some((i) => i.href === href));
  if (!sec) return layout;
  if (beforeHref !== null && !sec.items.some((i) => i.href === beforeHref)) return layout; // only within a section
  const hrefs = moveBefore(sec.items.map((i) => i.href), href, beforeHref);
  const byHref = new Map(sec.items.map((i) => [i.href, i] as const));
  sec.items = hrefs.map((h) => byHref.get(h) as (typeof sec.items)[number]);
  return store(layout, sections, ordered);
}

/** `href` moved `delta` places among the items of its section shown in the list (`shown`: hrefs on screen). */
export function moveNavItemBy(
  layout: PageLayout,
  sections: readonly NavSectionLike[],
  href: string,
  delta: number,
  shown?: (href: string) => boolean,
): PageLayout {
  const ordered = orderNav(sections, savedOrder(layout));
  const sec = ordered.find((s) => s.items.some((i) => i.href === href));
  if (!sec) return layout;
  const list = sec.items.filter((i) => !shown || shown(i.href)).map((i) => i.href);
  const at = list.indexOf(href);
  const to = at + delta;
  if (at === -1 || to < 0 || to >= list.length || delta === 0) return layout;
  const beforeHref = delta < 0 ? list[to] : list[to + 1] ?? null;
  if (beforeHref === null) {
    // Past the last shown item: right after it.
    const all = sec.items.map((i) => i.href);
    const after = all.indexOf(list[to]);
    return moveNavItem(layout, sections, href, all[after + 1] ?? null);
  }
  return moveNavItem(layout, sections, href, beforeHref);
}

/** Section `index` (its index in `sections`) moved before section `beforeIndex` (null: to the end). */
export function moveNavSection(layout: PageLayout, sections: readonly NavSectionLike[], index: number, beforeIndex: number | null): PageLayout {
  const ordered = orderNav(sections, savedOrder(layout));
  const ids = moveBefore(ordered.map((s) => String(s.index)), String(index), beforeIndex === null ? null : String(beforeIndex));
  const byId = new Map(ordered.map((s) => [String(s.index), s] as const));
  return store(layout, sections, ids.map((id) => byId.get(id) as (typeof ordered)[number]));
}

/** Section `index` moved `delta` places among the sections shown (`shown`: section indices on screen). */
export function moveNavSectionBy(
  layout: PageLayout,
  sections: readonly NavSectionLike[],
  index: number,
  delta: number,
  shown?: (index: number) => boolean,
): PageLayout {
  const ordered = orderNav(sections, savedOrder(layout));
  const list = ordered.filter((s) => !shown || shown(s.index)).map((s) => s.index);
  const at = list.indexOf(index);
  const to = at + delta;
  if (at === -1 || to < 0 || to >= list.length || delta === 0) return layout;
  if (delta < 0) return moveNavSection(layout, sections, index, list[to]);
  const next = list[to + 1];
  if (next !== undefined) return moveNavSection(layout, sections, index, next);
  const all = ordered.map((s) => s.index);
  const after = all[all.indexOf(list[to]) + 1];
  return moveNavSection(layout, sections, index, after ?? null);
}

// ---- Quick access (pins), hidden pages, bottom-bar tabs (all in layout.areas, see lib/nav-areas.ts) ----------

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function withAreaGrid(layout: PageLayout, id: string, grid: GridOverlay | null): PageLayout {
  const grids = { ...(layout.grids ?? {}) };
  if (grid && Object.keys(grid).length) grids[id] = grid;
  else delete grids[id];
  return normalizeLayout({ ...layout, grids });
}

/** The pinned pages (hrefs, in Quick access order). */
export function pinnedOf(layout: PageLayout, sections: readonly NavSectionLike[]): string[] {
  return arrangeNav(sections, areaPrefsOf(layout)).pinned.map((i) => i.href);
}

/** Store `hrefs` as the Quick access pages, in that order (the default pins store nothing). */
export function setPinnedList(layout: PageLayout, sections: readonly NavSectionLike[], hrefs: readonly string[]): PageLayout {
  const all = navDefaultIds(sections);
  const defaults = QUICK_ACCESS.map(areaId).filter((id) => all.includes(id));
  const ids: string[] = [];
  for (const h of hrefs) {
    const id = areaId(h);
    if (all.includes(id) && !ids.includes(id)) ids.push(id);
  }
  const hide: Record<string, boolean> = {};
  for (const id of all) {
    const d = defaults.includes(id);
    const p = ids.includes(id);
    if (d && !p) hide[id] = true;
    else if (!d && p) hide[id] = false;
  }
  if (!Object.keys(hide).length && sameIds(ids, defaults)) return withAreaGrid(layout, PIN_GRID, null);
  return withAreaGrid(layout, PIN_GRID, { ...(ids.length ? { order: ids } : {}), ...(Object.keys(hide).length ? { hide } : {}) });
}

/** Pin `href` to Quick access (at the end, or before `beforeHref`), or unpin it. */
export function setPinned(
  layout: PageLayout,
  sections: readonly NavSectionLike[],
  href: string,
  pinned: boolean,
  beforeHref: string | null = null,
): PageLayout {
  const cur = pinnedOf(layout, sections).filter((h) => h !== href);
  if (!pinned) return setPinnedList(layout, sections, cur);
  // A page hidden from the side panel comes back when it is pinned.
  const shown = setNavHidden(layout, sections, href, false);
  const at = beforeHref === null ? -1 : cur.indexOf(beforeHref);
  const next = at === -1 ? [...cur, href] : [...cur.slice(0, at), href, ...cur.slice(at)];
  return setPinnedList(shown, sections, next);
}

/** `href` moved `delta` places within Quick access. */
export function movePinnedBy(layout: PageLayout, sections: readonly NavSectionLike[], href: string, delta: number): PageLayout {
  const cur = pinnedOf(layout, sections);
  const at = cur.indexOf(href);
  const to = at + delta;
  if (at === -1 || delta === 0 || to < 0 || to >= cur.length) return layout;
  const next = cur.slice();
  next.splice(at, 1);
  next.splice(to, 0, href);
  return setPinnedList(layout, sections, next);
}

/** Hide `href` from the side panel and the phone drawer (it is unpinned too), or show it again. */
export function setNavHidden(layout: PageLayout, sections: readonly NavSectionLike[], href: string, hidden: boolean): PageLayout {
  const id = areaId(href);
  const cur = layout.grids?.[NAV_HIDE_GRID]?.hide ?? {};
  if ((cur[id] === true) === hidden) return layout;
  const hide = { ...cur };
  if (hidden) hide[id] = true;
  else delete hide[id];
  const base = hidden ? setPinnedList(layout, sections, pinnedOf(layout, sections).filter((h) => h !== href)) : layout;
  return withAreaGrid(base, NAV_HIDE_GRID, Object.keys(hide).length ? { hide } : null);
}

/** Leave `href` out of the continuous scroll (and its card on Today), or put it back. */
export function setScrollHidden(layout: PageLayout, sections: readonly NavSectionLike[], href: string, hidden: boolean): PageLayout {
  return setPartHidden(layout, "main", defs(sections), areaId(href), hidden);
}

/**
 * Store the phone bottom bar's four slots (hrefs, or MORE_TAB for the More menu) around Log. `defaults` = the
 * default slots (lib/mobile-tabs.ts); the default bar stores nothing.
 */
export function setTabSlots(layout: PageLayout, slots: readonly string[], defaults: readonly string[]): PageLayout {
  if (sameIds(slots, defaults)) return withAreaGrid(layout, TABS_GRID, null);
  return withAreaGrid(layout, TABS_GRID, { order: slots.map((h) => (h === MORE_TAB ? MORE_TAB : areaId(h))) });
}
