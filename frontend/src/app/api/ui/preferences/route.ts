import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { MAX_UI_PREF_BODY_BYTES, checkPrefWrite, isUiPrefKey, parsePrefBody } from "@/lib/ui-preferences";

export const dynamic = "force-dynamic";

/**
 * /api/ui/preferences: layout choices that follow Riley across devices (pds.ui_preferences,
 * sql/ui_preferences.sql). Owner session only: NOT in middleware's isCiRoute(), so no token reaches it.
 *
 * GET ?key=overview.cards  -> { key, value, updatedAt } (value null when nothing is saved yet)
 * PUT { key, value }       -> the same shape, after an upsert. Same-origin, JSON, at most 8 KB; the value is a
 *                             JSON object or array of at most 4 KB (lib/ui-preferences.ts).
 *
 * Logs carry a database error code only, never a stored value.
 */

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
  auth: { persistSession: false, autoRefreshToken: false },
});

const NO_STORE = { "Cache-Control": "no-store" };
const COLS = "key,value,updated_at";

function failed(code: string | undefined) {
  console.error("[ui preferences] query failed", code ?? "unexpected");
  return NextResponse.json({ error: "preferences unavailable" }, { status: 500, headers: NO_STORE });
}

function answer(row: { key: string; value: unknown; updated_at: string | null } | null, key: string) {
  return NextResponse.json({ key, value: row?.value ?? null, updatedAt: row?.updated_at ?? null }, { headers: NO_STORE });
}

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (!isUiPrefKey(key)) return NextResponse.json({ error: "invalid key" }, { status: 400, headers: NO_STORE });
  try {
    const { data, error } = await supabase.from("ui_preferences").select(COLS).eq("key", key).maybeSingle();
    if (error) return failed(error.code);
    return answer(data as { key: string; value: unknown; updated_at: string | null } | null, key);
  } catch {
    return failed(undefined);
  }
}

export async function PUT(req: NextRequest) {
  const refused = checkPrefWrite(req.headers, req.nextUrl.origin);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status, headers: NO_STORE });
  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "could not read body" }, { status: 400, headers: NO_STORE });
  }
  if (text.length > MAX_UI_PREF_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413, headers: NO_STORE });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400, headers: NO_STORE });
  }
  const parsed = parsePrefBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  try {
    const { data, error } = await supabase
      .from("ui_preferences")
      .upsert({ key: parsed.key, value: parsed.value, updated_at: new Date().toISOString() }, { onConflict: "key" })
      .select(COLS)
      .single();
    if (error) return failed(error.code);
    return answer(data as { key: string; value: unknown; updated_at: string | null }, parsed.key);
  } catch {
    return failed(undefined);
  }
}
