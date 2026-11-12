import { NextResponse, type NextRequest } from "next/server";
import { OWNER_USER_ID, startPunchout } from "@/lib/punchout";
import { loadSuppliers, supabaseStore } from "@/lib/punchout-store";

// Start a PunchOut session (owner login enforced by middleware.ts): create the session, send the cXML
// PunchOutSetupRequest to the supplier, answer with the supplier's StartPage for the browser to open.
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let key = "";
  try {
    const body = (await request.json()) as { supplier?: unknown };
    key = typeof body.supplier === "string" ? body.supplier : "";
  } catch {
    return NextResponse.json({ error: "Send JSON {\"supplier\": \"<key>\"}." }, { status: 400 });
  }
  const origin = request.nextUrl.origin;
  const supplier = loadSuppliers(origin).suppliers.find((s) => s.key === key);
  if (!supplier) return NextResponse.json({ error: "That supplier is not connected." }, { status: 404 });
  try {
    const result = await startPunchout({ store: supabaseStore(), fetchFn: fetch, now: new Date(), origin, supplier, ownerId: OWNER_USER_ID });
    if (!result.ok) {
      console.warn(`punchout start failed: supplier=${supplier.key} code=${result.code}`);
      return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
    }
    return NextResponse.json({ startPage: result.startPage }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.warn(`punchout start error: supplier=${supplier.key} ${e instanceof Error ? e.message.slice(0, 80) : "unknown"}`);
    return NextResponse.json({ error: "Could not start the PunchOut session." }, { status: 503 });
  }
}
