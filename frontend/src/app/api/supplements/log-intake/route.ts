import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

/**
 * POST /api/supplements/log-intake
 * Body: { product_id, doses?, intake_date?, intake_time?, notes? }
 *
 * Writes one row into pds.supplement_intake. Defaults intake_date to
 * today (ET-aligned via the user's timezone — we send the ISO date
 * client-side so server TZ doesn't shift it).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    product_id?: string;
    doses?: number;
    intake_date?: string;
    intake_time?: string;
    notes?: string;
  };
  if (!body.product_id) {
    return NextResponse.json({ error: "product_id is required" }, { status: 400 });
  }
  // Default intake_date to behavioral-today via pds.behavioral_today_now()
  // — TZ-aware (travel) + awake-tail-aware (-6h rule).
  let intake_date = body.intake_date;
  if (!intake_date) {
    try {
      const { data: bday } = await supabase.rpc("behavioral_today_now");
      intake_date = bday || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    } catch {
      intake_date = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    }
  }
  const row = {
    product_id: body.product_id,
    doses: body.doses ?? 1,
    intake_date,
    intake_time: body.intake_time ?? null,
    notes: body.notes ?? null,
  };
  const { data, error } = await supabase
    .from("supplement_intake")
    .insert(row)
    .select("intake_id")
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ intake_id: data?.intake_id, ...row });
}

/**
 * PATCH /api/supplements/log-intake
 * Body: { intake_id, doses?, intake_time?, notes?, intake_date? }
 *
 * Mutate a previously-logged intake. Only fields that are explicitly present
 * in the body are touched — undefined fields are left alone so partial edits
 * don't clobber unrelated columns. intake_time can be sent as `null` to
 * explicitly clear it ("took it today, time unspecified").
 */
export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as {
    intake_id?: number;
    doses?: number;
    intake_time?: string | null;
    intake_date?: string;
    notes?: string | null;
  };
  if (!body.intake_id || !Number.isFinite(body.intake_id)) {
    return NextResponse.json({ error: "intake_id is required" }, { status: 400 });
  }
  const patch: Record<string, unknown> = {};
  if (body.doses !== undefined) {
    if (!Number.isFinite(body.doses) || body.doses < 0) {
      return NextResponse.json({ error: "doses must be a non-negative number" }, { status: 400 });
    }
    patch.doses = body.doses;
  }
  if (body.intake_time !== undefined) patch.intake_time = body.intake_time;
  if (body.intake_date !== undefined) patch.intake_date = body.intake_date;
  if (body.notes !== undefined) patch.notes = body.notes;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }
  const { data, error } = await supabase
    .from("supplement_intake")
    .update(patch)
    .eq("intake_id", body.intake_id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * DELETE /api/supplements/log-intake?intake_id=...
 * For undoing a misclick on the log button.
 */
export async function DELETE(req: NextRequest) {
  const intake_id = req.nextUrl.searchParams.get("intake_id");
  if (!intake_id) {
    return NextResponse.json({ error: "intake_id is required" }, { status: 400 });
  }
  const { error } = await supabase
    .from("supplement_intake")
    .delete()
    .eq("intake_id", intake_id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
