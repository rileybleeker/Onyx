"use client";

import { useEffect, useRef, useState } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, CartesianGrid, Label,
} from "recharts";
import { getHealthMatrix, rangeDays, rangeLabel, type Range } from "@/lib/queries";
import { blandAltman } from "@/lib/stats";
import { sameJson } from "@/lib/format";
import ChartCard from "@/components/ChartCard";
import RangeFilter from "@/components/RangeFilter";
import { chartTooltip, axisTick, gridStyle, axisLabel, chartColors as C } from "@/lib/chart-theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface BAResult {
  bias: number;
  sd: number;
  lowerLoA: number;
  upperLoA: number;
  points: { mean: number; diff: number }[];
  n: number;
}

const PAIRS: [string, string, string][] = [
  ["Garmin", "WHOOP", C.source.garmin],
  ["Garmin", "Eight Sleep", C.source.eightsleep],
  ["WHOOP", "Eight Sleep", C.up],
];

function fmtBA(ba: BAResult | null): string {
  if (!ba) return "Insufficient overlapping data";
  return `Bias = ${ba.bias.toFixed(1)} | LoA = [${ba.lowerLoA.toFixed(1)}, ${ba.upperLoA.toFixed(1)}] | n = ${ba.n}`;
}

function BAPlot({
  title,
  subtitle,
  result,
  color,
  unit,
}: {
  title: string;
  subtitle: string;
  result: BAResult | null;
  color: string;
  unit: string;
}) {
  if (!result) {
    return (
      <ChartCard title={title} subtitle="Insufficient overlapping data">
        <div className="flex items-center justify-center h-[260px] text-text-tertiary text-sm">
          Not enough paired observations
        </div>
      </ChartCard>
    );
  }

  const xMin = Math.min(...result.points.map((p) => p.mean));
  const xMax = Math.max(...result.points.map((p) => p.mean));
  const pad = (xMax - xMin) * 0.05 || 5;

  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={280}>
        <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 20 }}>
          <CartesianGrid {...gridStyle} />
          <XAxis
            dataKey="mean"
            type="number"
            domain={[xMin - pad, xMax + pad]}
            tick={axisTick}
            name="Mean"
            height={50}
            label={axisLabel(`mean of both devices (${unit})`, "x")}
          />
          <YAxis
            dataKey="diff"
            type="number"
            tick={axisTick}
            width={65}
            name="Difference"
            label={axisLabel(`difference (${unit})`, "y")}
          />
          <Tooltip
            {...chartTooltip}
            formatter={(value: any, name: any) => [(+value).toFixed(1), name]}
          />
          {/* Bias line */}
          <ReferenceLine y={result.bias} stroke={C.source.whoop} strokeDasharray="6 3" strokeWidth={2}>
            <Label value={`Bias ${result.bias.toFixed(1)}`} fill={C.source.whoop} fontSize={10} position="right" />
          </ReferenceLine>
          {/* Upper LoA */}
          <ReferenceLine y={result.upperLoA} stroke={C.down} strokeDasharray="4 4" strokeWidth={1.5}>
            <Label value={`+1.96 SD (${result.upperLoA.toFixed(1)})`} fill={C.down} fontSize={10} position="right" />
          </ReferenceLine>
          {/* Lower LoA */}
          <ReferenceLine y={result.lowerLoA} stroke={C.down} strokeDasharray="4 4" strokeWidth={1.5}>
            <Label value={`-1.96 SD (${result.lowerLoA.toFixed(1)})`} fill={C.down} fontSize={10} position="right" />
          </ReferenceLine>
          {/* Zero line */}
          <ReferenceLine y={0} stroke={C.zeroLine} strokeWidth={1} />
          <Scatter data={result.points} fill={color} fillOpacity={0.7} r={4} isAnimationActive={false} />
        </ScatterChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

import type { BlandAltmanInitial } from "./BlandAltmanLoader";

