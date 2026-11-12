import { type NextRequest } from "next/server";
import { MAX_CXML_BYTES } from "@/lib/cxml";
import { handleTestSupplierSetup, testSupplierSecret } from "@/lib/punchout";

// The synthetic test supplier's cXML setup endpoint (labelled "Test supplier (synthetic)"; not a merchant).
// Called server-to-server by /api/procurement/punchout/start without an Onyx session, so middleware.ts
// lets this exact path through; it authenticates the cXML Sender SharedSecret like a real supplier.
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const secret = testSupplierSecret(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!secret) return new Response("not configured", { status: 503 });
  const text = await request.text();
  if (text.length > MAX_CXML_BYTES) return new Response("too large", { status: 413 });
  const { status, body } = handleTestSupplierSetup(text, { secret, origin: request.nextUrl.origin, now: new Date() });
  return new Response(body, { status, headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" } });
}
