import { earlyScriptSrc } from "@/lib/early-fetch";
import { logEarlyScript } from "@/lib/log-early";

// The Log screen's first reads start with the HTML, not after the JavaScript, the section chunks and their mount
// (lib/log-early.ts; speed budget, 2026-11-15: the cold first visit took about 1.4 s). Read-only GETs only. An async
// script with a src, hoisted into the head by React, so the reads do not wait for the stylesheet (lib/early-fetch.ts,
// PERF-01). On an in-app navigation React inserts it too and it does nothing (no reads, no mark), where the client
// cache already shows the last copy at once.
const SRC = earlyScriptSrc(logEarlyScript());

export default function EarlyReads() {
  return <script async src={SRC} />;
}
