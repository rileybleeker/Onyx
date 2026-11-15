/**
 * Personalize: where page layouts live on this device and how they follow Riley to the other devices.
 *
 * - First paint reads localStorage synchronously (`onyx.layout.<page>`), so a page renders its personalized
 *   layout in its first render: no request, no re-render, nothing moves after paint.
 * - The server copy (pds.ui_preferences via /api/ui/preferences, one row per page) is checked in the background
 *   in an idle slot after the page has loaded, at most every 15 minutes per page, through the shared client
 *   cache. A newer copy from another device is stored and used from the NEXT time the page opens, never
 *   swapped in under Riley's eyes (Personalize mode is the exception: it adopts the newest copy before editing).
 * - A change is saved here at once and PUT to the server in the background, only when the layout changed. An
 *   unsaved change (offline) stays marked dirty and is sent on the next page open. Newer wins: the server copy
 *   replaces a dirty local one only when it was written after the local change.
 * - Pages rendered on the server (SSR_LAYOUT_PAGES) also get the layout in a path-scoped cookie.
 * - `?personalize=off` in the address shows every page in its default layout for that load (support, checks).
 */

import { clientCache, fetchJsonValue } from "./client-cache";
import { UI_PREFS_PATH, parseUiPref, uiPrefUrl } from "./ui-preferences";
import {
  EMPTY_LAYOUT,
  SSR_LAYOUT_PAGES,
  isEmptyLayout,
  layoutCookie,
  parseStored,
  sanitizeLayout,
  serializeStored,
  storageKey,
  type PageLayout,
  type StoredLayout,
} from "./personalize-layout";
import { setEditingKey, setEditorRef } from "./personalize-registry";
import { AREAS_KEY, LAYOUT_EVENT } from "./nav-areas";

export const PULL_EVERY_MS = 15 * 60_000;

type Listener = () => void;
const listeners = new Set<Listener>();
const records = new Map<string, StoredLayout | null>();
/** Server copies fetched while their page was on screen: applied when the page opens next. */
const pending = new Map<string, StoredLayout>();
const pagesByKey = new Map<string, string>();

