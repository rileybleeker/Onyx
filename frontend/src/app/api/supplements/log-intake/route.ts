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
  const row = {
    product_id: body.product_id,
    doses: body.doses ?? 1,
    intake_date:
      body.intake_date ??
      new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
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
