/**
 * Onyx Recharts theme — Direction D ("Instrument").
 *
 * Single source of truth for chart styling so every chart on every page pulls
 * from one place (no per-chart ad-hoc hex strings). Fonts route through the
 * `--font-mono` stack (DM Mono). All values are dark-only and mirror the
 * tokens in app/globals.css.
 *
 * Stable exports (consumed across the app, kept backwards-compatible):
 *   chartTooltip · axisTick · gridStyle · sourceColors · accentColor · axisLabel
 * Direction A additions:
 *   chartColors · seriesColor() · directionalColor()
 */

const MONO = "var(--font-mono)";

/* ── Core palette ─────────────────────────────────────────────────────────── */

/** The single rationed accent — signal orange. */
export const accentColor = "#FF6A1A";

/**
 * Source colors for multi-device charts. Garmin / WHOOP / Eight Sleep are the
 * slots that appear together; that trio passes the color-vision checks for every
 * pair on the card surface. Cronometer and Spotify are charted on their own.
 */
export const sourceColors = {
  garmin: "#3987E5",
  whoop: "#C98500",
  eightsleep: "#199E70",
  cronometer: "#9085E9",
  spotify: "#1ED760",
} as const;

/**
 * Centralized color tokens for charts. Mirrors the CSS custom properties in
 * globals.css but as plain hex (Recharts needs concrete values, not CSS vars,
 * for SVG fills/strokes that animate).
 */
export const chartColors = {
  accent: accentColor,
  /** WHOOP zone encoding — green / yellow / red, used everywhere consistently. */
  up: "#5BC46E",
  down: "#F0584E",
  mid: "#F4C84E",
  neutral: "#B0AEA6",
  /** WHOOP strain — blue 0–21 scale (kept distinct from the recovery zones). */
  strain: "#6FA8DC",
  strainBright: "#8DBDE8",
  /** Pale up/down — significant-by-IF but block-bootstrap CI crosses zero. */
  paleUp: "#A7DDB0",
  paleDown: "#F6A49D",
  lowConf: "rgba(176,174,166,0.45)",
  grid: "rgba(236,235,230,0.05)",
  /** Stronger-than-grid hairline for a zero reference line. */
  zeroLine: "rgba(236,235,230,0.18)",
  /** Error-bar / whisker stroke (visible but on-palette). */
  whisker: "#B0AEA6",
  /** Card body — used to mask the lower half of a stacked CI band. */
  cardBg: "#232321",
  axis: "#97958D",
  /**
   * Categorical 8-step (habit / journal / supplement category bars), assigned in
   * this order. Validated on the card surface: lightness band, chroma, adjacent
   * color-vision separation and contrast all pass. No red slot: red means "bad".
   */
  categorical: [
    "#3987E5", "#D95926", "#199E70", "#C98500",
    "#D55181", "#008300", "#9085E9", "#B8862F",
  ],
  source: sourceColors,
  /** Section-tick colors keyed to section function. */
  tick: {
    forecast: "#6FA8DC",
    descriptive: "#B0AEA6",
    causal: "#C98500",
    calibration: "#5BC46E",
  },
} as const;

/* ── Recharts style objects ──────────────────────────────────────────────── */

/** Shared Recharts tooltip style — raised surface, mono numerics, rounded like a control. */
export const chartTooltip = {
  contentStyle: {
    backgroundColor: "#2C2C29",
    border: "1px solid rgba(236,235,230,0.10)",
    borderRadius: 10,
    boxShadow: "0 12px 36px rgba(0,0,0,0.55)",
    padding: "8px 12px",
  },
  labelStyle: { color: "#B0AEA6", fontFamily: MONO, fontSize: 11 },
  itemStyle: { color: "#ECEBE6", fontFamily: MONO, fontSize: 12 },
};

/** Shared axis tick style (mono, tertiary tone). */
export const axisTick = { fill: "#97958D", fontSize: 11, fontFamily: MONO };

/** Shared Recharts <Legend> wrapper style (mono). */
export const legendStyle = { fontSize: 11, fontFamily: MONO };

/**
 * Shared grid style. Horizontal-only is set per-call via `vertical={false}`;
 * dashed `2 4` keeps the grid quiet under dense data.
 */
export const gridStyle = {
  stroke: "#ECEBE6",
  strokeOpacity: 0.06,
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
      fill: "#97958D",
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

/**
 * WHOOP recovery-zone color for a 0..max score: ≥67% green, ≥34% yellow, else red.
 * The single source of the 3-zone system used by rings, status dots, and
 * zone-keyed KPI values across the app.
 */
export function zoneColor(value: number, max = 100): string {
  if (!Number.isFinite(value)) return chartColors.neutral;
  const pct = (value / max) * 100;
  if (pct >= 67) return chartColors.up;
  if (pct >= 34) return chartColors.mid;
  return chartColors.down;
}
