// The Log Drinks editor's state (PROD-CAFF-01 slice): the drink items, what the server acknowledged, and the one
// request per drink whose answer has not been seen yet. Outside any component, so a remount or the continuous scroll
// never makes a second drink; and, minimally, on the device, so a reload after a lost answer neither invents a new
// drink nor silently loses one.
//
// Storage: localStorage "onyx.drinks.pending" (the "onyx" prefix is wiped on sign-out and on a session end,
// lib/client-cache.ts APP_STORAGE_PREFIXES / wipeClientData). It holds only normalized fields: key, product id,
// amount, time fields and zone, overlap / recent choices, the acknowledged record, the pending request. Never the
// words Riley said (`said` is dropped) and nothing secret. Written synchronously BEFORE each request is sent.
//
// Rules:
//   - A request with an unknown outcome (lost answer, closed tab) is replayed EXACTLY before anything else is sent
//     for that drink. The server answers a replay of an applied request with the stored row; nothing else is merged.
//   - A conflict stays a conflict: 409 `changed` / `stale` shows the server's version and holds the item; it is never
//     turned into an edit or a removal with the freshly returned revision. A new deliberate change (or Undo) is needed.
//   - After a reload every restored item is held ("recover") and its key is READ (GET ?key=, read-only). A proven
//     replay (the stored drink equals the pending request) is acknowledged; a tombstone stays removed; a different
//     version is shown as a conflict; nothing found = held "retry", sent again only on Riley's tap. Opening or
//     scrolling never writes.
// No React. Network only through the `call` / `read` functions passed in (tests use fakes).

import { AutosaveRefused } from "./autosave";
import {
  isUuid,
  itemFieldsFromRecord,
  sameSave,
  type DrinkItemState,
  type DrinkRecord,
  type DrinkSave,
  TIME_PROBLEM_TEXT,
  type PendingOp,
  type TimeProblem,
} from "./drink-capture";

export const DRINK_STORAGE_KEY = "onyx.drinks.pending";
/** Keep at most this many settled drinks; unresolved operations and unsaved drafts are never evicted. */
const MAX_KEPT = 40;
/** An acknowledged drink with nothing pending is kept this long (so a reload still shows it with Undo). */
const KEEP_SAVED_MS = 36 * 3_600_000;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Kept = Omit<DrinkItemState, "said"> & { ack: DrinkRecord | null };

const items = new Map<string, DrinkItemState>();
const acks = new Map<string, DrinkRecord>();
const listeners = new Set<() => void>();
let version = 0;
let restored = false;
let storageOverride: StorageLike | null | undefined;

