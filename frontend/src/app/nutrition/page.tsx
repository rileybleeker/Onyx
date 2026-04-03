"use client";

import { useEffect, useState } from "react";
import {
  AreaChart, Area,
  BarChart, Bar,
  LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from "recharts";
import { getMfpNutrition } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import { chartTooltip, axisTick, gridStyle } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

const legendStyle = { fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" };

function avg(arr: any[], key: string): number {
  const vals = arr.map((d) => Number(d[key])).filter((v) => !isNaN(v) && v > 0);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

export default function NutritionPage() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMfpNutrition(30)
      .then(setData)
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
        <div className="h-[320px] bg-surface-card border border-border-subtle rounded-[6px] animate-pulse" />
      </div>
    );
  }

  const latest = data[data.length - 1];

  const calorieData = data.map((d) => ({
    date: formatDate(d.calendar_date),
    calories: d.calories ?? null,
  }));

  const macroData = data.map((d) => ({
    date: formatDate(d.calendar_date),
    protein: d.protein_g ? +Number(d.protein_g).toFixed(1) : 0,
    carbs: d.carbs_g ? +Number(d.carbs_g).toFixed(1) : 0,
    fat: d.fat_g ? +Number(d.fat_g).toFixed(1) : 0,
  }));

  const fiberSugarData = data.map((d) => ({
    date: formatDate(d.calendar_date),
    fiber: d.fiber_g ? +Number(d.fiber_g).toFixed(1) : null,
    sugar: d.sugar_g ? +Number(d.sugar_g).toFixed(1) : null,
  }));

  const avgCalories = avg(data, "calories");
  const avgProtein = avg(data, "protein_g");
  const avgCarbs = avg(data, "carbs_g");
  const avgFat = avg(data, "fat_g");

  return (
    <>
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Nutrition</h2>
          <p className="text-sm text-text-tertiary mt-0.5">30-day nutrition data from MyFitnessPal</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Calories"
          value={latest?.calories ?? null}
          sublabel={avgCalories > 0 ? `avg ${Math.round(avgCalories)} kcal` : undefined}
          source="MFP"
        />
        <StatCard
          label="Protein"
          value={latest?.protein_g ? `${Number(latest.protein_g).toFixed(0)}g` : null}
          sublabel={avgProtein > 0 ? `avg ${avgProtein.toFixed(0)}g` : undefined}
          source="MFP"
        />
        <StatCard
          label="Carbs"
          value={latest?.carbs_g ? `${Number(latest.carbs_g).toFixed(0)}g` : null}
          sublabel={avgCarbs > 0 ? `avg ${avgCarbs.toFixed(0)}g` : undefined}
          source="MFP"
        />
        <StatCard
          label="Fat"
          value={latest?.fat_g ? `${Number(latest.fat_g).toFixed(0)}g` : null}
          sublabel={avgFat > 0 ? `avg ${avgFat.toFixed(0)}g` : undefined}
          source="MFP"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard title="Calorie Trend" source="MFP" className="lg:col-span-2">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={calorieData}>
              <defs>
                <linearGradient id="calGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={48} />
              <Tooltip {...chartTooltip} />
              <Area
                type="monotone"
                dataKey="calories"
                stroke="#06b6d4"
                strokeWidth={2}
                fill="url(#calGrad)"
                name="Calories (kcal)"
                connectNulls={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Macro Breakdown (g)" source="MFP" className="lg:col-span-2">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={macroData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={48} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Bar dataKey="protein" stackId="macros" fill="#22c55e" name="Protein (g)" />
              <Bar dataKey="carbs" stackId="macros" fill="#3b82f6" name="Carbs (g)" />
              <Bar dataKey="fat" stackId="macros" fill="#f59e0b" name="Fat (g)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Fiber & Sugar (g)" source="MFP">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={fiberSugarData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line type="monotone" dataKey="fiber" stroke="#a78bfa" strokeWidth={2} dot={false} name="Fiber (g)" connectNulls={false} />
              <Line type="monotone" dataKey="sugar" stroke="#f87171" strokeWidth={2} dot={false} name="Sugar (g)" connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Protein vs Fat (g)" source="MFP">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={macroData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line type="monotone" dataKey="protein" stroke="#22c55e" strokeWidth={2} dot={false} name="Protein (g)" />
              <Line type="monotone" dataKey="fat" stroke="#f59e0b" strokeWidth={2} dot={false} name="Fat (g)" />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
