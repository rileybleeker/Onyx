/**
 * Onyx Recharts theme — Direction A ("Terminal").
 *
 * Single source of truth for chart styling so every chart on every page pulls
 * from one place (no per-chart ad-hoc hex strings). Fonts route through the
 * `--font-mono` stack (JetBrains Mono → Geist Mono fallback). All values are
 * dark-only.
 *
 * Stable exports (consumed across the app, kept backwards-compatible):
 *   chartTooltip · axisTick · gridStyle · sourceColors · accentColor · axisLabel
 * Direction A additions:
 *   chartColors · seriesColor() · directionalColor()
 */

const MONO = "var(--font-mono)";

/* ── Core palette ─────────────────────────────────────────────────────────── */

/** The single rationed accent (cyan). */
export const accentColor = "#7DD3FC";

/** Source colors for multi-device charts (desaturated ~15% for Direction A). */
export const sourceColors = {
  garmin: "#5B8DF6",
  whoop: "#F5A623",
  eightsleep: "#9A7BFA",
  cronometer: "#22D3A6",
  spotify: "#1ED760",
} as const;

/**
 * Centralized color tokens for charts. Mirrors the CSS custom properties in
 * globals.css but as plain hex (Recharts needs concrete values, not CSS vars,
 * for SVG fills/strokes that animate).
 */
export const chartColors = {
  accent: accentColor,
  /** HRV-direction encoding — used everywhere consistently. */
  up: "#34D399",
  down: "#F87171",
  neutral: "#9AA0A6",
  /** Pale up/down — significant-by-IF but block-bootstrap CI crosses zero. */
  paleUp: "#86EFAC",
  paleDown: "#FCA5A5",
  lowConf: "rgba(154,160,166,0.45)",
  grid: "rgba(255,255,255,0.04)",
  /** Stronger-than-grid hairline for a zero reference line. */
  zeroLine: "rgba(255,255,255,0.15)",
  /** Error-bar / whisker stroke (visible but on-palette). */
  whisker: "#9AA0A6",
  /** Card body — used to mask the lower half of a stacked CI band. */
  cardBg: "#0E1014",
  axis: "#5F6368",
  /** Low-chroma categorical 8-step (habit / journal / supplement category bars). */
  categorical: [
    "#7DD3FC", "#F5A623", "#34D399", "#C084FC",
    "#F472B6", "#FBBF24", "#60A5FA", "#94A3B8",
  ],
  source: sourceColors,
  /** Section-tick colors keyed to section function. */
  tick: {
    forecast: "#7DD3FC",
    descriptive: "#9AA0A6",
    causal: "#F5A623",
    calibration: "#34D399",
  },
} as const;

/* ── Recharts style objects ──────────────────────────────────────────────── */

/** Shared Recharts tooltip style — Surface 2 card, mono numerics, 1px cyan top edge. */
export const chartTooltip = {
  contentStyle: {
    backgroundColor: "#15181E",
    border: "1px solid rgba(255,255,255,0.08)",
    borderTop: "1px solid #7DD3FC",
    borderRadius: 4,
    boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
    padding: "8px 11px",
  },
  labelStyle: { color: "#9AA0A6", fontFamily: MONO, fontSize: 11 },
  itemStyle: { color: "#E8EAED", fontFamily: MONO, fontSize: 12 },
};

/** Shared axis tick style (mono, tertiary tone). */
export const axisTick = { fill: "#5F6368", fontSize: 11, fontFamily: MONO };

/** Shared Recharts <Legend> wrapper style (mono). */
export const legendStyle = { fontSize: 11, fontFamily: MONO };

/**
 * Shared grid style. Horizontal-only is set per-call via `vertical={false}`;
 * dashed `2 4` keeps the grid quiet under dense data.
 */
export const gridStyle = {
  stroke: "#ffffff",
  strokeOpacity: 0.04,
  strokeDasharray: "2 4",
};

/**
 * Standard Recharts axis label, kerned to the Onyx aesthetic.
 *
 * Usage: <YAxis label={axisLabel("ms", "y")} /> or <XAxis label={axisLabel("hours", "x")} />.
 *
 * Skip the label entirely when the axis is self-evident (dates, hour-of-day,
 * categorical names, %), or when the chart's title/subtitle already encodes the unit.
 */
export function axisLabel(value: string, axis: "x" | "y") {
  return {
    value,
    angle: axis === "y" ? -90 : 0,
    position: axis === "y" ? ("insideLeft" as const) : ("insideBottom" as const),
    offset: axis === "y" ? 10 : -4,
    style: {
      fill: "#5F6368",
      fontSize: 10,
      fontFamily: MONO,
      textAnchor: "middle" as const,
      letterSpacing: "0.04em",
    },
  };
}

/* ── Color helpers ───────────────────────────────────────────────────────── */

/**
 * Resolve a stable color for a named series/metric. Known data sources map to
 * their source color; HRV-ish metrics get the accent; everything else falls
 * back to a deterministic categorical slot derived from the string so repeated
 * calls for the same name return the same color.
 */
export function seriesColor(metric: string): string {
  const m = metric.toLowerCase();
  if (m.includes("garmin")) return sourceColors.garmin;
  if (m.includes("whoop")) return sourceColors.whoop;
  if (m.includes("eight") || m.includes("8slp") || m.includes("8sleep")) return sourceColors.eightsleep;
  if (m.includes("cronometer") || m.includes("nutrition")) return sourceColors.cronometer;
  if (m.includes("spotify")) return sourceColors.spotify;
  if (m.includes("hrv") || m.includes("recovery") || m.includes("forecast") || m.includes("predict")) {
    return chartColors.accent;
  }
  let hash = 0;
  for (let i = 0; i < metric.length; i++) hash = (hash * 31 + metric.charCodeAt(i)) >>> 0;
  return chartColors.categorical[hash % chartColors.categorical.length];
}

/**
 * Directional color for a signed value. Positive → up-color, negative →
 * down-color, ~zero → neutral. Pass `favorable: "down"` for metrics where a
 * decrease is the good outcome (e.g. resting HR, error/MAE), which flips the
 * green/red mapping without changing the numeric sign.
 */
export function directionalColor(
  value: number,
  opts?: { favorable?: "up" | "down"; epsilon?: number },
): string {
  const eps = opts?.epsilon ?? 0;
  if (!Number.isFinite(value) || Math.abs(value) <= eps) return chartColors.neutral;
  const good = opts?.favorable === "down" ? value < 0 : value > 0;
  return good ? chartColors.up : chartColors.down;
}
