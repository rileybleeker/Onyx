import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { readWindDown, WindDownReadError } from "@/lib/sleep-winddown-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/sleep/winddown (PROD-SLEEP-01): the wind-down goal versions, pauses, the chosen habit's answers since the
 * goal started, the "Started" times and two weeks of WHOOP sleep for the feedback line (lib/sleep-winddown.ts
 * WindDownPayload). Read-only: opening Today or Log never writes. Owner session only (middleware; /api/sleep is
 * not in isCiRoute()). Logs carry a step and a database code only.
 */

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
  auth: { persistSession: false, autoRefreshToken: false },
});

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    return NextResponse.json(await readWindDown(supabase), { headers: NO_STORE });
  } catch (e) {
    const step = e instanceof WindDownReadError ? e.step : "unexpected";
    const code = e instanceof WindDownReadError ? e.code : null;
    console.error("[sleep winddown] read failed", step, code ?? "");
    return NextResponse.json({ error: "wind-down progress unavailable" }, { status: 500, headers: NO_STORE });
  }
}
