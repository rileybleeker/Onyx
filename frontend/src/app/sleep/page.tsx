"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, CartesianGrid,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { getWhoopSleep, getWhoopRecovery, getEightSleepTrends } from "@/lib/queries";
import { formatDate, formatDuration } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import { chartTooltip, axisTick, gridStyle } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

const legendStyle = { fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" };

export default function SleepPage() {
  const [whoopSleep, setWhoopSleep] = useState<any[]>([]);
  const [whoopRecovery, setWhoopRecovery] = useState<any[]>([]);
  const [eightSleep, setEightSleep] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getWhoopSleep(30), getWhoopRecovery(30), getEightSleepTrends(30)])
      .then(([s, r, e]) => { setWhoopSleep(s); setWhoopRecovery(r); setEightSleep(e); })
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

  // WHOOP data
  const latestWhoop = whoopSleep[whoopSleep.length - 1];
  const latestRecovery = whoopRecovery[whoopRecovery.length - 1];
  const recoveryByCycle = new Map(whoopRecovery.map((r) => [r.cycle_id, r]));

  const whoopDurationData = whoopSleep.map((d) => ({
    date: formatDate(d.start_time?.split("T")[0]),
    deep: d.total_slow_wave_sleep_time_milli ? +(d.total_slow_wave_sleep_time_milli / 3600000).toFixed(2) : 0,
    light: d.total_light_sleep_time_milli ? +(d.total_light_sleep_time_milli / 3600000).toFixed(2) : 0,
    rem: d.total_rem_sleep_time_milli ? +(d.total_rem_sleep_time_milli / 3600000).toFixed(2) : 0,
    awake: d.total_awake_time_milli ? +(d.total_awake_time_milli / 3600000).toFixed(2) : 0,
  }));

  const whoopScoreData = whoopSleep.map((d) => ({
    date: formatDate(d.start_time?.split("T")[0]),
    performance: d.sleep_performance_percentage,
    efficiency: d.sleep_efficiency_percentage,
    consistency: d.sleep_consistency_percentage,
  }));

  const whoopHrData = whoopSleep.map((d) => {
    const rec = recoveryByCycle.get(d.cycle_id);
    return {
      date: formatDate(d.start_time?.split("T")[0]),
      hr: rec?.resting_heart_rate,
      hrv: rec?.hrv_rmssd_milli ? +Number(rec.hrv_rmssd_milli).toFixed(1) : null,
      respRate: d.respiratory_rate ? +Number(d.respiratory_rate).toFixed(1) : null,
    };
  });

  // Eight Sleep data
  const latestEight = eightSleep[eightSleep.length - 1];

  const eightScoreData = eightSleep.map((d) => ({
    date: formatDate(d.calendar_date),
    sleep: d.sleep_score,
    fitness: d.sleep_fitness_score,
    quality: d.sleep_quality_score,
  }));

  const eightStagesData = eightSleep.map((d) => ({
    date: formatDate(d.calendar_date),
    deep: d.deep_sleep_seconds ? +(d.deep_sleep_seconds / 3600).toFixed(2) : 0,
    light: d.light_sleep_seconds ? +(d.light_sleep_seconds / 3600).toFixed(2) : 0,
    rem: d.rem_sleep_seconds ? +(d.rem_sleep_seconds / 3600).toFixed(2) : 0,
    awake: d.awake_seconds ? +(d.awake_seconds / 3600).toFixed(2) : 0,
  }));

  const eightBiometricsData = eightSleep.map((d) => ({
    date: formatDate(d.calendar_date),
    hr: d.avg_heart_rate ? +Number(d.avg_heart_rate).toFixed(0) : null,
    hrv: d.avg_hrv ? +Number(d.avg_hrv).toFixed(0) : null,
    breathRate: d.avg_breath_rate ? +Number(d.avg_breath_rate).toFixed(1) : null,
  }));

  const eightEnvData = eightSleep.map((d) => ({
    date: formatDate(d.calendar_date),
    bedTemp: d.avg_bed_temp ? +Number(d.avg_bed_temp).toFixed(1) : null,
    roomTemp: d.avg_room_temp ? +Number(d.avg_room_temp).toFixed(1) : null,
    tossTurns: d.toss_and_turns,
  }));

  return (
    <>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Sleep</h2>
          <p className="text-sm text-text-tertiary mt-0.5">30-day sleep trends from WHOOP &amp; Eight Sleep</p>
        </div>
      </div>

      {/* WHOOP Section */}
      <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-3">WHOOP</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Duration" value={latestWhoop?.total_in_bed_time_milli ? formatDuration(Math.round(latestWhoop.total_in_bed_time_milli / 1000)) : null} source="WHOOP" />
        <StatCard label="Sleep Performance" value={latestWhoop?.sleep_performance_percentage != null ? `${latestWhoop.sleep_performance_percentage}%` : null} sublabel={`Efficiency: ${latestWhoop?.sleep_efficiency_percentage ?? "\u2014"}%`} source="WHOOP" />
        <StatCard label="Deep Sleep" value={latestWhoop?.total_slow_wave_sleep_time_milli ? formatDuration(Math.round(latestWhoop.total_slow_wave_sleep_time_milli / 1000)) : null} source="WHOOP" />
        <StatCard label="REM Sleep" value={latestWhoop?.total_rem_sleep_time_milli ? formatDuration(Math.round(latestWhoop.total_rem_sleep_time_milli / 1000)) : null} source="WHOOP" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
        <ChartCard title="Sleep Stages (hours)" source="WHOOP">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={whoopDurationData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={35} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Bar dataKey="deep" stackId="a" fill="#1e40af" name="Deep" />
              <Bar dataKey="light" stackId="a" fill="#60a5fa" name="Light" />
              <Bar dataKey="rem" stackId="a" fill="#a78bfa" name="REM" />
              <Bar dataKey="awake" stackId="a" fill="#f87171" name="Awake" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Scores" source="WHOOP">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={whoopScoreData}>
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
              <Legend wrapperStyle={legendStyle} />
              <Area type="monotone" dataKey="performance" stroke="#f59e0b" fill="url(#sleepPerfGrad)" strokeWidth={2} name="Performance" />
              <Area type="monotone" dataKey="efficiency" stroke="#22c55e" fill="url(#sleepEffGrad)" strokeWidth={1.5} name="Efficiency" />
              <Area type="monotone" dataKey="consistency" stroke="#3b82f6" fill="url(#sleepConsGrad)" strokeWidth={1.5} name="Consistency" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Resting HR, HRV & Respiratory Rate" source="WHOOP">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={whoopHrData}>
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
              <Legend wrapperStyle={legendStyle} />
              <Area yAxisId="hr" type="monotone" dataKey="hr" stroke="#ef4444" fill="url(#sleepRhrGrad)" strokeWidth={2} name="RHR (bpm)" />
              <Area yAxisId="hrv" type="monotone" dataKey="hrv" stroke="#22c55e" fill="url(#sleepHrvGrad)" strokeWidth={2} name="HRV (ms)" />
              <Area yAxisId="hr" type="monotone" dataKey="respRate" stroke="#8b5cf6" fill="transparent" strokeWidth={1.5} name="Resp Rate" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Divider */}
      <div className="border-t border-border-subtle mb-8" />

      {/* Eight Sleep Section */}
      <p className="text-[11px] font-mono text-text-tertiary uppercase tracking-widest mb-3">Eight Sleep</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Sleep Score" value={latestEight?.sleep_score} source="8SLP" />
        <StatCard label="Fitness Score" value={latestEight?.sleep_fitness_score} source="8SLP" />
        <StatCard label="Duration" value={formatDuration(latestEight?.time_slept_seconds)} source="8SLP" />
        <StatCard label="HRV" value={latestEight?.avg_hrv ? Number(latestEight.avg_hrv).toFixed(0) : null} unit="ms" source="8SLP" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Sleep Scores" source="8SLP">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={eightScoreData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} domain={[0, 100]} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line type="monotone" dataKey="sleep" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Sleep" />
              <Line type="monotone" dataKey="fitness" stroke="#22c55e" strokeWidth={1.5} dot={false} name="Fitness" />
              <Line type="monotone" dataKey="quality" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="Quality" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Stages (hours)" source="8SLP">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={eightStagesData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Bar dataKey="deep" stackId="a" fill="#1e40af" name="Deep" />
              <Bar dataKey="light" stackId="a" fill="#60a5fa" name="Light" />
              <Bar dataKey="rem" stackId="a" fill="#a78bfa" name="REM" />
              <Bar dataKey="awake" stackId="a" fill="#f87171" name="Awake" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Heart Rate & HRV" source="8SLP">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={eightBiometricsData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis yAxisId="hr" tick={axisTick} width={40} />
              <YAxis yAxisId="hrv" orientation="right" tick={axisTick} width={40} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line yAxisId="hr" type="monotone" dataKey="hr" stroke="#ef4444" strokeWidth={2} dot={false} name="Avg HR (bpm)" />
              <Line yAxisId="hrv" type="monotone" dataKey="hrv" stroke="#22c55e" strokeWidth={2} dot={false} name="Avg HRV (ms)" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Bed & Room Temperature" source="8SLP">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={eightEnvData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis yAxisId="temp" tick={axisTick} width={40} />
              <YAxis yAxisId="toss" orientation="right" tick={axisTick} width={40} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line yAxisId="temp" type="monotone" dataKey="bedTemp" stroke="#f97316" strokeWidth={2} dot={false} name="Bed Temp" />
              <Line yAxisId="temp" type="monotone" dataKey="roomTemp" stroke="#06b6d4" strokeWidth={2} dot={false} name="Room Temp" />
              <Line yAxisId="toss" type="monotone" dataKey="tossTurns" stroke="#a1a1aa" strokeWidth={1.5} dot={false} name="Toss & Turns" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
