/**
 * Today's presentation choices (PROD-T05): the optional quiet view and the row widths of "Keep life moving".
 *
 * Quiet view settings follow Riley across devices as the UI preference `today.quiet` (pds.ui_preferences through
 * PUT /api/ui/preferences, owner session only; lib/ui-preferences.ts) with a copy on this device
 * (localStorage `onyx.today.quiet`, wiped on sign-out with every `onyx*` key) so the first paint already has
 * them. Off by default: nothing changes until Riley turns it on. Push notifications are not touched.
 * - Opening Today never writes: the server copy is only read (at most every 15 minutes, after the page settles),
 *   and a change is sent only when Riley changes a setting. A send that fails stays on this device and goes with
 *   his Retry or his next change. A newer copy from another device applies the next time Today opens (never
 *   mid-visit).
 * - Snooze / "hide here" marks (lib/today-attention.ts) stay on this device only (`onyx.today.attention`, hashes
 *   only): they hold obligation identities, which are not layout.
 *
 * IMPORT-FREE at run time (tests/today-regression.cjs bundles it by name; type imports only).
 * Tests: frontend/tests/today-view.test.cjs (synthetic data only).
 */
import type { AttentionMark, AttentionMarks } from "./today-attention";

export const QUIET_PREF_KEY = "today.quiet";
/** = uiPrefUrl(QUIET_PREF_KEY) (lib/ui-preferences.ts; a test keeps them equal). */
export const QUIET_PREF_URL = "/api/ui/preferences?key=today.quiet";
export const QUIET_PUT_URL = "/api/ui/preferences";
export const QUIET_DEVICE_KEY = "onyx.today.quiet";
export const MARKS_DEVICE_KEY = "onyx.today.attention";
/** How often the server copy is read. */
export const QUIET_SYNC_EVERY_MS = 15 * 60_000;
/** The id of the pre-paint style the boot script adds (removed once React shows the same view). */
export const QUIET_BOOT_ID = "today-quiet-boot";

export interface QuietSettings {
  on: boolean;
  /** Ordinary items shown (1-5); urgent items are shown beyond it. */
  budget: number;
  /** Add one learning action (reading) below the list. */
  learning: boolean;
}
export const DEFAULT_QUIET: QuietSettings = Object.freeze({ on: false, budget: 3, learning: true }) as QuietSettings;
const MIN_BUDGET = 1;
const MAX_BUDGET = 5;

/** A stored value {v: 1, on, budget, learning}, checked; anything else is null (the default applies). */
export function parseQuietSettings(value: unknown): QuietSettings | null {
  const v = value as { v?: unknown; on?: unknown; budget?: unknown; learning?: unknown } | null;
  if (!v || typeof v !== "object" || Array.isArray(v) || v.v !== 1 || typeof v.on !== "boolean") return null;
  const budget = typeof v.budget === "number" && Number.isFinite(v.budget) ? Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.round(v.budget))) : DEFAULT_QUIET.budget;
  return { on: v.on, budget, learning: typeof v.learning === "boolean" ? v.learning : DEFAULT_QUIET.learning };
}

/** The value stored under today.quiet. */
export function quietValue(s: QuietSettings): { v: 1; on: boolean; budget: number; learning: boolean } {
  return { v: 1, on: s.on, budget: s.budget, learning: s.learning };
}

export function sameQuiet(a: QuietSettings, b: QuietSettings): boolean {
  return a.on === b.on && a.budget === b.budget && a.learning === b.learning;
}

// ─── This device's copy ─────────────────────────────────────────────────────────────────────────────────────

interface QuietRecord {
  settings: QuietSettings;
  /** When it was changed here (ms), null when it came from the server. */
  savedAt: number | null;
  /** The server copy's updatedAt this record matches, null when unknown. */
  updatedAt: string | null;
  /** Changed here and not yet stored on the server. */
  dirty: boolean;
  /** When the server copy was last read (ms). */
  checkedAt: number | null;
}

export function parseQuietRecord(raw: string | null): QuietRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    const settings = parseQuietSettings(r?.settings);
    if (!settings) return null;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    return { settings, savedAt: num(r.savedAt), updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : null, dirty: r.dirty === true, checkedAt: num(r.checkedAt) };
  } catch {
    return null;
  }
}

