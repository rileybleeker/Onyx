/**
 * Personalize mode: rearranging the side panel / phone drawer. Items move within their section, sections move as a
 * block; either way the result is stored as the app's single area order (`layout.areas`, `grids.main.order`), the
 * order the continuous scroll follows too. Loaded only with the editor.
 *
 * Pure (tests/nav-areas.test.cjs).
 */

import { areaId, navDefaultIds, orderNav, type NavSectionLike } from "./nav-areas";
import type { PageLayout, PartDef } from "./personalize-layout";
import { moveBefore, setGridOrder } from "./personalize-ops";

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
