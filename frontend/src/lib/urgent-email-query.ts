import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assessEmail,
  daysUntilDeadline,
  etDayLabel,
  gmailMessageHref,
  gmailThreadHref,
} from "@/lib/urgent-email";

// The client passed in MUST be scoped to schema "pds" (service role), like lib/reading.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

/**
 * Read-only query behind GET /api/urgent-email.
 *
 * Source: pds.inbox_emails (sql/inbox_emails_schema.sql), filled hourly by
 * urgent_email_etl.py with the metadata of the messages inbox-triage labelled
 * Agent/Action or Agent/Deadline in either Gmail account. The labels are the
 * urgency decision; this adds the reason, any deadline the subject/snippet names,
 * and the next step, and drops what is no longer worth showing:
 *   - archived threads (out of the inbox = handled);
 *   - Agent/Action older than ACTION_DAYS;
 *   - Agent/Deadline whose date has passed, is more than DEADLINE_AHEAD_DAYS out,
 *     or (no readable date) that arrived more than UNDATED_DEADLINE_DAYS ago.
 * One item per Gmail thread. The snippet never leaves the server.
 * Until the table exists this reports `not_connected`, a normal answer, not an error.
 */

export type AgentLabel = "Agent/Action" | "Agent/Deadline";

export interface UrgentEmailItem {
  /** "thread:<account>:<gmail thread id>" or "msg:<account>:<Message-ID>": one item per thread. */
  key: string;
  threadId: string | null;
  messageId: string;
  account: string;
  from: string;
  subject: string;
  receivedAt: string;
  /** When the email job last saw this thread still labelled. */
  lastSeenAt: string | null;
  labels: AgentLabel[];
  unread: boolean;
  deadline: { daysLeft: number; label: string } | null;
  /** Why it is shown, strongest first. */
  reasons: string[];
  nextStep: string;
  /** Gmail link to the thread, or null when no usable id. */
  href: string | null;
}

export interface UrgentEmailSync {
  at: string;
  status: string;
  error: string | null;
}

export type UrgentEmailResponse =
  | { status: "not_connected" }
  | {
      status: "ready";
      windowDays: number;
      /** Labelled threads in the window that were checked. */
      scanned: number;
      /** Threads worth showing (items is the bounded top of these). */
      total: number;
      /** Labelled threads left out (archived, old, or deadline passed). */
      hidden: number;
      /** Newest urgent_email|labels heartbeat; null before the first run. */
      lastSync: UrgentEmailSync | null;
      items: UrgentEmailItem[];
    };

/** Most rows read per request: a hard bound on work and payload. */
export const SCAN_LIMIT = 300;
/** Items returned (Today merges them with the Agent Inbox, then shows the top 5). */
export const ITEMS_RETURNED = 20;
export const WINDOW_DAYS = 30;
export const ACTION_DAYS = 14;
export const DEADLINE_AHEAD_DAYS = 7;
export const UNDATED_DEADLINE_DAYS = 3;
const SUBJECT_MAX = 140;
const FROM_MAX = 80;
const DAY_MS = 86_400_000;

// PostgREST says PGRST205 when the table is not in its schema cache; Postgres says 42P01.
// 42703 = a column is missing: the first version of the table without the label columns.
const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01", "42703"]);

interface Row {
  account: string | null;
  message_id: string | null;
  received_at: string | null;
  from_name: string | null;
  from_address: string | null;
  subject: string | null;
  snippet: string | null;
  is_unread: boolean | null;
  gmail_thread_id: string | null;
  agent_labels: string[] | null;
  in_inbox: boolean | null;
  last_seen_at: string | null;
}

interface Thread {
  key: string;
  newest: Row;
  rows: Row[];
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const time = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);

function labelsOf(rows: Row[]): AgentLabel[] {
  const set = new Set<AgentLabel>();
  for (const r of rows) for (const l of r.agent_labels ?? []) if (l === "Agent/Action" || l === "Agent/Deadline") set.add(l);
  return (["Agent/Action", "Agent/Deadline"] as const).filter((l) => set.has(l));
}

