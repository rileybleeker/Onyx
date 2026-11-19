/**
 * Personalize (Business Central-style page layouts): the part every page that adopts <PartGrid> loads.
 *
 * A page declares its parts in their default order (id, title, width, hidden / collapsed by default). Riley's
 * changes are stored as an OVERLAY on that default, never as a copy of the page:
 *   - parts the page gains later appear in their default spot (after their default predecessor);
 *   - parts the page drops are ignored (their ids stay in the stored order, so a part that only renders when it
 *     has data finds its place again when it comes back);
 *   - an empty overlay is the default layout, which is what "Clear personalization" stores.
 *
 * One overlay per page (`layoutKey(page)`, e.g. "layout.analytics.hrv"), holding the part grids of the page
 * (`grids`, usually just "main") and its personalizable tables (`tables`: column order, hidden columns, freeze pane).
 *
 * The editing operations and the drop-position maths are in personalize-ops.ts, loaded only in Personalize mode.
 * Import-free on purpose (tests/personalize.test.cjs runs it in plain node).
 */

export type PartWidth = "full" | "half" | "third" | "quarter";
export const PART_WIDTHS: readonly PartWidth[] = ["full", "half", "third", "quarter"];

export interface PartDef {
  id: string;
  title: string;
  width: PartWidth;
  /** Hidden until shown again from "+ Add part". */
  hidden: boolean;
  /** Shows only its title bar until opened. */
  collapsed: boolean;
}

export interface ResolvedPart extends PartDef {
  /** Position in display order (hidden parts included). */
  pos: number;
}

export interface GridOverlay {
  /** Display order of part ids. */
  order?: string[];
  /** true = hidden, false = shown although the page hides it by default. Only differences are stored. */
  hide?: Record<string, boolean>;
  width?: Record<string, PartWidth>;
  collapse?: Record<string, boolean>;
}

export interface TableOverlay {
  order?: string[];
  hide?: Record<string, boolean>;
  /** Last column of the freeze pane (BC "Set Freeze Pane"); "" = no frozen column; absent = the table's default. */
  freeze?: string;
}

export interface PageLayout {
  v: 1;
  grids?: Record<string, GridOverlay>;
  tables?: Record<string, TableOverlay>;
}

export const EMPTY_LAYOUT: PageLayout = { v: 1 };
export const MAIN_ZONE = "main";

export interface ColumnDef {
  id: string;
  label: string;
  /** Not shown until added from the column list. */
  hidden?: boolean;
  /** Cannot be hidden (it identifies the row). */
  locked?: boolean;
}

export interface ResolvedColumn {
  id: string;
  label: string;
  hidden: boolean;
  locked: boolean;
  /** Inside the freeze pane: sticks to the left edge while the table scrolls sideways. */
  frozen: boolean;
}

// ---- keys -------------------------------------------------------------------------------------------------

export const LAYOUT_KEY_PREFIX = "layout";
/** The live pds.ui_preferences table caps keys at 40 characters. */
export const MAX_LAYOUT_KEY_LENGTH = 40;

/** "/analytics/hrv" -> "layout.analytics.hrv" (pds.ui_preferences key format: lower-case, dotted, at most 40). */
export function layoutKey(page: string): string {
  const parts = page
    .toLowerCase()
    .split("/")
    .map((s) => s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((s) => s.length > 0);
  return [LAYOUT_KEY_PREFIX, ...parts].join(".").slice(0, MAX_LAYOUT_KEY_LENGTH).replace(/[._-]+$/, "");
}

/** localStorage key of a page's layout (an "onyx" key, so signing out wipes it). */
export function storageKey(key: string): string {
  return `onyx.${key}`;
}

// ---- reading untrusted copies (localStorage, the server, a cookie) -----------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_IDS = 200;

export function isPartId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

function cleanIds(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (isPartId(x) && !seen.has(x)) {
      seen.add(x);
      out.push(x);
      if (out.length >= MAX_IDS) break;
    }
  }
  return out.length ? out : undefined;
}

