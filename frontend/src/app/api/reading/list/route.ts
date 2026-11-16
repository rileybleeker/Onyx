import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkVoiceRequest } from "@/lib/checkin-voice";
import { LIST_MAX_BODY_BYTES, parseListOp } from "@/lib/reading-list";
import { applyListOp, readList } from "@/lib/reading-list-server";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/**
 * GET  /api/reading/list   The Want to read list: { items } in order. Read only (safe for the warm-up and the scroll).
 * POST /api/reading/list   One operation: { op: create | edit | move | remove | restore | start, op_key, ... }
 *                          (lib/reading-list.ts parseListOp; rules in lib/reading-list-server.ts).
 *
 * Auth: owner session only (middleware covers /api/reading/*; NOT in isCiRoute). POST: same-origin, JSON only,
 * 8 KB cap, unknown fields refused. Errors are short codes (no titles or other private text): 400 bad_*, 404
 * not_found, 409 changed / duplicate / not_queued, 503 list_unavailable (sql/reading_want_list.sql not applied).
 * Nothing here writes to Notion: a planned book has no reading-log page and no activity to mirror.
 */
export async function GET() {
  const r = await readList(supabase);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ items: r.items }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const refused = checkVoiceRequest(req.headers, req.nextUrl.origin, LIST_MAX_BODY_BYTES);
  if (refused) return NextResponse.json({ error: "bad_request" }, { status: refused.status });
  const raw = await req.text().catch(() => "");
  if (Buffer.byteLength(raw, "utf8") > LIST_MAX_BODY_BYTES) return NextResponse.json({ error: "bad_request" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const parsed = parseListOp(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const r = await applyListOp(supabase, parsed.op);
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
