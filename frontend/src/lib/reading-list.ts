/**
 * Want to read list (PROD-READLIST-01): shared, import-free rules for the client and the server.
 *
 * The list is pds.books rows with status 'queued' that are not taken off the list (sql/reading_want_list.sql).
 * Every change is ONE operation with a UUID `op_key`. The exact body is written to this device BEFORE it is sent
 * (fail closed: when the device cannot keep it, nothing is sent), and a send whose answer was lost is retried with
 * the SAME body. The server applies each change atomically through pds.reading_list_apply and records it in
 * pds.reading_list_ops: the same key with the same payload is answered from the record; the same key with another
 * payload is refused (`key_reused`). Edits carry the version the editor started from; a newer version on the server
 * is a conflict Riley resolves, never a silent overwrite.
 */

export const LIST_URL = "/api/reading/list";
/** Device copy of unconfirmed input and operations (localStorage; the `onyx` prefix is wiped on sign-out). */
export const LIST_LOCAL_KEY = "onyx.reading.list.v2";
export const LIST_MAX_BODY_BYTES = 8 * 1024;
export const TITLE_MAX = 300;
export const AUTHOR_MAX = 200;
/** Unconfirmed row actions kept at most; a new action past this is refused (never an older one dropped). */
export const MAX_PENDING = 20;
export const MAX_ORDER = 500;

export type ListOpKind = "create" | "edit" | "move" | "remove" | "restore" | "start";
export type BookStatus = "queued" | "reading" | "finished" | "abandoned";

export interface ListItem {
  book_id: number;
  slug: string;
  title: string;
  author: string | null;
  /** ISBN-13 or ASIN typed on the list; null = none. */
  edition: string | null;
  position: number | null;
  version: number;
  status: BookStatus;
  /** Queued and not taken off the list. */
  listed: boolean;
  created_at: string;
}

export interface DuplicateCandidate {
  book_id: number;
  status: BookStatus;
  listed: boolean;
  match: "identifier" | "title";
}

export type Resolve = "distinct" | { reuse: number };

export type ListOp =
  | { op: "create"; op_key: string; title: string; author: string | null; edition: string | null; resolve: Resolve | null }
  | { op: "edit"; op_key: string; book_id: number; expected_version: number; title: string; author: string | null; edition: string | null }
  | { op: "move"; op_key: string; book_id: number; direction: "up" | "down"; expected_order: number[] }
  | { op: "remove" | "restore"; op_key: string; book_id: number; expected_version: number }
  | { op: "start"; op_key: string; book_id: number; expected_version: number; start_date: string | null };

/** Short error codes the route answers (never a title or other private text). */
export type ListErrorCode =
  | "bad_request"
  | "bad_title"
  | "bad_author"
  | "bad_identifier"
  | "bad_date"
  | "not_found"
  | "not_queued"
  | "changed"
  | "duplicate"
  | "key_reused"
  | "list_unavailable"
  | "failed";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function newOpKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ------------------------------------------------------------------ */
/* Fields                                                               */
/* ------------------------------------------------------------------ */

/** Text as stored: NFC, no control characters, inner whitespace collapsed, trimmed. */
export function cleanText(v: string): string {
  return v.normalize("NFC").replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
}

/** Comparison key for "same title" (case and spacing ignored; the SQL function uses the same rule). */
export function titleKey(title: string): string {
  return cleanText(title).toLowerCase();
}

function isbn10Valid(s: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === "X" ? 10 : Number(s[i])) * (10 - i);
  return sum % 11 === 0;
}

function isbn13Check(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

/**
 * Edition identifier: ISBN-13, ISBN-10 (stored as its ISBN-13) or an ASIN (B + 9 letters/digits). Spaces and
 * hyphens are ignored. Empty = null. Anything else (or a wrong check digit) = undefined.
 */
export function normalizeIdentifier(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.length > 40) return undefined;
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  if (!s) return null;
  if (/^97[89]\d{10}$/.test(s)) return isbn13Check(s.slice(0, 12)) === Number(s[12]) ? s : undefined;
  if (/^\d{9}[\dX]$/.test(s)) {
    if (!isbn10Valid(s)) return undefined;
    const twelve = "978" + s.slice(0, 9);
    return twelve + String(isbn13Check(twelve));
  }
  if (/^B[0-9A-Z]{9}$/.test(s)) return s;
  return undefined;
}

/**
 * Every stored form one normalized identifier can take: the ISBN-13 itself and, for a 978 ISBN, its ISBN-10
 * (a print book's Kindle asin is its ISBN-10). The SQL function matches edition_identifier and the harvester's
 * asin against these.
 */