function emit() {
  for (const fn of Array.from(listeners)) {
    try { fn(); } catch { /* a listener never breaks another */ }
  }
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

let off: boolean | null = null;
function disabled(): boolean {
  if (off === null) {
    try { off = new URLSearchParams(window.location.search).get("personalize") === "off"; } catch { off = false; }
  }
  return off;
}

function read(key: string): StoredLayout | null {
  if (records.has(key)) return records.get(key) ?? null;
  let rec: StoredLayout | null = null;
  try { rec = parseStored(window.localStorage.getItem(storageKey(key))); } catch { rec = null; }
  records.set(key, rec);
  return rec;
}

function write(key: string, rec: StoredLayout) {
  records.set(key, rec);
  try { window.localStorage.setItem(storageKey(key), serializeStored(rec)); } catch { /* private mode / quota */ }
}

function writeCookie(page: string | undefined, layout: PageLayout) {
  if (!page || !SSR_LAYOUT_PAGES.includes(page)) return;
  try { document.cookie = layoutCookie(page, layout, window.location.protocol === "https:"); } catch { /* ignore */ }
}

/** The saved layout of a page on this device (the default when none, or with ?personalize=off). */
export function savedLayout(key: string): PageLayout {
  if (disabled()) return EMPTY_LAYOUT;
  return read(key)?.layout ?? EMPTY_LAYOUT;
}

/** Called once when a grid mounts, before it reads its layout: a server copy fetched last time applies now. */
export function adoptPending(key: string, page: string) {
  if (typeof window === "undefined") return;
  pagesByKey.set(key, page);
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  records.set(key, p);
}

// ---- Personalize session ----------------------------------------------------------------------------------

interface Draft {
  draft: PageLayout;
  base: PageLayout;
  /** Riley has changed something in this session. */
  touched: boolean;
}

interface Session {
  /** The page being personalized (its layout key), or AREAS_KEY for the app-wide arrangement. */
  key: string;
  page: string;
  title: string;
  /** Drafts by layout key: the page's own, plus layout.areas once the side panel is rearranged. */
  drafts: Record<string, Draft>;
}

let session: Session | null = null;
let editor: unknown = null;

/** What a grid shows: the draft while it is being personalized, else the saved layout. */
export function layoutSnapshot(key: string): PageLayout {
  const d = session?.drafts[key];
  return d ? d.draft : savedLayout(key);
}

/** The page (key) of the open Personalize session is this one. */
export function isEditing(key: string): boolean {
  return session !== null && session.key === key;
}

/** A Personalize session is open (any page): the side panel can be rearranged. */
export function isPersonalizing(): boolean {
  return session !== null;
}

export function editingSession(): Readonly<Session> | null {
  return session;
}

/** The loaded editor module (opaque here; components/personalize/editor-loader.ts types it). */
export function editorSnapshot(): unknown {
  return editor;
}

export function setEditorModule(mod: unknown) {
  if (editor === mod) return;
  editor = mod;
  setEditorRef(mod);
  emit();
}

export function beginEdit(key: string, page: string, title: string) {
  if (session?.key === key) return;
  if (session) endEdit(true);
  const base = savedLayout(key);
  session = { key, page, title, drafts: { [key]: { draft: base, base, touched: false } } };
  pagesByKey.set(key, page);
  setEditingKey(key);
  emit();
  // Edit the newest copies: another device may have changed this page or the area order since last checked.
  void pull(key, true);
  if (key !== AREAS_KEY) void pull(AREAS_KEY, true);
}

/** Change the draft of `key` (default: the session's page). The draft is created from the saved layout. */
export function updateDraftFor(key: string, fn: (layout: PageLayout) => PageLayout) {
  if (!session) return;
  const cur = session.drafts[key] ?? { draft: savedLayout(key), base: savedLayout(key), touched: false };
  const draft = fn(cur.draft);
  if (draft === cur.draft) return;
  session = { ...session, drafts: { ...session.drafts, [key]: { ...cur, draft, touched: true } } };
  emit();
}

export function updateDraft(fn: (layout: PageLayout) => PageLayout) {
  if (session) updateDraftFor(session.key, fn);
}

function commitTouched(s: Session, skip?: string) {
  for (const [key, d] of Object.entries(s.drafts)) {
    if (key === skip) continue;
    if (d.touched && JSON.stringify(d.draft) !== JSON.stringify(d.base)) commit(key, d.draft);
  }
}

/** End Personalize mode: Done (save = true) keeps the drafts, Cancel throws them away. */
export function endEdit(save: boolean) {
  const s = session;
  if (!s) return;
  session = null;
  setEditingKey(null);
  if (save) commitTouched(s);
  emit();
}

/** "Clear personalization": this page goes back to its default layout, here and on the other devices. */
export function clearAndEnd() {
  const s = session;
  if (!s) return;
  session = null;
  setEditingKey(null);
  commitTouched(s, s.key);
  commit(s.key, EMPTY_LAYOUT);
  emit();
}

function commit(key: string, layout: PageLayout) {
  const prev = read(key);
  const clean = isEmptyLayout(layout) ? EMPTY_LAYOUT : layout;
  write(key, { layout: clean, updatedAt: prev?.updatedAt ?? null, savedAt: Date.now(), dirty: true, checkedAt: prev?.checkedAt ?? 0 });
  pending.delete(key);
  writeCookie(pagesByKey.get(key), clean);
  announceLayout(key);
  void push(key);
}

/** The sidebar and the continuous scroll re-read this device's copy (other tabs get a storage event). */
function announceLayout(key: string) {
  try { window.dispatchEvent(new CustomEvent(LAYOUT_EVENT, { detail: key })); } catch { /* ignore */ }
}

// ---- server copy ------------------------------------------------------------------------------------------

const pushing = new Set<string>();

async function push(key: string) {
  const rec = read(key);
  if (!rec?.dirty || pushing.has(key)) return;
  pushing.add(key);
  try {
    const res = await fetch(UI_PREFS_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value: rec.layout }),
      keepalive: true,
    });
    if (!res.ok) return;
    const pref = parseUiPref(await res.json(), key);
    const now = read(key);
    // Only if nothing changed here while the request was out.
    if (now && now.savedAt === rec.savedAt) write(key, { ...now, dirty: false, updatedAt: pref.updatedAt, checkedAt: Date.now() });
  } catch {
    // Offline or refused: stays dirty, sent again on the next page open.
  } finally {
    pushing.delete(key);
  }
}

