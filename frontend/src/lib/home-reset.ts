/**
 * Apartment reset (2026-11-17): the pure rules behind Today's one cleanup card. No imports, no I/O, no clock
 * (callers pass `now`), so the same code runs on the server (validation, row shape) and in the browser (which
 * action is shown). Storage: sql/home_reset.sql (pds.home_reset_items / home_reset_receipts, service role only).
 *
 * Product decisions (Riley asked Claude to decide, 2026-11-17):
 *  - Onyx cannot see the apartment, so everything here is Riley's own input. The starter actions are examples.
 *  - ONE suggested action at a time: the oldest open, un-snoozed, due item. Default effort 5 minutes; 2 and 10 offered.
 *  - Opening or ignoring the card never completes anything; only Done / Partly done are completions.
 *  - Upkeep is opt-in, asked once after a reset is done ("Weekly / Every 2 weeks / No thanks"). The next due date is
 *    counted from the day it was done, so missed weeks never pile up into a backlog or an overdue list.
 */

export const HOME_MINUTES = [2, 5, 10] as const;
export type HomeMinutes = (typeof HOME_MINUTES)[number];
export type HomeUpkeep = "none" | "weekly" | "biweekly";
export const MAX_HOME_ITEMS = 20;
export const MAX_HOME_BODY_BYTES = 2048;

export interface HomeItem {
  id: string;
  area: string;
  action: string;
  minutes: HomeMinutes;
  remaining: string | null;
  status: "open" | "done";
  snoozedUntil: string | null; // ISO instant
  partialCount: number;
  upkeep: HomeUpkeep | null; // null = not asked yet
  upkeepPaused: boolean;
  nextDueOn: string | null; // YYYY-MM-DD; null = due now
  lastDoneOn: string | null;
}

export const HOME_COLUMNS = "id,area,action,minutes,remaining,status,snoozed_until,partial_count,upkeep,upkeep_paused,next_due_on,last_done_on";

/** Starter actions: examples Riley can pick or ignore, never claims about the apartment. */
export const STARTERS: { area: string; action: string; minutes: HomeMinutes }[] = [
  { area: "Kitchen", action: "Put the dishes in the dishwasher or sink", minutes: 5 },
  { area: "Anywhere", action: "Collect the trash and take it out", minutes: 5 },
  { area: "Bedroom", action: "Gather the laundry into one basket", minutes: 5 },
  { area: "Anywhere", action: "Clear one surface", minutes: 2 },
  { area: "Living room", action: "Put away everything that has a home", minutes: 10 },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length >= 1 && t.length <= max ? t : null;
}

export function easternDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function rowToHomeItem(row: unknown): HomeItem | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (!isUuid(r.id) || typeof r.area !== "string" || typeof r.action !== "string") return null;
  const minutes = HOME_MINUTES.find((m) => m === r.minutes);
  if (!minutes) return null;
  const upkeep = r.upkeep === "none" || r.upkeep === "weekly" || r.upkeep === "biweekly" ? r.upkeep : null;
  return {
    id: r.id, area: r.area, action: r.action, minutes,
    remaining: typeof r.remaining === "string" && r.remaining ? r.remaining : null,
    status: r.status === "done" ? "done" : "open",
    snoozedUntil: typeof r.snoozed_until === "string" ? r.snoozed_until : null,
    partialCount: typeof r.partial_count === "number" ? r.partial_count : 0,
    upkeep, upkeepPaused: r.upkeep_paused === true,
    nextDueOn: typeof r.next_due_on === "string" ? r.next_due_on.slice(0, 10) : null,
    lastDoneOn: typeof r.last_done_on === "string" ? r.last_done_on.slice(0, 10) : null,
  };
}

export type ParsedNewItem = { ok: true; item: { id: string; area: string; action: string; minutes: HomeMinutes } } | { ok: false; error: string };

