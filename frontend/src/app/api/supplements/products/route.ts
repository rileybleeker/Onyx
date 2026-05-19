import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

/**
 * GET /api/supplements/products
 *
 * Returns the full product library (ordered by brand). Each row includes a
 * compact ingredient summary so the frontend can show "12 compounds" without
 * a second fetch.
 */
export async function GET() {
  const { data, error } = await supabase
    .from("supplement_products")
    .select("product_id,dsld_id,brand_name,full_name,upc_sku,serving_size,serving_unit,physical_state,ingredients")
    .order("brand_name", { ascending: true });
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
    };
  });
  return NextResponse.json({ products: rows });
}
