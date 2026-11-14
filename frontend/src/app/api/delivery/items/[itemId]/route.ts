import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { MAX_PORTION_BODY_BYTES, checkPortionRequest, parseItemId, parsePortionBody } from "@/lib/delivery-portion";
import { leftoverConflictMessage } from "@/lib/delivery-leftovers";

// PATCH /api/delivery/items/[itemId]   body {eaten_fraction: number | null}
// How much of one delivered Uber Eats cart line Riley ate (1, 0.75, 0.5, 0.25, 0; null = back to "all",
// the default). Owner session only: this path is NOT in middleware's isCiRoute carve-out (only
// /api/delivery/items/import is), so the normal session check guards it. Writes exactly one column of
// one pds.delivery_order_items row. pds.delivery_item_nutrition is never touched: its per-dish estimate
// is shared by every order of the same dish. The harvester's upsert does not send eaten_fraction, so the
// value survives re-harvests.

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  const id = parseItemId(itemId);
  if (id == null) return NextResponse.json({ error: "invalid item id" }, { status: 400 });

  const refused = checkPortionRequest(req.headers, req.nextUrl.origin);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "could not read body" }, { status: 400 });
  }
  if (text.length > MAX_PORTION_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = parsePortionBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { data, error } = await supabase
    .from("delivery_order_items")
    .update({ eaten_fraction: parsed.value })
    .eq("item_id", id)
    .select("item_id, eaten_fraction");
  if (error) {
    // The leftover guard (sql/delivery_item_leftovers.sql) refuses a delivery-day portion that would no
    // longer leave room for leftovers already saved on a later day.
    const conflict = leftoverConflictMessage(error.code, "portion");
    if (conflict) return NextResponse.json({ error: conflict }, { status: 409 });
    console.error("delivery portion update failed:", error.code);
    return NextResponse.json({ error: "could not save" }, { status: 500 });
  }
  const row = data?.[0];
  if (!row) return NextResponse.json({ error: "item not found" }, { status: 404 });

  // The /nutrition ISR snapshot carries pds.delivery_nutrition_daily totals; drop it so the next load
  // shows the new number (the open page updates itself).
  revalidatePath("/nutrition");
  return NextResponse.json({
    item_id: Number(row.item_id),
    eaten_fraction: row.eaten_fraction == null ? null : Number(row.eaten_fraction),
  });
}
