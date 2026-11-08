import { revalidatePath, revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { NYC_LEADS_TAG, RILEY_DECISIONS, updateNycLead, type RileyDecision } from "@/lib/nyc";

const MAX_NOTE = 2000;

/**
 * PATCH /api/nyc/leads/[id] — Riley's decision on one lead.
 * Body: { riley?: 'New' | 'Interested' | 'Toured' | 'Passed', rileyNote?: string }
 * Writes only the Riley / Riley's note properties (the scout owns the rest)
 * and drops the ISR snapshot so the next /nyc load shows the change.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{32,36}$/i.test(id)) {
    return NextResponse.json({ error: "invalid lead id" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const patch: { riley?: RileyDecision; rileyNote?: string } = {};
  if ("riley" in body) {
    if (!RILEY_DECISIONS.includes(body.riley as RileyDecision)) {
      return NextResponse.json({ error: `riley must be one of ${RILEY_DECISIONS.join(", ")}` }, { status: 400 });
    }
    patch.riley = body.riley as RileyDecision;
  }
  if ("rileyNote" in body) {
    if (typeof body.rileyNote !== "string" || body.rileyNote.length > MAX_NOTE) {
      return NextResponse.json({ error: `rileyNote must be a string of at most ${MAX_NOTE} characters` }, { status: 400 });
    }
    patch.rileyNote = body.rileyNote.trim();
  }
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  try {
    const lead = await updateNycLead(id, patch);
    revalidateTag(NYC_LEADS_TAG);
    revalidatePath("/nyc");
    return NextResponse.json({ lead });
  } catch (e) {
    const message = (e as Error).message;
    return NextResponse.json({ error: message }, { status: message.includes("not in the NYC Leads") ? 403 : 502 });
  }
}
