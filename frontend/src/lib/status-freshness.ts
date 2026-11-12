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
