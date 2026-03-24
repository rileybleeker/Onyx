export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
