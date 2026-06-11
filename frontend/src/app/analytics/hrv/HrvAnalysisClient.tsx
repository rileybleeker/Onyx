"use client";

import { useEffect, useRef, useState } from "react";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  CartesianGrid, ReferenceLine, Cell, ErrorBar,
} from "recharts";
import ChartCard from "@/components/ChartCard";
import RangeFilter from "@/components/RangeFilter";
import KpiTile from "@/components/KpiTile";
import MetricRing from "@/components/MetricRing";
import SectionHeader from "@/components/SectionHeader";
import {
  chartTooltip, axisTick, gridStyle, axisLabel, legendStyle,
  chartColors as C, directionalColor,
} from "@/lib/chart-theme";
import { rangeDays, rangeLabel, type Range, type WorkoutSleepGap } from "@/lib/queries";
import { loadHrvDashboard, loadHrvRangeDependent, parseJsonb } from "@/lib/queries-hrv";
import type { HrvInitial } from "./HrvLoader";

/* eslint-disable @typescript-eslint/no-explicit-any */

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
 * Greedy word-wrap a (display) label into up to `maxLines` lines, each kept at
 * or under `maxChars`. Unlike the previous 2-line-then-hard-truncate approach,
 * NO line is ever allowed to overflow its width budget — so a right-anchored
 * YAxis tick can't bleed off the left edge of the chart gutter and get clipped
 * (the bug that rendered "Inflammatory Drug NSAID" as "…smmatory Drug Nsa…":
 * line 2 grew unbounded, then the right-anchored text ran past the gutter and
 * lost characters off BOTH ends).
 *
 * Only the final line is ellipsized, and only when words still remain after the
 * line budget is exhausted. A single word wider than `maxChars` is hard-sliced.
 */
function wrapLabel(text: string, maxChars: number, maxLines = 3): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  let p = 0;
  while (p < words.length && lines.length < maxLines) {
    const w = words[p];
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length <= maxChars) {
      cur = candidate;
      p++;
    } else if (!cur) {
      // lone word wider than the whole line — hard-slice it onto its own line
      lines.push(w.slice(0, Math.max(1, maxChars - 1)) + "…");
      p++;
    } else {
      // commit the current line, retry this word on a fresh one
      lines.push(cur);
      cur = "";
    }
  }
  if (cur && lines.length < maxLines) { lines.push(cur); cur = ""; }
  // Words left unplaced → flag the final line as truncated (hover shows full).
  if (p < words.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.endsWith("…")
      ? last
      : (last.length >= maxChars ? last.slice(0, maxChars - 1) : last) + "…";
  }
  return lines.length ? lines : [""];
}

/**
 * Container height for a horizontal bar chart whose YAxis ticks wrap with
 * {@link wrapLabel}. Each row is sized to the deepest label so multi-line names
 * never overlap their neighbours, while charts with only short labels stay
 * compact. `maxChars` MUST match the value passed to the chart's tick so the
 * measured line count matches what actually renders.
 */
function chartHeight(
  labels: (string | undefined)[], maxChars: number, minHeight: number,
  { maxLines = 3, fontSize = 10 }: { maxLines?: number; fontSize?: number } = {}
): number {
  let deepest = 1;
  for (const l of labels) {
    deepest = Math.max(deepest, wrapLabel(prettifyLabel(String(l ?? "")), maxChars, maxLines).length);
  }
  const perRow = fontSize * (deepest >= 3 ? 3.7 : deepest === 2 ? 2.6 : 2.0);
  return Math.max(minHeight, labels.length * perRow);
}

/**
 * Wrapped YAxis tick — labels in the correlation / journal-impact charts can
 * run 30-40 chars long (e.g. "Learned Something Interesting Or Important").
 * Wraps onto up to `maxLines` lines via {@link wrapLabel} (every line within
 * the gutter width), vertically centers the block on the tick anchor, and adds
 * a <title> hover so the full label is always recoverable.
 */
