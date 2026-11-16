import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { checkPortionRequest } from "@/lib/delivery-portion";
import { MAX_WINDDOWN_BODY_BYTES, isMissingStorage, parseCancelBody, windDownRefusal } from "@/lib/sleep-winddown";
import { cancelResult, readJsonBody } from "@/lib/sleep-winddown-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/sleep/winddown/cancel (PROD-SLEEP-01): Riley pressed Cancel on a tap that was sent and never answered, so
 * it is not known whether it landed. Body {op_id, night}. pds.sleep_winddown_cancel_op settles it under the same lock
 * as the write: `landed: true` (with the answer it holds) when the tap had been applied, `landed: false` when it had
 * not, in which case a request with that id that is still on its way is refused later (409 cancelled on the night
 * route). Writes nothing to the habit rows. Owner session only (never in isCiRoute()), same-origin JSON, at most 1 KB.
 */

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
  auth: { persistSession: false, autoRefreshToken: false },
});

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest) {
  const refused = checkPortionRequest(req.headers, req.nextUrl.origin, MAX_WINDDOWN_BODY_BYTES);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status, headers: NO_STORE });
  const read = await readJsonBody(req, MAX_WINDDOWN_BODY_BYTES);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: read.status, headers: NO_STORE });
  const parsed = parseCancelBody(read.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });

  const { data, error } = await supabase.rpc("sleep_winddown_cancel_op", { p_op_id: parsed.value.opId, p_night: parsed.value.night });
  if (error) {
    const known = windDownRefusal(error);
    if (known) return NextResponse.json({ error: known.error, code: known.code }, { status: known.status, headers: NO_STORE });
    if (isMissingStorage(error)) return NextResponse.json({ error: "The wind-down streak isn't set up on the server yet.", code: "not_connected" }, { status: 503, headers: NO_STORE });
    console.error("[sleep winddown] cancel failed", error.code ?? "unexpected");
    return NextResponse.json({ error: "Couldn't stop it. Try again." }, { status: 500, headers: NO_STORE });
  }
  const result = cancelResult(data);
  if (!result) {
    console.error("[sleep winddown] cancel: unexpected reply");
    return NextResponse.json({ error: "Couldn't stop it. Try again." }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ night: result.night, landed: result.landed, answer: result.answer }, { headers: NO_STORE });
}
