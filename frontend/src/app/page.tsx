"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, CartesianGrid,
} from "recharts";
import { getDailySummaries, getWhoopRecovery, getWhoopSleep, getHrvData } from "@/lib/queries";
import { formatDate, formatDuration } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import { chartTooltip, axisTick, gridStyle, accentColor } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function Dashboard() {
  const [summaries, setSummaries] = useState<any[]>([]);
  const [sleep, setSleep] = useState<any[]>([]);
  const [recovery, setRecovery] = useState<any[]>([]);
  const [hrv, setHrv] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getDailySummaries(30), getWhoopSleep(30), getWhoopRecovery(30), getHrvData(30)])
      .then(([s, sl, rec, h]) => {
        setSummaries(s);
        setSleep(sl);
        setRecovery(rec);
        setHrv(h);
      })
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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-surface-card border border-border-subtle rounded-[6px] p-5 h-[300px]">
              <div className="h-4 w-40 bg-white/5 animate-pulse rounded mb-4" />
              <div className="h-[220px] bg-white/5 animate-pulse rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const latest = summaries[summaries.length - 1];
  const latestSleep = sleep[sleep.length - 1];
  const latestRecovery = recovery[recovery.length - 1];

  const stepsData = summaries.map((d) => ({
    date: formatDate(d.calendar_date),
    steps: d.total_steps,
  }));

  const sleepData = sleep.map((d) => ({
    date: formatDate(d.start_time?.split("T")[0]),
    hours: d.total_in_bed_time_milli ? +((d.total_in_bed_time_milli - (d.total_awake_time_milli ?? 0)) / 3600000).toFixed(1) : null,
    score: d.sleep_performance_percentage,
  }));

  const hrvData = hrv.map((d) => ({
    date: formatDate(d.calendar_date),
    hrv: d.last_night_avg_ms,
    weeklyAvg: d.weekly_avg_ms,
  }));

  return (
    <>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Dashboard</h2>
          <p className="text-sm text-text-tertiary mt-0.5">30-day overview across all sources</p>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="animate-stagger-1">
          <StatCard label="Steps" value={latest?.total_steps?.toLocaleString()} sublabel={latest?.calendar_date} source="GARMIN" />
        </div>
        <div className="animate-stagger-2">
          <StatCard label="Resting HR" value={latestRecovery?.resting_heart_rate} unit="bpm" source="WHOOP" />
        </div>
        <div className="animate-stagger-3">
          <StatCard
            label="Sleep"
            value={latestSleep?.total_in_bed_time_milli ? formatDuration(Math.round((latestSleep.total_in_bed_time_milli - (latestSleep.total_awake_time_milli ?? 0)) / 1000)) : null}
            sublabel={latestSleep ? `Score: ${latestSleep.sleep_performance_percentage ?? "\u2014"}%` : undefined}
            source="WHOOP"
          />
        </div>
        <div className="animate-stagger-4">
          <StatCard
            label="Recovery"
            value={latestRecovery?.recovery_score}
            unit="%"
            source="WHOOP"
          />
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Daily Steps" subtitle="30 days" source="GARMIN">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={stepsData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={45} />
              <Tooltip {...chartTooltip} />
              <Bar dataKey="steps" fill={accentColor} radius={[2, 2, 0, 0]} fillOpacity={0.85} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Duration" subtitle="Hours per night" source="WHOOP">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={sleepData}>
              <defs>
                <linearGradient id="sleepFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={accentColor} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={accentColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={35} domain={[0, 10]} />
              <Tooltip {...chartTooltip} />
              <Area type="monotone" dataKey="hours" stroke={accentColor} fill="url(#sleepFill)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Score" source="WHOOP">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={sleepData}>
              <defs>
                <linearGradient id="scoreFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#F59E0B" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#F59E0B" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={35} domain={[0, 100]} />
              <Tooltip {...chartTooltip} />
              <Area type="monotone" dataKey="score" stroke="#F59E0B" fill="url(#scoreFill)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="HRV Trend" subtitle="Nightly avg · 7-day avg" source="GARMIN">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={hrvData}>
              <defs>
                <linearGradient id="hrvFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22C55E" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#22C55E" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} unit=" ms" />
              <Tooltip {...chartTooltip} formatter={(v) => [v != null ? `${v} ms` : '—']} />
              <Area type="monotone" dataKey="hrv" name="Nightly Avg" stroke="#22C55E" fill="url(#hrvFill)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="weeklyAvg" name="7-Day Avg" stroke="#86EFAC" fill="transparent" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