export function parseNewItem(body: unknown): ParsedNewItem {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !["id", "area", "action", "minutes"].includes(k));
  if (extra.length) return { ok: false, error: "unknown field" };
  if (!isUuid(b.id)) return { ok: false, error: "id must be a UUID" };
  const area = text(b.area, 40);
  const action = text(b.action, 120);
  const minutes = HOME_MINUTES.find((m) => m === b.minutes);
  if (!area) return { ok: false, error: "area must be 1 to 40 characters" };
  if (!action) return { ok: false, error: "action must be 1 to 120 characters" };
  if (!minutes) return { ok: false, error: "minutes must be 2, 5 or 10" };
  return { ok: true, item: { id: b.id, area, action, minutes } };
}

export type ParsedAct = { ok: true; act: { receiptId: string; itemId: string; action: "done" | "partly" | "snooze"; remaining: string | null; snoozeUntil: string | null } } | { ok: false; error: string };

export function parseAct(body: unknown, now: Date): ParsedAct {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !["receipt_id", "item_id", "action", "remaining", "snooze_until"].includes(k));
  if (extra.length) return { ok: false, error: "unknown field" };
  if (!isUuid(b.receipt_id) || !isUuid(b.item_id)) return { ok: false, error: "receipt_id and item_id must be UUIDs" };
  if (b.action !== "done" && b.action !== "partly" && b.action !== "snooze") return { ok: false, error: "action must be done, partly or snooze" };
  let remaining: string | null = null;
  if (b.remaining != null) {
    remaining = text(b.remaining, 120);
    if (!remaining) return { ok: false, error: "remaining must be 1 to 120 characters" };
  }
  let snoozeUntil: string | null = null;
  if (b.snooze_until != null) {
    const t = typeof b.snooze_until === "string" ? Date.parse(b.snooze_until) : NaN;
    if (!Number.isFinite(t)) return { ok: false, error: "snooze_until must be a time" };
    if (t > now.getTime() + 14 * 86400000) return { ok: false, error: "snooze at most 14 days" };
    snoozeUntil = new Date(t).toISOString();
  }
  return { ok: true, act: { receiptId: b.receipt_id, itemId: b.item_id, action: b.action, remaining, snoozeUntil } };
}

export type ParsedPatch = { ok: true; patch: { upkeep?: HomeUpkeep; upkeepPaused?: boolean; removed?: true } } | { ok: false; error: string };

export function parsePatch(body: unknown): ParsedPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !["upkeep", "upkeep_paused", "removed"].includes(k));
  if (extra.length) return { ok: false, error: "unknown field" };
  const patch: { upkeep?: HomeUpkeep; upkeepPaused?: boolean; removed?: true } = {};
  if (b.upkeep !== undefined) {
    if (b.upkeep !== "none" && b.upkeep !== "weekly" && b.upkeep !== "biweekly") return { ok: false, error: "upkeep must be none, weekly or biweekly" };
    patch.upkeep = b.upkeep;
  }
  if (b.upkeep_paused !== undefined) {
    if (typeof b.upkeep_paused !== "boolean") return { ok: false, error: "upkeep_paused must be true or false" };
    patch.upkeepPaused = b.upkeep_paused;
  }
  if (b.removed !== undefined) {
    if (b.removed !== true) return { ok: false, error: "removed must be true" };
    patch.removed = true;
  }
  if (!Object.keys(patch).length) return { ok: false, error: "nothing to change" };
  return { ok: true, patch };
}

