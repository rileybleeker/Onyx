/**
 * Personalize mode: the editing operations on a page layout and the drop-position maths. Loaded only with the
 * editor (components/personalize/PersonalizeEditor.tsx), never on a normal page load.
 *
 * Every operation returns a NEW normalized layout: entries equal to the page's default are dropped, so the
 * stored overlay holds only Riley's differences and an all-default page stores {v: 1}.
 *
 * Pure (tests/personalize.test.cjs); the only import is the base module.
 */

import {
  EMPTY_LAYOUT,
  resolveOrder,
  type ColumnDef,
  type GridOverlay,
  type PageLayout,
  type PartDef,
  type PartWidth,
  type TableOverlay,
} from "./personalize-layout";

// ---- order helpers ----------------------------------------------------------------------------------------

/** `id` moved to just before `beforeId` (null: to the end). */
export function moveBefore(order: readonly string[], id: string, beforeId: string | null): string[] {
  if (beforeId === id) return order.slice();
  const rest = order.filter((x) => x !== id);
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
  rest.splice(at === -1 ? rest.length : at, 0, id);
  return rest;
}

/** `id` moved `delta` places among the visible ids (hidden ones keep their places). */
export function moveAmongVisible(order: readonly string[], visible: readonly string[], id: string, delta: number): string[] {
  const i = visible.indexOf(id);
  if (i === -1 || delta === 0) return order.slice();
  const j = Math.max(0, Math.min(visible.length - 1, i + delta));
  if (j === i) return order.slice();
  const beforeId = delta < 0 ? visible[j] : visible[j + 1] ?? null;
  if (beforeId === null) {
    // Past the last visible part: just after it, ahead of any hidden part that follows.
    const last = visible[visible.length - 1];
    const rest = order.filter((x) => x !== id);
    rest.splice(rest.indexOf(last) + 1, 0, id);
    return rest;
  }
  return moveBefore(order, id, beforeId);
}

/**
 * The new order of the ids the page has now, with the ids an older saved order held that the page does not
 * render at the moment (a part that only shows when it has data) kept after their saved predecessor.
 */
export function mergeOrder(prev: readonly string[] | undefined, next: readonly string[]): string[] {
  const out = next.slice();
  if (!prev || prev.length === 0) return out;
  const known = new Set(out);
  for (let i = 0; i < prev.length; i++) {
    const id = prev[i];
    if (known.has(id)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const p = out.indexOf(prev[j]);
      if (p !== -1) {
        at = p + 1;
        break;
      }
    }
    out.splice(at, 0, id);
    known.add(id);
  }
  return out;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---- layout plumbing --------------------------------------------------------------------------------------

function sortedRecord<T>(r: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!r) return undefined;
  const keys = Object.keys(r).sort();
  if (!keys.length) return undefined;
  const out: Record<string, T> = {};
  for (const k of keys) out[k] = r[k];
  return out;
}

function cleanGrid(g: GridOverlay | undefined): GridOverlay | undefined {
  if (!g) return undefined;
  const out: GridOverlay = {};
  if (g.order && g.order.length) out.order = g.order.slice();
  const hide = sortedRecord(g.hide);
  const width = sortedRecord(g.width);
  const collapse = sortedRecord(g.collapse);
  if (hide) out.hide = hide;
  if (width) out.width = width;
  if (collapse) out.collapse = collapse;
  return Object.keys(out).length ? out : undefined;
}

function cleanTable(t: TableOverlay | undefined): TableOverlay | undefined {
  if (!t) return undefined;
  const out: TableOverlay = {};
  if (t.order && t.order.length) out.order = t.order.slice();
  const hide = sortedRecord(t.hide);
  if (hide) out.hide = hide;
  if (typeof t.freeze === "string") out.freeze = t.freeze;
  return Object.keys(out).length ? out : undefined;
}

