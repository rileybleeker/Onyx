// Latest Data for the Uber Rides /status card = the end of the ride date range the importer
// recorded (sync_log.date_range_end), never the import time (that is Last Sync). A run with
// no recorded range shows no date.
export function uberRidesLatestDataDate(entry: Record<string, unknown> | null): string | null {
  const end = entry?.date_range_end;
  if (typeof end !== "string") return null;
  const day = end.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}
