import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

export type IntegrationMethod = "automated" | "semi-automated" | "manual";

export interface SourceStatus {
  label: string;
  lastSync: string | null;
  status: "success" | "partial" | "failed" | "unknown";
  latestDataDate: string | null;
  daysLag: number;
  recordsSynced: number;
  durationSeconds: number | null;
  errorMessage: string | null;
  cadence: string;
  integrationMethod: IntegrationMethod;
  methodLabel: string;
}

// Human-readable sync cadence per source. "Manual" means user-triggered;
// everything else is a GitHub Actions cron or workflow_run trigger.
const CADENCE: Record<string, string> = {
  garmin: "Hourly :00",
  whoop: "Hourly :00",
  eight_sleep: "Daily 3pm ET",
  whoop_journal: "Hourly :30 (IMAP)",
  habits: "Hourly :45",
  myfitnesspal: "Hourly :15 (IMAP)",
  // Predict: every hourly ETL + 23:50 ET (DST-gated). Retrain: hourly
  // conditional on backfill detection + daily 12:00 UTC unconditional
  // safety-net.
  hrv_analysis: "Predict: hourly + 23:50 ET · Retrain: hourly (cond.) + 12:00 UTC",
  spotify: "Every 2h :50",
  reccobeats: "With Spotify ETL",
  musicbrainz: "With Spotify ETL",
  supplements: "Manual",
  notion_journal: "Hourly :35",
  meals: "Manual",
  weight: "Manual",
};

// Integration method per source.
// - "automated":      cron pulls data autonomously from an API or third-party sync (no user step).
// - "semi-automated": cron import that depends on a user-triggered export from the source app
//                     (WHOOP and MFP have no API export — user must request CSV via web UI;
//                     IMAP cron then picks up the email and imports).
// - "manual":         data is entered directly by the user via the Onyx UI.
const METHOD: Record<string, { method: IntegrationMethod; label: string }> = {
  garmin:         { method: "automated",      label: "API ETL" },
  whoop:          { method: "automated",      label: "API ETL" },
  eight_sleep:    { method: "automated",      label: "API ETL" },
  whoop_journal:  { method: "semi-automated", label: "Email import" },
  habits:         { method: "automated",      label: "Notion sync" },
  myfitnesspal:   { method: "semi-automated", label: "Email import" },
  hrv_analysis:   { method: "automated",      label: "Computed" },
  spotify:        { method: "automated",      label: "API ETL" },
  reccobeats:     { method: "automated",      label: "API ETL" },
  musicbrainz:    { method: "automated",      label: "API ETL" },
  supplements:    { method: "manual",         label: "Manual entry" },
  notion_journal: { method: "automated",      label: "Notion sync" },
  meals:          { method: "manual",         label: "Manual entry" },
  weight:         { method: "manual",         label: "Manual entry" },
};

export interface DriftAlert {
  id: string | null;
  raisedAt: string;
  message: string;
}

// Per ADR-0001 drastic-TZ-abroad gap #3: rows from pds.tz_log_gaps —
// WHOOP cycles whose source-reported timezone_offset disagrees with what
// pds.tz_for_instant returns from user_tz_log. Each row = a day where Riley
// likely traveled but forgot to add a user_tz_log entry. /status renders a
// yellow banner so the gap surfaces within ~1h of the next ETL.
export interface TzGapRow {
  cycleId: string;
  gapEtDate: string;            // YYYY-MM-DD
  sourceOffset: string;          // e.g. '+02:00'
  logResolvedTz: string;         // e.g. 'America/New_York'
  deltaMinutes: number;          // source - log_resolved, signed
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
  tzGaps: TzGapRow[];
  fetchedAt: string;
}