export default function BlandAltmanPage({ initial }: { initial?: BlandAltmanInitial | null }) {
  // Server-prefetched initial data (ISR, default 30d range) seeds the charts
  // so they paint immediately; the mount effect still runs as a SILENT
  // revalidation (no skeleton) because the ISR snapshot can be up to ~1h
  // stale — single-user traffic means the morning's first visit usually
  // lands on a cache regenerated last evening.
  const [data, setData] = useState<any[]>(initial?.data ?? []);
  const [loading, setLoading] = useState(!initial);
  const [range, setRange] = useState<Range>("30d");
  const firstRunWithInitial = useRef(!!initial);

  useEffect(() => {
    // Silent only on the very first run when seeded — range changes show the
    // loading state as before. The cancelled flag stops a superseded slow
    // response from overwriting a newer range's data (out-of-order resolve).
    let cancelled = false;
    const silent = firstRunWithInitial.current;
    firstRunWithInitial.current = false;
    if (!silent) setLoading(true);
    getHealthMatrix(rangeDays(range))
      .then((rows) => {
        if (cancelled) return;
        // sameJson bail-out: the silent revalidation's data is usually
        // byte-identical to the server-seeded state — returning the previous
        // reference lets React skip the commit (and a full chart re-render).
        setData((prev) => (sameJson(prev, rows) ? prev : rows));
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled && !silent) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [range]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-baseline justify-between mb-8">
          <div>
            <div className="h-7 w-64 bg-white/5 animate-pulse rounded-[4px]" />
            <div className="h-4 w-96 bg-white/5 animate-pulse rounded-[4px] mt-2" />
          </div>
        </div>
        <div className="h-40 bg-white/5 animate-pulse rounded-[6px]" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-[320px] bg-white/5 animate-pulse rounded-[6px]" />
          ))}
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <>
        <div className="flex flex-wrap items-end justify-between gap-3 mb-8">
          <div>
            <h2 data-testid="page-heading" className="text-[28px] font-medium text-text-primary">Bland-Altman Analysis</h2>
            <p className="text-sm text-text-tertiary mt-0.5">Method agreement analysis — {rangeLabel(range)}</p>
          </div>
          <RangeFilter value={range} onChange={setRange} />
        </div>
        <p className="text-text-tertiary">No data available. Make sure your ETL pipelines have synced data.</p>
      </>
    );
  }

  // Eight Sleep and Garmin HRV rows are dated by the WAKE-UP day, so on matrix row D they
  // describe the night before WHOOP's (row D = the sleep that closes day D). Pair each WHOOP /
  // Garmin-sleep night with the Eight Sleep + Garmin HRV values from row D+1 — the same
  // re-key hrv_alignment.realign_matrix applies in the pipeline (live check 2026-11-10:
  // Eight Sleep HRV vs WHOOP r = 0.56 same row, 0.84 one row apart; Garmin HRV 0.19 vs 0.82).
  // Rows are re-derived from the fetched range, so the newest night has no partner yet.
  const byDate = new Map<string, any>(data.map((d) => [String(d.calendar_date ?? d.onyx_behavioral_date), d]));
  const nextDay = (s: string) => {
    const t2 = new Date(s + "T00:00:00Z");
    t2.setUTCDate(t2.getUTCDate() + 1);
    return t2.toISOString().split("T")[0];
  };
  const paired = data.map((d) => {
    const n = byDate.get(nextDay(String(d.calendar_date ?? d.onyx_behavioral_date))) ?? {};
    const moved: Record<string, any> = {};
    for (const k of Object.keys(d)) {
      if (k.startsWith("eight_sleep_") || k.startsWith("garmin_hrv_")) moved[k] = n[k] ?? null;
    }
    return { ...d, ...moved };
  });

  // Extract arrays per source
  const garminSleep = paired.map((d) => d.garmin_sleep_score);
  const whoopSleep = paired.map((d) => d.whoop_sleep_performance);
  const eightSleep = paired.map((d) => d.eight_sleep_score);

  // Per-night HRV reading from each device's main-sleep session. Garmin
  // exposes weekly_avg / last_night / 5min_high / baselines on the matrix;
  // `last_night_avg_ms` is the only one that's a per-night reading directly
  // comparable to WHOOP's per-cycle hrv_rmssd_milli and Eight Sleep's avg_hrv.
  // (The view previously surfaced a `garmin_hrv` alias which was removed in
  // the c0cff10 source-prefixing pass.)
  const garminHrv = paired.map((d) => d.garmin_hrv_last_night ? +d.garmin_hrv_last_night : null);
  const whoopHrv = paired.map((d) => d.whoop_hrv_rmssd ? +d.whoop_hrv_rmssd : null);
  const eightHrv = paired.map((d) => d.eight_sleep_hrv ? +d.eight_sleep_hrv : null);

  const garminRhr = paired.map((d) => d.garmin_rhr);
  const whoopRhr = paired.map((d) => d.whoop_rhr);
  const eightHr = paired.map((d) => d.eight_sleep_hr ? +d.eight_sleep_hr : null);

  const garminResp = paired.map((d) => d.garmin_sleep_respiration ? +d.garmin_sleep_respiration : null);
  const whoopResp = paired.map((d) => d.whoop_respiratory_rate ? +d.whoop_respiratory_rate : null);
  const eightResp = paired.map((d) => d.eight_sleep_breath_rate ? +d.eight_sleep_breath_rate : null);

  // Duration pairs in MINUTES. Each side is main-session-only so naps don't
  // bias one device upward (see Notion decision record on nap-inclusion
  // convention). Garmin uses is_nap=false in the matrix; WHOOP same; Eight
  // Sleep uses the _main_sec columns added 2026-05-25.
  const garminDurMin = paired.map((d) => d.garmin_sleep_duration_sec ? +d.garmin_sleep_duration_sec / 60 : null);
  const whoopDurMin = paired.map((d) => d.whoop_sleep_duration_milli ? +d.whoop_sleep_duration_milli / 60000 : null);
  const eightDurMin = paired.map((d) => d.eight_sleep_duration_main_sec ? +d.eight_sleep_duration_main_sec / 60 : null);

  const garminDeepMin = paired.map((d) => d.garmin_deep_sleep_sec ? +d.garmin_deep_sleep_sec / 60 : null);
  const whoopDeepMin = paired.map((d) => d.whoop_deep_sleep_milli ? +d.whoop_deep_sleep_milli / 60000 : null);
  const eightDeepMin = paired.map((d) => d.eight_sleep_deep_main_sec ? +d.eight_sleep_deep_main_sec / 60 : null);

  const garminRemMin = paired.map((d) => d.garmin_rem_sleep_sec ? +d.garmin_rem_sleep_sec / 60 : null);
  const whoopRemMin = paired.map((d) => d.whoop_rem_sleep_milli ? +d.whoop_rem_sleep_milli / 60000 : null);
  const eightRemMin = paired.map((d) => d.eight_sleep_rem_main_sec ? +d.eight_sleep_rem_main_sec / 60 : null);

  const garminLightMin = paired.map((d) => d.garmin_light_sleep_sec ? +d.garmin_light_sleep_sec / 60 : null);
  const whoopLightMin = paired.map((d) => d.whoop_light_sleep_milli ? +d.whoop_light_sleep_milli / 60000 : null);
  const eightLightMin = paired.map((d) => d.eight_sleep_light_main_sec ? +d.eight_sleep_light_main_sec / 60 : null);

  // Awake keeps true zeros (a night with no recorded wake time is real data).
  const garminAwakeMin = paired.map((d) => d.garmin_awake_sec != null ? +d.garmin_awake_sec / 60 : null);
  const whoopAwakeMin = paired.map((d) => d.whoop_awake_milli != null ? +d.whoop_awake_milli / 60000 : null);
  const eightAwakeMin = paired.map((d) => d.eight_sleep_awake_main_sec != null ? +d.eight_sleep_awake_main_sec / 60 : null);

  // Compute all Bland-Altman comparisons
  const sleepBA = [
    blandAltman(garminSleep, whoopSleep),
    blandAltman(garminSleep, eightSleep),
    blandAltman(whoopSleep, eightSleep),
  ];
  const durationBA = [
    blandAltman(garminDurMin, whoopDurMin),
    blandAltman(garminDurMin, eightDurMin),
    blandAltman(whoopDurMin, eightDurMin),
  ];
  const deepBA = [
    blandAltman(garminDeepMin, whoopDeepMin),
    blandAltman(garminDeepMin, eightDeepMin),
    blandAltman(whoopDeepMin, eightDeepMin),
  ];
  const remBA = [
    blandAltman(garminRemMin, whoopRemMin),
    blandAltman(garminRemMin, eightRemMin),
    blandAltman(whoopRemMin, eightRemMin),
  ];
  const lightBA = [
    blandAltman(garminLightMin, whoopLightMin),
    blandAltman(garminLightMin, eightLightMin),
    blandAltman(whoopLightMin, eightLightMin),
  ];
  const awakeBA = [
    blandAltman(garminAwakeMin, whoopAwakeMin),
    blandAltman(garminAwakeMin, eightAwakeMin),
    blandAltman(whoopAwakeMin, eightAwakeMin),
  ];
  const hrvBA = [
    blandAltman(garminHrv, whoopHrv),
    blandAltman(garminHrv, eightHrv),
    blandAltman(whoopHrv, eightHrv),
  ];
  const rhrBA = [
    blandAltman(garminRhr, whoopRhr),
    blandAltman(garminRhr, eightHr),
    blandAltman(whoopRhr, eightHr),
  ];
  const respBA = [
    blandAltman(garminResp, whoopResp),
    blandAltman(garminResp, eightResp),
    blandAltman(whoopResp, eightResp),
  ];

  const metrics: Array<{ label: string; unit: string; results: (BAResult | null)[]; footnote?: string }> = [
    {
      label: "Sleep Score",
      unit: "%",
      results: sleepBA,
      footnote: "Eight Sleep's sleep_score is generated per-day after every session is synced, so it has indirect nap context; WHOOP sleep_performance_percentage and Garmin overall_sleep_score are main-session only. Normalization to 0-100 keeps the asymmetry small but it's not strictly apples-to-apples.",
    },
    {
      label: "Sleep Duration",
      unit: "min",
      results: durationBA,
      footnote: "All three sides are main-session only. Eight Sleep uses time_slept_main_session_seconds (Pod 4 splits multi-session days into main + naps); WHOOP and Garmin filter is_nap=false in the matrix view.",
    },
    {
      label: "Deep Sleep Duration",
      unit: "min",
      results: deepBA,
      footnote: "Deep / slow-wave duration. All three sides main-session only (deep_sleep_main_session_seconds on Eight Sleep; total_slow_wave_sleep_time_milli on WHOOP, deep_sleep_seconds on Garmin — both naturally main-only via is_nap=false in the matrix view). Each device's deep-sleep detection algorithm differs (Eight Sleep uses pressure/HRV/movement, WHOOP uses HR + accelerometer, Garmin uses optical HR + accelerometer) so bias here is expected even on perfectly aligned nights.",
    },
    {
      label: "REM Sleep Duration",
      unit: "min",
      results: remBA,
      footnote: "REM duration. Same main-only sourcing as Deep. Detection-algorithm differences are larger for REM than for Deep across consumer wearables — interpret narrow LoA as a coincidence rather than method agreement.",
    },
    {
      label: "Light Sleep Duration",
      unit: "min",
      results: lightBA,
      footnote: "Light sleep, main session only on all three sides (light_sleep_main_session_seconds on Eight Sleep). Light is the residual stage once deep and REM are classified, so it inherits both of their detection biases.",
    },
    {
      label: "Awake Time",
      unit: "min",
      results: awakeBA,
      footnote: "Time awake inside the sleep window, main session only. Devices disagree on where the window starts and ends (in-bed vs. sleep onset), which shows up here as bias more than in the stage totals.",
    },
    {
      label: "HRV",
      unit: "ms",
      results: hrvBA,
      footnote: "Each device uses a different HRV algorithm (WHOOP RMSSD, Garmin's averaged 5-min readings, Eight Sleep undocumented), so read this as 'do they track the same physiology', not a calibration.",
    },
    {
      label: "Resting Heart Rate",
      unit: "bpm",
      results: rhrBA,
      footnote: "Eight Sleep avg_heart_rate aggregates across all sessions for the day (no main-only variant in the API). WHOOP and Garmin RHR are derived from the main sleep session. Nap-heavy days may bias the Eight Sleep side.",
    },
    {
      label: "Respiratory Rate",
      unit: "br/min",
      results: respBA,
      footnote: "Same nap-inclusion asymmetry as RHR: Eight Sleep avg_breath_rate is day-wide; WHOOP / Garmin are main-session.",
    },
  ];

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-8">
        <div>
          <h2 data-testid="page-heading" className="text-[28px] font-medium text-text-primary">Bland-Altman Analysis</h2>
          <p className="text-sm text-text-tertiary mt-0.5">
            Method agreement between Garmin, WHOOP, and Eight Sleep — {rangeLabel(range)}, pairwise.
          </p>
        </div>
        <RangeFilter value={range} onChange={setRange} />
      </div>

      <div className="bg-surface-card border border-border-subtle rounded-[6px] p-5 mb-8 text-sm text-text-secondary space-y-3 max-w-3xl">
        <p>
          <span className="text-text-primary font-medium">What is Bland-Altman?</span>{" "}
          A Bland-Altman plot tests whether two devices <em>agree</em> on the same measurement — not just whether they correlate.
          Two devices can be perfectly correlated (r = 1.0) yet still disagree if one consistently reads higher.
          Each dot plots <span className="text-text-primary">the difference</span> (Device A − Device B) against{" "}
          <span className="text-text-primary">the mean</span> of both readings for that day.
        </p>
        <p>
          <span className="text-amber-400 font-medium">Bias</span> (amber line) is the average difference between two devices.
          A bias of 0 means no systematic offset. Positive bias means Device A reads higher on average;
          negative means Device B reads higher. Small bias = the devices are calibrated similarly.
        </p>
        <p>
          <span className="text-red-400 font-medium">Limits of Agreement</span> (red dashed lines) mark the range where 95% of day-to-day differences fall (bias ± 1.96 × SD).
          Narrow LoA = devices give similar readings on any given day.
          Wide LoA = even if the average bias is small, individual readings can differ substantially.
        </p>
        <p>
          <span className="text-text-primary font-medium">What to look for:</span>{" "}
          Dots should be randomly scattered with no pattern. A fan/funnel shape means the devices diverge more at higher or lower values (proportional bias).
          If most dots cluster near the zero line with narrow LoA, the devices are effectively interchangeable for that metric.
        </p>

        <div className="border-t border-border-subtle pt-3">
          <p className="text-text-primary font-medium mb-2">Interpretation guide</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-text-tertiary uppercase text-[10px] font-mono tracking-wider">
                <th className="text-left py-1 font-medium">Metric</th>
                <th className="text-center py-1 font-medium">Excellent bias</th>
                <th className="text-center py-1 font-medium">Moderate bias</th>
                <th className="text-center py-1 font-medium">Poor bias</th>
                <th className="text-center py-1 font-medium">Tight LoA width</th>
              </tr>
            </thead>
            <tbody className="text-text-secondary">
              <tr className="border-t border-white/5">
                <td className="py-1.5">Sleep Score (%)</td>
                <td className="text-center text-green-400 font-mono">&lt; 5 pts</td>
                <td className="text-center text-amber-400 font-mono">5 – 10 pts</td>
                <td className="text-center text-red-400 font-mono">&gt; 10 pts</td>
                <td className="text-center font-mono">± 10 pts</td>
              </tr>
              <tr className="border-t border-white/5">
                <td className="py-1.5">HRV (ms)</td>
                <td className="text-center text-green-400 font-mono">&lt; 5 ms</td>
                <td className="text-center text-amber-400 font-mono">5 – 15 ms</td>
                <td className="text-center text-red-400 font-mono">&gt; 15 ms</td>
                <td className="text-center font-mono">± 15 ms</td>
              </tr>
              <tr className="border-t border-white/5">
                <td className="py-1.5">Resting HR (bpm)</td>
                <td className="text-center text-green-400 font-mono">&lt; 2 bpm</td>
                <td className="text-center text-amber-400 font-mono">2 – 5 bpm</td>
                <td className="text-center text-red-400 font-mono">&gt; 5 bpm</td>
                <td className="text-center font-mono">± 5 bpm</td>
              </tr>
              <tr className="border-t border-white/5">
                <td className="py-1.5">Respiratory Rate (br/min)</td>
                <td className="text-center text-green-400 font-mono">&lt; 1 br/min</td>
                <td className="text-center text-amber-400 font-mono">1 – 2 br/min</td>
                <td className="text-center text-red-400 font-mono">&gt; 2 br/min</td>
                <td className="text-center font-mono">± 2 br/min</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {metrics.map((metric) => (
        <div key={metric.label} className="mb-8">
          <h3 className="text-lg font-semibold text-text-primary mb-1">{metric.label}</h3>
          {metric.footnote && (
            <p className="text-[11px] text-text-tertiary leading-relaxed mb-3 max-w-3xl">
              {metric.footnote}
            </p>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {PAIRS.map(([a, b, color], i) => (
              <BAPlot
                key={`${metric.label}-${a}-${b}`}
                title={`${a} vs ${b}`}
                subtitle={fmtBA(metric.results[i])}
                result={metric.results[i]}
                color={color}
                unit={metric.unit}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
