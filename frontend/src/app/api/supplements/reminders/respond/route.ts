import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseRespondBody, respondToReminder } from "@/lib/supplement-reminders";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

/**
 * POST /api/supplements/reminders/respond
 * Body: { stack_id: number, behavioral_date: 'YYYY-MM-DD', action: 'log' | 'skip' }
 *
 * Called by the sms-reminders Worker when Riley taps Log it / Skip on a
 * reminder card. `log` writes the stack's intake rows (once - a repeat call
 * answers already_logged), `skip` just settles the reminder. Only a
 * (stack, day) the claim endpoint created can be answered (404 otherwise).
 *
 * Auth: the x-onyx-ci-token header only (exact-path carve-out in
 * middleware.ts isCiRoute).
 */
export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = parseRespondBody(raw);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  try {
    const result = await respondToReminder(supabase, parsed.value);
    return NextResponse.json(result.body, { status: result.httpStatus });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("supplement reminder respond failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