function cleanFlags(v: unknown): Record<string, boolean> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, boolean> = {};
  let n = 0;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (isPartId(k) && typeof x === "boolean") {
      out[k] = x;
      if (++n >= MAX_IDS) break;
    }
  }
  return n ? out : undefined;
}

function cleanWidths(v: unknown): Record<string, PartWidth> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, PartWidth> = {};
  let n = 0;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (isPartId(k) && typeof x === "string" && (PART_WIDTHS as readonly string[]).includes(x)) {
      out[k] = x as PartWidth;
      if (++n >= MAX_IDS) break;
    }
  }
  return n ? out : undefined;
}

function cleanGrid(v: unknown): GridOverlay | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const g = v as Record<string, unknown>;
  const out: GridOverlay = {};
  const order = cleanIds(g.order);
  const hide = cleanFlags(g.hide);
  const width = cleanWidths(g.width);
  const collapse = cleanFlags(g.collapse);
  if (order) out.order = order;
  if (hide) out.hide = hide;
  if (width) out.width = width;
  if (collapse) out.collapse = collapse;
  return Object.keys(out).length ? out : undefined;
}

function cleanTable(v: unknown): TableOverlay | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const t = v as Record<string, unknown>;
  const out: TableOverlay = {};
  const order = cleanIds(t.order);
  const hide = cleanFlags(t.hide);
  if (order) out.order = order;
  if (hide) out.hide = hide;
  if (t.freeze === "" || isPartId(t.freeze)) out.freeze = t.freeze as string;
  return Object.keys(out).length ? out : undefined;
}

function cleanMap<T>(v: unknown, clean: (x: unknown) => T | undefined): Record<string, T> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, T> = {};
  let n = 0;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!isPartId(k)) continue;
    const c = clean(x);
    if (c) {
      out[k] = c;
      if (++n >= 20) break;
    }
  }
  return n ? out : undefined;
}

/** A layout read from anywhere outside this module: unknown fields dropped, every id and value checked. */
export function sanitizeLayout(raw: unknown): PageLayout {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_LAYOUT;
  const r = raw as Record<string, unknown>;
  const grids = cleanMap(r.grids, cleanGrid);
  const tables = cleanMap(r.tables, cleanTable);
  if (!grids && !tables) return EMPTY_LAYOUT;
  const out: PageLayout = { v: 1 };
  if (grids) out.grids = grids;
  if (tables) out.tables = tables;
  return out;
}

export function isEmptyLayout(layout: PageLayout): boolean {
  return !layout.grids && !layout.tables;
}

/** What this device keeps per page in localStorage. */
export interface StoredLayout {
  layout: PageLayout;
  /** updatedAt of the server copy this record matches (null: none known). */
  updatedAt: string | null;
  /** When Riley last changed it on this device (ms), for the newer-wins merge with the server copy. */
  savedAt: number | null;
  /** Changed here and not yet saved to the server. */
  dirty: boolean;
  /** When the server copy was last checked (ms). */
  checkedAt: number;
}

export function parseStored(raw: string | null): StoredLayout | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    if (!r || typeof r !== "object") return null;
    return {
      layout: sanitizeLayout(r.l),
      updatedAt: typeof r.u === "string" ? r.u : null,
      savedAt: typeof r.s === "number" && Number.isFinite(r.s) ? r.s : null,
      dirty: r.d === true,
      checkedAt: typeof r.c === "number" && Number.isFinite(r.c) ? r.c : 0,
    };
  } catch {
    return null;
  }
}

export function serializeStored(rec: StoredLayout): string {
  return JSON.stringify({ l: rec.layout, u: rec.updatedAt, s: rec.savedAt, d: rec.dirty, c: rec.checkedAt });
}

// ---- resolving the overlay against the page's default ------------------------------------------------------

/**
 * The display order: the saved order of the ids the page still has, with the ids the page gained since
 * inserted after their nearest default predecessor (or first when they lead the default order).
 */
export function resolveOrder(defaultIds: readonly string[], saved: readonly string[] | undefined): string[] {
  if (!saved || saved.length === 0) return defaultIds.slice();
  const known = new Set(defaultIds);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of saved) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (let i = 0; i < defaultIds.length; i++) {
    const id = defaultIds[i];
    if (seen.has(id)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const p = out.indexOf(defaultIds[j]);
      if (p !== -1) {
        at = p + 1;
        break;
      }
    }
    out.splice(at, 0, id);
    seen.add(id);
  }
  return out;
}

