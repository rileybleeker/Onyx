"use client";

import { useEffect, useState, useCallback } from "react";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import type { DriftAlert, SourceStatus, StatusResponse } from "@/app/api/status/route";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SOURCE_BADGE: Record<string, string> = {
  garmin: "GARMIN",
  whoop: "WHOOP",
  eight_sleep: "8SLP",
  whoop_journal: "WHOOP",
  habits: "NOTION",
  myfitnesspal: "MFP",
  hrv_analysis: "ML",
};

const SOURCE_BADGE_COLOR: Record<string, string> = {
  garmin: "text-source-garmin",
  whoop: "text-source-whoop",
  eight_sleep: "text-source-eightsleep",
  whoop_journal: "text-source-whoop",
  habits: "text-text-tertiary",
  myfitnesspal: "text-text-tertiary",
  hrv_analysis: "text-blue-400",
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

const SOURCE_ORDER = ["garmin", "whoop", "eight_sleep", "whoop_journal", "habits", "myfitnesspal", "hrv_analysis"];

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

function SourceCard({ sourceKey, info }: { sourceKey: string; info: SourceStatus }) {
  const badge = SOURCE_BADGE[sourceKey] ?? sourceKey.toUpperCase();
  const badgeColor = SOURCE_BADGE_COLOR[sourceKey] ?? "text-text-tertiary";
  const dotColor = STATUS_DOT[info.status];
  const statusText = STATUS_TEXT[info.status];
  const statusLabel = STATUS_LABEL[info.status];

  return (
    <div className="bg-surface-card border border-border-subtle rounded-[6px] p-5 shadow-card transition-colors hover:border-border-hover">
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
      </div>

      {/* Error box */}
      {info.errorMessage && (
        <div className="mt-3 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-[4px]">
          <p className="text-[11px] text-red-400 font-mono break-all">{info.errorMessage}</p>
        </div>
      )}
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
  myfitnesspal: "MFP",
};

const HISTORY_TYPE_LABELS: Record<string, string> = {
  full_sync: "Full Sync",
  trends: "Trends",
  journal_email: "Journal Email",
  nutrition: "Nutrition",
};

export default function StatusPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (res.ok) {
        const json = await res.json();
        setData(json);
        setRefreshedAt(new Date());
      }
    } catch (e) {
      console.error("Failed to fetch status:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-white/5 animate-pulse rounded" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-surface-card border border-border-subtle rounded-[6px] p-4 space-y-3">
              <div className="h-3 w-16 bg-white/5 animate-pulse rounded" />
              <div className="h-8 w-24 bg-white/5 animate-pulse rounded" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-surface-card border border-border-subtle rounded-[6px] p-5 space-y-4 h-40">
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

  // KPI calculations
  const sourceList = SOURCE_ORDER.map((k) => ({ key: k, info: sources[k] })).filter((s) => !!s.info);
  const sourcesOnline = sourceList.filter((s) => s.info.status === "success" && s.info.daysLag <= 1).length;
  const activeErrors = sourceList.filter((s) => s.info.status === "failed" || s.info.errorMessage).length;

  const allLastSyncs = sourceList.map((s) => s.info.lastSync).filter(Boolean) as string[];
  const mostRecentSync = allLastSyncs.length > 0
    ? allLastSyncs.reduce((a, b) => (new Date(a) > new Date(b) ? a : b))
    : null;

  const todayStr = new Date().toLocaleDateString("en-CA");
  const recordsToday = sourceList.reduce((sum, s) => {
    const lastSyncDate = s.info.lastSync ? new Date(s.info.lastSync).toLocaleDateString("en-CA") : null;
    return sum + (lastSyncDate === todayStr ? s.info.recordsSynced : 0);
  }, 0);

  return (
    <>
      {/* Page header */}
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">System Status</h2>
          <p className="text-sm text-text-tertiary mt-0.5">
            ETL pipeline health and data freshness
            {refreshedAt && (
              <span className="ml-2 text-text-tertiary/60">· refreshed {formatRelativeTime(refreshedAt.toISOString())}</span>
            )}
          </p>
        </div>
        <button
          onClick={load}
          className="px-3 py-1.5 text-[13px] font-medium bg-white/5 text-text-secondary border border-border-subtle rounded-[6px] hover:bg-white/10 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Drift alerts banner */}
      {driftAlerts.length > 0 && (
        <div className="mb-6 border border-red-500/30 bg-red-500/10 rounded-[6px] p-4">
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
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Sources Online"
          value={`${sourcesOnline} / ${sourceList.length}`}
          sublabel="fresh within 24h"
        />
        <StatCard
          label="Last ETL Run"
          value={mostRecentSync ? formatRelativeTime(mostRecentSync) : "—"}
          sublabel={mostRecentSync ? formatSyncTime(mostRecentSync) : "No data"}
        />
        <StatCard
          label="Records Today"
          value={recordsToday > 0 ? recordsToday.toLocaleString() : "—"}
          sublabel="rows synced"
        />
        <StatCard
          label="Active Errors"
          value={activeErrors}
          sublabel={activeErrors === 0 ? "all sources healthy" : `${activeErrors} source${activeErrors !== 1 ? "s" : ""} need attention`}
        />
      </div>

      {/* Source cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 mb-8">
        {sourceList.map(({ key, info }) => (
          <SourceCard key={key} sourceKey={key} info={info} />
        ))}
      </div>

      {/* Sync history */}
      {history.length > 0 && (
        <ChartCard title="Sync History" subtitle="Last 20 pipeline runs">
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal py-2 pr-4">Source</th>
                  <th className="text-left text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal py-2 pr-4">Type</th>
                  <th className="text-left text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal py-2 pr-4">Time</th>
                  <th className="text-left text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal py-2 pr-4">Status</th>
                  <th className="text-right text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal py-2 pr-4">Records</th>
                  <th className="text-right text-text-tertiary uppercase text-[10px] font-mono tracking-wider font-normal py-2">Duration</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row: any, i: number) => {
                  const isSuccess = row.status === "success";
                  const isPartial = row.status === "partial";
                  return (
                    <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                      <td className="py-2 pr-4 font-mono font-medium text-text-secondary">
                        {HISTORY_SOURCE_LABELS[row.source] ?? row.source}
                      </td>
                      <td className="py-2 pr-4 text-text-tertiary">
                        {HISTORY_TYPE_LABELS[row.data_type] ?? row.data_type}
                      </td>
                      <td className="py-2 pr-4 text-text-tertiary whitespace-nowrap">
                        {formatSyncTime(row.sync_start)}
                      </td>
                      <td className="py-2 pr-4">
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
                      </td>
                      <td className="py-2 pr-4 text-right font-mono text-text-secondary tabular-nums">
                        {row.records_synced > 0 ? row.records_synced.toLocaleString() : "—"}
                      </td>
                      <td className="py-2 text-right font-mono text-text-tertiary tabular-nums">
                        {row.duration_seconds != null ? `${(row.duration_seconds as number).toFixed(1)}s` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ChartCard>
      )}
    </>
  );
}
