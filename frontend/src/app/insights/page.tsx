"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import {
  ScatterChart, Scatter, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  CartesianGrid, ReferenceLine,
} from "recharts";
import { getRecoveryVsPace, getHealthMatrix } from "@/lib/queries";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import {
  pearsonR, linearRegression, trendLine, binBy, rollingAvg, quantile, mean,
} from "@/lib/stats";

/* eslint-disable @typescript-eslint/no-explicit-any */

const tt = {
  contentStyle: { backgroundColor: "#18181b", border: "1px solid #27272a", borderRadius: 8 },
  labelStyle: { color: "#a1a1aa" },
  itemStyle: { color: "#e4e4e7" },
};

const WORKOUT_COLORS: Record<string, string> = {
  AEROBIC_BASE: "#3b82f6",
  TEMPO: "#f59e0b",
  LACTATE_THRESHOLD: "#f97316",
  VO2MAX: "#ef4444",
  ANAEROBIC_CAPACITY: "#a855f7",
  RECOVERY: "#22c55e",
};

function recoveryColor(score: number): string {
  if (score >= 67) return "#22c55e";
  if (score >= 34) return "#f59e0b";
  return "#ef4444";
}

function recoveryZone(score: number): string {
  if (score >= 67) return "Green";
  if (score >= 34) return "Yellow";
  return "Red";
}

function fmt(v: number | null | undefined, decimals = 2): string {
  if (v == null || !isFinite(v)) return "—";
  return v.toFixed(decimals);
}

const SECTIONS = [
  { id: "recovery-perf", label: "Recovery ↔ Performance" },
  { id: "sleep-recovery", label: "Sleep ↔ Recovery" },
  { id: "sleep-perf", label: "Sleep ↔ Performance" },
  { id: "training-load", label: "Training Load" },
  { id: "green-light", label: "Green Light" },
];

