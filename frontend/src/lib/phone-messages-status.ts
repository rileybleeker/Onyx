import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

/**
 * /status card for the iPhone Messages push (heartbeat `phone_messages|push`).
 * The source is event driven (a Shortcuts automation on the phone), so a quiet
 * stretch is healthy and age never turns the card red: it is "unknown" until the
 * first push, "success" after a good push and "failed" only when the newest push
 * was refused or errored. A "partial" push (texts that could not be read) is degraded.
 * The heartbeat text is a fixed phrase and never carries message content.
 */
export async function getPhoneMessagesStatusCard(client: Supa, now: Date = new Date()) {
  const { data, error } = await client
    .from("sync_log")
    .select("sync_start,status,records_synced,duration_seconds,error_message")
    .eq("source", "phone_messages")
    .eq("data_type", "push")
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
      : entry.status === "failed" || entry.status === "error"
        ? "failed"
        : entry.status === "partial"
          ? "partial"
          : "success";
  return {
    label: "iPhone Messages",
    lastSync: entry?.sync_start ?? null,
    status,
    latestDataDate: entry?.sync_start ? String(entry.sync_start).slice(0, 10) : null,
    daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
    recordsSynced: entry?.records_synced ?? 0,
    durationSeconds: entry?.duration_seconds ?? null,
    errorMessage: error ? "Could not read the heartbeat" : (entry?.error_message ?? null),
  };
}
