import { takeLogEarlyMark } from "@/lib/log-early";
import { startEarlyDeliveryReads } from "./early-delivery";

/**
 * Starts the Uber Eats section's Supabase reads (./early-delivery.ts) on a full page load of /log. A module of its own
 * so that LogLoader can import it BEFORE ./LogClient: ES module imports run in order, so these reads leave when this
 * module runs, not after the frame and every section (a large amount of code) have been evaluated. That evaluation sits
 * on the critical path of the cold first visit: the reads are two Supabase calls in a row behind the `lib/queries`
 * chunk (PERF-01, 2026-11-16).
 *
 * READ-ONLY, same rule as before: only a full page load of /log (the head script's mark, lib/log-early.ts), never an
 * in-app visit or a copy in the continuous scroll. Nothing runs on the server.
 */
if (typeof window !== "undefined" && takeLogEarlyMark()) startEarlyDeliveryReads();