/** Empty parts dropped and keys sorted, so two equal layouts serialize to the same text. */
export function normalizeLayout(layout: PageLayout): PageLayout {
  const grids: Record<string, GridOverlay> = {};
  const tables: Record<string, TableOverlay> = {};
  for (const k of Object.keys(layout.grids ?? {}).sort()) {
    const g = cleanGrid(layout.grids?.[k]);
    if (g) grids[k] = g;
  }
  for (const k of Object.keys(layout.tables ?? {}).sort()) {
    const t = cleanTable(layout.tables?.[k]);
    if (t) tables[k] = t;
  }
  const out: PageLayout = { v: 1 };
  if (Object.keys(grids).length) out.grids = grids;
  if (Object.keys(tables).length) out.tables = tables;
  return out;
}

export function sameLayout(a: PageLayout, b: PageLayout): boolean {
  return JSON.stringify(normalizeLayout(a)) === JSON.stringify(normalizeLayout(b));
}

function withGrid(layout: PageLayout, zone: string, fn: (g: GridOverlay) => GridOverlay): PageLayout {
  const grids = { ...(layout.grids ?? {}) };
  grids[zone] = fn({ ...(grids[zone] ?? {}) });
  return normalizeLayout({ ...layout, grids });
}

function withTable(layout: PageLayout, table: string, fn: (t: TableOverlay) => TableOverlay): PageLayout {
  const tables = { ...(layout.tables ?? {}) };
  tables[table] = fn({ ...(tables[table] ?? {}) });
  return normalizeLayout({ ...layout, tables });
}

function setFlag(
  map: Record<string, boolean> | undefined,
  id: string,
  value: boolean,
  defaultValue: boolean,
): Record<string, boolean> | undefined {
  const next = { ...(map ?? {}) };
  if (value === defaultValue) delete next[id];
  else next[id] = value;
  return Object.keys(next).length ? next : undefined;
}

// ---- part operations --------------------------------------------------------------------------------------

/** The display order now (ids the page has, saved order applied). */
export function gridOrder(defs: readonly PartDef[], layout: PageLayout, zone: string): string[] {
  return resolveOrder(defs.map((d) => d.id), layout.grids?.[zone]?.order);
}

/** Store `order` (the display order of the page's current ids) for the zone; the default order stores nothing. */
export function setGridOrder(layout: PageLayout, zone: string, defs: readonly PartDef[], order: readonly string[]): PageLayout {
  const defaultIds = defs.map((d) => d.id);
  return withGrid(layout, zone, (g) => {
    const resolved = resolveOrder(defaultIds, order);
    if (sameIds(resolved, defaultIds)) {
      delete g.order;
    } else {
      g.order = mergeOrder(g.order, resolved);
    }
    return g;
  });
}

export function movePart(layout: PageLayout, zone: string, defs: readonly PartDef[], id: string, beforeId: string | null): PageLayout {
  return setGridOrder(layout, zone, defs, moveBefore(gridOrder(defs, layout, zone), id, beforeId));
}

export function movePartBy(
  layout: PageLayout,
  zone: string,
  defs: readonly PartDef[],
  visible: readonly string[],
  id: string,
  delta: number,
): PageLayout {
  return setGridOrder(layout, zone, defs, moveAmongVisible(gridOrder(defs, layout, zone), visible, id, delta));
}

export function movePartToTop(layout: PageLayout, zone: string, defs: readonly PartDef[], id: string): PageLayout {
  const order = gridOrder(defs, layout, zone);
  return setGridOrder(layout, zone, defs, moveBefore(order, id, order[0] ?? null));
}

function defOf(defs: readonly PartDef[], id: string): PartDef | undefined {
  return defs.find((d) => d.id === id);
}

export function setPartHidden(layout: PageLayout, zone: string, defs: readonly PartDef[], id: string, hidden: boolean): PageLayout {
  const def = defOf(defs, id);
  return withGrid(layout, zone, (g) => {
    g.hide = setFlag(g.hide, id, hidden, def ? def.hidden : false);
    if (!g.hide) delete g.hide;
    return g;
  });
}

