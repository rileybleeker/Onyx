"use client";

import { useInFeed, usePageHeadingTestId } from "@/components/FeedContext";
import { useEffect, useState, useCallback, useRef, type RefObject } from "react";
import StatCard from "@/components/StatCard";
import MetricRing from "@/components/MetricRing";
import ChartCard from "@/components/ChartCard";
import { Part, PartGroup, PartGrid } from "@/components/personalize/PartGrid";
import PersonalTable, { type TableColumn } from "@/components/personalize/PersonalTable";
import { sameJson } from "@/lib/format";
import { clientCache } from "@/lib/client-cache";
import { earlyFetchScript, earlyOr } from "@/lib/early-fetch";
import SpotifyReconnect from "@/components/SpotifyReconnect";
import KindleRunNow from "@/components/KindleRunNow";
import { needsSpotifyReconnect } from "@/lib/spotify-reconnect";
import type { DriftAlert, SourceStatus, StatusResponse, TzGapRow } from "@/app/api/status/route";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SOURCE_BADGE: Record<string, string> = {
  garmin: "GARMIN",
  whoop: "WHOOP",
  eight_sleep: "8SLP",
  habits: "NOTION",
  notion_journal: "NOTION",
  cronometer: "CRON",
  hrv_analysis: "ML",
  hrv_retrain: "ML",
  experiments: "N-OF-1",
  spotify: "SPOTIFY",
  reccobeats: "RECCOBEATS",
  musicbrainz: "MUSICBRAINZ",
  supplements: "DSLD",
  reading: "BOOK",
  procurement: "SUBS",
  photo_meals: "PHOTO",
  kindle: "KINDLE",
  reading_bank: "CLAUDE",
  amazon_orders: "AMAZON",
  screen_usage: "IPHONE",
  tanita: "TANITA",
  flights: "DELTA",
  delivery: "UBER EATS",
  online_orders: "GMAIL",
  air_quality: "OPEN-METEO",
  weather: "OPEN-METEO",
  pollen: "ATL ALLERGY",
  supplement_reminders: "AGENTS",
  renewal_reminders: "AGENTS",
  cash_forecast: "FORECAST",
  urgent_email: "GMAIL",
  phone_messages: "IPHONE",
  google_calendar: "GOOGLE",
  care_calendar: "GOOGLE",
  ubereats: "UBER EATS",
  gopuff: "GOPUFF",
  pc_activity: "PC",
  uber_rides: "UBER",
  ai_usage: "PC",
  youtube: "TAKEOUT",
  medical_backup: "PC",
  nyc_scout: "AGENT",
  simplefin: "SIMPLEFIN",
  matrix_mat: "DB",
  perf_mats: "DB",
};

const SOURCE_BADGE_COLOR: Record<string, string> = {
  garmin: "text-source-garmin",
  whoop: "text-source-whoop",
  eight_sleep: "text-source-eightsleep",
  habits: "text-text-tertiary",
  notion_journal: "text-text-tertiary",
  cronometer: "text-text-tertiary",
  hrv_analysis: "text-blue-400",
  hrv_retrain: "text-blue-400/70",
  experiments: "text-violet-300",
  spotify: "text-source-spotify",
  reccobeats: "text-source-spotify/70",
  musicbrainz: "text-source-spotify/70",
  supplements: "text-amber-400",
  reading: "text-amber-300",
  procurement: "text-amber-300",
  photo_meals: "text-emerald-300",
  kindle:"text-amber-300/70",
  reading_bank: "text-amber-300/70",
  amazon_orders: "text-orange-300",
  screen_usage: "text-fuchsia-400/70",
  tanita: "text-amber-500",
  flights: "text-indigo-400",
  delivery: "text-emerald-400",
  online_orders: "text-orange-300",
  air_quality: "text-teal-400",
  weather: "text-sky-400",
  pollen: "text-yellow-300",
  supplement_reminders: "text-amber-400/70",
  renewal_reminders: "text-amber-300/70",
  cash_forecast: "text-amber-300/70",
  urgent_email: "text-rose-400",
  phone_messages: "text-lime-400",
  google_calendar: "text-blue-300",
  care_calendar: "text-blue-300/70",
  ubereats: "text-emerald-400/70",
  gopuff: "text-sky-400/70",
  pc_activity: "text-slate-300",
  uber_rides: "text-emerald-400/70",
  ai_usage: "text-violet-300",
  youtube: "text-red-300",
  medical_backup: "text-emerald-300",
  nyc_scout: "text-sky-400",
  simplefin: "text-lime-400",
  matrix_mat: "text-cyan-400/70",
  perf_mats: "text-cyan-400/70",
};