function storage(): StorageLike | null {
  if (storageOverride !== undefined) return storageOverride;
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function keep(it: DrinkItemState, now: number): boolean {
  if (it.pending) return true;
  if (it.status !== "open") return false;
  if (!acks.has(it.key)) return true; // an unsaved drink is never silently lost
  return it.hold != null || now - it.capturedAt < KEEP_SAVED_MS;
}

/** Write the device copy. Returns false when there is no storage (memory only) or the write failed. */
function persist(): boolean {
  const s = storage();
  if (!s) return false;
  const now = Date.now();
  let settledKept = 0;
  const kept: Kept[] = Array.from(items.values())
    .filter((i) => keep(i, now))
    .sort((a, b) => Number(!!b.pending) - Number(!!a.pending) || b.capturedAt - a.capturedAt)
    .filter((i) => !!i.pending || !acks.has(i.key) || i.hold != null || settledKept++ < MAX_KEPT)
    .map(({ said: _said, ...rest }) => ({ ...rest, ack: acks.get(rest.key) ?? null }));
  try {
    if (kept.length === 0) s.removeItem(DRINK_STORAGE_KEY);
    else s.setItem(DRINK_STORAGE_KEY, JSON.stringify({ v: 1, items: kept }));
    return true;
  } catch {
    return false;
  }
}

function emit(save = true) {
  if (save) persist();
  version += 1;
  for (const fn of Array.from(listeners)) {
    try { fn(); } catch { /* a listener never breaks another */ }
  }
}

function asKept(raw: unknown): Kept | null {
  const k = raw as Kept | null;
  if (!k || typeof k !== "object" || !isUuid(k.key) || typeof k.capturedAt !== "number" || typeof k.zone !== "string") return null;
  if (k.status !== "open" && k.status !== "removed") return null;
  return k;
}

export type KeyRead = { status: "found"; record: DrinkRecord } | { status: "removed" } | { status: "none" };
export type CallAnswer = { ok: boolean; status: number; json: Record<string, unknown> };
export type Call = (method: "POST" | "PATCH" | "DELETE", body: unknown, keepalive?: boolean) => Promise<CallAnswer>;

const METHOD: Record<PendingOp["op"], "POST" | "PATCH" | "DELETE"> = { create: "POST", edit: "PATCH", remove: "DELETE" };
const recordOf = (a: CallAnswer) => (a.json.record && typeof a.json.record === "object" ? (a.json.record as DrinkRecord) : null);
const SAVE_FAILED = "Could not save the drink. Try again.";
/**
 * The words shown for a failed autosave. Server text is kept only where the server sends it on purpose: a time problem
 * (the app's own sentence for that fixed code), a 503 "unavailable" refusal, an overlap refusal, and a 400 validation
 * message. Everything else (5xx, 408/429, 404, unknown, non-JSON, missing error) gets fixed copy; no status number.
 */
function failureText(a: CallAnswer): string {
  const code = typeof a.json.code === "string" ? a.json.code : null;
  const err = typeof a.json.error === "string" && a.json.error ? a.json.error : null;
  if (code && Object.prototype.hasOwnProperty.call(TIME_PROBLEM_TEXT, code)) return TIME_PROBLEM_TEXT[code as TimeProblem];
  if (err && a.status === 503 && code === "unavailable") return err;
  if (err && a.status === 409 && code === "overlap_unverified") return err;
  if (err && a.status === 400) return err;
  return SAVE_FAILED;
}
const saveOf = (op: PendingOp): DrinkSave | null => {
  if (op.op === "remove") return null;
  const { client_key, product_id, servings, time, overlap } = op.body;
  return { client_key, product_id, servings, time, overlap };
};

export const CONFLICT_NOTE = "Saved with other details (shown). Change it again, or Undo, to replace that version.";

export const drinkSession = {
  version: () => version,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  items(): DrinkItemState[] {
    return Array.from(items.values());
  },
  get(key: string): DrinkItemState | undefined {
    return items.get(key);
  },
  /** Add an item once: the same key again keeps the existing state. */
  adopt(item: DrinkItemState): boolean {
    if (items.has(item.key)) return false;
    items.set(item.key, item);
    emit();
    return true;
  },
  update(key: string, patch: Partial<DrinkItemState>): void {
    const cur = items.get(key);
    if (!cur) return;
    items.set(key, { ...cur, ...patch });
    emit();
  },
  ack(key: string): DrinkRecord | undefined {
    return acks.get(key);
  },
  remember(rec: DrinkRecord): void {
    acks.set(rec.client_key, rec);
    emit();
  },
  forget(key: string): void {
    acks.delete(key);
    emit();
  },

  /**
   * The device copy, once per page load: every restored item is held for a read of its key ("recover"); nothing is
   * sent. Returns the keys to read.
   */
  restore(): string[] {
    if (restored) return [];
    restored = true;
    const s = storage();
    if (!s) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(s.getItem(DRINK_STORAGE_KEY) ?? "null");
    } catch {
      return [];
    }
    const list = (parsed as { v?: number; items?: unknown[] } | null)?.v === 1 ? (parsed as { items: unknown[] }).items : [];
    const keys: string[] = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const k = asKept(raw);
      if (!k || items.has(k.key)) continue;
      const { ack, ...rest } = k;
      items.set(k.key, { ...rest, said: "", hold: "recover", note: null });
      if (ack) acks.set(k.key, ack);
      keys.push(k.key);
    }
    if (keys.length) emit(false);
    return keys;
  },

  /** What the server answered for a restored key (read-only GET by key). */
  reconcile(key: string, read: KeyRead | "failed"): void {
    const it = items.get(key);
    if (!it) return;
    const pending = it.pending;
    if (read === "failed") {
      items.set(key, { ...it, hold: "recover", note: "Couldn't check whether this drink was saved." });
      return emit();
    }
    if (read.status === "removed") {
      acks.delete(key);
      items.set(key, { ...it, status: "removed", pending: null, hold: null, note: "Removed." });
      return emit();
    }
    if (read.status === "none") {
      acks.delete(key);
      if (pending?.op === "remove") items.set(key, { ...it, status: "removed", pending: null, hold: null, note: "Removed." });
      else items.set(key, { ...it, pending: null, saved: null, hold: "retry", note: "Not saved yet." });
      return emit();
    }
    const rec = read.record;
    acks.set(key, rec);
    const fields = itemFieldsFromRecord(rec);
    const want = pending ? saveOf(pending) : it.saved;
    if (pending?.op === "remove") {
      // The removal did not happen (or not yet): the drink is still saved; Undo is Riley's to repeat.
      items.set(key, { ...it, ...fields, pending: null, hold: null, note: "Undo did not go through. Undo again to remove it." });
    } else if (!want || sameSave(want, fields.saved)) {
      // A proven replay of our own request (or an unchanged saved drink).
      items.set(key, { ...it, ...fields, pending: null, hold: null, note: null });
    } else {
      items.set(key, { ...it, ...fields, pending: null, hold: "conflict", note: CONFLICT_NOTE });
    }
    emit();
  },

  /** Tests only. */
  reset(opts: { storage?: StorageLike | null } = {}): void {
    items.clear();
    acks.clear();
    restored = false;
    storageOverride = "storage" in opts ? opts.storage : undefined;
    version += 1;
  },
};

/** Keep the request BEFORE it is sent (device copy written synchronously). */
function setPending(key: string, op: PendingOp) {
  const it = items.get(key);
  if (it) items.set(key, { ...it, pending: op });
  emit();
}

