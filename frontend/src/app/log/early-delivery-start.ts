import { peekLogEarlyMark, takeLogEarlyMark } from "@/lib/log-early";
import { startEarlyDeliveryReads } from "./early-delivery";

/**
 * Starts the Uber Eats section's Supabase reads (./early-delivery.ts) on a full page load of /log. A module of its own
 * so that LogLoader can import it BEFORE ./LogClient: ES module imports run in order, so these reads leave when this
 * module runs, not after the frame and every section (a large amount of code) have been evaluated. That evaluation sits
 * on the critical path of the cold first visit: the reads are two Supabase calls in a row behind the `lib/queries`
 * chunk (PERF-01, 2026-11-16).
 *
 * Independent of script ordering (2026-11-16): the head script (lib/log-early.ts) may run AFTER this module is
 * evaluated, so a single takeLogEarlyMark() at import could miss the mark and silently lose the early start. The
 * starter therefore PEEKS (no consume) and, while the page is still loading, looks again until the mark appears —
 * the head script always runs before the load event however late it is (lib/early-fetch.ts), so the mark is there
 * by the time the document is "complete"; a completed document with no mark is an in-app visit, where nothing starts.
 * When the mark is seen it is consumed (once per page load) and startEarlyDeliveryReads() runs at most once.
 *
 * READ-ONLY, same rule as before: only a full page load of /log (the head script's mark, lib/log-early.ts), never an
 * in-app visit or a copy in the continuous scroll. Nothing runs on the server.
 */

/** How often to look again for the head script's mark while the page is still loading. */
const POLL_MS = 20;
/** Safety stop only; the load's own end ("complete" with no mark) is the real stop. */
const POLL_LIMIT_MS = 30_000;

let started = false;

/** True while the document is still loading: the head script may not have run yet, and cannot run once this is false. */
function loadInProgress(): boolean {
  return (
    typeof document !== "undefined" &&
    (document.readyState === "loading" || document.readyState === "interactive")
  );
}

/**
 * Start the early reads once, at the first moment the head script's mark is seen; true when they have started (also
 * on a later call, which starts nothing more). Exported for the tests; the module runs it at import.
 */
export function tryStartEarlyDelivery(now = Date.now()): boolean {
  if (started) return true;
  if (peekLogEarlyMark(now)) {
    takeLogEarlyMark(); // consume: once per page load.
    started = true;
    startEarlyDeliveryReads();
  }
  return started;
}

if (typeof window !== "undefined") {
  if (!tryStartEarlyDelivery() && loadInProgress()) {
    const began = Date.now();
    const tick = () => {
      if (tryStartEarlyDelivery() || !loadInProgress() || Date.now() - began >= POLL_LIMIT_MS) return;
      setTimeout(tick, POLL_MS);
    };
    setTimeout(tick, POLL_MS);
  }
}