const STATUS_DOT: Record<string, string> = {
  success: "bg-green-400",
  partial: "bg-yellow-400",
  failed: "bg-red-400",
  unknown: "bg-white/20",
};

const STATUS_LABEL: Record<string, string> = {
  success: "Healthy",
  partial: "Degraded",
  failed: "Error",
  unknown: "Unknown",
};

const STATUS_TEXT: Record<string, string> = {
  success: "text-green-400",
  partial: "text-yellow-400",
  failed: "text-red-400",
  unknown: "text-text-tertiary",
};

// Color coding for the Method row:
// - automated:      blue/cyan — runs on its own, no action needed
// - semi-automated: amber-300 — requires periodic user export (WHOOP / MFP)
// - manual:         amber-500 — user enters data directly via the UI
const METHOD_COLOR: Record<string, string> = {
  automated: "text-cyan-400",
  "semi-automated": "text-amber-300",
  manual: "text-amber-500",
};

const SOURCE_ORDER = [
  "garmin",
  "whoop",
  "eight_sleep",
  "habits",
  "notion_journal",
  "cronometer",
  "hrv_analysis",
  "hrv_retrain",
  "experiments",
  "spotify",
  "reccobeats",
  "musicbrainz",
  "supplements",
  "reading",
  "procurement",
  "photo_meals",
  "kindle",
  "reading_bank",
  "amazon_orders",
  "screen_usage",
  "tanita",
  "flights",
  "delivery",
  "online_orders",
  "air_quality",
  "weather",
  "pollen",
  "supplement_reminders",
  "renewal_reminders",
  "cash_forecast",
  "urgent_email",
  "phone_messages",
  "google_calendar",
  "care_calendar",
  "ubereats",
  "gopuff",
  "pc_activity",
  "uber_rides",
  "ai_usage",
  "youtube",
  "medical_backup",
  "nyc_scout",
  "simplefin",
  "matrix_mat",
  "perf_mats",
];

