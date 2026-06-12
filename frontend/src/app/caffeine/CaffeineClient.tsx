"use client";

import { useEffect, useRef, useState } from "react";
import {
  BarChart, Bar,
  LineChart, Line,
  ScatterChart, Scatter,
  XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
  ReferenceLine,
} from "recharts";
import {
  getCaffeineDaily,
  getCaffeineDataQuality,
  getCaffeineHrvPairs,
  type CaffeineDailyRow,
  type CaffeineHrvPair,
  type CaffeineQualityFlag,
} from "@/lib/queries";
import { formatDate, formatDuration, sameJson } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import { chartTooltip, axisTick, gridStyle, axisLabel, chartColors as C } from "@/lib/chart-theme";

const legendStyle = { fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" };

// FDA guidance: up to 400 mg/day is generally not associated with negative
// effects for healthy adults. Rendered as a ReferenceLine on the mg chart.
const FDA_DAILY_MG = 400;
// Common sleep-hygiene guideline: no caffeine within 6h of bedtime.
const BEDTIME_GAP_GUIDELINE_MIN = 360;

// Stacked-channel colors: dietary tracks the Cronometer source color; the
// supplement channel uses the categorical purple (distinct from every source).
const DIETARY_COLOR = C.source.cronometer;
const SUPPLEMENT_COLOR = C.categorical[3];

// Data-quality flag chips (pds.caffeine_data_quality). Journal-comparison
// flags removed 2026-06-10 — the WHOOP caffeine checkbox is disregarded by
// policy; the logged record (Cronometer + supplements) is the only source.
const QUALITY_FLAG_LABEL: Record<string, string> = {
  untrusted_timestamps: "retro-log",
  possible_double_log: "double log?",
};
const QUALITY_FLAG_STYLE: Record<string, string> = {
  untrusted_timestamps: "text-amber-300 border-amber-500/40",
  possible_double_log: "text-red-300 border-red-500/40",
};

/** YYYY-MM-DD string `days` before `anchor`, for slicing daily rows client-side.
 * Anchored to the latest behavioral row (not the browser clock) so KPI windows
 * have a fixed membership all day and in every viewer timezone — a browser-UTC
 * "today" includes 8 behavioral dates until ~8 PM ET, inflating a /7 average. */
function daysBefore(anchor: string, days: number): string {
  const [y, m, d] = anchor.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().split("T")[0];
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};

/**
 * Render an ET decimal hour as a clock time, e.g. 11.38 → "11:23 AM".
 * Hours ≥ 24 are post-midnight doses on a window that crosses midnight —
 * rendered with a "+1" day marker (e.g. 25.5 → "1:30 AM +1").
 */
function fmtClock(h: number): string {
  const nextDay = h >= 24;
  const hh24 = ((Math.floor(h) % 24) + 24) % 24;
  let mm = Math.round((h - Math.floor(h)) * 60);
  let hour = hh24;
  if (mm === 60) { mm = 0; hour = (hour + 1) % 24; }
  const ampm = hour >= 12 ? "PM" : "AM";
  const hr12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hr12}:${mm.toString().padStart(2, "0")} ${ampm}${nextDay ? " +1" : ""}`;
}

/** Axis tick for the hour-of-day axis: 0 → "12am", 13 → "1pm", 24 → "12am +1". */
function fmtHourTick(h: number): string {
  const hh = ((h % 24) + 24) % 24;
  const ampm = hh >= 12 ? "pm" : "am";
  const hr12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${hr12}${ampm}${h >= 24 ? " +1" : ""}`;
}

import type { CaffeineInitial } from "./CaffeineLoader";

