export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Convert a UTC instant to its ET (America/New_York) calendar date (YYYY-MM-DD).
// WHOOP's app labels each sleep by its wake-day, so callers should pass
// `sleep.end_time` (not start_time). For post-midnight bedtimes bedtime and wake
// land on the same date; for pre-midnight bedtimes they diverge — using end_time
// keeps us aligned with WHOOP's UI.
export function etDate(instant: string | null | undefined): string {
  if (!instant) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(instant));
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
