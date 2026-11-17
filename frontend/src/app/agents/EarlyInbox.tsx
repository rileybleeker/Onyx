import { preconnect } from "react-dom";
import { AGENTS_API } from "@/lib/agents-api";
import { earlyScriptSrc } from "@/lib/early-fetch";
import { agentsEarlyScript } from "@/lib/today-early";

// The inbox read starts with the HTML, not after the JavaScript and hydration (lib/today-early.ts; speed budget,
// 2026-11-15: the cold first visit took 1015 ms in perf-timing run 43679809614). GET only, read-only; AgentsInbox
// takes the answer on its first load. A URL that opens one conversation (?t=<agent>, a push deep link) starts that
// conversation's first read instead, which AgentsChat takes (agents:* is memory-only, so there is no copy on the
// device to paint from). An async script with a src, hoisted into the head by React, so the read does not wait for
// the stylesheet (lib/early-fetch.ts, PERF-01); inserted again by React on an in-app navigation, it does nothing.
const SCRIPT = agentsEarlyScript(process.env.NEXT_PUBLIC_SUPABASE_URL, AGENTS_API);
const SRC = SCRIPT ? earlyScriptSrc(SCRIPT) : "";

export default function EarlyInbox() {
  // Another origin: open its connection while the HTML is still parsing (anonymous, like the inbox fetch).
  preconnect(AGENTS_API, { crossOrigin: "anonymous" });
  return SRC ? <script async src={SRC} /> : null;
}
