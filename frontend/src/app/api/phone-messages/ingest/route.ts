import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { isFlagOn, PHONE_MESSAGES_FLAG } from "@/lib/phone-messages";
import { parseAllowList, parseIngestBody, RETENTION_DAYS } from "@/lib/phone-messages-ingest";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 96 * 1024;
const DAY_MS = 86_400_000;

/**
 * POST /api/phone-messages/ingest   (CI token: an exact path in middleware isCiRoute)
 *
 * Receives texts pushed by Riley's own Shortcuts automation (Message trigger):
 * { sender, text, received_at? } or { messages: [...] } (at most 20). iOS has no API
 * to read the existing inbox, so this is the only source: new texts the automation is
 * scoped to, from the moment Riley builds it. Setup and limits:
 * docs/iphone-messages-disabled-design.md ("Shortcuts push").
 *
 * OFF unless ONYX_PHONE_MESSAGES_ENABLED is exactly "true": then it answers 503
 * `disabled` before touching the database. Optional ONYX_PHONE_MESSAGES_SENDERS
 * (comma separated numbers or names) restricts accepted senders further. One-time /
 * verification codes are dropped, never stored. Rows are service-role only, kept 90
 * days (older rows are deleted here on each push). A repeat of the same text is
 * ignored. Answers counts only; message text is never logged, echoed or put in the
 * heartbeat (`phone_messages|push`).
 */
export async function POST(req: NextRequest) {
  if (!isFlagOn(process.env, PHONE_MESSAGES_FLAG)) {
    return NextResponse.json({ error: "disabled" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const startedAt = new Date();
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
  });

  const heartbeat = async (status: "success" | "partial" | "failed", records: number, error: string | null) => {
    const end = new Date();
    const { error: e } = await supabase.from("sync_log").insert({
      source: "phone_messages",
      data_type: "push",
      status,
      records_synced: records,
      sync_start: startedAt.toISOString(),
      sync_end: end.toISOString(),
      duration_seconds: Math.max(0, Math.round((end.getTime() - startedAt.getTime()) / 1000)),
      error_message: error,
    });
    if (e) console.error("phone_messages heartbeat failed:", e.code ?? "error");
  };
  const refuse = async (message: string, code: number) => {
    await heartbeat("failed", 0, `Rejected push: ${message}`);
    return NextResponse.json({ error: message, logged: true }, { status: code });
  };

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return refuse("Body too large", 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse("Body is not valid JSON", 400);
  }

  const nowMs = Date.now();
  const parsed = parseIngestBody(body, nowMs, parseAllowList(process.env.ONYX_PHONE_MESSAGES_SENDERS));
  if (!parsed.ok) return refuse(parsed.error, 400);

  const rows = parsed.items.map((m) => ({
    message_key: createHash("sha256").update(`${m.sender}|${m.receivedAt}|${m.text}`).digest("hex").slice(0, 32),
    sender: m.sender,
    body: m.text,
    received_at: m.receivedAt,
  }));
  const unique = [...new Map(rows.map((r) => [r.message_key, r])).values()];

  let stored = 0;
  if (unique.length > 0) {
    const { data, error } = await supabase
      .from("phone_messages")
      .upsert(unique, { onConflict: "message_key", ignoreDuplicates: true })
      .select("message_key");
    if (error) {
      console.error("phone_messages upsert failed:", error.code ?? "error");
      await heartbeat("failed", 0, `Database error ${error.code ?? ""}`.trim());
      return NextResponse.json({ error: "Could not store the texts", logged: true }, { status: 500 });
    }
    stored = data?.length ?? 0;
  }

  // Retention: best effort, never fails a push.
  const cutoff = new Date(nowMs - RETENTION_DAYS * DAY_MS).toISOString();
  const { error: purgeError } = await supabase.from("phone_messages").delete().lt("received_at", cutoff);
  if (purgeError) console.error("phone_messages purge failed:", purgeError.code ?? "error");

  await heartbeat(
    parsed.skippedInvalid > 0 ? "partial" : "success",
    stored,
    parsed.skippedInvalid > 0 ? `${parsed.skippedInvalid} text(s) in the last push could not be read` : null,
  );
  return NextResponse.json(
    {
      stored,
      duplicates: unique.length - stored,
      skipped_codes: parsed.skippedCodes,
      skipped_scope: parsed.skippedScope,
      skipped_invalid: parsed.skippedInvalid,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
