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

export interface DriftAlert {
  id: string | null;
  raisedAt: string;
  message: string;
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
  driftAlerts: DriftAlert[];
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

// Hours since a timestamp — used for enrichment cards (ReccoBeats, MusicBrainz)
// where the right "freshness" metric is when we last *ran* the enrichment,
// not when the data was last produced (no new tracks today = nothing to enrich,
// which is healthy, not stale).
function hoursSince(isoStr: string | null): number {
  if (!isoStr) return 9999;
  return Math.round((Date.now() - new Date(isoStr).getTime()) / 3_600_000);
}

function deriveStatus(
  syncEntry: Record<string, unknown> | null,
  lag: number
): "success" | "partial" | "failed" | "unknown" {
  if (!syncEntry && lag === 999) return "unknown";
  if (syncEntry?.status === "failed" || lag > 3) return "failed";
  if (syncEntry?.status === "partial" || lag > 1) return "partial";
  return "success";
}

// Enrichment subsystems (ReccoBeats audio features, MusicBrainz tags) are
// passive: they only do work when there's something new to enrich. If your
// listening was quiet for 3 days, the ETL still ran but enriched zero items —
// that's healthy, not stale. So freshness here is "when did the ETL last
// touch this subsystem" (sync_start), not data age.
function enrichmentSource({
  label,
  entry,
}: {
  label: string;
  entry: Record<string, unknown> | null;
}): SourceStatus {
  const lastSync = (entry?.sync_start as string) ?? null;
  const ageHours = hoursSince(lastSync);
  let status: SourceStatus["status"];
  if (entry?.status === "failed") status = "failed";
  else if (!entry) status = "unknown";
  else if (ageHours > 12) status = "failed";       // ETL should fire every 2h
  else if (ageHours > 4 || entry.status === "partial") status = "partial";
  else status = "success";
  return {
    label,
    lastSync,
    status,
    latestDataDate: null,           // not meaningful for enrichment cards
    daysLag: Math.floor(ageHours / 24),
    recordsSynced: (entry?.records_synced as number) ?? 0,
    durationSeconds: (entry?.duration_seconds as number) ?? null,
    errorMessage: (entry?.error_message as string) ?? null,
  };
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

    // Fetch latest data dates per source + drift alerts (last 7 days) in parallel
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const [garminRes, whoopRes, eightSleepRes, journalRes, habitsRes, mfpRes, hrvRes, spotifyRes, driftRes] = await Promise.all([
      supabase.from("garmin_daily_summary").select("calendar_date").order("calendar_date", { ascending: false }).limit(1),
      supabase.from("whoop_cycles").select("start_time").order("start_time", { ascending: false }).limit(1),
      supabase.from("eight_sleep_trends").select("calendar_date").order("calendar_date", { ascending: false }).limit(1),
      supabase.from("whoop_journal").select("cycle_date").order("cycle_date", { ascending: false }).limit(1),
      supabase.from("habit_journal").select("cycle_date").order("cycle_date", { ascending: false }).limit(1),
      supabase.from("myfitnesspal_nutrition").select("calendar_date").order("calendar_date", { ascending: false }).limit(1),
      supabase.from("hrv_predictions").select("prediction_date").eq("model", "xgboost").eq("horizon_days", 1).not("model_version", "like", "backtest%").order("prediction_date", { ascending: false }).limit(1),
      supabase.from("spotify_plays").select("played_date_et").order("played_date_et", { ascending: false }).limit(1),
      supabase
        .from("sync_log")
        .select("id, created_at, sync_start, error_message, source, data_type")
        .eq("data_type", "drift_alert")
        .gte("created_at", sevenDaysAgo)
        .order("created_at", { ascending: false })
        .limit(10),
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
    const habitsDate = habitsRes.data?.[0]?.cycle_date ?? null;
    const mfpDate = mfpRes.data?.[0]?.calendar_date ?? null;
    const hrvDate = hrvRes.data?.[0]?.prediction_date ?? null;
    const spotifyDate = spotifyRes.data?.[0]?.played_date_et ?? null;

    const garminEntry = latestBySrcType["garmin|full_sync"] ?? null;
    const whoopEntry = latestBySrcType["whoop|full_sync"] ?? null;
    const eightSleepEntry = latestBySrcType["eight_sleep|trends"] ?? null;
    const journalEntry = latestBySrcType["whoop|journal_email"] ?? null;
    const mfpEntry = latestBySrcType["myfitnesspal|nutrition"] ?? null;
    const spotifyEntry = latestBySrcType["spotify|plays"] ?? null;
    const reccobeatsEntry = latestBySrcType["reccobeats|audio_features"] ?? null;
    const musicbrainzEntry = latestBySrcType["musicbrainz|artist_tags"] ?? null;

    const garminLag = daysLag(garminDate);
    const whoopLag = daysLag(whoopDate);
    const eightSleepLag = daysLag(eightSleepDate);
    const journalLag = daysLag(journalDate);
    const habitsLag = daysLag(habitsDate);
    const mfpLag = daysLag(mfpDate);
    const hrvLag = daysLag(hrvDate);
    const spotifyLag = daysLag(spotifyDate);

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
      habits: {
        label: "Habits",
        lastSync: habitsDate,
        status: deriveStatus(null, habitsLag),
        latestDataDate: habitsDate,
        daysLag: habitsLag,
        recordsSynced: 0,
        durationSeconds: null,
        errorMessage: null,
      },
      myfitnesspal: {
        label: "MyFitnessPal",
        lastSync: (mfpEntry?.sync_start as string) ?? null,
        status: deriveStatus(mfpEntry, mfpLag),
        latestDataDate: mfpDate,
        daysLag: mfpLag,
        recordsSynced: (mfpEntry?.records_synced as number) ?? 0,
        durationSeconds: (mfpEntry?.duration_seconds as number) ?? null,
        errorMessage: (mfpEntry?.error_message as string) ?? null,
      },
      hrv_analysis: {
        label: "HRV Analysis",
        lastSync: hrvDate,
        status: deriveStatus(null, hrvLag),
        latestDataDate: hrvDate,
        daysLag: hrvLag,
        recordsSynced: 0,
        durationSeconds: null,
        errorMessage: null,
      },
      spotify: {
        label: "Spotify",
        lastSync: (spotifyEntry?.sync_start as string) ?? null,
        status: deriveStatus(spotifyEntry, spotifyLag),
        latestDataDate: spotifyDate,
        daysLag: spotifyLag,
        recordsSynced: (spotifyEntry?.records_synced as number) ?? 0,
        durationSeconds: (spotifyEntry?.duration_seconds as number) ?? null,
        errorMessage: (spotifyEntry?.error_message as string) ?? null,
      },
      reccobeats: enrichmentSource({
        label: "ReccoBeats",
        entry: reccobeatsEntry,
      }),
      musicbrainz: enrichmentSource({
        label: "MusicBrainz",
        entry: musicbrainzEntry,
      }),
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

    const driftAlerts: DriftAlert[] = (driftRes.data ?? []).map((r) => ({
      id: (r.id as string | null) ?? null,
      raisedAt: (r.created_at as string) ?? (r.sync_start as string) ?? new Date().toISOString(),
      message: (r.error_message as string) ?? "HRV model drift detected",
    }));

    return NextResponse.json({ sources, recentHistory, driftAlerts, fetchedAt: new Date().toISOString() } satisfies StatusResponse);
  } catch (err) {
    console.error("Status API error:", err);
    return NextResponse.json({ error: "Failed to fetch status" }, { status: 500 });
  }
}
