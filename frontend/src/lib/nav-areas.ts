/**
 * The area order (UI preference "layout.areas", owned by Personalize) applied to the side panel and the phone
 * drawer. One order for the app: the continuous scroll (lib/feed-order.ts), the sidebar and the drawer all read
 * `grids.main.order` of that layout, whose ids are area ids (`areaId(href)`: "/analytics/hrv" -> "analytics.hrv").
 *
 * The nav keeps its sections: items are ordered by the area order within their section, sections by their first
 * item. A full page load paints the saved order before React runs: the sidebar renders NAV_BOOT_SCRIPT, which
 * reads this device's copy and writes CSS `order` rules (removed once React has rendered the same order).
 *
 * Besides the order, `layout.areas` holds the side panel's other choices (Personalize, 2026-11-15), each a grid entry
 * of the same layout so the stored value stays a plain Personalize layout:
 *   - `grids.main.hide`  = hidden from the continuous scroll (and its card on Today), as before;
 *   - `grids.quick`      = Quick access (pinned pages): `order` = the pinned pages in order, `hide[id]` true = a default
 *                          pin (QUICK_ACCESS) taken out, false = another page pinned. Pinned pages also lead the scroll;
 *   - `grids.nav.hide`   = hidden from the side panel and the phone drawer (listed under "Show hidden");
 *   - `grids.tabs.order` = the phone bottom bar's four slots around Log (area ids, or "more" for the More menu).
 *
 * Import-free (shell bundle; tests/nav-areas.test.cjs).
 */

export const AREAS_KEY = "layout.areas";
/** This device's copy (Personalize's localStorage record; an "onyx" key, wiped on sign-out). */
export const AREAS_STORAGE = "onyx.layout.areas";
/** Fired on window (detail: the layout key) when Personalize saves or adopts a layout on this tab. */
export const LAYOUT_EVENT = "onyx:layout";
/**
 * Fired on window while Personalize mode edits `layout.areas` on this tab: `detail.layout` = the unsaved draft after
 * each change, null when the session ends (Done, Cancel, Clear; the saved copy applies again). The continuous scroll
 * follows it, so it changes as the side panel does instead of on Done (2026-11-15).
 */
export const LAYOUT_DRAFT_EVENT = "onyx:layout-draft";
/** Fired on window by a continuous scroll that starts listening: an open session answers with LAYOUT_DRAFT_EVENT. */
export const LAYOUT_DRAFT_REQUEST_EVENT = "onyx:layout-draft-request";
export interface LayoutDraftDetail {
  key: string;
  layout: unknown;
}
export const NAV_BOOT_STYLE_ID = "onyx-nav-boot";
/** The sidebar's "Quick access" group by default (the side panel's pinned pages). Keep equal to DEFAULT_PINNED in feed-order.ts. */
export const QUICK_ACCESS: readonly string[] = ["/today", "/log"];
/** Grid entries of `layout.areas` (see above). */
export const PIN_GRID = "quick";
export const NAV_HIDE_GRID = "nav";
export const TABS_GRID = "tabs";
/** The More menu (the drawer) as a bottom-bar slot value. Not a page. */
export const MORE_TAB = "more";

export interface NavSectionLike<I extends { href: string } = { href: string }> {
  title: string;
  items: I[];
}

export function areaId(href: string): string {
  const bare = href.replace(/^\/+/, "").replace(/\/+$/, "");
  return bare ? bare.replace(/\//g, ".") : "today";
}

/** The saved area order (ids) from this device's copy, or null. Accepts the record ({l: layout}) or a layout. */
export function parseAreaIds(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    let o = JSON.parse(raw) as Record<string, unknown> | null;
    if (o && typeof o === "object" && "l" in o) o = o.l as Record<string, unknown> | null;
    const grids = o && typeof o === "object" ? (o.grids as Record<string, unknown> | undefined) : undefined;
    const main = grids && typeof grids === "object" ? (grids.main as { order?: unknown } | undefined) : undefined;
    const order = main && Array.isArray(main.order) ? main.order.filter((x): x is string => typeof x === "string") : [];
    return order.length ? order : null;
  } catch {
    return null;
  }
}

