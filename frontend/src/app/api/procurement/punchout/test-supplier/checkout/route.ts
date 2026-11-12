import { type NextRequest } from "next/server";
import { autoPostHtml, messagePage, TEST_CATALOG, testSupplierCheckout, testSupplierSecret } from "@/lib/punchout";

// The synthetic test supplier's "return cart" step (behind the owner login like any Onyx page): turns the
// chosen quantities into a real cXML PunchOutOrderMessage and posts it to the buyer's BrowserFormPost URL.
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const secret = testSupplierSecret(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!secret) return messagePage("Test supplier unavailable", "The test supplier is not configured on this server.", 503);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return messagePage("Form not readable", "The test supplier form could not be read.", 400);
  }
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };
  const quantities: Record<string, string | null> = {};
  for (const item of TEST_CATALOG) quantities[item.partId] = str(`qty_${item.partId}`);
  const result = testSupplierCheckout({ s: str("s"), action: str("action"), quantities }, { secret, origin: request.nextUrl.origin, now: new Date() });
  if (!result.ok) return messagePage("Test supplier", result.message, result.status);
  return new Response(autoPostHtml(result.returnUrl, result.cxml), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
