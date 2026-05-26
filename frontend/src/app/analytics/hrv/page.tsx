"use client";

import { useEffect, useState } from "react";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  CartesianGrid, ReferenceLine, Cell, ErrorBar,
} from "recharts";
import ChartCard from "@/components/ChartCard";
import RangeFilter from "@/components/RangeFilter";
import { chartTooltip, axisTick, gridStyle, axisLabel } from "@/lib/chart-theme";
import { supabase } from "@/lib/supabase";
import { getWorkoutSleepGap, rangeDays, rangeLabel, type Range, type WorkoutSleepGap } from "@/lib/queries";

/* eslint-disable @typescript-eslint/no-explicit-any */

const legendStyle = { fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" };

// YAxis width on horizontal bar charts is a hardcoded Recharts prop, so mobile
// scaling needs JS state — without it, the 200-220px label column crushes the
// bar area into the right ~80px of a 320px mobile card.
function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [breakpoint]);
  return isMobile;
}

/**
 * Normalize a feature label for display. Some rows arrive pretty-printed from
 * the Python pipeline ("Bed Temperature"); others are still raw column names
 * ("whoop_cycle_avg_hr", "journal_slept_in_the_same_bed_as_usual"). One pass
 * idempotently produces the displayable form: strip `journal_` prefix, swap
 * underscores for spaces, title-case.
 */
function prettifyLabel(raw: string): string {
  if (!raw) return "";
  let s = raw.replace(/^journal_/, "");
  if (s.includes("_")) {
    s = s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return s;
}

/**
 * Wrapped YAxis tick — labels in the correlation / journal-impact charts can
 * run 30-40 chars long (e.g. "Learned Something Interesting Or Important").
 * Default Recharts behavior truncates with no overflow indicator; we instead
 * pack words greedily onto up to 2 lines and add a <title> hover so the full
 * label is always recoverable.
 *
 * `maxCharsPerLine` is the soft target — a word will spill over by a few
 * characters rather than break mid-word.
 */
function WrappedYAxisTick(
  { x, y, payload, maxCharsPerLine = 24, fontSize = 10 }: {
    x?: number; y?: number; payload?: { value?: string };
    maxCharsPerLine?: number; fontSize?: number;
  }
) {
  const raw = String(payload?.value ?? "");
  const display = prettifyLabel(raw);
  const words = display.split(/\s+/);
  const lines: string[] = ["", ""];
  let cursor = 0;
  for (const w of words) {
    const candidate = lines[cursor] ? `${lines[cursor]} ${w}` : w;
    if (candidate.length <= maxCharsPerLine || cursor === 1) {
      lines[cursor] = candidate;
    } else {
      cursor = 1;
      lines[cursor] = w;
    }
  }
  // If line 2 overflows the budget, truncate with ellipsis so it doesn't
  // bleed into the bars. Hover (<title>) still shows the full label.
  const hardCap = maxCharsPerLine + 6;
  if (lines[1].length > hardCap) lines[1] = lines[1].slice(0, hardCap - 1) + "…";

  const isWrapped = lines[1].length > 0;
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={-4}
        y={0}
        textAnchor="end"
        fill="#71717A"
        fontSize={fontSize}
        fontFamily="var(--font-geist-mono), monospace"
      >
        <title>{display}</title>
        {isWrapped ? (
          <>
            <tspan x={-4} dy={-fontSize * 0.45}>{lines[0]}</tspan>
            <tspan x={-4} dy={fontSize * 1.1}>{lines[1]}</tspan>
          </>
        ) : (
          <tspan x={-4} dy={fontSize * 0.35}>{lines[0]}</tspan>
        )}
      </text>
    </g>
  );
}

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

async function getHrvPredictionAccuracy(days: number = 60) {
  const since = new Date();
  since.setDate(since.getDate() - days);
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
  // Latest eval_date now writes ~36 rows (xgboost + 3 baselines + sarimax all at
  // h=1..7 = 35, plus prophet h=1 = 36). Limit must cover the full latest sweep
  // so the Accuracy-by-Forecast-Horizon chart sees every (model × horizon) cell.
  const { data } = await supabase
    .from("hrv_model_metrics")
    .select("*")
    .order("eval_date", { ascending: false })
    .limit(100);
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
    .from("daily_health_matrix_behavioral")
    .select("calendar_date,whoop_hrv_rmssd")
    .gte("calendar_date", since.toISOString().split("T")[0])
    .not("whoop_hrv_rmssd", "is", null)
    .order("calendar_date", { ascending: true });
  return data ?? [];
}

// All-time pull (no date filter) of nights that have a temperature reading
// AND any of the next-night outcomes. Powers the Environment Sweet Spot
// dose-response chart, which buckets nights by selected temperature and
// shows mean of the selected outcome per bucket. Filters at "any temp + HRV"
// so we don't drop nights where bed_temp is present but room_temp isn't.
// Per-row null-check happens client-side per selected axis pair.
async function getEnvDoseResponseData() {
  const { data } = await supabase
    .from("daily_health_matrix_behavioral")
    .select(
      "calendar_date,eight_sleep_room_temp,eight_sleep_bed_temp,whoop_hrv_rmssd," +
      "whoop_recovery_score,whoop_sleep_efficiency,whoop_deep_sleep_milli"
    )
    .or("eight_sleep_room_temp.not.is.null,eight_sleep_bed_temp.not.is.null")
    .not("whoop_hrv_rmssd", "is", null)
    .order("calendar_date", { ascending: true });
  return data ?? [];
}

