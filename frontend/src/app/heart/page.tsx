"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { getWhoopRecovery, getHeartRateData, getDailySummaries } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";

/* eslint-disable @typescript-eslint/no-explicit-any */

const tt = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #27272a", borderRadius: 8 },
  labelStyle: { color: "#a1a1aa" },
  itemStyle: { color: "#e4e4e7" },
};

export default function HeartPage() {
  const [recovery, setRecovery] = useState<any[]>([]);
  const [hr, setHr] = useState<any[]>([]);
  const [summaries, setSummaries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getWhoopRecovery(30), getHeartRateData(30), getDailySummaries(30)])
      .then(([rec, h, s]) => { setRecovery(rec); setHr(h); setSummaries(s); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-pulse text-zinc-500">Loading heart data...</div></div>;
  }

  const latestRecovery = recovery[recovery.length - 1];
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
      <h2 className="text-2xl font-bold mb-6">Heart & HRV</h2>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Resting HR" value={latestRecovery?.resting_heart_rate} unit="bpm" />
        <StatCard label="Max HR" value={latestHr?.max_heart_rate} unit="bpm" />
        <StatCard label="HRV (RMSSD)" value={latestRecovery?.hrv_rmssd_milli ? +Number(latestRecovery.hrv_rmssd_milli).toFixed(1) : null} unit="ms" />
        <StatCard label="Stress" value={latestSummary?.avg_stress_level} sublabel={latestSummary?.stress_qualifier} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Heart Rate Trends">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={hrData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" label={{ value: "Date", fill: "#71717a", fontSize: 11, position: "insideBottom", offset: -5 }} />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={40} label={{ value: "Heart Rate (bpm)", fill: "#71717a", fontSize: 11, angle: -90, position: "insideLeft" }} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="max" stroke="#ef4444" fill="#ef444420" strokeWidth={1.5} name="Max" />
              <Area type="monotone" dataKey="min" stroke="#22c55e" fill="#22c55e20" strokeWidth={1.5} name="Min" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Resting HR & HRV (WHOOP)">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={hrvData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" label={{ value: "Date", fill: "#71717a", fontSize: 11, position: "insideBottom", offset: -5 }} />
              <YAxis yAxisId="rhr" tick={{ fill: "#71717a", fontSize: 11 }} width={40} label={{ value: "RHR (bpm)", fill: "#71717a", fontSize: 11, angle: -90, position: "insideLeft" }} />
              <YAxis yAxisId="hrv" orientation="right" tick={{ fill: "#71717a", fontSize: 11 }} width={40} label={{ value: "HRV (ms)", fill: "#71717a", fontSize: 11, angle: 90, position: "insideRight" }} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="rhr" type="monotone" dataKey="rhr" stroke="#3b82f6" strokeWidth={2} dot={false} name="RHR (bpm)" />
              <Line yAxisId="hrv" type="monotone" dataKey="hrv" stroke="#8b5cf6" strokeWidth={2} dot={false} name="HRV RMSSD (ms)" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Stress Level">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={stressData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" label={{ value: "Date", fill: "#71717a", fontSize: 11, position: "insideBottom", offset: -5 }} />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={40} domain={[0, 100]} label={{ value: "Stress (0-100)", fill: "#71717a", fontSize: 11, angle: -90, position: "insideLeft" }} />
              <Tooltip {...tt} />
              <Area type="monotone" dataKey="overall" stroke="#f97316" fill="#f9731640" strokeWidth={2} name="Stress Level" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
