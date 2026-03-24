/** Shared Recharts tooltip style matching Onyx design system */
export const chartTooltip = {
  contentStyle: {
    backgroundColor: "#1A1A1D",
    border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 6,
    boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
    padding: "10px 12px",
  },
  labelStyle: { color: "#A1A1AA", fontFamily: "var(--font-geist-mono), monospace", fontSize: 11 },
  itemStyle: { color: "#F4F4F5", fontFamily: "var(--font-geist-mono), monospace", fontSize: 12 },
};

/** Shared axis tick style */
export const axisTick = { fill: "#71717A", fontSize: 11, fontFamily: "var(--font-geist-mono), monospace" };

/** Shared grid style */
export const gridStyle = { stroke: "#ffffff", strokeOpacity: 0.05 };

/** Source colors for multi-device charts */
export const sourceColors = {
  garmin: "#3B82F6",
  whoop: "#F59E0B",
  eightsleep: "#8B5CF6",
} as const;

/** Accent color for primary metric */
export const accentColor = "#06B6D4";
