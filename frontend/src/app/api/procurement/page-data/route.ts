import { NextRequest, NextResponse } from "next/server";
import { loadDetectedSubscriptions } from "@/lib/procurement-recurring-server";
import { loadSubscriptionAdvice } from "@/lib/procurement-flags-server";
import { loadReorderSuggestions } from "@/lib/procurement-reorder-server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/procurement/page-data: exactly what app/procurement/page.tsx hands to ProcurementClient
// ({detected, advice, reorder}), for the /procurement section of the continuous scroll
// (app/procurement/FeedSection.tsx). Same server functions, same order as the page: the ledger and the
// order history are read in parallel, then the waste flags for what was detected. A part that failed is
// that part's own {state: "error", code} here too, like on the page.
// Owner session only: middleware is the gate and this path is NOT in its CI-token carve-out (only
// /api/procurement/renewals/claim is). GET only, same-origin, never cached by the browser or CDN, and
// /api/procurement is a memory-only key in the client cache (isSensitiveKey), so the answer never reaches
// the device's disk. Read-only: nothing is bought, paid, cancelled or written. No model reads it.
// Logs a code only (inside the loaders), never a merchant or an amount.
export async function GET(req: NextRequest) {
  // A same-origin GET carries no Origin header; Sec-Fetch-Site says which site caused it.
  const site = req.headers.get("Sec-Fetch-Site"); // Headers.get is case-insensitive
  if (site && site !== "same-origin") return NextResponse.json({ error: "cross_origin" }, { status: 403, headers: NO_STORE });
  try {
    const [detected, reorder] = await Promise.all([loadDetectedSubscriptions(), loadReorderSuggestions()]);
    const advice = detected.state === "ok" ? await loadSubscriptionAdvice(detected.subs) : null;
    return NextResponse.json({ detected, advice, reorder }, { headers: NO_STORE });
  } catch {
    console.error("[api/procurement/page-data] read failed");
    return NextResponse.json({ error: "procurement unavailable" }, { status: 500, headers: NO_STORE });
  }
}
