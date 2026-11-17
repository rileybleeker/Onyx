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
  // 2026-11-17: the one supported source is a Shortcuts automation on the phone that pushes new texts to
  // POST /api/phone-messages/ingest. That is a push endpoint, not an adapter, so `reason` above is unchanged.
  const enabled = process.env.ONYX_PHONE_MESSAGES_ENABLED === "true";
  return NextResponse.json(
    {
      ...service.status(),
      shortcutsPush: {
        ingestEnabled: enabled,
        senderAllowListSet: Boolean((process.env.ONYX_PHONE_MESSAGES_SENDERS ?? "").trim()),
        coverage: "new texts the phone automation sends; never the existing inbox",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
