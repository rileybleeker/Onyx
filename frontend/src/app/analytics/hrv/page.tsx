"use client";

import { useEffect, useState } from "react";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  CartesianGrid, ReferenceLine, Cell,
} from "recharts";
import ChartCard from "@/components/ChartCard";
import { chartTooltip, axisTick, gridStyle } from "@/lib/chart-theme";
import { supabase } from "@/lib/supabase";

/* eslint-disable @typescript-eslint/no-explicit-any */

const legendStyle = { fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" };

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------
async function getHrvPredictions() {
  const since = new Date();
  since.setDate(since.getDate() - 7);
  const { data } = await supabase
    .from("hrv_predictions")
    .select("prediction_date,model,predicted_hrv,prediction_lower,prediction_upper,actual_hrv,residual,horizon_days,top_drivers,model_version")
    .in("model", ["xgboost", "prophet", "sarimax"])
    .order("prediction_date", { ascending: false })
    .limit(120);
  return data ?? [];
}

async function getHrvPredictionAccuracy() {
  const since = new Date();
  since.setDate(since.getDate() - 60);
  const { data } = await supabase
    .from("hrv_predictions")
    .select("prediction_date,model,predicted_hrv,actual_hrv,residual,prediction_lower,prediction_upper")
    .eq("model", "xgboost")
    .eq("horizon_days", 1)
    .not("actual_hrv", "is", null)
    .gte("prediction_date", since.toISOString().split("T")[0])
    .order("prediction_date", { ascending: true });
  return data ?? [];
}

async function getHrvModelMetrics() {
  const { data } = await supabase
    .from("hrv_model_metrics")
    .select("*")
    .order("eval_date", { ascending: false })
    .limit(20);
  return data ?? [];
}

async function getHrvAnalysisResults(resultType: string) {
  const { data } = await supabase
    .from("hrv_analysis_results")
    .select("result_type,result_key,result_json,computed_at")
    .eq("result_type", resultType)
    .order("computed_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

async function getHistoricalHrv(days = 180) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const { data } = await supabase
    .from("daily_health_matrix")
    .select("calendar_date,whoop_hrv_rmssd,garmin_hrv")
    .gte("calendar_date", since.toISOString().split("T")[0])
    .not("whoop_hrv_rmssd", "is", null)
    .order("calendar_date", { ascending: true });
  return data ?? [];
}

async function getGarminHrvBaseline(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const { data } = await supabase
    .from("garmin_hrv")
    .select("calendar_date,last_night_avg_ms,baseline_balanced_low_ms,baseline_balanced_upper_ms,weekly_avg_ms")
    .gte("calendar_date", since.toISOString().split("T")[0])
    .order("calendar_date", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

async function getHrvResiduals() {
  const { data } = await supabase
    .from("hrv_predictions")
    .select("prediction_date,model,predicted_hrv,actual_hrv,residual")
    .in("model", ["xgboost", "baseline_naive", "baseline_7d_avg"])
    .not("residual", "is", null)
    .eq("horizon_days", 1)
    .order("prediction_date", { ascending: true });
  return data ?? [];
}

async function getProphetForecast() {
  const today = new Date().toISOString().split("T")[0];
  const { data } = await supabase
    .from("hrv_predictions")
    .select("prediction_date,predicted_hrv,prediction_lower,prediction_upper,actual_hrv")
    .eq("model", "prophet")
    .gte("prediction_date", today)
    .eq("model_version", await getLatestModelVersion())
    .order("prediction_date", { ascending: true })
    .limit(30);
  return data ?? [];
}

async function getLatestModelVersion(): Promise<string> {
  const { data } = await supabase
    .from("hrv_predictions")
    .select("model_version")
    .eq("model", "prophet")
    .not("model_version", "is", null)
    .not("model_version", "like", "backtest%")
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0]?.model_version ?? "";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtDate(s: string) {
  const d = new Date(s + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function rolling7(data: number[], i: number): number {
  const slice = data.slice(Math.max(0, i - 6), i + 1).filter(v => !isNaN(v));
  return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : NaN;
}

function hrvColor(hrv: number | null): string {
  if (!hrv) return "#71717a";
  if (hrv >= 100) return "#22c55e";
  if (hrv >= 60) return "#f59e0b";
  return "#ef4444";
}

// Custom dot for prediction vs actual line
const HrvDot = (props: any) => {
  const { cx, cy, payload } = props;
  if (!payload?.actual || !payload?.predicted) return null;
  const diff = Math.abs(payload.actual - payload.predicted);
  const color = diff > 15 ? "#ef4444" : "transparent";
  return <circle cx={cx} cy={cy} r={4} fill={color} stroke="#ef4444" strokeWidth={1} />;
};

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------
export default function HrvAnalysisPage() {
  const [loading, setLoading] = useState(true);
  const [predictions, setPredictions] = useState<any[]>([]);
  const [accuracy, setAccuracy] = useState<any[]>([]);
  const [metrics, setMetrics] = useState<any[]>([]);
  const [historicalHrv, setHistoricalHrv] = useState<any[]>([]);
  const [garminBaseline, setGarminBaseline] = useState<any>(null);
  const [correlations, setCorrelations] = useState<any[]>([]);
  const [journalImpact, setJournalImpact] = useState<any[]>([]);
  const [featureImportance, setFeatureImportance] = useState<any[]>([]);
  const [residuals, setResiduals] = useState<any[]>([]);
  const [prophetForecast, setProphetForecast] = useState<any[]>([]);
  const [expandedEval, setExpandedEval] = useState(false);

  useEffect(() => {
    Promise.all([
      getHrvPredictions(),
      getHrvPredictionAccuracy(),
      getHrvModelMetrics(),
      getHistoricalHrv(180),
      getGarminHrvBaseline(30),
      getHrvAnalysisResults("correlation"),
      getHrvAnalysisResults("journal_impact"),
      getHrvAnalysisResults("feature_importance"),
      getHrvResiduals(),
      getProphetForecast(),
    ]).then(([preds, acc, m, hist, baseline, corr, ji, fi, res, prophet]) => {
      setPredictions(preds);
      setAccuracy(acc);
      setMetrics(m);
      setHistoricalHrv(hist);
      setGarminBaseline(baseline);
      if (corr?.result_json) {
        try { setCorrelations(JSON.parse(corr.result_json).slice(0, 15)); } catch {}
      }
      if (ji?.result_json) {
        try { setJournalImpact(JSON.parse(ji.result_json).slice(0, 15)); } catch {}
      }
      if (fi?.result_json) {
        try { setFeatureImportance(JSON.parse(fi.result_json).slice(0, 10)); } catch {}
      }
      setResiduals(res);
      setProphetForecast(prophet);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------
  const tomorrowPred = predictions.find(p => p.model === "xgboost" && p.horizon_days === 1 &&
    !p.model_version?.startsWith("backtest") && !p.actual_hrv);
  const todayActualHrv = historicalHrv.length ? Number(historicalHrv[historicalHrv.length - 1]?.whoop_hrv_rmssd) : null;
  const xgbMetrics = metrics.filter(m => m.model === "xgboost").sort((a, b) =>
    new Date(b.eval_date).getTime() - new Date(a.eval_date).getTime())[0];
  const naiveMetrics = metrics.find(m => m.model === "baseline_naive");

  const topDrivers: any[] = tomorrowPred?.top_drivers
    ? (() => { try { return JSON.parse(tomorrowPred.top_drivers); } catch { return []; } })()
    : featureImportance.map(f => ({ label: f.label, shap_value: f.importance }));

  // HRV trend data with 7-day rolling avg
  const hrvValues = historicalHrv.map(d => Number(d.whoop_hrv_rmssd));
  const trendData = historicalHrv.map((d, i) => ({
    date: fmtDate(d.calendar_date),
    hrv: Number(d.whoop_hrv_rmssd),
    rolling7: rolling7(hrvValues, i),
    garminHrv: d.garmin_hrv ? Number(d.garmin_hrv) : null,
  }));

  // Prediction vs actual overlay (last 60 days)
  const predActualData = accuracy.map(d => ({
    date: fmtDate(d.prediction_date),
    actual: Number(d.actual_hrv),
    predicted: Number(d.predicted_hrv),
    lower: d.prediction_lower ? Number(d.prediction_lower) : null,
    upper: d.prediction_upper ? Number(d.prediction_upper) : null,
  }));

  // Prophet 30-day forecast
  const prophetData = [
    ...historicalHrv.slice(-30).map(d => ({
      date: fmtDate(d.calendar_date),
      actual: Number(d.whoop_hrv_rmssd),
      forecast: null, lower: null, upper: null,
    })),
    ...prophetForecast.map(d => ({
      date: fmtDate(d.prediction_date),
      actual: d.actual_hrv ? Number(d.actual_hrv) : null,
      forecast: Number(d.predicted_hrv),
      lower: d.prediction_lower ? Number(d.prediction_lower) : null,
      upper: d.prediction_upper ? Number(d.prediction_upper) : null,
    })),
  ];

  // Model comparison table
  const modelComparison = ["xgboost", "sarimax", "prophet", "baseline_naive", "baseline_7d_avg"].map(m => {
    const row = metrics.filter(r => r.model === m).sort((a, b) =>
      new Date(b.eval_date).getTime() - new Date(a.eval_date).getTime())[0];
    return { model: m, ...row };
  }).filter(r => r.mae);

  // MAE by horizon (XGBoost vs SARIMAX)
  const horizonData = [1, 2, 3, 4, 5, 6, 7].map(h => {
    const xgbH = metrics.find(m => m.model === "xgboost" && m.horizon_days === h);
    const sarimaxH = metrics.find(m => m.model === "sarimax" && m.horizon_days === h);
    const naiveH = metrics.find(m => m.model === "baseline_naive" && m.horizon_days === h);
    return {
      horizon: `t+${h}`,
      xgboost: xgbH?.mae ? Number(xgbH.mae) : null,
      sarimax: sarimaxH?.mae ? Number(sarimaxH.mae) : null,
      naive: naiveH?.mae ? Number(naiveH.mae) : null,
    };
  });

  // Residual histogram
  const residualData: any[] = [];
  if (residuals.length) {
    const xgbRes = residuals.filter(r => r.model === "xgboost").map(r => Number(r.residual));
    const bins = Array.from({ length: 20 }, (_, i) => -50 + i * 5);
    bins.forEach((bin, i) => {
      const count = xgbRes.filter(v => v >= bin && v < bin + 5).length;
      residualData.push({ bin: `${bin}`, count });
    });
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 bg-white/5 animate-pulse rounded" />
        <div className="grid grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-surface-card border border-border-subtle rounded-[6px] p-4 h-28 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const hasData = tomorrowPred || predActualData.length > 0 || trendData.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">HRV Deep Analysis</h2>
          <p className="text-sm text-text-tertiary mt-0.5">
            Predictive modeling · Statistical drivers · {historicalHrv.length} days of data
          </p>
        </div>
        {!hasData && (
          <div className="text-sm text-text-tertiary bg-amber-500/10 border border-amber-500/20 rounded px-3 py-1.5">
            Run <code className="font-mono text-amber-400">python hrv_analysis.py</code> to generate predictions
          </div>
        )}
      </div>

      {/* ── Row 1: Hero Cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Tomorrow's Predicted HRV */}
        <div className="bg-surface-card border border-border-subtle rounded-[6px] p-4 shadow-card relative">
          <p className="text-[10px] text-text-tertiary font-medium uppercase tracking-[0.1em]">Tomorrow&apos;s Predicted HRV</p>
          {tomorrowPred ? (
            <>
              <p className="text-[36px] leading-none font-medium font-mono tabular-nums mt-2"
                 style={{ color: hrvColor(tomorrowPred.predicted_hrv) }}>
                {Number(tomorrowPred.predicted_hrv).toFixed(0)}
                <span className="text-base font-normal text-text-secondary ml-1">ms</span>
              </p>
              <p className="text-[11px] text-text-tertiary mt-1.5">
                90% CI: {Number(tomorrowPred.prediction_lower).toFixed(0)}–{Number(tomorrowPred.prediction_upper).toFixed(0)} ms
              </p>
              {todayActualHrv && (
                <p className="text-[11px] mt-1" style={{
                  color: tomorrowPred.predicted_hrv > todayActualHrv ? "#22c55e" : "#ef4444"
                }}>
                  {tomorrowPred.predicted_hrv > todayActualHrv ? "↑" : "↓"}
                  {" "}{Math.abs(tomorrowPred.predicted_hrv - todayActualHrv).toFixed(1)} ms from today
                </p>
              )}
            </>
          ) : (
            <p className="text-[28px] font-mono text-text-tertiary mt-2">—</p>
          )}
          <span className="absolute top-3 right-3 text-[9px] font-mono text-text-tertiary">XGBOOST</span>
        </div>

        {/* Model Accuracy */}
        <div className="bg-surface-card border border-border-subtle rounded-[6px] p-4 shadow-card">
          <p className="text-[10px] text-text-tertiary font-medium uppercase tracking-[0.1em]">Model Accuracy (30d)</p>
          {xgbMetrics ? (
            <>
              <p className="text-[28px] leading-none font-medium font-mono tabular-nums mt-2 text-text-primary">
                {Number(xgbMetrics.mae).toFixed(1)}<span className="text-xs text-text-secondary ml-1">ms MAE</span>
              </p>
              <p className="text-[11px] text-text-tertiary mt-1.5">
                Directional accuracy: {xgbMetrics.directional_accuracy ? `${Number(xgbMetrics.directional_accuracy).toFixed(0)}%` : "—"}
              </p>
              {naiveMetrics && (
                <p className="text-[11px] text-text-tertiary">
                  vs naive: {Number(naiveMetrics.mae).toFixed(1)} ms (
                  <span style={{ color: Number(xgbMetrics.mae) < Number(naiveMetrics.mae) ? "#22c55e" : "#ef4444" }}>
                    {Number(xgbMetrics.mae) < Number(naiveMetrics.mae) ? "better" : "worse"}
                  </span>)
                </p>
              )}
            </>
          ) : (
            <p className="text-[28px] font-mono text-text-tertiary mt-2">—</p>
          )}
        </div>

        {/* Top Driver Today */}
        <div className="bg-surface-card border border-border-subtle rounded-[6px] p-4 shadow-card">
          <p className="text-[10px] text-text-tertiary font-medium uppercase tracking-[0.1em]">Top Driver Today</p>
          {topDrivers[0] ? (
            <>
              <p className="text-[16px] font-medium text-text-primary mt-2 leading-tight">
                {topDrivers[0].label}
              </p>
              <p className="text-[24px] font-mono tabular-nums mt-1"
                 style={{ color: (topDrivers[0].shap_value ?? topDrivers[0].importance) > 0 ? "#22c55e" : "#ef4444" }}>
                {(topDrivers[0].shap_value ?? topDrivers[0].importance) > 0 ? "+" : ""}
                {Number(topDrivers[0].shap_value ?? topDrivers[0].importance).toFixed(1)} ms
              </p>
              <p className="text-[10px] text-text-tertiary mt-1">SHAP contribution to prediction</p>
            </>
          ) : (
            <p className="text-[28px] font-mono text-text-tertiary mt-2">—</p>
          )}
        </div>
      </div>

      {/* ── Row 2: Key Drivers ── */}
      {topDrivers.length > 0 && (
        <ChartCard title="Top 10 Prediction Drivers" subtitle="SHAP values — contribution to tomorrow's HRV prediction">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={topDrivers.slice(0, 10)} layout="vertical"
                      margin={{ left: 140, right: 20, top: 4, bottom: 4 }}>
              <CartesianGrid {...gridStyle} horizontal={false} />
              <XAxis type="number" tick={axisTick} tickFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(1)}`} />
              <YAxis type="category" dataKey="label" tick={{ ...axisTick, fontSize: 11 }} width={140} />
              <Tooltip
                {...chartTooltip}
                formatter={(v: any) => [`${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(2)} ms`, "SHAP"]}
              />
              <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
              <Bar dataKey="shap_value" radius={[0, 3, 3, 0]}>
                {topDrivers.slice(0, 10).map((d, i) => (
                  <Cell key={i}
                    fill={(d.shap_value ?? d.importance) > 0 ? "#22c55e" : "#ef4444"}
                    fillOpacity={0.85}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* ── Row 3: 30-Day Forecast + Journal Impact ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 30-Day Prophet Forecast */}
        <ChartCard title="30-Day HRV Forecast" source="Prophet">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={prophetData}>
              <defs>
                <linearGradient id="prophetGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} domain={["auto", "auto"]} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Area type="monotone" dataKey="upper" name="Upper CI" stroke="none"
                    fill="url(#prophetGrad)" stackId="ci" />
              <Area type="monotone" dataKey="lower" name="Lower CI" stroke="none"
                    fill="#0a0a0b" stackId="ci" />
              <Line type="monotone" dataKey="actual" stroke="#22c55e" strokeWidth={2}
                    dot={false} name="Actual HRV" connectNulls />
              <Line type="monotone" dataKey="forecast" stroke="#f59e0b" strokeWidth={2}
                    strokeDasharray="5 3" dot={false} name="Forecast" connectNulls />
            </AreaChart>
          </ResponsiveContainer>
          {prophetForecast.length === 0 && (
            <p className="text-[11px] text-text-tertiary text-center mt-2">
              No forecast data — run hrv_analysis.py to generate
            </p>
          )}
        </ChartCard>

        {/* Journal Impact */}
        <ChartCard title="Journal Behavior Impact" subtitle="Mean HRV difference: Yes vs No">
          {journalImpact.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={journalImpact.slice(0, 12)} layout="vertical"
                        margin={{ left: 120, right: 20, top: 4, bottom: 4 }}>
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={axisTick}
                       tickFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(0)}`} />
                <YAxis type="category" dataKey="label" tick={{ ...axisTick, fontSize: 10 }} width={120} />
                <Tooltip {...chartTooltip}
                         formatter={(v: any, n: any) => [`${Number(v).toFixed(1)} ms`, "HRV Δ"]} />
                <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
                <Bar dataKey="diff_ms" radius={[0, 3, 3, 0]}>
                  {journalImpact.slice(0, 12).map((d, i) => (
                    <Cell key={i} fill={d.diff_ms > 0 ? "#22c55e" : "#ef4444"} fillOpacity={0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[260px] flex items-center justify-center">
              <p className="text-[11px] text-text-tertiary">No journal data — run hrv_analysis.py</p>
            </div>
          )}
        </ChartCard>
      </div>

      {/* ── Row 4: Prediction vs Actual + Accuracy by Horizon ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Prediction vs Actual */}
        <ChartCard title="Prediction vs Actual (last 60 days)"
                   subtitle="Red dots = miss > 15ms">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={predActualData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} domain={["auto", "auto"]} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line type="monotone" dataKey="actual" stroke="#22c55e" strokeWidth={2}
                    dot={false} name="Actual HRV" />
              <Line type="monotone" dataKey="predicted" stroke="#3b82f6" strokeWidth={2}
                    dot={<HrvDot />} name="XGBoost Pred" strokeDasharray="4 2" />
            </LineChart>
          </ResponsiveContainer>
          {predActualData.length === 0 && (
            <p className="text-[11px] text-text-tertiary text-center mt-2">No backtest data yet</p>
          )}
        </ChartCard>

        {/* Accuracy by Horizon */}
        <ChartCard title="Accuracy by Forecast Horizon"
                   subtitle="MAE (ms) — lower is better">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={horizonData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="horizon" tick={axisTick} />
              <YAxis tick={axisTick} width={40} label={{
                value: "MAE (ms)", angle: -90, position: "insideLeft",
                style: { fill: "#71717a", fontSize: 10 }
              }} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Bar dataKey="xgboost" name="XGBoost" fill="#3b82f6" radius={[3, 3, 0, 0]} />
              <Bar dataKey="naive" name="Naive" fill="#f59e0b" radius={[3, 3, 0, 0]} />
              {horizonData.some(d => d.sarimax) && (
                <Bar dataKey="sarimax" name="SARIMAX" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
              )}
            </BarChart>
          </ResponsiveContainer>
          {horizonData.every(d => !d.xgboost) && (
            <p className="text-[11px] text-text-tertiary text-center mt-2">No horizon metrics yet</p>
          )}
        </ChartCard>
      </div>

      {/* ── Row 5: Correlation Heatmap + HRV Trend ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top-15 Correlations */}
        <ChartCard title="HRV Correlates" subtitle="Top 15 features — Spearman r with WHOOP HRV">
          {correlations.length > 0 ? (
            <ResponsiveContainer width="100%" height={340}>
              <BarChart data={correlations} layout="vertical"
                        margin={{ left: 160, right: 20, top: 4, bottom: 4 }}>
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={axisTick} domain={[-1, 1]} tickFormatter={v => v.toFixed(1)} />
                <YAxis type="category" dataKey="label" tick={{ ...axisTick, fontSize: 10 }} width={160} />
                <Tooltip {...chartTooltip}
                         formatter={(v: any) => [Number(v).toFixed(3), "Spearman r"]} />
                <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
                <Bar dataKey="spearman_r" radius={[0, 3, 3, 0]}>
                  {correlations.map((d, i) => (
                    <Cell key={i} fill={d.spearman_r > 0 ? "#22c55e" : "#ef4444"} fillOpacity={0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[340px] flex items-center justify-center">
              <p className="text-[11px] text-text-tertiary">Run hrv_analysis.py to compute correlations</p>
            </div>
          )}
        </ChartCard>

        {/* HRV Trend */}
        <ChartCard title="HRV Trend (180 days)"
                   subtitle="7-day rolling average + Garmin baseline">
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={trendData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={40} domain={["auto", "auto"]} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              {garminBaseline?.baseline_balanced_low_ms && (
                <ReferenceLine
                  y={Number(garminBaseline.baseline_balanced_low_ms)}
                  stroke="#3b82f6" strokeDasharray="4 4" strokeOpacity={0.5}
                  label={{ value: "Baseline Low", fill: "#71717a", fontSize: 9 }}
                />
              )}
              {garminBaseline?.baseline_balanced_upper_ms && (
                <ReferenceLine
                  y={Number(garminBaseline.baseline_balanced_upper_ms)}
                  stroke="#22c55e" strokeDasharray="4 4" strokeOpacity={0.5}
                  label={{ value: "Baseline High", fill: "#71717a", fontSize: 9 }}
                />
              )}
              <Line type="monotone" dataKey="hrv" stroke="#22c55e" strokeWidth={1.5}
                    dot={false} name="WHOOP HRV" strokeOpacity={0.5} />
              <Line type="monotone" dataKey="rolling7" stroke="#22c55e" strokeWidth={2.5}
                    dot={false} name="7-Day Avg" />
              {trendData.some(d => d.garminHrv) && (
                <Line type="monotone" dataKey="garminHrv" stroke="#3b82f6" strokeWidth={1.5}
                      dot={false} name="Garmin HRV" strokeOpacity={0.7} />
              )}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ── Row 6: Model Evaluation (collapsible) ── */}
      <div className="bg-surface-card border border-border-subtle rounded-[6px] shadow-card overflow-hidden">
        <button
          onClick={() => setExpandedEval(!expandedEval)}
          className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-white/[0.02] transition-colors"
        >
          <div>
            <h3 className="text-[13px] font-medium text-text-secondary">Model Evaluation Detail</h3>
            <p className="text-[11px] text-text-tertiary mt-0.5">
              Residual analysis · Rolling MAE · CI calibration · Model comparison
            </p>
          </div>
          <svg
            className={`w-4 h-4 text-text-tertiary transition-transform ${expandedEval ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {expandedEval && (
          <div className="px-5 pb-6 space-y-6 border-t border-border-subtle pt-5">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Residual histogram */}
              <div>
                <h4 className="text-[12px] font-medium text-text-secondary mb-3">Residual Distribution (XGBoost)</h4>
                {residualData.length > 0 && residualData.some(d => d.count > 0) ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={residualData}>
                      <CartesianGrid {...gridStyle} />
                      <XAxis dataKey="bin" tick={{ ...axisTick, fontSize: 9 }} interval={3} />
                      <YAxis tick={axisTick} width={30} />
                      <Tooltip {...chartTooltip} />
                      <ReferenceLine x="0" stroke="#ef4444" strokeWidth={1.5} />
                      <Bar dataKey="count" fill="#3b82f6" fillOpacity={0.8} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-[11px] text-text-tertiary h-[200px] flex items-center justify-center">
                    No residual data
                  </p>
                )}
              </div>

              {/* CI Calibration + rolling MAE stat */}
              <div className="space-y-4">
                <h4 className="text-[12px] font-medium text-text-secondary">CI Calibration</h4>
                {xgbMetrics?.ci_coverage ? (
                  <div className="flex items-center gap-4">
                    <span className="text-[36px] font-mono font-medium tabular-nums"
                          style={{
                            color: Number(xgbMetrics.ci_coverage) >= 85 && Number(xgbMetrics.ci_coverage) <= 95
                              ? "#22c55e" : "#f59e0b"
                          }}>
                      {Number(xgbMetrics.ci_coverage).toFixed(0)}%
                    </span>
                    <div>
                      <p className="text-sm text-text-secondary">of actuals inside 90% CI</p>
                      <p className="text-[11px] text-text-tertiary">
                        {Number(xgbMetrics.ci_coverage) >= 85 && Number(xgbMetrics.ci_coverage) <= 95
                          ? "Well calibrated"
                          : Number(xgbMetrics.ci_coverage) < 85
                          ? "Intervals too narrow (overconfident)"
                          : "Intervals too wide (underconfident)"}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] text-text-tertiary">No CI data yet</p>
                )}

                {xgbMetrics?.ci_avg_width && (
                  <div className="text-[11px] text-text-tertiary">
                    Average CI width: <span className="text-text-secondary font-mono">
                      {Number(xgbMetrics.ci_avg_width).toFixed(1)} ms
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Model comparison table */}
            <div>
              <h4 className="text-[12px] font-medium text-text-secondary mb-3">Model Comparison</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/10">
                      {["Model", "MAE (ms)", "RMSE", "R²", "Dir %", "CI Cov", "n"].map(h => (
                        <th key={h} className="text-left text-text-tertiary font-mono uppercase text-[10px] tracking-wider py-2 pr-4">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {modelComparison.length > 0 ? modelComparison.map(row => (
                      <tr key={row.model} className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="py-2 pr-4 font-mono text-text-secondary">{row.model}</td>
                        <td className="py-2 pr-4 tabular-nums"
                            style={{ color: row.model === "xgboost" ? "#22c55e" : "#a1a1aa" }}>
                          {row.mae ? Number(row.mae).toFixed(1) : "—"}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-text-tertiary">
                          {row.rmse ? Number(row.rmse).toFixed(1) : "—"}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-text-tertiary">
                          {row.r_squared ? Number(row.r_squared).toFixed(3) : "—"}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-text-tertiary">
                          {row.directional_accuracy ? `${Number(row.directional_accuracy).toFixed(0)}%` : "—"}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-text-tertiary">
                          {row.ci_coverage ? `${Number(row.ci_coverage).toFixed(0)}%` : "—"}
                        </td>
                        <td className="py-2 tabular-nums text-text-tertiary">
                          {row.n_predictions ?? "—"}
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={7} className="py-4 text-center text-text-tertiary">
                          Run hrv_analysis.py to populate metrics
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
