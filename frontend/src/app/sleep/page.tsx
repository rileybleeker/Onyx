"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { getWhoopSleep, getWhoopRecovery } from "@/lib/queries";
import { formatDate, formatDuration } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";

/* eslint-disable @typescript-eslint/no-explicit-any */

const tt = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #27272a", borderRadius: 8 },
  labelStyle: { color: "#a1a1aa" },
  itemStyle: { color: "#e4e4e7" },
};

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
    return <div className="flex items-center justify-center h-64"><div className="animate-pulse text-zinc-500">Loading sleep data...</div></div>;
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
      <h2 className="text-2xl font-bold mb-6">Sleep</h2>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Duration" value={latest?.total_in_bed_time_milli ? formatDuration(Math.round(latest.total_in_bed_time_milli / 1000)) : null} />
        <StatCard label="Sleep Performance" value={latest?.sleep_performance_percentage != null ? `${latest.sleep_performance_percentage}%` : null} sublabel={`Efficiency: ${latest?.sleep_efficiency_percentage ?? "—"}%`} />
        <StatCard label="Deep Sleep" value={latest?.total_slow_wave_sleep_time_milli ? formatDuration(Math.round(latest.total_slow_wave_sleep_time_milli / 1000)) : null} />
        <StatCard label="REM Sleep" value={latest?.total_rem_sleep_time_milli ? formatDuration(Math.round(latest.total_rem_sleep_time_milli / 1000)) : null} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Sleep Stages (hours)">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={durationData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" label={{ value: "Date", fill: "#71717a", fontSize: 11, position: "insideBottom", offset: -5 }} />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={35} label={{ value: "Duration (hrs)", fill: "#71717a", fontSize: 11, angle: -90, position: "insideLeft" }} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="deep" stackId="a" fill="#1e40af" name="Deep" />
              <Bar dataKey="light" stackId="a" fill="#60a5fa" name="Light" />
              <Bar dataKey="rem" stackId="a" fill="#a78bfa" name="REM" />
              <Bar dataKey="awake" stackId="a" fill="#f87171" name="Awake" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Scores">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={scoreData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" label={{ value: "Date", fill: "#71717a", fontSize: 11, position: "insideBottom", offset: -5 }} />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={35} domain={[0, 100]} label={{ value: "Score (%)", fill: "#71717a", fontSize: 11, angle: -90, position: "insideLeft" }} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="performance" stroke="#f59e0b" fill="#f59e0b30" strokeWidth={2} name="Performance" />
              <Area type="monotone" dataKey="efficiency" stroke="#22c55e" fill="transparent" strokeWidth={1.5} name="Efficiency" />
              <Area type="monotone" dataKey="consistency" stroke="#3b82f6" fill="transparent" strokeWidth={1.5} name="Consistency" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Resting HR, HRV & Respiratory Rate">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={hrData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" label={{ value: "Date", fill: "#71717a", fontSize: 11, position: "insideBottom", offset: -5 }} />
              <YAxis yAxisId="hr" tick={{ fill: "#71717a", fontSize: 11 }} width={40} label={{ value: "bpm / breaths", fill: "#71717a", fontSize: 11, angle: -90, position: "insideLeft" }} />
              <YAxis yAxisId="hrv" orientation="right" tick={{ fill: "#71717a", fontSize: 11 }} width={40} label={{ value: "HRV (ms)", fill: "#71717a", fontSize: 11, angle: 90, position: "insideRight" }} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area yAxisId="hr" type="monotone" dataKey="hr" stroke="#ef4444" fill="#ef444430" strokeWidth={2} name="RHR (bpm)" />
              <Area yAxisId="hrv" type="monotone" dataKey="hrv" stroke="#22c55e" fill="#22c55e30" strokeWidth={2} name="HRV (ms)" />
              <Area yAxisId="hr" type="monotone" dataKey="respRate" stroke="#8b5cf6" fill="transparent" strokeWidth={1.5} name="Resp Rate" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
