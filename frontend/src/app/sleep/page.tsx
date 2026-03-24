"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar, CartesianGrid,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { getWhoopSleep, getWhoopRecovery } from "@/lib/queries";
import { formatDate, formatDuration } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import { chartTooltip, axisTick, gridStyle } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function SleepPage() {
  const [data, setData] = useState<any[]>([]);
  const [recovery, setRecovery] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getWhoopSleep(30), getWhoopRecovery(30)])
      .then(([s, r]) => { setData(s); setRecovery(r); })
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

  const latest = data[data.length - 1];
  const latestRecovery = recovery[recovery.length - 1];

  // Build a map of cycle_id → recovery for joining
  const recoveryByCycle = new Map(recovery.map((r) => [r.cycle_id, r]));

  const durationData = data.map((d) => ({
    date: formatDate(d.start_time?.split("T")[0]),
    deep: d.total_slow_wave_sleep_time_milli ? +(d.total_slow_wave_sleep_time_milli / 3600000).toFixed(2) : 0,
    light: d.total_light_sleep_time_milli ? +(d.total_light_sleep_time_milli / 3600000).toFixed(2) : 0,
    rem: d.total_rem_sleep_time_milli ? +(d.total_rem_sleep_time_milli / 3600000).toFixed(2) : 0,
    awake: d.total_awake_time_milli ? +(d.total_awake_time_milli / 3600000).toFixed(2) : 0,
  }));

  const scoreData = data.map((d) => ({
    date: formatDate(d.start_time?.split("T")[0]),
    performance: d.sleep_performance_percentage,
    efficiency: d.sleep_efficiency_percentage,
    consistency: d.sleep_consistency_percentage,
  }));

  const hrData = data.map((d) => {
    const rec = recoveryByCycle.get(d.cycle_id);
    return {
      date: formatDate(d.start_time?.split("T")[0]),
      hr: rec?.resting_heart_rate,
      hrv: rec?.hrv_rmssd_milli ? +Number(rec.hrv_rmssd_milli).toFixed(1) : null,
      respRate: d.respiratory_rate ? +Number(d.respiratory_rate).toFixed(1) : null,
    };
  });

  return (
    <>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Sleep</h2>
          <p className="text-sm text-text-tertiary mt-0.5">30-day sleep trends from WHOOP</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Duration" value={latest?.total_in_bed_time_milli ? formatDuration(Math.round(latest.total_in_bed_time_milli / 1000)) : null} source="WHOOP" />
        <StatCard label="Sleep Performance" value={latest?.sleep_performance_percentage != null ? `${latest.sleep_performance_percentage}%` : null} sublabel={`Efficiency: ${latest?.sleep_efficiency_percentage ?? "\u2014"}%`} source="WHOOP" />
        <StatCard label="Deep Sleep" value={latest?.total_slow_wave_sleep_time_milli ? formatDuration(Math.round(latest.total_slow_wave_sleep_time_milli / 1000)) : null} source="WHOOP" />
        <StatCard label="REM Sleep" value={latest?.total_rem_sleep_time_milli ? formatDuration(Math.round(latest.total_rem_sleep_time_milli / 1000)) : null} source="WHOOP" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <ChartCard title="Sleep Stages (hours)" source="WHOOP">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={durationData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={35} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" }} />
              <Bar dataKey="deep" stackId="a" fill="#1e40af" name="Deep" />
              <Bar dataKey="light" stackId="a" fill="#60a5fa" name="Light" />
              <Bar dataKey="rem" stackId="a" fill="#a78bfa" name="REM" />
              <Bar dataKey="awake" stackId="a" fill="#f87171" name="Awake" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Scores" source="WHOOP">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={scoreData}>
              <defs>
                <linearGradient id="sleepPerfGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="sleepEffGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="sleepConsGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={35} domain={[0, 100]} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" }} />
              <Area type="monotone" dataKey="performance" stroke="#f59e0b" fill="url(#sleepPerfGrad)" strokeWidth={2} name="Performance" />
              <Area type="monotone" dataKey="efficiency" stroke="#22c55e" fill="url(#sleepEffGrad)" strokeWidth={1.5} name="Efficiency" />
              <Area type="monotone" dataKey="consistency" stroke="#3b82f6" fill="url(#sleepConsGrad)" strokeWidth={1.5} name="Consistency" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Resting HR, HRV & Respiratory Rate" source="WHOOP">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={hrData}>
              <defs>
                <linearGradient id="sleepRhrGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ef4444" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="sleepHrvGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis yAxisId="hr" tick={axisTick} width={40} />
              <YAxis yAxisId="hrv" orientation="right" tick={axisTick} width={40} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" }} />
              <Area yAxisId="hr" type="monotone" dataKey="hr" stroke="#ef4444" fill="url(#sleepRhrGrad)" strokeWidth={2} name="RHR (bpm)" />
              <Area yAxisId="hrv" type="monotone" dataKey="hrv" stroke="#22c55e" fill="url(#sleepHrvGrad)" strokeWidth={2} name="HRV (ms)" />
              <Area yAxisId="hr" type="monotone" dataKey="respRate" stroke="#8b5cf6" fill="transparent" strokeWidth={1.5} name="Resp Rate" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
