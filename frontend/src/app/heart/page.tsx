"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, LineChart, Line, CartesianGrid,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { getWhoopRecovery, getWhoopCycles, getHeartRateData, getDailySummaries } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import { chartTooltip, axisTick, gridStyle, axisLabel } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function HeartPage() {
  const [recovery, setRecovery] = useState<any[]>([]);
  const [cycles, setCycles] = useState<any[]>([]);
  const [hr, setHr] = useState<any[]>([]);
  const [summaries, setSummaries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getWhoopRecovery(30), getWhoopCycles(30), getHeartRateData(30), getDailySummaries(30)])
      .then(([rec, cyc, h, s]) => { setRecovery(rec); setCycles(cyc); setHr(h); setSummaries(s); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

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
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Heart & HRV</h2>
          <p className="text-sm text-text-tertiary mt-0.5">30-day heart rate and variability trends</p>
        </div>
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
                  <stop offset="0%" stopColor="#ef4444" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="heartMinGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={55} label={axisLabel("bpm", "y")} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" }} />
              <Area type="monotone" dataKey="max" stroke="#ef4444" fill="url(#heartMaxGrad)" strokeWidth={1.5} name="Max" />
              <Area type="monotone" dataKey="min" stroke="#22c55e" fill="url(#heartMinGrad)" strokeWidth={1.5} name="Min" />
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
              <Line yAxisId="rhr" type="monotone" dataKey="rhr" stroke="#3b82f6" strokeWidth={2} dot={false} name="RHR (bpm)" />
              <Line yAxisId="hrv" type="monotone" dataKey="hrv" stroke="#8b5cf6" strokeWidth={2} dot={false} name="HRV RMSSD (ms)" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Stress Level" source="GARMIN">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={stressData}>
              <defs>
                <linearGradient id="heartStressGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f97316" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#f97316" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={55} domain={[0, 100]} label={axisLabel("stress (0–100)", "y")} />
              <Tooltip {...chartTooltip} />
              <Area type="monotone" dataKey="overall" stroke="#f97316" fill="url(#heartStressGrad)" strokeWidth={2} name="Stress Level" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
