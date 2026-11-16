import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Shared logic for recording a stack as consumed: writes one
 * pds.supplement_intake row per stack item, carrying that item's dose and
 * stamping the stack_id provenance. Reused by:
 *   - POST /api/supplements/stacks/log   (the /supplements UI)
 *   - the log_supplement_stack chat tool (api/chat/route.ts)
 *
 * The Supabase client passed in MUST already be scoped to schema "pds".
 * intake_date defaults to the behavioral-today (pds.behavioral_today_now RPC,
 * TZ- + awake-tail-aware) with an ET-clock fallback — matching the existing
 * log-intake route so the awake-tail convention is honored everywhere.
 *
 * Event identity (SEC-04, sql/chat_operations.sql): with `event_key` (a UUID,
 * the chat operation id) every row of this log carries the key and its place
 * (client_event_key / client_event_line) and all rows go in ONE insert. A
 * second call with the same key returns the rows already written instead of
 * writing the stack again, also when two calls race (the unique index fails the
 * whole second insert). Without a key nothing changes.
 */
export interface LogStackResult {
  ok: boolean;
  error?: string;
  stack_id?: number;
  stack_name?: string;
  intake_date?: string;
  intake_ids?: number[];
  count?: number;
  total_doses?: number;
  /** The rows of an earlier call with the same event_key; nothing was written now. */
  replayed?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pds = SupabaseClient<any, any, any>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The key columns are new: until sql/chat_operations.sql is applied the key is ignored (codes only, never a 23505). */
const missingColumn = (error: { code?: string } | null | undefined) => !!error && (error.code === "42703" || error.code === "PGRST204");

export const eventKeyOf = (value: unknown): string | null =>
  typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : null;

interface EventRow {
  intake_id: number;
  doses: number | string;
  intake_date: string;
}

/** The rows an earlier call with this key wrote (empty when none, or when the column is not there yet). */
async function rowsForEvent(supabase: Pds, key: string): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from("supplement_intake")
    .select("intake_id,doses,intake_date")
    .eq("client_event_key", key)
    .order("client_event_line", { ascending: true });
  if (error) return [];
  return (data ?? []) as EventRow[];
}

async function replayStack(supabase: Pds, stack_id: number, rows: EventRow[]): Promise<LogStackResult> {
  // The stack may have been renamed or archived since; its rows still stand.
  const { data: stack } = await supabase.from("supplement_stack").select("name").eq("stack_id", stack_id).maybeSingle();
  return {
    ok: true,
    stack_id,
    stack_name: (stack as { name?: string } | null)?.name ?? undefined,
    intake_date: rows[0].intake_date,
    intake_ids: rows.map((r) => r.intake_id),
    count: rows.length,
    total_doses: rows.reduce((s, r) => s + Number(r.doses), 0),
    replayed: true,
  };
}

export async function logStackIntake(
  supabase: Pds,
  stack_id: number,
  opts: { intake_date?: string | null; intake_time?: string | null; event_key?: string | null } = {},
): Promise<LogStackResult> {
  const key = eventKeyOf(opts.event_key);
  if (key) {
    const prior = await rowsForEvent(supabase, key);
    if (prior.length > 0) return replayStack(supabase, stack_id, prior);
  }

  // Resolve the stack (must be active) + its items.
  const { data: stack, error: stackErr } = await supabase
    .from("supplement_stack")
    .select("stack_id,name,is_active")
    .eq("stack_id", stack_id)
    .single();
  if (stackErr || !stack) return { ok: false, error: stackErr?.message ?? "stack not found" };
  if (!stack.is_active) return { ok: false, error: "stack is archived" };

  const { data: items, error: itemsErr } = await supabase
    .from("supplement_stack_item")
    .select("product_id,doses,sort_order")
    .eq("stack_id", stack_id)
    .order("sort_order", { ascending: true });
  if (itemsErr) return { ok: false, error: itemsErr.message };
  if (!items || items.length === 0) {
    return { ok: false, error: "stack has no products", stack_name: stack.name };
  }

  // Default intake_date to behavioral-today (awake-tail + TZ aware).
  let intake_date = opts.intake_date ?? undefined;
  if (!intake_date) {
    try {
      const { data: bday } = await supabase.rpc("behavioral_today_now");
      intake_date =
        (bday as string | null) ||
        new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    } catch {
      intake_date = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    }
  }
  // undefined = caller didn't think about time → default to now (chat tool,
  // legacy callers). EXPLICIT null = "no clock time" (backdated /supplements
  // logs) and must be preserved — `??` would coerce it back to now, which is
  // exactly how 7 retro-logged intakes got next-day timestamps that the
  // caffeine timing layer then had to quarantine.
  const intake_time = opts.intake_time !== undefined ? opts.intake_time : new Date().toISOString();

  const rows = items.map((it) => ({
    product_id: it.product_id,
    doses: Number(it.doses),
    intake_date,
    intake_time,
    stack_id,
    notes: `Logged from stack: ${stack.name}`,
  }));

  const keyed = key ? rows.map((r, i) => ({ ...r, client_event_key: key, client_event_line: i })) : rows;
  let { data: inserted, error: insErr } = await supabase
    .from("supplement_intake")
    .insert(keyed)
    .select("intake_id");
  if (insErr && key && insErr.code === "23505") {
    // The same event arrived twice at once: the other call wrote the whole set.
    const prior = await rowsForEvent(supabase, key);
    if (prior.length > 0) return replayStack(supabase, stack_id, prior);
  }
  if (insErr && key && missingColumn(insErr)) {
    ({ data: inserted, error: insErr } = await supabase.from("supplement_intake").insert(rows).select("intake_id"));
  }
  if (insErr) return { ok: false, error: insErr.message };

  return {
    ok: true,
    stack_id,
    stack_name: stack.name,
    intake_date,
    intake_ids: (inserted ?? []).map((r: { intake_id: number }) => r.intake_id),
    count: rows.length,
    total_doses: rows.reduce((s, r) => s + Number(r.doses), 0),
  };
}