export function setPartWidth(layout: PageLayout, zone: string, defs: readonly PartDef[], id: string, width: PartWidth): PageLayout {
  const def = defOf(defs, id);
  return withGrid(layout, zone, (g) => {
    const next = { ...(g.width ?? {}) };
    if (def && def.width === width) delete next[id];
    else next[id] = width;
    if (Object.keys(next).length) g.width = next;
    else delete g.width;
    return g;
  });
}

export function setPartCollapsed(layout: PageLayout, zone: string, defs: readonly PartDef[], id: string, collapsed: boolean): PageLayout {
  const def = defOf(defs, id);
  return withGrid(layout, zone, (g) => {
    g.collapse = setFlag(g.collapse, id, collapsed, def ? def.collapsed : false);
    if (!g.collapse) delete g.collapse;
    return g;
  });
}

// ---- column operations ------------------------------------------------------------------------------------

export function columnOrder(defs: readonly ColumnDef[], layout: PageLayout, table: string): string[] {
  return resolveOrder(defs.map((d) => d.id), layout.tables?.[table]?.order);
}

export function setColumnOrder(layout: PageLayout, table: string, defs: readonly ColumnDef[], order: readonly string[]): PageLayout {
  const defaultIds = defs.map((d) => d.id);
  return withTable(layout, table, (t) => {
    const resolved = resolveOrder(defaultIds, order);
    if (sameIds(resolved, defaultIds)) delete t.order;
    else t.order = mergeOrder(t.order, resolved);
    return t;
  });
}

export function moveColumnBy(
  layout: PageLayout,
  table: string,
  defs: readonly ColumnDef[],
  visible: readonly string[],
  id: string,
  delta: number,
): PageLayout {
  return setColumnOrder(layout, table, defs, moveAmongVisible(columnOrder(defs, layout, table), visible, id, delta));
}

export function setColumnHidden(layout: PageLayout, table: string, defs: readonly ColumnDef[], id: string, hidden: boolean): PageLayout {
  const def = defs.find((d) => d.id === id);
  if (def?.locked && hidden) return normalizeLayout(layout);
  return withTable(layout, table, (t) => {
    t.hide = setFlag(t.hide, id, hidden, def?.hidden === true);
    if (!t.hide) delete t.hide;
    return t;
  });
}

/** Freeze pane through `id` ("" = none); the table's own default stores nothing. */
export function setColumnFreeze(layout: PageLayout, table: string, id: string, defaultFreeze = ""): PageLayout {
  return withTable(layout, table, (t) => {
    if (id === defaultFreeze) delete t.freeze;
    else t.freeze = id;
    return t;
  });
}

export function clearLayout(): PageLayout {
  return EMPTY_LAYOUT;
}

// ---- drop position ----------------------------------------------------------------------------------------

/** A visible part's box, relative to the grid container, in display order. */
export interface DropItem {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DropLine {
  /** h: a line between rows (the part lands above the next row); v: between two parts side by side. */
  axis: "h" | "v";
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DropTarget {
  /** Insertion index among the items (items.length = at the end). */
  index: number;
  /** The part the dragged one lands before (null: the end). */
  beforeId: string | null;
  line: DropLine;
  /** Dropping here leaves the part where it is. */
  noop: boolean;
}

const ROW_TOLERANCE = 4;
export const LINE_THICKNESS = 4;

/** Items grouped into grid rows (consecutive items starting at the same height). */
export function rowsOf(items: readonly DropItem[]): DropItem[][] {
  const rows: DropItem[][] = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].top - it.top) <= ROW_TOLERANCE && it.left > row[row.length - 1].left) row.push(it);
    else rows.push([it]);
  }
  return rows;
}

function rowTop(row: readonly DropItem[]): number {
  return Math.min(...row.map((r) => r.top));
}

function rowBottom(row: readonly DropItem[]): number {
  return Math.max(...row.map((r) => r.bottom));
}

/** A vertical indicator at x, as tall as the row. */
function besideLine(row: readonly DropItem[], x: number): DropLine {
  const t = LINE_THICKNESS;
  const top = rowTop(row);
  return { axis: "v", x: x - t / 2, y: top, w: t, h: rowBottom(row) - top };
}