export function identityForms(normalized: string | null): string[] {
  if (!normalized) return [];
  if (/^978\d{10}$/.test(normalized)) {
    const nine = normalized.slice(3, 12);
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(nine[i]) * (10 - i);
    const c = (11 - (sum % 11)) % 11;
    return [normalized, nine + (c === 10 ? "X" : String(c))];
  }
  return [normalized];
}

/** A real calendar date YYYY-MM-DD, null for empty, undefined for anything else. */
export function ymd(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : undefined;
}

export type CleanFields = { title: string; author: string | null; edition: string | null };

/** Title (required), author and edition identifier, cleaned; the first problem as an error code. */
export function parseFields(b: Record<string, unknown>): { ok: true; fields: CleanFields } | { ok: false; error: ListErrorCode } {
  if (typeof b.title !== "string") return { ok: false, error: "bad_title" };
  const title = cleanText(b.title);
  if (!title || title.length > TITLE_MAX) return { ok: false, error: "bad_title" };
  let author: string | null = null;
  if (b.author !== undefined && b.author !== null) {
    if (typeof b.author !== "string") return { ok: false, error: "bad_author" };
    author = cleanText(b.author) || null;
    if (author && author.length > AUTHOR_MAX) return { ok: false, error: "bad_author" };
  }
  const edition = normalizeIdentifier(b.edition);
  if (edition === undefined) return { ok: false, error: "bad_identifier" };
  return { ok: true, fields: { title, author, edition } };
}

const FIELDS_BY_OP: Record<ListOpKind, string[]> = {
  create: ["op", "op_key", "title", "author", "edition", "resolve"],
  edit: ["op", "op_key", "book_id", "expected_version", "title", "author", "edition"],
  move: ["op", "op_key", "book_id", "direction", "expected_order"],
  remove: ["op", "op_key", "book_id", "expected_version"],
  restore: ["op", "op_key", "book_id", "expected_version"],
  start: ["op", "op_key", "book_id", "expected_version", "start_date"],
};

const posInt = (v: unknown, min: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= 2 ** 31 ? v : null);

/** Parse a POST body (pure). Unknown fields, a missing or malformed op_key and bad numbers are refused. */
export function parseListOp(raw: unknown): { ok: true; op: ListOp } | { ok: false; error: ListErrorCode } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "bad_request" };
  const b = raw as Record<string, unknown>;
  const kind = b.op as ListOpKind;
  if (typeof kind !== "string" || !Object.prototype.hasOwnProperty.call(FIELDS_BY_OP, kind)) return { ok: false, error: "bad_request" };
  for (const k of Object.keys(b)) if (!FIELDS_BY_OP[kind].includes(k)) return { ok: false, error: "bad_request" };
  if (!isUuid(b.op_key)) return { ok: false, error: "bad_request" };
  const op_key = b.op_key.toLowerCase();

  if (kind === "create") {
    const f = parseFields(b);
    if (!f.ok) return f;
    let resolve: Resolve | null = null;
    if (b.resolve === "distinct") resolve = "distinct";
    else if (b.resolve && typeof b.resolve === "object" && !Array.isArray(b.resolve)) {
      const r = b.resolve as Record<string, unknown>;
      const id = posInt(r.reuse, 1);
      if (Object.keys(r).length !== 1 || id === null) return { ok: false, error: "bad_request" };
      resolve = { reuse: id };
    } else if (b.resolve !== undefined && b.resolve !== null) return { ok: false, error: "bad_request" };
    return { ok: true, op: { op: "create", op_key, ...f.fields, resolve } };
  }

  const book_id = posInt(b.book_id, 1);
  if (book_id === null) return { ok: false, error: "bad_request" };
  if (kind === "move") {
    if (b.direction !== "up" && b.direction !== "down") return { ok: false, error: "bad_request" };
    const order = b.expected_order;
    if (!Array.isArray(order) || order.length > MAX_ORDER || order.some((x) => posInt(x, 1) === null)) return { ok: false, error: "bad_request" };
    if (new Set(order).size !== order.length || !order.includes(book_id)) return { ok: false, error: "bad_request" };
    return { ok: true, op: { op: "move", op_key, book_id, direction: b.direction, expected_order: order as number[] } };
  }
  const expected_version = posInt(b.expected_version, 0);
  if (expected_version === null) return { ok: false, error: "bad_request" };
  const base = { op_key, book_id, expected_version };
  if (kind === "edit") {
    const f = parseFields(b);
    if (!f.ok) return f;
    return { ok: true, op: { op: "edit", ...base, ...f.fields } };
  }
  if (kind === "start") {
    const d = ymd(b.start_date);
    if (d === undefined) return { ok: false, error: "bad_date" };
    return { ok: true, op: { op: "start", ...base, start_date: d } };
  }
  return { ok: true, op: { op: kind, ...base } };
}