export default function InsightsPage() {
  const [rawRuns, setRawRuns] = useState<any[]>([]);
  const [rawMatrix, setRawMatrix] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    Promise.all([getRecoveryVsPace(730), getHealthMatrix(730)])
      .then(([runs, matrix]) => { setRawRuns(runs); setRawMatrix(matrix); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // ----- Matrix by date map -----
  const matrixByDate = useMemo(() => {
    const m = new Map<string, any>();
    for (const row of rawMatrix) m.set(row.calendar_date, row);
    return m;
  }, [rawMatrix]);

  // ----- matrixClean: matrix rows with WHOOP recovery -----
  const matrixClean = useMemo(() =>
    rawMatrix
      .map((d) => ({
        date: d.calendar_date,
        whoopRecovery: d.whoop_recovery_score != null ? +d.whoop_recovery_score : null,
        whoopHrv: d.whoop_hrv_rmssd != null ? +d.whoop_hrv_rmssd : null,
        whoopStrain: d.whoop_day_strain != null ? +d.whoop_day_strain : null,
        whoopSleepPerf: d.whoop_sleep_performance != null ? +d.whoop_sleep_performance : null,
        whoopDeepSleepHrs: d.whoop_deep_sleep_milli != null ? +d.whoop_deep_sleep_milli / 3600000 : null,
        whoopRhr: d.whoop_rhr != null ? +d.whoop_rhr : null,
        eightSleepScore: d.eight_sleep_score != null ? +d.eight_sleep_score : null,
        eightFitnessScore: d.eight_sleep_fitness_score != null ? +d.eight_sleep_fitness_score : null,
        eightHrv: d.eight_sleep_hrv != null ? +d.eight_sleep_hrv : null,
        eightHr: d.eight_sleep_hr != null ? +d.eight_sleep_hr : null,
        eightBedTemp: d.eight_sleep_bed_temp != null ? +d.eight_sleep_bed_temp : null,
        eightRoomTemp: d.eight_sleep_room_temp != null ? +d.eight_sleep_room_temp : null,
        eightDurationHrs: d.eight_sleep_duration_sec != null ? +d.eight_sleep_duration_sec / 3600 : null,
        eightDeepSleepHrs: d.eight_sleep_deep_sec != null ? +d.eight_sleep_deep_sec / 3600 : null,
        eightTossTurns: d.eight_sleep_toss_turns != null ? +d.eight_sleep_toss_turns : null,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    [rawMatrix]
  );

  // ----- enrichedRuns: recovery_vs_pace joined with matrix -----
  const enrichedRuns = useMemo(() =>
    rawRuns
      .map((d) => {
        const m = matrixByDate.get(d.activity_date);
        return {
          date: d.activity_date,
          name: d.activity_name,
          recovery: d.whoop_recovery != null ? +d.whoop_recovery : null,
          hrv: d.whoop_hrv != null ? +d.whoop_hrv : null,
          sleepPerf: d.whoop_sleep_performance != null ? +d.whoop_sleep_performance : null,
          paceDelta: d.pace_delta_pct != null ? +d.pace_delta_pct : null,
          actualPace: d.actual_pace_min_per_mile != null ? +d.actual_pace_min_per_mile : null,
          targetPace: d.target_pace_min_per_mile != null ? +d.target_pace_min_per_mile : null,
          overallPace: d.overall_pace_min_per_mile != null ? +d.overall_pace_min_per_mile : null,
          type: d.training_effect_label || "UNKNOWN",
          avgHr: d.avg_heart_rate != null ? +d.avg_heart_rate : null,
          // From matrix join
          whoopStrain: m?.whoop_day_strain != null ? +m.whoop_day_strain : null,
          whoopDeepSleepHrs: m?.whoop_deep_sleep_milli != null ? +m.whoop_deep_sleep_milli / 3600000 : null,
          eightDeepSleepHrs: m?.eight_sleep_deep_sec != null ? +m.eight_sleep_deep_sec / 3600 : null,
          eightBedTemp: m?.eight_sleep_bed_temp != null ? +m.eight_sleep_bed_temp : null,
          eightSleepScore: m?.eight_sleep_score != null ? +m.eight_sleep_score : null,
        };
      })
      .filter((d) => d.recovery != null),
    [rawRuns, matrixByDate]
  );

  // Runs with pace delta
  const withTarget = useMemo(() => enrichedRuns.filter((d) => d.paceDelta != null), [enrichedRuns]);

  // =====================================================================
  // Section 1: Recovery ↔ Performance
  // =====================================================================

  // Q1 — Recovery vs Pace Delta scatter + trend
  const q1Reg = useMemo(() =>
    linearRegression(withTarget.map((d) => d.recovery), withTarget.map((d) => d.paceDelta)),
    [withTarget]
  );
  const q1Trend = useMemo(() => trendLine(q1Reg, 0, 100), [q1Reg]);

  // Q2 — Target hit rate by recovery bin
  const q2Bins = useMemo(() => {
    const bins = binBy(withTarget, (d) => d.recovery, 10, 0, 100);
    return bins.map((b) => {
      const hits = b.items.filter((d) => d.paceDelta! <= 0).length;
      return {
        label: b.label,
        min: b.min,
        hitRate: b.items.length > 0 ? (hits / b.items.length) * 100 : 0,
        count: b.items.length,
      };
    });
  }, [withTarget]);

  const q2Threshold = useMemo(() => {
    for (let i = q2Bins.length - 1; i >= 0; i--) {
      if (q2Bins[i].count >= 3 && q2Bins[i].hitRate < 50) return q2Bins[i].min + 10;
    }
    return null;
  }, [q2Bins]);

  // Q3 — Rolling recovery window vs performance correlation
  const q3Windows = useMemo(() => {
    const windows = [1, 2, 3, 5, 7];
    const matrixRecoveries = matrixClean.map((d) => d.whoopRecovery);
    const matrixDates = matrixClean.map((d) => d.date);

    return windows.map((w) => {
      const rolled = rollingAvg(matrixRecoveries, w);
      const rolledByDate = new Map<string, number | null>();
      for (let i = 0; i < matrixDates.length; i++) rolledByDate.set(matrixDates[i], rolled[i]);

      const xs: (number | null)[] = [];
      const ys: (number | null)[] = [];
      for (const run of withTarget) {
        xs.push(rolledByDate.get(run.date) ?? null);
        ys.push(run.paceDelta);
      }
      const r = pearsonR(xs, ys);
      return { window: w, label: `${w}d`, r: r, absR: r != null ? Math.abs(r) : 0 };
    });
  }, [matrixClean, withTarget]);

  const q3Best = useMemo(() => {
    const valid = q3Windows.filter((w) => w.r != null);
    if (valid.length === 0) return null;
    return valid.reduce((best, w) => w.absR > best.absR ? w : best);
  }, [q3Windows]);

  // =====================================================================
  // Section 2: Sleep ↔ Recovery
  // =====================================================================

  // Q4 — Eight Sleep metric correlations with WHOOP recovery
  const q4Metrics = useMemo(() => {
    const metrics: { key: string; label: string; accessor: (d: any) => number | null }[] = [
      { key: "eightSleepScore", label: "Sleep Score", accessor: (d) => d.eightSleepScore },
      { key: "eightFitnessScore", label: "Fitness Score", accessor: (d) => d.eightFitnessScore },
      { key: "eightHrv", label: "HRV", accessor: (d) => d.eightHrv },
      { key: "eightHr", label: "Heart Rate", accessor: (d) => d.eightHr },
      { key: "eightBedTemp", label: "Bed Temp", accessor: (d) => d.eightBedTemp },
      { key: "eightRoomTemp", label: "Room Temp", accessor: (d) => d.eightRoomTemp },
      { key: "eightDurationHrs", label: "Duration", accessor: (d) => d.eightDurationHrs },
      { key: "eightDeepSleepHrs", label: "Deep Sleep", accessor: (d) => d.eightDeepSleepHrs },
      { key: "eightTossTurns", label: "Toss & Turns", accessor: (d) => d.eightTossTurns },
    ];
    return metrics.map((m) => {
      const xs = matrixClean.map(m.accessor);
      const ys = matrixClean.map((d) => d.whoopRecovery);
      const r = pearsonR(xs, ys);
      const [cx] = (() => {
        const cxArr: number[] = [];
        for (let i = 0; i < xs.length; i++) {
          if (xs[i] != null && ys[i] != null && isFinite(xs[i]!) && isFinite(ys[i]!)) cxArr.push(xs[i]!);
        }
        return [cxArr];
      })();
      return { ...m, r, absR: r != null ? Math.abs(r) : 0, n: cx.length };
    })
    .filter((m) => m.n >= 5)
    .sort((a, b) => b.absR - a.absR);
  }, [matrixClean]);

  const q4Best = q4Metrics.length > 0 ? q4Metrics[0] : null;

  // Q5 — Bed temperature vs HRV
  const q5Data = useMemo(() =>
    matrixClean.filter((d) => d.eightBedTemp != null && d.whoopHrv != null),
    [matrixClean]
  );
  const q5Reg = useMemo(() =>
    linearRegression(q5Data.map((d) => d.eightBedTemp), q5Data.map((d) => d.whoopHrv)),
    [q5Data]
  );
  const q5R = useMemo(() =>
    pearsonR(q5Data.map((d) => d.eightBedTemp), q5Data.map((d) => d.whoopHrv)),
    [q5Data]
  );
  const q5Bins = useMemo(() => {
    if (q5Data.length < 5) return [];
    const temps = q5Data.map((d) => d.eightBedTemp!).sort((a, b) => a - b);
    const lo = Math.floor(temps[0]);
    const hi = Math.ceil(temps[temps.length - 1]);
    return binBy(q5Data, (d) => d.eightBedTemp, 1, lo, hi + 1)
      .filter((b) => b.items.length >= 2)
      .map((b) => ({
        temp: (b.min + b.max) / 2,
        avgHrv: mean(b.items.map((d) => d.whoopHrv!)),
        count: b.items.length,
      }));
  }, [q5Data]);
  const q5OptimalBin = useMemo(() => {
    if (q5Bins.length === 0) return null;
    return q5Bins.reduce((best, b) => b.avgHrv > best.avgHrv ? b : best);
  }, [q5Bins]);

  // Q6 — Sleep duration vs recovery
  const q6Data = useMemo(() =>
    matrixClean.filter((d) => d.eightDurationHrs != null && d.whoopRecovery != null),
    [matrixClean]
  );
  const q6Threshold = useMemo(() => {
    if (q6Data.length < 10) return null;
    const sorted = [...q6Data].sort((a, b) => a.eightDurationHrs! - b.eightDurationHrs!);
    const bins = binBy(sorted, (d) => d.eightDurationHrs, 0.5, 4, 10);
    for (const bin of bins) {
      if (bin.items.length < 3) continue;
      const greenRate = bin.items.filter((d) => d.whoopRecovery! >= 67).length / bin.items.length;
      if (greenRate > 0.5) return bin.min;
    }
    return null;
  }, [q6Data]);

  // =====================================================================
  // Section 3: Sleep ↔ Performance
  // =====================================================================

  // Q7 — Deep sleep vs pace adherence
  const q7Data = useMemo(() =>
    withTarget.filter((d) => (d.whoopDeepSleepHrs != null || d.eightDeepSleepHrs != null)),
    [withTarget]
  );
  const q7DeepSleep = useMemo(() =>
    q7Data.map((d) => d.whoopDeepSleepHrs ?? d.eightDeepSleepHrs),
    [q7Data]
  );
  const q7Reg = useMemo(() =>
    linearRegression(q7DeepSleep, q7Data.map((d) => d.paceDelta)),
    [q7DeepSleep, q7Data]
  );
  const q7R = useMemo(() =>
    pearsonR(q7DeepSleep, q7Data.map((d) => d.paceDelta)),
    [q7DeepSleep, q7Data]
  );

  // Q8 — Bed temperature vs next-day HR at pace
  const q8Data = useMemo(() =>
    withTarget.filter((d) => d.eightBedTemp != null && d.avgHr != null),
    [withTarget]
  );
  const q8Reg = useMemo(() =>
    linearRegression(q8Data.map((d) => d.eightBedTemp), q8Data.map((d) => d.avgHr)),
    [q8Data]
  );
  const q8R = useMemo(() =>
    pearsonR(q8Data.map((d) => d.eightBedTemp), q8Data.map((d) => d.avgHr)),
    [q8Data]
  );

  // =====================================================================
  // Section 4: Training Load ↔ Recovery
  // =====================================================================

  // Q9 — Recovery bounce-back after high strain
  const q9Data = useMemo(() => {
    const withStrain = matrixClean.filter((d) => d.whoopStrain != null && d.whoopRecovery != null);
    if (withStrain.length < 20) return null;

    const strains = withStrain.map((d) => d.whoopStrain!).sort((a, b) => a - b);
    const q25 = quantile(strains, 0.25);
    const q75 = quantile(strains, 0.75);

    type StrainGroup = "Low" | "Medium" | "High";
    const classify = (s: number): StrainGroup => {
      if (s <= q25) return "Low";
      if (s >= q75) return "High";
      return "Medium";
    };

    const result: { day: number; Low: number | null; Medium: number | null; High: number | null }[] = [];
    for (let offset = 0; offset <= 5; offset++) {
      const byGroup: Record<StrainGroup, number[]> = { Low: [], Medium: [], High: [] };
      for (let i = 0; i < withStrain.length; i++) {
        const group = classify(withStrain[i].whoopStrain!);
        if (i + offset < withStrain.length) {
          const futureRec = withStrain[i + offset].whoopRecovery;
          if (futureRec != null) byGroup[group].push(futureRec);
        }
      }
      result.push({
        day: offset,
        Low: byGroup.Low.length > 0 ? mean(byGroup.Low) : null,
        Medium: byGroup.Medium.length > 0 ? mean(byGroup.Medium) : null,
        High: byGroup.High.length > 0 ? mean(byGroup.High) : null,
      });
    }
    return result;
  }, [matrixClean]);

  const q9NormalizeDay = useMemo(() => {
    if (!q9Data) return null;
    const baseline = q9Data[0];
    if (baseline?.Low == null || baseline?.High == null) return null;
    const diff0 = baseline.Low - baseline.High;
    for (let i = 1; i < q9Data.length; i++) {
      const d = q9Data[i];
      if (d.Low == null || d.High == null) continue;
      if (d.Low - d.High < diff0 * 0.3) return i;
    }
    return null;
  }, [q9Data]);

  // Q10 — Strain-to-recovery ratio vs pace delta
  const q10Data = useMemo(() =>
    withTarget
      .filter((d) => d.whoopStrain != null && d.recovery! > 0)
      .map((d) => ({ ...d, ratio: d.whoopStrain! / d.recovery! })),
    [withTarget]
  );
  const q10Reg = useMemo(() =>
    linearRegression(q10Data.map((d) => d.ratio), q10Data.map((d) => d.paceDelta)),
    [q10Data]
  );
  const q10Bins = useMemo(() => {
    if (q10Data.length < 10) return [];
    const ratios = q10Data.map((d) => d.ratio).sort((a, b) => a - b);
    const lo = Math.floor(ratios[0] * 10) / 10;
    const hi = Math.ceil(ratios[ratios.length - 1] * 10) / 10;
    return binBy(q10Data, (d) => d.ratio, 0.05, lo, hi + 0.05)
      .filter((b) => b.items.length >= 2)
      .map((b) => ({
        ratio: +((b.min + b.max) / 2).toFixed(2),
        avgDelta: mean(b.items.map((d) => d.paceDelta!)),
        count: b.items.length,
      }));
  }, [q10Data]);
  const q10Best = useMemo(() => {
    if (q10Bins.length === 0) return null;
    return q10Bins.reduce((best, b) => b.avgDelta < best.avgDelta ? b : best);
  }, [q10Bins]);

  // =====================================================================
  // Section 5: Green Light Conditions
  // =====================================================================

  // Q11 — Sleep × Recovery heatmap
  const q11Grid = useMemo(() => {
    const zones = ["Red", "Yellow", "Green"] as const;
    const sleepBins = ["Low", "Med", "High"] as const;
    const grid: Record<string, { avgDelta: number | null; count: number }> = {};

    for (const rz of zones) {
      for (const sb of sleepBins) {
        grid[`${rz}-${sb}`] = { avgDelta: null, count: 0 };
      }
    }

    const runsWithBoth = withTarget.filter((d) => d.eightSleepScore != null);
    for (const run of runsWithBoth) {
      const rz = recoveryZone(run.recovery!);
      const ss = run.eightSleepScore!;
      const sb = ss < 60 ? "Low" : ss < 80 ? "Med" : "High";
      const key = `${rz}-${sb}`;
      if (!grid[key]) grid[key] = { avgDelta: null, count: 0 };
      const cell = grid[key];
      cell.avgDelta = cell.avgDelta != null
        ? (cell.avgDelta * cell.count + run.paceDelta!) / (cell.count + 1)
        : run.paceDelta!;
      cell.count++;
    }

    return { grid, zones, sleepBins, total: runsWithBoth.length };
  }, [withTarget]);

  // Q12 — Green light profile
  const q12Data = useMemo(() => {
    const hits = withTarget.filter((d) => d.paceDelta! <= 0);
    const misses = withTarget.filter((d) => d.paceDelta! > 0);

    const avgOf = (arr: any[], key: string) => {
      const vals = arr.map((d) => d[key]).filter((v) => v != null && isFinite(v));
      return vals.length > 0 ? mean(vals) : null;
    };
    const p25Of = (arr: any[], key: string) => {
      const vals = arr.map((d) => d[key]).filter((v: any) => v != null && isFinite(v)).sort((a: number, b: number) => a - b);
      return vals.length >= 3 ? quantile(vals, 0.25) : null;
    };

    const metrics = [
      { label: "Recovery %", key: "recovery" },
      { label: "HRV (ms)", key: "hrv" },
      { label: "Sleep Perf %", key: "sleepPerf" },
      { label: "Eight Sleep Score", key: "eightSleepScore" },
      { label: "Deep Sleep (hrs)", key: "whoopDeepSleepHrs" },
      { label: "Strain", key: "whoopStrain" },
      { label: "Bed Temp", key: "eightBedTemp" },
    ];

    const rows = metrics.map((m) => {
      const hitAvg = avgOf(hits, m.key);
      const missAvg = avgOf(misses, m.key);
      return {
        label: m.label,
        hitAvg,
        missAvg,
        diff: hitAvg != null && missAvg != null ? hitAvg - missAvg : null,
      };
    });

    const thresholds = [
      { label: "Recovery", value: p25Of(hits, "recovery"), unit: "%" },
      { label: "Sleep Perf", value: p25Of(hits, "sleepPerf"), unit: "%" },
      { label: "HRV", value: p25Of(hits, "hrv"), unit: "ms" },
      { label: "Deep Sleep", value: p25Of(hits, "whoopDeepSleepHrs"), unit: "hrs" },
    ];

    return { rows, thresholds, hitCount: hits.length, missCount: misses.length };
  }, [withTarget]);


  // =====================================================================
  // Render
  // =====================================================================

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-pulse text-zinc-500">Loading insights...</div></div>;
  }

  if (enrichedRuns.length < 10) {
    return (
      <>
        <h2 className="text-2xl font-bold mb-2">Health Insights</h2>
        <div className="bg-amber-900/30 border border-amber-700 rounded-xl p-4 text-amber-200 text-sm">
          Insufficient data — need at least 10 runs with recovery data to generate insights. Currently have {enrichedRuns.length}.
        </div>
      </>
    );
  }

  return (
    <>
      <h2 className="text-2xl font-bold mb-1">Health Insights</h2>
      <p className="text-zinc-500 text-sm mb-4">
        Cross-device correlations — {enrichedRuns.length} runs, {matrixClean.length} matrix days
      </p>

      {/* Section nav pills */}
      <div className="flex flex-wrap gap-2 mb-8">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => sectionRefs.current[s.id]?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="px-3 py-1.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* ============================================================= */}
      {/* Section 1: Recovery ↔ Performance */}
      {/* ============================================================= */}
      <section ref={(el) => { sectionRefs.current["recovery-perf"] = el; }} className="mb-12">
        <h3 className="text-lg font-semibold mb-4 text-zinc-200">Recovery ↔ Performance</h3>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="R² (Recovery → Pace)"
            value={q1Reg ? fmt(q1Reg.r2) : null}
            sublabel={q1Reg ? `N = ${q1Reg.n} runs` : "Insufficient data"}
          />
          <StatCard
            label="Slope Interpretation"
            value={q1Reg ? `${fmt(q1Reg.slope * 10, 1)}%` : null}
            sublabel="pace Δ per 10% recovery"
          />
          <StatCard
            label="Hit Rate Threshold"
            value={q2Threshold != null ? `${q2Threshold}%` : "—"}
            sublabel="recovery where hit rate < 50%"
          />
          <StatCard
            label="Best Predictor Window"
            value={q3Best ? `${q3Best.window}-day` : null}
            sublabel={q3Best?.r != null ? `r = ${fmt(q3Best.r)}` : undefined}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Q1 — Scatter with trend */}
          {withTarget.length >= 5 && (
            <ChartCard title={`Recovery vs Pace Delta (N = ${withTarget.length})`}>
              <ResponsiveContainer width="100%" height={300}>
                <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis type="number" dataKey="recovery" name="Recovery" unit="%" tick={{ fill: "#71717a", fontSize: 11 }} domain={[0, 100]} />
                  <YAxis type="number" dataKey="paceDelta" name="Pace Delta" unit="%" tick={{ fill: "#71717a", fontSize: 11 }} />
                  <ReferenceLine y={0} stroke="#71717a" strokeDasharray="3 3" />
                  <Tooltip {...tt} />
                  <Scatter data={withTarget} shape="circle">
                    {withTarget.map((d, i) => (
                      <Cell key={i} fill={WORKOUT_COLORS[d.type] || "#71717a"} fillOpacity={0.8} r={5} />
                    ))}
                  </Scatter>
                  {q1Trend.length === 2 && (
                    <Scatter data={q1Trend} shape="circle" fill="none" line={{ stroke: "#f59e0b", strokeWidth: 2, strokeDasharray: "6 3" }} legendType="none">
                      {q1Trend.map((_, i) => <Cell key={i} r={0} />)}
                    </Scatter>
                  )}
                </ScatterChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-3 px-4 pb-3">
                {Object.entries(WORKOUT_COLORS).map(([type, color]) => {
                  const count = withTarget.filter((d) => d.type === type).length;
                  if (count === 0) return null;
                  return (
                    <span key={type} className="flex items-center gap-1.5 text-xs text-zinc-400">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                      {type.replace(/_/g, " ")} ({count})
                    </span>
                  );
                })}
              </div>
            </ChartCard>
          )}

          {/* Q2 — Hit rate by recovery bin */}
          <ChartCard title="Target Hit Rate by Recovery Bin">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={q2Bins} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="label" tick={{ fill: "#71717a", fontSize: 10 }} interval={0} angle={-45} textAnchor="end" height={50} />
                <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={40} domain={[0, 100]} unit="%" />
                <ReferenceLine y={50} stroke="#71717a" strokeDasharray="3 3" />
                <Tooltip {...tt} formatter={(value: any, name: any) => [`${(+value).toFixed(0)}%`, name]} />
                <Bar dataKey="hitRate" name="Hit Rate" radius={[4, 4, 0, 0]}>
                  {q2Bins.map((b, i) => (
                    <Cell key={i} fill={b.min >= 67 ? "#22c55e" : b.min >= 34 ? "#f59e0b" : "#ef4444"} fillOpacity={0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="px-4 pb-3 text-xs text-zinc-500">
              {q2Bins.filter((b) => b.count > 0).map((b) => (
                <span key={b.label} className="mr-3">{b.label}: {b.count} runs</span>
              ))}
            </div>
          </ChartCard>

          {/* Q3 — Rolling window correlation */}
          <ChartCard title="Recovery Window vs Performance Correlation">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={q3Windows} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="label" tick={{ fill: "#71717a", fontSize: 11 }} />
                <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={40} domain={[0, 1]} />
                <Tooltip {...tt} formatter={(value: any) => [fmt(+value), "|r|"]} />
                <Bar dataKey="absR" name="|r|" fill="#3b82f6" radius={[4, 4, 0, 0]}>
                  {q3Windows.map((w, i) => (
                    <Cell key={i} fill={q3Best && w.window === q3Best.window ? "#22c55e" : "#3b82f6"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </section>

      {/* ============================================================= */}
      {/* Section 2: Sleep ↔ Recovery */}
      {/* ============================================================= */}
      <section ref={(el) => { sectionRefs.current["sleep-recovery"] = el; }} className="mb-12">
        <h3 className="text-lg font-semibold mb-4 text-zinc-200">Sleep ↔ Recovery</h3>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Strongest Predictor"
            value={q4Best ? q4Best.label : "—"}
            sublabel={q4Best ? `r = ${fmt(q4Best.r)}, N = ${q4Best.n}` : undefined}
          />
          <StatCard
            label="Bed Temp vs HRV"
            value={q5R != null ? fmt(q5R) : "—"}
            sublabel={`r, N = ${q5Data.length}`}
          />
          <StatCard
            label="Optimal Bed Temp"
            value={q5OptimalBin ? `${fmt(q5OptimalBin.temp, 1)}°` : "—"}
            sublabel={q5OptimalBin ? `avg HRV ${fmt(q5OptimalBin.avgHrv, 0)} ms` : undefined}
          />
          <StatCard
            label="Min Sleep for Green"
            value={q6Threshold != null ? `${q6Threshold.toFixed(1)} hrs` : "—"}
            sublabel=">50% green recovery"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Q4 — Eight Sleep correlations (horizontal bar) */}
          {q4Metrics.length > 0 && (
            <ChartCard title={`Eight Sleep vs WHOOP Recovery Correlations`}>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={q4Metrics} layout="vertical" margin={{ top: 10, right: 10, bottom: 10, left: 80 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis type="number" tick={{ fill: "#71717a", fontSize: 11 }} domain={[-1, 1]} />
                  <YAxis type="category" dataKey="label" tick={{ fill: "#71717a", fontSize: 11 }} width={80} />
                  <ReferenceLine x={0} stroke="#71717a" />
                  <Tooltip {...tt} formatter={(value: any) => [fmt(+value), "r"]} />
                  <Bar dataKey="r" name="Correlation (r)" radius={[0, 4, 4, 0]}>
                    {q4Metrics.map((m, i) => (
                      <Cell key={i} fill={m.r != null && m.r >= 0 ? "#22c55e" : "#ef4444"} fillOpacity={0.8} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          )}

          {/* Q5 — Bed temp vs HRV scatter */}
          {q5Data.length >= 5 ? (
            <ChartCard title={`Bed Temperature vs HRV (N = ${q5Data.length})`}>
              <ResponsiveContainer width="100%" height={300}>
                <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis type="number" dataKey="eightBedTemp" name="Bed Temp" unit="°" tick={{ fill: "#71717a", fontSize: 11 }} />
                  <YAxis type="number" dataKey="whoopHrv" name="HRV" unit=" ms" tick={{ fill: "#71717a", fontSize: 11 }} />
                  <Tooltip {...tt} />
                  <Scatter data={q5Data} shape="circle" fill="#8b5cf6" fillOpacity={0.6} r={4} />
                  {q5Bins.length >= 2 && (
                    <Scatter data={q5Bins.map((b) => ({ eightBedTemp: b.temp, whoopHrv: b.avgHrv }))} shape="diamond" fill="#f59e0b" r={6} />
                  )}
                  {q5Reg && (() => {
                    const temps = q5Data.map((d) => d.eightBedTemp!);
                    const tl = trendLine(q5Reg, Math.min(...temps), Math.max(...temps));
                    return tl.length === 2 ? (
                      <Scatter
                        data={tl.map((p) => ({ eightBedTemp: p.x, whoopHrv: p.y }))}
                        shape="circle" fill="none"
                        line={{ stroke: "#f59e0b", strokeWidth: 2, strokeDasharray: "6 3" }}
                        legendType="none"
                      >
                        {tl.map((_, i) => <Cell key={i} r={0} />)}
                      </Scatter>
                    ) : null;
                  })()}
                </ScatterChart>
              </ResponsiveContainer>
            </ChartCard>
          ) : (
            <ChartCard title="Bed Temperature vs HRV">
              <div className="flex items-center justify-center h-[300px] text-zinc-500 text-sm">
                Insufficient Eight Sleep data (N = {q5Data.length}, need ≥ 5)
              </div>
            </ChartCard>
          )}

          {/* Q6 — Sleep duration vs recovery */}
          {q6Data.length >= 5 ? (
            <ChartCard title={`Sleep Duration vs Recovery (N = ${q6Data.length})`}>
              <ResponsiveContainer width="100%" height={300}>
                <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis type="number" dataKey="eightDurationHrs" name="Sleep" unit=" hrs" tick={{ fill: "#71717a", fontSize: 11 }} />
                  <YAxis type="number" dataKey="whoopRecovery" name="Recovery" unit="%" tick={{ fill: "#71717a", fontSize: 11 }} domain={[0, 100]} />
                  <ReferenceLine y={67} stroke="#22c55e" strokeDasharray="3 3" label={{ value: "Green", fill: "#22c55e", fontSize: 10 }} />
                  {q6Threshold != null && (
                    <ReferenceLine x={q6Threshold} stroke="#3b82f6" strokeDasharray="3 3" label={{ value: `${q6Threshold.toFixed(1)}h`, fill: "#3b82f6", fontSize: 10 }} />
                  )}
                  <Tooltip {...tt} />
                  <Scatter data={q6Data} shape="circle">
                    {q6Data.map((d, i) => (
                      <Cell key={i} fill={recoveryColor(d.whoopRecovery!)} fillOpacity={0.7} r={4} />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </ChartCard>
          ) : (
            <ChartCard title="Sleep Duration vs Recovery">
              <div className="flex items-center justify-center h-[300px] text-zinc-500 text-sm">
                Insufficient Eight Sleep data (N = {q6Data.length}, need ≥ 5)
              </div>
            </ChartCard>
          )}
        </div>
      </section>

      {/* ============================================================= */}
      {/* Section 3: Sleep ↔ Performance */}
      {/* ============================================================= */}
      <section ref={(el) => { sectionRefs.current["sleep-perf"] = el; }} className="mb-12">
        <h3 className="text-lg font-semibold mb-4 text-zinc-200">Sleep ↔ Performance</h3>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Deep Sleep → Pace"
            value={q7R != null ? fmt(q7R) : "—"}
            sublabel={`r, N = ${q7Data.length} runs`}
          />
          <StatCard
            label="Bed Temp → HR"
            value={q8R != null ? fmt(q8R) : "—"}
            sublabel={`r, N = ${q8Data.length} runs`}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Q7 — Deep sleep vs pace */}
          {q7Data.length >= 5 ? (
            <ChartCard title={`Deep Sleep vs Pace Adherence (N = ${q7Data.length})`}>
              <ResponsiveContainer width="100%" height={300}>
                <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis type="number" dataKey="x" name="Deep Sleep" unit=" hrs" tick={{ fill: "#71717a", fontSize: 11 }} />
                  <YAxis type="number" dataKey="y" name="Pace Delta" unit="%" tick={{ fill: "#71717a", fontSize: 11 }} />
                  <ReferenceLine y={0} stroke="#71717a" strokeDasharray="3 3" />
                  <Tooltip {...tt} />
                  <Scatter
                    data={q7Data.map((d, i) => ({ x: q7DeepSleep[i], y: d.paceDelta }))}
                    shape="circle" fill="#8b5cf6" fillOpacity={0.7} r={5}
                  />
                  {q7Reg && (() => {
                    const xs = q7DeepSleep.filter((v) => v != null) as number[];
                    const tl = trendLine(q7Reg, Math.min(...xs), Math.max(...xs));
                    return tl.length === 2 ? (
                      <Scatter
                        data={tl.map((p) => ({ x: p.x, y: p.y }))}
                        shape="circle" fill="none"
                        line={{ stroke: "#f59e0b", strokeWidth: 2, strokeDasharray: "6 3" }}
                        legendType="none"
                      >
                        {tl.map((_, i) => <Cell key={i} r={0} />)}
                      </Scatter>
                    ) : null;
                  })()}
                </ScatterChart>
              </ResponsiveContainer>
            </ChartCard>
          ) : (
            <ChartCard title="Deep Sleep vs Pace Adherence">
              <div className="flex items-center justify-center h-[300px] text-zinc-500 text-sm">
                Insufficient data (N = {q7Data.length}, need ≥ 5)
              </div>
            </ChartCard>
          )}

          {/* Q8 — Bed temp vs HR */}
          {q8Data.length >= 5 ? (
            <ChartCard title={`Bed Temperature vs HR at Pace (N = ${q8Data.length})`}>
              <ResponsiveContainer width="100%" height={300}>
                <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis type="number" dataKey="eightBedTemp" name="Bed Temp" unit="°" tick={{ fill: "#71717a", fontSize: 11 }} />
                  <YAxis type="number" dataKey="avgHr" name="Avg HR" unit=" bpm" tick={{ fill: "#71717a", fontSize: 11 }} />
                  <Tooltip {...tt} />
                  <Scatter data={q8Data} shape="circle" fill="#06b6d4" fillOpacity={0.7} r={5} />
                  {q8Reg && (() => {
                    const temps = q8Data.map((d) => d.eightBedTemp!);
                    const tl = trendLine(q8Reg, Math.min(...temps), Math.max(...temps));
                    return tl.length === 2 ? (
                      <Scatter
                        data={tl.map((p) => ({ eightBedTemp: p.x, avgHr: p.y }))}
                        shape="circle" fill="none"
                        line={{ stroke: "#f59e0b", strokeWidth: 2, strokeDasharray: "6 3" }}
                        legendType="none"
                      >
                        {tl.map((_, i) => <Cell key={i} r={0} />)}
                      </Scatter>
                    ) : null;
                  })()}
                </ScatterChart>
              </ResponsiveContainer>
            </ChartCard>
          ) : (
            <ChartCard title="Bed Temperature vs HR at Pace">
              <div className="flex items-center justify-center h-[300px] text-zinc-500 text-sm">
                Insufficient Eight Sleep data (N = {q8Data.length}, need ≥ 5)
              </div>
            </ChartCard>
          )}
        </div>
      </section>

      {/* ============================================================= */}
      {/* Section 4: Training Load ↔ Recovery */}
      {/* ============================================================= */}
      <section ref={(el) => { sectionRefs.current["training-load"] = el; }} className="mb-12">
        <h3 className="text-lg font-semibold mb-4 text-zinc-200">Training Load ↔ Recovery</h3>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard
            label="Recovery Normalizes"
            value={q9NormalizeDay != null ? `~${q9NormalizeDay} days` : "—"}
            sublabel="after high strain"
          />
          <StatCard
            label="Optimal Strain:Recovery"
            value={q10Best ? fmt(q10Best.ratio) : "—"}
            sublabel={q10Best ? `avg delta ${fmt(q10Best.avgDelta, 1)}%` : undefined}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Q9 — Recovery bounce-back */}
          {q9Data ? (
            <ChartCard title="Recovery After Strain (by Strain Level)">
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={q9Data} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis dataKey="day" tick={{ fill: "#71717a", fontSize: 11 }} label={{ value: "Days After", fill: "#71717a", fontSize: 11, position: "insideBottom", offset: -5 }} />
                  <YAxis tick={{ fill: "#71717a", fontSize: 11 }} width={40} domain={[0, 100]} />
                  <Tooltip {...tt} formatter={(value: any) => [`${fmt(+value, 0)}%`, undefined]} />
                  <Line type="monotone" dataKey="Low" stroke="#22c55e" strokeWidth={2} dot={{ r: 3 }} name="Low Strain" />
                  <Line type="monotone" dataKey="Medium" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} name="Medium Strain" />
                  <Line type="monotone" dataKey="High" stroke="#ef4444" strokeWidth={2} dot={{ r: 3 }} name="High Strain" />
                </LineChart>
              </ResponsiveContainer>
              <p className="px-4 pb-3 text-xs text-zinc-600">Uses consecutive available data points, not strict calendar days.</p>
            </ChartCard>
          ) : (
            <ChartCard title="Recovery After Strain">
              <div className="flex items-center justify-center h-[300px] text-zinc-500 text-sm">
                Insufficient strain data (need ≥ 20 days)
              </div>
            </ChartCard>
          )}

          {/* Q10 — Strain/recovery ratio vs pace */}
          {q10Data.length >= 5 ? (
            <ChartCard title={`Strain:Recovery Ratio vs Pace Delta (N = ${q10Data.length})`}>
              <ResponsiveContainer width="100%" height={300}>
                <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis type="number" dataKey="ratio" name="Strain/Recovery" tick={{ fill: "#71717a", fontSize: 11 }} />
                  <YAxis type="number" dataKey="paceDelta" name="Pace Delta" unit="%" tick={{ fill: "#71717a", fontSize: 11 }} />
                  <ReferenceLine y={0} stroke="#71717a" strokeDasharray="3 3" />
                  <Tooltip {...tt} />
                  <Scatter data={q10Data} shape="circle" fill="#06b6d4" fillOpacity={0.6} r={4} />
                  {q10Bins.length >= 2 && (
                    <Scatter
                      data={q10Bins.map((b) => ({ ratio: b.ratio, paceDelta: b.avgDelta }))}
                      shape="diamond" fill="#f59e0b" r={6}
                    />
                  )}
                  {q10Reg && (() => {
                    const ratios = q10Data.map((d) => d.ratio);
                    const tl = trendLine(q10Reg, Math.min(...ratios), Math.max(...ratios));
                    return tl.length === 2 ? (
                      <Scatter
                        data={tl.map((p) => ({ ratio: p.x, paceDelta: p.y }))}
                        shape="circle" fill="none"
                        line={{ stroke: "#f59e0b", strokeWidth: 2, strokeDasharray: "6 3" }}
                        legendType="none"
                      >
                        {tl.map((_, i) => <Cell key={i} r={0} />)}
                      </Scatter>
                    ) : null;
                  })()}
                </ScatterChart>
              </ResponsiveContainer>
            </ChartCard>
          ) : (
            <ChartCard title="Strain:Recovery Ratio vs Pace Delta">
              <div className="flex items-center justify-center h-[300px] text-zinc-500 text-sm">
                Insufficient data (N = {q10Data.length}, need ≥ 5)
              </div>
            </ChartCard>
          )}
        </div>
      </section>

      {/* ============================================================= */}
      {/* Section 5: Green Light Conditions */}
      {/* ============================================================= */}
      <section ref={(el) => { sectionRefs.current["green-light"] = el; }} className="mb-12">
        <h3 className="text-lg font-semibold mb-4 text-zinc-200">Green Light Conditions</h3>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {q12Data.thresholds.map((t) => (
            <StatCard
              key={t.label}
              label={`Min ${t.label}`}
              value={t.value != null ? `${fmt(t.value, t.unit === "hrs" ? 1 : 0)}` : "—"}
              unit={t.unit}
              sublabel="25th pctl of hits"
            />
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Q11 — Heatmap */}
          <ChartCard title={`Sleep Score × Recovery Zone → Pace Delta (N = ${q11Grid.total})`}>
            {q11Grid.total >= 5 ? (
              <div className="px-4 pb-4">
                <div className="grid grid-cols-4 gap-1 text-xs">
                  <div />
                  {q11Grid.sleepBins.map((sb) => (
                    <div key={sb} className="text-center text-zinc-500 font-medium py-1">
                      Sleep {sb}
                    </div>
                  ))}
                  {q11Grid.zones.map((rz) => (
                    <>
                      <div key={`label-${rz}`} className="flex items-center text-zinc-400 font-medium pr-2 justify-end">
                        {rz}
                      </div>
                      {q11Grid.sleepBins.map((sb) => {
                        const cell = q11Grid.grid[`${rz}-${sb}`];
                        const delta = cell?.avgDelta;
                        const bg = delta == null ? "bg-zinc-800"
                          : delta <= -3 ? "bg-green-900/60"
                          : delta <= 0 ? "bg-green-900/30"
                          : delta <= 3 ? "bg-red-900/30"
                          : "bg-red-900/60";
                        return (
                          <div key={`${rz}-${sb}`} className={`${bg} rounded-lg p-2 text-center min-h-[48px] flex flex-col justify-center`}>
                            <span className="text-white text-sm font-medium">
                              {delta != null ? `${delta > 0 ? "+" : ""}${fmt(delta, 1)}%` : "—"}
                            </span>
                            <span className="text-zinc-500 text-[10px]">n={cell?.count ?? 0}</span>
                          </div>
                        );
                      })}
                    </>
                  ))}
                </div>
                <p className="text-xs text-zinc-600 mt-2">Sleep bins: Low &lt;60, Med 60-79, High 80+</p>
              </div>
            ) : (
              <div className="flex items-center justify-center h-[200px] text-zinc-500 text-sm">
                Insufficient data with both sleep score and recovery (N = {q11Grid.total})
              </div>
            )}
          </ChartCard>

          {/* Q12 — Hit vs Miss comparison table */}
          <ChartCard title={`Green Light Profile: Hit (${q12Data.hitCount}) vs Miss (${q12Data.missCount})`}>
            <div className="px-4 pb-4">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800">
                    <th className="text-left py-2 font-medium">Metric</th>
                    <th className="text-right py-2 font-medium">Hit Avg</th>
                    <th className="text-right py-2 font-medium">Miss Avg</th>
                    <th className="text-right py-2 font-medium">Diff</th>
                  </tr>
                </thead>
                <tbody>
                  {q12Data.rows.map((row) => (
                    <tr key={row.label} className="border-b border-zinc-800/50">
                      <td className="py-2 text-zinc-300">{row.label}</td>
                      <td className="text-right text-white">{row.hitAvg != null ? fmt(row.hitAvg, 1) : "—"}</td>
                      <td className="text-right text-zinc-400">{row.missAvg != null ? fmt(row.missAvg, 1) : "—"}</td>
                      <td className="text-right">
                        {row.diff != null ? (
                          <span className={row.diff > 0 ? "text-green-400" : row.diff < 0 ? "text-red-400" : "text-zinc-400"}>
                            {row.diff > 0 ? "+" : ""}{fmt(row.diff, 1)}
                          </span>
                        ) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ChartCard>
        </div>
      </section>
    </>
  );
}
