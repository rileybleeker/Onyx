import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { logSupplementIntake } from "@/lib/supplement-intake";
import { checkPortionRequest } from "@/lib/delivery-portion";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
  auth: { persistSession: false, autoRefreshToken: false },
});

const MAX_BODY_BYTES = 2048;
const MAX_TIMES = 12;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /api/supplements/log-product
 * Body: { product_id?: string, product?: string, amount?: number|null, unit?: string|null,
 *         times?: "HH:MM"[], date?: "YYYY-MM-DD"|null }
 *
 * The /log Supplements section's "log a product" row: one product with an amount and clock times, through the
 * SAME function as the chat tool log_supplement_intake (lib/supplement-intake.ts logSupplementIntake), so the
 * rules are identical: the product resolves by id (the picker) or by name, brand or ingredient text (a Say it
 * draft); a weight amount is divided by the label quantity and a count by the serving size; one row per time,
 * each an instant in the zone from pds.tz_for_instant (a time before 06:00 = the small hours closing `date`);
 * no times = now for behavioral today, intake_time NULL for an earlier day; date defaults to
 * pds.behavioral_today_now(); a re-sent timed entry is skipped, not written twice.
 *
 * Owner session only (NOT in middleware's isCiRoute); same-origin JSON, 2 KB cap.
 */
export async function POST(req: NextRequest) {
  const refused = checkPortionRequest(req.headers, req.nextUrl.origin, MAX_BODY_BYTES);
  if (refused) return NextResponse.json({ ok: false, error: refused.error }, { status: refused.status });

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: "could not read body" }, { status: 400 });
  }
  if (text.length > MAX_BODY_BYTES) return NextResponse.json({ ok: false, error: "body too large" }, { status: 413 });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "body must be JSON" }, { status: 400 });
  }
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const productId = typeof b.product_id === "string" ? b.product_id.trim().slice(0, 120) : "";
  const product = typeof b.product === "string" ? b.product.trim().slice(0, 120) : "";
  if (!productId && !product) return NextResponse.json({ ok: false, error: "product_id or product is required" }, { status: 400 });

  let amount: number | null = null;
  if (b.amount !== undefined && b.amount !== null) {
    if (typeof b.amount !== "number" || !Number.isFinite(b.amount) || b.amount <= 0 || b.amount > 100000) {
      return NextResponse.json({ ok: false, error: "amount must be a positive number" }, { status: 400 });
    }
    amount = b.amount;
  }
  let unit: string | null = null;
  if (b.unit !== undefined && b.unit !== null) {
    if (typeof b.unit !== "string" || b.unit.length > 40) return NextResponse.json({ ok: false, error: "unit must be short text" }, { status: 400 });
    unit = b.unit.trim() || null;
  }
  let times: string[] = [];
  if (b.times !== undefined && b.times !== null) {
    if (!Array.isArray(b.times) || b.times.length > MAX_TIMES || !b.times.every((t) => typeof t === "string" && TIME_RE.test(t))) {
      return NextResponse.json({ ok: false, error: `times must be up to ${MAX_TIMES} "HH:MM" values` }, { status: 400 });
    }
    times = b.times as string[];
  }
  let date: string | null = null;
  if (b.date !== undefined && b.date !== null) {
    if (typeof b.date !== "string" || !DATE_RE.test(b.date)) return NextResponse.json({ ok: false, error: "date must be YYYY-MM-DD" }, { status: 400 });
    date = b.date;
  }

  try {
    const result = await logSupplementIntake(supabase, {
      product,
      product_id: productId || null,
      amount,
      unit,
      times,
      date,
      notes: "Logged from /log",
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (e) {
    console.error("log-product failed:", e instanceof Error ? e.name : "error");
    return NextResponse.json({ ok: false, error: "could not save" }, { status: 500 });
  }
}
