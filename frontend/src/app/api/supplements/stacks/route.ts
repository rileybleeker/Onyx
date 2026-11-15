import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseRemindTime } from "@/lib/supplement-reminders";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

interface IncomingItem {
  product_id?: string;
  doses?: number;
}

/** Normalize + validate an incoming items array into insertable rows. */
function buildItemRows(
  stack_id: number,
  items: IncomingItem[] | undefined,
): { rows: { stack_id: number; product_id: string; doses: number; sort_order: number }[]; error?: string } {
  if (!Array.isArray(items)) return { rows: [], error: "items must be an array" };
  const rows: { stack_id: number; product_id: string; doses: number; sort_order: number }[] = [];
  const seen = new Set<string>();
  items.forEach((it, idx) => {
    if (!it?.product_id) return; // skip blanks
    if (seen.has(it.product_id)) return; // dedupe (unique constraint would reject)
    seen.add(it.product_id);
    const doses = Number(it.doses ?? 1);
    rows.push({
      stack_id,
      product_id: it.product_id,
      doses: Number.isFinite(doses) && doses > 0 ? doses : 1,
      sort_order: idx,
    });
  });
  return { rows };
}

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
  let sq = supabase
    .from("supplement_stack")
    .select(
      "stack_id,name,description,remind_time,is_active,sort_order,created_at,updated_at," +
        "supplement_stack_item(item_id,product_id,doses,sort_order,supplement_products(brand_name,full_name,serving_size,serving_unit,ingredients,is_active))",
    );
  if (!includeArchived) sq = sq.eq("is_active", true);
  const { data: stacks, error: stacksErr } = await sq
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .order("sort_order", { referencedTable: "supplement_stack_item", ascending: true });
  if (stacksErr) return NextResponse.json({ error: stacksErr.message }, { status: 500 });

  type Product = { brand_name: string | null; full_name: string | null; serving_size: number | null; serving_unit: string | null; ingredients: unknown; is_active: boolean };
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
        ingredient_count: Array.isArray(p?.ingredients) ? (p?.ingredients as unknown[]).length : 0,
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

const STACK_COLS = "stack_id,name,description,remind_time,is_active,sort_order,created_at,updated_at";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the error is the client_key column not existing yet (sql/supplement_stack_client_key.sql not applied). */
function missingKeyColumn(e: { code?: string; message?: string } | null): boolean {
  return !!e && (e.code === "42703" || e.code === "PGRST204" || /client_key/.test(e.message ?? ""));
}

/** Replace all items of a stack (delete-by-stack_id + insert). Answers the error text, or null. */
async function replaceItems(stack_id: number, items: IncomingItem[] | undefined): Promise<{ error: string | null; count: number }> {
  const { error: delErr } = await supabase.from("supplement_stack_item").delete().eq("stack_id", stack_id);
  if (delErr) return { error: delErr.message, count: 0 };
  const { rows } = buildItemRows(stack_id, items);
  if (rows.length > 0) {
    const { error: insErr } = await supabase.from("supplement_stack_item").insert(rows);
    if (insErr) return { error: insErr.message, count: 0 };
  }
  return { error: null, count: rows.length };
}

