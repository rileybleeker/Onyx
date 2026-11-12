import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FUTURE_SKEW_MS,
  MAX_URGENT_SHOWN,
  WINDOW_DAYS,
  gmailMessageHref,
  selectUrgent,
  type EmailForUrgency,
} from "@/lib/urgent-email";

// The client passed in MUST be scoped to schema "pds" (service role), like lib/reading.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

/**
 * Read-only query behind GET /api/urgent-email.
 *
 * Source: pds.inbox_emails (sql/inbox_emails_schema.sql), a metadata-only copy of recent
 * mail (sender, subject, a short snippet, unread flag). Nothing in Onyx writes that table
 * yet, so until the ingestion decision is made the table does not exist and this reports
 * `not_connected`. That state is a normal answer, not an error.
 */

export interface UrgentEmailItem {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
  reasons: string[];
  /** Gmail link to the message, or null when the row has no usable Message-ID. */
  href: string | null;
}

export type UrgentEmailResponse =
  | { status: "not_connected" }
  | {
      status: "ready";
      windowDays: number;
      /** Unread messages in the window that were checked. */
      scanned: number;
      /** Urgent messages found (items is the bounded top of these). */
      total: number;
      /** Receive time of the newest stored message (read or not), to show when the source has gone quiet. */
      newestReceivedAt: string | null;
      /** True when the scan hit its row cap, so older unread mail in the window was not checked. */
      truncated: boolean;
      items: UrgentEmailItem[];
    };

/** Most unread rows read per request: a hard bound on work and payload. */
export const SCAN_LIMIT = 200;
const SUBJECT_MAX = 140;
const FROM_MAX = 80;

// PostgREST says PGRST205 when the table is not in its schema cache; Postgres says 42P01.
const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01"]);

interface Row {
  email_id: number | string;
  account: string | null;
  message_id: string | null;
  received_at: string;
  from_name: string | null;
  from_address: string | null;
  subject: string | null;
  snippet: string | null;
  is_unread: boolean | null;
}

function newestReceived(data: unknown): string | null {
  const first = Array.isArray(data) ? (data[0] as { received_at?: unknown } | null | undefined) : null;
  return first && typeof first.received_at === "string" ? first.received_at : null;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const COLUMNS = "email_id,account,message_id,received_at,from_name,from_address,subject,snippet,is_unread";

export async function getUrgentEmail(client: Supa, now: Date = new Date()): Promise<UrgentEmailResponse> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  // Same upper bound selectUrgent applies. It is in the query too so a junk Date header
  // far in the future cannot sort to the top and use up the row cap.
  const until = new Date(now.getTime() + FUTURE_SKEW_MS).toISOString();
  // Read mail is excluded in the database, not afterwards, so a busy week of read mail
  // cannot push an unread "Final notice" past the row cap.
  const [main, newest] = await Promise.all([
    client
      .from("inbox_emails")
      .select(COLUMNS)
      .eq("is_unread", true)
      .gte("received_at", since)
      .lte("received_at", until)
      .order("received_at", { ascending: false })
      .limit(SCAN_LIMIT),
    // Freshness of the source regardless of read state: one tiny row.
    client
      .from("inbox_emails")
      .select("received_at")
      .lte("received_at", until)
      .order("received_at", { ascending: false })
      .limit(1),
  ]);

  for (const { error } of [main, newest]) {
    if (!error) continue;
    if (MISSING_TABLE_CODES.has(error.code)) return { status: "not_connected" };
    throw new Error(`inbox_emails query failed (${error.code || "unknown"})`);
  }
  const data = main.data;

  const rows = (data ?? []) as Row[];
  const byId = new Map<string, Row>();
  const emails: EmailForUrgency[] = [];
  for (const row of rows) {
    if (!row || typeof row.received_at !== "string" || typeof row.from_address !== "string") continue;
    const id = String(row.email_id);
    byId.set(id, row);
    emails.push({
      id,
      fromName: row.from_name,
      fromAddress: row.from_address,
      subject: row.subject ?? "",
      snippet: row.snippet,
      receivedAt: row.received_at,
      isUnread: row.is_unread !== false,
    });
  }

  const picked = selectUrgent(emails, now, MAX_URGENT_SHOWN);
  const items = picked.items.map(({ email, reasons }): UrgentEmailItem => {
    const row = byId.get(email.id)!;
    return {
      id: email.id,
      from: clip((email.fromName?.trim() || email.fromAddress).trim(), FROM_MAX),
      subject: clip(email.subject.trim() || "(no subject)", SUBJECT_MAX),
      receivedAt: email.receivedAt,
      reasons,
      href: row.message_id ? gmailMessageHref(row.account, row.message_id) : null,
    };
  });

  return {
    status: "ready",
    windowDays: WINDOW_DAYS,
    scanned: picked.scanned,
    total: picked.total,
    newestReceivedAt: newestReceived(newest.data),
    truncated: rows.length >= SCAN_LIMIT,
    items,
  };
}