/** Earliest deadline still ahead across the thread's labelled messages, else the latest passed one. */
function threadDeadline(rows: Row[], now: Date): number | null {
  const found: number[] = [];
  for (const r of rows) {
    const received = new Date(r.received_at ?? "");
    if (Number.isNaN(received.getTime())) continue;
    const days = daysUntilDeadline(`${r.subject ?? ""} ${r.snippet ?? ""}`, received, now);
    if (days !== null) found.push(days);
  }
  if (found.length === 0) return null;
  const ahead = found.filter((d) => d >= 0);
  return ahead.length > 0 ? Math.min(...ahead) : Math.max(...found);
}

function deadlineReason(days: number, label: string): string {
  if (days === 0) return `Deadline today (${label})`;
  if (days === 1) return `Deadline tomorrow (${label})`;
  return `Deadline in ${days} days (${label})`;
}

/** Decide whether a labelled thread is shown, and say why. Pure. */
export function describeThread(thread: Thread, now: Date): UrgentEmailItem | null {
  const { newest, rows } = thread;
  const labels = labelsOf(rows);
  if (labels.length === 0) return null;
  if (!rows.some((r) => r.in_inbox !== false)) return null;   // archived: handled
  const ageDays = (now.getTime() - time(newest.received_at)) / DAY_MS;
  if (!Number.isFinite(ageDays)) return null;
  const days = labels.includes("Agent/Deadline") ? threadDeadline(rows, now) : null;
  const deadline = days !== null && days >= 0 && days <= DEADLINE_AHEAD_DAYS ? { daysLeft: days, label: etDayLabel(now, days) } : null;
  const showAction = labels.includes("Agent/Action") && ageDays <= ACTION_DAYS;
  const showDeadline = labels.includes("Agent/Deadline") && (deadline !== null || (days === null && ageDays <= UNDATED_DEADLINE_DAYS));
  if (!showAction && !showDeadline) return null;

  const reasons: string[] = [];
  if (deadline) reasons.push(deadlineReason(deadline.daysLeft, deadline.label));
  else if (showDeadline) reasons.push("inbox-triage marked it Agent/Deadline (a date matters)");
  if (labels.includes("Agent/Action")) reasons.push("inbox-triage marked it Agent/Action (needs a reply or decision)");
  const rules = assessEmail({
    id: newest.message_id ?? "", fromName: newest.from_name, fromAddress: newest.from_address ?? "",
    subject: newest.subject ?? "", snippet: newest.snippet, receivedAt: newest.received_at ?? "", isUnread: true,
  }, now);
  for (const r of rules.reasons) if (!r.startsWith("deadline") && reasons.length < 4) reasons.push(r);

  const nextStep = deadline
    ? deadline.daysLeft === 0 ? "Handle it today in Gmail" : `Handle it in Gmail by ${deadline.label}`
    : labels.includes("Agent/Action")
      ? "Reply or decide in Gmail (a draft reply may be waiting)"
      : "Open it in Gmail and check the date";

  const account = (newest.account ?? "").trim();
  const messageId = (newest.message_id ?? "").trim();
  return {
    key: thread.key,
    threadId: newest.gmail_thread_id,
    messageId,
    account,
    from: clip((newest.from_name?.trim() || newest.from_address || "").trim(), FROM_MAX),
    subject: clip((newest.subject ?? "").trim() || "(no subject)", SUBJECT_MAX),
    receivedAt: newest.received_at as string,
    lastSeenAt: rows.map((r) => r.last_seen_at).filter((x): x is string => !!x).sort().pop() ?? null,
    labels,
    unread: rows.some((r) => r.is_unread !== false),
    deadline,
    reasons,
    nextStep,
    href: gmailThreadHref(account, newest.gmail_thread_id) ?? (messageId ? gmailMessageHref(account, messageId) : null),
  };
}

/**
 * /status "Urgent Email" card (the source key is urgent_email): freshness = age of the newest
 * urgent_email|labels heartbeat, read with its own limit-1 query so the shared 100-row
 * sync_log window cannot hide it. The job runs hourly: >3 h degraded, >8 h or a failed run
 * red. A 'partial' run (an account failed or is not configured, a label is missing) is
 * degraded. "unknown" until the first run, which needs sql/inbox_emails_schema.sql applied.
 */
