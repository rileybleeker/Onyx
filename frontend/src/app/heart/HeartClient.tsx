"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaChart, Area, LineChart, Line, CartesianGrid,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { getWhoopRecovery, getWhoopCycles, getHeartRateData, getDailySummaries, rangeDays, rangeLabel, type Range } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import RangeFilter from "@/components/RangeFilter";
import { chartColors as C, chartTooltip, axisTick, gridStyle, axisLabel } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { HeartInitial } from "./HeartLoader";

export default function HeartPage({ initial }: { initial?: HeartInitial | null }) {
  // Server-prefetched initial data (ISR, default 30d range) seeds the charts
  // so they paint immediately; the mount effect still runs as a SILENT
  // revalidation (no skeleton) because the ISR snapshot can be up to ~1h
  // stale — single-user traffic means the morning's first visit usually
  // lands on a cache regenerated last evening.
  const [recovery, setRecovery] = useState<any[]>(initial?.recovery ?? []);
  const [cycles, setCycles] = useState<any[]>(initial?.cycles ?? []);
  const [hr, setHr] = useState<any[]>(initial?.hr ?? []);
  const [summaries, setSummaries] = useState<any[]>(initial?.summaries ?? []);
  const [loading, setLoading] = useState(!initial);
  const [range, setRange] = useState<Range>("30d");
  const firstRunWithInitial = useRef(!!initial);

  useEffect(() => {
    // Silent only on the very first run when seeded — range changes show the
    // loading state as before. The cancelled flag stops a superseded slow
    // response from overwriting a newer range's data (out-of-order resolve).
    let cancelled = false;
    const silent = firstRunWithInitial.current;
    firstRunWithInitial.current = false;
    if (!silent) setLoading(true);
    const days = rangeDays(range);
    Promise.all([getWhoopRecovery(days), getWhoopCycles(days), getHeartRateData(days), getDailySummaries(days)])
      .then(([rec, cyc, h, s]) => {
        if (cancelled) return;
        setRecovery(rec); setCycles(cyc); setHr(h); setSummaries(s);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled && !silent) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [range]);

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
      </div>
    );
  }

  const latestRecovery = recovery[recovery.length - 1];
  const latestCycle = cycles[cycles.length - 1];
  const latestHr = hr[hr.length - 1];
  const latestSummary = summaries[summaries.length - 1];

  const hrData = hr.map((d) => ({
    date: formatDate(d.calendar_date),
    min: d.min_heart_rate,
    max: d.max_heart_rate,
  }));

  // WHOOP recovery provides RHR and HRV (source of truth)
  const hrvData = recovery.map((d) => ({
    date: formatDate(d.created_at?.split("T")[0]),
    rhr: d.resting_heart_rate,
    hrv: d.hrv_rmssd_milli ? +Number(d.hrv_rmssd_milli).toFixed(1) : null,
  }));

  const stressData = summaries.map((d) => ({
    date: formatDate(d.calendar_date),
    overall: d.avg_stress_level,
  }));

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Heart & HRV</h2>
          <p className="text-sm text-text-tertiary mt-0.5">Heart rate and variability trends — {rangeLabel(range)}</p>
        </div>
        <RangeFilter value={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Resting HR" value={latestRecovery?.resting_heart_rate} unit="bpm" source="WHOOP" />
        <StatCard label="Max HR" value={latestCycle?.max_heart_rate} unit="bpm" source="WHOOP" />
        <StatCard label="HRV (RMSSD)" value={latestRecovery?.hrv_rmssd_milli ? +Number(latestRecovery.hrv_rmssd_milli).toFixed(1) : null} unit="ms" source="WHOOP" />
        <StatCard label="Stress" value={latestSummary?.avg_stress_level} sublabel={latestSummary?.stress_qualifier} source="GARMIN" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <ChartCard title="Heart Rate Trends" source="GARMIN">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={hrData}>
              <defs>
                <linearGradient id="heartMaxGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.down} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={C.down} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="heartMinGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.up} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={C.up} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={55} label={axisLabel("bpm", "y")} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" }} />
              <Area type="monotone" dataKey="max" stroke={C.down} fill="url(#heartMaxGrad)" strokeWidth={1.5} name="Max" />
              <Area type="monotone" dataKey="min" stroke={C.up} fill="url(#heartMinGrad)" strokeWidth={1.5} name="Min" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Resting HR & HRV" source="WHOOP">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={hrvData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis yAxisId="rhr" tick={axisTick} width={40} />
              <YAxis yAxisId="hrv" orientation="right" tick={axisTick} width={40} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" }} />
              <Line yAxisId="rhr" type="monotone" dataKey="rhr" stroke={C.source.garmin} strokeWidth={2} dot={false} name="RHR (bpm)" />
              <Line yAxisId="hrv" type="monotone" dataKey="hrv" stroke={C.source.eightsleep} strokeWidth={2} dot={false} name="HRV RMSSD (ms)" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Stress Level" source="GARMIN">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={stressData}>
              <defs>
                <linearGradient id="heartStressGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.source.whoop} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={C.source.whoop} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={55} domain={[0, 100]} label={axisLabel("stress (0–100)", "y")} />
              <Tooltip {...chartTooltip} />
              <Area type="monotone" dataKey="overall" stroke={C.source.whoop} fill="url(#heartStressGrad)" strokeWidth={2} name="Stress Level" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
