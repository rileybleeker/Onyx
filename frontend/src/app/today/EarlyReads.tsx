import { preconnect } from "react-dom";
import { AGENTS_API } from "@/lib/agents-api";
import { earlyScriptSrc } from "@/lib/early-fetch";
import { todayEarlyScript } from "@/lib/today-early";

// Today's first-paint reads start with the HTML, not after the JavaScript and hydration (lib/today-early.ts; speed
// budget, 2026-11-15). Read-only GETs only: the experiment arm is never asked here. Rendered by `/` and `/today`
// (both static). An async script with a src, which React hoists into the head: it runs as soon as the head is parsed
// instead of after the stylesheet, as an inline script in the body did (lib/early-fetch.ts, PERF-01). On an in-app
// navigation React inserts it too, and it then does nothing (the client cache already shows the last copy at once).
const SRC = earlyScriptSrc(todayEarlyScript(process.env.NEXT_PUBLIC_SUPABASE_URL, AGENTS_API));

export default function EarlyReads() {
  // The agents Worker is another origin: open its connection (DNS, TLS) while the HTML is still parsing. Anonymous,
  // like the inbox fetch itself (a bearer token, no cookies), so the request uses this connection.
  preconnect(AGENTS_API, { crossOrigin: "anonymous" });
  return <script async src={SRC} />;
}
