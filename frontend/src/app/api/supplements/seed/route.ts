import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { dsldLabel, normalizeLabel } from "@/lib/dsld";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

/**
 * POST /api/supplements/seed
 * Body: { dsld_id: number }
 *
 * Fetches a full DSLD label, normalizes it (shape matches
 * supplement_lookup.py:normalize_label), and upserts into
 * pds.supplement_products.
 */
export async function POST(req: NextRequest) {
  const { dsld_id } = (await req.json()) as { dsld_id?: number };
  if (!dsld_id || !Number.isFinite(dsld_id)) {
    return NextResponse.json({ error: "dsld_id is required" }, { status: 400 });
  }
  try {
    const label = await dsldLabel(dsld_id);
    const row = normalizeLabel(label);
    const { error } = await supabase
      .from("supplement_products")
      .upsert(row, { onConflict: "product_id" });
    if (error) throw error;
    return NextResponse.json({
      product_id: row.product_id,
      brand_name: row.brand_name,
      full_name: row.full_name,
      ingredient_count: row.ingredients.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
