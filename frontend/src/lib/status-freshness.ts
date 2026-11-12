export type HealthStatus = "success" | "partial" | "failed" | "unknown";

/** A frozen data spine must never make a stopped scheduled importer look healthy. */
export function ingestionHeartbeatStatus(
  dataStatus: HealthStatus,
  entry: Record<string, unknown> | null,
  warningHours: number,
  failureHours: number,
  now = Date.now(),
): HealthStatus {
  if (dataStatus === "failed" || entry?.status === "failed" || entry?.status === "error") return "failed";
  const timestamp = typeof entry?.sync_start === "string" ? Date.parse(entry.sync_start) : NaN;
  // Missing/invalid/future evidence is not proof of a healthy scheduled job.
  if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60_000) return "unknown";
  const ageHours = (now - timestamp) / 3_600_000;
  if (ageHours > failureHours) return "failed";
  if (ageHours > warningHours || entry?.status === "partial" || dataStatus === "partial") return "partial";
  if (entry?.status !== "success") return "unknown";
  return dataStatus;
}

/**
 * PostgREST `or` filter: a Garmin daily summary carrying data from the worn watch.
 * Garmin writes a summary row for every day, worn or not (goals, profile BMR,
 * stress -1/-2), so the newest row says nothing about whether data arrives; on
 * 2026-11-11 the newest row was that day while the newest worn day was 2026-10-02.
 * Mirrors daily_summary_has_wearable_values in garmin_etl.py; it split all 965
 * live rows the same way (528 worn, 437 not).
 */
export const GARMIN_WEARABLE_FILTER = [
  "total_steps.gt.0",
  "resting_heart_rate.not.is.null",
  "min_heart_rate.not.is.null",
  "max_heart_rate.not.is.null",
  "body_battery_highest.not.is.null",
  "avg_spo2.not.is.null",
  "avg_waking_respiration.not.is.null",
].join(",");

/**
 * Reason shown on the Garmin card when the newest worn day is more than a day
 * behind and the heartbeat carries no message of its own (runs before the ETL
 * logged 'partial' for empty windows, or a sync that still reports success).
 */
export function garminNoWearMessage(
  wornDate: string | null,
  newestRowDate: string | null,
  lagDays: number,
): string | null {
  if (lagDays <= 1) return null;
  const since = wornDate ? `since ${wornDate} (${lagDays} days)` : "on record";
  const rows = newestRowDate && newestRowDate !== wornDate ? ` Daily rows through ${newestRowDate} are empty.` : "";
  return `No Garmin day with watch data ${since}.${rows} Watch not worn, or Garmin is returning empty payloads.`;
}
