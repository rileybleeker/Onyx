// Care items stored in Onyx (pds.care_items): the wire shapes and checks shared by /health and
// the /api/care/* routes. Pure helpers only: no Supabase, no React, no Node built-ins, so the
// browser bundle and the offline tests (tests/care-items.test.cjs) load the same code.
//
// The table is service-role only. The browser talks to /api/care/items (owner session, same
// origin, JSON, small bodies); nothing here is reachable with the CI token.
import {
  CARE_KINDS,
  DEFAULT_TZ,
  REPEAT_OPTIONS,
  isSampleItem,
  parseLocalItems,
  validDate,
  validTime,
  validTimeZone,
  type CareItem,
  type CareKind,
  type LocalCareItem,
} from "@/lib/care-planner";

export const MAX_CARE_ITEMS = 500;
export const MAX_TITLE = 100;
export const MAX_NOTES = 1000;
/** One item with a full note fits well inside this (1000 chars of 4-byte text + the other fields). */
export const MAX_ITEM_BODY_BYTES = 6_000;
/** The one-time copy of a browser's saved planner: at most 500 short items. */
export const MAX_IMPORT_BODY_BYTES = 150_000;

/** Columns read from pds.care_items. Explicit on purpose: never `*`. */
export const CARE_COLUMNS = "id,title,kind,due_date,due_time,time_zone,repeat_months,booked,notes,archived,last_completed_on";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// C0 controls except tab / newline / carriage return, plus DEL. Notes may have line breaks; labels may not.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LINE_BREAK_RE = /[\t\n\r]/;

export function parseItemId(raw: unknown): string | null {
  return typeof raw === "string" && UUID_RE.test(raw) ? raw : null;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };
type Field<T> = { ok: true; value: T } | { ok: false; error: string };

function titleField(v: unknown): Field<string> {
  if (typeof v !== "string") return { ok: false, error: "title must be text" };
  const title = v.trim();
  if (!title || title.length > MAX_TITLE) return { ok: false, error: `title must be 1 to ${MAX_TITLE} characters` };
  if (CONTROL_RE.test(title) || LINE_BREAK_RE.test(title)) return { ok: false, error: "title must be one line of plain text" };
  return { ok: true, value: title };
}
function kindField(v: unknown): Field<CareKind> {
  return typeof v === "string" && (CARE_KINDS as readonly string[]).includes(v)
    ? { ok: true, value: v as CareKind }
    : { ok: false, error: `kind must be one of ${CARE_KINDS.join(", ")}` };
}
function dateField(name: string, v: unknown): Field<string> {
  return typeof v === "string" && validDate(v) && v >= "1900-01-01" && v <= "9998-12-31"
    ? { ok: true, value: v }
    : { ok: false, error: `${name} must be a real date, YYYY-MM-DD` };
}
function timeField(v: unknown): Field<string | null> {
  if (v === null) return { ok: true, value: null };
  return validTime(v) ? { ok: true, value: v } : { ok: false, error: "time must be null or HH:MM (24-hour)" };
}
function tzField(v: unknown): Field<string> {
  return validTimeZone(v) ? { ok: true, value: v } : { ok: false, error: "tz must be an IANA time zone such as America/New_York" };
}
function monthsField(v: unknown): Field<number> {
  return typeof v === "number" && (REPEAT_OPTIONS as readonly number[]).includes(v)
    ? { ok: true, value: v }
    : { ok: false, error: `months must be one of ${REPEAT_OPTIONS.join(", ")}` };
}
function boolField(name: string, v: unknown): Field<boolean> {
  return typeof v === "boolean" ? { ok: true, value: v } : { ok: false, error: `${name} must be true or false` };
}
function notesField(v: unknown): Field<string> {
  if (typeof v !== "string") return { ok: false, error: "notes must be text" };
  if (v.length > MAX_NOTES) return { ok: false, error: `notes must be at most ${MAX_NOTES} characters` };
  if (CONTROL_RE.test(v)) return { ok: false, error: "notes must be plain text" };
  return { ok: true, value: v };
}
function completedField(v: unknown): Field<string | null> {
  return v === null ? { ok: true, value: null } : dateField("completedOn", v);
}

function plainObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

const ITEM_KEYS = ["id", "title", "kind", "due", "time", "tz", "months", "booked", "notes", "archived", "completedOn"] as const;

/**
 * A complete care item: every field present, nothing extra. Used for the POST body and for
 * checking what the API sent back before it is put on screen.
 */
