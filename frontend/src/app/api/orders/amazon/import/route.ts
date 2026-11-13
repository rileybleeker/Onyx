import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { MAX_AMAZON_BODY_BYTES, eventsFor, parseAmazonImport } from "@/lib/amazon-orders";

// POST /api/orders/amazon/import: the personal Amazon account's order list, read by the Kindle
// harvester on Riley's PC (tools/kindle_harvest/amazon-orders.mjs). Auth: middleware's CI-token
// carve-out (exact path, x-onyx-ci-token). Writes pds.online_order_events (insert-only: an event
// keeps its first-seen time) and one pds.sync_log heartbeat (amazon|orders) per call, success or
// failure. orders_email_etl.py folds the events into pds.online_orders on its next run.
// Body: {orders: [...], scanned, unparsed} or {error: "..."} (the harvester reporting a failure).

export const dynamic = "force-dynamic";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
  auth: { persistSession: false, autoRefreshToken: false },
});

async function heartbeat(startedAt: Date, status: "success" | "partial" | "failed", records: number, error: string | null) {
  const end = new Date();
  const { error: e } = await supabase.from("sync_log").insert({
    source: "amazon",
    data_type: "orders",
    sync_start: startedAt.toISOString(),
    sync_end: end.toISOString(),
    status,
    records_synced: records,
    error_message: error,
    duration_seconds: (end.getTime() - startedAt.getTime()) / 1000,
  });
  if (e) console.error("amazon orders heartbeat failed:", e.code);
}

export async function POST(req: NextRequest) {
  const startedAt = new Date();
  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "could not read body" }, { status: 400 });
  }
  if (text.length > MAX_AMAZON_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = parseAmazonImport(body);
  if (!parsed.ok) {
    await heartbeat(startedAt, "failed", 0, `rejected payload: ${parsed.error}`);
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  if (parsed.kind === "error") {
    await heartbeat(startedAt, "failed", 0, parsed.error);
    return NextResponse.json({ ok: true, logged: true });
  }
  const nowIso = new Date().toISOString();
  const rows = parsed.orders.flatMap((o) => eventsFor(o, nowIso));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from("online_order_events").upsert(rows.slice(i, i + 200), { onConflict: "message_id", ignoreDuplicates: true });
    if (error) {
      console.error("amazon orders write failed:", error.code);
      await heartbeat(startedAt, "failed", 0, `database write failed (${error.code || "unknown"})`);
      return NextResponse.json({ error: "could not save" }, { status: 500 });
    }
  }
  const note = parsed.unparsed ? `${parsed.unparsed} order card(s) could not be read (Amazon may have changed the page)` : null;
  await heartbeat(startedAt, note ? "partial" : "success", parsed.orders.length, note);
  return NextResponse.json({ ok: true, orders: parsed.orders.length, events: rows.length, unparsed: parsed.unparsed });
}
