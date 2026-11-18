import { NextResponse } from "next/server";
import { loadUpdateStatus } from "@/lib/iphone-update-server";

export const dynamic = "force-dynamic";

// GET /api/iphone/update-status: { status: UpdateStatus | null } for Today's "iPhone app update ready" card.
// Owner session only (middleware; NOT a CI route). Read-only, no-store: it writes and marks nothing.
export async function GET() {
  const status = await loadUpdateStatus();
  return NextResponse.json({ status }, { headers: { "Cache-Control": "no-store" } });
}