function storage(): Storage | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}
// The last record written in this page load: used when this device's storage is off or full, so a change still
// applies and is still sent.
let memRecord: QuietRecord | null = null;
function readRecord(): QuietRecord | null {
  try {
    const s = storage();
    if (s) {
      const stored = parseQuietRecord(s.getItem(QUIET_DEVICE_KEY));
      if (stored) return stored;
    }
  } catch { /* storage off: fall back to this page load's copy */ }
  return memRecord;
}
function writeRecord(rec: QuietRecord) {
  memRecord = rec;
  try {
    storage()?.setItem(QUIET_DEVICE_KEY, JSON.stringify({ settings: quietValue(rec.settings), savedAt: rec.savedAt, updatedAt: rec.updatedAt, dirty: rec.dirty, checkedAt: rec.checkedAt }));
  } catch { /* storage full or off: the change still applies on this screen */ }
}

// The settings shown now. Read once per page load; changed here only by Riley's own change, or (on the next
// mount) by a newer server copy (`adoptQuiet`).
let live: QuietSettings | null = null;
let pending: QuietSettings | null = null;
const listeners = new Set<() => void>();
function emit() { for (const fn of Array.from(listeners)) fn(); }

/** useSyncExternalStore snapshot: the same object until the settings change. */
export function readQuiet(): QuietSettings {
  if (!live) live = readRecord()?.settings ?? DEFAULT_QUIET;
  return live;
}
export function serverQuiet(): QuietSettings {
  return DEFAULT_QUIET;
}
export function subscribeQuiet(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
/** Today mounting: a newer copy read from the server on an earlier visit applies now (before its first paint). */
export function adoptQuiet() {
  if (!pending) return;
  live = pending;
  pending = null;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
function defaultFetch(): Fetch | null {
  return typeof fetch === "function" ? (url, init) => fetch(url, init) : null;
}

/** Riley changed a setting: show it at once, keep it on this device, send it. Resolves true once stored on the server. */
export function setQuiet(next: QuietSettings, fetchImpl: Fetch | null = defaultFetch()): Promise<boolean> {
  const settings = parseQuietSettings(quietValue(next)) ?? DEFAULT_QUIET;
  const rec = readRecord();
  // Strictly increasing, so a change made while a send is out is never taken for the one that was sent.
  const savedAt = Math.max(Date.now(), (rec?.savedAt ?? 0) + 1);
  writeRecord({ settings, savedAt, updatedAt: rec?.updatedAt ?? null, dirty: true, checkedAt: rec?.checkedAt ?? null });
  live = settings;
  pending = null;
  emit();
  return pushQuiet(fetchImpl);
}

async function sendOnce(rec: QuietRecord, fetchImpl: Fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(QUIET_PUT_URL, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: QUIET_PREF_KEY, value: quietValue(rec.settings) }),
      keepalive: true,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { key?: unknown; updatedAt?: unknown } | null;
    if (!body || body.key !== QUIET_PREF_KEY) return false;
    const now = readRecord();
    // Only when nothing changed here while the request was out; a newer change is sent by the loop below.
    if (now && now.savedAt === rec.savedAt) writeRecord({ ...now, dirty: false, updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : null, checkedAt: Date.now() });
    return true;
  } catch {
    return false;
  }
}

let inflight: Promise<boolean> | null = null;
/**
 * Send the device copy while it is dirty (one request at a time; a change made while one is out is sent after
 * it). Only ever called after Riley's own change or his Retry: opening Today never writes. A failed send keeps
 * the change on this device (dirty) and resolves false.
 */
export function pushQuiet(fetchImpl: Fetch | null = defaultFetch()): Promise<boolean> {
  if (inflight) return inflight.then(() => pushQuiet(fetchImpl));
  if (!fetchImpl) return Promise.resolve(false);
  const run = (async () => {
    for (let i = 0; i < 3; i++) {
      const rec = readRecord();
      if (!rec?.dirty) return true;
      if (!(await sendOnce(rec, fetchImpl))) return false;
    }
    return !readRecord()?.dirty;
  })();
  inflight = run;
  return run.finally(() => { if (inflight === run) inflight = null; });
}

/** Changed here and not stored on the server yet (a failed send waits for Retry or the next change). */
export function quietUnsent(): boolean {
  return readRecord()?.dirty === true;
}

function time(iso: string | null): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Read the server copy (a GET, nothing is written there) at most every QUIET_SYNC_EVERY_MS. A newer copy than
 * this device's is stored here and applies on the next mount; a newer change made here that has not been sent
 * yet wins and waits for Riley's Retry or next change.
 */