export async function getUrgentEmailStatusCard(client: Supa, now: Date = new Date()) {
  const { data, error } = await client
    .from("sync_log")
    .select("sync_start,status,records_synced,duration_seconds,error_message")
    .eq("source", "urgent_email")
    .eq("data_type", "labels")
    .order("sync_start", { ascending: false })
    .limit(1);
  const entry = (error ? null : data?.[0]) as
    | { sync_start: string; status: string; records_synced: number | null; duration_seconds: number | null; error_message: string | null }
    | undefined;
  const ageH = entry?.sync_start ? (now.getTime() - new Date(entry.sync_start).getTime()) / 3_600_000 : Infinity;
  const status: "success" | "partial" | "failed" | "unknown" = error
    ? "failed"
    : !entry
      ? "unknown"
      : entry.status === "failed" || entry.status === "error" || ageH > 8
        ? "failed"
        : entry.status === "partial" || ageH > 3
          ? "partial"
          : "success";
  return {
    label: "Urgent Email",
    lastSync: entry?.sync_start ?? null,
    status,
    latestDataDate: entry?.sync_start ? String(entry.sync_start).slice(0, 10) : null,
    daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
    recordsSynced: entry?.records_synced ?? 0,
    durationSeconds: entry?.duration_seconds ?? null,
    errorMessage: error?.message
      ?? entry?.error_message
      ?? (entry && ageH > 8 ? `No label sync for ${Math.floor(ageH)}h - check the Urgent Email Labels workflow.` : null),
  };
}

function rank(item: UrgentEmailItem): number {
  if (item.deadline) return item.deadline.daysLeft;          // 0..7
  return item.labels.includes("Agent/Action") ? 8 : 9;
}

export async function getUrgentEmail(client: Supa, now: Date = new Date()): Promise<UrgentEmailResponse> {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const [emails, sync] = await Promise.all([
    client
      .from("inbox_emails")
      .select("account,message_id,received_at,from_name,from_address,subject,snippet,is_unread,gmail_thread_id,agent_labels,in_inbox,last_seen_at")
      .eq("labeled", true)
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .order("message_id", { ascending: true })
      .limit(SCAN_LIMIT),
    client
      .from("sync_log")
      .select("sync_start,status,error_message")
      .eq("source", "urgent_email")
      .eq("data_type", "labels")
      .order("sync_start", { ascending: false })
      .limit(1),
  ]);

  if (emails.error) {
    if (MISSING_TABLE_CODES.has(emails.error.code)) return { status: "not_connected" };
    throw new Error(`inbox_emails query failed (${emails.error.code || "unknown"})`);
  }
  // A failed heartbeat read only loses the "synced at" line; the items are still valid.
  const beat = sync.error ? null : (sync.data?.[0] as { sync_start?: string; status?: string; error_message?: string | null } | undefined);
  const lastSync = beat?.sync_start ? { at: beat.sync_start, status: beat.status ?? "unknown", error: beat.error_message ?? null } : null;

  const threads = new Map<string, Thread>();
  for (const row of (emails.data ?? []) as Row[]) {
    if (!row || typeof row.received_at !== "string" || Number.isNaN(time(row.received_at)) || typeof row.from_address !== "string") continue;
    const account = (row.account ?? "").trim().toLowerCase();
    // Thread ids are per mailbox, so the key carries the account too. The same message in
    // both mailboxes is two threads here; Today folds them by Message-ID (mergeUrgent).
    const key = row.gmail_thread_id && /^\d+$/.test(row.gmail_thread_id)
      ? `thread:${account}:${row.gmail_thread_id}`
      : `msg:${account}:${(row.message_id ?? "").trim()}`;
    const t = threads.get(key);
    if (!t) threads.set(key, { key, newest: row, rows: [row] });
    else {
      t.rows.push(row);
      if (time(row.received_at) > time(t.newest.received_at)) t.newest = row;
    }
  }

  const shown: UrgentEmailItem[] = [];
  for (const t of threads.values()) {
    const item = describeThread(t, now);
    if (item) shown.push(item);
  }
  shown.sort((a, b) => rank(a) - rank(b) || time(b.receivedAt) - time(a.receivedAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    status: "ready",
    windowDays: WINDOW_DAYS,
    scanned: threads.size,
    total: shown.length,
    hidden: threads.size - shown.length,
    lastSync,
    items: shown.slice(0, ITEMS_RETURNED),
  };
}