/**
 * The normalized payload of an operation as one canonical string (fixed key order, everything but op_key). The
 * server stores its hash with the operation; the same key arriving with another payload is `key_reused`.
 */
export function canonicalPayload(op: ListOp): string {
  const parts: Array<[string, unknown]> = [["op", op.op]];
  if (op.op === "create") {
    parts.push(["title", op.title], ["author", op.author], ["edition", op.edition]);
    parts.push(["resolve", op.resolve === null ? null : op.resolve === "distinct" ? "distinct" : `reuse:${op.resolve.reuse}`]);
  } else {
    parts.push(["book_id", op.book_id]);
    if (op.op === "move") parts.push(["direction", op.direction], ["expected_order", op.expected_order]);
    else parts.push(["expected_version", op.expected_version]);
    if (op.op === "edit") parts.push(["title", op.title], ["author", op.author], ["edition", op.edition]);
    if (op.op === "start") parts.push(["start_date", op.start_date]);
  }
  return JSON.stringify(parts);
}

/** Deterministic list order: position ascending (rows without one last), then book_id. */
export function sortItems<T extends { book_id: number; position: number | null }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.position !== b.position) {
      if (a.position === null) return 1;
      if (b.position === null) return -1;
      return a.position - b.position;
    }
    return a.book_id - b.book_id;
  });
}

/** The /reading book switcher: books with a quest, plus the one on screen (always kept, even if queued). */
export function questBooks<T extends { slug: string; status: string }>(books: T[], shownSlug: string | null): T[] {
  return books.filter((b) => b.status !== "queued" || b.slug === shownSlug);
}

/* ------------------------------------------------------------------ */
/* Drafts: the Add a book box and each row editor                        */
/* ------------------------------------------------------------------ */

/** What a box holds, as typed. */
export type Fields = { title: string; author: string; edition: string };
export type Body = Record<string, unknown> & { op: ListOpKind; op_key: string };

export interface Draft {
  /** null = a new book (Add a book) until its create is confirmed. */
  book_id: number | null;
  /** The version this box's words are based on (the create's or the last confirmed edit's result). */
  base_version: number | null;
  /** What the server holds at base_version, as this box last saw it; null until confirmed. */
  saved: CleanFields | null;
  /** What the box holds now. */
  fields: Fields;
  /** The exact body sent whose answer has not arrived: always resent unchanged before anything newer. */
  sent: Body | null;
  /** Riley's duplicate choice for the next create (a new key is used with it). */
  resolve: Resolve | null;
  /** The server's newer copy after a conflict: nothing is sent until Riley picks one. */
  conflict: ListItem | null;
}

export const emptyFields = (): Fields => ({ title: "", author: "", edition: "" });
export const newDraft = (): Draft => ({ book_id: null, base_version: null, saved: null, fields: emptyFields(), sent: null, resolve: null, conflict: null });
export const editDraft = (item: ListItem): Draft => ({
  book_id: item.book_id,
  base_version: item.version,
  saved: { title: item.title, author: item.author, edition: item.edition },
  fields: { title: item.title, author: item.author ?? "", edition: item.edition ?? "" },
  sent: null,
  resolve: null,
  conflict: null,
});

/** The cleaned form of what the box holds; null when not ready to send (no title, bad identifier). */
export function cleanFields(f: Fields): CleanFields | null {
  const p = parseFields({ title: f.title, author: f.author, edition: f.edition });
  return p.ok ? p.fields : null;
}

const sameClean = (a: CleanFields | null, b: CleanFields | null) =>
  !!a && !!b && a.title === b.title && a.author === b.author && a.edition === b.edition;

/** True when nothing in the box differs from what the server confirmed (and nothing is in flight). */
export function draftSettled(d: Draft): boolean {
  if (d.sent) return false;
  if (d.book_id === null) return !d.fields.title.trim() && !d.fields.author.trim() && !d.fields.edition.trim();
  return sameClean(cleanFields(d.fields), d.saved);
}

/** Restored unsent words are not an acknowledged autosave baseline. Hydration itself still sends nothing. */
export function draftBaseline(d: Draft): Fields | undefined {
  return draftSettled(d) ? d.fields : undefined;
}