/** Days until an upkeep action is due again, counted from the day it was done. */
export function upkeepDays(u: HomeUpkeep): number {
  return u === "weekly" ? 7 : u === "biweekly" ? 14 : 0;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The ONE action to show: oldest open item that is not snoozed and not waiting for its next upkeep day. */
export function activeItem(items: HomeItem[], now: Date): HomeItem | null {
  const today = easternDay(now);
  const t = now.getTime();
  for (const it of items) {
    if (it.status !== "open") continue;
    if (it.upkeepPaused && it.lastDoneOn) continue; // upkeep paused: no prompts
    if (it.snoozedUntil && Date.parse(it.snoozedUntil) > t) continue;
    if (it.nextDueOn && it.nextDueOn > today) continue;
    return it;
  }
  return null;
}

/** The finished reset whose upkeep question has not been answered (asked once, never automatic). */
export function upkeepOffer(items: HomeItem[]): HomeItem | null {
  return items.find((it) => it.status === "done" && it.upkeep === null) ?? null;
}

/** Why the card is shown: its source and why it is due, in one line. */
export function whyDue(it: HomeItem, now: Date): string {
  if (it.partialCount > 0) return "You started this and it is still open.";
  if (it.lastDoneOn && it.nextDueOn && it.nextDueOn <= easternDay(now)) return `Your ${it.upkeep === "biweekly" ? "every 2 weeks" : "weekly"} upkeep is due.`;
  return "Part of your apartment reset plan.";
}

export const SNOOZE_CHOICES: { label: string; hours: number }[] = [
  { label: "Later today", hours: 4 },
  { label: "Tomorrow", hours: 24 },
  { label: "In 3 days", hours: 72 },
];

export type HomeTap = { receiptId: string; itemId: string; action: "done" | "partly" | "snooze"; remaining: string | null; snoozeUntil: string | null };

/** The same change pds.home_reset_act() makes, so the card updates at once while the save is on its way. */
export function applyTap(it: HomeItem, tap: HomeTap, now: Date): HomeItem {
  const today = easternDay(now);
  if (tap.action === "partly") return { ...it, partialCount: it.partialCount + 1, remaining: tap.remaining };
  if (tap.action === "snooze") {
    const cap = now.getTime() + 14 * 86400000;
    const want = tap.snoozeUntil ? Date.parse(tap.snoozeUntil) : now.getTime() + 86400000;
    return { ...it, snoozedUntil: new Date(Math.min(Math.max(want, now.getTime()), cap)).toISOString() };
  }
  const keep = (it.upkeep === "weekly" || it.upkeep === "biweekly") && !it.upkeepPaused;
  return {
    ...it, lastDoneOn: today, remaining: null, partialCount: 0, snoozedUntil: null,
    status: keep ? "open" : "done",
    nextDueOn: keep && it.upkeep ? addDays(today, upkeepDays(it.upkeep)) : null,
  };
}

/** Answering the upkeep question or pausing / resuming it. A finished reset with an active cadence reopens with its next day counted from the day it was done (or from today, never in the past): no period is owed. */
export function applyPatch(cur: HomeItem, patch: { upkeep?: HomeUpkeep; upkeepPaused?: boolean }, now: Date): HomeItem {
  const today = easternDay(now);
  const next: HomeItem = { ...cur, upkeep: patch.upkeep ?? cur.upkeep, upkeepPaused: patch.upkeepPaused ?? cur.upkeepPaused };
  const active = (next.upkeep === "weekly" || next.upkeep === "biweekly") && !next.upkeepPaused;
  if (active && next.upkeep && next.lastDoneOn && (cur.status === "done" || !cur.nextDueOn)) {
    const target = addDays(next.lastDoneOn, upkeepDays(next.upkeep));
    next.status = "open";
    next.nextDueOn = target > today ? target : addDays(today, upkeepDays(next.upkeep));
  }
  return next;
}

export type HomeOp =
  | { kind: "create"; item: { id: string; area: string; action: string; minutes: HomeMinutes } }
  | { kind: "tap"; tap: HomeTap }
  | { kind: "patch"; id: string; patch: { upkeep?: HomeUpkeep; upkeepPaused?: boolean; removed?: true } };

export function newItemOf(c: { id: string; area: string; action: string; minutes: HomeMinutes }): HomeItem {
  return { id: c.id, area: c.area, action: c.action, minutes: c.minutes, remaining: null, status: "open", snoozedUntil: null, partialCount: 0, upkeep: null, upkeepPaused: false, nextDueOn: null, lastDoneOn: null };
}

/** Server items with every not-yet-saved op laid over them, in order. */
export function overlayOps(items: HomeItem[], ops: HomeOp[], now: Date): HomeItem[] {
  let out = items;
  for (const op of ops) {
    if (op.kind === "create") {
      if (!out.some((i) => i.id === op.item.id)) out = [...out, newItemOf(op.item)];
    } else if (op.kind === "tap") {
      out = out.map((i) => (i.id === op.tap.itemId ? applyTap(i, op.tap, now) : i));
    } else if (op.patch.removed) {
      out = out.filter((i) => i.id !== op.id);
    } else {
      out = out.map((i) => (i.id === op.id ? applyPatch(i, op.patch, now) : i));
    }
  }
  return out;
}