/**
 * The indicator for inserting before items[index]: a vertical line when both neighbours sit side by side in one
 * row, otherwise a horizontal line between the rows (across the whole grid).
 */
export function lineFor(items: readonly DropItem[], index: number, gap = 24): DropLine {
  const t = LINE_THICKNESS;
  if (items.length === 0) return { axis: "h", x: 0, y: 0, w: 0, h: t };
  const rows = rowsOf(items);
  const rowIndexOf = (it: DropItem) => rows.findIndex((r) => r.includes(it));
  const prev = index > 0 ? items[index - 1] : null;
  const next = index < items.length ? items[index] : null;
  const prevRow = prev ? rowIndexOf(prev) : -1;
  const nextRow = next ? rowIndexOf(next) : -1;
  if (prev && next && prevRow === nextRow) return besideLine(rows[nextRow], (prev.right + next.left) / 2);
  const left = Math.min(...items.map((r) => r.left));
  const right = Math.max(...items.map((r) => r.right));
  let y: number;
  if (!prev) y = rowTop(rows[0]) - gap / 2;
  else if (!next) y = rowBottom(rows[rows.length - 1]) + gap / 2;
  else y = (rowBottom(rows[prevRow]) + rowTop(rows[nextRow])) / 2;
  return { axis: "h", x: left, y: y - t / 2, w: right - left, h: t };
}

function target(items: readonly DropItem[], index: number, dragId: string, gap: number, line?: DropLine): DropTarget {
  const beforeId = index < items.length ? items[index].id : null;
  const noop = beforeId === dragId || (index > 0 && items[index - 1].id === dragId);
  return { index, beforeId, line: line ?? lineFor(items, index, gap), noop };
}

/**
 * Where a part dragged to `point` (container coordinates) lands. Between rows: above / below the row the pointer
 * is in (top / bottom half of a full-width part, top / bottom fifth of a row of parts side by side); inside a row
 * of parts side by side: before the first part whose middle is right of the pointer.
 */
export function dropTarget(
  items: readonly DropItem[],
  point: { x: number; y: number },
  dragId: string,
  gap = 24,
): DropTarget | null {
  if (items.length === 0) return null;
  const rows = rowsOf(items);
  const r = rows.findIndex((row) => point.y < rowBottom(row) + gap / 2);
  if (r === -1) return target(items, items.length, dragId, gap);
  const row = rows[r];
  const first = items.indexOf(row[0]);
  const top = rowTop(row);
  const bottom = rowBottom(row);
  if (point.y < top) return target(items, first, dragId, gap);
  if (row.length === 1) return target(items, point.y < (top + bottom) / 2 ? first : first + 1, dragId, gap);
  const edge = Math.min(40, (bottom - top) * 0.2);
  if (point.y < top + edge) return target(items, first, dragId, gap);
  if (point.y > bottom - edge) return target(items, first + row.length, dragId, gap);
  const k = row.findIndex((it) => point.x < (it.left + it.right) / 2);
  if (k === 0) return target(items, first, dragId, gap, besideLine(row, row[0].left - gap / 2));
  if (k === -1) return target(items, first + row.length, dragId, gap, besideLine(row, row[row.length - 1].right + gap / 2));
  return target(items, first + k, dragId, gap);
}

/**
 * Keyboard moves: the part's final position `pos` among the visible parts (0 = first). Returns the same target
 * shape as a drag, so the indicator is drawn the same way.
 */
export function keyboardTarget(items: readonly DropItem[], dragId: string, pos: number, gap = 24): DropTarget | null {
  if (items.length === 0) return null;
  const others = items.filter((it) => it.id !== dragId);
  const p = Math.max(0, Math.min(others.length, pos));
  const beforeId = p < others.length ? others[p].id : null;
  const index = beforeId === null ? items.length : items.findIndex((it) => it.id === beforeId);
  return target(items, index, dragId, gap);
}
