import { parseRemindTime } from "@/lib/supplement-reminders";

/**
 * Supplement stack save (audit PROD-07, 2026-11-16): POST / PATCH /api/supplements/stacks check the whole request
 * here, then make ONE call to pds.save_supplement_stack (sql/supplement_stack_atomic_save.sql), which writes the
 * header and the complete item list in one transaction with a version check. Nothing is written before the request
 * is known to be valid, a failure leaves the stack exactly as it was, and there is no fallback to the old
 * multi-request save: when the function is missing the answer is 503 "not set up" and nothing changes.
 *
 * Request fields the editor adds (lib/supplement-stack-chain.ts): expected_version (the version it last saw),
 * save_id (a UUID per save; a resend of a save that already went through is answered with replayed: true) and
 * after_save_ids (its earlier saves whose answer it never got). An update without expected_version, or a retried
 * create without save_id (a tab still running the previous build, or a list read before the migration), is refused
 * with 409 "reload": it cannot show that it is not a late body overwriting a newer save.
 *
 * Errors are mapped from the database CODE only, never its message text (a unique violation also names the
 * client_key index, and must never be read as "no such column").
 */

export const STACK_SAVE_RPC = "save_supplement_stack";
export const STACK_NAME_MAX = 200;
export const STACK_DESC_MAX = 1000;
export const STACK_ITEM_MAX = 100;
export const STACK_DOSES_MAX = 1000;
export const STACK_AFTER_MAX = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StackItemInput {
  product_id: string;
  doses: number;
}

export interface StackHeaderInput {
  name?: string;
  description?: string | null;
  remind_time?: string | null;
  is_active?: boolean;
}

export interface StackSaveRequest {
  stackId: number | null;
  clientKey: string | null;
  expectedVersion: number | null;
  saveId: string | null;
  afterSaveIds: string[];
  header: StackHeaderInput;
  /** The complete item list ([] = clear on purpose); null = leave the items alone (update only). */
  items: StackItemInput[] | null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/**
 * The complete item list. A value that is not an array, an item that is not {product_id, doses}, a blank or
 * repeated product, or doses that are not a number in (0, 1000] are refused (400) so a bad body never clears a
 * stack. An empty array is valid: it clears the stack on purpose.
 */
export function parseStackItems(raw: unknown): Parsed<StackItemInput[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "items must be an array" };
  if (raw.length > STACK_ITEM_MAX) return { ok: false, error: `A stack holds at most ${STACK_ITEM_MAX} products` };
  const out: StackItemInput[] = [];
  const seen = new Set<string>();
  for (const it of raw) {
    if (!isObject(it) || Object.keys(it).some((k) => k !== "product_id" && k !== "doses")) {
      return { ok: false, error: "every item must be {product_id, doses}" };
    }
    const pid = typeof it.product_id === "string" ? it.product_id.trim() : "";
    if (!pid || pid.length > STACK_NAME_MAX) return { ok: false, error: "every item needs a product_id" };
    if (seen.has(pid)) return { ok: false, error: "a product is listed twice" };
    seen.add(pid);
    const doses = it.doses === undefined || it.doses === null ? 1 : it.doses;
    if (typeof doses !== "number" || !Number.isFinite(doses) || doses <= 0 || doses > STACK_DOSES_MAX) {
      return { ok: false, error: `doses must be a number above 0 and at most ${STACK_DOSES_MAX}` };
    }
    out.push({ product_id: pid, doses });
  }
  return { ok: true, value: out };
}

const CREATE_KEYS = new Set(["name", "description", "remind_time", "items", "client_key", "save_id", "after_save_ids", "expected_version"]);
const UPDATE_KEYS = new Set(["stack_id", "name", "description", "remind_time", "is_active", "items", "save_id", "after_save_ids", "expected_version"]);