/**
 * Apply a definite answer to `op`. Success: acknowledged. 409 with a record: the server's version is shown and held
 * (a conflict, never written over). 410: removed. Another refusal: not applied. A 5xx / network failure is not an
 * answer: the request stays pending and is replayed as it is.
 */
function applyAnswer(key: string, op: PendingOp, a: CallAnswer): void {
  const it = items.get(key);
  if (!it) return;
  if (a.ok) {
    if (op.op === "remove") {
      acks.delete(key);
      items.set(key, { ...it, status: "removed", pending: null, hold: null, note: null, saved: null });
      return emit();
    }
    const rec = recordOf(a);
    if (!rec) throw new Error("Unexpected answer.");
    acks.set(key, rec);
    items.set(key, { ...it, pending: null, hold: null, note: null, saved: saveOf(op) });
    return emit();
  }
  if (a.status >= 500 || a.status === 408 || a.status === 429) {
    // 503 = not set up / turned off: a definite "not saved" (refused, shown); other 5xx stay pending (retried).
    if (a.status === 503) {
      items.set(key, { ...it, pending: null });
      emit();
      throw new AutosaveRefused(failureText(a));
    }
    throw new Error(failureText(a));
  }
  const rec = recordOf(a);
  if (a.status === 409 && rec && (a.json.code === "changed" || a.json.code === "stale")) {
    acks.set(key, rec);
    items.set(key, { ...it, ...itemFieldsFromRecord(rec), pending: null, hold: "conflict", note: CONFLICT_NOTE });
    emit();
    throw new AutosaveRefused(CONFLICT_NOTE);
  }
  if (a.status === 410) {
    acks.delete(key);
    items.set(key, { ...it, status: "removed", pending: null, hold: null, saved: null, note: "This drink was removed." });
    emit();
    throw new AutosaveRefused("This drink was removed.");
  }
  items.set(key, { ...it, pending: null });
  emit();
  throw new AutosaveRefused(failureText(a));
}

async function send(call: Call, key: string, op: PendingOp, keepalive: boolean): Promise<void> {
  // Every first send AND replay must have a recoverable identity before a server mutation can happen.
  if (!items.has(key) || !persist()) {
    throw new AutosaveRefused("Couldn't keep this drink safely on this device. Nothing was sent. Free some browser storage, then retry.");
  }
  const a = await call(METHOD[op.op], op.body, keepalive); // a network failure throws: op stays pending
  applyAnswer(key, op, a);
}

/** A pending request with an unknown outcome is replayed exactly, before anything new for this drink. */
async function settlePending(call: Call, key: string, keepalive: boolean): Promise<void> {
  const p = items.get(key)?.pending;
  if (p) await send(call, key, p, keepalive);
}

/**
 * Save (create or revision-checked edit) one drink. Throws AutosaveRefused for a refusal or a conflict (shown, not
 * retried) and an Error for a failure worth retrying (the request stays pending and is replayed first next time).
 */
export async function saveDrinkWith(call: Call, v: DrinkSave, keepalive = false): Promise<void> {
  const key = v.client_key;
  const p = items.get(key)?.pending;
  if (p && !(p.op !== "remove" && sameSave(saveOf(p), v))) await settlePending(call, key, keepalive);
  if (items.get(key)?.status === "removed") throw new AutosaveRefused("This drink was removed.");
  const again = items.get(key)?.pending;
  if (again) return send(call, key, again, keepalive); // the same request as v: send it (once)
  const ack = acks.get(key);
  // Already acknowledged as exactly this (e.g. the pending replay above was this value): nothing to send.
  if (ack && sameSave(items.get(key)?.saved, v)) return;
  const op: PendingOp = ack ? { op: "edit", body: { ...v, expected_revision: ack.revision } } : { op: "create", body: v };
  setPending(key, op);
  await send(call, key, op, keepalive);
}

/**
 * Undo / Remove with the revision last acknowledged. A 409 shows the newer version and stops: the removal is never
 * repeated with the fresh revision (that would delete an edit Riley has not seen). Returns a message for Riley.
 */
export async function undoDrinkWith(call: Call, key: string): Promise<{ ok: boolean; message: string | null }> {
  try {
    if (items.get(key)?.pending?.op !== "remove") await settlePending(call, key, false);
    const pend = items.get(key)?.pending;
    if (pend?.op === "remove") {
      await send(call, key, pend, false);
      return { ok: true, message: null };
    }
    const ack = acks.get(key);
    if (!ack) return { ok: false, message: "Nothing saved to undo." };
    const op: PendingOp = { op: "remove", body: { client_key: key, expected_revision: ack.revision } };
    setPending(key, op);
    await send(call, key, op, false);
    return { ok: true, message: null };
  } catch (e) {
    if (e instanceof AutosaveRefused) return { ok: false, message: e.message === CONFLICT_NOTE ? "Changed elsewhere (shown). Undo again to remove that version." : e.message };
    return { ok: false, message: "Couldn't reach Onyx: Undo will be checked again." };
  }
}
