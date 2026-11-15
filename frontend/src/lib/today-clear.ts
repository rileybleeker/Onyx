/**
 * Clearing items from Today (2026-11-14). Import-free, so tests/today-regression.cjs can bundle it.
 *
 * Today lists two kinds of thing Riley may want gone:
 *  - Agent Inbox cards (Needs your input, and inbox-triage's "Urgent: ..." questions under Urgent
 *    email). Clearing one goes through the Worker's POST /onyx/dismiss, the same call as the
 *    Agents inbox's x / Clear all: the card leaves Unread and the badge, the agent still waits for
 *    an answer, and a card the agent shows again comes back.
 *  - Labelled email threads (pds.inbox_emails, Agent/Action or Agent/Deadline). Clearing one
 *    stores a row in pds.today_cleared_emails (POST /api/urgent-email/clear): the thread is left
 *    out of GET /api/urgent-email until a message NEWER than the one Riley cleared arrives in it.
 *    Nothing changes in Gmail (no label, read flag or archive), and the hourly label sync is not
 *    touched.
 */

/** One labelled thread as Today shows it: the item key from GET /api/urgent-email + its newest message time. */
export interface EmailClearMark {
  key: string;
  receivedAt: string;
}

export type ClearRequest =
  | { undo: false; items: { key: string; through: string }[] }
  | { undo: true; keys: string[] };

/** One request clears at most this many threads (Clear all on Today sends what it lists: at most 20). */
export const MAX_CLEAR_ITEMS = 50;
export const MAX_CLEAR_BODY_BYTES = 16_384;
/** A received time may sit this far in the future (junk Date headers; see FUTURE_SKEW_MS). */
const FUTURE_SLACK_MS = 2 * 86_400_000;
const KEY_MAX = 900;
// "thread:<account>:<decimal thread id>" or "msg:<account>:<Message-ID>" (lib/urgent-email-query.ts).
const KEY_RE = /^(?:thread|msg):[^\s\u0000-\u001f\u007f]+$/;

type HeaderGetter = { get(name: string): string | null };

/** Same-origin JSON with a size cap; null = acceptable. Mirrors checkMarkRequest in lib/online-orders.ts. */
export function checkClearRequest(headers: HeaderGetter, requestOrigin: string): { status: number; error: string } | null {
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
  if (len != null && (!/^[0-9]+$/.test(len) || Number(len) > MAX_CLEAR_BODY_BYTES)) return { status: 413, error: "body too large" };
  return null;
}

function isKey(k: unknown): k is string {
  return typeof k === "string" && k.length <= KEY_MAX && KEY_RE.test(k);
}

/**
 * Body of POST /api/urgent-email/clear: `{items: [{key, receivedAt}]}` clears, `{items: [{key}], undo: true}`
 * brings the threads back. Strict: unknown fields, bad keys or times, and empty or oversized lists are refused.
 */
export function parseClearBody(body: unknown, now: Date): { ok: true; request: ClearRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "items" && k !== "undo")) return { ok: false, error: "unknown field" };
  if (b.undo !== undefined && typeof b.undo !== "boolean") return { ok: false, error: "undo must be a boolean" };
  const undo = b.undo === true;
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > MAX_CLEAR_ITEMS) {
    return { ok: false, error: `items must list 1-${MAX_CLEAR_ITEMS} emails` };
  }
  const seen = new Map<string, string>();
  for (const raw of b.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "each item must be an object" };
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some((k) => k !== "key" && k !== "receivedAt")) return { ok: false, error: "unknown item field" };
    if (!isKey(item.key)) return { ok: false, error: "invalid key" };
    if (undo) {
      seen.set(item.key, "");
      continue;
    }
    if (typeof item.receivedAt !== "string" || item.receivedAt.length > 40) return { ok: false, error: "invalid receivedAt" };
    const t = new Date(item.receivedAt).getTime();
    if (!Number.isFinite(t) || t < Date.UTC(2000, 0, 1) || t > now.getTime() + FUTURE_SLACK_MS) return { ok: false, error: "invalid receivedAt" };
    const through = new Date(t).toISOString();
    const prev = seen.get(item.key);
    // The same thread twice: keep the later time, so the newer message is the one cleared.
    if (prev === undefined || prev < through) seen.set(item.key, through);
  }
  return undo
    ? { ok: true, request: { undo: true, keys: [...seen.keys()] } }
    : { ok: true, request: { undo: false, items: [...seen].map(([key, through]) => ({ key, through })) } };
}

/** A cleared thread stays hidden while its newest message is no newer than the one cleared. */
export function stillCleared(receivedAt: string, clearedThrough: string): boolean {
  const r = new Date(receivedAt).getTime();
  const c = new Date(clearedThrough).getTime();
  return Number.isFinite(r) && Number.isFinite(c) && r <= c;
}

/** Stored id of a cleared thread: SHA-256 hex of its key, so the table holds no address or thread id. */
export async function clearKeyHash(key: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Client-side hide key for a thread: a newer message in it is a different key, so it shows again. */
export function hiddenEmailKey(mark: EmailClearMark): string {
  return `${mark.key}|${mark.receivedAt}`;
}

/** Undo toast text. */
export function clearedLabel(count: number): string {
  return count === 1 ? "Cleared 1" : `Cleared ${count}`;
}
