import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { parseClaimNow, runClaim } from "@/lib/supplement-reminders";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

/**
 * POST /api/supplements/reminders/claim
 * Body: { now?: ISO string }   (defaults to the server clock)
 *
 * Called by the sms-reminders Worker on its schedule. Atomically claims every
 * active stack that is due (local time within 4h after its remind_time), has no
 * intake logged for the behavioral day and has not been prompted yet, and
 * returns the claimed stacks for the Worker to post as /agents cards. Also
 * returns `settled`: earlier prompts whose stack was logged some other way.
 *
 * Auth: the x-onyx-ci-token header only (exact-path carve-out in
 * middleware.ts isCiRoute). The Worker holds no Supabase credentials.
 */
export async function POST(req: NextRequest) {
  let raw: unknown = {};
  try {
    const text = await req.text();
    if (text.trim()) raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "Body must be JSON" }, { status: 400 });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ ok: false, error: "Body must be a JSON object" }, { status: 400 });
  }

  const parsed = parseClaimNow((raw as { now?: unknown }).now, new Date());
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  try {
    return NextResponse.json(await runClaim(supabase, parsed.now));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("supplement reminder claim failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