/**
 * What to send next for a box (pure). An unanswered body goes first, unchanged. A new book is created from what
 * the box holds; a confirmed book gets an edit based on base_version. null = nothing to send (or waiting on a
 * conflict choice, or the words are not ready).
 */
export function nextSend(d: Draft, newKey: () => string): { draft: Draft; body: Body } | null {
  if (d.sent) return { draft: d, body: d.sent };
  if (d.conflict) return null;
  const clean = cleanFields(d.fields);
  if (!clean) return null;
  if (d.book_id === null) {
    const body: Body = { op: "create", op_key: newKey(), ...clean, ...(d.resolve ? { resolve: d.resolve } : {}) };
    return { draft: { ...d, sent: body }, body };
  }
  if (sameClean(clean, d.saved)) return null;
  const body: Body = { op: "edit", op_key: newKey(), book_id: d.book_id, expected_version: d.base_version ?? 0, ...clean };
  return { draft: { ...d, sent: body }, body };
}

export type Outcome =
  | { kind: "applied" }
  | { kind: "reused"; item: ListItem | null }
  | { kind: "not_listed" }
  | { kind: "conflict" }
  | { kind: "duplicate"; candidates: DuplicateCandidate[]; distinctAllowed: boolean }
  | { kind: "refused"; code: string };

/**
 * Fold the server's DEFINITIVE answer (anything but a network failure / 5xx) to `body` into the draft (pure).
 * A confirmed create binds the book with the version and fields the CREATE stored (not newer typing, which is
 * sent next as an edit). A confirmed edit moves base_version to that edit's result.
 */
export function applyAnswer(d: Draft, body: Body, status: number, json: Record<string, unknown>): { draft: Draft; outcome: Outcome } {
  const cleared = { ...d, sent: null };
  const item = (json.item as ListItem | null | undefined) ?? null;
  if (status === 200) {
    const version = typeof json.op_version === "number" ? json.op_version : null;
    const stored: CleanFields = { title: String(body.title ?? ""), author: (body.author as string | null) ?? null, edition: (body.edition as string | null) ?? null };
    if (body.op === "create") {
      if (json.reused) return { draft: { ...newDraft() }, outcome: { kind: "reused", item } };
      if (item && !item.listed) {
        // The create was applied earlier, then the book left the list (started or removed elsewhere): the words stay
        // in the box as a new, unsent book (Keep or an edit sends them; nothing is attached to the other book).
        return { draft: { ...newDraft(), fields: d.fields }, outcome: { kind: "not_listed" } };
      }
      const id = typeof json.book_id === "number" ? json.book_id : item?.book_id ?? null;
      return { draft: { ...cleared, book_id: id, base_version: version, saved: stored, resolve: null }, outcome: { kind: "applied" } };
    }
    return { draft: { ...cleared, base_version: version ?? d.base_version, saved: stored }, outcome: { kind: "applied" } };
  }
  const code = typeof json.error === "string" ? json.error : "failed";
  if (code === "changed" && item) return { draft: { ...cleared, conflict: item }, outcome: { kind: "conflict" } };
  if (code === "duplicate") {
    return {
      draft: { ...cleared, resolve: null },
      outcome: { kind: "duplicate", candidates: (json.candidates as DuplicateCandidate[]) ?? [], distinctAllowed: !!json.distinct_allowed },
    };
  }
  return { draft: cleared, outcome: { kind: "refused", code } };
}

/** Riley keeps his words after a conflict: base them on the server's newer version, then they are sent. */
export function keepMine(d: Draft): Draft {
  if (!d.conflict) return d;
  const c = d.conflict;
  return { ...d, conflict: null, base_version: c.version, saved: { title: c.title, author: c.author, edition: c.edition } };
}

/** Riley takes the saved version after a conflict: the box shows it and has nothing left to send. */
export function takeSaved(d: Draft): Draft {
  if (!d.conflict) return d;
  return { ...editDraft(d.conflict) };
}

/* ------------------------------------------------------------------ */
/* Device copy (fail closed)                                            */
/* ------------------------------------------------------------------ */

export interface PendingOp {
  /** The exact body that was (or is about to be) sent; resent unchanged by Retry. */
  body: Body;
  at: number;
}

export interface ListLocal {
  v: 2;
  /** The Add a book box. */
  add: Draft | null;
  /** Row editors with words not confirmed yet, by book id. */
  edits: Record<string, Draft>;
  /** Row actions (move, remove, restore, start) sent without an answer yet. */
  pending: PendingOp[];
}

export const emptyLocal = (): ListLocal => ({ v: 2, add: null, edits: {}, pending: [] });

export type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

