import { NextRequest, NextResponse } from "next/server";
import { MAX_MARK_BODY_BYTES, checkMarkRequest, parseMarkBody, parseOrderKey } from "@/lib/online-orders";
import { ordersDb } from "@/lib/online-orders-server";

// PATCH /api/orders/[key]   body {action: "received" | "hide" | "undo"}
// Riley's one-tap answer for one order on /orders: "Got it" (it arrived), "Hide" (not an order to
// track) or "Undo". Owner session only (middleware; this path is not in the CI carve-out). Writes
// pds.online_order_marks only: the answer is stored under the order's current key and replaces any
// answer stored under its other aliases. pds.online_orders is never written here (the ETL rebuilds
// it every run). 404 for an order key that does not exist.

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key: raw } = await params;
  const key = parseOrderKey(raw);
  if (!key) return NextResponse.json({ error: "invalid order key" }, { status: 400 });

  const refused = checkMarkRequest(req.headers, req.nextUrl.origin);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "could not read body" }, { status: 400 });
  }
  if (text.length > MAX_MARK_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = parseMarkBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const db = ordersDb();
  // Found by ANY alias: a page left open across an ETL run may hold a key the order no longer has
  // as its main key (a later email linked it to an order number); aliases keep every old key.
  const { data: rows, error: readErr } = await db.from("online_orders").select("order_key,aliases")
    .contains("aliases", [key]).order("order_key", { ascending: true }).limit(1);
  if (readErr) {
    console.error("order mark lookup failed:", readErr.code);
    return NextResponse.json({ error: "could not save" }, { status: 500 });
  }
  const order = rows?.[0];
  if (!order || typeof order.order_key !== "string") return NextResponse.json({ error: "order not found" }, { status: 404 });
  const current: string = order.order_key;
  const aliases = (Array.isArray(order.aliases) ? order.aliases : []).filter((a: unknown): a is string => typeof a === "string");
  const others = [...new Set([...aliases, key])].filter((a) => a !== current);
  const now = new Date().toISOString();

  if (parsed.action !== "undo") {
    const { error } = await db.from("online_order_marks").upsert({
      alias_key: current,
      received_at: parsed.action === "received" ? now : null,
      hidden: parsed.action === "hide",
      updated_at: now,
    }, { onConflict: "alias_key" });
    if (error) {
      console.error("order mark save failed:", error.code);
      return NextResponse.json({ error: "could not save" }, { status: 500 });
    }
  }
  const clear = parsed.action === "undo" ? [current, ...others] : others;
  if (clear.length) {
    const { error } = await db.from("online_order_marks").delete().in("alias_key", clear);
    if (error) {
      console.error("order mark clear failed:", error.code);
      return NextResponse.json({ error: "could not save" }, { status: 500 });
    }
  }
  return NextResponse.json({ key: current, action: parsed.action, at: now });
}