// Per ADR-0001 Phase 3 step 5: freshness compares to the SPINE's most-recent
// date (= max calendar_date across all sources) instead of browser-local today.
// When Riley is in Berlin, the spine's freshest day is today-in-Berlin; an
// ET-anchored "today" would falsely report all sources as ~18h stale even
// though Garmin/WHOOP are real-time in Berlin local. Pass spineMaxDate from
// the GET handler; falls back to ET today if no spine signal yet.
function daysLag(dateStr: string | null, spineMaxDate: string | null = null): number {
  if (!dateStr) return 999;
  const reference = spineMaxDate
    ? new Date(spineMaxDate + (spineMaxDate.includes("T") ? "" : "T00:00:00"))
    : (() => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; })();
  reference.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + (dateStr.includes("T") ? "" : "T00:00:00"));
  d.setHours(0, 0, 0, 0);
  return Math.round((reference.getTime() - d.getTime()) / 86400000);
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
    cadence: "",                                          // overwritten in the sources map below
    integrationMethod: "automated",                       // overwritten in the merge step
    methodLabel: "",                                      // overwritten in the merge step
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
    const [garminRes, whoopRes, eightSleepRes, journalRes, habitsRes, mfpRes, hrvRes, spotifyRes, supplementsRes, notionJournalRes, mealsRes, weightRes, driftRes, tzGapsRes, hrvGapsRes] = await Promise.all([
      supabase.from("garmin_daily_summary").select("calendar_date").order("calendar_date", { ascending: false }).limit(1),
      supabase.from("whoop_cycles").select("start_time").order("start_time", { ascending: false }).limit(1),
      supabase.from("eight_sleep_trends").select("calendar_date").order("calendar_date", { ascending: false }).limit(1),
      supabase.from("whoop_journal").select("cycle_date").order("cycle_date", { ascending: false }).limit(1),
      supabase.from("habit_journal").select("cycle_date,synced_at").order("synced_at", { ascending: false }).limit(1),
      supabase.from("myfitnesspal_nutrition").select("calendar_date").order("calendar_date", { ascending: false }).limit(1),
      supabase.from("hrv_predictions").select("prediction_date").eq("model", "xgboost").eq("horizon_days", 1).not("model_version", "like", "backtest%").order("prediction_date", { ascending: false }).limit(1),
      supabase.from("spotify_plays").select("played_date_et").order("played_date_et", { ascending: false }).limit(1),
      // Manual sources: include the actual log timestamp so the "Last Sync"
      // row shows real-time "Xm ago" rather than midnight of the latest
      // entry date. created_at on supplement/meal/weight is the row insert
      // time; for weight the user-facing timestamp is updated_at on edits.
      supabase.from("supplement_intake").select("intake_date,created_at").order("intake_time", { ascending: false }).limit(1),
      supabase.from("journal_entries").select("entry_date").eq("archived", false).order("entry_date", { ascending: false }).limit(1),
      supabase.from("meal_events").select("event_date,created_at").order("event_time", { ascending: false }).limit(1),
      supabase.from("weight_log").select("log_date,updated_at").order("log_date", { ascending: false }).limit(1),
      supabase
        .from("sync_log")
        .select("id, created_at, sync_start, error_message, source, data_type")
        .eq("data_type", "drift_alert")
        .gte("created_at", sevenDaysAgo)
        .order("created_at", { ascending: false })
        .limit(10),
      // ADR-0001 drastic-TZ-abroad gap #3: WHOOP cycles whose offset disagrees
      // with the user_tz_log lookup. Filter to gap_type='travel' so DST-
      // artifact rows (single NY DST-transition nights) don't surface as
      // false-positive "Travel detected" banner entries. DST rows remain
      // in the view for analytical queries that want them.
      supabase
        .from("tz_log_gaps")
        .select("cycle_id, gap_et_date, source_offset, log_resolved_tz, delta_minutes")
        .eq("gap_type", "travel")
        .order("gap_et_date", { ascending: false })
        .limit(50),
      // HRV prediction drift monitor — any expected_date in the last 30 days
      // where no live xgboost forecast was written. Backtest fills don't
      // count. Empty array = healthy.
      supabase
        .from("hrv_prediction_gaps")
        .select("expected_date, gap_type")
        .order("expected_date", { ascending: false }),
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
    const habitsLastLog = (habitsRes.data?.[0]?.synced_at as string | undefined) ?? null;
    const mfpDate = mfpRes.data?.[0]?.calendar_date ?? null;
    const hrvDate = hrvRes.data?.[0]?.prediction_date ?? null;
    const spotifyDate = spotifyRes.data?.[0]?.played_date_et ?? null;
    const supplementsDate = supplementsRes.data?.[0]?.intake_date ?? null;
    const supplementsLastLog = (supplementsRes.data?.[0]?.created_at as string | undefined) ?? null;
    const notionJournalDate = notionJournalRes.data?.[0]?.entry_date ?? null;
    const mealsDate = mealsRes.data?.[0]?.event_date ?? null;
    const mealsLastLog = (mealsRes.data?.[0]?.created_at as string | undefined) ?? null;
    const weightDate = weightRes.data?.[0]?.log_date ?? null;
    const weightLastLog = (weightRes.data?.[0]?.updated_at as string | undefined) ?? null;

    // Per ADR-0001 Phase 3 step 5: anchor freshness to the spine's most-recent
    // date (max across all sources), not browser-local today. When Riley is
    // abroad, the freshest day in his lived timeline IS today-in-his-current-TZ.
    // An ET-anchored "today" would falsely report all sources ~18h stale.
    const spineMaxDate = [garminDate, whoopDate, eightSleepDate, mfpDate, hrvDate, spotifyDate]
      .filter((d): d is string => typeof d === "string")
      .sort()
      .pop() ?? null;

    const garminEntry = latestBySrcType["garmin|full_sync"] ?? null;
    const whoopEntry = latestBySrcType["whoop|full_sync"] ?? null;
    const eightSleepEntry = latestBySrcType["eight_sleep|trends"] ?? null;
    const journalEntry = latestBySrcType["whoop|journal_email"] ?? null;
    const mfpEntry = latestBySrcType["myfitnesspal|nutrition"] ?? null;
    const spotifyEntry = latestBySrcType["spotify|plays"] ?? null;
    const reccobeatsEntry = latestBySrcType["reccobeats|audio_features"] ?? null;
    const musicbrainzEntry = latestBySrcType["musicbrainz|artist_tags"] ?? null;
    const notionJournalEntry = latestBySrcType["notion_journal|entries"] ?? null;

    const garminLag = daysLag(garminDate, spineMaxDate);
    const whoopLag = daysLag(whoopDate, spineMaxDate);
    const eightSleepLag = daysLag(eightSleepDate, spineMaxDate);
    const journalLag = daysLag(journalDate, spineMaxDate);
    const habitsLag = daysLag(habitsDate, spineMaxDate);
    const mfpLag = daysLag(mfpDate, spineMaxDate);
    const hrvLag = daysLag(hrvDate, spineMaxDate);
    const spotifyLag = daysLag(spotifyDate, spineMaxDate);
    const supplementsLag = daysLag(supplementsDate, spineMaxDate);
    const notionJournalLag = daysLag(notionJournalDate, spineMaxDate);
    const mealsLag = daysLag(mealsDate, spineMaxDate);
    const weightLag = daysLag(weightDate, spineMaxDate);

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
        cadence: CADENCE.garmin,
        integrationMethod: METHOD.garmin.method,
        methodLabel: METHOD.garmin.label,
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
        cadence: CADENCE.whoop,
        integrationMethod: METHOD.whoop.method,
        methodLabel: METHOD.whoop.label,
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
        cadence: CADENCE.eight_sleep,
        integrationMethod: METHOD.eight_sleep.method,
        methodLabel: METHOD.eight_sleep.label,
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
        cadence: CADENCE.whoop_journal,
        integrationMethod: METHOD.whoop_journal.method,
        methodLabel: METHOD.whoop_journal.label,
      },
      habits: {
        label: "Habits",
        // Habits is bi-directional Notion sync; synced_at fires on every
        // tap and on the hourly :45 cron. Use it for "Last Sync" so a
        // fresh tap shows "1m ago" instead of "9h ago".
        lastSync: habitsLastLog ?? habitsDate,
        status: deriveStatus(null, habitsLag),
        latestDataDate: habitsDate,
        daysLag: habitsLag,
        recordsSynced: 0,
        durationSeconds: null,
        errorMessage: null,
        cadence: CADENCE.habits,
        integrationMethod: METHOD.habits.method,
        methodLabel: METHOD.habits.label,
      },
      notion_journal: {
        label: "Notion Journal",
        lastSync: (notionJournalEntry?.sync_start as string) ?? null,
        status: deriveStatus(notionJournalEntry, notionJournalLag),
        latestDataDate: notionJournalDate,
        daysLag: notionJournalLag,
        recordsSynced: (notionJournalEntry?.records_synced as number) ?? 0,
        durationSeconds: (notionJournalEntry?.duration_seconds as number) ?? null,
        errorMessage: (notionJournalEntry?.error_message as string) ?? null,
        cadence: CADENCE.notion_journal,
        integrationMethod: METHOD.notion_journal.method,
        methodLabel: METHOD.notion_journal.label,
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
        cadence: CADENCE.myfitnesspal,
        integrationMethod: METHOD.myfitnesspal.method,
        methodLabel: METHOD.myfitnesspal.label,
      },
      hrv_analysis: {
        label: "HRV Analysis",
        lastSync: hrvDate,
        // Prediction-pipeline drift takes priority over freshness lag: if
        // any of the last 30 days is missing a live xgboost forecast, the
        // pipeline silently broke that day — degrade to 'partial' even if
        // today's forecast is on time.
        status: (hrvGapsRes.data?.length ?? 0) > 0
          ? "partial"
          : deriveStatus(null, hrvLag),
        latestDataDate: hrvDate,
        daysLag: hrvLag,
        recordsSynced: 0,
        durationSeconds: null,
        errorMessage: (hrvGapsRes.data?.length ?? 0) > 0
          ? `${hrvGapsRes.data!.length} prediction gap${hrvGapsRes.data!.length === 1 ? "" : "s"} in last 30d: ${(hrvGapsRes.data as Array<{ expected_date: string; gap_type: string }>).slice(0, 3).map((g) => `${g.expected_date} (${g.gap_type})`).join(", ")}${hrvGapsRes.data!.length > 3 ? "…" : ""}`
          : null,
        cadence: CADENCE.hrv_analysis,
        integrationMethod: METHOD.hrv_analysis.method,
        methodLabel: METHOD.hrv_analysis.label,
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
        cadence: CADENCE.spotify,
        integrationMethod: METHOD.spotify.method,
        methodLabel: METHOD.spotify.label,
      },
      reccobeats: {
        ...enrichmentSource({ label: "ReccoBeats", entry: reccobeatsEntry }),
        cadence: CADENCE.reccobeats,
        integrationMethod: METHOD.reccobeats.method,
        methodLabel: METHOD.reccobeats.label,
      },
      musicbrainz: {
        ...enrichmentSource({ label: "MusicBrainz", entry: musicbrainzEntry }),
        cadence: CADENCE.musicbrainz,
        integrationMethod: METHOD.musicbrainz.method,
        methodLabel: METHOD.musicbrainz.label,
      },
      // Supplements is user-driven (no ETL); status derives purely from the
      // most-recent intake_date. lastSync uses the actual created_at of the
      // most-recent intake row so the "Xm ago" relative time reflects when
      // Riley actually logged, not midnight of the intake_date.
      supplements: {
        label: "Supplements",
        lastSync: supplementsLastLog ?? supplementsDate,
        status: deriveStatus(null, supplementsLag),
        latestDataDate: supplementsDate,
        daysLag: supplementsLag,
        recordsSynced: 0,
        durationSeconds: null,
        errorMessage: null,
        cadence: CADENCE.supplements,
        integrationMethod: METHOD.supplements.method,
        methodLabel: METHOD.supplements.label,
      },
      // Meals: user-driven; lastSync uses the latest event row's created_at
      // (insert time) for accurate "Xm ago" rendering.
      meals: {
        label: "Meals",
        lastSync: mealsLastLog ?? mealsDate,
        status: deriveStatus(null, mealsLag),
        latestDataDate: mealsDate,
        daysLag: mealsLag,
        recordsSynced: 0,
        durationSeconds: null,
        errorMessage: null,
        cadence: CADENCE.meals,
        integrationMethod: METHOD.meals.method,
        methodLabel: METHOD.meals.label,
      },
      // Weight: user-driven daily body weight log. lastSync uses updated_at
      // (touched on every POST/PATCH) so an edit-in-place to today's row
      // refreshes the "Xm ago" reading; falls back to log_date as before.
      weight: {
        label: "Weight",
        lastSync: weightLastLog ?? weightDate,
        status: deriveStatus(null, weightLag),
        latestDataDate: weightDate,
        daysLag: weightLag,
        recordsSynced: 0,
        durationSeconds: null,
        errorMessage: null,
        cadence: CADENCE.weight,
        integrationMethod: METHOD.weight.method,
        methodLabel: METHOD.weight.label,
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

    const driftAlerts: DriftAlert[] = (driftRes.data ?? []).map((r) => ({
      id: (r.id as string | null) ?? null,
      raisedAt: (r.created_at as string) ?? (r.sync_start as string) ?? new Date().toISOString(),
      message: (r.error_message as string) ?? "HRV model drift detected",
    }));

    const tzGaps: TzGapRow[] = (tzGapsRes.data ?? []).map((r) => ({
      cycleId: String(r.cycle_id),
      gapEtDate: r.gap_et_date as string,
      sourceOffset: r.source_offset as string,
      logResolvedTz: r.log_resolved_tz as string,
      deltaMinutes: (r.delta_minutes as number) ?? 0,
    }));

    return NextResponse.json({ sources, recentHistory, driftAlerts, tzGaps, fetchedAt: new Date().toISOString() } satisfies StatusResponse);
  } catch (err) {
    console.error("Status API error:", err);
    return NextResponse.json({ error: "Failed to fetch status" }, { status: 500 });
  }
}
