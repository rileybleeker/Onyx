/**
 * Pure rules for texts pushed from an iPhone Shortcuts automation (2026-11-17).
 * Used by POST /api/phone-messages/ingest. No imports, no I/O, no process state.
 *
 * What is accepted: { sender, text, received_at? } or { messages: [...] } (at most
 * MAX_BATCH). What is refused or dropped: anything over the length caps,
 * text older than MAX_AGE_DAYS, a sender outside the optional allow-list
 * and anything that looks like a one-time / verification code (never stored).
 * Message text never appears in an error or a count.
 */

export const MAX_BATCH = 20;
export const MAX_TEXT = 4000;
export const MAX_SENDER = 200;
export const MAX_AGE_DAYS = 30;
export const RETENTION_DAYS = 90;
const FUTURE_SKEW_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export interface IncomingText {
  sender: string;
  text: string;
  receivedAt: string; // ISO
}

export interface ParsedBatch {
  ok: true;
  items: IncomingText[];
  skippedCodes: number;
  skippedScope: number;
  skippedInvalid: number;
}
export type ParseResult = ParsedBatch | { ok: false; error: string };

const CODE_WORDS =
  /\b(code|verification|verify|passcode|one[- ]time|otp|2fa|two[- ]factor|security code|login|log in|sign[- ]?in|password|pin)\b/i;
const DIGIT_RUN = /(?:^|[^\d])(\d{4,8}|\d{3}[- ]\d{3})(?!\d)/;

/** A text that carries a short numeric code next to verification wording. Dropped, never stored. */
export function looksLikeOneTimeCode(text: string): boolean {
  return CODE_WORDS.test(text) && DIGIT_RUN.test(text);
}

/** Comparable form of a sender: digits only for a phone number, else lower-case text. */
export function normalizeSender(s: string): string {
  const t = s.trim().toLowerCase();
  const digits = t.replace(/\D/g, "");
  return digits.length >= 7 && digits.length >= t.replace(/[\s()+.-]/g, "").length - 1 ? digits.slice(-10) : t;
}

/** Allow-list from a comma separated env value. Empty = no restriction (the Shortcut's own filter scopes it). */
export function parseAllowList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => normalizeSender(s))
    .filter(Boolean);
}

export function senderAllowed(sender: string, allow: string[]): boolean {
  if (allow.length === 0) return true;
  return allow.includes(normalizeSender(sender));
}

function oneString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\u0000/g, "").trim();
  return s ? s : null;
}

/**
 * The automation fires when the text arrives, so a missing, unreadable or future
 * time means "now". Only a text older than MAX_AGE_DAYS is refused (null).
 */
function parseWhen(v: unknown, nowMs: number): string | null {
  const ms = typeof v === "string" || typeof v === "number" ? new Date(v as string).getTime() : NaN;
  if (!Number.isFinite(ms) || ms > nowMs + FUTURE_SKEW_MS) return new Date(nowMs).toISOString();
  if (ms < nowMs - MAX_AGE_DAYS * DAY_MS) return null;
  return new Date(Math.min(ms, nowMs)).toISOString();
}

export function parseIngestBody(body: unknown, nowMs: number, allow: string[]): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object" };
  const o = body as Record<string, unknown>;
  const raw: unknown[] = Array.isArray(o.messages) ? o.messages : [o];
  if (raw.length === 0) return { ok: false, error: "No messages" };
  if (raw.length > MAX_BATCH) return { ok: false, error: `At most ${MAX_BATCH} messages per request` };

  const items: IncomingText[] = [];
  let skippedCodes = 0;
  let skippedScope = 0;
  let skippedInvalid = 0;
  for (const r of raw) {
    if (!r || typeof r !== "object") { skippedInvalid++; continue; }
    const m = r as Record<string, unknown>;
    const sender = oneString(m.sender);
    const text = oneString(m.text);
    const when = parseWhen(m.received_at, nowMs);
    if (!sender || !text || !when || sender.length > MAX_SENDER || text.length > MAX_TEXT) { skippedInvalid++; continue; }
    if (!senderAllowed(sender, allow)) { skippedScope++; continue; }
    if (looksLikeOneTimeCode(text)) { skippedCodes++; continue; }
    items.push({ sender, text, receivedAt: when });
  }
  return { ok: true, items, skippedCodes, skippedScope, skippedInvalid };
}
