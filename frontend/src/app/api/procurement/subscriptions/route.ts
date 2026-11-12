import { NextRequest, NextResponse } from "next/server";
import { parseSubscriptionInput } from "@/lib/procurement";
import { procurementDb } from "@/lib/procurement-db";
import { archiveAllSubscriptions, createSubscriptionRecord, failureResponse, listSubscriptions, type Db } from "@/lib/procurement-store";

export const dynamic = "force-dynamic";

// Session-protected by middleware.ts (owner account only; this path is not a CI route).
// Records what Riley typed. Nothing here contacts a merchant, orders, pays or cancels.
function db(): Db | null {
  try { return procurementDb(); } catch { return null; }
}
const unconfigured = () => NextResponse.json({ persisted: false, setupPending: false, error: "Saving is not configured on this deploy." }, { status: 503 });

/** GET: the active subscriptions. If the table does not exist yet: 200 with persisted:false so the page works in memory. */
export async function GET() {
  const client = db();
  if (!client) return unconfigured();
  const result = await listSubscriptions(client);
  if (!result.ok) { const r = failureResponse(result, true); return NextResponse.json(r.body, { status: r.status }); }
  return NextResponse.json({ persisted: true, subscriptions: result.value });
}

/** POST { name, amount, cycle, renewsOn, vendor?, notes? } creates one subscription. */
export async function POST(req: NextRequest) {
  let details;
  try { details = parseSubscriptionInput(await req.json()); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid subscription." }, { status: 400 }); }
  const client = db();
  if (!client) return unconfigured();
  const result = await createSubscriptionRecord(client, details);
  if (!result.ok) { const r = failureResponse(result, false); return NextResponse.json(r.body, { status: r.status }); }
  return NextResponse.json({ persisted: true, subscription: result.value }, { status: 201 });
}

/** DELETE archives (hides) every active subscription. Soft delete: rows stay in the table. */
export async function DELETE() {
  const client = db();
  if (!client) return unconfigured();
  const result = await archiveAllSubscriptions(client);
  if (!result.ok) { const r = failureResponse(result, false); return NextResponse.json(r.body, { status: r.status }); }
  return NextResponse.json({ persisted: true, archived: result.value.archived });
}