export default function CaffeinePage({ initial }: { initial?: CaffeineInitial | null }) {
  // Server-prefetched initial data (ISR, fixed 60/90/45-day windows) seeds the
  // charts so they paint immediately; the mount effect still runs as a SILENT
  // revalidation (no skeleton) because the ISR snapshot can be up to ~1h
  // stale — single-user traffic means the morning's first visit usually
  // lands on a cache regenerated last evening.
  const [daily, setDaily] = useState<CaffeineDailyRow[]>(initial?.daily ?? []);
  const [hrvPairs, setHrvPairs] = useState<CaffeineHrvPair[]>(initial?.hrvPairs ?? []);
  const [quality, setQuality] = useState<CaffeineQualityFlag[]>(initial?.quality ?? []);
  const [loading, setLoading] = useState(!initial);
  const firstRunWithInitial = useRef(!!initial);

  useEffect(() => {
    // Silent only on the very first run when seeded — there is no range
    // picker on this page, so this effect runs exactly once with the fixed
    // windows. The cancelled flag stops an unmounted/superseded run from
    // committing stale state.
    let cancelled = false;
    const silent = firstRunWithInitial.current;
    firstRunWithInitial.current = false;
    if (!silent) setLoading(true);
    Promise.all([getCaffeineDaily(60), getCaffeineHrvPairs(90), getCaffeineDataQuality(45)])
      .then(([d, p, q]) => {
        if (cancelled) return;
        // sameJson bail-out: the silent revalidation's data is usually
        // byte-identical to the server-seeded state — returning the previous
        // reference lets React skip the commit (and a full chart re-render).
        setDaily((prev) => (sameJson(prev, d) ? prev : d));
        setHrvPairs((prev) => (sameJson(prev, p) ? prev : p));
        setQuality((prev) => (sameJson(prev, q) ? prev : q));
      })
      .catch((err) => console.error("Caffeine page load:", err))
      .finally(() => {
        if (!cancelled && !silent) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // ─── KPI derivations ────────────────────────────────────────────────────
  const latest = daily[daily.length - 1];
  const latestTotal = num(latest?.total_caffeine_mg);
  const latestDietary = num(latest?.dietary_caffeine_mg) ?? 0;
  const latestSupplement = num(latest?.supplement_caffeine_mg) ?? 0;

  // 7-day average counts caffeine-free days as 0 mg (within the quantitative
  // era a missing row means "no caffeine logged", not "unknown") — so the
  // number is comparable to the FDA per-day guidance. Window = the 7 dates
  // ending at the latest behavioral row (anchor-6 .. anchor).
  const anchorDate = latest?.calendar_date;
  const last7 = anchorDate
    ? daily.filter((d) => d.calendar_date >= daysBefore(anchorDate, 6))
    : [];
  const sevenDayAvg = last7.reduce((s, d) => s + (num(d.total_caffeine_mg) ?? 0), 0) / 7;

  // Avg last-dose→bedtime gap over the last 30 dates, nulls excluded (days
  // without a trusted last-dose timestamp or without a paired sleep onset).
  const gapVals = (anchorDate
    ? daily.filter((d) => d.calendar_date >= daysBefore(anchorDate, 29))
    : []
  )
    .map((d) => num(d.last_caffeine_to_bedtime_minutes))
    .filter((v): v is number => v != null);
  const avgGapMin = gapVals.length
    ? gapVals.reduce((a, b) => a + b, 0) / gapVals.length
    : null;

  const latestAtBedtime = num(latest?.caffeine_mg_at_bedtime);

  // ─── Chart data ─────────────────────────────────────────────────────────
  const mgData = daily.map((d) => ({
    date: formatDate(d.calendar_date),
    dietary: Math.round(num(d.dietary_caffeine_mg) ?? 0),
    supplement: Math.round(num(d.supplement_caffeine_mg) ?? 0),
  }));

  // Floating-range bars: transparent base up to the first dose, visible bar
  // spanning the window. Single-dose days (window null) get a thin sliver so
  // the dose time is still visible. Windows that cross midnight extend past 24
  // (first 11 PM → last 12:01 AM renders 23.0→24.02), which keeps the bar
  // contiguous instead of wrapping to the bottom of the axis.
  const windowData = daily
    .filter((d) => num(d.first_caffeine_hour) != null)
    .map((d) => {
      const firstRaw = num(d.first_caffeine_hour)!;
      // Awake-tail normalization: a day whose FIRST trusted dose lands
      // post-midnight (<5 AM) belongs past 12am at the top of the axis,
      // mirroring the −6h behavioral-day rule — not at the axis bottom.
      const first = firstRaw < 5 ? firstRaw + 24 : firstRaw;
      const window = num(d.caffeine_window_hours);
      return {
        date: formatDate(d.calendar_date),
        // 2-decimal base: toFixed(1) rounded a 23.98 first dose to 24.0,
        // picking up a false "+1 day" clock label. Visible window floored at
        // the 0.2 h sliver so sub-3-minute multi-dose windows stay hoverable
        // (toFixed(1) used to collapse them to a zero-height bar).
        base: +first.toFixed(2),
        window: +Math.max(window ?? 0.2, 0.2).toFixed(2),
      };
    });
  const windowYMax = Math.max(24, Math.ceil(Math.max(0, ...windowData.map((d) => d.base + d.window))));

  const gapData = daily.map((d) => {
    const gap = num(d.last_caffeine_to_bedtime_minutes);
    return {
      date: formatDate(d.calendar_date),
      gap_min: gap != null ? Math.round(gap) : null,
    };
  });

  const scatterData = hrvPairs.map((p) => ({
    date: formatDate(p.calendar_date),
    caffeine_mg: Math.round(Number(p.caffeine_total_mg)),
    hrv: +Number(p.whoop_hrv_rmssd).toFixed(1),
  }));

  // Two-group comparison: mean next-night HRV when the last dose landed <6h
  // before bed vs ≥6h. Rows without a trusted bedtime gap are excluded.
  const lateGroup = hrvPairs.filter(
    (p) => p.caffeine_to_bedtime_min != null && Number(p.caffeine_to_bedtime_min) < BEDTIME_GAP_GUIDELINE_MIN
  );
  const earlyGroup = hrvPairs.filter(
    (p) => p.caffeine_to_bedtime_min != null && Number(p.caffeine_to_bedtime_min) >= BEDTIME_GAP_GUIDELINE_MIN
  );
  const meanHrv = (rows: CaffeineHrvPair[]) =>
    rows.length ? rows.reduce((s, p) => s + Number(p.whoop_hrv_rmssd), 0) / rows.length : null;
  const lateMean = meanHrv(lateGroup);
  const earlyMean = meanHrv(earlyGroup);
  const smallN = lateGroup.length < 10 || earlyGroup.length < 10;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Caffeine</h2>
          <p className="text-sm text-text-tertiary mt-0.5">
            Intake, timing windows &amp; next-night HRV — supplements + Cronometer dietary — last 60 days
          </p>
        </div>
      </div>

      <p className="text-[11px] text-text-tertiary leading-relaxed border-l-2 border-amber-500/30 pl-3 mb-8">
        <span className="text-text-secondary">Coverage note:</span> Quantitative caffeine tracking
        began 2026-05-19 (timestamped supplement doses) and 2026-05-31 (Cronometer dietary
        caffeine), so these charts cover the recent era only. The logged record is the sole
        caffeine source — the WHOOP journal&apos;s yes/no caffeine question is disregarded by
        policy (it proved unreliable). The FDA&apos;s 400 mg/day guidance is marked on the
        intake chart.
      </p>

      {loading ? (
        <div className="space-y-6">
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
      ) : daily.length === 0 ? (
        <div className="bg-surface-card border border-border-subtle rounded-[6px] p-8 text-center">
          <p className="text-[13px] text-text-secondary">No caffeine days in the database yet.</p>
          <p className="text-[11px] text-text-tertiary mt-2 font-mono">
            Log a caffeine supplement on /supplements or import a Cronometer export with caffeinated food.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* ─── KPI row ─────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Latest Day"
              value={latestTotal != null ? Math.round(latestTotal) : null}
              unit="mg"
              sublabel={
                latest
                  ? `diet ${Math.round(latestDietary)} · supp ${Math.round(latestSupplement)} mg · ${formatDate(latest.calendar_date)}`
                  : undefined
              }
            />
            <StatCard
              label="7d Avg"
              value={Math.round(sevenDayAvg)}
              unit="mg"
              sublabel="per day · caffeine-free days count as 0"
            />
            <StatCard
              label="Last Dose → Bed"
              value={avgGapMin != null ? formatDuration(Math.round(avgGapMin) * 60) : "—"}
              sublabel={
                avgGapMin != null
                  ? `avg of ${gapVals.length} timed days · last 30d`
                  : "no trusted-timestamp days · last 30d"
              }
            />
            <StatCard
              label="At Bedtime"
              value={latestAtBedtime != null ? Math.round(latestAtBedtime) : "—"}
              unit={latestAtBedtime != null ? "mg" : undefined}
              sublabel={
                latestAtBedtime != null
                  ? `5h half-life residual · ${formatDate(latest.calendar_date)}`
                  : latest && num(latest.timed_event_count) === num(latest.caffeine_intake_count)
                    ? "awaiting tonight's scored sleep"
                    : "needs trusted timestamps on every dose"
              }
            />
          </div>

          {/* ─── Daily intake, stacked by channel ────────────────────────── */}
          <ChartCard
            title="Daily Caffeine Intake"
            subtitle="mg per behavioral day, dietary (Cronometer) vs supplement (Onyx) stacked · last 60 days"
            source="CRONOMETER + SUPPLEMENTS"
            info="Days with no logged caffeine are omitted (no row in the view). The amber line is the FDA's 400 mg/day guidance for healthy adults."
          >
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={mgData} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                <YAxis tick={axisTick} width={50} label={axisLabel("mg", "y")} />
                <Tooltip {...chartTooltip} />
                <Legend wrapperStyle={legendStyle} />
                <ReferenceLine
                  y={FDA_DAILY_MG}
                  stroke={C.source.whoop}
                  strokeDasharray="4 4"
                  label={{ value: "FDA 400 mg/day", fill: C.source.whoop, fontSize: 10, position: "insideTopRight" }}
                />
                <Bar dataKey="dietary" stackId="mg" fill={DIETARY_COLOR} name="Dietary (mg)" isAnimationActive={false} />
                <Bar dataKey="supplement" stackId="mg" fill={SUPPLEMENT_COLOR} name="Supplement (mg)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* ─── Caffeine window (floating range bars) ───────────────────── */}
          <ChartCard
            title="Caffeine Window"
            subtitle="first dose → last dose per day (ET hour of day) · trusted-timestamp events only"
            source="SUPPLEMENTS + CRONOMETER"
            info="Each bar spans first to last dose. Single-dose days render a thin tick at the dose time. Bars extending past 12am mark windows that cross midnight (a post-midnight dose still belongs to the previous behavioral day)."
          >
            {windowData.length === 0 ? (
              <p className="text-[11px] text-text-tertiary font-mono py-12 text-center">
                No trusted-timestamp doses in this range.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={windowData} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                  <YAxis
                    tick={axisTick}
                    width={56}
                    domain={[0, windowYMax]}
                    ticks={[0, 4, 8, 12, 16, 20, 24].filter((t) => t <= windowYMax)}
                    tickFormatter={fmtHourTick}
                  />
                  <Tooltip
                    {...chartTooltip}
                    formatter={(value, name) => {
                      if (typeof value !== "number") return [String(value), name];
                      if (name === "First dose") return [fmtClock(value), name];
                      return [`${value.toFixed(1)} h`, name];
                    }}
                  />
                  <Legend wrapperStyle={legendStyle} />
                  {/* Transparent base lifts the visible bar to the first-dose hour. */}
                  <Bar dataKey="base" stackId="window" fill="transparent" name="First dose" legendType="none" isAnimationActive={false} />
                  <Bar dataKey="window" stackId="window" fill={C.accent} fillOpacity={0.75} name="Window (h)" radius={[2, 2, 2, 2]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </ChartCard>

          {/* ─── Last dose → bedtime gap ─────────────────────────────────── */}
          <ChartCard
            title="Last Dose → Bedtime Gap"
            subtitle="minutes between the last trusted-timestamp dose and sleep onset · higher is better"
            source="SUPPLEMENTS + CRONOMETER + WHOOP"
            info="The amber line marks the common 'no caffeine within 6h of bed' guideline (360 min). Gaps require a trusted dose timestamp and a paired sleep onset — days without either are skipped."
          >
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={gapData} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="date" tick={axisTick} interval="preserveStartEnd" />
                <YAxis tick={axisTick} width={56} label={axisLabel("min", "y")} />
                <Tooltip {...chartTooltip} />
                <ReferenceLine
                  y={BEDTIME_GAP_GUIDELINE_MIN}
                  stroke={C.source.whoop}
                  strokeDasharray="4 4"
                  label={{ value: "6h guideline", fill: C.source.whoop, fontSize: 10, position: "insideTopRight" }}
                />
                <Line
                  type="monotone"
                  dataKey="gap_min"
                  stroke={C.accent}
                  strokeWidth={2}
                  dot={{ r: 3, fill: C.accent }}
                  name="Gap (min)"
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* ─── Caffeine × HRV ──────────────────────────────────────────── */}
          <section className="space-y-4">
            <div className="border-l-2 border-accent/40 pl-3">
              <h3 className="text-[14px] font-medium text-text-primary">Caffeine × HRV</h3>
              <p className="text-[11px] text-text-tertiary mt-0.5">
                Each day&apos;s caffeine paired with the HRV scored from the night that closes it —
                i.e. the <span className="text-text-secondary">next-night HRV</span> relative to
                that day&apos;s intake (matrix same-row semantics).
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ChartCard
                title="Total Caffeine vs Next-Night HRV"
                subtitle="one point per day · last 90 days"
                source="SUPPLEMENTS + CRONOMETER + WHOOP"
                confidence={{ n: scatterData.length }}
              >
                {scatterData.length === 0 ? (
                  <p className="text-[11px] text-text-tertiary font-mono py-12 text-center">
                    No days with both caffeine mg and a scored next-night HRV yet.
                  </p>
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <ScatterChart margin={{ top: 8, right: 8, left: 4, bottom: 20 }}>
                      <CartesianGrid {...gridStyle} />
                      <XAxis
                        type="number"
                        dataKey="caffeine_mg"
                        name="Caffeine (mg)"
                        tick={axisTick}
                        height={45}
                        label={axisLabel("caffeine (mg)", "x")}
                      />
                      <YAxis
                        type="number"
                        dataKey="hrv"
                        name="Next-night HRV (ms)"
                        tick={axisTick}
                        width={56}
                        domain={["auto", "auto"]}
                        label={axisLabel("next-night HRV (ms)", "y")}
                      />
                      <Tooltip {...chartTooltip} cursor={{ strokeDasharray: "3 3" }} />
                      <Scatter data={scatterData} fill={C.accent} fillOpacity={0.8} name="day" isAnimationActive={false} />
                    </ScatterChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>

              <ChartCard
                title="Late vs Early Last Dose"
                subtitle="mean next-night HRV by last-dose→bedtime gap · last 90 days"
                source="SUPPLEMENTS + CRONOMETER + WHOOP"
              >
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-black/20 border border-border-subtle rounded-[4px] p-4">
                    <p className="text-[10px] text-text-tertiary font-medium uppercase tracking-[0.1em]">
                      &lt;6h before bed
                    </p>
                    <p className="text-[28px] leading-none font-display text-text-primary tabular-nums mt-1.5">
                      {lateMean != null ? lateMean.toFixed(1) : "—"}
                      {lateMean != null && <span className="text-xs font-normal text-text-secondary ml-1.5">ms</span>}
                    </p>
                    <p className="text-[11px] text-text-tertiary mt-1.5 font-mono">n={lateGroup.length}</p>
                  </div>
                  <div className="bg-black/20 border border-border-subtle rounded-[4px] p-4">
                    <p className="text-[10px] text-text-tertiary font-medium uppercase tracking-[0.1em]">
                      ≥6h before bed
                    </p>
                    <p className="text-[28px] leading-none font-display text-text-primary tabular-nums mt-1.5">
                      {earlyMean != null ? earlyMean.toFixed(1) : "—"}
                      {earlyMean != null && <span className="text-xs font-normal text-text-secondary ml-1.5">ms</span>}
                    </p>
                    <p className="text-[11px] text-text-tertiary mt-1.5 font-mono">n={earlyGroup.length}</p>
                  </div>
                </div>
                {smallN && (
                  <p className="text-[10px] text-amber-300/80 leading-relaxed mt-3 border-l-2 border-amber-500/40 pl-2">
                    Small sample — at least one group has n&lt;10, so this comparison is descriptive
                    only. It firms up as timed caffeine history accumulates.
                  </p>
                )}
                <p className="text-[10px] text-text-tertiary leading-relaxed mt-3">
                  Days without a trusted last-dose timestamp are excluded. Unadjusted means — for
                  confounder-adjusted caffeine effects see the causal layer on /analytics/hrv.
                </p>
              </ChartCard>
            </div>
          </section>

          {/* ─── Data quality ─────────────────────────────────────────────── */}
          <ChartCard
            title="Data Quality"
            subtitle="retro-logged timestamps + cross-channel double-log checks · last 45 days"
            source="CRONOMETER + SUPPLEMENTS"
            info="Each flag marks a day worth a second look — resolving them sharpens every chart above and the HRV analysis. Retro-logs keep their mg but their timestamps are quarantined from timing features."
          >
            {quality.length === 0 ? (
              <p className="text-[11px] text-text-tertiary font-mono py-6 text-center">
                No data-quality flags in the last 45 days.
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {quality.map((q) => (
                  <li key={`${q.behavioral_date}-${q.flag}`} className="py-2.5 flex items-start gap-3">
                    <span className="text-[11px] font-mono text-text-secondary shrink-0 w-[72px]">
                      {formatDate(q.behavioral_date)}
                    </span>
                    <span
                      className={`text-[9px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded-[3px] border shrink-0 ${
                        QUALITY_FLAG_STYLE[q.flag] ?? "text-text-tertiary border-border-subtle"
                      }`}
                    >
                      {QUALITY_FLAG_LABEL[q.flag] ?? q.flag}
                    </span>
                    <span className="text-[11px] text-text-tertiary leading-relaxed">{q.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </ChartCard>
        </div>
      )}
    </>
  );
}
