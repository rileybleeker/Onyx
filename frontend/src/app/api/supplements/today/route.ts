import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

/**
 * GET /api/supplements/today
 *
 * Returns today's intakes + the compound-level rollup for today. The
 * compound rollup comes straight from the supplement_intake_by_compound
 * view so cross-product summation (e.g. Vitamin C from multivitamin +
 * standalone Vitamin C) just works.
 *
 * "Today" = pds.behavioral_today_now() — the awake-tail-aware,
 * TZ-aware behavioral day. At 1 AM ET this returns YESTERDAY (your
 * day hasn't ended pre-bed yet), matching the convention the
 * /supplements page uses for its log defaults. Using ET-clock-today
 * here would cause a silent display gap during the awake-tail: a
 * just-logged pre-bed intake would be hidden until midnight ticked
 * past the behavioral cutoff.
 */
export async function GET() {
  const { data: behavioralToday, error: btErr } = await supabase.rpc("behavioral_today_now");
  if (btErr) {
    console.error("behavioral_today_now RPC failed, falling back to ET clock:", btErr);
  }
  const today = (behavioralToday as string | null)
    ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const [intakesRes, compoundsRes] = await Promise.all([
    supabase
      .from("supplement_intake")
      .select("intake_id,intake_date,intake_time,product_id,doses,notes")
      .eq("intake_date", today)
      .order("intake_time", { ascending: false, nullsFirst: false }),
    supabase
      .from("supplement_intake_by_compound")
      .select("compound_key,ingredient_group,ingredient_name,unii_code,category,unit,total_amount,total_doses,source_product_count")
      .eq("calendar_date", today)
      .order("category")
      .order("ingredient_group"),
  ]);

  if (intakesRes.error) return NextResponse.json({ error: intakesRes.error.message }, { status: 500 });
  if (compoundsRes.error) return NextResponse.json({ error: compoundsRes.error.message }, { status: 500 });

  // Decorate intakes with product names (one extra fetch, scoped to the IDs)
  const intakes = intakesRes.data ?? [];
  const productIds = Array.from(new Set(intakes.map((i) => i.product_id)));
  let productNames: Record<string, { brand_name: string | null; full_name: string | null }> = {};
  if (productIds.length > 0) {
    const { data: prods } = await supabase
      .from("supplement_products")
      .select("product_id,brand_name,full_name")
      .in("product_id", productIds);
    productNames = Object.fromEntries(
      (prods ?? []).map((p) => [p.product_id, { brand_name: p.brand_name, full_name: p.full_name }]),
    );
  }
  const decoratedIntakes = intakes.map((i) => ({
    ...i,
    brand_name: productNames[i.product_id]?.brand_name ?? null,
    full_name: productNames[i.product_id]?.full_name ?? null,
  }));

  return NextResponse.json({
    date: today,
    intakes: decoratedIntakes,
    compounds: compoundsRes.data ?? [],
  });
}