/**
 * POST /api/supplements/stacks
 * Body: { name, description?, remind_time?, items: [{ product_id, doses }], client_key?: uuid }
 *
 * Creates a new stack (header + items). Items with a blank product_id are
 * skipped; duplicates within the payload are de-duped (the table also enforces
 * a unique (stack_id, product_id)). remind_time is a local 'HH:MM' for the push
 * reminder; empty / null = reminders off.
 *
 * client_key (the stack editor's autosave sends one random UUID per new stack): when a stack with that key exists
 * already (the editor retried after a lost answer), it is brought up to this body and returned with existing: true
 * instead of inserting a second stack. Works without the key column (sql/supplement_stack_client_key.sql) too:
 * the stack is then created without a key, as before.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    name?: string;
    description?: string;
    remind_time?: string | null;
    items?: IncomingItem[];
    client_key?: unknown;
  };
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  const remind = parseRemindTime(body.remind_time ?? null);
  if (!remind.ok) return NextResponse.json({ error: remind.error }, { status: 400 });
  if (body.client_key !== undefined && body.client_key !== null && (typeof body.client_key !== "string" || !UUID_RE.test(body.client_key))) {
    return NextResponse.json({ error: "client_key must be a UUID" }, { status: 400 });
  }
  const key = typeof body.client_key === "string" ? body.client_key.toLowerCase() : null;
  const header = { name, description: body.description?.trim() || null, remind_time: remind.value };

  // The stack this key already created: update it to this body (the editor may have changed since) and return it.
  const adopt = async (): Promise<NextResponse | null> => {
    if (!key) return null;
    const { data: found, error: findErr } = await supabase.from("supplement_stack").select(STACK_COLS).eq("client_key", key).maybeSingle();
    if (findErr) return missingKeyColumn(findErr) ? null : NextResponse.json({ error: findErr.message }, { status: 500 });
    if (!found) return null;
    const { data: updated, error: upErr } = await supabase
      .from("supplement_stack")
      .update({ ...header, updated_at: new Date().toISOString() })
      .eq("stack_id", found.stack_id)
      .select(STACK_COLS)
      .single();
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
    const items = await replaceItems(found.stack_id, body.items);
    if (items.error) return NextResponse.json({ error: items.error }, { status: 500 });
    return NextResponse.json({ ...updated, item_count: items.count, existing: true });
  };

  const earlier = await adopt();
  if (earlier) return earlier;

  let { data: stack, error: stackErr } = await supabase
    .from("supplement_stack")
    .insert({ ...header, ...(key ? { client_key: key } : {}) })
    .select(STACK_COLS)
    .single();
  if (stackErr && key && stackErr.code === "23505") {
    // The same key was inserted by a request still in flight: answer with that stack.
    const again = await adopt();
    if (again) return again;
  }
  if (stackErr && key && missingKeyColumn(stackErr)) {
    ({ data: stack, error: stackErr } = await supabase.from("supplement_stack").insert(header).select(STACK_COLS).single());
  }
  if (stackErr || !stack) return NextResponse.json({ error: stackErr?.message ?? "insert failed" }, { status: 500 });

  const { rows } = buildItemRows(stack.stack_id, body.items);
  if (rows.length > 0) {
    const { error: itemErr } = await supabase.from("supplement_stack_item").insert(rows);
    if (itemErr) {
      // Roll back the orphan header so a failed item insert doesn't leave junk.
      await supabase.from("supplement_stack").delete().eq("stack_id", stack.stack_id);
      return NextResponse.json({ error: itemErr.message }, { status: 500 });
    }
  }
  return NextResponse.json({ ...stack, item_count: rows.length });
}

/**
 * PATCH /api/supplements/stacks
 * Body: { stack_id, name?, description?, remind_time?, is_active?, items? }
 *
 * Updates header fields that are present (remind_time: 'HH:MM' sets it, empty
 * or null turns the reminder off, omitted leaves it alone). If `items` is
 * provided, ALL items are replaced (delete-by-stack_id + insert) so the editor
 * is a simple full-save.
 */
export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as {
    stack_id?: number;
    name?: string;
    description?: string | null;
    remind_time?: string | null;
    is_active?: boolean;
    items?: IncomingItem[];
  };
  if (!body.stack_id || !Number.isFinite(body.stack_id)) {
    return NextResponse.json({ error: "stack_id is required" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) {
    const n = body.name.trim();
    if (!n) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    patch.name = n;
  }
  if (body.description !== undefined) patch.description = body.description?.trim() || null;
  if (body.remind_time !== undefined) {
    const remind = parseRemindTime(body.remind_time);
    if (!remind.ok) return NextResponse.json({ error: remind.error }, { status: 400 });
    patch.remind_time = remind.value;
  }
  if (body.is_active !== undefined) patch.is_active = body.is_active;

  const { error: upErr } = await supabase
    .from("supplement_stack")
    .update(patch)
    .eq("stack_id", body.stack_id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  if (body.items !== undefined) {
    const { error: delErr } = await supabase
      .from("supplement_stack_item")
      .delete()
      .eq("stack_id", body.stack_id);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
    const { rows } = buildItemRows(body.stack_id, body.items);
    if (rows.length > 0) {
      const { error: insErr } = await supabase.from("supplement_stack_item").insert(rows);
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, stack_id: body.stack_id });
}

/**
 * DELETE /api/supplements/stacks?stack_id=...
 *
 * Soft-delete (is_active=false), mirroring product archival. Existing
 * supplement_intake.stack_id provenance stays resolvable.
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
