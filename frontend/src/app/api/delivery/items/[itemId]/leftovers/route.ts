import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { MAX_PORTION_BODY_BYTES, checkPortionRequest, parseItemId } from "@/lib/delivery-portion";
import { checkLeftoverWrite, leftoverConflictMessage, parseLeftoverBody, type LeftoverRow } from "@/lib/delivery-leftovers";

// PUT /api/delivery/items/[itemId]/leftovers   body {date, fraction, threw_out?, time?}
// Leftovers of one delivered Uber Eats cart line eaten on a LATER behavioral day (D+1..D+3):
// fraction = share of the WHOLE line eaten that day (0 + threw_out false = "not today"),
// threw_out = the rest was thrown away (stop asking), fraction null = clear that day's answer,
// time = local "HH:MM" it was eaten (before 06:00 = the small hours closing that day; the trigger turns
// it into the instant eaten_at and refuses a time in the future).
// Owner session only: NOT in middleware's isCiRoute carve-out. Writes only pds.delivery_item_leftovers
// (one row per dish and day). The database trigger enforces the same rules (checkLeftoverWrite only
// names the problem first); a trigger refusal is answered 409.

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
  auth: { persistSession: false, autoRefreshToken: false },
});

function toRows(data: unknown): LeftoverRow[] {
  return ((data as Array<Record<string, unknown>>) ?? []).map((r) => ({
    item_id: Number(r.item_id),
    eaten_date: String(r.eaten_date),
    fraction: Number(r.fraction),
    threw_out: !!r.threw_out,
    eaten_time: r.eaten_time == null ? null : String(r.eaten_time).slice(0, 5),
  }));
}

async function behavioralToday(): Promise<string> {
  const { data, error } = await supabase.rpc("behavioral_today_now");
  if (!error && typeof data === "string") return data;
  // Same fallback as /api/behavioral-today: Eastern time - 6 h.
  return new Date(Date.now() - 6 * 3600 * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
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
  const parsed = parseLeftoverBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const w = parsed.value;

  const [dishRes, rowsRes, today] = await Promise.all([
    supabase
      .from("delivery_order_items")
      .select("item_id, onyx_behavioral_date, eaten_fraction, merchant_kind, is_cancelled")
      .eq("item_id", id),
    supabase.from("delivery_item_leftovers").select("item_id, eaten_date, fraction, threw_out, eaten_time").eq("item_id", id),
    behavioralToday(),
  ]);
  if (dishRes.error || rowsRes.error) {
    console.error("delivery leftovers read failed:", dishRes.error?.code ?? rowsRes.error?.code);
    return NextResponse.json({ error: "could not save" }, { status: 500 });
  }
  const d = dishRes.data?.[0];
  if (!d) return NextResponse.json({ error: "item not found" }, { status: 404 });
  if (!d.onyx_behavioral_date) return NextResponse.json({ error: "this dish has no delivery day yet" }, { status: 409 });
  const dish = {
    item_id: Number(d.item_id),
    behavioral_date: String(d.onyx_behavioral_date),
    eaten_fraction: d.eaten_fraction == null ? null : Number(d.eaten_fraction),
    merchant_kind: d.merchant_kind ?? null,
    is_cancelled: !!d.is_cancelled,
  };
  const conflict = checkLeftoverWrite(dish, toRows(rowsRes.data), today, w);
  if (conflict) return NextResponse.json({ error: conflict.error }, { status: conflict.status });

  const write =
    w.fraction === null
      ? await supabase.from("delivery_item_leftovers").delete().eq("item_id", id).eq("eaten_date", w.date)
      : await supabase
          .from("delivery_item_leftovers")
          .upsert(
            { item_id: id, eaten_date: w.date, fraction: w.fraction, threw_out: w.threw_out, eaten_time: w.time },
            { onConflict: "item_id,eaten_date" },
          );
  if (write.error) {
    const msg = leftoverConflictMessage(write.error.code, "leftover");
    if (msg) return NextResponse.json({ error: msg }, { status: 409 });
    console.error("delivery leftovers write failed:", write.error.code);
    return NextResponse.json({ error: "could not save" }, { status: 500 });
  }

  const after = await supabase
    .from("delivery_item_leftovers")
    .select("item_id, eaten_date, fraction, threw_out, eaten_time")
    .eq("item_id", id)
    .order("eaten_date", { ascending: true });
  // The /nutrition ISR snapshot carries pds.delivery_nutrition_daily totals, which now include leftovers.
  revalidatePath("/nutrition");
  return NextResponse.json({ item_id: id, leftovers: after.error ? null : toRows(after.data) });
}