/** localStorage, or null when there is none or reading it throws (private mode, blocked storage). */
export function safeStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    const s = window.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function validDraft(d: unknown): Draft | null {
  const x = d as Draft | null;
  if (!x || typeof x !== "object" || !x.fields) return null;
  const f = x.fields;
  if (typeof f.title !== "string" || typeof f.author !== "string" || typeof f.edition !== "string") return null;
  if (x.sent && (!isUuid(x.sent.op_key) || typeof x.sent.op !== "string")) return null;
  return {
    book_id: posInt(x.book_id, 1),
    base_version: posInt(x.base_version, 0),
    saved: x.saved && typeof x.saved.title === "string" ? x.saved : null,
    fields: { title: f.title, author: f.author, edition: f.edition },
    sent: x.sent ?? null,
    resolve: x.resolve ?? null,
    conflict: x.conflict ?? null,
  };
}

/** Read the device copy; malformed parts read as empty. Nothing unresolved is dropped. */
export function readLocal(storage: StorageLike | null | undefined): ListLocal {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(LIST_LOCAL_KEY) ?? null;
  } catch {
    return emptyLocal();
  }
  if (!raw) return emptyLocal();
  try {
    const v = JSON.parse(raw) as ListLocal;
    if (!v || v.v !== 2) return emptyLocal();
    const edits: Record<string, Draft> = {};
    for (const [k, d] of Object.entries(v.edits ?? {})) {
      const ok = validDraft(d);
      if (ok && ok.book_id !== null) edits[k] = ok;
    }
    const pending = Array.isArray(v.pending) ? v.pending.filter((p) => p && p.body && isUuid(p.body.op_key) && typeof p.body.op === "string") : [];
    return { v: 2, add: validDraft(v.add), edits, pending };
  } catch {
    return emptyLocal();
  }
}

/** Write the device copy. false = it could not be kept (no storage, quota, blocked): the caller must not send. */
export function writeLocal(storage: StorageLike | null | undefined, value: ListLocal): boolean {
  if (!storage) return false;
  try {
    const empty = !value.add && Object.keys(value.edits).length === 0 && value.pending.length === 0;
    if (empty) storage.removeItem(LIST_LOCAL_KEY);
    else storage.setItem(LIST_LOCAL_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a row action before it leaves (pure + one write). Refused when the device cannot keep it (`storage`) or
 * MAX_PENDING unconfirmed actions are already waiting (`full`); no recorded action is ever dropped to make room.
 */
export function recordPending(
  storage: StorageLike | null | undefined,
  local: ListLocal,
  body: Body,
  now: number,
): { ok: true; local: ListLocal } | { ok: false; reason: "storage" | "full" } {
  if (local.pending.some((p) => p.body.op_key === body.op_key)) {
    return writeLocal(storage, local) ? { ok: true, local } : { ok: false, reason: "storage" };
  }
  if (local.pending.length >= MAX_PENDING) return { ok: false, reason: "full" };
  const next = { ...local, pending: [...local.pending, { body, at: now }] };
  return writeLocal(storage, next) ? { ok: true, local: next } : { ok: false, reason: "storage" };
}

/** Drop a row action once the server answered it (applied, replayed or refused). */
export function withoutPending(local: ListLocal, opKey: string): ListLocal {
  return { ...local, pending: local.pending.filter((p) => p.body.op_key !== opKey) };
}

/** A box's draft in the device copy (null = remove it). */
export function withDraft(local: ListLocal, which: "add" | number, d: Draft | null): ListLocal {
  if (which === "add") return { ...local, add: d };
  const edits = { ...local.edits };
  if (d) edits[String(which)] = d;
  else delete edits[String(which)];
  return { ...local, edits };
}

/** Product copy for an error code. */
export function listErrorText(code: string | null | undefined): string {
  switch (code) {
    case "bad_title":
      return "Add a title.";
    case "bad_author":
      return "That author name is too long.";
    case "bad_identifier":
      return "That isn't a valid ISBN or ASIN.";
    case "bad_date":
      return "Pick a real day, today or earlier.";
    case "not_found":
      return "That book is no longer in Reading.";
    case "not_queued":
      return "That book is no longer on your list.";
    case "changed":
      return "This was changed somewhere else.";
    case "duplicate":
      return "This may already be in Reading.";
    case "key_reused":
      return "This change didn't match what was sent before, so it wasn't saved.";
    case "list_unavailable":
      return "Your list isn't available yet.";
    case "storage":
      return "This device can't keep the change, so it wasn't sent.";
    case "full":
      return "Too many changes are waiting. Retry or dismiss them first.";
    default:
      return "Couldn't save. Trying again.";
  }
}
