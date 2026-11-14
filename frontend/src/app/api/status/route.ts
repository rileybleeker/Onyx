import { GARMIN_WEARABLE_FILTER, garminNoWearMessage, ingestionHeartbeatStatus } from "@/lib/status-freshness";
import { NextResponse } from "next/server";
import { getNycScoutFreshness } from "@/lib/nyc";
import { createClient } from "@supabase/supabase-js";
import { getUrgentEmailStatusCard } from "@/lib/urgent-email-query";
import { financeLedgerCard } from "@/lib/finance-status";

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
  reading: "Manual",
  procurement: "Manual",
  kindle: "Every 3h (Riley's PC, while logged on)",
  amazon_orders: "Every 3h with the Kindle harvest (Riley's PC)",
  screen_usage: "Daily (iPhone Shortcuts automation)",
  notion_journal: "Hourly :35",
  tanita: "Daily 10am + 1:30pm ET",
  flights: "Every 3h :25 (both Gmail accounts)",
  delivery: "Every 3h :40",
  online_orders: "Every 3h :05 (both Gmail accounts)",
  air_quality: "Every 3h :12",
  weather: "Every 3h :32",
  supplement_reminders: "Worker poll (heartbeat ~hourly); cards at each stack's reminder time",
  renewal_reminders: "Worker poll, hourly; a card up to 3 days before a renewal",
  urgent_email: "Hourly :15 (both Gmail accounts)",
  google_calendar: "Hourly :55",
  ubereats: "Every 6h (Riley's PC, while logged on)",
  nyc_scout: "Daily 6:10am ET",
  rocket_money: "Daily (harvester)",
  // pg_cron refresh of pds.daily_health_matrix_behavioral_mat (the matview
  // the frontend matrix reads hit since 2026-06-11). The heartbeat also
  // carries the schema-drift tripwire — a 'failed' here can mean the view
  // gained columns the matview is missing.
  matrix_mat: "Every 30 min (:10/:40)",
  // pg_cron refresh of ALL FIVE tier-2 perf matviews (tz_log_gaps_mat +
  // hrv_prediction_gaps_mat read by this endpoint, plus
  // spotify_daily_signature_mat, recovery_vs_pace_mat and hrv_residuals_mat
  // read by /spotify, /activities and /analytics/hrv). A failed heartbeat
  // therefore flags staleness beyond this endpoint's own reads.
  perf_mats: "Every 30 min (:12/:42)",
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
  reading:        { method: "manual",         label: "Manual entry" },
  procurement:    { method: "manual",         label: "Manual entry" },
  kindle:         { method: "automated",      label: "Local Chrome harvest" },
  amazon_orders:  { method: "automated",      label: "Local Chrome harvest" },
  screen_usage:   { method: "automated",      label: "iPhone app export" },
  notion_journal: { method: "automated",      label: "Notion sync" },
  tanita:         { method: "automated",      label: "API ETL" },
  flights:        { method: "automated",      label: "IMAP email parser" },
  delivery:       { method: "automated",      label: "IMAP email parser" },
  online_orders:  { method: "automated",      label: "IMAP email parser" },
  air_quality:    { method: "automated",      label: "API ETL" },
  weather:        { method: "automated",      label: "API ETL" },
  supplement_reminders: { method: "automated", label: "Worker push cards" },
  renewal_reminders: { method: "automated", label: "Worker push cards" },
  urgent_email:   { method: "automated",      label: "IMAP label reader" },
  google_calendar: { method: "automated",     label: "iCal feed ETL" },
  ubereats:       { method: "automated",      label: "Local Chrome harvest" },
  nyc_scout:      { method: "automated",      label: "Agent → Notion" },
  rocket_money:   { method: "automated",      label: "Harvester import" },
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
  // "error" is what cronometer_etl.py / cronometer_import.py write on a failed run.
  if (syncEntry?.status === "failed" || syncEntry?.status === "error" || lag > 3) return "failed";
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
    // matrix_mat and perf_mats each refresh 2x/hour (~48 heartbeat rows/day
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
    // Garmin freshness = the newest day the watch was worn. Garmin writes an
    // (empty) summary row for every day, so the newest row alone stayed green
    // through 40 unworn days (2026-10-03 -> 2026-11-11). The query builder is
    // lazy; .then() sends it now so it overlaps the reads below.
    const garminWornPromise = supabase.from("garmin_daily_summary").select("calendar_date")
      .or(GARMIN_WEARABLE_FILTER).order("calendar_date", { ascending: false }).limit(1)
      .then((res) => res);

    // NYC scout freshness lives in Notion (the "NYC Leads" database the
    // nyc-scout agent upserts every run), not in sync_log. Started here so the
    // one Notion call overlaps the Supabase reads; a Notion failure turns the
    // card red but never breaks /status.
    const nycPromise = getNycScoutFreshness().then(
      (v) => ({ ok: true as const, ...v }),
      (e: Error) => ({ ok: false as const, error: e.message }),
    );
    const [garminRes, whoopRes, eightSleepRes, habitsRes, cronRes, hrvRes, spotifyRes, supplementsRes, readingRes, notionJournalRes, tanitaRes, tanitaSyncRes, driftRes, tzGapsRes, hrvGapsRes, hrvRetrainRes, matrixMatRes, perfMatsRes, deliveryRes, airQualityRes, airQualitySyncRes, weatherRes, weatherSyncRes, ubereatsSyncRes, kindleSyncRes, screenUsageSyncRes, hrvRetrainSyncRes, supplementRemindersSyncRes, ingestionHeartbeats] = await Promise.all([
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
      // Reading module (/reading): freshness = the newest logged session. Manual source.
      supabase.from("reading_sessions").select("session_date,created_at").order("created_at", { ascending: false }).limit(1),
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
      // Delivery orders: newest order date parsed from Uber Eats receipt emails.
      supabase.from("delivery_orders").select("order_date_local").order("order_date_local", { ascending: false }).limit(1),
      // Air quality: newest ET day in pds.air_quality_daily, plus a dedicated limit-1 heartbeat fetch
      // (the 3-hourly run can fall out of the 100-row window above when hourly sources are busy).
      // A missing table (SQL not applied yet) shows its error text on the card instead of breaking /status.
      supabase.from("air_quality_daily").select("calendar_date").order("calendar_date", { ascending: false }).limit(1),
      supabase.from("sync_log").select("*").eq("source", "air_quality").eq("data_type", "daily")
        .order("sync_start", { ascending: false }).limit(1),
      // Weather: same shape as air quality (newest ET day in pds.weather_daily + a dedicated
      // limit-1 heartbeat fetch for the 3-hourly run; a missing table shows its error on the card).
      supabase.from("weather_daily").select("calendar_date").order("calendar_date", { ascending: false }).limit(1),
      supabase.from("sync_log").select("*").eq("source", "weather").eq("data_type", "daily")
        .order("sync_start", { ascending: false }).limit(1),
      // The two PC harvesters heartbeat hours apart (and not at all while the PC is off), so their
      // newest row regularly falls out of the 100-row window above (~13 h of history). Without a
      // dedicated fetch a stalled harvester reads "Unknown" instead of going amber, then red.
      supabase.from("sync_log").select("*").eq("source", "ubereats").eq("data_type", "items")
        .order("sync_start", { ascending: false }).limit(1),
      supabase.from("sync_log").select("*").eq("source", "kindle").eq("data_type", "highlights")
        .order("sync_start", { ascending: false }).limit(1),
      // Onyx Screen Time iPhone app: one heartbeat a day, so it also needs its own fetch.
      supabase.from("sync_log").select("*").eq("source", "screen_time").eq("data_type", "usage")
        .order("sync_start", { ascending: false }).limit(1),
      // HRV retrain: daily safety net + conditional hourly runs, so its newest heartbeat (incl. a
      // failed "GUARD …" row from the alignment check) can fall out of the 100-row window.
      supabase.from("sync_log").select("*").eq("source", "hrv_analysis").eq("data_type", "retrain")
        .order("sync_start", { ascending: false }).limit(1),
      // Supplement stack reminders: the sms-reminders Worker polls /api/supplements/reminders/claim
      // and each poll (throttled to ~1/h when nothing is due) writes a heartbeat. Dedicated fetch so
      // a Worker that stops polling reads red instead of "unknown" once the row leaves the window.
      supabase.from("sync_log").select("*").eq("source", "supplement_reminders").eq("data_type", "prompt")
        .order("sync_start", { ascending: false }).limit(1),
      // Scheduled ingestion must retain its latest heartbeat even when the shared
      // history window is full of newer jobs. In particular, daily Eight Sleep and
      // twice-daily Cronometer regularly fall outside that window overnight.
      Promise.all([
        ["garmin", "full_sync"], ["whoop", "full_sync"],
        ["eight_sleep", "trends"], ["cronometer", "daily"],
        // Finance ledger: the harvester + importers heartbeat once a day (transactions and
        // balances separately), so the pair needs its own limit-1 reads. Heartbeats only:
        // this endpoint is CDN-cacheable, so no ledger rows or amounts are read here.
        ["rocketmoney", "transactions"], ["rocketmoney", "balances"],
        // Online orders (every 3h): its own read so the shared 100-row window cannot push it out.
        ["online_orders", "email"],
        // Personal Amazon order list (Kindle harvester pass on Riley's PC, every 3h).
        ["amazon", "orders"],
        // Google Calendar (hourly): 24 rows a day would otherwise push it, or the daily jobs,
        // out of the shared 100-row window.
        ["google_calendar", "events"],
      ].map(async ([source, dataType]) => {
        const { data, error } = await supabase.from("sync_log").select("*")
          .eq("source", source).eq("data_type", dataType)
          .order("sync_start", { ascending: false }).limit(1);
        if (error) throw error;
        return { key: `${source}|${dataType}`, entry: data?.[0] ?? null };
      })),
    ]);

    // Find the latest sync entry per (source, data_type) key
    const latestBySrcType: Record<string, Record<string, unknown>> = {};
    for (const row of (syncRows ?? [])) {
      const key = `${row.source}|${row.data_type}`;
      if (!latestBySrcType[key]) {
        latestBySrcType[key] = row as Record<string, unknown>;
      }
    }

    for (const { key, entry } of ingestionHeartbeats) {
      if (entry) latestBySrcType[key] = entry as Record<string, unknown>;
    }

    const garminRowDate = garminRes.data?.[0]?.calendar_date ?? null;
    const garminWorn = await garminWornPromise;
    const garminDate = (garminWorn.data?.[0]?.calendar_date as string | undefined) ?? null;
    const whoopDate = whoopRes.data?.[0]?.start_time?.split("T")[0] ?? null;
    const eightSleepDate = eightSleepRes.data?.[0]?.calendar_date ?? null;
    const habitsDate = habitsRes.data?.[0]?.cycle_date ?? null;
    const habitsLastLog = (habitsRes.data?.[0]?.synced_at as string | undefined) ?? null;
    const cronDate = cronRes.data?.[0]?.calendar_date ?? null;
    const hrvDate = hrvRes.data?.[0]?.prediction_date ?? null;
    const spotifyDate = spotifyRes.data?.[0]?.played_date_et ?? null;
    const supplementsDate = supplementsRes.data?.[0]?.intake_date ?? null;
    const supplementsLastLog = (supplementsRes.data?.[0]?.created_at as string | undefined) ?? null;
    const readingDate = readingRes.data?.[0]?.session_date ?? null;
    const readingLastLog = (readingRes.data?.[0]?.created_at as string | undefined) ?? null;
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
    const hrvRetrainEntry = (hrvRetrainSyncRes.data?.[0] as Record<string, unknown> | undefined)
      ?? latestBySrcType["hrv_analysis|retrain"] ?? null;
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
    const readingLag = daysLag(readingDate, spineMaxDate);
    const notionJournalLag = daysLag(notionJournalDate, spineMaxDate);
    const tanitaLag = daysLag(tanitaDate, spineMaxDate);
    const nyc = await nycPromise;
    const nycDate = nyc.ok ? nyc.lastVerified : null;
    const nycLag = daysLag(nycDate, spineMaxDate);
    // Procurement subscription tracker (/procurement): hand-typed, so data age says nothing. The card reports whether saving is set up (table answers) and how many are tracked.
    const procurementRes = await supabase.from("procurement_subscriptions").select("updated_at", { count: "exact" }).eq("is_active", true).order("updated_at", { ascending: false }).limit(1);
    const procurementPending = procurementRes.error?.code === "PGRST205" || procurementRes.error?.code === "42P01";
    const procurementLast = (procurementRes.data?.[0]?.updated_at as string | undefined) ?? null;
    // Renewal cards (sms-reminders Worker -> /api/procurement/renewals/claim): heartbeat age, own limit-1
    // query so a Worker that stops polling reads red instead of dropping out of the shared window.
    const renewalRemindersRes = await supabase.from("sync_log").select("status,sync_start,records_synced,duration_seconds,error_message")
      .eq("source", "procurement_renewals").eq("data_type", "prompt").order("sync_start", { ascending: false }).limit(1);
    // Urgent email labels (urgent_email_etl.py, hourly): heartbeat age, own limit-1 query.
    const urgentEmailCard = await getUrgentEmailStatusCard(supabase);

    const sources: Record<string, SourceStatus> = {
      garmin: {
        label: "Garmin",
        lastSync: (garminEntry?.sync_start as string) ?? null,
        status: ingestionHeartbeatStatus(deriveStatus(garminEntry, garminLag), garminEntry, 3, 6),
        latestDataDate: garminDate,
        daysLag: garminLag,
        recordsSynced: (garminEntry?.records_synced as number) ?? 0,
        durationSeconds: (garminEntry?.duration_seconds as number) ?? null,
        errorMessage: (garminEntry?.error_message as string)
          ?? garminWorn.error?.message
          ?? garminNoWearMessage(garminDate, garminRowDate, garminLag),
        cadence: CADENCE.garmin,
        integrationMethod: METHOD.garmin.method,
        methodLabel: METHOD.garmin.label,
      },
      whoop: {
        label: "WHOOP",
        lastSync: (whoopEntry?.sync_start as string) ?? null,
        status: ingestionHeartbeatStatus(deriveStatus(whoopEntry, whoopLag), whoopEntry, 3, 6),
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
        status: ingestionHeartbeatStatus(deriveStatus(eightSleepEntry, eightSleepLag), eightSleepEntry, 26, 30),
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
        status: ingestionHeartbeatStatus(deriveStatus(cronEntry, cronLag), cronEntry, 16, 28),
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
      // Reading quest (/reading, 2026-11-07): sessions + highlights logged by hand,
      // mirrored to the book's Notion reading-log page. Freshness = newest session
      // (daily cadence while a book is in progress).
      reading: {
        label: "Reading",
        lastSync: readingLastLog ?? readingDate,
        status: deriveStatus(null, readingLag),
        latestDataDate: readingDate,
        daysLag: readingLag,
        recordsSynced: 0,
        durationSeconds: null,
        errorMessage: null,
        cadence: CADENCE.reading,
        integrationMethod: METHOD.reading.method,
        methodLabel: METHOD.reading.label,
      },
      // Renewal cards (2026-11-13): the Worker claims subscriptions renewing within 3 days and posts a
      // card to /agents. Freshness = heartbeat age, because a week with nothing renewing is healthy.
      // Hourly poll, quiet 23:30-07:00: >3h with no poll = degraded, >9h or a failed heartbeat = red;
      // "unknown" until the Worker's first call. records_synced = renewals claimed by that call. The
      // heartbeat text is an error code at most - never a merchant or an amount.
      renewal_reminders: (() => {
        const entry = latestBySrcType["procurement_renewals|prompt"]
          ?? (renewalRemindersRes.data?.[0] as Record<string, unknown> | undefined)
          ?? null;
        const ageH = entry?.sync_start ? (Date.now() - new Date(entry.sync_start as string).getTime()) / 3600000 : Infinity;
        return {
          label: "Renewal Reminders",
          lastSync: (entry?.sync_start as string) ?? null,
          status: ingestionHeartbeatStatus("success", entry, 3, 9),
          latestDataDate: entry?.sync_start ? String(entry.sync_start).slice(0, 10) : null,
          daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string)
            ?? (entry && ageH > 9 ? `No claim call for ${Math.floor(ageH)}h - check the sms-reminders Worker's renewal poll.` : null),
          cadence: CADENCE.renewal_reminders,
          integrationMethod: METHOD.renewal_reminders.method,
          methodLabel: METHOD.renewal_reminders.label,
        };
      })(),
      // Procurement subscription tracker (/procurement, 2026-11-11): typed by hand, never connected to a provider.
      // "unknown" (not red) until sql/procurement_schema.sql is applied; green once the table answers.
      procurement: {
        label: procurementPending ? "Procurement (saving not set up)" : "Procurement",
        lastSync: procurementLast,
        status: procurementPending ? "unknown" : procurementRes.error ? "failed" : "success",
        latestDataDate: procurementLast ? procurementLast.slice(0, 10) : null,
        daysLag: 0,
        recordsSynced: procurementRes.count ?? 0,
        durationSeconds: null,
        errorMessage: procurementRes.error && !procurementPending ? procurementRes.error.message : null,
        cadence: CADENCE.procurement,
        integrationMethod: METHOD.procurement.method,
        methodLabel: METHOD.procurement.label,
      },
      // Kindle Notebook harvester (tools/kindle_harvest): a Task Scheduler job on
      // Riley's PC scrapes read.amazon.com/notebook in a signed-in Chrome and posts
      // to /api/reading/highlights/import, which writes a kindle|highlights heartbeat
      // on every call. Like the StreetEasy harvester it only runs while the PC is on,
      // so the thresholds are loose: >12h degraded, >48h or an error row = red. An
      // expired Amazon session arrives as a failed heartbeat with the fix in the text.
      kindle: (() => {
        const entry = latestBySrcType["kindle|highlights"]
          ?? (kindleSyncRes.data?.[0] as Record<string, unknown> | undefined)
          ?? null;
        const ageH = entry?.sync_start ? (Date.now() - new Date(entry.sync_start as string).getTime()) / 3600000 : Infinity;
        const status: SourceStatus["status"] = !entry
          ? "unknown"
          : entry.status === "failed" || ageH > 48
            ? "failed"
            : entry.status === "partial" || ageH > 12
              ? "partial"
              : "success";
        return {
          label: "Kindle",
          lastSync: (entry?.sync_start as string) ?? null,
          status,
          latestDataDate: entry?.sync_start ? String(entry.sync_start).slice(0, 10) : null,
          daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string) ?? null,
          cadence: CADENCE.kindle,
          integrationMethod: METHOD.kindle.method,
          methodLabel: METHOD.kindle.label,
        };
      })(),
      // Personal Amazon orders (tools/kindle_harvest/amazon-orders.mjs): the Kindle harvester's
      // 3-hourly pass on Riley's PC reads the "Your Orders" list and posts to
      // /api/orders/amazon/import, which writes an amazon|orders heartbeat on every call. PC-bound,
      // so Kindle's loose thresholds: >12h degraded, >48h or a failed row red.
      amazon_orders: (() => {
        const entry = latestBySrcType["amazon|orders"] ?? null;
        const ageH = entry?.sync_start ? (Date.now() - new Date(entry.sync_start as string).getTime()) / 3600000 : Infinity;
        const status: SourceStatus["status"] = !entry
          ? "unknown"
          : entry.status === "failed" || ageH > 48
            ? "failed"
            : entry.status === "partial" || ageH > 12
              ? "partial"
              : "success";
        return {
          label: "Amazon Orders",
          lastSync: (entry?.sync_start as string) ?? null,
          status,
          latestDataDate: entry?.sync_start ? String(entry.sync_start).slice(0, 10) : null,
          daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string)
            ?? (!entry ? "No run yet - the Kindle harvester's Amazon pass has not reported." : null),
          cadence: CADENCE.amazon_orders,
          integrationMethod: METHOD.amazon_orders.method,
          methodLabel: METHOD.amazon_orders.label,
        };
      })(),
      // Onyx Screen Time iPhone app (tools/screentime_ios -> /api/screen-time/usage):
      // a daily Shortcuts automation runs the app's "Sync Screen Time to Onyx"
      // intent, and every POST writes a screen_time|usage heartbeat. (The older
      // Shortcuts open/close path and its "Screen Time" card were retired 2026-11-13.)
      // The app reports its own failures (Screen Time unreadable, network, HTTP)
      // as a failed row (2026-11-11), but a missing or refused token cannot be
      // reported, so the card still ages out: >26h degraded, >36h or a failed
      // row = red. "unknown" until first sync.
      screen_usage: (() => {
        const entry = latestBySrcType["screen_time|usage"]
          ?? (screenUsageSyncRes.data?.[0] as Record<string, unknown> | undefined)
          ?? null;
        const ageH = entry?.sync_start ? (Date.now() - new Date(entry.sync_start as string).getTime()) / 3600000 : Infinity;
        const status: SourceStatus["status"] = !entry
          ? "unknown"
          : entry.status === "failed" || ageH > 36
            ? "failed"
            : ageH > 26
              ? "partial"
              : "success";
        return {
          label: "Screen Time app",
          lastSync: (entry?.sync_start as string) ?? null,
          status,
          latestDataDate: entry?.sync_start ? String(entry.sync_start).slice(0, 10) : null,
          daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string)
            ?? (entry && ageH > 36 ? `No sync for ${Math.floor(ageH)}h - open the Onyx Screen Time app on the iPhone (it must re-confirm access) and check the daily Shortcuts automation.` : null),
          cadence: CADENCE.screen_usage,
          integrationMethod: METHOD.screen_usage.method,
          methodLabel: METHOD.screen_usage.label,
        };
      })(),
      // Flights (flights_email_etl.py): Delta confirmation / trip-details / check-in
      // emails parsed over IMAP from BOTH Gmail accounts → pds.flights. Delta has no
      // bookings API and its emails carry no FlightReservation markup, so this is a
      // text parser. Freshness = heartbeat age (a quiet travel month is healthy, not
      // stale): cron every 3h → >4h partial, >12h or an error row = red. A 'partial'
      // heartbeat also means only one of the two accounts is configured, or an email
      // failed to parse (pds.flight_email_log status='error').
      flights: (() => {
        const entry = latestBySrcType["flights|email"] ?? null;
        const ageH = entry?.sync_start ? (Date.now() - new Date(entry.sync_start as string).getTime()) / 3600000 : Infinity;
        const status: SourceStatus["status"] = !entry
          ? "unknown"
          : entry.status === "failed" || ageH > 12
            ? "failed"
            : entry.status === "partial" || ageH > 4
              ? "partial"
              : "success";
        return {
          label: "Flights",
          lastSync: (entry?.sync_start as string) ?? null,
          status,
          latestDataDate: entry?.sync_start ? String(entry.sync_start).slice(0, 10) : null,
          daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string) ?? null,
          cadence: CADENCE.flights,
          integrationMethod: METHOD.flights.method,
          methodLabel: METHOD.flights.label,
        };
      })(),
      // Online orders (orders_email_etl.py): shipping / delivery emails from stores, Amazon and
      // the carriers, both Gmail accounts, joined into pds.online_orders for /orders. Freshness =
      // heartbeat age (a week without an order is healthy): cron every 3h -> >4h partial, >12h or
      // a failed run red. 'partial' = an account is missing or an email failed to parse.
      online_orders: (() => {
        const entry = latestBySrcType["online_orders|email"] ?? null;
        const ageH = entry?.sync_start ? (Date.now() - new Date(entry.sync_start as string).getTime()) / 3600000 : Infinity;
        const status: SourceStatus["status"] = !entry
          ? "unknown"
          : entry.status === "failed" || ageH > 12
            ? "failed"
            : entry.status === "partial" || ageH > 4
              ? "partial"
              : "success";
        return {
          label: "Online Orders",
          lastSync: (entry?.sync_start as string) ?? null,
          status,
          latestDataDate: entry?.sync_start ? String(entry.sync_start).slice(0, 10) : null,
          daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string)
            ?? (!entry ? "No run yet - the Online Orders Email workflow has not reported." : ageH > 12 ? `No run for ${Math.floor(ageH)}h - check the Online Orders Email workflow.` : null),
          cadence: CADENCE.online_orders,
          integrationMethod: METHOD.online_orders.method,
          methodLabel: METHOD.online_orders.label,
        };
      })(),
      // Delivery orders (delivery_email_etl.py): Uber Eats receipt emails parsed over
      // IMAP → pds.delivery_orders (merchant, order/delivery time, total — the emails
      // carry no line items). Same shape as Flights: freshness = heartbeat age, since
      // a day without a delivery is healthy. Cron every 3h → >4h partial, >12h or a
      // failed row = red. A 'partial' heartbeat = a receipt the parser could not read
      // (pds.delivery_email_log status 'unmatched'/'error' — Uber changed the template).
      delivery: (() => {
        const entry = latestBySrcType["delivery|email"] ?? null;
        const ageH = entry?.sync_start ? (Date.now() - new Date(entry.sync_start as string).getTime()) / 3600000 : Infinity;
        const status: SourceStatus["status"] = !entry
          ? "unknown"
          : entry.status === "failed" || ageH > 12
            ? "failed"
            : entry.status === "partial" || ageH > 4
              ? "partial"
              : "success";
        return {
          label: "Delivery",
          lastSync: (entry?.sync_start as string) ?? null,
          status,
          latestDataDate: (deliveryRes.data?.[0]?.order_date_local as string | undefined) ?? null,
          daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string) ?? deliveryRes.error?.message ?? null,
          cadence: CADENCE.delivery,
          integrationMethod: METHOD.delivery.method,
          methodLabel: METHOD.delivery.label,
        };
      })(),
      // Air quality (air_quality_etl.py): hourly PM2.5 / US AQI from the keyless Open-Meteo
      // Air Quality API, averaged per ET day into pds.air_quality_daily for the HRV pipeline
      // (aqi_* features, aqi_pm25 causal exposure). Freshness = heartbeat age, same thresholds
      // as Flights / Delivery: cron every 3h -> >4h partial, >12h or a failed row = red. A
      // 'partial' heartbeat means the API returned no PM2.5 values for the whole window.
      air_quality: (() => {
        const entry = latestBySrcType["air_quality|daily"]
          ?? (airQualitySyncRes.data?.[0] as Record<string, unknown> | undefined)
          ?? null;
        const ageH = entry?.sync_start ? (Date.now() - new Date(entry.sync_start as string).getTime()) / 3600000 : Infinity;
        const status: SourceStatus["status"] = !entry
          ? "unknown"
          : entry.status === "failed" || entry.status === "error" || ageH > 12
            ? "failed"
            : entry.status === "partial" || ageH > 4
              ? "partial"
              : "success";
        return {
          label: "Air Quality",
          lastSync: (entry?.sync_start as string) ?? null,
          status,
          latestDataDate: (airQualityRes.data?.[0]?.calendar_date as string | undefined) ?? null,
          daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string)
            ?? (entry ? null : airQualityRes.error?.message ?? airQualitySyncRes.error?.message ?? null),
          cadence: CADENCE.air_quality,
          integrationMethod: METHOD.air_quality.method,
          methodLabel: METHOD.air_quality.label,
        };
      })(),
      // Weather (weather_etl.py): hourly outdoor weather from the keyless Open-Meteo archive
      // API, aggregated per ET day into pds.weather_daily for the HRV pipeline (wx_* features)
      // and the Weather panel on /analytics/hrv. Freshness = heartbeat age, same thresholds as
      // Air Quality: cron every 3h -> >4h partial, >12h or a failed row = red. A 'partial'
      // heartbeat means the API returned no temperature values, or the optional UV index
      // request failed (the error text says which).
      weather: (() => {
        const entry = latestBySrcType["weather|daily"]
          ?? (weatherSyncRes.data?.[0] as Record<string, unknown> | undefined)
          ?? null;
        const ageH = entry?.sync_start ? (Date.now() - new Date(entry.sync_start as string).getTime()) / 3600000 : Infinity;
        const status: SourceStatus["status"] = !entry
          ? "unknown"
          : entry.status === "failed" || entry.status === "error" || ageH > 12
            ? "failed"
            : entry.status === "partial" || ageH > 4
              ? "partial"
              : "success";
        return {
          label: "Weather",
          lastSync: (entry?.sync_start as string) ?? null,
          status,
          latestDataDate: (weatherRes.data?.[0]?.calendar_date as string | undefined) ?? null,
          daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string)
            ?? (entry ? null : weatherRes.error?.message ?? weatherSyncRes.error?.message ?? null),
          cadence: CADENCE.weather,
          integrationMethod: METHOD.weather.method,
          methodLabel: METHOD.weather.label,
        };
      })(),
      // Supplement stack reminders (sms-reminders Worker -> /api/supplements/reminders/*):
      // the Worker claims due stacks on a schedule and posts Log it / Skip cards to /agents.
      // Freshness = heartbeat age, because a day with nothing due (stacks logged early, reminders
      // off) is healthy. >3h with no poll = degraded, >8h or a failed heartbeat = red; "unknown"
      // until the Worker's first call. records_synced = stacks claimed by that call.
      supplement_reminders: (() => {
        const entry = latestBySrcType["supplement_reminders|prompt"]
          ?? (supplementRemindersSyncRes.data?.[0] as Record<string, unknown> | undefined)
          ?? null;
        const ageH = entry?.sync_start ? (Date.now() - new Date(entry.sync_start as string).getTime()) / 3600000 : Infinity;
        return {
          label: "Supplement Reminders",
          lastSync: (entry?.sync_start as string) ?? null,
          status: ingestionHeartbeatStatus("success", entry, 3, 8),
          latestDataDate: entry?.sync_start ? String(entry.sync_start).slice(0, 10) : null,
          daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string)
            ?? (entry && ageH > 8 ? `No claim call for ${Math.floor(ageH)}h - check the sms-reminders Worker's supplement reminder poll.` : null),
          cadence: CADENCE.supplement_reminders,
          integrationMethod: METHOD.supplement_reminders.method,
          methodLabel: METHOD.supplement_reminders.label,
        };
      })(),
      // Uber Eats item harvester (tools/ubereats_harvest/harvest.mjs on Riley's PC):
      // reads the signed-in web app's order history (cart items, exact delivery
      // times) and posts it to /api/delivery/items/import, which also estimates
      // kcal / macros per dish. Same shape as the Kindle card: heartbeat-driven,
      // loose thresholds because the PC may be off (>18h degraded, >48h or an
      // error row = red). 'failed' usually means the Uber session expired — run
      // `node harvest.mjs --login` on the PC. 'partial' = dishes still unestimated.
      ubereats: (() => {
        const entry = latestBySrcType["ubereats|items"]
          ?? (ubereatsSyncRes.data?.[0] as Record<string, unknown> | undefined)
          ?? null;
        const ageH = entry?.sync_start ? (Date.now() - new Date(entry.sync_start as string).getTime()) / 3600000 : Infinity;
        const status: SourceStatus["status"] = !entry
          ? "unknown"
          : entry.status === "failed" || ageH > 48
            ? "failed"
            : entry.status === "partial" || ageH > 18
              ? "partial"
              : "success";
        return {
          label: "Uber Eats Items",
          lastSync: (entry?.sync_start as string) ?? null,
          status,
          latestDataDate: entry?.sync_start ? String(entry.sync_start).slice(0, 10) : null,
          daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string) ?? null,
          cadence: CADENCE.ubereats,
          integrationMethod: METHOD.ubereats.method,
          methodLabel: METHOD.ubereats.label,
        };
      })(),
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
      // NYC apartment scout (personal-agents cloud routine). Freshness = the
      // newest "Last verified" date on a Live lead — the scout re-verifies
      // every live lead each morning, so a stalled agent shows as lag. Daily
      // cadence → shared deriveStatus thresholds (>1d partial, >3d failed).
      nyc_scout: {
        label: "NYC Scout",
        lastSync: nycDate,
        status: nyc.ok ? deriveStatus(null, nycLag) : "failed",
        latestDataDate: nycDate,
        daysLag: nycLag,
        recordsSynced: nyc.ok ? nyc.liveCount : 0,
        durationSeconds: null,
        errorMessage: nyc.ok ? null : nyc.error,
        cadence: CADENCE.nyc_scout,
        integrationMethod: METHOD.nyc_scout.method,
        methodLabel: METHOD.nyc_scout.label,
      },
      // Materialized matrix view refresh (pg_cron, every 30 min). Frontend
      // matrix reads (/analytics/hrv, /caffeine, /nutrition, /bland-altman,
      // /analytics/travel) hit the matview since 2026-06-11; a stuck refresh
      // means those pages silently serve aging data while the live view (and
      // the Python pipeline) move on — exactly the silent-staleness failure
      // mode the heartbeat convention exists to catch. Freshness is heartbeat
      // age in MINUTES (like the enrichment cards but tighter): >40 min = one
      // missed refresh (partial), >75 min = two missed (failed). A 'failed'
      // heartbeat can also be the schema-drift tripwire — the error message
      // names the columns the matview is missing.
      matrix_mat: (() => {
        const entry = (matrixMatRes.data?.[0] as Record<string, unknown> | undefined) ?? null;
        const lastSync = (entry?.sync_start as string) ?? null;
        const ageMin = lastSync ? Math.round((Date.now() - new Date(lastSync).getTime()) / 60000) : null;
        let status: SourceStatus["status"];
        if (!entry) status = "unknown";
        else if (entry.status === "failed" || ageMin === null || ageMin > 75) status = "failed";
        else if (ageMin > 40) status = "partial";
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
      // Perf matviews (pg_cron, every 30 min): tz_log_gaps_mat +
      // hrv_prediction_gaps_mat — the matviews THIS endpoint reads for the
      // travel banner and the HRV-gap check (perf round 3, 2026-06-11; the
      // live views were the two slowest Promise.all members). Same heartbeat
      // semantics + thresholds as matrix_mat: >40 min = one missed refresh
      // (partial), >75 min = two missed (failed).
      perf_mats: (() => {
        const entry = (perfMatsRes.data?.[0] as Record<string, unknown> | undefined) ?? null;
        const lastSync = (entry?.sync_start as string) ?? null;
        const ageMin = lastSync ? Math.round((Date.now() - new Date(lastSync).getTime()) / 60000) : null;
        let status: SourceStatus["status"];
        if (!entry) status = "unknown";
        else if (entry.status === "failed" || ageMin === null || ageMin > 75) status = "failed";
        else if (ageMin > 40) status = "partial";
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
      // Rocket Money ledger (pds.finance_*, read by /financials): the daily harvester and the
      // transactions + balances importers each write a rocketmoney heartbeat on every run.
      // Status is the worse of the two (>36h degraded, >72h or a failed/error row = red, a
      // "login required" failure shows the importer's own text). Heartbeat-only by design:
      // no amounts or row contents ever reach this cacheable endpoint.
      rocket_money: (() => {
        const card = financeLedgerCard(
          latestBySrcType["rocketmoney|transactions"],
          latestBySrcType["rocketmoney|balances"],
        );
        return {
          label: "Rocket Money",
          lastSync: card.lastSync,
          status: card.status,
          latestDataDate: card.latestDataDate,
          daysLag: card.lastSync ? Math.floor((Date.now() - new Date(card.lastSync).getTime()) / 86_400_000) : 999,
          recordsSynced: card.recordsSynced,
          durationSeconds: card.durationSeconds,
          errorMessage: card.errorMessage,
          cadence: CADENCE.rocket_money,
          integrationMethod: METHOD.rocket_money.method,
          methodLabel: METHOD.rocket_money.label,
        };
      })(),
      // Google Calendar (google_calendar_etl.py): the calendars' iCal feeds copied hourly into
      // pds.calendar_events for /health and Today (read-only, calendar -> Onyx). Freshness =
      // heartbeat age (an hour without a new event is healthy): hourly cron -> >3h partial, >8h or
      // a failed run red. 'partial' = one feed failed, or a malformed event or series was skipped.
      // Heartbeat only: this endpoint is CDN-cacheable, so no event row is read here.
      google_calendar: (() => {
        const entry = latestBySrcType["google_calendar|events"] ?? null;
        const ageH = entry?.sync_start ? (Date.now() - new Date(entry.sync_start as string).getTime()) / 3600000 : Infinity;
        const status: SourceStatus["status"] = !entry
          ? "unknown"
          : entry.status === "failed" || entry.status === "error" || ageH > 8
            ? "failed"
            : entry.status === "partial" || ageH > 3
              ? "partial"
              : "success";
        return {
          label: "Google Calendar",
          lastSync: (entry?.sync_start as string) ?? null,
          status,
          latestDataDate: entry?.sync_start ? String(entry.sync_start).slice(0, 10) : null,
          daysLag: Number.isFinite(ageH) ? Math.floor(ageH / 24) : 999,
          recordsSynced: (entry?.records_synced as number) ?? 0,
          durationSeconds: (entry?.duration_seconds as number) ?? null,
          errorMessage: (entry?.error_message as string)
            ?? (!entry ? "No run yet - the Google Calendar ETL workflow has not reported." : ageH > 8 ? `No run for ${Math.floor(ageH)}h - check the Google Calendar ETL workflow.` : null),
          cadence: CADENCE.google_calendar,
          integrationMethod: METHOD.google_calendar.method,
          methodLabel: METHOD.google_calendar.label,
        };
      })(),
      // Urgent email for Today: inbox-triage's Agent/Action + Agent/Deadline labels read
      // over IMAP (read-only) into pds.inbox_emails. Thresholds in getUrgentEmailStatusCard.
      urgent_email: {
        ...urgentEmailCard,
        cadence: CADENCE.urgent_email,
        integrationMethod: METHOD.urgent_email.method,
        methodLabel: METHOD.urgent_email.label,
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