/** Saved order applied to the default ids: unknown ids dropped, new ids after their default predecessor. */
export function rankAreas(defaultIds: readonly string[], saved: readonly string[] | null): Map<string, number> {
  const out: string[] = [];
  const known = new Set(defaultIds);
  const seen = new Set<string>();
  for (const id of saved ?? []) {
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
  return new Map(out.map((id, i) => [id, i]));
}

export function navDefaultIds(sections: readonly NavSectionLike[]): string[] {
  const out: string[] = [];
  for (const s of sections) for (const i of s.items) {
    const id = areaId(i.href);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Sections (with their index in `sections`) and items in the area order. */
export function orderNav<I extends { href: string }>(
  sections: readonly NavSectionLike<I>[],
  saved: readonly string[] | null,
): { index: number; title: string; items: I[] }[] {
  const rank = rankAreas(navDefaultIds(sections), saved);
  const r = (href: string) => rank.get(areaId(href)) ?? Number.MAX_SAFE_INTEGER;
  return sections
    .map((s, index) => ({ index, title: s.title, items: s.items.slice().sort((a, b) => r(a.href) - r(b.href)) }))
    .map((s) => ({ ...s, first: s.items.length ? Math.min(...s.items.map((i) => r(i.href))) : Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.first - b.first || a.index - b.index)
    .map(({ index, title, items }) => ({ index, title, items }));
}

// ---- the side panel's choices (pins, hidden pages, bottom-bar tabs) -----------------------------------------

/** What `layout.areas` says about the side panel, as area ids. */
export interface AreaPrefs {
  /** `grids.main.order`, or null = the nav order. */
  order: string[] | null;
  /** `grids.quick` as stored, or null = the default pins (QUICK_ACCESS). */
  quick: { order: string[]; hide: Record<string, boolean> } | null;
  /** Hidden from the side panel and the drawer (`grids.nav.hide`). */
  navHidden: string[];
  /** Hidden from the continuous scroll (`grids.main.hide`). */
  scrollHidden: string[];
  /** `grids.tabs.order` (area ids or MORE_TAB), or null = the default bottom bar. */
  tabs: string[] | null;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) if (typeof x === "string" && x && !out.includes(x)) out.push(x);
  return out;
}

function flagMap(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (typeof x === "boolean") out[k] = x;
  return out;
}

const trueKeys = (m: Record<string, boolean>) => Object.keys(m).filter((k) => m[k] === true);

/** The side panel's choices from a layout (or Personalize's local record {l: layout}); anything unreadable = default. */
export function areaPrefsOf(raw: unknown): AreaPrefs {
  let o = raw as Record<string, unknown> | null;
  if (o && typeof o === "object" && !Array.isArray(o) && "l" in o) o = o.l as Record<string, unknown> | null;
  const grids = o && typeof o === "object" && !Array.isArray(o) ? (o.grids as Record<string, unknown> | undefined) : undefined;
  const g = (id: string) => {
    const x = grids && typeof grids === "object" ? grids[id] : undefined;
    return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
  };
  const main = g("main");
  const quick = g(PIN_GRID);
  const order = strList(main?.order);
  const tabs = strList(g(TABS_GRID)?.order);
  return {
    order: order.length ? order : null,
    quick: quick ? { order: strList(quick.order), hide: flagMap(quick.hide) } : null,
    navHidden: trueKeys(flagMap(g(NAV_HIDE_GRID)?.hide)),
    scrollHidden: trueKeys(flagMap(main?.hide)),
    tabs: tabs.length ? tabs : null,
  };
}

/** The pinned pages (area ids, in Quick access order) among `allIds`; hidden pages are never pinned. */
export function resolvePinned(allIds: readonly string[], prefs: AreaPrefs | null): string[] {
  const defaults = QUICK_ACCESS.map(areaId);
  const hide = prefs?.quick?.hide ?? {};
  const navHidden = prefs?.navHidden ?? [];
  const member = (id: string) => !navHidden.includes(id) && (typeof hide[id] === "boolean" ? !hide[id] : defaults.includes(id));
  const out: string[] = [];
  for (const id of [...(prefs?.quick?.order ?? []), ...defaults, ...allIds]) {
    if (allIds.includes(id) && member(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The side panel as Riley set it up: Quick access (pinned), sections without pinned or hidden pages, hidden pages. */
export function arrangeNav<I extends { href: string }>(
  sections: readonly NavSectionLike<I>[],
  prefs: AreaPrefs | null,
): { pinned: I[]; sections: { index: number; title: string; items: I[] }[]; hidden: I[] } {
  const ordered = orderNav(sections, prefs?.order ?? null);
  const byId = new Map<string, I>();
  for (const s of ordered) for (const i of s.items) if (!byId.has(areaId(i.href))) byId.set(areaId(i.href), i);
  // Candidates in the area order (like the pre-paint script), so both pick the same pins.
  const pinnedIds = resolvePinned(Array.from(rankAreas(navDefaultIds(sections), prefs?.order ?? null).keys()), prefs);
  const navHidden = new Set(prefs?.navHidden ?? []);
  const pinned = pinnedIds.map((id) => byId.get(id) as I);
  const off = (i: I) => pinnedIds.includes(areaId(i.href)) || navHidden.has(areaId(i.href));
  return {
    pinned,
    sections: ordered.map((s) => ({ ...s, items: s.items.filter((i) => !off(i)) })).filter((s) => s.items.length > 0),
    hidden: ordered.flatMap((s) => s.items).filter((i) => navHidden.has(areaId(i.href))),
  };
}

/**
 * The inline script the sidebar renders: before the first paint it applies this device's saved side panel (CSS on
 * `[data-nav-area]` items and `[data-nav-section]` sections: order, and display:none for pinned or hidden pages and
 * emptied sections; `[data-nav-quick]` entries of Quick access: shown in pin order, or display:none). Same rules as
 * orderNav() / resolvePinned() / arrangeNav(), written as plain ES5 so the server and the browser render the same text.
 */
export function navBootScript(sections: readonly NavSectionLike[]): string {
  const data = JSON.stringify(sections.map((s) => s.items.map((i) => areaId(i.href))));
  return (
    "(function(){try{" +
    `var raw=localStorage.getItem(${JSON.stringify(AREAS_STORAGE)});if(!raw)return;` +
    "var o=JSON.parse(raw);if(o&&o.l)o=o.l;var g=(o&&o.grids)||{};" +
    `var saved=g.main&&g.main.order,q=g[${JSON.stringify(PIN_GRID)}],nv=g[${JSON.stringify(NAV_HIDE_GRID)}];` +
    "var nh=(nv&&nv.hide)||{},hasNh=false,x;for(x in nh)if(nh[x]===true)hasNh=true;" +
    "if(!(saved&&saved.length)&&!q&&!hasNh)return;" +
    `var S=${data},Q=${JSON.stringify(QUICK_ACCESS.map(areaId))},def=[],i,j,k;` +
    "for(i=0;i<S.length;i++)for(j=0;j<S[i].length;j++)if(def.indexOf(S[i][j])===-1)def.push(S[i][j]);" +
    "var out=[];if(saved&&saved.length){for(i=0;i<saved.length;i++){var s=saved[i];if(def.indexOf(s)!==-1&&out.indexOf(s)===-1)out.push(s);}" +
    "for(i=0;i<def.length;i++){var d=def[i];if(out.indexOf(d)!==-1)continue;var at=0;" +
    "for(k=i-1;k>=0;k--){var p=out.indexOf(def[k]);if(p!==-1){at=p+1;break;}}out.splice(at,0,d);}}else out=def.slice();" +
    "var qh=(q&&q.hide)||{};var mem=function(id){if(nh[id]===true)return false;return typeof qh[id]==='boolean'?!qh[id]:Q.indexOf(id)!==-1;};" +
    "var cand=((q&&q.order)||[]).concat(Q,out),pins=[];" +
    "for(i=0;i<cand.length;i++){var c=cand[i];if(def.indexOf(c)!==-1&&mem(c)&&pins.indexOf(c)===-1)pins.push(c);}" +
    "var css='';for(i=0;i<def.length;i++){var pi=pins.indexOf(def[i]);" +
    "css+='[data-nav-quick=\"'+def[i]+'\"]{'+(pi===-1?'display:none!important':'display:flex!important;order:'+pi)+'}';}" +
    "for(i=0;i<S.length;i++){var m=1e9,shown=0;for(j=0;j<S[i].length;j++){var a=S[i][j],r=out.indexOf(a);if(r<m)m=r;" +
    "if(pins.indexOf(a)!==-1||nh[a]===true){css+='[data-nav-area=\"'+a+'\"]{display:none!important}';continue;}" +
    "shown++;css+='[data-nav-area=\"'+a+'\"]{display:flex!important;order:'+r+'}';}" +
    "css+='[data-nav-section=\"'+i+'\"]{'+(shown?'display:block!important;order:'+m:'display:none!important')+'}';}" +
    `var st=document.createElement("style");st.id=${JSON.stringify(NAV_BOOT_STYLE_ID)};st.textContent=css;document.head.appendChild(st);` +
    "}catch(e){}})();"
  );
}

// ---- this device's saved order as a store for the shell (no Personalize code needed) ------------------------

let cachedRaw: string | null | undefined;
let cachedIds: string[] | null = null;

/** The saved area ids on this device (stable reference until the copy changes). */
export function savedAreaIds(): string[] | null {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(AREAS_STORAGE); } catch { raw = null; }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedIds = parseAreaIds(raw);
  }
  return cachedIds;
}

let cachedPrefsRaw: string | null | undefined;
let cachedPrefs: AreaPrefs | null = null;

/** The side panel's choices on this device (null: nothing saved here; stable reference until the copy changes). */
export function savedAreaPrefs(): AreaPrefs | null {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(AREAS_STORAGE); } catch { raw = null; }
  if (raw !== cachedPrefsRaw) {
    cachedPrefsRaw = raw;
    let parsed: unknown = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    cachedPrefs = parsed ? areaPrefsOf(parsed) : null;
  }
  return cachedPrefs;
}

export function subscribeAreaIds(fn: () => void): () => void {
  const onLayout = (e: Event) => {
    const key = (e as CustomEvent<string>).detail;
    if (!key || key === AREAS_KEY) fn();
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === AREAS_STORAGE) fn();
  };
  window.addEventListener(LAYOUT_EVENT, onLayout);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LAYOUT_EVENT, onLayout);
    window.removeEventListener("storage", onStorage);
  };
}

/** React has rendered the saved order itself: the pre-paint rules can go. */
export function dropNavBootStyle() {
  try { document.getElementById(NAV_BOOT_STYLE_ID)?.remove(); } catch { /* ignore */ }
}

export const TABS_BOOT_STYLE_ID = "onyx-tabs-boot";

/**
 * The inline script the phone's bottom bar renders: on a full page load the bar is painted with the default slots
 * (the server cannot know this device's choice), so every `[data-tab-slot]` whose saved value (`grids.tabs.order`)
 * differs from `defaults` (area ids / MORE_TAB) is kept invisible, never moved, until React renders the saved bar.
 * Plain ES5.
 */
export function tabsBootScript(defaults: readonly string[]): string {
  return (
    "(function(){try{" +
    `var raw=localStorage.getItem(${JSON.stringify(AREAS_STORAGE)});if(!raw)return;` +
    `var o=JSON.parse(raw);if(o&&o.l)o=o.l;var t=o&&o.grids&&o.grids[${JSON.stringify(TABS_GRID)}];t=t&&t.order;if(!t||!t.length)return;` +
    `var D=${JSON.stringify(defaults)},css='',i;` +
    "for(i=0;i<D.length;i++)if(t[i]!==D[i])css+='[data-tab-slot=\"'+i+'\"]{visibility:hidden}';if(!css)return;" +
    `var st=document.createElement("style");st.id=${JSON.stringify(TABS_BOOT_STYLE_ID)};st.textContent=css;document.head.appendChild(st);` +
    "}catch(e){}})();"
  );
}

/** React has rendered the saved bottom bar: the pre-paint rules can go. */
export function dropTabsBootStyle() {
  try { document.getElementById(TABS_BOOT_STYLE_ID)?.remove(); } catch { /* ignore */ }
}
