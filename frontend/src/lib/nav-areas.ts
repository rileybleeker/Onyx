/**
 * The area order (UI preference "layout.areas", owned by Personalize) applied to the side panel and the phone
 * drawer. One order for the app: the continuous scroll (lib/feed-order.ts), the sidebar and the drawer all read
 * `grids.main.order` of that layout, whose ids are area ids (`areaId(href)`: "/analytics/hrv" -> "analytics.hrv").
 *
 * The nav keeps its sections: items are ordered by the area order within their section, sections by their first
 * item. A full page load paints the saved order before React runs: the sidebar renders NAV_BOOT_SCRIPT, which
 * reads this device's copy and writes CSS `order` rules (removed once React has rendered the same order).
 *
 * Import-free (shell bundle; tests/nav-areas.test.cjs).
 */

export const AREAS_KEY = "layout.areas";
/** This device's copy (Personalize's localStorage record; an "onyx" key, wiped on sign-out). */
export const AREAS_STORAGE = "onyx.layout.areas";
/** Fired on window (detail: the layout key) when Personalize saves or adopts a layout on this tab. */
export const LAYOUT_EVENT = "onyx:layout";
export const NAV_BOOT_STYLE_ID = "onyx-nav-boot";
/** The sidebar's "Quick access" group (the side panel's pinned pages). */
export const QUICK_ACCESS: readonly string[] = ["/today", "/check-in"];

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

/**
 * The inline script the sidebar renders: before the first paint it orders the nav items and sections (CSS
 * `order` on `[data-nav-area]` / `[data-nav-section]`) from this device's saved copy. Same ranking as
 * rankAreas() / orderNav(), written as plain ES5 so the server and the browser render the same text.
 */
export function navBootScript(sections: readonly NavSectionLike[]): string {
  const data = JSON.stringify(sections.map((s) => s.items.map((i) => areaId(i.href))));
  return (
    "(function(){try{" +
    `var raw=localStorage.getItem(${JSON.stringify(AREAS_STORAGE)});if(!raw)return;` +
    "var o=JSON.parse(raw);if(o&&o.l)o=o.l;" +
    "var saved=o&&o.grids&&o.grids.main&&o.grids.main.order;if(!saved||!saved.length)return;" +
    `var S=${data};var def=[],i,j,k;` +
    "for(i=0;i<S.length;i++)for(j=0;j<S[i].length;j++)if(def.indexOf(S[i][j])===-1)def.push(S[i][j]);" +
    "var out=[];for(i=0;i<saved.length;i++){var s=saved[i];if(def.indexOf(s)!==-1&&out.indexOf(s)===-1)out.push(s);}" +
    "for(i=0;i<def.length;i++){var d=def[i];if(out.indexOf(d)!==-1)continue;var at=0;" +
    "for(k=i-1;k>=0;k--){var p=out.indexOf(def[k]);if(p!==-1){at=p+1;break;}}out.splice(at,0,d);}" +
    'var css="";for(i=0;i<S.length;i++){var m=1e9;for(j=0;j<S[i].length;j++){var r=out.indexOf(S[i][j]);' +
    "css+='[data-nav-area=\"'+S[i][j]+'\"]{order:'+r+'}';if(r<m)m=r;}" +
    "css+='[data-nav-section=\"'+i+'\"]{order:'+m+'}';}" +
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
