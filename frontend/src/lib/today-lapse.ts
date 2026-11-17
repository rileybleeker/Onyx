/**
 * Lapse re-render timer for the quiet Today view (frontend/src/app/today/TodayClient.tsx).
 *
 * A set-aside (snoozed or hidden) item returns on its own at its resurface time even while Today stays open
 * between refreshes. The timer only re-renders; it never reads or writes.
 *
 * Delays are capped so the fire re-arms: browsers and timers are unreliable over very long delays, so a lapse
 * more than `LAPSE_CAP_MS` away fires at the cap, the component re-renders, and the effect re-runs to schedule
 * the next capped wait until the real `nextChange` is reached.
 */
export const LAPSE_CAP_MS = 6 * 3_600_000;
export const LAPSE_MARGIN_MS = 250;

/**
 * The delay in ms before the lapse should fire, or null when nothing should be scheduled:
 * either there is no `nextChange`, or it has already passed (`nextChange <= now`), so there is nothing left to
 * wait for. A fire past the real time would otherwise re-arm into a tight 250 ms loop.
 */
export function lapseDelay(nextChange: number | null, nowMs: number = Date.now()): number | null {
  if (nextChange === null || nextChange <= nowMs) return null;
  return Math.min(nextChange - nowMs + LAPSE_MARGIN_MS, LAPSE_CAP_MS);
}