function WrappedYAxisTick(
  { x, y, payload, maxCharsPerLine = 24, maxLines = 3, fontSize = 10 }: {
    x?: number; y?: number; payload?: { value?: string };
    maxCharsPerLine?: number; maxLines?: number; fontSize?: number;
  }
) {
  const display = prettifyLabel(String(payload?.value ?? ""));
  const lines = wrapLabel(display, maxCharsPerLine, maxLines);
  const lineH = fontSize * 1.15;
  // Vertically center the wrapped block on the tick's y anchor.
  const firstDy = -((lines.length - 1) / 2) * lineH + fontSize * 0.32;
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={-4}
        y={0}
        textAnchor="end"
        fill={C.axis}
        fontSize={fontSize}
        fontFamily="var(--font-mono)"
      >
        <title>{display}</title>
        {lines.map((ln, i) => (
          <tspan key={i} x={-4} dy={i === 0 ? firstDy : lineH}>{ln}</tspan>
        ))}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// Data fetching lives in lib/queries-hrv.ts (perf pass 2026-06-11) so the
// SAME functions run server-side for the ISR prefetch in page.tsx and here
// for the silent mount revalidation + range changes. loadHrvDashboard /
// loadHrvRangeDependent are the shared entry points.
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

// Custom dot for prediction vs actual line
const HrvDot = (props: any) => {
  const { cx, cy, payload } = props;
  if (!payload?.actual || !payload?.predicted) return null;
  const diff = Math.abs(payload.actual - payload.predicted);
  const color = diff > 15 ? C.down : "transparent";
  return <circle cx={cx} cy={cy} r={4} fill={color} stroke={C.down} strokeWidth={1} />;
};

// In-page section anchors — drives the sticky right-rail TOC and the
// SectionHeader ids below. Keep ids in sync with the SectionHeader id props.
const SECTIONS = [
  { id: "forecast", label: "Forecast & Drivers" },
  { id: "accuracy", label: "Model Accuracy" },
  { id: "trend", label: "HRV Trend" },
  { id: "associations", label: "Associations" },
  { id: "impact", label: "Behavior Impact" },
  { id: "supplements", label: "Supplements" },
  { id: "lifestyle", label: "Lifestyle" },
  { id: "causal", label: "Causal Inference" },
  { id: "environment", label: "Environment" },
  { id: "methods", label: "Methods & Eval" },
] as const;

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

// Default range — MUST stay in sync with page.tsx's server prefetch
// (loadHrvDashboard(rangeDays("30d"))), which produced `initial` for exactly
// this window. A mismatch would silently render wrong-window data.
const DEFAULT_RANGE: Range = "30d";

export default function HrvAnalysisPage({ initial }: { initial?: HrvInitial | null }) {
  // Server-prefetched initial data (ISR, default 30d range) seeds the charts
  // so they paint immediately; the mount effect still runs as a SILENT
  // revalidation (no skeleton) because the ISR snapshot can be up to ~1h
  // stale — single-user traffic means the morning's first visit usually
  // lands on a cache regenerated last evening.
  const [loading, setLoading] = useState(!initial);
  const [tomorrowPred, setTomorrowPred] = useState<any | null>(initial?.tomorrowPred ?? null);
  const [accuracy, setAccuracy] = useState<any[]>(initial?.accuracy ?? []);
  const [metrics, setMetrics] = useState<any[]>(initial?.metrics ?? []);
  const [historicalHrv, setHistoricalHrv] = useState<any[]>(initial?.historicalHrv ?? []);
  const [correlations, setCorrelations] = useState<any[]>(initial?.correlations ?? []);
  const [journalImpact, setJournalImpact] = useState<any[]>(initial?.journalImpact ?? []);
  const [featureImportance, setFeatureImportance] = useState<any[]>(initial?.featureImportance ?? []);
  const [residuals, setResiduals] = useState<any[]>(initial?.residuals ?? []);
  const [prophetForecast, setProphetForecast] = useState<any[]>(initial?.prophetForecast ?? []);
  const [sarimaxForecast, setSarimaxForecast] = useState<any[]>(initial?.sarimaxForecast ?? []);
  const [journalCorrelations, setJournalCorrelations] = useState<any[]>(initial?.journalCorrelations ?? []);
  const [journalShap, setJournalShap] = useState<any[]>(initial?.journalShap ?? []);
  const [habitImpact, setHabitImpact] = useState<any[]>(initial?.habitImpact ?? []);
  const [habitCorrelations, setHabitCorrelations] = useState<any[]>(initial?.habitCorrelations ?? []);
  const [habitShap, setHabitShap] = useState<any[]>(initial?.habitShap ?? []);
  const [supplementImpact, setSupplementImpact] = useState<any[]>(initial?.supplementImpact ?? []);
  const [supplementDoseResponse, setSupplementDoseResponse] = useState<any[]>(initial?.supplementDoseResponse ?? []);
  const [nutritionImpact, setNutritionImpact] = useState<any[]>(initial?.nutritionImpact ?? []);
  const [workoutGap, setWorkoutGap] = useState<WorkoutSleepGap[]>(initial?.workoutGap ?? []);
  const [causalBinary, setCausalBinary] = useState<any[]>(initial?.causalBinary ?? []);
  const [causalContinuous, setCausalContinuous] = useState<any[]>(initial?.causalContinuous ?? []);
  const [causalDag, setCausalDag] = useState<any | null>(initial?.causalDag ?? null);
  const [causalMeta, setCausalMeta] = useState<any | null>(initial?.causalMeta ?? null);
  const [causalDropped, setCausalDropped] = useState<any[]>(initial?.causalDropped ?? []);
  const [envMatrix, setEnvMatrix] = useState<any[]>(initial?.envMatrix ?? []);
  const [xgbDiagnostics, setXgbDiagnostics] = useState<any | null>(initial?.xgbDiagnostics ?? null);
  // Environment Sweet Spot dual-axis selectors. X axis is which temp sensor
  // to bucket by (Pod room vs bed surface); Y axis is which next-night
  // outcome to plot. Defaults preserve the original chart (room × HRV).
  const [envXAxis, setEnvXAxis] = useState<"room" | "bed">("room");
  const [envOutcome, setEnvOutcome] = useState<"hrv" | "recovery" | "efficiency" | "deep">("hrv");
  const [expandedEval, setExpandedEval] = useState(false);
  const [expandedModels, setExpandedModels] = useState(false);
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  // Narrow loading flag for range changes — only the 3 range-dependent series
  // refetch, and the stale charts stay visible while they do (no page-wide
  // skeleton; see the range effect below).
  const [rangeLoading, setRangeLoading] = useState(false);
  // Global FDR filter — when ON (default), every chart whose rows carry a
  // `passes_fdr` flag hides the non-survivors. BH-FDR is applied per family
  // in the pipeline (causal binary/continuous, journal/habit/supplement
  // impact, nutrition correlations); a row that fails its family's q-value
  // threshold is almost always noise dressed up as significance by the raw
  // t-test, so the safe default is "don't show it." Toggle OFF surfaces all
  // rows with non-survivors at 0.5 opacity so the contrast is still legible.
  const [fdrOnly, setFdrOnly] = useState(true);
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
  // Mobile char budgets are sized to the gutter width: a ~110px gutter at
  // fontSize 10 monospace (~6px/char) holds ~18 chars, so 17 is the safe cap
  // that leaves no line clipping while fitting one extra word per line. Paired
  // with WrappedYAxisTick's 3-line wrap, this keeps even 40-char journal labels
  // fully visible. nutri's gutter is ~100px → 15.
  const chars = {
    long:  isMobile ? 17 : 28,
    xlong: isMobile ? 17 : 30,
    corr:  isMobile ? 17 : 26,
    nutri: isMobile ? 15 : 20,
  };
  const sideMarginShort = isMobile ? 4 : 140;  // matches axisW.short when desktop
  const sideMarginMed   = isMobile ? 4 : 160;  // matches axisW.med when desktop

  const firstRunWithInitial = useRef(!!initial);
  const firstRangeRun = useRef(true);
  // Tracks the most recently requested range so the mount effect (which can
  // resolve AFTER a quick range flip's narrower fetch) knows whether it still
  // owns the 3 range-dependent state slices.
  const latestRange = useRef<Range>(DEFAULT_RANGE);

  // Mount effect: the full dashboard load (all 26 fetches via the shared
  // loadHrvDashboard — same function + args the server prefetch uses). Runs
  // exactly once. Silent when seeded from the server — no skeleton flip, the
  // ISR snapshot stays painted while fresh data swaps in underneath. When
  // initial is null (pre-ISR path) it behaves exactly as before: skeleton
  // until the first fetch resolves. The cancelled flag stops a superseded
  // slow response from committing stale state after unmount.
  useEffect(() => {
    let cancelled = false;
    const silent = firstRunWithInitial.current;
    firstRunWithInitial.current = false;
    if (!silent) setLoading(true);
    // DEFAULT_RANGE, not `range`: this effect runs once on mount, before the
    // user can possibly change the range filter (range changes are handled by
    // the narrower effect below).
    loadHrvDashboard(rangeDays(DEFAULT_RANGE))
      .then((d) => {
        if (cancelled) return;
        // The 3 range-dependent slices are guarded: if the user flipped the
        // range while this full load was in flight, the range effect below
        // owns them now — committing this default-window data would label
        // e.g. 30d points as "last 90 days" (the pre-split single effect
        // avoided this by cancelling the whole run on any range change).
        if (latestRange.current === DEFAULT_RANGE) {
          setAccuracy(d.accuracy);
          setHistoricalHrv(d.historicalHrv);
          setWorkoutGap(d.workoutGap);
        }
        setTomorrowPred(d.tomorrowPred);
        setMetrics(d.metrics);
        setCorrelations(d.correlations);
        setJournalImpact(d.journalImpact);
        setFeatureImportance(d.featureImportance);
        setJournalCorrelations(d.journalCorrelations);
        setJournalShap(d.journalShap);
        setResiduals(d.residuals);
        setProphetForecast(d.prophetForecast);
        setSarimaxForecast(d.sarimaxForecast);
        setSupplementImpact(d.supplementImpact);
        setSupplementDoseResponse(d.supplementDoseResponse);
        setNutritionImpact(d.nutritionImpact);
        setHabitImpact(d.habitImpact);
        setHabitCorrelations(d.habitCorrelations);
        setHabitShap(d.habitShap);
        setCausalBinary(d.causalBinary);
        setCausalContinuous(d.causalContinuous);
        setCausalDag(d.causalDag);
        setCausalMeta(d.causalMeta);
        setCausalDropped(d.causalDropped);
        setEnvMatrix(d.envMatrix);
        setXgbDiagnostics(d.xgbDiagnostics);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled && !silent) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Range effect: only 3 of the 26 calls actually vary with the range filter
  // (prediction accuracy window, HRV trend, workout→sleep gap), so range
  // changes refetch ONLY those and update just their state slices under the
  // narrow rangeLoading flag — the stale charts stay visible while
  // revalidating instead of flipping the page-wide skeleton. The first run
  // (mount) is skipped: the mount effect above already covers the default
  // range, and re-fetching here would duplicate the triple. The cancelled
  // flag stops a superseded slow response from overwriting a newer range's
  // data (out-of-order resolve).
  useEffect(() => {
    latestRange.current = range;
    if (firstRangeRun.current) {
      firstRangeRun.current = false;
      return;
    }
    let cancelled = false;
    setRangeLoading(true);
    loadHrvRangeDependent(rangeDays(range))
      .then((d) => {
        if (cancelled) return;
        setAccuracy(d.accuracy);
        setHistoricalHrv(d.historicalHrv);
        setWorkoutGap(d.workoutGap);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setRangeLoading(false);
      });
    return () => { cancelled = true; };
  }, [range]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------
  const todayActualHrv = historicalHrv.length ? Number(historicalHrv[historicalHrv.length - 1]?.whoop_hrv_rmssd) : null;
  const xgbMetrics = metrics.filter(m => m.model === "xgboost").sort((a, b) =>
    new Date(b.eval_date).getTime() - new Date(a.eval_date).getTime())[0];
  const naiveMetrics = metrics.find(m => m.model === "baseline_naive");

  const rawDrivers: any = tomorrowPred?.top_drivers
    ? (() => { try { return parseJsonb(tomorrowPred.top_drivers); } catch { return null; } })()
    : null;
  const topDrivers: any[] = Array.isArray(rawDrivers)
    ? rawDrivers
    : (rawDrivers?.top ?? featureImportance.map(f => ({ label: f.label, shap_value: f.importance })));
  // Today-specific signed SHAP values for journal features. Falls back to
  // historical mean-abs (unsigned) if the new payload shape isn't present.
  const journalDriversToday: any[] = Array.isArray(rawDrivers)
    ? []
    : (rawDrivers?.journal ?? []);

  // HRV trend data with 7-day rolling avg. X-axis date is the behavioral
  // day per ADR-0001 Phase 3 — pre-midnight bedtimes now plot under the
  // bedtime-day, matching the prediction/causal panels.
  const hrvValues = historicalHrv.map(d => Number(d.whoop_hrv_rmssd));
  // Percentile of tomorrow's predicted HRV within the observed range — drives the
  // WHOOP-style recovery ring (zone-colored: higher percentile = greener).
  const hrvPercentile = (() => {
    const vals = hrvValues.filter((v) => Number.isFinite(v));
    if (!tomorrowPred || !vals.length) return null;
    return Math.round((vals.filter((v) => v <= Number(tomorrowPred.predicted_hrv)).length / vals.length) * 100);
  })();
  const trendData = historicalHrv.map((d, i) => ({
    date: fmtDate(d.onyx_behavioral_date),
    hrv: Number(d.whoop_hrv_rmssd),
    rolling7: rolling7(hrvValues, i),
  }));
  // Day-context strip (weekend) aligned with trendData — derived from the date
  // itself, so no extra fetch. Richer day-context stripes (alcohol / hard-workout
  // / travel) would require adding columns to the HRV queries (a data-fetch
  // change deliberately out of scope for this frontend-only refresh).
  const trendWeekend = historicalHrv.map((d) => {
    const wd = new Date(d.onyx_behavioral_date + "T00:00:00").getDay();
    return wd === 0 || wd === 6;
  });

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
      date: fmtDate(d.onyx_behavioral_date),
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

  // MAE by horizon — all 5 multi-horizon models. Prophet writes h=1 only
  // (it's a 30-day forecaster, not a per-horizon evaluator) so it's
  // omitted from this view; see the Model Comparison table for its single
  // headline number. For each (model × h) cell we pick the *latest*
  // eval_date so a partial backfill that wrote some horizons today and
  // others yesterday still composes a coherent row.
  const HORIZON_MODELS = [
    { key: "xgboost",           label: "XGBoost",        color: C.source.garmin },
    { key: "sarimax",           label: "SARIMAX",        color: C.source.eightsleep },
    { key: "baseline_naive",    label: "Naive",          color: C.source.whoop },
    { key: "baseline_7d_avg",   label: "7d Avg",         color: C.accent },
    { key: "baseline_dow",      label: "Day-of-week",    color: C.neutral },
  ] as const;
  const horizonData = [1, 2, 3, 4, 5, 6, 7].map(h => {
    const row: Record<string, number | string | null> = { horizon: `t+${h}` };
    for (const { key } of HORIZON_MODELS) {
      const rows = metrics.filter(m => m.model === key && m.horizon_days === h);
      const latest = rows.sort((a, b) =>
        new Date(b.eval_date).getTime() - new Date(a.eval_date).getTime())[0];
      row[key] = latest?.mae != null ? Number(latest.mae) : null;
    }
    return row;
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
    <div className="xl:flex xl:gap-6 xl:items-start">
    <div className="flex-1 min-w-0 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">HRV Deep Analysis</h2>
          <p className="text-sm text-text-tertiary mt-0.5">
            Predictive modeling · Statistical drivers · {rangeLabel(range)} · {historicalHrv.length} days of data
          </p>
          <p className="text-[11px] text-text-tertiary/80 mt-1 max-w-2xl leading-relaxed">
            Driver, impact &amp; causal charts default to <span className="text-emerald-300/90">FDR-significant</span> rows
            only — relationships that hold up after correcting for the hundreds tested here. Toggle the filter to see
            everything; the full explanation is in <strong className="text-text-secondary">Models &amp; Methods</strong> at
            the bottom of the page.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setFdrOnly(v => !v)}
            title={fdrOnly
              ? "Showing only rows that survive BH-FDR per family. Click to also show non-survivors at 0.5 opacity."
              : "Showing all rows; non-FDR-significant rows are dimmed to 0.5 opacity. Click to hide them entirely."}
            className={`px-2.5 py-1 rounded-[3px] text-[11px] font-mono border transition-colors ${fdrOnly
              ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-300"
              : "border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-border-hover"}`}
          >
            FDR-significant only {fdrOnly ? "✓" : "○"}
          </button>
          {rangeLoading && (
            <span className="text-[11px] font-mono text-text-tertiary animate-pulse">updating…</span>
          )}
          <RangeFilter value={range} onChange={setRange} />
          {!hasData && (
            <div className="text-sm text-text-tertiary bg-amber-500/10 border border-amber-500/20 rounded px-3 py-1.5">
              Run <code className="font-mono text-amber-400">python hrv_analysis.py</code> to generate predictions
            </div>
          )}
        </div>
      </div>

      {/* ── Row 1: Hero KPI tiles (horizontal scroll-snap on mobile) ── */}
      <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-1 -mx-1 px-1 [scrollbar-width:none] sm:mx-0 sm:px-0 sm:grid sm:grid-cols-3 sm:gap-4 sm:overflow-visible">
        <div className="min-w-[78%] snap-start sm:min-w-0 relative bg-surface-card border border-border-subtle rounded-[4px] px-4 py-4 flex flex-col items-center">
          <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-[4px]" style={{ backgroundColor: "var(--color-accent)" }} />
          <MetricRing
            testId="hero-tomorrow-hrv"
            label="Tomorrow"
            value={hrvPercentile ?? NaN}
            zone
            centerValue={tomorrowPred ? Number(tomorrowPred.predicted_hrv).toFixed(0) : "—"}
            centerUnit="ms"
            sublabel={hrvPercentile != null ? `${hrvPercentile}th pctile` : undefined}
          />
          {tomorrowPred && (
            <p className="mt-2 text-center text-[11px] font-mono text-text-tertiary">
              80% CI {Number(tomorrowPred.prediction_lower).toFixed(0)}–{Number(tomorrowPred.prediction_upper).toFixed(0)} ms
              {todayActualHrv != null && (
                <span style={{ color: directionalColor(Number(tomorrowPred.predicted_hrv) - todayActualHrv, { favorable: "up" }) }}>
                  {" · "}{Number(tomorrowPred.predicted_hrv) > todayActualHrv ? "↑" : "↓"}{" "}
                  {Math.abs(Number(tomorrowPred.predicted_hrv) - todayActualHrv).toFixed(1)} vs today
                </span>
              )}
            </p>
          )}
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.06em] text-text-tertiary/70">XGBOOST</p>
        </div>
        <KpiTile
          className="min-w-[78%] snap-start sm:min-w-0"
          label="Model Accuracy (30d)"
          value={xgbMetrics ? Number(xgbMetrics.mae).toFixed(1) : "—"}
          unit={xgbMetrics ? "ms MAE" : undefined}
          sub={xgbMetrics?.directional_accuracy
            ? `${Number(xgbMetrics.directional_accuracy).toFixed(0)}% directional`
            : undefined}
          delta={xgbMetrics && naiveMetrics
            ? { value: Number(naiveMetrics.mae) - Number(xgbMetrics.mae), favorable: "up", suffix: "vs naive" }
            : undefined}
          meta={[{ text: "XGBOOST" }]}
        />
        <KpiTile
          className="min-w-[78%] snap-start sm:min-w-0"
          label="Top Driver Today"
          value={topDrivers[0]
            ? `${(topDrivers[0].shap_value ?? topDrivers[0].importance) > 0 ? "+" : ""}${Number(topDrivers[0].shap_value ?? topDrivers[0].importance).toFixed(1)}`
            : "—"}
          unit={topDrivers[0] ? "ms" : undefined}
          valueColor={topDrivers[0]
            ? directionalColor(Number(topDrivers[0].shap_value ?? topDrivers[0].importance), { favorable: "up" })
            : undefined}
          sub={topDrivers[0] ? topDrivers[0].label : undefined}
          meta={[{ text: "XGBOOST · SHAP" }]}
        />
      </div>

      <SectionHeader id="forecast" tick="forecast" title="Forecast & Drivers" kicker="What tomorrow looks like, and why" />
      {/* ── Forward-looking: what's predicted and why (today) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 30-Day Prophet Forecast */}
        <ChartCard collapsible title="30-Day HRV Forecast" source="PROPHET + SARIMAX"
          info="Prophet projects the next 30 days using your weekly patterns and long-term trend (orange dashed line + shaded uncertainty band — your HRV should land inside it about 4 out of 5 nights). The purple dotted line overlays SARIMAX's independent 7-day short-term forecast as a cross-check: when both models agree on the near-term, confidence is higher; when they diverge, recent dynamics look unusual.">
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={prophetData}>
              <defs>
                <linearGradient id="prophetGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.source.whoop} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={C.source.whoop} stopOpacity={0} />
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
                    fill={C.cardBg} stackId="ci" />
              <Line type="monotone" dataKey="actual" stroke={C.up} strokeWidth={2}
                    dot={false} name="Actual HRV" connectNulls />
              <Line type="monotone" dataKey="forecast" stroke={C.source.whoop} strokeWidth={2}
                    strokeDasharray="5 3" dot={false} name="Prophet" connectNulls />
              <Line type="monotone" dataKey="sarimax" stroke={C.source.eightsleep} strokeWidth={2}
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
          {xgbDiagnostics?.shap_unstable && (
            <div className="mb-3 bg-amber-500/10 border border-amber-500/30 rounded-[4px] px-3 py-2 text-[11px] leading-relaxed text-amber-200">
              <strong className="text-amber-100">High feature collinearity detected</strong>
              {xgbDiagnostics.feature_condition_number != null && (
                <> (condition number ={" "}
                <span className="font-mono">
                  {Number(xgbDiagnostics.feature_condition_number).toFixed(1)}
                </span>
                , threshold {xgbDiagnostics.threshold ?? 30})</>
              )} — SHAP attributions may over-credit one of several near-duplicate features.
              Treat similar-meaning drivers as substitutes rather than independent signals.
              A VIF prefilter would tighten the explanation.
            </div>
          )}
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
                <ReferenceLine x={0} stroke={C.zeroLine} />
                <Bar dataKey="shap_value" radius={[0, 3, 3, 0]}>
                  {topDrivers.slice(0, 10).map((d, i) => (
                    <Cell key={i}
                      fill={(d.shap_value ?? d.importance) > 0 ? C.up : C.down}
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
              Your logged Yes/No behaviors are part of the model. A <span className="text-up">green</span> bar means that behavior <em>raised</em> tomorrow&apos;s predicted HRV today; a <span className="text-down">red</span> bar means it <em>lowered</em> it. Binary features have smaller ms impact than continuous metrics but still shift the forecast.
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
                  <ReferenceLine x={0} stroke={C.zeroLine} />
                  <Bar dataKey="shap_value" radius={[0, 3, 3, 0]}>
                    {journalDriversToday.map((d, i) => (
                      <Cell key={i} fill={d.shap_value > 0 ? C.up : C.down} fillOpacity={0.85} />
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
                    <ReferenceLine x={0} stroke={C.zeroLine} />
                    <Bar dataKey="importance" radius={[0, 3, 3, 0]}>
                      {journalShap.map((d, i) => (
                        <Cell key={i} fill={C.source.eightsleep} fillOpacity={0.75} />
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
                  <ReferenceLine x={0} stroke={C.zeroLine} />
                  <Bar dataKey="importance" radius={[0, 3, 3, 0]}>
                    {habitShap.map((d, i) => (
                      <Cell key={i} fill={C.accent} fillOpacity={0.75} />
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

      <SectionHeader id="accuracy" tick="calibration" title="Model Accuracy" kicker="Backtested next-day prediction error" />
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
              <Line type="monotone" dataKey="actual" stroke={C.up} strokeWidth={2}
                    dot={false} name="Actual HRV" />
              <Line type="monotone" dataKey="predicted" stroke={C.source.garmin} strokeWidth={2}
                    dot={<HrvDot />} name="XGBoost Pred" strokeDasharray="4 2" />
            </LineChart>
          </ResponsiveContainer>
          {predActualData.length === 0 && (
            <p className="text-[11px] text-text-tertiary text-center mt-2">No backtest data yet</p>
          )}
        </ChartCard>

        {/* Accuracy by Horizon */}
        <ChartCard collapsible title="Accuracy by Forecast Horizon"
                   subtitle="MAE (ms) — lower is better · 5 models × 7 horizons"
                   info="Accuracy drops the further ahead you predict — this shows how much. Each grouped bar set is the average miss in ms for that horizon. Two real models (XGBoost, SARIMAX) sit alongside three trivial baselines: Naive (repeat yesterday), 7d Avg (last 7-day mean), and Day-of-week (same DOW last week). If the real models can't beat the cheapest baselines, they aren't actually learning anything. Prophet is excluded because it only writes h=1 — it's a long-horizon forecaster, not a per-horizon evaluator.">
          {(() => {
            const activeModels = HORIZON_MODELS.filter(m =>
              horizonData.some(d => d[m.key] != null)
            );
            if (activeModels.length === 0) {
              return (
                <div className="h-[260px] flex items-center justify-center">
                  <p className="text-[11px] text-text-tertiary">No horizon metrics yet — run hrv_analysis.py</p>
                </div>
              );
            }
            return (
              <>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={horizonData} margin={{ top: 4, right: 8, left: 0, bottom: 8 }}>
                    <CartesianGrid {...gridStyle} />
                    <XAxis dataKey="horizon" tick={axisTick}
                           label={axisLabel("forecast horizon (days)", "x")} height={50} />
                    <YAxis tick={axisTick} width={55} label={axisLabel("MAE (ms)", "y")} />
                    <Tooltip {...chartTooltip}
                             formatter={(v: any, name: any) => [
                               v == null ? "—" : `${Number(v).toFixed(1)} ms`,
                               String(name),
                             ]} />
                    <Legend wrapperStyle={legendStyle} />
                    {activeModels.map(m => (
                      <Bar key={m.key} dataKey={m.key} name={m.label}
                           fill={m.color} radius={[2, 2, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </>
            );
          })()}
        </ChartCard>
      </div>

      <SectionHeader id="trend" tick="descriptive" title="HRV Trend" />
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
            <Line type="monotone" dataKey="hrv" stroke={C.up} strokeWidth={1.5}
                  dot={false} name="WHOOP HRV" strokeOpacity={0.5} />
            <Line type="monotone" dataKey="rolling7" stroke={C.up} strokeWidth={2.5}
                  dot={false} name="7-Day Avg" />
          </LineChart>
        </ResponsiveContainer>
        {trendWeekend.length > 6 && (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="ml-[55px] mr-[5px] flex h-[6px] flex-1 overflow-hidden rounded-sm" aria-hidden>
              {trendWeekend.map((wknd, i) => (
                <div key={i} className={`flex-1 ${wknd ? "bg-accent/20" : ""}`} />
              ))}
            </div>
            <span className="shrink-0 font-mono text-[9px] text-text-tertiary">
              <span className="mr-1 inline-block h-2 w-2 translate-y-[1px] rounded-[1px] bg-accent/30" />
              weekend
            </span>
          </div>
        )}
      </ChartCard>

      <SectionHeader id="associations" tick="descriptive" title="Associations" kicker="What historically moves with your HRV" />
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
            <ResponsiveContainer width="100%" height={chartHeight(correlations.map((c: any) => c.label), chars.corr, 360)}>
              <BarChart data={correlations} layout="vertical"
                        margin={{ left: 8, right: 20, top: 4, bottom: 4 }}>
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={axisTick} domain={[-1, 1]} tickFormatter={v => v.toFixed(1)} />
                <YAxis type="category" dataKey="label" width={isMobile ? 110 : 180}
                       tick={<WrappedYAxisTick maxCharsPerLine={chars.corr} fontSize={10} />} />
                <Tooltip {...chartTooltip}
                         formatter={(v: any) => [Number(v).toFixed(3), "Spearman ρ"]} />
                <ReferenceLine x={0} stroke={C.zeroLine} />
                <Bar dataKey="spearman_r" radius={[0, 3, 3, 0]}>
                  {correlations.map((d, i) => (
                    <Cell key={i} fill={d.spearman_r > 0 ? C.up : C.down} fillOpacity={0.8} />
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
              <ResponsiveContainer width="100%" height={chartHeight(journalCorrelations.map((c: any) => c.label), chars.long, 160)}>
                <BarChart data={journalCorrelations} layout="vertical"
                          margin={{ left: 8, right: 20, top: 2, bottom: 2 }}>
                  <CartesianGrid {...gridStyle} horizontal={false} />
                  <XAxis type="number" tick={axisTick} domain={[-1, 1]} tickFormatter={v => v.toFixed(1)} />
                  <YAxis type="category" dataKey="label" width={axisW.long}
                         tick={<WrappedYAxisTick maxCharsPerLine={chars.long} fontSize={10} />} />
                  <Tooltip {...chartTooltip}
                           formatter={(v: any) => [Number(v).toFixed(3), "Spearman ρ"]} />
                  <ReferenceLine x={0} stroke={C.zeroLine} />
                  <Bar dataKey="spearman_r" radius={[0, 3, 3, 0]}>
                    {journalCorrelations.map((d, i) => (
                      <Cell key={i} fill={d.spearman_r > 0 ? C.source.eightsleep : C.categorical[3]} fillOpacity={0.75} />
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
              <ResponsiveContainer width="100%" height={chartHeight(habitCorrelations.map((c: any) => c.label), chars.long, 160)}>
                <BarChart data={habitCorrelations} layout="vertical"
                          margin={{ left: 8, right: 20, top: 2, bottom: 2 }}>
                  <CartesianGrid {...gridStyle} horizontal={false} />
                  <XAxis type="number" tick={axisTick} domain={[-1, 1]} tickFormatter={v => v.toFixed(1)} />
                  <YAxis type="category" dataKey="label" width={axisW.long}
                         tick={<WrappedYAxisTick maxCharsPerLine={chars.long} fontSize={10} />} />
                  <Tooltip {...chartTooltip}
                           formatter={(v: any) => [Number(v).toFixed(3), "Spearman ρ"]} />
                  <ReferenceLine x={0} stroke={C.zeroLine} />
                  <Bar dataKey="spearman_r" radius={[0, 3, 3, 0]}>
                    {habitCorrelations.map((d, i) => (
                      <Cell key={i} fill={d.spearman_r > 0 ? C.accent : C.categorical[6]} fillOpacity={0.75} />
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

      <SectionHeader id="impact" tick="descriptive" title="Behavior Impact" kicker="Mean next-night HRV difference (Welch's t-test)" />
      {/* ── Behavior t-tests: Journal + Habit Impact ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Journal Impact */}
        <ChartCard collapsible title="Journal Behavior Impact" subtitle="Mean HRV difference: Yes vs No"
          source="WELCH'S T-TEST"
          info="How each logged behavior affects your HRV the following night. A +15ms bar means your HRV was 15ms higher, on average, on nights after you did that thing. Green = helps recovery; red = hurts it. Method: Welch's two-sample t-test (unequal variance) on HRV distributions for Yes vs No nights. Whiskers on each bar are the 95% confidence interval — the range the true HRV difference is likely to land in; if the whiskers cross 0, the apparent effect could be noise. Tooltip shorthand: 'd' is Cohen's d (standardized effect size — the HRV gap divided by typical night-to-night HRV variability; |d|<0.2 trivial, 0.2-0.5 small, 0.5-0.8 medium, >0.8 large), 'n=Y/N' is the sample sizes (Yes-nights / No-nights) that fed the comparison.">
          {journalImpact.length > 0 ? (() => {
            const filtered = fdrOnly
              ? journalImpact.filter((d: any) => d.passes_fdr === true)
              : journalImpact;
            const ji = filtered.slice(0, 12).map((d: any) => ({
              ...d,
              displayLabel: `${d.passes_fdr ? "✓ " : ""}${d.label}`,
              errorRange: [
                Math.max(0, (d.diff_ms ?? 0) - (d.ci_low ?? 0)),
                Math.max(0, (d.ci_high ?? 0) - (d.diff_ms ?? 0)),
              ],
            }));
            if (ji.length === 0) {
              return (
                <div className="h-[260px] flex items-center justify-center px-6">
                  <p className="text-[11px] text-text-tertiary text-center leading-relaxed">
                    No journal behaviors survive BH-FDR at q&lt;0.05.{" "}
                    <button onClick={() => setFdrOnly(false)} className="text-accent hover:underline">
                      Show all
                    </button>{" "}
                    to see the unfiltered Welch ranking.
                  </p>
                </div>
              );
            }
            return (
            <ResponsiveContainer width="100%" height={chartHeight(ji.map((d: any) => d.displayLabel), chars.long, 360)}>
              <BarChart data={ji} layout="vertical"
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
                           const fdr = d.passes_fdr ? " · FDR✓" : "";
                           return [
                             `${Number(v).toFixed(1)} ms · 95% CI [${lo}, ${hi}] · d=${(d.cohen_d ?? 0).toFixed(2)} · n=${d.n_yes}/${d.n_no}${fdr}`,
                             "HRV Δ",
                           ];
                         }} />
                <ReferenceLine x={0} stroke={C.zeroLine} />
                <Bar dataKey="diff_ms" radius={[0, 3, 3, 0]}>
                  {ji.map((d: any, i: number) => (
                    <Cell key={i}
                          fill={d.diff_ms > 0 ? C.up : C.down}
                          fillOpacity={d.passes_fdr ? 0.8 : 0.5} />
                  ))}
                  <ErrorBar dataKey="errorRange" width={4} strokeWidth={1.5}
                            stroke={C.whisker} direction="x" />
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
            const filtered = fdrOnly
              ? habitImpact.filter((d: any) => d.passes_fdr === true)
              : habitImpact;
            const hi = filtered.slice(0, 12).map((d: any) => ({
              ...d,
              displayLabel: `${d.passes_fdr ? "✓ " : ""}${d.label}`,
              errorRange: [
                Math.max(0, (d.diff_ms ?? 0) - (d.ci_low ?? 0)),
                Math.max(0, (d.ci_high ?? 0) - (d.diff_ms ?? 0)),
              ],
            }));
            if (hi.length === 0) {
              return (
                <div className="h-[260px] flex items-center justify-center px-6">
                  <p className="text-[11px] text-text-tertiary text-center leading-relaxed">
                    No habits survive BH-FDR at q&lt;0.05 yet.{" "}
                    <button onClick={() => setFdrOnly(false)} className="text-accent hover:underline">
                      Show all
                    </button>{" "}
                    to see the unfiltered Welch ranking.
                  </p>
                </div>
              );
            }
            return (
            <ResponsiveContainer width="100%" height={chartHeight(hi.map((d: any) => d.displayLabel), chars.long, 260)}>
              <BarChart data={hi} layout="vertical"
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
                           const fdr = d.passes_fdr ? " · FDR✓" : "";
                           return [
                             `${Number(v).toFixed(1)} ms · 95% CI [${lo}, ${hi}] · d=${(d.cohen_d ?? 0).toFixed(2)} · n=${d.n_yes}/${d.n_no}${fdr}`,
                             "HRV Δ",
                           ];
                         }} />
                <ReferenceLine x={0} stroke={C.zeroLine} />
                <Bar dataKey="diff_ms" radius={[0, 3, 3, 0]}>
                  {hi.map((d: any, i: number) => (
                    <Cell key={i}
                          fill={d.diff_ms > 0 ? C.up : C.down}
                          fillOpacity={d.passes_fdr ? 0.8 : 0.5} />
                  ))}
                  <ErrorBar dataKey="errorRange" width={4} strokeWidth={1.5}
                            stroke={C.whisker} direction="x" />
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

      <SectionHeader id="supplements" tick="descriptive" title="Supplements" />
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
            const filtered = fdrOnly
              ? supplementImpact.filter((d: any) => d.passes_fdr === true)
              : supplementImpact;
            const si = filtered.slice(0, 14).map((d: any) => ({
              ...d,
              displayLabel: `${d.low_n ? "⚠ " : ""}${d.passes_fdr ? "✓ " : ""}${d.compound}`,
              errorRange: [
                Math.max(0, (d.diff_ms ?? 0) - (d.ci_low ?? 0)),
                Math.max(0, (d.ci_high ?? 0) - (d.diff_ms ?? 0)),
              ],
            }));
            if (si.length === 0) {
              return (
                <div className="h-[260px] flex items-center justify-center px-6">
                  <p className="text-[11px] text-text-tertiary text-center leading-relaxed">
                    No supplements survive BH-FDR at q&lt;0.05.{" "}
                    <button onClick={() => setFdrOnly(false)} className="text-accent hover:underline">
                      Show all
                    </button>{" "}
                    to see the unfiltered Welch ranking.
                  </p>
                </div>
              );
            }
            return (
            <ResponsiveContainer width="100%" height={chartHeight(si.map((d: any) => d.displayLabel), chars.long, 360)}>
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
                           const fdr = d.passes_fdr ? " · FDR✓" : "";
                           return [
                             `${Number(v).toFixed(1)} ms · 95% CI [${lo}, ${hi}] · d=${(d.cohen_d ?? 0).toFixed(2)} · n=${d.n_yes}/${d.n_no}${fdr}`,
                             "HRV Δ",
                           ];
                         }} />
                <ReferenceLine x={0} stroke={C.zeroLine} />
                <Bar dataKey="diff_ms" radius={[0, 3, 3, 0]}>
                  {si.map((d: any, i: number) => (
                    <Cell key={i} fill={d.diff_ms > 0 ? C.up : C.down}
                          fillOpacity={d.low_n ? 0.3 : (d.passes_fdr ? 0.8 : 0.5)} />
                  ))}
                  <ErrorBar dataKey="errorRange" width={4} strokeWidth={1.5}
                            stroke={C.whisker} direction="x" />
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
            {(() => {
              // dose-response rows may or may not carry passes_fdr depending
              // on pipeline version; treat missing as "FDR unknown" — when
              // the global FDR filter is ON we hide only rows that EXPLICITLY
              // failed (passes_fdr === false), so older payloads still render.
              const dr = (fdrOnly
                ? supplementDoseResponse.filter((d: any) => d.passes_fdr !== false)
                : supplementDoseResponse
              ).slice(0, 12);
              const drDecorated = dr.map((d: any) => ({
                ...d,
                displayLabel: `${d.low_n ? "⚠ " : ""}${d.passes_fdr === true ? "✓ " : ""}${d.compound}${d.unit ? ` (${d.unit})` : ""}`,
              }));
              if (drDecorated.length === 0) {
                return (
                  <p className="text-[11px] text-text-tertiary py-6 text-center px-6">
                    No dose-response rows survive BH-FDR at q&lt;0.05.{" "}
                    <button onClick={() => setFdrOnly(false)} className="text-accent hover:underline">
                      Show all
                    </button>.
                  </p>
                );
              }
              return (
                <ResponsiveContainer width="100%" height={chartHeight(drDecorated.map((d: any) => d.displayLabel), chars.xlong, 240)}>
                  <BarChart data={drDecorated} layout="vertical"
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
                               const fdr = d.passes_fdr === true ? " · FDR✓"
                                         : d.passes_fdr === false ? " · FDR✗" : "";
                               return [
                                 `${Number(v).toFixed(3)} (p=${(d.p_value ?? 0).toFixed(3)}, n=${d.n}, doses=${d.n_distinct_doses}${fdr})`,
                                 "Spearman ρ",
                               ];
                             }} />
                    <ReferenceLine x={0} stroke={C.zeroLine} />
                    <Bar dataKey="spearman_r" radius={[0, 3, 3, 0]}>
                      {drDecorated.map((d: any, i: number) => (
                        <Cell key={i} fill={d.spearman_r > 0 ? C.accent : C.source.whoop}
                              fillOpacity={d.low_n ? 0.3 : (d.passes_fdr === false ? 0.5 : 0.8)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              );
            })()}
          </ChartCard>
        )}
      </div>

      <SectionHeader id="lifestyle" tick="descriptive" title="Lifestyle" />
      {/* ── Lifestyle: Nutrition + Workout-to-Bed Gap ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Nutrition Spearman */}
        <ChartCard collapsible
          title="Nutrition Correlations"
          subtitle="Spearman ρ between daily nutrient totals and next-night HRV"
          source="SPEARMAN ρ"
          info="What it shows: how strongly each daily nutrient total moves with HRV the following morning. A bar near +1.0 means that nutrient almost always rises when your HRV rises; near −1.0 means the opposite; near 0 means no consistent link. Method: Spearman ρ — a rank-based correlation that's robust to outliers and skewed distributions; scores range −1.0 to +1.0. Rank-based so occasional restaurant blowouts don't dominate and non-linear monotonic effects still show up — e.g. sodium at 1g vs 8g. Tooltip: ρ is the correlation; p is the p-value (chance the link is random noise — <0.05 is the conventional significance threshold); n is the number of nights. BH-FDR corrected across nutrients. ⚠ marks rows with n<20 — estimates unstable. Associational, not causal."
        >
          {nutritionImpact.length > 0 ? (() => {
            const filtered = fdrOnly
              ? nutritionImpact.filter((d: any) => d.passes_fdr === true)
              : nutritionImpact;
            const ni = filtered.map((d: any) => ({
              ...d,
              displayLabel: `${d.low_n ? "⚠ " : ""}${d.passes_fdr ? "✓ " : ""}${d.label}`,
            }));
            if (ni.length === 0) {
              return (
                <div className="h-[260px] flex items-center justify-center px-6">
                  <p className="text-[11px] text-text-tertiary text-center leading-relaxed">
                    No nutrients survive BH-FDR at q&lt;0.05.{" "}
                    <button onClick={() => setFdrOnly(false)} className="text-accent hover:underline">
                      Show all
                    </button>{" "}
                    to see the unfiltered Spearman ranking.
                  </p>
                </div>
              );
            }
            return (
            <ResponsiveContainer width="100%" height={chartHeight(ni.map((d: any) => d.displayLabel), chars.nutri, 280, { fontSize: 11 })}>
              <BarChart data={ni}
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
                           const fdr = d.passes_fdr ? " · FDR✓" : "";
                           return [
                             `${Number(v).toFixed(3)} (p=${(d.p_value ?? 0).toFixed(3)}, n=${d.n}${fdr})`,
                             "Spearman ρ",
                           ];
                         }} />
                <ReferenceLine x={0} stroke={C.zeroLine} />
                <Bar dataKey="spearman_r" radius={[0, 3, 3, 0]}>
                  {ni.map((d: any, i: number) => (
                    <Cell key={i} fill={d.spearman_r > 0 ? C.up : C.down}
                          fillOpacity={d.low_n ? 0.3 : (d.passes_fdr ? 0.8 : 0.5)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            );
          })() : (
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
                  <Line type="monotone" dataKey="hrv_mean" stroke={C.up} strokeWidth={2.5}
                        dot={{ r: 5, fill: C.up }} name="Mean HRV per gap-hour bin" />
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

      <SectionHeader id="causal" tick="causal" title="Causal Inference" kicker="Adjusted effects — from association to causation" />
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
        info="Each bar is the doubly-robust AIPW estimate of the average treatment effect on tomorrow's HRV. Error bars are 95% CIs from the influence-function variance. ⚠ marks treatments with fewer than 20 days in either arm. ⊕ marks treatments where the autocorrelation-aware block-bootstrap CI is meaningfully wider than the IF CI (ratio >1.5×) — the BB CI is the more honest answer for those rows; check the tooltip. A pale-green or pale-red bar means IF said the effect is significant but the BB CI crosses zero (the temporal structure of the residuals doesn't support the IF call). Bars whose IF CI stays positive (saturated green) or negative (saturated red) are robust causal evidence under the stated confounder set. The naive estimate is in the comparison table below."
      >
        {causalBinary.length > 0 ? (() => {
          const finiteRows = causalBinary.filter((d: any) => Number.isFinite(d.aipw_ate));
          const fdrFiltered = fdrOnly
            ? finiteRows.filter((d: any) => d.passes_fdr === true)
            : finiteRows;
          const top = fdrFiltered
            .slice(0, 20)
            .map((d: any) => {
              const ratio = Number(d.aipw_bb_width_ratio);
              const bbDivergent = Number.isFinite(ratio) && ratio > 1.5;
              const bbExcludesZero = Number.isFinite(d.aipw_ci_low_bb) && Number.isFinite(d.aipw_ci_high_bb)
                ? (d.aipw_ci_low_bb > 0 || d.aipw_ci_high_bb < 0)
                : null;
              // If IF said significant but BB CI spans zero, that's the most
              // actionable disagreement — render dimmer to flag it.
              const bbHidesSig = d.significant && bbExcludesZero === false;
              return {
                ...d,
                bbDivergent,
                bbHidesSig,
                displayLabel: `${d.low_n ? "⚠ " : ""}${bbDivergent ? "⊕ " : ""}${d.passes_fdr ? "✓ " : ""}${d.label}`,
                errorRange: [
                  Math.max(0, (d.aipw_ate ?? 0) - (d.aipw_ci_low ?? 0)),
                  Math.max(0, (d.aipw_ci_high ?? 0) - (d.aipw_ate ?? 0)),
                ],
                barColor: !d.significant
                  ? C.neutral
                  : bbHidesSig
                    ? (d.aipw_ate > 0 ? C.paleUp : C.paleDown)   // pale: IF says sig, BB doesn't
                    : d.aipw_ate > 0 ? C.up : C.down,
              };
            });
          if (top.length === 0) {
            return (
              <div className="h-[260px] flex items-center justify-center px-6">
                <p className="text-[11px] text-text-tertiary text-center leading-relaxed">
                  No causal binary treatments survive BH-FDR at q&lt;0.05.{" "}
                  <button onClick={() => setFdrOnly(false)} className="text-accent hover:underline">
                    Show all
                  </button>{" "}
                  to see the unfiltered ranking (non-FDR rows at 0.5 opacity).
                </p>
              </div>
            );
          }
          return (
            <ResponsiveContainer width="100%" height={chartHeight(top.map((d: any) => d.displayLabel), chars.xlong, 420)}>
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
                           const bbCi = Number.isFinite(d.aipw_ci_low_bb) && Number.isFinite(d.aipw_ci_high_bb)
                             ? ` · BB CI [${Number(d.aipw_ci_low_bb).toFixed(1)}, ${Number(d.aipw_ci_high_bb).toFixed(1)}] (×${Number(d.aipw_bb_width_ratio).toFixed(2)})`
                             : "";
                           const ev = Number.isFinite(d.e_value) ? d.e_value.toFixed(2) : "—";
                           const fdr = d.passes_fdr ? " · FDR✓" : " · FDR✗";
                           return [
                             `${Number(v).toFixed(1)} ms — CI ${ci}${bbCi}, E-val ${ev}, n=${d.n_treated}/${d.n_control}, family=${d.family}${fdr}`,
                             "AIPW ATE",
                           ];
                         }} />
                <ReferenceLine x={0} stroke={C.zeroLine} />
                <Bar dataKey="aipw_ate" radius={[0, 3, 3, 0]}>
                  {top.map((d: any, i: number) => (
                    <Cell key={i} fill={d.barColor}
                          fillOpacity={d.low_n ? 0.3 : (d.passes_fdr ? 0.85 : 0.5)} />
                  ))}
                  <ErrorBar dataKey="errorRange" width={4} strokeWidth={1.5}
                            stroke={C.whisker} direction="x" />
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
          info="Continuous treatments (calories, strain, training load, steps) are binarized at their personal median, giving an 'above your usual' contrast that's directly comparable to the binary treatments. Same AIPW machinery, same pre-treatment confounders. ⚠ marks small-arm treatments. ⊕ marks treatments where the autocorrelation-aware block-bootstrap CI is meaningfully wider than the IF CI (ratio >1.5×) — trust the BB CI for those; check the tooltip. Pale bars = IF said significant but BB CI crosses zero (treat as inconclusive). Note that median-split loses dose information — for full dose-response curves see the Supplement Dose-Response chart above."
        >
          {causalContinuous.length > 0 ? (() => {
            const finiteRows = causalContinuous.filter((d: any) => Number.isFinite(d.aipw_ate));
            const fdrFiltered = fdrOnly
              ? finiteRows.filter((d: any) => d.passes_fdr === true)
              : finiteRows;
            const top = fdrFiltered
              .slice(0, 12)
              .map((d: any) => {
                const ratio = Number(d.aipw_bb_width_ratio);
                const bbDivergent = Number.isFinite(ratio) && ratio > 1.5;
                const bbExcludesZero = Number.isFinite(d.aipw_ci_low_bb) && Number.isFinite(d.aipw_ci_high_bb)
                  ? (d.aipw_ci_low_bb > 0 || d.aipw_ci_high_bb < 0)
                  : null;
                const bbHidesSig = d.significant && bbExcludesZero === false;
                return {
                  ...d,
                  bbDivergent,
                  bbHidesSig,
                  displayLabel: `${d.low_n ? "⚠ " : ""}${bbDivergent ? "⊕ " : ""}${d.passes_fdr ? "✓ " : ""}${d.label}`,
                  errorRange: [
                    Math.max(0, (d.aipw_ate ?? 0) - (d.aipw_ci_low ?? 0)),
                    Math.max(0, (d.aipw_ci_high ?? 0) - (d.aipw_ate ?? 0)),
                  ],
                  barColor: !d.significant
                    ? C.neutral
                    : bbHidesSig
                      ? (d.aipw_ate > 0 ? C.paleUp : C.paleDown)
                      : d.aipw_ate > 0 ? C.up : C.down,
                };
              });
            if (top.length === 0) {
              return (
                <div className="h-[260px] flex items-center justify-center px-6">
                  <p className="text-[11px] text-text-tertiary text-center leading-relaxed">
                    No continuous treatments survive BH-FDR at q&lt;0.05.{" "}
                    <button onClick={() => setFdrOnly(false)} className="text-accent hover:underline">
                      Show all
                    </button>{" "}
                    to see the unfiltered ranking.
                  </p>
                </div>
              );
            }
            return (
              <ResponsiveContainer width="100%" height={chartHeight(top.map((d: any) => d.displayLabel), chars.long, 280)}>
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
                             const bbCi = Number.isFinite(d.aipw_ci_low_bb) && Number.isFinite(d.aipw_ci_high_bb)
                               ? ` · BB CI [${Number(d.aipw_ci_low_bb).toFixed(1)}, ${Number(d.aipw_ci_high_bb).toFixed(1)}] (×${Number(d.aipw_bb_width_ratio).toFixed(2)})`
                               : "";
                             const ev = Number.isFinite(d.e_value) ? d.e_value.toFixed(2) : "—";
                             const fdr = d.passes_fdr ? " · FDR✓" : " · FDR✗";
                             return [
                               `${Number(v).toFixed(1)} ms — CI ${ci}${bbCi}, E-val ${ev}, n=${d.n_treated}/${d.n_control}${fdr}`,
                               "AIPW ATE",
                             ];
                           }} />
                  <ReferenceLine x={0} stroke={C.zeroLine} />
                  <Bar dataKey="aipw_ate" radius={[0, 3, 3, 0]}>
                    {top.map((d: any, i: number) => (
                      <Cell key={i} fill={d.barColor}
                            fillOpacity={d.low_n ? 0.3 : (d.passes_fdr ? 0.85 : 0.5)} />
                    ))}
                    <ErrorBar dataKey="errorRange" width={4} strokeWidth={1.5}
                              stroke={C.whisker} direction="x" />
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

      <SectionHeader id="environment" tick="descriptive" title="Environment" />
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
                  ? "bg-accent/15 border-accent/40 text-text-primary"
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
                  ? "bg-up/15 border-up/40 text-text-primary"
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
                  <Bar dataKey="meanY" radius={[2, 2, 0, 0]}>
                    {rows.map((r, i) => (
                      <Cell key={i}
                        fill={r.bucket === peakRow.bucket ? C.up : C.accent}
                        fillOpacity={r.n < 5 ? 0.35 : 0.85} />
                    ))}
                    <ErrorBar dataKey="sem" width={4} strokeWidth={1.5} stroke={C.source.whoop} />
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

      <SectionHeader id="methods" tick="calibration" title="Methods & Evaluation" />
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

            {/* Statistical significance / FDR — page-wide concept, explained first
                because the "FDR-significant only" toggle at the top gates most charts. */}
            <div>
              <p className="text-[10px] font-mono font-medium tracking-wider text-text-tertiary uppercase mb-3">Statistical Significance</p>
              <div className="bg-white/[0.03] rounded-[6px] p-4 space-y-2 border-l-2 border-emerald-500/40">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-text-primary">FDR-significant (Benjamini–Hochberg)</span>
                  <span className="text-[9px] font-mono text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">PAGE-WIDE FILTER</span>
                </div>
                <p className="text-[11px] text-text-tertiary leading-relaxed">
                  <strong className="text-text-secondary">The problem it solves:</strong> This page tests <em>hundreds</em> of relationships at once — every journal behavior, habit, supplement, nutrient, and causal treatment against your HRV. At the usual &ldquo;<em>p</em> &lt; 0.05&rdquo; bar, pure chance throws a false positive about 1 time in 20 — so testing ~100 behaviors hands you <em>~5 fake &ldquo;significant&rdquo; findings</em> even if nothing real were there. Chasing those is how you end up acting on noise.
                </p>
                <p className="text-[11px] text-text-tertiary leading-relaxed">
                  <strong className="text-text-secondary">What FDR does:</strong> the Benjamini–Hochberg <em>False Discovery Rate</em> correction re-weighs every raw <em>p</em>-value by how many tests were run, producing a <em>q-value</em>. <strong>q &lt; 0.05</strong> means: of all the rows flagged significant, we expect fewer than 5% to be false. A row is <strong className="text-text-secondary">FDR-significant (✓)</strong> when it clears that bar — i.e. it&apos;s still standing <em>after</em> accounting for everything else we tested, not just impressive on its own.
                </p>
                <p className="text-[11px] text-text-tertiary leading-relaxed">
                  <strong className="text-text-secondary">The toggle at the top of the page:</strong> <code className="font-mono text-[10px]">FDR-significant only</code> defaults to <strong>ON</strong> — it hides rows that look significant on a raw test but don&apos;t survive correction (almost always multiple-comparisons noise). Turn it <strong>OFF</strong> to see the full ranking, with non-survivors dimmed to 0.5 opacity and marked <code className="font-mono text-[10px]">FDR✗</code> in tooltips. Correction is applied <em>per family</em> — causal binary, causal continuous, journal impact, habit impact, supplement impact, and nutrition correlations are each corrected within themselves, so a small family isn&apos;t penalized for a large one.
                </p>
              </div>
            </div>

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
                    <span className="text-[12px] font-medium text-text-primary">Baselines &amp; MAE</span>
                    <span className="text-[9px] font-mono text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">BENCHMARKS</span>
                  </div>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">The baselines:</strong> three dumb &ldquo;models&rdquo; with no machine learning. <em>Naive</em> predicts tomorrow&apos;s HRV = today&apos;s. <em>7-day avg</em> predicts the last 7-day mean. <em>Day-of-week</em> predicts your average for that weekday. Every real model must beat all three to prove it&apos;s actually learning — if XGBoost can&apos;t outperform &ldquo;just copy yesterday,&rdquo; it isn&apos;t useful.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">MAE &amp; forecast horizon:</strong> <em>MAE</em> (mean absolute error) is the average miss in ms — lower is better. The <em>Accuracy by Forecast Horizon</em> chart plots MAE for each model at horizons <code className="font-mono text-[10px]">h=1</code> (tomorrow) through <code className="font-mono text-[10px]">h=7</code> (a week out); error naturally grows as the horizon lengthens.
                  </p>
                </div>
              </div>
            </div>

            {/* Causal inference methods */}
            <div>
              <p className="text-[10px] font-mono font-medium tracking-wider text-text-tertiary uppercase mb-3">Causal Inference</p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

                <div className="bg-white/[0.03] rounded-[6px] p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-text-primary">AIPW (Doubly Robust)</span>
                    <span className="text-[9px] font-mono text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">CAUSAL ATE</span>
                  </div>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">What it is:</strong> Every other chart here answers &ldquo;what&apos;s <em>associated</em> with my HRV?&rdquo; AIPW (Augmented Inverse-Probability Weighting) answers the harder question — &ldquo;what would change my HRV if I actually <em>intervened</em>?&rdquo; — by estimating a behavior&apos;s effect while statistically holding your confounding habits fixed.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">Why it&apos;s used:</strong> correlation conflates a behavior with everything it travels with — alcohol nights are also weekend, restaurant, and late nights, so a raw comparison blames alcohol for the whole pile. AIPW adjusts for that lifestyle clustering. &ldquo;Doubly robust&rdquo; = it combines a model for <em>which nights you do the behavior</em> with a model for <em>your HRV</em>, and stays correct if <em>either</em> one is right.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">What it produces:</strong> the <em>ATE</em> (average treatment effect) in ms — the adjusted next-night HRV change — with a 95% CI. It powers the Causal Effects charts; pale bars = the CI crosses zero (inconclusive).
                  </p>
                </div>

                <div className="bg-white/[0.03] rounded-[6px] p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-text-primary">E-value</span>
                    <span className="text-[9px] font-mono text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">SENSITIVITY</span>
                  </div>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">What it is:</strong> a robustness score for each causal estimate. It answers: &ldquo;how strong would a <em>hidden</em> factor I&apos;m not measuring have to be to fully explain this result away?&rdquo;
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">How to read it:</strong> higher = more robust. An E-value of <strong>2.5</strong> means an unmeasured confounder would have to be linked to <em>both</em> the behavior and HRV by a risk ratio of 2.5× — a large effect — to overturn the finding. An E-value near <strong>1.0</strong> means a weak lurking variable could erase it, so treat it with caution.
                  </p>
                </div>

                <div className="bg-white/[0.03] rounded-[6px] p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-text-primary">PSM &amp; Block-Bootstrap CI</span>
                    <span className="text-[9px] font-mono text-text-tertiary bg-white/5 px-1.5 py-0.5 rounded-[2px]">CROSS-CHECKS</span>
                  </div>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">PSM (Propensity Score Matching):</strong> a second, independent causal estimator that pairs each &ldquo;did-it&rdquo; night with the most similar &ldquo;didn&apos;t&rdquo; nights (1:3 nearest-neighbor on a logit propensity score) and averages the within-pair HRV gap. When PSM and AIPW agree, the causal read is more trustworthy.
                  </p>
                  <p className="text-[11px] text-text-tertiary leading-relaxed">
                    <strong className="text-text-secondary">Block-bootstrap CI:</strong> the standard CI assumes nights are independent, but HRV is autocorrelated (today resembles yesterday). The block bootstrap resamples <em>contiguous 7-day blocks</em> to respect that, giving an honest interval. The <code className="font-mono text-[10px]">⊕</code> marker flags treatments where this wider interval disagrees with the naive one — trust the block-bootstrap CI there.
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
                      <ReferenceLine x="0" stroke={C.down} strokeWidth={1.5} />
                      <Bar dataKey="count" fill={C.source.garmin} fillOpacity={0.8} />
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
                              ? C.up : C.source.whoop
                          }}>
                      {Number(xgbMetrics.ci_coverage).toFixed(0)}%
                    </span>
                    <div>
                      <p className="text-sm text-text-secondary">of actuals inside 80% CI</p>
                      <p className="text-[11px] text-text-tertiary">
                        {Number(xgbMetrics.ci_coverage) >= 75 && Number(xgbMetrics.ci_coverage) <= 85
                          ? "Well calibrated"
                          : Number(xgbMetrics.ci_coverage) < 75
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
                            style={{ color: row.model === "xgboost" ? C.up : C.neutral }}>
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
    <aside className="hidden xl:block w-[170px] shrink-0">
      <nav className="sticky top-[88px] space-y-0.5" aria-label="On this page">
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary/70 px-2 pb-1">On this page</p>
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="block px-2 py-1 text-[12px] text-text-tertiary hover:text-text-primary rounded-[3px] hover:bg-white/[0.03] transition-colors"
          >
            {s.label}
          </a>
        ))}
      </nav>
    </aside>
    </div>
  );
}
