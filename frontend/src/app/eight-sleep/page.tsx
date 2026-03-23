"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { getEightSleepTrends } from "@/lib/queries";
import { formatDate, formatDuration } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";

/* eslint-disable @typescript-eslint/no-explicit-any */

const tt = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #27272a", borderRadius: 8 },
  labelStyle: { color: "#a1a1aa" },
  itemStyle: { color: "#e4e4e7" },
};

export default function EightSleepPage() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getEightSleepTrends(30)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-pulse text-zinc-500">Loading Eight Sleep data...</div></div>;
  }

  const latest = data[data.length - 1];

  const scoreData = data.map((d) => ({
    date: formatDate(d.calendar_date),
    sleep: d.sleep_score,
    fitness: d.sleep_fitness_score,
    quality: d.sleep_quality_score,
    duration: d.sleep_duration_score,
  }));

  const stagesData = data.map((d) => ({
    date: formatDate(d.calendar_date),
    deep: d.deep_sleep_seconds ? +(d.deep_sleep_seconds / 3600).toFixed(2) : 0,
    light: d.light_sleep_seconds ? +(d.light_sleep_seconds / 3600).toFixed(2) : 0,
    rem: d.rem_sleep_seconds ? +(d.rem_sleep_seconds / 3600).toFixed(2) : 0,
    awake: d.awake_seconds ? +(d.awake_seconds / 3600).toFixed(2) : 0,
  }));

  const biometricsData = data.map((d) => ({
    date: formatDate(d.calendar_date),
    hr: d.avg_heart_rate ? +Number(d.avg_heart_rate).toFixed(0) : null,
    hrv: d.avg_hrv ? +Number(d.avg_hrv).toFixed(0) : null,
    breathRate: d.avg_breath_rate ? +Number(d.avg_breath_rate).toFixed(1) : null,
  }));

  const envData = data.map((d) => ({
    date: formatDate(d.calendar_date),
    bedTemp: d.avg_bed_temp ? +Number(d.avg_bed_temp).toFixed(1) : null,
    roomTemp: d.avg_room_temp ? +Number(d.avg_room_temp).toFixed(1) : null,
    tossTurns: d.toss_and_turns,
  }));

  return (
    <>
      <h2 className="text-2xl font-bold mb-6">Eight Sleep</h2>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Sleep Score" value={latest?.sleep_score} />
        <StatCard label="Fitness Score" value={latest?.sleep_fitness_score} />
        <StatCard label="Duration" value={formatDuration(latest?.time_slept_seconds)} />
        <StatCard label="HRV" value={latest?.avg_hrv ? Number(latest.avg_hrv).toFixed(0) : null} unit="ms" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Sleep Scores">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={scoreData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={35} domain={[0, 100]} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="sleep" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Sleep" />
              <Line type="monotone" dataKey="fitness" stroke="#22c55e" strokeWidth={1.5} dot={false} name="Fitness" />
              <Line type="monotone" dataKey="quality" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="Quality" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Sleep Stages (hours)">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={stagesData}>
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

        <ChartCard title="Heart Rate & HRV">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={biometricsData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis yAxisId="hr" tick={{ fill: "#71717a", fontSize: 11 }} width={35} />
              <YAxis yAxisId="hrv" orientation="right" tick={{ fill: "#71717a", fontSize: 11 }} width={35} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="hr" type="monotone" dataKey="hr" stroke="#ef4444" strokeWidth={2} dot={false} name="Avg HR (bpm)" />
              <Line yAxisId="hrv" type="monotone" dataKey="hrv" stroke="#22c55e" strokeWidth={2} dot={false} name="Avg HRV (ms)" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Bed & Room Temperature">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={envData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis yAxisId="temp" tick={{ fill: "#71717a", fontSize: 11 }} width={35} />
              <YAxis yAxisId="toss" orientation="right" tick={{ fill: "#71717a", fontSize: 11 }} width={35} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
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
