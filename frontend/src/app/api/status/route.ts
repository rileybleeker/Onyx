import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

export interface SourceStatus {
  label: string;
  lastSync: string | null;
  status: "success" | "partial" | "failed" | "unknown";
  latestDataDate: string | null;
  daysLag: number;
  recordsSynced: number;
  durationSeconds: number | null;
  errorMessage: string | null;
}

export interface StatusResponse {
  sources: Record<string, SourceStatus>;
  recentHistory: Array<{
    source: string;
    data_type: string;
    sync_start: string;
    status: string;
    records_synced: number;
    duration_seconds: number | null;
    error_message: string | null;
  }>;
  fetchedAt: string;
}

function daysLag(dateStr: string | null): number {
  if (!dateStr) return 999;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + (dateStr.includes("T") ? "" : "T00:00:00"));
  d.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - d.getTime()) / 86400000);
}

function deriveStatus(
  syncEntry: Record<string, unknown> | null,
  lag: number
): "success" | "partial" | "failed" | "unknown" {
  if (!syncEntry) return "unknown";
  if (syncEntry.status === "failed" || lag > 3) return "failed";
  if (syncEntry.status === "partial" || lag > 1) return "partial";
  return "success";
}

export async function GET() {
  try {
    // Fetch last 100 sync_log rows (enough to cover all sources with history)
    const { data: syncRows, error: syncErr } = await supabase
      .from("sync_log")
      .select("*")
      .order("sync_start", { ascending: false })
      .limit(100);

    if (syncErr) throw syncErr;

    // Fetch latest data dates per source in parallel
    const [garminRes, whoopRes, eightSleepRes, journalRes] = await Promise.all([
      supabase.from("garmin_daily_summary").select("calendar_date").order("calendar_date", { ascending: false }).limit(1),
      supabase.from("whoop_cycles").select("start_time").order("start_time", { ascending: false }).limit(1),
      supabase.from("eight_sleep_trends").select("calendar_date").order("calendar_date", { ascending: false }).limit(1),
      supabase.from("whoop_journal").select("cycle_date").order("cycle_date", { ascending: false }).limit(1),
    ]);

    // Find the latest sync entry per (source, data_type) key
    const latestBySrcType: Record<string, Record<string, unknown>> = {};
    for (const row of (syncRows ?? [])) {
      const key = `${row.source}|${row.data_type}`;
      if (!latestBySrcType[key]) {
        latestBySrcType[key] = row as Record<string, unknown>;
      }
    }

    const garminDate = garminRes.data?.[0]?.calendar_date ?? null;
    const whoopDate = whoopRes.data?.[0]?.start_time?.split("T")[0] ?? null;
    const eightSleepDate = eightSleepRes.data?.[0]?.calendar_date ?? null;
    const journalDate = journalRes.data?.[0]?.cycle_date ?? null;

    const garminEntry = latestBySrcType["garmin|full_sync"] ?? null;
    const whoopEntry = latestBySrcType["whoop|full_sync"] ?? null;
    const eightSleepEntry = latestBySrcType["eight_sleep|trends"] ?? null;
    const journalEntry = latestBySrcType["whoop|journal_email"] ?? null;

    const garminLag = daysLag(garminDate);
    const whoopLag = daysLag(whoopDate);
    const eightSleepLag = daysLag(eightSleepDate);
    const journalLag = daysLag(journalDate);

    const sources: Record<string, SourceStatus> = {
      garmin: {
        label: "Garmin",
        lastSync: (garminEntry?.sync_start as string) ?? null,
        status: deriveStatus(garminEntry, garminLag),
        latestDataDate: garminDate,
        daysLag: garminLag,
        recordsSynced: (garminEntry?.records_synced as number) ?? 0,
        durationSeconds: (garminEntry?.duration_seconds as number) ?? null,
        errorMessage: (garminEntry?.error_message as string) ?? null,
      },
      whoop: {
        label: "WHOOP",
        lastSync: (whoopEntry?.sync_start as string) ?? null,
        status: deriveStatus(whoopEntry, whoopLag),
        latestDataDate: whoopDate,
        daysLag: whoopLag,
        recordsSynced: (whoopEntry?.records_synced as number) ?? 0,
        durationSeconds: (whoopEntry?.duration_seconds as number) ?? null,
        errorMessage: (whoopEntry?.error_message as string) ?? null,
      },
      eight_sleep: {
        label: "Eight Sleep",
        lastSync: (eightSleepEntry?.sync_start as string) ?? null,
        status: deriveStatus(eightSleepEntry, eightSleepLag),
        latestDataDate: eightSleepDate,
        daysLag: eightSleepLag,
        recordsSynced: (eightSleepEntry?.records_synced as number) ?? 0,
        durationSeconds: (eightSleepEntry?.duration_seconds as number) ?? null,
        errorMessage: (eightSleepEntry?.error_message as string) ?? null,
      },
      whoop_journal: {
        label: "WHOOP Journal",
        lastSync: (journalEntry?.sync_start as string) ?? null,
        status: deriveStatus(journalEntry, journalLag),
        latestDataDate: journalDate,
        daysLag: journalLag === 999 ? 999 : journalLag,
        recordsSynced: (journalEntry?.records_synced as number) ?? 0,
        durationSeconds: (journalEntry?.duration_seconds as number) ?? null,
        errorMessage: (journalEntry?.error_message as string) ?? null,
      },
    };

    const recentHistory = (syncRows ?? []).slice(0, 20).map((r) => ({
      source: r.source,
      data_type: r.data_type,
      sync_start: r.sync_start,
      status: r.status,
      records_synced: r.records_synced,
      duration_seconds: r.duration_seconds,
      error_message: r.error_message,
    }));

    return NextResponse.json({ sources, recentHistory, fetchedAt: new Date().toISOString() } satisfies StatusResponse);
  } catch (err) {
    console.error("Status API error:", err);
    return NextResponse.json({ error: "Failed to fetch status" }, { status: 500 });
  }
}
