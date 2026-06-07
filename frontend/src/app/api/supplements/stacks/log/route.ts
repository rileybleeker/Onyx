import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { logStackIntake } from "@/lib/supplement-stacks";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

/**
 * POST /api/supplements/stacks/log
 * Body: { stack_id, intake_date?, intake_time? }
 *
 * Records a whole stack as consumed — one pds.supplement_intake row per item,
 * each carrying the item's dose and the stack_id provenance. Returns the
 * created intake_ids so the client can offer a single "undo all".
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    stack_id?: number;
    intake_date?: string;
    intake_time?: string | null;
  };
  if (!body.stack_id || !Number.isFinite(body.stack_id)) {
    return NextResponse.json({ error: "stack_id is required" }, { status: 400 });
  }
  const result = await logStackIntake(supabase, body.stack_id, {
    intake_date: body.intake_date,
    intake_time: body.intake_time,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result);
}
