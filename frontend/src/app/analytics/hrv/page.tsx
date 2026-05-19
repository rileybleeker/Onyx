"use client";

import { useEffect, useState } from "react";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  CartesianGrid, ReferenceLine, Cell,
} from "recharts";
import ChartCard from "@/components/ChartCard";
import { chartTooltip, axisTick, gridStyle, axisLabel } from "@/lib/chart-theme";
import { supabase } from "@/lib/supabase";
import { getWorkoutSleepGap, type WorkoutSleepGap } from "@/lib/queries";

/* eslint-disable @typescript-eslint/no-explicit-any */

const legendStyle = { fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" };

// ---------------------------------------------------------------------------
// Data fetching
//
// All forecast queries read from pds.hrv_predictions_latest — a DISTINCT ON
// view that returns one row per (prediction_date, model, horizon_days), always
// the freshest and excluding backtest rows. Readers do not reason about
// run-history or model_version freshness.
// ---------------------------------------------------------------------------

// ET tomorrow as YYYY-MM-DD. ET is canonical for all calendar_date joins in
// this pipeline; browser-local would drift for users outside ET.
function etTomorrowStr(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === "year")!.value;
  const m = parts.find(p => p.type === "month")!.value;
  const d = parts.find(p => p.type === "day")!.value;
  const t = new Date(`${y}-${m}-${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().split("T")[0];
}

async function getTomorrowPrediction() {
  const tomorrow = etTomorrowStr();
  const cols = "prediction_date,model,predicted_hrv,prediction_lower,prediction_upper,actual_hrv,horizon_days,top_drivers,model_version";
  const primary = await supabase
    .from("hrv_predictions_latest")
    .select(cols)
    .eq("model", "xgboost")
    .eq("horizon_days", 1)
    .eq("prediction_date", tomorrow)
    .is("actual_hrv", null)
    .limit(1);
  if (primary.data?.[0]) return primary.data[0];
  // Fallback: earliest unscored XGBoost h=1 on or after ET tomorrow.
  const fb = await supabase
    .from("hrv_predictions_latest")
    .select(cols)
    .eq("model", "xgboost")
    .eq("horizon_days", 1)
    .gte("prediction_date", tomorrow)
    .is("actual_hrv", null)
    .order("prediction_date", { ascending: true })
    .limit(1);
  return fb.data?.[0] ?? null;
}

async function getHrvPredictionAccuracy() {
  const since = new Date();
  since.setDate(since.getDate() - 60);
  const { data } = await supabase
    .from("hrv_predictions_latest")
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

async function getHrvAnalysisResults(resultType: string, resultKey?: string) {
  let query = supabase
    .from("hrv_analysis_results")
    .select("result_type,result_key,result_json,computed_at")
    .eq("result_type", resultType);
  if (resultKey) query = query.eq("result_key", resultKey);
  const { data } = await query.order("computed_at", { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

async function getHistoricalHrv(days = 180) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const { data } = await supabase
    .from("daily_health_matrix")
    .select("calendar_date,whoop_hrv_rmssd")
    .gte("calendar_date", since.toISOString().split("T")[0])
    .not("whoop_hrv_rmssd", "is", null)
    .order("calendar_date", { ascending: true });
  return data ?? [];
}

async function getHrvResiduals() {
  const { data } = await supabase
    .from("hrv_predictions_latest")
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
    .from("hrv_predictions_latest")
    .select("prediction_date,predicted_hrv,prediction_lower,prediction_upper,actual_hrv")
    .eq("model", "prophet")
    .gte("prediction_date", today)
    .order("prediction_date", { ascending: true })
    .limit(30);
  return data ?? [];
}

async function getSarimaxForecast() {
  const today = new Date().toISOString().split("T")[0];
  const { data } = await supabase
    .from("hrv_predictions_latest")
    .select("prediction_date,predicted_hrv,prediction_lower,prediction_upper")
    .eq("model", "sarimax")
    .gte("prediction_date", today)
    .order("prediction_date", { ascending: true })
    .limit(7);
  return data ?? [];
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
  const [tomorrowPred, setTomorrowPred] = useState<any | null>(null);
  const [accuracy, setAccuracy] = useState<any[]>([]);
  const [metrics, setMetrics] = useState<any[]>([]);
  const [historicalHrv, setHistoricalHrv] = useState<any[]>([]);
  const [correlations, setCorrelations] = useState<any[]>([]);
  const [journalImpact, setJournalImpact] = useState<any[]>([]);
  const [featureImportance, setFeatureImportance] = useState<any[]>([]);
  const [residuals, setResiduals] = useState<any[]>([]);
  const [prophetForecast, setProphetForecast] = useState<any[]>([]);
  const [sarimaxForecast, setSarimaxForecast] = useState<any[]>([]);
  const [journalCorrelations, setJournalCorrelations] = useState<any[]>([]);
  const [journalShap, setJournalShap] = useState<any[]>([]);
  const [workoutGap, setWorkoutGap] = useState<WorkoutSleepGap[]>([]);
  const [expandedEval, setExpandedEval] = useState(false);
  const [expandedModels, setExpandedModels] = useState(false);

  useEffect(() => {
    Promise.all([
      getTomorrowPrediction(),
      getHrvPredictionAccuracy(),
      getHrvModelMetrics(),
      getHistoricalHrv(180),
      getHrvAnalysisResults("correlation", "spearman_top50"),
      getHrvAnalysisResults("journal_impact"),
      getHrvAnalysisResults("feature_importance", "shap_mean_abs"),
      getHrvResiduals(),
      getProphetForecast(),
      getHrvAnalysisResults("correlation", "spearman_journal"),
      getHrvAnalysisResults("feature_importance", "shap_journal"),
      getSarimaxForecast(),
      getWorkoutSleepGap(90),
    ]).then(([tomorrow, acc, m, hist, corr, ji, fi, res, prophet, jCorr, jShap, sarimax, wkGap]) => {
      setTomorrowPred(tomorrow);
      setAccuracy(acc);
      setMetrics(m);
      setHistoricalHrv(hist);
      if (corr?.result_json) {
        try { setCorrelations(JSON.parse(corr.result_json).slice(0, 15)); } catch {}
      }
      if (ji?.result_json) {
        try { setJournalImpact(JSON.parse(ji.result_json).slice(0, 15)); } catch {}
      }
      if (fi?.result_json) {
        try { setFeatureImportance(JSON.parse(fi.result_json).slice(0, 10)); } catch {}
      }
      if (jCorr?.result_json) {
        try { setJournalCorrelations(JSON.parse(jCorr.result_json)); } catch {}
      }
      if (jShap?.result_json) {
        try { setJournalShap(JSON.parse(jShap.result_json)); } catch {}
      }
      setResiduals(res);
      setProphetForecast(prophet);
      setSarimaxForecast(sarimax);
      setWorkoutGap(wkGap);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------
  const todayActualHrv = historicalHrv.length ? Number(historicalHrv[historicalHrv.length - 1]?.whoop_hrv_rmssd) : null;
  const xgbMetrics = metrics.filter(m => m.model === "xgboost").sort((a, b) =>
    new Date(b.eval_date).getTime() - new Date(a.eval_date).getTime())[0];
  const naiveMetrics = metrics.find(m => m.model === "baseline_naive");

  const rawDrivers: any = tomorrowPred?.top_drivers
    ? (() => { try { return JSON.parse(tomorrowPred.top_drivers); } catch { return null; } })()
    : null;
  const topDrivers: any[] = Array.isArray(rawDrivers)
    ? rawDrivers
    : (rawDrivers?.top ?? featureImportance.map(f => ({ label: f.label, shap_value: f.importance })));
  // Today-specific signed SHAP values for journal features. Falls back to
  // historical mean-abs (unsigned) if the new payload shape isn't present.
  const journalDriversToday: any[] = Array.isArray(rawDrivers)
    ? []
    : (rawDrivers?.journal ?? []);

  // HRV trend data with 7-day rolling avg
  const hrvValues = historicalHrv.map(d => Number(d.whoop_hrv_rmssd));
  const trendData = historicalHrv.map((d, i) => ({
    date: fmtDate(d.calendar_date),
    hrv: Number(d.whoop_hrv_rmssd),
    rolling7: rolling7(hrvValues, i),
  }));

  // Prediction vs actual overlay (last 60 days)
  const predActualData = accuracy.map(d => ({
    date: fmtDate(d.prediction_date),
    actual: Number(d.actual_hrv),
    predicted: Number(d.predicted_hrv),
    lower: d.prediction_lower ? Number(d.prediction_lower) : null,
    upper: d.prediction_upper ? Number(d.prediction_upper) : null,
  }));

  // Prophet 30-day forecast + SARIMAX 7-day short-term overlay
  const sarimaxByDate = new Map(
    sarimaxForecast.map(d => [d.prediction_date, Number(d.predicted_hrv)])
  );
  const prophetData = [
    ...historicalHrv.slice(-30).map(d => ({
      date: fmtDate(d.calendar_date),
      actual: Number(d.whoop_hrv_rmssd),
      forecast: null, lower: null, upper: null, sarimax: null,
    })),
    ...prophetForecast.map(d => ({
      date: fmtDate(d.prediction_date),
      actual: d.actual_hrv ? Number(d.actual_hrv) : null,
      forecast: Number(d.predicted_hrv),
      lower: d.prediction_lower ? Number(d.prediction_lower) : null,
      upper: d.prediction_upper ? Number(d.prediction_upper) : null,
      sarimax: sarimaxByDate.has(d.prediction_date)
        ? sarimaxByDate.get(d.prediction_date)
        : null,
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
          <p className="text-[10px] text-text-tertiary mt-2 leading-relaxed">
            An AI model trained on your own workout, sleep, and behavior data to predict next-night HRV. The range below the number is where it expects your HRV to land 9 out of 10 nights.
          </p>
          <span className="absolute top-3 right-3 text-[9px] font-mono text-text-tertiary">XGBOOST</span>
        </div>

        {/* Model Accuracy */}
        <div className="bg-surface-card border border-border-subtle rounded-[6px] p-4 shadow-card relative">
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
              <p className="text-[10px] text-text-tertiary mt-2 leading-relaxed">
                On average, the model was off by this many ms. Directional accuracy is how often it correctly called whether HRV would go up or down. The &ldquo;naive&rdquo; comparison just uses yesterday&apos;s HRV as the guess — beating it means the model is actually learning something.
              </p>
            </>
          ) : (
            <p className="text-[28px] font-mono text-text-tertiary mt-2">—</p>
          )}
          <span className="absolute top-3 right-3 text-[9px] font-mono text-text-tertiary">XGBOOST</span>
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

      {/* ── Models & Methods ── */}
      <div className="bg-surface-card border border-border-subtle rounded-[6px] shadow-card overflow-hidden">
        <button
          onClick={() => setExpandedModels(!expandedModels)}
          className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-white/[0.02] transition-colors"
        >
          <div>
            <h3 className="text-[13px] font-medium text-text-secondary">Models &amp; Methods</h3>
            <p className="text-[11px] text-text-tertiary mt-0.5">How the predictions and statistical analysis work — click to expand</p>
          </div>
          <svg className={`w-4 h-4 text-text-tertiary transition-transform ${expandedModels ? "rotate-180" : ""}`}
               fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {expandedModels && (
          <div className="px-5 pb-6 border-t border-border-subtle pt-5 space-y-6">

            {/* Primary models */}
            <div>
              <p className="text-[10px] font-mono font-medium tracking-wider text-text-tertiary uppercase mb-3">Prediction Models</p>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

                <div className="bg-white/[0.03] rounded-[6px] p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-text-primary">XGBoost</span>
                    <span className="text-[9px] font-mono text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">DAY-AHEAD</span>
                  </div>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">What it is:</strong> A machine learning model that builds hundreds of small decision trees, each one correcting the mistakes of the last. The final prediction is all of them voting together.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">Why it&apos;s used:</strong> Excellent at finding non-obvious patterns across many variables at once — like &ldquo;high strain + poor sleep + high stress = low HRV&rdquo; — which simpler methods miss.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">What it predicts:</strong> Tomorrow&apos;s HRV, using today&apos;s ~250-feature matrix (training load, sleep quality, behaviors, recent HRV trend, etc.).
                  </p>
                </div>

                <div className="bg-white/[0.03] rounded-[6px] p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-text-primary">Prophet</span>
                    <span className="text-[9px] font-mono text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">30-DAY FORECAST</span>
                  </div>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">What it is:</strong> A forecasting model developed by Meta that splits your HRV history into three layers: a long-term trend, a weekly rhythm, and random noise — then adds them back together to project forward.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">Why it&apos;s used:</strong> Great at capturing repeating cycles — like &ldquo;HRV tends to dip on Mondays after heavy weekend training&rdquo; — and extending them into the future.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">What it predicts:</strong> Your likely HRV range over the next 30 days, including an uncertainty band.
                  </p>
                </div>

                <div className="bg-red-500/10 border border-red-500/40 rounded-[6px] p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-text-primary">SARIMAX</span>
                    <span className="text-[9px] font-mono text-red-400 bg-red-500/20 px-1.5 py-0.5 rounded-[2px]">NEEDS FIX</span>
                  </div>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">What it is:</strong> A classical statistics model that predicts tomorrow&apos;s HRV using your own past HRV values (today&apos;s HRV predicts tomorrow&apos;s to some degree), while also factoring in external variables like training load.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">Why it&apos;s used:</strong> Provides a transparent, interpretable baseline alongside XGBoost. If both models agree, the prediction is more reliable.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">What it predicts:</strong> Day-ahead HRV using recent HRV history + seasonal patterns + external inputs.
                  </p>
                </div>
              </div>
            </div>

            {/* Analysis methods */}
            <div>
              <p className="text-[10px] font-mono font-medium tracking-wider text-text-tertiary uppercase mb-3">Analysis Methods</p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">

                <div className="bg-white/[0.03] rounded-[6px] p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-text-primary">SHAP Values</span>
                    <span className="text-[9px] font-mono text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">EXPLAINABILITY</span>
                  </div>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">What it is:</strong> A method for opening up the &ldquo;black box&rdquo; of XGBoost to show why it made a specific prediction. Rooted in game theory — each feature gets credit proportional to how much it actually contributed.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">Why it&apos;s used:</strong> XGBoost alone can&apos;t tell you <em>why</em> it predicted a number. SHAP translates each prediction into a plain breakdown: &ldquo;your resting HR added +8ms, your sleep duration added +4ms, your strain subtracted −12ms.&rdquo;
                  </p>
                </div>

                <div className="bg-white/[0.03] rounded-[6px] p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-text-primary">Spearman Correlation</span>
                    <span className="text-[9px] font-mono text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">HISTORICAL PATTERNS</span>
                  </div>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">What it is:</strong> A statistical measure of how consistently two things move together. Instead of comparing raw numbers, it converts both to ranks (1st highest, 2nd highest, etc.) and checks how well those ranks agree.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">Why it&apos;s used:</strong> More reliable than standard correlation for health data because it&apos;s not thrown off by outliers or skewed distributions. Scores range from −1.0 to +1.0.
                  </p>
                </div>

                <div className="bg-white/[0.03] rounded-[6px] p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-text-primary">Welch&apos;s T-Test</span>
                    <span className="text-[9px] font-mono text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">JOURNAL IMPACT</span>
                  </div>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">What it is:</strong> A statistical test that compares the average HRV on nights you logged a behavior as <em>Yes</em> vs nights you logged <em>No</em>, and tells you whether the gap is real or just random noise. &ldquo;Welch&apos;s&rdquo; means it doesn&apos;t assume the two groups have the same variance — which matters because Yes/No nights are usually unbalanced.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">Why it&apos;s used:</strong> Correlation tells you strength on a −1 to +1 scale; the t-test tells you the <em>actual HRV difference in ms</em> and whether it&apos;s statistically significant. That&apos;s why it drives the Journal Behavior Impact chart — the bars are mean HRV differences, with Cohen&apos;s d and a 95% confidence interval computed per behavior.
                  </p>
                </div>

                <div className="bg-white/[0.03] rounded-[6px] p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-text-primary">Naive &amp; 7d Avg Baselines</span>
                    <span className="text-[9px] font-mono text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">BENCHMARKS</span>
                  </div>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">What they are:</strong> The simplest possible &ldquo;models&rdquo; — no machine learning involved. Naive predicts tomorrow&apos;s HRV will equal today&apos;s. 7d Avg predicts it will equal the last 7-day mean.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">Why they&apos;re used:</strong> Every real model must beat these to prove it&apos;s actually learning something. If XGBoost can&apos;t outperform &ldquo;just copy yesterday,&rdquo; it isn&apos;t useful.
                  </p>
                </div>
              </div>
            </div>

          </div>
        )}
      </div>

      {/* ── Row 2: Prediction Drivers + HRV Correlates ── */}
      <div className="space-y-4">
        {/* Explanation banner */}
        <div className="bg-surface-card border border-border-subtle rounded-[6px] p-4 shadow-card">
          <h3 className="text-[13px] font-medium text-text-secondary mb-3">Two ways to understand what is associated with your HRV</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <p className="text-[11px] font-medium text-text-primary mb-1">Prediction Drivers <span className="text-text-tertiary font-normal">(left chart)</span></p>
              <p className="text-[11px] text-text-tertiary leading-relaxed">
                What the model is using to push <em>tomorrow&apos;s specific forecast</em> up or down, right now. Recalculated every day. These are statistical associations the model has learned, not proven causes.
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-text-primary mb-1">HRV Correlates <span className="text-text-tertiary font-normal">(right chart)</span></p>
              <p className="text-[11px] text-text-tertiary leading-relaxed">
                What has <em>historically</em> moved with your HRV across all your data. Doesn&apos;t change day to day. No model involved — just a statistical pattern across your entire history.
              </p>
            </div>
          </div>
          <p className="text-[10px] text-text-tertiary mt-3 pt-3 border-t border-border-subtle">
            When both charts agree on a factor, you can be confident it genuinely matters. When they disagree, the model has learned something more nuanced than the simple historical pattern alone suggests.
            Your journal behaviors (alcohol, meditation, caffeine, etc.) are included in both analyses as Yes/No features — they appear in a dedicated sub-section at the bottom of each chart, separated because their scores are on a different scale to continuous metrics like heart rate.
          </p>
        </div>

        {/* Side-by-side charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ChartCard title="Prediction Drivers (Today)" subtitle="What's driving tomorrow's forecast right now"
            source="XGBOOST · SHAP"
            info="Shows what's pushing tomorrow's prediction up or down. Green bars are factors that raised the forecast; red bars lowered it. The longer the bar, the bigger the impact. This updates every day as your data changes. Journal behaviors appear in a separate section below because they're Yes/No entries — they have smaller numerical impact than continuous metrics like heart rate, but they're still part of the model.">
            {topDrivers.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={topDrivers.slice(0, 10)} layout="vertical"
                          margin={{ left: 140, right: 20, top: 4, bottom: 20 }}>
                  <CartesianGrid {...gridStyle} horizontal={false} />
                  <XAxis type="number" tick={axisTick} tickFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(1)}`}
                         label={axisLabel("HRV impact (ms)", "x")} />
                  <YAxis type="category" dataKey="label" tick={{ ...axisTick, fontSize: 11 }} width={140} />
                  <Tooltip
                    {...chartTooltip}
                    formatter={(v: any) => [`${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(2)} ms`, "Impact"]}
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
            ) : (
              <div className="h-[300px] flex items-center justify-center">
                <p className="text-[11px] text-text-tertiary">No prediction data — run hrv_analysis.py</p>
              </div>
            )}

            {/* Journal behavior SHAP sub-section */}
            <div className="mt-4 pt-4 border-t border-border-subtle">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-mono font-medium tracking-wider text-text-tertiary uppercase">Journal Behaviors</span>
                <span className="text-[9px] text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px] font-mono">XGBOOST · SHAP</span>
              </div>
              <p className="text-[10px] text-text-tertiary leading-relaxed mb-3">
                Your logged Yes/No behaviors are part of the model. A <span className="text-[#22c55e]">green</span> bar means that behavior <em>raised</em> tomorrow&apos;s predicted HRV today; a <span className="text-[#ef4444]">red</span> bar means it <em>lowered</em> it. Binary features have smaller ms impact than continuous metrics but still shift the forecast.
              </p>
              {journalDriversToday.length > 0 ? (
                <ResponsiveContainer width="100%" height={Math.max(120, journalDriversToday.length * 22)}>
                  <BarChart data={journalDriversToday} layout="vertical"
                            margin={{ left: 160, right: 20, top: 2, bottom: 20 }}>
                    <CartesianGrid {...gridStyle} horizontal={false} />
                    <XAxis type="number" tick={axisTick} tickFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(2)}`}
                           label={axisLabel("HRV impact (ms)", "x")} />
                    <YAxis type="category" dataKey="label" tick={{ ...axisTick, fontSize: 10 }} width={160}
                           tickFormatter={(v: string) => v.replace(/^journal_/, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())} />
                    <Tooltip {...chartTooltip}
                             formatter={(v: any) => [`${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(3)} ms`, Number(v) > 0 ? "Raised forecast" : "Lowered forecast"]} />
                    <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
                    <Bar dataKey="shap_value" radius={[0, 3, 3, 0]}>
                      {journalDriversToday.map((d, i) => (
                        <Cell key={i} fill={d.shap_value > 0 ? "#22c55e" : "#ef4444"} fillOpacity={0.85} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : journalShap.length > 0 ? (
                <>
                  <p className="text-[10px] text-amber-400/80 italic mb-2">
                    Showing historical average direction — re-run hrv_predict.py for today-specific signed values.
                  </p>
                  <ResponsiveContainer width="100%" height={Math.max(120, journalShap.length * 22)}>
                    <BarChart data={journalShap} layout="vertical"
                              margin={{ left: 160, right: 20, top: 2, bottom: 2 }}>
                      <CartesianGrid {...gridStyle} horizontal={false} />
                      <XAxis type="number" tick={axisTick} tickFormatter={v => v.toFixed(2)} />
                      <YAxis type="category" dataKey="label" tick={{ ...axisTick, fontSize: 10 }} width={160}
                             tickFormatter={(v: string) => v.replace(/^journal_/, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())} />
                      <Tooltip {...chartTooltip}
                               formatter={(v: any) => [`${Number(v).toFixed(3)} ms`, "Avg |Impact|"]} />
                      <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
                      <Bar dataKey="importance" radius={[0, 3, 3, 0]}>
                        {journalShap.map((d, i) => (
                          <Cell key={i} fill="#8b5cf6" fillOpacity={0.75} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </>
              ) : (
                <p className="text-[11px] text-text-tertiary italic">
                  Journal behavior impacts not yet computed — re-run hrv_analysis.py to generate.
                </p>
              )}
            </div>
          </ChartCard>

          <ChartCard title="HRV Correlates (Historical)" subtitle="What has historically moved with your HRV"
            source="SPEARMAN ρ"
            info="How strongly each factor is linked to your HRV across your entire history. A bar near +1.0 means that factor almost always rises when your HRV rises. A bar near −1.0 means the opposite. This doesn't change day to day — it's a long-term pattern. Journal behaviors appear in a separate section below because Yes/No features have a narrower correlation range than continuous metrics.">
            {correlations.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={correlations} layout="vertical"
                          margin={{ left: 160, right: 20, top: 4, bottom: 4 }}>
                  <CartesianGrid {...gridStyle} horizontal={false} />
                  <XAxis type="number" tick={axisTick} domain={[-1, 1]} tickFormatter={v => v.toFixed(1)} />
                  <YAxis type="category" dataKey="label" tick={{ ...axisTick, fontSize: 10 }} width={160} />
                  <Tooltip {...chartTooltip}
                           formatter={(v: any) => [Number(v).toFixed(3), "Correlation"]} />
                  <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
                  <Bar dataKey="spearman_r" radius={[0, 3, 3, 0]}>
                    {correlations.map((d, i) => (
                      <Cell key={i} fill={d.spearman_r > 0 ? "#22c55e" : "#ef4444"} fillOpacity={0.8} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[300px] flex items-center justify-center">
                <p className="text-[11px] text-text-tertiary">Run hrv_analysis.py to compute correlations</p>
              </div>
            )}

            {/* Journal behavior correlation sub-section */}
            <div className="mt-4 pt-4 border-t border-border-subtle">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-mono font-medium tracking-wider text-text-tertiary uppercase">Journal Behaviors</span>
                <span className="text-[9px] text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px] font-mono">SPEARMAN ρ</span>
              </div>
              <p className="text-[10px] text-text-tertiary leading-relaxed mb-3">
                Correlation between each logged behavior and the following night&apos;s HRV, across your entire history. Yes/No features naturally produce smaller correlation scores than continuous metrics — but a consistent +0.10 or −0.10 is still meaningful over hundreds of nights.
              </p>
              {journalCorrelations.length > 0 ? (
                <ResponsiveContainer width="100%" height={Math.max(120, journalCorrelations.length * 22)}>
                  <BarChart data={journalCorrelations} layout="vertical"
                            margin={{ left: 160, right: 20, top: 2, bottom: 2 }}>
                    <CartesianGrid {...gridStyle} horizontal={false} />
                    <XAxis type="number" tick={axisTick} domain={[-1, 1]} tickFormatter={v => v.toFixed(1)} />
                    <YAxis type="category" dataKey="label" tick={{ ...axisTick, fontSize: 10 }} width={160}
                           tickFormatter={(v: string) => v.replace(/^journal_/, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())} />
                    <Tooltip {...chartTooltip}
                             formatter={(v: any) => [Number(v).toFixed(3), "Correlation"]} />
                    <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
                    <Bar dataKey="spearman_r" radius={[0, 3, 3, 0]}>
                      {journalCorrelations.map((d, i) => (
                        <Cell key={i} fill={d.spearman_r > 0 ? "#8b5cf6" : "#a855f7"} fillOpacity={0.75} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-[11px] text-text-tertiary italic">
                  Journal behavior correlations not yet computed — re-run hrv_analysis.py to generate.
                </p>
              )}
            </div>
          </ChartCard>
        </div>
      </div>

      {/* ── Row 3: 30-Day Forecast + Journal Impact ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 30-Day Prophet Forecast */}
        <ChartCard title="30-Day HRV Forecast" source="PROPHET + SARIMAX"
          info="Prophet projects the next 30 days using your weekly patterns and long-term trend (orange dashed line + shaded uncertainty band — your HRV should land inside it about 4 out of 5 nights). The purple dotted line overlays SARIMAX's independent 7-day short-term forecast as a cross-check: when both models agree on the near-term, confidence is higher; when they diverge, recent dynamics look unusual.">
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
              <YAxis tick={axisTick} width={55} domain={["auto", "auto"]} label={axisLabel("HRV (ms)", "y")} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Area type="monotone" dataKey="upper" name="Upper CI" stroke="none"
                    fill="url(#prophetGrad)" stackId="ci" />
              <Area type="monotone" dataKey="lower" name="Lower CI" stroke="none"
                    fill="#0a0a0b" stackId="ci" />
              <Line type="monotone" dataKey="actual" stroke="#22c55e" strokeWidth={2}
                    dot={false} name="Actual HRV" connectNulls />
              <Line type="monotone" dataKey="forecast" stroke="#f59e0b" strokeWidth={2}
                    strokeDasharray="5 3" dot={false} name="Prophet" connectNulls />
              <Line type="monotone" dataKey="sarimax" stroke="#8b5cf6" strokeWidth={2}
                    strokeDasharray="2 3" dot={false} name="SARIMAX (7d)" connectNulls />
            </AreaChart>
          </ResponsiveContainer>
          {prophetForecast.length === 0 && (
            <p className="text-[11px] text-text-tertiary text-center mt-2">
              No forecast data — run hrv_analysis.py to generate
            </p>
          )}
        </ChartCard>

        {/* Journal Impact */}
        <ChartCard title="Journal Behavior Impact" subtitle="Mean HRV difference: Yes vs No"
          source="WELCH'S T-TEST"
          info="How each logged behavior affects your HRV the following night. A +15ms bar means your HRV was 15ms higher, on average, on nights after you did that thing. Green = helps recovery; red = hurts it. Method: Welch's two-sample t-test (unequal variance) on HRV distributions for Yes vs No nights, with Cohen's d and 95% CI computed per behavior.">
          {journalImpact.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={journalImpact.slice(0, 12)} layout="vertical"
                        margin={{ left: 120, right: 20, top: 4, bottom: 20 }}>
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={axisTick}
                       tickFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(0)}`}
                       label={axisLabel("HRV Δ (ms)", "x")} />
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
                   subtitle="⚠ DATA INACCURATE — NEEDS FIX"
                   info="What the model predicted each night (dashed) vs what your HRV actually was. Chart is styled red as a reminder that the underlying data is inaccurate and needs to be fixed.">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={predActualData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={55} domain={["auto", "auto"]} label={axisLabel("HRV (ms)", "y")} />
              <Tooltip {...chartTooltip} />
              <Legend wrapperStyle={legendStyle} />
              <Line type="monotone" dataKey="actual" stroke="#ef4444" strokeWidth={2}
                    dot={false} name="Actual HRV" />
              <Line type="monotone" dataKey="predicted" stroke="#b91c1c" strokeWidth={2}
                    dot={<HrvDot />} name="XGBoost Pred" strokeDasharray="4 2" />
            </LineChart>
          </ResponsiveContainer>
          {predActualData.length === 0 && (
            <p className="text-[11px] text-text-tertiary text-center mt-2">No backtest data yet</p>
          )}
        </ChartCard>

        {/* Accuracy by Horizon */}
        <ChartCard title="Accuracy by Forecast Horizon"
                   subtitle="MAE (ms) — lower is better"
                   info="Accuracy drops the further ahead you predict — this shows how much. Each bar is the average miss in ms for that day. 'Naive' just repeats yesterday's HRV as the guess. If the model can't beat that, it's not actually learning anything.">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={horizonData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="horizon" tick={axisTick} label={axisLabel("forecast horizon (days)", "x")} height={50} />
              <YAxis tick={axisTick} width={55} label={axisLabel("MAE (ms)", "y")} />
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

      {/* ── Row 5: HRV Trend ── */}
      <ChartCard title="HRV Trend (180 days)"
                 subtitle="WHOOP HRV + 7-day rolling average"
                 info="Your daily WHOOP HRV (faint line) swings a lot day-to-day — that's normal. The brighter line averages the last 7 days to show your real trend.">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={trendData}>
            <CartesianGrid {...gridStyle} />
            <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
            <YAxis tick={axisTick} width={55} domain={["auto", "auto"]} label={axisLabel("HRV (ms)", "y")} />
            <Tooltip {...chartTooltip} />
            <Legend wrapperStyle={legendStyle} />
            <Line type="monotone" dataKey="hrv" stroke="#22c55e" strokeWidth={1.5}
                  dot={false} name="WHOOP HRV" strokeOpacity={0.5} />
            <Line type="monotone" dataKey="rolling7" stroke="#22c55e" strokeWidth={2.5}
                  dot={false} name="7-Day Avg" />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* ── Row 5b: Workout-to-sleep gap vs HRV ── */}
      <ChartCard
        title="Workout-to-Bed Gap vs Next-Morning HRV"
        subtitle="Last 90 days · each dot = one night"
        info="Hours between your last logged workout and the moment you fell asleep, plotted against the HRV measured from that night's sleep. Late-evening workouts (gap < 2h) are known to depress HRV; this chart lets you see whether that pattern shows up in your data. Dot color encodes WHOOP strain when available."
      >
        {(() => {
          const points = workoutGap
            .filter((g) => g.gap_minutes != null && g.next_morning_hrv != null)
            .map((g) => ({
              gap_hours: (g.gap_minutes as number) / 60,
              hrv: g.next_morning_hrv as number,
              strain: g.whoop_strain,
              date: g.pred_date,
            }));
          if (points.length < 5) {
            return (
              <div className="h-[280px] flex items-center justify-center text-[12px] text-text-tertiary">
                Not enough workout-to-sleep data points yet (need ≥5).
              </div>
            );
          }
          // Bin into hour buckets for a faint trend overlay
          const bins: Record<number, number[]> = {};
          for (const p of points) {
            const k = Math.min(12, Math.floor(p.gap_hours));
            (bins[k] ||= []).push(p.hrv);
          }
          const binned = Object.entries(bins)
            .map(([k, vs]) => ({
              gap_hours: Number(k) + 0.5,
              hrv_mean: vs.reduce((a, b) => a + b, 0) / vs.length,
              n: vs.length,
            }))
            .sort((a, b) => a.gap_hours - b.gap_hours);
          return (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={binned}>
                <CartesianGrid {...gridStyle} />
                <XAxis
                  dataKey="gap_hours"
                  type="number"
                  domain={[0, 13]}
                  tickFormatter={(v) => `${v}h`}
                  tick={axisTick}
                  height={50}
                  label={axisLabel("hours from workout end → bed", "x")}
                />
                <YAxis tick={axisTick} width={55} domain={["auto", "auto"]}
                       label={axisLabel("HRV (ms)", "y")} />
                <Tooltip {...chartTooltip}
                         formatter={(value: any, name: any) =>
                           name === "hrv_mean"
                             ? [`${(value as number).toFixed(1)} ms`, "Mean HRV"]
                             : [value, String(name)]
                         } />
                <Line type="monotone" dataKey="hrv_mean" stroke="#22c55e" strokeWidth={2.5}
                      dot={{ r: 5, fill: "#22c55e" }} name="Mean HRV per gap-hour bin" />
              </LineChart>
            </ResponsiveContainer>
          );
        })()}
        <div className="mt-3 px-1 grid grid-cols-3 gap-2 text-[10px] text-text-tertiary">
          <div>n nights with both workout + HRV: <span className="text-text-secondary tabular-nums">{workoutGap.filter(g => g.gap_minutes != null && g.next_morning_hrv != null).length}</span></div>
          <div>median gap: <span className="text-text-secondary tabular-nums">{(() => {
            const arr = workoutGap.map(g => g.gap_minutes).filter((v): v is number => v != null).sort((a, b) => a - b);
            return arr.length ? `${(arr[Math.floor(arr.length / 2)] / 60).toFixed(1)}h` : "—";
          })()}</span></div>
          <div>evening workouts (after 6pm ET): <span className="text-text-secondary tabular-nums">{(() => {
            return workoutGap.filter(g => g.last_workout_end_utc &&
              new Date(g.last_workout_end_utc).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false }).includes(":") &&
              Number(new Date(g.last_workout_end_utc).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit" })) >= 18
            ).length;
          })()}</span></div>
        </div>
      </ChartCard>

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
                <h4 className="text-[12px] font-medium text-text-secondary mb-1">Residual Distribution (XGBoost)</h4>
                <p className="text-[11px] text-text-tertiary leading-relaxed mb-3">
                  Each bar counts how many nights the model missed by that amount (in ms). The tall bars should pile up near 0 (the red line) — random small misses. Bars skewed to one side mean the model is consistently predicting too high or too low.
                </p>
                {residualData.length > 0 && residualData.some(d => d.count > 0) ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={residualData} margin={{ top: 4, right: 8, left: 0, bottom: 20 }}>
                      <CartesianGrid {...gridStyle} />
                      <XAxis dataKey="bin" tick={{ ...axisTick, fontSize: 9 }} interval={3}
                             height={45} label={axisLabel("residual (ms)", "x")} />
                      <YAxis tick={axisTick} width={45} label={axisLabel("nights", "y")} />
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
                <h4 className="text-[12px] font-medium text-text-secondary mb-1">CI Calibration</h4>
                <p className="text-[11px] text-text-tertiary leading-relaxed">
                  When the model gives a range, it should be right about 90% of the time. This number shows how often it actually was. Close to 90% = well-sized ranges. Much lower = the ranges are too tight. Much higher = the ranges are too wide.
                </p>
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
              <h4 className="text-[12px] font-medium text-text-secondary mb-1">Model Comparison</h4>
              <p className="text-[11px] text-text-tertiary leading-relaxed mb-3">
                <strong className="text-text-secondary">MAE</strong> — average miss in ms, lower is better.{" "}
                <strong className="text-text-secondary">RMSE</strong> — same idea but big misses count extra.{" "}
                <strong className="text-text-secondary">R²</strong> — how well the model tracks your personal HRV patterns (1.0 = perfect, 0 = no better than a flat guess).{" "}
                <strong className="text-text-secondary">Dir %</strong> — how often it correctly called up vs down.{" "}
                <strong className="text-text-secondary">CI Cov</strong> — how often your actual HRV fell inside the predicted range.{" "}
                Naive and 7d Avg are simple guesses — beating them means the model is learning real patterns, not just copying recent numbers.
              </p>
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
