import { NextResponse } from "next/server";
import { createPhoneMessagesService } from "@/lib/phone-messages";

export const dynamic = "force-dynamic";

/**
 * GET /api/phone-messages/status
 *
 * Reports whether the iPhone Messages integration is switched on. It is OFF
 * unless ONYX_PHONE_MESSAGES_ENABLED is exactly "true", and even then no
 * adapter exists (iOS has no third-party API for the existing SMS/iMessage
 * inbox), so the answer is "no_supported_adapter". This route never creates an
 * adapter, reads a message, or sends one; it exposes no read/send endpoint.
 * Auth: browser session only (middleware default; deliberately not a CI route).
 * Design and limits: docs/iphone-messages-disabled-design.md.
 */
export async function GET() {
  const service = createPhoneMessagesService({ getEnv: () => process.env });
  return NextResponse.json(service.status(), { headers: { "Cache-Control": "no-store" } });
}
