"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from "recharts";
import { getHeartRateData, getHrvData, getStressData } from "@/lib/queries";
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
  const [hr, setHr] = useState<any[]>([]);
  const [hrv, setHrv] = useState<any[]>([]);
  const [stress, setStress] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getHeartRateData(30), getHrvData(30), getStressData(30)])
      .then(([h, v, s]) => { setHr(h); setHrv(v); setStress(s); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-pulse text-zinc-500">Loading heart data...</div></div>;
  }

  const latestHr = hr[hr.length - 1];
  const latestHrv = hrv[hrv.length - 1];
  const latestStress = stress[stress.length - 1];

  const hrData = hr.map((d) => ({
    date: formatDate(d.calendar_date),
    resting: d.resting_heart_rate,
    min: d.min_heart_rate,
    max: d.max_heart_rate,
  }));

  const hrvData = hrv.map((d) => ({
    date: formatDate(d.calendar_date),
    lastNight: d.last_night_avg_ms,
    weeklyAvg: d.weekly_avg_ms,
    balancedLow: d.baseline_balanced_low_ms,
    balancedUpper: d.baseline_balanced_upper_ms,
  }));

  const stressData = stress.map((d) => ({
    date: formatDate(d.calendar_date),
    overall: d.overall_stress_level,
  }));

  return (
    <>
      <h2 className="text-2xl font-bold mb-6">Heart & HRV</h2>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Resting HR" value={latestHr?.resting_heart_rate} unit="bpm" />
        <StatCard label="Max HR" value={latestHr?.max_heart_rate} unit="bpm" />
        <StatCard label="HRV (last night)" value={latestHrv?.last_night_avg_ms} unit="ms" sublabel={latestHrv?.hrv_status} />
        <StatCard label="Stress" value={latestStress?.overall_stress_level} sublabel={latestStress?.stress_qualifier} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Heart Rate Trends">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={hrData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={35} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="max" stroke="#ef4444" fill="#ef444420" strokeWidth={1.5} name="Max" />
              <Area type="monotone" dataKey="resting" stroke="#3b82f6" fill="#3b82f640" strokeWidth={2} name="Resting" />
              <Area type="monotone" dataKey="min" stroke="#22c55e" fill="#22c55e20" strokeWidth={1.5} name="Min" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="HRV Trend (ms)">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={hrvData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={35} />
              <Tooltip {...tt} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={hrvData[0]?.balancedLow} stroke="#71717a" strokeDasharray="3 3" />
              <ReferenceLine y={hrvData[0]?.balancedUpper} stroke="#71717a" strokeDasharray="3 3" />
              <Line type="monotone" dataKey="lastNight" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Last Night" />
              <Line type="monotone" dataKey="weeklyAvg" stroke="#f59e0b" strokeWidth={2} dot={false} name="Weekly Avg" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Stress Level">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={stressData}>
              <XAxis dataKey="date" tick={{ fill: "#71717a", fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={30} domain={[0, 100]} />
              <Tooltip {...tt} />
              <Area type="monotone" dataKey="overall" stroke="#f97316" fill="#f9731640" strokeWidth={2} name="Stress Level" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