/** Checks a POST (create) or PATCH (update) body completely; nothing is written for a refused body. */
export function parseStackSave(body: unknown, mode: "create" | "update"): Parsed<StackSaveRequest> {
  if (!isObject(body)) return { ok: false, error: "Send a JSON object" };
  const allowed = mode === "create" ? CREATE_KEYS : UPDATE_KEYS;
  const unknown = Object.keys(body).find((k) => !allowed.has(k));
  if (unknown) return { ok: false, error: `Unknown field: ${unknown.slice(0, 40)}` };

  let stackId: number | null = null;
  if (mode === "update") {
    if (!isPositiveInt(body.stack_id)) return { ok: false, error: "stack_id is required" };
    stackId = body.stack_id;
  }

  const header: StackHeaderInput = {};
  if (body.name !== undefined || mode === "create") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return { ok: false, error: mode === "create" ? "name is required" : "name cannot be empty" };
    if (name.length > STACK_NAME_MAX) return { ok: false, error: `name is longer than ${STACK_NAME_MAX} characters` };
    header.name = name;
  }
  if (body.description !== undefined || mode === "create") {
    const d = body.description ?? null;
    if (d !== null && typeof d !== "string") return { ok: false, error: "description must be text" };
    const desc = d === null ? null : d.trim() || null;
    if (desc && desc.length > STACK_DESC_MAX) return { ok: false, error: `description is longer than ${STACK_DESC_MAX} characters` };
    header.description = desc;
  }
  if (body.remind_time !== undefined || mode === "create") {
    const remind = parseRemindTime(body.remind_time ?? null);
    if (!remind.ok) return { ok: false, error: remind.error };
    header.remind_time = remind.value;
  }
  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") return { ok: false, error: "is_active must be true or false" };
    header.is_active = body.is_active;
  }

  let items: StackItemInput[] | null = null;
  if (body.items !== undefined || mode === "create") {
    const parsed = parseStackItems(body.items === undefined ? [] : body.items);
    if (!parsed.ok) return parsed;
    items = parsed.value;
  }

  let clientKey: string | null = null;
  if (body.client_key !== undefined && body.client_key !== null) {
    if (typeof body.client_key !== "string" || !UUID_RE.test(body.client_key)) return { ok: false, error: "client_key must be a UUID" };
    clientKey = body.client_key.toLowerCase();
  }

  let expectedVersion: number | null = null;
  if (body.expected_version !== undefined && body.expected_version !== null) {
    if (!isPositiveInt(body.expected_version)) return { ok: false, error: "expected_version must be a positive whole number" };
    expectedVersion = body.expected_version;
  }

  let saveId: string | null = null;
  if (body.save_id !== undefined && body.save_id !== null) {
    if (typeof body.save_id !== "string" || !UUID_RE.test(body.save_id)) return { ok: false, error: "save_id must be a UUID" };
    saveId = body.save_id.toLowerCase();
  }

  const afterSaveIds: string[] = [];
  if (body.after_save_ids !== undefined && body.after_save_ids !== null) {
    const a = body.after_save_ids;
    if (!Array.isArray(a) || a.length > STACK_AFTER_MAX || a.some((x) => typeof x !== "string" || !UUID_RE.test(x))) {
      return { ok: false, error: "after_save_ids must be a short list of UUIDs" };
    }
    for (const x of a as string[]) afterSaveIds.push(x.toLowerCase());
  }

  return { ok: true, value: { stackId, clientKey, expectedVersion, saveId, afterSaveIds, header, items } };
}

/** The named arguments of pds.save_supplement_stack for a checked request. */
export function stackRpcArgs(req: StackSaveRequest): Record<string, unknown> {
  return {
    p_stack_id: req.stackId,
    p_client_key: req.clientKey,
    p_expected_version: req.expectedVersion,
    p_save_id: req.saveId,
    p_after_save_ids: req.afterSaveIds,
    p_header: req.header,
    p_items: req.items,
  };
}

export type StackSaveCode = "stale" | "reload" | "unknown_product" | "not_found" | "name_taken" | "conflict" | "invalid" | "not_set_up" | "failed";

export const STACK_STALE_MESSAGE = "This stack was changed somewhere else. Load the latest version, then make your change again.";
export const STACK_RELOAD_MESSAGE = "This page is out of date. Reload it, then make your change again. Nothing was changed.";

/** Answer for a database error, by code only. Every one of these means nothing was changed. */
export function stackSaveFailure(code: string | null | undefined): { status: number; code: StackSaveCode; error: string } {
  switch (code) {
    case "OXS01":
      return { status: 409, code: "stale", error: STACK_STALE_MESSAGE };
    case "OXS05":
      return { status: 409, code: "reload", error: STACK_RELOAD_MESSAGE };
    case "OXS02":
    case "23503":
      return { status: 400, code: "unknown_product", error: "A product in this stack is not in your library. Nothing was changed." };
    case "OXS03":
      return { status: 404, code: "not_found", error: "This stack no longer exists." };
    case "OXS04":
      return { status: 409, code: "name_taken", error: "Another stack already has this name. Nothing was changed." };
    case "23505":
    case "40001":
    case "40P01":
      // Two saves met at a unique index (a create racing its own client_key, or two stacks racing to one name).
      // Nothing was written; the editor retries the same save, which the function then adopts, replays or refuses
      // with OXS04. Never a reason to insert again without the key.
      return { status: 503, code: "conflict", error: "Another save was under way at the same moment. Trying again." };
    case "22023":
    case "22P02":
    case "23514":
      return { status: 400, code: "invalid", error: "The stack could not be saved: a field is not valid. Nothing was changed." };
    case "PGRST202":
    case "42883":
    case "42703":
    case "PGRST204":
      return { status: 503, code: "not_set_up", error: "Saving stacks is not set up yet (database migration pending). Nothing was changed." };
    default:
      return { status: 500, code: "failed", error: "The stack could not be saved. Nothing was changed." };
  }
}

export interface StackSaveRow {
  stack_id: number;
  name: string;
  description: string | null;
  remind_time: string | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  version: number;
  item_count: number;
  created: boolean;
  existing: boolean;
  replayed: boolean;
}

type RpcDb = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
};

/** One call, one transaction. `status`/`body` are the HTTP answer. */
export async function saveStack(db: RpcDb, req: StackSaveRequest): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: { data: unknown; error: { code?: string } | null };
  try {
    res = await db.rpc(STACK_SAVE_RPC, stackRpcArgs(req));
  } catch {
    const f = stackSaveFailure(null);
    return { status: f.status, body: { error: f.error, code: f.code } };
  }
  if (res.error) {
    const f = stackSaveFailure(res.error.code);
    console.error("supplement stack save failed:", res.error.code ?? "no code");
    return { status: f.status, body: { error: f.error, code: f.code } };
  }
  const row = res.data as StackSaveRow | null;
  if (!row || !isPositiveInt(row.stack_id) || !isPositiveInt(row.version)) {
    const f = stackSaveFailure(null);
    return { status: f.status, body: { error: f.error, code: f.code } };
  }
  return { status: 200, body: { ok: true, ...row } };
}
