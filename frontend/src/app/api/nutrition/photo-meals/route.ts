import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkPortionRequest } from "@/lib/delivery-portion";
import {
  MAX_SAVE_BODY_BYTES,
  PHOTO_MEAL_MODEL,
  mealTotals,
  parseDeleteBody,
  parsePhotoMealBody,
  photoMealErrorMessage,
} from "@/lib/photo-meal";

// POST   /api/nutrition/photo-meals   the meal Riley confirmed on the photo review screen -> pds.photo_meals
// DELETE /api/nutrition/photo-meals   body {meal_id}: remove one saved photo meal
// Owner session only (middleware; not in isCiRoute), same-origin JSON with a size cap. The totals are summed
// here from the items, never taken from the browser; eaten_at is computed by the table's trigger. POST is
// idempotent on client_key (a UUID the browser makes per review), so a double tap saves one meal.

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
  auth: { persistSession: false, autoRefreshToken: false },
});

async function readJson(req: NextRequest): Promise<{ ok: true; body: unknown } | { ok: false; res: NextResponse }> {
  const refused = checkPortionRequest(req.headers, req.nextUrl.origin, MAX_SAVE_BODY_BYTES);
  if (refused) return { ok: false, res: NextResponse.json({ error: refused.error }, { status: refused.status }) };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, res: NextResponse.json({ error: "could not read body" }, { status: 400 }) };
  }
  if (text.length > MAX_SAVE_BODY_BYTES) return { ok: false, res: NextResponse.json({ error: "body too large" }, { status: 413 }) };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "body must be JSON" }, { status: 400 }) };
  }
}

function dbError(code: string | undefined, what: string) {
  const known = photoMealErrorMessage(code);
  if (known) return NextResponse.json({ error: known.error }, { status: known.status });
  console.error(`photo meal ${what} failed:`, code);
  return NextResponse.json({ error: "could not save" }, { status: 500 });
}

export async function POST(req: NextRequest) {
  const read = await readJson(req);
  if (!read.ok) return read.res;
  const parsed = parsePhotoMealBody(read.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const m = parsed.value;
  const t = mealTotals(m.items);

  const { data, error } = await supabase
    .from("photo_meals")
    .upsert(
      {
        client_key: m.client_key,
        eaten_date: m.eaten_date,
        eaten_time: m.eaten_time,
        time_source: m.time_source,
        items: m.items,
        kcal: t.kcal,
        protein_g: t.protein_g,
        carbs_g: t.carbs_g,
        fat_g: t.fat_g,
        est_kcal: m.est_kcal,
        confidence: m.confidence,
        model: m.est_kcal != null ? PHOTO_MEAL_MODEL : null,
      },
      { onConflict: "client_key", ignoreDuplicates: true },
    )
    .select("meal_id, eaten_date, eaten_at, kcal");
  if (error) return dbError(error.code, "save");

  let row = data?.[0];
  if (!row) {
    // Already saved by an earlier tap with the same client_key: answer with that row.
    const again = await supabase.from("photo_meals").select("meal_id, eaten_date, eaten_at, kcal").eq("client_key", m.client_key).limit(1);
    if (again.error) return dbError(again.error.code, "re-read");
    row = again.data?.[0];
    if (!row) return NextResponse.json({ error: "could not save" }, { status: 500 });
  }

  // The /nutrition ISR snapshot carries the daily macros, which now include this meal.
  revalidatePath("/nutrition");
  return NextResponse.json({
    meal_id: Number(row.meal_id),
    eaten_date: String(row.eaten_date),
    eaten_at: row.eaten_at ?? null,
    kcal: Number(row.kcal),
  });
}

export async function DELETE(req: NextRequest) {
  const read = await readJson(req);
  if (!read.ok) return read.res;
  const id = parseDeleteBody(read.body);
  if (id == null) return NextResponse.json({ error: "body must be exactly {meal_id: positive integer}" }, { status: 400 });

  const { data, error } = await supabase.from("photo_meals").delete().eq("meal_id", id).select("meal_id");
  if (error) return dbError(error.code, "delete");
  if (!data?.length) return NextResponse.json({ error: "meal not found" }, { status: 404 });
  revalidatePath("/nutrition");
  return NextResponse.json({ deleted: id });
}
