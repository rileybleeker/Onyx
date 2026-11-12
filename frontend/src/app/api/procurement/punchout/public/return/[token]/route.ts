import { type NextRequest } from "next/server";
import { MAX_CXML_BYTES } from "@/lib/cxml";
import { acceptReturn, cxmlFromForm, messagePage } from "@/lib/punchout";
import { supabaseStore } from "@/lib/punchout-store";

// The supplier's BrowserFormPost target. Cross-site, so no Onyx session cookie arrives: middleware.ts lets
// exactly this path shape through and the single-use, expiring secret in the URL authenticates it
// (lib/punchout.ts acceptReturn). On success the browser is sent (303) to the signed-in review page.
export const dynamic = "force-dynamic";

const LIMIT = MAX_CXML_BYTES * 2 + 4096; // url-encoding can double the size

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > LIMIT) return messagePage("Cart too large", "The supplier sent a cart over the size limit.", 413);
  let form: URLSearchParams | FormData;
  try {
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("multipart/form-data")) {
      form = await request.formData();
    } else {
      const text = await request.text();
      if (text.length > LIMIT) return messagePage("Cart too large", "The supplier sent a cart over the size limit.", 413);
      form = new URLSearchParams(text);
    }
  } catch {
    return messagePage("Cart not readable", "The supplier's post could not be read.", 400);
  }
  let result;
  try {
    result = await acceptReturn({ store: supabaseStore(), now: new Date() }, token, cxmlFromForm(form));
  } catch (e) {
    console.warn(`punchout return error: ${e instanceof Error ? e.message.slice(0, 80) : "unknown"}`);
    return messagePage("Cart not saved", "Onyx could not save the cart right now. Go back to the supplier and return the cart again.", 503);
  }
  if (result.kind === "error") {
    console.warn(`punchout return refused: code=${result.code}`);
    return messagePage("Cart not accepted", result.message, result.status);
  }
  const dest = new URL("/procurement/shop", request.nextUrl.origin);
  if (result.kind === "cart") dest.searchParams.set("cart", String(result.cartId));
  else dest.searchParams.set("cancelled", "1");
  return new Response(null, { status: 303, headers: { location: dest.toString(), "cache-control": "no-store" } });
}

export async function GET() {
  return messagePage("Nothing here", "This address only accepts a cart posted by a supplier.", 405);
}
