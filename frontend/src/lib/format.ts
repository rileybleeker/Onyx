export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// WHOOP cycles span bedtime → bedtime and are labeled in the app by the wake-day.
// Convert a cycle/sleep `start_time` (UTC ISO) to the wake-day ET date (YYYY-MM-DD)
// via the canonical "+12h then America/New_York" rule documented in CLAUDE.md.
export function whoopCycleDate(startTime: string | null | undefined): string {
  if (!startTime) return "";
  const shifted = new Date(new Date(startTime).getTime() + 12 * 3600 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(shifted);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function formatDuration(seconds: number | null): string {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatDistance(meters: number | null): string {
  if (!meters) return "—";
  const miles = meters / 1609.344;
  if (miles >= 0.5) return `${miles.toFixed(1)} mi`;
  return `${Math.round(meters)} m`;
}

export function formatPace(speedMps: number | null): string {
  if (!speedMps || speedMps === 0) return "—";
  const minPerMile = 1609.344 / speedMps / 60;
  const mins = Math.floor(minPerMile);
  const secs = Math.round((minPerMile - mins) * 60);
  if (secs === 60) return `${mins + 1}:00 /mi`;
  return `${mins}:${secs.toString().padStart(2, "0")} /mi`;
}