export function parseCareItem(body: unknown): Result<{ item: CareItem }> {
  const o = plainObject(body);
  if (!o) return { ok: false, error: "body must be a JSON object" };
  const extra = Object.keys(o).find((k) => !(ITEM_KEYS as readonly string[]).includes(k));
  if (extra) return { ok: false, error: "unknown field" };
  const missing = ITEM_KEYS.find((k) => !(k in o));
  if (missing) return { ok: false, error: `missing ${missing}` };
  const id = parseItemId(o.id);
  if (!id) return { ok: false, error: "id must be a lowercase UUID" };
  if (isSampleItem({ id })) return { ok: false, error: "sample items are never saved" };
  const title = titleField(o.title);
  if (!title.ok) return title;
  const kind = kindField(o.kind);
  if (!kind.ok) return kind;
  const due = dateField("due", o.due);
  if (!due.ok) return due;
  const time = timeField(o.time);
  if (!time.ok) return time;
  const tz = tzField(o.tz);
  if (!tz.ok) return tz;
  const months = monthsField(o.months);
  if (!months.ok) return months;
  const booked = boolField("booked", o.booked);
  if (!booked.ok) return booked;
  const notes = notesField(o.notes);
  if (!notes.ok) return notes;
  const archived = boolField("archived", o.archived);
  if (!archived.ok) return archived;
  const completedOn = completedField(o.completedOn);
  if (!completedOn.ok) return completedOn;
  return {
    ok: true,
    item: {
      id, title: title.value, kind: kind.value, due: due.value, time: time.value, tz: tz.value, months: months.value,
      booked: booked.value, notes: notes.value, archived: archived.value, completedOn: completedOn.value,
    },
  };
}

/** What a PATCH may change. `removed: false` brings back a removed item (Undo); true is refused (use DELETE). */
export type CarePatch = Partial<Omit<CareItem, "id">> & { removed?: false };

/** Body of PATCH /api/care/items/[id]: one or more known fields, nothing else. */
export function parseCarePatch(body: unknown): Result<{ patch: CarePatch }> {
  const o = plainObject(body);
  if (!o) return { ok: false, error: "body must be a JSON object" };
  const keys = Object.keys(o);
  if (keys.length === 0) return { ok: false, error: "nothing to change" };
  const patch: CarePatch = {};
  for (const key of keys) {
    const v = o[key];
    let f: Field<unknown>;
    switch (key) {
      case "title": f = titleField(v); if (f.ok) patch.title = f.value as string; break;
      case "kind": f = kindField(v); if (f.ok) patch.kind = f.value as CareKind; break;
      case "due": f = dateField("due", v); if (f.ok) patch.due = f.value as string; break;
      case "time": f = timeField(v); if (f.ok) patch.time = f.value as string | null; break;
      case "tz": f = tzField(v); if (f.ok) patch.tz = f.value as string; break;
      case "months": f = monthsField(v); if (f.ok) patch.months = f.value as number; break;
      case "booked": f = boolField("booked", v); if (f.ok) patch.booked = f.value as boolean; break;
      case "notes": f = notesField(v); if (f.ok) patch.notes = f.value as string; break;
      case "archived": f = boolField("archived", v); if (f.ok) patch.archived = f.value as boolean; break;
      case "completedOn": f = completedField(v); if (f.ok) patch.completedOn = f.value as string | null; break;
      case "removed":
        f = v === false ? { ok: true, value: false } : { ok: false, error: "removed may only be false (use DELETE to remove)" };
        if (f.ok) patch.removed = false;
        break;
      default: return { ok: false, error: "unknown field" };
    }
    if (!f.ok) return f;
  }
  return { ok: true, patch };
}

/**
 * Body of POST /api/care/items/import: {items: [the browser planner's saved items], tz}. The
 * items keep the old six-field shape; sample items are refused (they are never saved anywhere).
 */
export function parseImportBody(body: unknown): Result<{ items: LocalCareItem[]; tz: string }> {
  const o = plainObject(body);
  if (!o) return { ok: false, error: "body must be a JSON object" };
  const keys = Object.keys(o);
  if (keys.some((k) => k !== "items" && k !== "tz") || !("items" in o)) return { ok: false, error: "body must be {items, tz}" };
  const tz = o.tz === undefined ? DEFAULT_TZ : o.tz;
  if (!validTimeZone(tz)) return { ok: false, error: "tz must be an IANA time zone" };
  let items: LocalCareItem[];
  try {
    items = parseLocalItems(o.items);
  } catch {
    return { ok: false, error: "items must be the saved planner list" };
  }
  if (items.length === 0) return { ok: false, error: "nothing to copy" };
  if (items.some(isSampleItem)) return { ok: false, error: "sample items are never saved" };
  for (const item of items) {
    const title = titleField(item.title);
    if (!title.ok) return title;
    item.title = title.value;
  }
  return { ok: true, items, tz };
}

// ---- rows <-> items ---------------------------------------------------------

/** A pds.care_items row as a CareItem; null for a row that does not have the expected shape. */
export function rowToItem(row: unknown): CareItem | null {
  const r = plainObject(row);
  if (!r) return null;
  const time = typeof r.due_time === "string" ? r.due_time.slice(0, 5) : r.due_time;
  const parsed = parseCareItem({
    id: r.id, title: r.title, kind: r.kind, due: r.due_date, time: time ?? null, tz: r.time_zone, months: r.repeat_months,
    booked: r.booked, notes: r.notes ?? "", archived: r.archived, completedOn: r.last_completed_on ?? null,
  });
  return parsed.ok ? parsed.item : null;
}