export function resolveGrid(defs: readonly PartDef[], ov: GridOverlay | undefined): ResolvedPart[] {
  const byId = new Map<string, PartDef>();
  for (const d of defs) if (!byId.has(d.id)) byId.set(d.id, d);
  const order = resolveOrder(Array.from(byId.keys()), ov?.order);
  return order.map((id, pos) => {
    const d = byId.get(id) as PartDef;
    const hide = ov?.hide?.[id];
    const width = ov?.width?.[id];
    const collapse = ov?.collapse?.[id];
    return {
      id,
      title: d.title,
      width: width && (PART_WIDTHS as readonly string[]).includes(width) ? width : d.width,
      hidden: typeof hide === "boolean" ? hide : d.hidden,
      collapsed: typeof collapse === "boolean" ? collapse : d.collapsed,
      pos,
    };
  });
}

/** Columns in display order with their hidden / frozen state. `defaultFreeze`: the table's own freeze pane. */
export function resolveColumns(
  defs: readonly ColumnDef[],
  ov: TableOverlay | undefined,
  defaultFreeze = "",
): ResolvedColumn[] {
  const byId = new Map<string, ColumnDef>();
  for (const d of defs) if (!byId.has(d.id)) byId.set(d.id, d);
  const order = resolveOrder(Array.from(byId.keys()), ov?.order);
  const freeze = ov && typeof ov.freeze === "string" ? ov.freeze : defaultFreeze;
  const freezeAt = freeze ? order.indexOf(freeze) : -1;
  return order.map((id, i) => {
    const d = byId.get(id) as ColumnDef;
    const locked = d.locked === true;
    const hide = ov?.hide?.[id];
    const hidden = locked ? false : typeof hide === "boolean" ? hide : d.hidden === true;
    return { id, label: d.label, hidden, locked, frozen: !hidden && i <= freezeAt };
  });
}

// ---- pages with groups (nested parts) -------------------------------------------------------------------------

/**
 * A page with groups: top-level items (groups and lone parts) and, per group, the parts declared in it. A part can
 * be moved into another group of the same page: it then belongs to the group whose saved order lists it.
 * Order: `grids.main.order` (top level) and `grids[<group>].order` (inside a group). Flags (hide, width,
 * collapse) are page-wide in `grids.main`, so they follow a part into another group.
 */
export interface PageModel {
  top: PartDef[];
  groups: Record<string, PartDef[]>;
}

export interface ResolvedPage {
  top: ResolvedPart[];
  /** Parts shown in each group, in display order (moved-in parts included, moved-out ones not). */
  members: Record<string, ResolvedPart[]>;
  /** The group each declared part is shown in. */
  groupOf: Record<string, string>;
}

function flagOf<T>(layout: PageLayout, field: "hide" | "width" | "collapse", zone: string, id: string): T | undefined {
  const main = layout.grids?.[MAIN_ZONE]?.[field] as Record<string, T> | undefined;
  if (main && id in main) return main[id];
  const own = layout.grids?.[zone]?.[field] as Record<string, T> | undefined;
  return own && id in own ? own[id] : undefined;
}

function resolvePart(d: PartDef, layout: PageLayout, zone: string, pos: number): ResolvedPart {
  const hide = flagOf<boolean>(layout, "hide", zone, d.id);
  const width = flagOf<PartWidth>(layout, "width", zone, d.id);
  const collapse = flagOf<boolean>(layout, "collapse", zone, d.id);
  return {
    id: d.id,
    title: d.title,
    width: width && (PART_WIDTHS as readonly string[]).includes(width) ? width : d.width,
    hidden: typeof hide === "boolean" ? hide : d.hidden,
    collapsed: typeof collapse === "boolean" ? collapse : d.collapsed,
    pos,
  };
}

