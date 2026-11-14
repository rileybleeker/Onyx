import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { checkConfigWrite, MAX_FOCUS_CONFIG_BODY_BYTES, parseConfigBody, type FocusUnlockConfig } from "@/lib/focus-unlock";
import { FocusUnlockError, readFocusConfig, resolveHabitNames, saveFocusConfig } from "@/lib/focus-unlock-server";

export const dynamic = "force-dynamic";

/**
 * /api/focus/config: which Onyx habits unlock the iPhone Focus block, and the rule
 * (pds.focus_unlock_config). Owner session only: this path is NOT in middleware's isCiRoute()
 * (only /api/focus/unlock-status is), so the phone's token cannot read or change the settings.
 *
 * GET  -> { rule, habit_page_ids, chosen: [{ id, name }] }
 * PUT  { rule: "or" | "and", habit_page_ids: string[] } -> the same shape. Same-origin, JSON, at most
 *      1 KB, at most 10 habits, and every id must be a habit in pds.habit_name_map.
 */

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
  auth: { persistSession: false, autoRefreshToken: false },
});

const noStore = { "Cache-Control": "no-store" };

async function describe(config: FocusUnlockConfig) {
  const names = await resolveHabitNames(supabase, config.habitPageIds);
  return {
    rule: config.rule,
    habit_page_ids: config.habitPageIds,
    chosen: config.habitPageIds.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id) as string })),
  };
}

function failed(e: unknown) {
  const step = e instanceof FocusUnlockError ? e.step : "unexpected";
  console.error("focus config failed:", step);
  return NextResponse.json({ error: "could not load or save the Focus settings", step }, { status: 500, headers: noStore });
}

export async function GET() {
  try {
    return NextResponse.json(await describe(await readFocusConfig(supabase)), { headers: noStore });
  } catch (e) {
    return failed(e);
  }
}

export async function PUT(req: NextRequest) {
  const refused = checkConfigWrite(req.headers, req.nextUrl.origin);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "could not read body" }, { status: 400 });
  }
  if (text.length > MAX_FOCUS_CONFIG_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = parseConfigBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const saved = await saveFocusConfig(supabase, parsed.value);
    if (!saved.ok) return NextResponse.json({ error: "a chosen habit is not a habit Onyx knows" }, { status: 400 });
    return NextResponse.json(await describe(saved.config), { headers: noStore });
  } catch (e) {
    return failed(e);
  }
}