/** Column values for the fields present in a patch (or a whole item). */
export function toColumns(fields: CarePatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fields.title !== undefined) out.title = fields.title;
  if (fields.kind !== undefined) out.kind = fields.kind;
  if (fields.due !== undefined) out.due_date = fields.due;
  if (fields.time !== undefined) out.due_time = fields.time;
  if (fields.tz !== undefined) out.time_zone = fields.tz;
  if (fields.months !== undefined) out.repeat_months = fields.months;
  if (fields.booked !== undefined) out.booked = fields.booked;
  if (fields.notes !== undefined) out.notes = fields.notes;
  if (fields.archived !== undefined) out.archived = fields.archived;
  if (fields.completedOn !== undefined) out.last_completed_on = fields.completedOn;
  if (fields.removed === false) out.removed_at = null;
  return out;
}

// ---- request checks ---------------------------------------------------------

type HeaderGetter = { get(name: string): string | null };

/**
 * CSRF + shape checks before a write is read: a same-origin Origin (a browser always sends one
 * on POST / PATCH / DELETE, so a missing one is refused) and, when the request has a body, a
 * JSON content type and a small declared size. Returns null when the request may go on.
 */
export function checkCareRequest(headers: HeaderGetter, requestOrigin: string, body: { maxBytes: number } | null): { status: number; error: string } | null {
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
  if (!body) return null;
  const type = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "Content-Type must be application/json" };
  const len = headers.get("content-length");
  if (len != null && (!/^[0-9]+$/.test(len) || Number(len) > body.maxBytes)) return { status: 413, error: "body too large" };
  return null;
}

/** UTF-8 size of a body that was read as text (the declared Content-Length can lie or be absent). */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---- optimistic list updates (used by the page; reverted when a save fails) --

export function applyPatch(item: CareItem, patch: CarePatch): CareItem {
  const next = { ...item };
  for (const key of ["title", "kind", "due", "time", "tz", "months", "booked", "notes", "archived", "completedOn"] as const) {
    if (patch[key] !== undefined) (next as Record<string, unknown>)[key] = patch[key];
  }
  return next;
}

/** The list with `item` added, or replacing the item that has its id. */
export function putItem(items: CareItem[], item: CareItem): CareItem[] {
  return items.some((old) => old.id === item.id) ? items.map((old) => (old.id === item.id ? item : old)) : [...items, item];
}

export function dropItem(items: CareItem[], id: string): CareItem[] {
  return items.filter((old) => old.id !== id);
}

/** One change to one item, as the page makes it. */
export type CareOp =
  | { type: "create"; item: CareItem }
  | { type: "update"; id: string; patch: CarePatch }
  | { type: "remove"; id: string }
  | { type: "restore"; item: CareItem };

export const opId = (op: CareOp): string => (op.type === "create" || op.type === "restore" ? op.item.id : op.id);

/** The list as it should look the moment the change is made, before the server answers. */
export function applyOp(items: CareItem[], op: CareOp): CareItem[] {
  switch (op.type) {
    case "create":
    case "restore":
      return putItem(items, op.item);
    case "update":
      return items.map((old) => (old.id === op.id ? applyPatch(old, op.patch) : old));
    case "remove":
      return dropItem(items, op.id);
  }
}

/** The list after a failed save: that one item goes back to what the server last confirmed. */
export function revertOp(items: CareItem[], op: CareOp, before: CareItem | null): CareItem[] {
  return before ? putItem(items, before) : dropItem(items, opId(op));
}

/** The change that takes a successful change back (for Undo). `before` is the item before it. */
export function inverseOp(op: CareOp, before: CareItem | null): CareOp | null {
  switch (op.type) {
    case "create":
      return { type: "remove", id: op.item.id };
    case "restore":
      return { type: "remove", id: op.item.id };
    case "remove":
      return before ? { type: "restore", item: before } : null;
    case "update": {
      if (!before) return null;
      const patch: CarePatch = {};
      for (const key of Object.keys(op.patch) as (keyof CarePatch)[]) {
        if (key !== "removed") (patch as Record<string, unknown>)[key] = before[key as keyof CareItem];
      }
      return Object.keys(patch).length ? { type: "update", id: op.id, patch } : null;
    }
  }
}

/** The fetch each change makes. Paths only ever carry the item's UUID, never its text. */
export function opRequest(op: CareOp): { method: "POST" | "PATCH" | "DELETE"; path: string; body: unknown | null } {
  switch (op.type) {
    case "create":
      return { method: "POST", path: "/api/care/items", body: op.item };
    case "update":
      return { method: "PATCH", path: `/api/care/items/${op.id}`, body: op.patch };
    case "remove":
      return { method: "DELETE", path: `/api/care/items/${op.id}`, body: null };
    case "restore":
      return { method: "PATCH", path: `/api/care/items/${op.item.id}`, body: { removed: false } };
  }
}
