"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar,
} from "recharts";
import { getDailySummaries, getSleepData, getTrainingStatus } from "@/lib/queries";
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
  const [training, setTraining] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getDailySummaries(30), getSleepData(30), getTrainingStatus(30)])
      .then(([s, sl, tr]) => {
        setSummaries(s);
        setSleep(sl);
        setTraining(tr);
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
  const latestTraining = training[training.length - 1];

  const stepsData = summaries.map((d) => ({
    date: formatDate(d.calendar_date),
    steps: d.total_steps,
  }));

  const sleepData = sleep.map((d) => ({
    date: formatDate(d.calendar_date),
    hours: d.sleep_duration_seconds ? +(d.sleep_duration_seconds / 3600).toFixed(1) : null,
    score: d.overall_sleep_score,
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
        <StatCard label="Resting HR" value={latest?.resting_heart_rate} unit="bpm" />
        <StatCard
          label="Sleep"
          value={latestSleep?.sleep_duration_seconds ? formatDuration(latestSleep.sleep_duration_seconds) : null}
          sublabel={latestSleep ? `Score: ${latestSleep.overall_sleep_score ?? "—"}` : undefined}
        />
        <StatCard
          label="Training Readiness"
          value={latestTraining?.training_readiness_score}
          sublabel={latestTraining?.training_readiness_level}
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
