import { NextRequest, NextResponse } from "next/server";
import { parseRowId, parseSubscriptionInput } from "@/lib/procurement";
import { procurementDb } from "@/lib/procurement-db";
import { archiveSubscriptionRecord, failureResponse, updateSubscriptionRecord, type Db } from "@/lib/procurement-store";

export const dynamic = "force-dynamic";

// Session-protected by middleware.ts (owner account only). Records what Riley typed; contacts no provider.
function db(): Db | null {
  try { return procurementDb(); } catch { return null; }
}
const unconfigured = () => NextResponse.json({ persisted: false, setupPending: false, error: "Saving is not configured on this deploy." }, { status: 503 });
const badId = () => NextResponse.json({ error: "Invalid subscription id." }, { status: 400 });

/** PATCH { name, amount, cycle, renewsOn, vendor?, notes? } replaces the fields of one active subscription. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = parseRowId((await params).id);
  if (id === null) return badId();
  let details;
  try { details = parseSubscriptionInput(await req.json()); }
  catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid subscription." }, { status: 400 }); }
  const client = db();
  if (!client) return unconfigured();
  const result = await updateSubscriptionRecord(client, id, details);
  if (!result.ok) { const r = failureResponse(result, false); return NextResponse.json(r.body, { status: r.status }); }
  return NextResponse.json({ persisted: true, subscription: result.value });
}

/** DELETE archives one subscription (is_active = false). Nothing is cancelled with any provider. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = parseRowId((await params).id);
  if (id === null) return badId();
  const client = db();
  if (!client) return unconfigured();
  const result = await archiveSubscriptionRecord(client, id);
  if (!result.ok) { const r = failureResponse(result, false); return NextResponse.json(r.body, { status: r.status }); }
  return NextResponse.json({ persisted: true, archived: result.value.archived });
}