async function getHrvResiduals() {
  // Use the *_eval view (sibling of hrv_predictions_latest) so backtest
  // model_versions are included. The latest view excludes them, which
  // would render this chart nearly empty since most XGBoost evaluation
  // history is stored as backtest_initial rows.
  const { data } = await supabase
    .from("hrv_predictions_eval")
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
  const [habitImpact, setHabitImpact] = useState<any[]>([]);
  const [habitCorrelations, setHabitCorrelations] = useState<any[]>([]);
  const [habitShap, setHabitShap] = useState<any[]>([]);
  const [supplementImpact, setSupplementImpact] = useState<any[]>([]);
  const [supplementDoseResponse, setSupplementDoseResponse] = useState<any[]>([]);
  const [nutritionImpact, setNutritionImpact] = useState<any[]>([]);
  const [workoutGap, setWorkoutGap] = useState<WorkoutSleepGap[]>([]);
  const [causalBinary, setCausalBinary] = useState<any[]>([]);
  const [causalContinuous, setCausalContinuous] = useState<any[]>([]);
  const [causalDag, setCausalDag] = useState<any | null>(null);
  const [causalMeta, setCausalMeta] = useState<any | null>(null);
  const [causalDropped, setCausalDropped] = useState<any[]>([]);
  const [envMatrix, setEnvMatrix] = useState<any[]>([]);
  // Environment Sweet Spot dual-axis selectors. X axis is which temp sensor
  // to bucket by (Pod room vs bed surface); Y axis is which next-night
  // outcome to plot. Defaults preserve the original chart (room × HRV).
  const [envXAxis, setEnvXAxis] = useState<"room" | "bed">("room");
  const [envOutcome, setEnvOutcome] = useState<"hrv" | "recovery" | "efficiency" | "deep">("hrv");
  const [expandedEval, setExpandedEval] = useState(false);
  const [expandedModels, setExpandedModels] = useState(false);
  const [range, setRange] = useState<Range>("30d");
  const isMobile = useIsMobile();

  // Mobile-aware sizing for horizontal bar charts. On a ~320px wide mobile
  // card, the desktop YAxis widths (180-220px) leave the bars squeezed into
  // 80-120px on the right. These shrink the label column and font so the bars
  // get most of the horizontal space. The <title> hover on WrappedYAxisTick
  // still surfaces the full label when truncated.
  const axisW = {
    short: isMobile ? 90 : 140,   // Prediction Drivers (already-clean labels)
    med:   isMobile ? 95 : 160,   // Journal/Habit SHAP sub-charts
    long:  isMobile ? 110 : 200,  // Correlates, Journal/Habit Impact, Supplement Impact
    xlong: isMobile ? 110 : 220,  // Dose-Response, Causal Binary
    nutri: isMobile ? 100 : 140,  // Nutrition correlations
  };
  const chars = {
    long:  isMobile ? 16 : 28,
    xlong: isMobile ? 16 : 30,
    corr:  isMobile ? 16 : 26,
    nutri: isMobile ? 14 : 20,
  };
  const sideMarginShort = isMobile ? 4 : 140;  // matches axisW.short when desktop
  const sideMarginMed   = isMobile ? 4 : 160;  // matches axisW.med when desktop

  useEffect(() => {
    setLoading(true);
    const days = rangeDays(range);
    Promise.all([
      getTomorrowPrediction(),
      getHrvPredictionAccuracy(days),
      getHrvModelMetrics(),
      getHistoricalHrv(days),
      getHrvAnalysisResults("correlation", "spearman_top50"),
      getHrvAnalysisResults("journal_impact"),
      getHrvAnalysisResults("feature_importance", "shap_mean_abs"),
      getHrvResiduals(),
      getProphetForecast(),
      getHrvAnalysisResults("correlation", "spearman_journal"),
      getHrvAnalysisResults("feature_importance", "shap_journal"),
      getSarimaxForecast(),
      getWorkoutSleepGap(days),
      getHrvAnalysisResults("supplement_impact", "yes_no"),
      getHrvAnalysisResults("supplement_impact", "dose_response"),
      getHrvAnalysisResults("nutrition_impact", "spearman"),
      getHrvAnalysisResults("habit_impact"),
      getHrvAnalysisResults("correlation", "spearman_habit"),
      getHrvAnalysisResults("feature_importance", "shap_habit"),
      getHrvAnalysisResults("causal", "binary_treatments"),
      getHrvAnalysisResults("causal", "continuous_treatments"),
      getHrvAnalysisResults("causal", "dag"),
      getHrvAnalysisResults("causal", "meta"),
      getHrvAnalysisResults("causal", "dropped_low_n"),
      getEnvDoseResponseData(),
    ]).then(([tomorrow, acc, m, hist, corr, ji, fi, res, prophet, jCorr, jShap, sarimax, wkGap, suppImp, suppDose, nutImp, hi, hCorr, hShap, cBin, cCont, cDag, cMeta, cDrop, envM]) => {
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
      if (suppImp?.result_json) {
        try { setSupplementImpact(JSON.parse(suppImp.result_json)); } catch {}
      }
      if (suppDose?.result_json) {
        try { setSupplementDoseResponse(JSON.parse(suppDose.result_json)); } catch {}
      }
      if (nutImp?.result_json) {
        try { setNutritionImpact(JSON.parse(nutImp.result_json)); } catch {}
      }
      if (hi?.result_json) {
        try { setHabitImpact(JSON.parse(hi.result_json)); } catch {}
      }
      if (hCorr?.result_json) {
        try { setHabitCorrelations(JSON.parse(hCorr.result_json)); } catch {}
      }
      if (hShap?.result_json) {
        try { setHabitShap(JSON.parse(hShap.result_json)); } catch {}
      }
      if (cBin?.result_json) {
        try { setCausalBinary(JSON.parse(cBin.result_json)); } catch {}
      }
      if (cCont?.result_json) {
        try { setCausalContinuous(JSON.parse(cCont.result_json)); } catch {}
      }
      if (cDag?.result_json) {
        try { setCausalDag(JSON.parse(cDag.result_json)); } catch {}
      }
      if (cMeta?.result_json) {
        try { setCausalMeta(JSON.parse(cMeta.result_json)); } catch {}
      }
      if (cDrop?.result_json) {
        try { setCausalDropped(JSON.parse(cDrop.result_json)); } catch {}
      }
      setEnvMatrix(envM);
    }).catch(console.error).finally(() => setLoading(false));
  }, [range]);

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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">HRV Deep Analysis</h2>
          <p className="text-sm text-text-tertiary mt-0.5">
            Predictive modeling · Statistical drivers · {rangeLabel(range)} · {historicalHrv.length} days of data
          </p>
        </div>
        <div className="flex items-center gap-3">
          <RangeFilter value={range} onChange={setRange} />
          {!hasData && (
            <div className="text-sm text-text-tertiary bg-amber-500/10 border border-amber-500/20 rounded px-3 py-1.5">
              Run <code className="font-mono text-amber-400">python hrv_analysis.py</code> to generate predictions
            </div>
          )}
        </div>
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

      {/* ── Forward-looking: what's predicted and why (today) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 30-Day Prophet Forecast */}
        <ChartCard collapsible title="30-Day HRV Forecast" source="PROPHET + SARIMAX"
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

        <ChartCard collapsible title="Prediction Drivers (Today)" subtitle="What's driving tomorrow's forecast right now"
          source="XGBOOST · SHAP"
          info="Shows what's pushing tomorrow's prediction up or down. Green bars are factors that raised the forecast; red bars lowered it. The longer the bar, the bigger the impact. This updates every day as your data changes. Journal behaviors appear in a separate section below because they're Yes/No entries — they have smaller numerical impact than continuous metrics like heart rate, but they're still part of the model.">
          {topDrivers.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={topDrivers.slice(0, 10)} layout="vertical"
                        margin={{ left: sideMarginShort, right: 20, top: 4, bottom: 20 }}>
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={axisTick} tickFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(1)}`}
                       label={axisLabel("HRV impact (ms)", "x")} />
                <YAxis type="category" dataKey="label" tick={{ ...axisTick, fontSize: isMobile ? 9 : 11 }} width={axisW.short} />
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
                          margin={{ left: sideMarginMed, right: 20, top: 2, bottom: 20 }}>
                  <CartesianGrid {...gridStyle} horizontal={false} />
                  <XAxis type="number" tick={axisTick} tickFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(2)}`}
                         label={axisLabel("HRV impact (ms)", "x")} />
                  <YAxis type="category" dataKey="label" tick={{ ...axisTick, fontSize: isMobile ? 9 : 10 }} width={axisW.med}
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
                            margin={{ left: sideMarginMed, right: 20, top: 2, bottom: 2 }}>
                    <CartesianGrid {...gridStyle} horizontal={false} />
                    <XAxis type="number" tick={axisTick} tickFormatter={v => v.toFixed(2)} />
                    <YAxis type="category" dataKey="label" tick={{ ...axisTick, fontSize: isMobile ? 9 : 10 }} width={axisW.med}
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

          {/* Habit SHAP sub-section */}
          <div className="mt-4 pt-4 border-t border-border-subtle">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-mono font-medium tracking-wider text-text-tertiary uppercase">Habits</span>
              <span className="text-[9px] text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px] font-mono">XGBOOST · SHAP</span>
            </div>
            <p className="text-[10px] text-text-tertiary leading-relaxed mb-3">
              Notion-managed habits (from <a href="/habits" className="text-accent hover:underline">/habits</a>) are part of the model. Like journal behaviors, they&apos;re Yes/No features with smaller ms-impact than continuous metrics, but they shift the forecast in the direction shown.
            </p>
            {habitShap.length > 0 ? (
              <ResponsiveContainer width="100%" height={Math.max(120, habitShap.length * 28)}>
                <BarChart data={habitShap} layout="vertical"
                          margin={{ left: sideMarginMed, right: 20, top: 2, bottom: 2 }}>
                  <CartesianGrid {...gridStyle} horizontal={false} />
                  <XAxis type="number" tick={axisTick} tickFormatter={v => v.toFixed(2)} />
                  <YAxis type="category" dataKey="label" tick={{ ...axisTick, fontSize: isMobile ? 9 : 10 }} width={axisW.med} />
                  <Tooltip {...chartTooltip}
                           formatter={(v: any) => [`${Number(v).toFixed(3)} ms`, "Avg |Impact|"]} />
                  <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
                  <Bar dataKey="importance" radius={[0, 3, 3, 0]}>
                    {habitShap.map((d, i) => (
                      <Cell key={i} fill="#06b6d4" fillOpacity={0.75} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-[11px] text-text-tertiary italic">
                Habit impacts not yet computed — need more completions logged at <a href="/habits" className="text-accent hover:underline">/habits</a>, then re-run hrv_analysis.py.
              </p>
            )}
          </div>
        </ChartCard>
      </div>

      {/* ── How well does the model actually predict? ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Prediction vs Actual */}
        <ChartCard collapsible storageKey="prediction-vs-actual" title={`Prediction vs Actual (${rangeLabel(range)})`}
                   subtitle="Red dots = miss > 15ms"
                   info="What the model predicted each night (blue dashed) vs what your HRV actually was (green). Red dots are nights where it missed by more than 15ms. Fewer red dots = more accurate model.">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={predActualData}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
              <YAxis tick={axisTick} width={55} domain={["auto", "auto"]} label={axisLabel("HRV (ms)", "y")} />
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
        <ChartCard collapsible title="Accuracy by Forecast Horizon"
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

      {/* ── Where is HRV trending overall? ── */}
      <ChartCard collapsible storageKey="hrv-trend" title={`HRV Trend (${rangeLabel(range)})`}
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

      {/* ── What's associated with your HRV ── */}
      <div className="space-y-4">
        <div className="bg-surface-card border border-border-subtle rounded-[6px] p-4 shadow-card">
          <h3 className="text-[13px] font-medium text-text-secondary mb-2">What&apos;s associated with your HRV</h3>
          <p className="text-[11px] text-text-tertiary leading-relaxed">
            The charts below are <em>associational</em> — they show which factors have historically moved with your HRV across your entire tracking history. No model is involved; these are direct statistical patterns. Start with the broad continuous-metric view, then read on through the behavior-impact, supplement, and lifestyle pairings. Adjusted causal estimates (with confounders held fixed) come further down in the Causal Inference section.
          </p>
        </div>

        <ChartCard collapsible title="HRV Correlates (Historical)" subtitle="What has historically moved with your HRV"
          source="SPEARMAN ρ"
          info="What it shows: how strongly each factor is linked to your HRV across your entire history. A bar near +1.0 means that factor almost always rises when your HRV rises; near −1.0 means the opposite. Long-term pattern, doesn't change day to day. Method: Spearman ρ — a rank-based correlation that's robust to outliers and skewed distributions; scores range −1.0 to +1.0. Journal behaviors and habits appear in separate sub-sections below because Yes/No features have a narrower correlation range than continuous metrics.">
          {correlations.length > 0 ? (
            <ResponsiveContainer width="100%" height={Math.max(360, correlations.length * 26)}>
              <BarChart data={correlations} layout="vertical"
                        margin={{ left: 8, right: 20, top: 4, bottom: 4 }}>
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={axisTick} domain={[-1, 1]} tickFormatter={v => v.toFixed(1)} />
                <YAxis type="category" dataKey="label" width={isMobile ? 110 : 180}
                       tick={<WrappedYAxisTick maxCharsPerLine={chars.corr} fontSize={10} />} />
                <Tooltip {...chartTooltip}
                         formatter={(v: any) => [Number(v).toFixed(3), "Spearman ρ"]} />
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
            <p className="text-[10px] text-text-tertiary leading-relaxed">
              <strong className="text-text-secondary">What it is:</strong> A statistical measure of how consistently two things move together. For each behavior, every night gets two ranks — one by HRV, one by whether the behavior was logged that day — and the score reflects how well those rankings agree.
            </p>
            <p className="text-[10px] text-text-tertiary leading-relaxed mt-1.5 mb-3">
              <strong className="text-text-secondary">Why it&apos;s used:</strong> Rank-based, so it shrugs off outlier nights and skewed distributions that would distort a standard correlation. Scores range from −1.0 to +1.0; because behaviors are Yes/No, expect smaller magnitudes than continuous metrics — a steady ±0.10 across hundreds of nights is still real signal.
            </p>
            {journalCorrelations.length > 0 ? (
              <ResponsiveContainer width="100%" height={Math.max(160, journalCorrelations.length * 28)}>
                <BarChart data={journalCorrelations} layout="vertical"
                          margin={{ left: 8, right: 20, top: 2, bottom: 2 }}>
                  <CartesianGrid {...gridStyle} horizontal={false} />
                  <XAxis type="number" tick={axisTick} domain={[-1, 1]} tickFormatter={v => v.toFixed(1)} />
                  <YAxis type="category" dataKey="label" width={axisW.long}
                         tick={<WrappedYAxisTick maxCharsPerLine={chars.long} fontSize={10} />} />
                  <Tooltip {...chartTooltip}
                           formatter={(v: any) => [Number(v).toFixed(3), "Spearman ρ"]} />
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

          {/* Habit correlation sub-section */}
          <div className="mt-4 pt-4 border-t border-border-subtle">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-mono font-medium tracking-wider text-text-tertiary uppercase">Habits</span>
              <span className="text-[9px] text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px] font-mono">SPEARMAN ρ</span>
            </div>
            <p className="text-[10px] text-text-tertiary leading-relaxed">
              <strong className="text-text-secondary">What it is:</strong> A statistical measure of how consistently two things move together. For each habit, every night gets two ranks — one by HRV, one by whether you completed the habit that day — and the score reflects how well those rankings agree.
            </p>
            <p className="text-[10px] text-text-tertiary leading-relaxed mt-1.5 mb-3">
              <strong className="text-text-secondary">Why it&apos;s used:</strong> Rank-based, so it shrugs off outlier nights and skewed distributions that would distort a standard correlation. Scores range from −1.0 to +1.0; because habits are Yes/No, expect smaller magnitudes than continuous metrics — a steady ±0.10 across hundreds of nights is still real signal.
            </p>
            {habitCorrelations.length > 0 ? (
              <ResponsiveContainer width="100%" height={Math.max(160, habitCorrelations.length * 32)}>
                <BarChart data={habitCorrelations} layout="vertical"
                          margin={{ left: 8, right: 20, top: 2, bottom: 2 }}>
                  <CartesianGrid {...gridStyle} horizontal={false} />
                  <XAxis type="number" tick={axisTick} domain={[-1, 1]} tickFormatter={v => v.toFixed(1)} />
                  <YAxis type="category" dataKey="label" width={axisW.long}
                         tick={<WrappedYAxisTick maxCharsPerLine={chars.long} fontSize={10} />} />
                  <Tooltip {...chartTooltip}
                           formatter={(v: any) => [Number(v).toFixed(3), "Spearman ρ"]} />
                  <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
                  <Bar dataKey="spearman_r" radius={[0, 3, 3, 0]}>
                    {habitCorrelations.map((d, i) => (
                      <Cell key={i} fill={d.spearman_r > 0 ? "#06b6d4" : "#0ea5e9"} fillOpacity={0.75} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-[11px] text-text-tertiary italic">
                Habit correlations not yet computed — need ≥20 days with the habit logged before correlations are reliable. Keep tracking at <a href="/habits" className="text-accent hover:underline">/habits</a>.
              </p>
            )}
          </div>
        </ChartCard>
      </div>

      {/* ── Behavior t-tests: Journal + Habit Impact ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Journal Impact */}
        <ChartCard collapsible title="Journal Behavior Impact" subtitle="Mean HRV difference: Yes vs No"
          source="WELCH'S T-TEST"
          info="How each logged behavior affects your HRV the following night. A +15ms bar means your HRV was 15ms higher, on average, on nights after you did that thing. Green = helps recovery; red = hurts it. Method: Welch's two-sample t-test (unequal variance) on HRV distributions for Yes vs No nights. Whiskers on each bar are the 95% confidence interval — the range the true HRV difference is likely to land in; if the whiskers cross 0, the apparent effect could be noise. Tooltip shorthand: 'd' is Cohen's d (standardized effect size — the HRV gap divided by typical night-to-night HRV variability; |d|<0.2 trivial, 0.2-0.5 small, 0.5-0.8 medium, >0.8 large), 'n=Y/N' is the sample sizes (Yes-nights / No-nights) that fed the comparison.">
          {journalImpact.length > 0 ? (() => {
            const ji = journalImpact.slice(0, 12).map((d: any) => ({
              ...d,
              errorRange: [
                Math.max(0, (d.diff_ms ?? 0) - (d.ci_low ?? 0)),
                Math.max(0, (d.ci_high ?? 0) - (d.diff_ms ?? 0)),
              ],
            }));
            return (
            <ResponsiveContainer width="100%" height={Math.max(360, ji.length * 30)}>
              <BarChart data={ji} layout="vertical"
                        margin={{ left: 8, right: 20, top: 4, bottom: 20 }}>
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={axisTick}
                       tickFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(0)}`}
                       label={axisLabel("HRV Δ (ms) · whiskers = 95% CI", "x")} />
                <YAxis type="category" dataKey="label" width={axisW.long}
                       tick={<WrappedYAxisTick maxCharsPerLine={chars.long} fontSize={10} />} />
                <Tooltip {...chartTooltip}
                         formatter={(v: any, _n: any, p: any) => {
                           const d = p?.payload ?? {};
                           const lo = Number(d.ci_low ?? 0).toFixed(1);
                           const hi = Number(d.ci_high ?? 0).toFixed(1);
                           return [
                             `${Number(v).toFixed(1)} ms · 95% CI [${lo}, ${hi}] · d=${(d.cohen_d ?? 0).toFixed(2)} · n=${d.n_yes}/${d.n_no}`,
                             "HRV Δ",
                           ];
                         }} />
                <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
                <Bar dataKey="diff_ms" radius={[0, 3, 3, 0]}>
                  {ji.map((d: any, i: number) => (
                    <Cell key={i} fill={d.diff_ms > 0 ? "#22c55e" : "#ef4444"} fillOpacity={0.8} />
                  ))}
                  <ErrorBar dataKey="errorRange" width={4} strokeWidth={1.5}
                            stroke="#f4f4f5" direction="x" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            );
          })() : (
            <div className="h-[260px] flex items-center justify-center">
              <p className="text-[11px] text-text-tertiary">No journal data — run hrv_analysis.py</p>
            </div>
          )}
        </ChartCard>

        <ChartCard collapsible title="Habit Impact" subtitle="Mean HRV difference: nights you completed the habit vs nights you didn't"
          source="WELCH'S T-TEST"
          info="Same statistical treatment as Journal Behavior Impact, applied to Notion-managed habits (from /habits). A +Xms bar means HRV averaged X ms higher on the night following days you completed that habit. Method: Welch's two-sample t-test on next-night HRV for Yes vs No nights. Whiskers on each bar are the 95% confidence interval — the range the true HRV difference is likely to land in; if the whiskers cross 0, the apparent effect could be noise (and for habits with few completed-nights the whiskers will be wide — that's the chart honestly signaling 'trust this less'). Tooltip shorthand: 'd' is Cohen's d (standardized effect size — the HRV gap divided by typical night-to-night HRV variability; |d|<0.2 trivial, 0.2-0.5 small, 0.5-0.8 medium, >0.8 large), 'n=Y/N' is the sample sizes (Y completed-nights, N skipped-nights). Habits need at least 5 Yes-nights and 5 No-nights before they appear (the t-test isn't meaningful with smaller groups). Add more habits or toggle them more consistently at /habits to populate this view.">
          {habitImpact.length > 0 ? (() => {
            const hi = habitImpact.slice(0, 12).map((d: any) => ({
              ...d,
              errorRange: [
                Math.max(0, (d.diff_ms ?? 0) - (d.ci_low ?? 0)),
                Math.max(0, (d.ci_high ?? 0) - (d.diff_ms ?? 0)),
              ],
            }));
            return (
            <ResponsiveContainer width="100%" height={Math.max(260, hi.length * 36)}>
              <BarChart data={hi} layout="vertical"
                        margin={{ left: 8, right: 20, top: 4, bottom: 20 }}>
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={axisTick}
                       tickFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(0)}`}
                       label={axisLabel("HRV Δ (ms) · whiskers = 95% CI", "x")} />
                <YAxis type="category" dataKey="label" width={axisW.long}
                       tick={<WrappedYAxisTick maxCharsPerLine={chars.long} fontSize={10} />} />
                <Tooltip {...chartTooltip}
                         formatter={(v: any, _n: any, p: any) => {
                           const d = p?.payload ?? {};
                           const lo = Number(d.ci_low ?? 0).toFixed(1);
                           const hi = Number(d.ci_high ?? 0).toFixed(1);
                           return [
                             `${Number(v).toFixed(1)} ms · 95% CI [${lo}, ${hi}] · d=${(d.cohen_d ?? 0).toFixed(2)} · n=${d.n_yes}/${d.n_no}`,
                             "HRV Δ",
                           ];
                         }} />
                <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
                <Bar dataKey="diff_ms" radius={[0, 3, 3, 0]}>
                  {hi.map((d: any, i: number) => (
                    <Cell key={i} fill={d.diff_ms > 0 ? "#22c55e" : "#ef4444"} fillOpacity={0.8} />
                  ))}
                  <ErrorBar dataKey="errorRange" width={4} strokeWidth={1.5}
                            stroke="#f4f4f5" direction="x" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            );
          })() : (
            <div className="h-[260px] flex items-center justify-center px-6">
              <p className="text-[11px] text-text-tertiary text-center leading-relaxed">
                Not enough habit history yet — each habit needs ≥5 Yes-nights and ≥5 No-nights before the t-test is meaningful. Keep tracking at <a href="/habits" className="text-accent hover:underline">/habits</a>; this chart populates on the next pipeline run.
              </p>
            </div>
          )}
        </ChartCard>
      </div>

      {/* ── Supplements: Yes/No impact + Dose-Response ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Supplement Yes/No Impact */}
        <ChartCard collapsible
          title="Supplement Impact (Yes vs No)"
          subtitle="Mean HRV difference: nights compound taken vs not"
          source="WELCH'S T-TEST"
          info="How each supplement compound (rolled up across products via FDA UNII code, e.g. Vitamin C from a multi + standalone tablet sum into one row) affects HRV the following night. Method: Welch's two-sample t-test (unequal variance) on next-night HRV for Yes vs No nights. Whiskers on each bar are the 95% confidence interval — the range the true HRV difference is likely to land in; if the whiskers cross 0, the apparent effect could be noise (compounds with fewer tracked nights will show wide whiskers — that's the chart honestly signaling 'trust this less'). Tooltip shorthand: 'd' is Cohen's d (standardized effect size — the HRV gap divided by typical night-to-night HRV variability; |d|<0.2 trivial, 0.2-0.5 small, 0.5-0.8 medium, >0.8 large), 'n=Y/N' is the sample sizes (Y compound-taken nights, N compound-skipped nights). BH-FDR corrected across compounds. Yes/No framing chosen because most compounds are taken at a near-constant dose, so the actionable question is 'does taking it help?' — a continuous test would collapse on near-zero amount variance. ⚠ marks compounds with fewer than 20 Yes or No nights — estimates are unstable. Associational, not causal."
        >
          {supplementImpact.length > 0 ? (() => {
            const si = supplementImpact.slice(0, 14).map((d: any) => ({
              ...d,
              displayLabel: `${d.low_n ? "⚠ " : ""}${d.compound}`,
              errorRange: [
                Math.max(0, (d.diff_ms ?? 0) - (d.ci_low ?? 0)),
                Math.max(0, (d.ci_high ?? 0) - (d.diff_ms ?? 0)),
              ],
            }));
            return (
            <ResponsiveContainer width="100%" height={Math.max(360, si.length * 30)}>
              <BarChart data={si} layout="vertical"
                        margin={{ left: 8, right: 20, top: 4, bottom: 20 }}>
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={axisTick}
                       tickFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(0)}`}
                       label={axisLabel("HRV Δ (ms) · whiskers = 95% CI", "x")} />
                <YAxis type="category" dataKey="displayLabel" width={axisW.long}
                       tick={<WrappedYAxisTick maxCharsPerLine={chars.long} fontSize={10} />} />
                <Tooltip {...chartTooltip}
                         formatter={(v: any, _n: any, p: any) => {
                           const d = p?.payload ?? {};
                           const lo = Number(d.ci_low ?? 0).toFixed(1);
                           const hi = Number(d.ci_high ?? 0).toFixed(1);
                           return [
                             `${Number(v).toFixed(1)} ms · 95% CI [${lo}, ${hi}] · d=${(d.cohen_d ?? 0).toFixed(2)} · n=${d.n_yes}/${d.n_no}`,
                             "HRV Δ",
                           ];
                         }} />
                <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
                <Bar dataKey="diff_ms" radius={[0, 3, 3, 0]}>
                  {si.map((d: any, i: number) => (
                    <Cell key={i} fill={d.diff_ms > 0 ? "#22c55e" : "#ef4444"}
                          fillOpacity={d.low_n ? 0.35 : 0.8} />
                  ))}
                  <ErrorBar dataKey="errorRange" width={4} strokeWidth={1.5}
                            stroke="#f4f4f5" direction="x" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            );
          })() : (
            <div className="h-[260px] flex items-center justify-center px-6">
              <p className="text-[11px] text-text-tertiary text-center leading-relaxed">
                Not enough supplement history yet — the Yes/No t-test needs at least 3 nights of Yes and 3 of No per compound.
                Keep logging at <a href="/supplements" className="text-accent hover:underline">/supplements</a>; the chart populates on the next pipeline run.
              </p>
            </div>
          )}
        </ChartCard>

        {/* Supplement Dose-Response — conditional render */}
        {supplementDoseResponse.length > 0 && (
          <ChartCard collapsible
            title="Supplement Dose-Response"
            subtitle="Spearman ρ between daily amount and next-night HRV (compounds with ≥3 distinct doses)"
            source="SPEARMAN ρ"
            info="What it shows: for compounds where the dose actually varies, whether 'more = better/worse?' Only includes compounds with ≥3 distinct non-zero doses (constant-dose compounds appear in the Yes/No chart above instead). Method: Spearman ρ — a rank-based correlation between daily total amount and next-night HRV; robust to outliers and skewed distributions; handles non-linear monotonic dose-response curves; scores range −1.0 to +1.0. Tooltip: ρ is the correlation; p is the p-value (chance the link is random noise — <0.05 is the conventional significance threshold); n is the number of nights; doses is the count of distinct non-zero dose levels seen. BH-FDR corrected across compounds. ⚠ marks rows with n<20 — estimates are unstable. Associational, not causal."
          >
            <ResponsiveContainer width="100%" height={Math.max(240, supplementDoseResponse.slice(0, 12).length * 30)}>
              <BarChart data={supplementDoseResponse.slice(0, 12).map(d => ({
                            ...d,
                            displayLabel: `${d.low_n ? "⚠ " : ""}${d.compound}${d.unit ? ` (${d.unit})` : ""}`,
                         }))}
                        layout="vertical"
                        margin={{ left: 8, right: 20, top: 4, bottom: 20 }}>
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={axisTick} domain={[-1, 1]}
                       tickFormatter={v => v.toFixed(2)}
                       label={axisLabel("Spearman ρ (dose vs HRV)", "x")} />
                <YAxis type="category" dataKey="displayLabel" width={axisW.xlong}
                       tick={<WrappedYAxisTick maxCharsPerLine={chars.xlong} fontSize={10} />} />
                <Tooltip {...chartTooltip}
                         formatter={(v: any, _n: any, p: any) => {
                           const d = p?.payload ?? {};
                           return [
                             `${Number(v).toFixed(3)} (p=${(d.p_value ?? 0).toFixed(3)}, n=${d.n}, doses=${d.n_distinct_doses})`,
                             "Spearman ρ",
                           ];
                         }} />
                <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
                <Bar dataKey="spearman_r" radius={[0, 3, 3, 0]}>
                  {supplementDoseResponse.slice(0, 12).map((d, i) => (
                    <Cell key={i} fill={d.spearman_r > 0 ? "#06b6d4" : "#f97316"}
                          fillOpacity={d.low_n ? 0.35 : 0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>

      {/* ── Lifestyle: Nutrition + Workout-to-Bed Gap ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Nutrition Spearman */}
        <ChartCard collapsible
          title="Nutrition Correlations"
          subtitle="Spearman ρ between daily nutrient totals and next-night HRV"
          source="SPEARMAN ρ"
          info="What it shows: how strongly each daily nutrient total moves with HRV the following morning. A bar near +1.0 means that nutrient almost always rises when your HRV rises; near −1.0 means the opposite; near 0 means no consistent link. Method: Spearman ρ — a rank-based correlation that's robust to outliers and skewed distributions; scores range −1.0 to +1.0. Rank-based so occasional restaurant blowouts don't dominate and non-linear monotonic effects still show up — e.g. sodium at 1g vs 8g. Tooltip: ρ is the correlation; p is the p-value (chance the link is random noise — <0.05 is the conventional significance threshold); n is the number of nights. BH-FDR corrected across nutrients. ⚠ marks rows with n<20 — estimates unstable. Associational, not causal."
        >
          {nutritionImpact.length > 0 ? (
            <ResponsiveContainer width="100%" height={Math.max(280, nutritionImpact.length * 38)}>
              <BarChart data={nutritionImpact.map(d => ({ ...d, displayLabel: `${d.low_n ? "⚠ " : ""}${d.label}` }))}
                        layout="vertical"
                        margin={{ left: 8, right: 20, top: 4, bottom: 20 }}>
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={axisTick} domain={[-1, 1]}
                       tickFormatter={v => v.toFixed(2)}
                       label={axisLabel("Spearman ρ", "x")} />
                <YAxis type="category" dataKey="displayLabel" width={axisW.nutri}
                       tick={<WrappedYAxisTick maxCharsPerLine={chars.nutri} fontSize={isMobile ? 10 : 11} />} />
                <Tooltip {...chartTooltip}
                         formatter={(v: any, _n: any, p: any) => {
                           const d = p?.payload ?? {};
                           return [
                             `${Number(v).toFixed(3)} (p=${(d.p_value ?? 0).toFixed(3)}, n=${d.n})`,
                             "Spearman ρ",
                           ];
                         }} />
                <ReferenceLine x={0} stroke="rgba(255,255,255,0.1)" />
                <Bar dataKey="spearman_r" radius={[0, 3, 3, 0]}>
                  {nutritionImpact.map((d, i) => (
                    <Cell key={i} fill={d.spearman_r > 0 ? "#22c55e" : "#ef4444"}
                          fillOpacity={d.low_n ? 0.35 : 0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[260px] flex items-center justify-center">
              <p className="text-[11px] text-text-tertiary">No nutrition data — run hrv_analysis.py</p>
            </div>
          )}
        </ChartCard>

        <ChartCard collapsible
          title="Workout-to-Bed Gap vs Next-Morning HRV"
          subtitle={`${rangeLabel(range)} · each dot = one night`}
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
      </div>

      {/* ── Causal Inference: from association to causation ── */}
      {/*
        Where the other charts on this page measure ASSOCIATION (Spearman, Welch),
        this section estimates causal effects with confounder adjustment. The
        three estimators (naive, PSM, AIPW) are reported side-by-side so the
        reader can see how much of each apparent effect survives adjustment.
        Empty unless `python hrv_analysis.py` has populated the causal/* rows
        in pds.hrv_analysis_results.
      */}
      <div className="bg-surface-card border border-border-subtle rounded-[6px] p-6 shadow-card">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="text-[18px] font-medium text-text-primary">Causal Inference</h3>
            <p className="text-[12px] text-text-tertiary mt-1">
              Adjusted treatment effects · {causalMeta?.n_binary_treatments_analyzed ?? 0} binary +{" "}
              {causalMeta?.n_continuous_treatments_analyzed ?? 0} continuous treatments
            </p>
          </div>
          <span className="text-[9px] font-mono text-text-tertiary px-2 py-0.5 rounded border border-border-subtle">
            AIPW · PSM · NAIVE
          </span>
        </div>

        <div className="text-[12px] text-text-secondary leading-relaxed space-y-3 max-w-4xl">
          <p>
            Every other chart on this page measures <em>association</em>: how strongly each behavior moves
            with HRV. None of them adjust for the fact that behaviors cluster — alcohol nights are also
            weekend nights are also restaurant nights are also late-bed nights. The naive Yes/No t-test
            blames alcohol for the whole pile. <strong>Adjusted causal estimates correct for that</strong>{" "}
            by holding pre-treatment confounders fixed.
          </p>

          <div>
            <p className="text-text-primary font-medium mb-1">What&apos;s being estimated</p>
            <p>
              For each behavior X, the Average Treatment Effect on next-night HRV:{" "}
              <em>&ldquo;If you did X today (holding the pre-treatment confounders fixed), what would your
              HRV be tomorrow, vs. if you didn&apos;t?&rdquo;</em> Outcome is{" "}
              <code className="font-mono text-[11px] text-text-tertiary">whoop_hrv_rmssd</code> shifted
              −1 day, the same convention as the XGBoost prediction model above.
            </p>
          </div>

          <div>
            <p className="text-text-primary font-medium mb-1">Three estimators, reported side-by-side</p>
            <ol className="list-decimal list-inside space-y-1 ml-2">
              <li>
                <strong>Naive</strong> (Welch&apos;s t-test): <code className="font-mono text-[11px]">mean(Y|T=1) − mean(Y|T=0)</code>.
                The unadjusted comparison — what every other chart on this page is built on.
              </li>
              <li>
                <strong>Propensity Score Matching (PSM)</strong>: for each treated day, find the closest
                control day in confounder-space (1:3 nearest-neighbor on logit propensity). Average the
                within-pair HRV differences. CI by paired bootstrap (B=500).
              </li>
              <li>
                <strong>AIPW (doubly-robust)</strong>: combines a logistic propensity model with two Ridge
                outcome models (one per arm). Unbiased if <em>either</em> model is correct. 5-fold
                cross-fit so the models aren&apos;t evaluated on their training data. CI from the
                influence-function variance.
              </li>
            </ol>
          </div>

          <div>
            <p className="text-text-primary font-medium mb-1">How to read it</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li><strong>AIPW ATE bar</strong> = the headline causal estimate, in ms of HRV.</li>
              <li>
                <strong>Error bars</strong> = 95% confidence interval — the range the true causal
                effect is likely to land in given the data. If the CI crosses 0, the effect is
                consistent with no real causal influence (the apparent bar could just be noise).
              </li>
              <li>
                <strong>Tooltip <code className="font-mono text-[11px]">n=Y/Z</code></strong> = sample
                sizes that fed the estimate. Y is the number of <em>treated</em> days (the behavior
                happened), Z is the number of <em>control</em> days (it didn&apos;t). Bigger n → narrower
                CI → more trustworthy estimate.
              </li>
              <li>
                <strong>E-value</strong> = how strong an <em>unmeasured</em> confounder would need to be
                (on the risk-ratio scale, with both treatment and outcome) to fully explain the effect
                away. Higher = more robust. Computed via the Chinn (2000) d→RR transform for continuous
                outcomes, then VanderWeele &amp; Ding&apos;s formula{" "}
                <code className="font-mono text-[11px]">E = RR + √(RR·(RR−1))</code>.
              </li>
              <li>
                <strong>Attenuation</strong> (in the comparison table) = % by which adjustment shrunk
                (or grew) the naive estimate. Big shrinkage = naive view was dominated by confounding.
              </li>
              <li>⚠ flags any treatment with fewer than 20 days in either arm — small-sample CIs are unreliable.</li>
            </ul>
          </div>

          <div>
            <p className="text-text-primary font-medium mb-1">Important caveats</p>
            <ul className="list-disc list-inside space-y-1 ml-2">
              <li>
                This is <em>n-of-1 observational</em> data. Without randomization, all causal claims rest
                on the assumption that the listed confounders are sufficient (no unmeasured confounding) —
                which the E-value tries to probe but can&apos;t prove.
              </li>
              <li>
                We adjust only for <strong>pre-treatment</strong> features (yesterday&apos;s HRV, strain,
                sleep, training load, day-of-week). We deliberately do NOT adjust for same-night sleep
                or recovery — those are mediators on the very path we&apos;re estimating
                (adjusting for them would erase the effect).
              </li>
              <li>
                Effects are reported as <em>population-average</em> ATEs (AIPW) or <em>effect-on-the-treated</em>{" "}
                ATTs (PSM). They assume linear additivity — for very strong interactions
                (e.g. alcohol × short-sleep), AIPW gives a weighted average that may smooth over real heterogeneity.
              </li>
              <li>
                The outcome is HRV the morning <em>after</em> the behavior. Carry-over effects spanning
                multiple days (e.g. alcohol depressing HRV for 2-3 nights) are not modeled here.
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Supplements coverage callout — surfaces what's been dropped for low-n
          so the user doesn't have to scroll into the DAG card to discover that
          supplements are missing from the main forest plot. */}
      {(() => {
        const droppedSupps = causalDropped.filter((d: any) => d.family === "supplement");
        const includedSupps = causalBinary.filter((d: any) => d.family === "supplement");
        if (droppedSupps.length === 0 && includedSupps.length === 0) return null;
        const minRep = causalMeta?.min_per_arm_reported ?? 10;
        const topByN = [...droppedSupps]
          .sort((a, b) => (Number(b.n_treated) || 0) - (Number(a.n_treated) || 0))
          .slice(0, 10);
        return (
          <ChartCard collapsible
            title="Supplements · coverage status"
            subtitle={includedSupps.length > 0
              ? `${includedSupps.length} estimated · ${droppedSupps.length} awaiting tracking history`
              : `${droppedSupps.length} compounds enumerated but awaiting tracking history`}
            source={includedSupps.length > 0 ? "AIPW (DOUBLY ROBUST)" : "INSUFFICIENT DATA"}
            info={`Every compound in pds.supplement_intake_by_compound is enumerated as a binary treatment (taken vs not). They appear in the main forest plot only once at least ${minRep} days exist in each arm (Yes-nights AND No-nights). Until the supplement tracking window accumulates enough history, compounds will appear here with their current treated-day count so you can see which are closest to crossing the threshold.`}
          >
            {includedSupps.length > 0 ? (
              <div className="text-[11px] text-text-secondary leading-relaxed pb-2">
                <p className="mb-2">
                  {includedSupps.length} supplement{includedSupps.length === 1 ? "" : "s"} estimated above
                  in the main forest plot — look for the <code className="font-mono text-[10px]">family=supplement</code>{" "}
                  entries.
                </p>
              </div>
            ) : null}
            {droppedSupps.length > 0 && (
              <div className="text-[11px] text-text-secondary leading-relaxed">
                <p className="mb-2">
                  The supplement tracking window is too recent for causal estimation — every compound needs at least{" "}
                  <strong>{minRep} treated days</strong> AND <strong>{minRep} control days</strong> before its
                  estimate is reportable. Compounds closest to crossing the threshold:
                </p>
                <div className="overflow-x-auto -mx-2">
                  <table className="min-w-full text-[11px] font-mono">
                    <thead>
                      <tr className="text-text-tertiary border-b border-border-subtle">
                        <th className="text-left py-1.5 pl-3 pr-2 font-medium">Compound</th>
                        <th className="text-right py-1.5 px-2 font-medium">Days taken</th>
                        <th className="text-right py-1.5 px-2 font-medium">Days not taken</th>
                        <th className="text-right py-1.5 pl-2 pr-3 font-medium">Need</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topByN.map((d: any) => {
                        const treated = Number(d.n_treated) || 0;
                        const need = Math.max(0, minRep - treated);
                        return (
                          <tr key={d.treatment} className="border-b border-border-subtle/40">
                            <td className="py-1.5 pl-3 pr-2 text-text-primary">{d.label}</td>
                            <td className="py-1.5 px-2 text-right tabular-nums">{treated}</td>
                            <td className="py-1.5 px-2 text-right tabular-nums text-text-tertiary">{d.n_control}</td>
                            <td className="py-1.5 pl-2 pr-3 text-right tabular-nums">
                              {need === 0
                                ? <span className="text-emerald-400">ready</span>
                                : <span className="text-amber-400">+{need} days</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {droppedSupps.length > topByN.length && (
                    <p className="text-text-tertiary text-[10px] mt-2 italic">
                      …and {droppedSupps.length - topByN.length} more compounds with fewer tracked days.
                      Full list in the DAG &amp; Assumptions card.
                    </p>
                  )}
                </div>
                <p className="text-text-tertiary text-[10px] mt-3 leading-relaxed">
                  Log supplement intake at <a href="/supplements" className="text-accent hover:underline">/supplements</a>;{" "}
                  estimates populate on the next pipeline retrain after a compound crosses {minRep} treated days.
                </p>
              </div>
            )}
          </ChartCard>
        );
      })()}

      {/* Causal Forest Plot: Binary Treatments */}
      <ChartCard collapsible
        title="Causal Effects · Binary Treatments"
        subtitle={`AIPW ATE on next-night HRV (ms) · 95% CI shown as error bars · top ${Math.min(causalBinary.length, 20)} by |effect|`}
        source="AIPW (DOUBLY ROBUST)"
        info="Each bar is the doubly-robust AIPW estimate of the average treatment effect on tomorrow's HRV. Error bars are 95% confidence intervals from the influence-function variance. Bars whose CI crosses 0 (gray) are statistically indistinguishable from no-effect; bars whose CI stays positive (green) or negative (red) are causal evidence under the stated confounder set. ⚠ marks treatments with fewer than 20 days in either arm — interpret with caution. The naive (unadjusted) estimate for each treatment is in the comparison table below."
      >
        {causalBinary.length > 0 ? (() => {
          const top = causalBinary
            .filter((d: any) => Number.isFinite(d.aipw_ate))
            .slice(0, 20)
            .map((d: any) => ({
              ...d,
              displayLabel: `${d.low_n ? "⚠ " : ""}${d.label}`,
              errorRange: [
                Math.max(0, (d.aipw_ate ?? 0) - (d.aipw_ci_low ?? 0)),
                Math.max(0, (d.aipw_ci_high ?? 0) - (d.aipw_ate ?? 0)),
              ],
              barColor: !d.significant
                ? "#71717a"
                : d.aipw_ate > 0 ? "#22c55e" : "#ef4444",
            }));
          return (
            <ResponsiveContainer width="100%" height={Math.max(420, top.length * 32)}>
              <BarChart data={top} layout="vertical"
                        margin={{ left: 8, right: 32, top: 4, bottom: 24 }}>
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={axisTick}
                       tickFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(0)}`}
                       label={axisLabel("AIPW ATE (ms)", "x")} />
                <YAxis type="category" dataKey="displayLabel" width={axisW.xlong}
                       tick={<WrappedYAxisTick maxCharsPerLine={chars.xlong} fontSize={10} />} />
                <Tooltip {...chartTooltip}
                         formatter={(v: any, _n: any, p: any) => {
                           const d = p?.payload ?? {};
                           const ci = `[${Number(d.aipw_ci_low).toFixed(1)}, ${Number(d.aipw_ci_high).toFixed(1)}]`;
                           const ev = Number.isFinite(d.e_value) ? d.e_value.toFixed(2) : "—";
                           return [
                             `${Number(v).toFixed(1)} ms — CI ${ci}, E-val ${ev}, n=${d.n_treated}/${d.n_control}, family=${d.family}`,
                             "AIPW ATE",
                           ];
                         }} />
                <ReferenceLine x={0} stroke="rgba(255,255,255,0.15)" />
                <Bar dataKey="aipw_ate" radius={[0, 3, 3, 0]}>
                  {top.map((d: any, i: number) => (
                    <Cell key={i} fill={d.barColor} fillOpacity={d.low_n ? 0.35 : 0.85} />
                  ))}
                  <ErrorBar dataKey="errorRange" width={4} strokeWidth={1.5}
                            stroke="#f4f4f5" direction="x" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          );
        })() : (
          <div className="h-[260px] flex items-center justify-center px-6">
            <p className="text-[11px] text-text-tertiary text-center leading-relaxed">
              No causal results yet — run <code className="font-mono text-amber-400">python hrv_analysis.py</code>{" "}
              to populate. The causal layer needs at least 10 treated + 10 control days per treatment;
              very rare behaviors may never show up here even with full data.
            </p>
          </div>
        )}
      </ChartCard>

      {/* Naive vs Adjusted Comparison Table */}
      <ChartCard collapsible
        title="Naive vs Adjusted: where confounding mattered"
        subtitle="Treatments where adjustment changed the answer most"
        source="WELCH vs AIPW"
        info="Side-by-side comparison of the unadjusted (Welch's t-test) and adjusted (AIPW) estimates for the top treatments. ‘Attenuation’ is the % by which adjustment shrunk (or grew) the naive estimate — large positive values mean the naive view was inflated by confounding (e.g. alcohol nights co-occur with bad sleep, so the naive estimate blames alcohol for the whole drop). Sorted by absolute attenuation so the biggest course-corrections float to the top."
      >
        {causalBinary.length > 0 ? (
          <div className="overflow-x-auto -mx-2">
            <table className="min-w-full text-[11px] font-mono">
              <thead>
                <tr className="text-text-tertiary border-b border-border-subtle">
                  <th className="text-left py-2 pl-3 pr-2 font-medium">Treatment</th>
                  <th className="text-left py-2 px-2 font-medium">Family</th>
                  <th className="text-right py-2 px-2 font-medium">Naive Δ</th>
                  <th className="text-right py-2 px-2 font-medium">PSM ATT</th>
                  <th className="text-right py-2 px-2 font-medium">AIPW ATE</th>
                  <th className="text-right py-2 px-2 font-medium">95% CI</th>
                  <th className="text-right py-2 px-2 font-medium">E-val</th>
                  <th
                    className="text-right py-2 px-2 font-medium"
                    title="(|naive| − |adjusted|) / |naive|. Positive = adjustment shrunk the effect (naive was inflated by confounding). Negative = adjustment grew it (confounding was masking it). ↻ marks sign-flip — naive and adjusted disagree on direction."
                  >
                    Attenuation <span className="text-text-tertiary text-[10px]">(+ shrunk · − grew)</span>
                  </th>
                  <th className="text-right py-2 pl-2 pr-3 font-medium">n T / n C</th>
                </tr>
              </thead>
              <tbody>
                {[...causalBinary]
                  .filter((d: any) => Number.isFinite(d.aipw_ate) && Number.isFinite(d.naive_ate))
                  .sort((a: any, b: any) => Math.abs(b.attenuation_pct ?? 0) - Math.abs(a.attenuation_pct ?? 0))
                  .slice(0, 15)
                  .map((d: any) => {
                    const sigColor = d.significant
                      ? (d.aipw_ate > 0 ? "text-emerald-400" : "text-red-400")
                      : "text-text-tertiary";
                    const attColor = (d.attenuation_pct ?? 0) > 30
                      ? "text-amber-400"
                      : (d.attenuation_pct ?? 0) < -30
                        ? "text-cyan-400"
                        : "text-text-secondary";
                    // Sign-flip = naive and AIPW disagree on direction.
                    // Visually distinct because it's the most consequential
                    // change adjustment can produce (the conclusion reverses,
                    // not just shrinks/grows).
                    const naiveSign = Math.sign(Number(d.naive_ate));
                    const aipwSign = Math.sign(Number(d.aipw_ate));
                    const signFlip = naiveSign !== 0 && aipwSign !== 0 && naiveSign !== aipwSign;
                    return (
                      <tr key={d.treatment} className="border-b border-border-subtle/40 hover:bg-white/[0.02]">
                        <td className="py-2 pl-3 pr-2 text-text-primary">
                          {d.low_n ? <span className="text-amber-400 mr-1">⚠</span> : null}
                          {d.label}
                        </td>
                        <td className="py-2 px-2 text-text-tertiary">{d.family}</td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {d.naive_ate >= 0 ? "+" : ""}{Number(d.naive_ate).toFixed(1)}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {Number.isFinite(d.psm_ate)
                            ? `${d.psm_ate >= 0 ? "+" : ""}${Number(d.psm_ate).toFixed(1)}`
                            : "—"}
                        </td>
                        <td className={`py-2 px-2 text-right tabular-nums ${sigColor}`}>
                          {d.aipw_ate >= 0 ? "+" : ""}{Number(d.aipw_ate).toFixed(1)}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums text-text-tertiary">
                          [{Number(d.aipw_ci_low).toFixed(1)}, {Number(d.aipw_ci_high).toFixed(1)}]
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums">
                          {Number.isFinite(d.e_value) ? d.e_value.toFixed(2) : "—"}
                        </td>
                        <td className={`py-2 px-2 text-right tabular-nums ${attColor}`}>
                          {signFlip && (
                            <span
                              className="text-violet-400 mr-1"
                              title={`Sign flip: naive said ${d.naive_ate > 0 ? "positive" : "negative"}, AIPW says ${d.aipw_ate > 0 ? "positive" : "negative"} — confounding reversed the direction, not just the magnitude.`}
                            >
                              ↻
                            </span>
                          )}
                          {Number.isFinite(d.attenuation_pct)
                            ? `${(d.attenuation_pct ?? 0) >= 0 ? "+" : ""}${(d.attenuation_pct ?? 0).toFixed(0)}%`
                            : "—"}
                        </td>
                        <td className="py-2 pl-2 pr-3 text-right tabular-nums text-text-tertiary">
                          {d.n_treated} / {d.n_control}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[11px] text-text-tertiary py-8 text-center">
            Run <code className="font-mono text-amber-400">python hrv_analysis.py</code> to populate.
          </p>
        )}
      </ChartCard>

      {/* Continuous treatments + DAG / Assumptions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ChartCard collapsible
          title="Continuous Treatments (median-split)"
          subtitle="Adjusted contrast: above-median vs below-median day"
          source="AIPW (DOUBLY ROBUST)"
          info="Continuous treatments (calories, strain, training load, steps) are binarized at their personal median, giving an 'above your usual' contrast that's directly comparable to the binary treatments. Same AIPW machinery, same pre-treatment confounders. Note that median-split loses dose information — for full dose-response curves see the Supplement Dose-Response chart above (which uses Spearman rather than adjusted contrasts)."
        >
          {causalContinuous.length > 0 ? (() => {
            const top = causalContinuous
              .filter((d: any) => Number.isFinite(d.aipw_ate))
              .slice(0, 12)
              .map((d: any) => ({
                ...d,
                displayLabel: `${d.low_n ? "⚠ " : ""}${d.label}`,
                errorRange: [
                  Math.max(0, (d.aipw_ate ?? 0) - (d.aipw_ci_low ?? 0)),
                  Math.max(0, (d.aipw_ci_high ?? 0) - (d.aipw_ate ?? 0)),
                ],
                barColor: !d.significant
                  ? "#71717a"
                  : d.aipw_ate > 0 ? "#22c55e" : "#ef4444",
              }));
            return (
              <ResponsiveContainer width="100%" height={Math.max(280, top.length * 36)}>
                <BarChart data={top} layout="vertical"
                          margin={{ left: 8, right: 28, top: 4, bottom: 24 }}>
                  <CartesianGrid {...gridStyle} horizontal={false} />
                  <XAxis type="number" tick={axisTick}
                         tickFormatter={v => `${v > 0 ? "+" : ""}${v.toFixed(0)}`}
                         label={axisLabel("AIPW ATE (ms)", "x")} />
                  <YAxis type="category" dataKey="displayLabel" width={axisW.long}
                         tick={<WrappedYAxisTick maxCharsPerLine={chars.long} fontSize={10} />} />
                  <Tooltip {...chartTooltip}
                           formatter={(v: any, _n: any, p: any) => {
                             const d = p?.payload ?? {};
                             const ci = `[${Number(d.aipw_ci_low).toFixed(1)}, ${Number(d.aipw_ci_high).toFixed(1)}]`;
                             const ev = Number.isFinite(d.e_value) ? d.e_value.toFixed(2) : "—";
                             return [
                               `${Number(v).toFixed(1)} ms — CI ${ci}, E-val ${ev}, n=${d.n_treated}/${d.n_control}`,
                               "AIPW ATE",
                             ];
                           }} />
                  <ReferenceLine x={0} stroke="rgba(255,255,255,0.15)" />
                  <Bar dataKey="aipw_ate" radius={[0, 3, 3, 0]}>
                    {top.map((d: any, i: number) => (
                      <Cell key={i} fill={d.barColor} fillOpacity={d.low_n ? 0.35 : 0.85} />
                    ))}
                    <ErrorBar dataKey="errorRange" width={4} strokeWidth={1.5}
                              stroke="#f4f4f5" direction="x" />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            );
          })() : (
            <div className="h-[260px] flex items-center justify-center px-6">
              <p className="text-[11px] text-text-tertiary text-center leading-relaxed">
                No continuous-treatment results yet.
              </p>
            </div>
          )}
        </ChartCard>

        <ChartCard collapsible
          title="Causal DAG &amp; Assumptions"
          subtitle="What we adjust for, and what we deliberately don't"
          source="DECLARED MODEL"
          info="Every causal estimate above depends on this DAG. Confounders adjusted for must be sufficient — meaning, conditional on them, treatment assignment is (approximately) random. We deliberately exclude same-night sleep/recovery/HRV-derived variables because those are MEDIATORS — they lie on the causal path between behavior and outcome, and adjusting for them would block the very effect we're estimating. The E-value gives a quantitative sense of how much an unmeasured confounder would have to violate this assumption to overturn each finding."
        >
          {causalDag ? (
            <div className="text-[11px] font-mono leading-relaxed space-y-3 max-h-[420px] overflow-y-auto pr-2">
              <div>
                <p className="text-text-tertiary uppercase tracking-wide text-[10px] mb-1">
                  Outcome
                </p>
                <p className="text-text-primary">
                  <code className="text-cyan-400">{causalDag.outcome}</code> — {causalDag.outcome_description}
                </p>
              </div>

              {causalDag.estimand && (
                <div>
                  <p className="text-text-tertiary uppercase tracking-wide text-[10px] mb-1">
                    Estimand
                  </p>
                  <p className="text-text-secondary leading-relaxed">{causalDag.estimand}</p>
                </div>
              )}

              {(causalDag.treatment_families ?? []).length > 0 && (
                <div>
                  <p className="text-text-tertiary uppercase tracking-wide text-[10px] mb-1">
                    Treatment families
                  </p>
                  <p className="text-text-secondary">
                    {(causalDag.treatment_families as string[]).map((f, i) => (
                      <span key={f}>
                        <code>{f}</code>{i < causalDag.treatment_families.length - 1 ? ", " : ""}
                      </span>
                    ))}
                  </p>
                </div>
              )}

              <div>
                <p className="text-text-tertiary uppercase tracking-wide text-[10px] mb-1">
                  Common confounders (every family)
                </p>
                <ul className="space-y-0.5">
                  {(causalDag.common_confounders ?? []).map((c: string) => (
                    <li key={c} className="text-text-secondary">
                      ► <code>{c}</code>
                    </li>
                  ))}
                </ul>
              </div>

              {(causalDag.supplement_extra_confounders ?? []).length > 0 && (
                <div>
                  <p className="text-text-tertiary uppercase tracking-wide text-[10px] mb-1">
                    Extra confounders for SUPPLEMENT family
                  </p>
                  <ul className="space-y-0.5">
                    {causalDag.supplement_extra_confounders.map((c: string) => (
                      <li key={c} className="text-text-secondary">
                        ► <code>{c}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <p className="text-text-tertiary uppercase tracking-wide text-[10px] mb-1">
                  Mediators EXCLUDED on purpose
                </p>
                <ul className="space-y-1">
                  {(causalDag.mediator_exclusions ?? []).map((m: string, i: number) => (
                    <li key={i} className="text-text-secondary leading-relaxed">▼ {m}</li>
                  ))}
                </ul>
              </div>

              <div>
                <p className="text-text-tertiary uppercase tracking-wide text-[10px] mb-1">
                  Identifying assumptions
                </p>
                <ul className="space-y-1">
                  {(causalDag.identifying_assumptions ?? []).map((a: string, i: number) => (
                    <li key={i} className="text-text-secondary leading-relaxed">• {a}</li>
                  ))}
                </ul>
              </div>

              <div>
                <p className="text-text-tertiary uppercase tracking-wide text-[10px] mb-1">
                  Sensitivity: E-value
                </p>
                <p className="text-text-secondary leading-relaxed">
                  {causalDag.sensitivity?.method}
                </p>
                <p className="text-text-tertiary mt-1 text-[10px] leading-relaxed">
                  {causalDag.sensitivity?.transform}
                </p>
              </div>

              {causalMeta && (
                <div className="pt-2 border-t border-border-subtle/50">
                  <p className="text-text-tertiary uppercase tracking-wide text-[10px] mb-1">
                    Run metadata
                  </p>
                  <p className="text-text-tertiary">
                    Estimators: {(causalMeta.estimators ?? []).join(", ")}<br />
                    PSM: k={causalMeta.psm_k}, bootstrap={causalMeta.psm_bootstrap_reps} reps<br />
                    AIPW folds: {causalMeta.aipw_n_folds}<br />
                    Propensity trim: [{(causalMeta.propensity_trim ?? [])[0]}, {(causalMeta.propensity_trim ?? [])[1]}]<br />
                    Min per arm: {causalMeta.min_per_arm_reported} report / {causalMeta.min_per_arm_full} full
                  </p>
                </div>
              )}

              {causalDropped.length > 0 && (() => {
                // Group dropped treatments by family and sort each group so the
                // ones closest to crossing the threshold (highest n_treated)
                // float to the top. This is essential for supplements — the
                // user wants to see which compounds are 1-2 logs away from
                // populating, not a flat alphabetical list.
                const byFamily: Record<string, any[]> = {};
                for (const d of causalDropped) {
                  (byFamily[d.family] ??= []).push(d);
                }
                for (const fam of Object.keys(byFamily)) {
                  byFamily[fam].sort((a, b) =>
                    (Number(b.n_treated) || 0) - (Number(a.n_treated) || 0)
                  );
                }
                const order = ["supplement", "journal", "habit", "behavior", "nutrition"]
                  .filter(f => byFamily[f]?.length);
                const minRep = causalMeta?.min_per_arm_reported ?? 10;
                return (
                  <div className="pt-2 border-t border-border-subtle/50">
                    <p className="text-text-tertiary uppercase tracking-wide text-[10px] mb-1">
                      Treatments dropped for insufficient sample
                    </p>
                    <p className="text-text-tertiary mb-2">
                      {causalDropped.length} dropped (need ≥{minRep} days in each arm)
                    </p>
                    <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                      {order.map(fam => (
                        <div key={fam}>
                          <p className="text-text-secondary text-[10px] uppercase tracking-wide mb-1">
                            {fam} <span className="text-text-tertiary">— {byFamily[fam].length}</span>
                          </p>
                          <ul className="space-y-0.5 pl-1">
                            {byFamily[fam].slice(0, 15).map((d: any) => (
                              <li key={d.treatment} className="text-text-tertiary leading-snug">
                                ✕ {d.label}{" "}
                                <span className="text-[10px]">
                                  (n={d.n_treated}/{d.n_control})
                                </span>
                              </li>
                            ))}
                            {byFamily[fam].length > 15 && (
                              <li className="text-text-tertiary text-[10px] pl-3 italic">
                                …and {byFamily[fam].length - 15} more
                              </li>
                            )}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          ) : (
            <p className="text-[11px] text-text-tertiary py-8 text-center">
              Run <code className="font-mono text-amber-400">python hrv_analysis.py</code> to populate.
            </p>
          )}
        </ChartCard>
      </div>

      {/* ── Environment Sweet Spot: dose-response for controllable inputs ── */}
      {/*
        The causal layer above answers "does warmer/cooler than usual move HRV?"
        (binary direction). This panel answers the different question "what
        SPECIFIC temperature is optimal for me?" by binning every night by the
        selected temperature sensor and showing the mean of the selected
        next-night outcome per bucket. Peak bucket = personal sweet spot for
        that outcome. Error bars are ±1 SEM. Computed client-side from
        daily_health_matrix; no python pipeline dependency.

        Both X and Y axes are user-selectable (since 2026-05-25): toggle
        between Pod room temp / bed surface temp on the X axis, and HRV /
        Recovery Score / Sleep Efficiency / Deep Sleep duration on the Y.
        The optimal temperature for HRV may differ from optimal for deep
        sleep — surfacing that lets you pick a target based on the metric
        you actually want to optimize.
      */}
      {(() => {
        const X_AXIS_META = {
          room: {
            label: "Room temp",
            column: "eight_sleep_room_temp",
            axisLabel: "median room temp (°F · Pod sensor, uncalibrated)",
            sensorCaveat: "the Pod's room-temp sensor sits on the unit (in/under the bed) and reads warmer than a wall thermostat by an unknown amount — the relative shape (peak vs trough) is valid for finding your personal optimum, but absolute Fahrenheit values aren't.",
          },
          bed: {
            label: "Bed temp",
            column: "eight_sleep_bed_temp",
            axisLabel: "median bed-surface temp (°F · Pod sensor)",
            sensorCaveat: "bed temp reflects both your Pod heater/cooler setpoint AND your body warming the surface — it's partly an OUTPUT of how hot you slept, not just an input. Treat the peak as 'the bed temp my best nights converged on' rather than a setpoint recommendation.",
          },
        } as const;
        const Y_OUTCOMES = {
          hrv: { label: "WHOOP HRV", column: "whoop_hrv_rmssd", unit: "ms", axisLabel: "WHOOP HRV (ms)" },
          recovery: { label: "Recovery Score", column: "whoop_recovery_score", unit: "%", axisLabel: "WHOOP Recovery (%)" },
          efficiency: { label: "Sleep Efficiency", column: "whoop_sleep_efficiency", unit: "%", axisLabel: "WHOOP Sleep Efficiency (%)" },
          deep: { label: "Deep Sleep", column: "whoop_deep_sleep_milli", unit: "min", axisLabel: "WHOOP Deep Sleep (min)" },
        } as const;
        const xMeta = X_AXIS_META[envXAxis];
        const yMeta = Y_OUTCOMES[envOutcome];
        const useableRows = envMatrix.filter(
          (d: any) => d[xMeta.column] != null && d[yMeta.column] != null
        );
      return (
      <div className="bg-surface-card border border-border-subtle rounded-[6px] p-6 shadow-card">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="text-[18px] font-medium text-text-primary">Environment Sweet Spot</h3>
            <p className="text-[12px] text-text-tertiary mt-1">
              Mean {yMeta.label} per {xMeta.label.toLowerCase()} bucket · {useableRows.length} nights
            </p>
          </div>
          <span className="text-[9px] font-mono text-text-tertiary px-2 py-0.5 rounded border border-border-subtle">
            BINNED MEAN ± SEM
          </span>
        </div>

        {/* Axis selectors — surfaced above the explanation block so the
            chart-controls relationship is obvious. */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mb-4 text-[11px] font-mono">
          <div className="flex items-center gap-2">
            <span className="text-text-tertiary uppercase tracking-wide">Temp sensor</span>
            {(Object.keys(X_AXIS_META) as Array<keyof typeof X_AXIS_META>).map((k) => (
              <button
                key={k}
                onClick={() => setEnvXAxis(k)}
                className={`px-2 py-0.5 rounded-[3px] border ${envXAxis === k
                  ? "bg-[#06b6d4]/15 border-[#06b6d4]/40 text-text-primary"
                  : "border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-border-hover"}`}
              >
                {X_AXIS_META[k].label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-text-tertiary uppercase tracking-wide">Outcome</span>
            {(Object.keys(Y_OUTCOMES) as Array<keyof typeof Y_OUTCOMES>).map((k) => (
              <button
                key={k}
                onClick={() => setEnvOutcome(k)}
                className={`px-2 py-0.5 rounded-[3px] border ${envOutcome === k
                  ? "bg-[#22c55e]/15 border-[#22c55e]/40 text-text-primary"
                  : "border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-border-hover"}`}
              >
                {Y_OUTCOMES[k].label}
              </button>
            ))}
          </div>
        </div>

        <div className="text-[12px] text-text-secondary leading-relaxed space-y-3 max-w-4xl mb-4">
          <p>
            The Causal Inference section above tells you whether <em>warmer-than-usual</em> or
            <em> cooler-than-usual</em> moves your outcome (binary direction). This panel
            answers a different question: <strong>which specific temperature is actually
            optimal for the outcome you care about?</strong>{" "}
            Every night with both a temperature reading and a {yMeta.label.toLowerCase()}{" "}
            value is binned into 2°F buckets and plotted as the per-bucket mean. The peak
            bucket is your personal sweet spot for that outcome. The optimal temperature
            for HRV may differ from the optimal for deep sleep — that&apos;s the point of
            the outcome toggle.
          </p>
          <p>
            <strong>Error bars are ±1 SEM</strong> (standard error of the mean). Narrower bars
            = more nights in that bucket = more trustworthy. Bars at &lt;35% opacity have n&lt;5
            nights and shouldn&apos;t drive decisions yet.
          </p>
          <p>
            <strong>⚠ Sensor caveat ({xMeta.label}):</strong> {xMeta.sensorCaveat} Filed
            a follow-up to calibrate empirically by leaving a separate thermometer in the
            room for a week and deriving the real offset from paired readings.
          </p>
          <p className="text-[11px] text-text-tertiary">
            <strong>Sample size today:</strong> {useableRows.length} nights collected for
            this {xMeta.label.toLowerCase()} × {yMeta.label.toLowerCase()} pair.{" "}
            {useableRows.length < 30 && (
              <span>Directional reads need <strong>~30 nights</strong>; confident reads need <strong>~100</strong>. Eight Sleep&apos;s intervals API began exposing temp data ~2026-05-15, so this fills in one night per daily ETL run going forward.</span>
            )}
            {useableRows.length >= 30 && useableRows.length < 100 && (
              <span>Enough for a <strong>directional read</strong>. More nights will tighten the bars.</span>
            )}
            {useableRows.length >= 100 && (
              <span>Sample size is sufficient for a <strong>confident read</strong> on the optimal bucket.</span>
            )}
          </p>
        </div>

        {(() => {
          if (useableRows.length === 0) {
            return (
              <p className="text-[11px] text-text-tertiary py-8 text-center">
                No nights with both {xMeta.label.toLowerCase()} and {yMeta.label.toLowerCase()} yet.
                Will populate as the nightly ETL accumulates new data.
              </p>
            );
          }

          // Convert °C → °F at the bin boundary (DB canonical = °C). Outcome
          // conversion for milliseconds-stored fields (deep sleep) → minutes
          // so the Y axis reads in user-native units.
          const cToF = (c: number) => c * 9 / 5 + 32;
          const outcomeToDisplay = (raw: number) =>
            envOutcome === "deep" ? raw / 60000 : raw; // ms → min for deep sleep
          const BUCKET_SIZE = 2.0; // °F bins
          const buckets: Record<string, number[]> = {};
          useableRows.forEach((d: any) => {
            const tC = Number(d[xMeta.column]);
            const yRaw = Number(d[yMeta.column]);
            if (isNaN(tC) || isNaN(yRaw)) return;
            const tF = cToF(tC);
            const start = Math.floor(tF / BUCKET_SIZE) * BUCKET_SIZE;
            const key = start.toFixed(1);
            if (!buckets[key]) buckets[key] = [];
            buckets[key].push(outcomeToDisplay(yRaw));
          });

          const rows = Object.entries(buckets)
            .map(([k, ys]) => {
              const n = ys.length;
              const mean = ys.reduce((a, b) => a + b, 0) / n;
              const variance = n > 1
                ? ys.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)
                : 0;
              const sd = Math.sqrt(variance);
              const sem = n > 1 ? sd / Math.sqrt(n) : 0;
              const lo = parseFloat(k);
              return {
                start: lo,
                bucket: `${lo.toFixed(0)}–${(lo + BUCKET_SIZE).toFixed(0)}°F`,
                n,
                meanY: +mean.toFixed(1),
                sem: +sem.toFixed(2),
                sd: +sd.toFixed(2),
              };
            })
            .sort((a, b) => a.start - b.start);

          if (rows.length === 0) {
            return <p className="text-[11px] text-text-tertiary py-8 text-center">No valid data to bucket.</p>;
          }

          const reliable = rows.filter(r => r.n >= 5);
          const peakRow = (reliable.length > 0 ? reliable : rows).reduce(
            (m, r) => (r.meanY > m.meanY ? r : m)
          );

          return (
            <>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={rows} margin={{ left: 8, right: 20, top: 4, bottom: 20 }}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="bucket" tick={axisTick}
                    label={axisLabel(xMeta.axisLabel, "x")} />
                  <YAxis tick={axisTick} width={55}
                    label={axisLabel(yMeta.axisLabel, "y")} />
                  <Tooltip {...chartTooltip}
                    formatter={(v: any, _name: any, p: any) => {
                      const d = p?.payload ?? {};
                      return [
                        `${Number(v).toFixed(1)} ${yMeta.unit} (n=${d.n}, SEM=±${d.sem}, SD=${d.sd})`,
                        `Mean ${yMeta.label}`,
                      ];
                    }} />
                  <Bar dataKey="meanY" radius={[3, 3, 0, 0]}>
                    {rows.map((r, i) => (
                      <Cell key={i}
                        fill={r.bucket === peakRow.bucket ? "#22c55e" : "#06b6d4"}
                        fillOpacity={r.n < 5 ? 0.35 : 0.85} />
                    ))}
                    <ErrorBar dataKey="sem" width={4} strokeWidth={1.5} stroke="#f59e0b" />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <p className="text-[11px] text-text-tertiary mt-3">
                {rows.length >= 3 && useableRows.length >= 10 ? (
                  <>
                    Peak bucket ({xMeta.label.toLowerCase()}):{" "}
                    <strong className="text-text-secondary">{peakRow.bucket}</strong>,{" "}
                    {peakRow.meanY} {yMeta.unit} mean {yMeta.label.toLowerCase()} across{" "}
                    {peakRow.n} night{peakRow.n !== 1 ? "s" : ""}.
                    {reliable.length === 0 && " ⚠ No buckets yet have ≥5 nights — treat the peak as preliminary."}
                  </>
                ) : (
                  <>Too few nights / buckets to identify a meaningful peak. Check back as data accumulates.</>
                )}
              </p>
            </>
          );
        })()}
      </div>
      );
      })()}

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

                <div className="bg-white/[0.03] rounded-[6px] p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-text-primary">SARIMAX</span>
                    <span className="text-[9px] font-mono text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">SEASONAL</span>
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
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">Reading p-values:</strong> The <em>p</em> shown in chart tooltips is the chance the correlation could be random noise rather than a real link. Lower = more confident; <em>p</em> &lt; 0.05 is the conventional &ldquo;statistically significant&rdquo; threshold.
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
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">Reading the supporting numbers:</strong>
                    {" "}<em>Cohen&apos;s d</em> is the standardized effect size — the HRV gap divided by the typical night-to-night HRV variability. The ms bar tells you raw size; <em>d</em> tells you whether that gap is big <em>relative to your usual noise</em>. Rule of thumb: |d| &lt; 0.2 trivial, 0.2–0.5 small, 0.5–0.8 medium, &gt; 0.8 large.
                    {" "}<em>95% CI</em> (confidence interval) is the range the true difference is likely to land in given the data you have. If the CI crosses 0, the effect is statistically indistinguishable from no effect — meaning the apparent bar could just be noise.
                    {" "}<em>n</em> in tooltips (e.g. <code className="font-mono text-[10px]">n=12/47</code>) is the sample sizes — 12 Yes-nights and 47 No-nights in this example. Bigger n → narrower CI → more trustworthy estimate.
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

      {/* ── Model Evaluation Detail (collapsible — at-the-bottom diagnostics) ── */}
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