function formatRelativeTime(isoStr: string | null): string {
  if (!isoStr) return "Never";
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatDateShort(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatSyncTime(isoStr: string | null): string {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}

const HISTORY_TH = "text-left text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal py-2 pr-4";
const HISTORY_TH_RIGHT = "text-right text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal py-2 pr-4";

/** Sync History columns (personalizable: Personalize -> Columns, or the menu on each header). */
const HISTORY_COLUMNS: TableColumn[] = [
  { id: "source", label: "Source", locked: true, th: HISTORY_TH, td: "py-2 pr-4 font-mono font-medium text-text-secondary" },
  { id: "type", label: "Type", th: HISTORY_TH, td: "py-2 pr-4 text-text-tertiary" },
  { id: "time", label: "Time", th: HISTORY_TH, td: "py-2 pr-4 text-text-tertiary whitespace-nowrap" },
  { id: "status", label: "Status", th: HISTORY_TH, td: "py-2 pr-4" },
  { id: "records", label: "Records", th: HISTORY_TH_RIGHT, td: "py-2 pr-4 text-right font-mono text-text-secondary tabular-nums" },
  { id: "duration", label: "Duration", th: HISTORY_TH_RIGHT, td: "py-2 pr-4 text-right font-mono text-text-tertiary tabular-nums" },
];

/**
 * The source-card section's grid: the dense tile columns (1 / 2 / 3 / 5), one card per cell. Widths chosen in
 * Personalize still apply here: Full takes the row, Half two cells from 640 px; Third and Quarter stay one cell.
 */
const SOURCE_TILES_GRID =
  "pz-grid pz-tiles [&>[data-w=full]]:col-span-full! sm:[&>[data-w=half]]:col-span-2!";

function SourceCard({ sourceKey, info, onRefresh }: { sourceKey: string; info: SourceStatus; onRefresh?: () => void }) {
  const badge = SOURCE_BADGE[sourceKey] ?? sourceKey.toUpperCase();
  const badgeColor = SOURCE_BADGE_COLOR[sourceKey] ?? "text-text-tertiary";
  const dotColor = STATUS_DOT[info.status];
  const statusText = STATUS_TEXT[info.status];
  const statusLabel = STATUS_LABEL[info.status];

  return (
    <div className="bg-surface-card border border-border-subtle rounded-card p-5 shadow-card transition-colors hover:border-border-hover">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <p className="text-[15px] font-medium text-text-primary">{info.label}</p>
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor}`} />
            <span className={`text-[12px] font-medium ${statusText}`}>{statusLabel}</span>
          </div>
        </div>
        <span className={`text-[9px] font-mono font-medium tracking-wider ${badgeColor}`}>{badge}</span>
      </div>

      {/* Detail rows */}
      <div className="space-y-2">
        {info.methodLabel && (
          <DetailRow
            label="Method"
            value={info.methodLabel}
            sub={info.integrationMethod === "semi-automated" ? "Requires manual export" : undefined}
            valueClass={METHOD_COLOR[info.integrationMethod] ?? "text-text-secondary"}
          />
        )}
        {info.cadence && <DetailRow label="Cadence" value={info.cadence} />}
        <DetailRow label="Last Sync" value={formatRelativeTime(info.lastSync)} sub={info.lastSync ? formatSyncTime(info.lastSync) : undefined} />
        <DetailRow label="Latest Data" value={info.latestDataDate ? formatDateShort(info.latestDataDate) : "—"} />
        <DetailRow
          label="Days Behind"
          value={info.daysLag === 999 ? "—" : `${info.daysLag}d`}
          valueClass={info.daysLag > 3 ? "text-red-400" : info.daysLag > 1 ? "text-yellow-400" : "text-green-400"}
        />
        <DetailRow label="Records Synced" value={info.recordsSynced > 0 ? info.recordsSynced.toLocaleString() : "—"} />
        {info.durationSeconds != null && (
          <DetailRow label="Duration" value={`${info.durationSeconds.toFixed(1)}s`} />
        )}
        {info.extraRows?.map((row) => <DetailRow key={row.label} label={row.label} value={row.value} />)}
      </div>

      {/* Error box */}
      {info.errorMessage && (
        <div className="mt-3 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-control">
          <p className="text-[11px] text-red-400 font-mono break-all">{info.errorMessage}</p>
        </div>
      )}

      {/* Spotify: the refresh token dies 180 days after authorization. Offer the reconnect when the
          sync error says so, and from day 165 (reconnectBy) before it happens. */}
      {sourceKey === "spotify" && (needsSpotifyReconnect(info.errorMessage) || info.reconnectBy) && (
        <SpotifyReconnect reconnectBy={info.reconnectBy} />
      )}

      {/* Kindle: ask the PC to harvest now (event driven: a Realtime push to the PC's idle listener). */}
      {sourceKey === "kindle" && <KindleRunNow onDone={onRefresh} />}
    </div>
  );
}

function DetailRow({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string | number;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-text-tertiary uppercase tracking-[0.08em] font-medium shrink-0">{label}</span>
      <div className="text-right">
        <span className={`text-[13px] font-mono font-medium text-text-secondary tabular-nums ${valueClass ?? ""}`}>
          {value}
        </span>
        {sub && <p className="text-[10px] text-text-tertiary/60 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

const HISTORY_SOURCE_LABELS: Record<string, string> = {
  garmin: "Garmin",
  whoop: "WHOOP",
  eight_sleep: "8Sleep",
  cronometer: "Cronometer",
  myfitnesspal: "MFP",
  spotify: "Spotify",
  reccobeats: "ReccoBeats",
  musicbrainz: "MusicBrainz",
  notion_journal: "Notion Journal",
  hrv_analysis: "HRV Retrain",
  experiments: "Experiments",
  tanita: "Tanita",
  kindle: "Kindle",
  reading_bank: "Reading Questions",
  amazon: "Amazon Orders",
  screen_time: "Screen Time app",
  flights: "Flights",
  delivery: "Delivery",
  online_orders: "Online Orders",
  air_quality: "Air Quality",
  weather: "Weather",
  pollen: "Pollen",
  supplement_reminders: "Supplement Reminders",
  procurement_renewals: "Renewal Reminders",
  finance_forecast: "Cash Forecast",
  urgent_email: "Urgent Email",
  phone_messages: "iPhone Messages",
  google_calendar: "Google Calendar",
  ubereats: "Uber Eats Items",
  gopuff: "goPuff Items",
  pc_activity: "PC Activity",
  uber_rides: "Uber Rides",
  ai_usage: "AI Tool Usage",
  youtube: "YouTube History",
  backup: "Medical Backup",
  rocketmoney: "Rocket Money",
  simplefin: "SimpleFIN",
  matrix_mat: "Matrix Matview",
  perf_mats: "Perf Matviews",
};

const HISTORY_TYPE_LABELS: Record<string, string> = {
  full_sync: "Full Sync",
  cycles_backfill: "Cycles Backfill",
  trends: "Trends",
  temp_selfheal: "Temp Self-Heal",
  journal_email: "Journal Email",
  nutrition: "Nutrition",
  daily: "Daily Totals",
  servings: "Food Log",
  plays: "Plays",
  audio_features: "Audio Features",
  artist_tags: "Artist Tags",
  entries: "Entries",
  usage: "Usage",
  sessions: "Sessions",
  history: "Watch history",
  retrain: "Retrain",
  backfill_check: "Backfill Check",
  report: "Trial Report",
  admin: "Trial Admin",
  weight: "Weight",
  highlights: "Highlights",
  items: "Order Items",
  email: "Email Parse",
  labels: "Labels",
  push: "Push",
  events: "Events",
  refresh: "Refresh",
  prompt: "Reminder Poll",
  transactions: "Transactions",
  balances: "Balances",
  keepalive: "Keep-alive",
  snapshot: "Snapshot",
  generate: "Generate",
  medical_records: "Medical Records",
};

// "refreshed Xm ago" label, isolated from the page render cycle (perf round
// 3, 2026-06-11): refreshedAt lives in a REF in the parent — a successful
// poll whose payload is unchanged must not re-render the whole page just to
// move this label. The label still has to age (and pick up new refresh
// instants), so this tiny component re-reads the ref on its own 10s tick;
// only this one <span> re-renders, never the cards/table above it.
function RefreshedLabel({ refreshedAtRef }: { refreshedAtRef: RefObject<Date | null> }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10000);
    return () => clearInterval(t);
  }, []);
  const refreshedAt = refreshedAtRef.current;
  if (!refreshedAt) return null;
  return (
    <span className="ml-2 text-text-tertiary/60">· refreshed {formatRelativeTime(refreshedAt.toISOString())}</span>
  );
}

const STATUS_URL = "/api/status";
// The page's one read starts with the HTML instead of after the JavaScript and hydration (lib/early-fetch.ts; speed
// budget, 2026-11-15: the cold first visit took 1022 ms in perf-timing run 43676849680). Same request as load()'s
// own fetch (the browser's default cache mode: /api/status is edge-cached for 30 s; it answers `private, no-store`, so
// the browser never keeps a copy on disk). GET only.
const STATUS_EARLY = earlyFetchScript(STATUS_URL, false, { noStore: false });

export default function StatusPage() {
  // The script is in the static HTML of the routed page only. React never runs a script it inserts itself, so an
  // in-app navigation leaves an inert copy and the scroll's copy (FeedSection) renders none.
  const inFeed = useInFeed();
  return (
    <>
      {!inFeed && <script dangerouslySetInnerHTML={{ __html: STATUS_EARLY }} />}
      <StatusView early={!inFeed} />
    </>
  );
}

function StatusView({ early }: { early: boolean }) {
  // "feed-page-heading" when this page is shown inside the continuous scroll (components/ContinuousScroll.tsx).
  const headingTestId = usePageHeadingTestId();
  // Start from the in-memory copy (instant revisit this session), then revalidate. Never from the device: /api/status
  // carries heartbeat error text, so it is a memory-only key (lib/client-cache.ts isSensitiveKey).
  const [data, setData] = useState<StatusResponse | null>(() => clientCache.peek<StatusResponse>(STATUS_URL) ?? null);
  const [loading, setLoading] = useState(() => data === null);
  const refreshedAtRef = useRef<Date | null>(null);
  // The first load of a full page visit takes the GET the HTML started (once); later polls fetch for themselves.
  const firstLoad = useRef(early);

  const load = useCallback(async () => {
    try {
      const get = () => fetch(STATUS_URL);
      const takeEarly = firstLoad.current;
      firstLoad.current = false;
      const res = await (takeEarly ? earlyOr(STATUS_URL, get) : get());
      if (res.ok) {
        const fresh: StatusResponse = await res.json();
        clientCache.put(STATUS_URL, fresh);
        // Bail out of the commit when the poll returned the same payload
        // (perf round 3): fetchedAt is volatile — the server stamps it on
        // every response — so compare everything EXCEPT it, or the guard
        // would never fire. Returning `prev` keeps the state reference
        // stable and React skips the re-render entirely.
        setData((prev) =>
          prev && sameJson({ ...prev, fetchedAt: null }, { ...fresh, fetchedAt: null })
            ? prev
            : fresh
        );
        refreshedAtRef.current = new Date();
      }
    } catch (e) {
      console.error("Failed to fetch status:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Visibility-gated poll (perf round 3): a backgrounded tab kept hitting
    // /api/status every 60s for nothing — skip the tick while hidden, and
    // refresh immediately on return to visible so the page never shows a
    // stale snapshot after a long time away.
    const interval = setInterval(() => {
      if (document.visibilityState !== "hidden") load();
    }, 60000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-white/5 animate-pulse rounded" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4 space-y-3">
              <div className="h-3 w-16 bg-white/5 animate-pulse rounded" />
              <div className="h-8 w-24 bg-white/5 animate-pulse rounded" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-surface-card border border-border-subtle rounded-card shadow-card p-5 space-y-4 h-40">
              <div className="h-4 w-28 bg-white/5 animate-pulse rounded" />
              <div className="space-y-2">
                {[...Array(3)].map((_, j) => (
                  <div key={j} className="h-3 bg-white/5 animate-pulse rounded" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const sources = data?.sources ?? {};
  const history = data?.recentHistory ?? [];
  const driftAlerts: DriftAlert[] = data?.driftAlerts ?? [];
  const tzGaps: TzGapRow[] = data?.tzGaps ?? [];

  // Group tz_log_gaps into contiguous date ranges per (offset, tz) for a
  // less spammy banner: "Apr 30 → May 3 (+02:00)" reads cleaner than 4
  // separate dates per trip.
  const tzGapRanges: Array<{ from: string; to: string; offset: string; tz: string; days: number }> = (() => {
    if (tzGaps.length === 0) return [];
    const sorted = [...tzGaps].sort((a, b) => a.gapEtDate.localeCompare(b.gapEtDate));
    const out: typeof tzGapRanges = [];
    let cur: (typeof tzGapRanges)[number] | null = null;
    for (const g of sorted) {
      const nextDay = (d: string) => {
        const dt = new Date(d + "T00:00:00Z");
        dt.setUTCDate(dt.getUTCDate() + 1);
        return dt.toISOString().slice(0, 10);
      };
      if (cur && cur.offset === g.sourceOffset && cur.tz === g.logResolvedTz && nextDay(cur.to) === g.gapEtDate) {
        cur.to = g.gapEtDate;
        cur.days += 1;
      } else {
        if (cur) out.push(cur);
        cur = { from: g.gapEtDate, to: g.gapEtDate, offset: g.sourceOffset, tz: g.logResolvedTz, days: 1 };
      }
    }
    if (cur) out.push(cur);
    return out.sort((a, b) => b.from.localeCompare(a.from));
  })();

  // KPI calculations
  const sourceList = SOURCE_ORDER.map((k) => ({ key: k, info: sources[k] })).filter((s) => !!s.info);
  const sourcesOnline = sourceList.filter((s) => s.info.status === "success" && s.info.daysLag <= 1).length;
  const activeErrors = sourceList.filter((s) => s.info.status === "failed" || s.info.errorMessage).length;

  const allLastSyncs = sourceList.map((s) => s.info.lastSync).filter(Boolean) as string[];
  const mostRecentSync = allLastSyncs.length > 0
    ? allLastSyncs.reduce((a, b) => (new Date(a) > new Date(b) ? a : b))
    : null;

  // "Records · Latest Today" sums the records_synced from each source's
  // MOST-RECENT sync, when that sync happened today. It's the headline
  // count for "what got pulled in by the most recent runs today" — not the
  // total of every row synced today (which would need a server-side sum
  // over sync_log). Labeled accordingly so the math is honest.
  const todayStr = new Date().toLocaleDateString("en-CA");
  const recordsLatestToday = sourceList.reduce((sum, s) => {
    const lastSyncDate = s.info.lastSync ? new Date(s.info.lastSync).toLocaleDateString("en-CA") : null;
    return sum + (lastSyncDate === todayStr ? s.info.recordsSynced : 0);
  }, 0);

  return (
    <>
      {/* Page header */}
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h2 data-testid={headingTestId} className="text-[28px] font-medium text-text-primary">System Status</h2>
          <p className="text-sm text-text-tertiary mt-0.5">
            ETL pipeline health and data freshness
            <RefreshedLabel refreshedAtRef={refreshedAtRef} />
          </p>
        </div>
        <button
          onClick={load}
          className="px-3 py-1.5 text-[13px] font-medium bg-white/5 text-text-secondary border border-border-subtle rounded-control hover:bg-white/10 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Personalize: every banner, KPI tile, source card and the history table is its own part; parts move
          within their section and into any other section of the page. */}
      <PartGrid page="/status" title="System Status">
      <PartGroup id="kpis" title="Overview">
      {/* tz_log_gaps banner — per ADR-0001 drastic-TZ-abroad gap #3. WHOOP
          cycles whose offset disagrees with pds.tz_for_instant — Riley
          likely traveled but forgot to add a user_tz_log entry. */}
      {tzGapRanges.length > 0 && (
        <Part id="tz-gaps" title="Travel without a log entry">
        <div className="border border-yellow-500/30 bg-yellow-500/10 rounded-control p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 rounded-full bg-yellow-400" />
            <p className="text-[13px] font-medium text-yellow-300">
              Travel detected without log entry
              {tzGapRanges.length > 1 ? ` — ${tzGapRanges.length} trips` : ""}
            </p>
          </div>
          <ul className="space-y-1.5 mb-2">
            {tzGapRanges.slice(0, 8).map((r, i) => (
              <li key={i} className="text-[12px] text-yellow-200/90 font-mono">
                <span className="text-yellow-300/60 mr-2">
                  {r.from}{r.from !== r.to ? ` → ${r.to}` : ""}
                </span>
                offset {r.offset} (log says {r.tz})
                <span className="text-yellow-300/50 ml-2">
                  {r.days} {r.days === 1 ? "day" : "days"}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-yellow-300/60 leading-relaxed">
            Add rows to <code className="text-yellow-200/80">pds.user_tz_log</code> for these trips so behavioral-date attribution uses the right TZ.
            Example:{" "}
            <code className="text-yellow-200/80">{`INSERT INTO pds.user_tz_log(effective_from, tz) VALUES ('${tzGapRanges[0].from}T00:00:00Z', 'Europe/Berlin');`}</code>
          </p>
        </div>
        </Part>
      )}

      {/* Drift alerts banner */}
      {driftAlerts.length > 0 && (
        <Part id="drift-alerts" title="HRV model drift">
        <div className="border border-red-500/30 bg-red-500/10 rounded-control p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 rounded-full bg-red-400" />
            <p className="text-[13px] font-medium text-red-300">
              HRV Model Drift{driftAlerts.length > 1 ? ` — ${driftAlerts.length} alerts` : ""}
            </p>
          </div>
          <ul className="space-y-1.5">
            {driftAlerts.slice(0, 5).map((a, i) => (
              <li key={a.id ?? i} className="text-[12px] text-red-300/90 font-mono">
                <span className="text-red-300/60 mr-2">{formatRelativeTime(a.raisedAt)}</span>
                {a.message}
              </li>
            ))}
          </ul>
        </div>
        </Part>
      )}

      {/* KPI tiles */}
      <Part id="sources-online" title="Sources Online" width="quarter">
        <div className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4 flex items-center justify-center">
          <MetricRing
            label="Sources Online"
            value={sourcesOnline}
            max={sourceList.length || 1}
            zone
            centerValue={`${sourcesOnline}/${sourceList.length}`}
            sublabel="fresh within 24h"
            size={120}
          />
        </div>
      </Part>
      <Part id="last-etl-run" title="Last ETL Run" width="quarter">
        <StatCard
          label="Last ETL Run"
          value={mostRecentSync ? formatRelativeTime(mostRecentSync) : "—"}
          sublabel={mostRecentSync ? formatSyncTime(mostRecentSync) : "No data"}
        />
      </Part>
      <Part id="records-today" title="Records · Latest Today" width="quarter">
        <StatCard
          label="Records · Latest Today"
          value={recordsLatestToday > 0 ? recordsLatestToday.toLocaleString() : "—"}
          sublabel="latest run per source"
        />
      </Part>
      <Part id="active-errors" title="Active Errors" width="quarter">
        <StatCard
          label="Active Errors"
          value={activeErrors}
          sublabel={activeErrors === 0 ? "all sources healthy" : `${activeErrors} source${activeErrors !== 1 ? "s" : ""} need attention`}
        />
      </Part>
      </PartGroup>

      {/* Source cards: one part per source (ids = source keys, kept from the earlier tile zone so saved
          orders still apply). The group keeps the dense tile columns; Full / Half widen a card in it. */}
      <PartGroup id="sources" title="Source cards" gridClassName={SOURCE_TILES_GRID}>
        {sourceList.map(({ key, info }) => (
          <Part key={key} id={key} title={info.label} width="quarter">
            <SourceCard sourceKey={key} info={info} onRefresh={load} />
          </Part>
        ))}
      </PartGroup>

      {/* Sync history */}
      <PartGroup id="history" title="Sync History">
      {history.length > 0 && (
        <Part id="sync-history" title="Sync History">
        <ChartCard title="Sync History" subtitle="Last 20 pipeline runs">
          <div className="overflow-x-auto">
            <PersonalTable
              id="sync-history"
              className="w-full text-[12px]"
              headRowClassName="border-b border-white/5"
              columns={HISTORY_COLUMNS}
              rows={history.map((row: any, i: number) => {
                const isSuccess = row.status === "success";
                const isPartial = row.status === "partial";
                return {
                  key: String(i),
                  className: "border-b border-white/[0.03] hover:bg-white/[0.02]",
                  cells: {
                    source: HISTORY_SOURCE_LABELS[row.source] ?? row.source,
                    type: HISTORY_TYPE_LABELS[row.data_type] ?? row.data_type,
                    time: formatSyncTime(row.sync_start),
                    status: (
                      <span
                        className={`inline-flex items-center gap-1 text-[10px] font-medium font-mono px-1.5 py-0.5 rounded-[3px] ${
                          isSuccess
                            ? "bg-green-500/10 text-green-400"
                            : isPartial
                            ? "bg-yellow-500/10 text-yellow-400"
                            : "bg-red-500/10 text-red-400"
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            isSuccess ? "bg-green-400" : isPartial ? "bg-yellow-400" : "bg-red-400"
                          }`}
                        />
                        {row.status}
                      </span>
                    ),
                    records: row.records_synced > 0 ? row.records_synced.toLocaleString() : "—",
                    duration: row.duration_seconds != null ? `${(row.duration_seconds as number).toFixed(1)}s` : "—",
                  },
                };
              })}
            />
          </div>
        </ChartCard>
        </Part>
      )}
      </PartGroup>
      </PartGrid>
    </>
  );
}