export async function syncQuiet(fetchImpl: Fetch | null = defaultFetch(), nowMs: number = Date.now()): Promise<"skipped" | "same" | "adopted" | "kept" | "failed"> {
  const rec = readRecord();
  if (!fetchImpl || (rec?.checkedAt != null && nowMs - rec.checkedAt < QUIET_SYNC_EVERY_MS)) return "skipped";
  let body: { key?: unknown; value?: unknown; updatedAt?: unknown } | null;
  try {
    const res = await fetchImpl(QUIET_PREF_URL, { cache: "no-store" });
    if (!res.ok) return "failed";
    body = (await res.json()) as typeof body;
  } catch {
    return "failed";
  }
  if (!body || body.key !== QUIET_PREF_KEY || !("value" in body)) return "failed";
  const updatedAt = typeof body.updatedAt === "string" ? body.updatedAt : null;
  const server = parseQuietSettings(body.value);
  const local = readRecord();
  const stamp = (r: QuietRecord) => writeRecord({ ...r, checkedAt: nowMs });
  if (!server) {
    // Nothing stored yet (or an unreadable value): this device keeps what it has (and when it checked).
    stamp(local ?? { settings: DEFAULT_QUIET, savedAt: null, updatedAt: null, dirty: false, checkedAt: null });
    return "same";
  }
  if (local?.dirty && (local.savedAt ?? 0) >= time(updatedAt)) { stamp(local); return "kept"; }
  if (local && !local.dirty && local.updatedAt === updatedAt && sameQuiet(local.settings, server)) { stamp(local); return "same"; }
  writeRecord({ settings: server, savedAt: null, updatedAt, dirty: false, checkedAt: nowMs });
  if (!live || !sameQuiet(live, server)) pending = server;
  return "adopted";
}

/**
 * The pre-paint script (rendered at the top of Today): when this device's copy says the quiet view is on, the
 * full panels are hidden and the quiet slot shown before React runs, so a full page load never shows the full
 * page first. React removes the style (QUIET_BOOT_ID) once it renders the same view. ES5, never throws.
 */
export function quietBootScript(): string {
  return `try{var r=JSON.parse(localStorage.getItem(${JSON.stringify(QUIET_DEVICE_KEY)})||"null");` +
    `if(r&&r.settings&&r.settings.v===1&&r.settings.on===true&&!document.getElementById(${JSON.stringify(QUIET_BOOT_ID)})){` +
    `var s=document.createElement("style");s.id=${JSON.stringify(QUIET_BOOT_ID)};` +
    `s.textContent="[data-today-full]{display:none!important}[data-today-quiet]{display:block!important}";` +
    `document.head.appendChild(s);}}catch(e){}`;
}
export function removeQuietBoot() {
  try { document.getElementById(QUIET_BOOT_ID)?.remove(); } catch { /* ignore */ }
}

// ─── Snooze / hide marks on this device ─────────────────────────────────────────────────────────────────────

type MarksParser = (raw: unknown) => Record<string, AttentionMark>;
type MarksPruner = (marks: AttentionMarks, nowMs: number) => Record<string, AttentionMark>;

/** This device's marks (parsed and pruned by lib/today-attention.ts, passed in so this file stays import-free). */
export function readMarks(parse: MarksParser, prune: MarksPruner, nowMs: number = Date.now()): Record<string, AttentionMark> {
  try {
    const raw = storage()?.getItem(MARKS_DEVICE_KEY);
    return raw ? prune(parse(JSON.parse(raw)), nowMs) : {};
  } catch {
    return {};
  }
}
/** Store the marks (after a tap only). Returns false when this device could not keep them. */
export function writeMarks(marks: AttentionMarks): boolean {
  try {
    const s = storage();
    if (!s) return false;
    if (Object.keys(marks).length === 0) s.removeItem(MARKS_DEVICE_KEY);
    else s.setItem(MARKS_DEVICE_KEY, JSON.stringify(marks));
    return true;
  } catch {
    return false;
  }
}

// ─── "Keep life moving" row widths ──────────────────────────────────────────────────────────────────────────

export type LifeWidth = "full" | "half" | "third";
/**
 * Widths for the N panels "Keep life moving" shows (which ones depends on the day), so every desktop row is full
 * (three thirds or two halves) instead of ending in an empty track: 1 full, 2 halves, 3 thirds, 4 halves,
 * 5 = three thirds then two halves; in general thirds, with the last 2 or 4 as halves when N is not a multiple
 * of 3. Today's grid offers no width choice (CSS mode), so these defaults are the widths; a panel hidden in
 * Personalize is not counted (a known limit).
 */
export function lifeWidths(n: number): LifeWidth[] {
  const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  if (count === 1) return ["full"];
  const halves = count % 3 === 0 ? 0 : count % 3 === 2 ? 2 : 4;
  return Array.from({ length: count }, (_, i) => (i >= count - halves ? "half" : "third"));
}
