import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

/**
 * GET /api/supplements/products?include_archived=1
 *
 * Returns the product library (active by default). Pass include_archived=1
 * to surface soft-deleted rows too. Each row carries a compact ingredient
 * summary so the picker can render counts without a second fetch.
 */
export async function GET(req: NextRequest) {
  const includeArchived = req.nextUrl.searchParams.get("include_archived") === "1";
  let q = supabase
    .from("supplement_products")
    .select("product_id,dsld_id,brand_name,full_name,upc_sku,serving_size,serving_unit,physical_state,ingredients,is_active");
  if (!includeArchived) q = q.eq("is_active", true);
  const { data, error } = await q.order("brand_name", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // Trim ingredients to just count + categories for list view payload size.
  const rows = (data ?? []).map((r) => {
    const ingredients = (r.ingredients ?? []) as Array<{ category?: string | null }>;
    const categories = Array.from(new Set(ingredients.map((i) => i.category).filter(Boolean))) as string[];
    return {
      product_id: r.product_id,
      dsld_id: r.dsld_id,
      brand_name: r.brand_name,
      full_name: r.full_name,
      upc_sku: r.upc_sku,
      serving_size: r.serving_size,
      serving_unit: r.serving_unit,
      physical_state: r.physical_state,
      ingredient_count: ingredients.length,
      categories,
      is_active: r.is_active,
    };
  });
  return NextResponse.json({ products: rows });
}

/**
 * PATCH /api/supplements/products
 * Body: { product_id, is_active }
 *
 * Soft-delete toggle. Archived products stop appearing in the picker but
 * existing intake_history rows keep working (intake.product_id FK still
 * resolves) and the daily_supplement_matrix continues to compute correctly
 * for those historical days.
 */
export async function PATCH(req: NextRequest) {
  const { product_id, is_active } = (await req.json()) as {
    product_id?: string;
    is_active?: boolean;
  };
  if (!product_id || typeof is_active !== "boolean") {
    return NextResponse.json(
      { error: "product_id and is_active (boolean) are required" },
      { status: 400 },
    );
  }
  const { error } = await supabase
    .from("supplement_products")
    .update({ is_active })
    .eq("product_id", product_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, product_id, is_active });
}
