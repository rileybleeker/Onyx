import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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

  let sq = supabase
    .from("supplement_stack")
    .select("stack_id,name,description,is_active,sort_order,created_at,updated_at");
  if (!includeArchived) sq = sq.eq("is_active", true);
  const { data: stacks, error: stacksErr } = await sq
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false });
  if (stacksErr) return NextResponse.json({ error: stacksErr.message }, { status: 500 });

  const stackIds = (stacks ?? []).map((s) => s.stack_id);
  if (stackIds.length === 0) return NextResponse.json({ stacks: [] });

  const { data: items, error: itemsErr } = await supabase
    .from("supplement_stack_item")
    .select("item_id,stack_id,product_id,doses,sort_order")
    .in("stack_id", stackIds)
    .order("sort_order", { ascending: true });
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });

  // Decorate items with product names + ingredient counts.
  const productIds = Array.from(new Set((items ?? []).map((i) => i.product_id)));
  let products: Record<string, { brand_name: string | null; full_name: string | null; serving_size: number | null; serving_unit: string | null; ingredient_count: number; is_active: boolean }> = {};
  if (productIds.length > 0) {
    const { data: prods } = await supabase
      .from("supplement_products")
      .select("product_id,brand_name,full_name,serving_size,serving_unit,ingredients,is_active")
      .in("product_id", productIds);
    products = Object.fromEntries(
      (prods ?? []).map((p) => [
        p.product_id,
        {
          brand_name: p.brand_name,
          full_name: p.full_name,
          serving_size: p.serving_size,
          serving_unit: p.serving_unit,
          ingredient_count: Array.isArray(p.ingredients) ? p.ingredients.length : 0,
          is_active: p.is_active,
        },
      ]),
    );
  }

  const itemsByStack = new Map<number, unknown[]>();
  for (const it of items ?? []) {
    const decorated = {
      item_id: it.item_id,
      product_id: it.product_id,
      doses: Number(it.doses),
      sort_order: it.sort_order,
      brand_name: products[it.product_id]?.brand_name ?? null,
      full_name: products[it.product_id]?.full_name ?? null,
      serving_size: products[it.product_id]?.serving_size ?? null,
      serving_unit: products[it.product_id]?.serving_unit ?? null,
      ingredient_count: products[it.product_id]?.ingredient_count ?? 0,
      product_active: products[it.product_id]?.is_active ?? true,
    };
    const arr = itemsByStack.get(it.stack_id) ?? [];
    arr.push(decorated);
    itemsByStack.set(it.stack_id, arr);
  }

  const decorated = (stacks ?? []).map((s) => {
    const its = (itemsByStack.get(s.stack_id) ?? []) as { doses: number }[];
    return {
      ...s,
      items: its,
      item_count: its.length,
      total_doses: its.reduce((sum, i) => sum + Number(i.doses), 0),
    };
  });

  return NextResponse.json({ stacks: decorated });
}

/**
 * POST /api/supplements/stacks
 * Body: { name, description?, items: [{ product_id, doses }] }
 *
 * Creates a new stack (header + items). Items with a blank product_id are
 * skipped; duplicates within the payload are de-duped (the table also enforces
 * a unique (stack_id, product_id)).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { name?: string; description?: string; items?: IncomingItem[] };
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const { data: stack, error: stackErr } = await supabase
    .from("supplement_stack")
    .insert({ name, description: body.description?.trim() || null })
    .select("stack_id,name,description,is_active,sort_order,created_at,updated_at")
    .single();
  if (stackErr) return NextResponse.json({ error: stackErr.message }, { status: 500 });

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
 * Body: { stack_id, name?, description?, is_active?, items? }
 *
 * Updates header fields that are present. If `items` is provided, ALL items are
 * replaced (delete-by-stack_id + insert) so the editor is a simple full-save.
 */
export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as {
    stack_id?: number;
    name?: string;
    description?: string | null;
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
