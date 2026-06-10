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
}

export async function logStackIntake(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  stack_id: number,
  opts: { intake_date?: string | null; intake_time?: string | null } = {},
): Promise<LogStackResult> {
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

  const { data: inserted, error: insErr } = await supabase
    .from("supplement_intake")
    .insert(rows)
    .select("intake_id");
  if (insErr) return { ok: false, error: insErr.message };

  return {
    ok: true,
    stack_id,
    stack_name: stack.name,
    intake_date,
    intake_ids: (inserted ?? []).map((r) => r.intake_id),
    count: rows.length,
    total_doses: rows.reduce((s, r) => s + Number(r.doses), 0),
  };
}
