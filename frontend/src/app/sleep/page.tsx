"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { getSleepData } from "@/lib/queries";
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSleepData(30)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-pulse text-zinc-500">Loading sleep data...</div></div>;
  }

  const latest = data[data.length - 1];

  const durationData = data.map((d) => ({
    date: formatDate(d.calendar_date),
    deep: d.deep_sleep_seconds ? +(d.deep_sleep_seconds / 3600).toFixed(2) : 0,
    light: d.light_sleep_seconds ? +(d.light_sleep_seconds / 3600).toFixed(2) : 0,
    rem: d.rem_sleep_seconds ? +(d.rem_sleep_seconds / 3600).toFixed(2) : 0,
    awake: d.awake_seconds ? +(d.awake_seconds / 3600).toFixed(2) : 0,
  }));

  const scoreData = data.map((d) => ({
    date: formatDate(d.calendar_date),
    overall: d.overall_sleep_score,
    duration: d.duration_score,
    recovery: d.recovery_score,
    deep: d.deep_score,
    rem: d.rem_score,
  }));

  const hrData = data.map((d) => ({
    date: formatDate(d.calendar_date),
    hr: d.avg_sleep_heart_rate,
    hrv: d.avg_hrv,
  }));

  return (
    <>
      <h2 className="text-2xl font-bold mb-6">Sleep</h2>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Duration" value={formatDuration(latest?.sleep_duration_seconds)} />
        <StatCard label="Sleep Score" value={latest?.overall_sleep_score} sublabel={latest?.quality_score} />
        <StatCard label="Deep Sleep" value={formatDuration(latest?.deep_sleep_seconds)} />
        <StatCard label="REM Sleep" value={formatDuration(latest?.rem_sleep_seconds)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Sleep Stages (hours)">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={durationData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={30} />
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
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={30} domain={[0, 100]} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="overall" stroke="#f59e0b" fill="#f59e0b30" strokeWidth={2} name="Overall" />
              <Area type="monotone" dataKey="recovery" stroke="#22c55e" fill="transparent" strokeWidth={1.5} name="Recovery" />
              <Area type="monotone" dataKey="deep" stroke="#1e40af" fill="transparent" strokeWidth={1.5} name="Deep" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Heart Rate & HRV">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={hrData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis yAxisId="hr" tick={{ fill: "#71717a", fontSize: 11 }} width={30} />
              <YAxis yAxisId="hrv" orientation="right" tick={{ fill: "#71717a", fontSize: 11 }} width={30} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area yAxisId="hr" type="monotone" dataKey="hr" stroke="#ef4444" fill="#ef444430" strokeWidth={2} name="Avg HR (bpm)" />
              <Area yAxisId="hrv" type="monotone" dataKey="hrv" stroke="#22c55e" fill="#22c55e30" strokeWidth={2} name="Avg HRV (ms)" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
