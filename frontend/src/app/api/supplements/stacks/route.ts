import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseStackSave, saveStack } from "@/lib/supplement-stack-save";
import { type MissingColumnMemo, STACK_READ_STEPS, nextMemo, startStep } from "@/lib/supplement-stack-read-plan";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

/** Optional columns the last successful GET read found missing (see lib/supplement-stack-read-plan.ts). */
let missingMemo: MissingColumnMemo = null;

/**
 * GET /api/supplements/stacks?include_archived=1
 *
 * Returns active stacks (newest first), each decorated with its items and a
 * compact product summary so the picker can render without a second fetch.
 */
export async function GET(req: NextRequest) {
  const includeArchived = req.nextUrl.searchParams.get("include_archived") === "1";

  // Speed (2026-11-15): stacks, their items and the items' products in ONE query (PostgREST embedding over the
  // FKs supplement_stack_item.stack_id and .product_id) instead of three round trips in a row.
  // `version` (sql/supplement_stack_atomic_save.sql) is what the editor sends back with each save; a database
  // without that column yet (42703, code only) is read without it, and the editor then saves without a version.
  // `ingredient_count` (sql/supplement_product_ingredient_count.sql, 2026-11-17) is the number the picker shows; it
  // is read instead of the whole `ingredients` array, which was sent across the wire only to be counted. Without
  // that column (42703) the array is read and counted here, as before.
  const read = (withVersion: boolean, withCount: boolean) => {
    let sq = supabase
      .from("supplement_stack")
      .select(
        "stack_id,name,description,remind_time,is_active,sort_order,created_at,updated_at," +
          (withVersion ? "version," : "") +
          "supplement_stack_item(item_id,product_id,doses,sort_order,supplement_products(brand_name,full_name,serving_size,serving_unit," +
          (withCount ? "ingredient_count" : "ingredients") +
          ",is_active))",
      );
    if (!includeArchived) sq = sq.eq("is_active", true);
    return sq
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false })
      .order("sort_order", { referencedTable: "supplement_stack_item", ascending: true });
  };
  // Start at the step the memo predicts (a column found missing within the last 10 minutes is not selected again).
  const now = Date.now();
  const start = startStep(missingMemo, now);
  let idx = start;
  const readStep = (i: number) => read(STACK_READ_STEPS[i][0], STACK_READ_STEPS[i][1]);
  let res = await readStep(idx);
  // Each 42703 step drops one optional column (version, then ingredient_count) until the read goes through.
  while (res.error?.code === "42703" && idx < STACK_READ_STEPS.length - 1) {
    idx += 1;
    res = await readStep(idx);
  }
  if (!res.error) missingMemo = nextMemo(missingMemo, start, idx, now);
  const { data: stacks, error: stacksErr } = res;
  if (stacksErr) return NextResponse.json({ error: stacksErr.message }, { status: 500 });

  type Product = { brand_name: string | null; full_name: string | null; serving_size: number | null; serving_unit: string | null; ingredients?: unknown; ingredient_count?: number | null; is_active: boolean };
  type Item = { item_id: number; product_id: string; doses: number; sort_order: number; supplement_products: Product | Product[] | null };
  type Stack = { stack_id: number; supplement_stack_item: Item[] | null } & Record<string, unknown>;

  const decorated = ((stacks ?? []) as unknown as Stack[]).map(({ supplement_stack_item, ...s }) => {
    const its = (supplement_stack_item ?? []).map((it) => {
      const p = Array.isArray(it.supplement_products) ? it.supplement_products[0] : it.supplement_products;
      return {
        item_id: it.item_id,
        product_id: it.product_id,
        doses: Number(it.doses),
        sort_order: it.sort_order,
        brand_name: p?.brand_name ?? null,
        full_name: p?.full_name ?? null,
        serving_size: p?.serving_size ?? null,
        serving_unit: p?.serving_unit ?? null,
        ingredient_count:
          p?.ingredient_count ?? (Array.isArray(p?.ingredients) ? (p?.ingredients as unknown[]).length : 0),
        product_active: p?.is_active ?? true,
      };
    });
    return {
      ...s,
      items: its,
      item_count: its.length,
      total_doses: its.reduce((sum, i) => sum + Number(i.doses), 0),
    };
  });

  return NextResponse.json({ stacks: decorated });
}

/** The body as JSON, or undefined when it is not JSON (answered 400, nothing written). */
async function readBody(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/**
 * POST /api/supplements/stacks
 * Body: { name, description?, remind_time?, items?: [{ product_id, doses }], client_key?: uuid, save_id?: uuid,
 *         after_save_ids?: uuid[] }
 *
 * Creates a stack: header + items in ONE transaction (pds.save_supplement_stack, sql/supplement_stack_atomic_save.sql).
 * remind_time is a local 'HH:MM' for the push reminder; empty / null = reminders off. A malformed body is refused
 * (400) before anything is written.
 *
 * client_key (the stack editor's autosave sends one random UUID per new stack): when a stack with that key exists
 * already (the editor retried after a lost answer), that stack is brought up to this body and returned with
 * existing: true instead of inserting a second one, but only when its last write was this editor's own (save ids;
 * without a save_id that is 409 "reload"); a resend of a save that already went through answers replayed: true and
 * writes nothing. A retry sent while the first copy is still running waits for it and then adopts it. There is no
 * keyless fallback: a database without the function answers 503 and creates nothing.
 */
export async function POST(req: NextRequest) {
  const parsed = parseStackSave(await readBody(req), "create");
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: "invalid" }, { status: 400 });
  const r = await saveStack(supabase, parsed.value);
  return NextResponse.json(r.body, { status: r.status });
}

/**
 * PATCH /api/supplements/stacks
 * Body: { stack_id, name?, description?, remind_time?, is_active?, items?, expected_version?, save_id?,
 *         after_save_ids? }
 *
 * Updates the header fields that are present (remind_time: 'HH:MM' sets it, empty or null turns the reminder off,
 * omitted leaves it alone). `items`, when present, is the COMPLETE list and replaces the old one in the same
 * transaction ([] clears the stack on purpose; anything that is not a valid array is refused with 400 and nothing
 * changes). The save is refused with 409 { code: "stale" } when the stack changed since expected_version, unless the
 * change was this editor's own unanswered save (after_save_ids). An update with save_id but no expected_version is
 * refused with 409 { code: "reload" } before anything is written, even an exact resend. An update with neither (a tab
 * running the previous build) is refused with 409 { code: "reload" } by the database and changes nothing.
 */
export async function PATCH(req: NextRequest) {
  const parsed = parseStackSave(await readBody(req), "update");
  if (!parsed.ok) {
    const reload = parsed.code === "reload";
    return NextResponse.json({ error: parsed.error, code: reload ? "reload" : "invalid" }, { status: reload ? 409 : 400 });
  }
  const r = await saveStack(supabase, parsed.value);
  return NextResponse.json(r.body, { status: r.status });
}

/**
 * DELETE /api/supplements/stacks?stack_id=...
 *
 * Soft-delete (is_active=false), mirroring product archival. Existing
 * supplement_intake.stack_id provenance stays resolvable. Like every update of a stack row this raises its version
 * (trigger in sql/supplement_stack_atomic_save.sql), so an editor still open on it is asked to load the latest.
 */
export async function DELETE(req: NextRequest) {
  const stack_id = req.nextUrl.searchParams.get("stack_id");
  if (!stack_id) return NextResponse.json({ error: "stack_id is required" }, { status: 400 });
  const { error } = await supabase
    .from("supplement_stack")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("stack_id", stack_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, stack_id });
}
