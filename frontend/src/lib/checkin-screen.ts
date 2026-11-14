import { parseScreenRow } from "@/lib/screen-time";

/**
 * Readiness gate for the /check-in pre-fill of "Viewed a screen device in bed?" (the answer rule and
 * its thresholds stay in lib/checkin.ts:screenInBedSuggestion).
 *
 * Why a gate: pds.phone_usage_daily.minutes_last_hour_before_sleep_est is 0, not NULL, as soon as
 * WHOOP scores the sleep, even when the phone's hours around that sleep have not been sent yet. The
 * iPhone app syncs once a day (about 10 AM), and the check-in card is re-posted at 9 AM, so a
 * catch-up check-in opened before the sync read "no phone use in the hour before sleep" and
 * suggested No from data that was simply missing.
 *
 * The minutes count only when the row is for the asked day and is bedtimeReady (lib/screen-time.ts):
 * a sync happened after the day ended (synced_at >= day + 1 at 06:00 ET, the HRV pipeline's rule),
 * the sleep is scored, and the sync is at least an hour past sleep onset. Otherwise null, which
 * leaves the question blank.
 */

/** Columns the check-in reads from pds.phone_usage_daily (the last one feeds the app-habit pre-fills). */
export const CHECKIN_SCREEN_COLUMNS =
  "behavioral_date, sleep_start, synced_at, minutes_last_hour_before_sleep_est, minutes_by_app";

export function settledLastHourMinutes(raw: unknown, date: string): number | null {
  const day = parseScreenRow(raw);
  return day && day.date === date && day.bedtimeReady ? day.lastHourBeforeSleepMin : null;
}
