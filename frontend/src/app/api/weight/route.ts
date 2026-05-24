import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

/**
 * GET /api/weight?days=N
 *
 * Returns the last N days of weight log rows (default 90), oldest first
 * so the chart can plot left → right without resorting.
 */
export async function GET(req: NextRequest) {
  const daysParam = req.nextUrl.searchParams.get("days");
  const days = Math.min(Math.max(parseInt(daysParam ?? "90", 10) || 90, 1), 3650);

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const cutoff = new Date(today + "T00:00:00");
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("weight_log")
    .select("log_date, weight_kg, notes, logged_at")
    .gte("log_date", cutoffStr)
    .order("log_date", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ days, rows: data ?? [] });
}

/**
 * POST /api/weight
 * Body: { log_date?, weight_kg, notes? }
 *
 * log_date defaults to ET today. Upsert on log_date — re-logging the same
 * day overwrites; we keep one canonical weight per day.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    log_date?: string;
    weight_kg?: number;
    notes?: string;
  };

  if (typeof body.weight_kg !== "number" || !Number.isFinite(body.weight_kg) || body.weight_kg <= 0 || body.weight_kg >= 500) {
    return NextResponse.json({ error: "weight_kg must be a positive number under 500" }, { status: 400 });
  }

  const log_date =
    body.log_date ??
    new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const row = {
    log_date,
    weight_kg: body.weight_kg,
    notes: body.notes?.trim() ? body.notes.trim() : null,
    logged_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("weight_log")
    .upsert(row, { onConflict: "log_date" })
    .select("log_date, weight_kg, notes, logged_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * PATCH /api/weight
 * Body: { log_date, weight_kg?, notes? }
 *
 * Edits an existing row in place. Pass notes as "" to clear.
 */
export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as {
    log_date?: string;
    weight_kg?: number;
    notes?: string | null;
  };

  if (!body.log_date) {
    return NextResponse.json({ error: "log_date is required" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (body.weight_kg !== undefined) {
    if (!Number.isFinite(body.weight_kg) || body.weight_kg <= 0 || body.weight_kg >= 500) {
      return NextResponse.json({ error: "weight_kg must be a positive number under 500" }, { status: 400 });
    }
    patch.weight_kg = body.weight_kg;
  }
  if (body.notes !== undefined) {
    patch.notes = body.notes === null || body.notes.trim() === "" ? null : body.notes.trim();
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("weight_log")
    .update(patch)
    .eq("log_date", body.log_date)
    .select("log_date, weight_kg, notes, logged_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * DELETE /api/weight?log_date=YYYY-MM-DD
 */
export async function DELETE(req: NextRequest) {
  const log_date = req.nextUrl.searchParams.get("log_date");
  if (!log_date) {
    return NextResponse.json({ error: "log_date is required" }, { status: 400 });
  }
  const { error } = await supabase
    .from("weight_log")
    .delete()
    .eq("log_date", log_date);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
