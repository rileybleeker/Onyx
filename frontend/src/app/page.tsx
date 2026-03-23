"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar,
} from "recharts";
import { getDailySummaries, getWhoopRecovery, getWhoopSleep } from "@/lib/queries";
import { formatDate, formatDuration } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";

/* eslint-disable @typescript-eslint/no-explicit-any */

const chartTooltipStyle = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #27272a", borderRadius: 8 },
  labelStyle: { color: "#a1a1aa" },
  itemStyle: { color: "#e4e4e7" },
};

export default function Dashboard() {
  const [summaries, setSummaries] = useState<any[]>([]);
  const [sleep, setSleep] = useState<any[]>([]);
  const [recovery, setRecovery] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getDailySummaries(30), getWhoopSleep(30), getWhoopRecovery(30)])
      .then(([s, sl, rec]) => {
        setSummaries(s);
        setSleep(sl);
        setRecovery(rec);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-zinc-500">Loading your data...</div>
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

  const bbData = summaries.map((d) => ({
    date: formatDate(d.calendar_date),
    highest: d.body_battery_highest,
    lowest: d.body_battery_lowest,
  }));

  return (
    <>
      <h2 className="text-2xl font-bold mb-6">Dashboard</h2>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Steps" value={latest?.total_steps?.toLocaleString()} sublabel={latest?.calendar_date} />
        <StatCard label="Resting HR" value={latestRecovery?.resting_heart_rate} unit="bpm" />
        <StatCard
          label="Sleep"
          value={latestSleep?.total_in_bed_time_milli ? formatDuration(Math.round((latestSleep.total_in_bed_time_milli - (latestSleep.total_awake_time_milli ?? 0)) / 1000)) : null}
          sublabel={latestSleep ? `Score: ${latestSleep.sleep_performance_percentage ?? "—"}%` : undefined}
        />
        <StatCard
          label="Recovery"
          value={latestRecovery?.recovery_score}
          unit="%"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Daily Steps (30 days)">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={stepsData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={45} />
              <Tooltip {...chartTooltipStyle} />
              <Bar dataKey="steps" fill="#3b82f6" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Duration (hours)">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={sleepData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={30} domain={[0, 10]} />
              <Tooltip {...chartTooltipStyle} />
              <Area type="monotone" dataKey="hours" stroke="#8b5cf6" fill="#8b5cf680" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Body Battery">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={bbData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={30} domain={[0, 100]} />
              <Tooltip {...chartTooltipStyle} />
              <Area type="monotone" dataKey="highest" stroke="#22c55e" fill="#22c55e40" strokeWidth={2} />
              <Area type="monotone" dataKey="lowest" stroke="#ef4444" fill="#ef444440" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Score">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={sleepData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={30} domain={[0, 100]} />
              <Tooltip {...chartTooltipStyle} />
              <Area type="monotone" dataKey="score" stroke="#f59e0b" fill="#f59e0b40" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
