import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { NormalizedIngredient } from "@/lib/dsld";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

interface CustomProductBody {
  brand_name: string | null;
  full_name: string | null;
  serving_size: number | null;
  serving_unit: string | null;
  servings_per_container: number | null;
  physical_state: string | null;
  upc_sku?: string | null;
  ingredients: NormalizedIngredient[];
  extraction_meta?: Record<string, unknown>;
}

function newProductId(): string {
  return `custom_${randomBytes(6).toString("hex")}`;
}

/**
 * POST /api/supplements/custom-product
 *
 * Save a user-reviewed custom product (extracted from a Supplement Facts
 * photo and possibly hand-edited). Produces a row in pds.supplement_products
 * with the same shape as DSLD-sourced rows, so the supplement_intake_by_compound
 * view rolls UNII-tagged compounds up across DSLD + custom products
 * transparently. product_id is "custom_<random>" so the dsld_<id> namespace
 * stays clean.
 *
 * dsld_id is null. raw_json carries any extraction metadata for replay
 * (e.g. Claude usage stats, the original extracted payload pre-edit).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as CustomProductBody;
  if (!body.full_name || !Array.isArray(body.ingredients)) {
    return NextResponse.json(
      { error: "full_name and ingredients[] are required" },
      { status: 400 },
    );
  }
  if (body.ingredients.length === 0) {
    return NextResponse.json(
      { error: "ingredients[] cannot be empty" },
      { status: 400 },
    );
  }

  const product_id = newProductId();
  const row = {
    product_id,
    dsld_id: null,
    brand_name: body.brand_name,
    full_name: body.full_name,
    upc_sku: body.upc_sku ?? null,
    serving_size: body.serving_size,
    serving_unit: body.serving_unit,
    servings_per_container: body.servings_per_container,
    product_type: null,
    physical_state: body.physical_state,
    target_groups: [],
    ingredients: body.ingredients,
    off_market: false,
    is_active: true,
    raw_json: {
      source: "custom_photo_extraction",
      created_at: new Date().toISOString(),
      ...body.extraction_meta,
    },
  };

  const { error } = await supabase
    .from("supplement_products")
    .insert(row);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    product_id,
    full_name: row.full_name,
    brand_name: row.brand_name,
    ingredient_count: row.ingredients.length,
  });
}