/** Which group each part is in: a group other than its own whose saved order lists it, else its own. */
export function groupMembership(model: PageModel, layout: PageLayout): Record<string, string> {
  const groupIds = Object.keys(model.groups);
  const out: Record<string, string> = {};
  for (const g of groupIds) {
    for (const d of model.groups[g]) {
      if (d.id in out) continue;
      const moved = groupIds.find((x) => x !== g && (layout.grids?.[x]?.order ?? []).includes(d.id));
      out[d.id] = moved ?? g;
    }
  }
  return out;
}

export function resolvePage(model: PageModel, layout: PageLayout, zone: string = MAIN_ZONE): ResolvedPage {
  const groupOf = groupMembership(model, layout);
  const defOf = new Map<string, PartDef>();
  const declared = new Map<string, string>();
  for (const [g, defs] of Object.entries(model.groups)) {
    for (const d of defs) {
      if (!defOf.has(d.id)) {
        defOf.set(d.id, d);
        declared.set(d.id, g);
      }
    }
  }
  const members: Record<string, ResolvedPart[]> = {};
  for (const [g, defs] of Object.entries(model.groups)) {
    const saved = layout.grids?.[g]?.order;
    const own = defs.filter((d) => groupOf[d.id] === g).map((d) => d.id);
    const movedIn = (saved ?? []).filter((id) => groupOf[id] === g && declared.get(id) !== g);
    const order = resolveOrder([...own, ...movedIn], saved);
    members[g] = order.map((id, pos) => resolvePart(defOf.get(id) as PartDef, layout, g, pos));
  }
  const topDef = new Map(model.top.map((d) => [d.id, d] as const));
  const top = resolveOrder(model.top.map((d) => d.id), layout.grids?.[zone]?.order).map((id, pos) =>
    resolvePart(topDef.get(id) as PartDef, layout, zone, pos),
  );
  return { top, members, groupOf };
}

/** Ids of the visible parts in display order (for a table of contents that follows the layout). */
export function visibleOrder(ids: readonly string[], layout: PageLayout, zone = MAIN_ZONE, hiddenByDefault: readonly string[] = []): string[] {
  const g = layout.grids?.[zone];
  return resolveOrder(ids, g?.order).filter((id) => {
    const h = g?.hide?.[id];
    return typeof h === "boolean" ? !h : !hiddenByDefault.includes(id);
  });
}

// ---- server-rendered pages: the layout also rides in a cookie ----------------------------------------------

/**
 * Pages whose parts are rendered on the server (force-dynamic). Their layout is also written to a cookie scoped
 * to the page's path, so the server renders the personalized layout and hydration changes nothing on screen.
 * Client-rendered pages (the ISR dashboards render their parts with ssr:false) read localStorage on their first
 * render instead and need no cookie.
 */
export const SSR_LAYOUT_PAGES: readonly string[] = ["/financials", "/rewards", "/financials/budgets", "/financials/forecast", "/screen-time", "/orders", "/procurement", "/health", "/health/records"];
/** Encoded cookie values longer than this are not written (the page then personalizes after hydration). */
export const MAX_LAYOUT_COOKIE = 3500;

export function layoutCookieName(page: string): string {
  return `onyx-pz-${layoutKey(page).slice(LAYOUT_KEY_PREFIX.length + 1).replace(/\./g, "-") || "root"}`;
}

export function layoutFromCookie(value: string | undefined | null): PageLayout {
  if (!value) return EMPTY_LAYOUT;
  try {
    return sanitizeLayout(JSON.parse(decodeURIComponent(value)));
  } catch {
    return EMPTY_LAYOUT;
  }
}

/** The Set-Cookie text for a page's layout; an empty layout (or one too large) removes the cookie. */
export function layoutCookie(page: string, layout: PageLayout, secure = true): string {
  const name = layoutCookieName(page);
  const tail = `; Path=${page}; SameSite=Lax${secure ? "; Secure" : ""}`;
  if (isEmptyLayout(layout)) return `${name}=; Max-Age=0${tail}`;
  const value = encodeURIComponent(JSON.stringify(layout));
  if (value.length > MAX_LAYOUT_COOKIE) return `${name}=; Max-Age=0${tail}`;
  return `${name}=${value}; Max-Age=34560000${tail}`;
}