function time(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

async function pull(key: string, applyNow: boolean) {
  let raw: unknown;
  try {
    const url = uiPrefUrl(key);
    raw = await clientCache.revalidate(url, () => fetchJsonValue(url));
  } catch {
    return;
  }
  if (raw === undefined) return;
  let pref;
  try { pref = parseUiPref(raw, key); } catch { return; }
  const local = read(key);
  const now = Date.now();
  if (pref.value === null) {
    // Nothing on the server: a layout made here before it could sync goes up.
    if (local && !isEmptyLayout(local.layout) && !local.updatedAt) {
      write(key, { ...local, dirty: true, checkedAt: now });
      void push(key);
    } else if (local) {
      write(key, { ...local, checkedAt: now });
    }
    return;
  }
  if (local?.dirty && (local.savedAt ?? 0) >= time(pref.updatedAt)) {
    void push(key); // the change made here is newer
    return;
  }
  if (local && !local.dirty && local.updatedAt === pref.updatedAt) {
    write(key, { ...local, checkedAt: now });
    return;
  }
  const rec: StoredLayout = { layout: sanitizeLayout(pref.value), updatedAt: pref.updatedAt, savedAt: local?.savedAt ?? null, dirty: false, checkedAt: now };
  try { window.localStorage.setItem(storageKey(key), serializeStored(rec)); } catch { /* ignore */ }
  writeCookie(pagesByKey.get(key), rec.layout);
  const d = session?.drafts[key];
  if (session && d) {
    records.set(key, rec);
    // Not changed yet in this session: edit the newest copy. Already changed: keep the draft (Done overwrites).
    const next: Draft = d.touched ? { ...d, base: rec.layout } : { draft: rec.layout, base: rec.layout, touched: false };
    session = { ...session, drafts: { ...session.drafts, [key]: next } };
    emit();
  } else if (applyNow || key === AREAS_KEY) {
    // The area order drives the side panel (pre-painted from this copy) and the scroll below the fold.
    records.set(key, rec);
    pending.delete(key);
    emit();
  } else {
    pending.set(key, rec);
  }
  announceLayout(key);
}

/** A grid mounted (normal mode): in an idle slot after the page has loaded, sync this page with the server. */
export function scheduleSync(key: string) {
  if (typeof window === "undefined" || disabled()) return () => {};
  let cancelled = false;
  const run = () => {
    if (cancelled) return;
    const rec = read(key);
    if (rec?.dirty) { void push(key); return; }
    if (rec && Date.now() - rec.checkedAt < PULL_EVERY_MS) return;
    void pull(key, false);
  };
  const idle = () => {
    const g = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void };
    if (typeof g.requestIdleCallback === "function") g.requestIdleCallback(run, { timeout: 4000 });
    else setTimeout(run, 50);
  };
  const timer = setTimeout(idle, 2500);
  return () => { cancelled = true; clearTimeout(timer); };
}

/** Whether a part is hidden on this device (for any future part-level warm-up: a hidden part warms nothing). */
export function isPartHidden(key: string, partId: string, zone = "main", hiddenByDefault = false): boolean {
  const h = savedLayout(key).grids?.[zone]?.hide?.[partId];
  return typeof h === "boolean" ? h : hiddenByDefault;
}
