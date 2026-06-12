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
  habits: "Hourly :45",
  cronometer: "Daily 10:30pm + 11am ET",
  // Predict: every hourly ETL + 23:50 ET (DST-gated).
  hrv_analysis: "Predict: hourly + 23:50 ET",
  // Retrain: hourly conditional on backfill detection + daily 12:00 UTC
  // unconditional safety-net. Tracked separately because the predict path
  // can stay green while the retrain crashes silently (the model is cached).
  hrv_retrain: "Hourly (cond.) + 12:00 UTC safety-net",
  spotify: "Every 2h :50",
  reccobeats: "With Spotify ETL",
  musicbrainz: "With Spotify ETL",
  supplements: "Manual",
  notion_journal: "Hourly :35",
  tanita: "Daily 10am + 1:30pm ET",
  // pg_cron refresh of pds.daily_health_matrix_behavioral_mat (the matview
  // the frontend matrix reads hit since 2026-06-11). The heartbeat also
  // carries the schema-drift tripwire — a 'failed' here can mean the view
  // gained columns the matview is missing.
  matrix_mat: "Every 15 min (:10/:25/:40/:55)",
  // pg_cron refresh of ALL FIVE tier-2 perf matviews (tz_log_gaps_mat +
  // hrv_prediction_gaps_mat read by this endpoint, plus
  // spotify_daily_signature_mat, recovery_vs_pace_mat and hrv_residuals_mat
  // read by /spotify, /activities and /analytics/hrv). A failed heartbeat
  // therefore flags staleness beyond this endpoint's own reads.
  perf_mats: "Every 15 min (:12/:27/:42/:57)",
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
  habits:         { method: "automated",      label: "Notion sync" },
  cronometer:     { method: "automated",      label: "Web export ETL" },
  hrv_analysis:   { method: "automated",      label: "Computed" },
  hrv_retrain:    { method: "automated",      label: "Model retrain" },
  spotify:        { method: "automated",      label: "API ETL" },
  reccobeats:     { method: "automated",      label: "API ETL" },
  musicbrainz:    { method: "automated",      label: "API ETL" },
  supplements:    { method: "manual",         label: "Manual entry" },
  notion_journal: { method: "automated",      label: "Notion sync" },
  tanita:         { method: "automated",      label: "API ETL" },
  matrix_mat:     { method: "automated",      label: "Matview refresh" },
  perf_mats:      { method: "automated",      label: "Matview refresh" },
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
    // Fetch last 100 sync_log rows (enough to cover all sources with history).
    // matrix_mat and perf_mats each refresh 4x/hour (~96 heartbeat rows/day
    // apiece) and would flood this window, drowning every other source's
    // history — each gets a dedicated limit-1 fetch below instead.
    const { data: syncRows, error: syncErr } = await supabase
      .from("sync_log")
      .select("*")
      .not("source", "in", '("matrix_mat","perf_mats")')
      .order("sync_start", { ascending: false })
      .limit(100);

    if (syncErr) throw syncErr;

    // Fetch latest data dates per source + drift alerts (last 7 days) in parallel
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const [garminRes, whoopRes, eightSleepRes, habitsRes, cronRes, hrvRes, spotifyRes, supplementsRes, notionJournalRes, tanitaRes, tanitaSyncRes, driftRes, tzGapsRes, hrvGapsRes, hrvRetrainRes, matrixMatRes, perfMatsRes] = await Promise.all([
      supabase.from("garmin_daily_summary").select("calendar_date").order("calendar_date", { ascending: false }).limit(1),
      supabase.from("whoop_cycles").select("start_time").order("start_time", { ascending: false }).limit(1),
      supabase.from("eight_sleep_trends").select("calendar_date").order("calendar_date", { ascending: false }).limit(1),
      supabase.from("habit_journal").select("cycle_date,synced_at").order("synced_at", { ascending: false }).limit(1),
      supabase.from("cronometer_nutrition_daily").select("calendar_date").order("calendar_date", { ascending: false }).limit(1),
      supabase.from("hrv_predictions").select("prediction_date").eq("model", "xgboost").eq("horizon_days", 1).not("model_version", "like", "backtest%").order("prediction_date", { ascending: false }).limit(1),
      supabase.from("spotify_plays").select("played_date_et").order("played_date_et", { ascending: false }).limit(1),
      // Manual sources: include the actual log timestamp so the "Last Sync"
      // row shows real-time "Xm ago" rather than midnight of the latest
      // entry date. created_at on supplement/weight is the row insert
      // time; for weight the user-facing timestamp is updated_at on edits.
      supabase.from("supplement_intake").select("intake_date,created_at").order("intake_time", { ascending: false }).limit(1),
      supabase.from("journal_entries").select("entry_date").eq("archived", false).order("entry_date", { ascending: false }).limit(1),
      // Body weight via Tanita: freshness = the newest scale measurement.
      // onyx_et_date is the trigger-derived ET day; measured_at gives the
      // real-time "Xm ago" anchor when no sync_log heartbeat exists yet.
      supabase.from("tanita_measurements").select("onyx_et_date,measured_at").order("measured_at", { ascending: false }).limit(1),
      // Tanita's heartbeat needs a dedicated fetch: hourly sources write
      // ~8 sync_log rows/h, so the 100-row window above covers only ~13h —
      // but the 1:30pm → 10am gap between tanita runs is ~20h. Without this,
      // a FAILED afternoon run ages out of the window overnight and the card
      // reads Healthy off data-lag alone until the lag itself crosses 1d.
      supabase
        .from("sync_log")
        .select("*")
        .eq("source", "tanita")
        .eq("data_type", "weight")
        .order("sync_start", { ascending: false })
        .limit(1),
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
      // tz_log_gaps_mat = 15-min pg_cron matview of the live view (which was the slowest query here, ~503ms mean); a fixed travel gap can linger on the banner up to 15 min.
      supabase
        .from("tz_log_gaps_mat")
        .select("cycle_id, gap_et_date, source_offset, log_resolved_tz, delta_minutes")
        .eq("gap_type", "travel")
        .order("gap_et_date", { ascending: false })
        .limit(50),
      // HRV prediction drift monitor — any expected_date in the last 30 days
      // where no live xgboost forecast was written. Backtest fills don't
      // count. Empty array = healthy.
      // hrv_prediction_gaps_mat = 15-min pg_cron matview of the live view (2nd-slowest query here, ~363ms mean); a healed gap can keep the card degraded up to 15 min.
      supabase
        .from("hrv_prediction_gaps_mat")
        .select("expected_date, gap_type")
        .order("expected_date", { ascending: false }),
      // HRV RETRAIN freshness — most recent computed_at in hrv_analysis_results.
      // This catches silent failures of the hrv_analysis.py pipeline that the
      // prediction card misses (predict keeps writing fresh rows from the
      // cached model even when retrain has been crashing). Audit gap discovered
      // when category→categories rename broke retrain for weeks unnoticed.
      supabase
        .from("hrv_analysis_results")
        .select("computed_at")
        .order("computed_at", { ascending: false })
        .limit(1),
      // Matview refresh heartbeat (excluded from the main window above).
      supabase
        .from("sync_log")
        .select("*")
        .eq("source", "matrix_mat")
        .eq("data_type", "refresh")
        .order("sync_start", { ascending: false })
        .limit(1),
      // Perf-matview refresh heartbeat — covers all five tier-2 matviews
      // (see CADENCE comment above); also excluded from the main window.
      supabase
        .from("sync_log")
        .select("*")
        .eq("source", "perf_mats")
        .eq("data_type", "refresh")
        .order("sync_start", { ascending: false })
        .limit(1),
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
    const habitsDate = habitsRes.data?.[0]?.cycle_date ?? null;
    const habitsLastLog = (habitsRes.data?.[0]?.synced_at as string | undefined) ?? null;
    const cronDate = cronRes.data?.[0]?.calendar_date ?? null;
    const hrvDate = hrvRes.data?.[0]?.prediction_date ?? null;
    const spotifyDate = spotifyRes.data?.[0]?.played_date_et ?? null;
    const supplementsDate = supplementsRes.data?.[0]?.intake_date ?? null;
    const supplementsLastLog = (supplementsRes.data?.[0]?.created_at as string | undefined) ?? null;
    const notionJournalDate = notionJournalRes.data?.[0]?.entry_date ?? null;
    const tanitaDate = tanitaRes.data?.[0]?.onyx_et_date ?? null;
    const tanitaLastMeasure = (tanitaRes.data?.[0]?.measured_at as string | undefined) ?? null;

    // Per ADR-0001 Phase 3 step 5: anchor freshness to the spine's most-recent
    // date (max across all sources), not browser-local today. When Riley is
    // abroad, the freshest day in his lived timeline IS today-in-his-current-TZ.
    // An ET-anchored "today" would falsely report all sources ~18h stale.
    //
    // hrvDate is DELIBERATELY EXCLUDED from the anchor: hrv_predictions.prediction_date
    // is a FORECAST (always today+1, and today+2 on a late-evening run), so including it
    // pushed the reference date into the future and made every source carrying actual data
    // for *today* read as 1-2 days behind → false "Degraded". The freshness anchor must be
    // the most-recent OBSERVED day, never a prediction about the future. The HRV card keeps
    // its own freshness via hrvLag (prediction_date vs this anchor), so excluding it here
    // doesn't mask a real prediction outage.
    const spineMaxDate = [garminDate, whoopDate, eightSleepDate, cronDate, spotifyDate]
      .filter((d): d is string => typeof d === "string")
      .sort()
      .pop() ?? null;

    const garminEntry = latestBySrcType["garmin|full_sync"] ?? null;
    const whoopEntry = latestBySrcType["whoop|full_sync"] ?? null;
    const eightSleepEntry = latestBySrcType["eight_sleep|trends"] ?? null;
    const cronEntry = latestBySrcType["cronometer|daily"] ?? null;
    const spotifyEntry = latestBySrcType["spotify|plays"] ?? null;
    const reccobeatsEntry = latestBySrcType["reccobeats|audio_features"] ?? null;
    const musicbrainzEntry = latestBySrcType["musicbrainz|artist_tags"] ?? null;
    const notionJournalEntry = latestBySrcType["notion_journal|entries"] ?? null;
    // Latest hrv_analysis retrain heartbeat (added 2026-05-26 — older runs
    // didn't emit one, so fall back to MAX(hrv_analysis_results.computed_at)
    // below for historical signal).
    const hrvRetrainEntry = latestBySrcType["hrv_analysis|retrain"] ?? null;
    const hrvRetrainComputedAt = (hrvRetrainRes.data?.[0]?.computed_at as string | undefined) ?? null;
    const tanitaEntry = latestBySrcType["tanita|weight"]
      ?? (tanitaSyncRes.data?.[0] as Record<string, unknown> | undefined)
      ?? null;

    const garminLag = daysLag(garminDate, spineMaxDate);
    const whoopLag = daysLag(whoopDate, spineMaxDate);
    const eightSleepLag = daysLag(eightSleepDate, spineMaxDate);
    const habitsLag = daysLag(habitsDate, spineMaxDate);
    const cronLag = daysLag(cronDate, spineMaxDate);
    const hrvLag = daysLag(hrvDate, spineMaxDate);
    const spotifyLag = daysLag(spotifyDate, spineMaxDate);
    const supplementsLag = daysLag(supplementsDate, spineMaxDate);
    const notionJournalLag = daysLag(notionJournalDate, spineMaxDate);
    const tanitaLag = daysLag(tanitaDate, spineMaxDate);

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
      // WHOOP Journal card retired 2026-06-11: the email ETL is decommissioned
      // and WHOOP journal behaviors merged into habit_journal (the Habits card
      // covers the merged table's freshness). See sql/whoop_journal_merge.sql.
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
      cronometer: {
        label: "Cronometer",
        lastSync: (cronEntry?.sync_start as string) ?? null,
        status: deriveStatus(cronEntry, cronLag),
        latestDataDate: cronDate,
        daysLag: cronLag,
        recordsSynced: (cronEntry?.records_synced as number) ?? 0,
        durationSeconds: (cronEntry?.duration_seconds as number) ?? null,
        errorMessage: (cronEntry?.error_message as string) ?? null,
        cadence: CADENCE.cronometer,
        integrationMethod: METHOD.cronometer.method,
        methodLabel: METHOD.cronometer.label,
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
      // HRV Retrain (separate from Predict above) — tracks whether
      // hrv_analysis.py is actually completing. The predict path can stay
      // green while the retrain crashes silently (cached model keeps serving),
      // so we surface it independently. Daily safety-net runs at 12:00 UTC,
      // so >30h since the last successful computed_at = failure.
      hrv_retrain: (() => {
        // Prefer the new sync_log heartbeat (going forward); fall back to
        // hrv_analysis_results.computed_at (works for historical runs).
        const lastSync = (hrvRetrainEntry?.sync_start as string)
          ?? hrvRetrainComputedAt;
        const heartbeatStatus = hrvRetrainEntry?.status as string | undefined;
        const ageHours = hoursSince(lastSync);
        let status: SourceStatus["status"];
        if (heartbeatStatus === "failed") status = "failed";
        else if (!lastSync) status = "unknown";
        else if (ageHours > 30) status = "failed";        // missed daily safety net
        else if (ageHours > 26 || heartbeatStatus === "partial") status = "partial";
        else status = "success";
        return {
          label: "HRV Retrain",
          lastSync,
          status,
          latestDataDate: null,                            // not date-anchored
          daysLag: Math.floor(ageHours / 24),
          recordsSynced: (hrvRetrainEntry?.records_synced as number) ?? 0,
          durationSeconds: (hrvRetrainEntry?.duration_seconds as number) ?? null,
          errorMessage: (hrvRetrainEntry?.error_message as string)
            ?? (ageHours > 30 ? `Last successful retrain ${ageHours}h ago (daily safety-net runs at 12:00 UTC).` : null),
          cadence: CADENCE.hrv_retrain,
          integrationMethod: METHOD.hrv_retrain.method,
          methodLabel: METHOD.hrv_retrain.label,
        };
      })(),
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
      // Body weight via Tanita Health Planet (tanita_etl.py): scale → phone
      // app → Health Planet cloud → twice-daily ETL → tanita_measurements,
      // rolled up into weight_log (source='tanita'). This card REPLACED the
      // manual "Weight" card (2026-06-09) — weight is now an automated
      // ingestion source; the /nutrition quick-log remains as the manual
      // fallback/override (source='manual', never overwritten by the ETL)
      // and needs no card of its own. Daily cadence like Eight Sleep →
      // shared deriveStatus thresholds (>1d partial, >3d failed vs spine).
      tanita: {
        label: "Tanita",
        lastSync: (tanitaEntry?.sync_start as string) ?? tanitaLastMeasure ?? null,
        status: deriveStatus(tanitaEntry, tanitaLag),
        latestDataDate: tanitaDate,
        daysLag: tanitaLag,
        recordsSynced: (tanitaEntry?.records_synced as number) ?? 0,
        durationSeconds: (tanitaEntry?.duration_seconds as number) ?? null,
        errorMessage: (tanitaEntry?.error_message as string) ?? null,
        cadence: CADENCE.tanita,
        integrationMethod: METHOD.tanita.method,
        methodLabel: METHOD.tanita.label,
      },
      // Materialized matrix view refresh (pg_cron, every 15 min). Frontend
      // matrix reads (/analytics/hrv, /caffeine, /nutrition, /bland-altman,
      // /analytics/travel) hit the matview since 2026-06-11; a stuck refresh
      // means those pages silently serve aging data while the live view (and
      // the Python pipeline) move on — exactly the silent-staleness failure
      // mode the heartbeat convention exists to catch. Freshness is heartbeat
      // age in MINUTES (like the enrichment cards but tighter): >20 min = one
      // missed refresh (partial), >45 min = three missed (failed). A 'failed'
      // heartbeat can also be the schema-drift tripwire — the error message
      // names the columns the matview is missing.
      matrix_mat: (() => {
        const entry = (matrixMatRes.data?.[0] as Record<string, unknown> | undefined) ?? null;
        const lastSync = (entry?.sync_start as string) ?? null;
        const ageMin = lastSync ? Math.round((Date.now() - new Date(lastSync).getTime()) / 60000) : null;
        let status: SourceStatus["status"];
        if (!entry) status = "unknown";
        else if (entry.status === "failed" || ageMin === null || ageMin > 45) status = "failed";
        else if (ageMin > 20) status = "partial";
        else status = "success";
        return {
          label: "Matrix Matview",
          lastSync,
          status,
          latestDataDate: null,
          daysLag: ageMin === null ? 999 : Math.floor(ageMin / 1440),
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string) ?? null,
          cadence: CADENCE.matrix_mat,
          integrationMethod: METHOD.matrix_mat.method,
          methodLabel: METHOD.matrix_mat.label,
        };
      })(),
      // Perf matviews (pg_cron, every 15 min): tz_log_gaps_mat +
      // hrv_prediction_gaps_mat — the matviews THIS endpoint reads for the
      // travel banner and the HRV-gap check (perf round 3, 2026-06-11; the
      // live views were the two slowest Promise.all members). Same heartbeat
      // semantics + thresholds as matrix_mat: >20 min = one missed refresh
      // (partial), >45 min = three missed (failed).
      perf_mats: (() => {
        const entry = (perfMatsRes.data?.[0] as Record<string, unknown> | undefined) ?? null;
        const lastSync = (entry?.sync_start as string) ?? null;
        const ageMin = lastSync ? Math.round((Date.now() - new Date(lastSync).getTime()) / 60000) : null;
        let status: SourceStatus["status"];
        if (!entry) status = "unknown";
        else if (entry.status === "failed" || ageMin === null || ageMin > 45) status = "failed";
        else if (ageMin > 20) status = "partial";
        else status = "success";
        return {
          label: "Perf Matviews",
          lastSync,
          status,
          latestDataDate: null,
          daysLag: ageMin === null ? 999 : Math.floor(ageMin / 1440),
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string) ?? null,
          cadence: CADENCE.perf_mats,
          integrationMethod: METHOD.perf_mats.method,
          methodLabel: METHOD.perf_mats.label,
        };
      })(),
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

    return NextResponse.json(
      { sources, recentHistory, driftAlerts, tzGaps, fetchedAt: new Date().toISOString() } satisfies StatusResponse,
      {
        headers: {
          // The /status page polls every 60s and tolerates ~60s staleness.
          // s-maxage=30 + swr=30 lets Vercel's edge serve repeat hits without
          // re-running the ~16 Supabase queries, worst-case ~60s stale.
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30",
        },
      }
    );
  } catch (err) {
    console.error("Status API error:", err);
    return NextResponse.json({ error: "Failed to fetch status" }, { status: 500 });
  }
}
