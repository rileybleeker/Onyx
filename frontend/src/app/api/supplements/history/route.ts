import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

/**
 * GET /api/supplements/history?days=30&page=0&perPage=50
 *
 * Paginated intake history, newest first. Decorated with product name +
 * brand. Includes total row count for paging UI.
 */
export async function GET(req: NextRequest) {
  const days = Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? 30));
  const page = Math.max(0, Number(req.nextUrl.searchParams.get("page") ?? 0));
  const perPage = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("perPage") ?? 50)));
  const from = page * perPage;
  const to = from + perPage - 1;

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split("T")[0];

  const { data, error, count } = await supabase
    .from("supplement_intake")
    .select("intake_id,intake_date,intake_time,product_id,doses,notes", { count: "exact" })
    .gte("intake_date", sinceStr)
    .order("intake_date", { ascending: false })
    .order("intake_time", { ascending: false, nullsFirst: false })
    .range(from, to);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const intakes = data ?? [];
  const productIds = Array.from(new Set(intakes.map((i) => i.product_id)));
  let names: Record<string, { brand_name: string | null; full_name: string | null }> = {};
  if (productIds.length > 0) {
    const { data: prods } = await supabase
      .from("supplement_products")
      .select("product_id,brand_name,full_name")
      .in("product_id", productIds);
    names = Object.fromEntries(
      (prods ?? []).map((p) => [p.product_id, { brand_name: p.brand_name, full_name: p.full_name }]),
    );
  }

  const rows = intakes.map((i) => ({
    ...i,
    brand_name: names[i.product_id]?.brand_name ?? null,
    full_name: names[i.product_id]?.full_name ?? null,
  }));

  return NextResponse.json({ rows, totalCount: count ?? 0 });
}
