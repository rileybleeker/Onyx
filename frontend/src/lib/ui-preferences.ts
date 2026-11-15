/**
 * UI preferences that follow Riley across devices (the overview card order today; the sidebar order can use
 * the same store). Stored in pds.ui_preferences (sql/ui_preferences.sql): one row per key, a small JSON value.
 *
 * Access model: the table is owner-readable (owner_read policy) and written only by /api/ui/preferences
 * with the service role. That route is owner-session only (never in middleware's isCiRoute()), accepts only
 * same-origin JSON and caps the body. Values are layout choices, never health or finance data.
 *
 * Pure and import-free (tests/ui-preferences.test.cjs).
 */

/** Lower-case dotted names: "overview.cards", "sidebar.order". */
export const UI_PREF_KEY_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
export const MAX_UI_PREF_KEY_LENGTH = 64;
/** Longest request body the route reads. */
export const MAX_UI_PREF_BODY_BYTES = 8192;
/** Longest stored value (its JSON text). */
export const MAX_UI_PREF_VALUE_BYTES = 4096;

export const UI_PREFS_PATH = "/api/ui/preferences";

export function isUiPrefKey(key: unknown): key is string {
  return typeof key === "string" && key.length <= MAX_UI_PREF_KEY_LENGTH && UI_PREF_KEY_RE.test(key);
}

/** The GET URL for one key. Also its client-cache key (lib/client-cache.ts: one key per GET). */
export function uiPrefUrl(key: string): string {
  return `${UI_PREFS_PATH}?key=${encodeURIComponent(key)}`;
}

export interface UiPref {
  key: string;
  /** The stored value, or null when nothing has been saved for the key yet. */
  value: unknown;
  updatedAt: string | null;
}

/** What GET and PUT answer. Throws on anything else (a cached copy is checked the same way). */
export function parseUiPref(raw: unknown, key?: string): UiPref {
  const r = raw as { key?: unknown; value?: unknown; updatedAt?: unknown } | null;
  if (!r || typeof r !== "object" || !isUiPrefKey(r.key) || (key !== undefined && r.key !== key) || !("value" in r)) throw new Error("Invalid preference");
  if (r.updatedAt !== null && typeof r.updatedAt !== "string") throw new Error("Invalid preference");
  return { key: r.key, value: r.value ?? null, updatedAt: (r.updatedAt as string | null) ?? null };
}

export type ParsedPrefBody = { ok: true; key: string; value: object } | { ok: false; error: string };

/** PUT body: {key, value}; value a JSON object or array of at most MAX_UI_PREF_VALUE_BYTES. */
export function parsePrefBody(body: unknown): ParsedPrefBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => k !== "key" && k !== "value");
  if (extra.length) return { ok: false, error: "unknown field" };
  if (!isUiPrefKey(b.key)) return { ok: false, error: "invalid key" };
  const value = b.value;
  if (!value || typeof value !== "object") return { ok: false, error: "value must be an object or array" };
  let text: string;
  try { text = JSON.stringify(value); } catch { return { ok: false, error: "value must be JSON" }; }
  if (text.length > MAX_UI_PREF_VALUE_BYTES) return { ok: false, error: "value too large" };
  return { ok: true, key: b.key, value: value as object };
}

type HeaderGetter = { get(name: string): string | null };

/** Same-origin JSON with a declared size within the cap; null = allowed. */
export function checkPrefWrite(headers: HeaderGetter, requestOrigin: string): { status: number; error: string } | null {
  const origin = headers.get("origin");
  if (!origin) return { status: 403, error: "missing Origin" };
  let o: URL;
  let r: URL;
  try {
    o = new URL(origin);
    r = new URL(requestOrigin);
  } catch {
    return { status: 403, error: "bad Origin" };
  }
  const hosts = [headers.get("x-forwarded-host"), headers.get("host"), r.host].filter(Boolean);
  if (!hosts.includes(o.host)) return { status: 403, error: "cross-origin request refused" };
  const type = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "Content-Type must be application/json" };
  const len = headers.get("content-length");
  if (len != null && (!/^[0-9]+$/.test(len) || Number(len) > MAX_UI_PREF_BODY_BYTES)) return { status: 413, error: "body too large" };
  return null;
}
